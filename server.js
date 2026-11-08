'use strict';
// One id per server start: the page compares it after an SSE reconnect to tell a restarted server (job numbers begin again) from a dropped connection.
const BOOT_ID = Date.now().toString(36) + '-' + process.pid.toString(36);

const http = require('http');
const fs   = require('fs');
const path = require('path');

const a         = require('./assistant.js');
const providers = require('./providers');
const bench = require('./bench/bench');   // competence mini-benchmark (v1.9 M2.1)
const capabilities = require('./providers/capabilities');   // tool-protocol probe results (v1.9 M2)   // seats → provider layer (v1.9 M1): validation, model lists, API keys
const dbg       = require('./debug-log.js');
const lock      = require('./lock');
const pageAssembler = require('./web/assemble');   // R0a: web/src/ parts -> one page
const palette   = require('./palette');
const wfp       = require('./workflow-params');   // v1.10 ADV: per-workflow params (cfg/steps/sampler/size/faces ...), one store, two views
const libFolders = require('./library-folders');
const workflows = require('./workflows');
const animLib   = require('./animate_human');
const customRig = require('./custom_rig');
const characters = require('./characters');
const voice     = require('./voice');
const sfx       = require('./sfx');
const unrealIpc = require('./unreal-ipc');
const pipeline  = require('./pipeline');
const checkpoints = require('./checkpoints');   // scene checkpoints + rewind (v1.9 M5)
const jobs      = require('./jobs');
const i2iEngine = require('./i2i');   // baseForInstance — so the deps check hits each workflow's own instance
const records = require('./records');   // output record behind the Library's Images / Videos tabs (v1.10 C1)
const storyboard = require('./storyboard.js');   // shots as timeline events (v1.10 V1)
const storyboardTimeline = require('./storyboard-timeline');   // R6: the ONE timing source of a board (page animatic + MP4 export)
const storyboardExport = require('./storyboard-export');   // R6: the animatic MP4 (ffmpeg)
const remoteAccess = require('./remote-access');   // <r1-remote> R1: use Phoenix from the phone - second loopback listener behind "tailscale serve", laptop-approved pairing
const remoteTailscale = require('./remote-tailscale');
const downloader = require('./downloader');   // workflow/engine acquisition core (Stage 1)
const statusBar = require('./status');   // <r1-shell> status bar provider system: status-providers/*.js, read by GET /status
const blenderIpc = require('./blender-ipc');
const brushPreviews = require('./brush-previews');
const characterPreviews = require('./character-previews');
const brushBackend = require('./brush-to-unreal');
const libraryTrash = require('./library-trash');
brushPreviews.configure({ getCfg: () => a.loadConfig(), busy: () => lock.isHeld() || jobs.isRunning() || deferredInFlight, onStatus: s => broadcast({ kind: 'brush-previews', ...s }) });
// Foreground actions drive the user's GUI Blender over IPC (a different process). The background exports (brush + character previews) already yield to them
// (busy = lock / jobs / deferred) and run one at a time across both queues, so a foreground action never waits for a background export.
characterPreviews.configure({ getCfg: () => a.loadConfig(), busy: () => lock.isHeld() || jobs.isRunning() || deferredInFlight, onStatus: s => broadcast({ kind: 'character-previews', ...s }) });

// <b3-acquire-log>
// v1.10 B3 — in-memory acquire log (last 200 lines per workflow id, process lifetime only, nothing on disk)
// so a failed install can be copied into a bug report. EVERY line is redacted BEFORE it is stored (and before
// it is broadcast); there is no store-first-redact-on-read path.
const ACQUIRE_LOG_MAX = 200;
const acquireLogs = new Map();   // workflow id → string[]
const acquireRunning = new Set();   // <b2r-uninstall> workflow ids with an acquire in flight — an uninstall of one is refused
const FAQ_ENTRY_BASE = 'https://github.com/laconova/phoenix/blob/master/troubleshooting/entries/';

function collectConfigSecrets(node, out, depth) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') { if (/key|token|secret|password/i.test(k) && v.length >= 6) out.push(v); }
    else if (v && typeof v === 'object') collectConfigSecrets(v, out, depth + 1);
  }
}
// Redactor for one acquire: secrets-store values + secret-named config fields (non-empty, >= 6 chars) + token patterns.
function makeAcquireRedactor(cfg) {
  const vals = [];
  try {
    for (const ref of Object.keys(providers.listKeys())) {
      const v = providers.getKey(ref);
      if (typeof v === 'string' && v.length >= 6) vals.push(v);
    }
  } catch (_) { /* no secrets store → patterns only */ }
  try { collectConfigSecrets(cfg, vals, 0); } catch (_) {}
  const uniq = Array.from(new Set(vals)).sort((x, y) => y.length - x.length);
  return function redact(text) {
    let t = String(text == null ? '' : text);
    for (const v of uniq) t = t.split(v).join('[redacted]');
    return t
      .replace(/Bearer\s+\S+/g, '[redacted]')
      .replace(/hf_[A-Za-z0-9]{20,}/g, '[redacted]')
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted]')
      .replace(/(token|key|password)=\S+/gi, '$1=[redacted]');
  };
}
function deepRedact(v, redact) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(x => deepRedact(x, redact));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = deepRedact(v[k], redact); return o; }
  return v;
}
// One progress event → one log line (already-redacted event in): 'line' → the line; others → '[<phase>] <step> <error|warning>'.
function acquireLogText(p) {
  if (p.phase === 'line') return String(p.line == null ? '' : p.line);
  const nm = (p.step && p.step.name) || '';
  const extra = p.error || p.warning || '';
  return ('[' + p.phase + '] ' + nm + (extra ? ' ' + extra : '')).trim();
}
function acquireLogPush(id, line) {
  let ring = acquireLogs.get(id);
  if (!ring) { ring = []; acquireLogs.set(id, ring); }
  ring.push(line);
  if (ring.length > ACQUIRE_LOG_MAX) ring.splice(0, ring.length - ACQUIRE_LOG_MAX);
}
function acquireFaqFields(text) {
  const faq = downloader.acquireFaq(text);
  return { faq, faq_url: faq ? FAQ_ENTRY_BASE + faq + '.md' : null };
}
// </b3-acquire-log>

// ─── Working dir (used for /file security checks) ─────────────────────────────

const workingDir = __dirname;
const servable = require('./servable');

// ─── Session ──────────────────────────────────────────────────────────────────

const fresh   = process.argv.includes('--fresh');
a.ensureConfig();   // first-run: seed phoenix-config.json from the example if missing
let history   = fresh ? [] : a.loadHistory();
let state     = a.loadState();
let cfg       = a.loadConfig();

// ─── SSE client set & broadcast ───────────────────────────────────────────────

const clients = new Set();

function broadcast(obj) {
  const payload = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of clients) {
    if (res.writableEnded || res.destroyed) { clients.delete(res); continue; }   // <r1-remote> a stream the server just closed (Disconnect / switch-off) must not be written to
    try {
      res.write(payload);
    } catch (_) {
      clients.delete(res);
    }
  }
}

// <r1-remote> remote-access state goes to the laptop's own page only: a phone's /events stream never receives it (and it carries no payload, just "look again")
function broadcastLocal(obj) {
  const payload = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of clients) {
    if (remote.isRemoteStream(res)) continue;
    if (res.writableEnded || res.destroyed) { clients.delete(res); continue; }
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}
const remote = remoteAccess.create({
  secretsDir: () => process.env.PHOENIX_SECRETS_DIR || path.join(workingDir, '.secrets'),
  transport: remoteTailscale.create(),
  getHandler: () => handler,
  onChange: () => broadcastLocal({ kind: 'remote' }),
  log: (m) => { try { console.error(m); } catch (_) {} },
});
// </r1-remote>

// In-flight guard for the one action that deliberately does NOT take the Blender lock while it
// works (hy_motion — see the /action route). Module-level because the route is re-entered per
// request; a single boolean is enough, since exactly one action defers.
let deferredInFlight = false;
// <sb3> the voice packs /voice-state last saw (the storyboard view only reads this, it never calls the voice server) and the Speak-in-progress keys
// (board:shot = whole shot, board:shot:lid = one line): a second click while one is running answers 409
const sbVoiceSeen = { names: null };
const sbSpeakBusy = new Set();
// R6: the animatic export in server memory: running = { board, job, progress } while the job holds the slot, last = the answer of the latest finished/stopped/failed run
const sbExport = { running: null, last: null };

// R6: the body of the animatic export job (kept outside the storyboard route region: it broadcasts and writes a record). Runs in the shared jobs slot;
// `signal` is the slot's AbortSignal (POST /stop -> jobs.cancel). Always ends by publishing `last` and clearing `running` (even on a throw).
async function sbRunAnimaticJob(board, facts, jid, signal) {
  let lastTick = 0, res;
  const onProgress = (f) => {
    if (sbExport.running && sbExport.running.job === jid) sbExport.running.progress = f;
    const now = Date.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    try { broadcast({ kind: 'storyboard', phase: 'export', board: board.id, job: jid, progress: f, ok: true }); } catch (_) { /* no clients */ }
  };
  try {
    const tl = storyboardTimeline.timeline(board, facts);
    const colors = { bg: '#BDBDBD', text: '#1F1F1F' };   // the --ground / --text tokens of :root in web/src/01-base.css; these fallbacks stand when it cannot be read
    try {
      const css = fs.readFileSync(path.join(workingDir, 'web', 'src', '01-base.css'), 'utf8');
      const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(css);
      const g = rootBlock && /--ground:\s*(#[0-9a-fA-F]{6})\b/.exec(rootBlock[1]), t = rootBlock && /--text:\s*(#[0-9a-fA-F]{6})\b/.exec(rootBlock[1]);
      if (g) colors.bg = g[1];
      if (t) colors.text = t[1];
    } catch (_) { /* the fallback colours stand */ }
    const inVo = (take) => { const f = path.join(voice.OUT_DIR, path.basename(String(take))); try { return fs.statSync(f).isFile() ? f : null; } catch (_) { return null; } };
    res = await storyboardExport.exportBoard(board, tl, {
      ffmpeg: voice.ffmpegPath(),
      resolveImage: (rel) => (facts.keyframeOk(rel) ? path.resolve(workingDir, rel) : null),
      resolveClip: (rel) => (facts.clipOk(rel) ? path.resolve(workingDir, rel) : null),
      takeFile: inVo,
      sfxFile: (clip) => (facts.sfxOk(clip) ? path.join(sfx.CLIPS_DIR, path.basename(String(clip))) : null),
      signal, onProgress, colors, fontFile: storyboardExport.findFont(),
    });
  } catch (e) { res = { ok: false, error: String((e && e.message) || e), warnings: [] }; }
  let p = null, url = null;
  try {
    if (res.ok) {
      const rel = path.relative(workingDir, res.file);
      const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      p = inside ? rel.split(path.sep).join('/') : res.file;
      const fp = inside ? resolveFileParam(p) : null;
      url = (fp && fp.allowed) ? '/file?p=' + encodeURIComponent(p) : null;
      records.appendRecord({ kind: 'video', path: res.file, workflow: 'animatic', prompt: board.title, seed: null, parent: null, category: 'animatic' });
    }
  } finally {
    const done = { board: board.id, ok: res.ok === true, stopped: res.stopped === true, path: p, url, name: res.ok ? res.name : null, warnings: Array.isArray(res.warnings) ? res.warnings : [], error: res.ok ? '' : String(res.error || ''), at: new Date().toISOString() };
    sbExport.last = done;
    sbExport.running = null;
    try { broadcast({ kind: 'storyboard', phase: 'export-done', board: done.board, job: jid, ok: done.ok, stopped: done.stopped, path: done.path, url: done.url, name: done.name, warnings: done.warnings, error: done.error }); } catch (_) { /* no clients */ }
  }
  if (res.ok) return 'Animatic ready';
  if (res.stopped) return 'Animatic stopped';
  throw new Error(res.error || 'the animatic export failed');
}

// <v1b3-video> v1.10 V1b-3: the video-backend registry (EMPTY in v1.10 - V2 local preview / V3 fal+Kling register themselves).
// A backend = { id, label, available(cfg) -> {ok, reason}, estimate(shotRequest) -> {line, usd} | null, start(shotRequest, {confirmed}) }.
// estimate() non-null = PAID: the UI shows `line` next to Make video and start() is only called with confirmed:true after the user confirmed it.
// shotRequest = { startImage (absolute path), prompt (compilePrompt 'video'), duration_s, aspect, refs [{role,label,path(abs)}], lines [{speaker,line,take}] }.
// gpu:true -> start() runs inside the shared jobs slot (busy -> 409 with the jobs reason, and it blocks keyframes); gpu:false/absent -> cloud, no slot.
// start() may return a value or a Promise (a result {ok:false, error} or a rejection = failure); a finished clip is set by the BACKEND via storyboard.updateShot(board, shot, { clip: {path, backend, made_at} }).
const NO_VIDEO_BACKEND = 'No video backend yet — local preview (V2) and fal/Kling (V3) arrive with their own build steps.';
const videoBackends = [];
function registerVideoBackend(b) {
  if (!b || typeof b !== 'object' || typeof b.id !== 'string' || !b.id || typeof b.label !== 'string'
    || typeof b.available !== 'function' || typeof b.estimate !== 'function' || typeof b.start !== 'function') {
    throw new TypeError('a video backend needs { id, label, available(cfg), estimate(shotRequest), start(shotRequest, {confirmed}) } (+ optional gpu: true|false)');
  }
  if (b.gpu !== undefined && typeof b.gpu !== 'boolean') throw new TypeError('a video backend\'s gpu flag must be true or false');
  b.gpu = b.gpu === true;   // default false = a cloud backend (fal/Kling): no GPU slot; true = a local GPU backend: it runs in the shared jobs slot
  const i = videoBackends.findIndex(x => x.id === b.id);
  if (i >= 0) videoBackends[i] = b; else videoBackends.push(b);
  return b.id;
}
function unregisterVideoBackend(id) {
  const i = videoBackends.findIndex(x => x.id === id);
  if (i >= 0) videoBackends.splice(i, 1);
  return i >= 0;
}
// in-memory per-shot progress / last failure of the two long actions ('<board>:<shot>' -> true | text); a page reload still shows them
const sbKeyframeBusy = new Map(), sbKeyframeErr = new Map(), sbVideoBusy = new Map(), sbVideoErr = new Map();
// v1.10 V2: a local (gpu) backend's progress line while it runs, the note it leaves with a finished clip, and which shots run in the jobs slot (those can be stopped)
const sbVideoProgress = new Map(), sbVideoNote = new Map(), sbVideoGpu = new Map();   // sbVideoGpu: '<board>:<shot>' -> the jobs-slot id of its running local run (Stop names it)
const sbKeyframeRefJob = new Map();   // M4: '<board>:<shot>' -> the jobs-slot id of a running REFERENCE keyframe (the only keyframe a Stop may end)
const sbStops = new Map();   // jobs-slot id -> what its Stop did at ComfyUI (the backend's cancelPrompt answer), for /stop's reply; keyed by run so a second /stop cannot reset it
// </v1b3-video>

// Last Blender filepath GET /checkpoints could read (null = unknown); served as "stale" while a turn holds the lock.
let lastCpFilepath = null;

// ─── Unreal bridge status (for the header indicator) ──────────────────────────
// The probe costs a Python start plus multicast discovery, so it is cached AND
// shared: several open tabs plus a reload must not each spawn their own. The dot
// is a hint, not a measurement — an answer up to 20 s stale is the right trade,
// and it is exactly why the client may poll on a lazy tick.

let unrealCache = { at: 0, val: null };
let unrealInFlight = null;
const UNREAL_TTL_MS = 20000;

function unrealState() {
  if (unrealCache.val && Date.now() - unrealCache.at < UNREAL_TTL_MS) {
    return Promise.resolve(unrealCache.val);
  }
  if (unrealInFlight) return unrealInFlight;   // concurrent callers share one probe
  unrealInFlight = unrealIpc.probeUnrealStatus({ cfg })
    .catch(e => ({
      state: 'unknown', engineVersion: null, projectFile: null, projectName: null,
      message: String((e && e.message) || e),
    }))
    .then(v => { unrealCache = { at: Date.now(), val: v }; unrealInFlight = null; return v; });
  return unrealInFlight;
}

// <r1-shell> status bar providers: loaded once at start from status-providers/ (or PHOENIX_STATUS_PROVIDERS_DIR). A provider only gets this ctx.
const statusFetch = (u, o) => fetch(u, o);   // one stable function: the providers' shared caches are keyed on it
const statusService = statusBar.makeStatus(
  statusBar.loadProviders(process.env.PHOENIX_STATUS_PROVIDERS_DIR || path.join(__dirname, 'status-providers'), (m) => { try { console.error('[status] ' + m); } catch (_) {} }),
  () => ({ cfg: a.loadConfig(), jobs, probeBlender: (c, ms) => blenderIpc.probeBlenderIdle(c, ms), fetch: statusFetch, unrealState, remoteState: () => remote.view() }));
// </r1-shell>

// ─── Pipeline artifact parser (Phase 2b) ──────────────────────────────────────
// Pure, exported-for-test function. Maintains module-level state between calls
// because POSITIVE/NEGATIVE prompt text spans two lines.

let _pipelineState = {
  awaitingPositive: false,
  awaitingNegative: false,
  promptPositive: '',
  promptNegative: '',
};

function _resetPipelineState() {
  _pipelineState = {
    awaitingPositive: false,
    awaitingNegative: false,
    promptPositive: '',
    promptNegative: '',
  };
}

/**
 * feedPipelineLine(line) — feed one raw stdout line from the pipeline.
 * Returns an array of artifact objects to broadcast (may be empty).
 * Each object: { kind:'artifact', slot, url } or { kind:'artifact', slot:'prompt', text }
 * Never throws.
 */
function feedPipelineLine(line) {
  try {
    const trimmed = line.trim();
    const results = [];

    // ── PHOENIX_NOTICE: (e.g. a local model stays loaded next to ComfyUI) → a visible notice ──
    if (trimmed.startsWith('PHOENIX_NOTICE:')) {
      return [{ kind: 'notice', text: trimmed.slice('PHOENIX_NOTICE:'.length).trim() }];
    }

    // ── RESULT_GLB ──
    const glbMatch = line.match(/RESULT_GLB:\s*(.+\.glb)\s*$/i);
    if (glbMatch) {
      const rawPath = glbMatch[1].trim();
      const url = _artifactPathToUrl(rawPath);
      if (url) results.push({ kind: 'artifact', slot: 'mesh', url });
      return results;
    }

    // ── Arrow or bare .png path ──
    const pngArrowMatch = line.match(/(?:→|->)\s*(.+\.png)\s*$/);
    if (pngArrowMatch) {
      const rawPath = pngArrowMatch[1].trim();
      const url = _artifactPathToUrl(rawPath);
      if (url) results.push({ kind: 'artifact', slot: 'image', url });
      return results;
    }
    // Bare .png path (line is just a path ending in .png)
    if (/\.png\s*$/.test(trimmed) && !trimmed.includes(' ')) {
      const url = _artifactPathToUrl(trimmed);
      if (url) results.push({ kind: 'artifact', slot: 'image', url });
      return results;
    }

    // ── POSITIVE: / NEGATIVE: labels ──
    if (trimmed === 'POSITIVE:') {
      _pipelineState.awaitingPositive = true;
      _pipelineState.awaitingNegative = false;
      return results;
    }
    if (trimmed === 'NEGATIVE:') {
      _pipelineState.awaitingNegative = true;
      _pipelineState.awaitingPositive = false;
      return results;
    }

    // ── Capture next non-empty line for prompt ──
    if (trimmed !== '') {
      if (_pipelineState.awaitingPositive) {
        _pipelineState.awaitingPositive = false;
        _pipelineState.promptPositive = trimmed;
        results.push(_buildPromptArtifact());
        return results;
      }
      if (_pipelineState.awaitingNegative) {
        _pipelineState.awaitingNegative = false;
        _pipelineState.promptNegative = trimmed;
        results.push(_buildPromptArtifact());
        return results;
      }
    }

    return results;
  } catch (_) {
    return [];
  }
}

function _buildPromptArtifact() {
  const pos = _pipelineState.promptPositive;
  const neg = _pipelineState.promptNegative;
  let text = '';
  if (pos) text += 'POSITIVE:\n' + pos;
  if (pos && neg) text += '\n\nNEGATIVE:\n' + neg;
  else if (neg) text += 'NEGATIVE:\n' + neg;
  return { kind: 'artifact', slot: 'prompt', text };
}

/**
 * Convert a raw path (possibly absolute) to a /file?p=... URL.
 * Returns null if the path is not under output/ or staging/ of the working dir.
 */
function _artifactPathToUrl(rawPath) {
  try {
    // Resolve: if absolute, use as-is; if relative, resolve from workingDir
    const abs = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(workingDir, rawPath);

    const allowedRoots = [
      path.resolve(workingDir, 'output'),
      path.resolve(workingDir, 'staging'),
    ];

    const isAllowed = allowedRoots.some(root =>
      abs === root || abs.startsWith(root + path.sep)
    );

    if (!isAllowed) return null;

    const rel = path.relative(workingDir, abs).replace(/\\/g, '/');
    return '/file?p=' + encodeURIComponent(rel);
  } catch (_) {
    return null;
  }
}

// ─── /file security helper ────────────────────────────────────────────────────

function resolveFileParam(p) {
  // Returns { abs, allowed } or null if p missing/invalid (the rule lives in servable.js, shared with generate_from_refs)
  return servable.resolveFileParam(workingDir, p);
}

function extToMime(ext) {
  switch (ext.toLowerCase()) {
    case '.glb':  return 'model/gltf-binary';
    case '.png':  return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.mp4':  return 'video/mp4';
    case '.webp': return 'image/webp';
    default:      return 'application/octet-stream';
  }
}

// ─── v1.10 LIB2: output trash (images + videos) and video posters ─────────────────────────────────────────
// Trash = output/.trash/<stamp>/<the recorded relative path> + output/.trash/index.json [{id, from, to, at, kind}]. A move, never a
// hard delete; the only delete is "Empty trash", and it only ever removes inside output/.trash/. Posters = output/.thumbs/<sha1>.jpg.
// Every path decision is lexical AND by realpath (a junction / symlink can never carry a move or a delete out of its root).
// Test seam: PHOENIX_TRASH_NAME / PHOENIX_THUMBS_NAME rename the two folders under output/ (suites never touch the real ones).
const OUTPUT_DIR = path.join(workingDir, 'output');
const DEFAULT_TRASH_DIR = path.join(OUTPUT_DIR, '.trash');
// the seam must be ONE plain path part - anything else ("../x", "a/b", "C:x") falls back to the default
const safeDirName = (v, def) => (typeof v === 'string' && /^[A-Za-z0-9._-]+$/.test(v) && v !== '.' && v !== '..') ? v : def;
const TRASH_DIR  = path.join(OUTPUT_DIR, safeDirName(process.env.PHOENIX_TRASH_NAME, '.trash'));
const TRASH_INDEX = path.join(TRASH_DIR, 'index.json');
const THUMBS_DIR = path.join(OUTPUT_DIR, safeDirName(process.env.PHOENIX_THUMBS_NAME, '.thumbs'));
const FS_CI = process.platform === 'win32';   // NTFS / Windows paths are case-insensitive
const pcmp = (p) => FS_CI ? String(p).toLowerCase() : String(p);
const sameP = (a, b) => pcmp(a) === pcmp(b);
const relPosix = (abs) => path.relative(workingDir, abs).split(path.sep).join('/');
const inside = (root, abs) => { const r = pcmp(root), x = pcmp(abs); return x !== r && x.startsWith(r + path.sep); };
const insideOrSame = (root, abs) => sameP(root, abs) || inside(root, abs);
const hasDrive = (s) => /^[a-zA-Z]:/.test(s) || s.startsWith('\\\\') || s.startsWith('//') || s.includes('\0');   // C:output/x (drive-relative), UNC
const TRASH_KINDS_OK = ['image', 'i2i', 'video', 'upload'];
const fsp = fs.promises;

function trashValid(x) {
  return !!x && typeof x === 'object' && typeof x.id === 'string' && !!x.id && typeof x.from === 'string' && typeof x.to === 'string'
    && typeof x.at === 'string' && TRASH_KINDS_OK.includes(x.kind);
}
// strict = true: only a genuinely ABSENT index is []; unreadable / corrupt / any malformed entry THROWS (a trash that cannot be read
// completely is never written over). strict = false (listing): valid entries only.
function trashRead(strict) {
  let raw;
  try { raw = fs.readFileSync(TRASH_INDEX, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return []; if (strict) throw e; return []; }
  let o;
  try { o = JSON.parse(raw); } catch (e) { if (strict) throw e; return []; }
  if (!Array.isArray(o)) { if (strict) throw new Error('the trash index is not a list'); return []; }
  const good = o.filter(trashValid);
  if (strict) {
    if (good.length !== o.length) throw new Error('the trash index has ' + (o.length - good.length) + ' malformed entr' + (o.length - good.length === 1 ? 'y' : 'ies'));
    if (new Set(good.map(x => x.id)).size !== good.length) throw new Error('the trash index has duplicate ids');
  }
  return good;
}
function trashWrite(list) {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const tmp = TRASH_INDEX + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, TRASH_INDEX);
}
// LC2d: a local clip is two files side by side (<name>_local.<ext> silent, <name>_local.sound.<ext> original); -> { orig: is this the original, twin: the other one's path | null }
function clipTwin(rel) {
  const m = /^(.*)_local(\.sound)?(\.[A-Za-z0-9]+)$/.exec(String(rel || ''));
  if (!m) return { orig: false, twin: null };
  return m[2] ? { orig: true, twin: m[1] + '_local' + m[3] } : { orig: false, twin: m[1] + '_local.sound' + m[3] };
}
// LC2f (D3): where does a video workflow run? With TWO ComfyUI endpoints (comfyui + comfyui_bild) every one is asked what it can measure: are the entry's models and nodes
// there (/object_info) and which PyTorch is it (/system_stats). Read-only GETs, 8 s / 4 s. With ONE endpoint -> null and not a single request. Never throws.
// entryLike = { deps:{custom_nodes, models} } (a saved entry, or the deps of a dialog that is not saved yet); override = 'main' | 'bild' | undefined.
async function measureVideoCandidates(cfg, entryLike) {
  const eps = (cfg && cfg.endpoints) || {};
  const main = String(eps.comfyui || 'http://localhost:8188').replace(/\/+$/, '');
  const second = eps.comfyui_bild ? String(eps.comfyui_bild).replace(/\/+$/, '') : '';
  if (!second || second.toLowerCase() === main.toLowerCase()) return null;
  const one = async (key, base) => {
    const c = { key, base, reachable: false, missing: [], torch: null };
    try {
      const r = await fetch(base + '/object_info', { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const dep = workflows.checkDeps(entryLike || {}, await r.json());
        c.reachable = true; c.missing = dep.missing_models.concat(dep.missing_nodes);
      }
    } catch (_) { /* not answering: reachable stays false */ }
    if (c.reachable) {
      try {
        const r = await fetch(base + '/system_stats', { signal: AbortSignal.timeout(4000) });
        if (r.ok) { const j = await r.json(); c.torch = (j && j.system && typeof j.system.pytorch_version === 'string') ? j.system.pytorch_version : null; }
      } catch (_) { /* the PyTorch version stays unknown: no "modern" claim */ }
    }
    return c;
  };
  return Promise.all([one('main', main), one('bild', second)]);
}
async function measureVideoInstances(cfg, entryLike, override) {
  const cands = await measureVideoCandidates(cfg, entryLike);
  if (!cands) return null;
  const pick = workflows.pickVideoInstance(cands, override);
  return pick ? Object.assign(pick, { candidates: cands }) : null;
}
// the Advanced choice of the dialog: 'auto' | 'main' | 'second' -> the override the pick takes
const instanceOverride = (mode) => mode === 'main' ? 'main' : (mode === 'second' ? 'bild' : undefined);
// after a video entry was written: pick (or take the user's choice) and store it. -> { instance, pinned, line, candidates } | null (one ComfyUI: nothing measured, nothing stored)
async function applyVideoInstance(cfg, id, mode) {
  const entry = (workflows.loadRegistry().workflows || {})[id];
  if (!entry || entry.stage !== 'video') return null;
  const m = (mode === 'auto' || mode === 'main' || mode === 'second') ? mode : (entry.instance_pinned ? (entry.instance === 'bild' ? 'second' : 'main') : 'auto');
  const pick = await measureVideoInstances(cfg, entry, instanceOverride(m));
  if (!pick) return null;
  workflows.setVideoInstance(id, pick.instance, m !== 'auto');
  return { instance: pick.instance || null, pinned: m !== 'auto', line: pick.line, candidates: pick.candidates };
}
// LC2d (T8-3): the tombstone list - paths whose file was REALLY deleted by Empty trash, with the time it happened. The records log is never edited, so without this a
// record whose trash entry was emptied is listed again as a "missing" tile. A record is hidden when it is not newer than the tombstone of its path (a NEW record at
// the same path shows again). One file in the trash folder, atomic tmp + rename; bounded.
const TOMB_FILE = path.join(TRASH_DIR, 'deleted.json');
const TOMB_SOFT = 2000;   // above this many tombstones the list is compacted: only tombstones whose path has NO record any more are dropped (never one whose record still exists)
function tombRead() {   // -> Map path -> at (ms); unreadable = nothing hidden
  const m = new Map();
  try {
    const o = JSON.parse(fs.readFileSync(TOMB_FILE, 'utf8'));
    if (Array.isArray(o)) for (const t of o) { const ms = t && typeof t.path === 'string' ? Date.parse(t.at) : NaN; if (isFinite(ms) && ms >= (m.get(t.path) || 0)) m.set(t.path, ms); }
  } catch (_) { /* none yet */ }
  return m;
}
function tombWrite(m) {   // throws when the file cannot be written
  if (m.size > TOMB_SOFT) {
    let live = null;
    try { live = new Set(records.readRecords({ kinds: TRASH_KINDS_OK }).map(r => r.path)); } catch (_) { live = null; }
    if (live) for (const k of [...m.keys()]) if (!live.has(k)) m.delete(k);
  }
  const list = [...m.entries()].map(([p, ms]) => ({ path: p, at: new Date(ms).toISOString() }));
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const tmp = TOMB_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
  fs.renameSync(tmp, TOMB_FILE);
}
function tombAdd(paths) { const m = tombRead(), now = Date.now(); for (const p of paths) m.set(p, now); tombWrite(m); }
function tombRevert(paths, prev) {   // put the earlier state of these paths back (a delete that did not happen)
  const m = tombRead();
  for (const p of paths) { if (prev.has(p)) m.set(p, prev.get(p)); else m.delete(p); }
  tombWrite(m);
}
const isLinkSync = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };
const realOf = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
function nearestRealDir(p) { let d = p; for (let i = 0; i < 64; i++) { const r = realOf(d); if (r) return r; const up = path.dirname(d); if (up === d) return null; d = up; } return null; }
// '' when the trash root may be used: not a link, its real path inside the real output/ (it need not exist yet)
function trashRootError() {
  if (isLinkSync(TRASH_DIR)) return 'the trash folder is a link - refused';
  const ro = realOf(OUTPUT_DIR);
  if (!ro) return 'output/ is missing';
  const rt = realOf(TRASH_DIR);
  if (rt && !inside(ro, rt)) return 'the trash folder resolves outside output/ - refused';
  return '';
}
const inAnyTrash = (abs) => inside(TRASH_DIR, abs) || sameP(abs, TRASH_DIR) || inside(DEFAULT_TRASH_DIR, abs) || sameP(abs, DEFAULT_TRASH_DIR);
// '' when rel is a servable, existing, non-link file inside output/ (and not inside the trash itself) - else the plain reason.
function trashSourceError(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('..') || path.isAbsolute(rel) || hasDrive(rel)) return 'not a recorded output file';
  const abs = path.resolve(workingDir, rel);
  if (!inside(OUTPUT_DIR, abs) || inAnyTrash(abs)) return 'only files inside output/ can be trashed';
  let st;
  try { st = fs.lstatSync(abs); } catch (_) { return 'file is gone'; }
  if (st.isSymbolicLink() || !st.isFile()) return 'not a regular file';
  const real = realOf(abs), realOut = realOf(OUTPUT_DIR), realTrash = realOf(TRASH_DIR);
  if (!real || !realOut) return 'file is gone';
  if (!inside(realOut, real) || (realTrash && insideOrSame(realTrash, real))) return 'only files inside output/ can be trashed';
  return '';
}
function trashStamp() { return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', ''); }   // 20261014-123456.789
function pruneEmptyUp(dir) {   // remove empty folders from dir up to (excluding) the trash root
  let d = dir;
  while (inside(TRASH_DIR, d)) {
    try { if (fs.readdirSync(d).length) return; fs.rmdirSync(d); } catch (_) { return; }
    d = path.dirname(d);
  }
}
async function pruneEmptyUpAsync(dir) {
  let d = dir;
  while (inside(TRASH_DIR, d)) {
    try { if ((await fsp.readdir(d)).length) return; await fsp.rmdir(d); } catch (_) { return; }
    d = path.dirname(d);
  }
}
// the three mutating routes run one at a time (Empty trash is async; the index is read-modify-write)
let trashChain = Promise.resolve();
function withTrashLock(fn) { const p = trashChain.then(fn, fn); trashChain = p.catch(() => {}); return p; }

// → [status, body]
function trashDo(p) {
  const rec = (!p || typeof p !== 'string' || p.includes('..')) ? null : records.readRecords({ kinds: TRASH_KINDS_OK }).find(r => r.path === p);
  if (!rec) return [400, { error: 'not a recorded image or video' }];
  const why = trashSourceError(p);
  if (why === 'file is gone') return [404, { error: why }];
  if (why) return [400, { error: why }];
  const rootErr = trashRootError();
  if (rootErr) return [400, { error: rootErr }];
  let list;
  try { list = trashRead(true); }
  catch (e) { return [500, { error: 'The trash index could not be read - nothing was moved. ' + e.message }]; }
  if (list.some(x => x.from === p)) return [409, { error: 'already in the trash' }];
  const abs = path.resolve(workingDir, p);
  const stamp = trashStamp();
  let dest = path.join(TRASH_DIR, stamp, p);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(TRASH_DIR, stamp + '-' + n, p);
  const entry = { id: require('crypto').randomBytes(6).toString('hex'), from: p, to: relPosix(dest), at: new Date().toISOString(), kind: rec.kind };
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const rt = realOf(TRASH_DIR), rd = realOf(path.dirname(dest));
    if (!rt || !rd || !insideOrSame(rt, rd)) { pruneEmptyUp(path.dirname(dest)); return [400, { error: 'the trash folder resolves outside output/ - refused' }]; }
    fs.renameSync(abs, dest);
  } catch (e) { pruneEmptyUp(path.dirname(dest)); return [500, { error: 'Could not move the file to the trash: ' + e.message }]; }
  try { trashWrite(list.concat([entry])); }
  catch (e) {
    let back = true;
    try { fs.renameSync(dest, abs); } catch (_) { back = false; }   // the index is the undo record: no index entry, no move
    if (back) pruneEmptyUp(path.dirname(dest));
    return [500, { error: 'Could not write the trash index - ' + (back ? 'the file was put back. ' : 'the file could NOT be put back, it is at ' + entry.to + '. ') + e.message }];
  }
  try { trashTwin(p, entry); } catch (_) { /* the twin stays where it is; the clip itself is in the trash */ }
  return [200, { ok: true, id: entry.id, item: entry }];
}
// LC2d (O3): a local clip's other file moves into the same trash folder as a linked entry (twin_of); it has no record of its own
function trashTwin(p, main) {
  const t = clipTwin(p);
  if (!t.twin || trashSourceError(t.twin)) return;
  const list = trashRead(true);
  if (list.some(x => x.from === t.twin)) return;
  const top = path.relative(TRASH_DIR, path.resolve(workingDir, main.to)).split(path.sep)[0];
  const dest = path.join(TRASH_DIR, top, t.twin);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.resolve(workingDir, t.twin), dest);
  try { trashWrite(list.concat([{ id: require('crypto').randomBytes(6).toString('hex'), from: t.twin, to: relPosix(dest), at: main.at, kind: main.kind, twin_of: main.id }])); }
  catch (e) { try { fs.renameSync(dest, path.resolve(workingDir, t.twin)); } catch (_) {} }
}

// → {} on success, { err, created } on failure. created = this call made the file at dst (so it, and only it, is removed again on failure).
async function exclusiveCopy(src, dst) {
  let fh;
  try { fh = await fsp.open(dst, 'wx'); }   // EEXIST -> not ours, nothing touched
  catch (err) { return { err, created: false }; }
  try {
    await require('stream/promises').pipeline(fs.createReadStream(src), fh.createWriteStream());
    return {};
  } catch (err) {
    try { await fh.close(); } catch (_) {}
    try { await fsp.unlink(dst); } catch (_) {}   // we created it exclusively: the partial copy is ours
    return { err, created: true };
  }
}
async function restoreDo(id) {
  let list;
  try { list = trashRead(true); }
  catch (e) { return [500, { error: 'The trash index could not be read - nothing was moved. ' + e.message }]; }
  const entry = id ? list.find(x => x.id === id) : null;
  if (!entry) return [404, { error: 'not in the trash' }];
  const bad = (s) => [400, { error: s }];
  if ([entry.from, entry.to].some(s => s.includes('..') || path.isAbsolute(s) || hasDrive(s))) return bad('the trash entry points outside output/');
  const from = path.resolve(workingDir, entry.from), to = path.resolve(workingDir, entry.to);
  if (!inside(OUTPUT_DIR, from) || inAnyTrash(from) || !inside(TRASH_DIR, to)) return bad('the trash entry points outside output/');
  const rootErr = trashRootError();
  if (rootErr) return bad(rootErr);
  let tst = null;
  try { tst = fs.lstatSync(to); } catch (_) {}
  if (!tst || tst.isSymbolicLink() || !tst.isFile()) return [404, { error: 'the trashed file is gone' }];
  const rt = realOf(TRASH_DIR), ro = realOf(OUTPUT_DIR), rdTo = realOf(path.dirname(to));
  if (!rt || !ro || !rdTo || !insideOrSame(rt, rdTo)) return bad('the trashed file resolves outside output/');
  const nearFrom = nearestRealDir(path.dirname(from));
  if (!nearFrom || !insideOrSame(ro, nearFrom) || insideOrSame(rt, nearFrom)) return bad('the original folder resolves outside output/');
  try {
    fs.mkdirSync(path.dirname(from), { recursive: true });
    const rdFrom = realOf(path.dirname(from));
    if (!rdFrom || !insideOrSame(ro, rdFrom) || insideOrSame(rt, rdFrom)) return bad('the original folder resolves outside output/');
    // exclusive: a file that appears at the original path meanwhile is never replaced (EEXIST -> 409)
    try { fs.linkSync(to, from); }
    catch (e1) {
      if (e1 && e1.code === 'EEXIST') return [409, { error: 'a file already exists at the original path - nothing was restored' }];
      // No hard links here: copy. The destination is RESERVED by exclusive creation ('wx') first, then streamed into (async: a big video must not freeze
      // the server). Only a file this attempt created is ever removed; a file somebody else put at `from` is never touched.
      const c = await exclusiveCopy(to, from);
      if (c.err) {
        if (!c.created && c.err.code === 'EEXIST') return [409, { error: 'a file already exists at the original path - nothing was restored' }];
        return [500, { error: 'Could not copy the file back - it stays in the trash. ' + ((c.err && c.err.message) || c.err) }];
      }
    }
    try { fs.unlinkSync(to); }
    catch (e3) { try { fs.unlinkSync(from); } catch (_) {} return [500, { error: 'Could not take the file out of the trash: ' + e3.message }]; }
  } catch (e) { return [500, { error: 'Could not restore the file: ' + e.message }]; }
  try { trashWrite(list.filter(x => x.id !== id)); }
  catch (e) {
    let back = true;
    try { fs.renameSync(from, to); } catch (_) { back = false; }
    return [500, { error: 'Could not write the trash index - ' + (back ? 'the file stays in the trash. ' : 'the file is restored at ' + entry.from + ' but its trash entry could not be updated. ') + e.message }];
  }
  pruneEmptyUp(path.dirname(to));
  const warns = [];   // LC2d (O3, round 3): a twin that cannot be restored is reported, and stays in the trash as an item of its own (visible, retryable) - never hidden behind its clip
  for (const lk of list.filter(x => x.twin_of === id)) {
    let tr;
    try { tr = await restoreDo(lk.id); } catch (e) { tr = [500, { error: String((e && e.message) || e) }]; }
    if (tr[0] !== 200) {
      warns.push((tr[1] && tr[1].error) || 'unknown error');
      try { trashWrite(trashRead(true).map(x => { if (x.id !== lk.id) return x; const c2 = Object.assign({}, x); delete c2.twin_of; return c2; })); } catch (_) { /* the entry stays linked; the next Restore of the clip is gone, but Empty only deletes it on purpose */ }
    }
  }
  return [200, Object.assign({ ok: true, path: entry.from, url: '/file?p=' + encodeURIComponent(entry.from) }, warns.length ? { warning: 'The clip is back, but its sound file could not be restored (' + warns[0] + ') - it stays in the trash; restore it from there.' } : {})];
}

// Empty trash (T6-6): the only delete. Async fs, bounded concurrency; entries whose delete failed STAY (and are reported).
async function emptyDo(kinds) {
  const want = Array.isArray(kinds) ? kinds.filter(k => TRASH_KINDS_OK.includes(k)) : [];
  let list;
  try { list = trashRead(true); }
  catch (e) { return [500, { error: 'The trash index could not be read - nothing was deleted. ' + e.message }]; }
  const rootErr = trashRootError();
  if (rootErr) return [400, { error: rootErr }];
  const rt = realOf(TRASH_DIR);
  const gone = want.length ? list.filter(x => want.includes(x.kind)) : list;
  const cand = gone.filter(x => typeof x.to === 'string' && !x.to.includes('..') && !path.isAbsolute(x.to) && !hasDrive(x.to) && inside(TRASH_DIR, path.resolve(workingDir, x.to))).map(x => x.from);
  const prevTomb = tombRead();
  if (cand.length) { try { tombAdd(cand); } catch (e) { return [500, { error: 'Nothing was deleted - the list of deleted files could not be written: ' + e.message }]; } }   // durable FIRST: the index is untouched on failure, a retry works
  let removed = 0;
  const failed = [];
  const unlinked = [];   // LC2d (T8-3): the paths whose file is really gone now (their records must not come back as tiles)
  const one = async (x) => {
    const to = path.resolve(workingDir, x.to);
    if (x.to.includes('..') || path.isAbsolute(x.to) || hasDrive(x.to) || !inside(TRASH_DIR, to)) return;   // an entry pointing outside the trash is dropped, never followed
    let st;
    try { st = await fsp.lstat(to); }
    catch (e) { if (e && e.code === 'ENOENT') { unlinked.push(x.from); return; } failed.push({ id: x.id, from: x.from, error: e.message }); return; }
    let rd = null;
    try { rd = await fsp.realpath(path.dirname(to)); } catch (_) {}
    if (st.isSymbolicLink() || !st.isFile() || !rt || !rd || !insideOrSame(rt, rd)) { failed.push({ id: x.id, from: x.from, error: 'not a regular file inside the trash - left alone' }); return; }
    if (x.kind === 'video') { try { await fsp.unlink(path.join(THUMBS_DIR, thumbHash(x.from, st.mtimeMs) + '.jpg')); } catch (_) {} }   // its cached poster goes with it
    try { await fsp.unlink(to); removed++; unlinked.push(x.from); }
    catch (e) { if (e && e.code === 'ENOENT') { unlinked.push(x.from); return; } failed.push({ id: x.id, from: x.from, error: e.message }); return; }
    await pruneEmptyUpAsync(path.dirname(to));
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, gone.length) }, async () => { while (next < gone.length) { const x = gone[next++]; await one(x); } }));
  const failedIds = new Set(failed.map(f => f.id));
  const keep = list.filter(x => !gone.includes(x) || failedIds.has(x.id));
  if (!want.length && !failed.length) {   // everything: also sweep what the index does not know about - inside the trash folder only
    const keepTop = new Set(keep.map(x => path.relative(TRASH_DIR, path.resolve(workingDir, x.to)).split(path.sep)[0]));
    try {
      for (const n of await fsp.readdir(TRASH_DIR)) {
        if (n === 'index.json' || n.startsWith('index.json.tmp-') || n === 'deleted.json' || n.startsWith('deleted.json.tmp-') || keepTop.has(n)) continue;
        try { await fsp.rm(path.join(TRASH_DIR, n), { recursive: true, force: true }); } catch (_) {}
      }
    } catch (_) {}
  }
  const notDone = cand.filter(p => !unlinked.includes(p));   // announced but not deleted (a failed unlink, an entry pointing outside the trash): not tombstoned after all
  if (notDone.length) { try { tombRevert(notDone, prevTomb); } catch (_) { /* harmless: such a record is still hidden by its trash entry */ } }
  try { trashWrite(keep); }
  catch (e) { return [500, { error: 'Files were deleted but the trash index could not be written: ' + e.message }]; }
  return [200, { ok: failed.length === 0, removed, left: keep.length, failed }];
}

// video poster (T6-23): one ffmpeg frame, cached by sha1(path + mtime). child_process is looked up at call time (test seam: cp.execFile).
const thumbInFlight = new Map();
const thumbFailed = new Map();   // hash -> time of the failure: a clip ffmpeg cannot read is not re-spawned for 5 minutes (bounded: noteThumbFailure)
const THUMB_FAIL_TTL = 300000, THUMB_FAIL_MAX = 500;
function noteThumbFailure(hash) {
  const now = Date.now();
  for (const [k, t] of thumbFailed) if (now - t >= THUMB_FAIL_TTL) thumbFailed.delete(k);   // expired
  thumbFailed.delete(hash);
  while (thumbFailed.size >= THUMB_FAIL_MAX) thumbFailed.delete(thumbFailed.keys().next().value);   // oldest first
  thumbFailed.set(hash, now);
}
const thumbHash = (relKey, mtimeMs) => require('crypto').createHash('sha1').update(relKey + '|' + mtimeMs).digest('hex');
function thumbMake(abs, mtimeMs, relKey) {
  const hash = thumbHash(relKey, mtimeMs);
  const out = path.join(THUMBS_DIR, hash + '.jpg');
  try { if (fs.statSync(out).size > 0) return Promise.resolve(out); } catch (_) {}
  if (thumbFailed.has(hash) && Date.now() - thumbFailed.get(hash) < THUMB_FAIL_TTL) return Promise.resolve(null);
  if (thumbInFlight.has(hash)) return thumbInFlight.get(hash);
  const run = (args, tmp) => new Promise((resolve) => {
    try {
      require('child_process').execFile(voice.ffmpegPath(), args, { timeout: 30000, windowsHide: true }, (err) => {
        let ok = false;
        try { ok = !err && fs.statSync(tmp).size > 0; } catch (_) {}
        resolve(ok);
      });
    } catch (_) { resolve(false); }
  });
  const p = (async () => {
    try { fs.mkdirSync(THUMBS_DIR, { recursive: true }); } catch (_) { return null; }
    const tmp = path.join(THUMBS_DIR, hash + '.tmp-' + process.pid + '.jpg');
    const mk = (ss) => ['-hide_banner', '-loglevel', 'error', '-y'].concat(ss ? ['-ss', '0.5'] : [], ['-i', abs, '-frames:v', '1', '-vf', 'scale=320:-1', tmp]);
    let ok = await run(mk(true), tmp);
    if (!ok) { try { fs.unlinkSync(tmp); } catch (_) {} ok = await run(mk(false), tmp); }   // a clip shorter than 0.5 s has no frame there
    if (!ok) { try { fs.unlinkSync(tmp); } catch (_) {} noteThumbFailure(hash); return null; }
    try { fs.renameSync(tmp, out); } catch (_) { try { fs.unlinkSync(tmp); } catch (_) {} return null; }
    return out;
  })().finally(() => { thumbInFlight.delete(hash); });
  thumbInFlight.set(hash, p);
  return p;
}

// ─── Busy flag (now managed by shared lock — see lock.js) ────────────────────

// ─── Request handler ──────────────────────────────────────────────────────────

// v1.10 ADV: GET/POST /palette answer - hint/style/builtin per category plus the params of the ACTIVE image + mesh workflows
// ({ value, overridden, workflow } per key) and which workflow each stage's params come from.
function paletteResponse() {
  const cats = palette.loadPalette().categories;
  const pv = wfp.paletteView(a.loadConfig());
  const out = {};
  for (const [k, c] of Object.entries(cats)) out[k] = { hint: c.hint, style: c.style, builtin: !!c.builtin, params: pv.params[k] || {} };
  return { categories: out, paramSource: pv.paramSource, paramDefs: pv.defs };
}

// <r1-remote> B1 (structural): a REMOTE request is authorised again the moment its body has arrived. If its device was disconnected, Remote access switched off, or
// the request was cut while the body was on the wire, remote.revoked()/abandon() answer 401 (when a socket is left), destroy the request, and the promise returned here
// NEVER SETTLES - so no route's own "catch and carry on with defaults" can run its action. (Requests without the remote marker behave exactly as before.)
function readBody(req) {
  return new Promise((resolve, reject) => {
    const isR = remote.isRemoteReq(req);
    const pre = remote.bufferedBody(req);   // POST /config from a phone was already read once (quick-switch check)
    if (pre) { if (remote.revoked(req)) return; return resolve(pre.toString('utf8')); }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { if (isR && remote.revoked(req)) return; resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (isR) { remote.abandon(req); return; } reject(e); });
  });
}

function readRawBody(req, limit) {   // limit (bytes, optional): a body over it is refused up front (Content-Length) or as soon as the running total passes it - never fully buffered
  return new Promise((resolve, reject) => {
    const isR = remote.isRemoteReq(req);
    const chunks = [];
    let total = 0, over = false;
    const tooBig = () => { over = true; chunks.length = 0; const e = new Error('file too large'); e.tooLarge = true; reject(e); try { req.resume(); } catch (_) { /* gone */ } };
    if (limit > 0) { const cl = Number(req.headers && req.headers['content-length']); if (isFinite(cl) && cl > limit) { tooBig(); return; } }
    req.on('data', c => { if (over) return; total += c.length; if (limit > 0 && total > limit) { tooBig(); return; } chunks.push(c); });
    req.on('end', () => { if (over) return; if (isR && remote.revoked(req)) return; resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (isR) { remote.abandon(req); return; } reject(e); });
  });
}
// B2: after ANY wait between the body and the action (a lock queue, a probe), a remote request is checked once more. true = go on.
const REMOTE_GONE = { error: 'Not paired - open the pairing link from Phoenix on the laptop.' };
const REMOTE_NO_PAID = { error: 'Only on the laptop: paid jobs (Meshy, fal.ai).' };   // LC2i: v1.10 - a paired phone starts nothing that costs money (an opt-in switch is planned)
function remoteOk(req, res) { if (remote.authorised(req)) return true; sendJSON(res, 401, REMOTE_GONE); return false; }
const ifStillAuthorized = (req, fn) => () => (remote.authorised(req) ? fn() : [401, REMOTE_GONE]);

// User-facing names of the light /action actions that take the lock with a label (shown in "Phoenix is busy: ...").
const ACTION_LABELS = Object.freeze({
  import_asset: 'importing an asset', save_as_brush: 'saving a brush', use_brush: 'placing a brush',
  apply_material: 'applying a material', rename_asset: 'renaming an asset', rename_brush: 'renaming a brush',
  delete_asset: 'deleting an asset', delete_brush: 'deleting a brush', list_materials: 'reading the materials',
  delete_material: 'deleting a material', make_human: 'building a character', place_human: 'placing a character',
  animate_human: 'animating a character', sequence_animations: 'building an animation sequence',
  save_animation: 'saving an animation', assign_skeleton: 'assigning a skeleton', spawn_rig: 'spawning a rig',
  save_clip: 'saving a clip', animate_clip: 'applying a clip', sequence_clips: 'building a clip sequence',
  save_mesh: 'saving a mesh', save_character: 'saving a character', spawn_character: 'spawning a character',
  prepare_mesh: 'preparing a mesh', bind_mesh: 'binding a mesh', inspect_render: 'checking a render',
  asset_to_unreal: 'sending an asset to Unreal', brush_to_unreal: 'sending a brush to Unreal',
  brush_preview: 'rendering a brush preview', inspect_unreal: 'checking the Unreal scene',
  unreal_to_blender: 'bringing an asset over from Unreal', unreal_to_brush: 'making a brush from Unreal',
  character_to_unreal: 'sending a character to Unreal',
});
function actionLabel(action) {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, action) ? ACTION_LABELS[action] : String(action).replace(/_/g, ' ');
}

// The busy refusal of the heavy-job sites: names the real holder (a generation only when one runs), not every lock holder as a generation.
function busyRefusal() {
  const who = lock.holder();
  if (deferredInFlight || jobs.isRunning() || who === lock.GENERATION) return { error: 'a generation is already running — one heavy GPU job at a time; give it a moment', busy: true };   // busy: the storyboard view clears it when jobs go idle
  return { error: who ? 'Phoenix is busy: ' + who : 'Phoenix is busy with another step', busy: true };
}

function sendJSON(res, statusCode, obj, extraHeaders) {
  if (res.writableEnded) return;   // <r1-remote> the response was already answered (a revoked remote request): never answer twice
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

const WEB_ROOT = path.join(__dirname, 'web');

// ── Provider layer glue (v1.9 M1) ───────────────────────────────────────────
// Tests inject deps via _setProviderDeps: { validateSeat, listModels } replace the routes' calls
// outright; { cli, fetchImpl, getKey, dbg, spawn } are forwarded to providers/index.js.
let _provDeps = null;
let _probeRunning = false;   // one tool probe at a time
let lastCpProbeFailAt = 0;   // sweep 3 H
let _benchRunning = false;   // one competence benchmark at a time (it owns a headless Blender)
let _benchProgress = null;   // { task, of, id } while it runs — the UI polls GET /seat-bench-status
function _setProviderDeps(d) {
  _provDeps = (d && typeof d === 'object') ? d : null;
  if (!_provDeps) { providers._resetDeps(); return; }
  const fwd = {};
  for (const k of ['cli', 'fetchImpl', 'getKey', 'dbg', 'spawn', 'sleepImpl', 'spawnImpl', 'codexExe', 'spawnSyncImpl', 'existsSync']) if (_provDeps[k]) fwd[k] = _provDeps[k];
  providers._setDeps(fwd);
}
function provValidateSeat(name, candidate, cfgForValidation) {
  return (_provDeps && _provDeps.validateSeat)
    ? _provDeps.validateSeat(name, candidate, cfgForValidation)
    : providers.validateSeat(name, candidate, cfgForValidation);
}
function provListModels(endpointName, cfgForList) {
  return (_provDeps && _provDeps.listModels)
    ? _provDeps.listModels(endpointName, cfgForList)
    : providers.listEndpointModels(endpointName, cfgForList);
}

// Resolved view of every seat for the Settings UI — old configs show their inferred provider.
// env {} → shows what the FILE says, not a LOCAL_API / GEMMA_MODEL override.
function seatsView(cfg) {
  const out = {};
  for (const name of providers.SEAT_NAMES) {
    try {
      const r = providers.resolveSeat(name, cfg, {});
      const c = capabilities.getCaps(r), vz = capabilities.getVision(r);   // the vision test (M3) is its own verdict on the same key
      const caps = c ? { tools: c.tools, probedAt: c.probedAt, forced: !!c.forced, bench: c.bench || null } : (vz ? {} : null);
      if (caps && vz) Object.assign(caps, vz);
      out[name] = { provider: r.provider, model: r.model, endpoint: r.endpointName, caps };
    } catch (_) {
      const raw = (cfg && cfg.seats && cfg.seats[name]) || {};
      out[name] = { provider: raw.provider || '', model: raw.model || '', endpoint: raw.endpoint || '', caps: null };
    }
  }
  return out;
}
// Competence gate (v1.9 M2.1): only a LOCAL openai-compat orchestrator needs >= 4/5 on the benchmark; cloud/CLI/Codex
// seats are only graded. A benchmark that could not run (no Blender) is a missing prerequisite, not a failed test.
// → null (allowed) | the 400 error text.
function benchGateError(seat, caps) {
  if (!seat || seat.provider !== 'openai-compat' || seat.kind !== 'local') return null;
  const v = bench.benchVerdict(caps && caps.bench);   // old-shape entry = not run
  // A local orchestrator is never saved without a measured benchmark (or an explicit unavailable marker).
  if (v.state === 'none') return 'Run the benchmark first (Settings runs it automatically for local models).';
  if (v.state !== 'fail') return null;   // pass | unavailable
  return (seat.model || 'This model') + ' solved ' + v.passed + '/' + v.total + ' benchmark tasks over ' + v.runs + ' runs (needs ' + v.need + '): ' + v.weak.join(', ');
}
// M2.3: validateSeat for a probe/bench candidate (same merge rule as the probe itself). → '' (ok) | the message.
// Sweep 2 G2: the Settings dialog tests a seat against the endpoint URL TYPED THERE (maybe not saved yet). Only the `local` URL can be overlaid,
// only as an http(s) URL, only for this request - nothing is written.
// A non-empty candidate that is not an http(s) URL (or endpoints that is not an object) is an ERROR, never a silent fallback to the saved endpoint.
function withCandidateEndpoints(cfg0, eps) {
  if (eps === undefined || eps === null) return cfg0;
  if (typeof eps !== 'object' || Array.isArray(eps)) throw new CandidateEndpointError();
  const raw = eps.local;
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return cfg0;
  const u = typeof raw === 'string' ? raw.trim() : '';
  // parsed, not pattern-matched: "http://[" or "http://" is no URL; only http: / https: with a host counts
  let parsed = null;
  try { parsed = new URL(u); } catch (_) { /* invalid */ }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) throw new CandidateEndpointError();
  return { ...cfg0, endpoints: { ...(cfg0.endpoints || {}), local: u } };
}
class CandidateEndpointError extends Error { constructor() { super('LM Studio endpoint must be an http(s) URL.'); this.field = 'local'; } }
async function validateCandidate(seatName, body) {
  try {
    const cfg0 = withCandidateEndpoints(a.loadConfig(), body && body.endpoints);
    const cur = (cfg0.seats && cfg0.seats[seatName] && typeof cfg0.seats[seatName] === 'object') ? cfg0.seats[seatName] : {};
    const cand = { ...cur };
    for (const k of ['provider', 'model', 'endpoint']) if (body && typeof body[k] === 'string') cand[k] = body[k];
    const { ok, msg } = await provValidateSeat(seatName, cand, cfg0);
    return ok ? '' : String(msg || 'candidate was not accepted');
  } catch (e) { return String((e && e.message) || e); }
}
function endpointNamesOf(cfg) {
  const names = ['local', 'openai'];
  const eps = (cfg && cfg.endpoints) || {};
  for (const [k, v] of Object.entries(eps)) {
    if (v && typeof v === 'object' && typeof v.url === 'string' && !names.includes(k)) names.push(k);
  }
  return names;
}

// A key route must not be callable cross-site: a browser request from another origin (or a DNS-rebound
// Host) is refused. Requests with neither header (curl, tests) are same-machine by construction.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// Sweep 3b B: with an Origin present the request must be STRICTLY same-origin: scheme http, and the Origin's hostname AND port equal the Host header's
// hostname and port (the page's own relative requests always match). No cross-alias exemption: another service on [::1]:7777 or localhost:9999 is not
// Phoenix on 127.0.0.1:7777. No Origin = curl, phoenix-mcp.js, the Blender addon: unchanged (loopback Host only).
function isLocalRequest(req) {
  if (remote.isRemoteReq(req)) return true;   // <r1-remote> only the remote listener's own, already-checked requests carry the private marker; every other request falls through unchanged
  const h = req.headers || {};
  let hostName = null, hostPort = '80';
  if (h.host !== undefined) {
    try { const u = new URL('http://' + h.host); hostName = u.hostname; hostPort = u.port || '80'; } catch (_) { return false; }
    if (!LOCAL_HOSTS.has(hostName)) return false;
  }
  if (h.origin !== undefined) {
    let o;
    try { o = new URL(h.origin); } catch (_) { return false; }
    if (o.protocol !== 'http:' || !LOCAL_HOSTS.has(o.hostname)) return false;
    if (h.host === undefined) return false;   // an Origin without a Host cannot be checked
    if ((o.port || '80') !== hostPort || o.hostname.toLowerCase() !== String(hostName).toLowerCase()) return false;
  }
  return true;
}

// ─── MCP (v1.9 M6) ────────────────────────────────────────────────────────────
// M6.1: the Phoenix tools in assistant.js TOOLS except i2i_edit (UI-only decision) and the 1.10 tools generate_from_refs and
// make_video (not wired yet) are reachable over POST /mcp/call, each in
// exactly one class:  R read-only (no lock, runs during a background job) · H heavy GPU · S scene (Blender) · L library write
// (reads the scene / writes files, no scene change) · U Unreal · O opt-in (off by default, see MCP_OPTIN).
// Everything but R needs the lock and is refused while a background generation runs (same doors as /chat and /rewind).
// The R-client tools (list_animations / list_custom_rigs / list_characters / job_status / stop) never reach /mcp/call —
// phoenix-mcp.js answers them with GET routes. The checkpoint list (MCP_FORCE_CHECKPOINT) lives in assistant.js.
const MCP_CLASS = {
  // R
  read_state: 'R', list_assets: 'R', list_brushes: 'R', read_palette: 'R', list_materials: 'R',
  // H
  generate_prop: 'H', generate_image: 'H', image_to_3d: 'H', hy_motion: 'H',
  // S
  import_asset: 'S', use_brush: 'S', inspect_render: 'S', make_human: 'S', place_human: 'S', animate_human: 'S',
  sequence_animations: 'S', apply_material: 'S', spawn_rig: 'S', animate_clip: 'S', sequence_clips: 'S',
  prepare_mesh: 'S', bind_mesh: 'S', spawn_character: 'S', brush_preview: 'S',
  // L
  save_as_brush: 'L', save_animation: 'L', save_clip: 'L', save_mesh: 'L', save_character: 'L',
  rename_asset: 'L', rename_brush: 'L', assign_skeleton: 'L',
  // M9: Meshy remesh (paid cloud) — writes the library, no scene change, no checkpoint; takes NO chat lock (see /mcp/call)
  remesh_asset: 'L',
  // U
  asset_to_unreal: 'U', brush_to_unreal: 'U', unreal_to_blender: 'U', unreal_to_brush: 'U', character_to_unreal: 'U', inspect_unreal: 'U',
  // O
  blender_run: 'O', unreal_run: 'O', delete_asset: 'O', delete_brush: 'O', delete_material: 'O',
};
// opt-in tool -> the cfg.mcp flag that switches it on (default off; Settings -> Connections)
const MCP_OPTIN = { blender_run: 'allowBlenderRun', unreal_run: 'allowUnrealRun', delete_asset: 'allowDelete', delete_brush: 'allowDelete', delete_material: 'allowDelete' };
const MCP_FLAGS = ['allowBlenderRun', 'allowUnrealRun', 'allowDelete'];
let mcpRenderPath = path.join(workingDir, 'output', 'render-check.png');   // test seam: _setMcpRenderPath
const mcpAllows = (c, flag) => !!(c && c.mcp && c.mcp[flag] === true);
const mcpAllowsBlenderRun = (c) => mcpAllows(c, 'allowBlenderRun');   // kept: older callers/tests
const remeshView = (c) => {
  const r = (c && c.remesh && typeof c.remesh === 'object') ? c.remesh : {};
  return { enabled: r.enabled === true, provider: 'meshy', topology: r.topology === 'triangle' ? 'triangle' : 'quad',
    targetPolycount: Number.isInteger(r.targetPolycount) ? r.targetPolycount : 20000,
    maxUploadMB: (typeof r.maxUploadMB === 'number' && r.maxUploadMB > 0) ? r.maxUploadMB : 60,
    keyPresent: !!providers.getKey('meshy') };   // D8: also true for a key found via the environment; never the value
};
// V3: the video (fal.ai) block for the Settings page - never the key, never the base URL. audio = the config default for generate_audio (on unless video.fal.audio is false).
const videoView = (c) => {
  const f = (c && c.video && c.video.fal && typeof c.video.fal === 'object') ? c.video.fal : {};
  return { fal: { enabled: f.enabled === true, audio: f.audio !== false, keyPresent: !!providers.getKey('fal') } };
};
const mcpFlagsView = (c) => ({ allowBlenderRun: mcpAllows(c, 'allowBlenderRun'), allowUnrealRun: mcpAllows(c, 'allowUnrealRun'), allowDelete: mcpAllows(c, 'allowDelete') });
// "Render check: PASS | FAIL — why | UNVERIFIED — why | NO VERDICT — why | not run" (the MCP client and the chat line say the same)
function mcpVerdictLine(verdict, stopReason) {
  if (!verdict) return 'Render check: not run';
  const word = verdict === 'unverified' ? 'UNVERIFIED' : verdict === 'none' ? 'NO VERDICT' : String(verdict).toUpperCase();
  return 'Render check: ' + word + (verdict !== 'pass' && stopReason ? ' — ' + stopReason : '');
}

// <r1-remote> GET /remote/api/me (any paired phone: "am I remote, and who") + the laptop-only management routes. Returns true when answered.
async function remoteApi(req, res, method, p) {
  if (method === 'GET' && p === '/remote/api/me') {
    const d = remote.deviceOf(req);
    sendJSON(res, 200, d ? { remote: true, name: d.name } : { remote: false });
    return true;
  }
  if (!['/remote/api/state', '/remote/api/pair', '/remote/api/approve', '/remote/api/reject', '/remote/api/disconnect'].includes(p)) return false;
  if (remote.isRemoteReq(req)) { sendJSON(res, 403, { error: 'Only on the laptop: Remote access settings.' }); return true; }
  if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return true; }
  if (method === 'GET' && p === '/remote/api/state') { sendJSON(res, 200, remote.view()); return true; }
  if (method !== 'POST') { sendJSON(res, 405, { error: 'POST only' }); return true; }
  let body = {};
  try { body = JSON.parse((await readBody(req)) || '{}') || {}; } catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return true; }
  const answer = (r) => { sendJSON(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { error: r.error }); return true; };
  if (p === '/remote/api/pair') return answer(await remote.startPairing());
  const id = typeof body.id === 'string' ? body.id : '';
  if (p === '/remote/api/approve') return answer(remote.approve(id));
  if (p === '/remote/api/reject') return answer(remote.reject(id));
  return answer(remote.disconnect(id));
}

let lastLevelsOpen = null;
async function handler(req, res) {
  const method  = req.method;
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlPath = parsedUrl.pathname;

  // Sweep 2 F2: EVERY state-changing request must be same-machine/same-origin, in one place. A web page on another origin can send a
  // text/plain "simple" POST to 127.0.0.1:7777 without any preflight; refuse it before any route runs. Phoenix's own page is same-origin and
  // phoenix-mcp.js / the Blender addon / curl send no Origin (and a loopback Host), so they pass.
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !isLocalRequest(req)) {
    sendJSON(res, 403, { error: 'Cross-site request refused.' });
    return;
  }

  if (urlPath.startsWith('/remote/api/') && await remoteApi(req, res, method, urlPath)) return;   // <r1-remote>

  // ── GET / ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/') {
    let page;
    try { page = pageAssembler.assemblePage({ webRoot: WEB_ROOT }); }
    catch (err) {
      const why = String((err && err.message) || err).split(/\r?\n/)[0].slice(0, 300);   // one line, never a stack
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Page assembly failed: ' + why);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }

  // ── GET /events ────────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.flushHeaders();

    clients.add(res);

    // Send initial connected event
    const connectedRec = { ts: new Date().toISOString(), cat: 'system', msg: 'connected' };
    res.write('data: ' + JSON.stringify({ kind: 'event', rec: connectedRec }) + '\n\n');

    // Keep-alive ping every 15 seconds
    const pingInterval = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        clearInterval(pingInterval);
        clients.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(pingInterval);
      clients.delete(res);
    });

    return;
  }

  // ── GET /vendor/<file> ─────────────────────────────────────────────────────
  if (method === 'GET' && urlPath.startsWith('/vendor/')) {
    const fileName = urlPath.slice('/vendor/'.length);
    // Guard against path traversal
    if (!fileName || fileName.includes('..') || fileName.includes('/')) {
      res.writeHead(400);
      res.end('400 Bad Request');
      return;
    }
    const filePath = path.join(WEB_ROOT, 'vendor', fileName);
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end('404 Not Found');
        return;
      }
      const ext = path.extname(fileName).toLowerCase();
      const VENDOR_MIME = {
        '.js':   'text/javascript; charset=utf-8',
        '.png':  'image/png',
        '.ico':  'image/x-icon',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg':  'image/svg+xml',
      };
      const mime = VENDOR_MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type':   mime,
        'Content-Length': stat.size,
      });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  // ── GET /examples/<file> ── <b2r-example>
  // The per-workflow example image / mesh under web/examples/ (read only; a plain file name, no sub-folders). Six examples ship in web/examples;
  // for any workflow without one the UI says "No example yet".
  if (method === 'GET' && urlPath.startsWith('/examples/')) {
    let fileName = '';
    try { fileName = decodeURIComponent(urlPath.slice('/examples/'.length)); } catch (_) { /* stays '' → 400 */ }
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) {
      res.writeHead(400);
      res.end('400 Bad Request');
      return;
    }
    const filePath = path.join(WEB_ROOT, 'examples', fileName);
    try {   // fs.stat can throw synchronously on a name it rejects (ERR_INVALID_ARG_VALUE) → 400, never 500
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404);
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': extToMime(path.extname(fileName)), 'Content-Length': stat.size });
        fs.createReadStream(filePath).pipe(res);
      });
    } catch (_) {
      res.writeHead(400);
      res.end('400 Bad Request');
    }
    return;
  }
  // </b2r-example>

  // ── GET /file?p=<relpath> ──────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/file') {
    const p = parsedUrl.searchParams.get('p');
    const resolved = resolveFileParam(p);
    if (!resolved || !resolved.allowed) {
      res.writeHead(403);
      res.end('403 Forbidden');
      return;
    }
    const { abs } = resolved;
    fs.stat(abs, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end('404 Not Found');
        return;
      }
      const mime = extToMime(path.extname(abs));
      res.writeHead(200, {
        'Content-Type':   mime,
        'Content-Length': stat.size,
      });
      fs.createReadStream(abs).pipe(res);
    });
    return;
  }

  // ── POST /show ─────────────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/show') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { slot, p, text, source } = body || {};

    const VALID_SLOTS = ['mesh', 'image', 'prompt'];
    if (!VALID_SLOTS.includes(slot)) {
      sendJSON(res, 400, { error: 'slot must be mesh | image | prompt' });
      return;
    }

    if (slot === 'prompt') {
      if (typeof text !== 'string') {
        sendJSON(res, 400, { error: 'text is required for prompt slot' });
        return;
      }
      broadcast({ kind: 'artifact', slot: 'prompt', text });
      sendJSON(res, 200, { ok: true });
      return;
    }

    // mesh or image — require p, validate path
    const resolved = resolveFileParam(p);
    if (!resolved || !resolved.allowed) {
      sendJSON(res, 400, { error: 'p must be a path under output/ or staging/' });
      return;
    }
    const { abs } = resolved;
    if (!fs.existsSync(abs)) {
      sendJSON(res, 404, { error: 'file not found' });
      return;
    }
    const url = '/file?p=' + encodeURIComponent(p);
    broadcast({ kind: 'artifact', slot, url, ...(source ? { source } : {}) });
    sendJSON(res, 200, { ok: true });
    return;
  }

  // ── POST /chat ─────────────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/chat') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const message = (body && typeof body.message === 'string') ? body.message.trim() : '';
    if (!message) {
      sendJSON(res, 400, { error: 'message is required and must not be empty' });
      return;
    }
    // Run mode (v1.9 M4): optional per message. Absent = the config default (gates.mode, else Ask).
    if (body && body.mode !== undefined && body.mode !== 'ask' && body.mode !== 'auto') {
      sendJSON(res, 400, { error: 'mode must be ask or auto' });
      return;
    }

    // A chat turn can trigger a heavy generation (image/mesh/text→motion). A deferred edit
    // (i2i / hy_motion) in flight holds no lock, so without this the turn would run and its
    // generation's pre-run VRAM free (freeOtherInstances) would evict the running edit's model.
    // Block chat for the edit's duration — the /action tab actions stay usable. (Q3 follow-up, 2026-08-06)
    if (deferredInFlight) {
      sendJSON(res, 409, { error: 'a background generation (i2i edit / text→motion) is running — chat is blocked until it finishes' });
      return;
    }
    if (!lock.tryAcquire('a chat turn')) {
      sendJSON(res, 409, { error: 'busy' });
      return;
    }

    cfg = a.loadConfig();
    sendJSON(res, 202, { accepted: true });

    // Run turn asynchronously
    (async () => {
      try {
        broadcast({ kind: 'user', text: message });
        state.turnSeq = (Number(state.turnSeq) || 0) + 1;   // M5: monotonically increasing turn number
        const turnNo = state.turnSeq;

        // holdsLock: this route took the lock above and holds it for the whole turn. Tools that
        // would otherwise acquire it themselves (hy_motion) must not, or they deadlock against us.
        // onArtifact: the chat path's route to the artifact tabs. inspect_render and the
        // render-vision gate produce a picture mid-turn; without this hook the render was
        // taken and judged but never shown (the /action route had it, the chat path did not).
        const turnResult = await a.runTurn(message, history, state, cfg, {
          blenderOnly: !!(body && body.noTool), background: true, holdsLock: true,
          mode: body && body.mode,   // undefined = runConfig falls back to cfg.gates.mode
          remote: remote.isRemoteReq(req),   // LC2i: a chat turn from a paired phone starts no paid job (remesh_asset refuses)
          onArtifact: (art) => {
            try {
              if (!art || !art.rel) return;
              // Forward `source` so the UI can tell an inspect/gate render from a real image and
              // NOT adopt it as the i2i edit reference (F3). Undefined source serializes away.
              broadcast({ kind: 'artifact', slot: art.slot || 'image', source: art.source,
                url: '/file?p=' + encodeURIComponent(art.rel) + '&t=' + Date.now() });
            } catch (_) { /* a broadcast must never break the turn */ }
          },
          // onNote: the way back for work that outlives the turn. hy_motion runs its ~4 minutes as a
          // background job so it does not hold the Blender lock for the whole turn; its result lands
          // here, AFTER this turn's own reply. Same shape as that reply (no `action`, so the UI does
          // not try to release a control) — a job's return value otherwise reaches only the debug log.
          onNote: (text) => {
            // `background: true` — this note arrives AFTER the turn's own reply, so the client must
            // NOT run releaseUi for it: that would decrement the lock a second time and unlock the UI
            // while a real turn is still holding it.
            try { broadcast({ kind: 'reply', text: String(text), background: true }); }
            catch (_) { /* a broadcast must never break the job */ }
          },
        });

        const { text, stopped, visionOff, mode: ranMode } = turnResult;

        // Mirror CLI post-turn persistence exactly
        a.persistTurn(history, message, turnResult, turnNo);
        a.saveHistory(history, 2 * ((cfg.seats && cfg.seats.orchestrator && cfg.seats.orchestrator.historyMessages) || 3));
        a.saveState(state);

        // mode: what this turn ran as (the UI marks Auto replies); stopped / visionOff only when set.
        broadcast({ kind: 'reply', text, mode: ranMode || (body && body.mode) || 'ask',
          ...(stopped ? { stopped } : {}), ...(visionOff ? { visionOff: true } : {}),
          ...(turnResult.context ? { context: turnResult.context } : {}) });
      } catch (err) {
        broadcast({ kind: 'error', message: String(err.message || err) });
      } finally {
        lock.release();
      }
    })();

    return;
  }

  // ── POST /chat/reset (LC2d T8-14 "New chat") ────────────────────────────────
  // Empties the in-memory history AND session/history.json (the same writer a turn uses), then tells every open page (laptop + paired phone) to clear its chat view.
  // Refused while a turn, a deferred generation or a background job runs. Checkpoints, scene, storyboards are not touched. Same doors as /chat and /rewind.
  if (method === 'POST' && urlPath === '/chat/reset') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    if (deferredInFlight || jobs.isRunning()) {
      sendJSON(res, 409, { error: 'A background generation is running - New chat is blocked until it finishes.' });
      return;
    }
    if (!lock.tryAcquire('a new chat')) { sendJSON(res, 409, { error: 'Phoenix is busy with a turn - New chat is blocked until it finishes.' }); return; }
    try {
      // D2: the empty history goes to disk FIRST; memory changes (and the pages are told) only after that succeeded - a failure leaves memory, file and views as they were
      const cfgR = a.loadConfig();
      a.saveHistory([], 2 * ((cfgR.seats && cfgR.seats.orchestrator && cfgR.seats.orchestrator.historyMessages) || 3));
      cfg = cfgR;
      history = [];
    } catch (e) {
      lock.release();
      sendJSON(res, 500, { error: 'Could not clear the saved chat: ' + String((e && e.message) || e) });
      return;
    }
    lock.release();
    broadcast({ kind: 'chatreset' });
    sendJSON(res, 200, { ok: true });
    return;
  }

  // ── POST /action ───────────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/action') {
    // D2 (M9 Amendment 1): a state-changing route must not be drivable from another site's page (CSRF). The Phoenix UI is same-origin.
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { action, input } = body || {};
    // F2.6: the page's request id travels back on every reply/error of this route (a malformed id is dropped)
    const rid = body && typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.requestId) ? body.requestId : null;
    const answer = (o) => broadcast(rid ? Object.assign(o, { requestId: rid }) : o);

    const ALLOWED = ['generate_image', 'i2i_edit', 'generate_from_refs', 'image_to_3d', 'import_asset', 'save_as_brush', 'use_brush', 'apply_material', 'rename_asset', 'rename_brush', 'delete_asset', 'delete_brush', 'list_materials', 'delete_material', 'make_human', 'place_human', 'animate_human', 'sequence_animations', 'save_animation', 'assign_skeleton', 'spawn_rig', 'save_clip', 'animate_clip', 'sequence_clips', 'save_mesh', 'hy_motion',
      'save_character', 'spawn_character', 'prepare_mesh', 'bind_mesh', 'inspect_render',
      // Registering a tool in assistant.js is NOT enough — the UI posts through here, and this
      // list is a second, independent gate. Missing it produced "unknown action" 400s on every
      // double-click with the brush target set to Unreal (found live 2026-07-31).
      'asset_to_unreal', 'brush_to_unreal', 'brush_preview', 'inspect_unreal',
      'unreal_to_blender', 'unreal_to_brush', 'character_to_unreal',
      'remesh_asset'];
    if (!ALLOWED.includes(action)) {
      sendJSON(res, 400, { error: 'unknown action' });
      return;
    }
    if (action === 'remesh_asset' && remote.isRemoteReq(req)) { sendJSON(res, 403, REMOTE_NO_PAID); return; }   // LC2i: Meshy costs credits

    // v1.10 I1: generate_from_refs — every reference goes through the ONE path rule (servable.js, same texts as the storyboard route)
    // BEFORE anything is accepted or locked: a bad path is a plain 400, not a BUSY/202 followed by an error event.
    if (action === 'generate_from_refs') {
      const refsIn = input && typeof input === 'object' ? input.refs : undefined;
      if (!Array.isArray(refsIn)) { sendJSON(res, 400, { error: 'refs must be a list of image paths' }); return; }
      for (const rel of refsIn) {
        const refErr = (typeof rel === 'string' && rel !== '') ? servable.servableImageError(workingDir, rel) : 'image must be a path';
        if (refErr) { sendJSON(res, 400, { error: refErr }); return; }
      }
    }

    const needsBlender = ['use_brush', 'import_asset', 'apply_material'].includes(action) || (action === 'brush_preview' && !brushBackend.brushGlbFresh(input && input.name));
    if (needsBlender) {
      if (lock.isHeld()) { sendJSON(res, 409, { error: 'busy' }); return; }
      const probe = await blenderIpc.probeBlenderIdle(a.loadConfig(), 3000);
      if (probe === 'busy') { sendJSON(res, 409, { error: 'busy' }); return; }
      if (probe !== 'reachable') {
        sendJSON(res, 202, { accepted: true });
        answer({ kind: 'reply', action, text: 'BLENDER_UNREACHABLE: Blender is not answering. Open Blender with the Phoenix add-on, or wait until it is free, then try again.' });
        return;
      }
    }

    // M9: remesh_asset is a CLOUD job (Meshy) — light: no Blender lock, no GPU, so it is neither refused because a ComfyUI job runs
    // nor blocks one. It runs detached (the click returns 202, progress + the result arrive over SSE); its own flag allows ONE at a time.
    // The jobs.js slot is deliberately NOT used: it is the single GENERATION slot and would make a remesh and a GPU job exclude each other.
    if (action === 'remesh_asset') {
      if (a.remeshBusy()) { sendJSON(res, 409, { error: 'BUSY: a remesh is already running' }); return; }
      cfg = a.loadConfig();
      sendJSON(res, 202, { accepted: true });
      (async () => {
        try {
          const inp = (input && typeof input === 'object') ? input : {};
          broadcast({ kind: 'user', text: '⏷ ' + action });
          const result = await a.TOOLS.remesh_asset(inp, state, cfg, { background: true, uiButton: true });   // progress + done reach the page through the remeshEvents listeners (every start path alike)
          answer({ kind: 'reply', action, text: typeof result === 'string' ? result : JSON.stringify(result) });
        } catch (err) {
          answer({ kind: 'error', action, message: String((err && err.message) || err) });
        }
      })();
      return;
    }

    // hy_motion and i2i_edit each spend ~3–4 minutes generating in ComfyUI and do NOT hold the
    // Blender lock for that wait — holding it would freeze Phoenix the whole time (hy_motion takes
    // the lock late for its Blender-apply; i2i never touches Blender at all). So they "defer" the
    // lock and instead guard a single-slot flag. (i2i joined this path 2026-08-06 — Q3.)
    const defersLock = (action === 'hy_motion' || action === 'i2i_edit' || action === 'generate_from_refs');   // generate_from_refs (I1): ComfyUI-only, never touches Blender
    // The heavy LOCK-BASED generations. They call freeOtherInstances() before running, which would
    // evict a deferred edit's model mid-flight — so they and the deferred ops must be mutually
    // exclusive on the single GPU. Light Blender actions (rename, material, blender_run) are NOT
    // here: they stay usable during a deferred edit, which is the whole point of deferring.
    const heavyLockBased = (action === 'generate_image' || action === 'image_to_3d');

    if (defersLock) {
      // Refuse if ANY heavy job holds the GPU: another deferred generation (deferredInFlight); a
      // DETACHED background image/mesh job (jobs.isRunning() — these release the Blender lock seconds
      // after the click but keep generating for minutes, so lock.isHeld() alone misses them); or a
      // lock-based action currently holding the lock. "Does not hold the lock" must never mean
      // "may run twice" — one heavy GPU job at a time.
      if (deferredInFlight || jobs.isRunning() || lock.isHeld()) {
        sendJSON(res, 409, busyRefusal());
        return;
      }
      deferredInFlight = true;
    } else {
      // A heavy lock-based generation must not start while a deferred edit (i2i / text→motion) holds
      // the GPU — its pre-run VRAM free would kill the running edit. Light actions skip this and stay live.
      if (heavyLockBased && deferredInFlight) {
        sendJSON(res, 409, { error: 'a background generation (i2i edit / text→motion) is using the GPU — try again when it finishes' });
        return;
      }
      if (!lock.tryAcquire(heavyLockBased ? lock.GENERATION : actionLabel(action))) {
        sendJSON(res, 409, { error: 'busy' });
        return;
      }
    }

    cfg = a.loadConfig();
    sendJSON(res, 202, { accepted: true });

    (async () => {
      try {
        const inp = (input && typeof input === 'object') ? input : {};
        if (action === 'generate_image' && !inp.description) inp.description = state.lastImageDesc;
        broadcast({ kind: 'user', text: '⏷ ' + action });
        const t0 = Date.now();
        const result = await a.TOOLS[action](inp, state, cfg, { background: true });
        a.saveState(state);
        // make_human renders a face preview to output/human-preview.png — surface it in the Human tab
        // (only if it was (re)written by THIS call, so a stale file from a failed render isn't shown).
        if (action === 'make_human') {
          try {
            const previewAbs = path.join(workingDir, 'output', 'human-preview.png');
            const st = fs.statSync(previewAbs);
            if (st.mtimeMs >= t0 - 1000) {
              broadcast({ kind: 'artifact', slot: 'human', url: '/file?p=' + encodeURIComponent('output/human-preview.png') + '&t=' + Date.now() });
            }
          } catch (_) { /* no preview file — skip */ }
        }
        // inspect_render renders the current scene to output/render-check.png — surface it in the Image tab
        // (only if (re)written by THIS call, so a stale render isn't shown).
        if (action === 'inspect_render') {
          try {
            const rcAbs = path.join(workingDir, 'output', 'render-check.png');
            const st = fs.statSync(rcAbs);
            if (st.mtimeMs >= t0 - 1000) {
              broadcast({ kind: 'artifact', slot: 'image', source: 'inspect', url: '/file?p=' + encodeURIComponent('output/render-check.png') + '&t=' + Date.now() });
            }
          } catch (_) { /* no render file — skip */ }
        }
        // inspect_unreal renders the Unreal level to output/unreal-check.png — same Image tab, same
        // freshness rule. Deliberately the identical shape to inspect_render above: a render the
        // user cannot see is a render they have to take on trust, which is the whole failure mode
        // the vision work exists to remove.
        if (action === 'inspect_unreal') {
          try {
            const uAbs = path.join(workingDir, 'output', 'unreal-check.png');
            const st = fs.statSync(uAbs);
            if (st.mtimeMs >= t0 - 1000) {
              broadcast({ kind: 'artifact', slot: 'image', source: 'inspect', url: '/file?p=' + encodeURIComponent('output/unreal-check.png') + '&t=' + Date.now() });
            }
          } catch (_) { /* vision off, or nothing written — skip */ }
        }
        // brush_preview built (or reused) the brush's GLB — put it in the mesh viewer.
        // The path is read from the tool's OWN reply rather than rebuilt from the slug here: two
        // places deriving the same filename is how they end up disagreeing after a rename.
        if (action === 'brush_preview' && typeof result === 'string') {
          const m = result.match(/^PREVIEW_READY\s+(\S+)/);
          if (m) {
            broadcast({ kind: 'artifact', slot: 'mesh', url: '/file?p=' + encodeURIComponent(m[1]) + '&t=' + Date.now(), source: 'library' });
          }
        }
        // i2i_edit returns a NEW tile image (never mutates the reference). The tool marks its output
        // with `I2I_TILE <abs-path>\t<meta-json>`; parse it, broadcast the tile to the Edit tab's
        // gallery (its OWN slot, not the main image slot — the reference must stay put), and strip the
        // marker from the chat reply so the raw path never shows up in the conversation.
        let replyText = typeof result === 'string' ? result : JSON.stringify(result);
        if (action === 'i2i_edit' && typeof result === 'string') {
          const m = result.match(/^I2I_TILE\s+(.+?)\t(.+?)(?:\n([\s\S]*))?$/);
          if (m) {
            let meta = {};
            try { meta = JSON.parse(m[2]); } catch (_) { /* meta is best-effort */ }
            const rel = path.relative(workingDir, m[1]).split(path.sep).join('/');
            broadcast({ kind: 'artifact', slot: 'i2i-tile',
              url: '/file?p=' + encodeURIComponent(rel) + '&t=' + Date.now(), meta });
            replyText = (m[3] || '').trim() || ('i2i edit done (' + (meta.workflowId || 'edit') + ').');
          }
        }
        // generate_from_refs returns a NEW image (REF_TILE <abs-path>	<meta-json>): it becomes the current image (Image tab +
        // Library refresh happen on the 'image' artifact, like any new generation) and the marker is stripped from the chat reply.
        if (action === 'generate_from_refs' && typeof result === 'string') {
          const t = a.parseRefTile(result);
          if (t) {
            const rel = path.relative(workingDir, t.abs).split(path.sep).join('/');
            a.applyRefTile(state, t);   // lastImage, lastImageCategory (from the request when given), description from the prompt
            a.saveState(state);
            broadcast({ kind: 'artifact', slot: 'image', url: '/file?p=' + encodeURIComponent(rel) + '&t=' + Date.now(), meta: t.meta });
            replyText = t.tail || ('Reference image done (' + (t.meta.workflowId || 'image') + ').');
          }
        }
        // The action name travels with the reply so the UI can react to WHAT finished instead of
        // sniffing the reply text. Text sniffing misfires on chat turns that happen to echo the
        // same wording, and it silently rots the moment a message is reworded.
        answer({ kind: 'reply', action, text: replyText });
      } catch (err) {
        answer({ kind: 'error', action, message: String(err.message || err) });
      } finally {
        if (!defersLock) lock.release();
        else deferredInFlight = false;
      }
    })();

    return;
  }

  // ── GET /animations ────────────────────────────────────────────────────────
  // List the FBX animation files available for animate_human (Human tab dropdown).
  if (method === 'GET' && urlPath === '/animations') {
    sendJSON(res, 200, { animations: animLib.listAnimations() });
    return;
  }

  // ── GET /custom-rigs ───────────────────────────────────────────────────────
  // List the custom-rig folders + their state (skeleton assigned? variants? clips?).
  if (method === 'GET' && urlPath === '/custom-rigs') {
    sendJSON(res, 200, { folders: customRig.listFolders() });
    return;
  }

  // ── POST /custom-rig-create  {name} ────────────────────────────────────────
  // Create a new (locked, skeleton-less) folder. Pure filesystem — no Blender, no lock.
  if (method === 'POST' && urlPath === '/custom-rig-create') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = customRig.createFolder(body && body.name);
    if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
    sendJSON(res, 200, { ok: true, folder: r.folder, folders: customRig.listFolders() });
    return;
  }

  // ── POST /custom-rig-rename  {from, to} ────────────────────────────────────
  if (method === 'POST' && urlPath === '/custom-rig-rename') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = customRig.renameFolder(body && body.from, body && body.to);
    if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
    sendJSON(res, 200, { ok: true, folder: r.folder, folders: customRig.listFolders() });
    return;
  }

  // ── POST /custom-rig-delete  {name} ────────────────────────────────────────
  if (method === 'POST' && urlPath === '/custom-rig-delete') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = customRig.deleteFolder(body && body.name);
    if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
    sendJSON(res, 200, { ok: true, id: r.id, folders: customRig.listFolders() });
    return;
  }

  // <r1-shell> status bar: the provider list, one read round, and the user's layout (cfg.ui.statusBar is its one home)
  if (method === 'GET' && urlPath === '/status/items') { sendJSON(res, 200, statusService.items()); return; }
  if (method === 'GET' && urlPath === '/version') { sendJSON(res, 200, { version: require('./version'), boot: BOOT_ID }); return; }   // F6.8
  if (method === 'GET' && urlPath === '/status') { sendJSON(res, 200, await statusService.readAll()); return; }
  if (method === 'POST' && urlPath === '/status/layout') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    const layout = statusBar.validateLayout(body);
    if (!layout) { sendJSON(res, 400, { error: 'The layout needs { order: [ids], hidden: [ids] } - arrays of up to 64 strings.' }); return; }
    const fresh = a.loadConfig();
    fresh.ui = Object.assign({}, (fresh.ui && typeof fresh.ui === 'object') ? fresh.ui : {}, { statusBar: layout });
    a.saveConfig(fresh);
    sendJSON(res, 200, { ok: true, statusBar: layout });
    return;
  }
  // </r1-shell>
  // <t1-themes> the chosen theme lives in the config (cfg.ui.theme) so every browser and the phone show the same
  if (method === 'POST' && urlPath === '/ui/theme') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    const theme = body && typeof body === 'object' ? body.theme : null;
    if (typeof theme !== 'string' || !/^[a-z0-9-]{1,32}$/.test(theme)) { sendJSON(res, 400, { error: 'The theme must be a name of 1-32 lowercase letters, digits or dashes.' }); return; }
    const fresh = a.loadConfig();
    fresh.ui = Object.assign({}, (fresh.ui && typeof fresh.ui === 'object') ? fresh.ui : {}, { theme });
    a.saveConfig(fresh);
    sendJSON(res, 200, { ok: true, theme });
    return;
  }
  // </t1-themes>

  // GET /unreal-state — the header indicator's one call. Cached server-side;
  // see unrealState() for why the client is allowed to be lazy about polling.
  if (method === 'GET' && urlPath === '/unreal-state') {
    sendJSON(res, 200, await unrealState());
    return;
  }

  // ── Voice tab ──────────────────────────────────────────────────────────────
  // Speaking runs on whatever machine has the GPU: CrispASR's OpenAI-compatible
  // speech server, addressed through voice.api in the config. Same shape as hyMotion —
  // nothing here assumes it is local.

  // GET /voice-state — everything the tab needs to draw itself in one round trip.
  if (method === 'GET' && urlPath === '/voice-state') {
    const [h, v] = await Promise.all([voice.health(), voice.listVoices()]);
    sbVoiceSeen.names = (v && Array.isArray(v.voices)) ? new Set(v.voices.map(x => x && x.name)) : null;   // <sb3> the storyboard view's cast availability
    sendJSON(res, 200, {
      health: h,
      voices: (v && v.voices) || [],
      voicesError: (v && v.error) || null,
      effects: voice.listEffects(),   // R5b: the full objects (id, label, group, description, parameter) for the one effect rack
      engines: voice.listVoice(),
      watermark: voice.cfg().watermark !== false,
      takes: voice.listTakes(40),
      // VO1: local-dispatcher status line + the reference WAVs in sounds/refs/ (Chatterbox).
      dispatcher: voice.dispatcherStatus(),
      consent: voice.cfg().consentAck === true,   // VO1b: the one-time cloning consent (Settings -> Voice engines)
      refs: voice.listRefs(),
    });
    return;
  }

  // VO1 — the local voice dispatcher (voice.dispatcher = { local: true }). GET = status + last log lines;
  // restart / stop are local-mode only (400 otherwise: in rig mode Phoenix owns no process).
  if (method === 'GET' && urlPath === '/voice/dispatcher') {
    sendJSON(res, 200, voice.dispatcherStatus());
    return;
  }
  if (method === 'POST' && (urlPath === '/voice/dispatcher/restart' || urlPath === '/voice/dispatcher/stop')) {
    const r = urlPath.endsWith('/restart') ? await voice.dispatcherRestart() : await voice.dispatcherStop();
    if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
    sendJSON(res, 200, r);
    return;
  }

  // POST /voice-refs-open — show sounds/refs/ (the reference voices) in the OS file browser.
  if (method === 'POST' && urlPath === '/voice-refs-open') {
    sendJSON(res, 200, voice.openRefsFolder());
    return;
  }

  // POST /voice-speak {voice, text, effect, strength}
  if (method === 'POST' && urlPath === '/voice-speak') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    // #9 — a null / non-object JSON body (valid JSON like `null`, `42` or `"x"`) must be a clean 400,
    // not a 500: voice.speak destructures its argument, and destructuring `null` throws a TypeError.
    if (body === null || typeof body !== 'object') {
      sendJSON(res, 400, { error: 'body must be a JSON object with at least { voice, text }' });
      return;
    }
    const r = await voice.speak(body);
    if (r.error && !r.ok) { sendJSON(res, r.consentRequired ? 409 : 400, r); return; }
    sendJSON(res, 200, r);
    return;
  }

  // POST /voice-open — show the takes folder in the OS file browser.
  if (method === 'POST' && urlPath === '/voice-open') {
    sendJSON(res, 200, voice.openFolder());
    return;
  }

  // GET /vo/<file>.wav — play back a produced take.
  if (method === 'GET' && urlPath.startsWith('/vo/')) {
    const f = voice.readOut(decodeURIComponent(urlPath.slice(4)));
    if (!f) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': f.buf.length });
    res.end(f.buf);
    return;
  }

  // ── SFX tab — the clip workbench ───────────────────────────────────────────
  // Three sources (generate SFX · generate VO · load a clip), edit at two depths,
  // two exits (character .gguf · soundclip). Generation runs on the GPU machine;
  // editing runs here because ffmpeg is here. See sfx.js for the why.

  // GET /sfx-state — everything the tab needs to draw itself in one round trip.
  if (method === 'GET' && urlPath === '/sfx-state') {
    sendJSON(res, 200, await sfx.state());
    return;
  }

  // POST /sfx-cast {instruction, text, n, advanced} — VO candidates
  if (method === 'POST' && urlPath === '/sfx-cast') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = await sfx.castStart(body);
    sendJSON(res, r.error ? 400 : 200, r);
    return;
  }

  // POST /sfx-generate {prompt, seconds, n, seed, advanced} — SFX candidates
  if (method === 'POST' && urlPath === '/sfx-generate') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = await sfx.sfxStart(body);
    sendJSON(res, r.error ? 400 : 200, r);
    return;
  }

  // GET /sfx-job?id=… — poll. On completion the takes are pulled here once.
  if (method === 'GET' && urlPath === '/sfx-job') {
    const r = await sfx.jobStatus(parsedUrl.searchParams.get('id'));
    sendJSON(res, r.error ? 400 : 200, r);
    return;
  }

  // POST /sfx-adopt {take, kind, text} — put a candidate on the bench
  if (method === 'POST' && urlPath === '/sfx-adopt') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = (body && body.library && typeof body.library === 'object') ? sfx.adoptLibrary(body.library.dir, body.library.file) : sfx.adopt(body);   // M1.3: { library: { dir, file } } = a clip of the Library
    sendJSON(res, r.error ? 400 : 200, r);
    return;
  }

  // POST /sfx-clear — M1.3: Remove on the bench tile (the global guard refuses cross-site posts like every POST)
  if (method === 'POST' && urlPath === '/sfx-clear') {
    sendJSON(res, 200, sfx.clearBench());
    return;
  }

  // POST /sfx-load {path} — the third source: an existing clip from disk
  if (method === 'POST' && urlPath === '/sfx-load') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = await sfx.loadFile(body.path);
    sendJSON(res, r.error ? 400 : 200, r);
    return;
  }

  // POST /sfx-render {effect,strength} | {advanced,order} — re-render from source
  if (method === 'POST' && urlPath === '/sfx-render') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = await sfx.render(body);
    sendJSON(res, (r.error && !r.bench) ? 400 : 200, r);
    return;
  }

  // POST /sfx-save-clip {name} — exit 1: this is a line/sound, done
  if (method === 'POST' && urlPath === '/sfx-save-clip') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = sfx.saveClip(body.name);
    sendJSON(res, r.error ? 400 : 200, r);
    return;
  }

  // POST /sfx-save-character {name, transcript, iHaveRights, overwrite} — exit 2
  if (method === 'POST' && urlPath === '/sfx-save-character') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = await sfx.saveCharacter(body);
    sendJSON(res, r.error ? 400 : 200, r);
    return;
  }

  // POST /sfx-open {which} — show a folder in the OS file browser
  if (method === 'POST' && urlPath === '/sfx-open') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    sendJSON(res, 200, sfx.openFolder(body.which));
    return;
  }

  // GET /sfx-bench.wav — what is currently on the bench (preview, else source)
  if (method === 'GET' && urlPath === '/sfx-bench.wav') {
    const buf = sfx.readBenchAudio();
    if (!buf) { res.writeHead(404); res.end('nothing on the bench'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length,
                         'Cache-Control': 'no-store' });
    res.end(buf);
    return;
  }

  // GET /sfx-file/<take>.wav — a generated candidate
  if (method === 'GET' && urlPath.startsWith('/sfx-file/')) {
    const buf = sfx.readTake(decodeURIComponent(urlPath.slice(10)));
    if (!buf) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }

  // GET /sfx-clip/<file>.wav — a saved soundclip
  if (method === 'GET' && urlPath.startsWith('/sfx-clip/')) {
    const buf = sfx.readClip(decodeURIComponent(urlPath.slice(10)));
    if (!buf) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }

  // ── GET /characters ────────────────────────────────────────────────────────
  // List the saved (Mixamo-rigged) characters for the Human tab's Character dropdown.
  // They share the animations/ library — there is nothing per-character to list here.
  // R5a: every character carries posterStamp (its preview key when the GLB export is fresh, else null) and previewError (a failed export).
  if (method === 'GET' && urlPath === '/characters') {
    const st = characterPreviews.status();
    sendJSON(res, 200, {
      characters: characters.listCharacters().map(c => ({ ...c, posterStamp: characterPreviews.glbFresh(c.name) ? characterPreviews.characterKey(c.name) : null, previewError: st.failed[c.name] || null })),
      previews: st,
    });
    return;
  }

  // ── POST /characters/previews  {retry?} — (re)start the preview export queue ──
  if (method === 'POST' && urlPath === '/characters/previews') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    if (body && body.retry) characterPreviews.retry(body.retry); else characterPreviews.kick('section');
    sendJSON(res, 200, { ok: true, previews: characterPreviews.status() });
    return;
  }

  // ── GET /characters/preview-glb?name=<name> — the fresh preview GLB the poster is rendered from ──
  if (method === 'GET' && urlPath === '/characters/preview-glb') {
    const cn = parsedUrl.searchParams.get('name') || '';
    let data = null;
    try {
      if (cn && cn === characters.safeCharName(cn) && characterPreviews.glbFresh(cn)) data = fs.readFileSync(libraryTrash.guarded(characterPreviews.previewDir(), cn + '.glb'));
    } catch (_) { data = null; }
    if (!data) { sendJSON(res, 404, { error: 'No fresh preview for that character' }); return; }
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-cache' });
    res.end(data);
    return;
  }

  // ── POST /character-rename  {from, to} ─────────────────────────────────────
  // Pure filesystem (rename the .blend + sidecar) — no Blender, no lock, like the
  // custom-rig folder routes.
  if (method === 'POST' && urlPath === '/character-rename') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = characters.renameCharacter(body && body.from, body && body.to);
    if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
    sendJSON(res, 200, { ok: true, character: r.character, characters: characters.listCharacters(), ...(r.warning ? { warning: r.warning } : {}) });
    return;
  }

  // ── POST /character-delete  {name} ─────────────────────────────────────────
  if (method === 'POST' && urlPath === '/character-delete') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = characters.deleteCharacter(body && body.name);
    if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
    sendJSON(res, 200, { ok: true, id: r.id, characters: characters.listCharacters() });
    return;
  }

  // ── POST /upload-animation?name=foo.fbx ────────────────────────────────────
  // Drop a Mixamo FBX into the animations/ folder from the Human tab.
  if (method === 'POST' && urlPath === '/upload-animation') {
    const name = parsedUrl.searchParams.get('name');
    if (!name) {
      sendJSON(res, 400, { error: 'name query param required' });
      return;
    }
    const safe = path.basename(name).replace(/[^a-zA-Z0-9._ -]/g, '_');
    if (path.extname(safe).toLowerCase() !== '.fbx') {
      sendJSON(res, 400, { error: 'only .fbx files' });
      return;
    }
    try {
      const buf = await readRawBody(req);
      if (buf.length === 0) {
        sendJSON(res, 400, { error: 'empty upload' });
        return;
      }
      if (buf.length > 100 * 1024 * 1024) {
        sendJSON(res, 413, { error: 'file too large (max 100MB)' });
        return;
      }
      const dir = animLib.ensureAnimDir();
      fs.writeFileSync(path.join(dir, safe), buf);
      // An upload replacing a previously generated clip must not inherit its HY sidecar: that
      // marker tells animate_human to "fix" HY conventions, which on a normal Mixamo FBX means
      // laying the character on its back and dividing the hip translation by 100.
      try { fs.unlinkSync(path.join(dir, safe + '.hy.json')); } catch (_) { /* none — fine */ }
      broadcast({ kind: 'reply', text: 'Added animation: ' + safe + ' — pick it in Characters ▸ MakeHuman and press Animate.' });
      sendJSON(res, 200, { ok: true, name: safe, animations: animLib.listAnimations() });
    } catch (e) {
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }

  // ── POST /upload ───────────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/upload') {
    const name = parsedUrl.searchParams.get('name');
    const cat  = parsedUrl.searchParams.get('cat');

    if (!name) {
      sendJSON(res, 400, { error: 'name query param required' });
      return;
    }

    const safe = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext  = path.extname(safe).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      sendJSON(res, 400, { error: 'unsupported image type' });
      return;
    }

    try {
      const buf = await readRawBody(req, 50 * 1024 * 1024);

      if (buf.length === 0) {
        sendJSON(res, 400, { error: 'empty upload' });
        return;
      }
      if (buf.length > 50 * 1024 * 1024) {
        sendJSON(res, 413, { error: 'file too large (max 50MB)' });
        return;
      }

      const uploadsDir = path.join(workingDir, 'output', 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      // exclusive create: the same name in the same millisecond must never overwrite an earlier upload
      let finalName = null, absPath = null;
      for (let k = 0; k < 20; k++) {
        finalName = Date.now() + '_' + (k ? require('crypto').randomBytes(3).toString('hex') + '_' : '') + safe;
        absPath   = path.join(uploadsDir, finalName);
        try { fs.writeFileSync(absPath, buf, { flag: 'wx' }); break; }
        catch (e) { if (!e || e.code !== 'EEXIST' || k === 19) throw e; }
      }

      const rel = 'output/uploads/' + finalName;
      const url = '/file?p=' + encodeURIComponent(rel);

      // <l1-library> every successful upload is recorded, so the Library's Image tab lists it under "imported"
      records.appendRecord({ kind: 'upload', path: rel, workflow: null, prompt: null, seed: null, parent: null, category: 'imported' });

      // <l1-library> add=1 (Library "+ Add" / drop): store + record only - the current image, the artifact and the chat stay untouched
      if (parsedUrl.searchParams.get('add') !== '1') {
        state.lastImage         = absPath;
        state.lastImageCategory = (cat && typeof cat === 'string') ? cat : 'item';
        state.lastImageDesc     = path.basename(finalName, ext);
        a.saveState(state);

        broadcast({ kind: 'artifact', slot: 'image', url, source: 'upload' });
        broadcast({ kind: 'reply', text: 'Loaded image: ' + finalName + ' — it is in the Image tab. Click "Make 3D" to convert it (set a face count first if you like).' });
      }

      sendJSON(res, 200, { ok: true, url, path: rel });
    } catch (e) {
      if (e && e.tooLarge) { res.once('finish', () => { try { req.destroy(); } catch (_) { /* gone */ } }); sendJSON(res, 413, { error: 'file too large (max 50MB)' }); return; }
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }

  // ── F2.9 cached previews: orphaned poster JPEGs + preview GLBs (Settings > Storage) ────────────────────────
  if (method === 'GET' && urlPath === '/storage/caches') {
    try { const s = require('./cache-clean').scan(); sendJSON(res, 200, { ok: true, count: s.count, bytes: s.bytes }); }
    catch (e) { sendJSON(res, 500, { ok: false, error: String((e && e.message) || e) }); }
    return;
  }
  if (method === 'POST' && urlPath === '/storage/caches/clean') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    if (brushPreviews.status().running || characterPreviews.status().running) { sendJSON(res, 409, { ok: false, error: 'A preview export is running — try again when it has finished.' }); return; }
    try { const r = require('./cache-clean').clean(); sendJSON(res, 200, { ok: true, removed: r.removed, freed: r.freed, failed: r.failed }); }
    catch (e) { sendJSON(res, 500, { ok: false, error: String((e && e.message) || e) }); }
    return;
  }

  // ── GET /checkpoints (v1.9 M5) ───────────────────────────────────────────
  // The list for the Checkpoints panel. `current` marks the copy Blender has open right now (one short IPC
  // read, 500 ms bound). When Blender does not answer in time the LAST KNOWN value is kept and the reply says stale:true.
  // Blender's filepath is read ONLY while the chat lock is free (a turn / rewind owns the IPC channel meanwhile); when
  // busy, the last known state is returned with stale:true. Same localhost / cross-site rule as /rewind.
  if (method === 'GET' && urlPath === '/checkpoints') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    const fresh = a.loadConfig();
    const s = checkpoints.settings(fresh);
    let stale = true;
    // Sweep 3 H: while a recent probe found Blender silent, do not take the chat lock for another 500 ms on every refresh (a send right after a
    // reply would meet 409) - the last known value is returned until the quiet period is over.
    const cpQuiet = (Date.now() - lastCpProbeFailAt) < 15000;
    if (!cpQuiet && !blenderIpc.queueBusy(fresh) && lock.tryAcquire('a checkpoint check')) {
      // 500 ms bound: the lock is held only that long when Blender is down (a send / Rewind right after a reply must
      // not meet 409). No answer in time → the last known value, stale:true.
      try {
        const t0cp = Date.now();
        const fp = await checkpoints.currentFilepath({ timeoutMs: 500, cfg: fresh });
        // only a probe that really HELD the lock for a while (Blender silent) starts the quiet period; an immediate failure does not
        if (fp !== null) { lastCpFilepath = fp; stale = false; lastCpProbeFailAt = 0; } else if (Date.now() - t0cp >= 400) lastCpProbeFailAt = Date.now();
      }
      catch (_) { /* Blender not reachable: keep the last known value */ }
      finally { lock.release(); }
    }
    const cur = lastCpFilepath;
    const items = checkpoints.list({ currentPath: cur });
    sendJSON(res, 200, { enabled: s.enabled, keep: s.keep, maxGB: s.maxGB, usedBytes: checkpoints.usedBytes(),
      inCopy: !!(cur && checkpoints.insideDir(cur)), ...(stale ? { stale: true } : {}), items });
    return;
  }

  // ── POST /rewind (v1.9 M5) ───────────────────────────────────────────────
  // Body: { id, choice: 'stay' | 'overwrite' }. USER-ONLY and localhost-only (same rule as /secrets); takes the chat lock
  // like a turn does, and is refused while a deferred generation or a background job is running.
  if (method === 'POST' && urlPath === '/rewind') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    if (deferredInFlight || jobs.isRunning()) {
      sendJSON(res, 409, { error: 'a background generation is running — rewind is blocked until it finishes' });
      return;
    }
    if (!lock.tryAcquire('a rewind')) { sendJSON(res, 409, { error: 'busy' }); return; }
    let r;
    try {
      cfg = a.loadConfig();
      r = await checkpoints.rewind(body && body.id, body && body.choice, {
        cfg, turn: state.turnSeq,
        loadHistory: () => history,
        saveHistory: (h) => { history = h; a.saveHistory(h, 2 * ((cfg.seats && cfg.seats.orchestrator && cfg.seats.orchestrator.historyMessages) || 3)); },
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e) };
    } finally {
      lock.release();
    }
    // The scene can be rewound even when the overwrite was refused: the chat view must reload in that case too.
    if ((r.ok || r.rewound) && !r.noop) broadcast({ kind: 'rewound', id: body && body.id, choice: r.choice, openedPath: r.openedPath, history: r.history });
    if (!r.ok) { sendJSON(res, 400, { error: r.error, ...(r.rewound ? { rewound: true } : {}) }); return; }
    sendJSON(res, 200, { ok: true, openedPath: r.openedPath, choice: r.choice, ...(r.note ? { note: r.note } : {}) });
    return;
  }

  // ── GET /config ──────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/config') {
    const fresh = a.loadConfig();
    const orch = (fresh.seats && fresh.seats.orchestrator) || {};
    const meta = (fresh.seats && fresh.seats.metaprompter) || {};
    sendJSON(res, 200, {
      gates: Object.assign({}, (fresh && fresh.gates) || {}, { mode: a.runConfig(fresh).mode }),
      orchestrator: { model: orch.model || 'claude-sonnet-4-6', historyMessages: orch.historyMessages || 3, stepTimeoutS: a.stepTimeoutMs(fresh) / 1000,
        maxToolCalls: a.runConfig(fresh, 'ask').budget, maxToolCallsAuto: a.runConfig(fresh, 'auto').budget },
      metaprompter: { model: meta.model || '', ejectAfterUse: !!meta.ejectAfterUse },
      checkpoints: checkpoints.settings(fresh),
      mcp: mcpFlagsView(fresh),
      remesh: remeshView(fresh),   // M9: never the key, never the base URL
      video: videoView(fresh),     // V3: fal.ai video opt-in + "key present"; never the key
      voice: voice.settingsView(fresh),   // VO1b: Settings -> Voice engines (local engines, install folder, free space, watermark, consent)
      mcpScript: path.join(workingDir, 'phoenix-mcp.js'),   // absolute path for the Settings setup lines
      endpoints: { local: (fresh.endpoints && fresh.endpoints.local) || '', comfyui: (fresh.endpoints && fresh.endpoints.comfyui) || '' },
      seats: seatsView(fresh),
      endpointNames: endpointNamesOf(fresh),
      keys: providers.listKeys(),   // booleans only — a key value never leaves the server
      ui: { statusBar: (fresh.ui && fresh.ui.statusBar) || null, theme: (fresh.ui && typeof fresh.ui.theme === 'string') ? fresh.ui.theme : null },   // <r1-shell> the saved status bar layout
      apps: { blender: (fresh.apps && fresh.apps.blender) || '', comfyOutput: (fresh.apps && fresh.apps.comfyOutput) || '' },
      feedback: { endpointUrl: (fresh.feedback && fresh.feedback.endpointUrl) || '' },
      // Defaults land HERE, not in the browser: the double-click handler reads brushTarget on
      // every use, and a client-side fallback would silently disagree with what was saved.
      unreal: {
        brushTarget:  (fresh.unreal && fresh.unreal.brushTarget)  || 'blender',
        visionMode:   (fresh.unreal && fresh.unreal.visionMode)   || 'camera',
        visionWidth:  (fresh.unreal && fresh.unreal.visionWidth)  || 1280,
        visionHeight: (fresh.unreal && fresh.unreal.visionHeight) || 720,
      },
    });
    return;
  }

  if (method === 'POST' && urlPath === '/brushes/previews') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    if (body.retry) brushPreviews.retry(body.retry); else brushPreviews.kick('section'); sendJSON(res, 200, { ok: true, previews: brushPreviews.status() }); return;
  }
  if (urlPath === '/levels' || urlPath.startsWith('/levels/')) {
    const L = require('./levels'), fresh = a.loadConfig();
    const reply = (status, value, headers) => sendJSON(res,status,value,headers);
    const busy = () => reply(409,{ok:false,code:'BUSY',error:'Busy — another action is running'});
    const unreachable = () => reply(503,{ok:false,code:'BLENDER_UNREACHABLE',error:'BLENDER_UNREACHABLE: Blender is not answering. Open Blender with the Phoenix add-on, or wait until it is free, then try again.'});
    if (method === 'GET' && urlPath === '/levels') {
      // R4d3 P1: a level whose level.blend is newer than poster.jpg queues ONE poster render (debounced, never while it is open + dirty in Blender)
      const isOpenDirty = async (file) => {
        // true = open + dirty; false = known clean (the ONLY answer that allows a render); null = unknown (lock held, busy, unreachable, no state)
        // r5: holds NOTHING. The Blender IPC is one FIFO queue per directory, so a foreground action that starts meanwhile queues behind this query.
        if (lock.isHeld()) return null;
        const reach = await require('./blender-ipc').probeBlenderIdle(fresh,3000);
        if (reach === 'busy') return null;
        if (reach !== 'reachable') { const running = await L.blenderRunning(fresh); return running === false ? false : null; }   // Blender closed: nothing to protect, render
        if (lock.isHeld()) return null;
        const open = await L.readOpen({cfg:fresh,background:true});
        if (!open) return null;
        return !!(open.dirty && open.filepath && path.resolve(open.filepath).toLowerCase() === path.resolve(file).toLowerCase());
      };
      try { L.autoPoster(fresh,{isOpenDirty,onDone:(s,r) => broadcast({kind:'level-poster',level:s,...r})}); } catch (_) {}
      reply(200,{levels:L.list(fresh)},{'Cache-Control':'no-store'}); return;
    }
    if (method === 'GET' && urlPath === '/levels/poster') {
      try { const slug = parsedUrl.searchParams.get('level'); if (!L.slugOk(slug)) throw new Error('Invalid level'); const file = libraryTrash.guarded(L.root(fresh),slug + '/poster.jpg'); const bytes = fs.readFileSync(file); res.writeHead(200,{'Content-Type':'image/jpeg'}); res.end(bytes); } catch (_) { reply(404,{error:'Poster not found'}); } return;
    }
    if (method === 'GET' && urlPath === '/levels/open') {
      if (lock.isHeld()) { reply(200,{open:lastLevelsOpen,reachable:true,busy:true}); return; }
      const reach = await require('./blender-ipc').probeBlenderIdle(fresh,3000);
      if (reach === 'busy') reply(200,{open:lastLevelsOpen,reachable:true,busy:true});
      else if (reach !== 'reachable') reply(200,{open:null,reachable:false,reason:reach});
      else { lastLevelsOpen = await L.readOpen({cfg:fresh}); reply(200,{open:lastLevelsOpen,reachable:true}); } return;
    }
    if (method === 'POST') {
      if (!isLocalRequest(req)) { reply(403,{error:'Cross-site request refused.'}); return; }
      let body; try { body = JSON.parse(await readBody(req)); } catch (_) { reply(400,{ok:false,code:'NAME',error:'Invalid request.'}); return; }
      if (body.choice !== undefined && !['save','discard'].includes(body.choice)) { reply(400,{ok:false,code:'NAME',error:'Invalid open choice.'}); return; }
      const action = urlPath.slice(8), slug = body.level, scene = body.scene;
      if (action === 'orphan') {
        if (!['reattach','keep','delete'].includes(body.pick)) { reply(400,{ok:false,code:'CHOICE',error:'Choose an animation action.'}); return; }
        if (!L.slugOk(scene) || typeof body.action !== 'string' || !body.action.trim() || body.action.length > 256 || (body.pick === 'reattach' && (typeof body.object !== 'string' || !body.object.trim()))) { reply(400,{ok:false,code:'NAME',error:'Choose a scene, animation and target object.'}); return; }
      }
      let file, nameSlug;
      try {
        if (action === 'stage') { if (!L.excludeMap(body.stage)) { reply(400,{ok:false,code:'STAGE',error:'Unknown stage.'}); return; } }
        else if (action === 'new') {
          nameSlug = L.slugify(body.name); if (!L.slugOk(nameSlug)) { reply(400,{ok:false,code:'NAME',error:'Enter a level name.'}); return; }
          if (fs.existsSync(libraryTrash.guarded(L.root(fresh),nameSlug))) { reply(409,{ok:false,code:'EXISTS',error:'That level already exists.'}); return; }
        } else {
          if (!L.slugOk(slug) || (scene !== undefined && !L.slugOk(scene))) { reply(400,{ok:false,code:'NAME',error:'Invalid level or scene name.'}); return; }
          file = libraryTrash.guarded(L.root(fresh),slug + (scene ? '/scenes/' + scene + '.blend' : '/level.blend'));
          if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) { reply(404,{ok:false,error:'Level or scene not found.'}); return; }
          if (action === 'scenes/new') { nameSlug = L.slugify(body.name); if (!L.slugOk(nameSlug)) { reply(400,{ok:false,code:'NAME',error:'Enter a scene name.'}); return; } if (fs.existsSync(libraryTrash.guarded(L.root(fresh),slug + '/scenes/' + nameSlug + '.blend'))) { reply(409,{ok:false,code:'EXISTS',error:'That scene already exists.'}); return; } }
        }
      } catch(e) { reply(404,{ok:false,error:e.message}); return; }
      if (action === 'trash' && !scene && L.posterBusy(slug)) { reply(409,{ok:false,code:'POSTER_BUSY',error:'The poster of this level is still rendering — try again in a moment.'}); return; }
      if (lock.isHeld()) { busy(); return; }
      const reach = await require('./blender-ipc').probeBlenderIdle(fresh,3000);
      if (reach === 'busy' && action !== 'trash') { busy(); return; }
      if (action !== 'trash' && reach !== 'reachable') { unreachable(); return; }
      if (!lock.tryAcquire('a level change')) { busy(); return; }
      try {
        if (action === 'trash' && !scene && L.posterBusy(slug)) { reply(409,{ok:false,code:'POSTER_BUSY',error:'The poster of this level is still rendering — try again in a moment.'}); return; }
        if (action === 'trash') {
          const op = reach === 'reachable' ? await L.readOpen({cfg:fresh}) : null;
          if (!op && body.force !== true) { reply(409,{ok:false,code:'OPEN_UNKNOWN',error:"Blender isn't answering — if this level is open there, close it first."}); return; }
          const opts = {cfg:fresh,openPath:op && op.filepath}; const r = scene ? libraryTrash.trashScene(slug,scene,opts) : libraryTrash.trashLevel(slug,opts); reply(r.ok ? 200 : r.open ? 409 : 404,r); return;
        }
        if (action === 'stage') { const r = await L.setStage(body.stage,{cfg:fresh}); if (r.open) lastLevelsOpen = r.open; reply(r.ok ? 200 : 409,{...r,...(r.converted ? {note:[L.CONVERT_NOTE,...L.unmappedLines(r.unmapped || [])].join(' ')} : {})}); return; }
        const op = await L.readOpen({cfg:fresh});
        if (!op) { unreachable(); return; }
        if (action === 'orphan') {
          if (op.kind !== 'scene' || op.slug !== slug || op.scene !== scene || !op.filepath || path.resolve(op.filepath).toLowerCase() !== path.resolve(file).toLowerCase()) { reply(409,{ok:false,code:'NOT_OPEN',error:'Open this scene first.'}); return; }
          const result = await require('./blender-ipc').callBlender(L.orphanPython({choice:body.pick,action:body.action,object:body.object}),{cfg:fresh,timeoutMs:10000,readOnly:body.pick === 'keep',label:body.pick === 'reattach' ? 'reattach animation' : 'delete animation'});
          const line = String(result.stdout || '').split(/\r?\n/).find(l => l.startsWith('PHX_ORPHAN:'));
          const r = line ? JSON.parse(line.slice(11)) : {ok:false,error:result.message || 'Could not update the animation.'};
          if (!r.ok) { reply(409,{ok:false,code:'ORPHAN',error:r.error}); return; }
          lastLevelsOpen = r.open; reply(200,{ok:true,open:r.open}); return;
        }
        if (action === 'save') {
          if (!op.filepath || path.resolve(op.filepath).toLowerCase() !== path.resolve(file).toLowerCase()) { reply(409,{ok:false,code:'NOT_OPEN',error:'This level or scene is not the file open in Blender — open it first.'}); return; }
          const saved = await require('./blender-ipc').callBlender(L.savePython(file),{cfg:fresh,readOnly:true,timeoutMs:60000,label:'save'});
          if (saved.status && saved.status !== 'ok') throw new Error(saved.message || 'Blender could not save the file.');
          const stateLine = String(saved.stdout || '').split(/\r?\n/).find(l => l.startsWith('PHX_LEVEL:'));
          const state = stateLine ? JSON.parse(stateLine.slice(10)) : {}; if (state.error) throw new Error(state.error);
          if (!scene) { L.touch(slug,fresh); reply(200,{ok:true,poster:'pending'}); setImmediate(async () => { try { const poster = await L.renderPoster(slug,{cfg:fresh}); broadcast({kind:'level-poster',level:slug,...poster}); } catch(e) { broadcast({kind:'level-poster',level:slug,ok:false,error:e.message}); } }); }
          else reply(200,{ok:true,hints:L.keyHints({location:state.keyedLocation || [],scale:state.keyedScale || []})}); return;
        }
        if (!['new','scenes/new','open'].includes(action)) { reply(404,{ok:false,error:'Unknown level action.'}); return; }
        if (op.dirty && !body.choice) { reply(200,{ok:false,needsChoice:true,untitled:!op.filepath}); return; }
        if (body.choice === 'save' && !op.filepath) { reply(409,{ok:false,code:'UNTITLED',error:'This scene was never saved.'}); return; }
        let created = {slug,scene,file};
        if (action === 'new') created = await L.createLevel(body.name,{cfg:fresh});
        if (action === 'scenes/new') created = await L.createScene(slug,body.name,{cfg:fresh});
        if (created.ok === false) { reply(500,created); return; }
        const createdInfo = action === 'new' ? {created:{slug:created.slug}} : action === 'scenes/new' ? {created:{slug:created.slug,scene:created.scene}} : {};   // R4d3 P3: the file exists from here on, whatever the open does
        const opened = await L.openFile(created.file,{cfg:fresh,choice:body.choice}); if (!opened.ok) { if (opened.needsChoice) reply(200,{...opened,...(action !== 'open' ? {retry:{url:'/levels/open',body:{level:created.slug,...(created.scene ? {scene:created.scene} : {})}}} : {}),...createdInfo}); else reply(500,{...opened,...createdInfo}); return; }
        const openHints = [...L.unmappedLines(opened.unmapped || []),...L.keyHints(opened.keyed || {})];
        lastLevelsOpen = opened.open; reply(200,{ok:true,...createdInfo,slug:created.slug,...(created.scene ? {scene:created.scene} : {}),open:opened.open,...(opened.convertError ? {convertError:opened.convertError} : {}),...(opened.converted ? {note:L.CONVERT_NOTE} : {}),...(openHints.length ? {hints:openHints} : {})});
      } catch(e) { reply(500,{ok:false,error:e.message}); } finally { lock.release(); }
      return;
    }
  }

  if (method === 'GET' && urlPath === '/library/trash') { sendJSON(res, 200, { items: libraryTrash.list({cfg:a.loadConfig()}) }); return; }
  if (method === 'POST' && ['/library/trash/restore', '/library/trash/empty'].includes(urlPath)) {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch (_) {}
    if (!lock.tryAcquire('the library trash')) { sendJSON(res, 409, { ok: false, busy: true, error: 'Phoenix is busy (a save or another step is running) — try again when it finishes.' }); return; }
    let r;
    try { r = urlPath.endsWith('/restore') ? libraryTrash.restore(body.id, {cfg:a.loadConfig()}) : libraryTrash.empty({cfg:a.loadConfig()}); } finally { lock.release(); }
    sendJSON(res, r.ok ? 200 : r.clash ? 409 : 404, r); return;
  }
  // R5b: the Audio takes desk moves sounds/vo + sounds/sfx files into the Library trash (kind `sound`; restore = /library/trash/restore)
  if (method === 'POST' && urlPath === '/library/trash/sound') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch (_) {}
    if (!lock.tryAcquire('the library trash')) { sendJSON(res, 409, { ok: false, busy: true, error: 'Phoenix is busy (a save or another step is running) — try again when it finishes.' }); return; }
    let r;
    try { r = libraryTrash.trashSounds(body && body.files); } finally { lock.release(); }
    sendJSON(res, r.ok ? 200 : 400, r); return;
  }
  // R5b/F4: which storyboards use these takes / clips (the desk's delete confirm warns with it; read-only)
  if (method === 'POST' && urlPath === '/library/sound-users') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch (_) {}
    let users = []; try { users = storyboard.usersOfSound(body && body.files); } catch (_) { users = []; }
    sendJSON(res, 200, { ok: true, users }); return;
  }
  if ((method === 'GET' && urlPath === '/poster') || (method === 'POST' && urlPath === '/posters')) {
    if (method === 'POST' && !isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    const q = new URL(req.url, 'http://localhost').searchParams, key = q.get('key'), stamp = q.get('stamp');
    let current = null;
    if (key && key.startsWith('asset:')) {
      const hit = a.listStagedFiles().find(f => 'asset:' + f.category + '/' + f.name === key);
      if (hit) { try { const st = fs.statSync(hit.path); current = st.size + '-' + st.mtimeMs; } catch (_) {} }
    } else if (key && /^brush:[a-z0-9_]+$/i.test(key)) current = brushBackend.brushKey(key.slice(6));
    else if (key && key.startsWith('character:')) {
      // R5a: a character poster exists only for a FRESH preview export (a failed / stale export never gets a poster)
      const cn = key.slice(10), abs = cn && cn === characters.safeCharName(cn) ? characters.charPath(cn) : null;
      if (abs && fs.existsSync(abs)) {
        if (!characterPreviews.glbFresh(cn)) { sendJSON(res, method === 'POST' ? 409 : 404, { error: 'No fresh preview for that character' }); return; }
        current = characterPreviews.characterKey(cn);
      }
    }
    if (!current) { sendJSON(res, 404, { error: 'Unknown library item' }); return; }
    if (stamp !== current) { sendJSON(res, method === 'POST' ? 409 : 404, { error: 'Poster stamp changed' }); return; }
    const dir = path.resolve(process.env.PHOENIX_POSTER_CACHE_DIR || path.join(__dirname, 'poster-cache'));
    let file;
    try {
      if (isLinkSync(dir)) throw new Error('Poster folder is a link');
      if (fs.existsSync(dir) && path.resolve(fs.realpathSync(dir)).toLowerCase() !== path.join(fs.realpathSync(path.dirname(dir)), path.basename(dir)).toLowerCase()) throw new Error('Poster folder resolves elsewhere');
      const name = require('crypto').createHash('sha1').update('v2|' + key + '|' + stamp).digest('hex') + '.jpg';
      file = libraryTrash.guarded(dir, name);
    } catch (_) { sendJSON(res, method === 'POST' ? 400 : 404, { error: 'Poster links are refused' }); return; }
    if (method === 'GET') {
      try { const data = fs.readFileSync(file); res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(data); } catch (_) { sendJSON(res, 404, { error: 'No poster' }); } return;
    }
    let bytes = 0, chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes <= 204800) chunks.push(chunk); }
    if (bytes > 204800) { sendJSON(res, 413, { error: 'Poster exceeds 200 KB' }); return; }
    const data = Buffer.concat(chunks);
    if (req.headers['content-type'] !== 'image/jpeg' || data.length < 3 || data[0] !== 255 || data[1] !== 216 || data[2] !== 255) { sendJSON(res, 400, { error: 'JPEG required' }); return; }
    if (data.length < 2048) { sendJSON(res, 400, { error: 'Poster looks empty' }); return; }
    try {
      fs.mkdirSync(dir, { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
      const files = fs.readdirSync(dir).filter(n => /^[a-f0-9]{40}\.jpg$/.test(n)).map(n => { const p = libraryTrash.guarded(dir, n), st = fs.statSync(p); return { p, size: st.size, time: st.mtimeMs }; }).sort((a, b) => a.time - b.time);
      let total = files.reduce((n, f) => n + f.size, 0), cap = Number(process.env.PHOENIX_POSTER_CACHE_MAX_BYTES) || 100 * 1024 * 1024;
      for (const f of files) { if (total <= cap) break; fs.unlinkSync(f.p); total -= f.size; }
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendJSON(res, 400, { error: e.message }); } return;
  }

  // ── GET /assets ──────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/assets') {
    let assets = [];
    try {
      const labels = (a.loadLibraryLabels && a.loadLibraryLabels().assets) || {};
      // Sort by the DISPLAYED text (label falls back to filename) — sorting by filename
      // alone leaves renamed assets looking unsorted in the library.
      // orphaned reicht bis in die UI durch: sonst sieht der Operator eine Datei in einer
      // Kategorie, die es in der Palette gar nicht mehr gibt, ohne Hinweis warum.
      assets = a.listStagedFiles().map(({ name, category, orphaned, path: abs }) => {
        let sizeMB = null;   // M9: the Library's Remesh dialog says how much it would upload
        try { sizeMB = Math.round(fs.statSync(abs).size / 104857.6) / 10; } catch (_) { /* gone between list and stat */ }
        let posterStamp = ''; try { const st = fs.statSync(abs); posterStamp = st.size + '-' + st.mtimeMs; } catch (_) {}
        return { name, category, orphaned: !!orphaned, label: labels[category + '/' + name] || null, sizeMB, posterStamp };
      })
        .sort((x, y) => (x.label || x.name).localeCompare(y.label || y.name, undefined, { numeric: true, sensitivity: 'base' }));
    } catch (_) {}
    sendJSON(res, 200, { assets });
    return;
  }

  // ── v1.10 LIB2 (T6-6): trash for images + videos ─────────────────────────────────────────────────────────
  // GET /images also carries trash:[…] · POST /images/trash {path} · POST /images/restore {id} · POST /images/trash/empty {kinds?}
  if (method === 'POST' && urlPath === '/images/trash') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const p = body && typeof body.path === 'string' ? body.path : '';
    const [code, out] = await withTrashLock(ifStillAuthorized(req, () => trashDo(p)));   // <r1-remote> B2: re-checked when the queue turn comes
    sendJSON(res, code, out);
    return;
  }
  if (method === 'POST' && urlPath === '/images/restore') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const id = body && typeof body.id === 'string' ? body.id : '';
    const [code, out] = await withTrashLock(ifStillAuthorized(req, () => restoreDo(id)));
    sendJSON(res, code, out);
    return;
  }
  if (method === 'POST' && urlPath === '/images/trash/empty') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const [code, out] = await withTrashLock(ifStillAuthorized(req, () => emptyDo(body && body.kinds)));
    sendJSON(res, code, out);
    return;
  }

  // ── GET /thumb?p=<video path> (v1.10 LIB2, T6-23): JPEG poster, extracted once with ffmpeg and cached in output/.thumbs/ ─────────
  if (method === 'GET' && urlPath === '/thumb') {
    const p = parsedUrl.searchParams.get('p');
    const resolved = resolveFileParam(p);   // the /file path rule
    if (!resolved || !resolved.allowed) { res.writeHead(403); res.end('403 Forbidden'); return; }
    let st = null;
    try { st = fs.statSync(resolved.abs); } catch (_) {}
    if (!st || !st.isFile()) { res.writeHead(404); res.end('404 Not Found'); return; }
    let jpg = null;
    try { jpg = await thumbMake(resolved.abs, st.mtimeMs, p); } catch (_) { jpg = null; }
    let buf = null;
    try { if (jpg) buf = fs.readFileSync(jpg); } catch (_) {}
    if (!buf || !buf.length) { res.writeHead(404); res.end('404 Not Found'); return; }   // ffmpeg missing / failed: the tile shows its placeholder
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }

  // ── GET /images?kind=image,i2i ───────────────────────────────────────────
  // The output record, newest first (max 500). url only where /file would serve the path; exists = on disk now.
  // A file deleted since is shown, never dropped from the record.
  if (method === 'GET' && urlPath === '/images') {
    const want = String(parsedUrl.searchParams.get('kind') || 'image,i2i,upload').split(',').map(s => s.trim()).filter(k => ['image', 'i2i', 'video', 'upload'].includes(k));   // <l1-library> uploads are listed by default
    const kinds = want.length ? want : ['image', 'i2i', 'upload'];
    const trashed = new Set(trashRead(false).map(x => x.from));   // v1.10 LIB2: a record whose file is in the trash is not listed
    let usedClips = null;   // LC2d (B1): clip paths some shot uses (read once, only when a local clip is listed)
    const tombs = tombRead();   // LC2d (T8-3): …nor one whose trash entry was emptied (unless the record is newer than that)
    const items = records.readRecords({ kinds }).filter(r => !(typeof r.path === 'string' && trashed.has(r.path))).filter(r => { const t = typeof r.path === 'string' ? tombs.get(r.path) : undefined; if (t === undefined) return true; const ra = Date.parse(r.at); return isFinite(ra) && ra > t; }).slice(0, 500).map(r => {
      const p = typeof r.path === 'string' ? r.path : '';
      const abs = path.resolve(workingDir, p);
      const f = p && !path.isAbsolute(p) ? resolveFileParam(p) : null;
      let exists = false;
      try { exists = !!p && fs.statSync(abs).isFile(); } catch (_) {}
      const out = { ...r, url: (f && f.allowed) ? '/file?p=' + encodeURIComponent(p) : null, exists };
      if (r.kind === 'video' && out.url) out.thumb = '/thumb?p=' + encodeURIComponent(p);
      if (r.kind === 'video' && out.url) {   // LC2d (B1): the Library tile and its View button play the variant (sound / silent) a shot chose, not only the recorded file
        const ct = clipTwin(p);
        if (ct.twin) {
          if (!usedClips) { usedClips = new Set(); /* a listing must not create the boards folder: */ try { if (fs.existsSync(storyboard.STORYBOARD_DIR)) for (const b of storyboard.listBoards()) { const bd = storyboard.load(b.id); if (!bd.error) for (const s of bd.shots) if (s.clip && s.clip.path) usedClips.add(s.clip.path); } } catch (_) {} }
          if (!usedClips.has(p) && usedClips.has(ct.twin)) {
            const f2 = resolveFileParam(ct.twin); let ex2 = false;
            try { ex2 = fs.statSync(path.resolve(workingDir, ct.twin)).isFile(); } catch (_) {}
            if (ex2 && f2 && f2.allowed) out.url = '/file?p=' + encodeURIComponent(ct.twin);
          }
        }
      }   // v1.10 LIB2: the poster route (404 -> the tile shows a placeholder)
      return out;
    });
    const out = { items };
    const allTrash = trashRead(false), parentIds = new Set(allTrash.map(x => x.id));
    const inTrash = allTrash.filter(x => kinds.includes(x.kind) && !(x.twin_of && parentIds.has(x.twin_of))).reverse();   // LC2d (O3, D1): a clip's twin travels with its clip - hidden ONLY while that clip's entry is still in the index; an orphaned twin (parent restored / emptied / index edited / half-way failure) is a normal, retryable item
    if (inTrash.length) out.trash = inTrash;   // v1.10 LIB2: what is in the trash for these kinds (newest first); absent when empty
    sendJSON(res, 200, out);
    return;
  }

  // ── Storyboard (v1.10 V1): GET /storyboard · POST /storyboard/shot[/update|/remove|/move] ──
  // Shots are timeline events; images are LINKED (relative path), never copied. Every route answers with the whole board.
  // <v1-storyboard>
  if (urlPath === '/storyboard' || urlPath.startsWith('/storyboard/') || urlPath === '/storyboards' || urlPath.startsWith('/storyboards/')) {
    const sbExists = (rel) => {   // a recorded file under the /file roots (never stat outside them)
      const f = rel && typeof rel === 'string' && !path.isAbsolute(rel) ? resolveFileParam(rel) : null;
      let exists = false;
      if (f && f.allowed) { try { exists = fs.statSync(path.resolve(workingDir, rel)).isFile(); } catch (_) {} }
      return { exists, url: (f && f.allowed) ? '/file?p=' + encodeURIComponent(rel) : null };
    };
    // LC2f (T9-1): a new local clip is ONE file with the model's sound; the shot's clip.muted says whether the players mute it, and the switch only flips that flag.
    // Old LC2d pairs (<name>_local.<ext> silent + <name>_local.sound.<ext> original) switch too: the first switch moves clip.path to the .sound file and sets muted;
    // the silent file stays on disk untouched. A plain old clip without a twin (and a model without sound) cannot be switched and says why.
    const sbClipTwin = (rel) => {
      const m = /^(.*)_local(\.sound)?(\.[A-Za-z0-9]+)$/.exec(String(rel || ''));
      if (!m) return { orig: false, twin: null };
      return m[2] ? { orig: true, twin: m[1] + '_local' + m[3] } : { orig: false, twin: m[1] + '_local.sound' + m[3] };
    };
    const sbClipSound = (clip) => {
      const t = sbClipTwin(clip && clip.path);
      if (clip && typeof clip.muted === 'boolean') return { available: true, on: !clip.muted, reason: '' };   // a one-file clip (or an old pair already switched once)
      if (t.orig) return { available: true, on: true, reason: '' };   // an old clip that IS the original (with its sound), no flag yet
      if (t.twin && sbExists(t.twin).exists) return { available: true, on: false, reason: '' };   // an old pair, the shot is on the silent file
      return { available: false, on: false, reason: 'This clip has no separate sound version (made before sound could be switched, or the model makes no sound).' };
    };
    // <v1b3> V1b-3 helpers: video backend state, the shot request, the cast lookup
    const sbKey = (bid, sid) => bid + ':' + sid;
    const sbAvail = (b, cfgIn) => { try { const r = b.available(cfgIn || a.loadConfig()); return (r && typeof r === 'object') ? { ok: !!r.ok, reason: String(r.reason || ''), pending: r.pending === true } : { ok: false, reason: 'the video backend gave no answer' }; } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; } };
    // <v2-choice> v1.10 V2: config video.backend 'auto' (default; also any old config without it) | '<backend id>'. auto = a LOCAL (gpu) backend first when it is available (it is free), else the others in registration order.
    // An explicit id is honoured exactly: if that backend is not available the answer is ITS reason (no silent switch to a paid one). An id nobody registered behaves as auto.
    const sbVideoChoice = (cfg) => { const v = cfg && cfg.video && cfg.video.backend; return (typeof v === 'string' && v && v !== 'auto') ? v : 'auto'; };
    const sbVideoState = (cfgIn, forceChoice) => {   // the backend Make video would use
      if (!videoBackends.length) return { available: false, reason: NO_VIDEO_BACKEND, backend: null };
      const cfgV = cfgIn || a.loadConfig();
      const choice = forceChoice || sbVideoChoice(cfgV);
      if (choice !== 'auto') {
        const one = videoBackends.find(x => x.id === choice);
        if (one) { const r = sbAvail(one, cfgV); return r.ok ? { available: true, reason: '', backend: one } : { available: false, reason: r.reason || (one.label + ' is not available'), backend: null }; }
      }
      let firstReason = '';
      for (const b of videoBackends.slice().sort((x, y) => (y.gpu === true ? 1 : 0) - (x.gpu === true ? 1 : 0))) { const r = sbAvail(b, cfgV); if (r.ok) return { available: true, reason: '', backend: b };
        if (r.pending && !firstReason) return { available: false, reason: r.reason || 'Checking local video…', backend: null };   // the free local backend is still being checked: do not flash the paid one's cost line meanwhile
        if (!firstReason) firstReason = r.reason || (b.label + ' is not available'); }
      return { available: false, reason: firstReason, backend: null };
    };
    // </v2-choice>
    // <sb3> cast member by NAME; a cast member = {name, engine ('crispasr' | 'chatterbox'), voice (pack), reference (.wav in sounds/refs/)}
    const sbCastMember = (board, name) => (Array.isArray(board.cast) ? board.cast : []).find(c => c && c.name === name) || null;
    const sbLocalVoice = () => { try { return workflows.dispatcherMode((a.loadConfig() || {}).voice) === 'local'; } catch (_) { return false; } };
    // availability of one cast voice for the view. crispasr: the pack must be in the list /voice-state last saw (no list seen yet = unknown = available;
    // the view never reaches the network). chatterbox: the dispatcher must be on and, when a reference is set (local mode: required), the file must exist.
    const sbCastView = (board, vcfg) => {
      const known = sbVoiceSeen.names;
      const hasDisp = workflows.hasDispatcher(vcfg);
      return (Array.isArray(board.cast) ? board.cast : []).map(c => {
        let available = true, reason = '';
        if (c.engine === 'crispasr') {
          if (!c.voice) { available = false; reason = 'no voice pack chosen'; }
          else if (known && !known.has(c.voice)) { available = false; reason = 'voice pack "' + c.voice + '" is not in the current list'; }
        } else if (c.engine === 'chatterbox') {
          if (!hasDisp) { available = false; reason = 'turn on "Run voice engines on this PC" in Settings → Voice engines'; }
          else if (c.reference) { const rr = voice.resolveRef(c.reference); if (rr.error) { available = false; reason = rr.error; } }
          else if (workflows.dispatcherMode((vcfg || {}).voice) === 'local') { available = false; reason = 'pick a reference voice'; }
        } else { available = false; reason = 'unknown engine "' + c.engine + '"'; }
        return { ...c, available, reason };
      });
    };
    const sbShotRequest = (board, s) => {
      const abs = (rel) => path.resolve(workingDir, rel);
      const safe = (rel) => !!rel && typeof rel === 'string' && !sbImageError(rel);   // the ONE path rule (servable.js: realpath, inside the roots, a file) before anything reaches estimate()/start()
      return {
        boardId: board.id, shotId: s.id,   // so the BACKEND can set the finished clip with storyboard.updateShot(boardId, shotId, {clip})
        startImage: safe(s.image) ? abs(s.image) : null,
        prompt: storyboard.compilePrompt(s, 'video'),
        duration_s: s.duration_s,
        aspect: board.aspect,
        refs: (Array.isArray(s.refs) ? s.refs : []).filter(r => r && safe(r.path)).map(r => ({ role: r.role, label: r.label || '', path: abs(r.path) })),   // an unsafe reference is skipped
        lines: (Array.isArray(s.lines) ? s.lines : []).map(l => ({ speaker: l.speaker || '', line: l.line || '', take: l.take || null })),
        ...(sbHasVoiceTake(s) ? { audio: false } : {}),   // <lc2a-fal-audio> a shot with a voice take defaults to NO generated sound (the clip's own voice would fight the take); otherwise the Settings default decides
      };
    };
    // <lc2a-fal-audio> today dialogue.take; after SB3 any line with a take
    const sbHasVoiceTake = (s) => !!(s && Array.isArray(s.lines) && s.lines.some(l => l && l.take));
    const sbAudioDefault = (s, cfgAudio) => sbHasVoiceTake(s) ? { on: false, reason: 'off — this shot has a voice take' } : { on: cfgAudio !== undefined ? cfgAudio : videoView(a.loadConfig()).fal.audio, reason: '' };
    // </v1b3>
    // R6: what the timeline needs to know about files (one rule each: the servable-image rule, the real take file, the SFX library)
    const sbTimelineFacts = () => {
      let sfxNames = null;
      const imageOk = (rel) => typeof rel === 'string' && !!rel && sbImageError(rel) === '';
      return {
        keyframeOk: imageOk, clipOk: imageOk,
        takeSeconds: (take) => storyboardTimeline.wavSeconds(path.join(voice.OUT_DIR, path.basename(String(take)))),
        sfxOk: (clip) => { if (!sfxNames) sfxNames = new Set(sfx.listClips().map(c => c.file)); return sfxNames.has(clip); },
      };
    };
    const sbView = (board) => {
      let clips = null;
      // <lc2a-r2> M6 / r3 M1: config (and the key lookup behind videoView) is read ONCE per view build - availability, audio default and estimates all use it
      const vcfg = a.loadConfig();
      const vs = sbVideoState(vcfg);
      const vList = videoBackends.map(b => ({ b, r: sbAvail(b, vcfg) }));   // <v2-choice> every registered backend with its availability (once per view build)
      const cfgAudio = (vcfg && vcfg.video && vcfg.video.fal && typeof vcfg.video.fal === 'object') ? vcfg.video.fal.audio !== false : true;
      // LC2d (T8-6): the length cap of every backend that has one (the local model's frame rule), once per view; ③ shows the note before the run when the shot is longer
      const videoCaps = {};
      for (const x of vList) { if (typeof x.b.capSeconds !== 'function') continue; try { const cs = Number(x.b.capSeconds(vcfg)); if (cs > 0) videoCaps[x.b.id] = cs; } catch (_) { /* no cap known */ } }
      const shots = board.shots.map(s => {
        const k = sbExists(s.image);
        const out = { ...s, url: k.url, exists: k.exists };
        // V1b-1 fields (a v1-shaped shot from a hand-built board is tolerated)
        const refs = (Array.isArray(s.refs) ? s.refs : []).map(r => { const rk = sbExists(r && r.path); return { ...r, url: rk.url, exists: rk.exists }; });
        const lines = (Array.isArray(s.lines) ? s.lines : []).map(l => {   // <sb3> per line: does its take file still exist
          let takeExists = false, take_s = null;
          if (l.take) { try { const st = fs.statSync(path.join(voice.OUT_DIR, path.basename(String(l.take)))); takeExists = st.isFile(); if (takeExists) take_s = Math.max(0, Math.round((st.size - 44) / 48000 * 100) / 100); } catch (_) {} }   // 24 kHz mono PCM16, the same figure voice.speak reports
          return { ...l, takeExists, take_s };
        });
        const snd = s.sound || { text: '', clip: null };
        let clipExists = false;
        if (snd.clip) { if (!clips) clips = sfx.listClips().map(c => c.file); clipExists = clips.includes(snd.clip); }
        const vid = s.clip ? sbExists(s.clip.path) : null;
        out.refs = refs; out.lines = lines; out.sound = { ...snd, clipExists };
        out.clip_url = vid ? vid.url : null;
        out.clip_sound = (vid && vid.exists && s.clip.backend === 'comfy-i2v') ? sbClipSound(s.clip) : null;   // LC2f (T9-1): is the clip's sound on (clip.muted), and can it be switched
        out.status = (vid && vid.exists) ? 'video' : (k.exists ? 'keyframe' : 'draft');   // derived, never stored
        out.compiled = { keyframe: storyboard.compilePrompt(s, 'keyframe'), video: storyboard.compilePrompt(s, 'video') };
        // V1b-3: progress / last failure of the long actions, and the cost line of a paid video backend
        const sk = sbKey(board.id, s.id);
        out.keyframe_busy = sbKeyframeBusy.has(sk); out.keyframe_error = sbKeyframeErr.get(sk) || ''; out.keyframe_job = sbKeyframeRefJob.get(sk) ?? null;
        out.video_busy = sbVideoBusy.has(sk); out.video_error = sbVideoErr.get(sk) || '';
        out.video_estimate = null;
        { const ad = sbAudioDefault(s, cfgAudio); out.video_audio = { on: ad.on, reason: ad.reason }; }   // <lc2a-fal-audio> the confirm row's default for "with sound"
        if (vs.available && s.image) { try { const rq = sbShotRequest(board, s); const e = rq.startImage ? vs.backend.estimate(rq, vcfg) : null; if (e && typeof e === 'object') out.video_estimate = { line: String(e.line || ''), usd: Number(e.usd) || 0 }; } catch (_) {} }
        // <v2-choice> the price of THIS shot per available backend (the selector in ③ shows it; null = free) + the local run's progress / note / can-be-stopped
        out.video_options = [];
        if (s.image) { let rq2 = null; try { rq2 = sbShotRequest(board, s); } catch (_) {}
          for (const x of vList) { if (!x.r.ok) continue; let est2 = null; try { const e2 = (rq2 && rq2.startImage) ? x.b.estimate(rq2, vcfg) : null; if (e2 && typeof e2 === 'object') est2 = { line: String(e2.line || ''), usd: Number(e2.usd) || 0 }; } catch (_) { continue; } out.video_options.push({ id: x.b.id, estimate: est2 }); } }
        out.video_caps = videoCaps;
        out.video_progress = sbVideoProgress.get(sk) || ''; out.video_note = sbVideoNote.get(sk) || ''; out.video_stoppable = sbVideoGpu.has(sk); out.video_job = sbVideoGpu.get(sk) || null;
        // </v2-choice>
        return out;
      });
      const total_s = board.shots.reduce((t, s) => t + s.duration_s, 0);
      // <lc2b> which image workflow builds the keyframe (the keyframe route uses the ACTIVE one): the page shows it under the action row
      let keyframe = { workflow: '', label: 'the active image workflow', mode: 'none', max_refs: 0 };
      try {
        const we = workflows.getActive('image', vcfg), R = we && we.reference;
        keyframe = { workflow: (we && we.id) || '', label: (we && (we.label || we.id)) || 'the active image workflow', mode: !R ? 'none' : (R.mode === 'img2img' ? 'img2img' : (Number(R.maxRefs) >= 1 ? 'edit' : 'none')), max_refs: R ? (Number(R.maxRefs) || 0) : 0 };
      } catch (_) { /* no workflow info: the page shows the generic line */ }
      const lt = storyboard.listTags();   // R6: the shared own-tag list rides along with every view
      const out = { board, total_s, shots, camera_tags: lt.ok ? lt.tags : [], cast: sbCastView(board, vcfg), keyframe, video: { available: vs.available, reason: vs.reason, backend: vs.backend ? { id: vs.backend.id, label: vs.backend.label } : null } };
      if (vList.length) { const au = sbVideoState(vcfg, 'auto');   // <v2-choice> what the selector in ③ lists (absent while no backend is registered); video{} above is untouched
        out.video_choice = { choice: sbVideoChoice(vcfg), auto: au.backend ? au.backend.id : null, backends: vList.map(x => ({ id: x.b.id, label: x.b.label, gpu: x.b.gpu === true, available: x.r.ok, reason: x.r.ok ? '' : x.r.reason, ...(x.b.status === 'unverified' ? { unverified: true } : {}) })) }; }
      if (!board.error) { try { out.timeline = storyboardTimeline.timeline(board, sbTimelineFacts()); } catch (_) { /* a view never fails because of the timeline */ } }   // R6
      if (!board.error) out.undo = storyboard.pendingUndo(board.id);   // R6: the one remove the server can still undo (the page shows its Undo row only while this matches)
      if (board.warning) out.warning = board.warning;
      if (board.error) { out.error = board.error; out.board = { version: board.version, id: board.id, title: board.title, group: board.group, aspect: board.aspect, cast: board.cast, shots: board.shots }; }
      return out;
    };
    // storyboard.js error -> HTTP status (unknown shot / board 404, unreadable 409, save failed 500, else 400)
    const sbStatus = (err) => (err === 'unknown shot' || err === storyboard.UNKNOWN_BOARD) ? 404 : ((err === storyboard.UNREADABLE || err === storyboard.UNDO_GONE || /^too many tags/.test(String(err))) ? 409 : ((err === storyboard.SAVE_FAILED || err === storyboard.BACKUP_FAILED) ? 500 : 400));
    // '' when fine (or no image given), else the plain error for a 400.
    const sbImageError = (img) => servable.servableImageError(workingDir, img);   // one path rule (servable.js), shared with generate_from_refs
    if (method === 'GET' && urlPath === '/storyboard') {
      const bid = parsedUrl.searchParams.get('board');
      const board = storyboard.load(bid);
      if (board.error === storyboard.UNKNOWN_BOARD) { sendJSON(res, 404, { error: board.error }); return; }
      sendJSON(res, 200, sbView(board));
      return;
    }
    if (method === 'GET' && urlPath === '/storyboards') {
      const r = storyboard.boardsState();
      if (!r.ok) { sendJSON(res, sbStatus(r.error), { error: r.error }); return; }
      sendJSON(res, 200, { active: r.active, boards: r.boards, groups: r.groups });
      return;
    }
    // <r6-tags> R6: the shared own camera tags (session/storyboards/_tags.json)
    if (method === 'GET' && urlPath === '/storyboard/tags') {
      const r = storyboard.listTags();
      if (!r.ok) { sendJSON(res, sbStatus(r.error), { error: r.error }); return; }
      sendJSON(res, 200, { tags: r.tags });
      return;
    }
    if (method === 'POST' && (urlPath === '/storyboard/tags/add' || urlPath === '/storyboard/tags/remove')) {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (_) { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJSON(res, 400, { error: 'request body must be a JSON object' }); return; }
      const r = urlPath === '/storyboard/tags/add' ? storyboard.addTag(body.tag) : storyboard.removeTag(body.tag);
      if (!r.ok) { sendJSON(res, sbStatus(r.error), { error: r.error }); return; }
      sendJSON(res, 200, { ok: true, tags: r.tags });
      return;
    }
    // </r6-tags>
    // <r6-export> R6: Export board as video (the animatic MP4). One job in the shared slot; Stop = the existing POST /stop {kind:'video', job}
    if (method === 'GET' && urlPath === '/storyboard/export/status') {
      sendJSON(res, 200, { running: sbExport.running ? { board: sbExport.running.board, job: sbExport.running.job, progress: sbExport.running.progress } : null, last: sbExport.last, idle: !(deferredInFlight || lock.isHeld() || jobs.isRunning()) });   // idle: the phone can confirm a busy refusal is stale (/mcp/status is laptop-only)
      return;
    }
    if (method === 'POST' && urlPath === '/storyboard/export') {
      if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }   // starts a long ffmpeg job and writes a file
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (_) { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJSON(res, 400, { error: 'request body must be a JSON object' }); return; }
      const bid = body.board == null || body.board === '' ? null : String(body.board);
      const board = storyboard.load(bid);
      if (board.error) { sendJSON(res, sbStatus(board.error), { error: board.error }); return; }
      if (!board.shots.length) { sendJSON(res, 400, { error: 'nothing to export \u2014 add a shot first' }); return; }
      if (deferredInFlight || lock.isHeld()) { sendJSON(res, 409, busyRefusal()); return; }
      const facts = sbTimelineFacts();
      const started = jobs.start({ kind: 'video', label: 'Animatic ' + board.title }, (jid, signal) => sbRunAnimaticJob(board, facts, jid, signal));
      if (!started.started) { sendJSON(res, 409, { error: started.reason, busy: true }); return; }
      sbExport.running = { board: board.id, job: started.id, progress: 0 };
      sendJSON(res, 200, { ok: true, job: started.id });
      return;
    }
    // </r6-export>
    if (method === 'POST' && ['/storyboard/shot', '/storyboard/shot/update', '/storyboard/shot/line/add', '/storyboard/shot/remove', '/storyboard/shot/restore', '/storyboard/shot/move'].includes(urlPath)) {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (_) { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJSON(res, 400, { error: 'request body must be a JSON object' }); return; }
      if (urlPath === '/storyboard/shot' || urlPath === '/storyboard/shot/update') {   // stored in the spelling every later check accepts: an absolute path inside a root (on Windows also OUTPUT/x.png) becomes output/x.png
        body.image = servable.relativeForm(workingDir, body.image);
        if (Array.isArray(body.refs)) body.refs = body.refs.map(ref => (ref && typeof ref === 'object' && typeof ref.path === 'string') ? { ...ref, path: servable.relativeForm(workingDir, ref.path) } : ref);
      }
      const imgErr = urlPath === '/storyboard/shot' || urlPath === '/storyboard/shot/update' ? sbImageError(body.image) : '';
      if (imgErr) { sendJSON(res, 400, { error: imgErr }); return; }
      const bid = body.board == null || body.board === '' ? null : String(body.board);
      let r;
      if (urlPath === '/storyboard/shot') r = storyboard.addShot(bid, { image: body.image, prompt: body.prompt, duration_s: body.duration_s, index: body.index });
      else if (urlPath === '/storyboard/shot/update') {
        const patch = { prompt: body.prompt, duration_s: body.duration_s, image: body.image, title: body.title, refs: body.refs, camera: body.camera };
        if (body.refs !== undefined) {   // every reference passes the same checks as the keyframe image (400, nothing written)
          if (!Array.isArray(body.refs)) { sendJSON(res, 400, { error: 'bad references' }); return; }
          for (const ref of body.refs) {
            const rerr = (ref && typeof ref === 'object' && typeof ref.path === 'string' && ref.path) ? sbImageError(ref.path) : 'bad reference';
            if (rerr) { sendJSON(res, 400, { error: rerr }); return; }
          }
        }
        if (body.lines !== undefined) {   // <sb3> the whole list. R6: a client take is honoured when it is a string naming a take that really is in sounds/vo (take -> storyboard); absent / null keeps the line's take by lid
          if (!Array.isArray(body.lines)) { sendJSON(res, 400, { error: 'bad lines' }); return; }
          for (const l of body.lines) {
            if (!l || typeof l !== 'object' || Array.isArray(l) || l.take === undefined || l.take === null) continue;
            const tk = l.take;
            const base = typeof tk === 'string' ? path.basename(tk) : '';
            if (typeof tk !== 'string' || tk !== '/vo/' + base || /[\\/]/.test(base) || storyboard.normTake(tk) === null) { sendJSON(res, 400, { error: 'bad line take' }); return; }
            let isFile = false;
            try { isFile = fs.statSync(path.join(voice.OUT_DIR, base)).isFile(); } catch (_) { isFile = false; }
            if (!isFile) { sendJSON(res, 400, { error: 'that take is not in sounds/vo' }); return; }
          }
          patch.lines = body.lines.map(l => { if (!l || typeof l !== 'object' || Array.isArray(l)) return l; const { take, takeExists: _ig2, take_s: _ig3, ...rest } = l; if (typeof take === 'string') rest.take = take; return rest; });   // a validated string take is set; absent / null leaves it to storyboard.js (kept by lid)
        }
        if (body.sound !== undefined) {
          if (!body.sound || typeof body.sound !== 'object' || Array.isArray(body.sound)) { sendJSON(res, 400, { error: 'bad sound' }); return; }
          if (body.sound.clip != null && body.sound.clip !== '' && !sfx.listClips().some(c => c.file === body.sound.clip)) { sendJSON(res, 400, { error: 'sound clip is not in the SFX library' }); return; }
          patch.sound = { ...body.sound };
          if (body.sound.clip !== undefined) patch.sound.clip = body.sound.clip === '' ? null : body.sound.clip;   // '' clears
        }
        r = storyboard.updateShot(bid, body.id, patch);
      }
      else if (urlPath === '/storyboard/shot/line/add') {   // R6: atomic "+ new line" (the lines are read under the write; same take rule as update)
        const tk = body.take;
        const base = typeof tk === 'string' ? path.basename(tk) : '';
        if (typeof tk !== 'string' || tk !== '/vo/' + base || /[\\/]/.test(base) || storyboard.normTake(tk) === null) { sendJSON(res, 400, { error: 'bad line take' }); return; }
        let isFile = false;
        try { isFile = fs.statSync(path.join(voice.OUT_DIR, base)).isFile(); } catch (_) { isFile = false; }
        if (!isFile) { sendJSON(res, 400, { error: 'that take is not in sounds/vo' }); return; }
        r = storyboard.addLine(bid, body.id, { speaker: body.speaker, line: body.line, gap_s: body.gap_s, take: tk });
      }
      else if (urlPath === '/storyboard/shot/remove') r = storyboard.removeShot(bid, body.id);
      else if (urlPath === '/storyboard/shot/restore') r = storyboard.restoreShot(bid, body.shot, body.at);   // R6: Undo of the last remove of that board
      else r = storyboard.moveShot(bid, body.id, body.index);
      if (!r.ok) { sendJSON(res, sbStatus(r.error), { error: r.error }); return; }
      if (urlPath === '/storyboard/shot/remove') { sendJSON(res, 200, { ...sbView(r.board), removed: { shot: r.removed, at: r.at } }); return; }
      if (urlPath === '/storyboard/shot/restore') { sendJSON(res, 200, { ...sbView(r.board), restored: r.restored }); return; }
      sendJSON(res, 200, sbView(r.board));
      return;
    }
    // <v1b3-actions> V1b-3: Make keyframe (I1 generate_from_refs / plain text-to-image) - Speak line (voice.speak) - Make video (backend registry)
    // <lc2d-clipsound>
    // POST /storyboard/shot/clip-sound {board?, id, on} (LC2f T9-1): sets clip.muted = !on - nothing is made, no file changes (an old pair moves clip.path to its .sound file once)
    if (method === 'POST' && urlPath === '/storyboard/shot/clip-sound') {
      if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (_) { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJSON(res, 400, { error: 'request body must be a JSON object' }); return; }
      if (typeof body.on !== 'boolean') { sendJSON(res, 400, { error: 'on must be true or false' }); return; }
      const bid = body.board == null || body.board === '' ? null : String(body.board);
      const board = storyboard.load(bid);
      if (board.error) { sendJSON(res, sbStatus(board.error), { error: board.error }); return; }
      const shot = board.shots.find(x => x.id === body.id);
      if (!shot) { sendJSON(res, 404, { error: 'unknown shot' }); return; }
      if (!shot.clip || shot.clip.backend !== 'comfy-i2v') { sendJSON(res, 400, { error: 'this shot has no local clip' }); return; }   // fal clips keep their own "with sound" choice (made before paying)
      if (sbVideoBusy.has(sbKey(board.id, shot.id))) { sendJSON(res, 409, { error: 'a video for this shot is being made - wait for it' }); return; }
      const cs = sbClipSound(shot.clip), t = sbClipTwin(shot.clip.path);
      if (!cs.available) { sendJSON(res, 409, { error: cs.reason }); return; }
      if (cs.on !== body.on) {
        const movePath = (typeof shot.clip.muted !== 'boolean' && !t.orig && t.twin) ? t.twin : shot.clip.path;   // an old pair on the silent file: the sound lives in the .sound file
        const u = storyboard.updateShot(board.id, shot.id, { clip: { path: movePath, backend: shot.clip.backend, made_at: shot.clip.made_at, muted: !body.on } });
        if (!u.ok) { sendJSON(res, sbStatus(u.error), { error: u.error }); return; }
        try { broadcast({ kind: 'storyboard', phase: 'clipsound', board: board.id, shot: shot.id, ok: true }); } catch (_) { /* no clients */ }   // LC2d (B1): an open Library / Video tab re-reads
        sendJSON(res, 200, sbView(u.board));
        return;
      }
      sendJSON(res, 200, sbView(storyboard.load(board.id)));
      return;
    }
    // </lc2d-clipsound>
    if (method === 'POST' && ['/storyboard/shot/keyframe', '/storyboard/shot/speak', '/storyboard/shot/clip'].includes(urlPath)) {
      if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }   // these start a GPU job / a voice take / a (paid) clip
      if (urlPath === '/storyboard/shot/clip' && !videoBackends.length) { sendJSON(res, 501, { error: NO_VIDEO_BACKEND }); return; }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (_) { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJSON(res, 400, { error: 'request body must be a JSON object' }); return; }
      const bid = body.board == null || body.board === '' ? null : String(body.board);
      const board = storyboard.load(bid);
      if (board.error) { sendJSON(res, sbStatus(board.error), { error: board.error }); return; }
      const shot = board.shots.find(x => x.id === body.id);
      if (!shot) { sendJSON(res, 404, { error: 'unknown shot' }); return; }
      const k = sbKey(board.id, shot.id);
      const view = () => sbView(storyboard.load(board.id));

      if (urlPath === '/storyboard/shot/keyframe') {
        // references in role order character -> set -> prop (the order inside a role is kept)
        const rank = { character: 0, set: 1, prop: 2 };
        const refs = (shot.refs || []).map((r, i) => ({ r, i })).sort((x, y) => (rank[x.r.role] - rank[y.r.role]) || (x.i - y.i)).map(x => x.r.path);
        for (const rel of refs) { const e = sbImageError(rel); if (e) { sendJSON(res, 400, { error: e }); return; } }
        const prompt = storyboard.compilePrompt(shot, 'keyframe');
        if (!prompt.trim()) { sendJSON(res, 400, { error: 'a prompt is needed — write what happens in this shot first' }); return; }
        if (refs.length) {   // refuse BEFORE any generation (user decision 13.10.: refuse and say so)
          let entry;
          try { entry = workflows.getActive('image', a.loadConfig()); } catch (e) { sendJSON(res, 400, { error: String((e && e.message) || e) }); return; }
          const R = entry && entry.reference;
          const label = (entry && (entry.label || entry.id)) || 'the active image workflow';
          if (!R) { sendJSON(res, 400, { error: '"' + label + '" has no reference mode — use Flux Klein (up to 2 references) or Z-Image Turbo (1 reference).' }); return; }
          if (refs.length > R.maxRefs) { sendJSON(res, 400, { error: 'The active image workflow takes ' + R.maxRefs + ' reference images — this shot has ' + refs.length + '. Remove some or switch the workflow.' }); return; }
        }
        if (deferredInFlight || lock.isHeld()) { sendJSON(res, 409, busyRefusal()); return; }
        const dims = { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024] }[board.aspect] || [1344, 768];
        const nr = board.shots.indexOf(shot) + 1;
        const started = jobs.start({ kind: 'image', label: 'Keyframe shot ' + nr }, async (jid, signal) => {
          let ok = false, stoppedRun = false, timedOut = false, timer = null, limit = 0;
          const ac = new AbortController();
          try {
            let rel;
            if (refs.length) {   // I1's entry point, exactly as its spec defines it
              // M4: a reference run has a deadline (cfg.storyboard.keyframeTimeoutMs, else 12 min) and a Stop; the call ends even when the tool ignores the signal
              const kt = Number(((a.loadConfig() || {}).storyboard || {}).keyframeTimeoutMs);
              limit = Number.isFinite(kt) && kt > 0 ? kt : 720000;
              timer = setTimeout(() => { timedOut = true; ac.abort(); }, limit);
              if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }); }
              const gone = new Promise((_, rej) => { const f = () => rej(Object.assign(new Error('Stopped'), { aborted: true })); if (ac.signal.aborted) f(); else ac.signal.addEventListener('abort', f, { once: true }); });
              gone.catch(() => {});
              const call = Promise.resolve(a.TOOLS.generate_from_refs({ refs, prompt, width: dims[0], height: dims[1], category: 'storyboard' }, state, a.loadConfig(), { background: true, ownsJobSlot: true, signal: ac.signal, timeoutMs: limit }));
              call.catch(() => {});
              const out = await Promise.race([call, gone]);
              const t = a.parseRefTile(out);
              if (!t) throw new Error(String(out).replace(/^(ERROR|BUSY):\s*/, ''));
              rel = path.relative(workingDir, t.abs).split(path.sep).join('/');
            } else {   // no references: plain text-to-image with the compiled prompt (literal, no metaprompter)
              const r = await pipeline.runImageStage({ desc: prompt, cat: 'storyboard', promptPos: prompt, width: dims[0], height: dims[1] });
              if (!r || !r.ok) throw new Error((r && r.error) || 'image stage failed');
              rel = path.relative(workingDir, path.resolve(workingDir, r.artifact)).split(path.sep).join('/');
            }
            const u = storyboard.updateShot(board.id, shot.id, { image: rel });
            if (!u.ok) throw new Error(u.error);
            sbKeyframeErr.delete(k); ok = true;
            return 'Keyframe shot ' + nr + ' ready';
          } catch (e) {
            if (refs.length && timedOut) {
              sbKeyframeErr.set(k, 'Keyframe timed out after ' + Math.max(1, Math.round(limit / 60000)) + ' min. Check that ComfyUI is running, then try again.');
              throw new Error(sbKeyframeErr.get(k));
            }
            if (refs.length && ac.signal.aborted) {   // a Stop is not an alarm: the same line where errors show, no failure bubble
              sbKeyframeErr.set(k, 'Keyframe stopped.'); stoppedRun = true;
              return 'Keyframe shot ' + nr + ' stopped';
            }
            sbKeyframeErr.set(k, String((e && e.message) || e));
            throw e;
          } finally {
            if (timer) clearTimeout(timer);
            sbKeyframeRefJob.delete(k);
            sbKeyframeBusy.delete(k);
            broadcast({ kind: 'storyboard', phase: 'keyframe', board: board.id, shot: shot.id, ok });   // the open Storyboard tab reloads once
          }
        });
        if (!started.started) { sendJSON(res, 409, { error: started.reason, busy: true }); return; }
        sbKeyframeErr.delete(k); sbKeyframeBusy.set(k, true); if (refs.length) sbKeyframeRefJob.set(k, started.id);
        sendJSON(res, 200, view());
        return;
      }

      if (urlPath === '/storyboard/shot/speak') {
        // <sb3> {id, lid} speaks ONE line; {id} speaks every line of the shot that has no take, in order (stops at the first error)
        const lid = body.lid == null || body.lid === '' ? null : String(body.lid);
        const targets = lid ? shot.lines.filter(l => l.lid === lid) : shot.lines.filter(l => !l.take && String(l.line || '').trim());
        if (lid && !targets.length) { sendJSON(res, 404, { error: 'unknown line' }); return; }
        if (!lid && !shot.lines.some(l => String(l.line || '').trim())) { sendJSON(res, 400, { error: 'pick a speaker and type a line first' }); return; }   // nothing to say at all; lines that all HAVE takes is not an error (nothing to do)
        const busyKeys = [...sbSpeakBusy];
        if (busyKeys.some(x => x === k || x.startsWith(k + ':'))) { sendJSON(res, 409, { error: 'this shot is already being spoken — give it a moment' }); return; }
        const bkey = lid ? k + ':' + lid : k;
        sbSpeakBusy.add(bkey);
        try {
          let lastBoard = null;
          for (const l of targets) {
            const name = (l.speaker || '').trim();
            if (!name || !String(l.line || '').trim()) { const e = { error: 'pick a speaker and type a line first' }; if (lastBoard) { sendJSON(res, 400, { ...sbView(lastBoard), error: e.error }); return; } sendJSON(res, 400, e); return; }
            const m = sbCastMember(board, name);
            const noVoice = '"' + name + '" has no voice yet — set it in the cast';
            let args, err = '';
            if (!m) err = noVoice;
            else if (m.engine === 'crispasr') { if (!m.voice) err = noVoice; else args = { voice: m.voice, text: l.line }; }
            else if (m.engine === 'chatterbox') {
              const local = sbLocalVoice();
              if (local && !m.reference) err = noVoice;
              else { args = { engine: 'chatterbox', text: l.line }; if (m.reference) args.reference = m.reference; if (!local) args.voice = 'chatterbox'; }   // rig mode: the rig's default voice when no reference
            } else err = '"' + name + '" has an unknown voice engine — set it in the cast';
            let r;
            if (!err) {
              try { r = await voice.speak(args); }   // the same function /voice-speak uses
              catch (e) { err = String((e && e.message) || e); }
              if (!err && (!r || r.error || !r.ok)) err = (r && r.error) || 'the voice gave no take';
            }
            if (err) {
              const st = (r && r.consentRequired) ? 409 : 400;
              if (lastBoard) sendJSON(res, st, { ...sbView(lastBoard), error: err }); else sendJSON(res, st, { error: err });
              return;
            }
            const take = r.url || ('/vo/' + r.file);
            const cur = storyboard.load(board.id);   // re-read: the list may have changed while the voice was working; the take goes to THIS line only
            const cs = cur.error ? null : cur.shots.find(x => x.id === shot.id);
            if (!cs || !cs.lines.some(x => x.lid === l.lid)) { sendJSON(res, 409, { error: 'that line was removed while it was being spoken' }); return; }
            const u = storyboard.updateShot(board.id, shot.id, { lines: cs.lines.map(x => x.lid === l.lid ? { ...x, take } : x) });
            if (!u.ok) { sendJSON(res, sbStatus(u.error), { error: u.error }); return; }
            lastBoard = u.board;
          }
          sendJSON(res, 200, sbView(lastBoard || storyboard.load(board.id)));
        } finally { sbSpeakBusy.delete(bkey); }
        return;
      }

      // POST /storyboard/shot/clip {board?, id, backend?, confirmed?}
      {
        const vs = sbVideoState(undefined, body.backend === 'auto' ? 'auto' : undefined);   // <v2-choice> {backend:'auto'} = the automatic pick whatever the config says
        let be = vs.backend;
        if (body.backend != null && body.backend !== '' && body.backend !== 'auto') {
          be = videoBackends.find(x => x.id === body.backend);
          if (!be) { sendJSON(res, 400, { error: 'unknown video backend "' + String(body.backend) + '"' }); return; }
          const av = sbAvail(be);
          if (!av.ok) { sendJSON(res, 409, { error: av.reason || (be.label + ' is not available') }); return; }
        }
        if (!be) { sendJSON(res, 409, { error: vs.reason }); return; }
        if (!shot.image) { sendJSON(res, 400, { error: 'make a keyframe first — the video starts from it' }); return; }
        { const ie = sbImageError(shot.image); if (ie) { sendJSON(res, 400, { error: ie }); return; } }   // the start image goes through the same realpath/file check
        if (sbVideoBusy.has(k)) { sendJSON(res, 409, { error: 'a video for this shot is already being made' }); return; }
        const sreq = sbShotRequest(board, shot);
        if (Object.prototype.hasOwnProperty.call(body, 'audio')) {   // <lc2a-fal-audio> the per-video choice (the estimate and the request are priced with it); r2 M3: PRESENCE, so {audio:null} is a 400 too
          if (typeof body.audio !== 'boolean') { sendJSON(res, 400, { error: 'audio must be true or false' }); return; }
          sreq.audio = body.audio;
        }
        let est = null;
        try { est = be.estimate(sreq); } catch (e) { sendJSON(res, 400, { error: String((e && e.message) || e) }); return; }
        if (remote.isRemoteReq(req) && ((est && typeof est === 'object') || body.confirmed === true)) { sendJSON(res, 403, REMOTE_NO_PAID); return; }   // LC2i: a paid backend (or a confirmed cost) is never started from the phone; a local clip is
        // <lc2a-r2> M1: estimate_only is a price question and nothing else - it answers BEFORE anything can start (paid or free backend)
        if (Object.prototype.hasOwnProperty.call(body, 'estimate_only')) {
          if (body.estimate_only !== true && body.estimate_only !== false) { sendJSON(res, 400, { error: 'estimate_only must be true or false' }); return; }
          if (body.estimate_only === true) {
            if (est && typeof est === 'object') { const e3 = { line: String(est.line || ''), usd: Number(est.usd) || 0 }; sendJSON(res, 409, { error: 'This costs money — confirm first: ' + e3.line, needs_confirm: true, estimate_only: true, estimate: e3 }); }
            else sendJSON(res, 200, { estimate_only: true, estimate: null });
            return;
          }
        }
        const confirmed = body.confirmed === true;   // exactly true - a truthy string is not a confirmation
        if (est && typeof est === 'object') {   // a paid backend never starts unconfirmed, and only for the price the user saw
          const e2 = { line: String(est.line || ''), usd: Number(est.usd) || 0 };
          if (!confirmed) { sendJSON(res, 409, { error: 'This costs money — confirm first: ' + e2.line, needs_confirm: true, estimate: e2 }); return; }
          const seen = body.estimate;
          if (!seen || typeof seen !== 'object' || seen.line !== e2.line || Number(seen.usd) !== e2.usd) {
            sendJSON(res, 409, { error: 'The price changed — please confirm again: ' + e2.line, estimate_changed: true, estimate: e2 });
            return;
          }
        }
        const nr = board.shots.indexOf(shot) + 1;
        const failOf = (v) => (v && typeof v === 'object' && (v.ok === false || (v.error && !v.ok))) ? String(v.error || 'the video backend failed') : null;
        let lastV = null;
        const settle = (p) => {   // the end of start(): a rejection or a {ok:false,error} result is a failure (video_error + SSE ok:false)
          sbVideoBusy.set(k, true);
          return Promise.resolve(p).then(v => { lastV = v; return failOf(v); }, e => String((e && e.message) || e)).then(f => {
            if (f) sbVideoErr.set(k, f); else sbVideoErr.delete(k);
            if (!f && lastV && typeof lastV === 'object' && lastV.note) sbVideoNote.set(k, String(lastV.note)); else sbVideoNote.delete(k);   // <v2-choice> e.g. "the clip keeps its sound"
            sbVideoProgress.delete(k); sbVideoGpu.delete(k);
            sbVideoBusy.delete(k);
            broadcast({ kind: 'storyboard', phase: 'video', board: board.id, shot: shot.id, ok: !f });
            return f;
          });
        };
        sbVideoErr.delete(k);
        if (be.gpu === true) {   // a local GPU backend: ONE heavy GPU job at a time, in the shared jobs slot (blocks keyframes, is blocked by them)
          if (deferredInFlight || lock.isHeld()) { sendJSON(res, 409, busyRefusal()); return; }
          const started = jobs.start({ kind: 'video', label: 'Video shot ' + nr }, async (jid, signal) => {   // <v2-choice> the slot's AbortSignal = the stop path (POST /stop -> jobs.cancel)
            let ret;
            const onProgress = (t) => { sbVideoProgress.set(k, String(t)); broadcast({ kind: 'storyboard', phase: 'progress', board: board.id, shot: shot.id, text: String(t), ok: true }); };   // the page patches ONLY the progress text for this phase
            try { ret = be.start(sreq, { confirmed, signal, onProgress }); } catch (e) { ret = Promise.reject(e); }
            const f = await settle(ret);
            if (f && lastV && typeof lastV === 'object' && lastV.stopped === true) { sbStops.set(jid, lastV.cancel || null); for (const old of [...sbStops.keys()].slice(0, -20)) sbStops.delete(old); }
            if (f && lastV && typeof lastV === 'object' && lastV.stopped === true) return 'Video shot ' + nr + ' stopped';   // a stop is not a failure
            if (f) throw new Error(f);
            return 'Video shot ' + nr + ' ready';
          });
          if (!started.started) { sendJSON(res, 409, { error: started.reason, busy: true }); return; }
          sbVideoBusy.set(k, true); sbVideoGpu.set(k, started.id); sbVideoNote.delete(k); sbVideoProgress.delete(k);
          sendJSON(res, 200, view());
          return;
        }
        let ret;
        try { ret = be.start(sreq, { confirmed }); }
        catch (e) { sendJSON(res, 400, { error: String((e && e.message) || e) }); return; }
        if (ret && typeof ret.then === 'function') settle(ret);
        else { const f = failOf(ret); if (f) { sendJSON(res, 400, { error: f }); return; } }
        sendJSON(res, 200, view());
        return;
      }
    }
    // </v1b3-actions>
    if (method === 'POST' && ['/storyboards/create', '/storyboards/update', '/storyboards/activate', '/storyboards/trash', '/storyboards/restore'].includes(urlPath)) {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (_) { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJSON(res, 400, { error: 'request body must be a JSON object' }); return; }
      const id = typeof body.id === 'string' ? body.id : '';
      let r;
      if (urlPath === '/storyboards/create') r = storyboard.createBoard({ title: body.title, group: body.group });
      else if (urlPath === '/storyboards/update') r = storyboard.updateBoard(id, { title: body.title, group: body.group, aspect: body.aspect, cast: body.cast });
      else if (urlPath === '/storyboards/activate') r = storyboard.setActive(id);
      else if (urlPath === '/storyboards/trash') r = storyboard.trashBoard(id);
      else r = storyboard.restoreBoard(id);
      if (!r.ok) { sendJSON(res, sbStatus(r.error), { error: r.error }); return; }
      const groups = storyboard.boardsState().groups || [];
      sendJSON(res, 200, { ok: true, active: r.active, boards: r.boards, groups, ...(r.created ? { created: r.created } : {}), ...(r.trashed ? { trashed: r.trashed } : {}) });
      return;
    }
  }
  // </v1-storyboard>

  // ── GET /library/sounds · GET /library/sfx (<l1-library>) ─────────────────
  // The Library's Sound (= voice takes) and SFX tabs: the existing listings, one source each, no new records.
  if (method === 'GET' && urlPath === '/library/sounds') {
    sendJSON(res, 200, { items: voice.listTakes() });
    return;
  }
  if (method === 'GET' && urlPath === '/library/sfx') {
    sendJSON(res, 200, { items: sfx.listClips() });
    return;
  }

  // ── POST /images/use { path } ─────────────────────────────────────────────
  // Make a recorded image the current one - the same state /upload sets, nothing copied or moved.
  if (method === 'POST' && urlPath === '/images/use') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const p = body && typeof body.path === 'string' ? servable.relativeForm(workingDir, body.path) : '';   // records and /file?p= use the relative form
    const rec = (!p || p.includes('..')) ? null : records.readRecords({ kinds: ['image', 'i2i', 'upload'] }).find(r => r.path === p);   // <l1-library> imported images can be used too
    if (!rec) { sendJSON(res, 400, { error: 'not a recorded image' }); return; }
    const abs = path.resolve(workingDir, p);
    let isFile = false;
    try { isFile = fs.statSync(abs).isFile(); } catch (_) {}
    if (!isFile) { sendJSON(res, 404, { error: 'file is gone' }); return; }
    const roots = servable.servableImageError(workingDir, p);   // the one path rule (links, roots)
    if (roots) { sendJSON(res, 400, { error: roots }); return; }
    state.lastImage         = abs;
    state.lastImageCategory = (rec.kind !== 'upload' && typeof rec.category === 'string' && rec.category) ? rec.category : 'item';   // <l1-library> 'imported' is a gallery group, not a seat category
    state.lastImageDesc     = path.basename(abs, path.extname(abs));
    a.saveState(state);
    const url = '/file?p=' + encodeURIComponent(p);
    broadcast({ kind: 'artifact', slot: 'image', url, source: 'library' });
    sendJSON(res, 200, { ok: true, url });
    return;
  }


  // ── GET /brushes ──────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/brushes') {
    let brushes = [];
    try { brushes = a.listBrushesData().map(b => ({ ...b, posterStamp: brushBackend.brushKey(b.slug), glbFresh: brushBackend.brushGlbFresh(b.slug), previewError: brushPreviews.status().failed[b.slug] || null })); } catch (_) {}
    sendJSON(res, 200, { brushes, previews: brushPreviews.status() });
    return;
  }

  // ── GET /materials ──────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/materials') {
    let materials = [];
    try { materials = a.listMaterialsData(); } catch (_) {}
    sendJSON(res, 200, { materials });
    return;
  }

  // ── GET /bugreport ─────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/bugreport') {
    const { spawn } = require('child_process');
    const preflight = await new Promise(resolve => {
      const child = spawn('node', [path.join(__dirname, 'preflight.js')], { encoding: 'utf8' });
      const out = []; let done = false;
      const finish = (extra) => { if (!done) { done = true; resolve(out.join('') + (extra || '')); } };
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish('\n[FAIL] preflight timed out'); }, 20000);
      child.stdout.on('data', d => out.push(d.toString()));
      child.stderr.on('data', d => out.push(d.toString()));
      child.on('error', e => { clearTimeout(timer); finish('\n[FAIL] could not launch preflight: ' + e.message); });
      child.on('close', () => { clearTimeout(timer); finish(); });
    });
    let version = '?';
    try { version = a.loadConfig().version || '?'; } catch (_) {}
    let logTail = '';
    try { logTail = a.tsTailDebugLog(); } catch (e) { logTail = '(log tail unavailable: ' + e.message + ')'; }
    const report = [
      'Phoenix bug report',
      'Version: ' + version,
      'Generated: ' + new Date().toISOString(),
      '',
      '=== Preflight ===',
      preflight.trim(),
      '',
      '=== Debug log tail (last ~40 lines) ===',
      logTail,
    ].join('\n');
    // Tell the dialog whether direct sending is even possible, so it can hide a button that
    // could only ever fail. Without an endpoint configured, "Copy bug report" is the whole feature.
    let canSend = false;
    try { canSend = !!(a.loadConfig().feedback || {}).endpointUrl; } catch (_) {}
    let mailTo = 'info@laconova.com';
    try { const m = String((a.loadConfig().feedback || {}).mailTo || '').trim(); if (/^[^\s\x00-\x1f@<>"?&%=#\/\\:]+@[^\s\x00-\x1f@<>"?&%=#\/\\:]+\.[^\s\x00-\x1f@<>"?&%=#\/\\:]+$/.test(m)) mailTo = m; } catch (_) {}
    sendJSON(res, 200, { report, canSend, mailTo });
    return;
  }

  // ── POST /feedback ───────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/feedback') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    const message = (body && typeof body.message === 'string') ? body.message.trim() : '';
    if (!message) { sendJSON(res, 400, { error: 'Message is required.' }); return; }
    const fresh = a.loadConfig();
    const url = fresh.feedback && fresh.feedback.endpointUrl;
    if (!url) { sendJSON(res, 400, { error: 'Feedback endpoint is not configured. Set it in Settings.' }); return; }
    const payload = {
      message,
      contact: (body && typeof body.contact === 'string') ? body.contact.trim() : '',
      report:  (body && typeof body.report  === 'string') ? body.report  : '',
      context: (body && typeof body.context === 'string') ? body.context : '',
      version: (fresh.version || ''),
    };
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
      if (r.ok) { sendJSON(res, 200, { ok: true }); }
      else { sendJSON(res, 502, { error: 'Feedback endpoint returned ' + r.status }); }
    } catch (e) {
      sendJSON(res, 502, { error: 'Could not reach feedback endpoint: ' + String(e.message || e) });
    }
    return;
  }

  // ── POST /preflight ──────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/preflight') {
    const { spawn } = require('child_process');
    const child = spawn('node', [path.join(__dirname, 'preflight.js')], { encoding: 'utf8' });
    const out = [];
    let done = false;
    const finish = (extra) => {
      if (done) return; done = true;
      sendJSON(res, 200, { output: out.join('') + (extra || '') });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish('\n[FAIL] preflight timed out (15s)'); }, 15000);
    child.stdout.on('data', d => out.push(d.toString()));
    child.stderr.on('data', d => out.push(d.toString()));
    child.on('error', e => { clearTimeout(timer); finish('\n[FAIL] could not launch preflight: ' + e.message); });
    child.on('close', () => { clearTimeout(timer); finish(); });
    return;
  }

  // ── POST /troubleshoot ───────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/troubleshoot') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const messages = (body && Array.isArray(body.messages)) ? body.messages : null;
    if (!messages || messages.length === 0) {
      sendJSON(res, 400, { error: 'messages array is required and must not be empty' });
      return;
    }

    // Run preflight to get fresh component status for the system prompt
    const preflightOutput = await new Promise(resolve => {
      const { spawn: _spawn } = require('child_process');
      const pChild = _spawn('node', [path.join(__dirname, 'preflight.js')], { encoding: 'utf8' });
      const pOut = [];
      let pDone = false;
      const pFinish = (extra) => { if (pDone) return; pDone = true; resolve(pOut.join('') + (extra || '')); };
      const pTimer = setTimeout(() => { try { pChild.kill(); } catch (_) {} pFinish('\n[FAIL] preflight timed out'); }, 20000);
      pChild.stdout.on('data', d => pOut.push(d.toString()));
      pChild.stderr.on('data', d => pOut.push(d.toString()));
      pChild.on('error', e => { clearTimeout(pTimer); pFinish('\n[FAIL] could not launch preflight: ' + e.message); });
      pChild.on('close', () => { clearTimeout(pTimer); pFinish(); });
    });

    // The Blender bridge has ONE command slot. While an operation is running (a human build, a
    // bake), the addon is busy and preflight's probe cannot be answered inside its timeout — it
    // then prints "Blender IPC — NOT REACHABLE", which is false AND becomes the premise the
    // troubleshooter reasons from. Say what was actually going on rather than let it guess.
    const busyNote = lock.isHeld()
      ? '\n[NOTE] A Blender operation was in progress during this check — a failing Blender IPC line ' +
        'above is expected in that situation and does NOT mean Blender is unreachable.'
      : '';

    if (!remoteOk(req, res)) return;   // <r1-remote> B2: the preflight wait (up to 20 s) sits between the body and the turn
    try {
      cfg = a.loadConfig();
      const result = await a.runTroubleshootTurn(messages, cfg, preflightOutput + busyNote);
      sendJSON(res, 200, { text: result.text, messages: result.messages });
    } catch (err) {
      sendJSON(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  // ── POST /config ─────────────────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/config') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }   // D2 (M9 Amendment 1)
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    async function pingURL(url) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return r.ok; } catch (_) { return false; }
    }

    const fresh = a.loadConfig();
    if (!fresh.gates || typeof fresh.gates !== 'object') fresh.gates = {};
    if (!fresh.seats || typeof fresh.seats !== 'object') fresh.seats = {};
    if (!fresh.seats.orchestrator || typeof fresh.seats.orchestrator !== 'object') fresh.seats.orchestrator = {};
    if (!fresh.seats.metaprompter || typeof fresh.seats.metaprompter !== 'object') fresh.seats.metaprompter = {};
    if (!fresh.endpoints || typeof fresh.endpoints !== 'object') fresh.endpoints = {};
    if (!fresh.apps || typeof fresh.apps !== 'object') fresh.apps = {};
    if (!fresh.feedback || typeof fresh.feedback !== 'object') fresh.feedback = {};
    if (!fresh.unreal || typeof fresh.unreal !== 'object') fresh.unreal = {};

    const hasGates = body && typeof body.gates === 'object' && body.gates !== null;
    const hasOrch  = body && typeof body.orchestrator === 'object' && body.orchestrator !== null;
    const hasMeta  = body && typeof body.metaprompter === 'object' && body.metaprompter !== null;
    const hasEps   = body && typeof body.endpoints === 'object' && body.endpoints !== null;
    const hasApps  = body && typeof body.apps === 'object' && body.apps !== null;
    const hasFb    = body && typeof body.feedback === 'object' && body.feedback !== null;
    const hasUnreal = body && typeof body.unreal === 'object' && body.unreal !== null;
    const hasSeats = body && typeof body.seats === 'object' && body.seats !== null && !Array.isArray(body.seats);
    const hasCp    = body && typeof body.checkpoints === 'object' && body.checkpoints !== null && !Array.isArray(body.checkpoints);
    const hasMcp   = body && typeof body.mcp === 'object' && body.mcp !== null && !Array.isArray(body.mcp);
    const hasRemesh = body && typeof body.remesh === 'object' && body.remesh !== null && !Array.isArray(body.remesh);
    const hasVideo = body && typeof body.video === 'object' && body.video !== null && !Array.isArray(body.video);
    const hasVoice = body && typeof body.voice === 'object' && body.voice !== null && !Array.isArray(body.voice);
    const hasRemote = body && typeof body.remote === 'object' && body.remote !== null && !Array.isArray(body.remote);   // <r1-remote>

    if (!hasGates && !hasOrch && !hasMeta && !hasEps && !hasApps && !hasFb && !hasUnreal && !hasSeats && !hasCp && !hasMcp && !hasRemesh && !hasVideo && !hasVoice && !hasRemote) {
      sendJSON(res, 400, { error: 'No settings provided.' });
      return;
    }
    if (hasRemote && (typeof body.remote.enabled !== 'boolean' || Object.keys(body.remote).some(k => k !== 'enabled'))) {   // <r1-remote> the section carries the one switch, nothing else
      sendJSON(res, 400, { error: 'remote.enabled must be true or false.', field: 'remote' });
      return;
    }

    // Stage validated changes (only applied on full success)
    const staged = { gates: {}, orchestrator: {}, metaprompter: {}, endpoints: {}, apps: {}, feedback: {}, unreal: {}, seats: {} };

    if (hasGates) {
      for (const k of ['prompt', 'image', 'mesh']) {
        if (k in body.gates) staged.gates[k] = !!body.gates[k];
      }
      // vision is a MODE, not a checkbox — off | focused | full. Validated here so a
      // typo can't silently land in the config and get read back as the default.
      if ('vision' in body.gates) {
        const v = String(body.gates.vision);
        if (!['off', 'focused', 'full'].includes(v)) {
          sendJSON(res, 400, { error: 'Render vision must be off, focused or full.', field: 'vision' });
          return;
        }
        staged.gates.vision = v;
      }
      // mode = the DEFAULT run mode (the chat toggle picks per message). ask | auto, nothing else.
      if ('mode' in body.gates) {
        if (body.gates.mode !== 'ask' && body.gates.mode !== 'auto') {
          sendJSON(res, 400, { error: 'Run mode must be ask or auto.', field: 'mode' });
          return;
        }
        staged.gates.mode = body.gates.mode;
      }
    }

    // Checkpoints (v1.9 M5): enabled bool, keep int 1–100, maxGB number 0.1–100.
    const stagedCp = {};
    if (hasCp) {
      const c = body.checkpoints;
      if ('enabled' in c) {
        if (typeof c.enabled !== 'boolean') { sendJSON(res, 400, { error: 'Checkpoints enabled must be true or false.', field: 'enabled' }); return; }
        stagedCp.enabled = c.enabled;
      }
      if ('keep' in c) {
        if (!Number.isInteger(c.keep) || c.keep < 1 || c.keep > 100) { sendJSON(res, 400, { error: 'Checkpoints to keep must be an integer between 1 and 100.', field: 'keep' }); return; }
        stagedCp.keep = c.keep;
      }
      if ('maxGB' in c) {
        if (typeof c.maxGB !== 'number' || !Number.isFinite(c.maxGB) || c.maxGB < 0.1 || c.maxGB > 100) { sendJSON(res, 400, { error: 'Checkpoint disk budget must be a number between 0.1 and 100 GB.', field: 'maxGB' }); return; }
        stagedCp.maxGB = c.maxGB;
      }
    }

    // MCP (v1.9 M6 / M6.1): allowBlenderRun / allowUnrealRun / allowDelete must be real booleans.
    const stagedMcp = {};
    const MCP_FLAG_LABEL = { allowBlenderRun: 'Allow blender_run over MCP', allowUnrealRun: 'Allow unreal_run over MCP', allowDelete: 'Allow deleting library files over MCP' };
    if (hasMcp) {
      for (const flag of MCP_FLAGS) {
        if (!(flag in body.mcp)) continue;
        if (typeof body.mcp[flag] !== 'boolean') { sendJSON(res, 400, { error: MCP_FLAG_LABEL[flag] + ' must be true or false.', field: flag }); return; }
        stagedMcp[flag] = body.mcp[flag];
      }
    }

    // Remesh (v1.9 M9): enabled bool · provider 'meshy' · topology quad|triangle · targetPolycount int 100–300000 · maxUploadMB number 1–500.
    // A bad field saves nothing from this request. No other key (meshyBase is a test seam, config-file only) is taken from the body.
    const stagedRemesh = {};
    if (hasRemesh) {
      const rm = body.remesh;
      if ('enabled' in rm) {
        if (typeof rm.enabled !== 'boolean') { sendJSON(res, 400, { error: 'Allow remesh must be true or false.', field: 'enabled' }); return; }
        stagedRemesh.enabled = rm.enabled;
      }
      if ('provider' in rm) {
        if (rm.provider !== 'meshy') { sendJSON(res, 400, { error: 'Remesh provider must be meshy.', field: 'provider' }); return; }
        stagedRemesh.provider = 'meshy';
      }
      if ('topology' in rm) {
        if (rm.topology !== 'quad' && rm.topology !== 'triangle') { sendJSON(res, 400, { error: 'Remesh topology must be quad or triangle.', field: 'topology' }); return; }
        stagedRemesh.topology = rm.topology;
      }
      if ('targetPolycount' in rm) {
        if (!Number.isInteger(rm.targetPolycount) || rm.targetPolycount < 100 || rm.targetPolycount > 300000) { sendJSON(res, 400, { error: 'Remesh target polycount must be an integer between 100 and 300000.', field: 'targetPolycount' }); return; }
        stagedRemesh.targetPolycount = rm.targetPolycount;
      }
      if ('maxUploadMB' in rm) {
        if (typeof rm.maxUploadMB !== 'number' || !Number.isFinite(rm.maxUploadMB) || rm.maxUploadMB < 1 || rm.maxUploadMB > 500) { sendJSON(res, 400, { error: 'Remesh upload limit must be a number between 1 and 500 MB.', field: 'maxUploadMB' }); return; }
        stagedRemesh.maxUploadMB = rm.maxUploadMB;
      }
    }

    // Video (v1.10 V3): { fal: { enabled: bool, audio: bool } } - the ONLY fields taken from the body (audio since LC2a). baseUrl / model / pricePerSecond / timeouts are config-file only
    // (like meshyBase). A bad field saves nothing from this request.
    const stagedVideoFal = {};
    if (hasVideo) {
      const vf = body.video.fal;
      if (vf !== undefined) {
        if (!vf || typeof vf !== 'object' || Array.isArray(vf)) { sendJSON(res, 400, { error: 'Video settings must be an object.', field: 'fal' }); return; }
        if ('enabled' in vf) {
          if (typeof vf.enabled !== 'boolean') { sendJSON(res, 400, { error: 'Allow video must be true or false.', field: 'enabled' }); return; }
          stagedVideoFal.enabled = vf.enabled;
        }
        if ('audio' in vf) {   // <lc2a-fal-audio> the default for "generate sound with the video"
          if (typeof vf.audio !== 'boolean') { sendJSON(res, 400, { error: 'Generate sound must be true or false.', field: 'audio' }); return; }
          stagedVideoFal.audio = vf.audio;
        }
      }
    }

    // Voice (v1.10 VO1b): { dispatcherLocal, installRoot, port, watermark, consentAck } - exactly these keys, validated in voice.js.
    // A bad field saves nothing from this request.
    let stagedVoice = null;
    if (hasVoice) {
      const vv = voice.validateSettings(body.voice);
      if (vv.error) { sendJSON(res, 400, { error: vv.error, field: vv.field }); return; }
      stagedVoice = vv.staged;
    }

    // Validate historyMessages (cheap, synchronous)
    if (hasOrch && 'historyMessages' in body.orchestrator) {
      const hm = body.orchestrator.historyMessages;
      if (!Number.isInteger(hm) || hm < 1 || hm > 50) {
        sendJSON(res, 400, { error: 'History length must be an integer between 1 and 50.', field: 'historyMessages' });
        return;
      }
      staged.orchestrator.historyMessages = hm;
    }

    // Step timeout (S1 T7-7): seconds, 60..1800.
    if (hasOrch && 'stepTimeoutS' in body.orchestrator) {
      const st = body.orchestrator.stepTimeoutS;
      if (!Number.isInteger(st) || st < 60 || st > 1800) {
        sendJSON(res, 400, { error: 'Step timeout must be an integer between 60 and 1800 seconds.', field: 'stepTimeoutS' });
        return;
      }
      staged.orchestrator.stepTimeoutS = st;
    }

    // Tool budget per turn (Ask / Auto) — same integer rule as historyMessages.
    for (const [key, label] of [['maxToolCalls', 'Tool steps per turn (Ask)'], ['maxToolCallsAuto', 'Tool steps per turn (Auto)']]) {
      if (hasOrch && key in body.orchestrator) {
        const n = body.orchestrator[key];
        if (!Number.isInteger(n) || n < 1 || n > 50) {
          sendJSON(res, 400, { error: label + ' must be an integer between 1 and 50.', field: key });
          return;
        }
        staged.orchestrator[key] = n;
      }
    }

    // Validate model (async, live probe)
    if (hasOrch && 'model' in body.orchestrator) {
      const model = body.orchestrator.model;
      if (!model || typeof model !== 'string') {
        sendJSON(res, 400, { error: 'Model must be a non-empty string.', field: 'model' });
        return;
      }
      // Only probe if the model actually changed — saving other fields shouldn't
      // depend on a live Claude probe of an already-active model.
      if (model !== fresh.seats.orchestrator.model) {
        // Legacy field = a Claude model unless the seat is explicitly on another provider.
        const cand = { ...fresh.seats.orchestrator, model };
        if (!cand.provider) cand.provider = 'claude-cli';
        const { ok, msg } = await provValidateSeat('orchestrator', cand, fresh);
        if (!ok) {
          sendJSON(res, 400, { error: 'Model "' + model + '" was not accepted' + (cand.provider === 'claude-cli' ? ' by the Claude CLI' : '') + ': ' + msg, field: 'model' });
          return;
        }
        // Same tool-test gate as seats.orchestrator (v1.9 M2): a model change never bypasses it.
        let would = null;
        try { would = providers.resolveSeat('orchestrator', { ...fresh, seats: { ...fresh.seats, orchestrator: cand } }, {}); } catch (_) {}
        if (would) {
          const caps = capabilities.getCaps(would);
          if (!caps) { sendJSON(res, 400, { error: 'Test this model first (Settings runs the tool test automatically).', field: 'model' }); return; }
          if (caps.tools === 'fail') {
            const okN = (caps.trials || []).filter(t => t.ok).length;
            const why = ((caps.trials || []).find(t => !t.ok) || {}).why || 'failed';
            sendJSON(res, 400, { error: (would.model || 'Codex default') + ' did not drive the tool protocol (' + okN + '/3: ' + why + ') — use it as metaprompter or category model instead.', field: 'model' });
            return;
          }
          const benchErr = benchGateError(would, caps);
          if (benchErr) { sendJSON(res, 400, { error: benchErr, field: 'model' }); return; }
        }
      }
      staged.orchestrator.model = model;
    }

    // Validate local endpoint (async, ping)
    if (hasEps && 'local' in body.endpoints) {
      const local = body.endpoints.local;
      if (!local || !/^https?:\/\//.test(local)) {
        sendJSON(res, 400, { error: 'LM Studio endpoint must be an http(s) URL.', field: 'local' });
        return;
      }
      // Only ping if the endpoint changed — don't block saving other fields when
      // LM Studio happens to be closed and the URL is unchanged.
      if (local !== fresh.endpoints.local) {
        const reachable = await pingURL(local.replace(/\/$/, '') + '/models');
        if (!reachable) {
          sendJSON(res, 400, { error: 'LM Studio endpoint not reachable at ' + local + '.', field: 'local' });
          return;
        }
      }
      staged.endpoints.local = local;
    }

    // Validate comfyui endpoint (async, ping)
    if (hasEps && 'comfyui' in body.endpoints) {
      const comfyui = body.endpoints.comfyui;
      if (!comfyui || !/^https?:\/\//.test(comfyui)) {
        sendJSON(res, 400, { error: 'ComfyUI endpoint must be an http(s) URL.', field: 'comfyui' });
        return;
      }
      if (comfyui !== fresh.endpoints.comfyui) {
        const reachable = await pingURL(comfyui.replace(/\/$/, '') + '/system_stats');
        if (!reachable) {
          sendJSON(res, 400, { error: 'ComfyUI endpoint not reachable at ' + comfyui + '.', field: 'comfyui' });
          return;
        }
      }
      staged.endpoints.comfyui = comfyui;
    }

    // OpenAI endpoint (v1.9): only the URL is settable; its key reference is always "openai" and the
    // key itself goes through POST /secrets, never through this file.
    if (hasEps && 'openai' in body.endpoints) {
      const o = body.endpoints.openai;
      const u = (o && typeof o === 'object') ? o.url : o;
      if (typeof u !== 'string' || !/^https?:\/\//.test(u.trim())) {
        sendJSON(res, 400, { error: 'OpenAI endpoint must be an http(s) URL.', field: 'openai' });
        return;
      }
      staged.endpoints.openai = { url: u.trim(), apiKeyRef: 'openai' };
    }

    // Validate metaprompter model (probe only Claude models, only if changed)
    if (hasMeta && 'model' in body.metaprompter) {
      const mm = body.metaprompter.model;
      if (typeof mm !== 'string' || !mm.trim()) {
        sendJSON(res, 400, { error: 'Metaprompter model must be a non-empty string.', field: 'metaprompter' });
        return;
      }
      // Probe only Claude-CLI models (a local model is JIT-loaded and may not be listed yet).
      let mmProvider = null;
      try { mmProvider = providers.resolveSeat('metaprompter', { ...fresh, seats: { ...fresh.seats, metaprompter: { ...fresh.seats.metaprompter, model: mm.trim() } } }, {}).provider; } catch (_) {}
      if (mmProvider === 'claude-cli' && mm !== fresh.seats.metaprompter.model) {
        const { ok, msg } = await provValidateSeat('metaprompter', { ...fresh.seats.metaprompter, model: mm.trim() }, fresh);
        if (!ok) {
          sendJSON(res, 400, { error: 'Metaprompter model "' + mm + '" was not accepted by the Claude CLI: ' + msg, field: 'metaprompter' });
          return;
        }
      }
      staged.metaprompter.model = mm.trim();
    }

    if (hasMeta && 'ejectAfterUse' in body.metaprompter) {
      staged.metaprompter.ejectAfterUse = !!body.metaprompter.ejectAfterUse;
    }

    // ── Seats (v1.9): { <name>: { provider?, model?, endpoint? } }, any subset ──
    // Each CHANGED seat is probed (CLI probe / the endpoint's /models); an unchanged one is not —
    // saving something else must not depend on a live probe. Nothing is applied until all pass.
    const forcedSeats = [];
    if (hasSeats) {
      const valCfg = { ...fresh, endpoints: { ...fresh.endpoints, ...staged.endpoints } };
      for (const [name, patch] of Object.entries(body.seats)) {
        if (!providers.SEAT_NAMES.includes(name) || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
          sendJSON(res, 400, { error: 'Unknown seat "' + name + '".', field: name });
          return;
        }
        const cur = (fresh.seats[name] && typeof fresh.seats[name] === 'object') ? fresh.seats[name] : {};
        const cand = { ...cur }, picked = {};
        for (const k of ['provider', 'model', 'endpoint']) {
          if (!(k in patch)) continue;
          // An empty model is valid only for a ChatGPT-plan (codex-cli) seat = Codex's own default.
          const toCodex = (patch.provider !== undefined ? patch.provider : cur.provider) === 'codex-cli';
          if (typeof patch[k] !== 'string' || (k === 'model' && !patch[k].trim() && !toCodex)) {
            sendJSON(res, 400, { error: 'Seat ' + k + ' must be ' + (k === 'model' ? 'a non-empty ' : 'a ') + 'string.', field: name });
            return;
          }
          cand[k] = picked[k] = patch[k].trim();
        }
        // First use of the OpenAI endpoint on an older config: seed the default (key ref is fixed).
        if (cand.endpoint === 'openai' && !valCfg.endpoints.openai) {
          staged.endpoints.openai = { url: 'https://api.openai.com/v1', apiKeyRef: 'openai' };
          valCfg.endpoints = { ...valCfg.endpoints, openai: staged.endpoints.openai };
        }
        let before = null;
        try { before = providers.resolveSeat(name, valCfg, {}); } catch (_) {}
        let after;
        try { after = providers.resolveSeat(name, { ...valCfg, seats: { ...valCfg.seats, [name]: cand } }, {}); }
        catch (e) { sendJSON(res, 400, { error: e.message, field: name }); return; }
        const changed = !before || before.provider !== after.provider || before.model !== after.model ||
          (after.provider === 'openai-compat' && before.endpointName !== after.endpointName);
        if (changed) {
          const { ok, msg } = await provValidateSeat(name, cand, valCfg);
          if (!ok) {
            sendJSON(res, 400, { error: 'Seat "' + name + '" (' + after.model + ') was not accepted: ' + msg, field: name });
            return;
          }
          // Vision gating (v1.9 M3): a local / OpenAI / ChatGPT-plan seat must have read the test card. No override
          // (no force) — the judge is the only thing that can contradict a "fixed" claim.
          if (name === 'vision' && after.provider !== 'claude-cli') {
            const vz = capabilities.getVision(after);
            if (!vz) { sendJSON(res, 400, { error: 'Test this model for vision first (Settings runs the vision test automatically).', field: name }); return; }
            if (vz.vision === 'fail') {
              const why = ((vz.visionTrials || []).find(t => !t.ok) || {}).why || 'failed';
              sendJSON(res, 400, { error: (after.model || 'Codex default') + ' did not read the test card (' + why + ') — pick a model with vision (local: load its mmproj).', field: name });
              return;
            }
          }
          // Honest gating (v1.9 M2): the orchestrator / troubleshooter must have passed the tool test.
          // The orchestrator has no override; the troubleshooter may be forced (marked in the caps store).
          if (name === 'orchestrator' || name === 'troubleshooter') {
            const caps = capabilities.getCaps(after);
            if (!caps) {
              sendJSON(res, 400, { error: 'Test this model first (Settings runs the tool test automatically).', field: name });
              return;
            }
            if (caps.tools === 'fail') {
              if (name === 'troubleshooter' && patch.force === true) forcedSeats.push(after);
              else {
                const okN = (caps.trials || []).filter(t => t.ok).length;
                const why = ((caps.trials || []).find(t => !t.ok) || {}).why || 'failed';
                sendJSON(res, 400, { error: (after.model || 'Codex default') + ' did not drive the tool protocol (' + okN + '/3: ' + why +
                  ') — use it as metaprompter or category model instead.', field: name });
                return;
              }
            }
            const benchErr = name === 'orchestrator' ? benchGateError(after, caps) : null;
            if (benchErr) { sendJSON(res, 400, { error: benchErr, field: name }); return; }
          }
        }
        staged.seats[name] = { ...picked, provider: after.provider };   // provider is always written explicitly
      }
    }

    // Validate Blender path (string; empty allowed to clear)
    if (hasApps && 'blender' in body.apps) {
      const bp = body.apps.blender;
      if (typeof bp !== 'string') {
        sendJSON(res, 400, { error: 'Blender path must be a string.', field: 'blender' });
        return;
      }
      staged.apps.blender = bp.trim();
    }

    // Validate ComfyUI output path (string; empty allowed to clear; directory need not exist)
    if (hasApps && 'comfyOutput' in body.apps) {
      const co = body.apps.comfyOutput;
      if (typeof co !== 'string') {
        sendJSON(res, 400, { error: 'ComfyUI output path must be a string.', field: 'comfyOutput' });
        return;
      }
      staged.apps.comfyOutput = co.trim();
    }

    // Validate feedback endpointUrl (format-only; no GET ping — the PHP endpoint only accepts POST)
    if (hasFb && 'endpointUrl' in body.feedback) {
      const u = body.feedback.endpointUrl;
      if (typeof u !== 'string') { sendJSON(res, 400, { error: 'Feedback endpoint must be a string.', field: 'endpointUrl' }); return; }
      const t = u.trim();
      if (t && !/^https?:\/\//.test(t)) { sendJSON(res, 400, { error: 'Feedback endpoint must be an http(s) URL (or empty to clear).', field: 'endpointUrl' }); return; }
      staged.feedback.endpointUrl = t;
    }

    // ── Unreal ───────────────────────────────────────────────────────────────
    // Enumerations are validated here rather than defaulted silently: an unknown value read back
    // as "the default" is exactly the kind of drift that later gets debugged in the wrong place.
    if (hasUnreal && 'brushTarget' in body.unreal) {
      const t = String(body.unreal.brushTarget);
      if (!['blender', 'unreal', 'both'].includes(t)) {
        sendJSON(res, 400, { error: 'Brush target must be blender, unreal or both.', field: 'brushTarget' });
        return;
      }
      staged.unreal.brushTarget = t;
    }
    if (hasUnreal && 'visionMode' in body.unreal) {
      const m = String(body.unreal.visionMode);
      if (!['off', 'camera', 'viewport'].includes(m)) {
        sendJSON(res, 400, { error: 'Vision route must be off, camera or viewport.', field: 'visionMode' });
        return;
      }
      staged.unreal.visionMode = m;
    }
    for (const [key, min, max] of [['visionWidth', 256, 3840], ['visionHeight', 144, 2160]]) {
      if (hasUnreal && key in body.unreal) {
        const n = body.unreal[key];
        if (!Number.isInteger(n) || n < min || n > max) {
          sendJSON(res, 400, { error: `${key} must be an integer between ${min} and ${max}.`, field: key });
          return;
        }
        staged.unreal[key] = n;
      }
    }

    // All validations passed — apply staged changes (isolated-field merge)
    Object.assign(fresh.gates, staged.gates);
    Object.assign(fresh.seats.orchestrator, staged.orchestrator);
    Object.assign(fresh.seats.metaprompter, staged.metaprompter);
    Object.assign(fresh.endpoints, staged.endpoints);
    for (const [name, p] of Object.entries(staged.seats)) {
      if (!fresh.seats[name] || typeof fresh.seats[name] !== 'object') fresh.seats[name] = {};
      Object.assign(fresh.seats[name], p);
    }
    if ('blender' in staged.apps) fresh.apps.blender = staged.apps.blender;
    if ('comfyOutput' in staged.apps) fresh.apps.comfyOutput = staged.apps.comfyOutput;
    if ('endpointUrl' in staged.feedback) fresh.feedback.endpointUrl = staged.feedback.endpointUrl;
    Object.assign(fresh.unreal, staged.unreal);
    if (hasCp) {
      if (!fresh.checkpoints || typeof fresh.checkpoints !== 'object') fresh.checkpoints = {};
      Object.assign(fresh.checkpoints, stagedCp);
    }
    if (hasMcp) {
      if (!fresh.mcp || typeof fresh.mcp !== 'object') fresh.mcp = {};
      Object.assign(fresh.mcp, stagedMcp);
    }
    if (hasRemesh) {
      if (!fresh.remesh || typeof fresh.remesh !== 'object') fresh.remesh = {};
      Object.assign(fresh.remesh, stagedRemesh);
    }
    if (hasVideo) {
      if (!fresh.video || typeof fresh.video !== 'object') fresh.video = {};
      if (!fresh.video.fal || typeof fresh.video.fal !== 'object') fresh.video.fal = {};
      Object.assign(fresh.video.fal, stagedVideoFal);
    }

    let voiceApplied = {};
    if (hasVoice) {
      voiceApplied = voice.applySettings(fresh, stagedVoice);
      if (voiceApplied.error) { sendJSON(res, 400, { error: voiceApplied.error, field: voiceApplied.field }); return; }
    }

    // M1.1: the seat tests / pings above can take a minute; a workflow selected meanwhile (POST /workflows) is not ours to overwrite - POST /config never edits workflows
    const latest = a.loadConfig();
    if (latest && latest.workflows) fresh.workflows = latest.workflows; else delete fresh.workflows;
    a.saveConfig(fresh);
    try { voice.dispatcherSync(); } catch (_) { /* VO1: start/stop the local voice dispatcher to match the saved config */ }
    for (const sd of forcedSeats) capabilities.markForced(sd);   // the troubleshooter was forced past a failed test
    cfg = fresh;
    let remoteOut = null;
    if (hasRemote) {   // <r1-remote> the switch is saved AFTER the attempt: a failed switch-on leaves it off, with the reason in the state line
      const rv = await remote.setEnabled(body.remote.enabled);
      const on = body.remote.enabled === true && rv.state === 'on';
      const c2 = a.loadConfig(); c2.remote = Object.assign({}, c2.remote, { enabled: on }); a.saveConfig(c2); cfg = c2;
      remoteOut = { enabled: on, state: rv.state, origin: rv.origin, error: rv.error };
    }
    sendJSON(res, 200, {
      ...(remoteOut ? { remote: remoteOut } : {}),
      unreal: {
        brushTarget:  fresh.unreal.brushTarget  || 'blender',
        visionMode:   fresh.unreal.visionMode   || 'camera',
        visionWidth:  fresh.unreal.visionWidth  || 1280,
        visionHeight: fresh.unreal.visionHeight || 720,
      },
      gates: Object.assign({}, fresh.gates, { mode: a.runConfig(fresh).mode }),
      orchestrator: { model: fresh.seats.orchestrator.model, historyMessages: fresh.seats.orchestrator.historyMessages, stepTimeoutS: a.stepTimeoutMs(fresh) / 1000,
        maxToolCalls: a.runConfig(fresh, 'ask').budget, maxToolCallsAuto: a.runConfig(fresh, 'auto').budget },
      metaprompter: { model: fresh.seats.metaprompter.model, ejectAfterUse: !!fresh.seats.metaprompter.ejectAfterUse },
      checkpoints: checkpoints.settings(fresh),
      mcp: mcpFlagsView(fresh),
      remesh: remeshView(fresh),
      video: videoView(fresh),
      voice: Object.assign(voice.settingsView(fresh), voiceApplied.rootChanged ? { rootChanged: voiceApplied.rootChanged } : {}),
      endpoints: { local: fresh.endpoints.local, comfyui: fresh.endpoints.comfyui },
      seats: seatsView(fresh),
      apps: { blender: (fresh.apps && fresh.apps.blender) || '', comfyOutput: (fresh.apps && fresh.apps.comfyOutput) || '' },
      feedback: { endpointUrl: (fresh.feedback && fresh.feedback.endpointUrl) || '' },
    });
    return;
  }

  // ── Library folders ──────────────────────────────────────────────────────
  // A VIEW over the library, not storage — see library-folders.js. Nothing on disk moves, so an
  // asset keeps working with import_asset and keeps its palette category whatever folder it is
  // filed under.
  if (method === 'GET' && urlPath === '/library-folders') {
    sendJSON(res, 200, libFolders.load());
    return;
  }

  if (method === 'POST' && urlPath === '/library-folders') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }

    let r;
    try { r = libFolders.apply(body || {}); }
    catch (e) { sendJSON(res, 500, { error: 'Could not write library-folders.json: ' + e.message }); return; }

    if (!r.ok) { sendJSON(res, 400, { error: r.error }); return; }
    sendJSON(res, 200, Object.assign({ created: r.created || null }, r.data));
    return;
  }

  // ── GET /palette ─────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/palette') {
    sendJSON(res, 200, paletteResponse());
    return;
  }

  // ── POST /palette ─────────────────────────────────────────────────────────
  // Replaces the entire categories map. Validates all entries before saving.
  // Changes affect the NEXT generation; no live session surgery needed.
  if (method === 'POST' && urlPath === '/palette') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!body || typeof body.categories !== 'object' || body.categories === null || Object.keys(body.categories).length === 0) {
      sendJSON(res, 400, { error: 'categories object required' });
      return;
    }

    const builtinKeys = Object.keys(palette.DEFAULT_PALETTE.categories);

    // Reject deletion of any builtin category
    for (const bk of builtinKeys) {
      if (!(bk in body.categories)) {
        sendJSON(res, 400, { error: 'cannot delete builtin category "' + bk + '"', field: bk });
        return;
      }
    }

    // Refuse to delete a category that still has staged GLBs. listStagedFiles() walks the
    // PALETTE's categories, not the staging folder — so dropping a category does not delete
    // its files, it makes them invisible: gone from list_assets, from read_state and from the
    // import flow, while still sitting on disk. Same stance as the brush-name collision: refuse
    // and say what to do, rather than silently taking something away.
    const stagingBase = path.join(workingDir, 'staging');
    const removed = Object.keys(palette.loadPalette().categories).filter(k => !(k in body.categories));
    for (const key of removed) {
      let glbs = [];
      try {
        glbs = fs.readdirSync(path.join(stagingBase, key)).filter(f => f.toLowerCase().endsWith('.glb'));
      } catch (_) { /* no folder = nothing staged = safe to remove */ }
      if (glbs.length) {
        sendJSON(res, 400, {
          error: 'Category "' + key + '" still holds ' + glbs.length + ' staged file(s) (' +
                 glbs.slice(0, 3).join(', ') + (glbs.length > 3 ? ', …' : '') + '). Deleting it would hide them ' +
                 'from the asset list while leaving them on disk in staging/' + key + '. Import or delete them first.',
          field: key,
        });
        return;
      }
    }

    // Validate each entry
    for (const [key, cat] of Object.entries(body.categories)) {
      const result = palette.validateCategory(key, cat);
      if (!result.ok) {
        sendJSON(res, 400, { error: result.error, field: result.field });
        return;
      }
    }

    // v1.10 ADV: per-category param directives - { <key>: { override:true, value } | { override:false } }, either as the category's own
    // fields or under cat.params - go to the workflow that declares the key (active image workflow first, then the active mesh workflow).
    // Anything else for a param (a plain number from an old client) is ignored. Validated BEFORE anything is written.
    const advCfg = a.loadConfig();
    const ownerOf = (k) => { for (const st of ['image', 'mesh']) { try { const w = workflows.getActive(st, advCfg); if (wfp.declared(w.id).some(d => d.key === k)) return w.id; } catch (_) {} } return null; };
    const directives = [];
    for (const [key, cat] of Object.entries(body.categories)) {
      const src = {};
      if (cat && cat.params && typeof cat.params === 'object' && !Array.isArray(cat.params)) Object.assign(src, cat.params);
      for (const k of Object.keys(cat)) if (cat[k] && typeof cat[k] === 'object' && !Array.isArray(cat[k]) && 'override' in cat[k]) src[k] = cat[k];
      for (const [k, d] of Object.entries(src)) {
        if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
        const owner = ownerOf(k);
        if (!owner) continue;
        if (d.override === true) {
          const v = wfp.validate(owner, k, d.value);
          if (v.error) { sendJSON(res, 400, { error: v.error, field: key }); return; }
          const badS = await advSamplerCheck(owner, k, d.value);   // same sampler rule as the Advanced section
          if (badS) { sendJSON(res, 400, { error: badS.error, field: key }); return; }
          directives.push({ owner, key, k, set: true, value: v.value });
        } else if (d.override === false) directives.push({ owner, key, k, set: false });
      }
    }

    if (!remoteOk(req, res)) return;   // <r1-remote> B2: the sampler probes above are awaits between the body and the write

    // Build sanitized categories — recompute builtin from server side, drop unknown fields. cfg / steps / target_face_num are workflow
    // params now: palette.json keeps whatever it already carried for a category (rollback-safe) but never takes new values for them.
    const prevCats = palette.loadPalette().categories;
    const sanitized = {};
    for (const [key, cat] of Object.entries(body.categories)) {
      sanitized[key] = { hint: String(cat.hint), style: String(cat.style) };
      const prev = prevCats[key];
      if (prev) for (const f of wfp.PALETTE_KEYS) if (typeof prev[f] === 'number') sanitized[key][f] = prev[f];
      sanitized[key].builtin = builtinKeys.includes(key);
    }

    palette.savePalette({ version: 1, categories: sanitized });
    for (const d of directives) {
      const r = d.set ? wfp.setOverride(d.owner, d.key, d.k, d.value) : wfp.clearOverride(d.owner, d.key, d.k);
      if (r.error) { sendJSON(res, 400, { error: r.error, field: d.key }); return; }
    }
    sendJSON(res, 200, paletteResponse());
    return;
  }

  // ── POST /palette/draft ───────────────────────────────────────────────────
  // "Phoenix hilft" — drafts a palette category via the orchestrator seat.
  // Does NOT save anything — returns { hint, style, target_face_num, cfg, steps }.
  if (method === 'POST' && urlPath === '/palette/draft') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!body || typeof body.description !== 'string' || !body.description.trim()) {
      sendJSON(res, 400, { error: 'description required' });
      return;
    }

    try {
      cfg = a.loadConfig();
      const draft = await a.draftPaletteCategory({ name: body.name, description: body.description }, cfg);
      sendJSON(res, 200, draft);
    } catch (e) {
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }

  // ── POST /palette/reset ──────────────────────────────────────────────────
  // Reset a single builtin category to its default values. Custom categories
  // cannot be reset (they have no default to reset to).
  if (method === 'POST' && urlPath === '/palette/reset') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!body || typeof body.key !== 'string' || !body.key.trim()) {
      sendJSON(res, 400, { error: 'key required' });
      return;
    }

    const builtinKeys = Object.keys(palette.DEFAULT_PALETTE.categories);
    if (!builtinKeys.includes(body.key)) {
      sendJSON(res, 400, { error: 'not a builtin category', field: 'key' });
      return;
    }

    const pal = palette.loadPalette();
    pal.categories[body.key] = JSON.parse(JSON.stringify(palette.DEFAULT_PALETTE.categories[body.key]));
    palette.savePalette(pal);
    // v1.10 ADV: this category's palette-derived overrides follow what contract 3's seeding gives from DEFAULT_PALETTE (workflow-params.js)
    {
      let rr;
      try {
        const rc = a.loadConfig();
        rr = wfp.resetCategory(body.key, palette.DEFAULT_PALETTE.categories[body.key], ['image', 'mesh'].map(st => workflows.getActive(st, rc).id));
      } catch (e) { rr = { error: String(e && e.message || e), field: 'file' }; }
      if (rr && rr.error) { sendJSON(res, 500, { error: 'The category\'s style was reset, but its parameters could not be: ' + rr.error, field: rr.field || 'file' }); return; }
    }
    sendJSON(res, 200, paletteResponse());
    return;
  }

  // <adv-routes>
  // ── v1.10 ADV · per-workflow parameters (one store: workflow-params.json; the palette editor is the second view) ──
  async function advBody() { try { const b = JSON.parse(await readBody(req)); return (b && typeof b === 'object' && !Array.isArray(b)) ? b : null; } catch (_) { return null; } }
  const advErr = (r) => sendJSON(res, r.notFound ? 404 : 400, { error: r.error, field: r.field });
  // The sampler list of the workflow's own ComfyUI (one GET, 4 s). { reachable:false } = unknown; a list only when ComfyUI really answered.
  async function advSamplers(entry) {
    try {
      const base = String(i2iEngine.baseForInstance(a.loadConfig(), entry && entry.instance)).replace(/\/+$/, '');
      const r = await fetch(base + '/object_info/KSamplerSelect', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return { reachable: false, samplers: null };
      const j = await r.json();
      const req0 = j && j.KSamplerSelect && j.KSamplerSelect.input && j.KSamplerSelect.input.required;
      const opts0 = req0 ? workflows.comboOptions(req0.sampler_name) : null;
      const list = opts0 ? opts0.filter(x => typeof x === 'string') : null;
      return list && list.length ? { reachable: true, samplers: list } : { reachable: false, samplers: null };
    } catch (_) { return { reachable: false, samplers: null }; }
  }
  function advEntry(id) { try { const r = workflows.loadRegistry(); return (r.workflows && r.workflows[id]) || null; } catch (_) { return null; } }
  // a sampler value is refused only when the live list was obtainable and does not contain it
  async function advSamplerCheck(id, key, value) {
    const d = wfp.declaredAll(id).find(x => x.key === key);
    if (!d || d.type !== 'enum' || Array.isArray(d.options) || typeof value !== 'string') return null;
    const s = await advSamplers(advEntry(id));
    return (s.samplers && !s.samplers.includes(value)) ? { error: 'sampler "' + value + '" is not offered by ComfyUI', field: key } : null;
  }

  if (method === 'GET' && urlPath === '/workflows/samplers') {
    const id = parsedUrl.searchParams.get('id') || '';
    const entry = advEntry(id);
    if (!entry) { sendJSON(res, 404, { error: 'unknown workflow', field: 'id' }); return; }
    sendJSON(res, 200, await advSamplers(entry));
    return;
  }
  if (method === 'GET' && urlPath === '/workflows/params') {
    const id = parsedUrl.searchParams.get('id') || '';
    const v = wfp.view(id);
    if (!v) { sendJSON(res, 404, { error: 'unknown workflow', field: 'id' }); return; }
    sendJSON(res, 200, v);
    return;
  }
  if (method === 'POST' && urlPath === '/workflows/params') {
    const b = await advBody();
    if (!b || typeof b.id !== 'string' || typeof b.key !== 'string') { sendJSON(res, 400, { error: 'id and key required', field: 'id' }); return; }
    if (!advEntry(b.id)) { sendJSON(res, 404, { error: 'unknown workflow', field: 'id' }); return; }
    const bad = await advSamplerCheck(b.id, b.key, b.value);
    if (bad) { sendJSON(res, 400, bad); return; }
    const r = wfp.setValue(b.id, b.key, b.value);
    if (r.error) { advErr(r); return; }
    sendJSON(res, 200, Object.assign({ ok: true, value: r.value }, wfp.view(b.id)));
    return;
  }
  if (method === 'POST' && urlPath === '/workflows/params/override') {
    const b = await advBody();
    if (!b || typeof b.id !== 'string' || typeof b.key !== 'string') { sendJSON(res, 400, { error: 'id and key required', field: 'id' }); return; }
    if (!advEntry(b.id)) { sendJSON(res, 404, { error: 'unknown workflow', field: 'id' }); return; }
    const bad = await advSamplerCheck(b.id, b.key, b.value);
    if (bad) { sendJSON(res, 400, bad); return; }
    const r = wfp.setOverride(b.id, b.category, b.key, b.value);
    if (r.error) { advErr(r); return; }
    sendJSON(res, 200, Object.assign({ ok: true, value: r.value }, wfp.view(b.id)));
    return;
  }
  if (method === 'POST' && urlPath === '/workflows/params/override/remove') {
    const b = await advBody();
    if (!b || typeof b.id !== 'string' || typeof b.key !== 'string') { sendJSON(res, 400, { error: 'id and key required', field: 'id' }); return; }
    const r = wfp.clearOverride(b.id, b.category, b.key);
    if (r.error) { advErr(r); return; }
    sendJSON(res, 200, Object.assign({ ok: true }, wfp.view(b.id)));
    return;
  }
  if (method === 'POST' && urlPath === '/workflows/params/reset') {
    const b = await advBody();
    if (!b || typeof b.id !== 'string') { sendJSON(res, 400, { error: 'id required', field: 'id' }); return; }
    const r = wfp.reset(b.id);
    if (r.error) { advErr(r); return; }
    sendJSON(res, 200, Object.assign({ ok: true }, wfp.view(b.id)));
    return;
  }
  if (method === 'POST' && urlPath === '/workflows/params/seed') {
    const b = await advBody();
    if (!b || typeof b.id !== 'string') { sendJSON(res, 400, { error: 'id required', field: 'id' }); return; }
    const r = wfp.setSeed(b.id, b.locked, b.value);
    if (r.error) { advErr(r); return; }
    sendJSON(res, 200, Object.assign({ ok: true }, wfp.view(b.id)));
    return;
  }
  // </adv-routes>

  // ── GET /workflows ───────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/workflows') {
    const reg  = workflows.loadRegistry();
    const cfg2 = a.loadConfig();
    const active = {
      image: (cfg2.workflows && cfg2.workflows.image) || workflows.DEFAULT_ACTIVE.image,
      mesh:  (cfg2.workflows && cfg2.workflows.mesh)  || workflows.DEFAULT_ACTIVE.mesh,
      i2i:   (cfg2.workflows && cfg2.workflows.i2i)   || workflows.DEFAULT_ACTIVE.i2i,
      // Stage 2d follow-up: the persisted default voice engine (Library click-to-activate below),
      // mirroring image/mesh/i2i exactly — read by the SFX picker + Voice-tab Speak on page load.
      voice: (cfg2.workflows && cfg2.workflows.voice) || workflows.DEFAULT_ACTIVE.voice,
    };
    if (cfg2.workflows && cfg2.workflows.video) active.video = cfg2.workflows.video;   // v1.10 V2: only once a video model was chosen explicitly (a plain config keeps the four-key shape; the page treats "none chosen" as the default entry)
    // Config-capability gate for voice engines: availability depends on THIS install's voice.dispatcher
    // capability (a rig-only /speak dispatcher, not shipped), which the raw registry entry can't know.
    // Overlay the EFFECTIVE blocked/blockedReason (English) that the picker + library row already honor,
    // so a dispatcher-gated engine greys out on a plain customer config with no client-side change.
    const hasDispatcher = workflows.hasDispatcher(cfg2);   // VO1: both dispatcher shapes (true | { local: true })
    const outWorkflows = {};
    for (const [id, entry] of Object.entries(reg.workflows || {})) {
      if (entry && entry.stage === 'voice') {
        const av = workflows.engineAvailability(entry, hasDispatcher);
        outWorkflows[id] = Object.assign({}, entry, {
          available:     av.available,
          blocked:       av.available ? null : (entry.blocked || (entry.requiresDispatcher ? 'dispatcher' : true)),
          blockedReason: av.available ? null : av.reason,
        });
      } else {
        outWorkflows[id] = entry;
      }
    }
    // v1.10 B1: every entry (all stages, after the voice overlay) also carries the derived display
    // facts the stage pickers show — total disk and the public FAQ link. description/faq are already
    // on the entry itself. Read-only: nothing here touches workflows.json.
    for (const id of Object.keys(outWorkflows)) {
      const e = outWorkflows[id];
      if (!e || typeof e !== 'object') continue;
      const m = workflows.workflowMeta(e);
      outWorkflows[id] = Object.assign({}, e, { disk_gb: m.disk_gb, faq_url: m.faq_url });
      // v1.10 ADV: the img2img denoise lives in workflow-params (Advanced) - the Image-tab slider starts at that value
      if (e.reference && Array.isArray(e.referenceParams)) {
        try {
          const dn = wfp.resolve(id, null).denoise;
          if (dn) outWorkflows[id].reference = Object.assign({}, e.reference, { denoiseDefault: dn.value });
        } catch (_) { /* keep the shipped default */ }
      }
    }
    // <b2r-fields> v1.10 B2r: the detail window's "Tested with" profile (per instance; voice → null) and the example ("example" in the
    // registry is {kind,file}; the response carries {kind,url} or null when there is none / the file is not on disk).
    for (const id of Object.keys(outWorkflows)) {
      const e = outWorkflows[id];
      if (!e || typeof e !== 'object') continue;
      outWorkflows[id] = Object.assign({}, e, { tested: workflows.testedProfileFor(e), example: workflows.exampleFor(e, path.join(WEB_ROOT, 'examples')) });
    }
    // </b2r-fields>
    sendJSON(res, 200, { workflows: outWorkflows, active });
    return;
  }

  // ── POST /workflows ──────────────────────────────────────────────────────
  // Sets the active workflow for a given stage (image, mesh, i2i or voice). The business rule (which
  // stages exist, entry-exists/matches-stage, image/mesh/i2i's file+node-map completeness, voice's
  // `blocked`-engine refusal) lives in workflows.validateActivate — a pure function (mirrors
  // downloader.js's validateInstall) so it's testable without an HTTP round trip; this handler stays
  // parse → validate → persist.
  if (method === 'POST' && urlPath === '/workflows') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { stage, id } = body || {};
    const reg  = workflows.loadRegistry();
    const cfg2 = a.loadConfig();
    // cfg2 carries voice.dispatcher — validateActivate refuses a dispatcher-gated engine on a config
    // that doesn't declare it, the same way it already refuses a `blocked` one.
    const v   = workflows.validateActivate(stage, id, reg, cfg2);
    if (!v.ok) {
      sendJSON(res, 400, { error: v.error, field: v.field });
      return;
    }

    cfg2.workflows = cfg2.workflows || {};
    cfg2.workflows[stage] = id;
    a.saveConfig(cfg2);
    try { localVideoBackend.invalidate(); } catch (_) { /* the next view re-probes the local video models */ }
    sendJSON(res, 200, { active: cfg2.workflows });
    return;
  }

  // ── GET /workflows/deps ──────────────────────────────────────────────────
  // Checks ALL registered workflows against one live /object_info fetch.
  // Always responds 200 — { reachable: false, error, base } when ComfyUI is
  // unreachable so the UI can render a graceful "offline" badge.
  if (method === 'GET' && urlPath === '/workflows/deps') {
    const localCfg = a.loadConfig();
    const primaryBase = (localCfg.endpoints && localCfg.endpoints.comfyui) || 'http://localhost:8188';
    const reg  = workflows.loadRegistry();

    // Instance-aware: a workflow's deps must be checked against the ComfyUI it actually runs on.
    // With several instances (Trellis on one port, Qwen-Image-Edit on another — a normal multi-env
    // setup) checking everything against one port falsely reports the other instance's nodes as
    // missing. baseForInstance maps each entry to its base (image/mesh have no `instance` → primary).
    const infoCache = {};   // base -> { info } | { error }
    async function infoFor(b) {
      if (infoCache[b] !== undefined) return infoCache[b];
      try {
        const r = await fetch(b + '/object_info', { signal: AbortSignal.timeout(8000) });
        infoCache[b] = r.ok ? { info: await r.json() } : { error: 'HTTP ' + r.status };
      } catch (e) { infoCache[b] = { error: (e && e.message) || String(e) }; }
      return infoCache[b];
    }

    const deps = {};
    let anyReachable = false;
    for (const [id, entry] of Object.entries(reg.workflows)) {
      const b = i2iEngine.baseForInstance(localCfg, entry.instance);
      const got = await infoFor(b);
      if (got.info) {
        anyReachable = true;
        deps[id] = workflows.checkDeps(entry, got.info);
      } else {
        // Instance offline: not "missing deps" but unreachable — say so in the node slot so the
        // library renders a meaningful reason rather than a bare "missing deps".
        deps[id] = { missing_nodes: ['ComfyUI ' + b + ' offline'], missing_models: [], ready: false };
      }
    }
    sendJSON(res, 200, { reachable: anyReachable, base: primaryBase, deps });
    return;
  }

  // ── GET /workflows/acquire-plan ──────────────────────────────────────────
  // Read-only: resolves the acquisition target + plan + preflight for one workflow (downloader.js —
  // Stage 1 of the package-contract downloader). Same "always structured, never a bare error" shape
  // as /workflows/deps: an unreachable/manual target is a normal 200 response, not a failure.
  if (method === 'GET' && urlPath === '/workflows/acquire-plan') {
    const id = parsedUrl.searchParams.get('id');
    if (!id) { sendJSON(res, 400, { error: 'id required' }); return; }
    const reg = workflows.loadRegistry();
    const entry = reg.workflows && reg.workflows[id];
    if (!entry) { sendJSON(res, 404, { error: 'no workflow "' + id + '"' }); return; }
    try {
      const localCfg = a.loadConfig();
      const result = await downloader.plan(localCfg, { id, ...entry });
      sendJSON(res, 200, result);
    } catch (e) {
      sendJSON(res, 500, { error: String((e && e.message) || e) });
    }
    return;
  }

  // ── GET /workflows/acquire-log?id=<id> ───────────────────────────────────
  // v1.10 B3: the (already redacted) in-memory acquire log of the last run for this workflow id.
  if (method === 'GET' && urlPath === '/workflows/acquire-log') {
    const id = parsedUrl.searchParams.get('id') || '';
    sendJSON(res, 200, { id, lines: (acquireLogs.get(id) || []).slice() });
    return;
  }

  // <b2r-env>
  // ── GET /workflows/env?instance=<name> ───────────────────────────────────
  // v1.10 B2r: what the user's own ComfyUI reports (shown next to "Tested with"). Read only: one GET /system_stats, 4 s timeout, never a POST.
  // An unreachable ComfyUI is a normal 200 { reachable:false, base }; an instance neither Phoenix nor the config knows is a 400.
  if (method === 'GET' && urlPath === '/workflows/env') {
    const instance = parsedUrl.searchParams.get('instance') || 'trellis';
    const envCfg = a.loadConfig();
    const known = new Set(Object.keys(workflows.TESTED_PROFILES).concat(Object.keys((envCfg && envCfg.comfyInstall) || {})));
    if (!known.has(instance)) { sendJSON(res, 400, { error: 'unknown instance "' + instance + '"' }); return; }
    const base = String(i2iEngine.baseForInstance(envCfg, instance)).replace(/\/+$/, '');
    try {
      const r = await fetch(base + '/system_stats', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) { sendJSON(res, 200, { reachable: false, base }); return; }
      sendJSON(res, 200, workflows.envFromSystemStats(base, await r.json()));
    } catch (_) {
      sendJSON(res, 200, { reachable: false, base });
    }
    return;
  }
  // </b2r-env>

  // <b2r-uninstall>
  // The uninstall plan / run share one context: the registry (who else uses a file), the active workflow per stage and whether an acquire runs.
  // The awaited status checks come FIRST; config, active workflows and the running-acquire state are read AFTER them, so a workflow
  // activated / an acquire started meanwhile is seen. Callers plan and move synchronously from the returned ctx (ctx.cfg is the fresh config).
  const INSTALL_CHANGED = 'The install folder changed while Phoenix was checking — try again.';
  async function uninstallContext(id, entry, _cfgU0, reg) {
    // Which OTHER workflows on the SAME install target are really installed (status 'ready') - only those keep a shared file.
    // A workflow whose own instance differs lives in another root and never counts.
    const inst = (entry && entry.instance) || 'trellis';
    const probe = async (cfgP) => {
      const set = new Set();
      for (const [oid, o] of Object.entries((reg && reg.workflows) || {})) {
        if (oid === id || !o || typeof o !== 'object') continue;
        if ((o.instance || 'trellis') !== inst) continue;
        try { if (await downloader.status(cfgP, { id: oid, ...o }) === 'ready') set.add(oid); } catch (_) {}
      }
      return set;
    };
    const targetOf = (c) => JSON.stringify([c.comfyInstall, c.endpoints]);
    // installed state and plan must come from the same config: read it, probe, read it again; if the install target changed meanwhile, probe once more
    let cfgU = a.loadConfig();
    let installed = await probe(cfgU);
    const cfgAfter = a.loadConfig();
    let changed = false;
    if (targetOf(cfgAfter) !== targetOf(cfgU)) {
      cfgU = cfgAfter; installed = await probe(cfgU);
      const cfgThird = a.loadConfig();
      if (targetOf(cfgThird) !== targetOf(cfgU)) changed = true;   // moved AGAIN: no installed set fits any target - refuse, move nothing
      cfgU = cfgThird;
    } else cfgU = cfgAfter;   // fresh state (active workflows) AFTER the awaits
    const active = {};
    for (const st of ['image', 'mesh', 'i2i', 'voice', 'video']) active[st] = (cfgU.workflows && cfgU.workflows[st]) || workflows.defaultActive(st);
    const job = jobs.info();
    const running = acquireRunning.has(id) || !!(job && job.kind === 'acquire' && job.label === (entry.label || id));
    return { registry: reg, active, running, installed, cfg: cfgU, changed };
  }

  // ── GET /workflows/uninstall-plan?id= ────────────────────────────────────
  // Read only: what an uninstall would move (remove), what stays because something else uses it (keep), and what Phoenix cannot do (manual).
  if (method === 'GET' && urlPath === '/workflows/uninstall-plan') {
    const id = parsedUrl.searchParams.get('id');
    if (!id) { sendJSON(res, 400, { error: 'id required' }); return; }
    const reg = workflows.loadRegistry();
    const entry = reg.workflows && reg.workflows[id];
    if (!entry) { sendJSON(res, 404, { error: 'no workflow "' + id + '"' }); return; }
    const cfgU = a.loadConfig();
    const ctxU = await uninstallContext(id, entry, cfgU, reg);
    if (ctxU.changed) { sendJSON(res, 409, { error: INSTALL_CHANGED, moved: [] }); return; }
    sendJSON(res, 200, downloader.uninstallPlan(ctxU.cfg, { id, ...entry }, ctxU));
    return;
  }

  // ── POST /workflows/uninstall { id, confirm:true } ───────────────────────
  // Local requests only (like /config). The plan is recomputed here — the client's view is never trusted — and the removable items are
  // MOVED to <comfyInstall root>/.phoenix-trash/<time>/. Nothing is deleted.
  if (method === 'POST' && urlPath === '/workflows/uninstall') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    const id = body && body.id;
    if (!id || typeof id !== 'string') { sendJSON(res, 400, { error: 'id required', field: 'id' }); return; }
    if (body.confirm !== true) { sendJSON(res, 400, { error: 'confirm:true required — nothing was moved' }); return; }
    const reg = workflows.loadRegistry();
    const entry = reg.workflows && reg.workflows[id];
    if (!entry) { sendJSON(res, 404, { error: 'no workflow "' + id + '"' }); return; }
    const cfgU = a.loadConfig();
    const full = { id, ...entry };
    const ctxU = await uninstallContext(id, entry, cfgU, reg);
    if (ctxU.changed) { sendJSON(res, 409, { error: INSTALL_CHANGED, moved: [] }); return; }
    // from here on everything is synchronous: plan and move see the same fresh state
    const planU = downloader.uninstallPlan(ctxU.cfg, full, ctxU);
    if (!planU.ok) { sendJSON(res, 409, { error: planU.reason, moved: [] }); return; }
    if (planU.unsafe) { sendJSON(res, 400, { error: 'refused: unsafe path in the manifest — nothing was moved', moved: [] }); return; }
    const r = downloader.uninstallMove(ctxU.cfg, full, planU);
    if (!r.ok) { sendJSON(res, 400, { error: r.error, moved: r.moved || [], trash: r.trash }); return; }
    sendJSON(res, 200, { ok: true, moved: r.moved, trash: r.trash });
    return;
  }
  // </b2r-uninstall>

  // ── POST /workflows/acquire ──────────────────────────────────────────────
  // Runs downloader.acquire() as a background job on the existing single-slot job/broadcast
  // machinery (jobs.js) — same shape as generate_image/image_to_3d: 202 accepted, progress +
  // done/error land on the SSE stream (jobs.js's own dbg.event('job', …) already turns start/done/
  // error into a broadcast notice; onProgress below adds the finer-grained per-step ticks).
  if (method === 'POST' && urlPath === '/workflows/acquire') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const id = body && body.id;
    if (!id || typeof id !== 'string') { sendJSON(res, 400, { error: 'id required', field: 'id' }); return; }
    const reg = workflows.loadRegistry();
    const entry = reg.workflows && reg.workflows[id];
    if (!entry) { sendJSON(res, 404, { error: 'no workflow "' + id + '"' }); return; }

    const localCfg = a.loadConfig();

    // #7 — route-level engine gate. The Library hides a dispatcher-gated / `blocked` voice engine, but a
    // hidden control is not a gate: refuse the acquire server-side too, so no venv is ever built for an
    // engine this install cannot use (the same engineAvailability rule GET /workflows + voice.js honor).
    if (entry.stage === 'voice') {
      const hasDispatcher = workflows.hasDispatcher(localCfg);
      const av = workflows.engineAvailability({ id, ...entry }, hasDispatcher);
      if (!av.available) {
        sendJSON(res, 403, { error: 'voice engine "' + id + '" is not available (' + av.reason + ') — refusing to build a venv for an unusable engine' });
        return;
      }
    }

    // FIX #2 — acquire runs on the single-slot background job (jobs.js), which now hands `work` an
    // AbortSignal so POST /workflows/acquire/cancel can stop it. downloader.acquire is fully async
    // (cp.spawn, not spawnSync) so it no longer freezes chat/voice/library while a multi-minute clone/
    // pip/weights fetch runs; progress + terminal state broadcast over SSE as `acquire-progress`.
    const result = jobs.start({ kind: 'acquire', label: entry.label || id }, async (_jobId, signal) => {
      // v1.10 B3: a new acquire for this id starts a fresh log; each event is redacted, then stored + broadcast.
      const redact = makeAcquireRedactor(localCfg);
      acquireLogs.set(id, []);
      acquireRunning.add(id);
      try {
        const r = await downloader.acquire(localCfg, { id, ...entry }, {
          signal,
          onProgress: (p0) => {
            const p = deepRedact(p0, redact);
            try { acquireLogPush(id, redact(acquireLogText(p))); } catch (_) {}
            broadcast({ kind: 'acquire-progress', id, ...p });
          },
        });
        const cancelled = !!(r.failed && r.failed.some(f => f.cancelled));
        const hardFailed = !cancelled && r.failed && r.failed.length > 0;
        const failedText = hardFailed ? redact(r.failed.map(f => f.name + ' (' + f.error + ')').join('; ')) : '';
        if (!cancelled && !hardFailed) { try { localVideoBackend.invalidate(); } catch (_) { /* re-probe the local video models now that files arrived */ } }
        broadcast(Object.assign({ kind: 'acquire-progress', id, phase: cancelled ? 'cancelled' : (hardFailed ? 'failed' : 'complete'),
                    summary: deepRedact({ done: r.done, skipped: r.skipped, failed: r.failed, warnings: r.warnings || [] }, redact) },
                    hardFailed ? Object.assign({ label: entry.label || id, error: failedText }, acquireFaqFields(failedText)) : {}));
        if (hardFailed) throw new Error('acquire failed: ' + failedText);
        return cancelled
          ? 'acquire cancelled — ' + (entry.label || id)
          : 'acquired ' + (entry.label || id) + ' — done:' + r.done.length + ' skipped:' + r.skipped.length + ((r.warnings && r.warnings.length) ? ' warnings:' + r.warnings.length : '');
      } catch (e) {
        const errText = redact(String((e && e.message) || e));
        broadcast(Object.assign({ kind: 'acquire-progress', id, phase: 'failed', label: entry.label || id, error: errText }, acquireFaqFields(errText)));
        throw new Error(errText);   // never the raw error: jobs.js would put its message on SSE + the debug log
      } finally {
        acquireRunning.delete(id);
        try { voice.invalidateFreeSpace(); } catch (_) {}   // R3-M1: the disk figure in Settings -> Voice engines is stale after an install
      }
    });

    if (!result.started) { sendJSON(res, 409, { error: result.reason }); return; }
    sendJSON(res, 202, { accepted: true, id: result.id });
    return;
  }

  // ── POST /workflows/acquire/cancel ────────────────────────────────────────
  // Cancel the running acquire job (FIX #2). Body: { id } — the JOB id returned by POST
  // /workflows/acquire. jobs.cancel fires the AbortSignal → downloader.acquire SIGKILLs its child and
  // marks the run cancelled; a partial download left behind carries no completion marker, so the next
  // plan()/status() reads it as NOT installed (never masked). id omitted → cancels whatever is running.
  if (method === 'POST' && urlPath === '/workflows/acquire/cancel') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} — cancel the running job */ }
    if (body === null || typeof body !== 'object') body = {};
    const r = jobs.cancel(body.id);
    if (!r.ok) { sendJSON(res, 409, { error: r.reason }); return; }
    sendJSON(res, 200, { cancelled: true, id: r.id });
    return;
  }

  // ── POST /seat-probe ─────────────────────────────────────────────────────
  // Body: { seat, provider, model, endpoint } → the tool-protocol test (3 tries) of a CANDIDATE seat; seat 'vision' → the
  // vision test (2 colour cards, M3). Only these three seats are tested; any other answers { tools:'n/a' } with no calls.
  // One probe at a time (409); same localhost-only rule as /secrets.
  if (method === 'POST' && urlPath === '/seat-probe') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    const seatName = body && body.seat;
    if (seatName !== 'orchestrator' && seatName !== 'troubleshooter' && seatName !== 'vision') { sendJSON(res, 200, { tools: 'n/a' }); return; }
    if (_probeRunning) { sendJSON(res, 409, { error: 'probe already running' }); return; }
    // Sweep 3 G: claimed SYNCHRONOUSLY (before the first await) with an owner token - three parallel probes used to all pass the check; released only by the owner
    const owner = {}; _probeRunning = owner;
    try {
      // Validate the candidate BEFORE any model call (M2.3): a wrong model for the provider is a 400 with the reason —
      // zero calls, and no caps entry is written for a combination the user never meant.
      const vErr = await validateCandidate(seatName, body);
      if (vErr) { sendJSON(res, 400, { error: vErr }); return; }
      const cand = { provider: body.provider, model: body.model, endpoint: body.endpoint };
      const cfgP = withCandidateEndpoints(a.loadConfig(), body.endpoints);
      const r = seatName === 'vision'
        ? await capabilities.probeVision(seatName, cand, cfgP, { complete: _provDeps && _provDeps.complete })   // M3: the colour-card test
        : await capabilities.probeTools(seatName, cand, cfgP, {
          buildSystemPrompt: a.buildSystemPrompt, TOOLS: a.TOOLS, parseToolCallStrict: a.parseToolCallStrict, nudge: a.TOOL_RESULT_NUDGE,
          complete: _provDeps && _provDeps.complete,
        });
      sendJSON(res, 200, r);
    } catch (e) {
      sendJSON(res, 400, { error: String((e && e.message) || e) });
    } finally { if (_probeRunning === owner) _probeRunning = false; }
    return;
  }

  // ── GET /seat-caps?seat=&provider=&model=&endpoint=&local= (LC2d T8-11) ───────────────────────────────
  // Read-only: the PERSISTED tool-test verdict (capabilities.json) of a candidate seat - the same lookup GET /config does for the saved seats. Never probes, never writes.
  // → { tools:'pass'|'fail'|'none', probedAt?, forced? }. The page decides what is fresh enough (14 days).
  if (method === 'GET' && urlPath === '/seat-caps') {
    const sp = parsedUrl.searchParams, seatName = sp.get('seat');
    if (seatName !== 'orchestrator' && seatName !== 'troubleshooter') { sendJSON(res, 200, { tools: 'none' }); return; }
    try {
      const cfg0 = withCandidateEndpoints(a.loadConfig(), sp.get('local') ? { local: sp.get('local') } : undefined);
      const cur = (cfg0.seats && cfg0.seats[seatName] && typeof cfg0.seats[seatName] === 'object') ? cfg0.seats[seatName] : {};
      const cand = {};
      for (const k of ['provider', 'endpoint']) if (sp.get(k)) cand[k] = sp.get(k);
      if (sp.has('model')) cand.model = sp.get('model');   // C1: '' is a real choice (the Codex default model) - it must not fall back to the saved seat's model
      const seat = providers.resolveSeat(seatName, { ...cfg0, seats: { ...(cfg0.seats || {}), [seatName]: { ...cur, ...cand } } }, {});
      const c = capabilities.getCaps(seat);
      sendJSON(res, 200, c ? { tools: c.tools, probedAt: c.probedAt || null, forced: !!c.forced } : { tools: 'none' });
    } catch (_) { sendJSON(res, 200, { tools: 'none' }); }
    return;
  }

  // ── POST /seat-bench ─────────────────────────────────────────────────────
  // Body: { seat:'orchestrator', provider, model, endpoint } → the 5-task competence benchmark of a CANDIDATE seat
  // in a throw-away headless Blender (its own IPC dir — the user's open Blender is never touched). Only after the
  // seat's tool test passed. Result stored on the seat's caps entry. One at a time (409); localhost only.
  if (method === 'POST' && urlPath === '/seat-bench') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    const seatName = body && body.seat;
    if (seatName !== 'orchestrator') { sendJSON(res, 400, { error: 'Only the orchestrator is benchmarked.' }); return; }
    if (_benchRunning) { sendJSON(res, 409, { error: 'benchmark already running' }); return; }
    const owner = {}; _benchRunning = owner;   // sweep 3 G: claimed synchronously, released only by the owner
    try {
    let cfg0;
    try { cfg0 = withCandidateEndpoints(a.loadConfig(), body && body.endpoints); }
    catch (e) { sendJSON(res, 400, { error: e.message, field: 'local' }); return; }
    const cur = (cfg0.seats && cfg0.seats[seatName] && typeof cfg0.seats[seatName] === 'object') ? cfg0.seats[seatName] : {};
    const cand = {};
    for (const k of ['provider', 'model', 'endpoint']) if (typeof body[k] === 'string') cand[k] = body[k];
    let seat;
    try { seat = providers.resolveSeat(seatName, { ...cfg0, seats: { ...(cfg0.seats || {}), [seatName]: { ...cur, ...cand } } }, {}); }
    catch (e) { sendJSON(res, 400, { error: String((e && e.message) || e) }); return; }
    const caps = capabilities.getCaps(seat);
    if (!caps || caps.tools !== 'pass') { sendJSON(res, 400, { error: 'Run the tool test first' }); return; }
    const vErr = await validateCandidate(seatName, body);   // M2.3: validate before any bench call
    if (vErr) { sendJSON(res, 400, { error: vErr }); return; }
    _benchProgress = { task: 0, of: bench.OF, id: '', run: 0, runs: 0 };
      const bd = (_provDeps && _provDeps.bench) || {};
      const run = (_provDeps && _provDeps.runBench) || bench.runBench;
      const r = await run(seatName, cand, cfg0, {
        complete: _provDeps && _provDeps.complete,
        ...bd,
        onProgress: (task, of, id, run, runs) => { _benchProgress = { task, of, id, run, runs }; },
      });
      const stored = (r && Number.isInteger(r.passed) && Number.isInteger(r.runs))
        ? { passed: r.passed, total: r.total, runs: r.runs, ranAt: r.ranAt || new Date().toISOString(), blender: r.blender, tasks: r.tasks || [] }
        : { unavailable: String((r && r.unavailable) || bench.NO_BLENDER), ranAt: new Date().toISOString() };
      capabilities.setBench(seat, stored);
      sendJSON(res, 200, { ...stored, local: seat.provider === 'openai-compat' && seat.kind === 'local' });
    } catch (e) {
      sendJSON(res, 400, { error: String((e && e.message) || e) });
    } finally { if (_benchRunning === owner) { _benchRunning = false; _benchProgress = null; } }
    return;
  }

  // ── GET /seat-bench-status ───────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/seat-bench-status') {
    sendJSON(res, 200, { running: !!_benchRunning, ...(_benchProgress || {}) });
    return;
  }

  // ── Video (v1.10 V3): POST /video/estimate · POST /video/make · POST /video/cancel · GET /video/status ──
  // fal.ai Kling 3 Pro, paid + opt-in. job = { shots:[{keyframe, prompt, duration_s, refs:[{kind,image,name?}]}], audio?, endKeyframe? } (see providers/fal-video.js).
  // Every path in a job must resolve inside output/. /video/make needs confirmed:true (the page showed the cost line); progress arrives as SSE 'video-progress'.
  // <v3-video>
  if (urlPath === '/video/estimate' || urlPath === '/video/make' || urlPath === '/video/cancel' || urlPath === '/video/status') {
    if (urlPath === '/video/status') {
      if (method !== 'GET') { sendJSON(res, 405, { error: 'GET only' }); return; }
      sendJSON(res, 200, a.videoStatus());
      return;
    }
    if (method !== 'POST') { sendJSON(res, 405, { error: 'POST only' }); return; }
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    if (urlPath === '/video/make' && remote.isRemoteReq(req)) { sendJSON(res, 403, REMOTE_NO_PAID); return; }   // LC2i: fal.ai costs money; /video/cancel and /video/estimate stay open to the phone
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJSON(res, 400, { error: 'request body must be a JSON object' }); return; }
    if (urlPath === '/video/cancel') {
      const c = a.videoCancel();
      if (!c.ok) { sendJSON(res, 409, { error: c.error }); return; }
      sendJSON(res, 200, { ok: true, cancelling: true });   // the job answers over SSE once fal confirmed (or did not confirm) the cancel
      return;
    }
    try {
    const fal = require('./providers/fal-video');
    const vcfg = a.loadConfig();
    const pathErr = fal.checkPaths(body.job, { outputDir: path.join(workingDir, 'output'), cwd: workingDir });
    if (pathErr) { sendJSON(res, 400, { error: a.scrubFalKey(pathErr) }); return; }
    const est = fal.estimate(body.job, vcfg);   // normalises audio (job.audio ?? config ?? true) - the same function the request is built from
    if (!est.ok) { sendJSON(res, 400, { error: a.scrubFalKey(est.error) }); return; }
    if (urlPath === '/video/estimate') { sendJSON(res, 200, { line: est.line, usd: est.usd, seconds: est.seconds, audio: est.audio }); return; }
    if (body.confirmed !== true) { sendJSON(res, 400, { error: 'This costs money — confirm first: ' + est.line, needs_confirm: true, line: est.line, usd: est.usd }); return; }
    const denied = a.videoGate(vcfg, { uiButton: true });
    if (denied) { sendJSON(res, /^BUSY/.test(denied) ? 409 : 403, { error: denied }); return; }
    // the confirmation is bound to the price: the POST carries the { line, usd } the user saw; a different or missing one is answered with the current price
    const seen = body.estimate;
    if (!seen || typeof seen !== 'object' || seen.line !== est.line || seen.usd !== est.usd) { sendJSON(res, 409, { error: 'The price changed or was not confirmed - confirm again: ' + est.line, estimate_changed: true, estimate: { line: est.line, usd: est.usd } }); return; }
    const p = a.makeVideo(body.job, vcfg, { uiButton: true, confirmed: true });
    const jobId = a.videoStatus().id || null;
    const early = await Promise.race([p.then(r => ({ r })), new Promise(resolve => setImmediate(() => resolve(null)))]);   // a refusal before any request answers in this HTTP reply
    if (early && !early.r.ok) { sendJSON(res, 400, { error: a.scrubFalKey(early.r.error) }); return; }
    sendJSON(res, 200, early ? { ok: true, jobId, result: early.r } : { ok: true, jobId });
    return;
    } catch (e) { sendJSON(res, 500, { error: a.scrubFalKey((e && e.message) || e) }); return; }   // an unexpected exception is scrubbed like every other outgoing text
  }
  // </v3-video>

  // ── GET /remesh-balance (v1.9 M9) ──────────────────────────────────────────
  // The Settings section's live "Meshy balance". The server calls Meshy with the stored key; the page only ever gets the number
  // (or "balance unavailable"). Localhost-only like /secrets. Always 200: { ok:true, balance } | { ok:false, error }.
  if (method === 'GET' && urlPath === '/remesh-balance') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    const rcfg = a.loadConfig();
    const key = providers.getKey('meshy');
    if (!key) { sendJSON(res, 200, { ok: false, error: 'no Meshy API key' }); return; }
    const b = await require('./providers/meshy').balance({ key, baseUrl: rcfg.remesh && rcfg.remesh.meshyBase });
    sendJSON(res, 200, b.ok ? { ok: true, balance: b.balance } : { ok: false, error: b.error });
    return;
  }

  // ── GET /asset-faces (v1.9 M10) ───────────────────────────────────────────
  // Source triangle count for the Remesh dialog, read from the GLB's JSON chunk only. { ok:true, tris } | { ok:false }.
  if (method === 'GET' && urlPath === '/asset-faces') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    const qs = new URL(req.url, 'http://x').searchParams;
    sendJSON(res, 200, a.assetFaces(qs.get('category') || '', qs.get('name') || ''));
    return;
  }

  // ── GET /remesh-status (v1.9 M10) ─────────────────────────────────────────
  // The running remesh for the Library badge after a page reload: { running:false } | { running:true, asset, progress }. Never the key.
  if (method === 'GET' && urlPath === '/remesh-status') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    sendJSON(res, 200, a.remeshStatus());
    return;
  }

  // ── POST /secrets ────────────────────────────────────────────────────────
  // Body: { ref, key } — key '' deletes. The response carries booleans only; no route ever returns a key.
  if (method === 'POST' && urlPath === '/secrets') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    try { providers.setKey(body && body.ref, body && body.key); }
    catch (e) { sendJSON(res, 400, { error: String((e && e.message) || e) }); return; }
    sendJSON(res, 200, { keys: providers.listKeys() });
    return;
  }

  // ── GET /provider-models?endpoint=openai ────────────────────────────────
  // Model ids an OpenAI-compatible endpoint offers (Settings datalist). Always 200, like /lmstudio/models.
  if (method === 'GET' && urlPath === '/provider-models') {
    // ?provider=codex → the ChatGPT-plan catalog + login state (always 200, never throws)
    if (parsedUrl.searchParams.get('provider') === 'codex') {
      try { sendJSON(res, 200, await providers.codexCatalog(a.loadConfig())); }
      catch (e) { sendJSON(res, 200, { reachable: false, models: [], labels: {}, loggedIn: false, error: String((e && e.message) || e) }); }
      return;
    }
    const endpoint = parsedUrl.searchParams.get('endpoint') || 'local';
    try {
      const models = await provListModels(endpoint, a.loadConfig());
      sendJSON(res, 200, { endpoint, models });
    } catch (e) {
      sendJSON(res, 200, { endpoint, models: [], error: String((e && e.message) || e) });
    }
    return;
  }

  // ── GET /lmstudio/models ─────────────────────────────────────────────────
  // Returns models currently loaded in LM Studio. Always responds 200 —
  // { reachable: false, error, base } when LM Studio is unreachable so the UI
  // can render a graceful "offline" badge (same convention as /workflows/deps).
  if (method === 'GET' && urlPath === '/lmstudio/models') {
    let localCfg;
    try { localCfg = withCandidateEndpoints(a.loadConfig(), { local: parsedUrl.searchParams.get('local') }); }   // sweep 2 G2: the URL typed in Settings
    catch (e) { sendJSON(res, 400, { error: e.message, field: 'local' }); return; }
    const result = await a.listLmStudioModels(localCfg);
    sendJSON(res, 200, result);
    return;
  }

  // ── POST /workflows/infer ────────────────────────────────────────────────
  // Infers a Phoenix node-map from a ComfyUI API-format workflow JSON.
  // Body: { stage: 'image'|'mesh'|'i2i'|'video', json: <workflow as string or object> }   (video: the answer also carries { video, from } - AW1)
  if (method === 'POST' && urlPath === '/workflows/infer') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { stage } = body || {};
    if (stage !== 'image' && stage !== 'mesh' && stage !== 'i2i' && stage !== 'video') {
      sendJSON(res, 400, { error: 'stage must be "image", "mesh", "i2i" or "video"', field: 'stage' });
      return;
    }

    const jsonText = typeof body.json === 'string' ? body.json : JSON.stringify(body.json);
    if (!jsonText) {
      sendJSON(res, 400, { error: 'json required', field: 'json' });
      return;
    }

    let prep;
    try { prep = workflows.prepareWorkflowJson(jsonText); }
    catch (e) { sendJSON(res, 400, { error: String(e.message || e) }); return; }

    try {
      cfg = a.loadConfig();
      const out = await a.inferWorkflowMap(stage, jsonText, cfg);
      sendJSON(res, 200, out);
    } catch (e) {
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }

  // ── POST /workflows/custom ───────────────────────────────────────────────
  // Saves a user-provided custom workflow entry.
  // Body: { id, label, stage, nodes, deps, json[, video] }   (video: required for stage 'video' - AW1)
  if (method === 'POST' && urlPath === '/workflows/custom') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { stage: custStage, id: custId } = body || {};
    if (custStage !== 'image' && custStage !== 'mesh' && custStage !== 'i2i' && custStage !== 'video') {
      sendJSON(res, 400, { error: 'stage must be "image", "mesh", "i2i" or "video"', field: 'stage' });
      return;
    }
    if (!custId || typeof custId !== 'string') {
      sendJSON(res, 400, { error: 'id must be a non-empty string', field: 'id' });
      return;
    }

    const jsonText = typeof body.json === 'string' ? body.json : JSON.stringify(body.json);
    if (!jsonText) {
      sendJSON(res, 400, { error: 'json required', field: 'json' });
      return;
    }

    try {
      const entry = workflows.addCustomWorkflow(
        { id: body.id, label: body.label, stage: custStage, nodes: body.nodes || {}, deps: body.deps || {}, video: body.video },
        jsonText
      );
      // LC2f: a new video entry -> measure where it runs (D3, two ComfyUIs only) and re-probe the local video backend
      let instInfo = null;
      if (custStage === 'video') {
        try { instInfo = await applyVideoInstance(a.loadConfig(), custId, body.instance_mode); } catch (_) { /* never fails the save */ }
        try { localVideoBackend.invalidate(); } catch (_) { /* the next view re-probes */ }
      }
      const reg = workflows.loadRegistry();
      sendJSON(res, 200, Object.assign({ entry: instInfo ? (reg.workflows[custId] || entry) : entry, workflows: reg.workflows }, instInfo ? { instance_info: instInfo } : {}));
    } catch (e) {
      sendJSON(res, 400, e && e.field ? { error: String(e.message || e), field: e.field } : { error: String(e.message || e) });
    }
    return;
  }

  // ── POST /workflows/instance-probe {id} | {deps:{custom_nodes,models}} (LC2f, D3) ──────────────────────────────────────────────
  // Read-only measurement: which ComfyUI would run this video workflow, and why. { two:false } with one endpoint (nothing is fetched).
  if ((method === 'POST' || method === 'GET') && urlPath === '/workflows/instance-probe') {
    if (method === 'POST' && !isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    if (method === 'GET') body = { id: parsedUrl.searchParams.get('id') || '' };   // the workflow window asks with a GET
    else try { body = JSON.parse(await readBody(req)); } catch (_) { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJSON(res, 400, { error: 'request body must be a JSON object' }); return; }
    let entryLike = null, override;
    if (typeof body.id === 'string' && body.id) {
      const e = (workflows.loadRegistry().workflows || {})[body.id];
      if (!e) { sendJSON(res, 404, { error: 'unknown workflow', field: 'id' }); return; }
      entryLike = e;
      if (method === 'POST' && body.deps && typeof body.deps === 'object' && !Array.isArray(body.deps)) entryLike = Object.assign({}, e, { deps: body.deps });   // the dialog probes with what is in its fields NOW (what Save will store)
      if (e.instance_pinned) override = e.instance === 'bild' ? 'bild' : 'main';
      else if (e.builtin === true) override = e.instance === 'bild' ? 'bild' : 'main';   // a shipped entry keeps the instance it ships with: the line only says what it is
    } else entryLike = { deps: (body.deps && typeof body.deps === 'object') ? body.deps : {} };
    if (body.instance_mode === 'main' || body.instance_mode === 'second' || body.instance_mode === 'auto') override = instanceOverride(body.instance_mode);
    if (method === 'GET' && entryLike && typeof body.id === 'string' && body.id) {
      // LC2f r2: the workflow window states the STORED target (what really runs) - never a fresh pick; a different fresh pick is a second, separate line. Nothing is written here.
      const cands = await measureVideoCandidates(a.loadConfig(), entryLike);
      if (!cands) { sendJSON(res, 200, { two: false }); return; }
      const storedKey = entryLike.instance === 'bild' ? 'bild' : 'main';
      const stored = workflows.pickVideoInstance(cands, storedKey, { quiet: true });
      const fresh = entryLike.instance_pinned || entryLike.builtin === true ? null : workflows.pickVideoInstance(cands, undefined);
      const out = { two: true, instance: stored.instance || null, line: stored.line, reason: stored.reason, ready: stored.ready, candidates: cands };
      if (fresh && fresh.key !== stored.key) out.suggest = { instance: fresh.instance || null, line: 'Phoenix would now pick ' + fresh.target + ' (' + fresh.reason + ') \u2014 save to switch' };
      sendJSON(res, 200, out);
      return;
    }
    const pick = await measureVideoInstances(a.loadConfig(), entryLike, override);
    sendJSON(res, 200, pick ? { two: true, instance: pick.instance || null, line: pick.line, reason: pick.reason, ready: pick.ready, override: pick.override, candidates: pick.candidates } : { two: false });
    return;
  }

  // ── POST /workflows/delete ───────────────────────────────────────────────
  // Deletes a custom workflow by id; resets active selection if needed.
  // Body: { id }
  if (method === 'POST' && urlPath === '/workflows/delete') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { id: delId } = body || {};
    if (!delId || typeof delId !== 'string') {
      sendJSON(res, 400, { error: 'id must be a non-empty string', field: 'id' });
      return;
    }

    // Capture the stage before deleting so we can reset active if needed
    const reg0 = workflows.loadRegistry();
    const stage0 = reg0.workflows[delId] && reg0.workflows[delId].stage;

    try {
      workflows.deleteCustomWorkflow(delId);
    } catch (e) {
      sendJSON(res, 400, { error: String(e.message || e) });
      return;
    }

    // If that id was the active selection for its stage, reset to default
    if (stage0) {
      const c = a.loadConfig();
      if (c.workflows && c.workflows[stage0] === delId) {
        if (workflows.DEFAULT_ACTIVE[stage0]) c.workflows[stage0] = workflows.DEFAULT_ACTIVE[stage0];
        else delete c.workflows[stage0];   // AW1: video's default lives in EXTRA_ACTIVE (DEFAULT_ACTIVE has none): drop the key, getActive falls back to it
        a.saveConfig(c);
        if (stage0 === 'video') { try { localVideoBackend.invalidate(); } catch (_) {} }   // the next available() re-probes the fallback workflow
      }
    }

    const reg = workflows.loadRegistry();
    sendJSON(res, 200, { workflows: reg.workflows });
    return;
  }

  // ── POST /workflows/raw ──────────────────────────────────────────────────
  // Returns the saved JSON + helper data so the edit form can prefill + build node dropdowns.
  // Body: { id }
  if (method === 'POST' && urlPath === '/workflows/raw') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const { id: rawId } = body || {};
    if (!rawId || typeof rawId !== 'string') {
      sendJSON(res, 400, { error: 'id required', field: 'id' });
      return;
    }
    const reg = workflows.loadRegistry();
    const entry = reg.workflows[rawId];
    if (!entry) {
      sendJSON(res, 400, { error: 'unknown workflow id', field: 'id' });
      return;
    }
    let jsonText, obj;
    try {
      jsonText = require('fs').readFileSync(workflows.resolveWorkflowFile(entry), 'utf8');
      obj = JSON.parse(jsonText);
    } catch (e) {
      sendJSON(res, 400, { error: 'Saved workflow file is missing or invalid: ' + entry.file });
      return;
    }
    sendJSON(res, 200, { json: jsonText, entry, nodeChoices: workflows.collectNodeChoices(obj), modelCandidates: workflows.collectModelCandidates(obj) });
    return;
  }

  // ── POST /workflows/custom/update ───────────────────────────────────────
  // Updates a custom workflow entry (label, nodes, deps).
  // Body: { id, label, nodes, deps }
  if (method === 'POST' && urlPath === '/workflows/custom/update') {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const { id: updId } = body || {};
    if (!updId || typeof updId !== 'string') {
      sendJSON(res, 400, { error: 'id required', field: 'id' });
      return;
    }
    try {
      const entry = workflows.updateCustomWorkflow(body.id, { label: body.label, nodes: body.nodes, deps: body.deps, video: body.video });
      // LC2f: the video backend caches its readiness probe per entry; an edit (frames, models, nodes) must be seen at once. Also (re-)measure where it runs (D3).
      let instInfo = null;
      if (entry && entry.stage === 'video') {
        try { instInfo = await applyVideoInstance(a.loadConfig(), body.id, body.instance_mode); } catch (_) { /* never fails the save */ }
        try { localVideoBackend.invalidate(); } catch (_) { /* the next view re-probes */ }
      }
      const reg = workflows.loadRegistry();
      sendJSON(res, 200, Object.assign({ entry: instInfo ? (reg.workflows[body.id] || entry) : entry, workflows: reg.workflows }, instInfo ? { instance_info: instInfo } : {}));
    } catch (e) {
      sendJSON(res, 400, e && e.field ? { error: String(e.message || e), field: e.field } : { error: String(e.message || e) });
    }
    return;
  }

  // ── GET /onboarding/status ───────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/onboarding/status') {
    try {
      const st = await a.onboardingStatus(a.loadConfig());
      sendJSON(res, 200, st);
    } catch (e) {
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }

  // ── POST /onboarding/complete ────────────────────────────────────────────
  if (method === 'POST' && urlPath === '/onboarding/complete') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    const completed = (body && typeof body.completed === 'boolean') ? body.completed : true;
    const cfg = a.loadConfig();
    cfg.onboarding = cfg.onboarding || {};
    cfg.onboarding.completed = completed;
    a.saveConfig(cfg);
    sendJSON(res, 200, { completed });
    return;
  }

  // ── POST /mcp/call (v1.9 M6) ───────────────────────────────────────────────
  // Body { tool, input, intent?, client? }. ONE Phoenix tool run for an external agent (Claude Code / Codex / Cursor) —
  // Phoenix's own orchestrator is not involved. Localhost-only; same doors as /chat (the chat lock, no heavy tool
  // while a background generation runs). Runs as Auto (gates off on a copy, render vision as configured) and answers
  // when the tool is done — generate_prop may keep the request open for minutes. Shown live in the chat window
  // (kind:'mcp'), never written to history.json.
  if (method === 'POST' && urlPath === '/mcp/call') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { sendJSON(res, 400, { error: 'Invalid JSON body' }); return; }
    const tool = (body && typeof body.tool === 'string') ? body.tool : '';
    const fresh = a.loadConfig();
    const mcpClass = Object.prototype.hasOwnProperty.call(MCP_CLASS, tool) ? MCP_CLASS[tool] : null;
    if (!mcpClass) { sendJSON(res, 400, { error: 'tool not available over MCP' }); return; }
    const optFlag = Object.prototype.hasOwnProperty.call(MCP_OPTIN, tool) ? MCP_OPTIN[tool] : null;
    if (optFlag && !mcpAllows(fresh, optFlag)) {
      sendJSON(res, 400, { error: 'tool not available over MCP — enable it in Phoenix Settings → Connections' });
      return;
    }
    let input = body.input === undefined ? {} : body.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) { sendJSON(res, 400, { error: 'input must be an object' }); return; }
    input = Object.assign({}, input);
    // M6.1 B2: overwriting an existing library entry destroys data a checkpoint cannot bring back -> same opt-in as the deletes.
    // Chat path unchanged (this is the MCP door only). A refusal is a tool error text, not an HTTP error.
    if (!mcpAllows(fresh, 'allowDelete')) {
      let overwrite = '';
      if (tool === 'save_as_brush' && input.overwrite) overwrite = 'overwrite:true on save_as_brush';
      else if (tool === 'save_character' && input.overwrite) overwrite = 'overwrite:true on save_character';
      else if (tool === 'unreal_to_brush' && input.force) overwrite = 'force:true on unreal_to_brush';
      else if (tool === 'assign_skeleton') {
        try {
          const abs = customRig.folderPath(input.folder);
          if (abs && (fs.existsSync(path.join(abs, 'signature.json')) || fs.existsSync(path.join(abs, 'rig.blend')))) overwrite = 're-assigning the skeleton of a folder that already has one';
        } catch (_) { /* an unreadable folder is the tool's own error */ }
      }
      if (overwrite) {
        sendJSON(res, 200, { result: "REJECTED: " + overwrite + " would overwrite an existing library entry. Overwriting needs 'Allow deleting library files' in Phoenix Settings → Connections.",
          failed: true, verdict: null, gateNote: '', stopReason: null });
        return;
      }
    }
    let intent = typeof body.intent === 'string' ? body.intent : '';
    if ('intent' in input) { if (typeof input.intent === 'string' && !intent) intent = input.intent; delete input.intent; }   // never forwarded into the tool input, string or not
    intent = intent.trim();
    if (!intent) intent = Array.from(tool + ' ' + JSON.stringify(input)).slice(0, 500).join('');
    const client = (body && typeof body.client === 'string' && body.client.trim()) ? body.client.trim().slice(0, 80) : 'mcp';
    // M9: remesh_asset is cloud work — no chat lock, not refused by a running GPU job (own one-at-a-time flag in the tool). Consent:
    // only when Settings → Cloud & keys (Meshy) is on; MCP counts as Auto. The tool re-checks the same gates (enabled, key) in the same order.
    const cloudTool = tool === 'remesh_asset';
    if (cloudTool && !(fresh.remesh && fresh.remesh.enabled === true)) {
      sendJSON(res, 200, { result: 'REJECTED: remesh uploads meshes to Meshy (paid) — enable it in Settings → Cloud & keys', failed: true, verdict: null, gateNote: '', stopReason: null });
      return;
    }
    const readOnly = mcpClass === 'R' || cloudTool;   // 'readOnly' here = takes no chat lock
    if (!readOnly && (deferredInFlight || jobs.isRunning())) {
      sendJSON(res, 409, { error: 'a background generation is running — wait for it to finish, then try again' });
      return;
    }
    if (!readOnly && !lock.tryAcquire('an agent tool')) { sendJSON(res, 409, { error: 'busy' }); return; }   // read-only tools never take the lock: parallel agent calls must not 409
    const cut = (t, n) => { const cps = Array.from(String(t)); return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join(''); };
    try {
      cfg = fresh;
      broadcast({ kind: 'mcp', client, tool, phase: 'start', text: cut(JSON.stringify(input), 300) });
      const started = Date.now();
      let runCfg = a.runConfig(cfg, 'auto').cfg;
      // generate_image over MCP stops at the image, like the Image tab: only the image gate is switched back on.
      if (tool === 'generate_image') runCfg = Object.assign({}, runCfg, { gates: Object.assign({}, runCfg.gates, { image: true }) });
      const r = await a.runOneTool(tool, input, {
        state, cfg: runCfg, turnNo: Number(state.turnSeq) || 0, history, userInput: intent,
        toolOpts: {
          holdsLock: true, mode: 'auto', checkpointLabel: 'mcp_' + tool,
          forceCheckpoint: a.MCP_FORCE_CHECKPOINT.includes(tool),
          onArtifact: (art) => {
            try {
              if (!art || !art.rel) return;
              broadcast({ kind: 'artifact', slot: art.slot || 'image', source: art.source,
                url: '/file?p=' + encodeURIComponent(art.rel) + '&t=' + Date.now() });
            } catch (_) { /* a broadcast must never break the call */ }
          },
        },
      });
      let result = typeof r.result === 'string' ? r.result : String(r.result);
      const failed = a.toolResultFailed(result);
      if (tool === 'generate_image' && !failed) {
        result += "\n\nStopped at the image. The image is in Phoenix's Image tab — the user can turn it into 3D there; generate_prop makes a new prop from text in one go.";
      }
      const out = { result, failed, verdict: r.verdict === undefined ? null : r.verdict, gateNote: r.gateNote || '', stopReason: r.stopReason || null };
      if (r.rendered || tool === 'inspect_render') {
        try {
          const st = fs.statSync(mcpRenderPath);
          if (st.size <= 4 * 1024 * 1024 && st.mtimeMs >= started - 1000) out.image = fs.readFileSync(mcpRenderPath).toString('base64');
        } catch (_) { /* no render = no image */ }
      }
      broadcast({ kind: 'mcp', client, tool, phase: 'done',
        text: cut(result, 2000) + '\n' + mcpVerdictLine(out.verdict, out.stopReason) });
      sendJSON(res, 200, out);
    } catch (e) {
      const msg = String((e && e.message) || e);
      broadcast({ kind: 'mcp', client, tool, phase: 'done', text: 'ERROR: ' + msg });
      sendJSON(res, 500, { error: msg });
    } finally {
      if (!readOnly) lock.release();
    }
    return;
  }

  // ── GET /mcp/status (v1.9 M6) — what job_status shows an MCP client ─────────
  if (method === 'GET' && urlPath === '/mcp/status') {
    if (!isLocalRequest(req)) { sendJSON(res, 403, { error: 'Cross-site request refused.' }); return; }
    sendJSON(res, 200, { job: jobs.info(), stage: pipeline.currentStage(), busy: lock.isHeld() });
    return;
  }

  // ── POST /stop ─────────────────────────────────────────────────────────────
  // Abort the running stage. Two things have to die, not one: the LOCAL
  // phoenix.js stage child, and the job ComfyUI is computing on the rig.
  // Killing only the local child leaves the GPU busy for minutes on a result
  // nobody will collect (observed 2026-08-01).
  if (method === 'POST' && urlPath === '/stop') {
    // TWO layers, not one. jobs.js owns the background slot; pipeline.js owns the
    // stage child process. A job waiting at a gate, or sitting between stages, has
    // NO child — reporting "nothing is running" there is a lie the user can see
    // through, because their job list still shows it (found 2026-08-01).
    const stage = pipeline.currentStage();
    const job   = jobs.info();
    // killCurrent stops BOTH ends now (local child + ComfyUI interrupt) — the remote
    // half used to live here, which meant only /stop cleaned up and the timeout path
    // did not.
    // v1.10 V2: the ③ Stop button sends { kind:'video', job:<id> }: it only ever stops THAT video run (a stale click never kills the next stage); the chat /stop sends nothing
    let sbody = null;
    try { sbody = JSON.parse(await readBody(req)); } catch (_) { sbody = null; }
    const videoOnly = !!(sbody && typeof sbody === 'object' && sbody.kind === 'video');
    // M4: the keyframe card's Stop names its run { kind:'keyframe', job }: it ends only THAT registered reference run, waits (max 3 s) for the slot to free, and touches nothing else
    const kfWait = async (id) => { for (let i = 0; i < 120 && jobs.info() && jobs.info().id === id; i++) await new Promise(r => setTimeout(r, 25)); };
    const kfRegistered = (id) => id != null && [...sbKeyframeRefJob.values()].includes(id);
    if (sbody && typeof sbody === 'object' && sbody.kind === 'keyframe') {
      if (!(job && Number(sbody.job) === job.id && kfRegistered(job.id))) {
        sendJSON(res, 200, { stopped: false, reason: 'that keyframe run is not the one running', stage: null, comfyui: 'not attempted', job: job ? { id: job.id, kind: job.kind, label: job.label, runningMs: Date.now() - job.startedAt } : null });
        return;
      }
      jobs.cancel(job.id);
      await kfWait(job.id);
      const still = !!(jobs.info() && jobs.info().id === job.id);
      broadcast({ kind: 'notice', text: '⛔ Stopped the keyframe.' });
      sendJSON(res, 200, { stopped: true, stage: 'keyframe', comfyui: still ? 'Stop requested - the run ends as soon as ComfyUI answers' : 'cancelled', job: { id: job.id, kind: job.kind, label: job.label, runningMs: Date.now() - job.startedAt } });
      return;
    }
    // LC2f: a video Stop that names no run (a fal shot has no local job id) cancels NOTHING - it must never hit another shot's local run that happens to hold the slot
    if (videoOnly && sbody.job == null) {
      sendJSON(res, 200, { stopped: false, reason: 'no local video run named', stage: null, comfyui: 'not attempted', job: job ? { id: job.id, kind: job.kind, label: job.label, runningMs: Date.now() - job.startedAt } : null });
      return;
    }
    const local = videoOnly ? { stopped: false, stage: null, comfyui: 'not attempted' } : await pipeline.killCurrent('user pressed /stop');

    let remote = local.comfyui;
    // a local video run lives in the jobs slot with no stage child - its AbortSignal makes the backend dequeue/interrupt its ComfyUI prompt
    let videoStopped = false;
    if (!local.stopped && job && job.kind === 'video' && (!videoOnly || Number(sbody.job) === job.id)) {
      const c = jobs.cancel(job.id);
      if (c.ok) {
        videoStopped = true;
        const waitMs = Number((((a.loadConfig() || {}).video || {}).local || {}).stopWaitMs) > 0 ? Number(a.loadConfig().video.local.stopWaitMs) : 8000;
        for (let i = 0; i < Math.ceil(waitMs / 25) && jobs.info() && jobs.info().id === job.id; i++) await new Promise(r => setTimeout(r, 25));   // the backend answers with what it really did at ComfyUI
        const ci = sbStops.get(job.id);
        const still = !!(jobs.info() && jobs.info().id === job.id);
        remote = still ? 'Stop requested — ComfyUI is not answering yet; the run ends as soon as it does'
          : !ci ? 'nothing had been sent to ComfyUI yet'
          : (ci.interrupted ? 'interrupted' : (!ci.reached ? 'ComfyUI could not be reached — nothing was interrupted' : (ci.dequeued && !ci.running ? 'removed from the queue (it had not started)' : 'nothing to interrupt (it was not running)')));
      }
    }

    // M4: a bare /stop (the chat Stop) also ends a registered reference keyframe run
    let keyframeStopped = false;
    if (!local.stopped && !videoStopped && !videoOnly && job && kfRegistered(job.id) && jobs.cancel(job.id).ok) { keyframeStopped = true; await kfWait(job.id); }
    if (keyframeStopped) {
      broadcast({ kind: 'notice', text: '⛔ Stopped the keyframe.' });
    } else if (local.stopped) {
      broadcast({ kind: 'notice', text: `⛔ Stopped the ${stage || 'running'} stage (ComfyUI: ${remote}).` });
    } else if (videoStopped) {
      broadcast({ kind: 'notice', text: '⛔ Stopped the local video (ComfyUI: ' + remote + ').' });
    }
    sendJSON(res, 200, {
      stopped:  local.stopped || videoStopped || keyframeStopped,
      stage:    stage || (videoStopped ? 'video' : (keyframeStopped ? 'keyframe' : null)),
      comfyui:  remote,
      // Reported even when nothing was killed, so the UI can say WHY it could not stop.
      job:      job ? { id: job.id, kind: job.kind, label: job.label,
                        runningMs: Date.now() - job.startedAt } : null,
    });
    return;
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  res.writeHead(404);
  res.end('404 Not Found');
}

// ─── Exports (pure functions for unit testing — usable without starting the server) ──

function _setMcpRenderPath(p) { mcpRenderPath = p; }   // test seam: where /mcp/call looks for the gate's render

// F1: the "maybe charged" warning reaches the UI directly, not only through the tool result (a chat model may paraphrase it).
a.remeshEvents.on('progress', (e) => { try { broadcast({ kind: 'notice', text: 'remesh ' + e.pct + '%', progress: 'remesh', asset: e.asset, pct: e.pct }); } catch (_) { /* no clients */ } });
a.remeshEvents.on('done', (asset) => { try { broadcast({ kind: 'notice', text: 'remesh done', progress: 'remesh', asset, done: true }); } catch (_) { /* no clients */ } });
a.remeshEvents.on('maybe-charged', (text) => { try { broadcast({ kind: 'notice', level: 'error', text: String(text) }); } catch (_) { /* no clients */ } });

// V3: video progress / end to the page (kind 'video-progress'); a possible duplicate charge is shown as a notice, like remesh
a.videoEvents.on('progress', (e) => { try { broadcast({ kind: 'video-progress', id: e.id, pct: e.pct, status: e.status, queuePosition: e.queuePosition }); } catch (_) { /* no clients */ } });
a.videoEvents.on('done', (e) => { try { broadcast(Object.assign({ kind: 'video-progress', status: e.ok ? 'DONE' : 'FAILED', pct: e.ok ? 100 : null, queuePosition: null }, e)); } catch (_) { /* no clients */ } });
a.videoEvents.on('maybe-charged', (text) => { try { broadcast({ kind: 'notice', level: 'error', text: a.scrubFalKey(text) }); } catch (_) { /* no clients */ } });

// <v3-backend> V3: the 'fal' video backend of the V1b-3 registry. One shot per call (user 13.10.); estimate() is the SAME cost line as POST /video/estimate and never
// answers null (null would read as "free" and start without a confirm) - it throws when it has no number. start() refuses without confirmed:true and sets the shot's clip itself.
function falJobOf(req, cfg) {
  const fc = (cfg && cfg.video && cfg.video.fal && typeof cfg.video.fal === 'object') ? cfg.video.fal : {};
  const job = { shots: [{ keyframe: req.startImage, prompt: req.prompt, duration_s: req.duration_s,
    refs: (Array.isArray(req.refs) ? req.refs : []).map(r => ({ kind: r.role, image: r.path, name: r.label || '' })) }] };   // audio: decided once by fal.normalizeJob (job -> config -> on)
  if (typeof req.audio === 'boolean') job.audio = req.audio;   // <lc2a-fal-audio> the per-video choice wins over the config default
  return job;
}
const falVideoBackend = {
  id: 'fal',
  label: 'fal.ai · Kling 3 Pro',
  gpu: false,   // cloud: must not take the GPU slot (V1b-3 amendment)
  available(cfg) {
    const denied = a.videoGate(cfg, { uiButton: true, ignoreBusy: true });
    return denied ? { ok: false, reason: denied.replace(/^(REJECTED|BUSY): /, '') } : { ok: true, reason: '' };
  },
  estimate(req, cfgIn) {
    const c = cfgIn || a.loadConfig();   // <lc2a-r2> M6: sbView hands in the config it already read
    const e = require('./providers/fal-video').estimate(falJobOf(req, c), c);
    if (!e.ok) throw new Error(a.scrubFalKey(e.error));
    return { line: e.line, usd: e.usd };
  },
  start(req, o) {
    // failures are RESOLVED as { ok:false, error } (V1b-3 amendment), never thrown
    const bad = (m) => Promise.resolve({ ok: false, error: a.scrubFalKey(m) });
    if (!o || o.confirmed !== true) return bad('fal.ai video costs money — it only starts after the cost line was confirmed. Nothing was sent.');
    const cfg = a.loadConfig();
    const denied = a.videoGate(cfg, { uiButton: true });
    if (denied) return bad(denied.replace(/^(REJECTED|BUSY): /, ''));
    const job = falJobOf(req, cfg);
    const pathErr = require('./providers/fal-video').checkPaths(job, { outputDir: path.join(workingDir, 'output'), cwd: workingDir });
    if (pathErr) return bad(pathErr);
    return a.makeVideo(job, cfg, { uiButton: true, confirmed: true }).then((r) => {
      if (!r.ok) return { ok: false, error: a.scrubFalKey(r.error.replace(/^(ERROR|REJECTED|BUSY): /, '')) };
      if (req.boardId && req.shotId) {   // the final V1b-3 seam: the ids ride in the shotRequest
        const u = storyboard.updateShot(req.boardId, req.shotId, { clip: { path: r.path, backend: 'fal', made_at: new Date().toISOString() } });
        if (!u.ok) return { ok: false, error: a.scrubFalKey('the clip was made (' + r.path + ') but could not be linked to the shot: ' + u.error) };
      }
      return r;
    });
  },
};
function registerFalVideo() { return registerVideoBackend(falVideoBackend); }
// </v3-backend>

// <v2-backend> v1.10 V2: the free LOCAL image-to-video backend 'comfy-i2v' (providers/comfy-i2v.js): workflow-driven (the active stage:'video' entry), gpu:true -> the shared jobs slot.
// The readiness probe runs in the background; when its answer changes, the open storyboard re-reads the board once.
const localVideoBackend = require('./providers/comfy-i2v').create({
  loadConfig: () => a.loadConfig(), workingDir,
  measureVideoInstances, measureVideoCandidates,   // LC2g (T11-1): the Save-time measurement, reused at the first run of a never-measured entry and for the OOM hint
  onChange: () => { try { broadcast({ kind: 'storyboard', phase: 'backends', ok: true }); } catch (_) { /* no clients */ } },
});
function registerLocalVideo() { return registerVideoBackend(localVideoBackend); }
// </v2-backend>

module.exports = { remote, _actionLabels: ACTION_LABELS, _actionLabel: actionLabel, _safeDirName: safeDirName, _thumbFailedSize: () => thumbFailed.size, registerFalVideo, falVideoBackend, registerLocalVideo, localVideoBackend, registerVideoBackend, unregisterVideoBackend, videoBackends, NO_VIDEO_BACKEND, feedPipelineLine, _resetPipelineState, _resetCpProbeQuiet: () => { lastCpProbeFailAt = 0; }, handler, _setProviderDeps, _setMcpRenderPath };

// ─── Start server (only when run directly, not when required for tests) ────────

if (require.main === module) {
  brushPreviews.kick('start');
  characterPreviews.kick('start');
  // Subscribe to debug-log — forward every event to SSE clients + parse pipeline lines
  dbg.subscribe(rec => {
    broadcast({ kind: 'event', rec });
    if (rec.cat === 'pipeline' && typeof rec.line === 'string') {
      const artifacts = feedPipelineLine(rec.line);
      for (const art of artifacts) {
        broadcast(art);
      }
    }
    if (rec.cat === 'job') {
      if (rec.phase === 'done') {
        broadcast({ kind: 'notice', text: '✅ Background job #' + rec.id + ' done' + (rec.status ? ': ' + rec.status : '') });
      } else if (rec.phase === 'error') {
        broadcast({ kind: 'notice', text: '⚠️ Background job #' + rec.id + ' failed: ' + (rec.error || 'unknown') });
      }
    }
  });

  const server = http.createServer((req, res) => {
    handler(req, res).catch(err => {
      try {
        res.writeHead(500);
        res.end('Internal Server Error');
      } catch (_) {}
      console.error('Unhandled error in request handler:', err);
    });
  });

  // Sweep 2 F3: a second Phoenix (or anything else on the port) is a plain sentence, not a stack trace.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('Port 7777 is in use — is Phoenix already running? Open http://127.0.0.1:7777');
    } else {
      console.error('Phoenix could not start its server: ' + ((err && err.message) || err));
    }
    process.exit(1);
  });

  registerFalVideo();   // V3: Make video can use fal.ai once it is enabled + keyed in Settings
  registerLocalVideo(); // V2: ...and the free local preview once ComfyUI has the video models
  server.listen(7777, '127.0.0.1', () => {
    console.log('Phoenix UI → http://127.0.0.1:7777');
    try { voice.dispatcherSync(); } catch (_) { /* VO1: local voice dispatcher on if configured */ }
    try { remote.start(!!((a.loadConfig().remote || {}).enabled)).catch(() => {}); } catch (_) { /* <r1-remote> re-point the private route when switched on; withdraw a stale one when not */ }
  });
  // VO1: the dispatcher child must not outlive Phoenix (a hard kill is covered by its stdin pipe closing).
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { Promise.resolve().then(() => voice.dispatcherShutdown()).catch(() => {}).then(() => remote.shutdown()).catch(() => {}).then(() => process.exit(0)); });
  }
}
