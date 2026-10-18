-- 001_bot_schema.sql
-- Additive schema for the Prashn-Kosh TG Bot.
--
-- SAFETY RULES (enforced by migrations/run.js and tests/migrations.test.js):
--   * ONLY `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements.
--   * NO DROP / ALTER / TRUNCATE, and NO INSERT / UPDATE / DELETE anywhere.
--   * Existing prashn-kosh tables (questions, subjects, topics, ...) are never touched.
--   * The bot only READS questions/subjects/topics and WRITES its own bot_* tables below.
--
-- Comments must stay on their own lines: the statement splitter strips full-line `--`
-- comments and then splits on `;`.

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
  is_active   INTEGER NOT NULL DEFAULT 1,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_settings (
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, key)
);

CREATE TABLE IF NOT EXISTS schedules (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id         INTEGER NOT NULL REFERENCES channels(id),
  send_time          TEXT NOT NULL,
  days_of_week       TEXT NOT NULL DEFAULT '1111111',
  question_count     INTEGER NOT NULL DEFAULT 10,
  gap_seconds        INTEGER NOT NULL DEFAULT 5 CHECK (gap_seconds >= 3),
  subject_filter_json TEXT,
  format             TEXT NOT NULL DEFAULT 'poll',
  is_active          INTEGER NOT NULL DEFAULT 1,
  last_run_date      TEXT,
  created_at         TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sent_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    INTEGER NOT NULL REFERENCES channels(id),
  question_id   TEXT NOT NULL,
  schedule_id   INTEGER REFERENCES schedules(id),
  run_date      TEXT NOT NULL,
  tg_message_id INTEGER,
  sent_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  status        TEXT NOT NULL DEFAULT 'sent',
  error         TEXT
);

CREATE TABLE IF NOT EXISTS question_flags (
  question_id TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS bot_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sent_log_channel_question ON sent_log(channel_id, question_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sent_log_slot_question ON sent_log(schedule_id, run_date, question_id);

CREATE INDEX IF NOT EXISTS idx_schedules_active_time ON schedules(is_active, send_time);
