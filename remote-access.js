'use strict';

// ─── remote-access.js — R1: use Phoenix from the phone over the tailnet ───────────────────────────────────────────
// What this file is: the SECOND listener (127.0.0.1:<ephemeral>, published by `tailscale serve`, see remote-tailscale.js), the
// laptop-approved pairing, the device cookie and the request pipeline in front of the normal Phoenix `handler`. Port 7777 is
// untouched: remote traffic NEVER reaches it, and `isLocalRequest` answers `true` for a request that arrived here only because this
// module marked it with a module-private Symbol (so 7777 behaviour is byte-identical for every other request).
//
// The pipeline (every request, in this order): 1 remote off -> 503 · 2 Host must be our origin's host · 3 Origin / Sec-Fetch-Site
// (mutations + any Origin) · 4 no valid device cookie -> only the pairing page + claim endpoints · 5 laptop-only list -> 403 ·
// 6 the same `handler`, request marked remote.
//
// Lessons from the Mr. Mak audit (spec 6b) - each has code here and a test in accept.remote-access.js:
//   1 authorisation is re-checked when the body has arrived (revoked(req), called by readBody/readRawBody in server.js)
//   2 body bytes are reserved synchronously from Content-Length BEFORE the first await, plus an aggregate cap
//   3 approve is idempotent (marked approved before anything is saved)
//   4 rate limits are per bucket (claim / claim-status) and per Tailscale identity header
//   5 expired devices are pruned from the state file
//   6 no arbitrary HTML is ever served from the remote origin (own app only; /file gets nosniff + a sandbox CSP)
// Design adapted from Mr. Mak Workspace (MIT, github.com/witnesstodark/mr-mak-workspace) - the idea only, no code taken over.

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const COOKIE = 'phoenix_remote';
const SYM = Symbol('phoenix.remote.request');   // module-private: the only way a request counts as remote
// LC2i: devices whose Disconnect could not be written to disk. Process lifetime: a later load() that re-reads the old file must not give them access back.
const REVOKED = new Set();

const PAIR_TTL_MS    = 5 * 60 * 1000;
const TOMBSTONE_MS   = 10 * 60 * 1000;   // how long a timed-out request is still recognised
const TOMBSTONE_MAX  = 32;
const TIMED_OUT_PHONE  = 'This request timed out - start again from the laptop.';
const TIMED_OUT_LAPTOP = 'This request timed out - press Pair a phone to start again.';
const DEVICE_TTL_MS  = 180 * 24 * 3600 * 1000;
const SEEN_EVERY_MS  = 10 * 60 * 1000;
const MAX_DEVICES    = 8;
const MAX_PENDING    = 4;
const FLOOD_LIMIT = 300;
const CLAIM_LIMIT = 60, CLAIM_GLOBAL_LIMIT = 240, STATUS_LIMIT = 60, WINDOW_MS = 60 * 1000;
const MAX_BODY_PER_REQ = 100 * 1024 * 1024;   // = the largest upload Phoenix itself accepts (/upload-animation)
const MAX_BODY_AGGREGATE = 150 * 1024 * 1024;
const SMALL_BODY = 4096;                       // pairing endpoints / the /config pre-check

// the quick-access fields (the gear panel in the page POSTs exactly these - see DEVNOTE): everything else in POST /config is laptop-only
const QUICK_FIELDS = { gates: ['prompt', 'image', 'mesh', 'vision', 'mode'], unreal: ['brushTarget', 'visionMode'], checkpoints: ['enabled'] };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function eqHash(a, b) { try { const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex'); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); } catch (_) { return false; } }
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const digits = (n) => { let s = ''; while (s.length < n) s += String(crypto.randomInt(0, 10)); return s; };
const group6 = (s) => s.slice(0, 3) + ' ' + s.slice(3);

function cleanName(v) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 60) s = s.slice(0, 60).trim();
  return s || 'Phone';
}

// body of POST /config limited to the quick-access fields? (shape only: values are validated by the real route)
function isQuickConfigBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const keys = Object.keys(b);
  if (!keys.length) return false;
  for (const k of keys) {
    const allowed = Object.prototype.hasOwnProperty.call(QUICK_FIELDS, k) ? QUICK_FIELDS[k] : null;   // m1: "__proto__" / "constructor" are not fields
    const sec = b[k];
    if (!allowed || !sec || typeof sec !== 'object' || Array.isArray(sec)) return false;
    const sk = Object.keys(sec);
    if (!sk.length) return false;
    for (const f of sk) if (!allowed.includes(f)) return false;
  }
  return true;
}

function bucket(limit) {
  const m = new Map();
  return {
    hit(key, now) {   // true = allowed
      let e = m.get(key);
      if (!e || now - e.start >= WINDOW_MS) { e = { start: now, n: 0 }; m.set(key, e); }
      e.n++;
      if (m.size > 2000) { for (const [k, v] of m) if (now - v.start >= WINDOW_MS) m.delete(k); }
      return e.n <= limit;
    },
    reset() { m.clear(); },
  };
}

function create(opts) {
  opts = opts || {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const secretsDir = typeof opts.secretsDir === 'function' ? opts.secretsDir : () => path.join(__dirname, '.secrets');
  const transport = opts.transport;
  const getHandler = typeof opts.getHandler === 'function' ? opts.getHandler : () => null;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const limits = { perRequest: MAX_BODY_PER_REQ, aggregate: MAX_BODY_AGGREGATE };

  let loadedFrom = null, data = { devices: [], route: null };
  const claimBucket = bucket(CLAIM_LIMIT), claimGlobal = bucket(CLAIM_GLOBAL_LIMIT), statusBucket = bucket(STATUS_LIMIT), floodBucket = bucket(FLOOD_LIMIT);
  let pairing = null;            // { token, tokenHash, code, codeHash, expires }   (memory only)
  const pending = [];            // { id, name, confirm, claimHash, expires, status, credential, deviceId }
  const tombstones = new Map();  // id -> { claimHash, at } of a request that timed out
  let sweepTimer = null;
  const pairTtl = Number(opts.pairTtlMs) > 0 ? Number(opts.pairTtlMs) : PAIR_TTL_MS;   // opts.pairTtlMs: tests only
  const streams = new Set();     // { req, res, deviceId }
  const sockets = new Set();
  const active = new Set();      // remote requests that passed the pipeline (ctx); those whose body is still arriving die with their device
  let reserved = 0;
  let listener = null, listenerPort = 0, listenerStarting = null;
  let st = { state: 'off', origin: null, error: '', port: null };
  let chain = Promise.resolve();
  let originHost = null;

  // ── persistent state: .secrets/remote-access.json (devices store a HASH only) ──
  const file = () => path.join(secretsDir(), 'remote-access.json');
  function load() {
    const f = file();
    if (loadedFrom === f) return;
    loadedFrom = f;
    data = { devices: [], route: null };
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && Array.isArray(j.devices)) data.devices = j.devices.filter(d => d && typeof d.id === 'string' && typeof d.hash === 'string' && !REVOKED.has(d.id));
      if (j && j.route && typeof j.route === 'object' && j.route.hostname && j.route.port && j.route.target) data.route = { hostname: String(j.route.hostname), port: Number(j.route.port), target: String(j.route.target) };
    } catch (_) { /* first run / unreadable: start empty */ }
    prune(true);
  }
  const unsaved = new Map();   // id -> device view of a Disconnect whose write failed (this instance)
  let saveError = '';
  function save() {   // true = on disk. Never throws; callers that must know (Disconnect, approve) look at the answer, the rest keep logging only
    const f = file();
    if (data.devices.some(d => REVOKED.has(d.id))) data.devices = data.devices.filter(d => !REVOKED.has(d.id));   // LC2i: a revoked phone cached by this instance is never written back
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = f + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ devices: data.devices, route: data.route }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, f);
      saveError = '';
      return true;
    } catch (e) { saveError = String((e && e.message) || e); log('remote-access: could not save its state: ' + saveError); return false; }
  }
  const saveTwice = () => save() || save();   // one retry: a virus scanner holding the file for a moment is the usual cause
  // lesson 5: expired devices leave the file
  function prune(write) {
    const t = now();
    const keep = data.devices.filter(d => !(Number(d.expires) > 0 && Number(d.expires) <= t));
    const changed = keep.length !== data.devices.length;
    if (changed) { for (const d of data.devices) if (!keep.includes(d)) { cancelActive(d.id); closeStreamsOf(d.id); } data.devices = keep; if (write !== false) save(); }
    return changed;
  }
  function prunePending() {
    const t = now();
    let removed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (p.expires <= t) {
        // an approved request that was never picked up: its device would be an orphan nobody holds
        if (p.status === 'approved' && p.credential && p.deviceId) { data.devices = data.devices.filter(d => d.id !== p.deviceId); save(); }
        tombstones.set(p.id, { claimHash: p.claimHash, at: t });   // the phone must still learn "timed out", not "unknown"
        pending.splice(i, 1);
        removed = true;
      }
    }
    if (pairing && pairing.expires <= t) { pairing = null; removed = true; }
    for (const [id, tb] of tombstones) if (t - tb.at > TOMBSTONE_MS) tombstones.delete(id);
    while (tombstones.size > TOMBSTONE_MAX) tombstones.delete(tombstones.keys().next().value);
    armSweep();
    if (removed) emit();   // emit -> view() -> prunePending() finds nothing: no recursion
  }
  // one timer for the earliest open request: the laptop row goes without a click or a reload (unref: never keeps Phoenix alive)
  function armSweep() {
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    let first = Infinity;
    for (const p of pending) if (p.status === 'pending' && p.expires < first) first = p.expires;
    if (first === Infinity) return;
    sweepTimer = setTimeout(() => { sweepTimer = null; prunePending(); }, Math.max(0, first - now()) + 250);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  const emit = () => { try { onChange(view()); } catch (_) {} };
  function setState(patch) { st = Object.assign({}, st, patch); emit(); }

  // ── devices ──
  function cookieOf(req) {
    const c = String((req.headers || {}).cookie || '');
    for (const part of c.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }
  function authenticate(req) {
    load();
    const cred = cookieOf(req);
    if (!cred || cred.length > 200) return null;
    prune(true);
    const h = sha(cred);
    let found = null;
    for (const d of data.devices) if (eqHash(h, d.hash)) found = d;   // no early exit: constant work over <= 8 devices
    if (!found || REVOKED.has(found.id)) return null;
    const t = now();
    if (!found.lastSeen || t - found.lastSeen >= SEEN_EVERY_MS) { found.lastSeen = t; save(); }
    return found;
  }
  // C1: a request is authorised only while it was not cancelled (client closed / device disconnected / switched off - never reset), its device is listed,
  // Remote access is on, AND the listener generation is the one it arrived on (off -> on again does not revive an old request)
  let gen = 0;
  function stillAuthorised(ctx) {
    if (!ctx || ctx.cancelled || ctx.gen !== gen) return false;
    load();
    if (st.state !== 'on') return false;
    prune(true);
    return !REVOKED.has(ctx.deviceId) && data.devices.some(d => d.id === ctx.deviceId);
  }
  function cancelActive(deviceId) { for (const c of active) if (deviceId == null || c.deviceId === deviceId) c.cancelled = true; }
  function invalidateAll() { gen++; cancelActive(null); closeStreamsOf(null); abortActiveOf(null); destroySockets(); }
  function closeStreamsOf(deviceId) {
    for (const s of Array.from(streams)) {
      if (deviceId == null || s.deviceId === deviceId) { streams.delete(s); try { s.res.end(); } catch (_) {} try { s.req.destroy(); } catch (_) {} }
    }
  }
  function abortActiveOf(deviceId) {
    for (const c of Array.from(active)) if ((deviceId == null || c.deviceId === deviceId) && !c.req.complete) { active.delete(c); try { c.req.destroy(); } catch (_) {} }
  }
  function destroySockets() { for (const s of Array.from(sockets)) { try { s.destroy(); } catch (_) {} } sockets.clear(); }

  // ── responses ──
  function json(res, code, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }, extra || {}));
    res.end(body);
  }
  // C2: the SOURCE = the LAST hop of X-Forwarded-For (the tailnet peer address Serve appends) - never the client-supplied start of the header, never the login (devices of one login share it)
  const clientKey = (req) => {
    const h = req.headers || {};
    const x = String(h['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    return x.length ? 'ip:' + x[x.length - 1].slice(0, 80) : '-';
  };
  // B3: pairing bodies are small and bounded: 8 KB is reserved (counted in the aggregate) synchronously BEFORE the body is read
  const SMALL_RESERVE = 8192;
  function reserveSmall(req, res) {
    const h = req.headers;
    if (h['content-length'] === undefined && /chunked/i.test(String(h['transfer-encoding'] || ''))) { json(res, 411, { error: 'Send a Content-Length with this request.' }); return null; }
    const len = h['content-length'] === undefined ? 0 : Number(h['content-length']);
    if (!Number.isInteger(len) || len < 0) { json(res, 400, { error: 'Bad Content-Length.' }); return null; }
    if (len > SMALL_BODY) { json(res, 413, { error: 'Too large.' }); return null; }
    if (reserved + SMALL_RESERVE > limits.aggregate) { json(res, 413, { error: 'Too many requests at once - try again in a moment.' }); return null; }
    reserved += SMALL_RESERVE;
    let released = false;
    const release = () => { if (!released) { released = true; reserved -= SMALL_RESERVE; } };
    res.once('close', release); res.once('finish', release);
    return release;
  }

  function readSmall(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0, dead = false;
      req.on('data', (c) => { if (dead) return; n += c.length; if (n > SMALL_BODY) { dead = true; const e = new Error('too large'); e.tooLarge = true; reject(e); return; } chunks.push(c); });
      req.on('end', () => { if (!dead) resolve(Buffer.concat(chunks)); });
      req.on('error', (e) => { if (!dead) reject(e); });
    });
  }

  // ── pairing (laptop side) ──
  async function startPairing() {
    load(); prunePending();
    if (st.state !== 'on' || !st.origin) return { ok: false, status: 409, error: 'Switch Remote access on first.' };
    if (data.devices.length >= MAX_DEVICES) return { ok: false, status: 409, error: 'Eight phones are already paired - disconnect one first.' };
    if (transport.funnelOn) {   // C3: no pairing code while ANY Funnel is on for this host (it could have been turned on after switch-on)
      let f = null; try { f = await transport.funnelOn(st.origin.replace(/^https:\/\//, '').replace(/:\d+$/, '')); } catch (_) {}
      if (f !== false) { pairing = null; emit(); return { ok: false, status: 409, error: f === null ? 'Phoenix could not check Tailscale Funnel - pairing is off until it can.' : 'Tailscale Funnel (public internet) is on for this PC - turn it off before pairing a phone.' }; }
      if (st.state !== 'on') return { ok: false, status: 409, error: 'Switch Remote access on first.' };
    }
    pairing = { token: rnd(24), code: digits(8), expires: now() + pairTtl };
    pairing.tokenHash = sha(pairing.token); pairing.codeHash = sha(pairing.code);
    emit();
    return { ok: true, pairing: pairingView() };
  }
  function pairingView() {
    if (!pairing || pairing.expires <= now()) return null;
    return { link: st.origin + '/remote/#pair=' + pairing.token, code: pairing.code, expiresAt: pairing.expires };
  }
  function approve(id) {
    load(); prunePending();
    const p = pending.find(x => x.id === id);
    if (!p && tombstones.has(id)) return { ok: false, status: 410, error: TIMED_OUT_LAPTOP };
    if (!p) return { ok: false, status: 404, error: 'That request is gone - ask the phone to try again.' };
    if (p.status === 'approved') return { ok: true, duplicate: true, device: deviceView(data.devices.find(d => d.id === p.deviceId)) };   // lesson 3: idempotent
    if (p.status !== 'pending') return { ok: false, status: 409, error: 'That request was already answered.' };
    if (data.devices.length >= MAX_DEVICES) return { ok: false, status: 409, error: 'Eight phones are already paired - disconnect one first.' };
    p.status = 'approved';   // lesson 3: marked BEFORE anything is created or saved, so a second click can not make a second device
    const credential = rnd(32);
    const t = now();
    const dev = { id: crypto.randomBytes(6).toString('hex'), name: p.name, hash: sha(credential), createdAt: t, lastSeen: t, expires: t + DEVICE_TTL_MS };
    p.credential = credential; p.deviceId = dev.id;
    data.devices.push(dev);
    if (!saveTwice()) {   // LC2i: no credential for a device that would not survive a restart - undo, the request stays open for another try
      data.devices = data.devices.filter(d => d !== dev);
      p.status = 'pending'; p.credential = null; p.deviceId = null;
      emit();
      return { ok: false, status: 500, error: 'The phone could not be approved: Phoenix could not save the pairing (' + saveError + '). Fix the file and press Approve again.' };
    }
    emit();
    return { ok: true, device: deviceView(dev) };
  }
  function reject(id) {
    prunePending();
    const p = pending.find(x => x.id === id);
    if (!p && tombstones.has(id)) return { ok: false, status: 410, error: TIMED_OUT_LAPTOP };
    if (!p) return { ok: false, status: 404, error: 'That request is gone.' };
    if (p.status === 'approved') return { ok: false, status: 409, error: 'That request was already answered.' };
    if (p.status === 'pending') p.status = 'rejected';
    emit();
    return { ok: true };
  }
  function disconnect(id) {
    load();
    const before = data.devices.length;
    const owed = unsaved.has(id);   // an earlier Disconnect of this phone could not be written: pressing it again retries the write
    const gone = data.devices.find(d => d.id === id);
    data.devices = data.devices.filter(d => d.id !== id);
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].deviceId === id) pending.splice(i, 1);
    cancelActive(id); closeStreamsOf(id); abortActiveOf(id);
    const removed = data.devices.length !== before;
    if (removed || owed) {
      if (typeof id === 'string' && id) REVOKED.add(id);   // refused from this moment on, whatever a later load() reads
      if (!saveTwice()) {
        if (!unsaved.has(id)) unsaved.set(id, gone ? { id: gone.id, name: gone.name, createdAt: gone.createdAt, lastSeen: gone.lastSeen, expires: gone.expires } : { id, name: 'Phone' });   // the view keeps listing it, so the Disconnect button stays
        emit();
        return { ok: false, status: 500, error: 'The phone is disconnected until Phoenix restarts, but the change could not be saved (' + saveError + '). Fix the file and press Disconnect again.' };
      }
      unsaved.delete(id);   // the file no longer lists it. REVOKED is NEVER cleared: another instance may still hold the old credential, and a re-paired phone gets a new id
    }
    emit();
    return { ok: removed || owed, status: removed || owed ? 200 : 404, error: removed || owed ? undefined : 'No such device.' };
  }
  const connectedIds = () => new Set(Array.from(streams).map(s => s.deviceId));
  function deviceView(d) { return d ? { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, expires: d.expires, connected: connectedIds().has(d.id) } : null; }
  function view() {
    load(); prunePending();
    return {
      state: st.state, origin: st.origin, error: st.error,
      pairing: pairingView(),
      pending: pending.filter(p => p.status === 'pending').map(p => ({ id: p.id, name: p.name, confirm: group6(p.confirm), expiresAt: p.expires })),
      devices: data.devices.map(deviceView).concat(Array.from(unsaved.values()).map(u => Object.assign({}, u, { connected: false, unsaved: true }))),   // LC2i: a revocation not on disk yet stays listed (never authorised again)
    };
  }

  // ── pairing (phone side, public endpoints) ──
  async function claim(req, res) {
    const t = now(), key = clientKey(req);
    if (!reserveSmall(req, res)) return;                                                  // B3: reserve BEFORE reading
    let b;
    try { b = JSON.parse((await readSmall(req)).toString('utf8')); } catch (_) { return json(res, 400, { error: 'Bad request.' }); }
    if (!b || typeof b !== 'object') return json(res, 400, { error: 'Bad request.' });
    load(); prunePending();
    const bad = () => json(res, 403, { error: 'This pairing link or code is not valid anymore - start a new one in Phoenix on the laptop.' });
    const limited = () => json(res, 429, { error: 'Too many attempts - wait a minute and try again.' });
    // B4 (lesson 4 again): the 192-bit token path is NEVER refused for rate when it matches - a tailnet peer can not starve the real phone.
    // Wrong tokens count against the sender's own bucket; the 8-digit code (guessable) is limited per identity AND globally.
    let match = false;
    if (typeof b.token === 'string') {
      match = !!pairing && b.token.length > 0 && b.token.length < 200 && eqHash(sha(b.token), pairing.tokenHash);
      if (!match && !claimBucket.hit(key, t)) return limited();
    } else {
      const okKey = claimBucket.hit(key, t), okGlobal = claimGlobal.hit('*', t);
      if (!okKey || !okGlobal) return limited();
      if (pairing && typeof b.code === 'string') { const c = b.code.replace(/\D/g, ''); match = c.length === 8 && eqHash(sha(c), pairing.codeHash); }
    }
    if (!match) return bad();
    if (data.devices.length >= MAX_DEVICES) return json(res, 409, { error: 'Eight phones are already paired - disconnect one in Phoenix on the laptop first.' });
    if (pending.filter(p => p.status === 'pending').length >= MAX_PENDING) return json(res, 409, { error: 'Too many open requests - answer or reject them on the laptop first.' });
    pairing = null;   // one-time: consumed
    const claimSecret = rnd(24);
    const p = { id: crypto.randomBytes(6).toString('hex'), name: cleanName(b.name), confirm: digits(6), claimHash: sha(claimSecret), expires: t + pairTtl, status: 'pending', credential: null, deviceId: null };
    pending.push(p);
    armSweep();
    emit();
    return json(res, 200, { id: p.id, claim: claimSecret, confirm: group6(p.confirm), expiresIn: Math.round(pairTtl / 1000) });
  }
  async function claimStatus(req, res) {
    const t = now();
    if (!reserveSmall(req, res)) return;
    let b;
    try { b = JSON.parse((await readSmall(req)).toString('utf8')); } catch (_) { return json(res, 400, { error: 'Bad request.' }); }
    prunePending();
    const p = b && typeof b.id === 'string' ? pending.find(x => x.id === b.id) : null;
    const valid = !!(p && typeof b.claim === 'string' && eqHash(sha(b.claim), p.claimHash));
    const tb = !p && b && typeof b.id === 'string' ? tombstones.get(b.id) : null;
    if (tb && typeof b.claim === 'string' && eqHash(sha(b.claim), tb.claimHash)) return json(res, 410, { status: 'expired', error: TIMED_OUT_PHONE });
    // lesson 4: a poll that carries the right claim secret never counts; only wrong guesses fill this (separate) bucket
    if (!valid) {
      if (!statusBucket.hit(clientKey(req), t)) return json(res, 429, { error: 'Too many attempts - wait a minute and try again.' });
      return json(res, 403, { status: 'unknown', error: 'Unknown or expired request.' });
    }
    if (p.expires <= t) return json(res, 410, { status: 'expired', error: TIMED_OUT_PHONE });
    if (p.status === 'rejected') return json(res, 200, { status: 'rejected' });
    if (p.status === 'pending') return json(res, 200, { status: 'pending', confirm: group6(p.confirm) });
    // approved: hand the credential over exactly once, as an HttpOnly cookie
    const cred = p.credential;
    if (!cred) return json(res, 410, { status: 'expired', error: 'Already connected - if this phone lost access, pair it again.' });
    p.credential = null;
    const idx = pending.indexOf(p); if (idx >= 0) pending.splice(idx, 1);
    const dev = data.devices.find(d => d.id === p.deviceId);
    const maxAge = Math.max(60, Math.round(((dev && dev.expires) || (t + DEVICE_TTL_MS)) / 1000 - t / 1000));
    return json(res, 200, { status: 'approved', name: p.name }, { 'Set-Cookie': COOKIE + '=' + cred + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + maxAge });
  }

  // ── the pairing page (the only page an unpaired phone can see) ──
  function servePairPage(req, res) {
    const f = path.join(__dirname, 'web', 'remote-pair.html');
    fs.readFile(f, (err, buf) => {
      if (err) return json(res, 404, { error: 'Pairing page missing.' });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(buf);
    });
  }

  // ── the laptop-only list (spec 4.5). Returns the "what" or null. /config is decided on its body by the caller. ──
  function laptopOnlyWhat(method, p0) {
    let p = p0; try { p = decodeURIComponent(p0); } catch (_) {}
    p = p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase(); if (p.length > 1) p = p.replace(/\/+$/, '');   // every spelling of the path
    if (p.startsWith('/workflows/acquire')) return 'installing workflow models';
    if (p.startsWith('/workflows/custom') || p === '/workflows/raw' || p === '/workflows/delete') return 'editing workflows';
    if (p.startsWith('/workflows/params')) return 'workflow parameters';
    if (p.startsWith('/voice/dispatcher')) return 'the voice engines';
    if (p === '/onboarding/complete') return 'the first-run setup';
    if (p === '/images/trash/empty') return 'emptying the trash';
    if (p === '/secrets') return 'API keys';
    if (p === '/status/layout') return 'the status bar layout';
    if (p === '/mcp' || p.startsWith('/mcp/')) return 'the MCP connection';
    if (p === '/workflows/uninstall') return 'uninstalling a workflow';
    if (p === '/seat-probe' || p === '/seat-bench') return 'testing a model seat';
    if (p === '/remesh-balance') return 'the Meshy balance';
    if ((p === '/palette' && method !== 'GET' && method !== 'HEAD') || p === '/palette/draft' || p === '/palette/reset') return 'the style palette';   // LC2i: shares the workflow-parameter store; /draft runs the orchestrator seat
    if (p === '/voice-refs-open' || p === '/voice-open' || p === '/sfx-open') return 'opening folders on the laptop';   // LC2i: runs Explorer on the laptop
    if (p.startsWith('/remote/api/') && p !== '/remote/api/me') return 'Remote access settings';
    return null;
  }

  // ── lesson 2: reserve body bytes synchronously, before any await ──
  function reserveBody(req, res) {
    const m = req.method;
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { ok: true, release() {} };
    const h = req.headers;
    const hasCl = h['content-length'] !== undefined;
    if (!hasCl && /chunked/i.test(String(h['transfer-encoding'] || ''))) return { ok: false, code: 411, error: 'Send a Content-Length with this request.' };
    const len = hasCl ? Number(h['content-length']) : 0;
    if (!Number.isInteger(len) || len < 0) return { ok: false, code: 400, error: 'Bad Content-Length.' };
    if (len > limits.perRequest) return { ok: false, code: 413, error: 'That file is too large for the remote connection.' };
    if (reserved + len > limits.aggregate) return { ok: false, code: 413, error: 'Too many uploads at once - try again in a moment.' };
    reserved += len;   // <-- synchronous: the next request sees it
    let released = false;
    const release = () => { if (!released) { released = true; reserved -= len; } };
    res.once('close', release); res.once('finish', release);
    // m3: nothing is attached to the request here - a 'data' listener would start the flow, and a route that awaits before reading its body would lose it.
    // (Node's HTTP parser itself never delivers more than Content-Length bytes.)
    return { ok: true, release };
  }

  // B1: a remote request that lost its authorisation (or was cut) is answered 401 if it still can be, then the request is destroyed
  function abandon(req) {
    const c = req && req[SYM];
    if (!c) return;
    try {
      if (!c.res.headersSent) { c.res.once('finish', () => { try { req.destroy(); } catch (_) {} }); json(c.res, 401, { error: 'Not paired - open the pairing link from Phoenix on the laptop.' }); }
      else req.destroy();
    } catch (_) { try { req.destroy(); } catch (__) {} }
  }

  // ── the pipeline ──
  async function remoteHandler(req, res) {
    try { await pipeline(req, res); }
    catch (e) {
      try { if (!res.headersSent) json(res, 500, { error: 'Internal Server Error' }); else res.end(); } catch (_) {}
      log('remote-access: unhandled ' + (e && e.message));
    }
  }
  async function pipeline(req, res) {
    const h = req.headers || {};
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    let u; try { u = new URL(req.url, 'http://x'); } catch (_) { return json(res, 400, { error: 'Bad request.' }); }
    const p = u.pathname, method = req.method;
    // 1
    if (st.state !== 'on' || !st.origin) return json(res, 503, { error: 'Remote access is off - switch it on in Phoenix on the laptop.' });
    // 2
    if (String(h.host || '').toLowerCase() !== originHost) return json(res, 403, { error: 'Unexpected host' });
    // 3
    if (method === 'OPTIONS') { res.writeHead(204, { 'Content-Length': 0 }); return res.end(); }
    const mutation = method !== 'GET' && method !== 'HEAD';
    if ((mutation || h.origin !== undefined) && h.origin !== st.origin) return json(res, 403, { error: 'Cross-site request refused.' });
    const pairNav = method === 'GET' && (p === '/remote/' || p === '/remote');
    // m2: only same-origin / none / absent (the QR-scan navigation to /remote/ excepted)
    const sfs = String(h['sec-fetch-site'] || '').toLowerCase();
    if (sfs !== '' && sfs !== 'same-origin' && sfs !== 'none' && !pairNav) return json(res, 403, { error: 'Cross-site request refused.' });
    // 4
    const dev = authenticate(req);
    const isClaim = method === 'POST' && p === '/remote/api/claim', isStatus = method === 'POST' && p === '/remote/api/claim-status';
    if (!dev) {
      if (pairNav) return servePairPage(req, res);
      if (isClaim) return claim(req, res);
      if (isStatus) return claimStatus(req, res);
      // a reload of any page by an unpaired phone lands on the pair page, not on raw JSON (fetches and non-GET keep the 401)
      const mode = h['sec-fetch-mode'], dest = h['sec-fetch-dest'];
      const nav = method === 'GET' && (mode !== undefined || dest !== undefined
        ? String(mode).toLowerCase() === 'navigate' || String(dest).toLowerCase() === 'document'
        : /text\/html/i.test(String(h.accept || '')));
      if (nav) { res.writeHead(302, { Location: '/remote', 'Cache-Control': 'no-store', 'Content-Length': 0 }); return res.end(); }
      return json(res, 401, { error: 'Not paired - open the pairing link from Phoenix on the laptop.' });
    }
    // a paired phone that lands on the pair page again (QR scanned twice, an old tab) goes home; no-store so a revoked phone sees the pair page again
    if (pairNav) { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', 'Content-Length': 0 }); return res.end(); }
    if (isClaim || isStatus) return json(res, 409, { error: 'This phone is already paired.', paired: true });
    // 5
    const what = laptopOnlyWhat(method, String(req.url).split(/[?#]/)[0]) || laptopOnlyWhat(method, p);   // the RAW path too: "//workflows//acquire" parses to a host in URL() but is still a spelling to refuse
    if (what) return json(res, 403, { error: 'Only on the laptop: ' + what + '.' });
    // 6 (reserve first - synchronous - then the /config look at the body)
    const resv = reserveBody(req, res);
    if (!resv.ok) return json(res, resv.code, { error: resv.error });
    const ctx = { deviceId: dev.id, name: dev.name, res, req, body: null, cancelled: false, gen };
    req[SYM] = ctx;
    active.add(ctx);
    res.once('close', () => { if (!res.writableEnded) ctx.cancelled = true; active.delete(ctx); });   // C1: the client went away before the answer
    req.once('aborted', () => { ctx.cancelled = true; });
    if (method === 'POST' && p === '/config') {
      let buf;
      try { buf = await readSmall(req); } catch (e) { return json(res, e && e.tooLarge ? 413 : 400, { error: 'Only on the laptop: settings.' }); }
      let b = null; try { b = JSON.parse(buf.toString('utf8')); } catch (_) {}
      if (!isQuickConfigBody(b)) return json(res, 403, { error: 'Only on the laptop: settings (the phone may change the quick switches only).' });
      if (!stillAuthorised(ctx)) return json(res, 401, { error: 'Not paired - open the pairing link from Phoenix on the laptop.' });
      ctx.body = buf;
    }
    if (method === 'GET' && p === '/events') {
      const entry = { req, res, deviceId: dev.id };
      streams.add(entry);
      res.on('close', () => { streams.delete(entry); emit(); });
      emit();
    }
    if (p === '/file') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");   // lesson 6: a served file can never run as a page here
    const handler = getHandler();
    if (typeof handler !== 'function') return json(res, 503, { error: 'Phoenix is not ready.' });
    await handler(req, res);
  }

  // ── the second listener ──
  function ensureListener() {
    if (listener && listener.listening) return Promise.resolve(listenerPort);
    if (listenerStarting) return listenerStarting;
    listenerStarting = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => { remoteHandler(req, res); });
      s.requestTimeout = 30000; s.headersTimeout = 15000;
      s.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
      s.once('error', (e) => { listenerStarting = null; reject(e); });
      s.listen(0, '127.0.0.1', () => { listener = s; listenerPort = s.address().port; listenerStarting = null; resolve(listenerPort); });
    });
    return listenerStarting;
  }
  function stopListener() {
    const s = listener; listener = null; listenerPort = 0;
    return new Promise((resolve) => { if (!s) return resolve(); try { s.close(() => resolve()); } catch (_) { resolve(); } destroySockets(); });
  }

  // ── on / off ──
  function setEnabled(on) {
    const run = async () => {
      load();
      if (!on) return turnOff('');
      const wasOn = st.state === 'on', prevOrigin = st.origin;
      if (!wasOn) setState({ state: 'enabling', error: '' });   // C5: already on -> the re-point happens silently, in-flight requests keep going
      let r;
      try {
        const port = await ensureListener();
        r = await transport.enable({ listenerPort: port, savedRoute: data.route, onRouteSet: (route) => { data.route = route; save(); } });   // m4: the route is ours (and on disk) before it is verified
      } catch (e) { r = { ok: false, error: 'Remote access could not start: ' + (e && e.message || e) }; }
      if (!r.ok) {
        originHost = null;
        if (wasOn) invalidateAll();
        setState({ state: 'error', origin: null, error: r.error, port: null });
        return view();
      }
      data.route = { hostname: r.hostname, port: r.port, target: r.target };
      save();
      originHost = r.origin.replace(/^https:\/\//, '').toLowerCase();
      if (wasOn && prevOrigin !== r.origin) invalidateAll();   // a real address change cuts everything; the same address does not
      setState({ state: 'on', origin: r.origin, error: '', port: r.port });
      return view();
    };
    chain = chain.then(run, run);
    return chain;
  }
  async function turnOff(errText, closeListener) {
    // close every remote stream and socket first, then withdraw our own route (only if it is still ours)
    const route = data.route;
    originHost = null;
    setState({ state: 'off', origin: null, error: errText || '', port: null });
    invalidateAll();
    pairing = null; pending.length = 0; tombstones.clear();
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    if (route) {
      let d = null;
      try { d = await transport.disable(route); } catch (_) {}
      if (d && d.ok) { data.route = null; save(); }   // a failed `serve status` keeps the route so the next start can retry
    }
    if (closeListener) await stopListener();   // the listener stays up while Phoenix runs: an "off" phone gets a plain 503, not a dead socket
    emit();
    return view();
  }
  // Phoenix start: re-point the route when enabled; clean up our own stale route when it is not
  async function start(enabled) {
    load();
    if (enabled) return setEnabled(true);
    if (data.route) { chain = chain.then(() => turnOff(''), () => turnOff('')); return chain; }
    return view();
  }
  function shutdown() { chain = chain.then(() => turnOff('', true), () => turnOff('', true)); return chain; }

  return {
    // used by server.js
    handler: remoteHandler,
    isRemoteReq: (req) => !!(req && req[SYM]),
    deviceOf: (req) => (req && req[SYM]) ? { id: req[SYM].deviceId, name: req[SYM].name } : null,
    bufferedBody: (req) => (req && req[SYM] && req[SYM].body) || null,
    // lesson 1: false = this request's device (or the whole feature) is gone; refuses the pending response itself
    revoked(req) {
      const c = req && req[SYM];
      if (!c) return false;
      if (stillAuthorised(c)) return false;
      abandon(req);
      return true;
    },
    // B2: true for a non-remote request; for a remote one only while its device is still paired and Remote access is on (no side effects)
    authorised(req) { const c = req && req[SYM]; return !c || stillAuthorised(c); },
    abandon,
    isRemoteStream: (res) => { for (const s of streams) if (s.res === res) return true; return false; },
    _transport: transport, setEnabled, start, shutdown, view, startPairing, approve, reject, disconnect,
    ensureListener,
    // tests
    _limits: limits, _port: () => listenerPort, _sockets: () => sockets.size, _streams: () => streams.size, _reserved: () => reserved,
    _reset() { claimBucket.reset(); claimGlobal.reset(); statusBucket.reset(); floodBucket.reset(); },
    _data: () => data, _pending: () => pending, _pairing: () => pairing, _tombstones: () => tombstones.size,
    QUICK_FIELDS, isQuickConfigBody, cleanName,
  };
}

module.exports = { create, COOKIE, QUICK_FIELDS, isQuickConfigBody, cleanName, MAX_DEVICES };
