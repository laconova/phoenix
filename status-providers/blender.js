'use strict';
module.exports = {
  id: 'blender', label: 'Blender', kind: 'dot', order: 50, intervalMs: 30000, timeoutMs: 5000,
  async read(ctx) {
    const r = await ctx.probeBlender(ctx.cfg, 3000);
    // F2: 'busy' only means a command file is pending (maybe nobody ever answers it) - not proof that Blender is up, so no green dot.
    if (r === 'busy') return { state: 'unknown', text: 'blender', tip: 'Blender is busy or not answering yet.' };
    // the real probe answers 'reachable' or a reason string; an { ok, error } object is accepted too
    const ok = r === 'reachable' || (r && typeof r === 'object' && r.ok === true);
    const why = typeof r === 'string' ? r : (r && (r.error || r.message)) || 'no answer';
    return ok ? { state: 'ok', text: 'blender', tip: 'Blender answers over the Phoenix IPC addon.' } : { state: 'bad', text: 'blender', tip: String(why) };
  },
};
