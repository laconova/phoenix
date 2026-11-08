'use strict';
// The same wording the header indicator used before the status bar: the label carries the DIAGNOSIS, not just a colour.
const shortVer = (v) => String(v || '').split('-')[0] || '?';
const MAP = {
  live:      (s) => ({ state: 'ok',   text: 'Unreal ' + shortVer(s.engineVersion) + (s.projectName ? ' · ' + s.projectName : ''), tip: 'Bridge is live - ' + (s.projectFile || 'project path unknown') }),
  noproject: (s) => ({ state: 'warn', text: 'Unreal · no project', tip: s.message || '' }),
  silent:    (s) => ({ state: 'warn', text: 'Unreal silent', tip: s.message || '' }),
  absent:    () => ({ state: 'off',   text: 'Unreal off', tip: 'No Unreal Editor is running. Nothing is wrong - start one when you need it.' }),
  unknown:   (s) => ({ state: 'unknown', text: 'Unreal ?', tip: 'Could not determine the bridge state. ' + (s.message || '') }),
};
module.exports = {
  id: 'unreal', label: 'Unreal', kind: 'dot', order: 60, intervalMs: 20000, timeoutMs: 8000,
  async read(ctx) {
    const s = (await ctx.unrealState()) || {};
    // no Unreal on this machine => nothing is drawn (a permanent dot for something never installed is noise)
    if (s.state === 'noengine') return { state: 'off', text: '' };
    return (MAP[s.state] || MAP.unknown)(s);
  },
};
