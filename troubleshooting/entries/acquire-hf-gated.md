# Acquire fails with HTTP 401 / 403 (gated or moved model)

**Symptoms:** *"Acquire failed for …"* with `download failed HTTP 401 for https://huggingface.co/…/resolve/main/…` or
`download failed HTTP 403 for …`.
**Applies to:** acquire · models · huggingface
**Root cause:** Phoenix downloads models with a plain `https://huggingface.co/<repo>/resolve/main/<path>` request.
**Phoenix has no Hugging Face token support, so it cannot download gated models** — a model that needs you to log in
or accept a licence answers 401/403 and the download stops. The built-in workflows use ungated mirrors, so this
normally means a custom workflow that points at a gated repository, or a model that has been moved or made private.

## Fix — do it for me
1. Open the URL from the error message in your browser, sign in to Hugging Face and accept the model's licence on its page.
2. Download the file yourself.
3. Put it by hand in the folder the workflow expects: `<root>/models/<dir>/<filename>`, where `<root>` is
   `comfyInstall.<instance>.root` in `phoenix-config.json` and `<dir>` / `<filename>` are the workflow's
   `install.models[].dir` and file name.
4. Refresh the Library — the row turns to *installed* once the file is present.

## Fix — explain it
Acquire only knows how to fetch public files. For a gated model the download has to happen in your own logged-in
browser; Phoenix then just needs the file in the right folder. There is nothing to configure in Phoenix to make a
gated download work.

## Verify
The Library row for the workflow shows the model as present (no ⬇ Acquire needed), and the workflow runs.

## Notes
A 404 or other HTTP status in the same `download failed HTTP <status> for <url>` message is a different problem
(wrong or removed path) — check the URL in a browser first.
