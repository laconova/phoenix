'use strict';

// ─── records.js — append-only record of every generated output (v1.10 C1) ──────────────────────────
// One JSON line per generated file (image / i2i / mesh / video / upload), written by the module that writes
// the file, so the in-process and the spawned-CLI paths record alike. The Library's Images/Videos
// tabs read it back. A failing record must NEVER fail a generation: both functions swallow errors.

const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const RECORDS_FILE = process.env.PHOENIX_RECORDS_FILE || path.join(ROOT, 'output', 'records.jsonl');
const KINDS = ['image', 'i2i', 'mesh', 'video', 'upload'];   // <l1-library> 'upload' = an image the user brought in (POST /upload)
const PROMPT_MAX = 2000;

// Inside the Phoenix root → relative with '/'; anywhere else → the absolute path as given.
function storedPath(p) {
  if (p == null || p === '') return null;
  const s = String(p);
  const abs = path.resolve(ROOT, s);
  const rel = path.relative(ROOT, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return s;
}

function appendRecord(rec) {
  try {
    if (!rec || KINDS.indexOf(rec.kind) < 0 || rec.path == null || rec.path === '') return false;
    const line = {
      at:       new Date().toISOString(),
      kind:     rec.kind,
      path:     storedPath(rec.path),
      workflow: rec.workflow != null ? rec.workflow : null,
      prompt:   rec.prompt != null ? String(rec.prompt).slice(0, PROMPT_MAX) : null,
      seed:     rec.seed != null ? rec.seed : null,
      parent:   storedPath(rec.parent),
      category: rec.category != null ? rec.category : null,
    };
    if (typeof rec.backend === 'string' && rec.backend) line.backend = rec.backend.slice(0, 60);   // v1.10 V2: which video backend made a clip (only set when given)
    // v1.10 I1: a reference-image generation also keeps its mode and the reference list (nothing else is added).
    if (rec.mode === 'reference') {
      line.mode = 'reference';
      line.refs = Array.isArray(rec.refs) ? rec.refs.map(storedPath).filter(Boolean) : [];
    }
    fs.mkdirSync(path.dirname(RECORDS_FILE), { recursive: true });
    // A half-written earlier line (no trailing newline) must not swallow this record.
    let lead = '';
    try {
      const st = fs.statSync(RECORDS_FILE);
      if (st.size > 0) {
        const fd = fs.openSync(RECORDS_FILE, 'r');
        try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1); if (b[0] !== 10) lead = '\n'; } finally { fs.closeSync(fd); }
      }
    } catch (_) { /* no file yet */ }
    fs.appendFileSync(RECORDS_FILE, lead + JSON.stringify(line) + '\n', 'utf8');
    return true;
  } catch (e) {
    try { console.warn('records: could not append (' + ((e && e.message) || e) + ')'); } catch (_) {}
    return false;
  }
}

// Newest first. opts.kinds = array of kinds to keep (omitted/empty = all).
function readRecords(opts) {
  try {
    const kinds = opts && Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : null;
    if (!fs.existsSync(RECORDS_FILE)) return [];
    const out = [];
    fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').forEach(function (ln) {
      if (!ln.trim()) return;
      let r;
      try { r = JSON.parse(ln); } catch (_) { return; }
      if (!r || typeof r !== 'object' || Array.isArray(r) || KINDS.indexOf(r.kind) < 0) return;
      if (kinds && kinds.indexOf(r.kind) < 0) return;
      out.push(r);
    });
    return out.reverse();
  } catch (e) {
    try { console.warn('records: could not read (' + ((e && e.message) || e) + ')'); } catch (_) {}
    return [];
  }
}

module.exports = { appendRecord, readRecords, RECORDS_FILE };
