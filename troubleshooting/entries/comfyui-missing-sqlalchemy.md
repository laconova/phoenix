# ComfyUI won't start — `No module named 'sqlalchemy'`

**Symptoms:** ComfyUI exits immediately at startup · traceback ends in
`app/assets/database/queries/asset.py: import sqlalchemy as sa` → `ModuleNotFoundError: No module
named 'sqlalchemy'` · Phoenix reports "Can't reach ComfyUI" / connection refused although nothing in
Phoenix changed · **mesh generation stops working across the board**.
**Applies to:** comfyui · trellis · install · after a ComfyUI update

## Root cause
Newer ComfyUI (≥ 0.27) added an **asset database** that imports `sqlalchemy` at startup, before any
node is loaded. A `git pull` of ComfyUI does not install new requirements, so the server dies on the
first import. Nothing is wrong with Trellis, the models, or Phoenix.

⚠️ **Why this hurts more than it looks:** Trellis lives inside the same ComfyUI server. When ComfyUI
won't boot, Phoenix's *entire* mesh stage is dead — and the failure surfaces as a Phoenix networking
error, which sends you looking in the wrong place.

## Fix — do it for me
Install into **ComfyUI's venv**, not the system Python:

```bash
cd ~/ComfyUI
./venv/bin/pip install sqlalchemy alembic
./venv/bin/python main.py --listen 0.0.0.0 --port 8188
```

On Windows use `python_embeded\python.exe -s -m pip install sqlalchemy alembic`.

## Fix — explain it
ComfyUI gained a database layer. The library that talks to that database wasn't installed when
ComfyUI updated itself. Installing it makes the server boot again — it doesn't change any model or
workflow.

## Verify
```bash
curl -s http://127.0.0.1:8188/system_stats | head -c 120     # returns JSON, not empty
grep -iE "ModuleNotFound|Traceback" /tmp/comfy-*.log         # no hits
```
Then run one Phoenix mesh job end-to-end.

## Notes
- ⚠️ **Start ComfyUI with `./venv/bin/python`, never bare `python3`.** The system Python has no torch
  at all; starting with it produces a *different*, misleading missing-module error.
- If another `No module named 'X'` appears after this fix, install X in the same venv and repeat —
  same loop as `trellis-small-python-deps`.
- Found 2026-07-22 while setting up HY-Motion: the server had been broken since the last ComfyUI
  update and nobody noticed, because no mesh job had been run in between.
