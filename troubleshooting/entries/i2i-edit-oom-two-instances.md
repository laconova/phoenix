# i2i edit OOMs — two ComfyUI instances share one GPU's VRAM

**Symptoms:** `CUDA out of memory` / `cudaMalloc` during an **i2i / Edit** run · a tile's **→ 3D**
button OOMs right after you edited it · an i2i edit times out (~10 min) naming a base like
`…8188` · mesh or the next image generation OOMs only *after* you used the Edit tab.
**Applies to:** i2i · vram
**Root cause:** an i2i setup often runs **two ComfyUI instances on one GPU** — Qwen-Image-Edit on the
"bild" instance, Trellis/Flux on the other — because they need incompatible CUDA/Python envs. They
**share the card's VRAM.** Qwen-Image-Edit (~9.8 GB) leaves the card near-full after an edit, so a
Trellis mesh or a Flux image loading on the other instance can't fit. Phoenix frees the *other*
instance before an i2i edit and before mesh/image (best-effort ComfyUI `/free`, gated by
`vram.freeComfyBeforeMesh`), but a node that refuses to unload, or a big card configured
`freeComfyBeforeMesh:false`, can still collide.

## Fix — do it for me
1. Leave the pre-run VRAM free ON — it defaults on and there is no key to add for it. Only if you have
   put a `vram` block in `phoenix-config.json` yourself, make sure `freeComfyBeforeMesh` is not set to
   `false` (on a 10 GB card it must stay on).
2. If it still OOMs, free the other instance by hand: `POST /free {"unload_models":true,"free_memory":true}`
   to the instance NOT running the current stage (e.g. the bild instance on :8188 before a mesh on :8000),
   or restart that ComfyUI.
3. Run one heavy stage at a time — don't fire a mesh while an edit is still finishing.

## Fix — explain it
One GPU, two tenants that each want most of it. The edit model and the mesh model never need to run at
the same instant, but the model stays resident on its instance after it finishes, and the *other*
instance can't see or reclaim that memory. Phoenix asks the idle instance to unload before each heavy
stage; when a model won't let go (a stuck node) the only cure is restarting that ComfyUI.

## Verify
`nvidia-smi --query-gpu=memory.used --format=csv,noheader` drops to ≲2 GB between stages · the edit
(or the →3D) completes with no `out of memory` line in the ComfyUI log.

## Notes
- **Single-instance users don't hit this.** One ComfyUI with all nodes = one process, one model at a
  time; there's nothing on a second port to collide. The risk is only when `endpoints.comfyui_bild` is set.
- See also: `mesh-oom-local-llm-resident.md` (the same 10 GB card, a *different* squatter — the local LLM).
