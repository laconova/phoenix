'use strict';
// F2.5: one brush save at a time. save_brush.js (the CLI) takes this lock before it writes anything; library-trash (trashBrush,
// a brush restore, empty) and the assistant's rename run inside withLock(). The lock is a file in the brushes folder:
//   <brushes>/.save.lock = {"pid":<n>,"at":<ms>,"token":"<hex>"}   created exclusively ('wx').
// A parsed lock is stale when its pid is dead or it is older than 10 min. A file that does not parse (between create and write,
// or torn) is NOT stale until its mtime is older than GRACE_MS. release() deletes only a lock that still holds OUR token.
// Removing a stale lock: the contender renames the lock to <lock>.<random> (atomic; only one contender wins the rename), reads what it
// took and unlinks it only when it is exactly the content it judged stale. If it took a fresh owner's lock instead, it puts it back.
// acquire() re-reads its own lock after 15 ms, so an owner whose lock is briefly away during a put-back gives way instead of
// double-owning. Crashed locks still clear by themselves (dead pid / old / torn + grace).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bto = require('./brush-to-unreal');

const STALE_MS = 10 * 60 * 1000;
const GRACE_MS = 10000;
const SAVE_RUNNING = 'A brush save is running — try again when it has finished.';
const lockPath = () => path.join(bto.brushesDir(), '.save.lock');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// -> { state: 'none' } | { state: 'torn', raw, age } | { state: 'ok', raw, h: { pid, at, token } }
function inspect() {
  const file = lockPath();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { state: 'none' }; }
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && Number.isInteger(Number(o.pid)) && Number.isFinite(Number(o.at))) {
      return { state: 'ok', raw, h: { pid: Number(o.pid), at: Number(o.at), token: typeof o.token === 'string' ? o.token : '' } };
    }
  } catch (_) { /* torn: handled below */ }
  let age = Infinity;
  try { age = Date.now() - fs.statSync(file).mtimeMs; } catch (_) { return { state: 'none' }; }
  return { state: 'torn', raw, age };
}
function read() { const s = inspect(); return s.state === 'ok' ? s.h : null; }
const staleHolder = (h) => !h || !alive(h.pid) || !(Date.now() - h.at < STALE_MS);
const staleState = (s) => s.state === 'ok' ? staleHolder(s.h) : s.state === 'torn' ? s.age > GRACE_MS : false;

// judgedRaw = the lock content the caller judged stale. true = that lock is gone and the caller may try to create it; false = not removed.
function removeStale(judgedRaw) {
  const file = lockPath();
  const moved = file + '.' + crypto.randomBytes(6).toString('hex');
  try { fs.renameSync(file, moved); } catch (_) { return false; } // ENOENT: someone else got it
  let got = null;
  try { got = fs.readFileSync(moved, 'utf8'); } catch (_) { /* unreadable: treated as different below */ }
  if (got === judgedRaw) { try { fs.unlinkSync(moved); } catch (_) { /* already gone */ } return true; }
  // We took a fresh owner's lock: put it back.
  try { fs.linkSync(moved, file); fs.unlinkSync(moved); }
  catch (e) {
    if (e.code === 'EEXIST') { try { fs.unlinkSync(moved); } catch (_) {} }  // a newer lock is there
    else { try { fs.renameSync(moved, file); } catch (_) { try { fs.unlinkSync(moved); } catch (_) {} } } // no hard links on this volume
  }
  return false;
}
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* no wait available */ } };

function acquire() {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token })); }
      catch (e) { try { fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(file); } catch (_) {} throw e; }
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return; released = true;
        const h = read();
        if (h && h.token === token) { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } }
      };
      // A contender's put-back may be under way: if the file no longer holds our token, we do not own it.
      pause(15);
      const again = read();
      if (!again || again.token !== token) { release(); return { ok: false, holder: again }; }
      return { ok: true, token, release };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, holder: null, reason: 'The brush lock could not be taken (' + (e.code || 'error') + (e.message ? ': ' + e.message : '') + ').' }; // M2 MINOR 6: a refusal, never a throw
      const s = inspect();
      if (s.state === 'none') continue;
      if (!staleState(s)) return { ok: false, holder: s.state === 'ok' ? s.h : null };
      removeStale(s.raw); // false counts as an attempt
    }
  }
  return { ok: false, holder: read() };
}
// the holder when ANOTHER live process holds the lock, else null (our own process never blocks itself)
function held() {
  const h = read();
  if (!h || staleHolder(h) || h.pid === process.pid) return null;
  return h;
}
// Run fn (SYNC) under the lock. Refused → { ok:false, error: SAVE_RUNNING } (or the plain-text reason when the lock file could not be touched at all).
function withLock(fn) {
  const l = acquire();
  if (!l.ok) return { ok: false, error: l.reason || SAVE_RUNNING };
  try { return fn(); } finally { l.release(); }
}
module.exports = { lockPath, acquire, removeStale, inspect, held, withLock, SAVE_RUNNING, GRACE_MS, STALE_MS };
