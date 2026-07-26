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
  if (process.platform !== 'win32') {
    // Non-login shells (SSH-started servers, systemd) often lack ~/.local/bin on PATH —
    // the standard claude install location on Linux. Resolve it explicitly; PATH fallback.
    try {
      const cand = path.join(os.homedir(), '.local', 'bin', 'claude');
      if (fs.existsSync(cand)) return cand;
    } catch (_) {}
    return null;
  }
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

// With shell:false, args are passed through verbatim and nothing needs quoting. With the
// shell:true FALLBACK, Node joins the args with spaces and hands the string to cmd.exe /sh —
// so an argument containing a space silently splits into two. Prompt text never travels this
// way (that is the hard rule above), but the temp-file PATH does, and on Windows it sits under
// %TEMP% — i.e. C:\Users\<name>\AppData\... For a user whose name contains a space that path
// breaks apart and the CLI is called with a truncated --system-prompt-file. So the fallback
// branch quotes. Only reached when claude.exe could not be resolved from the .cmd shim.
function quoteForShell(s) {
  if (process.platform === 'win32') return /[\s&|<>^"()]/.test(s) ? '"' + s + '"' : s;
  return /[^A-Za-z0-9_@%+=:,./-]/.test(s) ? "'" + s.replace(/'/g, `'\\''`) + "'" : s;
}

function buildArgs(model, extraFlags, sysFile, useShell) {
  const a = ['--print', '--model', model, ...extraFlags];
  if (sysFile) a.push('--system-prompt-file', useShell ? quoteForShell(sysFile) : sysFile);
  return a;
}

// Synchronous call — returns trimmed stdout, throws on error.
function runSync(model, systemPrompt, user, opts = {}) {
  const { extraFlags = [], maxBuffer = 4 * 1024 * 1024, timeout } = opts;
  const sysFile = writeSysFile(systemPrompt);
  try {
    const { cmd, useShell } = target();
    const r = spawnSync(cmd, buildArgs(model, extraFlags, sysFile, useShell),
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
  const { extraFlags = [], timeout } = opts;
  return new Promise((resolve, reject) => {
    const sysFile = writeSysFile(systemPrompt);
    // Single-settle guard: whichever of {timeout, error, close} fires first wins,
    // clears the timer, removes the temp file, and settles the promise exactly once.
    let done = false, timer = null;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (sysFile) { try { fs.unlinkSync(sysFile); } catch (_) {} }
      fn(arg);
    };
    let child, childShell = false;
    try {
      const { cmd, useShell } = target();
      childShell = useShell;
      child = spawn(cmd, buildArgs(model, extraFlags, sysFile, useShell), { encoding: 'utf8', shell: useShell });
    } catch (e) { finish(reject, new Error('Claude CLI: ' + e.message)); return; }
    // stdin can EPIPE if the child dies instantly (bad flag / missing binary in shell mode); an
    // unlistened stream 'error' would crash the whole process. Swallow it — the child's
    // 'error'/'close' handlers below report the real failure.
    child.stdin.on('error', () => {});
    const out = [], err = [];
    // Optional timeout: kill the child so a hung CLI can't run forever burning tokens.
    if (timeout) {
      timer = setTimeout(() => {
        // On win32 with shell:true the direct child is cmd.exe; child.kill() there orphans the
        // real claude.exe (Windows has no process-group cascade). taskkill /T tears down the tree.
        try {
          if (process.platform === 'win32' && childShell && child.pid) {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
          } else {
            child.kill();
          }
        } catch (_) {}
        finish(reject, new Error('Claude CLI: timed out after ' + Math.round(timeout / 1000) + 's' +
          (err.length ? ' — stderr: ' + err.join('').trim().slice(-300) : '')));
      }, timeout);
    }
    child.on('error', e => finish(reject, new Error('Claude CLI: ' + e.message)));
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('close', code => {
      if (code !== 0) return finish(reject, new Error('Claude CLI exit ' + code + ': ' + err.join('').trim()));
      finish(resolve, out.join('').trim());
    });
    try { child.stdin.write(user || '', 'utf8'); child.stdin.end(); } catch (_) {}
  });
}

module.exports = { CLAUDE_EXE, runSync, runStream };
