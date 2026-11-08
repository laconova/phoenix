'use strict';
module.exports = {
  id: 'remote', label: 'Remote access', kind: 'dot', order: 80, intervalMs: 5000,
  async read(ctx) {
    const r = (ctx.remoteState && ctx.remoteState()) || {};
    const st = r.state || (r.enabled === true ? 'on' : 'off');
    if (st === 'on') return { state: 'ok', text: 'remote on', tip: 'Remote access is on' + (r.origin ? ' at ' + r.origin : '') + '.' };
    if (st === 'enabling') return { state: 'warn', text: 'remote starting', tip: 'Remote access is switching on.' };
    if (st === 'error') return { state: 'bad', text: 'remote error', tip: String(r.error || 'Remote access reported an error.') };
    return { state: 'off', text: 'remote off', tip: 'Remote access is off (Settings > Connections).' };
  },
};
