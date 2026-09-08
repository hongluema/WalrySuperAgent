import type { EmbeddingFn } from "../rag/embedder.js";

export type KnowledgeScope = {
  knowledgeBaseId: string;
  ownerId: string;
};

export type KnowledgeDocumentStatus = "ready" | "failed";

export type KnowledgeDocument = KnowledgeScope & {
  id: string;
  originalName: string;
  mimeType: string;
  sha256: string;
  parser: "mineru";
  parserVersion?: string;
  status: KnowledgeDocumentStatus;
  artifactDir: string;
  chunkCount: number;
  createdAt: string;
};

export type KnowledgeChunk = {
  id: string;
  documentId: string;
  content: string;
  embedding: number[];
  pageStart?: number;
  pageEnd?: number;
  sectionPath: string[];
  blockType: string;
  ordinal: number;
  metadata: Record<string, unknown>;
};

export type KnowledgeHit = KnowledgeChunk & {
  document: Pick<KnowledgeDocument, "id" | "originalName" | "knowledgeBaseId" | "ownerId">;
  score: number;
  vectorScore: number;
  keywordScore: number;
};

export type MineruParsedDocument = {
  markdown: string;
  contentList: unknown;
  images: Record<string, string>;
  parserVersion?: string;
};

export type MineruClient = {
  parse(input: { file: Uint8Array; fileName: string; mimeType: string; signal?: AbortSignal }): Promise<MineruParsedDocument>;
};

export type KnowledgeRepository = {
  saveDocument(document: KnowledgeDocument, chunks: KnowledgeChunk[]): Promise<void>;
  listDocuments(scope: KnowledgeScope): Promise<KnowledgeDocument[]>;
  search(scope: KnowledgeScope, query: string, queryEmbedding: number[], topK: number): Promise<KnowledgeHit[]>;
};

export type KnowledgeService = {
  ingest(input: {
    scope: KnowledgeScope;
    originalName: string;
    mimeType: string;
    file: Uint8Array;
    signal?: AbortSignal;
  }): Promise<KnowledgeDocument>;
  listDocuments(scope: KnowledgeScope): Promise<KnowledgeDocument[]>;
  search(input: { scope: KnowledgeScope; query: string; topK?: number }): Promise<KnowledgeHit[]>;
};

export type KnowledgeDependencies = {
  repository: KnowledgeRepository;
  mineru: MineruClient;
  embed: EmbeddingFn;
  dataDir: string;
};
