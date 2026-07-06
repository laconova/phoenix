'use strict';

/**
 * save_brush.js — Save a Blender object as a Phoenix brush
 *
 * Usage:
 *   node save_brush.js --name <slug> [--object <obj>] [--collection <col>] [--category <cat>] [--display <label>]
 *
 * Source of meshes (first match wins):
 *   --collection <name>  ALL mesh objects in that Blender collection
 *   --object <name>      that single object
 *   (neither)            ALL currently selected mesh objects
 * Saves ONE .blend library file with every mesh (+data+materials); the loader
 * (_load_blend) appends all objects from the lib, so multi-mesh brushes place whole.
 * Appends add_<name>() to phoenix_brushes.py, registers in registry.json.
 */

const fs   = require('fs');
const path = require('path');
const { callBlender } = require('./blender-ipc');
const { ensureBrushScaffold } = require('./brush-scaffold');
ensureBrushScaffold(); // brushes/ is gitignored — seed the .py base + registry on first use

const BRUSHES_DIR   = path.join(__dirname, 'brushes');
const REGISTRY_FILE = path.join(BRUSHES_DIR, 'registry.json');
const PHOENIX_PY    = path.join(BRUSHES_DIR, 'phoenix_brushes.py');
const LIB_DIR       = path.join(BRUSHES_DIR, 'lib');

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get  = k => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] || null) : null; };

const rawName     = get('--name');
const objName     = get('--object') || '';
const colName     = get('--collection') || '';
const category    = (get('--category') || 'item').toLowerCase();
const displayName = get('--display') || rawName;

if (!rawName) {
  console.error('Usage: node save_brush.js --name <name> [--object <obj>] [--collection <col>] [--category <cat>] [--display <label>]');
  process.exit(1);
}

const slug    = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const libPath = path.join(LIB_DIR, category, `${slug}.blend`);
const libFwd  = libPath.replace(/\\/g, '/');

// ─── Blender IPC ──────────────────────────────────────────────────────────────
// File-based transport via blender-ipc.js (callBlender imported above). Was a 9876
// socket; raw sockets fail cross-process on Windows + Blender 5.1 / Python 3.13.

// ─── Generate add_() function text ────────────────────────────────────────────

function buildAddFn(slug, display, relPath) {
  // relPath is relative from LIB_DIR — use os.path.join in Python
  return `
def add_${slug}(x=0, y=0, z=0, name=${JSON.stringify(display)}):
    """${display} — Phoenix-generated brush."""
    lib = os.path.join(_LIB_DIR, r"${relPath}")
    result = _load_blend(lib, location=(x, y, z), instance_name=name)
    print(f"BRUSH_PLACED:{result}")
    return result
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(path.join(LIB_DIR, category), { recursive: true });

  // Step 1: Save .blend from Blender via IPC.
  // Collection > object > selection; ALWAYS a list — a brush may be many meshes
  // (the loader appends every object in the lib, so save must be symmetric).
  // Names go through JSON.stringify: valid Python string literals, apostrophe-safe.
  const pyStr = s => JSON.stringify(s);

  const saveCode = `
import bpy, os
lib_path = r'${libFwd}'
col_name = ${pyStr(colName)}
obj_name = ${pyStr(objName)}
if col_name:
    col = bpy.data.collections.get(col_name)
    objs = [o for o in col.all_objects if o.type == 'MESH'] if col else []
    err = ('ERROR: collection %r not found' % col_name) if not col else ('ERROR: collection %r has no mesh objects' % col_name)
elif obj_name:
    o = bpy.data.objects.get(obj_name)
    objs = [o] if (o and o.type == 'MESH') else []
    err = 'ERROR: object %r not found or not a mesh' % obj_name
else:
    objs = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    err = 'ERROR: no meshes selected — select them, or pass --object/--collection'
if not objs:
    print(err)
else:
    os.makedirs(os.path.dirname(lib_path), exist_ok=True)
    blocks = set()
    for obj in objs:
        blocks.add(obj)
        if obj.data: blocks.add(obj.data)
        for slot in obj.material_slots:
            if slot.material: blocks.add(slot.material)
    bpy.data.libraries.write(lib_path, blocks, fake_user=True, compress=True)
    print('SAVED_BRUSH:' + lib_path + ' (' + str(len(objs)) + ' mesh(es))')
`;

  process.stdout.write(`  Saving .blend → ${libPath} ... `);
  let result;
  try {
    result = await callBlender(saveCode);
  } catch (e) {
    console.error(`\nERROR: ${e.message}`);
    process.exit(1);
  }

  const out = (result.stdout || result.output || '').trim();
  if (!out.includes('SAVED_BRUSH')) {
    console.error(`\nBLENDER ERROR: ${out || JSON.stringify(result)}`);
    process.exit(1);
  }
  console.log('done');

  // Step 2: Append / update add_() in phoenix_brushes.py
  const relPath = path.relative(LIB_DIR, libPath);
  const fnText  = buildAddFn(slug, displayName || slug, relPath);
  let src = fs.readFileSync(PHOENIX_PY, 'utf8');
  const marker = `\ndef add_${slug}(`;
  if (src.includes(marker)) {
    // Remove the old definition before appending the new one
    const start = src.indexOf(marker);
    const nextDef = src.indexOf('\ndef ', start + 1);
    src = src.slice(0, start) + (nextDef >= 0 ? src.slice(nextDef) : '');
    fs.writeFileSync(PHOENIX_PY, src, 'utf8');
  }
  fs.appendFileSync(PHOENIX_PY, fnText, 'utf8');
  console.log(`  add_${slug}() → phoenix_brushes.py`);

  // Step 3: Register in registry.json
  let registry = {};
  if (fs.existsSync(REGISTRY_FILE)) {
    registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  }
  if (!registry.brushes) registry.brushes = {};
  registry.phoenix_source = PHOENIX_PY;
  registry.lib_dir        = LIB_DIR;
  registry.brushes[slug]  = {
    type:     'phoenix',
    display:  displayName || slug,
    category,
    fn:       `add_${slug}`,
    lib:      libPath,
    added:    new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
  console.log(`  '${slug}' → registry.json`);
  console.log(`\n  Done. Say "use brush ${slug}" to place it.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
