'use strict';

/**
 * Tests for the question selector: poll conversion, quota allocation and the
 * fill/recycle behaviour, with no network and no real database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSelector,
  parseOptions,
  correctOptionIndex,
  toPoll,
  allocateProportional,
  allocateExplicit,
  interleave,
  POLL_CAPS
} = require('../lib/selector');
const { questionRow } = require('./support/fakes');

/** A row that is deliberately too long to be a poll. */
const longStem = (overrides = {}) =>
  questionRow({ question_text: 'क'.repeat(POLL_CAPS.question + 1), ...overrides });

// --- parseOptions ---------------------------------------------------------

test('selector: parseOptions reads the canonical key/text shape', () => {
  const options = parseOptions(
    JSON.stringify([
      { key: 'A', text: 'one' },
      { key: 'B', text: 'two' }
    ])
  );
  assert.deepEqual(options, [
    { key: 'A', text: 'one' },
    { key: 'B', text: 'two' }
  ]);
});

test('selector: parseOptions tolerates a plain string array and rejects junk', () => {
  assert.deepEqual(parseOptions('["alpha","beta"]'), [
    { key: null, text: 'alpha' },
    { key: null, text: 'beta' }
  ]);

  for (const bad of [null, '', 'not json', '{"a":1}', '[1,2]', '[]']) {
    assert.deepEqual(parseOptions(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

// --- correctOptionIndex ---------------------------------------------------

test('selector: correctOptionIndex resolves keys, letters and digits', () => {
  const options = parseOptions(JSON.stringify([
    { key: 'A', text: 'one' },
    { key: 'B', text: 'two' },
    { key: 'C', text: 'three' }
  ]));

  assert.equal(correctOptionIndex(options, 'B'), 1, 'by stored key');
  assert.equal(correctOptionIndex(options, ' b '), 1, 'trimmed and case-insensitive');
  assert.equal(correctOptionIndex([{ key: null, text: 'one' }, { key: null, text: 'two' }], 'B'), 1, 'letter onto position');
  assert.equal(correctOptionIndex(options, '2'), 2, 'bare digit is an index');
  assert.equal(correctOptionIndex(options, 'Z'), -1, 'unresolvable');
  assert.equal(correctOptionIndex(options, null), -1);
  assert.equal(correctOptionIndex(options, 'E'), -1, 'letter past the last option');
});

// --- toPoll ---------------------------------------------------------------

test('selector: toPoll converts a good row into a quiz payload', () => {
  const poll = toPoll(questionRow());
  assert.equal(poll.question, 'राजस्थान का सबसे बड़ा जिला कौन-सा है?');
  assert.deepEqual(poll.options, ['जैसलमेर', 'बाड़मेर', 'जयपुर', 'उदयपुर']);
  assert.equal(poll.correctOptionId, 0);
});

test('selector: toPoll refuses everything Telegram would refuse', () => {
  assert.equal(toPoll(null), null, 'no row');
  assert.equal(toPoll(longStem()), null, 'stem over 300 chars');
  assert.equal(toPoll(questionRow({ question_text: '   ' })), null, 'blank stem');
  assert.equal(toPoll(questionRow({ options_json: '[]' })), null, 'no options');
  assert.equal(toPoll(questionRow({ options_json: 'nonsense' })), null, 'unparseable options');
  assert.equal(
    toPoll(questionRow({ options_json: JSON.stringify([{ key: 'A', text: 'only' }]) })),
    null,
    'a single option is not a quiz'
  );
  assert.equal(
    toPoll(questionRow({ options_json: JSON.stringify([{ key: 'A', text: 'x'.repeat(POLL_CAPS.option + 1) }]) })),
    null,
    'option text over 100 chars'
  );
  assert.equal(toPoll(questionRow({ correct_option: 'Z' })), null, 'unresolvable answer');
  assert.equal(toPoll(questionRow({ correct_option: null })), null, 'missing answer');
  assert.equal(
    toPoll(
      questionRow({
        options_json: JSON.stringify([
          { key: 'A', text: 'same' },
          { key: 'B', text: 'same' }
        ])
      })
    ),
    null,
    'duplicate option texts'
  );
});

test('selector: toPoll drops surrounding whitespace rather than sending it', () => {
  const poll = toPoll(questionRow({ question_text: '  padded  ' }));
  assert.equal(poll.question, 'padded');
});

test('selector: toPoll refuses a non-mcq row even when it would fit a poll (ADR-009)', () => {
  for (const question_type of ['match', 'statements', 'assertion_reason']) {
    assert.equal(
      toPoll(questionRow({ question_type })),
      null,
      `${question_type} must use the two-message text form`
    );
  }
  assert.notEqual(toPoll(questionRow({ question_type: 'mcq' })), null, 'a plain mcq still polls');
});

test('selector: selectQuestions with pollableOnly:false keeps non-pollable rows for the text form', async () => {
  const questions = [
    questionRow({ id: 'text_match', subject_id: 'a', question_type: 'match' }),
    longStem({ id: 'text_long', subject_id: 'a' }),
    questionRow({ id: 'poll_1', subject_id: 'a' })
  ];
  const selector = createSelector({ db: fakeSelectorDb({ questions }) });

  const pollOnly = await selector.selectQuestions({ channelId: 1, count: 3 });
  assert.deepEqual(pollOnly.questions.map((q) => q.id), ['poll_1'], 'pollable-only still skips them');

  const withText = await selector.selectQuestions({ channelId: 1, count: 3, pollableOnly: false });
  assert.deepEqual(
    withText.questions.map((q) => q.id).sort(),
    ['poll_1', 'text_long', 'text_match'],
    'nothing renderable is dropped when text is allowed'
  );
});

// --- allocation -----------------------------------------------------------

test('selector: allocateProportional spreads slots by supply and sums exactly', () => {
  assert.deepEqual(allocateProportional({ a: 10, b: 2 }, 6), { a: 5, b: 1 });
  assert.deepEqual(allocateProportional({ a: 10, b: 2 }, 10), { a: 8, b: 2 });
  assert.deepEqual(allocateProportional({ a: 3, b: 3 }, 5), { a: 3, b: 2 });
});

test('selector: allocateProportional handles empty and oversized requests', () => {
  assert.deepEqual(allocateProportional({}, 5), {});
  assert.deepEqual(allocateProportional({ a: 0 }, 5), {});
  assert.deepEqual(allocateProportional({ a: 2, b: 1 }, 0), {});
  assert.deepEqual(allocateProportional({ a: 2 }, 99), { a: 2 }, 'never asks for more than exists');
});

test('selector: allocateExplicit honours quotas, scales down, and skips dry subjects', () => {
  assert.deepEqual(allocateExplicit({ a: 1, b: 2 }, 5, { a: 50, b: 50 }), { a: 1, b: 2 });
  assert.deepEqual(allocateExplicit({ a: 5, b: 5 }, 3, { a: 50, b: 50 }), { a: 2, b: 1 });
  assert.deepEqual(allocateExplicit({ a: 3, b: 3 }, 5, { a: 0, b: 50 }), { b: 3 });
  assert.deepEqual(allocateExplicit({ a: -1, b: 'x' }, 5, {}), {});
  assert.deepEqual(allocateExplicit(null, 5, {}), {});
});

test('selector: interleave round-robins the per-subject groups', () => {
  assert.deepEqual(interleave([['a1', 'a2', 'a3'], ['b1']]), ['a1', 'b1', 'a2', 'a3']);
  assert.deepEqual(interleave([]), []);
  assert.deepEqual(interleave([[], ['x']]), ['x']);
});

// --- selectQuestions (fake DB) -------------------------------------------

/**
 * A database stand-in that answers exactly the three queries the selector
 * issues, so `selectQuestions` can be exercised without Turso.
 */
function fakeSelectorDb({ questions, sentByChannel = {} }) {
  const sent = new Map(
    Object.entries(sentByChannel).map(([channelId, ids]) => [Number(channelId), new Set(ids)])
  );
  const sentSet = (channelId) => sent.get(Number(channelId)) || new Set();

  /** Questions in the channel's fresh (`sentOnly === false`) or used pool. */
  const pool = (channelId, sentOnly) =>
    questions.filter((q) => sentOnly === sentSet(channelId).has(q.id));

  return {
    all: async (sql, args) => {
      if (sql.includes('GROUP BY q.subject_id')) {
        const stats = {};
        for (const q of questions) {
          const entry = (stats[q.subject_id] = stats[q.subject_id] || { subject_id: q.subject_id, n: 0, unsent: 0 });
          entry.n += 1;
          if (!sentSet(args[0]).has(q.id)) entry.unsent += 1;
        }
        return Object.values(stats);
      }
      if (sql.includes('MAX(s2.sent_at)')) {
        const [channelId, subjectId, , limit] = args;
        return pool(channelId, true).filter((q) => q.subject_id === subjectId).slice(0, limit);
      }
      const [channelId, subjectId, limit] = args;
      return pool(channelId, false).filter((q) => q.subject_id === subjectId).slice(0, limit);
    }
  };
}

/** `n` pollable rows for one subject. */
function rowsFor(subject, n, prefix = subject) {
  return Array.from({ length: n }, (_, i) => questionRow({ id: `${prefix}_${i}`, subject_id: subject }));
}

test('selector: selectQuestions fills a per-subject quota proportionally', async () => {
  const db = fakeSelectorDb({ questions: [...rowsFor('a', 10), ...rowsFor('b', 2)] });
  const selector = createSelector({ db });

  const result = await selector.selectQuestions({ channelId: 1, count: 6 });

  assert.equal(result.questions.length, 6);
  assert.equal(result.bySubject.a, 5);
  assert.equal(result.bySubject.b, 1);
  assert.deepEqual(result.available, { a: 10, b: 2 });
  assert.deepEqual(result.recycled, {});
  assert.equal(result.shortfall, 0);
});

test('selector: selectQuestions skips rows that cannot become polls, and over-fetches to compensate', async () => {
  const questions = [
    questionRow({ id: 'bad_1', subject_id: 'a', correct_option: 'Z' }),
    longStem({ id: 'bad_2', subject_id: 'a' }),
    questionRow({ id: 'ok_1', subject_id: 'a' }),
    questionRow({ id: 'ok_2', subject_id: 'a' })
  ];
  const selector = createSelector({ db: fakeSelectorDb({ questions }) });

  const result = await selector.selectQuestions({ channelId: 1, count: 2 });

  assert.equal(result.questions.length, 2, 'the two unusable rows must not block the quota');
  assert.deepEqual(result.questions.map((q) => q.id).sort(), ['ok_1', 'ok_2']);
});

test('selector: selectQuestions respects an explicit subject filter', async () => {
  const db = fakeSelectorDb({ questions: [...rowsFor('a', 5), ...rowsFor('b', 5)] });
  const selector = createSelector({ db });

  const result = await selector.selectQuestions({ channelId: 1, count: 5, subjects: { b: 2 } });

  assert.equal(result.questions.length, 2);
  assert.equal(result.bySubject.b, 2);
});

test('selector: an exhausted pool is reused oldest-first and reported', async () => {
  const all = [...rowsFor('a', 4), ...rowsFor('b', 4)];
  const db = fakeSelectorDb({
    questions: all,
    sentByChannel: { 1: all.map((q) => q.id) }
  });
  const selector = createSelector({ db });

  const result = await selector.selectQuestions({ channelId: 1, count: 3 });

  assert.equal(result.questions.length, 3);
  assert.deepEqual(result.unsent, { a: 0, b: 0 }, 'nothing is unsent');
  assert.deepEqual(result.available, { a: 4, b: 4 }, 'quota is drawn from the whole pool, not just the fresh part');
  assert.equal(Object.keys(result.recycled).length > 0, true, 'the recycle must be reported');
  assert.equal(
    Object.values(result.recycled).reduce((sum, n) => sum + n, 0),
    3,
    'every returned question is a recycled one'
  );
});

test('selector: recycling is refused when allowRecycle is false', async () => {
  const all = rowsFor('a', 3);
  const db = fakeSelectorDb({ questions: all, sentByChannel: { 1: all.map((q) => q.id) } });
  const selector = createSelector({ db });

  const result = await selector.selectQuestions({ channelId: 1, count: 2, allowRecycle: false });

  assert.deepEqual(result.questions, []);
  assert.equal(result.shortfall, 2);
  assert.deepEqual(result.recycled, {});
});

test('selector: sent history is per channel', async () => {
  const all = rowsFor('a', 3);
  const db = fakeSelectorDb({ questions: all, sentByChannel: { 1: all.map((q) => q.id) } });
  const selector = createSelector({ db });

  const other = await selector.selectQuestions({ channelId: 2, count: 3, allowRecycle: false });
  assert.equal(other.questions.length, 3, 'a different channel still sees everything as unsent');
});

test('selector: count 0 and an empty table are handled without queries blowing up', async () => {
  const selector = createSelector({ db: fakeSelectorDb({ questions: [] }) });

  assert.deepEqual((await selector.selectQuestions({ channelId: 1, count: 0 })).questions, []);
  assert.deepEqual((await selector.selectQuestions({ channelId: 1, count: 5 })).questions, []);
});

test('selector: selectQuestions requires a database', () => {
  assert.throws(() => createSelector({}), /selector: db is required/);
});
