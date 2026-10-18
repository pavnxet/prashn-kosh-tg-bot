'use strict';

/**
 * router.js — command handling for the bot's private chat.
 *
 * Phase 4 scope: identity, status, channel connect/verify, pause/resume, admins,
 * the sender (`/preview` and `/sendnow`) and the schedule controls
 * (`/schedule …`). Inline button menus arrive in Phase 5.
 *
 * Two deliberate safety choices:
 *   1. `/start`, `/help` and `/id` are open to everyone — a new owner needs `/id`
 *      to discover their numeric `OWNER_TG_ID`.
 *   2. Privileged replies go to the caller's **private chat** (`from.id`), never
 *      to the group where the command was typed, so admin lists and channel ids
 *      are not leaked into a group.
 *
 * A third one belongs to Phase 3: nothing reaches a channel while `DRY_RUN=true`.
 * `/sendnow` then behaves like `/preview` — the exact items, sent to the admin
 * only, with `sent_log` untouched so the dry run leaves no trace behind.
 */

const { createMessages, PARSE_MODE } = require('./messages');
const { normaliseChatId } = require('./channels');
const { DEFAULT_GAP_SECONDS } = require('./dispatcher');
const {
  parseSendTime,
  formatSendTime,
  normaliseDays,
  describeDays,
  DEFAULT_SCHEDULE_TIME,
  DEFAULT_SCHEDULE_COUNT,
  DEFAULT_SCHEDULE_DAYS,
  MAX_SCHEDULE_COUNT
} = require('./schedules');

const PHASE = 'phase-4-scheduler';
const PUBLIC_COMMANDS = Object.freeze(['start', 'help', 'id']);

/** Ceilings for a single manual send. */
const MAX_PREVIEW_COUNT = 10;
const MAX_SENDNOW_COUNT = 30;
const DEFAULT_SENDNOW_COUNT = 5;

/** `/schedule` sub-commands, so a stray word cannot be read as a day list. */
const SCHEDULE_VERBS = Object.freeze(['list', 'add', 'default', 'enable', 'disable', 'remove']);

/** Split `/cmd@BotName arg1 arg2` into `{ command, args }`. */
function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  const command = parts[0].slice(1).split('@')[0].toLowerCase();
  if (!command) return null;
  return { command, args: parts.slice(1) };
}

/**
 * @param {object} opts
 * @param {object} opts.tg            Telegram client (`lib/telegram.js`).
 * @param {object} opts.auth          Auth helper (`lib/admin.js`).
 * @param {object} opts.channels      Channel store (`lib/channels.js`).
 * @param {object} opts.config        Frozen config.
 * @param {object} [opts.selector]    Question selector (`lib/selector.js`).
 * @param {object} [opts.dispatcher]  Question dispatcher (`lib/dispatcher.js`).
 * @param {object} [opts.schedules]   Schedule store (`lib/schedules.js`).
 * @param {object} [opts.botInfo]     Result of `getMe()` captured at boot.
 * @param {object} [opts.log]
 * @param {string} [opts.lang]        Menu language (`en` | `hi`).
 */
function createRouter(opts = {}) {
  const { tg, auth, channels, config, selector, dispatcher, schedules, botInfo = null, log } = opts;
  if (!tg) throw new Error('router: telegram client is required');
  if (!auth) throw new Error('router: auth helper is required');
  if (!channels) throw new Error('router: channel store is required');

  const messages = createMessages(opts.lang || 'en');
  const senderReady = Boolean(selector && dispatcher);
  const schedulerReady = Boolean(schedules);

  // `t()` HTML-escapes every value, so all messages here are safe to send as HTML.
  const send = (chatId, text, extra = {}) =>
    tg.sendMessage(chatId, text, { parse_mode: PARSE_MODE, ...extra });

  /** First plain integer in the arguments, clamped into range. */
  function parseCount(args, fallback, max) {
    const token = (args || []).find((arg) => /^\d+$/.test(arg));
    if (!token) return fallback;
    return Math.min(Math.max(1, Number(token)), max);
  }

  /** An explicit channel id in the arguments (`-100…`). */
  function parseChatArg(args) {
    return (args || []).find((arg) => /^-\d{6,}$/.test(arg)) || null;
  }

  /** `text` forces the text format even for poll-capable questions. */
  function wantsText(args) {
    return (args || []).some((arg) => /^text$/i.test(arg));
  }

  /** `08:00` / `8:05` → canonical `HH:MM`; `null` when the token is not a time. */
  function canonicalTime(token) {
    if (!/^\d{1,2}:\d{2}$/.test(String(token))) return null;
    try {
      const { hour, minute } = parseSendTime(token);
      return formatSendTime(hour, minute);
    } catch {
      return null;
    }
  }

  /** The first token that could be a day list (`daily`, `weekdays`, `mon,wed`). */
  function parseDaysArg(args) {
    for (const arg of args || []) {
      if (SCHEDULE_VERBS.includes(String(arg).toLowerCase())) continue;
      if (/^\d{1,2}:\d{2}$/.test(arg)) continue; // a time
      if (/^-?\d+$/.test(arg)) continue; // a count or a chat id
      if (/^text$/i.test(arg)) continue; // the format flag
      if (!/[a-z]/i.test(arg)) continue;
      return arg;
    }
    return null;
  }

  /** The first bare integer after the sub-command — a schedule id. */
  function parseIdArg(args) {
    const token = (args || []).find((arg, index) => index > 0 && /^\d+$/.test(arg));
    return token === undefined ? null : Number(token);
  }

  /**
   * Resolve which channel a send refers to: an explicit id in the arguments, or
   * the first active channel.
   */
  async function pickChannel(args) {
    const explicit = parseChatArg(args);
    if (explicit) {
      let normalised;
      try {
        normalised = normaliseChatId(explicit);
      } catch (err) {
        return { error: 'invalid', chatId: explicit, detail: err.message };
      }
      const row = await channels.findByChatId(normalised);
      return row ? { row } : { error: 'unknown', chatId: normalised };
    }

    const rows = await channels.list();
    const active = rows.find((row) => row.is_active);
    if (active) return { row: active };
    if (rows.length) return { row: rows[0], paused: true };
    return { error: 'none' };
  }

  /** The label to show a human for a channel row. */
  const channelTitle = (row) => row.title || String(row.tg_chat_id);

  async function cmdStatus(chatId) {
    let channelCount = '0';
    let adminCount = '0';
    try {
      const [rows, admins] = await Promise.all([channels.list(), auth.listAdmins()]);
      channelCount = String(rows.length);
      adminCount = String(admins.length + (auth.hasOwner ? 1 : 0));
    } catch (err) {
      if (log) log.warn('status_lookup_failed', { error: err.message });
    }

    return send(
      chatId,
      messages.t('status', {
        username: (botInfo && botInfo.username) || 'unknown',
        phase: PHASE,
        dryRun: config && config.dryRun ? 'true' : 'false',
        timezone: (config && config.defaultTz) || 'Asia/Kolkata',
        dbHost: (config && config.dbHttpHost) || 'unknown',
        ownerSet: auth.hasOwner ? 'yes' : 'no',
        channels: channelCount,
        admins: adminCount
      })
    );
  }

  async function cmdConnect(chatId, actorId, args) {
    const raw = args[0];
    if (!raw) return send(chatId, messages.t('connect_usage'));

    let normalised;
    try {
      normalised = normaliseChatId(raw);
    } catch (err) {
      return send(chatId, messages.t('connect_invalid', { chatId: raw, error: err.message }));
    }

    const result = await channels.connect({ chatId: normalised, actorId });

    if (result.ok) {
      await auth.logAudit(actorId, 'channel_connected', `chat=${normalised} title=${result.title || ''}`);

      // A freshly connected channel gets the standard daily slot so the bot
      // works with no further setup. A channel that already has a schedule is
      // never touched (ADR-016).
      let extra = '';
      if (schedulerReady && result.channel) {
        try {
          const ensured = await schedules.ensureDefault(result.channel.id, {
            sendTime: (config && config.defaultScheduleTime) || DEFAULT_SCHEDULE_TIME,
            days: DEFAULT_SCHEDULE_DAYS,
            questionCount: (config && config.defaultScheduleCount) || DEFAULT_SCHEDULE_COUNT
          });
          if (ensured.created) {
            await auth.logAudit(
              actorId,
              'schedule_default_created',
              `id=${ensured.schedule && ensured.schedule.id} chat=${normalised}`
            );
            extra = `\n\n${messages.t('schedule_default_created', {
              id: (ensured.schedule && ensured.schedule.id) || '?',
              time: (ensured.schedule && ensured.schedule.send_time) || DEFAULT_SCHEDULE_TIME,
              count: (ensured.schedule && ensured.schedule.question_count) || DEFAULT_SCHEDULE_COUNT,
              title: result.title || normalised
            })}`;
          }
        } catch (err) {
          // A schedule problem must never fail the connection itself.
          if (log) log.warn('schedule_default_failed', { chatId: normalised, error: err.message });
        }
      }

      return send(
        chatId,
        `${messages.t('connect_ok', { title: result.title || normalised, chatId: normalised, reason: result.rights.reason })}${extra}`
      );
    }

    await auth.logAudit(actorId, 'channel_connect_failed', `chat=${normalised} reason=${result.rights.reason}`);
    const reasonText = result.rights.reason;
    const suffix = result.rights.reason === 'bot_is_not_an_administrator' || result.rights.reason === 'bot_is_not_in_the_chat'
      ? messages.t('connect_hint')
      : '';
    return send(chatId, `${messages.t('connect_failed', { chatId: normalised, error: reasonText })}${suffix}`);
  }

  async function cmdChannels(chatId) {
    const rows = await channels.list();
    if (!rows.length) return send(chatId, messages.t('channels_empty'));

    const lines = rows.map((row) =>
      messages.t('channels_row', {
        marker: row.is_active ? '✅' : '⏸',
        chatId: row.tg_chat_id,
        title: row.title || '(untitled)',
        tz: row.timezone
      })
    );
    return send(chatId, [messages.t('channels_header'), ...lines].join('\n'));
  }

  async function cmdToggle(chatId, command, args) {
    const raw = args[0];
    if (!raw) return send(chatId, messages.t('connect_usage'));

    let normalised;
    try {
      normalised = normaliseChatId(raw);
    } catch (err) {
      return send(chatId, messages.t('connect_invalid', { chatId: raw, error: err.message }));
    }

    const existing = await channels.findByChatId(normalised);
    if (!existing) return send(chatId, messages.t('channel_unknown', { chatId: normalised }));

    const isActive = command === 'resume';
    await channels.setActive(normalised, isActive);
    await auth.logAudit(null, `channel_${isActive ? 'resumed' : 'paused'}`, `chat=${normalised}`);

    return send(
      chatId,
      messages.t('channel_toggled', {
        chatId: normalised,
        state: isActive ? messages.t('active') : messages.t('paused')
      })
    );
  }

  async function cmdAdmins(chatId) {
    const rows = await auth.listAdmins();
    const lines = [messages.t('admins_header')];
    if (auth.hasOwner) lines.push(messages.t('admins_owner', { userId: auth.ownerId }));
    if (!rows.length) lines.push(messages.t('admins_none'));
    rows.forEach((row) => lines.push(messages.t('admins_row', { userId: row.tg_user_id, role: row.role })));
    return send(chatId, lines.join('\n'));
  }

  /** Shared by `/preview` and `/sendnow`: prove the sender modules were wired. */
  function senderUnavailable(chatId) {
    return send(chatId, messages.t('error_generic', { error: 'question sender is not configured' }));
  }

  /**
   * `/preview [count]` — render the exact items to the caller's own chat.
   * Uses the channel's history for the "already sent" filter, but writes nothing.
   */
  async function cmdPreview(chatId, args) {
    if (!senderReady) return senderUnavailable(chatId);

    const type = wantsText(args) ? 'text' : 'poll';
    const count = parseCount(args, 1, MAX_PREVIEW_COUNT);

    const picked = await pickChannel(args);
    if (picked.error === 'invalid') {
      return send(chatId, messages.t('connect_invalid', { chatId: picked.chatId, error: picked.detail }));
    }
    if (picked.error === 'unknown') {
      return send(chatId, messages.t('channel_unknown', { chatId: picked.chatId }));
    }

    const channelId = picked.row ? picked.row.id : 0;
    const selection = await selector.selectQuestions({
      channelId,
      count,
      // Include every renderable row; the dispatcher picks poll vs the
      // two-message text form per row.
      pollableOnly: false,
      allowRecycle: false
    });

    if (!selection.questions.length) return send(chatId, messages.t('preview_none'));

    await send(chatId, messages.t('preview_header', { count: selection.questions.length }));

    const subjectNames = await selector.subjectNames();
    return dispatcher.sendItems({
      chatId,
      questions: selection.questions,
      type,
      gapSeconds: 1,
      subjectNames,
      record: false // a preview must never mark anything as sent
    });
  }

  /**
   * `/sendnow [count] [chat_id] [text]` — post to a connected channel now.
   * Respects `DRY_RUN`: in dry-run mode the items go to the admin only and
   * `sent_log` is left untouched.
   */
  async function cmdSendnow(respondTo, actorId, args) {
    if (!senderReady) return senderUnavailable(respondTo);

    const type = wantsText(args) ? 'text' : 'poll';
    const count = parseCount(args, DEFAULT_SENDNOW_COUNT, MAX_SENDNOW_COUNT);

    const picked = await pickChannel(args);
    if (picked.error === 'none') return send(respondTo, messages.t('sendnow_no_channel'));
    if (picked.error === 'invalid') {
      return send(respondTo, messages.t('connect_invalid', { chatId: picked.chatId, error: picked.detail }));
    }
    if (picked.error === 'unknown') {
      return send(respondTo, messages.t('channel_unknown', { chatId: picked.chatId }));
    }

    const row = picked.row;
    const title = channelTitle(row);

    const selection = await selector.selectQuestions({
      channelId: row.id,
      count,
      // Every renderable row qualifies; non-pollable ones use the two-message
      // text form (ADR-014). `text` only forces that form for pollable rows too.
      pollableOnly: false,
      allowRecycle: true
    });

    if (!selection.questions.length) return send(respondTo, messages.t('sendnow_none', { title }));

    const subjectNames = await selector.subjectNames();
    const dryRun = Boolean(config && config.dryRun);

    if (dryRun) {
      await send(
        respondTo,
        messages.t('sendnow_dryrun', { count: selection.questions.length, title, chatId: row.tg_chat_id })
      );
      await dispatcher.sendItems({
        chatId: respondTo,
        questions: selection.questions,
        type,
        gapSeconds: 1,
        subjectNames,
        record: false
      });
      await auth.logAudit(actorId, 'send_now_dry_run', `chat=${row.tg_chat_id} count=${selection.questions.length}`);
      return;
    }

    await send(
      respondTo,
      messages.t('sendnow_start', { count: selection.questions.length, title, chatId: row.tg_chat_id })
    );

    const outcome = await dispatcher.sendItems({
      chatId: row.tg_chat_id,
      channelId: row.id,
      record: true,
      questions: selection.questions,
      type,
      gapSeconds: DEFAULT_GAP_SECONDS,
      runDate: dispatcher.runDateFor(row.timezone || (config && config.defaultTz)),
      subjectNames
    });

    await auth.logAudit(
      actorId,
      'send_now',
      `chat=${row.tg_chat_id} sent=${outcome.sent} failed=${outcome.failed}`
    );

    if (outcome.sent === 0) return send(respondTo, messages.t('sendnow_all_failed', { title }));

    await send(
      respondTo,
      messages.t('sendnow_done', {
        sent: outcome.sent,
        requested: selection.questions.length,
        title,
        mode: outcome.mode,
        failed: outcome.failed
      })
    );

    const recycled = Object.keys(selection.recycled || {});
    if (recycled.length) {
      await send(
        respondTo,
        messages.t('sendnow_recycled', { subjects: recycled.map((id) => subjectNames[id] || id).join(', ') })
      );
    }
    return outcome;
  }

  // --- Phase 4: schedules --------------------------------------------------

  /** Resolve the target channel for a schedule command, or explain why not. */
  async function scheduleChannel(respondTo, args) {
    const picked = await pickChannel(args);
    if (picked.error === 'invalid') {
      await send(respondTo, messages.t('connect_invalid', { chatId: picked.chatId, error: picked.detail }));
      return null;
    }
    if (picked.error === 'unknown') {
      await send(respondTo, messages.t('channel_unknown', { chatId: picked.chatId }));
      return null;
    }
    if (picked.error === 'none') {
      await send(respondTo, messages.t('schedule_no_channel'));
      return null;
    }
    return picked.row;
  }

  /** Shared by `/schedule default` and the `/connect` auto-default. */
  async function createDefaultSchedule(row, actorId, verb) {
    const ensured = await schedules.ensureDefault(row.id, {
      sendTime: (config && config.defaultScheduleTime) || DEFAULT_SCHEDULE_TIME,
      days: DEFAULT_SCHEDULE_DAYS,
      questionCount: (config && config.defaultScheduleCount) || DEFAULT_SCHEDULE_COUNT
    });
    if (!ensured.created) return null;

    const created = ensured.schedule || {};
    await auth.logAudit(actorId, verb, `id=${created.id} chat=${row.tg_chat_id}`);
    return created;
  }

  async function cmdScheduleList(respondTo) {
    const rows = await schedules.listAll();
    if (!rows.length) return send(respondTo, messages.t('schedule_none'));

    const lines = rows.map((row) =>
      messages.t('schedule_row', {
        marker: Number(row.is_active) === 1 ? '✅' : '⏸',
        id: row.id,
        time: row.send_time,
        days: describeDays(row.days_of_week),
        count: row.question_count,
        format: row.format,
        title: channelTitle(row)
      })
    );
    return send(respondTo, [messages.t('schedule_header'), ...lines].join('\n'));
  }

  async function cmdScheduleAdd(respondTo, actorId, args, timeToken) {
    const time = timeToken ? canonicalTime(timeToken) : DEFAULT_SCHEDULE_TIME;
    if (!time) return send(respondTo, messages.t('schedule_invalid_time', { value: timeToken }));

    let days = DEFAULT_SCHEDULE_DAYS;
    const daysToken = parseDaysArg(args);
    if (daysToken) {
      try {
        days = normaliseDays(daysToken);
      } catch {
        return send(respondTo, messages.t('schedule_invalid_days', { value: daysToken }));
      }
    }

    const row = await scheduleChannel(respondTo, args);
    if (!row) return undefined;

    const count = parseCount(args, DEFAULT_SCHEDULE_COUNT, MAX_SCHEDULE_COUNT);
    const created = await schedules.create({
      channelId: row.id,
      sendTime: time,
      days,
      questionCount: count,
      format: wantsText(args) ? 'text' : 'poll'
    });

    await auth.logAudit(
      actorId,
      'schedule_created',
      `id=${created && created.id} chat=${row.tg_chat_id} time=${time} days=${days} count=${count}`
    );

    return send(
      respondTo,
      messages.t('schedule_created', {
        id: (created && created.id) || '?',
        time,
        days: describeDays(days),
        count,
        title: channelTitle(row),
        chatId: row.tg_chat_id
      })
    );
  }

  async function cmdScheduleDefault(respondTo, actorId, args) {
    const row = await scheduleChannel(respondTo, args);
    if (!row) return undefined;

    const created = await createDefaultSchedule(row, actorId, 'schedule_default_created');
    // Already scheduled — show what exists rather than pretending to add one.
    if (!created) return cmdScheduleList(respondTo);

    return send(
      respondTo,
      messages.t('schedule_default_created', {
        id: created.id,
        time: created.send_time,
        count: created.question_count,
        title: channelTitle(row)
      })
    );
  }

  async function cmdScheduleToggle(respondTo, actorId, args, isActive) {
    const id = parseIdArg(args);
    const existing = id === null ? null : await schedules.findById(id);
    if (!existing) {
      return send(respondTo, messages.t('schedule_unknown', { id: id === null ? (args[1] || '?') : id }));
    }

    await schedules.setActive(id, isActive);
    await auth.logAudit(actorId, isActive ? 'schedule_enabled' : 'schedule_disabled', `id=${id}`);
    return send(
      respondTo,
      messages.t('schedule_toggled', { id, state: isActive ? messages.t('active') : messages.t('paused') })
    );
  }

  async function cmdScheduleRemove(respondTo, actorId, args) {
    const id = parseIdArg(args);
    const existing = id === null ? null : await schedules.findById(id);
    if (!existing) {
      return send(respondTo, messages.t('schedule_unknown', { id: id === null ? (args[1] || '?') : id }));
    }

    await schedules.remove(id);
    await auth.logAudit(actorId, 'schedule_removed', `id=${id}`);
    return send(respondTo, messages.t('schedule_removed', { id }));
  }

  /**
   * `/schedule [list|add|default|enable|disable|remove] …`
   *
   *   /schedule 08:00 5            → add (a bare time implies `add`)
   *   /schedule add 08:00 5 -100… weekly
   *   /schedule default            → the standard daily 08:00 slot
   *
   * Posting happens on the scheduler's next tick, not here.
   */
  async function cmdSchedule(respondTo, actorId, args) {
    if (!schedulerReady) {
      return send(respondTo, messages.t('error_generic', { error: 'the scheduler is not configured' }));
    }

    const list = args || [];
    const timeToken = list.find((arg) => /^\d{1,2}:\d{2}$/.test(arg)) || null;
    const sub = String(list[0] || '').toLowerCase();
    const verb = SCHEDULE_VERBS.includes(sub) ? sub : timeToken ? 'add' : 'list';

    switch (verb) {
      case 'add':
        return cmdScheduleAdd(respondTo, actorId, list, timeToken);
      case 'default':
        return cmdScheduleDefault(respondTo, actorId, list);
      case 'enable':
        return cmdScheduleToggle(respondTo, actorId, list, true);
      case 'disable':
        return cmdScheduleToggle(respondTo, actorId, list, false);
      case 'remove':
        return cmdScheduleRemove(respondTo, actorId, list);
      default:
        return cmdScheduleList(respondTo);
    }
  }

  /** Handle a single Telegram update. Never throws for a bad update. */
  async function handleUpdate(update) {
    if (!update) return;

    if (update.message && update.message.from) {
      const message = update.message;
      const fromId = message.from.id;
      const chatId = message.chat ? message.chat.id : null;
      const parsed = parseCommand(message.text);
      if (!parsed) return;

      const { command, args } = parsed;
      const isPublic = PUBLIC_COMMANDS.includes(command);
      // Privileged answers go to the admin's private chat, not the group.
      const respondTo = isPublic ? chatId : fromId;

      try {
        if (!isPublic) {
          const allowed = await auth.requireAdmin(fromId, `/${command}`);
          if (!allowed) {
            await send(respondTo, messages.t('not_authorised'));
            return;
          }
        }

        switch (command) {
          case 'start':
          case 'help':
            await send(respondTo, `${messages.t('welcome')}\n\n${messages.t('help')}`);
            return;
          case 'id':
            await send(respondTo, messages.t('id_info', { userId: fromId, chatId }));
            return;
          case 'status':
            await cmdStatus(respondTo);
            return;
          case 'connect':
            await cmdConnect(respondTo, fromId, args);
            return;
          case 'channels':
            await cmdChannels(respondTo);
            return;
          case 'pause':
          case 'resume':
            await cmdToggle(respondTo, command, args);
            return;
          case 'admins':
            await cmdAdmins(respondTo);
            return;
          case 'preview':
            await cmdPreview(respondTo, args);
            return;
          case 'sendnow':
            await cmdSendnow(respondTo, fromId, args);
            return;
          case 'schedule':
            await cmdSchedule(respondTo, fromId, args);
            return;
          default:
            await send(respondTo, messages.t('unknown_command'));
            return;
        }
      } catch (err) {
        if (log) log.error('command_failed', { command, error: err.message });
        await send(respondTo, messages.t('error_generic', { error: err.message })).catch(() => {});
        return;
      }
    }

    if (update.callback_query) {
      // Inline menus arrive in Phase 5; acknowledge so the client stops spinning.
      try {
        await tg.answerCallbackQuery(update.callback_query.id, { text: 'Menu coming soon' });
      } catch (err) {
        if (log) log.warn('callback_ack_failed', { error: err.message });
      }
      return;
    }
  }

  return { handleUpdate, parseCommand, messages, PHASE };
}

module.exports = { createRouter, parseCommand, PUBLIC_COMMANDS, PHASE };
