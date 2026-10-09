'use strict';
// providers/claude-cli.js — the Claude CLI as a provider. Thin: flattening + error typing around
// ../claude-cli.js (which stays untouched — it owns the "prompt never on the command line" rule).
const { ProviderError } = require('./errors');

// History flattening, byte-for-byte what assistant.js did before providers existed.
function flatten(messages) {
  const contextLines = [];
  for (const m of messages.slice(0, -1)) {
    const tag = m.role === 'user' ? 'Human' : 'Assistant';
    contextLines.push(tag + ': ' + m.content);
  }
  const lastUser = messages[messages.length - 1].content;
  const contextBlock = contextLines.length
    ? '<conversation_history>\n' + contextLines.join('\n\n') + '\n</conversation_history>\n\n'
    : '';
  return contextBlock + lastUser;
}

// A missing binary shows up as spawn ENOENT (direct spawn) or as the shell's own text (cmd.exe / sh) after "exit N" — name it plainly.
// Anchored to the real shapes only: Node's own spawn failure ("Claude CLI: spawn <cmd> ENOENT ...") or the shell's missing-command text.
// An ENOENT somewhere inside a CLI's own stderr ("Claude CLI exit 1: ... ENOENT ...") is a normal failure and keeps its kind.
const CLI_MISSING = /^Claude CLI: spawn \S+ ENOENT|is not recognized as an internal or external command|command not found/i;
const CLI_MISSING_MSG = 'Claude CLI not found — install Claude Code (see README) or pick another brain in Settings → General → Seats';

function typeError(e, seat) {
  const msg = (e && e.message) || String(e);
  if (CLI_MISSING.test(msg)) return new ProviderError('unreachable', CLI_MISSING_MSG, { seat: seat.name, provider: 'claude-cli', model: seat.model });
  const kind = /exit \d+/.test(msg) ? 'rejected' : /timed out/.test(msg) ? 'timeout' : 'unreachable';
  return new ProviderError(kind, msg, { seat: seat.name, provider: 'claude-cli', model: seat.model });
}

async function complete(seat, { system, messages, timeoutMs, extraFlags, sync, cli } = {}) {
  const impl = cli || require('../claude-cli');
  const user = flatten(messages);
  const flags = Array.isArray(extraFlags) ? extraFlags : ['--tools', '', '--strict-mcp-config'];
  const opts = { extraFlags: flags };
  if (timeoutMs) opts.timeout = timeoutMs;   // absent = no timeout, exactly like the old metaprompter call
  try {
    const text = sync
      ? impl.runSync(seat.model, system, user, opts)
      : await impl.runStream(seat.model, system, user, opts);
    return { text };
  } catch (e) { throw typeError(e, seat); }
}

module.exports = { complete, flatten, CLI_MISSING, CLI_MISSING_MSG };
