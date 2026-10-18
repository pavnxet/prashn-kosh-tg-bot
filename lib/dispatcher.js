'use strict';

/**
 * dispatcher.js — turn selected questions into Telegram messages and record
 * the outcome.
 *
 * Format rules (ADR-009 / ADR-014):
 *   - `type: 'poll'` sends a **native quiz poll** whenever the row is a plain
 *     MCQ that fits Telegram's caps; the answer is intrinsic.
 *   - A row that cannot be a poll — a `match`/`statements`/`assertion_reason`
 *     type, or a stem over 300 chars — is sent as **two text messages**: the
 *     stem first, then the options with the answer shown. Nothing is dropped.
 *   - `type: 'text'` forces the two-message text form for every row.
 *
 * `sent_log` is written **only after Telegram confirms the send**, and never in
 * preview mode, so "already sent" in the selector stays truthful. A failed send
 * is logged with `status='failed'` and is therefore retried next time rather
 * than being treated as delivered.
 */

const { escapeHtml, PARSE_MODE } = require('./messages');
const { parseOptions, toPoll } = require('./selector');

/** Telegram caps a poll explanation at 200 characters. */
const MAX_EXPLANATION = 200;

/** Telegram tolerates roughly 20 messages/minute per chat; 5s ≈ 12/minute. */
const DEFAULT_GAP_SECONDS = 5;

const SENT = 'sent';
const FAILED = 'failed';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `YYYY-MM-DD` in the given IANA timezone, falling back to UTC. */
function runDateFor(timezone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Clamp an explanation to Telegram's 200-character cap. */
function trimExplanation(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > MAX_EXPLANATION ? `${text.slice(0, MAX_EXPLANATION - 1)}…` : text;
}

/**
 * @param {object} opts
 * @param {object} opts.db        Turso client (`lib/turso.js`).
 * @param {object} opts.tg        Telegram client (`lib/telegram.js`).
 * @param {object} opts.messages  Result of `createMessages()` — all text.
 * @param {object} [opts.log]
 */
function createDispatcher(opts = {}) {
  const { db, tg, messages, log } = opts;
  if (!db) throw new Error('dispatcher: db is required');
  if (!tg) throw new Error('dispatcher: telegram client is required');
  if (!messages) throw new Error('dispatcher: messages is required');

  /**
   * Render one question.
   * @param {object} question       Row from the `questions` table.
   * @param {object} [renderOpts]
   * @param {'poll'|'text'} [renderOpts.type]
   * @param {object} [renderOpts.subjectNames] `{ subject_id: name }`
   * @returns {{mode:'poll'|'text', id:string, subject:string,
   *            payload?:object, html?:string}}
   */
  function renderItem(question, renderOpts = {}) {
    const subjectId = question.subject_id;
    const subject = (renderOpts.subjectNames && renderOpts.subjectNames[subjectId]) || subjectId || '';

    if (renderOpts.type !== 'text') {
      const poll = toPoll(question);
      if (poll) {
        const explanation = trimExplanation(poll.explanation);
        const extra = {
          type: 'quiz',
          correct_option_id: poll.correctOptionId,
          is_anonymous: true
        };
        if (explanation) extra.explanation = explanation;

        return {
          mode: 'poll',
          id: question.id,
          subject,
          payload: { question: poll.question, options: poll.options, extra }
        };
      }
    }

    return { mode: 'text', id: question.id, subject, messages: renderTextParts(question, subject) };
  }

  /**
   * The fallback form, split for readability into two messages:
   *   1. the question stem (with its subject header), then
   *   2. the options followed by the answer and any explanation.
   * Returns at least one non-empty HTML string; a block with no content is left
   * out rather than sent as an empty message.
   */
  function renderTextParts(question, subject) {
    const stem = messages.t('question_text_header', {
      subject: subject || '—',
      question: question.question_text
    });

    const options = parseOptions(question.options_json);
    const second = options.map((option, index) =>
      messages.t('question_text_option', { n: index + 1, text: option.text })
    );

    const answer = resolveAnswerText(question, options);
    if (answer) second.push(messages.t('question_text_answer', { answer }));
    const explanation = trimExplanation(question.explanation);
    if (explanation) second.push(messages.t('question_text_explanation', { explanation }));

    const tail = second.join('\n').trim();
    return tail ? [stem, tail] : [stem];
  }

  /** The two text parts joined — kept for callers that want one string. */
  function renderText(question, subject) {
    return renderTextParts(question, subject).join('\n');
  }

  /**
   * The human-readable answer: the option text when the correct option can be
   * resolved, otherwise the raw stored value.
   */
  function resolveAnswerText(question, options) {
    const raw = question.correct_option;
    if (raw === null || raw === undefined || !String(raw).trim()) return null;
    const token = String(raw).trim().toUpperCase();

    const match = options.find(
      (option) => option.key !== null && String(option.key).trim().toUpperCase() === token
    );
    if (match) return match.text;

    const index = /^[A-J]$/.test(token) ? token.charCodeAt(0) - 65 : -1;
    if (index >= 0 && index < options.length) return options[index].text;

    return String(raw).trim();
  }

  /** Record a successful delivery. Returns false when the write failed. */
  async function recordSent(entry) {
    try {
      await db.execute(
        'INSERT INTO sent_log (channel_id, question_id, schedule_id, run_date, tg_message_id, status) ' +
          "VALUES (?, ?, ?, ?, ?, 'sent')",
        [entry.channelId, entry.questionId, entry.scheduleId, entry.runDate, entry.messageId]
      );
      return true;
    } catch (err) {
      // Losing this row would cost idempotency, so say so loudly.
      if (log) log.error('sent_log_write_failed', { questionId: entry.questionId, error: err.message });
      return false;
    }
  }

  /** Record a failed delivery so the question stays eligible for a retry. */
  async function recordFailed(entry) {
    try {
      await db.execute(
        'INSERT INTO sent_log (channel_id, question_id, schedule_id, run_date, status, error) ' +
          "VALUES (?, ?, ?, ?, 'failed', ?)",
        [entry.channelId, entry.questionId, entry.scheduleId, entry.runDate, String(entry.error || '').slice(0, 500)]
      );
      return true;
    } catch (err) {
      if (log) log.warn('sent_log_write_failed', { questionId: entry.questionId, error: err.message });
      return false;
    }
  }

  /**
   * Send a batch, one message at a time, honouring a gap between sends.
   *
   * A text item is two messages (stem, then options+answer), and the gap is
   * applied **between every message** — not every question — so a batch that
   * mixes the two forms still respects "≈20 messages/minute per chat".
   *
   * @param {object} sendOpts
   * @param {string|number} sendOpts.chatId   Destination.
   * @param {Array} sendOpts.questions        Rows, in order.
   * @param {number} [sendOpts.channelId]     `channels.id`; required to record.
   * @param {boolean}[sendOpts.record]        Write `sent_log` (live sends only).
   * @param {'poll'|'text'} [sendOpts.type]
   * @param {number} [sendOpts.gapSeconds]
   * @param {number} [sendOpts.scheduleId]
   * @param {string} [sendOpts.runDate]
   * @param {object} [sendOpts.subjectNames]
   * @param {Function}[sendOpts.sleep]        Injected for tests.
   * @returns {Promise<{results:Array, sent:number, failed:number, mode:string}>}
   */
  async function sendItems(sendOpts = {}) {
    const {
      chatId,
      questions = [],
      channelId = null,
      record = false,
      type = 'poll',
      gapSeconds = DEFAULT_GAP_SECONDS,
      scheduleId = null,
      runDate = null,
      subjectNames = {},
      sleep = defaultSleep
    } = sendOpts;

    const results = [];
    let sent = 0;
    let failed = 0;
    const modes = new Set();
    let firstSend = true;

    for (const question of questions) {
      const item = renderItem(question, { type, subjectNames });
      modes.add(item.mode);

      const steps =
        item.mode === 'poll'
          ? [{ poll: item.payload }]
          : item.messages.map((html) => ({ html }));

      let firstMessageId = null;
      try {
        for (const step of steps) {
          if (!firstSend && gapSeconds > 0) await sleep(gapSeconds * 1000);
          firstSend = false;

          const message = step.poll
            ? await tg.sendPoll(chatId, step.poll.question, step.poll.options, step.poll.extra)
            : await tg.sendMessage(chatId, step.html, { parse_mode: PARSE_MODE });

          const messageId = message && message.message_id !== undefined ? message.message_id : null;
          if (firstMessageId === null) firstMessageId = messageId;
        }

        if (record && channelId !== null) {
          await recordSent({
            channelId,
            questionId: item.id,
            scheduleId,
            runDate,
            messageId: firstMessageId
          });
        }
        sent += 1;
        results.push({
          id: item.id,
          mode: item.mode,
          status: SENT,
          messageId: firstMessageId,
          messages: steps.length,
          subject: item.subject
        });
      } catch (err) {
        failed += 1;
        results.push({
          id: item.id,
          mode: item.mode,
          status: FAILED,
          error: err.message,
          messages: steps.length,
          subject: item.subject
        });
        if (record && channelId !== null) {
          await recordFailed({
            channelId,
            questionId: item.id,
            scheduleId,
            runDate,
            error: err.message
          });
        }
        if (log) log.warn('dispatch_failed', { chatId: String(chatId), questionId: item.id, error: err.message });
      }
    }

    return {
      results,
      sent,
      failed,
      mode: modes.size === 1 ? [...modes][0] : modes.size === 0 ? 'none' : 'mixed'
    };
  }

  return { renderItem, renderText, renderTextParts, sendItems, recordSent, recordFailed, runDateFor };
}

module.exports = {
  createDispatcher,
  runDateFor,
  trimExplanation,
  DEFAULT_GAP_SECONDS,
  MAX_EXPLANATION
};
