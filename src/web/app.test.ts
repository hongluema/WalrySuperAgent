import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebApp, type RunStreamEvent } from './app.js';

function parseSse(body: string): RunStreamEvent[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'))
    .filter(Boolean)
    .map((data) => JSON.parse(data) as RunStreamEvent);
}

test('GET /health 返回 ok', async () => {
  const app = createWebApp(async () => {});
  const res = await app.request('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, mode: 'web' });
});

test('POST /api/v1/runs 拒绝空消息', async () => {
  const app = createWebApp(async () => {});
  const res = await app.request('/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'c1', message: '   ' }),
  });
  assert.equal(res.status, 400);
  const payload = await res.json() as { error: { code: string } };
  assert.equal(payload.error.code, 'INVALID_REQUEST');
});

test('POST /api/v1/runs 以 SSE 流式返回 text-delta 和 done', async () => {
  const app = createWebApp(async ({ onEvent }) => {
    await onEvent({ type: 'text-delta', text: '你好' });
    await onEvent({ type: 'tool-call', name: 'web_search', input: { q: 'hono' } });
    await onEvent({ type: 'text-delta', text: '，世界' });
  });

  const res = await app.request('/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'c1', message: 'hello' }),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const events = parseSse(await res.text());
  assert.deepEqual(events, [
    { type: 'text-delta', text: '你好' },
    { type: 'tool-call', name: 'web_search' },
    { type: 'text-delta', text: '，世界' },
    { type: 'done' },
  ]);
});

test('POST /api/v1/runs 把 runTurn 异常变成 error 事件', async () => {
  const app = createWebApp(async () => {
    throw new Error('模型超时');
  });

  const res = await app.request('/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi' }),
  });

  const events = parseSse(await res.text());
  assert.deepEqual(events, [{ type: 'error', message: '模型超时' }]);
});
