# Mesh stage OOM — the local LLM is still sitting in VRAM

**Symptoms:** ComfyUI console: `Got an OOM, unloading all loaded models` during the mesh/`image_to_3d`
stage · mesh stage runs forever then times out while GPU shows ~full memory at 0% utilization ·
`nvidia-smi` shows an `.lmstudio/.internal/utils/node` process holding 6–9 GB.
**Applies to:** mesh · lmstudio · vram
**Root cause:** the metaprompter's call **JIT-loads the local LLM into VRAM and leaves it there**
(LM Studio's idle TTL only evicts after ~1 h). On a 10 GB card, Gemma-12B-Q4 (~8.6 GB with 8k context)
plus Trellis cannot coexist → the mesh job OOMs. The eject-before-heavy-stage logic does not cover
this path (found live on the rig 2026-07-02).

## Fix — do it for me
1. Free the VRAM: `lms unload --all` (add `~/.lmstudio/bin` to PATH if `lms` is not found).
2. Confirm: `nvidia-smi --query-gpu=memory.used --format=csv,noheader` → should drop to ≲1.5 GB
   (ComfyUI idle + desktop).
3. Re-run the mesh stage. It now has the whole card.

## Fix — explain it
Two GPU tenants, one 10 GB card: the prompt-writing LLM and the 3D generator each want most of it.
They never need to run at the same moment — the prompt is finished before the mesh starts — but
LM Studio keeps the model warm long after its last call. Until Phoenix ejects automatically before
heavy stages (planned; same problem the Forge VRAM-lock solves system-wide), unload manually between
"prompt work" and "mesh work".

## Verify
`lms ps` → no LLM listed (or STATUS not loaded) · mesh stage completes; ComfyUI log ends with
`Prompt executed in …` and no OOM line.

## Notes
- The image stage usually survives (SD1.5 is small); it's the **mesh** stage that collides.
- LM Studio's TTL (~1 h) will *eventually* free it — never soon enough for a pipeline run.
- Long-term fix = Phoenix ejects before mesh dispatch / loads the metaprompter with a short TTL;
  system-wide fix = the Forge VRAM booking lock.
