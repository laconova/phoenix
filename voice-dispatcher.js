'use strict';

// ─── voice-dispatcher.js — Phoenix's local voice dispatcher (v1.10 VO1) ───────────────────────
//
// Cut-down sibling of a rig-side voice service: ONLY `/speak` + engine routing. CrispASR, the SFX
// workbench and cast/bake stay where they are. Phoenix starts this as a child process when
// voice.dispatcher = { local: true } and sends it every non-crispasr speak call.
//
//   node voice-dispatcher.js --port 8091 --engines <json-path>
//
// The engines file is written by Phoenix:
//   { "refsDir": "<abs sounds/refs>", "engines": { "chatterbox": { "venv": "...", "adapter": "...", "cwd": "...",
//       "env": { "HF_HOME": "<root>/hf-cache" }, "model": { "repo": "ResembleAI/chatterbox", "files": [...] } } } }
//
//   GET  /health  -> { status:'ok', engines:{ chatterbox:{ installed, reason? } } }
//   POST /speak   {engine, input|text, reference, language?, params?} -> audio/wav (+ X-Voice-Seed, X-Voice-Watermark on|off|failed)
//
// Rules (same as the rig): unknown engine = 400, never a silent substitute; missing venv/adapter = 400;
// ONE call at a time (429); success = the output FILE (>= 1000 bytes), not the exit code.
// Binds 127.0.0.1 only. Node built-ins only.

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');

const MIN_BYTES  = 1000;
const TIMEOUT_MS = 300000;
const MAX_BODY   = 1024 * 1024;
const BLOCKED    = { cosyvoice: 'engine "cosyvoice" is blocked in this release (its environment does not install yet) — no substitute' };

// Optional VRAM booking hook: absent env var or module = no booking, no message.
let kasse = null;
try { if (process.env.PHOENIX_KASSE_LIB) kasse = require(process.env.PHOENIX_KASSE_LIB); } catch (_) { kasse = null; }

// Python inside a venv: Windows keeps it in Scripts\python.exe, everywhere else bin/python.
function venvPython(venv, platform) {
  return (platform || process.platform) === 'win32'
    ? path.win32.join(venv, 'Scripts', 'python.exe')
    : path.posix.join(venv, 'bin', 'python');
}

// Windows has no signal names — child.kill() there; SIGKILL elsewhere.
function killChild(child, platform) {
  try {
    if ((platform || process.platform) === 'win32') child.kill();
    else child.kill('SIGKILL');
  } catch (_) { /* already gone */ }
}

function engineStatus(eng, platform) {
  if (!eng) return { installed: false, reason: 'engine not configured' };
  if (!eng.venv) return { installed: false, reason: 'no install location configured (set voiceInstall.voice.root, then Acquire the engine)' };
  const py = venvPython(eng.venv, platform);
  if (!fs.existsSync(py)) return { installed: false, reason: 'venv python missing: ' + py };
  if (!fs.existsSync(eng.adapter)) return { installed: false, reason: 'adapter missing: ' + eng.adapter };
  if (!modelPresent(eng)) return { installed: false, reason: 'voice model missing — run Install again' };
  return { installed: true };
}

// VO1b: an engine that declares `model` (HF repo + file names) and an HF_HOME is only installed when every file sits in
// <HF_HOME>/hub/models--<org>--<name>/snapshots/<rev>/. No `model` declared (rig mode, older engines files) = no check.
function modelPresent(eng) {
  const m = eng && eng.model;
  if (!m || !m.repo || !Array.isArray(m.files) || !m.files.length) return true;
  return snapshotFilesPresent(eng.env && eng.env.HF_HOME, m.repo, m.files);
}
// Shared with downloader.js (Acquire's weights skip decision): every file sits in <home>/hub/models--<org>--<name>/snapshots/<rev>/.
function snapshotFilesPresent(home, repo, files) {
  if (!home) return false;
  const snaps = path.join(home, 'hub', 'models--' + String(repo).replace(/\//g, '--'), 'snapshots');
  let revs = [];
  try { revs = fs.readdirSync(snaps); } catch (_) { return false; }
  return revs.some(rev => files.every(f => { try { return fs.existsSync(path.join(snaps, rev, f)); } catch (_) { return false; } }));
}

// The reference must be an existing .wav that sits inside refsDir (symlinks resolved).
function resolveReference(reference, refsDir) {
  if (!reference || !String(reference).trim()) return { error: 'pick a reference voice first' };
  const bad = { error: 'reference must be a .wav inside the Phoenix reference folder (sounds/refs)' };
  if (!refsDir) return bad;
  const p = path.resolve(String(reference));
  if (path.extname(p).toLowerCase() !== '.wav') return bad;
  let real, root;
  try { real = fs.realpathSync(p); } catch (_) { return { error: 'reference not found: ' + path.basename(p) }; }
  try { if (!fs.statSync(real).isFile()) return bad; } catch (_) { return bad; }   // a directory called x.wav is not a reference
  try { root = fs.realpathSync(refsDir); } catch (_) { return bad; }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return bad;
  return { path: real };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(opts) {
  const o = opts || {};
  const engines  = o.engines || {};
  const refsDir  = o.refsDir || null;
  const spawn    = o.spawn || cp.spawn;
  const platform = o.platform || process.platform;
  const timeoutMs = o.timeoutMs || TIMEOUT_MS;
  const tmpdir   = o.tmpdir || os.tmpdir();
  let busy = false;
  const active = new Set();   // in-flight engine processes: they must die with us

  function json(res, code, obj) {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  }

  // Run one adapter process; resolves { buf, seed } or rejects Error (message goes to the client).
  function runEngine(eng, spec) {
    return new Promise((resolve, reject) => {
      const out = path.join(tmpdir, 'pxvd_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.wav');
      const specPath = out + '.spec.json';
      try {
        fs.writeFileSync(specPath, JSON.stringify({ text: String(spec.text), reference: spec.reference,
          language: spec.language || 'en', out, params: spec.params || {} }), 'utf8');
      } catch (e) { reject(e); return; }
      const cleanup = () => { try { fs.unlinkSync(out); } catch (_) {} try { fs.unlinkSync(specPath); } catch (_) {} };
      let child;
      const spawnOpts = { cwd: eng.cwd || undefined, windowsHide: true };
      if (eng.env && typeof eng.env === 'object') spawnOpts.env = Object.assign({}, process.env, eng.env);   // VO1b: HF_HOME -> the adapter finds the cached model
      try { child = spawn(venvPython(eng.venv, platform), [eng.adapter, specPath], spawnOpts); }
      catch (e) { cleanup(); reject(new Error('could not start the engine: ' + e.message)); return; }
      active.add(child);
      let errbuf = '', outbuf = '', timedOut = false, settled = false;
      const timer = setTimeout(() => { timedOut = true; killChild(child, platform); }, timeoutMs);
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); active.delete(child); fn(arg); };
      if (child.stdout) child.stdout.on('data', d => { outbuf += String(d); if (outbuf.length > 4000) outbuf = outbuf.slice(-4000); });
      if (child.stderr) child.stderr.on('data', d => { errbuf += String(d); if (errbuf.length > 8000) errbuf = errbuf.slice(-8000); });
      child.on('error', e => { cleanup(); finish(reject, new Error('could not start the engine: ' + e.message)); });
      child.on('close', () => {
        let buf = null;
        try { if (fs.existsSync(out)) buf = fs.readFileSync(out); } catch (_) {}
        cleanup();
        if (timedOut) { finish(reject, new Error('engine timed out after ' + Math.round(timeoutMs / 1000) + ' s and was stopped')); return; }
        if (!buf || buf.length < MIN_BYTES) {
          finish(reject, new Error('no audio produced' + (errbuf.trim() ? ': ' + errbuf.trim().slice(-300) : '')));
          return;
        }
        const sm = /^SEED (\d+)$/m.exec(outbuf);
        // VO1b: watermark verdict. params.watermark === false -> off; the adapter prints WATERMARK_FAILED <reason> when Perth
        // could not be applied (the take is still written); otherwise on.
        const wf = /^WATERMARK_FAILED[ \t]*(.*)$/m.exec(outbuf);
        const wmOff = !!(spec.params && spec.params.watermark === false);
        const watermark = wmOff ? 'off' : (wf ? 'failed' : 'on');
        const wmReason = wf ? (wf[1] || 'unknown').replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 200) : null;
        finish(resolve, { buf, seed: sm ? Number(sm[1]) : null, watermark, watermarkReason: wmReason });
      });
    });
  }

  function book(engine) {
    if (!kasse || typeof kasse.book !== 'function') return { ok: true, booking: null };
    try {
      const paths = process.env.PHOENIX_KASSE_PATHS ? JSON.parse(process.env.PHOENIX_KASSE_PATHS) : {};
      const r = kasse.book(paths, { model: 'speak-' + engine, pid: process.pid });
      if (r && r.ok) return { ok: true, booking: r.booking || null };
      if (r && r.reason === 'unknown-model') return { ok: true, booking: null };
      return { ok: false };
    } catch (_) { return { ok: true, booking: null }; }
  }
  function unbook(b) {
    if (!kasse || !b || !b.id || typeof kasse.unbook !== 'function') return;
    try { kasse.unbook(process.env.PHOENIX_KASSE_PATHS ? JSON.parse(process.env.PHOENIX_KASSE_PATHS) : {}, b.id); } catch (_) {}
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      const st = {};
      for (const id of Object.keys(engines)) st[id] = engineStatus(engines[id], platform);
      json(res, 200, { status: 'ok', engines: st, busy });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/speak') {
      let b;
      try { b = JSON.parse(await readBody(req)); } catch (_) { json(res, 400, { error: 'invalid JSON body' }); return; }
      if (!b || typeof b !== 'object') { json(res, 400, { error: 'invalid JSON body' }); return; }
      const engine = String(b.engine || '').toLowerCase();
      if (BLOCKED[engine]) { json(res, 400, { error: BLOCKED[engine] }); return; }
      const eng = engines[engine];
      if (!engine || !eng) { json(res, 400, { error: 'unknown engine "' + engine + '" — known: ' + Object.keys(engines).join(', ') + '. No silent substitute.' }); return; }
      const st = engineStatus(eng, platform);
      if (!st.installed) { json(res, 400, { error: 'engine "' + engine + '" is not installed (' + st.reason + ') — install it from the Library. No substitute.' }); return; }
      const text = b.input || b.text;
      if (!text || !String(text).trim()) { json(res, 400, { error: 'input missing' }); return; }
      const ref = resolveReference(b.reference, refsDir);
      if (ref.error) { json(res, 400, { error: ref.error }); return; }
      if (busy) { json(res, 429, { error: 'the voice engine is busy — one line at a time' }); return; }
      busy = true;                       // claim before any await so two calls can never both pass
      let booking = null;
      try {
        const k = book(engine);
        if (!k.ok) { json(res, 429, { error: 'the GPU is booked by another job — try again in a moment' }); return; }
        booking = k.booking;
        const r = await runEngine(eng, { text, reference: ref.path, language: b.language, params: b.params });
        const hdr = { 'Content-Type': 'audio/wav', 'Content-Length': r.buf.length, 'X-Voice-Used': engine };
        if (r.seed != null) hdr['X-Voice-Seed'] = String(r.seed);
        if (r.watermark) hdr['X-Voice-Watermark'] = r.watermark;
        if (r.watermark === 'failed' && r.watermarkReason) hdr['X-Voice-Watermark-Reason'] = r.watermarkReason;
        res.writeHead(200, hdr);
        res.end(r.buf);
      } catch (e) {
        json(res, 400, { error: e.message });
      } finally {
        busy = false; unbook(booking);
      }
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  // Kill every in-flight engine process (shutdown / stdin-close / SIGTERM path).
  server.killActive = () => { for (const c of Array.from(active)) killChild(c, platform); active.clear(); };
  return server;
}

function parseArgs(argv) {
  const a = { port: 8091, engines: null, exitOnStdinClose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') a.port = Number(argv[++i]);
    else if (argv[i] === '--engines') a.engines = argv[++i];
    else if (argv[i] === '--exit-on-stdin-close') a.exitOnStdinClose = true;
  }
  return a;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  let conf = {};
  try { if (args.engines) conf = JSON.parse(fs.readFileSync(args.engines, 'utf8')); }
  catch (e) { console.error('voice-dispatcher: cannot read engines file: ' + e.message); process.exit(2); }
  const server = createServer({ engines: conf.engines || {}, refsDir: conf.refsDir || null });
  server.on('error', e => { console.error('voice-dispatcher: ' + (e.code === 'EADDRINUSE' ? 'port ' + args.port + ' is already in use' : e.message)); process.exit(1); });
  // Phoenix starts us with a piped stdin: when Phoenix dies (even hard), the pipe closes and so do we — no orphan.
  // An in-flight engine python is killed first, so it never outlives the dispatcher.
  const bye = () => { try { server.killActive(); } catch (_) {} process.exit(0); };
  process.on('exit', () => { try { server.killActive(); } catch (_) {} });
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  if (args.exitOnStdinClose) { process.stdin.on('end', bye); process.stdin.on('close', bye); process.stdin.resume(); }
  server.listen(args.port, '127.0.0.1', () => console.log('voice-dispatcher listening on 127.0.0.1:' + args.port));
}

module.exports = { createServer, venvPython, killChild, resolveReference, engineStatus, parseArgs, snapshotFilesPresent };
