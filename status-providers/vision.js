'use strict';
module.exports = {
  id: 'vision', label: 'Vision', kind: 'text', order: 20, intervalMs: 5000,
  async read(ctx) {
    const s = (ctx.cfg && ctx.cfg.seats && ctx.cfg.seats.vision) || {};
    if (!s.model) return { state: 'off', text: '', tip: 'No vision seat is configured.' };
    return { state: 'ok', text: 'vision ' + s.model, tip: (s.provider ? s.provider + ' · ' : '') + s.model };
  },
};
