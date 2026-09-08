import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { NodeLearningState, QuestionPurpose, TeachingQuestion, TopicModel, TutorAnswerEvaluation, TutorEvent, TutorState } from "./types.js";
import type { TutorModelClient } from "./model-client.js";
import { AiTutorModelClient, normalizeEvaluation, webAnswerEvaluationSchema } from "./model-client.js";
import { attachPlannedWebQuestion, auditWebEvaluation, buildWebTeachingDecision, contentRecoveryQuestion, WEB_TEACHING_POLICY } from "./web-teaching.js";
import { buildResolvedActionDecision } from "./pedagogy.js";
import { TurnResolver } from "./routing/turn-resolver.js";
import { topicModelFromUnknownTopic } from "./topic-model.js";
import { TutorStore } from "./store.js";
import { TutorOrchestrator } from "./orchestrator.js";

function topic(): TopicModel {
  const model = topicModelFromUnknownTopic("比例");
  model.topic = "比例";
  model.coreOutcome = "比较不同整体中的部分比例";
  model.conceptRoute = ["部分与整体", "比例比较"].map((title, index) => ({
    id: `node-${index}`, title, target: "将部分和对应整体关联，比较占比",
    openingQuestion: "4 人占 8 人的一半，4 人占 16 人还是一半吗？", openingHint: "先看整体有没有变化", knowledgeTypes: ["conceptual"],
  }));
  model.rubricAnchors = model.conceptRoute.map((node) => ({ conceptId: node.id, accuracy: "对应分母", explanation: "解释整体影响", discrimination: "区分人数与比例", transfer: "比较不同新比例" }));
  return model;
}

function question(purpose: QuestionPurpose = "accurate"): TeachingQuestion {
  return { id: "question-before", nodeId: "node-0", purpose, text: "两组比例相同吗？", thinkingHint: "分别对应整体", support: "none", expectedSignals: ["正确对应整体"] };
}

function node(purpose?: QuestionPurpose): NodeLearningState {
  return { nodeId: "node-0", stage: "elicit", questionsAsked: ["两组比例相同吗？"], evidence: [], misconceptions: [], activeQuestion: question(purpose), questionHistory: [question(purpose)] };
}

function evaluation(message = "分母表示整体", purpose: "accurate" | "explained" | "discrimination" | "transfer" = "accurate"): TutorAnswerEvaluation {
  return {
    intent: "answer", understoodMeaning: message,
    obstacle: { kind: "none", description: "", learnerQuote: "" },
    observations: [{ quote: message, implication: "已关联整体" }],
    assessment: { status: "partial", rubricEvidence: [], evidence: [{ learnerQuote: message, criterion: purpose, strength: "sufficient", confidence: 0.95 }] },
    misconceptionUpdates: [], pedagogy: { hit: "你已把部分与整体对应", unpunched: "仍需新题验证", invented: "", sourceMove: "比较新比例" },
    questionCandidates: ["accurate", "explained", "discrimination", "transfer"].map((purpose, index) => ({
      purpose: purpose as QuestionPurpose, text: `${message}之后，${index + 2} 人占 12 人比 3 人占 18 人更多吗？`, thinkingHint: "把部分与整体分别对应", expectedSignals: ["比较相应比例而非人数"],
    })),
  };
}

test("v2 schema requires grounded obstacle and candidate evidence targets", () => {
  assert.equal(webAnswerEvaluationSchema.safeParse(normalizeEvaluation(evaluation())).success, true);
  const missing = evaluation();
  delete missing.obstacle;
  assert.equal(webAnswerEvaluationSchema.safeParse(missing).success, false);
});

test("assisted evidence keeps provenance but never supplies independent mastery", () => {
  const state = node();
  state.activeQuestion!.support = "hint";
  const audited = auditWebEvaluation("分母表示整体", state, evaluation());
  assert.equal(audited.assessment.evidence[0].strength, "weak");
  assert.equal(audited.assessment.evidence[0].questionId, "question-before");
  assert.equal(audited.assessment.evidence[0].support, "hint");
  const decision = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: state, message: "分母表示整体", evaluation: evaluation() });
  assert.equal(decision.webTeaching?.question?.purpose, "accurate");
  assert.equal(decision.webTeaching?.question?.support, "none");
  assert.equal(decision.webTeaching?.feedback.evidenceMode, "assisted");
  assert.equal(decision.webTeaching?.feedback.metCriteria.length, 0);
});

test("foreign quotes, invented misconception repairs and requests do not become evidence", () => {
  const output = evaluation("学生没有说过这句话");
  output.misconceptionUpdates = [{ description: "错误模型", status: "repaired", evidenceQuote: "虚构原话" }];
  assert.equal(auditWebEvaluation("我不确定", node(), output).assessment.evidence.length, 0);
  assert.equal(auditWebEvaluation("我不确定", node(), output).misconceptionUpdates.length, 0);
  output.intent = "disagreement";
  assert.equal(auditWebEvaluation("学生没有说过这句话", node(), output).assessment.evidence.length, 0);
});

test("missing transfer candidate gets an unused transfer task bound to the existing rubric", () => {
  const state = node("explained");
  state.evidence = ["accurate", "explained", "discrimination"].map((criterion) => ({ learnerQuote: criterion, criterion: criterion as "accurate", strength: "sufficient" }));
  const output = evaluation();
  output.questionCandidates = output.questionCandidates.filter((item) => item.purpose !== "transfer");
  const decision = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: state, message: "分母表示整体", evaluation: output });
  assert.equal(decision.webTeaching?.question?.purpose, "transfer");
  assert.match(decision.webTeaching!.question!.text, /还没讨论过的实际场景/);
  assert.deepEqual(decision.webTeaching!.question!.expectedSignals, ["比较不同新比例"]);
  assert.equal(decision.assessment.evidence.some((item) => item.criterion === "transfer"), false);
});

test("different obstacles change the actual teaching move and support", () => {
  const moves = [
    ["concept-boundary", "repair-misconception", "hint"],
    ["procedure-error", "give-example", "hint"],
    ["task-ambiguity", "ask-clarification", "none"],
    ["prerequisite-gap", "give-example", "worked-example"],
  ] as const;
  for (const [kind, action, support] of moves) {
    const output = evaluation();
    output.assessment.evidence = [];
    output.obstacle = { kind, description: "缺少对应整体的这一步", learnerQuote: "分母表示整体" };
    output.questionCandidates.push({ purpose: "clarify", text: "题目里的两组分别指哪两组？", thinkingHint: "只需指出题目对象", expectedSignals: ["明确题意对象"] });
    const state = node();
    state.stalledTurns = 1;
    const decision = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: state, message: "分母表示整体", evaluation: output });
    assert.equal(decision.nextAction, action);
    assert.equal(decision.webTeaching?.question?.support, support);
  }
});

test("continue preserves a grounded no-doubts confirmation only at the existing mastery gate", () => {
  const state = node("doubt-check");
  state.stage = "doubt-check";
  state.evidence = ["accurate", "explained", "discrimination", "transfer"].map((criterion) => ({ learnerQuote: criterion, criterion: criterion as "accurate", strength: "sufficient" }));
  const output = evaluation("继续吧");
  output.intent = "no_doubts";
  const decision = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: state, message: "继续吧", evaluation: output });
  assert.equal(decision.nextAction, "advance-concept");
  assert.equal(decision.statePatch.masteredConceptId, "node-0");
  const incomplete = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: { ...state, evidence: [] }, message: "继续吧", evaluation: output });
  assert.equal(incomplete.statePatch.masteredConceptId, undefined);
  assert.equal(incomplete.assessment.evidence.length, 0);
});

test("a hint request stays a minimal clue with either model or recovery questions", () => {
  for (const hasCandidate of [true, false]) {
    const output = evaluation("提示一下");
    if (!hasCandidate) output.questionCandidates = [];
    const decision = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: node("clarify"), message: "提示一下", evaluation: output });
    assert.equal(decision.webTeaching?.question?.support, "hint");
    assert.match(decision.responsePlan.goal, /只给一个最小线索/);
    assert.equal(decision.assessment.evidence.length, 0);
  }
});

function client(): TutorModelClient {
  let count = 0;
  return {
    buildTopicModel: async () => topic(),
    compileDiagnosis: async () => ({ summary: "从部分和整体开始", learnerProfile: [], evidence: [], teachingApproach: { startingPoint: "部分与整体", emphasis: ["对应整体"], exampleContext: "分组统计", pacing: "小步验证", rationale: [] } }),
    evaluateAnswer: async ({ message, state }) => {
      const purpose = state.nodeLearningStates["node-0"]?.activeQuestion?.purpose;
      const result = evaluation(message, ["accurate", "explained", "discrimination", "transfer"].includes(purpose ?? "") ? purpose as "accurate" : "accurate");
      result.questionCandidates.forEach((item) => { item.text = `第 ${++count} 个新任务：${item.text}`; });
      if (message === "没有疑问了") result.intent = "no_doubts";
      return result;
    },
    streamResponse: async ({ decision }, onDelta) => { await onDelta(decision.responsePlan.goal); return decision.responsePlan.goal; },
  };
}

function modelState(): TutorState {
  return {
    schemaVersion: 5, conversationId: "regression", learningSessionId: "lesson-regression", sessionStatus: "active",
    phase: "teach", teachingPolicy: WEB_TEACHING_POLICY, sessionMode: "teach", topicModel: topic(),
    diagnosticCards: [], diagnosticAnswers: {}, currentCard: 0, roadmap: topic().conceptRoute.map((item, i) => ({ ...item, status: i ? "locked" : "active" })),
    activeConcept: 0, turnCount: 0, messages: [], learnerProfile: [], knownIntuitions: [], nodeLearningStates: { "node-0": node() }, updatedAt: new Date().toISOString(),
  };
}

class MockLanguageModelV2 {
  specificationVersion = "v2";
  provider = "regression";
  modelId = "scripted-json";
  supportedUrls = {};
  doGenerateCalls: Array<{ prompt: unknown }> = [];
  constructor(private readonly script: { doGenerate: Array<ReturnType<typeof textResult>> }) {}
  async doGenerate(input: { prompt: unknown }) {
    this.doGenerateCalls.push(input);
    const output = this.script.doGenerate.shift();
    if (!output) throw new Error("Unexpected model call");
    return output;
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
}

test("classifier repairs with its full contract and normalizes null and NONE", async () => {
  const model = new MockLanguageModelV2({ doGenerate: [textResult("{}"), textResult(JSON.stringify({ target: "tutor", primaryIntent: "ASK_QUESTION", sessionCommand: "CONTINUE", requestedTopic: null, explicitAction: "NONE", confidence: 0.8, reason: "当前课内问题" }))] });
  const output = await new AiTutorModelClient(model).classifyTurn({ message: "贴现率是什么意思", hasActiveSession: true, phase: "teach", currentTopic: "标普500和美债收益率" });
  assert.equal(output.target, "tutor");
  assert.equal(output.explicitAction, undefined);
  assert.equal(output.requestedTopic, undefined);
  const repair = JSON.stringify(model.doGenerateCalls[1].prompt);
  assert.match(repair, /requiredContract/);
  assert.match(repair, /primaryIntent/);
  assert.match(repair, /贴现率是什么意思/);
});

test("legacy-shaped evaluation is adapted with rubric signals without fabricating mastery", async () => {
  const raw = evaluation();
  delete raw.obstacle;
  raw.questionCandidates.forEach((item) => { delete item.expectedSignals; });
  const model = new MockLanguageModelV2({ doGenerate: [textResult(JSON.stringify(raw)), textResult("不是 JSON")] });
  const output = await new AiTutorModelClient(model).evaluateAnswer({ message: "分母表示整体", state: modelState(), topicModel: topic() });
  assert.equal(model.doGenerateCalls.length, 1);
  assert.ok(output.obstacle);
  assert.deepEqual(output.questionCandidates[0].expectedSignals, ["对应分母"]);
  assert.deepEqual(output.assessment.evidence, raw.assessment.evidence);
});

test("nullable annotations are recoverable but missing routing fields still fail after one repair", async () => {
  const raw = { ...evaluation(), obstacle: null, assessment: { ...evaluation().assessment, score: null } };
  const nullableModel = new MockLanguageModelV2({ doGenerate: [textResult(JSON.stringify(raw))] });
  const output = await new AiTutorModelClient(nullableModel).evaluateAnswer({ message: "分母表示整体", state: modelState(), topicModel: topic() });
  assert.equal(output.assessment.score, undefined);
  assert.equal(output.obstacle?.kind, "none");
  const brokenModel = new MockLanguageModelV2({ doGenerate: [textResult("{}"), textResult("仍然不是 JSON")] });
  await assert.rejects(new AiTutorModelClient(brokenModel).classifyTurn({ message: "继续吧", hasActiveSession: true, phase: "teach" }), /模型结构化输出不完整/);
  assert.equal(brokenModel.doGenerateCalls.length, 2);
});

test("content recovery is bounded and never cycles through used tasks or grants mastery", async () => {
  const state = node();
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const recovered = contentRecoveryQuestion(topic(), 0, state, "accurate", "none");
    if (i === 4) { assert.equal(recovered, undefined); break; }
    assert.ok(recovered);
    assert.equal(seen.has(recovered.text), false);
    seen.add(recovered.text);
    state.questionsAsked.push(recovered.text);
  }
  const output = evaluation();
  output.intent = "clarification";
  output.questionCandidates = [];
  const decision = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: state, message: "继续吧", evaluation: output });
  assert.equal(decision.webTeaching?.question, undefined);
  assert.equal(decision.assessment.evidence.length, 0);
  assert.equal(decision.nextAction, "explain");
  assert.match(decision.responsePlan.goal, /不重复已问题目/);
  state.activeQuestion = undefined;
  const resolution = await new TurnResolver().resolve({ message: "给我一个例子", hasActiveSession: true, phase: "teach" });
  const help = buildResolvedActionDecision(topic(), 0, resolution)!;
  attachPlannedWebQuestion(topic(), 0, state, help);
  assert.equal(help.webTeaching?.question, undefined);
  assert.equal(help.responsePlan.question, undefined);
  assert.match(help.responsePlan.goal, /不重复已问题目/);
});

test("reported clarification sequence exits the menu despite failed evaluation and missing probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarify-recovery-"));
  const store = new TutorStore(root);
  const state = modelState();
  state.nodeLearningStates["node-0"].activeQuestion = { ...question("clarify"), text: "你希望我先澄清题意、解释一个词，还是示范一个步骤？" };
  state.nodeLearningStates["node-0"].stalledTurns = 4;
  const teacher = client();
  let turn = 0;
  teacher.evaluateAnswer = async ({ message }) => {
    if (turn++ === 0) throw new SyntaxError("模拟模型两次 JSON 校验失败");
    const value = evaluation(message);
    value.intent = "direct_answer_request";
    value.obstacle = { kind: "causal-model", description: "错误地把求助当误区", learnerQuote: message };
    value.questionCandidates = [];
    return value;
  };
  try {
    await store.save(state, state.conversationId);
    const tutor = new TutorOrchestrator(store, teacher, async () => "");
    for (const message of ["没什么需要澄清的，继续吧", "示范一个步骤吧", "示范一个步骤"]) {
      await tutor.run(state.conversationId, message, () => {});
      const saved = (await store.load(state.conversationId))!;
      const current = saved.nodeLearningStates["node-0"];
      assert.ok(current.activeQuestion, "需要一个可回答的内容任务");
      assert.notEqual(current.activeQuestion.purpose, "clarify");
      assert.doesNotMatch(current.activeQuestion.text, /你希望我先澄清/);
      assert.equal(current.evidence.length, 0);
      assert.equal(current.misconceptions.length, 0);
      assert.notEqual(current.lastObstacle?.kind, "causal-model");
    }
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("explicit demonstration exits clarification and helps the same content card without assessing the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "explicit-recovery-"));
  const store = new TutorStore(root);
  const state = modelState();
  state.nodeLearningStates["node-0"].activeQuestion = question("clarify");
  const teacher = client();
  teacher.classifyTurn = async () => ({ target: "tutor", primaryIntent: "REQUEST_EXAMPLE", sessionCommand: "CONTINUE", explicitAction: "DEMONSTRATE", confidence: 0.99 });
  teacher.evaluateAnswer = async () => { throw new Error("显式示范不应评估作答"); };
  try {
    await store.save(state, { type: "test.seed" });
    const tutor = new TutorOrchestrator(store, teacher, async () => "");
    let previousId: string | undefined;
    for (const message of ["示范一个步骤吧", "示范一个步骤"]) {
      await tutor.run(state.conversationId, message, () => {});
      const saved = (await store.load(state.conversationId))!;
      const current = saved.nodeLearningStates["node-0"];
      assert.ok(current.activeQuestion);
      assert.notEqual(current.activeQuestion.purpose, "clarify");
      assert.equal(current.activeQuestion.support, "worked-example");
      assert.equal(saved.lastDecision?.responsePlan.question, current.activeQuestion.text);
      assert.equal(current.evidence.length, 0);
      if (previousId) assert.equal(current.activeQuestion.id, previousId);
      previousId = current.activeQuestion.id;
    }
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("policy isolation, durable hints, stale answer rejection and a complete evidence gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-teaching-test-"));
  const store = new TutorStore(root);
  const tutor = new TutorOrchestrator(store, client(), async () => "");
  const events: TutorEvent[] = [];
  const emit = (event: TutorEvent) => { events.push(event); };
  try {
    await tutor.run("old", "我想学习比例", emit);
    await tutor.run("old", "A", emit, undefined, { teachingPolicy: WEB_TEACHING_POLICY });
    assert.equal((await store.load("old"))?.teachingPolicy, "legacy.v1");
    await tutor.run("web", "我想学习比例", emit, undefined, { teachingPolicy: WEB_TEACHING_POLICY });
    let state = (await store.load("web"))!;
    const answers = Object.fromEntries(state.diagnosticCards.map((card) => [card.id, card.options[0].id]));
    await tutor.run("web", "完成摸底", emit, undefined, { diagnosticAnswers: answers });
    state = (await store.load("web"))!;
    assert.equal(state.teachingPolicy, WEB_TEACHING_POLICY);
    assert.equal(state.nodeLearningStates["node-0"].activeQuestion?.purpose, "introduce");
    const reply = async (text: string, hintSeen = false) => {
      const question = state.nodeLearningStates["node-0"].activeQuestion!;
      await tutor.run("web", text, emit, undefined, { learningSupport: { questionId: question.id, hintSeen } });
      state = (await store.load("web"))!;
    };
    await reply("我将人数与总人数对应");
    assert.equal(state.nodeLearningStates["node-0"].activeQuestion?.support, "none");
    await reply("这里的整体需要对应", true);
    assert.equal(state.nodeLearningStates["node-0"].evidence.at(-1)?.support, "hint");
    assert.equal(state.nodeLearningStates["node-0"].evidence.at(-1)?.strength, "weak");
    assert.equal(state.nodeLearningStates["node-0"].questionHistory?.at(-2)?.support, "hint");
    const before = JSON.stringify(state);
    await assert.rejects(tutor.run("web", "过期题回答", emit, undefined, { learningSupport: { questionId: "stale", hintSeen: false } }), /题目已经更新/);
    assert.equal(JSON.stringify(await store.load("web")), before);
    for (const message of ["我独立判断对应整体", "我独立解释原因", "我独立区分人数比例", "我独立应用新案例"]) await reply(message);
    assert.equal(state.nodeLearningStates["node-0"].stage, "doubt-check");
    assert.notEqual(state.roadmap[0].status, "mastered");
    await reply("没有疑问了");
    assert.equal(state.roadmap[0].status, "mastered");
    assert.equal(state.activeConcept, 1);
    assert.equal(state.nodeLearningStates["node-1"].activeQuestion?.purpose, "introduce");
    assert.ok(events.some((event) => event.type === "assessment.updated" && event.feedback?.evidenceMode === "assisted"));
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("missing exposure metadata cannot yield independent evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-exposure-test-"));
  const store = new TutorStore(root);
  const tutor = new TutorOrchestrator(store, client(), async () => "");
  try {
    await tutor.run("web", "我想学习比例", () => {}, undefined, { teachingPolicy: WEB_TEACHING_POLICY });
    let state = (await store.load("web"))!;
    await tutor.run("web", "完成摸底", () => {}, undefined, { diagnosticAnswers: Object.fromEntries(state.diagnosticCards.map((card) => [card.id, "A"])) });
    await tutor.run("web", "分母对应整体", () => {});
    state = (await store.load("web"))!;
    assert.equal(state.nodeLearningStates["node-0"].activeQuestion?.support, "none");
    await tutor.run("web", "我独立完成了", () => {});
    state = (await store.load("web"))!;
    assert.equal(state.nodeLearningStates["node-0"].evidence.at(-1)?.strength, "weak");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
