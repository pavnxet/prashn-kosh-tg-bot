'use strict';

/**
 * tests/support/fakes.js — in-memory stand-ins used by the unit tests.
 *
 * These are deliberately small: they implement only the SQL the bot actually
 * issues, which keeps the tests honest about what the real Turso client must
 * support (and no network is ever touched).
 */

/** A logger that records lines instead of writing them. */
function createTestLogger() {
  const lines = [];
  const push = (level) => (msg, meta) => lines.push({ level, msg, meta });
  return {
    lines,
    level: 'debug',
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    redact: (value) => value
  };
}

/**
 * Minimal in-memory Turso client: `get`, `all`, `execute`, `pipeline`.
 * Understands the specific statements issued by `lib/admin.js`, `lib/channels.js`
 * and `lib/router.js`.
 */
function createFakeDb(seed = {}) {
  const admins = new Map(); // tg_user_id -> row
  const channels = new Map(); // tg_chat_id -> row
  const schedules = new Map(); // id -> row
  const audit = [];
  const sentLog = [];
  const subjects = new Map(); // id -> { id, name }
  const calls = [];
  let nextChannelId = 1;
  let nextScheduleId = 1;

  for (const row of seed.channels || []) {
    channels.set(String(row.tg_chat_id), { id: nextChannelId++, ...row });
  }
  for (const row of seed.schedules || []) {
    schedules.set(Number(row.id) || nextScheduleId++, {
      is_active: 1,
      last_run_date: null,
      gap_seconds: 5,
      format: 'poll',
      ...row
    });
  }
  for (const row of seed.admins || []) admins.set(row.tg_user_id, { ...row });
  for (const row of seed.subjects || []) subjects.set(row.id, { ...row });

  function run(sql, args = []) {
    calls.push({ sql, args });
    const s = String(sql).replace(/\s+/g, ' ').trim();
    const a = args.map((v) => (v === undefined ? null : v));

    // --- bot_admins -------------------------------------------------------
    if (s.startsWith('INSERT INTO bot_admins')) {
      const [tgUserId, role, addedBy] = a.map((v) => (typeof v === 'string' && v === 'null' ? null : v));
      admins.set(tgUserId, {
        tg_user_id: tgUserId,
        role,
        added_by: addedBy === null || addedBy === undefined ? null : Number(addedBy),
        created_at: '2026-10-18T00:00:00Z'
      });
      return { cols: [], rows: [], affected_row_count: 1 };
    }
    if (s.startsWith('SELECT tg_user_id, role, added_by, created_at FROM bot_admins WHERE tg_user_id')) {
      const row = admins.get(a[0]);
      return row ? { cols: Object.keys(row).map((name) => ({ name })), rows: [Object.values(row)] } : { cols: [], rows: [] };
    }
    if (s.startsWith('SELECT tg_user_id, role, added_by, created_at FROM bot_admins ORDER BY')) {
      const rows = [...admins.values()].sort((x, y) => x.tg_user_id - y.tg_user_id);
      return { cols: [{ name: 'tg_user_id' }, { name: 'role' }, { name: 'added_by' }, { name: 'created_at' }], rows: rows.map((r) => [r.tg_user_id, r.role, r.added_by, r.created_at]) };
    }
    if (s.startsWith('DELETE FROM bot_admins')) {
      admins.delete(a[0]);
      return { cols: [], rows: [], affected_row_count: 1 };
    }

    // --- audit_log --------------------------------------------------------
    if (s.startsWith('INSERT INTO audit_log')) {
      audit.push({ id: audit.length + 1, actor_id: a[0], action: a[1], detail: a[2] });
      return { cols: [], rows: [], affected_row_count: 1 };
    }

    // --- schedules (Phase 4) ----------------------------------------------
    // Grouped before `channels` so the schedule-specific DELETE is matched
    // ahead of the generic `DELETE FROM` fallback further down.
    if (s.startsWith('INSERT INTO schedules')) {
      const [channelId, sendTime, days, questionCount, gapSeconds, subjectFilter, format] = a;
      const id = nextScheduleId++;
      schedules.set(id, {
        id,
        channel_id: Number(channelId),
        send_time: sendTime,
        days_of_week: days,
        question_count: Number(questionCount),
        gap_seconds: Number(gapSeconds),
        subject_filter_json: subjectFilter ?? null,
        format,
        is_active: 1,
        last_run_date: null
      });
      return { cols: [], rows: [], affected_row_count: 1 };
    }
    if (s.startsWith('SELECT s.id, s.channel_id')) {
      const cols = [
        'id',
        'channel_id',
        'send_time',
        'days_of_week',
        'question_count',
        'gap_seconds',
        'subject_filter_json',
        'format',
        'is_active',
        'last_run_date',
        'tg_chat_id',
        'title',
        'channel_active',
        'timezone'
      ];
      const joined = [...schedules.values()].map((row) => {
        const channel = channels.get(String(row.channel_id)) ||
          [...channels.values()].find((c) => c.id === row.channel_id) ||
          {};
        return {
          ...row,
          tg_chat_id: channel.tg_chat_id,
          title: channel.title,
          channel_active: channel.is_active,
          timezone: channel.timezone
        };
      });

      let filtered = joined;
      if (s.includes('WHERE s.channel_id = ?')) {
        filtered = joined.filter((row) => row.channel_id === Number(a[0]));
      } else if (s.includes('WHERE s.id = ?')) {
        filtered = joined.filter((row) => row.id === Number(a[0]));
      }

      filtered.sort(
        (x, y) =>
          x.channel_id - y.channel_id ||
          String(x.send_time).localeCompare(String(y.send_time)) ||
          x.id - y.id
      );
      return {
        cols: cols.map((name) => ({ name })),
        rows: filtered.map((row) => cols.map((name) => (row[name] === undefined ? null : row[name])))
      };
    }
    if (s.startsWith('SELECT COUNT(*) AS n FROM schedules WHERE channel_id')) {
      const n = [...schedules.values()].filter((row) => row.channel_id === Number(a[0])).length;
      return { cols: [{ name: 'n' }], rows: [[n]] };
    }
    if (s.startsWith('UPDATE schedules SET is_active = ? WHERE id')) {
      const row = schedules.get(Number(a[1]));
      if (row) row.is_active = a[0];
      return { cols: [], rows: [], affected_row_count: row ? 1 : 0 };
    }
    if (s.startsWith('UPDATE schedules SET last_run_date = ? WHERE id')) {
      const row = schedules.get(Number(a[1]));
      if (row) row.last_run_date = a[0];
      return { cols: [], rows: [], affected_row_count: row ? 1 : 0 };
    }
    if (s.startsWith('DELETE FROM schedules')) {
      schedules.delete(Number(a[0]));
      return { cols: [], rows: [], affected_row_count: 1 };
    }

    // --- channels ---------------------------------------------------------
    if (s.startsWith('SELECT id, tg_chat_id, title, is_active, timezone, created_at FROM channels ORDER BY')) {
      const rows = [...channels.values()].sort((x, y) => x.id - y.id);
      return {
        cols: [{ name: 'id' }, { name: 'tg_chat_id' }, { name: 'title' }, { name: 'is_active' }, { name: 'timezone' }, { name: 'created_at' }],
        rows: rows.map((r) => [r.id, r.tg_chat_id, r.title, r.is_active, r.timezone, r.created_at || '2026-10-18T00:00:00Z'])
      };
    }
    if (s.startsWith('SELECT * FROM channels WHERE tg_chat_id')) {
      const row = channels.get(String(a[0]));
      if (!row) return { cols: [], rows: [] };
      return { cols: Object.keys(row).map((name) => ({ name })), rows: [Object.values(row)] };
    }
    if (s.startsWith('INSERT INTO channels')) {
      const [tgChatId, title, timezone] = a;
      const key = String(tgChatId);
      const existing = channels.get(key);
      if (existing) {
        existing.title = title;
        existing.timezone = timezone;
      } else {
        channels.set(key, { id: nextChannelId++, tg_chat_id: key, title, is_active: 1, timezone });
      }
      return { cols: [], rows: [], affected_row_count: 1 };
    }
    if (s.startsWith('UPDATE channels SET is_active = ? WHERE tg_chat_id')) {
      const [isActive, tgChatId] = a;
      const row = channels.get(String(tgChatId));
      if (row) row.is_active = isActive;
      return { cols: [], rows: [], affected_row_count: row ? 1 : 0 };
    }
    if (s.startsWith('UPDATE channels SET is_active = ? WHERE id')) {
      const [isActive, id] = a;
      for (const row of channels.values()) if (row.id === Number(id)) row.is_active = isActive;
      return { cols: [], rows: [], affected_row_count: 1 };
    }
    if (s.startsWith('DELETE FROM channels')) {
      // The real statement targets the numeric primary key, not the chat id.
      for (const [key, row] of channels) if (row.id === Number(a[0])) channels.delete(key);
      return { cols: [], rows: [], affected_row_count: 1 };
    }
    if (s.startsWith('DELETE FROM')) {
      return { cols: [], rows: [], affected_row_count: 1 };
    }

    // --- sent_log (Phase 3) ----------------------------------------------
    if (s.startsWith('INSERT INTO sent_log')) {
      sentLog.push({
        id: sentLog.length + 1,
        channel_id: a[0],
        question_id: a[1],
        schedule_id: a[2] ?? null,
        run_date: a[3] ?? null,
        tg_message_id: s.includes('tg_message_id') ? a[4] ?? null : null,
        status: s.includes("'sent'") ? 'sent' : 'failed',
        error: s.includes('error') ? a[a.length - 1] : null
      });
      return { cols: [], rows: [], affected_row_count: 1 };
    }

    // --- subjects (read-only lookup) --------------------------------------
    if (s.startsWith('SELECT id, name FROM subjects')) {
      const rows = [...subjects.values()].sort((x, y) => String(x.id).localeCompare(String(y.id)));
      return {
        cols: [{ name: 'id' }, { name: 'name' }],
        rows: rows.map((r) => [r.id, r.name])
      };
    }

    throw new Error(`fake db: unsupported statement: ${s.slice(0, 80)}`);
  }

  const raw = (sql, args) => run(sql, args);
  const asObjects = (result) => {
    const names = result.cols.map((c) => c.name);
    return result.rows.map((row) => {
      const obj = {};
      row.forEach((cell, i) => {
        obj[names[i]] = cell;
      });
      return obj;
    });
  };

  return {
    calls,
    audit,
    admins,
    channels,
    schedules,
    sentLog,
    subjects,
    get: async (sql, args) => asObjects(raw(sql, args))[0],
    all: async (sql, args) => asObjects(raw(sql, args)),
    execute: async (sql, args) => raw(sql, args),
    pipeline: async (statements) => statements.map((s) => raw(s.sql, s.args))
  };
}

/**
 * Fake Telegram client. Records outgoing messages in `sent`.
 * `behavior` can override any method.
 */
function createFakeTg(behavior = {}) {
  const sent = [];
  const polls = [];

  const client = {
    sent,
    polls,
    getMe: behavior.getMe || (async () => ({ id: 999, username: 'test_bot', first_name: 'Test' })),
    getChat: behavior.getChat || (async (chatId) => ({ id: Number(chatId), type: 'channel', title: `Channel ${chatId}` })),
    getChatMember: behavior.getChatMember || (async () => ({ status: 'administrator', can_post_messages: true })),
    getChatAdministrators: behavior.getChatAdministrators || (async () => []),
    getChatMemberCount: behavior.getChatMemberCount || (async () => 10),
    sendMessage: behavior.sendMessage || (async (chatId, text, extra) => {
      sent.push({ chatId, text, extra });
      return { message_id: sent.length };
    }),
    editMessageText: behavior.editMessageText || (async () => ({ message_id: 1 })),
    deleteMessage: behavior.deleteMessage || (async () => true),
    answerCallbackQuery: behavior.answerCallbackQuery || (async (id, extra) => {
      sent.push({ callbackQueryId: id, ...extra });
      return true;
    }),
    sendPoll: behavior.sendPoll || (async (chatId, question, options, extra) => {
      polls.push({ chatId, question, options, extra });
      return { message_id: polls.length };
    }),
    call: behavior.call || (async () => ({})),
    callWithRetry: behavior.callWithRetry || (async () => ({})),
    startPolling: behavior.startPolling || (async (o) => {
      polls.push(o);
      return { stop() {} };
    })
  };

  return client;
}

/** Message update shape, as Telegram delivers it. */
function messageUpdate({ text, userId = 1, chatId = 1, username = 'tester' }) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1700000000,
      text,
      from: { id: userId, is_bot: false, first_name: 'Test', username },
      chat: { id: chatId, type: 'private' }
    }
  };
}

/**
 * A question row shaped like the live `questions` table.
 * `overrides` wins, so a test can make one deliberately unusable.
 */
function questionRow(overrides = {}) {
  return {
    id: 'q_test_1',
    subject_id: 'rajasthan_polity',
    question_text: 'राजस्थान का सबसे बड़ा जिला कौन-सा है?',
    question_type: 'mcq',
    options_json: JSON.stringify([
      { key: 'A', text: 'जैसलमेर' },
      { key: 'B', text: 'बाड़मेर' },
      { key: 'C', text: 'जयपुर' },
      { key: 'D', text: 'उदयपुर' }
    ]),
    correct_option: 'A',
    explanation: 'क्षेत्रफल के अनुसार जैसलमेर सबसे बड़ा जिला है।',
    ...overrides
  };
}

/**
 * Fake selector: returns a prepared list and records how it was called.
 * Takes the place of the real SQL-backed selector in router tests.
 */
function createFakeSelector(questions = [], extra = {}) {
  const list = typeof questions === 'function' ? questions : () => questions;
  const calls = [];
  return {
    calls,
    selectQuestions: async (opts) => {
      calls.push(opts);
      const chosen = list(opts) || [];
      return {
        questions: chosen,
        requested: opts.count || 0,
        available: {},
        bySubject: {},
        recycled: {},
        shortfall: 0,
        ...extra
      };
    },
    subjectNames: async () => ({ rajasthan_polity: 'Rajasthan Polity' })
  };
}

module.exports = {
  createFakeDb,
  createFakeTg,
  createFakeSelector,
  createTestLogger,
  messageUpdate,
  questionRow
};
