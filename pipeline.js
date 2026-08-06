'use strict';

const path   = require('path');
const { spawn } = require('child_process');
const fs     = require('fs');
const dbg    = require('./debug-log');
const palette = require('./palette');
const { callBlender } = require('./blender-ipc');
const { demetalPy } = require('./mesh-import-fix');

// ─── Stage list ───────────────────────────────────────────────────────────────

const STAGES = ['prompt', 'image', 'mesh', 'import'];

// ─── Constants ────────────────────────────────────────────────────────────────

const PHOENIX_PATH = path.join(__dirname, 'phoenix.js');
const STAGING_BASE = path.join(__dirname, 'staging');
const SCENE_FILE   = path.join(__dirname, 'session', 'scene.json');

// ─── Blender IPC ─────────────────────────────────────────────────────────────
// File-based transport via blender-ipc.js (callBlender imported above). Was a 9876
// socket; raw sockets fail cross-process on Windows + Blender 5.1 / Python 3.13
// (WinError 10035, accept() never returns). blender-ipc handles its own debug logging.

// ─── Phoenix stage spawn helper ───────────────────────────────────────────────
// Mirrors the spawn/parse pattern in assistant.js toolGenerateImage / toolImageTo3d.

// ─── Cancellation ─────────────────────────────────────────────────────────────
// The running stage child is held here so /stop can reach it. Without this the
// handle only ever lived inside the promise closure, so a run that had clearly
// gone wrong could not be stopped from the UI — you could only wait out the
// 11-minute mesh timeout (found 2026-08-01, an OOM'd Trellis run burned 7.5 min
// with no way to abort).
let _currentChild = null;
let _currentStage = null;
let _cancelled    = false;
// The ComfyUI prompt_id the running stage queued (announced by phoenix.js on stdout). Null for
// stages that never touch ComfyUI (prompt/import) — which is exactly why the cancel below is safe.
let _currentPromptId = null;

// Where ComfyUI lives. Read fresh (not cached at require time) so a config edit
// does not need a restart to take effect here.
function comfyBase() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'phoenix-config.json'), 'utf8'));
    return ((cfg.endpoints || {}).comfyui || 'http://localhost:8188').replace(/\/$/, '');
  } catch { return 'http://localhost:8188'; }
}

// Killing the local child does NOT stop the rig. phoenix.js has its own cancel, but it
// never runs when WE kill the process — so the cancel has to happen here too.
// This is the leak the user hit on 2026-08-01: the outer 11-min timeout killed the child
// while ComfyUI kept sampling for minutes, holding the whole card for a dead job.
//
// ⚠️ /interrupt is GLOBAL — no prompt_id, it stops whatever the instance runs *right now*. The
// laptop, the rig and the user's manual Trellis runs all share one ComfyUI, so firing it blind
// aborts a foreign job (measured 2026-08-01). So this is TARGETED by the prompt_id phoenix.js
// announced: dequeue ours if it is only pending, and interrupt ONLY when ours is the one running.
// A stage that queued nothing (prompt/import) passes promptId=null and this never touches ComfyUI.
async function cancelComfy(promptId, why) {
  if (!promptId) return 'no ComfyUI prompt from this stage — left untouched';
  const base = comfyBase();
  // Remove it if still pending — targeted by id, cannot affect a foreign job.
  try {
    await fetch(base + '/queue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(5000),
    });
  } catch (_) { /* best effort */ }
  // Interrupt ONLY if OUR prompt is the one executing. queue_running items are
  // [number, prompt_id, prompt, extra, outputs], so the id is a member of the tuple.
  try {
    const q = await (await fetch(base + '/queue', { signal: AbortSignal.timeout(5000) })).json();
    const oursRunning = (q.queue_running || []).some(it => Array.isArray(it) && it.includes(promptId));
    if (oursRunning) {
      const r = await fetch(base + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(5000) });
      try { dbg.event('comfy', { phase: 'interrupted', why, promptId, ok: r.ok }); } catch {}
      return r.ok ? 'interrupted (ours was running)' : 'interrupt HTTP ' + r.status;
    }
    try { dbg.event('comfy', { phase: 'dequeued', why, promptId }); } catch {}
    return 'dequeued (ours was pending, not running) — foreign job left alone';
  } catch (e) {
    return 'queue-check unreachable: ' + String((e && e.message) || e);
  }
}

// Kill the running stage child, if any, AND stop the rig-side job it was waiting on.
// Returns what was actually stopped. Async: the caller wants to report the remote result.
async function killCurrent(why = 'user stop') {
  if (!_currentChild) return { stopped: false, stage: null, comfyui: 'not attempted' };
  const stage = _currentStage;
  const promptId = _currentPromptId;
  _cancelled = true;
  try { _currentChild.kill(); } catch (_) { /* already gone */ }
  const comfyui = await cancelComfy(promptId, why);
  return { stopped: true, stage, comfyui };
}

function currentStage() {
  return _currentChild ? _currentStage : null;
}

function spawnPhoenixStage(args, timeoutMs) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let partialLine = '';
    let timedOut = false;      // set by the stage timeout; the close handler owns the single resolve
    let cancelResult = null;   // the in-flight rig cancel, awaited in the close handler for its message

    const child = spawn('node', [PHOENIX_PATH, ...args], { encoding: 'utf8' });
    // args is ['--stage', '<name>', ...] — index 1 is the stage being run.
    _currentChild = child;
    // Normal stages arrive as ['--stage', '<name>', ...]; generate_prop arrives as ['--headless',
    // <description>, ...] where args[1] is the PROMPT, not a stage — using it made /stop announce
    // "Stopped the <prompt> stage". Map the headless (prop) form to a real label (fixed 2026-08-02).
    _currentStage = args[0] === '--headless' ? 'prop' : (args[1] || 'unknown');
    _cancelled    = false;
    _currentPromptId = null;

    const timer = setTimeout(() => {
      // Capture the prompt id before the kill so the cancel targets OUR job, not a foreign one,
      // and kick the rig-side cancel now (killing the child alone leaves ComfyUI computing for
      // minutes on a job nobody will collect). Do NOT resolve here: the kill triggers 'close',
      // which used to win the race and report a nameless failure — the close handler owns the
      // single resolve, and reads `timedOut` to tell a timeout from an ordinary exit.
      const promptId = _currentPromptId;
      timedOut = true;
      cancelResult = cancelComfy(promptId, `stage timeout after ${Math.round(timeoutMs / 60000)} min`);
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdoutChunks.push(chunk);
      const combined = partialLine + chunk;
      const lines = combined.split('\n');
      partialLine = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          // phoenix.js announces the ComfyUI prompt it queued; capture it so a later cancel
          // targets our job instead of firing a global interrupt at a foreign one. NOT anchored:
          // the spinner in withProgress can prefix the line with "\r  label Ns" before the marker.
          const pm = line.match(/PHX_COMFY_PROMPT\s+(\S+)/);
          if (pm) _currentPromptId = pm[1];
          try { if (dbg && typeof dbg.event === 'function') dbg.event('pipeline', { line: line.trim() }); } catch {}
        }
      }
    });

    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    child.on('error', err => {
      clearTimeout(timer);
      if (_currentChild === child) { _currentChild = null; _currentStage = null; _currentPromptId = null; }
      resolve({ ok: false, stdout: '', stderr: err.message, error: err.message });
    });

    child.on('close', async code => {
      clearTimeout(timer);
      if (partialLine.trim()) {
        try { if (dbg && typeof dbg.event === 'function') dbg.event('pipeline', { line: partialLine.trim() }); } catch {}
      }
      const wasCancelled = _cancelled && _currentChild === child;
      if (_currentChild === child) { _currentChild = null; _currentStage = null; _cancelled = false; _currentPromptId = null; }
      if (timedOut) {
        // Resolve the timeout HERE, the single place, so its diagnosis actually reaches the caller
        // instead of losing the race to a bare close. Wait for the rig cancel so we can report it.
        const comfyui = cancelResult
          ? await cancelResult.catch(e => 'cancel failed: ' + ((e && e.message) || e))
          : 'not attempted';
        resolve({
          ok: false, timedOut: true, comfyui,
          stdout: stdoutChunks.join(''),
          stderr: (stderrChunks.join('') +
            `\n[pipeline] stage timed out after ${Math.round(timeoutMs / 60000)} min; ` +
            `ComfyUI cancel: ${comfyui}`).trim(),
        });
        return;
      }
      resolve({
        ok: code === 0, code, cancelled: wasCancelled,
        // A cancelled run exits non-zero; say so plainly instead of letting it
        // surface as a nameless "stage failed".
        stdout: stdoutChunks.join(''),
        stderr: wasCancelled ? 'cancelled by user' : stderrChunks.join(''),
      });
    });
  });
}

// ─── Stage runners ────────────────────────────────────────────────────────────
// Each takes a ctx object and resolves to { ok, stage, artifact?, error? }.
// (Naming note: pipeline.js runImageStage is a conductor runner that spawns
//  phoenix.js --stage image; it is distinct from the same-named function inside
//  phoenix.js. No cross-import is needed or used here.)

async function runPromptStage(ctx) {
  const desc = ctx.desc || '';
  const args = ['--stage', 'prompt', '--desc', desc];
  if (ctx.cat) args.push('--cat', ctx.cat);

  const res = await spawnPhoenixStage(args, 120000);

  if (!res.ok) {
    const tail = (res.stderr || res.stdout || '').trim().slice(-500);
    return { ok: false, stage: 'prompt', error: `prompt stage failed (exit ${res.code !== undefined ? res.code : 'timeout'}): ${tail}` };
  }

  const mPos = res.stdout.match(/RESULT_PROMPT_POS:\s*(.+)/);
  const mNeg = res.stdout.match(/RESULT_PROMPT_NEG:\s*(.+)/);
  const mCat = res.stdout.match(/CATEGORY:\s*(.+)/);

  if (!mPos) {
    return { ok: false, stage: 'prompt', error: `no RESULT_PROMPT_POS in output\n${res.stdout.slice(0, 500)}` };
  }

  return {
    ok:        true,
    stage:     'prompt',
    artifact:  mPos[1].trim(),
    promptNeg: mNeg ? mNeg[1].trim() : '',
    category:  mCat ? mCat[1].trim() : (ctx.cat || null),
  };
}

async function runImageStage(ctx) {
  const desc = ctx.desc || '';
  const args = ['--stage', 'image', '--desc', desc];
  if (ctx.cat)       args.push('--cat',    ctx.cat);
  if (ctx.promptPos) args.push('--prompt', ctx.promptPos);
  if (ctx.promptNeg) args.push('--neg',    ctx.promptNeg);

  const res = await spawnPhoenixStage(args, 240000);

  if (!res.ok) {
    const tail = (res.stderr || res.stdout || '').trim().slice(-500);
    return { ok: false, stage: 'image', error: `image stage failed: ${tail}` };
  }

  const mImage = res.stdout.match(/RESULT_IMAGE:\s*(.+)/);
  if (!mImage) {
    return { ok: false, stage: 'image', error: `no RESULT_IMAGE in output\n${res.stdout.slice(0, 500)}` };
  }

  const mCat = res.stdout.match(/CATEGORY:\s*(.+)/);

  return {
    ok:       true,
    stage:    'image',
    artifact: mImage[1].trim(),
    category: mCat ? mCat[1].trim() : (ctx.cat || null),
  };
}

async function runMeshStage(ctx) {
  const image = ctx.image || '';
  const desc  = ctx.desc  || 'asset';
  const args  = ['--stage', 'mesh', '--image', image, '--desc', desc];
  if (ctx.cat)   args.push('--cat',   ctx.cat);
  if (ctx.faces) args.push('--faces', String(ctx.faces));

  // The outer wall MUST exceed the inner mesh poll (phoenix.js comfyPoll = 30 min) plus headroom for
  // one OOM-retry rung — otherwise it kills the child mid-run before the inner timeout can cancel the
  // ComfyUI job and the retry ladder never fires. 11 min < 30 min was exactly that bug (fixed 2026-08-02).
  const res = await spawnPhoenixStage(args, 2400000); // 40 min

  if (!res.ok) {
    const tail = (res.stderr || res.stdout || '').trim().slice(-500);
    return { ok: false, stage: 'mesh', error: `mesh stage failed: ${tail}` };
  }

  const mGlb = res.stdout.match(/RESULT_GLB:\s*(.+)/);
  if (!mGlb) {
    return { ok: false, stage: 'mesh', error: `no RESULT_GLB in output\n${res.stdout.slice(0, 500)}` };
  }

  return {
    ok:       true,
    stage:    'mesh',
    artifact: mGlb[1].trim(),
  };
}

async function runImportStage(ctx) {
  // Mirrors toolImportAsset in assistant.js
  let assetPath = ctx.glb || '';
  const cleanup = ctx.cleanup === true || ctx.cleanup === 'true';

  // Resolve relative name to staging path
  if (assetPath && !path.isAbsolute(assetPath)) {
    // Reject path traversal in the caller-supplied name — the legit forms are "file.glb" and
    // "cat/file.glb"; a "../.." must not let an import escape the staging tree.
    if (assetPath.includes('..')) return { ok: false, stage: 'import', error: `invalid asset name: ${assetPath}` };
    const categories = Object.keys(palette.loadPalette().categories);
    let found = null;
    for (const cat of categories) {
      const candidate = path.join(STAGING_BASE, cat, assetPath.endsWith('.glb') ? assetPath : assetPath + '.glb');
      if (fs.existsSync(candidate)) { found = candidate; break; }
      const parts = assetPath.split('/');
      if (parts.length === 2) {
        const p2 = path.join(STAGING_BASE, parts[0], parts[1].endsWith('.glb') ? parts[1] : parts[1] + '.glb');
        if (fs.existsSync(p2)) { found = p2; break; }
      }
    }
    if (!found) return { ok: false, stage: 'import', error: `Asset not found in staging: ${assetPath}` };
    assetPath = found;
  }

  if (!assetPath) return { ok: false, stage: 'import', error: 'no glb path in ctx' };

  const fwd      = assetPath.replace(/\\/g, '/');
  const basename = path.basename(fwd);

  let code;
  if (!cleanup) {
    // RAW import — default; no shading applied (aber entmetallisiert: siehe mesh-import-fix.js)
    code = [
      'import bpy',
      `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(fwd)})`,
      'imported = [o for o in bpy.context.selected_objects if o.type == "MESH"]',
      ...demetalPy('imported'),
      `print("IMPORT_OK:" + ${JSON.stringify(basename)})`,
    ].join('\n');
  } else {
    // CLEANED import — mirrors blenderCleanup logic in phoenix.js
    code = [
      'import bpy',
      `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(fwd)})`,
      'imported = [o for o in bpy.context.selected_objects if o.type == "MESH"]',
      'for obj in imported:',
      '    bpy.ops.object.select_all(action="DESELECT")',
      '    obj.select_set(True)',
      '    bpy.context.view_layer.objects.active = obj',
      '    try:',
      '        bpy.ops.object.shade_auto_smooth(angle=0.523599)',
      '    except Exception:',
      '        try:',
      '            bpy.ops.object.shade_smooth_by_angle(angle=0.523599)',
      '        except Exception:',
      '            bpy.ops.object.shade_smooth()',
      ...demetalPy('imported'),
      `print("IMPORT_OK:" + ${JSON.stringify(basename)})`,
    ].join('\n');
  }

  try {
    const result = await callBlender(code);
    // callBlender RESOLVES with {status:'error'} on a Python failure (it only REJECTS on a transport
    // timeout, caught below) — so a corrupt/unimportable GLB or an importer exception would otherwise
    // be reported as a successful import and poison the scene cache. Require the IMPORT_OK marker,
    // which both import branches print as their LAST statement (only after the import actually ran).
    const out = String((result && (result.stdout || result.output)) || '');
    if (!result || result.status === 'error' || !out.includes('IMPORT_OK:')) {
      const tb = (out.match(/Traceback[\s\S]*/) || [''])[0].trim().slice(0, 400);
      const msg = (result && result.message) || '';
      return { ok: false, stage: 'import', error: 'import failed in Blender' + (tb ? ': ' + tb : (msg ? ': ' + msg : '')) };
    }
    const name = path.basename(assetPath, '.glb');
    // Update scene cache (mirrors assistant.js toolImportAsset L312–317; keep pipeline.js self-contained)
    try {
      let sc = { sceneObjects: [], sceneUpdatedAt: null };
      try {
        const raw2 = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8'));
        if (Array.isArray(raw2.sceneObjects)) sc.sceneObjects = raw2.sceneObjects;
        sc.sceneUpdatedAt = raw2.sceneUpdatedAt || null;
      } catch {}
      if (!sc.sceneObjects.includes(name)) {
        sc.sceneObjects.push(name);
        sc.sceneUpdatedAt = new Date().toISOString();
        fs.mkdirSync(path.dirname(SCENE_FILE), { recursive: true });
        fs.writeFileSync(SCENE_FILE, JSON.stringify({
          sceneObjects:   sc.sceneObjects,
          sceneUpdatedAt: sc.sceneUpdatedAt,
        }, null, 2));
      }
    } catch {}
    return { ok: true, stage: 'import', artifact: name };
  } catch (e) {
    return { ok: false, stage: 'import', error: e.message };
  }
}

// ─── Gate engine ──────────────────────────────────────────────────────────────

async function advance(ctx, cfg, runners) {
  if (!runners) {
    runners = {
      prompt:   runPromptStage,
      image:    runImageStage,
      mesh:     runMeshStage,
      'import': runImportStage,
    };
  }

  const idx  = STAGES.indexOf(ctx.stage);
  const next = STAGES[idx + 1];

  // No next stage — pipeline complete
  if (!next) return { done: true, ctx };

  // Gate on? Stop before running the next stage.
  const gates = (cfg && cfg.gates) || {};
  if (gates[ctx.stage] === true) {
    try {
      if (dbg && typeof dbg.event === 'function') {
        dbg.event('gate', { stage: ctx.stage, awaiting: ctx.stage, next });
      }
    } catch {}
    return { stopped: true, awaiting: ctx.stage, next, ctx };
  }

  // Gate off — run the next stage directly (no LLM round-trip)
  const r = await runners[next](ctx);
  if (r.ok === false) {
    return { error: r.error, ctx };
  }

  // Merge artifact and advance to the next stage
  ctx.stage = next;
  if (r.artifact !== undefined) {
    if (next === 'prompt') {
      ctx.promptPos = r.artifact;
      if (r.promptNeg !== undefined) ctx.promptNeg = r.promptNeg;
      if (r.category  !== undefined) ctx.cat       = r.category;
    } else if (next === 'image') {
      ctx.image = r.artifact;
      if (r.category !== undefined) ctx.cat = r.category;
    } else if (next === 'mesh') {
      ctx.glb = r.artifact;
    } else {
      ctx.artifact = r.artifact;
    }
  }

  return advance(ctx, cfg, runners);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { STAGES, runPromptStage, runImageStage, runMeshStage, runImportStage, spawnPhoenixStage, advance, killCurrent, currentStage };
