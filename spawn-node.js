'use strict';

const { spawn } = require('child_process');

// Async replacement for spawnSync('node', ...). The Phoenix server is single-threaded, so a
// spawnSync that shells out to a child running a Blender call (use_brush / save_brush — up to ~3 min)
// FREEZES the whole event loop while it runs: SSE, /status, /stop and the header polls all go dead.
// This runs the same child without blocking. It RESOLVES (never rejects) with a spawnSync-shaped
// result — { code, stdout, stderr, error } — so each caller keeps its own throw-vs-return-string
// handling; only the field name changes (r.status -> r.code).
//
// process.execPath is this very Node binary, which is more reliable than 'node' on PATH (a fresh
// install may not have `node` on PATH even while running under it).
function spawnNode(scriptPath, argv = [], opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const maxBuffer = opts.maxBuffer || 2 * 1024 * 1024;
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, done = false;
    const cap = s => (s.length > maxBuffer ? s.slice(0, maxBuffer) : s);
    const finish = (code, error) => {
      if (done) return;                 // close can fire after an error; report once
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, error });
    };

    let child;
    try {
      child = spawn(process.execPath, [scriptPath, ...argv]);
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: e });
      return;
    }

    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (_) {} }, timeoutMs);

    // Decode at proper UTF-8 boundaries so a multi-byte char split across a chunk isn't mangled.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out = cap(out + d); });
    child.stderr.on('data', d => { err = cap(err + d); });
    child.on('error', e => finish(null, e));
    child.on('close', code => finish(
      code,
      timedOut ? new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`) : null
    ));
  });
}

module.exports = { spawnNode };
