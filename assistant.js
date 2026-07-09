'use strict';

const readline = require('readline');
const { spawnSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const net  = require('net');
const blenderIpc = require('./blender-ipc');

// ─── Windows: resolve claude.exe path once to avoid shell:true newline truncation ──
// On Windows, spawning 'claude' with shell:true routes through cmd.exe which treats
// literal newlines in arguments as command separators — truncating multiline system
// prompts to their first line. We find the real .exe so we can spawn without shell.
const claudeCli = require('./claude-cli');
const { runPreflight } = require('./preflight');
const dbg = require('./debug-log');
const pipeline = require('./pipeline');
const jobs = require('./jobs');
const lock = require('./lock');
const palette = require('./palette');
const wf = require('./workflows');
const workflows = require('./workflows');
// brushes/ is gitignored user data, but its .py base + registry are code the brush
// tools need — seed them at boot (same idiom as config/palette/workflows self-seed).
require('./brush-scaffold').ensureBrushScaffold();

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_FILE   = path.join(__dirname, 'phoenix-config.json');
const CONFIG_EXAMPLE_FILE = path.join(__dirname, 'phoenix-config.example.json');
const HISTORY_FILE  = path.join(__dirname, 'session', 'history.json');
const STATE_FILE    = path.join(__dirname, 'session', 'state.json');
const HISTORY_KEEP  = 10;
const MAX_TOOL_CALLS = 3;

const BLENDER_ONLY_TOOLS = ['blender_run', 'read_state', 'list_assets', 'list_brushes', 'use_brush', 'save_as_brush', 'import_asset'];
const BLENDER_ONLY_SYSTEM = 'BLENDER-ONLY MODE (active this turn): The generation tools (generate_image, image_to_3d, generate_prop) are DISABLED. Build the requested asset by modelling it directly in Blender with bpy via the blender_run tool — use primitives, modifiers, transforms, and materials. Do NOT call any image/3D generation tool; if you do, it will be rejected.';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// First-run seed: if there's no phoenix-config.json yet, create it from the shipped example
// so a fresh clone works with just `node server.js` (no manual copy step — CMD has no `cp`).
// No-op when the config already exists or the example isn't present (e.g. the dev tree). Non-fatal.
function ensureConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(CONFIG_EXAMPLE_FILE)) {
      fs.copyFileSync(CONFIG_EXAMPLE_FILE, CONFIG_FILE);
      console.log('[setup] Created phoenix-config.json from phoenix-config.example.json — edit it to change endpoints/models.');
    }
  } catch (_) { /* non-fatal: loadConfig() falls back to defaults */ }
}

function getConfigValue(cfg, dotKey) {
  return dotKey.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), cfg);
}

function setConfigValue(cfg, dotKey, value) {
  const keys = dotKey.split('.');
  let cur = cfg;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function autoType(v) {
  if (v === 'null')  return null;
  if (v === 'true')  return true;
  if (v === 'false') return false;
  if (v !== '' && !isNaN(v)) return Number(v);
  return v;
}

const CATEGORY_ENUM = Object.keys(palette.loadPalette().categories).join('|');

const SYSTEM_PROMPT = `You are Phoenix, a creative assistant for 3D asset creation in Blender. You can generate images, turn images into 3D assets, and run Blender directly. You control Blender via file-based IPC (the Phoenix IPC addon). You have tools — use them.

ABSOLUTE RULES — no exceptions:
1. ANY action in Blender (add/move/delete objects, apply materials, run scripts, check the scene) → emit a TOOL block immediately. No preamble, no description of what you are about to do.
2. NEVER claim an action succeeded unless you have a TOOL_RESULT confirming it. If you haven't called a tool yet, you don't know what's in the scene.
3. NEVER mention MCP, addons, ports, servers, or connection setup. If Blender is unreachable the tool returns an error — just say "Blender isn't reachable" in one sentence.
4. After receiving a TOOL_RESULT: reply in 1-2 sentences summarizing what it shows. Nothing else.
5. If the user names a brush directly (e.g. "use the wooden plank brush", "place a gravinium coil"), call use_brush immediately with the slug — do NOT call list_brushes first. Only call list_brushes when the user is explicitly browsing ("what brushes do I have?", "show me furniture brushes").

TOOL BLOCK FORMAT — output these two lines exactly, no other text on them:
TOOL: tool_name
INPUT: {"key": "value"}

Use \\n (escaped) for newlines inside JSON string values. Do NOT wrap in code fences.

TOOLS:
- generate_image  runs the image generation stage; the system decides whether to continue automatically. INPUT: {"description": "...", "category": "${CATEGORY_ENUM}"}  Optional: {"prompt":"<exact positive>","negative":"<exact negative>"} to bypass the metaprompter and use an exact prompt.
- image_to_3d     runs the 3D mesh stage from the last generated image (or a given one); the system decides whether to continue automatically. INPUT: {} or {"image": "path", "description": "..."}  Optional: {"target_face_num": <n>} to regenerate the mesh at a specific face count (e.g. 7500).
- generate_prop   full pipeline image→3D in ONE shot, STAGES the result (GLB on disk). Does NOT import into the scene. REJECTED while any approval gate is enabled in Settings — use generate_image then. INPUT: {"description": "...", "category": "${CATEGORY_ENUM}"}
- blender_run     runs Python in Blender. INPUT: {"code": "python as single string, \\n for newlines"}
- read_state      reads session state: sceneObjects (what is LIVE in the Blender scene, kept fresh by the scene-sync module), stagedFiles (GLB FILES on disk in staging/, ready to import), lastTask, sceneUpdatedAt. INPUT: {}
- list_assets     lists staged GLB FILES on disk (in staging/). These are assets ready to import — they are NOT necessarily in the Blender scene. INPUT: {}
- read_palette    returns the current style palette (each category's style text + params). Use ONLY when the user asks you to help draft or choose a category. INPUT: {}
- list_materials   lists the shared MATERIAL palette (reusable materials that brushes share) — NOT the style palette above. INPUT: {}
- delete_material  removes a material from the shared MATERIAL palette by name (palette registry only; the open Blender scene is untouched). Use when the user says e.g. "delete material X from the palette". INPUT: {"name": "MaterialName"}
- import_asset    imports a staged file into the live Blender scene. INPUT: {"name": "filename.glb", "cleanup": true|false}. cleanup:true = import with auto-smooth shading; omitted/false = raw mesh (DEFAULT = raw).
- list_brushes    lists brushes. INPUT: {} for all, {"category": "item|furniture|sci_fi|..."} to filter by category, {"search": "keyword"} to search by name. Use filtered calls — avoid listing all when you only need one category.
- save_as_brush   saves Blender mesh(es) as a reusable brush — ONE brush file that places whole again later. INPUT: {"name": "slug", "collection": "CollectionName (optional — saves ALL meshes in it)", "object": "BlenderObjName (optional — single object)", "category": "item|sci_fi|etc (optional)", "display": "Human label (optional)"}. Omit collection AND object to save ALL currently selected meshes.
- use_brush       places a brush from the library into the scene at optional coordinates. INPUT: {"name": "slug", "x": 0, "y": 0, "z": 0, "instance_name": "optional"}

WORKFLOW RULES:
- Flow control (when to stop for approval between image / 3D / import) is handled automatically by the system based on settings — you do NOT need to tell the user to approve or ask permission between steps. Just call the tool the user's request implies, then relay the tool result. For a 3D prop call generate_image (or image_to_3d to continue from an existing image); for image-only requests use generate_image; never refuse an image-only request.
- If the user only wants an image (e.g. "an image of a dog"), use generate_image and stop. Do NOT refuse — you can produce images.
- Use generate_prop only when the user explicitly wants the whole thing done in one go without stopping — and only while no approval gate is enabled (gated sessions must go through generate_image so the pipeline can pause).
- If a tool result contradicts what you expected twice in a row, STOP retrying: diagnose first (read_state or a small blender_run inspection), then act on what you actually find.

BRUSH WORKFLOW (what save_as_brush really does — know this):
- A brush = ONE .blend library file holding mesh objects + their materials, plus a loader entry. Placing it later (use_brush) appends EVERY object from that file — a multi-part brush comes back whole.
- What gets saved is decided by the input: "collection" = all meshes in that collection; "object" = that one object; neither = all meshes currently selected in Blender. For "make a brush from the X collection" pass {"collection": "X"} — do NOT pick a single member object.
- After saving, VERIFY from the tool result: it reports the .blend path and how many meshes went in. If the count does not match what the user meant (e.g. 1 mesh from a 5-object collection), say so instead of declaring success.

EXAMPLES (follow these exactly):

User: whats in my blender scene?
TOOL: blender_run
INPUT: {"code": "import bpy\\nnames = [o.name for o in bpy.context.scene.objects]\\nprint('OBJECTS:' + str(names))"}

User: add a wooden plank
TOOL: blender_run
INPUT: {"code": "import bpy\\nbpy.ops.mesh.primitive_cube_add()\\nobj = bpy.context.active_object\\nobj.name = 'WoodenPlank'\\nobj.scale = (2.0, 0.15, 0.04)\\nbpy.ops.object.transform_apply(scale=True)\\nprint('ADDED:' + obj.name)"}

User: add a wood material to WoodenPlank
TOOL: blender_run
INPUT: {"code": "import bpy\\nobj = bpy.data.objects.get('WoodenPlank')\\nif not obj:\\n    print('ERROR: object not found')\\nelse:\\n    mat = bpy.data.materials.new('WoodProcedural')\\n    mat.use_nodes = True\\n    nodes = mat.node_tree.nodes\\n    nodes.clear()\\n    out = nodes.new('ShaderNodeOutputMaterial')\\n    bsdf = nodes.new('ShaderNodeBsdfPrincipled')\\n    wave = nodes.new('ShaderNodeTexWave')\\n    wave.inputs['Scale'].default_value = 5.0\\n    mat.node_tree.links.new(wave.outputs['Color'], bsdf.inputs['Base Color'])\\n    mat.node_tree.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])\\n    obj.data.materials.append(mat)\\n    print('MAT_APPLIED:' + mat.name)"}

User: list my staged assets
TOOL: list_assets
INPUT: {}

User: what brushes do I have?
TOOL: list_brushes
INPUT: {}

User: save this as a brush called gravinium_reactor
TOOL: save_as_brush
INPUT: {"name": "gravinium_reactor", "category": "sci_fi", "display": "Gravinium Reactor"}

User: save MyCoil as a brush called my_coil
TOOL: save_as_brush
INPUT: {"name": "my_coil", "object": "MyCoil", "category": "sci_fi", "display": "My Coil"}

User: make a brush out of the Campfire collection
TOOL: save_as_brush
INPUT: {"name": "campfire", "collection": "Campfire", "display": "Campfire"}

User: use the gravinium coil brush
TOOL: use_brush
INPUT: {"name": "gravinium_coil", "x": 0, "y": 0, "z": 0}

User: place a PCB Part A at position 2 1 0
TOOL: use_brush
INPUT: {"name": "electronic_part_pcb_a", "x": 2, "y": 1, "z": 0}

User: import it cleaned
TOOL: import_asset
INPUT: {"name": "phoenix_a_dog_0_2026-06-24T12-00.glb", "cleanup": true}

After TOOL_RESULT: 1-2 sentences on what it shows. If it is an error, say what failed in one sentence.`;

// ─── Session storage ──────────────────────────────────────────────────────────

function ensureSessionDir() {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(history) {
  ensureSessionDir();   // fresh clone has no session/ dir yet — create before first write
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-HISTORY_KEEP), null, 2));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { staged: [], lastTask: null, currentScene: 'untitled' }; }
}

function saveState(state) {
  ensureSessionDir();   // fresh clone has no session/ dir yet — create before first write
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const LIBRARY_LABELS_FILE = path.join(__dirname, 'library-labels.json');
function loadLibraryLabels() {
  try { const o = JSON.parse(fs.readFileSync(LIBRARY_LABELS_FILE, 'utf8')); if (!o.assets) o.assets = {}; return o; }
  catch { return { assets: {} }; }
}
function saveLibraryLabels(obj) {
  try { fs.writeFileSync(LIBRARY_LABELS_FILE, JSON.stringify(obj, null, 2)); } catch (_) {}
}

// ─── Scene cache (separate file) ────────────────────────────────────────────
// The LIVE Blender scene contents live in their OWN file, written ONLY by the
// scene-sync poller (and the manual `refresh`). Keeping it out of state.json
// avoids a clobber race: the long-running server caches state.json in memory at
// startup and re-saves it per turn, which would otherwise overwrite the poller.
// read_state reads this fresh from disk every call, so it always reflects the
// latest poll regardless of any in-memory state the server is holding.
const SCENE_FILE = path.join(__dirname, 'session', 'scene.json');

function loadSceneCache() {
  try {
    const s = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8'));
    return { sceneObjects: Array.isArray(s.sceneObjects) ? s.sceneObjects : [], sceneUpdatedAt: s.sceneUpdatedAt || null };
  } catch { return { sceneObjects: [], sceneUpdatedAt: null }; }
}

function saveSceneCache(cache) {
  fs.mkdirSync(path.dirname(SCENE_FILE), { recursive: true });
  fs.writeFileSync(SCENE_FILE, JSON.stringify({
    sceneObjects:   Array.isArray(cache.sceneObjects) ? cache.sceneObjects : [],
    sceneUpdatedAt: cache.sceneUpdatedAt || new Date().toISOString(),
  }, null, 2));
}

// ─── Blender IPC ─────────────────────────────────────────────────────────────

// File-based transport — see blender-ipc.js. (Was a 9876 socket; sockets fail
// cross-process on Windows + Blender 5.1 / Python 3.13. WinError 10035.)
function callBlender(code) {
  return blenderIpc.callBlender(code);
}

// ─── Tool implementations ─────────────────────────────────────────────────────

const STAGING_BASE = path.join(__dirname, 'staging');

// ─── Conductor advance result → status string ─────────────────────────────────
// Factual, no "ASK the user" wording. Called by toolGenerateImage / toolImageTo3d.

function describeAdvance(adv) {
  if (adv.error)   return `ERROR: ${adv.error}`;
  if (adv.stopped) {
    if (adv.awaiting === 'prompt') return 'Prompt generated — shown in the Prompt tab. (gate: prompt) Edit it if you like, then approve to generate the image.';
    if (adv.awaiting === 'image') return 'Image generated — shown in the Image tab. (gate: image) Next step is up to the user: make 3D, or regenerate.';
    if (adv.awaiting === 'mesh')  return '3D mesh generated and staged — shown in the Mesh tab. (gate: mesh) Next step is up to the user: import (raw or cleaned), or regenerate.';
  }
  if (adv.done) return 'Pipeline complete — the asset was imported into the Blender scene.';
  return 'Pipeline stopped (state unknown).';
}

// Live list of staged GLB FILES on disk (staging/) — single source of truth for "staged".
function listStagedFiles() {
  const categories = Object.keys(palette.loadPalette().categories);
  const found = [];
  for (const cat of categories) {
    const dir = path.join(STAGING_BASE, cat);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.glb'));
    for (const f of files) found.push({ name: f, category: cat, path: path.join(dir, f) });
  }
  return found;
}

function listBrushesData() {
  const REG = path.join(__dirname, 'brushes', 'registry.json');
  try {
    const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
    const brushes = reg.brushes || {};
    return Object.entries(brushes).map(([slug, b]) => ({
      slug, display: b.display || slug, type: b.type || 'phoenix', category: b.category || null,
    }));
  } catch { return []; }
}

function listMaterialsData() {
  const PY      = path.join(__dirname, 'brushes', 'phoenix_brushes.py');
  const PAL_DIR = path.join(__dirname, 'brushes', 'palette_materials');
  const out = [];

  // Solid presets: _PHOENIX_PALETTE lambdas. Scoped to the dict body so the
  // docstring's "M_YourMat" example can never be matched as a real entry.
  try {
    const src   = fs.readFileSync(PY, 'utf8');
    const open  = src.indexOf('_PHOENIX_PALETTE = {');
    const close = open >= 0 ? src.indexOf('\n}', open) : -1;
    const body  = (open >= 0 && close >= 0) ? src.slice(open, close) : '';
    const re = /"([^"]+)"\s*:\s*lambda[^:]*:\s*_make_\w+\(([^\n]*)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const tuple = m[2].match(/\(([^)]*)\)/);
      let color = null;
      if (tuple) {
        const nums = tuple[1].split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n));
        if (nums.length >= 3) color = [nums[0], nums[1], nums[2]];
      }
      out.push({ name: m[1], color });
    }
  } catch (_) {}

  // Procedural materials live as per-material .blend files, not as dict entries.
  try {
    for (const f of fs.readdirSync(PAL_DIR)) {
      if (f.endsWith('.blend')) out.push({ name: f.slice(0, -6), color: null });
    }
  } catch (_) {}

  return out;
}

async function toolListAssets(_input, _state, _cfg) {
  const found = listStagedFiles();
  if (!found.length) return 'No staged files on disk. Generate a prop first.';
  return found.map(a => `${a.category}/${a.name}`).join('\n');
}

async function toolReadState(_input, state, _cfg) {
  const scene = loadSceneCache(); // fresh from disk — reflects the latest scene-sync poll
  return JSON.stringify({
    currentScene:   state.currentScene,
    sceneObjects:   scene.sceneObjects,   // LIVE Blender scene contents (kept fresh by scene-sync)
    sceneUpdatedAt: scene.sceneUpdatedAt, // when the scene cache was last refreshed (null = never / poller off)
    stagedFiles:    listStagedFiles().map(a => `${a.category}/${a.name}`), // GLB files on disk, ready to import
    lastTask:       state.lastTask,
  }, null, 2);
}

async function toolReadPalette(_input, _state, _cfg) {
  const cats = palette.loadPalette().categories;
  return JSON.stringify({ categories: cats });
}

async function toolBlenderRun(input, _state, _cfg) {
  const code = input.code;
  if (!code) return 'ERROR: no code provided';
  try {
    const result = await callBlender(code);
    // Blender MCP returns print() output in result.stdout (not result.output)
    const out = (result.stdout || result.output || '').trim();
    if (result.status === 'error') {
      return `BLENDER_ERROR: ${result.message || out || JSON.stringify(result)}`;
    }
    if (!out) return `OK (script ran, no print output) — raw: ${JSON.stringify(result)}`;
    if (out.includes('Traceback') || /\bError:/i.test(out) || out.includes('SyntaxError')) {
      return `PYTHON_ERROR:\n${out}`;
    }
    return out;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

async function toolImportAsset(input, state, cfg) {
  const ctx = {
    stage:   'mesh',
    glb:     input.name || input.path || '',
    cleanup: input.cleanup,
  };

  const r = await pipeline.runImportStage(ctx);
  if (!r.ok) return `ERROR: ${r.error}`;
  return `Imported: ${r.artifact} — asset is now in the Blender scene.`;
}

async function toolGenerateProp(input, state, cfg) {
  const { description, category } = input;
  if (!description) return 'ERROR: description required';
  // One-shot bypasses the approval gates by construction (spawns --headless) — a gate the
  // orchestrator can route around is no gate, so hard-reject and steer to the staged path.
  const _g = (cfg && cfg.gates) || {};
  if (_g.prompt === true || _g.image === true || _g.mesh === true) {
    return 'REJECTED: approval gates are enabled in Settings, and generate_prop would skip them. Call generate_image instead — the pipeline pauses at each enabled gate.';
  }
  const cat = category || 'item';
  state.lastTask = `generate_prop: ${description}`;

  const phoenixPath = path.join(__dirname, 'phoenix.js');
  dbg.event('progress', { label: 'generate_prop', description, category: cat });

  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let partialLine = '';

    const child = spawn(
      'node',
      [phoenixPath, '--headless', description, '--cat', cat],
      { encoding: 'utf8' }
    );

    const timer = setTimeout(() => {
      child.kill();
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      resolve(`Pipeline failed (exit timeout):\n${(stderr || stdout || '').slice(0, 500)}`);
    }, 600000);

    child.stdout.on('data', chunk => {
      stdoutChunks.push(chunk);
      const combined = partialLine + chunk;
      const lines = combined.split('\n');
      partialLine = lines.pop();
      for (const line of lines) {
        if (line.trim()) dbg.event('pipeline', { line: line.trim() });
      }
    });

    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    child.on('error', err => {
      clearTimeout(timer);
      resolve(`ERROR launching pipeline: ${err.message}`);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (partialLine.trim()) dbg.event('pipeline', { line: partialLine.trim() });
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      if (code !== 0) {
        resolve(`Pipeline failed (exit ${code}):\n${(stderr || stdout || '').slice(0, 500)}`);
        return;
      }

      const m = stdout.match(/RESULT_GLB:\s*(.+)/);
      if (m) {
        const glbPath = m[1].trim();
        const name = path.basename(glbPath);
        if (!state.staged.includes(name)) state.staged.push(name);
        resolve(`Generated and staged: ${name}. The asset is on disk in the staging folder and is not yet in the Blender scene — use import_asset with {"name": "${name}"} to import it when ready.`);
        return;
      }
      resolve(stdout.trim() || 'Pipeline completed (no GLB path in output)');
    });
  });
}

async function toolGenerateImage(input, state, cfg, opts = {}) {
  const { description, category } = input;
  const hasLiteral = !!(input.prompt && String(input.prompt).trim());
  const gates = (cfg && cfg.gates) || {};

  // ── PROMPT GATE (live): run the metaprompt only, surface it, stop before FLUX ──
  // Fires only when the prompt gate is ON and the caller did NOT pass a literal prompt.
  // A literal prompt (the Approve/Edit path) skips the metaprompter and goes straight to image.
  // This path is ALWAYS synchronous — it's fast and stops before FLUX.
  if (gates.prompt === true && !hasLiteral) {
    if (!description) return 'ERROR: description required';
    const pctx = { stage: 'prompt', desc: description, cat: category || undefined };
    dbg.event('progress', { label: 'generate_prompt', description, category: category || 'auto' });

    const pr = await pipeline.runPromptStage(pctx);
    if (!pr.ok) return `ERROR: ${pr.error}`;

    pctx.stage     = 'prompt';
    pctx.promptPos = pr.artifact;
    pctx.promptNeg = pr.promptNeg;
    pctx.cat       = pr.category || pctx.cat;

    // Remember for the approve / regenerate round-trip
    state.lastImageDesc     = description;
    state.lastImageCategory = pr.category || category || null;
    state.lastTask          = 'generate_prompt: ' + description;

    const adv = await pipeline.advance(pctx, cfg); // gates.prompt===true → stops awaiting 'prompt'
    return describeAdvance(adv);
  }

  // ── Image path (literal prompt, or prompt gate off) ──
  if (!description && !hasLiteral) return 'ERROR: description required';

  const ctx = {
    stage:     'prompt',
    desc:      description,
    cat:       category || undefined,
    promptPos: input.prompt   || undefined,
    promptNeg: input.negative || undefined,
  };

  dbg.event('progress', { label: 'generate_image', description, category: category || 'auto' });

  // ── Pre-gen guard: check for missing models before starting ──────────────────
  try {
    const _wfEntry = workflows.getActive('image', cfg);
    let _wfObj = null;
    try { _wfObj = JSON.parse(fs.readFileSync(workflows.resolveWorkflowFile(_wfEntry), 'utf8')); } catch { /* file unreadable — skip */ }
    if (_wfObj) {
      const _base = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8000';
      const _oiRes = await fetch(_base + '/object_info', { signal: AbortSignal.timeout(8000) });
      if (_oiRes.ok) {
        const _objectInfo = await _oiRes.json();
        const _missing = workflows.missingModelsForWorkflow(_wfObj, _objectInfo);
        if (_missing.length > 0) {
          const _label = _wfEntry.label || _wfEntry.id;
          return `⚠️ Can't generate yet — ComfyUI is missing these models for workflow "${_label}": ${_missing.join(', ')}. Install them in ComfyUI's models folder, or pick another workflow in the Workflows tab.`;
        }
      }
    }
  } catch { /* ComfyUI unreachable or guard error — skip, let normal path run */ }

  // ── Background path (server / web UI) ────────────────────────────────────────
  if (opts.background) {
    const result = jobs.start({ kind: 'image', label: description || 'image' }, async (id) => {
      const r = await pipeline.runImageStage(ctx);
      if (!r.ok) throw new Error(r.error);

      // Map result into ctx and state
      ctx.stage = 'image';
      ctx.image = r.artifact;
      ctx.cat   = r.category || ctx.cat;

      state.lastImage         = r.artifact;
      state.lastImageCategory = r.category || category || null;
      state.lastImageDesc     = description;
      state.lastTask          = 'generate_image: ' + description;

      // Mesh-locked cfg: background job must never auto-import (no Blender IPC during detached run)
      const bgCfg = Object.assign({}, cfg, { gates: Object.assign({}, cfg.gates, { mesh: true }) });
      const adv = await pipeline.advance(ctx, bgCfg);

      // Map any new artifacts produced by auto-advance to state
      if (ctx.glb) {
        if (!state.staged) state.staged = [];
        const glbName = path.basename(ctx.glb);
        if (!state.staged.includes(glbName)) state.staged.push(glbName);
      }

      saveState(state);

      // Phase C: if mesh gate is OFF and we have a staged mesh, do the import under the shared lock
      const meshGateOff = !(cfg.gates && cfg.gates.mesh === true);
      let status;
      if (meshGateOff && ctx.glb) {
        await lock.acquire();
        try {
          const imp = await pipeline.runImportStage(ctx);   // single Blender-socket op, now serialized
          if (!imp.ok) throw new Error(imp.error);
          status = 'Generated image + mesh and imported "' + imp.artifact + '" into the scene.';
        } finally {
          lock.release();
        }
        saveState(state);
      } else {
        status = describeAdvance(adv);
      }
      return status;
    });

    if (!result.started) return result.reason;
    return '🚀 Started background generation (job #' + result.id + ') for "' + description + '". I will keep working — the image (and staged mesh) appear in their tabs when ready; you can send Blender commands meanwhile.';
  }

  // ── Synchronous path (CLI) ────────────────────────────────────────────────────
  const r = await pipeline.runImageStage(ctx);
  if (!r.ok) return `ERROR: ${r.error}`;

  // Map result into ctx and state
  ctx.stage = 'image';
  ctx.image = r.artifact;
  ctx.cat   = r.category || ctx.cat;

  state.lastImage         = r.artifact;
  state.lastImageCategory = r.category || category || null;
  state.lastImageDesc     = description;
  state.lastTask          = 'generate_image: ' + description;

  // Advance — checks gates.image; auto-runs mesh→import if gate is off
  const adv = await pipeline.advance(ctx, cfg);

  // Map any new artifacts produced by auto-advance to state
  if (ctx.glb) {
    if (!state.staged) state.staged = [];
    const glbName = path.basename(ctx.glb);
    if (!state.staged.includes(glbName)) state.staged.push(glbName);
  }

  return describeAdvance(adv);
}

async function toolImageTo3d(input, state, cfg, opts = {}) {
  const image       = input.image || state.lastImage;
  const description = input.description || state.lastImageDesc || 'asset';
  const category    = input.category || state.lastImageCategory;

  if (!image) return 'ERROR: no image to convert. Generate an image first with generate_image.';

  const _tf = parseInt(input.target_face_num, 10);
  const faces = (Number.isFinite(_tf) && _tf > 0) ? _tf : undefined;

  const ctx = {
    stage: 'image',
    image,
    desc:  description,
    cat:   category || undefined,
    faces,
  };

  dbg.event('progress', { label: 'image_to_3d', image, description, category: category || 'auto' });

  // ── Pre-gen guard: check for missing models before starting ──────────────────
  try {
    const _wfEntry = workflows.getActive('mesh', cfg);
    let _wfObj = null;
    try { _wfObj = JSON.parse(fs.readFileSync(workflows.resolveWorkflowFile(_wfEntry), 'utf8')); } catch { /* file unreadable — skip */ }
    if (_wfObj) {
      const _base = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8000';
      const _oiRes = await fetch(_base + '/object_info', { signal: AbortSignal.timeout(8000) });
      if (_oiRes.ok) {
        const _objectInfo = await _oiRes.json();
        const _missing = workflows.missingModelsForWorkflow(_wfObj, _objectInfo);
        if (_missing.length > 0) {
          const _label = _wfEntry.label || _wfEntry.id;
          return `⚠️ Can't generate yet — ComfyUI is missing these models for workflow "${_label}": ${_missing.join(', ')}. Install them in ComfyUI's models folder, or pick another workflow in the Workflows tab.`;
        }
      }
    }
  } catch { /* ComfyUI unreachable or guard error — skip, let normal path run */ }

  // ── Background path (server / web UI) ────────────────────────────────────────
  if (opts.background) {
    const result = jobs.start({ kind: 'mesh', label: description || 'mesh' }, async (id) => {
      const r = await pipeline.runMeshStage(ctx);
      if (!r.ok) throw new Error(r.error);

      ctx.stage = 'mesh';
      ctx.glb   = r.artifact;

      if (!state.staged) state.staged = [];
      const glbName = path.basename(ctx.glb);
      if (!state.staged.includes(glbName)) state.staged.push(glbName);

      // Mesh-locked cfg: stops pipeline before import (import is done below under the shared lock)
      const bgCfg = Object.assign({}, cfg, { gates: Object.assign({}, cfg.gates, { mesh: true }) });
      const adv = await pipeline.advance(ctx, bgCfg);

      saveState(state);

      // Phase C: if mesh gate is OFF, do the import under the shared lock
      const meshGateOff = !(cfg.gates && cfg.gates.mesh === true);
      let status;
      if (meshGateOff && ctx.glb) {
        await lock.acquire();
        try {
          const imp = await pipeline.runImportStage(ctx);   // single Blender-socket op, now serialized
          if (!imp.ok) throw new Error(imp.error);
          status = 'Generated image + mesh and imported "' + imp.artifact + '" into the scene.';
        } finally {
          lock.release();
        }
        saveState(state);
      } else {
        status = describeAdvance(adv);
      }
      return status;
    });

    if (!result.started) return result.reason;
    return '🚀 Started background generation (job #' + result.id + ') for "' + description + '". I will keep working — the image (and staged mesh) appear in their tabs when ready; you can send Blender commands meanwhile.';
  }

  // ── Synchronous path (CLI) ────────────────────────────────────────────────────
  const r = await pipeline.runMeshStage(ctx);
  if (!r.ok) return `ERROR: ${r.error}`;

  ctx.stage = 'mesh';
  ctx.glb   = r.artifact;

  if (!state.staged) state.staged = [];
  const glbName = path.basename(ctx.glb);
  if (!state.staged.includes(glbName)) state.staged.push(glbName);

  // Advance — checks gates.mesh; auto-runs import if gate is off
  const adv = await pipeline.advance(ctx, cfg);

  return describeAdvance(adv);
}

const BRUSHES_REGISTRY = path.join(__dirname, 'brushes', 'registry.json');

// registry.json trug frueher den absoluten Pfad der Maschine, auf der der Brush
// gespeichert wurde — auf dem Rig zeigten die Eintraege auf D:\phoenix\... Seit
// 2026-07-09 schreibt save_brush.js relativ zu brushes/lib; Alt-Eintraege werden
// hier noch aufgeloest, damit bestehende Registries weiterlaufen.
function resolveBrushLib(lib) {
  if (!lib) return null;
  const libDir = path.join(__dirname, 'brushes', 'lib');
  const m = String(lib).replace(/\\/g, '/').match(/(?:^|\/)brushes\/lib\/(.+)$/);
  return path.join(libDir, m ? m[1] : String(lib).replace(/\\/g, '/'));
}

async function toolListBrushes(input, _state, _cfg) {
  if (!fs.existsSync(BRUSHES_REGISTRY)) return 'No brush registry found. Save a brush first.';
  const registry = JSON.parse(fs.readFileSync(BRUSHES_REGISTRY, 'utf8'));
  const brushes  = registry.brushes || {};
  if (!Object.keys(brushes).length) return 'No brushes registered yet.';

  const { category, search } = input || {};
  const term = search ? search.toLowerCase() : null;

  const sciFi = [], phoenix = [];
  for (const [slug, b] of Object.entries(brushes)) {
    if (category) {
      if (b.type === 'sci_fi'   && category !== 'sci_fi')    continue;
      if (b.type === 'phoenix'  && b.category !== category)  continue;
    }
    if (term && !slug.includes(term) && !(b.display || '').toLowerCase().includes(term)) continue;

    if (b.type === 'phoenix') phoenix.push(`  ${slug} — ${b.display} [${b.category || 'item'}]`);
    else                      sciFi.push(`  ${slug} — ${b.display}`);
  }

  const parts = [];
  if (sciFi.length)   parts.push(`SCI-FI BRUSHES (${sciFi.length}):\n${sciFi.join('\n')}`);
  if (phoenix.length) parts.push(`PHOENIX BRUSHES (${phoenix.length}):\n${phoenix.join('\n')}`);
  if (!parts.length)  return 'No brushes match that filter.';
  return parts.join('\n\n');
}

async function toolSaveAsBrush(input, _state, _cfg) {
  const { name, object, collection, category, display } = input;
  if (!name) return 'ERROR: name required';

  const argv = ['--name', name];
  if (collection) argv.push('--collection', collection);
  if (object)   argv.push('--object',   object);
  if (category) argv.push('--category', category);
  if (display)  argv.push('--display',  display);

  const r = spawnSync('node', [path.join(__dirname, 'save_brush.js'), ...argv], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000,
  });

  if (r.error)      return `ERROR: ${r.error.message}`;
  if (r.status !== 0) return `ERROR (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`;
  return (r.stdout || '').trim() || 'Brush saved.';
}

async function toolUseBrush(input, _state, _cfg) {
  const { name, x, y, z, instance_name } = input;
  if (!name) return 'ERROR: name required';

  const argv = ['--name', name];
  if (x !== undefined && x !== null) argv.push('--x', String(x));
  if (y !== undefined && y !== null) argv.push('--y', String(y));
  if (z !== undefined && z !== null) argv.push('--z', String(z));
  if (instance_name)                 argv.push('--instance-name', instance_name);

  const r = spawnSync('node', [path.join(__dirname, 'use_brush.js'), ...argv], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000,
  });

  if (r.error)        return `ERROR: ${r.error.message}`;
  if (r.status !== 0) return `ERROR (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`;
  return (r.stdout || '').trim() || 'Brush placed.';
}

async function toolApplyMaterial(input) {
  const name = input && input.name;
  if (!name) return 'ERROR: name required';
  const pyFwd = path.join(__dirname, 'brushes', 'phoenix_brushes.py').replace(/\\/g, '/');
  const code = [
    'import bpy',
    "exec(open(r'" + pyFwd + "').read())",
    '_n = ' + JSON.stringify(name),
    '_m = bpy.data.materials.get(_n)',
    "if _m is None and _n in _PHOENIX_PALETTE: _m = _PHOENIX_PALETTE[_n](_n)",
    "_sel = [o for o in bpy.context.selected_objects if o.type == 'MESH']",
    "if _m is None:\n    print('ERROR: material not found: ' + _n)",
    "elif not _sel:\n    print('ERROR: select a mesh object in Blender first')",
    "else:\n    for _o in _sel:\n        if _o.data.materials:\n            _o.data.materials[0] = _m\n        else:\n            _o.data.materials.append(_m)\n    print('APPLIED:' + _n + ' to ' + str(len(_sel)) + ' object(s)')",
  ].join('\n');
  try {
    const r = await callBlender(code);
    const o = (r.stdout || r.output || '').trim();
    if (r.status === 'error') return 'ERROR: ' + (r.message || o);
    if (/error/i.test(o)) return o.replace(/^ERROR:\s*/i, 'ERROR: ');
    return o || 'Material applied.';
  } catch (e) { return 'ERROR: ' + e.message; }
}

async function toolRenameAsset(input) {
  const { category, name } = input || {};
  const label = (input && typeof input.label === 'string') ? input.label.trim() : '';
  if (!category || !name) return 'ERROR: category and name required';
  const labels = loadLibraryLabels();
  if (!labels.assets) labels.assets = {};
  const key = category + '/' + name;
  if (label) labels.assets[key] = label; else delete labels.assets[key];
  saveLibraryLabels(labels);
  return label ? ('Renamed to "' + label + '"') : 'Label cleared';
}

async function toolRenameBrush(input) {
  const { slug, display } = input || {};
  if (!slug || !display) return 'ERROR: slug and display required';
  const REG = path.join(__dirname, 'brushes', 'registry.json');
  try {
    const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
    if (!reg.brushes || !reg.brushes[slug]) return 'ERROR: brush not found: ' + slug;
    reg.brushes[slug].display = String(display).trim();
    fs.writeFileSync(REG, JSON.stringify(reg, null, 2));
    return 'Renamed brush to "' + reg.brushes[slug].display + '"';
  } catch (e) { return 'ERROR: ' + e.message; }
}

async function toolDeleteAsset(input) {
  const { category, name } = input || {};
  const CATS = ['flat','furniture','item','architecture','flora','fauna'];
  if (!category || !name || !CATS.includes(category)) return 'ERROR: valid category and name required';
  const safe = path.basename(name);
  if (safe !== name || !safe.endsWith('.glb')) return 'ERROR: invalid asset name';
  const abs = path.join(STAGING_BASE, category, safe);
  try {
    if (!fs.existsSync(abs)) return 'ERROR: file not found';
    fs.unlinkSync(abs);
    const labels = loadLibraryLabels();
    if (labels.assets) { delete labels.assets[category + '/' + safe]; saveLibraryLabels(labels); }
    return 'Deleted ' + category + '/' + safe;
  } catch (e) { return 'ERROR: ' + e.message; }
}

async function toolDeleteBrush(input) {
  const slug = input && input.slug;
  if (!slug) return 'ERROR: slug required';
  const REG = path.join(__dirname, 'brushes', 'registry.json');
  const PY  = path.join(__dirname, 'brushes', 'phoenix_brushes.py');
  try {
    const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
    const b = reg.brushes && reg.brushes[slug];
    if (!b) return 'ERROR: brush not found: ' + slug;
    if (b.type === 'phoenix') {
      const libFile = resolveBrushLib(b.lib);
      if (libFile) { try { if (fs.existsSync(libFile)) fs.unlinkSync(libFile); } catch (_) {} }
      try {
        let src = fs.readFileSync(PY, 'utf8');
        const marker = '\ndef add_' + slug + '(';
        const start = src.indexOf(marker);
        if (start >= 0) {
          const nextDef = src.indexOf('\ndef ', start + 1);
          src = src.slice(0, start) + (nextDef >= 0 ? src.slice(nextDef) : '');
          fs.writeFileSync(PY, src, 'utf8');
        }
      } catch (_) {}
    }
    delete reg.brushes[slug];
    fs.writeFileSync(REG, JSON.stringify(reg, null, 2));
    return 'Deleted brush ' + slug;
  } catch (e) { return 'ERROR: ' + e.message; }
}

async function toolListPalette() {
  const r = spawnSync('node', [path.join(__dirname, 'manage_palette.js'), '--list'], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15000,
  });
  if (r.error)        return `ERROR: ${r.error.message}`;
  if (r.status !== 0) return `ERROR (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`;
  return (r.stdout || '').trim() || '(palette empty)';
}

async function toolDeleteMaterial(input) {
  const name = input && input.name;
  if (!name) return 'ERROR: name required';
  const r = spawnSync('node', [path.join(__dirname, 'manage_palette.js'), '--delete', name], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15000,
  });
  if (r.error)        return `ERROR: ${r.error.message}`;
  if (r.status !== 0) return `ERROR (exit ${r.status}): ${(r.stderr || r.stdout || '').trim()}`;
  return (r.stdout || '').trim() || `deleted ${name}`;
}

const TOOLS = {
  generate_image: toolGenerateImage,
  image_to_3d:    toolImageTo3d,
  generate_prop:  toolGenerateProp,
  blender_run:    toolBlenderRun,
  list_assets:    toolListAssets,
  read_palette:   toolReadPalette,
  import_asset:   toolImportAsset,
  read_state:     toolReadState,
  list_brushes:   toolListBrushes,
  save_as_brush:  toolSaveAsBrush,
  use_brush:      toolUseBrush,
  apply_material: toolApplyMaterial,
  rename_asset:   toolRenameAsset,
  rename_brush:   toolRenameBrush,
  delete_asset:   toolDeleteAsset,
  delete_brush:   toolDeleteBrush,
  list_materials: toolListPalette,
  delete_material: toolDeleteMaterial,
};

// ─── Claude CLI call ──────────────────────────────────────────────────────────

function callClaude(messages, cfg, extraSystem) {
  const contextLines = [];
  for (const m of messages.slice(0, -1)) {
    const tag = m.role === 'user' ? 'Human' : 'Assistant';
    contextLines.push(`${tag}: ${m.content}`);
  }
  const lastUser = messages[messages.length - 1].content;

  const contextBlock = contextLines.length
    ? `<conversation_history>\n${contextLines.join('\n\n')}\n</conversation_history>\n\n`
    : '';

  const userMsg = contextBlock + lastUser;
  const model = (cfg.seats && cfg.seats.orchestrator && cfg.seats.orchestrator.model) || 'claude-sonnet-4-6';
  const systemPrompt = extraSystem ? (SYSTEM_PROMPT + '\n\n' + extraSystem) : SYSTEM_PROMPT;

  const _t = Date.now();
  // Prompt text (system + userMsg) must never be a command-line arg — see claude-cli.js.
  return claudeCli.runStream(model, systemPrompt, userMsg, { extraFlags: ['--tools', '', '--strict-mcp-config'] })
    .then(result => {
      dbg.llm('orchestrator', { msgCount: messages.length, ms: Date.now() - _t, respChars: result.length });
      return result;
    });
}

// ─── Tool dispatch parser ─────────────────────────────────────────────────────

// Extract the balanced { ... } object starting at index `start` in `s`, respecting
// JSON string quoting so that braces INSIDE string values (very common in bpy code)
// do not prematurely end the object. Returns the substring incl. outer braces, or null.
function extractBalancedObject(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
  }
  return null;
}

// Escape raw control chars (newline / CR / tab) that appear INSIDE JSON string
// literals, so JSON.parse accepts payloads where the model emitted literal newlines
// instead of \n (common for multi-line code strings). No-op for well-formed JSON.
function sanitizeJsonControlChars(jsonStr) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inStr) {
      if (esc)            { out += ch; esc = false; continue; }
      if (ch === '\\')    { out += ch; esc = true;  continue; }
      if (ch === '"')     { out += ch; inStr = false; continue; }
      if (ch === '\n')    { out += '\\n'; continue; }
      if (ch === '\r')    { out += '\\r'; continue; }
      if (ch === '\t')    { out += '\\t'; continue; }
      out += ch;
    } else {
      out += ch;
      if (ch === '"') inStr = true;
    }
  }
  return out;
}

function parseToolCall(text) {
  // Strip markdown code fences Claude sometimes adds
  const clean = text.replace(/^```[\w]*\r?\n?/gm, '').replace(/^```\r?$/gm, '');
  // Locate the TOOL name + the opening brace of the INPUT object ([\r\n]+ for CRLF)
  const m = clean.match(/TOOL:\s*(\w+)\s*[\r\n]+INPUT:\s*(\{)/);
  if (!m) return null;
  const name = m[1].trim();
  const braceIdx = m.index + m[0].length - 1; // position of the opening '{'
  const objStr = extractBalancedObject(clean, braceIdx);
  if (!objStr) return { name, input: {} };
  try {
    return { name, input: JSON.parse(objStr) };
  } catch {
    // Salvage: the model may have used literal newlines inside the code string
    try {
      return { name, input: JSON.parse(sanitizeJsonControlChars(objStr)) };
    } catch {
      return { name, input: {} };
    }
  }
}

function stripToolBlock(text) {
  let out = text.replace(/```[\w]*\r?\n?/g, '').replace(/```/g, '');
  // Remove each balanced TOOL…INPUT{ … } block (quote/brace-aware, not a fragile regex).
  while (true) {
    const m = out.match(/TOOL:\s*\w+\s*[\r\n]+INPUT:\s*(\{)/);
    if (!m) break;
    const braceIdx = m.index + m[0].length - 1;
    const objStr = extractBalancedObject(out, braceIdx);
    if (!objStr) { out = out.slice(0, m.index); break; }
    out = out.slice(0, m.index) + out.slice(braceIdx + objStr.length);
  }
  return out.trim();
}

// ─── Agentic turn ─────────────────────────────────────────────────────────────

async function runTurn(userInput, history, state, cfg, opts = {}) {
  const blenderOnly = !!opts.blenderOnly;
  const allowedTools = blenderOnly ? BLENDER_ONLY_TOOLS : null;
  const extraSystem  = blenderOnly ? BLENDER_ONLY_SYSTEM : '';
  const historyMessages = (cfg.seats && cfg.seats.orchestrator && cfg.seats.orchestrator.historyMessages) || 3;
  const window = history.slice(-historyMessages * 2);
  window.push({ role: 'user', content: userInput });

  let toolCalls = 0;
  let messages = [...window];

  while (true) {
    const raw = await callClaude(messages, cfg, extraSystem);
    const toolCall = parseToolCall(raw);

    if (!toolCall || toolCalls >= MAX_TOOL_CALLS) {
      if (toolCalls >= MAX_TOOL_CALLS && toolCall) {
        // Claude is still in tool-call mode at the limit — force a text response
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'TOOL_LIMIT_REACHED: Reply to the user in plain text now. No more TOOL blocks.' });
        const finalRaw = await callClaude(messages, cfg, extraSystem);
        const text = stripToolBlock(finalRaw).trim();
        return { text: text || '(reached tool limit — no summary)', messages };
      }
      const text = stripToolBlock(raw).trim();
      messages.push({ role: 'assistant', content: raw });
      return { text: text || '(no response)', messages };
    }

    // Execute tool
    toolCalls++;
    dbg.event('progress', { label: 'tool', name: toolCall.name, phase: 'start' });
    dbg.tool(toolCall.name, 'call', toolCall.input);
    let toolResult;
    const fn = TOOLS[toolCall.name];
    if (allowedTools && !allowedTools.includes(toolCall.name)) {
      toolResult = `ERROR: tool "${toolCall.name}" is disabled in Blender-only mode. Model the asset directly with blender_run (bpy) instead — do not use generation tools.`;
    } else if (!fn) {
      toolResult = `ERROR: unknown tool "${toolCall.name}"`;
    } else {
      try {
        toolResult = await fn(toolCall.input, state, cfg, opts);
      } catch (e) {
        toolResult = `ERROR: ${e.message}`;
      }
    }
    dbg.tool(toolCall.name, 'result', toolResult);
    if (typeof toolResult === 'string' && (toolResult.startsWith('PYTHON_ERROR') || toolResult.startsWith('ERROR'))) dbg.pyerr(toolResult);
    dbg.event('progress', { label: 'tool', name: toolCall.name, phase: 'done' });

    // Feed result back into messages
    // The hint after the result nudges Claude to reply in text if the answer is complete,
    // while still allowing it to chain tools when a follow-up action is genuinely needed.
    const assistantMsg = { role: 'assistant', content: raw };
    const resultMsg    = {
      role: 'user',
      content: `TOOL_RESULT [${toolCall.name}]:\n${toolResult}\n\nIf this answers the user's question, reply in plain text now. Only emit another TOOL block if a follow-up action is strictly required.`,
    };
    messages.push(assistantMsg, resultMsg);
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  ensureSessionDir();
  const freshStart = process.argv.includes('--fresh');
  let history = freshStart ? [] : loadHistory();
  let state   = loadState();
  let cfg     = loadConfig();

  const orchModel = (cfg.seats && cfg.seats.orchestrator && cfg.seats.orchestrator.model) || 'claude-sonnet-4-6';
  const metaModel = (cfg.seats && cfg.seats.metaprompter && cfg.seats.metaprompter.model) || 'google/gemma-4-e4b';
  console.log('\n  PHOENIX ASSISTANT');
  console.log(`  orchestrator: ${orchModel}  ·  metaprompter: ${metaModel}`);
  if (freshStart) console.log('  --fresh: starting with empty history (prior session not loaded)');
  console.log('  /set key value  ·  /config  ·  reset  ·  refresh  ·  exit\n');

  dbg.initDebug({ enabled: process.argv.includes('--debug') });

  if (!process.argv.includes('--skip-preflight')) {
    try {
      await runPreflight();
    } catch (e) {
      console.log(`  (preflight skipped — internal error: ${e.message})`);
    }
  }

  dbg.subscribe(rec => {
    if (rec.cat === 'progress' && rec.label === 'tool') {
      if (rec.phase === 'start') process.stdout.write(`\n  [tool: ${rec.name}] `);
      else if (rec.phase === 'done') process.stdout.write(`done\n`);
    } else if (rec.cat === 'progress' && rec.label === 'generate_prop') {
      process.stdout.write(`  [generate_prop] starting pipeline for: "${rec.description}" (${rec.category})\n`);
    } else if (rec.cat === 'pipeline') {
      process.stdout.write(`  ${rec.line}\n`);
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question('you> ', async raw => {
      const input = raw.trim();
      if (!input)                              { ask(); return; }
      if (input === 'exit' || input === 'quit') { saveHistory(history); saveState(state); rl.close(); return; }

      if (input === '/config') {
        console.log('\n' + JSON.stringify(cfg, null, 2) + '\n');
        ask();
        return;
      }

      if (input.startsWith('/set ')) {
        const parts = input.slice(5).trim().split(/\s+/);
        if (parts.length < 2) {
          console.log('  Usage: /set key.path value\n');
          ask();
          return;
        }
        const dotKey = parts[0];
        const value  = autoType(parts.slice(1).join(' '));
        setConfigValue(cfg, dotKey, value);
        saveConfig(cfg);
        console.log(`  set ${dotKey} = ${JSON.stringify(value)}\n`);
        ask();
        return;
      }

      if (input === 'reset') {
        history = [];
        saveHistory(history);
        console.log('  History cleared.\n');
        ask();
        return;
      }
      if (input === 'refresh') {
        try {
          const result = await callBlender(
            'import bpy\nnames=[o.name for o in bpy.context.scene.objects]\nprint("OBJECTS:"+str(names))'
          );
          const raw = result.stdout || result.output || '';
          const m = raw.match(/OBJECTS:\[([^\]]*)\]/);
          const objects = m ? m[1].replace(/'/g, '').split(', ').filter(Boolean) : [];
          saveSceneCache({ sceneObjects: objects, sceneUpdatedAt: new Date().toISOString() });
          console.log(`  Scene refreshed — ${objects.length} object(s): ${objects.join(', ') || '(empty)'}\n`);
        } catch (e) {
          console.log(`  Refresh failed: ${e.message}\n`);
        }
        ask();
        return;
      }

      if (input === '/debug on') {
        dbg.setDebug(true);
        process.stdout.write('  debug echo ON\n');
        ask(); return;
      }
      if (input === '/debug off') {
        dbg.setDebug(false);
        process.stdout.write('  debug echo OFF\n');
        ask(); return;
      }
      if (input === '/debug') {
        process.stdout.write(`  debug echo is ${dbg.isDebug() ? 'ON' : 'OFF'}\n`);
        ask(); return;
      }

      try {
        const { text, messages } = await runTurn(input, history, state, cfg);

        // Update history with the full exchange
        history.push({ role: 'user', content: input });
        const lastAssistant = messages.findLast(m => m.role === 'assistant');
        if (lastAssistant) history.push({ role: 'assistant', content: lastAssistant.content });
        saveHistory(history);
        saveState(state);

        console.log(`\nphoenix> ${text}\n`);
      } catch (e) {
        console.error(`\n  Error: ${e.message}\n`);
      }

      ask();
    });
  };

  ask();
}

if (require.main === module) main();

// ─── Troubleshooter — Step A (read-only diagnosis; does NOT touch TOOLS or runTurn) ──

const TROUBLESHOOTER_SYSTEM = `You are the Phoenix Troubleshooter, a diagnostic assistant for the Phoenix agent system.
You help the user find out why components are not connected or not working.

Reply in ENGLISH. Be concise — this runs on a metered model, so do not pad.

TASK (Step A — diagnosis only, no actions):
- Gather FACTS with your tools before making any guess.
- Explain clearly what is broken and the most likely cause.
- Tell the user exactly what to do (which app to start, what to click or run).
- You CANNOT perform any fix yourself in this step — only diagnose and advise.
- If a fix involves server settings, point the user to the Settings panel.

TOOL-CALL FORMAT — exactly these two lines, no preamble, no code fence around them:
TOOL: tool_name
INPUT: {"key": "value"}

AVAILABLE TOOLS (only these six are allowed):
- run_preflight         Runs the full preflight health check and returns the status. INPUT: {}
- tail_debug_log        Reads the last ~40 lines of the current debug log. INPUT: {}
- probe_blender_socket  Tests whether Blender is reachable via the Phoenix file-based IPC (Blender open + IPC addon enabled). INPUT: {}
- check_workflow_deps   Checks whether the ACTIVE image + mesh workflows' required custom nodes and models are installed in ComfyUI. INPUT: {}
- list_lmstudio_models  Lists the models currently loaded by LM Studio (the local model server). Use when the user can't find or select a local model (e.g. a metaprompter seat model like Gemma 12B). INPUT: {}
- read_troubleshooting  The known-trap library. Best: INPUT {"symptom":"<the exact error string>"} — it matches the index server-side and returns the matching fix in ONE call. Also: INPUT {} for the whole symptom→entry INDEX, or {"entry":"<slug>"} for a specific trap. Each fix has symptoms, root cause, "do it for me" steps, "explain it" steps, and verify.

KNOWN-TRAP LIBRARY — use it before guessing on any setup/install/ComfyUI/Trellis/torch/workflow/metaprompter issue:
- Call read_troubleshooting {"symptom":"<paste the user's exact error/behaviour>"} — one call returns the matched fix (or the index if no match).
- Present the fix and ASK the user which they prefer: "do it for me" (walk them step by step) or "explain it" (what & why, they run it). Default to explain-first for anything irreversible or a big (GB) download.
- If the fix needs a server.bat restart + browser refresh, say so plainly and state exactly what to verify afterward (that restart ends this chat).
- If nothing matches, fall back to your normal diagnosis.

RULES:
1. The latest preflight status is ALREADY provided below — base your diagnosis on it directly. Do NOT call a tool just to confirm what preflight already shows.
2. Only call a tool when you need detail preflight does not give you (e.g. tail_debug_log for a recent error, probe_blender_socket for a live socket check). You may call at most ONE tool, then you must answer.
3. After TOOL_RESULT: give a clear, short diagnosis. Do not call another tool if the answer is already complete.
4. Emit the TOOL block directly — no preamble like "I will now..." before it.
5. Format TOOL blocks exactly as shown: TOOL: on one line, INPUT: on the next.`;

const SUSPECTED_ISSUES_FILE = path.join(__dirname, 'SUSPECTED-ISSUES.md');

function buildTroubleshooterPrompt(cfg, preflightOutput) {
  let suspectedIssues = '';
  try { suspectedIssues = fs.readFileSync(SUSPECTED_ISSUES_FILE, 'utf8'); } catch (_) {}

  const localEndpoint   = (cfg.endpoints && cfg.endpoints.local)   || 'http://localhost:1234/v1';
  const comfyuiEndpoint = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8000';
  const blenderExe      = (cfg.apps      && cfg.apps.blender)      || 'blender';

  const connectFacts = [
    '## Connect Facts (live from config)',
    '- Blender IPC: file-based via the Phoenix IPC addon (probe_blender_socket tests this)',
    '- Local LM Studio endpoint: ' + localEndpoint,
    '- ComfyUI endpoint: ' + comfyuiEndpoint,
    '- Blender executable: ' + blenderExe,
    '- Rule: any edit to server.js or engine files requires the user to restart server.bat',
  ].join('\n');

  const preflightBlock = preflightOutput
    ? '## Latest Preflight Output (collected when this chat opened)\n```\n' + preflightOutput.trim() + '\n```'
    : '## Latest Preflight Output\n(not available — use run_preflight tool to fetch it)';

  return TROUBLESHOOTER_SYSTEM + '\n\n' + suspectedIssues + '\n\n' + connectFacts + '\n\n' + preflightBlock;
}

// ── Read-only troubleshooter tool functions ───────────────────────────────────

async function tsRunPreflight() {
  return new Promise(resolve => {
    const out = [];
    let done = false;
    const finish = (extra) => { if (done) return; done = true; resolve(out.join('') + (extra || '')); };
    const child = spawn('node', [path.join(__dirname, 'preflight.js')], { encoding: 'utf8' });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish('\n[FAIL] preflight timed out'); }, 20000);
    child.stdout.on('data', d => out.push(d.toString()));
    child.stderr.on('data', d => out.push(d.toString()));
    child.on('error', e => { clearTimeout(timer); finish('\n[FAIL] could not launch preflight: ' + e.message); });
    child.on('close', () => { clearTimeout(timer); finish(); });
  });
}

function tsTailDebugLog() {
  try {
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) return '(logs directory does not exist yet)';
    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('debug-') && f.endsWith('.jsonl'))
      .map(f => ({ f, mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return '(no debug log files found in logs/)';
    const newest = path.join(logsDir, files[0].f);
    const content = fs.readFileSync(newest, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const tail = lines.slice(-40).join('\n');
    return '[file: ' + files[0].f + ']\n' + (tail || '(empty)');
  } catch (e) { return 'ERROR: ' + e.message; }
}

function tsProbeBlenderSocket() {
  // File-based liveness probe (was a 9876 socket connect). Sends a no-op to the addon.
  // No cfg in scope here; probes the default IPC dir (matches the zero-config setup).
  return blenderIpc.probeBlender(null, 3000);
}

async function tsCheckWorkflowDeps() {
  const cfg  = loadConfig();
  const base = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8000';

  let info;
  try {
    const res = await fetch(base + '/object_info', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return 'Could not reach ComfyUI /object_info at ' + base + ' — cannot check workflow deps (HTTP ' + res.status + '). Is ComfyUI running?';
    }
    info = await res.json();
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    return 'Could not reach ComfyUI /object_info at ' + base + ' — cannot check workflow deps (' + errMsg + '). Is ComfyUI running?';
  }

  const lines = ['Active workflow dependency check (ComfyUI at ' + base + '):'];

  for (const stage of ['image', 'mesh']) {
    const e = wf.getActive(stage, cfg);
    const r = wf.checkDeps(e, info);

    // Custom nodes — class name must appear as a top-level key in /object_info
    const nodesStr  = e.deps && e.deps.custom_nodes && e.deps.custom_nodes.length
      ? (r.missing_nodes.length  ? 'MISSING: ' + r.missing_nodes.join(', ')  : 'all present')
      : 'none declared';

    // Models — present if in enum set OR appears as substring in the full JSON
    const modelsStr = e.deps && e.deps.models && e.deps.models.length
      ? (r.missing_models.length ? 'MISSING: ' + r.missing_models.join(', ') : 'all present')
      : 'none declared';

    lines.push('');
    lines.push(stage.toUpperCase() + ' — ' + e.label + ' (id: ' + e.id + ')');
    lines.push('  custom nodes: ' + nodesStr);
    lines.push('  models:       ' + modelsStr);
  }

  return lines.join('\n');
}

async function listLmStudioModels(cfg) {
  const localBase = (cfg && cfg.endpoints && cfg.endpoints.local) || 'http://localhost:1234/v1';
  try {
    const r = await fetch(localBase + '/models', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      const models = Array.isArray(j.data) ? j.data.map(m => m && m.id).filter(x => typeof x === 'string') : [];
      return { reachable: true, base: localBase, models };
    }
    return { reachable: false, base: localBase, models: [], error: 'HTTP ' + r.status };
  } catch (e) {
    return { reachable: false, base: localBase, models: [], error: (e && e.message) || String(e) };
  }
}

async function tsListLmStudioModels() {
  const cfg = loadConfig();
  const r = await listLmStudioModels(cfg);
  if (!r.reachable) {
    return 'Could not reach LM Studio at ' + r.base + ' (' + (r.error || 'unreachable') + '). Make sure LM Studio is running and its local server is started.';
  }
  if (r.models.length === 0) {
    return 'LM Studio is reachable at ' + r.base + ' but no models are currently loaded. Load the model you want (e.g. Gemma 12B) in LM Studio, then it will appear here and in Settings.';
  }
  return 'LM Studio models currently loaded at ' + r.base + ':\n' + r.models.map(m => '- ' + m).join('\n');
}

const TROUBLESHOOTING_DIR = path.join(__dirname, 'troubleshooting');

// Retrieval over the known-trap library. Read-only; path-safe (bare slugs only).
//   {}                    → the symptom→entry INDEX
//   { symptom: "<text>" } → server-side match against the index; returns the matched entry (ONE call)
//   { entry: "<slug>" }   → that entry directly
function tsReadIndex()      { return fs.readFileSync(path.join(TROUBLESHOOTING_DIR, 'INDEX.md'), 'utf8'); }
function tsReadEntry(slug)  {
  if (/[\\/]|\.\./.test(slug)) return null;
  const f = path.join(TROUBLESHOOTING_DIR, 'entries', slug + '.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
async function tsReadTroubleshooting(input) {
  input = input || {};
  const entry   = typeof input.entry   === 'string' ? input.entry.trim().replace(/\.md$/i, '') : '';
  const symptom = typeof input.symptom === 'string' ? input.symptom.trim() : '';
  try {
    if (entry) {
      const c = tsReadEntry(entry);
      return c || ('No entry "' + entry + '". Index:\n\n' + tsReadIndex());
    }
    if (symptom) {
      const idx = tsReadIndex();
      for (const line of idx.split(/\r?\n/)) {
        if (line.includes('|') && line.toLowerCase().includes(symptom.toLowerCase())) {
          const m = line.match(/`entries\/([a-z0-9-]+)\.md`/);
          if (m) { const c = tsReadEntry(m[1]); if (c) return 'Matched trap: ' + m[1] + '\n\n' + c; }
        }
      }
      return 'No exact match for "' + symptom + '". Full index below — pick the closest and re-read with {"entry":"<slug>"}:\n\n' + idx;
    }
    return tsReadIndex();
  } catch (e) {
    return 'Troubleshooting library unavailable: ' + e.message;
  }
}

const TROUBLESHOOTER_TOOLS = {
  run_preflight:        tsRunPreflight,
  tail_debug_log:       tsTailDebugLog,
  probe_blender_socket: tsProbeBlenderSocket,
  check_workflow_deps:  tsCheckWorkflowDeps,
  list_lmstudio_models: tsListLmStudioModels,
  read_troubleshooting: tsReadTroubleshooting,
};

// ── Seat-aware Claude caller (parallel to callClaude; does NOT change the orchestrator) ──
// Takes explicit { model, systemPrompt } instead of reading from cfg.seats.orchestrator
// and SYSTEM_PROMPT. The orchestrator's callClaude is completely untouched.

function callClaudeSeat(messages, { model, systemPrompt }) {
  const contextLines = [];
  for (const m of messages.slice(0, -1)) {
    const tag = m.role === 'user' ? 'Human' : 'Assistant';
    contextLines.push(tag + ': ' + m.content);
  }
  const lastUser = messages[messages.length - 1].content;
  const contextBlock = contextLines.length
    ? '<conversation_history>\n' + contextLines.join('\n\n') + '\n</conversation_history>\n\n'
    : '';
  const userMsg = contextBlock + lastUser;
  const _t = Date.now();
  // Prompt text (system + userMsg) must never be a command-line arg — see claude-cli.js.
  return claudeCli.runStream(model, systemPrompt, userMsg, { extraFlags: ['--tools', '', '--strict-mcp-config'] })
    .then(result => {
      dbg.llm('troubleshooter', { msgCount: messages.length, ms: Date.now() - _t, respChars: result.length });
      return result;
    });
}

// ── Troubleshooter turn loop — mirrors runTurn but uses TROUBLESHOOTER_TOOLS only ──
// Takes a full messages array [{role, content}] (client maintains and passes it in).
// Returns { text, messages } where messages is the updated full context for the next turn.

async function runTroubleshootTurn(messages, cfg, preflightOutput) {
  const seatCfg = (cfg.seats && cfg.seats.troubleshooter) || {};
  const model   = seatCfg.model || 'claude-sonnet-4-6';
  const historyMessages = seatCfg.historyMessages || 8;

  // Apply a history window: keep the last N pairs + current user msg at the tail
  const maxMsgs = historyMessages * 2 + 1;
  const limited = messages.length > maxMsgs ? messages.slice(-maxMsgs) : messages;

  // Preflight is already injected into the system prompt, so the model rarely needs a tool.
  // Cap at 1 (not the global 3) to avoid extra full-prompt re-spawns. See changelog 2026-06-27.
  const maxTsToolCalls = 1;

  const systemPrompt = buildTroubleshooterPrompt(cfg, preflightOutput);
  let toolCalls = 0;
  let msgs = [...limited];

  while (true) {
    const raw = await callClaudeSeat(msgs, { model, systemPrompt });
    const toolCall = parseToolCall(raw);

    if (!toolCall || toolCalls >= maxTsToolCalls) {
      if (toolCalls >= maxTsToolCalls && toolCall) {
        // Still emitting tool calls at limit — force plain-text reply
        msgs.push({ role: 'assistant', content: raw });
        msgs.push({ role: 'user', content: 'TOOL_LIMIT_REACHED: Reply to the user now in plain English text. No more TOOL blocks.' });
        const finalRaw = await callClaudeSeat(msgs, { model, systemPrompt });
        const text = stripToolBlock(finalRaw).trim();
        return { text: text || '(tool limit reached — no summary)', messages: msgs };
      }
      const text = stripToolBlock(raw).trim();
      msgs.push({ role: 'assistant', content: raw });
      return { text: text || '(no response)', messages: msgs };
    }

    // Execute tool — only TROUBLESHOOTER_TOOLS are allowed
    toolCalls++;
    dbg.event('progress', { label: 'ts-tool', name: toolCall.name, phase: 'start' });
    let toolResult;
    const fn = TROUBLESHOOTER_TOOLS[toolCall.name];
    if (!fn) {
      toolResult = 'ERROR: tool "' + toolCall.name + '" is not available in the troubleshooter. Allowed: ' + Object.keys(TROUBLESHOOTER_TOOLS).join(', ') + '.';
    } else {
      try {
        toolResult = await fn(toolCall.input);
      } catch (e) {
        toolResult = 'ERROR: ' + e.message;
      }
    }
    dbg.event('progress', { label: 'ts-tool', name: toolCall.name, phase: 'done' });

    const assistantMsg = { role: 'assistant', content: raw };
    const resultMsg    = {
      role: 'user',
      content: 'TOOL_RESULT [' + toolCall.name + ']:\n' + toolResult
        + '\n\nIf this answers the user\'s question, reply now in plain English text. Only emit another TOOL block if a follow-up diagnosis is strictly required.',
    };
    msgs.push(assistantMsg, resultMsg);
  }
}

// ─── draftPaletteCategory — "Phoenix hilft" backend ──────────────────────────
// Calls the orchestrator seat to draft ONE palette category entry.
// Does NOT save anything — returns { hint, style, target_face_num, cfg, steps }.

async function draftPaletteCategory({ name, description }, cfg) {
  const systemPrompt = `You are a 3D-asset style-palette designer. Draft ONE category entry for a Trellis/Flux 3D-asset pipeline.

Output ONLY a single JSON object — no prose, no markdown, no explanation:
{"hint": "...", "style": "...", "target_face_num": <int 200-300000>, "cfg": <num 0-20>, "steps": <int 1-100>}

Rules:
- hint: short description of what objects belong in this category (1 sentence)
- style: the image-style sentence used for the reference render that Flux generates (tells Flux how to frame/light the object)
- target_face_num: controls Trellis mesh density (200=very low, 300000=very high; typical range 3500-40000)
- cfg: Flux guidance scale (0-20; typical 3.0-4.5)
- steps: Flux sampling steps (1-100; typical 20)`;

  const existingPalette = palette.loadPalette();
  const existingContext = Object.entries(existingPalette.categories)
    .map(([k, v]) => `  ${k}: style="${v.style}"`)
    .join('\n');

  const userMsg = `New category name: ${name || description}
Description: ${description}

Existing palette for context (match the style conventions):
${existingContext}

Output ONLY the JSON object for the new category.`;

  const model = (cfg.seats && cfg.seats.orchestrator && cfg.seats.orchestrator.model) || 'claude-sonnet-4-6';
  const raw = await callClaudeSeat([{ role: 'user', content: userMsg }], { model, systemPrompt });

  // Extract JSON from response
  let parsed = null;
  const braceIdx = raw.indexOf('{');
  if (braceIdx >= 0) {
    const objStr = extractBalancedObject(raw, braceIdx);
    if (objStr) {
      try { parsed = JSON.parse(objStr); } catch {
        try { parsed = JSON.parse(sanitizeJsonControlChars(objStr)); } catch { parsed = null; }
      }
    }
  }
  if (!parsed) parsed = {};

  // Baseline fallback values from item category
  const baseline = { target_face_num: 7500, cfg: 4.0, steps: 20 };

  // Clamp/validate target_face_num
  let target_face_num = Math.round(Number(parsed.target_face_num));
  if (!Number.isFinite(target_face_num)) target_face_num = baseline.target_face_num;
  target_face_num = Math.max(200, Math.min(300000, target_face_num));

  // Clamp/validate cfg
  let cfg_val = Number(parsed.cfg);
  if (!Number.isFinite(cfg_val)) cfg_val = baseline.cfg;
  cfg_val = Math.max(0, Math.min(20, cfg_val));

  // Clamp/validate steps
  let steps = Math.round(Number(parsed.steps));
  if (!Number.isFinite(steps)) steps = baseline.steps;
  steps = Math.max(1, Math.min(100, steps));

  const hint  = (typeof parsed.hint  === 'string' && parsed.hint.trim())  ? parsed.hint.trim()  : (description || name || 'custom category');
  const style = (typeof parsed.style === 'string' && parsed.style.trim()) ? parsed.style.trim() : 'product studio photo, white background, 3/4 angle view, soft diffuse lighting';

  return { hint, style, target_face_num, cfg: cfg_val, steps };
}

// ─── inferWorkflowMap — "Phoenix maps" backend ────────────────────────────────
// Calls the orchestrator seat to map a ComfyUI API-format workflow to Phoenix's
// fixed node-map for a given stage ('image' or 'mesh').
// Does NOT save anything — returns { nodes, deps, label, nodeChoices, modelCandidates }.

async function inferWorkflowMap(stage, jsonText, cfg) {
  // 1. Parse + strip non-node keys (UI-graph format is a hard error)
  const { clean } = workflows.prepareWorkflowJson(jsonText);
  const obj = clean;

  // 2. Build helper data
  const choices = workflows.collectNodeChoices(obj);
  const models  = workflows.collectModelCandidates(obj);
  const classes = workflows.listClassTypes(obj);

  // 4. Fetch a filtered /object_info slice (best-effort — on any failure use {})
  const base = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8000';
  let slice = {};
  try {
    const r = await fetch(base + '/object_info', { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const info = await r.json();
      slice = {};
      for (const c of classes) if (info[c]) slice[c] = info[c];
    }
  } catch { slice = {}; }

  // Build compact field listing string
  let fieldListing;
  if (Object.keys(slice).length === 0) {
    fieldListing = '(ComfyUI offline — infer fields from titles/structure)';
  } else {
    const lines = [];
    for (const c of Object.keys(slice)) {
      const req = Object.keys((slice[c].input && slice[c].input.required) || {});
      const opt = Object.keys((slice[c].input && slice[c].input.optional) || {});
      const fields = [...req, ...opt];
      lines.push(`${c}: ${fields.join(', ')}`);
    }
    fieldListing = lines.join('\n');
  }

  // 5. System prompt (verbatim per spec)
  const systemPrompt = `You map a ComfyUI API-format workflow to Phoenix's fixed node-map for the "${stage}" stage.

Phoenix injects values into specific node ids + input fields. For each required slot, pick the node id (and field, if non-default) from THIS workflow that should receive that value.

Stage "image" slots:
- positive  -> node+field holding the POSITIVE prompt text (usually a CLIPTextEncode 'text')
- negative  -> the NEGATIVE prompt text node+field (CLIPTextEncode 'text'); omit if the workflow has none
- cfg       -> the sampler's CFG/guidance field (e.g. KSampler 'cfg')
- steps     -> the sampler's steps field (e.g. KSampler 'steps')
- seed      -> the sampler's seed field. The field name VARIES: KSampler uses 'seed', some samplers use 'noise_seed'. Use the real field name from the field listing.
- output    -> the image OUTPUT node (e.g. SaveImage)

Stage "mesh" slots:
- image           -> node+field that receives the input image
- seed            -> the seed field
- target_face_num -> the mesh face-count field
- output_prefix   -> the filename/prefix field (optional)
- output          -> the mesh export/output node

Output ONLY one JSON object, no prose, no markdown:
{"nodes": {"<slot>": "<nodeId>" OR {"node":"<nodeId>","field":"<fieldName>"}}, "deps": {"custom_nodes": [], "models": []}, "label": "<short label>"}

Rules:
- Use a plain "<nodeId>" string when the field is the slot's default; use {"node","field"} when a specific/non-default field is needed (e.g. seed where the field is 'seed' not 'noise_seed').
- Only include slots you can identify. Every node id MUST be one of the ids listed.
- deps.custom_nodes: class_types that are NOT ComfyUI core (core = KSampler, CLIPTextEncode, VAEDecode, VAEEncode, EmptyLatentImage, CheckpointLoaderSimple, SaveImage, LoadImage, PreviewImage). When unsure, include it.
- deps.models: model filenames referenced (checkpoint/unet/vae/clip/lora/gguf).`;

  // 6. Build user message
  const nodeLines = choices.map(({ id, class_type, title }) => `${id} - ${class_type} - ${title}`).join('\n');
  const userMsg = `Stage: ${stage}

Nodes (id - class_type - title):
${nodeLines}

Input fields per class (from live ComfyUI):
${fieldListing}

Auto-detected model candidates: ${models.length ? models.join(', ') : '(none)'}

Workflow JSON:
${jsonText}

Output ONLY the JSON object.`;

  // 7. Call the orchestrator seat
  const model = (cfg.seats && cfg.seats.orchestrator && cfg.seats.orchestrator.model) || 'claude-sonnet-4-6';
  const raw = await callClaudeSeat([{ role: 'user', content: userMsg }], { model, systemPrompt });

  // 8. Parse JSON from raw (same pattern as draftPaletteCategory)
  let parsed = {};
  const braceIdx = raw.indexOf('{');
  if (braceIdx >= 0) {
    const objStr = extractBalancedObject(raw, braceIdx);
    if (objStr) {
      try { parsed = JSON.parse(objStr); } catch {
        try { parsed = JSON.parse(sanitizeJsonControlChars(objStr)); } catch { parsed = {}; }
      }
    }
  }

  // 9. Clamp to stage contract
  const ALLOWED = stage === 'mesh'
    ? ['image', 'seed', 'target_face_num', 'output_prefix', 'output']
    : ['positive', 'negative', 'cfg', 'steps', 'seed', 'output'];

  const nodes = {};
  for (const slot of ALLOWED) {
    const val = parsed.nodes && parsed.nodes[slot];
    if (val == null) continue;
    // Resolve node id
    const nodeId = (val !== null && typeof val === 'object') ? String(val.node) : String(val);
    // Keep only if node id exists in the workflow
    if (!(nodeId in obj)) continue;
    // Store with or without explicit field
    if (val !== null && typeof val === 'object' && typeof val.field === 'string') {
      nodes[slot] = { node: String(val.node), field: val.field };
    } else {
      nodes[slot] = nodeId;
    }
  }

  const deps = {
    custom_nodes: Array.isArray(parsed.deps && parsed.deps.custom_nodes)
      ? parsed.deps.custom_nodes.filter(x => typeof x === 'string')
      : [],
    models: Array.isArray(parsed.deps && parsed.deps.models)
      ? parsed.deps.models.filter(x => typeof x === 'string')
      : [],
  };

  // Union Claude's models with the auto-detected candidates (dedupe) so no referenced model is dropped
  deps.models = [...new Set([...deps.models, ...models])];

  const label = (typeof parsed.label === 'string' && parsed.label.trim()) ? parsed.label.trim() : '';

  // 10. Return
  return { nodes, deps, label, nodeChoices: choices, modelCandidates: models };
}

// ─── Claude CLI probe ─────────────────────────────────────────────────────────

function claudeCliCheck() {
  return new Promise((resolve) => {
    let done = false; let out = ''; let err = '';
    let child;
    const finish = (val) => { if (done) return; done = true; clearTimeout(timer); try { if (child) child.kill(); } catch {} resolve(val); };
    const timer = setTimeout(() => finish({ present: false, error: 'timeout' }), 8000);
    try {
      child = spawn('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    } catch (e) { finish({ present: false, error: e.message }); return; }
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => finish({ present: false, error: e.message }));
    child.on('close', code => finish(code === 0 ? { present: true, version: out.trim() || '(unknown)' } : { present: false, error: err.trim() || ('exit ' + code) }));
  });
}

// ─── Onboarding status aggregate ─────────────────────────────────────────────

async function onboardingStatus(cfg) {
  cfg = cfg || {};
  const completed  = !!(cfg.onboarding && cfg.onboarding.completed);
  const comfyBase  = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8000';
  const localBase  = (cfg.endpoints && cfg.endpoints.local)   || 'http://localhost:1234/v1';

  const node = { present: true, version: process.version };

  let comfyui = { reachable: false, base: comfyBase };
  try {
    const r = await fetch(comfyBase + '/object_info', { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const info = await r.json();
      const reg  = workflows.loadRegistry();
      const deps = {};
      for (const [id, entry] of Object.entries(reg.workflows)) deps[id] = workflows.checkDeps(entry, info);
      const active = {
        image: (cfg.workflows && cfg.workflows.image) || workflows.DEFAULT_ACTIVE.image,
        mesh:  (cfg.workflows && cfg.workflows.mesh)  || workflows.DEFAULT_ACTIVE.mesh,
      };
      comfyui = { reachable: true, base: comfyBase, deps, active };
    } else {
      comfyui = { reachable: false, base: comfyBase, error: 'HTTP ' + r.status };
    }
  } catch (e) { comfyui = { reachable: false, base: comfyBase, error: (e && e.message) || String(e) }; }

  const claudeCli = await claudeCliCheck();

  let lmstudio = { reachable: false, base: localBase };
  try {
    const r = await fetch(localBase + '/models', { signal: AbortSignal.timeout(4000) });
    lmstudio = { reachable: !!r.ok, base: localBase };
  } catch (e) { lmstudio = { reachable: false, base: localBase, error: (e && e.message) || String(e) }; }

  const blenderPath = (cfg.apps && cfg.apps.blender) || null;
  let blenderPresent = false;
  try { blenderPresent = !!(blenderPath && fs.existsSync(blenderPath)); } catch {}
  const blender = { present: blenderPresent, path: blenderPath };

  return { completed, node, comfyui, claudeCli, lmstudio, blender };
}

module.exports = { runTurn, callClaude, callBlender, loadConfig, saveConfig, ensureConfig, loadHistory, saveHistory, loadState, saveState, loadSceneCache, saveSceneCache, listStagedFiles, listBrushesData, listMaterialsData, loadLibraryLabels, TOOLS, SYSTEM_PROMPT, tsTailDebugLog, runTroubleshootTurn, draftPaletteCategory, inferWorkflowMap, claudeCliCheck, onboardingStatus, listLmStudioModels };
