'use strict';
// providers/secrets.js — API keys live in .secrets/providers.json ({ "<ref>": "<key>" }), never in
// phoenix-config.json. Nothing here logs, and only getKey() ever returns a key value.
const fs = require('fs');
const path = require('path');

// Read on every call (not at require time) so a test can point PHOENIX_SECRETS_DIR at a temp dir.
function dir()  { return process.env.PHOENIX_SECRETS_DIR || path.join(__dirname, '..', '.secrets'); }
function file() { return path.join(dir(), 'providers.json'); }

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (_) { return {}; }
}

function getKey(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  const v = readAll()[ref];
  if (typeof v === 'string' && v) return v;
  const e = process.env['PHOENIX_KEY_' + ref.toUpperCase()];
  if (e) return e;
  if (ref === 'openai' && process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return null;
}

// The thrown messages never contain the key that was passed in.
function setKey(ref, key) {
  if (typeof ref !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(ref)) throw new Error('invalid key reference');
  if (typeof key !== 'string' || key.length > 512 || /\s/.test(key)) throw new Error('invalid key (1-512 characters, no whitespace)');
  const all = readAll();
  if (key === '') delete all[ref]; else all[ref] = key;
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = file() + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

function listKeys() {
  const out = {};
  for (const [k, v] of Object.entries(readAll())) if (typeof v === 'string' && v) out[k] = true;
  return out;
}

module.exports = { getKey, setKey, listKeys };
