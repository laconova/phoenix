# Trellis o_voxel — small missing Python deps

**Symptoms:** `No module named 'plyfile'` · `'zstandard'` · `'easydict'` while importing `o_voxel`
(plain ModuleNotFound, not a compile error).
**Applies to:** trellis · install
**Root cause:** `o_voxel`'s pure-python dependencies aren't pulled — especially if the CUDA wheels were
installed with `--no-deps` (which we do, to protect the torch version).

## Fix — do it for me
`python_embeded\python.exe -s -m pip install plyfile zstandard easydict`
Then re-import and **loop** — if another `No module named 'X'` appears, install X and repeat.

## Fix — explain it
Small helper libraries the mesh code needs for reading `.ply` files, compression, and config objects.
They're harmless PyPI packages; install whatever it names until the import is clean.

## Verify
`import o_voxel` → OK (no traceback).

## Notes
Order matters: fix the compile/ABI traps first (`trellis-triton-python-h`, `trellis-torchaudio-abi`) —
a compile error can masquerade as this. These pure-python deps are the *last* layer.
