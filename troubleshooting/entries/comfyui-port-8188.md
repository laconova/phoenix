# ComfyUI port mismatch (Phoenix can't reach ComfyUI)

**Symptoms:** Phoenix says it can't reach ComfyUI · a gen never starts / image tab stays empty ·
connection refused on the configured port (`:8188`, or `:8000` from an older config) while the
ComfyUI window is clearly running.
**Applies to:** comfyui · runtime
**Root cause:** `endpoints.comfyui` does not name the port ComfyUI is actually listening on. Since
1.6.0 Phoenix ships pointing at **8188**, which is ComfyUI's own default — so this now bites the other
way round: a ComfyUI started with `--port 8000` (or a config carried over from an older Phoenix)
no longer meets it. Either way the two numbers simply have to be equal.

## Fix — do it for me
1. Find the port ComfyUI is really on — it prints it at startup
   (`To see the GUI go to: http://127.0.0.1:8188`), and it is in the browser URL you use for ComfyUI.
2. Put that exact URL in `endpoints.comfyui` in `phoenix-config.json`, e.g. `http://localhost:8188`.
3. Restart the Phoenix server (config is read at startup). ⟳ restart + refresh.

*(Alternative: start ComfyUI on the port Phoenix expects — `python main.py --port 8188` — and leave
the config alone.)*

## Fix — explain it
Phoenix talks to ComfyUI over HTTP at whatever URL is in `endpoints.comfyui`. ComfyUI is just
listening on a different port than Phoenix expects. Either move Phoenix to ComfyUI's port, or start
ComfyUI on Phoenix's port. Pick one and keep them equal.

## Verify
`curl http://127.0.0.1:<port>/system_stats` → HTTP 200, and `node preflight.js` turns the ComfyUI
line to `[PASS]`. A Phoenix image generation now reaches ComfyUI.

## Notes
Config change needs a server restart. #1 cause of "everything's installed but nothing generates."

⚠️ This entry is about the **image/mesh** endpoint (`endpoints.comfyui`). Text→motion has its own
setting, `hyMotion.api`, which may point at the same ComfyUI or a different one — what matters there
is whether the HY-Motion nodes are installed, not the port. See `entries/hymotion-endpoint-no-nodes.md`.
