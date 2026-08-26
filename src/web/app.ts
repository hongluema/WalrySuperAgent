import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { AgentLoopEvent } from '../agent/loop.js';

export type RunStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; name: string }
  | { type: 'tool-result'; name: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type RunTurn = (input: {
  conversationId: string;
  message: string;
  onEvent: (event: AgentLoopEvent) => Promise<void>;
  signal: AbortSignal;
}) => Promise<void>;

const MAX_MESSAGE_CHARS = 20_000;

function toWireEvent(event: AgentLoopEvent): RunStreamEvent {
  switch (event.type) {
    case 'text-delta':
      return { type: 'text-delta', text: event.text };
    case 'tool-call':
      return { type: 'tool-call', name: event.name };
    case 'tool-result':
      return { type: 'tool-result', name: event.name };
    case 'error':
      return { type: 'error', message: event.message };
  }
}

export function createWebApp(runTurn: RunTurn) {
  const app = new Hono();
  app.use('*', cors());

  app.get('/health', (c) => c.json({ ok: true, mode: 'web' }));

  app.get('/', (c) => c.json({
    name: 'Walry Super Agent',
    mode: 'web',
    endpoints: {
      health: 'GET /health',
      runs: 'POST /api/v1/runs',
    },
  }));

  app.post('/api/v1/runs', async (c) => {
    let body: { conversationId?: unknown; message?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: 'INVALID_REQUEST', message: '请求体必须是 JSON' } },
        400,
      );
    }

    const conversationId =
      typeof body.conversationId === 'string' && body.conversationId.trim()
        ? body.conversationId.trim()
        : 'new';
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!message || message.length > MAX_MESSAGE_CHARS) {
      return c.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'message 必须是 1 到 20000 个字符',
          },
        },
        400,
      );
    }

    return streamSSE(c, async (stream) => {
      const write = async (event: RunStreamEvent) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };

      try {
        await runTurn({
          conversationId,
          message,
          signal: c.req.raw.signal,
          onEvent: async (event) => {
            await write(toWireEvent(event));
          },
        });
        await write({ type: 'done' });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Agent 运行失败';
        await write({ type: 'error', message: messageText });
      }
    });
  });

  return app;
}
