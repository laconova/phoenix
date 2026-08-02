// Release completeness gate — run INSIDE a clean checkout of what will actually ship:
//
//   node scripts/check-refs.js
//
// It answers one question: does every file the code reaches for exist in THIS tree?
// That is the automatable half of "did we forget to ship a script". It matters because it
// cannot be answered in the dev tree, where everything is present anyway — which is exactly
// how v1.5.0 shipped WITHOUT manage_palette.js, leaving list_materials / delete_material
// dead with ENOENT for every user. Found again on 2026-07-23, by this check.
//
// Three reference kinds are followed:
//   1. local require('./x')             — a missing module is a hard crash on load
//   2. path.join(__dirname, 'x.js')     — spawned child processes / files read at runtime;
//                                         invisible to require analysis, and how the above slipped
//   3. 'scripts/....py'                 — helper scripts referenced from strings
//
// Exit code 1 on any unexplained miss, so it can gate a release.

const fs = require('fs');
const path = require('path');

// Files that are SUPPOSED to be absent from a fresh checkout. Each one is verified, not assumed —
// keep the reason with the entry, and re-verify before adding to this list. An allowlist that
// grows on faith is how a real miss gets waved through.
const EXPECTED_ABSENT = {
  'phoenix-config.json':  'seeded from phoenix-config.example.json on first run (assistant.ensureConfig)',
  'palette.json':         'self-seeds with DEFAULT_PALETTE (palette.js)',
  'workflows.json':       'self-seeds with DEFAULT_WORKFLOWS (workflows.js)',
  'library-labels.json':  'optional; loadLibraryLabels() falls back to {assets:{}} and writes on save',
  'library-folders.json': 'optional; library-folders.js load() returns EMPTY() when absent, save() writes on first mutation',
  'SUSPECTED-ISSUES.md':  'optional troubleshooter input; read in a try/catch with an empty-string fallback',
};

// Skipped while walking: VCS/deps, everything git already ignores as runtime or user data, and
// this file itself — it quotes both a bad absolute require and a fake './x' as documentation,
// and a checker that flags its own examples is a checker nobody trusts.
const SKIP_DIR = /^(node_modules|\.git|output|staging|session|logs|brushes|animations|custom-rigs|characters|scenes|__pycache__)$|^session-/;
const SELF = path.resolve(__filename);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIR.test(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (path.resolve(p) !== SELF) out.push(p);
  }
  return out;
}

const files = walk('.').filter(f => f.endsWith('.js'));
const missing = [];
const expected = new Set();
let checked = 0;

const note = (from, target, key) => {
  if (EXPECTED_ABSENT[key]) expected.add(`${key} — ${EXPECTED_ABSENT[key]}`);
  else missing.push(`${from}  ->  ${target}`);
};

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');

  for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    checked++;
    const base = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(base) && !fs.existsSync(base + '.js') && !fs.existsSync(base + '.json')) {
      note(f, `require('${m[1]}')`, path.basename(m[1]));
    }
  }

  // 1b) ABSOLUTE requires. These resolve fine on the machine they were written on and crash with
  // MODULE_NOT_FOUND everywhere else, so they are always a bug — no existence check needed, the
  // shape alone condemns them. Added 2026-07-23 after blend-run.js was found doing
  // require('/abs/path/blender-ipc.js'): relative-path analysis cannot see this, and neither
  // can `node --check`, because the file parses perfectly.
  for (const m of src.matchAll(/require\(['"]((?:[A-Za-z]:[\\/]|\/|~)[^'"]+)['"]\)/g)) {
    checked++;
    missing.push(`${f}  ->  absolute require('${m[1]}') — only resolves on the author's machine`);
  }

  for (const m of src.matchAll(/__dirname,\s*['"]([^'"]+\.(?:js|py|json|md|bat))['"]/g)) {
    checked++;
    if (!fs.existsSync(path.join('.', m[1]))) note(f, m[1], path.basename(m[1]));
  }

  for (const m of src.matchAll(/['"](scripts\/[A-Za-z0-9_\-/]+\.py)['"]/g)) {
    checked++;
    if (!fs.existsSync(m[1])) note(f, m[1], path.basename(m[1]));
  }
}

console.log(`${checked} references across ${files.length} JS files checked`);
if (expected.size) {
  console.log('\nabsent by design (runtime-seeded / optional):');
  for (const e of expected) console.log('  · ' + e);
}
if (missing.length) {
  console.log('\nMISSING — these would break at runtime:');
  missing.forEach(x => console.log('  ✗ ' + x));
  process.exit(1);
}
console.log('\nno file left behind ✓');
