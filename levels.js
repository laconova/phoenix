'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const LAYERS = ['_greybox', '_movable', '_detail'];
const STAGES = { blockout: ['_greybox'], movable: ['_greybox', '_movable'], detail: ['_movable', '_detail'] };
const STAGE_LABELS = { blockout: 'Blockout', movable: 'Movable', detail: 'Detail' };
const excludeMap = stage => Object.hasOwn(STAGES, stage) ? Object.fromEntries(LAYERS.map(n => [n, !STAGES[stage].includes(n)])) : null;
const slugify = name => String(name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 64);
const slugOk = s => typeof s === 'string' && /^[a-z0-9_-]{1,64}$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s);
const renderStageLine = s => ['blockout', 'movable'].includes(s) ? `Rendered at stage ${STAGE_LABELS[s]} — switch to Detail for the final look.` : '';
const root = cfg => path.resolve(__dirname, process.env.PHOENIX_LEVELS_DIR || cfg && cfg.paths && cfg.paths.levels || path.join(__dirname, 'levels'));
const guarded = (cfg, rel, create) => require('./library-trash').guarded(root(cfg), rel, create);
const isFile = p => { try { return fs.lstatSync(p).isFile(); } catch (_) { return false; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return {}; } };
function atomic(p, data) { const tmp = require('./library-trash').guarded(path.dirname(p), path.basename(p) + '.tmp'); fs.writeFileSync(tmp, data, {flag:'w'}); try { fs.renameSync(tmp, p); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } }
// F2.8: like touch() but meta.edited stays: a poster render is not an edit of the level
function posterTouch(slug, cfg, extra) { const p = guarded(cfg, slug + '/meta.json'); const m = readJson(p); if (extra) Object.assign(m, extra); atomic(p, JSON.stringify(m, null, 2)); }
function touch(slug, cfg, extra) { const p = guarded(cfg, slug + '/meta.json'); const m = readJson(p); m.edited = new Date().toISOString(); if (extra) Object.assign(m, extra); atomic(p, JSON.stringify(m, null, 2)); }
function list(cfg) {
  const out = []; let names; try { names = fs.readdirSync(guarded(cfg, '')); } catch (_) { return out; }
  for (const slug of names.filter(slugOk)) try {
    const dir = guarded(cfg, slug); if (!fs.lstatSync(dir).isDirectory()) continue;
    const broken = isFile(guarded(cfg, slug + '/level.blend')) ? null : 'level.blend is missing';
    const meta = readJson(guarded(cfg, slug + '/meta.json')); let posterStamp = null;
    try { const st = fs.statSync(guarded(cfg, slug + '/poster.jpg')); posterStamp = st.size + '-' + st.mtimeMs; } catch (_) {}
    const scenes = []; try { for (const n of fs.readdirSync(guarded(cfg, slug + '/scenes'))) { const s = n.replace(/\.blend$/, ''); if (!n.endsWith('.blend') || !slugOk(s)) continue; const p = guarded(cfg, slug + '/scenes/' + n); if (fs.lstatSync(p).isFile()) scenes.push({ name: s, broken: broken ? 'Its level file is missing (level.blend)' : null }); } } catch (_) {}
    out.push({ slug, name: meta.name || slug, created: meta.created || null, edited: meta.edited || null, posterStamp, posterUpdating: posterBusy(slug) || posterPending(slug), broken, scenes: scenes.sort((a,b) => a.name.localeCompare(b.name)) });
  } catch (_) {}
  return out.sort((a,b) => a.name.localeCompare(b.name));
}
const pyBase = `import bpy, json, os
scene = bpy.context.scene
layers = ['_greybox', '_movable', '_detail']
stages = {'blockout': ['_greybox'], 'movable': ['_greybox', '_movable'], 'detail': ['_movable', '_detail']}
def find_layer(lc, name):
    if lc.name == name: return lc
    for child in lc.children:
        found = find_layer(child, name)
        if found is not None: return found
    return None
def apply_stage(stage):
    found = [find_layer(bpy.context.view_layer.layer_collection, n) for n in layers]
    if any(x is None for x in found): return False
    for n, lc in zip(layers, found): lc.exclude = n not in stages[stage]
    scene['phoenix_stage'] = stage
    return True
def movable_override():
    return next((c for c in scene.collection.children if c.name == '_movable' and c.library is None and c.override_library is not None), None)
def norm_path(p):
    return os.path.normcase(os.path.abspath(p)).replace(chr(92), '/')
def wrong_file(expected):
    fp = bpy.data.filepath
    if expected is None or (fp and norm_path(fp) == norm_path(expected)): return None
    return 'Blender has another file open (' + (os.path.basename(fp) if fp else 'an unsaved file') + ') — not saved.'
def save_verdict(expected=None):
    fp = bpy.data.filepath
    def sig():
        try:
            st = os.stat(fp)
            return (st.st_mtime_ns, st.st_size)
        except OSError:
            return None
    before = sig() if fp else None
    r = bpy.ops.wm.save_mainfile()
    after = sig() if fp else None
    ok = 'FINISHED' in r and bool(fp) and bpy.data.filepath == fp and (expected is None or norm_path(bpy.data.filepath) == norm_path(expected)) and after is not None and (before is None or before != after)
    if ok: bpy.app.driver_namespace.pop('phoenix_modified', None)
    return ok
def keyed_channels():
    out = {'location': [], 'scale': []}
    movable = movable_override()
    if movable is None or not scene.get('phoenix_scene'): return out
    from bpy_extras import anim_utils
    for ob in movable.all_objects:
        ad = ob.animation_data
        if ad and ad.action and ad.action.library is None and ad.action_slot:
            bag = anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)
            if bag:
                paths = set(fc.data_path for fc in bag.fcurves)
                for key in out:
                    if key in paths: out[key].append(ob.name)
    return {key: sorted(names) for key, names in out.items()}
unmapped = []
def convert_movable():
    if not scene.get('phoenix_scene') or movable_override() is not None: return False
    linked = next((c for c in scene.collection.children if c.name == '_movable' and c.library is not None), None)
    if linked is None: return False
    override = linked.override_hierarchy_create(scene, bpy.context.view_layer, do_fully_editable=True)
    scene.collection.children.unlink(linked)
    remap = {o.override_library.reference: o for o in override.all_objects if o.override_library is not None}
    users = bpy.data.user_map(subset=list(remap))
    def local(u): return u.library is None and u.override_library is None
    def pointers(st):
        for p in st.bl_rna.properties:
            if p.type == 'POINTER' and p.fixed_type.identifier == 'Object' and not p.is_readonly:
                value = getattr(st, p.identifier)
                if value in remap: setattr(st, p.identifier, remap[value])
    for u in {u for group in users.values() for u in group if local(u)}:
        if isinstance(u, bpy.types.Object):
            if u.parent in remap: u.parent = remap[u.parent]
            for mod in u.modifiers:
                pointers(mod)
                if mod.type == 'NODES':
                    for k in mod.keys():
                        value = mod[k]
                        if isinstance(value, bpy.types.Object) and value in remap: mod[k] = remap[value]
            for constraint in u.constraints:
                pointers(constraint)
                for target in getattr(constraint, 'targets', []): pointers(target)
        if isinstance(u, bpy.types.Camera):
            if u.dof.focus_object in remap: u.dof.focus_object = remap[u.dof.focus_object]
        ad = getattr(u, 'animation_data', None)
        if ad:
            for curve in ad.drivers:
                for variable in curve.driver.variables:
                    for target in variable.targets:
                        if target.id in remap: target.id = remap[target.id]
    unmapped.extend(sorted(({'user': u.name, 'object': ob.name} for ob, group in bpy.data.user_map(subset=list(remap)).items() for u in group if local(u)), key=lambda e: (e['user'], e['object'])))
    stage = scene.get('phoenix_stage')
    apply_stage(stage if stage in stages else 'blockout')
    bpy.app.driver_namespace['phoenix_modified'] = True
    try:
        windows = bpy.context.window_manager.windows
        if windows:
            w = windows[0]
            with bpy.context.temp_override(window=w, screen=w.screen):
                bpy.ops.ed.undo_push(message='Phoenix: movable per scene')
    except Exception:
        pass
    return True
def orphan_actions():
    if not scene.get('phoenix_scene'): return []
    tagged = [a for a in bpy.data.actions if a.library is None and a.get('phoenix_orphan') == scene['phoenix_scene']]
    used = {a for a, users in bpy.data.user_map(subset=tagged).items() if any(u is not a and u.library is None for u in users)}
    kept = bpy.app.driver_namespace.get('phoenix_orphan_kept', [])
    return sorted((a for a in bpy.data.actions if a.library is None and a.get('phoenix_orphan') == scene['phoenix_scene'] and a not in used and a.name not in kept), key=lambda a: a.name)
def state():
    level = scene.get('phoenix_level')
    sc = scene.get('phoenix_scene')
    kind = 'level' if level else ('scene' if sc else None)
    parts = sc.split('/', 1) if sc else []
    stage = scene.get('phoenix_stage')
    movable = movable_override() if kind == 'scene' else None
    orphans = [{'name': a.name, 'slot': a.slots[0].identifier if a.slots else None, 'slots': [slot.identifier for slot in a.slots], 'reattachable': any(slot.identifier.startswith('OB') for slot in a.slots)} for a in orphan_actions()] if kind == 'scene' else []
    level_anims, linked_anims = [], []
    if kind == 'level':
        col = next((c for c in scene.collection.children if c.name == '_movable'), None)
        level_anims = [o.name for o in col.all_objects if o.animation_data and o.animation_data.action] if col else []
    if movable:
        linked_anims = [o.name for o in movable.all_objects if o.animation_data and o.animation_data.action and o.animation_data.action.library is not None]
    targets = sorted(o.name for o in movable.all_objects if not o.animation_data or not o.animation_data.action) if movable else []
    return {'levelMovableAnims': sorted(level_anims), 'linkedMovableAnims': sorted(linked_anims), 'orphanAnims': orphans, 'reattachTargets': targets, 'openAborted': bpy.app.driver_namespace.get('phoenix_open_aborted'), 'filepath': bpy.data.filepath, 'dirty': bool(bpy.data.is_dirty or bpy.app.driver_namespace.get('phoenix_modified')), 'kind': kind, 'slug': level if level else (parts[0] if parts else None), 'scene': parts[1] if len(parts) > 1 else None, 'stage': stage if kind and stage in stages else None}
`;
const clearPy = `for ob in list(bpy.data.objects): bpy.data.objects.remove(ob, do_unlink=True)
for col in list(bpy.data.collections): bpy.data.collections.remove(col)
`;
function newLevelPython({slug, out}) { return pyBase + clearPy + `for n in layers: scene.collection.children.link(bpy.data.collections.new(n))
scene['phoenix_level'] = ${JSON.stringify(slug)}
apply_stage('blockout')
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(out)})
`; }
function newScenePython({slug, scene: name, levelFile, out}) { return pyBase + clearPy + `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(out)})
with bpy.data.libraries.load(${JSON.stringify(levelFile)}, link=True, relative=True) as (data_from, data_to):
    data_to.collections = list(layers)
for col in data_to.collections:
    if col is not None: scene.collection.children.link(col)
linked = next((c for c in scene.collection.children if c.name == '_movable' and c.library is not None), None)
if linked is None: raise RuntimeError('The level has no _movable collection — open the level and add it (Phoenix levels have _greybox, _movable and _detail).')
linked.override_hierarchy_create(scene, bpy.context.view_layer, do_fully_editable=True)
scene.collection.children.unlink(linked)
local = bpy.data.collections.new('_scene')
scene.collection.children.link(local)
camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
local.objects.link(camera)
scene.camera = camera
scene['phoenix_scene'] = ${JSON.stringify(slug + '/' + name)}
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(out)})
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(out)})
scene = bpy.context.scene
if not apply_stage('blockout'): raise RuntimeError('A level layer is missing.')
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(out)})
`; }
function readOpenPython() { return pyBase + `print('PHX_LEVEL:' + json.dumps(state()))\n`; }
function stagePython(stage) { return pyBase + `try:
    converted = convert_movable()
    stage = ${JSON.stringify(stage)}
    if not state()['kind'] or stage not in stages:
        print('PHX_LEVEL:' + json.dumps({'error': 'No Phoenix level or scene is open in Blender.'}))
    elif not apply_stage(stage):
        print('PHX_LEVEL:' + json.dumps({'error': 'A level layer is missing.'}))
    else:
        result = state()
        if converted: result.update({'converted': True, 'unmapped': unmapped})
        print('PHX_LEVEL:' + json.dumps(result))
except Exception as e:
    print('PHX_LEVEL:' + json.dumps({'error': "This scene's movable layer could not be made per scene: " + str(e)}))
`; }
function openPython(file, {save = false, discard, expected} = {}) { const exp = expected == null ? 'None' : JSON.stringify(expected); return pyBase + require('./blender-ipc').HANDLERS_PY + `def phoenix_open():
    if not ${discard ? 'True' : 'False'} and state()['dirty']:
        bpy.app.driver_namespace['phoenix_open_aborted'] = ${JSON.stringify(file)}
        return None
    bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(file)}, load_ui=False)
    return None
try:
    ready = True
    bad = None
${save ? "    bad = wrong_file(" + exp + ")\n    ready = False if bad else save_verdict(" + exp + ")\n" : ''}    if ready:
        bpy.app.driver_namespace.pop('phoenix_open_aborted', None)
        bpy.app.timers.register(phoenix_open, first_interval=0.2)
        print('PHX_OPEN:' + json.dumps({'ok': True}))
    else:
        print('PHX_OPEN:' + json.dumps({'ok': False, 'error': bad or 'Blender did not write the file — it is not saved.'}))
except Exception as e:
    print('PHX_OPEN:' + json.dumps({'ok': False, 'error': str(e)}))
`; }
function savePython(expected) { return pyBase + `try:
    expected = ${expected == null ? 'None' : JSON.stringify(expected)}
    bad = wrong_file(expected)
    if bad:
        print('PHX_LEVEL:' + json.dumps({'error': bad}))
    elif not save_verdict(expected):
        print('PHX_LEVEL:' + json.dumps({'error': 'Blender did not write the file — it is not saved.'}))
    else:
        result = state()
        result['dirty'] = False
        if result['kind'] == 'scene':
            k = keyed_channels()
            result['keyedLocation'] = k['location']
            result['keyedScale'] = k['scale']
        print('PHX_LEVEL:' + json.dumps(result))
except Exception as e:
    print('PHX_LEVEL:' + json.dumps({'error': str(e)}))
`; }
function convertPython() { return pyBase + `try:
    converted = convert_movable()
    print('PHX_CONVERT:' + json.dumps({'converted': converted, 'open': state(), 'unmapped': unmapped, 'keyed': keyed_channels()}))
except Exception as e:
    print('PHX_CONVERT:' + json.dumps({'error': str(e)}))
`; }
function orphanPython({choice, action, object}) { return pyBase + require('./blender-ipc').HANDLERS_PY + `try:
    name = ${JSON.stringify(action)}
    choice = ${JSON.stringify(choice)}
    target = ${JSON.stringify(object || null) === 'null' ? 'None' : JSON.stringify(object)}
    entries = orphan_actions()
    act = bpy.data.actions.get(name)
    if act is None or act not in entries: raise RuntimeError('That animation is no longer waiting.')
    if choice == 'reattach':
        if not any(slot.identifier.startswith('OB') for slot in act.slots): raise RuntimeError('This is not an object animation; keep it for later or delete it.')
        movable = movable_override()
        ob = next((o for o in movable.all_objects if o.name == target), None) if movable else None
        if ob is None or (ob.animation_data and ob.animation_data.action): raise RuntimeError('Choose a movable object without animation.')
        ad = ob.animation_data or ob.animation_data_create()
        ad.action = act
        if ad.action_slot is None: ad.action_slot = ad.action_suitable_slots[0]
        if ob.override_library and ob.override_library.is_system_override: ob.override_library.is_system_override = False
        act.use_fake_user = False
    elif choice == 'delete':
        act.use_fake_user = False
    elif choice != 'keep':
        raise RuntimeError('Unknown animation choice.')
    if choice == 'keep':
        bpy.app.driver_namespace.setdefault('phoenix_orphan_kept', []).append(name)
    else:
        for key in ('phoenix_orphan', 'phoenix_orphan_object'):
            if key in act: del act[key]
    print('PHX_ORPHAN:' + json.dumps({'ok': True, 'open': state()}))
except Exception as e:
    print('PHX_ORPHAN:' + json.dumps({'ok': False, 'error': str(e)}))
`; }
const CONVERT_NOTE = "This scene's movable layer is now per scene — save to keep it.";
function unmappedLines(list) { return list.slice(0,3).map(e => e.user + " still uses the level's " + e.object + " — pick the scene's " + e.object + " there.").concat(list.length > 3 ? ['+' + (list.length - 3) + ' more'] : []); }
function positionHints(names) { return names.slice(0,3).map(n => n + ": position is keyed in this scene — moving it in the level won't show here. Key rotation only, or animate it through a parent empty.").concat(names.length > 3 ? ['+' + (names.length - 3) + ' more'] : []); }
function keyHints({location = [], scale = []} = {}) {
  const names = [...new Set([...location, ...scale])].sort(), loc = new Set(location), sc = new Set(scale);
  const line = n => loc.has(n) && sc.has(n) ? n + ": position and size are keyed in this scene — moving or resizing it in the level won't show here. To fix: Preferences › Animation › Default Key Channels › Location and Scale off (key rotation only), then Clear Keyframes on it and key again."
    : sc.has(n) ? n + ": size is keyed in this scene — size changes in the level won't show here. To fix: Preferences › Animation › Default Key Channels › Scale off, then Clear Keyframes on it and key again."
    : positionHints([n])[0];
  return names.slice(0,3).map(line).concat(names.length > 3 ? ['+' + (names.length - 3) + ' more'] : []);
}
const ROUTE_RESTORE = `ns = bpy.app.driver_namespace
active_name = ns.pop('phoenix_route_active', None)
ns.pop('phoenix_route', None)
vl = bpy.context.view_layer
lc = find_layer(vl.layer_collection, active_name) if active_name else None
if lc is not None and lc.collection.library is None and not lc.exclude:
    vl.active_layer_collection = lc
else:
    tl = find_layer(vl.layer_collection, target) if target else None
    if tl is not None and not tl.exclude: vl.active_layer_collection = tl
`;
function routeBeforePython() { return pyBase + `kind = state()['kind']
target = '_detail' if kind == 'level' else ('_scene' if kind == 'scene' else None)
vl = bpy.context.view_layer
previous = vl.active_layer_collection.name
bpy.app.driver_namespace['phoenix_route'] = set(o.name for o in bpy.data.objects if o.library is None)
bpy.app.driver_namespace['phoenix_route_active'] = previous
if target:
    lc = find_layer(vl.layer_collection, target)
    if lc is None or lc.exclude or lc.collection.library is not None: lc = vl.layer_collection
    vl.active_layer_collection = lc
print('PHX_ROUTE:' + json.dumps({'kind': kind, 'active': vl.active_layer_collection.name, 'previous': previous}))
`; }
function routeAfterPython() { return pyBase + `kind = state()['kind']
target = '_detail' if kind == 'level' else ('_scene' if kind == 'scene' else None)
old = bpy.app.driver_namespace.get('phoenix_route', set())
moved = 0
col = next((c for c in scene.collection.children if c.name == target and c.library is None), None) if target else None
if col is not None:
    reachable = set(scene.collection.all_objects)
    for ob in list(bpy.data.objects):
        if ob.library is None and ob.name not in old and ob in reachable:
            if list(ob.users_collection) == [col]: continue
            if col not in list(ob.users_collection): col.objects.link(ob)
            for owner in list(ob.users_collection):
                if owner != col: owner.objects.unlink(ob)
            moved += 1
    if moved > 0:
        if kind == 'level': apply_stage('detail')
` + ROUTE_RESTORE + `print('PHX_ROUTE:' + json.dumps({'kind': kind, 'moved': moved, 'target': target, 'active': bpy.context.view_layer.active_layer_collection.name}))
`; }
function routeRestorePython() { return pyBase + `kind = state()['kind']
target = '_detail' if kind == 'level' else ('_scene' if kind == 'scene' else None)
` + ROUTE_RESTORE + `print('PHX_ROUTE:' + json.dumps({'active': bpy.context.view_layer.active_layer_collection.name}))
`; }
function posterPython({out}) { return pyBase + `from mathutils import Vector
detail = bpy.data.collections.get('_detail')
stage = 'detail' if detail is not None and len(detail.all_objects) else 'blockout'
apply_stage(stage)
camera = bpy.data.objects.new('Phoenix Poster Camera', bpy.data.cameras.new('Phoenix Poster Camera'))
scene.collection.objects.link(camera)
scene.camera = camera
camera.rotation_euler = (1.1, 0.0, 0.785)
coords = []
for n in stages[stage]:
    col = bpy.data.collections.get(n)
    if col is not None:
        for ob in col.all_objects:
            if ob.type != 'CAMERA':
                for corner in ob.bound_box: coords.extend(ob.matrix_world @ Vector(corner))
if coords: camera.location = camera.camera_fit_coords(bpy.context.evaluated_depsgraph_get(), coords)[0]
else: camera.location = (0, 0, 10)
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x = 256
scene.render.resolution_y = 256
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'JPEG'
scene.render.filepath = ${JSON.stringify(out)}
bpy.ops.render.render(write_still=True)
print('PHX_POSTER:' + json.dumps({'stage': stage}))
`; }
const defaultRun = (exe, args, {timeoutMs}) => new Promise((resolve, reject) => {
  const child = cp.spawn(exe, args, {windowsHide:true}); let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  child.on('error', e => { clearTimeout(timer); reject(e); }); child.on('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
});
// true = a process of the configured Blender image runs, false = none, null = could not tell. Never throws, no shell string.
function defaultBlenderRunning(cfg) {
  return new Promise(resolve => {
    try {
      const image = path.basename((cfg && cfg.apps && cfg.apps.blender) || '') || 'blender.exe';
      if (process.platform === 'win32') {
        cp.execFile('tasklist', ['/FI', 'IMAGENAME eq ' + image, '/NH', '/FO', 'CSV'], {windowsHide: true, timeout: 5000}, (err, stdout) => {
          if (err) return resolve(null);
          resolve(String(stdout || '').split(/\r?\n/).some(line => { const m = /^\s*"([^"]*)"/.exec(line); return !!m && m[1].toLowerCase() === image.toLowerCase(); }));
        });
      } else {
        cp.execFile('pgrep', ['-x', image.replace(/\.exe$/i, '')], {timeout: 5000}, err => resolve(!err ? true : (err.code === 1 ? false : null)));
      }
    } catch (_) { resolve(null); }
  });
}
async function blenderRunning(cfg) { try { const v = await (deps.blenderRunning || defaultBlenderRunning)(cfg); return v === true || v === false ? v : null; } catch (_) { return null; } }
let deps = {run: defaultRun};
function executable(cfg) { const exe = cfg && cfg.apps && cfg.apps.blender; if (!exe || !fs.existsSync(exe) || !fs.statSync(exe).isFile()) throw new Error('Set the Blender executable in Settings > Connections.'); return exe; }
async function headless(exe, code, file, timeoutMs = 120000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-level-')), script = path.join(dir, 'level.py');
  try { fs.writeFileSync(script, code); const r = await deps.run(exe, ['--background', ...(file ? [file] : []), '--python-exit-code', '1', '--python', script], {timeoutMs});
    if (r.code !== 0) throw new Error(String(r.stderr || r.stdout || 'Blender failed').trim().split(/\r?\n/).pop()); return r;
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
}
async function createLevel(name, {cfg} = {}) {
  const slug = slugify(name); if (!slugOk(slug)) return {ok:false, code:'NAME', error:'Enter a level name.'}; let dir, owned = false;
  try { dir = guarded(cfg, slug); if (fs.existsSync(dir)) return {ok:false, code:'EXISTS', error:'That level already exists.'}; const exe = executable(cfg);
    guarded(cfg, slug, true); owned = true; const out = guarded(cfg, slug + '/.level.tmp.blend'); await headless(exe, newLevelPython({slug,out}));
    if (!fs.existsSync(out)) throw new Error('Blender did not create level.blend'); const file = guarded(cfg, slug + '/level.blend'); fs.renameSync(out,file);
    const now = new Date().toISOString(); atomic(guarded(cfg, slug + '/meta.json'), JSON.stringify({name:String(name).trim(),created:now,edited:now},null,2)); return {ok:true,slug,file};
  } catch(e) { if (owned) fs.rmSync(dir,{recursive:true,force:true}); return {ok:false,error:e.message}; }
}
async function createScene(slug, name, {cfg} = {}) {
  const scene = slugify(name); if (!slugOk(scene) || !slugOk(slug)) return {ok:false,code:'NAME',error:'Invalid name.'}; let out;
  try { const levelFile = guarded(cfg, slug + '/level.blend'); if (!isFile(levelFile)) return {ok:false,code:'NO_LEVEL',error:'The level is missing.'};
    const file = guarded(cfg, slug + '/scenes/' + scene + '.blend'); if (fs.existsSync(file)) return {ok:false,code:'EXISTS',error:'That scene already exists.'}; const exe = executable(cfg);
    guarded(cfg, slug + '/scenes', true); out = guarded(cfg, slug + '/scenes/.' + scene + '.tmp.blend'); await headless(exe, newScenePython({slug,scene,levelFile,out}));
    if (!fs.existsSync(out)) throw new Error('Blender did not create the scene file'); fs.renameSync(out,file); return {ok:true,slug,scene,file};
  } catch(e) { return {ok:false,error:e.message}; } finally { if (out) { if (fs.existsSync(out)) fs.unlinkSync(out); const dir = path.dirname(out), prefix = path.basename(out); for (const n of fs.readdirSync(dir)) if (n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length))) fs.unlinkSync(require('./library-trash').guarded(dir,n)); } }
}
const tagged = (r, tag) => { if (!r || r.status && r.status !== 'ok') return null; for (const l of String(r.stdout || '').split(/\r?\n/)) if (l.startsWith(tag + ':')) try { return JSON.parse(l.slice(tag.length + 1)); } catch (_) {} return null; };
async function renderPosterNow(slug, {cfg} = {}) { let out; try { if (!slugOk(slug)) throw new Error('Invalid level'); const file = guarded(cfg, slug + '/level.blend'); if (!isFile(file)) throw new Error('level.blend is missing'); const exe = executable(cfg); const source = blendVersion(file);
  out = guarded(cfg, slug + '/.poster-' + require('crypto').randomUUID() + '.tmp.jpg'); const r = await headless(exe, posterPython({out}),file,300000); if (!fs.existsSync(out)) throw new Error('No poster was produced'); if (!isFile(file)) throw new Error('The level folder is gone.'); const bytes = fs.readFileSync(out); if (bytes.length < 3 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('Poster is not a JPEG'); fs.renameSync(out,guarded(cfg, slug + '/poster.jpg')); posterTouch(slug,cfg,source ? {posterSource:source} : undefined); return {ok:true,stage:(tagged(r,'PHX_POSTER') || {}).stage};
} catch(e) { return {ok:false,error:e.message}; } finally { if(out && fs.existsSync(out)) fs.unlinkSync(out); } }
const posterJobs = new Map();
function posterBusy(slug) { return posterJobs.has(slug); }
function renderPoster(slug, opts = {}) {
  const previous = posterJobs.get(slug) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => renderPosterNow(slug, opts));
  posterJobs.set(slug, job);
  return job.finally(() => { if (posterJobs.get(slug) === job) posterJobs.delete(slug); });
}
async function readOpen({cfg,background} = {}) { try { const r = tagged(await require('./blender-ipc').callBlender(readOpenPython(),{readOnly:true,cfg,timeoutMs:3000,...(background ? {background:true} : {})}),'PHX_LEVEL'); return r && !r.error ? r : null; } catch (_) { return null; } }
const norm = f => path.resolve(f).replace(/\\/g,'/').toLowerCase();
async function openFile(file, {cfg,choice,sleep = ms => new Promise(r => setTimeout(r,ms)),pollMs = 100,openTimeoutMs = 60000} = {}) {
  try { if (choice !== undefined && !['save','discard'].includes(choice)) return {ok:false,code:'NAME',error:'Choose Save and open or Open without saving.'}; const op = await readOpen({cfg}); if (!op) throw new Error('Blender is not answering.'); if (op.dirty && !choice) return {ok:false,needsChoice:true,untitled:!op.filepath}; if (choice === 'save' && !op.filepath) return {ok:false,code:'UNTITLED',error:'This scene was never saved.'};
    const result = await require('./blender-ipc').callBlender(openPython(file,{save:choice === 'save',discard:choice === 'discard',expected: op.filepath}),{readOnly:true,cfg,timeoutMs:Math.max(60000,openTimeoutMs)}); if (result && result.status === 'error') throw new Error(result.message || 'Blender could not open the file.'); const ack = tagged(result,'PHX_OPEN'); if (ack && ack.ok === false) throw new Error(ack.error); const start = Date.now();
    do { await sleep(pollMs); const open = await readOpen({cfg}); if (open && open.openAborted && norm(open.openAborted) === norm(file)) return {ok:false,code:'DIRTY_AGAIN',error:'Blender has new unsaved changes — not opened'}; if (open && open.filepath && norm(open.filepath) === norm(file)) {
      if (open.kind !== 'scene') return {ok:true,open};
      try {
        const converted = tagged(await require('./blender-ipc').callBlender(convertPython(),{readOnly:true,cfg,timeoutMs:10000}),'PHX_CONVERT');
        if (!converted || converted.error) throw new Error(converted && converted.error || 'Could not convert the movable layer.');
        const keyed = converted.keyed || {location:[],scale:[]}; return converted.converted ? {ok:true,open:converted.open,converted:true,unmapped:converted.unmapped || [],keyed} : {ok:true,open,keyed};
      } catch(e) { return {ok:true,open,convertError:e.message}; }
    } } while (Date.now() - start < openTimeoutMs); throw new Error('Timed out opening the file in Blender.');
  } catch(e) { return {ok:false,error:e.message}; }
}
async function setStage(stage,{cfg} = {}) { if (!excludeMap(stage)) return {ok:false,code:'STAGE',error:'Unknown stage.'}; try { const open = tagged(await require('./blender-ipc').callBlender(stagePython(stage),{cfg,timeoutMs:10000,label:'stage ' + stage}),'PHX_LEVEL'); if (!open || open.error) return {ok:false,code:'NOT_LEVEL',error:open && open.error || 'No Phoenix level or scene is open.'}; return {ok:true,open,...(open.converted ? {converted:true,unmapped:open.unmapped || []} : {})}; } catch(e) { return {ok:false,code:'NOT_LEVEL',error:e.message}; } }
async function withRouting(fn,{cfg,label} = {}) { const ipc = require('./blender-ipc'); let before; try { before = tagged(await ipc.callBlender(routeBeforePython(),{readOnly:true,cfg,timeoutMs:3000}),'PHX_ROUTE'); } catch (_) {}
  const restore = async () => { try { await ipc.callBlender(routeRestorePython(),{readOnly:true,cfg,timeoutMs:3000}); } catch (_) {} };
  let res; try { res = await fn(); } catch (e) { if (before && before.kind) await restore(); throw e; }
  if (!before || !before.kind) return res;
  if (/^(?:ERROR|[A-Z_]+_ERROR|REJECTED|BUSY)/.test(String(res))) { await restore(); return res; }
  try { const after = tagged(await ipc.callBlender(routeAfterPython(),{cfg,timeoutMs:3000,label:label || 'place new objects'}),'PHX_ROUTE'); return after && after.moved > 0 && after.target ? res + '\nNew objects placed in ' + after.target + '.' : res; } catch(e) { return res + '\nWarning: object routing failed: ' + e.message; } }
// ── automatic poster (P1) ──
const mtimeMs = p => { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } };
const blendVersion = p => { try { const st = fs.statSync(p); return {mtimeMs: st.mtimeMs, size: st.size}; } catch (_) { return null; } };
const versionKey = v => v ? v.mtimeMs + ':' + v.size : '';
const auto = { pending: new Set(), failed: new Map(), timers: new Map(), misses: new Map(), gen: 0 };   // gen: _reset() bumps it — a run already in flight then drops its result
let askChain = Promise.resolve();   // every isOpenDirty query of every autoPoster call runs strictly one at a time (they share Blender's IPC)
// F6.3: a level whose open-dirty query keeps answering 'dirty / unknown' is asked again later each time - doubling, capped at 5 min (no 20 s IPC chatter on a long edit)
function posterRetryMs(misses, debounceMs) { return Math.min(debounceMs * 2 ** misses, 300000); }
function posterPending(slug) { return auto.pending.has(slug); }
function autoPoster(cfg, {now = Date.now(), debounceMs = 20000, isOpenDirty = async () => false, onDone = () => {}, setTimer = setTimeout} = {}) {
  const schedule = (slug, ms) => { const h = setTimer(() => { auto.timers.delete(slug); check(slug, Date.now(), true); }, Math.max(0, ms)); if (h && typeof h.unref === 'function') h.unref(); auto.timers.set(slug, h); };
  const skew = now - Date.now();   // r4: the caller's clock (tests pass a simulated `now`) — the post-await debounce re-check reads the same clock
  const SKIP = Symbol('skip');
  // r5: `pre` runs when the queued query actually starts (inside the chain, before any IPC); a non-null result = reschedule in that many ms, no query
  const ask = (file, pre) => { const q = askChain.then(() => { const wait = pre && pre(); return wait != null ? SKIP : isOpenDirty(file); }); askChain = q.then(() => {}, () => {}); return q; };
  const waitFor = (blendFile, key) => { const v2 = blendVersion(blendFile); return (versionKey(v2) !== key || (v2 && Date.now() + skew - v2.mtimeMs < debounceMs)) ? (v2 ? Math.max(v2.mtimeMs + debounceMs - (Date.now() + skew), 0) : debounceMs) : null; };
  const finish = (slug, key, r) => { if (!r || !r.ok) auto.failed.set(slug, key); try { onDone(slug, r); } catch (_) {} check(slug, Date.now(), true); };   // re-check at once: a save during the render schedules the next one
  const run = async (slug, blendFile, key) => {
    const gen = auto.gen;
    try {
      let dirty; try { dirty = await ask(blendFile, () => waitFor(blendFile, key)); } catch (_) { dirty = null; }
      if (gen !== auto.gen) return;   // _reset() ran while the query was in flight: this run is void
      if (dirty === SKIP) { const w = waitFor(blendFile, key); schedule(slug, w != null ? w : debounceMs); return; }   // r5 start-of-query re-check: source changed / window open → no IPC
      if (dirty !== false) { const mm = auto.misses.get(slug), n = mm && mm.key === key ? mm.n : 0; auto.misses.set(slug, { key, n: n + 1 }); schedule(slug, posterRetryMs(n, debounceMs)); return; }
      // (above: true / unknown (null) / failed query: never render, ask again later - with backoff, F6.3)
      auto.misses.delete(slug);   // the query answered 'clean'
      const v2 = blendVersion(blendFile);   // r4: re-read AFTER the await — a save during the query (new version) or a still-open debounce window: no render, check again
      if (versionKey(v2) !== key || (v2 && Date.now() + skew - v2.mtimeMs < debounceMs)) { if (versionKey(v2) !== key) auto.misses.delete(slug); schedule(slug, v2 ? Math.max(v2.mtimeMs + debounceMs - (Date.now() + skew), 0) : debounceMs); return; }
      if (posterBusy(slug)) { schedule(slug, debounceMs); return; }
      finish(slug, key, await renderPoster(slug, {cfg}));
    } catch (e) { finish(slug, key, {ok:false, error:e.message}); }
  };
  function check(slug, nowMs, recheck) {
    let blendFile, v, poster, meta;
    try { blendFile = guarded(cfg, slug + '/level.blend'); v = blendVersion(blendFile); poster = mtimeMs(guarded(cfg, slug + '/poster.jpg')); meta = readJson(guarded(cfg, slug + '/meta.json')); } catch (_) { auto.pending.delete(slug); return; }
    const ps = meta && meta.posterSource, key = versionKey(v);
    // stale: no poster; or the recorded source version differs from the current level.blend; or (no record / old level, and a poster older than level.blend)
    const stale = !!v && (!poster || v.mtimeMs > poster || (ps && typeof ps.mtimeMs === 'number' && (ps.mtimeMs !== v.mtimeMs || ps.size !== v.size)));
    if (!stale || auto.failed.get(slug) === key) { auto.pending.delete(slug); return; }
    if (!recheck && (auto.pending.has(slug) || posterBusy(slug))) return;
    if (recheck && posterBusy(slug)) { auto.pending.add(slug); schedule(slug, debounceMs); return; }
    auto.pending.add(slug);
    if (nowMs - v.mtimeMs < debounceMs) { schedule(slug, v.mtimeMs + debounceMs - nowMs); return; }
    run(slug, blendFile, key);
  }
  for (const level of list(cfg)) if (!level.broken) check(level.slug, now, false);
  return [...auto.pending];
}
module.exports = {unmappedLines,convertPython,orphanPython,positionHints,CONVERT_NOTE,posterBusy,posterRetryMs,LAYERS,STAGES,STAGE_LABELS,excludeMap,slugify,slugOk,renderStageLine,root,list,touch,posterTouch,newLevelPython,newScenePython,stagePython,readOpenPython,openPython,savePython,routeBeforePython,routeAfterPython,routeRestorePython,keyHints,autoPoster,posterPending,blenderRunning,posterPython,createLevel,createScene,renderPoster,readOpen,openFile,setStage,withRouting,_setDeps: d => Object.assign(deps,d),_reset: () => {deps = {run:defaultRun}; for (const h of auto.timers.values()) try { clearTimeout(h); } catch (_) {} auto.timers.clear(); auto.pending.clear(); auto.failed.clear(); auto.misses.clear(); auto.gen++;}};
