'use strict';

// ─── i2i.js — image-to-image edit engine (v1.8) ──────────────────────────────
//
// Runs an i2i-category workflow (Qwen-Image-Edit for appearance/material/style edits;
// SAM3 for text-guided isolation) against the ComfyUI instance the workflow entry names.
//
// WHY A SEPARATE MODULE (not phoenix.js's helpers): the image/mesh pipeline helpers
// (comfyQueue/comfyPoll/…) are hard-wired to COMFY_BASE (the image/mesh instance) and carry the OOM-ladder +
// pipeline-cancel-marker machinery that the release-critical mesh path depends on. i2i talks to a
// DIFFERENT instance (Qwen lives on the Bild-Instanz :8188), is single-shot, and must not risk
// regressing that path. So it gets its own minimal, base-parametrised helpers here.
//
// Measured facts driving the design (from development testing):
//   • Qwen-Image-Edit = appearance/material/style edits only (CFG ~4 is the lever). It does NOT do
//     structure removal and does NOT do novel-view/camera rotation — both need generating unseen
//     geometry, which an edit model can't. Isolation therefore goes through SAM3, not Qwen.
//   • ~3–4 min per edit on a 10 GB card (VL-encoder + Unet swap). Callers must show progress.

const fs   = require('fs');
const path = require('path');
const wfLib = require('./workflows.js');
const crypto = require('crypto');
const records = require('./records');   // append-only output record (v1.10 C1)
const wfp = require('./workflow-params');   // v1.10 ADV: cfg / steps / sampler / denoise per workflow

// ── instance → base URL ──────────────────────────────────────────────────────
// Running SEVERAL ComfyUI instances is a legitimate, first-class setup — different node sets need
// incompatible Python/CUDA environments (e.g. Trellis vs Qwen-Image-Edit/Flux), so they live in
// separate venvs on separate ports. That is true even on ONE machine. The `instance` field on a
// workflow entry ('bild' | 'trellis') says WHICH ComfyUI a workflow belongs to.
//
// The release requirement is only that it ALSO works with a single instance: `endpoints.comfyui`
// is the one always-present endpoint, and if no per-instance endpoint is configured, every stage
// (i2i included) targets it. A user then runs:
//   • one ComfyUI with all nodes  → set only endpoints.comfyui → everything on one port; or
//   • several ComfyUI (one machine or many) → also set endpoints.comfyui_bild (and future keys)
//     → each workflow hits its own instance.
// So the multi-instance split is SUPPORTED, not assumed — never rig-only, never remote-only
// (bases default to localhost).
//
// ⚠️ KNOWN GAP (the real single-machine work): several instances share ONE GPU's VRAM. Running an
// i2i edit on 'bild' while 'trellis' holds the card OOMs (measured 2026-08-06). Freeing the idle
// instance before running on the other is the "systemd/Preflight" ops job, not yet built here.
function baseForInstance(config, instance) {
  const endpoints = (config && config.endpoints) || {};
  const main = endpoints.comfyui || 'http://localhost:8188';   // ComfyUI's own default port
  if (instance === 'bild') return endpoints.comfyui_bild || main;
  return main;
}

// Normalize a base URL for IDENTITY comparison only (never for fetching): lowercase, strip any
// trailing slash. So "http://localhost:8188" and "http://localhost:8188/" are not mistaken for two
// different instances — which would make the free-other loop unload the very model it's about to
// use. Cheap on purpose: it does NOT equate localhost with 127.0.0.1 (that needs host resolution,
// overkill here); a user who names the SAME instance both ways in two keys is the documented edge.
function normBase(b) {
  return String(b || '').trim().replace(/\/+$/, '').toLowerCase();
}

// Every distinct ComfyUI endpoint the config knows about. Used to free VRAM on the OTHER instances
// before running on one — see the VRAM-orchestration note in runI2I. De-duped by normalized form
// but the RAW url is kept (that's what /free is fetched against).
function allComfyBases(config) {
  const e = (config && config.endpoints) || {};
  const bases = [];
  const seen = new Set();
  for (const key of ['comfyui', 'comfyui_bild']) {
    const v = e[key];
    if (v && !seen.has(normBase(v))) { seen.add(normBase(v)); bases.push(v); }
  }
  return bases;
}

// Free every configured ComfyUI instance EXCEPT the one at keepBase. Exported for the mesh/image
// stages: after an i2i edit, the edit model (Qwen, ~9.8 GB) stays resident on the OTHER instance,
// so a following mesh/image load on a one-GPU multi-instance box OOMs unless that instance is freed
// first. Best-effort, never throws, and a plain no-op with a single instance (nothing else to free).
async function freeOtherInstances(config, keepBase) {
  for (const other of allComfyBases(config)) {
    if (normBase(other) !== normBase(keepBase)) await freeInstance(other);
  }
}

// Best-effort: ask a ComfyUI to unload its models + free VRAM. Uses ComfyUI's own /free endpoint —
// PORTABLE (no supervisor, no SSH), so it works on a single machine as well as with a separate GPU box. Never
// throws: a free that fails (instance down / unreachable) must not block the run.
const freedAt = new Map();   // v1.10 V2 r3: normalised base -> when something last asked that ComfyUI to unload its models (a loaded model is gone then: the next run is a cold one)
const lastFreed = (base) => freedAt.get(normBase(base)) || 0;
async function freeInstance(base) {
  try {
    await fetch(`${base}/free`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(8000),
    });
    freedAt.set(normBase(base), Date.now());
    return true;
  } catch { return false; }
}

// ── minimal comfy helpers, parametrised by base ──────────────────────────────
// v1.10 V2 r2: the optional `signal` (the job's AbortSignal) is combined with a deadline on every request of the local video path, also while the body is read,
// so a stalled connection ends in seconds and a Stop ends it at once. Without a signal every function behaves exactly as before.
const guard = (signal, ms) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : undefined);
async function uploadImage(base, imagePath, uploadName, signal) {
  const data = fs.readFileSync(imagePath);
  const name = uploadName || path.basename(imagePath);
  const form = new FormData();
  form.append('image', new Blob([data], { type: 'image/png' }), name);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res = await fetch(`${base}/upload/image`, signal ? { method: 'POST', body: form, signal: guard(signal, 30000) } : { method: 'POST', body: form });
  if (!res.ok) throw new Error(`i2i upload failed ${res.status}: ${await res.text()}`);
  return (await res.json()).name;
}

// <lc2a-r2> B1: the in-process reference path has no phoenix.js stage in front of it, so it needs the same
// "ComfyUI is gone" handling + wording as phoenix.js ensureComfyUp (Contract 5: one text everywhere).
// Returns null when ComfyUI answers (the original error then stands), else the Contract-5 sentence.
// v1.10 V2 r3: the optional `signal` (the job's AbortSignal) ends the whole recovery at once: the ssh child is killed, the restart wait stops, the error is flagged .aborted.
async function comfyGoneMessage(config, base, signal) {
  const stopped = () => Object.assign(new Error('Stopped'), { aborted: true });
  const answers = async () => { try { const r = await fetch(`${base}/queue`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) }); return r.ok; } catch (_) { return false; } };
  if (signal && signal.aborted) throw stopped();
  if (await answers()) return null;
  if (signal && signal.aborted) throw stopped();
  const e = (config && config.endpoints) || {};
  const rig = e.rigSsh || null, sup = e.comfySupervisor || null;
  if (!rig || !sup) return `ComfyUI is not answering at ${base}. Start it (or fix endpoints.comfyui). If it runs on another machine that may stop it to free VRAM, set endpoints.rigSsh + endpoints.comfySupervisor so Phoenix restarts it by itself.`;
  const inst = /:8000(\D|$)/.test(base) ? 'trellis' : (/:8188(\D|$)/.test(base) ? 'bild' : null);
  if (!inst) return `ComfyUI is not answering at ${base} and Phoenix cannot restart it: endpoints.rigSsh (${rig}) is set, but this port maps to no supervisor instance (8000 = trellis, 8188 = bild). Start ComfyUI yourself or fix endpoints.comfyui.`;
  let fail = null;
  // <lc2a-r3> B1: ASYNC ssh - this runs inside the server process; spawnSync froze SSE/chat/Library for up to the 120 s timeout
  try {
    const r = await new Promise((resolve) => {
      try {
        require('child_process').execFile('ssh', ['-o', 'ConnectTimeout=10', rig, `node ${sup} up ${inst}`], { encoding: 'utf8', timeout: 120000, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
          resolve({ err, stdout: stdout || '', stderr: stderr || '' });
        });
      } catch (err) { resolve({ err, stdout: '', stderr: '' }); }
    });
    if (signal && signal.aborted) throw stopped();
    const line = (r.stdout + r.stderr).trim();
    const er = r.err;
    if (er) {
      const spawnFail = er.code !== undefined && typeof er.code !== 'number';   // ENOENT etc.: ssh could not even start
      const exitCode = typeof er.code === 'number' ? er.code : null;
      fail = (spawnFail && er.message) || (line && line.split('\n').pop()) || (er.signal ? 'killed by ' + er.signal : (exitCode !== null ? 'exit code ' + exitCode : er.message));
    }
  } catch (err) { if (err && err.aborted) throw err; fail = err.message; }
  if (fail) return `ComfyUI is not answering at ${base} and the restart over ${rig} failed: ${String(fail).replace(/\s+/g, ' ').slice(0, 160)}.`;
  for (let i = 0; i < 20; i++) {
    if (await answers()) return null;
    if (signal && signal.aborted) throw stopped();
    await new Promise((res) => { const t = setTimeout(res, 1500); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
    if (signal && signal.aborted) throw stopped();
  }
  return `ComfyUI is not answering at ${base} and the restart over ${rig} failed: ${inst} still not reachable after the restart (check the connection).`;
}

// <lc2a-r3> upload with the Contract-5 treatment: a CONNECTION failure (no HTTP answer) on the first contact is explained by comfyGoneMessage;
// ComfyUI answering again (restart / blip) -> one retry. Used by runReference (first reference) and runI2I.
async function uploadOrExplain(config, base, imagePath, upName, signal) {
  try { return await uploadImage(base, imagePath, upName, signal); }
  catch (err) {
    if (/^i2i upload failed/.test(String(err && err.message))) throw err;
    if (signal && signal.aborted) throw err;
    const gone = await comfyGoneMessage(config, base, signal);
    if (gone) throw new Error(gone);
    return uploadImage(base, imagePath, upName, signal);
  }
}

// v1.10 V2 r3: promptId (optional) is sent as `prompt_id` - ComfyUI keeps a client-supplied id, so an aborted/timed-out submission can still be cancelled by that id; the id in the answer wins if it differs.
async function queue(base, workflow, signal, promptId, deadlineMs) {
  const res = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptId ? { prompt: workflow, prompt_id: promptId } : { prompt: workflow }),
    ...(signal ? { signal: guard(signal, deadlineMs || 30000) } : {}),
  });
  if (!res.ok) throw new Error(`i2i queue failed ${res.status}: ${await res.text()}`);
  const d = await res.json();
  if (d.error) throw new Error(`ComfyUI rejected i2i workflow: ${d.error.message || JSON.stringify(d.error)}`);
  return d.prompt_id || promptId;
}

// Poll history until the prompt completes or fails. Reads ComfyUI's own error status so a failed
// job (bad node, OOM) throws immediately instead of polling to the timeout — same lesson as the
// mesh poller. No global /interrupt here: i2i is single-shot and the instance may be shared, so we
// never blind-cancel a foreign job.
// v1.10 V2: intervalMs (default 3000) and signal (an AbortSignal: a stop ends the wait at once with an error flagged .aborted) are optional; every other caller is unchanged.
async function poll(base, promptId, { timeoutMs = 600000, onTick, intervalMs = 3000, signal, requestMs = 15000 } = {}) {
  const stopped = () => Object.assign(new Error('Stopped'), { aborted: true });
  const deadline = Date.now() + timeoutMs;
  const t0 = Date.now();
  let consecFails = 0;
  const MAX_CONSEC_FAILS = 5;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw stopped();
    await new Promise(r => { const t = setTimeout(r, intervalMs); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    if (signal && signal.aborted) throw stopped();
    try {
      const res = await fetch(`${base}/history/${promptId}`, signal ? { signal: guard(signal, requestMs) } : undefined);
      // A non-ok status (500 from a crashed worker behind a proxy) is a FAILURE, not a "keep
      // waiting" — count it toward the strike limit instead of polling silently to the timeout.
      if (!res.ok) throw new Error(`history HTTP ${res.status}`);
      const hist = await res.json();
      consecFails = 0;   // reset only after a genuinely parseable OK response (a 200 with a broken body counts as a strike)
      const entry = hist[promptId];
      if (onTick) { try { onTick(Math.round((Date.now() - t0) / 1000)); } catch (_) {} }
      if (!entry) continue;
      const st = entry.status || {};
      if (st.status_str === 'error' ||
          (Array.isArray(st.messages) && st.messages.some(m => Array.isArray(m) && m[0] === 'execution_error'))) {
        const em = (Array.isArray(st.messages) ? st.messages : []).find(m => Array.isArray(m) && m[0] === 'execution_error');
        const d  = (em && em[1]) || {};
        const detail = d.exception_message || d.exception_type || st.status_str || 'unknown error';
        const where  = d.node_type ? ` in node ${d.node_type}${d.node_id != null ? ` (#${d.node_id})` : ''}` : '';
        const oom = /out of memory|cuda error|cudamalloc/i.test(String(detail));
        const err = new Error(`i2i job failed${where}: ${String(detail).trim()}` +
          (oom ? '\n  → CUDA out of memory: the edit engine (Qwen, ~10 GB) could not fit. Free the other ComfyUI instance and retry.' : ''));
        err.oom = oom;
        throw err;
      }
      const done = (st.completed) || (entry.outputs && Object.keys(entry.outputs).length > 0);
      if (done) return entry.outputs || {};
    } catch (e) {
      if (signal && signal.aborted) throw stopped();   // a Stop that landed inside the request (not a blip, not a strike)
      if (e && e.message && e.message.startsWith('i2i job failed')) throw e; // real failure, not a blip
      consecFails++;
      if (consecFails >= MAX_CONSEC_FAILS) {
        throw new Error(`ComfyUI became unreachable or kept erroring during the i2i edit (${consecFails} failed status checks) at ${base} — is that ComfyUI instance running?`);
      }
    }
  }
  throw new Error(`i2i edit timed out after ${Math.round(timeoutMs / 60000)} min at ${base}. Qwen-Image-Edit needs ~3–4 min on a 10 GB card; if it never returns, that instance may be swapping against another VRAM holder.`);
}

// v1.10 V2 r2: with { signal, stallMs } the download ends on a Stop (error flagged .aborted) or when no byte arrived for stallMs (default 30 s; error flagged .stalled), also mid-body.
async function download(base, filename, subfolder = '', type = 'output', opts) {
  const url = `${base}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  const signal = opts && opts.signal;
  if (!signal) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`i2i download failed ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const stallMs = (opts && opts.stallMs) || 30000;
  const ctl = new AbortController();
  let timer = null, stalled = false;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ctl.abort(); }, stallMs); };
  const sig = AbortSignal.any([signal, ctl.signal]);
  try {
    arm();
    const res = await fetch(url, { signal: sig });
    if (!res.ok) throw new Error(`i2i download failed ${res.status}`);
    const chunks = [];
    if (res.body && typeof res.body.getReader === 'function') {
      const rd = res.body.getReader();
      for (;;) { const r = await rd.read(); if (r.done) break; chunks.push(Buffer.from(r.value)); arm(); }
    } else chunks.push(Buffer.from(await res.arrayBuffer()));
    return Buffer.concat(chunks);
  } catch (e) {
    if (signal.aborted) throw Object.assign(new Error('Stopped'), { aborted: true });
    if (stalled) throw Object.assign(new Error(`i2i download stalled: no data from ${base} for ${Math.round(stallMs / 1000)} s`), { stalled: true, stallMs });
    throw e;
  } finally { clearTimeout(timer); }
}

// ── entry resolution ─────────────────────────────────────────────────────────
// Pick the i2i workflow: an explicit id (must be stage i2i) or the active i2i workflow.
function resolveEntry(config, workflowId) {
  if (workflowId) {
    const reg = wfLib.loadRegistry();
    const e = reg.workflows && reg.workflows[workflowId];
    if (!e) throw new Error(`No workflow "${workflowId}".`);
    if (e.stage !== 'i2i') throw new Error(`Workflow "${workflowId}" is not an i2i workflow (stage=${e.stage}).`);
    return { id: workflowId, ...e };
  }
  return wfLib.getActive('i2i', config);
}

/**
 * runI2I(config, opts) → { outPath, filename, workflowId, instance, seconds }
 *
 * opts:
 *   inputImagePath  (required)  absolute path to the reference image on this machine
 *   prompt          (required for edit)  the edit instruction / the thing to isolate
 *   workflowId      (optional)  i2i workflow id; defaults to the active i2i workflow
 *   cfg             (optional)  guidance scale; only injected if the node-map has a cfg slot
 *   seed            (optional)  defaults to a fresh random seed (so refine → new variant)
 *   outDir          (optional)  where to save the result png (default: staging/i2i)
 *   timeoutMs, onTick (optional)
 */
async function runI2I(config, opts = {}) {
  const { inputImagePath, prompt, workflowId, cfg, seed, outDir, timeoutMs, onTick } = opts;
  if (!inputImagePath) throw new Error('runI2I: inputImagePath is required.');
  if (!fs.existsSync(inputImagePath)) throw new Error(`runI2I: input image not found: ${inputImagePath}`);

  const entry = resolveEntry(config, workflowId);
  const n     = entry.nodes || {};
  const base  = baseForInstance(config, entry.instance);
  const wf    = JSON.parse(fs.readFileSync(wfLib.resolveWorkflowFile(entry), 'utf8'));

  // Inject into the workflow via the node-map. cfg/seed are optional slots (a segmenter has neither).
  const set = (slot, value) => {
    if (value === undefined || value === null) return;
    if (n[slot] == null) return;
    const r = wfLib.resolveSlot('i2i', slot, n[slot]);
    if (!wf[r.node]) throw new Error(`i2i workflow has no node ${r.node} for slot ${slot}`);
    if (!wf[r.node].inputs) wf[r.node].inputs = {};
    wf[r.node].inputs[r.field] = value;
  };

  // VRAM orchestration: several ComfyUI instances on ONE GPU share its memory, so a model still
  // resident on another instance OOMs this run (measured 2026-08-06: Qwen on 'bild' killed a SAM3
  // run on 'trellis'). Free every OTHER configured instance first, via ComfyUI's own /free — portable
  // (no supervisor/SSH) and a plain no-op for single-instance users (nothing else to free).
  for (const other of allComfyBases(config)) {
    if (normBase(other) !== normBase(base)) {
      const ok = await freeInstance(other);
      if (onTick && ok) { try { onTick(0); } catch (_) {} }
    }
  }

  const uploadedName = await uploadOrExplain(config, base, inputImagePath);
  // a seed the caller passes wins; otherwise a seed locked in the workflow window (Advanced), else a fresh random one
  const lockedSeed = (n.seed != null) ? wfp.lockedSeed(entry.id) : null;
  const usedSeed = (seed != null && Number.isFinite(Number(seed))) ? Number(seed) : (lockedSeed != null ? lockedSeed : Math.floor(Math.random() * 2147483647));

  set('input_image', uploadedName);
  if (prompt != null) set('prompt', String(prompt));
  // v1.10 ADV: the entry's declared params (cfg, steps, sampler ...) come from the store; a per-call cfg is a one-off that wins for this call only
  // (never stored) and is clamped to the declaration's range. Entries without a cfg param (SAM3) get nothing.
  const adv = wfp.run(entry.id, null, (cfg != null && Number.isFinite(Number(cfg))) ? { cfg: Number(cfg) } : null);
  wfp.applyToGraph(entry, wf, adv.values);
  if (n.seed != null) set('seed', usedSeed);

  // Give the SaveImage node a unique prefix so concurrent/rapid edits never collide on one filename.
  const outSlot = wfLib.resolveSlot('i2i', 'output', n.output);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const uniquePrefix = `phoenix_i2i_${entry.id}_${stamp}_${usedSeed}`;
  if (wf[outSlot.node] && wf[outSlot.node].inputs && 'filename_prefix' in wf[outSlot.node].inputs) {
    wf[outSlot.node].inputs.filename_prefix = uniquePrefix;
  }

  const t0 = Date.now();
  const promptId = await queue(base, wf);
  const outputs  = await poll(base, promptId, { timeoutMs: timeoutMs || 600000, onTick });

  const saveNode = outputs[outSlot.node];
  if (!saveNode || !saveNode.images || !saveNode.images.length) {
    throw new Error(`i2i produced no image in output node ${outSlot.node}. The engine ran but returned nothing — check the ComfyUI log on ${base}.`);
  }
  const img = saveNode.images[0];
  const imgData = await download(base, img.filename, img.subfolder, img.type);

  const destDir = outDir || path.join(__dirname, 'staging', 'i2i');
  fs.mkdirSync(destDir, { recursive: true });
  const outPath = path.join(destDir, `${uniquePrefix}.png`);
  fs.writeFileSync(outPath, imgData);
  try { records.appendRecord({ kind: 'i2i', path: outPath, workflow: entry.id, prompt: prompt != null ? String(prompt) : null, seed: usedSeed, parent: inputImagePath, category: null }); } catch (_) {}

  return {
    outPath,
    filename: path.basename(outPath),
    workflowId: entry.id,
    instance: entry.instance || 'trellis',
    seed: usedSeed,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

// ── reference-image generation (v1.10 I1) ─────────────────────────────────────
// Flux Klein: up to 2 reference images conditioned via ReferenceLatent (official Klein image-edit template).
// Z-Image Turbo: 1 reference as img2img (denoise slider). Driven by the `reference` block of the ACTIVE IMAGE
// workflow entry (workflows.js) — no new workflow stage. The prompt is sent literally (no metaprompter).
function resolveImageEntry(config, workflowId) {
  if (workflowId) {
    const reg = wfLib.loadRegistry();
    const e = reg.workflows && reg.workflows[workflowId];
    if (!e) throw new Error(`No workflow "${workflowId}".`);
    if (e.stage !== 'image') throw new Error(`Workflow "${workflowId}" is not an image workflow (stage=${e.stage}).`);
    return { id: workflowId, ...e };
  }
  return wfLib.getActive('image', config);
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function runReference(config, opts = {}) {
  const { refs, prompt, width, height, denoise, seed, workflowId, category, outDir, timeoutMs, onTick, signal, intervalMs } = opts;   // M4: signal = the keyframe run's AbortSignal (every request gets a deadline); intervalMs = poll seam
  const entry = resolveImageEntry(config, workflowId);
  const label = entry.label || entry.id;
  const R = entry.reference;
  if (!R) throw new Error(`"${label}" has no reference mode — use Flux Klein (up to 2 references) or Z-Image Turbo (1 reference).`);

  if (category != null && (typeof category !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(category))) throw new Error('category must be 1-40 letters, digits, "_" or "-"');
  const list = Array.isArray(refs) ? refs : [];
  if (list.length < 1) throw new Error('at least one reference image is needed');
  if (list.length > R.maxRefs) throw new Error(`${label} takes at most ${R.maxRefs} reference image(s)`);
  for (const r of list) {
    if (typeof r !== 'string' || !r || !fs.existsSync(r)) throw new Error(`reference image not found: ${typeof r === 'string' ? path.basename(r) : String(r)}`);
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('a prompt is needed');

  const flux = R.mode !== 'img2img';
  // LC2h: the reference templates keep their own defaults (Flux ref: cfg 5 / euler); only what the user SET in Advanced (workflow value or
  // category override, never a 'default' source) is applied on top, so an untouched workflow runs the template exactly as before.
  const wrun = wfp.run(entry.id, category || null, null);
  const userSet = (key) => wrun.values[key] !== undefined && wrun.sources[key] !== 'default';
  let w = null, h = null, usedDenoise = null;
  if (flux) {
    const okSize = (v) => Number.isInteger(v) && v % 16 === 0 && v >= 512 && v <= 2048;
    const ss = userSet('size') ? wrun.values.size : null;   // a stored size the reference path cannot use falls back to sizeDefault (never throws)
    const useSs = !!ss && okSize(ss.w) && okSize(ss.h);
    w = width == null ? (useSs ? ss.w : R.sizeDefault[0]) : width;
    h = height == null ? (useSs ? ss.h : R.sizeDefault[1]) : height;
    if (!okSize(w) || !okSize(h)) throw new Error('width and height must be multiples of 16 between 512 and 2048');
  } else {
    // the workflow's denoise (Advanced, same store; its default is read from the img2img JSON) unless the call passes one
    const rs = wfp.resolve(entry.id, category || null).denoise;
    usedDenoise = denoise == null ? (rs ? rs.value : R.denoiseDefault) : denoise;
    if (typeof usedDenoise !== 'number' || !Number.isFinite(usedDenoise) || usedDenoise < 0.05 || usedDenoise > 1.0) throw new Error('denoise must be between 0.05 and 1.0');
  }

  const n    = R.nodes || {};
  const base = baseForInstance(config, entry.instance);
  const file = path.resolve(__dirname, R.files[list.length]);
  const wf   = JSON.parse(fs.readFileSync(file, 'utf8'));
  const setIn = (node, field, value) => {
    if (!wf[node]) throw new Error(`reference workflow has no node ${node}`);
    if (!wf[node].inputs) wf[node].inputs = {};
    wf[node].inputs[field] = value;
  };
  const slot = (v, defField) => (v && typeof v === 'object') ? { node: String(v.node), field: v.field || defField } : { node: String(v), field: defField };

  // Same VRAM rule as runI2I: free every OTHER configured ComfyUI instance first.
  for (const other of allComfyBases(config)) {
    if (normBase(other) !== normBase(base)) {
      const ok = await freeInstance(other);
      if (onTick && ok) { try { onTick(0); } catch (_) {} }
    }
  }

  for (let i = 0; i < list.length; i++) {
    // unique upload name per reference: uploads overwrite by name, so two refs called image.png would both become the second file
    const upName = `phx_ref_${stampNow()}_${i}_${crypto.randomBytes(3).toString('hex')}${path.extname(list[i]).toLowerCase() || '.png'}`;
    const uploaded = i === 0 ? await uploadOrExplain(config, base, list[i], upName, signal) : await uploadImage(base, list[i], upName, signal);   // only the first contact can be "ComfyUI is gone"
    setIn(n.ref_images[i], 'image', uploaded);
  }
  // explicit seed wins, then a seed locked in the workflow window (Advanced), else a fresh random one (same precedence as runI2I)
  const lockedSeed = wfp.lockedSeed(entry.id);
  const usedSeed = (seed != null && Number.isFinite(Number(seed))) ? Number(seed) : (lockedSeed != null ? lockedSeed : Math.floor(Math.random() * 2147483647));
  const setVals = {};
  for (const k of Object.keys(wrun.values)) if (userSet(k) && k !== 'size' && k !== 'denoise') setVals[k] = wrun.values[k];
  wfp.applyToGraph(entry, wf, setVals);
  const sSeed = slot(n.seed, 'noise_seed');
  setIn(sSeed.node, sSeed.field, usedSeed);
  const sPos = slot(n.positive, 'text');
  setIn(sPos.node, sPos.field, prompt);
  if (flux) {
    for (const node of n.size) { setIn(node, 'width', w); setIn(node, 'height', h); }
  } else {
    const sDen = slot(n.denoise, 'denoise');
    setIn(sDen.node, sDen.field, usedDenoise);
  }

  const uniquePrefix = `phoenix_ref_${entry.id}_${stampNow()}_${usedSeed}_${crypto.randomBytes(2).toString('hex')}`;   // random tail: same workflow + seed within one second must not collide
  const outNode = String(n.output);
  if (wf[outNode] && wf[outNode].inputs && 'filename_prefix' in wf[outNode].inputs) wf[outNode].inputs.filename_prefix = uniquePrefix;

  const t0 = Date.now();
  // M4: with a signal the prompt id is ours (ComfyUI keeps a client-supplied id), so a Stop / timeout can cancel it even while the submission is in flight
  let promptId = signal ? crypto.randomUUID() : undefined, outputs, imgData, saveNode;
  try {
    promptId = signal ? await queue(base, wf, signal, promptId) : await queue(base, wf);
    outputs = await poll(base, promptId, { timeoutMs: timeoutMs || 600000, onTick, ...(signal ? { signal } : {}), ...(intervalMs ? { intervalMs } : {}) });
    saveNode = outputs[outNode];
    if (!saveNode || !saveNode.images || !saveNode.images.length) {
      throw new Error(`reference generation produced no image in output node ${outNode}. The engine ran but returned nothing — check the ComfyUI log on ${base}.`);
    }
    const img = saveNode.images[0];
    imgData = signal ? await download(base, img.filename, img.subfolder, img.type, { signal }) : await download(base, img.filename, img.subfolder, img.type);
  } catch (e) {
    if (signal) {
      await cancelQueued(base, promptId);   // best effort, never throws
      if (signal.aborted && !(e && e.aborted)) throw Object.assign(new Error('Stopped'), { aborted: true });
    }
    throw e;
  }

  const outRoot = path.resolve(__dirname, 'output');
  const destDir = outDir || path.join(outRoot, category || 'reference');
  if (!outDir && !path.resolve(destDir).startsWith(outRoot + path.sep)) throw new Error('category must stay inside output/');
  fs.mkdirSync(destDir, { recursive: true });
  const outPath = path.join(destDir, `${uniquePrefix}.png`);
  fs.writeFileSync(outPath, imgData, { flag: 'wx' });   // never overwrite an earlier result
  try { records.appendRecord({ kind: 'image', mode: 'reference', path: outPath, workflow: entry.id, prompt, seed: usedSeed, parent: list[0], refs: list, category: category || null }); } catch (_) {}

  return {
    outPath, filename: path.basename(outPath), workflowId: entry.id, seed: usedSeed,
    seconds: Math.round((Date.now() - t0) / 1000), refs: list.length,
    width: flux ? w : null, height: flux ? h : null, denoise: flux ? null : usedDenoise,
    sizeFrom: flux ? 'request' : 'reference',
  };
}

// M4: best-effort cancel of one prompt after a Stop / timeout: dequeue it by id; POST /interrupt only when /queue says OUR prompt is the one running
// (/interrupt has no id - it would stop a foreign job). 3 s timeouts, never throws. -> { reached, dequeued, running, interrupted }
async function cancelQueued(base, promptId) {
  const out = { reached: false, dequeued: false, running: false, interrupted: false };
  if (!base || !promptId) return out;
  const t = () => AbortSignal.timeout(3000);
  try {
    const r = await fetch(`${base}/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }), signal: t() });
    out.reached = true; out.dequeued = !!(r && r.ok);
  } catch (_) { /* unreachable: nothing else to try */ }
  try {
    const q = await fetch(`${base}/queue`, { signal: t() });
    const j = await q.json();
    out.reached = true;
    out.running = (j.queue_running || []).some((it) => Array.isArray(it) && it.includes(promptId));
    if (out.running) { await fetch(`${base}/interrupt`, { method: 'POST', signal: t() }); out.interrupted = true; }
  } catch (_) { /* best effort */ }
  return out;
}

// List the available i2i workflows (for the UI engine picker / dep checks).
function listI2I() {
  const reg = wfLib.loadRegistry();
  return Object.entries(reg.workflows || {})
    .filter(([, e]) => e.stage === 'i2i')
    .map(([id, e]) => ({ id, label: e.label || id, instance: e.instance || 'trellis', mode: e.mode || 'edit', builtin: !!e.builtin }));
}

module.exports = { runI2I, runReference, cancelQueued, listI2I, comfyGoneMessage, baseForInstance, resolveEntry, freeOtherInstances, freeInstance, uploadOrExplain, queue, poll, download, lastFreed };   // v1.10 V2: the local video backend reuses the same ComfyUI client
