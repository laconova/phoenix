'use strict';
let held = false;
const waiters = [];
function tryAcquire() {        // non-blocking: server turns. true = acquired, false = busy
  if (held) return false;
  held = true;
  return true;
}
function acquire() {           // blocking: the background import tail. resolves when the lock is held by caller
  if (!held) { held = true; return Promise.resolve(); }
  return new Promise(resolve => waiters.push(resolve));
}
function release() {           // hand off to next waiter, or free
  const next = waiters.shift();
  if (next) next();           // lock STAYS held, handed to the waiter
  else held = false;
}
function isHeld() { return held; }
module.exports = { tryAcquire, acquire, release, isHeld };
