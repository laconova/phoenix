'use strict';

// ─── storyboard.js — the storyboards: shots as timeline events (v1.10 V1 + V1b-1) ──────────────────
// V1b-1: SEVERAL boards. session/storyboards/<boardId>.json (one file per board, boardId = 6 x [a-z0-9]) plus
// _index.json = { version:1, active, order:[ids] }. A board = { version:4, id, title, group, aspect, cast, shots }.
// A shot = { id, start_s, duration_s, image(=keyframe), prompt(=what happens), title, refs, camera, lines, sound, clip }.
// SB3: a shot has SEVERAL dialogue lines, lines = [ {lid, speaker, line, take, gap_s} ] (max 8); a cast member = {name, engine, voice, reference}.
// A v2 board (shot.dialogue, cast {name,voice}) is READ as v3 (pure, no write); the first v3 write in a store that still has v2 files copies
// every board file once into _backup-v2-<stamp>/ (nothing deleted).
// R6: version 4 adds shot.camera.tags (own tags, max 8 per shot) + the shared tag list _tags.json; the first v4 write in a store that still has
// v3 files copies them once into _backup-v3-<stamp>/ (same pattern). A v3 board is READ as v4 (pure, no write).
// Shots are contiguous: start_s is recomputed on EVERY write. Images are LINKED by their path relative to the
// Phoenix root, never copied. No function here throws.
// Per-file rule of V1 (Amendment 1) applies to EVERY board file and to _index.json: a file that was not read cleanly
// is never written over (malformed -> renamed .bad-<stamp> first; unreadable -> nothing changes, UNREADABLE, HTTP 409).
// The V1 single file (session/storyboard.json) is MIGRATED once into board 1 and then renamed .migrated-<stamp> (never deleted).

const fs   = require('fs');
const path = require('path');
const servable = require('./servable');

const ROOT = __dirname;
// The V1 file: migration source only (kept as STORYBOARD_FILE export for compatibility).
const STORYBOARD_FILE = process.env.PHOENIX_STORYBOARD_FILE || path.join(ROOT, 'session', 'storyboard.json');
// Boards folder. If only the legacy file is redirected (old test setups), the folder sits next to it - never in the real session/.
const STORYBOARD_DIR = process.env.PHOENIX_STORYBOARD_DIR
  || (process.env.PHOENIX_STORYBOARD_FILE ? path.join(path.dirname(process.env.PHOENIX_STORYBOARD_FILE), 'storyboards') : path.join(ROOT, 'session', 'storyboards'));
const INDEX_FILE = path.join(STORYBOARD_DIR, '_index.json');
const TRASH_DIR  = path.join(STORYBOARD_DIR, '_trash');

const PROMPT_MAX = 2000;
const MAX_SHOTS  = 60;
const MAX_BOARDS = 50;
const MAX_REFS   = 6;
const TITLE_MAX = 80, GROUP_MAX = 60, SHOT_TITLE_MAX = 80, FREE_MAX = 300, LINE_MAX = 500, SOUND_MAX = 300, LABEL_MAX = 80, NAME_MAX = 60;
const MAX_CAST = 12;
const MAX_LINES = 8, GAP_MAX = 5;
const ENGINES = ['crispasr', 'chatterbox'];
const BACKUP_FAILED = 'could not back up the old boards — nothing was changed';
const DUR_MIN = 1, DUR_MAX = 15, DUR_DEFAULT = 5;
const ASPECTS = ['16:9', '9:16', '1:1'];
const ROLES = ['character', 'set', 'prop'];
const CAMERA_ENUMS = {
  size:  ['', 'wide', 'medium', 'close', 'extreme-close'],
  angle: ['', 'eye', 'low', 'high', 'birds-eye'],
  move:  ['', 'static', 'push-in', 'orbit', 'handheld', 'tilt'],
};
// preset -> prompt text, the ONE table compilePrompt reads
const CAMERA_TEXT = {
  size:  { wide: 'Wide shot', medium: 'Medium shot', close: 'Close-up', 'extreme-close': 'Extreme close-up' },
  angle: { eye: 'eye-level angle', low: 'low angle', high: 'high angle', 'birds-eye': "bird's-eye view" },
  move:  { static: 'static camera', 'push-in': 'slow push-in', orbit: 'slow orbit around the subject', handheld: 'handheld camera', tilt: 'slow tilt' },
};
const COMPILED_MAX = 1000;
const TAG_MAX = 40, TAGS_PER_SHOT = 8, TAGS_MAX = 50;
const TAGS_FILE = path.join(STORYBOARD_DIR, '_tags.json');

const SAVE_FAILED = 'could not save the storyboard — nothing was changed';
const UNREADABLE = 'storyboard file could not be read — nothing was changed';
const UNKNOWN_BOARD = 'unknown board';
const UNDO_GONE = 'nothing to undo — the board changed since the shot was removed';

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// Strict: finite numbers and non-empty numeric strings only; everything else (arrays, objects, booleans, '', null) -> default.
function normDuration(d) {
  let n;
  if (typeof d === 'number') n = d;
  else if (typeof d === 'string' && NUMERIC.test(d.trim())) n = Number(d.trim());
  else return DUR_DEFAULT;
  if (!isFinite(n)) return DUR_DEFAULT;
  return Math.min(DUR_MAX, Math.max(DUR_MIN, Math.round(n * 2) / 2));
}

// Inside the Phoenix root → relative with '/'; anywhere else → the string as given.
function normImage(p) {
  if (p == null || p === '') return null;
  const s = String(p);
  const abs = path.resolve(ROOT, s);
  const rel = path.relative(ROOT, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return s;
}

const cut = (t, n) => t == null ? '' : String(t).slice(0, n);
function normPrompt(t) { return cut(t, PROMPT_MAX); }

function newId(shots) {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8) || 'shot';
    if (!shots.some(s => s.id === id)) return id;
  }
}

function retime(board) {
  let t = 0;
  board.shots.forEach(s => { s.start_s = t; t += s.duration_s; });
  return board;
}

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
// F5.3: the LENIENT read keeps fields it does not know (a newer Phoenix wrote them); `extra(o, known)` = o without the fields this version owns, merged UNDER the normalised known ones.
const extra = (o, known) => { const r = {}; if (isObj(o)) Object.keys(o).forEach(k => { if (!known.includes(k)) r[k] = o[k]; }); return r; };
const K_BOARD = ['version', 'id', 'title', 'group', 'aspect', 'cast', 'migrated_from', 'shots', 'error', 'warning'];
const K_SHOT = ['id', 'start_s', 'duration_s', 'image', 'prompt', 'title', 'refs', 'camera', 'lines', 'sound', 'clip', 'dialogue'];
const K_CAMERA = ['size', 'angle', 'move', 'free', 'tags'];
const K_LINE = ['lid', 'speaker', 'line', 'take', 'gap_s'];
const K_SOUND = ['text', 'clip'];
const K_CLIP = ['path', 'backend', 'made_at', 'muted'];
const K_CAST = ['name', 'engine', 'voice', 'reference'];
const stamp = () => new Date().toISOString().replace(/[^0-9]/g, '');

// ── shot v2 normalising (LENIENT: used when reading a file; nothing is rejected, bad values fall back to defaults) ──
// Reading is lossless: an object entry is kept whole (unknown keys too) with role/path/label filled in; only non-objects are dropped.
// a reference's stable id (rid): short random, unique within its shot, assigned on add, kept through updates, filled in when a stored ref has none
const RID = /^[a-z0-9]{1,12}$/;
function newRid(refs) { for (;;) { const id = Math.random().toString(36).slice(2, 7) || 'r'; if (!refs.some(x => x && x.rid === id)) return id; } }
function ridsOf(refs, det) {   // det: reading a stored board - missing ids are 'r'+index (skipping taken ones), the same on every read   // keeps a valid unique rid, gives every other ref a fresh one (order preserved)
  const seen = new Set();
  refs.forEach(r => { if (typeof r.rid === 'string' && RID.test(r.rid) && !seen.has(r.rid)) seen.add(r.rid); else delete r.rid; });
  refs.forEach(r => { if (!r.rid) { if (det) { let k = refs.indexOf(r); while (refs.some(x => x.rid === 'r' + k)) k++; r.rid = 'r' + k; } else r.rid = newRid(refs); } });
  return refs;
}
function normRef(r) {
  if (!isObj(r)) return null;
  return Object.assign({}, r, { role: ROLES.includes(r.role) ? r.role : 'prop', path: typeof r.path === 'string' ? (normImage(r.path) || '') : '', label: cut(r.label, LABEL_MAX) });
}
// own camera tags, LENIENT read: strings only, trimmed, cut to TAG_MAX, non-empty, de-duplicated case-insensitively (first wins). An over-long hand-edited list is kept whole.
function normTags(list) {
  const out = [], seen = new Set();
  (Array.isArray(list) ? list : []).forEach(t => {
    if (typeof t !== 'string') return;
    const v = t.trim().slice(0, TAG_MAX).trim(), key = v.toLowerCase();
    if (!v || seen.has(key)) return;
    seen.add(key); out.push(v);
  });
  return out;
}
function normCamera(c) {
  const o = isObj(c) ? c : {};
  const pick = (k) => (typeof o[k] === 'string' && CAMERA_ENUMS[k].includes(o[k])) ? o[k] : '';
  return Object.assign(extra(o, K_CAMERA), { size: pick('size'), angle: pick('angle'), move: pick('move'), free: cut(o.free, FREE_MAX), tags: normTags(o.tags) });
}
function normTake(t) { return (typeof t === 'string' && t.startsWith('/vo/') && !t.includes('..') && t.length <= 200) ? t : null; }
// SB3 dialogue lines. LENIENT read: bad values fall back (gap clamped to 0..5, lid filled in deterministically so a read is pure and stable).
function gapLenient(g) {
  let n;
  if (typeof g === 'number') n = g; else if (typeof g === 'string' && NUMERIC.test(g.trim())) n = Number(g.trim()); else return 0;
  return isFinite(n) ? Math.min(GAP_MAX, Math.max(0, n)) : 0;
}
function normLine(l) {
  const o = isObj(l) ? l : {};
  return Object.assign(extra(o, K_LINE), { lid: (typeof o.lid === 'string' && RID.test(o.lid)) ? o.lid : '', speaker: cut(o.speaker, NAME_MAX), line: cut(o.line, LINE_MAX), take: normTake(o.take), gap_s: gapLenient(o.gap_s) });
}
function lidsOf(lines, det) {   // keeps a valid unique lid; every other line gets one (reading: 'l'+index, the same on every read)
  const seen = new Set();
  lines.forEach(l => { if (l.lid && !seen.has(l.lid)) seen.add(l.lid); else l.lid = ''; });
  lines.forEach((l, i) => {
    if (l.lid) return;
    if (det) { let k = i; while (seen.has('l' + k)) k++; l.lid = 'l' + k; }
    else { for (;;) { const id = 'l' + Math.random().toString(36).slice(2, 6); if (!seen.has(id)) { l.lid = id; break; } } }
    seen.add(l.lid);
  });
  return lines;
}
// v2 -> v3: a dialogue with any non-empty field becomes the one line, else no lines
function linesOfShot(s) {
  if (Array.isArray(s.lines)) return lidsOf(s.lines.filter(isObj).map(normLine), true);   // an over-cap hand-edited list is kept whole; only updateShot refuses
  const d = isObj(s.dialogue) ? s.dialogue : null;
  if (!d) return [];
  const l = normLine({ speaker: d.speaker, line: d.line, take: d.take });
  const any = l.speaker || l.line || l.take || cut(d.voice, NAME_MAX);
  return any ? lidsOf([l], true) : [];
}
function normSoundClip(c) { return (typeof c === 'string' && c && c.length <= 200 && !/[\\/]/.test(c)) ? c : null; }
function normSound(s) { const o = isObj(s) ? s : {}; return Object.assign(extra(o, K_SOUND), { text: cut(o.text, SOUND_MAX), clip: normSoundClip(o.clip) }); }
function normClip(c) {
  if (!isObj(c) || typeof c.path !== 'string' || !c.path) return null;
  const out = Object.assign(extra(c, K_CLIP), { path: normImage(c.path), backend: cut(c.backend, NAME_MAX), made_at: typeof c.made_at === 'string' ? c.made_at.slice(0, 40) : '' });
  if (typeof c.muted === 'boolean') out.muted = c.muted;   // LC2f (T9-1): a one-file local clip starts muted or not; absent = the clip has no switch
  return out;
}
function normCast(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(c => {
    if (!isObj(c)) return;
    const name = cut(c.name, NAME_MAX).trim();
    if (!name || out.length >= MAX_CAST || out.some(x => x.name.toLowerCase() === name.toLowerCase())) return;
    out.push(Object.assign(extra(c, K_CAST), { name, engine: (typeof c.engine === 'string' && c.engine) ? cut(c.engine, NAME_MAX) : 'crispasr', voice: cut(c.voice, NAME_MAX), reference: cut(c.reference, 200) }));   // an unknown engine is kept as-is on read
  });
  return out;
}
// an unknown-engine cast row that is identical to the one already stored under that name
function sameStored(c, stored) {
  if (typeof c.engine !== 'string' || !c.engine || ENGINES.includes(c.engine)) return false;
  const n = cut(c.name, NAME_MAX).trim().toLowerCase();
  return (stored || []).some(x => x.name.toLowerCase() === n && x.engine === cut(c.engine, NAME_MAX) && x.voice === cut(c.voice, NAME_MAX) && x.reference === cut(c.reference, 200));
}
// STRICT cast check for writes: a known engine and a plain .wav basename (or ''). Returns an error string or null.
function castError(raw, stored) {
  for (const c of raw) {
    if (!isObj(c)) continue;
    if (sameStored(c, stored)) continue;   // an unknown-engine row exactly as stored is kept as-is (lenient read); a new or changed one is refused below
    if (c.engine !== undefined && !ENGINES.includes(c.engine)) return 'bad cast';
    if (c.voice !== undefined && typeof c.voice !== 'string') return 'bad cast';
    if (c.reference !== undefined) {
      if (typeof c.reference !== 'string') return 'bad cast';
      const r = c.reference;
      if (r && (r !== path.basename(r) || /[\\/]/.test(r) || r.includes('..') || !/\.wav$/i.test(r) || r.length > 200)) return 'bad cast';
    }
  }
  return null;
}
function castForWrite(cast, stored) {   // one engine -> one voice field: a pack for crispasr, a reference for chatterbox; a stored unknown-engine row is kept as-is
  const keepOf = (c) => { const n = c.name.toLowerCase(), o = (stored || []).find(x => x.name.toLowerCase() === n); return o ? extra(o, K_CAST) : {}; };   // F5.3: a stored row's unknown fields stay, the client's never get in
  return cast.map(c => Object.assign(keepOf(c), !ENGINES.includes(c.engine) && sameStored(c, stored) ? { name: c.name, engine: c.engine, voice: c.voice, reference: c.reference } : c.engine === 'chatterbox' ? { name: c.name, engine: 'chatterbox', voice: '', reference: c.reference } : { name: c.name, engine: 'crispasr', voice: c.voice, reference: '' }));
}
function normShot(s, shots) {
  const id = (typeof s.id === 'string' && s.id && !shots.some(x => x.id === s.id)) ? s.id : newId(shots);
  return Object.assign(extra(s, K_SHOT), {
    id, start_s: 0, duration_s: normDuration(s.duration_s),
    image: normImage(s.image), prompt: normPrompt(s.prompt), title: cut(s.title, SHOT_TITLE_MAX),
    refs: ridsOf((Array.isArray(s.refs) ? s.refs : []).map(normRef).filter(Boolean), true),   // an over-cap hand-edited list is kept whole; only updateShot refuses > MAX_REFS
    camera: normCamera(s.camera), lines: linesOfShot(s), sound: normSound(s.sound), clip: normClip(s.clip),
  });
}
function newShot(shots, o) {
  return {
    id: newId(shots), start_s: 0, duration_s: normDuration(o.duration_s),
    image: normImage(o.image), prompt: normPrompt(o.prompt), title: '',
    refs: [], camera: normCamera(null), lines: [], sound: normSound(null), clip: null,
  };
}

// ── files ────────────────────────────────────────────────────────────────────────────────────────────
const BOARD_ID = /^[a-z0-9]{6}$/;
function writeJson(file, obj) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);   // Phoenix is single-process: no inter-process lock, just collision-safe temp names
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return null;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return (e && e.message) || String(e);
  }
}
const boardFile = (id) => path.join(STORYBOARD_DIR, id + '.json');

// Read one JSON file with the V1 rules. -> { state:'missing' } | { state:'ok', json } | { state:'unreadable' } | { state:'bad-renamed' }
function readJsonFile(file, validate) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return (e && e.code === 'ENOENT') ? { state: 'missing' } : { state: 'unreadable' }; }
  try {
    const j = JSON.parse(raw);
    if (!validate(j)) throw new Error('bad shape');
    return { state: 'ok', json: j, raw };
  } catch (_) {
    // Never silently overwrite a file we could not read: keep it next to the original - and only if that worked may we start fresh.
    try { const bad = file + '.bad-' + stamp(); fs.renameSync(file, bad); return { state: 'bad-renamed', bad }; }
    catch (_2) { return { state: 'unreadable' }; }
  }
}

function emptyBoard(id, title) {
  return { version: 4, id: id || '', title: title || 'Storyboard 1', group: '', aspect: '16:9', cast: [], shots: [] };
}
function errBoard(error, id) { const b = emptyBoard(id || ''); b.error = error; return b; }

// Parse a board object (v1, v2, v3 or v4) leniently into the v4 shape. `fallbackTitle` for v1 boards / missing titles.
function parseBoard(j, id, fallbackTitle) {
  const shots = [];
  j.shots.forEach(s => { if (isObj(s)) shots.push(normShot(s, shots)); });
  return retime(Object.assign(extra(j, K_BOARD), {
    version: 4, id,
    title: cut(j.title, TITLE_MAX).trim() || fallbackTitle || 'Storyboard',
    group: cut(j.group, GROUP_MAX).trim(),
    aspect: ASPECTS.includes(j.aspect) ? j.aspect : '16:9',
    cast: normCast(j.cast),
    ...(typeof j.migrated_from === 'string' && j.migrated_from ? { migrated_from: j.migrated_from.slice(0, 40) } : {}),   // marks a board made from the V1 file (retry of a failed archive must not duplicate it)
    shots,   // an over-cap board is kept in full; only addShot refuses
  }));
}
const validBoardJson = (j) => isObj(j) && Array.isArray(j.shots);

// Returns { board, writable }. writable=false: the file exists but was not read cleanly - nothing may be written over it.
// newest <id>.json.bad-<stamp> backup of a board, or null
function newestBad(id) {
  try { const l = fs.readdirSync(STORYBOARD_DIR).filter(f => f.startsWith(id + '.json.bad-')).sort(); return l.length ? path.join(STORYBOARD_DIR, l[l.length - 1]) : null; }
  catch (_) { return null; }
}
function readBoard(id, fallbackTitle) {
  let r = readJsonFile(boardFile(id), validBoardJson);
  // double fault of an earlier call (replacement write AND rollback both failed): the file is gone but an indexed board has a .bad- backup -> recover from it
  if (r.state === 'missing') { const bad = newestBad(id); if (bad) r = { state: 'bad-renamed', bad }; }
  if (r.state === 'ok') return { board: parseBoard(r.json, id, fallbackTitle), writable: true };
  if (r.state === 'unreadable') return { board: errBoard(UNREADABLE, id), writable: false };
  const fresh = emptyBoard(id, fallbackTitle);
  if (r.state === 'bad-renamed') {   // the .bad- copy is kept; the board keeps its id and place
    if (writeJson(boardFile(id), fresh)) {
      // the replacement could not be written: put the malformed file back (the id must not vanish) and report it; a later call retries
      try { fs.renameSync(r.bad, boardFile(id)); } catch (_) {}
      return { board: errBoard(SAVE_FAILED, id), writable: false };
    }
  }
  return { board: fresh, writable: true };   // missing / malformed-and-renamed: start fresh
}
// Non-mutating peek (listing): never renames, never throws. -> board | null
function peekBoard(id, fallbackTitle) {
  try {
    const j = JSON.parse(fs.readFileSync(boardFile(id), 'utf8'));
    return validBoardJson(j) ? parseBoard(j, id, fallbackTitle) : null;
  } catch (_) { return null; }
}

// ── the store: index + folder listing + V1 migration ─────────────────────────────────────────────────
function listBoardIds() {
  try {
    return fs.readdirSync(STORYBOARD_DIR).filter(f => f.endsWith('.json') && BOARD_ID.test(f.slice(0, -5))).map(f => f.slice(0, -5));
  } catch (e) { return (e && e.code === 'ENOENT') ? [] : null; }
}
function mtimeOf(id) { try { return fs.statSync(boardFile(id)).mtimeMs; } catch (_) { return 0; } }
function mergeOrder(order, ids) {
  const out = (Array.isArray(order) ? order : []).filter((x, i, a) => typeof x === 'string' && ids.includes(x) && a.indexOf(x) === i);
  ids.filter(id => !out.includes(id)).sort((a, b) => (mtimeOf(a) - mtimeOf(b)) || (a < b ? -1 : 1)).forEach(id => out.push(id));   // orphans are appended, never lost
  return out;
}

function newBoardId(taken) {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8);
    if (BOARD_ID.test(id) && !taken.includes(id)) return id;
  }
}

const ARCHIVE_FAILED = 'could not archive the V1 storyboard file — it stays where it is and is retried on the next start';
// small checksum of the V1 bytes (storyboard.js requires only fs + path)
function markOf(raw) { let h = 2166136261; for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16) + '-' + raw.length; }
function archiveLegacy() {
  try { fs.renameSync(STORYBOARD_FILE, STORYBOARD_FILE + '.migrated-' + stamp()); return null; }
  catch (_) { return ARCHIVE_FAILED; }
}

// V1 file -> v2 board 1. -> { error } | { migrated:true, warning? } | { migrated:false } (nothing to migrate)
function migrateLegacy() {
  const r = readJsonFile(STORYBOARD_FILE, validBoardJson);
  if (r.state === 'missing' || r.state === 'bad-renamed') return { migrated: false };
  if (r.state === 'unreadable') return { error: UNREADABLE };
  const id = newBoardId([]);
  const board = parseBoard(r.json, id, 'Storyboard 1');
  board.title = 'Storyboard 1';
  board.migrated_from = markOf(r.raw);
  if (writeJson(boardFile(id), board)) return { error: SAVE_FAILED };
  if (writeJson(INDEX_FILE, { version: 1, active: id, order: [id] })) return { error: SAVE_FAILED };
  // a failed archive is NOT "migrated": the V1 bytes stay, the warning is reported, the next start retries (the marker prevents a second board)
  return { migrated: true, warning: archiveLegacy() };
}
// boards exist and a V1 file is still there: if one board carries its marker, only the archive step was missing -> retry it
function retryArchive(ids) {
  let st;
  try { st = fs.statSync(STORYBOARD_FILE); } catch (_) { return null; }
  if (!st || !st.isFile()) return null;
  let raw; try { raw = fs.readFileSync(STORYBOARD_FILE, 'utf8'); } catch (_) { return null; }
  const mark = markOf(raw);
  if (!ids.some(id => { const b = peekBoard(id, ''); return b && b.migrated_from === mark; })) return null;   // an unrelated V1 file next to boards is left alone
  return archiveLegacy();
}

// _index.json must look like { version:1, active:<id>, order:[ids] } (optionally trashed:{id:position}); anything else is backed up as .bad- before any rewrite
function validIndex(j) {
  return isObj(j) && j.version === 1 && typeof j.active === 'string' && BOARD_ID.test(j.active)
    && Array.isArray(j.order) && j.order.every(x => typeof x === 'string' && BOARD_ID.test(x))
    && (j.trashed === undefined || isObj(j.trashed));
}

// -> { ok:true, ids, order, active, trashed, warning? } | { ok:false, error }. Creates board 1 (or migrates V1) when the folder holds none.
// The index is read and validated FIRST: nothing here ever writes _index.json over a file that was not read cleanly.
function openStore() {
  const ix = readJsonFile(INDEX_FILE, validIndex);
  if (ix.state === 'unreadable') return { ok: false, error: UNREADABLE };
  const idx = ix.state === 'ok' ? ix.json : {};
  let ids = listBoardIds();
  if (ids === null) return { ok: false, error: UNREADABLE };
  // an indexed board whose file is missing but whose .bad- backup exists is never dropped (readBoard recovers it)
  ids = ids.concat((idx.order || []).filter(x => !ids.includes(x) && newestBad(x)));
  let use = idx;
  if (!ids.length) {
    const m = migrateLegacy();
    if (m.error) return { ok: false, error: m.error };
    if (!m.migrated) {
      const id = newBoardId([]);
      const e1 = writeJson(boardFile(id), emptyBoard(id, 'Storyboard 1'));
      const e2 = e1 || writeJson(INDEX_FILE, { version: 1, active: id, order: [id] });
      if (e1 || e2) return { ok: false, error: SAVE_FAILED };
    }
    ids = listBoardIds();
    if (!ids || !ids.length) return { ok: false, error: UNREADABLE };
    use = rdIndex() || {};   // the index we just wrote is the truth
  }
  const warning = retryArchive(ids);
  const order = mergeOrder(use.order, ids);
  const active = (typeof use.active === 'string' && order.includes(use.active)) ? use.active : order[0];
  return Object.assign({ ok: true, ids, order, active, trashed: isObj(use.trashed) ? use.trashed : {} }, warning ? { warning } : {});
}
function rdIndex() { try { const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); return validIndex(j) ? j : null; } catch (_) { return null; } }
function saveIndex(order, active, trashed) {
  const j = { version: 1, active, order };
  if (trashed && Object.keys(trashed).length) j.trashed = trashed;
  return writeJson(INDEX_FILE, j);
}

function resolveId(st, boardId) {
  if (boardId == null || boardId === '') return st.active;
  return (typeof boardId === 'string' && st.order.includes(boardId)) ? boardId : null;
}

// The board for reading; an unreadable file gives the empty board with an 'error' field.
function load(boardId) {
  try {
    const st = openStore();
    if (!st.ok) return errBoard(st.error);
    const id = resolveId(st, boardId);
    if (!id) return errBoard(UNKNOWN_BOARD);
    const b = readBoard(id, 'Storyboard ' + (st.order.indexOf(id) + 1)).board;
    if (st.warning) b.warning = st.warning;
    return b;
  } catch (_) { return errBoard(UNREADABLE); }
}

// v2 -> v3 and v3 -> v4 safety nets: ONE algorithm, two folder prefixes. RULE: before a board file whose on-disk version is "old" (v2: neither
// 3 nor 4; v3: exactly 3) is overwritten, a byte copy of it exists in a _backup-v2-* / _backup-v3-* folder. The first backup of a kind holds every
// board file plus _trash/*.json (under _trash/); an old file that shows up later (Undo of a trash, synced in) gets its own copy right before its
// first write. Copied into a .tmp folder and renamed at the end, so a half copy never counts. A failing copy refuses the save. `file` = the board
// file about to be written (null = creating a new board: only the first-backup rule applies). Each kind keeps its own "no old file anywhere"
// fingerprint (per process) so saves need not re-read every file. -> null | error string
const fileIsV = (f, pred) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return isObj(j) && pred(j.version); } catch (_) { return false; } };
const isV2File = (f) => fileIsV(f, v => v !== 3 && v !== 4);
const isV3File = (f) => fileIsV(f, v => v === 3);
function trashFiles() { try { return fs.readdirSync(TRASH_DIR).filter(f => f.endsWith('.json')); } catch (_) { return []; } }
// cheap fingerprint of the board + trash files (names, sizes, mtimes; no reads): a "no old file anywhere" result is only trusted while it is unchanged
function storeSig() {
  try {
    const one = (dir, f) => { try { const s = fs.statSync(path.join(dir, f)); return f + ':' + s.size + ':' + s.mtimeMs; } catch (_) { return f + ':?'; } };
    const bs = fs.readdirSync(STORYBOARD_DIR).filter(f => f.endsWith('.json') && f !== '_index.json' && f !== '_tags.json').sort().map(f => one(STORYBOARD_DIR, f));
    return bs.concat(['|'], trashFiles().sort().map(f => one(TRASH_DIR, f))).join(',');
  } catch (_) { return null; }
}
function makeBackup(prefix, isOld) {
  let noSig = null;   // the store fingerprint at which a scan found no old file (no backup yet)
  const dirsOf = () => { try { return fs.readdirSync(STORYBOARD_DIR).filter(f => f.startsWith(prefix) && !f.endsWith('.tmp')).sort(); } catch (_) { return []; } };
  function copyInto(entries) {   // entries: [[srcFile, relName]] -> null | BACKUP_FAILED
    let dir = path.join(STORYBOARD_DIR, prefix + stamp());
    for (let n = 2; fs.existsSync(dir) || fs.existsSync(dir + '.tmp'); n++) dir = path.join(STORYBOARD_DIR, prefix + stamp() + '-' + n);
    try {
      fs.mkdirSync(dir + '.tmp', { recursive: true });
      for (const [src, rel] of entries) {
        const dst = path.join(dir + '.tmp', rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
      fs.renameSync(dir + '.tmp', dir);
      return null;
    } catch (_) {
      try { fs.rmSync(dir + '.tmp', { recursive: true, force: true }); } catch (_2) {}
      return BACKUP_FAILED;
    }
  }
  function backup(st, file) {
    try {
      const have = dirsOf();
      if (!have.length) {   // no backup yet: look at the WHOLE store (boards and trash), whatever file is about to be written
        const sig = storeSig();
        if (sig !== null && sig === noSig) return null;
        const boards = st.ids.map(boardFile).filter(f => fs.existsSync(f));
        const trash = trashFiles();
        const any = boards.some(isOld) || trash.some(f => isOld(path.join(TRASH_DIR, f))) || (file && fs.existsSync(file) && isOld(file));
        if (!any) { noSig = sig; return null; }
        const entries = boards.map(f => [f, path.basename(f)]);
        trash.forEach(f => entries.push([path.join(TRASH_DIR, f), path.join('_trash', f)]));
        if (file && fs.existsSync(file) && !boards.includes(file)) entries.push([file, path.basename(file)]);
        return copyInto(entries);
      }
      if (!file || !fs.existsSync(file) || !isOld(file)) return null;   // a current file (or none) needs no copy
      const bytes = fs.readFileSync(file);
      const rel = path.basename(file);
      if (have.some(d => { try { return fs.readFileSync(path.join(STORYBOARD_DIR, d, rel)).equals(bytes); } catch (_) { return false; } })) return null;
      return copyInto([[file, rel]]);   // a later old file: its own copy
    } catch (_) { return BACKUP_FAILED; }
  }
  // our own write is not an old file appearing: only the entry of the file we just wrote is refreshed in the trusted fingerprint; every other
  // entry stays as scanned, so any other change (an old file that landed meanwhile) still differs from the next scan and forces a rescan
  function note(file) {
    if (noSig === null) return;
    try {
      const name = path.basename(file), s = fs.statSync(file), entry = name + ':' + s.size + ':' + s.mtimeMs;
      const i = noSig.indexOf(',|');
      const boards = (i >= 0 ? noSig.slice(0, i) : noSig).split(',').filter(Boolean), rest = i >= 0 ? noSig.slice(i) : '';
      const k = boards.findIndex(x => x.slice(0, x.indexOf(':')) === name);
      if (k >= 0) boards[k] = entry; else boards.push(entry);
      boards.sort((a, b) => { const x = a.slice(0, a.indexOf(':')), y = b.slice(0, b.indexOf(':')); return x < y ? -1 : x > y ? 1 : 0; });
      noSig = boards.join(',') + rest;
    } catch (_) { noSig = null; }
  }
  return { backup, note };
}
const v2Backup = makeBackup('_backup-v2-', isV2File), v3Backup = makeBackup('_backup-v3-', isV3File);
const backupV2 = v2Backup.backup, backupV3 = v3Backup.backup;
function noteWritten(file) { v2Backup.note(file); v3Backup.note(file); }

// R6 shot undo: the last removed shot per board, in memory only (Phoenix is one process; every access is synchronous, so there is no interleaving).
// Any other successful write of that board (mutate) and a trash of it forgets the entry.
const removedShots = new Map();   // board id -> { shot, at }
const clone = (x) => JSON.parse(JSON.stringify(x));

// fn(board) mutates and returns null on success or an error string.
function mutate(boardId, fn) {
  try {
    const st = openStore();
    if (!st.ok) return { ok: false, error: st.error };
    const id = resolveId(st, boardId);
    if (!id) return { ok: false, error: UNKNOWN_BOARD };
    const rb = readBoard(id, 'Storyboard ' + (st.order.indexOf(id) + 1));
    if (!rb.writable) return { ok: false, error: rb.board.error || UNREADABLE };
    const bk = backupV2(st, boardFile(id));
    if (bk) return { ok: false, error: bk };
    const bk3 = backupV3(st, boardFile(id));
    if (bk3) return { ok: false, error: bk3 };
    const board = rb.board;
    const err = fn(board);
    if (err) return { ok: false, error: err };
    retime(board);
    if (writeJson(boardFile(id), board)) return { ok: false, error: SAVE_FAILED };   // plain text: no fs message, no paths
    noteWritten(boardFile(id));
    removedShots.delete(id);   // the board changed: an earlier shot Undo is gone (removeShot sets its own entry right after this returns)
    return { ok: true, board };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function isIndex(i, max) { return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i <= max; }

// ── shots ────────────────────────────────────────────────────────────────────────────────────────────
function addShot(boardId, opts) {
  const o = opts || {};
  return mutate(boardId, board => {
    if (board.shots.length >= MAX_SHOTS) return 'storyboard is full (max ' + MAX_SHOTS + ' shots)';
    let idx = board.shots.length;
    if (o.index != null) {
      if (!isIndex(o.index, board.shots.length)) return 'bad index';
      idx = o.index;
    }
    board.shots.splice(idx, 0, newShot(board.shots, o));
    return null;
  });
}

// STRICT patch of one shot (a rejected value writes nothing). Partial objects merge: {camera:{move:'orbit'}} keeps size.
function applyShotPatch(s, p) {
  if (p.refs !== undefined) {
    if (!Array.isArray(p.refs)) return 'bad references';
    if (p.refs.length > MAX_REFS) return 'too many references (max ' + MAX_REFS + ')';
    const refs = [];
    for (const r of p.refs) {
      if (!isObj(r) || typeof r.path !== 'string' || !r.path) return 'bad reference';
      if (!ROLES.includes(r.role)) return 'bad reference role';
      refs.push({ role: r.role, path: normImage(r.path), label: cut(r.label, LABEL_MAX), rid: r.rid });
    }
    s.refs = ridsOf(refs);
  }
  if (p.camera !== undefined) {
    if (!isObj(p.camera)) return 'bad camera value';
    const c = Object.assign({}, s.camera);
    for (const k of Object.keys(CAMERA_ENUMS)) {
      if (p.camera[k] === undefined) continue;
      if (typeof p.camera[k] !== 'string' || !CAMERA_ENUMS[k].includes(p.camera[k])) return 'bad camera value';
      c[k] = p.camera[k];
    }
    if (p.camera.free !== undefined) c.free = cut(p.camera.free, FREE_MAX);
    if (p.camera.tags !== undefined) {   // own tags: <= 8 strings of 1..40 characters (trimmed); stored de-duplicated case-insensitively, in the given order
      if (!Array.isArray(p.camera.tags) || p.camera.tags.length > TAGS_PER_SHOT) return 'bad camera value';
      const tags = [], seen = new Set();
      for (const t of p.camera.tags) {
        if (typeof t !== 'string') return 'bad camera value';
        const v = t.trim();
        if (v.length < 1 || v.length > TAG_MAX) return 'bad camera value';
        if (!seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); tags.push(v); }
      }
      c.tags = tags;
    }
    s.camera = c;
  }
  if (p.lines !== undefined) {   // the WHOLE list (SB3). A line with a known lid keeps its take unless the patch says otherwise; `take` is for trusted callers (the HTTP route strips it)
    if (!Array.isArray(p.lines)) return 'bad lines';
    if (p.lines.length > MAX_LINES) return 'too many lines (max ' + MAX_LINES + ')';
    const prev = new Map((Array.isArray(s.lines) ? s.lines : []).map(l => [l.lid, l]));
    const out = [];
    for (const l of p.lines) {
      if (!isObj(l)) return 'bad line';
      let gap = 0;
      if (l.gap_s !== undefined && l.gap_s !== null) {
        const n = typeof l.gap_s === 'number' ? l.gap_s : (typeof l.gap_s === 'string' && NUMERIC.test(l.gap_s.trim()) ? Number(l.gap_s.trim()) : NaN);
        if (!isFinite(n) || n < 0 || n > GAP_MAX) return 'bad gap (0 to ' + GAP_MAX + ' s)';
        gap = Math.round(n * 10) / 10;
      }
      if (l.speaker !== undefined && typeof l.speaker !== 'string') return 'bad line';
      if (l.line !== undefined && typeof l.line !== 'string') return 'bad line';
      const old = (typeof l.lid === 'string' && prev.has(l.lid)) ? prev.get(l.lid) : null;
      let take = old ? old.take : null;
      if (l.take !== undefined) {
        if (l.take !== null && normTake(l.take) === null) return 'bad line take';
        take = l.take;
      }
      out.push(Object.assign(old ? extra(old, K_LINE) : {}, { lid: (typeof l.lid === 'string' && RID.test(l.lid)) ? l.lid : '', speaker: cut(l.speaker, NAME_MAX), line: cut(l.line, LINE_MAX), take, gap_s: gap }));   // F5.3: the stored line's unknown fields stay, the client's never get in
    }
    s.lines = lidsOf(out, false);
  }
  if (p.sound !== undefined) {
    if (!isObj(p.sound)) return 'bad sound';
    const o = Object.assign({}, s.sound);
    if (p.sound.text !== undefined) o.text = cut(p.sound.text, SOUND_MAX);
    if (p.sound.clip !== undefined) {
      if (p.sound.clip !== null && normSoundClip(p.sound.clip) === null) return 'bad sound clip';
      o.clip = p.sound.clip;
    }
    s.sound = o;
  }
  if (p.clip !== undefined) {   // reserved for V2/V3 backends; trusted callers only
    if (p.clip !== null && normClip(p.clip) === null) return 'bad clip';
    s.clip = p.clip === null ? null : normClip(p.clip);
  }
  if (p.title !== undefined) s.title = cut(p.title, SHOT_TITLE_MAX);
  if (p.prompt !== undefined) s.prompt = normPrompt(p.prompt);
  if (p.duration_s !== undefined) s.duration_s = normDuration(p.duration_s);
  if (p.image !== undefined) s.image = normImage(p.image);
  return null;
}

function updateShot(boardId, id, patch) {
  const p = patch || {};
  return mutate(boardId, board => {
    const s = board.shots.find(x => x.id === id);
    if (!s) return 'unknown shot';
    const draft = JSON.parse(JSON.stringify(s));   // validate on a copy: a rejected field must not leave a half-applied shot
    const err = applyShotPatch(draft, p);
    if (err) return err;
    board.shots[board.shots.indexOf(s)] = draft;
    return null;
  });
}

// Atomic append of ONE line (R6 "+ new line"): reads the lines under the same mutate that writes them, so two sends in a row both survive.
// The caller validates `take` (string '/vo/<file>', file exists); here it is only checked with normTake.
function addLine(boardId, shotId, line) {
  const l = line || {};
  return mutate(boardId, board => {
    const s = board.shots.find(x => x.id === shotId);
    if (!s) return 'unknown shot';
    const cur = Array.isArray(s.lines) ? s.lines : [];
    if (cur.length >= MAX_LINES) return 'too many lines (max ' + MAX_LINES + ')';
    let gap = 0;
    if (l.gap_s !== undefined && l.gap_s !== null) {
      const n = typeof l.gap_s === 'number' ? l.gap_s : (typeof l.gap_s === 'string' && NUMERIC.test(l.gap_s.trim()) ? Number(l.gap_s.trim()) : NaN);
      if (!isFinite(n) || n < 0 || n > GAP_MAX) return 'bad gap (0 to ' + GAP_MAX + ' s)';
      gap = Math.round(n * 10) / 10;
    }
    if (l.speaker !== undefined && typeof l.speaker !== 'string') return 'bad line';
    if (l.line !== undefined && typeof l.line !== 'string') return 'bad line';
    let take = null;
    if (l.take !== undefined && l.take !== null) {
      if (normTake(l.take) === null) return 'bad line take';
      take = l.take;
    }
    const out = cur.map(x => ({ lid: x.lid, speaker: x.speaker, line: x.line, take: x.take, gap_s: x.gap_s }));
    out.push({ lid: '', speaker: cut(l.speaker, NAME_MAX), line: cut(l.line, LINE_MAX), take, gap_s: gap });
    s.lines = lidsOf(out, false);
    return null;
  });
}

// -> { ok, board, removed: <the shot exactly as stored>, at: <its index> }; the removed shot is remembered for restoreShot (this board only)
function removeShot(boardId, id) {
  let gone = null, at = -1;
  const r = mutate(boardId, board => {
    const i = board.shots.findIndex(x => x.id === id);
    if (i < 0) return 'unknown shot';
    gone = clone(board.shots[i]); at = i;
    board.shots.splice(i, 1);
    return null;
  });
  if (!r.ok) return r;
  removedShots.set(r.board.id, { shot: gone, at });
  return Object.assign(r, { removed: clone(gone), at });
}

// Undo of removeShot: only while nothing else was written to the board since, and only for exactly that shot + index. Inserts a copy with ALL
// fields (same id when free, else a new one), start_s is recomputed by mutate. -> { ok, board, restored: <id> }
function restoreShot(boardId, shotId, at) {
  let restored = '';
  const r = mutate(boardId, board => {
    const mem = removedShots.get(board.id);
    if (!mem || typeof shotId !== 'string' || mem.shot.id !== shotId || !Number.isInteger(at) || mem.at !== at) return UNDO_GONE;
    if (board.shots.length >= MAX_SHOTS) return 'storyboard is full (max ' + MAX_SHOTS + ' shots)';
    const copy = clone(mem.shot);
    if (board.shots.some(x => x.id === copy.id)) copy.id = newId(board.shots);
    board.shots.splice(Math.min(at, board.shots.length), 0, copy);
    restored = copy.id;
    return null;
  });
  return r.ok ? Object.assign(r, { restored }) : r;
}

// What Undo can still restore on this board right now: { shot: <removed shot id>, at } or null. Never the shot body.
function pendingUndo(boardId) {
  const mem = removedShots.get(boardId);
  return mem && mem.shot && typeof mem.shot.id === 'string' ? { shot: mem.shot.id, at: mem.at } : null;
}

function moveShot(boardId, id, toIndex) {
  return mutate(boardId, board => {
    const i = board.shots.findIndex(x => x.id === id);
    if (i < 0) return 'unknown shot';
    if (!isIndex(toIndex, board.shots.length - 1)) return 'bad index';
    const [s] = board.shots.splice(i, 1);
    board.shots.splice(toIndex, 0, s);
    return null;
  });
}

// ── boards ───────────────────────────────────────────────────────────────────────────────────────────
function summary(id, order) {
  const b = peekBoard(id, 'Storyboard ' + (order.indexOf(id) + 1));
  if (!b) return { id, title: 'Storyboard ' + (order.indexOf(id) + 1), group: '', shots: 0, total_s: 0, poster: null, error: UNREADABLE };
  const shot = b.shots.find(s => s.image && servable.servableImageError(ROOT, s.image) === '');
  return { id, title: b.title, group: b.group, poster: shot ? '/file?p=' + encodeURIComponent(shot.image) : null, shots: b.shots.length, total_s: b.shots.reduce((t, s) => t + s.duration_s, 0) };
}
// R5b/F4: which boards use these Audio files? files = [{ dir: 'vo'|'sfx', file }] -> [{ board, title, shots: [n, ...] }] (n = 1-based shot number).
// Read-only: every board file in the folder is peeked, nothing is renamed or written.
function usersOfSound(files) {
  const takes = new Set(), clips = new Set();
  (Array.isArray(files) ? files : []).forEach(f => {
    if (!isObj(f) || typeof f.file !== 'string' || !f.file) return;
    if (f.dir === 'vo') takes.add('/vo/' + f.file); else if (f.dir === 'sfx') clips.add(f.file);
  });
  const out = [];
  if (!takes.size && !clips.size) return out;
  (listBoardIds() || []).forEach(id => {
    const b = peekBoard(id, '');
    if (!b) return;
    const shots = [];
    b.shots.forEach((s, i) => {
      const lineHit = (s.lines || []).some(l => l && l.take && takes.has(l.take));
      const clipHit = !!(s.sound && s.sound.clip && clips.has(s.sound.clip));
      if (lineHit || clipHit) shots.push(i + 1);
    });
    if (shots.length) out.push({ board: id, title: b.title, shots });
  });
  return out;
}
function listBoards() {
  try {
    const st = openStore();
    if (!st.ok) return [];
    return st.order.map(id => summary(id, st.order));
  } catch (_) { return []; }
}
function listResult(st, extra) {
  return Object.assign({ ok: true, active: st.active, boards: st.order.map(id => summary(id, st.order)) }, extra || {});
}
function groupsOf(boards) { return Array.from(new Set(boards.map(b => b.group).filter(Boolean))).sort((a, b) => a.localeCompare(b)); }

// { ok, active, boards, groups } | { ok:false, error }
function boardsState() {
  try {
    const st = openStore();
    if (!st.ok) return { ok: false, error: st.error };
    const r = listResult(st);
    r.groups = groupsOf(r.boards);
    return r;
  } catch (_) { return { ok: false, error: UNREADABLE }; }
}

function createBoard(opts) {
  const o = opts || {};
  try {
    const st = openStore();
    if (!st.ok) return { ok: false, error: st.error };
    if (st.order.length >= MAX_BOARDS) return { ok: false, error: 'too many storyboards (max ' + MAX_BOARDS + ')' };
    const id = newBoardId(st.ids.concat(trashedIds()));
    let title = cut(o.title, TITLE_MAX).trim();
    if (!title) {
      const used = st.order.map(x => summary(x, st.order).title);
      let n = st.order.length + 1;
      while (used.includes('Storyboard ' + n)) n++;
      title = 'Storyboard ' + n;
    }
    const bk = backupV2(st);
    if (bk) return { ok: false, error: bk };
    const bk3 = backupV3(st);
    if (bk3) return { ok: false, error: bk3 };
    const b = emptyBoard(id, title);
    b.group = cut(o.group, GROUP_MAX).trim();
    if (writeJson(boardFile(id), b)) return { ok: false, error: SAVE_FAILED };   // board first: a crash leaves an orphan, which is picked up, never lost
    noteWritten(boardFile(id));
    const order = st.order.concat(id);
    if (saveIndex(order, st.active, st.trashed)) return { ok: false, error: SAVE_FAILED };
    return listResult({ order, active: st.active }, { created: id });
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

function updateBoard(id, patch) {
  const p = patch || {};
  if (typeof id !== 'string' || !id) return { ok: false, error: UNKNOWN_BOARD };   // never falls back to the active board
  const r = mutate(id, board => {
    if (p.title !== undefined) { const t = cut(p.title, TITLE_MAX).trim(); if (!t) return 'bad title'; board.title = t; }
    if (p.group !== undefined) board.group = cut(p.group, GROUP_MAX).trim();
    if (p.aspect !== undefined) { if (!ASPECTS.includes(p.aspect)) return 'bad aspect'; board.aspect = p.aspect; }
    if (p.cast !== undefined) {
      if (!Array.isArray(p.cast)) return 'bad cast';
      const cast = normCast(p.cast);
      const named = p.cast.filter(c => isObj(c) && cut(c.name, NAME_MAX).trim());
      if (cast.length !== named.length) return 'bad cast';   // duplicate names / too many: refuse rather than drop silently
      if (castError(p.cast, board.cast)) return 'bad cast';   // unknown engine / a reference that is not a plain .wav name
      board.cast = castForWrite(cast, board.cast);
    }
    return null;
  });
  if (!r.ok) return r;
  const bs = boardsState();
  return bs.ok ? Object.assign(bs, { board: r.board }) : bs;
}

function setActive(id) {
  try {
    const st = openStore();
    if (!st.ok) return { ok: false, error: st.error };
    if (typeof id !== 'string' || !st.order.includes(id)) return { ok: false, error: UNKNOWN_BOARD };
    if (saveIndex(st.order, id, st.trashed)) return { ok: false, error: SAVE_FAILED };
    return listResult({ order: st.order, active: id });
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

function trashedIds() {
  try { return fs.readdirSync(TRASH_DIR).map(f => f.split('-')[0]); } catch (_) { return []; }
}
// Moves the file to _trash/<id>-<stamp>.json; never deletes. The last board cannot be trashed. Its position is kept in the index (Undo puts it back there).
function trashBoard(id) {
  try {
    const st = openStore();
    if (!st.ok) return { ok: false, error: st.error };
    if (typeof id !== 'string' || !st.order.includes(id)) return { ok: false, error: UNKNOWN_BOARD };
    if (st.order.length <= 1) return { ok: false, error: 'the last storyboard cannot be trashed' };
    const rb = readBoard(id, 'Storyboard ' + (st.order.indexOf(id) + 1));   // same read path as every mutation: a malformed file is recovered under the same id first; if that fails nothing is moved
    if (!rb.writable) return { ok: false, error: rb.board.error || UNREADABLE };
    const rj = readJsonFile(boardFile(id), validBoardJson);
    if (rj.state === 'unreadable') return { ok: false, error: UNREADABLE };
    if (rj.state !== 'ok') return { ok: false, error: UNKNOWN_BOARD };
    const name = id + '-' + stamp() + '.json';
    try { fs.mkdirSync(TRASH_DIR, { recursive: true }); fs.renameSync(boardFile(id), path.join(TRASH_DIR, name)); }
    catch (_) { return { ok: false, error: SAVE_FAILED }; }
    const order = st.order.filter(x => x !== id);
    const active = st.active === id ? (order[Math.max(0, st.order.indexOf(id) - 1)] || order[0]) : st.active;
    const trashed = Object.assign({}, st.trashed, { [id]: st.order.indexOf(id) });
    if (saveIndex(order, active, trashed)) {   // the index still lists the board: put the file back so nothing is half-done
      try { fs.renameSync(path.join(TRASH_DIR, name), boardFile(id)); } catch (_) {}
      return { ok: false, error: SAVE_FAILED };
    }
    removedShots.delete(id);   // a trashed board has no shot Undo
    return listResult({ order, active }, { trashed: name });
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
// Undo of trashBoard: the newest _trash/<id>-*.json goes back to its old position in the order. Never overwrites.
function restoreBoard(id) {
  try {
    if (typeof id !== 'string' || !BOARD_ID.test(id)) return { ok: false, error: UNKNOWN_BOARD };
    const st = openStore();
    if (!st.ok) return { ok: false, error: st.error };
    if (st.order.length >= MAX_BOARDS) return { ok: false, error: 'too many storyboards (max ' + MAX_BOARDS + ')' };
    if (st.ids.includes(id)) return { ok: false, error: 'storyboard already exists' };
    let names;
    try { names = fs.readdirSync(TRASH_DIR).filter(f => f.startsWith(id + '-') && f.endsWith('.json')).sort(); } catch (_) { names = []; }
    if (!names.length) return { ok: false, error: UNKNOWN_BOARD };
    const src = path.join(TRASH_DIR, names[names.length - 1]);
    try { fs.renameSync(src, boardFile(id)); }
    catch (_) { return { ok: false, error: SAVE_FAILED }; }
    const undo = () => { try { fs.renameSync(boardFile(id), src); } catch (_) {} };   // index save failed: the file goes back to the trash so an Undo retry works
    const order = st.order.slice();
    const pos = Number.isInteger(st.trashed[id]) ? Math.max(0, Math.min(st.trashed[id], order.length)) : order.length;
    order.splice(pos, 0, id);
    const trashed = Object.assign({}, st.trashed); delete trashed[id];
    if (saveIndex(order, st.active, trashed)) { undo(); return { ok: false, error: SAVE_FAILED }; }
    return listResult({ order, active: st.active });
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// ── the shared own-tag list: <STORYBOARD_DIR>/_tags.json = { version:1, tags:[...] } (<= 50 tags of 1..40 characters) ──
// Every access is synchronous read -> change -> writeJson (unique temp name + rename), so two requests can never interleave on the file.
// -> { ok:true, tags } | { ok:false, error }
function readTags() {
  try {
    const r = readJsonFile(TAGS_FILE, (j) => isObj(j) && Array.isArray(j.tags));
    if (r.state === 'unreadable') return { ok: false, error: UNREADABLE };
    if (r.state !== 'ok') return { ok: true, tags: [] };   // missing, or malformed (kept as .bad-<stamp>) -> the list starts empty
    return { ok: true, tags: normTags(r.json.tags.filter(t => typeof t === 'string' && t.trim().length >= 1 && t.trim().length <= TAG_MAX)).slice(0, TAGS_MAX) };
  } catch (_) { return { ok: false, error: UNREADABLE }; }
}
function listTags() { return readTags(); }
function addTag(tag) {
  if (typeof tag !== 'string' || tag.trim().length < 1 || tag.trim().length > TAG_MAX) return { ok: false, error: 'bad tag (1 to ' + TAG_MAX + ' characters)' };
  const v = tag.trim();
  const r = readTags();
  if (!r.ok) return r;
  if (r.tags.some(t => t.toLowerCase() === v.toLowerCase())) return { ok: true, tags: r.tags };
  if (r.tags.length >= TAGS_MAX) return { ok: false, error: 'too many tags (max ' + TAGS_MAX + ')' };
  const tags = r.tags.concat(v);
  if (writeJson(TAGS_FILE, { version: 1, tags })) return { ok: false, error: SAVE_FAILED };
  return { ok: true, tags };
}
// Removes the case-insensitive match from the list ONLY. Boards are never touched: shots keep their tag text.
function removeTag(tag) {
  if (typeof tag !== 'string') return { ok: false, error: 'bad tag (1 to ' + TAG_MAX + ' characters)' };
  const r = readTags();
  if (!r.ok) return r;
  const key = tag.trim().toLowerCase();
  const tags = r.tags.filter(t => t.toLowerCase() !== key);
  if (tags.length === r.tags.length) return { ok: true, tags: r.tags };
  if (writeJson(TAGS_FILE, { version: 1, tags })) return { ok: false, error: SAVE_FAILED };
  return { ok: true, tags };
}

// ── compilePrompt: pure, deterministic, English, <= 1000 chars ───────────────────────────────────────
function labelsOf(shot, role) {
  return (Array.isArray(shot.refs) ? shot.refs : []).filter(r => r && r.role === role && typeof r.label === 'string' && r.label.trim()).map(r => r.label.trim());
}
function compilePrompt(shot, target) {
  const s = isObj(shot) ? shot : {};
  const c = normCamera(s.camera);
  const prompt = String(s.prompt == null ? '' : s.prompt).trim();
  const sentence = (t) => /[.!?]$/.test(t) ? t : t + '.';
  const size = CAMERA_TEXT.size[c.size] || '', angle = CAMERA_TEXT.angle[c.angle] || '';
  const parts = [];
  if (target === 'video') {
    const free = c.free.trim();
    const move = free ? 'camera: ' + free : (CAMERA_TEXT.move[c.move] ? 'camera ' + CAMERA_TEXT.move[c.move] : '');
    const head = [size, angle, move, ...c.tags].filter(Boolean).join(', ');
    if (head) parts.push(sentence(head));
    if (prompt) parts.push(sentence(prompt));
  } else {   // 'keyframe': a still has no movement - camera move/free are never used
    const head = [size, angle, ...c.tags].filter(Boolean).join(', ');
    if (head && prompt) parts.push(sentence(head + ': ' + prompt));
    else if (head) parts.push(sentence(head));
    else if (prompt) parts.push(sentence(prompt));
    const ch = labelsOf(s, 'character'), se = labelsOf(s, 'set'), pr = labelsOf(s, 'prop');
    if (ch.length) parts.push('Featuring ' + ch.join(', ') + '.');
    if (se.length) parts.push('Setting: ' + se.join(', ') + '.');
    if (pr.length) parts.push('Props: ' + pr.join(', ') + '.');
  }
  return parts.join(' ').slice(0, COMPILED_MAX);
}

module.exports = {
  load, addShot, updateShot, addLine, removeShot, restoreShot, pendingUndo, moveShot, listTags, addTag, removeTag, normTake,
  listBoards, usersOfSound, boardsState, createBoard, updateBoard, setActive, trashBoard, restoreBoard, compilePrompt,
  STORYBOARD_FILE, STORYBOARD_DIR, INDEX_FILE, TRASH_DIR, TAGS_FILE, TAG_MAX, TAGS_PER_SHOT, TAGS_MAX, UNDO_GONE, UNREADABLE, SAVE_FAILED, UNKNOWN_BOARD,
  MAX_SHOTS, MAX_BOARDS, MAX_REFS, MAX_LINES, ENGINES, BACKUP_FAILED, PROMPT_MAX, normImage, CAMERA_ENUMS, CAMERA_TEXT, ROLES, ASPECTS,
};
