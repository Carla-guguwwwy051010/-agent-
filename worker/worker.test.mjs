import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const origin = 'https://my-agent-demo-233.netlify.app';
function fakeDB() {
  let rows = [];
  let nextId = 1;
  function statement(sql) {
    return {
      bind(...values) {
        return {
          async all() {
            const selected = rows.filter(row => row.session_id === values[0]);
            return { results: selected.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id) };
          },
          async run() {
            if (sql.startsWith('DELETE')) {
              const before = rows.length;
              rows = rows.filter(row => row.session_id !== values[0]);
              return { meta: { changes: before - rows.length } };
            }
            rows.push({ id: nextId++, session_id: values[0], role: values[1], content: values[2], created_at: values[3] });
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  }
  return {
    prepare: statement,
    async batch(statements) { for (const item of statements) await item.run(); },
  };
}
function req(path, method = 'GET', body, extra = {}) {
  return new Request('https://example.workers.dev' + path, {
    method,
    headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('CORS preflight and denied origins', async () => {
  const preflight = await worker.fetch(req('/api/chat', 'OPTIONS'), { DB: fakeDB() });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /DELETE/);
  const blocked = await worker.fetch(new Request('https://example.workers.dev/api/health', { headers: { Origin: 'https://untrusted.example' } }), { DB: fakeDB() });
  assert.equal(blocked.status, 403);
});

test('chat persists both roles, history is isolated and deletion is scoped', async () => {
  const env = { DB: fakeDB() };
  const session = 'session_12345678';
  const chat = await worker.fetch(req('/api/chat', 'POST', { session_id: session, message: '我的问题' }), env);
  assert.equal(chat.status, 200);
  assert.match((await chat.json()).reply, /模拟回答/);
  const history = await worker.fetch(req('/api/history?session_id=' + session), env);
  const data = await history.json();
  assert.deepEqual(data.messages.map(x => x.role), ['user', 'assistant']);
  assert.equal(data.messages[0].content, '我的问题');
  const other = await worker.fetch(req('/api/history?session_id=other_session_123'), env);
  assert.equal((await other.json()).messages.length, 0);
  const deleted = await worker.fetch(req('/api/history?session_id=' + session, 'DELETE'), env);
  assert.equal((await deleted.json()).deleted, 2);
  assert.equal((await (await worker.fetch(req('/api/history?session_id=' + session), env)).json()).messages.length, 0);
});

test('validation and database errors return JSON', async () => {
  assert.equal((await worker.fetch(req('/api/chat', 'POST', { session_id: 'bad', message: 'hi' }), { DB: fakeDB() })).status, 400);
  const unavailable = await worker.fetch(req('/api/history?session_id=session_12345678'), { DB: { prepare() { throw new Error('private DB details'); } } });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: '数据库暂时不可用，请稍后重试' });
  assert.equal((await worker.fetch(req('/api/health'), { DB: fakeDB() })).status, 200);
});
