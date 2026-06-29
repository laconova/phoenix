# Phoenix — Roadmap

Where Phoenix is and where it's going. This is a living document — order and scope will shift
as the project (and feedback) evolve, and the further out an item is, the less fixed it is.
Phoenix is **alpha**: usable, but early.

## Now (this release)

The core text → 3D prop pipeline, driven from one browser UI:

- **Chat-driven generation** with per-stage gates (prompt · image · mesh).
- **Field-aware, workflow-agnostic engine** — every workflow is a small *node-map*, so Phoenix
  can drive any ComfyUI graph.
- **Workflow registry** — *Verified* (shipped) workflows + **add your own** (upload an API-format
  ComfyUI JSON, Phoenix infers the node-map + dependencies, you review and save as *Custom*).
- **Live per-workflow dependency status** — see what actually runs on your machine.
- **Style palette** — editable per-category style presets.
- **Asset library** — staged assets, brushes, materials.
- **First-run onboarding wizard** — detects prerequisites, links to fixes, walks you to your first prop.
- **Troubleshooter** — an LLM assistant that checks your local stack and helps get deps running.

## Near future

- **PBR material generator** — generate physically-based material sets, not just meshes.
- **MakeHuman connection** — bring in MakeHuman character base meshes.
- **Unreal Engine connection** — export / hand assets straight into Unreal.
- **Client access** — a thin client that connects to a remote Phoenix server (run the heavy
  stack on one machine, drive it from another).
- **Mesh rigging** — turn generated meshes into animation-ready, rigged assets.
- **Remesh** — clean retopology / remeshing of generated meshes.

## Middle future

- **Video generation** — a video stage beyond the current image/mesh pipeline.
- **Live motion capture** — drive animation from live mocap.
- **Sound editing** — audio in the pipeline alongside the visuals.
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
