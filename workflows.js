'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Shared workflow registry data + helpers ──────────────────────────────────
// Required by both phoenix.js (CLI) and assistant.js / server.js (server).
// No project-local requires — only fs and path — to avoid require cycles.

// LC2f: PHOENIX_WORKFLOWS_FILE = a test seam (a suite points the registry at a temp file; loadRegistry() SEEDS this file when it is absent)
const WORKFLOWS_FILE = process.env.PHOENIX_WORKFLOWS_FILE || path.join(__dirname, 'workflows.json');

// v1.10 ADV: per-workflow tunable parameters. A declaration is { key, label, type: 'int'|'float'|'enum'|'size', min, max, step,
// options?, targets: [{ node, field }, ...] }. The DEFAULT of a param is never typed here - workflow-params.js reads it from the
// workflow JSON at the first target. 'size' targets list the width and the height field of every node that carries the resolution.
const sizeTargets = (...nodes) => nodes.flatMap(n => [{ node: n, field: 'width' }, { node: n, field: 'height' }]);
const DEFAULT_WORKFLOWS = {
  version: 1,
  workflows: {
    flux_klein: {
      label:   'Flux Klein',
      stage:   'image',
      file:    path.join(__dirname, 'workflows', 'flux2_klein_txt2img.json'),
      nodes:   { positive: '4', negative: '14', cfg: '6', steps: '8', seed: '10', output: '13' },
      params:  [
        { key: 'cfg',     label: 'CFG',     type: 'float', min: 0, max: 20,  step: 0.1, targets: [{ node: '6', field: 'cfg' }] },
        { key: 'steps',   label: 'Steps',   type: 'int',   min: 1, max: 100, step: 1,   targets: [{ node: '8', field: 'steps' }] },
        { key: 'sampler', label: 'Sampler', type: 'enum',  targets: [{ node: '9', field: 'sampler_name' }] },
        { key: 'size',    label: 'Size',    type: 'size',  min: 256, max: 2048, step: 16, targets: sizeTargets('7', '8') },
      ],
      // v1.10 I1: reference-image mode (official Flux.2 Klein image-edit template: ReferenceLatent on positive AND negative,
      // a 2nd reference chains a 2nd pair). Stock nodes only — deps/install are unchanged. Output size comes from the width/height of the nodes in `size`.
      reference: {
        maxRefs: 2,
        files: { 1: 'workflows/flux2_klein_ref1.json', 2: 'workflows/flux2_klein_ref2.json' },
        nodes: { positive: '4', negative: '14', ref_images: ['20', '25'], size: ['7', '8'],
                 seed: { node: '10', field: 'noise_seed' }, output: '13' },
        sizeDefault: [1024, 1024],
      },
      deps:    {
        // trimmed 2026-09-17 (shipmitnull-workflow-manifests): EmptyFlux2LatentImage/Flux2Scheduler are
        // core ComfyUI nodes (comfy_extras/nodes_flux.py), not plugins — flux_klein needs ZERO custom
        // nodes. Leaving them declared with no install.custom_nodes match would make plan()/status()
        // report "manual" forever.
        custom_nodes: [],
        models: ['flux-2-klein-base-4b.safetensors', 'qwen_3_4b.safetensors', 'flux2-vae.safetensors'],
      },
      builtin: true,
      example: { kind: 'image', file: 'flux_klein.jpg' },   // Shipped example in web/examples/.
      description: 'Default text-to-image. Good detail and prompt following — the standard choice for props.',
      faq:     'comfyui-port-8188',
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
    z_image_turbo: {
      label:   'Z-Image Turbo',
      stage:   'image',
      file:    path.join(__dirname, 'workflows', 'z_image_turbo_txt2img.json'),
      // No cfg/steps/negative slot on purpose: Z-Image Turbo must run at cfg 1 / 8 steps with a ConditioningZeroOut
      // negative (official ComfyUI template). Phoenix's session cfg/steps (made for flux) would break it, so the
      // workflow keeps its own values.
      nodes:   { positive: '4', seed: { node: '8', field: 'seed' }, output: '10' },
      // v1.10 ADV: z-image's own tunables (defaults come from its JSON: 8 steps / res_multistep / 1024x1024). NO cfg control on purpose:
      // it is a turbo model that runs at cfg 1 (the JSON value stays). The palette's Flux values never reach it. Denoise exists only in the img2img reference variant (referenceParams below).
      params:  [
        { key: 'steps',   label: 'Steps',   type: 'int',   min: 1, max: 50, step: 1,   targets: [{ node: '8', field: 'steps' }] },
        { key: 'sampler', label: 'Sampler', type: 'enum',  targets: [{ node: '8', field: 'sampler_name' }] },
        { key: 'size',    label: 'Size',    type: 'size',  min: 256, max: 2048, step: 16, targets: sizeTargets('7') },
      ],
      // v1.10 I1: img2img only (Z-Image has no documented reference mechanism): VAEEncode latent into the KSampler with denoise < 1.
      reference: {
        maxRefs: 1, mode: 'img2img',
        files: { 1: 'workflows/z_image_turbo_img2img.json' },
        nodes: { positive: '4', ref_images: ['20'], denoise: { node: '8', field: 'denoise' },
                 seed: { node: '8', field: 'seed' }, output: '10' },
        denoiseDefault: 0.6,
      },
      // v1.10 ADV: the img2img denoise lives in the same store (default read from the img2img JSON); shown in the Advanced section. (Kept beside, not inside, I1's `reference` block.)
      referenceParams: [
        { key: 'denoise', label: 'Denoise (reference)', type: 'float', min: 0.05, max: 1, step: 0.05, file: 'workflows/z_image_turbo_img2img.json', targets: [{ node: '8', field: 'denoise' }] },
      ],
      deps:    { custom_nodes: [], models: ['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors'] },
      builtin: true,
      example: { kind: 'image', file: 'z_image_turbo.jpg' },   // Shipped example in web/examples/.
      description: 'Fast 8-step text-to-image with strong photo realism. Needs more VRAM than Flux Klein; shares its text encoder.',
      faq:     'comfyui-port-8188',
      install: {
        license: 'Apache-2.0',   // Tongyi-MAI Z-Image-Turbo / Comfy-Org repack
        vram_gb: 22,             // measured 2026-10-13: ~22 GB peak on a 24 GB RTX 3090 (ComfyUI keeps encoder + model resident; smaller cards offload)
        custom_nodes: [],
        models: [
          { filename: 'z_image_turbo_bf16.safetensors',
            source: { hf: 'Comfy-Org/z_image_turbo/split_files/diffusion_models/z_image_turbo_bf16.safetensors' },
            dir: 'diffusion_models', size_gb: 11.5 },
          { filename: 'qwen_3_4b.safetensors',   // byte-identical to flux_klein's (same LFS sha256) — shared, uninstall keeps it while flux_klein uses it
            source: { hf: 'Comfy-Org/z_image_turbo/split_files/text_encoders/qwen_3_4b.safetensors' },
            dir: 'text_encoders', size_gb: 7.5 },
          { filename: 'ae.safetensors',
            source: { hf: 'Comfy-Org/z_image_turbo/split_files/vae/ae.safetensors' },
            dir: 'vae', size_gb: 0.31 },
        ],
      },
    },
    sd15: {
      label:   'SD1.5',
      stage:   'image',
      file:    path.join(__dirname, 'workflows', 'sd15_txt2img.json'),
      nodes:   { positive: '6', negative: '7', cfg: '3', steps: '3', seed: { node: '3', field: 'seed' }, output: '9' },
      params:  [
        { key: 'cfg',     label: 'CFG',     type: 'float', min: 0, max: 20,  step: 0.1, targets: [{ node: '3', field: 'cfg' }] },
        { key: 'steps',   label: 'Steps',   type: 'int',   min: 1, max: 100, step: 1,   targets: [{ node: '3', field: 'steps' }] },
        { key: 'sampler', label: 'Sampler', type: 'enum',  targets: [{ node: '3', field: 'sampler_name' }] },
        { key: 'size',    label: 'Size',    type: 'size',  min: 256, max: 2048, step: 16, targets: sizeTargets('5') },
      ],
      deps:    { custom_nodes: [], models: ['v1-5-pruned-emaonly-fp16.safetensors'] },
      builtin: true,
      example: { kind: 'image', file: 'sd15.jpg' },   // Shipped example in web/examples/.
      description: 'Small, fast text-to-image for low-VRAM cards. Lower quality than Flux Klein.',
      faq:     'phoenix-workflow-stale-path',
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
      params:  [
        { key: 'target_face_num', label: 'Target faces',    type: 'int',  min: 200, max: 300000, step: 100, targets: [{ node: '5', field: 'target_face_num' }] },
        { key: 'texture_size',    label: 'Texture size',    type: 'enum', options: [512, 1024, 2048],      targets: [{ node: '5', field: 'texture_size' }] },
        { key: 'structure_steps', label: 'Structure steps', type: 'int',  min: 4, max: 50, step: 1,       targets: [{ node: '4', field: 'sparse_structure_steps' }] },
        { key: 'shape_steps',     label: 'Shape steps',     type: 'int',  min: 4, max: 50, step: 1,       targets: [{ node: '4', field: 'shape_steps' }] },
        { key: 'texture_steps',   label: 'Texture steps',   type: 'int',  min: 4, max: 50, step: 1,       targets: [{ node: '4', field: 'texture_steps' }] },
      ],
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
      example: { kind: 'mesh', file: 'trellis2.glb' },   // Shipped example in web/examples/.
      description: 'Image to textured 3D mesh (GLB). Downloads its weights on the first run.',
      faq:     'trellis-first-mesh-timeout',
      install: {
        // Plugin CODE license is MIT (LICENSE file, rig-verified). The MODEL WEIGHTS' license is stated
        // honestly rather than guessed — no fabricated SPDX id; check the model card (Aero-Ex/Trellis2-GGUF).
        license: 'MIT (plugin code) — model weights: see the model card (Aero-Ex/Trellis2-GGUF)',
        vram_gb: 10,   // estimated — low_vram:true in the workflow JSON, runs on the rig's 10GB card today
        disk_gb: 6.9,  // self-downloaded weights (install.models stays []) — explicit so the picker can show a size
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
      params:   [   // no denoise: an edit model runs at 1
        { key: 'cfg',     label: 'CFG',     type: 'float', min: 0, max: 20,  step: 0.1, targets: [{ node: '9', field: 'cfg' }] },
        { key: 'steps',   label: 'Steps',   type: 'int',   min: 1, max: 100, step: 1,   targets: [{ node: '9', field: 'steps' }] },
        { key: 'sampler', label: 'Sampler', type: 'enum',  targets: [{ node: '9', field: 'sampler_name' }] },
      ],
      deps:     {
        // trimmed 2026-09-17 (shipmitnull-workflow-manifests): CLIPLoader/TextEncodeQwenImageEditPlus/
        // ImageScaleToTotalPixels are core ComfyUI nodes, not plugins — only UnetLoaderGGUF (ComfyUI-GGUF)
        // is a real installable dep. Leaving the core names declared with no install source would make
        // plan()/status() report "manual" forever.
        custom_nodes: ['UnetLoaderGGUF'],
        models: ['Qwen-Image-Edit-2509-Q3_K_M.gguf', 'qwen_2.5_vl_7b_fp8_scaled.safetensors', 'qwen_image_vae.safetensors'],
      },
      builtin: true,
      example: { kind: 'image', file: 'qwen_edit.jpg' },   // Shipped example in web/examples/.
      description: 'Edit an image by instruction — material, colour, style. Keeps the shape.',
      faq:     'i2i-material-edit-black-or-unchanged',
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
      instance: 'trellis',              // the ComfyUI that hosts the ComfyUI-RMBG suite
      mode:     'segment',              // text-guided isolation — the reliable "cut a part out" engine (measured 2026-08-06)
      file:     path.join(__dirname, 'workflows', 'sam3_segment.json'),
      nodes:    { input_image: '1', prompt: '2', output: '3' },   // no cfg/seed: SAM3 is deterministic
      deps:     {
        custom_nodes: ['SAM3Segment'],  // sam3.pt loads internally (no model_name input) → not a dep-checkable model name
        models: [],
      },
      builtin: true,
      example: { kind: 'image', file: 'sam3_isolate.jpg' },   // Shipped example in web/examples/.
      description: 'Cut one object out of an image by naming it.',
      faq:     'i2i-sam3-isolate-fails',
      install: {
        // Plugin code (ComfyUI-RMBG) is GPL-3.0 (LICENSE file, rig-verified) — new info, badge set
        // honestly. Model weights (SAM3, via the 1038lab/sam3 mirror) are Meta's own release terms,
        // redistributed ungated by the mirror but the underlying rights are Meta's, not 1038lab's.
        license: 'GPL-3.0',
        vram_gb: 4,   // estimated — sam3.pt is 3.2GB loaded, workflow sets unload_model:true after each run
        disk_gb: 3.2, // sam3.pt self-downloads into the node dir (install.models stays []) — explicit for the picker
        custom_nodes: [
          { classType: 'SAM3Segment', git: 'https://github.com/1038lab/ComfyUI-RMBG.git', ref: 'd7402513f23f58db7d56754b02a4f51a148b4941' },
        ],
        // sam3.pt self-downloads into the node's OWN dir (ComfyUI-RMBG/models/sam3/sam3.pt), not
        // modelsRoot — the install.models[] contract has no way to express that destination. A hard
        // architectural constraint (manifest), not a product choice like trellis2's.
        models: [],
      },
    },
    // ── video category (v1.10 V2) ───────────────────────────────────────────────
    // Local image-to-video for the storyboard's Make video: ONE start image + the shot prompt -> a short mp4 on the user's own GPU.
    // The backend (providers/comfy-i2v.js) is workflow-driven: it patches the slots of this node map into the API-format graph and
    // reads everything model-specific from the `video` block (frame rule, fps, sizes, poll timeout) - a second model (e.g. Wan 2.2) is
    // another stage:'video' entry, not code. Bench 14./15.10.2026 (RTX 3090): 3 s at 768x448 warm 40-64 s, runs beside a resident seat.
    ltx2_i2v: {
      label:   'Local · LTX-2 i2v',
      stage:   'video',
      file:    path.join(__dirname, 'workflows', 'ltx2_i2v.json'),
      // no negative slot on purpose: the distilled LTX-2 graph zeroes the positive conditioning (CFG 1). width/height are ONE node (ImageScale) -
      // the size is applied to the resized start image and the whole two-stage chain derives from it. output = the SaveVideo node.
      nodes:   { image: '98', positive: '3', length: '62', width: { node: '102', field: 'width' }, height: { node: '102', field: 'height' }, seed: '11', output: '75' },
      // frames = step*k + offset (k whole), 25 fps, at most 73 (2.9 s; LC2f - measured: motion in the last quarter of the clip is 45 % of the first at 73 frames, 19 % at 97, 18 % at 121 - the second half is a still blade; a custom entry may be raised to 121); sizes are multiples of 64 (else ComfyUI snaps silently); audio:true = the
      // model always writes an audio track (video.local.keepAudio decides whether Phoenix keeps it); timeoutMin = poll limit (a cold first load is 4.5-6 min).
      video:   { fps: 25, frames: { step: 8, offset: 1, min: 9, max: 73 }, sizes: { '16:9': [768, 448], '9:16': [448, 768], '1:1': [576, 576] }, timeoutMin: 10, audio: true, expect: { warm_s: 60, cold_s: 360 } },   // expect = what the bench saw (warm ~1 min, first run after start-up up to ~6 min), shown as an honest hint next to the elapsed time
      deps:    { custom_nodes: [], models: ['ltx-2-19b-distilled-fp8.safetensors', 'gemma_3_12B_it_fp4_mixed.safetensors', 'ltx-2-spatial-upscaler-x2-1.0.safetensors'] },
      builtin: true,
      description: 'Free local image-to-video for the storyboard: your keyframe plus the shot prompt become a clip of up to 3 s with sound, in about a minute on a 24 GB card. Needs ComfyUI 0.27 or newer, about 38 GB of disk and 48 GB of RAM; it also runs with less free VRAM, only slower. Licence: LTX-2 is free for companies under $10M annual revenue, above that you need a paid licence from Lightricks; its text encoder (Gemma 3) has its own terms from Google.',
      faq:     'comfyui-port-8188',
      install: {
        license: 'LTX-2 Community License (free under $10M annual revenue; a paid licence from Lightricks above that) + Gemma Terms of Use (text encoder)',
        vram_gb: 8,   // the floor it still runs at (slower, offloads to RAM); it uses up to ~24 GB when free. RAM >= 48 GB recommended (bench 15.10.2026)
        custom_nodes: [],   // core nodes only (ComfyUI 0.27+: LTXAVTextEncoderLoader, LTXVImgToVideoInplace, LTXVLatentUpsampler)
        models: [
          { filename: 'ltx-2-19b-distilled-fp8.safetensors',
            source: { hf: 'Lightricks/LTX-2/ltx-2-19b-distilled-fp8.safetensors' },
            dir: 'checkpoints', size_gb: 27.1 },
          { filename: 'gemma_3_12B_it_fp4_mixed.safetensors',
            source: { hf: 'Comfy-Org/ltx-2/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors' },
            dir: 'text_encoders', size_gb: 9.4 },
          { filename: 'ltx-2-spatial-upscaler-x2-1.0.safetensors',
            source: { hf: 'Lightricks/LTX-2/ltx-2-spatial-upscaler-x2-1.0.safetensors' },
            dir: 'latent_upscale_models', size_gb: 1.0 },
        ],
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
      description: 'Default voice engine. Ships with Phoenix, nothing to install.',
    },
    chatterbox: {
      label:   'Chatterbox',
      stage:   'voice',
      builtin: true,
      description: 'Expressive voice with cloning from a short sample. Runs on this PC (Settings → Voice engines); use your own voice or your characters.',
      // Config-capability gate: engine=<id> is understood only by a /speak dispatcher. Since 1.10 one ships
      // (voice-dispatcher.js, started by Phoenix when voice.dispatcher = { local: true }); voice.dispatcher = true
      // means an external dispatcher already answers behind voice.api. Without either, a plain CrispASR speech
      // server cannot route it, so it stays greyed until the config declares a dispatcher. See engineAvailability().
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
          // absolute per-user path; the maintainer's own path lives ONLY in a gitignored phoenix-config.json.
          // VO1: torch MUST be the CUDA build — Acquire installs torch/torchaudio 2.6.0 from this index BEFORE
          // chatterbox-tts (on Windows plain pip would otherwise pick a CPU-only torch).
          venv: { path: 'venv', python: '3.12', torch: '2.6.0', index_url: 'https://download.pytorch.org/whl/cu124', size_gb: 5.4,
            // VO1b: resemble-perth 1.0.1 builds + applies PerthImplicitWatermarker on a 24 kHz sine (checked 2026-10-14, CPU). It imports
            // pkg_resources, which setuptools >= 81 dropped (a bare py3.12 venv has none) - hence the setuptools pin: that was the 'incompatible perth'.
            pins: ['resemble-perth==1.0.1', 'setuptools<81'] },
          pip:  'chatterbox-tts==0.1.7',
          weights: {
            // VO1b: exactly the six files ChatterboxMultilingualTTS.from_pretrained reads (mtl_tts.py
            // snapshot_download allow_patterns) = 3.21 GB — NOT the whole repo (> 9 GB). Fetched into the
            // HF cache <root>\hf-cache by the venv's own python; the dispatcher hands the adapter HF_HOME.
            source:  { hf: 'ResembleAI/chatterbox', files: ['ve.pt', 't3_mtl23ls_v2.safetensors', 's3gen.pt', 'grapheme_mtl_merged_expanded_v1.json', 'conds.pt', 'Cangjie5_TC.json'] },
            dir:     'hf-cache',
            size_gb: 3.3,
          },
          // VO1: resolves to the SHIPPED file voice-engines/<adapter> (product code, see voice.js enginesFile()),
          // never into the engine root — the Acquire only fetches venv + weights.
          adapter: 'chatterbox_adapter.py',
        },
      },
    },
    cosyvoice: {
      label:   'CosyVoice',
      stage:   'voice',
      builtin: true,
      description: 'Multilingual voice engine. Runs through a voice dispatcher; not yet run end-to-end.',
      // Same dispatcher gate as chatterbox (greyed until a dispatcher is configured). See engineAvailability() below.
      requiresDispatcher: true,
      // Secondary reason (applies once the dispatcher IS present, e.g. on a second machine): engine=cosyvoice
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
            // literal absolute path of one specific install; now resolves per-customer).
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
 * workflowMeta(entry) — pure, never throws. The display facts the stage pickers show next to a
 * workflow: { description, disk_gb, faq, faq_url }. Every field is null when the entry has nothing
 * valid for it (custom workflows may omit all of them).
 *   disk_gb: install.disk_gb (explicit, for self-downloading weights) → else the ComfyUI form's
 *   install.models[].size_gb sum → else the voice-engine form's install.engine.weights.size_gb.
 */
const FAQ_BASE_URL = 'https://github.com/laconova/phoenix/blob/master/troubleshooting/entries/';
function workflowMeta(entry) {
  const out = { description: null, disk_gb: null, faq: null, faq_url: null };
  try {
    if (!entry || typeof entry !== 'object') return out;
    if (typeof entry.description === 'string' && entry.description) out.description = entry.description;
    if (typeof entry.faq === 'string' && /^[a-z0-9-]+$/.test(entry.faq)) {
      out.faq = entry.faq;
      out.faq_url = FAQ_BASE_URL + entry.faq + '.md';
    }
    const inst = entry.install;
    if (inst && typeof inst === 'object') {
      let gb = null;
      if (typeof inst.disk_gb === 'number' && Number.isFinite(inst.disk_gb) && inst.disk_gb >= 0) {
        gb = inst.disk_gb;
      } else {
        let sum = 0;
        if (Array.isArray(inst.models)) {
          for (const m of inst.models) {
            if (m && typeof m.size_gb === 'number' && Number.isFinite(m.size_gb)) sum += m.size_gb;
          }
        }
        const w = inst.engine && inst.engine.weights;
        if (sum > 0) gb = sum;
        else if (w && typeof w.size_gb === 'number' && Number.isFinite(w.size_gb) && w.size_gb > 0) gb = w.size_gb;
      }
      if (gb !== null) out.disk_gb = Math.round(gb * 10) / 10;
    }
  } catch (_) { /* never throws — fall through with whatever was filled */ }
  return out;
}

// <b2r-profiles>
// v1.10 B2r: what Phoenix has actually run each ComfyUI instance with (measured on the rig 2026-10-12). These are the
// versions we KNOW work, not proven minimums — the UI labels them "Tested with", never "requires". The facts belong to the
// INSTANCE (flux, sd15, trellis2 and sam3 all share `trellis`), so a workflow reaches its profile through `entry.instance`.
const TESTED_PROFILES = {
  trellis: {
    comfyui: '0.27.0 (2c935de)', python: '3.11.15', torch: '2.5.1+cu124', cuda: '12.4',
    wheels: { xformers: '0.0.28.post3', triton: '3.2.0', flash_attn: '2.8.3', nvdiffrast: '0.4.0', open3d: '0.19.0', pymeshlab: '2025.7', 'onnxruntime-gpu': '1.27.0', gguf: '0.19.0' },
  },
  bild: {
    comfyui: '2c935de', python: '3.12.3', torch: '2.12.1+cu130', cuda: '13.0',
    wheels: { triton: '3.7.1', gguf: '0.19.0', diffusers: '0.40.0' },
  },
};
const DEFAULT_INSTANCE = 'trellis';

/** testedProfileFor(entry) → a copy of the tested profile of the entry's instance (default `trellis`); voice / unknown instance → null. */
function testedProfileFor(entry) {
  if (!entry || typeof entry !== 'object' || entry.stage === 'voice') return null;
  const p = TESTED_PROFILES[entry.instance || DEFAULT_INSTANCE];
  return p ? JSON.parse(JSON.stringify(p)) : null;
}

/**
 * exampleFor(entry, examplesDir) → { kind: 'image'|'mesh', url } | null. A builtin carries `example: { kind, file }`; the file lives
 * under web/examples/ and is served at /examples/<file>. No example, a bad name or a file that is not on disk → null (the UI shows "No example yet").
 */
function exampleFor(entry, examplesDir) {
  try {
    const ex = entry && entry.example;
    if (!ex || typeof ex !== 'object') return null;
    if (ex.kind !== 'image' && ex.kind !== 'mesh') return null;
    const file = ex.file;
    if (typeof file !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(file)) return null;
    if (!fs.statSync(path.join(examplesDir, file)).isFile()) return null;
    return { kind: ex.kind, url: '/examples/' + file };
  } catch (_) { return null; }
}

/**
 * envFromSystemStats(base, stats) → the "On your ComfyUI" facts from a ComfyUI GET /system_stats body (pure, never throws):
 * { reachable:true, base, comfyui, python, torch, cuda, gpu, vram_gb }. python = the part before the first space; cuda comes from
 * torch's +cuXYZ suffix (cu124 → 12.4, cu130 → 13.0) or null; gpu = the first cuda device without the ": cudaMallocAsync" tail.
 */
function envFromSystemStats(base, stats) {
  const out = { reachable: true, base, comfyui: null, python: null, torch: null, cuda: null, gpu: null, vram_gb: null };
  try {
    const sys = (stats && stats.system) || {};
    if (typeof sys.comfyui_version === 'string') out.comfyui = sys.comfyui_version;
    if (typeof sys.python_version === 'string') out.python = sys.python_version.trim().split(/\s+/)[0] || null;
    if (typeof sys.pytorch_version === 'string') {
      out.torch = sys.pytorch_version;
      const m = /\+cu(\d{3,4})\b/.exec(sys.pytorch_version);
      if (m) out.cuda = m[1].slice(0, 2) + '.' + m[1].slice(2);
    }
    const dev = (Array.isArray(stats && stats.devices) ? stats.devices : []).find(d => d && d.type === 'cuda');
    if (dev) {
      if (typeof dev.name === 'string') out.gpu = dev.name.replace(/\s*:\s*cudaMallocAsync\s*$/, '');
      if (typeof dev.vram_total === 'number' && dev.vram_total > 0) out.vram_gb = Math.round(dev.vram_total / 1073741824 * 10) / 10;
    }
  } catch (_) { /* whatever was filled stays */ }
  return out;
}
// </b2r-profiles>

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
// LC2e: ids that were shipped as a builtin once and are not any more. A saved registry still carries such an entry with
// builtin:true (the loop below only adds/refreshes ids that ARE shipped), and builtin:true makes it uneditable and undeletable -
// it would point at a file that is gone and block Add workflow from using the id. Dropped on load; a user's own builtin:false
// entry of the same id is never touched. wan22_i2v: LC2d r1-r5 shipped it as an unverified builtin; it comes back through Add workflow.
const RETIRED_BUILTINS = ['wan22_i2v'];

function mergeMissingBuiltins(reg) {
  if (!reg || typeof reg !== 'object') return JSON.parse(JSON.stringify(DEFAULT_WORKFLOWS));
  if (!reg.workflows || typeof reg.workflows !== 'object') reg.workflows = {};
  for (const id of RETIRED_BUILTINS) {
    const e = reg.workflows[id];
    if (e && typeof e === 'object' && e.builtin === true) delete reg.workflows[id];
  }
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
// v1.10 V2: stages added later keep their default HERE (DEFAULT_ACTIVE's key list is a frozen fact of the original four stages); defaultActive(stage) reads both.
const EXTRA_ACTIVE = { video: 'ltx2_i2v' };
const defaultActive = (stage) => DEFAULT_ACTIVE[stage] || EXTRA_ACTIVE[stage];

/**
 * dispatcherMode(voiceCfg) → 'off' | 'rig' | 'local'   (VO1)
 * voice.dispatcher has two shapes: `true` = RIG mode (voice.api routes engines itself, Phoenix spawns
 * nothing) and `{ local: true, port?: 8091 }` = LOCAL mode (Phoenix spawns voice-dispatcher.js). An
 * object without `local: true` is off; any other truthy value keeps the old meaning (rig).
 * `voiceCfg` is the `voice` sub-object of phoenix-config.json.
 */
function dispatcherMode(voiceCfg) {
  const d = voiceCfg && voiceCfg.dispatcher;
  if (!d) return 'off';
  if (typeof d === 'object') return d.local === true ? 'local' : 'off';
  return 'rig';
}
/** hasDispatcher(cfg) — cfg is the WHOLE config; both shapes count as "has a dispatcher". */
function hasDispatcher(cfg) { return dispatcherMode(cfg && cfg.voice) !== 'off'; }

/**
 * engineAvailability(entry, hasDispatcher) → { available: bool, reason: string|null }
 * The single source of truth for "can this (voice) engine be used / activated / acquired right now".
 * Generalizes the old bare `blocked` check into an effective "unavailable + reason", combining the
 * config-capability gate with the pre-existing per-engine block. Two gates, DISPATCHER FIRST (the
 * governing PUBLIC gate):
 *   1. requiresDispatcher && !hasDispatcher → unavailable. The engine=<id> the picker sends is
 *      understood only by a voice dispatcher (local: Settings → Voice engines, or a rig-side service), so on a
 *      plain CrispASR server it is inert. The reason tells the user which switch to turn on.
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
    return { available: false, reason: 'turn on "Run voice engines on this PC" in Settings → Voice engines' };
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
  const activeId = (cfg && cfg.workflows && cfg.workflows[stage]) || defaultActive(stage);
  const reg      = loadRegistry();
  const entry    = reg.workflows && reg.workflows[activeId];
  const hasDisp = hasDispatcher(cfg);
  if (entry && entry.stage === stage && engineAvailability(entry, hasDisp).available) {
    return { id: activeId, ...entry };
  }
  // Fallback to built-in default
  const fallbackId    = defaultActive(stage);
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
  if (stage !== 'image' && stage !== 'mesh' && stage !== 'i2i' && stage !== 'voice' && stage !== 'video') {
    return { ok: false, error: 'stage must be "image", "mesh", "i2i", "voice" or "video"', field: 'stage' };
  }
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'id must be a non-empty string', field: 'id' };
  }

  const entry = reg && reg.workflows && reg.workflows[id];
  if (!entry) return { ok: false, error: 'unknown workflow id', field: 'id' };
  if (entry.stage !== stage) return { ok: false, error: 'workflow is not for this stage', field: 'stage' };

  if (stage === 'voice') {
    const av = engineAvailability(entry, hasDispatcher(cfg));
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

  for (const key of REQUIRED_SLOTS[stage]) {
    if (!entry.nodes || !entry.nodes[key]) {
      return { ok: false, error: 'nodes map missing key: ' + key, field: 'nodes' };
    }
  }
  return { ok: true, entry };
}

// comboOptions(spec) — the option list of one /object_info input spec, or null.
// Old ComfyUI shape: [ ["a","b"], {opts} ]; new shape: [ "COMBO", { options: ["a","b"] } ].
function comboOptions(spec) {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === 'COMBO' && spec[1] && typeof spec[1] === 'object' && Array.isArray(spec[1].options)) return spec[1].options;
  return null;
}

/**
 * collectEnumValues(objectInfo) — returns a Set of all string enum option values
 * from a ComfyUI /object_info response.
 * Iterates all node class definitions and collects every string that appears as
 * a combo/enum choice (see comboOptions: old and new /object_info shape).
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
        const opts = comboOptions(spec);
        if (opts) {
          for (const v of opts) if (typeof v === 'string') vals.add(v);
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
 * - missing_models: declared models not found in the enum values set AND not a whole JSON string
 *   value that equals the name or ends with "/name" or "\name" (subfolder-prefixed enum values).
 *   A bare substring is NOT enough: ae.safetensors is a substring of flux2-vae.safetensors but is a
 *   distinct model.
 */
function checkDeps(entry, objectInfo) {
  const enumVals      = collectEnumValues(objectInfo);
  // every string value anywhere in objectInfo (whole values only — no substring matching)
  const allStrings    = new Set();
  (function walk(v) {
    if (typeof v === 'string') allStrings.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(objectInfo);
  const inInfo = (m) => { for (const v of allStrings) if (v === m || v.endsWith('/' + m) || v.endsWith('\\' + m)) return true; return false; };
  const missing_nodes  = (entry.deps && entry.deps.custom_nodes || []).filter(name => !(name in objectInfo));
  const missing_models = (entry.deps && entry.deps.models || []).filter(m => !enumVals.has(m) && !inInfo(m));
  return { missing_nodes, missing_models, ready: missing_nodes.length === 0 && missing_models.length === 0 };
}

// The slots a workflow entry MUST map, per stage - ONE list for validateActivate (what a selectable entry needs) and validateNodeMap (what
// Add/Edit workflow accepts). video (v1.10 V2): the slots the local video backend needs.
const REQUIRED_SLOTS = {
  image: ['positive', 'output'],
  mesh:  ['image', 'output'],
  i2i:   ['input_image', 'output'],
  video: ['image', 'positive', 'length', 'output'],
};

const DEFAULT_FIELDS = {
  image: { positive: 'text', negative: 'text', cfg: 'cfg', steps: 'steps', seed: 'noise_seed', output: null },
  mesh:  { image: 'image', seed: 'seed', target_face_num: 'target_face_num', output_prefix: 'filename_prefix', output: null },
  // i2i: input_image = the LoadImage node's `image` field; prompt/cfg/seed target the edit's
  // sampler/encoder. cfg+seed are optional (a segmenter like SAM3 has neither) and are only
  // injected when the node-map declares them.
  i2i:   { input_image: 'image', prompt: 'prompt', cfg: 'cfg', seed: 'seed', output: null },
  // video (v1.10 V2): image = the LoadImage node, length = the frame-count primitive, width/height = the node that sets the size
  video: { image: 'image', positive: 'text', negative: 'text', length: 'value', width: 'width', height: 'height', seed: 'noise_seed', output: null },
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
  if (!Object.prototype.hasOwnProperty.call(REQUIRED_SLOTS, stage)) {
    return { ok: false, error: 'Unknown stage: ' + stage };
  }
  for (const slot of REQUIRED_SLOTS[stage]) {
    const val = nodes[slot];
    if (val === undefined || val === null) {
      return { ok: false, error: 'Missing required slot: ' + slot, field: 'nodes.' + slot };
    }
    if (typeof val === 'string' && val.trim() === '') {
      return { ok: false, error: 'Missing required slot: ' + slot, field: 'nodes.' + slot };
    }
    if (typeof val === 'object' && (!val.node || String(val.node).trim() === '')) {
      return { ok: false, error: 'Missing required slot: ' + slot, field: 'nodes.' + slot };
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
      return { ok: false, error: 'Slot "' + slot + '" maps to node "' + nodeId + '" which is not in the workflow JSON.', field: 'nodes.' + slot };
    }
  }
  // AW1: a video entry is patched through the manifest alone, so a scalar slot must name a field the node really has - the default field
  // of a slot (DEFAULT_FIELDS.video) is only a guess (Wan's length sits on WanImageToVideo.length, not on a PrimitiveInt's "value").
  // image/mesh/i2i keep ignoring fields (byte-for-byte as before). output needs the node only.
  if (stage === 'video') {
    for (const slot of VIDEO_SCALAR_SLOTS) {
      const val = nodes[slot];
      if (val === undefined || val === null) continue;
      const r = resolveSlot('video', slot, val);
      const node = obj[r.node];
      const inputs = (node && node.inputs && typeof node.inputs === 'object') ? node.inputs : {};
      if (!r.field || !Object.prototype.hasOwnProperty.call(inputs, r.field)) {
        const hint = (VIDEO_FIELD_HINTS[slot] || []).find(f => Object.prototype.hasOwnProperty.call(inputs, f));
        return { ok: false, field: 'nodes.' + slot, error: 'Slot "' + slot + '" → node ' + r.node + ' has no input "' + r.field + '" — set the field' + (hint ? ' (e.g. "' + hint + '")' : '') + '.' };
      }
    }
  }
  return { ok: true, error: null };
}

const VIDEO_SCALAR_SLOTS = ['image', 'positive', 'negative', 'length', 'width', 'height', 'seed'];
const VIDEO_FIELD_HINTS = { image: ['image'], positive: ['text', 'prompt'], negative: ['text', 'prompt'], length: ['length', 'value', 'frames', 'num_frames'], width: ['width'], height: ['height'], seed: ['noise_seed', 'seed'] };

// ─── AW1: the `video` block of a custom video entry ──────────────────────────────────────────────────────────────────────────
const isInt = (x) => typeof x === 'number' && Number.isInteger(x);
const isPosNum = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * validateVideoBlock(v) → { ok:true, video } | { ok:false, error, field }   (pure)
 * The frame rule / fps / sizes / poll limit the local video backend (providers/comfy-i2v.js) reads. Without a block framesFor() would silently
 * use LTX-2's rule, so a custom entry MUST carry a valid one. `video` in the answer = the stored form (defaults filled in, unknown keys dropped).
 */
function validateVideoBlock(v) {
  const bad = (field, error) => ({ ok: false, field, error });
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('video', 'A video workflow needs a "video" block (fps, frames, sizes, ...).');
  if (typeof v.fps !== 'number' || !Number.isFinite(v.fps) || v.fps < 1 || v.fps > 120) return bad('video.fps', 'video.fps must be a number from 1 to 120.');
  const f = v.frames;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return bad('video.frames', 'video.frames needs { step, offset, min, max }.');
  if (!isInt(f.step) || f.step < 1) return bad('video.frames.step', 'video.frames.step must be a whole number of at least 1.');
  if (!isInt(f.offset) || f.offset < 0) return bad('video.frames.offset', 'video.frames.offset must be a whole number of at least 0.');
  if (f.offset >= f.step) return bad('video.frames.offset', 'video.frames.offset (' + f.offset + ') must be smaller than step (' + f.step + ').');   // LC2f: offset 5 on step 4 is the grid of offset 1, shown under a wrong number
  if (!isInt(f.min) || f.min < 1) return bad('video.frames.min', 'video.frames.min must be a whole number of at least 1.');
  if (!isInt(f.max) || f.max < f.min) return bad('video.frames.max', 'video.frames.max must be a whole number, not below min (' + (isInt(f.min) ? f.min : '?') + ').');
  if ((f.min - f.offset) % f.step !== 0) return bad('video.frames.min', 'video.frames.min (' + f.min + ') is not on the model\'s frame grid (offset ' + f.offset + ' + a multiple of ' + f.step + ').');
  if ((f.max - f.offset) % f.step !== 0) return bad('video.frames.max', 'video.frames.max (' + f.max + ') is not on the model\'s frame grid (offset ' + f.offset + ' + a multiple of ' + f.step + ').');
  const s = v.sizes;
  if (!s || typeof s !== 'object' || Array.isArray(s) || !s['16:9']) return bad('video.sizes', 'video.sizes needs at least the 16:9 size [width, height].');
  for (const [asp, wh] of Object.entries(s)) {
    if (!Array.isArray(wh) || wh.length !== 2 || !wh.every(n => isInt(n) && n >= 64 && n <= 4096)) return bad('video.sizes.' + asp, 'video.sizes["' + asp + '"] must be [width, height], whole numbers from 64 to 4096.');
  }
  let timeoutMin = 15;
  if (v.timeoutMin !== undefined) {
    if (typeof v.timeoutMin !== 'number' || !Number.isFinite(v.timeoutMin) || v.timeoutMin < 1 || v.timeoutMin > 60) return bad('video.timeoutMin', 'video.timeoutMin must be a number from 1 to 60 (minutes).');
    timeoutMin = v.timeoutMin;
  }
  if (typeof v.audio !== 'boolean') return bad('video.audio', 'video.audio must be true or false (does the model write a sound track?).');
  const out = { fps: v.fps, frames: { step: f.step, offset: f.offset, min: f.min, max: f.max }, sizes: {}, timeoutMin, audio: v.audio };
  for (const [asp, wh] of Object.entries(s)) out.sizes[asp] = [wh[0], wh[1]];
  if (v.expect !== undefined && v.expect !== null) {
    const e = v.expect;
    if (typeof e !== 'object' || Array.isArray(e) || !isPosNum(e.warm_s) || !isPosNum(e.cold_s)) return bad('video.expect', 'video.expect must be { warm_s, cold_s } (positive seconds) or left out.');
    out.expect = { warm_s: e.warm_s, cold_s: e.cold_s };
  }
  return { ok: true, video: out };
}

// ── LC2f (D3): where a video workflow runs - Phoenix MEASURES it, the user does not pick ───────────────────────────────────────────
// Two ComfyUI endpoints (comfyui + comfyui_bild): ask each one (1) are all the entry's models and nodes there, (2) which PyTorch (ComfyUI only has
// DynamicVRAM with PyTorch >= 2.8). Pure: the caller does the two fetches.
const MODERN_TORCH = [2, 8];
function torchModern(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || '').trim());
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a > MODERN_TORCH[0] || (a === MODERN_TORCH[0] && b >= MODERN_TORCH[1]);
}
function torchShort(v) { const m = /^(\d+\.\d+)/.exec(String(v || '').trim()); return m ? m[1] : ''; }
function portOf(base) { try { const u = new URL(String(base)); return u.port || (u.protocol === 'https:' ? '443' : '80'); } catch (_) { return String(base); } }
/**
 * pickVideoInstance(cands, override) -> { key:'main'|'bild', instance:'bild'|undefined, base, ready, modern, override, reason, line }
 * cands = [{ key:'main', base, reachable, missing:[names], torch }, { key:'bild', ... }]. override = 'main' | 'bild' | undefined (the Advanced choice wins).
 * Rule: among the instances that have everything, prefer PyTorch >= 2.8; on a tie keep the main endpoint; if none has everything keep main (the line names what is missing).
 */
function pickVideoInstance(cands, override, opts) {
  const list = (Array.isArray(cands) ? cands : []).filter(c => c && (c.key === 'main' || c.key === 'bild'));
  const main = list.find(c => c.key === 'main') || list[0];
  if (!main) return null;
  const readyOf = (c) => !!(c.reachable && !(c.missing && c.missing.length));
  const modernOf = (c) => !!(c.reachable && torchModern(c.torch));
  let chosen, forced = false;
  if (override === 'main' || override === 'bild') { chosen = list.find(c => c.key === override) || main; forced = true; }
  else {
    const ready = list.filter(readyOf);
    const pool = ready.filter(modernOf).length ? ready.filter(modernOf) : ready;
    chosen = pool.length ? (pool.includes(main) ? main : pool[0]) : main;
  }
  const ready = readyOf(chosen), modern = modernOf(chosen);
  let why;
  if (!chosen.reachable) why = 'not answering';
  else if (!ready) why = 'missing: ' + chosen.missing.slice(0, 4).join(', ') + (chosen.missing.length > 4 ? ' …' : '');
  else why = 'all models found' + (modern ? ', modern memory management (PyTorch ' + torchShort(chosen.torch) + ')' : (torchShort(chosen.torch) ? ', PyTorch ' + torchShort(chosen.torch) : ''));
  const reason = why + (forced && !(opts && opts.quiet) ? ' (your choice)' : '');   // quiet = the STORED target described as it is, not as a choice
  return { key: chosen.key, instance: chosen.key === 'bild' ? 'bild' : undefined, base: chosen.base, ready, modern, override: forced, reason, target: 'ComfyUI :' + portOf(chosen.base), line: 'Runs on: ComfyUI :' + portOf(chosen.base) + ' — ' + reason };
}
// Store the pick on a saved stage:'video' entry (instance 'bild' or absent; instance_pinned = the user chose it in Advanced). Returns the entry or null. Never throws.
function setVideoInstance(id, instance, pinned) {
  try {
    const reg = loadRegistry();
    const e = reg.workflows[id];
    if (!e || e.stage !== 'video') return null;
    if (instance === 'bild') e.instance = 'bild'; else delete e.instance;
    if (pinned) e.instance_pinned = true; else delete e.instance_pinned;
    e.instance_checked_at = new Date().toISOString();   // LC2g (T11-1): every save-time / first-run pick is stamped, so "measured" is told apart from "never measured"
    reg.workflows[id] = e;
    saveRegistry(reg);
    return e;
  } catch (_) { return null; }
}

// ── LC2f r2 (D1): an LTX graph may be raised to 121 frames, not beyond (measured: motion fades after ~3 s; 121 is the model's own limit) ──
const LTX_MAX_FRAMES = 121;
function isLtxGraph(g) {   // the same detection the Add/Edit dialog uses for the grey note: a class_type containing "LTX"
  try { return /"class_type"\s*:\s*"[^"]*LTX/i.test(typeof g === 'string' ? g : JSON.stringify(g)); } catch (_) { return false; }
}
function checkVideoCap(video, graph) {   // -> null | { field, error }; video = a validated block
  if (video && video.frames && isLtxGraph(graph) && video.frames.max > LTX_MAX_FRAMES) {
    return { field: 'video.frames.max', error: 'video.frames.max (' + video.frames.max + ') is above the ' + LTX_MAX_FRAMES + ' frames an LTX workflow supports.' };
  }
  return null;
}

// the node ids from `startId` upstream (inputs that are links [id, idx]), breadth first, start first
function upstreamIds(graph, startId) {
  const seen = [], q = [String(startId)], mark = new Set();
  while (q.length) {
    const id = q.shift();
    if (mark.has(id) || !graph[id]) continue;
    mark.add(id); seen.push(id);
    for (const val of Object.values(graph[id].inputs || {})) if (isLink(val)) q.push(String(val[0]));
  }
  return seen;
}
function isLink(x) { return Array.isArray(x) && x.length === 2 && (typeof x[0] === 'string' || typeof x[0] === 'number'); }
// the [type, meta] spec of one input of a class in a /object_info answer, or null
function inputSpec(objectInfo, cls, field) {
  const inp = objectInfo && objectInfo[cls] && objectInfo[cls].input;
  const spec = inp && ((inp.required && inp.required[field]) || (inp.optional && inp.optional[field]));
  return Array.isArray(spec) ? spec : null;
}
const intMeta = (spec) => (spec && spec[0] === 'INT' && spec[1] && typeof spec[1] === 'object') ? spec[1] : null;

/**
 * deriveVideoBlock(graph, nodes, objectInfo|null) → { video, from }   (pure, deterministic - the LLM never sets these numbers)
 * graph = the cleaned API-format workflow, nodes = the (validated or LLM-proposed) node map, objectInfo = ComfyUI's /object_info (or a slice) or null.
 * from[<key>] = 'graph' | 'comfyui' | 'default' for: fps, frames.step, frames.offset, frames.min, frames.max, sizes.16:9, sizes.9:16, sizes.1:1, timeoutMin, audio.
 */
function deriveVideoBlock(graph, nodes, objectInfo) {
  graph = graph || {}; nodes = nodes || {};
  const info = objectInfo && typeof objectInfo === 'object' ? objectInfo : null;
  const from = {};
  const slot = (name) => (nodes[name] != null ? resolveSlot('video', name, nodes[name]) : null);
  const out = slot('output');
  const up = out && graph[out.node] ? upstreamIds(graph, out.node) : [];
  // fps: a CreateVideo upstream of the output first, then any node with a numeric fps input
  let fps = 16; from.fps = 'default';
  const fpsNode = up.find(id => graph[id].class_type === 'CreateVideo' && typeof (graph[id].inputs || {}).fps === 'number') || up.find(id => typeof (graph[id].inputs || {}).fps === 'number');
  if (fpsNode) { const n = graph[fpsNode].inputs.fps; if (n >= 1 && n <= 120) { fps = n; from.fps = 'graph'; } }
  // frame grid: the length field's INT spec in ComfyUI
  let step = 1, offset = 0, cmax = null; from['frames.step'] = from['frames.offset'] = 'default';
  const ls = slot('length'), lnode = ls && graph[ls.node];
  const meta = lnode && ls.field ? intMeta(inputSpec(info, lnode.class_type, ls.field)) : null;
  if (meta && isInt(meta.step) && meta.step >= 1) {
    step = meta.step; from['frames.step'] = 'comfyui';
    if (isInt(meta.min) && meta.min >= 0) { offset = meta.min % step; from['frames.offset'] = 'comfyui'; }
  }
  // the field's own limits count with or without a reported step (r3): max caps the clip, min raises the lowest grid value
  if (meta && isInt(meta.max) && meta.max >= 1) cmax = meta.max;
  let min = offset + step; from['frames.min'] = from['frames.step'];
  if (meta && isInt(meta.min) && meta.min > min) { min = offset + Math.ceil((meta.min - offset) / step) * step; from['frames.min'] = 'comfyui'; }
  // max: the grid value nearest to 5 s (decision 2), snapped onto the grid at or below the field's maximum ComfyUI reports, never below min
  let k = Math.round((5 * fps - offset) / step);
  if (cmax != null) k = Math.min(k, Math.floor((cmax - offset) / step));
  const max = Math.max(min, offset + k * step); from['frames.max'] = 'default';
  // sizes: the width/height the graph has -> 16:9 (or 9:16 if it is portrait), the swapped pair is exact, 1:1 is a guess (sqrt of the area)
  const sizes = {};
  const ws = slot('width'), hs = slot('height');
  const wv = ws && graph[ws.node] && ws.field ? (graph[ws.node].inputs || {})[ws.field] : undefined;
  const hv = hs && graph[hs.node] && hs.field ? (graph[hs.node].inputs || {})[hs.field] : undefined;
  if (isInt(wv) && isInt(hv) && wv >= 64 && hv >= 64 && wv <= 4096 && hv <= 4096) {
    const landscape = wv >= hv;
    sizes['16:9'] = landscape ? [wv, hv] : [hv, wv]; sizes['9:16'] = landscape ? [hv, wv] : [wv, hv];
    from['sizes.16:9'] = from['sizes.9:16'] = 'graph';
    const wm = intMeta(inputSpec(info, graph[ws.node].class_type, ws.field));
    const grid = Math.max(16, wm && isInt(wm.step) ? wm.step : 0);
    const sq = Math.min(4096, Math.max(64, Math.ceil(Math.sqrt(wv * hv) / grid) * grid));   // rounded UP onto the grid: Wan 631.95 -> 640, LTX 586.6 -> 592
    sizes['1:1'] = [sq, sq]; from['sizes.1:1'] = 'default';
  } else {
    sizes['16:9'] = [832, 480]; from['sizes.16:9'] = 'default';
  }
  // audio: a CreateVideo upstream of the output whose `audio` input is linked
  const audio = up.some(id => graph[id].class_type === 'CreateVideo' && isLink((graph[id].inputs || {}).audio)); from.audio = 'graph';
  from.timeoutMin = 'default';
  return { video: { fps, frames: { step, offset, min, max }, sizes, timeoutMin: 15, audio }, from };
}

/**
 * missingModelsForWorkflow(workflowObj, objectInfo) → [string]
 * Returns a de-duplicated array (first-seen order) of model filenames that are
 * referenced by the workflow JSON but not present in the ComfyUI /object_info response.
 * A model is considered missing iff it is NOT in collectEnumValues(objectInfo) — exact
 * enum membership only. No substring fallback: ComfyUI's own validation is exact enum
 * membership (value_not_in_list), so substring matching would produce false negatives
 * (e.g. ae.safetensors is a substring of flux2-vae.safetensors but is a distinct model).
 * checkDeps keeps a fallback for subfolder-prefixed enum values, but matches whole JSON string values only.
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

function withField(err, field) { if (field) err.field = field; return err; }

/**
 * addCustomWorkflow(entry, jsonText) → the saved registry entry (with id)
 * Validates, writes the JSON file, updates the registry.
 */
function addCustomWorkflow(entry, jsonText) {
  const { id, label, stage, nodes, deps } = entry;
  if (!/^[a-z0-9_]+$/.test(id)) {
    throw withField(new Error('Invalid id (use lowercase a-z, 0-9, _).'), 'id');
  }
  if (stage !== 'image' && stage !== 'mesh' && stage !== 'i2i' && stage !== 'video') {
    throw withField(new Error('stage must be "image", "mesh", "i2i" or "video".'), 'stage');
  }
  const { clean } = prepareWorkflowJson(jsonText);
  const vn = validateNodeMap(stage, nodes, clean);
  if (!vn.ok) throw withField(new Error(vn.error), vn.field);
  // AW1: a custom video entry MUST carry a valid video block (no silent LTX-2 fallback in framesFor)
  let videoBlock = null;
  if (stage === 'video') {
    const vv = validateVideoBlock(entry.video);
    if (!vv.ok) throw withField(new Error(vv.error), vv.field);
    videoBlock = vv.video;
    const cap = checkVideoCap(videoBlock, clean);
    if (cap) throw withField(new Error(cap.error), cap.field);
  }
  const reg = loadRegistry();
  if (reg.workflows[id]) {
    throw withField(new Error('A workflow with id "' + id + '" already exists. Pick another id (e.g. "' + id + '_2").'), 'id');
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
  // AW1 (decision 1): "verified" = shipped with Phoenix. Whatever a user adds stays unverified; the badge and the ③ marker (LC2d) read this.
  if (stage === 'video') { newEntry.video = videoBlock; newEntry.status = 'unverified'; }
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
 * fields = { label, nodes, deps, video } — any may be omitted (video: only for a video entry, validated like on add).
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
  if (!vm.ok) throw withField(new Error(vm.error), vm.field);
  let videoBlock = null;
  if (entry.stage === 'video' && fields.video !== undefined) {   // only an OMITTED block means unchanged; null is invalid -> 400
    const vv = validateVideoBlock(fields.video);
    if (!vv.ok) throw withField(new Error(vv.error), vv.field);
    videoBlock = vv.video;
    const cap = checkVideoCap(videoBlock, obj);
    if (cap) throw withField(new Error(cap.error), cap.field);
  }
  entry.label = (typeof fields.label === 'string' && fields.label.trim()) ? fields.label.trim() : entry.label;
  entry.nodes = nodes;
  entry.deps = {
    custom_nodes: (fields.deps && Array.isArray(fields.deps.custom_nodes)) ? fields.deps.custom_nodes.filter(x => typeof x === 'string') : (entry.deps && entry.deps.custom_nodes) || [],
    models:       (fields.deps && Array.isArray(fields.deps.models))       ? fields.deps.models.filter(x => typeof x === 'string')       : (entry.deps && entry.deps.models)       || [],
  };
  entry.builtin = false;
  if (videoBlock) entry.video = videoBlock;
  reg.workflows[id] = entry;
  saveRegistry(reg);
  return { id, ...entry };
}

module.exports = {
  DEFAULT_WORKFLOWS, WORKFLOWS_FILE, DEFAULT_ACTIVE, EXTRA_ACTIVE, defaultActive, DEFAULT_FIELDS, TESTED_PROFILES, testedProfileFor, exampleFor, envFromSystemStats,
  loadRegistry, saveRegistry, mergeMissingBuiltins, RETIRED_BUILTINS, workflowMeta, getActive, validateActivate, engineAvailability, dispatcherMode, hasDispatcher, resolveSlot, collectEnumValues, comboOptions, checkDeps,
  MODEL_INPUT_FIELDS, validateWorkflowJson, stripNonNodeKeys, prepareWorkflowJson,
  collectNodeChoices, collectModelCandidates, missingModelsForWorkflow,
  listClassTypes, validateNodeMap, REQUIRED_SLOTS, validateVideoBlock, deriveVideoBlock, isLtxGraph, checkVideoCap, pickVideoInstance, setVideoInstance, torchModern, addCustomWorkflow, deleteCustomWorkflow, updateCustomWorkflow,
  resolveWorkflowFile,
};
