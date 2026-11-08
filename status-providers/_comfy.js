'use strict';
// Shared helper of the comfyui + vram providers (a "_" file is not a provider): ONE GET <comfyui>/system_stats per ctx.fetch and base URL
// inside a few seconds, so the dot and the meter never ask ComfyUI twice for the same answer. Read only, 4 s timeout.
const TTL_MS = 3000;
const cache = new WeakMap();   // ctx.fetch -> Map(base -> { at, promise })

function baseOf(cfg) {
  const e = cfg && cfg.endpoints && cfg.endpoints.comfyui;
  return typeof e === 'string' && e.trim() ? e.trim().replace(/\/+$/, '') : '';
}
function portOf(base) {
  try { const u = new URL(base); return u.port || (u.protocol === 'https:' ? '443' : '80'); } catch (_) { return ''; }
}
// -> Promise<{ ok: true, stats } | { ok: false, error }>  (never rejects)
function systemStats(ctx, base) {
  let byBase = cache.get(ctx.fetch);
  if (!byBase) { byBase = new Map(); cache.set(ctx.fetch, byBase); }
  const hit = byBase.get(base);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = Promise.resolve().then(() => ctx.fetch(base + '/system_stats', { signal: AbortSignal.timeout(4000) })).then(async (r) => {
    if (!r || !r.ok) return { ok: false, error: 'ComfyUI answered HTTP ' + (r && r.status) };
    return { ok: true, stats: await r.json() };
  }).catch((e) => ({ ok: false, error: String((e && e.message) || e).replace(/\s+/g, ' ').trim() }));
  byBase.set(base, { at: Date.now(), promise });
  return promise;
}
module.exports = { baseOf, portOf, systemStats };
