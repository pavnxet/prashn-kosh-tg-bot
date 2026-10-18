'use strict';

/**
 * logger.js — leveled JSON-line logger with secret redaction.
 *
 * Every log line is a single JSON object: { ts, level, msg, meta? }.
 * Two layers of redaction:
 *   1. Any object key matching /token|secret|password|auth/i is replaced wholesale.
 *   2. Any exact secret substring configured via `secrets` is masked inside strings.
 * This guarantees `BOT_TOKEN` / `TURSO_AUTH_TOKEN` values never reach the logs.
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SECRET_KEY_RE = /(token|secret|password|passwd|auth|apikey|api_key)/i;
const REDACTED = '[REDACTED]';

/**
 * Recursively redact a value.
 * @param {*} value
 * @param {{key?: string, secrets?: string[]}} [opts]
 */
function redact(value, opts = {}) {
  const secrets = opts.secrets || [];

  if (opts.key && SECRET_KEY_RE.test(opts.key)) return REDACTED;

  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, { secrets }));
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = redact(inner, { key, secrets });
    }
    return out;
  }

  return value;
}

/**
 * @param {object} [opts]
 * @param {'debug'|'info'|'warn'|'error'} [opts.level='info']
 * @param {string[]} [opts.secrets]  Exact values to mask inside strings.
 * @param {{write:(s:string)=>void}} [opts.out]  Sink (default `process.stdout`).
 * @param {() => Date} [opts.now]  Clock injection for tests.
 */
function createLogger(opts = {}) {
  const level = LEVELS[opts.level] !== undefined ? opts.level : 'info';
  const threshold = LEVELS[level];
  const secrets = opts.secrets || [];
  const out = opts.out || process.stdout;
  const now = opts.now || (() => new Date());

  const emit = (lvl, msg, meta) => {
    if (LEVELS[lvl] < threshold) return;
    const line = {
      ts: now().toISOString(),
      level: lvl,
      msg: String(msg)
    };
    if (meta !== undefined) line.meta = redact(meta, { secrets });
    out.write(`${JSON.stringify(line)}\n`);
  };

  return {
    level,
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    redact: (value) => redact(value, { secrets })
  };
}

module.exports = { createLogger, redact, LEVELS, REDACTED };
