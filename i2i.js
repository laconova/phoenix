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
// PORTABLE (no supervisor, no SSH), so it works on a single machine as well as the dev rig. Never
// throws: a free that fails (instance down / unreachable) must not block the run.
async function freeInstance(base) {
  try {
    await fetch(`${base}/free`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(8000),
    });
    return true;
  } catch { return false; }
}

// ── minimal comfy helpers, parametrised by base ──────────────────────────────
async function uploadImage(base, imagePath) {
  const data = fs.readFileSync(imagePath);
  const name = path.basename(imagePath);
  const form = new FormData();
  form.append('image', new Blob([data], { type: 'image/png' }), name);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res = await fetch(`${base}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`i2i upload failed ${res.status}: ${await res.text()}`);
  return (await res.json()).name;
}

async function queue(base, workflow) {
  const res = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!res.ok) throw new Error(`i2i queue failed ${res.status}: ${await res.text()}`);
  const d = await res.json();
  if (d.error) throw new Error(`ComfyUI rejected i2i workflow: ${d.error.message || JSON.stringify(d.error)}`);
  return d.prompt_id;
}

// Poll history until the prompt completes or fails. Reads ComfyUI's own error status so a failed
// job (bad node, OOM) throws immediately instead of polling to the timeout — same lesson as the
// mesh poller. No global /interrupt here: i2i is single-shot and the instance may be shared, so we
// never blind-cancel a foreign job.
async function poll(base, promptId, { timeoutMs = 600000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  const t0 = Date.now();
  let consecFails = 0;
  const MAX_CONSEC_FAILS = 5;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`${base}/history/${promptId}`);
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
      if (e && e.message && e.message.startsWith('i2i job failed')) throw e; // real failure, not a blip
      consecFails++;
      if (consecFails >= MAX_CONSEC_FAILS) {
        throw new Error(`ComfyUI became unreachable or kept erroring during the i2i edit (${consecFails} failed status checks) at ${base} — is that ComfyUI instance running?`);
      }
    }
  }
  throw new Error(`i2i edit timed out after ${Math.round(timeoutMs / 60000)} min at ${base}. Qwen-Image-Edit needs ~3–4 min on a 10 GB card; if it never returns, that instance may be swapping against another VRAM holder.`);
}

async function download(base, filename, subfolder = '', type = 'output') {
  const url = `${base}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`i2i download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

  const uploadedName = await uploadImage(base, inputImagePath);
  const usedSeed = (seed != null && Number.isFinite(Number(seed))) ? Number(seed) : Math.floor(Math.random() * 2147483647);

  set('input_image', uploadedName);
  if (prompt != null) set('prompt', String(prompt));
  if (cfg != null && n.cfg != null) set('cfg', Number(cfg));
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

  return {
    outPath,
    filename: path.basename(outPath),
    workflowId: entry.id,
    instance: entry.instance || 'trellis',
    seed: usedSeed,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

// List the available i2i workflows (for the UI engine picker / dep checks).
function listI2I() {
  const reg = wfLib.loadRegistry();
  return Object.entries(reg.workflows || {})
    .filter(([, e]) => e.stage === 'i2i')
    .map(([id, e]) => ({ id, label: e.label || id, instance: e.instance || 'trellis', mode: e.mode || 'edit', builtin: !!e.builtin }));
}

module.exports = { runI2I, listI2I, baseForInstance, resolveEntry, freeOtherInstances };
