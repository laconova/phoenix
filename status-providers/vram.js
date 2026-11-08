'use strict';
const { baseOf, systemStats } = require('./_comfy');
const GB = 1024 * 1024 * 1024;
const tenth = (n) => Math.round(n * 10) / 10;
module.exports = {
  id: 'vram', label: 'VRAM', kind: 'meter', order: 40, intervalMs: 10000,
  async read(ctx) {
    const base = baseOf(ctx.cfg);
    if (!base) return { state: 'off', text: '' };
    const r = await systemStats(ctx, base);
    if (!r.ok) return { state: 'off', text: '', tip: 'VRAM is read from ComfyUI, which does not answer.' };
    const dev = ((r.stats && r.stats.devices) || []).find((d) => d && typeof d.vram_total === 'number' && d.vram_total > 0);
    if (!dev || typeof dev.vram_free !== 'number') return { state: 'off', text: '', tip: 'ComfyUI reports no GPU memory.' };
    const used = tenth((dev.vram_total - dev.vram_free) / GB), max = tenth(dev.vram_total / GB);
    return { state: used / max >= 0.9 ? 'warn' : 'ok', text: used.toFixed(1) + '/' + max + ' GB', value: used, max, unit: 'GB', tip: (dev.name || 'GPU') + ' - ' + used.toFixed(1) + ' of ' + max + ' GB in use' };
  },
};
