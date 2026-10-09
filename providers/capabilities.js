'use strict';
// providers/capabilities.js — the tool-protocol probe + its store (v1.9 M2).
// Phoenix's orchestrator drives Blender through text "TOOL:/INPUT:" blocks. Not every model can:
// Qwen-Coder-14B managed 0/3 tool turns, Gemma 26B-A4B 3/3 (bench 10.09.). So a model is TESTED once
// and the result decides whether it may be the orchestrator — instead of failing mid-job.
const fs = require('fs');
const path = require('path');
const { resolveSeat } = require('./seats');
const { makeCard, checkProof, colorWordList } = require('./vision-proof');

const PROBE_Q = 'What objects are in my Blender scene right now?';
const TRIALS = 3;
const VISION_TRIALS = 2;
// The exact sentence runTurn appends after a tool result (assistant.js passes its own constant in deps.nudge).
const NUDGE = "If this answers the user's question, reply in plain text now. Only emit another TOOL block if a follow-up action is strictly required.";

// ── Store ───────────────────────────────────────────────────────────────────
// Read on every call (a test can point PHOENIX_CAPS_FILE at a temp file); corrupt file = empty store.
function file() { return process.env.PHOENIX_CAPS_FILE || path.join(__dirname, '..', 'capabilities.json'); }
function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (_) { return {}; }
}
function writeAll(all) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, f);
}
// "<provider>|<endpoint or ->|<model or ->" — endpoint only matters for openai-compat.
function capKey(seat) {
  return [seat.provider, seat.provider === 'openai-compat' ? (seat.endpointName || '-') : '-', seat.model || '-'].join('|');
}
// Sweep 2 G3: results are keyed by endpoint NAME, so the entry also remembers the resolved endpoint URL it was measured against; an entry
// measured against another server (the same name re-pointed) is treated as absent. Entries without a url (written before this) stay valid.
// Normalised with URL: scheme + host are case-insensitive (lowercased by URL), the PATH and query are not (/API/v1 and /api/v1 are different servers);
// a trailing slash is dropped consistently.
function normUrl(u) {
  const t = String(u).trim();
  try { const x = new URL(t); return x.protocol + '//' + x.host + x.pathname.replace(/\/+$/, '') + x.search; } catch (_) { return t.replace(/\/+$/, ''); }
}
function urlOf(seat) { return seat.provider === 'openai-compat' && seat.url ? normUrl(seat.url) : ''; }
const sameServer = (e, seat) => !e || !e.url || !urlOf(seat) || e.url === urlOf(seat);
function getCaps(seat) {
  const e = readAll()[capKey(seat)];
  return (e && typeof e === 'object' && sameServer(e, seat) && (e.tools === 'pass' || e.tools === 'fail')) ? e : null;
}
// A re-probe replaces the entry (bench dropped) but keeps the M3 vision fields of the same key — the vision test is
// a different question from the tool test.
function setCaps(seat, entry) {
  const all = readAll(), k = capKey(seat), old = all[k];
  const keep = {};
  if (old && typeof old === 'object' && sameServer(old, seat)) for (const f of ['vision', 'visionTrials', 'visionProbedAt']) if (old[f] !== undefined) keep[f] = old[f];
  all[k] = { ...entry, ...keep, ...(urlOf(seat) ? { url: urlOf(seat) } : {}) };
  writeAll(all);
}

// M3 vision test result, MERGED into the entry (creating it when absent). getCaps still wants a tools verdict,
// so an entry that only has vision* fields is not a tool-test result.
function setVision(seat, { vision, visionTrials, visionProbedAt }) {
  const all = readAll(), k = capKey(seat);
  const e = (all[k] && typeof all[k] === 'object' && sameServer(all[k], seat)) ? all[k] : {};   // another server: start a fresh entry, no stale tool verdict
  all[k] = { ...e, vision, visionTrials, visionProbedAt, ...(urlOf(seat) ? { url: urlOf(seat) } : {}) };
  writeAll(all);
}
function getVision(seat) {
  const e = readAll()[capKey(seat)];
  return (e && typeof e === 'object' && sameServer(e, seat) && (e.vision === 'pass' || e.vision === 'fail'))
    ? { vision: e.vision, visionProbedAt: e.visionProbedAt, visionTrials: e.visionTrials } : null;
}
function markForced(seat) {
  const all = readAll(), k = capKey(seat);
  if (all[k]) { all[k].forced = true; writeAll(all); }
}

// M2.1 competence benchmark result, stored on the SAME entry (a re-probe replaces the entry, so a stale
// benchmark never outlives the format test it followed). bench = { score, of, tasks, ranAt } | { unavailable, ranAt }.
// Returns false when the seat has no probe entry yet (the benchmark only runs after a passed probe).
function setBench(seat, bench) {
  const all = readAll(), k = capKey(seat);
  if (!all[k] || typeof all[k] !== 'object' || !sameServer(all[k], seat)) return false;
  all[k].bench = bench;
  writeAll(all);
  return true;
}

// ── Probe ───────────────────────────────────────────────────────────────────
function errWhy(e) {
  return ((e && e.kind) || 'error') + ': ' + String((e && e.message) || e).slice(0, 120);
}

// One trial → { ok, why? }; throws only for provider errors (the caller aborts the probe on those).
async function trial(seatName, cfg2, d) {
  const toolNames = Object.keys(d.TOOLS || {});
  const system = d.buildSystemPrompt();
  const r1 = await d.complete(seatName, cfg2, { system, messages: [{ role: 'user', content: PROBE_Q }], purpose: 'probe', timeoutMs: 120000 });
  const raw = r1.text;
  const p1 = d.parseToolCallStrict(raw);
  if (!p1 || !p1.found) return { ok: false, why: 'no TOOL block' };
  if (!toolNames.includes(p1.name)) return { ok: false, why: 'unknown tool ' + String(p1.name).slice(0, 40) };
  if (!p1.ok) return { ok: false, why: 'bad INPUT JSON' };
  const r2 = await d.complete(seatName, cfg2, {
    system,
    messages: [
      { role: 'user', content: PROBE_Q },
      { role: 'assistant', content: raw },
      { role: 'user', content: 'TOOL_RESULT [' + p1.name + "]:\nOBJECTS:['Camera', 'Light', 'Cube']\n\n" + (d.nudge || NUDGE) },
    ],
    purpose: 'probe', timeoutMs: 120000,
  });
  if (!r2.text || !r2.text.trim()) return { ok: false, why: 'empty reply' };
  const p2 = d.parseToolCallStrict(r2.text);
  if (p2 && p2.found) return { ok: false, why: 'still emitting TOOL after result' };
  return { ok: true };
}

// probeTools(seatName, candidate, cfg, deps) → { tools:'pass'|'fail', trials, probedAt }, also stored.
// candidate = { provider, model, endpoint } (not yet saved). deps (tests): complete, buildSystemPrompt,
// TOOLS, parseToolCallStrict, nudge. pass = 3/3; one provider error aborts as fail (no retries).
async function probeTools(seatName, candidate, cfg, deps = {}) {
  const d = { ...deps };
  if (!d.complete) d.complete = require('./index').complete;
  const cur = (cfg && cfg.seats && cfg.seats[seatName] && typeof cfg.seats[seatName] === 'object') ? cfg.seats[seatName] : {};
  const cand = {};
  for (const k of ['provider', 'model', 'endpoint']) if (candidate && typeof candidate[k] === 'string') cand[k] = candidate[k];
  const cfg2 = { ...(cfg || {}), seats: { ...((cfg && cfg.seats) || {}), [seatName]: { ...cur, ...cand } } };
  const seat = resolveSeat(seatName, cfg2, {});

  const trials = [];
  for (let i = 0; i < TRIALS; i++) {
    try { trials.push(await trial(seatName, cfg2, d)); }
    catch (e) { trials.push({ ok: false, why: errWhy(e) }); break; }   // provider error: stop, the user sees why
  }
  const tools = trials.length === TRIALS && trials.every(t => t.ok) ? 'pass' : 'fail';
  const probedAt = new Date().toISOString();
  setCaps(seat, { tools, probedAt, trials });
  return { tools, trials, probedAt };
}

// ── Vision test (v1.9 M3) ───────────────────────────────────────────────────
const visionProbeQ = (rng) => 'Name the three vertical colour stripes in this image from left to right. Answer with exactly one line: ' +
  'COLORS: <left>, <middle>, <right> — using only: ' + colorWordList(rng) + '.';   // word list shuffled per trial

// probeVision(seatName, candidate, cfg, deps) → { vision:'pass'|'fail'|'n/a', trials, probedAt, why? }; pass/fail is stored.
// Claude seats read images through the CLI (their own proof) → 'n/a', nothing stored.
// openai-compat and codex-cli: 2 trials, each a fresh stripe card; pass = 2/2; a provider error aborts as fail (no retries). deps (tests): complete, rng.
async function probeVision(seatName, candidate, cfg, deps = {}) {
  const d = { ...deps };
  if (!d.complete) d.complete = require('./index').complete;
  const cur = (cfg && cfg.seats && cfg.seats[seatName] && typeof cfg.seats[seatName] === 'object') ? cfg.seats[seatName] : {};
  const cand = {};
  for (const k of ['provider', 'model', 'endpoint']) if (candidate && typeof candidate[k] === 'string') cand[k] = candidate[k];
  const cfg2 = { ...(cfg || {}), seats: { ...((cfg && cfg.seats) || {}), [seatName]: { ...cur, ...cand } } };
  const seat = resolveSeat(seatName, cfg2, {});
  if (seat.provider === 'claude-cli') return { vision: 'n/a' };

  const probedAt = new Date().toISOString();
  const trials = [];
  {
    for (let i = 0; i < VISION_TRIALS; i++) {
      const card = makeCard(d.rng);
      try {
        const r = await d.complete(seatName, cfg2, {
          system: 'You read test cards.', messages: [{ role: 'user', content: visionProbeQ(d.rng) }],
          images: [{ mime: 'image/png', data: card.png }], purpose: 'vision', timeoutMs: 120000,
        });
        const p = checkProof(r.text, card.colors);
        if (r.imagesSent === 1 && p.ok) trials.push({ ok: true });
        else trials.push({ ok: false, why: r.imagesSent === 1 ? p.detail : 'the image was not sent to the model' });
      } catch (e) { trials.push({ ok: false, why: errWhy(e) }); break; }   // provider error: stop, the user sees why
    }
  }
  const vision = trials.length === VISION_TRIALS && trials.every(t => t.ok) ? 'pass' : 'fail';
  setVision(seat, { vision, visionTrials: trials, visionProbedAt: probedAt });
  const out = { vision, trials, probedAt };
  if (vision === 'fail') out.why = (trials.find(t => !t.ok) || {}).why || 'failed';
  return out;
}

module.exports = { normUrl, PROBE_Q, NUDGE, capKey, getCaps, setCaps, markForced, setBench, probeTools, setVision, getVision, probeVision };
