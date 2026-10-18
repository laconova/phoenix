// Release guard (VO1): the user's own reference voice must never ship.
//
//   node scripts/check-voice-release.js [root]      (root defaults to the current folder; run it INSIDE the
//                                                    clean checkout that will be released, like check-refs.js)
//
// Red (exit 1) when, anywhere in the tree - EVERY directory, including output/, logs/, staging/ ... that the string check skips:
//   1. an audio file is named  ref-*  (.wav .mp3 .flac .ogg .m4a - a reference recording), or any file starts with one of
//      the private stems below (e.g. a recording's notes)
//   2. a *.wav sits under voice-engines/ or sounds/refs/  (reference voices are the user's data, never product)
// and, in shipped .js / .py files only:
//   3. one of the private strings below appears
// Test harnesses (accept*.js, *.test.js) and this file are not shipped code and are skipped for rule 3.
// The private strings (your own voice stem, your machine paths) never live in this file: pass them at release time as
//   PHOENIX_RELEASE_FORBIDDEN="<stem>,<path>,..."   (entries without a slash also count as file-name stems for rule 1)

const fs = require('fs');
const path = require('path');

const FORBIDDEN = String(process.env.PHOENIX_RELEASE_FORBIDDEN || '').split(',').map(s => s.trim()).filter(Boolean);
const STEMS = FORBIDDEN.filter(s => !/[\\/]/.test(s)).map(s => s.toLowerCase());
const REF_AUDIO = /^ref-.*\.(wav|mp3|flac|ogg|m4a)$/i;
// Never descended at all (not part of any release). Everything else is walked for file NAMES.
const NEVER = /^(node_modules|\.git)$/;
// Walked for names, but their file CONTENTS are runtime/user data, not shipped source.
const NO_STRING_CHECK = /^(output|staging|session|logs|brushes|animations|custom-rigs|characters|scenes|__pycache__|unreal-cache|brush-cache|character-cache)$|^session-/;
const SELF = path.resolve(__filename);

function walk(dir, noStrings, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    if (NEVER.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, noStrings || NO_STRING_CHECK.test(e.name), out);
    else out.push({ p, noStrings });
  }
  return out;
}

function isHarness(p) {
  const b = path.basename(p);
  return path.resolve(p) === SELF || /^accept.*\.js$/.test(b) || /\.test\.js$/.test(b);
}

// scan(root[, { files }]) -> [ 'path: reason', ... ]  (empty = green)
// opts.files = a list of paths relative to root (e.g. `git ls-files`): scan exactly the release set instead of walking the folder.
function scan(root, opts) {
  const base = path.resolve(root || '.');
  const bad = [];
  const list = (opts && Array.isArray(opts.files))
    ? opts.files.map(f => ({ p: path.join(base, f), noStrings: NO_STRING_CHECK.test(f.split(/[\\/]/)[0]) }))
    : walk(base, false, []);
  for (const { p: f, noStrings } of list) {
    const rel = path.relative(base, f).split(path.sep).join('/');
    const name = path.basename(f);
    const lower = name.toLowerCase();
    if (REF_AUDIO.test(name)) bad.push(rel + ': audio file named ref-* (a reference recording)');
    else for (const s of STEMS) if (lower.startsWith(s)) { bad.push(rel + ': file named ' + s + '* (a private name)'); break; }
    if (/\.wav$/i.test(name) && /(^|\/)(voice-engines|sounds\/refs)\//i.test(rel)) bad.push(rel + ': .wav under voice-engines/ or sounds/refs/ (reference voices never ship)');
    if (!noStrings && /\.(js|py)$/.test(name) && !isHarness(f)) {
      let src = '';
      try { src = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      for (const s of FORBIDDEN) if (src.includes(s)) bad.push(rel + ': contains "' + s + '"');
    }
  }
  return bad;
}

module.exports = { scan };

if (require.main === module) {
  const bad = scan(process.argv[2] || '.');
  if (bad.length) {
    console.log('VOICE RELEASE GUARD: RED');
    bad.forEach(x => console.log('  ✗ ' + x));
    process.exit(1);
  }
  console.log('voice release guard: green ✓ (no reference recording, no reference .wav' + (FORBIDDEN.length ? ', none of the ' + FORBIDDEN.length + ' private strings' : '; no private strings given - set PHOENIX_RELEASE_FORBIDDEN') + ')');
}
