import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import type { LearningSessionSummary, TutorState } from "./types.js";

type ConversationIndex = {
  schemaVersion: 1;
  conversationId: string;
  selectedLearningSessionId: string;
  sessions: LearningSessionSummary[];
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function normalizeTutorState(value: TutorState, conversationId: string, legacyLearningSessionId: (conversationId: string) => string): TutorState {
  if (![1, 2, 3, 4, 5].includes(value.schemaVersion) || value.conversationId !== conversationId) {
    throw new Error("学习状态版本或会话不匹配");
  }
  value.schemaVersion = 5;
  value.learningSessionId ||= legacyLearningSessionId(conversationId);
  value.sessionStatus ||= value.phase === "complete" ? "completed" : "active";
  value.learnerProfile ??= [];
  value.knownIntuitions ??= [];
  value.nodeLearningStates ??= {};
  value.sessionMode ??= "teach";
  return value;
}

class FileTutorStore {
  private readonly root: string;

  constructor(root = process.env.TUTOR_DATA_DIR ?? join(process.cwd(), ".tutor-data")) {
    this.root = root;
  }

  private legacyStatePath(conversationId: string) {
    return join(this.root, "sessions", `${encodeURIComponent(conversationId)}.json`);
  }

  private indexPath(conversationId: string) {
    return join(this.root, "conversations", `${encodeURIComponent(conversationId)}.json`);
  }

  private learningStatePath(conversationId: string, learningSessionId: string) {
    return join(this.root, "learning-sessions", encodeURIComponent(conversationId), `${encodeURIComponent(learningSessionId)}.json`);
  }

  private eventsPath(conversationId: string, learningSessionId: string) {
    return join(this.root, "events", encodeURIComponent(conversationId), `${encodeURIComponent(learningSessionId)}.jsonl`);
  }

  private legacyEventsPath(conversationId: string) {
    return join(this.root, "events", `${encodeURIComponent(conversationId)}.jsonl`);
  }

  private legacyLearningSessionId(conversationId: string): string {
    const digest = createHash("sha256").update(conversationId).digest("hex").slice(0, 12);
    return `learn_legacy_${digest}`;
  }

  private normalizeState(value: TutorState, conversationId: string): TutorState {
    return normalizeTutorState(value, conversationId, (id) => this.legacyLearningSessionId(id));
  }

  private async readState(path: string, conversationId: string, expectedLearningSessionId?: string): Promise<TutorState | undefined> {
    try {
      const raw = await readFile(path, "utf8");
      const state = this.normalizeState(JSON.parse(raw) as TutorState, conversationId);
      if (expectedLearningSessionId && state.learningSessionId !== expectedLearningSessionId) {
        throw new Error("学习状态与 learningSessionId 不匹配");
      }
      return state;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async readIndex(conversationId: string): Promise<ConversationIndex | undefined> {
    try {
      const index = JSON.parse(await readFile(this.indexPath(conversationId), "utf8")) as ConversationIndex;
      if (index.schemaVersion !== 1 || index.conversationId !== conversationId) {
        throw new Error("学习会话索引版本或会话不匹配");
      }
      return index;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }

  async load(conversationId: string, learningSessionId?: string): Promise<TutorState | undefined> {
    if (learningSessionId) {
      const state = await this.readState(this.learningStatePath(conversationId, learningSessionId), conversationId, learningSessionId);
      if (state) return state;
      if (learningSessionId !== this.legacyLearningSessionId(conversationId)) return undefined;
      return this.readState(this.legacyStatePath(conversationId), conversationId, learningSessionId);
    }

    const index = await this.readIndex(conversationId);
    if (index?.selectedLearningSessionId) {
      const state = await this.readState(
        this.learningStatePath(conversationId, index.selectedLearningSessionId),
        conversationId,
        index.selectedLearningSessionId,
      );
      if (state) return state;
    }
    return this.readState(this.legacyStatePath(conversationId), conversationId);
  }

  async list(conversationId: string): Promise<LearningSessionSummary[]> {
    return (await this.readIndex(conversationId))?.sessions.map((item) => ({ ...item })) ?? [];
  }

  async save(state: TutorState, event: unknown): Promise<void> {
    const normalized = this.normalizeState(state, state.conversationId);
    const summary: LearningSessionSummary = {
      learningSessionId: normalized.learningSessionId,
      topic: normalized.topic,
      lessonTitle: normalized.lessonTitle,
      status: normalized.sessionStatus,
      updatedAt: normalized.updatedAt,
    };
    const previous = await this.readIndex(normalized.conversationId);
    const sessions = previous?.sessions.map((item) => ({ ...item })) ?? [];
    const existingIndex = sessions.findIndex((item) => item.learningSessionId === normalized.learningSessionId);
    if (existingIndex >= 0) sessions[existingIndex] = summary;
    else sessions.push(summary);
    const selectedLearningSessionId = normalized.sessionStatus === "active" || !previous?.selectedLearningSessionId
      ? normalized.learningSessionId
      : previous.selectedLearningSessionId;
    const index: ConversationIndex = {
      schemaVersion: 1,
      conversationId: normalized.conversationId,
      selectedLearningSessionId,
      sessions,
    };

    await this.writeJson(this.learningStatePath(normalized.conversationId, normalized.learningSessionId), normalized);
    await this.writeJson(this.indexPath(normalized.conversationId), index);
    if (selectedLearningSessionId === normalized.learningSessionId) {
      // 旧路径调用方仍可读取当前课程快照；v5 的权威状态在 learning-sessions/。
      await this.writeJson(this.legacyStatePath(normalized.conversationId), normalized);
    }
    const eventsPath = this.eventsPath(normalized.conversationId, normalized.learningSessionId);
    await mkdir(dirname(eventsPath), { recursive: true });
    const eventLine = `${JSON.stringify({ at: new Date().toISOString(), event })}\n`;
    await appendFile(eventsPath, eventLine, "utf8");
    if (selectedLearningSessionId === normalized.learningSessionId) {
      const legacyEventsPath = this.legacyEventsPath(normalized.conversationId);
      await mkdir(dirname(legacyEventsPath), { recursive: true });
      await appendFile(legacyEventsPath, eventLine, "utf8");
    }
  }
}

type TutorStoreBackend = Pick<FileTutorStore, "load" | "list" | "save"> & {
  close?: () => Promise<void>;
  select?: (conversationId: string, learningSessionId: string) => Promise<void>;
};

type StoredStateRow = { state_json: TutorState | string };

function parseStoredState(value: TutorState | string): TutorState {
  return typeof value === "string" ? JSON.parse(value) as TutorState : value;
}

class PostgresTutorStore implements TutorStoreBackend {
  private schemaReady?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  private legacyLearningSessionId(conversationId: string): string {
    const digest = createHash("sha256").update(conversationId).digest("hex").slice(0, 12);
    return `learn_legacy_${digest}`;
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS tutor_learning_sessions (
        conversation_id TEXT NOT NULL,
        learning_session_id TEXT NOT NULL,
        session_status TEXT NOT NULL CHECK (session_status IN ('active', 'paused', 'completed')),
        topic TEXT,
        lesson_title TEXT,
        state_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (conversation_id, learning_session_id)
      );
      CREATE TABLE IF NOT EXISTS tutor_conversations (
        conversation_id TEXT PRIMARY KEY,
        selected_learning_session_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tutor_learning_events (
        event_id BIGSERIAL PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        learning_session_id TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_json JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tutor_learning_sessions_conversation_updated_idx
        ON tutor_learning_sessions (conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS tutor_learning_events_session_idx
        ON tutor_learning_events (conversation_id, learning_session_id, event_id ASC);
    `).then(() => undefined);
    return this.schemaReady;
  }

  private normalize(value: TutorState, conversationId: string): TutorState {
    return normalizeTutorState(value, conversationId, (id) => this.legacyLearningSessionId(id));
  }

  private stateFromRow(row: StoredStateRow | undefined, conversationId: string, expectedLearningSessionId?: string): TutorState | undefined {
    if (!row) return undefined;
    const state = this.normalize(parseStoredState(row.state_json), conversationId);
    if (expectedLearningSessionId && state.learningSessionId !== expectedLearningSessionId) {
      throw new Error("学习状态与 learningSessionId 不匹配");
    }
    return state;
  }

  async load(conversationId: string, learningSessionId?: string): Promise<TutorState | undefined> {
    await this.ensureSchema();
    if (learningSessionId) {
      const result = await this.pool.query<StoredStateRow>(
        `SELECT state_json FROM tutor_learning_sessions
         WHERE conversation_id = $1 AND learning_session_id = $2`,
        [conversationId, learningSessionId],
      );
      return this.stateFromRow(result.rows[0], conversationId, learningSessionId);
    }
    const result = await this.pool.query<StoredStateRow>(
      `SELECT session.state_json
       FROM tutor_conversations conversation
       JOIN tutor_learning_sessions session
         ON session.conversation_id = conversation.conversation_id
        AND session.learning_session_id = conversation.selected_learning_session_id
       WHERE conversation.conversation_id = $1`,
      [conversationId],
    );
    return this.stateFromRow(result.rows[0], conversationId);
  }

  async list(conversationId: string): Promise<LearningSessionSummary[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      learning_session_id: string;
      topic: string | null;
      lesson_title: string | null;
      session_status: LearningSessionSummary["status"];
      updated_at: Date;
    }>(
      `SELECT learning_session_id, topic, lesson_title, session_status, updated_at
       FROM tutor_learning_sessions
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conversationId],
    );
    return result.rows.map((row) => ({
      learningSessionId: row.learning_session_id,
      topic: row.topic ?? undefined,
      lessonTitle: row.lesson_title ?? undefined,
      status: row.session_status,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async save(state: TutorState, event: unknown): Promise<void> {
    await this.ensureSchema();
    const normalized = this.normalize(state, state.conversationId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.upsertSession(client, normalized);
      await client.query(
        `INSERT INTO tutor_conversations (conversation_id, selected_learning_session_id, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (conversation_id) DO UPDATE
           SET selected_learning_session_id = CASE
             WHEN $3 = 'active' THEN EXCLUDED.selected_learning_session_id
             ELSE tutor_conversations.selected_learning_session_id
           END,
               updated_at = NOW()`,
        [normalized.conversationId, normalized.learningSessionId, normalized.sessionStatus],
      );
      await client.query(
        `INSERT INTO tutor_learning_events (conversation_id, learning_session_id, event_json)
         VALUES ($1, $2, $3::jsonb)`,
        [normalized.conversationId, normalized.learningSessionId, JSON.stringify(event)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async select(conversationId: string, learningSessionId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE tutor_conversations
       SET selected_learning_session_id = $2, updated_at = NOW()
       WHERE conversation_id = $1`,
      [conversationId, learningSessionId],
    );
  }

  private async upsertSession(client: PoolClient, state: TutorState): Promise<void> {
    await client.query(
      `INSERT INTO tutor_learning_sessions (
         conversation_id, learning_session_id, session_status, topic, lesson_title, state_json, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
       ON CONFLICT (conversation_id, learning_session_id) DO UPDATE
         SET session_status = EXCLUDED.session_status,
             topic = EXCLUDED.topic,
             lesson_title = EXCLUDED.lesson_title,
             state_json = EXCLUDED.state_json,
             updated_at = EXCLUDED.updated_at`,
      [
        state.conversationId,
        state.learningSessionId,
        state.sessionStatus,
        state.topic ?? null,
        state.lessonTitle ?? null,
        JSON.stringify(state),
        state.updatedAt,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Runtime uses PostgreSQL whenever POSTGRES_URL is configured. Passing an
 * explicit directory retains the file-backed store for deterministic tests and
 * one-time recovery of existing local snapshots.
 */
export class TutorStore {
  private readonly backend: TutorStoreBackend;
  private readonly legacyFallback?: FileTutorStore;
  private migratedConversations = new Set<string>();

  constructor(root?: string) {
    if (root) {
      this.backend = new FileTutorStore(root);
      return;
    }
    const postgresUrl = process.env.POSTGRES_URL;
    if (!postgresUrl) {
      this.backend = new FileTutorStore(process.env.TUTOR_DATA_DIR ?? join(process.cwd(), ".tutor-data"));
      return;
    }
    this.backend = new PostgresTutorStore(new Pool({ connectionString: postgresUrl }));
    this.legacyFallback = new FileTutorStore(process.env.TUTOR_DATA_DIR ?? join(process.cwd(), ".tutor-data"));
  }

  private async migrateLegacyConversation(conversationId: string): Promise<void> {
    if (!this.legacyFallback || this.migratedConversations.has(conversationId)) return;
    this.migratedConversations.add(conversationId);
    const summaries = await this.legacyFallback.list(conversationId);
    const selected = await this.legacyFallback.load(conversationId);
    if (summaries.length === 0) {
      if (selected) await this.backend.save(selected, { type: "storage.migrated", source: "file" });
      return;
    }
    for (const summary of summaries) {
      const state = await this.legacyFallback.load(conversationId, summary.learningSessionId);
      if (state) await this.backend.save(state, { type: "storage.migrated", source: "file" });
    }
    if (selected) await this.backend.select?.(conversationId, selected.learningSessionId);
  }

  async load(conversationId: string, learningSessionId?: string): Promise<TutorState | undefined> {
    let state = await this.backend.load(conversationId, learningSessionId);
    if (state || !this.legacyFallback) return state;
    await this.migrateLegacyConversation(conversationId);
    state = await this.backend.load(conversationId, learningSessionId);
    return state;
  }

  async list(conversationId: string): Promise<LearningSessionSummary[]> {
    let sessions = await this.backend.list(conversationId);
    if (sessions.length > 0 || !this.legacyFallback) return sessions;
    await this.migrateLegacyConversation(conversationId);
    sessions = await this.backend.list(conversationId);
    return sessions;
  }

  async save(state: TutorState, event: unknown): Promise<void> {
    await this.backend.save(state, event);
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }
}
