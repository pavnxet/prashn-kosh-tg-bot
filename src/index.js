#!/usr/bin/env node
'use strict';

/**
 * src/index.js — Prashn-Kosh TG Bot entry point.
 *
 * Phase 4: loads config, connects to Turso, authenticates admins, long-polls
 * Telegram for commands, can send questions — `/preview` to the caller's own
 * chat, `/sendnow` to a connected channel — and runs the **scheduler**, which
 * posts each due slot once a day (see `lib/scheduler.js`).
 *
 * Still absent by design: the inline button menus (Phase 5).
 *
 * Usage:
 *   node src/index.js          # boot + long polling + scheduler
 *   node src/index.js --once   # preflight: config, Turso ping, getMe — then exit
 */

const { loadConfig, ConfigError } = require('../lib/config');
const { createLogger } = require('../lib/logger');
const { createTursoClient } = require('../lib/turso');
const { createTelegramClient } = require('../lib/telegram');
const { createAuth } = require('../lib/admin');
const { createChannelStore } = require('../lib/channels');
const { createSelector } = require('../lib/selector');
const { createDispatcher } = require('../lib/dispatcher');
const { createScheduleStore } = require('../lib/schedules');
const { createScheduler } = require('../lib/scheduler');
const { createMessages } = require('../lib/messages');
const { createRouter } = require('../lib/router');

const PHASE = 'phase-4-scheduler';

async function main() {
  const once = process.argv.includes('--once');

  let config;
  try {
    config = loadConfig({ requireBotToken: false });
  } catch (err) {
    const fallbackLog = createLogger({ level: process.env.LOG_LEVEL || 'info' });
    if (err instanceof ConfigError) fallbackLog.error('config_invalid', { errors: err.messages });
    else fallbackLog.error('config_load_failed', { error: err.message });
    process.exitCode = 1;
    return;
  }

  const log = createLogger({
    level: config.logLevel,
    // Mask the real secret values anywhere they might appear.
    secrets: [config.botToken, config.tursoAuthToken].filter(Boolean)
  });

  log.info('boot', {
    phase: PHASE,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    timezone: config.defaultTz,
    dryRun: config.dryRun,
    menuLang: config.menuLang,
    schedulerEnabled: config.schedulerEnabled,
    defaultScheduleTime: config.defaultScheduleTime,
    tursoHost: config.dbHttpHost, // host only — never the full URL, never the token
    ownerConfigured: config.ownerTgId !== null,
    botConfigured: config.botToken !== null
  });

  if (!config.ownerTgId) {
    log.warn('owner_not_configured', {
      hint: 'Set OWNER_TG_ID in .env. Send /id to the bot to discover your numeric user id.'
    });
  }

  const db = createTursoClient({ url: config.dbHttpUrl, authToken: config.tursoAuthToken });

  // --- Preflight path ------------------------------------------------------
  if (once) {
    try {
      const ping = await db.get('SELECT 1 AS ok');
      log.info('db_ok', { ok: Boolean(ping && ping.ok === 1) });
    } catch (err) {
      log.error('db_failed', { error: err.message });
      process.exitCode = 1;
      return;
    }

    if (config.botToken) {
      try {
        const tg = createTelegramClient({ token: config.botToken });
        const me = await tg.getMe();
        log.info('telegram_ok', { id: me.id, username: me.username });
      } catch (err) {
        log.error('telegram_failed', { error: err.message });
        process.exitCode = 1;
        return;
      }
    } else {
      log.warn('bot_token_missing', { hint: 'Set BOT_TOKEN in .env to enable polling.' });
    }

    log.info('check_ok', { note: 'Configuration, database and Telegram credentials verified.' });
    return;
  }

  // --- Polling path --------------------------------------------------------
  if (!config.botToken) {
    log.error('bot_token_missing', { hint: 'Set BOT_TOKEN in .env, then restart.' });
    process.exitCode = 1;
    return;
  }

  const tg = createTelegramClient({ token: config.botToken });
  const botInfo = await tg.getMe();
  log.info('telegram_ready', { id: botInfo.id, username: botInfo.username });

  const auth = createAuth({ db, config, log });
  const channels = createChannelStore({ db, tg, log, defaultTz: config.defaultTz });
  const selector = createSelector({ db, log });
  const messages = createMessages(config.menuLang);
  const dispatcher = createDispatcher({ db, tg, messages, log });
  const schedules = createScheduleStore({ db, log });
  const router = createRouter({
    tg,
    auth,
    channels,
    selector,
    dispatcher,
    schedules,
    config,
    botInfo,
    log,
    lang: config.menuLang
  });
  const scheduler = createScheduler({ tg, selector, dispatcher, schedules, messages, config, log });

  const controller = new AbortController();
  const shutdown = (signal) => {
    log.info('shutdown', { signal });
    scheduler.stop();
    controller.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  scheduler.start();

  log.info('polling', { note: 'Long polling for commands. Ctrl+C to stop.' });
  await tg.startPolling({
    onUpdate: (update) => router.handleUpdate(update),
    signal: controller.signal,
    log
  });

  scheduler.stop();
  log.info('stopped', { note: 'Polling loop finished.' });
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'fatal', error: err && err.message })}\n`
  );
  process.exit(1);
});
