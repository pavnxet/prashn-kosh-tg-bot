'use strict';

/**
 * Guards for the bot migration: it must be additive-only, idempotent, correctly typed,
 * and must never mention the prashn-kosh source tables.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const {
  splitStatements,
  findForbidden,
  assertSafeSql,
  SOURCE_TABLES,
  EXPECTED_TABLES,
  EXPECTED_INDEXES,
  SQL_FILE
} = require('../migrations/run');

const SQL = fs.readFileSync(SQL_FILE, 'utf8');
const STATEMENTS = splitStatements(SQL);

test('migration: contains no destructive or mutating SQL', () => {
  // Comments may mention the forbidden words in prose, so only the executable
  // statements are checked.
  const executable = STATEMENTS.join(';\n');
  assert.deepEqual(findForbidden(executable), []);
  assert.doesNotThrow(() => assertSafeSql(executable));
});

test('migration: every statement is CREATE TABLE/INDEX ... IF NOT EXISTS (idempotent)', () => {
  assert.ok(STATEMENTS.length >= EXPECTED_TABLES.length + EXPECTED_INDEXES.length);
  for (const stmt of STATEMENTS) {
    assert.match(
      stmt,
      /^CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+/i,
      `unexpected statement: ${stmt.slice(0, 60)}`
    );
  }
});

test('migration: creates exactly the expected tables and indexes', () => {
  const joined = STATEMENTS.join('\n');
  for (const table of EXPECTED_TABLES) {
    assert.match(joined, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} `), `missing table ${table}`);
  }
  for (const index of EXPECTED_INDEXES) {
    assert.match(joined, new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${index} `), `missing index ${index}`);
  }
  const tableCount = STATEMENTS.filter((s) => /^CREATE TABLE/i.test(s)).length;
  const indexCount = STATEMENTS.filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(s)).length;
  assert.equal(tableCount, EXPECTED_TABLES.length);
  assert.equal(indexCount, EXPECTED_INDEXES.length);
});

test('migration: never references prashn-kosh source tables', () => {
  const joined = STATEMENTS.join('\n');
  for (const table of SOURCE_TABLES) {
    assert.equal(
      new RegExp(`\\b${table}\\b`).test(joined),
      false,
      `migration must not touch source table "${table}"`
    );
  }
});

test('migration: question_id columns are TEXT to match questions.id', () => {
  const sentLog = STATEMENTS.find((s) => /CREATE TABLE IF NOT EXISTS sent_log /.test(s));
  const flags = STATEMENTS.find((s) => /CREATE TABLE IF NOT EXISTS question_flags /.test(s));
  assert.match(sentLog, /question_id\s+TEXT\s+NOT NULL/);
  assert.match(flags, /question_id TEXT PRIMARY KEY/);
});

test('migration: idempotency index on the slot key exists', () => {
  const uniqueIdx = STATEMENTS.find((s) => /uq_sent_log_slot_question/.test(s));
  assert.match(uniqueIdx, /UNIQUE INDEX IF NOT EXISTS/);
  assert.match(uniqueIdx, /\(schedule_id, run_date, question_id\)/);
});

test('assertSafeSql: rejects dangerous SQL with a clear message', () => {
  assert.throws(() => assertSafeSql('DROP TABLE questions;'), /forbidden keyword\(s\): DROP/);
  assert.throws(() => assertSafeSql('UPDATE questions SET x = 1;'), /UPDATE/);
  assert.throws(() => assertSafeSql('DELETE FROM sent_log;'), /DELETE/);
  assert.doesNotThrow(() => assertSafeSql('CREATE TABLE IF NOT EXISTS t (updated_at TEXT);'));
});

test('splitStatements: strips comment lines, splits, and ignores the word "updated"', () => {
  const stmts = splitStatements('-- a comment\nCREATE TABLE IF NOT EXISTS t (updated_at TEXT);\n-- another\nCREATE INDEX IF NOT EXISTS i ON t(updated_at);\n');
  assert.equal(stmts.length, 2);
  assert.deepEqual(findForbidden(stmts.join('\n')), []);
});
