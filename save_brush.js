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
// brushes/ is gitignored — seed the .py base + registry on first use.
// Ist die Laufzeitdatei in einem kaputten Zustand (abgeschnitten / ohne Marker), wird
// NICHT gespeichert: ein angehaengtes add_() unter einem zerstoerten Kopf faellt sonst
// erst viel spaeter beim Platzieren als unverstaendlicher Python-Fehler auf.
{
  const _st = ensureBrushScaffold().scaffold || {};
  if (_st.reason === 'version-current-but-truncated' || _st.reason === 'marker-missing') {
    console.error(
      'ABORT: brushes/phoenix_brushes.py is in a broken state (' + _st.reason + '). Nothing was written.\n' +
      'Your brushes are most likely intact in the newest phoenix_brushes.py.bak-* next to it — restore that file first.'
    );
    process.exit(1);
  }
}

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
// Whitelisted, not just lowercased: the category becomes a DIRECTORY under brushes/lib, so an
// unchecked value ('../..') writes the library outside the tree and records the escaped path
// in registry.json. Anything unexpected falls back to 'item' rather than failing the save.
const rawCategory = (get('--category') || 'item').toLowerCase();
const category    = /^[a-z0-9_]{1,32}$/.test(rawCategory) ? rawCategory : 'item';
const displayName = get('--display') || rawName;

if (!rawName) {
  console.error('Usage: node save_brush.js --name <name> [--object <obj>] [--collection <col>] [--category <cat>] [--display <label>]');
  process.exit(1);
}

const slug    = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const libPath = path.join(LIB_DIR, category, `${slug}.blend`);
const libFwd  = libPath.replace(/\\/g, '/');
const force   = args.includes('--force');

// ─── Collision guard ──────────────────────────────────────────────────────────
// The slug is LOSSY: "Oak Tree A", "oak-tree-a" and "Oak Tree-A" all collapse to
// oak_tree_a. Before this guard the save just overwrote — the .blend, the add_()
// function and the registry entry — and reported success, so a brush saved weeks
// ago vanished on a name the user thought was new. Refuse instead, and say what to
// do about it (user decision 2026-07-25). --force is the deliberate way through,
// which is also how you legitimately UPDATE an existing brush.
//
// Checked against the registry AND the file: the function name and the registry key
// are global while the .blend sits under a category folder, so a same-slug save in a
// different category still hijacks the old brush's name and orphans its library file.
function firstFreeSlug(base, taken) {
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  return `${base}_${Date.now()}`;
}

// Registry EINMAL lesen, und zwar bevor irgendetwas geschrieben wird.
// ⚠ Vorher stand hier ein `catch → {}` und weiter unten ein zweites, ungeschuetztes
// JSON.parse derselben Datei. Eine kaputte registry.json hat damit erst still die halbe
// Kollisionswache abgeschaltet (leere Registry = "kein Eintrag da") und ist dann NACH dem
// Schreiben der .blend abgestuerzt — halb gespeicherter Brush, und der zweite Versuch
// wurde mit "existiert bereits" abgewiesen. Kaputt ist deshalb ein Abbruchgrund, fehlend nicht.
let registry = {};
if (fs.existsSync(REGISTRY_FILE)) {
  let rawReg;
  try {
    rawReg = fs.readFileSync(REGISTRY_FILE, 'utf8');
  } catch (e) {
    // Gesperrt (Virenscanner, offener Editor) ist kein Grund fuer einen rohen Stacktrace
    console.error('ABORT: brushes/registry.json could not be read (' + e.message + '). Nothing was written.');
    process.exit(1);
  }
  try {
    registry = JSON.parse(rawReg);
  } catch (e) {
    console.error(
      `ABORT: brushes/registry.json is not valid JSON (${e.message}).\n` +
      `Nothing was written. Fix or delete the file first — saving now would create a brush ` +
      `that no lookup can ever find, and would overwrite an existing one without noticing.`
    );
    process.exit(1);
  }
  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    console.error('ABORT: brushes/registry.json does not contain an object. Nothing was written.');
    process.exit(1);
  }
}

if (!force) {
  const brushes  = registry.brushes || {};
  const existing = brushes[slug];
  const fileInTheWay = fs.existsSync(libPath);

  if (existing || fileInTheWay) {
    // Nicht nur die Registry fragen: liegt eine .blend ohne Eintrag herum (oder umgekehrt),
    // waere der "freie" Vorschlag selbst wieder besetzt.
    const taken = new Set(Object.keys(brushes));
    try {
      for (const cat of fs.readdirSync(LIB_DIR, { withFileTypes: true })) {
        if (!cat.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(LIB_DIR, cat.name))) {
          if (f.toLowerCase().endsWith('.blend')) taken.add(f.replace(/\.blend$/i, ''));
        }
      }
    } catch (_) { /* keine lib/ = nichts zusaetzlich belegt */ }
    const where = existing && existing.category && existing.category !== category
      ? ` — registered under category "${existing.category}", you are saving into "${category}"`
      : '';
    const label = existing && existing.display ? ` ("${existing.display}")` : '';
    console.error(
      `REFUSED: the brush name "${rawName}" becomes "${slug}", which already exists${label}${where}.\n` +
      `Saving would overwrite the existing brush library, its add_${slug}() function and its registry entry — silently and unrecoverably.\n` +
      `Pick one:\n` +
      `  • a different name, e.g. "${firstFreeSlug(slug, taken)}"\n` +
      `  • delete the old brush first (delete_brush ${slug})\n` +
      `  • pass --force / overwrite:true if you MEANT to replace it (this is also how you update a brush)`
    );
    process.exit(1);
  }
}

// ─── Blender IPC ──────────────────────────────────────────────────────────────
// File-based transport via blender-ipc.js (callBlender imported above). Was a 9876
// socket; raw sockets fail cross-process on Windows + Blender 5.1 / Python 3.13.

// ─── Generate add_() function text ────────────────────────────────────────────

function buildAddFn(slug, display, relPath) {
  // relPath is relative from LIB_DIR. Emit it as os.path.join(_LIB_DIR, "a", "b") with
  // forward-slash-split components so the .py resolves on Linux and on Windows alike.
  const parts = relPath.replace(/\\/g, '/').split('/').map(p => JSON.stringify(p)).join(', ');
  // Sanitize display for a Python docstring: a stray triple-quote / backslash / newline in the
  // label would break the docstring and SyntaxError the whole phoenix_brushes.py (every brush
  // stops loading). name= keeps the JSON.stringify'd value, which is already safe.
  const docName = String(display).replace(/[\\"\r\n]/g, ' ').trim() || slug;
  return `
def add_${slug}(x=None, y=None, z=None, name=${JSON.stringify(display)}):
    """${docName} — Phoenix-generated brush. Spawns as a grouped brush under a grab
    handle at the 3D cursor (pass x/y/z to place at explicit coords instead)."""
    lib = os.path.join(_LIB_DIR, ${parts})
    loc = None if (x is None and y is None and z is None) else (x or 0.0, y or 0.0, z or 0.0)
    result = _load_blend(lib, location=loc, instance_name=name)
    print(f"BRUSH_PLACED:{result}")
    return result
`;
}

// ─── Palette auto-add ─────────────────────────────────────────────────────────
// Parse MATINFO from the save output and add any material name not already present
// in _PHOENIX_PALETTE (a mesh reusing an existing palette material is left alone).
function injectPaletteEntries(out) {
  const raw = (out.split(/\r?\n/).find(l => l.startsWith('MATINFO:')) || '').slice('MATINFO:'.length);
  let mats;
  try { mats = JSON.parse(raw || '[]'); } catch { mats = []; }
  if (!mats.length) return;
  const src0 = fs.readFileSync(PHOENIX_PY, 'utf8');
  const open = src0.indexOf('_PHOENIX_PALETTE = {');
  const close = open >= 0 ? src0.indexOf('\n}', open) : -1;
  if (open < 0 || close < 0) { console.log('  palette: dict not found, skipped'); return; }
  const existing = new Set([...src0.slice(open, close).matchAll(/"([^"]+)"\s*:/g)].map(m => m[1]));
  const added = [];
  const lines = [];
  for (const mt of mats) {
    if (existing.has(mt.name) || added.includes(mt.name)) continue;
    const [r, g, b] = mt.color;
    lines.push(mt.kind === 'emission'
      ? `    ${JSON.stringify(mt.name)}: lambda n: _make_emission(n, (${r}, ${g}, ${b}), strength=${mt.strength}),`
      : `    ${JSON.stringify(mt.name)}: lambda n: _make_pbr(n, (${r}, ${g}, ${b}), metallic=${mt.metallic}, rough=${mt.rough}),`);
    added.push(mt.name);
  }
  if (!lines.length) { console.log('  palette: no new materials (all already present)'); return; }
  const src = src0.slice(0, close) + '\n' + lines.join('\n') + src0.slice(close);
  const _pyTmp = PHOENIX_PY + '.tmp-' + process.pid;
  fs.writeFileSync(_pyTmp, src, 'utf8');
  fs.renameSync(_pyTmp, PHOENIX_PY);
  console.log(`  palette += ${added.length}: ${added.join(', ')}`);
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
lib_path = ${JSON.stringify(libFwd)}
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
    import re, json
    pal_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(lib_path))), 'palette_materials')
    os.makedirs(pal_dir, exist_ok=True)
    def _phx_solid(m, r, g, b, metallic, rough, kind, strength):
        return {'name': re.sub(r'\\.\\d+$', '', m.name), 'kind': kind,
                'color': [round(r, 4), round(g, 4), round(b, 4)],
                'metallic': round(metallic, 4), 'rough': round(rough, 4), 'strength': round(strength, 4)}
    def _phx_classify(m):
        # SOLID (flat colour) -> ('solid', info) for a palette lambda.
        # PROCEDURAL (node-driven colour) -> ('proc', None) -> saved as a real material library file.
        if not (m.use_nodes and m.node_tree):
            c = m.diffuse_color
            return ('solid', _phx_solid(m, c[0], c[1], c[2], 0.0, 0.6, 'pbr', 1.0))
        nodes = m.node_tree.nodes
        emis = next((n for n in nodes if n.type == 'EMISSION'), None)
        princ = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if emis is not None:
            if emis.inputs['Color'].is_linked:
                return ('proc', None)
            c = emis.inputs['Color'].default_value
            return ('solid', _phx_solid(m, c[0], c[1], c[2], 0.0, 0.6, 'emission', emis.inputs['Strength'].default_value))
        if princ is not None:
            if princ.inputs['Base Color'].is_linked:
                return ('proc', None)
            c = princ.inputs['Base Color'].default_value; r, g, b = c[0], c[1], c[2]
            metallic = princ.inputs['Metallic'].default_value; rough = princ.inputs['Roughness'].default_value
            kind = 'pbr'; strength = 1.0
            es = princ.inputs.get('Emission Strength'); ec = princ.inputs.get('Emission Color')
            if es is not None and ec is not None and not ec.is_linked and es.default_value > 0.0 and any(ec.default_value[i] > 0.001 for i in range(3)):
                c = ec.default_value; r, g, b = c[0], c[1], c[2]; strength = es.default_value; kind = 'emission'
            return ('solid', _phx_solid(m, r, g, b, metallic, rough, kind, strength))
        return ('proc', None)
    # Namen, die ein Generator vergibt und die NICHTS ueber den Inhalt aussagen.
    # Muss mit _GENERIC_MAT in brushes/phoenix_brushes.py uebereinstimmen.
    _PHX_GENERIC_MAT = re.compile(r'^(Material|Mat|Default|Standard|Untitled)(_?\\d+)?$', re.I)
    _seen = set(); _solids = []; _libmats = []
    _all_objs = list(objs)
    for obj in objs:
        for ps in getattr(obj, 'particle_systems', []):
            io = ps.settings.instance_object
            if io is not None and io not in _all_objs:
                _all_objs.append(io)
            ic = ps.settings.instance_collection
            if ic is not None:
                for co in ic.objects:
                    if co not in _all_objs:
                        _all_objs.append(co)
    for obj in _all_objs:
        for slot in obj.material_slots:
            mm = slot.material
            if not mm:
                continue
            base = re.sub(r'\\.\\d+$', '', mm.name)
            if base in _seen:
                continue
            _seen.add(base)
            # GENERISCHE NAMEN NIE IN DIE GETEILTE PALETTE (Fund 2026-07-13).
            # Trellis nennt JEDES exportierte Material "Material_0" — Stamm, Blatt, Stein.
            # Ein solches Material hat eine Textur an der Base Color, wird also als 'proc'
            # eingestuft und landete als palette_materials/Material_0.blend in der Bibliothek.
            # Damit galt "Material_0" fortan als BENANNTES, GETEILTES Palette-Material, und das
            # Remap beim Spawnen warf alle Staemme und Blaetter auf diesen einen Block zusammen:
            # der Stamm trug die Blatt-Textur. Der Name sagt nichts ueber den Inhalt -> raus.
            # (Das Material bleibt in der Brush-.blend selbst erhalten — nur geteilt wird es nicht.)
            if _PHX_GENERIC_MAT.match(base):
                print('  palette: generisches Material uebersprungen: ' + base)
                continue
            kind, payload = _phx_classify(mm)
            if kind == 'solid':
                _solids.append(payload)
            elif kind == 'proc':
                dst = os.path.join(pal_dir, base + '.blend')
                if not os.path.exists(dst):
                    bpy.data.libraries.write(dst, {mm}, fake_user=True, compress=True)
                    _libmats.append(base)
    print('MATINFO:' + json.dumps(_solids))
    print('LIBMATS:' + json.dumps(_libmats))
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
  }
  src += fnText;
  // Atomic write: assemble the whole file in memory, then tmp+rename. The old code wrote once to strip
  // the stale def and appendFileSync'd again — a crash between the two left phoenix_brushes.py with the
  // brush def gone entirely, and appendFileSync is itself non-atomic (fixed 2026-08-02).
  const _pyTmpAdd = PHOENIX_PY + '.tmp';
  fs.writeFileSync(_pyTmpAdd, src, 'utf8');
  fs.renameSync(_pyTmpAdd, PHOENIX_PY);
  console.log(`  add_${slug}() → phoenix_brushes.py`);

  // Step 2b: solid materials → palette lambdas; procedural materials → real material library.
  injectPaletteEntries(out);
  const libLine = (out.split(/\r?\n/).find(l => l.startsWith('LIBMATS:')) || '').slice('LIBMATS:'.length);
  let libmats = [];
  try { libmats = JSON.parse(libLine || '[]'); } catch (_) { libmats = []; }
  if (libmats.length) console.log(`  palette library += ${libmats.length}: ${libmats.join(', ')}`);

  // Step 3: Register in registry.json — nutzt die oben EINMAL geprüfte Registry.
  // Ein zweites JSON.parse hier war der Absturz nach dem Schreiben (siehe Kommentar oben).
  if (!registry.brushes) registry.brushes = {};
  // Relative paths with forward slashes: registry.json travels with the brush library, so an
  // absolute path recorded on the machine that saved the brush is worthless anywhere else
  // (same class as _LIB_DIR / resolveWorkflowFile). Every install resolves against its own tree.
  const fwd = p => p.replace(/\\/g, '/');
  registry.phoenix_source = fwd(path.relative(__dirname, PHOENIX_PY));
  registry.lib_dir        = fwd(path.relative(__dirname, LIB_DIR));
  registry.brushes[slug]  = {
    type:     'phoenix',
    display:  displayName || slug,
    category,
    fn:       `add_${slug}`,
    lib:      fwd(path.relative(LIB_DIR, libPath)),
    added:    new Date().toISOString().slice(0, 10),
  };
  const _regTmp = REGISTRY_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(_regTmp, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(_regTmp, REGISTRY_FILE);
  console.log(`  '${slug}' → registry.json`);
  console.log(`\n  Done. Say "use brush ${slug}" to place it.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
