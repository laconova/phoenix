'use strict';

/**
 * use_brush.js — Place a brush from the Phoenix library into the current Blender scene
 *
 * Usage:
 *   node use_brush.js --name <slug> [--x <x>] [--y <y>] [--z <z>] [--instance-name <n>]
 *
 * Reads registry.json, resolves the brush type, and calls the correct .py source via Blender IPC.
 * Outputs BRUSH_PLACED:<slug> on success, ERROR:<msg> on failure.
 */

const fs   = require('fs');
const path = require('path');
const { callBlender } = require('./blender-ipc');
const { ensureBrushScaffold } = require('./brush-scaffold');
// brushes/ is gitignored — seed the .py base + registry on first use. Ist die Laufzeit
// kaputt (abgeschnitten / ohne Marker), sofort und verstaendlich abbrechen: sonst
// scheitert erst Blender mit einem Python-Fehler weit weg von der Ursache.
{
  const _st = ensureBrushScaffold().scaffold || {};
  if (_st.reason === 'version-current-but-truncated' || _st.reason === 'marker-missing') {
    console.error(
      'ABORT: brushes/phoenix_brushes.py is in a broken state (' + _st.reason + ').\n' +
      'Restore the newest phoenix_brushes.py.bak-* next to it before placing brushes.'
    );
    process.exit(1);
  }
}

const BRUSHES_DIR   = path.join(__dirname, 'brushes');
const REGISTRY_FILE = path.join(BRUSHES_DIR, 'registry.json');

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get  = k => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] || null) : null; };

const slug         = (get('--name') || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
const xRaw         = get('--x');   // left null when not passed → brush spawns at the 3D cursor
const yRaw         = get('--y');
const zRaw         = get('--z');
const instanceName = get('--instance-name') || '';

if (!slug) {
  console.error('ERROR: --name is required');
  process.exit(1);
}

// ─── Blender IPC ──────────────────────────────────────────────────────────────
// File-based transport via blender-ipc.js (callBlender imported above). Was a 9876
// socket; raw sockets fail cross-process on Windows + Blender 5.1 / Python 3.13.

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(REGISTRY_FILE)) {
    console.error(`ERROR: registry.json not found at ${REGISTRY_FILE}`);
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  const brush    = registry.brushes && registry.brushes[slug];

  if (!brush) {
    const available = Object.keys(registry.brushes || {}).join(', ') || '(none)';
    console.error(`ERROR: brush '${slug}' not found. Available: ${available}`);
    process.exit(1);
  }

  // Resolve source file path.
  // registry.json stores these RELATIVE ("brushes/phoenix_brushes.py"). Blender's cwd is not
  // Phoenix's, so a relative path reaches it as FileNotFoundError and the brush never spawns.
  // path.resolve keeps absolute entries as they are and anchors relative ones to Phoenix.
  const srcRaw = brush.type === 'phoenix'
    ? (registry.phoenix_source || path.join(BRUSHES_DIR, 'phoenix_brushes.py'))
    : (registry.sci_fi_source  || path.join(path.dirname(BRUSHES_DIR), 'blender-brushes', 'sci_fi_v1.py'));
  const srcPath = path.resolve(__dirname, srcRaw);

  const srcFwd  = srcPath.replace(/\\/g, '/');
  const fnName  = brush.fn;
  // Pass x/y/z only when the caller gave them; otherwise the .py default (None) makes the
  // brush spawn at the 3D cursor.
  const posArgs = [];
  // Guard non-finite coords: a non-numeric x/y/z would emit `x=NaN`/`x=Infinity` into the Python
  // and NameError in Blender. A dropped axis becomes 0.0 in the .py (the 3D-cursor default applies
  // only when x, y AND z are all absent).
  if (xRaw !== null) { const _x = parseFloat(xRaw); if (Number.isFinite(_x)) posArgs.push(`x=${_x}`); }
  if (yRaw !== null) { const _y = parseFloat(yRaw); if (Number.isFinite(_y)) posArgs.push(`y=${_y}`); }
  if (zRaw !== null) { const _z = parseFloat(zRaw); if (Number.isFinite(_z)) posArgs.push(`z=${_z}`); }
  if (instanceName) posArgs.push(`name=${JSON.stringify(instanceName)}`);
  const args_py = posArgs.join(', ');

  // Override any root baked into the .py at seed time with THIS machine's lib dir,
  // so a brushes/ tree copied between machines still resolves locally.
  // Python reads module globals at call time, so setting _LIB_DIR after exec() wins.
  const libDirFwd = path.join(BRUSHES_DIR, 'lib').replace(/\\/g, '/');
  const code = `
import sys
exec(open(${JSON.stringify(srcFwd)}).read())
_LIB_DIR = ${JSON.stringify(libDirFwd)}
${fnName}(${args_py})
`;

  let result;
  try {
    result = await callBlender(code);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }

  const out = (result.stdout || result.output || '').trim();

  // Check for Python-level error. With file-IPC the traceback is in result.message
  // (status 'error'); legacy markers in stdout are still caught for safety.
  // ANCHORED, not a substring scan: the old test was out.toLowerCase().includes('error'), which
  // a successful placement can satisfy all by itself — BRUSH_PLACED echoes the object name, so a
  // brush made from an object called "Terror Tower" reported failure after placing correctly,
  // and a retry then placed a second copy.
  if (result.status === 'error' || /(^|\n)\s*(ERROR|PYTHON_ERROR|Traceback)/.test(out)) {
    console.error(`ERROR: ${result.message || out}`);
    process.exit(1);
  }

  // Success — print placement confirmation
  const placed = out.includes('BRUSH_PLACED') ? out : `BRUSH_PLACED:${slug}`;
  console.log(placed);
}

main().catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
