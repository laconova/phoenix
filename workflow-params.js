'use strict';

const fs   = require('fs');
const path = require('path');
const workflows = require('./workflows');

// ─── v1.10 ADV · per-workflow tunable parameters — ONE store, two views ──────────────────────────────────────────
// Every tunable (cfg, steps, sampler, resolution, Trellis faces/steps, ...) is declared on the workflow entry (`params`, workflows.js).
// The VALUE lives here, in workflow-params.json (beside palette.json), workflow-level by default, with an opt-in per-category override:
//
//   { version:1, workflows:{ <id>:{ values:{<key>:v}, overrides:{<category>:{<key>:v}} } }, seed:{ <id>:{ locked, value } } }
//
//   effective(id, category, key) = overrides[category][key]  →  values[key]  →  the default read from the workflow JSON
//
// The Advanced section of the workflow window and the palette editor are two views of this file: editing either moves the other.
// Reads are fresh on every call (phoenix.js is spawned per stage; the server and the stage processes share the file).
// No project-local requires except workflows.js (which itself requires nothing local) - no require cycle.

const SIZE_MIN = 256, SIZE_MAX = 2048, SIZE_STEP = 16;
const SIZE_PRESETS = [
  { label: '1024 × 1024 (1:1)',  w: 1024, h: 1024 },
  { label: '1344 × 768 (16:9)',  w: 1344, h: 768 },
  { label: '768 × 1344 (9:16)',  w: 768,  h: 1344 },
  { label: '1152 × 896 (4:3)',   w: 1152, h: 896 },
  { label: '896 × 1152 (3:4)',   w: 896,  h: 1152 },
  { label: '1536 × 640 (21:9)',  w: 1536, h: 640 },
];
const MAX_SEED = 0x7fffffff;
// The palette values the migration carries over, per workflow (the palette's cfg/steps were tuned for Flux, its faces for Trellis).
const MIGRATION = { flux_klein: ['cfg', 'steps'], trellis2: ['target_face_num'] };
const PALETTE_KEYS = ['cfg', 'steps', 'target_face_num'];   // the three fields palette.json carried before ADV

const DEFAULT_FILE = process.env.PHOENIX_WORKFLOW_PARAMS_FILE || path.join(__dirname, 'workflow-params.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameVal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ─── declarations ────────────────────────────────────────────────────────────────────────────────────────────────

function validDecl(p) {
  return isObj(p) && typeof p.key === 'string' && /^[a-z][a-z0-9_]*$/.test(p.key) && ['int', 'float', 'enum', 'size'].includes(p.type) &&
    Array.isArray(p.targets) && p.targets.length > 0 && p.targets.every(t => isObj(t) && t.node != null && typeof t.field === 'string' && t.field);
}

// A user-added workflow has no `params`: derive them from its node map (cfg/steps slots; faces for a mesh workflow, which the palette fed
// before ADV). Only slots the node map really has; nothing else is guessed.
function derive(entry) {
  const n = entry && entry.nodes;
  if (!isObj(n) || !entry.stage) return [];
  const out = [];
  const target = (slot) => {
    if (n[slot] == null) return null;
    let r; try { r = workflows.resolveSlot(entry.stage, slot, n[slot]); } catch (_) { return null; }
    return r && r.node && r.field ? [{ node: String(r.node), field: String(r.field) }] : null;
  };
  let t;
  if ((t = target('cfg'))   && (entry.stage === 'image' || entry.stage === 'i2i')) out.push({ key: 'cfg',   label: 'CFG',   type: 'float', min: 0, max: 20,  step: 0.1, targets: t });
  if ((t = target('steps')) && entry.stage === 'image')                            out.push({ key: 'steps', label: 'Steps', type: 'int',   min: 1, max: 100, step: 1,   targets: t });
  if ((t = target('target_face_num')) && entry.stage === 'mesh')                   out.push({ key: 'target_face_num', label: 'Target faces', type: 'int', min: 200, max: 300000, step: 100, targets: t });
  return out;
}

/** declared(entry[, withReference]) → the param declarations of a registry entry (builtin `params`, or derived for a user-added entry). */
function declaredOf(entry, withReference) {
  if (!isObj(entry)) return [];
  let list = Array.isArray(entry.params) ? entry.params.filter(validDecl) : derive(entry);
  if (withReference && Array.isArray(entry.referenceParams)) {
    list = list.concat(entry.referenceParams.filter(validDecl).map(p => Object.assign({}, p, { scope: 'reference' })));
  }
  return list;
}

function graphOf(entry, decl) {
  const file = decl.file ? path.resolve(__dirname, decl.file) : workflows.resolveWorkflowFile(entry);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const roundSize = (v) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(v / SIZE_STEP) * SIZE_STEP));

/** The default of a param = the value the workflow JSON carries at the first target (null when it cannot be read as the param's type). */
function defaultOf(entry, decl) {
  let g; try { g = graphOf(entry, decl); } catch (_) { return null; }
  const at = (t) => { const nd = g && g[t.node]; return nd && nd.inputs ? nd.inputs[t.field] : undefined; };
  if (decl.type === 'size') {
    const w = decl.targets.find(t => t.field === 'width'), h = decl.targets.find(t => t.field === 'height');
    const wv = w ? at(w) : undefined, hv = h ? at(h) : undefined;
    return (Number.isFinite(wv) && Number.isFinite(hv)) ? { w: wv, h: hv } : null;
  }
  const v = at(decl.targets[0]);
  if (decl.type === 'int')   return Number.isInteger(v) ? v : null;
  if (decl.type === 'float') return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  if (decl.type === 'enum')  return (typeof v === 'string' || typeof v === 'number') ? v : null;
  return null;
}

// ─── validation ──────────────────────────────────────────────────────────────────────────────────────────────────

/** validateValue(decl, value) → { ok:true, value } | { error, field }. Wrong type / out of range is REFUSED (a size is normalised). */
function validateValue(decl, value) {
  const bad = (msg) => ({ error: msg, field: decl.key });
  if (decl.type === 'size') {
    if (!isObj(value) || typeof value.w !== 'number' || typeof value.h !== 'number' || !Number.isFinite(value.w) || !Number.isFinite(value.h)) return bad(decl.key + ' must be {w, h} numbers');
    return { ok: true, value: { w: roundSize(value.w), h: roundSize(value.h) } };
  }
  if (decl.type === 'enum') {
    if (Array.isArray(decl.options)) {
      const hit = decl.options.find(o => o === value);
      return hit !== undefined ? { ok: true, value: hit } : bad(decl.key + ' must be one of ' + decl.options.join(', '));
    }
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.+\-]{1,80}$/.test(value)) return bad(decl.key + ' must be a name');
    return { ok: true, value };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return bad(decl.key + ' must be a number');
  if (decl.type === 'int' && !Number.isInteger(value)) return bad(decl.key + ' must be an integer');
  if (typeof decl.min === 'number' && value < decl.min) return bad(decl.key + ' must be at least ' + decl.min);
  if (typeof decl.max === 'number' && value > decl.max) return bad(decl.key + ' must be at most ' + decl.max);
  return { ok: true, value };
}

/** clampValue(decl, value) → the value forced into the declaration's range (used for one-off overrides); undefined = unusable. */
function clampValue(decl, value) {
  if (decl.type === 'size') return validateValue(decl, value).ok ? validateValue(decl, value).value : undefined;
  if (decl.type === 'enum') {
    if (Array.isArray(decl.options)) return decl.options.find(o => o === value);
    return validateValue(decl, value).ok ? value : undefined;
  }
  let n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (decl.type === 'int') n = Math.round(n);
  if (typeof decl.min === 'number') n = Math.max(decl.min, n);
  if (typeof decl.max === 'number') n = Math.min(decl.max, n);
  return n;
}

// ─── applying values to a graph / describing them ───────────────────────────────────────────────────────────────────

/** applyToGraph(entry, wf, values[, withReference]) → [keys actually written]. Every target of every declared param with a value is written. */
function applyToGraph(entry, wf, values, withReference) {
  const done = [];
  for (const decl of declaredOf(entry, withReference)) {
    if (!values || values[decl.key] === undefined || values[decl.key] === null) continue;
    let wrote = false;
    for (const t of decl.targets) {
      const nd = wf && wf[String(t.node)];
      if (!nd) continue;
      if (!nd.inputs) nd.inputs = {};
      if (decl.type === 'size') {
        if (t.field === 'width')  { nd.inputs.width  = values[decl.key].w; wrote = true; }
        if (t.field === 'height') { nd.inputs.height = values[decl.key].h; wrote = true; }
      } else { nd.inputs[t.field] = values[decl.key]; wrote = true; }
    }
    if (wrote) done.push(decl.key);
  }
  return done;
}

function fmtValue(decl, v) {
  if (decl.type === 'size') return v.w + '×' + v.h;
  if (decl.type === 'float') return Number.isInteger(v) ? v.toFixed(1) : String(v);
  return String(v);
}
/** describeRun(entry, run, keys) → "cfg 4.0 (furniture) · steps 20 · sampler dpmpp_2m · 1024×1024" for exactly the keys that were set. */
function describeRun(entry, run, keys) {
  const parts = [];
  for (const decl of declaredOf(entry, true)) {
    if (!keys.includes(decl.key)) continue;
    const src = run.sources[decl.key];
    const mark = src && src.indexOf('override:') === 0 ? ' (' + src.slice(9) + ')' : (src === 'one-off' ? ' (one-off)' : '');
    parts.push((decl.type === 'size' ? '' : decl.key + ' ') + fmtValue(decl, run.values[decl.key]) + mark);
  }
  return parts.join(' · ');
}

// ─── the store ───────────────────────────────────────────────────────────────────────────────────────────────────────

function createStore(opts) {
  opts = opts || {};
  const FILE = opts.file || DEFAULT_FILE;
  const paletteFile = () => opts.paletteFile || require('./palette').PALETTE_FILE;
  const registry = opts.registry || (() => workflows.loadRegistry());
  const warn = opts.warn || ((m) => { try { console.error(m); } catch (_) {} });
  let warned = false;

  const entryOf = (id) => { try { const r = registry(); return (r && r.workflows && isObj(r.workflows[id])) ? r.workflows[id] : null; } catch (_) { return null; } };

  // palette categories, tolerant (a read problem never throws; the palette file is never written from here)
  // null = palette.json exists but cannot be read / is ill-shaped right now (the caller must NOT act as if it had the builtin defaults)
  function paletteCatsStrict() {
    let raw;
    try { raw = fs.readFileSync(paletteFile(), 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return clone(require('./palette').DEFAULT_PALETTE.categories);   // genuinely absent → palette.js seeds the builtins
      return null;
    }
    try { const p = JSON.parse(raw); return (p && isObj(p.categories)) ? p.categories : null; } catch (_) { return null; }
  }
  function paletteCats() { return paletteCatsStrict() || clone(require('./palette').DEFAULT_PALETTE.categories); }
  const categoryKeys = () => Object.keys(paletteCats());

  const empty = () => ({ version: 1, workflows: {}, seed: {} });
  // strict shape check of what is on disk: anything off is "corrupt" (setters refuse, the bytes stay) - never silently dropped
  const isVal = (v) => typeof v === 'number' || typeof v === 'string' || (isObj(v) && typeof v.w === 'number' && typeof v.h === 'number');
  function checkShape(j) {
    const bad = (m) => { throw new Error('bad shape: ' + m); };
    if (!isObj(j)) bad('root');
    if (j.workflows !== undefined && !isObj(j.workflows)) bad('workflows');
    for (const [id, w] of Object.entries(j.workflows || {})) {
      if (!isObj(w)) bad('workflows.' + id);
      if (w.values !== undefined) { if (!isObj(w.values)) bad(id + '.values'); for (const [k, v] of Object.entries(w.values)) if (!isVal(v)) bad(id + '.values.' + k); }
      if (w.overrides !== undefined) {
        if (!isObj(w.overrides)) bad(id + '.overrides');
        for (const [c, kv] of Object.entries(w.overrides)) { if (!isObj(kv)) bad(id + '.overrides.' + c); for (const [k, v] of Object.entries(kv)) if (!isVal(v)) bad(id + '.overrides.' + c + '.' + k); }
      }
    }
    if (j.seed !== undefined) {
      if (!isObj(j.seed)) bad('seed');
      for (const [id, v] of Object.entries(j.seed)) {
        if (!isObj(v) || (v.locked !== undefined && typeof v.locked !== 'boolean') || (v.value !== undefined && v.value !== null && !Number.isInteger(v.value))) bad('seed.' + id);
      }
    }
  }
  function normalise(s) {
    const out = empty();
    if (isObj(s.workflows)) for (const [id, w] of Object.entries(s.workflows)) {
      if (!isObj(w)) continue;
      const o = { values: isObj(w.values) ? w.values : {}, overrides: {} };
      if (isObj(w.overrides)) for (const [c, kv] of Object.entries(w.overrides)) if (isObj(kv)) o.overrides[c] = kv;
      out.workflows[id] = o;
    }
    if (isObj(s.seed)) for (const [id, v] of Object.entries(s.seed)) if (isObj(v)) out.seed[id] = { locked: v.locked === true, value: Number.isInteger(v.value) ? v.value : null };
    return out;
  }

  // ── migration (file absent): carry the palette's cfg/steps/faces over — all categories, custom ones included ──
  function pick(pairs) {   // [[category, value]] → most common value; tie → item's value if tied, else the smallest
    const count = new Map();
    for (const [, v] of pairs) count.set(JSON.stringify(v), (count.get(JSON.stringify(v)) || 0) + 1);
    const top = Math.max(...count.values());
    const tied = [...count.entries()].filter(([, c]) => c === top).map(([k]) => JSON.parse(k));
    const item = pairs.find(([c]) => c === 'item');
    if (item && tied.some(t => sameVal(t, item[1]))) return item[1];
    return tied.slice().sort((a, b) => a - b)[0];
  }
  function seedFrom(state, wfId, categories) {
    const entry = entryOf(wfId);
    if (!entry) return;
    const decls = declaredOf(entry);
    for (const key of (MIGRATION[wfId] || [])) {
      const decl = decls.find(d => d.key === key);
      if (!decl) continue;
      const pairs = [];
      for (const [cat, c] of Object.entries(categories)) {
        const v = c && c[key];
        if (v !== undefined && validateValue(decl, v).ok) pairs.push([cat, v]);
      }
      if (!pairs.length) continue;
      const base = pick(pairs);
      const w = state.workflows[wfId] || (state.workflows[wfId] = { values: {}, overrides: {} });
      w.values[key] = base;
      for (const [cat, v] of pairs) if (!sameVal(v, base)) { (w.overrides[cat] || (w.overrides[cat] = {}))[key] = v; }
    }
  }
  function migrate() {
    const cats = paletteCatsStrict();
    if (!cats) return null;   // palette.json unreadable: defer - nothing seeded, nothing written, the next successful read migrates
    const state = empty();
    for (const id of Object.keys(MIGRATION)) seedFrom(state, id, cats);
    return state;
  }

  function write(state) {
    const tmp = FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  }

  // read() → { state, corrupt, transient }. ENOENT seeds (migration); a parse/shape error or a transient read error NEVER touches the file.
  function read() {
    let raw;
    try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') {
        const st = migrate();
        if (!st) return { state: empty(), deferred: true };
        try { write(st); } catch (_) { /* read-only FS: still usable in memory */ }
        return { state: st };
      }
      return { state: empty(), transient: true };
    }
    try {
      const j = JSON.parse(raw);
      checkShape(j);
      return { state: normalise(j) };
    } catch (_) {
      if (!warned) { warned = true; warn('[workflow-params] ' + path.basename(FILE) + ' is unreadable - using the workflow defaults; the file is left untouched.'); }
      return { state: empty(), corrupt: true };
    }
  }
  const unusable = (r) => {
    if (r.transient) return { error: path.basename(FILE) + ' could not be read just now - try again', field: 'file' };
    if (r.corrupt) return { error: path.basename(FILE) + ' is unreadable - fix or remove the file first; nothing was changed', field: 'file' };   // never overwrite it
    if (r.deferred) return { error: 'palette.json cannot be read just now - the first-time migration is waiting for it; nothing was changed', field: 'file' };
    return null;
  };
  function mutate(fn) {
    const r = read();
    const bad = unusable(r); if (bad) return bad;
    const res = fn(r.state);
    if (res && res.error) return res;
    try { write(r.state); } catch (e) { return { error: 'could not save: ' + e.message, field: 'file' }; }
    return res || { ok: true };
  }

  const declaredFor = (id, withRef) => declaredOf(entryOf(id), withRef !== false);
  const wfState = (state, id) => state.workflows[id] || (state.workflows[id] = { values: {}, overrides: {} });
  const stored = (decl, v) => (v !== undefined && validateValue(decl, v).ok) ? validateValue(decl, v).value : undefined;

  // resolve(id, category) → { key: { value, source: 'override:<cat>'|'workflow'|'default', workflowValue, default } } for every declared param
  function resolve(id, category) {
    const entry = entryOf(id);
    const out = {};
    if (!entry) return out;
    const st = read().state;
    const w = st.workflows[id] || { values: {}, overrides: {} };
    const known = category && categoryKeys().includes(category);   // an override of a category deleted from the palette is not applied
    for (const decl of declaredOf(entry, true)) {
      const def = defaultOf(entry, decl);
      const wv = stored(decl, w.values[decl.key]);
      const ov = known && w.overrides[category] ? stored(decl, w.overrides[category][decl.key]) : undefined;
      let value, source;
      if (ov !== undefined)      { value = ov;  source = 'override:' + category; }
      else if (wv !== undefined) { value = wv;  source = 'workflow'; }
      else if (def !== null)     { value = def; source = 'default'; }
      else continue;
      out[decl.key] = { scope: decl.scope || null, value, source, workflowValue: wv !== undefined ? wv : def, default: def };
    }
    return out;
  }
  function effective(id, category) {
    const out = {};
    for (const [k, r] of Object.entries(resolve(id, category))) if (r.scope !== 'reference') out[k] = r.value;
    return out;
  }

  /** run(id, category, oneOff) → { values, sources } for a stage: store value, then a one-off override (never stored), then clamped. */
  function run(id, category, oneOff) {
    const entry = entryOf(id);
    const res = resolve(id, category);
    const values = {}, sources = {};
    for (const decl of declaredOf(entry, false)) {
      const r = res[decl.key];
      let v = r ? r.value : undefined, src = r ? r.source : null;
      if (oneOff && oneOff[decl.key] !== undefined && oneOff[decl.key] !== null) {
        const c = clampValue(decl, oneOff[decl.key]);
        if (c !== undefined && !sameVal(c, v)) { v = c; src = 'one-off'; }
      }
      if (v !== undefined) { values[decl.key] = v; sources[decl.key] = src; }
    }
    return { values, sources };
  }

  const declOrErr = (id, key) => {
    if (!entryOf(id)) return { error: 'unknown workflow', field: 'id', notFound: true };
    const d = declaredFor(id, true).find(x => x.key === key);
    return d ? { decl: d } : { error: 'unknown parameter "' + key + '"', field: 'key' };
  };

  const validate = (id, key, value) => { const d = declOrErr(id, key); if (d.error) return d; const v = validateValue(d.decl, value); return v.error ? v : { ok: true, value: v.value, decl: d.decl }; };

  function setValue(id, key, value) {
    const v = validate(id, key, value); if (v.error) return v;
    const r = mutate(st => { wfState(st, id).values[key] = v.value; });
    return r.error ? r : { ok: true, value: v.value };
  }
  function setOverride(id, category, key, value) {
    const v = validate(id, key, value); if (v.error) return v;
    if (typeof category !== 'string' || !categoryKeys().includes(category)) return { error: 'unknown category "' + category + '"', field: 'category' };
    const r = mutate(st => { const w = wfState(st, id); (w.overrides[category] || (w.overrides[category] = {}))[key] = v.value; });
    return r.error ? r : { ok: true, value: v.value };
  }
  function clearOverride(id, category, key) {
    const d = declOrErr(id, key); if (d.error) return d;
    if (typeof category !== 'string' || !categoryKeys().includes(category)) return { error: 'unknown category "' + category + '"', field: 'category' };
    const rd = read(); const badRd = unusable(rd); if (badRd) return badRd;   // a corrupt store refuses even when there would be nothing to remove
    const cur = rd.state.workflows[id];
    if (!cur || !cur.overrides[category] || !(key in cur.overrides[category])) return { ok: true };   // nothing to remove: no write
    const r = mutate(st => {
      const w = st.workflows[id];
      if (!w || !w.overrides[category]) return;
      delete w.overrides[category][key];
      if (!Object.keys(w.overrides[category]).length) delete w.overrides[category];
    });
    return r.error ? r : { ok: true };
  }
  /** overridesFor(id) → [{category, key, value}] - only for categories the palette still has. */
  function overridesFor(id) {
    const w = read().state.workflows[id];
    const decls = declaredFor(id, true);
    const cats = categoryKeys();
    const out = [];
    if (!w) return out;
    for (const [category, kv] of Object.entries(w.overrides)) {
      if (!cats.includes(category)) continue;
      for (const [key, raw] of Object.entries(kv)) {
        const d = decls.find(x => x.key === key); const val = d ? stored(d, raw) : undefined;
        if (val !== undefined) out.push({ category, key, value: val });
      }
    }
    return out;
  }
  function reset(id) {
    if (!entryOf(id)) return { error: 'unknown workflow', field: 'id', notFound: true };
    const r = mutate(st => { delete st.workflows[id]; delete st.seed[id]; });
    return r.error ? r : { ok: true };
  }

  // seed lock: per workflow, only for an entry that has a seed slot
  function getSeed(id) { const s = read().state.seed[id]; return s ? { locked: s.locked, value: s.value } : { locked: false, value: null }; }
  function setSeed(id, locked, value) {
    const e = entryOf(id);
    if (!e) return { error: 'unknown workflow', field: 'id', notFound: true };
    if (!isObj(e.nodes) || e.nodes.seed == null) return { error: 'this workflow has no seed', field: 'seed' };
    if (typeof locked !== 'boolean') return { error: 'locked must be true or false', field: 'locked' };
    const hasVal = value !== undefined && value !== null;
    if (hasVal && (!Number.isInteger(value) || value < 0 || value > MAX_SEED)) return { error: 'seed must be an integer 0-' + MAX_SEED, field: 'value' };
    if (locked && !hasVal && getSeed(id).value == null) return { error: 'a locked seed needs a value', field: 'value' };
    const r = mutate(st => { const prev = st.seed[id] || { locked: false, value: null }; st.seed[id] = { locked, value: hasVal ? value : prev.value }; });
    return r.error ? r : Object.assign({ ok: true }, getSeed(id));
  }
  /** lockedSeed(id) → the locked seed, or null (random). */
  function lockedSeed(id) { const s = getSeed(id); return (s.locked && Number.isInteger(s.value)) ? s.value : null; }

  const defOf = (d) => ({
    key: d.key, label: d.label || d.key, type: d.type, min: d.min != null ? d.min : null, max: d.max != null ? d.max : null, step: d.step != null ? d.step : null,
    options: Array.isArray(d.options) ? d.options.slice() : null, presets: d.type === 'size' ? SIZE_PRESETS.map(p => ({ label: p.label, w: p.w, h: p.h })) : null,
  });

  /** view(id) → the GET /workflows/params payload (sampler options are added by the caller: they come from ComfyUI). */
  function view(id) {
    const entry = entryOf(id);
    if (!entry) return null;
    const res = resolve(id, null);
    const ovs = overridesFor(id);
    const params = declaredFor(id, true).map(d => {
      const r = res[d.key];
      return Object.assign(defOf(d), {
        scope: d.scope || null,
        value: r ? r.workflowValue : null, default: r ? r.default : null,
        overrides: ovs.filter(o => o.key === d.key).map(o => ({ category: o.category, value: o.value })),
      });
    });
    const hasSeed = isObj(entry.nodes) && entry.nodes.seed != null;
    return { params, categories: categoryKeys(), seed: hasSeed ? getSeed(id) : null };
  }

  // The palette view: the declared params of the ACTIVE image and mesh workflows, per category.
  function paletteView(cfg) {
    const out = { paramSource: { image: null, mesh: null }, defs: {}, params: {} };
    const cats = categoryKeys();
    for (const c of cats) out.params[c] = {};
    for (const stage of ['image', 'mesh']) {
      let act; try { act = workflows.getActive(stage, cfg || {}); } catch (_) { act = null; }
      if (!act) continue;
      out.paramSource[stage] = act.id;
      const entry = entryOf(act.id) || act;
      const decls = declaredOf(entry, false);
      const base = resolve(act.id, null);
      for (const d of decls) {
        if (!out.defs[d.key]) out.defs[d.key] = Object.assign(defOf(d), { workflow: act.id, workflowLabel: entry.label || act.id, stage, value: base[d.key] ? base[d.key].workflowValue : null });
      }
      for (const c of cats) {
        const res = resolve(act.id, c);
        for (const d of decls) {
          const r = res[d.key];
          if (r) out.params[c][d.key] = { value: r.value, overridden: r.source.indexOf('override:') === 0, workflow: act.id, workflowValue: r.workflowValue };
        }
      }
    }
    return out;
  }

  // /palette/reset of ONE category: only that category's overrides for the palette-derived keys change - to what contract 3's seeding gives for
  // it from DEFAULT_PALETTE (an override when its value differs from the workflow value, none when equal). Workflow values and every other
  // category's overrides stay. Only the workflows the palette numbers belong to (flux_klein cfg/steps, trellis2 faces) are seeded, and only
  // when active; any other active workflow (z-image ...) is untouched - the Flux palette numbers never reach it.
  function resetCategory(category, defaults, activeIds) {
    return mutate(st => {
      for (const id of activeIds) {
        const entry = entryOf(id);
        if (!MIGRATION[id] || !entry) continue;
        const decls = declaredOf(entry, false);
        const w = wfState(st, id);
        for (const key of MIGRATION[id]) {
          const decl = decls.find(d => d.key === key); if (!decl) continue;
          if (w.overrides[category]) { delete w.overrides[category][key]; if (!Object.keys(w.overrides[category]).length) delete w.overrides[category]; }
          if (!defaults || defaults[key] === undefined || !validateValue(decl, defaults[key]).ok) continue;
          const wv = stored(decl, w.values[key]); const base = wv !== undefined ? wv : defaultOf(entry, decl);
          if (base !== null && !sameVal(base, defaults[key])) (w.overrides[category] || (w.overrides[category] = {}))[key] = defaults[key];
        }
      }
    });
  }

  return {
    file: FILE, declared: (id) => declaredFor(id, false), declaredAll: (id) => declaredFor(id, true),
    effective, resolve, run, setValue, setOverride, clearOverride, overridesFor, reset, validate,
    getSeed, setSeed, lockedSeed, view, paletteView, resetCategory, categoryKeys,
  };
}

const defaultStore = createStore();
module.exports = Object.assign({
  createStore, SIZE_PRESETS, SIZE_MIN, SIZE_MAX, SIZE_STEP, MAX_SEED, PALETTE_KEYS, DEFAULT_FILE,
  declaredOf, defaultOf, validateValue, clampValue, applyToGraph, describeRun, fmtValue,
}, defaultStore);
