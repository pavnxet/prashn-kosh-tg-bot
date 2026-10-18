'use strict';

/**
 * Tests for channel connect/verify/list/pause/remove. Telegram is faked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChannelStore,
  normaliseChatId,
  evaluatePostingRights
} = require('../lib/channels');
const { createFakeDb, createFakeTg, createTestLogger } = require('./support/fakes');

const CHAT = '-1001234567890';

function build(tgBehavior = {}, seed = {}) {
  const db = createFakeDb(seed);
  const tg = createFakeTg(tgBehavior);
  const log = createTestLogger();
  return { db, tg, log, store: createChannelStore({ db, tg, log }) };
}

test('channels: normaliseChatId accepts real ids and rejects junk', () => {
  assert.equal(normaliseChatId('-1001234567890'), '-1001234567890');
  assert.equal(normaliseChatId(' -1001234567890 '), '-1001234567890');
  assert.equal(normaliseChatId(-1001234567890), '-1001234567890');
  assert.equal(normaliseChatId('123'), '123');

  assert.throws(() => normaliseChatId(''), /chat id is required/);
  assert.throws(() => normaliseChatId('@my_channel'), /not a valid numeric/);
  assert.throws(() => normaliseChatId('-100.5'), /not a valid numeric/);
  assert.throws(() => normaliseChatId('-'), /not a valid numeric/);
});

test('channels: posting rights are judged from the bot membership', () => {
  assert.deepEqual(evaluatePostingRights({ status: 'creator' }), { ok: true, status: 'creator', reason: 'creator' });
  assert.deepEqual(evaluatePostingRights({ status: 'administrator', can_post_messages: true }), {
    ok: true,
    status: 'administrator',
    reason: 'administrator'
  });
  // Absent flag (e.g. non-channel admin) must not block posting.
  assert.equal(evaluatePostingRights({ status: 'administrator' }).ok, true);
  assert.deepEqual(evaluatePostingRights({ status: 'administrator', can_post_messages: false }), {
    ok: false,
    status: 'administrator',
    reason: 'admin_without_post_messages_right'
  });
  assert.equal(evaluatePostingRights({ status: 'restricted', can_post_messages: true }).ok, true);
  assert.equal(evaluatePostingRights({ status: 'restricted', can_post_messages: false }).ok, false);
  assert.equal(evaluatePostingRights({ status: 'member' }).reason, 'bot_is_not_an_administrator');
  assert.equal(evaluatePostingRights({ status: 'left' }).reason, 'bot_is_not_in_the_chat');
  assert.equal(evaluatePostingRights({ status: 'kicked' }).reason, 'bot_is_not_in_the_chat');
  assert.equal(evaluatePostingRights(null).ok, false);
});

test('channels: connect verifies rights and persists the channel', async () => {
  const { store, db, tg } = build({
    getChat: async (id) => ({ id: Number(id), type: 'channel', title: 'Daily Quiz' }),
    getChatMember: async () => ({ status: 'administrator', can_post_messages: true })
  });

  const result = await store.connect({ chatId: CHAT, actorId: 555 });

  assert.equal(result.ok, true);
  assert.equal(result.title, 'Daily Quiz');
  assert.equal(result.type, 'channel');
  assert.equal(result.rights.reason, 'administrator');
  assert.equal(result.channel.tg_chat_id, CHAT);
  assert.equal(result.channel.is_active, 1);
  assert.equal(result.channel.timezone, 'Asia/Kolkata');
  assert.equal(tg.sent.length, 0, 'connecting must never post to the channel');

  const again = await store.connect({ chatId: CHAT, actorId: 555 });
  assert.equal(again.ok, true);
  assert.equal(db.channels.size, 1, 'reconnecting must not duplicate the row');
});

test('channels: connect refuses a chat the bot cannot post to', async () => {
  const { store, db } = build({
    getChatMember: async () => ({ status: 'member' })
  });

  const result = await store.connect({ chatId: CHAT, actorId: 555 });

  assert.equal(result.ok, false);
  assert.equal(result.rights.reason, 'bot_is_not_an_administrator');
  assert.equal(db.channels.size, 0, 'a refused channel must not be stored');
});

test('channels: connect refuses an admin without the post-messages right', async () => {
  const { store } = build({ getChatMember: async () => ({ status: 'administrator', can_post_messages: false }) });
  const result = await store.connect({ chatId: CHAT });
  assert.equal(result.ok, false);
  assert.equal(result.rights.reason, 'admin_without_post_messages_right');
});

test('channels: connect reports an unreachable chat instead of throwing', async () => {
  const { store } = build({
    getChat: async () => {
      throw new Error('Bad Request: chat not found');
    }
  });

  const result = await store.connect({ chatId: CHAT });
  assert.equal(result.ok, false);
  assert.equal(result.rights.reason, 'chat_unreachable');
  assert.match(result.error, /chat not found/);
});

test('channels: remove deletes children explicitly in one pipeline (no FK cascade)', async () => {
  const { store, db } = build({}, { channels: [{ tg_chat_id: CHAT, title: 'X', is_active: 1, timezone: 'Asia/Kolkata' }] });

  const result = await store.remove(CHAT);

  assert.equal(result.removed, true);
  assert.equal(db.channels.size, 0);

  const deletes = db.calls.filter((c) => c.sql.startsWith('DELETE FROM')).map((c) => c.sql.split(' ')[2]);
  assert.deepEqual(deletes, ['sent_log', 'channel_settings', 'schedules', 'channels']);
});

test('channels: remove on an unknown channel is a no-op', async () => {
  const { store } = build();
  assert.deepEqual(await store.remove(CHAT), { removed: false, chatId: CHAT });
});

test('channels: pause/resume toggles a channel and setAllActive touches each row', async () => {
  const seed = [
    { tg_chat_id: '-100111', title: 'A', is_active: 1, timezone: 'Asia/Kolkata' },
    { tg_chat_id: '-100222', title: 'B', is_active: 1, timezone: 'Asia/Kolkata' }
  ];
  const { store, db } = build({}, { channels: seed });

  await store.setActive('-100111', false);
  assert.equal((await store.findByChatId('-100111')).is_active, 0);
  assert.equal((await store.findByChatId('-100222')).is_active, 1);

  await store.setAllActive(false);
  const rows = await store.list();
  assert.deepEqual(rows.map((r) => r.is_active), [0, 0]);
  assert.equal(db.channels.size, 2);
});

test('channels: the bot id is fetched once and cached', async () => {
  let meCalls = 0;
  const { store } = build({
    getMe: async () => {
      meCalls += 1;
      return { id: 999, username: 'test_bot' };
    }
  });

  assert.equal(await store.botId(), 999);
  assert.equal(await store.botId(), 999);
  assert.equal(meCalls, 1);
});
