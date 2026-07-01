# Phoenix workflow file not found — stale drive path / wrong active workflow

**Symptoms:** `UNKNOWN: unknown error, open '...\workflows\....json'` with a drive that isn't there
(`Z:\`, `E:\`) · "Can't generate — missing models for workflow Flux Klein" on a machine that should
be using sd15 · gen fails immediately after the metaprompt succeeds.
**Applies to:** phoenix · runtime
**Root cause:** the runtime `workflows.json` stores **absolute** file paths from wherever it was first
seeded (an old E:/Z: drive). After the workspace moved, those paths are dead. Separately, the active
image workflow defaults to `flux_klein` if `phoenix-config.json` has no `workflows` override — and
Flux won't fit an 8 GB laptop GPU anyway.

## Fix — do it for me
1. In `workflows.json`, rewrite each `"file"` path to the current location (fix the drive letter).
2. In `phoenix-config.json`, set `"workflows": { "image": "sd15", "mesh": "trellis2" }` (laptop = sd15).
3. ⟳ restart `server.bat` — the workflow registry is loaded into memory at startup.

## Fix — explain it
Phoenix remembers the full path to each workflow file. Those paths point at a drive that no longer
exists, so it can't open them. Fix the paths, and tell it to use the light SD1.5 workflow instead of
Flux (which is too big for this GPU).

## Verify
`node -e "const w=require('./workflows.json'),c=require('./phoenix-config.json'),fs=require('fs');const e=w.workflows[c.workflows.image];console.log(e.file, fs.existsSync(e.file))"` → path + `true`; a gen loads the workflow.

## Notes
`workflows.json` and `phoenix-config.json` are **gitignored runtime files** — editing them does NOT
affect the repo or the eventual push. The in-memory registry means a restart is required.
