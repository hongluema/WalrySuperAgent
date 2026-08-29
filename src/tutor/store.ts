import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TutorState } from "./types.js";

export class TutorStore {
  private readonly root: string;

  constructor(root = process.env.TUTOR_DATA_DIR ?? join(process.cwd(), ".tutor-data")) {
    this.root = root;
  }

  private statePath(conversationId: string) {
    return join(this.root, "sessions", `${encodeURIComponent(conversationId)}.json`);
  }

  private eventsPath(conversationId: string) {
    return join(this.root, "events", `${encodeURIComponent(conversationId)}.jsonl`);
  }

  async load(conversationId: string): Promise<TutorState | undefined> {
    try {
      const raw = await readFile(this.statePath(conversationId), "utf8");
      const state = JSON.parse(raw) as TutorState;
      if (![1, 2, 3, 4].includes(state.schemaVersion) || state.conversationId !== conversationId) {
        throw new Error("学习状态版本或会话不匹配");
      }
      state.learnerProfile ??= [];
      state.nodeLearningStates ??= {};
      state.sessionMode ??= "teach";
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: TutorState, event: unknown): Promise<void> {
    const statePath = this.statePath(state.conversationId);
    const eventsPath = this.eventsPath(state.conversationId);
    await mkdir(dirname(statePath), { recursive: true });
    await mkdir(dirname(eventsPath), { recursive: true });
    const tempPath = `${statePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, statePath);
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`, "utf8");
  }
}
