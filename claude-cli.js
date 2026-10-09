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

// Sweep 3 F: resolve the real claude executable. Windows: `where.exe claude.exe` first (the native installer ships only that), then the
// claude.cmd shim. A candidate must EXIST and must not be node.exe (an npm cmd-shim for a cli.js bin quotes node.exe first - spawning that
// would run node, not claude); anything else -> null (the validated shell fallback). deps are a test seam.
function resolveClaudeExe(deps = {}) {
  const platform = deps.platform || process.platform;
  const sp = deps.spawnSync || spawnSync, rf = deps.readFileSync || fs.readFileSync, ex = deps.existsSync || fs.existsSync;
  const home = deps.homedir ? deps.homedir() : os.homedir();
  const isNode = (p) => /^node(js)?(\.exe)?$/i.test(path.win32.basename(String(p)) ) || /^node(js)?(\.exe)?$/i.test(path.basename(String(p)));
  if (platform !== 'win32') {
    // Non-login shells (SSH-started servers, systemd) often lack ~/.local/bin on PATH —
    // the standard claude install location on Linux. Resolve it explicitly; PATH fallback.
    try {
      const cand = path.join(home, '.local', 'bin', 'claude');
      if (ex(cand)) return cand;
    } catch (_) {}
    return null;
  }
  const where = (name) => { try { const r = sp('where.exe', [name], { encoding: 'utf8' }); return String((r && r.stdout) || '').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch (_) { return []; } };
  try {
    for (const c of where('claude.exe')) { if (!isNode(c) && ex(c)) return path.normalize(c); }
    const cmdPath = where('claude.cmd')[0];
    if (!cmdPath) return null;
    const cmdDir = path.dirname(cmdPath);
    const content = String(rf(cmdPath, 'utf8'));
    for (const m of content.matchAll(/"([^"\r\n]+\.exe)"/gi)) {
      // Expand %dp0% / %~dp0 (cmd.exe var = the .cmd file's directory, with trailing separator).
      const cand = path.normalize(m[1].replace(/%~?dp0%?/gi, cmdDir + path.sep));
      if (!isNode(cand) && ex(cand)) return cand;
    }
    return null;
  } catch (_) { return null; }
}
const CLAUDE_EXE = resolveClaudeExe();

function target() {
  return CLAUDE_EXE
    ? { cmd: CLAUDE_EXE, useShell: false }
    : { cmd: 'claude', useShell: process.platform === 'win32' };
}

// Sweep 3 A: characters that cmd.exe (or sh) would interpret even inside a quoted word: " % ! ^ & | < > ` and control characters.
const SHELL_BAD = /["%!^&|<>`\u0000-\u001f]/;
// The system-prompt file lives in a Phoenix-owned subfolder with a generated name. When the command line goes through a shell the whole path
// must be free of SHELL_BAD characters: try the temp dir, then a folder next to Phoenix; else refuse. (Never a shared / world-writable folder.)
function safeSysDir(strict) {
  const cands = [path.join(os.tmpdir(), 'phoenix-sys'), path.join(__dirname, 'session', 'tmp-sys')];
  for (const d of cands) {
    if (strict && SHELL_BAD.test(d)) continue;
    try { fs.mkdirSync(d, { recursive: true }); return d; } catch (_) { /* next */ }
  }
  throw new Error('Claude CLI: no usable folder for the system-prompt file' + (strict ? ' (the temp folder and Phoenix\'s own folder contain characters the Windows command shell would misread - a normal Windows user name avoids this)' : ' (could not create the temp folder)'));
}
function writeSysFile(systemPrompt, strict) {
  if (systemPrompt == null || systemPrompt === '') return null;
  const f = path.join(safeSysDir(!!strict),
    `sys-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
  // exclusive create ('wx': never follow / overwrite an existing file) and owner-only permissions where the platform supports them
  fs.writeFileSync(f, systemPrompt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
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
  const tgt0 = opts.target || target();
  let sysFile = null;
  try {
    sysFile = writeSysFile(systemPrompt, tgt0.useShell);
    assertSafeArgs(buildArgs(model, extraFlags, sysFile, false), { shell: !!tgt0.useShell });   // before ANY spawn
    // Sweep 2c: through planSpawn (resolved exe -> direct; unresolved -> ONE quoted command string with shell:true, no args array = no DEP0190).
    // planSpawn quotes every argument itself, so buildArgs gets the RAW sys-file path here. opts.target is a test seam.
    const plan = planSpawn(tgt0, buildArgs(model, extraFlags, sysFile, false));
    const sopts = { input: user || '', encoding: 'utf8', maxBuffer, timeout, ...plan.opts };
    const r = plan.args ? spawnSync(plan.file, plan.args, sopts) : spawnSync(plan.file, sopts);
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
    const tgt = opts.target || target();   // opts.target is a test seam
    let sysFile = null;
    try { sysFile = writeSysFile(systemPrompt, tgt.useShell); assertSafeArgs(buildArgs(model, extraFlags, sysFile, false), { shell: !!tgt.useShell }); }   // before ANY spawn
    catch (e) { if (sysFile) { try { fs.unlinkSync(sysFile); } catch (_) {} } reject(new Error('Claude CLI: ' + e.message.replace(/^Claude CLI: /, ''))); return; }
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
      childShell = !!tgt.useShell;
      const plan = planSpawn(tgt, buildArgs(model, extraFlags, sysFile, false));   // sweep 2c: see runSync - no args array together with shell:true
      child = plan.args ? spawn(plan.file, plan.args, { encoding: 'utf8', ...plan.opts }) : spawn(plan.file, { encoding: 'utf8', ...plan.opts });
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

// Sweep 3 A - strict allowlist. Whatever reaches a spawn is checked FIRST: the model must look like a model id, every other argument must be
// one of the fixed flags below (with a value of the expected shape), and no argument may carry a character a shell would interpret.
// Quoting alone is not enough: cmd.exe does not treat \" as an escape and expands %VAR% even inside quotes.
const MODEL_RE = /^[A-Za-z0-9._:\/\[\]-]+$/;
const FLAGS_NOARG = new Set(['--print', '--strict-mcp-config', '--version']);
// Sweep 3b: the path of the system-prompt file may only be held to the SHELL_BAD rule when a shell is on the line (a Windows user name with & ! % ^
// would otherwise lose every Claude call even though a direct spawn is immune to it). Length cap + control-character ban always apply.
const CTRL = /[\u0000-\u001f]/;
const FLAGS_VALUE = {
  '--model': (v) => MODEL_RE.test(v),
  '--tools': (v) => /^[A-Za-z,]*$/.test(v),
  '--allowedTools': (v) => /^[A-Za-z,]+$/.test(v),
  '--output-format': (v) => /^(json|text|stream-json)$/.test(v),
  '--system-prompt-file': (v, o) => v.length > 0 && v.length < 400 && !CTRL.test(v) && (!o.shell || !SHELL_BAD.test(v)),
};
function assertSafeArgs(args, o = {}) {
  if (!Array.isArray(args)) throw new Error('Claude CLI: refused - arguments must be a list');
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (FLAGS_NOARG.has(a)) continue;
    if (a === 'ok') continue;   // the model probe's fixed one-word prompt (the only positional argument that ever travels on the command line)
    if (Object.prototype.hasOwnProperty.call(FLAGS_VALUE, a)) {
      const v = args[i + 1];
      if (typeof v !== 'string' || !FLAGS_VALUE[a](v, o)) throw new Error('Claude CLI: refused an unsafe or malformed value for ' + a + (a === '--model' ? ' (a model id may only contain letters, digits and . _ : / [ ] -)' : ''));
      i++;
      continue;
    }
    throw new Error('Claude CLI: refused the argument "' + a.replace(/[^\x20-\x7e]/g, '?').slice(0, 40) + '" - not an allowed flag');
  }
}

// How to spawn the claude CLI. A resolved exe is spawned directly (shell:false, args array). Only when the exe could not be resolved
// (Windows .cmd shim) the shell is needed - then ONE command string with shell:true and NO args array (an args array together with shell:true is
// what Node 24 warns about as DEP0190). Because assertSafeArgs has already refused every shell metacharacter, the only quoting left is
// double quotes around a word that contains a space (the sys-file path), which is safe for the characters that remain.
function planSpawn(tgt, args) {
  assertSafeArgs(args, { shell: !!tgt.useShell });
  if (!tgt.useShell) return { file: tgt.cmd, args, opts: { shell: false } };
  if (SHELL_BAD.test(String(tgt.cmd)) || !/^[A-Za-z0-9._:\\\/ \-()]+$/.test(String(tgt.cmd))) throw new Error('Claude CLI: refused an unsafe CLI path');
  const q = (a) => (a === '' || /\s/.test(a) ? '"' + a + '"' : a);
  return { file: [tgt.cmd].concat(args.map(q)).join(' '), args: null, opts: { shell: true } };
}

module.exports = { CLAUDE_EXE, resolveClaudeExe, target, planSpawn, assertSafeArgs, SHELL_BAD, runSync, runStream };
