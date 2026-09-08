import { randomUUID } from "node:crypto";
import { resolveMasteryPolicy } from "./domain/catalog.js";
import { buildEvidenceDrivenDecision, questionAlreadyAsked } from "./pedagogy.js";
import { explanationTasks, usableHint, type ScaffoldedTask } from "./question-hints.js";
import type { EvidenceCriterion, LearningObstacle, NodeLearningState, QuestionPurpose, TeachingFeedback, TeachingQuestion, TeachingSupport, TopicModel, TutorAnswerEvaluation, TutorState, TutorTurnDecision } from "./types.js";

export const WEB_TEACHING_POLICY = "web-teacher.v2" as const;
export const OBSTACLE_KINDS = ["none", "missing-fact", "prerequisite-gap", "representation-gap", "concept-boundary", "causal-model", "procedure-error", "transfer-gap", "evidence-gap", "expression-gap", "task-ambiguity", "load-or-affect", "uncertain"] as const;

export function usesWebTeaching(state: TutorState): boolean {
  return state.teachingPolicy === WEB_TEACHING_POLICY && state.sessionMode !== "explain";
}

/** Narrow classroom controls, never a semantic claim about the course content. */
export function webRecoveryRequest(message: string): "continue" | "demonstrate" | "explain" | "hint" | undefined {
  const text = message.trim().replace(/[，。！？!?、,\s]/gu, "");
  if (/^(?:(?:没什么|没有|没|不|不用|无需)(?:需要)?(?:再)?澄清的?)?(?:请)?(?:继续|接着)(?:吧|讲|教学|学习)?$/u.test(text)) return "continue";
  if (/^(?:请|帮我|给我)?(?:示范|演示)(?:一个|一下|一)?(?:具体)?(?:步骤|例子|操作)?(?:吧|看看)?$/u.test(text)) return "demonstrate";
  if (/^(?:请|帮我)?(?:解释|讲解)(?:一个词|这个词|一下|清楚)?(?:吧)?$/u.test(text)) return "explain";
  if (/^(?:请|给我|给点|需要)?(?:提示|线索)(?:吧|一下)?$/u.test(text)) return "hint";
  return undefined;
}

export function rubricSignal(model: TopicModel, index: number, purpose: QuestionPurpose): string | undefined {
  const rubric = model.rubricAnchors.find((item) => item.conceptId === model.conceptRoute[index]?.id);
  if (!rubric) return undefined;
  const signals: Partial<Record<QuestionPurpose, string>> = {
    accurate: rubric.accuracy, explained: rubric.explanation, discrimination: rubric.discrimination,
    transfer: rubric.transfer, performance: rubric.performance,
  };
  return signals[purpose]?.trim() || undefined;
}

function isQuote(message: string, quote: string): boolean {
  return Boolean(quote.trim()) && message.replace(/\s/gu, "").includes(quote.replace(/\s/gu, ""));
}

function stripHint(question: string): string {
  return question.replace(/（思路：[\s\S]*）\s*$/u, "").trim();
}

function feedbackFor(model: TopicModel, index: number, node: NodeLearningState | undefined, decision: TutorTurnDecision): TeachingFeedback {
  const required = resolveMasteryPolicy(model, index).requiredCriteria;
  const sufficient = new Set([...(node?.evidence ?? []), ...decision.assessment.evidence]
    .filter((item) => item.strength === "sufficient").map((item) => item.criterion));
  const evidence = decision.assessment.evidence;
  return {
    observed: decision.pedagogy?.hit ?? "",
    gap: decision.responsePlan.gapToRepair,
    nextStep: "围绕当前缺口继续验证",
    evidenceMode: !evidence.length ? "none" : evidence.some((item) => item.support !== "none") ? "assisted" : "independent",
    metCriteria: required.filter((item) => sufficient.has(item)),
    missingCriteria: required.filter((item) => !sufficient.has(item)),
  };
}

/** The controller attaches provenance; model output cannot invent a question ID or execution proof. */
export function auditWebEvaluation(message: string, node: NodeLearningState | undefined, evaluation: TutorAnswerEvaluation): TutorAnswerEvaluation {
  const request = webRecoveryRequest(message);
  const confirmsNoDoubts = request === "continue" && node?.activeQuestion?.purpose === "doubt-check" && evaluation.intent === "no_doubts";
  if (request && !confirmsNoDoubts) evaluation = { ...evaluation, intent: request === "continue" ? "clarification" : "direct_answer_request" };
  const question = node?.activeQuestion;
  const canAssess = evaluation.intent === "answer" && question && !["clarify", "doubt-check"].includes(question.purpose);
  const obstacle = evaluation.obstacle;
  const groundedObstacle: LearningObstacle = evaluation.intent !== "answer"
    ? { kind: "none", description: "当前是教学请求，不是知识作答", learnerQuote: "" }
    : obstacle && (obstacle.kind === "none" || isQuote(message, obstacle.learnerQuote))
    ? obstacle
    : { kind: "uncertain", description: "需要确认你当前卡住的位置", learnerQuote: "" };
  const evidence = canAssess ? evaluation.assessment.evidence
    .filter((item) => isQuote(message, item.learnerQuote))
    .map((item) => ({
      ...item,
      // This slice only checks text responses. It cannot certify execution or a physical skill.
      strength: question.support !== "none" || item.criterion === "performance" ? "weak" as const : item.strength,
      questionId: question.id,
      nodeId: question.nodeId,
      support: question.support,
      verification: "learner-response" as const,
    })) : [];
  return {
    ...evaluation,
    obstacle: groundedObstacle,
    observations: evaluation.observations.filter((item) => isQuote(message, item.quote)),
    assessment: { ...evaluation.assessment, evidence },
    misconceptionUpdates: evaluation.intent === "answer"
      ? evaluation.misconceptionUpdates.filter((item) => isQuote(message, item.evidenceQuote)) : [],
    pedagogy: {
      ...evaluation.pedagogy,
      hit: evidence.length ? evaluation.pedagogy.hit : "",
      invented: evaluation.intent === "answer" && ["concept-boundary", "causal-model"].includes(groundedObstacle.kind)
        ? evaluation.pedagogy.invented : "",
    },
  };
}

type Move = { purpose: QuestionPurpose; action: TutorTurnDecision["nextAction"]; support: TeachingSupport; instruction: string };

function nextMove(obstacle: LearningObstacle, intent: TutorAnswerEvaluation["intent"], missing: EvidenceCriterion, stalled: number): Move {
  if (intent === "dont_know" || ["missing-fact", "prerequisite-gap", "representation-gap", "load-or-affect"].includes(obstacle.kind)) {
    return {
      purpose: missing, action: "give-example", support: stalled >= 1 ? "worked-example" : "hint",
      instruction: stalled >= 1
        ? "换一种表示或示范一个最小步骤，再让学习者完成下一步；不要同义重问"
        : "补充回答所需的一个事实、前置或具体表示，再做一个低门槛判断",
    };
  }
  if (obstacle.kind === "task-ambiguity" || obstacle.kind === "uncertain") {
    return { purpose: "clarify", action: "ask-clarification", support: "none", instruction: "先澄清题意或不确定的一步，不评价学生能力" };
  }
  if (obstacle.kind === "concept-boundary" || obstacle.kind === "causal-model") {
    return { purpose: "discrimination", action: "repair-misconception", support: "hint", instruction: "只针对学生原话里的错误模型给一个最小对照或反例，让学生修正规则" };
  }
  if (obstacle.kind === "procedure-error") {
    return { purpose: missing, action: "give-example", support: "hint", instruction: "保留正确步骤，只定位最早出错的一步，不重讲整个概念" };
  }
  if (obstacle.kind === "expression-gap") {
    return { purpose: missing, action: "ask-socratic-question", support: "none", instruction: "允许用图示、步骤或具体例子回答，不要求复述老师措辞" };
  }
  return {
    purpose: missing,
    action: missing === "transfer" || missing === "performance" ? "give-practice" : "ask-socratic-question",
    support: "none",
    instruction: obstacle.kind === "evidence-gap"
      ? "围绕主张与依据取得一个具体证据，不要求迎合老师观点"
      : "用未见过的具体任务验证当前缺口，撤除示范，不在题前讲出本题答案",
  };
}

function newQuestion(nodeId: string, purpose: QuestionPurpose, text: string, hint: string, support: TeachingSupport, expectedSignals: string[]): TeachingQuestion {
  return { id: `question_${randomUUID()}`, nodeId, purpose, text: stripHint(text), thinkingHint: usableHint(hint, stripHint(text)), support, expectedSignals };
}

/** Bounded, rubric-bound recovery tasks: infrastructure failure never asks the student to choose help again. */
export function contentRecoveryQuestion(model: TopicModel, index: number, node: NodeLearningState | undefined, purpose: QuestionPurpose, support: TeachingSupport): TeachingQuestion | undefined {
  const current = model.conceptRoute[index];
  const anchor = rubricSignal(model, index, purpose);
  if (!current) return undefined;
  const title = current.title;
  const prompts: Partial<Record<QuestionPurpose, ScaffoldedTask[]>> = {
    accurate: [
      { text: `围绕“${title}”，请给出一个具体例子，指出其中涉及的对象及它们的关系。`, hint: "先从刚才讨论的场景里选两个对象，分别标出它们的角色，再用一个动词连接它们；不要先下整件事对错的结论。" },
      { text: `回到“${title}”，请用当前材料中的一个具体事实说明你的理解。`, hint: "定位材料中一句描述实际情况的话，圈出对象和条件；先把原文信息与自己的推测分开，再用前者支持判断。" },
      { text: `关于“${title}”，请写出一个你能确认的判断，并说明它适用的条件。`, hint: "先写成「在___条件下，___」，再检查前半句是否漏掉时间、范围或对象限制；暂时不要扩展到所有情况。" },
    ],
    explained: explanationTasks(title, current.knowledgeTypes),
    discrimination: [
      { text: `请给出“${title}”适用和不适用的各一个例子，指出决定区别的条件。`, hint: "先固定同一个场景，只改变一个特征做成一对例子；将这个差异与定义要求对应，避免两个例子处处不同。" },
      { text: `围绕“${title}”，怎样只改变一个条件，就让原来的判断不再成立？`, hint: "把原判断依赖的条件列成清单，一次只取走一项，其余保持原样；先试最可能不可缺少的一项。" },
      { text: `请指出一个容易被误认为符合“${title}”的例子，并说明判断依据。`, hint: "分开列「表面上相似的特征」和「定义不可缺少的条件」，找一个具有前者却缺少后者的场景。" },
    ],
    transfer: [
      { text: `请选一个这堂课还没讨论过的实际场景，用“${title}”作出一个有依据的判断。`, hint: "先列旧例子中的对象、关系和限制，再为新场景逐项找对应；换名称不算新应用，至少检查一项条件是否真的不同。" },
      { text: `换到一个与你之前例子不同的场景，“${title}”的哪个原则仍然适用？请具体应用一次。`, hint: "把两个场景并排写，划掉仅是名称或外观的变化；检查剩余的关系和适用条件，先确认条件再套原则。" },
      { text: `请构造一个含有新限制的情境，并说明如何用“${title}”处理这个限制。`, hint: "保留旧例子的目标，只增加一个限制；先标出原做法中哪一步依赖了现在不再满足的条件。" },
    ],
    performance: [{ text: `请围绕“${title}”提交一个最小实际产物，并说明它对应的任务条件。`, hint: "先列「输入或材料｜一个操作｜可观察产物」，只完成这一条最短路径，再把产物与任务条件逐项对照。" }],
  };
  const task = prompts[purpose]?.find((item) => !questionAlreadyAsked(node?.questionsAsked ?? [], item.text));
  if (anchor && task) return newQuestion(current.id, purpose, task.text, task.hint, support, [anchor]);
  if (!questionAlreadyAsked(node?.questionsAsked ?? [], current.openingQuestion)) {
    return newQuestion(current.id, "introduce", current.openingQuestion, current.openingHint, "hint", []);
  }
  return undefined;
}

export function buildWebRecoveryDecision(message: string, model: TopicModel, activeConcept: number, nodeState?: NodeLearningState): TutorTurnDecision {
  return buildWebTeachingDecision({
    model, activeConcept, nodeState, message,
    evaluation: {
      intent: "clarification", understoodMeaning: "本轮评估不可用，仅恢复内容教学，不作掌握判断",
      obstacle: { kind: "none", description: "本轮没有可靠的评估结果", learnerQuote: "" },
      observations: [], assessment: { status: "not-answered", rubricEvidence: [], evidence: [] },
      misconceptionUpdates: [], pedagogy: { hit: "", unpunched: "本轮未作能力判定", invented: "", sourceMove: "回到当前内容" },
      questionCandidates: [],
    },
  });
}

/** Always select the entire candidate. No different-purpose fallback is allowed. */
export function buildWebTeachingDecision(input: {
  model: TopicModel; activeConcept: number; nodeState?: NodeLearningState;
  evaluation: TutorAnswerEvaluation; message: string;
}): TutorTurnDecision {
  const { model, activeConcept, nodeState } = input;
  const evaluation = auditWebEvaluation(input.message, nodeState, input.evaluation);
  const decision = buildEvidenceDrivenDecision({ model, activeConcept, nodeState, evaluation });
  const feedback = feedbackFor(model, activeConcept, nodeState, decision);
  const obstacle = evaluation.obstacle!;
  decision.webTeaching = { feedback, obstacle };

  // The existing deterministic gate still owns completion, doubts and node advancement.
  if (["complete", "switch-topic", "advance-concept"].includes(decision.nextAction) || decision.pedagogy?.questionPurpose === "doubt-check") {
    feedback.nextStep = decision.nextAction === "advance-concept" ? "本关证据已齐，进入下一内容关" : decision.nextAction === "complete" ? "收束当前学习" : "处理本关遗留疑问";
    return attachPlannedWebQuestion(model, activeConcept, nodeState, decision);
  }

  const missing = feedback.missingCriteria[0] ?? "discrimination";
  const move = nextMove(obstacle, evaluation.intent, missing, nodeState?.stalledTurns ?? 0);
  const request = webRecoveryRequest(input.message);
  const leavingClarification = nodeState?.activeQuestion?.purpose === "clarify";
  if (request || (leavingClarification && move.purpose === "clarify")) {
    move.purpose = missing;
    move.action = request && request !== "continue" ? "give-example" : "ask-socratic-question";
    move.support = request === "hint" ? "hint" : request && request !== "continue" ? "worked-example" : "none";
    move.instruction = request === "hint"
      ? "只给一个最小线索，再让学生完成题卡判断，不展开示范或答案"
      : request === "explain"
      ? "解释学生所问的当前术语或步骤，再让学生完成题卡中的具体判断，不再询问是否需要解释"
      : request === "demonstrate"
      ? "按学生请求示范一个当前内容步骤，再让学生完成题卡中的一个具体判断，不再询问是否需要示范"
      : "结束澄清，回到当前关卡的具体内容任务；本轮请求不算掌握证据";
  }
  // An existing unresolved misconception must be repaired before practising unrelated criteria.
  if (decision.nextAction === "repair-misconception" && move.purpose !== "clarify") {
    move.purpose = "discrimination";
    move.action = "repair-misconception";
    move.support = "hint";
    move.instruction = "针对尚未修复的误区使用最小反例，修复后再做独立新题";
  }
  if (!request && ["direct_answer_request", "clarification", "disagreement", "meta_question"].includes(evaluation.intent)) {
    move.action = "explain";
    move.support = "hint";
    move.instruction = "先回答实际疑问，核对学生的合理质疑，再让其完成一个小判断；求助本身不算作答";
  }
  const current = model.conceptRoute[activeConcept];
  const candidate = evaluation.questionCandidates.find((item) => item.purpose === move.purpose
    && item.text.trim() && item.expectedSignals?.length
    && !questionAlreadyAsked(nodeState?.questionsAsked ?? [], stripHint(item.text)));
  let question: TeachingQuestion | undefined;
  if (candidate) {
    question = newQuestion(current.id, candidate.purpose, candidate.text, candidate.thinkingHint, move.support, candidate.expectedSignals!);
  } else {
    const purpose = move.purpose === "clarify" ? missing : move.purpose;
    question = contentRecoveryQuestion(model, activeConcept, nodeState, purpose, move.support);
    if (question) {
      move.action = move.support === "none" ? "ask-socratic-question" : "give-example";
      move.instruction = move.support === "none" ? "回到当前内容，用题卡中的具体任务验证，不再重复帮助菜单"
        : move.support === "hint" ? "只给一个最小线索，随后让学生完成题卡任务，不展开示范或答案，不再重复帮助菜单"
        : request === "explain" ? "解释学生所问的当前术语或步骤，随后让学生完成题卡任务，不再询问是否需要解释"
        : "提供一个最小内容示范，随后让学生完成题卡任务，不再询问要不要示范";
    } else {
      move.action = "explain";
      move.instruction = "暂时无法生成新的有效内容题，明确说明并保留进度；不重复已问题目，不追加澄清菜单，不宣称掌握";
    }
  }
  decision.nextAction = move.action;
  decision.responsePlan = {
    ...decision.responsePlan,
    goal: move.instruction,
    gapToRepair: obstacle.kind === "none" ? decision.responsePlan.gapToRepair : obstacle.description,
    question: question?.text,
  };
  decision.pedagogy = {
    ...decision.pedagogy!, nextQuestion: question?.text ?? "", questionPurpose: question?.purpose ?? "introduce",
  };
  feedback.gap = decision.responsePlan.gapToRepair;
  feedback.nextStep = move.instruction;
  decision.webTeaching.question = question;
  return decision;
}

/** Initial, explicit-help and transition decisions use the same structured presentation contract. */
export function attachPlannedWebQuestion(model: TopicModel, index: number, node: NodeLearningState | undefined, decision: TutorTurnDecision): TutorTurnDecision {
  const feedback = decision.webTeaching?.feedback ?? feedbackFor(model, index, node, decision);
  const nextIndex = decision.statePatch.activeConceptId
    ? model.conceptRoute.findIndex((item) => item.id === decision.statePatch.activeConceptId) : index;
  const current = model.conceptRoute[nextIndex >= 0 ? nextIndex : index];
  const purpose = decision.pedagogy?.questionPurpose;
  const raw = decision.responsePlan.question;
  let question: TeachingQuestion | undefined;
  if (raw && purpose && !["complete", "switch-topic"].includes(decision.nextAction)) {
    const hint = raw.match(/（思路：([\s\S]*)）\s*$/u)?.[1] ?? current.openingHint;
    const isHelp = ["give-example", "explain"].includes(decision.nextAction);
    const helpSupport = decision.intent === "dont_know" ? "hint" : "worked-example";
    if (node?.activeQuestion && isHelp && node.activeQuestion.purpose !== "clarify" && node.activeQuestion.purpose !== "doubt-check") {
      question = { ...node.activeQuestion, thinkingHint: usableHint(node.activeQuestion.thinkingHint, node.activeQuestion.text), support: node.activeQuestion.support === "worked-example" ? "worked-example" : helpSupport };
    } else if (isHelp && (!node?.activeQuestion || node.activeQuestion.purpose === "clarify")) {
      question = contentRecoveryQuestion(model, index, node, feedback.missingCriteria[0] ?? "accurate", helpSupport);
      if (!question) decision.responsePlan.goal = "暂时没有新的有效内容题，先回应本次帮助请求并保留进度；不重复已问题目，不追加澄清菜单，不宣称掌握";
    } else {
      // A reused opening question is an introduction, never masquerading as a new transfer task.
      question = newQuestion(current.id, purpose === "doubt-check" || purpose === "clarify" ? purpose : "introduce", raw, hint, purpose === "doubt-check" ? "none" : "hint", []);
    }
    decision.responsePlan.question = question?.text;
    decision.pedagogy = { ...decision.pedagogy!, questionPurpose: question?.purpose ?? "introduce", nextQuestion: question?.text ?? "" };
  }
  feedback.nextStep = decision.responsePlan.goal;
  decision.webTeaching = { ...decision.webTeaching, question, feedback };
  return decision;
}

export function recordWebQuestion(state: TutorState, decision: TutorTurnDecision) {
  const current = state.topicModel?.conceptRoute[state.activeConcept];
  const node = current && state.nodeLearningStates[current.id];
  if (!node) return;
  const question = decision.webTeaching?.question;
  const leftClarification = node.activeQuestion?.purpose === "clarify" && question && question.purpose !== "clarify";
  node.activeQuestion = question;
  if (question) {
    node.questionHistory ??= [];
    const existing = node.questionHistory.findIndex((item) => item.id === question.id);
    if (existing >= 0) node.questionHistory[existing] = { ...question };
    else node.questionHistory.push({ ...question });
  }
  node.lastObstacle = decision.webTeaching?.obstacle;
  if (leftClarification) node.stalledTurns = 0;
  else if (decision.intent === "answer" || decision.intent === "dont_know") {
    node.stalledTurns = decision.assessment.evidence.some((item) => item.strength === "sufficient") ? 0 : (node.stalledTurns ?? 0) + 1;
  }
}

export function domainTeachingGuidance(model: TopicModel, index: number): string[] {
  const types = model.conceptRoute[index]?.knowledgeTypes ?? ["conceptual"];
  const rules: Record<string, string> = {
    factual: "不可推导的事实先给可靠材料；提取事实只能证明该事实的识别或回忆。",
    conceptual: "用正反例和最小对照检查必要特征；不要只考定义复述。",
    causal: "检查中间机制、条件与替代解释；不要把共变当因果证据。",
    formal: "检查定义、前提和逐步推导；一例计算正确不能当一般证明。",
    procedural: "检查实际步骤、产物与执行环境；没有真实执行结果就不能声称运行验证。",
    language: "围绕真实语境的表达或修改评价；允许合理措辞，文本不能证明发音听力。",
    argument: "检查主张与原始材料支持范围；接受有根据的不同解释。",
    strategic: "围绕约束、假设和取舍评价；不能以观点一致或事后结果判对。",
  };
  return [...types.map((type) => rules[type]), "来源不足时明确限制，不发明事实、引用、工具结果或学习者背景。"];
}
