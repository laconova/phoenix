'use strict';
// providers/fal-video.js — v1.10 V3: paid video through fal.ai (Kling 3 Pro image-to-video), opt-in. Node stdlib + global fetch.
//
//   planJob(job)                     -> { ok:true, shots, seconds, elements, audio } | { ok:false, error, code }     (pure, no file access, no network)
//   estimate(job, cfg)               -> { ok:true, usd, seconds, rate, audio, source, line } | { ok:false, error }   (the mandatory cost line, contract 4)
//   buildRequest(job, { outputDir }) -> { ok:true, input, seconds, audio, prompts, keyframe } | { ok:false, error, code }
//   submit(input, { key, ... })      -> { ok:true, requestId, statusUrl, responseUrl, cancelUrl } | { ok:false, error, code }
//   waitAndFetch(task, { key, ... }) -> { ok:true, mp4:Buffer, ms } | { ok:false, error, code, terminal?, downloadable? }
//   cancel(task, { key, ... })       -> { confirmed:true } | { alreadyCompleted:true } | { confirmed:false, error }
//
// The key is only ever sent as `Authorization: Key <key>` to URLs on the queue host (the origin of baseUrl). It — and every
// data URI — never appears in a returned message. Every test points `fetchImpl` at a fake (no real call in tests).
// shortBody() below is a VERBATIM COPY of providers/meshy.js's (not lifted into a shared module: meshy.js and accept.remesh.js stay untouched).
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://queue.fal.run';
const DEFAULT_MODEL = 'fal-ai/kling-video/v3/pro/image-to-video';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;      // one image > 10 MB raw is refused before any request
const MAX_PROMPT = 512;   // fal's prompt limit (V1b compiles up to 1000: a longer prompt is REFUSED with an exact message, never cut silently)
const MAX_SHOTS = 6, MIN_TOTAL_S = 3, MAX_TOTAL_S = 15, MAX_ELEMENTS = 3;
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const CREATE_TIMEOUT_MS = 120000;       // the upload (data URIs) can be big
const REQUEST_TIMEOUT_MS = 15000;       // every status / result / cancel call
const DOWNLOAD_STALL_MS = 60000;        // no bytes for this long = stalled
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;   // refuse a clip larger than 1 GB
const DEFAULT_PRICE = { audioOff: 0.112, audioOn: 0.168 };   // fal model page, read 13.10.2026 (the pricing page says $0.14/s: estimates only)
const FAILED_STATES = ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'];   // LC2i: fal's own conclusive end of a request; any other unknown status value is retried, not a verdict
const CREATE_MAYBE_CHARGED = 'fal did not answer in time — the request may have been created and charged anyway. Check your fal dashboard (Requests) before retrying.';
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);   // errors that prove the request never left the machine

const fail = (error, code) => ({ ok: false, error, code: code || 'error' });

// The key, both halves of an id:secret key, and their percent-encoded forms (encodeURIComponent, and every byte as %xx in either case) are removed from any text.
const keyParts = (key) => (key ? [String(key)].concat(String(key).split(':').filter(x => x.length >= 8)) : []);
const pctAll = (s) => Array.from(Buffer.from(String(s), 'utf8')).map(b => '%' + b.toString(16).padStart(2, '0')).join('');
// ONE tolerant decoder: every valid %hh (either case) is replaced individually, a malformed escape ('%', '%f', '%zz') is left as it is and never stops the rest;
// repeated until nothing changes (max 6 rounds). Everything that compares against the key goes through this canonical form.
// No fixed round cap: every round that changes the string strictly shortens it (each %hh becomes one char), so "until stable" terminates after at most
// length rounds; that is also the hard safety bound. If the bound were ever hit with valid escapes still left, the state is "open" and callers FAIL CLOSED.
// ASCII controls and every kind of whitespace (incl. unicode spaces / zero-width / BOM) are STRIPPED before matching: a URL parser drops TAB/CR/LF, so a key split by one is still the key.
const CTL_RE = /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/;
const CTL_G = new RegExp(CTL_RE.source, 'g');
function canonicalState(s) {
  let cur = String(s == null ? '' : s).replace(CTL_G, '');
  const bound = cur.length + 1;
  for (let i = 0; i < bound; i++) {
    // UTF-8 aware: a run of consecutive %hh is decoded together (so %E2%80%83 becomes U+2003 and is then stripped as whitespace); invalid UTF-8 falls back to per-byte
    const d = cur.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => { try { return decodeURIComponent(run); } catch (_) { return run.replace(/%([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))); } }).replace(CTL_G, '');
    if (d === cur) return { c: cur, open: false };
    cur = d;
  }
  return { c: cur, open: /%[0-9a-fA-F]{2}/.test(cur) };
}
const canonical = (s) => canonicalState(s).c;
const hasSecret = (s, key) => { const st = canonicalState(s); return st.open || keyParts(key).some(k => st.c.includes(k)); };   // case-sensitive on the key bytes; an undecodable-to-the-end text is treated as secret-bearing
const HIDDEN = '[fal response hidden: contained the API key]';
// Redaction, fail closed: when the canonical form of the text contains the key or a half, the WHOLE affected token (split on whitespace, quotes, & ? =) becomes [key];
// if the secret is still reachable afterwards (it spanned tokens) the whole message is replaced by HIDDEN.
function scrubSecret(text, key) {
  let s = String(text == null ? '' : text);
  if (!key || !hasSecret(s, key)) return s;
  s = s.split(/([\s"'&?=]+)/).map((tok, i) => (i % 2 === 0 && tok && hasSecret(tok, key) ? '[key]' : tok)).join('');
  return hasSecret(s, key) ? HIDDEN : s;
}

// A server-supplied body goes into a message only after the key, any data URI and long base64-ish runs are scrubbed, and cut short.
function shortBody(text, key) {
  let t = String(text == null ? '' : text);
  if (key) t = scrubSecret(t, key);
  t = t.replace(/data:[^"'\s]*/gi, '[data]').replace(/base64,[A-Za-z0-9+/=]*/gi, '[data]')
       .replace(/[A-Za-z0-9+/=]{40,}/g, '…').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, 160).join('');
}

function httpError(status, text, key) {
  if (status === 401 || status === 403) return fail('fal rejected the API key — check it in Settings → Connections', 'auth');
  if (status === 402) return fail('fal: not enough balance', 'credits');
  if (status === 429) return fail('fal is rate-limiting — try again in a minute', 'rate');
  return fail('fal HTTP ' + status + ': ' + shortBody(text, key), 'http');
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));
function withTimeout(signal, ms) {
  if (typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return signal;
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  if (AbortSignal.any) return AbortSignal.any([signal, t]);
  return signal;
}

// the key is only ever sent to the origin of the queue base URL
function sameOrigin(u, base) {
  try { return typeof u === 'string' && new URL(u).origin === new URL(base).origin; } catch (_) { return false; }
}
// A value fal supplied (request id, queue URL, clip URL) must never carry secret data: the API key (or either half of an id:secret key, also URL-encoded),
// user:password in a URL, and - for queue URLs - query parameters that look like credentials. Such a value is refused before it is stored, returned or fetched.
function secretBearing(v, key, queueUrl) {
  if (typeof v !== 'string' || !v) return true;
  if (CTL_RE.test(v)) return true;   // fal-supplied ids/URLs must not contain ASCII controls or whitespace AT ALL (fail closed)
  if (key) {
    if (hasSecret(v, key)) return true;   // canonical form: mixed / double / malformed-neighbour escapes cannot hide the key
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (u.username || u.password) return true;
      if (key && hasSecret(u.href, key)) return true;   // the parsed form (what would really be fetched) is checked as well
      if (queueUrl) for (const n of u.searchParams.keys()) if (/key|token|secret|sig|auth|pass|credential/i.test(n)) return true;
    } catch (_) { return true; }
  }
  return false;
}
const safeQueueUrl = (u, base, key) => sameOrigin(u, base) && !secretBearing(u, key, true);
const hrefOf = (u) => new URL(u).href;   // only the CHECKED, parsed href is stored / returned / fetched
const isRedirect = (res) => !!res && (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400));
// the effective job: audio = job.audio ?? config video.fal.audio ?? true, decided ONCE so the cost line and the request always agree
function normalizeJob(job, cfg) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return job;
  const fc = (cfg && cfg.video && cfg.video.fal && typeof cfg.video.fal === 'object') ? cfg.video.fal : {};
  const audio = typeof job.audio === 'boolean' ? job.audio : (typeof fc.audio === 'boolean' ? fc.audio : true);
  return Object.assign({}, job, { audio });
}
const baseOf = (o) => String((o && o.baseUrl) || DEFAULT_BASE).replace(/\/+$/, '');

// ── the job (contract 2): checks that need no file access ───────────────────────────────────────────
// job = { shots:[ { keyframe, prompt, duration_s, refs:[ { kind:'character'|'prop'|'set', image, name? } ] } ], audio?, endKeyframe? }
function planJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return fail('no video job given — nothing was sent', 'input');
  const shots = job.shots;
  if (!Array.isArray(shots) || !shots.length) return fail('the job has no shots — nothing was sent', 'input');
  if (shots.length > MAX_SHOTS) return fail('too many shots: ' + shots.length + ' — Kling takes at most ' + MAX_SHOTS + ' shots per request. Nothing was sent.', 'shots');
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (!s || typeof s !== 'object') return fail('shot ' + (i + 1) + ' is not a shot — nothing was sent', 'input');
    if (typeof s.keyframe !== 'string' || !s.keyframe.trim()) return fail('shot ' + (i + 1) + ' has no keyframe — make a keyframe first, the video starts from it. Nothing was sent.', 'nokeyframe');
    if (typeof s.prompt !== 'string' || !s.prompt.trim()) return fail('shot ' + (i + 1) + ' has no prompt — write what happens in the shot first. Nothing was sent.', 'input');
    if (Array.from(s.prompt.trim()).length > MAX_PROMPT) return fail('shot ' + (i + 1) + "'s prompt is " + Array.from(s.prompt.trim()).length + ' characters — fal takes at most ' + MAX_PROMPT + '; shorten the shot text. Nothing was sent.', 'prompt');
    const d = s.duration_s;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 1 || d > MAX_TOTAL_S) {
      return fail('shot ' + (i + 1) + ' duration must be between 1 and ' + MAX_TOTAL_S + ' seconds (got ' + shortBody(String(d)) + '). Nothing was sent.', 'duration');
    }
  }
  let secs;
  if (shots.length === 1) secs = [Math.min(MAX_TOTAL_S, Math.max(MIN_TOTAL_S, Math.ceil(shots[0].duration_s)))];
  else secs = shots.map(s => Math.max(1, Math.ceil(s.duration_s)));
  const seconds = secs.reduce((x, y) => x + y, 0);
  if (seconds < MIN_TOTAL_S || seconds > MAX_TOTAL_S) {
    return fail('the shots add up to ' + seconds + ' s — Kling takes ' + MIN_TOTAL_S + ' to ' + MAX_TOTAL_S + ' s per request. Nothing was sent.', 'duration');
  }
  // reference images -> elements (character / prop); a set ref is already visible in the keyframe
  const elements = [], refImages = [];   // refImages = EVERY reference image of the job (set refs included): all are path-checked, only characters/props are uploaded
  for (let i = 0; i < shots.length; i++) {
    const refs = Array.isArray(shots[i].refs) ? shots[i].refs : [];
    for (const r of refs) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.image !== 'string' || !r.image.trim()) return fail('a ' + (typeof r.kind === 'string' ? r.kind : 'reference') + ' reference of shot ' + (i + 1) + ' has no image — nothing was sent', 'input');
      if (!refImages.includes(r.image)) refImages.push(r.image);
      if (r.kind !== 'character' && r.kind !== 'prop') continue;
      let el = elements.find(e => e.image === r.image);
      if (!el) { el = { image: r.image, name: typeof r.name === 'string' ? r.name.trim() : '', shot: i, shots: [] }; elements.push(el); }
      if (!el.shots.includes(i)) el.shots.push(i);
    }
  }
  if (elements.length > MAX_ELEMENTS) return fail('too many reference images: ' + elements.length + ' characters/props — at most ' + MAX_ELEMENTS + ' per request. Nothing was sent.', 'elements');
  return { ok: true, shots, secs, seconds, elements, refImages, audio: job.audio !== false };
}

// ── the cost line (contract 4) ─────────────────────────────────────────────────────────────────────
// cfg.video.fal.pricePerSecond = { audioOff, audioOn }. Absent = the defaults (fal model page 13.10.); present = it must hold a finite positive number for the rate this job needs.
function estimate(job, cfg) {
  const p = planJob(normalizeJob(job, cfg));
  if (!p.ok) return { ok: false, error: p.error, code: p.code };
  const fc = (cfg && cfg.video && cfg.video.fal && typeof cfg.video.fal === 'object') ? cfg.video.fal : {};
  const given = fc.pricePerSecond !== undefined && fc.pricePerSecond !== null;
  const table = given ? fc.pricePerSecond : DEFAULT_PRICE;
  const rate = (table && typeof table === 'object') ? Number(p.audio ? table.audioOn : table.audioOff) : NaN;
  const usd = rate * p.seconds;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(usd)) return { ok: false, error: 'no cost estimate — nothing was sent (check video.fal.pricePerSecond in the config file)', code: 'nocost' };
  const out = { ok: true, usd, seconds: p.seconds, shotCount: p.shots.length, rate, audio: p.audio, source: given ? 'config' : 'fal model page 13.10.' };
  out.line = costLine(out);
  return out;
}
function costLine(e) {
  if (!e || !Number.isFinite(e.usd) || !Number.isFinite(e.rate)) return '';
  return 'fal.ai · Kling 3 Pro · ' + e.seconds + ' s · audio ' + (e.audio ? 'on' : 'off') + ' · est. $' + e.usd.toFixed(2) + ' (fal model page 13.10.: $' + e.rate + '/s — your fal bill is the truth)'
    + (e.shotCount > 1 ? " — only shot 1's keyframe is used (fal takes one start image per request; the other shots steer through their prompts)" : '');
}

// Path rule only (no file access): every image of the job must resolve inside outputDir and be a .png/.jpg/.jpeg/.webp. -> '' | the refusal text. A job planJob
// already refuses is left to estimate()/buildRequest() to explain.
function checkPaths(job, o) {
  o = o || {};
  const p = planJob(job);
  if (!p.ok || !o.outputDir) return '';
  const outputDir = path.resolve(o.outputDir), base = o.cwd ? path.resolve(o.cwd) : path.dirname(outputDir);
  const all = [];
  p.shots.forEach(s => all.push(s.keyframe));
  p.refImages.forEach(x => all.push(x));
  if (typeof job.endKeyframe === 'string' && job.endKeyframe.trim()) all.push(job.endKeyframe);
  for (const given of all) {
    const abs = path.resolve(base, given), name = path.basename(abs);
    const rel = path.relative(outputDir, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return name + " is outside Phoenix's output folder — only images from output/ are uploaded. Nothing was sent.";
    if (!IMAGE_EXT[path.extname(abs).toLowerCase()]) return name + ' is not a .png/.jpg/.jpeg/.webp image. Nothing was sent.';
  }
  return '';
}

// ── request body (contract 2) ───────────────────────────────────────────────────────────────────────
// Reads the images (only .png/.jpg/.jpeg/.webp from inside outputDir, each <= 10 MB) and returns the fal input with data URIs. Nothing is sent here.
function buildRequest(job, o) {
  o = o || {};
  const p = planJob(job);
  if (!p.ok) return p;
  const outputDir = o.outputDir ? path.resolve(o.outputDir) : null;
  if (!outputDir) return fail('no output folder given — nothing was sent', 'input');
  const base = o.cwd ? path.resolve(o.cwd) : path.dirname(outputDir);
  let realOut = outputDir;
  try { realOut = fs.realpathSync(outputDir); } catch (_) { /* a missing output folder: every image is then "missing" below */ }
  const cache = new Map();
  const encode = (given, what) => {
    if (cache.has(given)) return { ok: true, uri: cache.get(given) };
    const abs = path.resolve(base, given);
    const name = path.basename(abs);
    const inside = (a, root) => { const rel = path.relative(root, a); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
    if (!inside(abs, outputDir)) return fail(name + ' is outside Phoenix\'s output folder — only images from output/ are uploaded. Nothing was sent.', 'path');
    const ext = path.extname(abs).toLowerCase();
    if (!IMAGE_EXT[ext]) return fail(name + ' is not a .png/.jpg/.jpeg/.webp image. Nothing was sent.', 'path');
    let st;
    try { st = fs.statSync(abs); } catch (_) { return fail(what + ' file missing: ' + name + '. Nothing was sent.', 'missing'); }
    if (!st.isFile()) return fail(what + ' file missing: ' + name + '. Nothing was sent.', 'missing');
    try { const real = fs.realpathSync(abs); if (!inside(real, realOut)) return fail(name + ' is outside Phoenix\'s output folder — only images from output/ are uploaded. Nothing was sent.', 'path'); } catch (_) { /* stat worked: read below decides */ }
    if (st.size > MAX_IMAGE_BYTES) return fail(name + ' is larger than 10 MB — fal upload limit in Phoenix. Nothing was sent.', 'size');
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { return fail('could not read ' + name + '. Nothing was sent.', 'input'); }
    if (buf.length > MAX_IMAGE_BYTES) return fail(name + ' is larger than 10 MB — fal upload limit in Phoenix. Nothing was sent.', 'size');
    const uri = 'data:' + IMAGE_EXT[ext] + ';base64,' + buf.toString('base64');
    cache.set(given, uri);
    return { ok: true, uri };
  };
  const first = encode(p.shots[0].keyframe, 'keyframe');
  if (!first.ok) return first;
  // the prompts: every character/prop element is announced as @Element<n> right next to its name, in the prompt of the first shot that has it
  const prompts = p.shots.map(s => s.prompt.trim());
  const elements = [];
  for (const el of p.elements) {
    const enc = encode(el.image, 'reference image');
    if (!enc.ok) return enc;
    elements.push({ frontal_image_url: enc.uri, reference_image_urls: [enc.uri] });
    const tag = '@Element' + elements.length;
    for (const si of el.shots) prompts[si] += el.name ? ' ' + el.name + ' (' + tag + ')' : ' ' + tag;   // every shot that uses a (reused) element names it
  }
  for (const ri of p.refImages) { const e = encode(ri, 'reference image'); if (!e.ok) return e; }   // a set ref is not uploaded but its file is checked like the others
  for (let i = 0; i < prompts.length; i++) {
    const n = Array.from(prompts[i]).length;
    if (n > MAX_PROMPT) return fail('shot ' + (i + 1) + "'s prompt is " + n + ' characters with the @Element tags — fal takes at most ' + MAX_PROMPT + '; shorten the shot text. Nothing was sent.', 'prompt');
  }
  for (let i = 1; i < p.shots.length; i++) {   // the other keyframes are checked too (a missing/oversized file is refused up front) but only shot 1's is sent
    const e = encode(p.shots[i].keyframe, 'keyframe'); if (!e.ok) return e;
  }
  const input = {};
  if (p.shots.length === 1) {
    input.prompt = prompts[0];
    input.duration = String(p.seconds);
  } else {
    input.multi_prompt = prompts.map((pr, i) => ({ prompt: pr, duration: String(p.secs[i]) }));
    input.shot_type = 'customize';
    input.duration = String(p.seconds);
  }
  input.start_image_url = first.uri;
  if (typeof job.endKeyframe === 'string' && job.endKeyframe.trim()) {
    const end = encode(job.endKeyframe, 'end keyframe');
    if (!end.ok) return end;
    input.end_image_url = end.uri;
  }
  if (elements.length) input.elements = elements;
  input.generate_audio = p.audio;
  return { ok: true, input, seconds: p.seconds, audio: p.audio, prompts, shotCount: p.shots.length, elementCount: elements.length };
}

// ── submit (never repeated: a second submit would be a second charge) ───────────────────────────────
async function submit(input, o) {
  o = o || {};
  const key = o.key;
  const fetchImpl = o.fetchImpl || ((typeof fetch === 'function') ? fetch : null);
  const base = baseOf(o);
  const model = String(o.model || DEFAULT_MODEL).replace(/^\/+/, '');
  const signal = o.signal;
  if (!fetchImpl) return fail('no fetch available in this Node version', 'env');
  if (!key || typeof key !== 'string') return fail('no fal.ai API key — add it in Settings → Connections', 'nokey');
  if (!input || typeof input !== 'object') return fail('no request given — nothing was sent', 'input');
  if (signal && signal.aborted) return fail('video cancelled', 'cancelled');   // aborted before anything was sent: nothing can have been charged
  const body = JSON.stringify(input);
  let createTimeoutMs = Number.isFinite(o.createTimeoutMs) ? o.createTimeoutMs : Math.ceil(Math.max(CREATE_TIMEOUT_MS, 60000 + 10000 * (body.length / 1048576)));
  if (Number.isFinite(o.timeoutMs) && o.timeoutMs > 0) createTimeoutMs = Math.min(createTimeoutMs, o.timeoutMs);   // the overall limit covers the submit too
  // the caller persists its "submission intent" HERE, right before the request leaves; a callback that answers false refuses the submission
  if (typeof o.beforeCreate === 'function') {
    let go = true;
    try { go = o.beforeCreate(); } catch (_) { go = false; }   // a callback that throws cannot have secured the intent: fail closed
    if (go === false) return fail('Phoenix could not secure this paid submission, nothing was sent', 'refused');
  }
  let created = null;
  try {
    const res = await fetchImpl(base + '/' + model, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + key },
      body,
      redirect: 'manual',
      signal: withTimeout(signal, createTimeoutMs),
    });
    const text = await res.text();
    // a 5xx on the submit may have queued (and will bill) a request before it failed - treated like a timeout, never a plain http error. A 4xx proves it was refused.
    if (!res.ok || isRedirect(res)) {
      if (res.status >= 500 || isRedirect(res)) return fail('fal HTTP ' + res.status + ': ' + shortBody(text, key) + ' — the request may have been created and charged anyway. Check your fal dashboard (Requests) before retrying.', 'create_timeout');
      return httpError(res.status, text, key);
    }
    try { created = JSON.parse(text); } catch (_) { created = null; }
  } catch (e) {
    if (signal && signal.aborted) return fail(CREATE_MAYBE_CHARGED, 'create_timeout');   // an abort AFTER the request went out may still have queued it
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return fail(CREATE_MAYBE_CHARGED, 'create_timeout');
    const code = e && ((e.cause && e.cause.code) || e.code);
    if (!NEVER_SENT.has(code)) return fail(CREATE_MAYBE_CHARGED, 'create_timeout');
    return fail('fal is unreachable: ' + shortBody(e && e.message, key), 'network');
  }
  const requestId = created && created.request_id;
  const idOk = typeof requestId === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(requestId) && !secretBearing(requestId, key, false);
  if (!requestId || typeof requestId !== 'string') return fail('fal answered without a request id — the request may have been created and charged anyway. Check your fal dashboard (Requests) before retrying.', 'create_timeout');
  // use the URLs fal sent, never rebuilt ones - and never to another host
  let statusUrl = created.status_url, responseUrl = created.response_url, cancelUrl = created.cancel_url;
  if (!idOk || ![statusUrl, responseUrl, cancelUrl].every(u => safeQueueUrl(u, base, key))) {
    // an unusable id/address is never stored, returned, logged or fetched
    return Object.assign(fail('fal answered with an address outside its queue host, or with a value that carries secret data — nothing was sent there and nothing was stored. The request may have been created and charged anyway: check your fal dashboard (Requests).', 'bad_url'), { maybeCharged: true });
  }
  statusUrl = hrefOf(statusUrl); responseUrl = hrefOf(responseUrl); cancelUrl = hrefOf(cancelUrl);
  if (typeof o.onCreated === 'function') { try { o.onCreated({ requestId, statusUrl, responseUrl, cancelUrl }); } catch (_) { /* a callback must never break the run */ } }
  return { ok: true, requestId, statusUrl, responseUrl, cancelUrl };
}

// ── status polling -> result -> download ────────────────────────────────────────────────────────────
async function waitAndFetch(task, o) {
  o = o || {};
  const key = o.key;
  const fetchImpl = o.fetchImpl || ((typeof fetch === 'function') ? fetch : null);
  const sleep = o.sleep || defaultSleep;
  const now = o.now || Date.now;
  const pollMs = Number.isFinite(o.pollMs) ? o.pollMs : 5000;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 900000;
  const requestTimeoutMs = Number.isFinite(o.requestTimeoutMs) ? o.requestTimeoutMs : REQUEST_TIMEOUT_MS;
  const dlStallMs = Number.isFinite(o.downloadStallMs) ? o.downloadStallMs : DOWNLOAD_STALL_MS;
  const maxDownload = Number.isFinite(o.maxDownloadBytes) && o.maxDownloadBytes > 0 ? o.maxDownloadBytes : MAX_DOWNLOAD_BYTES;
  const base = baseOf(o);
  const signal = o.signal;
  if (!fetchImpl) return fail('no fetch available in this Node version', 'env');
  if (!key || typeof key !== 'string') return fail('no fal.ai API key — add it in Settings → Connections', 'nokey');
  if (!task || !safeQueueUrl(task.statusUrl, base, key) || !safeQueueUrl(task.responseUrl, base, key)) return fail('the status address is outside fal\'s queue host — refused, the key was not sent there', 'bad_url');
  const auth = { Authorization: 'Key ' + key };
  const t0 = now();
  let status = null, transient = 0, odd = 0;
  // LC2i: an answer Phoenix can not read says nothing about the request - it may still be rendering (and billing). A few retries, then a failure that is NOT terminal (the record stays).
  const oddFail = (what) => Object.assign(fail('fal answered with something unreadable: ' + what + ' — the request may still run; Make video again on the same shot checks that job', 'http'), { keep: true });   // keep: the caller must not cancel it or drop its record
  for (;;) {
    if (signal && signal.aborted) return fail('video cancelled', 'cancelled');
    if (now() - t0 >= timeoutMs) return fail('fal video timed out after ' + Math.round(timeoutMs / 1000) + ' s', 'timeout');
    try {
      const res = await fetchImpl(hrefOf(task.statusUrl), { method: 'GET', headers: auth, redirect: 'manual', signal: withTimeout(signal, requestTimeoutMs) });
      if (isRedirect(res)) return fail('fal redirected the status request — refused, the key is never sent to another address', 'redirect');
      const text = await res.text();
      if (!res.ok) {
        if (res.status >= 500 && ++transient <= 3) { await sleep(pollMs); continue; }
        if (res.status === 404 || res.status === 410) return Object.assign(fail('fal no longer has this video request — Make video again to start a new one (that costs credit again)', 'task_gone'), { terminal: true });
        return httpError(res.status, text, key);
      }
      transient = 0;
      try { status = JSON.parse(text); } catch (_) { status = null; }
      if (!status || typeof status !== 'object' || Array.isArray(status)) {
        if (++odd <= 3) { await sleep(pollMs); continue; }
        return oddFail(shortBody(text, key));
      }
    } catch (e) {
      if (signal && signal.aborted) return fail('video cancelled', 'cancelled');
      if (++transient <= 3) { await sleep(pollMs); continue; }   // a timed-out poll counts as a network failure
      return fail('fal is unreachable: ' + shortBody(e && e.message, key), 'network');
    }
    const st = String(status.status || '');
    if (st === 'COMPLETED' || st === 'IN_QUEUE' || st === 'IN_PROGRESS') odd = 0;   // only a KNOWN status restarts the budget
    if (st === 'COMPLETED') { progress(o, { pct: 100, status: st, queuePosition: null }); break; }
    if (st === 'IN_QUEUE') progress(o, { pct: 0, status: st, queuePosition: Number.isFinite(Number(status.queue_position)) ? Number(status.queue_position) : null });
    else if (st === 'IN_PROGRESS') progress(o, { pct: 50, status: st, queuePosition: null });
    else if (!FAILED_STATES.includes(st.toUpperCase())) {   // LC2i: a value Phoenix does not know is not a verdict - retry, then a non-terminal failure
      if (++odd <= 3) { await sleep(pollMs); continue; }
      return oddFail(shortBody(JSON.stringify(status), key));
    } else {
      // fal's own conclusive failed/cancelled states -> terminal, with the scrubbed body
      return Object.assign(fail('fal reported a status Phoenix does not know: ' + shortBody(JSON.stringify(status), key), 'failed'), { terminal: true });
    }
    await sleep(pollMs);
  }

  // result
  let result = null;
  try {
    const res = await fetchImpl(hrefOf(task.responseUrl), { method: 'GET', headers: auth, redirect: 'manual', signal: withTimeout(signal, requestTimeoutMs) });
    if (isRedirect(res)) return Object.assign(fail('fal redirected the result request — refused, the key is never sent to another address', 'redirect'), { downloadable: true });
    const text = await res.text();
    if (!res.ok) {
      const e = httpError(res.status, text, key);
      // a client error on a COMPLETED request = fal itself ended it as failed (terminal); anything else may be retried (it is paid)
      if (res.status >= 400 && res.status < 500 && !['auth', 'credits', 'rate'].includes(e.code)) return Object.assign(e, { terminal: true });
      return Object.assign(e, { downloadable: true });
    }
    try { result = JSON.parse(text); } catch (_) { result = null; }
  } catch (e) {
    return Object.assign(fail('fal result could not be read: ' + shortBody(e && e.message, key), 'network'), { downloadable: true });
  }
  const url = result && result.video && result.video.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return Object.assign(fail('fal finished but returned no video', 'http'), { downloadable: true });
  if (secretBearing(url, key, false)) return Object.assign(fail('fal returned a clip address that carries secret data — refused, nothing was fetched', 'download'), { downloadable: true });
  const dl = await download((() => { try { return hrefOf(url); } catch (_) { return url; } })(), { fetchImpl, signal, maxDownload, dlStallMs, downloadTimeoutMs: o.downloadTimeoutMs, key });
  if (!dl.ok) return Object.assign(dl, { downloadable: true });
  return { ok: true, mp4: dl.buf, ms: now() - t0 };
}
function progress(o, p) { if (typeof o.onProgress === 'function') { try { o.onProgress(p); } catch (_) { /* a callback must never break the run */ } } }

// the clip link is a signed CDN URL: the key is NOT sent. Cap 1 GB; no bytes for 60 s = stalled; an overall limit scaled by the size.
async function download(url, o) {
  const key = o.key, fetchImpl = o.fetchImpl, signal = o.signal, maxDownload = o.maxDownload;
  const tooBig = () => fail('the fal clip is larger than the ' + Math.round(maxDownload / 1048576) + ' MB download limit - raise it (config video.fal.maxDownloadBytes) and press Make video again', 'download');
  const dac = new AbortController();
  const dlSignal = (signal && AbortSignal.any) ? AbortSignal.any([signal, dac.signal]) : dac.signal;
  let overallTimer = null, stallTimer = null, dlTimedOut = false;
  const clearDl = () => { clearTimeout(overallTimer); clearTimeout(stallTimer); };
  const trip = () => { dlTimedOut = true; try { dac.abort(); } catch (_) { /* gone */ } };
  const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(trip, o.dlStallMs); };
  try {
    overallTimer = setTimeout(trip, Number.isFinite(o.downloadTimeoutMs) ? o.downloadTimeoutMs : 120000);
    armStall();
    // redirect:'manual': a 3xx Location is validated like every fal-supplied address (controls/whitespace refused, secretBearing on the raw value AND the parsed href,
    // http(s) only) before it is followed; at most 3 hops
    let res, cur = url;
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(cur, { method: 'GET', redirect: 'manual', signal: dlSignal });
      if (!isRedirect(res)) break;
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      let next = null;
      try {
        if (!loc || hop >= 3 || CTL_RE.test(loc)) throw new Error('refused');
        next = new URL(loc, cur).href;
        if (!/^https?:/i.test(next) || secretBearing(loc, key, false) || secretBearing(next, key, false)) throw new Error('refused');
      } catch (_) { clearDl(); return fail('fal clip download was redirected to an address Phoenix refuses (or too many redirects) - nothing was followed', 'download'); }
      cur = next;
    }
    if (!res.ok) { clearDl(); return fail('fal clip download failed (HTTP ' + res.status + ')', 'download'); }
    const cl = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(cl) && cl > maxDownload) { clearDl(); try { await res.body.cancel(); } catch (_) { /* gone */ } return tooBig(); }
    if (Number.isFinite(cl) && !Number.isFinite(o.downloadTimeoutMs)) {
      clearTimeout(overallTimer); overallTimer = setTimeout(trip, Math.ceil(Math.max(120000, 10000 * (cl / 1048576))));
    }
    let buf;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader(); const parts = []; let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armStall();
        n += value.length;
        if (n > maxDownload) { clearDl(); try { await reader.cancel(); } catch (_) { /* gone */ } return tooBig(); }
        parts.push(Buffer.from(value));
      }
      buf = Buffer.concat(parts);
    } else {
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxDownload) { clearDl(); return tooBig(); }
    }
    clearDl();
    if (!buf.length) return fail('the fal clip came back empty', 'download');
    return { ok: true, buf };
  } catch (e) {
    clearDl();
    if (dlTimedOut) return fail('fal clip download timed out — stalled or too slow', 'download');
    return fail('fal clip download failed: ' + shortBody(e && e.message, key), 'download');
  }
}

// ── cancel ──────────────────────────────────────────────────────────────────────────────────────────
// PUT <cancel_url> -> 202 CANCELLATION_REQUESTED | 400 ALREADY_COMPLETED | 404 NOT_FOUND. Never throws.
async function cancel(task, o) {
  o = o || {};
  const key = o.key;
  const fetchImpl = o.fetchImpl || ((typeof fetch === 'function') ? fetch : null);
  const base = baseOf(o);
  if (!fetchImpl || !key) return { confirmed: false, error: 'cancel not possible: ' + (!key ? 'no fal.ai API key' : 'no fetch available') };
  if (!task || !safeQueueUrl(task.cancelUrl, base, key)) return { confirmed: false, error: 'the cancel address is outside fal\'s queue host — refused, the key was not sent there', code: 'bad_url' };
  try {
    const res = await fetchImpl(hrefOf(task.cancelUrl), { method: 'PUT', headers: { Authorization: 'Key ' + key }, redirect: 'manual', signal: withTimeout(undefined, Number.isFinite(o.requestTimeoutMs) ? o.requestTimeoutMs : REQUEST_TIMEOUT_MS) });
    let text = '';
    try { text = await res.text(); } catch (_) { /* no body */ }
    if (res.status === 202) return { confirmed: true };
    if (res.status === 400 && /ALREADY_COMPLETED/i.test(text)) return { alreadyCompleted: true };
    const he = isRedirect(res) ? fail('fal redirected the cancel request — refused', 'redirect') : httpError(res.status, text, key);   // the shared HTTP mapper; a 400 other than ALREADY_COMPLETED is NOT a confirmed cancel
    return { confirmed: false, error: he.error, code: he.code };
  } catch (e) {
    return { confirmed: false, error: 'fal is unreachable: ' + shortBody(e && e.message, key) };
  }
}

module.exports = { canonical, HIDDEN, scrubSecret, normalizeJob, secretBearing, planJob, checkPaths, estimate, costLine, buildRequest, submit, waitAndFetch, cancel, shortBody, DEFAULT_BASE, DEFAULT_MODEL, DEFAULT_PRICE, MAX_IMAGE_BYTES, CREATE_MAYBE_CHARGED };
