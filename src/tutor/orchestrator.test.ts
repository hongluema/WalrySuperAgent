import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TutorOrchestrator } from "./orchestrator.js";
import { TutorStore } from "./store.js";
import type { TopicModel, TutorEvent, TutorState, TutorTurnDecision } from "./types.js";
import type { TutorModelClient } from "./model-client.js";
import { normalizeTopicModel } from "./model-client.js";

function fakeTopicModel(): TopicModel {
  return {
    id: "fake-topic",
    topic: "any-topic",
    lessonTitle: "任意主题的学习",
    coreOutcome: "能够理解核心概念并在新场景中独立应用。",
    diagnosticDimensions: [
      { id: "experience", tab: "已有经验", question: "你做过什么？", options: [{ id: "A", label: "做过" }, { id: "B", label: "没做过" }] },
      { id: "understanding", tab: "概念理解", question: "你如何解释？", options: [{ id: "A", label: "能解释" }, { id: "B", label: "不确定" }] },
      { id: "transfer", tab: "迁移验证", question: "如何验证？", options: [{ id: "A", label: "用新场景验证" }, { id: "B", label: "不知道" }] },
    ],
    conceptRoute: [
      { id: "concept-1", title: "第一个概念", target: "理解第一个概念" },
      { id: "concept-2", title: "第二个概念", target: "迁移到新场景" },
    ],
    boundaryCases: ["概念理解不等于能够迁移"],
    practiceTarget: "完成一个真实小任务",
    rubricAnchors: [{ conceptId: "concept-1", accuracy: "能准确解释", transfer: "能在新场景应用" }],
    evidenceSources: ["用户目标"],
    confidence: 0.9,
  };
}

function fakeDecision(message: string): TutorTurnDecision {
  const dontKnow = message.includes("不知道");
  return {
    intent: dontKnow ? "dont_know" : "answer",
    understoodMeaning: dontKnow ? "用户暂时无法回答当前问题" : "用户正在回答当前问题",
    evidence: [{ quote: message, implication: dontKnow ? "没有可评估的答案证据" : "用户提供了回答" }],
    assessment: { status: dontKnow ? "not-answered" : "partial", score: dontKnow ? undefined : 60, rubricEvidence: [] },
    nextAction: dontKnow ? "give-example" : "ask-socratic-question",
    statePatch: {},
    responsePlan: { goal: dontKnow ? "降低难度并提供例子" : "继续验证理解", keyPoints: ["用一个具体场景说明"] },
  };
}

function fakeModelClient(): TutorModelClient {
  return {
    buildTopicModel: async () => fakeTopicModel(),
    analyzeTurn: async ({ message }: { message: string; state: TutorState; topicModel: TopicModel }) => fakeDecision(message),
    streamResponse: async ({ decision }: { message: string; state: TutorState; topicModel: TopicModel; decision: TutorTurnDecision }, onDelta: (text: string) => void | Promise<void>) => {
      await onDelta(decision.responsePlan.goal);
      return decision.responsePlan.goal;
    },
  };
}

test("routes systematic learning requests for any topic into the same tutor", () => {
  const tutor = new TutorOrchestrator();
  assert.equal(tutor.isTutorIntent("我想学英语"), true);
  assert.equal(tutor.isTutorIntent("我想学习写作"), true);
  assert.equal(tutor.isTutorIntent("今天天气怎么样"), false);
  assert.equal(tutor.isTutorIntent("我想学习 Vibe Coding"), true);
});

test("normalizes common model aliases before TopicModel validation", () => {
  const normalized = normalizeTopicModel({
    title: "AI 漫剧制作",
    expectedOutcome: "完成一个小作品",
    diagnostics: [{ name: "已有经验", prompt: "你做过什么？", choices: [{ text: "做过" }, { text: "没做过" }] }],
    learningPath: [{ name: "剧本拆解", description: "把故事拆成可执行分镜" }],
    boundaries: [{ title: "看起来完成", description: "不等于真实有效" }],
    rubrics: [{ concept: "concept-1", criteria: "能解释机制", application: "能迁移应用" }],
  }) as Record<string, any>;
  assert.equal(normalized.lessonTitle, "AI 漫剧制作");
  assert.equal(normalized.diagnosticDimensions[0].tab, "已有经验");
  assert.equal(normalized.diagnosticDimensions[0].options[0].id, "A");
  assert.equal(normalized.conceptRoute[0].target, "把故事拆成可执行分镜");
  assert.equal(normalized.boundaryCases[0], "看起来完成：不等于真实有效");
  assert.equal(normalized.rubricAnchors[0].transfer, "能迁移应用");
});

test("runs the diagnostic journey and persists resumable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-tutor-test-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient());
    const events: TutorEvent[] = [];
    const emit = (event: TutorEvent): void => {
      events.push(event);
    };

    await tutor.run("test-session", "如何进行高效的 Vibe Coding？", emit);
    assert.deepEqual(
      events.filter((event) => event.type === "diagnostic.card.ready").map((event) => (event.card as { index: number }).index),
      [0],
    );
    assert.ok(events.some((event) => event.type === "research.completed"));
    assert.ok(events.some((event) => event.type === "message.delta"));
    const latestTrace = [...events].reverse().find((event) => event.type === "reasoning.trace.ready");
    assert.equal(latestTrace?.type, "reasoning.trace.ready");
    if (latestTrace?.type === "reasoning.trace.ready") {
      assert.equal(latestTrace.trace.phase, "diagnose");
      assert.equal(latestTrace.trace.selectedAction, "ask-socratic-question");
    }

    events.length = 0;
    await tutor.run("test-session", "完成诊断", emit, undefined, {
      diagnosticAnswers: { workflow: "B", validation: "B", trust: "B" },
    });

    assert.ok(events.some((event) => event.type === "diagnosis.ready"));
    assert.ok(events.some((event) => event.type === "roadmap.ready"));
    assert.ok(events.some((event) => event.type === "reasoning.trace.ready"));
    assert.ok(events.some((event) => event.type === "state.saved"));

    const state = JSON.parse(await readFile(join(root, "sessions", "test-session.json"), "utf8")) as { schemaVersion: number; phase: string; currentCard: number };
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.phase, "teach");
    assert.equal(state.currentCard, 2);
    assert.match(await readFile(join(root, "events", "test-session.jsonl"), "utf8"), /state\.saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("any topic uses the same dynamic diagnostic protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-writing-test-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient());
    const events: TutorEvent[] = [];
    const emit = (event: TutorEvent): void => { events.push(event); };

    await tutor.run("writing-session", "我想系统学习写作", emit);
    assert.equal(events.filter((event) => event.type === "diagnostic.card.ready").length, 1);
    const model = events.find((event) => event.type === "topic.model.ready");
    assert.equal(model?.type, "topic.model.ready");
    if (model?.type === "topic.model.ready") assert.equal(model.topic, "any-topic");

    events.length = 0;
    await tutor.run("writing-session", "完成诊断", emit, undefined, {
      diagnosticAnswers: { purpose: "B", structure: "B", revision: "B" },
    });
    assert.ok(events.some((event) => event.type === "diagnosis.ready"));
    assert.ok(events.some((event) => event.type === "roadmap.ready"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("switching topics rebuilds a dynamic topic model", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-switch-test-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient());
    const events: TutorEvent[] = [];
    const emit = (event: TutorEvent): void => { events.push(event); };

    await tutor.run("switch-session", "我想学习 Vibe Coding", emit);
    events.length = 0;
    await tutor.run("switch-session", "我想学习写作", emit);

    const model = events.find((event) => event.type === "topic.model.ready");
    assert.equal(model?.type, "topic.model.ready");
    if (model?.type === "topic.model.ready") assert.equal(model.topic, "any-topic");
    assert.deepEqual(
      events.filter((event) => event.type === "diagnostic.card.ready").map((event) => event.card.index),
      [0],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
