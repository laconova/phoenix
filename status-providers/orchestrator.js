'use strict';
module.exports = {
  id: 'orchestrator', label: 'Orchestrator', kind: 'text', order: 10, intervalMs: 5000,
  async read(ctx) {
    const s = (ctx.cfg && ctx.cfg.seats && ctx.cfg.seats.orchestrator) || {};
    if (!s.model) return { state: 'off', text: 'orchestrator not set', tip: 'No orchestrator model is configured (Settings > Brains).' };
    return { state: 'ok', text: 'orchestrator ' + s.model, tip: (s.provider ? s.provider + ' · ' : '') + s.model };
  },
};
