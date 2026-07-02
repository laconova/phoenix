# LM Studio won't start on Linux (AppImage: FUSE2 + display + sandbox — three stacked traps)

**Symptoms:** `dlopen(): error loading libfuse.so.2` · "AppImages require FUSE to run" · LM Studio
never appears when started over SSH · `lms server start` → "Waking up LM Studio service…" then
`Timed out waiting for LM Studio daemon to start` · `lms bootstrap` → "Cannot find LM Studio
installation" · Phoenix preflight says LM Studio is absent on a Linux machine where it's installed.
**Applies to:** lmstudio · linux · onboarding
**Root cause:** THREE independent Linux traps stack on Ubuntu 24.04:
1. Ubuntu ≥22.04 ships **FUSE 3 only**; AppImages need `libfuse.so.2` → the AppImage refuses to run at all.
2. LM Studio is an **Electron GUI app** — with no display (SSH session, headless box) it cannot start,
   and `lms server start` can't cold-start it either (its spawned daemon dies display-less → the timeout).
3. Ubuntu 24.04's **AppArmor blocks unprivileged user namespaces** → the Chromium sandbox crashes
   unless the app runs with `--no-sandbox`.

## Fix — do it for me (proven live 2026-07-02 on the rig; NO sudo needed)

1. **Extract instead of FUSE-mounting** (kills trap 1 without installing anything):
   ```bash
   cd ~/apps && ./LM-Studio.AppImage --appimage-extract   # → squashfs-root/
   ```
2. **One GUI first-run** — this seeds `~/.lmstudio/` incl. the `lms` CLI. Check `who` first: a `:1`
   entry means a local desktop session exists → borrow its display:
   ```bash
   DISPLAY=:1 nohup ./squashfs-root/lm-studio --no-sandbox --minimized >/tmp/lmstudio.log 2>&1 &
   sleep 20 && ls ~/.lmstudio/bin   # should now contain: lms
   ```
3. **Start the API server** (app from step 2 keeps running):
   ```bash
   export PATH="$HOME/.lmstudio/bin:$PATH"
   lms server start
   ```
4. **Verify:** `curl http://localhost:1234/v1/models` → HTTP 200 JSON → point Phoenix's
   `endpoints.lmstudio` at `http://localhost:1234`.

*(With sudo available: `sudo apt install libfuse2t64` makes the AppImage itself runnable — steps 2–4
unchanged. Truly no desktop session anywhere: `sudo apt install xvfb`, then `xvfb-run -a` replaces
`DISPLAY=:1`.)*

## Fix — explain it
Three things must ALL be true before LM Studio serves on Linux: the AppImage must be able to open
(FUSE2, or sidestep it by extracting), the Electron app must find a display (a real one, a logged-in
local session's `:1`, or a virtual Xvfb one), and Chromium's sandbox must not trip Ubuntu 24.04's
AppArmor rule (`--no-sandbox`). The `lms` CLI only exists AFTER the app has run once — that's why
`lms bootstrap`/`lms server start` on a fresh box fail with confusing errors that look unrelated to
the real cause. Order matters: extract → GUI once → `lms server start`.

## Verify
`lms server status` → "The server is running on port 1234." · `curl http://localhost:1234/v1/models`
returns a model list (the bundled `text-embedding-nomic-embed-text-v1.5` counts — it proves the server).

## Notes
- **`lms server start` alone can NOT cold-start the app** on this setup — start the app first, then lms.
  The "Timed out waiting for LM Studio daemon" error is trap 2+3 wearing a different costume.
- The app+server pair must survive the session: `nohup` (above) covers logout; after a reboot re-run
  steps 2–3, or wrap them in a systemd **user** service for boot persistence.
- Set the models directory to the shared models home (e.g. `/data/_shared/models`) in-app — weights
  never belong on the system disk.
- SSH trap while debugging: `pkill -f lm-studio` kills **your own SSH shell** (the pattern matches the
  remote command line). Use `pkill -x lm-studio`.
- **`lms get` lowercases repo names** → case-sensitive Hugging Face repos fail with "artifact does not
  exist" even though the repo is real (e.g. `lmstudio-community/gemma-4-12B-it-QAT-GGUF`). Workaround:
  `wget -c` the `.gguf` straight from HF into `<models-dir>/<publisher>/<repo>/<file>.gguf` — LM Studio
  indexes plain files fine.
- **The running instance only indexes the models dir at startup** — a model downloaded/copied in while
  it runs won't show in `lms ls`. Restart the app (pkill -x → relaunch → `lms server start`).
- Models dir on a data disk without touching the GUI: symlink it —
  `ln -s /data/_shared/models/lmstudio ~/.lmstudio/models` (proven working incl. GPU load).
