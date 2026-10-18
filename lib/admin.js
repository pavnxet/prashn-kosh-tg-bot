'use strict';

/**
 * admin.js — authorisation and audit trail.
 *
 * Two sources of authority:
 *   1. `OWNER_TG_ID` from the environment — authoritative and cannot be revoked
 *      from inside Telegram. Only the env var can grant or remove ownership.
 *   2. The `bot_admins` table — everyone else, with a role.
 *
 * Every access decision and every administrative mutation is written to
 * `audit_log` (best-effort: a failed audit write is logged, never fatal).
 */

/** Roles accepted by the `bot_admins.role` CHECK constraint. */
const ROLES = Object.freeze(['owner', 'admin', 'editor']);

/** Roles an admin may grant to someone else (owner is env-only). */
const GRANTABLE_ROLES = Object.freeze(['admin', 'editor']);

const SELECT_ADMIN = 'SELECT tg_user_id, role, added_by, created_at FROM bot_admins WHERE tg_user_id = ?';

/**
 * @param {object} opts
 * @param {object} opts.db      Turso client from `lib/turso.js`.
 * @param {object} opts.config  Frozen config from `lib/config.js`.
 * @param {object} [opts.log]
 */
function createAuth(opts = {}) {
  const { db, config, log } = opts;
  if (!db) throw new Error('admin: db is required');

  const ownerId =
    config && Number.isSafeInteger(config.ownerTgId) ? config.ownerTgId : null;

  /** True when `userId` is the env-configured owner. Never touches the DB. */
  function isOwner(userId) {
    return ownerId !== null && Number(userId) === ownerId;
  }

  function getRow(userId) {
    return db.get(SELECT_ADMIN, [userId]);
  }

  /** Owner, or anyone present in `bot_admins`. */
  async function isAdmin(userId) {
    if (isOwner(userId)) return true;
    const row = await getRow(userId);
    return Boolean(row);
  }

  /**
   * Gate for a privileged command.
   * @returns {Promise<boolean>} false when the caller must be refused.
   */
  async function requireAdmin(userId, action = 'unknown') {
    const allowed = await isAdmin(userId);
    if (!allowed) {
      await logAudit(userId, 'access_denied', `action=${action}`);
      if (log) log.warn('access_denied', { userId, action });
    }
    return allowed;
  }

  async function addAdmin(userId, role, addedBy = null) {
    if (!ROLES.includes(role)) {
      throw new Error(`admin: invalid role "${role}" (expected ${GRANTABLE_ROLES.join(' | ')})`);
    }
    if (role === 'owner') {
      throw new Error('admin: the owner role is controlled by OWNER_TG_ID, not by the bot');
    }
    await db.execute(
      'INSERT INTO bot_admins (tg_user_id, role, added_by) VALUES (?, ?, ?) ' +
        'ON CONFLICT(tg_user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by',
      [userId, role, addedBy]
    );
    await logAudit(addedBy, 'admin_added', `user=${userId} role=${role}`);
    return getRow(userId);
  }

  async function removeAdmin(userId, actorId = null) {
    if (isOwner(userId)) {
      throw new Error('admin: the owner cannot be removed from the bot');
    }
    await db.execute('DELETE FROM bot_admins WHERE tg_user_id = ?', [userId]);
    await logAudit(actorId, 'admin_removed', `user=${userId}`);
    return { removed: true };
  }

  async function listAdmins() {
    return db.all(
      'SELECT tg_user_id, role, added_by, created_at FROM bot_admins ORDER BY tg_user_id'
    );
  }

  /** Append an audit row. Best-effort by design. */
  async function logAudit(actorId, action, detail) {
    try {
      await db.execute('INSERT INTO audit_log (actor_id, action, detail) VALUES (?, ?, ?)', [
        actorId === undefined ? null : actorId,
        String(action),
        detail === undefined || detail === null ? null : String(detail)
      ]);
    } catch (err) {
      if (log) log.warn('audit_write_failed', { action, error: err.message });
    }
  }

  return {
    ownerId,
    hasOwner: ownerId !== null,
    isOwner,
    isAdmin,
    requireAdmin,
    addAdmin,
    removeAdmin,
    listAdmins,
    logAudit
  };
}

module.exports = { createAuth, ROLES, GRANTABLE_ROLES, SELECT_ADMIN };
