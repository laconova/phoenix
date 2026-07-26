'use strict';
// ─── blend-run — on-call driver for the live Blender bridge ───────────────────
// Sends Python to the already-open Blender session (via blender-ipc.js) and prints
// the result. No need to rebuild a driver each session.
//
// Usage (run from the repo root, PowerShell or bash):
//   node blend-run.js script.py                            # run a .py file
//   node blend-run.js -c "import bpy; print(bpy.context.scene.name)"
//   cat script.py | node blend-run.js -                    # stdin
//   Get-Content script.py | node blend-run.js -            # stdin, PowerShell
// Options:
//   --timeout <ms>   bridge timeout (default 90000)
//
// Requires: Blender open with the Phoenix IPC addon active (it polls the shared dir).
const fs = require('fs');
const { callBlender } = require('./blender-ipc.js');

const argv = process.argv.slice(2);
let code = null, timeoutMs = 90000;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--timeout') { timeoutMs = parseInt(argv[++i], 10); }
  else if (a === '-c') { code = argv[++i]; }
  else if (a === '-') { code = fs.readFileSync(0, 'utf8'); }
  else if (code === null) { code = fs.readFileSync(a, 'utf8'); }
}
if (code === null) {
  console.error('blend-run: no code. Usage: node blend-run.js <file.py> | -c "code" | -  [--timeout ms]');
  process.exit(2);
}

callBlender(code, { timeoutMs })
  .then(r => {
    console.log('STATUS:', r.status);
    if (r.stdout) console.log('--- STDOUT ---\n' + r.stdout.replace(/\s+$/, ''));
    if (r.message) console.log('--- MESSAGE ---\n' + r.message);
    if (r.result && Object.keys(r.result).length) console.log('--- RESULT ---\n' + JSON.stringify(r.result, null, 2));
    process.exit(r.status === 'ok' ? 0 : 1);
  })
  .catch(e => { console.error('BRIDGE ERROR:', e.message); process.exit(3); });
