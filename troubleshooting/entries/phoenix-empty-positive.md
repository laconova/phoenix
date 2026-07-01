# Empty POSITIVE / "you wrote 'are'" — prompt mangled to the model

**Symptoms:** `[WARN] ... returned empty POSITIVE` · the metaprompter/orchestrator replies "it looks
like your message got cut off, you wrote 'are'" · a real request errors with `--stage image requires
--desc` · a job starts for `"undefined"`.
**Applies to:** phoenix · runtime (historical — FIXED in code 2026-07-01)
**Root cause:** prompts were passed to the `claude` CLI as **command-line arguments** with
`shell: true`. On Windows cmd.exe (and `/bin/sh` on Linux) treat newlines and `& | < > ( ) " ^` as
separators, shredding the system prompt down to a trailing fragment (".​..You are") and dropping the
user text. Fixed by `claude-cli.js`: system prompt → temp file (`--system-prompt-file`), user → stdin,
real `claude.exe` resolved from the .cmd shim.

## Fix — do it for me
Confirm `claude-cli.js` exists and that `phoenix.js` + `assistant.js` call `claudeCli.runSync`/
`runStream` (no raw `spawn('claude', [... systemPrompt, user])`). If a fresh empty-desc gen appears,
that's the separate **"undefined" guard gap** — validate the description is non-empty before starting
the job (reject with a clear message instead of launching for "undefined").

## Fix — explain it
The tool that talks to Claude was handing the whole prompt on the command line, and the shell chopped
it up. It now sends the prompt through a file + standard input instead, so nothing gets mangled.

## Verify
`node phoenix.js --stage prompt --desc "wooden plank"` → a real `RESULT_PROMPT_POS`, not empty.

## Notes
If you see this **after** the `claude-cli.js` fix is in place, it is a NEW cause — do **not** assume
shell mangling; check whether the model got empty input for a different reason (empty desc, LM Studio
server down for a local metaprompter, etc.).
