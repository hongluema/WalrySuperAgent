import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { WebAgentService } from "./agent-service.js";
import { MACRO_DOMAINS } from "../tutor/domain/catalog.js";
import { createKnowledgeService } from "../knowledge/factory.js";

const runSchema = z.object({
  conversationId: z.string().trim().min(1).max(120),
  learningSessionId: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(20_000),
  diagnosticAnswers: z.record(z.string()).optional(),
  teachingPolicy: z.enum(["legacy.v1", "web-teacher.v2"]).optional(),
  learningSupport: z.object({ questionId: z.string().trim().min(1).max(120), hintSeen: z.boolean() }).optional(),
  sessionMode: z.enum(["teach", "explain"]).optional(),
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
  }).optional(),
});

export const app = new Hono();
const agent = new WebAgentService();
const knowledge = createKnowledgeService();
const knowledgeScopeConfig = {
  knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID ?? "default",
  ownerId: process.env.KNOWLEDGE_OWNER_ID ?? "local",
};
const knowledgeApiToken = process.env.KNOWLEDGE_API_TOKEN;
const configuredMaxUploadBytes = Number(process.env.KNOWLEDGE_MAX_UPLOAD_BYTES);
const maxKnowledgeUploadBytes = Number.isFinite(configuredMaxUploadBytes) && configuredMaxUploadBytes >= 1
  ? configuredMaxUploadBytes
  : 50 * 1024 * 1024;

function knowledgeScope() {
  return { ...knowledgeScopeConfig };
}

function knowledgeAccessError(context: { req: { header(name: string): string | undefined } }): Response | undefined {
  if (knowledgeApiToken) {
    const authorization = context.req.header("authorization");
    if (authorization !== `Bearer ${knowledgeApiToken}`) {
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "知识库接口需要有效的 KNOWLEDGE_API_TOKEN" } }), {
        status: 401,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }
  }
  const host = process.env.WALRY_WEB_HOST ?? "127.0.0.1";
  if (!knowledgeApiToken && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    return new Response(JSON.stringify({ error: { code: "KNOWLEDGE_AUTH_REQUIRED", message: "非本机部署必须配置 KNOWLEDGE_API_TOKEN" } }), {
      status: 503,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  }
  return undefined;
}

app.get("/health", (context) =>
  context.json({ status: "ok", service: "walry-web-agent" }),
);

app.post("/api/v1/knowledge/documents", async (context) => {
  const accessError = knowledgeAccessError(context);
  if (accessError) return accessError;
  const contentLength = Number(context.req.header("content-length") ?? 0);
  if (contentLength > maxKnowledgeUploadBytes) {
    return context.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "上传文件超过大小限制" } }, 413);
  }
  let body: Record<string, unknown>;
  try {
    body = await context.req.parseBody();
  } catch {
    return context.json({ error: { code: "INVALID_REQUEST", message: "请求体必须是 multipart/form-data" } }, 400);
  }
  const file = body.file;
  if (!(file instanceof File)) {
    return context.json({ error: { code: "INVALID_REQUEST", message: "必须上传 file 字段" } }, 400);
  }
  if (file.size > maxKnowledgeUploadBytes) {
    return context.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "上传文件超过大小限制" } }, 413);
  }
  const originalName = file.name || "document";
  try {
    const document = await knowledge.ingest({
      scope: knowledgeScope(),
      originalName,
      mimeType: file.type || "application/octet-stream",
      file: new Uint8Array(await file.arrayBuffer()),
      signal: context.req.raw.signal,
    });
    return context.json({ document }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识文档导入失败";
    console.error(`[knowledge-ingest] ${message}`);
    return context.json({ error: { code: "INGEST_FAILED", message: "知识文档导入失败，请稍后重试" } }, 502);
  }
});

app.get("/api/v1/knowledge/documents", async (context) => {
  const accessError = knowledgeAccessError(context);
  if (accessError) return accessError;
  try {
    const documents = await knowledge.listDocuments(knowledgeScope());
    return context.json({ documents });
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识文档查询失败";
    console.error(`[knowledge-list] ${message}`);
    return context.json({ error: { code: "KNOWLEDGE_UNAVAILABLE", message: "知识库暂时不可用，请稍后重试" } }, 503);
  }
});

app.post("/api/v1/knowledge/search", async (context) => {
  const accessError = knowledgeAccessError(context);
  if (accessError) return accessError;
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: { code: "INVALID_REQUEST", message: "请求体必须是 JSON" } }, 400);
  }
  const parsed = z.object({
    query: z.string().trim().min(1).max(2_000),
    topK: z.number().int().min(1).max(20).optional(),
  }).safeParse(body);
  if (!parsed.success) return context.json({ error: { code: "INVALID_REQUEST", message: "query 不合法" } }, 400);
  try {
    const hits = await knowledge.search({
      scope: knowledgeScope(),
      query: parsed.data.query,
      topK: parsed.data.topK,
    });
    return context.json({ hits });
  } catch (error) {
    const message = error instanceof Error ? error.message : "知识检索失败";
    console.error(`[knowledge-search] ${message}`);
    return context.json({ error: { code: "KNOWLEDGE_UNAVAILABLE", message: "知识库暂时不可用，请稍后重试" } }, 503);
  }
});

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
  const hostname = process.env.WALRY_WEB_HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname });
  console.log(`[web-agent] listening on http://${hostname}:${port}`);
}
