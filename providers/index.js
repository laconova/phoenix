'use strict';
// providers/index.js — the single door every LLM call in Phoenix goes through:
//   complete(seatName, cfg, { system, messages, purpose, ... }) → { text, provider, model, ms }
// The seat decides WHICH provider answers (Claude CLI · local OpenAI-compatible server · OpenAI with
// a key); call sites only name the seat. v1.9 M1 — see planing phase/phoenix-v19-m1-provider-layer-codespec.md.
const { ProviderError } = require('./errors');
const { resolveSeat, resolveEndpoint, SEAT_NAMES } = require('./seats');
const claudeProvider = require('./claude-cli');
const openaiProvider = require('./openai-compat');
const codexProvider = require('./codex-cli');
const secrets = require('./secrets');

const PURPOSES = ['chat', 'troubleshoot', 'helper', 'metaprompt', 'category', 'vision', 'probe', 'bench'];
const DEFAULT_MAX_TOKENS = { metaprompt: 4000, category: 64 };   // everything else 8000

// Real modules are loaded lazily, so a test that injects fakes never touches the real CLI module.
const REAL = {
  cli:       () => require('../claude-cli'),
  fetchImpl: () => (...a) => fetch(...a),
  getKey:    () => secrets.getKey,
  dbg:       () => require('../debug-log'),
};
let _deps = null;   // test overrides
function _setDeps(d) { _deps = d && typeof d === 'object' ? { ...d } : null; }
function _resetDeps() { _deps = null; }
function depsFor(over) {
  const d = { ...(_deps || {}), ...(over || {}) };
  for (const k of Object.keys(REAL)) if (!d[k]) d[k] = REAL[k]();
  return d;
}

async function complete(seatName, cfg, { system, messages, purpose, timeoutMs, extraFlags, maxTokens, images, deps } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new ProviderError('config', 'complete(): messages must be a non-empty array', { seat: seatName });
  if (messages[messages.length - 1].role !== 'user') throw new ProviderError('config', 'complete(): the last message must have role "user"', { seat: seatName });
  if (purpose !== undefined && !PURPOSES.includes(purpose)) throw new ProviderError('config', 'complete(): unknown purpose "' + purpose + '"', { seat: seatName });
  // v1.9 M3: images = [{ mime:'image/png', data:Buffer }] — only an openai-compat seat can take them through here.
  const hasImages = images !== undefined && images !== null;
  if (hasImages && (!Array.isArray(images) || !images.every(i => i && typeof i === 'object' && Buffer.isBuffer(i.data) && typeof i.mime === 'string' && i.mime.startsWith('image/')))) {
    throw new ProviderError('config', 'complete(): images must be an array of { mime: "image/…", data: Buffer }', { seat: seatName });
  }
  const nImages = hasImages ? images.length : 0;
  const d = depsFor(deps);
  const seat = resolveSeat(seatName, cfg);

  const ctx = { seat: seatName, provider: seat.provider, model: seat.model };
  if (nImages && seat.provider === 'claude-cli') {
    throw new ProviderError('config', 'claude-cli vision goes through render_check (Read tool), not complete()', ctx);
  }
  if (purpose === 'vision' && seat.provider !== 'claude-cli' && !nImages) {
    throw new ProviderError('no-vision', 'a vision call needs at least one image', ctx);
  }

  const raw = seat.raw || {};
  const maxTok = Number.isInteger(raw.maxTokens) && raw.maxTokens > 0 ? raw.maxTokens
    : (maxTokens || DEFAULT_MAX_TOKENS[purpose] || 8000);
  // Temperature: the metaprompter defaults to 0.7 (today's GEMMA_TEMP, `|| 0.7`); other seats only if set.
  let temperature;
  if (typeof raw.temperature === 'number' && (raw.temperature || seatName !== 'metaprompter')) temperature = raw.temperature;
  else if (seatName === 'metaprompter') temperature = 0.7;

  const t0 = Date.now();
  let r;
  if (seat.provider === 'claude-cli') {
    r = await claudeProvider.complete(seat, { system, messages, timeoutMs, extraFlags, cli: d.cli });
  } else if (seat.provider === 'codex-cli') {
    // The CLI has no max-tokens / temperature flags, so neither is passed. Images go as `-i <file>` (M3).
    r = await codexProvider.complete(seat, { system, messages, timeoutMs, images: nImages ? images : undefined, cfg, deps: d });
  } else {
    r = await openaiProvider.complete(seat, { system, messages, timeoutMs, maxTokens: maxTok, temperature, images: nImages ? images : undefined,
      fetchImpl: d.fetchImpl, getKey: d.getKey, sleepImpl: d.sleepImpl });
  }
  const ms = Date.now() - t0;
  const rec = { provider: seat.provider, model: seat.model, purpose, msgCount: messages.length, ms, respChars: r.text.length, imagesSent: r.imagesSent || 0 };
  if (r.usage) {   // token counts only (numbers), never any text
    const u = {};
    for (const [k, v] of Object.entries(r.usage)) if (typeof v === 'number') u[k] = v;
    rec.usage = u;
  }
  try { d.dbg.llm(seatName, rec); } catch (_) {}
  return { text: r.text, provider: seat.provider, model: seat.model, ms, imagesSent: r.imagesSent || 0 };
}

// The model-name charset guard + the `claude --print` probe, moved here from server.js unchanged.
function probeClaudeModel(model, d) {
  return new Promise(resolve => {
    // Guard: `model` is interpolated into a shell command line on Windows (shell:true below — needed
    // to launch the `claude` .cmd shim). Reject anything outside the character set real model ids use,
    // or a crafted model string becomes a command-injection vector (fixed 2026-08-02).
    if (typeof model !== 'string' || !/^[A-Za-z0-9._:\/\[\]-]+$/.test(model)) {
      return resolve({ ok: false, msg: 'invalid model name' });
    }
    const spawn = d.spawn || require('child_process').spawn;
    let done = false;
    const finish = (ok, msg) => { if (!done) { done = true; resolve({ ok, msg }); } };
    let child;
    // Sweep 2 F4: reuse claude-cli's resolved exe with shell:false; the shell is only the fallback when the exe could not be resolved (Node 24 DEP0190).
    const tgt = (d.cliTarget || require('../claude-cli').target)();
    try {
      const plan = require('../claude-cli').planSpawn(tgt, ['--print', '--tools', '', '--strict-mcp-config', '--model', model, 'ok']);
      child = plan.args ? spawn(plan.file, plan.args, { encoding: 'utf8', ...plan.opts }) : spawn(plan.file, { encoding: 'utf8', ...plan.opts });
    } catch (e) { return finish(false, 'could not launch claude: ' + e.message); }
    const { CLI_MISSING, CLI_MISSING_MSG } = require('./claude-cli');
    let errText = '';
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', x => { errText += String(x).slice(0, 2000); });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(false, 'model probe timed out'); }, 25000);
    child.on('error', e => { clearTimeout(timer); finish(false, (e && (e.code === 'ENOENT' || CLI_MISSING.test(String(e.message)))) ? CLI_MISSING_MSG : 'claude CLI error: ' + e.message); });
    // Sweep 2 F1: a missing binary is "not found" (shell 9009 / 127 or the shell's own text), not "rejected model (exit 1)"
    child.on('close', code => { clearTimeout(timer); finish(code === 0, code === 0 ? '' : ((code === 9009 || code === 127 || CLI_MISSING.test(errText)) ? CLI_MISSING_MSG : 'Claude CLI rejected model (exit ' + code + ')')); });
  });
}

// validateSeat(seatName, candidateSeat, cfg, deps) → { ok, msg } — is this seat usable as proposed?
async function validateSeat(seatName, candidateSeat, cfg, deps) {
  const d = depsFor(deps);
  let seat;
  try {
    const trial = { ...(cfg || {}), seats: { ...((cfg && cfg.seats) || {}), [seatName]: candidateSeat } };
    seat = resolveSeat(seatName, trial, { LOCAL_API: process.env.LOCAL_API });
  } catch (e) { return { ok: false, msg: e.message }; }
  if (seat.provider === 'claude-cli') return probeClaudeModel(seat.model, d);
  if (seat.provider === 'codex-cli') {
    const cd = { ...d, cfg };
    const st = await codexProvider.loginStatus(cd);
    if (!st.loggedIn) return { ok: false, msg: st.missing ? 'Codex CLI not found — npm install -g @openai/codex' : 'Codex is not logged in — run codex login' };
    if (!seat.model) return { ok: true, msg: '' };
    const cat = await codexProvider.listModels(cd);
    if (!cat.ok || !cat.models.some(m => m.id === seat.model)) return { ok: false, msg: 'model ' + seat.model + ' is not in your Codex model list' };
    return { ok: true, msg: '' };
  }
  try {
    const ids = await openaiProvider.listModels(seat, { fetchImpl: d.fetchImpl, getKey: d.getKey });
    if (!ids.includes(seat.model)) return { ok: false, msg: 'model "' + seat.model + '" is not listed by ' + seat.url };
    return { ok: true, msg: '' };
  } catch (e) { return { ok: false, msg: e.message }; }
}

// Settings picker data for the ChatGPT plan: { reachable, models:[ids], labels:{id:label}, loggedIn, error? }.
// Never throws (the route always answers 200).
async function codexCatalog(cfg, deps) {
  const cd = { ...depsFor(deps), cfg };
  const [st, cat] = await Promise.all([codexProvider.loginStatus(cd), codexProvider.listModels(cd)]);
  const labels = {};
  for (const m of cat.models) labels[m.id] = m.label;
  const out = { reachable: !st.missing && !cat.missing, models: cat.models.map(m => m.id), labels, loggedIn: !!st.loggedIn };
  if (!out.reachable) out.error = 'Codex CLI not found — npm install -g @openai/codex';
  else if (!st.loggedIn) out.error = 'Codex is not logged in — run codex login';
  else if (!cat.ok) out.error = cat.error;
  return out;
}

// Model ids offered by an endpoint (for the Settings datalist). endpointName e.g. 'openai' | 'local'.
async function listEndpointModels(endpointName, cfg, deps) {
  const d = depsFor(deps);
  const ep = resolveEndpoint(endpointName, cfg);
  return openaiProvider.listModels(ep, { fetchImpl: d.fetchImpl, getKey: d.getKey });
}

module.exports = {
  complete, validateSeat, listEndpointModels, codexCatalog, resolveSeat, SEAT_NAMES, ProviderError,
  listModels: openaiProvider.listModels,
  getKey: secrets.getKey, setKey: secrets.setKey, listKeys: secrets.listKeys,
  _setDeps, _resetDeps,
};
