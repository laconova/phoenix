'use strict';
// providers/gpu-share.js — a local model server and ComfyUI often share one GPU. Before a heavy
// image/mesh stage, unload the local model where the server has an unload command (LM Studio, Ollama);
// llama.cpp in ROUTER mode (--models-preset: POST /models/unload, status via GET /models), unloaded and
// waited for; where it has none (plain llama-server ...) say so, honestly, once. Phoenix NEVER kills a
// process it did not start: nothing here spawns kill/pkill/fuser/taskkill (an API unload request is not a kill).
const fs = require('fs');
const path = require('path');
const { resolveSeat, SEAT_NAMES } = require('./seats');

const _kinds = new Map();      // endpoint URL → 'ollama' | 'lmstudio' | 'llamacpp-router' | 'other'  (per process)
const _noticed = new Set();    // "<url>|<model>" already warned about (per process)
function _resetCache() { _kinds.clear(); _noticed.clear(); }

function rootOf(url) { return String(url || '').replace(/\/+$/, '').replace(/\/v1$/, ''); }

async function getJson(url, deps, ms, meta) {
  const f = deps.fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, ms);
  try {
    const res = await f(url, { method: 'GET', signal: ac.signal });
    if (res && meta) meta.answered = true;   // any HTTP answer (even 404) = the server is alive
    if (!res || !res.ok) return null;
    try { return await res.json(); } catch (_) { return {}; }
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}

// Internal: { kind, unreachable }. unreachable = nobody answered /api/version (network error/timeout): the other two
// probes are skipped (2 s, not 6 s) and the result is NOT cached, so the next stage probes again.
async function detectInfo(endpointUrl, deps = {}) {
  const root = rootOf(endpointUrl);
  if (_kinds.has(root)) return { kind: _kinds.get(root), unreachable: false };
  let kind = 'other';
  const meta = { answered: false };
  try {
    const v = await getJson(root + '/api/version', deps, 2000, meta);
    if (!meta.answered) return { kind: 'other', unreachable: true };
    if (v && typeof v === 'object' && v.version) kind = 'ollama';
    else if (await getJson(root + '/api/v0/models', deps, 2000, meta)) kind = 'lmstudio';
    else {
      const m = await getJson(root + '/models', deps, 2000, meta);
      if (m && Array.isArray(m.data) && m.data.some(e => e && e.status && typeof e.status === 'object' && typeof e.status.value === 'string')) kind = 'llamacpp-router';
    }
  } catch (_) { kind = 'other'; }
  _kinds.set(root, kind);
  return { kind, unreachable: false };
}

// 'ollama' (/api/version) | 'lmstudio' (/api/v0/models) | 'llamacpp-router' (/models with status.value) | 'other'. Errors/dead → 'other'.
async function detectServer(endpointUrl, deps = {}) { return (await detectInfo(endpointUrl, deps)).kind; }

// lms lives in ~/.lmstudio/bin, which non-login shells (SSH, spawned servers) often
// don't have on PATH — resolve the explicit path first, fall back to PATH lookup.
function lmsBin() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cand = path.join(home, '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms');
  return fs.existsSync(cand) ? cand : 'lms';
}
// Sweep 2 G10: is this endpoint on THIS machine (so the local `lms` CLI is the right tool)?
function isLoopbackUrl(u) {
  try { const h = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'; } catch (_) { return false; }
}
function dbgOf(deps) { return deps.dbg || require('../debug-log'); }
function lmsLoad(modelKey, deps = {}) {
  const dbg = dbgOf(deps);
  try {
    const r = (deps.spawnSyncImpl || require('child_process').spawnSync)(lmsBin(), ['load', modelKey, '-y'], { encoding: 'utf8', timeout: 120000 });
    if (r.error)        { dbg.event('eject', { phase: 'load-error',   model: modelKey, error: r.error.message }); return; }
    if (r.status !== 0) { dbg.event('eject', { phase: 'load-nonzero', model: modelKey, code: r.status, stderr: String(r.stderr || '').slice(0, 200) }); return; }
    dbg.event('eject', { phase: 'loaded', model: modelKey });
  } catch (e) { dbg.event('eject', { phase: 'load-throw', error: (e && e.message) || String(e) }); }
}
function lmsUnload(modelKey, deps = {}) {
  const dbg = dbgOf(deps);
  try {
    const r = (deps.spawnSyncImpl || require('child_process').spawnSync)(lmsBin(), ['unload', modelKey], { encoding: 'utf8', timeout: 30000 });
    if (r.error)        { dbg.event('eject', { phase: 'unload-error',   model: modelKey, error: r.error.message }); return; }
    if (r.status !== 0) { dbg.event('eject', { phase: 'unload-nonzero', model: modelKey, code: r.status, stderr: String(r.stderr || '').slice(0, 200) }); return; }
    dbg.event('eject', { phase: 'unloaded', model: modelKey });
  } catch (e) { dbg.event('eject', { phase: 'unload-throw', error: (e && e.message) || String(e) }); }
}

async function ollamaUnload(root, model, deps) {
  const f = deps.fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, 5000);
  try {
    await f(root + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: ac.signal });
    dbgOf(deps).event('eject', { phase: 'unloaded', model, server: 'ollama' });
  } catch (e) { try { dbgOf(deps).event('eject', { phase: 'unload-error', model, error: (e && e.message) || String(e) }); } catch (_) {} }
  finally { clearTimeout(timer); }
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
// { read, status, ids }: read = the list was actually read (data is an array); status = the entry's status.value or null
function routerStatus(list, model) {
  if (!list || !Array.isArray(list.data)) return { read: false, status: null, ids: [] };
  const e = list.data.find(x => x && x.id === model);
  return { read: true, status: e && e.status && typeof e.status === 'object' ? e.status.value : null,
           ids: list.data.map(x => x && x.id).filter(x => typeof x === 'string'), listed: !!e };
}
const _active = (st) => st === 'loaded' || st === 'loading';
// llama.cpp router mode: unload only <model>, then wait (poll GET /models) until it is gone from VRAM.
// "Unloaded" counts only for a list that was READ. deps (tests): fetchImpl, dbg, log, sleep(ms), now(), pollMs (500), timeoutMs (30000). Never throws.
async function routerUnload(root, model, deps = {}, url) {
  const dbg = dbgOf(deps);
  const ev = (o) => { try { dbg.event('eject', o); } catch (_) {} };
  const sleep = deps.sleep || _sleep, now = deps.now || Date.now;
  const pollMs = deps.pollMs != null ? deps.pollMs : 500, timeoutMs = deps.timeoutMs != null ? deps.timeoutMs : 30000;
  try {
    const t0 = now();
    const first = routerStatus(await getJson(root + '/models', deps, 2000), model);
    if (first.read && !_active(first.status)) {
      if (!first.listed) {
        ev({ phase: 'not-loaded', model, server: 'llamacpp-router', models: first.ids });
        const key = 'unlisted|' + root + '|' + model;
        if (!_noticed.has(key)) {
          _noticed.add(key);
          (deps.log || console.log)('PHOENIX_NOTICE: Local model ' + model + ' is not listed by the llama.cpp router at ' + (url || root) +
            ' (it has: ' + first.ids.join(', ') + ') — check the model name in Settings.');
        }
      } else ev({ phase: 'not-loaded', model, server: 'llamacpp-router' });
      return;
    }
    const f = deps.fetchImpl || fetch;
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, 5000);
    try {
      const res = await f(root + '/models/unload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: ac.signal });
      if (!res || res.ok === false) { ev({ phase: 'unload-error', model, server: 'llamacpp-router', error: 'HTTP ' + (res && res.status) }); return; }
      let body = null; try { body = await res.json(); } catch (_) {}
      if (body && body.success === false) { ev({ phase: 'unload-error', model, server: 'llamacpp-router', error: 'success:false' }); return; }
    } finally { clearTimeout(timer); }
    while (true) {
      const cur = routerStatus(await getJson(root + '/models', deps, 2000), model);
      if (cur.read && !_active(cur.status)) { ev({ phase: 'unloaded', model, server: 'llamacpp-router', ms: now() - t0 }); return; }
      if (now() - t0 >= timeoutMs) { ev({ phase: 'unload-timeout', model, server: 'llamacpp-router', ms: now() - t0 }); return; }
      await sleep(pollMs);
    }
  } catch (e) { ev({ phase: 'unload-error', model, server: 'llamacpp-router', error: (e && e.message) || String(e) }); }
}

// stage = 'image' | 'mesh'. Best-effort, never throws. deps (tests): fetchImpl, spawnSyncImpl, dbg, log,
// lmsUnload (override of the unload call).
async function beforeGpuStage(cfg, stage, deps = {}) {
  try {
    const targets = new Map();
    for (const name of SEAT_NAMES) {
      let seat;
      try { seat = resolveSeat(name, cfg); } catch (_) { continue; }
      if (seat.provider !== 'openai-compat' || seat.kind !== 'local' || !seat.model) continue;
      targets.set(rootOf(seat.url) + '|' + seat.model, { url: seat.url, model: seat.model });
    }
    const memo = new Map();   // root → detection promise, one probe per root per call
    const detectOnce = (url) => { const r = rootOf(url); if (!memo.has(r)) memo.set(r, detectInfo(url, deps)); return memo.get(r); };
    for (const t of targets.values()) {
      try {
        const info = await detectOnce(t.url);
        const kind = info.kind;
        if (kind === 'lmstudio') {
          // Sweep 2 G10: `lms unload` talks to the LM Studio on THIS machine. A remote LM Studio is detected through its URL, but unloading it
          // with the local CLI would hit the wrong machine (or nothing) - so say honestly that it was not unloaded.
          if (!isLoopbackUrl(t.url)) {
            const key = 'remote-lms|' + rootOf(t.url) + '|' + t.model;
            if (!_noticed.has(key)) {
              _noticed.add(key);
              (deps.log || console.log)('PHOENIX_NOTICE: Local model ' + t.model + ' runs on LM Studio at ' + t.url + ' (another machine) \u2014 Phoenix can only unload an LM Studio ' +
                'on this computer, so it was not unloaded. If it shares the GPU with ComfyUI, unload it there, or large images or meshes can run out of memory.');
            }
          } else (deps.lmsUnload || lmsUnload)(t.model, deps);
        }
        else if (kind === 'ollama') await ollamaUnload(rootOf(t.url), t.model, deps);
        else if (kind === 'llamacpp-router') await routerUnload(rootOf(t.url), t.model, deps, t.url);
        else {
          const key = (info.unreachable ? 'unreach|' : '') + rootOf(t.url) + '|' + t.model;
          if (info.unreachable) {
            if (!_noticed.has(key)) {
              _noticed.add(key);
              (deps.log || console.log)('PHOENIX_NOTICE: Local model ' + t.model + ' at ' + t.url + ' is not reachable right now \u2014 it was not unloaded; ' +
                'if it shares the GPU, large images or meshes can run out of memory.');
            }
          } else if (!_noticed.has(key)) {
            _noticed.add(key);
            (deps.log || console.log)('PHOENIX_NOTICE: Local model ' + t.model + ' at ' + t.url + ' stays loaded while ComfyUI runs ' +
              '(this server has no unload command). If both share one GPU, large images or meshes can run out of memory. ' +
              'llama.cpp can do this in router mode (--models-preset) — then Phoenix unloads it automatically.');
          }
        }
      } catch (_) { /* best-effort: one failing server must not block the others */ }
    }
  } catch (_) {}
}

module.exports = { detectServer, beforeGpuStage, routerUnload, lmsLoad, lmsUnload, lmsBin, isLoopbackUrl, _resetCache };
