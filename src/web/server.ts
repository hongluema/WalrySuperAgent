import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { WebAgentService } from "./agent-service.js";

const runSchema = z.object({
  conversationId: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(20_000),
  diagnosticAnswers: z.record(z.string()).optional(),
  sessionMode: z.enum(["teach", "explain"]).optional(),
});

export const app = new Hono();
const agent = new WebAgentService();

app.get("/health", (context) =>
  context.json({ status: "ok", service: "walry-web-agent" }),
);

app.post("/api/v1/runs", async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json(
      { error: { code: "INVALID_REQUEST", message: "请求体必须是 JSON" } },
      400,
    );
  }

  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return context.json(
      { error: { code: "INVALID_REQUEST", message: "conversationId 或 message 不合法" } },
      400,
    );
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by abort or a previous terminal event */
        }
      };

      void agent
        .run(parsed.data, context.req.raw.signal, send)
        .then((result) => {
          // TutorOrchestrator emits its own semantic terminal event. Generic
          // Agent Loop runs return a non-empty final message and need the
          // web-layer terminal event here.
          if (result.message.content) send({ type: "run.completed", runId: result.runId });
          finish();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Agent 运行失败";
          console.error(`[web-agent] ${message}`);
          send({ type: "error", message });
          finish();
        });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
    },
  });
});

function isMainModule(): boolean {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

if (isMainModule()) {
  const port = Number(process.env.WALRY_WEB_PORT ?? 3100);
  serve({ fetch: app.fetch, port });
  console.log(`[web-agent] listening on http://127.0.0.1:${port}`);
}
