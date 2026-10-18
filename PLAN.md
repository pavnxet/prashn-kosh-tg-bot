# PLAN.md — Prashn-Kosh TG Bot

> Daily previous-year-question channel bot for **Prashn-Kosh**.
> Phases 0–4 are built: audit · additive schema applied to Turso · Telegram client + admin auth +
> channel connect · selector + dispatcher · scheduler + idempotency.
> Phase 4 runs under PM2 on a self-hosted Android/Termux device, ticking once a minute and posting a
> daily slot **at most once per day**.
> Last updated: 2026-10-18

> The numbered decisions cited below (ADR-001 … ADR-019) are recorded in full in
> [`docs/DECISIONS.md`](./docs/DECISIONS.md).

---

## 1. Phase 0 — Audit Findings (read-only, from `prashn-kosh`)

| Question from the brief | Verified answer |
|---|---|
| Language / framework | **Node.js (CommonJS)**, no TypeScript, no framework, no build step. Vanilla HTML/CSS/JS frontend. |
| Existing bot code? | **None.** No Telegram code, no `BOT_TOKEN`, no cron, no webhook anywhere in the repo. |
| Hosting today | Vercel serverless (`api/*` thin wrappers → `lib/handlers/*`) + local `server.js` router. `vercel.json` has **no** `crons` block. |
| Question table columns (Open Q #1) | **Resolved.** See below. |
| DB access | `@libsql/client` + `dotenv`; dual mode: Turso cloud (`TURSO_DATABASE_URL`) or local `file:local.db`. |
| Scale of data | **14 subjects, 293 topics, 11,295 questions** (live counts read 2026-10-18 — the repo docs' "13 / 259 / ~1,550" was stale). Devanagari UTF-8. |
| Git state | branch `main`, tag `v1.0.9`; one uncommitted documentation file from a prior session. **Untouched by this work.** |

### 1.1 Existing question schema (verbatim from `scripts/init_db.js`)
```
questions(
  id TEXT PK, subject_id TEXT, topic_id TEXT,
  question_text TEXT, question_type TEXT DEFAULT 'mcq',
  options_json TEXT, correct_option TEXT, explanation TEXT,
  exam_source TEXT, exam_year INTEGER, difficulty TEXT DEFAULT 'medium',
  tags_json TEXT DEFAULT '[]',
  content_hash TEXT, repetition_count INTEGER DEFAULT 1, exam_sources_json TEXT DEFAULT '[]',
  created_at TEXT, updated_at TEXT
)
subjects(id TEXT PK, name, icon, sort_order)
topics(id TEXT PK, subject_id, name, description, sort_order)
```
Field mapping for the bot: **answer → `correct_option`** (canonical `A`–`E`),
**explanation → `explanation`**, **subject/year → `subject_id`/`exam_year`**,
**difficulty → `difficulty`**, **format → `question_type`** ∈ {`mcq`, `match`, `assertion_reason`, `statements`}.

### 1.2 Blocking constraint discovered
**Vercel Hobby Cron runs at most once per day**, so the brief's "every-minute scheduler"
cannot run on the existing Vercel deployment. This is the reason for the hosting decision below.

### 1.3 Prior art
`telegram-quiz-bot/` exists but contains **documentation only** (no code):
`TELEGRAM_QUIZ_IMPLEMENTATION_PLAN.md`, `DECISIONS.md`, `learning.md`, `summary.md`. Left as-is; not depended on.

---

## 2. Decisions Taken (with the user)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Host on the J7 Max micro-server** (Termux, PM2; verified Node v24.18.0, `armv8l`) | Always-on, free, precise per-minute scheduling. |
| D2 | **Long polling**, not webhooks | J7 is LAN-only (`192.168.1.100`): no public URL, TLS or inbound port. |
| D3 | **New sibling folder** `prashn-kosh-tg-bot` | Keeps the Vercel app and its prod branch untouched. |
| D4 | **Zero runtime dependencies** (own `.env` parser, `fetch` HTTP, `node:test`) | Avoids Bionic/32-bit native-module failures and the < 50 MB RAM budget. |
| D8 | **Questions come from Turso**, not the J7's local SQLite file | That file is a stale hand-copy (6,199 questions vs 11,295). See ADR-012. |
| D9 | `parse_mode: 'HTML'` with all interpolated values escaped | Legacy Markdown broke `/start`+`/help` live (`can't parse entities`). See ADR-011. |
| D5 | **Additive schema only** — bot owns new tables; never alters `questions`/`subjects`/`topics` | Protects production data. |
| D6 | **Poll mode limited to in-limit `mcq`**; text + answer sheet otherwise | Telegram caps: 300/100/200 chars, 2–10 options. |
| D7 | `prashn-kosh` repo work stays on `testingbyopencode`, no push | Repo's recorded workflow. **No `prashn-kosh` files were changed in this session.** |

Recorded in detail as ADR-001…ADR-012 in [`docs/DECISIONS.md`](./docs/DECISIONS.md).

---

## 3. Data Model — **APPLIED** to the shared Turso DB on 2026-10-18

All statements are additive `CREATE TABLE IF NOT EXISTS`. **Corrections vs the brief's §1.5 are marked ⚠.**
This is now the live schema (`migrations/001_bot_schema.sql`); a re-run is a verified no-op.

```sql
CREATE TABLE IF NOT EXISTS bot_admins (
  tg_user_id INTEGER PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','editor')),
  added_by   INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_chat_id  INTEGER UNIQUE NOT NULL,
  title       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,            -- ⚠ added
  timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_settings (
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,                          -- ⚠ renamed from `value` (it is JSON)
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,         -- ⚠ added
  PRIMARY KEY (channel_id, key)
);

CREATE TABLE IF NOT EXISTS schedules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id       INTEGER NOT NULL REFERENCES channels(id),
  send_time        TEXT NOT NULL,                    -- 'HH:MM' in the channel timezone
  days_of_week     TEXT NOT NULL DEFAULT '1111111',  -- Mon..Sun
  question_count   INTEGER NOT NULL DEFAULT 10,
  gap_seconds      INTEGER NOT NULL DEFAULT 5 CHECK (gap_seconds >= 3),
  subject_filter_json TEXT,                          -- e.g. {"rajasthan_history":3,"mathematics":3}
  format           TEXT NOT NULL DEFAULT 'poll',     -- ⚠ 'poll' | 'text'
  is_active        INTEGER NOT NULL DEFAULT 1,
  last_run_date    TEXT,                             -- 'YYYY-MM-DD' channel-tz (idempotency guard)
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP    -- ⚠ added
);

CREATE TABLE IF NOT EXISTS sent_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   INTEGER NOT NULL REFERENCES channels(id),
  question_id  TEXT NOT NULL,                        -- ⚠ TEXT (matches questions.id), not INTEGER
  schedule_id  INTEGER REFERENCES schedules(id),
  run_date     TEXT NOT NULL,                        -- ⚠ 'YYYY-MM-DD' channel-tz
  tg_message_id INTEGER,
  sent_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  status       TEXT NOT NULL DEFAULT 'sent',         -- ⚠ 'sent' | 'failed' | 'skipped'
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sent_log_channel_question ON sent_log(channel_id, question_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sent_log_slot_question ON sent_log(schedule_id, run_date, question_id); -- ⚠ idempotency
CREATE INDEX IF NOT EXISTS idx_schedules_active_time ON schedules(is_active, send_time);

CREATE TABLE IF NOT EXISTS question_flags (
  question_id TEXT PRIMARY KEY,                      -- ⚠ TEXT (matches questions.id)
  reason      TEXT,
  flagged_by  INTEGER,
  is_blocked  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_state (                -- ⚠ small KV for cursors/cycle markers
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**Why the ⚠ changes:** `questions.id` is `TEXT`, so `sent_log.question_id` and
`question_flags.question_id` must be `TEXT` or every join breaks. `run_date` +
the unique index `uq_sent_log_slot_question` are what actually make the scheduler
idempotent (the brief only had `last_run_date`). libSQL does not enforce foreign keys by
default, so deletes are done explicitly in one pipeline (ADR-004).

**No-repeat / cycle reset:** candidates = questions matching the schedule's subject quotas
and filters, excluding `question_flags.is_blocked = 1`, excluding `question_id`s already in
`sent_log` for that channel. When candidates run out, the cycle resets (recorded in
`bot_state`) and admins are notified.

---

## 4. Module Map (target)

```
prashn-kosh-tg-bot/
├── src/index.js            # ✅ built  — entry: config → Turso → getMe → poll loop
├── lib/config.js           # ✅ built  — .env loader + validated config (incl. MENU_LANG)
├── lib/logger.js           # ✅ built  — JSON logger + secret redaction
├── lib/turso.js            # ✅ built  — zero-dep HTTP pipeline client (execute/all/get)
├── lib/telegram.js         # ✅ built  — getUpdates/sendMessage/sendPoll, 429 backoff, poll limits
├── lib/admin.js            # ✅ built  — OWNER_TG_ID + bot_admins auth + audit_log
├── lib/channels.js         # ✅ built  — connect/verify/list/pause/resume/remove
├── lib/router.js           # ✅ built  — command parsing, admin gating, DM replies
├── lib/messages.js         # ✅ built  — en | hi strings (MENU_LANG)
├── lib/selector.js         # ✅ built  — per-subject quota, pollability, recycle
├── lib/dispatcher.js       # ✅ built  — quiz-poll/text render, gap pacing, sent_log
├── lib/scheduler.js        # ✅ built  — tick engine: due-slot + TZ + catch-up + owner alerts
├── lib/schedules.js        # ✅ built  — schedule store + pure slot rules (isSlotDue)
├── lib/settings.js         # ⏳ planned — channel_settings helpers
├── lib/menu.js             # ⏳ planned — inline-button menus, callback routing
├── migrations/             # ✅ applied — 001_bot_schema.sql + safety-checked run.js
└── tests/                  # ✅ built  — node --test suite (126 tests, network-free)
```

---

## 5. Phased Roadmap

| Phase | Work | Done when | Status |
|---|---|---|---|
| 0 | Audit + decisions | Written findings & open questions answered | ✅ **done** |
| 1 | Skeleton: scaffold, memory files, config/env, logging | `npm run check` + `npm test` pass | ✅ **done** |
| 1b | Migration runner + additive schema | New tables exist in Turso (additive only) | ✅ **done** — 8 tables + 3 indexes live; source counts unchanged; re-run is a no-op |
| 2 | Telegram client + admin auth + channel connect | Non-admins rejected; posting rights verified | ✅ **done** — 82/82 tests; live `getMe` + long-poll verified; no channel posted to |
| 3 | Selector + dispatcher (poll/text) + `/sendnow` + `/preview` | Correct set appears in a **test** channel / DRY_RUN | ✅ **done** — 126/126 tests; live read-only selection verified against Turso |
| 3.1 | Non-pollable → two-message text fallback; enable live channel posting | Nothing renderable is dropped; approval given | ✅ **done (2026-10-18)** — 129/129 tests; eligible supply 10,324 → **11,294**; live mixed draw verified read-only (7 polls + 1 text); `DRY_RUN=false` on the live `.env` (ADR-014 + ADR-015) |
| 4 | Scheduler + idempotency + 429 retries | Sends on time; rerun creates no duplicates | ⛔ |
| 5 | Inline settings menu + header/footer templates | Each setting changes via button and takes effect | ⛔ |
| 6 | Answer sheet, pin, silent, pause/resume | Admin flows complete | ⛔ |
| 7 | Question management: `/addq`, CSV/JSON import-export, flagging | Import works; blocking works | ⛔ |
| 8 | `/stats`, alerts, backup, i18n (Hindi/English) | `/stats` + owner alerts work | ⛔ |
| 9 | Tests, README, J7 deploy guide | `npm test` green; PM2 deploy verified | ⛔ |

**Commands live now:** `/start`, `/help`, `/id`, `/status`, `/connect <chat_id>`,
`/channels`, `/pause <chat_id>`, `/resume <chat_id>`, `/admins`, `/preview [count]`,
`/sendnow [count] [chat_id] [text]`.
**Commands planned:** `/settings`, `/stats`, `/template`, `/exportq`.
**Reliability targets:** per-minute tick, `retry_after` backoff, bounded retries, owner DM on
serious failure, `audit_log` for every admin action.

---

## 6. Remaining Open Questions

1. **Channels**: how many channels, and are their `-100…` chat IDs available yet? Is there a
   dedicated **test channel** for dry-run verification? — *still open; the bot is
   @YourBot and `/connect` is ready the moment an id is supplied.*
2. **Bot**: ✅ **answered** — token exists and is live (`@YourBot`, id `123456789`).
   The bot must be added to each channel as an **admin with "Post messages"** (`/connect`
   verifies this and refuses the channel if it is missing).
3. **Content selection default**: ✅ **answered (2026-10-18)** — **per-subject quota**, configured
   per channel. Each channel gets a quota map (e.g. `{history: 3, maths: 3, science: 2}`) plus a
   fill rule for short subjects; `difficulty` defaults to "any" unless the channel overrides it.
   See ADR-010.
4. **Question volume / exhaustion**: ✅ **answered (2026-10-18)** — **reset the cycle and reuse**,
   and DM the admins that recycling started (now implemented: `allowRecycle` fills from the
   least-recently-sent rows and reports the subjects in `selection.recycled`). See ADR-010.
   ✅ *Risk tested live (2026-10-18):* Telegram **accepted the same quiz poll twice** in the same
   chat (owner's DM, probes deleted after), so recycled poll-mode questions are safe to re-send —
   no text-only fallback is needed for recycling.
5. **Answer sheet**: ✅ **clarified (2026-10-18)** — the answer is **not** a separate message for
   normal questions: they go out as **native Telegram quiz polls** (`type: quiz` +
   `correct_option_id` + `explanation`), so the answer is intrinsic and the user gets instant
   correct/wrong feedback plus the explanation via the lamp icon. A separate answer sheet is only
   needed for the minority that cannot be polls — see ADR-009.
6. **i18n**: ✅ **answered (2026-10-18)** — **English** menus by default; the Hindi table is
   complete and switchable with `MENU_LANG=hi`.
7. **The ~11% that cannot be polls**: ✅ **answered (2026-10-18)** — the user chose **two messages**
   (one for the question, one for the options). Implemented as: `/preview` and `/sendnow` default to
   `pollableOnly: false`; each row is rendered as a quiz poll when it is a plain `mcq` that fits the
   caps, otherwise as **two text messages** — the stem first, then the options with `Answer: …` and
   the explanation. Polls are gated to `mcq` in `toPoll()` so a short `match`/`statements`/
   `assertion_reason` row still uses the text form (ADR-009 kept). Structural eligibility widened to
   any type with 2–10 options and a stem ≤3500, raising live eligible supply **10,324 → 11,294**.
   `sent_log` is written once per question after both messages confirm. See ADR-014.

---

## 7. Known Limitations (to keep in README + bot help)

- **No channel leaderboards.** Telegram channel quiz polls are anonymous; per-user answers are
  never delivered to bots. Per-user scoring would require a DM practice mode or a linked
  discussion group (a future item, not built).
- **Poll mode is length-capped, but that no longer drops questions.** Poll mode covers
  `question_type='mcq'` rows whose stem is ≤300 chars and whose `correct_option` resolves to a real
  option — **10,142** of 11,295 rows (verified live 2026-10-18). Since ADR-014, everything else goes
  out as **two text messages** instead of being skipped, so **11,294** rows are postable (the one
  exclusion has no `correct_option`). The text form *shows* the answer rather than asking.
- **Single small host.** The J7 Max is a 4 GB phone; the bot is one lean process with no
  heavy media work. If uptime requirements grow, an external uptime check or a small VPS may
  be warranted.
- **Shared DB token.** Turso tokens are database-wide (no per-table grants); the bot avoids
  touching source tables by convention + code review, not by DB permissions.

---

## 8. Approval Gate — what happens on "go"

**Phase 1b (completed 2026-10-18)** added, **without touching any `prashn-kosh` file**:
1. ✅ `migrations/001_bot_schema.sql` — exactly the §3 statements (8 tables, 3 indexes).
2. ✅ `migrations/run.js` — applies statements via one Turso HTTP pipeline; dry-run by default,
   `--apply` to execute, `--env-file` to reuse credentials in place.
3. ✅ Verification: lists created tables/indexes and confirms row counts of
   `questions`/`subjects`/`topics`/`sub_subjects`/`quiz_attempts`/`import_batches`/`staged_questions`
   are **unchanged** (they were), then re-run proved idempotency.
4. ✅ `tests/migrations.test.js` — asserts the executable SQL has no `DROP`/`ALTER`/`TRUNCATE` and
   no `INSERT`/`UPDATE`/`DELETE`, that it names no source table, and that every statement is
   `CREATE … IF NOT EXISTS`.

**Phase 2 (completed 2026-10-18)** added, again **without touching any `prashn-kosh` file**:
1. ✅ `lib/telegram.js` — long polling, `sendMessage`/`sendPoll`, `retry_after` backoff, local
   enforcement of every Telegram poll/text limit, and **token-sanitised** errors.
2. ✅ `lib/admin.js` — owner from `OWNER_TG_ID` (DB-free), delegated roles in `bot_admins`,
   `audit_log` for every decision and mutation.
3. ✅ `lib/channels.js` — `/connect` verifies via `getChat` + `getChatMember` that the bot is an
   admin **with posting rights** before the channel is stored.
4. ✅ `lib/router.js` + `lib/messages.js` — command gating (non-admins rejected) and
   en|hi strings; privileged replies go to the caller's DM, never to a group.
5. ✅ Verification: `npm test` **70/70**; live `getMe` (@YourBot) and a 10 s
   long-poll smoke test; no channel message was sent and no channel was written to.

**Phase 3 (built 2026-10-18, not yet posted to any channel)** added, again **without touching any
`prashn-kosh` file**:
1. ✅ `lib/selector.js` — per-subject quota (explicit map, else proportional to supply via
   largest-remainder), authoritative `toPoll()` pollability check, oversampled fill, and a
   recycle pass that reuses the least-recently-sent rows and reports them. `sent_log` is only
   ever read here.
2. ✅ `lib/dispatcher.js` — quiz-poll or text rendering, 200-char explanation cap, gap pacing
   between sends, and a `sent_log` write **only after Telegram confirms** (a failure is logged
   `status='failed'` and stays eligible for retry).
3. ✅ `lib/router.js` — `/preview [count]` (always the caller's own chat, never records) and
   `/sendnow [count] [chat_id] [text]` (posts to an active channel, or to the caller only while
   `DRY_RUN=true`), plus new `en`/`hi` strings in `lib/messages.js`.
4. ✅ Tests: `tests/selector.test.js`, `tests/dispatcher.test.js`, extended `tests/router.test.js`
   and `tests/support/fakes.js` → `npm test` **126/126** (was 82).
5. ✅ Verification: `npm run check` → `db_ok` + `telegram_ok` with `phase-3-sender`; a read-only
   live probe ran the real selector over Turso (14 subjects, 10,324 eligible, a 5-question
   proportional draw rendered as 5 polls with correct answers). **No channel message was sent and
   no `sent_log` row was created.**

**Phase 4 (built 2026-10-18, nothing scheduled yet)** added, again **without touching any
`prashn-kosh` file**:
1. ✅ `lib/schedules.js` — the schedule store (`listAll`/`listForChannel`/`findById`/`create`/
   `setActive`/`remove`/`markRun`/`ensureDefault`) plus the **pure** slot rules
   (`parseSendTime`, `normaliseDays`, `zonedNow`, `isSlotDue`). `isSlotDue` returns a
   machine-readable reason (`not_yet`, `already_ran`, `missed_window`, `not_scheduled_today`,
   `inactive`, `no_schedule`, `due`) so the engine's decisions are testable without a clock.
2. ✅ `lib/scheduler.js` — one 60 s tick: read every schedule **once**, decide per slot in the
   channel's own timezone, then dispatch → `markRun`. Fires **once per day** via
   `schedules.last_run_date`; a slot reached after the catch-up window is **skipped, never
   replayed**; a *selection* failure is retried up to **3** times inside the window and only then
   burns the slot and DMs the owner; the owner is also DMed for failures, partial sends, an empty
   pool, recycling and dry runs. `DRY_RUN` sends the items to the owner with `record:false` but
   still marks the slot spent. See ADR-016.
3. ✅ `lib/router.js` — `/schedule [list]`, `/schedule add [HH:MM] [count] [chat_id] [days] [text]`,
   `/schedule default`, `/schedule enable|disable|remove <id>`; a bare time (`/schedule 08:00`) means
   `add`. A successful `/connect` now creates the standard **08:00 daily, 10 questions** slot for
   that channel (never touching a channel that already has one). `en`/`hi` strings added.
4. ✅ `tests/schedules.test.js` + `tests/scheduler.test.js` (pure rules, store CRUD, and the engine's
   fire-once / no-replay / dry-run / retry / failure-DM behaviour), extended `tests/router.test.js`
   and `tests/support/fakes.js` → `npm test` **185/185** (was 129).
5. ✅ Verification: `npm run check` → `db_ok` + `telegram_ok` with `phase-4-scheduler`; a read-only
   live probe ran the real store + tick against Turso (`schedules` empty → `listAll []`,
   `countForChannel(1) 0`, `tick` → `due: 0`) with a **stub** Telegram client that throws if called.
   **No channel message was sent and no row was written.**

**Armed:** a channel created by `/connect` gets the standard slot — **08:00, every day, 10 questions**,
format `poll` — as one row in `schedules`, via `ensureDefault(channelId)`; a channel that already has a
schedule is never touched. To rehearse first, run `/preview 10`; to park it, `/schedule disable <id>`
(keeps the row) or `/schedule remove <id>` (deletes it).

**Deployed:** the bot runs under PM2 on a self-hosted Android/Termux device (`fork_mode`,
node **v24.18.0**, `android/arm`). `pm2 save` persists it and a boot script restores it with
`pm2 resurrect`. The developer copy is **stopped** — one token admits exactly one poller (ADR-017).
