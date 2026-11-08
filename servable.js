'use strict';

// ─── servable.js — the ONE rule for "an image the user may point Phoenix at" (v1.10 I1) ──────────────
// Shared by the storyboard route (server.js sbImageError) and the generate_from_refs route + tool, so the
// path rule exists exactly once. No "..", inside output / staging / brush-cache by realpath, must be a file. An
// absolute path is accepted when it lies inside one of those roots (lexically) and is then judged by its relative form
// (relativeForm) through the same file and link checks; callers store and show the relative form. Outside: refused.
// No project-local requires (fs + path only).

const fs   = require('fs');
const path = require('path');

const ROOT_DIRS = ['output', 'staging', 'brush-cache'];   // brush-cache: cached brush GLBs, servable but not "staged" assets

const OUTSIDE_ABS = 'image is outside output/, staging/ and brush-cache/';

// { abs, allowed } or null when p is missing / not a string / contains ".." (the /file route's rule).
function resolveFileParam(workingDir, p) {
  if (!p || typeof p !== 'string') return null;
  if (p.includes('..')) return null;
  const abs = path.resolve(workingDir, p);
  const allowed = ROOT_DIRS.map(d => path.resolve(workingDir, d)).some(root =>
    abs === root || abs.startsWith(root + path.sep)
  );
  return { abs, allowed };
}

// The root-relative form (forward slashes) of an absolute path inside a servable root; anything else comes back unchanged.
function relativeForm(workingDir, img) {
  if (typeof img !== 'string' || img === '' || img.includes('..')) return img;
  // Windows extended form of a drive path (\\?\C:\...): the same file, so the same rule. UNC (\\?\UNC\), device (\\.\) and the rest stay outside.
  const plain = process.platform === 'win32' ? img.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '') : img;
  if (!path.isAbsolute(plain)) return img;
  const abs = path.resolve(plain), win = process.platform === 'win32', fold = (x) => (win ? x.toLowerCase() : x);
  for (const d of ROOT_DIRS) {
    const root = path.resolve(workingDir, d);
    // the root's own spelling (a case-insensitive match must still be a path /file accepts), the rest as given
    if (fold(abs) === fold(root)) return d;
    if (fold(abs).startsWith(fold(root) + path.sep)) return d + '/' + abs.slice(root.length + 1).split(path.sep).join('/');
  }
  return img;
}

// '' when fine (or no image given), else the plain error text. `abs` is the resolved path when fine.
function servableImageError(workingDir, img) {
  if (img == null || img === '') return '';
  if (typeof img !== 'string') return 'image must be a path';
  if (img.includes('..')) return 'image path must not contain ".."';
  const isAbs = path.isAbsolute(img);
  const outside = isAbs ? OUTSIDE_ABS : 'image is outside the servable roots';   // a relative path keeps its old text
  if (isAbs) { img = relativeForm(workingDir, img); if (path.isAbsolute(img)) return OUTSIDE_ABS; }
  const f = resolveFileParam(workingDir, img);
  if (!f || !f.allowed) return outside;
  let isFile = false;
  try { isFile = fs.statSync(f.abs).isFile(); } catch (_) {}
  if (!isFile) return 'image file is gone';
  // links: the real path must lie inside the real path of one of the /file roots
  try {
    const real = fs.realpathSync(f.abs);
    const inside = ROOT_DIRS.some(d => {
      let rr; try { rr = fs.realpathSync(path.resolve(workingDir, d)); } catch (_) { return false; }
      return real === rr || real.startsWith(rr + path.sep);
    });
    if (!inside) return outside;
  } catch (_) { return 'image file is gone'; }
  return '';
}

module.exports = { resolveFileParam, servableImageError, relativeForm, ROOT_DIRS };
