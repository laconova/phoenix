'use strict';

// ─── Unreal IPC — drive a running Unreal Editor with Python ───────────────────
//
// The counterpart to blender-ipc.js, and deliberately shaped the same way:
// `callUnreal(code)` hands the editor Python and resolves {status, stdout, result}.
// Everything downstream can then treat "run this in Blender" and "run this in
// Unreal" as the same kind of call.
//
// TRANSPORT — and why it is NOT hand-rolled: Epic ships the protocol
// implementation with the engine, at
//   Engine/Plugins/Experimental/PythonScriptPlugin/Content/Python/remote_execution.py
// It is UDP multicast (239.0.0.1:6766) for discovering editor instances plus a TCP
// channel (127.0.0.1:6776) for the commands themselves. Reimplementing that in Node
// would mean owning a protocol Epic can change under us for no gain, so instead a
// short Python process drives THEIR client and answers on stdout as JSON.
//
// That helper is generated here and fed through stdin rather than kept as a file on
// disk, so there is nothing to install, relocate or lose at runtime. (The original
// reason was that `scripts/` did not ship — that stopped being true with v1.6.0,
// which tracks the whole folder. The decision stands on the weaker reason.)
//
// The cost is one Python start per call (~200 ms). For editor automation that is
// irrelevant, and it buys a transport we do not maintain.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000;

// Where the engine lives. Config wins; otherwise take the newest UE_* we can find.
function engineRoot(cfg) {
  const configured = cfg && cfg.apps && cfg.apps.unrealEngine;
  if (configured) return configured;
  if (process.env.PHOENIX_UNREAL_ENGINE) return process.env.PHOENIX_UNREAL_ENGINE;

  const bases = ['C:/Program Files/Epic Games', 'D:/Epic Games', 'E:/Epic Games'];
  const found = [];
  for (const b of bases) {
    let names = [];
    try { names = fs.readdirSync(b); } catch (_) { continue; }
    for (const n of names) {
      if (!/^UE_\d/.test(n)) continue;
      const abs = path.join(b, n);
      if (fs.existsSync(path.join(abs, 'Engine'))) found.push(abs);
    }
  }
  // "UE_5.10" must sort above "UE_5.8", so compare the version numerically.
  found.sort((a, b) => {
    const v = s => (path.basename(s).match(/UE_(\d+)\.(\d+)/) || [0, 0, 0]).slice(1).map(Number);
    const [aM, am] = v(a), [bM, bm] = v(b);
    return (bM - aM) || (bm - am);
  });
  return found[0] || null;
}

function remoteExecutionDir(cfg) {
  const root = engineRoot(cfg);
  if (!root) return null;
  const p = path.join(root, 'Engine', 'Plugins', 'Experimental', 'PythonScriptPlugin',
                      'Content', 'Python');
  return fs.existsSync(path.join(p, 'remote_execution.py')) ? p : null;
}

function pythonExe(cfg) {
  return (cfg && cfg.apps && cfg.apps.python) || process.env.PHOENIX_PYTHON || 'python';
}

// Every failure mode of this bridge looks identical from the outside — "no editor
// found" — whether the editor is closed, the plugin is off, remote execution is
// unticked, or multicast is blocked. A bare timeout would send the operator hunting
// through all four. So the one message names all four, in the order they are likely.
const NO_NODE_HELP = [
  'No Unreal Editor answered. One of these is true:',
  '  1. the editor is not running (or is still loading the project)',
  '  2. the "Python Editor Script Plugin" is not enabled in the PROJECT',
  '     — Edit > Plugins > search "Python" > enable > restart the editor',
  '  3. remote execution is off',
  '     — Edit > Project Settings > Plugins > Python > tick "Enable Remote Execution"',
  '  4. something blocks UDP multicast on 239.0.0.1:6766 (firewall / VPN adapter)',
].join('\n');

// `python -` reads the SCRIPT from stdin, so stdin is spent by the time the script
// runs — the payload cannot travel the same way. It is embedded as a literal instead,
// escaped to pure ASCII so the source carries no encoding assumptions.
function pyString(s) {
  // Iterate by CODE POINT, not by UTF-16 code unit. The original range ran
  // \u007F-\uFFFF without the /u flag, so an astral character (any emoji) was seen as its
  // two surrogate halves and escaped as two LONE surrogates. Python then builds a string
  // holding unpaired surrogates and dies the moment it is encoded:
  //     UnicodeEncodeError: surrogates not allowed
  // Measured 2026-07-31 -- triggered by nothing worse than an emoji in a script comment,
  // and the message points at Python, not at this line.
  return JSON.stringify(String(s)).replace(/[\u007F-\u{10FFFF}]/gu, (c) => {
    const cp = c.codePointAt(0);
    return cp > 0xFFFF
      ? '\\U' + cp.toString(16).padStart(8, '0')      // Python wants exactly 8 hex digits
      : '\\u' + cp.toString(16).padStart(4, '0');
  });
}

// The helper: drive Epic's client, print exactly one JSON object, never anything else.
// stdout is the channel, so any diagnostic goes to stderr.
function helperSource(reDir, code, mode, discoverMs) {
  return `
import sys, json, time
sys.path.insert(0, ${pyString(reDir)})
import remote_execution as re

CODE = ${pyString(code)}
out = {"status": "error", "stdout": "", "result": None, "message": ""}
sess = re.RemoteExecution()
try:
    sess.start()
    # Discovery is a broadcast that the editor answers on its own schedule, so poll
    # instead of sleeping a fixed amount: a found node should not cost the full wait.
    deadline = time.time() + ${discoverMs} / 1000.0
    nodes = []
    while time.time() < deadline:
        nodes = sess.remote_nodes
        if nodes:
            break
        time.sleep(0.1)
    if not nodes:
        out["message"] = "NO_NODE"
    else:
        sess.open_command_connection(nodes[0])
        r = sess.run_command(CODE, exec_mode=re.${mode})
        out["status"] = "ok" if r.get("success") else "error"
        out["stdout"] = "".join(x.get("output", "") for x in (r.get("output") or []))
        out["result"] = r.get("result")
        out["node"] = nodes[0].get("data", {}).get("project_name") or nodes[0].get("node_id")
        if not r.get("success"):
            out["message"] = out["stdout"] or "command failed"
except Exception as e:
    out["message"] = "%s: %s" % (type(e).__name__, e)
finally:
    try: sess.stop()
    except Exception: pass

sys.stdout.write(json.dumps(out))
`.trim();
}

// Run `code` in the running Unreal Editor.
// opts: { cfg, timeoutMs, mode: 'file'|'statement'|'eval', discoverMs }
function callUnreal(code, opts = {}) {
  const cfg = opts.cfg;
  const reDir = remoteExecutionDir(cfg);
  if (!reDir) {
    const root = engineRoot(cfg);
    return Promise.resolve({
      status: 'error',
      message: root
        ? 'Found the engine at ' + root + ' but not remote_execution.py underneath it. ' +
          'Is the Python Editor Script Plugin part of this installation?'
        : 'No Unreal installation found. Set apps.unrealEngine in phoenix-config.json ' +
          '(the folder that contains Engine\\, e.g. C:\\Program Files\\Epic Games\\UE_5.8).',
      stdout: '', result: null,
    });
  }

  const mode = opts.mode === 'eval' ? 'MODE_EVAL_STATEMENT'
             : opts.mode === 'statement' ? 'MODE_EXEC_STATEMENT'
             : 'MODE_EXEC_FILE';
  const discoverMs = opts.discoverMs || 6000;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = execFile(pythonExe(cfg), ['-'],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let parsed = null;
        try { parsed = JSON.parse(String(stdout).trim()); } catch (_) { /* handled below */ }

        if (!parsed) {
          const why = (stderr || '').trim() || (err && err.message) || 'no output';
          resolve({
            status: 'error', stdout: '', result: null,
            message: /No module named|ModuleNotFoundError/.test(why)
              ? 'The helper could not import remote_execution.py from ' + reDir + ' — ' + why
              : 'The Python helper produced no usable answer — ' + why.slice(0, 400),
          });
          return;
        }
        if (parsed.message === 'NO_NODE') {
          resolve({ status: 'error', stdout: '', result: null, message: NO_NODE_HELP });
          return;
        }
        resolve(parsed);
      });

    // An async EPIPE on stdin (python started then exited instantly — e.g. the Windows Store
    // `python` app-execution stub) is emitted as a stream 'error' event. With no listener that is
    // an UNCAUGHT exception that takes the whole server down on the first Unreal action of a fresh
    // install. The listener defuses the crash; the execFile callback above still reports the real
    // failure once the child exits (resolve is idempotent — first one wins).
    child.stdin.on('error', () => {});
    try {
      child.stdin.write(helperSource(reDir, code, mode, discoverMs));
      child.stdin.end();
    } catch (e) {
      resolve({ status: 'error', stdout: '', result: null,
                message: 'could not hand the script to Python — ' + e.message });
    }
  });
}

// ─── Guarded calls ────────────────────────────────────────────────────────────
//
// A Python-level exception inside the editor comes back from callUnreal() as a bare
// "command failed" with EMPTY stdout — the traceback never leaves Unreal. That cost
// three blind retries on 2026-07-31 before the real cause (a wrong argument) showed up.
// Wrapping the body in try/except + traceback.print_exc() is therefore not optional
// hygiene, it is the difference between a readable error and a mute one.
//
// It lives HERE rather than in each caller because there is nothing caller-specific
// about it: brush-to-unreal.js and unreal-to-blender.js had begun to carry the same
// twelve lines, and a divergence between two copies of an error path is the kind of
// bug that only shows up when something is already going wrong.

// Wrap Python source so an exception prints itself instead of vanishing.
function guardPython(code) {
  const body = Array.isArray(code) ? code : String(code).split(/\r?\n/);
  return [
    'import unreal, traceback',
    'try:',
    ...body.map(l => '    ' + l),
    'except Exception as _e:',
    '    print("PHX_PY_ERROR:", type(_e).__name__, _e)',
    '    traceback.print_exc()',
  ].join('\n');
}

// callUnreal + guardPython + throw-on-error, which is what every real caller wants.
// Returns stdout as a string.
//
// ⚠️ The `!out` in the status check is deliberate: a guarded script that PRINTS and then
// hits a non-fatal bridge complaint still carries its diagnosis in stdout, and throwing
// that away in favour of a generic message would hide it.
async function callUnrealGuarded(code, opts = {}) {
  const r = await callUnreal(guardPython(code), opts);
  const out = String(r.stdout || '').trim();
  if (r.status !== 'ok' && !out) {
    throw new Error('Unreal: ' + (r.message || 'command failed (no output)'));
  }
  if (out.includes('PHX_PY_ERROR')) throw new Error('Unreal Python error:\n' + out);
  return out;
}

// Is anybody home? Answers with what the editor says about itself, so the operator
// can tell "the bridge works" from "the bridge found SOMETHING" — with two editors
// open, knowing WHICH one answered matters.
async function probeUnreal(opts = {}) {
  const r = await callUnreal(
    'import unreal\n' +
    'print(unreal.SystemLibrary.get_engine_version())\n' +
    'print(unreal.Paths.get_project_file_path())\n',
    Object.assign({ discoverMs: 4000, timeoutMs: 30000 }, opts));
  if (r.status !== 'ok') return r;
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  return Object.assign(r, { engineVersion: lines[0] || null, projectFile: lines[1] || null });
}

// ── Which of the four failures is it? ────────────────────────────────────────
//
// probeUnreal answers "did a node reply", and when none did, NO_NODE_HELP has to
// list all four causes because from inside the bridge they are indistinguishable.
// Exactly one of them is cheap to rule out from the OUTSIDE: whether an editor
// process exists at all. That single bit splits the four into "Unreal is not
// running" (nothing is wrong — start it) and "Unreal IS running but stays silent"
// (plugin off, remote execution off, or multicast blocked).
//
// That distinction cost two hours on 2026-07-29: an editor sitting at the project
// browser reports itself the same way a closed one does, and the operator went
// hunting through plugin settings for a bridge that was never the problem.
//
// It also splits one step finer, and that is the split that actually cost the two
// hours: the COMMAND LINE says which project an editor was started with. An editor
// sitting in the project browser has no .uproject on it, cannot answer the bridge,
// and is indistinguishable from a broken plugin — unless you look here. So the
// command line is read, not just the process name (which is why this asks CIM on
// Windows: tasklist cannot show a command line).
//
// Assumption, stated because it is the one soft spot: picking a project in the
// browser relaunches the editor WITH the .uproject argument. If a build ever loads
// one in-process instead, the worst case is that 'noproject' is reported where
// 'silent' was meant — both are yellow, both name their causes.
//
// Returns { running, withProject }, each true / false / null — null meaning "could
// not tell", which is a third answer and never silently folded into false.
function editorProcesses() {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const cmd = win ? 'powershell' : 'pgrep';
    const args = win
      ? ['-NoProfile', '-NonInteractive', '-Command',
         "Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe'\" | " +
         'Select-Object -ExpandProperty CommandLine']
      : ['-af', 'UnrealEditor'];

    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      // pgrep exits 1 when nothing matched — that is an answer, not a failure.
      if (err && !(!win && err.code === 1)) { resolve({ running: null, withProject: null }); return; }
      const lines = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const editors = lines.filter(l => /UnrealEditor/i.test(l));
      resolve({
        running: editors.length > 0,
        withProject: editors.length > 0 ? editors.some(l => /\.uproject/i.test(l)) : false,
      });
    });
  });
}

// Once the process check has ruled out "not running", repeating the full four-cause
// list is worse than useless — it leads with a cause already disproved. These two
// narrow it to what is still possible.
const SILENT_HELP = [
  'An Unreal Editor IS running, but it does not answer the bridge. So it is one of:',
  '  1. the "Python Editor Script Plugin" is not enabled in the OPEN PROJECT',
  '     — Edit > Plugins > search "Python" > enable > restart the editor',
  '  2. remote execution is off',
  '     — Edit > Project Settings > Plugins > Python > tick "Enable Remote Execution"',
  '  3. something blocks UDP multicast on 239.0.0.1:6766 (firewall / VPN adapter)',
  '  4. the project is still loading — give it a moment and look again',
].join('\n');

const NO_PROJECT_HELP = [
  'An Unreal Editor is running, but NO project is open — it is sitting in the',
  'project browser, and an editor without a project cannot answer the bridge.',
  '',
  'Open the project (MyProject 5.8), then this goes blue on its own.',
].join('\n');

// One round trip for the header indicator: the state plus the numbers behind it.
//
// Deliberately NOT probeUnreal with its 30 s ceiling — an indicator that can block
// for half a minute is one nobody leaves switched on. A live editor answers well
// inside the discovery window (the helper polls at 100 ms and breaks on the first
// node), so the shorter wait costs nothing when things are healthy and bounds the
// cost when they are not.
//
// state: 'live' | 'noproject' | 'silent' | 'absent' | 'noengine' | 'unknown'
async function probeUnrealStatus(opts = {}) {
  // Cheapest check first, and it spawns nothing: if the engine or its
  // remote_execution.py is not where we think it is, no probe can help — and this
  // is also how a machine WITHOUT Unreal answers, so the caller can hide the
  // indicator entirely instead of showing a permanent red dot.
  if (!remoteExecutionDir(opts.cfg)) {
    const root = engineRoot(opts.cfg);
    return {
      state: 'noengine', engineVersion: null, projectFile: null, projectName: null,
      message: root
        ? 'Engine at ' + root + ', but no remote_execution.py underneath it.'
        : 'No Unreal installation found (set apps.unrealEngine in phoenix-config.json).',
    };
  }

  const r = await probeUnreal(Object.assign({ discoverMs: 3000, timeoutMs: 20000 }, opts));

  if (r.status === 'ok') {
    const projectFile = r.projectFile || null;
    return {
      state: 'live',
      engineVersion: r.engineVersion || null,
      projectFile,
      projectName: projectFile
        ? path.basename(projectFile).replace(/\.uproject$/i, '')
        : null,
      message: null,
    };
  }

  // The probe failed. Which failure? Only now is the process check worth its cost —
  // on the healthy path above it never runs at all.
  const { running, withProject } = await editorProcesses();

  const state = running === null ? 'unknown'
              : running === false ? 'absent'
              : withProject === false ? 'noproject'
              : 'silent';

  const message = state === 'noproject' ? NO_PROJECT_HELP
                : state === 'silent'    ? SILENT_HELP
                : (r.message || 'the probe gave no reason');

  return { state, engineVersion: null, projectFile: null, projectName: null, message };
}

module.exports = {
  callUnreal, callUnrealGuarded, guardPython,
  probeUnreal, probeUnrealStatus, editorProcesses,
  engineRoot, remoteExecutionDir,
};
