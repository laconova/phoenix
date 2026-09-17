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
const { execFile } = require('child_process');
const soundFx = require('./sound-fx');
// The voice-engine picker registry. Required the same way i2i.js pulls it in (workflows.js takes no
// project-local requires itself, so no cycle).
const wfLib = require('./workflows');

const OUT_DIR = path.join(__dirname, 'sounds', 'vo');

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
                                    type: res.headers['content-type'] || '' }));
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
  if (!base) return { error: 'voice.api is not set in phoenix-config.json' };
  try {
    const r = await request(base + '/v1/voices', { timeoutMs: 8000 });
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
  const hasDispatcher = !!cfg().dispatcher;   // cfg() returns the `voice` sub-object → voice.dispatcher
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
  const av = wfLib.engineAvailability(entry, !!cfg().dispatcher);
  if (!av.available) {
    return { ok: false, error: `voice engine "${id}" is not available yet (${av.reason}) — no silent fallback to crispasr` };
  }
  return { ok: true, id };
}

// speak({voice, text, effect, strength, engine}) -> { file, url, seconds, effect, filter }
async function speak({ voice, text, effect, strength, engine } = {}) {
  const base = apiBase();
  if (!base) return { error: 'voice.api is not set in phoenix-config.json' };
  if (!voice) return { error: 'pick a voice pack first' };
  // A pack name is a NAME, never a path: `voice` goes into the output filename below (path.join). Without
  // this guard a name like "../../characters/hero" would write the WAV outside OUT_DIR (fixed 2026-08-02).
  if (/[\/\\]|\.\./.test(String(voice))) return { error: 'invalid voice pack name' };
  if (!text || !String(text).trim()) return { error: 'nothing to say — type a line' };

  const eng = resolveEngine(engine);
  if (!eng.ok) return { error: eng.error };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base_name = voice + '_' + slug(text) + '_' + stamp;
  const rawFile = path.join(OUT_DIR, base_name + (effect ? '_raw.wav' : '.wav'));

  let r;
  try {
    r = await request(base + '/v1/audio/speech', {
      method: 'POST',
      // `engine` (Stage 2d): default "crispasr" reproduces the exact prior body/behavior — the
      // rig's /v1/audio/speech + /speak already default to "crispasr" when the field is absent
      // (Part 2b, LIVE), so sending it explicitly here changes nothing for the default case.
      body: JSON.stringify({ model: 'tada', voice, input: String(text), engine: eng.id }),
    });
  } catch (e) {
    return { error: 'speech server not reachable at ' + base + ' — ' + e.message };
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
  fs.writeFileSync(rawFile, r.buf);

  let finalFile = rawFile;
  let chain = null;
  if (effect) {
    try {
      chain = soundFx.buildChain({ effect, strength: typeof strength === 'number' ? strength : 0.5 });
      finalFile = path.join(OUT_DIR, base_name + '.wav');
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
                   request, ffmpegPath, cfg, apiBase, slug };
