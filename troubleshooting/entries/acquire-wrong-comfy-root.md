# Acquire has no target (comfyInstall root missing or wrong)

**Symptoms:** Acquire says `no acquisition target configured for instance "<instance>" — set comfyInstall.<instance>.root
in phoenix-config.json, or install manually` · the voice twin `… voice instance "<instance>" — set voiceInstall.<instance>.root …`
· `"<folder>" already exists and is not a git repository — refusing to overwrite it (move it aside and retry)` ·
files land in the wrong place / the workflow still shows missing models after a successful Acquire.
**Applies to:** acquire · config · comfyui
**Root cause:** Acquire only installs where `phoenix-config.json` tells it to — it never guesses a default location.
`comfyInstall.<instance>.root` must be **the ComfyUI folder itself, the one that contains `models/` and `custom_nodes/`**
(Phoenix installs models into `<root>/models` and custom nodes into `<root>/custom_nodes`). Image and mesh workflows
(no explicit instance) use the instance name `trellis`; i2i workflows tagged `instance:'bild'` use `comfyInstall.bild`;
the voice endpoint uses `voiceInstall.voice`. A root that points one level too high or too low puts files where ComfyUI
does not look, and a custom-node target that is an ordinary (non-git) folder triggers the "not a git repository" refusal.

## Fix — do it for me
1. Open `phoenix-config.json` and set, for a single machine:
   `"comfyInstall": { "trellis": { "root": "<your ComfyUI folder>", "via": "local" } }`
   (`via` defaults to `local`; `supervisor` also needs `endpoints.rigSsh`).
2. Check that `<root>/models` and `<root>/custom_nodes` really exist inside that folder.
3. Press **⬇ Acquire** again — the Acquire routes read the config on every request, no restart needed.
4. For the *"already exists and is not a git repository"* message: that folder is in the way of a custom-node clone.
   Move it aside (or rename it) and press **⬇ Acquire** again — Phoenix will not overwrite it.

## Fix — explain it
Acquire needs to know which ComfyUI installation to put files into. That answer lives only in `comfyInstall`
(`voiceInstall` for voice engines). Without it, Acquire reports "manual" and you place files yourself; with a wrong root
it installs successfully into a folder ComfyUI never reads.

## Verify
`GET /workflows/acquire-plan?id=<workflow id>` no longer reports a missing target, the Library row offers **⬇ Acquire**
for the right instance, and after it runs the row turns to *installed*.

## Notes
The example config `phoenix-config.example.json` has a `_comment_comfyInstall`
describing the same shape.
