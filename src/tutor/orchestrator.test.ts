import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TutorOrchestrator } from "./orchestrator.js";
import { TutorStore } from "./store.js";
import type { TopicModel, TutorEvent, TutorState, TutorTurnDecision } from "./types.js";
import type { TutorModelClient } from "./model-client.js";
import { normalizeDiagnosis, normalizeTopicModel } from "./model-client.js";
import { ensureTopicModelDefaults } from "./topic-model.js";

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
      { id: "concept-1", title: "第一个概念", target: "介绍第一个概念的背景、定义和核心内容" },
      { id: "concept-2", title: "第二个概念", target: "介绍第二个概念并迁移到新场景" },
    ],
    boundaryCases: ["概念理解不等于能够迁移"],
    practiceTarget: "完成一个真实小任务",
    rubricAnchors: [{
      conceptId: "concept-1",
      accuracy: "能准确解释",
      explanation: "能说明原因",
      discrimination: "能区分相似概念",
      transfer: "能在新场景应用",
    }],
    evidenceSources: ["用户目标"],
    confidence: 0.9,
    subject: { kind: "任意开放标签", description: "任意主题", userGoal: "理解并应用" },
    grounding: { mode: "model-knowledge", sources: [], limitations: ["没有外部材料"] },
    capabilities: {
      acquisition: ["model-knowledge"],
      structuring: ["concept-dependency"],
      interaction: ["socratic-dialogue"],
      assessment: ["explanation", "transfer"],
      missing: [],
    },
  };
}

function fakeDecision(message: string): TutorTurnDecision {
  const dontKnow = message.includes("不知道");
  return {
    intent: dontKnow ? "dont_know" : "answer",
    understoodMeaning: dontKnow ? "用户暂时无法回答当前问题" : "用户正在回答当前问题",
    evidence: [{ quote: message, implication: dontKnow ? "没有可评估的答案证据" : "用户提供了回答" }],
    assessment: { status: dontKnow ? "not-answered" : "partial", score: dontKnow ? undefined : 60, rubricEvidence: [], evidence: [] },
    nextAction: dontKnow ? "give-example" : "ask-socratic-question",
    statePatch: {},
    responsePlan: {
      goal: dontKnow ? "降低难度并提供例子" : "继续验证理解",
      teachingAtom: "一个最小概念",
      gapToRepair: dontKnow ? "缺少回答证据" : "缺少迁移证据",
      keyPoints: ["用一个具体场景说明"],
      allowedContent: ["当前概念"],
      forbiddenContent: ["后续概念"],
      question: "你会如何判断？",
    },
  };
}

function fakeModelClient(): TutorModelClient {
  return {
    buildTopicModel: async () => fakeTopicModel(),
    compileDiagnosis: async ({ answeredDiagnostics }) => ({
      summary: "已根据结构化答案完成诊断",
      learnerProfile: answeredDiagnostics.map((item) => `${item.question}：${item.optionLabel}`),
      evidence: answeredDiagnostics.map((item) => ({ quote: `${item.question} -> ${item.optionLabel}`, implication: "用户已经完成该诊断题" })),
    }),
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
  assert.equal(normalized.subject.kind, "open-learning-subject");
  assert.deepEqual(normalized.capabilities.missing, []);
});

test("normalizes loose diagnosis shapes before TutorDiagnosis validation", () => {
  const normalized = normalizeDiagnosis({
    summary: "有一定基础",
    learnerProfile: ["做过类似项目"],
    evidence: [
      "题干A -> 选项B",
      { text: "题干C：选项D", meaning: "说明已有经验" },
      { quote: "完整引用", implication: "可进入下一节点" },
      {},
    ],
    skipSuggestions: [
      { id: "concept-1", why: "答对了核心题", confidence: "high" },
      { conceptId: "concept-2", reason: "有直觉", confidence: "medium" },
      { reason: "缺少 conceptId，应丢弃" },
    ],
  }) as Record<string, any>;

  assert.deepEqual(normalized.evidence, [
    { quote: "题干A", implication: "选项B" },
    { quote: "题干C：选项D", implication: "说明已有经验" },
    { quote: "完整引用", implication: "可进入下一节点" },
  ]);
  assert.deepEqual(normalized.skipSuggestions, [
    { conceptId: "concept-1", reason: "答对了核心题", confidence: "high" },
    { conceptId: "concept-2", reason: "有直觉", confidence: "medium" },
  ]);
});

test("upgrades legacy topic models without introducing a closed subject enum", () => {
  const legacy = fakeTopicModel();
  delete (legacy as Partial<TopicModel>).subject;
  delete (legacy as Partial<TopicModel>).grounding;
  delete (legacy as Partial<TopicModel>).capabilities;
  const upgraded = ensureTopicModelDefaults(legacy);
  assert.equal(upgraded.subject.kind, "open-learning-subject");
  assert.equal(upgraded.grounding.sources.length, 0);
  assert.deepEqual(upgraded.capabilities.structuring, ["concept-dependency"]);
});

test("runs the diagnostic journey and persists resumable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-tutor-test-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient(), async () => "没有找到相关结果");
    const events: TutorEvent[] = [];
    const emit = (event: TutorEvent): void => {
      events.push(event);
    };

    await tutor.run("test-session", "如何进行高效的 Vibe Coding？", emit);
    assert.deepEqual(
      events.filter((event) => event.type === "diagnostic.card.ready").map((event) => (event.card as { index: number }).index),
      [0],
    );
    assert.equal(events.some((event) => event.type === "research.completed"), false);
    assert.ok(events.some((event) => event.type === "message.delta"));
    const latestTrace = [...events].reverse().find((event) => event.type === "reasoning.trace.ready");
    assert.equal(latestTrace?.type, "reasoning.trace.ready");
    if (latestTrace?.type === "reasoning.trace.ready") {
      assert.equal(latestTrace.trace.phase, "diagnose");
      assert.equal(latestTrace.trace.selectedAction, "ask-socratic-question");
    }

    events.length = 0;
    await tutor.run("test-session", "完成诊断", emit, undefined, {
      diagnosticAnswers: { experience: "B", understanding: "B", transfer: "B" },
    });

    assert.ok(events.some((event) => event.type === "diagnosis.ready"));
    assert.ok(events.some((event) => event.type === "roadmap.ready"));
    assert.ok(events.some((event) => event.type === "reasoning.trace.ready"));
    assert.ok(events.some((event) => event.type === "state.saved"));
    const teachingTrace = events.find((event) => event.type === "reasoning.trace.ready");
    assert.equal(teachingTrace?.type, "reasoning.trace.ready");
    if (teachingTrace?.type === "reasoning.trace.ready") {
      assert.equal(teachingTrace.trace.selectedAction, "explain");
      assert.match(teachingTrace.trace.currentGoal, /第一个概念/);
    }

    const state = JSON.parse(await readFile(join(root, "sessions", "test-session.json"), "utf8")) as { schemaVersion: number; phase: string; currentCard: number; learnerProfile: string[] };
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.phase, "teach");
    assert.equal(state.currentCard, 2);
    assert.ok(state.learnerProfile.some((item) => item.includes("没做过")));
    assert.match(await readFile(join(root, "events", "test-session.jsonl"), "utf8"), /state\.saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses real search material before building a grounded topic model", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-grounding-test-"));
  try {
    const client = fakeModelClient();
    let receivedMaterials: string[] = [];
    client.buildTopicModel = async ({ materials }) => {
      receivedMaterials = materials ?? [];
      const model = fakeTopicModel();
      model.grounding = {
        mode: "model-knowledge",
        sources: [{ label: "用户只提供了主题名", verified: true }],
        limitations: [],
      };
      return model;
    };
    const searchQueries: string[] = [];
    const tutor = new TutorOrchestrator(
      new TutorStore(root),
      client,
      async (query) => {
        searchQueries.push(query);
        return "### 权威资料\nhttps://example.com/source\n真实搜索取得的背景与核心内容";
      },
    );
    const events: TutorEvent[] = [];

    await tutor.run("grounded-session", "我想学习一部具体作品", (event) => { events.push(event); });

    assert.deepEqual(searchQueries, ["我想学习一部具体作品 背景 核心内容 结构"]);
    assert.equal(receivedMaterials.length, 1);
    assert.match(receivedMaterials[0], /真实搜索取得/);
    assert.ok(events.some((event) => event.type === "research.completed"));
    assert.equal(events.some((event) => event.type === "grounding.degraded"), false);

    const state = JSON.parse(await readFile(join(root, "sessions", "grounded-session.json"), "utf8")) as TutorState;
    assert.equal(state.topicModel?.grounding.mode, "web-search");
    assert.deepEqual(state.topicModel?.grounding.sources, [{ label: "https://example.com/source", verified: true }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("degrades explicitly when required search returns no usable content", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-grounding-failure-test-"));
  try {
    const client = fakeModelClient();
    let receivedMaterials: string[] = [];
    client.buildTopicModel = async ({ materials }) => {
      receivedMaterials = materials ?? [];
      return fakeTopicModel();
    };
    const tutor = new TutorOrchestrator(
      new TutorStore(root),
      client,
      async () => "[web_search] 未配置 TAVILY_API_KEY，请在 .env 中设置",
    );
    const events: TutorEvent[] = [];

    await tutor.run("degraded-session", "我想学习一部具体作品", (event) => { events.push(event); });

    assert.deepEqual(receivedMaterials, []);
    assert.ok(events.some((event) => event.type === "grounding.degraded"));
    assert.equal(events.some((event) => event.type === "research.completed"), false);

    const state = JSON.parse(await readFile(join(root, "sessions", "degraded-session.json"), "utf8")) as TutorState;
    assert.equal(state.topicModel?.grounding.mode, "model-knowledge");
    assert.equal(state.topicModel?.grounding.sources.length, 0);
    assert.match(state.topicModel?.grounding.limitations[0] ?? "", /真实搜索未取得/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts story nodes with grounded content instead of asking for unknown facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-story-first-test-"));
  try {
    const client = fakeModelClient();
    const model = fakeTopicModel();
    model.conceptRoute[0] = {
      ...model.conceptRoute[0],
      title: "故事背景",
      target: "先介绍故事发生的背景、关键人物，以及这段故事如何引出主题",
    };
    client.buildTopicModel = async () => model;
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");

    await tutor.run("story-session", "我想学习一部作品", () => {});
    await tutor.run("story-session", "完成诊断", () => {}, undefined, {
      diagnosticAnswers: { experience: "B", understanding: "B", transfer: "B" },
    });

    const state = JSON.parse(await readFile(join(root, "sessions", "story-session.json"), "utf8")) as TutorState;
    assert.deepEqual(state.lastDecision?.responsePlan.keyPoints, [
      "先介绍故事发生的背景、关键人物，以及这段故事如何引出主题",
    ]);
    assert.match(state.lastDecision?.responsePlan.question ?? "", /根据刚才介绍的内容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("any topic uses the same dynamic diagnostic protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-writing-test-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient(), async () => "没有找到相关结果");
    const events: TutorEvent[] = [];
    const emit = (event: TutorEvent): void => { events.push(event); };

    await tutor.run("writing-session", "我想系统学习写作", emit);
    assert.equal(events.filter((event) => event.type === "diagnostic.card.ready").length, 1);
    const model = events.find((event) => event.type === "topic.model.ready");
    assert.equal(model?.type, "topic.model.ready");
    if (model?.type === "topic.model.ready") assert.equal(model.topic, "any-topic");

    events.length = 0;
    await tutor.run("writing-session", "完成诊断", emit, undefined, {
      diagnosticAnswers: { experience: "B", understanding: "B", transfer: "B" },
    });
    assert.ok(events.some((event) => event.type === "diagnosis.ready"));
    assert.ok(events.some((event) => event.type === "roadmap.ready"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mid-session message does not rebuild topic model", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-switch-test-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient(), async () => "没有找到相关结果");
    const events: TutorEvent[] = [];
    const emit = (event: TutorEvent): void => { events.push(event); };

    await tutor.run("switch-session", "我想学习 Vibe Coding", emit);
    events.length = 0;
    await tutor.run("switch-session", "我想学习写作", emit);

    // Should NOT rebuild topic model — stays in current diagnose flow
    const model = events.find((event) => event.type === "topic.model.ready");
    assert.equal(model, undefined);
    // Should advance diagnostic card instead
    assert.ok(events.some((event) => event.type === "diagnostic.card.ready"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not mark a node mastered without sufficient evidence in all core criteria", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-mastery-gate-test-"));
  try {
    let fullEvidence = false;
    const client = fakeModelClient();
    client.analyzeTurn = async ({ message }) => ({
      ...fakeDecision(message),
      assessment: {
        status: "mastered",
        score: 95,
        rubricEvidence: [],
        evidence: (fullEvidence
          ? ["accurate", "explained", "discrimination", "transfer"] as const
          : ["accurate"] as const
        ).map((criterion) => ({ learnerQuote: message, criterion, strength: "sufficient" as const })),
      },
      statePatch: { masteredConceptId: "concept-1" },
      nextAction: "advance-concept",
    });
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");
    const emit = (): void => {};

    await tutor.run("mastery-session", "我想学习一个全新的对象", emit);
    await tutor.run("mastery-session", "完成诊断", emit, undefined, {
      diagnosticAnswers: { experience: "B", understanding: "B", transfer: "B" },
    });
    await tutor.run("mastery-session", "我能准确复述", emit);
    let state = JSON.parse(await readFile(join(root, "sessions", "mastery-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "active");

    fullEvidence = true;
    await tutor.run("mastery-session", "我还能解释、辨析并迁移", emit);
    state = JSON.parse(await readFile(join(root, "sessions", "mastery-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "mastered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("degrades model failures without failing or losing the teaching turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-model-fallback-test-"));
  try {
    const client = fakeModelClient();
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");

    await tutor.run("fallback-session", "我想学习一个全新的对象", () => {});
    await tutor.run("fallback-session", "完成诊断", () => {}, undefined, {
      diagnosticAnswers: { experience: "B", understanding: "B", transfer: "B" },
    });

    client.analyzeTurn = async () => { throw new Error("结构化输出校验失败"); };
    client.streamResponse = async () => { throw new Error("模型暂时不可用"); };
    const events: TutorEvent[] = [];
    await tutor.run("fallback-session", "我认为关键在于现金流方向", (event) => { events.push(event); });

    assert.ok(events.some((event) => event.type === "model.degraded" && event.stage === "decision"));
    assert.ok(events.some((event) => event.type === "model.degraded" && event.stage === "response"));
    assert.ok(events.some((event) => event.type === "message.delta"));
    assert.ok(events.some((event) => event.type === "state.saved"));
    assert.ok(events.some((event) => event.type === "run.completed"));
    assert.equal(events.some((event) => event.type === "run.failed"), false);

    const state = JSON.parse(await readFile(join(root, "sessions", "fallback-session.json"), "utf8")) as TutorState;
    assert.equal(state.turnCount, 1);
    assert.match(String(state.messages.at(-1)?.content), /学习进度已保留/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic suggestions do not skip content nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-skip-test-"));
  try {
    const client = fakeModelClient();
    client.compileDiagnosis = async ({ answeredDiagnostics }) => ({
      summary: "学习者已掌握第一个概念",
      learnerProfile: answeredDiagnostics.map((item) => `${item.question}：${item.optionLabel}`),
      evidence: answeredDiagnostics.map((item) => ({ quote: `${item.question} -> ${item.optionLabel}`, implication: "用户已经完成该诊断题" })),
      skipSuggestions: [
        { conceptId: "concept-1", reason: "用户在诊断中明确答对了核心概念题", confidence: "high" as const },
        { conceptId: "concept-2", reason: "用户有一定直觉但未验证", confidence: "medium" as const },
      ],
    });
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");
    const events: TutorEvent[] = [];
    const emit = (event: TutorEvent): void => { events.push(event); };

    await tutor.run("skip-session", "我想学习一个有基础的主题", emit);
    events.length = 0;
    await tutor.run("skip-session", "完成诊断", emit, undefined, {
      diagnosticAnswers: { experience: "A", understanding: "A", transfer: "B" },
    });

    const state = JSON.parse(await readFile(join(root, "sessions", "skip-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "active");
    assert.equal(state.activeConcept, 0);
    const teachingTrace = events.find((event) => event.type === "reasoning.trace.ready");
    assert.equal(teachingTrace?.type, "reasoning.trace.ready");
    if (teachingTrace?.type === "reasoning.trace.ready") {
      assert.match(teachingTrace.trace.currentGoal, /第一个概念/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not skip a core node from diagnostic multiple-choice answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-core-node-test-"));
  try {
    const client = fakeModelClient();
    client.compileDiagnosis = async () => ({
      summary: "学习者答对了核心概念选择题",
      learnerProfile: [],
      evidence: [],
      skipSuggestions: [{ conceptId: "concept-1", reason: "选择题正确", confidence: "high" as const }],
    });
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");

    await tutor.run("core-node-session", "我想学习一个核心主题", () => {});
    await tutor.run("core-node-session", "完成诊断", () => {}, undefined, {
      diagnosticAnswers: { experience: "A", understanding: "A", transfer: "A" },
    });

    const state = JSON.parse(await readFile(join(root, "sessions", "core-node-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "active");
    assert.equal(state.activeConcept, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
