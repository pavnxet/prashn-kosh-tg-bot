# 🤖 Prashn-Kosh TG Bot

A standalone Telegram bot that posts previous-year questions (MCQs) from a shared
[Turso](https://turso.tech) / libSQL database to one or more Telegram channels on a daily
schedule. Admins manage channels and schedules from inside the bot over Telegram — no shell access
to the server is needed.

- **Native Telegram quiz polls** (`type: quiz`, `correct_option_id`, optional `explanation`), with a
  two-message text fallback for the question types a poll cannot represent.
- **Per-subject quotas**, so a large subject cannot crowd out a small one.
- **At-most-once daily posting**, enforced by a `schedules.last_run_date` marker plus a `sent_log`
  unique index — a restart or a slow tick can never double-post.
- **Zero runtime dependencies** — no npm packages at all. Node's built-in `fetch` and `node:test`, a
  ~20-line internal `.env` parser, and a hand-written Turso HTTP client.

> **Status: Phase 4 (scheduler + `/schedule` + idempotent daily runs) is built, tested (186/186), and
> running under PM2 on a self-hosted Android/Termux device.** Long polling keeps it reachable from a
> LAN-only box with no public URL, TLS certificate or open inbound port. Inline-button menus are the
> next phase; see [`PLAN.md`](./PLAN.md) for the roadmap.
>
> The *why* behind each design choice — including the two-message fallback and the "skip, never
> replay" scheduler rule — is recorded in [`docs/DECISIONS.md`](./docs/DECISIONS.md).

---

## Requirements
- **Node.js >= 20** (uses global `fetch` and `node:test`). No build step, no native modules.
- A `.env` file (see `.env.example`).
- Deploy target: Samsung Galaxy J7 Max micro-server (Termux + PM2). **Verified 2026-10-18**: `uname -m` is `armv8l`, 32-bit Bionic userland, **Node v24.18.0** (the original notes said `armv7l` / Node 20.x).

## Quick start (local)
```bash
cp .env.example .env      # then fill in BOT_TOKEN, OWNER_TG_ID, TURSO_*
npm run check             # LIVE preflight: config + Turso ping + getMe, then exits
npm test                  # zero-dependency test suite (186 tests, no network)
npm run migrate           # DRY RUN: prints the schema plan, changes nothing
npm run migrate:apply     # creates the additive bot tables (safer, idempotent)
npm start                 # long-polls Telegram for admin commands + runs the scheduler
```

`DRY_RUN=true` is the default in `.env.example`: `/sendnow` then behaves like `/preview` — the exact
items are sent to the admin's own chat (so you can see the real polls) and nothing is written to
`sent_log`. Set `DRY_RUN=false` once you are ready for `/sendnow` to post to the connected channel
(ADR-015); `/preview` never posts and never records either way.

### First run — linking your account
1. Open your bot in Telegram (the one whose token is in `BOT_TOKEN`) and send `/id`. It replies with your numeric
   user id and the chat id — everyone may use `/id` for exactly this reason.
2. Put that number in `.env` as `OWNER_TG_ID` and restart. You are now the owner; nothing else can
   grant ownership (see ADR-007).
3. Add the bot to your channel as an administrator with **Post messages**.
4. Send `/connect -100…` (the channel id) to the bot. It verifies the chat **and** the bot's
   posting rights before saving, and replies in your **private chat**, never in the channel.
5. `/channels` lists what is connected; `/pause -100…` and `/resume -100…` toggle a channel.
6. Try the sender: `/preview 3` shows you three real questions in your own chat (nothing is posted).
   `/sendnow 3` posts to a connected channel once `DRY_RUN=false`.
7. `/connect` also creates that channel's **default daily slot** (08:00, 10 questions, every day).
   `/schedule` lists it; `/schedule disable 1` parks it, `/schedule remove 1` deletes it. Nothing
   posts until the slot's time arrives, and a slot fires **at most once a day**.

### Commands
| Command | Who | What it does |
|---|---|---|
| `/start`, `/help` | everyone | Welcome + command list |
| `/id` | everyone | Your user id and chat id (needed for `OWNER_TG_ID`) |
| `/status` | admins | Phase, dry-run flag, timezone, DB host, channel/admin counts |
| `/connect <chat_id>` | admins | Verify a channel (bot must be admin with *Post messages*) and save it |
| `/channels` | admins | List connected channels with active/paused state |
| `/pause`, `/resume <chat_id>` | admins | Toggle a channel |
| `/admins` | admins | Show the owner plus delegated admins |
| `/preview [count]` | admins | Render `count` (default 1, max 10) real questions **to your own chat** — never posts, never records |
| `/sendnow [count] [chat_id] [text]` | admins | Post `count` (default 5, max 30) questions to a channel now. Pollable rows go as quiz polls and the rest as two-message text; `text` forces the two-message form for every row; a `-100…` argument targets a specific channel |
| `/schedule` | admins | List every schedule with its time, days, count and on/off state |
| `/schedule add [HH:MM] [count] [chat_id] [days] [text]` | admins | Add a slot (defaults `08:00`, 10 questions, every day). `days` is `daily` \| `weekdays` \| `weekends` \| `1111111` (Mon→Sun). A bare time (`/schedule 08:00`) means `add` |
| `/schedule default` | admins | Add the standard slot: **08:00, 10 questions, every day** for the connected channel |
| `/schedule enable\|disable <id>` | admins | Park or re-arm a slot without deleting it |
| `/schedule remove <id>` | admins | Delete a slot |

Non-admins are refused on every privileged command, and the refusal is written to `audit_log`.
Privileged replies are always sent to the caller's private chat.

### The schedule engine
`lib/scheduler.js` wakes every `SCHEDULER_TICK_SECONDS` (default 60 s), reads the schedules
**once**, and decides each slot in **that channel's own timezone**:

- **Fires at most once a day** — `schedules.last_run_date` is the lock.
- **A missed slot is skipped, never replayed.** If the bot was off at 08:00 and starts at 09:30,
  the 08:00 batch is *not* dumped into the channel; `SCHEDULE_CATCHUP_MINUTES` (default 60) is the
  window in which a slightly-late tick may still fire.
- **A selection failure retries 3 times inside the window**, then the slot is marked spent and the
  owner is DMed — so a transient DB blip does not silently lose a day, and does not retry forever.
- **The owner is DMed** on a failed selection, a partial send, an empty pool, a recycled pool and
  every dry run.
- **`DRY_RUN=true`** sends the items to the owner only, writes no `sent_log` row, but still marks
  the slot spent (so a dry-run misconfiguration cannot loop).
- A send that Telegram *rejects* is logged `status='failed'` in `sent_log`, which keeps the question
  eligible on a later day instead of losing it.

Idempotency is belt **and** braces: `schedules.last_run_date` stops a second run the same day, and
the `sent_log` unique index `(schedule_id, run_date, question_id)` stops the same question being
recorded twice even if two runs somehow overlapped.

### How a set of questions is chosen
`lib/selector.js` picks **per subject** (ADR-010): an explicit quota map when one exists,
otherwise a share proportional to how much each subject still has unsent — so a 3,158-question
subject cannot crowd out a 533-question one. A candidate must have 2–10 options, an answer that
resolves to a real option, and must not have been sent to this channel before.
Every renderable row is sent (ADR-014): a plain `mcq` becomes a **native quiz poll**; a row that
cannot be a poll — a `match`/`statements`/`assertion_reason` type or a stem over the 300-char poll
cap — goes out as **two text messages**, the question first and then the options with the answer
shown. Nothing is skipped for formatting reasons (11,294 of 11,295 rows qualify; the one exclusion
has no answer key).
When a subject's fresh pool runs out, the **least recently sent** questions are reused and the
admins are told which subjects were recycled.

### Message formatting (HTML, not Markdown)
Every reply is sent with `parse_mode: 'HTML'`. Templates in `lib/messages.js` carry the markup
(`<b>`, `<i>`, `<code>`), and `t(key, vars)` **escapes every interpolated value** — so a channel
titled `My_Channel*<b>` cannot break a reply. A literal `<` in copy is written `&lt;`.

This is deliberate: legacy Markdown treats every stray `_` or `*` as an entity delimiter and
rejects the *whole* message when one is unbalanced, which is exactly how `/start` and `/help`
broke in live testing (`400 can't parse entities … byte offset 362`). `tests/support/html.js`
validates every string against Telegram's HTML rules, so that class of bug now fails `npm test`.

### Migrations
`migrations/001_bot_schema.sql` only ever runs `CREATE TABLE/INDEX IF NOT EXISTS`, so applying it
repeatedly is safe. The runner refuses any SQL containing `DROP`/`ALTER`/`TRUNCATE` or
`INSERT`/`UPDATE`/`DELETE`, and after applying it verifies that the `prashn-kosh` source-table row
counts are unchanged.

To apply against the shared database using the credentials that already live in the sibling
`prashn-kosh` project (no secret copying):

```bash
node migrations/run.js --apply --env-file "../prashn-kosh/.env"
```

## Deploy (self-hosted, under PM2)

**Verified 2026-10-18** — runs on a Samsung Galaxy J7 Max (Termux, 32-bit Bionic) as the PM2 app
`prashn-kosh-tg-bot`, `fork_mode`, Node **v24.18.0**, `android/arm`.

```bash
# from the folder containing this project
scp -P 8022 -r ./prashn-kosh-tg-bot u0_a123@192.168.1.100:~/
ssh -p 8022 u0_a123@192.168.1.100
cd ~/prashn-kosh-tg-bot
rm -f bot.out.log bot.err.log        # stale logs from an earlier PC run; don't ship them
npm run check                        # LIVE preflight: config + Turso + getMe, then exits
pm2 start src/index.js --name prashn-kosh-tg-bot --node-args=--max-old-space-size=128
pm2 save                             # ~/.termux/boot/start-services.sh runs `pm2 resurrect`
```

Two footnotes that cost time the first way round:

- **`--max-old-space-size` must go through `--node-args=`.** Written bare
  (`pm2 start src/index.js --max-old-space-size=128`) PM2 passes it to the *script* as a normal
  argument and node never sees it, so the heap cap is silently not applied.
- **`pm2 save` is what makes it survive a reboot**, not `pm2 start`. The device already has
  `~/.termux/boot/start-services.sh` doing `termux-wake-lock` → `sshd` → `pm2 resurrect`, so once
  the app is in `~/.pm2/dump.pm2` it comes back on its own. Confirm with
  `tr ',' '\n' < ~/.pm2/dump.pm2 | grep -i name | sort -u`.

`scp -r` copies `.env` along with everything else (it is gitignored, so this is the one deliberate
carrier of secrets). `npm install` is unnecessary — the project has **zero dependencies** in both
`dependencies` and `devDependencies`.

The bot uses **long polling** — it needs no public URL, no TLS certificate and no open
inbound port, which is why it works from a LAN-only device.

Run `node src/index.js --once` (or `npm run check`) on the box first: it verifies the Turso
connection and `getMe` before PM2 ever starts the polling loop. Only one process may poll a given
token — a second one fails `getUpdates` with `409 Conflict`, which is the signal that two
instances are running. **The PC copy must therefore stay stopped**; it is development-only.

## Rotating the bot token

If a token is ever exposed — pasted into a chat, a log, a screenshot — revoke it in @BotFather
(`/mybots` → the bot → **API Token** → **Revoke**, or send `/revoke`), then put the replacement into
`.env` with the helper instead of editing the file by hand:

```bash
python3 set_bot_token.py            # hidden prompt, verifies, writes one line
python3 set_bot_token.py --show-current        # print the current token, masked
python3 set_bot_token.py --dry-run             # verify but write nothing
python3 set_bot_token.py --restart-pm2 prashn-kosh-tg-bot   # write and restart the PM2 app
```

Run it wherever the `.env` you care about lives — on the J7 that is the live one:

```bash
scp -P 8022 ./set_bot_token.py u0_a123@192.168.1.100:~/prashn-kosh-tg-bot/
ssh -p 8022 u0_a123@192.168.1.100
cd ~/prashn-kosh-tg-bot
python3 set_bot_token.py --restart-pm2 prashn-kosh-tg-bot
```

What it guarantees:

- **The token is never echoed, printed or logged.** It is read with `getpass()`, and every message
  prints only the *non-secret* bot id plus the length — e.g. `123456789:******** (46 chars)` — which
  is enough to confirm you pasted the right bot.
- **It is verified with Telegram's `getMe` *before* `.env` is written**, so a typo or a stale token
  aborts the run and leaves the file untouched. The returned `@username` is shown so you can confirm
  it is the bot you meant.
- **`HTTPError` bodies are read, never the exception object** — a `urllib` `HTTPError`'s `repr()`
  contains the request URL, and the URL contains the token.
- **`.env` is rewritten atomically** (temp file + `os.replace`) with its original line endings and
  without a BOM, and chmod'd `600`.
- A malformed value is rejected before any network call; `--force` overrides.
- `--no-verify` skips the network check (offline); `--token-stdin` reads the token from a pipe, so
  it also works where there is no console. **Without `--token-stdin` it refuses to run when stdin is
  not a terminal**, because `getpass` on Windows blocks forever waiting on a console handle instead
  of failing.

**A revoke does not change the bot's id or username**, so `OWNER_TG_ID`, the channel, the admins and
the armed schedule all survive. After a rotation there is nothing to re-`/connect` — just confirm
with `npm run check` (expect `telegram_ok` with the same `@username`).

## Environment variables
| Key | Required | Purpose |
|---|---|---|
| `BOT_TOKEN` | yes | Telegram bot token from @BotFather. |
| `OWNER_TG_ID` | yes | Numeric Telegram user id of the owner (super-admin). |
| `TURSO_DATABASE_URL` | yes | `libsql://…` URL of the shared Prashn-Kosh database. |
| `TURSO_AUTH_TOKEN` | yes | Turso auth token. |
| `DEFAULT_TZ` | no | Channel default timezone (default `Asia/Kolkata`). |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` (default `info`). |
| `MENU_LANG` | no | Bot menu/help language: `en` \| `hi` (default `en`). |
| `DRY_RUN` | no | `true` = never actually send (default `true`). |
| `SCHEDULER_ENABLED` | no | `false` parks the tick engine without touching stored schedules (default `true`). |
| `SCHEDULER_TICK_SECONDS` | no | How often to look for due slots, 5–3600 (default `60`). |
| `SCHEDULE_CATCHUP_MINUTES` | no | How late a slot may still fire, 0–1440 (default `60`); later than this it is skipped, not replayed. |
| `DEFAULT_SCHEDULE_TIME` | no | Time `/schedule default` and a fresh `/connect` create, 24-hour `HH:MM` (default `08:00`). |
| `DEFAULT_SCHEDULE_COUNT` | no | How many questions that default slot posts, 1–30 (default `10`). |

## Known limitations
- Telegram **quiz polls in channels are always anonymous** and the bot never receives
  individual answers → channel leaderboards / per-user scoring are **not possible**. A
  practice mode in the bot's DM (or a linked discussion group) would be needed instead.
- **Non-pollable rows are sent as two text messages** (the question, then the options with the
  answer shown) — a `match`/`statements`/`assertion_reason` type or a stem over 300 chars
  (ADR-014). Poll mode alone covers 10,142 of 11,295; with the text fallback **11,294** rows are
  postable (the single exclusion has no `correct_option`). Because the text form *shows* the
  answer, the two-message items behave like a PYQ reveal rather than a quiz.
- Some questions have a **NULL `explanation`**; the bot posts the answer without one rather
  than failing.
- **Questions come from the shared Turso DB, not the J7's local `~/databases/prashn-kosh.db`.**
  That file is a stale hand-copy (6,199 questions on 2026-10-02, vs 11,295 in Turso) and is
  *replaced wholesale* whenever a new snapshot is copied over it, so bot state must never live
  there. See ADR-012.
- **A slot that is missed is skipped *silently*.** If the bot is off at 08:00 and comes back
  after the `SCHEDULE_CATCHUP_MINUTES` window, that day is skipped and **nothing is logged or
  DMed** — by design (ADR-016 §3: a stale batch hours late is worse than none). The owner is
  DMed for failures and partial sends, but *not* for a window miss, because the bot has no way
  to tell "I was off" from "I was never started". Consequence: on a phone that reboots often,
  you will not be told you lost a day. Adding a once-per-date "skipped" notice would need a
  marker row in `bot_state`; it is not implemented.

## Project layout
```
prashn-kosh-tg-bot/
├── PLAN.md                # audit, decisions, schema, roadmap
├── README.md              # this file
├── LICENSE                # MIT
├── set_bot_token.py       # token-rotation helper (stdlib only, Python 3.8+)
├── .env.example
├── docs/
│   └── DECISIONS.md       # architecture decision records (ADR-001 … ADR-018)
├── lib/
│   ├── config.js          # .env loader + validated config (no deps)
│   ├── logger.js          # leveled JSON logger with secret redaction
│   ├── turso.js           # zero-dep Turso HTTP v2/pipeline client
│   ├── telegram.js        # Bot API client: polling, sends, 429 backoff, poll limits
│   ├── admin.js           # owner (env) + bot_admins roles + audit_log
│   ├── channels.js        # connect/verify/list/pause/resume/remove
│   ├── selector.js        # per-subject quota, pollability, recycle
│   ├── dispatcher.js      # quiz-poll/text rendering, gap pacing, sent_log
│   ├── schedules.js       # schedule store + pure slot rules (isSlotDue, zonedNow)
│   ├── scheduler.js       # tick engine: due slots, catch-up window, owner alerts
│   ├── router.js          # command parsing, admin gating, DM replies
│   └── messages.js        # en | hi user-facing strings
├── migrations/
│   ├── 001_bot_schema.sql # additive bot schema (8 tables + 3 indexes)
│   └── run.js             # safety-checked runner (dry-run by default)
├── src/
│   └── index.js           # entry point (long polling; --once = live preflight)
├── tests/
│   ├── smoke.test.js      # config + logger
│   ├── turso.test.js      # HTTP client
│   ├── migrations.test.js # SQL safety + additive-only guarantees
│   ├── telegram.test.js   # Bot API client (faked fetch, token redaction)
│   ├── admin.test.js      # authorisation + audit
│   ├── channels.test.js   # posting-rights logic + connect
│   ├── selector.test.js   # pollability, quota allocation, recycle
│   ├── dispatcher.test.js # rendering, sent_log, failure handling
│   ├── schedules.test.js  # slot rules (due/early/late/once-a-day) + store CRUD
│   ├── scheduler.test.js  # fire-once, no replay, dry run, retry, owner alerts
│   ├── router.test.js     # command routing + gating
│   ├── messages.test.js   # every string is valid Telegram HTML; escaping
│   └── support/
│       ├── fakes.js       # in-memory DB, fake Telegram, fake selector, fake logger
│       └── html.js        # Telegram-HTML validator shared by the tests
```

## Security notes
- The bot token lives in `.env` only (gitignored). It is never logged: `lib/logger.js` redacts
  secret values, and `lib/telegram.js` strips the token out of every error, because the Bot API
  puts it in the request URL.
- Ownership is defined **only** by `OWNER_TG_ID`; `bot_admins` can never mint an owner (ADR-007).
  Recovering from a bad admin list means fixing `.env` and rotating the token.
- The Turso token is database-wide (no per-table grants), so the read-only guarantee on
  `questions`/`subjects`/`topics` is enforced by code review and tests, not by permissions.

## Data
The bot **reads** `questions` / `subjects` / `topics` and **writes only** its own tables:
`bot_admins`, `channels`, `channel_settings`, `schedules`, `sent_log`, `question_flags`,
`audit_log`, `bot_state`. Source tables are never modified. (The counts quoted above — 11,295
questions across 14 subjects and 293 topics — describe the reference database, not a requirement.)

## License
[MIT](./LICENSE).
