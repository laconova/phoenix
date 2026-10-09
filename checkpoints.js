'use strict';

// ─── checkpoints.js — scene checkpoints + rewind (v1.9 M5) ─────────────────────
//
// Before a scene-changing tool runs, Phoenix saves a COPY of the open Blender file into a ring buffer
// (session/checkpoints/, override with PHOENIX_CHECKPOINT_DIR). Rewind = checkpoint of the current state
// first (so the rewind itself is undoable), then open the copy, then cut the chat back to that moment.
// Rewind is USER-ONLY: it is deliberately not a tool and not in the system prompt.
//
// Everything Blender-side is plain Python sent through blender-ipc (the addon is NOT changed).
// callBlender is looked up on the blender-ipc module at CALL time, so a test can swap it.

const fs   = require('fs');
const path = require('path');
const blenderIpc = require('./blender-ipc');

const DEFAULTS = { enabled: true, keep: 10, maxGB: 2 };
const SAVE_TIMEOUT_MS = 45000;   // a dead Blender must not cost minutes before every scene tool
const HISTORY_KEEP = 10;          // = what session/history.json holds; a checkpoint snapshots no more than that
const POLL_TIMEOUT_MS = 5000;
const NOOP_NOTE = 'already at this checkpoint';

function dir() {
  return process.env.PHOENIX_CHECKPOINT_DIR || path.join(__dirname, 'session', 'checkpoints');
}

// Settings with defaults. Invalid stored values (hand-edited config) read as the default.
function settings(cfg) {
  const c = (cfg && cfg.checkpoints && typeof cfg.checkpoints === 'object') ? cfg.checkpoints : {};
  const keep = (Number.isInteger(c.keep) && c.keep >= 1 && c.keep <= 100) ? c.keep : DEFAULTS.keep;
  const maxGB = (typeof c.maxGB === 'number' && Number.isFinite(c.maxGB) && c.maxGB >= 0.1 && c.maxGB <= 100) ? c.maxGB : DEFAULTS.maxGB;
  return { enabled: c.enabled !== false, keep, maxGB };
}

const norm = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const fwd  = (p) => String(p).replace(/\\/g, '/');
function insideDir(p) {
  if (!p) return false;
  const d = norm(path.resolve(dir()));
  const q = norm(path.resolve(String(p)));
  return q.startsWith(d + '/');
}
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const safeTool = (t) => String(t == null ? 'tool' : t).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'tool';
const blendOf = (id) => path.join(dir(), id + '.blend');
const metaOf  = (id) => path.join(dir(), id + '.json');
const cursorFile = () => path.join(dir(), 'cursor.json');

let lastAtMs = 0;   // `at` must strictly increase inside this process so "newest first" is never a tie
function nextAt() {
  let t = Date.now();
  if (t <= lastAtMs) t = lastAtMs + 1;
  lastAtMs = t;
  return new Date(t);
}

function readMeta(id) {
  try {
    const m = JSON.parse(fs.readFileSync(metaOf(id), 'utf8'));
    if (!m || m.id !== id) return null;
    return m;
  } catch (_) { return null; }
}

function writeMeta(meta) {
  const f = metaOf(meta.id), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, f);
}

// ─── cursor (linear timeline) ──────────────────────────────────────────────────
// cursor.json = { id, openedPath, fingerprint, at }: "the open scene IS checkpoint <id>, unchanged". Written only by a successful rewind.
// Valid for a scene only while Blender has openedPath open AND the scene fingerprint still equals the stored one AND the hard
// flag is clear; anything else = stale → dropped.
function readCursor() {
  try {
    const c = JSON.parse(fs.readFileSync(cursorFile(), 'utf8'));
    if (!c || typeof c.id !== 'string' || !SAFE_ID.test(c.id)) return null;
    if (!readMeta(c.id) || !fs.existsSync(blendOf(c.id))) return null;
    return c;
  } catch (_) { return null; }
}
function writeCursor(c) {
  const f = cursorFile(), tmp = f + '.tmp';
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, f);
}
function deleteCursor() { try { fs.unlinkSync(cursorFile()); } catch (_) {} }

// Every complete checkpoint (meta + copy both present), oldest first. Orphans are reported separately.
function scan() {
  const d = dir();
  let names = [];
  try { names = fs.readdirSync(d); } catch (_) { return { items: [], orphans: [] }; }
  const jsons = new Set(), blends = new Set();
  for (const n of names) {
    if (n === 'cursor.json') continue;   // the timeline cursor is not a checkpoint (prune would take it for an orphan)
    const m = /^([A-Za-z0-9_-]+)\.(json|blend)$/.exec(n);
    if (!m) continue;
    (m[2] === 'json' ? jsons : blends).add(m[1]);
  }
  const items = [], orphans = [];
  for (const id of jsons) {
    if (!blends.has(id)) { orphans.push(metaOf(id)); continue; }
    const meta = readMeta(id);
    if (!meta) { orphans.push(metaOf(id)); orphans.push(blendOf(id)); continue; }
    items.push(meta);
  }
  for (const id of blends) if (!jsons.has(id)) orphans.push(blendOf(id));
  items.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : (x.id < y.id ? -1 : 1)));
  return { items, orphans };
}

function usedBytes() { return scan().items.reduce((s, m) => s + (Number(m.bytes) || 0), 0); }

// Newest first, no history. `current` = this copy is the file Blender has open right now (pass currentPath).
function list({ currentPath } = {}) {
  const cur = currentPath ? norm(path.resolve(String(currentPath))) : null;
  const items = scan().items;
  let cursorAt = null;
  const c = readCursor();
  if (c && !(currentPath != null && norm(currentPath) !== norm(c.openedPath))) { const cm = items.find(m => m.id === c.id); if (cm) cursorAt = cm; }
  const posOf = (m) => !cursorAt ? null : (m.id === cursorAt.id ? 'here' : (m.at > cursorAt.at ? 'ahead' : null));
  return items.slice().reverse().map(m => ({
    id: m.id, turn: m.turn, tool: m.tool, at: m.at, bytes: m.bytes, kind: m.kind === 'pre-rewind' ? 'tip' : m.kind,
    position: posOf(m),
    projectPath: m.projectPath == null ? null : m.projectPath, hasProject: m.projectPath != null,
    current: cur != null && cur === norm(path.resolve(blendOf(m.id))),
  }));
}

function prune(cfg, protectIds) {
  const s = settings(cfg);
  const keepSet = new Set(protectIds.filter(Boolean));
  const { items, orphans } = scan();
  for (const f of orphans) { try { fs.unlinkSync(f); } catch (_) {} }
  const maxBytes = s.maxGB * 1024 * 1024 * 1024;
  let count = items.length, total = items.reduce((x, m) => x + (Number(m.bytes) || 0), 0);
  for (const m of items) {   // oldest first
    if (count <= s.keep && total <= maxBytes) break;
    if (keepSet.has(m.id)) continue;
    try { fs.unlinkSync(metaOf(m.id)); } catch (_) {}
    try { fs.unlinkSync(blendOf(m.id)); } catch (_) {}
    count--; total -= (Number(m.bytes) || 0);
  }
}

const stdoutOf = (r) => String((r && (r.stdout || r.output)) || '');
function parseTagged(r, tag) {
  const m = new RegExp(tag + ':(\\{.*\\})').exec(stdoutOf(r));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}
// Sweep 3 E: cfg is threaded through EVERY IPC call so cfg.apps.blenderIpcDir is honoured (it used to be ignored here).
const call = (callBlender, code, timeoutMs, cfg) =>
  (callBlender || ((c, o) => blenderIpc.callBlender(c, o)))(code, { cfg, timeoutMs });

// Which file Blender has open right now → string ('' = untitled) | null (Blender not reachable).
async function currentFilepath({ callBlender, timeoutMs = 3000, cfg } = {}) {
  try {
    const r = await call(callBlender, 'import bpy\nprint("CP_FP:" + bpy.data.filepath)', timeoutMs, cfg);
    if (!r || r.status === 'error') return null;
    const m = /CP_FP:(.*)/.exec(stdoutOf(r));
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
}

// ─── change watch + scene fingerprint (Blender side) ───────────────────────────
// Whether the open scene is still "checkpoint X, unchanged" is decided by a FINGERPRINT of the scene (objects, meshes,
// actions, materials/nodes, images, a few scene settings — NOT selection, frame, camera view). It is stored in cursor.json
// when the cursor is written and recomputed on every CP_STATE read, so it survives a Blender restart / file reopen.
// On top sits a hard flag: a depsgraph_update_post handler sets driver_namespace['phoenix_cp']['changed'] on a geometry or
// transform update (cheap early warning for edits the fingerprint would round away) and records the first 5 updates
// (type, name, geom, trans) so the live test can see what a click really fires. A missing entry is NOT a flag.
// Everything is try/except'd per item: the fingerprint never throws, a handler error never reaches Blender.
const FINGERPRINT_PY = [
  'def phoenix_cp_fingerprint():',
  '    import bpy, json, hashlib',
  '    try:',
  '        import numpy as np',
  '    except Exception:',
  '        np = None',
  '    MARK = "?"',
  '    def S(f):',
  '        try:',
  '            return f()',
  '        except Exception:',
  '            return MARK',
  '    def L(f):',
  '        try:',
  '            return list(f())',
  '        except Exception:',
  '            return []',
  '    def R(v, n=5):',
  '        return S(lambda: round(float(v), n) + 0.0)',
  '    def arr(seq, n):',
  '        # hash of a flat float sequence, rounded (-0.0 folded into 0.0)',
  '        return S(lambda: hashlib.sha1(json.dumps([round(float(x), n) + 0.0 for x in seq]).encode()).hexdigest())',
  '    def getco(coll, attr, width):',
  '        n = len(coll)',
  '        if np is not None:',
  '            a = np.empty(n * width, dtype=np.float32)',
  '            coll.foreach_get(attr, a)',
  '            a = np.round(a.astype(np.float64), 6) + 0.0',
  '            return hashlib.sha1(a.tobytes()).hexdigest()',
  '        flat = []',
  '        for e in coll:',
  '            flat.extend(getattr(e, attr))',
  '        return arr(flat, 6)',
  '    def K(coll):',
  '        # only datablocks a save keeps: 0 users (and no fake user) are dropped by Blender on save → would break restart',
  '        return [x for x in coll if (getattr(x, "users", 1) > 0 or getattr(x, "use_fake_user", False))]',
  '    out = {"obj": {}, "mesh": {}, "action": {}, "mat": {}, "tree": {}, "img": {}, "scene": None}',
  '    for o in L(lambda: sorted(K(bpy.data.objects), key=lambda x: x.name)):',
  '        nm = S(lambda: o.name)',
  '        out["obj"][str(nm)] = [',
  '            S(lambda: o.type),',
  '            S(lambda: o.data.name if o.data else None),',
  '            S(lambda: o.parent.name if o.parent else None),',
  '            S(lambda: [R(x) for row in o.matrix_world for x in row]),',
  '            S(lambda: bool(o.hide_viewport)), S(lambda: bool(o.hide_render)), S(lambda: bool(o.hide_get())),',
  '            S(lambda: [[m.type, m.name, bool(m.show_viewport), bool(m.show_render)] for m in o.modifiers]),',
  '            S(lambda: [s.material.name if s.material else None for s in o.material_slots]),',
  '        ]',
  '    for me in L(lambda: K(bpy.data.meshes)):',
  '        out["mesh"][str(S(lambda: me.name))] = [',
  '            S(lambda: [len(me.vertices), len(me.edges), len(me.polygons), len(me.loops)]),',
  '            S(lambda: getco(me.vertices, "co", 3)),',
  '            S(lambda: [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else []),',
  '            S(lambda: [u.name for u in me.uv_layers]),',
  '        ]',
  '    def fcurves_of(act):',
  '        try:',
  '            return list(act.fcurves)',
  '        except Exception:',
  '            pass',
  '        res = []',
  '        for ly in act.layers:',
  '            for st in ly.strips:',
  '                for cb in st.channelbags:',
  '                    res.extend(cb.fcurves)',
  '        return res',
  '    for act in L(lambda: K(bpy.data.actions)):',
  '        def one(act=act):',
  '            fcs = fcurves_of(act)',
  '            n = 0',
  '            h = hashlib.sha1()',
  '            for fc in fcs:',
  '                kp = fc.keyframe_points',
  '                n += len(kp)',
  '                h.update(str(getco(kp, "co", 2)).encode())',
  '            return [len(fcs), n, h.hexdigest()]',
  '        out["action"][str(S(lambda: act.name))] = S(one)',
  '    def tree_fp(nt):',
  '        nodes = list(nt.nodes)',
  '        ins = []',
  '        for nd in sorted(nodes, key=lambda x: x.name):',
  '            for i, sk in enumerate(nd.inputs):',
  '                dv = getattr(sk, "default_value", None)',
  '                if isinstance(dv, (bool, int, float)):',
  '                    ins.append([nd.name, i, R(dv, 4) if isinstance(dv, float) else dv])',
  '                elif dv is not None and hasattr(dv, "__len__"):',
  '                    ins.append([nd.name, i, [R(x, 4) for x in dv]])',
  '        return [len(nodes), sorted(nd.bl_idname for nd in nodes), len(nt.links), ins]',
  '    for mat in L(lambda: K(bpy.data.materials)):',
  '        out["mat"][str(S(lambda: mat.name))] = S(lambda: tree_fp(mat.node_tree) if mat.node_tree else None)',
  '    for nt in L(lambda: K(bpy.data.node_groups)):',
  '        out["tree"][str(S(lambda: nt.name))] = S(lambda: tree_fp(nt))',
  '    for im in L(lambda: K(bpy.data.images)):',
  '        out["img"][str(S(lambda: im.name))] = [S(lambda: list(im.size)), S(lambda: bool(im.is_dirty))]',
  '    def scene_fp():',
  '        sc = bpy.context.scene',
  '        return [sc.render.engine, sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage,',
  '                sc.camera.name if sc.camera else None, sc.world.name if sc.world else None,',
  '                sc.unit_settings.system, R(sc.unit_settings.scale_length, 6)]',
  '    out["scene"] = S(scene_fp)',
  '    return hashlib.sha1(json.dumps(out, sort_keys=True, default=str).encode()).hexdigest()',
].join('\n');

function watchPython() {
  return [
    'import bpy',
    'for _lst in (bpy.app.handlers.depsgraph_update_post, bpy.app.handlers.save_post):',
    '    for _h in list(_lst):',
    '        if getattr(_h, "__name__", "") in ("phoenix_cp_watch", "phoenix_cp_save"):',
    '            _lst.remove(_h)',
    FINGERPRINT_PY,
    'bpy.app.driver_namespace["phoenix_cp"] = {"changed": False, "hits": []}',
    'def phoenix_cp_watch(scene, depsgraph=None):',
    '    try:',
    '        import bpy',
    '        st = bpy.app.driver_namespace.get("phoenix_cp")',
    '        if st is None:',
    '            return',
    '        for u in depsgraph.updates:',
    '            g = bool(u.is_updated_geometry)',
    '            t = bool(u.is_updated_transform)',
    '            hits = st.setdefault("hits", [])',
    '            if len(hits) < 5:',
    '                hits.append([type(u.id).__name__, getattr(u.id, "name", None), g, t])',
    '            if g or t:',
    '                st["changed"] = True',
    '    except Exception:',
    '        pass',
    'bpy.app.handlers.depsgraph_update_post.append(phoenix_cp_watch)',
    'print("CP_WATCH_OK:" + phoenix_cp_fingerprint())',
  ].join('\n');
}
// → the scene fingerprint to store in the cursor, or null when the watch could not be installed
async function installWatch(callBlender, cfg) {
  try {
    const r = await call(callBlender, watchPython(), SAVE_TIMEOUT_MS, cfg);
    const m = (r && r.status !== 'error') ? /CP_WATCH_OK:([0-9a-f]{40})/.exec(stdoutOf(r)) : null;
    return m ? m[1] : null;
  } catch (_) { return null; }
}

function statePython() {
  return [
    'import bpy, json',
    FINGERPRINT_PY,
    'st = bpy.app.driver_namespace.get("phoenix_cp")',
    'print("CP_STATE:" + json.dumps({"filepath": bpy.data.filepath, "fp": phoenix_cp_fingerprint(), "watching": st is not None, "changed": bool(st.get("changed")) if st else False, "hits": (list(st.get("hits", [])) if st else [])}))',
  ].join('\n');
}

// Cursor vs. the scene Blender has open now. { cursor, state: 'none' | 'valid' | 'changed' | 'other' | 'unknown' }.
// valid = same file AND the fingerprint equals the one stored with the cursor AND no hard flag AND the change watcher is active (sweep 3 D).
// 'unwatched' = same file + equal fingerprint but no active watcher (Blender restarted): not trusted, nothing deleted. 'unknown' = the read failed.
async function cursorState(callBlender, cfg) {
  const cursor = readCursor();
  if (!cursor) return { cursor: null, state: 'none' };
  try {
    const r = await call(callBlender, statePython(), SAVE_TIMEOUT_MS, cfg);
    const res = (r && r.status !== 'error') ? parseTagged(r, 'CP_STATE') : null;
    if (!res || typeof res.fp !== 'string') return { cursor, state: 'unknown' };
    if (res.hits && res.hits.length) console.log('[checkpoints] depsgraph updates seen by the watch:', JSON.stringify(res.hits));
    if (norm(res.filepath) !== norm(cursor.openedPath)) return { cursor, state: 'other' };
    // Sweep 3 D: the fingerprint alone misses edits it does not cover (a light's energy, ...). It may only vouch for "unchanged" while the change
    // watcher has been continuously active since the cursor was set - after a Blender restart the watcher is gone (res.watching false), so the scene
    // counts as changed and the undo copy IS taken.
    if (res.fp !== cursor.fingerprint || res.changed) return { cursor, state: 'changed' };
    return { cursor, state: res.watching === true ? 'valid' : 'unwatched' };   // 'unwatched': nothing vouches for "unchanged" -> never skip the undo copy, but delete nothing either
  } catch (_) { return { cursor, state: 'unknown' }; }
}

// Drop every checkpoint strictly newer than <id> (the future that a new action overwrites).
function dropAfter(id) {
  const base = readMeta(id);
  if (!base) return;
  for (const m of scan().items) {
    if (m.at > base.at) {
      try { fs.unlinkSync(metaOf(m.id)); } catch (_) {}
      try { fs.unlinkSync(blendOf(m.id)); } catch (_) {}
    }
  }
}

// ─── take ──────────────────────────────────────────────────────────────────────

async function take(tool, { cfg, turn, kind, callBlender, history, protect } = {}) {
  try {
    if (!settings(cfg).enabled) { deleteCursor(); return { skipped: 'disabled' }; }   // no tracking → the cursor would go stale unseen

    // Linear timeline: a valid cursor means the scene already IS checkpoint cursor.id → nothing to save, and the
    // action that follows overwrites the undone future. A changed scene at the cursor = a new action as well.
    const cs = await cursorState(callBlender, cfg);
    if (cs.state === 'valid') {
      dropAfter(cs.cursor.id); deleteCursor();
      return { ok: true, id: cs.cursor.id, reused: true };
    }
    if (cs.state === 'changed') { dropAfter(cs.cursor.id); deleteCursor(); }
    else if (cs.state === 'other' || cs.state === 'unknown' || cs.state === 'unwatched') deleteCursor();   // unknown: no checkpoint is deleted, but the cursor can no longer be trusted
    const at = nextAt();
    const base = at.toISOString().replace(/[-:.]/g, '');
    const id = base + '-t' + (Number.isFinite(Number(turn)) ? Number(turn) : 0) + '-' + safeTool(tool);
    const target = fwd(path.resolve(blendOf(id)));

    // One IPC call: read the filepath, then save a COPY (copy=True: the user's file, its path and its dirty
    // flag stay untouched). No relative_remap / compression change — a copy of what is open.
    const py = [
      'import bpy, os, json',
      'res = {"ok": False, "filepath": bpy.data.filepath, "bytes": 0, "err": None}',
      'try:',
      '    os.makedirs(os.path.dirname(' + JSON.stringify(target) + '), exist_ok=True)',
      '    bpy.ops.wm.save_as_mainfile(filepath=' + JSON.stringify(target) + ', copy=True, check_existing=False)',
      '    res["bytes"] = os.path.getsize(' + JSON.stringify(target) + ')',
      '    res["ok"] = True',
      'except Exception as e:',
      '    res["err"] = str(e)',
      'print("CP_JSON:" + json.dumps(res))',
    ].join('\n');
    let r;
    try { r = await call(callBlender, py, SAVE_TIMEOUT_MS, cfg); }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
    if (!r || r.status === 'error') return { ok: false, error: (r && r.message) ? String(r.message).slice(0, 300) : 'Blender reported an error' };
    const res = parseTagged(r, 'CP_JSON');
    if (!res) return { ok: false, error: 'Blender gave no checkpoint answer' };
    if (!res.ok) { try { fs.unlinkSync(blendOf(id)); } catch (_) {} return { ok: false, error: String(res.err || 'save failed').slice(0, 300) }; }

    // projectPath: the user's real file. A checkpoint copy that is open (after a "stay" rewind) hands on the
    // projectPath stored in ITS meta; an untitled file is null.
    const fp = res.filepath || '';
    let projectPath = null;
    let openId = null;
    if (fp && insideDir(fp)) {
      openId = path.basename(fp).replace(/\.blend$/i, '');
      const om = SAFE_ID.test(openId) ? readMeta(openId) : null;
      projectPath = om && om.projectPath != null ? om.projectPath : null;
    } else if (fp) {
      projectPath = fp;
    }

    let hist = history;
    if (!Array.isArray(hist)) {
      try { hist = require('./assistant').loadHistory(); } catch (_) { hist = []; }
    }
    let bytes = Number(res.bytes) || 0;
    if (!bytes) { try { bytes = fs.statSync(blendOf(id)).size; } catch (_) {} }
    hist = hist.slice(-HISTORY_KEEP);
    const meta = { id, turn: Number.isFinite(Number(turn)) ? Number(turn) : 0, tool: String(tool), at: at.toISOString(), bytes,
                   projectPath, history: hist, kind: (kind === 'tip' || kind === 'pre-rewind') ? 'tip' : 'auto' };
    fs.mkdirSync(dir(), { recursive: true });
    writeMeta(meta);
    const curs = readCursor();
    try { prune(cfg, [id, openId, curs && curs.id].concat(Array.isArray(protect) ? protect : [])); } catch (_) {}
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ─── rewind ────────────────────────────────────────────────────────────────────

async function rewind(id, choice, { cfg, callBlender, saveHistory, loadHistory, turn, sleep, pollMs = 500, openTimeoutMs = 60000 } = {}) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return { ok: false, error: 'unknown checkpoint', choice };
  if (choice !== 'stay' && choice !== 'overwrite') return { ok: false, error: 'choice must be stay or overwrite', choice };
  const meta = readMeta(id);
  if (!meta || !fs.existsSync(blendOf(id))) return { ok: false, error: 'unknown checkpoint', choice };
  const nap = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));

  // (1) checkpoint of the CURRENT state first — a rewind must be undoable. Failing here aborts the rewind.
  // With a valid cursor the current scene is already stored as cursor.id → no new checkpoint (no fork per rewind);
  // rewinding to the checkpoint the cursor already points at is a no-op.
  const cs = await cursorState(callBlender, cfg);
  let curHist = [];
  try { if (typeof loadHistory === 'function') curHist = loadHistory() || []; } catch (_) {}
  let noop = false;
  if (cs.state === 'valid') {
    if (cs.cursor.id === id) {
      noop = true;
      // stay: nothing to do, the chat keeps its CURRENT history (no snapshot, no note)
      if (choice === 'stay') return { ok: true, openedPath: cs.cursor.openedPath, choice, history: curHist, rewound: false, noop: true, note: NOOP_NOTE };
    }
  } else {
    const pre = await take('rewind', { cfg, turn, kind: 'tip', callBlender, history: curHist, protect: [id] });   // the target must survive this prune
    if (pre && pre.ok === false) return { ok: false, error: 'could not checkpoint the current scene first (' + pre.error + ') — rewind aborted', choice };
    // the pre-take may have dropped the future (a changed scene at the cursor) — the target can be gone by now
    if (!readMeta(id) || !fs.existsSync(blendOf(id))) return { ok: false, error: 'that redo step was removed by your change to the scene', choice };
  }
  // pre.skipped === 'disabled': the user switched checkpoints off, so this rewind has no undo copy (by their choice).

  // (2) open the copy. ⚠ The open is DEFERRED to a one-shot timer: the IPC code runs inside the addon's persistent
  // bpy.app.timers callback, and loading another .blend from inside that callback frees the data the running
  // callback stands on (the known crash shape). The IPC call only registers the timer and returns at once;
  // the timer fires on a clean stack and then Phoenix polls the filepath until the file is open.
  // Note: after the load the addon's persistent namespace may hold stale datablock references from earlier
  // scripts — Phoenix's generated code looks objects up fresh, so this is documented, not changed.
  const target = fwd(path.resolve(blendOf(id)));
  const reg = [
    'import bpy',
    'P = ' + JSON.stringify(target),
    'bpy.app.timers.register(lambda P=P: (bpy.ops.wm.open_mainfile(filepath=P, load_ui=False), None)[1], first_interval=0.2)',
    'print("CP_OPEN_REGISTERED")',
  ].join('\n');
  if (!noop) try {
    const r = await call(callBlender, reg, POLL_TIMEOUT_MS * 6, cfg);
    if (!r || r.status === 'error') return { ok: false, error: 'Blender refused the open request' + (r && r.message ? ': ' + String(r.message).slice(0, 200) : ''), choice };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), choice }; }
  const tries = Math.max(1, Math.ceil(openTimeoutMs / pollMs));
  let opened = noop;   // a no-op overwrite skips the open: the checkpoint is already what Blender has
  for (let i = 0; i < tries && !opened; i++) {
    await nap(pollMs);
    try {
      const r = await call(callBlender, 'import bpy\nprint(bpy.data.filepath)', POLL_TIMEOUT_MS, cfg);
      if (r && r.status !== 'error' && stdoutOf(r).split(/\r?\n/).some(l => l.trim() && norm(l.trim()) === norm(target))) opened = true;
    } catch (_) { /* Blender is busy loading — tolerated */ }
  }
  if (!opened) return { ok: false, error: 'Blender did not open the checkpoint within ' + Math.round(openTimeoutMs / 1000) + ' s', choice };

  // (3) overwrite → the open file becomes the project file again, now in the rewound state
  let openedPath = noop ? cs.cursor.openedPath : target;
  let problem = null;
  if (choice === 'overwrite') {
    if (meta.projectPath == null) {
      problem = 'this scene was never saved — stay in the copy and use Save As in Blender';
    } else {
      const pp = fwd(meta.projectPath);
      const py = [
        'import bpy, json',
        'err = None',
        'try:',
        '    bpy.ops.wm.save_as_mainfile(filepath=' + JSON.stringify(pp) + ', check_existing=False)',
        'except Exception as e:',
        '    err = str(e)',
        'print("CP_JSON:" + json.dumps({"filepath": bpy.data.filepath, "err": err}))',
      ].join('\n');
      try {
        const r = await call(callBlender, py, SAVE_TIMEOUT_MS, cfg);
        const res = r && r.status !== 'error' ? parseTagged(r, 'CP_JSON') : null;
        if (!res) problem = 'could not save over the project file' + (r && r.message ? ': ' + String(r.message).slice(0, 200) : '');
        else if (res.err) problem = 'could not save over the project file: ' + String(res.err).slice(0, 200);
        else if (norm(res.filepath) !== norm(pp)) problem = 'saving over the project file could not be verified';
        else openedPath = meta.projectPath;
      } catch (e) { problem = 'could not save over the project file: ' + ((e && e.message) || e); }
    }
  }

  // the open scene IS checkpoint <id>, unchanged → remember it (undo/redo position) and start watching for changes.
  // No watch = no way to tell a later edit → no cursor (the rewind itself still worked; only redo is lost).
  deleteCursor();
  const fingerprint = await installWatch(callBlender, cfg);
  if (fingerprint) { try { writeCursor({ id, openedPath, fingerprint, at: new Date().toISOString() }); } catch (_) {} }

  if (noop) {   // overwrite on the checkpoint that is already open: only the project file was written
    if (problem) return { ok: false, error: problem, rewound: false, noop: true, openedPath, choice, history: curHist };
    return { ok: true, openedPath, choice, history: curHist, rewound: false, noop: true, note: NOOP_NOTE };
  }

  // (4) the scene IS rewound (even if the overwrite was refused) → cut the chat to the same moment
  const note = '(Rewound the Blender scene to before ' + meta.tool + ' in turn ' + meta.turn + '. Anything after that is undone.)';
  // Never two assistant messages in a row: when the snapshot ends with an assistant message the note joins it.
  const restored = Array.isArray(meta.history) ? meta.history.slice() : [];
  const lastMsg = restored[restored.length - 1];
  if (lastMsg && lastMsg.role === 'assistant') restored[restored.length - 1] = Object.assign({}, lastMsg, { content: String(lastMsg.content) + '\n\n' + note });
  else restored.push({ role: 'assistant', content: note });
  try { if (typeof saveHistory === 'function') saveHistory(restored); } catch (_) {}
  if (problem) return { ok: false, error: problem, rewound: true, openedPath, choice, history: restored };
  return { ok: true, openedPath, choice, history: restored, rewound: true };
}

module.exports = { take, list, rewind, settings, usedBytes, currentFilepath, dir, insideDir, DEFAULTS, _watchPython: watchPython, _statePython: statePython, _fingerprintPython: () => FINGERPRINT_PY };
