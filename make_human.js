'use strict';

// ─── MakeHuman (MPFB2) generator ──────────────────────────────────────────────
//
// Creates a parametric MakeHuman character directly inside the running Blender via
// the file-IPC bridge (callBlender). MPFB2 is an in-Blender add-on, so this is NOT a
// ComfyUI/Trellis pipeline job and NOT a static brush — it builds fresh geometry each
// call from the macro sliders below, applies a skin material, and can attach body
// parts (eyes/teeth/eyebrows/eyelashes/hair) and clothes.
//
// Requires the MPFB2 add-on installed+enabled in the Blender that hosts the IPC dir.
// Photoreal skins / eyes / hair / clothes come from the MakeHuman *system-assets* pack
// (makehuman_system_assets, extracted into MPFB's user-data dir). If that pack is NOT
// installed, list_mhmat_assets/list_mhclo_assets return empty and this code degrades
// gracefully: the body still gets a procedural (skin-toned SSS) material and the part
// toggles simply no-op with a warning. Nothing throws.
//
// INPUT (all optional):
//   Macros (0..1): gender (0=female,1=male), age, muscle, weight, height, proportions,
//                  cupsize, firmness
//   race:   {asian, caucasian, african}  (0..1 each; dominant one drives skin choice)
//   rig:    true / "default" — add MPFB's standard weighted skeleton
//           "mixamo" — add the Mixamo-named skeleton (required for Mixamo/FBX retargeting)
//   name:   scene object name
//   skin:   false  -> procedural skin (no asset needed)
//           "<substr>" -> use the skin asset whose filename contains <substr>
//           (default/omitted) -> auto-match a skin to gender+age+race
//   eyes / teeth / eyebrows / eyelashes: booleans (default: eyes/teeth/brows/lashes ON)
//   eyeColor:  "brown"|"blue"|"green"|... — eye-color material for the eyeballs
//   hair:   true (default style) | "<substr>" (style e.g. short01/long01/afro01/bob01/
//           ponytail01/braid01) | omitted/false -> no hair
//   clothes: "<substr>" or ["<substr>", ...] — clothing assets (e.g. male_casualsuit01)
//   targets: { "nose/nose-scale-horiz-more": 0.7, ... } — MakeHuman detail targets (0..1)

const path = require('path');
const { callBlender } = require('./blender-ipc');

// Where the tab's face preview lands. Must be under the repo's own output/ so the server's
// /file?p= route will serve it (server.js sets workingDir to the repo root).
const PREVIEW_ABS = path.join(__dirname, 'output', 'human-preview.png');
const PREVIEW_REL = 'output/human-preview.png';

const MACRO_KEYS = ['gender', 'age', 'muscle', 'weight', 'height', 'proportions', 'cupsize', 'firmness'];
const RACE_KEYS  = ['asian', 'caucasian', 'african'];

function clamp01(v) {
  v = Number(v);
  if (!isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}
function num(v, dflt) { const c = clamp01(v); return c === null ? dflt : c; }
function safeName(s)   { return String(s).replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 40); }
function safeAsset(s)  { return String(s).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 60); }
function safeTarget(s) { return String(s).replace(/[^A-Za-z0-9/_\-]/g, '').slice(0, 80); }
function isOn(v, dfltOn) {
  if (v === undefined || v === null) return dfltOn;
  return v !== false && v !== 'false' && v !== 0 && v !== '0';
}

// Build the Python snippet. Params validated + coerced in JS; asset *names* are
// sanitized to a safe charset and resolved to real files in Python (by basename
// substring) — there is no path/string injection surface from the input.
function buildMakeHumanCode(input = {}) {
  // ── macros ──
  const overrides = [];
  for (const k of MACRO_KEYS) {
    if (input[k] !== undefined && input[k] !== null) {
      const v = clamp01(input[k]);
      if (v !== null) overrides.push(`    macro[${JSON.stringify(k)}] = ${v}`);
    }
  }
  if (input.race && typeof input.race === 'object') {
    const parts = [];
    for (const rk of RACE_KEYS) {
      if (input.race[rk] !== undefined) {
        const v = clamp01(input.race[rk]);
        if (v !== null) parts.push(`${JSON.stringify(rk)}: ${v}`);
      }
    }
    if (parts.length) overrides.push(`    macro["race"].update({${parts.join(', ')}})`);
  }
  const overrideBlock = overrides.length ? overrides.join('\n') : '    pass';

  const nm = safeName((typeof input.name === 'string' && input.name.trim()) ? input.name.trim() : 'Human') || 'Human';

  // ── derive skin-match tokens from the macros ──
  const genderTok = num(input.gender, 0.5) >= 0.5 ? 'male' : 'female';
  const ageVal    = num(input.age, 0.5);
  const ageBucket = ageVal < 0.4 ? 'young' : (ageVal > 0.7 ? 'old' : 'middleage');
  let race = 'caucasian';
  if (input.race && typeof input.race === 'object') {
    let best = -1;
    for (const rk of RACE_KEYS) { const v = clamp01(input.race[rk]); if (v !== null && v > best) { best = v; race = rk; } }
  }

  const skinMode  = (input.skin === false || input.skin === 'false') ? 'procedural'
                  : (typeof input.skin === 'string' && input.skin.trim()) ? 'named' : 'auto';
  const skinNamed = skinMode === 'named' ? safeAsset(input.skin) : '';

  // ── parts ──
  const wantEyes   = isOn(input.eyes, true);
  const wantTeeth  = isOn(input.teeth, true);
  const wantBrows  = isOn(input.eyebrows, true);
  const wantLashes = isOn(input.eyelashes, true);
  const eyeColor   = (typeof input.eyeColor === 'string' && input.eyeColor.trim()) ? safeAsset(input.eyeColor) : '';
  const hairSpec   = (input.hair === true || input.hair === 'true') ? 'short01'
                   : (typeof input.hair === 'string' && input.hair.trim()) ? safeAsset(input.hair) : '';
  let clothesList = [];
  if (Array.isArray(input.clothes)) clothesList = input.clothes;
  else if (typeof input.clothes === 'string' && input.clothes.trim()) clothesList = [input.clothes];
  clothesList = clothesList.map(safeAsset).filter(Boolean).slice(0, 8);

  // rig: false/omitted -> none; true/"default" -> standard rig; "mixamo" -> Mixamo skeleton
  const rigType = input.rig === 'mixamo' ? 'mixamo'
                : (input.rig === true || input.rig === 'true' || input.rig === 'default') ? 'default'
                : null;

  // ── staging (tab "Preview & Place" mode) ──
  // When staged: replace the previous staged human, then hide the new one in a "MH Staged"
  // collection (out of the viewport) so the scene stays clean until the user presses Place.
  const staged = input.staged === true || input.staged === 'true';
  const stagedPre = staged ? [
    '    _stale_staged = [_o for _o in bpy.data.objects if _o.get("mh_staged")]',
    '    for _old in _stale_staged:',
    '        for _c in list(_old.children_recursive):',
    '            try:',
    '                bpy.data.objects.remove(_c, do_unlink=True)',
    '            except Exception:',
    '                pass',
    '        try:',
    '            bpy.data.objects.remove(_old, do_unlink=True)',
    '        except Exception:',
    '            pass',
  ] : [];
  const stagedPost = staged ? [
    // Walk up to the root: when a rig is added, the ARMATURE is the parent of the body mesh,
    // so it is NOT in human.children_recursive. Stage the whole group from the root down.
    '    _root = human',
    '    while _root.parent is not None:',
    '        _root = _root.parent',
    '    _root["mh_staged"] = 1',
    '    _stcol = bpy.data.collections.get("MH Staged")',
    '    if _stcol is None:',
    '        _stcol = bpy.data.collections.new("MH Staged")',
    '        bpy.context.scene.collection.children.link(_stcol)',
    '    for _o in [_root] + list(_root.children_recursive):',
    '        for _coll in list(_o.users_collection):',
    '            try:',
    '                _coll.objects.unlink(_o)',
    '            except Exception:',
    '                pass',
    '        try:',
    '            _stcol.objects.link(_o)',
    '        except Exception:',
    '            pass',
    '        try:',
    '            _o.hide_viewport = True',  // viewport-only hide; still renders for the preview
    '        except Exception:',
    '            pass',
    '    print("STAGED")',
  ] : [];

  // ── detail targets ──
  const targetPairs = [];
  if (input.targets && typeof input.targets === 'object') {
    for (const [k, v] of Object.entries(input.targets)) {
      const tn = safeTarget(k); const tv = clamp01(v);
      if (tn && tv !== null) targetPairs.push(`        ("${tn}", ${tv}),`);
    }
  }
  const targetBlock = targetPairs.slice(0, 60).join('\n');

  // ── skin application (Python) ──
  let skinPy;
  if (skinMode === 'procedural') {
    skinPy = [
      '        MS.create_v2_skin_material("Skin_" + human.name, human, mhmat_file=None)',
      '        print("SKIN_APPLIED:procedural")',
    ];
  } else {
    const finder = skinMode === 'named'
      ? `_pick_mhmat("skins", contains="${skinNamed}")`
      : `_pick_mhmat("skins", tokens=["${ageBucket}", "${race}", "${genderTok}"])`;
    skinPy = [
      `        _sk = ${finder}`,
      '        if _sk:',
      '            HS.set_character_skin(_sk, human)',
      '            print("SKIN_APPLIED:asset:" + _os.path.basename(_sk))',
      '        else:',
      '            MS.create_v2_skin_material("Skin_" + human.name, human, mhmat_file=None)',
      '            print("SKIN_APPLIED:procedural")',
    ];
  }

  // ── part-add helpers (Python) ──
  const partLines = [];
  const addPart = (cond, sub, atype, contains, extra) => {
    if (!cond) return;
    partLines.push(
      '    try:',
      `        _f = _pick_mhclo(${JSON.stringify(sub)}${contains ? `, contains=${JSON.stringify(contains)}` : ''})`,
      '        if _f:',
      `            HS.add_mhclo_asset(_f, human, asset_type=${JSON.stringify(atype)}${extra || ''})`,
      `            print("PART_ADDED:${atype}:" + _os.path.basename(_f))`,
      '        else:',
      `            print("PART_SKIP:${atype}:no-asset")`,
      '    except Exception as _pe:',
      `        print("PART_WARN:${atype}:" + repr(_pe))`,
    );
  };
  // eyes (optionally with a color material via alternative_materials)
  if (wantEyes) {
    if (eyeColor) {
      partLines.push(
        '    try:',
        '        _f = _pick_mhclo("eyes", contains="high-poly")',
        `        _ec = _pick_mhmat("eyes", contains=${JSON.stringify(eyeColor)})`,
        '        if _f and _ec:',
        '            try:',
        '                HS.add_mhclo_asset(_f, human, asset_type="Eyes", alternative_materials=[_ec])',
        '            except Exception:',
        '                HS.add_mhclo_asset(_f, human, asset_type="Eyes")',
        '            print("PART_ADDED:Eyes:" + _os.path.basename(_f) + "/" + _os.path.basename(_ec))',
        '        elif _f:',
        '            HS.add_mhclo_asset(_f, human, asset_type="Eyes")',
        '            print("PART_ADDED:Eyes:" + _os.path.basename(_f))',
        '        else:',
        '            print("PART_SKIP:Eyes:no-asset")',
        '    except Exception as _pe:',
        '        print("PART_WARN:Eyes:" + repr(_pe))',
      );
    } else {
      addPart(true, 'eyes', 'Eyes', 'high-poly');
    }
  }
  addPart(wantTeeth,  'teeth',     'Teeth',     'teeth_base');
  addPart(wantBrows,  'eyebrows',  'Eyebrows',  'eyebrow003');
  addPart(wantLashes, 'eyelashes', 'Eyelashes', null);
  addPart(!!hairSpec, 'hair',      'Hair',      hairSpec);
  for (const c of clothesList) addPart(true, 'clothes', 'Clothes', c);

  const rigLines = !rigType ? [] : rigType === 'mixamo' ? [
    // Mixamo skeleton via the service (add_standard_rig's operator only exposes the panel's
    // default choice; the service takes the rig name directly). Required for FBX retargeting.
    '    try:',
    '        HS.add_builtin_rig(human, "mixamo", import_weights=True)',
    '        print("RIG_ADDED:mixamo")',
    '    except Exception as _re:',
    '        print("RIG_WARN:" + repr(_re))',
  ] : [
    '    try:',
    '        bpy.context.view_layer.objects.active = human',
    '        human.select_set(True)',
    '        bpy.ops.mpfb.add_standard_rig()',
    '        print("RIG_ADDED")',
    '    except Exception as _re:',
    '        print("RIG_WARN:" + repr(_re))',
  ];

  return [
    'import bpy, addon_utils, importlib',
    'import os as _os',
    "_mods = [m.__name__ for m in addon_utils.modules() if 'mpfb' in m.__name__.lower()]",
    '_mod = None',
    'for _m in _mods:',
    '    try:',
    '        addon_utils.enable(_m, default_set=True, persistent=True); _mod = _m; break',
    '    except Exception:',
    '        pass',
    'if not _mod:',
    '    print("ERROR: MPFB2 add-on is not installed/enabled in this Blender")',
    'else:',
    '    HS = importlib.import_module(_mod + ".services.humanservice").HumanService',
    '    TS = importlib.import_module(_mod + ".services.targetservice").TargetService',
    '    MS = importlib.import_module(_mod + ".services.materialservice").MaterialService',
    '    AS = importlib.import_module(_mod + ".services.assetservice").AssetService',
    '    import re as _re',
    '    def _match(files, contains):',
    '        c = contains.lower()',
    '        # 1) exact filename stem (so "male_casualsuit01" never matches "female_casualsuit01")',
    '        for f in files:',
    '            if _os.path.splitext(_os.path.basename(f))[0].lower() == c:',
    '                return f',
    '        # 2) whole-token / word-boundary match',
    '        _pat = _re.compile(r"(?:^|[^a-z0-9])" + _re.escape(c) + r"(?:$|[^a-z0-9])")',
    '        for f in files:',
    '            if _pat.search(_os.path.basename(f).lower()):',
    '                return f',
    '        # 3) loose substring fallback',
    '        for f in files:',
    '            if c in _os.path.basename(f).lower():',
    '                return f',
    '        return None',
    '    def _pick_mhmat(sub, tokens=None, contains=None):',
    '        files = [str(p) for p in AS.list_mhmat_assets(sub)]',
    '        if contains:',
    '            _m = _match(files, contains)',
    '            if _m:',
    '                return _m',
    '        if tokens:',
    '            for f in files:',
    '                toks = _os.path.basename(f).lower().replace(".mhmat", "").split("_")',
    '                if all(t in toks for t in tokens):',
    '                    return f',
    '            for f in files:',
    '                toks = _os.path.basename(f).lower().replace(".mhmat", "").split("_")',
    '                if all(t in toks for t in tokens if t not in ("young", "middleage", "old")):',
    '                    return f',
    '        return files[0] if files else None',
    '    def _pick_mhclo(sub, contains=None):',
    '        files = [str(p) for p in AS.list_mhclo_assets(sub)]',
    '        if contains:',
    '            _m = _match(files, contains)',
    '            if _m:',
    '                return _m',
    '        return files[0] if files else None',
    ...stagedPre,
    '    macro = TS.get_default_macro_info_dict()',
    overrideBlock,
    '    human = HS.create_human(macro_detail_dict=macro)',
    '    try:',
    `        human.name = ${JSON.stringify(nm)}`,
    '    except Exception:',
    '        pass',
    // detail targets (applied to the reshaped base before fitting assets)
    '    for _tn, _tv in [',
    targetBlock,
    '    ]:',
    '        try:',
    '            TS.set_target_value(human, _tn, _tv)',
    '        except Exception as _te:',
    '            print("TARGET_WARN:" + _tn + ":" + repr(_te))',
    // skin
    '    try:',
    ...skinPy,
    '    except Exception as _se:',
    '        print("SKIN_WARN:" + repr(_se))',
    // rig BEFORE parts so clothes/hair/eyes weight to the skeleton as they are added
    ...rigLines,
    // parts (each rigs to the skeleton via add_mhclo_asset's set_up_rigging)
    ...partLines,
    // stage (hide until Place) — only when the tab asks for it
    ...stagedPost,
    '    print("HUMAN_CREATED:" + human.name + ":verts=" + str(len(human.data.vertices)))',
  ].join('\n');
}

// Build a Python snippet that renders a face-framed headshot of `name` to `outAbs`.
// Renders the LIVE scene (window-independent — the bridge renders the active scene) with a
// temporary camera+sun, then FULLY restores every render setting it touched so the user's
// working scene is left exactly as it was. Best-effort: any failure just prints PREVIEW_ERR.
function buildHeadshotCode(name, outAbs) {
  return [
    'import bpy, math, mathutils, os as _os',
    `NAME = ${JSON.stringify(name)}`,
    `OUT = ${JSON.stringify(outAbs)}`,
    'human = bpy.data.objects.get(NAME)',
    'if not human:',
    '    print("PREVIEW_NO_OBJ")',
    'else:',
    '    sc = bpy.context.scene',
    '    _save = {',
    '        "engine": sc.render.engine, "cam": sc.camera,',
    '        "rx": sc.render.resolution_x, "ry": sc.render.resolution_y, "rp": sc.render.resolution_percentage,',
    '        "fp": sc.render.filepath, "fmt": sc.render.image_settings.file_format,',
    '    }',
    '    try:',
    '        _save["taa"] = sc.eevee.taa_render_samples',
    '    except Exception:',
    '        _save["taa"] = None',
    '    # frame on the BODY bbox only — some child assets (eyes/clothes) carry a huge bound_box',
    '    # that would otherwise blow up the framing and shrink the figure to a dot.',
    '    _bb = [human.matrix_world @ mathutils.Vector(_c) for _c in human.bound_box]',
    '    zmin = min(v.z for v in _bb); zmax = max(v.z for v in _bb)',
    '    h = max(zmax - zmin, 0.1)',
    '    cx = sum(v.x for v in _bb) / 8.0; cy = sum(v.y for v in _bb) / 8.0',
    '    center = mathutils.Vector((cx, cy, (zmin + zmax) / 2.0))',
    '    cam_d = bpy.data.cameras.new("__hu_cam__"); cam_d.lens = 50; cam_d.sensor_fit = "VERTICAL"',
    '    cam = bpy.data.objects.new("__hu_cam__", cam_d); sc.collection.objects.link(cam)',
    '    # deterministic vertical framing: fit (h * margin) into the vertical FOV',
    '    _dist = (h * 1.3) * cam_d.lens / cam_d.sensor_height',
    '    cam.location = center + mathutils.Vector((0.0, -_dist, 0.0))',
    '    _d = center - cam.location; cam.rotation_euler = _d.to_track_quat("-Z", "Y").to_euler()',
    '    sd = bpy.data.lights.new("__hu_sun__", "SUN"); sd.energy = 3.0',
    '    sun = bpy.data.objects.new("__hu_sun__", sd); sc.collection.objects.link(sun)',
    '    sun.rotation_euler = (math.radians(55), 0.0, math.radians(25))',
    '    _made_world = False',
    '    if not sc.world:',
    '        sc.world = bpy.data.worlds.new("__hu_world__"); _made_world = True',
    '    # isolate: humans pile up at the origin, so hide everything except THIS one from the',
    '    # render. Walk up to the root (the ARMATURE, when rigged, parents the body + clothes/hair),',
    '    # so rig-parented assets are kept visible too — else clothes vanish and the masked body',
    '    # under them shows only head/hands/feet. Restore afterwards.',
    '    _kroot = human',
    '    while _kroot.parent is not None:',
    '        _kroot = _kroot.parent',
    '    _keep = set([_kroot] + list(_kroot.children_recursive) + [cam, sun])',
    '    _hidden = []',
    '    for _o in bpy.data.objects:',
    '        if _o not in _keep and not _o.hide_render:',
    '            try:',
    '                _o.hide_render = True; _hidden.append(_o)',
    '            except Exception:',
    '                pass',
    '    try:',
    '        _os.makedirs(_os.path.dirname(OUT), exist_ok=True)',
    '        sc.camera = cam',
    // The EEVEE enum identifier moved: Blender 4.2-4.4 call it BLENDER_EEVEE_NEXT, 4.1 and
    // 5.x call it BLENDER_EEVEE. Assigning one that does not exist raises, which would kill the
    // whole preview render — so try both and let whichever exists win. MPFB2 itself supports
    // 4.2+, so the 4.2-4.4 window is real users, not a hypothetical.
    '        for _eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):',
    '            try:',
    '                sc.render.engine = _eng; break',
    '            except Exception: pass',
    '        sc.render.resolution_x = 460; sc.render.resolution_y = 640; sc.render.resolution_percentage = 100',
    '        try:',
    '            sc.eevee.taa_render_samples = 32',
    '        except Exception:',
    '            pass',
    '        sc.render.image_settings.file_format = "PNG"',
    '        sc.render.filepath = OUT',
    '        bpy.ops.render.render(write_still=True)',
    '        print("PREVIEW_OK")',
    '    except Exception as _e:',
    '        print("PREVIEW_ERR:" + repr(_e))',
    '    finally:',
    '        for _o in _hidden:',
    '            try:',
    '                _o.hide_render = False',
    '            except Exception:',
    '                pass',
    '        sc.render.engine = _save["engine"]; sc.camera = _save["cam"]',
    '        sc.render.resolution_x = _save["rx"]; sc.render.resolution_y = _save["ry"]; sc.render.resolution_percentage = _save["rp"]',
    '        sc.render.filepath = _save["fp"]; sc.render.image_settings.file_format = _save["fmt"]',
    '        if _save["taa"] is not None:',
    '            try:',
    '                sc.eevee.taa_render_samples = _save["taa"]',
    '            except Exception:',
    '                pass',
    '        for _o in (cam, sun):',
    '            try:',
    '                bpy.data.objects.remove(_o, do_unlink=True)',
    '            except Exception:',
    '                pass',
    '        try:',
    '            bpy.data.cameras.remove(cam_d)',
    '        except Exception:',
    '            pass',
    '        try:',
    '            bpy.data.lights.remove(sd)',
    '        except Exception:',
    '            pass',
    '        if _made_world and sc.world and sc.world.name.startswith("__hu_world__"):',
    '            _w = sc.world; sc.world = None',
    '            try:',
    '                bpy.data.worlds.remove(_w)',
    '            except Exception:',
    '                pass',
  ].join('\n');
}

// Run it in Blender and return a short human-readable status string (tool convention).
// On success also renders a face preview to PREVIEW_ABS (best-effort — never fails the build).
async function makeHuman(input = {}, cfg) {
  const code = buildMakeHumanCode(input || {});
  let r;
  try {
    r = await callBlender(code, { cfg, timeoutMs: 300000 }); // MPFB2 builds + asset fitting can be slow
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);

  const errLine = out.split('\n').find(l => l.startsWith('ERROR:'));
  if (errLine) return errLine;

  const m = out.match(/HUMAN_CREATED:(.+?):verts=(\d+)/);
  if (m) {
    // Best-effort face preview for the Human tab (server broadcasts it as slot:'human').
    try {
      await callBlender(buildHeadshotCode(m[1], PREVIEW_ABS), { cfg, timeoutMs: 120000 });
    } catch (_) { /* preview is optional — ignore */ }
    // Two markers, and the Mixamo one matters most to the user: it is the rig everything in the
    // animation path targets. `\bRIG_ADDED\b` alone also matches "RIG_ADDED:mixamo", which used to
    // report an animatable character as carrying the "standard rig" — i.e. exactly the rig the tool
    // docs say cannot be animated, inviting a pointless regenerate.
    const mixamoRig = /\bRIG_ADDED:mixamo\b/.test(out);
    const rigged    = mixamoRig || /\bRIG_ADDED\b(?!:)/.test(out);
    const skinM  = out.match(/SKIN_APPLIED:(asset:[^\s]+|procedural)/);
    const skin   = skinM ? (skinM[1].startsWith('asset') ? 'photoreal skin' : 'procedural skin') : null;
    const parts  = [...out.matchAll(/PART_ADDED:([A-Za-z]+):/g)].map(x => x[1].toLowerCase());
    const bits = [];
    if (skin) bits.push(skin);
    if (parts.length) bits.push(parts.join(', '));
    if (rigged) bits.push(mixamoRig ? 'mixamo rig (animatable)' : 'standard rig');
    const suffix = bits.length ? ' — with ' + bits.join(' + ') : '';
    return `Created MakeHuman "${m[1]}"${suffix} (${m[2]} verts).`;
  }
  return out || 'Human created.';
}

// Commit the staged human into the scene: unhide it, move it out of the staging collection into
// the scene's main collection, and drop the staged tag. Returns a status string.
function buildPlaceHumanCode() {
  return [
    'import bpy',
    '_placed = None',
    'for _o in list(bpy.data.objects):',
    '    if _o.get("mh_staged"):',
    '        for _m in [_o] + list(_o.children_recursive):',
    '            try:',
    '                _m.hide_viewport = False',
    '            except Exception:',
    '                pass',
    '            for _coll in list(_m.users_collection):',
    '                try:',
    '                    _coll.objects.unlink(_m)',
    '                except Exception:',
    '                    pass',
    '            try:',
    '                bpy.context.scene.collection.objects.link(_m)',
    '            except Exception:',
    '                pass',
    '        try:',
    '            del _o["mh_staged"]',
    '        except Exception:',
    '            pass',
    '        _placed = _o.name',
    '        break',
    '_stcol = bpy.data.collections.get("MH Staged")',
    'if _stcol is not None and len(_stcol.objects) == 0:',
    '    try:',
    '        bpy.data.collections.remove(_stcol)',
    '    except Exception:',
    '        pass',
    'print("PLACED:" + (_placed or ""))',
  ].join('\n');
}

async function placeHuman(_input = {}, cfg) {
  let r;
  try {
    r = await callBlender(buildPlaceHumanCode(), { cfg, timeoutMs: 60000 });
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const m = out.match(/PLACED:(.*)/);
  const name = m && m[1] ? m[1].trim() : '';
  return name
    ? `Placed "${name}" into the scene at the origin.`
    : 'No staged human to place — press Generate first.';
}

module.exports = { makeHuman, placeHuman, buildMakeHumanCode, buildHeadshotCode, buildPlaceHumanCode, PREVIEW_ABS, PREVIEW_REL };
