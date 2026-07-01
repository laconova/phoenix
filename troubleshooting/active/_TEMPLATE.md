<!-- Copy this to active/<issue-slug>.md when a fix spans a server.bat restart + refresh.
     A fresh troubleshooter reads active/*.md FIRST after a restart and resumes from here.
     Delete this file when Status = resolved. -->

# Active fix: <short issue title>

- **Entry:** entries/<component>-<slug>.md
- **Started:** <ISO datetime>
- **Symptom seen:** <the exact error/behaviour the user hit>
- **User's chosen door:** do-it-for-me | explain-it

## Steps
- [x] <done step>
- [ ] <next step>
- [ ] ⟳ **restart server.bat + hard-refresh the browser** (this ends the chat — resume from this file)
- [ ] verify: <what confirms resolved>

## Status
`in-progress` | `awaiting-restart` | `awaiting-user` | `resolved`

## Notes for the next instance
<anything a fresh troubleshooter needs to not re-diagnose — e.g. "torch already downgraded to 2.6,
only torchaudio left" or "model still downloading (~2.5 GB), just wait">
