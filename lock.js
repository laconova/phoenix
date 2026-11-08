'use strict';
let held = false;
let label = null;               // what the holder is doing (for the busy message); null = unlabelled
const waiters = [];
const GENERATION = 'a generation';   // label of a lock-based generation (server.js tells it from other holders)
function tryAcquire(what) {    // non-blocking: server turns. true = acquired, false = busy
  if (held) return false;
  held = true;
  label = what || null;
  return true;
}
function acquire(what) {       // blocking: the background import tail. resolves when the lock is held by caller
  if (!held) { held = true; label = what || null; return Promise.resolve(); }
  return new Promise(resolve => waiters.push({ resolve, label: what || null }));
}
function release() {           // hand off to next waiter, or free
  const next = waiters.shift();
  if (next) { label = next.label; next.resolve(); }   // lock STAYS held, handed to the waiter (with its label)
  else { held = false; label = null; }
}
function isHeld() { return held; }
function holder() { return held ? label : null; }
function relabel(what) { if (held) label = what || null; }   // the holder changes what it says it does (a generation inside a turn); a free lock stays unlabelled
module.exports = { tryAcquire, acquire, release, isHeld, holder, relabel, GENERATION };
