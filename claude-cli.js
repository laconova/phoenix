// Robust Claude CLI invocation, shared by phoenix.js (metaprompter) and
// assistant.js (orchestrator / troubleshooter seats).
//
// HARD RULE: prompt text is NEVER passed as a command-line argument.
//   * On Windows the PATH `claude` is a .cmd shim; Node needs shell:true to exec it,
//     which routes the command line through cmd.exe. cmd.exe treats literal newlines
//     as command separators and reinterprets & | < > ( ) " ^ — shredding any prompt
//     (the classic symptom: the model receives only a trailing fragment like
//     "...You are" and replies "it looks like your message got cut off").
//   * shell:true on POSIX has the same failure via /bin/sh word-splitting.
// So: the SYSTEM prompt goes to a temp file (--system-prompt-file) and the USER
// message goes via stdin. Only fixed, shell-safe flags ever touch the command line.
//
// We also resolve the real claude.exe from the .cmd shim so we can spawn it directly
// with shell:false whenever possible — that keeps even the temp-file PATH off cmd.exe
// (a stranger's Windows username can contain spaces). The shell:true branch is a
// last-resort fallback and still keeps ALL prompt text off the command line.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_EXE = (() => {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('where.exe', ['claude.cmd'], { encoding: 'utf8' });
    const cmdPath = (r.stdout || '').trim().split(/\r?\n/)[0].trim();
    if (!cmdPath) return null;
    const cmdDir = path.dirname(cmdPath);
    const content = fs.readFileSync(cmdPath, 'utf8');
    const m = content.match(/"([^"]+\.exe)"/i);
    if (!m) return null;
    // Expand %dp0% (cmd.exe var = the .cmd file's directory, with trailing separator).
    return path.normalize(m[1].replace(/%dp0%/gi, cmdDir + path.sep));
  } catch (_) { return null; }
})();

function target() {
  return CLAUDE_EXE
    ? { cmd: CLAUDE_EXE, useShell: false }
    : { cmd: 'claude', useShell: process.platform === 'win32' };
}

function writeSysFile(systemPrompt) {
  if (systemPrompt == null || systemPrompt === '') return null;
  const f = path.join(os.tmpdir(),
    `phoenix-sys-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
  fs.writeFileSync(f, systemPrompt, 'utf8');
  return f;
}

function buildArgs(model, extraFlags, sysFile) {
  const a = ['--print', '--model', model, ...extraFlags];
  if (sysFile) a.push('--system-prompt-file', sysFile);
  return a;
}

// Synchronous call — returns trimmed stdout, throws on error.
function runSync(model, systemPrompt, user, opts = {}) {
  const { extraFlags = [], maxBuffer = 4 * 1024 * 1024, timeout } = opts;
  const sysFile = writeSysFile(systemPrompt);
  try {
    const { cmd, useShell } = target();
    const r = spawnSync(cmd, buildArgs(model, extraFlags, sysFile),
      { input: user || '', encoding: 'utf8', maxBuffer, timeout, shell: useShell });
    if (r.error) throw new Error('Claude CLI: ' + r.error.message);
    if (r.status !== 0) throw new Error('Claude CLI exit ' + r.status + ': ' + (r.stderr || ''));
    return (r.stdout || '').trim();
  } finally {
    if (sysFile) { try { fs.unlinkSync(sysFile); } catch (_) {} }
  }
}

// Streaming call — returns Promise<trimmed stdout>.
function runStream(model, systemPrompt, user, opts = {}) {
  const { extraFlags = [] } = opts;
  return new Promise((resolve, reject) => {
    const sysFile = writeSysFile(systemPrompt);
    const clean = () => { if (sysFile) { try { fs.unlinkSync(sysFile); } catch (_) {} } };
    let child;
    try {
      const { cmd, useShell } = target();
      child = spawn(cmd, buildArgs(model, extraFlags, sysFile), { encoding: 'utf8', shell: useShell });
    } catch (e) { clean(); return reject(new Error('Claude CLI: ' + e.message)); }
    const out = [], err = [];
    child.on('error', e => { clean(); reject(new Error('Claude CLI: ' + e.message)); });
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('close', code => {
      clean();
      if (code !== 0) return reject(new Error('Claude CLI exit ' + code + ': ' + err.join('').trim()));
      resolve(out.join('').trim());
    });
    try { child.stdin.write(user || '', 'utf8'); child.stdin.end(); } catch (_) {}
  });
}

module.exports = { CLAUDE_EXE, runSync, runStream };
