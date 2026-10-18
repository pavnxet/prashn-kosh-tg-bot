'use strict';

/**
 * Tests for the zero-dependency Turso HTTP client (no network — `fetch` is faked).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTursoClient,
  encodeArg,
  decodeValue,
  rowsToObjects,
  TursoError
} = require('../lib/turso');

function fakeFetch(response, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = JSON.parse(init.body);
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      text: async () => JSON.stringify(response.body)
    };
  };
}

const okExecute = (cols, rows) => ({
  body: {
    baton: null,
    base_url: null,
    results: [{ type: 'ok', response: { type: 'execute', result: { cols, rows } } }]
  }
});

test('encodeArg: maps JS values to typed Turso values', () => {
  assert.deepEqual(encodeArg(null), { type: 'null' });
  assert.deepEqual(encodeArg(undefined), { type: 'null' });
  assert.deepEqual(encodeArg(true), { type: 'integer', value: '1' });
  assert.deepEqual(encodeArg(42), { type: 'integer', value: '42' });
  assert.deepEqual(encodeArg(3.5), { type: 'float', value: 3.5 });
  assert.deepEqual(encodeArg('hi'), { type: 'text', value: 'hi' });
  assert.deepEqual(encodeArg(10n), { type: 'integer', value: '10' });
  assert.deepEqual(encodeArg(new Uint8Array([1, 2])), { type: 'blob', base64: 'AQI=' });
});

test('decodeValue + rowsToObjects: rebuilds plain objects', () => {
  assert.equal(decodeValue({ type: 'null' }), null);
  assert.equal(decodeValue({ type: 'integer', value: '7' }), 7);
  assert.equal(decodeValue({ type: 'text', value: 'x' }), 'x');
  const result = {
    cols: [{ name: 'id' }, { name: 'title' }],
    rows: [[{ type: 'integer', value: '1' }, { type: 'text', value: 'Q' }]]
  };
  assert.deepEqual(rowsToObjects(result), [{ id: 1, title: 'Q' }]);
  assert.deepEqual(rowsToObjects(null), []);
});

test('client: sends a /v2/pipeline request with typed args and a close op', async () => {
  const capture = {};
  const client = createTursoClient({
    url: 'https://demo.turso.io',
    authToken: 'tok',
    fetchImpl: fakeFetch(okExecute([{ name: 'c' }], [[{ type: 'integer', value: '1' }]]), capture)
  });

  const rows = await client.all('SELECT COUNT(*) AS c FROM "questions"');
  assert.deepEqual(rows, [{ c: 1 }]);
  assert.equal(capture.url, 'https://demo.turso.io/v2/pipeline');
  assert.equal(capture.init.headers.Authorization, 'Bearer tok');
  assert.equal(capture.body.requests.length, 2);
  assert.deepEqual(capture.body.requests[0], {
    type: 'execute',
    stmt: { sql: 'SELECT COUNT(*) AS c FROM "questions"', args: [] }
  });
  assert.deepEqual(capture.body.requests[1], { type: 'close' });
});

test('client: encodes args and drops the trailing close result', async () => {
  const capture = {};
  const client = createTursoClient({
    url: 'https://demo.turso.io/',
    authToken: 'tok',
    fetchImpl: fakeFetch(okExecute([{ name: 'a' }], []), capture)
  });
  await client.execute('SELECT ?', ['x', 1, null]);
  assert.deepEqual(capture.body.requests[0].stmt.args, [
    { type: 'text', value: 'x' },
    { type: 'integer', value: '1' },
    { type: 'null' }
  ]);
  // Trailing slash normalised away.
  assert.equal(capture.url, 'https://demo.turso.io/v2/pipeline');
});

test('client: throws TursoError on HTTP failure and on in-pipeline errors', async () => {
  const httpFail = createTursoClient({
    url: 'https://demo.turso.io',
    authToken: 'tok',
    fetchImpl: fakeFetch({ ok: false, status: 401, body: { error: 'nope' } })
  });
  await assert.rejects(() => httpFail.execute('SELECT 1'), (err) => {
    assert.ok(err instanceof TursoError);
    assert.equal(err.status, 401);
    return true;
  });

  const pipelineFail = createTursoClient({
    url: 'https://demo.turso.io',
    authToken: 'tok',
    fetchImpl: fakeFetch({
      body: { results: [{ type: 'error', error: { message: 'syntax error', code: 'SQL_PARSE_ERROR' } }] }
    })
  });
  await assert.rejects(() => pipelineFail.execute('BROKEN'), /statement 0 failed: syntax error/);
});

test('client: requires url, token and fetch', () => {
  assert.throws(() => createTursoClient({ authToken: 't', fetchImpl: () => {} }), /url is required/);
  assert.throws(() => createTursoClient({ url: 'https://x', fetchImpl: () => {} }), /authToken is required/);
  assert.throws(
    () => createTursoClient({ url: 'https://x', authToken: 't', fetchImpl: null }),
    /fetch is unavailable/
  );
});

test('client: surfaces timeouts as TursoError', async () => {
  const hanging = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const client = createTursoClient({ url: 'https://x', authToken: 't', fetchImpl: hanging, timeoutMs: 5 });
  await assert.rejects(() => client.execute('SELECT 1'), /timed out/);
});
