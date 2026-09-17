'use strict';

const dbg = require('./debug-log');

// ─── Single-slot background job registry ─────────────────────────────────────
// At most one generation job runs at a time. The slot lives here so server.js
// and assistant.js can both reach it without circular requires.

let current = null;
let counter = 0;

// Outcomes are announced to the user by server.js, which subscribes to the debug log and turns
// every cat:'job' event into an SSE notice. That is why the dbg.event calls below carry the
// status/error text rather than just a marker — they are the message, not only a log line.

/**
 * start(meta, work) — attempt to launch a background job.
 *
 * meta: { kind?: string, label?: string }
 * work: async (id, signal) => string  — the heavy function; its return value becomes
 *       the job's status string on success. The second arg is an AbortSignal that fires
 *       when cancel(id) is called, so a long-running job (e.g. downloader.acquire) can
 *       kill its child process and stop. Existing callers that ignore it are unaffected.
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
  const ac = new AbortController();
  current = {
    id,
    kind:      meta.kind  || 'gen',
    label:     meta.label || 'job',
    startedAt: Date.now(),
    ac,
  };

  dbg.event('job', { phase: 'start', id, label: current.label });

  // Run detached — intentionally NOT awaited.
  const label0 = current.label;

  Promise.resolve()
    .then(() => work(id, ac.signal))
    .then(status => {
      dbg.event('job', { phase: 'done', id, label: label0, status: typeof status === 'string' ? status : '' });
    })
    .catch(err => {
      dbg.event('job', { phase: 'error', id, label: label0, error: String((err && err.message) || err) });
    })
    .finally(() => {
      current = null;
    });

  return { started: true, id };
}

/**
 * cancel(id) — signal the running job to abort (there is at most one).
 *   - id omitted → cancels whatever is running.
 *   - id given but not the running job → { ok:false } (stale click; do not cancel someone else).
 * Aborting only SIGNALS; the job's own work fn is responsible for stopping (downloader.acquire
 * kills its child on the signal and marks the run cancelled). The slot clears when work settles.
 */
function cancel(id) {
  if (current === null) return { ok: false, reason: 'no job is running' };
  if (id != null && Number(id) !== current.id) {
    return { ok: false, reason: 'job #' + id + ' is not the one running (#' + current.id + ')' };
  }
  try { current.ac.abort(); } catch (_) { /* already aborted */ }
  return { ok: true, id: current.id };
}

function isRunning() { return current !== null; }
function info()      { return current ? { id: current.id, kind: current.kind, label: current.label, startedAt: current.startedAt } : null; }

module.exports = { start, cancel, isRunning, info };
