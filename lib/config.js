'use strict';

/**
 * config.js — zero-dependency environment loader + validated config object.
 *
 * Why hand-rolled instead of `dotenv`: the deploy target is a 32-bit ARM Termux
 * device where we want no dependencies at all (see ADR-002). Node's `--env-file`
 * flag exists but requires a recent 20.x patch level, so we parse `.env` ourselves.
 *
 * Security: this module never logs. Callers must route values through
 * `lib/logger.js`, which redacts secret-looking keys and exact secret substrings.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_ENV_FILE = path.join(ROOT_DIR, '.env');

const DEFAULTS = {
  defaultTz: 'Asia/Kolkata',
  logLevel: 'info',
  dryRun: true,
  menuLang: 'en',
  // Phase 4 — scheduler.
  schedulerEnabled: true,
  schedulerTickSeconds: 60,
  scheduleCatchupMinutes: 60,
  defaultScheduleTime: '08:00',
  defaultScheduleCount: 10
};

/** Languages with a complete string table in `lib/messages.js`. */
const SUPPORTED_LANGS = Object.freeze(['en', 'hi']);

class ConfigError extends Error {
  constructor(messages) {
    super(`Invalid configuration: ${messages.join('; ')}`);
    this.name = 'ConfigError';
    this.messages = messages;
  }
}

/**
 * Parse `.env`-style text into a plain object.
 * Supports `KEY=value`, `export KEY=value`, `#` comments, blank lines and
 * single/double quoted values. Later duplicate keys win.
 */
function parseEnvText(text) {
  const out = {};
  if (typeof text !== 'string') return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Strip an unquoted trailing comment (` # ...`).
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnvText(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

/** Normalise a `libsql://` / `http(s)://` Turso URL to its HTTPS pipeline form. */
function toHttpsUrl(tursoUrl) {
  if (!tursoUrl) return null;
  return tursoUrl.replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
}

function toHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parseInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** A bounded integer with a fallback, for knobs that must never be absurd. */
function clampInteger(value, fallback, min, max) {
  const n = parseInteger(value);
  if (n === null) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Build the runtime config.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]       Environment source (default: file `.env` merged under `process.env`).
 * @param {string} [opts.envFile]   Path to the `.env` file.
 * @param {boolean}[opts.requireBotToken=false] Fail when `BOT_TOKEN` is absent.
 * @returns {object} frozen config
 */
function loadConfig(opts = {}) {
  const fileEnv = opts.env !== undefined ? {} : readEnvFile(opts.envFile || DEFAULT_ENV_FILE);
  const env = { ...fileEnv, ...(opts.env || process.env) };

  const tursoUrl = (env.TURSO_DATABASE_URL || '').trim() || null;
  const dbHttpUrl = toHttpsUrl(tursoUrl);
  const rawLang = (env.MENU_LANG || '').trim().toLowerCase();

  const config = {
    botToken: (env.BOT_TOKEN || '').trim() || null,
    ownerTgId: parseInteger(env.OWNER_TG_ID),
    tursoUrl,
    tursoAuthToken: (env.TURSO_AUTH_TOKEN || '').trim() || null,
    dbHttpUrl,
    dbHttpHost: toHost(dbHttpUrl),
    defaultTz: (env.DEFAULT_TZ || '').trim() || DEFAULTS.defaultTz,
    logLevel: ((env.LOG_LEVEL || '').trim() || DEFAULTS.logLevel).toLowerCase(),
    dryRun: parseBoolean(env.DRY_RUN, DEFAULTS.dryRun),
    menuLang: SUPPORTED_LANGS.includes(rawLang) ? rawLang : DEFAULTS.menuLang,

    // --- Phase 4: scheduler ----------------------------------------------
    // `SCHEDULER_ENABLED=false` parks the tick engine without touching rows.
    schedulerEnabled: parseBoolean(env.SCHEDULER_ENABLED, DEFAULTS.schedulerEnabled),
    schedulerTickSeconds: clampInteger(env.SCHEDULER_TICK_SECONDS, DEFAULTS.schedulerTickSeconds, 5, 3600),
    scheduleCatchupMinutes: clampInteger(
      env.SCHEDULE_CATCHUP_MINUTES,
      DEFAULTS.scheduleCatchupMinutes,
      0,
      1440
    ),
    defaultScheduleTime: (env.DEFAULT_SCHEDULE_TIME || '').trim() || DEFAULTS.defaultScheduleTime,
    defaultScheduleCount: clampInteger(env.DEFAULT_SCHEDULE_COUNT, DEFAULTS.defaultScheduleCount, 1, 30)
  };

  const errors = [];
  if (!config.tursoUrl) errors.push('TURSO_DATABASE_URL is required');
  if (!config.tursoAuthToken) errors.push('TURSO_AUTH_TOKEN is required');
  if (config.tursoUrl && !config.dbHttpUrl) errors.push('TURSO_DATABASE_URL is not a valid URL');
  if (config.ownerTgId !== null && !Number.isSafeInteger(config.ownerTgId)) {
    errors.push('OWNER_TG_ID must be an integer within the safe range');
  }
  if (rawLang && !SUPPORTED_LANGS.includes(rawLang)) {
    errors.push(`MENU_LANG must be one of: ${SUPPORTED_LANGS.join(', ')}`);
  }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(config.defaultScheduleTime)) {
    errors.push('DEFAULT_SCHEDULE_TIME must be a 24-hour HH:MM time');
  }
  if (opts.requireBotToken && !config.botToken) errors.push('BOT_TOKEN is required');

  if (errors.length) throw new ConfigError(errors);

  // Freeze so later modules cannot mutate shared state.
  return Object.freeze(config);
}

module.exports = {
  loadConfig,
  parseEnvText,
  toHttpsUrl,
  ConfigError,
  DEFAULT_ENV_FILE,
  ROOT_DIR,
  SUPPORTED_LANGS
};
