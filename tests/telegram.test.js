'use strict';

/**
 * Tests for the Telegram client. `fetch` is always faked — no network, no token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTelegramClient,
  validatePoll,
  TelegramError,
  POLL_LIMITS
} = require('../lib/telegram');

const TOKEN = '123456:TEST-TOKEN-VALUE';

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

function captureFetch(responseFn) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, init });
    return responseFn({ url, body, calls });
  };
  return { fetchImpl, calls };
}

test('telegram: getMe posts to the right URL and returns the result', async () => {
  const { fetchImpl, calls } = captureFetch(async () =>
    jsonResponse({ ok: true, result: { id: 42, username: 'quiz_bot', is_bot: true } })
  );
  const tg = createTelegramClient({ token: TOKEN, fetchImpl });

  const me = await tg.getMe();

  assert.equal(me.id, 42);
  assert.equal(me.username, 'quiz_bot');
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getMe`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].body, {});
});

test('telegram: getUpdates omits an undefined offset and extends the timeout', async () => {
  const { fetchImpl, calls } = captureFetch(async () => jsonResponse({ ok: true, result: [] }));
  const tg = createTelegramClient({ token: TOKEN, fetchImpl });

  await tg.getUpdates({ timeout: 30, allowedUpdates: ['message'] });

  assert.deepEqual(calls[0].body, { timeout: 30, allowed_updates: ['message'] });
  assert.ok(!('offset' in calls[0].body));
});

test('telegram: API failures become TelegramError with code and description', async () => {
  const { fetchImpl } = captureFetch(async () =>
    jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: chat not found' })
  );
  const tg = createTelegramClient({ token: TOKEN, fetchImpl });

  await assert.rejects(
    () => tg.getChat('-100123'),
    (err) => {
      assert.ok(err instanceof TelegramError);
      assert.equal(err.errorCode, 400);
      assert.equal(err.description, 'Bad Request: chat not found');
      assert.equal(err.method, 'getChat');
      return true;
    }
  );
});

test('telegram: the token is redacted from network errors', async () => {
  const failing = async (url) => {
    throw new Error(`request to ${url} failed, reason: connect ECONNREFUSED`);
  };
  const tg = createTelegramClient({ token: TOKEN, fetchImpl: failing });

  await assert.rejects(() => tg.getMe(), (err) => {
    assert.equal(err.message.includes(TOKEN), false, 'token leaked into the error message');
    assert.match(err.message, /\[REDACTED\]/);
    return true;
  });
});

test('telegram: callWithRetry sleeps for retry_after + 1s and reports the retry', async () => {
  let attempt = 0;
  const retries = [];
  const slept = [];
  const { fetchImpl, calls } = captureFetch(async () => {
    attempt += 1;
    return attempt === 1
      ? jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 3 }, description: 'Too Many Requests' })
      : jsonResponse({ ok: true, result: { message_id: 9 } });
  });

  // Exercise callWithRetry directly so we can inject the delay function.
  const { createTelegramClient: create } = require('../lib/telegram');
  const client = create({ token: TOKEN, fetchImpl });
  const result = await client.callWithRetry(
    'sendMessage',
    { chat_id: 1, text: 'hi' },
    { sleep: async (ms) => slept.push(ms), onRetry: (info) => retries.push(info) }
  );

  assert.equal(result.message_id, 9);
  assert.deepEqual(slept, [4000]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].method, 'sendMessage');
  assert.equal(calls.length, 2);
});

test('telegram: client errors are never retried', async () => {
  const { fetchImpl, calls } = captureFetch(async () =>
    jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: message text is empty' })
  );
  const tg = createTelegramClient({ token: TOKEN, fetchImpl });

  await assert.rejects(() => tg.sendMessage(1, 'x'));
  assert.equal(calls.length, 1, 'a 400 must not be retried');
});

test('telegram: validatePoll enforces every Telegram cap', () => {
  assert.deepEqual(validatePoll({ question: 'Short?', options: ['A', 'B'] }), []);

  assert.match(validatePoll({ question: 'Q', options: ['only-one'] })[0], /must be 2-10/);
  assert.match(validatePoll({ question: 'Q', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] })[0], /must be 2-10/);
  assert.match(validatePoll({ question: 'x'.repeat(301), options: ['A', 'B'] })[0], /max 300/);
  assert.match(validatePoll({ question: 'Q', options: ['A', 'B'], explanation: 'y'.repeat(201) })[0], /max 200/);
  assert.match(validatePoll({ question: 'Q', options: ['A', 'B'.repeat(101)] })[0], /max 100/);
  assert.match(validatePoll({ question: '  ', options: ['A', 'B'] })[0], /required/);
  assert.deepEqual(validatePoll({ question: 'Q', options: ['A', ''], explanation: null }), ['poll option 2 is empty']);
});

test('telegram: sendPoll refuses an over-long question before any HTTP call', async () => {
  const { fetchImpl, calls } = captureFetch(async () => jsonResponse({ ok: true, result: {} }));
  const tg = createTelegramClient({ token: TOKEN, fetchImpl });

  // `sendPoll` validates synchronously, so the call is wrapped to observe it.
  await assert.rejects(async () => tg.sendPoll(1, 'x'.repeat(301), ['A', 'B']), /does not fit Telegram limits/);
  assert.equal(calls.length, 0);
});

test('telegram: sendMessage refuses text over 4096 chars locally', async () => {
  const { fetchImpl, calls } = captureFetch(async () => jsonResponse({ ok: true, result: {} }));
  const tg = createTelegramClient({ token: TOKEN, fetchImpl });

  await assert.rejects(async () => tg.sendMessage(1, 'x'.repeat(POLL_LIMITS.messageText + 1)), /max 4096/);
  await assert.rejects(async () => tg.sendMessage(1, ''), /text is required/);
  assert.equal(calls.length, 0);
});

test('telegram: startPolling dispatches updates, advances the offset and survives handler errors', async () => {
  const controller = new AbortController();
  const offsets = [];
  let round = 0;

  const { fetchImpl } = captureFetch(async ({ body }) => {
    offsets.push(body.offset);
    round += 1;
    if (round === 1) {
      return jsonResponse({
        ok: true,
        result: [
          { update_id: 10, message: { text: '/id' } },
          { update_id: 11, message: { text: '/status' } }
        ]
      });
    }
    controller.abort();
    return jsonResponse({ ok: true, result: [] });
  });

  const handled = [];
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const tg = createTelegramClient({ token: TOKEN, fetchImpl });

  await tg.startPolling({
    signal: controller.signal,
    log,
    allowedUpdates: ['message'],
    sleep: async () => {},
    onUpdate: async (update) => {
      handled.push(update.update_id);
      if (update.update_id === 11) throw new Error('handler blew up'); // must not be fatal
    }
  });

  assert.deepEqual(handled, [10, 11]);
  assert.equal(offsets[0], undefined, 'first poll has no offset');
  assert.equal(offsets[1], 12, 'offset follows the highest dispatched update_id');
});

test('telegram: startPolling requires a handler and a token/fetch', async () => {
  const tg = createTelegramClient({ token: TOKEN, fetchImpl: async () => jsonResponse({ ok: true, result: [] }) });
  await assert.rejects(() => tg.startPolling({}), /requires an onUpdate handler/);

  assert.throws(() => createTelegramClient({}), /token is required/);
  assert.throws(() => createTelegramClient({ token: TOKEN, fetchImpl: null }), /fetch is unavailable/);
});
