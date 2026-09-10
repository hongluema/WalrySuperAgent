import { verifyInternalIdentity } from "./internal-auth.js";
import { learnerMemoryService } from "./learner-memory-service.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { WebAgentService } from "./agent-service.js";
import { MACRO_DOMAINS } from "../tutor/domain/catalog.js";
import { TutorStore } from "../tutor/store.js";
import { summarizeBookStudy } from "../tutor/book-study.js";

const runSchema = z.object({
  conversationId: z.string().trim().min(1).max(120),
  learningSessionId: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(20_000),
  diagnosticAnswers: z.record(z.string()).optional(),
  teachingPolicy: z.enum(["legacy.v1", "web-teacher.v2"]).optional(),
  learningSupport: z.object({ questionId: z.string().trim().min(1).max(120), hintSeen: z.boolean() }).optional(),
  sessionMode: z.enum(["teach", "explain", "read"]).optional(),
  clientCommand: z.object({
    type: z.literal("UPDATE_SUBJECT"),
    correction: z.object({
      macroDomain: z.enum(MACRO_DOMAINS),
      subdomainPath: z.array(z.string().trim().min(1).max(80)).max(6).optional(),
      secondaryDomains: z.array(z.enum(MACRO_DOMAINS)).max(8).optional(),
    }),
  }).optional(),
});

const quickAskSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  context: z.object({
    topic: z.string().trim().optional(),
    chapter: z.string().trim().optional(),
    objective: z.string().trim().optional(),
    recentDialogue: z.string().trim().optional(),
    highlight: z.string().trim().max(2000).optional(),
    sourceContext: z.record(z.unknown()).optional(),
    history: z.array(z.record(z.unknown())).max(8).optional(),
  }).optional(),
});

export const app = new Hono();
const agent = new WebAgentService();
const readingStore = new TutorStore();

// Internal service endpoint; the Web BFF resolves ownership before forwarding.
app.get("/api/v1/conversations/:id/reading", async (context) => {
  const id = context.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return context.json({ error: { message: "课堂 ID 无效" } }, 400);
  context.header("Cache-Control", "no-store");
  const state = await readingStore.load(id);
  if (state?.sessionMode !== "read" || !state.bookStudy) return context.json({ reading: null });
  const book = state.bookStudy.books[state.bookStudy.activeBook];
  return context.json({ reading: {
    ...summarizeBookStudy(state.bookStudy, new Date()),
    chapters: book.chapters,
    notes: book.notes,
    updatedAt: book.updatedAt,
  } });
});

app.get("/health", (context) =>
  context.json({ status: "ok", service: "walry-web-agent" }),
);

app.post("/api/v1/quick-ask", async (context) => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json(
      { error: { code: "INVALID_REQUEST", message: "请求体必须是 JSON" } },
      400,
    );
  }

  const parsed = quickAskSchema.safeParse(body);
  if (!parsed.success) {
    return context.json(
      { error: { code: "INVALID_REQUEST", message: "message 不合法" } },
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
          /* already closed */
        }
      };

      void agent
        .quickAsk(
          parsed.data,
          context.req.raw.signal,
          (chunk) => {
            send({ type: "chunk", delta: chunk });
          },
        )
        .then(() => {
          send({ type: "done" });
          finish();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "快问运行失败";
          console.error(`[web-agent-quick-ask] ${message}`);
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

app.post("/api/v1/runs", async (context) => {
  let body: unknown;
  let rawBody: string;
  try {
    rawBody = await context.req.text();
    body = JSON.parse(rawBody);
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

  const userId = verifyInternalIdentity(context.req.raw.headers, "POST", "/api/v1/runs", rawBody);
  if (process.env.WALRY_INTERNAL_SECRET && !userId) return context.json({ error: { message: "内部身份验证失败" } }, 401);
  if (userId) {
    const { pool } = learnerMemoryService();
    const owned = await pool.query("SELECT 1 FROM cheerful_conversations WHERE walry_conversation_id = $1 AND user_id = $2", [parsed.data.conversationId, userId]);
    if (!owned.rowCount) return context.json({ error: { message: "没有找到这堂课" } }, 404);
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
        .run({ ...parsed.data, learnerId: userId }, context.req.raw.signal, send)
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

app.all("/api/v1/learning-memory", memoryEndpoint);
app.post("/api/v1/learning-memory/backfill", memoryEndpoint);
app.post("/api/v1/learning-memory/corrections", memoryEndpoint);

async function memoryEndpoint(context: import("hono").Context) {
  context.header("Cache-Control", "no-store");
  const url = new URL(context.req.url);
  const body = await context.req.text();
  const userId = verifyInternalIdentity(context.req.raw.headers, context.req.method, `${url.pathname}${url.search}`, body);
  if (!userId) return context.json({ error: { message: "内部身份验证失败" } }, 401);
  try {
    const { memory } = learnerMemoryService();
    await memory.ensureSchema();
    if (context.req.method === "GET") return context.json(await memory.get(userId));
    if (context.req.method === "PATCH") {
      const parsed = z.object({ enabled: z.boolean().optional(), teachingPreference: z.string().trim().max(600).optional() }).strict().safeParse(JSON.parse(body));
      if (!parsed.success) return context.json({ error: { message: "记忆设置不合法" } }, 400);
      await memory.updatePreferences(userId, parsed.data);
    } else if (context.req.method === "DELETE") {
      await memory.remove(userId, url.searchParams.get("itemId") ?? undefined);
    } else if (url.pathname.endsWith("/backfill")) {
      await memory.backfill(userId);
    } else if (url.pathname.endsWith("/corrections")) {
      const parsed = z.object({ itemId: z.string().min(1).max(200) }).strict().safeParse(JSON.parse(body));
      if (!parsed.success) return context.json({ error: { message: "请选择要复核的记忆" } }, 400);
      await memory.correct(userId, parsed.data.itemId);
    } else return context.json({ error: { message: "不支持此操作" } }, 405);
    return context.json(await memory.get(userId));
  } catch (error) {
    if (error instanceof SyntaxError) return context.json({ error: { message: "请求体必须是 JSON" } }, 400);
    console.error("[learner-memory]", error);
    return context.json({ error: { message: "学习记忆暂不可用，请稍后重试" } }, 503);
  }
}

function isMainModule(): boolean {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

if (isMainModule()) {
  const port = Number(process.env.WALRY_WEB_PORT ?? 3100);
  const hostname = process.env.WALRY_WEB_HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname });
  console.log(`[web-agent] listening on http://${hostname}:${port}`);
}
