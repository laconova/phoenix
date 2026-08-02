'use strict';

/**
 * character-to-unreal.js — carry a rigged character from Blender into Unreal.
 *
 *   characters/<name>.blend (or a rig already in the scene)
 *        → select rig + its skinned meshes
 *        → GLB (skins + weights, optionally the animation)
 *        → import_scene → SkeletalMesh + Skeleton + materials
 *
 * This is the Human-tab counterpart to brush-to-unreal.js and deliberately reuses its Unreal
 * leg (importIntoUnreal) rather than repeating it: the override_pipelines rule and the
 * zero-parameter material guard are properties of importing INTO Unreal, not of brushes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASURED 2026-07-31, because each of these was an open question before:
 *
 * 1. ✅ export_apply=True DOES NOT BAKE THE POSE. This was the main worry — the brush export
 *    passes export_apply=True and a brush has no armature, so it was unknown whether a skinned
 *    character would arrive frozen in whatever pose it was in. Control test: the left arm was
 *    rotated ~57° and the same selection exported both ways. The two GLBs came out
 *    BYTE-IDENTICAL (45 876 836 B), same POSITION bounds, both carrying skins:1 / joints:52 /
 *    JOINTS_0 / WEIGHTS_0. Blender's glTF exporter excludes armature modifiers from the apply.
 *    ⇒ The flag is safe and is left as it is, so both routes share one export path.
 *
 * 2. 🪤 THE ROOT IS THE ARMATURE, NOT THE MESH. MakeHuman parents its meshes TO the rig, so
 *    selecting "the character" by picking a mesh silently exports a skinned mesh whose skeleton
 *    is not in the file. Selection therefore always starts at the armature and walks down.
 *
 * 3. ⚠️ ANIMATION IS OPT-IN AND GOES THROUGH glTF ONLY FOR PREVIEW. glTF carries the clip, and
 *    Unreal will import it — but the project's standing decision (phoenix-agent/state.md) is
 *    ASSETS AS GLB, ANIMATION AS FBX, because FBX is the trodden path for AnimSequence while it
 *    loses embedded textures. So withAnimation defaults to FALSE and says what it is when used.
 *
 * 4. 🔴 THE SKELETON QUESTION IS NOT SETTLED BY THIS FILE. Every import creates its own
 *    Skeleton asset unless one is supplied, and N characters with N skeletons means no shared
 *    animation library — the exact cost that makes the MetaHuman rail expensive. All MakeHuman
 *    characters wear the same mixamorig skeleton (characters.js MIXAMO_ROOT), so they SHOULD
 *    share one. That is a decision for the operator, so this reports the skeletons that were
 *    created instead of quietly picking one.
 */

const fs   = require('fs');
const path = require('path');

const { callBlender } = require('./blender-ipc');
const { importIntoUnreal, saveImportedAssets } = require('./brush-to-unreal');
const { inspectGlbMaterials } = require('./unreal-to-blender');

const CACHE_DIR = path.join(__dirname, 'character-cache');
const DEFAULT_UNREAL_PATH = '/Game/PhoenixCharacters';

// The bone that defines "standard humanoid skeleton" — the same constant characters.js and
// animate_human.js test against. Kept identical on purpose: a character that is animatable
// there must be exportable here.
const MIXAMO_ROOT = 'mixamorig:Hips';

// Alpha threshold for the masked test — Unreal's own default for OpacityMaskClipValue. The
// SAME number is used to measure in Blender and set as AlphaCutoff in Unreal, so that "what
// was measured" and "what gets rendered" cut at the same place.
const ALPHA_CUTOFF = 0.333;

// How many percent of texels below the cutoff make a texture "masked". Measured on a
// MakeHuman character, the gap is between 0.00 % (skin — no alpha content at all) and
// 1.24 % (eyes — the small but decisive cornea disc). 0.1 % separates those cleanly and sits
// far enough from both sides that it cannot tip.
const MASK_THRESHOLD_PCT = 0.1;

const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const fwd     = p => p.replace(/\\/g, '/');

// The alpha profile lives next to the GLB so a cache hit is not left without measurements.
const alphaSidecar = glbPath => glbPath.replace(/\.glb$/i, '') + '.alpha.json';

// ─── Blender leg ──────────────────────────────────────────────────────────────

/**
 * Export the rig and every mesh bound to it.
 *
 * `rigName` empty → the first mixamorig armature in the scene, which is the same rule
 * animate_human.js uses when no character is named.
 */
async function exportCharacterGlb(rigName, glbPath, cfg, opts = {}) {
  // 🔴 NEVER `raise SystemExit` IN BRIDGE PYTHON — IT KILLS BLENDER. This cost two crashes of
  // the user's live session on 2026-07-31. The IPC addon runs the code as
  // `try: exec(code) except Exception:` on a bpy.app.timers callback, and SystemExit derives
  // from BaseException, NOT Exception — so it sails straight through the handler, out of the
  // timer, into the embedded interpreter, and takes the process down. There is no traceback and
  // no .crash.txt, so it does not even look like a script error afterwards.
  // ⇒ Early exits are a `return` out of a function. Never an exception that skips the guard.
  const py = [
    'import bpy, os, json',
    '',
    'def _phx_export():',
    '    want = ' + JSON.stringify(rigName || ''),
    '    root_bone = ' + JSON.stringify(MIXAMO_ROOT),
    '',
    '    def is_mixamo(a):',
    '        return root_bone in [b.name for b in a.data.bones]',
    '',
    '    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]',
    '    if want:',
    '        rig = next((a for a in arms if a.name == want), None)',
    '        if rig is None:',
    '            print("PHX_ERROR: no armature named " + want + " — have: " + ", ".join(a.name for a in arms))',
    '            return',
    '    else:',
    '        rig = next((a for a in arms if is_mixamo(a)), None)',
    '        if rig is None:',
    '            print("PHX_ERROR: no mixamorig armature in the scene — have: " + ", ".join(a.name for a in arms))',
    '            return',
    '',
    '    # Refuse a non-mixamorig rig HERE rather than letting it import and fail later in a way',
    '    # nobody can read. Same routing rule as characters.js: anything else is Custom-Rig work.',
    '    if not is_mixamo(rig):',
    '        names = [b.name for b in rig.data.bones]',
    '        print("PHX_ERROR: " + rig.name + " is not a " + root_bone + " skeleton (" + str(len(names)) +',
    '              " bones). Custom rigs go through the Custom-Rig tab, not here.")',
    '        return',
    '',
    '    # 🪤 Meshes are children of the rig, and a mesh alone would export skinning with no skeleton.',
    '    meshes = [o for o in bpy.context.scene.objects',
    '              if o.type == "MESH" and (o.parent == rig or any(',
    '                  getattr(m, "object", None) == rig for m in o.modifiers))]',
    '    if not meshes:',
    '        print("PHX_ERROR: " + rig.name + " has no meshes bound to it — nothing to export")',
    '        return',
    '',
    '    sel = [rig] + meshes',
    '',
    '    # 🔴 A HIDDEN OBJECT CANNOT BE SELECTED, AND select_set() SAYS NOTHING ABOUT IT.',
    '    # make_human.js:157 builds every character with hide_viewport=True in an "MH Staged"',
    '    # collection — that is the Human tab\'s preview mode, not a mistake — and place_human',
    '    # is what reveals it. So a freshly built character, which is the NORMAL case here, is',
    '    # invisible. select_set(True) then returns without error and select_get() stays False,',
    '    # use_selection exports nothing, and the result is a valid 132-byte GLB with no meshes.',
    '    # Measured 2026-07-31: all six objects of Human.rig came back sel=False, and the export',
    '    # "succeeded". ⇒ Unhide for the export, then put it back EXACTLY as it was.',
    '    prev_hide = {o.name: o.hide_viewport for o in sel}',
    '    try:',
    '        for o in sel:',
    '            o.hide_viewport = False',
    '        bpy.ops.object.select_all(action="DESELECT")',
    '        for o in sel:',
    '            o.select_set(True)',
    '        bpy.context.view_layer.objects.active = rig',
    '',
    '        # Verify the selection actually took. Assuming it did is what produced the empty GLB.',
    '        picked = [o.name for o in sel if o.select_get()]',
    '        if len(picked) != len(sel):',
    '            missed = [o.name for o in sel if not o.select_get()]',
    '            print("PHX_ERROR: could not select " + ", ".join(missed) +',
    '                  " — they stay unselectable even unhidden, so nothing would be exported")',
    '            return',
    '',
    '        out = ' + JSON.stringify(fwd(glbPath)),
    '        os.makedirs(os.path.dirname(out), exist_ok=True)',
    '        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True,',
    '                                  export_materials="EXPORT", export_apply=True, export_yup=True,',
    '                                  export_skins=True,',
    '                                  export_animations=' + (opts.withAnimation ? 'True' : 'False') + ')',
    '    finally:',
    '        # Restore even if the export raised — leaving the user\'s character visible when he',
    '        # left it staged is a silent change to HIS scene.',
    '        for o in sel:',
    '            if o.name in prev_hide:',
    '                o.hide_viewport = prev_hide[o.name]',
    '',
    '    # ── Per-texture alpha profile ────────────────────────────────────────',
    '    # MPFB builds EVERY material with surface_render_method="DITHERED", which the glTF',
    '    # exporter turns into alphaMode:BLEND — and Unreal\'s importer then picks the',
    '    # MI_*_Blend_DS parent materials. Result: the whole character is translucent and you',
    '    # can see the sky through him (measured 2026-08-01).',
    '    # The correction must NOT be a name list ("lashes need alpha"). The first version was',
    '    # exactly that, put the eyes on OPAQUE, and thereby made the transparent cornea',
    '    # solid: brown iris gone, a lavender disc in front of it instead.',
    '    # So the decision comes from the alpha channel ITSELF. Measured on this character:',
    '    # skin 0.00 %, brown_eye 1.24 %, teeth 47.8 %, lashes 88.9 %, brows 90.5 % of texels',
    '    # below the cutoff — zero against everything else, cleanly separable.',
    '    prof = {}',
    '    for img in bpy.data.images:',
    '        if img.channels < 4 or img.size[0] == 0 or img.size[1] == 0:',
    '            continue',
    '        if img.type in ("RENDER_RESULT", "COMPOSITING"):',   // "Render Result"/"Viewer Node" are buffers, not textures
    '            continue',
    '        key = os.path.splitext(img.name)[0]',
    '        while key and key.rsplit(".", 1)[-1].isdigit():',   // Human.png.001 -> Human.png -> Human
    '            key = key.rsplit(".", 1)[0]',
    '        key = os.path.splitext(key)[0]',
    '        if key in prof:',
    '            continue',
    '        # foreach_get into a compact float32 array in ONE C copy. img.pixels[:] materialised the',
    '        # whole RGBA as ~1GB of Python floats; indexing img.pixels PER READ is far worse (each RNA',
    '        # index access re-copies the ENTIRE array), which timed the export out on a 2K skin. array',
    '        # ("f") is 4 bytes/elem and foreach_get fills it in one pass - fast AND a fraction of the RAM.',
    '        import array as _pxarr',
    '        _npx = len(img.pixels)',
    '        px = _pxarr.array("f", bytes(_npx * 4))',
    '        img.pixels.foreach_get(px)',
    '        n = _npx // 4',
    '        step = max(1, n // 20000)             # a sample is enough - the question is "has alpha", not precision',
    '        seen = 0',
    '        below = 0',
    '        for i in range(0, n, step):',
    '            seen += 1',
    '            if px[i * 4 + 3] < ' + ALPHA_CUTOFF + ':',
    '                below += 1',
    '        prof[key] = round(100.0 * below / seen, 3) if seen else 0.0',
    '',
    '    ok = os.path.exists(out) and os.path.getsize(out) > 0',
    '    print("PHX_ALPHA:", json.dumps(prof))',
    '    print("PHX_RIG:", rig.name)',
    '    print("PHX_BONES:", len(rig.data.bones))',
    '    print("PHX_MESHES:", json.dumps([o.name for o in meshes]))',
    '    print("PHX_SELECTED:", len(picked))',
    '    print("PHX_RESTAGED:", json.dumps([n for n, v in prev_hide.items() if v]))',
    '    print("PHX_VERTS:", sum(len(o.data.vertices) for o in meshes))',
    '    print("PHX_ACTION:", (rig.animation_data.action.name if (rig.animation_data and rig.animation_data.action) else ""))',
    '    print("PHX_BYTES:", os.path.getsize(out) if ok else 0)',
    '',
    '_phx_export()',
  ].join('\n');

  const r = await callBlender(py, { cfg, timeoutMs: 300000 });
  const out = String(r.stdout || '').trim();
  if (r.status !== 'ok') throw new Error(`Blender: ${r.message || out}`);
  if (out.includes('PHX_ERROR')) {
    throw new Error(out.split('\n').find(l => l.includes('PHX_ERROR')).replace('PHX_ERROR:', '').trim());
  }

  const grab = k => {
    const m = out.match(new RegExp('^' + k + ':\\s*(.*)$', 'm'));
    return m ? m[1].trim() : '';
  };
  const bytes = parseInt(grab('PHX_BYTES'), 10) || 0;
  if (!bytes) throw new Error('Blender wrote no GLB (0 bytes).');

  // 🔴 "BYTES > 0" IS NOT A RESULT. An empty selection produces a perfectly valid GLB of about
  // 132 bytes: header, one JSON chunk, no meshes. It passes every file check, imports into
  // Unreal without complaint, and only shows up much later as "the character has no mesh".
  // Measured 2026-07-31 — that exact 132-byte file went all the way into /Game before anything
  // objected. So the content is checked HERE, at the step that produced it.
  const info = inspectGlbMaterials(glbPath);
  if (!info.meshes) {
    throw new Error(
      `Blender wrote a GLB of ${bytes} bytes with NO meshes in it. The export ran but nothing ` +
      `was in the selection — usually a visibility problem (a hidden object cannot be selected ` +
      `and select_set() does not say so).`
    );
  }

  let meshes = [];
  try { meshes = JSON.parse(grab('PHX_MESHES') || '[]'); } catch (_) {}
  let restaged = [];
  try { restaged = JSON.parse(grab('PHX_RESTAGED') || '[]'); } catch (_) {}
  let alpha = {};
  try { alpha = JSON.parse(grab('PHX_ALPHA') || '{}'); } catch (_) {}

  // The profile travels as a sidecar next to the GLB. Reason: the UI button calls WITHOUT
  // refresh, and on a cache hit Blender never runs — without the sidecar the correction would
  // stand there with no measurements and the character would arrive translucent again. The
  // cache must not serve half the truth.
  if (Object.keys(alpha).length) {
    try { fs.writeFileSync(alphaSidecar(glbPath), JSON.stringify(alpha, null, 1), 'utf8'); }
    catch (_) { /* no reason to fail the export over this — the fallback is "measure again" */ }
  }

  return {
    rig:      grab('PHX_RIG'),
    bones:    parseInt(grab('PHX_BONES'), 10) || 0,
    action:   grab('PHX_ACTION') || null,
    verts:    parseInt(grab('PHX_VERTS'), 10) || 0,
    selected: parseInt(grab('PHX_SELECTED'), 10) || 0,
    glbMeshes: info.meshes,
    restaged, meshes, bytes, alpha,
  };
}

// ─── Unreal leg: Blend-Modus reparieren ───────────────────────────────────────

/**
 * Re-parent the imported MaterialInstances from the Blend parent to the Opaque or Mask one,
 * and set AlphaCutoff where masked.
 *
 * 🪤 THREE TRAPS, each measured separately (2026-08-01):
 *
 * 1. Setting `blend_mode` on the instance DOES NOTHING. The translucency comes from the parent
 *    (MI_Default_Blend_DS) and `override_blend_mode` is False. So the PARENT is swapped —
 *    same family, other variant.
 * 2. The alpha channel alone masks nothing. Unreal's glTF base material has its own scalar
 *    parameter `AlphaCutoff` defaulting to 0.0 — at 0 every texel passes, and the eyelash card
 *    stays a black rectangle over the eye. NOT to be confused with
 *    BasePropertyOverrides.opacity_mask_clip_value; that was the wrong screw.
 * 3. The lookup goes through the TEXTURE name, not the material name. One material is called
 *    `Human.body.001` in Blender, `Human.body` in the GLB and `Human_body` in Unreal — three
 *    renames in a row. The texture name (`brown_eye`) survives all three.
 *
 * A texture missing from the profile is NOT guessed at: it is left untouched and reported. A
 * silent default here is exactly the mistake that cost the eyes.
 */
async function applyAlphaModes(destPath, profile, cfg) {
  const body = [
    'import unreal, json',
    'prof   = json.loads(' + JSON.stringify(JSON.stringify(profile || {})) + ')',
    'thresh = ' + MASK_THRESHOLD_PCT,
    'cutoff = ' + ALPHA_CUTOFF,
    'root   = ' + JSON.stringify(destPath),
    '',
    'ar  = unreal.AssetRegistryHelpers.get_asset_registry()',
    'els = unreal.get_editor_subsystem(unreal.EditorAssetSubsystem)',
    'mel = unreal.MaterialEditingLibrary',
    'out = []',
    '',
    'for a in ar.get_assets_by_path(root, recursive=True):',
    '    if str(a.asset_class_path.asset_name) != "MaterialInstanceConstant":',
    '        continue',
    '    name = str(a.asset_name)',
    '    mi   = a.get_asset()',
    '    par  = mi.get_editor_property("parent")',
    '    if par is None:',
    '        out.append({"mat": name, "action": "skipped", "why": "no parent"})',
    '        continue',
    '    old = par.get_name()',
    '    if "_Blend_" not in old:',
    '        out.append({"mat": name, "action": "unchanged", "why": "parent " + old + " is not a Blend variant"})',
    '        continue',
    '',
    '    # Which BaseColor texture is attached? That is the key into the alpha profile.',
    '    tex = None',
    '    for tp in mi.texture_parameter_values:',
    '        if str(tp.parameter_info.name) == "BaseColorTexture" and tp.parameter_value:',
    '            tex = tp.parameter_value.get_name()',
    '',
    '    # 🪤 Unreal does NOT deduplicate textures. In the GLB six "textures" point at the same',
    '    # "image"; the importer creates six assets from that and numbers them:',
    '    #   middleage_lightskinned_male_diffuse, ...diffuse1 ... ...diffuse5',
    '    #   eyebrow003 -> additionally eyebrow0031',
    '    # The Blender name knows nothing of those numbers. So trim digits from the end until',
    '    # the profile matches. Stop at the FIRST hit — that lands "eyebrow0031" on',
    '    # "eyebrow003" and not on "eyebrow00", even though the name itself ends in digits.',
    '    key = tex',
    '    while key and key not in prof and key[-1].isdigit():',
    '        key = key[:-1]',
    '    if tex is None or key not in prof:',
    '        out.append({"mat": name, "action": "skipped",',
    '                    "why": "no alpha measurement for texture " + str(tex)})',
    '        continue',
    '',
    '    pct    = float(prof[key])',
    '    masked = pct >= thresh',
    '    new    = old.replace("_Blend_", "_Mask_" if masked else "_Opaque_")',
    '    np_    = "/InterchangeAssets/gltf/MaterialInstances/%s.%s" % (new, new)',
    '    newpar = unreal.load_asset(np_)',
    '    if newpar is None:',
    '        out.append({"mat": name, "action": "skipped", "why": "target material missing: " + np_})',
    '        continue',
    '',
    '    mi.set_editor_property("parent", newpar)',
    '    if masked:',
    '        mel.set_material_instance_scalar_parameter_value(mi, "AlphaCutoff", cutoff)',
    '    mel.update_material_instance(mi)',
    '    saved = bool(els.save_loaded_asset(mi, False))',
    '',
    '    # Verify against the object, not against our own call: what does it actually say now?',
    '    got = mi.get_editor_property("parent").get_name()',
    '    out.append({"mat": name, "tex": tex, "key": key, "pct": pct,',
    '                "mode": "MASK" if masked else "OPAQUE",',
    '                "from": old, "to": got, "ok": got == new, "saved": saved,',
    '                "action": "changed"})',
    '',
    'print("PHX_ALPHAFIX:", json.dumps(out))',
  ];

  // 🪤 THIS CALL LANDS IMMEDIATELY AFTER A LARGE IMPORT, AND THAT IS EXACTLY WHERE THE BRIDGE
  // IS FRAGILE. Measured 2026-08-01 on the user's first UI click: the import of 36 assets went
  // through, the very next call died with
  //     ConnectionAbortedError: [WinError 10053]
  // The editor was busy with the asset registry scan and dropped the connection.
  // What the user saw: "CHARACTER_TO_UNREAL_ERROR", while the character had long been in the
  // project — just uncorrected, and therefore see-through. That is the worst kind of feedback:
  // it reads as "nothing happened" when it is really "half happened".
  // Retrying is safe here because the loop above skips every material whose parent no longer
  // contains "_Blend_" — a second run changes nothing.
  const ipc = require('./unreal-ipc');
  const transient = e => /10053|10054|ConnectionAborted|ConnectionReset|forcibly closed/i.test(
    e && e.message || String(e));

  let out, lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      out = await ipc.callUnrealGuarded(body, { cfg, timeoutMs: 180000 });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (!transient(e) || attempt === 3) break;
      await new Promise(r => setTimeout(r, 2000 * attempt));   // give the editor room to finish
    }
  }
  if (lastErr) {
    throw new Error(
      'The blend correction never reached Unreal (' + (lastErr.message || lastErr) + '). ' +
      'The import itself is unaffected — the character IS in the project, but with the blend ' +
      'materials it was imported with, i.e. translucent. Running this again picks it up.');
  }

  const m = out.match(/^PHX_ALPHAFIX:\s*(.*)$/m);
  if (!m) throw new Error('Unreal reported no result for the blend correction:\n' + out);
  return JSON.parse(m[1]);
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * @param {object}  opts
 * @param {string}  [opts.rig]        armature name; omitted → first mixamorig rig in the scene
 * @param {string}  [opts.name]       name under the Unreal content path; defaults to the rig name
 * @param {string}  [opts.unrealPath] content root, default /Game/PhoenixCharacters
 * @param {boolean} [opts.withAnimation] include the current action (see note 3 — FBX is the
 *                                       right carrier for animation; this is preview-grade)
 * @param {boolean} [opts.refresh]    re-export even if a GLB is cached
 * @param {object}  [opts.cfg]        phoenix config
 */
async function characterToUnreal(opts = {}) {
  const cfg   = opts.cfg;
  const steps = [];

  // No cache reuse when the animation flag differs — the two files are not interchangeable
  // and silently serving the wrong one is exactly the kind of bug a cache introduces.
  const suffix  = opts.withAnimation ? '_anim' : '';
  const stableName = opts.name && String(opts.name).trim();
  const slug    = slugify(stableName || opts.rig || 'character') + suffix;
  const glbPath = path.join(CACHE_DIR, slug + '.glb');

  // Cache retired for the Unreal path. The key can only be the requested NAME, but the content is
  // "whatever mixamorig is in the scene right now" — so an unnamed default served the PREVIOUS figure,
  // and a named export whose dropdown didn't match the placed rig cached the WRONG figure under that
  // name for good (both found in the v1.7.0 function review). A Blender re-export costs a few seconds
  // (async since spawn-node); a wrong character in a demo costs more. Always rebuild. (stableName is
  // still used for the output GLB filename above.)
  const cached = false;
  let built = null;
  if (cached) {
    steps.push(`GLB from cache (${fs.statSync(glbPath).size} bytes) — Blender not involved`);
  } else {
    built = await exportCharacterGlb(opts.rig, glbPath, cfg, { withAnimation: !!opts.withAnimation });
    steps.push(
      `exported ${built.rig}: ${built.bones} bones, ${built.meshes.length} mesh(es), ` +
      `${built.verts} verts (${built.bytes} bytes, ${built.glbMeshes} mesh(es) in the GLB)`
    );
    if (built.restaged.length) {
      steps.push(
        `${built.restaged.length} object(s) were hidden (Human-tab staging) — unhidden for the ` +
        `export and put back afterwards`
      );
    }
    if (opts.withAnimation) {
      steps.push(built.action
        ? `animation included: "${built.action}" — glTF is preview-grade here; FBX is the ` +
          `carrier for AnimSequence work`
        : `⚠️ animation requested but the rig has no action assigned — nothing to include`);
    }
  }

  const base     = slugify(opts.name || (built && built.rig) || opts.rig || 'character');
  const destPath = (opts.unrealPath || DEFAULT_UNREAL_PATH).replace(/\/+$/, '') + '/' + base;

  const imported = await importIntoUnreal(glbPath, destPath, cfg);
  if (!imported.count) {
    throw new Error(
      `Unreal reported the import but ${destPath} is empty. import_scene returns True even ` +
      `when it creates nothing, so the count — not the return value — is the result.`
    );
  }
  if (imported.flatMaterials.length) {
    throw new Error(
      `Imported into ${destPath}, but ${imported.flatMaterials.length} material(s) arrived with ` +
      `no parameters (${imported.flatMaterials.join(', ')}) — they will render black.`
    );
  }
  steps.push(`imported into ${destPath} (${imported.count} assets)`);

  // The skeleton is reported, never chosen silently — see header note 4.
  const skeletons = imported.assets.filter(a => a.type === 'Skeleton').map(a => a.path);
  const skelMesh  = imported.assets.filter(a => a.type === 'SkeletalMesh').map(a => a.path);
  if (!skelMesh.length) {
    steps.push(
      `⚠️ NO SkeletalMesh among the imported assets — the character arrived as static geometry. ` +
      `That means the skin did not travel; check that the armature was in the selection.`
    );
  }
  if (skeletons.length) {
    steps.push(
      `skeleton(s) created: ${skeletons.join(', ')} — every character imported this way gets ` +
      `its OWN skeleton unless they are merged, and separate skeletons mean no shared clip library`
    );
  }

  // Blend correction BEFORE saving, so the changed materials go to disk with everything else
  // instead of living only in the editor's memory.
  // From the export, or — on a cache hit — from the sidecar next to the GLB.
  let profile = (built && built.alpha) || null;
  let profileFrom = 'export';
  if (!profile || !Object.keys(profile).length) {
    profile = null;
    try {
      const side = alphaSidecar(glbPath);
      if (fs.existsSync(side)) {
        profile = JSON.parse(fs.readFileSync(side, 'utf8'));
        profileFrom = 'sidecar';
      }
    } catch (_) { profile = null; }
  }

  let alphaFix = [];
  if (profile && Object.keys(profile).length) {
    if (profileFrom === 'sidecar') {
      steps.push(`alpha profile read from ${path.basename(alphaSidecar(glbPath))} (GLB was cached, ` +
                 `so Blender did not run)`);
    }
    alphaFix = await applyAlphaModes(destPath, profile, cfg);
    const changed = alphaFix.filter(r => r.action === 'changed');
    const failed  = changed.filter(r => !r.ok || !r.saved);
    const skipped = alphaFix.filter(r => r.action === 'skipped');
    if (changed.length) {
      const masked = changed.filter(r => r.mode === 'MASK').map(r => `${r.mat} ${r.pct}%`);
      const opaque = changed.filter(r => r.mode === 'OPAQUE').map(r => r.mat);
      steps.push(
        `blend fixed on ${changed.length} material(s) — MPFB exports everything as ` +
        `alphaMode:BLEND, which arrives translucent. OPAQUE: ${opaque.join(', ') || '—'}; ` +
        `MASK (cutoff ${ALPHA_CUTOFF}): ${masked.join(', ') || '—'}`
      );
    }
    if (failed.length) {
      steps.push(`⚠️ ${failed.length} material(s) did not take the new parent: ` +
                 failed.map(r => r.mat).join(', '));
    }
    // Skipped materials are NAMED, not swallowed — otherwise "blend fixed" reads as "all
    // done" while one material quietly stays translucent.
    if (skipped.length) {
      steps.push(`⚠️ ${skipped.length} material(s) skipped (left as-is): ` +
                 skipped.map(r => `${r.mat} — ${r.why}`).join('; '));
    }
  } else if (built) {
    steps.push('⚠️ no alpha profile came back from Blender — materials left as imported, ' +
               'so the character may render translucent');
  } else {
    steps.push('⚠️ GLB came from cache AND no alpha profile lies beside it (the cache predates ' +
               'the sidecar) — materials left as imported. Re-run with refresh:true if the ' +
               'character renders translucent.');
  }

  const saved = await saveImportedAssets(imported.assets, cfg);
  steps.push(saved.failed.length
    ? `⚠️ saved ${saved.saved}/${saved.packages.length} — FAILED: ${saved.failed.join(', ')}`
    : `saved ${saved.saved} asset package(s) to disk`);
  steps.push('level NOT saved — the actor placement lives until you save the level yourself');

  return { slug, glb: glbPath, cached, destPath, steps, built, skeletons, skelMesh, saved,
           alphaFix, ...imported };
}

module.exports = { characterToUnreal, exportCharacterGlb, applyAlphaModes,
                   DEFAULT_UNREAL_PATH, CACHE_DIR, ALPHA_CUTOFF, MASK_THRESHOLD_PCT };
