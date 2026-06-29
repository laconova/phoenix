'use strict';

const readline = require('readline');
const { spawnSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const net  = require('net');
const { runPreflight } = require('./preflight');
const dbg = require('./debug-log');

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_FILE  = path.join(__dirname, 'phoenix-config.json');
const PALETTE_FILE = path.join(__dirname, 'palette.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

const { loadPalette } = require('./palette');
const { getActive, resolveSlot } = require('./workflows');

const _cfg     = loadConfig();
const _palette = loadPalette();

const COMFY_BASE   = (_cfg.endpoints && _cfg.endpoints.comfyui) || 'http://localhost:8000';
const LOCAL_BASE   = process.env.LOCAL_API   || (_cfg.endpoints && _cfg.endpoints.local) || 'http://localhost:1234/v1';
const GEMMA_MODEL  = process.env.GEMMA_MODEL || (_cfg.seats && _cfg.seats.metaprompter && _cfg.seats.metaprompter.model) || 'claude-haiku-4-5-20251001';
const EJECT_AFTER  = !!(_cfg.seats && _cfg.seats.metaprompter && _cfg.seats.metaprompter.ejectAfterUse);
const GEMMA_TEMP   = (_cfg.seats && _cfg.seats.metaprompter && _cfg.seats.metaprompter.temperature) || 0.7;
const BLENDER_PORT = 9876;

const COMFY_OUTPUT = (_cfg.apps && _cfg.apps.comfyOutput) ||
  path.join(process.env.USERPROFILE || process.env.HOME || '', 'Documents', 'ComfyUI', 'output');
// Active image/3D workflow files + node-maps now come from the registry (workflows.js)
// via getActive(stage, _cfg). The old FLUX_WORKFLOW / TRELLIS_WORKFLOW constants were
// removed in the Phase 2 engine refactor (2026-06-27).
const OUTPUT_BASE    = path.join(__dirname, 'output');
const STAGING_BASE   = path.join(__dirname, 'staging');

// ─── Category defaults ────────────────────────────────────────────────────────

const CATEGORIES = Object.fromEntries(
  Object.entries(_palette.categories).map(([k, v]) => [k, { target_face_num: v.target_face_num, cfg: v.cfg, steps: v.steps }])
);

const CATEGORY_LABELS = {
  flat:         'flat prop  (plank / panel / floor)',
  furniture:    'furniture  (chair / table / shelf)',
  item:         'item       (tool / weapon / container)',
  architecture: 'architecture  (wall / pillar / arch)',
  flora:        'flora  (tree / plant / shrub)',
  fauna:        'fauna / monster  (static)',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

const randomSeed  = () => Math.floor(Math.random() * 0x7fffffff);
const slug        = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 28);
const nowStamp    = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

async function withProgress(label, fn) {
  const start = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${label} ${s}s`);
  }, 1000);
  process.stdout.write(`  ${label} 0s`);
  try {
    const r = await fn();
    clearInterval(timer);
    const s = Math.floor((Date.now() - start) / 1000);
    process.stdout.write(`\r  ${label} done (${s}s)\n`);
    dbg.progress(label, { ms: Date.now() - start, ok: true });
    return r;
  } catch (e) {
    clearInterval(timer);
    process.stdout.write('\n');
    dbg.progress(label, { ms: Date.now() - start, ok: false, err: e.message });
    throw e;
  }
}

// ─── LLM calls ───────────────────────────────────────────────────────────────

function callClaude(systemPrompt, user) {
  const r = spawnSync(
    'claude',
    ['--print', '--model', 'claude-sonnet-4-6', '--system-prompt', systemPrompt, user],
    // shell:true on Windows — `claude` is often a .cmd shim the OS loader can't exec directly (ENOENT otherwise). No-op on POSIX.
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' }
  );
  if (r.error)      throw new Error(`Claude CLI: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`Claude CLI exit ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

function lmsLoad(modelKey) {
  try {
    const r = spawnSync('lms', ['load', modelKey, '-y'], { encoding: 'utf8', timeout: 120000 });
    if (r.error)       { dbg.event('eject', { phase: 'load-error',   model: modelKey, error: r.error.message }); return; }
    if (r.status !== 0){ dbg.event('eject', { phase: 'load-nonzero', model: modelKey, code: r.status, stderr: String(r.stderr || '').slice(0, 200) }); return; }
    dbg.event('eject', { phase: 'loaded', model: modelKey });
  } catch (e) { dbg.event('eject', { phase: 'load-throw', error: (e && e.message) || String(e) }); }
}
function lmsUnload(modelKey) {
  try {
    const r = spawnSync('lms', ['unload', modelKey], { encoding: 'utf8', timeout: 30000 });
    if (r.error)       { dbg.event('eject', { phase: 'unload-error',   model: modelKey, error: r.error.message }); return; }
    if (r.status !== 0){ dbg.event('eject', { phase: 'unload-nonzero', model: modelKey, code: r.status, stderr: String(r.stderr || '').slice(0, 200) }); return; }
    dbg.event('eject', { phase: 'unloaded', model: modelKey });
  } catch (e) { dbg.event('eject', { phase: 'unload-throw', error: (e && e.message) || String(e) }); }
}

async function callLocal(systemPrompt, user) {
  const _t = Date.now();
  const body = JSON.stringify({
    model: GEMMA_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: user },
    ],
    temperature: GEMMA_TEMP,
    max_tokens: 4000,
    stream: false,
    thinking: { type: 'disabled' },
  });
  // Up to 2 attempts: LM Studio JIT-loads the model on the first request, which can
  // briefly return "No models loaded" before the load finishes (a race). One retry
  // after a short wait lets the load complete instead of failing the whole gen.
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${LOCAL_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) {
        const content = (await res.json()).choices[0].message.content.trim();
        dbg.llm('metaprompter', { ms: Date.now() - _t, respChars: content.length, attempt });
        return content;
      }
      lastErr = `HTTP ${res.status}: ${await res.text()}`;
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 3000)); // give JIT loading time
  }
  throw new Error(`Local metaprompter model "${GEMMA_MODEL}" isn't responding from LM Studio at ${LOCAL_BASE} (${lastErr}). Load the model in LM Studio (or enable JIT loading), then retry — or switch the metaprompter to Haiku in Settings (no local model needed).`);
}

// ─── Blender IPC ─────────────────────────────────────────────────────────────

function callBlender(code) {
  return new Promise((resolve, reject) => {
    dbg.ipc('send', { code });
    const msg  = JSON.stringify({ type: 'execute', code, strict_json: false }) + '\x00';
    const sock = new net.Socket();
    const chunks = [];

    sock.setTimeout(90000);
    sock.connect(BLENDER_PORT, 'localhost', () => sock.write(Buffer.from(msg, 'utf8')));
    sock.on('data', d => { chunks.push(d); if (d.includes(0)) sock.end(); });
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').replace(/\x00/g, '').trim();
      dbg.ipc('recv', raw);
      try { resolve(JSON.parse(raw)); } catch { resolve({ output: raw }); }
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('Blender socket timeout')); });
    sock.on('error', err => {
      dbg.ipc('error', err.message);
      if (err.code === 'ECONNREFUSED')
        reject(new Error('Blender not reachable on port 9876 — is Blender open with the IPC server running?'));
      else
        reject(err);
    });
  });
}

// ─── ComfyUI helpers ─────────────────────────────────────────────────────────

async function comfyCheck() {
  try {
    const res = await fetch(`${COMFY_BASE}/queue`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

async function comfyUploadImage(filePath) {
  const data = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const form = new FormData();
  form.append('image', new Blob([data], { type: 'image/png' }), name);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res = await fetch(`${COMFY_BASE}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed ${res.status}: ${await res.text()}`);
  return (await res.json()).name;
}

async function comfyQueue(workflow) {
  const res = await fetch(`${COMFY_BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!res.ok) throw new Error(`Queue failed ${res.status}: ${await res.text()}`);
  const d = await res.json();
  if (d.error) throw new Error(`ComfyUI rejected workflow: ${d.error.message || JSON.stringify(d.error)}`);
  return d.prompt_id;
}

async function comfyPoll(promptId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  let consecFails = 0;
  const MAX_CONSEC_FAILS = 5; // ~15s of consecutive unreachable polls ⇒ ComfyUI is gone, not a blip
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`${COMFY_BASE}/history/${promptId}`);
      consecFails = 0; // got a response ⇒ ComfyUI is reachable
      if (!res.ok) continue;
      const hist  = await res.json();
      const entry = hist[promptId];
      if (!entry) continue;
      const done = (entry.status && entry.status.completed) ||
                   (entry.outputs && Object.keys(entry.outputs).length > 0);
      if (done) return entry.outputs || {};
    } catch {
      // A thrown fetch = ComfyUI unreachable. Tolerate a few (transient blip),
      // but bail fast if it stays down instead of polling silently to the timeout.
      consecFails++;
      if (consecFails >= MAX_CONSEC_FAILS) {
        throw new Error(`ComfyUI became unreachable during generation (${consecFails} consecutive failed status checks) — is ComfyUI still running?`);
      }
    }
  }
  throw new Error(`ComfyUI timed out after ${timeoutMs / 60000} min — check the UI`);
}

async function comfyDownload(filename, subfolder = '', type = 'output') {
  const url = `${COMFY_BASE}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Category inference ───────────────────────────────────────────────────────

const CAT_SYSTEM = [
  'You are a 3D asset categorizer. Given a description, return ONE word from this list:',
  Object.keys(_palette.categories).join(', '),
  '',
  ...Object.entries(_palette.categories).map(([k, v]) => `${k} = ${v.hint}`),
  '',
  'Reply with ONLY the single category word. No explanation.',
].join('\n');

function inferCategory(userPrompt) {
  try {
    const raw = callClaude(CAT_SYSTEM, userPrompt);
    const cat = raw.trim().toLowerCase().split(/\s+/)[0];
    return CATEGORIES[cat] ? cat : 'item';
  } catch (e) {
    console.error(`  Category inference failed (${e.message}), defaulting to 'item'`);
    return 'item';
  }
}

// ─── Metaprompt ───────────────────────────────────────────────────────────────

const META_SYSTEM_HEADER = `You are a Flux 2 image prompt engineer specializing in 3D asset reference images.
The image will be used as input to Trellis, a 3D mesh generator. The image MUST show:
- Single isolated object, centered in frame
- Clean white or transparent background
- Clear silhouette, minimal drop shadow
- All sides of the object visible from a slight 3/4 angle

Output EXACTLY this format, no other text:
POSITIVE:
<prompt, comma-separated phrases, 30-60 words>

NEGATIVE:
<negative prompt, 15-25 words>

Style rules by category:`;

const META_SYSTEM = META_SYSTEM_HEADER +
  Object.entries(_palette.categories).map(([k, v]) => `\n- ${k}: ${v.style}`).join('');

async function generateMetaprompt(userPrompt, category) {
  const _mpUser = `Category: ${category}\nDescription: ${userPrompt}`;
  const isLocal = !/^claude/i.test(GEMMA_MODEL);
  let text;
  if (isLocal) {
    if (EJECT_AFTER) lmsLoad(GEMMA_MODEL);
    try {
      text = await callLocal(META_SYSTEM, _mpUser);
    } finally {
      if (EJECT_AFTER) lmsUnload(GEMMA_MODEL);
    }
  } else {
    text = await callClaudeMeta(META_SYSTEM, _mpUser, GEMMA_MODEL);
  }
  const posM = text.match(/POSITIVE:\s*([\s\S]+?)(?:\nNEGATIVE:|$)/i);
  const negM = text.match(/NEGATIVE:\s*([\s\S]+?)$/i);
  const positive = posM ? posM[1].trim() : '';
  const negative = negM ? negM[1].trim() : '';
  if (!positive) {
    console.error('\n  [WARN] Gemma returned empty POSITIVE — raw output below:');
    console.error('  ' + text.slice(0, 400).replace(/\n/g, '\n  '));
    throw new Error('Empty POSITIVE from metaprompter — hit [r] to retry');
  }
  return {
    positive,
    negative: negative || 'blurry, low quality, distorted, multiple objects, cluttered background, shadows, people, text',
  };
}

async function callClaudeMeta(systemPrompt, user, model) {
  return new Promise((resolve, reject) => {
    const out = [], err = [];
    const child = spawn('claude', ['--print', '--tools', '', '--strict-mcp-config', '--model', model, '--system-prompt', systemPrompt, user], { encoding: 'utf8', shell: process.platform === 'win32' });
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => reject(new Error('Claude CLI: ' + e.message)));
    child.on('close', code => {
      if (code !== 0) { reject(new Error('Claude CLI exit ' + code + ': ' + err.join('').trim())); return; }
      resolve(out.join('').trim());
    });
  });
}

// ─── Stage: Flux image gen ───────────────────────────────────────────────────

async function runFlux(session) {
  const wfEntry = getActive('image', _cfg);
  const n  = wfEntry.nodes;
  const wf = JSON.parse(fs.readFileSync(wfEntry.file, 'utf8'));

  const set = (slot, value) => { if (n[slot] == null) return; const r = resolveSlot('image', slot, n[slot]); wf[r.node].inputs[r.field] = value; };
  set('positive', session.imagePrompt);
  set('negative', session.negativePrompt);
  set('cfg', session.params.cfg);
  set('steps', session.params.steps);
  set('seed', session.fluxSeed);

  return withProgress('Flux image gen', async () => {
    const promptId = await comfyQueue(wf);
    const outputs  = await comfyPoll(promptId, 180000);

    const outNode  = resolveSlot('image', 'output', n.output).node;
    const saveNode = outputs[outNode];
    if (!saveNode || !saveNode.images || !saveNode.images.length)
      throw new Error(`No image in ComfyUI output node ${outNode}`);

    const img     = saveNode.images[0];
    const imgData = await comfyDownload(img.filename, img.subfolder, img.type);

    const outDir  = path.join(OUTPUT_BASE, session.category);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${slug(session.userPrompt)}_${nowStamp()}_flux.png`);
    fs.writeFileSync(outPath, imgData);
    return outPath;
  });
}

// ─── Stage: Trellis 3D gen ────────────────────────────────────────────────────

async function runTrellis(session) {
  const wfEntry = getActive('mesh', _cfg);
  const n  = wfEntry.nodes;
  const wf = JSON.parse(fs.readFileSync(wfEntry.file, 'utf8'));

  return withProgress('Trellis 3D gen', async () => {
    const uploadedName = await comfyUploadImage(session.imagePath);
    const prefix = `phoenix_${slug(session.userPrompt)}_${session.trellisSeed}`;

    const set = (slot, value) => { if (n[slot] == null) return; const r = resolveSlot('mesh', slot, n[slot]); wf[r.node].inputs[r.field] = value; };
    set('image', uploadedName);
    set('seed', session.trellisSeed);
    set('target_face_num', session.params.target_face_num);
    set('output_prefix', prefix);

    const promptId = await comfyQueue(wf);
    const outputs  = await comfyPoll(promptId, 600000);

    // ExportMesh returns glb_path as STRING output
    let glbPath = null;
    const outNode = resolveSlot('mesh', 'output', n.output).node;
    const expNode = outputs[outNode];
    if (expNode && expNode.glb_path) {
      glbPath = Array.isArray(expNode.glb_path) ? expNode.glb_path[0] : expNode.glb_path;
    }

    // Fallback: scan ComfyUI output dir for newest matching GLB
    if (!glbPath || !fs.existsSync(glbPath)) {
      const files = fs.readdirSync(COMFY_OUTPUT)
        .filter(f => f.startsWith(prefix) && f.endsWith('.glb'))
        .map(f => ({ f, mt: fs.statSync(path.join(COMFY_OUTPUT, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);
      if (files.length) glbPath = path.join(COMFY_OUTPUT, files[0].f);
    }

    if (!glbPath || !fs.existsSync(glbPath))
      throw new Error(`GLB not found after Trellis run (prefix: ${prefix})`);

    const outDir  = path.join(OUTPUT_BASE, session.category);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${prefix}.glb`);
    fs.copyFileSync(glbPath, outPath);
    return outPath;
  });
}

// ─── Stage: Blender cleanup ───────────────────────────────────────────────────

async function blenderCleanup(session) {
  const meshPath = session.meshPath.replace(/\\/g, '/');
  const assetName = slug(session.userPrompt);

  const code = [
    'import bpy',
    `bpy.ops.import_scene.gltf(filepath='${meshPath}')`,
    'imported = [o for o in bpy.context.selected_objects if o.type == "MESH"]',
    'for obj in imported:',
    '    bpy.ops.object.select_all(action="DESELECT")',
    '    obj.select_set(True)',
    '    bpy.context.view_layer.objects.active = obj',
    // NOTE: normals_make_consistent(inside=False) removed 2026-06-23 — it flipped ~26% of faces
    // on Trellis output (measured 1876/7236), causing "missing surfaces". auto_smooth fixes the
    // shading without touching winding; raw GLB normals are kept as-is.
    '    try:',
    '        bpy.ops.object.shade_auto_smooth(angle=0.523599)',
    '        print("SMOOTH:auto_smooth")',
    '    except Exception:',
    '        try:',
    '            bpy.ops.object.shade_smooth_by_angle(angle=0.523599)',
    '            print("SMOOTH:smooth_by_angle")',
    '        except Exception as _e:',
    '            bpy.ops.object.shade_smooth()',
    '            print("SMOOTH:fallback " + str(_e))',
    `    obj.name = '${assetName}'`,
    'print("CLEANUP_DONE:" + str(len(imported)))',
  ].join('\n');

  return withProgress('Blender cleanup', () => callBlender(code));
}

async function importRaw(session) {
  const meshPath  = session.meshPath.replace(/\\/g, '/');
  const assetName = slug(session.userPrompt) + '_raw';

  const code = [
    'import bpy',
    `bpy.ops.import_scene.gltf(filepath='${meshPath}')`,
    'imported = [o for o in bpy.context.selected_objects if o.type == "MESH"]',
    'for obj in imported:',
    `    obj.name = '${assetName}'`,
    'print("IMPORT_RAW_DONE:" + str(len(imported)))',
  ].join('\n');

  return withProgress('Import raw', () => callBlender(code));
}

// ─── UX helpers ──────────────────────────────────────────────────────────────

function prompt(rl, q) {
  return new Promise(res => rl.question(q, res));
}

async function stepPause(rl, label, withSameSeed = true) {
  const opts = withSameSeed
    ? '[n] next  [r] redo (new seed)  [s] redo (same seed)  [e] edit params  [q] quit'
    : '[n] next  [r] redo  [e] edit params  [q] quit';
  while (true) {
    const raw = await prompt(rl, `\n  --- ${label} ---\n  ${opts}\n> `);
    const c = raw.trim().toLowerCase();
    if (['n','r','s','e','q'].includes(c)) return c;
    console.log('  Unknown key.');
  }
}

async function editParams(rl, session) {
  console.log('\n  Current params:');
  for (const [k, v] of Object.entries(session.params)) {
    console.log(`    ${k.padEnd(20)} ${v}`);
  }
  console.log('  Enter param=value to change (empty to cancel):');
  while (true) {
    const raw = await prompt(rl, '  > ');
    if (!raw.trim()) return;
    const m = raw.trim().match(/^(\w+)\s*=\s*(.+)$/);
    if (!m) { console.log('  Format: param_name=value'); continue; }
    const [, k, v] = m;
    if (!(k in session.params)) { console.log(`  Unknown: ${k}. Valid: ${Object.keys(session.params).join(', ')}`); continue; }
    const num = parseFloat(v);
    session.params[k] = isNaN(num) ? v : (Number.isInteger(session.params[k]) ? Math.round(num) : num);
    console.log(`  Set ${k} = ${session.params[k]}`);
    return;
  }
}

// ─── Shared finalization (staging copy + RESULT_GLB marker) ──────────────────

async function finalizeMesh(session, headless = false) {
  if (session.meshPath && fs.existsSync(session.meshPath)) {
    const stagingDir = path.join(STAGING_BASE, session.category);
    fs.mkdirSync(stagingDir, { recursive: true });
    const stagingPath = path.join(stagingDir, path.basename(session.meshPath));
    fs.copyFileSync(session.meshPath, stagingPath);
    console.log(`\n  Saved to staging:\n  ${stagingPath}`);
    if (headless) process.stdout.write(`\nRESULT_GLB: ${stagingPath}\n`);
    return stagingPath;
  }
  return null;
}

// ─── Stage entry points ───────────────────────────────────────────────────────

async function runImageStage(userPrompt, categoryOverride, literalPos = null, literalNeg = null) {
  const category = categoryOverride || inferCategory(userPrompt);
  const params   = { ...CATEGORIES[category] };
  const session  = {
    userPrompt,
    category,
    params,
    fluxSeed:      randomSeed(),
    imagePrompt:   null,
    negativePrompt: null,
    imagePath:     null,
  };

  process.stdout.write(`CATEGORY: ${category}\n`);
  console.log(`  Category: ${category}  (${CATEGORY_LABELS[category]})`);

  // Step 1: Metaprompt (or bypass with literal prompt)
  if (literalPos && literalPos.trim()) {
    session.imagePrompt    = literalPos;
    session.negativePrompt = literalNeg || '';
    console.log('  Using provided prompt (metaprompter skipped).');
  } else {
    process.stdout.write('  Metaprompter (Gemma E4B)...');
    const { positive, negative } = await generateMetaprompt(userPrompt, category);
    session.imagePrompt    = positive;
    session.negativePrompt = negative;
  }
  console.log('\n\n  POSITIVE:\n  ' + session.imagePrompt);
  console.log('\n  NEGATIVE:\n  ' + session.negativePrompt);
  process.stdout.write(`RESULT_PROMPT_POS: ${session.imagePrompt.replace(/\n/g, ' ')}\n`);
  process.stdout.write(`RESULT_PROMPT_NEG: ${session.negativePrompt.replace(/\n/g, ' ')}\n`);

  // Step 2: Image generation
  console.log(`\n  seed: ${session.fluxSeed}`);
  session.imagePath = await runFlux(session);
  console.log(`  → ${session.imagePath}`);
  process.stdout.write(`RESULT_IMAGE: ${session.imagePath}\n`);
}

async function runMeshStage(imagePath, userPrompt, categoryOverride, targetFaceNum = null) {
  if (!fs.existsSync(imagePath)) {
    process.stderr.write(`Stage error: image not found: ${imagePath}\n`);
    process.exit(1);
  }

  const category = categoryOverride || inferCategory(userPrompt);
  const params   = { ...CATEGORIES[category] };
  if (Number.isFinite(targetFaceNum) && targetFaceNum > 0) {
    params.target_face_num = Math.round(Math.min(300000, Math.max(200, targetFaceNum)));
  }
  const session  = {
    userPrompt,
    category,
    params,
    trellisSeed: randomSeed(),
    imagePath,
    meshPath:    null,
  };

  console.log(`  Category: ${category}  (${CATEGORY_LABELS[category]})`);
  console.log(`  seed: ${session.trellisSeed}  |  target_face_num: ${session.params.target_face_num}`);

  // Step 1: Trellis 3D gen
  session.meshPath = await runTrellis(session);
  console.log(`  → ${session.meshPath}`);

  // Step 2 (cleanup/import) is intentionally removed — deferred to the import gate.
  // The orchestrator calls import_asset with cleanup:true|false to control shading.

  // Step 3: Staging + RESULT_GLB marker
  await finalizeMesh(session, true);
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

async function runPipeline(rl, userPrompt, categoryOverride = null, headless = false) {
  const session = {
    userPrompt,
    category:      null,
    params:        null,
    fluxSeed:      randomSeed(),
    trellisSeed:   randomSeed(),
    imagePrompt:   null,
    negativePrompt: null,
    imagePath:     null,
    meshPath:      null,
  };

  // Category
  process.stdout.write('  Detecting category...');
  session.category = categoryOverride || inferCategory(userPrompt);
  session.params   = { ...CATEGORIES[session.category] };
  console.log(` ${session.category}  (${CATEGORY_LABELS[session.category]})`);
  console.log(`  Defaults → ${session.params.target_face_num} faces | CFG ${session.params.cfg} | ${session.params.steps} steps\n`);

  // ── Step 1: Metaprompt ────────────────────────────────────────────────────
  while (true) {
    process.stdout.write('  Metaprompter (Gemma E4B)...');
    try {
      const { positive, negative } = await generateMetaprompt(userPrompt, session.category);
      session.imagePrompt    = positive;
      session.negativePrompt = negative;
      console.log('\n\n  POSITIVE:\n  ' + positive);
      console.log('\n  NEGATIVE:\n  ' + negative);
    } catch (e) {
      console.error(`\n  Metaprompt failed: ${e.message}`);
      if (headless) throw e;
    }
    if (headless) break;

    const c = await stepPause(rl, 'Metaprompt', false);
    if (c === 'q') return;
    if (c === 'e') { await editParams(rl, session); continue; }
    if (c === 'r') continue;
    break;
  }

  // ── Step 2: Image generation ──────────────────────────────────────────────
  while (true) {
    console.log(`\n  seed: ${session.fluxSeed}`);
    try {
      session.imagePath = await runFlux(session);
      console.log(`  → ${session.imagePath}`);
    } catch (e) {
      console.error(`  Image gen failed: ${e.message}`);
      if (headless) throw e;
    }
    if (headless) break;

    const c = await stepPause(rl, 'Image result', true);
    if (c === 'q') return;
    if (c === 'r') { session.fluxSeed = randomSeed(); continue; }
    if (c === 's') continue;
    if (c === 'e') { await editParams(rl, session); session.fluxSeed = randomSeed(); continue; }
    break;
  }

  // ── Step 3: 3D generation ─────────────────────────────────────────────────
  while (true) {
    console.log(`\n  seed: ${session.trellisSeed}  |  target_face_num: ${session.params.target_face_num}`);
    try {
      session.meshPath = await runTrellis(session);
      console.log(`  → ${session.meshPath}`);
    } catch (e) {
      console.error(`  3D gen failed: ${e.message}`);
      if (headless) throw e;
    }
    if (headless) break;

    const c = await stepPause(rl, '3D mesh result', true);
    if (c === 'q') return;
    if (c === 'r') { session.trellisSeed = randomSeed(); continue; }
    if (c === 's') continue;
    if (c === 'e') { await editParams(rl, session); continue; }
    break;
  }

  // ── Step 4: Blender cleanup (interactive only — headless skips; import gate owns cleanup) ──
  if (!headless && session.meshPath) {
    const doClean = await prompt(rl, '\n  Run Blender cleanup? (normals + smooth shading) [y/n] ');
    if (doClean.trim().toLowerCase() === 'y') {
      try {
        const result = await blenderCleanup(session);
        const out = result.stdout || result.output || JSON.stringify(result);
        if (out) console.log('  ' + out);
      } catch (e) {
        console.log(`  Blender cleanup skipped: ${e.message}`);
      }
    }
  }

  // ── Step 5: Staging ───────────────────────────────────────────────────────
  await finalizeMesh(session, headless);

  // ── Post-run: re-import menu (interactive only) ───────────────────────────
  if (!headless && rl && session.meshPath && fs.existsSync(session.meshPath)) {
    while (true) {
      const raw = await prompt(
        rl,
        `\n  --- re-import ${path.basename(session.meshPath)} ---\n  [i] import raw (no cleanup)   [c] import + cleanup   [enter] done\n> `
      );
      const c = raw.trim().toLowerCase();
      if (c === '') break;
      if (c === 'i') {
        try {
          const r = await importRaw(session);
          const out = r.stdout || r.output || '';
          if (out) console.log('  ' + String(out).trim());
        } catch (e) { console.log(`  Import failed: ${e.message}`); }
        continue;
      }
      if (c === 'c') {
        try {
          const r = await blenderCleanup(session);
          const out = r.stdout || r.output || '';
          if (out) console.log('  ' + String(out).trim());
        } catch (e) { console.log(`  Cleanup import failed: ${e.message}`); }
        continue;
      }
      console.log('  Unknown key.');
    }
  }

  console.log('\n  Pipeline complete.\n');
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

async function main() {
  dbg.initDebug({ enabled: process.argv.includes('--debug') });
  console.log('\n  PHOENIX AGENT v0.1');
  console.log('  Text  →  Image (Flux 2 Klein)  →  3D (Trellis)  →  Blender\n');
  console.log('  Type a description to start, or prefix with category:');
  console.log('  furniture: wooden chair   |   item: battle axe   |   exit\n');

  if (!process.argv.includes('--skip-preflight')) {
    try {
      await runPreflight();
    } catch (e) {
      console.log(`  (preflight skipped — internal error: ${e.message})`);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question('phoenix> ', async raw => {
      const input = raw.trim();
      if (!input)                            { ask(); return; }
      if (input === 'exit' || input === 'quit') { console.log('  Bye.\n'); rl.close(); return; }

      if (input === '/debug' || input.startsWith('/debug ')) {
        const arg = input.slice(6).trim();
        if (arg === 'on')       { dbg.setDebug(true);  console.log('  debug echo ON\n'); }
        else if (arg === 'off') { dbg.setDebug(false); console.log('  debug echo OFF\n'); }
        else                    { console.log(`  debug echo is ${dbg.isDebug() ? 'ON' : 'OFF'}\n`); }
        ask(); return;
      }
      if (input.startsWith('/')) {
        console.log(`  Unknown command: ${input}  (try /debug on)\n`);
        ask(); return;
      }

      let userPrompt = input;
      let catOverride = null;
      const m = input.match(/^([a-z]+):\s*(.+)$/i);
      if (m && CATEGORIES[m[1].toLowerCase()]) {
        catOverride = m[1].toLowerCase();
        userPrompt  = m[2].trim();
      }

      try {
        await runPipeline(rl, userPrompt, catOverride);
      } catch (e) {
        console.error(`\n  Pipeline error: ${e.message}\n`);
      }

      ask();
    });
  };

  ask();
}

// CLI dispatch
const _args = process.argv.slice(2);
dbg.initDebug({ enabled: _args.includes('--debug') });

const _si = _args.indexOf('--stage');
const _hi = _args.indexOf('--headless');

if (_si >= 0) {
  // Stage mode: node phoenix.js --stage <image|mesh> --desc "<text>" [--cat <cat>] [--image "<path>"] [--prompt "<pos>"] [--neg "<neg>"]
  const _stageName = _args[_si + 1] || '';
  const _di        = _args.indexOf('--desc');
  const _desc      = _di >= 0 ? _args[_di + 1] : null;
  const _ci        = _args.indexOf('--cat');
  const _cat       = _ci >= 0 ? _args[_ci + 1] : null;

  if (_stageName === 'image') {
    if (!_desc) { process.stderr.write('--stage image requires --desc "<description>"\n'); process.exit(1); }
    const _ppi  = _args.indexOf('--prompt');
    const _ppos = _ppi >= 0 ? _args[_ppi + 1] : null;
    const _nni  = _args.indexOf('--neg');
    const _nneg = _nni >= 0 ? _args[_nni + 1] : null;
    (async () => {
      try {
        await runImageStage(_desc, _cat, _ppos, _nneg);
      } catch (e) {
        process.stderr.write(`Stage error: ${e.message}\n`);
        process.exitCode = 1;
        return;
      }
    })();
  } else if (_stageName === 'mesh') {
    // Usage: --stage mesh --image "<path>" --desc "<text>" [--cat <cat>] [--faces <n>]
    const _ii    = _args.indexOf('--image');
    const _image = _ii >= 0 ? _args[_ii + 1] : null;
    if (!_image) { process.stderr.write('--stage mesh requires --image "<path>"\n'); process.exit(1); }
    if (!_desc)  { process.stderr.write('--stage mesh requires --desc "<description>"\n'); process.exit(1); }
    const _fi    = _args.indexOf('--faces');
    const _faces = _fi >= 0 ? parseInt(_args[_fi + 1], 10) : null;
    (async () => {
      try {
        await runMeshStage(_image, _desc, _cat, Number.isFinite(_faces) ? _faces : null);
      } catch (e) {
        process.stderr.write(`Stage error: ${e.message}\n`);
        process.exitCode = 1;
        return;
      }
    })();
  } else if (_stageName === 'prompt') {
    // Usage: --stage prompt --desc "<text>" [--cat <cat>]
    if (!_desc) { process.stderr.write('--stage prompt requires --desc "<description>"\n'); process.exit(1); }
    (async () => {
      try {
        const category = _cat || inferCategory(_desc);
        process.stdout.write(`CATEGORY: ${category}\n`);
        console.log(`  Category: ${category}  (${CATEGORY_LABELS[category]})`);
        process.stdout.write('  Metaprompter (Gemma E4B)...');
        const { positive, negative } = await generateMetaprompt(_desc, category);
        console.log('\n\n  POSITIVE:\n  ' + positive);
        console.log('\n  NEGATIVE:\n  ' + negative);
        process.stdout.write(`RESULT_PROMPT_POS: ${positive.replace(/\n/g, ' ')}\n`);
        process.stdout.write(`RESULT_PROMPT_NEG: ${negative.replace(/\n/g, ' ')}\n`);
      } catch (e) {
        process.stderr.write(`Stage error: ${e.message}\n`);
        process.exitCode = 1;
        return;
      }
    })();
  } else {
    process.stderr.write(`Unknown stage: "${_stageName}". Valid stages: image, mesh, prompt\n`);
    process.exit(1);
  }
} else if (_hi >= 0) {
  // Headless mode: node phoenix.js --headless "description" [--cat category]
  const _desc = _args[_hi + 1] || '';
  const _ci   = _args.indexOf('--cat');
  const _cat  = _ci >= 0 ? _args[_ci + 1] : null;
  if (!_desc) { console.error('--headless requires a description argument'); process.exit(1); }
  (async () => {
    try {
      await runPipeline(null, _desc, _cat, true);
    } catch (e) {
      console.error(`Pipeline error: ${e.message}`);
      process.exit(1);
    }
  })();
} else {
  main();
}
