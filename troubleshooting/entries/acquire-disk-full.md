# Acquire stops: not enough disk space

**Symptoms:** a Library **⬇ Acquire** ends with *"Acquire failed for …"* and an error such as
`needs 24.5 GB disk at <folder>, 11 GB free` · or a raw OS error `ENOSPC` / `no space left on device`
part-way through a download.
**Applies to:** acquire · install · disk
**Root cause:** the drive that holds the target folder has less free space than the workflow's models need.
Phoenix checks this *before* it downloads anything (the `needs X GB disk at <root>, Y GB free` message names the
folder it measured). `ENOSPC` is the same problem arriving late: the drive filled up while a file was being written.

## Fix — do it for me
1. Free space on the drive named in the error (or point `comfyInstall.<instance>.root` in `phoenix-config.json` at a
   ComfyUI folder on a drive with room — models land in `<root>/models`, custom nodes in `<root>/custom_nodes`).
2. Press **⬇ Acquire** again.

## Fix — explain it
Acquire fetches model files into the ComfyUI folder you configured. The disk check compares the workflow's declared
download size with the free space on that folder's drive and refuses to start when it will not fit. Nothing is deleted
for you — make room (or choose another drive) and run Acquire again.

## Verify
Acquire starts and the progress line moves; the Library row turns to *installed* when it finishes. For an `ENOSPC`
failure, the file that was being written is left as `<name>.part` and is not used until a full download renames it —
see `entries/acquire-interrupted.md` if the retry still stops.

## Notes
The check runs before any download starts, so a `needs X GB disk` failure leaves nothing half-written.
