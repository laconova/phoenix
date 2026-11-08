'use strict';
// F2.9: orphaned preview caches. scan() lists them, clean() deletes them. Regular files only (lstat), only directly inside
//   - the poster folder   (PHOENIX_POSTER_CACHE_DIR or ./poster-cache)   <40 hex>.jpg
//   - the brush cache     (brush-to-unreal cacheDir())                    <slug>.glb / <slug>.key
//   - the character previews (character-previews previewDir())            <name>.glb / <name>.key
// Nothing else is ever looked at (never sounds/). A file is an orphan when no live brush / character / staged asset and no trash item names it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bto = require('./brush-to-unreal');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const posterDir = () => process.env.PHOENIX_POSTER_CACHE_DIR || path.join(__dirname, 'poster-cache');

function liveSets() {
  try { return liveSetsStrict(); }
  catch (e) { throw new Error('Cleanup stopped: Phoenix could not read the library (' + String((e && e.message) || e) + '). Nothing was deleted.'); }
}
function liveSetsStrict() {
  const LT = require('./library-trash'), CP = require('./character-previews'), C = require('./characters');
  const posters = new Set(), glbNames = new Set();
  // brushes
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(path.join(bto.brushesDir(), 'registry.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const slug of Object.keys(reg.brushes || {})) {
    glbNames.add(slug);
    const key = bto.brushKey(slug, { strict: true });
    if (key) posters.add(sha1('v2|brush:' + slug + '|' + key) + '.jpg');
  }
  // characters
  for (const c of C.listCharacters({ strict: true })) {
    glbNames.add(c.name);
    const key = CP.characterKey(c.name, { strict: true });
    if (key) posters.add(sha1('v2|character:' + c.name + '|' + key) + '.jpg');
  }
  // staged assets
  for (const f of require('./assistant').listStagedFiles({ strict: true })) {
    let st; try { st = fs.statSync(f.path); } catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }
    posters.add(sha1('v2|asset:' + f.category + '/' + f.name + '|' + st.size + '-' + st.mtimeMs) + '.jpg');
  }
  // the trash keeps what a Restore needs
  for (const it of LT.list({ strict: true })) {
    if (it.poster) posters.add(String(it.poster));
    if (it.kind === 'brush' && it.slug) glbNames.add(String(it.slug));
    if (it.kind === 'character' && it.name) glbNames.add(String(it.name));
  }
  return { posters, glbNames };
}

function regularFiles(dir) {
  let names; try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const file of names) {
    const abs = path.join(dir, file);
    let st; try { st = fs.lstatSync(abs); } catch (_) { continue; }
    if (st.isFile()) out.push({ file, abs, bytes: st.size });
  }
  return out;
}

function scan() {
  const live = liveSets(), items = [];
  const pd = posterDir();
  for (const f of regularFiles(pd)) if (/^[a-f0-9]{40}\.jpg$/.test(f.file) && !live.posters.has(f.file)) items.push({ dir: pd, ...f });
  const caches = [bto.cacheDir(), require('./character-previews').previewDir()];
  for (const dir of caches) {
    for (const f of regularFiles(dir)) {
      const m = /^(.+)\.(glb|key)$/.exec(f.file);
      if (m && !live.glbNames.has(m[1])) items.push({ dir, ...f });
    }
  }
  return { items, count: items.length, bytes: items.reduce((n, i) => n + i.bytes, 0) };
}

function clean() {
  const s = scan(), failed = [];
  let removed = 0, freed = 0;
  for (const it of s.items) {
    try {
      if (!fs.lstatSync(it.abs).isFile()) throw new Error('Not a regular file');
      fs.unlinkSync(it.abs);
      removed++; freed += it.bytes;
    } catch (e) { failed.push({ file: it.file, error: String((e && e.message) || e) }); }
  }
  return { removed, freed, failed };
}
module.exports = { scan, clean };
