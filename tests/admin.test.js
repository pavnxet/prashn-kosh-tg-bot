'use strict';

/**
 * Tests for admin authorisation and the audit trail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuth, ROLES, GRANTABLE_ROLES } = require('../lib/admin');
const { createFakeDb, createTestLogger } = require('./support/fakes');

const config = { ownerTgId: 555 };

function build(seed, cfg = config) {
  const db = createFakeDb(seed);
  const log = createTestLogger();
  return { db, log, auth: createAuth({ db, config: cfg, log }) };
}

test('admin: the env owner is always an admin and needs no DB row', async () => {
  const { auth, db } = build();
  assert.equal(auth.hasOwner, true);
  assert.equal(auth.isOwner(555), true);
  assert.equal(await auth.isAdmin(555), true);
  assert.equal(db.calls.length, 0, 'owner check must not hit the database');
});

test('admin: a missing OWNER_TG_ID leaves the bot with no owner', () => {
  const { auth } = build({}, { ownerTgId: null });
  assert.equal(auth.hasOwner, false);
  assert.equal(auth.isOwner(555), false);
});

test('admin: a stranger is refused and the refusal is audited', async () => {
  const { auth, db } = build();

  const allowed = await auth.requireAdmin(9001, '/connect');

  assert.equal(allowed, false);
  assert.deepEqual(
    db.audit.map((row) => ({ actor: row.actor_id, action: row.action, detail: row.detail })),
    [{ actor: 9001, action: 'access_denied', detail: 'action=/connect' }]
  );
});

test('admin: a row in bot_admins grants access', async () => {
  const { auth } = build({ admins: [{ tg_user_id: 777, role: 'admin', added_by: 555, created_at: 'x' }] });

  assert.equal(await auth.isAdmin(777), true);
  assert.equal(await auth.requireAdmin(777, '/status'), true);
  assert.equal(await auth.isAdmin(778), false);
});

test('admin: addAdmin validates the role and refuses to mint an owner', async () => {
  const { auth, db } = build();

  await assert.rejects(() => auth.addAdmin(777, 'superuser'), /invalid role/);
  await assert.rejects(() => auth.addAdmin(777, 'owner'), /controlled by OWNER_TG_ID/);

  const row = await auth.addAdmin(777, 'editor', 555);
  assert.equal(row.role, 'editor');
  assert.equal(row.added_by, 555);
  assert.ok(db.audit.some((r) => r.action === 'admin_added' && r.detail === 'user=777 role=editor'));
});

test('admin: addAdmin is idempotent and updates the role in place', async () => {
  const { auth } = build();

  await auth.addAdmin(777, 'editor', 555);
  const updated = await auth.addAdmin(777, 'admin', 555);

  assert.equal(updated.role, 'admin');
  assert.equal((await auth.listAdmins()).length, 1);
});

test('admin: the owner cannot be removed, others can', async () => {
  const { auth, db } = build({ admins: [{ tg_user_id: 777, role: 'admin' }] });

  await assert.rejects(() => auth.removeAdmin(555, 555), /owner cannot be removed/);

  await auth.removeAdmin(777, 555);
  assert.deepEqual(await auth.listAdmins(), []);
  assert.ok(db.audit.some((r) => r.action === 'admin_removed' && r.detail === 'user=777'));
});

test('admin: ROLES match the schema CHECK constraint', () => {
  assert.deepEqual([...ROLES], ['owner', 'admin', 'editor']);
  assert.deepEqual([...GRANTABLE_ROLES], ['admin', 'editor']);
});

test('admin: a failing audit write never breaks the access decision', async () => {
  const { db, log, auth } = build();
  db.execute = async () => {
    throw new Error('database is down');
  };

  const allowed = await auth.requireAdmin(9001, '/status');

  assert.equal(allowed, false, 'the decision still stands');
  assert.ok(log.lines.some((l) => l.msg === 'audit_write_failed'));
});
