'use strict';

const fs   = require('fs');
const path = require('path');

// ─── In-process event listener bus ───────────────────────────────────────────

const _listeners = new Set();

function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

// ─── Log directory & stream ───────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, 'logs');

// Stream is created lazily on first write to avoid side effects at require time.
let _stream  = undefined; // undefined = not yet initialised; null = failed
let _enabled = false;

function getStream() {
  if (_stream !== undefined) return _stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `debug-${date}.jsonl`);
    _stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    _stream.on('error', () => { _stream = null; }); // silence stream errors
  } catch {
    _stream = null;
  }
  return _stream;
}

// ─── Control ──────────────────────────────────────────────────────────────────

function initDebug({ enabled = false } = {}) {
  _enabled = !!enabled;
}

function setDebug(on) {
  _enabled = !!on;
}

function isDebug() {
  return _enabled;
}

// ─── Truncation helper ────────────────────────────────────────────────────────

function truncate(v, max = 2000) {
  if (typeof v === 'string') {
    if (v.length > max) return v.slice(0, max) + `…[+${v.length - max}]`;
    return v;
  }
  if (v !== null && (typeof v === 'object' || Array.isArray(v))) {
    const s = JSON.stringify(v);
    if (s.length > max) return s.slice(0, max) + `…[+${s.length - max}]`;
    return s;
  }
  return v;
}

// ─── Core event writer ────────────────────────────────────────────────────────

function event(cat, fields = {}) {
  const rec = { ts: new Date().toISOString(), cat, ...fields };

  // Always persist to file
  try {
    const stream = getStream();
    if (stream) {
      stream.write(JSON.stringify(rec) + '\n');
    }
  } catch { /* never throw */ }

  // Optionally echo to stdout
  if (_enabled) {
    try {
      const hms     = rec.ts.slice(11, 19);
      let compact   = JSON.stringify(fields);
      if (compact.length > 300) compact = compact.slice(0, 300) + '…';
      process.stdout.write(`  \x1b[90m[${hms}] [${cat}] ${compact}\x1b[0m\n`);
    } catch { /* never throw */ }
  }

  // Notify in-process listeners
  for (const fn of _listeners) { try { fn(rec); } catch {} }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

function ipc(dir, data) {
  event('ipc', { dir, data: truncate(data) });
}

function tool(name, phase, data) {
  event('tool', { name, phase, data: truncate(data) });
}

function llm(seat, fields) {
  event('llm', { seat, ...fields });
}

function comfy(action, fields) {
  event('comfy', { action, ...fields });
}

function progress(label, fields) {
  event('progress', { label, ...fields });
}

function pyerr(text) {
  event('pyerr', { level: 'error', text: truncate(text) });
}

function error(where, msg) {
  event('error', { level: 'error', where, msg: truncate(msg) });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { initDebug, setDebug, isDebug, event, ipc, tool, llm, comfy, progress, pyerr, error, subscribe };
