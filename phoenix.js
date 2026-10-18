'use strict';

const readline = require('readline');
const { spawnSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const net  = require('net');
const { runPreflight } = require('./preflight');
const { demetalPy } = require('./mesh-import-fix');
const dbg = require('./debug-log');
const blenderIpc = require('./blender-ipc');

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_FILE  = path.join(__dirname, 'phoenix-config.json');
const PALETTE_FILE = path.join(__dirname, 'palette.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

const { loadPalette } = require('./palette');
const wfp = require('./workflow-params');   // v1.10 ADV: cfg / steps / sampler / size / faces ... live per workflow here, not in the palette
const { getActive, resolveSlot, resolveWorkflowFile } = require('./workflows');
const providers = require('./providers');   // every LLM call (metaprompter, category) goes through the seat → provider layer
const records = require('./records');   // append-only output record (v1.10 C1) - written here, where the file is written
const i2iEngine = require('./i2i');   // freeOtherInstances — evict an i2i model left resident on the OTHER instance before mesh/image

const _cfg     = loadConfig();
const _palette = loadPalette();

const COMFY_BASE   = (_cfg.endpoints && _cfg.endpoints.comfyui) || 'http://localhost:8188';
const EJECT_AFTER  = !!(_cfg.seats && _cfg.seats.metaprompter && _cfg.seats.metaprompter.ejectAfterUse);

// ─── VRAM ─────────────────────────────────────────────────────────────────────
// Freeing ComfyUI's models before the mesh step is what keeps Flux and Trellis from
// fighting over a 10GB card. It used to be gated by `seats.metaprompter.ejectAfterUse`
// — which is a flag about the *metaprompter*, and that seat is a cloud model now. The
// coupling was accidental: flip that flag for a good reason and the eject vanishes
// silently, and every mesh OOMs. It gets its own switch.
//   vram.freeComfyBeforeMesh: true|false   (default: true — safe for VRAM-poor boxes)
const _vram = _cfg.vram || {};
const FREE_COMFY_BEFORE_MESH = (_vram.freeComfyBeforeMesh !== undefined)
  ? !!_vram.freeComfyBeforeMesh
  : (_cfg.seats && _cfg.seats.metaprompter && _cfg.seats.metaprompter.ejectAfterUse !== undefined
      ? !!_cfg.seats.metaprompter.ejectAfterUse   // legacy config: keep old behaviour
      : true);                                    // nothing configured: assume the card is small

const COMFY_OUTPUT = (_cfg.apps && _cfg.apps.comfyOutput) ||
  path.join(process.env.USERPROFILE || process.env.HOME || '', 'Documents', 'ComfyUI', 'output');
// Active image/3D workflow files + node-maps now come from the registry (workflows.js)
// via getActive(stage, _cfg). The old FLUX_WORKFLOW / TRELLIS_WORKFLOW constants were
// removed in the Phase 2 engine refactor (2026-06-27).
const OUTPUT_BASE    = path.join(__dirname, 'output');
const STAGING_BASE   = path.join(__dirname, 'staging');

// ─── Category defaults ────────────────────────────────────────────────────────

// v1.10 ADV: the palette only says WHICH categories exist (and their hint/style). The tunable values (cfg, steps, sampler, size, faces,
// Trellis steps ...) are read per run from workflow-params.js for the ACTIVE workflow: category override -> workflow value -> JSON default.
const CATEGORIES = Object.fromEntries(Object.keys(_palette.categories).map(k => [k, {}]));

// The effective parameters of the active workflow of a stage for a category (stage = 'image' | 'mesh').
function stageParams(stage, category) {
  try { return wfp.effective(getActive(stage, _cfg).id, category); } catch (_) { return {}; }
}

// Every category in the palette gets a label — a hand-written one where we have it,
// the palette's own hint otherwise. Hardcoding the list here is what made `leaf` and
// `branch` print "undefined": palette.json is the only place a category is declared.
const CATEGORY_LABEL_OVERRIDES = {
  flat:         'flat prop  (plank / panel / floor)',
  furniture:    'furniture  (chair / table / shelf)',
  item:         'item       (tool / weapon / container)',
  architecture: 'architecture  (wall / pillar / arch)',
  flora:        'flora  (tree / plant / shrub)',
  fauna:        'fauna / monster  (static)',
};

const CATEGORY_LABELS = Object.fromEntries(
  Object.keys(_palette.categories).map(k => [k, CATEGORY_LABEL_OVERRIDES[k] || _palette.categories[k].hint || k])
);

// ─── Utilities ────────────────────────────────────────────────────────────────

const randomSeed  = () => Math.floor(Math.random() * 0x7fffffff);
const slug        = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 28);
// A locked seed (workflow window -> Advanced) replaces the random one for that workflow; only workflows with a seed slot can lock.
function drawSeed(stage) {
  try {
    const w = getActive(stage, _cfg);
    const locked = (w.nodes && w.nodes.seed != null) ? wfp.lockedSeed(w.id) : null;
    if (locked != null) return locked;
  } catch (_) { /* fall through to random */ }
  return randomSeed();
}
const nowStamp    = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // to the second

async function withProgress(label, fn) {
  const start = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${label} ${s}s`);
  }, 1000);
  process.stdout.write(`  ${label} 0s`);
  try {
    const r = await fn();
    clearInterval(timer);
    const s = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${label} done (${s}s)\n`);
    dbg.progress(label, { ms: Date.now() - start, ok: true });
    return r;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write('\n');
    dbg.progress(label, { ms: Date.now() - start, ok: false, err: e.message });
    throw e;
  }
}

// ─── LLM calls ───────────────────────────────────────────────────────────────

// lms load/unload + the pre-stage GPU sharing live in providers/gpu-share.js
const gpuShare = require('./providers/gpu-share');
const { lmsLoad, lmsUnload } = gpuShare;

// ─── Blender IPC ─────────────────────────────────────────────────────────────

// File-based transport — see blender-ipc.js. (Was a 9876 socket; sockets fail
// cross-process on Windows + Blender 5.1 / Python 3.13. WinError 10035.)
function callBlender(code) {
  return blenderIpc.callBlender(code);
}

// ─── ComfyUI helpers ─────────────────────────────────────────────────────────

async function comfyCheck() {
  try {
    const res = await fetch(`${COMFY_BASE}/queue`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

// Lazy-Restore (2026-08-05): Das voice-service verdraengt idle ComfyUI-Instanzen,
// um dem 8,6-GB-TTS-Modell die 10-GB-Karte ZUSAMMENHAENGEND zu geben (sonst
// scheitert cuMemCreate trotz "genug frei"). Damit der Nutzer danach NICHTS von
// Hand starten muss, faehrt Phoenix die ComfyUI-Instanz hinter COMFY_BASE hier
// selbst wieder hoch, wenn sie unten ist. ADDITIV: liest nur den bestehenden
// Endpoint, aendert keinen Wert; startet die passende Instanz per SSH auf dem Rig
// (comfy-supervisor.js). Deckt zugleich "ComfyUI ueberlebte keinen Reboot" ab —
// Phoenix heilt sich beim naechsten Auftrag selbst.
// OPTIONAL remote-restart config. A user whose ComfyUI is managed by a supervisor on another host
// (the dev rig) can set these to let Phoenix restart it over SSH when it is down. UNSET by default:
// a single-machine user has no rig to SSH into, so we must NOT ship a hardcoded host/path — that
// both leaks the dev's box and sends a normal user's failing generation on a doomed SSH detour.
const RIG_SSH          = (_cfg.endpoints && _cfg.endpoints.rigSsh)         || null;
const COMFY_SUPERVISOR = (_cfg.endpoints && _cfg.endpoints.comfySupervisor) || null;

function comfyInstanceFor(base) {
  // Port -> supervisor instance name (only meaningful for the configured remote supervisor).
  if (/:8000(\D|$)/.test(base)) return 'trellis';
  if (/:8188(\D|$)/.test(base)) return 'bild';
  return null;
}

// <lc2c-comfy-gone> true = ComfyUI answers (already up, or restarted and reachable); false = it does not - the ONE `Stage error:` line is already printed,
// its text is left in ensureComfyUp.lastMessage so comfyGoneError() can stop the stage without a second, bare line.
async function ensureComfyUp() {
  ensureComfyUp.lastMessage = null;
  if (await comfyCheck()) return true;              // fast path: it's up

  // No remote supervisor configured → this is (or should be treated as) a local ComfyUI. Don't SSH
  // anywhere; give a clear, actionable message. The generation that follows will fail fast with the
  // same base in its error, so the user knows exactly what to start.
  if (!RIG_SSH || !COMFY_SUPERVISOR) {
    // <lc2a-comfy-gone> one wording for every surface (stderr → pipeline error → chat / Image tab / storyboard keyframe)
    const _msg = `ComfyUI is not answering at ${COMFY_BASE}. Start it (or fix endpoints.comfyui). If it runs on another machine that may stop it to free VRAM, set endpoints.rigSsh + endpoints.comfySupervisor so Phoenix restarts it by itself.`;
    console.log(`  [comfy] ${_msg}`);
    console.error(`Stage error: ${_msg}`);   // <lt-fixes> stderr wins in pipeline.js's error, so the cause must be there too
    ensureComfyUp.lastMessage = _msg;
    return false;
  }

  const inst = comfyInstanceFor(COMFY_BASE);
  if (!inst) {
    // <lc2a-r2> B2: same reporter as every other case — one `Stage error:` line, so chat / Image tab / keyframe show it
    const _msg = `ComfyUI is not answering at ${COMFY_BASE} and Phoenix cannot restart it: endpoints.rigSsh (${RIG_SSH}) is set, but this port maps to no supervisor instance (8000 = trellis, 8188 = bild). Start ComfyUI yourself or fix endpoints.comfyui.`;
    console.log(`  [comfy] ${COMFY_BASE} is down and maps to no known supervisor instance — not auto-started. ${_msg}`);
    console.error(`Stage error: ${_msg}`);
    ensureComfyUp.lastMessage = _msg;
    return false;
  }
  console.log(`  [comfy] ${inst} (${COMFY_BASE}) is down — restarting via ${RIG_SSH} (supervisor)…`);
  let _restartFail = null;   // <lc2a-comfy-gone> short reason when the ssh restart itself failed
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', RIG_SSH, `node ${COMFY_SUPERVISOR} up ${inst}`],
      { encoding: 'utf8', timeout: 120000 });
    const line = ((r.stdout || '') + (r.stderr || '')).trim();
    if (line) console.log(`  [comfy] ${line.split('\n').pop()}`);
    if (r.error || r.signal || (typeof r.status === 'number' && r.status !== 0)) {
      _restartFail = (r.error && r.error.message) || (line && line.split('\n').pop()) || (r.signal ? 'killed by ' + r.signal : 'exit code ' + r.status);
    }
  } catch (e) { console.log(`  [comfy] auto-start threw: ${e.message}`); _restartFail = e.message; }
  if (_restartFail) {
    const _msg = `ComfyUI is not answering at ${COMFY_BASE} and the restart over ${RIG_SSH} failed: ${String(_restartFail).replace(/\s+/g, ' ').slice(0, 160)}.`;
    console.log(`  [comfy] ${_msg}`);
    console.error(`Stage error: ${_msg}`);
    ensureComfyUp.lastMessage = _msg;
    return false;
  }
  // The server is back up rig-side; an SSH tunnel can lag a moment. Wait for the port before continuing.
  for (let i = 0; i < 20; i++) {
    if (await comfyCheck()) { console.log(`  [comfy] ${inst} reachable again.`); return true; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  const _msg2 = `ComfyUI is not answering at ${COMFY_BASE} and the restart over ${RIG_SSH} failed: ${inst} still not reachable after the restart (check the connection).`;
  console.log(`  [comfy] ${_msg2}`);
  console.error(`Stage error: ${_msg2}`);
  ensureComfyUp.lastMessage = _msg2;
  return false;
}

// <lc2c-comfy-gone> the error a stage throws when ensureComfyUp() said false: it carries comfyGone so the stage catch does not print a second line.
function comfyGoneError() {
  const e = new Error(ensureComfyUp.lastMessage || 'ComfyUI is not answering.');
  e.comfyGone = true;
  return e;
}

async function comfyUploadImage(filePath) {
  const data = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const form = new FormData();
  form.append('image', new Blob([data], { type: 'image/png' }), name);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY_BASE}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed ${res.status}: ${await res.text()}`);
  return (await res.json()).name;
}

async function comfyQueue(workflow) {
  const res = await fetch(`${COMFY_BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!res.ok) throw new Error(`Queue failed ${res.status}: ${await res.text()}`);
  const d = await res.json();
  if (d.error) throw new Error(`ComfyUI rejected workflow: ${d.error.message || JSON.stringify(d.error)}`);
  // Announce the queued prompt on stdout so pipeline.js — which spawns this stage as a child and
  // cannot see promptId directly — can target its cancel at OUR prompt. Without this it fired a
  // GLOBAL /interrupt that aborts a foreign job sharing this ComfyUI instance (burned the user
  // 2026-08-01). A line the parent parses; harmless to a human reader.
  // Leading \n is load-bearing: this runs inside withProgress, whose spinner writes "\r  label Ns"
  // with NO newline, so without it the marker glues onto the spinner line and the parent never
  // parses it. Own line in, own line out.
  try { process.stdout.write(`\nPHX_COMFY_PROMPT ${d.prompt_id}\n`); } catch (_) {}
  return d.prompt_id;
}

// Tell ComfyUI to actually stop working on a prompt we have given up on.
//
// Without this, a Phoenix-side timeout only ends the WAITING — the rig keeps computing
// the mesh for minutes afterwards, burns the whole card, and delivers into the void
// (observed 2026-08-01: job reported failed at ~660 s while Trellis was still sampling
// texture SLat two minutes later, blocking every following job).
//
// Two calls, because a prompt can be in one of two places:
//   /queue {delete:[id]}  removes it if it is still PENDING
//   /interrupt            stops it if it is already EXECUTING
// ⚠️ /interrupt has no prompt_id — it stops whatever that instance runs right now, and this
// ComfyUI is shared (laptop + rig + the user's manual Trellis runs). Firing it blind aborts a
// foreign job (burned the user 2026-08-01), and "we polled this prompt so it IS the running one"
// is false when ours was only PENDING (history has no entry, so the poll times out the same way).
// So interrupt ONLY when queue_running actually holds our id; otherwise the dequeue above sufficed.
async function comfyCancel(promptId, why) {
  const results = {};
  try {
    const r = await fetch(`${COMFY_BASE}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(5000),
    });
    results.dequeued = r.ok;
  } catch (e) { results.dequeued = 'unreachable'; }
  try {
    const q = await (await fetch(`${COMFY_BASE}/queue`, { signal: AbortSignal.timeout(5000) })).json();
    const oursRunning = (q.queue_running || []).some(it => Array.isArray(it) && it.includes(promptId));
    if (oursRunning) {
      const r = await fetch(`${COMFY_BASE}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      results.interrupted = r.ok;
    } else {
      results.interrupted = 'skipped (ours not running — foreign job left alone)';
    }
  } catch (e) { results.interrupted = 'unreachable'; }
  dbg.event('comfy', { phase: 'cancelled', promptId, why, ...results });
  console.log(`  ⛔ ComfyUI abbestellt (${why}) — dequeue=${results.dequeued} interrupt=${results.interrupted}`);
  return results;
}

async function comfyPoll(promptId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  let consecFails = 0;
  let fatal = null;   // a job ComfyUI reported as failed — thrown AFTER the try/catch (see note below)
  const MAX_CONSEC_FAILS = 5; // ~15s of consecutive unreachable polls ⇒ ComfyUI is gone, not a blip
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`${COMFY_BASE}/history/${promptId}`);
      consecFails = 0; // got a response ⇒ ComfyUI is reachable
      if (!res.ok) continue;
      const hist  = await res.json();
      const entry = hist[promptId];
      if (!entry) continue;

      // ── Zombie-proofing ────────────────────────────────────────────────────
      // A failed ComfyUI job (CUDA OOM, bad node, cancelled) lands in /history with
      // status_str 'error' and NO outputs. The old code only asked "is it done?", so a
      // failure fell through to `continue` and we polled a dead job until the deadline —
      // 30 MINUTES for the mesh step, then a meaningless "timed out" error. That is the
      // hang that blocks the queue and would kill a take on camera. ComfyUI tells us
      // exactly what went wrong; we just never read it.
      // NOTE: do NOT throw from inside this try — the catch below treats any throw as a
      // network blip and swallows it, and because consecFails resets on every successful
      // fetch it never reaches the bail-out. That turns a detected failure into an endless
      // poll: the exact hang this code exists to prevent. Hand it out via `fatal` instead.
      const st   = entry.status || {};
      const msgs = Array.isArray(st.messages) ? st.messages : [];
      const errM = msgs.find(m => Array.isArray(m) &&
                                  (m[0] === 'execution_error' || m[0] === 'execution_interrupted'));
      if (errM || st.status_str === 'error') {
        const d      = (errM && errM[1]) || {};
        const detail = d.exception_message || d.exception_type || st.status_str || 'unknown error';
        const where  = d.node_type ? ` in node ${d.node_type}${d.node_id != null ? ` (#${d.node_id})` : ''}` : '';
        const oom    = /out of memory|outofmemory|cuda error|cudamalloc/i.test(String(detail));
        dbg.event('comfy', { phase: 'job-failed', promptId, oom, detail: String(detail).slice(0, 400), node: d.node_type });
        fatal = new Error(
          `ComfyUI job failed${where}: ${String(detail).trim()}` +
          (oom ? '\n  → CUDA out of memory. The card could not hold this step. Lower dual_contouring_resolution '
               + '(workflows/trellis_phoenix.json), or free VRAM (gemma / other models) and retry.'
               : '')
        );
        fatal.oom  = oom;            // lets callers retry on OOM specifically — runTrellis does
        fatal.node = d.node_type;
        break;
      }

      const done = (entry.status && entry.status.completed) ||
                   (entry.outputs && Object.keys(entry.outputs).length > 0);
      if (done) return entry.outputs || {};
    } catch {
      // A thrown fetch = ComfyUI unreachable. Tolerate a few (transient blip),
      // but bail fast if it stays down instead of polling silently to the timeout.
      consecFails++;
      if (consecFails >= MAX_CONSEC_FAILS) {
        throw new Error(`ComfyUI became unreachable during generation (${consecFails} consecutive failed status checks) — is ComfyUI still running?`);
      }
    }
  }
  // `break` above jumps clear out of the while, so this check must live OUTSIDE it —
  // inside the loop body it would be skipped and we'd report a bogus "timed out" instead
  // of the real cause.
  if (fatal) throw fatal;   // ComfyUI said the job failed: stop now, don't poll a corpse

  // Giving up on OUR side is not the same as the work stopping on the rig. Cancel first,
  // then report — otherwise the card stays busy on a result nobody will ever collect.
  await comfyCancel(promptId, `timeout after ${timeoutMs / 60000} min`);
  throw new Error(
    `ComfyUI timed out after ${timeoutMs / 60000} min — the job was cancelled on the rig ` +
    `(dequeued, and interrupted only if it was still the running job). If this keeps happening ` +
    `on the same image, the object is ` +
    `likely too heavy: check "Number of voxels (Nvox)" in the ComfyUI log — above ~6 M this ` +
    `card runs out of memory.`
  );
}

async function comfyDownload(filename, subfolder = '', type = 'output') {
  const url = `${COMFY_BASE}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Category inference ───────────────────────────────────────────────────────

const CAT_SYSTEM = [
  'You are a 3D asset categorizer. Given a description, return ONE word from this list:',
  Object.keys(_palette.categories).join(', '),
  '',
  ...Object.entries(_palette.categories).map(([k, v]) => `${k} = ${v.hint}`),
  '',
  'Reply with ONLY the single category word. No explanation.',
].join('\n');

async function inferCategory(userPrompt) {
  try {
    // 'utility' seat (default claude-sonnet-4-6); no extra CLI flags, as before.
    const { text: raw } = await providers.complete('utility', _cfg, {
      system: CAT_SYSTEM, messages: [{ role: 'user', content: userPrompt }], purpose: 'category', extraFlags: [],
    });
    const cat = raw.trim().toLowerCase().split(/\s+/)[0];
    return CATEGORIES[cat] ? cat : 'item';
  } catch (e) {
    console.error(`  Category inference failed (${e.message}), defaulting to 'item'`);
    return 'item';
  }
}

// ─── Metaprompt ───────────────────────────────────────────────────────────────

const META_SYSTEM_HEADER = `You are a Flux 2 image prompt engineer specializing in 3D asset reference images.
The image will be used as input to Trellis, a 3D mesh generator. The image MUST show:
- Single isolated object, centered in frame
- Clean white or transparent background
- Clear silhouette, minimal drop shadow
- All sides of the object visible from a slight 3/4 angle

Output EXACTLY this format, no other text:
POSITIVE:
<prompt, comma-separated phrases, 30-60 words>

NEGATIVE:
<negative prompt, 15-25 words>

Style rules by category:`;

const META_SYSTEM = META_SYSTEM_HEADER +
  Object.entries(_palette.categories).map(([k, v]) => `\n- ${k}: ${v.style}`).join('');

// <lt-fixes> label shows the model the metaprompter seat really uses
function metaprompterLabel() {
  let m = '';
  try { m = (providers.resolveSeat('metaprompter', _cfg) || {}).model || ''; } catch (_) {}
  return m ? `Metaprompter (${m})...` : 'Metaprompter...';
}

async function generateMetaprompt(userPrompt, category) {
  const _mpUser = `Category: ${category}\nDescription: ${userPrompt}`;
  const seat = providers.resolveSeat('metaprompter', _cfg);
  // LM Studio load/unload only makes sense for a local (keyless) OpenAI-compatible seat.
  const isLocal = seat.provider === 'openai-compat' && seat.kind === 'local';
  let text;
  if (isLocal && EJECT_AFTER) lmsLoad(seat.model);
  try {
    ({ text } = await providers.complete('metaprompter', _cfg, {
      system: META_SYSTEM, messages: [{ role: 'user', content: _mpUser }], purpose: 'metaprompt',
    }));
  } catch (e) {
    if (isLocal && e && e.kind === 'unreachable') {
      throw new Error(`Local metaprompter model "${seat.model}" isn't responding from LM Studio at ${seat.url} (${e.message}). Load the model in LM Studio (or enable JIT loading), then retry — or switch the metaprompter to Haiku in Settings (no local model needed).`);
    }
    throw e;
  } finally {
    if (isLocal && EJECT_AFTER) lmsUnload(seat.model);
  }
  const posM = text.match(/POSITIVE:\s*([\s\S]+?)(?:\nNEGATIVE:|$)/i);
  const negM = text.match(/NEGATIVE:\s*([\s\S]+?)$/i);
  const positive = posM ? posM[1].trim() : '';
  const negative = negM ? negM[1].trim() : '';
  if (!positive) {
    console.error('\n  [WARN] Gemma returned empty POSITIVE — raw output below:');
    console.error('  ' + text.slice(0, 400).replace(/\n/g, '\n  '));
    throw new Error('Empty POSITIVE from metaprompter — hit [r] to retry');
  }
  return {
    positive,
    negative: negative || 'blurry, low quality, distorted, multiple objects, cluttered background, shadows, people, text',
  };
}

// ─── Stage: image gen ───────────────────────────────────────────────────

async function runFlux(session) {
  if (!(await ensureComfyUp())) throw comfyGoneError();   // <lc2c-comfy-gone> stop here, no ComfyUI request after a failed check; ComfyUI ggf. lazy neu hochfahren (nach Voice-Verdraengung / Reboot)
  // Local model servers sharing the GPU: unload where possible, else one honest notice (never kills anything).
  await gpuShare.beforeGpuStage(_cfg, 'image');
  // Free an i2i model (Qwen) left resident on the OTHER instance before loading Flux here — same
  // one-GPU multi-instance OOM as the mesh path. Gated by the same switch, best-effort. (F2, 2026-08-06)
  if (FREE_COMFY_BEFORE_MESH) { try { await i2iEngine.freeOtherInstances(_cfg, COMFY_BASE); } catch (_) {} }
  const wfEntry = getActive('image', _cfg);
  const n  = wfEntry.nodes;
  const wf = JSON.parse(fs.readFileSync(resolveWorkflowFile(wfEntry), 'utf8'));

  const lockedSeed = n.seed != null ? wfp.lockedSeed(wfEntry.id) : null;
  if (lockedSeed != null) session.fluxSeed = lockedSeed;
  const set = (slot, value) => { if (n[slot] == null) return; const r = resolveSlot('image', slot, n[slot]); wf[r.node].inputs[r.field] = value; };
  set('positive', session.imagePrompt);
  set('negative', session.negativePrompt);
  set('seed', session.fluxSeed);
  // v1.10 ADV: every declared param of the active workflow (cfg, steps, sampler, size ...) - category override -> workflow value ->
  // JSON default, then a one-off from session.params (CLI edit), clamped. Every target of a param is written (size = width+height on all nodes).
  const run = wfp.run(wfEntry.id, session.category, session.params);
  const setKeys = wfp.applyToGraph(wfEntry, wf, run.values);

  // fluxSeed is drawn at random and is the ONLY thing that makes an image reproducible —
  // the `seed:` printed elsewhere is the Trellis seed. Log it, or the image is gone for good.
  // Only what was really set is logged, by param key; a category override is marked with its category.
  const shown = wfp.describeRun(wfEntry, run, setKeys);
  console.log(`  ${wfEntry.id}` + (shown ? ` · ${shown}` : '') + (n.seed != null ? ` · seed${lockedSeed != null ? ' (locked):' : ''} ${session.fluxSeed}` : ''));

  return withProgress(`${wfEntry.label || wfEntry.id} image gen`, async () => {
    const promptId = await comfyQueue(wf);
    const outputs  = await comfyPoll(promptId, 600000); // 10 min — first run of a heavy image model (Flux) loads GBs before generating

    const outNode  = resolveSlot('image', 'output', n.output).node;
    const saveNode = outputs[outNode];
    if (!saveNode || !saveNode.images || !saveNode.images.length)
      throw new Error(`No image in ComfyUI output node ${outNode}`);

    const img     = saveNode.images[0];
    const imgData = await comfyDownload(img.filename, img.subfolder, img.type);

    const outDir  = path.join(OUTPUT_BASE, session.category);
    fs.mkdirSync(outDir, { recursive: true });
    // Second-precision stamp + a short random token: two jobs with the same prompt slug in the same
    // second (a background batch) otherwise built the SAME filename and one overwrote the other's PNG
    // before the mesh stage picked it up (fixed 2026-08-02).
    const rand    = Math.random().toString(36).slice(2, 6);
    // flux_klein keeps the historic `_flux.png` suffix (existing files, prop-feeder, history); every other workflow writes `_<id>.png`.
    const sfx     = wfEntry.id === 'flux_klein' ? 'flux' : String(wfEntry.id).replace(/[^a-z0-9_]+/gi, '_');
    const outPath = path.join(outDir, `${slug(session.userPrompt)}_${nowStamp()}_${rand}_${sfx}.png`);
    fs.writeFileSync(outPath, imgData);
    try { records.appendRecord({ kind: 'image', path: outPath, workflow: wfEntry.id, prompt: session.imagePrompt, seed: session.fluxSeed, parent: null, category: session.category }); } catch (_) {}
    return outPath;
  });
}

// ─── Stage: Trellis 3D gen ────────────────────────────────────────────────────

async function runTrellis(session) {
  if (!(await ensureComfyUp())) throw comfyGoneError();   // <lc2c-comfy-gone> stop here, no ComfyUI request after a failed check; ComfyUI ggf. lazy neu hochfahren (nach Voice-Verdraengung / Reboot)
  // Mesh OOMs on 10GB cards while a local model still sits in VRAM (LM Studio JIT keeps it loaded ~1h).
  // Every local seat's model is unloaded where the server supports it (LM Studio, Ollama), otherwise an
  // honest PHOENIX_NOTICE — unconditionally, not gated by ejectAfterUse, so the --stage/CLI paths are covered.
  await gpuShare.beforeGpuStage(_cfg, 'mesh');

  if (FREE_COMFY_BEFORE_MESH) {
    // First free any OTHER instance: after an i2i edit, Qwen-Image-Edit (~9.8 GB) stays resident on
    // the Bild instance (:8188) and would OOM the Trellis load on a one-GPU multi-instance box. No-op
    // with a single instance. Best-effort — a failed free must never block the mesh. (F2, 2026-08-06)
    try { await i2iEngine.freeOtherInstances(_cfg, COMFY_BASE); } catch (_) {}
    // Same juggle, other direction: on VRAM-poor boxes ComfyUI itself may still hold the
    // heavy image model (Flux) when the mesh model loads — ask it to free first (official
    // /free API, best-effort). Own switch (vram.freeComfyBeforeMesh), NOT the metaprompter's
    // eject flag — see the config block up top. Big cards can set it false to keep both resident.
    try {
      await fetch(`${COMFY_BASE}/free`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      });
      dbg.event('eject', { phase: 'comfy-freed' });
    } catch (e) { dbg.event('eject', { phase: 'comfy-free-failed', error: (e && e.message) || String(e) }); }
  }

  const wfEntry = getActive('mesh', _cfg);
  const n  = wfEntry.nodes;
  const wf = JSON.parse(fs.readFileSync(resolveWorkflowFile(wfEntry), 'utf8'));

  return withProgress('Trellis 3D gen', async () => {
    const uploadedName = await comfyUploadImage(session.imagePath);
    const prefix = `phoenix_${slug(session.userPrompt)}_${session.trellisSeed}`;

    const set = (slot, value) => { if (n[slot] == null) return; const r = resolveSlot('mesh', slot, n[slot]); wf[r.node].inputs[r.field] = value; };
    set('image', uploadedName);
    const lockedSeed = n.seed != null ? wfp.lockedSeed(wfEntry.id) : null;
    if (lockedSeed != null) session.trellisSeed = lockedSeed;
    set('seed', session.trellisSeed);
    set('output_prefix', prefix);
    // v1.10 ADV: target_face_num, texture_size and the three step controls come from the workflow's declared params (every target written).
    const run = wfp.run(wfEntry.id, session.category, session.params);
    const setKeys = wfp.applyToGraph(wfEntry, wf, run.values);
    const shown = wfp.describeRun(wfEntry, run, setKeys);
    process.stdout.write(`\n  ${wfEntry.id}` + (shown ? ` · ${shown}` : '') + (n.seed != null ? ` · seed${lockedSeed != null ? ' (locked):' : ''} ${session.trellisSeed}` : '') + '\n');

    // ── OOM self-rescue ────────────────────────────────────────────────────────
    // The memory peak of the mesh step is the dual-contouring GRID, and it grows with the
    // cube of its resolution: halving it cuts the peak ~8x. A card that cannot hold DC 1024
    // can almost always hold 512. Since a CUDA OOM is now reported cleanly (err.oom), we no
    // longer have to die on it — we retry one rung lower instead of losing the job (or, on a
    // shoot, the take). The mesh comes out coarser; that is stated, not hidden.
    // Only the in-memory workflow is changed — the file on disk is never touched.
    const dcNode = Object.keys(wf).find(id => wf[id] && wf[id].inputs &&
                                              wf[id].inputs.dual_contouring_resolution !== undefined);
    const dcNow  = dcNode ? parseInt(wf[dcNode].inputs.dual_contouring_resolution, 10) : NaN;
    // ONE retry, not a staircase. Measured 12.07.: the case that recovers (2048 -> 1024) needs
    // exactly one rung; the case that cannot be saved (oak-d: OOM at 512, 256 AND 128 — its memory
    // peak is NOT the DC grid) just OOMs on every rung. A 3-rung ladder turned a 5-minute failure
    // into a 14-minute one — on a shoot that is worse than failing fast. Rungs are configurable.
    const rungs  = Math.max(1, (_vram.oomRetryRungs != null ? _vram.oomRetryRungs : 2));
    const ladder = Number.isFinite(dcNow)
      ? [...new Set(Array.from({ length: rungs }, (_, k) => Math.floor(dcNow / Math.pow(2, k))))].filter(v => v >= 128)
      : [null];   // no DC knob in this workflow ⇒ single attempt, no retry

    let outputs = null;
    for (let i = 0; i < ladder.length; i++) {
      if (dcNode && ladder[i] != null) wf[dcNode].inputs.dual_contouring_resolution = String(ladder[i]);
      try {
        const promptId = await comfyQueue(wf);
        outputs = await comfyPoll(promptId, 1800000); // 30 min — a first mesh run may pull GBs of Trellis models
        if (i > 0) {
          process.stdout.write(`\n  ✓ recovered at dual_contouring_resolution ${ladder[i]} (mesh is coarser than at ${ladder[0]})\n`);
          dbg.event('mesh', { phase: 'oom-recovered', dc: ladder[i], startedAt: ladder[0] });
        }
        break;
      } catch (e) {
        const last = (i === ladder.length - 1);
        if (!e.oom || last) {
          if (e.oom) dbg.event('mesh', { phase: 'oom-exhausted', tried: ladder.slice(0, i + 1) });
          throw e;
        }
        // Newline first: withProgress is mid-`\r` ticker, otherwise the message gets eaten.
        process.stdout.write(`\n  ⚠ CUDA OOM at dual_contouring_resolution ${ladder[i]} — retrying at ${ladder[i + 1]}\n`);
        dbg.event('mesh', { phase: 'oom-retry', from: ladder[i], to: ladder[i + 1], node: e.node });
        try {   // hand the card back before the next attempt, or it OOMs again on the same leftovers
          await fetch(`${COMFY_BASE}/free`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true }),
          });
        } catch { /* best effort */ }
      }
    }

    // ExportMesh returns glb_path as STRING output
    let glbPath = null;
    const outNode = resolveSlot('mesh', 'output', n.output).node;
    const expNode = outputs[outNode];
    if (expNode && expNode.glb_path) {
      glbPath = Array.isArray(expNode.glb_path) ? expNode.glb_path[0] : expNode.glb_path;
    }

    // Fallback: scan ComfyUI output dir for newest matching GLB — only meaningful when
    // ComfyUI runs on this machine. Over a tunnel the directory does not exist here.
    if ((!glbPath || !fs.existsSync(glbPath)) && COMFY_OUTPUT && fs.existsSync(COMFY_OUTPUT)) {
      const files = fs.readdirSync(COMFY_OUTPUT)
        .filter(f => f.startsWith(prefix) && f.endsWith('.glb'))
        .map(f => ({ f, mt: fs.statSync(path.join(COMFY_OUTPUT, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);
      if (files.length) glbPath = path.join(COMFY_OUTPUT, files[0].f);
    }

    const outDir  = path.join(OUTPUT_BASE, session.category);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${prefix}.glb`);

    if (glbPath && fs.existsSync(glbPath)) {
      fs.copyFileSync(glbPath, outPath);
      return outPath;
    }

    // ComfyUI may be remote (tunnel) — fetch the GLB over HTTP like the image stage does.
    // Trellis' ExportMesh reports nothing into /history, so the name ComfyUI assigned has
    // to be reconstructed: <prefix>_0000N_.glb, N only counting up on a name collision.
    const tried = [];
    if (glbPath) tried.push(path.basename(glbPath));
    for (let i = 1; i <= 5; i++) tried.push(`${prefix}_${String(i).padStart(5, '0')}_.glb`);

    for (const name of tried) {
      try {
        fs.writeFileSync(outPath, await comfyDownload(name));
        return outPath;
      } catch { /* not this name — try the next */ }
    }

    throw new Error(`GLB not found after Trellis run (prefix: ${prefix}) — neither on disk nor via ComfyUI /view (tried: ${tried.join(', ')})`);
  });
}

// ─── Stage: Blender cleanup ───────────────────────────────────────────────────

async function blenderCleanup(session) {
  const meshPath = session.meshPath.replace(/\\/g, '/');
  const assetName = slug(session.userPrompt);

  const code = [
    'import bpy',
    `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(meshPath)})`,
    'imported = [o for o in bpy.context.selected_objects if o.type == "MESH"]',
    'for obj in imported:',
    '    bpy.ops.object.select_all(action="DESELECT")',
    '    obj.select_set(True)',
    '    bpy.context.view_layer.objects.active = obj',
    // NOTE: normals_make_consistent(inside=False) removed 2026-06-23 — it flipped ~26% of faces
    // on Trellis output (measured 1876/7236), causing "missing surfaces". auto_smooth fixes the
    // shading without touching winding; raw GLB normals are kept as-is.
    '    try:',
    '        bpy.ops.object.shade_auto_smooth(angle=0.523599)',
    '        print("SMOOTH:auto_smooth")',
    '    except Exception:',
    '        try:',
    '            bpy.ops.object.shade_smooth_by_angle(angle=0.523599)',
    '            print("SMOOTH:smooth_by_angle")',
    '        except Exception as _e:',
    '            bpy.ops.object.shade_smooth()',
    '            print("SMOOTH:fallback " + str(_e))',
    `    obj.name = ${JSON.stringify(assetName)}`,
    ...demetalPy('imported'),
    'print("CLEANUP_DONE:" + str(len(imported)))',
  ].join('\n');

  return withProgress('Blender cleanup', () => callBlender(code));
}

async function importRaw(session) {
  const meshPath  = session.meshPath.replace(/\\/g, '/');
  const assetName = slug(session.userPrompt) + '_raw';

  const code = [
    'import bpy',
    `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(meshPath)})`,
    'imported = [o for o in bpy.context.selected_objects if o.type == "MESH"]',
    'for obj in imported:',
    `    obj.name = ${JSON.stringify(assetName)}`,
    ...demetalPy('imported'),
    'print("IMPORT_RAW_DONE:" + str(len(imported)))',
  ].join('\n');

  return withProgress('Import raw', () => callBlender(code));
}

// ─── UX helpers ──────────────────────────────────────────────────────────────

function prompt(rl, q) {
  return new Promise(res => rl.question(q, res));
}

async function stepPause(rl, label, withSameSeed = true) {
  const opts = withSameSeed
    ? '[n] next  [r] redo (new seed)  [s] redo (same seed)  [e] edit params  [q] quit'
    : '[n] next  [r] redo  [e] edit params  [q] quit';
  while (true) {
    const raw = await prompt(rl, `\n  --- ${label} ---\n  ${opts}\n> `);
    const c = raw.trim().toLowerCase();
    if (['n','r','s','e','q'].includes(c)) return c;
    console.log('  Unknown key.');
  }
}

async function editParams(rl, session) {
  console.log('\n  Current params:');
  for (const [k, v] of Object.entries(session.params)) {
    console.log(`    ${k.padEnd(20)} ${v && typeof v === 'object' ? v.w + 'x' + v.h : v}`);
  }
  console.log('  Enter param=value to change (empty to cancel):');
  while (true) {
    const raw = await prompt(rl, '  > ');
    if (!raw.trim()) return;
    const m = raw.trim().match(/^(\w+)\s*=\s*(.+)$/);
    if (!m) { console.log('  Format: param_name=value'); continue; }
    const [, k, v] = m;
    if (!(k in session.params)) { console.log(`  Unknown: ${k}. Valid: ${Object.keys(session.params).join(', ')}`); continue; }
    const num = parseFloat(v);
    if (session.params[k] && typeof session.params[k] === 'object') {   // size: WxH (one-off for this run, never stored; clamped when applied)
      const sz = /^(\d+)\s*[x*,]\s*(\d+)$/i.exec(v.trim());
      if (!sz) { console.log('  Size needs the form WIDTHxHEIGHT, e.g. 1344x768'); continue; }
      session.params[k] = { w: Number(sz[1]), h: Number(sz[2]) };
    } else {
      // parse by the param's DECLARATION (a float that happens to be 4 may become 4.2); clamping to the range happens when it is applied
      let decl = null;
      for (const st of ['image', 'mesh']) { try { const d = wfp.declared(getActive(st, _cfg).id).find(x => x.key === k); if (d) { decl = d; break; } } catch (_) { /* no declaration */ } }
      if (decl && decl.type === 'int') session.params[k] = isNaN(num) ? session.params[k] : Math.round(num);
      else if (decl && decl.type === 'float') session.params[k] = isNaN(num) ? session.params[k] : num;
      else if (decl && decl.type === 'enum' && Array.isArray(decl.options)) { const hit = decl.options.find(o => String(o) === v.trim()); if (hit !== undefined) session.params[k] = hit; }
      else session.params[k] = isNaN(num) ? v : (Number.isInteger(session.params[k]) ? Math.round(num) : num);
    }
    console.log(`  Set ${k} = ${session.params[k] && typeof session.params[k] === 'object' ? session.params[k].w + 'x' + session.params[k].h : session.params[k]}  (this run only)`);
    return;
  }
}

// ─── Shared finalization (staging copy + RESULT_GLB marker) ──────────────────

async function finalizeMesh(session, headless = false) {
  if (session.meshPath && fs.existsSync(session.meshPath)) {
    const stagingDir = path.join(STAGING_BASE, session.category);
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagingPath = path.join(stagingDir, path.basename(session.meshPath));
    fs.copyFileSync(session.meshPath, stagingPath);
    let meshWf = null; try { meshWf = getActive('mesh', _cfg).id; } catch (_) {}
    try { records.appendRecord({ kind: 'mesh', path: stagingPath, workflow: meshWf, prompt: session.userPrompt, seed: session.trellisSeed, parent: session.imagePath, category: session.category }); } catch (_) {}
    console.log(`\n  Saved to staging:\n  ${stagingPath}`);
    if (headless) process.stdout.write(`\nRESULT_GLB: ${stagingPath}\n`);
    return stagingPath;
  }
  return null;
}

// ─── Stage entry points ───────────────────────────────────────────────────────

// 'storyboard' is a built-in, hidden destination (no palette entry, no palette UI): the storyboard keyframe of a shot with no references.
// It is never inferred: output lands in output/storyboard/, the prompt is the user's literal one (no category style, no LLM call).
const STORYBOARD_CATEGORY = 'storyboard';
async function resolveImageCategory(categoryOverride, userPrompt) {
  if (categoryOverride === STORYBOARD_CATEGORY) return STORYBOARD_CATEGORY;
  return (categoryOverride && CATEGORIES[categoryOverride]) ? categoryOverride : await inferCategory(userPrompt);
}

async function runImageStage(userPrompt, categoryOverride, literalPos = null, literalNeg = null, size = null) {
  // Validate the override against the palette: an unknown category (LLM invented one, or a custom
  // category deleted after the image step) would make CATEGORIES[category] undefined → empty params →
  // undefined workflow inputs → a raw ComfyUI 400. inferCategory always returns a real category.
  const category = await resolveImageCategory(categoryOverride, userPrompt);
  const params   = stageParams('image', category);
  if (size && size.w > 0 && size.h > 0) params.size = { w: size.w, h: size.h };   // one-off (never stored): the storyboard keyframe size; clamped by workflow-params like every one-off
  const session  = {
    userPrompt,
    category,
    params,
    fluxSeed:      drawSeed('image'),
    imagePrompt:   null,
    negativePrompt: null,
    imagePath:     null,
  };

  process.stdout.write(`CATEGORY: ${category}\n`);
  console.log(`  Category: ${category}  (${CATEGORY_LABELS[category] || 'storyboard keyframe'})`);

  // Step 1: Metaprompt (or bypass with literal prompt)
  if (literalPos && literalPos.trim()) {
    session.imagePrompt    = literalPos;
    session.negativePrompt = literalNeg || '';
    console.log('  Using provided prompt (metaprompter skipped).');
  } else {
    process.stdout.write('  ' + metaprompterLabel());
    const { positive, negative } = await generateMetaprompt(userPrompt, category);
    session.imagePrompt    = positive;
    session.negativePrompt = negative;
  }
  console.log('\n\n  POSITIVE:\n  ' + session.imagePrompt);
  console.log('\n  NEGATIVE:\n  ' + session.negativePrompt);
  process.stdout.write(`RESULT_PROMPT_POS: ${session.imagePrompt.replace(/\n/g, ' ')}\n`);
  process.stdout.write(`RESULT_PROMPT_NEG: ${session.negativePrompt.replace(/\n/g, ' ')}\n`);

  // Step 2: Image generation
  console.log(`\n  seed: ${session.fluxSeed}`);
  session.imagePath = await runFlux(session);
  console.log(`  → ${session.imagePath}`);
  process.stdout.write(`RESULT_IMAGE: ${session.imagePath}\n`);
}

async function runMeshStage(imagePath, userPrompt, categoryOverride, targetFaceNum = null) {
  if (!fs.existsSync(imagePath)) {
    process.stderr.write(`Stage error: image not found: ${imagePath}\n`);
    process.exit(1);
  }

  const category = (categoryOverride && CATEGORIES[categoryOverride]) ? categoryOverride : await inferCategory(userPrompt);
  const params   = stageParams('mesh', category);
  if (Number.isFinite(targetFaceNum) && targetFaceNum > 0) {
    params.target_face_num = Math.round(Math.min(300000, Math.max(200, targetFaceNum)));   // one-off (--faces): this call only, never stored
  }
  const session  = {
    userPrompt,
    category,
    params,
    trellisSeed: drawSeed('mesh'),
    imagePath,
    meshPath:    null,
  };

  console.log(`  Category: ${category}  (${CATEGORY_LABELS[category]})`);
  console.log(`  seed: ${session.trellisSeed}` + (session.params.target_face_num != null ? `  |  target_face_num: ${session.params.target_face_num}` : ''));

  // Step 1: Trellis 3D gen
  session.meshPath = await runTrellis(session);
  console.log(`  → ${session.meshPath}`);

  // Step 2 (cleanup/import) is intentionally removed — deferred to the import gate.
  // The orchestrator calls import_asset with cleanup:true|false to control shading.

  // Step 3: Staging + RESULT_GLB marker
  await finalizeMesh(session, true);
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

async function runPipeline(rl, userPrompt, categoryOverride = null, headless = false) {
  const session = {
    userPrompt,
    category:      null,
    params:        null,
    fluxSeed:      drawSeed('image'),
    trellisSeed:   drawSeed('mesh'),
    imagePrompt:   null,
    negativePrompt: null,
    imagePath:     null,
    meshPath:      null,
  };

  // Category
  process.stdout.write('  Detecting category...');
  session.category = (categoryOverride && CATEGORIES[categoryOverride]) ? categoryOverride : await inferCategory(userPrompt);
  session.params   = { ...stageParams('image', session.category), ...stageParams('mesh', session.category) };
  console.log(` ${session.category}  (${CATEGORY_LABELS[session.category]})`);
  console.log('  Defaults → ' + Object.entries(session.params).map(([k, v]) => `${k} ${v && typeof v === 'object' ? v.w + '×' + v.h : v}`).join(' | ') + '\n');

  // ── Step 1: Metaprompt ────────────────────────────────────────────────────
  while (true) {
    process.stdout.write('  ' + metaprompterLabel());
    try {
      const { positive, negative } = await generateMetaprompt(userPrompt, session.category);
      session.imagePrompt    = positive;
      session.negativePrompt = negative;
      console.log('\n\n  POSITIVE:\n  ' + positive);
      console.log('\n  NEGATIVE:\n  ' + negative);
    } catch (e) {
      console.error(`\n  Metaprompt failed: ${e.message}`);
      if (headless) throw e;
    }
    if (headless) break;

    const c = await stepPause(rl, 'Metaprompt', false);
    if (c === 'q') return;
    if (c === 'e') { await editParams(rl, session); continue; }
    if (c === 'r') continue;
    break;
  }

  // ── Step 2: Image generation ──────────────────────────────────────────────
  while (true) {
    console.log(`\n  seed: ${session.fluxSeed}`);
    try {
      session.imagePath = await runFlux(session);
      console.log(`  → ${session.imagePath}`);
    } catch (e) {
      console.error(`  Image gen failed: ${e.message}`);
      if (headless) throw e;
    }
    if (headless) break;

    const c = await stepPause(rl, 'Image result', true);
    if (c === 'q') return;
    if (c === 'r') { session.fluxSeed = drawSeed('image'); continue; }
    if (c === 's') continue;
    if (c === 'e') { await editParams(rl, session); session.fluxSeed = drawSeed('image'); continue; }
    break;
  }

  // ── Step 3: 3D generation ─────────────────────────────────────────────────
  while (true) {
    console.log(`\n  seed: ${session.trellisSeed}  |  target_face_num: ${session.params.target_face_num}`);
    try {
      session.meshPath = await runTrellis(session);
      console.log(`  → ${session.meshPath}`);
    } catch (e) {
      console.error(`  3D gen failed: ${e.message}`);
      if (headless) throw e;
    }
    if (headless) break;

    const c = await stepPause(rl, '3D mesh result', true);
    if (c === 'q') return;
    if (c === 'r') { session.trellisSeed = drawSeed('mesh'); continue; }
    if (c === 's') continue;
    if (c === 'e') { await editParams(rl, session); continue; }
    break;
  }

  // ── Step 4: Blender cleanup (interactive only — headless skips; import gate owns cleanup) ──
  if (!headless && session.meshPath) {
    const doClean = await prompt(rl, '\n  Run Blender cleanup? (normals + smooth shading) [y/n] ');
    if (doClean.trim().toLowerCase() === 'y') {
      try {
        const result = await blenderCleanup(session);
        const out = result.stdout || result.output || JSON.stringify(result);
        if (out) console.log('  ' + out);
      } catch (e) {
        console.log(`  Blender cleanup skipped: ${e.message}`);
      }
    }
  }

  // ── Step 5: Staging ───────────────────────────────────────────────────────
  await finalizeMesh(session, headless);

  // ── Post-run: re-import menu (interactive only) ───────────────────────────
  if (!headless && rl && session.meshPath && fs.existsSync(session.meshPath)) {
    while (true) {
      const raw = await prompt(
        rl,
        `\n  --- re-import ${path.basename(session.meshPath)} ---\n  [i] import raw (no cleanup)   [c] import + cleanup   [enter] done\n> `
      );
      const c = raw.trim().toLowerCase();
      if (c === '') break;
      if (c === 'i') {
        try {
          const r = await importRaw(session);
          const out = r.stdout || r.output || '';
          if (out) console.log('  ' + String(out).trim());
        } catch (e) { console.log(`  Import failed: ${e.message}`); }
        continue;
      }
      if (c === 'c') {
        try {
          const r = await blenderCleanup(session);
          const out = r.stdout || r.output || '';
          if (out) console.log('  ' + String(out).trim());
        } catch (e) { console.log(`  Cleanup import failed: ${e.message}`); }
        continue;
      }
      console.log('  Unknown key.');
    }
  }

  console.log('\n  Pipeline complete.\n');
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

async function main() {
  dbg.initDebug({ enabled: process.argv.includes('--debug') });
  console.log('\n  PHOENIX AGENT v0.1');
  console.log('  Text  →  Image (Flux 2 Klein)  →  3D (Trellis)  →  Blender\n');
  console.log('  Type a description to start, or prefix with category:');
  console.log('  furniture: wooden chair   |   item: battle axe   |   exit\n');

  if (!process.argv.includes('--skip-preflight')) {
    try {
      await runPreflight();
    } catch (e) {
      console.log(`  (preflight skipped — internal error: ${e.message})`);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question('phoenix> ', async raw => {
      const input = raw.trim();
      if (!input)                            { ask(); return; }
      if (input === 'exit' || input === 'quit') { console.log('  Bye.\n'); rl.close(); return; }

      if (input === '/debug' || input.startsWith('/debug ')) {
        const arg = input.slice(6).trim();
        if (arg === 'on')       { dbg.setDebug(true);  console.log('  debug echo ON\n'); }
        else if (arg === 'off') { dbg.setDebug(false); console.log('  debug echo OFF\n'); }
        else                    { console.log(`  debug echo is ${dbg.isDebug() ? 'ON' : 'OFF'}\n`); }
        ask(); return;
      }
      if (input.startsWith('/')) {
        console.log(`  Unknown command: ${input}  (try /debug on)\n`);
        ask(); return;
      }

      let userPrompt = input;
      let catOverride = null;
      const m = input.match(/^([a-z]+):\s*(.+)$/i);
      if (m && CATEGORIES[m[1].toLowerCase()]) {
        catOverride = m[1].toLowerCase();
        userPrompt  = m[2].trim();
      }

      try {
        await runPipeline(rl, userPrompt, catOverride);
      } catch (e) {
        console.error(`\n  Pipeline error: ${e.message}\n`);
      }

      ask();
    });
  };

  ask();
}

// CLI dispatch
const _args = process.argv.slice(2);
const _isMain = require.main === module;   // required as a module (tests) → export only, don't dispatch
if (_isMain) dbg.initDebug({ enabled: _args.includes('--debug') });

const _si = _args.indexOf('--stage');
const _hi = _args.indexOf('--headless');

if (!_isMain) {
  module.exports = { inferCategory, generateMetaprompt, resolveImageCategory, STORYBOARD_CATEGORY };
} else if (_si >= 0) {
  // Stage mode: node phoenix.js --stage <image|mesh> --desc "<text>" [--cat <cat>] [--image "<path>"] [--prompt "<pos>"] [--neg "<neg>"]
  const _stageName = _args[_si + 1] || '';
  const _di        = _args.indexOf('--desc');
  const _desc      = _di >= 0 ? _args[_di + 1] : null;
  const _ci        = _args.indexOf('--cat');
  const _cat       = _ci >= 0 ? _args[_ci + 1] : null;

  if (_stageName === 'image') {
    if (!_desc) { process.stderr.write('--stage image requires --desc "<description>"\n'); process.exit(1); }
    const _ppi  = _args.indexOf('--prompt');
    const _ppos = _ppi >= 0 ? _args[_ppi + 1] : null;
    const _nni  = _args.indexOf('--neg');
    const _nneg = _nni >= 0 ? _args[_nni + 1] : null;
    (async () => {
      try {
        const _wi = _args.indexOf('--width'), _hgi = _args.indexOf('--height');
        const _sz = (_wi >= 0 && _hgi >= 0 && parseInt(_args[_wi + 1], 10) > 0 && parseInt(_args[_hgi + 1], 10) > 0) ? { w: parseInt(_args[_wi + 1], 10), h: parseInt(_args[_hgi + 1], 10) } : null;
        await runImageStage(_desc, _cat, _ppos, _nneg, _sz);
      } catch (e) {
        if (!e.comfyGone) process.stderr.write(`Stage error: ${e.message}\n`);   // <lc2c-comfy-gone> ComfyUI text already printed once by ensureComfyUp
        process.exitCode = 1;
        return;
      }
    })();
  } else if (_stageName === 'mesh') {
    // Usage: --stage mesh --image "<path>" --desc "<text>" [--cat <cat>] [--faces <n>]
    const _ii    = _args.indexOf('--image');
    const _image = _ii >= 0 ? _args[_ii + 1] : null;
    if (!_image) { process.stderr.write('--stage mesh requires --image "<path>"\n'); process.exit(1); }
    if (!_desc)  { process.stderr.write('--stage mesh requires --desc "<description>"\n'); process.exit(1); }
    const _fi    = _args.indexOf('--faces');
    const _faces = _fi >= 0 ? parseInt(_args[_fi + 1], 10) : null;
    (async () => {
      try {
        await runMeshStage(_image, _desc, _cat, Number.isFinite(_faces) ? _faces : null);
      } catch (e) {
        if (!e.comfyGone) process.stderr.write(`Stage error: ${e.message}\n`);   // <lc2c-comfy-gone> ComfyUI text already printed once by ensureComfyUp
        process.exitCode = 1;
        return;
      }
    })();
  } else if (_stageName === 'prompt') {
    // Usage: --stage prompt --desc "<text>" [--cat <cat>]
    if (!_desc) { process.stderr.write('--stage prompt requires --desc "<description>"\n'); process.exit(1); }
    (async () => {
      try {
        const category = _cat || await inferCategory(_desc);
        process.stdout.write(`CATEGORY: ${category}\n`);
        console.log(`  Category: ${category}  (${CATEGORY_LABELS[category]})`);
        process.stdout.write('  ' + metaprompterLabel());
        const { positive, negative } = await generateMetaprompt(_desc, category);
        console.log('\n\n  POSITIVE:\n  ' + positive);
        console.log('\n  NEGATIVE:\n  ' + negative);
        process.stdout.write(`RESULT_PROMPT_POS: ${positive.replace(/\n/g, ' ')}\n`);
        process.stdout.write(`RESULT_PROMPT_NEG: ${negative.replace(/\n/g, ' ')}\n`);
      } catch (e) {
        process.stderr.write(`Stage error: ${e.message}\n`);
        process.exitCode = 1;
        return;
      }
    })();
  } else {
    process.stderr.write(`Unknown stage: "${_stageName}". Valid stages: image, mesh, prompt\n`);
    process.exit(1);
  }
} else if (_hi >= 0) {
  // Headless mode: node phoenix.js --headless "description" [--cat category]
  const _desc = _args[_hi + 1] || '';
  const _ci   = _args.indexOf('--cat');
  const _cat  = _ci >= 0 ? _args[_ci + 1] : null;
  if (!_desc) { console.error('--headless requires a description argument'); process.exit(1); }
  (async () => {
    try {
      await runPipeline(null, _desc, _cat, true);
    } catch (e) {
      console.error(`Pipeline error: ${e.message}`);
      process.exit(1);
    }
  })();
} else {
  main();
}
