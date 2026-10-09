'use strict';
// providers/meshy.js — v1.9 M9: remesh a GLB through Meshy (paid cloud, opt-in). Node stdlib + global fetch.
//
//   remesh(glbAbsPath, { topology, targetPolycount, key, ... }) -> { ok:true, glb:Buffer, credits, ms, taskId } | { ok:false, error, code }
//   balance({ key, baseUrl, fetchImpl })                        -> { ok:true, balance:<n> } | { ok:false, error }
//
// The key is only ever sent as `Authorization: Bearer` to the base URL. It — and the upload's data URI — never appear in
// a returned message. Every test points `baseUrl` at a local fake server (no real call in tests).
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://api.meshy.ai';
const DEFAULT_MAX_MB = 60;
const MIN_POLY = 100, MAX_POLY = 300000;
const CREATE_TIMEOUT_MS = 120000;       // the upload can be big
const REQUEST_TIMEOUT_MS = 15000;       // every poll / balance call
const DOWNLOAD_STALL_MS = 60000;       // E2: no bytes for this long = stalled
const CREATE_MAYBE_CHARGED = 'Meshy did not answer in time — the task may have been created and charged anyway. Check your Meshy dashboard (Tasks) before retrying.';
// N2: errors that prove the request never left the machine (nothing can have been charged)
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;   // refuse a result larger than 1 GB

const fail = (error, code) => ({ ok: false, error, code: code || 'error' });

// A server-supplied body goes into a message only after the key, any data URI and long base64-ish runs are scrubbed, and cut short.
function shortBody(text, key) {
  let t = String(text == null ? '' : text);
  if (key) t = t.split(key).join('[key]');
  t = t.replace(/data:[^"'\s]*/gi, '[data]').replace(/base64,[A-Za-z0-9+/=]*/gi, '[data]')
       .replace(/[A-Za-z0-9+/=]{40,}/g, '…').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, 160).join('');
}

function httpError(status, text, key) {
  if (status === 401) return fail('Meshy rejected the API key — check it in Settings → Connections', 'auth');
  if (status === 402) return fail('Meshy: not enough credits', 'credits');
  if (status === 429) return fail('Meshy is rate-limiting — try again in a minute', 'rate');
  return fail('Meshy HTTP ' + status + ': ' + shortBody(text, key), 'http');
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

// One signal from the caller's abort + a per-request timeout.
function withTimeout(signal, ms) {
  if (typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return signal;
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  if (AbortSignal.any) return AbortSignal.any([signal, t]);
  return signal;
}

async function remesh(glbAbsPath, o) {
  o = o || {};
  const key = o.key;
  const fetchImpl = o.fetchImpl || ((typeof fetch === 'function') ? fetch : null);
  const sleep = o.sleep || defaultSleep;
  const now = o.now || Date.now;
  const pollMs = Number.isFinite(o.pollMs) ? o.pollMs : 5000;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 600000;
  const fileMB = (() => { try { return fs.statSync(glbAbsPath).size / 1048576; } catch (_) { return 0; } })();
  // E1: the create timeout scales with the upload: max(120 s, 60 s + 10 s per MB)
  const createTimeoutMs = Number.isFinite(o.createTimeoutMs) ? o.createTimeoutMs : Math.ceil(Math.max(CREATE_TIMEOUT_MS, 60000 + 10000 * fileMB));
  const dlStallMs = Number.isFinite(o.downloadStallMs) ? o.downloadStallMs : DOWNLOAD_STALL_MS;
  const requestTimeoutMs = Number.isFinite(o.requestTimeoutMs) ? o.requestTimeoutMs : REQUEST_TIMEOUT_MS;
  const maxDownload = Number.isFinite(o.maxDownloadBytes) && o.maxDownloadBytes > 0 ? o.maxDownloadBytes : MAX_DOWNLOAD_BYTES;
  const base = String(o.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const topology = o.topology === undefined ? 'quad' : o.topology;
  const targetPolycount = o.targetPolycount === undefined ? 20000 : o.targetPolycount;
  const maxMB = Number.isFinite(o.maxUploadMB) && o.maxUploadMB > 0 ? o.maxUploadMB : DEFAULT_MAX_MB;
  const signal = o.signal;
  if (!fetchImpl) return fail('no fetch available in this Node version', 'env');
  if (!key || typeof key !== 'string') return fail('no Meshy API key — add it in Settings → Connections', 'nokey');

  // ── validation, before anything is uploaded ──
  if (topology !== 'quad' && topology !== 'triangle') return fail('topology must be "quad" or "triangle"', 'input');
  if (!Number.isInteger(targetPolycount) || targetPolycount < MIN_POLY || targetPolycount > MAX_POLY) {
    return fail('target_polycount must be an integer between ' + MIN_POLY + ' and ' + MAX_POLY, 'input');
  }
  if (typeof glbAbsPath !== 'string' || !glbAbsPath) return fail('no file given', 'input');
  const fname = path.basename(glbAbsPath);
  let st;
  try { st = fs.statSync(glbAbsPath); } catch (_) { return fail(fname + ' not found', 'input'); }
  if (!st.isFile()) return fail(fname + ' is not a file', 'input');
  if (!/\.glb$/i.test(fname)) return fail(fname + ' is not a .glb file', 'input');
  const mb = st.size / (1024 * 1024);
  if (mb > maxMB) {
    return fail(fname + ' is ' + Number(mb.toFixed(mb < 1 ? 3 : 1)) + ' MB — larger than the remesh upload limit (' + maxMB + ' MB, Settings → Connections)', 'size');
  }

  const t0 = now();
  const auth = { Authorization: 'Bearer ' + key };
  const resumeId = (typeof o.resumeTaskId === 'string' && o.resumeTaskId) ? o.resumeTaskId : null;
  // Sweep 3e: the caller may hand over the bytes it already hashed (o.bytes) - the upload then describes EXACTLY the content its record key was computed from
  let bytes;
  if (!resumeId) {
    // Sweep 3f: the tool always hands over the buffer it hashed; with requireBytes the path is NEVER read here (no submission without the hashed content)
    if (o.requireBytes && !Buffer.isBuffer(o.bytes)) return fail('Phoenix did not prepare the upload data, nothing was sent', 'input');
    if (Buffer.isBuffer(o.bytes)) {
      bytes = o.bytes;
      if (bytes.length > maxMB * 1024 * 1024) return fail(fname + ' is larger than the remesh upload limit (' + maxMB + ' MB, Settings → Connections)', 'size');
    } else { try { bytes = fs.readFileSync(glbAbsPath); } catch (e) { return fail('could not read ' + fname + ': ' + shortBody(e && e.message, key), 'input'); } }
  }

  // ── create (never repeated: a second create would be a second charge) ──
  // Sweep 3 C: with resumeTaskId (a task that already SUCCEEDED but whose download failed) nothing is created or uploaded: the task is read again
  // for a fresh download link.
  let created = resumeId ? { result: resumeId } : null;
  if (!resumeId && signal && signal.aborted) return fail('remesh cancelled', 'cancelled');   // aborted before anything was sent: nothing can have been charged
  // Sweep 3e: the caller persists its "submission intent" HERE, right before the request leaves; a callback that answers false refuses the submission
  if (!resumeId && typeof o.beforeCreate === 'function') {
    let go = true;
    try { go = o.beforeCreate(); } catch (_) { go = true; }
    if (go === false) return fail('Phoenix could not secure this paid submission, nothing was sent', 'refused');
  }
  if (!resumeId) try {
    const res = await fetchImpl(base + '/openapi/v1/remesh', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
      body: JSON.stringify({
        model_url: 'data:application/octet-stream;base64,' + bytes.toString('base64'),
        topology, target_polycount: targetPolycount, target_formats: ['glb'],
      }),
      signal: withTimeout(signal, createTimeoutMs),
    });
    bytes = null;
    delete o.bytes;   // sweep 3f: release the upload buffer as soon as the request is out (it can be tens of MB)
    const text = await res.text();
    // Sweep 3e: a 5xx on the CREATE may have created (and charged) a task before it failed - treated like a timeout, never a plain http error. A 4xx proves the request was refused.
    if (!res.ok) {
      if (res.status >= 500) return fail('Meshy HTTP ' + res.status + ': ' + shortBody(text, key) + ' — the task may have been created and charged anyway. Check your Meshy dashboard (Tasks) before retrying.', 'create_timeout');
      return httpError(res.status, text, key);
    }
    try { created = JSON.parse(text); } catch (_) { created = null; }
  } catch (e) {
    // Sweep 3 C: an abort AFTER the request went out may still have created (and charged) a task - same warning + retry block as a timeout
    if (signal && signal.aborted) return fail(CREATE_MAYBE_CHARGED, 'create_timeout');
    // E1: a create that timed out may still have made (and charged) a task — say so, never retry
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return fail(CREATE_MAYBE_CHARGED, 'create_timeout');
    // N2: a network error AFTER the body was sent is just as ambiguous (same wording); only connect-phase errors prove nothing was sent
    const code = e && ((e.cause && e.cause.code) || e.code);
    if (!NEVER_SENT.has(code)) return fail(CREATE_MAYBE_CHARGED, 'create_timeout');
    return fail('Meshy is unreachable: ' + shortBody(e && e.message, key), 'network');
  }
  const taskId = created && (created.result || created.id);
  // a 2xx without a usable task id: the task may well exist - possibly charged, not a plain error
  if (!taskId || typeof taskId !== 'string') return fail('Meshy answered without a task id — the task may have been created and charged anyway. Check your Meshy dashboard (Tasks) before retrying.', 'create_timeout');
  if (!resumeId && typeof o.onCreated === 'function') { try { o.onCreated(taskId); } catch (_) { /* a callback must never break the run */ } }
  const taskUrl = base + '/openapi/v1/remesh/' + encodeURIComponent(taskId);

  // D3: once a task id exists, EVERY exit other than SUCCEEDED / FAILED / CANCELED first asks Meshy to cancel the task
  // (best-effort refund of a pending task). Never throws, never a second create.
  // Sweep 3b: the result says whether Meshy CONFIRMED the cancel (2xx). An unconfirmed cancel leaves a task that may be charged - the caller keeps
  // the task id (and the maybe-charged block) and a later identical remesh reconciles that task instead of creating a new one. A resumed task is
  // never DELETEd (it is already paid and may be finished).
  const abandon = async (result) => {
    let confirmed = false;
    if (!resumeId) {
      try { const dr = await fetchImpl(taskUrl, { method: 'DELETE', headers: auth, signal: withTimeout(undefined, requestTimeoutMs) }); confirmed = !!(dr && dr.ok); } catch (_) { /* best effort */ }
    }
    return Object.assign(result, { taskId, cancelConfirmed: confirmed });
  };

  // ── poll ──
  let task = null, transient = 0;
  for (;;) {
    if (signal && signal.aborted) return abandon(fail('remesh cancelled', 'cancelled'));
    if (now() - t0 >= timeoutMs) return abandon(fail('Meshy remesh timed out after ' + Math.round(timeoutMs / 1000) + ' s — cancelled', 'timeout'));
    try {
      const res = await fetchImpl(taskUrl, { method: 'GET', headers: auth, signal: withTimeout(signal, requestTimeoutMs) });
      const text = await res.text();
      if (!res.ok) {
        if (res.status >= 500 && ++transient <= 3) { await sleep(pollMs); continue; }
        if (resumeId && (res.status === 404 || res.status === 410)) return Object.assign(fail('Meshy no longer has the earlier remesh task (its result link expires after a few days) — remesh again to start a new one (that costs credits again)', 'task_gone'), { taskId, terminal: true });
        return abandon(httpError(res.status, text, key));
      }
      transient = 0;
      try { task = JSON.parse(text); } catch (_) { task = null; }
    } catch (e) {
      if (signal && signal.aborted) return abandon(fail('remesh cancelled', 'cancelled'));
      if (++transient <= 3) { await sleep(pollMs); continue; }   // a timed-out poll counts as a network failure
      return abandon(fail('Meshy is unreachable: ' + shortBody(e && e.message, key), 'network'));
    }
    if (!task || typeof task !== 'object') return abandon(fail('Meshy answered with something unreadable', 'http'));
    if (typeof o.onProgress === 'function') { try { o.onProgress(Number(task.progress) || 0); } catch (_) { /* a callback must never break the run */ } }
    const status = String(task.status || '');
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'CANCELED') {
      const m = task.task_error && task.task_error.message;
      // terminal: Meshy itself ended the task - nothing is pending or recoverable any more (the caller clears its record)
      return Object.assign(fail('Meshy remesh ' + (status === 'FAILED' ? 'failed' : 'was cancelled') + (m ? ': ' + shortBody(m, key) : ''), status === 'FAILED' ? 'failed' : 'cancelled'), { taskId, terminal: true });
    }
    await sleep(pollMs);
  }

  // ── download at once (the link expires) ──
  // Sweep 3 C: from here on the task is PAID. Every failure carries the task id + downloadable:true so the caller can retry the DOWNLOAD (never a second create).
  const failDl = (error, code) => Object.assign(fail(error, code), { taskId, downloadable: true });
  const glbUrl = task.model_urls && task.model_urls.glb;
  if (!glbUrl || typeof glbUrl !== 'string') return failDl('Meshy finished but returned no GLB', 'http');
  const tooBig = () => failDl('Meshy result is larger than the ' + Math.round(maxDownload / 1048576) + ' MB download limit - raise it (config remesh.maxDownloadBytes) and press Remesh again', 'download');
  let glb;
  // E2: own timeouts — a stall (no bytes for 60 s) or the overall limit max(120 s, 10 s per expected MB) ends the download
  const dac = new AbortController();
  const dlSignal = (signal && AbortSignal.any) ? AbortSignal.any([signal, dac.signal]) : dac.signal;
  let overallTimer = null, stallTimer = null, dlTimedOut = false;
  const clearDl = () => { clearTimeout(overallTimer); clearTimeout(stallTimer); };
  const trip = () => { dlTimedOut = true; try { dac.abort(); } catch (_) { /* gone */ } };
  const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(trip, dlStallMs); };
  const dlTimeoutMsg = () => failDl('Meshy result download timed out — stalled or too slow', 'download');
  try {
    overallTimer = setTimeout(trip, Number.isFinite(o.downloadTimeoutMs) ? o.downloadTimeoutMs : 120000);
    armStall();
    const res = await fetchImpl(glbUrl, { method: 'GET', signal: dlSignal });   // a signed URL — the key is NOT sent
    if (!res.ok) { clearDl(); return failDl('Meshy result download failed (HTTP ' + res.status + ')', 'download'); }
    const cl = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(cl) && cl > maxDownload) { clearDl(); try { await res.body.cancel(); } catch (_) { /* gone */ } return tooBig(); }
    if (Number.isFinite(cl) && !Number.isFinite(o.downloadTimeoutMs)) {   // the overall limit now knows the size
      clearTimeout(overallTimer); overallTimer = setTimeout(trip, Math.ceil(Math.max(120000, 10000 * (cl / 1048576))));
    }
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader(); const parts = []; let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armStall();
        n += value.length;
        if (n > maxDownload) { clearDl(); try { await reader.cancel(); } catch (_) { /* gone */ } return tooBig(); }
        parts.push(Buffer.from(value));
      }
      glb = Buffer.concat(parts);
    } else {
      glb = Buffer.from(await res.arrayBuffer());
      if (glb.length > maxDownload) { clearDl(); return tooBig(); }
    }
    clearDl();
  } catch (e) {
    clearDl();
    if (dlTimedOut) return dlTimeoutMsg();
    return failDl('Meshy result download failed: ' + shortBody(e && e.message, key), 'download');
  }
  if (glb.length < 12 || glb.toString('latin1', 0, 4) !== 'glTF') return failDl('Meshy result is not a GLB file (no glTF header)', 'download');
  const credits = Number.isFinite(Number(task.consumed_credits)) && task.consumed_credits !== null && task.consumed_credits !== undefined ? Number(task.consumed_credits) : null;
  return { ok: true, glb, credits, ms: now() - t0, taskId };
}

// GET <base>/openapi/v1/balance -> {"balance":<n>}. Never throws, never echoes the key. 15 s timeout.
async function balance(o) {
  o = o || {};
  const fetchImpl = o.fetchImpl || ((typeof fetch === 'function') ? fetch : null);
  const base = String(o.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  if (!fetchImpl) return { ok: false, error: 'balance unavailable' };
  if (!o.key) return { ok: false, error: 'no Meshy API key' };
  try {
    const res = await fetchImpl(base + '/openapi/v1/balance', {
      method: 'GET', headers: { Authorization: 'Bearer ' + o.key },
      signal: withTimeout(undefined, o.timeoutMs || REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: res.status === 401 ? 'Meshy rejected the API key' : 'balance unavailable' };
    let j = null;
    try { j = JSON.parse(text); } catch (_) { /* below */ }
    const n = j && Number(j.balance);
    if (!j || j.balance === null || j.balance === undefined || !Number.isFinite(n)) return { ok: false, error: 'balance unavailable' };
    return { ok: true, balance: n };
  } catch (_) {
    return { ok: false, error: 'balance unavailable' };
  }
}

module.exports = { remesh, balance, DEFAULT_BASE, DEFAULT_MAX_MB };
