'use strict';

// Unit tests for pipeline.js advance() gate logic.
// Runners are mocked — no phoenix.js, no Blender, no network calls.
// Run: node pipeline.test.js
// Exits 0 if all pass, 1 if any fail.

const { STAGES, advance } = require('./pipeline');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log('PASS: ' + label);
    passed++;
  } else {
    console.log('FAIL: ' + label);
    failed++;
  }
}

// Build a fresh set of mock runners.
// Each runner records call count and returns { ok: true, stage: <name> }.
function makeMocks() {
  const calls = { prompt: 0, image: 0, mesh: 0, 'import': 0 };
  const runners = {};
  for (const s of STAGES) {
    runners[s] = async (_ctx) => {
      calls[s]++;
      return { ok: true, stage: s };
    };
  }
  return { runners, calls };
}

(async () => {
  // ── Test (a): all gates true, start at 'prompt' ──────────────────────────
  // Expected: stopped immediately at 'prompt'; no runner called.
  {
    const { runners, calls } = makeMocks();
    const cfg = { gates: { prompt: true, image: true, mesh: true } };
    const ctx = { stage: 'prompt', desc: 'a wooden crate' };

    const result = await advance(ctx, cfg, runners);

    assert(result.stopped === true,      '(a) result.stopped is true');
    assert(result.awaiting === 'prompt', '(a) result.awaiting === "prompt"');
    assert(
      calls.prompt === 0 && calls.image === 0 && calls.mesh === 0 && calls['import'] === 0,
      '(a) no runner called'
    );
  }

  // ── Test (b): gates.prompt=false, rest true, start at 'prompt' ───────────
  // Expected: image runner called once; stopped at 'image'.
  {
    const { runners, calls } = makeMocks();
    const cfg = { gates: { prompt: false, image: true, mesh: true } };
    const ctx = { stage: 'prompt', desc: 'a wooden crate' };

    const result = await advance(ctx, cfg, runners);

    assert(result.stopped === true,     '(b) result.stopped is true');
    assert(result.awaiting === 'image', '(b) result.awaiting === "image"');
    assert(calls.image === 1,           '(b) image runner called exactly once');
    assert(
      calls.mesh === 0 && calls['import'] === 0,
      '(b) mesh and import runners not called'
    );
  }

  // ── Test (c): all gates false, start at 'prompt' ─────────────────────────
  // Expected: image, mesh, import each called once; done.
  {
    const { runners, calls } = makeMocks();
    const cfg = { gates: { prompt: false, image: false, mesh: false } };
    const ctx = { stage: 'prompt', desc: 'a wooden crate' };

    const result = await advance(ctx, cfg, runners);

    assert(result.done === true,    '(c) result.done is true');
    assert(calls.image === 1,       '(c) image runner called once');
    assert(calls.mesh === 1,        '(c) mesh runner called once');
    assert(calls['import'] === 1,   '(c) import runner called once');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n' + total + ' assertions: ' + passed + ' PASS, ' + failed + ' FAIL');
  if (failed > 0) process.exit(1);
})();
