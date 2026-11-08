'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const bto = require('./brush-to-unreal'), folders = require('./library-folders'), brushLock = require('./brush-lock');
const staging = () => process.env.PHOENIX_STAGING_DIR || path.join(__dirname, 'staging');
const labelsFile = () => process.env.PHOENIX_LIBRARY_LABELS_FILE || path.join(__dirname, 'library-labels.json');
const posterDir = () => process.env.PHOENIX_POSTER_CACHE_DIR || path.join(__dirname, 'poster-cache');
const json = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
const atomic = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.tmp'; fs.writeFileSync(tmp, data); try { fs.renameSync(tmp, p); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; } };
const save = (p, o) => atomic(p, JSON.stringify(o, null, 2));
function guarded(root, rel, create) {
  const base = path.resolve(root), target = path.resolve(base, rel || '.');
  if (target !== base && !target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) throw new Error('Path outside library');
  let cur = base;
  for (const part of [''].concat(path.relative(base, target).split(path.sep).filter(Boolean))) {
    if (part) cur = path.join(cur, part);
    let st; try { st = fs.lstatSync(cur); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && st.isSymbolicLink()) throw new Error('Library links are refused');
  }
  if (create) fs.mkdirSync(target, { recursive: true });
  return target;
}
const trash = (root, create) => guarded(root, '.trash', create);
const idNow = () => Date.now() + '-' + crypto.randomBytes(4).toString('hex');
function assignment(key, remove) {
  const tree = folders.load(), folder = tree.assignments[key] || null;
  if (remove) { const r = folders.apply({ action: 'assign', key, folder: null }); if (!r.ok) throw new Error(r.error); }
  return folder;
}
function restoreFolder(key, folder) { if (folder && folders.load().folders.some(f => f.id === folder)) folders.apply({ action: 'assign', key, folder }); }
function move(from, to) { if (!fs.existsSync(from)) return; fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
function trashAsset(category, name) {
  try {
    if (!category || !name || path.basename(category) !== category || path.basename(name) !== name || category.startsWith('.') || !/\.glb$/i.test(name)) throw new Error('Invalid asset name');
    const source = guarded(staging(), category + '/' + name);
    if (!fs.existsSync(source)) throw new Error('Asset not found');
    const dir = trash(staging(), true), id = idNow(), rel = id + '/' + category + '/' + name;
    const labels = json(labelsFile(), { assets: {} }), key = category + '/' + name;
    labels.assets = labels.assets || {};
    const item = { id, kind: 'asset', name, category, at: new Date().toISOString(), rel, label: labels.assets[key], folder: assignment('asset:' + key, false) };
    const index = json(path.join(dir, 'index.json'), []);
    // the asset moves first, but a failed index write puts it back (otherwise it is hidden in .trash and the next Empty deletes it)
    let movedTo = null;
    try { move(source, path.join(dir, rel)); movedTo = path.join(dir, rel); index.push(item); save(path.join(dir, 'index.json'), index); }
    catch (e) {
      try {
        if (movedTo && fs.existsSync(movedTo)) {
          if (fs.existsSync(source)) {   // a new file took the old name meanwhile: the trashed bytes stay (listed again if the index allows), nothing is deleted
            try { save(path.join(dir, 'index.json'), index.indexOf(item) >= 0 ? index : index.concat([item])); } catch (_) { /* the files stay in the trash folder */ }
            throw new Error('A new file named ' + name + ' appeared while it was being moved to the trash. The old one is kept in the trash folder (' + path.join(dir, id) + ').');
          }
          move(movedTo, source);
        }
        fs.rmSync(path.join(dir, id), { recursive: true, force: true });
      } catch (re) { if (/appeared while it was being moved/.test(re.message)) throw re; throw new Error(e.message + '; undo: ' + re.message); }
      throw e;
    }
    delete labels.assets[key]; save(labelsFile(), labels); assignment('asset:' + key, true);
    return { ok: true, id };
  } catch (e) { return { ok: false, error: e.message }; }
}
// F2.5: the brush files belong to one writer at a time — the CLI save holds the same lock, so this waits for nothing and refuses instead
function trashBrush(slug) { return brushLock.withLock(() => trashBrushLocked(slug)); }
function trashBrushLocked(slug) {
  let rollback = () => {}, cleanup = () => {};
  try {
    if (!/^[a-z0-9_]+$/i.test(slug || '')) throw new Error('Invalid brush slug');
    const root = bto.brushesDir(), rp = path.join(root, 'registry.json'), py = path.join(root, 'phoenix_brushes.py');
    const reg = json(rp, {}), entry = reg.brushes && reg.brushes[slug];
    if (!entry) throw new Error('Brush not found');
    const id = idNow() + '-' + slug, dir = guarded(trash(root, true), id, true);
    const regBytes = fs.readFileSync(rp);
    cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const src = fs.readFileSync(py, 'utf8'), block = bto.brushDefBlock(src, slug), key = bto.brushKey(slug);
    const lib = String(entry.lib || '').replace(/\\/g, '/').replace(/^.*brushes\/lib\//, '');
    const libFile = guarded(path.join(root, 'lib'), lib);
    const hasLib = libFile !== path.resolve(root, 'lib') && fs.existsSync(libFile) && fs.statSync(libFile).isFile();
    const stat = hasLib ? fs.statSync(libFile) : null;
    const poster = posterName(slug, key);   // F2.7e: the same v2 name the poster cache uses
    const manifest = { id, kind: 'brush', slug, name: entry.display || slug, at: new Date().toISOString(), entry, folder: assignment('brush:' + slug, false), lib, mtime: stat && stat.mtimeMs, poster };
    atomic(path.join(dir, 'fn.py'), block); save(path.join(dir, 'manifest.json'), manifest);
    const moved = [];
    let pyWritten = false, regWritten = false;
    rollback = () => {
      for (const [from, to] of moved.reverse()) move(to, from);
      if (pyWritten) atomic(py, src);
      if (regWritten) atomic(rp, regBytes);
      restoreFolder('brush:' + slug, manifest.folder);
    };
    atomic(py, src.replace(block, '')); pyWritten = true;
    delete reg.brushes[slug]; save(rp, reg); regWritten = true;
    const transfer = (from, to) => { if (fs.existsSync(from)) { move(from, to); moved.push([from, to]); } };
    if (hasLib) transfer(libFile, path.join(dir, path.basename(lib)));
    for (const ext of ['glb', 'key']) transfer(path.join(bto.cacheDir(), slug + '.' + ext), path.join(dir, slug + '.' + ext));
    transfer(guarded(posterDir(), poster), path.join(dir, poster));
    assignment('brush:' + slug, true);
    return { ok: true, id };
  } catch (e) { try { rollback(); cleanup(); } catch (re) { return { ok: false, error: e.message + '; rollback: ' + re.message }; } return { ok: false, error: e.message }; }
}
// ── R5a: characters + custom rig folders. Everything is MOVED (rename), never copied + unlinked, never unlinked ──
const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
const charPoster = (name, key) => crypto.createHash('sha1').update('v2|character:' + name + '|' + key).digest('hex') + '.jpg';
// sha256 in 1 MB chunks (bounded memory: a character .blend can be ~70 MB); same digest as hashing the whole file at once
function fileSha(p) {
  const h = crypto.createHash('sha256'), buf = Buffer.alloc(1 << 20); let fd = null;
  try { fd = fs.openSync(p, 'r'); let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
  return h.digest('hex');
}
// where a trashed character file belongs again, by what it is
function charHome(file, name) {
  const C = require('./characters'), CP = require('./character-previews');
  if (file === name + '.blend' || file === name + '.sig.json') return path.join(C.CHAR_DIR, file);
  if (file === name + '.glb' || file === name + '.key') return path.join(CP.previewDir(), file);
  if (/^[0-9a-f]{40}\.jpg$/.test(file)) return guarded(posterDir(), file);
  throw new Error('Unexpected file in the trash entry: ' + file);
}
// undo a list of [from, to] moves (newest first); never throws. -> the moves that could NOT be undone
function undoMoves(moved) {
  const stuck = [];
  for (const [from, to] of moved.slice().reverse()) { try { move(to, from); } catch (e) { stuck.push([from, to, e.message]); } }
  return stuck;
}
// "<file> is at home, <file> is in the trash (<dir>)" for every file of an entry - what a user needs to finish by hand
function whereAre(bases, homeOf, trashDir) {
  return bases.map((b) => {
    let home = null; try { home = homeOf(b); } catch (_) { home = null; }
    return b + (home && fs.existsSync(home) ? ' is at home (' + path.dirname(home) + ')' : fs.existsSync(path.join(trashDir, b)) ? ' is in the trash (' + trashDir + ')' : ' is missing');
  }).join(', ');
}
function trashCharacter(name) {
  const moved = []; let dir = null, manifest = null, assigned = false, bases = [];
  try {
    const C = require('./characters'), CP = require('./character-previews');
    const abs = C.charPath(name);
    if (!abs || C.safeCharName(name) !== String(name)) throw new Error('Invalid character name');
    if (!fs.existsSync(abs)) throw new Error('Character not found');
    const id = idNow() + '-' + slugOf(name);
    dir = guarded(trash(C.CHAR_DIR, true), id, true);
    const key = CP.characterKey(name), posterFile = key ? charPoster(name, key) : null;
    const sources = [[abs, name + '.blend'], [abs.replace(/\.blend$/i, '.sig.json'), name + '.sig.json'],
      [path.join(CP.previewDir(), name + '.glb'), name + '.glb'], [path.join(CP.previewDir(), name + '.key'), name + '.key']];
    if (posterFile) sources.push([guarded(posterDir(), posterFile), posterFile]);
    const present = sources.filter(([from]) => fs.existsSync(from));
    bases = present.map(([, base]) => base);
    const hashes = {}; for (const [from, base] of present) hashes[base] = fileSha(from);
    manifest = { id, kind: 'character', name, at: new Date().toISOString(), files: bases, hashes, key, poster: posterFile && bases.includes(posterFile) ? posterFile : null, folder: assignment('character:' + name, false) };
    save(path.join(dir, 'manifest.json'), manifest);
    for (const [from, base] of present) { move(from, path.join(dir, base)); moved.push([from, path.join(dir, base)]); }
    assignment('character:' + name, true); assigned = true;
    return { ok: true, id };
  } catch (e) {
    const stuck = undoMoves(moved);
    if (stuck.length) {   // never rm a trash dir that still holds a file: the entry stays listed so the user can restore it
      return { ok: false, error: e.message + '; the character is split: ' + bases.map((b) => b + (stuck.some((s) => path.basename(s[1]) === b) ? ' is in the trash (' + dir + ')' : ' is at home')).join(', ') + '. Restore it from Library > Trash to finish.' };
    }
    try { if (assigned && manifest) restoreFolder('character:' + manifest.name, manifest.folder); if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (re) { return { ok: false, error: e.message + '; cleanup: ' + re.message }; }
    return { ok: false, error: e.message };
  }
}
// R5b: sounds (takes of sounds/vo and clips of sounds/sfx). items = 1..200 of { dir: 'vo'|'sfx', file }. All-or-nothing: any bad item refuses
// the whole call before anything moves. A vo take brings its <x>_raw.wav sibling along. Trash = <SOUNDS_ROOT>/.trash/<id>/<dir>/<file>.
const soundsRoot = () => require('./voice').SOUNDS_ROOT;
const SOUND_DIRS = ['vo', 'sfx'];
function soundFileOk(dir, file) {
  return SOUND_DIRS.includes(dir) && typeof file === 'string' && file === path.basename(file) && file !== '' && !file.startsWith('.') && /\.wav$/i.test(file);
}
function trashSounds(items) {
  const moved = []; let dir = null, files = [];
  try {
    if (!Array.isArray(items) || items.length < 1 || items.length > 200) throw new Error('Pick between 1 and 200 sounds.');
    const root = soundsRoot(), seen = new Set(), picked = [];
    for (const it of items) {
      if (!it || typeof it !== 'object' || !soundFileOk(it.dir, it.file)) throw new Error('Invalid sound: ' + (it && typeof it === 'object' ? String(it.dir) + '/' + String(it.file) : String(it)));
      const key = it.dir + '/' + it.file;
      const abs = guarded(path.join(root, it.dir), it.file);
      let st = null; try { st = fs.lstatSync(abs); } catch (_) { st = null; }
      if (!st || !st.isFile()) throw new Error('Sound not found: ' + it.file);
      if (seen.has(key)) continue;
      seen.add(key); picked.push({ dir: it.dir, file: it.file });
    }
    const all = [];
    const add = (d, f) => { if (!all.some((x) => x.dir === d && x.file === f)) all.push({ dir: d, file: f }); };
    for (const it of picked) {
      add(it.dir, it.file);
      if (it.dir === 'vo' && !/_raw\.wav$/i.test(it.file)) {
        const sib = it.file.replace(/\.wav$/i, '_raw.wav');
        let st = null; try { st = fs.lstatSync(guarded(path.join(root, 'vo'), sib)); } catch (_) { st = null; }
        if (st && st.isFile()) add('vo', sib);
      }
    }
    const id = idNow();
    dir = guarded(trash(root, true), id, true);
    files = all.map((x) => ({ dir: x.dir, file: x.file, sha256: fileSha(guarded(path.join(root, x.dir), x.file)) }));
    const manifest = { id, kind: 'sound', name: picked.length === 1 ? picked[0].file : picked.length + ' sounds', at: new Date().toISOString(), files };
    save(path.join(dir, 'manifest.json'), manifest);
    for (const x of all) { const from = guarded(path.join(root, x.dir), x.file), to = path.join(dir, x.dir, x.file); move(from, to); moved.push([from, to]); }
    return { ok: true, id, files: all.map((x) => x.dir + '/' + x.file) };
  } catch (e) {
    const stuck = undoMoves(moved);
    if (stuck.length) {   // a trash dir that still holds a file stays, so the entry can be restored
      return { ok: false, error: e.message + '; the sounds are split: ' + files.map((f) => f.file + (stuck.some((s) => s[1] === path.join(dir, f.dir, f.file)) ? ' is in the trash (' + path.join(dir, f.dir) + ')' : ' is at home')).join(', ') + '. Restore it from Library > Trash to finish.' };
    }
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (re) { return { ok: false, error: e.message + '; cleanup: ' + re.message }; }
    return { ok: false, error: e.message };
  }
}
function restoreSound(item, id) {
  const root = soundsRoot(), dir = guarded(trash(root), id), files = Array.isArray(item.files) ? item.files : [];
  if (!files.length || !files.every((f) => f && soundFileOk(f.dir, f.file))) throw new Error('Invalid trash manifest');
  // 1. PLAN, nothing moves
  const todo = [];
  for (const f of files) {
    const from = guarded(dir, f.dir + '/' + f.file), to = guarded(path.join(root, f.dir), f.file);
    if (fs.existsSync(from)) {
      if (fs.existsSync(to)) {
        if (f.sha256 && fileSha(to) === f.sha256) continue;   // already restored (by hand or an earlier run): the trash copy goes with the entry
        return { ok: false, clash: true, error: 'A sound with that name already exists: ' + f.file };
      }
      todo.push([from, to]);
    } else if (!(fs.existsSync(to) && f.sha256 && fileSha(to) === f.sha256)) {
      return { ok: false, error: f.file + ' is missing: it is neither in the trash entry nor at home - nothing was restored.' };
    }
  }
  // 2. MOVE; a failure undoes this run's moves
  const moved = [];
  try { for (const [from, to] of todo) { move(from, to); moved.push([from, to]); } }
  catch (e) {
    const stuck = undoMoves(moved);
    if (!stuck.length) return { ok: false, error: 'Could not restore ' + item.name + ': ' + e.message + ' - nothing was changed, try again.' };
    return { ok: false, error: 'Could not restore ' + item.name + ': ' + e.message + '; the sounds are split: ' + whereAre(files.map((f) => f.dir + '/' + f.file), (b) => guarded(path.join(root, path.dirname(b)), path.basename(b)), dir) + '. The trash entry stays - restore it again to finish.' };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}
function trashCustomRig(name) {
  let dir = null, from = null, to = null;
  try {
    const R = require('./custom_rig');
    const abs = R.folderPath(name);
    if (!abs || R.safeFolder(name) !== String(name)) throw new Error('Invalid folder name');
    if (!fs.existsSync(abs)) throw new Error('Folder not found');
    const id = idNow() + '-' + slugOf(name);
    dir = guarded(trash(R.CUSTOM_DIR, true), id, true);
    save(path.join(dir, 'manifest.json'), { id, kind: 'customrig', name, at: new Date().toISOString() });
    from = abs; to = path.join(dir, name);
    fs.renameSync(from, to);
    return { ok: true, id };
  } catch (e) {
    try { if (to && !fs.existsSync(from) && fs.existsSync(to)) fs.renameSync(to, from); if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (re) { return { ok: false, error: e.message + '; rollback: ' + re.message }; }
    return { ok: false, error: e.message };
  }
}
function restoreCharacter(item, id) {
  const C = require('./characters'), CP = require('./character-previews');
  const dir = guarded(trash(C.CHAR_DIR), id), name = item.name, abs = C.charPath(name);
  if (!abs || C.safeCharName(name) !== name) throw new Error('Invalid trash manifest');
  const bases = item.files || [], hashes = item.hashes && typeof item.hashes === 'object' ? item.hashes : null;
  const clash = { ok: false, clash: true, error: 'A character with that name already exists.' };
  // 1. PLAN, nothing moves: every file is in the trash (its home is free, or holds the same bytes) or already home with the manifest bytes
  const todo = [];
  for (const base of bases) {
    const from = guarded(dir, base), to = charHome(base, name);
    if (fs.existsSync(from)) {
      if (fs.existsSync(to)) {
        if (hashes && hashes[base] && fileSha(to) === hashes[base]) continue;   // restored by an earlier partial run: the trash copy goes with the entry
        if (/\.blend$/.test(base)) return clash;                                // a different .blend under the name
        if (/\.jpg$/.test(base)) continue;                                      // a poster that is already there stays
      }
      todo.push([from, to]);
    } else if (hashes) {
      if (!(fs.existsSync(to) && hashes[base] && fileSha(to) === hashes[base])) return { ok: false, error: base + ' is missing: it is neither in the trash entry nor at home - nothing was restored.' };
    }
  }
  // 2. MOVE; a failure undoes this run's moves, and if even that fails the entry stays with an exact list
  const moved = [];
  try { for (const [from, to] of todo) { move(from, to); moved.push([from, to]); } }
  catch (e) {
    const stuck = undoMoves(moved);
    if (!stuck.length) return { ok: false, error: 'Could not restore ' + name + ': ' + e.message + ' - nothing was changed, try again.' };
    return { ok: false, error: 'Could not restore ' + name + ': ' + e.message + '; the character is split: ' + whereAre(bases, (b) => charHome(b, name), dir) + '. The trash entry stays - restore it again to finish.' };
  }
  restoreFolder('character:' + name, item.folder);
  fs.rmSync(dir, { recursive: true, force: true });
  try { CP.kick('restore'); } catch (_) { /* previews are optional */ }
  return { ok: true };
}
function restoreCustomRig(item, id) {
  const R = require('./custom_rig');
  const dir = guarded(trash(R.CUSTOM_DIR), id), name = item.name, target = R.folderPath(name);
  if (!target || R.safeFolder(name) !== name) throw new Error('Invalid trash manifest');
  if (fs.existsSync(target)) return { ok: false, clash: true, error: 'A rig folder with that name already exists.' };
  try { fs.renameSync(guarded(dir, name), target); }
  catch (e) { return { ok: false, error: 'Could not restore the rig folder ' + name + ': ' + e.message + ' - the trash entry stays, try again.' }; }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}
// ── R4e: snapshot of a live brush before an overwrite (copies, never moves) ──
const posterName = (slug, key) => crypto.createHash('sha1').update('v2|brush:' + slug + '|' + key).digest('hex') + '.jpg';
const libRel = (entry) => String((entry && entry.lib) || '').replace(/\\/g, '/').replace(/^.*brushes\/lib\//, '');
// canonical absolute path of a registry entry's library (inside <brushes>/lib), or null
const winCase = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const samePath = (a, b) => !!a && !!b && winCase(path.normalize(path.resolve(a))) === winCase(path.normalize(path.resolve(b)));
function libPathOf(entry) {
  const rel = libRel(entry); if (!rel) return null;
  const root = path.resolve(bto.brushesDir(), 'lib'), abs = path.normalize(path.resolve(root, rel));
  const r = winCase(root), a = winCase(abs);
  return a !== r && a.startsWith(r.endsWith(path.sep) ? r : r + path.sep) ? abs : null;
}
function libUsers(absPath, exceptSlug) {
  const reg = json(path.join(bto.brushesDir(), 'registry.json'), {}), out = [];
  for (const k of Object.keys(reg.brushes || {})) if (k !== exceptSlug && samePath(libPathOf(reg.brushes[k]), absPath)) out.push(k);
  return out;
}
// a brush trash entry is incomplete when fn.py or (if the manifest says there was a lib) the .blend is missing
function missingParts(item, dir) {
  const miss = [];
  if (!fs.existsSync(path.join(dir, 'fn.py'))) miss.push('fn.py');
  if (item.mtime != null && item.lib && !fs.existsSync(path.join(dir, path.basename(item.lib)))) miss.push(path.basename(item.lib));
  return miss;
}
const stampNow = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); };
function copyKeep(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = to + '.tmp-' + process.pid; const st = fs.statSync(from);
  try { fs.copyFileSync(from, tmp); try { fs.utimesSync(tmp, st.atime, st.mtime); } catch (_) {} try { fs.renameSync(tmp, to); } catch (e) { if (e.code === 'EEXIST' || e.code === 'EPERM') { fs.unlinkSync(to); fs.renameSync(tmp, to); } else throw e; } }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
}
function snapshotBrush(slug) {
  let dir = null;
  try {
    if (!/^[a-z0-9_]+$/i.test(slug || '')) throw new Error('Invalid brush slug');
    const root = bto.brushesDir(), rp = path.join(root, 'registry.json'), py = path.join(root, 'phoenix_brushes.py');
    const reg = json(rp, {}), entry = reg.brushes && reg.brushes[slug];
    if (!entry) throw new Error('Brush not found');
    const id = idNow() + '-' + slug; dir = guarded(trash(root, true), id, true);
    const lib = libRel(entry), libFile = guarded(path.join(root, 'lib'), lib);
    const hasLib = libFile !== path.resolve(root, 'lib') && fs.existsSync(libFile) && fs.statSync(libFile).isFile();
    const stat = hasLib ? fs.statSync(libFile) : null;
    const copyNamed = (from, to) => { try { fs.copyFileSync(from, to); } catch (e) { throw new Error('could not copy ' + path.basename(from) + ': ' + e.message); } };   // F2.7b
    if (hasLib) { const to = path.join(dir, path.basename(lib)); copyNamed(libFile, to); try { fs.utimesSync(to, stat.atime, stat.mtime); } catch (_) {} }
    let src = ''; try { src = fs.readFileSync(py, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    atomic(path.join(dir, 'fn.py'), bto.brushDefBlock(src, slug));
    for (const ext of ['glb', 'key']) { const f = path.join(bto.cacheDir(), slug + '.' + ext); if (fs.existsSync(f)) copyNamed(f, path.join(dir, slug + '.' + ext)); }
    const key = bto.brushKey(slug), poster = key ? posterName(slug, key) : null;
    if (poster) { const pf = guarded(posterDir(), poster); if (fs.existsSync(pf)) copyNamed(pf, path.join(dir, poster)); }
    const display = entry.display || slug;
    const manifest = { id, kind: 'brush', slug, name: display + ' (replaced ' + stampNow() + ')', display, at: new Date().toISOString(), entry, folder: assignment('brush:' + slug, false), lib, mtime: stat && stat.mtimeMs, poster, replaced: true };
    save(path.join(dir, 'manifest.json'), manifest);
    return { ok: true, id, dir };
  } catch (e) { if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} return { ok: false, error: e.message }; }
}
// atomic discard: rename out of the list first, then delete (a half-failed delete never leaves a half-empty entry listed)
function discard(dir) {
  const gone = path.join(path.dirname(dir), '.gone-' + path.basename(dir));
  try { fs.rmSync(gone, { recursive: true, force: true }); } catch (_) {}
  try { fs.renameSync(dir, gone); } catch (e) { return { ok: false, error: e.message }; }
  try { fs.rmSync(gone, { recursive: true, force: true }); } catch (e) { return { ok: true, warning: e.message }; }
  return { ok: true };
}
function removeSnapshot(id) {
  try {
    if (!/^[0-9]+-[0-9a-f]{8}-[a-z0-9_]+$/i.test(id || '')) throw new Error('Invalid snapshot id');
    const r = discard(guarded(trash(bto.brushesDir()), id));
    return r.ok ? (r.warning ? { ok: true, warning: r.warning } : { ok: true }) : { ok: false, error: r.error };
  } catch (e) { return { ok: false, error: e.message }; }
}
// restoring a "replaced" snapshot while the slug is live: the live version becomes a new snapshot, the trashed one goes live
function swapRestore(item, odir, root) {
  const rp = path.join(root, 'registry.json'), py = path.join(root, 'phoenix_brushes.py');
  const snap = snapshotBrush(item.slug);
  if (!snap.ok) return { ok: false, error: 'Could not keep the current version in the trash (' + snap.error + ') — nothing was restored.' };
  // reserve the trash entry before anything is consumed: from here on every file is taken from the reserved dir
  const dir = path.join(path.dirname(odir), '.reserved-' + path.basename(odir));
  if (fs.existsSync(dir)) { removeSnapshot(snap.id); return { ok: false, error: 'The trash entry is in use (a previous restore left it reserved) — nothing was restored.' }; }
  try { fs.renameSync(odir, dir); }
  catch (e) { removeSnapshot(snap.id); return { ok: false, error: 'The trash entry is in use (' + e.message + ') — nothing was restored.' }; }
  const undo = [];
  try {
    const pyOrig = fs.readFileSync(py, 'utf8'), regBytes = fs.readFileSync(rp);
    const reg = JSON.parse(regBytes.toString('utf8')), cur = reg.brushes[item.slug];
    const libRoot = path.join(root, 'lib'), target = guarded(libRoot, item.lib), curLib = guarded(libRoot, libRel(cur));
    const snapLib = path.join(snap.dir, path.basename(libRel(cur))), trashLib = path.join(dir, path.basename(item.lib));
    const hasTarget = target !== path.resolve(libRoot) && fs.existsSync(trashLib);
    const sameAsCur = samePath(target, curLib);
    if (hasTarget && fs.existsSync(target)) {
      const users = libUsers(target, item.slug);
      if (users.length) throw new Error('The library file ' + item.lib + ' is used by "' + users[0] + '" — nothing was restored.');
      if (!sameAsCur) throw new Error('A different file is in the way at ' + item.lib);
    }
    if (hasTarget) {
      // the current lib goes away only when the restored one replaces it and no other brush still references it
      if (curLib !== path.resolve(libRoot) && fs.existsSync(curLib) && (sameAsCur || !libUsers(curLib, item.slug).length)) { fs.unlinkSync(curLib); undo.push(() => { if (fs.existsSync(snapLib)) copyKeep(snapLib, curLib); }); }
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(trashLib, target); undo.push(() => move(target, trashLib));
    }
    for (const ext of ['glb', 'key']) {
      const live = path.join(bto.cacheDir(), item.slug + '.' + ext), tr = path.join(dir, item.slug + '.' + ext), sc = path.join(snap.dir, item.slug + '.' + ext);
      const back = () => { if (fs.existsSync(sc)) copyKeep(sc, live); };
      if (fs.existsSync(tr)) { if (fs.existsSync(live)) fs.unlinkSync(live); undo.push(back); move(tr, live); undo.push(() => move(live, tr)); }
      else if (fs.existsSync(live)) { fs.unlinkSync(live); undo.push(back); }
    }
    if (item.poster) {
      const tr = path.join(dir, item.poster), dest = guarded(posterDir(), item.poster);
      if (fs.existsSync(tr) && !fs.existsSync(dest)) { move(tr, dest); undo.push(() => move(dest, tr)); }
    }
    const block = bto.brushDefBlock(pyOrig, item.slug), fn = fs.readFileSync(path.join(dir, 'fn.py'), 'utf8');
    const stripped = block ? pyOrig.replace(block, '') : pyOrig;
    undo.push(() => atomic(py, pyOrig));
    atomic(py, stripped + (stripped.endsWith('\n') ? '' : '\n') + fn);
    reg.brushes[item.slug] = item.entry;
    save(rp, reg);
    undo.push(() => atomic(rp, regBytes));
  } catch (e) {
    let rbErr = null;
    for (const u of undo.reverse()) { try { u(); } catch (re) { rbErr = rbErr || re; } }
    try { fs.renameSync(dir, odir); } catch (re) { rbErr = rbErr || re; }
    if (rbErr) return { ok: false, error: e.message + '; rollback failed (' + rbErr.message + ') — the current version is kept in the trash (Library › Trash).' };
    removeSnapshot(snap.id);
    return { ok: false, error: e.message };
  }
  // committed: py + registry are final. Cleanup of the restored trash entry must never undo it (a hidden leftover is retried by list()).
  try { require('./brush-previews').kick('restore'); } catch (_) {}
  // reserved -> committed deletion (.gone-) -> rm; a failed rename falls back to rm of the reserved dir
  const gone = path.join(path.dirname(odir), '.gone-' + path.basename(odir));
  let target = dir;
  try { fs.rmSync(gone, { recursive: true, force: true }); } catch (_) {}
  try { fs.renameSync(dir, gone); target = gone; } catch (_) {}
  try { fs.rmSync(target, { recursive: true, force: true }); }
  catch (e) { return { ok: true, swapped: true, id: snap.id, warning: 'Restored, but the old trash entry could not be removed (' + e.message + ').' }; }
  return { ok: true, swapped: true, id: snap.id };
}
// ── R6: boards in the storyboard trash (<storyboards>/_trash/<boardId>-<17-digit UTC stamp>.json, written by storyboard.trashBoard) ──
const SB_TRASH_FILE = /^([a-z0-9]{6})-(\d+)\.json$/;
const SB_TITLE_MAX = 80, SB_READ_MAX = 4 * 1024 * 1024;
const sbTrashDir = () => require('./storyboard').TRASH_DIR;
function sbStampIso(stamp, file) {   // '20261023090653946' -> ISO; anything else -> the file's mtime
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(stamp);
  if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7])); if (!isNaN(d.getTime())) return d.toISOString(); }
  try { return fs.statSync(file).mtime.toISOString(); } catch (_) { return new Date(0).toISOString(); }
}
function sbTrashItems() {
  const out = [];
  try {
    const dir = sbTrashDir();
    for (const n of fs.readdirSync(dir)) {
      const m = SB_TRASH_FILE.exec(n); if (!m) continue;
      const file = path.join(dir, n);
      let st; try { st = fs.lstatSync(file); } catch (_) { continue; }
      if (!st.isFile()) continue;
      let name = 'Storyboard';
      try { if (st.size <= SB_READ_MAX) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j.title === 'string' && j.title.trim()) name = j.title.trim().slice(0, SB_TITLE_MAX); } } catch (_) { /* a board file we cannot read keeps the plain name */ }
      out.push({ id: 'storyboard:' + m[1], kind: 'storyboard', board: m[1], file: n, name, at: sbStampIso(m[2], file) });
    }
  } catch (_) { /* no storyboard trash yet */ }
  return out;
}
// the *.json files directly in the storyboard trash (what Empty trash removes); a link is refused like everywhere else in the trash
function sbTrashFiles() {
  let names; try { names = fs.readdirSync(sbTrashDir()); } catch (_) { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => path.join(sbTrashDir(), n)).filter((p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error('Trash links are refused');
    return st.isFile();
  });
}
function list({cfg, noLive, strict} = {}) {   // noLive: skip the registry read of the live flag (restore() only needs the item, and must not read the registry before it holds the lock)
  const items = [];
  // retry the cleanup of hidden .gone-* leftovers (failed deletes / aborted reservations); errors ignored
  const sweep = (get) => { try { const d = get(); for (const n of fs.readdirSync(d)) if (n.startsWith('.gone-')) { try { fs.rmSync(path.join(d, n), { recursive: true, force: true }); } catch (_) {} } } catch (_) {} };
  sweep(() => trash(bto.brushesDir())); sweep(() => trash(require('./levels').root(cfg)));
  // strict (cache cleanup): a real read error (not "folder not there") aborts instead of looking like an empty trash
  const soft = (e) => { if (strict && e && e.code && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; };
  try { items.push(...json(path.join(trash(staging()), 'index.json'), [])); } catch (e) { soft(e); }
  // a reserved entry (.reserved-<name>) without a committed deletion is a crashed/failed restore: recover it, never sweep it
  try { const d = trash(bto.brushesDir()); for (const n of fs.readdirSync(d)) if (n.startsWith('.reserved-')) { const orig = path.join(d, n.slice('.reserved-'.length)); if (!fs.existsSync(orig)) { try { fs.renameSync(path.join(d, n), orig); } catch (_) {} } } } catch (_) {}
  // F2.7c: a brush item says whether its slug is registered now (a replaced snapshot of a gone slug is a plain Restore, not a swap)
  let liveSlugs = new Set(); if (!noLive) try { liveSlugs = new Set(Object.keys(json(path.join(bto.brushesDir(), 'registry.json'), {}).brushes || {})); } catch (_) {}
  const brushItem = (m) => { if (m && m.kind === 'brush') m.live = liveSlugs.has(m.slug); return m; };
  try { const dir = trash(bto.brushesDir()); for (const name of fs.readdirSync(dir)) { if (name.startsWith('.gone-')) continue; if (name.startsWith('.reserved-')) { const p = path.join(dir, name); try { const m = json(path.join(p, 'manifest.json'), null); if (m) items.push(brushItem(m)); } catch (_) {} continue; } const p = guarded(dir, name); if (fs.lstatSync(p).isDirectory()) { const m = json(path.join(p, 'manifest.json'), null); if (m) items.push(brushItem(m)); } } } catch (e) { soft(e); }
  try { const dir = trash(require('./levels').root(cfg)); for (const n of fs.readdirSync(dir)) { if (n.startsWith('.gone-')) continue; const p = guarded(dir,n); if (fs.lstatSync(p).isDirectory()) { const m = json(guarded(p,'manifest.json'),null); if (m && ['level','scene'].includes(m.kind)) items.push(m); } } } catch (e) { soft(e); }
  // R5a: characters (<characters>/.trash/<id>/manifest.json) and custom rig folders (<custom-rigs>/.trash/<id>/manifest.json)
  const readKind = (get, kind) => { try { const dir = trash(get()); for (const n of fs.readdirSync(dir)) { if (n.startsWith('.gone-')) continue; const p = guarded(dir, n); if (fs.lstatSync(p).isDirectory()) { const m = json(guarded(p, 'manifest.json'), null); if (m && m.kind === kind) items.push(m); } } } catch (e) { soft(e); } };
  readKind(() => require('./characters').CHAR_DIR, 'character'); readKind(() => require('./custom_rig').CUSTOM_DIR, 'customrig');
  readKind(soundsRoot, 'sound');
  items.push(...sbTrashItems());
  return items.sort((a, b) => b.at.localeCompare(a.at));
}
function restore(id, {cfg} = {}) {
  try {
    const item = list({cfg, noLive: true}).find(x => x.id === id);
    if (!item) return { ok: false, error: 'Trash item not found' };
    if (item.kind === 'level' || item.kind === 'scene') {
      const L = require('./levels'); if (!L.slugOk(item.slug) || (item.kind === 'scene' && !L.slugOk(item.scene))) throw new Error('Invalid trash manifest');
      const base = L.root(cfg), dir = guarded(trash(base),id), rel = item.kind === 'level' ? item.slug : item.slug + '/scenes/' + item.scene + '.blend';
      const target = guarded(base,rel);
      if (fs.existsSync(target)) return {ok:false,clash:true,error:'That name already exists.'};
      if (item.kind === 'scene' && !fs.existsSync(guarded(base,item.slug + '/level.blend'))) return {ok:false,error:'The level is missing.'};
      const source = guarded(dir,item.kind === 'level' ? item.slug : item.scene + '.blend'); checkTree(source); move(source,target); fs.rmSync(dir,{recursive:true});
    } else if (item.kind === 'character') {
      return restoreCharacter(item, id);
    } else if (item.kind === 'customrig') {
      return restoreCustomRig(item, id);
    } else if (item.kind === 'sound') {
      return restoreSound(item, id);
    } else if (item.kind === 'storyboard') {
      const r = require('./storyboard').restoreBoard(item.board);   // the board file comes back by rename = byte-exact
      return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'Could not restore the storyboard' };
    } else if (item.kind === 'asset') {
      const dir = trash(staging()), target = guarded(staging(), item.category + '/' + item.name);
      if (fs.existsSync(target)) return { ok: false, clash: true, error: 'A file of that name already exists; rename or delete it first.' };
      move(guarded(dir, item.rel), target);
      const labels = json(labelsFile(), { assets: {} }); labels.assets = labels.assets || {}; if (item.label) labels.assets[item.category + '/' + item.name] = item.label; save(labelsFile(), labels);
      restoreFolder('asset:' + item.category + '/' + item.name, item.folder);
      save(path.join(dir, 'index.json'), json(path.join(dir, 'index.json'), []).filter(x => x.id !== id));
    } else {
      return brushLock.withLock(() => {   // F2.5: sync body, released on every path (a throw lands in the catch below)
      const root = bto.brushesDir(), dir = guarded(trash(root), id), rp = path.join(root, 'registry.json'), py = path.join(root, 'phoenix_brushes.py');
      const reg = json(rp, { brushes: {} });
      const miss = missingParts(item, dir);
      if (miss.length) return { ok: false, error: 'This trash entry is incomplete (missing ' + miss.join(', ') + ') — nothing was restored.' };
      if (reg.brushes[item.slug] && item.replaced === true) return swapRestore(item, dir, root);
      if (reg.brushes[item.slug]) return { ok: false, clash: true, error: 'A brush with that slug already exists.' };
      // 1. PLAN, nothing moves: read everything and refuse a clash before the first file is touched
      const libRoot = path.resolve(root, 'lib'), lib = guarded(path.join(root, 'lib'), item.lib), libFrom = path.join(dir, path.basename(item.lib));
      const withLib = lib !== libRoot && fs.existsSync(libFrom);
      if (withLib) {
        if (fs.existsSync(lib)) return { ok: false, clash: true, error: 'A library file named ' + path.basename(item.lib) + ' already exists - nothing was restored.' };
        const users = libUsers(lib, item.slug);
        if (users.length) return { ok: false, clash: true, error: 'The library file ' + path.basename(item.lib) + ' is used by "' + users[0] + '" - nothing was restored.' };
      }
      const posterTo = item.poster ? guarded(posterDir(), item.poster) : null;
      const src = fs.readFileSync(py, 'utf8'), block = fs.readFileSync(path.join(dir, 'fn.py'), 'utf8');
      let regBytes = null; try { regBytes = fs.readFileSync(rp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const plan = [];
      if (withLib) plan.push([libFrom, lib]);
      for (const ext of ['glb', 'key']) plan.push([path.join(dir, item.slug + '.' + ext), path.join(bto.cacheDir(), item.slug + '.' + ext)]);
      if (posterTo) plan.push([path.join(dir, item.poster), posterTo]);
      // 2. MOVE with an undo list; any failure puts every file back and leaves the entry whole
      const moved = []; let pyWritten = false;
      try {
        for (const [from, to] of plan) if (fs.existsSync(from)) { move(from, to); moved.push([from, to]); }
        atomic(py, src + (src.endsWith('\n') ? '' : '\n') + block); pyWritten = true;
        reg.brushes[item.slug] = item.entry; save(rp, reg);
      } catch (e) {
        let rb = null;
        if (regBytes) { try { atomic(rp, regBytes); } catch (re) { rb = rb || re; } }
        if (pyWritten) { try { atomic(py, src); } catch (re) { rb = rb || re; } }
        const stuck = undoMoves(moved);
        if (stuck.length || rb) return { ok: false, error: e.message + '; undo failed (' + (rb ? rb.message : stuck[0][2]) + ') - the trash entry stays, restore it again to finish.' };
        return { ok: false, error: e.message + ' - nothing was restored.' };
      }
      restoreFolder('brush:' + item.slug, item.folder);
      fs.rmSync(dir, { recursive: true }); require('./brush-previews').kick('restore');
      return { ok: true };
      });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
function empty({cfg} = {}) {
  return brushLock.withLock(() => emptyLocked({cfg}));   // F2.5: the brush trash is emptied under the same lock as every other brush writer
}
// M1.5: the Unreal export caches of a character / brush that is deleted for good. A failed delete never fails the trash operation (returns what could not go).
function clearUnrealCache(what) {
  const failed = [];
  const rm = (dir, file) => { try { fs.rmSync(path.join(dir, file), { force: true }); } catch (e) { failed.push(file + ' (' + (e && e.code || e && e.message) + ')'); } };
  try {
    if (what && what.kind === 'character') {
      const cte = require('./character-to-unreal'), slug = cte.slugify(what.name);
      if (slug) for (const f of [slug + '.glb', slug + '_anim.glb', slug + '.alpha.json', slug + '_anim.alpha.json']) rm(cte.CACHE_DIR, f);
    } else if (what && what.kind === 'brush') {
      const slug = path.basename(String(what.slug || ''));
      if (slug && slug === String(what.slug)) rm(bto.cacheDir(), slug + '.glb');
    }
  } catch (e) { failed.push(String(e && e.message || e)); }
  return { ok: failed.length === 0, failed };
}
function emptyLocked({cfg} = {}) {
  try {
    const dirs = [trash(staging()), trash(bto.brushesDir()), trash(require('./levels').root(cfg)), trash(require('./characters').CHAR_DIR), trash(require('./custom_rig').CUSTOM_DIR), trash(soundsRoot())];
    const check = p => { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('Trash links are refused'); if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) check(path.join(p, n)); };
    for (const d of dirs) if (fs.existsSync(d)) check(d);
    const boards = sbTrashFiles();   // R6: trashed storyboards (links refused here, before anything is deleted)
    const gone = list({cfg}), removed = gone.length;
    // only what was listed goes (its folder by id, an asset's index.json, hidden .gone- leftovers); a folder nobody listed is never deleted
    const names = new Set(); for (const it of gone) if (it && typeof it.id === 'string' && it.id && path.basename(it.id) === it.id) { names.add(it.id); names.add('.reserved-' + it.id); }
    for (const d of dirs) if (fs.existsSync(d)) for (const n of fs.readdirSync(d)) {
      if (names.has(n) || n.startsWith('.gone-') || (n === 'index.json' && d === dirs[0])) fs.rmSync(path.join(d, n), { recursive: true, force: true });
    }
    let liveChar = () => false; try { const C = require('./characters'); liveChar = (nm) => { const a = C.charPath(nm); return !!a && fs.existsSync(a); }; } catch (_) { /* no character library */ }
    for (const it of gone) {   // final delete: the caches go with it (moving to the trash and restoring leave them) - but never the cache of a LIVE brush / character of the same name
      if (it.kind === 'character') { if (!liveChar(it.name)) clearUnrealCache({ kind: 'character', name: it.name }); }
      else if (it.kind === 'brush') { if (!it.live) clearUnrealCache({ kind: 'brush', slug: it.slug }); }
    }
    for (const f of boards) fs.rmSync(f, { force: true });
    return { ok: true, removed };
  } catch (e) { return { ok: false, error: e.message }; }
}
function checkTree(p) { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('Library links are refused'); if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) checkTree(path.join(p,n)); }
function trashLevel(slug, opts = {}) { return trashLevelItem(slug,null,opts); }
function trashScene(slug, scene, opts = {}) { return trashLevelItem(slug,scene,opts); }
function trashLevelItem(slug, scene, {cfg,openPath} = {}) {
  let dir;
  try {
    const L = require('./levels'); if (!L.slugOk(slug) || (scene !== null && !L.slugOk(scene))) throw new Error('Invalid level or scene name');
    const base = L.root(cfg), rel = scene === null ? slug : slug + '/scenes/' + scene + '.blend', source = guarded(base,rel);
    if (!fs.existsSync(source)) throw new Error('Level or scene not found');
    const norm = p => path.resolve(p).toLowerCase(); const op = openPath && norm(openPath), src = norm(source);
    if (op && (op === src || (scene === null && op.startsWith(src + path.sep)))) return {ok:false,open:true,error:'This file is open in Blender. Open another file before moving it to trash.'};
    checkTree(source);
    const id = idNow(); dir = guarded(trash(base,true),id,true);
    const meta = scene === null ? json(guarded(base,slug + '/meta.json'),{}) : {};
    const item = {id,kind:scene === null ? 'level' : 'scene',name:meta.name || scene || slug,slug,at:new Date().toISOString()}; if (scene !== null) item.scene = scene;
    save(guarded(dir,'manifest.json'),item);
    move(source,guarded(dir,scene === null ? slug : scene + '.blend'));
    return {ok:true,id};
  } catch(e) { if (dir) fs.rmSync(dir,{recursive:true,force:true}); return {ok:false,error:e.message}; }
}
module.exports = { _fileSha: fileSha, trashLevel, trashScene, trashAsset, trashBrush, trashCharacter, trashCustomRig, trashSounds, clearUnrealCache, snapshotBrush, removeSnapshot, posterName, libPathOf, samePath, libUsers, list, restore, empty, guarded };
