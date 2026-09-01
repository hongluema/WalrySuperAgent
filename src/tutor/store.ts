import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export class TutorStore {
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
    if (![1, 2, 3, 4, 5].includes(value.schemaVersion) || value.conversationId !== conversationId) {
      throw new Error("学习状态版本或会话不匹配");
    }
    value.schemaVersion = 5;
    value.learningSessionId ||= this.legacyLearningSessionId(conversationId);
    value.sessionStatus ||= value.phase === "complete" ? "completed" : "active";
    value.learnerProfile ??= [];
    value.knownIntuitions ??= [];
    value.nodeLearningStates ??= {};
    value.sessionMode ??= "teach";
    return value;
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
