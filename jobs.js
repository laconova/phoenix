'use strict';

const dbg = require('./debug-log');

// ─── Single-slot background job registry ─────────────────────────────────────
// At most one generation job runs at a time. The slot lives here so server.js
// and assistant.js can both reach it without circular requires.

let current = null;
let counter = 0;

/**
 * start(meta, work) — attempt to launch a background job.
 *
 * meta: { kind?: string, label?: string }
 * work: async (id) => string  — the heavy function; its return value becomes
 *       the job's status string on success.
 *
 * Returns:
 *   { started: true,  id }            — job accepted, running detached.
 *   { started: false, reason: string } — slot occupied, caller should relay reason.
 */
function start(meta, work) {
  if (current !== null) {
    return {
      started: false,
      reason: 'a generation job is already running (#' + current.id + ': ' + current.label + '). Only one runs at a time — wait for it to finish or cancel it.',
    };
  }

  const id = ++counter;
  current = {
    id,
    kind:      meta.kind  || 'gen',
    label:     meta.label || 'job',
    startedAt: Date.now(),
  };

  dbg.event('job', { phase: 'start', id, label: current.label });

  // Run detached — intentionally NOT awaited.
  Promise.resolve()
    .then(() => work(id))
    .then(status => {
      dbg.event('job', {
        phase:  'done',
        id,
        label:  current ? current.label : '',
        status: typeof status === 'string' ? status : '',
      });
    })
    .catch(err => {
      dbg.event('job', {
        phase: 'error',
        id,
        label: current ? current.label : '',
        error: String((err && err.message) || err),
      });
    })
    .finally(() => {
      current = null;
    });

  return { started: true, id };
}

function isRunning() { return current !== null; }
function info()      { return current; }

module.exports = { start, isRunning, info };
