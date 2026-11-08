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
- **One brain of your choice** for the assistant: the **[Claude CLI](https://docs.claude.com/en/docs/claude-code)** (`claude`, sign in with your Anthropic account), the **Codex CLI** (ChatGPT plan), a local model server (LM Studio / llama.cpp), or an API key — pick it in Settings ▸ Brains.
- *Optional:* **[LM Studio](https://lmstudio.ai/)** (local model for the metaprompter), **Blender** (import / scene sync).
- *Optional (for the Audio workspace and the Unreal bridge):* **Unreal Engine 5.8+** with the Python plugin and a real `python` on your PATH (Unreal bridge — see **Connect Unreal**); a **CrispASR** speech server plus `.gguf` voice packs (Audio workspace — this is what powers the integrated default engine); an **ffmpeg** binary for voice/SFX effects and for **Export board as video** (auto‑detected from `imageio‑ffmpeg` if present, otherwise set `voice.ffmpeg`). Chatterbox (in the picker) runs on this PC through Phoenix's own voice dispatcher — switch it on in **Settings → Voice engines**; it needs an NVIDIA GPU, Python 3.12 and about 9 GB of disk. CosyVoice stays blocked in this release.

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

On first run, Phoenix seeds its registry with seven built‑in ("Verified") ComfyUI workflows — **Flux Klein**, **Z-Image Turbo** and **SD 1.5** (image), **Trellis2‑GGUF** (mesh), **Qwen Image Edit** and **SAM3 Isolate** (i2i / edit), and **Local · LTX-2 i2v** (video) — plus three **Voice** engines, listed as rows next to them under Library ▸ Tools ▸ Workflows (**CrispASR**, the integrated default, alongside **Chatterbox** and **CosyVoice**). The Workflows list shows a live dependency badge per workflow so you can see what actually runs on your machine. The Image and Mesh tabs each have a workflow picker; workflows that aren't installed yet are acquired from Library ▸ Tools ▸ Workflows.

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

## Use Phoenix from Claude Code / Codex / Cursor

Phoenix also runs as an **MCP server**, so an external coding agent can generate props, import them and check the result with Phoenix's render vision — the agent is the brain, Phoenix is the tool. Add it once (replace `<abs>` with your Phoenix folder; Settings ▸ Connections shows the exact lines):

```bash
claude mcp add --scope user phoenix -- node "<abs>/phoenix-mcp.js"
codex mcp add phoenix -- node "<abs>/phoenix-mcp.js"
```

Cursor — `.cursor/mcp.json`:

```json
{"mcpServers":{"phoenix":{"command":"node","args":["<abs>/phoenix-mcp.js"]}}}
```

**Phoenix must be running** (start it with `server.bat` on Windows, or `node server.js`). Every MCP call shows up live in the Phoenix chat window, marked with 🔌.

**What an agent can do.** Almost every Phoenix tool is available (the exceptions are listed at the end of this paragraph), in groups: **generate** (`generate_prop`, `generate_image`, `image_to_3d`) · **scene** (`import_asset`, `use_brush`, `apply_material`, `inspect_render` — Phoenix renders the scene and a vision model judges it) · **humans & animation** (`make_human`, `place_human`, `animate_human`, `sequence_animations`, `hy_motion` text→motion, `save_animation`, `list_animations`) · **custom rigs** (`list_custom_rigs`, `assign_skeleton`, `spawn_rig`, `animate_clip`, `sequence_clips`, `prepare_mesh`, `bind_mesh`, `save_clip`, `save_mesh`) · **characters** (`list_characters`, `save_character`, `spawn_character`) · **library** (`list_assets`, `list_brushes`, `list_materials`, `read_palette`, `save_as_brush`, `brush_preview`, `rename_asset`, `rename_brush`) · **Unreal** (`brush_to_unreal`, `unreal_to_blender`, `unreal_to_brush`, `character_to_unreal`, `inspect_unreal` — needs a running Unreal Editor with the Phoenix bridge) · **control** (`read_state`, `job_status`, `stop`). Tools that change your open Blender scene take a checkpoint first (on/off, how many to keep and the disk budget in Settings ▸ Storage & checkpoints), and one heavy job runs at a time. **Three things are off until you tick them in Settings ▸ Connections:** `blender_run` (arbitrary Python in your Blender scene), `unreal_run` (arbitrary Python in Unreal) and the deletes `delete_asset` / `delete_brush` / `delete_material` (permanent — a checkpoint cannot bring a deleted file back). `brush_to_unreal` / `character_to_unreal` re-import into the same `/Game` path and replace those Unreal assets (they can be regenerated from Phoenix). The Edit tab's `i2i_edit` stays UI-only. Voice/TTS, sound effects, the workflow downloader, reference-image generation (`generate_from_refs`) and Make video (`make_video`) are not available over MCP yet.

**Long generations:** `generate_prop` / `generate_image` take several minutes. Claude Code: set the `MCP_TOOL_TIMEOUT` environment variable (milliseconds). Codex: add `[mcp_servers.phoenix]` with `tool_timeout_sec = 3600` to `~/.codex/config.toml`. If a client times out anyway, Phoenix keeps working — check with `job_status` / `list_assets`.

## Features

- **Chat‑driven generation** with per‑stage gates (prompt / image / mesh).
- **Workflow registry** — *Verified* (shipped) workflows plus **add your own**: upload a ComfyUI **API‑format** workflow JSON, Phoenix infers the node‑map and dependencies, you review/correct it in a form, and it's saved as a *Custom* workflow. Live per‑workflow dependency status.
- **Library that ships with nothing** *(new in 1.8.1)* — every built‑in workflow carries an **install manifest** (its license plus the exact models / custom nodes it needs), so a fresh install downloads no heavy weights. The library shows a **license badge** and a real *installed / not installed* status per workflow and offers **⬇ Acquire** to fetch what's missing — you pull only the workflows you actually use, and existing installs pick up newly‑shipped definitions on upgrade.
- **Style palette** — editable per‑category style presets that shape the look of your props.
- **Asset library** — four sections plus a Trash: **Media** (Images, Videos, Sound, SFX), **3D** (Assets, Brushes, Materials, Characters), **Scenes** (Levels) and **Tools** (Palette, Workflows, Storyboards).
- **Images and Videos tabs** *(new in 1.10)* — every image Phoenix generates or edits is recorded, so the Library's Images tab shows them as thumbnails with Use, Mesh it and Open; the Videos tab shows the clips made from the storyboard (Make video).
- **Storyboards** *(new in 1.10)* — lay shots out as a timeline (image, prompt, 1–15 s each, reorderable) and send any Library image to it with one click; images are linked, never copied. Keep several boards (grouped in the Library under Tools); each shot links its references, keyframe and clip.
- **Make video** *(new in 1.10)* — turn a shot's keyframe and prompt into a clip from the storyboard. Free and local through ComfyUI with the built-in **Local · LTX-2 i2v** workflow (clips of up to about 3 s with sound; needs ComfyUI 0.27 or newer, about 38 GB of downloads via **⬇ Acquire** and 48 GB of RAM), or — optional and paid — through **fal.ai** (Kling 3 Pro) with your own key in *Settings ▸ Cloud & keys*; Phoenix shows the estimated cost and asks before it sends anything. `video.backend` picks the backend (`auto` prefers local).
- **Reference images** *(new in 1.10)* — generate from reference images instead of text alone: **Flux Klein** takes up to two references, **Z-Image Turbo** (new built-in fast photo-real workflow) one, with a *Change* slider for how far it may move away from it.
- **Per-workflow settings** *(new in 1.10)* — CFG, steps, sampler, size, denoise and the other tunables of each workflow live in its **Advanced** section (workflow window), per workflow with optional per-category overrides, a reset and a seed lock. They are stored in `workflow-params.json`; values that 1.9 kept in `palette.json` are migrated on first start.
- **Clip sound** *(new in 1.10)* — a local clip is one file with the sound the model made; each shot has a "Clip sound" switch that mutes or unmutes it in every player (nothing is re-rendered, no second file, no ffmpeg needed).
- **Bring your own local video model** *(new in 1.10)* — **+ Add workflow** now takes a **Video (local)** stage: upload an image-to-video workflow (e.g. Wan 2.2) in API format, Analyze, and Phoenix proposes the node map and reads fps, frame grid and sizes from the graph and your ComfyUI. Review the *Video settings*, save, select it in the storyboard. Workflows you add yourself stay marked "unverified".
- **Troubleshooter** — an LLM assistant that checks your local stack (ComfyUI · models · Blender) and helps get missing dependencies running.
- **Characters & animation** *(new in 1.6.0)* — build parametric people into your Blender scene, save them as reusable characters, and animate them from Mixamo clips or plain text. Creatures and machines get their own skeleton-bound workflow. They live in the **Characters** workspace; full guide: **[human-tab-guide.md](human-tab-guide.md)**.
- **Voice & sound** *(new in 1.7.0; multi‑engine in 1.8.1)* — a baked voice pack speaks a line, plus sound effects to generate, audition and edit SFX takes and bake them onto a character — all in the **Audio** workspace (Speak a line · Cast a new voice · Sound effects). Its voice picker is grouped by engine. **CrispASR** (the default, integrated) runs against your own CrispASR speech server — local or on your GPU box — and works today. **Chatterbox** (MIT) runs on **your own PC**: turn on **Settings → Voice engines → Run voice engines on this PC**, pick an install folder (about 9 GB — Phoenix shows what is free), and press **⬇ Acquire** in the Library; no config file editing. **CosyVoice** stays blocked in this release. Chatterbox clones a voice from a short sample, so use **your own voice, your characters** — or a voice you have the person's consent for. Generated speech is marked as AI by default (Perth watermark; switch it off only for private use in Settings → Voice engines), and Phoenix asks you to confirm this once before the first take. Pick and activate an engine from the workflow library; the choice persists, and `/speak` never silently falls back to an unavailable engine — it tells you what's missing instead.
- **Unreal Engine bridge** *(new in 1.7.0)* — place brushes and spawn saved characters into an already‑running Unreal editor, pull Unreal assets back into Blender as glTF, and let the assistant screenshot the viewport to check its own work. See **Connect Unreal** below.
- **Mesh preview** *(new in 1.7.0)* — inspect a brush's geometry right in the browser (a vendored model‑viewer, no CDN) before it goes anywhere.
- **Image editing (i2i)** *(new in 1.8.0)* — a branch between the image and the mesh: recolour or restyle a reference with **Qwen‑Image‑Edit**, or isolate a part on white with **SAM3** for a cleaner mesh. Edits arrive as tiles you can refine or send straight to 3D. See **[Edit an image (i2i)](#edit-an-image-i2i)** below.
- **Your brain, your choice — per seat** *(new in 1.9.0)* — every role (orchestrator, troubleshooter, metaprompter, vision, and the category provider — `utility` in the config) picks its own provider: the **Claude CLI**, the **Codex CLI** (ChatGPT plan), a **local OpenAI‑compatible server** (LM Studio / llama.cpp) or an **API key**. A model that is going to drive tools must pass a **tool test** first (a local orchestrator also a short **competence benchmark**); a non‑Claude **vision** seat must pass a **vision test** (it has to read a colour card next to the render) before it can be saved. Pick them in *Settings ▸ Brains*.
- **Ask / Auto run modes** *(new in 1.9.0)* — **Ask** stops at the gates as before; **Auto** runs to the end and only stops when the render check does not clearly confirm a step. Tool steps per turn are budgeted (default 3 in Ask, 8 in Auto — *Settings ▸ Brains ▸ Advanced*).
- **Checkpoints with rewind** *(new in 1.9.0)* — before each step that changes your open Blender scene Phoenix saves a copy (your own file is never touched) — in chat and over MCP alike, taken right where Blender is actually touched (a generated mesh right before it is imported, an applied animation right before it is applied); the Library and Human-tab buttons do not take one yet (apart from that import); the Checkpoints panel under the chat rewinds to any of them, and a rewind can itself be undone. On/off, how many to keep and the disk budget in *Settings ▸ Storage & checkpoints*.
- **Phoenix as an MCP server** *(new in 1.9.0)* — an external agent (Claude Code / Codex / Cursor) can use almost the whole Phoenix toolset; see **Use Phoenix from Claude Code / Codex / Cursor** above.
- **GPU share** *(new in 1.9.0, best effort)* — before an image or mesh stage Phoenix asks a local LLM server that shares the GPU to unload its model (LM Studio, Ollama, or a llama.cpp router server). Only for the llama.cpp router does Phoenix wait until the model is gone; for LM Studio and Ollama it does not confirm the unload, and if unloading fails the job still runs. The model reloads on its next request.
- **Remesh via Meshy** *(new in 1.9.0, optional, paid)* — rebuild a staged mesh's topology through Meshy's cloud API (about 5 Meshy credits per remesh). Off until you tick it in *Settings ▸ Cloud & keys* and store your own Meshy key; the Library entry *Remesh via Meshy…* shows your balance, the source triangle count and a live % on the asset. GLB cannot store quads, so a Meshy *quad* result comes back as triangle pairs — Phoenix joins them back into quads when you import it.
- **Use Phoenix from your phone** *(new in 1.10, optional, off by default)* — switch on *Settings ▸ Connections ▸ Phones* and Phoenix publishes itself to your own Tailscale network over HTTPS (a private Tailscale Serve route; never public, port 7777 is never exposed). Pair a phone once with a QR code or an 8-digit code and confirm it on the laptop; disconnect it there at any time. Since 1.10.1 the pairing page recovers from a timed-out request with a clear hint, an expired request disappears on its own, and an already-paired phone goes straight to Phoenix. The phone can chat, watch jobs and browse the Library; API keys, MCP and Settings stay laptop-only. Needs Tailscale signed in on both devices (same account, MagicDNS + HTTPS on). Design adapted from Mr. Mak Workspace (MIT); the QR encoder is qrcode-generator (MIT) — see THIRD_PARTY_NOTICES.
- **Resizable, collapsible panels** *(new in 1.9.0)* — drag the handles between the assistant, the middle area and the Library, or collapse the assistant / Library to a thin strip; the layout is remembered per browser.
- **A new shell** *(new in 1.10.1)* — a left rail (Create · Characters · Audio · Story · Library · Settings · Help), a top bar with Quick switches (gates, Blender-only, render vision, where brushes land, Brush from selection, Level stage), a **Ctrl K** command palette, a Copilot panel (Ask | Auto lives there) and a status bar with live providers (ComfyUI, VRAM, Blender, Unreal, jobs, orchestrator, vision, remote). Troubleshooter, Feedback and Setup are in the Help menu.
- **Settings, rebuilt** *(new in 1.10.1)* — six sections: **General · Brains · Connections · Voice engines · Cloud & keys · Storage & checkpoints**, a *Find a setting* search, and every change saves at once. *Run setup again* is at the bottom. *Storage* also lists orphaned cached previews (poster JPEGs, preview GLBs) so you can delete them.
- **Library, regrouped** *(new in 1.10.1)* — Media / 3D / Scenes / Tools plus a **Trash** with Restore for assets, brushes, characters, images and sound takes (Media, Characters and Audio also offer an Undo right after a delete). Brushes get their own folder tree (a one-time migration keeps a `.bak-r4` copy). Replacing a brush keeps the old one as a snapshot, and a failed brush save rolls back without leaving files or palette materials behind.
- **Characters, Audio and Story workspaces** *(new in 1.10.1)* — **Characters**: saved-character list, preview with one animation sequencer, inspector; MakeHuman and Custom rig are two sources (+ New character). **Audio**: Speak a line · Cast a new voice · Sound effects as modes of one panel with one effect rack and a takes desk (Music shows as unavailable). **Story**: storyboard with board bar, preview, transport, strip, lanes and inspector; per-shot camera tags (up to 8) and Undo of a removed shot.
- **Export board as video** *(new in 1.10.1)* — render the board's timeline to one MP4 (animatic) with ffmpeg: 1920×1080, 1080×1920 or 1080×1080 at 30 fps, up to 60 shots, with a Stop button. What plays is what exports.
- **Levels** *(new in 1.10.1)* — Library ▸ Scenes ▸ Levels, with the stages Blockout / Movable / Detail.
- **Make video fixes** *(new in 1.10.1)* — a self-added video workflow's frame rate is now written into the clip; the local/fal choice is remembered per browser; a storyboard keyframe made from reference images can be stopped and times out after 12 minutes by default (`storyboard.keyframeTimeoutMs`).
- **Smaller fixes** *(new in 1.10.1)* — Assign / Re-assign skeleton refuses when nothing is selected instead of taking an armature that is not in the scene; duplicated figures for custom rigs and characters are fixed; busy messages name the action in words.

### Characters and animation

The **Characters** workspace (left rail) builds parametric people directly in your open Blender scene through **MPFB2** (MakeHuman's engine, installed in your Blender). Press **+ New character ▸ MakeHuman** and work through the Body, Face, Look, Rig and Animate steps: body and face sliders, skin, hair, clothes, and a preview (**Rebuild preview**) before anything enters the scene (**Place in scene**). Set the Rig step to **Mixamo** and the figure is animation‑ready.

- **Character library** — save a finished figure with its meshes, packed textures and skeleton (**Save to saved characters**), and spawn it back from the Saved characters list whenever you need it. It stores the real geometry, so sculpts and edits survive; a character you rigged yourself at [mixamo.com](https://www.mixamo.com) works the same way.
- **Animation** — drop in Mixamo FBX clips, retarget them onto any rigged character, and chain them into sequences that blend at the seams. One shared clip library: every clip fits every character, because they all wear the same skeleton.
- **Custom rig source** (**+ New character ▸ Custom rig**) — for everything that is *not* a standard humanoid. A folder binds one skeleton to its clips and mesh variants, so a deer, a monster or a robot arm keeps its own animations, and every variant of it reuses them. **Rig to mesh** voxel‑remeshes a generated mesh and binds it with automatic weights, then reports how many vertices actually got weighted.

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

*Library ▸ Tools ▸ Workflows* → **+ Add workflow** → pick the stage (image / mesh / i2i / video) → upload a ComfyUI workflow exported as **"Save (API Format)"** → **Analyze with Phoenix**. Phoenix proposes the node‑map (which node receives the prompt, seed, steps, output, …) and the required custom nodes / models from the graph. Review the dropdowns, give it a name, and save. Only `positive` + `output` (image) / `image` + `output` (mesh) / `input_image` + `output` (i2i) are required; anything you don't map keeps the workflow's own built‑in value.

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
- **`check-voice-release.js`** — release gate, run by `check-refs.js`: refuses a tree that contains a reference
  recording (`ref-*.wav` and friends, any `.wav` under `sounds/refs/` or `voice-engines/`). Your own private strings
  (voice file stem, machine paths) go in `PHOENIX_RELEASE_FORBIDDEN="a,b"` at release time — never into the code.
- **`hy-motion/`** — helpers for text→motion, including `make_tpose_char.py` (see above).

One more lives in the repo root: **`node scene-sync.js`** polls your open Blender scene and keeps the
assistant's picture of it current, so it can answer "what is in the scene" without asking Blender each
time. It is a **separate, optional process** — the server does not start it — and it is tuned by the
`sceneSync` block in the config. Without it the assistant still works; its scene view is just only as
fresh as the last import or explicit refresh.

## Configuration

Phoenix creates `phoenix-config.json` from `phoenix-config.example.json` on first run (or copy it yourself — `copy` on Windows, `cp` on macOS/Linux). Key fields:

- **`seats`** — which model each role uses (`orchestrator`, `metaprompter`, `troubleshooter`, `vision`, and `utility` — the *category provider*, the small model that picks a category for a prop). Each seat has a **`provider`**: `claude-cli` (your Claude Code login, the default), `codex-cli` (your ChatGPT plan through the Codex CLI — an empty `model` means Codex's own default), or `openai-compat` with an `endpoint` name from `endpoints` (`local` = a local server such as LM Studio / llama.cpp, no key; a cloud entry names an `apiKeyRef` — keys live in `.secrets/`, never in this file). A seat without `provider` still works: a model named `claude*` uses the CLI, anything else the local server. Easiest is *Settings ▸ Brains*, which also runs the tool / vision tests. The orchestrator's chat history is sized in tokens to the seat's context (read from a local server, 200k for the CLI seats, or set `seats.orchestrator.contextTokens`), and a small meter under the chat input shows how full the request is.
- **`endpoints`** — ComfyUI + local‑model URLs. `comfyui` runs your image, mesh **and** i2i/edit
  workflows; optional **`comfyui_bild`** is a *second* ComfyUI instance for i2i workflows tagged
  `instance:'bild'` — only needed if you run Qwen‑Image‑Edit and Trellis in separate environments
  (see *Edit an image (i2i)*). Leave it out and everything runs on the one `comfyui`.
- **`hyMotion`** — text→motion: `api` (a ComfyUI with the HY‑Motion nodes installed — the same one as
  `endpoints.comfyui` is fine) and `template` (the T‑pose FBX it retargets against). See *Text → motion* above.
- **`voice`** — the Audio workspace: `api` (a CrispASR speech server — local or on your GPU box, e.g.
  `http://gpu-box.local:8090`; leave it empty and CrispASR speech and SFX generation stay unconfigured — Chatterbox still works through the dispatcher) and `ffmpeg` (path to an ffmpeg binary
  for the effects; leave empty to auto‑detect the one bundled with `imageio‑ffmpeg`). The picker's
  non‑default engine Chatterbox needs a dispatcher: normally just switch on **Settings → Voice engines → Run
  voice engines on this PC** (writes `voice.dispatcher: { "local": true, "port": 8091 }` and
  `voiceInstall.voice` for you, plus `voice.watermark` — default on — and `voice.consentAck`). `voice.api`
  can stay empty for Chatterbox. Your own voice, your characters: only clone a voice you own or have consent for.
- **`comfyInstall`** / **`voiceInstall`** — optional; what the Workflow Library's **⬇ Acquire** button
  needs to fetch a workflow's missing models / custom nodes (or a voice engine) for you. One key per
  instance → `{ root, via }`: `root` is the ComfyUI checkout (models land in `root/models`, custom nodes
  in `root/custom_nodes`) or the voice/bench root; `via` is `"local"` (default — install onto **this**
  machine) or `"supervisor"` (install on another host over `endpoints.rigSsh`). Image and mesh workflows
  (no explicit instance) resolve under the **`trellis`** key, so a single‑machine user sets
  `comfyInstall.trellis = { "root": "<your ComfyUI folder>", "via": "local" }`; i2i workflows tagged
  `instance:'bild'` use `comfyInstall.bild`; the one voice endpoint uses `voiceInstall.voice`. **Left out
  (or a workflow's instance absent), Acquire shows "manual" and you place the files yourself** — never a
  silent install to some default location. Note: on **Windows** (`via:"local"`) the **Chatterbox** Acquire runs
  without a shell (it needs Python 3.12, builds the venv and installs CUDA torch); engines with git + requirements
  steps (CosyVoice class) still need a **Linux/macOS** target, and cancelling a voice acquire on a Windows host
  may not stop the in‑flight step (Windows has no process‑group kill). ComfyUI Acquire is portable either way.
- **`feedback.endpointUrl`** — optional. Set it to a URL that accepts a JSON `POST` and the in‑app
  Feedback form's **Send feedback** posts there; leave it empty and **Send by email** opens your mail
  program with a draft instead.
- **`feedback.mailTo`** — the address that mail draft goes to (default `info@laconova.com`).
- **`gates`** — which stages pause for approval (`prompt` / `image` / `mesh`), plus **`gates.vision`**
  (`off` / `focused` / `full`) — after a scene‑changing action Phoenix renders the viewport and has a
  model *look at it*, instead of reporting "fixed ✓" from text alone. `focused` is the default and
  covers the animation/mesh/brush tools; `full` adds asset placement and `blender_run`. The seat that
  does the looking is **`seats.vision`**.
- **`gates.mode`** — the default run mode, `ask` or `auto` (the toggle above the chat input picks per message). Tool steps per turn: `orchestrator.maxToolCalls` (Ask, default 3) and `orchestrator.maxToolCallsAuto` (Auto, default 8).
- **`checkpoints`** — `{ enabled, keep, maxGB }`: save a scene copy before scene‑changing steps (default on), how many to keep (1–100, default 10) and the disk budget in GB (default 2). All three are in *Settings ▸ Storage & checkpoints*.
- **`mcp`** — `allowBlenderRun`, `allowUnrealRun`, `allowDelete`: the three MCP tools that are off until you enable them (*Settings ▸ Connections*).
- **`remesh`** — `{ enabled, provider: "meshy", topology, targetPolycount, maxUploadMB }`: the optional paid Meshy remesh (off by default; the key is stored in `.secrets/`). `topology` / `targetPolycount` are the defaults the Library's Remesh dialog opens with.
- **`apps`** — local paths: `blender` (the Blender executable), `comfyOutput` (the folder Phoenix
  reads ComfyUI's generated files from; leave empty to use the default `~/Documents/ComfyUI/output`),
  `unrealEngine` (your UE install folder — optional, Phoenix otherwise takes the newest `UE_*` it finds),
  and `python` (a real Python 3 for the Unreal bridge if `python` isn't already on your PATH — see
  **Connect Unreal**).
  Also `codex` — the full path to the Codex CLI binary, only needed if Phoenix cannot find `codex` itself.
- **Advanced environment overrides** — `GEMMA_MODEL` replaces the metaprompter's model and `LOCAL_API` replaces the `endpoints.local` URL, for the current process only. Normally you set these in the config or Settings instead.

Runtime/user files (`phoenix-config.json`, `workflows.json`, `palette.json`, `output/`, …) are git‑ignored — Phoenix recreates them on first run.

## License

[MIT](LICENSE) © 2026 Laconova
