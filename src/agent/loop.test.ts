import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "ai";
import { agentLoop } from "./loop.js";
import { ToolRegistry } from "../tools/registry.js";

test("provider 流错误应保留原始原因，且余额不足不重试", async () => {
  let calls = 0;
  const model = {
    specificationVersion: "v2" as const,
    provider: "test",
    modelId: "error-model",
    get supportedUrls() {
      return Promise.resolve({});
    },
    async doStream() {
      calls += 1;
      let errorEventSent = false;
      return {
        stream: new ReadableStream({
          pull(controller) {
            if (!errorEventSent) {
              errorEventSent = true;
              controller.enqueue({
                type: "error",
                error: new Error("Insufficient Balance"),
              });
              return;
            }
            controller.error(
              new Error("No output generated. Check the stream for errors."),
            );
          },
        }),
      };
    },
  };
  const messages: ModelMessage[] = [{ role: "user", content: "你好" }];

  await assert.rejects(
    agentLoop(model, new ToolRegistry(), messages, "测试系统提示词"),
    /Insufficient Balance/,
  );
  assert.equal(calls, 1);
});
