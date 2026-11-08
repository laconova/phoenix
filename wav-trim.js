'use strict';
// wav-trim.js — cut the trailing silence of a finished voice take (once, final take only).
// Engine-independent: seeded Chatterbox takes and seedless pack takes both carry seconds of digital silence at the end.
// Only PCM16 (format 1, or 0xFFFE extensible with 16 bits) with a parseable fmt + data chunk is touched; everything else comes back unchanged.
const fs = require('fs');

const DEFAULTS = { thresholdDb: -50, keepS: 0.2, windowMs: 10 };

function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4), n = buf.readUInt32LE(p + 4), body = p + 8;
    if (id === 'fmt ') {
      if (n < 16 || body + 16 > buf.length) return null;
      fmt = { tag: buf.readUInt16LE(body), ch: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), align: buf.readUInt16LE(body + 12), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = { sizeAt: p + 4, start: body, len: Math.min(n, buf.length - body), declared: n };
      break;
    }
    p = body + n + (n & 1);
  }
  if (!fmt || !data) return null;
  if (!(fmt.tag === 1 || fmt.tag === 0xFFFE) || fmt.bits !== 16 || fmt.ch < 1 || !fmt.sr) return null;
  return { fmt, data };
}

// A C2PA-signed take stays untouched: its hash covers LIST and the audio, so stripping or trimming would break the signature.
// Walks the RIFF chunks (past `data` too, no plain byte search: audio bytes can contain the letters). Never throws.
function hasC2pa(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return false;
    let p = 12;
    while (p + 8 <= buf.length) {
      const id = buf.toString('latin1', p, p + 4), n = buf.readUInt32LE(p + 4), body = p + 8;
      if (body + n > buf.length) return false;
      if (id === 'C2PA') return true;
      p = body + n + (n & 1);
    }
    return false;
  } catch (_) { return false; }
}

function trimTrailingSilence(buf, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const same = { buf, trimmed: false };
  try {
    if (hasC2pa(buf)) return same;
    const info = parse(buf);
    if (!info) return same;
    const { fmt, data } = info;
    const frameBytes = 2 * fmt.ch, total = Math.floor(data.len / frameBytes);
    const win = Math.max(1, Math.round(fmt.sr * o.windowMs / 1000));
    const th = 32768 * Math.pow(10, o.thresholdDb / 20);
    let soundEnd = -1;
    for (let e = total; e > 0; e -= win) {
      const from = Math.max(0, e - win); let sum = 0;
      for (let i = from * fmt.ch; i < e * fmt.ch; i++) { const v = buf.readInt16LE(data.start + i * 2); sum += v * v; }
      if (Math.sqrt(sum / ((e - from) * fmt.ch)) >= th) { soundEnd = e; break; }
    }
    if (soundEnd < 0) return same;                                   // all silent
    if ((total - soundEnd) / fmt.sr <= o.keepS) return same;         // nothing worth cutting
    const keep = Math.min(total, soundEnd + Math.round(o.keepS * fmt.sr));
    if (keep >= total) return same;
    const newLen = keep * frameBytes, oldEnd = data.start + data.len, pad = data.len & 1;
    const head = Buffer.from(buf.subarray(0, data.start));
    head.writeUInt32LE(newLen, data.sizeAt - 0);
    const tail = data.declared > data.len ? Buffer.alloc(0) : buf.subarray(oldEnd + pad);   // chunks after `data` stay byte-exact
    const parts = [head, buf.subarray(data.start, data.start + newLen)];
    if (newLen & 1) parts.push(Buffer.alloc(1));
    parts.push(tail);
    const out = Buffer.concat(parts);
    out.writeUInt32LE(out.length - 8, 4);
    return { buf: out, trimmed: true };
  } catch (_) { return same; }
}

// Read, trim, write `<abs>.tmp-<pid>`, rename over `abs`. Any error leaves `abs` as it was.
function trimFile(abs) {
  const tmp = abs + '.tmp-' + process.pid;
  try {
    const buf = fs.readFileSync(abs);
    const r = trimTrailingSilence(buf);
    if (!r.trimmed) return { trimmed: false };
    fs.writeFileSync(tmp, r.buf);
    fs.renameSync(tmp, abs);
    return { trimmed: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    return { trimmed: false, error: e.message };
  }
}

// #24 (round 2): drop the metadata chunks an encoder leaves behind (LIST/Lavf, bext, id3 ...). Kept: `fmt ` and `data`.
// A C2PA-signed take stays untouched: its hash covers LIST and the audio, so stripping or trimming would break the signature.
// A buffer that is not a RIFF/WAVE with fmt + data, or has nothing to drop, comes back unchanged (the same Buffer).
const KEEP_CHUNKS = new Set(['fmt ', 'data']);
function stripWavMeta(buf) {
  try {
    if (hasC2pa(buf)) return buf;
    if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return buf;
    const kept = []; let p = 12, dropped = false, hasFmt = false, hasData = false;
    while (p + 8 <= buf.length) {
      const id = buf.toString('latin1', p, p + 4), n = buf.readUInt32LE(p + 4), body = p + 8;
      const end = Math.min(buf.length, body + n + (n & 1));
      if (id === 'data' && n === 0 && body < buf.length) return buf;   // empty data with bytes after it: not a file we understand
      if (KEEP_CHUNKS.has(id)) {
        if (id === 'fmt ') hasFmt = true;
        if (id === 'data') hasData = true;
        kept.push(buf.subarray(p, end));
        if (id === 'data' && body + n > buf.length) break;   // declared past the end (streamed file): nothing follows
      } else dropped = true;
      p = body + n + (n & 1);
    }
    if (!hasFmt || !hasData || !dropped) return buf;
    const out = Buffer.concat([buf.subarray(0, 12)].concat(kept));
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  } catch (_) { return buf; }
}

// Read, strip, write `<abs>.tmp-<pid>`, rename over `abs`. Any error leaves `abs` as it was.
function stripFile(abs) {
  const tmp = abs + '.tmp-' + process.pid;
  try {
    const buf = fs.readFileSync(abs);
    const out = stripWavMeta(buf);
    if (out === buf) return { stripped: false };
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, abs);
    return { stripped: true, removed: buf.length - out.length };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    return { stripped: false, error: e.message };
  }
}

module.exports = { trimTrailingSilence, trimFile, stripWavMeta, stripFile, hasC2pa, DEFAULTS };
