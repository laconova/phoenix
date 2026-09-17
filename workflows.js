'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Shared workflow registry data + helpers ──────────────────────────────────
// Required by both phoenix.js (CLI) and assistant.js / server.js (server).
// No project-local requires — only fs and path — to avoid require cycles.

const WORKFLOWS_FILE = path.join(__dirname, 'workflows.json');

const DEFAULT_WORKFLOWS = {
  version: 1,
  workflows: {
    flux_klein: {
      label:   'Flux Klein',
      stage:   'image',
      file:    path.join(__dirname, 'workflows', 'flux2_klein_txt2img.json'),
      nodes:   { positive: '4', negative: '14', cfg: '6', steps: '8', seed: '10', output: '13' },
      deps:    {
        // trimmed 2026-09-17 (shipmitnull-workflow-manifests): EmptyFlux2LatentImage/Flux2Scheduler are
        // core ComfyUI nodes (comfy_extras/nodes_flux.py), not plugins — flux_klein needs ZERO custom
        // nodes. Leaving them declared with no install.custom_nodes match would make plan()/status()
        // report "manual" forever.
        custom_nodes: [],
        models: ['flux-2-klein-base-4b.safetensors', 'qwen_3_4b.safetensors', 'flux2-vae.safetensors'],
      },
      builtin: true,
      install: {
        license: 'Apache-2.0',   // black-forest-labs FLUX.2-klein-base-4B model card
        vram_gb: 10,             // estimated — runs on the rig's single 10GB card, no OOM documented, not live-measured
        custom_nodes: [],
        models: [
          { filename: 'flux-2-klein-base-4b.safetensors',
            source: { hf: 'Comfy-Org/vae-text-encorder-for-flux-klein-4b/split_files/diffusion_models/flux-2-klein-base-4b.safetensors' },
            dir: 'diffusion_models', size_gb: 7.3 },
          { filename: 'qwen_3_4b.safetensors',
            source: { hf: 'Comfy-Org/vae-text-encorder-for-flux-klein-4b/split_files/text_encoders/qwen_3_4b.safetensors' },
            dir: 'text_encoders', size_gb: 7.5 },
          { filename: 'flux2-vae.safetensors',
            source: { hf: 'Comfy-Org/vae-text-encorder-for-flux-klein-4b/split_files/vae/flux2-vae.safetensors' },
            dir: 'vae', size_gb: 0.32 },
        ],
      },
    },
    sd15: {
      label:   'SD1.5',
      stage:   'image',
      file:    path.join(__dirname, 'workflows', 'sd15_txt2img.json'),
      nodes:   { positive: '6', negative: '7', cfg: '3', steps: '3', seed: { node: '3', field: 'seed' }, output: '9' },
      deps:    { custom_nodes: [], models: ['v1-5-pruned-emaonly-fp16.safetensors'] },
      builtin: true,
      install: {
        license: 'CreativeML Open RAIL-M',   // SD1.5's original license terms carry over to this archive — NOT MIT/Apache
        vram_gb: 4,                          // estimated — 512x512 well below the rig's 10GB card, no OOM ever reported
        custom_nodes: [],
        models: [
          { filename: 'v1-5-pruned-emaonly-fp16.safetensors',
            source: { hf: 'Comfy-Org/stable-diffusion-v1-5-archive/v1-5-pruned-emaonly-fp16.safetensors' },
            dir: 'checkpoints', size_gb: 2.0 },
        ],
      },
    },
    trellis2: {
      label:   'Trellis2-GGUF',
      stage:   'mesh',
      file:    path.join(__dirname, 'workflows', 'trellis_phoenix.json'),
      nodes:   { image: '2', seed: '4', target_face_num: '5', output_prefix: '6', output: '6' },
      deps:    {
        custom_nodes: [
          'Trellis2LoadModel_GGUF', 'Trellis2LoadImageWithTransparency_GGUF', 'Trellis2PreProcessImage_GGUF',
          'Trellis2MeshWithVoxelGenerator_GGUF', 'Trellis2PostProcessAndUnWrapAndRasterizer_GGUF', 'Trellis2ExportMesh_GGUF',
        ],
        // trimmed 2026-09-17: the old symbolic 'TRELLIS.2-4B' matched no real file. Trellis2LoadModel_GGUF
        // self-downloads its own weights on first run (product decision — see install.models below), so
        // this stays [] — a non-empty entry here with no install.models match would fail validateInstall's
        // "dep X has no install source" check.
        models: [],
      },
      builtin: true,
      install: {
        // Plugin CODE license is MIT (LICENSE file, rig-verified). The MODEL WEIGHTS' license is stated
        // honestly rather than guessed — no fabricated SPDX id; check the model card (Aero-Ex/Trellis2-GGUF).
        license: 'MIT (plugin code) — model weights: see the model card (Aero-Ex/Trellis2-GGUF)',
        vram_gb: 10,   // estimated — low_vram:true in the workflow JSON, runs on the rig's 10GB card today
        custom_nodes: [
          { classType: 'Trellis2LoadModel_GGUF',                         git: 'https://github.com/Aero-Ex/ComfyUI-Trellis2-GGUF.git', ref: '6bd11ead7ab7976ec4b2c47db52701f4c76a54e2' },
          { classType: 'Trellis2LoadImageWithTransparency_GGUF',         git: 'https://github.com/Aero-Ex/ComfyUI-Trellis2-GGUF.git', ref: '6bd11ead7ab7976ec4b2c47db52701f4c76a54e2' },
          { classType: 'Trellis2PreProcessImage_GGUF',                   git: 'https://github.com/Aero-Ex/ComfyUI-Trellis2-GGUF.git', ref: '6bd11ead7ab7976ec4b2c47db52701f4c76a54e2' },
          { classType: 'Trellis2MeshWithVoxelGenerator_GGUF',            git: 'https://github.com/Aero-Ex/ComfyUI-Trellis2-GGUF.git', ref: '6bd11ead7ab7976ec4b2c47db52701f4c76a54e2' },
          { classType: 'Trellis2PostProcessAndUnWrapAndRasterizer_GGUF', git: 'https://github.com/Aero-Ex/ComfyUI-Trellis2-GGUF.git', ref: '6bd11ead7ab7976ec4b2c47db52701f4c76a54e2' },
          { classType: 'Trellis2ExportMesh_GGUF',                        git: 'https://github.com/Aero-Ex/ComfyUI-Trellis2-GGUF.git', ref: '6bd11ead7ab7976ec4b2c47db52701f4c76a54e2' },
        ],
        // self-download (product decision, task brief overrides the manifest's "pre-stage 11 files"
        // recommendation): Trellis2LoadModel_GGUF pulls ~6.9GB of its own weights from Aero-Ex/Trellis2-GGUF
        // + Aero-Ex/Dinov3 on first run — the current install.models[] contract has no bearing on that path.
        models: [],
      },
    },
    // ── i2i category (v1.8) ─────────────────────────────────────────────────────
    // Image-to-image editing between the image and mesh stages. Unlike image/mesh (both on
    // COMFY_BASE), an i2i entry names its `instance`: 'bild' = the ComfyUI that hosts Qwen-Image-Edit,
    // 'trellis' = the one that hosts the SAM3 / RMBG suite. The backend maps instance -> base URL via
    // config (endpoints.comfyui / optional endpoints.comfyui_bild); with a single ComfyUI both map to
    // the one endpoint. Entries without `instance` fall back to COMFY_BASE.
    qwen_edit: {
      label:    'Qwen Image Edit',
      stage:    'i2i',
      instance: 'bild',                 // the ComfyUI that hosts Qwen-Image-Edit-2509 (endpoints.comfyui_bild, or the single endpoint)
      mode:     'edit',                 // appearance/material/style edit (NOT structure removal — measured 2026-08-05)
      file:     path.join(__dirname, 'workflows', 'qwen_image_edit.json'),
      nodes:    { input_image: '4', prompt: '6', cfg: '9', seed: '9', output: '11' },
      deps:     {
        // trimmed 2026-09-17 (shipmitnull-workflow-manifests): CLIPLoader/TextEncodeQwenImageEdit/
        // ImageScaleToTotalPixels are core ComfyUI nodes, not plugins — only UnetLoaderGGUF (ComfyUI-GGUF)
        // is a real installable dep. Leaving the core names declared with no install source would make
        // plan()/status() report "manual" forever.
        custom_nodes: ['UnetLoaderGGUF'],
        models: ['Qwen-Image-Edit-2509-Q3_K_M.gguf', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'qwen_image_vae.safetensors'],
      },
      builtin: true,
      install: {
        license: 'Apache-2.0',   // Qwen-Image family license; ComfyUI-GGUF itself is also Apache-2.0
        // measured live: VL text-encoder (9.4GB) +
        // Unet (9.8GB) don't fit simultaneously on a 10GB card — ComfyUI swaps per run — but each fits
        // individually, so 10 is the correct ceiling. The one workflow in this batch with a live measurement.
        vram_gb: 10,
        custom_nodes: [
          { classType: 'UnetLoaderGGUF', git: 'https://github.com/city96/ComfyUI-GGUF', ref: '6ea2651e7df66d7585f6ffee804b20e92fb38b8a' },
        ],
        models: [
          { filename: 'Qwen-Image-Edit-2509-Q3_K_M.gguf',
            source: { hf: 'QuantStack/Qwen-Image-Edit-2509-GGUF/Qwen-Image-Edit-2509-Q3_K_M.gguf' },
            dir: 'diffusion_models', size_gb: 9.1 },
          { filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
            source: { hf: 'Comfy-Org/Qwen-Image_ComfyUI/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors' },
            dir: 'text_encoders', size_gb: 8.8 },
          { filename: 'qwen_image_vae.safetensors',
            source: { hf: 'Comfy-Org/Qwen-Image_ComfyUI/split_files/vae/qwen_image_vae.safetensors' },
            dir: 'vae', size_gb: 0.24 },
        ],
      },
    },
    sam3_isolate: {
      label:    'SAM3 Isolate',
      stage:    'i2i',
      instance: 'trellis',              // the ComfyUI that hosts the ComfyUI-RMBG suite (dev rig: :8000)
      mode:     'segment',              // text-guided isolation — the reliable "cut a part out" engine (measured 2026-08-06)
      file:     path.join(__dirname, 'workflows', 'sam3_segment.json'),
      nodes:    { input_image: '1', prompt: '2', output: '3' },   // no cfg/seed: SAM3 is deterministic
      deps:     {
        custom_nodes: ['SAM3Segment'],  // sam3.pt loads internally (no model_name input) → not a dep-checkable model name
        models: [],
      },
      builtin: true,
      install: {
        // Plugin code (ComfyUI-RMBG) is GPL-3.0 (LICENSE file, rig-verified) — new info, badge set
        // honestly. Model weights (SAM3, via the 1038lab/sam3 mirror) are Meta's own release terms,
        // redistributed ungated by the mirror but the underlying rights are Meta's, not 1038lab's.
        license: 'GPL-3.0',
        vram_gb: 4,   // estimated — sam3.pt is 3.2GB loaded, workflow sets unload_model:true after each run
        custom_nodes: [
          { classType: 'SAM3Segment', git: 'https://github.com/1038lab/ComfyUI-RMBG.git', ref: 'd7402513f23f58db7d56754b02a4f51a148b4941' },
        ],
        // sam3.pt self-downloads into the node's OWN dir (ComfyUI-RMBG/models/sam3/sam3.pt), not
        // modelsRoot — the install.models[] contract has no way to express that destination. A hard
        // architectural constraint (manifest), not a product choice like trellis2's.
        models: [],
      },
    },
    // ── voice category (v1.8.1) ─────────────────────────────────────────────────
    // Engine picker entries for the voice-service's /speak dispatch. crispasr ships WITH the product
    // (no install block, same pattern as flux_klein/trellis2 above); chatterbox/cosyvoice are the first
    // DOWNLOADABLE voice engines — their `install` block uses the voice-engine form
    // (`install.target:"voice-engine"`, validated by downloader.js validateInstall) instead of the
    // comfyui custom_nodes/models form. Both are dispatcher-gated (requiresDispatcher) — see below.
    crispasr: {
      label:   'CrispASR',
      stage:   'voice',
      builtin: true,   // integrated — ships with the product, no acquire step
    },
    chatterbox: {
      label:   'Chatterbox',
      stage:   'voice',
      builtin: true,
      // Config-capability gate: engine=<id> is understood only by the voice-service /speak dispatcher,
      // a Laconova rig-side service that is NOT shipped with the product. On a plain CrispASR speech
      // server the picker can select this but nothing routes it, so it ships greyed BY DEFAULT and is
      // enabled only where the config declares the dispatcher (voice.dispatcher truthy). See
      // engineAvailability() below. Our own rig sets that flag in its gitignored phoenix-config.json.
      requiresDispatcher: true,
      install: {
        license: 'MIT',
        vram_gb: 4,        // measured live on the rig 2026-09-16 (manifest estimate was 3) — see dev-note
        target:  'voice-engine',
        engine: {
          id:   'chatterbox',
          kind: 'pip',
          // NO engine.root here (release-blocker fix, 2026-09-17): the real install root is
          // voiceInstall.<instance>.root from the CUSTOMER's phoenix-config.json (downloader.js
          // resolveVoiceTarget) — same rule as comfyInstall. DEFAULT_WORKFLOWS must never hardcode an
          // absolute per-user path; our own rig's path lives ONLY in our gitignored phoenix-config.json.
          venv: { path: 'venv', python: '3.12', torch: '2.6.0', index_url: null, pins: [] },
          pip:  'chatterbox-tts==0.1.7',
          weights: {
            source:  { hf: 'ResembleAI/chatterbox' },
            // Relative — joined onto the resolved engineRoot by resolveVoiceTarget. Cosmetic/inert while
            // lazy:true (chatterbox-tts manages its own real HF cache internally; acquire() never fetches
            // a lazy weights step — see downloader.js's weights.lazy handling), but still a required,
            // non-absolute, non-leaking field for validateInstall.
            dir:     'hf-cache',
            size_gb: 3.0,
            lazy:    true,
          },
          adapter: 'chatterbox_adapter.py',   // the live adapter name, not the bench script it wraps
        },
      },
    },
    cosyvoice: {
      label:   'CosyVoice',
      stage:   'voice',
      builtin: true,
      // Same dispatcher gate as chatterbox — the governing PUBLIC reason it ships greyed (the /speak
      // dispatcher is not shipped). See engineAvailability() below.
      requiresDispatcher: true,
      // Secondary reason (applies once the dispatcher IS present, e.g. on our rig): engine=cosyvoice
      // fails in its own venv (venv-cosy) — a native pyworld build wall after the requirements surgery
      // below, which is not a strip/pin fix. `blocked` is UI-only (the picker renders a disabled
      // <option>); it does NOT gate acquire/dep-check, which stay honest to the manifest.
      blocked:       'venv',
      blockedReason: 'voice engine not installed',
      install: {
        license: 'Apache-2.0',
        vram_gb: 4,   // estimated (unmeasured — engine has never completed a run, per dev-note)
        target:  'voice-engine',
        engine: {
          id:   'cosyvoice',
          kind: 'git+requirements',
          // NO engine.root here — same rule as chatterbox above (root resolves from the customer's
          // voiceInstall.<instance>.root, never hardcoded in the shipped manifest).
          venv: { path: 'venv-cosy', python: '3.12', torch: '2.6.0', index_url: null, pins: ['setuptools<81'] },
          repo: { url: 'https://github.com/FunAudioLLM/CosyVoice.git', commit: 'main', submodules: ['third_party/Matcha-TTS'] },
          requirements: {
            file:  'requirements.txt',
            // strip + pre/post amended per the 2026-09-16 live recipe (dev-note): onnxruntime-gpu's
            // fragile Azure extra-index-url never resolved — strip it and install plain CPU onnxruntime
            // instead (post). The pyworld native-build wall (still open) is NOT encodable here — it isn't
            // a strip/pin fix, which is exactly why this engine stays `blocked` instead of claiming a
            // working recipe.
            strip: ['pynini', 'wetextprocessing', 'grpcio', 'onnxruntime-gpu'],
            pre:   ['setuptools<81', 'wheel', 'grpcio', 'grpcio-tools'],
            post:  ['modelscope', 'onnxruntime'],
          },
          weights: {
            source:  { modelscope: 'iic/CosyVoice2-0.5B' },
            // Relative — joined onto the resolved engineRoot by resolveVoiceTarget (was previously the
            // literal absolute path to OUR rig's bench install; now resolves per-customer).
            dir:     'cosyvoice/pretrained_models/CosyVoice2-0.5B',
            size_gb: 4.0,
            lazy:    true,
          },
          adapter: 'cosyvoice_adapter.py',
        },
      },
    },
  },
};

/**
 * loadRegistry() — reads workflows.json fresh on every call.
 * On any read/parse failure, writes DEFAULT_WORKFLOWS to disk (best-effort) and
 * returns a deep copy of DEFAULT_WORKFLOWS.
 */
function loadRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(WORKFLOWS_FILE, 'utf8');
  } catch (e) {
    // File genuinely absent → seed it (first run). Any OTHER read error (EBUSY/EPERM from AV or a
    // concurrent writer on Windows) is TRANSIENT — return defaults WITHOUT touching the file, so a
    // momentary read failure can never destroy the user's authored workflows. (Same rule as palette.js.)
    if (e && e.code === 'ENOENT') {
      try { fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(DEFAULT_WORKFLOWS, null, 2), 'utf8'); } catch { /* read-only FS */ }
    }
    return JSON.parse(JSON.stringify(DEFAULT_WORKFLOWS));
  }
  try {
    return mergeMissingBuiltins(JSON.parse(raw));
  } catch {
    // Parse failure (corruption / partial write) — do NOT overwrite; return defaults.
    return JSON.parse(JSON.stringify(DEFAULT_WORKFLOWS));
  }
}

// Ensure every workflow the app SHIPS as builtin is present AND up to date, without ever clobbering a
// user's own entry of the same id. WHY: workflows.json is seeded from DEFAULT_WORKFLOWS only on first
// run (ENOENT above). A user who already had the file from an earlier version would otherwise NEVER
// receive builtins added in an update — e.g. the v1.8 i2i engines (qwen_edit, sam3_isolate), which
// left the whole i2i/Edit engine picker empty and SAM3 isolation unreachable for every upgrader.
//
// 🔴 Two cases, not one (fixed 2026-09-17 — live-probe finding: `GET /workflows/acquire-plan` on the
// running rig returned every step "manual" for flux_klein/sd15/etc, because their PRE-EXISTING
// workflows.json entries never picked up the new `install` blocks / trimmed `deps` — only a WHOLLY
// ABSENT id was ever backfilled):
//   1. id absent from reg.workflows entirely → add a deep copy of the DEFAULT_WORKFLOWS entry (as before).
//   2. id present AND still `builtin === true` → REPLACE it with a fresh deep copy of the
//      DEFAULT_WORKFLOWS entry. Builtins are non-editable (updateCustomWorkflow refuses `builtin:true`
//      entries), so the shipped definition is always authoritative for a still-builtin id — this is
//      what actually delivers a shipped `install`/`deps`/`nodes`/`file` change to every upgrader, not
//      just a first-run install.
// A user's own entry (an id that shares a builtin's name but has `builtin: false` — the shape
// updateCustomWorkflow leaves behind) is NEVER touched by either case. The active workflow/engine
// PER STAGE is stored separately in phoenix-config.json (`cfg.workflows.<stage>`, read by getActive()
// via server.js's own cfg, never in the registry entry itself — see getActive() below) — so wholesale-
// replacing a builtin entry here can never lose a user's active selection.
// Merge is in-memory (loadRegistry stays side-effect-light); it persists the next time the registry is
// saved anyway.
function mergeMissingBuiltins(reg) {
  if (!reg || typeof reg !== 'object') return JSON.parse(JSON.stringify(DEFAULT_WORKFLOWS));
  if (!reg.workflows || typeof reg.workflows !== 'object') reg.workflows = {};
  for (const [id, entry] of Object.entries(DEFAULT_WORKFLOWS.workflows)) {
    const existing = reg.workflows[id];
    if (!existing || existing.builtin === true) {
      reg.workflows[id] = JSON.parse(JSON.stringify(entry));
    }
    // else: a user's own non-builtin entry of this id — leave it exactly as they made it.
  }
  return reg;
}

/**
 * saveRegistry(reg) — writes registry object to workflows.json atomically (tmp + rename), so a crash
 * mid-write can never leave a truncated file that the next loadRegistry would treat as corrupt.
 */
function saveRegistry(reg) {
  const tmp = WORKFLOWS_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, WORKFLOWS_FILE);
}

// voice (Stage 2d follow-up): mirrors image/mesh/i2i — the Library's click-to-activate persists this
// as cfg.workflows.voice (server.js POST /workflows), read back here as the fallback when unset.
const DEFAULT_ACTIVE = { image: 'flux_klein', mesh: 'trellis2', i2i: 'qwen_edit', voice: 'crispasr' };

/**
 * engineAvailability(entry, hasDispatcher) → { available: bool, reason: string|null }
 * The single source of truth for "can this (voice) engine be used / activated / acquired right now".
 * Generalizes the old bare `blocked` check into an effective "unavailable + reason", combining the
 * config-capability gate with the pre-existing per-engine block. Two gates, DISPATCHER FIRST (the
 * governing PUBLIC gate):
 *   1. requiresDispatcher && !hasDispatcher → unavailable. The engine=<id> the picker sends is
 *      understood only by the voice-service /speak dispatcher — a rig-only Laconova service NOT shipped
 *      with the product — so on a plain CrispASR server it is inert. Greyed until a future version.
 *   2. entry.blocked (e.g. cosyvoice's venv wall — applies even WITH the dispatcher) → unavailable,
 *      "voice engine not installed".
 * Non-voice entries carry neither field, so this always returns available:true for them (a no-op for
 * image/mesh/i2i — their activation path is unchanged).
 * `hasDispatcher` is a plain boolean; each caller derives it from its own config shape
 * (cfg.voice.dispatcher). English reasons only — these strings render in the shipped UI.
 */
function engineAvailability(entry, hasDispatcher) {
  if (!entry) return { available: false, reason: 'unknown engine' };
  if (entry.requiresDispatcher && !hasDispatcher) {
    return { available: false, reason: 'requires the voice-service dispatcher — coming in a future version' };
  }
  if (entry.blocked) {
    return { available: false, reason: 'voice engine not installed' };
  }
  return { available: true, reason: null };
}

/**
 * getActive(stage, cfg) — returns the active workflow entry for a given stage.
 * Attaches `id` to the returned object. Never throws on a bad/missing id —
 * always returns a usable entry by falling back to DEFAULT_ACTIVE.
 * An UNAVAILABLE entry (Stage 2d — e.g. cosyvoice's venv, or a dispatcher-gated engine on a config that
 * doesn't declare the dispatcher) never resolves as active, even if it somehow ended up as the
 * persisted id (a stale config, hand-edited outside the guarded POST /workflows path) — same "no
 * silent substitute of a broken thing" rule as everywhere else; it falls through to the safe
 * DEFAULT_ACTIVE the same way a missing/wrong-stage id already did.
 */
function getActive(stage, cfg) {
  const activeId = (cfg && cfg.workflows && cfg.workflows[stage]) || DEFAULT_ACTIVE[stage];
  const reg      = loadRegistry();
  const entry    = reg.workflows && reg.workflows[activeId];
  const hasDispatcher = !!(cfg && cfg.voice && cfg.voice.dispatcher);
  if (entry && entry.stage === stage && engineAvailability(entry, hasDispatcher).available) {
    return { id: activeId, ...entry };
  }
  // Fallback to built-in default
  const fallbackId    = DEFAULT_ACTIVE[stage];
  const fallbackEntry = (reg.workflows && reg.workflows[fallbackId]) || DEFAULT_WORKFLOWS.workflows[fallbackId];
  return { id: fallbackId, ...fallbackEntry };
}

/**
 * validateActivate(stage, id, reg, cfg) → { ok:true, entry } | { ok:false, error, field }
 * Pure validation for "set the active workflow/engine for a stage" — the business rule server.js's
 * POST /workflows enforces, factored out (mirrors downloader.js's validateInstall) so it's testable
 * without an HTTP round trip and so the route handler stays a thin parse → validate → persist wrapper.
 * image/mesh/i2i need the ComfyUI workflow FILE present + a complete node-map (unchanged, Stage 1) and
 * ignore `cfg`; voice (Stage 2d) has neither concept — it refuses any UNAVAILABLE engine via
 * engineAvailability (a `blocked` engine like cosyvoice, OR a dispatcher-gated one when cfg does not
 * declare voice.dispatcher), same "no silent substitute" rule as voice.js's own resolveEngine().
 */
function validateActivate(stage, id, reg, cfg) {
  if (stage !== 'image' && stage !== 'mesh' && stage !== 'i2i' && stage !== 'voice') {
    return { ok: false, error: 'stage must be "image", "mesh", "i2i" or "voice"', field: 'stage' };
  }
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'id must be a non-empty string', field: 'id' };
  }

  const entry = reg && reg.workflows && reg.workflows[id];
  if (!entry) return { ok: false, error: 'unknown workflow id', field: 'id' };
  if (entry.stage !== stage) return { ok: false, error: 'workflow is not for this stage', field: 'stage' };

  if (stage === 'voice') {
    const hasDispatcher = !!(cfg && cfg.voice && cfg.voice.dispatcher);
    const av = engineAvailability(entry, hasDispatcher);
    if (!av.available) {
      return { ok: false, error: 'engine not available (' + av.reason + ')', field: 'id' };
    }
    return { ok: true, entry };
  }

  try {
    resolveWorkflowFile(entry);
  } catch (_) {
    return { ok: false, error: 'workflow file not found: ' + entry.file, field: 'file' };
  }

  const REQUIRED = {
    image: ['positive', 'output'],
    mesh:  ['image', 'output'],
    i2i:   ['input_image', 'output'],
  };
  for (const key of REQUIRED[stage]) {
    if (!entry.nodes || !entry.nodes[key]) {
      return { ok: false, error: 'nodes map missing key: ' + key, field: 'nodes' };
    }
  }
  return { ok: true, entry };
}

/**
 * collectEnumValues(objectInfo) — returns a Set of all string enum option values
 * from a ComfyUI /object_info response.
 * Iterates all node class definitions and collects every string that appears as
 * a combo/enum choice (spec[0] is an array of strings).
 */
function collectEnumValues(objectInfo) {
  const vals = new Set();
  for (const cls of Object.values(objectInfo)) {
    const inp = cls && cls.input;
    if (!inp) continue;
    for (const group of [inp.required, inp.optional]) {
      if (!group) continue;
      for (const spec of Object.values(group)) {
        // combo/enum inputs look like [ [ "a.safetensors", "b.safetensors" ], {opts} ]
        if (Array.isArray(spec) && Array.isArray(spec[0])) {
          for (const v of spec[0]) if (typeof v === 'string') vals.add(v);
        }
      }
    }
  }
  return vals;
}

/**
 * checkDeps(entry, objectInfo) — pure dep-checker, no fetch.
 * Returns { missing_nodes: [...], missing_models: [...], ready: <bool> }.
 * - missing_nodes: declared custom_nodes not present as top-level keys in objectInfo.
 * - missing_models: declared models not found in the enum values set AND not a
 *   substring of the full JSON (same heuristic as the troubleshooter).
 */
function checkDeps(entry, objectInfo) {
  const enumVals      = collectEnumValues(objectInfo);
  const infoJson      = JSON.stringify(objectInfo);
  const missing_nodes  = (entry.deps && entry.deps.custom_nodes || []).filter(name => !(name in objectInfo));
  const missing_models = (entry.deps && entry.deps.models || []).filter(m => !enumVals.has(m) && !infoJson.includes(m));
  return { missing_nodes, missing_models, ready: missing_nodes.length === 0 && missing_models.length === 0 };
}

const DEFAULT_FIELDS = {
  image: { positive: 'text', negative: 'text', cfg: 'cfg', steps: 'steps', seed: 'noise_seed', output: null },
  mesh:  { image: 'image', seed: 'seed', target_face_num: 'target_face_num', output_prefix: 'filename_prefix', output: null },
  // i2i: input_image = the LoadImage node's `image` field; prompt/cfg/seed target the edit's
  // sampler/encoder. cfg+seed are optional (a segmenter like SAM3 has neither) and are only
  // injected when the node-map declares them.
  i2i:   { input_image: 'image', prompt: 'prompt', cfg: 'cfg', seed: 'seed', output: null },
};

/**
 * resolveSlot(stage, slot, slotValue) — node-map slot may be a plain node-id string
 * (→ default field for that slot) or an object { node, field } (→ explicit field).
 * Returns { node: <string>, field: <string|null> }.
 */
function resolveSlot(stage, slot, slotValue) {
  const def = (DEFAULT_FIELDS[stage] || {})[slot] ?? null;
  if (slotValue && typeof slotValue === 'object') {
    return { node: String(slotValue.node), field: (slotValue.field != null ? slotValue.field : def) };
  }
  return { node: String(slotValue), field: def };
}

// ─── Phase 1: User self-add data/validation layer ────────────────────────────

const MODEL_INPUT_FIELDS = new Set([
  'ckpt_name', 'unet_name', 'vae_name', 'clip_name', 'clip_name1', 'clip_name2', 'clip_name3',
  'lora_name', 'model_name', 'gguf_name', 'control_net_name', 'style_model_name', 'upscale_model_name',
]);

/**
 * stripNonNodeKeys(obj) → { clean, stripped }
 * Returns a new object (clean) containing only the top-level entries of obj
 * whose value is a non-null, non-array object with a string class_type.
 * stripped = array of removed top-level key names (order preserved).
 * Does not mutate obj.
 */
function stripNonNodeKeys(obj) {
  const clean = {};
  const stripped = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val !== null && !Array.isArray(val) && typeof val === 'object' && typeof val.class_type === 'string') {
      clean[key] = val;
    } else {
      stripped.push(key);
    }
  }
  return { clean, stripped };
}

/**
 * prepareWorkflowJson(jsonText) → { clean, stripped }  (throws Error on hard failure)
 * Parses jsonText, hard-errors on UI-graph format, strips non-node top-level keys,
 * then validates the cleaned node map. Returns { clean, stripped }.
 */
function prepareWorkflowJson(jsonText) {
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { throw new Error('Workflow JSON is not valid JSON.'); }
  // Detect UI-graph on the raw parsed object so the helpful message survives
  const vraw = validateWorkflowJson(parsed);
  if (vraw.format === 'ui') throw new Error(vraw.error);
  const { clean, stripped } = stripNonNodeKeys(parsed);
  const v = validateWorkflowJson(clean);
  if (!v.ok) throw new Error(v.error);
  return { clean, stripped };
}

/**
 * validateWorkflowJson(obj) → { ok, error, format }
 * Validates that obj is a ComfyUI API-format workflow JSON.
 */
function validateWorkflowJson(obj) {
  if (obj === null || Array.isArray(obj) || typeof obj !== 'object') {
    return { ok: false, error: 'Not a JSON object.', format: 'invalid' };
  }
  if (Array.isArray(obj.nodes) && ('links' in obj || 'last_node_id' in obj)) {
    return {
      ok: false,
      error: 'This looks like a ComfyUI UI/graph export. In ComfyUI enable dev mode (Settings) and use "Save (API Format)", then upload that file.',
      format: 'ui',
    };
  }
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || Array.isArray(val) || typeof val !== 'object' || typeof val.class_type !== 'string') {
      return {
        ok: false,
        error: 'Top-level key "' + key + '" is not a node object — every entry must be a ComfyUI node with a class_type (remove non-node keys like "_comment").',
        format: 'invalid',
      };
    }
  }
  if (Object.keys(obj).length === 0) {
    return { ok: false, error: 'Workflow is empty.', format: 'invalid' };
  }
  return { ok: true, error: null, format: 'api' };
}

/**
 * collectNodeChoices(obj) → [ { id, class_type, title } ]
 * One entry per top-level node in a validated API-format workflow.
 */
function collectNodeChoices(obj) {
  return Object.keys(obj).map(id => ({
    id,
    class_type: obj[id].class_type || '',
    title: (obj[id]._meta && obj[id]._meta.title) || '',
  }));
}

/**
 * collectModelCandidates(obj) → [string]
 * Unique list of string values found in any node's inputs whose field name
 * is in MODEL_INPUT_FIELDS. De-duplicated, first-seen order.
 */
function collectModelCandidates(obj) {
  const seen   = new Set();
  const result = [];
  for (const node of Object.values(obj)) {
    const inputs = node && node.inputs;
    if (!inputs) continue;
    for (const [field, value] of Object.entries(inputs)) {
      if (MODEL_INPUT_FIELDS.has(field) && typeof value === 'string') {
        if (!seen.has(value)) {
          seen.add(value);
          result.push(value);
        }
      }
    }
  }
  return result;
}

/**
 * listClassTypes(obj) → [string]
 * Unique list of every node's class_type, first-seen order.
 */
function listClassTypes(obj) {
  const seen   = new Set();
  const result = [];
  for (const node of Object.values(obj)) {
    const ct = node && node.class_type;
    if (typeof ct === 'string' && !seen.has(ct)) {
      seen.add(ct);
      result.push(ct);
    }
  }
  return result;
}

/**
 * validateNodeMap(stage, nodes, obj) → { ok, error }
 * Verifies all required slots are present and point to real node IDs in obj.
 */
function validateNodeMap(stage, nodes, obj) {
  const REQUIRED = {
    image: ['positive', 'output'],
    mesh:  ['image', 'output'],
    i2i:   ['input_image', 'output'],
  };
  if (!(stage in REQUIRED)) {
    return { ok: false, error: 'Unknown stage: ' + stage };
  }
  for (const slot of REQUIRED[stage]) {
    const val = nodes[slot];
    if (val === undefined || val === null) {
      return { ok: false, error: 'Missing required slot: ' + slot };
    }
    if (typeof val === 'string' && val.trim() === '') {
      return { ok: false, error: 'Missing required slot: ' + slot };
    }
    if (typeof val === 'object' && (!val.node || String(val.node).trim() === '')) {
      return { ok: false, error: 'Missing required slot: ' + slot };
    }
  }
  for (const [slot, val] of Object.entries(nodes)) {
    if (val === undefined || val === null) continue;
    let nodeId;
    if (typeof val === 'string') {
      nodeId = val;
    } else if (typeof val === 'object') {
      nodeId = String(val.node);
    } else {
      continue;
    }
    nodeId = String(nodeId);
    if (!(nodeId in obj)) {
      return { ok: false, error: 'Slot "' + slot + '" maps to node "' + nodeId + '" which is not in the workflow JSON.' };
    }
  }
  return { ok: true, error: null };
}

/**
 * missingModelsForWorkflow(workflowObj, objectInfo) → [string]
 * Returns a de-duplicated array (first-seen order) of model filenames that are
 * referenced by the workflow JSON but not present in the ComfyUI /object_info response.
 * A model is considered missing iff it is NOT in collectEnumValues(objectInfo) — exact
 * enum membership only. No substring fallback: ComfyUI's own validation is exact enum
 * membership (value_not_in_list), so substring matching would produce false negatives
 * (e.g. ae.safetensors is a substring of flux2-vae.safetensors but is a distinct model).
 * checkDeps retains its original two-part guard unchanged for backwards compatibility.
 */
function missingModelsForWorkflow(workflowObj, objectInfo) {
  const candidates = collectModelCandidates(workflowObj);
  const enumVals   = collectEnumValues(objectInfo);
  const seen       = new Set();
  const missing    = [];
  for (const m of candidates) {
    if (!seen.has(m) && !enumVals.has(m)) {
      seen.add(m);
      missing.push(m);
    }
  }
  return missing;
}

/**
 * addCustomWorkflow(entry, jsonText) → the saved registry entry (with id)
 * Validates, writes the JSON file, updates the registry.
 */
function addCustomWorkflow(entry, jsonText) {
  const { id, label, stage, nodes, deps } = entry;
  if (!/^[a-z0-9_]+$/.test(id)) {
    throw new Error('Invalid id (use lowercase a-z, 0-9, _).');
  }
  if (stage !== 'image' && stage !== 'mesh' && stage !== 'i2i') {
    throw new Error('stage must be "image", "mesh" or "i2i".');
  }
  const { clean } = prepareWorkflowJson(jsonText);
  const vn = validateNodeMap(stage, nodes, clean);
  if (!vn.ok) throw new Error(vn.error);
  const reg = loadRegistry();
  if (reg.workflows[id]) {
    throw new Error('A workflow with id "' + id + '" already exists. Pick another id (e.g. "' + id + '_2").');
  }
  const customDir = path.join(__dirname, 'workflows', 'custom');
  fs.mkdirSync(customDir, { recursive: true });
  const filePath = path.join(customDir, id + '.json');
  fs.writeFileSync(filePath, JSON.stringify(clean, null, 2));
  const newEntry = {
    label: label || id,
    stage,
    file: filePath,
    nodes,
    // #8 — type-filter to arrays of strings (mirrors updateCustomWorkflow). A hand-crafted entry whose
    // deps.custom_nodes/models is a non-array (or holds non-strings) must not be stored as-is: GET
    // /workflows/deps later does `entry.deps.custom_nodes.filter(...)` and a non-array there 500s the
    // whole Library view. Coerce here so a malformed deps can never poison the registry.
    deps: {
      custom_nodes: (deps && Array.isArray(deps.custom_nodes)) ? deps.custom_nodes.filter(x => typeof x === 'string') : [],
      models:       (deps && Array.isArray(deps.models))       ? deps.models.filter(x => typeof x === 'string')       : [],
    },
    builtin: false,
  };
  reg.workflows[id] = newEntry;
  saveRegistry(reg);
  return { id, ...newEntry };
}

/**
 * deleteCustomWorkflow(id) → { id }
 * Removes a custom (non-builtin) workflow from the registry and deletes its file.
 */
function deleteCustomWorkflow(id) {
  const reg = loadRegistry();
  if (!reg.workflows[id]) {
    throw new Error('No workflow with id "' + id + '".');
  }
  if (reg.workflows[id].builtin === true) {
    throw new Error('Cannot delete a Verified (builtin) workflow.');
  }
  delete reg.workflows[id];
  saveRegistry(reg);
  const filePath = path.join(__dirname, 'workflows', 'custom', id + '.json');
  try { fs.unlinkSync(filePath); } catch { /* ignore if missing */ }
  return { id };
}

/**
 * resolveWorkflowFile(entry) → absolute path that exists on THIS machine
 *
 * entry.file is an absolute path recorded when the workflow was registered, and it is only valid
 * on the machine and in the location it was registered from: move the tree, restore a backup, or
 * share a registry, and the read fails. Fall back to this install's own workflows/ directory —
 * the same portability rule the brush library applies to _LIB_DIR.
 */
function resolveWorkflowFile(entry) {
  const p = entry && entry.file;
  if (!p) throw new Error('workflow entry has no file');
  if (fs.existsSync(p)) return p;
  const local = path.join(__dirname, 'workflows', path.basename(p));
  if (fs.existsSync(local)) return local;
  throw new Error('workflow file not found: ' + p);
}

/**
 * updateCustomWorkflow(id, fields) → updated entry
 * fields = { label, nodes, deps } — any may be omitted.
 * Throws an Error with a clear message on any failure.
 */
function updateCustomWorkflow(id, fields) {
  const reg = loadRegistry();
  const entry = reg.workflows[id];
  if (!entry) throw new Error('No workflow with id "' + id + '".');
  if (entry.builtin === true) throw new Error('Cannot edit a Verified (builtin) workflow.');
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(resolveWorkflowFile(entry), 'utf8'));
  } catch {
    throw new Error('Saved workflow file is missing or invalid.');
  }
  const nodes = fields.nodes || entry.nodes;
  const vm = validateNodeMap(entry.stage, nodes, obj);
  if (!vm.ok) throw new Error(vm.error);
  entry.label = (typeof fields.label === 'string' && fields.label.trim()) ? fields.label.trim() : entry.label;
  entry.nodes = nodes;
  entry.deps = {
    custom_nodes: (fields.deps && Array.isArray(fields.deps.custom_nodes)) ? fields.deps.custom_nodes.filter(x => typeof x === 'string') : (entry.deps && entry.deps.custom_nodes) || [],
    models:       (fields.deps && Array.isArray(fields.deps.models))       ? fields.deps.models.filter(x => typeof x === 'string')       : (entry.deps && entry.deps.models)       || [],
  };
  entry.builtin = false;
  reg.workflows[id] = entry;
  saveRegistry(reg);
  return { id, ...entry };
}

module.exports = {
  DEFAULT_WORKFLOWS, WORKFLOWS_FILE, DEFAULT_ACTIVE, DEFAULT_FIELDS,
  loadRegistry, saveRegistry, mergeMissingBuiltins, getActive, validateActivate, engineAvailability, resolveSlot, collectEnumValues, checkDeps,
  MODEL_INPUT_FIELDS, validateWorkflowJson, stripNonNodeKeys, prepareWorkflowJson,
  collectNodeChoices, collectModelCandidates, missingModelsForWorkflow,
  listClassTypes, validateNodeMap, addCustomWorkflow, deleteCustomWorkflow, updateCustomWorkflow,
  resolveWorkflowFile,
};
