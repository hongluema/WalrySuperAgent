import { randomUUID } from "node:crypto";
import { resolveMasteryPolicy } from "./domain/catalog.js";
import { buildEvidenceDrivenDecision, questionAlreadyAsked } from "./pedagogy.js";
import type { EvidenceCriterion, LearningObstacle, NodeLearningState, QuestionPurpose, TeachingFeedback, TeachingQuestion, TeachingSupport, TopicModel, TutorAnswerEvaluation, TutorState, TutorTurnDecision } from "./types.js";

export const WEB_TEACHING_POLICY = "web-teacher.v2" as const;
export const OBSTACLE_KINDS = ["none", "missing-fact", "prerequisite-gap", "representation-gap", "concept-boundary", "causal-model", "procedure-error", "transfer-gap", "evidence-gap", "expression-gap", "task-ambiguity", "load-or-affect", "uncertain"] as const;

export function usesWebTeaching(state: TutorState): boolean {
  return state.teachingPolicy === WEB_TEACHING_POLICY && state.sessionMode !== "explain";
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
  const question = node?.activeQuestion;
  const canAssess = evaluation.intent === "answer" && question && !["clarify", "doubt-check"].includes(question.purpose);
  const obstacle = evaluation.obstacle;
  const groundedObstacle: LearningObstacle = obstacle && (obstacle.kind === "none" || isQuote(message, obstacle.learnerQuote))
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
  return { id: `question_${randomUUID()}`, nodeId, purpose, text: stripHint(text), thinkingHint: hint, support, expectedSignals };
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
  // An existing unresolved misconception must be repaired before practising unrelated criteria.
  if (decision.nextAction === "repair-misconception" && move.purpose !== "clarify") {
    move.purpose = "discrimination";
    move.action = "repair-misconception";
    move.support = "hint";
    move.instruction = "针对尚未修复的误区使用最小反例，修复后再做独立新题";
  }
  if (["direct_answer_request", "clarification", "disagreement", "meta_question"].includes(evaluation.intent)) {
    move.action = "explain";
    move.support = "hint";
    move.instruction = "先回答实际疑问，核对学生的合理质疑，再让其完成一个小判断；求助本身不算作答";
  }
  const current = model.conceptRoute[activeConcept];
  const candidate = evaluation.questionCandidates.find((item) => item.purpose === move.purpose
    && item.text.trim() && item.expectedSignals?.length
    && !questionAlreadyAsked(nodeState?.questionsAsked ?? [], stripHint(item.text)));
  let question: TeachingQuestion;
  if (candidate) {
    question = newQuestion(current.id, candidate.purpose, candidate.text, candidate.thinkingHint, move.support, candidate.expectedSignals!);
  } else {
    // No invented content probe, no relabelled transfer evidence: this is explicitly a clarification.
    question = newQuestion(current.id, "clarify", `围绕“${current.title}”，你希望我先澄清题意、解释一个词，还是示范一个步骤？`, "可以指出原题中具体不清楚的位置", "none", []);
    move.action = "ask-clarification";
    move.instruction = "目前没有合适的内容探针，先确认需要的帮助；不要据此判断掌握";
  }
  decision.nextAction = move.action;
  decision.responsePlan = {
    ...decision.responsePlan,
    goal: move.instruction,
    gapToRepair: obstacle.kind === "none" ? decision.responsePlan.gapToRepair : obstacle.description,
    question: question.text,
  };
  decision.pedagogy = {
    ...decision.pedagogy!, nextQuestion: question.text, questionPurpose: question.purpose,
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
    if (node?.activeQuestion && isHelp) {
      question = { ...node.activeQuestion, support: decision.nextAction === "explain" || node.activeQuestion.support === "worked-example" ? "worked-example" : "hint" };
    } else {
      // A reused opening question is an introduction, never masquerading as a new transfer task.
      question = newQuestion(current.id, purpose === "doubt-check" || purpose === "clarify" ? purpose : "introduce", raw, hint, purpose === "doubt-check" ? "none" : "hint", []);
    }
    decision.responsePlan.question = question.text;
    decision.pedagogy = { ...decision.pedagogy!, questionPurpose: question.purpose, nextQuestion: question.text };
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
  node.activeQuestion = question;
  if (question) {
    node.questionHistory ??= [];
    const existing = node.questionHistory.findIndex((item) => item.id === question.id);
    if (existing >= 0) node.questionHistory[existing] = { ...question };
    else node.questionHistory.push({ ...question });
  }
  node.lastObstacle = decision.webTeaching?.obstacle;
  if (decision.intent === "answer" || decision.intent === "dont_know") {
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
