import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileKnowledgeRepository } from "./repository.js";
import { HttpMineruClient } from "./mineru-client.js";
import { DefaultKnowledgeService } from "./service.js";
import type { MineruClient } from "./types.js";

test("ingests MinerU structure, persists artifacts, and searches after reloading the file repository", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "walry-knowledge-"));
  try {
    const mineru: MineruClient = {
      async parse() {
        return {
          markdown: "# 现金流\n\n资产带来现金流，负债消耗现金流。",
          contentList: [
            { type: "title", text: "现金流", text_level: 1, page_idx: 0 },
            { type: "text", text: "资产带来现金流，负债消耗现金流。", page_idx: 1 },
          ],
          images: {},
          parserVersion: "test-mineru",
        };
      },
    };
    const repository = new FileKnowledgeRepository(join(dataDir, "index.json"));
    const service = new DefaultKnowledgeService({
      repository,
      mineru,
      embed: async (texts) => texts.map((text) => [text.includes("现金流") ? 1 : 0, text.length]),
      dataDir,
    });

    const document = await service.ingest({
      scope: { knowledgeBaseId: "finance", ownerId: "user-1" },
      originalName: "finance.pdf",
      mimeType: "application/pdf",
      file: new TextEncoder().encode("fake-pdf"),
    });
    assert.equal(document.status, "ready");
    assert.equal(document.chunkCount, 1);
    assert.match(await readFile(join(dataDir, "documents", document.id, "document.md"), "utf8"), /现金流/);

    const reloaded = new DefaultKnowledgeService({
      repository: new FileKnowledgeRepository(join(dataDir, "index.json")),
      mineru,
      embed: async (texts) => texts.map((text) => [text.includes("现金流") ? 1 : 0, text.length]),
      dataDir,
    });
    const hits = await reloaded.search({
      scope: { knowledgeBaseId: "finance", ownerId: "user-1" },
      query: "现金流",
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].document.originalName, "finance.pdf");
    assert.equal(hits[0].pageStart, 1);
    assert.deepEqual(hits[0].sectionPath, ["现金流"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("calls MinerU file_parse and normalizes its markdown/content-list response", async () => {
  let requestUrl = "";
  let requestMethod = "";
  const client = new HttpMineruClient("http://mineru.test", async (input, init) => {
    requestUrl = String(input);
    requestMethod = init?.method ?? "";
    const form = init?.body as FormData;
    assert.equal(form.get("return_md"), "true");
    assert.equal(form.get("return_content_list"), "true");
    assert.equal(form.get("return_images"), "true");
    return new Response(JSON.stringify({
      version: "3.0.0-test",
      results: {
        lesson: {
          md_content: "# Lesson\n\nParsed content",
          content_list: JSON.stringify([{ type: "text", text: "Parsed content", page_idx: 0 }]),
          images: {},
        },
      },
    }), { status: 200 });
  });

  const parsed = await client.parse({
    file: new Uint8Array([1, 2, 3]),
    fileName: "lesson.pdf",
    mimeType: "application/pdf",
  });
  assert.equal(requestUrl, "http://mineru.test/file_parse");
  assert.equal(requestMethod, "POST");
  assert.equal(parsed.parserVersion, "3.0.0-test");
  assert.match(parsed.markdown, /Parsed content/);
  assert.deepEqual(parsed.contentList, [{ type: "text", text: "Parsed content", page_idx: 0 }]);
});

test("serializes concurrent file-repository writes without losing documents", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "walry-knowledge-concurrent-"));
  try {
    const repository = new FileKnowledgeRepository(join(dataDir, "index.json"));
    const makeDocument = (id: string) => ({
      id,
      knowledgeBaseId: "default",
      ownerId: "local",
      originalName: `${id}.pdf`,
      mimeType: "application/pdf",
      sha256: id,
      parser: "mineru" as const,
      status: "ready" as const,
      artifactDir: dataDir,
      chunkCount: 1,
      createdAt: new Date().toISOString(),
    });
    await Promise.all([
      repository.saveDocument(makeDocument("a"), [{ id: "a#0", documentId: "a", content: "A", embedding: [1], sectionPath: [], blockType: "text", ordinal: 0, metadata: {} }]),
      repository.saveDocument(makeDocument("b"), [{ id: "b#0", documentId: "b", content: "B", embedding: [1], sectionPath: [], blockType: "text", ordinal: 0, metadata: {} }]),
    ]);
    assert.deepEqual((await repository.listDocuments({ knowledgeBaseId: "default", ownerId: "local" })).map((item) => item.id).sort(), ["a", "b"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
