# Phoenix — Roadmap

Where Phoenix is and where it's going. This is a living document — order and scope will shift
as the project (and feedback) evolve, and the further out an item is, the less fixed it is.
Phoenix is **alpha**: usable, but early.

## Now (this release)

The core text → 3D prop pipeline, driven from one browser UI — now with a choice of brain per role, Ask/Auto run modes, scene checkpoints and an MCP server (see *New in 1.9.0* below):

- **Chat-driven generation** with per-stage gates (prompt · image · mesh) — plus a **vision gate**
  (`off` / `focused` / `full`) that renders the viewport after a scene-changing action and has a model
  look at it, so "fixed ✓" has to be *seen* rather than assumed.
- **Field-aware, workflow-agnostic engine** — every workflow is a small *node-map*, so Phoenix
  can drive any ComfyUI graph.
- **Workflow registry** — *Verified* (shipped) workflows + **add your own** (upload an API-format
  ComfyUI JSON, Phoenix infers the node-map + dependencies, you review and save as *Custom*).
- **Live per-workflow dependency status** — see what actually runs on your machine.
- **Style palette** — editable per-category style presets.
- **Asset library** — staged assets, brushes, materials.
- **First-run onboarding wizard** — detects prerequisites, links to fixes, walks you to your first prop.
- **Troubleshooter** — an LLM assistant that checks your local stack and helps get deps running.

New in **1.6.0** — characters and animation, alongside the prop pipeline:

- **Human tab** — parametric people built straight into your open Blender scene through MPFB2
  (MakeHuman's engine): body and face sliders, skin/hair/clothes, preview before you commit.
  Guide: [`human-tab-guide.md`](human-tab-guide.md).
- **Character library** — save a finished rigged figure (meshes, packed textures, skeleton) and
  spawn it back later. Stores the real geometry, so your own edits survive; works equally for a
  character you rigged yourself at mixamo.com.
- **Animation** — retarget Mixamo FBX clips onto any rigged character, chain them into sequences
  blended at the seams, and save the result as a reusable clip. One shared clip library: every clip
  fits every character.
- **Text → motion** *(optional)* — describe a movement and get a clip back, via HY-Motion in ComfyUI.
- **Custom Rig tab** — skeleton-bound animation for everything that is *not* a standard humanoid:
  creatures, animals, machines. A folder binds one skeleton to its clips and mesh variants, so the
  same animations play on every variant. Includes **rig-to-mesh**: voxel-remesh a generated mesh and
  bind it with automatic weights, with the result measured rather than assumed.

New in **1.7.0** — the Unreal bridge and audio:

- **Unreal Engine bridge** — drive an *already-running* Unreal editor from Phoenix: place a brush or
  spawn a saved character straight into the open level, pull an Unreal asset back out into Blender as
  glTF, and have the assistant screenshot the viewport to check its own work. It talks to Unreal over
  the editor's Python remote execution — Phoenix never launches Unreal. See **Connect Unreal** in the
  README.
- **Voice tab** — a baked voice pack speaks a line, with optional effects. Runs against a CrispASR
  speech server (local or on your GPU box).
- **Sound effects** — generate, audition and edit SFX takes, then save them to a clip or bake them
  onto a character.
- **Mesh preview** — inspect a brush's geometry in the browser (a vendored model-viewer, no CDN)
  before it goes anywhere.

New in **1.8.0** — image editing between the stages:

- **i2i / Edit tab** — a branch between the image and the mesh. Recolour or restyle a reference with
  **Qwen-Image-Edit** (appearance / material / style — not structure removal or a new camera angle),
  or isolate a part on white with **SAM3** for a cleaner mesh. Edits arrive as tiles you can refine
  or send straight to Trellis; the reference is never overwritten. See **Edit an image (i2i)** in the
  README.
- **VRAM & concurrency hardening** — one heavy GPU job runs at a time, and Phoenix frees an idle
  ComfyUI instance before a generation so an edit and a mesh can't collide on a single card. Multiple
  ComfyUI instances (e.g. Qwen-Image-Edit and Trellis in separate environments) are supported via an
  optional second endpoint, while a single-machine setup keeps working unchanged.

New in **1.8.1** — a library that ships with nothing, and a choice of voice:

- **Workflow library — "ship with nothing"** — every built-in workflow now carries an **install
  manifest**: the license it runs under and the exact models / custom nodes it needs. On a fresh
  machine the library shows each workflow with a **license badge** and a real *installed / not
  installed* status, and offers **⬇ Acquire** to fetch what's missing — so nothing large is bundled
  into the download, and you pull only the workflows you actually use. Shipped licenses: Flux-Klein
  Apache-2.0, SD1.5 CreativeML Open RAIL-M, Qwen-Image-Edit Apache-2.0, Trellis2 MIT (plugin code;
  model weights per their model card), SAM3 GPL-3.0. Trellis2 and SAM3 fetch their own weights on
  first run.
- **Voice — multiple engines** — an **engine picker** in the Sound Design workbench. **CrispASR**
  (the default, integrated) works today against your own CrispASR speech server. **Chatterbox** (MIT)
  and **CosyVoice** (Apache-2.0) are shown in the picker but route through a **voice-service
  dispatcher** that isn't part of this release, so they appear greyed out ("coming in a future
  version") for now. Choose and activate an engine from the workflow library and the choice persists
  as your default; `/speak` never silently substitutes an unknown or unavailable engine — it tells you
  what's missing instead.
- **Upgrade pickup** — existing installs pick up newly-shipped built-in workflow definitions on
  upgrade, rather than staying frozen at the set they first seeded.

New in **1.9.0** — your choice of brain, safer automation, and Phoenix as a tool:

- **A provider per seat** — the orchestrator, troubleshooter, metaprompter, vision and category-provider (`utility` in the config) roles each
  pick their own model source: the Claude CLI, the Codex CLI (ChatGPT plan), a local OpenAI-compatible
  server, or an API key. Models that drive tools pass a **tool test** (local ones also a short
  **benchmark**); a non-Claude vision seat passes a **vision test** (a colour card proves it saw the
  render) before it can be saved.
- **Ask / Auto** — Ask stops at the gates; Auto runs to the end and stops only when the render check does
  not clearly confirm a step. Tool steps per turn are budgeted.
- **Checkpoints + rewind** — a copy of the open Blender scene before each scene-changing step (chat and MCP
  alike, taken right where Blender is touched — e.g. a generated mesh right before its import; the Library and
  Human-tab buttons do not take one yet), with a rewind that can itself be undone.
- **Phoenix as an MCP server** — an external agent (Claude Code / Codex / Cursor) can generate props,
  import them and check the result with Phoenix's render vision.
- **GPU share** *(best effort)* — before an image or mesh stage Phoenix asks a local LLM server that shares the
  card (LM Studio, Ollama, llama.cpp router) to unload its model. Only for the llama.cpp router does it wait
  until the model is gone; for LM Studio and Ollama it does not confirm, and if unloading fails the job still runs.
- **Remesh via Meshy** *(optional, paid)* — rebuild a staged mesh's topology in the cloud; a Meshy *quad*
  result gets its quads restored on import (GLB can only store triangles).
- **Resizable, collapsible panels** — drag or collapse the assistant and the Library; Settings is split into
  a General and a Connections tab.

## Near future

- **Foliage / scatter workflow** — the trick that makes generated trees work: mesh a *single* leaf
  (a compact body — what the mesher is good at), then instance it thousands of times over a trunk.
  Leaf size becomes a **dial** instead of a property baked into the mesh. This exists today as a
  script beside Phoenix; the next update brings it *into* Phoenix as a first-class step.
- **PBR material generator** — generate physically-based material sets, not just meshes.
- **Deeper Unreal integration** — the 1.7.0 bridge places assets into a running editor; next is a
  fuller round trip (materials, level layout) and hardening the editor-side setup.
- **Client access** — a thin client that connects to a remote Phoenix server (run the heavy
  stack on one machine, drive it from another).
- **Rigid binding for machines** — robots, vehicles and other hard-surface rigs want each part
  parented to a bone, not weighted deformation. The folder model already carries them; the binding
  step is manual for now.
- **Clean retopology, locally** — 1.9.0 adds a paid, opt-in cloud remesh through Meshy (with quads restored
  on import); 1.6.0's local remesh is a *voxel* remesh, which is what automatic weights need but is not a
  quality retopo. Proper local retopology (and baking detail back onto it) is still the next step.

## Middle future

- **Video generation** — a video stage beyond the current image/mesh pipeline.
- **Live motion capture** — drive animation from live mocap.
- **Depth-to-video** — depth-conditioned video generation.

## Further out (no fixed timeframe)

- **Better AI helpers in each department** — stronger per-module assistance, especially for
  **Unreal coding**.
- **More Verified workflows** — broaden the shipped, vetted set.
- **Cloud-based workflows** — run workflows on remote/cloud compute, not only the local box.
- …and likely more — the pipeline is built to grow new stages and integrations.

## Known limitations

- **Background isn't always clean.** Some `flat`-style props still render on a surface/"carpet"
  instead of a pure white background. The **style palette is the escape hatch** — edit the category's
  style preset to tune the look. Better shipped defaults are on the list.
- **Workflows only run if their models/custom-nodes are present.** The Workflows tab shows a live
  dependency badge; a red badge means something is missing on your machine. The Troubleshooter helps
  locate what's missing.
- **Prerequisites are real.** ComfyUI + multi-GB models + one brain of your choice (Claude CLI, Codex CLI, a local model server or an API key) are required for a full run.
  The onboarding wizard guides you, but it can't install them for you.
- **Wizard / Settings corners (1.9.0).** The Settings dialog tests a seat against the *local* endpoint URL typed there, but only that one
  (not ComfyUI's); a changed local URL starts a fresh test result rather than inheriting the old one (entries written before 1.9.0 stay valid).
  The "controls stuck after a lost completion" fix asks the server once when the live stream (re)opens; a request sent in the same instant can
  still release the UI one moment early. Unloading a model on a *remote* LM Studio is not possible from here — Phoenix says so instead of
  running the local `lms`; the "unload after use" option of the metaprompter still uses the local `lms` only.

- **Meshy records use the wall clock.** The 3-day life of a paid-task record and the 15-minute hold after an unconfirmed remesh are measured with the system clock; a large clock jump
  (manual change, a long suspend, a wrong time after boot) can shorten or extend either of them. A remesh costs about 5 credits; check the Meshy dashboard (Tasks) if in doubt.

## Philosophy

Local-first, legible, zero-npm-dependency Node. Phoenix should *welcome, detect, guide, verify, and
walk you to first success* — never silently fail because a prerequisite isn't there.

---

Feedback and issues are welcome — they shape this list.
