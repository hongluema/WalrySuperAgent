import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TutorStore } from "./store.js";
import type { TutorState } from "./types.js";

function state(conversationId: string, learningSessionId: string, topic: string, sessionStatus: "active" | "paused" = "active"): TutorState {
  return {
    schemaVersion: 5,
    conversationId,
    learningSessionId,
    sessionStatus,
    phase: "diagnose",
    topic,
    diagnosticCards: [],
    diagnosticAnswers: {},
    currentCard: 0,
    roadmap: [],
    activeConcept: 0,
    turnCount: 0,
    messages: [],
    learnerProfile: [],
    knownIntuitions: [],
    nodeLearningStates: {},
    updatedAt: new Date().toISOString(),
  };
}

test("stores multiple learning sessions under one conversation without cross-contamination", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-multi-session-store-"));
  try {
    const store = new TutorStore(root);
    const first = state("conversation-1", "learn-first", "Vibe Coding", "paused");
    const second = state("conversation-1", "learn-second", "写作");

    await store.save(first, { type: "seed.first" });
    await store.save(second, { type: "seed.second" });

    assert.equal((await store.load("conversation-1"))?.learningSessionId, "learn-second");
    assert.equal((await store.load("conversation-1", "learn-first"))?.topic, "Vibe Coding");
    assert.equal((await store.load("conversation-1", "learn-second"))?.topic, "写作");
    assert.deepEqual(
      (await store.list("conversation-1")).map((item) => ({ id: item.learningSessionId, status: item.status })),
      [
        { id: "learn-first", status: "paused" },
        { id: "learn-second", status: "active" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads a legacy v4 conversation and migrates it on the next save", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-legacy-session-store-"));
  try {
    await mkdir(join(root, "sessions"), { recursive: true });
    const legacy = { ...state("legacy-conversation", "unused", "概率论") } as Partial<TutorState> & Pick<TutorState, "conversationId">;
    legacy.schemaVersion = 4;
    delete legacy.learningSessionId;
    delete legacy.sessionStatus;
    await writeFile(join(root, "sessions", "legacy-conversation.json"), `${JSON.stringify(legacy)}\n`, "utf8");

    const store = new TutorStore(root);
    const loaded = await store.load("legacy-conversation");
    assert.equal(loaded?.schemaVersion, 5);
    assert.match(loaded?.learningSessionId ?? "", /^learn_legacy_/);
    assert.equal(loaded?.sessionStatus, "active");

    await store.save(loaded!, { type: "migrated" });
    assert.equal((await store.list("legacy-conversation")).length, 1);
    assert.equal((await store.load("legacy-conversation", loaded!.learningSessionId))?.topic, "概率论");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
