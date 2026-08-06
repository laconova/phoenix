# i2i material edit comes back black — or unchanged

**Symptoms:** an i2i / Edit instruction like *"change the material to bronze / stone / dark metal"*
returns a **black image** · or the tile comes back **basically unchanged** (still wood) · turning the
**strength (CFG)** slider up or down doesn't help · rewording ("warm gold", "oxidized bronze") doesn't help.
**Applies to:** i2i · qwen-image-edit
**Root cause:** the shipped edit model is **Qwen-Image-Edit-2509 at the Q3_K_M quant** — the size that
fits a 10 GB card. Q3 has a **measured material-fidelity ceiling** (2026-08-06): some deep material
swaps either collapse to black or are ignored, and this is **not reachable by CFG** (a full 2.5–4.0
sweep at a fixed seed all failed; 3.5–4.0 also add white edge artifacts, ~3.0 is cleanest) **nor by
wording.** It is a model-capacity limit, not a setting you got wrong.

## Fix — explain it
Q3 is a heavy compression of the edit model; it keeps *appearance* edits (colour, weathering, surface
detail, style) but loses the capacity for a full material-class change. Options:
- **Stay in what it can do:** "make it rusty and weathered", "turn the cloak deep red", "add moss" —
  these land. A total material swap (wood → cast bronze) often won't.
- **Change it at the source instead:** regenerate the base *image* with the material in the prompt, then
  mesh — the image model has the capacity the Q3 editor lacks.
- **Bigger card?** A higher quant (Q4_K_S 12.2 GB … Q8 21.8 GB) has more material capacity — but you
  can't edit it into the builtin (Verified workflows aren't editable). Instead: copy
  `workflows/qwen_image_edit.json`, change `UnetLoaderGGUF`'s `unet_name` to the larger `.gguf`, and add
  it as a NEW custom i2i workflow (Workflows tab → **+ Add workflow** → stage **i2i**). The larger quants
  exceed 10 GB → CPU offload → much slower, so they aren't shipped by default.

## Verify
Run an *appearance* edit ("make it rusty and weathered") — if that lands as a visible tile change, the
engine works and the black/no-change result is the Q3 material ceiling, not a broken install.

## Notes
- **This is not an error state** — nothing throws; the run "succeeds" with a black or unchanged tile.
  Your eye is the judge, not the log.
- Structure removal and new camera angles are a *different* limit the same model has — see the Edit-tab
  help text; use **SAM3 Isolate** for cutting parts out, not the edit engine.
