'use strict';

const path   = require('path');
const { spawn } = require('child_process');
const fs     = require('fs');
const dbg    = require('./debug-log');
const { callBlender } = require('./blender-ipc');

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

function spawnPhoenixStage(args, timeoutMs) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let partialLine = '';

    const child = spawn('node', [PHOENIX_PATH, ...args], { encoding: 'utf8' });

    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false, timedOut: true,
        stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''),
      });
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdoutChunks.push(chunk);
      const combined = partialLine + chunk;
      const lines = combined.split('\n');
      partialLine = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          try { if (dbg && typeof dbg.event === 'function') dbg.event('pipeline', { line: line.trim() }); } catch {}
        }
      }
    });

    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: '', stderr: err.message, error: err.message });
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (partialLine.trim()) {
        try { if (dbg && typeof dbg.event === 'function') dbg.event('pipeline', { line: partialLine.trim() }); } catch {}
      }
      resolve({
        ok: code === 0, code,
        stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''),
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

  const res = await spawnPhoenixStage(args, 660000);

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
    const categories = ['flat', 'furniture', 'item', 'architecture', 'flora', 'fauna'];
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
    // RAW import — default; no shading applied
    code = `import bpy\nbpy.ops.import_scene.gltf(filepath='${fwd}')\nprint("IMPORT_OK:" + '${basename}')`;
  } else {
    // CLEANED import — mirrors blenderCleanup logic in phoenix.js
    code = [
      'import bpy',
      `bpy.ops.import_scene.gltf(filepath='${fwd}')`,
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
      `print("IMPORT_OK:" + '${basename}')`,
    ].join('\n');
  }

  try {
    const result = await callBlender(code);
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

module.exports = { STAGES, runPromptStage, runImageStage, runMeshStage, runImportStage, advance };
