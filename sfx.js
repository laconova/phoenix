'use strict';

// ─── SFX tab — the clip workbench ─────────────────────────────────────────────
//
// Three sources, one bench, two exits:
//
//   generate SFX  ┐
//   generate VO   ├─▶  adjust (simple ⇄ advanced)  ─▶  save as character (.gguf)
//   load a clip   ┘                                └─▶  save as soundclip
//
// The Voice tab *uses* a finished voice pack. This tab *makes* audio — and the
// two connect through the pack library: a character saved here shows up in the
// Voice tab's dropdown. That is the only coupling between them.
//
// THE CENTRAL DESIGN DECISION: the chain is the state, the audio is derived.
// Editing never stacks a filter onto the previous output. Every render starts
// from the untouched source and applies the whole chain in one ffmpeg pass.
// Two reasons, both real: repeated tweaking would otherwise degrade the audio
// generation by generation, and a stacked result cannot be reproduced from what
// the UI shows. So the bench holds {source, chain} and re-renders on demand.
//
// Generation runs where the GPU is (voice.api). Editing runs here, because
// ffmpeg lives on this machine — which is also why baking uploads the finished
// WAV to the service instead of asking it for a path it cannot see.

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const soundFx = require('./sound-fx');
const voice = require('./voice');

const ROOT       = path.join(__dirname, 'sounds');
const BENCH_DIR  = path.join(ROOT, 'workbench');     // source + preview, transient
const TAKES_DIR  = path.join(BENCH_DIR, 'takes');    // generated candidates
const CLIPS_DIR  = path.join(ROOT, 'sfx');           // saved soundclips

// The bench holds one clip at a time. Single operator, single bench — a list of
// parallel benches would be a feature nobody asked for.
let bench = null;   // {source, kind, text, meta, chain, preview, warnings}

const BENCH_STATE = path.join(BENCH_DIR, 'bench.json');

function ensureDirs() {
  for (const d of [BENCH_DIR, TAKES_DIR, CLIPS_DIR]) fs.mkdirSync(d, { recursive: true });
}

// The bench survives a Phoenix restart. Without this the audio files would still be
// on disk while the module forgot what they are — and a cast take would silently
// come back as "no transcript", i.e. the safe answer to the wrong question. The
// work here is a loop ("keep adjusting until it sits"), and a loop that a restart
// empties is a loop that loses work.
function persist() {
  try {
    if (!bench) { fs.rmSync(BENCH_STATE, { force: true }); return; }
    fs.writeFileSync(BENCH_STATE, JSON.stringify({
      kind: bench.kind, text: bench.text, meta: bench.meta,
      chain: bench.chain, warnings: bench.warnings,
    }, null, 2), 'utf8');
  } catch (_) { /* persistence is a convenience, never a blocker */ }
}

function rehydrate() {
  if (bench) return;
  const source = path.join(BENCH_DIR, 'source.wav');
  if (!fs.existsSync(source)) return;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(BENCH_STATE, 'utf8')); } catch (_) {}
  const preview = path.join(BENCH_DIR, 'preview.wav');
  bench = {
    source,
    kind: saved.kind || 'file',
    text: saved.text || null,
    meta: saved.meta || null,
    chain: saved.chain || null,
    preview: fs.existsSync(preview) ? preview : null,
    warnings: saved.warnings || [],
  };
}

// ── WAV facts, read from the file rather than assumed ─────────────────────────
// voice.js can hardcode 24 kHz because CrispASR always answers 24 kHz. Here the
// sources differ (VO 24 kHz, SFX 48 kHz, a loaded clip anything), so guessing the
// sample rate would quietly misreport every duration in the UI.
function wavInfo(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(44);
    const n = fs.readSync(fd, head, 0, 44, 0);
    if (n < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false };
    }
    const channels = head.readUInt16LE(22);
    const rate = head.readUInt32LE(24);
    const bits = head.readUInt16LE(34);
    const bytes = fs.statSync(file).size;
    const byteRate = rate * channels * (bits / 8);
    return {
      ok: true, rate, channels, bits, bytes,
      seconds: byteRate ? Math.round((bytes - 44) / byteRate * 100) / 100 : null,
    };
  } catch (_) { return { ok: false }; }
  // The fd used to be closed mid-try; if readSync threw, closeSync was skipped and the descriptor
  // leaked. finally closes it on every path (fixed 2026-08-02).
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
}

function safeName(s, fallback) {
  const v = String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return v || fallback;
}

// ── the audio service (same endpoint as the Voice tab) ───────────────────────
function apiBase() { return voice.apiBase(); }

async function serviceJson(pathAndQuery, opts) {
  const base = apiBase();
  if (!base) return { error: 'voice.api is not set in phoenix-config.json' };
  try {
    const r = await voice.request(base + pathAndQuery, opts);
    let j = {};
    try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) {}
    if (r.status >= 400) return { error: j.error || ('HTTP ' + r.status), status: r.status };
    return j;
  } catch (e) {
    return { error: 'audio service not reachable at ' + base + ' — ' + e.message };
  }
}

// ── generation ───────────────────────────────────────────────────────────────

// Both generators are jobs, not long HTTP calls: the model loads first and every
// throw costs seconds. Same shape as Text→Motion in the Human tab — a popup with
// a running clock, and Phoenix stays usable meanwhile.
async function castStart({ instruction, text, n, advanced } = {}) {
  if (!String(instruction || '').trim()) return { error: 'describe the voice first' };
  if (!String(text || '').trim()) return { error: 'type the line it should say' };
  return serviceJson('/cast', {
    method: 'POST',
    body: JSON.stringify({ instruction, text, n: Number(n) || 3, advanced: advanced || {} }),
    timeoutMs: 20000,
  });
}

async function sfxStart({ prompt, seconds, n, seed, advanced } = {}) {
  if (!String(prompt || '').trim()) return { error: 'describe the sound first' };
  return serviceJson('/sfx', {
    method: 'POST',
    body: JSON.stringify({
      prompt, seconds: Number(seconds) || 8, n: Number(n) || 3,
      seed: (seed === '' || seed === undefined || seed === null) ? null : Number(seed),
      advanced: advanced || {},
    }),
    timeoutMs: 20000,
  });
}

// Poll a job. When it finishes, the takes are pulled here once — playback and
// editing then work on local files and no longer depend on the rig.
async function jobStatus(id) {
  if (!id) return { error: 'no job id' };
  const j = await serviceJson('/job?id=' + encodeURIComponent(id), { timeoutMs: 15000 });
  if (j.error) return j;
  if (j.status !== 'done' || !j.result || !Array.isArray(j.result.takes)) return j;

  ensureDirs();
  const base = apiBase();
  for (const t of j.result.takes) {
    if (!t.url || !t.datei) continue;
    const local = path.join(TAKES_DIR, id + '_' + t.datei);
    t.local = path.basename(local);
    t.playUrl = '/sfx-file/' + encodeURIComponent(t.local);
    if (fs.existsSync(local)) continue;
    try {
      const r = await voice.request(base + t.url, { timeoutMs: 120000 });
      if (r.status === 200 && r.buf.length > 1000) fs.writeFileSync(local, r.buf);
      else t.pullError = 'HTTP ' + r.status + ' (' + r.buf.length + ' bytes)';
    } catch (e) { t.pullError = e.message; }
  }
  return j;
}

// ── the bench ────────────────────────────────────────────────────────────────

// Adopt a generated take. `text` is provenance, not decoration: for a VO take the
// spoken line is KNOWN, which is what makes baking it safe later (see saveCharacter).
function adopt({ take, kind, text, meta } = {}) {
  ensureDirs();
  const safe = path.basename(String(take || ''));
  const src = path.join(TAKES_DIR, safe);
  if (!safe.endsWith('.wav') || !fs.existsSync(src)) return { error: 'take not found: ' + safe };
  const dst = path.join(BENCH_DIR, 'source.wav');
  fs.copyFileSync(src, dst);
  bench = {
    source: dst, kind: kind || 'sfx', text: text || null, meta: meta || null,
    chain: null, preview: null, warnings: [],
  };
  persist();
  return benchView();
}

// Load an existing clip from anywhere on disk. This is the third source, and the
// one with no provenance — the bench remembers that, because baking depends on it.
function loadFile(p) {
  ensureDirs();
  const src = String(p || '').trim().replace(/^"|"$/g, '');
  if (!src) return { error: 'no file given' };
  if (!fs.existsSync(src)) return { error: 'file not found: ' + src };
  if (!/\.(wav|mp3|flac|ogg|m4a)$/i.test(src)) return { error: 'not an audio file: ' + path.basename(src) };
  const dst = path.join(BENCH_DIR, 'source.wav');
  if (/\.wav$/i.test(src)) {
    fs.copyFileSync(src, dst);
    return finishLoad(src);
  }
  // Anything not already WAV goes through ffmpeg once, so the bench only ever
  // holds one format and the chain never has to care.
  return new Promise((resolve) => {
    execFile(voice.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, dst],
      { timeout: 120000 }, (err, _o, stderr) => {
        if (err) { resolve({ error: 'could not convert to wav: ' + (stderr || err.message).trim().slice(0, 200) }); return; }
        resolve(finishLoad(src));
      });
  });

  function finishLoad(origin) {
    bench = {
      source: dst, kind: 'file', text: null, meta: { origin },
      chain: null, preview: null, warnings: [],
    };
    persist();
    return benchView();
  }
}

function runFfmpeg(inFile, outFile, filter) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile,
                  '-filter_complex', filter, '-map', '[out]', outFile];
    execFile(voice.ffmpegPath(), args, { timeout: 180000 }, (err, _o, stderr) => {
      if (err) { reject(new Error('ffmpeg failed: ' + (stderr || err.message).trim().slice(0, 300))); return; }
      resolve();
    });
  });
}

// Render source + chain -> preview. Always from the source, never from the last
// preview (see the header). An empty chain means the preview IS the source.
async function render(spec) {
  rehydrate();
  if (!bench) return { error: 'nothing on the bench — generate or load a clip first' };
  ensureDirs();
  const preview = path.join(BENCH_DIR, 'preview.wav');

  const leer = !spec || (!spec.effect && !(spec.order && spec.order.length));
  if (leer) {
    fs.copyFileSync(bench.source, preview);
    bench.chain = null; bench.preview = preview; bench.warnings = [];
    persist();
    return benchView();
  }

  let chain;
  try {
    chain = soundFx.buildChain(spec);
  } catch (e) {
    return { error: e.message };   // sound-fx validates; surface its wording unchanged
  }
  try {
    await runFfmpeg(bench.source, preview, chain.filter);
  } catch (e) {
    // Keep whatever was on the bench rather than losing it to a filter problem.
    return Object.assign(benchView(), { error: e.message });
  }
  bench.chain = { spec, filter: chain.filter, steps: chain.steps };
  bench.warnings = chain.warnings || [];
  bench.preview = preview;
  persist();
  return benchView();
}

function currentAudio() {
  rehydrate();
  if (!bench) return null;
  return bench.preview && fs.existsSync(bench.preview) ? bench.preview : bench.source;
}

function benchView() {
  rehydrate();
  if (!bench) return { bench: null };
  const file = currentAudio();
  const info = wavInfo(file);
  return {
    bench: {
      kind: bench.kind,
      text: bench.text,
      meta: bench.meta,
      hasChain: !!bench.chain,
      chain: bench.chain ? { filter: bench.chain.filter, steps: bench.chain.steps, spec: bench.chain.spec } : null,
      warnings: bench.warnings || [],
      // Cache-buster: the file name never changes, only its content.
      url: '/sfx-bench.wav?v=' + Date.now(),
      seconds: info.seconds, rate: info.rate, channels: info.channels, bytes: info.bytes,
    },
  };
}

function readBenchAudio() {
  const f = currentAudio();
  if (!f || !fs.existsSync(f)) return null;
  return fs.readFileSync(f);
}

function readTake(name) {
  const safe = path.basename(String(name || ''));
  const p = path.join(TAKES_DIR, safe);
  if (!safe.endsWith('.wav') || !fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

// ── the two exits ────────────────────────────────────────────────────────────

// Exit 1: a soundclip. One take, no commitment.
function saveClip(name) {
  const f = currentAudio();
  if (!f) return { error: 'nothing on the bench' };
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = safeName(name, 'clip') + '_' + stamp + '.wav';
  const dst = path.join(CLIPS_DIR, file);
  fs.copyFileSync(f, dst);
  return { ok: true, file, url: '/sfx-clip/' + encodeURIComponent(file), dir: CLIPS_DIR };
}

// Exit 2: a character. Reusable, shows up in the Voice tab afterwards.
//
// The transcript is the whole risk here. `--make-ref` aligns audio against text;
// if the text is not word-for-word what the audio says, the pack is subtly wrong
// and nothing complains. For a VO take generated on this bench the line is known
// and gets filled in automatically — that path cannot go wrong. For a LOADED clip
// nobody knows it, so the operator must type it and the service refuses without it.
//
// Consent is a decision, not a default: `iHaveRights` has to arrive as true.
async function saveCharacter({ name, transcript, iHaveRights, overwrite } = {}) {
  rehydrate();
  const f = currentAudio();
  if (!f) return { error: 'nothing on the bench' };
  const packName = safeName(name, '');
  if (!packName) return { error: 'give the character a name' };
  if (iHaveRights !== true) {
    return { error: 'confirm you have the rights to clone this voice — baking a pack is not a neutral act' };
  }
  const text = String(transcript || bench.text || '').trim();
  if (!text) {
    return { error: bench.kind === 'file'
      ? 'this clip was loaded, so Phoenix does not know what is said in it. Type the spoken line word-for-word — an approximate transcript silently misaligns the pack.'
      : 'no transcript available for this take' };
  }

  const base = apiBase();
  if (!base) return { error: 'voice.api is not set in phoenix-config.json' };
  const buf = fs.readFileSync(f);
  const q = '/bake?name=' + encodeURIComponent(packName) +
            '&transcript=' + encodeURIComponent(text) +
            '&iHaveRights=true' + (overwrite ? '&overwrite=true' : '');
  try {
    const r = await uploadWav(base + q, buf);
    let j = {};
    try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) {}
    if (r.status >= 400) return { error: j.error || ('HTTP ' + r.status) };
    return Object.assign({ ok: true, transcript: text }, j);
  } catch (e) {
    return { error: 'could not reach the audio service — ' + e.message };
  }
}

function uploadWav(urlStr, buf) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (_) { reject(new Error('bad url')); return; }
    // Scheme-aware, same as voice.request: an https audio service needs the https lib and port 443,
    // not a plaintext POST on port 80 (fixed 2026-08-02).
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'Content-Length': buf.length },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(300000, () => req.destroy(new Error('timeout')));
    req.write(buf);
    req.end();
  });
}

// ── listings ─────────────────────────────────────────────────────────────────

function listClips() {
  try {
    return fs.readdirSync(CLIPS_DIR)
      .filter(f => f.endsWith('.wav'))
      .map(f => {
        const st = fs.statSync(path.join(CLIPS_DIR, f));
        return { file: f, url: '/sfx-clip/' + encodeURIComponent(f), bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40);
  } catch (_) { return []; }
}

function readClip(name) {
  const safe = path.basename(String(name || ''));
  const p = path.join(CLIPS_DIR, safe);
  if (!safe.endsWith('.wav') || !fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

function openFolder(which) {
  const dir = which === 'clips' ? CLIPS_DIR : BENCH_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cmd = process.platform === 'win32' ? 'explorer'
              : process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [dir], () => {});   // explorer.exe returns 1 even on success
    return { ok: true, dir };
  } catch (e) { return { error: 'could not open ' + dir + ' — ' + e.message }; }
}

// Everything the tab needs to draw itself, in one round trip.
async function state() {
  ensureDirs();
  const [h, v] = await Promise.all([voice.health(), voice.listVoices()]);
  return {
    health: h,
    packs: (v && v.voices) || [],
    // The FULL effect catalogue with every parameter — the advanced view is meant
    // to be dense. The Voice tab filters this down; this tab does not.
    effects: soundFx.listEffects(),
    clips: listClips(),
    bench: benchView().bench,
  };
}

module.exports = {
  state, castStart, sfxStart, jobStatus,
  adopt, loadFile, render, benchView, readBenchAudio, readTake,
  saveClip, saveCharacter, listClips, readClip, openFolder,
  BENCH_DIR, CLIPS_DIR, TAKES_DIR,
};
