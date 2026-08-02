'use strict';

/**
 * unreal-to-blender.js — carry something from Unreal back into Blender, in one call.
 *
 * TWO DOORS, and which one applies depends on whether the thing is IN THE LEVEL:
 *
 *   unrealToBlender({asset})    /Game/Path/Asset → GLTF*Exporter        → <slug>.glb → Blender
 *   unrealSelectionToBlender({actor})  actor tree → GLTFLevelExporter   → asm_<slug>.glb → Blender
 *
 * ⛔ UNTIL 2026-08-01 THIS FILE CALLED ITSELF "the mirror image of brush-to-unreal.js".
 * It never was. brush_to_unreal sends out an actor TREE with hierarchy; the asset-path route
 * can only fetch ONE part of that back. A "brush" built from it consisted of a quarter of the
 * object — and because the single part looked correct on its own, only the user noticed. Only
 * the second door makes the claim true.
 *
 * Everything here was measured against a live 5.8.1 editor on 2026-07-31, not read off
 * documentation. The three notes below are the ones that cost something.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. 🔴 THE MISSING metallicFactor — why every imported asset arrives as METAL
 *
 * glTF's spec default for `metallicFactor` is **1.0**. Unreal's exporter writes the key only
 * when the material carries one, so a material with no metallic input produces a GLB with the
 * key ABSENT — and every correct importer, Blender included, then reads 1.0. Measured on a
 * control: /Game/PhoenixBrushes/.../Cylinder_017, whose Unreal instance carries exactly three
 * parameters (EmissiveFactor, BaseColorFactor, RoughnessFactor) and no metallic at all, came
 * back into Blender at Metallic = 1.0.
 *
 * That is the same defect class as the Trellis one in mesh-import-fix.js, and it matters for
 * the same reason: metal does not show its own colour, it reflects its surroundings, so a dark
 * material renders BLACK and a light one merely renders wrong.
 *
 * ⛔ BUT IT IS NOT FIXED BY DEMETALLISING EVERYTHING. Some assets are genuinely metal, and
 * blanket-zeroing would silently destroy them — trading a visible bug for an invisible one.
 * So the GLB's own JSON is read here, per material, and ONLY the materials whose
 * metallicFactor is actually absent get corrected. A material that says 1.0 keeps 1.0.
 *
 * ⚠️ AND "ABSENT" IS NOT ENOUGH EITHER — this caught the first version of this file, on the
 * MetaHuman body. glTF's metallic is `metallicFactor × metallicRoughnessTexture.B`, so when a
 * material carries a metallicRoughness TEXTURE, the missing factor means "take the texture
 * unchanged" and 1.0 is exactly right. Zeroing it there cuts Blender's Separate Color link and
 * throws the measured channel away — the SRMF map whose B channel was established as Metallic
 * on 2026-07-30. The correction therefore needs BOTH conditions: no factor AND no texture.
 * Measured control pair: Cylinder_017 (no texture → genuinely wrong, corrected) against
 * spudermin_Body (metallicRoughnessTexture index 1 → correct as-is, left alone).
 *
 * 🔴 AND A COUNTER-EXAMPLE THAT BREAKS THE RULE — found 2026-08-01, still unresolved.
 * M_Gold on a three-part assembly satisfies BOTH conditions (no factor, no texture) and is
 * nevertheless RIGHT at 1.0: it imports as metallic=1.0, roughness=0.08, base colour
 * (1.00, 0.76, 0.10) and renders as gold. So "no factor and no texture" does NOT reliably mean
 * "spurious metal". Stranger still, two other materials of the SAME assembly did get
 * metallicFactor=0 written, and all three report Metallic=0.0 in Unreal.
 * skip_near_default_values was tested as the explanation and REFUTED — the switch does not
 * change the exported file by one byte.
 * ⇒ unrealToBlender() keeps correcting (that is the measured majority case), but
 * unrealSelectionToBlender() does NOT, and reports instead. Until the rule is understood, an
 * assembly route that silently strips metal is worse than one that occasionally hands over a
 * too-shiny material.
 *
 * 2. 🔴 A MATERIAL CAN ARRIVE THAT IS NOT A MATERIAL. If the Unreal asset's material slot is
 * empty, the glTF exporter substitutes Unreal's placeholder and the GLB contains a material
 * literally named `WorldGridMaterial` with three baked grid textures. Anyone who imports it
 * and sees textures will believe the material came along; it is the grey checker. Measured on
 * a MetaHuman groom card mesh. Detected and reported, not silently kept.
 *
 * 3. 🪤 THE Icosphere. Blender's glTF importer creates an `Icosphere` in a
 * `glTF_not_exported` collection on every import. It is not in the GLB and it is not yours.
 * It is filtered out of the reported objects so it cannot be mistaken for imported geometry.
 *
 * Scale is handled by Unreal: GLTFExportOptions.export_uniform_scale defaults to 0.01, i.e.
 * cm → m. The MetaHuman body came back at 1.07 × 0.40 × 1.42 m, which is metric and right.
 */

const fs   = require('fs');
const path = require('path');
const { spawnNode } = require('./spawn-node');

const { callBlender } = require('./blender-ipc');
const unrealIpc       = require('./unreal-ipc');

// Mirrors brush-cache/ and is out of staging/ for the same reason: listStagedFiles() treats
// every directory under staging/ as a palette category, so a cache folder there turns each
// cached file into a fake "staged asset" in the library.
const CACHE_DIR = path.join(__dirname, 'unreal-cache');

// Asset class → exporter. Read out of the live editor (`dir(unreal)` filtered for "Exporter"),
// not guessed. FBX equivalents exist (StaticMeshExporterFBX, SkeletalMeshExporterFBX,
// AnimSequenceExporterFBX) and are the right choice for ANIMATION — glTF is chosen here
// because this path carries geometry + materials, where FBX loses the embedded texture.
const EXPORTERS = {
  StaticMesh:   'GLTFStaticMeshExporter',
  SkeletalMesh: 'GLTFSkeletalMeshExporter',
  AnimSequence: 'GLTFAnimSequenceExporter',
};

const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const fwd     = p => p.replace(/\\/g, '/');

// "/Game/A/B" and "/Game/A/B.B" both mean the same asset; Unreal's loader wants the second.
// A dot only counts as the object separator when it is in the LAST path segment.
function objectPath(assetPath) {
  const clean = String(assetPath || '').trim().replace(/\/+$/, '');
  if (!clean.startsWith('/')) throw new Error(`asset path must start with / (got "${assetPath}")`);
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  if (last.includes('.')) return clean;
  return clean + '.' + last;
}

function assetName(assetPath) {
  const obj = objectPath(assetPath);
  return obj.slice(obj.lastIndexOf('.') + 1);
}

// ─── GLB inspection (local, no bridge) ────────────────────────────────────────

/**
 * Read a .glb's JSON chunk. This is where the metallicFactor question is settled, and it is
 * settled HERE rather than in Blender on purpose: once Blender's importer has applied the
 * spec default, "absent" and "explicitly 1.0" are indistinguishable — the information only
 * exists in the file.
 */
function readGlbJson(glbPath) {
  const b = fs.readFileSync(glbPath);
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46546C67) {   // 'glTF'
    throw new Error(`not a GLB file: ${glbPath}`);
  }
  const jsonLen = b.readUInt32LE(12);
  return JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'));
}

function inspectGlbMaterials(glbPath) {
  const j = readGlbJson(glbPath);
  const mats = j.materials || [];
  const noMetallic = [];
  const textureDriven = [];
  const placeholder = [];
  for (const m of mats) {
    const pbr = m.pbrMetallicRoughness || {};
    const hasFactor  = pbr.metallicFactor !== undefined;
    const hasTexture = pbr.metallicRoughnessTexture !== undefined;
    // No factor AND no texture => 1.0 with nothing behind it => spurious metal.
    // No factor BUT a texture => 1.0 is the multiplier the texture wants. Leave it.
    if (!hasFactor && !hasTexture) noMetallic.push(m.name);
    if (!hasFactor && hasTexture)  textureDriven.push(m.name);
    if (/WorldGridMaterial/i.test(m.name || '')) placeholder.push(m.name);
  }
  return {
    materials:   mats.map(m => m.name),
    noMetallic,                              // → will read as metal 1.0 unless corrected
    textureDriven,                           // → factor absent but a texture supplies it: correct
    placeholder,                             // → Unreal's grey checker, not the real material
    meshes:      (j.meshes || []).length,
    nodes:       (j.nodes  || []).length,
    images:      (j.images || []).length,
    animations:  (j.animations || []).length,
  };
}

// ─── Unreal leg ───────────────────────────────────────────────────────────────

const runUnreal = (lines, cfg, timeoutMs = 300000) =>
  unrealIpc.callUnrealGuarded(lines, { cfg, timeoutMs });

/** What kind of asset is this, and does an exporter exist for it? */
async function assetClass(assetPath, cfg) {
  const obj = objectPath(assetPath);
  const out = await runUnreal([
    'a = unreal.load_asset(' + JSON.stringify(obj) + ')',
    'if a is None:',
    '    print("PHX_CLASS: <none>")',
    'else:',
    '    print("PHX_CLASS:", type(a).__name__)',
  ], cfg, 120000);
  const cls = (out.match(/^PHX_CLASS:\s*(\S+)$/m) || [])[1] || '<none>';
  if (cls === '<none>') {
    throw new Error(
      `Unreal could not load ${obj}. Check the path in the content browser — ` +
      `"/Game/Foo/Bar" and "/Game/Foo/Bar.Bar" both work, a wrong one loads as None.`
    );
  }
  return cls;
}

/**
 * Export one asset to GLB.
 *
 * ⚠️ The export options are set EXPLICITLY rather than left to the exporter's stored defaults.
 * A UI-owned default is not a contract: it is whatever the operator last clicked in the export
 * dialog, and an automated path that inherits it produces different files on different
 * machines. export_emissive_strength is the one that visibly matters — without the
 * KHR_materials_emissive_strength extension glTF clamps emissive to 1.0, and Cylinder_017's
 * Unreal emissive of 3.0 came back as 1.0 in the first measured run.
 */
async function exportAsset(assetPath, glbPath, cfg) {
  const obj = objectPath(assetPath);
  const cls = await assetClass(assetPath, cfg);
  const exporter = EXPORTERS[cls];
  if (!exporter) {
    throw new Error(
      `no glTF exporter for asset class "${cls}". Known: ${Object.keys(EXPORTERS).join(', ')}. ` +
      `(Textures go through TextureExporterPNG.)`
    );
  }

  const out = await runUnreal([
    'import os',
    'obj = unreal.load_asset(' + JSON.stringify(obj) + ')',
    'dest = r' + JSON.stringify(fwd(glbPath)),
    'os.makedirs(os.path.dirname(dest), exist_ok=True)',
    'opts = unreal.GLTFExportOptions()',
    'opts.set_editor_property("export_vertex_skin_weights", True)',
    'opts.set_editor_property("export_morph_targets", True)',
    'opts.set_editor_property("export_emissive_strength", True)',
    'opts.set_editor_property("export_animation_sequences", True)',
    'task = unreal.AssetExportTask()',
    'task.set_editor_property("object", obj)',
    'task.set_editor_property("filename", dest)',
    'task.set_editor_property("automated", True)',
    'task.set_editor_property("replace_identical", True)',
    'task.set_editor_property("prompt", False)',
    'task.set_editor_property("options", opts)',
    'task.set_editor_property("exporter", unreal.' + exporter + '())',
    'ok = bool(unreal.Exporter.run_asset_export_task(task))',
    '# The return value is not the result — check the file, the same rule as import_scene.',
    'print("PHX_EXPORT_OK:", ok)',
    'print("PHX_BYTES:", os.path.getsize(dest) if os.path.isfile(dest) else 0)',
  ], cfg);

  const bytes = parseInt((out.match(/^PHX_BYTES:\s*(\d+)$/m) || [])[1], 10) || 0;
  if (!bytes) {
    throw new Error(
      `${exporter} reported ${(out.match(/^PHX_EXPORT_OK:\s*(\w+)$/m) || [])[1]} but wrote no ` +
      `file to ${glbPath}. The task's return value is not a result — this is the file check.`
    );
  }
  return { cls, exporter, bytes };
}

/**
 * Export an ACTOR TREE from the level — the assembly counterpart to exportAsset().
 *
 * 🔴 WHY THIS SECOND DOOR IS NEEDED. exportAsset() takes a content-browser path and returns
 * exactly ONE asset. But brush_to_unreal sends out an actor TREE (root + attached parts, each
 * with its own transform). Fetching that back through an asset path can only ever retrieve a
 * single part — and a "brush" built that way consisted of a quarter of the object (the
 * condensator, 2026-07-31).
 *
 * The route exists inside Unreal itself and was measured on 2026-08-01:
 *   set the selection → GLTFLevelExporter with AssetExportTask.selected = True → one GLB
 * Result on the control object: 3 meshes, 3 materials, hierarchy restored in Blender.
 *
 * 🪤 "ok=True" IS PARTICULARLY WORTHLESS HERE. The first measured attempt hit an empty actor
 * shell (after a level cleanup the root had no children left), reported success, and wrote a
 * VALID 332-byte GLB with not a single mesh in it. So BEFORE exporting, count how many of the
 * selected actors carry bounds at all, and refuse at zero — with the reason, not with an
 * empty file.
 */
async function exportSelection(actorLabel, glbPath, cfg) {
  const out = await runUnreal([
    'import os, json',
    'want = ' + JSON.stringify(String(actorLabel || '')),
    'eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    'ues = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)',
    '',
    'hits = [a for a in eas.get_all_level_actors() if a.get_actor_label() == want]',
    'if not hits:',
    '    print("PHX_ERROR: no actor labelled " + want + " in the level")',
    'elif len(hits) > 1:',
    '    # Labels are NOT unique in Unreal - "Scene" existed nine times in the test level.',
    '    # Silently taking one of them would be guessing, not determining.',
    '    print("PHX_ERROR: " + str(len(hits)) + " actors are called " + want +',
    '          " - the label is not unique, please give it a unique name")',
    'else:',
    '    tgt = hits[0]',
    '    def descend(x):',
    '        out = [x]',
    '        for c in x.get_attached_actors():',
    '            out.extend(descend(c))',
    '        return out',
    '    tree = descend(tgt)',
    '',
    '    geo, empty, hidden = [], [], []',
    '    for a in tree:',
    '        o, e = a.get_actor_bounds(False)',
    '        (empty if (e.x == 0 and e.y == 0 and e.z == 0) else geo).append(a.get_actor_label())',
    '        if a.is_hidden_ed():',
    '            hidden.append(a.get_actor_label())',
    '',
    '    print("PHX_TREE:" + json.dumps({"total": len(tree), "geo": geo,',
    '                                    "empty": empty, "hidden": hidden}))',
    '    if not geo:',
    '        print("PHX_ERROR: " + want + " and its " + str(len(tree) - 1) + " child(ren) carry ' +
      'no geometry - exporting that would produce a valid, empty GLB")',
    '    else:',
    '        # The user\'s selection is THEIRS - save it and put it back afterwards.',
    '        prev = eas.get_selected_level_actors()',
    '        try:',
    '            eas.set_selected_level_actors(tree)',
    '            got = len(eas.get_selected_level_actors())',
    '            if got != len(tree):',
    '                print("PHX_ERROR: the selection only took " + str(got) + " of " + str(len(tree)) +',
    '                      " actors")',
    '            else:',
    '                dest = r' + JSON.stringify(fwd(glbPath)),
    '                os.makedirs(os.path.dirname(dest), exist_ok=True)',
    '                if os.path.exists(dest):',
    '                    os.remove(dest)      # no stale file may pass as this result',
    '                opts = unreal.GLTFExportOptions()',
    '                # Set explicitly rather than inherited from the stored dialog defaults -',
    '                # same reasoning as exportAsset().',
    '                opts.set_editor_property("export_emissive_strength", True)',
    '                opts.set_editor_property("export_vertex_skin_weights", True)',
    '                opts.set_editor_property("export_morph_targets", True)',
    '                # Level furniture does not belong in an assembly.',
    '                opts.set_editor_property("export_lights", False)',
    '                opts.set_editor_property("export_cameras", False)',
    '                opts.set_editor_property("export_level_sequences", False)',
    '                opts.set_editor_property("export_animation_sequences", False)',
    '                task = unreal.AssetExportTask()',
    '                task.set_editor_property("object", ues.get_editor_world())',
    '                task.set_editor_property("filename", dest)',
    '                task.set_editor_property("automated", True)',
    '                task.set_editor_property("prompt", False)',
    '                task.set_editor_property("replace_identical", True)',
    '                task.set_editor_property("selected", True)',
    '                task.set_editor_property("options", opts)',
    '                task.set_editor_property("exporter", unreal.GLTFLevelExporter())',
    '                ok = bool(unreal.Exporter.run_asset_export_task(task))',
    '                for e in task.get_editor_property("errors"):',
    '                    print("PHX_EXPORT_ERR:", e)',
    '                print("PHX_EXPORT_OK:", ok)',
    '                print("PHX_BYTES:", os.path.getsize(dest) if os.path.isfile(dest) else 0)',
    '        finally:',
    '            eas.set_selected_level_actors(prev)',
  ], cfg);

  if (out.includes('PHX_ERROR')) {
    throw new Error(out.split('\n').find(l => l.includes('PHX_ERROR')).replace('PHX_ERROR:', '').trim());
  }
  let tree = { total: 0, geo: [], empty: [], hidden: [] };
  const tm = out.match(/^PHX_TREE:(.*)$/m);
  if (tm) { try { tree = JSON.parse(tm[1]); } catch (_) {} }

  const bytes = parseInt((out.match(/^PHX_BYTES:\s*(\d+)$/m) || [])[1], 10) || 0;
  if (!bytes) {
    throw new Error(
      `GLTFLevelExporter reported ${(out.match(/^PHX_EXPORT_OK:\s*(\w+)$/m) || [])[1]} but wrote no ` +
      `file to ${glbPath}. The task's return value is not a result — this is the file check.`
    );
  }
  return { tree, bytes, exporter: 'GLTFLevelExporter' };
}

// ─── Blender leg ──────────────────────────────────────────────────────────────

/**
 * Import the GLB and report what actually arrived.
 *
 * `fixMetallic` is the list of material names whose metallicFactor was ABSENT from the GLB —
 * computed from the file, never guessed here. Those and only those are set back to 0.
 *
 * 🪤 Blender uniquifies material names on collision (`M_Foo` → `M_Foo.001`), so matching by
 * exact name would silently miss every re-import. The match allows a `.NNN` suffix.
 */
async function importIntoBlender(glbPath, cfg, fixMetallic = []) {
  const py = [
    'import bpy, os, json, re',
    'glb = r' + JSON.stringify(fwd(glbPath)),
    'before = set(o.name for o in bpy.context.scene.objects)',
    'bpy.ops.import_scene.gltf(filepath=glb)',
    'fresh = [o for o in bpy.context.scene.objects if o.name not in before]',
    '',
    '# The importer manufactures an Icosphere in a glTF_not_exported collection on every run.',
    '# It is not in the file and reporting it as imported geometry would be a lie.',
    'def is_noise(o):',
    '    if not o.name.startswith("Icosphere"):',
    '        return False',
    '    return any(c.name.startswith("glTF_not_exported") for c in o.users_collection)',
    'noise = [o for o in fresh if is_noise(o)]',
    'real  = [o for o in fresh if o not in noise]',
    '',
    'fix = set(json.loads(' + JSON.stringify(JSON.stringify(fixMetallic)) + '))',
    'def wants_fix(name):',
    '    for f in fix:',
    '        if name == f or re.fullmatch(re.escape(f) + r"\\.\\d{3}", name):',
    '            return True',
    '    return False',
    '',
    'fixed = []',
    'seen_mats = set()',
    'for o in real:',
    '    for slot in getattr(o, "material_slots", []):',
    '        m = slot.material',
    '        if not m or m.name in seen_mats:',
    '            continue',
    '        seen_mats.add(m.name)',
    '        if not (m.use_nodes and wants_fix(m.name)):',
    '            continue',
    '        for n in m.node_tree.nodes:',
    '            if n.type != "BSDF_PRINCIPLED":',
    '                continue',
    '            inp = n.inputs.get("Metallic")',
    '            if inp is None:',
    '                continue',
    '            # A LINK beats default_value, so it has to go first — same lesson as',
    '            # mesh-import-fix.js. Here there is normally no link; belt and braces.',
    '            for lk in list(inp.links):',
    '                m.node_tree.links.remove(lk)',
    '            inp.default_value = 0.0',
    '            fixed.append(m.name)',
    '',
    'out = {"objects": [], "armatures": [], "materials": sorted(seen_mats),',
    '       "metallicFixed": sorted(set(fixed)), "noise": [o.name for o in noise]}',
    'for o in real:',
    '    e = {"name": o.name, "type": o.type, "parent": o.parent.name if o.parent else None}',
    '    if o.type == "MESH":',
    '        e["verts"] = len(o.data.vertices)',
    '        e["vertexGroups"] = len(o.vertex_groups)',
    '        e["modifiers"] = [m.type for m in o.modifiers]',
    '        e["shapeKeys"] = len(o.data.shape_keys.key_blocks) if o.data.shape_keys else 0',
    '        e["dims"] = [round(d, 4) for d in o.dimensions]',
    '    if o.type == "ARMATURE":',
    '        e["bones"] = len(o.data.bones)',
    '        e["roots"] = [b.name for b in o.data.bones if b.parent is None]',
    '    out["objects"].append(e)',
    '    if o.type == "ARMATURE":',
    '        out["armatures"].append(o.name)',
    'print("PHX_RESULT:" + json.dumps(out))',
  ].join('\n');

  const r = await callBlender(py, { cfg, timeoutMs: 300000 });
  const out = String(r.stdout || '').trim();
  if (r.status !== 'ok') throw new Error(`Blender import failed: ${r.message || out}`);
  const m = out.match(/^PHX_RESULT:(.*)$/m);
  if (!m) throw new Error(`Blender gave no result. Output was:\n${out.slice(0, 800)}`);
  return JSON.parse(m[1]);
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * @param {object}  opts
 * @param {string}  opts.asset      Unreal content path, e.g. "/Game/MHExport/spudermin_Body"
 * @param {boolean} [opts.refresh]  re-export even if the GLB is cached
 * @param {boolean} [opts.exportOnly] stop after the GLB — do not touch Blender
 * @param {object}  [opts.cfg]      phoenix config (the Unreal bridge needs it to find the engine)
 */
async function unrealToBlender(opts = {}) {
  const cfg   = opts.cfg;
  const asset = opts.asset;
  if (!asset) throw new Error('asset required, e.g. "/Game/MHExport/spudermin_Body"');

  // Key by the FULL content path, not just the leaf name: /Game/A/SM_Crate and /Game/B/SM_Crate are
  // different assets that share a name, and a name-only key served A's geometry when B was requested
  // (found in the v1.7.0 function review). The full path is unique per asset.
  const slug    = slugify(asset);
  const glbPath = path.join(CACHE_DIR, slug + '.glb');
  const steps   = [];

  const cached = fs.existsSync(glbPath) && fs.statSync(glbPath).size > 0 && !opts.refresh;
  let exported = null;
  if (cached) {
    steps.push(`GLB from cache (${fs.statSync(glbPath).size} bytes) — Unreal not involved`);
  } else {
    exported = await exportAsset(asset, glbPath, cfg);
    steps.push(`exported ${exported.cls} via ${exported.exporter} (${exported.bytes} bytes)`);
  }

  const glb = inspectGlbMaterials(glbPath);

  // Reported, never silently kept: the operator would see textures and believe the material
  // travelled. It did not — the source slot was empty and this is Unreal's grey checker.
  if (glb.placeholder.length) {
    steps.push(
      `⚠️ ${glb.placeholder.length} placeholder material(s) (${glb.placeholder.join(', ')}) — ` +
      `the source asset has an EMPTY material slot, so the exporter substituted Unreal's grid ` +
      `checker. The real look is not in this file and has to be rebuilt in Blender.`
    );
  }
  if (glb.noMetallic.length) {
    steps.push(
      `${glb.noMetallic.length} material(s) carry no metallicFactor and no metallicRoughness ` +
      `texture — glTF's default is 1.0, so they would import as metal. Corrected to 0 on import.`
    );
  }
  if (glb.textureDriven.length) {
    steps.push(
      `${glb.textureDriven.length} material(s) take metallic from a texture (${glb.textureDriven.join(', ')}) ` +
      `— left untouched on purpose; the missing factor is the multiplier, not a defect.`
    );
  }

  if (opts.exportOnly) {
    return { asset, slug, glb: glbPath, cached, steps, glbInfo: glb, exported, blender: null };
  }

  const blender = await importIntoBlender(glbPath, cfg, glb.noMetallic);
  const meshes  = blender.objects.filter(o => o.type === 'MESH');
  steps.push(
    `imported into Blender: ${blender.objects.length} object(s)` +
    (blender.armatures.length ? `, ${blender.armatures.length} armature(s)` : '') +
    (meshes.length ? `, ${meshes.reduce((n, o) => n + (o.verts || 0), 0)} verts` : '')
  );
  if (blender.metallicFixed.length) {
    steps.push(`demetallised ${blender.metallicFixed.length}: ${blender.metallicFixed.join(', ')}`);
  }

  return { asset, slug, glb: glbPath, cached, steps, glbInfo: glb, exported, blender };
}

/**
 * Fetch an ASSEMBLY out of the level into Blender — the second door of the return route.
 *
 * unrealToBlender() takes a content-browser path and returns a single asset. That is right for
 * an asset that is not in the level at all. Anything made of several parts with their own
 * transforms — i.e. every brush that went out through brush_to_unreal — needs this route.
 *
 * @param {object}  opts
 * @param {string}  opts.actor        actor label in the level, e.g. "electronic_part_b"
 * @param {boolean} [opts.refresh]    re-export even if a GLB is cached
 * @param {boolean} [opts.exportOnly] export only, do not import into Blender
 * @param {boolean} [opts.fixMetallic] force a missing metallicFactor to 0. OFF BY DEFAULT —
 *        see the reasoning below; switched on it destroys genuine metal.
 */
async function unrealSelectionToBlender(opts = {}) {
  const cfg   = opts.cfg;
  const actor = opts.actor;
  if (!actor) throw new Error('actor required — the label in the level, e.g. "electronic_part_b"');

  const slug    = slugify(actor);
  const glbPath = path.join(CACHE_DIR, 'asm_' + slug + '.glb');
  const steps   = [];

  const cached = fs.existsSync(glbPath) && fs.statSync(glbPath).size > 0 && !opts.refresh;
  let exported = null;
  if (cached) {
    steps.push(`GLB from cache (${fs.statSync(glbPath).size} bytes) — Unreal not involved`);
  } else {
    exported = await exportSelection(actor, glbPath, cfg);
    steps.push(
      `exported ${exported.tree.geo.length} part(s) carrying geometry out of ${exported.tree.total} ` +
      `actor(s) in the tree (${exported.bytes} bytes)`
    );
    // Empty shells are normal (a brush root IS one), but NAMING them is the difference
    // between "3 of 4 exported" and a silent partial result.
    if (exported.tree.empty.length) {
      steps.push(`structure only, no geometry: ${exported.tree.empty.join(', ')}`);
    }
    // export_hidden_in_game is False: a part hidden in the editor is missing from the GLB
    // without anything failing. That MUST surface, or the missing part gets hunted in the mesh.
    if (exported.tree.hidden.length) {
      steps.push(
        `⚠️ hidden in the editor and therefore NOT exported: ${exported.tree.hidden.join(', ')} — ` +
        `unhide and re-run with refresh:true if they should come along`
      );
    }
  }

  const glb = inspectGlbMaterials(glbPath);
  if (!glb.meshes) {
    throw new Error(
      `The GLB contains not a single mesh (${fs.statSync(glbPath).size} bytes). The export ran, ` +
      `but the selection carried nothing — usually a root with no children.`
    );
  }
  steps.push(`GLB: ${glb.meshes} mesh(es), ${glb.nodes} node(s), ${glb.materials.length} material(s)`);

  if (glb.placeholder.length) {
    steps.push(
      `⚠️ ${glb.placeholder.length} placeholder material(s) (${glb.placeholder.join(', ')}) — ` +
      `the material slot in Unreal is EMPTY and the exporter substituted Unreal's grid checker.`
    );
  }

  // 🔴 metallicFactor: DELIBERATELY NOT CORRECTED HERE, UNLIKE IN unrealToBlender().
  // Measured 2026-08-01 on a three-part assembly: M_Gold arrives with no metallicFactor and no
  // metallicRoughness texture — exactly the condition under which unrealToBlender() forces 0.
  // In Blender it landed at metallic=1.0, roughness=0.08, base colour (1.00, 0.76, 0.10) and
  // renders as gold. The "correction" would have demetallised it.
  // Why Unreal writes metallicFactor=0 for two materials of the same assembly and nothing at
  // all for the third is UNRESOLVED — skip_near_default_values was tested as the explanation
  // and refuted (the switch does not change the file by a single byte). While that is open,
  // reporting is right and intervening is wrong: a visibly too-metallic material can be dialled
  // back by hand, a discarded metal property is something nobody notices.
  const fixList = opts.fixMetallic ? glb.noMetallic : [];
  if (glb.noMetallic.length) {
    steps.push(
      (opts.fixMetallic ? '' : 'ℹ️ ') +
      `${glb.noMetallic.length} material(s) carry no metallicFactor (${glb.noMetallic.join(', ')}) — ` +
      `glTF's default is 1.0, so they arrive as metal. ` +
      (opts.fixMetallic
        ? 'Set to 0 (fixMetallic was requested).'
        : 'LEFT ALONE: for a gold material 1.0 is correct, and which case applies is currently ' +
          'not decidable. Force it with fixMetallic:true.')
    );
  }

  if (opts.exportOnly) {
    return { actor, slug, glb: glbPath, cached, steps, glbInfo: glb, exported, blender: null };
  }

  const blender = await importIntoBlender(glbPath, cfg, fixList);
  const meshes  = blender.objects.filter(o => o.type === 'MESH');
  const roots   = blender.objects.filter(o => !o.parent);
  steps.push(
    `in Blender: ${blender.objects.length} object(s) — ${meshes.length} mesh(es), ` +
    `${roots.length} root(s), ${meshes.reduce((n, o) => n + (o.verts || 0), 0)} verts`
  );

  // The hierarchy IS the result of this route — it gets reported, not assumed.
  const parented = blender.objects.filter(o => o.parent);
  steps.push(parented.length
    ? `hierarchy preserved: ${parented.map(o => `${o.name}→${o.parent}`).join(', ')}`
    : `⚠️ NOT ONE object has a parent — the assembly arrived as loose parts, not as a tree`);

  if (blender.metallicFixed.length) {
    steps.push(`demetallised: ${blender.metallicFixed.join(', ')}`);
  }

  return { actor, slug, glb: glbPath, cached, steps, glbInfo: glb, exported, blender };
}

/**
 * Unreal asset → Blender → Phoenix brush library, in one call.
 *
 * The missing half of the round trip: brush_to_unreal sends a brush out, this turns something
 * that only existed in Unreal into a brush that can be placed anywhere.
 *
 * 🪤 save_brush.js takes ONLY MESH OBJECTS (`o.type == 'MESH'`, three times over). An armature
 * is dropped, so a rigged character saved this way would arrive skinless. That is why a
 * SkeletalMesh is refused here rather than half-saved — characters belong in the Human tab or
 * the Custom-Rig tab, which is the same routing rule characters.js applies.
 *
 * ⚠️ THE IMPORTED OBJECTS ARE REMOVED ONLY AFTER THE BRUSH IS VERIFIED IN THE REGISTRY —
 * same rule as brush-to-unreal.js. Deleting on the strength of an exit code would mean a
 * failed save silently costs the geometry that was just fetched.
 */
async function unrealToBrush(opts = {}) {
  const cfg   = opts.cfg;
  const asset = opts.asset;
  if (!asset) throw new Error('asset required, e.g. "/Game/Props/SM_Crate"');

  const imported = await unrealToBlender({ asset, refresh: opts.refresh, cfg });
  const steps    = imported.steps.slice();

  const objects = imported.blender.objects;
  const meshes  = objects.filter(o => o.type === 'MESH');
  const arms    = objects.filter(o => o.type === 'ARMATURE');

  const cleanup = async () => {
    const names = objects.map(o => o.name);
    await callBlender([
      'import bpy, json',
      'for n in json.loads(' + JSON.stringify(JSON.stringify(names)) + '):',
      '    o = bpy.data.objects.get(n)',
      '    if o: bpy.data.objects.remove(o, do_unlink=True)',
      'print("PHX_CLEANED")',
    ].join('\n'), { cfg, timeoutMs: 60000 });
  };

  if (arms.length) {
    await cleanup();
    throw new Error(
      `${asset} is rigged (${arms.length} armature: ${arms.map(a => a.name).join(', ')}). ` +
      `A brush holds meshes only — save_brush drops armatures, so the rig would be lost ` +
      `silently. Rigged characters go through the Human tab (mixamorig) or the Custom-Rig tab. ` +
      `The imported objects were removed again.`
    );
  }
  if (!meshes.length) {
    await cleanup();
    throw new Error(`${asset} produced no mesh objects in Blender — nothing to save as a brush.`);
  }

  // Default the brush name to the asset's LEAF name, not imported.slug — the latter is now the
  // full content-path slug (cache key), so a brush from /Game/Props/SM_Crate would otherwise be
  // named "game_props_sm_crate". The tool doc promises "defaults to the asset name".
  const brushName = opts.name || assetName(asset);

  // Select exactly the imported meshes: save_brush.js with neither --object nor --collection
  // takes the current selection, which is the only form that handles a multi-mesh import.
  const selOut = await callBlender([
    'import bpy, json',
    'names = json.loads(' + JSON.stringify(JSON.stringify(meshes.map(o => o.name))) + ')',
    'bpy.ops.object.select_all(action="DESELECT")',
    'picked = []',
    'for n in names:',
    '    o = bpy.data.objects.get(n)',
    '    if not o:',
    '        continue',
    '    o.hide_viewport = False        # a hidden object cannot be selected, silently',
    '    o.select_set(True)',
    '    if o.select_get():',
    '        picked.append(n)',
    'if picked:',
    '    bpy.context.view_layer.objects.active = bpy.data.objects[picked[0]]',
    'print("PHX_PICKED:" + json.dumps(picked))',
  ].join('\n'), { cfg, timeoutMs: 60000 });

  const pickedMatch = String(selOut.stdout || '').match(/^PHX_PICKED:(.*)$/m);
  const picked = pickedMatch ? JSON.parse(pickedMatch[1]) : [];
  if (picked.length !== meshes.length) {
    await cleanup();
    throw new Error(
      `could only select ${picked.length} of ${meshes.length} imported meshes — save_brush ` +
      `would have stored a partial brush. Nothing was saved; the import was removed again.`
    );
  }
  steps.push(`selected ${picked.length} mesh(es) for the brush`);

  const argv = ['--name', brushName];
  if (opts.category) argv.push('--category', opts.category);
  if (opts.display)  argv.push('--display', opts.display);
  if (opts.force)    argv.push('--force');
  const r = await spawnNode(path.join(__dirname, 'save_brush.js'), argv, { timeoutMs: 180000, maxBuffer: 4 * 1024 * 1024 });
  if (r.error)      throw new Error(`save_brush: ${r.error.message}`);
  if (r.code !== 0) throw new Error(`save_brush (exit ${r.code}): ${(r.stderr || r.stdout || '').trim()}`);

  // The exit code is not the result — read the registry back, the same way the Unreal leg
  // counts assets instead of trusting import_scene's return value.
  const slug = String(brushName).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'brushes', 'registry.json'), 'utf8'));
  if (!registry.brushes || !registry.brushes[slug]) {
    throw new Error(
      `save_brush reported success but "${slug}" is not in registry.json. The imported objects ` +
      `were LEFT in the Blender scene on purpose so nothing is lost.`
    );
  }
  steps.push(`saved as brush "${slug}" (${meshes.length} mesh(es))`);

  if (!opts.keepInBlender) {
    await cleanup();
    steps.push('removed the imported objects from the Blender scene again');
  }

  return { asset, slug, brush: registry.brushes[slug], steps, meshes: meshes.map(o => o.name) };
}

module.exports = {
  unrealToBlender, unrealSelectionToBlender, unrealToBrush,
  exportAsset, exportSelection, inspectGlbMaterials, readGlbJson,
  objectPath, assetName, EXPORTERS, CACHE_DIR,
};
