'use strict';
// character-previews.js - the character preview cache (R5a). Mirror of brush-previews.js: a background Blender opens a saved character
// .blend and exports it to a GLB in its OWN folder (not the Unreal character-cache); the browser renders the poster from that GLB.
//   <previewDir>/<name>.glb   the export
//   <previewDir>/<name>.key   the key it was exported for = size + '-' + mtimeMs of <name>.blend (a save or rename changes it)
// One Blender at a time; waits while Phoenix is busy; a failed export leaves no .key and no partial GLB, and the same key is not retried
// until it changes or retry(name) is called.
const fs = require('fs');
const path = require('path');
const characters = require('./characters');

const previewDir = () => process.env.PHOENIX_CHARACTER_PREVIEW_DIR || path.join(__dirname, 'character-previews');
const defaultRun = (exe, args, opts) => new Promise((resolve, reject) => {
  const child = require('child_process').spawn(exe, args, { windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => { child.kill(); reject(new Error('Preview timed out')); }, opts.timeoutMs);
  child.on('error', e => { clearTimeout(timer); reject(e); });
  child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
const deps = { run: defaultRun, getCfg: () => ({}), busy: () => false, onStatus: () => {} };
let state, queue, failures, timer, epoch = 0;
function _reset() {
  epoch++; clearTimeout(timer); timer = null; queue = []; failures = {};
  state = { running: false, done: 0, total: 0, current: null, unavailable: null, failed: {} };
}
_reset();
function status() { return { ...state, failed: { ...state.failed } }; }
function emit() { try { deps.onStatus(status()); } catch (_) { /* a broken listener never stops the queue */ } }
// ONE background Blender across both preview queues: the brush queue running counts as busy here (lazy require: circular is fine)
const otherRunning = () => { try { return require('./brush-previews').status().running; } catch (_) { return false; } };
const isBusy = () => deps.busy() || otherRunning();
function configure(o) { for (const k of ['getCfg', 'busy', 'onStatus']) if (typeof o[k] === 'function') deps[k] = o[k]; }
function _setDeps(o) { for (const k of Object.keys(deps)) if (typeof o[k] === 'function') deps[k] = o[k]; }

// size + '-' + mtimeMs of the saved .blend, or null when there is none
function characterKey(name, opts) {
  try {
    const abs = characters.charPath(name);
    if (!abs) return null;
    const st = fs.statSync(abs);
    return st.size + '-' + st.mtimeMs;
  } catch (e) { if (opts && opts.strict && e && e.code !== 'ENOENT') throw e; return null; }   // strict (cache cleanup): an unreadable .blend is an error, not "no key"
}
// the GLB exists (size > 0) and its .key is the key of the .blend as it is now
function glbFresh(name) {
  const key = characterKey(name);
  if (!key) return false;
  try {
    const dir = previewDir();
    return fs.statSync(path.join(dir, name + '.glb')).size > 0 && fs.readFileSync(path.join(dir, name + '.key'), 'utf8').trim() === key;
  } catch (_) { return false; }
}

function kick(reason) {
  const cfg = deps.getCfg() || {}, exe = cfg.apps && cfg.apps.blender;
  state.unavailable = !exe ? 'Blender path not set (Settings > Connections)' : !fs.existsSync(exe) ? 'Blender executable not found' : null;
  if (state.unavailable) { emit(); return status(); }
  let list = [];
  try { list = characters.listCharacters(); } catch (_) { list = []; }
  const names = new Set(list.map(c => c.name));
  for (const n of Object.keys(failures)) if (!names.has(n)) { delete failures[n]; delete state.failed[n]; }
  for (const c of list) {
    const name = c.name, key = characterKey(name);
    if (!key) continue;
    if (failures[name] && failures[name] !== key) { delete failures[name]; delete state.failed[name]; }
    if (!glbFresh(name) && !queue.some(x => x.name === name) && state.current !== name && failures[name] !== key) {
      if (!state.running && !queue.length) { state.done = 0; state.total = 0; }
      queue.push({ name, key }); state.total++;
    }
  }
  emit(); pump(exe); return status();
}

async function pump(exe) {
  if (state.running || !queue.length) return;
  if (isBusy()) { clearTimeout(timer); timer = setTimeout(() => kick('idle'), 1000); if (timer.unref) timer.unref(); return; }
  const generation = epoch;
  state.running = true; emit();
  while (queue.length && generation === epoch) {
    if (isBusy()) break;
    const item = queue.shift(); state.current = item.name; emit();
    const dir = previewDir(), out = path.join(dir, item.name + '.glb'), keyFile = path.join(dir, item.name + '.key');
    try {
      const blend = characters.charPath(item.name);
      // trashed / renamed while it waited in the queue: nothing to export, and not a failure either (same rule as after the run)
      if (!blend || !fs.existsSync(blend)) { state.done++; state.current = null; emit(); continue; }
      fs.mkdirSync(dir, { recursive: true });
      try { fs.unlinkSync(out); } catch (_) {}
      try { fs.unlinkSync(keyFile); } catch (_) {}
      const args = ['--background', blend, '--python-exit-code', '1', '--python', path.join(__dirname, 'character_preview_export.py'), '--', out];
      const r = await deps.run(exe, args, { timeoutMs: 180000 });
      if (generation !== epoch) return;
      // renamed, trashed or changed while it rendered: the output belongs to nothing now, drop it (no failure)
      if (characterKey(item.name) !== item.key) { try { fs.unlinkSync(out); } catch (_) {} try { fs.unlinkSync(keyFile); } catch (_) {} }
      else {
      if (r.code !== 0) throw new Error(String(r.stderr || r.stdout || 'Preview export failed').trim().split(/\r?\n/).pop());
      if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('Blender wrote no GLB');
      fs.writeFileSync(keyFile, item.key);
      delete failures[item.name]; delete state.failed[item.name];
      }
    } catch (e) {
      failures[item.name] = item.key; state.failed[item.name] = e.message;
      try { fs.unlinkSync(out); } catch (_) {}
      try { fs.unlinkSync(keyFile); } catch (_) {}
    }
    try {
      // the character changed while it rendered: render the new key in this same run
      const cur = characterKey(item.name);
      if (cur && cur !== item.key && !queue.some(x => x.name === item.name)) { queue.push({ name: item.name, key: cur }); state.total++; }
    } catch (_) {}
    state.done++; state.current = null; emit();
  }
  state.running = false; emit();
  if (queue.length) { timer = setTimeout(() => kick('idle'), 1000); if (timer.unref) timer.unref(); }
}

function retry(name) { delete failures[name]; delete state.failed[name]; return kick('retry'); }
module.exports = { configure, _setDeps, _reset, kick, retry, status, previewDir, characterKey, glbFresh };
