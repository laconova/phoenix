# ComfyUI port mismatch (Phoenix can't reach ComfyUI)

**Symptoms:** Phoenix says it can't reach ComfyUI · a gen never starts / image tab stays empty ·
connection refused on :8000 while the ComfyUI window is clearly running.
**Applies to:** comfyui · runtime
**Root cause:** the portable's `run_nvidia_gpu.bat` starts ComfyUI on its default **8188**, but Phoenix
defaults to **8000**. They never meet.

## Fix — do it for me
1. Point Phoenix at the running port: set `endpoints.comfyui` in `phoenix-config.json` to
   `http://localhost:8188` (or whatever port ComfyUI is on).
2. Restart `server.bat` (the server caches config at startup). ⟳ restart + refresh.

*(Alternative: relaunch ComfyUI on 8000 — `python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --port 8000` — and leave Phoenix at 8000.)*

## Fix — explain it
Phoenix talks to ComfyUI over HTTP at whatever URL is in `endpoints.comfyui`. ComfyUI is just
listening on a different port than Phoenix expects. Either move Phoenix to ComfyUI's port, or start
ComfyUI on Phoenix's port. Pick one and keep them equal.

## Verify
`curl http://127.0.0.1:8188/system_stats` → HTTP 200; a Phoenix image gen now reaches ComfyUI.

## Notes
Config change needs a server restart. #1 cause of "everything's installed but nothing generates."
