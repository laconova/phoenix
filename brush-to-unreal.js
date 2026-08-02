'use strict';

/**
 * brush-to-unreal.js — carry a Phoenix brush from the library into Unreal, in one call.
 *
 * The route, and why each leg is the way it is:
 *
 *   registry → Blender (place) → GLB on disk → Unreal (import_scene) → actor tree
 *
 * 1. BLENDER IS ONLY NEEDED ONCE PER BRUSH. A brush *is* Blender Python (bpy/bmesh) — its
 *    geometry cannot exist until Blender has run it, and Unreal cannot run bpy. But the GLB
 *    it produces is just a file, so every later trip is file → Unreal with no Blender at all.
 *    That is what makes "double-click a brush, it lands in Unreal" possible without an open
 *    Blender. Cache lives in brush-cache/<slug>.glb; pass refresh:true to rebuild it.
 *
 * 2. THE UNREAL LEG USES import_scene, NOT AssetImportTask. Measured 2026-07-31: an
 *    AssetImportTask drops the scene graph and yields LOOSE StaticMeshes — an assembly comes
 *    out as a heap, and the operator has to rebuild the arrangement by hand. import_scene
 *    reconstructs the parenting and the relative transforms.
 *
 *    🪤 DO NOT SET override_pipelines. This cost a round of silent material loss on 2026-07-31
 *    and the failure is worth spelling out, because it looks like success from every angle:
 *    forcing [DefaultGLTFSceneAssetsPipeline, DefaultSceneLevelPipeline] DOES build the actor
 *    hierarchy — so the import reads as correct — while replacing glTF's own material
 *    translation with a generic one. The instances then hang off PBRSurfaceMaterial_MR with
 *    ZERO parameters instead of MI_Default_Opaque_DS with BaseColor/Roughness/Emissive, and
 *    every brush arrives black. Measured against a control: the same GLB imported both ways,
 *    override → "0 vector, 0 scalar", no override → the exact source values.
 *    Interchange already picks the right stack for .glb. Let it.
 *
 *    (Adding DefaultGLTFPipeline to the override does NOT repair it — tested, still generic.
 *    The fix is to stop overriding, not to override better.)
 *
 * 3. THE BRUSH IS DELETED FROM BLENDER ONLY AFTER THE GLB IS VERIFIED ON DISK (user's call,
 *    2026-07-31: "nach dem Export wieder entfernen"). Deleting before the check would mean a
 *    failed export silently costs the placed objects.
 *
 * 4. NOTHING IS REPORTED AS IMPORTED UNTIL IT HAS BEEN LISTED BACK. Interchange finishes at
 *    the END OF THE FRAME — the same trap as screenshots. Assets
 *    queried inside the importing call are always absent, so the verification is a SECOND
 *    call. A count that was never read back is a claim, not a result.
 */

const fs        = require('fs');
const path      = require('path');
const { spawnNode } = require('./spawn-node');

const { callBlender } = require('./blender-ipc');
const unrealIpc       = require('./unreal-ipc');

const BRUSHES_DIR   = path.join(__dirname, 'brushes');
const REGISTRY_FILE = path.join(BRUSHES_DIR, 'registry.json');
// 🔴 NOT under staging/. listStagedFiles() treats EVERY directory in staging/ as a palette
// category, so a cache folder there turns every cached brush into a fake "staged asset" in the
// library — and import_asset then fails on it with "Asset not found in staging", because it
// resolves paths differently. Found the hard way 2026-07-31, live, by the user.
// staging/ is the drop zone for importable assets; this is an internal cache and must stay out.
const CACHE_DIR     = path.join(__dirname, 'brush-cache');

const DEFAULT_UNREAL_PATH = '/Game/PhoenixBrushes';

const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const fwd     = p => p.replace(/\\/g, '/');

// ─── Blender leg ──────────────────────────────────────────────────────────────

// Names of everything currently in the scene — the "before" half of the diff that tells us
// which objects the brush created. A brush is NOT one object (measured: an Empty root plus
// child meshes, three deep for gravinium_coil), so we cannot just grab the active object.
async function sceneObjectNames(cfg) {
  const r = await callBlender(
    // JSON, not a "|"-join: a Blender object name may legally contain "|", which split() would
    // shatter into phantom names — those then read as "new" objects and get exported AND DELETED.
    'import bpy, json\nprint("PHX_OBJS:" + json.dumps([o.name for o in bpy.context.scene.objects]))',
    { cfg, timeoutMs: 20000 }
  );
  if (r.status !== 'ok') throw new Error(`Blender: ${r.message || 'scene listing failed'}`);
  const m = String(r.stdout || '').match(/PHX_OBJS:(\[.*\])/);
  if (!m) throw new Error(`Blender: could not parse scene object list from: ${String(r.stdout || '').slice(0, 200)}`);
  return JSON.parse(m[1]);
}

async function placeBrush(slug, instanceName) {
  const argv = ['--name', slug, '--instance-name', instanceName];
  const r = await spawnNode(path.join(__dirname, 'use_brush.js'), argv, { timeoutMs: 120000, maxBuffer: 2 * 1024 * 1024 });
  if (r.error)      throw new Error(`use_brush: ${r.error.message}`);
  if (r.code !== 0) throw new Error(`use_brush (exit ${r.code}): ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout || '').trim();
}

// Export the objects the brush just created, then remove them — in that order, and only if
// the file is really on disk. Returns { glb, bytes, exported: [names] }.
async function exportAndClean(beforeNames, glbPath, cfg, keepInBlender) {
  const py = [
    'import bpy, os, json',
    'before = set(json.loads(' + JSON.stringify(JSON.stringify(beforeNames)) + '))',
    'fresh = [o for o in bpy.context.scene.objects if o.name not in before]',
    'if not fresh:',
    '    print("PHX_ERROR: brush placed no new objects")',
    'else:',
    '    fresh_names = set(o.name for o in fresh)',
    '    # The root is the fresh object whose parent is outside the fresh set. Exporting from the',
    '    # root down keeps the hierarchy that Unreal will rebuild; exporting the meshes alone would',
    '    # flatten it here and no importer could put it back.',
    '    roots = [o for o in fresh if (o.parent is None) or (o.parent.name not in fresh_names)]',
    '    sel = []',
    '    for r in roots:',
    '        sel.append(r)',
    '        sel.extend(r.children_recursive)',
    '    bpy.ops.object.select_all(action="DESELECT")',
    '    for o in sel:',
    '        o.select_set(True)',
    '    bpy.context.view_layer.objects.active = roots[0]',
    '    out = ' + JSON.stringify(fwd(glbPath)),
    '    os.makedirs(os.path.dirname(out), exist_ok=True)',
    '    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True,',
    '                              export_materials="EXPORT", export_apply=True, export_yup=True)',
    '    # VERIFY BEFORE DELETING. A missing or empty file here means the export failed, and',
    '    # deleting anyway would destroy the only copy of what was placed.',
    '    ok = os.path.exists(out) and os.path.getsize(out) > 0',
    '    print("PHX_GLB:", out)',
    '    print("PHX_BYTES:", os.path.getsize(out) if ok else 0)',
    '    print("PHX_ROOTS:", json.dumps([r.name for r in roots]))',
    '    print("PHX_OBJECTS:", json.dumps([o.name for o in sel]))',
    '    if ok and ' + (keepInBlender ? 'False' : 'True') + ':',
    '        for o in sel:',
    '            bpy.data.objects.remove(o, do_unlink=True)',
    '        print("PHX_CLEANED: yes")',
    '    else:',
    '        print("PHX_CLEANED: no")',
  ].join('\n');

  const r = await callBlender(py, { cfg, timeoutMs: 180000 });
  const out = String(r.stdout || '').trim();
  if (r.status !== 'ok') throw new Error(`Blender export failed: ${r.message || out}`);
  if (out.includes('PHX_ERROR')) throw new Error(`Blender: ${out}`);

  const grab = key => {
    const m = out.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };
  const bytes = parseInt(grab('PHX_BYTES'), 10) || 0;
  if (!bytes) throw new Error('Blender wrote no GLB (0 bytes) — nothing was removed from the scene.');

  let objects = [];
  try { objects = JSON.parse(grab('PHX_OBJECTS') || '[]'); } catch (_) {}
  return { glb: grab('PHX_GLB'), bytes, objects, cleaned: grab('PHX_CLEANED') === 'yes' };
}

// ─── Unreal leg ───────────────────────────────────────────────────────────────

// The try/except-that-prints-its-traceback wrapper now lives in unreal-ipc.js, because
// unreal-to-blender.js needs exactly the same thing and two copies of an error path is
// the one place a divergence stays invisible until something is already going wrong.
const runUnreal = (bodyLines, cfg, timeoutMs = 300000) =>
  unrealIpc.callUnrealGuarded(bodyLines, { cfg, timeoutMs });

// The verify and save calls land immediately after a large import — exactly where the editor,
// busy scanning its asset registry, drops the connection (WinError 10053). That surfaced as a
// "CHARACTER/BRUSH_TO_UNREAL_ERROR" reading like "nothing happened" while the import had really
// half-happened. Retry ONLY these idempotent follow-ups — never the import itself, where a retry
// would double it. Same transient set as character-to-unreal.js.
const _transientUnreal = e =>
  /10053|10054|ConnectionAborted|ConnectionReset|forcibly closed/i.test((e && e.message) || String(e));
async function runUnrealRetry(bodyLines, cfg, timeoutMs = 300000) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await runUnreal(bodyLines, cfg, timeoutMs); }
    catch (e) {
      lastErr = e;
      if (!_transientUnreal(e) || attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 2000 * attempt));   // give the editor room to finish
    }
  }
  throw lastErr;
}

async function importIntoUnreal(glbPath, destPath, cfg) {
  await runUnreal([
    'im = unreal.InterchangeManager.get_interchange_manager_scripted()',
    'src = unreal.InterchangeSourceData()',
    'src.set_filename(r' + JSON.stringify(fwd(glbPath)) + ')',
    'params = unreal.ImportAssetParameters()',
    'params.is_automated = True',
    '# 🪤 import_level is a Level OBJECT, not a flag — passing True raises a TypeError that the',
    '# bridge reports as a bare "command failed". Omitting it targets the open level, which is',
    '# what we want.',
    '# 🪤 override_pipelines is deliberately NOT set — see header note 2. Setting it keeps the',
    '# hierarchy and silently strips every material factor.',
    'print("PHX_IMPORT:", im.import_scene(' + JSON.stringify(destPath) + ', src, params))',
  ], cfg);

  // Second call on purpose — Interchange finishes at end of frame (header note 4).
  // This call also COUNTS MATERIAL PARAMETERS. A material instance with zero of them is not a
  // cosmetic detail: it is the machine-readable signature of the wrong pipeline stack, and the
  // only difference between a correct import and a black one. Reading it back here is what
  // turns "no material" from something the operator discovers by looking into something the
  // bridge refuses to ship.
  const verify = await runUnrealRetry([
    'ar = unreal.AssetRegistryHelpers.get_asset_registry()',
    'assets = ar.get_assets_by_path(' + JSON.stringify(destPath) + ', recursive=True)',
    'print("PHX_ASSET_COUNT:", len(assets))',
    'for a in assets:',
    '    kind = str(a.asset_class_path.asset_name)',
    '    print("PHX_ASSET:", kind, "|", a.package_name)',
    '    if kind == "MaterialInstanceConstant":',
    '        m = unreal.load_asset(str(a.package_name) + "." + str(a.asset_name))',
    '        n = 0',
    '        if m:',
    '            n = (len(list(m.get_editor_property("vector_parameter_values")))',
    '                 + len(list(m.get_editor_property("scalar_parameter_values")))',
    '                 + len(list(m.get_editor_property("texture_parameter_values"))))',
    '        print("PHX_MATPARAMS:", a.asset_name, "|", n)',
  ], cfg);

  const count  = parseInt((verify.match(/^PHX_ASSET_COUNT:\s*(\d+)$/m) || [])[1], 10) || 0;
  const assets = [...verify.matchAll(/^PHX_ASSET:\s*(\S+)\s*\|\s*(\S+)$/gm)]
    .map(m => ({ type: m[1], path: m[2] }));
  const materials = [...verify.matchAll(/^PHX_MATPARAMS:\s*(\S+)\s*\|\s*(\d+)$/gm)]
    .map(m => ({ name: m[1], params: parseInt(m[2], 10) }));
  const flatMaterials = materials.filter(m => m.params === 0).map(m => m.name);

  return { count, assets, materials, flatMaterials };
}

/**
 * Write the imported assets to disk.
 *
 * 🔴 WHY THIS IS A SEPARATE, MANDATORY STEP. Interchange creates the packages in memory.
 * Until something calls save_asset they exist only in the editor's session and in autosave —
 * and autosave is not a copy you own. Measured cost of skipping it:
 * the 2026-07-28 MetaHuman export existed ONLY as an autosave, so it did not survive into the
 * copied project and the work was gone. The import reported success the whole time.
 *
 * ⚠️ CALLED AFTER THE CHECKS, NOT BEFORE. A material instance with zero parameters renders
 * black; saving first would persist the defect instead of letting the caller refuse it.
 *
 * ⛔ THE LEVEL IS DELIBERATELY NOT SAVED. import_scene also spawns actors, and those belong to
 * the user's open level — writing his working file as a side effect of an import is not ours to
 * do. So: the ASSETS survive a restart, the PLACEMENT does not until he saves the level. Said
 * out loud in the return value rather than left as a surprise.
 */
async function saveImportedAssets(assets, cfg) {
  const packages = [...new Set(assets.map(a => a.path).filter(Boolean))];
  if (!packages.length) return { saved: 0, failed: [], packages };

  const out = await runUnrealRetry([
    'pkgs = ' + JSON.stringify(packages),
    'saved, failed = [], []',
    'for p in pkgs:',
    '    try:',
    '        ok = unreal.EditorAssetLibrary.save_asset(p, only_if_is_dirty=False)',
    '    except Exception as _se:',
    '        ok = False',
    '        print("PHX_SAVE_EXC:", p, "|", _se)',
    '    (saved if ok else failed).append(p)',
    'print("PHX_SAVED:", len(saved))',
    'for p in failed:',
    '    print("PHX_SAVE_FAILED:", p)',
  ], cfg);

  const saved  = parseInt((out.match(/^PHX_SAVED:\s*(\d+)$/m) || [])[1], 10) || 0;
  const failed = [...out.matchAll(/^PHX_SAVE_FAILED:\s*(\S+)$/gm)].map(m => m[1]);
  return { saved, failed, packages };
}

// ─── Public entry points ──────────────────────────────────────────────────────

function resolveBrush(name) {
  const slug = slugify(name);
  if (!slug) throw new Error('name required');
  if (!fs.existsSync(REGISTRY_FILE)) throw new Error(`registry.json not found at ${REGISTRY_FILE}`);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  if (!registry.brushes || !registry.brushes[slug]) {
    const available = Object.keys(registry.brushes || {}).join(', ') || '(none)';
    throw new Error(`brush '${slug}' not found. Available: ${available}`);
  }
  return slug;
}

/**
 * Make sure the brush's GLB exists on disk, building it via Blender only if it does not.
 * Split out of brushToUnreal() because the Blender half is useful on its own: the library
 * PREVIEW needs a GLB and has no business touching Unreal. Two callers, one export path — a
 * second copy would drift, and this one carries the "delete only after the file is verified"
 * rule that keeps a failed export from costing the placed objects.
 *
 * @returns {{slug, glb, cached, bytes, steps, blender}}
 */
async function ensureBrushGlb(opts = {}) {
  const slug    = resolveBrush(opts.name);
  const cfg     = opts.cfg;
  const glbPath = path.join(CACHE_DIR, slug + '.glb');
  const steps   = [];

  // Invalidate the cache when the brush's source geometry is newer than it: overwriting, renaming
  // or deleting a brush rewrites brushes/phoenix_brushes.py, so a GLB older than that file holds
  // pre-overwrite geometry (found in the v1.7.0 function review). Rebuild when the source moved.
  const brushSrc = path.join(BRUSHES_DIR, 'phoenix_brushes.py');
  const srcMtime = fs.existsSync(brushSrc) ? fs.statSync(brushSrc).mtimeMs : 0;
  const cached = fs.existsSync(glbPath) && fs.statSync(glbPath).size > 0
                 && fs.statSync(glbPath).mtimeMs >= srcMtime && !opts.refresh;
  let blender  = null;

  if (cached) {
    if (opts.keepInBlender) {
      // 'both' target: the cache gives us the GLB for Unreal, but the user also asked for the brush
      // in the live Blender scene. A cache hit used to skip Blender entirely, so 'both' silently
      // degraded to 'unreal' on every call after the first. Place it (no export — the GLB exists).
      // Non-fatal: if Blender is closed this must NOT sink the Unreal half, so a failed placement
      // degrades to a warning step and the caller still imports the cached GLB into Unreal.
      try {
        await placeBrush(slug, slug);
        steps.push(`GLB from cache (${fs.statSync(glbPath).size} bytes); placed in Blender scene (kept)`);
      } catch (e) {
        steps.push(`GLB from cache (${fs.statSync(glbPath).size} bytes); Blender placement skipped (${String((e && e.message) || e).slice(0, 80)})`);
      }
    } else {
      steps.push(`GLB from cache (${fs.statSync(glbPath).size} bytes) — Blender not involved`);
    }
  } else {
    const before = await sceneObjectNames(cfg);
    await placeBrush(slug, slug);
    blender = await exportAndClean(before, glbPath, cfg, !!opts.keepInBlender);
    steps.push(`placed in Blender (${blender.objects.length} objects)`);
    steps.push(`exported ${path.relative(__dirname, glbPath)} (${blender.bytes} bytes)`);
    steps.push(blender.cleaned ? 'removed from Blender scene' : 'left in Blender scene');
  }

  return { slug, glb: glbPath, cached, bytes: fs.statSync(glbPath).size, steps, blender };
}

/**
 * @param {object} opts
 * @param {string} opts.name        brush slug from the registry
 * @param {string} [opts.unrealPath] content root, default /Game/PhoenixBrushes
 * @param {boolean} [opts.refresh]  rebuild the GLB even if it is cached
 * @param {boolean} [opts.keepInBlender] leave the placed objects in the Blender scene
 * @param {object} [opts.cfg]       phoenix config (the Unreal bridge needs it to find the engine)
 */
async function brushToUnreal(opts = {}) {
  const built = await ensureBrushGlb(opts);
  const slug     = built.slug;
  const cfg      = opts.cfg;
  const glbPath  = built.glb;
  const cached   = built.cached;
  const steps    = built.steps;
  const destPath = (opts.unrealPath || DEFAULT_UNREAL_PATH).replace(/\/+$/, '') + '/' + slug;

  const imported = await importIntoUnreal(glbPath, destPath, cfg);
  if (!imported.count) {
    throw new Error(
      `Unreal reported the import but ${destPath} is empty. import_scene returns True even ` +
      `when it creates nothing, so the count — not the return value — is the result.`
    );
  }
  // A material instance with no parameters is the signature of a wrong pipeline stack (header
  // note 2). It renders black and reads as "the brush has no material", which cost a debugging
  // round once already — so the bridge says it instead of shipping a silent black asset.
  if (imported.flatMaterials.length) {
    throw new Error(
      `Imported into ${destPath}, but ${imported.flatMaterials.length} material(s) arrived with ` +
      `no parameters (${imported.flatMaterials.join(', ')}) — they will render black. This is ` +
      `the override_pipelines defect described in the header, not a problem with the brush.`
    );
  }
  steps.push(`imported into ${destPath} (${imported.count} assets)`);

  // Only now — the checks above have to be able to refuse before anything is written.
  const saved = await saveImportedAssets(imported.assets, cfg);
  if (saved.failed.length) {
    steps.push(`⚠️ saved ${saved.saved}/${saved.packages.length} — FAILED: ${saved.failed.join(', ')}`);
  } else {
    steps.push(`saved ${saved.saved} asset package(s) to disk`);
  }
  steps.push('level NOT saved — the actor placement lives until you save the level yourself');

  return { slug, glb: glbPath, cached, destPath, steps, saved, ...imported };
}

module.exports = {
  brushToUnreal, ensureBrushGlb, saveImportedAssets,
  // Exported for character-to-unreal.js: the Unreal leg is not brush-specific and the
  // override_pipelines rule + the zero-parameter material guard must hold for every route
  // into Unreal, not just this one. A second copy would be a second place to forget them.
  importIntoUnreal,
  DEFAULT_UNREAL_PATH, CACHE_DIR,
};
