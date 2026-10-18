'use strict';

/**
 * Tests for the schedule store and the pure "is this slot due?" rules.
 *
 * The due rules are the whole safety story of Phase 4: they decide whether a
 * restart at 4 pm replays the 8 am batch (it must not) and whether a slot can
 * fire twice in a day (it cannot).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createScheduleStore,
  parseSendTime,
  formatSendTime,
  normaliseDays,
  describeDays,
  zonedNow,
  isSlotDue,
  DEFAULT_SCHEDULE_TIME,
  DEFAULT_SCHEDULE_COUNT,
  DEFAULT_SCHEDULE_DAYS
} = require('../lib/schedules');
const { createFakeDb, createTestLogger } = require('./support/fakes');

/** 2026-10-18 is a Sunday; 02:30 UTC is 08:00 in Asia/Kolkata. */
const SUNDAY_0800_IST = new Date('2026-10-18T02:30:00Z');

const CHANNEL_SEED = {
  channels: [{ tg_chat_id: '-1001234567890', title: 'Example Channel', is_active: 1, timezone: 'Asia/Kolkata' }]
};

function scheduleRow(overrides = {}) {
  return {
    id: 1,
    channel_id: 1,
    send_time: '08:00',
    days_of_week: DEFAULT_SCHEDULE_DAYS,
    is_active: 1,
    last_run_date: null,
    timezone: 'Asia/Kolkata',
    ...overrides
  };
}

function buildStore(seed = CHANNEL_SEED) {
  const db = createFakeDb(seed);
  const log = createTestLogger();
  return { db, log, store: createScheduleStore({ db, log }) };
}

// --- pure helpers ---------------------------------------------------------

test('schedules: parseSendTime accepts 24-hour times and pads nothing itself', () => {
  assert.deepEqual(parseSendTime('08:00'), { hour: 8, minute: 0 });
  assert.deepEqual(parseSendTime('8:05'), { hour: 8, minute: 5 });
  assert.deepEqual(parseSendTime(' 23:59 '), { hour: 23, minute: 59 });
});

test('schedules: parseSendTime rejects malformed and out-of-range times', () => {
  for (const bad of ['', '   ', '8', '8:5', '0800', '24:00', '23:60', '08:00:00', 'noon', '-1:00']) {
    assert.throws(() => parseSendTime(bad), /not a (valid 24-hour )?time/, `"${bad}" should be rejected`);
  }
});

test('schedules: formatSendTime zero-pads so stored times sort as text', () => {
  assert.equal(formatSendTime(8, 0), '08:00');
  assert.equal(formatSendTime(0, 5), '00:05');
  assert.equal(formatSendTime(23, 59), '23:59');
});

test('schedules: normaliseDays understands the friendly tokens', () => {
  assert.equal(normaliseDays('1111111'), '1111111');
  assert.equal(normaliseDays('daily'), '1111111');
  assert.equal(normaliseDays('EVERYDAY'), '1111111');
  assert.equal(normaliseDays('weekdays'), '1111100');
  assert.equal(normaliseDays('weekends'), '0000011');
  assert.equal(normaliseDays('mon,wed'), '1010000');
  assert.equal(normaliseDays('MON WED FRI'), '1010100');
  assert.throws(() => normaliseDays('2026-10-18'), /unknown day/, 'a date is not a day list');
});

test('schedules: normaliseDays defaults when empty and throws on nonsense', () => {
  assert.equal(normaliseDays(''), DEFAULT_SCHEDULE_DAYS);
  assert.equal(normaliseDays(undefined), DEFAULT_SCHEDULE_DAYS);
  assert.throws(() => normaliseDays('whenever'), /unknown day/);
  assert.throws(() => normaliseDays('111111'), /unknown day/, 'a wrong-length bit string is not silently fixed');
});

test('schedules: describeDays round-trips the friendly names', () => {
  assert.equal(describeDays('1111111'), 'daily');
  assert.equal(describeDays('1111100'), 'weekdays');
  assert.equal(describeDays('0000011'), 'weekends');
  assert.equal(describeDays('1010000'), 'mon,wed');
  assert.equal(describeDays('0000000'), 'never');
  assert.equal(describeDays('garbage'), 'garbage');
});

test('schedules: zonedNow reads the local wall clock, not the machine clock', () => {
  const ist = zonedNow('Asia/Kolkata', SUNDAY_0800_IST);
  assert.deepEqual(ist, { date: '2026-10-18', hour: 8, minute: 0, weekday: 6 });

  const utc = zonedNow('UTC', SUNDAY_0800_IST);
  assert.deepEqual(utc, { date: '2026-10-18', hour: 2, minute: 30, weekday: 6 });
});

test('schedules: zonedNow survives midnight and an unknown timezone', () => {
  // 18:30 UTC is already the next day in India — the classic off-by-one.
  const midnight = zonedNow('Asia/Kolkata', new Date('2026-10-18T18:30:00Z'));
  assert.equal(midnight.date, '2026-10-19');
  assert.equal(midnight.hour, 0, 'hour 24 must be reported as 0');
  assert.equal(midnight.weekday, 0, 'Monday');

  // An unknown zone falls back to UTC instead of throwing.
  const fallback = zonedNow('Not/AZone', SUNDAY_0800_IST);
  assert.deepEqual(fallback, zonedNow('UTC', SUNDAY_0800_IST));
});

// --- isSlotDue ------------------------------------------------------------

test('schedules: a slot is due at its time and inside the catch-up window', () => {
  const at = isSlotDue({ schedule: scheduleRow(), now: SUNDAY_0800_IST });
  assert.equal(at.due, true);
  assert.equal(at.date, '2026-10-18');
  assert.equal(at.lateMinutes, 0);

  // 09:00 IST — 60 minutes late, still inside the default window.
  const late = isSlotDue({ schedule: scheduleRow(), now: new Date('2026-10-18T03:30:00Z') });
  assert.equal(late.due, true);
  assert.equal(late.lateMinutes, 60);
});

test('schedules: a slot does not fire early', () => {
  const verdict = isSlotDue({ schedule: scheduleRow(), now: new Date('2026-10-18T02:00:00Z') });
  assert.equal(verdict.due, false);
  assert.equal(verdict.reason, 'not_yet');
  assert.equal(verdict.waitMinutes, 30);
});

test('schedules: a slot outside the window is skipped, never replayed', () => {
  // 09:30 IST is 90 minutes late — the 60-minute window has closed.
  const verdict = isSlotDue({ schedule: scheduleRow(), now: new Date('2026-10-18T04:00:00Z') });
  assert.equal(verdict.due, false);
  assert.equal(verdict.reason, 'missed_window');
  assert.equal(verdict.lateMinutes, 90);
});

test('schedules: the catch-up window is configurable, and 0 means exactly on time', () => {
  const late = new Date('2026-10-18T02:31:00Z'); // 08:01 IST
  assert.equal(isSlotDue({ schedule: scheduleRow(), now: late, catchupMinutes: 0 }).due, false);
  assert.equal(isSlotDue({ schedule: scheduleRow(), now: late, catchupMinutes: 5 }).due, true);
});

test('schedules: a slot fires once per day', () => {
  const verdict = isSlotDue({
    schedule: scheduleRow({ last_run_date: '2026-10-18' }),
    now: SUNDAY_0800_IST
  });
  assert.equal(verdict.due, false);
  assert.equal(verdict.reason, 'already_ran');

  // A previous day does not block today.
  assert.equal(
    isSlotDue({ schedule: scheduleRow({ last_run_date: '2026-10-17' }), now: SUNDAY_0800_IST }).due,
    true
  );
});

test('schedules: days_of_week gates the slot', () => {
  // Sunday (index 6) is not in Mon–Fri.
  const verdict = isSlotDue({ schedule: scheduleRow({ days_of_week: '1111100' }), now: SUNDAY_0800_IST });
  assert.equal(verdict.due, false);
  assert.equal(verdict.reason, 'not_scheduled_today');

  assert.equal(isSlotDue({ schedule: scheduleRow({ days_of_week: '0000011' }), now: SUNDAY_0800_IST }).due, true);
});

test('schedules: an inactive schedule or a missing row is never due', () => {
  assert.equal(isSlotDue({ schedule: scheduleRow({ is_active: 0 }), now: SUNDAY_0800_IST }).reason, 'inactive');
  assert.equal(isSlotDue({ schedule: null, now: SUNDAY_0800_IST }).reason, 'no_schedule');
  assert.equal(isSlotDue({}).reason, 'no_schedule');
});

test('schedules: due results carry a machine-readable reason', () => {
  assert.equal(isSlotDue({ schedule: scheduleRow(), now: SUNDAY_0800_IST }).reason, 'due');
});

// --- store ----------------------------------------------------------------

test('schedules: create stores a normalised, enabled row', async () => {
  const { db, store } = buildStore();

  const created = await store.create({
    channelId: 1,
    sendTime: '8:05',
    days: 'weekdays',
    questionCount: 4,
    gapSeconds: 7
  });

  assert.equal(created.id, 1);
  assert.equal(created.send_time, '08:05');
  assert.equal(created.days_of_week, '1111100');
  assert.equal(created.question_count, 4);
  assert.equal(created.gap_seconds, 7);
  assert.equal(created.format, 'poll');
  assert.equal(created.is_active, 1);
  assert.equal(created.last_run_date, null);
  assert.equal(created.tg_chat_id, '-1001234567890', 'the join supplies the destination');
  assert.equal(db.schedules.size, 1);
});

test('schedules: create clamps the count and keeps defaults', async () => {
  const { store } = buildStore();

  const defaulted = await store.create({ channelId: 1 });
  assert.equal(defaulted.send_time, DEFAULT_SCHEDULE_TIME);
  assert.equal(defaulted.question_count, DEFAULT_SCHEDULE_COUNT);
  assert.equal(defaulted.days_of_week, DEFAULT_SCHEDULE_DAYS);

  const huge = await store.create({ channelId: 1, questionCount: 9999 });
  assert.equal(huge.question_count, 30, 'clamped to the ceiling');

  const zero = await store.create({ channelId: 1, questionCount: 0 });
  assert.equal(zero.question_count, 1, 'clamped to the floor');
});

test('schedules: create returns the row it just inserted, not the latest time', async () => {
  const { store } = buildStore();

  await store.create({ channelId: 1, sendTime: '20:00' });
  const earlier = await store.create({ channelId: 1, sendTime: '08:00' });

  assert.equal(earlier.id, 2, 'the new row is identified by id, not by position in a time-sorted list');
  assert.equal(earlier.send_time, '08:00');
  assert.equal(earlier.question_count, DEFAULT_SCHEDULE_COUNT, 'and it is fully hydrated from the join');
  assert.equal(earlier.tg_chat_id, '-1001234567890');

  // The listing itself still sorts by time.
  assert.deepEqual((await store.listAll()).map((row) => row.send_time), ['08:00', '20:00']);
});

test('schedules: create validates the channel and the time', async () => {
  const { db, store } = buildStore();

  await assert.rejects(() => store.create({ sendTime: '08:00' }), /channelId is required/);
  await assert.rejects(() => store.create({ channelId: 1, sendTime: '25:00' }), /not a valid 24-hour time/);
  assert.equal(db.schedules.size, 0);
});

test('schedules: listAll joins the channel and orders deterministically', async () => {
  const { store } = buildStore();
  await store.create({ channelId: 1, sendTime: '20:00' });
  await store.create({ channelId: 1, sendTime: '08:00' });

  const rows = await store.listAll();
  assert.deepEqual(rows.map((row) => row.send_time), ['08:00', '20:00']);
  assert.equal(rows[0].channel_active, 1, 'the channel state travels with the row');
  assert.equal(rows[0].timezone, 'Asia/Kolkata');
});

test('schedules: setActive and markRun update the row in place', async () => {
  const { store } = buildStore();
  await store.create({ channelId: 1 });

  const off = await store.setActive(1, false);
  assert.equal(off.is_active, 0);

  const on = await store.setActive(1, true);
  assert.equal(on.is_active, 1);

  await store.markRun(1, '2026-10-18');
  assert.equal((await store.findById(1)).last_run_date, '2026-10-18');
});

test('schedules: remove deletes the schedule and is reported on the next list', async () => {
  const { store } = buildStore();
  await store.create({ channelId: 1 });

  assert.deepEqual(await store.remove(1), { removed: true, id: 1 });
  assert.deepEqual(await store.listAll(), []);
  assert.equal(await store.findById(1), undefined);
});

test('schedules: countForChannel reports how many rows a channel owns', async () => {
  const { store } = buildStore();
  assert.equal(await store.countForChannel(1), 0);

  await store.create({ channelId: 1, sendTime: '08:00' });
  await store.create({ channelId: 1, sendTime: '20:00' });

  assert.equal(await store.countForChannel(1), 2);
  assert.equal(await store.countForChannel(2), 0);
});

test('schedules: ensureDefault adds the standard slot exactly once', async () => {
  const { db, store } = buildStore();

  const first = await store.ensureDefault(1, { sendTime: '08:00', questionCount: 10 });
  assert.equal(first.created, true);
  assert.equal(first.schedule.send_time, '08:00');
  assert.equal(first.schedule.question_count, 10);
  assert.equal(first.schedule.days_of_week, '1111111');

  const second = await store.ensureDefault(1, { sendTime: '20:00' });
  assert.equal(second.created, false, 'an existing schedule is never overwritten');
  assert.equal(second.count, 1);
  assert.equal(db.schedules.size, 1);
  assert.equal(db.schedules.get(1).send_time, '08:00');
});
