'use strict';

// ─── storyboard-export.js — the animatic MP4 of a board (v1.10.1 R6) ─────────────────────────────────
// exportBoard(board, tl, opts) renders the server timeline (storyboard-timeline.js) into ONE MP4 with ffmpeg:
//   per shot a segment of exactly duration_s (clip > keyframe > title card, never skipped), concatenated; the audio is one mix (silent base +
//   every line take, SFX and unmuted clip sound, each placed with adelay at its timeline time).
// Safety rules (the review of the earlier steps rejected exactly these):
//   - every number that reaches ffmpeg is validated as finite and in range BEFORE anything is spawned; colours are '#RRGGBB'
//   - inputs only as `-i <absolute existing file>` or `-f lavfi -i <plain source>`; the filter graph carries no path, title, quote, backslash,
//     % or { (a title card's text lives in a file inside the private work dir, read by drawtext textfile=)
//   - spawn(ffmpeg, argsArray) - never a shell, never a joined command string
//   - temp names are unique per call; the final name is created with a hard link only after ffmpeg succeeded (never overwrites); every
//     failure / stop / exception removes the temp file and the work dir (finally)

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const ANIMATIC_DIR = path.resolve(process.env.PHOENIX_ANIMATIC_DIR || path.join(ROOT, 'output', 'video'));
const SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
const FPS = 30;
const DUR_MIN = 1, DUR_MAX = 15, MAX_SHOTS = 60;
const HEX = /^#[0-9a-fA-F]{6}$/;
const BOARD_ID = /^[a-z0-9]{6}$/;
const GRAPH_OK = /^[A-Za-z0-9_=:.,;\[\]()+\-*\/ |]*$/;   // what a filter graph of ours may contain (checked before spawning)
const ARGS_MAX = 30000;                                   // total length of the ffmpeg command line (Windows allows 32767)
const STALE_PART_MS = 24 * 3600 * 1000;

const fmt = (x) => String(Math.round(x * 1000) / 1000);   // a validated finite number as plain decimal text
const inRange = (x, lo, hi) => typeof x === 'number' && isFinite(x) && x >= lo && x <= hi;
const rm = (p, dir) => { try { if (p) (dir ? fs.rmSync(p, { recursive: true, force: true }) : fs.unlinkSync(p)); } catch (_) { /* already gone */ } };

function findFont() {
  const win = process.env.WINDIR || process.env.SystemRoot;
  if (!win) return null;
  for (const n of ['arial.ttf', 'segoeui.ttf']) {
    const p = path.join(win, 'Fonts', n);
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* try the next one */ }
  }
  return null;
}

// an absolute path of an existing file, or null (no relative paths, no NUL / line breaks)
function absFile(fn, arg) {
  try {
    const p = typeof fn === 'function' ? fn(arg) : null;
    if (typeof p !== 'string' || !p || /[\0\r\n]/.test(p) || !path.isAbsolute(p)) return null;
    return fs.statSync(p).isFile() ? p : null;
  } catch (_) { return null; }
}

// Runs one process with an args array. -> Promise<{ code, stopped, timedOut, stderr, error }>. Kills on abort / timeout and resolves only after the exit.
function run(cmd, args, o) {
  return new Promise((resolve) => {
    let child = null, done = false, stopped = false, timedOut = false, err = '', out = '', killTimer = null, timer = null;
    const signal = o.signal;
    const finish = (code, error) => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (_) { /* gone */ } }
      resolve({ code, stopped, timedOut, stderr: err, error: error || '' });
    };
    const kill = () => {
      if (!child || done) return;
      try { child.kill(); } catch (_) { /* already gone */ }
      if (!killTimer) killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 5000);
    };
    const onAbort = () => { stopped = true; kill(); };
    if (signal && signal.aborted) { stopped = true; finish(-1); return; }
    try { child = cp.spawn(cmd, args, { cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { finish(-1, (e && e.message) || String(e)); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (o.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    child.on('error', (e) => finish(-1, (e && e.message) || String(e)));
    child.stdout.on('data', (b) => {
      if (!o.onLine) return;
      out += b.toString('latin1');
      const parts = out.split('\n'); out = parts.pop();
      if (out.length > 4096) out = '';
      for (const ln of parts) { try { o.onLine(ln.trim()); } catch (_) { /* progress must never break the run */ } }
    });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); if (err.length > 16000) err = err.slice(-8000); });
    child.on('close', (code) => finish(code));
  });
}

// does the media file have an audio stream? (`ffmpeg -hide_banner -i <file>` prints the streams to stderr and exits 1 - that is normal)
async function hasAudio(ffmpeg, file, signal) {
  const r = await run(ffmpeg, ['-hide_banner', '-i', file], { signal, timeoutMs: 30000 });
  return /Stream #\d+:\d+.*?: Audio:/.test(r.stderr);
}

// can ffmpeg decode one frame of this picture? A text file named .png or a cut-off PNG makes `-loop 1` spin for hours, so each keyframe is probed once.
// A missing ffmpeg is not judged here (the main run reports it); a stop counts as fine (the caller checks the signal).
async function frameReadable(ffmpeg, file, signal) {
  const r = await run(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'image2', '-pattern_type', 'none', '-i', file, '-frames:v', '1', '-f', 'null', '-'], { signal, timeoutMs: 10000 });
  if (r.stopped || r.error) return true;
  return !r.timedOut && r.code === 0 && !r.stderr.trim();
}

// Wraps a title for the card: at most 4 lines, no control characters. The text only ever goes into a file.
function wrapTitle(text, width) {
  const words = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (let w of words) {
    while (w.length > width) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, width)); w = w.slice(width); }
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= width) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > 4) { lines.length = 4; lines[3] = lines[3].slice(0, Math.max(0, width - 3)) + '...'; }
  return lines.join('\n');
}

const two = (n) => String(n).padStart(2, '0');
const stampOf = (d) => d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());

// partial files that an earlier crash left behind (never a running export: those are touched all the time)
function sweepParts() {
  try {
    for (const n of fs.readdirSync(ANIMATIC_DIR)) {
      if (!/^\.[a-z0-9]{6}-animatic-.*\.part\.mp4$/.test(n)) continue;
      const p = path.join(ANIMATIC_DIR, n);
      try { if (Date.now() - fs.statSync(p).mtimeMs > STALE_PART_MS) fs.unlinkSync(p); } catch (_) { /* busy or gone */ }
    }
  } catch (_) { /* no folder yet */ }
}

// -> null | error text. Nothing is spawned unless this is null.
function validate(board, tl, opts) {
  if (!board || typeof board !== 'object' || !BOARD_ID.test(String(board.id))) return 'bad board';
  if (!tl || typeof tl !== 'object' || !Array.isArray(tl.shots) || !tl.shots.length) return 'nothing to export';
  if (tl.shots.length > MAX_SHOTS) return 'too many shots to export';
  if (!opts || typeof opts.ffmpeg !== 'string' || !opts.ffmpeg.trim() || /[\0\r\n]/.test(opts.ffmpeg)) return 'ffmpeg is not set';
  const c = opts.colors;
  if (!c || typeof c.bg !== 'string' || typeof c.text !== 'string' || !HEX.test(c.bg) || !HEX.test(c.text)) return 'bad colours';
  let sum = 0;
  for (const s of tl.shots) {
    if (!s || typeof s !== 'object' || !inRange(s.duration_s, DUR_MIN, DUR_MAX)) return 'a shot length is out of range (1 to 15 s)';
    sum += s.duration_s;
  }
  const total = tl.total_s;
  if (!inRange(total, DUR_MIN, DUR_MAX * MAX_SHOTS) || Math.abs(total - sum) > 0.01) return 'the timeline length does not match its shots';
  const timeOk = (x) => inRange(x, 0, total);
  for (const s of tl.shots) {
    if (!timeOk(s.start_s) || !timeOk(s.end_s)) return 'a shot time is out of range';
    for (const l of (Array.isArray(s.lines) ? s.lines : [])) if (!l || !timeOk(l.at_s) || !timeOk(l.until_s)) return 'a line time is out of range';
    if (s.sfx && (!timeOk(s.sfx.at_s) || !timeOk(s.sfx.until_s))) return 'a sound time is out of range';
  }
  return null;
}

async function exportBoard(board, tl, opts) {
  const warnings = [];
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
  let workDir = null, tmp = null;
  try {
    const bad = validate(board, tl, opts);
    if (bad) return { ok: false, error: bad, warnings };
    (Array.isArray(tl.warnings) ? tl.warnings : []).forEach((w) => { if (typeof w === 'string') warn(w); });
    const signal = (opts.signal && typeof opts.signal.aborted === 'boolean') ? opts.signal : null;
    if (signal && signal.aborted) return { ok: false, stopped: true, error: 'stopped', warnings };
    const [W, H] = SIZES[board.aspect] || SIZES['16:9'];
    const total = tl.total_s;
    const bg = '0x' + opts.colors.bg.slice(1), fg = '0x' + opts.colors.text.slice(1);
    const now = (() => { try { const d = typeof opts.now === 'function' ? opts.now() : new Date(); return (d instanceof Date && isFinite(d.getTime())) ? d : new Date(); } catch (_) { return new Date(); } })();

    fs.mkdirSync(ANIMATIC_DIR, { recursive: true });
    sweepParts();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-animatic-'));
    let font = null;
    if (typeof opts.fontFile === 'string' && opts.fontFile && path.isAbsolute(opts.fontFile)) {
      try { fs.copyFileSync(opts.fontFile, path.join(workDir, 'font.ttf')); font = 'font.ttf'; } catch (_) { font = null; }
    }

    const inputs = [];   // argv pieces in input order; every entry is [...optionsBeforeI, '-i', source]
    const addInput = (pre, source) => { inputs.push(pre.concat(['-i', source])); return inputs.length - 1; };
    addInput(['-f', 'lavfi', '-t', fmt(total)], 'anullsrc=r=48000:cl=stereo');   // input 0: the silent audio base (its length is the length of the mix)
    const vparts = [], vlabels = [], audio = [];   // audio: { idx, at, until }
    const fit = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:color=' + bg + ',setsar=1,fps=' + FPS + ',format=yuv420p';

    for (let i = 0; i < tl.shots.length; i++) {
      const s = tl.shots[i], n = i + 1, D = fmt(s.duration_s);
      let kind = s.visual === 'clip' ? 'clip' : (s.visual === 'keyframe' ? 'keyframe' : 'none'), file = null;
      const warnedBefore = warnings.length;
      if (kind === 'clip') {
        file = absFile(opts.resolveClip, s.clip);
        if (!file) { warn('Shot ' + n + ': clip file missing'); kind = 'keyframe'; }
      }
      if (kind === 'keyframe') {
        file = absFile(opts.resolveImage, s.image);
        if (!file) { if (s.visual === 'keyframe' || s.image) warn('Shot ' + n + ': keyframe file missing'); kind = 'none'; }
        else if (!(await frameReadable(opts.ffmpeg, file, signal))) { warn('Shot ' + n + ': keyframe unreadable, title card used'); kind = 'none'; }
      }
      if (kind === 'none' && warnings.length === warnedBefore) warn('Shot ' + n + ': no image yet, title card used');   // M1.2: nothing was asked for and nothing said so yet
      const label = '[v' + i + ']';
      if (kind === 'clip') {
        const idx = addInput([], file);
        vparts.push('[' + idx + ':v]' + fit + ',tpad=stop_mode=clone:stop_duration=' + D + ',trim=duration=' + D + ',setpts=PTS-STARTPTS' + label);
        if (s.clip_audio === true && await hasAudio(opts.ffmpeg, file, signal)) audio.push({ idx: addInput([], file), at: s.start_s, until: s.end_s });
      } else if (kind === 'keyframe') {
        const idx = addInput(['-pattern_type', 'none', '-loop', '1', '-f', 'image2', '-framerate', String(FPS), '-t', D], file);
        vparts.push('[' + idx + ':v]' + fit + ',tpad=stop_mode=clone:stop_duration=' + D + ',trim=duration=' + D + ',setpts=PTS-STARTPTS' + label);
      } else {   // the title card: board colour + the shot title (text from a file in the work dir)
        const idx = addInput(['-f', 'lavfi'], 'color=c=' + bg + ':s=' + W + 'x' + H + ':r=' + FPS + ':d=' + D);
        let draw = '';
        if (font) {
          const fs0 = Math.round(Math.min(W, H) / 18), width = Math.max(10, Math.floor(W * 0.8 / (fs0 * 0.6)));
          const text = wrapTitle(s.title || ('Shot ' + n), width) || ('Shot ' + n);
          fs.writeFileSync(path.join(workDir, 'title-' + n + '.txt'), text, 'utf8');
          draw = 'drawtext=textfile=title-' + n + '.txt:fontfile=font.ttf:expansion=none:fontcolor=' + fg + ':fontsize=' + fs0 + ':x=(w-text_w)/2:y=(h-text_h)/2,';
        } else warn('Shot ' + n + ': title text skipped — no font found');
        vparts.push('[' + idx + ':v]' + draw + 'setsar=1,fps=' + FPS + ',format=yuv420p,trim=duration=' + D + ',setpts=PTS-STARTPTS' + label);
      }
      vlabels.push(label);
      for (const l of (Array.isArray(s.lines) ? s.lines : [])) {
        const f = absFile(opts.takeFile, l.take);
        if (!f) { warn('Shot ' + n + ': take missing — ' + String(l.take)); continue; }
        if (l.until_s - l.at_s > 0) audio.push({ idx: addInput([], f), at: l.at_s, until: l.until_s });
      }
      if (s.sfx) {
        const f = absFile(opts.sfxFile, s.sfx.clip);
        if (!f) warn('Shot ' + n + ': sound clip missing — ' + String(s.sfx.clip));
        else if (s.sfx.until_s - s.sfx.at_s > 0) audio.push({ idx: addInput([], f), at: s.sfx.at_s, until: s.sfx.until_s });
      }
    }
    if (signal && signal.aborted) return { ok: false, stopped: true, error: 'stopped', warnings };

    const aparts = audio.map((a, k) => '[' + a.idx + ':a]atrim=0:' + fmt(a.until - a.at) + ',asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=' + Math.round(a.at * 1000) + '|' + Math.round(a.at * 1000) + '[a' + k + ']');
    const mix = audio.length
      ? '[0:a]' + audio.map((_, k) => '[a' + k + ']').join('') + 'amix=inputs=' + (audio.length + 1) + ':duration=first:normalize=0[aout]'
      : '[0:a]anull[aout]';
    const graph = vparts.concat(vlabels.join('') + 'concat=n=' + vlabels.length + ':v=1:a=0[vout]', aparts, mix).join(';');
    if (!GRAPH_OK.test(graph)) return { ok: false, error: 'the filter graph is not safe', warnings };

    const part = path.join(ANIMATIC_DIR, '.' + board.id + '-animatic-' + stampOf(now) + '-' + crypto.randomBytes(3).toString('hex') + '.part.mp4');
    const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', '-y'];
    inputs.forEach((p) => args.push(...p));
    args.push('-filter_complex', graph, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '160k', '-t', fmt(total), '-movflags', '+faststart', part);
    if (args.reduce((t, a) => t + a.length + 1, opts.ffmpeg.length) > ARGS_MAX) return { ok: false, error: 'this board has too many parts to export in one go', warnings };

    tmp = part;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const r = await run(opts.ffmpeg, args, {
      cwd: workDir, signal, timeoutMs: Math.max(120, total * 20) * 1000,
      onLine: (ln) => {
        const m = /^out_time_ms=(\d+)$/.exec(ln);
        if (m && onProgress) onProgress(Math.max(0, Math.min(1, Number(m[1]) / (total * 1e6))));
      },
    });
    if (r.stopped) return { ok: false, stopped: true, error: 'stopped', warnings };
    if (r.timedOut) return { ok: false, error: 'ffmpeg took too long', warnings };
    if (r.error) return { ok: false, error: 'ffmpeg could not be started', warnings };
    if (r.code !== 0) return { ok: false, error: 'ffmpeg failed' + (r.stderr.trim() ? ': ' + r.stderr.trim().slice(-300) : ''), warnings };
    let size = 0; try { size = fs.statSync(tmp).size; } catch (_) { size = 0; }
    if (!size) return { ok: false, error: 'ffmpeg wrote no file', warnings };

    // success only: the final name is a hard link of the finished temp file (never overwrites; a taken name gets -2, -3 ...)
    const base = board.id + '-animatic-' + stampOf(now);
    for (let k = 1; k <= 50; k++) {
      const name = base + (k === 1 ? '' : '-' + k) + '.mp4', dst = path.join(ANIMATIC_DIR, name);
      try { fs.linkSync(tmp, dst); }
      catch (e) {
        if (e && e.code === 'EEXIST') continue;
        if (e && ['EPERM', 'ENOSYS', 'ENOTSUP', 'EXDEV', 'EOPNOTSUPP'].includes(e.code)) {   // a file system without hard links: copy, still without ever overwriting
          try { fs.copyFileSync(tmp, dst, fs.constants.COPYFILE_EXCL); }
          catch (e2) {
            if (e2 && e2.code === 'EEXIST') continue;   // COPYFILE_EXCL created nothing: dst is ANOTHER export's finished file - never delete it
            rm(dst);   // any other error: dst can only be our own partial copy
            return { ok: false, error: 'could not save the video', warnings }; }
        } else return { ok: false, error: 'could not save the video', warnings };
      }
      return { ok: true, file: dst, name, duration_s: total, warnings };
    }
    return { ok: false, error: 'could not find a free file name', warnings };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), warnings };
  } finally {
    rm(tmp);
    rm(workDir, true);
  }
}

module.exports = { exportBoard, ANIMATIC_DIR, SIZES, FPS, findFont };
