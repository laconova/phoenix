'use strict';
// providers/openai-compat.js — any OpenAI-compatible /chat/completions server: a local one
// (LM Studio, llama.cpp — no key) or a cloud one (OpenAI — Bearer key from providers/secrets).
// The key is used for exactly one thing, the Authorization header. It never reaches an error
// message, a thrown object or a log line (server text that echoes it is scrubbed).
const { ProviderError } = require('./errors');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function scrub(text, key) {
  let s = String(text == null ? '' : text);
  if (key) s = s.split(key).join('***');
  return s;
}

function baseUrl(u) { return String(u || '').replace(/\/+$/, ''); }

// Pull a readable message out of an error body ({error:'x'} / {error:{message:'x'}} / plain text).
function errText(raw) {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.error === 'string') return j.error;
    if (j && j.error && typeof j.error.message === 'string') return j.error.message;
    if (j && typeof j.message === 'string') return j.message;
  } catch (_) {}
  return String(raw || '');
}

function buildBody(seat, { system, messages, maxTokens, temperature, images }) {
  const raw = seat.raw || {};
  const msgs = [{ role: 'system', content: system }, ...messages];
  if (images && images.length) {   // v1.9 M3: the LAST user message carries the text first, then the images as data URLs
    const last = msgs[msgs.length - 1];
    msgs[msgs.length - 1] = { ...last, content: [{ type: 'text', text: last.content },
      ...images.map(i => ({ type: 'image_url', image_url: { url: 'data:' + i.mime + ';base64,' + i.data.toString('base64') } }))] };
  }
  if (seat.kind === 'cloud') {
    const body = { model: seat.model, messages: msgs, max_completion_tokens: maxTokens, stream: false, ...seat.options };
    if (typeof raw.temperature === 'number') body.temperature = raw.temperature;
    return body;
  }
  const body = { model: seat.model, messages: msgs };
  if (temperature !== undefined) body.temperature = temperature;
  Object.assign(body, {
    max_tokens: maxTokens, stream: false,
    thinking: { type: 'disabled' },
    // llama.cpp seats with thinking on return empty `length` turns (measured 12.09.)
    chat_template_kwargs: { enable_thinking: false },
    ...seat.options,
  });
  return body;
}

// One request, bounded by timeoutMs (abort signal AND a race, so a fetch that ignores the signal
// still ends). Throws ProviderError; `retryable` marks the local JIT-load / network cases.
async function attempt(url, headers, body, { fetchImpl, timeoutMs, key, ctx, hasImages }) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      try { ac.abort(); } catch (_) {}
      rej(new ProviderError('timeout', 'request timed out after ' + Math.round(timeoutMs / 1000) + 's', ctx));
    }, timeoutMs);
  });
  const run = (async () => {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    } catch (e) {
      const err = new ProviderError('unreachable', 'could not reach ' + url + ' (' + scrub((e && e.message) || e, key) + ')', ctx);
      err.retryable = true;
      throw err;
    }
    if (res.ok) {
      let j;
      try { j = await res.json(); }
      catch (e) { throw new ProviderError('unreachable', 'unreadable response from ' + url, ctx); }
      return j;
    }
    let rawText = '';
    try { rawText = await res.text(); } catch (_) {}
    let text = scrub(errText(rawText), key);
    if (hasImages) {   // a server that echoes the request must not echo our image bytes (also when split by \/ escapes or line wraps)
      text = text.replace(/base64,[^\s"']*/gi, '[data]').replace(/[A-Za-z0-9+\/=\\\r\n]{40,}/g, '[data]');
    }
    text = text.slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new ProviderError('config', 'API key rejected (HTTP ' + res.status + ')', ctx);
    if (hasImages && /image|vision|multimodal|mmproj|modalit/i.test(text)) {   // server text only — never the request body
      throw new ProviderError('no-vision', 'this model/server did not accept images (' + text + ") — a local server needs the model's vision projector (mmproj)", ctx);
    }
    const err = res.status >= 500
      ? new ProviderError('unreachable', 'HTTP ' + res.status + ': ' + text, ctx)
      : new ProviderError('rejected', 'HTTP ' + res.status + ': ' + text, ctx);
    err.noModels = /No models loaded/i.test(rawText);
    throw err;
  })();
  try { return await Promise.race([run, timeout]); }
  finally { clearTimeout(timer); run.catch(() => {}); }
}

async function complete(seat, { system, messages, timeoutMs = 300000, maxTokens, temperature, images, fetchImpl, getKey, sleepImpl } = {}) {
  const f = fetchImpl || fetch;
  const gk = getKey || require('./secrets').getKey;
  const ctx = { seat: seat.name, provider: 'openai-compat', model: seat.model };
  const cloud = seat.kind === 'cloud';
  const headers = { 'Content-Type': 'application/json' };
  let key = null;
  if (cloud) {
    key = gk(seat.apiKeyRef);
    if (!key) throw new ProviderError('config', 'no API key for "' + seat.apiKeyRef + '" — set the key in Settings', ctx);
    headers.Authorization = 'Bearer ' + key;
  }
  const url = baseUrl(seat.url) + '/chat/completions';
  const body = buildBody(seat, { system, messages, maxTokens, temperature, images });

  // Local only: LM Studio JIT-loads on the first request and can briefly answer "No models loaded"
  // (a race); one retry after a pause lets the load finish. Cloud never retries.
  const maxAttempts = cloud ? 1 : 2;
  let j;
  for (let n = 1; ; n++) {
    try { j = await attempt(url, headers, body, { fetchImpl: f, timeoutMs, key, ctx, hasImages: !!(images && images.length) }); break; }
    catch (e) {
      if (n < maxAttempts && (e.noModels || (e.retryable && e.kind === 'unreachable'))) { await (sleepImpl || sleep)(3000); continue; }
      throw e;
    }
  }
  const choice = j && Array.isArray(j.choices) ? j.choices[0] : null;
  const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
  if (!content) {
    throw new ProviderError('empty', 'model returned no text (finish_reason: ' + ((choice && choice.finish_reason) || 'unknown') +
      ') — if this is a local thinking model, switch thinking off', ctx);
  }
  return { text: content, imagesSent: images && images.length ? images.length : 0 };
}

// GET {url}/models → array of model ids. Accepts a resolved seat or endpoint ({ url, apiKeyRef, kind }).
async function listModels(target, { fetchImpl, getKey, timeoutMs = 10000 } = {}) {
  const f = fetchImpl || fetch;
  const gk = getKey || require('./secrets').getKey;
  const ctx = { seat: target.name, provider: 'openai-compat' };
  const headers = {};
  let key = null;
  if (target.apiKeyRef) {
    key = gk(target.apiKeyRef);
    if (!key) throw new ProviderError('config', 'no API key for "' + target.apiKeyRef + '" — set the key in Settings', ctx);
    headers.Authorization = 'Bearer ' + key;
  }
  const url = baseUrl(target.url) + '/models';
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, timeoutMs);
  try {
    let res;
    try { res = await f(url, { method: 'GET', headers, signal: ac.signal }); }
    catch (e) { throw new ProviderError('unreachable', 'could not reach ' + url + ' (' + scrub((e && e.message) || e, key) + ')', ctx); }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new ProviderError('config', 'API key rejected (HTTP ' + res.status + ')', ctx);
      throw new ProviderError(res.status >= 500 ? 'unreachable' : 'rejected', 'HTTP ' + res.status + ' from ' + url, ctx);
    }
    const j = await res.json();
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    return arr.map(m => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('unreachable', scrub((e && e.message) || e, key), ctx);
  } finally { clearTimeout(timer); }
}

module.exports = { complete, listModels };
