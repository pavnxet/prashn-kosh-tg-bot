'use strict';

/**
 * selector.js — decide *which* questions a send should carry.
 *
 * Two layers, deliberately separated:
 *   1. SQL narrows the field with cheap structural predicates: `mcq`, a sane
 *      option count, a stem that fits a poll, not blocked, and not already sent
 *      to this channel.
 *   2. JavaScript makes the authoritative poll-correctness decision in
 *      `toPoll()`, because the real rules depend on JSON the database only
 *      half-understands (option *text* lengths, key→index mapping). The same
 *      function feeds `validatePoll()` in `lib/telegram.js`, so a question that
 *      passes here cannot be rejected there for locally-checkable reasons.
 *
 * Selection is **per subject** (ADR-010):
 *   - an explicit map — `schedules.subject_filter_json`, e.g.
 *     `{"rajasthan_history":3,"mathematics":3}` — is honoured as a quota;
 *   - with no map the quota is proportional to what each subject still has
 *     unsent, so a 3,160-question subject cannot crowd out a 27-question one.
 * When a subject runs dry, `allowRecycle` lets its *least recently sent*
 * questions back in and reports them, so the caller can warn an admin. Nothing
 * is ever deleted or rewritten: `sent_log` stays append-only.
 */

/** Telegram quiz-poll caps, mirrored from `lib/telegram.js` (POLL_LIMITS). */
const POLL_CAPS = Object.freeze({
  question: 300,
  option: 100,
  minOptions: 2,
  maxOptions: 10
});

/** How far past the quota we oversample, since some rows are dropped in JS. */
const OVERSAMPLE = 8;
const MIN_FETCH = 20;
const MAX_FETCH_ROUNDS = 3;

/**
 * Structural eligibility, shared by every candidate query. Contains **no**
 * placeholders so it can be interpolated without disturbing argument order.
 *
 * Any question type is admitted as long as it has 2–10 parseable options, an
 * answer, and a non-empty stem: rows that cannot be rendered as a quiz poll
 * (non-`mcq` types, stems over the 300-char poll cap) are still sent, using the
 * dispatcher's two-message text form. The stem cap here (3500) is far above the
 * live maximum (682) and only exists to keep a message inside Telegram's
 * 4096-char text limit.
 */
const ELIGIBLE_SQL = `q.correct_option IS NOT NULL
          AND q.options_json IS NOT NULL
          AND json_valid(q.options_json) = 1
          AND json_array_length(q.options_json) BETWEEN 2 AND 10
          AND LENGTH(q.question_text) BETWEEN 1 AND 3500
          AND NOT EXISTS (SELECT 1 FROM question_flags f WHERE f.question_id = q.id AND f.is_blocked = 1)`;

/** Already delivered to this channel (successfully). Takes one arg: channel id. */
const NOT_SENT_SQL = `NOT EXISTS (SELECT 1 FROM sent_log s WHERE s.channel_id = ? AND s.question_id = q.id AND s.status = 'sent')`;

/** Previously delivered to this channel. Takes one arg: channel id. */
const WAS_SENT_SQL = `EXISTS (SELECT 1 FROM sent_log s WHERE s.channel_id = ? AND s.question_id = q.id AND s.status = 'sent')`;

const CANDIDATE_COLUMNS =
  'q.id, q.subject_id, q.question_text, q.question_type, q.options_json, q.correct_option, q.explanation';

/**
 * Parse `options_json` into `[{ key, text }]`.
 * Accepts the canonical shape (`[{"key":"A","text":"…"}]`) and a plain string
 * array, which older imports may contain. Returns `[]` for anything unusable.
 */
function parseOptions(optionsJson) {
  if (typeof optionsJson !== 'string' || !optionsJson.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      out.push({ key: null, text: item });
      continue;
    }
    if (item && typeof item === 'object' && typeof item.text === 'string') {
      out.push({ key: item.key === undefined ? null : item.key, text: item.text });
      continue;
    }
    return []; // a malformed entry makes the whole row untrustworthy
  }
  return out;
}

/**
 * Map `correct_option` onto a 0-based option index.
 * Telegram wants `correct_option_id` (an index); the database stores a letter
 * key (`A`), a digit, or — for a handful of dirty rows — free text.
 * @returns {number} the index, or -1 when it cannot be resolved.
 */
function correctOptionIndex(options, correctOption) {
  if (correctOption === null || correctOption === undefined) return -1;
  const raw = String(correctOption).trim();
  if (!raw) return -1;

  // 1. Match against the stored keys ("A" → key "A").
  const byKey = options.findIndex(
    (option) => option.key !== null && String(option.key).trim().toUpperCase() === raw.toUpperCase()
  );
  if (byKey !== -1) return byKey;

  // 2. A bare letter ("A".."J") maps onto position when keys are missing.
  if (/^[A-J]$/.test(raw.toUpperCase())) {
    const index = raw.toUpperCase().charCodeAt(0) - 65;
    if (index < options.length) return index;
  }

  // 3. A bare digit is already an index.
  if (/^\d+$/.test(raw)) {
    const index = Number(raw);
    if (index >= 0 && index < options.length) return index;
  }

  return -1;
}

/**
 * Turn a database row into a Telegram **quiz poll**, or `null` when it cannot
 * be one. This is the single source of truth for pollability.
 *
 * @returns {{question:string, options:string[], correctOptionId:number,
 *            explanation:string|null}|null}
 */
function toPoll(row) {
  if (!row) return null;

  // ADR-009: only a plain MCQ becomes a quiz poll. The other question types
  // (match / statements / assertion_reason) are rendered by the dispatcher's
  // two-message text form, even when they would technically fit a poll.
  if (row.question_type && String(row.question_type) !== 'mcq') return null;

  const question = String(row.question_text === null || row.question_text === undefined ? '' : row.question_text).trim();
  if (!question || question.length > POLL_CAPS.question) return null;

  const parsed = parseOptions(row.options_json);
  if (parsed.length < POLL_CAPS.minOptions || parsed.length > POLL_CAPS.maxOptions) return null;

  const options = parsed.map((option) => String(option.text === null || option.text === undefined ? '' : option.text).trim());
  if (options.some((text) => !text || text.length > POLL_CAPS.option)) return null;

  const correctOptionId = correctOptionIndex(parsed, row.correct_option);
  if (correctOptionId === -1) return null;

  // Telegram rejects a quiz whose options are not all distinct.
  const unique = new Set(options);
  if (unique.size !== options.length) return null;

  return { question, options, correctOptionId, explanation: row.explanation ?? null };
}

/**
 * Is this row usable at all (in text mode we do not need it to be a poll)?
 * A question with an unusable stem is worthless in any format.
 */
function isRenderable(row) {
  if (!row) return false;
  const stem = String(row.question_text === null || row.question_text === undefined ? '' : row.question_text).trim();
  return stem.length > 0;
}

/**
 * Give `count` slots to subjects in proportion to what each still has unsent.
 * Largest-remainder method, with a stable tie-break, so the result is
 * reproducible and the slots always sum to exactly `count` when supply allows.
 *
 * @param {object} available `{ subject_id: unsentCount }`
 * @param {number} count
 * @returns {object} `{ subject_id: quota }`
 */
function allocateProportional(available, count) {
  const entries = Object.entries(available || {}).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((sum, [, n]) => sum + Number(n), 0);
  if (!entries.length || count <= 0 || total <= 0) return {};
  if (count >= total) return Object.fromEntries(entries.map(([subject, n]) => [subject, Number(n)]));

  const quotas = {};
  const remainders = [];
  let used = 0;
  for (const [subject, n] of entries) {
    const exact = (count * Number(n)) / total;
    const base = Math.floor(exact);
    quotas[subject] = base;
    used += base;
    remainders.push({ subject, frac: exact - base, n: Number(n) });
  }

  remainders.sort(
    (a, b) => b.frac - a.frac || b.n - a.n || a.subject.localeCompare(b.subject)
  );
  let leftover = count - used;
  for (const item of remainders) {
    if (leftover <= 0) break;
    if (quotas[item.subject] === 0 && item.n <= 0) continue;
    quotas[item.subject] += 1;
    leftover -= 1;
  }
  return quotas;
}

/**
 * Normalise an explicit `subject_filter_json` map into `{ subject: quota }`.
 * Values are clamped to non-negative integers; unknown keys are dropped.
 * When the quotas overshoot `count`, they are scaled down proportionally.
 */
function allocateExplicit(filter, count, available) {
  const quotas = {};
  const entries = [];
  for (const [subject, rawValue] of Object.entries(filter || {})) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (available && available[subject] !== undefined && available[subject] <= 0) continue;
    entries.push([subject, Math.floor(value)]);
  }
  if (!entries.length) return quotas;

  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (count > 0 && total > count) {
    const scaled = allocateProportional(Object.fromEntries(entries), count);
    for (const [subject, quota] of Object.entries(scaled)) {
      if (quota > 0) quotas[subject] = quota;
    }
    return quotas;
  }
  for (const [subject, n] of entries) quotas[subject] = n;
  return quotas;
}

/**
 * Interleave per-subject groups so consecutive items rarely share a subject.
 * @param {Array<Array>} groups
 */
function interleave(groups) {
  const out = [];
  const queues = groups.filter((group) => Array.isArray(group) && group.length).map((group) => group.slice());
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const queue of queues) {
      if (queue.length) {
        out.push(queue.shift());
        progressed = true;
      }
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.db  Turso client (`lib/turso.js`).
 * @param {object} [opts.log]
 */
function createSelector(opts = {}) {
  const { db, log } = opts;
  if (!db) throw new Error('selector: db is required');

  /**
   * Eligible supply per subject: `total` (everything on offer) and `unsent`
   * (never delivered to this channel). Quotas are allocated over `total`, so a
   * subject whose pool has just been used up can still be topped up from its
   * recycle pool.
   * @returns {Promise<{total:object, unsent:object}>}
   */
  async function availableBySubject(channelId) {
    const rows = await db.all(
      `SELECT q.subject_id AS subject_id,
              COUNT(*) AS n,
              SUM(CASE WHEN ${NOT_SENT_SQL} THEN 1 ELSE 0 END) AS unsent
         FROM questions q
        WHERE ${ELIGIBLE_SQL}
        GROUP BY q.subject_id`,
      [channelId]
    );
    const total = {};
    const unsent = {};
    for (const row of rows) {
      total[row.subject_id] = Number(row.n);
      unsent[row.subject_id] = Number(row.unsent);
    }
    return { total, unsent };
  }

  /** `{ id: name }` for every subject, for readable output. */
  async function subjectNames() {
    try {
      const rows = await db.all('SELECT id, name FROM subjects');
      const out = {};
      for (const row of rows) out[row.id] = row.name || row.id;
      return out;
    } catch (err) {
      if (log) log.warn('subject_names_failed', { error: err.message });
      return {};
    }
  }

  /** One page of random candidates for a subject. */
  function fetchUnsent(channelId, subjectId, limit) {
    return db.all(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM questions q
        WHERE ${ELIGIBLE_SQL}
          AND ${NOT_SENT_SQL}
          AND q.subject_id = ?
        ORDER BY RANDOM()
        LIMIT ?`,
      [channelId, subjectId, limit]
    );
  }

  /** Recycle page: previously sent, oldest first. */
  function fetchRecyclable(channelId, subjectId, limit) {
    return db.all(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM questions q
        WHERE ${ELIGIBLE_SQL}
          AND ${WAS_SENT_SQL}
          AND q.subject_id = ?
        ORDER BY (SELECT MAX(s2.sent_at) FROM sent_log s2
                   WHERE s2.channel_id = ? AND s2.question_id = q.id AND s2.status = 'sent') ASC
        LIMIT ?`,
      [channelId, subjectId, channelId, limit]
    );
  }

  /**
   * Fill one subject's quota, oversampling because some rows fail the JS-level
   * poll check.
   */
  async function fillSubject({ channelId, subjectId, want, pollableOnly, fetchPage }) {
    const chosen = [];
    const seen = new Set();

    for (let round = 0; round < MAX_FETCH_ROUNDS && chosen.length < want; round += 1) {
      const need = want - chosen.length;
      const limit = Math.max(need * OVERSAMPLE, MIN_FETCH);
      const rows = await fetchPage(channelId, subjectId, limit);
      if (!rows.length) break;

      for (const row of rows) {
        if (chosen.length >= want) break;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        if (pollableOnly ? !toPoll(row) : !isRenderable(row)) continue;
        chosen.push(row);
      }

      if (rows.length < limit) break; // exhausted the table for this subject
    }

    return chosen;
  }

  /**
   * Choose the questions for one send.
   *
   * @param {object} selectionOpts
   * @param {number} selectionOpts.channelId    Numeric `channels.id` (0 when unknown).
   * @param {number} [selectionOpts.count]      How many questions to return.
   * @param {object} [selectionOpts.subjects]   Explicit `{ subject_id: quota }`.
   * @param {boolean}[selectionOpts.pollableOnly] Only return poll-capable rows.
   * @param {boolean}[selectionOpts.allowRecycle] Reuse old questions on shortfall.
   * @returns {Promise<{questions:Array, requested:number, available:object,
   *                    unsent:object, bySubject:object, recycled:object,
   *                    shortfall:number}>}
   */
  async function selectQuestions(selectionOpts = {}) {
    const channelId = Number(selectionOpts.channelId) || 0;
    const count = Math.max(0, Math.floor(Number(selectionOpts.count) || 0));
    const pollableOnly = selectionOpts.pollableOnly !== false;
    const allowRecycle = selectionOpts.allowRecycle !== false;

    const result = {
      questions: [],
      requested: count,
      available: {},
      unsent: {},
      bySubject: {},
      recycled: {},
      shortfall: 0
    };
    if (count <= 0) return result;

    const supply = await availableBySubject(channelId);
    result.available = supply.total;
    result.unsent = supply.unsent;

    const quotas = selectionOpts.subjects
      ? allocateExplicit(selectionOpts.subjects, count, supply.total)
      : allocateProportional(supply.total, count);

    const groups = [];
    const shortSubjects = [];

    for (const [subjectId, quota] of Object.entries(quotas)) {
      if (quota <= 0) continue;
      const chosen = await fillSubject({
        channelId,
        subjectId,
        want: quota,
        pollableOnly,
        fetchPage: fetchUnsent
      });
      result.bySubject[subjectId] = chosen.length;
      if (chosen.length) groups.push(chosen);
      if (chosen.length < quota) shortSubjects.push({ subjectId, missing: quota - chosen.length });
    }

    // Recycled fills are appended per subject after the fresh ones, so a live
    // send prefers unseen questions before repeating any.
    let recycledGroups = [];
    if (allowRecycle && shortSubjects.length) {
      for (const { subjectId, missing } of shortSubjects) {
        const chosen = await fillSubject({
          channelId,
          subjectId,
          want: missing,
          pollableOnly,
          fetchPage: fetchRecyclable
        });
        if (chosen.length) {
          recycledGroups.push(chosen);
          result.recycled[subjectId] = chosen.length;
          result.bySubject[subjectId] = (result.bySubject[subjectId] || 0) + chosen.length;
        }
      }
    }

    // Fresh first (interleaved for variety), then recycled, trimmed to `count`.
    const fresh = interleave(groups);
    const reused = interleave(recycledGroups);
    result.questions = fresh.concat(reused).slice(0, count);
    result.shortfall = Math.max(0, count - result.questions.length);
    return result;
  }

  return {
    selectQuestions,
    availableBySubject,
    subjectNames,
    // exposed for the dispatcher and the tests
    fetchUnsent,
    fetchRecyclable
  };
}

module.exports = {
  createSelector,
  parseOptions,
  correctOptionIndex,
  toPoll,
  isRenderable,
  allocateProportional,
  allocateExplicit,
  interleave,
  POLL_CAPS,
  ELIGIBLE_SQL,
  NOT_SENT_SQL,
  WAS_SENT_SQL
};
