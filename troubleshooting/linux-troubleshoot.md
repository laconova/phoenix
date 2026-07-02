# Phoenix on Linux — setup & troubleshooting (umbrella)

The rest of this library was written against the **Windows** portable (WinError 127, `win_amd64`
wheels, `python_embeded`, drive letters). This file is the **Linux** counterpart: a from-scratch,
**no-root** install recipe plus the traps that are specific to Linux. Verified on **Ubuntu 24.04.4**,
**RTX 3080 (10 GB)**, driver **595.71.05**, no `sudo` rights.

**Applies to:** comfyui · blender · lmstudio · install · linux
**Golden rule discovered here:** the **image** stack (SD 1.5 / Flux 2 Klein) and the **mesh** stack
(Trellis 2 GGUF) want **different, mutually incompatible Python/torch/CUDA versions**. Don't try to
serve both from one venv. See "The Python 3.11 vs 3.12 split" below — it's the single most important
fact on Linux.

---

## 0. Environment constraints on this box

**Symptoms:** `sudo: a password is required` · `No module named pip` · venv creation dies with
`ensurepip is not available ... install python3.12-venv`.
**Root cause:** no interactive `sudo`, and the system Python has neither `pip` nor the
`python3.12-venv` (ensurepip) package. Anything that reaches for `apt`/`snap` is dead on arrival.

**Fix — do it for me (all no-root):**
- **Never use apt/snap.** Use portable installs only: tarballs, AppImages, and venvs.
- **venv without ensurepip:** create with `--without-pip`, then bootstrap pip by hand:
  ```bash
  python3 -m venv venv --without-pip
  curl -sS https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
  ./venv/bin/python /tmp/get-pip.py
  ```
- For a **different** Python (e.g. 3.11, see Trellis) install `uv` — a single user-space binary,
  no root — and let it fetch a standalone CPython:
  ```bash
  curl -LsSf https://astral.sh/uv/install.sh | sh     # installs to ~/.local/bin
  uv python install 3.11
  ```

**Verify:** `./venv/bin/python -m pip --version` prints a pip version.

---

## 1. What's installed on this machine (reproducible recipe)

All under `~` — nothing needs root.

| Component | Version | Location | Launch |
|---|---|---|---|
| ComfyUI | 0.27.0 | `~/ComfyUI` (venv `~/ComfyUI/venv`) | `~/ComfyUI/venv/bin/python ~/ComfyUI/main.py --port 8000` |
| Blender | 5.1.2 | `~/apps/blender/` | `~/apps/blender/blender` |
| LM Studio | 0.4.18 | `~/apps/LM-Studio.AppImage` | `~/apps/LM-Studio.AppImage` |

- **Blender** = the official `blender-5.1.2-linux-x64.tar.xz` from
  `https://download.blender.org/release/Blender5.1/`, extracted to `~/apps/blender`. No install step.
- **LM Studio** = AppImage from `https://installers.lmstudio.ai/linux/x64/0.4.18-1/LM-Studio-0.4.18-1-x64.AppImage`,
  `chmod +x`. FUSE is present so it runs directly. (URL format: `.../linux/x64/<ver>/LM-Studio-<ver>-x64.AppImage`;
  probe with `curl -sI` — a real build returns `application/octet-stream ~1 GB`, a bad version returns 404.)
- **ComfyUI (current, image-only venv)** = Python 3.12 + `torch 2.12.1+cu130`. `cuda.is_available()` → True,
  sees the RTX 3080. See §5 for why this venv **cannot** run Trellis.

---

## 2. ComfyUI must listen on :8000, not :8188

**Symptoms:** Phoenix "can't reach ComfyUI"; `curl :8000/system_stats` refused while ComfyUI is up.
**Root cause:** ComfyUI defaults to **8188**; Phoenix's `endpoints.comfyui` defaults to **8000**.
**Fix:** launch ComfyUI with `--port 8000` (what we do), *or* set `endpoints.comfyui` to `:8188`.
Keep them equal. `see also: comfyui-port-8188.md` (the Windows twin of this trap).
**Verify:** `curl http://127.0.0.1:8000/system_stats` → HTTP 200, then `node preflight.js` shows
`[PASS] ComfyUI`.

---

## 3. Image models — sources & exact target paths (VERIFIED, downloaded)

These are **not** auto-downloaded; place the files yourself. Both workflows shipped in
`workflows/` reference these exact filenames.

### SD 1.5 (`workflows/sd15_txt2img.json`) — the easy, guaranteed path
- File: `v1-5-pruned-emaonly-fp16.safetensors` (~2 GB) → `~/ComfyUI/models/checkpoints/`
- Source (open, ungated):
  `https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors`
- All-native nodes. Works on the current Python 3.12/cu130 venv. Config defaults `workflows.image` to `sd15`.

### Flux 2 Klein (`workflows/flux2_klein_txt2img.json`) — higher quality, ~16 GB
All three files live in ONE **open** Comfy-Org repo (the ComfyUI split mirror — **not** the gated
`black-forest-labs/FLUX.2-*` repos, which 401 without a license token):
`https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/...`

| Workflow wants (node) | Repo path | Put in |
|---|---|---|
| `flux-2-klein-base-4b.safetensors` (UNETLoader) | `split_files/diffusion_models/flux-2-klein-base-4b.safetensors` | `~/ComfyUI/models/diffusion_models/` |
| `qwen_3_4b.safetensors` (CLIPLoader, type `flux2`) | `split_files/text_encoders/qwen_3_4b.safetensors` | `~/ComfyUI/models/text_encoders/` |
| `flux2-vae.safetensors` (VAELoader) | `split_files/vae/flux2-vae.safetensors` | `~/ComfyUI/models/vae/` |

Flux 2 uses **native** ComfyUI nodes (`EmptyFlux2LatentImage`, `Flux2Scheduler`, `CFGGuider`) — no
custom node needed, just a recent ComfyUI (0.27.0 is fine). Runs on the current venv.

**Verify:** in ComfyUI `curl :8000/object_info` lists the loaders; a Phoenix image gen produces a PNG.

---

## 4. Metaprompter routing — LM Studio is optional with the default config

**Root cause / fact:** `phoenix.js:271` → `const isLocal = !/^claude/i.test(GEMMA_MODEL)`. If the
metaprompter seat's model **starts with `claude`**, the metaprompt runs through the **Claude CLI**, and
LM Studio is never touched. The default config uses `claude-haiku-4-5-20251001`, so:
- `[FAIL] Local LLM` in `preflight.js` is **harmless** here — nothing uses `:1234`.
- LM Studio only matters if you switch the metaprompter seat to a local model (e.g. a Gemma). Then
  start LM Studio, load that model (or enable JIT), and point `endpoints.local` at its `/v1`.

---

## 5. ★ The Python 3.11 vs 3.12 split (the big one) ★

**Symptoms (if you ignore this):** `No module named 'cumesh'` / `'triton'` · `IMPORT FAILED
...ComfyUI-Trellis2-GGUF` · Trellis nodes absent from `/object_info` · pip resolver fights over
`transformers` versions.

**Root cause:** the mesh node's compiled CUDA extensions ship as **pre-built `cp311` wheels**
(`cumesh`, `nvdiffrast`, `flex-gemm`, `o-voxel`, `nvdiffrec-render`, `flash-attn`). They require:
- **Python 3.11** (not 3.12 — 3.12 has no matching wheels and building from source is brutal), and
- **torch on CUDA 12.4** (the wheel set tops out around torch 2.6–2.10 / cu124–cu126; **torch 2.12 /
  cu130 is too new** and every wheel 404s — this is the Windows umbrella `trellis-torch-too-new.md`
  reproduced on Linux).

Additionally the node pins `transformers==5.2.0` in its `requirements.txt`, which **conflicts** with
the `transformers 5.12.1` that stock ComfyUI pulls. → hard evidence these two stacks can't share a venv.

**Consequence / decision:**
- The **current** `~/ComfyUI/venv` (Python 3.12 + torch 2.12/cu130) is the **image** venv: SD 1.5 and
  Flux 2 Klein only. It will **never** run Trellis.
- To get the **mesh** stage you build a **second, isolated** ComfyUI environment on **Python 3.11 +
  torch cu124**. Model files (§3) are venv-independent and carry over — nothing re-downloaded.

Keep the two apart. Easiest is a whole separate ComfyUI checkout+venv (e.g. `~/ComfyUI-trellis`) so
the image setup you already have keeps working while you fight the mesh build.

---

## 6. Trellis 2 (mesh) on Linux — VERIFIED WORKING recipe

Canonical node: **`https://github.com/Aero-Ex/ComfyUI-Trellis2-GGUF`** (ships `install.py` +
`requirements.txt`). Best written Linux walkthrough: `github.com/LsM97/comfyui-trellis2-gguf-guide`.
The exact combo that worked here: **Python 3.11.15 · torch 2.5.1+cu124 · triton 3.2.0 · cp311
manylinux prebuilt wheels** from the `pozzettiandrea.github.io/cuda-wheels/` index. All prebuilt —
**no `nvcc`/compiler needed** (which matters: we can't `apt install` a CUDA toolkit).

Build it as a **second, isolated** ComfyUI (`~/ComfyUI-trellis`) that becomes THE ComfyUI on :8000
(it also serves SD/Flux images — see §6.4). Steps in the order that actually worked:

```bash
# 6.1  Python 3.11 + fresh ComfyUI
uv python install 3.11
git clone https://github.com/comfyanonymous/ComfyUI.git ~/ComfyUI-trellis
cd ~/ComfyUI-trellis
uv venv --python 3.11 venv

# 6.2  torch — PIN 2.5.1 EXACTLY (do NOT install "latest": on cu124 that gives 2.6.0, and the
#      node's CUDA wheels are tagged cu124torch2.5). install.py itself recommends this combo.
uv pip install --python venv/bin/python \
   torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124
uv pip install --python venv/bin/python -r requirements.txt
uv pip install --python venv/bin/python pip setuptools wheel packaging   # install.py falls back to `python -m pip`; uv venvs have no pip

# 6.3  the node + its prebuilt CUDA wheels
git clone https://github.com/Aero-Ex/ComfyUI-Trellis2-GGUF.git custom_nodes/ComfyUI-Trellis2-GGUF
./venv/bin/python custom_nodes/ComfyUI-Trellis2-GGUF/install.py     # --dry-run first to preview wheel URLs

# 6.4  ★ GOTCHA 1 — install.py's `pip install -r requirements.txt` has an UNPINNED `torch`, so it
#      silently upgrades you back to torch 2.12+cu130 from PyPI. Symptom afterwards:
#         ImportError: .../cumesh/_C...so: undefined symbol: _ZN3c106detail23torchInternalAssertFail...
#      (classic ABI mismatch). FIX: re-pin torch immediately after install.py:
uv pip install --python venv/bin/python \
   torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124

# 6.5  ★ GOTCHA 2 — flex_gemm needs triton 3.2.0, but torch 2.5.1 ships triton 3.1.0. Symptom:
#         TypeError: Autotuner.__init__() takes from 7 to 13 positional arguments but 14 were given
#      (also fires when importing nvdiffrec_render / o_voxel, which import flex_gemm). FIX — bump triton;
#      the pip "torch 2.5.1 requires triton==3.1.0" warning is harmless, it works:
./venv/bin/pip install "triton==3.2.0"

# 6.6  background removal + supporting nodes (these can also drag torch — re-check after)
./venv/bin/pip install "rembg[gpu]" onnxruntime-gpu gguf
git clone https://github.com/1038lab/ComfyUI-RMBG.git custom_nodes/ComfyUI-RMBG && ./venv/bin/pip install -r custom_nodes/ComfyUI-RMBG/requirements.txt
git clone https://github.com/city96/ComfyUI-GGUF.git custom_nodes/ComfyUI-GGUF && ./venv/bin/pip install -r custom_nodes/ComfyUI-GGUF/requirements.txt

# 6.7  sanity check BEFORE launching — all six must import with NO undefined-symbol / Autotuner error:
./venv/bin/python -c "import torch,cumesh,o_voxel,flex_gemm,nvdiffrast,nvdiffrec_render,flash_attn; print(torch.__version__,'OK')"
#   → 2.5.1+cu124 OK

# 6.8  launch on Phoenix's port (expandable_segments helps the 10 GB card avoid OOM)
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True ./venv/bin/python main.py --port 8000
```

**Golden rule for this whole section:** after *every* `pip install` that isn't torch itself,
assume something may have moved torch. Re-pin (6.4) and re-run the import check (6.7) until it's clean.

### 6.a  Share the image models (don't re-download SD/Flux)
Drop `~/ComfyUI-trellis/extra_model_paths.yaml` pointing `base_path` at `~/ComfyUI/models`
(checkpoints / diffusion_models / text_encoders / vae / …). Verified: SD 1.5, `flux-2-klein-base-4b`,
`flux2-vae` then appear in this instance's `/object_info`. So ONE ComfyUI on :8000 does image **and**
mesh — which is what Phoenix expects. Stop the old py3.12 ComfyUI first (`pkill -f "ComfyUI/main.py"`)
so :8000 is free.

### 6.b  Verified result
Boot log shows `1.5 seconds: .../ComfyUI-Trellis2-GGUF` (NOT `IMPORT FAILED`) and
`[Trellis2] Using native ComfyUI-GGUF support`; `/object_info` lists `Trellis2LoadModel_GGUF`,
`Trellis2ExportMesh_GGUF`, `Trellis2LoadImageWithTransparency_GGUF` — the exact classes
`workflows/trellis_phoenix.json` calls.

**Models.** Two options, both fine:
- **Auto:** the node's ModelManager downloads the TRELLIS.2-4B GGUF set on the **first mesh gen**
  (`[ModelManager] Downloading shape/...gguf`, ~752 MB / 904 MB / …, ~2.5 GB total). The first gen
  therefore looks like a hang — it's the download. `see also: trellis-first-mesh-timeout.md`.
- **Manual (pre-warm, what we did):** `Aero-Ex/Trellis2-GGUF` holds the whole Q4_K_M set — `shape/`,
  `texture/`, `refiner/` (`*_Q4_K_M.gguf`), `encoders/`, `decoders/` (`*_fp16.safetensors`), plus
  `Vision/dinov3-vitl16-pretrain-lvd1689m.safetensors`, `pipeline.json`, `texturing_pipeline.json`.
  Pull it preserving structure into the node's model dir:
  ```bash
  ./venv/bin/hf download Aero-Ex/Trellis2-GGUF --local-dir ~/ComfyUI-trellis/models/Trellis2
  ```
  `model_manager.py` resolves both `models/Trellis2/<file>` (flat) and `models/Trellis2/<folder>/<file>`
  (nested "Aero-Ex layout") — so the mirrored structure is found as-is. The workflow requests
  `TRELLIS.2-4B` / `GGUF Q4_K_M` / `1024_cascade` / `low_vram:true` — correct for a 10 GB card.
- **DINOv3 caveat:** `model_manager.py` looks for DINOv3 at
  `models/Trellis2/dinov3/facebook/dinov3-vitl16-pretrain-lvd1689m/model.safetensors` and auto-fetches
  it from the separate repo `Aero-Ex/Dinov3` on first gen (~1.7 GB, quick). The `Vision/…` copy in the
  GGUF repo is a different path/name; simplest is to let the node fetch DINOv3 itself the first time.

**Known Linux gotchas along the way:**
- The two big ones are **§6.4 (torch ABI undefined-symbol)** and **§6.5 (flex_gemm triton Autotuner
  14-arg TypeError)** above — both hit here, both fixed by re-pinning torch 2.5.1 + triton 3.2.0.
- All CUDA wheels are **prebuilt cp311 manylinux** from `pozzettiandrea.github.io/cuda-wheels/`, so
  **nothing compiles** — no flash-attn source build, no `nvcc` needed (which we don't have and can't
  `apt`-install). Stay exactly on py3.11 / torch2.5 / cu124 so the prebuilt tags match.
- `IndexError: index 3 is out of bounds ... size 3` in `Trellis2PreProcessImage_GGUF` = RGB vs RGBA on
  the input image. `see also: trellis-preprocess-rgb-alpha.md`.
- First mesh gen still downloads DINOv3 (+ any json) → can look like a hang.
  `see also: trellis-first-mesh-timeout.md`.

**Verify:** `import cumesh,o_voxel,flex_gemm,nvdiffrast,nvdiffrec_render,flash_attn` all OK; ComfyUI log
shows `N seconds: ...Trellis2-GGUF` (not IMPORT FAILED); `Trellis2*_GGUF` in `/object_info`; a mesh gen
writes a `.glb`. **Confirmed on this box up to node-load + object_info; a full mesh gen is the last
unrun step (pending the model download + an input image).**

---

## 7. Blender IPC on Linux

**Symptoms:** `[FAIL] Blender IPC — Blender not open, or the Phoenix IPC addon is not enabled`.
**Root cause:** it's file-IPC, not a network check — it only passes when Blender is **running with the
addon enabled**. Nothing to install at the OS level; it works identically to Windows.
**Fix:** open `~/apps/blender/blender` → Edit ▸ Preferences ▸ Add-ons ▸ Install from Disk… → pick
`blender-addon/phoenix_blender_ipc.py` from this repo → enable "Phoenix Blender IPC". Press **N** in
the viewport for the Phoenix tab. IPC dir defaults to `/tmp/phoenix-blender-ipc` on Linux.
**Verify:** `node preflight.js` → `[PASS] Blender IPC ... Blender 5.1.2`.

---

## 8. Config changes made on this box

`phoenix-config.json` (auto-created from the example on first `node server.js`) was edited:
- `apps.blender` → `~/apps/blender/blender` (was the Windows default path).
- `preflight.expected.pytorch` → `2.12` (silences the drift WARN for the current image venv). Note:
  if/when you build the Trellis venv on torch 2.6/cu124, this "expected" block no longer matches that
  env — it only describes whichever ComfyUI is actually serving :8000.
- `workflows.image` → `sd15` (default image workflow; sd15 works on the current venv today).

---

## Notes / status
- **Two ComfyUI installs on this box:**
  - `~/ComfyUI` — original image-only (py3.12 / torch2.12 / cu130). Kept as a fallback; **not** the one
    to run for the full pipeline.
  - `~/ComfyUI-trellis` — **the real one**: py3.11 / torch2.5.1 / cu124 / triton3.2.0, Trellis2-GGUF +
    RMBG + GGUF nodes, `extra_model_paths.yaml` sharing `~/ComfyUI/models`. Serves image **and** mesh
    on :8000. Launch: `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True ~/ComfyUI-trellis/venv/bin/python ~/ComfyUI-trellis/main.py --port 8000`.
    **Run only one at a time** (both bind :8000).
- **Verified working:** SD 1.5 + Flux 2 Klein downloaded; the Trellis node loads (`1.5s`, not IMPORT
  FAILED) and its nodes appear in `/object_info`; image models visible via the shared path. Claude CLI
  + Blender exe path green.
- **Last unrun step:** a full mesh generation (needs the Trellis GGUF set — downloading — and an input
  image). Then wire Phoenix's `mesh` gate and generate end-to-end.
- **One-time downloads:** ~2 GB SD · ~16 GB Flux · ~3 GB torch per venv · ~8–10 GB Trellis Q4_K_M set
  · ~1.7 GB DINOv3 on first mesh gen.
- Since :8000 is now the py3.11/cu124 env, `preflight.expected` (python 3.12 / pytorch 2.12 / cu130 in
  config) will show drift WARNs — cosmetic. Update it to `3.11 / 2.5 / cu124` if you retire `~/ComfyUI`.
- If you resolve a new Linux-only trap, add a row to `INDEX.md` and either a flat `entries/<slug>.md`
  or a section here.
