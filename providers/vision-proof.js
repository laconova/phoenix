'use strict';
// providers/vision-proof.js — the colour-stripe proof that a vision model actually SAW the image bytes (v1.9 M3).
// A model that did not receive (or cannot read) an image will still happily describe one. So every vision call
// carries a small generated test card — 3 vertical stripes, each random from 6 colours (1/216 to guess) — and the
// model must name the stripes before it judges the render. Wrong or missing colours = UNVERIFIED, never a silent pass.
// Each stripe is 128 px wide: measured on GPT 06.10. — 96x32 gave 4/5 wrong, 384x128 gave 4/4 right.
// Node stdlib only (zlib): no font, no Blender, no image library.
const zlib = require('zlib');

const COLORS = { red: [255, 0, 0], green: [0, 170, 0], blue: [0, 0, 255], yellow: [255, 230, 0], black: [0, 0, 0], white: [255, 255, 255] };
const NAMES = Object.keys(COLORS);
const W = 384, H = 128, STRIPE = 128;

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; _crcTable[n] = c >>> 0; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const pick = (rng, n) => Math.min(n - 1, Math.floor(rng() * n));

// Fisher-Yates over the 6 colour names → a fresh random order (a copy; the injectable rng makes it testable).
function shuffledNames(rng = Math.random) {
  const a = NAMES.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = pick(rng, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// The word list shown in the prompts: all 6 names exactly once, shuffled per call. An unsure model parrots the first
// words it was given (measured 07.10.: "red, green, blue"), so a fixed order would let a guess pass.
function colorWordList(rng = Math.random) { return shuffledNames(rng).join(', '); }

// makeCard(rng) → { colors: [c1, c2, c3], png: Buffer } — three DISTINCT colours, drawn without replacement
// (120 combinations). Adjacent repeats were misread by Gemma 5/12 times (measured 07.10.).
function makeCard(rng = Math.random) {
  const pool = NAMES.slice(), colors = [];
  for (let k = 0; k < 3; k++) colors.push(pool.splice(pick(rng, pool.length), 1)[0]);
  const row = Buffer.alloc(1 + W * 3);   // filter byte 0, then RGB
  colors.forEach((c, i) => { for (let x = i * STRIPE; x < (i + 1) * STRIPE; x++) row.set(COLORS[c], 1 + x * 3); });
  const raw = Buffer.concat(Array.from({ length: H }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB, no alpha
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return { colors, png };
}

// The first non-empty line must start with "COLORS:" (case-insensitive, optional ** / backticks around it).
function colorsLine(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const i = lines.findIndex(l => l.trim());
  if (i < 0) return { idx: -1, rest: null };
  const m = /^[\s*`]*colors[\s*`]*:[\s*`]*(.*)$/i.exec(lines[i]);
  return m ? { idx: i, rest: m[1], lines } : { idx: -1, rest: null };
}

// parseColors(text) → { found, colors } — only the 6 known colour words are kept.
function parseColors(text) {
  const { rest } = colorsLine(text);
  if (rest === null) return { found: false, colors: [] };
  const colors = rest.toLowerCase().split(/[\s,\/\-→>]+/).map(w => w.replace(/[^a-z]/g, '')).filter(w => NAMES.includes(w));
  return { found: true, colors };
}

// checkProof(text, expected) → { ok, said, detail } — ok iff the stated colours equal the card, in order.
function checkProof(text, expected) {
  const p = parseColors(text);
  if (!p.found) return { ok: false, said: [], detail: 'no COLORS line' };
  const ok = p.colors.length === expected.length && p.colors.every((c, i) => c === expected[i]);
  return { ok, said: p.colors, detail: ok ? 'colours matched' : 'said ' + (p.colors.join(', ') || 'nothing') + ' — card was ' + expected.join(', ') };
}

// stripColorsLine(text) → the text without its first COLORS: line, trimmed (unchanged when there is none).
function stripColorsLine(text) {
  const c = colorsLine(text);
  if (c.idx < 0) return String(text == null ? '' : text).trim();
  return c.lines.filter((_, i) => i !== c.idx).join('\n').trim();
}

module.exports = { shuffledNames, colorWordList, COLORS, makeCard, parseColors, checkProof, stripColorsLine, crc32 };
