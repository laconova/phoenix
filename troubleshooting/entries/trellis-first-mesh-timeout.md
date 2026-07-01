# First mesh "times out" — it's downloading the Trellis models

**Symptoms:** `mesh stage failed: ComfyUI timed out after 10 min — check the UI` on the **first**
`image_to_3d` · the GPU sits at ~0% while it "runs" · the ComfyUI console shows
`[ModelManager] Downloading shape/....gguf` / `decoders/....gguf` (752 MB, 904 MB, …).
**Applies to:** trellis · runtime (first run only)
**Root cause:** the first mesh generation triggers a **one-time download of the Trellis GGUF model set**
(several GB). On a slow link that download outlasts the mesh poll timeout, so Phoenix gives up even
though nothing is stuck — ComfyUI is just still pulling files. GPU at 0% = network-bound, not hung.

## Fix — do it for me
1. The mesh timeout was raised to **30 min** (`comfyPoll(promptId, 1800000)` in `phoenix.js`) so a gen
   can ride through a tail-end download. (Engine is spawned per-gen, so it's live on the next gen — no
   server restart needed.)
2. But the surest path: **let ComfyUI finish the model download once** — watch its console until every
   file logs `Completed!` — then run the mesh. With models cached it generates in minutes.

## Fix — explain it
It's a one-time model download, not a failure. Let ComfyUI finish pulling the Trellis models (watch the
download bars in its window), then generate — from then on the models are on disk and it's fast.

## Verify
GPU utilisation jumps above 0% (it's now computing, not downloading); the mesh finishes and a `.glb`
lands in the output/staging folder.

## Notes
On a metered/slow link (a mobile hotspot, say) the one-time pull can be tens of minutes. Best UX would be a
dedicated "download Trellis models" pre-step so the first *gen* never includes the download — noted as
a future improvement. `see also: comfyui-port-8188` (make sure it timed out on download, not a dead port).
