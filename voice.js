'use strict';

// ─── Voice — speak a line with a saved voice pack ─────────────────────────────
//
// Companion to the Human/Custom-Rig tabs: those make things that move, this makes
// them talk. A *voice pack* is a small .gguf baked once from a reference recording
// (CrispASR `--make-ref`); from then on the same character can speak any number of
// lines and stays the same person across separate calls. That constancy is the whole
// reason packs exist — a bare WAV reference re-rolls the speaker on every request.
//
// Generation runs where the GPU is. CrispASR ships an OpenAI-compatible speech
// server, so this is the same shape as hyMotion: an HTTP endpoint in the config,
// nothing hardcoded, and it may live on another machine.
//
//   POST {voice.api}/v1/audio/speech   {model, voice, input}  -> audio/wav
//   GET  {voice.api}/v1/voices                                -> {voices:[{name,format}]}
//   GET  {voice.api}/health                                   -> {status,backend}
//
// Effects go through sound-fx.js — the SAME core the Sound-Design tab uses. Built as
// one module on purpose: two tabs that each grow their own effect code drift apart,
// which is exactly what the shared seam core in animate_human.js was created to avoid.
//
// ffmpeg is required for effects only. Plain speaking works without it.

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFile, spawn } = require('child_process');
const soundFx = require('./sound-fx');
// The voice-engine picker registry. Required the same way i2i.js pulls it in (workflows.js takes no
// project-local requires itself, so no cycle).
const wfLib = require('./workflows');

const OUT_DIR = path.join(__dirname, 'sounds', 'vo');
// Reference voices for cloning engines (Chatterbox): the user drops clean WAVs here. Created on demand.
const REFS_DIR = path.join(__dirname, 'sounds', 'refs');
let DISPATCHER_SCRIPT = path.join(__dirname, 'voice-dispatcher.js');
const DEFAULT_DISPATCHER_PORT = 8091;

// ── config ───────────────────────────────────────────────────────────────────
function cfg() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'phoenix-config.json'), 'utf8'));
    return (c && c.voice) || {};
  } catch (_) { return {}; }
}
function apiBase() {
  const a = (cfg().api || '').trim();
  return a.replace(/\/+$/, '');
}
// The whole phoenix-config.json (voice.js's cfg() only returns the `voice` block).
function fullCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'phoenix-config.json'), 'utf8')) || {}; } catch (_) { return {}; }
}
// VO1b: shown whenever a CrispASR-only action (bake a pack, list voice packs) has no CrispASR server to talk to.
const NEEDS_CRISPASR = 'This needs a CrispASR speech server (voice.api). Chatterbox needs no pack — pick a reference voice instead.';

// Where ffmpeg lives. Explicit config wins; otherwise the imageio-ffmpeg binary that
// ships with the Python toolchain — it is present but NOT on PATH, which is why a bare
// "ffmpeg" call fails on this machine even though ffmpeg exists.
function ffmpegPath() {
  const fromCfg = (cfg().ffmpeg || '').trim();
  if (fromCfg) return fromCfg;
  const guesses = [
    path.join(process.env.APPDATA || '', 'Python', 'Python314', 'site-packages',
              'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v7.1.exe'),
  ];
  for (const g of guesses) { try { if (fs.existsSync(g)) return g; } catch (_) {} }
  return 'ffmpeg';
}

// ── tiny HTTP helpers (node core only — Phoenix has no npm deps) ─────────────
function request(urlStr, { method = 'GET', body = null, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('bad url: ' + urlStr)); return; }
    // Scheme-aware: an https voice.api used to fail — request() only ever spoke http and defaulted the
    // port to 80, so a TLS endpoint got a plaintext request on the wrong port (fixed 2026-08-02).
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method,
      headers: body ? { 'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks),
                                    type: res.headers['content-type'] || '',
                                    // Voice seed (2026-09-26): the seed the engine used comes back as a
                                    // response header (X-Voice-Seed), not in the JSON/audio body — expose
                                    // the raw node headers object so callers can read it.
                                    headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout after ' + timeoutMs + 'ms')); });
    if (body) req.write(body);
    req.end();
  });
}

function slug(s) {
  return String(s || 'line').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'line';
}

// Voice seed (2026-09-26): `undefined`/`null`/`''` means "no seed" (the adapter rolls one); anything
// else must be an integer 0..2147483647 (a number, or a string of plain digits) or it's a format error.
// Validated before any network call so a typo never spends a generation.
function parseSeed(seed) {
  if (seed === undefined || seed === null || seed === '') return { none: true };
  let n;
  if (typeof seed === 'number') {
    n = seed;
  } else if (typeof seed === 'string' && /^\d+$/.test(seed.trim())) {
    n = Number(seed.trim());
  } else {
    return { error: true };
  }
  if (!Number.isInteger(n) || n < 0 || n > 2147483647) return { error: true };
  return { none: false, value: n };
}

// ── public ───────────────────────────────────────────────────────────────────

async function health() {
  const base = apiBase();
  if (!base) return { ok: false, error: 'voice.api is not set in phoenix-config.json' };
  try {
    const r = await request(base + '/health', { timeoutMs: 8000 });
    if (r.status !== 200) return { ok: false, error: 'speech server answered HTTP ' + r.status };
    let j = {};
    try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) {}
    // `mode` comes from the per-call service, `backend` from a resident TTS server.
    // `kasse` is the shared VRAM ledger (added 2026-07-27): free/total GB plus who
    // is holding the card. It travels through untouched so the tab can answer
    // "can I even do this right now?" BEFORE the user presses anything — the 10 GB
    // card is shared with ComfyUI and the batch queue, and the old answer to a
    // busy card was a silent hang.
    return { ok: true, backend: j.mode || j.backend || '?', api: base,
             kasse: j.kasse || null, busy: !!j.busy, busyWith: j.busyWith || null };
  } catch (e) {
    return { ok: false, error: 'speech server not reachable at ' + base + ' — ' + e.message };
  }
}

async function listVoices() {
  const base = apiBase();
  if (!base) return { error: NEEDS_CRISPASR };
  try {
    const r = await request(base + '/v1/voices', { timeoutMs: 8000 });
    if (r.status === 404) return { error: NEEDS_CRISPASR };
    if (r.status !== 200) return { error: 'HTTP ' + r.status + ' from ' + base + '/v1/voices' };
    const j = JSON.parse(r.buf.toString('utf8'));
    const voices = (j.voices || []).map(v => ({ name: v.name, format: v.format || '' }));
    voices.sort((a, b) => a.name.localeCompare(b.name));
    return { voices };
  } catch (e) {
    return { error: 'could not list voices — ' + e.message };
  }
}

// listVoice() — the voice-engine picker's data source (Stage 2d), mirroring i2i.js's listI2I(): reads
// the SAME workflow registry i2i uses, filtered to stage==='voice'. Not wired to its own HTTP route —
// like listI2I, the browser reads the generic GET /workflows response and filters client-side (see
// web/index.html's loadEngines()/initVoiceEnginePicker()); this function is the programmatic/test seam.
function listVoice() {
  const reg = wfLib.loadRegistry();
  const hasDispatcher = wfLib.dispatcherMode(cfg()) !== 'off';   // cfg() returns the `voice` sub-object; both dispatcher shapes count (VO1)
  return Object.entries(reg.workflows || {})
    .filter(([, e]) => e.stage === 'voice')
    .map(([id, e]) => {
      const av = wfLib.engineAvailability(e, hasDispatcher);
      return {
        id,
        label:              e.label || id,
        builtin:            !!e.builtin,
        requiresDispatcher: !!e.requiresDispatcher,
        available:          av.available,
        // Effective (post-gate) blocked/blockedReason — what the UI greys on. A dispatcher-gated engine
        // on a config without the dispatcher reads as blocked here even though its own `blocked` field
        // is unset; an available engine clears both. English reasons only.
        // N2: the token reflects the EFFECTIVE governing gate, mirroring engineAvailability's precedence
        // (dispatcher FIRST). Previously cosyvoice emitted 'venv' while chatterbox emitted 'dispatcher'
        // for the SAME missing-dispatcher condition — confusing, since blockedReason already reports the
        // dispatcher gate as the active one. Now: dispatcher gate active → 'dispatcher'; otherwise the
        // engine's own block ('venv') or a plain truthy.
        blocked:            av.available ? null : ((e.requiresDispatcher && !hasDispatcher) ? 'dispatcher' : (e.blocked || true)),
        blockedReason:      av.available ? null : av.reason,
        license:            (e.install && e.install.license) || null,
        hasInstall:         !!e.install,
      };
    });
}

function listEffects() {
  // Only the ones that make sense on a spoken line. The cleanup/shaping blocks live
  // in the Sound-Design tab; here we offer character effects plus a level fix.
  const wanted = ['radio', 'creature', 'pitch', 'saturate', 'level', 'trim'];
  return soundFx.listEffects().filter(e => wanted.includes(e.id));
}

function runFfmpeg(inFile, outFile, chain) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile,
                  '-filter_complex', chain.filter, '-map', '[out]', outFile];
    execFile(ffmpegPath(), args, { timeout: 120000 }, (err, _o, stderr) => {
      if (err) { reject(new Error('ffmpeg failed: ' + (stderr || err.message).trim().slice(0, 300))); return; }
      resolve();
    });
  });
}

// Resolve+validate the requested engine against the stage:"voice" registry. Default (absent/empty
// `engine`) is ALWAYS "crispasr" — the always-available, integrated default. An unknown id, a
// dispatcher-gated engine on a config that doesn't declare the dispatcher, or a `blocked` entry (e.g.
// cosyvoice — see workflows.js) is a loud error, never a silent fallback to crispasr (the same rule
// the voice-service's own /speak dispatch enforces rig-side). Availability is computed by
// workflows.engineAvailability against this install's voice.dispatcher capability.
function resolveEngine(engine) {
  const id = (engine == null || engine === '') ? 'crispasr' : String(engine);
  if (id === 'crispasr') return { ok: true, id };
  const reg = wfLib.loadRegistry();
  const entry = reg.workflows && reg.workflows[id];
  if (!entry || entry.stage !== 'voice') {
    return { ok: false, error: `unknown voice engine "${id}" — no silent fallback to crispasr` };
  }
  const av = wfLib.engineAvailability(entry, wfLib.dispatcherMode(cfg()) !== 'off');
  if (!av.available) {
    return { ok: false, error: `voice engine "${id}" is not available yet (${av.reason}) — no silent fallback to crispasr` };
  }
  return { ok: true, id };
}

// ── reference voices (VO1) ────────────────────────────────────────────────────
// A cloning engine needs a WAV of the voice to clone. There is NO built-in default reference: the
// user puts a clean 10–20 s WAV into sounds/refs/ and picks it by file name. The server resolves that
// name to an absolute path (basename only, .wav only) — nothing else is ever sent as `reference`.
// A reference is a REGULAR FILE whose real path (symlinks resolved) stays inside sounds/refs/ - a symlink pointing out of the
// folder, or a directory that happens to be called x.wav, is not one.
function refInside(p) {
  try {
    const real = fs.realpathSync(p), root = fs.realpathSync(REFS_DIR);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return fs.statSync(real).isFile();
  } catch (_) { return false; }
}
function listRefs() {
  let files = [];
  try {
    files = fs.readdirSync(REFS_DIR).filter(f => /\.wav$/i.test(f) && refInside(path.join(REFS_DIR, f))).sort((a, b) => a.localeCompare(b));
  } catch (_) { /* folder not created yet */ }
  return { dir: REFS_DIR, files };
}
function resolveRef(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return { error: 'pick a reference voice first' };
  if (n !== path.basename(n) || /[\/\\]/.test(n) || n.includes('..') || !/\.wav$/i.test(n)) {
    return { error: 'invalid reference — pick a .wav file from sounds/refs/' };
  }
  const p = path.join(REFS_DIR, n);
  if (!fs.existsSync(p)) return { error: 'reference not found in sounds/refs/: ' + n };
  if (!refInside(p)) return { error: 'invalid reference — it must be a regular .wav file inside sounds/refs/' };
  return { path: p };
}
function openRefsFolder() {
  try {
    fs.mkdirSync(REFS_DIR, { recursive: true });
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [REFS_DIR], () => {});
    return { ok: true, dir: REFS_DIR };
  } catch (e) {
    return { error: 'could not open ' + REFS_DIR + ' — ' + e.message };
  }
}

// ── local dispatcher child (VO1) ──────────────────────────────────────────────
// voice.dispatcher = { local: true, port? } → Phoenix runs voice-dispatcher.js itself on 127.0.0.1 and
// sends it every non-crispasr speak. States: stopped | starting | running | error. A failure (port busy,
// early exit, no healthy answer in 10 s) is an `error` with the reason and stays one until the user
// presses Restart — no silent retry loop. The child is stopped when Phoenix exits.
const disp = { child: null, state: 'stopped', reason: null, port: null, root: null, stopPort: null, shut: false, lines: [], userStopped: false, gen: 0, exitHooked: false };
let LOG_DIR = path.join(__dirname, 'logs');
let HEALTH_TIMEOUT_MS = 10000;

function localPort() {
  const d = cfg().dispatcher;
  const p = d && typeof d === 'object' ? Number(d.port) : NaN;
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_DISPATCHER_PORT;
}
function dispLog(line) {
  const t = String(line).replace(/\r?\n$/, '');
  if (!t) return;
  disp.lines.push(t);
  if (disp.lines.length > 200) disp.lines.splice(0, disp.lines.length - 200);
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'voice-dispatcher.log'), new Date().toISOString() + ' ' + t + '\n'); } catch (_) {}
}
function dispFeed(buf) { String(buf).split(/\r?\n/).forEach(l => { if (l.trim()) dispLog(l); }); }

// The engines file the child reads: the reference folder + every dispatcher engine the registry knows.
// The adapter is the SHIPPED voice-engines/<adapter>; the venv is voiceInstall.voice.root/<venv.path>.
function currentRoot() {
  const full = fullCfg();
  return (full.voiceInstall && full.voiceInstall.voice && full.voiceInstall.voice.root) || null;
}
function writeEnginesFile() {
  const root = currentRoot();
  const reg = wfLib.loadRegistry();
  const engines = {};
  for (const [id, e] of Object.entries(reg.workflows || {})) {
    const eng = e && e.stage === 'voice' && e.requiresDispatcher && !e.blocked && e.install && e.install.engine;
    if (!eng || !eng.adapter) continue;
    engines[id] = {
      venv: root ? path.join(root, (eng.venv && eng.venv.path) || 'venv') : null,
      adapter: path.join(__dirname, 'voice-engines', eng.adapter),
      cwd: root || __dirname,
    };
    // VO1b: the HF cache lives INSIDE the engine root (Uninstall = delete one folder). The adapter child gets it as HF_HOME so
    // from_pretrained finds the files Acquire fetched and never downloads at speak time; `model` lets /health check they are there.
    const w = eng.weights || {};
    if (root && w.dir && !path.isAbsolute(w.dir)) {
      engines[id].env = { HF_HOME: path.join(root, w.dir), HF_HUB_OFFLINE: '1' };   // no hub calls at speak time
      if (w.source && w.source.hf && Array.isArray(w.source.files)) engines[id].model = { repo: w.source.hf, files: w.source.files.slice() };
    }
  }
  fs.mkdirSync(REFS_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, 'voice-dispatcher-engines.json');
  fs.writeFileSync(file, JSON.stringify({ refsDir: REFS_DIR, engines }, null, 2), 'utf8');
  return file;
}

// Windows has no signal names: child.kill() there, SIGKILL / SIGTERM elsewhere.
function killProc(c, soft) {
  try { if (process.platform === 'win32') c.kill(); else c.kill(soft ? 'SIGTERM' : 'SIGKILL'); } catch (_) {}
}
// Stop = close the child's stdin FIRST (it kills its in-flight engine python and exits by itself - the only graceful route on
// Windows, where kill() is a hard TerminateProcess), then force it after 2 s. The promise resolves at the child's exit OR after the
// bounded wait (4 s); the caller then DROPS the child reference even if the hard kill has not been confirmed (known limit, see DEVNOTE).
function killDispatcher() {
  const c = disp.child;
  if (!c) return Promise.resolve();
  if (c.exitCode !== null && c.exitCode !== undefined) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const fin = () => { if (!done) { done = true; clearTimeout(t); clearTimeout(t2); resolve(); } };
    const t = setTimeout(() => { killProc(c, false); fin(); }, 4000);
    const t2 = setTimeout(() => killProc(c, true), 2000);
    c.once('exit', fin);
    try { c.stdin.end(); } catch (_) { killProc(c, true); }
  });
}

function startDispatcher() {
  const port = localPort();
  const gen = ++disp.gen;
  disp.port = port; disp.root = currentRoot(); disp.state = 'starting'; disp.reason = null; disp.userStopped = false;
  disp.lines = [];
  let sawListening = false, finished = false;
  const fail = (reason) => {
    if (finished || gen !== disp.gen) return;
    finished = true; disp.state = 'error'; disp.reason = reason; dispLog('[phoenix] ' + reason);
    const c = disp.child; if (c) killProc(c, true);
  };
  let child;
  try {
    const enginesFile = writeEnginesFile();
    child = spawn(process.execPath, [DISPATCHER_SCRIPT, '--port', String(port), '--engines', enginesFile, '--exit-on-stdin-close'],
                  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) { disp.child = null; fail('could not start the dispatcher: ' + e.message); return; }
  disp.child = child;
  if (!disp.exitHooked) {
    disp.exitHooked = true;
    // 'exit' handlers are synchronous, so nothing can be awaited here. We ONLY close the pipe and do NOT kill: a hard kill would race
    // the dispatcher's own cleanup and could orphan its engine python (Windows). The dispatcher's EOF handler kills its engine and exits
    // by itself. A waiting stop is dispatcherShutdown()/Stop.
    process.on('exit', () => { try { if (disp.child) disp.child.stdin.destroy(); } catch (_) {} });
  }
  child.stdout.on('data', d => { dispFeed(d); if (/listening on/.test(String(d))) sawListening = true; });
  child.stderr.on('data', d => dispFeed(d));
  child.on('error', e => fail('could not start the dispatcher: ' + e.message));
  child.on('exit', (code) => {
    if (disp.child === child) disp.child = null;
    if (gen !== disp.gen) return;
    if (finished && disp.state !== 'running') return;
    if (disp.userStopped) { disp.state = 'stopped'; return; }
    const lastErr = disp.lines.slice().reverse().find(l => /port \d+ is already in use|cannot read|error/i.test(l));
    finished = false;
    fail(lastErr ? lastErr.replace(/^voice-dispatcher:\s*/, '') : ('the dispatcher exited (code ' + code + ')'));
  });
  // Health poll: "running" needs BOTH the child's own listening line and a real {status:'ok'} answer,
  // so a foreign process on the port can never pass for our dispatcher.
  const t0 = Date.now();
  (function poll() {
    if (finished || gen !== disp.gen || disp.child !== child) return;
    if (Date.now() - t0 > HEALTH_TIMEOUT_MS) { fail('no healthy answer from the dispatcher within ' + Math.round(HEALTH_TIMEOUT_MS / 1000) + ' s'); return; }
    if (!sawListening) { setTimeout(poll, 100); return; }
    request('http://127.0.0.1:' + port + '/health', { timeoutMs: 2000 }).then(r => {
      let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) {}
      if (finished || gen !== disp.gen) return;
      if (r.status === 200 && j && j.status === 'ok') { finished = true; disp.state = 'running'; dispLog('[phoenix] dispatcher running on 127.0.0.1:' + port); }
      else setTimeout(poll, 150);
    }).catch(() => setTimeout(poll, 150));
  })();
}

function dispatcherStatus() {
  const mode = wfLib.dispatcherMode(cfg());
  if (mode !== 'local') return { mode, state: 'stopped', lastLines: [] };
  const s = { mode, state: disp.state, port: disp.port || localPort(), lastLines: disp.lines.slice() };   // the whole bounded ring (<= 200 lines)
  if (disp.reason) s.reason = disp.reason;
  return s;
}

// ── ONE serialized dispatcher lifecycle (VO1b R3) ─────────────────────────────────────────────────────────────
// Every action — config sync (on/off/port/root), the Restart button, Stop, shutdown — only changes the REQUESTED state (config + the
// userStopped / forceRestart flags) and then calls lifecycle(). lifecycle() runs ONE async loop; a call while it runs just asks for
// another pass, so the LATEST requested state always wins (a Stop during a queued restart means: no child is started afterwards).
// A dying child is awaited (exit, then its port freed - bounded, async) before any start; the child reference is dropped only after
// it has really exited, so no orphan is left behind.
let lcP = null, lcAgain = false, forceRestart = false, lcBusy = false;   // lcBusy: a kill / port wait is in flight
function portInUse(port) {
  return new Promise(resolve => {
    const s = require('net').connect({ port, host: '127.0.0.1' });
    let done = false; const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(500, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}
const wantRun = () => wfLib.dispatcherMode(cfg()) === 'local' && !disp.userStopped && !disp.shut;
async function lifecycleStep() {
  const mode = wfLib.dispatcherMode(cfg());
  if (mode !== 'local') { disp.port = disp.child ? disp.port : null; }
  const port = localPort(), root = currentRoot();
  // a port change in the config AFTER the user pressed Stop is a new user action (as before): it lifts the Stop
  if (disp.userStopped && !disp.shut && mode === 'local' && disp.stopPort != null && port !== disp.stopPort) { disp.userStopped = false; disp.stopPort = null; }
  const changed = disp.port != null && (disp.port !== port || (disp.child ? disp.root !== root : false));
  let started = false;
  if (disp.child && (!wantRun() || changed || forceRestart)) {
    disp.state = wantRun() ? 'starting' : 'stopped'; disp.reason = null;
    const oldPort = disp.port;
    disp.gen++;
    lcBusy = true;
    try {
      await killDispatcher(); disp.child = null;
      for (let i = 0; oldPort && i < 30 && await portInUse(oldPort); i++) await new Promise(r => setTimeout(r, 100));   // bounded: 3 s
    } finally { lcBusy = false; }
    started = true;   // a deliberate restart: an earlier error does not block the new start
  }
  if (!wantRun()) {   // re-read AFTER the awaits: a Stop / off that arrived meanwhile wins
    disp.state = 'stopped'; disp.reason = null; if (mode !== 'local') disp.port = null;
    forceRestart = false;
    return;
  }
  if (!disp.child && (started || forceRestart || changed || disp.state !== 'error')) {
    forceRestart = false;
    startDispatcher();
  }
}
function lifecycle() {
  if (lcP) { lcAgain = true; if (lcBusy) { disp.state = wantRun() ? 'starting' : 'stopped'; disp.reason = null; } return lcP; }   // a transition is in flight: show the latest requested state
  lcP = (async () => {
    try { do { lcAgain = false; await lifecycleStep(); } while (lcAgain); }
    finally { lcP = null; }
  })();
  return lcP;
}

// Idempotent: call on server start and after every config save. Local mode on = make sure it runs
// (unless the user stopped it or it failed - those need the user); anything else = stop it.
function dispatcherSync() {
  if (wfLib.dispatcherMode(cfg()) !== 'local' && !disp.child) { disp.state = 'stopped'; disp.reason = null; disp.port = null; }
  lifecycle();
  return dispatcherStatus();
}

async function dispatcherRestart() {
  if (wfLib.dispatcherMode(cfg()) !== 'local') return { error: 'the local dispatcher is not enabled (voice.dispatcher = { "local": true })', status: 400 };
  disp.userStopped = false; disp.shut = false; forceRestart = true;   // an explicit Restart lifts even a shutdown (tests / re-use of the module)
  await lifecycle();
  return dispatcherStatus();
}
async function dispatcherStop() {
  if (wfLib.dispatcherMode(cfg()) !== 'local') return { error: 'the local dispatcher is not enabled (voice.dispatcher = { "local": true })', status: 400 };
  disp.userStopped = true; disp.stopPort = localPort(); forceRestart = false;
  await lifecycle();
  return dispatcherStatus();
}
// Called on Phoenix shutdown: the child must not outlive us. Graceful first (stdin closed, up to 2 s, then a hard kill - see
// killDispatcher). ONE lifecycle: every caller (a second Ctrl+C included) waits for the same cleanup.
function dispatcherShutdown() {
  disp.userStopped = true; disp.shut = true; forceRestart = false;
  return lifecycle();
}

// ── Settings → Voice (VO1b) ───────────────────────────────────────────────────
// A view + validated writes for voice.dispatcher / voiceInstall.voice / voice.watermark / voice.consentAck, so a
// customer never edits phoenix-config.json by hand. server.js calls settingsView() (GET/POST /config) and
// validateSettings()+applySettings() (POST /config); nothing here touches the disk but statfsSync.
const DEFAULT_ROOT_NAME = 'voice-engines-env';
const ENGINE_NEED_GB = 9;   // Chatterbox: ~5.4 GB Python + CUDA libraries + ~3.2 GB voice model
function defaultInstallRoot() { return path.join(__dirname, DEFAULT_ROOT_NAME); }
const freeCache = new Map();   // resolved path -> { at, gb }  (statfs + the ancestor walk are not repeated on every GET /config)
// R3-M1: NEVER measured on the request path. A fresh cache entry is returned as is; a miss / stale entry returns the old value (or null =
// "unknown") and measures once, deferred with setImmediate (statfs + the ancestor walk run off the request); the next GET sees the figure.
const freeBusy = new Set();
function freeGbAt(p) {
  const key = path.resolve(p), hit = freeCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.gb;
  if (!freeBusy.has(key)) {
    freeBusy.add(key);
    freeGbUncached(key).catch(() => null).then((gb) => {   // fully async: fs.promises only, no sync fs call on this path
      freeCache.set(key, { at: Date.now(), gb });
      freeBusy.delete(key);
    });
  }
  return hit ? hit.gb : null;
}
// Drop every cached figure (after Acquire finishes, when the install folder changes): the next GET re-measures.
function invalidateFreeSpace() { freeCache.clear(); }
async function freeGbUncached(p) {
  try {
    let q = path.resolve(p);
    for (let i = 0; i < 64; i++) {   // nearest existing ancestor
      try { await fs.promises.stat(q); break; } catch (_) { const up = path.dirname(q); if (up === q) break; q = up; }
    }
    const s = await fs.promises.statfs(q);
    const gb = Number(s.bavail) * Number(s.bsize) / 1e9;
    return Number.isFinite(gb) ? Math.round(gb * 10) / 10 : null;
  } catch (_) { return null; }
}
function engineInstalledAt(root) {
  try { return !!root && (fs.existsSync(path.join(root, 'venv', 'Scripts', 'python.exe')) || fs.existsSync(path.join(root, 'venv', 'bin', 'python'))); } catch (_) { return false; }
}
function settingsView(full) {
  const f = full || fullCfg();
  const v = (f && f.voice && typeof f.voice === 'object') ? f.voice : {};
  const mode = wfLib.dispatcherMode(v);
  const vi = plainObj(f && f.voiceInstall) ? f.voiceInstall.voice : null;
  const root = (vi && vi.root) || defaultInstallRoot();
  const dp = (v.dispatcher && typeof v.dispatcher === 'object') ? Number(v.dispatcher.port) : NaN;
  const port = (Number.isInteger(dp) && dp > 0) ? dp : DEFAULT_DISPATCHER_PORT;
  return {
    dispatcherLocal: mode === 'local', rig: v.dispatcher === true, mode,
    installRoot: root, defaultRoot: defaultInstallRoot(), installed: engineInstalledAt(root),
    port, watermark: v.watermark !== false, consentAck: v.consentAck === true,
    needGb: ENGINE_NEED_GB, freeGb: freeGbAt(root),
  };
}
// Strip trailing separators but keep a filesystem root intact ("/", "D:\").
function stripTrailingSep(p) {
  const root = path.parse(p).root;
  const s = String(p).replace(/[\\/]+$/, '');
  return s.length < root.length ? root : s;
}
function plainObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
// Normalize for the "inside output/ sounds/ session/" check: strip the \\?\ long-path prefix, resolve, case-insensitive on win32.
function normForCompare(p) {
  let s = String(p).replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\/, '');
  s = path.resolve(s).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
function insideDir(p, dir) {
  const rel = path.relative(normForCompare(dir), normForCompare(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const VOICE_KEYS = ['dispatcherLocal', 'installRoot', 'port', 'watermark', 'consentAck'];
// -> { error, field } | { staged }
function validateSettings(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'Voice settings must be an object.', field: 'voice' };
  const st = {};
  for (const k of Object.keys(b)) if (!VOICE_KEYS.includes(k)) return { error: 'Unknown voice setting "' + k + '".', field: k };
  if ('dispatcherLocal' in b) {
    if (typeof b.dispatcherLocal !== 'boolean') return { error: 'Run voice engines on this PC must be true or false.', field: 'dispatcherLocal' };
    st.dispatcherLocal = b.dispatcherLocal;
  }
  if ('installRoot' in b) {
    const r = b.installRoot;
    if (typeof r !== 'string' || !r.trim()) return { error: 'Install folder must be a folder path.', field: 'installRoot' };
    if (!path.isAbsolute(r.trim())) return { error: 'Install folder must be an absolute path.', field: 'installRoot' };
    const abs = path.resolve(r.trim().replace(/^\\\\[?.]\\(?!UNC\\)/i, ''));
    for (const bad of ['output', 'sounds', 'session']) {
      if (insideDir(abs, path.join(__dirname, bad))) return { error: 'Install folder must not be inside ' + bad + '/.', field: 'installRoot' };
    }
    st.installRoot = stripTrailingSep(abs);
  }
  if ('port' in b) {
    if (!Number.isInteger(b.port) || b.port < 1024 || b.port > 65535) return { error: 'Port must be a whole number between 1024 and 65535.', field: 'port' };
    st.port = b.port;
  }
  for (const k of ['watermark', 'consentAck']) {
    if (k in b) {
      if (typeof b[k] !== 'boolean') return { error: (k === 'watermark' ? 'Watermark' : 'Consent') + ' must be true or false.', field: k };
      st[k] = b[k];
    }
  }
  if (!Object.keys(st).length) return { error: 'No voice settings provided.', field: 'voice' };
  return { staged: st };
}
// Applies validated settings to `fresh` (the whole config object). -> { error, field } | { rootChanged? }
function applySettings(fresh, st) {
  if (!fresh.voice || typeof fresh.voice !== 'object') fresh.voice = {};
  const v = fresh.voice;
  if (v.dispatcher === true && ('dispatcherLocal' in st)) return { error: 'The rig dispatcher is set in phoenix-config.json and cannot be changed here.', field: 'dispatcherLocal' };
  if (!plainObj(fresh.voiceInstall)) fresh.voiceInstall = {};
  const oldRoot = (plainObj(fresh.voiceInstall.voice) && fresh.voiceInstall.voice.root) || null;
  const cp0 = (v.dispatcher && typeof v.dispatcher === 'object') ? Number(v.dispatcher.port) : NaN;
  const curPort = Number.isInteger(cp0) ? cp0 : null;
  // the port lives in voice.dispatcher.port ONLY
  if ('port' in st) {
    if (v.dispatcher === true) return { error: 'The port is set by the rig dispatcher (phoenix-config.json).', field: 'port' };
    if (!(v.dispatcher && typeof v.dispatcher === 'object') && st.dispatcherLocal !== true) return { error: 'Turn on "Run voice engines on this PC" first, then set the port.', field: 'port' };
  }
  if ('port' in st && v.dispatcher && typeof v.dispatcher === 'object') v.dispatcher.port = st.port;
  if (st.dispatcherLocal === true) {
    v.dispatcher = { local: true, port: st.port || curPort || DEFAULT_DISPATCHER_PORT };
  } else if (st.dispatcherLocal === false) {
    if (v.dispatcher && typeof v.dispatcher === 'object') delete v.dispatcher;
  }
  const vi = fresh.voiceInstall.voice && typeof fresh.voiceInstall.voice === 'object' ? fresh.voiceInstall.voice : null;
  if ('installRoot' in st) fresh.voiceInstall.voice = Object.assign({}, vi || {}, { root: st.installRoot, via: (vi && vi.via) || 'local' });
  else if (st.dispatcherLocal === true && !(vi && vi.root)) fresh.voiceInstall.voice = Object.assign({}, vi || {}, { root: defaultInstallRoot(), via: (vi && vi.via) || 'local' });
  if ('watermark' in st) v.watermark = st.watermark;
  if ('consentAck' in st) v.consentAck = st.consentAck;
  const nowRoot = fresh.voiceInstall.voice && fresh.voiceInstall.voice.root;
  if ('installRoot' in st) invalidateFreeSpace();
  const out = {};
  if ('installRoot' in st && oldRoot && nowRoot && path.resolve(oldRoot) !== path.resolve(nowRoot) && engineInstalledAt(oldRoot)) {
    out.rootChanged = { from: oldRoot, to: nowRoot,
      warning: 'The engine installed in ' + oldRoot + ' stays there — install again or move the folder.' };
  }
  return out;
}

// speak({voice, text, effect, strength, engine, seed, reference}) -> { file, url, seconds, effect, filter, seed, seedIgnored }
async function speak({ voice, text, effect, strength, engine, seed, reference } = {}) {
  const base = apiBase();
  // VO1 local mode: a non-crispasr engine is served by the local dispatcher, so it needs neither voice.api
  // nor a voice pack (the reference WAV is the voice). crispasr and everything else is unchanged.
  const engId = (engine == null || engine === '') ? 'crispasr' : String(engine);
  const localRoute = engId !== 'crispasr' && wfLib.dispatcherMode(cfg()) === 'local';
  if (!base && !localRoute) return { error: 'voice.api is not set in phoenix-config.json' };
  if (!voice && !localRoute) return { error: 'pick a voice pack first' };
  // A pack name is a NAME, never a path: `voice` goes into the output filename below (path.join). Without
  // this guard a name like "../../characters/hero" would write the WAV outside OUT_DIR (fixed 2026-08-02).
  if (voice && /[\/\\]|\.\./.test(String(voice))) return { error: 'invalid voice pack name' };
  if (!text || !String(text).trim()) return { error: 'nothing to say — type a line' };

  const eng = resolveEngine(engine);
  if (!eng.ok) return { error: eng.error };

  // Voice seed (2026-09-26): validated before any network call — see parseSeed().
  const seedInfo = parseSeed(seed);
  if (seedInfo.error) return { error: 'seed must be a whole number between 0 and 2147483647' };
  // crispasr is a fixed speaker pack with no seed knob (voice-host contract) — a given seed is accepted but
  // ignored, never sent as `params`, so the crispasr request body stays byte-for-byte as before this
  // feature existed.
  const seedIgnored = eng.id === 'crispasr' && !seedInfo.none;
  const sendSeed = eng.id !== 'crispasr' && !seedInfo.none;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base_name = (voice || eng.id) + '_' + slug(text) + '_' + stamp;

  const reqBody = { model: 'tada', voice, input: String(text), engine: eng.id };
  if (sendSeed) reqBody.params = { seed: seedInfo.value };
  // VO1b: the Perth watermark is ON unless the user explicitly turned it off in Settings -> Voice.
  if (eng.id !== 'crispasr' && cfg().watermark === false) reqBody.params = Object.assign(reqBody.params || {}, { watermark: false });

  // VO1 reference voice. Phoenix resolves the chosen NAME to an absolute path under sounds/refs/ (basename
  // only, .wav only) and sends that as `reference`. Local mode requires one - there is no default voice.
  // Rig mode sends it when chosen (so the rig adapter gets a real file instead of its own fallback) but
  // stays optional there, so today's rig calls keep working byte-for-byte.
  let target = { url: base + '/v1/audio/speech' };
  if (eng.id !== 'crispasr') {
    const wantRef = localRoute || (reference != null && String(reference).trim() !== '');
    if (wantRef) {
      // VO1b: cloning a voice needs the one-time consent ("your own voice, your characters"), stored server-side.
      if (cfg().consentAck !== true) return { error: 'confirm the voice consent first (Settings → Voice)', status: 409, consentRequired: true };
      const rr = resolveRef(reference);
      if (rr.error) return { error: rr.error };
      reqBody.reference = rr.path;
    }
  }
  if (localRoute) {
    const st = dispatcherStatus();
    if (st.state !== 'running') {
      return { error: 'the local voice dispatcher is ' + st.state + (st.reason ? ' (' + st.reason + ')' : '') + ' - see the status line under the engine picker' };
    }
    delete reqBody.model; delete reqBody.voice;
    target = { url: 'http://127.0.0.1:' + st.port + '/speak' };
  }

  let r;
  try {
    r = await request(target.url, {
      method: 'POST',
      // `engine` (Stage 2d): default "crispasr" reproduces the exact prior body/behavior — the
      // the voice host's /v1/audio/speech + /speak already default to "crispasr" when the field is absent
      // (Part 2b, LIVE), so sending it explicitly here changes nothing for the default case.
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    return { error: 'speech server not reachable at ' + (localRoute ? target.url : base) + ' — ' + e.message };
  }
  if (r.status !== 200) {
    // The server answers errors as text/json — surface ITS wording, not an HTTP dump.
    // A 429 here is the VRAM ledger refusing: that message already names who holds
    // the card and what to do about it, and a JSON blob pasted in front only buries
    // it. Same shape sfx.js already uses.
    let j = null;
    try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) {}
    if (j && j.error) return { error: j.error, status: r.status, kasse: j.kasse || null };
    return { error: 'speech server answered HTTP ' + r.status + ': ' + r.buf.toString('utf8').slice(0, 200) };
  }
  if (!(r.type || '').includes('audio') || r.buf.length < 1000) {
    return { error: 'speech server returned no audio (' + r.buf.length + ' bytes, ' + r.type + ')' };
  }

  // Voice seed (2026-09-26): the engine's actual seed comes back as X-Voice-Seed (node lowercases
  // header names). crispasr/cosyvoice never send it, chatterbox always does. If it doesn't parse as
  // an integer, the take still succeeded — just report seed: null rather than failing it.
  const hdrSeed = r.headers && r.headers['x-voice-seed'];
  const parsedHdrSeed = Number(hdrSeed);
  const respSeed = (hdrSeed !== undefined && Number.isInteger(parsedHdrSeed)) ? parsedHdrSeed : null;
  // VO1b: X-Voice-Watermark = on | off | failed (the take is kept either way; failed carries a short reason).
  const hdrWm = r.headers && r.headers['x-voice-watermark'];
  const wm = (hdrWm === 'on' || hdrWm === 'off' || hdrWm === 'failed') ? hdrWm : null;
  const wmReason = (wm === 'failed' && r.headers['x-voice-watermark-reason']) ? String(r.headers['x-voice-watermark-reason']).slice(0, 200) : null;
  const seedSuffix = respSeed != null ? ('_s' + respSeed) : '';
  const named_base = base_name + seedSuffix;
  const rawFile = path.join(OUT_DIR, named_base + (effect ? '_raw.wav' : '.wav'));

  fs.writeFileSync(rawFile, r.buf);

  let finalFile = rawFile;
  let chain = null;
  if (effect) {
    try {
      chain = soundFx.buildChain({ effect, strength: typeof strength === 'number' ? strength : 0.5 });
      finalFile = path.join(OUT_DIR, named_base + '.wav');
      await runFfmpeg(rawFile, finalFile, chain);
    } catch (e) {
      // Keep the unprocessed take rather than losing the generation to a filter problem.
      return { error: 'effect failed (the plain take was kept): ' + e.message,
               file: path.basename(rawFile), url: '/vo/' + path.basename(rawFile) };
    }
  }

  const bytes = fs.statSync(finalFile).size;
  return {
    ok: true,
    file: path.basename(finalFile),
    url: '/vo/' + path.basename(finalFile),
    bytes,
    seconds: Math.round((bytes - 44) / (24000 * 2) * 100) / 100,  // 24 kHz mono PCM16
    effect: effect || null,
    filter: chain ? chain.filter : null,
    steps: chain ? chain.steps.map(s => s.id) : [],
    // Voice seed (2026-09-26): the reproducible-take feature — see parseSeed()/hdrSeed above.
    seed: respSeed,
    ...(wm ? { watermark: wm } : {}),
    ...(wmReason ? { watermarkReason: wmReason } : {}),
    ...(seedIgnored ? { seedIgnored: true } : {}),
  };
}

// Serve a produced file (server.js maps GET /vo/<name>).
function readOut(name) {
  const safe = path.basename(String(name || ''));
  const p = path.join(OUT_DIR, safe);
  if (!safe.endsWith('.wav') || !fs.existsSync(p)) return null;
  return { path: p, buf: fs.readFileSync(p) };
}

function listTakes() {
  try {
    return fs.readdirSync(OUT_DIR)
      .filter(f => f.endsWith('.wav'))
      .map(f => ({ file: f, url: '/vo/' + f, bytes: fs.statSync(path.join(OUT_DIR, f)).size,
                   mtime: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40);
  } catch (_) { return []; }
}

// Open the takes folder in the OS file browser. The user asked for a button rather than
// a built-in browser — picking files is something the OS already does well.
function openFolder() {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const cmd = process.platform === 'win32' ? 'explorer'
              : process.platform === 'darwin' ? 'open' : 'xdg-open';
    // explorer.exe returns exit code 1 even on success — ignore the code, not the error.
    execFile(cmd, [OUT_DIR], () => {});
    return { ok: true, dir: OUT_DIR };
  } catch (e) {
    return { error: 'could not open ' + OUT_DIR + ' — ' + e.message };
  }
}

// `request`, `ffmpegPath` and `cfg` are shared with the SFX workbench (sfx.js) on
// purpose. They resolve the same speech service and the same ffmpeg binary, and a
// second copy would drift — the same reason sound-fx.js is one module for both tabs.
module.exports = { health, listVoices, listVoice, listEffects, speak, readOut, listTakes, openFolder, OUT_DIR,
                   request, ffmpegPath, cfg, apiBase, slug,
                   // VO1
                   REFS_DIR, listRefs, resolveRef, openRefsFolder,
                   // VO1b
                   settingsView, validateSettings, applySettings, defaultInstallRoot, NEEDS_CRISPASR, invalidateFreeSpace,
                   dispatcherStatus, dispatcherSync, dispatcherRestart, dispatcherStop, dispatcherShutdown,
                   _test: { resetShutdown: () => { disp.shut = false; disp.userStopped = false; disp.stopPort = null; }, clearFreeCache: () => freeCache.clear(), setLogDir: d => { LOG_DIR = d; }, setHealthTimeout: n => { HEALTH_TIMEOUT_MS = n; }, setDispatcherScript: p => { DISPATCHER_SCRIPT = p || path.join(__dirname, 'voice-dispatcher.js'); }, childPid: () => (disp.child ? disp.child.pid : null) } };
