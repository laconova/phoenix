'use strict';

/**
 * manage_palette.js — inspect / prune the Phoenix shared material palette
 *
 * Usage:
 *   node manage_palette.js --list                 list all palette materials
 *   node manage_palette.js --delete <M_Name>      remove one material from the palette
 *
 * Operates only on _PHOENIX_PALETTE in brushes/phoenix_brushes.py (the registry / source
 * of truth). It does NOT touch the open Blender scene — a material already created there
 * stays until the file is reloaded.
 */

const fs   = require('fs');
const path = require('path');
const { ensureBrushScaffold } = require('./brush-scaffold');
ensureBrushScaffold();

const PHOENIX_PY = path.join(__dirname, 'brushes', 'phoenix_brushes.py');

const args = process.argv.slice(2);
const get  = k => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] || null) : null; };
const wantList = args.includes('--list');
const delName  = get('--delete');

if (!wantList && !delName) {
  console.error('Usage: node manage_palette.js --list | --delete <M_Name>');
  process.exit(1);
}

// A material name is a NAME, never a path. Without this, --delete is a file-deletion primitive
// pointed at the whole tree: the name is joined onto palette_materials/ and unlinked, so
// "../../characters/hero" deletes a saved character. And `delete_material` is a tool the
// orchestrator can be talked into calling with whatever a user types into the chat.
if (delName && (delName !== path.basename(delName) || delName === '.' || delName === '..')) {
  console.error('ERROR: material name must be a plain name, not a path');
  process.exit(1);
}

const PAL_DIR = path.join(__dirname, 'brushes', 'palette_materials');

function paletteBody(src) {
  const open  = src.indexOf('_PHOENIX_PALETTE = {');
  const close = open >= 0 ? src.indexOf('\n}', open) : -1;
  return (open >= 0 && close >= 0) ? src.slice(open, close) : '';
}

function libraryMaterials() {
  try { return fs.readdirSync(PAL_DIR).filter(f => f.endsWith('.blend')).map(f => f.slice(0, -6)); }
  catch (_) { return []; }
}

if (wantList) {
  const src = fs.readFileSync(PHOENIX_PY, 'utf8');
  const entries = [...paletteBody(src).matchAll(/"([^"]+)"\s*:\s*lambda\s*\w*\s*:\s*(_make_\w+)/g)];
  const lib = libraryMaterials();
  console.log(`Palette (${entries.length + lib.length} material(s)):`);
  for (const m of entries) console.log(`  ${m[1]}  [${m[2].replace('_make_', '')}]`);
  for (const n of lib) console.log(`  ${n}  [library]`);
}

if (delName) {
  // 1) built-in solid lambda?
  let src = fs.readFileSync(PHOENIX_PY, 'utf8');
  const esc = delName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRe = new RegExp(`\\n[ \\t]*"${esc}"\\s*:\\s*lambda[^\\n]*`);
  const m = src.match(lineRe);
  if (m) {
    src = src.slice(0, m.index) + src.slice(m.index + m[0].length);
    fs.writeFileSync(PHOENIX_PY, src, 'utf8');
    console.log(`deleted "${delName}" from palette`);
  } else {
    // 2) saved library material?
    const libFile = path.join(PAL_DIR, delName + '.blend');
    if (fs.existsSync(libFile)) {
      fs.unlinkSync(libFile);
      console.log(`deleted "${delName}" from palette library`);
    } else {
      console.error(`ERROR: "${delName}" not found in palette`);
      process.exit(1);
    }
  }
}
