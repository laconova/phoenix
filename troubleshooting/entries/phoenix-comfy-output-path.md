# Mesh finishes in ComfyUI but Phoenix errors collecting it (wrong output dir)

**Symptoms:** `Stage error: ENOENT: no such file or directory, scandir '…/ComfyUI/output'` right after
a long mesh run · ComfyUI log says `Prompt executed in …s` (success!) and the `.glb` exists in
ComfyUI's own `output/` folder, but Phoenix reports a failed stage and `output/<cat>/` gets no mesh.
**Applies to:** mesh · config · runtime
**Root cause:** **`apps.comfyOutput`** in `phoenix-config.json` is **empty or wrong**, so Phoenix
falls back to a guessed default (`~/Documents/ComfyUI/output` — the ComfyUI-Desktop default) that
doesn't match the actual install (portable/custom dirs like `~/ComfyUI-trellis/output`). The
generation succeeded — only the result pickup looked in the wrong place.
⚠️ The key lives under **`apps`**, NOT under `endpoints` — putting it in `endpoints` silently does
nothing (found the hard way, twice, 2026-07-02).

## Fix — do it for me
1. Find the real output dir: it's `<your ComfyUI folder>/output` — confirm with
   `ls <comfyui-dir>/output` (your fresh `.glb` should be there).
2. Set it in `phoenix-config.json` (note: the `apps` section):
   ```json
   "apps": { "blender": "...", "comfyOutput": "<your ComfyUI folder>/output" }
   ```
3. Re-run the stage (or restart `server.bat` first if using the UI — config is cached at startup).

## Fix — explain it
ComfyUI writes results into its own `output/` folder; Phoenix must scan that folder to copy the mesh
into the Phoenix output tree. The API tells Phoenix *that* the job finished, not *where* the file
lives on disk — that path comes from config. Empty `comfyOutput` = Phoenix guesses = ENOENT on any
non-default install.

## Verify
Re-run mesh → log ends with a `RESULT_MESH:` path under Phoenix's `output/<category>/` and the `.glb`
is copied there.

## Notes
The wasted run isn't fully wasted: the `.glb` already sits in ComfyUI's `output/` — you can copy it
out by hand. Onboarding should set `comfyOutput` whenever it sets `comfyui` (they always travel together).
