# Phoenix

**A creative's control room for local AI.** Phoenix is a free, open‑source harness that brings the messy toolchain of local AI generation — concept images, 3D meshes, voice & sound, image editing, a Blender bridge — into one browser workbench and *drives the tools for you*. Describe what you want in plain language; Phoenix runs the pipeline and hands you an asset to finish in Blender. It all runs on your own GPU — the flagship pipeline (prompt → reference image → 3D mesh → Blender) is the fastest way to see it work.

Built by [Laconova](https://laconova.com). Phoenix is the first public release built on Laconova's in-house agent harness — the same foundation behind the developer tooling we're building next.

> **Status: alpha.** Early and evolving — expect rough edges. Issues and feedback welcome.

---

## How it works

Phoenix is a lightweight **Node.js orchestrator** (zero npm dependencies — just the Node standard library) that drives a local **ComfyUI** over HTTP. A chat assistant runs the pipeline stage by stage:

1. **Prompt** — a metaprompter expands your short prompt into a tuned positive/negative prompt for the active image workflow.
2. **Image** — ComfyUI renders a reference image (Flux / SD / your own workflow).
3. **Mesh** — ComfyUI turns that image into a 3D mesh (Trellis).
4. **Import** — the asset lands in your staging library, ready for Blender.

Each stage has an optional **gate** (pause for your approval). The generation engine is **field‑aware** and **workflow‑agnostic**: every workflow is described by a small *node‑map*, so Phoenix can drive any ComfyUI graph — and you can add your own (see below).

```
  you ──chat──▶ Phoenix (Node, :7777) ──HTTP──▶ ComfyUI (:8188)
                     │                              │
                prompt · image · mesh · import   models / workflows
                     └────────▶ staging library ──▶ Blender
```

## Prerequisites

- **Node.js 20+**
- **[ComfyUI](https://github.com/comfyanonymous/ComfyUI)** running locally, with the models for the workflow you want to use (e.g. Flux, SD 1.5, Trellis).
- **[Claude CLI](https://docs.claude.com/en/docs/claude-code)** (`claude`) — the assistant/orchestrator seats call it; sign in with your Anthropic account.
- *Optional:* **[LM Studio](https://lmstudio.ai/)** (local model for the metaprompter), **Blender** (import / scene sync).
- *Optional (for the Voice/Unreal tabs):* **Unreal Engine 5.8+** with the Python plugin and a real `python` on your PATH (Unreal bridge — see **Connect Unreal**); a **CrispASR** speech server plus `.gguf` voice packs (Voice / SFX tabs — this is what powers the integrated default engine); an **ffmpeg** binary for voice/SFX effects (auto‑detected from `imageio‑ffmpeg` if present, otherwise set `voice.ffmpeg`). The picker's other engines (Chatterbox, CosyVoice) additionally need a voice‑service dispatcher that a future version will ship.

## Quickstart

```bash
git clone https://github.com/laconova/phoenix.git
cd phoenix

# start ComfyUI separately, then:
node server.js
```

Open **http://127.0.0.1:7777**.

On first run Phoenix creates `phoenix-config.json` from the example automatically — no manual copy
needed. To customize endpoints/models, edit that file, or pre-create it yourself:
`copy phoenix-config.example.json phoenix-config.json` (Windows) /
`cp phoenix-config.example.json phoenix-config.json` (macOS/Linux).

On first run, Phoenix seeds its registry with five built‑in ("Verified") ComfyUI workflows — **Flux Klein** and **SD 1.5** (image), **Trellis2‑GGUF** (mesh), and **Qwen Image Edit** and **SAM3 Isolate** (i2i / edit) — plus three **Voice** engines in the library's Voice section (**CrispASR**, the integrated default, alongside **Chatterbox** and **CosyVoice**). The Workflows tab shows a live dependency badge per workflow so you can see what actually runs on your machine.

## Connect Blender

The final pipeline stage imports your prop into Blender. Phoenix talks to Blender through a small **file‑based IPC addon** — no sockets, no ports, no firewall setup (it works the same on Windows and Linux).

**One‑time install (4 clicks):**

1. In Blender: **Edit ▸ Preferences ▸ Add‑ons ▸ Install from Disk…**
2. Pick **`blender-addon/phoenix_blender_ipc.py`** from this repo.
3. **Enable** the checkbox next to *"Phoenix Blender IPC"*.
4. Done — it starts automatically. Press **N** in the 3D viewport to see the **Phoenix** sidebar tab (live status + a manual Start/Stop).

With Blender open and the addon enabled, the import stage drops generated props straight into your scene. The **Troubleshooter**'s Blender check probes the bridge and flips to ✓ once it's connected. (The onboarding wizard's Blender pill reports something different — whether the optional `apps.blender` executable path in your config exists.)

*Optional:* set `apps.blender` in `phoenix-config.json` to your Blender executable so Phoenix can launch it for you. Requires Blender 3.0+ (tested on 5.1).

## Connect Unreal

*(Optional — for the 1.7.0 Unreal bridge.)* Phoenix can drive an **already‑running** Unreal Engine editor: place brushes and spawn saved characters into the open level, pull assets back into Blender, and screenshot the viewport so the assistant can check its own work. **Phoenix never launches Unreal** — you keep the editor open and it connects over Unreal's Python remote execution.

**One‑time setup, in Unreal:**

1. **Enable the Python plugin:** *Edit ▸ Plugins ▸* search **"Python Editor Script Plugin"** ▸ enable ▸ restart the editor.
2. **Enable remote execution:** *Edit ▸ Project Settings ▸ Plugins ▸ Python ▸* tick **"Enable Remote Execution"**.
3. **A real `python` on your PATH.** The bridge shells out to a short Python helper that speaks Unreal's remote‑execution protocol — any Python 3 works. On Windows, make sure it is a *real* Python and not the Microsoft‑Store `python` app‑execution stub, which exits instantly. If `python` isn't on PATH, point Phoenix at one with `apps.python` in the config.

With the editor open and a project loaded, the Unreal actions light up (a red/absent indicator means one of the three above is missing — the bridge's error message names which). Tested on **UE 5.8**. *Optional:* set `apps.unrealEngine` to your install folder (e.g. `C:\Program Files\Epic Games\UE_5.8`); left empty, Phoenix uses the newest `UE_*` it finds.

## Features

- **Chat‑driven generation** with per‑stage gates (prompt / image / mesh).
- **Workflow registry** — *Verified* (shipped) workflows plus **add your own**: upload a ComfyUI **API‑format** workflow JSON, Phoenix infers the node‑map and dependencies, you review/correct it in a form, and it's saved as a *Custom* workflow. Live per‑workflow dependency status.
- **Library that ships with nothing** *(new in 1.8.1)* — every built‑in workflow carries an **install manifest** (its license plus the exact models / custom nodes it needs), so a fresh install downloads no heavy weights. The library shows a **license badge** and a real *installed / not installed* status per workflow and offers **⬇ Acquire** to fetch what's missing — you pull only the workflows you actually use, and existing installs pick up newly‑shipped definitions on upgrade.
- **Style palette** — editable per‑category style presets that shape the look of your props.
- **Asset library** — staged assets, brushes, materials.
- **Troubleshooter** — an LLM assistant that checks your local stack (ComfyUI · models · Blender) and helps get missing dependencies running.
- **Characters & animation** *(new in 1.6.0)* — build parametric people into your Blender scene, save them as reusable characters, and animate them from Mixamo clips or plain text. Creatures and machines get their own skeleton-bound workflow. Full guide: **[human-tab-guide.md](human-tab-guide.md)**.
- **Voice & sound** *(new in 1.7.0; multi‑engine in 1.8.1)* — a baked voice pack speaks a line, plus a sound‑effects tab to generate, audition and edit SFX takes and bake them onto a character. An **engine picker** in the Sound Design workbench shows the available voice engines. **CrispASR** (the default, integrated) runs against your own CrispASR speech server — local or on your GPU box — and works today. **Chatterbox** (MIT) and **CosyVoice** are shown in the picker but route through a **voice‑service dispatcher** that is not part of this release, so they appear greyed out ("requires the voice‑service dispatcher — coming in a future version") until that ships. Pick and activate an engine from the workflow library; the choice persists, and `/speak` never silently falls back to an unavailable engine — it tells you what's missing instead.
- **Unreal Engine bridge** *(new in 1.7.0)* — place brushes and spawn saved characters into an already‑running Unreal editor, pull Unreal assets back into Blender as glTF, and let the assistant screenshot the viewport to check its own work. See **Connect Unreal** below.
- **Mesh preview** *(new in 1.7.0)* — inspect a brush's geometry right in the browser (a vendored model‑viewer, no CDN) before it goes anywhere.
- **Image editing (i2i)** *(new in 1.8.0)* — a branch between the image and the mesh: recolour or restyle a reference with **Qwen‑Image‑Edit**, or isolate a part on white with **SAM3** for a cleaner mesh. Edits arrive as tiles you can refine or send straight to 3D. See **[Edit an image (i2i)](#edit-an-image-i2i)** below.

### Characters and animation

The **Human tab** builds parametric people directly in your open Blender scene through **MPFB2** (MakeHuman's engine, installed in your Blender): body and face sliders, skin, hair, clothes, and a preview before anything enters the scene. Switch the rig to **Mixamo** and the figure is animation‑ready.

- **Character library** — save a finished figure with its meshes, packed textures and skeleton, and spawn it back whenever you need it. It stores the real geometry, so sculpts and edits survive; a character you rigged yourself at [mixamo.com](https://www.mixamo.com) works the same way.
- **Animation** — drop in Mixamo FBX clips, retarget them onto any rigged character, and chain them into sequences that blend at the seams. One shared clip library: every clip fits every character, because they all wear the same skeleton.
- **Custom Rig tab** — for everything that is *not* a standard humanoid. A folder binds one skeleton to its clips and mesh variants, so a deer, a monster or a robot arm keeps its own animations, and every variant of it reuses them. **Rig to mesh** voxel‑remeshes a generated mesh and binds it with automatic weights, then reports how many vertices actually got weighted.

See [`human-tab-guide.md`](human-tab-guide.md) for the walkthrough, including the setup MPFB2 needs.

### Text → motion (optional)

Describe a movement in plain English and get an animation clip back, retargeted onto any Mixamo‑rigged character in your scene. It runs on **HY‑Motion** (Tencent Hunyuan Motion) in ComfyUI. Two things it needs, both easy to get wrong:

- **A ComfyUI with the HY nodes.** `hyMotion.api` must point at a ComfyUI that has `ComfyUI-HY-Motion1` in `custom_nodes` and the weights under `models/HY-Motion/`. That can be the same ComfyUI you use for images and meshes — what matters is that the nodes are installed there, not which port it runs on. Point it at another machine (`http://gpu-box.local:8188`) if generation runs on a separate GPU box. `node preflight.js` reports whether the endpoint is up **and** whether the HY nodes are actually there.
- **A T‑pose template.** HY‑Motion retargets against a character FBX that must be in the **Mixamo rest pose (T‑pose)**. Feed it an A‑pose rig and generation still "succeeds" — it just returns a hunched figure with the forearms bent in front of the body, which is the single most confusing failure in this feature. Create the template once with `scripts/hy-motion/make_tpose_char.py`:

  ```bash
  blender --background --python scripts/hy-motion/make_tpose_char.py -- <char.fbx> <char_tpose.fbx>
  ```

  then put the result in that ComfyUI's `input/3d/` and set `hyMotion.template` to its path. Preflight cannot verify this one for you: ComfyUI's file listing only reports top‑level files, so a template inside `input/3d/` is invisible to it — if your figures come out hunched, this is why.

### Save your own brushes

A **brush** is a reusable asset saved from your Blender scene — one `.blend` library file that places back **whole**, however many meshes it contains. Two ways to tell Phoenix what goes in:

- **Name a collection:** *"make a brush out of the Campfire collection"* — saves **all** mesh objects in that collection.
- **Select in Blender:** select the meshes in the viewport, then *"save this as a brush called campfire"* — saves the whole selection (a single selected object works too).

Phoenix reports how many meshes went into the brush — if that's not what you expected, adjust the selection/collection and save again. Place it later with *"use the campfire brush"*.

### Edit an image (i2i)

The **Edit · i2i** sub‑tab (inside the Image window) is a branch between the image and the mesh: take a generated or loaded reference and either **change how it looks** or **cut a part out**, then send the result to Trellis or refine it further. Two engines, picked from a dropdown:

- **Qwen Image Edit** — appearance, material and style edits (*"make it rusty and weathered"*, *"turn the cloak deep red"*). It does **not** remove structure and does **not** produce a new camera angle, and the shipped Q3 quant has a material ceiling: a full material swap (wood → cast bronze) may come back unchanged or black, while recolour / weathering / surface detail land. Needs the Qwen‑Image‑Edit model set in your ComfyUI (the ~10 GB Q3 gguf plus its VL text encoder and VAE — more than 10 GB of downloads in total).
- **SAM3 Isolate** — text‑guided isolation (*"the head"*, *"the held item"*): cuts the named part out onto a white background, ready to mesh. Needs the ComfyUI‑RMBG suite with `sam3.pt`.

Each edit is a **new tile** — the reference is never overwritten. A tile can become the new reference (**Refine**) or go straight to **→ 3D**.

Both engines are heavy and share your GPU, so Phoenix runs one heavy job at a time. If Qwen‑Image‑Edit and Trellis live in **separate ComfyUI instances** (they often need incompatible CUDA/Python), set the optional `endpoints.comfyui_bild` to the second one; otherwise everything runs on your single `endpoints.comfyui`.

### Add your own workflow

Workflows tab → **+ Add workflow** → pick the stage (image / mesh / i2i) → upload a ComfyUI workflow exported as **"Save (API Format)"** → **Analyze with Phoenix**. Phoenix proposes the node‑map (which node receives the prompt, seed, steps, output, …) and the required custom nodes / models from the graph. Review the dropdowns, give it a name, and save. Only `positive` + `output` (image) / `image` + `output` (mesh) / `input_image` + `output` (i2i) are required; anything you don't map keeps the workflow's own built‑in value.

### Bundled scripts

`scripts/` holds a few standalone helpers that are not (yet) wired into the UI. Run them yourself
when you need them:

- **`leaf_scatter.py`** — the trick that makes generated trees hold up. An image‑to‑3D mesher spends
  its whole polygon budget on the *whole* tree, so each "leaf" ends up a facet half a metre across.
  Instead: mesh a **single leaf**, decimate it, and instance it thousands of times over the canopy
  with Geometry Nodes — leaf size becomes a dial rather than something baked into the mesh. Includes
  an **instance guard** that computes the exact instance count first and refuses to run over budget,
  because the alternative is Blender dying of OOM. Run it inside Blender (the docstring at the top of
  the file is the walkthrough). This is the workflow the roadmap folds into Phoenix proper.
- **`contact_sheet.py`** — build a contact sheet from a batch of generated images.
- **`check-refs.js`** — release gate: `node scripts/check-refs.js` verifies that every file the code
  reaches for actually exists in the tree. Useful before packaging, useless afterwards.
- **`check-scaffold-parity.js`** — release gate: `node scripts/check-scaffold-parity.js` answers one
  question — *is the brush runtime a fresh install gets the same one this machine runs?* There are two
  copies of it: `brushes/phoenix_brushes.py` (gitignored user data) and the template inside
  `brush-scaffold.js`. A fix to the live file does not reach the template on its own, and once that
  drifted the fresh-install copy silently shipped bugs that had already been fixed. Exits 1 on drift
  and prints the differing lines. **Run it where the brush system is actually used** — on a tree
  without `brushes/` it has nothing to compare and says so.
- **`hy-motion/`** — helpers for text→motion, including `make_tpose_char.py` (see above).

One more lives in the repo root: **`node scene-sync.js`** polls your open Blender scene and keeps the
assistant's picture of it current, so it can answer "what is in the scene" without asking Blender each
time. It is a **separate, optional process** — the server does not start it — and it is tuned by the
`sceneSync` block in the config. Without it the assistant still works; its scene view is just only as
fresh as the last import or explicit refresh.

## Configuration

Phoenix creates `phoenix-config.json` from `phoenix-config.example.json` on first run (or copy it yourself — `copy` on Windows, `cp` on macOS/Linux). Key fields:

- **`seats`** — which model each role uses (`orchestrator`, `metaprompter`, `troubleshooter`, `vision`).
- **`endpoints`** — ComfyUI + local‑model URLs. `comfyui` runs your image, mesh **and** i2i/edit
  workflows; optional **`comfyui_bild`** is a *second* ComfyUI instance for i2i workflows tagged
  `instance:'bild'` — only needed if you run Qwen‑Image‑Edit and Trellis in separate environments
  (see *Edit an image (i2i)*). Leave it out and everything runs on the one `comfyui`.
- **`hyMotion`** — text→motion: `api` (a ComfyUI with the HY‑Motion nodes installed — the same one as
  `endpoints.comfyui` is fine) and `template` (the T‑pose FBX it retargets against). See *Text → motion* above.
- **`voice`** — the Voice/SFX tabs: `api` (a CrispASR speech server — local or on your GPU box, e.g.
  `http://gpu-box.local:8090`; leave empty to hide the functions) and `ffmpeg` (path to an ffmpeg binary
  for the effects; leave empty to auto‑detect the one bundled with `imageio‑ffmpeg`). The picker's
  non‑default engines (Chatterbox, CosyVoice) additionally require `voice.dispatcher: true` **and** a
  voice‑service dispatcher behind that `api` — not part of this release, so they stay greyed out by
  default.
- **`comfyInstall`** / **`voiceInstall`** — optional; what the Workflow Library's **⬇ Acquire** button
  needs to fetch a workflow's missing models / custom nodes (or a voice engine) for you. One key per
  instance → `{ root, via }`: `root` is the ComfyUI checkout (models land in `root/models`, custom nodes
  in `root/custom_nodes`) or the voice/bench root; `via` is `"local"` (default — install onto **this**
  machine) or `"supervisor"` (install on another host over `endpoints.rigSsh`). Image and mesh workflows
  (no explicit instance) resolve under the **`trellis`** key, so a single‑machine user sets
  `comfyInstall.trellis = { "root": "<your ComfyUI folder>", "via": "local" }`; i2i workflows tagged
  `instance:'bild'` use `comfyInstall.bild`; the one voice endpoint uses `voiceInstall.voice`. **Left out
  (or a workflow's instance absent), Acquire shows "manual" and you place the files yourself** — never a
  silent install to some default location. Note: a **voice‑engine** Acquire runs its venv/pip/git steps
  on a **Linux/macOS (POSIX)** target, and cancelling a `via:"local"` voice acquire *on a Windows host*
  may not stop the in‑flight step (Windows has no process‑group kill); ComfyUI Acquire is portable
  either way.
- **`feedback.endpointUrl`** — optional. Set it to a URL that accepts a JSON `POST` and the in‑app
  Feedback form sends there; leave it empty and the form stays hidden.
- **`gates`** — which stages pause for approval (`prompt` / `image` / `mesh`), plus **`gates.vision`**
  (`off` / `focused` / `full`) — after a scene‑changing action Phoenix renders the viewport and has a
  model *look at it*, instead of reporting "fixed ✓" from text alone. `focused` is the default and
  covers the animation/mesh/brush tools; `full` adds asset placement and `blender_run`. The seat that
  does the looking is **`seats.vision`**.
- **`apps`** — local paths: `blender` (the Blender executable), `comfyOutput` (the folder Phoenix
  reads ComfyUI's generated files from; leave empty to use the default `~/Documents/ComfyUI/output`),
  `unrealEngine` (your UE install folder — optional, Phoenix otherwise takes the newest `UE_*` it finds),
  and `python` (a real Python 3 for the Unreal bridge if `python` isn't already on your PATH — see
  **Connect Unreal**).

Runtime/user files (`phoenix-config.json`, `workflows.json`, `palette.json`, `output/`, …) are git‑ignored — Phoenix recreates them on first run.

## License

[MIT](LICENSE) © 2026 Laconova
