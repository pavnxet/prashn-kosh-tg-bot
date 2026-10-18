'use strict';

/**
 * Smoke tests for the Phase 1 skeleton (config + logger).
 * Zero dependencies: uses the built-in `node:test` runner.
 *   npm test        (== node --test tests/)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, parseEnvText, toHttpsUrl, ConfigError } = require('../lib/config');
const { createLogger, redact, REDACTED } = require('../lib/logger');

const VALID_ENV = {
  TURSO_DATABASE_URL: 'libsql://prashn-kosh-demo.turso.io',
  TURSO_AUTH_TOKEN: 'turso-secret-token-value',
  BOT_TOKEN: '123456:AA-secret-bot-token',
  OWNER_TG_ID: '424242',
  DEFAULT_TZ: 'Asia/Kolkata',
  LOG_LEVEL: 'debug',
  DRY_RUN: 'true'
};

function collectLogger(env) {
  const lines = [];
  const log = createLogger({
    level: env.LOG_LEVEL,
    secrets: [env.TURSO_AUTH_TOKEN, env.BOT_TOKEN],
    out: { write: (s) => lines.push(s) },
    now: () => new Date('2026-10-18T00:00:00.000Z')
  });
  return { log, lines };
}

test('config: throws ConfigError when Turso credentials are missing', () => {
  assert.throws(() => loadConfig({ env: {} }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /TURSO_DATABASE_URL/);
    assert.match(err.message, /TURSO_AUTH_TOKEN/);
    return true;
  });
});

test('config: requires BOT_TOKEN only when asked', () => {
  const { BOT_TOKEN, ...withoutBotToken } = VALID_ENV;
  const cfg = loadConfig({ env: withoutBotToken });
  assert.equal(cfg.botToken, null);
  assert.throws(() => loadConfig({ env: withoutBotToken, requireBotToken: true }), /BOT_TOKEN/);
});

test('config: derives https endpoint + host and parses primitives', () => {
  const cfg = loadConfig({ env: VALID_ENV });
  assert.equal(cfg.dbHttpUrl, 'https://prashn-kosh-demo.turso.io');
  assert.equal(cfg.dbHttpHost, 'prashn-kosh-demo.turso.io');
  assert.equal(cfg.ownerTgId, 424242);
  assert.equal(cfg.logLevel, 'debug');
  assert.equal(cfg.dryRun, true);
  assert.ok(Object.isFrozen(cfg));
});

test('config: DRY_RUN defaults to safe (true) and parses false explicitly', () => {
  const base = { ...VALID_ENV };
  delete base.DRY_RUN;
  assert.equal(loadConfig({ env: base }).dryRun, true);
  assert.equal(loadConfig({ env: { ...VALID_ENV, DRY_RUN: 'false' } }).dryRun, false);
  assert.equal(loadConfig({ env: { ...VALID_ENV, DRY_RUN: 'no' } }).dryRun, false);
});

test('config: MENU_LANG defaults to en, accepts hi, and rejects a typo', () => {
  const base = { ...VALID_ENV };
  assert.equal(loadConfig({ env: base }).menuLang, 'en');
  assert.equal(loadConfig({ env: { ...VALID_ENV, MENU_LANG: 'HI' } }).menuLang, 'hi');
  assert.throws(() => loadConfig({ env: { ...VALID_ENV, MENU_LANG: 'hindi' } }), /MENU_LANG must be one of/);
});

test('config: toHttpsUrl handles http(s) urls and trailing slashes', () => {
  assert.equal(toHttpsUrl('libsql://a.turso.io'), 'https://a.turso.io');
  assert.equal(toHttpsUrl('https://a.turso.io/'), 'https://a.turso.io');
  assert.equal(toHttpsUrl(null), null);
});

test('config: parseEnvText ignores comments/blanks and survives quotes', () => {
  const parsed = parseEnvText(
    ['# comment', '', 'export A=1', 'B="two words"', "C='three'", 'D=plain # trailing', 'E='].join('\n')
  );
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'three', D: 'plain', E: '' });
});

test('logger: redacts secret-named keys wholesale', () => {
  const out = redact({ bot_token: 'abc', TURSO_AUTH_TOKEN: 'xyz', nested: { password: 'p' }, safe: 'ok' });
  assert.equal(out.bot_token, REDACTED);
  assert.equal(out.TURSO_AUTH_TOKEN, REDACTED);
  assert.equal(out.nested.password, REDACTED);
  assert.equal(out.safe, 'ok');
});

test('logger: masks exact secret substrings found in string values', () => {
  const { log, lines } = collectLogger(VALID_ENV);
  log.info('url', { endpoint: `https://x.turso.io?token=${VALID_ENV.TURSO_AUTH_TOKEN}` });
  const line = JSON.parse(lines[0]);
  assert.equal(line.meta.endpoint.includes(VALID_ENV.TURSO_AUTH_TOKEN), false);
  assert.ok(line.meta.endpoint.includes(REDACTED));
});

test('logger: honours level threshold and emits valid JSON lines', () => {
  const { log, lines } = collectLogger({ ...VALID_ENV, LOG_LEVEL: 'warn' });
  log.info('hidden');
  log.error('shown', { ok: true });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.msg, 'shown');
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
});
