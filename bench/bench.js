'use strict';
// bench/bench.js — the competence mini-benchmark (v1.9 M2.1).
// The M2 tool probe is only a format floor (a 4B model passes 3/3). This runs five real Blender tasks through
// ONE real orchestrator turn each, against a throw-away headless Blender with its OWN IPC dir — the user's open
// Blender is never touched. Checks are plain read-only Python; no LLM judges anything.
// Local orchestrators need >= 4/5 (gated in server.js); cloud/CLI models are only graded.
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const OF = 5;               // tasks per run
const LOCAL_RUNS = 3;       // a local model is a coin toss on ONE run (measured 3/5, 5/5, 5/5) — it runs 3x
const PASS_RATIO = 0.8;     // local gate: passed / total >= 0.8 (12/15)
const DRIVER = path.join(__dirname, 'bench_driver.py');
const READY_TIMEOUT_MS = 60000;
const STOP_WAIT_MS = 5000;
const TASK_TIMEOUT_MS = 180000;
const BENCH_SUFFIX = 'BENCHMARK MODE: you are working in a test scene. Only blender_run and read_state are available.';
const NO_BLENDER = 'Blender not found — set the Blender path in Settings';
const FIXTURE_NAMES = ['Camera', 'Crate', 'Ball', 'Light'];

// ── Blender resolution ──────────────────────────────────────────────────────
// cfg.apps.blender if it exists; else (Windows) the highest "Blender *" install under Program Files;
// else `blender` on PATH; else null. deps (tests): exists, readdir, platform, pathEnv, programFilesDir.
function resolveBlenderExe(cfg, deps = {}) {
  const exists = deps.exists || fs.existsSync;
  const readdir = deps.readdir || fs.readdirSync;
  const platform = deps.platform || process.platform;
  const configured = cfg && cfg.apps && typeof cfg.apps.blender === 'string' ? cfg.apps.blender.trim() : '';
  if (configured && exists(configured)) return configured;

  if (platform === 'win32') {
    const base = deps.programFilesDir || 'C:\\Program Files\\Blender Foundation';
    let dirs = [];
    try { dirs = readdir(base).map(d => (typeof d === 'string' ? d : d && d.name)).filter(d => /^Blender\s/i.test(String(d))); } catch (_) { dirs = []; }
    const ver = d => String(d).replace(/^Blender\s+/i, '').split('.').map(n => parseInt(n, 10) || 0);
    dirs.sort((x, y) => {
      const a = ver(x), b = ver(y);
      for (let i = 0; i < Math.max(a.length, b.length); i++) { const dv = (b[i] || 0) - (a[i] || 0); if (dv) return dv; }
      return 0;
    });
    for (const d of dirs) {
      const exe = path.win32.join(base, d, 'blender.exe');
      if (exists(exe)) return exe;
    }
  }

  const pathEnv = deps.pathEnv !== undefined ? deps.pathEnv : (process.env.PATH || process.env.Path || '');
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['blender.exe', 'blender.cmd', 'blender.bat'] : ['blender'];
  for (const dir of String(pathEnv).split(sep).filter(Boolean)) {
    for (const n of names) {
      const p = (platform === 'win32' ? path.win32 : path.posix).join(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
// startBench(cfg, deps) → { dir, stop() }. deps (tests): spawn, fs, os, exists/readdir/platform/pathEnv (exe
// resolution), exe (skip resolution), readyTimeoutMs, stopWaitMs. Rejects (child killed, dir removed) when
// Blender is missing / dies / does not announce BENCH READY in time. stop() is idempotent.
async function startBench(cfg, deps = {}) {
  const fsx = deps.fs || fs;
  const osx = deps.os || os;
  const spawn = deps.spawn || childProcess.spawn;
  const exe = deps.exe || resolveBlenderExe(cfg, deps);
  if (!exe) { const e = new Error(NO_BLENDER); e.unavailable = true; throw e; }
  const readyMs = deps.readyTimeoutMs || READY_TIMEOUT_MS;
  const stopMs = deps.stopWaitMs || STOP_WAIT_MS;

  const dir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'phoenix-bench-'));
  const env = { ...process.env, PHOENIX_BLENDER_IPC_DIR: dir };   // a COPY — this process's env is never modified
  // Sweep 2 G5: the driver lives as long as the whole run may legitimately take (the caller's budget), not a fixed 600 s
  const budgetMs = Number.isFinite(deps.benchBudgetMs) && deps.benchBudgetMs > 0 ? deps.benchBudgetMs : 600000;
  env.PHOENIX_BENCH_MAX_SECONDS = String(Math.min(36000, Math.ceil(budgetMs / 1000)));
  let child;
  try {
    child = spawn(exe, ['-b', '--factory-startup', '--python', DRIVER], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    throw new Error('Blender could not be started: ' + e.message);
  }

  let exited = false, exitInfo = '';
  const exitWaiters = [];
  const onExit = (why) => { if (exited) return; exited = true; exitInfo = why || ''; exitWaiters.forEach(f => f()); };
  child.on('exit', (code, sig) => onExit('exit ' + (code !== null && code !== undefined ? code : sig)));
  child.on('error', (e) => onExit('error ' + (e && e.message)));

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { fsx.writeFileSync(path.join(dir, 'STOP'), ''); } catch (_) {}
    if (!exited) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, stopMs);
        exitWaiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
    if (!exited) { try { child.kill(); } catch (_) {} }   // only THIS child — it is ours
    try { fsx.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    await new Promise((resolve, reject) => {
      let buf = '', done = false;
      const finish = (err) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => finish(new Error('Blender did not become ready within ' + Math.round(readyMs / 1000) + ' s')), readyMs);
      const onData = (d) => { buf += String(d); if (buf.includes('BENCH READY')) finish(null); };
      if (child.stdout) child.stdout.on('data', onData);
      if (child.stderr) child.stderr.on('data', (d) => { buf += String(d).slice(0, 2000); });
      exitWaiters.push(() => finish(new Error('Blender exited before it was ready (' + exitInfo + ')')));
      if (exited) finish(new Error('Blender exited before it was ready (' + exitInfo + ')'));
    });
  } catch (e) {
    await stop();
    throw e;
  }
  return { dir, stop, exe, hasExited: () => exited, exitInfo: () => exitInfo };
}

// The bench's own callBlender: ALWAYS carries the bench dir, never the live/default one.
function makeBenchCall(dir, deps = {}) {
  const ipc = deps.blenderIpc || require('../blender-ipc');
  return (code, opts = {}) => ipc.callBlender(code, { cfg: { apps: { blenderIpcDir: dir } }, timeoutMs: opts.timeoutMs || 30000 });
}

// ── Tasks ───────────────────────────────────────────────────────────────────
const out = (r) => String((r && (r.stdout || r.output)) || '').trim();

// Run read-only Python that prints ONE json line → parsed object. Throws with a readable reason.
async function readJson(benchCall, py) {
  const r = await benchCall(py);
  if (r && r.status === 'error') throw new Error(String(r.message || out(r) || 'Blender error').slice(0, 160));
  const text = out(r);
  const line = text.split('\n').map(s => s.trim()).filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch (_) { throw new Error('unreadable scene reading: ' + line.slice(0, 80)); }
}

const PY_NAMES = "import bpy, json\nprint(json.dumps([[o.name, o.type] for o in bpy.data.objects]))";

const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const fmt = (n) => (typeof n === 'number' ? (Math.round(n * 1000) / 1000) : String(n));

const TASKS = [
  {
    id: 'red',
    prompt: 'Make the crate red.',
    async check(benchCall) {
      const j = await readJson(benchCall,
        "import bpy, json\n" +
        "o = bpy.data.objects.get('Crate')\n" +
        "res = {'crate': bool(o), 'base': None, 'diffuse': None}\n" +
        "m = o.data.materials[0] if (o and o.type == 'MESH' and len(o.data.materials)) else None\n" +
        "if m is not None:\n" +
        "    res['diffuse'] = [float(x) for x in m.diffuse_color[:3]]\n" +
        "    if m.node_tree:\n" +
        "        for n in m.node_tree.nodes:\n" +
        "            if n.type == 'BSDF_PRINCIPLED':\n" +
        "                res['base'] = [float(x) for x in n.inputs['Base Color'].default_value[:3]]\n" +
        "                break\n" +
        "print(json.dumps(res))");
      if (!j.crate) return { ok: false, why: 'Crate is missing' };
      const isRed = (c) => Array.isArray(c) && c[0] >= 0.5 && c[1] <= 0.3 && c[2] <= 0.3;
      if (isRed(j.base) || isRed(j.diffuse)) return { ok: true };
      const show = (c) => c ? '(' + c.map(fmt).join(', ') + ')' : 'none';
      return { ok: false, why: j.base === null && j.diffuse === null ? 'Crate has no material' : 'Crate base color ' + show(j.base) + ' / viewport ' + show(j.diffuse) + ' is not red' };
    },
  },
  {
    id: 'lift',
    prompt: 'Move the light 2 metres up.',
    async check(benchCall) {
      const j = await readJson(benchCall,
        "import bpy, json\n" +
        "o = bpy.data.objects.get('Light')\n" +
        "print(json.dumps({'light': [float(v) for v in o.location] if o else None}))");
      if (!j.light) return { ok: false, why: 'Light is missing' };
      const [x, y, z] = j.light;
      if (!near(z, 7, 0.05)) return { ok: false, why: 'Light z = ' + fmt(z) + ', expected 7.0' };
      if (!near(x, 0, 0.05) || !near(y, 0, 0.05)) return { ok: false, why: 'Light x/y moved to (' + fmt(x) + ', ' + fmt(y) + '), expected (0, 0)' };
      return { ok: true };
    },
  },
  {
    id: 'delete',
    prompt: 'Delete the ball.',
    async check(benchCall) {
      const names = (await readJson(benchCall, PY_NAMES)).map(p => p[0]);
      if (names.includes('Ball')) return { ok: false, why: 'Ball still exists' };
      const lost = ['Crate', 'Light', 'Camera'].filter(n => !names.includes(n));
      if (lost.length) return { ok: false, why: 'also deleted: ' + lost.join(', ') };
      return { ok: true };
    },
  },
  {
    id: 'count',
    prompt: 'How many mesh objects are in the scene?',
    async check(benchCall, replyText) {
      const reply = String(replyText || '');
      const said = /(?<![\d.])2(?![\d]|\.\d)/.test(reply) || /\btwo\b/i.test(reply);
      if (!said) return { ok: false, why: 'reply does not say 2: "' + reply.replace(/\s+/g, ' ').slice(0, 60) + '"' };
      const names = (await readJson(benchCall, PY_NAMES)).map(p => p[0]).sort();
      const want = FIXTURE_NAMES.slice().sort();
      if (names.length !== want.length || names.some((n, i) => n !== want[i])) return { ok: false, why: 'the scene changed (' + names.join(', ') + ')' };
      return { ok: true };
    },
  },
  {
    id: 'cylinder',
    prompt: 'Add a cylinder 3 metres tall next to the crate.',
    async check(benchCall) {
      const j = await readJson(benchCall,
        "import bpy, json\n" +
        "from mathutils import Vector\n" +
        "res = {'crate': None, 'objs': []}\n" +
        "c = bpy.data.objects.get('Crate')\n" +
        "if c: res['crate'] = [float(c.location.x), float(c.location.y)]\n" +
        "for o in bpy.data.objects:\n" +
        "    if o.name in ('Crate', 'Ball', 'Light', 'Camera'): continue\n" +
        "    d = {'name': o.name, 'type': o.type}\n" +
        "    if o.type == 'MESH':\n" +
        "        pts = [o.matrix_world @ Vector(v) for v in o.bound_box]\n" +
        "        xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]\n" +
        "        d['h'] = max(zs) - min(zs)\n" +
        "        d['xy'] = [(max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2]\n" +
        "    res['objs'].append(d)\n" +
        "print(json.dumps(res))");
      const meshes = (j.objs || []).filter(o => o.type === 'MESH');
      if (meshes.length !== 1) return { ok: false, why: meshes.length + ' new mesh objects, expected exactly 1' };
      const m = meshes[0];
      if (!(m.h >= 2.7 && m.h <= 3.3)) return { ok: false, why: 'height ' + fmt(m.h) + ', expected 2.7–3.3' };
      if (!j.crate) return { ok: false, why: 'Crate is missing' };
      const dist = Math.hypot(m.xy[0] - j.crate[0], m.xy[1] - j.crate[1]);
      if (!(dist >= 0.5 && dist <= 5)) return { ok: false, why: 'distance to Crate ' + fmt(dist) + ', expected 0.5–5' };
      return { ok: true };
    },
  },
];

// ── The bench tool map ──────────────────────────────────────────────────────
// Only blender_run + read_state; runTurn answers everything else with the refusal text (opts.tools set).
function makeBenchTools(benchCall, assistant) {
  return {
    blender_run: (input) => assistant.blenderRunWith(input || {}, (code) => benchCall(code)),
    read_state: async () => {
      try {
        const names = await readJson(benchCall, PY_NAMES);
        return JSON.stringify({ sceneObjects: names.map(p => ({ name: p[0], type: p[1] })) }, null, 2);
      } catch (e) { return 'ERROR: ' + e.message; }
    },
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────
// runBench(seatName, candidate, cfg, deps) →
//   { passed, total, runs, ranAt, blender, tasks:[{ id, passes, runs, whys:[<=3 unique], sample? }] }
//   | { score:null, unavailable }.   candidate = { provider, model, endpoint }.
// A LOCAL candidate (openai-compat, no apiKeyRef) runs the five tasks 3x; every other provider 1x. One Blender
// process serves all runs; the fixture is reset before every task. `sample` (<=300 chars of the model's last TOOL
// block or reply) is kept only for tasks with a failure — it is MODEL OUTPUT, so the UI must render it as text.
// deps (tests): runs (override), startBench, makeBenchCall, complete(seat, cfg, req) (= providers.complete),
// assistant, runTurn, taskTimeoutMs, onProgress(task, of, id, run, runs), plus everything startBench takes.
function sampleOf(raw) {
  const t = String(raw || '');
  const k = t.indexOf('TOOL:');
  return (k >= 0 ? t.slice(k) : t).slice(0, 300);
}

async function runBench(seatName, candidate, cfg, deps = {}) {
  const assistant = deps.assistant || require('../assistant');
  const runTurn = deps.runTurn || assistant.runTurn;
  const complete = deps.complete || require('../providers').complete;
  const taskMs = deps.taskTimeoutMs || TASK_TIMEOUT_MS;

  const cur = (cfg && cfg.seats && cfg.seats[seatName] && typeof cfg.seats[seatName] === 'object') ? cfg.seats[seatName] : {};
  const cand = {};
  for (const k of ['provider', 'model', 'endpoint']) if (candidate && typeof candidate[k] === 'string') cand[k] = candidate[k];
  const benchCfg = { ...(cfg || {}), seats: { ...((cfg && cfg.seats) || {}), [seatName]: { ...cur, ...cand } } };

  let runs = Number.isInteger(deps.runs) && deps.runs > 0 ? deps.runs : null;
  if (runs === null) {
    try {
      const seat = require('../providers/seats').resolveSeat(seatName, benchCfg, {});
      runs = (seat.provider === 'openai-compat' && seat.kind === 'local') ? LOCAL_RUNS : 1;
    } catch (_) { runs = 1; }
  }

  let bench;
  try {
    // budget = every task of every run at its full timeout + resets + a margin (sweep 2 G5)
    bench = await (deps.startBench || startBench)(cfg, { ...deps, benchBudgetMs: runs * TASKS.length * taskMs + 10 * 60 * 1000 });
  } catch (e) {
    return { score: null, unavailable: e && e.unavailable ? NO_BLENDER : 'Blender did not start for the benchmark (' + String((e && e.message) || e).slice(0, 120) + ')' };
  }
  const exe = bench.exe || null;
  try {
    const benchCall = (deps.makeBenchCall || makeBenchCall)(bench.dir, deps);
    const baseTools = makeBenchTools(benchCall, assistant);
    const agg = TASKS.map(t => ({ id: t.id, passes: 0, runs: 0, whys: [], sample: undefined }));
    for (let run = 1; run <= runs; run++) {
      for (let i = 0; i < TASKS.length; i++) {
        const task = TASKS[i];
        if (typeof deps.onProgress === 'function') { try { deps.onProgress(i + 1, TASKS.length, task.id, run, runs); } catch (_) {} }
        const t0 = Date.now();
        let ok = false, why = '', cancelled = false, lastRaw = '', lastTool = '', turn = null;
        const deadline = t0 + taskMs;
        // Sweep 2 G4: a timed-out task is CANCELLED - none of its late tool calls may reach Blender (they would run against the NEXT task's fixture)
        const tools = {};
        for (const [tn, tfn] of Object.entries(baseTools)) {
          tools[tn] = async (...args) => { if (cancelled) throw new Error('benchmark task timed out'); const r = await tfn(...args); if (cancelled) throw new Error('benchmark task timed out'); return r; };
        }
        try {
          if (bench.hasExited && bench.hasExited()) return { score: null, unavailable: 'Blender exited during the benchmark (' + (bench.exitInfo ? bench.exitInfo() : 'unknown') + ') - this is an infrastructure failure, not a result for the model' };
          const rr = await benchCall('_bench_reset()');
          if (rr && rr.status === 'error') throw new Error('fixture reset failed: ' + String(rr.message || '').slice(0, 100));
          let timer;
          turn = runTurn(task.prompt, [], {}, benchCfg, {
            complete: async (messages, sys) => {
              if (cancelled) throw new Error('benchmark task timed out');
              const r = await complete(seatName, benchCfg, { system: sys, messages, purpose: 'bench', timeoutMs: Math.max(1000, deadline - Date.now()) + 5000 });
              if (cancelled) throw new Error('benchmark task timed out');   // the answer arrived after the deadline: it must not start a tool call   // the TASK timer is authoritative; the provider gets a bit longer
              const text = r && r.text;
              if (typeof text === 'string') { lastRaw = text; if (text.includes('TOOL:')) lastTool = text; }
              return text;
            },
            tools,
            systemSuffix: BENCH_SUFFIX,
            noVisionGate: true,
          });
          const timeout = new Promise((_, rej) => { timer = setTimeout(() => { cancelled = true; rej(Object.assign(new Error('timeout'), { isTimeout: true })); }, taskMs); });
          let reply;
          try { reply = await Promise.race([turn, timeout]); }
          finally { clearTimeout(timer); turn.catch(() => {}); }
          if (cancelled) throw Object.assign(new Error('timeout'), { isTimeout: true });
          const v = await task.check(benchCall, reply && reply.text);
          ok = !!v.ok; why = ok ? '' : (v.why || 'check failed');
        } catch (e) {
          ok = false;
          why = (cancelled || (e && e.isTimeout)) ? 'timeout' : String((e && e.message) || e).slice(0, 160);
        }
        // settle before the next fixture reset: give the cancelled turn a moment to unwind so nothing of it is still in flight
        if (cancelled && turn) await Promise.race([turn.catch(() => {}), new Promise(r => setTimeout(r, deps.settleMs != null ? deps.settleMs : 3000))]);
        // Sweep 2 G5: if the Blender driver itself died, the task did not fail - the infrastructure did; do not score it
        if (bench.hasExited && bench.hasExited()) return { score: null, unavailable: 'Blender exited during the benchmark (' + (bench.exitInfo ? bench.exitInfo() : 'unknown') + ') - this is an infrastructure failure, not a result for the model' };
        const a = agg[i];
        a.runs++;
        if (ok) a.passes++;
        else {
          if (why && !a.whys.includes(why) && a.whys.length < 3) a.whys.push(why);
          if (a.sample === undefined) a.sample = sampleOf(lastTool || lastRaw);   // first failed attempt
        }
      }
    }
    const tasks = agg.map(a => { const o = { id: a.id, passes: a.passes, runs: a.runs, whys: a.whys }; if (a.sample !== undefined) o.sample = a.sample; return o; });
    return { passed: tasks.reduce((n, t) => n + t.passes, 0), total: runs * TASKS.length, runs, ranAt: new Date().toISOString(), blender: exe || undefined, tasks };
  } finally {
    await bench.stop();
  }
}

// ── Verdict (shared by the server gate and the runtime guard) ───────────────
// An old-shape entry (score/of, no runs) counts as NOT RUN. → { state:'none'|'unavailable'|'pass'|'fail', passed, total, runs, need, weak }
function benchVerdict(b) {
  if (!b || typeof b !== 'object') return { state: 'none' };
  if (b.unavailable) return { state: 'unavailable' };
  if (!Number.isInteger(b.passed) || !Number.isInteger(b.total) || !Number.isInteger(b.runs) || b.runs < 1 || b.total < 1) return { state: 'none' };
  const need = Math.ceil(PASS_RATIO * b.total - 1e-9);
  const weak = (b.tasks || []).filter(t => t && t.passes < t.runs).map(t => t.id + ' ' + t.passes + '/' + t.runs);
  return { state: b.passed >= need ? 'pass' : 'fail', passed: b.passed, total: b.total, runs: b.runs, need, weak };
}

module.exports = { LOCAL_RUNS, PASS_RATIO, benchVerdict, OF, TASKS, BENCH_SUFFIX, NO_BLENDER, DRIVER, resolveBlenderExe, startBench, makeBenchCall, makeBenchTools, runBench };
