# Text→motion returns a hunched figure (T-pose template)

**Symptoms:** a generated motion plays but the character is **hunched, shoulders rolled forward,
forearms bent in front of the body** · every prompt comes out like that, no matter how it is worded ·
the pose looks "wrong" rather than the motion · *or*: you replaced the template FBX and the result
did not change at all.
**Applies to:** hy-motion · runtime
**Root cause:** HY-Motion retargets its generated motion onto a **character FBX template**, and that
template must be in the **Mixamo rest pose (T-pose)**. Given an A-pose rig instead — which is what
MPFB and most character exports produce — generation still reports **success** and simply bakes the
A-pose offset into every clip. Nothing errors out, so it reads as a bad model instead of a setup gap.

## Fix — do it for me
1. Build a T-pose template once from any Mixamo-rigged character FBX:
   ```bash
   blender --background --python scripts/hy-motion/make_tpose_char.py -- <char.fbx> <char_tpose.fbx>
   ```
2. Copy the result into the **HY-Motion ComfyUI's** `input/3d/` folder (that is the ComfyUI at
   `hyMotion.api`, not necessarily the one at `endpoints.comfyui`).
3. Set `hyMotion.template` in `phoenix-config.json` to its path relative to that ComfyUI folder,
   e.g. `input/3d/phoenix_char_tpose.fbx`.
4. Restart the Phoenix server (config is read at startup). ⟳ restart + refresh.

⚠️ **If you are REPLACING an existing template, give the new file a NEW NAME.** ComfyUI caches on the
**path string**, not on file contents: overwrite `phoenix_char_tpose.fbx` in place and the next run
reports `success` while quietly re-exporting the *old* geometry. Rename (e.g. `..._tpose_v2.fbx`),
update `hyMotion.template`, restart.

## Fix — explain it
The template does not decide what your character looks like — it decides the **proportions and rest
pose the motion is generated against**. Phoenix scale-matches the finished clip onto whatever
character is actually in your scene, so one clean T-pose template serves every character you own.
It only has to be a T-pose, because that is the rest pose the model was trained to write motion for.

## Verify
Generate a short clip ("a person walks forward") and look at frame 1: arms should hang naturally
along the sides, not be locked in front of the chest. Same prompt, same seed, upright figure = fixed.

## Notes
`node preflight.js` **cannot** confirm this for you. ComfyUI's file listing (`/internal/files/input`)
is a flat scan that never descends into subfolders, so a template inside `input/3d/` is invisible to
it — the preflight therefore reports "not verifiable from here" rather than claiming it is missing.
Absence of the file is never proven by that listing; the hunched figure is the real signal.
