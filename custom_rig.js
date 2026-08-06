'use strict';

// ─── Custom-Rig library — skeleton-bound animation for non-Mixamo rigs ────────
//
// A "folder" binds ONE skeleton to its animation clips and mesh variants. Everything
// spawned from a folder shares that skeleton, so the existing retarget code (animate/
// sequence) works unchanged — source and target are guaranteed identical. This is the
// whole point: it turns cross-skeleton retargeting (hard) into same-skeleton retargeting
// (trivial) by construction. Full design: planing phase/custom-rig-animation.md.
//
// Layout:
//   custom-rigs/<folder>/
//     rig.blend          bare skeleton in rest pose (the animation template)
//     meshes/<v>.blend   mesh + skeleton + PACKED textures (a spawnable variant)
//     signature.json     { bones:[...], rigObject, created }
//     clips/*.fbx        saved animations (+ .sig.json sidecars)

const path = require('path');
const fs = require('fs');
const { callBlender } = require('./blender-ipc');
// The seam machinery (yaw match, rotation continuity, position offset, NLA stacking) lives in
// animate_human.js and is skeleton-agnostic — it only needs to be told which bone carries the
// root motion. sequenceClips() below drives that same builder with this library's values.
const { buildSequenceAnimationsCode } = require('./animate_human');

const CUSTOM_DIR = path.join(__dirname, 'custom-rigs');

function ensureDir() {
  try { fs.mkdirSync(CUSTOM_DIR, { recursive: true }); } catch (_) { /* ignore */ }
  return CUSTOM_DIR;
}

// folder name -> safe single path segment (no traversal, no separators)
function safeFolder(s) {
  const cleaned = String(s || '').trim().replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 60).trim();
  return cleaned || '';
}

// mesh-variant name -> safe single path segment (the .blend basename)
function safeVariantName(s) {
  const cleaned = String(s || '').trim().replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 60).trim();
  return cleaned || '';
}

// clip name -> safe .fbx basename (no path traversal, .fbx enforced)
function safeClipName(s) {
  let base = path.basename(String(s || '').trim());
  base = base.replace(/[^A-Za-z0-9 _\-.]/g, '').slice(0, 100).replace(/\.fbx$/i, '');
  return base ? base + '.fbx' : '';
}

// Resolve a clip name to a real file inside <folder>/clips/ (containment-checked).
function resolveClip(folderAbs, name) {
  const safe = safeClipName(name);
  if (!safe) return null;
  const clipsDir = path.join(folderAbs, 'clips');
  const abs = path.resolve(clipsDir, safe);
  if (path.dirname(abs) !== path.resolve(clipsDir)) return null;   // no escape
  return fs.existsSync(abs) ? abs : null;
}

function folderPath(name) {
  const safe = safeFolder(name);
  if (!safe) return null;
  const abs = path.resolve(CUSTOM_DIR, safe);
  // containment: the resolved path must sit directly under CUSTOM_DIR
  if (path.dirname(abs) !== path.resolve(CUSTOM_DIR)) return null;
  return abs;
}

function readSig(folderAbs) {
  try { return JSON.parse(fs.readFileSync(path.join(folderAbs, 'signature.json'), 'utf8')); }
  catch (_) { return null; }
}

// One folder's state — drives the UI's locked/unlocked model.
function describeFolder(name) {
  const abs = folderPath(name);
  if (!abs || !fs.existsSync(abs)) return null;
  const sig = readSig(abs);
  const hasSkeleton = !!(sig && Array.isArray(sig.bones) && sig.bones.length);
  let variants = [];
  try {
    variants = fs.readdirSync(path.join(abs, 'meshes'))
      .filter(f => /\.blend$/i.test(f)).map(f => f.replace(/\.blend$/i, '')).sort();
  } catch (_) { /* no meshes dir yet */ }
  let clips = [];
  try {
    clips = fs.readdirSync(path.join(abs, 'clips'))
      .filter(f => /\.fbx$/i.test(f)).sort();
  } catch (_) { /* no clips dir yet */ }
  return {
    name: safeFolder(name), hasSkeleton,
    boneCount: hasSkeleton ? sig.bones.length : 0,
    rigObject: hasSkeleton ? sig.rigObject : null,
    variants, clips,
  };
}

function listFolders() {
  ensureDir();
  let names = [];
  try {
    names = fs.readdirSync(CUSTOM_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch (_) { /* ignore */ }
  return names.map(describeFolder).filter(Boolean);
}

function createFolder(name) {
  const abs = folderPath(name);
  if (!abs) return { error: 'invalid folder name.' };
  if (fs.existsSync(abs)) return { error: 'a folder with that name already exists.' };
  try {
    fs.mkdirSync(path.join(abs, 'clips'), { recursive: true });
    fs.mkdirSync(path.join(abs, 'meshes'), { recursive: true });
  } catch (e) { return { error: e.message }; }
  return { folder: describeFolder(name) };
}

// Rename a folder = rename its directory. Everything inside is path-independent (rig.blend is
// self-contained, signature.json holds no path, clip sidecars only carry a cosmetic folder name),
// so a plain directory rename is safe.
function renameFolder(oldName, newName) {
  const src = folderPath(oldName);
  const dst = folderPath(newName);
  if (!src) return { error: 'invalid current folder name.' };
  if (!dst) return { error: 'invalid new folder name.' };
  if (!fs.existsSync(src)) return { error: 'folder does not exist.' };
  if (path.resolve(src) === path.resolve(dst)) return { folder: describeFolder(newName) };
  if (fs.existsSync(dst)) return { error: 'a folder with the new name already exists.' };
  try { fs.renameSync(src, dst); } catch (e) { return { error: e.message }; }
  return { folder: describeFolder(newName) };
}

// Delete a folder and everything in it. Containment-checked via folderPath.
function deleteFolder(name) {
  const abs = folderPath(name);
  if (!abs) return { error: 'invalid folder name.' };
  if (!fs.existsSync(abs)) return { error: 'folder does not exist.' };
  try { fs.rmSync(abs, { recursive: true, force: true }); } catch (e) { return { error: e.message }; }
  return { ok: true };
}

// Skeleton picker for CUSTOM rigs — deliberately NOT the Mixamo-specific one: a deer/
// creature rig has none of the mixamorig: bones. Take the active object's armature root,
// else the first armature in the scene.
const CUSTOM_TARGET_PY = [
  'def _rootof(o):',
  '    while o.parent is not None: o = o.parent',
  '    return o',
  '_arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]',
  'src = None',
  '_act = bpy.context.view_layer.objects.active',
  'if _act is not None:',
  '    _r = _rootof(_act)',
  '    if _r.type == "ARMATURE": src = _r',
  'if src is None and _act is not None and _act.type == "ARMATURE": src = _act',
  'if src is None and _arms: src = _arms[0]',
];

// Write the bare skeleton (rest pose) to rig.blend. Done on a DUPLICATE with its animation
// cleared, so the user's live rig — pose, animation, everything — is untouched.
function buildAssignCode(rigBlendAbs, rigName) {
  const OUT = rigBlendAbs.replace(/\\/g, '/');
  const NAME = safeFolder(rigName) || 'custom_rig';
  return [
    'import bpy, os',
    `OUT = ${JSON.stringify(OUT)}`,
    `RIGNAME = ${JSON.stringify(NAME)}`,
    ...CUSTOM_TARGET_PY,
    'if src is None:',
    '    print("CRIG_ERR:no armature selected to assign")',
    'else:',
    '    os.makedirs(os.path.dirname(OUT), exist_ok=True)',
    // Erst in den OBJECT-Modus — beide Geschwister (characters.js, buildSaveMeshCode) tun das,
    // hier fehlte es. Wer das Rig gerade posiert hat, steckt im Pose-Modus, und select_all
    // wirft dann einen rohen Kontext-Traceback statt einer verstaendlichen Meldung.
    '    try: bpy.ops.object.mode_set(mode="OBJECT")',
    '    except Exception: pass',
    '    bpy.ops.object.select_all(action="DESELECT")',
    '    src.select_set(True); bpy.context.view_layer.objects.active = src',
    // Die Kopie wird ueber den NAMENSVERGLEICH bestimmt, nicht ueber die Selektion:
    // "loesche im finally, was gerade selektiert ist" waere im Fall, dass duplicate()
    // nichts erzeugt und die Originale selektiert laesst, ein Loeschbefehl auf das
    // Rig des Users. Ueber die Differenz vorher/nachher kann nur Neues geloescht werden.
    '    _before = set(o.name for o in bpy.data.objects)',
    '    bpy.ops.object.duplicate()',
    '    _dups = [o for o in bpy.data.objects if o.name not in _before]',
    '    if not _dups:',
    '        raise RuntimeError("duplicate() created nothing - aborting before touching the original")',
    '    _dup = _dups[0]',
    // Name it after the folder so it reads sensibly when spawned (Blender adds .001 on any
    // clash in the target scene — normal, harmless).
    // try/finally: a raising libraries.write (full disk, bad path, denied permission) would
    // otherwise leave the duplicated rig standing in the user's scene — a failed save that
    // litters the file it was protecting.
    '    try:',
    '        _dup.name = RIGNAME',
    '        if _dup.animation_data:',           // rest-pose template: no animation
    '            _dup.animation_data_clear()',
    '        for _pb in _dup.pose.bones:',       // clear any live pose offset
    '            _pb.location = (0, 0, 0); _pb.rotation_quaternion = (1, 0, 0, 0)',
    '            _pb.rotation_euler = (0, 0, 0); _pb.scale = (1, 1, 1)',
    '        _sig = sorted(b.name for b in _dup.data.bones)',
    '        bpy.data.libraries.write(OUT, {_dup}, fake_user=True)',
    '        _rigname = src.name',
    '    finally:',
    '        for _o in _dups:',
    '            try: bpy.data.objects.remove(_o, do_unlink=True)',
    '            except Exception: pass',
    '    _size = os.path.getsize(OUT) if os.path.exists(OUT) else -1',
    '    print("CRIG_ASSIGN:rig=" + _rigname + ":bones=" + str(len(_sig)) + ":bytes=" + str(_size))',
    '    print("CRIG_SIG:" + ",".join(_sig))',
  ].join('\n');
}

// Append every object from a .blend into the open scene.
function buildSpawnCode(blendAbs) {
  const SRC = blendAbs.replace(/\\/g, '/');
  return [
    'import bpy',
    `SRC = ${JSON.stringify(SRC)}`,
    'with bpy.data.libraries.load(SRC, link=False) as (_from, _to):',
    '    _to.objects = list(_from.objects)',
    '_n = 0',
    'for _o in _to.objects:',
    '    if _o is not None:',
    '        bpy.context.collection.objects.link(_o); _n += 1',
    'print("CRIG_SPAWN:objects=" + str(_n))',
  ].join('\n');
}

async function assignSkeleton(input = {}, cfg) {
  const abs = folderPath(input && input.folder);
  if (!abs) return 'ERROR: invalid folder.';
  if (!fs.existsSync(abs)) return 'ERROR: folder does not exist — create it first.';
  // Capture any skeleton already assigned here BEFORE the signature is overwritten. Re-assign is a valid
  // repair/update path, but silently replacing a skeleton the folder's mesh variants and clips were bound
  // to is a footgun — the caller should be told (fixed 2026-08-02).
  const prior = readSig(abs);
  const rigBlend = path.join(abs, 'rig.blend');
  // Write to a temp .blend and rename on success. Re-assign is the documented repair/update path, so
  // this overwrites an existing rig.blend — an in-place write that crashed mid-way corrupted it and
  // cost every variant/clip in the folder its spawn template. (Same fix as saveCharacter.)
  const tmpBlend = rigBlend + '.tmp-' + process.pid;
  const _cleanTmp = () => { try { fs.unlinkSync(tmpBlend); } catch (_) { /* ignore */ } };
  let r;
  try {
    r = await callBlender(buildAssignCode(tmpBlend, input.folder), { cfg, timeoutMs: 120000 });
  } catch (e) { _cleanTmp(); return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') { _cleanTmp(); return 'ERROR: ' + (r.message || out); }
  const err = out.split('\n').find(l => l.startsWith('CRIG_ERR:'));
  if (err) { _cleanTmp(); return 'ERROR: ' + err.slice('CRIG_ERR:'.length); }
  const m = out.match(/CRIG_ASSIGN:rig=(.+?):bones=(\d+):bytes=(-?\d+)/);
  if (!m) { _cleanTmp(); return out || 'Assign failed.'; }
  const sigLine = out.split('\n').find(l => l.startsWith('CRIG_SIG:'));
  const bones = sigLine ? sigLine.slice('CRIG_SIG:'.length).split(',').filter(Boolean) : [];
  // Commit the rig only now that it exported cleanly.
  try { fs.renameSync(tmpBlend, rigBlend); }
  catch (e) { _cleanTmp(); return 'ERROR: skeleton exported but could not be finalized — ' + e.message; }
  try {
    const sigTmp = path.join(abs, 'signature.json.tmp-' + process.pid);
    fs.writeFileSync(sigTmp, JSON.stringify({
      bones, boneCount: bones.length, rigObject: m[1], source: 'custom',
    }, null, 2), 'utf8');
    fs.renameSync(sigTmp, path.join(abs, 'signature.json'));
  } catch (e) { return 'ERROR: skeleton exported but signature could not be written — ' + e.message; }
  let note = '';
  if (prior && prior.boneCount) {
    note = prior.boneCount === bones.length
      ? ` ⚠ This replaced a skeleton already assigned to the folder (same bone count, ${prior.boneCount}). If it is a different rig, re-check the mesh variants and clips bound to it.`
      : ` ⚠ This replaced the folder's previous skeleton (${prior.boneCount} → ${bones.length} bones). Mesh variants and clips already here were bound to the OLD skeleton and may no longer fit — re-bind or re-check them.`;
  }
  return `Assigned "${m[1]}" to folder "${safeFolder(input.folder)}" — ${m[2]} bones. The folder is now unlocked.${note}`;
}

async function spawnRig(input = {}, cfg) {
  const abs = folderPath(input && input.folder);
  if (!abs) return 'ERROR: invalid folder.';
  const sig = readSig(abs);
  if (!sig || !sig.bones || !sig.bones.length) return 'ERROR: this folder has no skeleton assigned yet.';
  // variant "" / "rig" / undefined -> bare skeleton; otherwise a named mesh variant
  const variant = input.variant && input.variant !== 'rig' ? String(input.variant) : null;
  let blendAbs;
  if (variant) {
    const safeV = variant.replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 60);
    blendAbs = path.join(abs, 'meshes', safeV + '.blend');
    if (!fs.existsSync(blendAbs)) return `ERROR: mesh variant "${safeV}" not found in this folder.`;
  } else {
    blendAbs = path.join(abs, 'rig.blend');
    if (!fs.existsSync(blendAbs)) return 'ERROR: rig.blend missing — re-assign the skeleton.';
  }
  let r;
  try {
    r = await callBlender(buildSpawnCode(blendAbs), { cfg, timeoutMs: 60000 });
  } catch (e) { return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const m = out.match(/CRIG_SPAWN:objects=(\d+)/);
  if (!m) return out || 'Spawn failed.';
  return `Spawned ${variant ? `"${variant}"` : 'bare rig'} from folder "${safeFolder(input.folder)}" — ${m[1]} object(s) in the scene.`;
}

// ─── Save the animation on the selected rig as a clip in this folder ──────────
//
// The custom-rig counterpart to animate_human's saveAnimation. NOT that one: it uses the
// Mixamo-specific target picker (mixamorig:Hips) and would refuse a creature rig. This uses
// the same NLA-bake-on-a-duplicate export (so a built sequence collapses to one take and the
// live scene is untouched) but the CUSTOM target picker. The written clip is gated in Node
// against the folder's signature — a clip that doesn't match this skeleton never lands in clips/.
function buildCustomSaveCode(outAbs) {
  const OUT = outAbs.replace(/\\/g, '/');   // Blender takes forward slashes on every OS
  return [
    'import bpy, addon_utils, os',
    `OUT = ${JSON.stringify(OUT)}`,
    'addon_utils.enable("io_scene_fbx", default_set=False, persistent=False)',
    ...CUSTOM_TARGET_PY,
    'dst = src',
    'if dst is None:',
    '    print("CSAVE_ERR:no armature selected to save (select your rig in the scene)")',
    'else:',
    '    _ad = dst.animation_data',
    '    _has_action = bool(_ad and _ad.action)',
    '    _has_nla = bool(_ad and any(len(t.strips) for t in _ad.nla_tracks))',
    '    if not (_has_action or _has_nla):',
    '        print("CSAVE_ERR:the selected rig has no animation to save")',
    '    else:',
    '        os.makedirs(os.path.dirname(OUT), exist_ok=True)',
    '        _f0 = bpy.context.scene.frame_start; _f1 = bpy.context.scene.frame_end',
    // Saving straight out of Pose mode is the NORMAL case (keyframe a pose, then Save clip), and
    // the bpy.ops.object.* calls below poll for OBJECT mode. Switch ourselves and put the user
    // back afterwards — same guard the Human-tab twin (animate_human.buildSaveAnimationCode) has.
    // Without it, select_all's poll() fails with a raw Python traceback.
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
    // Bake NLA into a single action on a DUPLICATE, then export the duplicate — one take with
    // the evaluated motion, live scene never touched (same reasoning as the Human-tab save).
    '            bpy.ops.object.select_all(action="DESELECT")',
    '            dst.select_set(True); bpy.context.view_layer.objects.active = dst',
    '            bpy.ops.object.duplicate()',
    '            _dup = bpy.context.view_layer.objects.active',
    '            _dup.name = "__csave_tmp__"',
    '            bpy.ops.object.mode_set(mode="POSE")',
    '            bpy.ops.pose.select_all(action="SELECT")',
    '            bpy.ops.nla.bake(frame_start=_f0, frame_end=_f1, only_selected=False,',
    '                             visual_keying=True, clear_constraints=False,',
    '                             use_current_action=True, bake_types={"POSE"})',
    '            bpy.ops.object.mode_set(mode="OBJECT")',
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
    '            print("CSAVE_DONE:" + dst.name + ":frames=" + str(_f0) + "-" + str(_f1) +',
    '                  ":bones=" + str(len(_sig)) + ":bytes=" + str(_size))',
    '            print("CSAVE_SIG:" + ",".join(_sig))',
    '        except Exception as _e:',
    '            _err = _e',
    '        finally:',
    // A mid-way failure must not leave the working duplicate behind in the user's scene, and the
    // user must land back in the mode/selection he started in.
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
    '        if _err is not None:',
    '            _m = str(_err).replace(chr(10), " ").strip()',
    '            if "poll()" in _m or "context is incorrect" in _m:',
    '                _m = ("Blender refused the export in its current state - click once into the " +',
    '                      "3D viewport, leave Edit mode, and try again. (" + _m + ")")',
    '            print("CSAVE_ERR:" + _m)',
  ].join('\n');
}

async function saveClip(input = {}, cfg) {
  const abs = folderPath(input && input.folder);
  if (!abs) return 'ERROR: invalid folder.';
  if (!fs.existsSync(abs)) return 'ERROR: folder does not exist — create it first.';
  const folderSig = readSig(abs);
  if (!folderSig || !Array.isArray(folderSig.bones) || !folderSig.bones.length) {
    return 'ERROR: this folder has no skeleton assigned yet — assign one first.';
  }
  const base = safeClipName(input && input.name);
  if (!base) return 'ERROR: give the clip a name to save it under.';
  const outAbs = path.join(abs, 'clips', base);
  // Refuse to overwrite — the same guard saveMesh has. Without it, saving with the name of an
  // existing clip while the WRONG rig is selected was destructive twice over: the export
  // overwrote the good clip, and then the signature gate deleted the file it had just written.
  // The user lost a working animation by mis-clicking a name.
  if (fs.existsSync(outAbs)) {
    return `ERROR: a clip named "${base}" already exists in this folder — pick another name ` +
           '(or delete the old one first).';
  }
  let r;
  try {
    r = await callBlender(buildCustomSaveCode(outAbs), { cfg, timeoutMs: 180000 });
  } catch (e) { return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('CSAVE_ERR:'));
  if (err) return 'ERROR: ' + err.slice('CSAVE_ERR:'.length);
  const m = out.match(/CSAVE_DONE:(.+?):frames=([\d-]+):bones=(\d+):bytes=(-?\d+)/);
  if (!m) return out || 'Save failed.';
  const sigLine = out.split('\n').find(l => l.startsWith('CSAVE_SIG:'));
  const bones = sigLine ? sigLine.slice('CSAVE_SIG:'.length).split(',').filter(Boolean) : [];
  // Gate: the clip must belong to THIS folder's skeleton, else Animate here would break.
  // The folder signature is already sorted; the exported one is sorted too.
  const matches = bones.length === folderSig.bones.length &&
                  bones.every((b, i) => b === folderSig.bones[i]);
  if (!matches) {
    try { fs.unlinkSync(outAbs); } catch (_) { /* ignore */ }
    return `ERROR: the selected rig's skeleton (${bones.length} bones) doesn't match this folder's ` +
           `skeleton (${folderSig.bones.length} bones). Spawn THIS folder's rig, keyframe that, then save.`;
  }
  try {
    fs.writeFileSync(outAbs + '.sig.json', JSON.stringify({
      bones, boneCount: bones.length, source: 'custom', folder: safeFolder(input.folder), frames: m[2],
    }, null, 2), 'utf8');
  } catch (_) { /* the clip itself is saved; a missing sidecar just disables filtering */ }
  return `Saved "${base}" to folder "${safeFolder(input.folder)}" — frames ${m[2]}, ${m[3]} bones. ` +
         `Pick it under Animate to re-apply it.`;
}

// ─── Apply a clip from this folder onto the rig in the scene ──────────────────
//
// Trivial by construction: the clip was saved FROM a spawn of this exact skeleton, so source
// and target share every bone name. No cross-skeleton retarget, no scale-match (factor 1), no
// HY-fix (hand-keyed clips carry their own motion). Copy-rotation on every matching bone +
// copy-location on the root bone(s) for root motion, bake, delete the imported source.
function buildCustomAnimateCode(fbxAbs) {
  const FBX = fbxAbs.replace(/\\/g, '/');
  return [
    'import bpy, addon_utils',
    `FBX = ${JSON.stringify(FBX)}`,
    'addon_utils.enable("io_scene_fbx", default_set=False, persistent=False)',
    // Pick the TARGET before importing, so the clip's own armature can't be chosen as target.
    ...CUSTOM_TARGET_PY,
    'dst = src',
    'if dst is None:',
    '    print("CANIM_ERR:no armature in the scene to animate (spawn this folder\'s rig first)")',
    'else:',
    '    _before = set(bpy.data.objects)',
    // The import brings its own action, with a fake user attached by Blender's FBX importer, so
    // deleting the source rig used to leave it in the file for good (measured 2026-07-24: one
    // orphan per applied clip). Snapshot taken before the bake, so the baked result is never in it.
    '    _actsb = set(bpy.data.actions)',
    '    bpy.ops.import_scene.fbx(filepath=FBX)',
    '    _new = list(set(bpy.data.objects) - _before)',
    '    _newacts = [a for a in bpy.data.actions if a not in _actsb]',
    '    srcclip = next((o for o in _new if o.type == "ARMATURE"), None)',
    '    if srcclip is None:',
    // objects FIRST, actions after — an action still held by a live object keeps a user and would
    // (correctly) refuse to go
    '        for o in _new:',
    '            try: bpy.data.objects.remove(o, do_unlink=True)',
    '            except Exception: pass',
    '        for _a in _newacts:',
    '            try:',
    '                _a.use_fake_user = False',
    '                if _a.users == 0: bpy.data.actions.remove(_a)',
    '            except Exception: pass',
    '        print("CANIM_ERR:no armature in the clip FBX")',
    '    else:',
    '        act = srcclip.animation_data.action if srcclip.animation_data else None',
    '        fr = act.frame_range if act else (bpy.context.scene.frame_start, bpy.context.scene.frame_end)',
    '        f0, f1 = int(fr[0]), int(fr[1])',
    // Identical skeleton by construction -> exact bone-name match; suffix fallback is pure
    // insurance in case an FBX roundtrip ever namespaces a name.
    '        def _suf(n): return n.split(":")[-1]',
    '        _exact = {b.name: b.name for b in srcclip.pose.bones}',
    '        _bysuf = {_suf(b.name): b.name for b in srcclip.pose.bones}',
    '        def _match(n):',
    '            return _exact.get(n) or _bysuf.get(_suf(n))',
    // Keep the character where the user placed it. Copy-location otherwise pins the target's
    // root to the imported clip's world position (which starts at the origin), teleporting the
    // figure to the centre. Instead, slide the imported clip so its root head starts exactly on
    // the target's CURRENT root head at f0 -- a constant object offset preserves all relative
    // root motion, so the clip plays out from where the character stands.
    '        bpy.context.scene.frame_set(f0)',
    '        bpy.context.view_layer.update()',
    '        _rootname = None',
    '        for pb in dst.pose.bones:',
    '            if pb.parent is None and _match(pb.name):',
    '                _rootname = pb.name; break',
    '        if _rootname:',
    '            _sr = _match(_rootname)',
    '            _dhead = (dst.matrix_world @ dst.pose.bones[_rootname].matrix).translation',
    '            _shead = (srcclip.matrix_world @ srcclip.pose.bones[_sr].matrix).translation',
    '            srcclip.location = srcclip.location + (_dhead - _shead)',
    '            bpy.context.view_layer.update()',
    '        _m = 0',
    '        for pb in dst.pose.bones:',
    '            _sn = _match(pb.name)',
    '            if _sn:',
    '                c = pb.constraints.new("COPY_ROTATION"); c.target = srcclip; c.subtarget = _sn; _m += 1',
    // Root motion: copy-location on every root bone (no parent) that the clip also has.
    '        _rm = 0',
    '        for pb in dst.pose.bones:',
    '            if pb.parent is None:',
    '                _sn = _match(pb.name)',
    '                if _sn:',
    '                    c = pb.constraints.new("COPY_LOCATION"); c.target = srcclip; c.subtarget = _sn; _rm += 1',
    '        if _m == 0:',
    '            for o in _new:',
    '                try: bpy.data.objects.remove(o, do_unlink=True)',
    '                except Exception: pass',
    '            for _a in _newacts:',
    '                try:',
    '                    _a.use_fake_user = False',
    '                    if _a.users == 0: bpy.data.actions.remove(_a)',
    '                except Exception: pass',
    '            print("CANIM_ERR:the clip shares no bone names with the rig in the scene")',
    '        else:',
    '            bpy.context.scene.frame_start = f0; bpy.context.scene.frame_end = f1',
    '            bpy.ops.object.mode_set(mode="OBJECT")',
    '            bpy.ops.object.select_all(action="DESELECT")',
    '            dst.select_set(True); bpy.context.view_layer.objects.active = dst',
    '            _baked = False',
    '            try:',
    '                bpy.ops.object.mode_set(mode="POSE")',
    '                bpy.ops.pose.select_all(action="SELECT")',
    '                bpy.ops.nla.bake(frame_start=f0, frame_end=f1, only_selected=False,',
    '                                 visual_keying=True, clear_constraints=True, clear_parents=False,',
    '                                 use_current_action=True, bake_types={"POSE"})',
    '                _baked = True',
    '            except Exception as _be:',
    '                print("CANIM_BAKE_WARN:" + repr(_be))',
    '            finally:',
    '                try: bpy.ops.object.mode_set(mode="OBJECT")',
    '                except Exception: pass',
    // Only remove the imported source when the bake actually happened. The constraints target it;
    // deleting it after a failed bake leaves dead constraints and no animation, while the reply
    // says the constraints were left in place for the user to work with.
    '            if _baked:',
    '                for o in _new:',
    '                    try: bpy.data.objects.remove(o, do_unlink=True)',
    '                    except Exception: pass',
    // users==0 after dropping the fake user is the guard — anything still attached survives
    '                for _a in _newacts:',
    '                    try:',
    '                        _a.use_fake_user = False',
    '                        if _a.users == 0: bpy.data.actions.remove(_a)',
    '                    except Exception: pass',
    '            bpy.context.scene.frame_set(f0)',
    '            print("CANIM_DONE:" + dst.name + ":bones=" + str(_m) + ":root=" + str(_rm) +',
    '                  ":frames=" + str(f0) + "-" + str(f1) + ":baked=" + str(_baked))',
  ].join('\n');
}

async function animateClip(input = {}, cfg) {
  const abs = folderPath(input && input.folder);
  if (!abs) return 'ERROR: invalid folder.';
  const sig = readSig(abs);
  if (!sig || !sig.bones || !sig.bones.length) return 'ERROR: this folder has no skeleton assigned yet.';
  const clipAbs = resolveClip(abs, input && input.clip);
  if (!clipAbs) {
    const have = describeFolder(input.folder);
    const clips = (have && have.clips) || [];
    return `ERROR: clip not found in this folder.` + (clips.length ? ` Available: ${clips.join(', ')}` : ' (no clips saved yet)');
  }
  let r;
  try {
    r = await callBlender(buildCustomAnimateCode(clipAbs), { cfg, timeoutMs: 300000 });
  } catch (e) { return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('CANIM_ERR:'));
  if (err) return 'ERROR: ' + err.slice('CANIM_ERR:'.length);
  const m = out.match(/CANIM_DONE:(.+?):bones=(\d+):root=(\d+):frames=([\d-]+):baked=(\w+)/);
  if (!m) return out || 'Animate failed.';
  const baked = m[5] === 'True';
  return `Animated "${m[1]}" from ${path.basename(clipAbs)} — ${m[2]} bones` +
         (Number(m[3]) ? `, ${m[3]} root bone(s)` : '') + `, frames ${m[4]}` +
         (baked ? ', baked (source removed).' : ' (bake failed — the imported source and its live constraints were LEFT in the scene so you can inspect or bake manually; delete it when done).');
}

// ─── Chain clips: Sequence (rebuild) and Append (add to the end) ──────────────
//
// Same feature as the Human tab's playlist, same code — see buildSequenceAnimationsCode in
// animate_human.js. Four things differ on a creature rig, and they are exactly the four
// options that builder takes:
//
//   1. the target picker           — any armature, not "the one with mixamorig:Hips"
//   2. the root bone               — whatever this rig has, not a fixed name
//   3. no thigh-ratio scale match  — source and target ARE the same skeleton (factor 1)
//   4. no HY-Motion import fix     — text-to-motion only produces humanoids; these clips are
//                                    hand-keyed and already in the rig's own conventions
//
// Plus two placement rules that only matter here: the clip is slid onto the creature's CURRENT
// position before baking (a creature stands where the user put it, unlike a Human-tab character
// at the origin), and the object location is never zeroed for the same reason.
const CUSTOM_ROOT_PY = [
  // Which bone carries the root motion? Mixamo always answers "mixamorig:Hips"; a creature rig
  // answers whatever its author built. Take the parentless bone with the biggest subtree — on a
  // one-skeleton rig (deer, monster, mech) that IS the root, and it is the same bone the
  // single-clip path copy-locations.
  '    def _subtree(_b):',
  '        _n = 1',
  '        for _c in _b.children: _n += _subtree(_c)',
  '        return _n',
  '    _roots = [b for b in dst.pose.bones if b.parent is None]',
  '    HIPS = max(_roots, key=_subtree).name if _roots else ""',
  // Exact bone path, NOT a substring test. "Bone" is a prefix of "Bone.001" (that is literally
  // what Blender's default names look like), so a substring match would pull every sibling
  // bone's curves into the root's channel set and the seam maths would be nonsense.
  '    _HIPPATH = "pose.bones[\\"" + HIPS + "\\"]"',
  '    print("SEQ_ROOT:" + HIPS + ":roots=" + str(len(_roots)))',
];

// Root motion onto EVERY parentless bone, matching what the single-clip Animate does, so one
// clip looks the same whether it was applied alone or as part of a chain. The seam correction
// still runs on the primary root only — a rig with several roots gets its extra roots played
// per clip but not stitched, which is why the count is reported.
const CUSTOM_ROOTLOC_PY = [
  '        for _pb in dst.pose.bones:',
  '            if _pb.parent is None and _suf(_pb.name) in _src_by:',
  '                c = _pb.constraints.new("COPY_LOCATION"); c.target = src; c.subtarget = _src_by[_suf(_pb.name)]',
];

// Keep the creature where it stands. COPY_LOCATION pins the target bone to the SOURCE's world
// position, and the imported clip sits at the origin — without this the creature teleports to
// the centre of the scene the moment the chain is built (the same trap the single-clip path
// fixes). Sliding the imported clip so its root head starts on the target's root head at f0 is
// a constant object offset: all relative root motion survives. For clips 2..n the seam offset
// overwrites this anyway; for the FIRST clip it is what puts the chain in the right place.
const CUSTOM_CLIPPLACE_PY = [
  '        bpy.context.scene.frame_set(_f0)',
  '        bpy.context.view_layer.update()',
  '        _srcroot = _src_by.get(_suf(HIPS)) if HIPS else None',
  '        if _srcroot and HIPS in dst.pose.bones:',
  '            _dhead = (dst.matrix_world @ dst.pose.bones[HIPS].matrix).translation',
  '            _shead = (src.matrix_world @ src.pose.bones[_srcroot].matrix).translation',
  '            src.location = src.location + (_dhead - _shead)',
  '            bpy.context.view_layer.update()',
];

const CUSTOM_SEQ_OPTS = {
  targetPy: [...CUSTOM_TARGET_PY, 'dst = src'],
  errNoTarget: "no armature in the scene to animate (spawn this folder's rig first)",
  rootPy: CUSTOM_ROOT_PY,
  rootMatch: 'fc.data_path.startswith(_HIPPATH)',
  rootNoMatch: 'not fc.data_path.startswith(_HIPPATH)',
  scaleMatch: false,
  hyFix: false,
  rootLocPy: CUSTOM_ROOTLOC_PY,
  clipPlacePy: CUSTOM_CLIPPLACE_PY,
  resetObjectLoc: false,
};

async function sequenceClips(input = {}, cfg) {
  const abs = folderPath(input && input.folder);
  if (!abs) return 'ERROR: invalid folder.';
  if (!fs.existsSync(abs)) return 'ERROR: folder does not exist — create it first.';
  const sig = readSig(abs);
  if (!sig || !sig.bones || !sig.bones.length) return 'ERROR: this folder has no skeleton assigned yet.';
  const names = Array.isArray(input && input.clips) ? input.clips : [];
  const resolved = names.map(n => resolveClip(abs, n)).filter(Boolean);
  if (!resolved.length) {
    const have = describeFolder(input.folder);
    const clips = (have && have.clips) || [];
    return 'ERROR: no valid clips in the list.' +
           (clips.length ? ` Available: ${clips.join(', ')}` : ' (no clips saved yet)');
  }
  const append = input.append === true;
  let r;
  try {
    // speed = 0 and character = '': extra object drift exists for Mixamo "In Place" clips, which
    // have no counterpart here, and the target is picked from the scene, not by name.
    r = await callBlender(
      buildSequenceAnimationsCode(resolved, input.blend, 0, '', append, CUSTOM_SEQ_OPTS),
      { cfg, timeoutMs: 900000 });
  } catch (e) { return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('SEQ_ERR:'));
  if (err) return 'ERROR: ' + err.slice('SEQ_ERR:'.length);
  const m = out.match(/SEQ_DONE:(.+?):clips=(\d+):frames=([\d-]+):blend=(\d+):append=(\w+):travel=([\d.]+)/);
  if (!m) return out || 'Sequence failed.';
  const skipped = (out.match(/SEQ_SKIP:/g) || []).length;
  const root = out.match(/SEQ_ROOT:(.*?):roots=(\d+)/);
  const verb = m[5] === 'True' ? 'Appended' : 'Sequenced';
  return `${verb} ${m[2]} clip(s) onto "${m[1]}" — frames ${m[3]}, blend ${m[4]}f, root travel ${m[6]}m` +
         (skipped ? ` (${skipped} skipped)` : '') +
         (root ? `, root bone "${root[1]}"` : '') + '.' +
         (root && Number(root[2]) > 1
           ? ` ⚠️ This rig has ${root[2]} root bones — the seams are matched on "${root[1]}" only; ` +
             'the other roots play each clip as saved.'
           : '');
}

// ─── Rig ans Mesh — prepare a bare mesh, then bind it to this folder's skeleton ─
//
// The last piece of the custom-rig roadmap, and the one that CANNOT be a single button:
// automatic weights need bones that already sit roughly inside the mesh, and no code can
// place them reliably on a mesh it has never seen. So the feature is two deterministic
// steps with the user's own alignment (if any) in between:
//
//   Spawn rig -> [Prepare] join + voxel-remesh -> (align bones in EDIT mode, if needed)
//                -> [Bind] automatic weights + verify -> Save Mesh (existing)
//
// The dominant case needs no alignment at all: a folder is ONE anatomy with many tissue
// variants (deer fat/thin, monster bulky/lean), so the folder's skeleton already fits the
// next mesh — that is the whole point of binding clips to a folder. Re-fitting the folder's
// skeleton for a variant is the thing to AVOID: bone names stay the same (signature still
// matches) but every existing clip renders differently on the moved bones.
//
// The chain is join -> voxel remesh -> automatic weights, proven twice on a generated deer.
// The two steps that follow it in practice — baking a diffuse texture back onto the remesh and
// keeping crisp original details as bone-parented overlays — stay OUT of this code: they are
// judged by eye, not deterministic. Failure modes and fixes for users:
// troubleshooting/entries/custom-rig-bind-fails.md.
// Verified against Blender 5.1.2: parent_set has ARMATURE_AUTO, Mesh has
// remesh_voxel_size/remesh_mode, voxel_remesh() takes no arguments of its own.

function buildPrepareMeshCode(voxel, doRemesh) {
  const VOX = Number.isFinite(Number(voxel)) && Number(voxel) > 0 ? Number(voxel) : 0;
  return [
    'import bpy',
    `VOXEL = ${VOX}`,
    `DOREMESH = ${doRemesh ? 'True' : 'False'}`,
    '_sel = [o for o in bpy.context.selected_objects if o.type == "MESH"]',
    '_act = bpy.context.view_layer.objects.active',
    'if _act is not None and _act.type == "MESH" and _act not in _sel: _sel.append(_act)',
    'if not _sel:',
    '    print("CPREP_ERR:select the mesh (or mesh fragments) you want to rig — nothing mesh-like is selected.")',
    'else:',
    // A bound mesh must not go through here: joining/remeshing a mesh that is already
    // deformed by an armature bakes whatever pose it is in (creature-pipeline step 1).
    '    _b = [o for o in _sel if any(m.type == "ARMATURE" for m in o.modifiers)]',
    '    if _b:',
    '        print("CPREP_ERR:\\"" + _b[0].name + "\\" is already bound to an armature. Prepare works on a bare mesh — remove its Armature modifier, or duplicate the mesh first.")',
    '    else:',
    '        try: bpy.ops.object.mode_set(mode="OBJECT")',
    '        except Exception: pass',
    '        bpy.ops.object.select_all(action="DESELECT")',
    '        for _o in _sel: _o.select_set(True)',
    '        bpy.context.view_layer.objects.active = _sel[0]',
    '        _njoin = len(_sel)',
    '        if _njoin > 1: bpy.ops.object.join()',
    '        _obj = bpy.context.view_layer.objects.active',
    '        _before = len(_obj.data.polygons)',
    // Voxel remesh works in LOCAL space: a scaled object would be remeshed at the wrong
    // effective resolution (and auto-weights on a scaled rig/mesh pair is its own mess).
    // Applying scale here is a real mutation, so it is reported back, not done silently.
    '        _sc = tuple(round(v, 4) for v in _obj.scale)',
    '        _applied = 0',
    '        if _sc != (1.0, 1.0, 1.0):',
    '            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)',
    '            _applied = 1',
    '        _d = _obj.dimensions',
    '        _diag = (_d.x * _d.x + _d.y * _d.y + _d.z * _d.z) ** 0.5',
    // Voxel size is SCALE-DEPENDENT. The 0.04 that was right for the deer would shred a mouse
    // and do nothing to a whale, so the default is derived from the object's own size.
    '        _vox = VOXEL if VOXEL > 0 else max(0.0005, _diag / 60.0)',
    '        _after = _before',
    '        if DOREMESH:',
    '            _me = _obj.data',
    '            try: _me.remesh_mode = "VOXEL"',
    '            except Exception: pass',
    '            _me.remesh_voxel_size = _vox',
    '            bpy.ops.object.voxel_remesh()',
    '            _after = len(_obj.data.polygons)',
    '        print("CPREP_DONE:obj=" + _obj.name + ":joined=" + str(_njoin) + ":applied=" + str(_applied) +',
    '              ":before=" + str(_before) + ":after=" + str(_after) + ":voxel=" + ("%.4f" % _vox) +',
    '              ":diag=" + ("%.3f" % _diag) + ":remesh=" + ("1" if DOREMESH else "0"))',
  ].join('\n');
}

function buildBindMeshCode(sigBones) {
  return [
    'import bpy',
    'from mathutils import Matrix',
    `SIG = ${JSON.stringify(sigBones)}`,
    '_arm = next((o for o in bpy.context.selected_objects if o.type == "ARMATURE"), None)',
    '_act = bpy.context.view_layer.objects.active',
    'if _arm is None and _act is not None and _act.type == "ARMATURE": _arm = _act',
    'if _arm is None:',
    '    _all = [o for o in bpy.data.objects if o.type == "ARMATURE"]',
    '    if len(_all) == 1: _arm = _all[0]',
    'if _arm is None:',
    '    print("CBIND_ERR:no armature selected — spawn this folder\'s rig, then select the mesh AND the rig.")',
    'else:',
    '    _have = sorted(b.name for b in _arm.data.bones)',
    '    if _have != sorted(SIG):',
    '        print("CBIND_ERR:\\"" + _arm.name + "\\" (" + str(len(_have)) + " bones) is not this folder\'s skeleton (" + str(len(SIG)) + " bones). Spawn this folder\'s rig and bind to that one.")',
    '    else:',
    // THE gate this feature exists for. Fitting a rig in POSE mode looks right at bind time
    // and collapses on the first animation, because the rest pose never changed. Fitting in
    // EDIT mode changes the rest pose itself and leaves every pose bone at identity — which
    // is exactly what this check reads. matrix_basis covers loc+rot+scale in one comparison.
    '        _I = Matrix.Identity(4)',
    '        def _posed(pb):',
    '            m = pb.matrix_basis',
    '            return max(abs(m[i][j] - _I[i][j]) for i in range(4) for j in range(4)) > 1e-4',
    '        _bad = [pb.name for pb in _arm.pose.bones if _posed(pb)]',
    '        _hasact = bool(_arm.animation_data and _arm.animation_data.action)',
    '        if _bad or _hasact:',
    '            _why = ("an animation" if _hasact else str(len(_bad)) + " posed bone(s), e.g. " + _bad[0])',
    '            print("CBIND_ERR:the rig carries " + _why + " — binding now would bake that pose in as the rest pose. Fit bones in EDIT mode (that IS the rest pose), or use Pose > Apply > Apply Pose as Rest Pose, then bind.")',
    '        else:',
    '            _meshes = [o for o in bpy.context.selected_objects if o.type == "MESH"]',
    '            if not _meshes:',
    '                print("CBIND_ERR:no mesh selected — select the mesh(es) AND this folder\'s rig, then bind.")',
    '            else:',
    '                _already = [o for o in _meshes if any(m.type == "ARMATURE" for m in o.modifiers)]',
    '                if _already:',
    '                    print("CBIND_ERR:\\"" + _already[0].name + "\\" is already bound to an armature — nothing to do (or unbind it first).")',
    '                else:',
    '                    try: bpy.ops.object.mode_set(mode="OBJECT")',
    '                    except Exception: pass',
    '                    bpy.ops.object.select_all(action="DESELECT")',
    '                    for _o in _meshes: _o.select_set(True)',
    '                    _arm.select_set(True); bpy.context.view_layer.objects.active = _arm',
    '                    _err = ""',
    '                    try: bpy.ops.object.parent_set(type="ARMATURE_AUTO")',
    '                    except Exception as _e: _err = repr(_e)',
    '                    if _err:',
    '                        print("CBIND_ERR:automatic weights failed — " + _err + " | classic non-manifold failure: run Prepare with Remesh on, then bind again.")',
    '                    else:',
    // The bind can also "succeed" and leave vertices with no weight at all — bone-heat
    // weighting reports that as a warning, not an error. So the result is MEASURED, never
    // assumed: count vertices carrying no deform weight and report the number.
    '                        _db = set(b.name for b in _arm.data.bones if b.use_deform)',
    '                        _tot = 0; _un = 0',
    '                        for _m in _meshes:',
    '                            _gi = set(g.index for g in _m.vertex_groups if g.name in _db)',
    '                            for _v in _m.data.vertices:',
    '                                _tot += 1',
    '                                if not any((_g.group in _gi and _g.weight > 0.0) for _g in _v.groups): _un += 1',
    '                        print("CBIND_DONE:arm=" + _arm.name + ":meshes=" + str(len(_meshes)) +',
    '                              ":verts=" + str(_tot) + ":unbound=" + str(_un))',
  ].join('\n');
}

async function prepareMesh(input = {}, cfg) {
  const abs = folderPath(input && input.folder);
  if (!abs) return 'ERROR: invalid folder.';
  const sig = readSig(abs);
  if (!sig || !sig.bones || !sig.bones.length) return 'ERROR: this folder has no skeleton assigned yet.';
  const voxel = Number.isFinite(Number(input.voxel)) && Number(input.voxel) > 0 ? Number(input.voxel) : 0;
  const doRemesh = input.remesh !== false;
  let r;
  try {
    // A voxel remesh on a dense mesh is minutes of work, not seconds.
    r = await callBlender(buildPrepareMeshCode(voxel, doRemesh), { cfg, timeoutMs: 600000 });
  } catch (e) { return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('CPREP_ERR:'));
  if (err) return 'ERROR: ' + err.slice('CPREP_ERR:'.length);
  const m = out.match(/CPREP_DONE:obj=(.+?):joined=(\d+):applied=(\d):before=(\d+):after=(\d+):voxel=([\d.]+):diag=([\d.]+):remesh=(\d)/);
  if (!m) return out || 'Prepare failed.';
  const [, obj, joined, applied, before, after, vox, diag, remeshed] = m;
  const parts = [`Prepared "${obj}"`];
  if (Number(joined) > 1) parts.push(`joined ${joined} meshes`);
  if (applied === '1') parts.push('applied object scale (voxel remesh needs it)');
  if (remeshed === '1') {
    parts.push(`voxel-remeshed at ${vox} (auto-derived from its ${diag} m size)`);
    parts.push(`${before} → ${after} faces`);
  } else {
    parts.push(`no remesh (${before} faces kept)`);
  }
  return parts.join(' — ') + '. Now check the rig sits inside it (fit bones in EDIT mode if not), ' +
         'then select mesh + rig and press Bind.';
}

async function bindMesh(input = {}, cfg) {
  const abs = folderPath(input && input.folder);
  if (!abs) return 'ERROR: invalid folder.';
  const sig = readSig(abs);
  if (!sig || !Array.isArray(sig.bones) || !sig.bones.length) {
    return 'ERROR: this folder has no skeleton assigned yet.';
  }
  let r;
  try {
    r = await callBlender(buildBindMeshCode(sig.bones), { cfg, timeoutMs: 600000 });
  } catch (e) { return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('CBIND_ERR:'));
  if (err) return 'ERROR: ' + err.slice('CBIND_ERR:'.length);
  const m = out.match(/CBIND_DONE:arm=(.+?):meshes=(\d+):verts=(\d+):unbound=(\d+)/);
  if (!m) return out || 'Bind failed.';
  const [, arm, nMesh, verts, unbound] = m;
  const head = `Bound ${nMesh} mesh${Number(nMesh) === 1 ? '' : 'es'} to "${arm}" — ${verts} vertices`;
  if (Number(unbound) === 0) {
    return head + ', 100% weighted. Pose the rig to check it deforms, then "Save Mesh" to keep it as a variant.';
  }
  const pct = ((Number(unbound) / Number(verts)) * 100).toFixed(1);
  return head + `, but ${unbound} of them (${pct}%) carry NO weight and will not follow the rig. ` +
         'Usually the mesh is not one closed piece, or a limb sits too far from its bone: ' +
         'run Prepare with Remesh on (a finer voxel size if it is already on), or move the bones closer, then bind again.';
}

// ─── Save the selected mesh (on this folder's skeleton) as a spawnable variant ─
//
// Writes meshes/<name>.blend containing the mesh AND its armature, self-contained: every
// texture/map is PACKED first (bpy.ops.file.pack_all) so the .blend still renders after a
// fresh open — the same lesson the creature diffuse-bake taught. buildSpawnCode already
// appends every object in the file, so a spawn of this variant brings rig + visible mesh.
function buildSaveMeshCode(outAbs) {
  const OUT = outAbs.replace(/\\/g, '/');
  return [
    'import bpy, os',
    `OUT = ${JSON.stringify(OUT)}`,
    // A creature is usually MANY meshes on one skeleton (body + head + eyes + teeth …). Find the
    // ARMATURE first, then grab EVERY mesh bound to it — not just the one selected. That is what
    // "save the whole creature as a variant" needs, and it fixes the earlier "only the head" bug.
    '_act = bpy.context.view_layer.objects.active',
    '_arm = _act if (_act is not None and _act.type == "ARMATURE") else None',
    // If a mesh (not an armature) is active/selected, follow it to its armature.
    'if _arm is None:',
    '    _cm = _act if (_act is not None and _act.type == "MESH") else next((o for o in bpy.context.selected_objects if o.type == "MESH"), None)',
    '    if _cm is not None:',
    '        for _md in _cm.modifiers:',
    '            if _md.type == "ARMATURE" and _md.object is not None:',
    '                _arm = _md.object; break',
    '        if _arm is None:',
    '            _p = _cm.parent',
    '            while _p is not None and _p.type != "ARMATURE":',
    '                _p = _p.parent',
    '            if _p is not None and _p.type == "ARMATURE": _arm = _p',
    // Last resort: the only armature in the file.
    'if _arm is None:',
    '    _arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]',
    '    if len(_arms) == 1: _arm = _arms[0]',
    'if _arm is None:',
    '    print("CMESH_ERR:could not find the armature — select the creature (its rig or any of its meshes) first")',
    'else:',
    // Every mesh bound to _arm: an Armature-modifier target == _arm, OR parented (any depth) to _arm.
    '    def _bound(o):',
    '        if o.type != "MESH": return False',
    '        for _md in o.modifiers:',
    '            if _md.type == "ARMATURE" and _md.object is _arm: return True',
    '        _p = o.parent',
    '        while _p is not None:',
    '            if _p is _arm: return True',
    '            _p = _p.parent',
    '        return False',
    '    _meshes = [o for o in bpy.data.objects if _bound(o)]',
    '    if not _meshes:',
    '        print("CMESH_ERR:no meshes are bound to this armature")',
    '    else:',
    '        os.makedirs(os.path.dirname(OUT), exist_ok=True)',
    // Pack textures/maps INTO the datablocks so the written .blend is self-contained. This
    // touches the live file's image datablocks (harmless, not saved) — the price of a portable variant.
    '        try: bpy.ops.file.pack_all()',
    '        except Exception as _pe: print("CMESH_PACKWARN:" + repr(_pe))',
    '        _sig = sorted(b.name for b in _arm.data.bones)',
    '        _nmesh = len(_meshes)',
    // A mesh variant is a spawn TEMPLATE: it must arrive in rest pose, not carrying whatever
    // animation happened to be on the rig at save time. So duplicate the whole set, strip the
    // duplicate armature's animation + reset its pose, write the duplicates, delete them — the
    // live rig (and the user's animation) is never touched. bpy duplicate remaps the meshes'
    // armature-modifier/parent onto the duplicate armature automatically.
    '        try: bpy.ops.object.mode_set(mode="OBJECT")',
    '        except Exception: pass',
    '        bpy.ops.object.select_all(action="DESELECT")',
    '        for _o in _meshes: _o.select_set(True)',
    '        _arm.select_set(True); bpy.context.view_layer.objects.active = _arm',
    // Namensvergleich statt Selektion — siehe buildAssignCode: nur wirklich Neues darf
    // im finally geloescht werden, sonst raeumt ein fehlgeschlagenes duplicate() die
    // Originale des Users weg.
    '        _before = set(o.name for o in bpy.data.objects)',
    '        bpy.ops.object.duplicate()',
    '        _dups = [o for o in bpy.data.objects if o.name not in _before]',
    '        if not _dups:',
    '            raise RuntimeError("duplicate() created nothing - aborting before touching the originals")',
    // try/finally — same reason as the character save: a failed write must not leave the
    // duplicated armature + mesh copies behind in the user's scene.
    '        try:',
    '            _darm = next((o for o in _dups if o.type == "ARMATURE"), None)',
    '            if _darm is not None:',
    '                if _darm.animation_data:',
    '                    _darm.animation_data_clear()',
    '                for _pb in _darm.pose.bones:',
    '                    _pb.location = (0, 0, 0); _pb.rotation_quaternion = (1, 0, 0, 0)',
    '                    _pb.rotation_euler = (0, 0, 0); _pb.scale = (1, 1, 1)',
    '            bpy.data.libraries.write(OUT, set(_dups), fake_user=True)',
    '            _size = os.path.getsize(OUT) if os.path.exists(OUT) else -1',
    '        finally:',
    '            for _o in _dups:',
    '                try: bpy.data.objects.remove(_o, do_unlink=True)',
    '                except Exception: pass',
    '        print("CMESH_DONE:meshes=" + str(_nmesh) + ":arm=" + _arm.name +',
    '              ":bones=" + str(len(_sig)) + ":bytes=" + str(_size))',
    '        print("CMESH_SIG:" + ",".join(_sig))',
  ].join('\n');
}

async function saveMesh(input = {}, cfg) {
  const abs = folderPath(input && input.folder);
  if (!abs) return 'ERROR: invalid folder.';
  if (!fs.existsSync(abs)) return 'ERROR: folder does not exist — create it first.';
  const folderSig = readSig(abs);
  if (!folderSig || !Array.isArray(folderSig.bones) || !folderSig.bones.length) {
    return 'ERROR: this folder has no skeleton assigned yet — assign one first.';
  }
  const safe = safeVariantName(input && input.name);
  if (!safe) return 'ERROR: give the mesh variant a name.';
  const outAbs = path.join(abs, 'meshes', safe + '.blend');
  if (fs.existsSync(outAbs)) return `ERROR: a variant named "${safe}" already exists in this folder.`;
  let r;
  try {
    r = await callBlender(buildSaveMeshCode(outAbs), { cfg, timeoutMs: 180000 });
  } catch (e) { return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const err = out.split('\n').find(l => l.startsWith('CMESH_ERR:'));
  if (err) return 'ERROR: ' + err.slice('CMESH_ERR:'.length);
  const m = out.match(/CMESH_DONE:meshes=(\d+):arm=(.+?):bones=(\d+):bytes=(-?\d+)/);
  if (!m) return out || 'Save mesh failed.';
  const sigLine = out.split('\n').find(l => l.startsWith('CMESH_SIG:'));
  const bones = sigLine ? sigLine.slice('CMESH_SIG:'.length).split(',').filter(Boolean) : [];
  // Gate: the armature must be THIS folder's skeleton, else spawning it gives a rig that
  // no clip in this folder can drive.
  const matches = bones.length === folderSig.bones.length &&
                  bones.every((b, i) => b === folderSig.bones[i]);
  if (!matches) {
    try { fs.unlinkSync(outAbs); } catch (_) { /* ignore */ }
    return `ERROR: the mesh's armature (${bones.length} bones) doesn't match this folder's ` +
           `skeleton (${folderSig.bones.length} bones). Only meshes bound to this folder's rig can be saved here.`;
  }
  const bytesKb = m[4] > 0 ? ` (${Math.round(Number(m[4]) / 1024)} KB)` : '';
  const nMesh = Number(m[1]);
  return `Saved mesh variant "${safe}" to folder "${safeFolder(input.folder)}" — ${nMesh} mesh${nMesh === 1 ? '' : 'es'} on "${m[2]}"${bytesKb}. ` +
         `Pick "rig + ${safe}" in the Spawn dropdown.`;
}

module.exports = {
  CUSTOM_DIR, ensureDir, safeFolder, safeClipName, safeVariantName, folderPath, describeFolder,
  listFolders, createFolder, renameFolder, deleteFolder, assignSkeleton, spawnRig,
  saveClip, animateClip, sequenceClips, saveMesh, prepareMesh, bindMesh,
  buildAssignCode, buildSpawnCode, buildCustomSaveCode, buildCustomAnimateCode, buildSaveMeshCode,
  buildPrepareMeshCode, buildBindMeshCode,
};
