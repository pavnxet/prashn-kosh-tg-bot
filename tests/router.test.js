'use strict';

/**
 * Tests for the command router: parsing, gating, replies and audit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouter, parseCommand } = require('../lib/router');
const { createAuth } = require('../lib/admin');
const { createChannelStore } = require('../lib/channels');
const { createDispatcher } = require('../lib/dispatcher');
const { createScheduleStore } = require('../lib/schedules');
const { createMessages } = require('../lib/messages');
const {
  createFakeDb,
  createFakeTg,
  createFakeSelector,
  createTestLogger,
  messageUpdate,
  questionRow
} = require('./support/fakes');
const { assertTelegramHtml } = require('./support/html');

const CONFIG = Object.freeze({
  ownerTgId: 555,
  dryRun: true,
  defaultTz: 'Asia/Kolkata',
  dbHttpHost: 'example.turso.io'
});
const LIVE_CONFIG = Object.freeze({ ...CONFIG, dryRun: false });
const BOT_INFO = Object.freeze({ id: 999, username: 'test_bot' });
const CHAT = '-1001234567890';

function build(tgBehavior = {}, seed = {}, config = CONFIG, selection = []) {
  const db = createFakeDb(seed);
  const tg = createFakeTg(tgBehavior);
  const log = createTestLogger();
  const auth = createAuth({ db, config, log });
  const channels = createChannelStore({ db, tg, log });
  const selector = createFakeSelector(selection);
  const dispatcher = createDispatcher({ db, tg, messages: createMessages('en'), log });
  const schedules = createScheduleStore({ db, log });
  const router = createRouter({ tg, auth, channels, selector, dispatcher, schedules, config, botInfo: BOT_INFO, log });
  return { db, tg, log, auth, channels, selector, dispatcher, schedules, router };
}

const lastText = (tg) => tg.sent[tg.sent.length - 1].text;

test('router: parseCommand handles bots, casing and arguments', () => {
  assert.deepEqual(parseCommand('/connect -100123'), { command: 'connect', args: ['-100123'] });
  assert.deepEqual(parseCommand('/connect@test_bot -100123'), { command: 'connect', args: ['-100123'] });
  assert.deepEqual(parseCommand('  /STATUS  '), { command: 'status', args: [] });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand('/'), null);
});

test('router: /start and /id work for a non-admin (so the owner can find their id)', async () => {
  const { router, tg, db } = build();

  await router.handleUpdate(messageUpdate({ text: '/start', userId: 4242, chatId: 4242 }));
  assert.match(lastText(tg), /Prashn-Kosh Bot/);

  await router.handleUpdate(messageUpdate({ text: '/id', userId: 4242, chatId: 4242 }));
  assert.match(lastText(tg), /<code>4242<\/code>/);

  assert.equal(db.audit.length, 0, 'public commands are not audited');
});

test('router: a non-admin is refused on privileged commands, and it is audited', async () => {
  const { router, tg, db } = build();

  await router.handleUpdate(messageUpdate({ text: '/status', userId: 4242, chatId: 4242 }));

  assert.match(lastText(tg), /not authorised/i);
  assert.deepEqual(db.audit.map((r) => r.action), ['access_denied']);
});

test('router: privileged replies go to the caller privates chat, never the group', async () => {
  const { router, tg } = build();

  await router.handleUpdate(messageUpdate({ text: '/status', userId: 555, chatId: -100777 }));

  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].chatId, 555, 'must answer in DM, not in the group');
  assert.match(tg.sent[0].text, /Status/);
});

test('router: /start and /help send valid HTML (the shipped parse-error bug)', async () => {
  const { router, tg } = build();

  await router.handleUpdate(messageUpdate({ text: '/help', userId: 4242, chatId: 4242 }));

  const msg = tg.sent[tg.sent.length - 1];
  assert.equal(msg.extra.parse_mode, 'HTML', 'Markdown is what caused the 400');
  assertTelegramHtml(msg.text, 'router:/help');
  assert.match(msg.text, /&lt;chat_id&gt;/, 'placeholders must be escaped, not raw tags');
});

test('router: a channel title with markup cannot break the reply', async () => {
  const evil = 'My_Channel*<b>Daily</b>&Quiz';
  const { router, tg } = build({ getChat: async (id) => ({ id: Number(id), type: 'channel', title: evil }) });

  await router.handleUpdate(messageUpdate({ text: `/connect ${CHAT}`, userId: 555, chatId: 555 }));

  const msg = tg.sent[tg.sent.length - 1];
  assertTelegramHtml(msg.text, 'router:/connect hostile title');
  assert.ok(msg.text.includes('&lt;b&gt;Daily&lt;/b&gt;&amp;Quiz'), `title was not escaped: ${msg.text}`);
});

test('router: /status summarises config and counts', async () => {
  const { router, tg } = build({}, { channels: [{ tg_chat_id: CHAT, title: 'A', is_active: 1, timezone: 'Asia/Kolkata' }] });

  await router.handleUpdate(messageUpdate({ text: '/status', userId: 555, chatId: 555 }));

  const text = lastText(tg);
  assert.match(text, /@test_bot/);
  assert.match(text, /phase-4-scheduler/);
  assert.match(text, /example\.turso\.io/);
  assert.match(text, /Channels: <code>1<\/code>/);
});

test('router: /connect verifies rights, stores the channel and audits it', async () => {
  const { router, tg, db } = build({ getChat: async (id) => ({ id: Number(id), type: 'channel', title: 'Daily Quiz' }) });

  await router.handleUpdate(messageUpdate({ text: `/connect ${CHAT}`, userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /Connected/);
  assert.match(lastText(tg), /Daily Quiz/);
  assert.equal(db.channels.size, 1);
  assert.ok(db.audit.some((r) => r.action === 'channel_connected'));
});

test('router: /connect without an argument shows usage, and a bad id is rejected clearly', async () => {
  const { router, tg, db } = build();

  await router.handleUpdate(messageUpdate({ text: '/connect', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /Usage/);

  await router.handleUpdate(messageUpdate({ text: '/connect @channel', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /not a valid chat id/);

  assert.equal(db.channels.size, 0);
});

test('router: /connect explains how to fix a missing posting right', async () => {
  const { router, tg } = build({ getChatMember: async () => ({ status: 'member' }) });

  await router.handleUpdate(messageUpdate({ text: `/connect ${CHAT}`, userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /administrator with <b>Post messages<\/b>/);
});

test('router: /channels lists connected channels or reports none', async () => {
  const empty = build();
  await empty.router.handleUpdate(messageUpdate({ text: '/channels', userId: 555, chatId: 555 }));
  assert.match(lastText(empty.tg), /No channels connected/);

  const withOne = build({}, { channels: [{ tg_chat_id: CHAT, title: 'Daily Quiz', is_active: 0, timezone: 'Asia/Kolkata' }] });
  await withOne.router.handleUpdate(messageUpdate({ text: '/channels', userId: 555, chatId: 555 }));
  assert.match(lastText(withOne.tg), /Connected channels/);
  assert.match(lastText(withOne.tg), new RegExp(CHAT));
  assert.match(lastText(withOne.tg), /⏸/, 'an inactive channel is marked paused');
});

test('router: /pause and /resume toggle a known channel and reject an unknown one', async () => {
  const seed = { channels: [{ tg_chat_id: CHAT, title: 'A', is_active: 1, timezone: 'Asia/Kolkata' }] };
  const { router, tg, db } = build({}, seed);

  await router.handleUpdate(messageUpdate({ text: `/pause ${CHAT}`, userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /paused/);
  assert.equal(db.channels.get(CHAT).is_active, 0);

  await router.handleUpdate(messageUpdate({ text: `/resume ${CHAT}`, userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /active/);
  assert.equal(db.channels.get(CHAT).is_active, 1);

  await router.handleUpdate(messageUpdate({ text: '/pause -100999999', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /No channel found/);
});

test('router: /admins shows the env owner plus stored admins', async () => {
  const { router, tg } = build({}, { admins: [{ tg_user_id: 777, role: 'editor', added_by: 555 }] });

  await router.handleUpdate(messageUpdate({ text: '/admins', userId: 555, chatId: 555 }));

  const text = lastText(tg);
  assert.match(text, /555.*owner/s);
  assert.match(text, /777.*editor/s);
});

test('router: an unknown command gets a helpful reply', async () => {
  const { router, tg } = build();

  await router.handleUpdate(messageUpdate({ text: '/nonsense', userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /Unknown command/);
});

test('router: a failing command is caught, reported and logged', async () => {
  const broken = build();
  broken.channels.list = async () => {
    throw new Error('database exploded');
  };

  await broken.router.handleUpdate(messageUpdate({ text: '/channels', userId: 555, chatId: 555 }));

  assert.match(lastText(broken.tg), /Something went wrong/);
  assert.ok(broken.log.lines.some((l) => l.msg === 'command_failed'));
});

test('router: callback queries are acknowledged so the UI stops spinning', async () => {
  const { router, tg } = build();

  await router.handleUpdate({ update_id: 5, callback_query: { id: 'cb-1', from: { id: 555 }, data: 'menu:main' } });

  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].callbackQueryId, 'cb-1');
});

test('router: plain chatter is ignored', async () => {
  const { router, tg } = build();
  await router.handleUpdate(messageUpdate({ text: 'hello there', userId: 555, chatId: 555 }));
  assert.equal(tg.sent.length, 0);
});

// --- Phase 3: /preview and /sendnow --------------------------------------

const CHANNEL_SEED = { channels: [{ tg_chat_id: CHAT, title: 'Example Channel', is_active: 1, timezone: 'Asia/Kolkata' }] };

test('router: /preview sends a sample to the admin only and never writes sent_log', async () => {
  const { router, tg, db, selector } = build({}, CHANNEL_SEED, CONFIG, [questionRow({ id: 'p1' })]);

  await router.handleUpdate(messageUpdate({ text: '/preview 1', userId: 555, chatId: 555 }));

  assert.equal(selector.calls.length, 1);
  assert.equal(selector.calls[0].channelId, 1, 'the connected channel supplies the history');
  assert.equal(selector.calls[0].allowRecycle, false, 'a preview must not reach into the recycle pool');

  const header = tg.sent[0];
  assert.equal(header.chatId, 555);
  assert.match(header.text, /Preview/);
  assertTelegramHtml(header.text, 'router:/preview header');

  assert.equal(tg.polls.length, 1, 'the sample is a real poll, sent to the caller');
  assert.equal(tg.polls[0].chatId, 555, 'never the channel');
  assert.equal(db.sentLog.length, 0, 'a preview marks nothing as sent');
});

test('router: /preview reports when nothing eligible exists', async () => {
  const { router, tg } = build({}, CHANNEL_SEED, CONFIG, []);

  await router.handleUpdate(messageUpdate({ text: '/preview', userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /No eligible questions/);
});

test('router: /sendnow without a connected channel explains what to do', async () => {
  const { router, tg, db } = build({}, {}, CONFIG, [questionRow()]);

  await router.handleUpdate(messageUpdate({ text: '/sendnow', userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /No active channel/);
  assert.equal(tg.polls.length, 0);
  assert.equal(db.sentLog.length, 0);
});

test('router: /sendnow under DRY_RUN posts to the admin only and audits the dry run', async () => {
  const { router, tg, db } = build({}, CHANNEL_SEED, CONFIG, [questionRow({ id: 'd1' })]);

  await router.handleUpdate(messageUpdate({ text: '/sendnow 1', userId: 555, chatId: 555 }));

  const banner = tg.sent[0];
  assert.equal(banner.chatId, 555);
  assert.match(banner.text, /Dry run/);
  assert.match(banner.text, /Example Channel/);

  assert.equal(tg.polls.length, 1);
  assert.equal(tg.polls[0].chatId, 555, 'a dry run must not touch the channel');
  assert.equal(db.sentLog.length, 0, 'a dry run leaves no trace');

  const actions = db.audit.map((row) => row.action);
  assert.deepEqual(actions, ['send_now_dry_run']);
  assert.match(db.audit[0].detail, new RegExp(CHAT));
});

test('router: /sendnow posts to the channel when DRY_RUN is false, and logs it', async () => {
  const { router, tg, db } = build({}, CHANNEL_SEED, LIVE_CONFIG, [questionRow({ id: 'live1' })]);

  await router.handleUpdate(messageUpdate({ text: '/sendnow 1', userId: 555, chatId: 555 }));

  assert.equal(tg.polls.length, 1);
  assert.equal(tg.polls[0].chatId, CHAT, 'the real channel');
  assert.equal(tg.polls[0].extra.type, 'quiz');

  assert.equal(db.sentLog.length, 1);
  assert.equal(db.sentLog[0].status, 'sent');
  assert.equal(db.sentLog[0].question_id, 'live1');
  assert.equal(db.sentLog[0].channel_id, 1);
  assert.match(String(db.sentLog[0].run_date), /^\d{4}-\d{2}-\d{2}$/, 'dated in the channel timezone');

  const texts = tg.sent.map((msg) => msg.text);
  assert.ok(texts.some((text) => /^📤/.test(text)), 'a start notice goes to the admin');
  assert.ok(texts.some((text) => /Posted/.test(text)), 'and a completion summary');
  assert.ok(texts.every((text) => text.length > 0));
  texts.forEach((text) => assertTelegramHtml(text, 'router:/sendnow status'));

  assert.deepEqual(db.audit.map((row) => row.action), ['send_now']);
  assert.match(db.audit[0].detail, /sent=1 failed=0/);
});

test('router: /sendnow clamps an absurd count and honours the text flag', async () => {
  const over = build({}, CHANNEL_SEED, CONFIG, []);
  await over.router.handleUpdate(messageUpdate({ text: '/sendnow 100', userId: 555, chatId: 555 }));
  assert.equal(over.selector.calls[0].count, 30, 'capped at the ceiling');
  assert.equal(over.selector.calls[0].pollableOnly, false, 'the default path also accepts non-pollable rows as text');

  const asText = build({}, CHANNEL_SEED, CONFIG, [questionRow()]);
  await asText.router.handleUpdate(messageUpdate({ text: '/sendnow 1 text', userId: 555, chatId: 555 }));
  assert.equal(asText.selector.calls[0].pollableOnly, false, 'text mode accepts non-pollable rows');
});

test('router: /sendnow warns an admin when the fresh pool was recycled', async () => {
  const selectorExtra = { recycled: { rajasthan_polity: 1 } };
  const db = createFakeDb(CHANNEL_SEED);
  const tg = createFakeTg();
  const log = createTestLogger();
  const config = { ...CONFIG, dryRun: false };
  const auth = createAuth({ db, config, log });
  const channels = createChannelStore({ db, tg, log });
  const selector = createFakeSelector([questionRow({ id: 'r1' })], selectorExtra);
  const dispatcher = createDispatcher({ db, tg, messages: createMessages('en'), log });
  const router = createRouter({ tg, auth, channels, selector, dispatcher, config, botInfo: BOT_INFO, log });

  await router.handleUpdate(messageUpdate({ text: '/sendnow 1', userId: 555, chatId: 555 }));

  const texts = tg.sent.map((msg) => msg.text);
  assert.ok(texts.some((text) => /ran out/.test(text)), 'the recycle must be surfaced');
  assert.ok(texts.some((text) => /Rajasthan Polity/.test(text)), 'by subject name');
});

test('router: /sendnow rejects an unknown channel id', async () => {
  const { router, tg } = build({}, CHANNEL_SEED, CONFIG, [questionRow()]);

  await router.handleUpdate(messageUpdate({ text: '/sendnow 1 -100999999999', userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /No channel found/);
  assert.equal(tg.polls.length, 0);
});

test('router: a non-admin cannot send with /sendnow or /preview', async () => {
  const { router, tg } = build({}, CHANNEL_SEED, LIVE_CONFIG, [questionRow()]);

  await router.handleUpdate(messageUpdate({ text: '/sendnow 5', userId: 4242, chatId: 4242 }));
  assert.match(lastText(tg), /not authorised/i);

  await router.handleUpdate(messageUpdate({ text: '/preview 5', userId: 4242, chatId: 4242 }));
  assert.match(lastText(tg), /not authorised/i);

  assert.equal(tg.polls.length, 0);
});

test('router: the sender commands explain themselves when the sender is not wired', async () => {
  const db = createFakeDb(CHANNEL_SEED);
  const tg = createFakeTg();
  const log = createTestLogger();
  const auth = createAuth({ db, config: CONFIG, log });
  const channels = createChannelStore({ db, tg, log });
  const router = createRouter({ tg, auth, channels, config: CONFIG, botInfo: BOT_INFO, log });

  await router.handleUpdate(messageUpdate({ text: '/sendnow', userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /question sender is not configured/);
});

test('router: /help advertises the sending commands', async () => {
  const { router, tg } = build();

  await router.handleUpdate(messageUpdate({ text: '/help', userId: 555, chatId: 555 }));

  const text = lastText(tg);
  assert.match(text, /\/preview/);
  assert.match(text, /\/sendnow/);
  assert.match(text, /\/schedule/);
  assertTelegramHtml(text, 'router:/help');
});

// --- Phase 4: /schedule ---------------------------------------------------

test('router: /schedule lists nothing when no schedule exists', async () => {
  const { router, tg } = build({}, CHANNEL_SEED);

  await router.handleUpdate(messageUpdate({ text: '/schedule', userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /No schedules yet/);
});

test('router: /schedule add creates a row with a canonical time, days and count', async () => {
  const { router, tg, db } = build({}, CHANNEL_SEED);

  await router.handleUpdate(
    messageUpdate({ text: `/schedule add 8:05 7 ${CHAT} weekdays`, userId: 555, chatId: 555 })
  );

  const row = db.schedules.get(1);
  assert.equal(row.send_time, '08:05', 'a single-digit hour is zero-padded');
  assert.equal(row.days_of_week, '1111100');
  assert.equal(row.question_count, 7);
  assert.equal(row.channel_id, 1);
  assert.equal(row.is_active, 1);

  const text = lastText(tg);
  assert.match(text, /Schedule <code>#1<\/code>/);
  assert.match(text, /08:05/);
  assert.match(text, /weekdays/);
  assertTelegramHtml(text, 'router:/schedule add');

  assert.deepEqual(db.audit.map((r) => r.action), ['schedule_created']);
});

test('router: a bare time implies add, and the default slot is 08:00 daily with 10', async () => {
  const { router, db } = build({}, CHANNEL_SEED);

  await router.handleUpdate(messageUpdate({ text: '/schedule 07:30', userId: 555, chatId: 555 }));

  const row = db.schedules.get(1);
  assert.equal(row.send_time, '07:30');
  assert.equal(row.days_of_week, '1111111');
  assert.equal(row.question_count, 10, 'the documented default');
});

test('router: /schedule rejects a bad time and a bad day list, and stores nothing', async () => {
  const { router, tg, db } = build({}, CHANNEL_SEED);

  await router.handleUpdate(messageUpdate({ text: '/schedule add 25:00', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /not a time/);

  await router.handleUpdate(messageUpdate({ text: '/schedule add 09:00 whenever', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /not a day list/);

  assert.equal(db.schedules.size, 0, 'nothing is stored for an invalid request');
});

test('router: /schedule add without a channel explains what to do', async () => {
  const { router, tg, db } = build({}, {}, CONFIG, []);

  await router.handleUpdate(messageUpdate({ text: '/schedule add 08:00', userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /No channel to schedule for/);
  assert.equal(db.schedules.size, 0);
});

test('router: /schedule default creates the standard daily slot exactly once', async () => {
  const { router, tg, db } = build({}, CHANNEL_SEED);

  await router.handleUpdate(messageUpdate({ text: '/schedule default', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /Default schedule <code>#1<\/code>/);

  const row = db.schedules.get(1);
  assert.equal(row.send_time, '08:00');
  assert.equal(row.days_of_week, '1111111');
  assert.equal(row.question_count, 10);

  // A second call must not add a second row — it lists what already exists.
  await router.handleUpdate(messageUpdate({ text: '/schedule default', userId: 555, chatId: 555 }));
  assert.equal(db.schedules.size, 1);
  assert.match(lastText(tg), /Schedules/);
});

test('router: /connect gives a fresh channel the default daily schedule', async () => {
  const { router, tg, db } = build({ getChat: async (id) => ({ id: Number(id), type: 'channel', title: 'Daily Quiz' }) });

  await router.handleUpdate(messageUpdate({ text: `/connect ${CHAT}`, userId: 555, chatId: 555 }));

  assert.match(lastText(tg), /Default schedule/);
  assert.equal(db.schedules.size, 1);
  const row = [...db.schedules.values()][0];
  assert.equal(row.send_time, '08:00');
  assert.equal(row.question_count, 10);
  assert.deepEqual(db.audit.map((r) => r.action), ['channel_connected', 'schedule_default_created']);
});

test('router: /connect never touches a channel that already has a schedule', async () => {
  const seed = {
    channels: [{ tg_chat_id: CHAT, title: 'A', is_active: 1, timezone: 'Asia/Kolkata' }],
    schedules: [{ id: 1, channel_id: 1, send_time: '20:00', days_of_week: '1111111', question_count: 3 }]
  };
  const { router, tg, db } = build(
    { getChat: async (id) => ({ id: Number(id), type: 'channel', title: 'A' }) },
    seed
  );

  await router.handleUpdate(messageUpdate({ text: `/connect ${CHAT}`, userId: 555, chatId: 555 }));

  assert.equal(db.schedules.size, 1);
  assert.equal(db.schedules.get(1).send_time, '20:00', 'the existing slot is left alone');
  assert.ok(!/Default schedule/.test(lastText(tg)));
});

test('router: /schedule enable, disable and remove act on a known id only', async () => {
  const seed = {
    channels: [{ tg_chat_id: CHAT, title: 'A', is_active: 1, timezone: 'Asia/Kolkata' }],
    schedules: [{ id: 1, channel_id: 1, send_time: '08:00', days_of_week: '1111111', question_count: 5 }]
  };
  const { router, tg, db } = build({}, seed);

  await router.handleUpdate(messageUpdate({ text: '/schedule disable 1', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /now paused/);
  assert.equal(db.schedules.get(1).is_active, 0);

  await router.handleUpdate(messageUpdate({ text: '/schedule enable 1', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /now active/);
  assert.equal(db.schedules.get(1).is_active, 1);

  await router.handleUpdate(messageUpdate({ text: '/schedule remove 1', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /removed/);
  assert.equal(db.schedules.size, 0);

  await router.handleUpdate(messageUpdate({ text: '/schedule remove 99', userId: 555, chatId: 555 }));
  assert.match(lastText(tg), /No schedule found/);

  assert.deepEqual(db.audit.map((r) => r.action), [
    'schedule_disabled',
    'schedule_enabled',
    'schedule_removed'
  ]);
});

test('router: /schedule list renders every row with its state', async () => {
  const seed = {
    channels: [{ tg_chat_id: CHAT, title: 'A', is_active: 1, timezone: 'Asia/Kolkata' }],
    schedules: [
      { id: 1, channel_id: 1, send_time: '08:00', days_of_week: '1111111', question_count: 5, is_active: 1 },
      { id: 2, channel_id: 1, send_time: '20:30', days_of_week: '0000011', question_count: 3, is_active: 0 }
    ]
  };
  const { router, tg } = build({}, seed);

  await router.handleUpdate(messageUpdate({ text: '/schedule list', userId: 555, chatId: 555 }));

  const text = lastText(tg);
  assert.match(text, /<code>#1<\/code> 08:00 · daily/);
  assert.match(text, /<code>#2<\/code> 20:30 · weekends/);
  assert.match(text, /⏸/, 'the disabled row is marked');
  assertTelegramHtml(text, 'router:/schedule list');
});

test('router: /schedule is refused for a non-admin and explained when unwired', async () => {
  const { router, tg } = build({}, CHANNEL_SEED);
  await router.handleUpdate(messageUpdate({ text: '/schedule', userId: 4242, chatId: 4242 }));
  assert.match(lastText(tg), /not authorised/i);

  const db = createFakeDb(CHANNEL_SEED);
  const bareTg = createFakeTg();
  const log = createTestLogger();
  const auth = createAuth({ db, config: CONFIG, log });
  const channels = createChannelStore({ db, tg: bareTg, log });
  const bare = createRouter({ tg: bareTg, auth, channels, config: CONFIG, botInfo: BOT_INFO, log });

  await bare.handleUpdate(messageUpdate({ text: '/schedule', userId: 555, chatId: 555 }));
  assert.match(lastText(bareTg), /scheduler is not configured/);
});
