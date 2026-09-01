import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { TutorStore } from "./store.js";
import type { TutorState } from "./types.js";

function state(conversationId: string, learningSessionId: string): TutorState {
  return {
    schemaVersion: 5,
    conversationId,
    learningSessionId,
    sessionStatus: "active",
    phase: "diagnose",
    topic: "PostgreSQL 持久化验证",
    lessonTitle: "存储验证课",
    diagnosticCards: [],
    diagnosticAnswers: {},
    currentCard: 0,
    roadmap: [],
    activeConcept: 0,
    turnCount: 1,
    messages: [{ role: "user", content: "验证 PostgreSQL 学习历史" }],
    learnerProfile: [],
    knownIntuitions: [],
    nodeLearningStates: {},
    updatedAt: new Date().toISOString(),
  };
}

test("persists learning sessions and audit events to configured PostgreSQL", async (context) => {
  if (!process.env.POSTGRES_URL) {
    context.skip("POSTGRES_URL is not configured");
    return;
  }
  const conversationId = `postgres-store-test-${randomUUID()}`;
  const learningSessionId = "learn-postgres";
  const store = new TutorStore();
  const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
  try {
    await store.save(state(conversationId, learningSessionId), { type: "test.postgres.persisted" });
    assert.equal((await store.load(conversationId))?.learningSessionId, learningSessionId);
    assert.equal((await store.load(conversationId, learningSessionId))?.messages[0]?.content, "验证 PostgreSQL 学习历史");
    assert.deepEqual((await store.list(conversationId)).map((item) => item.learningSessionId), [learningSessionId]);

    const events = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tutor_learning_events WHERE conversation_id = $1",
      [conversationId],
    );
    assert.equal(events.rows[0]?.count, "1");
  } finally {
    await pool.query("DELETE FROM tutor_learning_events WHERE conversation_id = $1", [conversationId]);
    await pool.query("DELETE FROM tutor_learning_sessions WHERE conversation_id = $1", [conversationId]);
    await pool.query("DELETE FROM tutor_conversations WHERE conversation_id = $1", [conversationId]);
    await pool.end();
    await store.close();
  }
});
