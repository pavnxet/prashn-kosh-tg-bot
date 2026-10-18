# Architectural Decision Records (ADRs)

These records capture *why* the bot is built the way it is — the constraints behind each choice, the
alternatives that were rejected, and the consequences that were accepted. They are numbered in the
order the decisions were made, and are referenced from [`../README.md`](../README.md) and
[`../PLAN.md`](../PLAN.md).

## ADR-001: Standalone bot service in a sibling folder, deployed to the J7 Max
- **Date**: 2026-10-18
- **Context**: The bot needs an every-minute scheduler. `prashn-kosh` is deployed on Vercel Hobby, where Cron is limited to once-per-day, so the scheduler cannot live there. A Cloudflare Worker (`*/1` cron) is possible but the repo is CommonJS+Node and a Worker would need a separate ESM/libSQL-client codebase. The user owns a 24/7 PM2-managed Samsung J7 Max micro-server.
- **Decision**: Build a standalone Node.js service in a new sibling folder `prashn-kosh-tg-bot`, deployed to the J7 Max under PM2. It connects to the **same Turso DB** as `prashn-kosh` for reading questions.
- **Consequences**: Precise per-minute scheduling with a single always-on process; direct reuse of Node idioms; `prashn-kosh` production code and its Vercel deployment are untouched.

## ADR-002: Zero native dependencies; direct Turso HTTP pipeline; long polling
- **Date**: 2026-10-18
- **Context**: The J7 is `armv7l`/Bionic (native prebuilds unreliable) with a < 50 MB RAM budget, and is LAN-only (no public ingress for a webhook).
- **Decision**:
  1. Telegram Bot API client written against Node 20 global `fetch`, using **long polling** (`getUpdates`).
  2. Turso access via the **HTTP pipeline API** directly (no `@libsql/client`, no native `libsql`).
  3. CommonJS source, no build step, no runtime framework.
- **Consequences**: No native-module install risk, no bundler, low memory, no inbound port/TLS requirement. `.env` is parsed by a ~20-line internal parser (no `dotenv` dependency).

## ADR-003: Additive `prashn-kosh`-style schema in the shared Turso DB, with corrected key types
- **Date**: 2026-10-18
- **Context**: The plan (§1.5) suggested `sent_log.question_id INTEGER` and simple indexes, but `prashn-kosh.questions.id` is **TEXT** and the plan's idempotency story needs an explicit run-date key.
- **Decision**: Create the bot tables with additive `CREATE TABLE IF NOT EXISTS`; key corrections:
  - `sent_log.question_id TEXT` (matches `questions.id`), plus `run_date TEXT`.
  - `question_flags.question_id TEXT` (matches `questions.id`).
  - Unique index `uq_sent_log_slot_question (schedule_id, run_date, question_id)` for idempotency.
  - Indexes `idx_sent_log_channel_question (channel_id, question_id)` and `idx_schedules_active_time (is_active, send_time)`.
  - Added `channels.is_active`/`timezone`, `channel_settings.updated_at`, `schedules.format`/`created_at`, `sent_log.status`, and a small `bot_state` key-value table.
- **Consequences**: No double-posting, correct joins against `questions`, and room for per-channel config. Existing tables are never altered.

## ADR-004: Pipeline-batched Turso writes; explicit cascade deletes
- **Date**: 2026-10-18
- **Context**: Cross-region HTTP round-trips are the dominant latency cost; libSQL does not enforce foreign keys by default.
- **Decision**: Bundle related statements into one `/v2/pipeline` request. Never rely on `ON DELETE CASCADE`; delete child rows explicitly in the same pipeline as the parent.
- **Consequences**: Fast, deterministic writes with no orphaned rows. (Mirrors `prashn-kosh` ADR-005 `db.batch()` lesson.)

## ADR-005: Quiz-poll mode restricted to in-limit `mcq`; text mode with answer sheet otherwise
- **Date**: 2026-10-18
- **Context**: Telegram caps poll questions at 300 chars, options at 100 chars, explanations at 200 chars, 2–10 options. Prashn-Kosh contains long stems and `match`/`assertion_reason`/`statements` formats that cannot fit.
- **Decision**: `format = 'poll'` is only used when `question_type = 'mcq'` and all strings fit the caps; otherwise the bot falls back to a plain-text MCQ message and posts an answer-sheet message at the end of the set.
- **Consequences**: No silent truncation or API errors; every question is deliverable. Channel poll answers stay anonymous (no per-user scoring — documented limitation).

## ADR-006: Dry-run-first migration runner with executable-SQL assertion and post-apply count verification
- **Date**: 2026-10-18
- **Context**: The bot writes into the **shared production Turso DB** that also serves the live `prashn-kosh` web app. A bad migration is unrecoverable-by-convention: Turso tokens are database-wide (no per-table grants), so nothing at the DB level stops a stray `DROP`/`UPDATE` on source tables (see `PLAN.md` §7).
- **Decision**:
  1. `migrations/run.js` is a **dry run by default**; it only touches the DB with an explicit `--apply`.
  2. Before executing, it asserts the **executable** SQL (comments stripped) contains none of `DROP`/`ALTER`/`TRUNCATE`/`INSERT`/`UPDATE`/`DELETE`/`REPLACE`. The prose header comment may name them; the statement body may not.
  3. After applying, it re-counts `questions`/`subjects`/`topics`/`sub_subjects`/`quiz_attempts`/`import_batches`/`staged_questions` and **fails** if any row count drifted, then verifies every expected table/index exists.
  4. All DDL is `IF NOT EXISTS`, so re-running is a no-op (verified: a second `--apply` left counts identical).
  5. Secrets are not copied between projects: the runner accepts `--env-file <path>` so it can reuse `prashn-kosh/.env` in place.
- **Consequences**: The same guarantees are enforced in CI-style tests (`tests/migrations.test.js`) and at apply time. A future bot migration that is not purely additive cannot be run without editing the guard, which is itself a reviewed change.

## ADR-007: Owner authority lives in the environment; the DB holds only delegated roles
- **Date**: 2026-10-18
- **Context**: Admin lists are the classic way a bot gets hijacked: if "who is owner" is a database row, a single bad write (or a compromised token) can promote an attacker, and there is no out-of-band way back in. But hard-coding every admin in `.env` means editing a file and restarting to add a helper.
- **Decision**:
  1. `OWNER_TG_ID` (env) is the **only** source of ownership. `isOwner()` never touches the database, so ownership is checkable even when Turso is unreachable.
  2. Everyone else lives in `bot_admins` with a `CHECK (role IN ('owner','admin','editor'))` role. `addAdmin()` refuses to grant `owner`; `removeAdmin()` refuses to remove the owner.
  3. `requireAdmin()` and every mutation append to `audit_log` (including refusals, as `access_denied`).
  4. An audit write failure is caught and logged — it never blocks or changes an access decision.
- **Consequences**: Recovery from a compromised admin list is "fix `OWNER_TG_ID`, revoke the token". Adding day-to-day admins needs no restart. Role separation exists (`editor` vs `admin`) for later phases that will use it.

## ADR-008: Phase 2 sends only to the invoking admin's DM — never to a channel
- **Date**: 2026-10-18
- **Context**: Phase 2 introduces the first code that can call `sendMessage`. The danger is an admin testing `/connect` or `/status` in a group and the bot answering there, exposing channel ids and the admin list to members.
- **Decision**:
  1. `PUBLIC_COMMANDS` (`/start`, `/help`, `/id`) answer in the originating chat.
  2. Every privileged reply is sent to `update.message.from.id` — the admin's private chat — never to `message.chat.id`.
  3. `lib/channels.js` `connect()` performs `getChat` + `getChatMember` only. No router or channel code path can post to a channel id; channel sending is exclusively the Phase 3/4 dispatcher's job.
  4. Inline-menu button presses are acknowledged with a placeholder message until `lib/menu.js` lands in Phase 5.
- **Consequences**: Nothing this phase can spam or leak into a channel, and the `DRY_RUN` question becomes irrelevant for Phase 2 because channel posting does not exist yet. `/connect` still proves posting rights, so a misconfigured channel fails at connect time rather than silently at send time.

## ADR-009: A question is a native Telegram **quiz poll** — a separate answer sheet is an exception, not the rule
- **Date**: 2026-10-18
- **Context**: The brief's phrase "text + answer sheet fallback" could be read as "every question is a text message followed by an answer sheet". That would be worse for the majority of the data: Telegram has a purpose-built quiz poll format that embeds the correct answer, gives the user instant feedback, and shows the explanation on demand — with no extra message to post or keep in sync.
- **Decision**:
  1. Any question that fits becomes a **quiz poll**: `type: 'quiz'`, `correct_option_id` (**0-based** index into the options array), and `explanation` when the DB has one.
  2. The answer is therefore intrinsic to the message. **No answer sheet is sent for poll-mode questions.**
  3. A text + answer-sheet path exists **only** for items a poll cannot represent: stems over 300 chars, more than 10 or fewer than 2 options, option labels over 100 chars, or `question_type` ∈ {`match`, `statements`, `assertion_reason`}.
  4. `lib/telegram.js` already rejects an over-limit poll locally (`validatePoll`) instead of burning a Bot API call on it, so the dispatcher can decide the format from a pure length/type check before sending.
- **Consequences**: The common case is one self-contained message per question with real engagement data (the bot sees poll answer counts via updates if we later add `poll_answer` to `allowed_updates`). The exception path is small: the long stems plus the non-MCQ-typed items (≈11% of the bank). **Resolved by ADR-014 (2026-10-18)**: those rows are neither skipped nor sent as one blob — they go out as **two text messages** (stem, then options+answer), and polls are gated to `mcq` only.

## ADR-010: Per-subject quotas, and recycle the pool instead of stopping
- **Date**: 2026-10-18
- **Context**: With 11,295 questions live and ~20/day per channel the pool lasts roughly 18 months. Two questions were open: what a daily set contains, and what happens at the end of the pool.
- **Decision** (user-chosen 2026-10-18):
  1. A daily set honours a **per-subject quota** stored per channel (e.g. `{history: 3, maths: 3, science: 2}`) rather than drawing uniformly from all 14 subjects, so small subjects cannot be starved by large ones.
  2. When a channel has seen everything, the bot **resets the cycle and reuses** questions, and DMs the admins that recycling began. It does not stop.
  3. The no-repeat guarantee is scoped per channel and per cycle, so `sent_log` stays append-only; a reset is recorded rather than deleting history.
- **Consequences**: `sent_log` grows without bound (a few thousand rows per channel per cycle — trivial for libSQL) and must never be deleted to "reset". ✅ **Risk resolved (verified live 2026-10-18)**: the "does Telegram reject the same quiz twice?" question was tested by sending **the identical quiz poll twice to the owner's own private DM** (`123456789`) — Telegram accepted both (`message_id` 521 and 522). So **recycling poll-mode questions re-sent to the same chat is safe**; no text-only fallback is needed for recycled items, and this ADR stands as written. (The two probe messages were deleted afterwards.)

## ADR-011: `parse_mode: 'HTML'` with universal value escaping (supersedes legacy Markdown)
- **Date**: 2026-10-18
- **Context**: `/start` and `/help` failed **in live testing** with `400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 362`. Root cause: `parse_mode: 'Markdown'` treats `_` and `*` as entity delimiters, and the help text contained `<chat_id>` placeholders. The `_` in `/connect <chat_id>` opened an italic run, the `_` in `/resume <chat_id>` closed it, and the `_` at byte 362 opened another that nothing closed — so Telegram rejected the whole message. The same class of failure applied to *data*: a channel titled `My_Channel*` or containing `<b>` would have broken `/connect` at runtime, arbitrarily far from the code that caused it.
- **Decision**:
  1. Render every message as **HTML** (`PARSE_MODE = 'HTML'`, exported from `lib/messages.js` and used by the router's single `send` helper).
  2. Templates may contain only tags Telegram supports; `<` in text must be written `&lt;`.
  3. `t(key, vars)` **escapes every interpolated value** (`&`, `<`, `>`), so data can never open a tag. Markup cannot be injected from a channel title, an error message or an id. `format()` escapes by default too and takes `{ escape: false }` for the rare deliberate case.
  4. Menu copy that was Markdown-formatted moved into `messages.js` (`connect_hint`, `admins_none`) so no markup lives in `lib/router.js`.
  5. `tests/support/html.js` validates any string against Telegram's HTML rules (tag whitelist, balanced tags, no raw `<`/`>`, no bare `&`); `tests/messages.test.js` runs it over **every key in every language**, and `tests/router.test.js` runs it over real handler output plus a hostile channel title.
- **Consequences**: The failure mode is now caught by `npm test` instead of in production. Verified live: the exact old string still returns `can't parse entities ... byte offset 362`, while the new string parses cleanly (probe sent to an invalid chat id, so nothing was delivered). Any future message must pass the validator; adding a raw `<` to a template is now a test failure.

## ADR-012: Turso remains the question source — the J7's local SQLite file is a stale hand-copy
- **Date**: 2026-10-18
- **Context**: The user asked to use "the db from the J7 server" and showed `sqlite3.connect('~/databases/prashn-kosh.db')`. Investigation (read-only, over SSH) found that file is **not** the live database: it is a **manual copy taken from the PC on 2026-10-02** holding **6,199** questions, while the shared Turso DB holds **11,295** with newer timestamps. The J7's own dashboard history records the copy verbatim ("Replace without backup"), there is **no crontab**, and the `db-backup` PM2 service only dumps local DBs *outward* — nothing pulls from Turso. 
- **Decision** (user-chosen 2026-10-18): **Keep Turso** as the bot's question source. Rejected alternatives and why:
  1. *Point the bot at `~/databases/prashn-kosh.db`* — rejected: 45% of the bank is missing, and the file is **replaced wholesale** on every manual refresh, which would silently wipe `channels`/`schedules`/`sent_log` and cause old questions to re-post.
  2. *Local SQLite seeded from the newest PC copy* (`a newer local snapshot`, 10,913 questions, Oct 6) — viable but frozen 382 questions behind Turso with no refresh path.
  3. *Local SQLite with a Turso sync job* — deferred as an option, not built. It would need a bot-owned file (never the hand-copied snapshot) plus a sync step, and buys nothing while the J7's outbound internet is available.
- **Consequences**: Zero new code; the already-migrated, live-verified Turso path is unchanged. The J7 needs outbound HTTPS only. **Recorded for the future**: if an offline-first build is ever wanted, the J7 runs **Node v24.18.0** with **`node:sqlite` built in**, so local SQLite is achievable with **no native module** — and the bot's state must live in a file the bot owns, never in the hand-copied snapshot.

## ADR-013: Two-layer question selection — SQL narrows, JS decides; quotas over total supply; oldest-first recycle
- **Date**: 2026-10-18
- **Context**: Phase 3 had to answer "which questions go out" precisely, and the tempting shortcut (do it all in one clever SQL query) fails for two reasons. First, "can this row become a Telegram quiz poll?" is a rich rule — `question_type`, 2–10 options, stem ≤300, every option label ≤100, and a `correct_option` letter that must map onto a real option index. Expressing that in SQL means `json_each` gymnastics that still diverge from the JS that actually renders the poll. Second, the per-subject quota has to stay meaningful even when a subject's unsent pool is small: if quotas are allocated only over *unsent* rows, a nearly-exhausted subject contributes almost nothing and its quota silently collapses.
- **Decision**:
  1. **Two layers.** SQL applies only cheap structural predicates (`question_type`, not blocked, not already sent for this channel). **`toPoll()` in `lib/selector.js` is the single authoritative pollability check** — the same function the dispatcher's `validatePoll` path relies on, so "selectable" and "sendable" can never disagree.
  2. **Quotas are allocated over the total eligible supply per subject**, not just the unsent remainder. The unsent rows are taken first; whatever a subject cannot cover from its unsent rows is filled from its recycle pool. This keeps small subjects represented instead of letting one huge subject absorb the whole batch.
  3. **Oversample then trim.** SQL fetches more candidates per subject than the quota needs (`OVERSAMPLE`), then JS trims to the quota after the pollability filter, so a few unrenderable rows cannot leave a subject short.
  4. **Proportional by default, explicit when set.** With no configured quota map, the batch is split by each subject's share of eligible supply using **largest remainder**; an explicit map overrides this. `interleave()` mixes the subjects so the channel does not get five questions of one topic in a row.
  5. **Recycle is oldest-first and reported.** When the fresh pool is empty the selector reuses the **least-recently-sent** rows and returns them in `selection.recycled`, per subject, so the admins are told exactly what was reused. `sent_log` is never deleted to "reset" (ADR-010).
  6. **Recording is post-confirmation only.** The dispatcher writes `sent_log` **after** Telegram confirms a send, never in preview and never before. A failed send is written `status='failed'`, which keeps the row eligible for a later retry instead of silently burning it.
  7. **Default format is polls-only.** `/sendnow` and the future scheduler select pollable rows only; `/sendnow … text` (and `pollableOnly: false`) opts into the text-with-answer form for the ~11% a poll cannot represent. A row that slips through is still rendered as text by `renderItem`, never as a malformed poll. *Superseded by ADR-014 (2026-10-18): the default is now `pollableOnly: false` with a per-row poll/text decision, and the text form is two messages.*
- **Consequences**: The selection rule lives in one testable module (22 selector cases + 17 dispatcher cases) and the SQL stays simple and index-friendly. The cost is one extra JS pass per batch — negligible at 30 questions. Live read-only verification against Turso (2026-10-18) exercised exactly this path: 14 subjects, 10,324 eligible rows, and a 5-question proportional draw came back as 5 different subjects rendered as 5 valid quiz polls with the correct answer each. The `sent_log`-unique-index idempotency from ADR-004/ADR-010 is untouched because a manual send uses a NULL `schedule_id`, so manual and scheduled slots can never collide.

## ADR-014: Non-pollable questions go out as **two text messages** (stem, then options+answer); polls are gated to `mcq`
- **Date**: 2026-10-18
- **Context**: ADR-009 left the ~11% of rows a poll cannot represent as "skipped or downgraded to text", with the default unwritten. The user then decided the format explicitly: *"for those that can't be poll send 2 messages for that one, for text and one for option"* — one message with the question, a second with the options — and separately *"enable posting to the live channel"*. Two facts from a read-only probe of live Turso shaped the implementation: (a) **every** row with usable options also has an answer and a `stem`, and the true maxima are tiny (**longest stem 682 chars, longest `options_json` 930 chars, at most 4 options**) — so nothing can overflow Telegram's 4096-char text limit and no truncation logic is needed; (b) **all four `question_type`s carry a well-formed 2–10-option `options_json` and a `correct_option`**, so the non-`mcq` types are renderable as text and need not be dropped.
- **Decision**:
  1. **A non-pollable row is sent as exactly two text messages**: (1) the subject header + question stem, (2) the numbered options followed by `Answer: …` and any explanation. It is never silently skipped and never sent as a malformed poll.
  2. **Polls are gated to `question_type = 'mcq'`** inside `toPoll()`. This preserves ADR-009's type rule now that the SQL no longer filters by type: a short `match`/`statements`/`assertion_reason` row *would* physically fit a poll, but by decision it is always rendered by the two-message text form, so the format stays predictable per type.
  3. **The structural SQL admits every renderable row** — any `question_type`, `correct_option NOT NULL`, `json_array_length(options_json)` 2–10, `LENGTH(question_text)` 1–3500 (the 3500 cap is a defensive bound far above the live max of 682). Live eligible supply for a channel therefore rises from **10,324 → 11,294**; the ~970 extra rows are the 954 non-`mcq` rows plus 16 long-stem `mcq` rows.
  4. **`/preview` and `/sendnow` default to `pollableOnly: false`.** The dispatcher decides poll-vs-text per row. The `text` flag still exists, now meaning "force the two-message form for *every* row too".
  5. **The send gap is applied between every message, not every question**, so a batch that mixes forms stays under Telegram's ~20 messages/minute per chat (a text question consumes two sends, hence two gaps).
  6. **`sent_log` is written once per question, after all of its messages are confirmed** — a half-delivered text pair is recorded `status='failed'` and stays retryable rather than looking delivered.
- **Consequences**: Coverage of the bank goes from ~90% to effectively **100%** of rows with a real question and answer; nothing is dropped for formatting reasons. The cost is two Telegram sends (and two rate-limit gaps) for the non-`mcq` third of question types. `correct_option` is *shown* in the text form (there is no poll to reveal it), which is the intended behaviour for a PYQ channel. `npm test` grew to **129/129** (new cases: `toPoll` refuses non-`mcq`, `pollableOnly:false` keeps non-pollable rows, the text fallback is exactly two messages and escapes hostile content, and a text item sends two messages while logging once).

## ADR-015: Live channel posting enabled — `DRY_RUN=false` against the connected channel
- **Date**: 2026-10-18
- **Context**: ADR-007 and the project's operating rules both require explicit user approval before any real channel post. The user gave that approval directly: *"enable posting to the live channel"*. The only connected channel is `channels.id` 1 — **"My PYQ Channel"**, `tg_chat_id` `-1001234567890` — which is a production channel; no separate test channel was ever named.
- **Decision**: Set `DRY_RUN=false` in `.env` (the file stays gitignored; secrets are never logged or echoed — the toggle was applied by a script that prints only the key *names*). `/sendnow` now posts to the channel and writes `sent_log`; `/preview` remains non-posting and non-recording regardless of the flag.
- **Consequences**: The bot can publish to a real, disinterested-optional audience. `sent_log` writes become authoritative (a preview never marks anything sent, so an accidental preview cannot consume a question). The `DRY_RUN` guard is retained as a first-class config, so reverting to rehearsal is a one-line change. Because the toggle is invisible to `git`, the value in the running process is always reported in the boot log (`boot … dryRun:false`) and by `/status`.

## ADR-016: The scheduler fires each slot at most once, skips missed slots rather than replaying, and always tells the owner when it does not post cleanly
- **Date**: 2026-10-18
- **Context**: Phase 4 had to answer "when does the bot post on its own", with three concrete failure modes to design against: (1) a **double post**, because a tick every 60 s means a naive "is the time past 08:00?" check fires 1,440 times a day; (2) a **late flood**, because the bot restarts often (electricity, Termux, PM2) and replaying every missed slot would dump several batches into the channel at once; (3) an **invisible miss**, because a slot that silently does nothing looks identical to a slot that worked. A fourth constraint is that the deploy host is a LAN-only phone whose clock may drift and whose process may be killed at any moment, so the "did I already run today?" fact must be **durable** (`schedules.last_run_date`), not in-process memory. Asked for a choice, the user picked: **fire once, DM the owner on failure, with a 60-minute catch-up window**.
- **Decision**:
  1. **One lock: `schedules.last_run_date`.** A slot is spent by writing today's **local channel date**; the tick re-reads the table every time, so a restart cannot re-fire. Belt-and-braces: the `sent_log` unique index `(schedule_id, run_date, question_id)` (ADR-004) makes a duplicate record impossible even if two runs overlapped.
  2. **Times are wall-clock in the channel's own timezone**, resolved with `Intl.DateTimeFormat`, never with the host's clock or a fixed offset. `zonedNow()` returns the date, hour, minute **and** a Mon-first weekday, and it is the *only* source of "now" in the engine (injected as `now()` in tests, so the rules are testable without waiting for 08:00). `isSlotDue()` returns a machine-readable reason — `not_yet`, `already_ran`, `missed_window`, `not_scheduled_today`, `inactive`, `no_schedule`, `due` — instead of a bare boolean, so logs and tests can say *why*.
  3. **A missed slot is skipped, never replayed.** `SCHEDULE_CATCHUP_MINUTES` (default 60, clamped 0–1440) is the only window in which a late tick may still fire. A bot that comes up at 09:30 for an 08:00 slot does **not** post the 08:00 batch — the day is simply skipped and `last_run_date` is left `NULL` so tomorrow works normally. This was chosen deliberately: for a daily *question* channel, a stale batch hours late is worse than no batch.
  4. **A *selection* failure is retried a bounded 3 times inside the window** (`MAX_SELECT_ATTEMPTS`), then the slot is marked spent and the owner is DMed. This separates a transient blip (Turso timeout, a network hiccup — worth retrying) from a persistent break (bad SQL, revoked token — worth stopping and shouting about). Bindings are cleared on success, so an ordinary day never accumulates state.
  5. **The owner is DMed whenever the run is not a clean post**: selection failure after 3 attempts, a partial send (`sent`/`failed` counts), an empty pool, a recycled pool, and every dry run. `DRY_RUN` sends the items **to the owner's DM** with `record:false` (no `sent_log` row) but **still marks the slot spent**, so a dry-run misconfiguration cannot loop or silently consume the next day's slot.
  6. **A send Telegram rejects is logged `status='failed'` in `sent_log`** (ADR-013 §6), which keeps that question eligible on a later day. The slot is still spent — the alternative, retrying delivery of a partially-failed batch, risks duplicating the questions that *did* land.
  7. **Schedules are created from inside the bot** — `/schedule add|default|list|enable|disable|remove` — and a successful `/connect` creates the standard slot (**08:00, 10 questions, every day**, from `DEFAULT_SCHEDULE_TIME`/`DEFAULT_SCHEDULE_COUNT`) **only if that channel has no schedule yet**. Arming therefore needs no shell access to the J7, which matters because the box is a phone on a LAN. All three answers the user gave this session (commands + auto-default; 08:00/10/Asia-Kolkata daily; fire once + DM on failure with a 60-minute window) are encoded here.
  8. **The tick is re-entrancy guarded** (`inFlight`), the interval is `unref()`ed, and `SCHEDULER_ENABLED=false` parks the engine entirely without touching any row. The router and the engine are separate objects, so `/schedule` works with the engine disabled and a tick never depends on a command having been issued.
- **Consequences**: A day is posted exactly once or not at all, and every "not at all" is announced to the owner — the failure mode is a message, not silence. The cost of "skip, never replay" is that a host outage spanning 08:00 loses that day's batch; that is the intended trade and is the reason the owner gets no false alarm in that case (there is nothing to report — the slot was simply not due). Because "due" is decided from the DB rather than process memory, `pm2 restart` and `pm2 stop` are safe at any time. Verification: `npm test` **185/185** (new `tests/schedules.test.js` + `tests/scheduler.test.js` cover due/early/late/once-a-day/inactive-paused/empty/dry-run/3-strike/partial-failure), plus a **read-only live probe** that ran the real store and a real `tick()` against Turso with a stub Telegram client that *throws if called* — no row written, no message sent. `schedules` was left **empty** through the whole build, so as of the ADR itself **nothing was scheduled and nothing posted**; that final step was left to the user.
- **Follow-up (same session, user-approved)**: the user chose **"arm 08:00 daily now"** on the live channel rather than setting up a separate test channel. `/schedule default` was therefore applied by calling `ensureDefault(1)` directly — the exact code path the command uses — instead of typing in Telegram, producing **schedule #1: 08:00, `1111111`, 10 questions, gap 5 s, format `poll`, active, channel `-1001234567890` ("My PYQ Channel", Asia/Kolkata), `last_run_date` NULL**. Armed mid-evening, `isSlotDue` returned `{ due: false, reason: 'missed_window', lateMinutes: 670 }`, so **the arming itself posted nothing**; the first real post is **2026-10-19 08:00 IST**. Verified after two live ticks: `last_run_date` still `NULL` and `sent_log` still 0 rows. That is exactly the state this ADR was designed to produce — one armed slot, zero accidental posts, first post at the intended hour.
- **Known and accepted gap**: because §3 leaves a window-missed slot *unmarked*, the engine cannot distinguish "the host was off at 08:00" from "the process was never started", so a missed day is **silent** — no log line and no DM. Reporting it would require a `missed:<scheduleId>:<date>` marker in `bot_state` so the notice fires once per date; that is deliberately **not** implemented, and the limitation is recorded in `README.md`.

## ADR-017: The J7 Max is the host of record; the PC copy is development-only and must stay stopped
- **Date**: 2026-10-18
- **Context**: Phase 4 verification ran the bot on the developer PC (detached `node src/index.js`, PID 19504) because that is where the code and `.env` live. That process logged `boot → telegram_ready → scheduler_started → polling` and then **vanished without a shutdown line** and with a 0-byte error log — it went down with the session that launched it. Meanwhile the armed 08:00 slot had to actually fire. The obvious question ("is it running on the J7?") turned out to have the answer **no**: the J7 had 15 PM2 apps and no `~/prashn-kosh-tg-bot` at all, and a grep of the whole home directory found **no file containing the bot id**, so nothing on the device was polling our token.
- **Decision**:
  1. **The J7 Max is the host of record.** It has PM2 with crash-restart and boot persistence, a 24×7 duty cycle, and its other 15 apps show 12 h+ uptimes. A desktop PC that sleeps, reboots or loses its launching shell cannot honour an 08:00 daily slot.
  2. **The PC copy is development-only and stays stopped.** One token admits exactly one poller; a second process fails `getUpdates` with `409 Conflict`. The rule is therefore: *edit on the PC, deploy to the J7, and never leave a PC poller running.*
  3. **Deployment is the documented four steps** (the deploy section of `README.md`): `scp -P 8022 -r` the folder (which carries `.env`), `npm run check` on the device as a live preflight, `pm2 start … --node-args=--max-old-space-size=128`, then **`pm2 save`** — the save is what persists, because `~/.termux/boot/start-services.sh` already runs `pm2 resurrect` at boot.
  4. **No build step and no `npm install`.** The project has zero entries in both `dependencies` and `devDependencies`, which is what makes a 0.42 MB `scp -r` a complete deploy onto a 32-bit Bionic device that cannot use native modules.
- **Consequences**: The daily slot is now backed by a host that survives reboots, and the single-poller rule is explicit rather than accidental. The trade is that the deployed copy is a **snapshot**: fixing a bug on the PC does nothing until it is re-transferred, so every change must be followed by a re-deploy (and the J7 copy is not a git checkout, so there is no `git pull` shortcut). Verified live: PM2, `online`, `restarts 0`, `fork_mode`, node **v24.18.0**, `android/arm`; on-device `npm run check` returned `db_ok` + `telegram_ok` + `check_ok`; the running log shows `telegram_ready → scheduler_started (60 s, catchup 60 m) → polling` with an empty PM2 error log and **no `scheduler_tick_failed` or `poll_error` after 100 s**; and `prashn-kosh-tg-bot` appears in `~/.pm2/dump.pm2`, so it resurrects on reboot. RSS settled ~58 MB against a device at ~36% RAM.

## ADR-018: Token rotation is a verify-before-write Python helper that never prints the secret
- **Date**: 2026-10-18
- **Context**: The live `BOT_TOKEN` was exposed in a tool result and is present in the session transcript, so it has to be revoked at @BotFather and replaced. The user's constraint was explicit: **they must not have to paste the new token into the chat to get it into `.env`** — which is how the first one leaked. The obvious alternative, a documented `notepad .env` procedure, is exactly what puts secrets into screenshots and into whatever the operator pastes back for help. A second, quieter trap: PowerShell's `Set-Content -Encoding UTF8` writes a BOM, which corrupts the *first* key in the file — and `BOT_TOKEN` is the first key.
- **Decision**: Ship **`set_bot_token.py`** in the repo root — standard library only, Python 3.8+, identical on the PC and on Termux — with these properties as requirements rather than niceties:
  1. **The secret is never printed, echoed or logged.** Read with `getpass()`; every output path shows only the non-secret bot id and the character count (`123456789:******** (46 chars)`).
  2. **Verify *before* write.** The real `getMe` call runs first, so a mistyped, revoked or wrong-bot token aborts and leaves `.env` byte-identical. The returned `@username` is printed for confirmation.
  3. **Never surface a `urllib` exception object.** `HTTPError`'s `str()`/`repr()` embed the request URL, which embeds the token; the script reads `exc.read()` and prints only the status code plus Telegram's `description`.
  4. **Refuse rather than hang when there is no console**, unless `--token-stdin` is passed — `getpass` on Windows blocks on a console handle for a piped stdin instead of failing.
  5. **Rewrite `.env` byte-carefully**: detect the existing EOL, preserve it (CRLF on both hosts), encode UTF-8 with no BOM, and write through a temp file plus `os.replace` so an interrupted run cannot truncate it. `chmod 600` on POSIX.
  6. **Reject a malformed value before any network call** (`<digits>:<secret>`), overridable with `--force` in case Telegram ever changes the shape.
- **Consequences**: Rotation no longer requires the secret to be typed anywhere but the operator's own hidden prompt, and a typo cannot land in `.env` at all. The cost is one extra tracked file and a second language in the repo — justified because the alternative is the exact failure mode being fixed, and because Python 3.14.6 is already present on the J7. Verified: the write path was exercised against a **copy** (`.env.test`) — line count identical, only the `BOT_TOKEN` line changed, CRLF intact, first byte `0x23`, no BOM, no `.env.tmp` left behind, and the real `.env` SHA-256 unchanged; a fake token produced `FAILED: Telegram rejected it (401 Unauthorized): Unauthorized` + `.env was NOT modified.` with **no secret in the output**; and `--show-current` on the J7 printed the masked live value. **A revoke keeps the bot's id and username**, so `OWNER_TG_ID`, the channel row, the admins and the armed schedule all survive — no re-`/connect` is needed, only `pm2 restart prashn-kosh-tg-bot`. Documented in `README.md` → *Rotating the bot token*.
