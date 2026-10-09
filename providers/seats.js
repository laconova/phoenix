'use strict';
// providers/seats.js — resolve a named seat (orchestrator, troubleshooter, ...) from the config
// into { provider, model, endpoint, ... }. The ONE place that infers a provider from a model name
// (the v1.8.1 rule: "claude*" → CLI, anything else → local OpenAI-compatible server), so every
// config written before providers existed resolves exactly as it did.
const { ProviderError } = require('./errors');

const SEAT_NAMES = ['orchestrator', 'troubleshooter', 'metaprompter', 'vision', 'utility'];
const PROVIDERS  = ['claude-cli', 'openai-compat', 'codex-cli'];   // codex-cli is only ever explicit — never inferred
const DEFAULT_LOCAL_URL = 'http://localhost:1234/v1';

const DEFAULT_MODEL = {
  orchestrator:   'claude-sonnet-4-6',
  troubleshooter: 'claude-sonnet-4-6',
  metaprompter:   'claude-haiku-4-5-20251001',
  utility:        'claude-sonnet-4-6',   // category inference only
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str   = v => (typeof v === 'string' && v.trim()) ? v.trim() : '';

function seatModel(name, seats, env) {
  const own = isObj(seats[name]) ? str(seats[name].model) : '';
  if (name === 'metaprompter') return str(env.GEMMA_MODEL) || own || DEFAULT_MODEL.metaprompter;
  if (name === 'vision') {
    // Exactly the old visionModel(): own seat, else the orchestrator's configured model, else Opus.
    return own || (isObj(seats.orchestrator) ? str(seats.orchestrator.model) : '') || 'claude-opus-4-8';
  }
  return own || DEFAULT_MODEL[name];
}

// Resolve an endpoint NAME to { url, apiKeyRef, kind }. A string entry is a bare URL (no key).
function resolveEndpoint(name, cfg, env = process.env) {
  const eps = (cfg && isObj(cfg.endpoints)) ? cfg.endpoints : {};
  const entry = eps[name];
  let url = '', apiKeyRef = null;
  if (typeof entry === 'string') url = entry.trim();
  else if (isObj(entry)) { url = str(entry.url); apiKeyRef = str(entry.apiKeyRef) || null; }
  if (name === 'local') {
    if (str(env.LOCAL_API)) url = str(env.LOCAL_API);
    else if (!url) url = DEFAULT_LOCAL_URL;
  }
  if (!url) throw new ProviderError('config', 'endpoint "' + name + '" is not configured');
  if (!/^https?:\/\//i.test(url)) throw new ProviderError('config', 'endpoint "' + name + '" must be an http(s) URL');
  return { endpointName: name, url, apiKeyRef, kind: apiKeyRef ? 'cloud' : 'local' };
}

function resolveSeat(name, cfg, env = process.env) {
  if (!SEAT_NAMES.includes(name)) throw new ProviderError('config', 'unknown seat "' + name + '"');
  const seats = (cfg && isObj(cfg.seats)) ? cfg.seats : {};
  const raw = isObj(seats[name]) ? seats[name] : {};
  const fail = (msg, extra) => new ProviderError('config', 'seat "' + name + '": ' + msg, { seat: name, ...extra });

  let provider = raw.provider;
  // A codex-cli seat may have an empty model (= Codex's own default), so no Claude default is filled in.
  const model = provider === 'codex-cli' ? str(raw.model) : seatModel(name, seats, env || {});
  if (provider === undefined || provider === null || provider === '') {
    provider = /^claude/i.test(model) ? 'claude-cli' : 'openai-compat';   // the inference rule — nowhere else
  } else if (!PROVIDERS.includes(provider)) {
    throw fail('unknown provider "' + String(provider).slice(0, 40) + '" (use ' + PROVIDERS.join(' | ') + ')');
  }

  const endpointName = str(raw.endpoint) || 'local';
  let ep = { url: '', apiKeyRef: null, kind: 'local' };
  if (provider === 'openai-compat') {
    try { ep = resolveEndpoint(endpointName, cfg, env || {}); }
    catch (e) { throw fail(e.message, { provider, model }); }
  }
  return {
    name, provider, model, endpointName,
    url: ep.url, apiKeyRef: ep.apiKeyRef, kind: ep.kind,
    options: isObj(raw.options) ? raw.options : {},
    raw,
  };
}

module.exports = { resolveSeat, resolveEndpoint, SEAT_NAMES, PROVIDERS };
