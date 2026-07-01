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

const BRUSHES_DIR   = path.join(__dirname, 'brushes');
const REGISTRY_FILE = path.join(BRUSHES_DIR, 'registry.json');

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get  = k => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] || null) : null; };

const slug         = (get('--name') || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
const x            = parseFloat(get('--x') || '0');
const y            = parseFloat(get('--y') || '0');
const z            = parseFloat(get('--z') || '0');
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

  // Resolve source file path
  const srcPath = brush.type === 'phoenix'
    ? (registry.phoenix_source || path.join(BRUSHES_DIR, 'phoenix_brushes.py'))
    : (registry.sci_fi_source  || path.join(path.dirname(BRUSHES_DIR), 'blender-brushes', 'sci_fi_v1.py'));

  const srcFwd  = srcPath.replace(/\\/g, '/');
  const fnName  = brush.fn;
  const nameArg = instanceName ? `name='${instanceName}'` : '';
  const args_py = [`x=${x}`, `y=${y}`, `z=${z}`, nameArg].filter(Boolean).join(', ');

  const code = `
import sys
exec(open(r'${srcFwd}').read())
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
  if (result.status === 'error' || out.toLowerCase().includes('error') || out.toLowerCase().includes('traceback')) {
    console.error(`ERROR: ${result.message || out}`);
    process.exit(1);
  }

  // Success — print placement confirmation
  const placed = out.includes('BRUSH_PLACED') ? out : `BRUSH_PLACED:${slug}`;
  console.log(placed);
}

main().catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
