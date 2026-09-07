import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { NodeLearningState, QuestionPurpose, TeachingQuestion, TopicModel, TutorAnswerEvaluation, TutorEvent, TutorState } from "./types.js";
import type { TutorModelClient } from "./model-client.js";
import { normalizeEvaluation, webAnswerEvaluationSchema } from "./model-client.js";
import { auditWebEvaluation, buildWebTeachingDecision, WEB_TEACHING_POLICY } from "./web-teaching.js";
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

test("missing target candidate is a non-assessing clarification, never relabelled transfer", () => {
  const state = node("explained");
  state.evidence = ["accurate", "explained", "discrimination"].map((criterion) => ({ learnerQuote: criterion, criterion: criterion as "accurate", strength: "sufficient" }));
  const output = evaluation();
  output.questionCandidates = output.questionCandidates.filter((item) => item.purpose !== "transfer");
  const decision = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: state, message: "分母表示整体", evaluation: output });
  assert.equal(decision.webTeaching?.question?.purpose, "clarify");
  assert.equal(decision.pedagogy?.questionPurpose, "clarify");
  assert.equal(auditWebEvaluation("分母表示整体", { ...state, activeQuestion: decision.webTeaching!.question }, output).assessment.evidence.length, 0);
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
    const state = node();
    state.stalledTurns = 1;
    const decision = buildWebTeachingDecision({ model: topic(), activeConcept: 0, nodeState: state, message: "分母表示整体", evaluation: output });
    assert.equal(decision.nextAction, action);
    assert.equal(decision.webTeaching?.question?.support, support);
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
