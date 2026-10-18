'use strict';

/**
 * telegram.js — zero-dependency Telegram Bot API client over global `fetch`.
 *
 * Why hand-rolled: the J7 Max runs 32-bit ARM/Bionic where native modules are
 * unreliable (ADR-002), and the bot only needs a handful of Bot API methods.
 *
 * Security invariant: **the token is never exposed**. The token appears in the
 * request URL, so every thrown message is passed through `sanitize()` which
 * strips the token, and the URL is never included verbatim in an error.
 *
 * Reliability: `callWithRetry()` retries only rate limits (HTTP 429, honouring
 * `parameters.retry_after`) and transient failures (5xx / network). Client errors
 * such as "message is not modified" or "chat not found" are never retried.
 */

const DEFAULT_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_POLL_TIMEOUT_S = 25;
const DEFAULT_MAX_ATTEMPTS = 4;
const REDACTED = '[REDACTED]';

/** Telegram's hard quiz-poll caps (AGENTS.md invariant 6). */
const POLL_LIMITS = Object.freeze({
  question: 300,
  option: 100,
  explanation: 200,
  minOptions: 2,
  maxOptions: 10,
  messageText: 4096
});

class TelegramError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'TelegramError';
    this.method = meta.method ?? null;
    this.errorCode = meta.errorCode ?? null;
    this.retryAfter = meta.retryAfter ?? null;
    this.description = meta.description ?? null;
  }
}

/** Replace the raw token anywhere it might have leaked into a string. */
function sanitize(text, token) {
  const value = text === null || text === undefined ? '' : String(text);
  return token ? value.split(token).join(REDACTED) : value;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check a poll against Telegram's caps.
 * @returns {string[]} human-readable problems; empty when the poll fits.
 */
function validatePoll({ question, options, explanation } = {}) {
  const errors = [];

  if (typeof question !== 'string' || !question.trim()) {
    errors.push('poll question is required');
  } else if (question.length > POLL_LIMITS.question) {
    errors.push(`poll question is ${question.length} chars (max ${POLL_LIMITS.question})`);
  }

  if (!Array.isArray(options)) {
    errors.push('poll options must be an array');
  } else {
    if (options.length < POLL_LIMITS.minOptions || options.length > POLL_LIMITS.maxOptions) {
      errors.push(
        `poll has ${options.length} options (must be ${POLL_LIMITS.minOptions}-${POLL_LIMITS.maxOptions})`
      );
    }
    options.forEach((option, index) => {
      if (typeof option !== 'string' || !option.trim()) {
        errors.push(`poll option ${index + 1} is empty`);
      } else if (option.length > POLL_LIMITS.option) {
        errors.push(`poll option ${index + 1} is ${option.length} chars (max ${POLL_LIMITS.option})`);
      }
    });
  }

  if (explanation !== undefined && explanation !== null) {
    const length = String(explanation).length;
    if (length > POLL_LIMITS.explanation) {
      errors.push(`poll explanation is ${length} chars (max ${POLL_LIMITS.explanation})`);
    }
  }

  return errors;
}

/**
 * @param {object} opts
 * @param {string} opts.token                 Bot token from @BotFather.
 * @param {Function} [opts.fetchImpl]         Fetch implementation (injected in tests).
 * @param {string} [opts.apiBase]             API root (default https://api.telegram.org).
 * @param {number} [opts.timeoutMs]           Per-request timeout.
 */
function createTelegramClient(opts = {}) {
  const {
    token,
    fetchImpl = globalThis.fetch,
    apiBase = DEFAULT_API_BASE,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = opts;

  if (!token) throw new TelegramError('telegram: token is required');
  if (typeof fetchImpl !== 'function') {
    throw new TelegramError('telegram: global fetch is unavailable (Node >= 20 required)');
  }

  const base = String(apiBase).replace(/\/+$/, '');
  const urlFor = (method) => `${base}/bot${token}/${method}`;

  /** One Bot API call. Throws `TelegramError` on transport or API failure. */
  async function call(method, payload = {}, callOpts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callOpts.timeoutMs ?? timeoutMs);

    let res;
    try {
      res = await fetchImpl(urlFor(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new TelegramError(`telegram: ${method} timed out`, { method });
      }
      // `err.message` from undici can embed the request URL, which holds the token.
      throw new TelegramError(
        `telegram: ${method} network error: ${sanitize(err && err.message, token)}`,
        { method }
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    const description = data && data.description ? sanitize(data.description, token) : null;
    const retryAfter = (data && data.parameters && data.parameters.retry_after) ?? null;

    if (!res.ok) {
      throw new TelegramError(
        `telegram: ${method} HTTP ${res.status}${description ? `: ${description}` : ''}`,
        { method, errorCode: res.status, retryAfter, description }
      );
    }
    if (!data || data.ok !== true) {
      const fallback = sanitize(text, token).slice(0, 200) || 'unknown error';
      throw new TelegramError(`telegram: ${method} failed: ${description || fallback}`, {
        method,
        errorCode: data ? data.error_code : null,
        retryAfter,
        description
      });
    }

    return data.result;
  }

  /**
   * `call()` with bounded retries for rate limits and transient failures.
   * @param {object} [opts.attempts] Max attempts (default 4).
   * @param {Function} [opts.sleep]  Injected delay function (tests).
   * @param {Function} [opts.onRetry] Called with `{ method, attempt, delayMs, error }`.
   */
  async function callWithRetry(method, payload = {}, opts2 = {}) {
    const attempts = opts2.attempts ?? DEFAULT_MAX_ATTEMPTS;
    const sleep = opts2.sleep || defaultSleep;

    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await call(method, payload, opts2);
      } catch (err) {
        lastError = err;
        const rateLimited = err.retryAfter !== null && err.retryAfter !== undefined;
        const serverError = typeof err.errorCode === 'number' && err.errorCode >= 500;
        const networkError = err.errorCode === null || err.errorCode === undefined;

        if (attempt >= attempts || !(rateLimited || serverError || networkError)) throw err;

        const delayMs = rateLimited
          ? (Number(err.retryAfter) + 1) * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 30000);
        if (opts2.onRetry) opts2.onRetry({ method, attempt, delayMs, error: err });
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  // --- Thin wrappers over the methods the bot actually uses ---------------

  const getMe = () => call('getMe');

  const getUpdates = (updateOpts = {}) => {
    const timeout = updateOpts.timeout ?? DEFAULT_POLL_TIMEOUT_S;
    return call(
      'getUpdates',
      { offset: updateOpts.offset, timeout, allowed_updates: updateOpts.allowedUpdates },
      { timeoutMs: timeout * 1000 + 10000 }
    );
  };

  const getChat = (chatId) => call('getChat', { chat_id: chatId });
  const getChatMember = (chatId, userId) => call('getChatMember', { chat_id: chatId, user_id: userId });
  const getChatAdministrators = (chatId) => call('getChatAdministrators', { chat_id: chatId });
  const getChatMemberCount = (chatId) => call('getChatMemberCount', { chat_id: chatId });

  const sendMessage = (chatId, text, extra = {}) => {
    const length = String(text ?? '').length;
    if (length === 0) throw new TelegramError('telegram: sendMessage text is required', { method: 'sendMessage' });
    if (length > POLL_LIMITS.messageText) {
      throw new TelegramError(
        `telegram: sendMessage text is ${length} chars (max ${POLL_LIMITS.messageText})`,
        { method: 'sendMessage' }
      );
    }
    return callWithRetry('sendMessage', { chat_id: chatId, text, ...extra });
  };

  const editMessageText = (extra = {}) =>
    callWithRetry('editMessageText', { ...extra });

  const deleteMessage = (chatId, messageId) =>
    call('deleteMessage', { chat_id: chatId, message_id: messageId });

  const answerCallbackQuery = (callbackQueryId, extra = {}) =>
    call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...extra });

  const sendPoll = (chatId, question, options, extra = {}) => {
    const problems = validatePoll({ question, options, explanation: extra.explanation });
    if (problems.length) {
      throw new TelegramError(`telegram: poll does not fit Telegram limits: ${problems.join('; ')}`, {
        method: 'sendPoll'
      });
    }
    return callWithRetry('sendPoll', { chat_id: chatId, question, options, ...extra });
  };

  /**
   * Long-poll loop. `onUpdate` is awaited for each update; a throwing handler is
   * logged and skipped, never fatal. Resolves when the signal aborts.
   */
  async function startPolling(pollOpts = {}) {
    const {
      onUpdate,
      signal,
      log,
      allowedUpdates = ['message', 'callback_query'],
      timeoutSeconds = DEFAULT_POLL_TIMEOUT_S
    } = pollOpts;

    if (typeof onUpdate !== 'function') {
      throw new TelegramError('telegram: startPolling requires an onUpdate handler');
    }

    let offset = pollOpts.offset;
    let running = true;
    const stop = () => {
      running = false;
    };
    if (signal) {
      if (signal.aborted) running = false;
      else if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', stop, { once: true });
      }
    }

    while (running) {
      let updates;
      try {
        updates = await getUpdates({ offset, timeout: timeoutSeconds, allowedUpdates });
      } catch (err) {
        if (!running) break;
        if (log) log.warn('poll_error', { error: err.message, code: err.errorCode });
        if (typeof pollOpts.sleep === 'function') await pollOpts.sleep(3000);
        else await defaultSleep(3000);
        continue;
      }

      for (const update of updates || []) {
        offset = update.update_id + 1;
        try {
          await onUpdate(update);
        } catch (err) {
          if (log) log.error('update_handler_failed', { updateId: update.update_id, error: err.message });
        }
      }
    }

    return { stop, offset };
  }

  return {
    getMe,
    getUpdates,
    getChat,
    getChatMember,
    getChatAdministrators,
    getChatMemberCount,
    sendMessage,
    editMessageText,
    deleteMessage,
    answerCallbackQuery,
    sendPoll,
    call,
    callWithRetry,
    startPolling
  };
}

module.exports = {
  createTelegramClient,
  validatePoll,
  TelegramError,
  POLL_LIMITS,
  DEFAULT_API_BASE,
  DEFAULT_POLL_TIMEOUT_S
};
