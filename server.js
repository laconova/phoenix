'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const a         = require('./assistant.js');
const providers = require('./providers');
const bench = require('./bench/bench');   // competence mini-benchmark (v1.9 M2.1)
const capabilities = require('./providers/capabilities');   // tool-protocol probe results (v1.9 M2)   // seats → provider layer (v1.9 M1): validation, model lists, API keys
const dbg       = require('./debug-log.js');
const lock      = require('./lock');
const palette   = require('./palette');
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
const downloader = require('./downloader');   // workflow/engine acquisition core (Stage 1)

// ─── Working dir (used for /file security checks) ─────────────────────────────

const workingDir = __dirname;

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
    try {
      res.write(payload);
    } catch (_) {
      clients.delete(res);
    }
  }
}

// In-flight guard for the one action that deliberately does NOT take the Blender lock while it
// works (hy_motion — see the /action route). Module-level because the route is re-entered per
// request; a single boolean is enough, since exactly one action defers.
let deferredInFlight = false;

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
  // Returns { abs, allowed } or null if p missing/invalid
  if (!p || typeof p !== 'string') return null;
  // Guard against path traversal
  if (p.includes('..')) return null;
  const abs = path.resolve(workingDir, p);
  const allowedRoots = [
    path.resolve(workingDir, 'output'),
    path.resolve(workingDir, 'staging'),
    // Cached brush GLBs, so the mesh viewer can preview a brush. READ-ONLY like the others, and
    // deliberately still outside staging/ — being servable and being listed as a staged asset are
    // two different things, and conflating them is what produced phantom library entries.
    path.resolve(workingDir, 'brush-cache'),
  ];
  const allowed = allowedRoots.some(root =>
    abs === root || abs.startsWith(root + path.sep)
  );
  return { abs, allowed };
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

// ─── Busy flag (now managed by shared lock — see lock.js) ────────────────────

// ─── Request handler ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
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
// M6.1: EVERY Phoenix tool in assistant.js TOOLS except i2i_edit (UI-only decision) is reachable over POST /mcp/call, each in
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
  brush_to_unreal: 'U', unreal_to_blender: 'U', unreal_to_brush: 'U', character_to_unreal: 'U', inspect_unreal: 'U',
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
const mcpFlagsView = (c) => ({ allowBlenderRun: mcpAllows(c, 'allowBlenderRun'), allowUnrealRun: mcpAllows(c, 'allowUnrealRun'), allowDelete: mcpAllows(c, 'allowDelete') });
// "Render check: PASS | FAIL — why | UNVERIFIED — why | NO VERDICT — why | not run" (the MCP client and the chat line say the same)
function mcpVerdictLine(verdict, stopReason) {
  if (!verdict) return 'Render check: not run';
  const word = verdict === 'unverified' ? 'UNVERIFIED' : verdict === 'none' ? 'NO VERDICT' : String(verdict).toUpperCase();
  return 'Render check: ' + word + (verdict !== 'pass' && stopReason ? ' — ' + stopReason : '');
}

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

  // ── GET / ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/') {
    const indexPath = path.join(WEB_ROOT, 'index.html');
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('404 Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
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
    if (!lock.tryAcquire()) {
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
        const { text, messages, stopped, visionOff, mode: ranMode } = await a.runTurn(message, history, state, cfg, {
          blenderOnly: !!(body && body.noTool), background: true, holdsLock: true,
          mode: body && body.mode,   // undefined = runConfig falls back to cfg.gates.mode
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

        // Mirror CLI post-turn persistence exactly
        history.push({ role: 'user', content: message, turn: turnNo });
        const lastAssistant = messages.findLast(m => m.role === 'assistant');
        if (lastAssistant) history.push({ role: 'assistant', content: lastAssistant.content, turn: turnNo });
        a.saveHistory(history);
        a.saveState(state);

        // mode: what this turn ran as (the UI marks Auto replies); stopped / visionOff only when set.
        broadcast({ kind: 'reply', text, mode: ranMode || (body && body.mode) || 'ask',
          ...(stopped ? { stopped } : {}), ...(visionOff ? { visionOff: true } : {}) });
      } catch (err) {
        broadcast({ kind: 'error', message: String(err.message || err) });
      } finally {
        lock.release();
      }
    })();

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

    const ALLOWED = ['generate_image', 'i2i_edit', 'image_to_3d', 'import_asset', 'save_as_brush', 'use_brush', 'apply_material', 'rename_asset', 'rename_brush', 'delete_asset', 'delete_brush', 'list_materials', 'delete_material', 'make_human', 'place_human', 'animate_human', 'sequence_animations', 'save_animation', 'assign_skeleton', 'spawn_rig', 'save_clip', 'animate_clip', 'sequence_clips', 'save_mesh', 'hy_motion',
      'save_character', 'spawn_character', 'prepare_mesh', 'bind_mesh', 'inspect_render',
      // Registering a tool in assistant.js is NOT enough — the UI posts through here, and this
      // list is a second, independent gate. Missing it produced "unknown action" 400s on every
      // double-click with the brush target set to Unreal (found live 2026-07-31).
      'brush_to_unreal', 'brush_preview', 'inspect_unreal',
      'unreal_to_blender', 'unreal_to_brush', 'character_to_unreal',
      'remesh_asset'];
    if (!ALLOWED.includes(action)) {
      sendJSON(res, 400, { error: 'unknown action' });
      return;
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
          broadcast({ kind: 'reply', action, text: typeof result === 'string' ? result : JSON.stringify(result) });
        } catch (err) {
          broadcast({ kind: 'error', action, message: String((err && err.message) || err) });
        }
      })();
      return;
    }

    // hy_motion and i2i_edit each spend ~3–4 minutes generating in ComfyUI and do NOT hold the
    // Blender lock for that wait — holding it would freeze Phoenix the whole time (hy_motion takes
    // the lock late for its Blender-apply; i2i never touches Blender at all). So they "defer" the
    // lock and instead guard a single-slot flag. (i2i joined this path 2026-08-06 — Q3.)
    const defersLock = (action === 'hy_motion' || action === 'i2i_edit');
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
        sendJSON(res, 409, { error: 'a generation is already running — one heavy GPU job at a time; give it a moment' });
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
      if (!lock.tryAcquire()) {
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
        // The action name travels with the reply so the UI can react to WHAT finished instead of
        // sniffing the reply text. Text sniffing misfires on chat turns that happen to echo the
        // same wording, and it silently rots the moment a message is reworded.
        broadcast({ kind: 'reply', action, text: replyText });
      } catch (err) {
        broadcast({ kind: 'error', action, message: String(err.message || err) });
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
    sendJSON(res, 200, { ok: true, folders: customRig.listFolders() });
    return;
  }

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
    sendJSON(res, 200, {
      health: h,
      voices: (v && v.voices) || [],
      voicesError: (v && v.error) || null,
      effects: voice.listEffects().map(e => ({ id: e.id, label: e.label })),
      takes: voice.listTakes(),
    });
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
    if (r.error && !r.ok) { sendJSON(res, 400, r); return; }
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
    const r = sfx.adopt(body);
    sendJSON(res, r.error ? 400 : 200, r);
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
  if (method === 'GET' && urlPath === '/characters') {
    sendJSON(res, 200, { characters: characters.listCharacters() });
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
    sendJSON(res, 200, { ok: true, character: r.character, characters: characters.listCharacters() });
    return;
  }

  // ── POST /character-delete  {name} ─────────────────────────────────────────
  if (method === 'POST' && urlPath === '/character-delete') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch (_) { /* {} */ }
    const r = characters.deleteCharacter(body && body.name);
    if (r.error) { sendJSON(res, 400, { error: r.error }); return; }
    sendJSON(res, 200, { ok: true, characters: characters.listCharacters() });
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
      broadcast({ kind: 'reply', text: 'Added animation: ' + safe + ' — pick it in the Human tab and press Animate.' });
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
      const buf = await readRawBody(req);

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

      const finalName = Date.now() + '_' + safe;
      const absPath   = path.join(uploadsDir, finalName);
      fs.writeFileSync(absPath, buf);

      state.lastImage         = absPath;
      state.lastImageCategory = (cat && typeof cat === 'string') ? cat : 'item';
      state.lastImageDesc     = path.basename(finalName, ext);
      a.saveState(state);

      const rel = 'output/uploads/' + finalName;
      const url = '/file?p=' + encodeURIComponent(rel);

      broadcast({ kind: 'artifact', slot: 'image', url, source: 'upload' });
      broadcast({ kind: 'reply', text: 'Loaded image: ' + finalName + ' — it is in the Image tab. Click "Make 3D" to convert it (set a face count first if you like).' });

      sendJSON(res, 200, { ok: true, url });
    } catch (e) {
      sendJSON(res, 500, { error: String(e.message || e) });
    }
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
    if (!cpQuiet && lock.tryAcquire()) {
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
    if (!lock.tryAcquire()) { sendJSON(res, 409, { error: 'busy' }); return; }
    let r;
    try {
      cfg = a.loadConfig();
      r = await checkpoints.rewind(body && body.id, body && body.choice, {
        cfg, turn: state.turnSeq,
        loadHistory: () => history,
        saveHistory: (h) => { history = h; a.saveHistory(h); },
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
      orchestrator: { model: orch.model || 'claude-sonnet-4-6', historyMessages: orch.historyMessages || 3,
        maxToolCalls: a.runConfig(fresh, 'ask').budget, maxToolCallsAuto: a.runConfig(fresh, 'auto').budget },
      metaprompter: { model: meta.model || '', ejectAfterUse: !!meta.ejectAfterUse },
      checkpoints: checkpoints.settings(fresh),
      mcp: mcpFlagsView(fresh),
      remesh: remeshView(fresh),   // M9: never the key, never the base URL
      mcpScript: path.join(workingDir, 'phoenix-mcp.js'),   // absolute path for the Settings setup lines
      endpoints: { local: (fresh.endpoints && fresh.endpoints.local) || '', comfyui: (fresh.endpoints && fresh.endpoints.comfyui) || '' },
      seats: seatsView(fresh),
      endpointNames: endpointNamesOf(fresh),
      keys: providers.listKeys(),   // booleans only — a key value never leaves the server
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
        return { name, category, orphaned: !!orphaned, label: labels[category + '/' + name] || null, sizeMB };
      })
        .sort((x, y) => (x.label || x.name).localeCompare(y.label || y.name, undefined, { numeric: true, sensitivity: 'base' }));
    } catch (_) {}
    sendJSON(res, 200, { assets });
    return;
  }

  // ── GET /brushes ──────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/brushes') {
    let brushes = [];
    try { brushes = a.listBrushesData(); } catch (_) {}
    sendJSON(res, 200, { brushes });
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
    sendJSON(res, 200, { report, canSend });
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

    if (!hasGates && !hasOrch && !hasMeta && !hasEps && !hasApps && !hasFb && !hasUnreal && !hasSeats && !hasCp && !hasMcp && !hasRemesh) {
      sendJSON(res, 400, { error: 'No settings provided.' });
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

    // Validate historyMessages (cheap, synchronous)
    if (hasOrch && 'historyMessages' in body.orchestrator) {
      const hm = body.orchestrator.historyMessages;
      if (!Number.isInteger(hm) || hm < 1 || hm > 50) {
        sendJSON(res, 400, { error: 'History length must be an integer between 1 and 50.', field: 'historyMessages' });
        return;
      }
      staged.orchestrator.historyMessages = hm;
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

    a.saveConfig(fresh);
    for (const sd of forcedSeats) capabilities.markForced(sd);   // the troubleshooter was forced past a failed test
    cfg = fresh;
    sendJSON(res, 200, {
      unreal: {
        brushTarget:  fresh.unreal.brushTarget  || 'blender',
        visionMode:   fresh.unreal.visionMode   || 'camera',
        visionWidth:  fresh.unreal.visionWidth  || 1280,
        visionHeight: fresh.unreal.visionHeight || 720,
      },
      gates: Object.assign({}, fresh.gates, { mode: a.runConfig(fresh).mode }),
      orchestrator: { model: fresh.seats.orchestrator.model, historyMessages: fresh.seats.orchestrator.historyMessages,
        maxToolCalls: a.runConfig(fresh, 'ask').budget, maxToolCallsAuto: a.runConfig(fresh, 'auto').budget },
      metaprompter: { model: fresh.seats.metaprompter.model, ejectAfterUse: !!fresh.seats.metaprompter.ejectAfterUse },
      checkpoints: checkpoints.settings(fresh),
      mcp: mcpFlagsView(fresh),
      remesh: remeshView(fresh),
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
    sendJSON(res, 200, { categories: palette.loadPalette().categories });
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

    // Build sanitized categories — recompute builtin from server side, drop unknown fields
    const sanitized = {};
    for (const [key, cat] of Object.entries(body.categories)) {
      sanitized[key] = {
        hint:            String(cat.hint),
        style:           String(cat.style),
        target_face_num: Math.round(Number(cat.target_face_num)),
        cfg:             Number(cat.cfg),
        steps:           Math.round(Number(cat.steps)),
        builtin:         builtinKeys.includes(key),
      };
    }

    palette.savePalette({ version: 1, categories: sanitized });
    sendJSON(res, 200, { categories: sanitized });
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
    sendJSON(res, 200, { categories: pal.categories });
    return;
  }

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
    // Config-capability gate for voice engines: availability depends on THIS install's voice.dispatcher
    // capability (a rig-only /speak dispatcher, not shipped), which the raw registry entry can't know.
    // Overlay the EFFECTIVE blocked/blockedReason (English) that the picker + library row already honor,
    // so a dispatcher-gated engine greys out on a plain customer config with no client-side change.
    const hasDispatcher = !!(cfg2.voice && cfg2.voice.dispatcher);
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
      const hasDispatcher = !!(localCfg.voice && localCfg.voice.dispatcher);
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
      try {
        const r = await downloader.acquire(localCfg, { id, ...entry }, {
          signal,
          onProgress: (p) => broadcast({ kind: 'acquire-progress', id, ...p }),
        });
        const cancelled = !!(r.failed && r.failed.some(f => f.cancelled));
        const hardFailed = !cancelled && r.failed && r.failed.length > 0;
        broadcast({ kind: 'acquire-progress', id, phase: cancelled ? 'cancelled' : (hardFailed ? 'failed' : 'complete'),
                    summary: { done: r.done, skipped: r.skipped, failed: r.failed, warnings: r.warnings || [] } });
        if (hardFailed) throw new Error('acquire failed: ' + r.failed.map(f => f.name + ' (' + f.error + ')').join('; '));
        return cancelled
          ? 'acquire cancelled — ' + (entry.label || id)
          : 'acquired ' + (entry.label || id) + ' — done:' + r.done.length + ' skipped:' + r.skipped.length + ((r.warnings && r.warnings.length) ? ' warnings:' + r.warnings.length : '');
      } catch (e) {
        broadcast({ kind: 'acquire-progress', id, phase: 'failed', error: String((e && e.message) || e) });
        throw e;
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
  // Body: { stage: 'image'|'mesh', json: <workflow as string or object> }
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
    if (stage !== 'image' && stage !== 'mesh' && stage !== 'i2i') {
      sendJSON(res, 400, { error: 'stage must be "image", "mesh" or "i2i"', field: 'stage' });
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
  // Body: { id, label, stage, nodes, deps, json }
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
    if (custStage !== 'image' && custStage !== 'mesh' && custStage !== 'i2i') {
      sendJSON(res, 400, { error: 'stage must be "image", "mesh" or "i2i"', field: 'stage' });
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
        { id: body.id, label: body.label, stage: custStage, nodes: body.nodes || {}, deps: body.deps || {} },
        jsonText
      );
      const reg = workflows.loadRegistry();
      sendJSON(res, 200, { entry, workflows: reg.workflows });
    } catch (e) {
      sendJSON(res, 400, { error: String(e.message || e) });
    }
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
        c.workflows[stage0] = workflows.DEFAULT_ACTIVE[stage0];
        a.saveConfig(c);
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
      const entry = workflows.updateCustomWorkflow(body.id, { label: body.label, nodes: body.nodes, deps: body.deps });
      const reg = workflows.loadRegistry();
      sendJSON(res, 200, { entry, workflows: reg.workflows });
    } catch (e) {
      sendJSON(res, 400, { error: String(e.message || e) });
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
    // only when Settings → Connections is on; MCP counts as Auto. The tool re-checks the same gates (enabled, key) in the same order.
    const cloudTool = tool === 'remesh_asset';
    if (cloudTool && !(fresh.remesh && fresh.remesh.enabled === true)) {
      sendJSON(res, 200, { result: 'REJECTED: remesh uploads meshes to Meshy (paid) — enable it in Settings → Connections', failed: true, verdict: null, gateNote: '', stopReason: null });
      return;
    }
    const readOnly = mcpClass === 'R' || cloudTool;   // 'readOnly' here = takes no chat lock
    if (!readOnly && (deferredInFlight || jobs.isRunning())) {
      sendJSON(res, 409, { error: 'a background generation is running — wait for it to finish, then try again' });
      return;
    }
    if (!readOnly && !lock.tryAcquire()) { sendJSON(res, 409, { error: 'busy' }); return; }   // read-only tools never take the lock: parallel agent calls must not 409
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
    const local = await pipeline.killCurrent('user pressed /stop');

    const remote = local.comfyui;

    if (local.stopped) {
      broadcast({ kind: 'notice', text: `⛔ Stopped the ${stage || 'running'} stage (ComfyUI: ${remote}).` });
    }
    sendJSON(res, 200, {
      stopped:  local.stopped,
      stage:    stage || null,
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

module.exports = { feedPipelineLine, _resetPipelineState, _resetCpProbeQuiet: () => { lastCpProbeFailAt = 0; }, handler, _setProviderDeps, _setMcpRenderPath };

// ─── Start server (only when run directly, not when required for tests) ────────

if (require.main === module) {
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

  server.listen(7777, '127.0.0.1', () => {
    console.log('Phoenix UI → http://127.0.0.1:7777');
  });
}
