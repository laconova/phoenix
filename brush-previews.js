'use strict';
const fs = require('fs');
const path = require('path');
const bto = require('./brush-to-unreal');
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
function emit() { deps.onStatus(status()); }
// ONE background Blender across both preview queues: the character queue running counts as busy here (lazy require: circular is fine)
const otherRunning = () => { try { return require('./character-previews').status().running; } catch (_) { return false; } };
const isBusy = () => deps.busy() || otherRunning();
function configure(o) { for (const k of ['getCfg', 'busy', 'onStatus']) if (typeof o[k] === 'function') deps[k] = o[k]; }
function _setDeps(o) { for (const k of Object.keys(deps)) if (typeof o[k] === 'function') deps[k] = o[k]; }
function kick(reason) {
  let reg = {}; try { reg = JSON.parse(fs.readFileSync(path.join(bto.brushesDir(), 'registry.json'), 'utf8')).brushes || {}; } catch (_) {}
  const cfg = deps.getCfg() || {}, exe = cfg.apps && cfg.apps.blender;
  state.unavailable = !exe ? 'Blender path not set (Settings > Connections)' : !fs.existsSync(exe) ? 'Blender executable not found' : null;
  if (state.unavailable) { emit(); return status(); }
  for (const slug of Object.keys(reg)) {
    const key = bto.brushKey(slug);
    if (failures[slug] && failures[slug] !== key) { delete failures[slug]; delete state.failed[slug]; }
    if (!bto.brushGlbFresh(slug) && !queue.some(x => x.slug === slug) && state.current !== slug && failures[slug] !== key) {
      if (!state.running && !queue.length) { state.done = 0; state.total = 0; }
      queue.push({ slug, key, entry: reg[slug] }); state.total++;
    }
  }
  emit(); pump(exe); return status();
}
async function pump(exe) {
  if (state.running || !queue.length) return;
  if (isBusy()) { clearTimeout(timer); timer = setTimeout(() => kick('idle'), 1000); timer.unref(); return; }
  const generation = epoch;
  state.running = true; emit();
  while (queue.length && generation === epoch) {
    if (isBusy()) break;
    const item = queue.shift(); state.current = item.slug; emit();
    const out = path.join(bto.cacheDir(), item.slug + '.glb');
    try {
      fs.mkdirSync(bto.cacheDir(), { recursive: true });
      try { fs.unlinkSync(out); } catch (_) {}
      const args = ['--background', '--python-exit-code', '1', '--python', path.join(__dirname, 'brush_preview_export.py'), '--', path.join(bto.brushesDir(), 'phoenix_brushes.py'), path.join(bto.brushesDir(), 'lib'), item.entry.fn || 'add_' + item.slug, out];
      const r = await deps.run(exe, args, { timeoutMs: 180000 });
      if (generation !== epoch) return;
      if (r.code !== 0) throw new Error(String(r.stderr || r.stdout || 'Preview export failed').trim().split(/\r?\n/).pop());
      if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error('Blender wrote no GLB');
      fs.writeFileSync(path.join(bto.cacheDir(), item.slug + '.key'), item.key);
      delete failures[item.slug]; delete state.failed[item.slug];
    } catch (e) { failures[item.slug] = item.key; state.failed[item.slug] = e.message; }
    try {
      // the brush changed while it rendered: render the new key in this same run
      const cur = bto.brushKey(item.slug);
      if (cur && cur !== item.key && !queue.some(x => x.slug === item.slug)) {
        let entry = item.entry; try { entry = JSON.parse(fs.readFileSync(path.join(bto.brushesDir(), 'registry.json'), 'utf8')).brushes[item.slug] || entry; } catch (_) {}
        queue.push({ slug: item.slug, key: cur, entry }); state.total++;
      }
    } catch (_) {}
    state.done++; state.current = null; emit();
  }
  state.running = false; emit();
  if (queue.length) { timer = setTimeout(() => kick('idle'), 1000); timer.unref(); }
}
function retry(slug) { delete failures[slug]; delete state.failed[slug]; return kick('retry'); }
module.exports = { configure, _setDeps, _reset, kick, retry, status };
