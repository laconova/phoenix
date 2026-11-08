'use strict';

// ─── providers/comfy-i2v.js — v1.10 V2: free LOCAL image-to-video through the user's own ComfyUI ───────────────────────────────
// A backend of the storyboard's video-backend registry (server.js registerVideoBackend): one start image + the shot prompt -> an mp4.
// It is WORKFLOW-DRIVEN: the model lives in a stage:'video' workflow entry (workflows.js; node map + a `video` block with the frame rule, fps,
// sizes and poll limit), this file only patches the slots of that entry into the API-format graph. A second model (Wan 2.2 ...) is another
// manifest entry, not code. It reuses the one ComfyUI client of i2i.js (upload / queue / poll / download / free / "ComfyUI is gone" wording).
//
//   available(cfg)  SYNC (the storyboard view calls it on every build): answers from a short-lived cache that a background probe of the
//                   configured ComfyUI refreshes (/object_info: are the entry's models there, does ComfyUI know the graph's nodes).
//   estimate()      null = free, no confirm.
//   start(req, o)   o.signal = the jobs slot's AbortSignal (the stop path), o.onProgress(text) = the line the shot shows while it runs.
//                   Failures RESOLVE as { ok:false, error }, a stop as { ok:false, stopped:true, error:'Stopped' }.
//
// Config (all optional): video.backend 'auto'|'<id>' (server.js) · video.local.keepAudio (default FALSE: the clip is ONE file with the model's sound; the shot starts
// muted (clip.muted) and a per-shot "Clip sound" switch only flips that flag - LC2f, no ffmpeg, no second file) · video.local.freeAfter (default true: ComfyUI is asked to unload its models when a clip ends)
// · video.local.pollMs (test seam, default 3000).
// Nothing here touches the network except the configured ComfyUI base (global fetch, like i2i.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = 'comfy-i2v';
const OOM_TEXT = 'The 3090 ran out of memory — stop other GPU jobs (Trellis, a local seat) and try again.';
const OK_TTL_MS = 60000;    // a "ready" answer is trusted this long
const BAD_TTL_MS = 8000;    // a "not ready" answer is re-checked soon (the user starts ComfyUI)
const SLOW_TTL_MS = 300000; // ComfyUI answers but lacks the models / nodes: /object_info is big, so wait 5 min (invalidate() re-probes at once after an Acquire / a workflow switch)

// frames = step*k + offset (k whole), clamped to the model's [min, max]; 3 s at 25 fps -> 73 (LC2f: the builtin cap, motion fades after ~3 s)
// F6.5: sets the frame rate in a graph the way workflows.js deriveVideoBlock reads it: a CreateVideo with a numeric inputs.fps, else any node with one. -> true when a node was set; a graph without one stays unchanged.
function setGraphFps(graph, fps) {
  const ids = Object.keys(graph || {}), has = (id) => !!graph[id] && !!graph[id].inputs && typeof graph[id].inputs.fps === 'number';
  const id = ids.find(i => has(i) && graph[i].class_type === 'CreateVideo') || ids.find(has);
  if (id === undefined) return false;
  graph[id].inputs.fps = fps;
  return true;
}
function framesFor(v, durationS) {
  const f = (v && v.frames) || { step: 8, offset: 1, min: 9, max: 73 };
  const fps = Number(v && v.fps) || 25;
  const raw = Math.max(0.1, Number(durationS) || 3) * fps;
  const kMax = Math.floor((f.max - f.offset) / f.step), kMin = Math.ceil((f.min - f.offset) / f.step);
  const k = Math.max(kMin, Math.min(kMax, Math.round((raw - f.offset) / f.step)));
  return f.step * k + f.offset;
}

function create(deps) {
  const d = Object.assign({}, deps || {});
  const i2i = d.i2i || require('../i2i');
  const workflows = d.workflows || require('../workflows');
  const records = d.records || require('../records');
  const gpuShare = d.gpuShare || require('./gpu-share');   // LC2f (AW-L3): the local video run frees the orchestrator seat first
  const dbg = d.dbg || require('../debug-log');
  const storyboard = d.storyboard || require('../storyboard');
  const workingDir = d.workingDir || path.resolve(__dirname, '..');
  const loadConfig = d.loadConfig || (() => ({}));
  const onChange = d.onChange || (() => {});
  // LC2g (T11-1): the save-time measurement of server.js (injected - never duplicated here). Absent (a bare create()) = no measuring, today's behaviour.
  const measureInstances = typeof d.measureVideoInstances === 'function' ? d.measureVideoInstances : null;
  const measureCands = typeof d.measureVideoCandidates === 'function' ? d.measureVideoCandidates : null;

  const localCfg = (cfg) => ((cfg && cfg.video && cfg.video.local && typeof cfg.video.local === 'object') ? cfg.video.local : {});
  const pickEntry = (cfg) => { try { const e = workflows.getActive('video', cfg); return (e && e.stage === 'video') ? e : null; } catch (_) { return null; } };
  const shortName = (entry) => String(entry.label || entry.id || 'video').replace(/^Local\s*[·\-:]\s*/i, '');
  const slotOf = (entry, slot) => {
    let spec = entry.nodes && entry.nodes[slot];
    if (spec == null) return null;
    if (spec && typeof spec === 'object' && spec.node == null && spec.id != null) spec = Object.assign({}, spec, { node: spec.id });   // the bench wrote {id, field}
    return workflows.resolveSlot('video', slot, spec);
  };
  const readGraph = (entry) => JSON.parse(fs.readFileSync(workflows.resolveWorkflowFile(entry), 'utf8'));

  // ── readiness: the probe + its cache ──────────────────────────────────────────────────────────────────────────────────────
  const cache = new Map();      // '<base>|<entry id>' -> { at, res }
  const warm = new Map();       // '<base>|<entry id>' -> when it finished a run since Phoenix started: the model is loaded, the next run is the fast one (unless another job freed that ComfyUI since)
  const inflight = new Map();
  // LC2g r5: RULE - every readiness answer (ok or failure) is cached ONLY under the key of the base it actually probed ('<base>|<id>' = res.base).
  // The in-memory pick of an unmeasured entry (migrate without persist) is a separate lookup: picks id -> { base, t }; available() reads the cache of the base the CURRENT pick points at.
  // A newer decision (t = when its measurement started) replaces an older one: a run that keeps A is not overridden by a slower background measurement that picked B.
  const picks = new Map();
  const setPick = (id, base, t) => { const p = picks.get(id); if (!p || p.t <= t) picks.set(id, { base, t }); };
  // LC2g (T11-1): is this a video entry that contract 2 measures? (custom, automatic, never measured, two ComfyUIs)
  const unmeasured = (cfg, entry) => !!(measureInstances && entry && entry.builtin !== true && !entry.instance_pinned && !entry.instance_checked_at && twoEndpoints(cfg));
  // LC2g r2 (B2): store the measured pick ONLY if the entry in the registry is still unpinned and unstamped (a Save while the measurement was running wins) -> { entry, stored }
  function commitPick(entry, pick) {
    let cur = null;
    try { cur = workflows.loadRegistry().workflows[entry.id]; } catch (_) { cur = null; }
    if (!cur || cur.stage !== 'video') return { entry, stored: false, gone: true };
    cur = Object.assign({ id: entry.id }, cur);
    if (cur.instance_pinned || cur.instance_checked_at) return { entry: cur, stored: false };   // the NEWER stored choice is the target of this clip
    try { workflows.setVideoInstance(entry.id, pick.instance, false); } catch (_) { /* the run still uses the pick */ }
    const e2 = Object.assign({}, cur, { instance_checked_at: new Date().toISOString() });
    if (pick.instance === 'bild') e2.instance = 'bild'; else delete e2.instance;
    return { entry: e2, stored: true };
  }
  // LC2g (T11-1): measure an unmeasured entry (both ComfyUIs answered -> the entry with the pick; one silent / a throw -> the entry as it is).
  // persist=true (ONLY the first run in start: progress + Stop): the pick is stored + stamped through commitPick. persist=false (the readiness probe, B1: an entry whose models are
  // only on the second ComfyUI is available BEFORE its first run): the pick is used in memory for availability and never written (r3: Contract 2 commits at the first RUN). Throws {aborted} on Stop.
  async function migrate(cfg, entry, signal, progress, persist) {
    if (!unmeasured(cfg, entry)) return entry;
    if (progress) progress('Checking where this workflow runs…');
    const dbgInst = (rec) => { try { dbg.event('instance', rec); } catch (_) { /* a debug line never fails a clip */ } };
    let pick = null;
    try { pick = await abortable(measureInstances(cfg, entry), signal); }
    catch (e) { if ((signal && signal.aborted) || (e && e.aborted)) throw Object.assign(new Error('aborted'), { aborted: true }); pick = null; }
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    const cands = (pick && Array.isArray(pick.candidates)) ? pick.candidates : [];
    if (pick && cands.length >= 2 && cands.every(c => c && c.reachable)) {
      if (!persist) { const e2 = Object.assign({}, entry); if (pick.instance === 'bild') e2.instance = 'bild'; else delete e2.instance; return e2; }   // readiness: measured, NOT stored
      const c = commitPick(entry, pick);
      if (c.stored) dbgInst({ phase: 'measured', id: entry.id, target: pick.target, reason: pick.reason });
      else dbgInst({ phase: 'discarded', id: entry.id, reason: 'the entry was saved while it was being measured - the newer choice wins' });
      return c.entry;
    }
    if (persist) dbgInst({ phase: 'skipped', id: entry.id, reason: (cands.filter(c => c && !c.reachable).map(c => c.key).join(', ') || 'a ComfyUI') + ' not answering' });
    return entry;
  }
  // the base available() reads: the stored target, or - for an unmeasured entry - the base its current in-memory pick points at (r5)
  function targetBase(cfg, entry) {
    const p = unmeasured(cfg, entry) ? picks.get(entry.id) : null;
    if (p && (sameBase(p.base, i2i.baseForInstance(cfg, undefined)) || sameBase(p.base, i2i.baseForInstance(cfg, 'bild')))) return p.base;
    return i2i.baseForInstance(cfg, entry.instance);
  }
  async function probe(cfg, entry, pre) {
    const t0 = Date.now(), elig = !pre && unmeasured(cfg, entry), id = entry.id;
    if (!pre) { try { entry = await migrate(cfg, entry, null, null, false); } catch (_) { /* never fails the probe */ } }
    const base = i2i.baseForInstance(cfg, entry.instance);
    if (elig) setPick(id, base, t0);   // measured (B) or kept (A): what available() now reads
    try { return await probeAt(cfg, entry, base); } catch (e) { return { ok: false, base, reason: String((e && e.message) || e) }; }
  }
  async function probeAt(cfg, entry, base) {
    const name = shortName(entry);
    let info;
    try {
      const r = await fetch(base + '/object_info', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      info = await r.json();
    } catch (_) {
      return { ok: false, base, reason: 'ComfyUI at ' + base + ' is not answering — start it, or fix endpoints.comfyui in phoenix-config.json.' };
    }
    const dep = workflows.checkDeps(entry, info);
    if (dep.missing_models.length || dep.missing_nodes.length) {
      // AW1: an entry the user added by hand has no install block, so there is no Install button to point at
      const nodesToo = dep.missing_nodes.length ? ' (custom node ' + dep.missing_nodes.join(', ') + ' is missing too)' : '';
      const reason = entry.install
        ? 'Local video needs the ' + name + ' models — Workflows ▸ Video ▸ Install' + nodesToo
        : (dep.missing_models.length
          ? 'Local video needs these models in ComfyUI: ' + dep.missing_models.join(', ') + " — copy them into ComfyUI's models folders (this workflow was added by hand, Phoenix cannot download them)." + nodesToo
          : 'Local video needs these custom nodes in ComfyUI: ' + dep.missing_nodes.join(', ') + ' — install them in ComfyUI (this workflow was added by hand, Phoenix cannot install them).');
      return { ok: false, slow: true, base, missing: dep.missing_models.concat(dep.missing_nodes), reason };
    }
    let classes = [];
    try { classes = [...new Set(Object.values(readGraph(entry)).map(n => n && n.class_type).filter(Boolean))]; } catch (e) { return { ok: false, base, reason: 'The ' + name + ' workflow file could not be read: ' + String((e && e.message) || e) }; }
    const unknown = classes.filter(c => !(c in info));
    if (unknown.length) return { ok: false, slow: true, base, reason: 'ComfyUI at ' + base + ' does not know the node' + (unknown.length > 1 ? 's ' : ' ') + unknown.slice(0, 4).join(', ') + ' that ' + name + ' needs — update ComfyUI.' };
    return { ok: true, base, reason: '' };
  }
  function refresh(cfg, pre) {   // -> Promise<{ok, reason, base}>; never rejects. pre = { entry }: the run already resolved its entry (no second measurement)
    const entry = (pre && pre.entry) || pickEntry(cfg);
    if (!entry) return Promise.resolve({ ok: false, reason: 'No local video workflow is set up — Workflows ▸ Video.' });
    const base = i2i.baseForInstance(cfg, entry.instance);
    const key = base + '|' + entry.id;
    // LC2g r4: a run's check is for the run's RESOLVED base (pre.entry) - it never joins a background probe that measured on its own (that one may be about another endpoint)
    const ikey = (pre ? 'run|' : '') + key;
    if (inflight.has(ikey)) return inflight.get(ikey);
    const p = probe(cfg, entry, pre).catch(e => ({ ok: false, reason: String((e && e.message) || e) })).then(res => {
      // r5 rule: cached ONLY under the base that was actually probed (res.base); never under the stored target of an entry that was measured elsewhere
      const rkey = res && res.base ? res.base + '|' + entry.id : null;
      const prev = rkey ? cache.get(rkey) : null;
      if (rkey) cache.set(rkey, { at: Date.now(), res });
      inflight.delete(ikey);
      if (!prev || prev.res.ok !== res.ok) { try { onChange(res); } catch (_) {} }   // the open storyboard re-reads the board once
      return res;
    });
    inflight.set(ikey, p);
    return p;
  }

  async function cancelPrompt(base, promptId, ms) {   // each call has its own short timeout (default 3 s) so a dead ComfyUI cannot hold the answer back   // the same care as phoenix.js comfyCancel: dequeue, and /interrupt ONLY when ours is the running one
    const out = { dequeued: false, interrupted: false, reached: true, running: false, pending: false, unknown: false };
    try {
      const r = await fetch(base + '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(ms || 3000) });
      out.dequeued = !!(r && r.ok);
    } catch (_) { out.reached = false; }
    try {
      const qr = await fetch(base + '/queue', { signal: AbortSignal.timeout(ms || 3000) });
      const q = qr && qr.ok ? await qr.json() : null;
      if (!q || !Array.isArray(q.queue_pending) || !Array.isArray(q.queue_running)) { out.unknown = true; return out; }   // LC2i: "not queued, not running" is only concluded from a real answer; a 503 or a odd shape proves nothing
      if ((q.queue_pending || []).some(it => Array.isArray(it) && it.includes(promptId))) out.pending = true;   // LC2i: still queued after the delete (it failed): it WILL start once the slot is released
      if ((q.queue_running || []).some(it => Array.isArray(it) && it.includes(promptId))) {
        out.running = true;
        const r = await fetch(base + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(ms || 3000) });
        out.interrupted = !!(r && r.ok);
      }
    } catch (_) { out.reached = false; }
    return out;
  }

  function writeClip(buf, promptText, ext) {   // output/video/<slug>_<stamp>_<rand>_local.<ext>; written as .part and renamed, so a half file is never left
    const dir = path.join(workingDir, 'output', 'video');
    fs.mkdirSync(dir, { recursive: true });
    const slug = (String(promptText || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')) || 'video';
    const dt = new Date(), z = (n) => String(n).padStart(2, '0');
    const stamp = dt.getFullYear() + z(dt.getMonth() + 1) + z(dt.getDate()) + '-' + z(dt.getHours()) + z(dt.getMinutes()) + z(dt.getSeconds());
    const abs = path.join(dir, slug + '_' + stamp + '_' + crypto.randomBytes(2).toString('hex') + '_local' + ext);
    // LC2f (T9-1): ONE file with whatever sound the model wrote; muted-or-not is the shot's flag (clip.muted), not a second file.
    return { abs, part: abs + '.part' };
  }

  // LC2g: two distinct ComfyUI endpoints configured? (the same test measureVideoCandidates makes; with one there is nothing to measure)
  function twoEndpoints(cfg) {
    const eps = (cfg && cfg.endpoints) || {};
    const main = String(eps.comfyui || 'http://localhost:8188').replace(/\/+$/, '');
    const second = eps.comfyui_bild ? String(eps.comfyui_bild).replace(/\/+$/, '') : '';
    return !!second && second.toLowerCase() !== main.toLowerCase();
  }
  const portOf = (b) => { try { const u = new URL(String(b)); return u.port || (u.protocol === 'https:' ? '443' : '80'); } catch (_) { return String(b); } };
  const torchShort = (v) => { const m = /^(\d+\.\d+)/.exec(String(v || '').trim()); return m ? m[1] : ''; };
  const sameBase = (a, b) => String(a).replace(/\/+$/, '').toLowerCase() === String(b).replace(/\/+$/, '').toLowerCase();
  // run a measurement but give up the wait the moment Stop lands (the held GET itself ends at its own 8 s / 4 s deadline)
  function abortable(p, signal) {
    if (!signal) return p;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(Object.assign(new Error('aborted'), { aborted: true })); return; }
      const on = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
      signal.addEventListener('abort', on, { once: true });
      Promise.resolve(p).then(resolve, reject).then(() => { try { signal.removeEventListener('abort', on); } catch (_) { /* gone */ } });
    });
  }
  // LC2g (T11-1): an OOM on the instance the entry runs on - when the OTHER ComfyUI has everything and modern memory management, say so (best effort; anything else -> OOM_TEXT)
  async function oomText(cfg, base, entry, signal) {
    if (!measureCands || !entry || entry.builtin === true || !twoEndpoints(cfg)) return OOM_TEXT;
    let cands = null;
    try { cands = await abortable(measureCands(cfg, entry), signal); }
    catch (e) { if (e && e.aborted) throw e; return OOM_TEXT; }
    if (!Array.isArray(cands)) return OOM_TEXT;
    const own = cands.find(c => c && sameBase(c.base, base));
    const other = cands.find(c => c && !sameBase(c.base, base));
    if (!own || !other) return OOM_TEXT;
    const okOf = (c) => !!(c.reachable && !(c.missing && c.missing.length));
    const modernOf = (c) => !!(c.reachable && workflows.torchModern(c.torch));
    if (!(okOf(other) && modernOf(other)) || (okOf(own) && modernOf(own))) return OOM_TEXT;
    const label = String(entry.label || entry.id);
    const pinned = entry.instance_pinned === true;
    const t = torchShort(own.torch);
    return 'The 3090 ran out of memory on ComfyUI :' + portOf(own.base) + ' (PyTorch ' + (t || 'unknown') + '). ComfyUI :' + portOf(other.base) + ' has all models and modern memory management — Workflows ▸ ' + label + ' ▸ ' +
      (pinned ? 'Edit ▸ Advanced ▸ Automatic ▸ Save' : 'Edit ▸ Save') + ' moves this workflow there.' +
      (pinned ? ' (Advanced is set to ' + (entry.instance === 'bild' ? 'Second' : 'Main') + ' ComfyUI.)' : '');
  }

  async function failText(e, cfg, base, minutes, signal, entry) {   // a thrown error -> the plain sentence the shot shows
    const msg = String((e && e.message) || e);
    if (e && (e.oom || /out of memory|cudamalloc|cuda error/i.test(msg))) return oomText(cfg, base, entry, signal);
    if (/^i2i job failed/.test(msg)) return 'Local video failed' + msg.split('\n')[0].replace(/^i2i job failed/, '');
    if (/became unreachable|failed status checks|fetch failed|ECONNREFUSED|ECONNRESET/i.test(msg)) {
      const gone = await i2i.comfyGoneMessage(cfg, base, signal);
      return gone || msg.replace(/i2i edit/g, 'video').split('\n')[0];
    }
    if (e && e.stalled) return 'ComfyUI at ' + base + ' stopped sending the clip (no data for ' + Math.round((e.stallMs || 30000) / 1000) + ' s) — the run was dropped; check ComfyUI and try again.';
    if (e && (e.name === 'TimeoutError' || /operation was aborted due to timeout/i.test(msg))) return 'ComfyUI at ' + base + ' did not answer in time — check that it is running and try again.';
    if (/timed out/i.test(msg)) return 'Local video did not finish within ' + minutes + ' min at ' + base + ' — ComfyUI may be swapping against another GPU job. It was told to stop; try again when the card is free.';
    if (/^i2i queue failed|^ComfyUI rejected i2i/.test(msg)) return 'ComfyUI refused the video workflow: ' + msg.replace(/^i2i queue failed \d+:\s*/, '').replace(/^ComfyUI rejected i2i workflow:\s*/, '').slice(0, 300);
    return msg.replace(/^i2i /, '').split('\n')[0];
  }

  const backend = {
    id: ID,
    get label() { const e = pickEntry(loadConfig()); return e ? String(e.label || e.id) : 'Local · image-to-video'; },
    get status() { const e = pickEntry(loadConfig()); return e && e.status === 'unverified' ? 'unverified' : ''; },   // the manifest's status:'unverified' (LC2d): the selector and the Workflows window say so
    capSeconds(cfg) {   // the longest clip the active model makes (its frame cap / fps), 1 decimal; null = unknown. ③ says it BEFORE the run
      const e = pickEntry(cfg || loadConfig()); const v = e && e.video;
      if (!v || !v.frames) return null;
      const n = framesFor(v, 100000), fps = Number(v.fps) || 25;
      return Math.round(n / fps * 100) / 100;   // 2 decimals: the cap of 73 frames is 2.92 s, and a default 3 s shot must not be told it is "too long" (the page shows 1 decimal)
    },
    gpu: true,   // runs in the shared jobs slot (one heavy GPU job at a time; blocks keyframes)
    available(cfg) {
      const c = cfg || loadConfig();
      const entry = pickEntry(c);
      if (!entry) return { ok: false, reason: 'No local video workflow is set up — Workflows ▸ Video.' };
      const base = targetBase(c, entry);   // r5
      const key = base + '|' + entry.id;
      const hit = cache.get(key);
      if (!hit || Date.now() - hit.at > (hit.res.ok ? OK_TTL_MS : (hit.res.slow ? SLOW_TTL_MS : BAD_TTL_MS))) refresh(c);   // background; never awaited here
      if (!hit) return { ok: false, pending: true, reason: 'Checking local video…' };   // the server keeps "auto" from showing the paid backend's cost line while this is pending
      return { ok: !!hit.res.ok, reason: hit.res.ok ? '' : String(hit.res.reason || '') };
    },
    estimate() { return null; },   // free: no confirm
    refresh,
    invalidate() { cache.clear(); picks.clear(); },   // the next available() re-probes at once (an Acquire finished, the video workflow was switched)
    _resetCache() { cache.clear(); inflight.clear(); picks.clear(); },
    _resetWarm() { warm.clear(); },
    async start(req, o) {
      o = o || {};
      const jobSignal = o.signal || null;
      const ctl = new AbortController();   // the one signal every ComfyUI request of this run gets (i2i.js adds the per-request deadline)
      if (jobSignal) { if (jobSignal.aborted) ctl.abort(); else jobSignal.addEventListener('abort', () => ctl.abort(), { once: true }); }
      const signal = ctl.signal;
      const progress = (t) => { try { if (typeof o.onProgress === 'function') o.onProgress(t); } catch (_) {} };
      const fail = (error) => ({ ok: false, error });
      let cancelInfo = null;   // what Stop did at ComfyUI (cancelPrompt's answer), for /stop's reply
      const stopped = () => ({ ok: false, stopped: true, error: 'Stopped', cancel: cancelInfo });
      const cfg = loadConfig();
      let entry = pickEntry(cfg);
      if (!entry) return fail('No local video workflow is set up — Workflows ▸ Video.');
      if (!req || !req.startImage) return fail('make a keyframe first — the video starts from it');
      if (signal.aborted) return stopped();
      // LC2g (T11-1): an entry that was never measured is measured ONCE at its first run, before the target is taken (migrate(): see above).
      const elig = unmeasured(cfg, entry), tRun = Date.now(), idRun = entry.id;
      try { entry = await migrate(cfg, entry, signal, progress, true); }
      catch (e) { if (signal.aborted || (e && e.aborted)) return stopped(); }
      if (signal.aborted) return stopped();
      if (elig) setPick(idRun, i2i.baseForInstance(cfg, entry.instance), tRun);   // r5: the run's resolved target is the entry's current pick (committed, or kept A)
      const base = i2i.baseForInstance(cfg, entry.instance);
      const wkey = base + '|' + entry.id;
      const expectMin = (s) => '~' + Math.max(1, Math.round(s / 60)) + ' min';
      const ex = (vb0 => ({ warm: Number(vb0.expect && vb0.expect.warm_s) || 60, cold: Number(vb0.expect && vb0.expect.cold_s) || 360 }))(entry.video || {});
      const hint = () => (warm.has(wkey) && !(i2i.lastFreed(base) > warm.get(wkey))) ? 'usually ' + expectMin(ex.warm) : 'first run after start-up can take up to ' + expectMin(ex.cold) + ' while the model loads';
      const vb = entry.video || {};
      const minutes = Number(vb.timeoutMin) > 0 ? Number(vb.timeoutMin) : 10;
      const lc = localCfg(cfg);
      const cms = Number(lc.cancelMs) > 0 ? Number(lc.cancelMs) : undefined;
      let promptId = null, partFiles = [], queuing = false, touched = false, published = [], success = false;   // published = final files this run created; removed again on any end that is not a linked, finished clip
      try {
        const ready = await refresh(cfg, { entry });   // LC2g: the entry is already resolved (migrate) - the probe must not measure a second time. A fresh answer, not the cached one: the first thing a failed start should say is WHY
        if (!ready.ok) return fail(ready.reason);
        touched = true;   // from here ComfyUI holds (or may hold) our model: the end of the run asks it to let go (T8-8)
        let wf = readGraph(entry);
        const seed = Math.floor(Math.random() * 2147483647);
        const frames = framesFor(vb, req.duration_s);
        const fps = Number(vb.fps) || 25;
        const sz = (vb.sizes && (vb.sizes[req.aspect] || vb.sizes['16:9'])) || [768, 448];
        const set = (slot, value, required) => {
          const r = slotOf(entry, slot);
          if (!r) { if (required) throw new Error('the ' + shortName(entry) + ' workflow has no "' + slot + '" slot in its node map'); return; }
          if (!wf[r.node]) throw new Error('the ' + shortName(entry) + ' workflow has no node ' + r.node + ' for "' + slot + '"');
          if (!wf[r.node].inputs) wf[r.node].inputs = {};
          wf[r.node].inputs[r.field] = value;
        };
        progress('Preparing…');
        await i2i.freeOtherInstances(cfg, base);
        // LC2f (AW-L3): a local seat model (Qwen/Gemma on the router) holds the card - ask it to let go before the clip loads. Best-effort like the image/mesh stages: never blocks the clip.
        try { await gpuShare.beforeGpuStage(cfg, 'video', d.gpuDeps || {}); }
        catch (e) { try { dbg.event('eject', { phase: 'unload-error', stage: 'video', error: String((e && e.message) || e) }); } catch (_) { /* a debug line never fails a clip */ } }
        const up = await i2i.uploadOrExplain(cfg, base, req.startImage, 'phx_' + crypto.randomBytes(3).toString('hex') + '_' + path.basename(req.startImage), signal);
        if (signal.aborted) return stopped();
        set('image', up, true);
        set('positive', String(req.prompt || ''), true);
        set('length', frames, true);
        set('width', sz[0]); set('height', sz[1]);
        set('seed', seed);
        setGraphFps(wf, fps);   // F6.5: the clip's frame rate also lands in the graph, so the saved file plays at the speed the frame count was planned for
        const outSlot = slotOf(entry, 'output');
        if (!outSlot) throw new Error('the ' + shortName(entry) + ' workflow has no output node in its node map');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        if (wf[outSlot.node] && wf[outSlot.node].inputs && 'filename_prefix' in wf[outSlot.node].inputs) wf[outSlot.node].inputs.filename_prefix = 'phoenix/i2v_' + stamp + '_' + seed;
        const clientId = crypto.randomUUID();
        promptId = clientId;   // ComfyUI keeps a client-supplied id: if Stop / the deadline hits after it accepted the prompt but before we saw the answer, the catch below still cancels THIS id
        queuing = true;
        promptId = (await i2i.queue(base, wf, signal, clientId, Number(lc.queueMs) > 0 ? Number(lc.queueMs) : undefined)) || clientId;
        queuing = false;
        if (signal.aborted) { cancelInfo = await cancelPrompt(base, promptId, cms); return stopped(); }
        progress('Queued in ComfyUI · ' + hint());
        const fmt = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
        const outputs = await i2i.poll(base, promptId, {
          timeoutMs: Number(lc.timeoutMs) > 0 ? Number(lc.timeoutMs) : minutes * 60000, requestMs: Number(lc.requestMs) > 0 ? Number(lc.requestMs) : 15000, intervalMs: Number(lc.pollMs) > 0 ? Number(lc.pollMs) : 3000, signal,
          onTick: (sec) => progress('Making video locally — ' + fmt(sec) + ' · ' + hint()),   // honest: elapsed time + what the bench saw; no fake percentage
        });
        // the clip of a SaveVideo node is listed under `images` (animated), other nodes use `videos` / `gifs`: take any of the three
        const node = outputs[outSlot.node] || {};
        const files = [].concat(node.videos || [], node.images || [], node.gifs || []).filter(x => x && typeof x.filename === 'string' && x.filename);
        const clip = files.find(x => /\.(mp4|webm|mov|mkv|m4v)$/i.test(x.filename)) || files[0];
        if (!clip) return fail('The local video run finished but node ' + outSlot.node + ' returned no clip — check the ComfyUI log at ' + base + '.');
        progress('Downloading the clip…');
        warm.set(wkey, Date.now());   // the graph ran to the end: the models are loaded in this ComfyUI now
        const buf = await i2i.download(base, clip.filename, clip.subfolder || '', clip.type || 'output', { signal, stallMs: Number(lc.stallMs) > 0 ? Number(lc.stallMs) : 30000 });
        if (signal.aborted) return stopped();   // a Stop during the download publishes nothing
        if (!buf || !buf.length) return fail('ComfyUI sent an empty clip.');
        const ext = (/\.(mp4|webm|mov|mkv|m4v)$/i.exec(clip.filename) || ['.mp4'])[0].toLowerCase();
        const w = writeClip(buf, req.prompt, ext);
        partFiles = [w.part];
        fs.writeFileSync(w.part, buf);
        const notes = [];
        // LC2f (T9-1): ONE file, the model's sound kept. Whether the shot starts muted is the shot's choice (req.audio, or the keepAudio config) and the shot has no voice lines.
        const hasVoice = (Array.isArray(req.lines) ? req.lines : []).some(l => l && (l.take || String(l.line || '').trim()));
        const wantSound = typeof req.audio === 'boolean' ? req.audio : (lc.keepAudio === true && !hasVoice);
        if (signal.aborted) return stopped();
        fs.renameSync(w.part, w.abs); published.push(w.abs);
        partFiles = [w.part];   // whatever is left is removed below
        const usedAbs = w.abs;
        const muted = vb.audio === false ? undefined : !wantSound;   // a model without a sound track has nothing to switch: no flag
        const rel = path.relative(workingDir, usedAbs).split(path.sep).join('/');
        const asked = Number(req.duration_s) || 0, got = Math.round(frames / fps * 10) / 10;
        const capRaw = framesFor(vb, 100000) / fps;   // O1: the note compares the shot with the model's CAP, unrounded (LC2f: 73 frames = 2.92 s, so the default 3 s shot is no news)
        const capS = Math.round(capRaw * 10) / 10;
        if (asked - capRaw >= 0.1 - 1e-9) notes.push('This model makes up to ' + capS + ' s per clip; the shot is ' + asked + ' s.');
        if (req.boardId && req.shotId) {
          const u = storyboard.updateShot(req.boardId, req.shotId, { clip: Object.assign({ path: rel, backend: ID, made_at: new Date().toISOString() }, typeof muted === 'boolean' ? { muted } : {}) });
          if (!u.ok) return fail('the clip was made but could not be linked to the shot, so it was removed again: ' + u.error);   // the finally removes the files again: no orphan, no record
        }
        try { records.appendRecord({ kind: 'video', path: usedAbs, workflow: entry.id, backend: ID, prompt: req.prompt, seed, parent: req.startImage, category: 'storyboard' }); } catch (_) { /* a failing record never fails a clip */ }
        success = true;
        return { ok: true, path: rel, abs: usedAbs, seed, frames, seconds: got, muted, note: notes.join(' ') };
      } catch (e) {
        if (signal.aborted || (e && e.aborted)) { if (promptId) cancelInfo = await cancelPrompt(base, promptId, cms); return stopped(); }   // any error that lands inside a Stop is the Stop
        // LC2i: a prompt that was submitted and did not END conclusively (anything but ComfyUI's own "execution failed" answer: a timeout, 5 failed status checks, a stalled download) is cancelled
        // before the slot is released - otherwise ComfyUI keeps rendering while the next GPU job starts. Not confirmed (ComfyUI unreachable, or running and not interrupted) = the error says so.
        const unconfirmed = (ci) => !ci.reached || ci.unknown || ci.pending || (ci.running && !ci.interrupted);
        let stillRunning = false, ci0 = null;
        if (promptId && (queuing || !/^i2i job failed/.test(String((e && e.message) || '')))) { ci0 = await cancelPrompt(base, promptId, cms); stillRunning = unconfirmed(ci0); }   // a submission that hit its deadline may still have been accepted: reconcile by the client id
        const mayRun = () => (stillRunning ? ' It could not be confirmed that ComfyUI stopped: the clip may still be rendering in ComfyUI.' : '');
        try { return fail((await failText(e, cfg, base, minutes, signal, entry)) + mayRun()); }
        catch (e2) {   // a Stop that lands while the error is being explained (the ssh recovery) is still a Stop: reconcile the prompt, release
          if (signal.aborted || (e2 && e2.aborted)) { if (promptId) cancelInfo = (ci0 && !unconfirmed(ci0)) ? ci0 : await cancelPrompt(base, promptId, cms); return stopped(); }   // LC2i: a cancel that already went through is not repeated
          return fail(String((e2 && e2.message) || e2));
        }
      } finally {
        for (const f of partFiles) { try { fs.unlinkSync(f); } catch (_) { /* already gone */ } }
        if (!success) for (const f of published) { try { fs.unlinkSync(f); } catch (_) { /* already gone */ } }   // B2: a run that did not end in a linked clip leaves no final file either
        // LC2d (T8-8): the clip is over (done, failed or stopped) - ask THIS ComfyUI to unload its models so the next job (a voice, a keyframe) finds the card free.
        // Best-effort and bounded: freeInstance never throws, and a ComfyUI that does not answer cannot hold the shot busy longer than freeMs.
        if (touched && lc.freeAfter !== false) {
          const ms = Number(lc.freeMs) > 0 ? Number(lc.freeMs) : 4000;
          let t = null;
          // O2: ONLY the ComfyUI this clip ran on (i2i.freeInstance never throws); another instance (Trellis, a second ComfyUI) is left alone
          try { await Promise.race([Promise.resolve(i2i.freeInstance(base)).catch(() => false), new Promise((r) => { t = setTimeout(r, ms); if (t && t.unref) t.unref(); })]); } catch (_) { /* never fails the clip */ }
          if (t) clearTimeout(t);
        }
      }
    },
  };
  return backend;
}

module.exports = { create, framesFor, setGraphFps, ID, OOM_TEXT };
