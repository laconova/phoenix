'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const a         = require('./assistant.js');
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
const jobs      = require('./jobs');

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

async function handler(req, res) {
  const method  = req.method;
  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlPath = parsedUrl.pathname;

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

        // holdsLock: this route took the lock above and holds it for the whole turn. Tools that
        // would otherwise acquire it themselves (hy_motion) must not, or they deadlock against us.
        // onArtifact: the chat path's route to the artifact tabs. inspect_render and the
        // render-vision gate produce a picture mid-turn; without this hook the render was
        // taken and judged but never shown (the /action route had it, the chat path did not).
        const { text, messages } = await a.runTurn(message, history, state, cfg, {
          blenderOnly: !!(body && body.noTool), background: true, holdsLock: true,
          onArtifact: (art) => {
            try {
              if (!art || !art.rel) return;
              broadcast({ kind: 'artifact', slot: art.slot || 'image',
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
        history.push({ role: 'user', content: message });
        const lastAssistant = messages.findLast(m => m.role === 'assistant');
        if (lastAssistant) history.push({ role: 'assistant', content: lastAssistant.content });
        a.saveHistory(history);
        a.saveState(state);

        broadcast({ kind: 'reply', text });
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
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { action, input } = body || {};

    const ALLOWED = ['generate_image', 'image_to_3d', 'import_asset', 'save_as_brush', 'use_brush', 'apply_material', 'rename_asset', 'rename_brush', 'delete_asset', 'delete_brush', 'list_materials', 'delete_material', 'make_human', 'place_human', 'animate_human', 'sequence_animations', 'save_animation', 'assign_skeleton', 'spawn_rig', 'save_clip', 'animate_clip', 'sequence_clips', 'save_mesh', 'hy_motion',
      'save_character', 'spawn_character', 'prepare_mesh', 'bind_mesh', 'inspect_render',
      // Registering a tool in assistant.js is NOT enough — the UI posts through here, and this
      // list is a second, independent gate. Missing it produced "unknown action" 400s on every
      // double-click with the brush target set to Unreal (found live 2026-07-31).
      'brush_to_unreal', 'brush_preview', 'inspect_unreal',
      'unreal_to_blender', 'unreal_to_brush', 'character_to_unreal'];
    if (!ALLOWED.includes(action)) {
      sendJSON(res, 400, { error: 'unknown action' });
      return;
    }

    // hy_motion spends most of its ~4 minutes generating in ComfyUI and does not touch
    // Blender until it applies the result. Holding the lock for all of it would freeze
    // Phoenix for the whole wait, so this action takes the lock late, itself, and only
    // for the Blender part (see toolHyMotion in assistant.js).
    const defersLock = action === 'hy_motion';
    if (!defersLock && !lock.tryAcquire()) {
      sendJSON(res, 409, { error: 'busy' });
      return;
    }
    // ...but "does not hold the lock" must not mean "may run twice". Because it takes no lock
    // and does not go through the single-slot job registry, nothing else stops a second click
    // during the four-minute wait from starting a second GPU generation. The UI used to prevent
    // that only by accident, by greying itself out — and that accident disappeared the moment the
    // UI stopped lying about staying usable. So the guard lives here, where it belongs.
    if (defersLock) {
      if (deferredInFlight) {
        sendJSON(res, 409, { error: 'a text→motion generation is already running — it takes about four minutes' });
        return;
      }
      deferredInFlight = true;
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
              broadcast({ kind: 'artifact', slot: 'image', url: '/file?p=' + encodeURIComponent('output/render-check.png') + '&t=' + Date.now() });
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
              broadcast({ kind: 'artifact', slot: 'image', url: '/file?p=' + encodeURIComponent('output/unreal-check.png') + '&t=' + Date.now() });
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
        // The action name travels with the reply so the UI can react to WHAT finished instead of
        // sniffing the reply text. Text sniffing misfires on chat turns that happen to echo the
        // same wording, and it silently rots the moment a message is reworded.
        broadcast({ kind: 'reply', action, text: typeof result === 'string' ? result : JSON.stringify(result) });
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

  // ── GET /config ──────────────────────────────────────────────────────────
  if (method === 'GET' && urlPath === '/config') {
    const fresh = a.loadConfig();
    const orch = (fresh.seats && fresh.seats.orchestrator) || {};
    const meta = (fresh.seats && fresh.seats.metaprompter) || {};
    sendJSON(res, 200, {
      gates: (fresh && fresh.gates) || {},
      orchestrator: { model: orch.model || 'claude-sonnet-4-6', historyMessages: orch.historyMessages || 3 },
      metaprompter: { model: meta.model || '', ejectAfterUse: !!meta.ejectAfterUse },
      endpoints: { local: (fresh.endpoints && fresh.endpoints.local) || '', comfyui: (fresh.endpoints && fresh.endpoints.comfyui) || '' },
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
      assets = a.listStagedFiles().map(({ name, category, orphaned }) => ({ name, category, orphaned: !!orphaned, label: labels[category + '/' + name] || null }))
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
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (_) {
      sendJSON(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    function validateClaudeModel(model) {
      return new Promise(resolve => {
        const { spawn } = require('child_process');
        let done = false;
        const finish = (ok, msg) => { if (!done) { done = true; resolve({ ok, msg }); } };
        let child;
        try {
          child = spawn('claude', ['--print', '--tools', '', '--strict-mcp-config', '--model', model, 'ok'], { encoding: 'utf8', shell: process.platform === 'win32' });
        } catch (e) { return finish(false, 'could not launch claude: ' + e.message); }
        const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(false, 'model probe timed out'); }, 25000);
        child.on('error', e => { clearTimeout(timer); finish(false, 'claude CLI error: ' + e.message); });
        child.on('close', code => { clearTimeout(timer); finish(code === 0, code === 0 ? '' : 'Claude CLI rejected model (exit ' + code + ')'); });
      });
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

    if (!hasGates && !hasOrch && !hasMeta && !hasEps && !hasApps && !hasFb && !hasUnreal) {
      sendJSON(res, 400, { error: 'No settings provided.' });
      return;
    }

    // Stage validated changes (only applied on full success)
    const staged = { gates: {}, orchestrator: {}, metaprompter: {}, endpoints: {}, apps: {}, feedback: {}, unreal: {} };

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
        const { ok, msg } = await validateClaudeModel(model);
        if (!ok) {
          sendJSON(res, 400, { error: 'Model "' + model + '" was not accepted by the Claude CLI: ' + msg, field: 'model' });
          return;
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

    // Validate metaprompter model (probe only Claude models, only if changed)
    if (hasMeta && 'model' in body.metaprompter) {
      const mm = body.metaprompter.model;
      if (typeof mm !== 'string' || !mm.trim()) {
        sendJSON(res, 400, { error: 'Metaprompter model must be a non-empty string.', field: 'metaprompter' });
        return;
      }
      if (/^claude/i.test(mm) && mm !== fresh.seats.metaprompter.model) {
        const { ok, msg } = await validateClaudeModel(mm);
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
    if ('blender' in staged.apps) fresh.apps.blender = staged.apps.blender;
    if ('comfyOutput' in staged.apps) fresh.apps.comfyOutput = staged.apps.comfyOutput;
    if ('endpointUrl' in staged.feedback) fresh.feedback.endpointUrl = staged.feedback.endpointUrl;
    Object.assign(fresh.unreal, staged.unreal);

    a.saveConfig(fresh);
    cfg = fresh;
    sendJSON(res, 200, {
      unreal: {
        brushTarget:  fresh.unreal.brushTarget  || 'blender',
        visionMode:   fresh.unreal.visionMode   || 'camera',
        visionWidth:  fresh.unreal.visionWidth  || 1280,
        visionHeight: fresh.unreal.visionHeight || 720,
      },
      gates: fresh.gates,
      orchestrator: { model: fresh.seats.orchestrator.model, historyMessages: fresh.seats.orchestrator.historyMessages },
      metaprompter: { model: fresh.seats.metaprompter.model, ejectAfterUse: !!fresh.seats.metaprompter.ejectAfterUse },
      endpoints: { local: fresh.endpoints.local, comfyui: fresh.endpoints.comfyui },
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
    };
    sendJSON(res, 200, { workflows: reg.workflows, active });
    return;
  }

  // ── POST /workflows ──────────────────────────────────────────────────────
  // Sets the active workflow for a given stage (image or mesh).
  // Validates that the entry exists, matches the stage, its file is present,
  // and its node-map has all required keys.
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

    if (stage !== 'image' && stage !== 'mesh') {
      sendJSON(res, 400, { error: 'stage must be "image" or "mesh"', field: 'stage' });
      return;
    }

    if (!id || typeof id !== 'string') {
      sendJSON(res, 400, { error: 'id must be a non-empty string', field: 'id' });
      return;
    }

    const reg   = workflows.loadRegistry();
    const entry = reg.workflows[id];

    if (!entry) {
      sendJSON(res, 400, { error: 'unknown workflow id', field: 'id' });
      return;
    }

    if (entry.stage !== stage) {
      sendJSON(res, 400, { error: 'workflow is not for this stage', field: 'stage' });
      return;
    }

    // resolveWorkflowFile, not a bare existsSync: entry.file is the absolute path recorded when
    // the workflow was registered, and it goes stale the moment the tree moves or a registry is
    // restored elsewhere. The resolver falls back to this install's own workflows/ — without it,
    // reading and editing such a workflow works while ACTIVATING it fails, which is a confusing
    // half-broken state (and the exact case entries/phoenix-workflow-stale-path.md documents).
    try {
      workflows.resolveWorkflowFile(entry);
    } catch (_) {
      sendJSON(res, 400, { error: 'workflow file not found: ' + entry.file, field: 'file' });
      return;
    }

    const REQUIRED = {
      image: ['positive', 'output'],
      mesh:  ['image', 'output'],
    };
    for (const key of REQUIRED[stage]) {
      if (!entry.nodes || !entry.nodes[key]) {
        sendJSON(res, 400, { error: 'nodes map missing key: ' + key, field: 'nodes' });
        return;
      }
    }

    const cfg2 = a.loadConfig();
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
    const base = (localCfg.endpoints && localCfg.endpoints.comfyui) || 'http://localhost:8188';
    let info;
    try {
      const r = await fetch(base + '/object_info', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        sendJSON(res, 200, { reachable: false, error: 'ComfyUI HTTP ' + r.status, base });
        return;
      }
      info = await r.json();
    } catch (e) {
      sendJSON(res, 200, { reachable: false, error: (e && e.message) || String(e), base });
      return;
    }
    const reg  = workflows.loadRegistry();
    const deps = {};
    for (const [id, entry] of Object.entries(reg.workflows)) {
      deps[id] = workflows.checkDeps(entry, info);
    }
    sendJSON(res, 200, { reachable: true, base, deps });
    return;
  }

  // ── GET /lmstudio/models ─────────────────────────────────────────────────
  // Returns models currently loaded in LM Studio. Always responds 200 —
  // { reachable: false, error, base } when LM Studio is unreachable so the UI
  // can render a graceful "offline" badge (same convention as /workflows/deps).
  if (method === 'GET' && urlPath === '/lmstudio/models') {
    const localCfg = a.loadConfig();
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
    if (stage !== 'image' && stage !== 'mesh') {
      sendJSON(res, 400, { error: 'stage must be "image" or "mesh"', field: 'stage' });
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
    if (custStage !== 'image' && custStage !== 'mesh') {
      sendJSON(res, 400, { error: 'stage must be "image" or "mesh"', field: 'stage' });
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

module.exports = { feedPipelineLine, _resetPipelineState };

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

  server.listen(7777, '127.0.0.1', () => {
    console.log('Phoenix UI → http://127.0.0.1:7777');
  });
}
