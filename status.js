'use strict';
// status.js - Phoenix status bar provider system (v1.10.1 R1). No dependencies, never throws on bad providers.
//   loadProviders(dir, log) -> providers   reads *.js in dir (sorted by file name; names starting with "_" are helpers, not providers).
//                                          A file that throws on require or has a bad shape is skipped with ONE log line naming it.
//   makeStatus(providers, ctxFn, { now? }) -> { items(), readAll() }
//                                          items(): [{ id, label, kind, order }] by order, then id.
//                                          readAll(): { items: { <id>: Reading + { at } } } - every provider in parallel, each with its own
//                                          timeout, cached for intervalMs, never more than one read in flight per provider.
//   validateLayout(body) -> { order, hidden } | null
// A provider = { id, label, kind: 'dot' | 'text' | 'meter', order, intervalMs?, timeoutMs?, read(ctx) -> Promise<Reading> };
// Reading = { state: 'ok' | 'warn' | 'bad' | 'off' | 'unknown', text, value?, max?, unit?, tip? }.
// ctx = { cfg, jobs, probeBlender, fetch, unrealState, remoteState } - the ONLY things a provider may touch.

const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KINDS = ['dot', 'text', 'meter'];
const STATES = ['ok', 'warn', 'bad', 'off', 'unknown'];
const DEFAULT_INTERVAL_MS = 20000;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_ORDER = 1000;
const MAX_LAYOUT = 64;

function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 300); }

function shapeError(p) {
  if (!p || typeof p !== 'object') return 'does not export an object';
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return 'bad id ' + JSON.stringify(p.id);
  if (typeof p.label !== 'string' || !p.label) return 'missing label';
  if (KINDS.indexOf(p.kind) < 0) return 'bad kind ' + JSON.stringify(p.kind);
  if (typeof p.read !== 'function') return 'read is not a function';
  return '';
}

function loadProviders(dir, log) {
  const say = typeof log === 'function' ? log : function () {};
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f) && f.charAt(0) !== '_'; }).sort(); } catch (_) { return out; }
  const seen = new Set();
  for (const f of names) {
    let p;
    try { p = require(path.join(dir, f)); }
    catch (e) { say('status provider ' + f + ' skipped: ' + oneLine(e && e.message || e)); continue; }
    const bad = shapeError(p);
    if (bad) { say('status provider ' + f + ' skipped: ' + bad); continue; }
    if (seen.has(p.id)) { say('status provider ' + f + ' skipped: duplicate id ' + p.id); continue; }
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function orderOf(p) { return typeof p.order === 'number' && isFinite(p.order) ? p.order : DEFAULT_ORDER; }
function sortedBy(providers) {
  return providers.slice().sort(function (a, b) { return orderOf(a) - orderOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
}

// one clean Reading, or null when the provider's answer is not one
function cleanReading(r) {
  if (!r || typeof r !== 'object' || STATES.indexOf(r.state) < 0 || typeof r.text !== 'string') return null;
  const out = { state: r.state, text: r.text };
  if (typeof r.value === 'number' && isFinite(r.value)) out.value = r.value;
  if (typeof r.max === 'number' && isFinite(r.max)) out.max = r.max;
  if (typeof r.unit === 'string') out.unit = r.unit;
  if (typeof r.tip === 'string') out.tip = r.tip;
  return out;
}

function makeStatus(providers, ctxFn, opts) {
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
  const list = sortedBy(providers || []);
  const slot = new Map();   // id -> { at, reading, flight }
  function items() { return list.map(function (p) { return { id: p.id, label: p.label, kind: p.kind, order: orderOf(p) }; }); }

  function startRead(p, ctx, s) {
    const timeoutMs = typeof p.timeoutMs === 'number' && p.timeoutMs > 0 ? p.timeoutMs : DEFAULT_TIMEOUT_MS;
    let timer = null;
    const timeout = new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error(p.label + ' did not answer within ' + timeoutMs + ' ms')); }, timeoutMs); });
    let call;
    try { call = Promise.resolve(p.read(ctx)); } catch (e) { call = Promise.reject(e); }
    // the provider call stays tracked until it really settles (a timeout answers the caller, it does not end the call)
    const pending = call.then(function () {}, function () {}).then(function () { if (s.pending === pending) s.pending = null; });
    s.pending = pending;
    s.flight = Promise.race([call, timeout]).then(function (r) {
      const clean = cleanReading(r);
      return clean || { state: 'unknown', text: '', tip: 'the provider returned something that is not a reading' };
    }, function (e) {
      return { state: 'unknown', text: '', tip: oneLine(e && e.message || e) || 'the provider failed' };
    }).then(function (reading) {
      clearTimeout(timer);
      s.reading = Object.assign({}, reading, { at: now() });
      s.at = s.reading.at;
      s.flight = null;
      return s.reading;
    });
    return s.flight;
  }

  function readAll() {
    let ctx = null;   // one fresh ctx (fresh cfg) per round, built only when something has to be read
    const jobs = list.map(function (p) {
      let s = slot.get(p.id);
      if (!s) { s = { at: 0, reading: null, flight: null }; slot.set(p.id, s); }
      if (s.flight) return s.flight.then(function (r) { return [p.id, r]; });   // single flight
      if (s.pending && s.reading) return Promise.resolve([p.id, s.reading]);     // an earlier call timed out but has not settled: no second read on top of it
      const every = typeof p.intervalMs === 'number' && p.intervalMs >= 0 ? p.intervalMs : DEFAULT_INTERVAL_MS;
      if (s.reading && now() - s.at < every) return Promise.resolve([p.id, s.reading]);
      if (!ctx) { try { ctx = ctxFn(); } catch (e) { ctx = {}; } }
      return startRead(p, ctx, s).then(function (r) { return [p.id, r]; });
    });
    return Promise.all(jobs).then(function (pairs) {
      const out = {};
      for (const pr of pairs) out[pr[0]] = pr[1];
      return { items: out };
    });
  }
  return { items: items, readAll: readAll };
}

function stringList(v) {
  if (!Array.isArray(v) || v.length > MAX_LAYOUT) return null;
  for (const x of v) if (typeof x !== 'string' || !x || x.length > 64) return null;
  return v.slice();
}
// the saved status-bar layout: arrays of ids (unknown ids are kept so a provider removed for a while keeps its place)
function validateLayout(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const order = stringList(body.order), hidden = stringList(body.hidden);
  return order && hidden ? { order: order, hidden: hidden } : null;
}

module.exports = { loadProviders, makeStatus, validateLayout, ID_RE };
