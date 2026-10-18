'use strict';

/**
 * Tests for the scheduler engine.
 *
 * These are the tests that matter most for Phase 4: the engine decides when a
 * real message hits a real channel. Each case pins one behaviour —
 * fire once, never replay a missed slot, respect DRY_RUN, and always tell the
 * owner when something went wrong.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createScheduler } = require('../lib/scheduler');
const { createScheduleStore } = require('../lib/schedules');
const { createDispatcher } = require('../lib/dispatcher');
const { createMessages } = require('../lib/messages');
const {
  createFakeDb,
  createFakeTg,
  createFakeSelector,
  createTestLogger,
  questionRow
} = require('./support/fakes');

const CHAT = '-1001234567890';
const OWNER = 555;

/** 2026-10-18 (Sunday) 08:00 in Asia/Kolkata. */
const DUE_NOW = new Date('2026-10-18T02:30:00Z');

const CONFIG = Object.freeze({
  ownerTgId: OWNER,
  dryRun: false,
  scheduleCatchupMinutes: 60,
  schedulerTickSeconds: 60,
  defaultTz: 'Asia/Kolkata'
});

const SEED = {
  channels: [{ tg_chat_id: CHAT, title: 'Example Channel', is_active: 1, timezone: 'Asia/Kolkata' }],
  schedules: [
    {
      id: 1,
      channel_id: 1,
      send_time: '08:00',
      days_of_week: '1111111',
      question_count: 1,
      gap_seconds: 5,
      format: 'poll'
    }
  ]
};

function build(overrides = {}) {
  const {
    seed = SEED,
    config = CONFIG,
    tgBehavior = {},
    questions = [questionRow({ id: 'q1' })],
    now = () => DUE_NOW
  } = overrides;

  const db = createFakeDb(seed);
  const tg = createFakeTg(tgBehavior);
  const log = createTestLogger();
  const messages = createMessages('en');
  const selector = createFakeSelector(questions);
  const dispatcher = createDispatcher({ db, tg, messages, log });
  const schedules = createScheduleStore({ db, log });
  const scheduler = createScheduler({
    tg,
    selector,
    dispatcher,
    schedules,
    messages,
    config,
    log,
    now,
    sleep: async () => {}
  });

  return { db, tg, log, messages, selector, dispatcher, schedules, scheduler };
}

/** Messages the owner received, as plain strings. */
const dmsToOwner = (tg) => tg.sent.filter((msg) => String(msg.chatId) === String(OWNER)).map((m) => m.text);

// --- the happy path -------------------------------------------------------

test('scheduler: a due slot posts to the channel, once, and records it', async () => {
  const { db, tg, selector, scheduler } = build();

  const run = await scheduler.tick();

  assert.equal(run.skipped, false);
  assert.equal(run.due, 1);
  assert.equal(run.results[0].status, 'sent');
  assert.equal(run.results[0].sent, 1);

  assert.equal(selector.calls.length, 1);
  assert.equal(selector.calls[0].channelId, 1);
  assert.equal(selector.calls[0].count, 1);
  assert.equal(selector.calls[0].pollableOnly, false, 'non-pollable rows are renderable too');

  assert.equal(tg.polls.length, 1);
  assert.equal(tg.polls[0].chatId, CHAT);
  assert.equal(tg.polls[0].extra.type, 'quiz');

  assert.equal(db.schedules.get(1).last_run_date, '2026-10-18', 'the slot is spent');
  assert.equal(db.sentLog.length, 1);
  assert.equal(db.sentLog[0].schedule_id, 1);
  assert.equal(db.sentLog[0].channel_id, 1);
  assert.equal(db.sentLog[0].run_date, '2026-10-18');
  assert.equal(db.sentLog[0].status, 'sent');

  assert.deepEqual(dmsToOwner(tg), [], 'a clean run does not nag the owner');
});

test('scheduler: a second tick on the same day does nothing', async () => {
  const { tg, scheduler } = build();

  await scheduler.tick();
  const second = await scheduler.tick();

  assert.equal(second.due, 0);
  assert.equal(tg.polls.length, 1, 'exactly one poll ever reached the channel');
});

test('scheduler: the schedule format chooses poll vs the two-message text form', async () => {
  const seed = {
    ...SEED,
    schedules: [{ ...SEED.schedules[0], format: 'text' }]
  };
  const { tg, scheduler } = build({ seed });

  await scheduler.tick();

  assert.equal(tg.polls.length, 0, 'text mode never sends a poll');
  assert.equal(tg.sent.length, 2, 'stem, then options with the answer');
  assert.equal(tg.sent[0].chatId, CHAT);
});

// --- slots that must not run ---------------------------------------------

test('scheduler: nothing runs before the slot', async () => {
  const { tg, scheduler } = build({ now: () => new Date('2026-10-18T02:00:00Z') });

  const run = await scheduler.tick();

  assert.equal(run.due, 0);
  assert.equal(tg.polls.length, 0);
  assert.equal(tg.sent.length, 0);
});

test('scheduler: a missed slot is skipped, never replayed late', async () => {
  const { tg, db, scheduler } = build({ now: () => new Date('2026-10-18T04:00:00Z') });

  const run = await scheduler.tick();

  assert.equal(run.due, 0, '90 minutes late is outside the 60-minute window');
  assert.equal(tg.polls.length, 0);
  assert.equal(db.schedules.get(1).last_run_date, null, 'and the slot is left for the next day');
});

test('scheduler: a day the schedule does not cover is skipped', async () => {
  const seed = { ...SEED, schedules: [{ ...SEED.schedules[0], days_of_week: '1111100' }] };
  const { tg, scheduler } = build({ seed });

  const run = await scheduler.tick();

  assert.equal(run.due, 0);
  assert.equal(tg.polls.length, 0);
});

test('scheduler: an inactive schedule is skipped', async () => {
  const seed = { ...SEED, schedules: [{ ...SEED.schedules[0], is_active: 0 }] };
  const { tg, scheduler } = build({ seed });

  assert.equal((await scheduler.tick()).due, 0);
  assert.equal(tg.polls.length, 0);
});

test('scheduler: a paused channel is skipped even though the schedule is active', async () => {
  const seed = {
    channels: [{ ...SEED.channels[0], is_active: 0 }],
    schedules: SEED.schedules
  };
  const { tg, scheduler } = build({ seed });

  assert.equal((await scheduler.tick()).due, 0);
  assert.equal(tg.polls.length, 0);
});

// --- DRY_RUN --------------------------------------------------------------

test('scheduler: under DRY_RUN the items go to the owner and no sent_log row is written', async () => {
  const { db, tg, scheduler } = build({ config: { ...CONFIG, dryRun: true } });

  const run = await scheduler.tick();

  assert.equal(run.results[0].status, 'dry_run');
  assert.equal(tg.polls.length, 1);
  assert.equal(tg.polls[0].chatId, OWNER, 'a dry run must never touch the channel');

  assert.equal(db.sentLog.length, 0, 'a dry run leaves no trace');
  assert.equal(db.schedules.get(1).last_run_date, '2026-10-18', 'but the slot is still spent');

  const dms = dmsToOwner(tg);
  assert.ok(dms.some((text) => /Dry run/.test(text)), 'the owner gets a summary');
});

test('scheduler: a dry run with no owner configured sends nothing at all', async () => {
  const { db, tg, log, scheduler } = build({ config: { ...CONFIG, dryRun: true, ownerTgId: null } });

  const run = await scheduler.tick();

  assert.equal(run.results[0].status, 'dry_run_no_owner');
  assert.equal(tg.polls.length, 0);
  assert.equal(tg.sent.length, 0);
  assert.equal(db.schedules.get(1).last_run_date, '2026-10-18', 'the slot is marked so it cannot loop');
  assert.ok(log.lines.some((line) => line.msg === 'schedule_dryrun_no_owner'));
});

// --- failure handling -----------------------------------------------------

test('scheduler: an empty pool marks the slot and tells the owner', async () => {
  const { db, tg, scheduler } = build({ questions: [] });

  const run = await scheduler.tick();

  assert.equal(run.results[0].status, 'empty');
  assert.equal(db.schedules.get(1).last_run_date, '2026-10-18');
  assert.ok(dmsToOwner(tg).some((text) => /no eligible questions/.test(text)));
});

test('scheduler: a selection failure retries, then gives up and reports', async () => {
  let boom = true;
  const { db, tg, log, scheduler } = build({
    questions: () => {
      if (boom) throw new Error('database exploded');
      return [questionRow({ id: 'q1' })];
    }
  });

  const first = await scheduler.tick();
  assert.equal(first.results[0].status, 'retry');
  assert.equal(first.results[0].attempts, 1);
  assert.equal(db.schedules.get(1).last_run_date, null, 'a transient failure does not burn the day');

  const second = await scheduler.tick();
  assert.equal(second.results[0].status, 'retry');

  const third = await scheduler.tick();
  assert.equal(third.results[0].status, 'failed', 'three strikes');
  assert.equal(db.schedules.get(1).last_run_date, '2026-10-18', 'and now the day is burnt');
  assert.ok(dmsToOwner(tg).some((text) => /failed/.test(text)));
  assert.ok(log.lines.some((line) => line.msg === 'schedule_select_failed'));
});

test('scheduler: a recovery inside the window still posts', async () => {
  let boom = true;
  const { db, tg, scheduler } = build({
    questions: () => {
      if (boom) throw new Error('database exploded');
      return [questionRow({ id: 'q1' })];
    }
  });

  await scheduler.tick();
  boom = false;
  const recovered = await scheduler.tick();

  assert.equal(recovered.results[0].status, 'sent');
  assert.equal(tg.polls.length, 1);
  assert.equal(db.schedules.get(1).last_run_date, '2026-10-18');
});

test('scheduler: a failed send is reported and stays retryable on a later day', async () => {
  const { db, tg, scheduler } = build({
    tgBehavior: {
      sendPoll: async () => {
        throw new Error('telegram said no');
      }
    }
  });

  const run = await scheduler.tick();

  assert.equal(run.results[0].status, 'sent', 'the tick itself completes');
  assert.equal(run.results[0].sent, 0);
  assert.equal(run.results[0].failed, 1);

  assert.equal(db.schedules.get(1).last_run_date, '2026-10-18', 'the slot is spent, so no flood');
  assert.equal(db.sentLog.length, 1);
  assert.equal(db.sentLog[0].status, 'failed', 'a failure is logged as retryable, not as delivered');

  const dms = dmsToOwner(tg);
  assert.ok(dms.some((text) => /Scheduled run/.test(text) && /failed/.test(text)));
});

test('scheduler: a recycled pool is surfaced to the owner', async () => {
  const db = createFakeDb(SEED);
  const tg = createFakeTg();
  const log = createTestLogger();
  const messages = createMessages('en');
  const selector = createFakeSelector([questionRow({ id: 'q1' })], { recycled: { rajasthan_polity: 1 } });
  const dispatcher = createDispatcher({ db, tg, messages, log });
  const schedules = createScheduleStore({ db, log });
  const scheduler = createScheduler({
    tg,
    selector,
    dispatcher,
    schedules,
    messages,
    config: CONFIG,
    log,
    now: () => DUE_NOW
  });

  await scheduler.tick();

  const dms = dmsToOwner(tg);
  assert.ok(dms.some((text) => /ran out/.test(text)));
  assert.ok(dms.some((text) => /Rajasthan Polity/.test(text)));
});

// --- tick plumbing --------------------------------------------------------

test('scheduler: an overlapping tick is skipped rather than run twice', async () => {
  const { tg, log, scheduler } = build();

  const first = scheduler.tick();
  const second = await scheduler.tick();
  assert.equal(second.skipped, true, 'the in-flight guard holds');
  assert.ok(log.lines.some((line) => line.msg === 'scheduler_busy'));

  await first;
  assert.equal(tg.polls.length, 1, 'and only one batch was ever posted');
});

test('scheduler: start registers a timer, ticks immediately, and stop is idempotent', async () => {
  const intervals = [];
  const cleared = [];
  const db = createFakeDb(SEED);
  const tg = createFakeTg();
  const log = createTestLogger();
  const messages = createMessages('en');
  const selector = createFakeSelector([questionRow({ id: 'q1' })]);
  const dispatcher = createDispatcher({ db, tg, messages, log });
  const schedules = createScheduleStore({ db, log });
  const scheduler = createScheduler({
    tg,
    selector,
    dispatcher,
    schedules,
    messages,
    config: CONFIG,
    log,
    now: () => DUE_NOW,
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms });
      return { unref() {}, id: intervals.length };
    },
    clearIntervalFn: (timer) => cleared.push(timer.id)
  });

  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false, 'starting twice is a no-op');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 60_000);

  // The immediate tick is fired without awaiting; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tg.polls.length, 1);
  assert.equal(db.schedules.get(1).last_run_date, '2026-10-18');
  assert.ok(log.lines.some((line) => line.msg === 'scheduler_started'));

  assert.equal(scheduler.stop(), true);
  assert.deepEqual(cleared, [1]);
  assert.equal(scheduler.stop(), false);
});

test('scheduler: SCHEDULER_ENABLED=false parks the engine without touching rows', async () => {
  const db = createFakeDb(SEED);
  const tg = createFakeTg();
  const log = createTestLogger();
  const messages = createMessages('en');
  const selector = createFakeSelector([questionRow({ id: 'q1' })]);
  const dispatcher = createDispatcher({ db, tg, messages, log });
  const schedules = createScheduleStore({ db, log });
  const scheduler = createScheduler({
    tg,
    selector,
    dispatcher,
    schedules,
    messages,
    config: { ...CONFIG, schedulerEnabled: false },
    log,
    now: () => DUE_NOW,
    setIntervalFn: () => {
      throw new Error('a disabled scheduler must not register a timer');
    }
  });

  assert.equal(scheduler.start(), false);
  assert.equal(tg.polls.length, 0);
  assert.equal(db.schedules.get(1).last_run_date, null);
  assert.ok(log.lines.some((line) => line.msg === 'scheduler_disabled'));
});

test('scheduler: required collaborators are enforced at construction', () => {
  assert.throws(() => createScheduler({}), /telegram client is required/);
  assert.throws(
    () => createScheduler({ tg: {}, selector: {}, dispatcher: {} }),
    /schedule store is required/
  );
});

test('scheduler: a schedule with a subject filter passes the quota through', async () => {
  const seed = {
    ...SEED,
    schedules: [
      {
        ...SEED.schedules[0],
        subject_filter_json: JSON.stringify({ rajasthan_polity: 3 })
      }
    ]
  };
  const { selector, scheduler } = build({ seed });

  await scheduler.tick();

  assert.deepEqual(selector.calls[0].subjects, { rajasthan_polity: 3 });
});

test('scheduler: a corrupt subject filter is ignored instead of crashing the tick', async () => {
  const seed = {
    ...SEED,
    schedules: [{ ...SEED.schedules[0], subject_filter_json: '{not json' }]
  };
  const { selector, tg, scheduler } = build({ seed });

  const run = await scheduler.tick();

  assert.equal(run.results[0].status, 'sent');
  assert.equal(selector.calls[0].subjects, undefined);
  assert.equal(tg.polls.length, 1);
});
