'use strict';
// remesh-store.js — what must survive a Phoenix restart about PAID Meshy work (sweep 3b/3c/3e).
//   tasks:   key -> { taskId, at }   a Meshy task that exists (created, maybe finished) but whose GLB is not yet written to staging.
//   intents: key -> at               "a create POST was (or may have been) sent for this content": written BEFORE the POST, replaced by the task record when the
//                                    task id arrives, cleared when the failure proves nothing was sent. An UNRESOLVED intent (e.g. Phoenix died mid-POST,
//                                    a timeout, a 5xx) blocks automatic resubmission of that key - it may have been charged.
//   key = sha256(the bytes that are uploaded) + normalised params, so a CHANGED file never reuses an old task / intent.
// File: session/remesh-tasks.json (override: PHOENIX_REMESH_STORE - tests). Written atomically (tmp + rename). It holds task ids and times ONLY:
// never the API key, never the uploaded data, never a download link. Records older than 3 days are swept on every read and write; the store is capped at
// 200 entries IN TOTAL (tasks + intents). The cap only ever drops intents older than the 15-minute hold; when it cannot make room, a NEW record is refused
// (mutators return false) - paid-task records and young intents are never evicted.
// Sweep 3c: an in-process MIRROR of every change is consulted together with the file; the rename is retried briefly; a failed tmp file is removed; each write
// re-reads the file right before writing and applies only OUR changes; every mutator returns whether it reached the disk.
// Sweep 3e: a file that EXISTS but cannot be read / parsed is NOT an empty store. The last known good snapshot (+ mirror) is used, nothing is ever written on
// top of an unreadable file, and health().unreadable lets the caller refuse NEW paid submissions until the file is fixed.
const fs = require('fs');
const path = require('path');

const KEEP_MS = 3 * 24 * 60 * 60 * 1000;   // Meshy result links live ~3 days
const HOLD_MS = 15 * 60 * 1000;             // an unresolved intent is protected from the cap / the Library override for this long
const MAX_ENTRIES = 200;
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

function file() { return process.env.PHOENIX_REMESH_STORE || path.join(__dirname, 'session', 'remesh-tasks.json'); }

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function clean(j, now) {
  const out = { tasks: {}, intents: {} };
  if (isObj(j) && isObj(j.tasks)) {
    for (const [k, v] of Object.entries(j.tasks)) {
      if (isObj(v) && typeof v.taskId === 'string' && v.taskId.length > 0 && v.taskId.length <= 200 && Number.isFinite(v.at) && now - v.at < KEEP_MS) out.tasks[String(k).slice(0, 300)] = { taskId: v.taskId, at: v.at };
    }
  }
  if (isObj(j) && isObj(j.intents)) {
    for (const [k, v] of Object.entries(j.intents)) if (Number.isFinite(v) && now - v < KEEP_MS) out.intents[String(k).slice(0, 300)] = v;
  }
  // one combined cap of MAX_ENTRIES: the only things the cap may drop are intents that are OLDER than the hold (oldest first). A paid-task record and a young intent
  // are never evicted - if that leaves the store over its capacity, flush() refuses to take on anything NEW (fail closed) instead of silently forgetting paid work.
  const over0 = Object.keys(out.tasks).length + Object.keys(out.intents).length - MAX_ENTRIES;
  if (over0 > 0) {
    const old = Object.entries(out.intents).filter(([, v]) => now - v >= HOLD_MS).sort((x, y) => x[1] - y[1]);
    for (let i = 0; i < Math.min(over0, old.length); i++) delete out.intents[old[i][0]];
  }
  return out;
}

// our own changes that the file may not have yet: set (key -> value) and deleted (key) per section
const mem = { tasks: {}, intents: {}, delTasks: new Set(), delIntents: new Set() };
const memEmpty = () => !Object.keys(mem.tasks).length && !Object.keys(mem.intents).length && !mem.delTasks.size && !mem.delIntents.size;
function resetMem() { mem.tasks = {}; mem.intents = {}; mem.delTasks.clear(); mem.delIntents.clear(); }

let lastGood = { tasks: {}, intents: {} };   // the last snapshot that was read successfully (or written)
let unreadable = false;

// -> { j, ok }. ENOENT = an empty store (fine). Any other failure (locked, permission, bad JSON) = NOT empty: ok:false.
function readFile() {
  let txt;
  try { txt = fs.readFileSync(file(), 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return { j: null, ok: true }; return { j: null, ok: false }; }
  try { return { j: JSON.parse(txt), ok: true }; } catch (_) { return { j: null, ok: false }; }
}
// base (file, or the last good snapshot when the file is unreadable) with our unsaved changes applied on top
function overlay(rf, now) {
  let db;
  if (rf.ok) { db = clean(rf.j, now); lastGood = db; unreadable = false; }
  else { db = clean(lastGood, now); unreadable = true; }
  db = JSON.parse(JSON.stringify(db));
  for (const [k, v] of Object.entries(mem.tasks)) db.tasks[k] = v;
  for (const k of mem.delTasks) delete db.tasks[k];
  for (const [k, v] of Object.entries(mem.intents)) db.intents[k] = v;
  for (const k of mem.delIntents) delete db.intents[k];
  return clean(db, now);
}
const read = (now = Date.now()) => overlay(readFile(), now);

function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } } }

// write the file = (fresh read) + overlay of our changes. true = it reached the disk. NEVER writes on top of an unreadable file.
function flush() {
  const f = file();
  const tmp = f + '.tmp-' + process.pid;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const rf = readFile();   // re-read immediately before writing, then apply only our changes
    if (!rf.ok) { overlay(rf, Date.now()); return false; }   // keep the mirror, write nothing
    const db = overlay(rf, Date.now());
    // Fail closed: a mutator may only answer true when what it just recorded really is in the file. Over capacity, or one of OUR new records lost to the cleanup,
    // means the change is NOT secured: nothing is written and the caller (which then refuses the paid submission) gets false.
    const total = Object.keys(db.tasks).length + Object.keys(db.intents).length;
    const lost = Object.keys(mem.tasks).some(k => !db.tasks[k]) || Object.keys(mem.intents).some(k => db.intents[k] === undefined);
    if (total > MAX_ENTRIES || lost) return false;
    fs.writeFileSync(tmp, JSON.stringify(db));
    let lastErr = null;
    // at most 3 tries with 15 / 30 ms waits between them (~45 ms of synchronous waiting): this runs on the server's main thread, so a persistently locked file
    // must not stall every request. What does not get written now stays in the mirror and goes out with the next flush.
    for (let i = 0; i < 3; i++) {
      try { fs.renameSync(tmp, f); lastErr = null; break; }
      catch (e) { lastErr = e; if (!(e && TRANSIENT.has(e.code))) break; if (i < 2) sleepMs(15 * Math.pow(2, i)); }
    }
    if (lastErr) throw lastErr;
    resetMem();   // the file has everything now
    lastGood = db;
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) { /* nothing to remove */ }
    return false;   // a store that cannot be written must never break a remesh - the mirror keeps this session safe and the caller tells the user
  }
}

function change(apply) {
  apply();
  return flush();
}

module.exports = {
  getTask: (key) => read().tasks[key] || null,
  setTask: (key, rec) => change(() => { mem.delTasks.delete(key); mem.tasks[key] = { taskId: String(rec.taskId), at: Number.isFinite(rec.at) ? rec.at : Date.now() }; }),
  delTask: (key) => change(() => { delete mem.tasks[key]; mem.delTasks.add(key); }),
  getIntent: (key) => { const v = read().intents[key]; return v === undefined ? null : v; },
  setIntent: (key, at) => change(() => { mem.delIntents.delete(key); mem.intents[key] = Number.isFinite(at) ? at : Date.now(); }),
  delIntent: (key) => change(() => { delete mem.intents[key]; mem.delIntents.add(key); }),
  // the task id arrived: record the task and resolve the intent in ONE write
  taskReplacesIntent: (key, rec) => change(() => { mem.delTasks.delete(key); mem.tasks[key] = { taskId: String(rec.taskId), at: Number.isFinite(rec.at) ? rec.at : Date.now() }; delete mem.intents[key]; mem.delIntents.add(key); }),
  // { unreadable }: the file exists but cannot be read / parsed - NEW paid submissions must be refused until it is fixed
  health: () => { read(); return { unreadable }; },
  clear: () => { resetMem(); lastGood = { tasks: {}, intents: {} }; unreadable = false; const f = file(); const tmp = f + '.tmp-' + process.pid; try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify({ tasks: {}, intents: {} })); fs.renameSync(tmp, f); } catch (_) { try { fs.unlinkSync(tmp); } catch (__) { /* gone */ } } },
  pendingUnsaved: () => !memEmpty(),
  _file: file, KEEP_MS, HOLD_MS, MAX_ENTRIES,
};
