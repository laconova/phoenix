'use strict';

// ─── storyboard-timeline.js — the ONE timing source of a board (v1.10.1 R6) ──────────────────────────
// The page plays the animatic from this timeline and the MP4 export renders from it, so what plays is what exports.
//   timeline(board, facts) -> { total_s, shots: [ { id, index, n, title, start_s, duration_s, end_s, visual: 'clip'|'keyframe'|'none',
//                                                   image, clip, clip_audio, lines: [ { lid, take, at_s, dur_s, until_s } ],
//                                                   sfx: { clip, at_s, until_s } | null } ], warnings: [string] }
//   facts = { keyframeOk(rel) -> bool, clipOk(rel) -> bool, takeSeconds(take) -> number|null (null = missing), sfxOk(clipName) -> bool }
//   wavSeconds(absFile) -> number|null
// timeline() is pure (it touches no file; the facts do). wavSeconds() reads at most the first 64 KiB of one file.

const fs = require('fs');

const ms = (x) => Math.round(x * 1000) / 1000;
const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : 0;
const safe = (fn, arg) => { try { return typeof fn === 'function' ? !!fn(arg) : false; } catch (_) { return false; } };

function timeline(board, facts) {
  const f = facts || {};
  const src = (board && Array.isArray(board.shots)) ? board.shots : [];
  const warnings = [];
  const shots = [];
  let t = 0;
  src.forEach((s0, index) => {
    const s = (s0 && typeof s0 === 'object') ? s0 : {};
    const n = index + 1;
    const start = ms(t), duration = ms(num(s.duration_s)), end = ms(start + duration);
    t = end;

    const clipPath = (s.clip && typeof s.clip === 'object' && typeof s.clip.path === 'string' && s.clip.path) ? s.clip.path : null;
    const image = (typeof s.image === 'string' && s.image) ? s.image : null;
    const clipOk = clipPath !== null && safe(f.clipOk, clipPath);
    const kfOk = image !== null && safe(f.keyframeOk, image);
    const visual = clipOk ? 'clip' : (kfOk ? 'keyframe' : 'none');
    if (clipPath !== null && !clipOk) warnings.push('Shot ' + n + ': clip file missing');
    if (image !== null && !kfOk && !clipOk) warnings.push('Shot ' + n + ': keyframe file missing');

    const lines = [];
    let cursor = start;
    (Array.isArray(s.lines) ? s.lines : []).forEach((l, k) => {
      if (!l || typeof l !== 'object' || typeof l.take !== 'string') return;   // a line without a take is silent: skipped, no warning
      let secs = null;
      try { secs = typeof f.takeSeconds === 'function' ? f.takeSeconds(l.take) : null; } catch (_) { secs = null; }
      if (typeof secs !== 'number' || !isFinite(secs) || secs < 0) { warnings.push('Shot ' + n + ': take missing — ' + l.take); return; }   // the line and its gap are skipped
      const at = ms(cursor + Math.max(0, num(l.gap_s)));
      if (at >= end) { warnings.push('Shot ' + n + ': line ' + (k + 1) + ' starts after the shot ends'); return; }
      lines.push({ lid: typeof l.lid === 'string' ? l.lid : '', take: l.take, at_s: at, dur_s: ms(secs), until_s: end });
      cursor = ms(at + secs);
    });

    let sfx = null;
    const clipName = (s.sound && typeof s.sound === 'object' && typeof s.sound.clip === 'string' && s.sound.clip) ? s.sound.clip : null;
    if (clipName !== null) {
      if (safe(f.sfxOk, clipName)) sfx = { clip: clipName, at_s: start, until_s: end };
      else warnings.push('Shot ' + n + ': sound clip missing — ' + clipName);
    }

    shots.push({
      id: typeof s.id === 'string' ? s.id : '', index, n, title: typeof s.title === 'string' ? s.title : '',
      start_s: start, duration_s: duration, end_s: end, visual, image, clip: clipPath,
      clip_audio: visual === 'clip' && s.clip.muted !== true, lines, sfx,
    });
  });
  return { total_s: ms(t), shots, warnings };
}

// Length of a WAV in seconds, from its header (byteRate of the fmt chunk, size of the data chunk capped at what the file really holds).
// Anything that does not parse falls back to a 48000 bytes/s guess (24 kHz mono PCM16, what CrispASR answers). A missing file is null.
function wavSeconds(file) {
  let fd = null;
  try {
    if (typeof file !== 'string' || !file) return null;
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const guess = () => ms(Math.max(0, st.size - 44) / 48000);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 65536));
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, got);
    if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return guess();
    let byteRate = 0, off = 12;
    while (off + 8 <= head.length) {
      const id = head.toString('latin1', off, off + 4), size = head.readUInt32LE(off + 4), body = off + 8;
      if (id === 'fmt ' && size >= 16 && body + 16 <= head.length) byteRate = head.readUInt32LE(body + 8);
      else if (id === 'data') {
        if (byteRate <= 0) return guess();
        return ms(Math.min(size, Math.max(0, st.size - body)) / byteRate);
      }
      off = body + size + (size & 1);
    }
    return guess();
  } catch (_) { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* nothing to close */ } } }
}

module.exports = { timeline, wavSeconds };
