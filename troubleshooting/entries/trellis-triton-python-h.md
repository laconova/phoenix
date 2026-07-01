# Trellis triton JIT fails — Python.h not found

**Symptoms:** `include file 'Python.h' not found` · triton `tcc.exe ... returned non-zero exit status 1`
· `import flex_gemm` or `import o_voxel` fails during a compile step (not a plain ModuleNotFound).
**Applies to:** trellis · install
**Root cause:** `o_voxel`/`flex_gemm` JIT-compile a small triton launcher at import via triton's bundled
`tcc` compiler, which `#include`s `Python.h` and links `python3.lib`. ComfyUI's **embedded** Python
ships **without** dev headers (`Include/Python.h`) or `libs/` — so the compile fails.

## Fix — do it for me
Add CPython headers+libs matching the embedded python's version into `python_embeded`:
1. Download the official CPython nupkg for the exact minor (e.g. `python.3.13.12.nupkg` from nuget).
2. It's a zip: copy `tools/include/*` → `python_embeded\Include\` and `tools/libs/*` → `python_embeded\libs\`
   (use robocopy — it copies without deleting).

## Fix — explain it
Those two GPU libs compile a tiny helper the first time they're imported, and that compile needs the
Python C headers. The slimmed-down embedded Python doesn't include them. Drop the matching Python
headers and `.lib` files in and the compile succeeds (and caches).

## Verify
`Test-Path python_embeded\Include\Python.h` and `...\libs\python3.lib` → True; `import o_voxel, flex_gemm` → OK.

## Notes
Headers MUST match the embedded python's minor version (check `python.exe --version`). This is a
one-time fix that also unblocks any other triton-JIT node. `see also: trellis-small-python-deps`.
