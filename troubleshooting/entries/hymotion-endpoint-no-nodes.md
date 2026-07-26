# Text→motion does nothing (wrong ComfyUI / HY nodes missing)

**Symptoms:** "Describe a new motion…" fails immediately · `has no HY-Motion nodes` · the job is
rejected with a node-type error naming `HYMotionGenerate` / `HYMotionLoadNetwork` · preflight prints
`[WARN] HY-Motion (text→motion) — ... NOT REACHABLE` · everything *else* in Phoenix generates fine.
**Applies to:** hy-motion · setup
**Root cause:** `hyMotion.api` points at a ComfyUI that does not have **`ComfyUI-HY-Motion1`** in
`custom_nodes` (plus the weights under `models/HY-Motion/`). What decides this is **whether the nodes
are installed there — not which port it runs on.** Both settings ship pointing at `localhost:8188`,
so if you installed HY-Motion into the ComfyUI you already use for images and meshes, you are done.
If HY-Motion lives in a *second* ComfyUI, or on another machine, `hyMotion.api` has to say so.

## Fix — do it for me
1. Find the ComfyUI that actually has the HY-Motion nodes, and confirm it answers:
   ```bash
   curl http://<host>:8188/object_info/HYMotionGenerate
   ```
   A JSON object back = right server. `{}` or 404 = that install does not have the nodes.
2. Set it in `phoenix-config.json`:
   ```json
   "hyMotion": { "api": "http://localhost:8188" }
   ```
   Use the machine's address (e.g. `http://gpu-box.local:8188`) if generation runs on a separate GPU box.
3. Restart the Phoenix server. ⟳ restart + refresh.
4. Re-run `node preflight.js` — the HY-Motion line should turn `[PASS]`.

If the nodes are genuinely missing: install `ComfyUI-HY-Motion1` into that ComfyUI's `custom_nodes/`
and fetch the HY-Motion weights, then restart ComfyUI.

## Fix — explain it
There are two settings because the two jobs can live apart, not because they must. One ComfyUI with
the HY nodes installed serves both perfectly well — that is the default. A second install only makes
sense if you want to keep HY-Motion's several-GB models and its environment separate, or if
generation runs on a different machine. So the question is never "which port should this be", it is
"does the ComfyUI at this address have the HY-Motion nodes".

## Verify
`node preflight.js` → `[PASS] HY-Motion (text→motion) — <url> reachable, HY nodes present`.
Then generate a 2-second clip; it should start and report elapsed time rather than fail instantly.

## Notes
Text→motion is **optional**. Preflight reports it as a WARN and deliberately leaves it out of the
`n/4 checks passed` count, so a Phoenix without HY-Motion still reads as healthy. Generation is slow
by nature (~4 min for 6 s of motion) — a long wait is not a failure; Phoenix stays usable meanwhile.
Not to be confused with `entries/comfyui-port-8188.md`, which is about the **image/mesh** endpoint
(`endpoints.comfyui`) naming a different port than the ComfyUI it should reach.
