'use strict';

// ─── Character library — save/spawn finished Mixamo-rigged humans ─────────────
//
// The Human tab's counterpart to the custom-rig folders, and DELIBERATELY much smaller.
// A custom-rig folder exists because the skeleton is a VARIABLE (deer != monster), so each
// folder binds its own skeleton and carries its own clips. Here the skeleton is a CONSTANT:
// anything animatable in the Human tab wears the standard mixamorig: skeleton, whether it
// came from MPFB (rig:"mixamo") or from a character the user auto-rigged at Mixamo. The
// retarget matches bones BY NAME (animate_human.js), so every clip in animations/ already
// fits every character here.
//
// Therefore: NO per-character clips, NO signature binding, NO folders — a character is just
// a saved "skin". One flat .blend per character, and the shared animations/ library stays
// shared. Anything that is NOT mixamorig-rigged is refused here and belongs in the
// Custom-Rig tab instead; that check is the routing, so the user never has to pick a tab.
//
// Layout:
//   characters/<name>.blend       rig + every bound mesh, rest pose, textures PACKED
//   characters/<name>.sig.json    { bones, boneCount, meshCount, rigObject, created }

const path = require('path');
const fs = require('fs');
const { callBlender } = require('./blender-ipc');

const CHAR_DIR = path.join(__dirname, 'characters');

// The one bone that defines "this is the standard humanoid skeleton" — the same test
// animate_human.js uses to find its target. Keeping it identical is the point: a character
// that passes here is animatable there.
const MIXAMO_ROOT = 'mixamorig:Hips';

function ensureDir() {
  try { fs.mkdirSync(CHAR_DIR, { recursive: true }); } catch (_) { /* ignore */ }
  return CHAR_DIR;
}

// character name -> safe .blend basename (single segment, no traversal)
function safeCharName(s) {
  const cleaned = String(s || '').trim().replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 60).trim();
  return cleaned || '';
}

// Absolute path of a character's .blend, containment-checked against CHAR_DIR.
function charPath(name) {
  const safe = safeCharName(name);
  if (!safe) return null;
  const abs = path.resolve(CHAR_DIR, safe + '.blend');
  if (path.dirname(abs) !== path.resolve(CHAR_DIR)) return null;   // no escape
  return abs;
}

function sidecarPath(blendAbs) {
  return blendAbs.replace(/\.blend$/i, '.sig.json');
}

function readSidecar(blendAbs) {
  try { return JSON.parse(fs.readFileSync(sidecarPath(blendAbs), 'utf8')); }
  catch (_) { return null; }
}

function describeCharacter(name) {
  const abs = charPath(name);
  if (!abs || !fs.existsSync(abs)) return null;
  const sc = readSidecar(abs) || {};
  let bytes = 0;
  try { bytes = fs.statSync(abs).size; } catch (_) { /* ignore */ }
  return {
    name: safeCharName(name),
    boneCount: Number(sc.boneCount) || 0,
    meshCount: Number(sc.meshCount) || 0,
    rigObject: sc.rigObject || null,
    created: sc.created || null,
    bytes,
  };
}

function listCharacters() {
  ensureDir();
  let names = [];
  try {
    names = fs.readdirSync(CHAR_DIR)
      .filter(f => /\.blend$/i.test(f))
      .map(f => f.replace(/\.blend$/i, ''))
      .sort((a, b) => a.localeCompare(b));
  } catch (_) { /* ignore */ }
  return names.map(describeCharacter).filter(Boolean);
}

// Rename = rename the .blend + its sidecar. The .blend is self-contained (packed) and the
// sidecar holds no path, so a plain file rename is safe — same reasoning as custom-rig folders.
function renameCharacter(from, to) {
  const src = charPath(from);
  const dst = charPath(to);
  if (!src) return { error: 'invalid current name.' };
  if (!dst) return { error: 'invalid new name.' };
  if (!fs.existsSync(src)) return { error: 'character does not exist.' };
  if (path.resolve(src) === path.resolve(dst)) return { character: describeCharacter(to) };
  if (fs.existsSync(dst)) return { error: 'a character with the new name already exists.' };
  try {
    fs.renameSync(src, dst);
    if (fs.existsSync(sidecarPath(src))) fs.renameSync(sidecarPath(src), sidecarPath(dst));
  } catch (e) { return { error: e.message }; }
  return { character: describeCharacter(to) };
}

function deleteCharacter(name) {
  const abs = charPath(name);
  if (!abs) return { error: 'invalid name.' };
  if (!fs.existsSync(abs)) return { error: 'character does not exist.' };
  try {
    fs.unlinkSync(abs);
    if (fs.existsSync(sidecarPath(abs))) fs.unlinkSync(sidecarPath(abs));
  } catch (e) { return { error: e.message }; }
  return { ok: true };
}

// ─── Save the character in the scene as a spawnable .blend ────────────────────
//
// Same shape as custom_rig's buildSaveMeshCode (pack_all -> duplicate -> strip animation ->
// write -> delete the duplicates), for the same three reasons that were learned the hard way:
//   * pack_all BEFORE libraries.write, or the texture is gone on the next open;
//   * write DUPLICATES, so the live rig and whatever animation is on it are never touched;
//   * a template must arrive in REST POSE, not carrying the pose it happened to be in.
// The difference is the picker: this one insists on the mixamorig: skeleton, so a creature
// rig is refused BEFORE anything is written (no file to clean up afterwards).
function buildSaveCharacterCode(outAbs) {
  const OUT = outAbs.replace(/\\/g, '/');
  return [
    'import bpy, os',
    `OUT = ${JSON.stringify(OUT)}`,
    `ROOTBONE = ${JSON.stringify(MIXAMO_ROOT)}`,
    'def _is_mixamo_arm(o):',
    '    return o.type == "ARMATURE" and any(b.name == ROOTBONE for b in o.data.bones)',
    'def _rootof(o):',
    '    while o.parent is not None: o = o.parent',
    '    return o',
    '_arms = [o for o in bpy.data.objects if _is_mixamo_arm(o)]',
    '_arm = None',
    // Prefer what the user is pointing at: the active object, or the armature a selected mesh
    // hangs off. Fall back to the only/first mixamo rig in the scene.
    '_act = bpy.context.view_layer.objects.active',
    'if _act is not None:',
    '    _r = _rootof(_act)',
    '    if _is_mixamo_arm(_r): _arm = _r',
    'if _arm is None and _act is not None and _act.type == "MESH":',
    '    for _md in _act.modifiers:',
    '        if _md.type == "ARMATURE" and _md.object is not None and _is_mixamo_arm(_md.object):',
    '            _arm = _md.object; break',
    // The Human tab builds previews HIDDEN (make_human staged: an "MH Staged" collection kept
    // out of the viewport until Place). With nothing selected, a bare _arms[0] could grab that
    // hidden preview instead of the figure the user is looking at — so visible rigs win.
    'def _visible(o):',
    '    try: return o.visible_get()',
    '    except Exception: return False',
    'if _arm is None:',
    '    _vis = [o for o in _arms if _visible(o)]',
    '    if _vis: _arm = _vis[0]',
    'if _arm is None and _arms: _arm = _arms[0]',
    'if _arm is None:',
    // The routing message: this is what tells the user the character belongs in the other tab.
    '    _any = [o for o in bpy.data.objects if o.type == "ARMATURE"]',
    '    if _any:',
    '        print("CHAR_ERR:the armature in the scene is not a Mixamo skeleton (no ' + MIXAMO_ROOT + ' bone). ' +
      'Rig it at mixamo.com, or use the Custom-Rig tab for creature rigs.")',
    '    else:',
    '        print("CHAR_ERR:no rigged character in the scene — build one with Rig = Mixamo, or import a Mixamo-rigged character.")',
    'else:',
    // Every mesh bound to the rig: body + eyes + teeth + hair + clothes are separate objects.
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
    '    os.makedirs(os.path.dirname(OUT), exist_ok=True)',
    '    try: bpy.ops.file.pack_all()',
    '    except Exception as _pe: print("CHAR_PACKWARN:" + repr(_pe))',
    '    _sig = sorted(b.name for b in _arm.data.bones)',
    '    _nmesh = len(_meshes)',
    '    try: bpy.ops.object.mode_set(mode="OBJECT")',
    '    except Exception: pass',
    '    bpy.ops.object.select_all(action="DESELECT")',
    '    for _o in _meshes: _o.select_set(True)',
    '    _arm.select_set(True); bpy.context.view_layer.objects.active = _arm',
    // Namensvergleich statt Selektion: "loesche, was selektiert ist" wuerde im Fall,
    // dass duplicate() nichts erzeugt, die ORIGINALE des Users treffen. Ueber die
    // Differenz vorher/nachher kann nur Neues geloescht werden.
    '    _before = set(o.name for o in bpy.data.objects)',
    '    bpy.ops.object.duplicate()',
    '    _dups = [o for o in bpy.data.objects if o.name not in _before]',
    '    if not _dups:',
    '        raise RuntimeError("duplicate() created nothing - aborting before touching the originals")',
    // try/finally, not a straight line: if libraries.write raises (full disk, bad path, denied
    // permission) the cleanup below would never run and the DUPLICATES stay in the user's scene
    // as Human.rig.001 + mesh copies — a failed save that silently litters the file it was
    // protecting. The copies must go whether the write succeeded or not.
    '    try:',
    '        _darm = next((o for o in _dups if o.type == "ARMATURE"), None)',
    '        if _darm is not None:',
    '            if _darm.animation_data:',
    '                _darm.animation_data_clear()',
    '            for _pb in _darm.pose.bones:',
    '                _pb.location = (0, 0, 0); _pb.rotation_quaternion = (1, 0, 0, 0)',
    '                _pb.rotation_euler = (0, 0, 0); _pb.scale = (1, 1, 1)',
    '        bpy.data.libraries.write(OUT, set(_dups), fake_user=True)',
    '        _size = os.path.getsize(OUT) if os.path.exists(OUT) else -1',
    '    finally:',
    '        for _o in _dups:',
    '            try: bpy.data.objects.remove(_o, do_unlink=True)',
    '            except Exception: pass',
    '    print("CHAR_DONE:meshes=" + str(_nmesh) + ":arm=" + _arm.name +',
    '          ":bones=" + str(len(_sig)) + ":bytes=" + str(_size))',
    '    print("CHAR_SIG:" + ",".join(_sig))',
  ].join('\n');
}

// Append every object from the character's .blend, then leave its ARMATURE selected+active.
// That last step is the actual QoL: animate_human picks the active object's armature as its
// target, so spawn -> Animate / Describe a motion works without hunting in the outliner.
function buildSpawnCharacterCode(blendAbs) {
  const SRC = blendAbs.replace(/\\/g, '/');
  return [
    'import bpy',
    `SRC = ${JSON.stringify(SRC)}`,
    'with bpy.data.libraries.load(SRC, link=False) as (_from, _to):',
    '    _to.objects = list(_from.objects)',
    '_n = 0',
    '_new = []',
    'for _o in _to.objects:',
    '    if _o is not None:',
    '        bpy.context.collection.objects.link(_o); _new.append(_o); _n += 1',
    'try: bpy.ops.object.mode_set(mode="OBJECT")',
    'except Exception: pass',
    '_arm = next((o for o in _new if o.type == "ARMATURE"), None)',
    'if _arm is not None:',
    '    try:',
    '        bpy.ops.object.select_all(action="DESELECT")',
    '        _arm.select_set(True); bpy.context.view_layer.objects.active = _arm',
    '    except Exception: pass',
    'print("CHAR_SPAWN:objects=" + str(_n) + ":arm=" + (_arm.name if _arm is not None else "-"))',
  ].join('\n');
}

async function saveCharacter(input = {}, cfg) {
  ensureDir();
  const safe = safeCharName(input && input.name);
  if (!safe) return 'ERROR: give the character a name.';
  const outAbs = charPath(safe);
  if (!outAbs) return 'ERROR: invalid character name.';
  if (fs.existsSync(outAbs) && !input.overwrite) {
    return `ERROR: a character named "${safe}" already exists — pick another name (or delete it first).`;
  }
  // Write to a temp .blend and only rename over the real character once the save is verified good.
  // overwrite:true used to write straight onto outAbs, so a crash mid-write (disk full, Blender
  // dying) destroyed the existing character; the temp keeps the old file intact until the last step.
  const tmpAbs = outAbs + '.tmp-' + process.pid;
  const _cleanTmp = () => { try { fs.unlinkSync(tmpAbs); } catch (_) { /* ignore */ } };
  let r;
  try {
    // A full MPFB human with clothes/hair is heavy to pack + write; give it the same headroom
    // as the custom-rig mesh save (a 70-bone creature took ~2 min on a busy scene).
    r = await callBlender(buildSaveCharacterCode(tmpAbs), { cfg, timeoutMs: 180000 });
  } catch (e) { _cleanTmp(); return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') { _cleanTmp(); return 'ERROR: ' + (r.message || out); }
  const err = out.split('\n').find(l => l.startsWith('CHAR_ERR:'));
  if (err) { _cleanTmp(); return 'ERROR: ' + err.slice('CHAR_ERR:'.length); }
  const m = out.match(/CHAR_DONE:meshes=(\d+):arm=(.+?):bones=(\d+):bytes=(-?\d+)/);
  if (!m) { _cleanTmp(); return out || 'Save character failed.'; }
  const sigLine = out.split('\n').find(l => l.startsWith('CHAR_SIG:'));
  const bones = sigLine ? sigLine.slice('CHAR_SIG:'.length).split(',').filter(Boolean) : [];
  // Belt and braces: Python already refused a non-Mixamo rig, so this only fires if the marker
  // parsing ever drifts. Cheap, and it keeps a broken character out of the library.
  if (!bones.includes(MIXAMO_ROOT)) {
    _cleanTmp();
    return `ERROR: that skeleton has no ${MIXAMO_ROOT} bone — it can't be animated in the Human tab. ` +
           'Use the Custom-Rig tab for non-Mixamo rigs.';
  }
  // Commit: atomically replace the (possibly existing) character only now that it is verified good.
  try { fs.renameSync(tmpAbs, outAbs); }
  catch (e) { _cleanTmp(); return 'ERROR: character built but could not be finalized — ' + e.message; }
  try {
    fs.writeFileSync(sidecarPath(outAbs), JSON.stringify({
      bones, boneCount: bones.length, meshCount: Number(m[1]), rigObject: m[2],
      source: 'mixamo', created: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (e) {
    return 'ERROR: character saved but its info file could not be written — ' + e.message;
  }
  const nMesh = Number(m[1]);
  const bytesMb = m[4] > 0 ? ` (${(Number(m[4]) / 1048576).toFixed(1)} MB)` : '';
  return `Saved character "${safe}" — ${nMesh} mesh${nMesh === 1 ? '' : 'es'} on "${m[2]}", ` +
         `${m[3]} bones${bytesMb}. Pick it in the Character dropdown to spawn it; ` +
         'every clip in the animation list works on it.';
}

async function spawnCharacter(input = {}, cfg) {
  const abs = charPath(input && input.name);
  if (!abs) return 'ERROR: invalid character name.';
  if (!fs.existsSync(abs)) return 'ERROR: no saved character with that name.';
  let r;
  try {
    r = await callBlender(buildSpawnCharacterCode(abs), { cfg, timeoutMs: 120000 });
  } catch (e) { return 'ERROR: ' + e.message; }
  const out = (r.stdout || r.output || '').trim();
  if (r.status === 'error') return 'ERROR: ' + (r.message || out);
  const m = out.match(/CHAR_SPAWN:objects=(\d+):arm=(.+)/);
  if (!m) return out || 'Spawn failed.';
  const armed = m[2] && m[2] !== '-';
  return `Spawned "${safeCharName(input.name)}" — ${m[1]} object(s) in the scene.` +
         (armed ? ` Its rig ("${m[2]}") is selected, so Animate hits it straight away.` : '');
}

module.exports = {
  CHAR_DIR, MIXAMO_ROOT, ensureDir, safeCharName, charPath, describeCharacter,
  listCharacters, renameCharacter, deleteCharacter, saveCharacter, spawnCharacter,
  buildSaveCharacterCode, buildSpawnCharacterCode,
};
