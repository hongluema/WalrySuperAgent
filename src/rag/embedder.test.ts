import assert from "node:assert/strict";
import test from "node:test";
import { createDashScopeEmbedder } from "./embedder.js";

test("DashScope embedder splits inputs into batches of 10", async () => {
  const calls: string[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    calls.push(body.input);
    return new Response(JSON.stringify({
      data: body.input.map(() => ({ embedding: [1, 0] })),
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const embedder = createDashScopeEmbedder("test-key");
    const texts = Array.from({ length: 11 }, (_, i) => `chunk-${i}`);
    const vectors = await embedder(texts);
    assert.equal(vectors.length, 11);
    assert.deepEqual(calls.map((batch) => batch.length), [10, 1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
