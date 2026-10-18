'use strict';

/**
 * schedules.js — the scheduled-send store, plus the **pure** rules that decide
 * whether a slot is due.
 *
 * The due check is deliberately pure and timezone-aware so it can be tested
 * without a clock, a database or Telegram:
 *   - a slot fires **once per day** (tracked by `schedules.last_run_date`);
 *   - it only fires inside a **catch-up window** (60 min by default) after its
 *     time, so restarting the bot at 4 pm can never dump a stale 8 am batch;
 *   - `days_of_week` is a Mon→Sun bit string (`1111111` = every day), matching
 *     the column default in `migrations/001_bot_schema.sql`.
 *
 * `sent_log`'s unique index `(schedule_id, run_date, question_id)` is the second
 * half of the idempotency guarantee: even if `last_run_date` were lost, the same
 * question cannot be recorded twice in the same slot.
 */

/** Matches the schema defaults. */
const DEFAULT_SCHEDULE_TIME = '08:00';
const DEFAULT_SCHEDULE_COUNT = 10;
const DEFAULT_SCHEDULE_DAYS = '1111111';
const DEFAULT_SCHEDULE_GAP_SECONDS = 5;
const DEFAULT_CATCHUP_MINUTES = 60;

/** Guards for values a human can type. */
const MAX_SCHEDULE_COUNT = 30;
const MIN_GAP_SECONDS = 3;
const MAX_GAP_SECONDS = 60;

/** Mon → Sun, the order used by `days_of_week`. */
const WEEKDAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

const DAY_NAMES = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/** `HH:MM` (24-hour) → `{ hour, minute }`. Throws on anything else. */
function parseSendTime(value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) throw new Error(`schedule: "${raw}" is not a time (use HH:MM)`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`schedule: "${raw}" is not a valid 24-hour time`);
  return { hour, minute };
}

/** `{ hour, minute }` → `HH:MM` (zero-padded, so stored values sort as text). */
function formatSendTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Normalise a human day token into a Mon→Sun bit string.
 * Accepts `1111111`, `daily`, `weekdays`, `weekends`, or `mon,wed,fri`.
 */
function normaliseDays(value) {
  const raw = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  if (!raw) return DEFAULT_SCHEDULE_DAYS;
  if (raw === 'daily' || raw === 'everyday' || raw === 'all') return '1111111';
  if (raw === 'weekdays' || raw === 'weekday') return '1111100';
  if (raw === 'weekends' || raw === 'weekend') return '0000011';
  if (/^[01]{7}$/.test(raw)) return raw;

  const flags = ['0', '0', '0', '0', '0', '0', '0'];
  let seen = false;
  for (const token of raw.split(/[,\s]+/).filter(Boolean)) {
    const index = DAY_NAMES.indexOf(token.slice(0, 3));
    if (index === -1) throw new Error(`schedule: unknown day "${token}"`);
    flags[index] = '1';
    seen = true;
  }
  if (!seen) throw new Error(`schedule: "${value}" is not a valid day list`);
  return flags.join('');
}

/** A bit string back into something a human reads (`weekdays`, `mon,wed`, …). */
function describeDays(value) {
  const bits = String(value || DEFAULT_SCHEDULE_DAYS);
  if (!/^[01]{7}$/.test(bits)) return bits;
  if (bits === '1111111') return 'daily';
  if (bits === '1111100') return 'weekdays';
  if (bits === '0000011') return 'weekends';

  const picked = WEEKDAYS.filter((_, index) => bits[index] === '1');
  return picked.length ? picked.map((day) => day.toLowerCase()).join(',') : 'never';
}

/**
 * The local wall clock in an IANA timezone, without a date library.
 * @returns {{date:string, hour:number, minute:number, weekday:number}}
 *          `weekday` is 0 for Monday; `-1` when the name could not be read.
 */
function zonedNow(timezone, now = new Date()) {
  const tz = timezone || 'UTC';
  const options = {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short'
  };

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...options }).formatToParts(now);
  } catch {
    // An unknown timezone must not stop the scheduler; fall back to UTC.
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options }).formatToParts(now);
  }

  const pick = (type) => (parts.find((part) => part.type === type) || {}).value || '';
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    // Some ICU builds report midnight as hour "24".
    hour: Number(pick('hour')) % 24,
    minute: Number(pick('minute')),
    weekday: WEEKDAYS.indexOf(pick('weekday'))
  };
}

/**
 * Decide whether a schedule should run right now.
 *
 * @param {object} opts
 * @param {object} opts.schedule              Row (needs `send_time`, `days_of_week`,
 *                                            `is_active`, `last_run_date`, `timezone`).
 * @param {Date}   [opts.now]
 * @param {number} [opts.catchupMinutes]
 * @returns {{due:boolean, reason:string, date?:string, lateMinutes?:number, waitMinutes?:number}}
 */
function isSlotDue(opts = {}) {
  const { schedule, now = new Date(), catchupMinutes = DEFAULT_CATCHUP_MINUTES } = opts;
  if (!schedule) return { due: false, reason: 'no_schedule' };
  if (Number(schedule.is_active) !== 1) return { due: false, reason: 'inactive' };

  const local = zonedNow(schedule.timezone, now);
  if (local.weekday === -1) return { due: false, reason: 'unknown_weekday', date: local.date };

  const days = String(schedule.days_of_week || DEFAULT_SCHEDULE_DAYS);
  if (days[local.weekday] !== '1') {
    return { due: false, reason: 'not_scheduled_today', date: local.date };
  }

  if (schedule.last_run_date === local.date) {
    return { due: false, reason: 'already_ran', date: local.date };
  }

  const { hour, minute } = parseSendTime(schedule.send_time);
  const slotMinutes = hour * 60 + minute;
  const nowMinutes = local.hour * 60 + local.minute;

  if (nowMinutes < slotMinutes) {
    return { due: false, reason: 'not_yet', date: local.date, waitMinutes: slotMinutes - nowMinutes };
  }

  const lateMinutes = nowMinutes - slotMinutes;
  if (lateMinutes > catchupMinutes) {
    return { due: false, reason: 'missed_window', date: local.date, lateMinutes };
  }

  return { due: true, reason: 'due', date: local.date, lateMinutes };
}

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * @param {object} opts
 * @param {object} opts.db   Turso client.
 * @param {object} [opts.log]
 */
function createScheduleStore(opts = {}) {
  const { db, log } = opts;
  if (!db) throw new Error('schedules: db is required');

  const COLUMNS =
    's.id, s.channel_id, s.send_time, s.days_of_week, s.question_count, s.gap_seconds, ' +
    's.subject_filter_json, s.format, s.is_active, s.last_run_date, ' +
    'c.tg_chat_id, c.title, c.is_active AS channel_active, c.timezone';

  /** Every schedule with its channel's destination facts, ready for a tick. */
  function listAll() {
    return db.all(
      `SELECT ${COLUMNS} FROM schedules s JOIN channels c ON c.id = s.channel_id ` +
        'ORDER BY c.id, s.send_time, s.id'
    );
  }

  function listForChannel(channelId) {
    return db.all(
      `SELECT ${COLUMNS} FROM schedules s JOIN channels c ON c.id = s.channel_id ` +
        'WHERE s.channel_id = ? ORDER BY s.send_time, s.id',
      [Number(channelId)]
    );
  }

  function findById(id) {
    return db.get(
      `SELECT ${COLUMNS} FROM schedules s JOIN channels c ON c.id = s.channel_id WHERE s.id = ?`,
      [Number(id)]
    );
  }

  async function countForChannel(channelId) {
    const row = await db.get('SELECT COUNT(*) AS n FROM schedules WHERE channel_id = ?', [
      Number(channelId)
    ]);
    return Number(row && row.n) || 0;
  }

  /** Create a schedule. Throws on a bad time/day so the router can explain. */
  async function create(createOpts = {}) {
    const channelId = Number(createOpts.channelId);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      throw new Error('schedules: channelId is required');
    }

    const { hour, minute } = parseSendTime(createOpts.sendTime || DEFAULT_SCHEDULE_TIME);
    const days = normaliseDays(createOpts.days);
    const questionCount = clampInteger(
      createOpts.questionCount,
      DEFAULT_SCHEDULE_COUNT,
      1,
      MAX_SCHEDULE_COUNT
    );
    const gapSeconds = clampInteger(
      createOpts.gapSeconds,
      DEFAULT_SCHEDULE_GAP_SECONDS,
      MIN_GAP_SECONDS,
      MAX_GAP_SECONDS
    );
    const format = createOpts.format === 'text' ? 'text' : 'poll';
    const filter =
      createOpts.subjects && Object.keys(createOpts.subjects).length
        ? JSON.stringify(createOpts.subjects)
        : null;

    await db.execute(
      'INSERT INTO schedules (channel_id, send_time, days_of_week, question_count, gap_seconds, ' +
        'subject_filter_json, format, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [channelId, formatSendTime(hour, minute), days, questionCount, gapSeconds, filter, format]
    );

    const rows = await listForChannel(channelId);
    // `listForChannel` orders by time, so take the newest by id — `rows.at(-1)`
    // would be the *latest time*, not the row we just inserted.
    const created = rows.reduce((best, row) => (!best || row.id > best.id ? row : best), null);
    if (log) {
      log.info('schedule_created', {
        channelId,
        scheduleId: created && created.id,
        sendTime: formatSendTime(hour, minute),
        days,
        questionCount,
        format
      });
    }
    return created;
  }

  async function setActive(id, isActive) {
    await db.execute('UPDATE schedules SET is_active = ? WHERE id = ?', [
      isActive ? 1 : 0,
      Number(id)
    ]);
    return findById(id);
  }

  /** Remove the schedule only — `sent_log` history is never deleted (ADR-010). */
  async function remove(id) {
    await db.execute('DELETE FROM schedules WHERE id = ?', [Number(id)]);
    return { removed: true, id: Number(id) };
  }

  /** Mark the slot spent for `runDate`; this is what makes a slot fire once. */
  async function markRun(id, runDate) {
    await db.execute('UPDATE schedules SET last_run_date = ? WHERE id = ?', [
      runDate,
      Number(id)
    ]);
  }

  /**
   * Give a channel the standard daily slot, unless it already has any.
   * Called on `/connect`, so a freshly connected channel works with no setup.
   */
  async function ensureDefault(channelId, defaults = {}) {
    const existing = await listForChannel(channelId);
    if (existing.length) return { created: false, count: existing.length, schedule: existing[0] };

    const schedule = await create({
      channelId,
      sendTime: defaults.sendTime || DEFAULT_SCHEDULE_TIME,
      days: defaults.days || DEFAULT_SCHEDULE_DAYS,
      questionCount: defaults.questionCount || DEFAULT_SCHEDULE_COUNT,
      gapSeconds: defaults.gapSeconds,
      format: defaults.format
    });
    return { created: true, count: 1, schedule };
  }

  return {
    listAll,
    listForChannel,
    findById,
    countForChannel,
    create,
    setActive,
    remove,
    markRun,
    ensureDefault
  };
}

module.exports = {
  createScheduleStore,
  parseSendTime,
  formatSendTime,
  normaliseDays,
  describeDays,
  zonedNow,
  isSlotDue,
  WEEKDAYS,
  DAY_NAMES,
  DEFAULT_SCHEDULE_TIME,
  DEFAULT_SCHEDULE_COUNT,
  DEFAULT_SCHEDULE_DAYS,
  DEFAULT_SCHEDULE_GAP_SECONDS,
  DEFAULT_CATCHUP_MINUTES,
  MAX_SCHEDULE_COUNT,
  MIN_GAP_SECONDS,
  MAX_GAP_SECONDS
};
