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
const HANDLERS_PY = `import bpy, os
@bpy.app.handlers.persistent
def phoenix_clear_saved(*args):
    if args and isinstance(args[0], str):
        saved = os.path.normcase(os.path.abspath(args[0])).replace('\\\\', '/').lower()
        current = os.path.normcase(os.path.abspath(bpy.data.filepath)).replace('\\\\', '/').lower()
        if saved == current:
            bpy.app.driver_namespace.pop('phoenix_modified', None)
@bpy.app.handlers.persistent
def phoenix_clear_loaded(*args):
    bpy.app.driver_namespace.pop('phoenix_rescue_undo', None)
    bpy.app.driver_namespace.pop('phoenix_modified', None)
    bpy.app.driver_namespace['phoenix_orphan_kept'] = []
    changed = False
    scene = bpy.context.scene
    if scene.get('phoenix_scene'):
        tagged = [a for a in bpy.data.actions if a.library is None and a.get('phoenix_orphan')]
        used = {a for a, users in bpy.data.user_map(subset=tagged).items() if any(u is not a and u.library is None for u in users)}
        for act in bpy.data.actions:
            if act in used:
                for key in ('phoenix_orphan', 'phoenix_orphan_object'):
                    if key in act: del act[key]; changed = True
            if act.library is None and act.users == 0:
                act.use_fake_user = True
                act['phoenix_orphan'] = scene['phoenix_scene']
                act['phoenix_orphan_object'] = act.slots[0].identifier[2:] if act.slots else ''
                changed = True
        for col in scene.collection.children:
            if col.name == '_movable' and col.library is None and col.override_library is not None:
                for ob in col.all_objects:
                    if ob.override_library and ob.override_library.is_system_override:
                        ob.override_library.is_system_override = False
                        changed = True
    if changed:
        bpy.app.driver_namespace['phoenix_modified'] = True
        loaded_path = bpy.data.filepath
        def push_rescue_undo():
            try:
                if bpy.data.filepath != loaded_path:
                    return None
                windows = bpy.context.window_manager.windows
                if windows:
                    w = windows[0]
                    with bpy.context.temp_override(window=w, screen=w.screen):
                        r = bpy.ops.ed.undo_push(message='Phoenix: rescue animation')
                    if 'FINISHED' in r:
                        bpy.app.driver_namespace['phoenix_rescue_undo'] = True
            except Exception:
                pass
            return None
        bpy.app.timers.register(push_rescue_undo, first_interval=0)
for handlers, handler in ((bpy.app.handlers.save_post, phoenix_clear_saved), (bpy.app.handlers.load_post, phoenix_clear_loaded)):
    for old in list(handlers):
        if old.__name__ == handler.__name__: handlers.remove(old)
    handlers.append(handler)
`;
const MARK_PY = `import bpy, os
bpy.app.driver_namespace['phoenix_modified'] = True
` + HANDLERS_PY;
function wrapCommand(code, opts = {}) {
  if (opts.readOnly) return code;
  return MARK_PY + code + '\n' + `import bpy
bpy.app.driver_namespace['phoenix_modified'] = True
try:
    windows = bpy.context.window_manager.windows
    if windows:
        w = windows[0]
        with bpy.context.temp_override(window=w, screen=w.screen):
            bpy.ops.ed.undo_push(message=${JSON.stringify('Phoenix: ' + (opts.label || 'change'))})
except Exception:
    pass
`;
}

let inflight = 0;   // calls of THIS process that have not settled yet (probeBlenderIdle looks at it)
// opts.background === true: not counted in `inflight` (a background query must not make probeBlenderIdle answer 'busy' to a foreground action);
// otherwise identical — same queue, same timeout rule.
function callBlender(code, opts = {}) {
  if (opts.background === true) return callBlenderRaw(wrapCommand(code, opts), opts);
  inflight++;
  const wrapped = wrapCommand(code, opts);
  // a long wait on a closed Blender holds the Phoenix lock for minutes: look first. The look happens inside the call's queue turn (the place in the
  // FIFO is reserved now, so a short call started right after cannot overtake it); `inflight` covers the whole call.
  const gate = (opts.timeoutMs || 90000) > GATE_ABOVE_MS ? gateFor(opts.cfg) : null;
  return callBlenderRaw(wrapped, opts, gate).finally(() => { inflight--; });
}
const GATE_ABOVE_MS = 30000;   // calls with a longer timeout are probed first; 30 s and below are not
const GATE_BUDGET_MS = 5000;   // total bound for the check, including waits on a foreign command
const GATE_RETRY_MS = 250;
const BLENDER_REFUSE = 'BLENDER_UNREACHABLE: Blender is not answering. Open Blender with the Phoenix add-on, or wait until it is free, then try again.';
const gates = new Map();   // dirKey -> the liveness check shared by the long calls queued while it is unsettled
// Decided synchronously at enqueue. A pending gate of the directory is reused (one answer for all followers, a refusal reaches them at once);
// a probe already running (the status bar's, or another gate's) seeds a new gate; a call behind a running call of ours needs no gate (null);
// otherwise a new gate probes when its call's turn comes.
function gateFor(cfg) {
  const dir = ipcDir(cfg), key = dirKey(dir);
  if (gates.has(key)) return gates.get(key);
  let seed = null;
  if (probes.has(key)) seed = probes.get(key);
  else if (queueBusy(cfg)) return null;
  const g = { p: null, check() { if (!g.p) g.start(); return g.p; }, start() { g.p = runGate(cfg, dir, seed).finally(() => { if (gates.get(key) === g) gates.delete(key); }); g.p.catch(() => {}); } };
  gates.set(key, g);
  return g;
}
// The probe inside a queue turn cannot go through probeBlender (it queues behind the current turn: deadlock): it uses the slot directly.
async function probeInTurn(cfg, dir, timeoutMs) {
  if (foreignPending(dir)) return 'busy';
  const id = crypto.randomUUID();
  ownIds.add(id);
  try { await callBlenderNow('pass', { cfg, timeoutMs }, id, dir); return 'reachable'; }
  catch (e) {
    if (e && e.code === 'FOREIGN_BUSY') return 'busy';
    const m = (e && e.message) || String(e);
    return /not responding/i.test(m) ? 'not responding' : 'error: ' + m;
  } finally { ownIds.delete(id); }
}
// Resolves when the real command may go; rejects BLENDER_REFUSE when Blender does not answer within the budget.
async function runGate(cfg, dir, seed) {
  const t0 = Date.now();
  let r = seed ? await seed : null;
  for (;;) {
    if (r === null) {
      const left = GATE_BUDGET_MS - (Date.now() - t0);
      if (left <= 0) throw new Error(BLENDER_REFUSE);
      r = await probeInTurn(cfg, dir, Math.max(500, left));
    }
    if (r === 'reachable') return;
    if (/^not responding/.test(r)) throw new Error(BLENDER_REFUSE);
    if (r !== 'busy') return;   // 'error: ...': the real call reports the real write error
    // a foreign command in the slot (usually another process's heartbeat, clears within seconds): never overwrite it, ask again
    if (Date.now() - t0 + GATE_RETRY_MS >= GATE_BUDGET_MS) throw new Error(BLENDER_REFUSE);
    await new Promise(res => setTimeout(res, GATE_RETRY_MS));
    r = null;
  }
}

// ONE command slot per IPC directory (cmd.json): every command that uses it runs strictly one after another, FIFO per directory. A call's turn
// starts the whole body (write .tmp, publish, poll, withdraw on timeout); its timeout starts when its command is published, not when it is queued.
// The slot is released in every outcome (resolve, reject, synchronous throw). Different directories have independent queues.
const queues = new Map();      // canonical IPC directory key (dirKey) -> tail promise (never rejects)
// One canonical identity per directory: `D:\ipc`, `D:\ipc\` and `d:/ipc` are the same slot. Used for queues, probes and queueBusy;
// the published paths themselves stay path.join(dir, ...).
function dirKey(dir) {
  let k = path.resolve(String(dir));
  const root = path.parse(k).root;
  while (k.length > root.length && (k.endsWith('\\') || k.endsWith('/'))) k = k.slice(0, -1);
  return process.platform === 'win32' ? k.toLowerCase() : k;
}
// true while a queue entry exists for that directory (an own call is in flight or queued behind the single cmd.json slot)
function queueBusy(cfg) { return queues.has(dirKey(ipcDir(cfg))); }
const ownIds = new Set();      // ids of calls of THIS process that have not settled yet (probeBlenderIdle: our own pending id is not foreign)
function callBlenderRaw(code, opts = {}, gate = null) {
  const dir = ipcDir(opts.cfg);
  const id  = crypto.randomUUID();
  ownIds.add(id);
  const key  = dirKey(dir);
  const prev = queues.get(key) || Promise.resolve();
  // opts.probeGuard (probes only): on its queue turn, a FOREIGN unanswered command resolves FOREIGN_BUSY without writing or publishing anything
  const run  = prev.then(() => (opts.probeGuard && foreignPending(dir)) ? FOREIGN_BUSY : gate ? gate.check().then(() => callBlenderNow(code, opts, id, dir)) : callBlenderNow(code, opts, id, dir));
  const tail = run.then(() => {}, () => {}).then(() => { ownIds.delete(id); if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  return run;
}
function callBlenderNow(code, opts, id, dir) {
  const timeoutMs = opts.timeoutMs || 90000;
  const cmdFile   = path.join(dir, 'cmd.json');
  const resFile   = path.join(dir, 'result.json');

  return new Promise((resolve, reject) => {
    // Prepare the command in our OWN per-call .tmp first (unique via `id`), then atomically rename it
    // onto cmd.json. The per-id name matters because the publish retry below backs off for up to ~0.5s,
    // and two callers can be live at once across PROCESSES the lock doesn't cover — a detached job's
    // phoenix.js child and the preflight probe (spawned during a held lock). A shared .tmp name would let
    // one caller overwrite the other's payload mid-backoff (lost command, or publishing a foreign payload).
    const tmp = cmdFile + '.' + id + '.tmp';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ id, type: 'execute', code }), 'utf8');
    } catch (e) {
      return reject(new Error('Blender IPC: cannot write command in ' + dir + ' — ' + e.message));
    }

    let deadline = Infinity;     // set when the command is actually published
    const poll = () => {
      if (Date.now() > deadline) {
        // Sweep 3 H: the command we published is still sitting in cmd.json. A Blender that wakes up later would execute it AFTER Phoenix
        // reported the failure (e.g. a late open_mainfile switching the scene). Withdraw it - only if it is still OUR command.
        // Sweep 3b: no read-then-unlink race. MOVE cmd.json to a name only we know (rename is atomic), look at the id, and either drop it (ours) or put it back
        // WITHOUT overwriting anything newer (hard link = atomic "create only if absent"; if a newer cmd.json appeared meanwhile, that one stays).
        const mine = cmdFile + '.' + id + '.wd';
        try {
          fs.renameSync(cmdFile, mine);
          let cur = null; try { cur = JSON.parse(fs.readFileSync(mine, 'utf8')); } catch (_) { /* unreadable: not ours to judge */ }
          if (!(cur && cur.id === id)) {
            try { fs.linkSync(mine, cmdFile); }
            catch (le) {
              // ONLY EEXIST means "a newer cmd.json is there: it stays". Any other error (FAT / exFAT stick: EPERM, ENOTSUP, EINVAL ... = no hard links) must not
              // look like that - copy it back with COPYFILE_EXCL (create only if absent) so the other caller's command is not lost.
              if (!(le && le.code === 'EEXIST')) { try { fs.copyFileSync(mine, cmdFile, fs.constants.COPYFILE_EXCL); } catch (_) { /* a newer cmd.json appeared meanwhile: it stays */ } }
            }
          }
          try { fs.unlinkSync(mine); } catch (_) { /* gone */ }
        } catch (_) { /* no cmd.json (Blender took it) or it is busy: nothing to withdraw */ }
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

    // Publishing (rename over cmd.json) is the Windows race: it throws EPERM/EBUSY/EACCES when the addon
    // holds cmd.json open mid-read at that instant. It's transient — retry with a short backoff instead of
    // failing the whole call, exactly as the result-read side above already retries (fixed 2026-08-02).
    const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
    let publishTries = 0;
    const publish = () => {
      if (publishTries > 0 && foreignPending(dir)) {   // F6.1: a retry must not rename over a command another process has put there meanwhile
        try { fs.unlinkSync(tmp); } catch (_) {}
        const fe = new Error('FOREIGN_BUSY: another command is pending in ' + dir + ' - nothing was written'); fe.code = 'FOREIGN_BUSY';
        return reject(fe);
      }
      try {
        fs.renameSync(tmp, cmdFile);          // atomic publish — addon never sees a partial command
      } catch (e) {
        if (TRANSIENT.has(e.code) && ++publishTries < 25) return setTimeout(publish, 20);  // ~0.5s window
        try { fs.unlinkSync(tmp); } catch (_) {}   // don't leave a .tmp behind on a hard failure
        return reject(new Error('Blender IPC: cannot write command in ' + dir + ' — ' + e.message));
      }
      try { dbg.ipc('send', { id, code }); } catch (_) {}
      deadline = Date.now() + timeoutMs;
      setTimeout(poll, 100);                   // start polling only once the command is actually published
    };
    publish();
  });
}

// Liveness probe for preflight / troubleshooter: send a no-op and see if the addon
// answers quickly. Resolves to 'reachable' or a human-readable reason string.
const probes = new Map(); // canonical IPC directory key (dirKey) -> the shared liveness promise
function probeBlender(cfg, timeoutMs = 3000) {
  const dir = ipcDir(cfg);
  const key = dirKey(dir);
  if (probes.has(key)) return probes.get(key);
  const probe = callBlenderRaw('pass', { cfg, timeoutMs, probeGuard: true })
    .then(r => r === FOREIGN_BUSY ? 'busy' : 'reachable')
    .catch(e => {
      const m = e.message || String(e);
      if (e && e.code === 'FOREIGN_BUSY') return 'busy';
      return /not responding/i.test(m)
        ? 'not responding (Blender not open, or the Phoenix IPC addon is not enabled)'
        : 'error: ' + m;
    }).finally(() => { if (probes.get(key) === probe) probes.delete(key); });
  probes.set(key, probe);
  return probe;
}

// Status-bar probe: NEVER writes while a command may be pending or running. A probe renames its own cmd.json over a tool call's
// command (the addon only polls every 0.25 s and never deletes cmd.json) and a probe during a long command times out for nothing.
// 'busy' = this process has a call in flight, or cmd.json holds an id that result.json does not answer yet (another process).
const STALE_MS = 10 * 60 * 1000;   // longer than any callBlender timeoutMs, so a cmd.json this old can no longer be a live command
const FOREIGN_BUSY = Symbol('foreign-busy');
// A FOREIGN unanswered command: cmd.json holds an id that result.json does not answer, that is not one of our own unsettled ids (those are in our
// queue - a probe just waits behind them) and that is younger than STALE_MS (older = orphaned: Phoenix died mid-call / a withdraw failed).
function foreignPending(dir) {
  try {
    const cmdPath = path.join(dir, 'cmd.json');
    const cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8'));
    let res = null;
    try { res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch (_) { /* no result yet */ }
    if (cmd && cmd.id && !(res && res.id === cmd.id)) {
      let age = 0; try { age = Date.now() - fs.statSync(cmdPath).mtimeMs; } catch (_) { /* unreadable: treat as fresh */ }
      if (age < STALE_MS && !ownIds.has(cmd.id)) return true;
    }
  } catch (_) { /* no (readable) cmd.json: nothing pending */ }
  return false;
}
function probeBlenderIdle(cfg, timeoutMs = 3000) {
  const dir = ipcDir(cfg);
  if (foreignPending(dir)) return Promise.resolve('busy');   // also before joining a shared probe: a foreign command that appeared meanwhile must not be overwritten
  const key = dirKey(dir);
  if (probes.has(key)) return probes.get(key);
  if (inflight > 0) return Promise.resolve('busy');
  return probeBlender(cfg, timeoutMs);
}

module.exports = { HANDLERS_PY, MARK_PY, wrapCommand, callBlender, probeBlender, probeBlenderIdle, queueBusy, ipcDir, DEFAULT_DIR, BLENDER_REFUSE };
