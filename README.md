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
  you ──chat──▶ Phoenix (Node, :7777) ──HTTP──▶ ComfyUI (:8000)
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

## Features

- **Chat‑driven generation** with per‑stage gates (prompt / image / mesh).
- **Workflow registry** — *Verified* (shipped) workflows plus **add your own**: upload a ComfyUI **API‑format** workflow JSON, Phoenix infers the node‑map and dependencies, you review/correct it in a form, and it's saved as a *Custom* workflow. Live per‑workflow dependency status.
- **Style palette** — editable per‑category style presets that shape the look of your props.
- **Asset library** — staged assets, brushes, materials.
- **Troubleshooter** — an LLM assistant that checks your local stack (ComfyUI · models · Blender) and helps get missing dependencies running.

### Add your own workflow

Workflows tab → **+ Add workflow** → pick the stage (image / mesh) → upload a ComfyUI workflow exported as **"Save (API Format)"** → **Analyze with Phoenix**. Phoenix proposes the node‑map (which node receives the prompt, seed, steps, output, …) and the required custom nodes / models from the graph. Review the dropdowns, give it a name, and save. Only `positive` + `output` (image) / `image` + `output` (mesh) are required; anything you don't map keeps the workflow's own built‑in value.

## Configuration

Phoenix creates `phoenix-config.json` from `phoenix-config.example.json` on first run (or copy it yourself — `copy` on Windows, `cp` on macOS/Linux). Key fields:

- **`seats`** — which model each role uses (`orchestrator`, `metaprompter`, `troubleshooter`).
- **`endpoints`** — ComfyUI + local‑model URLs.
- **`gates`** — which stages pause for approval (`prompt` / `image` / `mesh`).
- **`apps`** — local paths: `blender` (the Blender executable) and `comfyOutput` (the folder Phoenix
  reads ComfyUI's generated files from; leave empty to use the default `~/Documents/ComfyUI/output`).

Runtime/user files (`phoenix-config.json`, `workflows.json`, `palette.json`, `output/`, …) are git‑ignored — Phoenix recreates them on first run.

## License

[MIT](LICENSE) © 2026 Laconova
