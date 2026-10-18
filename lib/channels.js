'use strict';

/**
 * channels.js — connect, verify and manage the channels the bot may post to.
 *
 * "Connect" means more than storing an id: it proves the bot can actually read the
 * chat AND holds posting rights there, so a misconfigured channel is rejected at
 * connect time instead of failing silently at send time.
 *
 * Chat ids are kept as **strings** end to end. They are int64 values, and while
 * realistic supergroup ids fit inside JS's safe-integer range, string handling
 * removes any chance of precision loss or accidental float formatting.
 */

/** Member statuses that may post to a channel. */
const POSTING_STATUSES = Object.freeze(['creator', 'administrator']);

/**
 * Validate and normalise a chat id.
 * @returns {string} the digits (with optional leading `-`) as a string.
 */
function normaliseChatId(value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) throw new Error('channel: a chat id is required');
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`channel: "${raw}" is not a valid numeric Telegram chat id`);
  }
  if (raw === '-') throw new Error(`channel: "${raw}" is not a valid Telegram chat id`);
  return raw;
}

/**
 * Decide whether a `getChatMember` result permits posting.
 * Pure function so it can be unit-tested without Telegram.
 *
 * @param {object} member  Result of `getChatMember(chat, botId)`.
 * @returns {{ok:boolean, status:string, reason:string}}
 */
function evaluatePostingRights(member) {
  const status = (member && member.status) || 'unknown';

  if (status === 'creator') return { ok: true, status, reason: 'creator' };
  if (status === 'administrator') {
    // `can_post_messages` may be absent on non-channel administrators; only an
    // explicit `false` means the bot cannot post.
    return member.can_post_messages === false
      ? { ok: false, status, reason: 'admin_without_post_messages_right' }
      : { ok: true, status, reason: 'administrator' };
  }
  if (status === 'restricted') {
    return member.can_post_messages
      ? { ok: true, status, reason: 'restricted_but_can_post' }
      : { ok: false, status, reason: 'restricted_without_post_right' };
  }
  if (status === 'left' || status === 'kicked') {
    return { ok: false, status, reason: 'bot_is_not_in_the_chat' };
  }
  return { ok: false, status, reason: 'bot_is_not_an_administrator' };
}

/**
 * @param {object} opts
 * @param {object} opts.db   Turso client.
 * @param {object} opts.tg   Telegram client.
 * @param {object} [opts.log]
 * @param {string} [opts.defaultTz]
 */
function createChannelStore(opts = {}) {
  const { db, tg, log, defaultTz = 'Asia/Kolkata' } = opts;
  if (!db) throw new Error('channel: db is required');
  if (!tg) throw new Error('channel: telegram client is required');

  let cachedBotId = null;

  async function botId() {
    if (cachedBotId === null) {
      const me = await tg.getMe();
      cachedBotId = me.id;
    }
    return cachedBotId;
  }

  function list() {
    return db.all(
      'SELECT id, tg_chat_id, title, is_active, timezone, created_at FROM channels ORDER BY id'
    );
  }

  function findByChatId(chatId) {
    return db.get('SELECT * FROM channels WHERE tg_chat_id = ?', [chatId]);
  }

  /**
   * Verify and persist a channel.
   * @returns {Promise<{ok:boolean, chatId:string, title:string|null, type?:string,
   *                    rights:object, channel?:object, error?:string}>}
   */
  async function connect(connectOpts = {}) {
    const { actorId = null } = connectOpts;
    const chatId = normaliseChatId(connectOpts.chatId);

    let chat;
    try {
      chat = await tg.getChat(chatId);
    } catch (err) {
      return { ok: false, chatId, title: null, rights: { ok: false, status: 'unknown', reason: 'chat_unreachable' }, error: err.message };
    }

    const id = await botId();
    let member;
    try {
      member = await tg.getChatMember(chatId, id);
    } catch (err) {
      return {
        ok: false,
        chatId,
        title: chat.title || chat.username || null,
        type: chat.type,
        rights: { ok: false, status: 'unknown', reason: 'membership_unreadable' },
        error: err.message
      };
    }

    const rights = evaluatePostingRights(member);
    const title = chat.title || chat.username || null;

    if (!rights.ok) {
      if (log) log.warn('channel_connect_refused', { chatId, type: chat.type, reason: rights.reason });
      return { ok: false, chatId, title, type: chat.type, rights };
    }

    await db.execute(
      'INSERT INTO channels (tg_chat_id, title, is_active, timezone) VALUES (?, ?, 1, ?) ' +
        'ON CONFLICT(tg_chat_id) DO UPDATE SET title = excluded.title, timezone = excluded.timezone',
      [chatId, title, connectOpts.timezone || defaultTz]
    );

    const channel = await findByChatId(chatId);
    if (log) log.info('channel_connected', { chatId, title, type: chat.type, reason: rights.reason, actorId });
    return { ok: true, chatId, title, type: chat.type, rights, channel };
  }

  async function setActive(chatId, isActive) {
    const id = normaliseChatId(chatId);
    await db.execute('UPDATE channels SET is_active = ? WHERE tg_chat_id = ?', [isActive ? 1 : 0, id]);
    return findByChatId(id);
  }

  /** Convenience wrapper used by `/channels` and `/killall`. */
  async function setAllActive(isActive) {
    const rows = await list();
    await db.pipeline(
      rows.map((row) => ({
        sql: 'UPDATE channels SET is_active = ? WHERE id = ?',
        args: [isActive ? 1 : 0, row.id]
      }))
    );
    return rows.length;
  }

  /**
   * Delete a channel. libSQL does not enforce foreign keys, so children are
   * removed explicitly in the same pipeline (ADR-004).
   */
  async function remove(chatId) {
    const id = normaliseChatId(chatId);
    const row = await findByChatId(id);
    if (!row) return { removed: false, chatId: id };

    await db.pipeline([
      { sql: 'DELETE FROM sent_log WHERE channel_id = ?', args: [row.id] },
      { sql: 'DELETE FROM channel_settings WHERE channel_id = ?', args: [row.id] },
      { sql: 'DELETE FROM schedules WHERE channel_id = ?', args: [row.id] },
      { sql: 'DELETE FROM channels WHERE id = ?', args: [row.id] }
    ]);

    if (log) log.info('channel_removed', { chatId: id, channelId: row.id });
    return { removed: true, chatId: id, channelId: row.id };
  }

  return { botId, list, findByChatId, connect, setActive, setAllActive, remove };
}

module.exports = {
  createChannelStore,
  normaliseChatId,
  evaluatePostingRights,
  POSTING_STATUSES
};
