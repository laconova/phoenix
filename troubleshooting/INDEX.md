# Troubleshooting Index — symptom → entry

The troubleshooter loads ONLY this file. Match the user's symptom / error string to a row, then read
that ONE entry from `entries/`. Keys are exact substrings you'll see in errors, logs, or the UI.

| Symptom / error string (match on any) | Entry |
|---|---|
| Phoenix "Can't reach ComfyUI" · connection refused :8000 · port 8188 vs 8000 mismatch · gen never starts · image tab empty | `entries/comfyui-port-8188.md` |
| `No module named 'cumesh'` · `No module named 'triton'` · Trellis nodes missing from the menu · `IMPORT FAILED ...Trellis2-GGUF` | `entries/trellis-torch-too-new.md` |
| `install.py` picked a `manylinux`/`...linux_x86_64.whl` · "wheel not supported on this platform" · cumesh imports but node fails on load | `entries/trellis-linux-wheel-on-windows.md` |
| `include file 'Python.h' not found` · triton `tcc.exe ... returned non-zero exit status 1` · `import flex_gemm`/`o_voxel` fails on compile | `entries/trellis-triton-python-h.md` |
| `WinError 127` · `Die angegebene Prozedur wurde nicht gefunden` · `torch.ops.load_library` fails · ComfyUI exits at startup after a torch change | `entries/trellis-torchaudio-abi.md` |
| `No module named 'plyfile'` · `'zstandard'` · `'easydict'` while importing o_voxel | `entries/trellis-small-python-deps.md` |
| `UNKNOWN: unknown error, open '...\workflows\....json'` · `open 'Z:\` · `open 'E:\` · wrong drive letter in a path · "missing models for workflow Flux Klein" on a machine that should use sd15 | `entries/phoenix-workflow-stale-path.md` |
| `Trellis2PreProcessImage_GGUF` · `IndexError: index 3 is out of bounds for axis 2 with size 3` · mesh errors instantly in ComfyUI · `remove_background` / RGB vs RGBA / onnxruntime · `0xC0000005` | `entries/trellis-preprocess-rgb-alpha.md` |
| `timed out after 10 min` on the mesh/`image_to_3d` stage · GPU at 0% while "generating" · ComfyUI console shows `Downloading ...gguf` · first mesh only | `entries/trellis-first-mesh-timeout.md` |
| `empty POSITIVE` · "you wrote 'are'" · metaprompter/orchestrator reply is a "your message got cut off" · `--stage image requires --desc` for a real request | `entries/phoenix-empty-positive.md` |
| Started generation for `"undefined"` · generate fired with no subject | `entries/phoenix-empty-positive.md` (see Notes) |
| `dlopen(): error loading libfuse.so.2` · "AppImages require FUSE to run" · `Timed out waiting for LM Studio daemon` · `lms bootstrap` "Cannot find LM Studio installation" · LM Studio won't start on Linux / over SSH · preflight LM Studio absent (Linux) | `entries/lmstudio-linux-appimage.md` |
| `Got an OOM, unloading all loaded models` (ComfyUI, mesh stage) · GPU ~full at 0% util · `.lmstudio/.internal/utils/node` holding 6–9 GB in `nvidia-smi` | `entries/mesh-oom-local-llm-resident.md` |
| `Stage error: ENOENT ... scandir '.../ComfyUI/output'` after a mesh run · ComfyUI says `Prompt executed` but Phoenix reports stage failed · `.glb` exists only in ComfyUI's own output/ | `entries/phoenix-comfy-output-path.md` |
| Installing on **Linux** (any step) · `sudo: a password is required` · `ensurepip is not available` · venv has no pip · no-root install · which Python for image vs mesh (3.11 vs 3.12 split) · Ubuntu setup from scratch | `linux-troubleshoot.md` (umbrella — Linux install recipe + Linux-specific traps) |

**Not here?** It's a new trap → after solving it, add a row above + an entry (keep the entry format).
