'use strict';

/**
 * turso.js — zero-dependency Turso/libSQL client over the HTTP v2 pipeline API.
 *
 * Why not `@libsql/client`: it can pull a native `libsql` optional dependency that is
 * unreliable on the J7 Max's `armv7l` / Android Bionic userland (see ADR-002). Node 20's
 * global `fetch` is enough.
 *
 * Protocol: `POST {url}/v2/pipeline` with `Authorization: Bearer <token>` and a body of
 * `{ baton: null, requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }] }`.
 * Each arg is a typed value object, e.g. `{ type: 'text', value: 'x' }`.
 *
 * This module never logs and never includes the auth token in thrown errors.
 */

const DEFAULT_TIMEOUT_MS = 15000;

class TursoError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'TursoError';
    this.status = meta.status ?? null;
    this.detail = meta.detail ?? null;
  }
}

/** Encode a JS value into a Turso HTTP typed-value object. */
function encodeArg(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  if (value instanceof Uint8Array) {
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  return { type: 'text', value: String(value) };
}

/** Decode a Turso HTTP typed-value object back into a JS value. */
function decodeValue(cell) {
  if (cell === null || cell === undefined) return null;
  switch (cell.type) {
    case 'null':
      return null;
    case 'integer':
      return Number(cell.value);
    case 'float':
      return Number(cell.value);
    case 'text':
      return cell.value;
    case 'blob':
      return Buffer.from(cell.base64, 'base64');
    default:
      return null;
  }
}

/** Turn a `{ cols, rows }` result into an array of plain objects. */
function rowsToObjects(result) {
  if (!result || !Array.isArray(result.cols) || !Array.isArray(result.rows)) return [];
  const names = result.cols.map((col) => col.name);
  return result.rows.map((row) => {
    const obj = {};
    row.forEach((cell, index) => {
      obj[names[index]] = decodeValue(cell);
    });
    return obj;
  });
}

/**
 * @param {object} opts
 * @param {string} opts.url        HTTPS base URL (e.g. https://db.turso.io).
 * @param {string} opts.authToken  Bearer token.
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 */
function createTursoClient(opts = {}) {
  const { url, authToken, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  if (!url) throw new TursoError('turso: url is required');
  if (!authToken) throw new TursoError('turso: authToken is required');
  if (typeof fetchImpl !== 'function') {
    throw new TursoError('turso: global fetch is unavailable (Node >= 20 required)');
  }

  const endpoint = `${String(url).replace(/\/+$/, '')}/v2/pipeline`;

  async function pipeline(statements) {
    const requests = (statements || []).map((s) => ({
      type: 'execute',
      stmt: { sql: s.sql, args: (s.args || []).map(encodeArg) }
    }));
    requests.push({ type: 'close' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ baton: null, requests }),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new TursoError(`turso: request timed out after ${timeoutMs}ms`, { detail: 'timeout' });
      }
      throw new TursoError(`turso: network error: ${err && err.message}`, { detail: 'network' });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new TursoError(`turso: HTTP ${res.status}`, {
        status: res.status,
        detail: text.slice(0, 300)
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new TursoError('turso: response was not valid JSON', { detail: text.slice(0, 300) });
    }

    const results = data.results || [];
    results.forEach((entry, index) => {
      if (entry && entry.type === 'error') {
        const message = entry.error && entry.error.message ? entry.error.message : 'unknown error';
        throw new TursoError(`turso: statement ${index} failed: ${message}`, {
          detail: entry.error && entry.error.code ? entry.error.code : null
        });
      }
    });

    // Drop the synthetic `close` result; keep one result per input statement.
    return results
      .slice(0, (statements || []).length)
      .map((entry) => (entry && entry.response && entry.response.result) || { cols: [], rows: [] });
  }

  async function execute(sql, args = []) {
    const [result] = await pipeline([{ sql, args }]);
    return result;
  }

  async function all(sql, args = []) {
    return rowsToObjects(await execute(sql, args));
  }

  async function get(sql, args = []) {
    const rows = await all(sql, args);
    return rows.length ? rows[0] : null;
  }

  return { endpoint, pipeline, execute, all, get };
}

module.exports = {
  createTursoClient,
  encodeArg,
  decodeValue,
  rowsToObjects,
  TursoError
};
