import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TutorOrchestrator } from "./orchestrator.js";
import { TutorStore } from "./store.js";
import type { TopicModel, TutorAnswerEvaluation, TutorEvent, TutorState, TutorTurnDecision } from "./types.js";
import type { TutorModelClient } from "./model-client.js";
import { loadAgentMd } from "../agent-md.js";
import { normalizeDiagnosis, normalizeEvaluation, normalizeTopicModel, normalizeDesignedDiagnostics } from "./model-client.js";
import { ensureTopicModelDefaults, isGenericRouteTitle } from "./topic-model.js";
import { buildEvidenceDrivenDecision, buildFirstTeachingDecision, constrainEvaluationEvidence, DIAGNOSE_INTRO_TEXT, hasAskedQuestion, nodeProgress, stripChoiceOptionLines, withThinkingHint } from "./pedagogy.js";

function protocolAnswers(overrides: Record<string, string> = {}) {
  return { baseline: "B", motivation: "B", focus: "B", misconception: "C", ...overrides };
}

function fakeTopicModel(): TopicModel {
  return {
    id: "fake-topic",
    topic: "any-topic",
    lessonTitle: "任意主题的学习",
    coreOutcome: "能够理解核心概念并在新场景中独立应用。",
    backgroundBrief: "这是一个用于验证通用私教流程的开放学习主题。学习者需要先知道它所处理的问题、基本概念之间的关系和常见使用场景，再通过解释、辨析与迁移建立真实理解。课程不会停留在定义记忆，而会沿着第一个概念和第二个概念逐层推进，同时区分看似理解与能够应用的差别。学完后，学习者应该能说明主题的基本定位、解释关键原因，并在一个未见过的新场景中作出有依据的判断。",
    diagnosticDimensions: [],
    conceptRoute: [
      {
        id: "concept-1",
        title: "第一个概念",
        target: "介绍第一个概念的背景、定义和核心内容",
        openingQuestion: "在你熟悉的场景里，第一个概念会影响哪个判断？",
        openingHint: "先找场景中的目标，再看哪个条件会改变结果",
      },
      {
        id: "concept-2",
        title: "第二个概念",
        target: "介绍第二个概念并迁移到新场景",
        openingQuestion: "换到一个新场景，你会怎样识别第二个概念？",
        openingHint: "先比较新旧场景中不变的条件",
      },
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

function fakeEvaluation(message: string): TutorAnswerEvaluation {
  const dontKnow = message.includes("不知道");
  const noDoubts = /没有疑问|没有了|都清楚/u.test(message);
  return {
    intent: dontKnow ? "dont_know" : noDoubts ? "no_doubts" : "answer",
    understoodMeaning: dontKnow ? "用户暂时无法回答当前问题" : noDoubts ? "用户明确表示没有遗留疑问" : "用户正在回答当前问题",
    observations: [{ quote: message, implication: dontKnow ? "没有可评估的答案证据" : "用户提供了回答" }],
    assessment: {
      status: dontKnow ? "not-answered" : "partial",
      score: dontKnow ? undefined : 60,
      rubricEvidence: [],
      evidence: [],
    },
    misconceptionUpdates: [],
    pedagogy: {
      hit: dontKnow ? "" : message,
      unpunched: dontKnow ? "缺少回答证据" : "缺少迁移证据",
      invented: "",
      sourceMove: "用一个具体场景说明",
    },
    questionCandidates: [
      { purpose: "accurate", text: "这个判断成立还是不成立？", thinkingHint: "先对照概念成立所需的条件" },
      { purpose: "explained", text: "它会让结果变好还是变坏，哪一步造成的？", thinkingHint: "沿着原因到结果的链条逐步检查" },
      { purpose: "discrimination", text: "这更接近情况 A 还是情况 B？", thinkingHint: "比较两种情况的关键条件" },
      { purpose: "transfer", text: "换到一个新场景，你会如何判断？", thinkingHint: "先找新旧场景中不变的原则" },
    ],
  };
}

function fakeTeachingApproach() {
  return {
    startingPoint: "先建立整体框架",
    emphasis: ["优先解释实际应用"],
    exampleContext: "使用学习者熟悉的工作场景",
    pacing: "已有经验快速确认，陌生部分逐层练习",
    rationale: ["依据既往经验决定起点", "依据学习动机选择案例", "依据内容侧重安排比重"],
  };
}

function fakeModelClient(): TutorModelClient {
  return {
    buildTopicModel: async () => fakeTopicModel(),
    compileDiagnosis: async ({ answeredDiagnostics }) => ({
      summary: "已根据结构化答案完成诊断",
      learnerProfile: answeredDiagnostics.map((item) => `${item.question}：${item.optionLabel}`),
      evidence: answeredDiagnostics.map((item) => ({ quote: `${item.question} -> ${item.optionLabel}`, implication: "用户已经完成该诊断题" })),
      teachingApproach: fakeTeachingApproach(),
    }),
    evaluateAnswer: async ({ message }: { message: string; state: TutorState; topicModel: TopicModel }) => fakeEvaluation(message),
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
  assert.equal(tutor.isTutorIntent("https://mp.weixin.qq.com/s/abcd1234"), true);
  assert.equal(tutor.isTutorIntent("给我讲下这篇文章\n\n微信公众号文章：https://mp.weixin.qq.com/s/abcd1234"), true);
});

test("agent.md is loaded as simplified-Chinese operating rules", () => {
  assert.match(loadAgentMd(), /简体中文/);
  assert.match(loadAgentMd(), /评估器只抽学生原话证据/);
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
  assert.match(normalized.backgroundBrief, /AI 漫剧制作/);
  assert.deepEqual(normalized.diagnosticDimensions, []);
  assert.equal(normalized.conceptRoute[0].target, "把故事拆成可执行分镜");
  assert.match(normalized.conceptRoute[0].openingQuestion, /剧本拆解/);
  assert.match(normalized.conceptRoute[0].openingHint, /可执行分镜/);
  assert.equal(normalized.boundaryCases[0], "看起来完成：不等于真实有效");
  assert.equal(normalized.rubricAnchors[0].transfer, "能迁移应用");
  assert.equal(normalized.subject.kind, "open-learning-subject");
  assert.deepEqual(normalized.capabilities.missing, []);
});

test("diagnostic protocol is determined by route and boundary, not by invented questions", () => {
  const invented = fakeTopicModel();
  invented.diagnosticDimensions = [{
    id: "opt-misc-1",
    kind: "misconception",
    tab: "粉红塔火车",
    rationale: "现场出卷",
    teachingUse: "每次都不一样",
    question: "孩子把粉红塔当火车怎么处理？",
    thinkingHint: "猜一个老师想听的答案",
    options: [
      { id: "opt-misc-1", label: "立刻制止并没收" },
      { id: "opt-misc-2", label: "不干预并夸奖创意" },
    ],
  }];
  const empty = fakeTopicModel();
  empty.diagnosticDimensions = [];
  const a = ensureTopicModelDefaults(invented);
  const b = ensureTopicModelDefaults(empty);

  assert.deepEqual(a.diagnosticDimensions.map((item) => item.kind), ["baseline", "motivation", "focus", "misconception"]);
  assert.deepEqual(a.diagnosticDimensions, b.diagnosticDimensions);
  assert.deepEqual(a.diagnosticDimensions.find((item) => item.kind === "focus")?.options.map((item) => item.label), ["第一个概念", "第二个概念"]);
  assert.match(a.diagnosticDimensions.find((item) => item.kind === "misconception")?.question ?? "", /概念理解不等于能够迁移/);
  assert.deepEqual(
    a.diagnosticDimensions[0].options.map((item) => item.id),
    ["A", "B", "C", "D"],
  );
});

test("diagnostic protocol drops unused slots instead of padding to four", () => {
  const noBoundary = fakeTopicModel();
  noBoundary.boundaryCases = [];
  assert.deepEqual(
    ensureTopicModelDefaults(noBoundary).diagnosticDimensions.map((item) => item.kind),
    ["baseline", "motivation", "focus"],
  );

  const oneNode = fakeTopicModel();
  oneNode.conceptRoute = [oneNode.conceptRoute[0]];
  oneNode.boundaryCases = [];
  assert.deepEqual(
    ensureTopicModelDefaults(oneNode).diagnosticDimensions.map((item) => item.kind),
    ["baseline", "motivation"],
  );

  const threeNodes = fakeTopicModel();
  threeNodes.conceptRoute = [
    ...threeNodes.conceptRoute,
    {
      id: "concept-3",
      title: "第三个概念",
      target: "介绍第三个概念",
      openingQuestion: "第三个概念会改变哪个判断？",
      openingHint: "先找会改变结果的条件",
    },
  ];
  assert.deepEqual(
    ensureTopicModelDefaults(threeNodes).diagnosticDimensions.find((item) => item.kind === "focus")?.options.map((item) => item.label),
    ["第一个概念", "第二个概念", "第三个概念"],
  );
});

test("teacher-designed diagnostics are kept instead of the enrollment form", () => {
  const model = fakeTopicModel();
  model.diagnosticDimensions = [
    {
      id: "flutter-base",
      kind: "baseline",
      tab: "Dart/Flutter 基础",
      rationale: "起点决定从零讲还是过考点",
      teachingUse: "零基础从语法讲起，写过 demo 就加快",
      question: "你之前接触过 Dart 语言或 Flutter 吗？",
      thinkingHint: "按你现在真实写过的程度选",
      options: [
        { id: "opt-1", label: "完全没碰过，纯零基础" },
        { id: "opt-2", label: "看过一些教程，但没实际写过" },
        { id: "opt-3", label: "写过一些小 demo 或简单页面" },
        { id: "opt-4", label: "比较熟悉，想系统过一遍考点" },
      ],
    },
    {
      id: "gap",
      kind: "focus",
      tab: "最想补的层面",
      rationale: "缺口决定哪一关加重",
      teachingUse: "选中的层面多给对比和练习",
      question: "作为 React 前端，你觉得自己最需要补的是哪一块？",
      thinkingHint: "选现在最卡住面试准备的那一层",
      options: [
        { id: "a", label: "Dart 语言本身（语法、异步、类型）" },
        { id: "b", label: "Widget 与布局系统（和 JSX/CSS 的差异）" },
      ],
    },
    {
      id: "deadline",
      kind: "constraints",
      tab: "面试时间线",
      rationale: "期限决定深度和练习量",
      teachingUse: "几周内就压缩到高频考点",
      question: "你大概什么时候要去面试？",
      thinkingHint: "按真实时间选，不必报得更从容",
      options: [
        { id: "A", label: "很急，几周内就要面" },
        { id: "B", label: "一两个月内" },
        { id: "C", label: "不着急，先系统学起来" },
      ],
    },
  ];
  const upgraded = ensureTopicModelDefaults(model);
  assert.deepEqual(upgraded.diagnosticDimensions.map((item) => item.tab), ["Dart/Flutter 基础", "最想补的层面", "面试时间线"]);
  assert.doesNotMatch(upgraded.diagnosticDimensions.map((item) => item.tab).join("、"), /了解程度|学习动机|内容侧重/);
  assert.deepEqual(upgraded.diagnosticDimensions[0].options.map((item) => item.id), ["A", "B", "C", "D"]);
  assert.equal(upgraded.diagnosticDimensions[0].options[0].label, "完全没碰过，纯零基础");
});

test("normalizes teacher-designed diagnostic aliases before validation", () => {
  const normalized = normalizeDesignedDiagnostics({
    questions: [{
      title: "缩量下跌",
      type: "misconception",
      prompt: "缩量下跌作为筑底信号，你的理解是？",
      hint: "按你现在的真实理解选",
      choices: [
        { text: "成交量持续萎缩，说明抛压枯竭、卖盘减少" },
        { text: "价格下跌但成交清淡，说明市场没人关注" },
        { text: "缩量说明主力在悄悄吸筹" },
        { text: "不太清楚" },
      ],
    }, {
      name: "熟悉程度",
      aspect: "baseline",
      question: "关于筑底迹象，你目前的熟悉程度是？",
      answers: [{ label: "有实战看盘经验" }, { label: "不太清楚" }],
    }],
  }) as { diagnosticDimensions: Array<{ tab: string; kind: string; options: Array<{ id: string }> }> };

  assert.equal(normalized.diagnosticDimensions[0].tab, "缩量下跌");
  assert.equal(normalized.diagnosticDimensions[0].kind, "misconception");
  assert.deepEqual(normalized.diagnosticDimensions[0].options.map((item) => item.id), ["A", "B", "C", "D"]);
  assert.equal(normalized.diagnosticDimensions[1].kind, "baseline");
});

test("generic four-beat route titles are not valid content nodes", () => {
  assert.equal(isGenericRouteTitle("核心机制"), true);
  assert.equal(isGenericRouteTitle("基础定位"), true);
  assert.equal(isGenericRouteTitle("实践应用"), true);
  assert.equal(isGenericRouteTitle("吸收性心智"), false);
});

test("rewrites evaluation aliases into the closed schema before validation", () => {
  const normalized = normalizeEvaluation({
    intent: "answer",
    understoodMeaning: "学生用生活例子说明了吸收性心智",
    observations: [
      "3岁前全盘吸收 -> 抓住了无意识吸收",
      { quote: "教导其实没什么用" },
    ],
    assessment: {
      status: "in_progress",
      score: 0.65,
      rubricEvidence: { accuracy: "提到了吸收", explained: "还没对比教导" },
      evidence: [
        { learnerQuote: "全盘吸收", criterion: "accuracy", strength: "partial" },
        { quote: "教导没什么用", criterion: "explanation", strength: "none" },
      ],
    },
    pedagogy: {
      hit: ["全盘吸收"],
      unpunched: ["有意识吸收"],
      invented: [],
      sourceMove: "补一层敏感期",
    },
    questionCandidates: [{
      purpose: "explanation",
      text: "幼儿学会母语口音和成人背单词有什么不同？",
      thinkingHint: "对比有没有刻意记忆",
    }],
  }) as Record<string, any>;

  assert.deepEqual(normalized.observations[0], { quote: "3岁前全盘吸收", implication: "抓住了无意识吸收" });
  assert.equal(normalized.observations[1].implication, "诊断证据");
  assert.equal(normalized.assessment.status, "partial");
  assert.equal(normalized.assessment.score, 65);
  assert.deepEqual(normalized.assessment.rubricEvidence, ["提到了吸收", "还没对比教导"]);
  assert.equal(normalized.assessment.evidence[0].criterion, "accurate");
  assert.equal(normalized.assessment.evidence[0].strength, "weak");
  assert.equal(normalized.assessment.evidence[1].criterion, "explained");
  assert.equal(normalized.assessment.evidence[1].learnerQuote, "教导没什么用");
  assert.equal(normalized.pedagogy.hit, "全盘吸收");
  assert.equal(normalized.pedagogy.invented, "");
  assert.equal(normalized.questionCandidates[0].purpose, "explained");
});

test("treats vacuous invented claims as empty before evaluation validation", () => {
  const normalized = normalizeEvaluation({
    intent: "answer",
    understoodMeaning: "学生给出了家庭材料方案",
    observations: [{ quote: "给些豆子、大米", implication: "迁移到家庭" }],
    assessment: {
      status: "partial",
      evidence: [{ learnerQuote: "给些豆子、大米", criterion: "transfer", strength: "sufficient" }],
    },
    pedagogy: {
      hit: "豆子和大米",
      unpunched: "",
      invented: "无",
      sourceMove: "补结构",
    },
    misconceptionUpdates: [{ description: "无", status: "open", evidenceQuote: "—" }],
    questionCandidates: [],
  }) as Record<string, any>;

  assert.equal(normalized.pedagogy.invented, "");
  assert.deepEqual(normalized.misconceptionUpdates, []);
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
  assert.equal(normalized.teachingApproach.startingPoint, "从学习者当前能理解的整体框架开始");
  assert.equal(normalized.teachingApproach.rationale.length, 3);
});

test("one fluent answer cannot award every mastery dimension", () => {
  const evidence = (["accurate", "explained", "discrimination", "transfer"] as const).map((criterion) => ({
    learnerQuote: "这段回答把四层都说得很像",
    criterion,
    strength: "sufficient" as const,
    confidence: 0.95,
  }));

  const constrained = constrainEvaluationEvidence(evidence, "transfer");
  assert.deepEqual(
    constrained.filter((item) => item.strength === "sufficient").map((item) => item.criterion),
    ["accurate", "transfer"],
  );
  assert.equal(
    constrainEvaluationEvidence(evidence, "doubt-check").some((item) => item.strength === "sufficient"),
    false,
  );
});

test("a direct explanation request is answered but the teacher still follows up", () => {
  const evaluation = fakeEvaluation("直接告诉我答案");
  evaluation.intent = "direct_answer_request";
  const decision = buildEvidenceDrivenDecision({
    model: fakeTopicModel(),
    activeConcept: 0,
    evaluation,
  });

  assert.equal(decision.nextAction, "explain");
  assert.match(decision.responsePlan.question ?? "", /？（思路：[^）]+）$/u);
  assert.equal(decision.pedagogy?.nextQuestion, decision.responsePlan.question);
});

test("teaching questions carry a non-answer thinking direction", () => {
  const evaluation = fakeEvaluation("我先试着回答");
  const decision = buildEvidenceDrivenDecision({
    model: fakeTopicModel(),
    activeConcept: 0,
    evaluation,
  });

  assert.match(decision.responsePlan.question ?? "", /？（思路：[^）]+）$/u);
  assert.doesNotMatch(decision.responsePlan.question ?? "", /标准答案|答案是/u);
});

test("node progress score follows sufficient evidence on the current route node", () => {
  const model = fakeTopicModel();
  assert.deepEqual(nodeProgress(model, 0), { score: 0, status: "in-progress" });
  assert.equal(nodeProgress(model, 0, {
    nodeId: "concept-1",
    stage: "elicit",
    evidence: [
      { learnerQuote: "微小事物敏感期", criterion: "accurate", strength: "sufficient" },
      { learnerQuote: "嘴也算探索", criterion: "discrimination", strength: "weak" },
    ],
    misconceptions: [],
    questionsAsked: [],
  }).score, 25);
  assert.deepEqual(nodeProgress(model, 0, {
    nodeId: "concept-1",
    stage: "elicit",
    evidence: [
      { learnerQuote: "微小事物敏感期", criterion: "accurate", strength: "sufficient" },
      { learnerQuote: "手眼协调", criterion: "explained", strength: "sufficient" },
    ],
    misconceptions: [],
    questionsAsked: [],
  }), { score: 50, status: "in-progress" });
  assert.deepEqual(nodeProgress(model, 0, {
    nodeId: "concept-1",
    stage: "mastered",
    evidence: [
      { learnerQuote: "准确", criterion: "accurate", strength: "sufficient" },
      { learnerQuote: "解释", criterion: "explained", strength: "sufficient" },
      { learnerQuote: "辨析", criterion: "discrimination", strength: "sufficient" },
      { learnerQuote: "迁移", criterion: "transfer", strength: "sufficient" },
    ],
    misconceptions: [],
    questionsAsked: [],
  }), { score: 100, status: "mastered" });
});

test("vacuous invented does not recycle the opening question as a misconception repair", () => {
  const model = fakeTopicModel();
  const opening = withThinkingHint(model.conceptRoute[0].openingQuestion, model.conceptRoute[0].openingHint);
  const evaluation = fakeEvaluation("给些豆子、大米让孩子在成人监护下玩耍");
  evaluation.pedagogy.invented = "无";
  evaluation.assessment.evidence = [
    { learnerQuote: "给些豆子、大米", criterion: "transfer", strength: "sufficient", confidence: 0.9 },
  ];
  evaluation.questionCandidates = [
    { purpose: "accurate", text: "最关键的区别是什么？", thinkingHint: "对比两个条件" },
  ];
  const decision = buildEvidenceDrivenDecision({
    model,
    activeConcept: 0,
    nodeState: {
      nodeId: "concept-1",
      stage: "elicit",
      evidence: [
        { learnerQuote: "微小事物敏感期", criterion: "accurate", strength: "sufficient" },
        { learnerQuote: "手眼协调", criterion: "explained", strength: "sufficient" },
      ],
      misconceptions: [],
      questionsAsked: [opening],
      lastQuestionPurpose: "transfer",
    },
    evaluation,
  });

  assert.notEqual(decision.nextAction, "repair-misconception");
  assert.equal(decision.pedagogy?.invented, "");
  assert.notEqual(decision.responsePlan.gapToRepair, "无");
  assert.equal(decision.responsePlan.question?.includes(model.conceptRoute[0].openingQuestion), false);
  assert.match(decision.responsePlan.question ?? "", /换到另一个你熟悉的场景/);
});

test("an opening hint that already includes 思路 is wrapped only once", () => {
  const model = fakeTopicModel();
  model.conceptRoute[0].openingQuestion = "一个两岁半的孩子反复把积木排成一条线，成人应当如何解读与应对？";
  model.conceptRoute[0].openingHint = "（思路：从特定年龄段的发展敏感期特征，以及儿童如何通过外部环境建立内在安全感与心智模型来思考。）";
  const question = buildFirstTeachingDecision(model, "诊断摘要").responsePlan.question ?? "";
  const wrapped = withThinkingHint(model.conceptRoute[0].openingQuestion, model.conceptRoute[0].openingHint);

  assert.equal((question.match(/思路：/g) ?? []).length, 1);
  assert.doesNotMatch(question, /（思路：（思路：/);
  assert.match(question, /？（思路：从特定年龄段的发展敏感期特征/);
  assert.equal(
    hasAskedQuestion(`讲解结束。\n\n${model.conceptRoute[0].openingQuestion}（思路：从特定年龄段的发展敏感期特征，以及儿童如何通过外部环境建立内在安全感与心智模型来思考。）`, wrapped),
    true,
  );
});

test("an open misconception blocks mastery even after doubt confirmation", () => {
  const evaluation = fakeEvaluation("没有疑问了");
  evaluation.assessment.evidence = [];
  const decision = buildEvidenceDrivenDecision({
    model: fakeTopicModel(),
    activeConcept: 0,
    nodeState: {
      nodeId: "concept-1",
      stage: "doubt-check",
      evidence: (["accurate", "explained", "discrimination", "transfer"] as const).map((criterion) => ({
        learnerQuote: `已证明 ${criterion}`,
        criterion,
        strength: "sufficient" as const,
      })),
      misconceptions: [{ description: "把相关性当因果", status: "open" }],
      questionsAsked: ["还有疑问吗？"],
      lastQuestionPurpose: "doubt-check",
    },
    evaluation,
  });

  assert.equal(decision.nextAction, "repair-misconception");
  assert.equal(decision.statePatch.masteredConceptId, undefined);
  assert.match(decision.responsePlan.gapToRepair, /相关性当因果/);
});

test("a repaired misconception can pass the deterministic mastery gate", () => {
  const evaluation = fakeEvaluation("没有疑问了");
  evaluation.misconceptionUpdates = [{
    description: "把相关性当因果",
    status: "repaired",
    evidenceQuote: "我现在会先验证因果链",
  }];
  const decision = buildEvidenceDrivenDecision({
    model: fakeTopicModel(),
    activeConcept: 0,
    nodeState: {
      nodeId: "concept-1",
      stage: "doubt-check",
      evidence: (["accurate", "explained", "discrimination", "transfer"] as const).map((criterion) => ({
        learnerQuote: `已证明 ${criterion}`,
        criterion,
        strength: "sufficient" as const,
      })),
      misconceptions: [{ description: "把相关性当因果", status: "open" }],
      questionsAsked: ["还有疑问吗？"],
      lastQuestionPurpose: "doubt-check",
    },
    evaluation,
  });

  assert.equal(decision.nextAction, "advance-concept");
  assert.equal(decision.statePatch.masteredConceptId, "concept-1");
  assert.equal(decision.statePatch.activeConceptId, "concept-2");
  assert.match(decision.responsePlan.question ?? "", /新场景.*？（思路：[^）]+）$/u);
});

test("upgrades legacy topic models without introducing a closed subject enum", () => {
  const legacy = fakeTopicModel();
  delete (legacy as Partial<TopicModel>).subject;
  delete (legacy as Partial<TopicModel>).grounding;
  delete (legacy as Partial<TopicModel>).capabilities;
  delete (legacy.conceptRoute[0] as Partial<TopicModel["conceptRoute"][number]>).openingQuestion;
  delete (legacy.conceptRoute[0] as Partial<TopicModel["conceptRoute"][number]>).openingHint;
  const upgraded = ensureTopicModelDefaults(legacy);
  assert.equal(upgraded.subject.kind, "open-learning-subject");
  assert.equal(upgraded.grounding.sources.length, 0);
  assert.deepEqual(upgraded.capabilities.structuring, ["concept-dependency"]);
  assert.match(upgraded.conceptRoute[0].openingQuestion, /第一个概念/);
  assert.match(upgraded.conceptRoute[0].openingHint, /背景、定义和核心内容/);
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
    const progress = events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("");
    assert.match(progress, /检索|主题模型/);
    const latestTrace = [...events].reverse().find((event) => event.type === "reasoning.trace.ready");
    assert.equal(latestTrace?.type, "reasoning.trace.ready");
    if (latestTrace?.type === "reasoning.trace.ready") {
      assert.equal(latestTrace.trace.phase, "diagnose");
      assert.match(latestTrace.trace.rawThinking, /没有对学习者回答做教学诊断|诊断开场/);
    }

    events.length = 0;
    await tutor.run("test-session", "完成诊断", emit, undefined, {
      diagnosticAnswers: protocolAnswers(),
    });

    assert.ok(events.some((event) => event.type === "diagnosis.ready"));
    assert.ok(events.some((event) => event.type === "roadmap.ready"));
    assert.ok(events.some((event) => event.type === "reasoning.trace.ready"));
    assert.ok(events.some((event) => event.type === "state.saved"));
    const teachingTrace = events.find((event) => event.type === "reasoning.trace.ready");
    assert.equal(teachingTrace?.type, "reasoning.trace.ready");
    if (teachingTrace?.type === "reasoning.trace.ready") {
      assert.match(teachingTrace.trace.rawThinking, /第一个概念|编排器/);
      assert.doesNotMatch(teachingTrace.trace.rawThinking, /不展示隐藏推理文本/);
    }

    const state = JSON.parse(await readFile(join(root, "sessions", "test-session.json"), "utf8")) as { schemaVersion: number; phase: string; currentCard: number; learnerProfile: string[] };
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.phase, "teach");
    assert.equal(state.currentCard, 3);
    assert.ok(state.learnerProfile.some((item) => item.includes("没有自己实践过")));
    assert.match(await readFile(join(root, "events", "test-session.jsonl"), "utf8"), /state\.saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic design covers learner baseline, motivation and focus with teaching rationale", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-diagnostic-quality-test-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient(), async () => "没有找到相关结果");
    const events: TutorEvent[] = [];
    await tutor.run("diagnostic-quality-session", "我想系统学习一个主题", (event) => { events.push(event); });

    const ready = events.find((event) => event.type === "diagnostic.cards.ready");
    assert.equal(ready?.type, "diagnostic.cards.ready");
    if (ready?.type === "diagnostic.cards.ready") {
      assert.deepEqual(ready.cards.map((card) => card.kind), ["baseline", "motivation", "focus", "misconception"]);
      assert.ok(ready.cards.every((card) => card.rationale.trim() && card.teachingUse.trim()));
      assert.ok(ready.cards.every((card) => /（思路：[^）]+）$/u.test(card.question)));
      assert.deepEqual(ready.cards.find((card) => card.kind === "focus")?.options.map((item) => item.label), ["第一个概念", "第二个概念"]);
    }
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

test("uses a weixin article as source material and does not search", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-weixin-test-"));
  try {
    const client = fakeModelClient();
    let receivedGoal = "";
    let receivedMaterials: string[] = [];
    client.buildTopicModel = async ({ userGoal, materials }) => {
      receivedGoal = userGoal;
      receivedMaterials = materials ?? [];
      return fakeTopicModel();
    };
    const searchQueries: string[] = [];
    const tutor = new TutorOrchestrator(
      new TutorStore(root),
      client,
      async (query) => {
        searchQueries.push(query);
        return "搜索不该被调用";
      },
      async (url) => ({ title: "定投的底层逻辑", url, markdown: "定投不是择时。贵不贵要看估值分位数。" }),
    );
    const events: TutorEvent[] = [];
    await tutor.run("weixin-session", "https://mp.weixin.qq.com/s/abcd1234", (event) => { events.push(event); });

    assert.deepEqual(searchQueries, []);
    assert.match(receivedGoal, /定投的底层逻辑/);
    assert.match(receivedMaterials[0] ?? "", /估值分位数/);
    assert.ok(events.some((event) => event.type === "research.completed"));
    const thinking = events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("");
    assert.match(thinking, /微信公众号文章/);

    const state = JSON.parse(await readFile(join(root, "sessions", "weixin-session.json"), "utf8")) as TutorState;
    assert.equal(state.topicModel?.grounding.mode, "source-material");
    assert.deepEqual(state.topicModel?.grounding.sources, [{ label: "https://mp.weixin.qq.com/s/abcd1234", verified: true }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explain mode skips diagnostics and cannot be changed later", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-explain-mode-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient(), async () => "没有找到相关结果");
    const events: TutorEvent[] = [];
    await tutor.run("explain-session", "我想学习任意主题", (event) => { events.push(event); }, undefined, { sessionMode: "explain" });
    assert.equal(events.some((event) => event.type === "diagnostic.card.ready"), false);
    assert.ok(events.some((event) => event.type === "roadmap.ready"));
    assert.ok(events.some((event) => event.type === "message.delta"));
    const state = JSON.parse(await readFile(join(root, "sessions", "explain-session.json"), "utf8")) as TutorState;
    assert.equal(state.sessionMode, "explain");
    assert.equal(state.phase, "teach");

    await tutor.run("explain-session", "接下来讲第二点", () => {}, undefined, { sessionMode: "teach" });
    const locked = JSON.parse(await readFile(join(root, "sessions", "explain-session.json"), "utf8")) as TutorState;
    assert.equal(locked.sessionMode, "explain");
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
      diagnosticAnswers: protocolAnswers(),
    });

    const state = JSON.parse(await readFile(join(root, "sessions", "story-session.json"), "utf8")) as TutorState;
    assert.deepEqual(state.lastDecision?.responsePlan.keyPoints, [
      model.backgroundBrief,
      "先介绍故事发生的背景、关键人物，以及这段故事如何引出主题",
    ]);
    assert.equal(state.lastDecision?.responsePlan.backgroundBrief, model.backgroundBrief);
    assert.equal(state.lastDecision?.nextAction, "ask-socratic-question");
    assert.match(state.lastDecision?.responsePlan.question ?? "", /？（思路：[^）]+）$/u);
    assert.equal(state.lastDecision?.pedagogy?.nextQuestion, state.lastDecision?.responsePlan.question);
    assert.equal(state.lastDecision?.pedagogy?.questionPurpose, "introduce");
    assert.equal(state.lastDecision?.pedagogy?.restatedBiography, true);
    assert.doesNotMatch(state.lastDecision?.responsePlan.question ?? "", /根据刚才介绍的内容|最关键的区别/);
    assert.deepEqual(state.nodeLearningStates["concept-1"].questionsAsked, [state.lastDecision?.responsePlan.question]);
    assert.match(state.messages.at(-1)?.content ?? "", /在你熟悉的场景里.*？（思路：[^）]+）$/u);
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
      diagnosticAnswers: protocolAnswers(),
    });
    assert.ok(events.some((event) => event.type === "diagnosis.ready"));
    assert.ok(events.some((event) => event.type === "topic.background.ready" && event.summary === fakeTopicModel().backgroundBrief));
    assert.ok(events.some((event) => event.type === "roadmap.ready"));
    const diagnosisEvent = events.find((event) => event.type === "diagnosis.ready");
    assert.equal(diagnosisEvent?.type, "diagnosis.ready");
    if (diagnosisEvent?.type === "diagnosis.ready") {
      assert.equal(diagnosisEvent.teachingApproach.exampleContext, "使用学习者熟悉的工作场景");
    }
    const saved = JSON.parse(await readFile(join(root, "sessions", "writing-session.json"), "utf8")) as TutorState;
    assert.equal(saved.teachingApproach?.startingPoint, "先建立整体框架");
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
    const client = fakeModelClient();
    client.evaluateAnswer = async ({ message }) => {
      const criterion = message.includes("迁移")
        ? "transfer"
        : message.includes("辨析")
          ? "discrimination"
          : message.includes("解释")
            ? "explained"
            : "accurate";
      const evaluation = fakeEvaluation(message);
      evaluation.assessment.status = "mastered";
      evaluation.assessment.score = 95;
      evaluation.assessment.evidence = [{ learnerQuote: message, criterion, strength: "sufficient", confidence: 0.95 }];
      return evaluation;
    };
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");
    const events: TutorEvent[] = [];
    const emit = (event: TutorEvent): void => { events.push(event); };
    const lastScore = () => {
      const event = [...events].reverse().find((item) => item.type === "assessment.updated");
      return event?.type === "assessment.updated" ? event : undefined;
    };

    await tutor.run("mastery-session", "我想学习一个全新的对象", emit);
    await tutor.run("mastery-session", "完成诊断", emit, undefined, {
      diagnosticAnswers: protocolAnswers(),
    });
    await tutor.run("mastery-session", "我能准确复述", emit);
    let state = JSON.parse(await readFile(join(root, "sessions", "mastery-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "active");
    assert.equal(lastScore()?.score, 25);
    assert.equal(lastScore()?.status, "in-progress");

    await tutor.run("mastery-session", "我能解释原因", emit);
    assert.equal(lastScore()?.score, 50);
    await tutor.run("mastery-session", "我能辨析相近概念", emit);
    assert.equal(lastScore()?.score, 75);
    await tutor.run("mastery-session", "我能迁移到新场景", emit);
    state = JSON.parse(await readFile(join(root, "sessions", "mastery-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "active");
    assert.equal(state.nodeLearningStates["concept-1"].stage, "doubt-check");
    assert.equal(lastScore()?.score, 100);
    assert.equal(lastScore()?.status, "in-progress");

    events.length = 0;
    await tutor.run("mastery-session", "没有疑问了", emit);
    state = JSON.parse(await readFile(join(root, "sessions", "mastery-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "mastered");
    assert.equal(state.roadmap[1].status, "active");
    assert.equal(state.activeConcept, 1);
    assert.equal(lastScore()?.score, 100);
    assert.equal(lastScore()?.status, "mastered");
    const latestRoadmap = [...events].reverse().find((item) => item.type === "roadmap.ready");
    assert.equal(latestRoadmap?.type, "roadmap.ready");
    if (latestRoadmap?.type === "roadmap.ready") {
      assert.equal(latestRoadmap.roadmap[0].status, "mastered");
      assert.equal(latestRoadmap.roadmap[1].status, "active");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saying dont know raises the hint level without creating mastery evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-hint-ladder-test-"));
  try {
    const tutor = new TutorOrchestrator(new TutorStore(root), fakeModelClient(), async () => "没有找到相关结果");
    await tutor.run("hint-session", "我想学习一个全新的对象", () => {});
    await tutor.run("hint-session", "完成诊断", () => {}, undefined, {
      diagnosticAnswers: protocolAnswers(),
    });

    await tutor.run("hint-session", "不知道", () => {});
    const state = JSON.parse(await readFile(join(root, "sessions", "hint-session.json"), "utf8")) as TutorState;
    const node = state.nodeLearningStates["concept-1"];
    assert.equal(node.hintLevel, 1);
    assert.equal(node.evidence.some((item) => item.strength === "sufficient"), false);
    assert.equal(state.lastDecision?.nextAction, "give-example");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strips streamed A/B/C/D option lists out of diagnose intro copy", () => {
  const leaked = [
    "为了更好地为你定制学习内容与节奏，我们先进行一个简短的摸底。",
    "",
    "A. 零基础，只听过名字",
    "B. 接触过零散概念（如敏感期、蒙氏教具等）",
    "C. 读过相关书籍或在家庭中有初步实践",
    "D. 系统学习过或具备相关教育从业经验",
    "",
    "你目前和「蒙氏教育」的真实接触到哪一步了？",
  ].join("\n");
  const cleaned = stripChoiceOptionLines(leaked);
  assert.doesNotMatch(cleaned, /^[A-D][\.．、]/m);
  assert.match(cleaned, /简短的摸底/);
});

test("diagnostic intro does not leak the core outcome, options, or card question into prose", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-intro-leak-test-"));
  try {
    const client = fakeModelClient();
    let streamed = false;
    client.streamResponse = async ({ decision }, onDelta) => {
      streamed = true;
      await onDelta(`A. 零基础\nB. 接触过概念\n${decision.responsePlan.question}`);
      return `A. 零基础\nB. 接触过概念\n${decision.responsePlan.question}`;
    };
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");
    const events: TutorEvent[] = [];
    await tutor.run("intro-session", "我想学习一个全新的对象", (event) => { events.push(event); });

    assert.equal(streamed, false);
    const state = JSON.parse(await readFile(join(root, "sessions", "intro-session.json"), "utf8")) as TutorState;
    assert.equal(state.messages.at(-1)?.content, DIAGNOSE_INTRO_TEXT);
    assert.doesNotMatch(state.messages.at(-1)?.content ?? "", /^[A-D][\.．、]/m);
    assert.doesNotMatch(state.messages.at(-1)?.content ?? "", /真实接触到哪一步了/);
    assert.ok(!state.lastDecision?.responsePlan.keyPoints.some((item) => item.includes("能够理解核心概念并在新场景中独立应用")));
    assert.ok(state.lastDecision?.responsePlan.forbiddenContent.some((item) => /列出诊断选项|重复诊断卡题干/.test(item)));
    const cards = events.find((event) => event.type === "diagnostic.cards.ready");
    assert.equal(cards?.type, "diagnostic.cards.ready");
    if (cards?.type === "diagnostic.cards.ready") {
      assert.match(cards.cards[0].question, /真实接触到哪一步了/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decision fallback keeps teaching from the learner quote instead of asking for a restatement", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-teach-fallback-test-"));
  try {
    const client = fakeModelClient();
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");

    await tutor.run("teach-fallback-session", "我想学习一个全新的对象", () => {});
    await tutor.run("teach-fallback-session", "完成诊断", () => {}, undefined, {
      diagnosticAnswers: protocolAnswers(),
    });

    client.evaluateAnswer = async () => { throw new Error("结构化输出校验失败"); };
    const events: TutorEvent[] = [];
    await tutor.run("teach-fallback-session", "对钱是不是当作产生资产的工具", (event) => { events.push(event); });

    assert.ok(events.some((event) => event.type === "model.degraded" && event.stage === "decision"));
    assert.equal(events.some((event) => event.type === "run.failed"), false);

    const state = JSON.parse(await readFile(join(root, "sessions", "teach-fallback-session.json"), "utf8")) as TutorState;
    const decision = state.lastDecision;
    assert.ok(decision);
    assert.notEqual(decision.nextAction, "ask-clarification");
    assert.doesNotMatch(decision.responsePlan.question ?? "", /再用一句话说明/);
    assert.doesNotMatch(decision.understoodMeaning, /评估未完成/);
    assert.doesNotMatch(decision.evidence[0]?.implication ?? "", /暂不据此更新掌握状态/);
    assert.match(decision.evidence[0]?.quote ?? "", /产生资产的工具/);
    assert.equal(decision.pedagogy?.restatedBiography, false);
    assert.match(decision.responsePlan.question ?? "", /？（思路：[^）]+）$/u);
    assert.equal(decision.pedagogy?.nextQuestion, decision.responsePlan.question);
    assert.match(decision.thinking ?? "", /带着原话继续教|教学决策失败/);
    const thinkingTrace = events.find((event) => event.type === "reasoning.trace.ready");
    assert.equal(thinkingTrace?.type, "reasoning.trace.ready");
    if (thinkingTrace?.type === "reasoning.trace.ready") {
      assert.match(thinkingTrace.trace.rawThinking, /带着原话继续教|教学决策失败/);
      assert.doesNotMatch(thinkingTrace.trace.rawThinking, /暂不据此更新掌握状态/);
    }
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
      diagnosticAnswers: protocolAnswers(),
    });

    client.evaluateAnswer = async () => { throw new Error("结构化输出校验失败"); };
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
      teachingApproach: fakeTeachingApproach(),
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
      diagnosticAnswers: protocolAnswers({ baseline: "A", motivation: "A", focus: "B" }),
    });

    const state = JSON.parse(await readFile(join(root, "sessions", "skip-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "active");
    assert.equal(state.activeConcept, 0);
    const teachingTrace = events.find((event) => event.type === "reasoning.trace.ready");
    assert.equal(teachingTrace?.type, "reasoning.trace.ready");
    if (teachingTrace?.type === "reasoning.trace.ready") {
      assert.match(teachingTrace.trace.rawThinking, /第一个概念|编排器/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streams an auditable evidence-and-action trace instead of hidden chain of thought", async () => {
  const root = await mkdtemp(join(tmpdir(), "walry-raw-thinking-test-"));
  try {
    const client = fakeModelClient();
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");
    await tutor.run("raw-thinking-session", "我想学习一个全新的对象", () => {});
    await tutor.run("raw-thinking-session", "完成诊断", () => {}, undefined, {
      diagnosticAnswers: protocolAnswers(),
    });

    const events: TutorEvent[] = [];
    await tutor.run("raw-thinking-session", "对钱是不是当作产生资产的工具", (event) => { events.push(event); });

    const deltas = events.filter((event) => event.type === "reasoning.delta").map((event) => event.text).join("");
    assert.match(deltas, /产生资产的工具/);
    assert.match(deltas, /选择动作/);
    assert.match(deltas, /正在根据你的回答做教学判断/);
    const trace = events.find((event) => event.type === "reasoning.trace.ready");
    assert.equal(trace?.type, "reasoning.trace.ready");
    if (trace?.type === "reasoning.trace.ready") {
      assert.ok(deltas.includes(trace.trace.rawThinking));
      assert.match(trace.trace.rawThinking, /选择动作/);
      assert.ok(Array.isArray(trace.trace.observedEvidence));
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
      teachingApproach: fakeTeachingApproach(),
      skipSuggestions: [{ conceptId: "concept-1", reason: "选择题正确", confidence: "high" as const }],
    });
    const tutor = new TutorOrchestrator(new TutorStore(root), client, async () => "没有找到相关结果");

    await tutor.run("core-node-session", "我想学习一个核心主题", () => {});
    await tutor.run("core-node-session", "完成诊断", () => {}, undefined, {
      diagnosticAnswers: protocolAnswers({ baseline: "A", motivation: "A", focus: "A" }),
    });

    const state = JSON.parse(await readFile(join(root, "sessions", "core-node-session.json"), "utf8")) as TutorState;
    assert.equal(state.roadmap[0].status, "active");
    assert.equal(state.activeConcept, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
