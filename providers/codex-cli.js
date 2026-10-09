'use strict';
// providers/codex-cli.js — the user's ChatGPT subscription via the Codex CLI (`codex exec`), used
// strictly as a TEXT completer: read-only sandbox, empty working dir, no user config (plugins/MCP
// of the Codex desktop app cost 20-40 s per call otherwise). Prompt text never touches the command
// line: system prompt → a temp FILE (model_instructions_file), user text → stdin. The binary is
// spawned directly (shell:false), never through a .cmd shim.
// Contract measured live 2026-10-06 (Codex CLI 0.160.1) — see planing phase/phoenix-v19-m1-2-codex-cli-codespec.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProviderError } = require('./errors');
const { flatten } = require('./claude-cli');

const NOT_FOUND = 'Codex CLI not found — install it (npm install -g @openai/codex) and run codex login';
const NOT_LOGGED_IN = 'Codex is not logged in — run `codex login` (ChatGPT plan)';
const WIN_VENDOR = path.join('vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');

let _cachedExe;   // undefined = not resolved yet; resolved once, only on the plain (non-injected) path

// cfg: the Phoenix config (cfg.apps.codex wins). deps (all optional, for tests): spawnSyncImpl,
// existsSync, platform, homedir.
function resolveCodexExe(cfg, deps = {}) {
  const injected = !!(deps.spawnSyncImpl || deps.existsSync || deps.platform || deps.homedir);
  const configured = cfg && cfg.apps && typeof cfg.apps.codex === 'string' ? cfg.apps.codex.trim() : '';
  const exists = deps.existsSync || fs.existsSync;
  if (configured && exists(configured)) return configured;
  if (!injected && _cachedExe !== undefined) return _cachedExe;
  const platform = deps.platform || process.platform;
  const spawnSync = deps.spawnSyncImpl || require('child_process').spawnSync;
  let found = null;
  try {
    if (platform === 'win32') {
      const r = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8' });
      const shim = String((r && r.stdout) || '').trim().split(/\r?\n/)[0].trim();
      if (shim) {
        const prefix = path.win32.dirname(shim);
        const nested = path.win32.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', WIN_VENDOR);
        const flat = path.win32.join(prefix, 'node_modules', '@openai', 'codex-win32-x64', WIN_VENDOR);
        found = [nested, flat].find(p => exists(p)) || null;
      }
    } else {
      const cand = path.join(deps.homedir || os.homedir(), '.local', 'bin', 'codex');
      if (exists(cand)) found = cand;
      else {
        const r = spawnSync('which', ['codex'], { encoding: 'utf8' });
        const p = String((r && r.stdout) || '').trim().split(/\r?\n/)[0].trim();
        if (p) found = p;
      }
    }
  } catch (_) { found = null; }
  if (!injected) _cachedExe = found;
  return found;
}
function _resetCache() { _cachedExe = undefined; }

function exeFor(cfg, deps) {
  return deps.codexExe || resolveCodexExe(cfg, deps);
}

// Run the codex binary once. Resolves { code, stdout, stderr, error, timedOut } — never rejects.
function runCodex(exe, args, { input, timeoutMs, deps = {} }) {
  const spawn = deps.spawnImpl || require('child_process').spawn;
  return new Promise(resolve => {
    let done = false, timer = null, child;
    const out = [], err = [];
    const finish = r => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout: out.join(''), stderr: err.join(''), error: null, timedOut: false, ...r });
    };
    try { child = spawn(exe, args, { shell: false, windowsHide: true }); }
    catch (e) { return finish({ error: e }); }
    if (child.stdin && child.stdin.on) child.stdin.on('error', () => {});   // EPIPE if it dies instantly
    if (timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish({ timedOut: true });
      }, timeoutMs);
    }
    child.on('error', e => finish({ error: e }));
    if (child.stdout) child.stdout.on('data', d => out.push(String(d)));
    if (child.stderr) child.stderr.on('data', d => err.push(String(d)));
    child.on('close', code => finish({ code }));
    try { if (input !== undefined) child.stdin.write(input, 'utf8'); child.stdin.end(); } catch (_) {}
  });
}

// The last error Codex reported in its JSONL (turn.failed.error.message / error.message / a top-level error event).
// The message is sometimes itself a JSON string ({"detail":"…"} / {"message":"…"}) — unwrap it. → a clean sentence | ''.
function jsonlError(stdout) {
  let msg = '';
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let j; try { j = JSON.parse(t); } catch (_) { continue; }
    let m = '';
    if (j && j.type === 'turn.failed' && j.error && typeof j.error.message === 'string') m = j.error.message;
    else if (j && j.error && typeof j.error === 'object' && typeof j.error.message === 'string') m = j.error.message;
    else if (j && j.type === 'error' && typeof j.message === 'string') m = j.message;
    if (m) msg = m;
  }
  if (!msg) return '';
  for (let i = 0; i < 2; i++) {   // nested JSON inside the message
    const s = msg.trim();
    if (s[0] !== '{') break;
    try {
      const inner = JSON.parse(s);
      const d = inner && (typeof inner.detail === 'string' ? inner.detail : (typeof inner.message === 'string' ? inner.message : (inner.error && typeof inner.error.message === 'string' ? inner.error.message : '')));
      if (!d) break;
      msg = d;
    } catch (_) { break; }
  }
  return msg.replace(/\s+/g, ' ').replace(/["\\}\s]+$/, m => (/^[\s"}\\]*$/.test(m) ? '' : m)).trim().slice(0, 300);
}

function parseJsonl(stdout) {
  let text = '', usage = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let j; try { j = JSON.parse(t); } catch (_) { continue; }
    if (j && j.type === 'item.completed' && j.item && j.item.type === 'agent_message' && typeof j.item.text === 'string') text = j.item.text;
    else if (j && j.type === 'turn.completed' && j.usage && typeof j.usage === 'object') usage = j.usage;
  }
  return { text: text.trim(), usage };
}

async function complete(seat, { system, messages, timeoutMs = 300000, images = [], cfg, deps = {} } = {}) {
  const ctx = { seat: seat.name, provider: 'codex-cli', model: seat.model };
  const model = typeof seat.model === 'string' ? seat.model : '';
  const effort = seat.raw && seat.raw.reasoningEffort;
  if (model && !/^[A-Za-z0-9._:-]+$/.test(model)) throw new ProviderError('config', 'invalid Codex model id', ctx);
  if (effort !== undefined && !/^(low|medium|high|xhigh|max)$/.test(String(effort))) {
    throw new ProviderError('config', 'invalid reasoningEffort (use low | medium | high | xhigh | max)', ctx);
  }
  const exe = exeFor(cfg, deps);
  if (!exe) throw new ProviderError('config', NOT_FOUND, ctx);

  const user = flatten(messages);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-codex-'));   // the empty -C dir
  const rand = Math.random().toString(16).slice(2, 8);
  const sysFile = path.join(path.dirname(dir), 'phoenix-codex-sys-' + process.pid + '-' + rand + '.txt');
  const imgFiles = [];   // v1.9 M3: next to the system file, NOT inside the empty -C dir (the model must not find them by listing it)
  try {
    fs.writeFileSync(sysFile, system || '', 'utf8');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only', '-C', dir,
      '-c', 'model_instructions_file="' + sysFile.replace(/\\/g, '/') + '"'];
    if (model) args.push('-m', model);
    if (effort !== undefined) args.push('-c', 'model_reasoning_effort="' + effort + '"');
    // Images: one temp file each, `-i <path>` in the given order, before `--json -`. Only paths go on the command
    // line — the prompt text stays on stdin.
    (images || []).forEach((img, n) => {
      const f = path.join(path.dirname(dir), 'phoenix-codex-img-' + process.pid + '-' + rand + '-' + n + '.png');
      imgFiles.push(f);   // registered BEFORE the write, so a partial write is still deleted in finally
      fs.writeFileSync(f, img.data);
      args.push('-i', f);
    });
    args.push('--json', '-');
    const r = await runCodex(exe, args, { input: user, timeoutMs, deps });
    if (r.timedOut) throw new ProviderError('timeout', 'Codex timed out after ' + Math.round(timeoutMs / 1000) + 's', ctx);
    if (r.error) throw new ProviderError('unreachable', 'could not run Codex (' + ((r.error && r.error.message) || r.error) + ')', ctx);
    if (r.code !== 0) {
      const both = r.stderr + '\n' + r.stdout;
      const jerr = jsonlError(r.stdout);   // the real reason first; only without one, the stderr tail
      const tail = jerr || r.stderr.trim().slice(-300) || r.stdout.trim().slice(-300);
      if (/not logged in|login required|unauthori[sz]ed|401/i.test(both)) throw new ProviderError('config', NOT_LOGGED_IN, ctx);
      if (/usage limit|rate limit|quota|429/i.test(both)) throw new ProviderError('rejected', 'ChatGPT plan limit reached: ' + tail, ctx);
      if (imgFiles.length && /image|vision|multimodal|modalit/i.test(tail)) {
        throw new ProviderError('no-vision', 'this model/server did not accept images (' + tail + ')', ctx);
      }
      throw new ProviderError('rejected', jerr ? jerr : 'Codex exit ' + r.code + ': ' + tail, ctx);
    }
    const { text, usage } = parseJsonl(r.stdout);
    if (!text) throw new ProviderError('empty', 'Codex returned no answer text', ctx);
    return { text, usage, imagesSent: imgFiles.length };
  } finally {
    for (const f of imgFiles) { try { fs.unlinkSync(f); } catch (_) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(sysFile); } catch (_) {}
  }
}

// → { ok, models:[{id,label,vision}], error?, missing? } — never throws.
async function listModels(deps = {}) {
  try {
    const exe = exeFor(deps.cfg, deps);
    if (!exe) return { ok: false, models: [], error: NOT_FOUND, missing: true };
    const r = await runCodex(exe, ['debug', 'models'], { timeoutMs: 20000, deps });
    if (r.timedOut) return { ok: false, models: [], error: 'codex debug models timed out' };
    if (r.error) return { ok: false, models: [], error: 'could not run Codex (' + ((r.error && r.error.message) || r.error) + ')' };
    if (r.code !== 0) return { ok: false, models: [], error: 'codex debug models failed (exit ' + r.code + ')' };
    const j = JSON.parse(r.stdout);
    if (!j || !Array.isArray(j.models)) return { ok: false, models: [], error: 'unexpected codex model catalog' };
    const models = j.models.filter(m => m && m.visibility === 'list' && typeof m.slug === 'string').map(m => ({
      id: m.slug,
      label: (typeof m.display_name === 'string' && m.display_name) || m.slug,
      vision: Array.isArray(m.input_modalities) && m.input_modalities.includes('image'),
    }));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: 'could not read the Codex model catalog' };
  }
}

// → { loggedIn, mode: 'chatgpt'|'apikey'|null, raw, missing? }
async function loginStatus(deps = {}) {
  const none = { loggedIn: false, mode: null, raw: '' };
  try {
    const exe = exeFor(deps.cfg, deps);
    if (!exe) return { ...none, missing: true };
    const r = await runCodex(exe, ['login', 'status'], { timeoutMs: 15000, deps });
    const raw = (r.stdout + '\n' + r.stderr).trim();
    if (r.code !== 0 || r.error || r.timedOut) return { ...none, raw };
    if (/Logged in using ChatGPT/i.test(raw)) return { loggedIn: true, mode: 'chatgpt', raw };
    if (/Logged in using an? API key/i.test(raw)) return { loggedIn: true, mode: 'apikey', raw };
    return { ...none, raw };
  } catch (_) { return none; }
}

module.exports = { complete, listModels, loginStatus, resolveCodexExe, _resetCache };
