# Mesh errors in preprocess — RGB image needs a background cutout (onnxruntime)

**Symptoms:** ComfyUI `execution_error` on node `Trellis2PreProcessImage_GGUF` ·
`IndexError: index 3 is out of bounds for axis 2 with size 3` · the mesh fails immediately (GPU blips,
then 0%) · no `.glb`, ComfyUI `/history` shows the prompt `status=error`.
**Applies to:** trellis · runtime
**Root cause:** with `remove_background: false`, the preprocess node expects the input image to already be
an **RGBA cutout** — it reads the alpha channel (index 3). But an SD1.5/Flux image is plain **RGB** (opaque
white background, 3 channels), so index 3 doesn't exist. `remove_background: true` (which makes the cutout
via rembg) had been turned off because **onnxruntime wasn't installed / crashed** the GPU variant.

## Fix — do it for me
1. Install **CPU** onnxruntime: `python_embeded\python.exe -s -m pip install onnxruntime`
   (CPU, NOT onnxruntime-gpu — the GPU one clashes with torch's CUDA DLLs → `0xC0000005` crash).
2. Set `"remove_background": true` in the mesh workflow (`workflows/trellis_phoenix.json`).
3. ⟳ restart ComfyUI. First mesh then pulls the rembg u2net model (~170 MB) once.

## Fix — explain it
The mesh needs the object cut out from its background (a transparency mask). Your image is a solid
photo with no transparency, so either you supply a pre-cut PNG, or you let Trellis cut it — which needs
onnxruntime. Install the CPU build (no GPU conflict) and turn background-removal on.

## Verify
ComfyUI `/history` last prompt `status=success`; the gen proceeds past preprocess into shape/texture;
a `.glb` lands in ComfyUI's output.

## Notes
The two failure modes are a pair: `remove_background:true` **without** onnxruntime → crash; `false` with an
RGB image → this IndexError. CPU onnxruntime resolves both. bg removal on CPU is a few seconds (tiny model).
`see also: trellis-first-mesh-timeout` (don't confuse a preprocess error with a download timeout).
