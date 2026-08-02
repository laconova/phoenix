# Phoenix — Roadmap

Where Phoenix is and where it's going. This is a living document — order and scope will shift
as the project (and feedback) evolve, and the further out an item is, the less fixed it is.
Phoenix is **alpha**: usable, but early.

## Now (this release)

The core text → 3D prop pipeline, driven from one browser UI:

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
- **Clean retopology** — 1.6.0 ships a *voxel* remesh, which is what automatic weights need but is
  not a quality retopo. Proper retopology (and baking detail back onto it) is the next step.

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
- **Prerequisites are real.** ComfyUI + multi-GB models + the Claude CLI are required for a full run.
  The onboarding wizard guides you, but it can't install them for you.

## Philosophy

Local-first, legible, zero-npm-dependency Node. Phoenix should *welcome, detect, guide, verify, and
walk you to first success* — never silently fail because a prerequisite isn't there.

---

Feedback and issues are welcome — they shape this list.
