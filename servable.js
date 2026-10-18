'use strict';

// ─── servable.js — the ONE rule for "an image the user may point Phoenix at" (v1.10 I1) ──────────────
// Shared by the storyboard route (server.js sbImageError) and the generate_from_refs route + tool, so the
// path rule exists exactly once. Relative paths only, no "..", inside output / staging / brush-cache by
// realpath, must be a file. No project-local requires (fs + path only).

const fs   = require('fs');
const path = require('path');

const ROOT_DIRS = ['output', 'staging', 'brush-cache'];   // brush-cache: cached brush GLBs, servable but not "staged" assets

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

// '' when fine (or no image given), else the plain error text. `abs` is the resolved path when fine.
function servableImageError(workingDir, img) {
  if (img == null || img === '') return '';
  if (typeof img !== 'string') return 'image must be a path';
  if (img.includes('..')) return 'image path must not contain ".."';
  if (path.isAbsolute(img)) return 'image is outside the servable roots';
  const f = resolveFileParam(workingDir, img);
  if (!f || !f.allowed) return 'image is outside the servable roots';
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
    if (!inside) return 'image is outside the servable roots';
  } catch (_) { return 'image file is gone'; }
  return '';
}

module.exports = { resolveFileParam, servableImageError, ROOT_DIRS };
