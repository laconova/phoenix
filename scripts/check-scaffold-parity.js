#!/usr/bin/env node
'use strict';

/**
 * check-scaffold-parity.js — is the brush runtime a fresh install gets the same one we run?
 *
 * WHY THIS EXISTS
 * `brushes/phoenix_brushes.py` is gitignored user data; the code that recreates it lives as a
 * template string in `brush-scaffold.js`. So the brush runtime exists TWICE: the file this machine
 * runs, and the one every fresh clone is seeded with. A fix made to the live file does not reach
 * the template, and until now nothing said so.
 *
 * That is not hypothetical. On 2026-07-24 the template still held the PRE-2026-07-13 runtime and
 * was missing all three fixes of that day — palette-only material remap ("oak wears the leaf
 * texture"), instance sources not linked into the scene, and roots-only move/parent (tree spawns
 * at 1/19 scale). A v1.6.0 downloader saving their first brush would have got all three bugs back.
 * The rule was written down that day; this is the check that enforces it.
 *
 * WHAT IT COMPARES
 * Only the RUNTIME half — everything above the `# ── Brushes (appended by save_brush.js)` marker.
 * Below it live the user's own add_*() functions, which are data and are supposed to differ.
 * Two things inside the runtime half are also allowed to differ, because they are per-install:
 *   • the `_LIB_DIR = r"..."` line   — the seeding machine's path
 *   • the body of `_PHOENIX_PALETTE` — the user's accumulated materials
 *
 * HOW IT SEEDS
 * `brush-scaffold.js` derives its paths from `__dirname`, so a copy of that one file in an empty
 * temp folder seeds into THAT folder. Nothing in the real `brushes/` tree is read for writing or
 * touched in any way.
 *
 * EXIT CODES:  0 = in sync   1 = drift found   2 = could not run the check
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE_PY = path.join(ROOT, 'brushes', 'phoenix_brushes.py');
const SCAFFOLD_JS = path.join(ROOT, 'brush-scaffold.js');
const BRUSH_MARKER = '# ── Brushes (appended by save_brush.js)';

function fail(msg) {
  console.error(`check-scaffold-parity: ${msg}`);
  process.exit(2);
}

// Runtime half only: everything above the marker.
function runtimeHalf(text, wo) {
  const i = text.indexOf(BRUSH_MARKER);
  if (i < 0) {
    // Not an error for a freshly seeded file — the marker is appended with the first brush.
    return { text, hadMarker: false, wo };
  }
  return { text: text.slice(0, i), hadMarker: true, wo };
}

// Blank out the two per-install regions so they cannot produce false drift.
function normalise(text) {
  let out = text.replace(/^(\s*_LIB_DIR\s*=\s*r").*(")\s*$/m, '$1<per-install>$2');
  const open = out.indexOf('_PHOENIX_PALETTE = {');
  if (open >= 0) {
    const close = out.indexOf('\n}', open);
    if (close > open) {
      out = out.slice(0, open) + '_PHOENIX_PALETTE = { <user palette> ' + out.slice(close);
    }
  }
  return out;
}

function seedFresh() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-scaffold-'));
  fs.copyFileSync(SCAFFOLD_JS, path.join(tmp, 'brush-scaffold.js'));
  const mod = require(path.join(tmp, 'brush-scaffold.js'));
  const r = mod.ensureBrushScaffold();
  const text = fs.readFileSync(r.PY, 'utf8');
  return { text, tmp, version: mod.SCAFFOLD_VERSION };
}

/**
 * A real line diff (LCS), not an index-by-index compare.
 *
 * The naive version was tried first and is a trap: ONE inserted line shifts everything after it,
 * so a single-line drift reported 288 "differences". A check whose failure output is 288 lines of
 * noise gets ignored on the third read, which makes it worse than no check. ~300x300 cells is
 * nothing to compute.
 */
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ kind: 'only-live', line: i + 1, text: a[i] }); i++; }
    else { out.push({ kind: 'only-scaffold', line: j + 1, text: b[j] }); j++; }
  }
  while (i < n) { out.push({ kind: 'only-live', line: i + 1, text: a[i] }); i++; }
  while (j < m) { out.push({ kind: 'only-scaffold', line: j + 1, text: b[j] }); j++; }
  return out;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* Aufraeumen darf nie der Grund fuer einen Fehlschlag sein */ }
}

function main() {
  if (!fs.existsSync(SCAFFOLD_JS)) fail(`brush-scaffold.js not found at ${SCAFFOLD_JS}`);
  if (!fs.existsSync(LIVE_PY)) {
    console.log('check-scaffold-parity: no brushes/phoenix_brushes.py on this machine — nothing to');
    console.log('  compare against. That is fine on a fresh clone; run it where the brush system is used.');
    process.exit(0);
  }

  let fresh;
  try { fresh = seedFresh(); } catch (e) { fail(`could not seed a fresh scaffold: ${e.message}`); }

  try {
    const live = runtimeHalf(fs.readFileSync(LIVE_PY, 'utf8'), 'live');
    const seed = runtimeHalf(fresh.text, 'scaffold');

    const liveV = (live.text.match(/PHOENIX_SCAFFOLD_VERSION:\s*(\d+)/) || [])[1] || '1 (none)';
    const seedV = String(fresh.version);

    const a = normalise(live.text).split(/\r?\n/);
    const b = normalise(seed.text).split(/\r?\n/);

    const diffs = lineDiff(a, b);

    console.log('brush runtime parity — live file vs. what a fresh install is seeded with');
    console.log(`  live     : ${path.relative(ROOT, LIVE_PY)}  (scaffold version ${liveV}, ${a.length} runtime lines)`);
    console.log(`  scaffold : brush-scaffold.js template      (scaffold version ${seedV}, ${b.length} runtime lines)`);
    if (!live.hadMarker) console.log('  note     : live file carries no brush marker — comparing the whole file.');

    if (liveV !== seedV) {
      console.log(`\n  ⚠ version mismatch: live is v${liveV}, template is v${seedV}.`);
      console.log('    Start Phoenix once — ensureBrushScaffold() migrates the live file — then re-run.');
    }

    if (!diffs.length) {
      console.log('\n  ✅ in sync — the runtime a downloader gets is the runtime you run.');
      process.exit(0);
    }

    const nurLive = diffs.filter((d) => d.kind === 'only-live').length;
    const nurScaffold = diffs.length - nurLive;
    console.log(`\n  ❌ DRIFT: ${nurLive} line(s) only in the live runtime, ${nurScaffold} only in the template.`);
    console.log('     Every fix to brushes/phoenix_brushes.py must be made in the SCAFFOLD template');
    console.log('     in brush-scaffold.js as well — otherwise a fresh install gets the old bug back.\n');
    for (const d of diffs.slice(0, 30)) {
      const wo = d.kind === 'only-live' ? 'live only     ' : 'scaffold only ';
      console.log(`  ${wo} L${String(d.line).padEnd(4)} ${d.text}`);
    }
    if (diffs.length > 30) console.log(`  … and ${diffs.length - 30} more`);
    process.exit(1);
  } finally {
    rmrf(fresh.tmp);
  }
}

main();
