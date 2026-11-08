'use strict';

/**
 * library-folders.js — user-made folders for the library rail, with nesting.
 *
 * 🔑 THE ONE DESIGN DECISION, and everything follows from it:
 * FOLDERS ARE A VIEW, NOT STORAGE. Nothing on disk moves.
 *
 * Staged assets live at staging/<palette-category>/<file>.glb and `import_asset` resolves them
 * through exactly that path; the palette guard in server.js also refuses to delete a category that
 * still owns files. So physically moving a GLB into a user folder would break the import path and
 * cut the asset out of its palette category at the same time. Instead this file stores a tree and
 * a mapping, and the rail renders accordingly:
 *
 *   - an item WITH an assignment appears under its folder
 *   - an item WITHOUT one appears under its original category, exactly as before
 *
 * That is what "loosen the Trellis assets out of their groups" means in practice — the grouping by
 * palette category stops being the only way to see them, without anything being moved or renamed.
 * Assignment is reversible: drop it and the item falls back to its category.
 *
 * Item keys are stable and namespaced:
 *   asset:<category>/<filename.glb>     — same key shape library-labels.json already uses
 *   brush:<slug>
 *   video:<relative path>               — v1.10 LIB2: the Videos tab has its OWN tree (folders with scope:'video')
 * The namespace matters: a brush and an asset may legitimately share a name.
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'library-folders.json');
// test seam: PHOENIX_LIBRARY_FOLDERS_FILE points the module at a temp file (read at call time)
const fileNow = () => process.env.PHOENIX_LIBRARY_FOLDERS_FILE || FILE;

// v1.10 LIB2: a folder may carry scope:'video' (the Videos tab tree). v1.10.1 R4: scope:'brush' (the Brushes tree).
// No scope = the asset tree. Three trees, never mixed: keys only into folders of their own tree.
const SCOPES = ['video', 'brush', 'image'];
const scopeOf = (f) => (f && SCOPES.indexOf(f.scope) >= 0) ? f.scope : null;
const keyScope = (key) => (/^image:/.test(key) ? 'image' : /^video:/.test(key) ? 'video' : /^brush:/.test(key) ? 'brush' : null);
const VERSION = 2;

const EMPTY = () => ({ version: VERSION, folders: [], assignments: {}, collapsed: [] });

// strict=false (reads): any error → EMPTY(), so the rail still renders on a transient hiccup.
// strict=true  (mutations): only a genuinely ABSENT file (ENOENT) is EMPTY; a locked or corrupt file
// THROWS, so apply() can refuse the mutation instead of persisting an empty tree over the real one —
// a transient read must never cost the user every folder + assignment.
function readTree(strict) {
  let raw;
  try { raw = fs.readFileSync(fileNow()); }
  catch (e) {
    if (e && e.code === 'ENOENT') return EMPTY();
    if (strict) throw e;
    return EMPTY();
  }
  let o;
  try { o = JSON.parse(raw.toString('utf8')); }
  catch (e) { if (strict) throw e; return EMPTY(); }
  if (!o || typeof o !== 'object') {
    if (strict) throw new Error('library-folders.json is not a valid object');
    return EMPTY();
  }
  const tree = {
    version:     Number(o.version) || 1,
    folders:     Array.isArray(o.folders) ? o.folders.filter(f => f && f.id && typeof f.name === 'string') : [],
    assignments: (o.assignments && typeof o.assignments === 'object') ? o.assignments : {},
    collapsed:   Array.isArray(o.collapsed) ? o.collapsed.filter(x => typeof x === 'string') : [],
  };
  if (tree.version >= VERSION) return tree;
  // v1.10.1 R4: a version-1 file is migrated once - the ORIGINAL bytes go to <file>.bak-r4 first, then the
  // migrated tree is written. A second read finds version 2 and writes nothing. (Only a file that exists and
  // parses gets here; a missing or corrupt file never reaches this line.)
  const m = migrateFolders(tree);
  try {
    // backup via temp + rename: a crash must never leave a partial .bak-r4 that a later load would trust
    const bak = fileNow() + '.bak-r4';
    if (!fs.existsSync(bak)) {                                  // keep the FIRST original if a backup is already there
      const btmp = bak + '.tmp-' + process.pid;
      fs.writeFileSync(btmp, raw);
      fs.renameSync(btmp, bak);
    }
    save(m.tree);
  } catch (e) {
    if (strict) throw e;           // a mutation must not go on if the backup / rewrite failed
    return tree;                   // never serve ids that are not on disk: the unmigrated tree now, a retry next load
  }
  return m.tree;
}

function load() { return readTree(false); }

function save(o) {
  // tmp + rename: a truncated write here would lose the whole tree, and the next load would
  // silently return EMPTY() — i.e. every folder gone with no error anywhere.
  const tmp = fileNow() + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2), 'utf8');
  fs.renameSync(tmp, fileNow());
}

let _seq = 0;
function newId() {
  _seq += 1;
  return 'f' + Date.now().toString(36) + _seq.toString(36);
}

/**
 * v1.10.1 R4 - pure (no fs): split the shared asset/brush tree into two trees. Version >= 2 -> unchanged.
 * For every scope-less ROOT folder take its whole subtree and the assignments pointing into it:
 *   only brush: keys (>= 1)  -> every folder of the subtree becomes scope:'brush'
 *   no brush keys            -> stays an asset folder
 *   mixed                    -> stays an asset folder; ALL its brush: assignments move to ONE new brush root
 *                               folder of the same name, mirroring the folder path of each brush (no mirror
 *                               for a folder without brushes; a mirror is collapsed when its original is)
 * Video folders, collapsed ids and every other assignment are untouched. The input is never mutated.
 */
function migrateFolders(tree) {
  const t = JSON.parse(JSON.stringify(tree || {}));
  if (Number(t.version) >= VERSION) return { tree: t, changed: false };
  t.folders = Array.isArray(t.folders) ? t.folders : [];
  t.assignments = (t.assignments && typeof t.assignments === 'object') ? t.assignments : {};
  t.collapsed = Array.isArray(t.collapsed) ? t.collapsed : [];
  const kids = (id) => t.folders.filter(f => f.parent === id);
  const subtree = (root) => { const out = [root]; for (let i = 0; i < out.length; i++) kids(out[i].id).forEach(c => out.push(c)); return out; };
  const byIdLocal = (id) => t.folders.find(f => f.id === id) || null;
  const roots = t.folders.filter(f => !f.parent && !scopeOf(f));
  for (const root of roots) {
    const sub = subtree(root);
    const ids = new Set(sub.map(f => f.id));
    const keys = Object.keys(t.assignments).filter(k => ids.has(t.assignments[k]));
    const brushKeys = keys.filter(k => /^brush:/.test(k));
    if (!brushKeys.length) continue;
    if (brushKeys.length === keys.length) { sub.forEach(f => { f.scope = 'brush'; }); continue; }
    const mirror = new Map();
    const mirrorOf = (f) => {
      if (mirror.has(f.id)) return mirror.get(f.id);
      const nf = { id: newId(), name: f.name, parent: f === root ? null : mirrorOf(byIdLocal(f.parent)).id, scope: 'brush' };
      t.folders.push(nf);
      mirror.set(f.id, nf);
      if (t.collapsed.indexOf(f.id) >= 0 && t.collapsed.indexOf(nf.id) < 0) t.collapsed.push(nf.id);
      return nf;
    };
    brushKeys.forEach(k => { t.assignments[k] = mirrorOf(byIdLocal(t.assignments[k])).id; });
  }
  t.version = VERSION;
  return { tree: t, changed: true };
}

const byId = (o, id) => o.folders.find(f => f.id === id) || null;

// Walk up from `id`; returns true if `ancestorId` is on the path. Used to refuse a move that would
// put a folder inside its own subtree — that detaches the branch from the root and it disappears
// from the rail with no way back through the UI.
function isDescendant(o, id, ancestorId) {
  let cur = byId(o, id);
  const seen = new Set();
  while (cur && cur.parent) {
    if (seen.has(cur.id)) return false;      // corrupt cycle — stop rather than hang
    seen.add(cur.id);
    if (cur.parent === ancestorId) return true;
    cur = byId(o, cur.parent);
  }
  return false;
}

/**
 * Apply one mutation. Returns { ok, error, data } — never throws for user error, because every
 * caller is a UI click and a stack trace is not an answer.
 *
 * ops: create | rename | delete | moveFolder | assign | moveKey | collapse
 */
function apply(op) {
  let o;
  try { o = readTree(true); }
  catch (e) {
    // A locked/corrupt file must never cost the user their whole folder structure: refuse the
    // mutation rather than operate on an empty tree and let save() persist the wipe.
    return { ok: false, error: 'Could not read the folder tree (file locked or corrupt) — nothing changed. ' + e.message };
  }
  const name = typeof op.name === 'string' ? op.name.trim() : '';

  switch (op.action) {
    case 'create': {
      if (!name) return { ok: false, error: 'Folder name required.' };
      if (op.parent && !byId(o, op.parent)) return { ok: false, error: 'Parent folder no longer exists.' };
      if (op.scope != null && SCOPES.indexOf(op.scope) < 0) return { ok: false, error: 'Bad folder scope.' };
      let scope = op.scope != null ? op.scope : null;
      if (op.parent) {
        const pScope = scopeOf(byId(o, op.parent));
        if (scope === null) scope = pScope;                       // a subfolder lives in its parent's tree
        else if (scope !== pScope) return { ok: false, error: 'A folder cannot be created in the other tree.' };
      }
      const f = { id: newId(), name: name.slice(0, 60), parent: op.parent || null };
      if (scope) f.scope = scope;
      o.folders.push(f);
      save(o);
      return { ok: true, data: o, created: f.id };
    }

    case 'rename': {
      const f = byId(o, op.id);
      if (!f)    return { ok: false, error: 'Folder not found.' };
      if (!name) return { ok: false, error: 'Folder name required.' };
      f.name = name.slice(0, 60);
      save(o);
      return { ok: true, data: o };
    }

    case 'delete': {
      const f = byId(o, op.id);
      if (!f) return { ok: false, error: 'Folder not found.' };
      // Deleting a folder removes THAT FOLDER ONLY. Its subfolders move up one level and its
      // items fall back to their palette category. Nothing on disk is touched.
      //
      // 🪤 The first version computed subtreeIds() here and deleted the whole branch — one click
      // could silently take a dozen nested folders with it, and the confirm dialog said the
      // opposite ("subfolders move up one level"). Caught by the unit test, not by reading.
      // If a whole branch really should go, the user can delete the folders one at a time and see
      // each step; there is no way back from the other order.
      for (const child of o.folders) if (child.parent === f.id) child.parent = f.parent;
      o.folders = o.folders.filter(x => x.id !== f.id);
      for (const [k, v] of Object.entries(o.assignments)) if (v === f.id) delete o.assignments[k];
      o.collapsed = o.collapsed.filter(id => id !== f.id);
      save(o);
      return { ok: true, data: o };
    }

    case 'moveFolder': {
      const f = byId(o, op.id);
      if (!f) return { ok: false, error: 'Folder not found.' };
      const target = op.parent || null;
      if (target) {
        if (!byId(o, target))          return { ok: false, error: 'Target folder no longer exists.' };
        if (target === f.id)           return { ok: false, error: 'A folder cannot contain itself.' };
        if (scopeOf(byId(o, target)) !== scopeOf(f)) return { ok: false, error: 'A folder cannot move between the asset, brush and video trees.' };
        if (isDescendant(o, target, f.id)) return { ok: false, error: 'Cannot move a folder into its own subfolder.' };
      }
      f.parent = target;
      save(o);
      return { ok: true, data: o };
    }

    case 'assign': {
      const key = typeof op.key === 'string' ? op.key : '';
      if (!/^(asset|brush|video|image|character):.+/.test(key) || (keyScope(key) && key.indexOf('..') >= 0)) return { ok: false, error: 'Bad item key.' };
      if (op.folder) {
        const tf = byId(o, op.folder);
        if (!tf) return { ok: false, error: 'Folder no longer exists.' };
        // video keys only into video folders, brush keys only into brush folders, asset keys only into folders without a scope
        if (scopeOf(tf) !== keyScope(key)) return { ok: false, error: (keyScope(key) === 'image' || scopeOf(tf) === 'image') ? 'Images can only be filed into image folders.' : keyScope(key) === 'video' ? 'Videos can only be filed into video folders.' : keyScope(key) === 'brush' ? 'Brushes can only be filed into brush folders.' : 'Assets can only be filed into asset folders.' };
        o.assignments[key] = op.folder;
      } else {
        delete o.assignments[key];     // back to its palette category
      }
      save(o);
      return { ok: true, data: o };
    }

    case 'moveKey': {
      // R5a: a renamed item keeps its folder - ONE save, so the old and the new key are never both assigned
      const from = typeof op.from === 'string' ? op.from : '', to = typeof op.to === 'string' ? op.to : '';
      const ok = (k) => /^(asset|brush|video|image|character):.+/.test(k) && !(keyScope(k) && k.indexOf('..') >= 0);
      if (!ok(from) || !ok(to) || keyScope(from) !== keyScope(to)) return { ok: false, error: 'Bad item key.' };
      if (!(from in o.assignments)) return { ok: true, data: o };
      o.assignments[to] = o.assignments[from]; delete o.assignments[from];
      save(o);
      return { ok: true, data: o };
    }

    case 'collapse': {
      const id = op.id;
      if (!byId(o, id)) return { ok: false, error: 'Folder not found.' };
      const at = o.collapsed.indexOf(id);
      if (op.collapsed === false || (op.collapsed === undefined && at >= 0)) {
        if (at >= 0) o.collapsed.splice(at, 1);
      } else if (at < 0) {
        o.collapsed.push(id);
      }
      save(o);
      return { ok: true, data: o };
    }

    default:
      return { ok: false, error: 'Unknown action.' };
  }
}

module.exports = { load, apply, migrateFolders, FILE, fileNow };
