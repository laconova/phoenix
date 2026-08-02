'use strict';

// ─── Animate a MakeHuman character from a Mixamo FBX ──────────────────────────
//
// Retargets a Mixamo animation onto a MakeHuman character that was built with the
// "mixamo" rig (make_human rig:"mixamo"). Both skeletons use mixamorig: bone names,
// so the retarget is a 1:1 copy-rotation on every matching bone + a scale-matched
// hips copy-location for root motion — exactly what MPFB's map_mixamo operator does,
// replicated directly (more robust than driving the UI operator through the bridge).
// The result is BAKED onto the character and the imported source rig is deleted, so
// the scene stays clean and the character is exportable.
//
// Animation FBX files live in <workingDir>/animations/ (dropped via the Human tab).
//
// INPUT:
//   fbx:        basename of an FBX in animations/ (required; sanitized + existence-checked)
//   character:  optional target character name; if omitted, the first mixamo-rigged
//               MakeHuman armature in the scene is used.

const path = require('path');
const fs = require('fs');
const { callBlender } = require('./blender-ipc');

const ANIM_DIR = path.join(__dirname, 'animations');

function ensureAnimDir() {
  try { fs.mkdirSync(ANIM_DIR, { recursive: true }); } catch (_) { /* ignore */ }
  return ANIM_DIR;
}

// FBX filename -> safe basename (no path traversal, .fbx only)
function safeFbxName(s) {
  const base = path.basename(String(s || ''));           // strip any dir components
  const cleaned = base.replace(/[^A-Za-z0-9 _.\-]/g, '').slice(0, 120);
  return /\.fbx$/i.test(cleaned) ? cleaned : '';
}

function listAnimations() {
  ensureAnimDir();
  try {
    return fs.readdirSync(ANIM_DIR)
      .filter(f => /\.fbx$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
  } catch (_) {
    return [];
  }
}

// Resolve an input fbx name to a real file inside ANIM_DIR (containment-checked).
function resolveFbx(name) {
  const safe = safeFbxName(name);
  if (!safe) return null;
  const abs = path.join(ANIM_DIR, safe);
  const real = path.resolve(abs);
  if (real !== path.resolve(ANIM_DIR, safe)) return null;       // paranoia: no escape
  if (!real.startsWith(path.resolve(ANIM_DIR) + path.sep)) return null;
  return fs.existsSync(real) ? real : null;
}

// Target-picker (Python lines). Assumes a `NAME` variable is defined.
// Priority: explicit NAME → active object's root → first mixamo armature.
const TARGET_SELECT_PY = [
  'def _is_mixamo_arm(o):',
  '    return o.type == "ARMATURE" and any(b.name == "mixamorig:Hips" for b in o.data.bones)',
  'def _rootof(o):',
  '    while o.parent is not None: o = o.parent',
  '    return o',
  '_arms = [o for o in bpy.data.objects if _is_mixamo_arm(o)]',
  'dst = None',
  'if NAME:',
  '    _no = bpy.data.objects.get(NAME)',
  '    if _no is not None and _is_mixamo_arm(_rootof(_no)):',
  '        dst = _rootof(_no)',
  'if dst is None:',
  '    _act = bpy.context.view_layer.objects.active',
  '    if _act is not None and _rootof(_act) in _arms:',
  '        dst = _rootof(_act)',
  'if dst is None and _arms:',
  '    dst = _arms[0]',
];

// HY-Motion exports are structurally Mixamo FBX (same 52 mixamorig: bones, same T-pose
// rest) but arrive in the generator's own conventions: the body axis lands in Y instead
// of Z (figure on its back) and the root translation is in CENTIMETRES on a metre-scale
// skeleton (a 5.73 m walk reads as 573 m). Both are fixed on the imported SOURCE, before
// the retarget — the source is deleted afterwards anyway, so the live scene never sees it.
// User-facing symptoms and fixes: troubleshooting/entries/hymotion-hunched-tpose.md.
// Emitted at a caller-chosen indent and against caller-chosen variable names, because both
// the single-clip and the sequencing path need it and they name their locals differently.
function hyFixPy(indent, actVar, armVar) {
  const I = indent;
  return [
    I + '# --- HY-Motion source: upright + centimetres -> metres ---',
    I + 'def _hyfc(a):',
    I + '    _f = getattr(a, "fcurves", None)',
    I + '    if _f is not None: return list(_f)',
    I + '    _out = []',                          // Blender 5.x: slotted actions
    I + '    for _l in getattr(a, "layers", []):',
    I + '        for _s in getattr(_l, "strips", []):',
    I + '            for _cb in getattr(_s, "channelbags", []):',
    I + '                _out.extend(_cb.fcurves)',
    I + '    return _out',
    I + '_hyn = 0',
    I + 'if ' + actVar + ' is not None:',
    I + '    for _fc in _hyfc(' + actVar + '):',
    I + '        if _fc.data_path.endswith(".location") and "mixamorig:Hips" in _fc.data_path:',
    I + '            for _kp in _fc.keyframe_points:',
    I + '                _kp.co.y /= 100.0',
    I + '                _kp.handle_left.y /= 100.0',
    I + '                _kp.handle_right.y /= 100.0',
    I + '            _fc.update(); _hyn += 1',
    I + armVar + '.rotation_euler.x += 1.5707963267948966',
    I + 'bpy.context.view_layer.update()',
    I + 'print("ANIM_HYFIX:hips_curves=" + str(_hyn))',
    I + '# HY-Motion generates at 30 fps. On a 24 fps scene the clip plays 25% too slow —',
    I + '# it still looks "fine", just wrong, which is exactly why it needs saying out loud.',
    I + 'if bpy.context.scene.render.fps != 30: print("ANIM_FPSWARN:" + str(bpy.context.scene.render.fps))',
    // Third correction: put the clip ON THE GROUND. HY-Motion's vertical origin is its own,
    // so the raw clip sits about a metre off the floor. Reference is the lowest TOE over the
    // whole clip, not the mesh bounding box (a hanging hand would set that and the figure
    // would float). Shifting the hips Z keys moves the whole body, the pose stays untouched.
    I + '_toes = [' + armVar + '.pose.bones.get(_t) for _t in ("mixamorig:LeftToeBase", "mixamorig:RightToeBase")]',
    I + '_toes = [_t for _t in _toes if _t is not None]',
    I + 'if _toes and ' + actVar + ' is not None:',
    I + '    _sc = bpy.context.scene; _cur = _sc.frame_current; _lo = None; _zs = []',
    // Frame range taken from the action itself: the two call sites name their locals
    // differently and the sequencing path has not computed them yet at this point.
    I + '    _hf0 = int(' + actVar + '.frame_range[0]); _hf1 = int(' + actVar + '.frame_range[1])',
    I + '    for _fr in range(_hf0, _hf1 + 1):',
    I + '        _sc.frame_set(_fr)',
    I + '        _z = min((' + armVar + '.matrix_world @ _t.matrix).to_translation().z for _t in _toes)',
    I + '        _zs.append((_fr, _z))',
    I + '        if _lo is None or _z < _lo: _lo = _z',
    I + '    _sc.frame_set(_cur)',
    // ── Vertical drift ────────────────────────────────────────────────────────────────
    // HY-Motion clips sink as they play: a 4 s walk measured -0.188 m from first frame to
    // last, in the RAW source (verified by importing the untouched FBX). The ground shift
    // below cannot absorb that — it is a single constant, so it can only put the clip's
    // LOWEST moment on the floor, leaving the figure hovering at the start and buried at the
    // end. Chained, it is worse than cosmetic: sequencing deliberately gives every clip its
    // own world height (else a clip inherits the previous one's end height and crawls through
    // the air), so the drift reappears as a hard jump at every seam — measured 0.1825 m in one
    // frame on three chained walks.
    //
    // The trend is taken from GROUND-CONTACT frames, not from the first and last frame: the
    // ends of a generated clip are start-up and slow-down transients, and a jump ends airborne.
    // Per window the lowest toe height is a footfall; the slope through those footfalls is the
    // drift. Theil-Sen (median of pairwise slopes) rather than least squares, because an
    // airborne window is an outlier by construction and would drag a mean fit with it.
    I + '    _slope = 0.0',
    I + '    if len(_zs) >= 8:',
    I + '        _win = max(4, len(_zs) // 8)',
    I + '        _pts = []',
    I + '        for _i in range(_hf0, _hf1 + 1, _win):',
    I + '            _seg = [_p for _p in _zs if _i <= _p[0] < _i + _win]',
    I + '            if _seg: _pts.append(min(_seg, key=lambda _p: _p[1]))',
    I + '        _sl = []',
    I + '        for _a in range(len(_pts)):',
    I + '            for _b in range(_a + 1, len(_pts)):',
    I + '                _dx = _pts[_b][0] - _pts[_a][0]',
    I + '                if _dx: _sl.append((_pts[_b][1] - _pts[_a][1]) / _dx)',
    I + '        _sl.sort()',
    I + '        if _sl: _slope = _sl[len(_sl) // 2]',
    // Leave small drifts alone. Below ~2 cm over the whole clip the ramp is within the noise of
    // the footfall samples, and a correction that small is not worth touching real motion for.
    I + '    if abs(_slope * (_hf1 - _hf0)) < 0.02: _slope = 0.0',
    I + '    _hb0 = ' + armVar + '.data.bones.get("mixamorig:Hips")',
    I + '    _hrm0 = (' + armVar + '.matrix_world @ _hb0.matrix_local).to_3x3() if _hb0 is not None else Matrix.Identity(3)',
    I + '    if _slope:',
    I + '        _rf = [None, None, None]',
    I + '        for _fc in _hyfc(' + actVar + '):',
    I + '            if _fc.data_path.endswith(".location") and "mixamorig:Hips" in _fc.data_path and 0 <= _fc.array_index < 3:',
    I + '                _rf[_fc.array_index] = _fc',
    // Same bone-space trap as the constant lift: the ramp is a WORLD Z displacement and has to
    // be resolved into the hip bone's own axes per key, or it pushes the figure sideways.
    I + '        for _k in range(3):',
    I + '            if _rf[_k] is None: continue',
    I + '            for _kp in _rf[_k].keyframe_points:',
    I + '                _rv = (_hrm0.inverted() @ Vector((0.0, 0.0, -_slope * (_kp.co.x - _hf0))))[_k]',
    I + '                _kp.co.y += _rv; _kp.handle_left.y += _rv; _kp.handle_right.y += _rv',
    I + '            _rf[_k].update()',
    I + '        bpy.context.view_layer.update()',
    // The ramp is a rigid vertical translation, so every sampled toe height moves with it —
    // the post-correction minimum follows analytically and costs no second pass over the clip.
    I + '        _lo = min(_z - _slope * (_f - _hf0) for _f, _z in _zs)',
    // The toe bone sits inside the foot, not on the sole. Calibrate that offset on the
    // TARGET character's own rest pose instead of guessing a value that only fits one body.
    I + '    _sole = 0.0; _nfv = 0; _nmesh = 0',
    I + '    _tb = dst.data.bones.get("mixamorig:LeftToeBase")',
    // Every mesh bound to this armature, by MODIFIER or by parenting — not just the first
    // child. dst.children is unordered, so "the first MESH child" could be the eyebrows, and
    // eyebrows have no foot vertices: the calibration then silently produced 0.
    I + '    _tms = [o for o in bpy.data.objects if o.type == "MESH" and (o.parent is dst or',
    I + '            any(_m.type == "ARMATURE" and _m.object is dst for _m in o.modifiers))]',
    I + '    if _tb is not None and _tms:',
    I + '        _lows = []',
    I + '        for _tm in _tms:',
    I + '            _gi = set()',
    I + '            for _n in ("mixamorig:LeftToeBase", "mixamorig:RightToeBase", "mixamorig:LeftFoot", "mixamorig:RightFoot"):',
    I + '                if _n in _tm.vertex_groups: _gi.add(_tm.vertex_groups[_n].index)',
    I + '            if not _gi: continue',
    // A vertex belongs to the foot if the heaviest DEFORM group is a foot group. Restricting
    // to groups that are actual bones is the whole point: a MakeHuman body carries ~200 vertex
    // groups, and its own metadata groups (HelperGeometry, JointCubes, Left/Mid/Right) hold
    // weight 1.0 — they beat every fractional skin weight, so the unrestricted max() never
    // returned a bone at all and NO vertex ever counted as a foot.
    I + '            _bg = set(_g.index for _g in _tm.vertex_groups if _g.name in dst.data.bones)',
    I + '            _fv = []',
    I + '            for _v in _tm.data.vertices:',
    I + '                _dg = [_g for _g in _v.groups if _g.group in _bg]',
    I + '                if _dg and max(_dg, key=lambda g: g.weight).group in _gi: _fv.append(_v)',
    I + '            if _fv:',
    I + '                _nfv += len(_fv); _nmesh += 1',
    I + '                _lows.append(min((_tm.matrix_world @ _v.co).z for _v in _fv))',
    I + '        if _lows:',
    I + '            _sole = min(_lows) - (dst.matrix_world @ _tb.head_local).z',
    I + '    _dz = -(_lo + _sole)',
    // Hips location keys are in BONE space, and a Mixamo hip bone points UP along its own
    // Y — its Z axis runs forward. Adding the lift to index 2 shoves the character backwards
    // instead of raising it. Convert the world-Z lift into bone space first, then all three
    // components move together.
    I + '    _hb = ' + armVar + '.data.bones.get("mixamorig:Hips")',
    I + '    _hrm = (' + armVar + '.matrix_world @ _hb.matrix_local).to_3x3() if _hb is not None else Matrix.Identity(3)',
    I + '    _dv = _hrm.inverted() @ Vector((0.0, 0.0, _dz))',
    I + '    _lf = [None, None, None]',
    I + '    for _fc in _hyfc(' + actVar + '):',
    I + '        if _fc.data_path.endswith(".location") and "mixamorig:Hips" in _fc.data_path and 0 <= _fc.array_index < 3:',
    I + '            _lf[_fc.array_index] = _fc',
    I + '    for _k in range(3):',
    I + '        if _lf[_k] is None or abs(_dv[_k]) < 1e-9: continue',
    I + '        for _kp in _lf[_k].keyframe_points:',
    I + '            _kp.co.y += _dv[_k]; _kp.handle_left.y += _dv[_k]; _kp.handle_right.y += _dv[_k]',
    I + '        _lf[_k].update()',
    I + '    bpy.context.view_layer.update()',
    // Report what the calibration actually stood on. sole=0 from "no foot vertices found" and
    // sole=0 from "the sole really is at the bone" used to look identical in the log — that is
    // how the MakeHuman miss stayed invisible.
    I + '    print("ANIM_HYGROUND:toe_min=%.3f sole=%.3f lifted=%+.3f footverts=%d meshes=%d drift=%+.3f" % (_lo, _sole, _dz, _nfv, _nmesh, _slope * (_hf1 - _hf0)))',
  ];
}

function buildAnimateHumanCode(fbxAbs, characterName, hyFix) {
  const NAME = typeof characterName === 'string' ? characterName.replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 40) : '';
  return [
    'import bpy, addon_utils',
    'from mathutils import Vector, Matrix',
    `FBX = ${JSON.stringify(fbxAbs)}`,
    `NAME = ${JSON.stringify(NAME)}`,
    'addon_utils.enable("io_scene_fbx", default_set=False, persistent=False)',
    '',
    ...TARGET_SELECT_PY,
    'if dst is None:',
    '    print("ANIM_ERR:no mixamo-rigged character in scene (build one with rig=mixamo)")',
    'else:',
    '    _before = set(bpy.data.objects)',
    // Remember which ACTIONS the import brings along, not just the objects. Blender's FBX import
    // hands them a fake user, so deleting the source rig leaves the action behind forever —
    // measured 2026-07-24: one orphan per applied clip, never purged on save, the .blend just
    // grows. Captured here (before the bake) so the baked result can never be mistaken for one.
    '    _actsb = set(bpy.data.actions)',
    '    bpy.ops.import_scene.fbx(filepath=FBX)',
    '    _new = list(set(bpy.data.objects) - _before)',
    '    _newacts = [a for a in bpy.data.actions if a not in _actsb]',
    '    src = next((o for o in _new if o.type == "ARMATURE"), None)',
    '    if src is None:',
    '        print("ANIM_ERR:no armature in FBX")',
    '    else:',
    '        act = src.animation_data.action if src.animation_data else None',
    '        fr = act.frame_range if act else (bpy.context.scene.frame_start, bpy.context.scene.frame_end)',
    '        f0, f1 = int(fr[0]), int(fr[1])',
    ...(hyFix ? hyFixPy('        ', 'act', 'src') : []),
    '        # scale-match source to target (thigh bone length ratio) so root motion is correct',
    '        _tb = dst.data.bones.get("mixamorig:LeftUpLeg"); _sb = src.data.bones.get("mixamorig:LeftUpLeg")',
    '        if _tb and _sb:',
    '            _tl = _tb.length * dst.matrix_world.to_scale().z',
    '            _sl = _sb.length * src.matrix_world.to_scale().z',
    '            if _sl:',
    '                src.scale = src.scale * (_tl / _sl)',
    '                bpy.context.view_layer.update()',
    '        # retarget: copy-rotation on every matching bone (suffix-robust) + hips copy-location',
    '        def _suf(n): return n.split(":")[-1]',
    '        _src_by = {_suf(b.name): b.name for b in src.pose.bones}',
    '        _m = 0',
    '        for pb in dst.pose.bones:',
    '            _s = _suf(pb.name)',
    '            if _s in _src_by:',
    '                c = pb.constraints.new("COPY_ROTATION"); c.target = src; c.subtarget = _src_by[_s]; _m += 1',
    '        _hips = dst.pose.bones.get("mixamorig:Hips")',
    '        if _hips:',
    '            c = _hips.constraints.new("COPY_LOCATION"); c.target = src; c.subtarget = "mixamorig:Hips"',
    '        # bake the constrained result onto the character, then drop the constraints',
    '        bpy.context.scene.frame_start = f0; bpy.context.scene.frame_end = f1',
    '        bpy.ops.object.mode_set(mode="OBJECT")',
    '        bpy.ops.object.select_all(action="DESELECT")',
    '        dst.select_set(True); bpy.context.view_layer.objects.active = dst',
    '        _baked = False',
    '        try:',
    '            bpy.ops.object.mode_set(mode="POSE")',
    '            bpy.ops.pose.select_all(action="SELECT")',
    '            bpy.ops.nla.bake(frame_start=f0, frame_end=f1, only_selected=False,',
    '                             visual_keying=True, clear_constraints=True, clear_parents=False,',
    '                             use_current_action=True, bake_types={"POSE"})',
    '            _baked = True',
    '        except Exception as _be:',
    '            print("ANIM_BAKE_WARN:" + repr(_be))',
    '        finally:',
    '            try:',
    '                bpy.ops.object.mode_set(mode="OBJECT")',
    '            except Exception:',
    '                pass',
    // Applying a single clip REPLACES what the character was doing, so any NLA strips left over
    // from a previous `sequence` have to go. Without this they keep playing underneath the new
    // action and the result is a silent blend of both — plausible-looking and wrong, which is the
    // worst kind. Dropped only once the bake succeeded, same rule the sequencing path follows:
    // never destroy what is there until the replacement is in hand. Counted, because a character
    // quietly losing a built sequence deserves to be told, not guessed at.
    '        _dropped = 0',
    '        if _baked and dst.animation_data is not None:',
    '            for _tr in list(dst.animation_data.nla_tracks):',
    '                try:',
    '                    dst.animation_data.nla_tracks.remove(_tr); _dropped += 1',
    '                except Exception:',
    '                    pass',
    // Delete the imported source rig — but ONLY if the bake succeeded. The constraints point AT
    // this object; removing it after a failed bake leaves the character wearing 52 dead
    // constraints and no animation, while the status line claims the constraints were "left in
    // place" so the user could still scrub the timeline. Keeping the source makes that true.
    '        if _baked:',
    '            for o in _new:',
    '                try:',
    '                    bpy.data.objects.remove(o, do_unlink=True)',
    '                except Exception:',
    '                    pass',
    // ...and the actions that came in with them. The users==0 check after clearing the fake user
    // is the guard: anything that unexpectedly ended up attached to a live object survives.
    '            for _a in _newacts:',
    '                try:',
    '                    _a.use_fake_user = False',
    '                    if _a.users == 0: bpy.data.actions.remove(_a)',
    '                except Exception:',
    '                    pass',
    '        bpy.context.scene.frame_set(f0)',
    '        print("ANIM_DONE:" + dst.name + ":bones=" + str(_m) + ":frames=" + str(f0) + "-" + str(f1) + ":baked=" + str(_baked) + ":nla_dropped=" + str(_dropped))',
  ].join('\n');
}

// Build a Python snippet that chains several Mixamo FBX clips onto one mixamo-rigged
// character as blended NLA strips. Each clip is retargeted WITH its real root motion
// (rotation on every bone + hips copy-location, scale-matched — same as animateHuman)
// and baked to its own action; the actions are stacked one-track-per-clip with a blend-in
// crossfade at each seam.
//
// Chaining the travel: a baked clip always starts near the armature origin, so clip 2 would
// snap back to the start. Instead of throwing the motion away, every clip's hips LOCATION
// keys are shifted by a constant offset so the clip begins exactly where the previous clip
// stood at the seam frame. Bone-space location is rest-relative and unaffected by the bone's
// own pose rotation, so adding a constant there is a clean world-space translation.
// The seam is sampled at (prev_end - blend), i.e. the frame the next strip actually starts on,
// so both strips agree on the position throughout the crossfade — no jump, no slide.
//
// speed = OPTIONAL extra linear drift (metres of forward -Y travel per frame) on the object,
// for genuine Mixamo "In Place" clips that carry no root motion of their own. Default 0:
// with real root motion any nonzero value is pure foot-sliding.
//
// ── Why this builder takes an `opts` ───────────────────────────────────────────
// Everything below — the yaw match, the quaternion/euler continuity, the position offset,
// the NLA stacking — is skeleton-agnostic: it only ever needs to know WHICH bone carries the
// root motion. Only four things in here are Mixamo-specific (target picker, that bone's name,
// the thigh-ratio scale match, the HY-Motion import fix), so those four are options and the
// custom-rig library drives the same code with its own values. One copy of the seam logic,
// two callers. The defaults reproduce the Mixamo path exactly — verified by generating the
// Python before and after the refactor and diffing it byte for byte.
function buildSequenceAnimationsCode(fbxAbsList, blend, speed, characterName, append, opts = {}) {
  const NAME = typeof characterName === 'string' ? characterName.replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 40) : '';
  const BLEND = Math.max(0, Math.min(60, Math.round(Number(blend) || 0)));
  const SPEED = (isFinite(Number(speed)) ? Number(speed) : 0);
  const APPEND = append === true ? 'True' : 'False';
  const targetPy    = opts.targetPy    || TARGET_SELECT_PY;
  const errNoTarget = opts.errNoTarget || 'no mixamo-rigged character in scene (build one with rig=mixamo)';
  const rootPy      = opts.rootPy      || ['    HIPS = "mixamorig:Hips"'];
  // How to tell whether an fcurve belongs to the root bone. Mixamo's name is unique enough for
  // a substring test; a custom rig is not ("Bone" is a prefix of "Bone.001"), so that caller
  // passes an exact bone-path test instead.
  const rootMatch   = opts.rootMatch   || 'HIPS in fc.data_path';
  const rootNoMatch = opts.rootNoMatch || 'HIPS not in fc.data_path';
  const scaleMatch  = opts.scaleMatch !== false;
  const hyFix       = opts.hyFix !== false;
  const rootLocPy   = opts.rootLocPy || [
    '        _hips = dst.pose.bones.get(HIPS)',
    '        if _hips and HIPS.split(":")[-1] in _src_by:',
    '            c = _hips.constraints.new("COPY_LOCATION"); c.target = src; c.subtarget = _src_by[HIPS.split(":")[-1]]',
  ];
  // Optional per-clip placement, run after the imported clip is known and before it is baked.
  // Empty for a Human-tab character (it stands at the origin); the custom-rig library uses it to
  // slide each clip onto the creature's current position so a chain does not teleport it.
  const clipPlacePy = opts.clipPlacePy || [];
  // Zero the character object's X/Y on a fresh (non-append) chain. Right for a Mixamo character,
  // wrong for a creature the user placed somewhere on purpose.
  const resetObjectLoc = opts.resetObjectLoc !== false;
  return [
    'import bpy, addon_utils, math',
    'from mathutils import Vector, Matrix, Quaternion, Euler',
    `FBXS = ${JSON.stringify(fbxAbsList)}`,
    // Python booleans, NOT JSON: JSON.stringify would emit [true,false], which parses
    // fine as Python (they are just names) and then dies with NameError at runtime.
    `HYFLAGS = [${fbxAbsList.map(f => (hyFix && needsHyFix(f) ? 'True' : 'False')).join(', ')}]`,
    `BLEND = ${BLEND}`,
    `SPEED = ${SPEED}`,
    `NAME = ${JSON.stringify(NAME)}`,
    `APPEND = ${APPEND}`,
    'addon_utils.enable("io_scene_fbx", default_set=False, persistent=False)',
    '',
    'def _suf(n): return n.split(":")[-1]',
    ...targetPy,
    'if dst is None:',
    `    print("SEQ_ERR:${errNoTarget}")`,
    'elif not FBXS:',
    '    print("SEQ_ERR:no animations given")',
    'else:',
    ...rootPy,
    '    def _fcurves(a):',
    '        # Blender 4.4+/5.x actions are slotted: curves live under layers->strips->channelbags.',
    '        # Older builds expose action.fcurves directly -- support both.',
    '        _f = getattr(a, "fcurves", None)',
    '        if _f is not None:',
    '            return list(_f)',
    '        _out = []',
    '        for _l in getattr(a, "layers", []):',
    '            for _s in getattr(_l, "strips", []):',
    '                for _cb in getattr(_s, "channelbags", []):',
    '                    _out.extend(_cb.fcurves)',
    '        return _out',
    '    def _hipfc(a):',
    '        _r = [None, None, None]',
    '        for fc in _fcurves(a):',
    `            if fc.data_path.endswith(".location") and (${rootMatch}) and 0 <= fc.array_index < 3:`,
    '                _r[fc.array_index] = fc',
    '        return _r',
    '    def _val(fcs, f):',
    '        return [(fc.evaluate(f) if fc is not None else 0.0) for fc in fcs]',
    '    def _shift(fcs, off):',
    '        for _k, fc in enumerate(fcs):',
    '            if fc is None or off[_k] == 0.0:',
    '                continue',
    '            for kp in fc.keyframe_points:',
    '                kp.co.y += off[_k]; kp.handle_left.y += off[_k]; kp.handle_right.y += off[_k]',
    '            fc.update()',
    // ── Facing at the seam ──────────────────────────────────────────────────────
    // Shifting the hips POSITION makes the path continuous but says nothing about which
    // way the character faces: clip 2 starts in its own heading regardless of where clip 1
    // was pointing, so the figure spins on the spot at the seam (measured: 92 degrees in a
    // single frame) and then walks off in the wrong direction.
    // Fix: rotate the whole incoming clip about the world Z axis by the heading difference.
    // Bone-space rotation is rest-relative, so a world rotation Rz becomes the constant
    // conjugation  C = Rest^-1 * Rz * Rest  -- and that SAME C rotates the hips location
    // keys about the clip's start point. One constant, applied to both channels, exact.
    '    _HB = dst.pose.bones.get(HIPS)',
    '    _RESTW = (dst.matrix_world @ _HB.bone.matrix_local).to_3x3() if _HB else Matrix.Identity(3)',
    '    _RESTWI = _RESTW.inverted()',
    '    def _hiprotfc(a):',
    '        _q = [None, None, None, None]; _e = [None, None, None]',
    '        for fc in _fcurves(a):',
    `            if ${rootNoMatch}:`,
    '                continue',
    '            if fc.data_path.endswith(".rotation_quaternion") and 0 <= fc.array_index < 4:',
    '                _q[fc.array_index] = fc',
    '            elif fc.data_path.endswith(".rotation_euler") and 0 <= fc.array_index < 3:',
    '                _e[fc.array_index] = fc',
    '        return _q, _e',
    '    def _rot_at(qf, ef, f):',
    '        if any(x is not None for x in qf):',
    '            return Quaternion([(qf[i].evaluate(f) if qf[i] is not None else (1.0 if i == 0 else 0.0)) for i in range(4)])',
    '        if any(x is not None for x in ef):',
    '            return Euler([(ef[i].evaluate(f) if ef[i] is not None else 0.0) for i in range(3)], "XYZ").to_quaternion()',
    '        return Quaternion()',
    // Heading = the direction the character actually TRAVELS, sampled from the hips path,
    // not the direction the hip bone points. Those two agree while walking upright and
    // diverge hard when the body is horizontal (a crawl points its hips at the floor):
    // matching the bone orientation there rotates the clip by tens of degrees for nothing.
    // Returns None when the clip barely moves — an idle has no heading to match.
    '    _HEAD_WIN = 6',
    '    def _travel_dir(fcs, f, back):',
    '        _a1 = _val(fcs, f - _HEAD_WIN) if back else _val(fcs, f)',
    '        _a2 = _val(fcs, f) if back else _val(fcs, f + _HEAD_WIN)',
    '        _d = _RESTW @ Vector([_a2[_k] - _a1[_k] for _k in range(3)])',
    '        _d.z = 0.0',
    '        if _d.length < 0.02:',
    '            return None',
    '        return math.atan2(_d.y, _d.x)',
    // Fallback for clips that barely travel -- a backflip lands where it took off, so there
    // is no travel direction to match, and matching nothing leaves the seam unfixed.
    // Reference then is the hip's SIDEWAYS axis (bone X). Deliberately not the bone's long
    // axis: that one points at the floor whenever the body is horizontal and its ground
    // projection collapses, which is what made the first attempt swing clips at random.
    // The sideways axis stays in the ground plane through crawls, jumps and flips alike.
    // ── Quaternion continuity across the seam ──────────────────────────────────
    // A full 360-degree flip ends on q = -q_start: the SAME orientation, the opposite
    // quaternion. The next clip starts on +q_start, so the crossfade interpolates between
    // q and -q and takes the long way round -- the body visibly un-rotates at the seam to
    // "get back to the start pose". Negating every key of the incoming clip changes no
    // orientation at all (double cover) but puts the blend on the short arc.
    // Per bone, not just the hips: arms and legs carry their own flips.
    '    def _quatgroups(a):',
    '        _g = {}',
    '        for fc in _fcurves(a):',
    '            if fc.data_path.endswith(".rotation_quaternion") and 0 <= fc.array_index < 4:',
    '                _g.setdefault(fc.data_path, [None, None, None, None])[fc.array_index] = fc',
    '        return _g',
    '    def _negate(cs):',
    '        for fc in cs:',
    '            for kp in fc.keyframe_points:',
    '                kp.co.y = -kp.co.y; kp.handle_left.y = -kp.handle_left.y; kp.handle_right.y = -kp.handle_right.y',
    '            fc.update()',
    // EULER is the case that actually occurs: nla.bake writes rotation_euler (all 52 bones
    // come out XYZ), so a quaternion-only fix silently does nothing. Here the discontinuity
    // is not a sign flip but a WRAP: after a full flip the hips sit at -359 degrees while the
    // next clip starts at -1.5, and the blend interpolates those NUMBERS -- a 358 degree
    // spin in 8 frames. Shifting the incoming clip by whole turns removes it; a multiple of
    // 360 degrees is the identical pose, so nothing about the animation changes.
    '    def _eulergroups(a):',
    '        _g = {}',
    '        for fc in _fcurves(a):',
    '            if fc.data_path.endswith(".rotation_euler") and 0 <= fc.array_index < 3:',
    '                _g.setdefault(fc.data_path, [None, None, None])[fc.array_index] = fc',
    '        return _g',
    '    _TAU = 2.0 * math.pi',
    '    def _match_rot_continuity(prev_a, seam_f, next_a, start_f):',
    '        if prev_a is None:',
    '            return 0',
    '        _n = 0',
    '        _pg = _quatgroups(prev_a); _ng = _quatgroups(next_a)',
    '        for _dp, _nc in _ng.items():',
    '            _pc = _pg.get(_dp)',
    '            if _pc is None or any(x is None for x in _pc) or any(x is None for x in _nc):',
    '                continue',
    '            _qp = Quaternion([_pc[_k].evaluate(seam_f) for _k in range(4)])',
    '            _qn = Quaternion([_nc[_k].evaluate(start_f) for _k in range(4)])',
    '            if _qp.dot(_qn) < 0.0:',
    '                _negate(_nc); _n += 1',
    '        _pe = _eulergroups(prev_a); _ne = _eulergroups(next_a)',
    '        for _dp, _nc in _ne.items():',
    '            _pc = _pe.get(_dp)',
    '            if _pc is None:',
    '                continue',
    '            for _k in range(3):',
    '                if _pc[_k] is None or _nc[_k] is None:',
    '                    continue',
    '                _turns = round((_pc[_k].evaluate(seam_f) - _nc[_k].evaluate(start_f)) / _TAU)',
    '                if _turns == 0:',
    '                    continue',
    '                _shift_by = _turns * _TAU',
    '                for _kp in _nc[_k].keyframe_points:',
    '                    _kp.co.y += _shift_by; _kp.handle_left.y += _shift_by; _kp.handle_right.y += _shift_by',
    '                _nc[_k].update(); _n += 1',
    '        return _n',
    '    def _side_dir(qf, ef, f):',
    '        _m = _RESTW @ _rot_at(qf, ef, f).to_matrix()',
    '        _s = _m @ Vector((1.0, 0.0, 0.0))',
    '        _s.z = 0.0',
    '        if _s.length < 0.15:',
    '            return None',
    '        return math.atan2(_s.y, _s.x)',
    // Both ends of a seam must be measured the SAME way or the difference is meaningless.
    // prev is a (travel, facing) pair — either sampled from the outgoing clip's curves or,
    // when appending, off the live rig.
    //
    // FACING wins, travel is the fallback. Measured 2026-07-23 on three chained HY walks:
    // matching travel left a +36.1 degree BODY snap in a single frame at every seam, because a
    // clip's own start and the previous clip's end hold different body-to-path relations (a
    // generated clip begins with a start-up transient: 125 degrees between body and path,
    // against 92 degrees mid-stride). A rigid yaw can satisfy exactly one of the two, so the
    // choice is which discontinuity the viewer gets — and the eye tracks the BODY, not the
    // path. Facing also stays defined where travel does not: an idle, a clip that lands where
    // it took off, and the airborne part of a jump all have no travel direction, and a
    // run->jump->run chain is made of exactly those.
    // Safe against the crawl case that made travel the original default: _side_dir reads the
    // hip's SIDEWAYS axis, which stays horizontal even when the body is — it is the bone's
    // long axis that points at the floor, and that one is deliberately not used here.
    '    def _seam_from(prev, nf, nq, ne, nfr):',
    '        _pt, _ps = prev',
    '        _o = _side_dir(nq, ne, nfr)',
    '        if _ps is not None and _o is not None:',
    '            return _ps, _o, "facing"',
    '        _o = _travel_dir(nf, nfr, False)',
    '        if _pt is not None and _o is not None:',
    '            return _pt, _o, "travel"',
    '        return None, None, "none"',
    '    def _rotate_clip(qf, ef, lfcs, ang, pivot):',
    '        if abs(ang) < 1e-6:',
    '            return',
    '        _C = _RESTWI @ Matrix.Rotation(ang, 3, "Z") @ _RESTW',
    '        _Cq = _C.to_quaternion()',
    '        # rotations: left-multiply every key, keeping the quaternion on the short arc',
    '        if any(x is not None for x in qf) and all(x is not None for x in qf):',
    '            _n = len(qf[0].keyframe_points)',
    '            _prev = None',
    '            for _i in range(_n):',
    '                _q = Quaternion([qf[_k].keyframe_points[_i].co.y for _k in range(4)])',
    '                _q = _Cq @ _q',
    '                if _prev is not None:',
    '                    _q.make_compatible(_prev)',
    '                _prev = _q.copy()',
    '                for _k in range(4):',
    '                    _kp = qf[_k].keyframe_points[_i]',
    '                    _d = _q[_k] - _kp.co.y',
    '                    _kp.co.y += _d; _kp.handle_left.y += _d; _kp.handle_right.y += _d',
    '            for _k in range(4):',
    '                qf[_k].update()',
    '        elif all(x is not None for x in ef):',
    '            _n = len(ef[0].keyframe_points)',
    '            for _i in range(_n):',
    '                _q = _Cq @ Euler([ef[_k].keyframe_points[_i].co.y for _k in range(3)], "XYZ").to_quaternion()',
    '                _ne = _q.to_euler("XYZ")',
    '                for _k in range(3):',
    '                    _kp = ef[_k].keyframe_points[_i]',
    '                    _d = _ne[_k] - _kp.co.y',
    '                    _kp.co.y += _d; _kp.handle_left.y += _d; _kp.handle_right.y += _d',
    '            for _k in range(3):',
    '                ef[_k].update()',
    '        # locations: rotate the travel about the clip start, same conjugation',
    '        if all(x is not None for x in lfcs):',
    '            _n = min(len(fc.keyframe_points) for fc in lfcs)',
    '            for _i in range(_n):',
    '                _p = Vector([lfcs[_k].keyframe_points[_i].co.y for _k in range(3)])',
    '                _np = _C @ (_p - Vector(pivot)) + Vector(pivot)',
    '                for _k in range(3):',
    '                    _kp = lfcs[_k].keyframe_points[_i]',
    '                    _d = _np[_k] - _kp.co.y',
    '                    _kp.co.y += _d; _kp.handle_left.y += _d; _kp.handle_right.y += _d',
    '            for fc in lfcs:',
    '                fc.update()',
    '    _append = APPEND and bool(dst.animation_data and len(dst.animation_data.nla_tracks) > 0)',
    '    _root_action = None',
    '    _root_fake = False',
    // DO NOT destroy the existing animation up front. This used to call animation_data_clear()
    // before a single clip had been imported, so a run where every clip failed to import or bake
    // left the character with NOTHING — the previous sequence and any hand-keyed action gone, in
    // exchange for an error message. The old action is stashed and put back if nothing bakes; the
    // existing NLA tracks are only removed once there is something to replace them with (below).
    '    _old_action = dst.animation_data.action if dst.animation_data else None',
    // The fake user is a LOAN for the duration of the run, so remember what it was. Restoring it
    // blindly to False at the end would be a new data-loss bug of its own: an action the user had
    // deliberately marked would then be collected on the next reload. Put back is at the very end.
    '    _old_fake = _old_action.use_fake_user if _old_action is not None else False',
    '    if _old_action is not None:',
    '        _old_action.use_fake_user = True   # survive losing the slot even if Blender reloads',
    '    if not _append:',
    '        if dst.animation_data is None:',
    '            dst.animation_data_create()',
    '        _track_off = 0; _existing_end = 1; _prev_end = 1; _prev_y = 0.0',
    '    else:',
    '        _existing_end = 1',
    '        for _tr in dst.animation_data.nla_tracks:',
    '            for _st in _tr.strips:',
    '                _existing_end = max(_existing_end, int(_st.frame_end))',
    '        _track_off = len(dst.animation_data.nla_tracks)',
    '        _root_action = dst.animation_data.action        # existing root/location action',
    '        _root_fake = _root_action.use_fake_user if _root_action is not None else False',
    '        if _root_action is not None:',
    '            _root_action.use_fake_user = True',
    '        bpy.context.scene.frame_set(_existing_end)',
    '        _prev_y = dst.location.y',
    '        _prev_end = _existing_end',
    '    baked = []',
    '    for _i, _fbx in enumerate(FBXS):',
    '        _before = set(bpy.data.objects)',
    // see the single-clip path: the import's own actions carry a fake user and would otherwise
    // survive the source rig by an eternity — one orphan per clip, per chain, forever.
    '        _actsb = set(bpy.data.actions)',
    '        try:',
    '            bpy.ops.import_scene.fbx(filepath=_fbx)',
    '        except Exception as _ie:',
    '            print("SEQ_SKIP:" + str(_i) + ":import:" + repr(_ie)); continue',
    '        _newacts = [a for a in bpy.data.actions if a not in _actsb]',
    '        _new = list(set(bpy.data.objects) - _before)',
    '        src = next((o for o in _new if o.type == "ARMATURE"), None)',
    '        if src is None:',
    '            for o in _new:',
    '                try: bpy.data.objects.remove(o, do_unlink=True)',
    '                except Exception: pass',
    '            for _a in _newacts:',
    '                try:',
    '                    _a.use_fake_user = False',
    '                    if _a.users == 0: bpy.data.actions.remove(_a)',
    '                except Exception: pass',
    '            print("SEQ_SKIP:" + str(_i) + ":no-armature"); continue',
    '        _act = src.animation_data.action if src.animation_data else None',
    '        # Text-generated clips arrive in HY-Motion conventions — fix this one before it is',
    '        # measured or scaled, exactly as the single-clip path does. Per clip, because a',
    '        # playlist can mix generated and Mixamo clips freely.',
    '        if HYFLAGS[_i]:',
    ...hyFixPy('            ', '_act', 'src'),
    '        _fr = _act.frame_range if _act else (bpy.context.scene.frame_start, bpy.context.scene.frame_end)',
    '        _f0, _f1 = int(_fr[0]), int(_fr[1])',
    ...(scaleMatch ? [
      '        # scale-match source to target (thigh bone length ratio) so root motion is correct',
      '        _tb = dst.data.bones.get("mixamorig:LeftUpLeg"); _sb = src.data.bones.get("mixamorig:LeftUpLeg")',
      '        if _tb and _sb:',
      '            _tl = _tb.length * dst.matrix_world.to_scale().z',
      '            _sl = _sb.length * src.matrix_world.to_scale().z',
      '            if _sl:',
      '                src.scale = src.scale * (_tl / _sl)',
      '                bpy.context.view_layer.update()',
    ] : []),
    '        # retarget WITH real root motion: rotation on every bone + hips location',
    '        _src_by = {_suf(b.name): b.name for b in src.pose.bones}',
    ...clipPlacePy,
    '        for pb in dst.pose.bones:',
    '            _s = _suf(pb.name)',
    '            if _s in _src_by:',
    '                c = pb.constraints.new("COPY_ROTATION"); c.target = src; c.subtarget = _src_by[_s]',
    ...rootLocPy,
    '        # bake this clip into a fresh action',
    '        dst.animation_data.action = None',
    '        bpy.context.scene.frame_start = _f0; bpy.context.scene.frame_end = _f1',
    '        bpy.ops.object.mode_set(mode="OBJECT"); bpy.ops.object.select_all(action="DESELECT")',
    '        dst.select_set(True); bpy.context.view_layer.objects.active = dst',
    '        try:',
    '            bpy.ops.object.mode_set(mode="POSE"); bpy.ops.pose.select_all(action="SELECT")',
    '            bpy.ops.nla.bake(frame_start=_f0, frame_end=_f1, only_selected=False,',
    '                             visual_keying=True, clear_constraints=True, clear_parents=False,',
    '                             use_current_action=True, bake_types={"POSE"})',
    '        except Exception as _be:',
    '            print("SEQ_BAKE_WARN:" + str(_i) + ":" + repr(_be))',
    '        finally:',
    '            try: bpy.ops.object.mode_set(mode="OBJECT")',
    '            except Exception: pass',
    '        _a = dst.animation_data.action',
    '        if _a is not None:',
    '            _a.name = "seq_%02d_%d" % (_track_off + len(baked), _f1 - _f0)',
    '            _a.use_fake_user = True',
    '            baked.append((_a, _f0, _f1))',
    '            dst.animation_data.action = None',
    '        for o in _new:',
    '            try: bpy.data.objects.remove(o, do_unlink=True)',
    '            except Exception: pass',
    // the clip's own action goes with its rig; the baked one was created after _newacts was taken
    '        for _a in _newacts:',
    '            try:',
    '                _a.use_fake_user = False',
    '                if _a.users == 0: bpy.data.actions.remove(_a)',
    '            except Exception: pass',
    '    if not baked:',
    // Nothing was produced, so nothing may be taken away: hand the character back exactly as it
    // was. The NLA tracks were never touched (that now happens below, after this branch).
    '        if dst.animation_data is not None:',
    '            dst.animation_data.action = _old_action',
    '        print("SEQ_ERR:nothing baked")',
    '    else:',
    // Only now is it safe to drop what was there: we have replacements in hand.
    '        if not _append:',
    '            for _tr in list(dst.animation_data.nla_tracks):',
    '                try: dst.animation_data.nla_tracks.remove(_tr)',
    '                except Exception: pass',
    '            dst.animation_data.action = None',
    '        # effective crossfade per seam: the strip overlap and the blend-in must be the SAME',
    '        # number of frames, or the incoming strip reaches full weight while the outgoing one',
    '        # is still playing (that mismatch was a visible hitch at every seam).',
    '        _effs = []',
    '        for _j in range(len(baked)):',
    '            _lj = baked[_j][2] - baked[_j][1]',
    '            if _j == 0 and not _append:',
    '                _effs.append(0)',
    '            elif _j == 0:',
    '                _effs.append(min(BLEND, max(1, _lj // 2)))',
    '            else:',
    '                _lp = baked[_j - 1][2] - baked[_j - 1][1]',
    '                _effs.append(min(BLEND, max(1, _lj // 2), max(1, _lp // 2)))',
    '        # where the chain has to pick up: on append, read the hips out of the existing NLA',
    '        _target = None; _prev_yaws = None',
    '        _prev_action = None; _prev_seam_f = 0',
    '        if _append:',
    '            _sf = max(1, _existing_end - _effs[0])',
    '            bpy.context.scene.frame_set(_sf)',
    '            bpy.context.view_layer.update()',
    '            _pbh = dst.pose.bones.get(HIPS)',
    '            _target = [_pbh.location[0], _pbh.location[1], _pbh.location[2]] if _pbh else [0.0, 0.0, 0.0]',
    '            # Same two references, but read off the evaluated rig instead of clip curves:',
    '            # what is already in the NLA has no source action to sample any more.',
    '            if _pbh:',
    '                _m2 = dst.matrix_world @ _pbh.matrix',
    '                _p2 = _m2.to_translation().copy()',
    '                _sv = _m2.to_3x3() @ Vector((1.0, 0.0, 0.0)); _sv.z = 0.0',
    '                _face = math.atan2(_sv.y, _sv.x) if _sv.length >= 0.15 else None',
    '                bpy.context.scene.frame_set(max(1, _sf - _HEAD_WIN))',
    '                bpy.context.view_layer.update()',
    '                _p1 = (dst.matrix_world @ _pbh.matrix).to_translation().copy()',
    '                bpy.context.scene.frame_set(_sf)',
    '                bpy.context.view_layer.update()',
    '                _dv = _p2 - _p1; _dv.z = 0.0',
    '                _prev_yaws = (math.atan2(_dv.y, _dv.x) if _dv.length >= 0.02 else None, _face)',
    '            # the outgoing clip is an NLA strip here, not a live action -- fetch the one',
    '            # that reaches furthest and convert the seam frame into ITS action time',
    '            _ls = None',
    '            for _tr in dst.animation_data.nla_tracks:',
    '                for _st in _tr.strips:',
    '                    if _ls is None or _st.frame_end > _ls.frame_end:',
    '                        _ls = _st',
    '            if _ls is not None and _ls.action is not None:',
    '                _prev_action = _ls.action',
    '                _prev_seam_f = _sf + (_ls.action_frame_start - _ls.frame_start)',
    '        _start = (_existing_end - _effs[0]) if _append else 1',
    '        _chain0 = None; _chainN = None',
    '        _last_end = _prev_end',
    '        for _j, (_a, _f0, _f1) in enumerate(baked):',
    '            _idx = _track_off + _j',
    '            _fcs = _hipfc(_a)',
    '            _qf, _ef = _hiprotfc(_a)',
    '            # 1) face the way the chain was heading. MUST happen before the position',
    '            #    offset: rotating afterwards would swing the already-placed path away',
    '            #    from the seam point again.',
    '            if _prev_yaws is not None:',
    '                _t, _o, _how = _seam_from(_prev_yaws, _fcs, _qf, _ef, _f0)',
    '                if _t is not None:',
    '                    _dy = (_t - _o + math.pi) % (2 * math.pi) - math.pi',
    '                    _rotate_clip(_qf, _ef, _fcs, _dy, _val(_fcs, _f0))',
    '                    print("SEQ_YAW:clip=%d turned=%+.1f via=%s" % (_j, math.degrees(_dy), _how))',
    '                else:',
    '                    print("SEQ_YAW:clip=%d no-reference" % _j)',
    '            # after any rotation: put every bone on the short arc across the seam',
    '            _flip = _match_rot_continuity(_prev_action, _prev_seam_f, _a, _f0)',
    '            if _flip:',
    '                print("SEQ_FLIP:clip=%d bones=%d" % (_j, _flip))',
    '            # 2) then move it so it starts where the previous clip stood at the seam',
    '            _s = _val(_fcs, _f0)',
    '            if _target is None:',
    '                _off = [0.0, 0.0, 0.0]',
    '            else:',
    // Match ground position (world X/Y), keep each clip's own HEIGHT (world Z). Hip height
    // belongs to the pose -- carrying the salto's end-height into the crawl makes it crawl
    // through the air. The location keys are in BONE space (Mixamo hips: height is the bone
    // Y axis, not Z), so nulling a bone axis nulls the wrong thing. Convert the delta to
    // world, drop world Z there, convert back. Same bone-space trap as the ground/yaw fixes.
    '                _ob = Vector([_target[_k] - _s[_k] for _k in range(3)])',
    '                _ow = _RESTW @ _ob; _ow.z = 0.0',
    '                _off = list(_RESTWI @ _ow)',
    '            _shift(_fcs, _off)',
    '            if _chain0 is None:',
    '                _chain0 = [_s[_k] + _off[_k] for _k in range(3)]',
    '            _ev = _val(_fcs, _f1)',
    '            _chainN = [_ev[_k] for _k in range(3)]',
    '            # the next clip starts at the frame this one is still mid-motion on -> sample THERE',
    '            if _j + 1 < len(baked):',
    '                _sn = _f1 - _effs[_j + 1]',
    '                if _sn < _f0: _sn = _f0',
    '                _target = _val(_fcs, _sn)',
    '                _prev_yaws = (_travel_dir(_fcs, _sn, True), _side_dir(_qf, _ef, _sn))',
    '                _prev_action = _a; _prev_seam_f = _sn',
    '            # stack on its own NLA track (higher = later), blend-in crossfade',
    '            _tr = dst.animation_data.nla_tracks.new(); _tr.name = "Seq %02d" % _idx',
    '            _strip = _tr.strips.new(_a.name, int(_start), _a)',
    '            _strip.extrapolation = "HOLD_FORWARD"',
    '            if _effs[_j] > 0:',
    '                _strip.blend_in = _effs[_j]',
    '            _last_end = int(_strip.frame_end)',
    '            _start = _last_end - (_effs[_j + 1] if _j + 1 < len(baked) else 0)',
    '        _total_end = _last_end',
    '        _travel = 0.0',
    '        if _chain0 and _chainN:',
    '            _travel = (Vector(_chainN) - Vector(_chain0)).length',
    '        # optional extra object drift -- only for genuine "In Place" clips (SPEED defaults to 0)',
    '        if SPEED:',
    '            if _append and _root_action is not None:',
    '                dst.animation_data.action = _root_action',
    '                dst.location = (0.0, _prev_y - SPEED * (_total_end - _prev_end), dst.location.z)',
    '                dst.keyframe_insert("location", frame=_total_end)',
    '            else:',
    '                dst.animation_data.action = None',
    '                dst.location = (0.0, 0.0, dst.location.z)',
    '                dst.keyframe_insert("location", frame=1)',
    '                dst.location = (0.0, -SPEED * (_total_end - 1), dst.location.z)',
    '                dst.keyframe_insert("location", frame=_total_end)',
    '        else:',
    '            if _append and _root_action is not None:',
    '                dst.animation_data.action = _root_action',
    ...(resetObjectLoc ? [
      '            elif not _append:',
      '                dst.location = (0.0, 0.0, dst.location.z)',
    ] : []),
    '        bpy.context.scene.frame_start = 1; bpy.context.scene.frame_end = _total_end',
    '        bpy.context.scene.frame_set(1)',
    '        print("SEQ_DONE:" + dst.name + ":clips=" + str(len(baked)) + ":frames=1-" + str(_total_end) + ":blend=" + str(BLEND) + ":append=" + str(_append) + ":travel=" + ("%.3f" % _travel))',
    // Give the borrowed fake user back exactly as it was found (see the note at the capture).
    // Deliberately OUTSIDE both branches: the flag was set before we knew whether anything would
    // bake, so it has to come off on the failure exit too — that path promises to hand the
    // character back "exactly as it was", and a changed flag breaks that promise.
    '    _restored = 0',
    '    for _sa, _sfake in ((_old_action, _old_fake), (_root_action, _root_fake)):',
    '        if _sa is not None:',
    '            try:',
    '                _sa.use_fake_user = _sfake; _restored += 1',
    '            except Exception:',
    '                pass',
    '    print("SEQ_STASH:restored=" + str(_restored))',
  ].join('\n');
}

async function sequenceAnimations(input = {}, cfg) {
  const names = Array.isArray(input && input.fbxs) ? input.fbxs : [];
  const resolved = names.map(resolveFbx).filter(Boolean);
  if (resolved.length < 1) {
    const have = listAnimations();
    return `ERROR: no valid animations in the sequence.` + (have.length ? ` Available: ${have.join(', ')}` : ' (folder is empty)');
  }
  let r;
  try {
    r = await callBlender(buildSequenceAnimationsCode(resolved, input.blend, input.speed, input.character, input.append), { cfg, timeoutMs: 600000 });
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('SEQ_ERR:'));
  if (err) return 'ERROR: ' + err.slice('SEQ_ERR:'.length);
  const m = out.match(/SEQ_DONE:(.+?):clips=(\d+):frames=([\d-]+):blend=(\d+):append=(\w+):travel=([\d.]+)/);
  if (m) {
    const skipped = (out.match(/SEQ_SKIP:/g) || []).length;
    const verb = m[5] === 'True' ? 'Appended' : 'Sequenced';
    const hyN = resolved.filter(needsHyFix).length;
    const fpsWarn = out.match(/ANIM_FPSWARN:(\d+)/);
    return `${verb} ${m[2]} clip(s) onto "${m[1]}" — frames ${m[3]}, blend ${m[4]}f, root travel ${m[6]}m` +
           (skipped ? ` (${skipped} skipped)` : '') +
           (hyN ? `, ${hyN} text-generated clip(s) corrected on import` : '') + '.' +
           (fpsWarn ? ` ⚠️ Scene runs at ${fpsWarn[1]} fps but generated clips are 30 — they play ` +
                      `${Math.round((30 / Number(fpsWarn[1]) - 1) * 100)}% too slow. Set the scene to 30 fps.` : '');
  }
  return out || 'Sequence applied.';
}

// Does this FBX need the HY-Motion conventions fixed on import?
// Answered from a sidecar the HY download writes next to the file — deterministic, not
// guessed from the filename (a rename would silently turn the fix off and lay the
// character on its back). An explicit input.hyFix always wins.
function needsHyFix(fbxAbs) {
  try {
    const meta = JSON.parse(fs.readFileSync(fbxAbs + '.hy.json', 'utf8'));
    return meta && meta.source === 'hymotion';
  } catch (_) {
    return false;
  }
}

async function animateHuman(input = {}, cfg) {
  const fbxAbs = resolveFbx(input && input.fbx);
  if (!fbxAbs) {
    const have = listAnimations();
    return `ERROR: animation FBX not found. Drop one in animations/ first.` +
           (have.length ? ` Available: ${have.join(', ')}` : ' (folder is empty)');
  }
  const hyFix = typeof input.hyFix === 'boolean' ? input.hyFix : needsHyFix(fbxAbs);
  let r;
  try {
    // 15 minutes, not 5. The work scales with the clip length — the bake plus the per-frame ground
    // scan both walk every frame with a scene update — and a 12 s generated clip is 360 frames.
    // That blew through the old 300 s ceiling on this machine (2026-07-23), and the failure mode is
    // nasty: Blender finishes the job anyway, so the caller reports a timeout while the character
    // silently DID get animated. Better to wait than to lie.
    r = await callBlender(buildAnimateHumanCode(fbxAbs, input.character, hyFix), { cfg, timeoutMs: 900000 });
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('ANIM_ERR:'));
  if (err) return 'ERROR: ' + err.slice('ANIM_ERR:'.length);
  const m = out.match(/ANIM_DONE:(.+?):bones=(\d+):frames=([\d-]+):baked=(\w+)/);
  if (m) {
    const baked = m[4] === 'True';
    const fpsWarn = out.match(/ANIM_FPSWARN:(\d+)/);
    // Say it when a built sequence was replaced. Silently dropping someone's chained clips is
    // how a tool loses trust, even when replacing them is the correct behaviour.
    const dropped = Number((out.match(/:nla_dropped=(\d+)/) || [])[1] || 0);
    return `Animated "${m[1]}" from ${path.basename(fbxAbs)} — ${m[2]} bones, frames ${m[3]}` +
           (hyFix ? ', HY-Motion source corrected' : '') +
           (dropped ? `. Replaced the sequence that was on this rig (${dropped} clip${dropped > 1 ? 's' : ''} dropped — re-run "sequence" to rebuild it)` : '') +
           (baked ? ', baked (source removed).' : ' (bake failed — the imported source and its live constraints were LEFT in the scene so you can inspect or bake manually; delete it when done).') +
           (fpsWarn ? ` ⚠️ Scene runs at ${fpsWarn[1]} fps but this clip was generated at 30 — it will play ` +
                      `${Math.round((30 / Number(fpsWarn[1]) - 1) * 100)}% too slow. Set the scene to 30 fps.` : '');
  }
  return out || 'Animation applied.';
}

// ─── Save the current animation on a rig as a reusable FBX clip ───────────────
//
// The counterpart to animateHuman: instead of applying a clip, export the animation
// that is ON the selected mixamo-rigged armature right now (hand-keyframed, or a built
// sequence) into animations/ so it can be re-applied and sequenced like any other clip.
//
// Skeleton-aware from day one: the clip is written with a .sig.json sidecar carrying the
// sorted bone-name signature. For the Mixamo Human tab that is always the standard 52-bone
// set, but the same mechanism binds a custom-rig clip to its own skeleton — see
// planing phase/custom-rig-animation.md. animate/sequence stay skeleton-agnostic; the
// signature is what a future Custom-Rig tab filters on so a clip is only offered where it fits.

function buildSaveAnimationCode(outAbs, characterName) {
  const NAME = typeof characterName === 'string' ? characterName.replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 40) : '';
  const OUT = outAbs.replace(/\\/g, '/');   // Blender takes forward slashes on every OS
  return [
    'import bpy, addon_utils, os',
    `OUT = ${JSON.stringify(OUT)}`,
    `NAME = ${JSON.stringify(NAME)}`,
    'addon_utils.enable("io_scene_fbx", default_set=False, persistent=False)',
    '',
    ...TARGET_SELECT_PY,
    'if dst is None:',
    '    print("SAVE_ERR:no mixamo-rigged character selected (build/select one with rig=mixamo)")',
    'else:',
    // An armature carries animation either as a live action or as NLA strips (a built
    // sequence). Refuse to write an empty clip — a silent zero-frame FBX is worse than an error.
    '    _ad = dst.animation_data',
    '    _has_action = bool(_ad and _ad.action)',
    '    _has_nla = bool(_ad and any(len(t.strips) for t in _ad.nla_tracks))',
    '    if not (_has_action or _has_nla):',
    '        print("SAVE_ERR:the selected rig has no animation to save")',
    '    else:',
    '        os.makedirs(os.path.dirname(OUT), exist_ok=True)',
    '        _f0 = bpy.context.scene.frame_start; _f1 = bpy.context.scene.frame_end',
    // Every bpy.ops.object.* below polls for OBJECT mode. Saving straight out of Pose mode is
    // the NORMAL case (you keyframe a pose, then hit Save FBX), so switch modes ourselves and
    // put the user back where he was — same thing animateHuman/sequence already do. Without
    // this, select_all's poll() fails and the user gets a raw Python traceback.
    '        _prev = bpy.context.view_layer.objects.active',
    '        _prev_name = _prev.name if _prev is not None else None',
    '        _prev_mode = None',
    '        try:',
    '            if _prev is not None and _prev.mode != "OBJECT":',
    '                _prev_mode = _prev.mode',
    '                bpy.ops.object.mode_set(mode="OBJECT")',
    '        except Exception:',
    '            _prev_mode = None',
    '        _dup = None',
    '        _err = None',
    '        try:',
    // FBX bake_anim_use_nla_strips exports each NLA strip as its OWN take (a 4-clip sequence
    // came back as 4 separate 120-frame actions, losing every seam fix). To get ONE take with
    // the evaluated motion, the NLA must first be baked into a single action. Do that on a
    // DUPLICATE so the user's live scene is never touched, then export the duplicate.
    '            bpy.ops.object.select_all(action="DESELECT")',
    '            dst.select_set(True); bpy.context.view_layer.objects.active = dst',
    '            bpy.ops.object.duplicate()',
    '            _dup = bpy.context.view_layer.objects.active',
    '            _dup.name = "__save_tmp__"',
    '            bpy.ops.object.mode_set(mode="POSE")',
    '            bpy.ops.pose.select_all(action="SELECT")',
    '            bpy.ops.nla.bake(frame_start=_f0, frame_end=_f1, only_selected=False,',
    '                             visual_keying=True, clear_constraints=False,',
    '                             use_current_action=True, bake_types={"POSE"})',
    '            bpy.ops.object.mode_set(mode="OBJECT")',
    // After baking, drop the strips so the export sees only the one baked action, not the
    // strips again.
    '            if _dup.animation_data:',
    '                for _tr in list(_dup.animation_data.nla_tracks):',
    '                    _dup.animation_data.nla_tracks.remove(_tr)',
    '            bpy.ops.object.select_all(action="DESELECT")',
    '            _dup.select_set(True); bpy.context.view_layer.objects.active = _dup',
    '            bpy.ops.export_scene.fbx(filepath=OUT, use_selection=True, object_types={"ARMATURE"},',
    '                                     add_leaf_bones=False, bake_anim=True,',
    '                                     bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False)',
    '            _sig = sorted(b.name for b in dst.data.bones)',
    '            _size = os.path.getsize(OUT) if os.path.exists(OUT) else -1',
    '            _bakedact = _dup.animation_data.action if _dup.animation_data else None',
    '            bpy.data.objects.remove(_dup, do_unlink=True)',
    '            _dup = None',
    '            if _bakedact is not None:',
    '                try: bpy.data.actions.remove(_bakedact)',
    '                except Exception: pass',
    '            print("SAVE_DONE:" + dst.name + ":frames=" + str(_f0) + "-" + str(_f1) +',
    '                  ":bones=" + str(len(_sig)) + ":bytes=" + str(_size))',
    '            print("SAVE_SIG:" + ",".join(_sig))',
    '        except Exception as _e:',
    '            _err = _e',
    '        finally:',
    // A failure mid-way must not leave the working duplicate behind in the user's scene.
    '            try:',
    '                if _dup is not None and _dup.name in bpy.data.objects:',
    '                    bpy.data.objects.remove(_dup, do_unlink=True)',
    '            except Exception: pass',
    '            try:',
    '                if _prev_name and _prev_name in bpy.data.objects:',
    '                    _po = bpy.data.objects[_prev_name]',
    '                    bpy.context.view_layer.objects.active = _po',
    '                    _po.select_set(True)',
    '                    if _prev_mode: bpy.ops.object.mode_set(mode=_prev_mode)',
    '            except Exception: pass',
    // The net: any exception comes back as one readable SAVE_ERR line, never a traceback.
    '        if _err is not None:',
    '            _m = str(_err).replace(chr(10), " ").strip()',
    '            if "poll()" in _m or "context is incorrect" in _m:',
    '                _m = ("Blender refused the export in its current state - click once into the " +',
    '                      "3D viewport, leave Edit mode, and try again. (" + _m + ")")',
    '            print("SAVE_ERR:" + _m)',
  ].join('\n');
}

// name -> safe .fbx basename inside ANIM_DIR
function safeSaveName(s) {
  let base = path.basename(String(s || '').trim());
  base = base.replace(/[^A-Za-z0-9 _\-.]/g, '').slice(0, 100).replace(/\.fbx$/i, '');
  return base ? base + '.fbx' : '';
}

async function saveAnimation(input = {}, cfg) {
  const base = safeSaveName(input && input.name);
  if (!base) return 'ERROR: give the clip a name to save it under.';
  ensureAnimDir();
  const outAbs = path.join(ANIM_DIR, base);
  // Refuse to overwrite — same guard as custom_rig's saveClip and saveMesh. A clip in animations/
  // may be a generated take that cost minutes, or a sequence somebody built by hand; a mistyped name
  // must not be able to destroy either. Deliberately a REFUSAL and not the auto-rename generateMotion
  // does: there the name is Phoenix's own invention, so sliding to "-2" is harmless, but here the
  // user typed it, and silently saving under a different name than the one they asked for is its own
  // way of losing their work.
  if (fs.existsSync(outAbs)) {
    return `ERROR: an animation named "${base}" already exists — pick another name ` +
           '(or delete the old one first).';
  }
  let r;
  try {
    r = await callBlender(buildSaveAnimationCode(outAbs, input.character), { cfg, timeoutMs: 180000 });
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('SAVE_ERR:'));
  if (err) return 'ERROR: ' + err.slice('SAVE_ERR:'.length);
  const m = out.match(/SAVE_DONE:(.+?):frames=([\d-]+):bones=(\d+):bytes=(-?\d+)/);
  if (!m) return out || 'Save failed.';
  const sigLine = out.split('\n').find(l => l.startsWith('SAVE_SIG:'));
  const bones = sigLine ? sigLine.slice('SAVE_SIG:'.length).split(',').filter(Boolean) : [];
  // Skeleton signature sidecar — the binding a Custom-Rig tab will filter on. Written for
  // every clip, humanoid or not, so the mechanism is uniform from the start.
  try {
    fs.writeFileSync(outAbs + '.sig.json', JSON.stringify({
      bones, boneCount: bones.length, source: 'saved', character: m[1], frames: m[2],
    }, null, 2), 'utf8');
  } catch (_) { /* the clip itself is saved; a missing sidecar just disables filtering */ }
  // Drop any HY sidecar left over from a clip of the same name. It marks a file as carrying
  // HY-Motion conventions, and animate_human then "corrects" them — so an inherited sidecar makes
  // the next use lay the character on its back with the hip translation divided by 100. The clip
  // just written is in Blender conventions; saying otherwise is worse than saying nothing.
  try { fs.unlinkSync(outAbs + '.hy.json'); } catch (_) { /* none there — fine */ }
  return `Saved "${base}" from "${m[1]}" — frames ${m[2]}, ${m[3]} bones. It's now in the animation list.`;
}

module.exports = {
  animateHuman, buildAnimateHumanCode, sequenceAnimations, buildSequenceAnimationsCode,
  saveAnimation, buildSaveAnimationCode, safeSaveName,
  listAnimations, resolveFbx, ensureAnimDir, needsHyFix, ANIM_DIR,
};
