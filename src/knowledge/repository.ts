import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Pool, type PoolClient } from "pg";
import { cosineSimilarity } from "../rag/embedder.js";
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeHit, KnowledgeRepository, KnowledgeScope } from "./types.js";

type FileSnapshot = {
  documents: KnowledgeDocument[];
  chunks: KnowledgeChunk[];
};

function keywordScore(query: string, content: string): number {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return 0;
  const text = content.toLowerCase();
  return terms.filter((term) => text.includes(term)).length / terms.length;
}

function inScope(document: KnowledgeDocument, scope: KnowledgeScope): boolean {
  return document.knowledgeBaseId === scope.knowledgeBaseId && document.ownerId === scope.ownerId;
}

export class FileKnowledgeRepository implements KnowledgeRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<FileSnapshot> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as FileSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { documents: [], chunks: [] };
      throw error;
    }
  }

  private async save(snapshot: FileSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }

  async saveDocument(document: KnowledgeDocument, chunks: KnowledgeChunk[]): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const snapshot = await this.load();
      snapshot.documents = snapshot.documents.filter((item) => item.id !== document.id);
      snapshot.chunks = snapshot.chunks.filter((item) => item.documentId !== document.id);
      snapshot.documents.push(document);
      snapshot.chunks.push(...chunks);
      await this.save(snapshot);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async listDocuments(scope: KnowledgeScope): Promise<KnowledgeDocument[]> {
    const snapshot = await this.load();
    return snapshot.documents.filter((document) => inScope(document, scope));
  }

  async search(scope: KnowledgeScope, query: string, queryEmbedding: number[], topK: number): Promise<KnowledgeHit[]> {
    const snapshot = await this.load();
    const documents = new Map(snapshot.documents.filter((item) => inScope(item, scope)).map((item) => [item.id, item]));
    return snapshot.chunks
      .filter((chunk) => documents.has(chunk.documentId))
      .map((chunk) => {
        const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
        const keyword = keywordScore(query, chunk.content);
        return {
          ...chunk,
          document: documents.get(chunk.documentId)!,
          score: vectorScore * 0.8 + keyword * 0.2,
          vectorScore,
          keywordScore: keyword,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  private schemaReady?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        parser TEXT NOT NULL,
        parser_version TEXT,
        status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
        artifact_dir TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_documents_scope_idx
        ON knowledge_documents (knowledge_base_id, owner_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        embedding vector(128) NOT NULL,
        page_start INTEGER,
        page_end INTEGER,
        section_path JSONB NOT NULL,
        block_type TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        metadata JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx
        ON knowledge_chunks (document_id, ordinal);
    `).then(() => undefined);
    return this.schemaReady;
  }

  async saveDocument(document: KnowledgeDocument, chunks: KnowledgeChunk[]): Promise<void> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM knowledge_documents WHERE id = $1", [document.id]);
      await client.query(
        `INSERT INTO knowledge_documents
          (id, knowledge_base_id, owner_id, original_name, mime_type, sha256, parser, parser_version, status, artifact_dir, chunk_count, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [document.id, document.knowledgeBaseId, document.ownerId, document.originalName, document.mimeType, document.sha256, document.parser, document.parserVersion ?? null, document.status, document.artifactDir, document.chunkCount, document.createdAt],
      );
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO knowledge_chunks
            (id, document_id, content, embedding, page_start, page_end, section_path, block_type, ordinal, metadata)
           VALUES ($1,$2,$3,$4::vector,$5,$6,$7::jsonb,$8,$9,$10::jsonb)`,
          [chunk.id, chunk.documentId, chunk.content, vectorLiteral(chunk.embedding), chunk.pageStart ?? null, chunk.pageEnd ?? null, JSON.stringify(chunk.sectionPath), chunk.blockType, chunk.ordinal, JSON.stringify(chunk.metadata)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listDocuments(scope: KnowledgeScope): Promise<KnowledgeDocument[]> {
    await this.ensureSchema();
    const result = await this.pool.query<KnowledgeDocument>(
      `SELECT id, knowledge_base_id AS "knowledgeBaseId", owner_id AS "ownerId", original_name AS "originalName",
              mime_type AS "mimeType", sha256, parser, parser_version AS "parserVersion", status,
              artifact_dir AS "artifactDir", chunk_count AS "chunkCount", created_at AS "createdAt"
       FROM knowledge_documents WHERE knowledge_base_id = $1 AND owner_id = $2 ORDER BY created_at DESC`,
      [scope.knowledgeBaseId, scope.ownerId],
    );
    return result.rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
  }

  async search(scope: KnowledgeScope, query: string, queryEmbedding: number[], topK: number): Promise<KnowledgeHit[]> {
    await this.ensureSchema();
    const result = await this.pool.query<KnowledgeHit & { createdAt: Date }>(
      `SELECT c.id, c.document_id AS "documentId", c.content, c.embedding::text AS embedding,
              c.page_start AS "pageStart", c.page_end AS "pageEnd", c.section_path AS "sectionPath",
              c.block_type AS "blockType", c.ordinal, c.metadata,
              d.id AS "documentIdAlias", d.original_name AS "documentOriginalName",
              d.knowledge_base_id AS "documentKnowledgeBaseId", d.owner_id AS "documentOwnerId",
              1 - (c.embedding <=> $1::vector) AS "vectorScore",
              CASE WHEN c.content ILIKE '%' || $2 || '%' THEN 1 ELSE 0 END AS "keywordScore"
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
       WHERE d.knowledge_base_id = $3 AND d.owner_id = $4 AND d.status = 'ready'
       ORDER BY (0.8 * (1 - (c.embedding <=> $1::vector)) +
                 0.2 * CASE WHEN c.content ILIKE '%' || $2 || '%' THEN 1 ELSE 0 END) DESC
       LIMIT $5`,
      [vectorLiteral(queryEmbedding), query, scope.knowledgeBaseId, scope.ownerId, topK],
    );
    return result.rows.map((row: any) => {
      const embedding = typeof row.embedding === "string"
        ? row.embedding.replace(/[\[\]]/gu, "").split(",").filter(Boolean).map(Number)
        : row.embedding;
      return {
        ...row,
        embedding,
        score: Number(row.vectorScore) * 0.8 + Number(row.keywordScore) * 0.2,
        vectorScore: Number(row.vectorScore),
        keywordScore: Number(row.keywordScore),
        document: {
          id: row.documentIdAlias ?? row.documentId,
          originalName: row.documentOriginalName,
          knowledgeBaseId: row.documentKnowledgeBaseId,
          ownerId: row.documentOwnerId,
        },
      };
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPostgresKnowledgeRepository(connectionString: string): PostgresKnowledgeRepository {
  return new PostgresKnowledgeRepository(new Pool({ connectionString }));
}
