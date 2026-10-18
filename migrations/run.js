#!/usr/bin/env node
'use strict';

/**
 * migrations/run.js — applies additive bot schema to the shared Turso database.
 *
 * Safety model (defence in depth):
 *   1. `assertSafeSql()` rejects the SQL file outright if it contains any destructive
 *      statement (DROP / ALTER / TRUNCATE) or any data mutation (INSERT / UPDATE / DELETE).
 *   2. The runner is DRY-RUN by default. It only touches the database with `--apply`.
 *   3. Before and after applying, it counts rows in the existing source tables and
 *      refuses to report success if any of them changed.
 *
 * Usage:
 *   node migrations/run.js                                   # dry run: print the plan
 *   node migrations/run.js --apply                           # apply using ./.env
 *   node migrations/run.js --apply --env-file <path-to-.env>  # apply using another env file
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, ConfigError } = require('../lib/config');
const { createTursoClient } = require('../lib/turso');
const { createLogger } = require('../lib/logger');

const SQL_FILE = path.join(__dirname, '001_bot_schema.sql');

/** prashn-kosh tables that must never be written to by this bot. */
const SOURCE_TABLES = [
  'questions',
  'subjects',
  'topics',
  'sub_subjects',
  'quiz_attempts',
  'import_batches',
  'staged_questions'
];

/** Tables this migration is expected to create. */
const EXPECTED_TABLES = [
  'bot_admins',
  'channels',
  'channel_settings',
  'schedules',
  'sent_log',
  'question_flags',
  'audit_log',
  'bot_state'
];

/** Indexes this migration is expected to create. */
const EXPECTED_INDEXES = [
  'idx_sent_log_channel_question',
  'uq_sent_log_slot_question',
  'idx_schedules_active_time'
];

/** Destructive or mutating SQL that must never appear in a bot migration. */
const FORBIDDEN_PATTERNS = [
  { re: /\bDROP\b/i, why: 'DROP' },
  { re: /\bALTER\b/i, why: 'ALTER' },
  { re: /\bTRUNCATE\b/i, why: 'TRUNCATE' },
  { re: /\bINSERT\b/i, why: 'INSERT' },
  { re: /\bUPDATE\b/i, why: 'UPDATE' },
  { re: /\bDELETE\b/i, why: 'DELETE' },
  { re: /\bREPLACE\b/i, why: 'REPLACE' }
];

/** Strip full-line `--` comments, then split on `;`, dropping empties. */
function splitStatements(sql) {
  return String(sql)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

/**
 * Throw if the SQL contains anything destructive/mutating.
 * @returns {string[]} the offending keywords, or [] when safe.
 */
function findForbidden(sql) {
  const found = [];
  for (const { re, why } of FORBIDDEN_PATTERNS) {
    if (re.test(sql)) found.push(why);
  }
  return found;
}

function assertSafeSql(sql) {
  const found = findForbidden(sql);
  if (found.length) {
    throw new Error(`Refusing to run unsafe migration; found forbidden keyword(s): ${found.join(', ')}`);
  }
}

async function countSourceTables(client) {
  const counts = {};
  for (const table of SOURCE_TABLES) {
    const row = await client.get(`SELECT COUNT(*) AS c FROM "${table}"`);
    counts[table] = row ? row.c : null;
  }
  return counts;
}

async function listBotObjects(client) {
  const placeholders = [...EXPECTED_TABLES, ...EXPECTED_INDEXES].map(() => '?').join(', ');
  const rows = await client.all(
    `SELECT type, name FROM sqlite_master WHERE name IN (${placeholders}) ORDER BY type, name`,
    [...EXPECTED_TABLES, ...EXPECTED_INDEXES]
  );
  return rows;
}

function parseArgs(argv) {
  const args = { apply: false, envFile: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--env-file') args.envFile = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = createLogger({ level: (process.env.LOG_LEVEL || 'info').toLowerCase() });

  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  const statements = splitStatements(sql);
  // Check the executable statements only — the file's header comment legitimately
  // names the forbidden keywords in prose.
  assertSafeSql(statements.join(';\n'));

  log.info('migration_plan', {
    file: path.relative(path.join(__dirname, '..'), SQL_FILE),
    statements: statements.length,
    creates: statements.filter((s) => /^CREATE TABLE/i.test(s)).length,
    indexes: statements.filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(s)).length,
    apply: args.apply
  });

  if (!args.apply) {
    statements.forEach((stmt, index) => {
      const first = stmt.split(/\s+/).slice(0, 4).join(' ');
      log.debug('statement', { index: index + 1, head: `${first}...` });
    });
    log.info('dry_run', { note: 'No changes made. Re-run with --apply to create the tables.' });
    return;
  }

  let config;
  try {
    config = loadConfig({ envFile: args.envFile, requireBotToken: false });
  } catch (err) {
    if (err instanceof ConfigError) log.error('config_invalid', { errors: err.messages });
    else log.error('config_load_failed', { error: err.message });
    process.exitCode = 1;
    return;
  }

  const client = createTursoClient({ url: config.dbHttpUrl, authToken: config.tursoAuthToken });
  log.info('connecting', { tursoHost: config.dbHttpHost });

  const before = await countSourceTables(client);
  log.info('source_counts_before', before);

  await client.pipeline(statements.map((sqlText) => ({ sql: sqlText, args: [] })));
  log.info('applied', { statements: statements.length });

  const after = await countSourceTables(client);
  log.info('source_counts_after', after);

  const drift = SOURCE_TABLES.filter((t) => before[t] !== after[t]);
  if (drift.length) {
    throw new Error(`Source-table row counts changed for: ${drift.join(', ')} — investigate immediately.`);
  }

  const objects = await listBotObjects(client);
  const createdTables = objects.filter((o) => o.type === 'table').map((o) => o.name);
  const createdIndexes = objects.filter((o) => o.type === 'index').map((o) => o.name);
  const missingTables = EXPECTED_TABLES.filter((t) => !createdTables.includes(t));
  const missingIndexes = EXPECTED_INDEXES.filter((i) => !createdIndexes.includes(i));

  log.info('bot_objects', { tables: createdTables, indexes: createdIndexes });

  if (missingTables.length || missingIndexes.length) {
    throw new Error(
      `Migration incomplete. Missing tables: [${missingTables.join(', ')}]; missing indexes: [${missingIndexes.join(', ')}]`
    );
  }

  log.info('verify_ok', {
    tables: createdTables.length,
    indexes: createdIndexes.length,
    sourceTablesUnchanged: true
  });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'migration_failed', error: err.message })}\n`);
    process.exit(1);
  });
}

module.exports = {
  splitStatements,
  findForbidden,
  assertSafeSql,
  countSourceTables,
  SOURCE_TABLES,
  EXPECTED_TABLES,
  EXPECTED_INDEXES,
  SQL_FILE
};
