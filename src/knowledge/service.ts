import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkMineruDocument } from "./chunker.js";
import type { KnowledgeDependencies, KnowledgeDocument, KnowledgeService, KnowledgeScope } from "./types.js";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

function safeName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9._-\u4e00-\u9fff]/gu, "_").replace(/^\.+/u, "_");
  return normalized || "document";
}

export class DefaultKnowledgeService implements KnowledgeService {
  constructor(private readonly dependencies: KnowledgeDependencies) {}

  async ingest(input: {
    scope: KnowledgeScope;
    originalName: string;
    mimeType: string;
    file: Uint8Array;
    signal?: AbortSignal;
  }): Promise<KnowledgeDocument> {
    const id = `doc_${randomUUID().replace(/-/gu, "")}`;
    const artifactDir = join(this.dependencies.dataDir, "documents", id);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, safeName(input.originalName)), input.file);

    const parsed = await this.dependencies.mineru.parse({
      file: input.file,
      fileName: input.originalName,
      mimeType: input.mimeType,
      signal: input.signal,
    });
    await writeFile(join(artifactDir, "document.md"), parsed.markdown, "utf8");
    await writeFile(join(artifactDir, "content-list.json"), `${JSON.stringify(parsed.contentList, null, 2)}\n`, "utf8");
    await writeFile(join(artifactDir, "metadata.json"), `${JSON.stringify({
      originalName: input.originalName,
      mimeType: input.mimeType,
      parser: "mineru",
      parserVersion: parsed.parserVersion,
    }, null, 2)}\n`, "utf8");

    const chunksWithoutEmbeddings = chunkMineruDocument(parsed, id);
    if (chunksWithoutEmbeddings.length === 0) throw new Error("解析结果没有可检索文本");
    const embeddings = await this.dependencies.embed(chunksWithoutEmbeddings.map((chunk) => chunk.content));
    if (embeddings.length !== chunksWithoutEmbeddings.length) throw new Error("Embedding 返回数量与文档片段数量不一致");
    const chunks = chunksWithoutEmbeddings.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] }));

    const imageEntries = Object.entries(parsed.images);
    if (imageEntries.length > 0) await mkdir(join(artifactDir, "images"), { recursive: true });
    for (const [name, dataUrl] of imageEntries) {
      const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/u);
      if (match) await writeFile(join(artifactDir, "images", safeName(name)), Buffer.from(match[1], "base64"));
    }

    const document: KnowledgeDocument = {
      id,
      knowledgeBaseId: input.scope.knowledgeBaseId,
      ownerId: input.scope.ownerId,
      originalName: input.originalName,
      mimeType: input.mimeType || "application/octet-stream",
      sha256: createHash("sha256").update(input.file).digest("hex"),
      parser: "mineru",
      parserVersion: parsed.parserVersion,
      status: "ready",
      artifactDir,
      chunkCount: chunks.length,
      createdAt: new Date().toISOString(),
    };
    await this.dependencies.repository.saveDocument(document, chunks);
    return document;
  }

  listDocuments(scope: KnowledgeScope): Promise<KnowledgeDocument[]> {
    return this.dependencies.repository.listDocuments(scope);
  }

  async search(input: { scope: KnowledgeScope; query: string; topK?: number }) {
    const query = input.query.trim();
    if (!query) return [];
    const topK = Math.min(Math.max(input.topK ?? DEFAULT_TOP_K, 1), MAX_TOP_K);
    const [queryEmbedding] = await this.dependencies.embed([query]);
    return this.dependencies.repository.search(input.scope, query, queryEmbedding, topK);
  }
}
