# ComfyUI crashes at startup after a torch change — WinError 127 (torchaudio ABI)

**Symptoms:** `OSError: [WinError 127]` / `Die angegebene Prozedur wurde nicht gefunden` ·
`torch.ops.load_library(...)` in the traceback · ComfyUI exits with code 1 during startup, right
after you changed the torch version · traceback passes through `torchaudio` (or `torchvision`).
**Applies to:** trellis · install (collateral of a torch downgrade)
**Root cause:** you changed `torch` but left `torchaudio`/`torchvision` at their old build. Their
compiled `.dll` expects the OLD torch's C++ symbols → "procedure not found". ComfyUI **hard-imports
torchaudio at startup**, so it can't even boot.

## Fix — do it for me
Reinstall the audio/vision siblings to match torch, from the same CUDA index:
`torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu126`
(and `torchvision==0.21.0` if it wasn't already realigned). ⟳ restart ComfyUI.

## Fix — explain it
`torch`, `torchvision`, and `torchaudio` are one matched set built against each other. If you move
one, move all three to the same version. You bumped torch but not torchaudio, so ComfyUI can't load it.

## Verify
`import torch, torchaudio, torchvision` all print the same `X.Y.Z+cu126`; ComfyUI reaches "Starting server".

## Notes
**Rule: never change `torch` alone** — always update torchvision + torchaudio in the same command.
This was the LAST crash before Trellis loaded. `see also: trellis-torch-too-new`.
