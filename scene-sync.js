'use strict';

// ─── Phoenix scene-sync ─────────────────────────────────────────────────────
// Standalone, toggleable background module. Periodically asks the live Blender
// scene what objects exist and writes them into session/state.json as
// `sceneObjects` + `sceneUpdatedAt`, so the assistant can know what's in the
// scene WITHOUT running a tool/IPC call at question-time (warm cache).
//
// Toggle / tune via phoenix-config.json → "sceneSync": { enabled, intervalSeconds }.
// Config is re-read every tick, so enabling/disabling or changing the interval
// takes effect on the next cycle — no restart needed. Setting enabled:false
// (or just closing this window) stops the sync. The manual `refresh` command in
// the assistant remains as an "update right now" fallback.
//
// Run:  scene-sync.bat   (or: node scene-sync.js)
// Requiring assistant.js is safe — it is require.main-guarded (no readline boot).

const { callBlender, saveSceneCache, loadConfig } = require('./assistant');
const dbg = require('./debug-log');

const DEFAULT_INTERVAL = 120; // seconds
const MIN_INTERVAL     = 5;   // floor so a typo can't hammer Blender

const SCENE_QUERY =
  'import bpy\nnames=[o.name for o in bpy.context.scene.objects]\nprint("OBJECTS:"+str(names))';

function log(msg) {
  const hms = new Date().toISOString().slice(11, 19);
  process.stdout.write(`  [${hms}] [scene-sync] ${msg}\n`);
}

function readSyncCfg() {
  let cfg = {};
  try { cfg = loadConfig() || {}; } catch { /* fall through to defaults */ }
  const s = (cfg && cfg.sceneSync) || {};
  const enabled = s.enabled !== false; // default ON unless explicitly false
  let interval = Number(s.intervalSeconds);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL) interval = DEFAULT_INTERVAL;
  return { enabled, interval };
}

async function syncOnce() {
  let raw;
  try {
    const result = await callBlender(SCENE_QUERY);
    raw = result.stdout || result.output || '';
  } catch (e) {
    // Blender closed / IPC down → skip quietly, keep last-known cache + timestamp.
    log(`Blender unreachable — keeping last-known scene cache (${e.message})`);
    dbg.event('scene-sync', { ok: false, reason: 'blender-unreachable', msg: e.message });
    return;
  }

  const m = raw.match(/OBJECTS:\[([^\]]*)\]/);
  const objects = m ? m[1].replace(/'/g, '').split(', ').filter(Boolean) : [];

  // Dedicated scene-cache file — scene-sync is its sole writer, so there is no
  // clobber race with the server's in-memory state.json.
  saveSceneCache({ sceneObjects: objects, sceneUpdatedAt: new Date().toISOString() });

  log(`scene cache updated — ${objects.length} object(s): ${objects.join(', ') || '(empty)'}`);
  dbg.event('scene-sync', { ok: true, count: objects.length });
}

function scheduleNext() {
  const { enabled, interval } = readSyncCfg();
  if (!enabled) {
    log('sceneSync.enabled = false in phoenix-config.json — stopping.');
    process.exit(0);
  }
  setTimeout(tick, interval * 1000);
}

async function tick() {
  await syncOnce();
  scheduleNext();
}

function start() {
  const { enabled, interval } = readSyncCfg();
  if (!enabled) {
    log('sceneSync.enabled = false in phoenix-config.json — nothing to do. Exiting.');
    return;
  }
  log(`starting — polling Blender scene every ${interval}s (edit phoenix-config.json to tune; Ctrl+C to stop).`);
  tick(); // run immediately, then self-schedule
}

if (require.main === module) start();

module.exports = { start, syncOnce, readSyncCfg };
