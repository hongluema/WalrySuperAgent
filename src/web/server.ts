import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { WebAgentService } from "./agent-service.js";

const runSchema = z.object({
  conversationId: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(20_000),
});

export const app = new Hono();
const agent = new WebAgentService();

app.get("/health", (context) =>
  context.json({ status: "ok", service: "walry-web-agent" }),
);

/**
 * 首版先提供非流式 JSON 接口，验证 Cheerful → Walry → 模型 → Cheerful
 * 的完整闭环。流式 AgentEvent 会在下一阶段复用同一个 Facade 加入。
 */
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

  try {
    const result = await agent.run(parsed.data);
    return context.json(result, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent 运行失败";
    console.error(`[web-agent] ${message}`);
    return context.json(
      { error: { code: "AGENT_RUN_FAILED", message } },
      500,
    );
  }
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
