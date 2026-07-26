'use strict';

// ─── Blender IPC — file-based transport ───────────────────────────────────────
//
// Phoenix drives Blender by handing it Python to run. The transport is a pair of
// JSON files in a shared directory — NOT a socket.
//
// Why file-based and not a socket: cross-process loopback sockets fail on Windows +
// Blender 5.1 / Python 3.13 — accept() never returns external connections (WinError
// 10035 / WSAEWOULDBLOCK), even with select() on the main thread. File-IPC sidesteps
// all networking / firewall / Winsock issues and behaves identically on Windows and
// Linux. This was Phoenix's original "spark" mechanism; the socket was a later detour.
//
// Protocol (shared dir, default <os tmp>/phoenix-blender-ipc — override with the
// PHOENIX_BLENDER_IPC_DIR env var or config apps.blenderIpcDir):
//   request  cmd.json    : {"id": <uuid>, "type": "execute", "code": <python>}
//   response result.json : {"id": <uuid>, "status": "ok"|"error",
//                           "stdout": <print output>, "message": <error>, "result": {}}
// Phoenix writes cmd.json atomically (.tmp + rename) and polls result.json until its
// `id` matches — so it can never read a stale result from a previous call.
// The Blender side is the addon in blender-addon/phoenix_blender_ipc.py.

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

let dbg;
try { dbg = require('./debug-log'); } catch (_) { dbg = { ipc() {} }; }

const DEFAULT_DIR = path.join(os.tmpdir(), 'phoenix-blender-ipc');

function ipcDir(cfg) {
  return (cfg && cfg.apps && cfg.apps.blenderIpcDir) ||
         process.env.PHOENIX_BLENDER_IPC_DIR ||
         DEFAULT_DIR;
}

// ⚠ HALF-WIRED BY DESIGN OF THE ADDON, not by oversight: this side honours
// apps.blenderIpcDir, but blender-addon/phoenix_blender_ipc.py can only read
// PHOENIX_BLENDER_IPC_DIR (it has no way to find phoenix-config.json — Blender copies the
// addon into its own scripts dir, away from the install). So a config value alone makes
// Phoenix write into a folder the addon never watches, and every call dies in a mute
// timeout. We cannot repair that from here, but we can stop it from being mute.
function ipcDirMismatchHint(cfg) {
  const configured = cfg && cfg.apps && cfg.apps.blenderIpcDir;
  if (!configured) return '';
  if (process.env.PHOENIX_BLENDER_IPC_DIR === configured) return '';   // both sides agree
  return '\n⚠ apps.blenderIpcDir is set to "' + configured + '", but the Blender addon only reads the ' +
         'PHOENIX_BLENDER_IPC_DIR environment variable — it is almost certainly watching "' + DEFAULT_DIR +
         '" instead. Either start Blender with PHOENIX_BLENDER_IPC_DIR set to the same path, or remove ' +
         'apps.blenderIpcDir from the config so both sides use the default.';
}

// Run `code` in Blender and resolve the parsed response object.
// opts: { cfg, timeoutMs } — both optional.
function callBlender(code, opts = {}) {
  const dir       = ipcDir(opts.cfg);
  const timeoutMs = opts.timeoutMs || 90000;
  const cmdFile   = path.join(dir, 'cmd.json');
  const resFile   = path.join(dir, 'result.json');
  const id        = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = cmdFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ id, type: 'execute', code }), 'utf8');
      fs.renameSync(tmp, cmdFile);          // atomic publish — addon never sees a partial command
    } catch (e) {
      return reject(new Error('Blender IPC: cannot write command in ' + dir + ' — ' + e.message));
    }
    try { dbg.ipc('send', { id, code }); } catch (_) {}

    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (Date.now() > deadline) {
        return reject(new Error(
          'Blender not responding (' + Math.round(timeoutMs / 1000) + 's) — is Blender open with the ' +
          'Phoenix IPC addon enabled? Watch dir: ' + dir + ipcDirMismatchHint(opts.cfg)));
      }
      let raw;
      try { raw = fs.readFileSync(resFile, 'utf8'); }
      catch { return setTimeout(poll, 150); }            // no result yet
      let obj;
      try { obj = JSON.parse(raw); }
      catch { return setTimeout(poll, 150); }            // mid-write — retry
      if (!obj || obj.id !== id) return setTimeout(poll, 150);  // stale result from a previous call
      try { dbg.ipc('recv', raw); } catch (_) {}
      resolve(obj);
    };
    setTimeout(poll, 100);
  });
}

// Liveness probe for preflight / troubleshooter: send a no-op and see if the addon
// answers quickly. Resolves to 'reachable' or a human-readable reason string.
function probeBlender(cfg, timeoutMs = 3000) {
  return callBlender('pass', { cfg, timeoutMs })
    .then(() => 'reachable')
    .catch(e => {
      const m = e.message || String(e);
      return /not responding/i.test(m)
        ? 'not responding (Blender not open, or the Phoenix IPC addon is not enabled)'
        : 'error: ' + m;
    });
}

module.exports = { callBlender, probeBlender, ipcDir, DEFAULT_DIR };
