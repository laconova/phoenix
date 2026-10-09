#!/usr/bin/env node
'use strict';

// phoenix-mcp.js — Phoenix as a tool for Claude Code / Codex / Cursor (v1.9 M6, full palette since M6.1).
//
// A stdio MCP server (newline-delimited JSON-RPC 2.0). It is a thin bridge: every tools/call becomes ONE request to
// the running Phoenix (POST /mcp/call) — the external agent is the brain, Phoenix's own orchestrator is not involved.
// Node stdlib only. NOTHING but JSON-RPC lines may go to stdout (the client parses it) — logs go to stderr.
//
// Setup:  claude mcp add phoenix -- node "<abs>/phoenix-mcp.js"      (Phoenix must be running)
// Env:    PHOENIX_URL (default http://127.0.0.1:7777)

const http = require('http');
const readline = require('readline');

const VERSION = '1.9.0';
const PHOENIX_URL = process.env.PHOENIX_URL || 'http://127.0.0.1:7777';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const NOT_RUNNING = 'Phoenix is not running — start it (server.bat on Windows, or node server.js) and try again.';

const log = (...a) => { try { process.stderr.write('[phoenix-mcp] ' + a.join(' ') + '\n'); } catch (_) { /* stderr gone */ } };
const send = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };

// ─── tool catalogue ───────────────────────────────────────────────────────────
// M6.1: every Phoenix tool except i2i_edit (a UI-only decision). The classes and the opt-ins mirror server.js MCP_CLASS /
// MCP_OPTIN; the tools below go through POST /mcp/call, the R-client ones (list_animations, list_custom_rigs,
// list_characters, job_status, stop) are answered with plain GET/POST routes and never reach /mcp/call.

const AUTO = ' Runs in Auto (no approval gates) and, for steps that change the scene, is followed by Phoenix\'s render check.';
const HEAVY = ' Takes several minutes and holds the GPU — only one heavy job at a time. If your client times out, Phoenix keeps working: check with job_status / list_assets.';
const UNREAL = ' Needs a running Unreal Editor with the Phoenix bridge; Blender-side changes are checkpointed.';
const PERMANENT = ' Permanent — not undone by a checkpoint. Only listed when the user enabled deleting over MCP in Phoenix Settings → Connections.';
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const unit = (description) => ({ type: 'number', minimum: 0, maximum: 1, description });
const tool = (name, description, properties, required) =>
  ({ name, description, inputSchema: Object.assign({ type: 'object', properties: properties || {} }, required && required.length ? { required } : {}) });

const TOOLS = [
  // ── generate (H) ──
  tool('generate_prop', 'Generate a 3D prop from a text description (image, then mesh) in ONE shot and stage the GLB in Phoenix\'s library. Does not import it into the scene — call import_asset next.' + AUTO + HEAVY,
    { description: str('what the prop is, e.g. "a small wooden barrel"'), category: str('palette category, e.g. item | furniture | sci_fi (default item)') }, ['description']),
  tool('generate_image', 'Generate an image (the first stage of the image-to-3D pipeline) from a description, using Phoenix\'s style palette. Optional exact prompt/negative bypass the metaprompter. Stops at the image: it lands in Phoenix\'s Image tab, where the user can turn it into 3D; generate_prop makes a new prop from text in one go.' + AUTO + HEAVY,
    { description: str('what the image shows'), category: str('palette category (default item)'), prompt: str('exact positive prompt (optional)'), negative: str('exact negative prompt (optional)') }, ['description']),
  tool('image_to_3d', 'Turn an image into a 3D mesh (runs the mesh stage, then imports it into the Blender scene unless a mesh approval gate stops it). With no `image` it uses the last image generate_image made in this Phoenix session. A checkpoint is taken right before the import.' + AUTO + HEAVY,
    { image: str('path of the image (optional — omitted = the last image generate_image made in this Phoenix session)'), description: str('what the image shows (optional)'), category: str('palette category (optional)'), target_face_num: num('regenerate the mesh at this face count, e.g. 7500 (optional)') }),
  tool('hy_motion', 'Generate an animation FROM A TEXT DESCRIPTION (HY-Motion) and apply it to a character built with make_human rig:"mixamo". Use it when the motion is not already a clip — the generated clip is saved in Phoenix\'s animation library and then shows up in list_animations for reuse (animate_human / sequence_animations take clip names from list_animations). Synchronous: the call returns when the clip is applied (about 4 minutes). A checkpoint of the open scene is taken first.' + AUTO + HEAVY,
    { prompt: str('English description of the MOTION, not the character, e.g. "a person walks forward and looks around"'), duration: num('seconds of motion, 1-12 (default 6)'), cfg: num('guidance scale 1-15 (optional — default is tuned, only change it for a stiffer or looser motion)'), seed: num('integer seed for a repeatable result (optional)'), apply: bool('false = only generate the clip, do not apply it (default true)'), character: str('target character name (optional — default: the mixamo-rigged character in the scene)') }, ['prompt']),

  // ── scene (S) ──
  tool('inspect_render', 'Render the current Blender scene (EEVEE, non-destructive) and return a vision verdict (PASS/FAIL and what is visibly wrong) plus the render image. Use it to SEE a result instead of guessing.',
    { question: str('a specific thing to check (optional)') }),
  tool('import_asset', 'Import a staged GLB file into the live Blender scene. A checkpoint of the open scene is taken first.' + AUTO,
    { name: str('file name from list_assets, e.g. barrel.glb'), cleanup: bool('import with auto-smooth shading (default false = raw mesh)') }, ['name']),
  tool('use_brush', 'Place a brush from the library into the Blender scene at optional coordinates (slug from list_brushes). A checkpoint is taken first.' + AUTO,
    { name: str('brush slug from list_brushes'), x: num('x position'), y: num('y position'), z: num('z position'), instance_name: str('optional name for the placed instance') }, ['name']),
  tool('apply_material', 'Apply a material from the shared material palette (name from list_materials) to the mesh objects currently SELECTED in Blender. A checkpoint is taken first.' + AUTO,
    { name: str('material name from list_materials') }, ['name']),
  tool('brush_preview', 'Build (or reuse) the cached GLB of a brush so it can be previewed (slug from list_brushes). The first time per brush it briefly places the brush in the open Blender scene to export it, so a checkpoint is taken first; afterwards it is served from the cache.' + AUTO,
    { name: str('brush slug from list_brushes') }, ['name']),

  // ── humans & animation (S) ──
  tool('make_human', 'Create a parametric MakeHuman character (MPFB2) in the Blender scene with a skin and body parts. Sliders are 0..1 and optional (omitted = 0.5 neutral). Use rig:"mixamo" if you will animate it with animate_human / sequence_animations / hy_motion. Characters spawn without clothes unless `clothes` is given. A checkpoint is taken first.' + AUTO,
    { gender: unit('0 = female .. 1 = male'), age: unit('0 = young .. 1 = old'), muscle: unit('0..1'), weight: unit('0..1'), height: unit('0 = short .. 1 = tall'), proportions: unit('0..1'), cupsize: unit('0..1'), firmness: unit('0..1'),
      race: { type: 'object', description: 'blend of ethnic sliders, each 0..1', properties: { asian: unit('0..1'), caucasian: unit('0..1'), african: unit('0..1') } },
      rig: { type: 'string', enum: ['none', 'default', 'mixamo'], description: 'skeleton to add: "none" (default) | "default" | "mixamo" (needed to animate it)' },
      name: str('object name (optional)'), skin: { description: 'false = procedural skin (no assets), or a skin asset name', oneOf: [{ type: 'boolean', enum: [false] }, { type: 'string' }] },
      eyes: bool('default true'), teeth: bool('default true'), eyebrows: bool('default true'), eyelashes: bool('default true'), eyeColor: str('brown | blue | green | grey | ...'),
      hair: { description: 'true = default style, or a style name such as short01 | long01 | afro01 | bob01 | ponytail01 | braid01', oneOf: [{ type: 'boolean' }, { type: 'string' }] },
      clothes: { description: 'one clothes asset name or a list, e.g. "male_casualsuit01"', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      targets: { type: 'object', description: 'MakeHuman detail targets, e.g. {"nose/nose-scale-horiz-more": 0.7}', additionalProperties: { type: 'number' } },
      staged: bool('true = build hidden in a staging collection (then call place_human) instead of dropping it into the scene') }),
  tool('place_human', 'Commit the currently staged human (a make_human call with staged:true) into the scene at the origin, visible. A checkpoint is taken first.' + AUTO, {}),
  tool('animate_human', 'Apply a Mixamo FBX animation to a character built with make_human rig:"mixamo": retargets and bakes it onto the character and sets the frame range. Clip names come from list_animations. A checkpoint is taken first.' + AUTO,
    { fbx: str('clip file name from list_animations, e.g. "Low Crawl.fbx"'), character: str('target character name (optional — default: the mixamo-rigged character in the scene)') }, ['fbx']),
  tool('sequence_animations', 'Chain several Mixamo clips (names from list_animations) onto a rig:"mixamo" character as blended NLA strips, each starting where the previous one ended (no snap-back, no foot sliding). A checkpoint is taken first.' + AUTO,
    { fbxs: { type: 'array', items: { type: 'string' }, description: 'ordered clip file names from list_animations' }, blend: num('crossfade frames (default 8)'), speed: num('extra forward drift in metres/frame — leave 0 unless a genuine Mixamo "In Place" clip needs it'), append: bool('true = add to the END of the existing sequence instead of rebuilding'), character: str('target character name (optional)') }, ['fbxs']),
  tool('save_animation', 'Save the animation currently on a rig:"mixamo" character (hand-keyed, or a built sequence) as a reusable FBX clip in Phoenix\'s animation library; it then shows up in list_animations. Refuses an existing name.',
    { name: str('file name to save under'), character: str('source character name (optional — default: the mixamo-rigged character in the scene)') }, ['name']),

  // ── custom rigs (folder from list_custom_rigs) ──
  tool('assign_skeleton', 'Store the selected armature of the open scene as the skeleton of a custom-rig folder (folder from list_custom_rigs; re-assigning replaces it and may invalidate that folder\'s variants/clips). Writes files only; the mode/selection of the open scene may change. Overwriting needs "Allow deleting library files" in Phoenix Settings → Connections.',
    { folder: str('custom-rig folder name from list_custom_rigs') }, ['folder']),
  tool('spawn_rig', 'Spawn a custom-rig folder\'s bare skeleton, or one of its saved mesh variants, into the Blender scene (folder from list_custom_rigs). A checkpoint is taken first.' + AUTO,
    { folder: str('custom-rig folder name from list_custom_rigs'), variant: str('mesh variant name; omitted or "rig" = the bare skeleton') }, ['folder']),
  tool('save_clip', 'Save the animation on the selected rig as a clip in a custom-rig folder (folder from list_custom_rigs); the rig must match the folder\'s skeleton. Refuses an existing name.',
    { folder: str('custom-rig folder name from list_custom_rigs'), name: str('clip name') }, ['folder', 'name']),
  tool('animate_clip', 'Apply one of a custom-rig folder\'s saved clips to the rig in the scene (folder from list_custom_rigs; clip names are listed there). A checkpoint is taken first.' + AUTO,
    { folder: str('custom-rig folder name from list_custom_rigs'), clip: str('clip name saved in that folder') }, ['folder', 'clip']),
  tool('sequence_clips', 'Chain several of a custom-rig folder\'s clips onto the rig in the scene as blended NLA strips, or append to the existing sequence (folder from list_custom_rigs). A checkpoint is taken first.' + AUTO,
    { folder: str('custom-rig folder name from list_custom_rigs'), clips: { type: 'array', items: { type: 'string' }, description: 'ordered clip names saved in that folder' }, blend: num('crossfade frames (default 8)'), append: bool('true = add to the END of the existing sequence') }, ['folder', 'clips']),
  tool('prepare_mesh', 'Prepare a bare mesh for binding to a custom-rig folder\'s skeleton: join the meshes and (by default) voxel-remesh (folder from list_custom_rigs). Then check the rig sits inside the mesh and call bind_mesh. A checkpoint is taken first.' + AUTO,
    { folder: str('custom-rig folder name from list_custom_rigs'), voxel: num('voxel size (optional — default: derived from the mesh size)'), remesh: bool('false = skip the voxel remesh (default true)') }, ['folder']),
  tool('bind_mesh', 'Bind the selected mesh to a custom-rig folder\'s skeleton with automatic weights and report how much of it is weighted (folder from list_custom_rigs). A checkpoint is taken first.' + AUTO,
    { folder: str('custom-rig folder name from list_custom_rigs') }, ['folder']),
  tool('save_mesh', 'Save the rigged mesh (and its armature) in the scene as a spawnable variant of a custom-rig folder (folder from list_custom_rigs); the armature must match the folder\'s skeleton. Refuses an existing name.',
    { folder: str('custom-rig folder name from list_custom_rigs'), name: str('variant name') }, ['folder', 'name']),

  // ── characters (name from list_characters) ──
  tool('save_character', 'Save the Mixamo-rigged character in the scene (body, hair, clothes) as a reusable character in Phoenix\'s library. Refuses an existing name unless overwrite is true. Overwriting needs "Allow deleting library files" in Phoenix Settings → Connections.',
    { name: str('character name'), overwrite: bool('true = replace an existing character of that name (default false)') }, ['name']),
  tool('spawn_character', 'Spawn a saved character (name from list_characters) into the Blender scene with its rig selected; every clip in list_animations works on it. A checkpoint is taken first.' + AUTO,
    { name: str('character name from list_characters') }, ['name']),

  // ── library & state (R) ──
  tool('read_state', 'Read Phoenix\'s session state: scene objects at the last sync (may be stale), staged GLB files, the last completed task.', {}),
  tool('list_assets', 'List the staged GLB files on disk (ready to import; not necessarily in the Blender scene).', {}),
  tool('list_brushes', 'List the brush library (reusable placeable assets). Filter by category or search by name rather than listing everything.',
    { category: str('item | furniture | sci_fi | ...'), search: str('keyword') }),
  tool('read_palette', 'Return the current style palette: each category\'s style text and parameters. Use it to choose a category for generate_prop / generate_image.', {}),
  tool('list_materials', 'List the shared material palette (reusable materials that brushes share) — names for apply_material. Not the style palette (read_palette).', {}),
  // ── library & state (L) ──
  tool('save_as_brush', 'Save Blender mesh(es) as ONE reusable brush. With neither collection nor object, all currently selected meshes are saved. A colliding name is REFUSED with a suggested free name — only set overwrite:true when the user explicitly wants to replace that brush. Overwriting needs "Allow deleting library files" in Phoenix Settings → Connections.',
    { name: str('brush slug'), collection: str('save ALL meshes of this collection (optional)'), object: str('save this single object (optional)'), category: str('item | sci_fi | ... (optional)'), display: str('human label (optional)'), overwrite: bool('replace an existing brush of that name (default false)') }, ['name']),
  tool('rename_asset', 'Set (or clear, with an empty label) the display label of a staged asset in the library. The file itself is not renamed.',
    { category: str('palette category of the asset'), name: str('file name from list_assets, e.g. barrel.glb'), label: str('new display label; empty string clears it') }, ['category', 'name']),
  tool('remesh_asset', 'Rebuild the topology of a STAGED GLB through Meshy (PAID cloud service): it UPLOADS the mesh to Meshy and spends Meshy credits (about 5 per remesh). Writes the result as a NEW staged file next to the original (the original stays; textures are re-baked; Meshy normalises the size, so check the scale after import). Takes about 1.5 minutes. Only works when the user enabled it in Phoenix Settings → Connections and stored a Meshy API key; does not hold the GPU or the Blender lock, one remesh at a time. Not in the scene — call import_asset next.',
    { name: str('file name from list_assets, e.g. barrel.glb'), category: str('palette category of the asset (optional — needed only when the name exists in several)'), topology: { enum: ['quad', 'triangle'], description: '"quad" (default: your last choice in the Library dialog) or "triangle"' }, target_polycount: num('target face count, 100-300000 (default: your last choice in the Library dialog, 20000)') }, ['name']),
  tool('rename_brush', 'Change the display name of a brush (slug from list_brushes). The slug stays the same.',
    { slug: str('brush slug from list_brushes'), display: str('new display name') }, ['slug', 'display']),

  // ── Unreal (U) ──
  tool('brush_to_unreal', 'Carry a brush (slug from list_brushes) into Unreal as a placed actor tree with hierarchy and transforms intact. Blender is only needed the first time per brush; afterwards a cached GLB is used. Fails rather than shipping a material that would render black.' + UNREAL,
    { name: str('brush slug from list_brushes'), unreal_path: str('content folder, default /Game/PhoenixBrushes'), refresh: bool('rebuild the cached GLB'), keep_in_blender: bool('leave the placed objects in the Blender scene') }, ['name']),
  tool('unreal_to_blender', 'Pull an existing Unreal asset (StaticMesh, SkeletalMesh or AnimSequence) into the Blender scene; a SkeletalMesh arrives with its armature and weights. A material named WorldGridMaterial means the source had an empty material slot.' + UNREAL,
    { asset: str('Unreal asset path, e.g. /Game/MHExport/spudermin_Body'), refresh: bool('re-export instead of using the cached GLB'), export_only: bool('write the GLB and stop, do not touch Blender') }, ['asset']),
  tool('unreal_to_brush', 'Fetch an Unreal asset into Blender and save it into the brush library, so it can be placed anywhere afterwards with use_brush. Refuses a rigged asset (a brush holds meshes only). force:true overwrites an existing brush. Overwriting needs "Allow deleting library files" in Phoenix Settings → Connections.' + UNREAL,
    { asset: str('Unreal asset path, e.g. /Game/Props/SM_Crate'), name: str('brush slug (optional — default: the asset name)'), category: str('brush category (optional)'), display: str('display name (optional)'), force: bool('overwrite an existing brush of that name'), refresh: bool('re-export instead of using the cached GLB'), keep_in_blender: bool('keep the imported objects in the Blender scene') }, ['asset']),
  tool('character_to_unreal', 'Carry a rigged (Mixamo) character from the Blender scene into Unreal as SkeletalMeshes with their skeleton. Every import creates its own skeleton asset, so several characters do not share an animation library until merged in Unreal.' + UNREAL,
    { rig: str('armature name, e.g. "Human.rig" (optional — default: the first mixamorig armature in the scene)'), name: str('name in Unreal (optional)'), unreal_path: str('content folder, default /Game/PhoenixCharacters'), with_animation: bool('also carry the animation (preview-grade)'), refresh: bool('rebuild the cached export') }),
  tool('inspect_unreal', 'Render the Unreal level and LOOK at it: returns a description by a vision model that saw the image (not a file path). If it errors or Unreal vision is off, the level was NOT seen — do not describe it from memory.' + UNREAL,
    { focus: str('actor label to frame (optional)'), question: str('what to check (optional)'), mode: { enum: ['camera', 'viewport'], description: '"camera" (default, works in the background, no post-processing) or "viewport" (real editor view, Unreal must be in the foreground)' }, width: num('image width, default 1280'), height: num('image height, default 720') }),

  // ── opt-in (O) — listed only when the matching Settings → Connections checkbox is on ──
  tool('blender_run', 'Run arbitrary Python (bpy) in the open Blender scene. Only listed when the user enabled it in Phoenix Settings → Connections. A checkpoint is taken first.' + AUTO,
    { code: str('Python source as one string') }, ['code']),
  tool('unreal_run', 'Run arbitrary Python in a running Unreal Editor (it does not touch the Blender scene). Only listed when the user enabled it in Phoenix Settings → Connections. Unreal writes screenshots at the END of the frame: take the shot in one call and collect the file in the next. Needs a running Unreal Editor with the Phoenix bridge.',
    { code: str('Python source as one string') }, ['code']),
  tool('delete_asset', 'Delete a staged GLB file from the library.' + PERMANENT,
    { category: str('palette category of the asset'), name: str('file name from list_assets, e.g. barrel.glb') }, ['category', 'name']),
  tool('delete_brush', 'Delete a brush (slug from list_brushes) with its library file.' + PERMANENT,
    { slug: str('brush slug from list_brushes') }, ['slug']),
  tool('delete_material', 'Remove a material (name from list_materials) from the shared material palette; the open Blender scene is untouched.' + PERMANENT,
    { name: str('material name from list_materials') }, ['name']),
];
const INTENT = str('what this step is for — the render judge uses it to decide whether the result is what was asked');
for (const t of TOOLS) t.inputSchema.properties.intent = INTENT;
// opt-in tool → the /config mcp flag that lists it (must match server.js MCP_OPTIN)
const OPTIN = { blender_run: 'allowBlenderRun', unreal_run: 'allowUnrealRun', delete_asset: 'allowDelete', delete_brush: 'allowDelete', delete_material: 'allowDelete' };
// R-client tools: a plain GET of a Phoenix route, never /mcp/call (names for the tools that take clip / folder / character names)
const LISTS = {
  list_animations: { route: '/animations', description: 'List the animation clips (FBX files) in Phoenix\'s animation library — the names animate_human, sequence_animations and the character tools take.' },
  list_custom_rigs: { route: '/custom-rigs', description: 'List the custom-rig folders with their state (skeleton assigned, mesh variants, clips) — the folder names the custom-rig tools take.' },
  list_characters: { route: '/characters', description: 'List the saved characters — the names spawn_character takes.' },
};
const LIST_CUT = 20000;
// R-client-style action: POST a lock-free pure-filesystem route (as the UI does), never /mcp/call
const CREATE_RIG = { name: 'create_custom_rig', description: 'Create a new, empty custom-rig folder (no skeleton yet) — then call assign_skeleton to give it the selected armature. The folder name is what the other custom-rig tools take (list_custom_rigs shows all folders).',
  inputSchema: { type: 'object', properties: { name: str('folder name') }, required: ['name'] } };
const CONTROL = [
  CREATE_RIG,
  ...Object.keys(LISTS).map(name => ({ name, description: LISTS[name].description, inputSchema: { type: 'object', properties: {} } })),
  { name: 'job_status', description: 'Show whether Phoenix is busy: the running background job, the running pipeline stage, and whether a call holds the chat lock.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'stop', description: 'Stop the running Phoenix stage and its ComfyUI job (the same as the Stop button).',
    inputSchema: { type: 'object', properties: {} } },
];

// ─── HTTP to Phoenix ──────────────────────────────────────────────────────────

// → { status, json, text } ; rejects with { code } when Phoenix is not reachable
function phoenix(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlPath, PHOENIX_URL); } catch (e) { reject(e); return; }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch (_) { json = undefined; }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    req.on('error', reject);   // no request timeout: generate_prop may keep the request open for minutes
    if (payload) req.write(payload);
    req.end();
  });
}

// Fallback only (an older Phoenix without the "failed" field): the same failure shapes as assistant.js toolResultFailed.
const FAILED_RE = /^(ERROR|PYTHON_ERROR|BLENDER_ERROR|REJECTED|BUSY|Pipeline failed|inspect_render could not complete)/;
const errResult = (text) => ({ content: [{ type: 'text', text }], isError: true });
const failText = (e) => (e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'ENOTFOUND' || e.code === 'EHOSTUNREACH'))
  ? NOT_RUNNING : 'Could not reach Phoenix: ' + ((e && e.message) || String(e));

async function listTools() {
  let flags = {};
  try {
    const r = await phoenix('GET', '/config');
    if (r.status === 200 && r.json && r.json.mcp && typeof r.json.mcp === 'object') flags = r.json.mcp;
  } catch (_) { /* Phoenix down: the safe default is "everything opt-in off" */ }
  return TOOLS.filter(t => !OPTIN[t.name] || flags[OPTIN[t.name]] === true).concat(CONTROL);
}

let clientName = 'mcp';

async function callTool(name, args) {
  args = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  try {
    if (Object.prototype.hasOwnProperty.call(LISTS, name)) {
      const r = await phoenix('GET', LISTS[name].route);
      if (r.status !== 200) return errResult((r.json && r.json.error) || ('Phoenix answered ' + r.status));
      let text = JSON.stringify(r.json === undefined ? r.text : r.json, null, 2);
      const cps = Array.from(text);
      if (cps.length > LIST_CUT) text = cps.slice(0, LIST_CUT).join('') + '\n… ' + (cps.length - LIST_CUT) + ' more characters (cut)';
      return { content: [{ type: 'text', text }], isError: false };
    }
    if (name === 'create_custom_rig') {
      const r = await phoenix('POST', '/custom-rig-create', { name: typeof args.name === 'string' ? args.name : '' });
      if (r.status !== 200) return errResult((r.json && r.json.error) || ('Phoenix answered ' + r.status));
      const f = r.json && r.json.folder;
      return { content: [{ type: 'text', text: 'Created custom-rig folder "' + ((f && f.name) || args.name) + '" (no skeleton yet) — next: assign_skeleton.' }], isError: false };
    }
    if (name === 'job_status') {
      const r = await phoenix('GET', '/mcp/status');
      if (r.status !== 200) return errResult((r.json && r.json.error) || ('Phoenix answered ' + r.status));
      const j = r.json || {};
      const lines = [
        j.busy ? 'Phoenix is busy (a call holds the chat lock).' : 'Phoenix is idle.',
        'Stage: ' + (j.stage || 'none'),
        'Job: ' + (j.job ? JSON.stringify(j.job) : 'none'),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
    }
    if (name === 'stop') {
      const r = await phoenix('POST', '/stop', {});
      if (r.status !== 200) return errResult((r.json && r.json.error) || ('Phoenix answered ' + r.status));
      const j = r.json || {};
      return { content: [{ type: 'text', text: j.stopped ? 'Stopped the ' + (j.stage || 'running') + ' stage.' : 'Nothing was running to stop.' + (j.job ? ' (Job #' + j.job.id + ' ' + (j.job.label || j.job.kind || '') + ' is still listed.)' : '') }], isError: false };
    }
    const input = Object.assign({}, args);
    if (name === 'make_human' && input.rig === 'none') input.rig = false;   // strict clients need a string enum; Phoenix wants false
    const intent = typeof input.intent === 'string' ? input.intent : undefined;
    delete input.intent;
    const r = await phoenix('POST', '/mcp/call', { tool: name, input, ...(intent ? { intent } : {}), client: clientName });
    if (r.status !== 200) return errResult((r.json && r.json.error) || ('Phoenix answered ' + r.status + (r.text ? ': ' + r.text.slice(0, 200) : '')));
    const j = r.json || {};
    // Headline: PASS | FAIL — why | UNVERIFIED — why | NO VERDICT — why | not run. UNVERIFIED is never shown as PASS.
    const word = !j.verdict ? null : j.verdict === 'unverified' ? 'UNVERIFIED' : j.verdict === 'none' ? 'NO VERDICT' : String(j.verdict).toUpperCase();
    const verdictLine = word
      ? 'Render check: ' + word + (j.verdict !== 'pass' && j.stopReason ? ' — ' + j.stopReason : '') + (j.gateNote ? '\n' + String(j.gateNote).trim() : '')
      : 'Render check: not run';
    const resultText = String(j.result == null ? '' : j.result);
    const content = [{ type: 'text', text: resultText + '\n' + verdictLine }];
    if (typeof j.image === 'string' && j.image) content.push({ type: 'image', data: j.image, mimeType: 'image/png' });
    // A failed tool is an error for the client; a FAIL / UNVERIFIED render verdict is a result, not an error (prefixes only).
    return { content, isError: typeof j.failed === 'boolean' ? j.failed : FAILED_RE.test(resultText) || resultText.startsWith('⚠️') };
  } catch (e) {
    return errResult(failText(e));
  }
}

// ─── JSON-RPC ─────────────────────────────────────────────────────────────────

let pending = 0, closing = false;
function maybeExit() { if (closing && pending === 0) process.exit(0); }

async function handle(msg) {
  const hasId = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null && msg.id !== undefined;
  const reply = (result) => { if (hasId) send({ jsonrpc: '2.0', id: msg.id, result }); };
  const fail = (code, message) => { if (hasId) send({ jsonrpc: '2.0', id: msg.id, error: { code, message } }); };
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
    send({ jsonrpc: '2.0', id: (msg && typeof msg === 'object' && !Array.isArray(msg) && 'id' in msg) ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      if (p.clientInfo && typeof p.clientInfo.name === 'string' && p.clientInfo.name) clientName = p.clientInfo.name;
      const v = SUPPORTED.includes(p.protocolVersion) ? p.protocolVersion : SUPPORTED[0];
      reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'phoenix', version: VERSION } });
      return;
    }
    case 'notifications/initialized': return;   // notification: no reply
    case 'ping': reply({}); return;
    case 'tools/list': reply({ tools: await listTools() }); return;
    case 'tools/call': {
      if (typeof p.name !== 'string' || !p.name) { fail(-32602, 'tools/call needs params.name'); return; }
      reply(await callTool(p.name, p.arguments));
      return;
    }
    default:
      fail(-32601, 'Method not found: ' + msg.method);   // an unknown notification (no id) stays silent
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  pending++;
  handle(msg).catch((e) => {
    log('handler error:', (e && e.stack) || String(e));
    try { if (msg && msg.id !== undefined && msg.id !== null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } }); } catch (_) { /* nothing */ }
  }).finally(() => { pending--; maybeExit(); });
});
rl.on('close', () => { closing = true; maybeExit(); });
process.on('uncaughtException', (e) => log('uncaught:', (e && e.stack) || String(e)));
