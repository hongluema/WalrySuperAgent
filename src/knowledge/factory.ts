import { join } from "node:path";
import { Pool } from "pg";
import { createDashScopeEmbedder, createMockEmbedder } from "../rag/embedder.js";
import { FileKnowledgeRepository, PostgresKnowledgeRepository } from "./repository.js";
import { HttpMineruClient } from "./mineru-client.js";
import { DefaultKnowledgeService } from "./service.js";
import type { KnowledgeService } from "./types.js";

export function createKnowledgeService(): KnowledgeService {
  const dataDir = process.env.KNOWLEDGE_DATA_DIR ?? join(process.cwd(), ".knowledge-data");
  const repository = process.env.POSTGRES_URL
    ? new PostgresKnowledgeRepository(new Pool({ connectionString: process.env.POSTGRES_URL }))
    : new FileKnowledgeRepository(join(dataDir, "index.json"));
  const embedKey = process.env.DASHSCOPE_API_KEY ?? "";
  const embed = embedKey ? createDashScopeEmbedder(embedKey) : createMockEmbedder();
  return new DefaultKnowledgeService({
    repository,
    mineru: new HttpMineruClient(),
    embed,
    dataDir,
  });
}

