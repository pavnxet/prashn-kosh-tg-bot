'use strict';

/**
 * Tests for the message catalogue.
 *
 * The point of this file is the validator: Telegram rejects an entire message
 * with `400 can't parse entities` when its markup is unbalanced, so every string
 * we can produce is checked against Telegram's HTML rules. That is exactly the
 * bug that shipped — `/help` contained `<chat_id>`, which HTML mode reads as a
 * tag and Markdown mode read as an underscore-laden italic run.
 *
 * `t()` escapes all interpolated values, so hostile data (a channel titled
 * `My_Channel*<b>`) must come out inert.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMessages,
  format,
  escapeHtml,
  STRINGS,
  LANGUAGES,
  DEFAULT_LANG,
  PARSE_MODE
} = require('../lib/messages');
const { assertTelegramHtml } = require('./support/html');

const SAMPLE_VARS = Object.freeze({
  userId: 123456789,
  chatId: '-1001234567890',
  username: 'test_bot',
  phase: 'phase-2-telegram',
  dryRun: 'true',
  timezone: 'Asia/Kolkata',
  dbHost: 'example.turso.io',
  ownerSet: 'no',
  channels: '0',
  admins: '1',
  title: 'Daily Quiz',
  reason: 'ok',
  error: 'boom',
  marker: '✅',
  tz: 'Asia/Kolkata',
  state: 'paused'
});

test('messages: parse mode is HTML, so there is no Markdown underscore hazard', () => {
  assert.equal(PARSE_MODE, 'HTML');
});

test('messages: every string in every language is valid Telegram HTML', () => {
  for (const lang of LANGUAGES) {
    const m = createMessages(lang);
    for (const key of Object.keys(STRINGS[lang])) {
      assertTelegramHtml(m.t(key, SAMPLE_VARS), `${lang}.${key}`);
    }
  }
});

test('messages: english and hindi define exactly the same keys', () => {
  const en = Object.keys(STRINGS.en).sort();
  for (const lang of LANGUAGES) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), en, `${lang} key set differs from en`);
  }
});

test('messages: an unknown key is reported, not silently empty', () => {
  assert.equal(createMessages('en').t('nope_not_here'), '{missing:nope_not_here}');
});

test('messages: an unknown language falls back to english', () => {
  assert.equal(createMessages('fr').lang, DEFAULT_LANG);
  assert.equal(createMessages(undefined).lang, DEFAULT_LANG);
});

test('messages: interpolated values are escaped, so data cannot inject markup', () => {
  const m = createMessages('en');
  const hostile = 'My_Channel*<b>bold</b>& <script>';

  const rendered = m.t('connect_ok', { title: hostile, chatId: '-100123', reason: 'ok' });
  assert.ok(rendered.includes('My_Channel*&lt;b&gt;bold&lt;/b&gt;&amp; &lt;script&gt;'),
    `value was not escaped: ${rendered}`);
  assert.ok(!rendered.includes('<b>bold</b>'), 'raw markup from data survived');
  assertTelegramHtml(rendered, 'connect_ok/hostile');

  // The placeholder itself is not escaped away.
  assert.ok(rendered.includes('<b>My_Channel*'), 'the template tag must survive');
});

test('messages: escapeHtml handles & before < and >', () => {
  assert.equal(escapeHtml('&<'), '&amp;&lt;');
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
  assert.equal(escapeHtml('plain'), 'plain');
  assert.equal(escapeHtml(0), '0');
});

test('messages: format leaves unknown placeholders untouched and does not escape templates', () => {
  assert.equal(format('a {x} b', { x: 1 }), 'a 1 b');
  assert.equal(format('a {y} b', { x: 1 }), 'a {y} b');
  assert.equal(format('no vars'), 'no vars');
  assert.equal(format('<b>{x}</b>', { x: '<i>' }), '<b>&lt;i&gt;</b>');
  assert.equal(format('<b>{x}</b>', { x: '<i>' }, { escape: false }), '<b><i></b>');
});

test('messages: regression — /help has no bare angle brackets (the shipped bug)', () => {
  for (const lang of LANGUAGES) {
    const help = createMessages(lang).t('help');
    assert.ok(!/<chat_id>/.test(help), `${lang} help still contains a raw <chat_id> tag`);
    assert.ok(help.includes('&lt;chat_id&gt;'), `${lang} help should show a literal <chat_id>`);
    assertTelegramHtml(help, `${lang}.help`);
  }
});

test('messages: the /start reply (welcome + help) is valid and fits one message', () => {
  const m = createMessages('en');
  const combined = `${m.t('welcome')}\n\n${m.t('help')}`;
  assert.ok(combined.length < 4096);
  assertTelegramHtml(combined, 'start');
});
