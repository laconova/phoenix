'use strict';
const { baseOf, portOf, systemStats } = require('./_comfy');
module.exports = {
  id: 'comfyui', label: 'ComfyUI', kind: 'dot', order: 30, intervalMs: 10000,
  async read(ctx) {
    const base = baseOf(ctx.cfg);
    if (!base) return { state: 'off', text: '', tip: 'No ComfyUI endpoint is configured (Settings > Connections).' };
    const text = 'comfyui :' + portOf(base);
    const r = await systemStats(ctx, base);
    return r.ok ? { state: 'ok', text, tip: 'ComfyUI answers at ' + base }
      : { state: 'bad', text, tip: 'ComfyUI does not answer at ' + base + ' - ' + r.error };
  },
};
