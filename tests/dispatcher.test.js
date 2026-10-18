'use strict';

/**
 * Tests for the dispatcher: rendering, the text fallback, `sent_log` writes and
 * failure handling. No network, no real database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher, runDateFor, trimExplanation, MAX_EXPLANATION } = require('../lib/dispatcher');
const { createMessages } = require('../lib/messages');
const { createFakeDb, createFakeTg, createTestLogger, questionRow } = require('./support/fakes');
const { assertTelegramHtml } = require('./support/html');

const messages = createMessages('en');

function build(tgBehavior = {}) {
  const db = createFakeDb();
  const tg = createFakeTg(tgBehavior);
  const log = createTestLogger();
  const dispatcher = createDispatcher({ db, tg, messages, log });
  return { db, tg, log, dispatcher };
}

/** A sleep that records instead of waiting. */
function recordingSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  return { delays, sleep };
}

// --- runDateFor / trimExplanation ----------------------------------------

test('dispatcher: runDateFor formats a date, and survives a bad timezone', () => {
  const date = new Date('2026-10-18T20:30:00Z');
  assert.equal(runDateFor('Asia/Kolkata', date), '2026-10-19', 'IST is ahead of UTC');
  assert.equal(runDateFor('UTC', date), '2026-10-18');
  assert.match(runDateFor('Not/AZone', date), /^\d{4}-\d{2}-\d{2}$/, 'falls back instead of throwing');
});

test('dispatcher: trimExplanation enforces the 200-character poll cap', () => {
  assert.equal(trimExplanation(null), null);
  assert.equal(trimExplanation('   '), null);
  assert.equal(trimExplanation(' short '), 'short');

  const long = 'क'.repeat(MAX_EXPLANATION + 50);
  const trimmed = trimExplanation(long);
  assert.equal(trimmed.length, MAX_EXPLANATION);
  assert.equal(trimmed.endsWith('…'), true);
});

// --- renderItem -----------------------------------------------------------

test('dispatcher: renderItem builds a quiz poll with a 0-based answer index', () => {
  const { dispatcher } = build();
  const item = dispatcher.renderItem(questionRow({ correct_option: 'C' }), {
    subjectNames: { rajasthan_polity: 'Rajasthan Polity' }
  });

  assert.equal(item.mode, 'poll');
  assert.equal(item.subject, 'Rajasthan Polity');
  assert.equal(item.payload.question, 'राजस्थान का सबसे बड़ा जिला कौन-सा है?');
  assert.equal(item.payload.options.length, 4);
  assert.equal(item.payload.extra.type, 'quiz');
  assert.equal(item.payload.extra.correct_option_id, 2, 'C is index 2');
  assert.equal(item.payload.extra.is_anonymous, true);
});

test('dispatcher: renderItem caps the explanation it passes to Telegram', () => {
  const { dispatcher } = build();
  const item = dispatcher.renderItem(questionRow({ explanation: 'x'.repeat(500) }));

  assert.equal(item.payload.extra.explanation.length, MAX_EXPLANATION);
});

test('dispatcher: renderItem omits an empty explanation rather than sending a blank field', () => {
  const { dispatcher } = build();
  const item = dispatcher.renderItem(questionRow({ explanation: null }));

  assert.equal('explanation' in item.payload.extra, false);
});

test('dispatcher: a question that cannot be a poll falls back to two text messages', () => {
  const { dispatcher } = build();
  const item = dispatcher.renderItem(questionRow({ question_text: 'क'.repeat(400), correct_option: 'B' }));

  assert.equal(item.mode, 'text');
  assert.equal(item.messages.length, 2, 'one message for the stem, one for the options');
  assert.match(item.messages[0], /क{5}/, 'the stem leads the first message');
  assert.match(item.messages[1], /Answer:/, 'the answer rides with the options');
  assert.match(item.messages[1], /बाड़मेर/, 'the answer text, not just the letter');
  item.messages.forEach((html) => assertTelegramHtml(html, 'dispatcher:text fallback'));
});

test('dispatcher: the text fallback escapes hostile question content', () => {
  const { dispatcher } = build();
  const item = dispatcher.renderItem(
    questionRow({ question_text: 'Long <b>bold</b> & <script> stem '.padEnd(400, 'x') })
  );

  assert.equal(item.messages.length, 2);
  item.messages.forEach((html) => assertTelegramHtml(html, 'dispatcher:hostile stem'));
  const joined = item.messages.join('\n');
  assert.ok(!joined.includes('<script>'), 'raw tag must not survive');
  assert.ok(joined.includes('&lt;script&gt;'), 'it must be escaped instead');
});

test('dispatcher: type "text" forces the two-message form even for a pollable row', () => {
  const { dispatcher } = build();
  const item = dispatcher.renderItem(questionRow(), { type: 'text' });

  assert.equal(item.mode, 'text');
  assert.equal(item.payload, undefined);
  assert.equal(item.messages.length, 2);
});

test('dispatcher: renderText tolerates an unusable options field', () => {
  const { dispatcher } = build();
  const html = dispatcher.renderText(questionRow({ options_json: 'not json' }), 'X');
  assertTelegramHtml(html, 'dispatcher:no options');
  assert.match(html, /Answer:/);
});

// --- sendItems ------------------------------------------------------------

test('dispatcher: sendItems posts polls, gaps them, and logs each as sent', async () => {
  const { dispatcher, tg, db } = build();
  const { delays, sleep } = recordingSleep();
  const questions = [questionRow({ id: 'q1' }), questionRow({ id: 'q2' }), questionRow({ id: 'q3' })];

  const outcome = await dispatcher.sendItems({
    chatId: '-100123',
    channelId: 7,
    record: true,
    questions,
    gapSeconds: 4,
    runDate: '2026-10-18',
    sleep
  });

  assert.equal(outcome.sent, 3);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.mode, 'poll');
  assert.equal(tg.polls.length, 3);
  assert.equal(tg.polls[0].chatId, '-100123');
  assert.deepEqual(delays, [4000, 4000], 'a gap between sends, none before the first');

  assert.equal(db.sentLog.length, 3);
  assert.deepEqual(db.sentLog.map((row) => row.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(db.sentLog.map((row) => row.question_id), ['q1', 'q2', 'q3']);
  assert.deepEqual(db.sentLog.map((row) => row.run_date), ['2026-10-18', '2026-10-18', '2026-10-18']);
  assert.deepEqual(db.sentLog.map((row) => row.channel_id), [7, 7, 7]);
});

test('dispatcher: sendItems with record false sends but writes nothing (preview)', async () => {
  const { dispatcher, tg, db } = build();

  const outcome = await dispatcher.sendItems({
    chatId: 555,
    questions: [questionRow()],
    record: false,
    sleep: async () => {}
  });

  assert.equal(outcome.sent, 1);
  assert.equal(tg.polls.length, 1, 'the preview is a real send to the caller');
  assert.equal(db.sentLog.length, 0, 'a preview must never mark a question as sent');
});

test('dispatcher: a text item sends two messages, gaps them, and logs once', async () => {
  const { dispatcher, tg, db } = build();
  const { delays, sleep } = recordingSleep();

  const outcome = await dispatcher.sendItems({
    chatId: '-100123',
    channelId: 7,
    record: true,
    questions: [questionRow({ id: 'txt', question_type: 'statements' })],
    gapSeconds: 3,
    runDate: '2026-10-18',
    sleep
  });

  assert.equal(outcome.sent, 1);
  assert.equal(outcome.mode, 'text');
  assert.equal(tg.sent.length, 2, 'stem + options');
  assert.equal(tg.polls.length, 0, 'a non-mcq row is never sent as a poll');
  assert.deepEqual(delays, [3000], 'a gap between the two messages of one question');
  assert.equal(db.sentLog.length, 1, 'sent_log records the question once, not once per message');
  assert.equal(db.sentLog[0].question_id, 'txt');
  assert.equal(db.sentLog[0].status, 'sent');
});

test('dispatcher: a failed send is logged as failed, not as sent, and the batch continues', async () => {
  let calls = 0;
  const { dispatcher, db } = build({
    sendPoll: async () => {
      calls += 1;
      if (calls === 1) throw new Error('400 Bad Request: chat not found');
      return { message_id: 42 };
    }
  });

  const outcome = await dispatcher.sendItems({
    chatId: '-100123',
    channelId: 7,
    record: true,
    questions: [questionRow({ id: 'q1' }), questionRow({ id: 'q2' })],
    gapSeconds: 0,
    sleep: async () => {}
  });

  assert.equal(outcome.sent, 1);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.results[0].status, 'failed');
  assert.match(outcome.results[0].error, /chat not found/);

  assert.equal(db.sentLog.length, 2);
  const [first, second] = db.sentLog;
  assert.equal(first.status, 'failed', 'a failure must not look like a delivery');
  assert.match(String(first.error), /chat not found/);
  assert.equal(second.status, 'sent');
});

test('dispatcher: an empty batch is a no-op', async () => {
  const { dispatcher, tg, db } = build();
  const outcome = await dispatcher.sendItems({ chatId: 1, questions: [], sleep: async () => {} });

  assert.deepEqual(outcome, { results: [], sent: 0, failed: 0, mode: 'none' });
  assert.equal(tg.polls.length, 0);
  assert.equal(db.sentLog.length, 0);
});

test('dispatcher: a mixed batch reports mode "mixed"', async () => {
  const { dispatcher } = build();
  const outcome = await dispatcher.sendItems({
    chatId: 1,
    questions: [questionRow({ id: 'ok' }), questionRow({ id: 'long', question_text: 'x'.repeat(400) })],
    gapSeconds: 0,
    sleep: async () => {}
  });

  assert.equal(outcome.mode, 'mixed');
  assert.deepEqual(outcome.results.map((r) => r.mode), ['poll', 'text']);
});

test('dispatcher: required collaborators are enforced', () => {
  assert.throws(() => createDispatcher({ tg: createFakeTg(), messages }), /dispatcher: db is required/);
  assert.throws(() => createDispatcher({ db: createFakeDb(), messages }), /dispatcher: telegram client is required/);
  assert.throws(() => createDispatcher({ db: createFakeDb(), tg: createFakeTg() }), /dispatcher: messages is required/);
});
