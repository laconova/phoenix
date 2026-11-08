'use strict';
// web/assemble.js - Phoenix page assembler (R0a). The page is edited as the parts listed in web/src/page.json and served / inspected
// as ONE byte-identical document. Parts are concatenated as Buffers (no encoding round-trip, CRLF kept).
//   assemblePage({ webRoot }) -> Buffer      pageSource({ webRoot }) -> string (utf8; what the acceptance suites read)
// Refuses (throws an Error whose message names the offender) on: unreadable/invalid page.json, a part name that is empty, contains
// '/', '\' or '..' or does not resolve inside web/src/, a duplicate, a listed part missing on disk, a part on disk that is not listed.

const fs = require('fs');
const path = require('path');

const MANIFEST = 'page.json';
let cache = null;   // { key, buf }

function srcDirOf(opts) {
  const webRoot = (opts && opts.webRoot) || __dirname;
  return path.join(webRoot, 'src');
}

function readManifest(srcDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(srcDir, MANIFEST), 'utf8'); }
  catch (e) { throw new Error('page.json unreadable: ' + (e && e.code || e.message)); }
  let list;
  try { list = JSON.parse(raw.replace(/^﻿/, '')); }
  catch (e) { throw new Error('page.json is not valid JSON'); }
  if (!Array.isArray(list) || !list.length) throw new Error('page.json must be a non-empty array of part names');
  return list;
}

function checkNames(list, srcDir) {
  const seen = new Set();
  for (const name of list) {
    if (typeof name !== 'string' || !name) throw new Error('bad part name in page.json: ' + JSON.stringify(name));
    if (name.includes('/') || name.includes('\x5c') || name.includes('..') || name.includes('\0') || name === MANIFEST || path.basename(name) !== name) {
      throw new Error('illegal part name: ' + name);
    }
    if (seen.has(name)) throw new Error('duplicate part: ' + name);
    seen.add(name);
  }
  return seen;
}

function assemblePage(opts) {
  const srcDir = srcDirOf(opts);
  const list = readManifest(srcDir);
  const listed = checkNames(list, srcDir);
  let onDisk;
  try { onDisk = fs.readdirSync(srcDir); } catch (e) { throw new Error('web/src unreadable: ' + (e && e.code || e.message)); }
  for (const f of onDisk) if (f !== MANIFEST && !listed.has(f)) throw new Error('part on disk but not listed in page.json: ' + f);
  // cache key: page.json + every part's mtime/size
  const stats = [];
  for (const f of [MANIFEST].concat(list)) {
    let st;
    try { st = fs.statSync(path.join(srcDir, f)); } catch (e) { throw new Error('missing part: ' + f); }
    if (!st.isFile()) throw new Error('part is not a file: ' + f);
    stats.push(f + ':' + st.size + ':' + st.mtimeMs);
  }
  const key = srcDir + '|' + stats.join('|');
  if (cache && cache.key === key) return cache.buf;
  const bufs = list.map((f) => {
    try { return fs.readFileSync(path.join(srcDir, f)); } catch (e) { throw new Error('missing part: ' + f); }
  });
  const buf = Buffer.concat(bufs);
  cache = { key, buf };
  return buf;
}

function pageSource(opts) {
  return assemblePage(opts).toString('utf8');
}

module.exports = { assemblePage, pageSource };
