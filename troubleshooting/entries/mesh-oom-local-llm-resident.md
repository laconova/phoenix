# Mesh stage OOM — the local LLM is still sitting in VRAM

**Symptoms:** ComfyUI console: `Got an OOM, unloading all loaded models` during the mesh/`image_to_3d`
stage · mesh stage runs forever then times out while GPU shows ~full memory at 0% utilization ·
`nvidia-smi` shows an `.lmstudio/.internal/utils/node` process holding 6–9 GB.
**Applies to:** mesh · lmstudio · vram
**Root cause:** a local LLM seat (LM Studio JIT-load, Ollama, llama.cpp) keeps its model in VRAM after its
call (LM Studio's idle TTL only evicts after ~1 h). On a 10 GB card, Gemma-12B-Q4 (~8.6 GB with 8k context)
plus Trellis cannot coexist → the mesh job OOMs.
**Since 1.9.0 Phoenix tries to do this for you (best effort):** before an image or mesh stage it asks the local
server to unload the model (LM Studio, Ollama, or a llama.cpp router server). Only for the llama.cpp router does it
wait until the model is gone; for LM Studio and Ollama it does not confirm, and if unloading fails the job still
runs. If you still see this, the unload did not work (server not reachable, a plain `llama-server` without an unload command — Phoenix never
kills a process it did not start — or a model loaded by another program), so the manual steps below are the fallback.

## Fix — do it for me
1. Free the VRAM: `lms unload --all` (add `~/.lmstudio/bin` to PATH if `lms` is not found).
2. Confirm: `nvidia-smi --query-gpu=memory.used --format=csv,noheader` → should drop to ≲1.5 GB
   (ComfyUI idle + desktop).
3. Re-run the mesh stage. It now has the whole card.

## Fix — explain it
Two GPU tenants, one 10 GB card: the prompt-writing LLM and the 3D generator each want most of it.
They never need to run at the same moment — the prompt is finished before the mesh starts — but
LM Studio keeps the model warm long after its last call. Phoenix now asks it to unload before heavy
stages (best effort); when that does not work (see above), unload manually between "prompt work" and "mesh work".

## Verify
`lms ps` → no LLM listed (or STATUS not loaded) · mesh stage completes; ComfyUI log ends with
`Prompt executed in …` and no OOM line.

## Notes
- The image stage usually survives (SD1.5 is small); it's the **mesh** stage that collides.
- LM Studio's TTL (~1 h) will *eventually* free it — never soon enough for a pipeline run.
- Automatic, best effort: Phoenix asks LM Studio / Ollama / llama.cpp-router to unload before image and mesh stages (the manual
  `lms unload --all` is the fallback).
