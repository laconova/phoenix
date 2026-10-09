'use strict';
// providers/errors.js — one error type for every provider failure, so callers can branch on
// `.kind` (config | rejected | timeout | unreachable | empty | no-vision) instead of parsing text.

class ProviderError extends Error {
  constructor(kind, message, ctx = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.seat = ctx.seat || null;
    this.provider = ctx.provider || null;
    this.model = ctx.model || null;
  }
}

module.exports = { ProviderError };
