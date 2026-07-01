# Trellis install.py grabs the Linux wheel on Windows

**Symptoms:** the node's `install.py` prints `Found matching wheel: ...manylinux_2_35_x86_64.whl` on a
Windows box · "wheel not supported on this platform" · the CUDA libs never actually install.
**Applies to:** trellis · install
**Root cause:** `install.py`'s `find_wheel_url` uses a wildcard for the platform tag and returns the
**first** match, which is the `manylinux` (Linux) build of the same filename — not `win_amd64`.

## Fix — do it for me
Install the correct Windows wheels directly. Put the 6 URLs in a requirements file and:
`python_embeded\python.exe -s -m pip install --no-deps -r trellis-win-wheels.txt`
(the wheels: cumesh, o_voxel, flex_gemm, nvdiffrast, nvdiffrec_render, flash_attn — each
`...+cu126torch2.6-cp313-cp313-win_amd64.whl`). `--no-deps` protects your torch.

## Fix — explain it
The installer picked the Linux version of each GPU wheel. You need the Windows (`win_amd64`) build of
the same file. Take the URL it found and swap `manylinux_2_35_x86_64` → `win_amd64`, and install those.
Find them at `https://pozzettiandrea.github.io/cuda-wheels/<lib>/`.

## Verify
`pip list` shows `cumesh 0.0.1+cu126torch2.6` etc.; `import cumesh, o_voxel, flex_gemm, nvdiffrast` OK.

## Notes
The GitHub URLs contain `%2B` (an encoded `+`). Put them in a `.txt` and use `pip install -r` — in a
`.bat` a raw `%2B` gets eaten by cmd's `%var%` expansion. `see also: trellis-triton-python-h`,
`trellis-small-python-deps` (o_voxel needs more after this).
