'use strict';
module.exports = {
  id: 'jobs', label: 'Jobs', kind: 'text', order: 70, intervalMs: 3000,
  async read(ctx) {
    const j = ctx.jobs.info();
    const previews = require('../brush-previews').status();
    if (previews.running) return { state: 'ok', text: 'jobs ' + (j ? '1 running · ' : '') + 'previews ' + previews.done + ' / ' + previews.total, tip: 'Building brush previews' };
    if (!j) return { state: 'off', text: 'jobs idle', tip: 'No background job is running.' };
    return { state: 'ok', text: 'jobs 1 running · ' + (j.label || j.kind || 'job'), tip: (j.kind || 'job') + ' - running ' + Math.max(0, Math.round((Date.now() - (j.startedAt || Date.now())) / 1000)) + ' s' };
  },
};
