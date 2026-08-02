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
 * The namespace matters: a brush and an asset may legitimately share a name.
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'library-folders.json');

const EMPTY = () => ({ version: 1, folders: [], assignments: {}, collapsed: [] });

// strict=false (reads): any error → EMPTY(), so the rail still renders on a transient hiccup.
// strict=true  (mutations): only a genuinely ABSENT file (ENOENT) is EMPTY; a locked or corrupt file
// THROWS, so apply() can refuse the mutation instead of persisting an empty tree over the real one —
// a transient read must never cost the user every folder + assignment.
function readTree(strict) {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return EMPTY();
    if (strict) throw e;
    return EMPTY();
  }
  let o;
  try { o = JSON.parse(raw); }
  catch (e) { if (strict) throw e; return EMPTY(); }
  if (!o || typeof o !== 'object') {
    if (strict) throw new Error('library-folders.json is not a valid object');
    return EMPTY();
  }
  return {
    version:     1,
    folders:     Array.isArray(o.folders) ? o.folders.filter(f => f && f.id && typeof f.name === 'string') : [],
    assignments: (o.assignments && typeof o.assignments === 'object') ? o.assignments : {},
    collapsed:   Array.isArray(o.collapsed) ? o.collapsed.filter(x => typeof x === 'string') : [],
  };
}

function load() { return readTree(false); }

function save(o) {
  // tmp + rename: a truncated write here would lose the whole tree, and the next load would
  // silently return EMPTY() — i.e. every folder gone with no error anywhere.
  const tmp = FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

let _seq = 0;
function newId() {
  _seq += 1;
  return 'f' + Date.now().toString(36) + _seq.toString(36);
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
 * ops: create | rename | delete | moveFolder | assign | collapse
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
      const f = { id: newId(), name: name.slice(0, 60), parent: op.parent || null };
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
        if (isDescendant(o, target, f.id)) return { ok: false, error: 'Cannot move a folder into its own subfolder.' };
      }
      f.parent = target;
      save(o);
      return { ok: true, data: o };
    }

    case 'assign': {
      const key = typeof op.key === 'string' ? op.key : '';
      if (!/^(asset|brush):.+/.test(key)) return { ok: false, error: 'Bad item key.' };
      if (op.folder) {
        if (!byId(o, op.folder)) return { ok: false, error: 'Folder no longer exists.' };
        o.assignments[key] = op.folder;
      } else {
        delete o.assignments[key];     // back to its palette category
      }
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

module.exports = { load, apply, FILE };
