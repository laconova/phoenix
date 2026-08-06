# SAM3 Isolate errors — or the GroundingDINO `Segment` node is broken

**Symptoms:** the **SAM3 Isolate** engine errors · a workflow naming `SAM3Segment` fails to queue ·
`BertModel.get_head_mask` / a `transformers` error when using the RMBG suite's `Segment` /
GroundingDINO node · the isolate result is empty or returns the whole image · a hand-built SAM3
workflow fails on a missing/positional `device`.
**Applies to:** i2i · comfyui-rmbg · install
**Root cause:** two separate traps in the ComfyUI-RMBG suite. (1) The **GroundingDINO-based `Segment`
node is broken on some installs** — a transformers version conflict surfacing as
`BertModel.get_head_mask`. Phoenix's builtin isolation engine uses **`SAM3Segment`**, which sidesteps
it entirely. (2) `SAM3Segment`'s **`device` input, although shown as "optional", is positionally
required** by the node — a workflow that omits it fails to run.

## Fix — do it for me
1. Use the builtin **`sam3_isolate`** workflow (engine picker → "SAM3 Isolate"). It already sets
   `device:"Auto"` and passes every optional input explicitly, so it runs as-is.
2. Confirm the model is present: `sam3.pt` (~3.2 GB) under `…/ComfyUI-RMBG/models/sam3/`. It loads
   internally — there is no `model_name` input to set.
3. Do **not** try to fix the GroundingDINO `Segment` node for isolation — SAM3 is the working path.

## Fix — explain it
The RMBG suite ships more than one segmenter. The text-box `Segment` (GroundingDINO) path is fragile
against transformers versions; SAM3 is the robust one and is what Phoenix wires. If you build your own
i2i/segment workflow through the Workflows editor, copy the builtin's node exactly — especially the
`device` field, which the node demands even though ComfyUI labels it optional.

## Verify
Isolate "the main subject" on any image → a clean cutout on a white background in ~9–12 s, deterministic
(no seed). Parts are complementary (isolate "the head", then "the body" → they fit back together).

## Notes
- SAM3 is the reliable **structure-removal / part-isolation** engine; the Qwen edit engine cannot cut
  parts out (measured 2026-08-05). Route "remove/isolate a part" to SAM3, "recolour/restyle" to Qwen.
- Output is on white/alpha → Trellis-ready, so an isolated part can go straight to → 3D.
