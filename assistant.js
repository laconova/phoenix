'use strict';

const readline = require('readline');
const { spawnSync, spawn } = require('child_process');
const { spawnNode } = require('./spawn-node');   // async spawn so a ~2-3 min brush child never freezes the loop
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const net  = require('net');
const blenderIpc = require('./blender-ipc');
const unrealIpc  = require('./unreal-ipc');
const unrealVision = require('./unreal-vision');
const { brushToUnreal, ensureBrushGlb } = require('./brush-to-unreal');
const { unrealToBlender, unrealToBrush } = require('./unreal-to-blender');
const { characterToUnreal } = require('./character-to-unreal');

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
const { makeHuman, placeHuman } = require('./make_human');
const { animateHuman, sequenceAnimations, saveAnimation } = require('./animate_human');
const { generateMotion } = require('./hy_motion');
const customRig = require('./custom_rig');
const characterLib = require('./characters');
const renderCheck = require('./render_check');
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

const BLENDER_ONLY_TOOLS = ['blender_run', 'read_state', 'list_assets', 'list_brushes', 'use_brush', 'save_as_brush', 'import_asset', 'make_human', 'place_human', 'animate_human', 'sequence_animations', 'save_animation', 'assign_skeleton', 'spawn_rig', 'hy_motion', 'inspect_render'];
const BLENDER_ONLY_SYSTEM = 'BLENDER-ONLY MODE (active this turn): The generation tools (generate_image, image_to_3d, generate_prop) are DISABLED. Build the requested asset by modelling it directly in Blender with bpy via the blender_run tool — use primitives, modifiers, transforms, and materials. Do NOT call any image/3D generation tool; if you do, it will be rejected.';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

// tmp + rename: a crash mid-write can never leave a truncated file that the next read treats as
// corrupt or reseeds over. Same atomic pattern as palette.js / workflows.js.
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function saveConfig(cfg) {
  writeFileAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2));
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

// Built per call, NOT once at module load: the palette's categories change while the server
// runs (Settings → palette), and a prompt frozen at startup keeps advertising the old list —
// so a category the user just created stayed invisible to the assistant in the very session
// that created it, until someone restarted Phoenix.
function buildSystemPrompt() {
  const CATEGORY_ENUM = Object.keys(palette.loadPalette().categories).join('|');
  return `You are Phoenix, a creative assistant for 3D asset creation in Blender. You can generate images, turn images into 3D assets, and run Blender directly. You control Blender via file-based IPC (the Phoenix IPC addon). You have tools — use them.

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
- unreal_run      runs Python in a RUNNING Unreal Editor (separate app from Blender — this does NOT touch the Blender scene). Use for Unreal-side work: querying assets, spawning/inspecting actors, taking a viewport screenshot. INPUT: {"code": "python as single string, \\n for newlines"}. NOTE: Unreal writes screenshots at the END of the frame, so take the shot in one call and collect the file in the NEXT one — checking os.path.exists() in the same call always reports False.
- unreal_to_blender is the OTHER direction: it pulls an existing Unreal asset back into Blender. INPUT: {"asset": "/Game/MHExport/spudermin_Body", "refresh": true (optional — re-export instead of using the cached GLB), "export_only": true (optional — write the GLB and stop, do not touch Blender)}. Works on StaticMesh, SkeletalMesh and AnimSequence; a SkeletalMesh arrives with its armature, vertex groups and ARMATURE modifier intact. Two things it reports and you should relay: a material named WorldGridMaterial means the SOURCE asset had an empty material slot and the grey checker was substituted — the real look did NOT travel; and materials with no metallicFactor are corrected to 0 on the way in, because glTF's default for the missing key is 1.0 (fully metal) and that is almost never what the asset meant. Assets whose metallic comes from a TEXTURE are left alone.
- unreal_to_brush goes one step further than unreal_to_blender: it fetches the Unreal asset into Blender and saves it into the BRUSH LIBRARY, so it can be placed anywhere afterwards. INPUT: {"asset": "/Game/Props/SM_Crate", "name": "crate" (optional — defaults to the asset name), "category": "item" (optional), "force": true (optional — overwrite an existing brush of that name), "keep_in_blender": true (optional)}. REFUSES a rigged asset on purpose: a brush holds meshes only, so an armature would be dropped silently — rigged characters belong in the Human tab (mixamorig) or the Custom-Rig tab. By default the imported objects are removed from Blender again AFTER the brush is confirmed in the registry.
- character_to_unreal carries a RIGGED character from the Human tab into Unreal as SkeletalMeshes with their skeleton — the counterpart to brush_to_unreal, which cannot do this because a brush is meshes only. INPUT: {"rig": "Human.rig" (optional — omitted takes the first mixamorig armature in the scene), "name": "my_char" (optional), "unreal_path": "/Game/PhoenixCharacters" (optional), "with_animation": true (optional)}. Two things worth relaying: characters built in the Human tab are HIDDEN (staged) and are unhidden for the export and re-hidden afterwards; and every import creates its OWN skeleton asset, so several characters imported this way do not share an animation library until their skeletons are merged. For animation work FBX is the right carrier, not glTF — with_animation is preview-grade.
- brush_to_unreal carries a brush from the library into Unreal as a placed ACTOR TREE (hierarchy and relative transforms intact), not loose meshes. Blender is used only the first time per brush; afterwards a cached GLB is imported directly, so this works with Blender closed. INPUT: {"name": "slug", "unreal_path": "/Game/PhoenixBrushes" (optional), "refresh": true (optional — rebuild the cached GLB), "keep_in_blender": true (optional)}. By default the brush is removed from the Blender scene again AFTER the export is verified — never before, so a failed export cannot cost the placed objects. Reports how many parameters each imported material carries; a material with 0 renders black and the call fails rather than shipping it.
- inspect_unreal   renders the Unreal level AND LOOKS AT IT — returns a description written by a vision model that actually saw the image, not a file path. INPUT: {"focus": "ActorLabel" (optional — frames that actor and its children automatically), "question": "what to check" (optional), "mode": "camera" (default) | "viewport", "width": 1280, "height": 720}. The camera route works no matter which window is in focus but carries NO post-processing, so emissive materials do not glow in it — judge placement/material/breakage from it, not final looks. "viewport" is the real editor view including bloom and FAILS with a clear error unless the Unreal window is in the foreground. If this tool returns an error, or if Unreal vision is switched off, you have NOT seen the level: say so plainly and never describe its contents from memory or inference.
- read_state      reads session state: sceneObjects (what was in the Blender scene at the last sync — refreshed by imports, by an explicit refresh, and by the optional scene-sync poller if it is running; treat it as possibly stale and verify with blender_run when it matters), stagedFiles (GLB FILES on disk in staging/, ready to import), lastTask, sceneUpdatedAt. INPUT: {}
- list_assets     lists staged GLB FILES on disk (in staging/). These are assets ready to import — they are NOT necessarily in the Blender scene. INPUT: {}
- read_palette    returns the current style palette (each category's style text + params). Use ONLY when the user asks you to help draft or choose a category. INPUT: {}
- list_materials   lists the shared MATERIAL palette (reusable materials that brushes share) — NOT the style palette above. INPUT: {}
- delete_material  removes a material from the shared MATERIAL palette by name (palette registry only; the open Blender scene is untouched). Use when the user says e.g. "delete material X from the palette". INPUT: {"name": "MaterialName"}
- import_asset    imports a staged file into the live Blender scene. INPUT: {"name": "filename.glb", "cleanup": true|false}. cleanup:true = import with auto-smooth shading; omitted/false = raw mesh (DEFAULT = raw).
- list_brushes    lists brushes. INPUT: {} for all, {"category": "item|furniture|sci_fi|..."} to filter by category, {"search": "keyword"} to search by name. Use filtered calls — avoid listing all when you only need one category.
- save_as_brush   saves Blender mesh(es) as a reusable brush — ONE brush file that places whole again later. INPUT: {"name": "slug", "collection": "CollectionName (optional — saves ALL meshes in it)", "object": "BlenderObjName (optional — single object)", "category": "item|sci_fi|etc (optional)", "display": "Human label (optional)", "overwrite": false}. Omit collection AND object to save ALL currently selected meshes. If the name collides with an existing brush the save is REFUSED with a suggested free name — relay that to the user and let them choose; only set overwrite:true when the user explicitly says to replace or update that brush.
- use_brush       places a brush from the library into the scene at optional coordinates. INPUT: {"name": "slug", "x": 0, "y": 0, "z": 0, "instance_name": "optional"}
- make_human      creates a parametric MakeHuman character directly in the Blender scene (MPFB2), with a skin material + body parts. Body sliders are 0..1, optional (omit = 0.5 neutral). A skin is auto-matched to gender/age/race; eyes+teeth+eyebrows+eyelashes are ON by default. INPUT: {"gender": 0=female..1=male, "age": 0=young..1=old, "muscle": 0..1, "weight": 0..1, "height": 0=short..1=tall, "proportions": 0..1, "cupsize": 0..1, "firmness": 0..1, "race": {"asian":0..1,"caucasian":0..1,"african":0..1}, "rig": false|"default"|"mixamo" (add a skeleton; use "mixamo" if you will animate it via animate_human), "name": "optional", "skin": false (procedural, no assets) | "substr" (pick a skin asset by name), "eyes"/"teeth"/"eyebrows"/"eyelashes": true|false, "eyeColor": "brown|blue|green|grey|...", "hair": true (default style) | "short01|long01|afro01|bob01|ponytail01|braid01|...", "clothes": "male_casualsuit01" or ["...","..."], "targets": {"nose/nose-scale-horiz-more": 0.7, ...} (MakeHuman detail targets 0..1), "staged": true (build hidden in a staging collection for the tab's Preview & Place flow instead of dropping it visibly into the scene)}
- place_human     commits the currently staged human (from a make_human call with staged:true) into the scene at the origin, visible. INPUT: {}
- animate_human    applies a Mixamo FBX animation to a MakeHuman character that was built with rig:"mixamo". Retargets + bakes the animation onto the character (source rig removed), sets the scene frame range. The FBX must already be in the animations/ folder (dropped via the Human tab). INPUT: {"fbx": "Low Crawl.fbx" (filename in animations/), "character": "optional target name — defaults to the mixamo-rigged character in the scene"}
- hy_motion       generates an animation FROM A TEXT DESCRIPTION (HY-Motion in ComfyUI) and applies it to a rig:"mixamo" character — use this when the user describes a motion that is not already an FBX in animations/ ("make him walk in a circle and sit down"). Takes ~230s for 6s of motion; the clip is saved in animations/ for reuse. INPUT: {"prompt": "a person walks forward and looks around" (English, describe the MOTION not the character), "duration": 6 (seconds, 1-20), "seed": optional int for a repeatable result, "apply": true (set false to only generate), "character": "optional target name"}
- save_animation   saves the animation currently ON a rig:"mixamo" character (hand-keyframed, or a built sequence) as a reusable FBX clip in animations/, so it can be re-applied and sequenced. Use when the user asks to save/export/keep the current animation. INPUT: {"name": "my_clip" (filename to save under), "character": "optional source name — defaults to the mixamo-rigged character in the scene"}
- sequence_animations  chains several Mixamo FBX clips onto a rig:"mixamo" character as blended NLA strips. Each clip is retargeted WITH its own real root motion and offset so it starts exactly where the previous clip stood at the seam — no snap-back, no foot sliding. Use append:true to add clips to the END of the existing sequence instead of rebuilding. INPUT: {"fbxs": ["Idle.fbx","Walking.fbx",...] (ordered, from animations/), "blend": 8 (crossfade frames), "speed": 0 (OPTIONAL extra forward drift in metres/frame — leave at 0 for normal clips; only genuine Mixamo "In Place" clips need a value), "append": false, "character": "optional target"}
- inspect_render  renders the CURRENT Blender scene (EEVEE, non-destructive) and returns a vision verdict (PASS/FAIL + what is visibly wrong). Use it to SEE a result instead of guessing: after a visual change (spawn, animation, mesh/rig edit, placement) to confirm it actually looks right, and BEFORE claiming anything visual is fixed. INPUT: {} or {"question": "specific thing to check, e.g. is the deer head attached and undamaged"}

WORKFLOW RULES:
- Flow control (when to stop for approval between image / 3D / import) is handled automatically by the system based on settings — you do NOT need to tell the user to approve or ask permission between steps. Just call the tool the user's request implies, then relay the tool result. For a 3D prop call generate_image (or image_to_3d to continue from an existing image); for image-only requests use generate_image; never refuse an image-only request.
- If the user only wants an image (e.g. "an image of a dog"), use generate_image and stop. Do NOT refuse — you can produce images.
- Use generate_prop only when the user explicitly wants the whole thing done in one go without stopping — and only while no approval gate is enabled (gated sessions must go through generate_image so the pipeline can pause).
- If a tool result contradicts what you expected twice in a row, STOP retrying: diagnose first (read_state or a small blender_run inspection), then act on what you actually find. For anything VISUAL (does it look right, is it broken, did the change take), call inspect_render to actually SEE the render — never claim a visual result is fixed without looking. If you cannot verify, say so plainly and ask the user to check, rather than asserting success.
- A tool result may carry a "RENDER GATE" section. That is an automatic render of the scene taken FOR you right after your action — you did not call it and you cannot turn it off. Treat it as the strongest evidence you have about the current scene: if it reports a problem, report that problem to the user instead of claiming success, and if it says it could not look, say the result is unverified. When a gate verdict is already present, do NOT call inspect_render again for the same action.

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

User: make a tall muscular man
TOOL: make_human
INPUT: {"gender": 1.0, "muscle": 0.85, "height": 0.9}

User: create a young woman and rig her
TOOL: make_human
INPUT: {"gender": 0.0, "age": 0.3, "rig": true}

User: make an old man in a suit with short hair and blue eyes
TOOL: make_human
INPUT: {"gender": 1.0, "age": 0.85, "hair": "short01", "clothes": "male_casualsuit01", "eyeColor": "blue"}

User: make a man I can animate, then make him do the low crawl
TOOL: make_human
INPUT: {"gender": 1.0, "rig": "mixamo", "name": "Crawler"}
TOOL: animate_human
INPUT: {"fbx": "Low Crawl.fbx", "character": "Crawler"}

User: import it cleaned
TOOL: import_asset
INPUT: {"name": "phoenix_a_dog_0_2026-06-24T12-00.glb", "cleanup": true}

After TOOL_RESULT: 1-2 sentences on what it shows. If it is an error, say what failed in one sentence.`;
}

// Startup snapshot, kept so existing importers of SYSTEM_PROMPT keep working. Anything that
// needs the CURRENT categories must call buildSystemPrompt() instead.
const SYSTEM_PROMPT = buildSystemPrompt();

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
  // Walk the STAGING FOLDER, not just the palette's category list. Filing by palette meant a
  // category removed from the palette took its staged GLBs out of sight with it — still on
  // disk, invisible to list_assets / read_state / import. Deleting such a category is refused
  // now (server.js POST /palette), but anything orphaned BEFORE that guard existed has to stay
  // findable, so unknown folders are listed too and flagged.
  const categories = Object.keys(palette.loadPalette().categories);
  let dirs = [];
  try {
    dirs = fs.readdirSync(STAGING_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch (_) { dirs = []; }
  for (const cat of categories) if (!dirs.includes(cat)) dirs.push(cat);

  const found = [];
  for (const cat of dirs.sort()) {
    const dir = path.join(STAGING_BASE, cat);
    let files;
    try {
      // readdir statt existsSync-dann-lesen: eine DATEI mit Kategorienamen wirft ENOTDIR,
      // ein Virenscanner EPERM — und das riss bisher read_state und list_assets komplett um.
      // .GLB case-insensitiv, damit dieselbe Datei zaehlt wie in der Palette-Wache (server.js).
      files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.glb'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } catch (_) { continue; }
    for (const f of files) {
      found.push({ name: f, category: cat, path: path.join(dir, f), orphaned: !categories.includes(cat) });
    }
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
    })).sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true, sensitivity: 'base' }));
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
  return found.map(a => `${a.category}/${a.name}` +
    (a.orphaned ? '   ⚠ its category is no longer in the palette — still importable, but it will not appear under any category' : '')
  ).join('\n');
}

async function toolReadState(_input, state, _cfg) {
  const scene = loadSceneCache(); // fresh from disk — reflects the latest scene-sync poll
  return JSON.stringify({
    currentScene:   state.currentScene,
    sceneObjects:   scene.sceneObjects,   // Blender scene contents as of the last sync (see read_state)
    sceneUpdatedAt: scene.sceneUpdatedAt, // when the scene cache was last refreshed (null = never / poller off)
    stagedFiles:    listStagedFiles().map(a => `${a.category}/${a.name}`), // GLB files on disk, ready to import
    lastTask:       state.lastTask,
  }, null, 2);
}

async function toolReadPalette(_input, _state, _cfg) {
  const cats = palette.loadPalette().categories;
  return JSON.stringify({ categories: cats });
}

async function toolUnrealRun(input, _state, cfg) {
  const code = input.code;
  if (!code) return 'ERROR: no code provided';
  try {
    // Anders als bei Blender wird cfg DURCHGEREICHT: die Bruecke findet die Engine ueber
    // apps.unrealEngine (oder faellt auf den neuesten UE_* zurueck) und braucht sie, um
    // Epics eigenen remote_execution-Client zu laden.
    const r = await unrealIpc.callUnreal(code, { cfg, timeoutMs: 120000 });
    if (r.status !== 'ok') {
      // Die Bruecke liefert bei "kein Editor gefunden" bereits eine Diagnose, die ALLE vier
      // Ursachen nennt (Editor zu / Plugin aus / Remote Execution aus / Multicast blockiert).
      // Deshalb wird sie durchgereicht statt zu einem generischen Satz eingedampft.
      return `UNREAL_ERROR: ${r.message || r.stderr || JSON.stringify(r)}`;
    }
    const out = String(r.stdout || '').trim();
    if (!out) return 'OK (script ran, no print output)';
    if (out.includes('Traceback') || out.includes('SyntaxError')) return `PYTHON_ERROR:\n${out}`;
    return out;
  } catch (e) {
    return 'UNREAL_ERROR: ' + e.message;
  }
}

// Carry a brush from the library into Unreal in one call. The heavy lifting (GLB cache, scene
// import, material verification) lives in brush-to-unreal.js — this is only the tool seam.
async function toolBrushToUnreal(input, _state, cfg) {
  const name = input && input.name;
  if (!name) return 'ERROR: name required';
  try {
    const r = await brushToUnreal({
      name,
      unrealPath:    input.unreal_path,
      refresh:       !!input.refresh,
      keepInBlender: !!input.keep_in_blender,
      cfg,
    });
    const lines = r.steps.map(s => '  ' + s);
    // The material parameter counts are reported, not hidden: a brush arriving with zero of them
    // renders black, and that is the one defect this route has actually produced.
    if (r.materials && r.materials.length) {
      lines.push('  materials: ' + r.materials.map(m => `${m.name} (${m.params})`).join(', '));
    }
    return `Brush "${r.slug}" is in Unreal at ${r.destPath}\n` + lines.join('\n');
  } catch (e) {
    return 'BRUSH_TO_UNREAL_ERROR: ' + (e.message || String(e));
  }
}

// The other direction: pull an Unreal asset back into Blender. Mirror of toolBrushToUnreal, and
// the heavy lifting is in unreal-to-blender.js — this is only the tool seam.
async function toolUnrealToBlender(input, _state, cfg) {
  const asset = input && input.asset;
  if (!asset) return 'ERROR: asset required, e.g. "/Game/MHExport/spudermin_Body"';
  try {
    const r = await unrealToBlender({
      asset,
      refresh:    !!input.refresh,
      exportOnly: !!input.export_only,
      cfg,
    });
    const lines = r.steps.map(s => '  ' + s);
    // What ARRIVED, not what was requested. A bone/vertex-group count is the difference between
    // "a mesh came over" and "a rigged character came over", and only the second one is usable.
    if (r.blender) {
      for (const o of r.blender.objects) {
        lines.push(o.type === 'ARMATURE'
          ? `  armature ${o.name}: ${o.bones} bones, root ${o.roots.join('/') || '(none)'}`
          : `  ${o.type.toLowerCase()} ${o.name}: ${o.verts} verts, ${o.vertexGroups} vertex groups, ` +
            `modifiers [${o.modifiers.join(', ')}]`);
      }
    }
    return `${r.asset} -> ${r.blender ? 'Blender' : r.glb}\n` + lines.join('\n');
  } catch (e) {
    return 'UNREAL_TO_BLENDER_ERROR: ' + (e.message || String(e));
  }
}

// Unreal asset -> Blender -> brush library, in one call. Closes the round trip: brush_to_unreal
// sends geometry out, this turns something that only existed in Unreal into a placeable brush.
async function toolUnrealToBrush(input, _state, cfg) {
  const asset = input && input.asset;
  if (!asset) return 'ERROR: asset required, e.g. "/Game/Props/SM_Crate"';
  try {
    const r = await unrealToBrush({
      asset,
      name:          input.name,
      category:      input.category,
      display:       input.display,
      force:         !!input.force,
      refresh:       !!input.refresh,
      keepInBlender: !!input.keep_in_blender,
      cfg,
    });
    return `Brush "${r.slug}" saved from ${r.asset}\n` + r.steps.map(s => '  ' + s).join('\n') +
           `\n  Say "use brush ${r.slug}" to place it.`;
  } catch (e) {
    return 'UNREAL_TO_BRUSH_ERROR: ' + (e.message || String(e));
  }
}

// A rigged character from the Human tab into Unreal as a SkeletalMesh. Separate from
// brush_to_unreal because a brush is meshes only — this one has to carry the armature.
async function toolCharacterToUnreal(input, _state, cfg) {
  try {
    const r = await characterToUnreal({
      rig:           input && input.rig,
      name:          input && input.name,
      unrealPath:    input && input.unreal_path,
      withAnimation: !!(input && input.with_animation),
      refresh:       !!(input && input.refresh),
      cfg,
    });
    const lines = r.steps.map(s => '  ' + s);
    // The skeleton is named, not hidden: N characters with N skeletons means no shared clip
    // library, and that is a decision the operator has to be able to see coming.
    if (r.skelMesh.length) lines.push('  skeletal meshes: ' + r.skelMesh.length);
    return `Character is in Unreal at ${r.destPath}\n` + lines.join('\n');
  } catch (e) {
    return 'CHARACTER_TO_UNREAL_ERROR: ' + (e.message || String(e));
  }
}

// Build (or reuse) a brush's cached GLB so the mesh viewer can show it. A brush is Python plus a
// .blend and therefore has no preview of its own — the cache the Unreal bridge already produces is
// exactly the missing artefact, so this reuses it rather than inventing a second thumbnail path.
// On-demand by the user's choice (2026-07-31): the first click on a brush costs one Blender export,
// every later one is instant.
async function toolBrushPreview(input, _state, cfg) {
  const name = input && input.name;
  if (!name) return 'ERROR: name required';
  try {
    const r = await ensureBrushGlb({ name, cfg });
    return `PREVIEW_READY ${path.relative(__dirname, r.glb).replace(/\\/g, '/')} — ` +
           `${r.cached ? 'from cache' : 'exported from Blender'} (${r.bytes} bytes)`;
  } catch (e) {
    return 'BRUSH_PREVIEW_ERROR: ' + (e.message || String(e)) +
           (/not responding|IPC/i.test(e.message || '')
             ? '\nThe first preview of a brush needs Blender open with the Phoenix IPC addon; ' +
               'after that it is served from the cache.'
             : '');
  }
}

// Render the Unreal level to a PNG so it can actually be LOOKED at. Default route is the
// in-level camera, which does not care whether the Unreal window has focus — see unreal-vision.js
// for why the viewport route is not the default.
async function toolInspectUnreal(input, _state, cfg) {
  try {
    // The Settings values are the DEFAULT, an explicit argument wins. Without this the switches in
    // the gates panel would be decoration — set but never consulted.
    const prefs = (cfg && cfg.unreal) || {};

    // ...with ONE exception: "off" is not a default, it is a refusal, and it beats the argument.
    // A switch the caller can talk its way past is not a switch. The message says plainly that the
    // level was not looked at, so the turn cannot quietly continue as if it had been.
    if (prefs.visionMode === 'off') {
      return 'UNREAL_VISION_OFF: Unreal vision is switched off in Settings, so the level was NOT ' +
             'rendered and NOT looked at. Do not describe or judge how anything in Unreal looks. ' +
             'Say that vision is off and let the user turn it on (gates panel → Unreal vision) if ' +
             'they want a visual check.';
    }

    const r = await unrealVision.captureUnreal({
      cfg,
      mode:   (input && input.mode)   || prefs.visionMode,
      focus:  input && input.focus,
      width:  (input && input.width)  || prefs.visionWidth,
      height: (input && input.height) || prefs.visionHeight,
    });

    // 🔴 THE RENDER IS NOT THE ANSWER. Returning a file path here let the orchestrator answer
    // "what do you see in the level?" with an invented description — it reported a character
    // standing in a scene that holds a capacitor and a tree trunk (live, 2026-07-31). A path is
    // not evidence; somebody has to LOOK. So the image goes through the vision seat, exactly like
    // inspect_render does for Blender, and what comes back is a VERDICT.
    const model = visionModel(cfg);   // own seat — the judge is not the orchestrator

    // Hand the judge the level's actual contents. Without it, it can only describe shapes — it
    // called an oak trunk "a canopy/shelter structure" and a capacitor "a translucent canister"
    // (live, 2026-07-31). Phoenix knows the names, so withholding them was throwing away
    // information we already had.
    let inventory = '';
    try {
      const actors = await unrealVision.levelInventory(cfg);
      if (actors.length) {
        inventory =
          '\n\nFor reference, Unreal reports these actors in the level (indentation = parenting):\n' +
          actors.map(a => '  '.repeat((a.depth || 0) + 1) + a.label + '  [' + a.cls + ']').join('\n') +
          '\n\nUse these NAMES when you describe what you see. ⚠️ This list is what the level ' +
          'CONTAINS, not what is in frame — the camera may not show all of it. State which of ' +
          'these you can actually see and which you cannot. Never claim to see something merely ' +
          'because it appears in this list.';
      }
    } catch (_) { /* inventory is a bonus; a render without it still beats no render */ }

    const question = ((input && typeof input.question === 'string' && input.question.trim())
      ? input.question.trim()
      : 'Describe what is actually visible in this Unreal Engine level render: which objects are ' +
        'present, roughly where they sit, and whether anything looks broken, black, untextured or ' +
        'misplaced. Only describe what you can SEE. If the image is empty or shows nothing but ' +
        'ground and sky, say exactly that.') + inventory;

    const verdict = await renderCheck.askVision(claudeCli, model, r.file, question);

    const caveat = r.mode === 'camera'
      ? '\n\n(camera route — no viewport post-processing, so emissive materials do not glow here; ' +
        'judge placement and materials from this, not final looks)'
      : '\n\n(viewport route — full post-processing)';
    return verdict + '\n\n→ ' + r.file + caveat;
  } catch (e) {
    return 'INSPECT_UNREAL_ERROR: ' + (e.message || String(e)) +
           '\nNothing was looked at. Do not describe the level.';
  }
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

  dbg.event('progress', { label: 'generate_prop', description, category: cat });

  // Run the full headless pipeline through the pipeline cancel wrapper (spawnPhoenixStage): it
  // registers the child so POST /stop can reach it, captures PHX_COMFY_PROMPT, and on timeout
  // cancels the ComfyUI job on the rig. A bare spawn here (the old code) left the GPU computing for
  // up to 20 min on a killed prop and made /stop report "nothing running".
  const res = await pipeline.spawnPhoenixStage(['--headless', description, '--cat', cat], 900000);

  if (!res.ok) {
    const tail = (res.stderr || res.stdout || '').trim().slice(0, 500);
    const how = res.timedOut ? `timed out (ComfyUI cancel: ${res.comfyui})` : `exit ${res.code !== undefined ? res.code : '?'}`;
    return `Pipeline failed (${how}):\n${tail}`;
  }

  const m = res.stdout.match(/RESULT_GLB:\s*(.+)/);
  if (m) {
    const glbPath = m[1].trim();
    const name = path.basename(glbPath);
    if (!state.staged) state.staged = [];
    if (!state.staged.includes(name)) state.staged.push(name);
    return `Generated and staged: ${name}. The asset is on disk in the staging folder and is not yet in the Blender scene — use import_asset with {"name": "${name}"} to import it when ready.`;
  }
  return res.stdout.trim() || 'Pipeline completed (no GLB path in output)';
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
      const _base = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8188';
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
      const _base = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8188';
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

// registry.json used to record the absolute path of the machine that saved the brush, which
// resolves to nothing anywhere else. save_brush.js now writes paths relative to brushes/lib;
// older absolute entries are still resolved here so existing registries keep working.
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
  const { name, object, collection, category, display, overwrite } = input;
  if (!name) return 'ERROR: name required';

  const argv = ['--name', name];
  if (collection) argv.push('--collection', collection);
  if (object)   argv.push('--object',   object);
  if (category) argv.push('--category', category);
  if (display)  argv.push('--display',  display);
  // Only on explicit intent: without it a colliding name is REFUSED rather than
  // silently overwriting an existing brush (see save_brush.js collision guard).
  if (overwrite === true) argv.push('--force');

  const r = await spawnNode(path.join(__dirname, 'save_brush.js'), argv, {
    // Longer than the 90 s the child allows its own Blender call: if the OUTER timeout fires
    // first, the child is killed between writing the .blend and registering it, leaving an
    // orphan library file the user can neither see nor place. Let the inner call fail first,
    // with a message that says what happened.
    timeoutMs: 120000, maxBuffer: 2 * 1024 * 1024,
  });

  if (r.error)    return `ERROR: ${r.error.message}`;
  if (r.code !== 0) return `ERROR (exit ${r.code}): ${(r.stderr || r.stdout || '').trim()}`;
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

  const r = await spawnNode(path.join(__dirname, 'use_brush.js'), argv, {
    // Longer than the 90 s the child allows its own Blender call: if the OUTER timeout fires
    // first, the child is killed between writing the .blend and registering it, leaving an
    // orphan library file the user can neither see nor place. Let the inner call fail first,
    // with a message that says what happened.
    timeoutMs: 120000, maxBuffer: 2 * 1024 * 1024,
  });

  if (r.error)    return `ERROR: ${r.error.message}`;
  if (r.code !== 0) return `ERROR (exit ${r.code}): ${(r.stderr || r.stdout || '').trim()}`;
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
    writeFileAtomic(REG, JSON.stringify(reg, null, 2));
    return 'Renamed brush to "' + reg.brushes[slug].display + '"';
  } catch (e) { return 'ERROR: ' + e.message; }
}

async function toolDeleteAsset(input) {
  const { category, name } = input || {};
  const CATS = Object.keys(palette.loadPalette().categories);
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
          writeFileAtomic(PY, src);
        }
      } catch (_) {}
    }
    delete reg.brushes[slug];
    writeFileAtomic(REG, JSON.stringify(reg, null, 2));
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

async function toolMakeHuman(input, _state, cfg) {
  return makeHuman(input || {}, cfg);
}

async function toolPlaceHuman(input, _state, cfg) {
  return placeHuman(input || {}, cfg);
}

async function toolAnimateHuman(input, _state, cfg) {
  return animateHuman(input || {}, cfg);
}

async function toolSequenceAnimations(input, _state, cfg) {
  return sequenceAnimations(input || {}, cfg);
}

async function toolSaveAnimation(input, _state, cfg) {
  return saveAnimation(input || {}, cfg);
}

async function toolAssignSkeleton(input, _state, cfg) {
  return customRig.assignSkeleton(input || {}, cfg);
}

async function toolSpawnRig(input, _state, cfg) {
  return customRig.spawnRig(input || {}, cfg);
}

async function toolSaveClip(input, _state, cfg) {
  return customRig.saveClip(input || {}, cfg);
}

async function toolAnimateClip(input, _state, cfg) {
  return customRig.animateClip(input || {}, cfg);
}

// Chain several of a folder's clips (or append one to what is already there). Same seam
// machinery as sequence_animations — see custom_rig.js sequenceClips().
async function toolSequenceClips(input, _state, cfg) {
  return customRig.sequenceClips(input || {}, cfg);
}

async function toolSaveMesh(input, _state, cfg) {
  return customRig.saveMesh(input || {}, cfg);
}

// "Rig ans Mesh", the two halves: prepare a bare mesh (join + optional voxel remesh), then
// bind it to the folder's skeleton with automatic weights + a measured verify. Two calls, not
// one, because the bone alignment in between is the user's — see custom_rig.js.
async function toolPrepareMesh(input, _state, cfg) {
  return customRig.prepareMesh(input || {}, cfg);
}

async function toolBindMesh(input, _state, cfg) {
  return customRig.bindMesh(input || {}, cfg);
}

// Save/spawn a finished Mixamo-rigged character ("skin"). No clip library of its own —
// the Human tab's animations/ pool already fits every mixamorig: skeleton. See characters.js.
async function toolSaveCharacter(input, _state, cfg) {
  return characterLib.saveCharacter(input || {}, cfg);
}

async function toolSpawnCharacter(input, _state, cfg) {
  return characterLib.spawnCharacter(input || {}, cfg);
}

// Text -> motion -> straight onto the character. Generation runs in ComfyUI (~230 s for
// 6 s of motion); the clip is kept in animations/ so it can be reused without paying for
// it twice. apply:false stops after generating.
// The work itself, independent of who asked for it. takeLock says whether THIS function owns the
// Blender lock for the apply step — the three callers differ, see toolHyMotion below.
async function runHyMotion(inp, cfg, takeLock) {
  // Generation runs in ComfyUI and touches no Blender.
  const gen = await generateMotion(inp, cfg);
  if (gen.error) return 'ERROR: ' + gen.error;
  // gen.note carries anything the generator had to change about the request (currently: a
  // duration clamped to the model's 12 s ceiling). Surfacing it beats letting the user wonder
  // why the clip is shorter than what they typed.
  const made = `Generated "${gen.file}" from your description — ${gen.seconds}s of generation.` +
               (gen.note ? ` Note: ${gen.note}.` : '');
  if (inp.apply === false) return made + ' Not applied (apply:false).';
  // Applying DOES touch Blender — seconds, not minutes.
  if (takeLock) await lock.acquire();
  try {
    const applied = await animateHuman({ fbx: gen.file, character: inp.character }, cfg);
    return made + '\n' + applied;
  } finally {
    if (takeLock) lock.release();
  }
}

// Three callers, three different lock situations — that is what the branch below is for.
//
//   /chat    sets holdsLock:true and holds the Blender lock for the WHOLE turn. Awaiting the ~230 s
//            generation here froze Blender for four minutes (measured 2026-07-28). So the work moves
//            into a background job: the turn returns immediately, /chat's finally releases the lock,
//            and the job takes it itself only for the seconds-long apply step.
//            ⭐ This cannot reproduce the old SELF-DEADLOCK — that one happened because /chat was
//            AWAITING this call while holding the lock, so the waiter could never be resolved. A
//            detached job is not awaited by anyone: if it reaches lock.acquire() first, it simply
//            waits for a lock that WILL be released.
//            The outcome travels back via opts.onNote, because a job's return value reaches only the
//            debug log — without it the user would never learn how the four minutes ended.
//   /action  defers the lock precisely so this tool can take it late, and it broadcasts our return
//            value. Awaiting is correct there; making it a job would replace the real result with
//            "started #N" and lose it.
//   CLI      no opts at all — plain synchronous run.
async function toolHyMotion(input, _state, cfg, opts = {}) {
  const inp = input || {};

  if (opts.holdsLock && typeof opts.onNote === 'function') {
    const started = jobs.start({ kind: 'motion', label: inp.description || 'text→motion' }, async () => {
      let text;
      try {
        text = await runHyMotion(inp, cfg, true);
      } catch (e) {
        text = 'ERROR: ' + ((e && e.message) || e);
      }
      try { opts.onNote(text); } catch (_) { /* a broadcast must never break the job */ }
      return text;
    });
    if (!started.started) return started.reason;
    return 'Started text→motion as background job #' + started.id + '. It takes about four minutes — ' +
           'Blender stays usable meanwhile, and I will report here as soon as the clip is applied.';
  }

  // Fallback covers /action, the CLI, and any /chat caller without onNote: keep the old behaviour,
  // including not re-acquiring a lock the caller already holds.
  return runHyMotion(inp, cfg, !opts.holdsLock);
}

// inspect_render — render the CURRENT scene and get a vision verdict, so the
// orchestrator can SEE a result instead of guessing (the gap behind blind
// "fixed ✓" claims). Non-destructive: render_check saves/restores the user's
// render settings. The render lands in output/render-check.png; server.js
// surfaces it in the Image tab (mtime-guarded broadcast, like make_human).
async function toolInspectRender(input, _state, cfg) {
  const q = (input && typeof input.question === 'string' && input.question.trim())
    ? input.question.trim() : undefined;
  const outAbs = path.join(__dirname, 'output', 'render-check.png');
  const model = visionModel(cfg);   // own seat — the judge is not the orchestrator
  try {
    const r = await renderCheck.checkRender({ blenderIpc, claudeCli }, { outAbs, model, question: q, cfg });
    return r.verdict + '\n\n(frame ' + r.frame + ')  → output/render-check.png';
  } catch (e) {
    return 'inspect_render could not complete: ' + (e.message || String(e)) +
      ' — is Blender open with the Phoenix IPC addon enabled?';
  }
}

const TOOLS = {
  generate_image: toolGenerateImage,
  make_human:     toolMakeHuman,
  place_human:    toolPlaceHuman,
  animate_human:  toolAnimateHuman,
  sequence_animations: toolSequenceAnimations,
  save_animation: toolSaveAnimation,
  assign_skeleton: toolAssignSkeleton,
  spawn_rig:      toolSpawnRig,
  save_clip:      toolSaveClip,
  animate_clip:   toolAnimateClip,
  sequence_clips: toolSequenceClips,
  save_mesh:      toolSaveMesh,
  prepare_mesh:   toolPrepareMesh,
  bind_mesh:      toolBindMesh,
  save_character:  toolSaveCharacter,
  spawn_character: toolSpawnCharacter,
  hy_motion:      toolHyMotion,
  image_to_3d:    toolImageTo3d,
  generate_prop:  toolGenerateProp,
  blender_run:    toolBlenderRun,
  unreal_run:     toolUnrealRun,
  brush_to_unreal: toolBrushToUnreal,
  unreal_to_blender: toolUnrealToBlender,
  unreal_to_brush: toolUnrealToBrush,
  character_to_unreal: toolCharacterToUnreal,
  brush_preview:   toolBrushPreview,
  inspect_unreal:  toolInspectUnreal,
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
  inspect_render: toolInspectRender,
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
  // buildSystemPrompt(), not the startup snapshot — picks up palette categories added since boot
  const base = buildSystemPrompt();
  const systemPrompt = extraSystem ? (base + '\n\n' + extraSystem) : base;

  const _t = Date.now();
  // Prompt text (system + userMsg) must never be a command-line arg — see claude-cli.js.
  return claudeCli.runStream(model, systemPrompt, userMsg, { extraFlags: ['--tools', '', '--strict-mcp-config'], timeout: 300000 })
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

// ─── Render-vision gate ───────────────────────────────────────────────────────
// Which tool results get an automatic look at the scene. Three modes, set in
// Settings → Approval gates (cfg.gates.vision):
//   'off'      never fires; inspect_render stays available on request
//   'focused'  the expensive/error-prone actions only (default)
//   'full'     every step that can change what the scene looks like
//
// ⚠ The gate is DELIBERATELY not a tool call. It runs as plain code after the
// action, so (a) a model that "forgot" to look cannot skip it — the protection
// is code, not a request — and (b) it does not consume the turn's
// MAX_TOOL_CALLS budget (3). Cost is one separate claude-CLI call carrying the
// image; the picture never enters the orchestrator's own context, only the verdict.
const VISION_GATE_FOCUSED = [
  'animate_human', 'sequence_animations', 'animate_clip', 'sequence_clips',
  'prepare_mesh', 'bind_mesh', 'use_brush', 'spawn_rig', 'spawn_character',
];
// generate_prop und image_to_3d stehen bewusst NICHT hier: generate_prop legt nur eine
// GLB in staging/ ab ("not yet in the Blender scene"), und image_to_3d kehrt im
// Hintergrundmodus sofort mit "🚀 Started …" zurueck, waehrend die Erzeugung noch
// minutenlang laeuft. Der Gate haette in beiden Faellen die UNVERAENDERTE Szene
// gerendert und das Urteil als Beleg fuer die Aktion ausgegeben — also genau die
// Sorte Falschaussage, gegen die er gebaut wurde.
const VISION_GATE_FULL = VISION_GATE_FOCUSED.concat([
  'make_human', 'place_human', 'import_asset', 'apply_material', 'blender_run',
]);

// Ein Werkzeug meldet Misserfolg (oder "faengt gerade erst an") in mehr Formen als ein
// blosses "ERROR". Wer hier eine Form vergisst, laesst den Gate eine Szene beurteilen,
// die die Aktion nie angefasst hat — und verkauft das Ergebnis als Beweis.
// Gemessen an den echten Rueckgaben: BLENDER_ERROR (toolBlenderRun), "Pipeline failed"
// (generate_prop), "⚠️ Can't generate yet" (fehlende Modelle), "🚀 Started …"
// (Hintergrundjob laeuft noch), "inspect_render could not complete".
function toolResultIsNoEvidence(result) {
  if (typeof result !== 'string') return false;
  return /^(ERROR|PYTHON_ERROR|BLENDER_ERROR|REJECTED|Pipeline failed|inspect_render could not complete)/.test(result)
      || result.startsWith('⚠️')
      || result.startsWith('🚀');
}

// Which model actually LOOKS at the render. This is a JUDGE, not an orchestrator —
// it is the only thing in Phoenix that can contradict a "fixed ✓" claim. It therefore
// gets its OWN seat: before this, render_check took cfg.seats.orchestrator.model, so
// swapping the orchestrator for speed or cost silently swapped the judge with it (found
// 2026-07-25 while wiring the gate). Falls back to the orchestrator only when no vision
// seat is configured, so an old config keeps working unchanged.
function visionModel(cfg) {
  const seats = (cfg && cfg.seats) || {};
  return (seats.vision && seats.vision.model)
      || (seats.orchestrator && seats.orchestrator.model)
      || 'claude-opus-4-8';
}

let _visionModeWarned = false;
function visionGateMode(cfg) {
  const v = cfg && cfg.gates && cfg.gates.vision;
  if (v === 'off' || v === 'focused' || v === 'full') return v;
  // Die Route /config prueft den Wert, eine handgeschriebene Config nicht. Und der
  // Rueckfall geht Richtung "an" — ein Tippfehler kostet also Renders und Vision-Calls,
  // statt folgenlos zu bleiben. Deshalb einmal laut sagen, was passiert ist.
  if (v !== undefined && !_visionModeWarned) {
    _visionModeWarned = true;
    console.warn('  ⚠ gates.vision = ' + JSON.stringify(v) + ' is not one of off|focused|full — using "focused".');
  }
  return 'focused';
}

function visionGateFires(cfg, toolName) {
  const mode = visionGateMode(cfg);
  if (mode === 'off') return false;
  if (toolName === 'inspect_render') return false;   // it just looked — don't render twice
  return (mode === 'full' ? VISION_GATE_FULL : VISION_GATE_FOCUSED).includes(toolName);
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
    const toolStart = Date.now();   // Stichzeit für die mtime-Wache des Bild-Broadcasts
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

    // ── Render-vision gate ────────────────────────────────────────────────────
    // Look at what the action actually produced BEFORE the model gets a chance to
    // claim it worked. Never fires on a failed tool (the scene isn't in the state
    // the action intended, so the render would judge the wrong thing), and a broken
    // gate never kills the turn — it says "could not look" instead of going quiet.
    const noEvidence = toolResultIsNoEvidence(toolResult);
    const RENDER_CHECK_REL = 'output/render-check.png';
    const renderCheckAbs = path.join(__dirname, 'output', 'render-check.png');

    // Zeigt den Render nur, wenn er von DIESEM Aufruf stammt. Ohne die Prüfung wirft
    // ein fehlgeschlagener Lauf das ALTE Bild in den Image-Tab, als wäre es das neue —
    // die /action-Route hat diese Wache schon immer, dem Chat-Pfad fehlte sie.
    const broadcastIfFresh = (since) => {
      if (typeof opts.onArtifact !== 'function') return;
      try {
        if (fs.statSync(renderCheckAbs).mtimeMs >= since - 1000) {
          opts.onArtifact({ slot: 'image', rel: RENDER_CHECK_REL });
        }
      } catch (_) { /* keine Datei = nichts zu zeigen */ }
    };

    let gateNote = '';
    if (!noEvidence && visionGateFires(cfg, toolCall.name)) {
      const gateModel = visionModel(cfg);   // own seat — see visionModel()
      const gateStart = Date.now();
      dbg.event('progress', { label: 'vision-gate', name: toolCall.name, phase: 'start' });
      try {
        const r = await renderCheck.checkRender({ blenderIpc, claudeCli }, {
          outAbs: renderCheckAbs, model: gateModel, cfg,
          // Eigene, KURZE Frist: der Standardwert von render_check ist 600 s, und der
          // Chat-Turn hält währenddessen das globale Lock — ein hängendes Blender würde
          // Phoenix sonst minutenlang auf 409-busy nageln. Ein Blick, der zwei Minuten
          // braucht, ist ohnehin ein gescheiterter Blick.
          timeoutMs: 120000, visionTimeout: 120000,
          question: 'The action just performed was: ' + toolCall.name +
                    '. Does the scene look correct and undamaged after it?',
        });
        gateNote = '\n\nRENDER GATE (automatic — the render was taken FOR you, you did not call it):\n' +
                   r.verdict + '\n(frame ' + r.frame + ')  → ' + RENDER_CHECK_REL + '\n' +
                   'This is evidence about the CURRENT scene. Do NOT claim a visual result the render contradicts.';
        broadcastIfFresh(gateStart);
        dbg.event('progress', { label: 'vision-gate', name: toolCall.name, phase: 'done' });
      } catch (e) {
        gateNote = '\n\nRENDER GATE: could not look at the scene (' + (e.message || String(e)) +
                   '). Do not assume the result is fine — tell the user you could not verify it visually.';
        dbg.event('progress', { label: 'vision-gate', name: toolCall.name, phase: 'error' });
      }
    }
    // A model-invoked inspect_render belongs in the Image tab too. The /action route
    // broadcast it, the chat path never did — which is why the render stayed invisible
    // even though it had been taken (live-test finding 2026-07-25).
    if (!noEvidence && toolCall.name === 'inspect_render') broadcastIfFresh(toolStart);
    // Same for the Unreal render — a picture nobody sees is a claim, not evidence. Its own file,
    // so the freshness check cannot pass off a stale Blender render as the Unreal one.
    if (!noEvidence && toolCall.name === 'inspect_unreal') {
      const UNREAL_CHECK_REL = 'output/unreal-check.png';
      if (typeof opts.onArtifact === 'function') {
        try {
          if (fs.statSync(path.join(__dirname, UNREAL_CHECK_REL)).mtimeMs >= toolStart - 1000) {
            opts.onArtifact({ slot: 'image', rel: UNREAL_CHECK_REL });
          }
        } catch (_) { /* vision off or nothing written — nothing to show */ }
      }
    }

    // Feed result back into messages
    // The hint after the result nudges Claude to reply in text if the answer is complete,
    // while still allowing it to chain tools when a follow-up action is genuinely needed.
    const assistantMsg = { role: 'assistant', content: raw };
    const resultMsg    = {
      role: 'user',
      content: `TOOL_RESULT [${toolCall.name}]:\n${toolResult}${gateNote}\n\nIf this answers the user's question, reply in plain text now. Only emit another TOOL block if a follow-up action is strictly required.`,
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
- probe_unreal          Tests whether a running Unreal Editor answers (editor open + Python plugin + remote execution enabled). Returns the engine version and the open project. INPUT: {}
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
  const comfyuiEndpoint = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8188';
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

function tsProbeUnreal() {
  // Spiegel zu probe_blender_socket: sagt, OB ein Editor antwortet - und wenn nicht,
  // nennt die Bruecke selbst alle vier moeglichen Ursachen.
  return unrealIpc.probeUnreal({ cfg: loadConfig() });
}

function tsProbeBlenderSocket() {
  // File-based liveness probe (was a 9876 socket connect). Sends a no-op to the addon.
  // No cfg in scope here; probes the default IPC dir (matches the zero-config setup).
  return blenderIpc.probeBlender(null, 3000);
}

async function tsCheckWorkflowDeps() {
  const cfg  = loadConfig();
  const base = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8188';

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
// Slugs stay bare (no slashes, no ..) so this can never read outside the library. Most rows in
// INDEX.md point at entries/<slug>.md, but an umbrella document may live at the troubleshooting
// root — linux-troubleshoot.md does. Without the second lookup that row was unreachable: the
// matcher found no `entries/` link, and a direct {"entry":"linux-troubleshoot"} answered "No entry",
// so the whole Linux install recipe was invisible to the feature meant to serve it.
function tsReadEntry(slug)  {
  if (/[\\/]|\.\./.test(slug)) return null;
  for (const f of [path.join(TROUBLESHOOTING_DIR, 'entries', slug + '.md'),
                   path.join(TROUBLESHOOTING_DIR, slug + '.md')]) {
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return null;
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
      const hay = symptom.toLowerCase();
      // The original test was row.includes(symptom): it required the user's ENTIRE paste to sit
      // inside one index row. That works for a bare "No module named 'sqlalchemy'" and fails for
      // every realistic paste — an error line with the console noise around it, or the same
      // problem in the user's own words. Since the troubleshooter gets one tool call per turn,
      // each miss burned that call on the raw index and left the model answering without the entry.
      //
      // Exact phrases do not survive a real paste either: the index keys are phrases
      // ("shoulders rolled forward, forearms bent in front of the chest") and nobody types them
      // verbatim. So the row is SCORED instead:
      //   * a backticked literal (an error string) found in the paste is decisive — weight 5
      //   * otherwise count distinctive words the row and the paste share
      // and the best row above the threshold wins. Whole-row containment stays as a fallback so
      // the previous behaviour is never worse.
      const STOP = new Set(['while','after','before','with','without','their','there','which','that',
        'this','from','into','when','then','than','does','done','have','been','being','about','still',
        'never','always','every','phoenix','blender','comfyui']);
      const rowKeys = line => (line.split('|')[1] || '');
      const literals = cell => [...cell.matchAll(/`([^`]{6,})`/g)].map(m => m[1].toLowerCase());
      const words = cell => [...new Set(cell.replace(/`[^`]*`/g, ' ').toLowerCase()
        .split(/[^a-z0-9']+/).filter(w => w.length >= 5 && !STOP.has(w)))];

      let best = null, bestScore = 0;
      for (const line of idx.split(/\r?\n/)) {
        if (!line.includes('|')) continue;
        const cell = rowKeys(line);
        let score = 0;
        for (const lit of literals(cell)) if (hay.includes(lit)) score += 5;
        for (const w of words(cell)) if (hay.includes(w)) score += 1;
        if (line.toLowerCase().includes(hay)) score += 5;          // the original test, as a signal
        if (score > bestScore) { bestScore = score; best = line; }
      }
      // Three shared distinctive words is enough to beat coincidence; one literal error string
      // is enough on its own. Below that, hand back the index rather than a confident wrong entry.
      if (best && bestScore >= 3) {
        // Accept both `entries/<slug>.md` rows and root-level umbrella docs like
        // `linux-troubleshoot.md` — tsReadEntry looks in both places.
        const m = best.match(/`(?:entries\/)?([a-z0-9-]+)\.md`/);
        if (m) { const c = tsReadEntry(m[1]); if (c) return 'Matched trap: ' + m[1] + '\n\n' + c; }
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
  probe_unreal:         tsProbeUnreal,
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
  return claudeCli.runStream(model, systemPrompt, userMsg, { extraFlags: ['--tools', '', '--strict-mcp-config'], timeout: 300000 })
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
  const base = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8188';
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
  const comfyBase  = (cfg.endpoints && cfg.endpoints.comfyui) || 'http://localhost:8188';
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

module.exports = { runTurn, callClaude, callBlender, loadConfig, saveConfig, ensureConfig, loadHistory, saveHistory, loadState, saveState, loadSceneCache, saveSceneCache, listStagedFiles, listBrushesData, listMaterialsData, loadLibraryLabels, TOOLS, SYSTEM_PROMPT, buildSystemPrompt, tsTailDebugLog, runTroubleshootTurn, draftPaletteCategory, inferWorkflowMap, claudeCliCheck, onboardingStatus, listLmStudioModels };
