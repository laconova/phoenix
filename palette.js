'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Shared palette data + helpers ───────────────────────────────────────────
// Required by both phoenix.js (CLI) and assistant.js / server.js (server).
// No project-local requires — only fs and path — to avoid require cycles.

const PALETTE_FILE = path.join(__dirname, 'palette.json');

const DEFAULT_PALETTE = {
  version: 1,
  categories: {
    flat:         { hint: 'planks, panels, floors, tiles, simple flat surfaces',         style: 'crisp top-down or 3/4 product studio photo of a flat surface, isolated on a pure white seamless background, no floor, no shadow, soft diffuse lighting, 8k sharp focus',           target_face_num: 2000,  cfg: 3.5, steps: 20, builtin: true },
    furniture:    { hint: 'chairs, tables, shelves, beds, desks, stools',                style: 'furniture product shot, 3/4 view, pure white seamless background, object floating slightly above ground, NO floor, NO shadow, NO surface, neutral even lighting',                        target_face_num: 10000, cfg: 4.0, steps: 20, builtin: true },
    item:         { hint: 'tools, weapons, containers, props with detail',               style: 'crisp 3/4 hero product studio photo, isolated on a pure white seamless background, no floor, no shadow, soft diffuse lighting, fine detail, 8k sharp focus',                          target_face_num: 6000,  cfg: 3.5, steps: 20, builtin: true },
    architecture: { hint: 'walls, pillars, arches, doorways, beams, structures',         style: 'architectural fragment, isolated on a pure white background, 3/4 view, no environment, no shadow',                                                                                       target_face_num: 14000, cfg: 3.5, steps: 20, builtin: true },
    flora:        { hint: 'trees, plants, bushes, flowers, roots, moss',                 style: 'botanical illustration, isolated on a pure white background, full plant visible, detailed structure',                                                                                    target_face_num: 28000, cfg: 3.5, steps: 20, builtin: true },
    fauna:        { hint: 'animals, monsters, and creatures (static props only)',        style: 'full-body creature, isolated on a pure white background, slightly elevated 3/4 view, natural textures, no shadow',                                                                       target_face_num: 40000, cfg: 3.0, steps: 20, builtin: true },
  },
};

/**
 * loadPalette() — reads palette.json fresh on every call.
 * On any read/parse failure, writes DEFAULT_PALETTE to disk (best-effort) and
 * returns a deep copy of DEFAULT_PALETTE.
 */
function loadPalette() {
  try {
    return JSON.parse(fs.readFileSync(PALETTE_FILE, 'utf8'));
  } catch {
    try { fs.writeFileSync(PALETTE_FILE, JSON.stringify(DEFAULT_PALETTE, null, 2), 'utf8'); } catch { /* read-only FS */ }
    return JSON.parse(JSON.stringify(DEFAULT_PALETTE));
  }
}

/**
 * savePalette(palette) — writes palette object to palette.json.
 */
function savePalette(palette) {
  fs.writeFileSync(PALETTE_FILE, JSON.stringify(palette, null, 2));
}

/**
 * validateCategory(key, cat) — validate ONE category entry.
 * Returns { ok: true } or { ok: false, error: '<msg>', field: '<key>' }.
 */
function validateCategory(key, cat) {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    return { ok: false, error: 'invalid category key', field: key };
  }
  if (!cat || typeof cat.hint !== 'string' || !cat.hint) {
    return { ok: false, error: 'hint must be a non-empty string', field: key };
  }
  if (typeof cat.style !== 'string' || !cat.style) {
    return { ok: false, error: 'style must be a non-empty string', field: key };
  }
  if (!Number.isInteger(cat.target_face_num) || cat.target_face_num < 200 || cat.target_face_num > 300000) {
    return { ok: false, error: 'target_face_num must be an integer 200–300000', field: key };
  }
  if (typeof cat.cfg !== 'number' || cat.cfg < 0 || cat.cfg > 20) {
    return { ok: false, error: 'cfg must be a number 0–20', field: key };
  }
  if (!Number.isInteger(cat.steps) || cat.steps < 1 || cat.steps > 100) {
    return { ok: false, error: 'steps must be an integer 1–100', field: key };
  }
  return { ok: true };
}

module.exports = { DEFAULT_PALETTE, PALETTE_FILE, loadPalette, savePalette, validateCategory };
