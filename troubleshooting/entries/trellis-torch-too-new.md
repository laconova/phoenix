# Trellis node won't load — ComfyUI torch/CUDA too new

**Symptoms:** `No module named 'cumesh'` / `'triton'` in the ComfyUI log · Trellis2 nodes missing from
the node menu · `IMPORT FAILED ...ComfyUI-Trellis2-GGUF`.
**Applies to:** trellis · install
**Root cause:** the Trellis node loads compiled CUDA extensions whose **prebuilt wheels** are keyed to
a specific torch+cuda. The wheel repo tops out around **torch 2.10 / CUDA 12.6**. If the ComfyUI
portable is newer (we hit **torch 2.12 / CUDA 13.0**), every wheel 404s and the node fails to import.
cp313 **Windows** wheels exist — only torch/cuda were too new. (It ran on Windows before; just match versions.)

## Fix — do it for me
1. Stop ComfyUI (torch DLLs can't be replaced while it runs).
2. Align torch: `torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu126`.
   Also realign **torchaudio==2.6.0** (`see also: trellis-torchaudio-abi`).
3. Fetch the CUDA wheels — but the node's `install.py` grabs the wrong platform
   (`see also: trellis-linux-wheel-on-windows`), so install the **win_amd64** wheels directly.
4. Give the embedded python headers so triton can JIT (`see also: trellis-triton-python-h`).
5. Small deps: plyfile, zstandard, easydict (`see also: trellis-small-python-deps`).
6. ⟳ restart ComfyUI.

## Fix — explain it
The mesh node ships prebuilt GPU code built against a specific PyTorch. Your ComfyUI is a newer
PyTorch than that code was built for, so it can't load. Downgrade PyTorch to a version the node
supports (2.6 + CUDA 12.6), then install the node's matching GPU wheels.

## Verify
`import cumesh, triton` → OK; ComfyUI log shows `N seconds: ...Trellis2-GGUF` (not IMPORT FAILED);
`Trellis2*_GGUF` nodes appear in `/object_info`.

## Notes
This is the umbrella trap — it cascades into the 4 `see also` entries. One-time downloads: ~2.5 GB
torch + ~2.5 GB TRELLIS.2-4B model on first mesh gen. Keep the portable ≤ torch2.10/cu126 for Trellis.
