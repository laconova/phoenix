# Acquire was interrupted (cancelled, network drop, bad checksum, half-cloned node)

**Symptoms:** *"Acquire failed for …"* or *"Acquire cancelled"* after you pressed **✕ Cancel** · an error containing
`ECONNRESET`, `ETIMEDOUT` or `socket hang up` · `sha256 mismatch for <file>: expected …, got …` · a custom-node folder
that `… is a git repository with an empty working tree (interrupted clone?)`.
**Applies to:** acquire · install · network
**Root cause:** the run stopped before a step finished. Phoenix is built so that a half-done step is never read as
done:
- a model file is streamed into `<file>.part` and renamed to its real name only after the whole download succeeds —
  a partial download never carries the final name;
- a folder-type step (custom node, engine) is only "done" once a small completion marker is written inside it
  *after* the step succeeds, so a cancelled or killed clone has no marker and the plan still lists it as missing;
- on a `sha256 mismatch` Phoenix removes the file it just fetched and fails the step.

Phoenix never deletes a folder it did not create, so a leftover folder from an interrupted clone stays where it is.

## Fix — do it for me
1. Just press **⬇ Acquire** again — finished steps are skipped, the interrupted one is redone.
2. If the error says a folder `already exists and is not a git repository` or has an `empty working tree`, move that
   exact folder (the path is in the message) aside or rename it, then press **⬇ Acquire** again.
3. For a leftover `<file>.part`, nothing needs doing — the next download starts over and replaces it.
4. A repeated `sha256 mismatch` means the file at the source differs from the one the workflow declares; retry once,
   and if it repeats, report it with **Copy log** / **Open issue**.

## Fix — explain it
Acquire is restartable. Whatever was finished is recognised and skipped; whatever was cut off is not counted as
installed. The one case that needs your hand is a folder the interrupted clone left behind — Phoenix will not
overwrite or delete it for you, so move it aside and let Acquire clone fresh.

## Verify
The Library row turns to *installed* and the failed step now shows `✓` in the progress line.

## Notes
Network errors (`ECONNRESET`, `ETIMEDOUT`, `socket hang up`) are usually temporary — retry before digging further.
Not enough space is a different case: see `entries/acquire-disk-full.md`.
