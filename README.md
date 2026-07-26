# Phoenix

**Text → 3D prop pipeline.** Phoenix is an AI agent that turns a short text prompt into a 3D prop. It orchestrates a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) through a chat‑driven pipeline — prompt → reference image → 3D mesh → Blender import — all from a single browser UI.

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

On first run, Phoenix seeds its registry with three built‑in ("Verified") workflows — **Flux Klein** and **SD 1.5** (image) and **Trellis2‑GGUF** (mesh). The Workflows tab shows a live dependency badge per workflow so you can see what actually runs on your machine.

## Connect Blender

The final pipeline stage imports your prop into Blender. Phoenix talks to Blender through a small **file‑based IPC addon** — no sockets, no ports, no firewall setup (it works the same on Windows and Linux).

**One‑time install (4 clicks):**

1. In Blender: **Edit ▸ Preferences ▸ Add‑ons ▸ Install from Disk…**
2. Pick **`blender-addon/phoenix_blender_ipc.py`** from this repo.
3. **Enable** the checkbox next to *"Phoenix Blender IPC"*.
4. Done — it starts automatically. Press **N** in the 3D viewport to see the **Phoenix** sidebar tab (live status + a manual Start/Stop).

With Blender open and the addon enabled, the import stage drops generated props straight into your scene. The **Troubleshooter**'s Blender check probes the bridge and flips to ✓ once it's connected. (The onboarding wizard's Blender pill reports something different — whether the optional `apps.blender` executable path in your config exists.)

*Optional:* set `apps.blender` in `phoenix-config.json` to your Blender executable so Phoenix can launch it for you. Requires Blender 3.0+ (tested on 5.1).

## Features

- **Chat‑driven generation** with per‑stage gates (prompt / image / mesh).
- **Workflow registry** — *Verified* (shipped) workflows plus **add your own**: upload a ComfyUI **API‑format** workflow JSON, Phoenix infers the node‑map and dependencies, you review/correct it in a form, and it's saved as a *Custom* workflow. Live per‑workflow dependency status.
- **Style palette** — editable per‑category style presets that shape the look of your props.
- **Asset library** — staged assets, brushes, materials.
- **Troubleshooter** — an LLM assistant that checks your local stack (ComfyUI · models · Blender) and helps get missing dependencies running.
- **Characters & animation** *(new in 1.6.0)* — build parametric people into your Blender scene, save them as reusable characters, and animate them from Mixamo clips or plain text. Creatures and machines get their own skeleton-bound workflow. Full guide: **[human-tab-guide.md](human-tab-guide.md)**.

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

### Add your own workflow

Workflows tab → **+ Add workflow** → pick the stage (image / mesh) → upload a ComfyUI workflow exported as **"Save (API Format)"** → **Analyze with Phoenix**. Phoenix proposes the node‑map (which node receives the prompt, seed, steps, output, …) and the required custom nodes / models from the graph. Review the dropdowns, give it a name, and save. Only `positive` + `output` (image) / `image` + `output` (mesh) are required; anything you don't map keeps the workflow's own built‑in value.

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
- **`hy-motion/`** — helpers for text→motion, including `make_tpose_char.py` (see above).

One more lives in the repo root: **`node scene-sync.js`** polls your open Blender scene and keeps the
assistant's picture of it current, so it can answer "what is in the scene" without asking Blender each
time. It is a **separate, optional process** — the server does not start it — and it is tuned by the
`sceneSync` block in the config. Without it the assistant still works; its scene view is just only as
fresh as the last import or explicit refresh.

## Configuration

Phoenix creates `phoenix-config.json` from `phoenix-config.example.json` on first run (or copy it yourself — `copy` on Windows, `cp` on macOS/Linux). Key fields:

- **`seats`** — which model each role uses (`orchestrator`, `metaprompter`, `troubleshooter`).
- **`endpoints`** — ComfyUI + local‑model URLs.
- **`hyMotion`** — text→motion: `api` (a ComfyUI with the HY‑Motion nodes installed — the same one as
  `endpoints.comfyui` is fine) and `template` (the T‑pose FBX it retargets against). See *Text → motion* above.
- **`feedback.endpointUrl`** — optional. Set it to a URL that accepts a JSON `POST` and the in‑app
  Feedback form sends there; leave it empty and the form stays hidden.
- **`gates`** — which stages pause for approval (`prompt` / `image` / `mesh`).
- **`apps`** — local paths: `blender` (the Blender executable) and `comfyOutput` (the folder Phoenix
  reads ComfyUI's generated files from; leave empty to use the default `~/Documents/ComfyUI/output`).

Runtime/user files (`phoenix-config.json`, `workflows.json`, `palette.json`, `output/`, …) are git‑ignored — Phoenix recreates them on first run.

## License

[MIT](LICENSE) © 2026 Laconova
