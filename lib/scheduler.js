'use strict';

/**
 * scheduler.js — the ticking engine that turns due `schedules` rows into posts.
 *
 * Design rules (ADR-016):
 *   1. **Fire once per day.** A due slot is marked spent (`last_run_date`) after
 *      the run, whatever the outcome, so a failure cannot become a retry flood.
 *   2. **A missed slot is skipped, not replayed.** `isSlotDue()` only fires
 *      inside the catch-up window, so a restart hours later posts nothing.
 *   3. **A failed *selection* retries a few times inside the window** (the DB
 *      being briefly unreachable is transient), then gives up, marks the slot
 *      and DMs the owner.
 *   4. **The owner hears about every problem** — a failed run, a partial run, a
 *      dry-run summary, or a subject pool that had to be recycled.
 *   5. **`DRY_RUN` is respected.** A dry run sends the exact items to the owner's
 *      DM, writes no `sent_log`, but still marks the slot spent so it fires once.
 *
 * The tick is guarded against re-entry: a slow batch never overlaps the next
 * minute's tick.
 */

const { PARSE_MODE } = require('./messages');
const { isSlotDue, DEFAULT_CATCHUP_MINUTES } = require('./schedules');

/** Selection failures retried inside the catch-up window before giving up. */
const MAX_SELECT_ATTEMPTS = 3;

/**
 * @param {object} opts
 * @param {object} opts.tg          Telegram client.
 * @param {object} opts.selector    Question selector.
 * @param {object} opts.dispatcher  Question dispatcher.
 * @param {object} opts.schedules   Schedule store (`lib/schedules.js`).
 * @param {object} opts.messages    Result of `createMessages()`.
 * @param {object} [opts.config]
 * @param {object} [opts.log]
 * @param {Function} [opts.now]           Clock, injected for tests.
 * @param {Function} [opts.setIntervalFn] Ditto.
 * @param {Function} [opts.clearIntervalFn]
 */
function createScheduler(opts = {}) {
  const {
    tg,
    selector,
    dispatcher,
    schedules,
    messages,
    config = {},
    log,
    now = () => new Date(),
    sleep,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = opts;

  if (!tg) throw new Error('scheduler: telegram client is required');
  if (!selector || !dispatcher) throw new Error('scheduler: selector and dispatcher are required');
  if (!schedules) throw new Error('scheduler: schedule store is required');
  if (!messages) throw new Error('scheduler: messages are required');

  const catchupMinutes =
    config.scheduleCatchupMinutes === undefined
      ? DEFAULT_CATCHUP_MINUTES
      : Number(config.scheduleCatchupMinutes);
  const tickSeconds = Math.max(5, Number(config.schedulerTickSeconds) || 60);
  const ownerId = config.ownerTgId || null;

  /** `${scheduleId}:${runDate}` → attempts, so a sick DB retries a bounded few times. */
  const attempts = new Map();
  let timer = null;
  let inFlight = false;

  /** DM the owner; silently no-ops when no owner is configured. */
  const notifyOwner = (text) =>
    ownerId ? tg.sendMessage(ownerId, text, { parse_mode: PARSE_MODE }) : Promise.resolve(null);

  function parseFilter(raw) {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Run every slot that is due right now.
   * @returns {Promise<{skipped:boolean, due:number, results:Array}>}
   */
  async function tick() {
    if (inFlight) {
      if (log) log.warn('scheduler_busy', { note: 'previous tick is still running' });
      return { skipped: true, due: 0, results: [] };
    }

    inFlight = true;
    try {
      const at = now();
      const rows = await schedules.listAll();
      const due = [];

      for (const row of rows) {
        if (Number(row.channel_active) !== 1) continue;
        const verdict = isSlotDue({ schedule: row, now: at, catchupMinutes });
        if (verdict.due) due.push({ schedule: row, date: verdict.date, lateMinutes: verdict.lateMinutes });
      }

      const results = [];
      for (const item of due) {
        results.push(await runSlot(item.schedule, item.date, item.lateMinutes));
      }
      return { skipped: false, due: due.length, results };
    } finally {
      inFlight = false;
    }
  }

  /** A transient selection failure: retry a bounded few times, then report. */
  async function selectionFailed(schedule, runDate, key, error, title) {
    const used = (attempts.get(key) || 0) + 1;
    attempts.set(key, used);
    if (log) {
      log.error('schedule_select_failed', {
        scheduleId: schedule.id,
        attempt: used,
        error: error.message
      });
    }

    if (used < MAX_SELECT_ATTEMPTS) {
      return { scheduleId: schedule.id, status: 'retry', attempts: used, error: error.message };
    }

    attempts.delete(key);
    await schedules.markRun(schedule.id, runDate);
    await notifyOwner(
      messages.t('schedule_failed', {
        title,
        chatId: schedule.tg_chat_id,
        error: error.message
      })
    );
    return { scheduleId: schedule.id, status: 'failed', attempts: used, error: error.message };
  }

  /**
   * Execute one schedule for one run date.
   * @returns {Promise<{scheduleId:number, status:string, sent?:number,
   *                    failed?:number, requested?:number, error?:string}>}
   */
  async function runSlot(schedule, runDate, lateMinutes = 0) {
    const key = `${schedule.id}:${runDate}`;
    const title = schedule.title || String(schedule.tg_chat_id);
    const dryRun = Boolean(config.dryRun);
    const type = schedule.format === 'text' ? 'text' : 'poll';
    const count = Number(schedule.question_count) || 10;
    const gapSeconds = Math.max(3, Number(schedule.gap_seconds) || 5);

    // A dry run with no owner has nowhere safe to send; never fall through to
    // the live channel.
    if (dryRun && !ownerId) {
      await schedules.markRun(schedule.id, runDate);
      if (log) log.error('schedule_dryrun_no_owner', { scheduleId: schedule.id });
      return { scheduleId: schedule.id, status: 'dry_run_no_owner', sent: 0, failed: 0 };
    }

    let selection;
    try {
      selection = await selector.selectQuestions({
        channelId: schedule.channel_id,
        count,
        subjects: parseFilter(schedule.subject_filter_json),
        // Every renderable row qualifies; the dispatcher chooses poll vs the
        // two-message text form per row (ADR-014).
        pollableOnly: false,
        allowRecycle: true
      });
    } catch (err) {
      return selectionFailed(schedule, runDate, key, err, title);
    }
    attempts.delete(key);

    if (!selection.questions.length) {
      await schedules.markRun(schedule.id, runDate);
      if (log) log.warn('schedule_empty', { scheduleId: schedule.id, channelId: schedule.channel_id });
      await notifyOwner(
        messages.t('schedule_empty', { title, chatId: schedule.tg_chat_id })
      );
      return { scheduleId: schedule.id, status: 'empty', sent: 0, failed: 0, requested: 0 };
    }

    const subjectNames = await selector.subjectNames();
    const sendOpts = {
      chatId: dryRun ? ownerId : schedule.tg_chat_id,
      channelId: dryRun ? null : schedule.channel_id,
      record: !dryRun,
      questions: selection.questions,
      type,
      gapSeconds: dryRun ? 1 : gapSeconds,
      scheduleId: schedule.id,
      runDate,
      subjectNames
    };
    // Only passed when injected, so dispatcher's own pacing default applies live.
    if (sleep) sendOpts.sleep = sleep;
    const outcome = await dispatcher.sendItems(sendOpts);

    // Fire-once: the slot is spent for the day regardless of the outcome.
    await schedules.markRun(schedule.id, runDate);

    if (log) {
      log.info('schedule_run', {
        scheduleId: schedule.id,
        channelId: schedule.channel_id,
        runDate,
        dryRun,
        lateMinutes,
        requested: selection.questions.length,
        sent: outcome.sent,
        failed: outcome.failed,
        mode: outcome.mode
      });
    }

    if (dryRun) {
      await notifyOwner(
        messages.t('schedule_dryrun', {
          count: selection.questions.length,
          title,
          chatId: schedule.tg_chat_id
        })
      );
      return {
        scheduleId: schedule.id,
        status: 'dry_run',
        sent: 0,
        failed: 0,
        requested: selection.questions.length
      };
    }

    if (outcome.failed > 0 || outcome.sent === 0) {
      await notifyOwner(
        messages.t('schedule_failed_partial', {
          title,
          chatId: schedule.tg_chat_id,
          sent: outcome.sent,
          requested: selection.questions.length,
          failed: outcome.failed
        })
      );
    }

    const recycled = Object.keys(selection.recycled || {});
    if (recycled.length) {
      await notifyOwner(
        messages.t('sendnow_recycled', {
          subjects: recycled.map((id) => subjectNames[id] || id).join(', ')
        })
      );
    }

    return {
      scheduleId: schedule.id,
      status: 'sent',
      sent: outcome.sent,
      failed: outcome.failed,
      requested: selection.questions.length,
      lateMinutes
    };
  }

  /** Begin ticking. Runs one tick immediately, then every `tickSeconds`. */
  function start() {
    if (timer) return false;
    if (config.schedulerEnabled === false) {
      if (log) log.info('scheduler_disabled', { note: 'SCHEDULER_ENABLED=false' });
      return false;
    }

    timer = setIntervalFn(() => {
      tick().catch((err) => {
        if (log) log.error('scheduler_tick_failed', { error: err.message });
      });
    }, tickSeconds * 1000);
    // Do not let the timer alone hold the process open.
    if (timer && typeof timer.unref === 'function') timer.unref();

    if (log) {
      log.info('scheduler_started', { everySeconds: tickSeconds, catchupMinutes });
    }

    tick().catch((err) => {
      if (log) log.error('scheduler_tick_failed', { error: err.message });
    });
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }

  return {
    tick,
    runSlot,
    start,
    stop,
    isRunning: () => inFlight,
    attempts,
    MAX_SELECT_ATTEMPTS
  };
}

module.exports = { createScheduler, MAX_SELECT_ATTEMPTS };
