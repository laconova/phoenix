# Phoenix Troubleshooting Library

A **lookup library** for the in-app troubleshooter *and* the onboarding skill. The whole point:
**nobody reads the whole thing.** The assistant carries only `INDEX.md` (it knows traps *exist*),
and reads the **one** entry that matches the live symptom. Full detail per issue, zero context bloat.

## How retrieval works (and the grouping decision)
- **Retrieve by SYMPTOM, not by category.** When something breaks you have an error string / a
  visible failure — not a tidy category. So `INDEX.md` maps **symptom → entry** (exact error
  substrings like `WinError 127`, `No module named 'cumesh'`, `empty POSITIVE`, `open 'Z:\...'`).
- **One trap per file.** Each entry stands alone so it loads in isolation — no reading five things to
  fix one. Files live flat in `entries/` named `<component>-<slug>.md` (`comfyui-…`, `trellis-…`,
  `phoenix-…`, `blender-…`, `network-…`). The `<component>` prefix is just human sorting; **the index
  is the real map.**
- **Why not nest by component folders?** Browsing folders assumes you already know the category —
  but the failure hands you a symptom. Nesting adds navigation with no retrieval benefit and splits
  cross-component traps (e.g. "Phoenix can't reach ComfyUI" is both). Flat + symptom-index wins.
- Entries cross-link with `see also:` when a symptom can cascade (e.g. torch-align → torchaudio ABI).

## Entry format (every file)
```
# <trap name>
**Symptoms:** <exact strings / what the user sees>   ← these are the INDEX keys
**Applies to:** <component · install|runtime>
**Root cause:** <one short paragraph>

## Fix — do it for me         (steps the assistant can run; flag restart/refresh/downloads)
## Fix — explain it           (same steps in plain language + the why, for the hands-on user)
## Verify                     (how to confirm it's actually resolved)
## Notes                      (must-restart? must-refresh? one-time GB download? see also:)
```

## The two doors (do-it-for-me vs explain-it)
Every entry carries both. The assistant offers the user the choice per issue:
- **Do it for me** — user grants rights; assistant runs the steps.
- **Explain it** — assistant narrates what & why; user runs it / just learns.
Default to **explain-first for anything irreversible or heavy**; offer do-it-for-me as the opt-in.

## Active-issue state — planned, not yet wired
Many fixes need a **server restart + browser refresh**, which ends the troubleshooter's chat session,
so a fix that spans a restart currently has to be re-explained afterwards. The intended mechanism is a
small state file in `active/` (from `active/_TEMPLATE.md`) that a fresh troubleshooter reads first and
resumes from. **The template is here, the reading side is not built yet** — nothing in the shipped code
writes or reads `active/` today. Documented so the folder is not mistaken for a live feature.

> Ships with the app (the troubleshooter reads it). Distinct from `SUSPECTED-ISSUES.md`, which is
> dev-only speculation and must never ship.
