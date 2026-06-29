# Phoenix — Roadmap

Where Phoenix is and where it's going. This is a living document — order and scope will shift
as the project (and feedback) evolve. Phoenix is **alpha**: usable, but early.

## Now (v1.x — this release)

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

## Next

- **Onboarding polish** — celebrate the first successful generation; richer "how it works" explainer.
- **Remote / client mode** — run the heavy stack (ComfyUI + models + Claude) on one machine and
  connect from another. The server already does the work; this splits the networking so a thin client
  can point at a remote Phoenix server.
- **More Verified workflows** — broaden the shipped image/mesh set; a clearer path for community
  workflows to graduate from *Custom* → *Verified*.
- **Better defaults** — tighter prompt/style presets so props come out clean on a plain background
  more consistently (see *Known limitations*).

## Later

- **New pipeline stages** — e.g. a **video** stage (image/depth → video) beyond the current
  image/mesh contract; this needs new node-map slots + an engine path.
- **Deeper Blender integration** — smoother import + scene-sync round-trips.
- **Rigging** — turning generated meshes into animation-ready assets.
- **Packaged distribution** — a friendlier install path for non-developers (the local AI stack —
  ComfyUI, models, drivers — is the real barrier, not Phoenix itself).

## Known limitations

- **Background isn't always clean.** Some `flat`-style props still render on a surface/"carpet"
  instead of a pure white background. The **style palette is the escape hatch** — edit the category's
  style preset to tune the look. Improving the shipped defaults is on the *Next* list.
- **Workflows only run if their models/custom-nodes are present.** The Workflows tab shows a live
  dependency badge; a red badge means something is missing on your machine (e.g. an SDXL checkpoint
  that isn't downloaded). The Troubleshooter helps locate what's missing.
- **Prerequisites are real.** ComfyUI + multi-GB models + the Claude CLI are required for a full run.
  The onboarding wizard guides you, but it can't install them for you.

## Philosophy

Local-first, legible, zero-npm-dependency Node. Phoenix should *welcome, detect, guide, verify, and
walk you to first success* — never silently fail because a prerequisite isn't there.

---

Feedback and issues are welcome — they shape this list.
