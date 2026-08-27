import type {
  EvidenceCriterion,
  LearningEvidence,
  NodeLearningState,
  QuestionPurpose,
  TopicModel,
  TutorAnswerEvaluation,
  TutorTurnDecision,
} from "./types.js";

function nodeAt(model: TopicModel, index: number) {
  return model.conceptRoute[index] ?? model.conceptRoute[0];
}

function nextTitle(model: TopicModel, index: number) {
  return model.conceptRoute[index + 1]?.title;
}

export function withThinkingHint(question: string, hint?: string): string {
  const trimmed = question.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("（思路：")) return trimmed;
  const inner = (hint ?? "").trim().replace(/^（?思路：/, "").replace(/）$/, "").trim();
  return inner ? `${trimmed}（思路：${inner}）` : trimmed;
}

export function hasAskedQuestion(text: string, plannedQuestion: string): boolean {
  const stem = plannedQuestion.replace(/（思路：[\s\S]*$/u, "").trim();
  return text.includes(stem || plannedQuestion);
}

function openingQuestion(node: TopicModel["conceptRoute"][number] | undefined): string | undefined {
  const question = node?.openingQuestion?.trim();
  if (!question) return undefined;
  return withThinkingHint(
    question,
    node?.openingHint?.trim() || `联系一个你熟悉的场景，找出会影响判断的条件`,
  );
}

function teacherProbe(node: TopicModel["conceptRoute"][number] | undefined): string | undefined {
  return openingQuestion(node) || (node
    ? `如果把“${node.title}”用于一个你熟悉的场景，你会先检查什么？（思路：从“${node.target}”中找一个会改变判断的条件。）`
    : undefined);
}

const coreCriteria: EvidenceCriterion[] = ["accurate", "explained", "discrimination", "transfer"];
const bannedQuestionPattern = /最关键的区别|机制或作用是什么|再用一句话说明|为什么会产生这种结果|根据刚才介绍的内容/;

function requiredCriteria(model: TopicModel, activeConcept: number): EvidenceCriterion[] {
  const concept = nodeAt(model, activeConcept);
  const rubric = model.rubricAnchors.find((item) => item.conceptId === concept?.id);
  return rubric?.performance?.trim() ? [...coreCriteria, "performance"] : coreCriteria;
}

function isEvidencePurpose(purpose: QuestionPurpose | undefined): purpose is EvidenceCriterion {
  return Boolean(purpose && coreCriteria.concat("performance").includes(purpose as EvidenceCriterion));
}

/**
 * A single fluent answer must not silently become sufficient evidence for every
 * mastery dimension. The asked question owns the strong evidence. Accuracy may
 * accompany a higher-order answer, but all other incidental signals stay weak
 * until they are deliberately probed.
 */
export function constrainEvaluationEvidence(
  evidence: LearningEvidence[],
  askedPurpose: QuestionPurpose | undefined,
): LearningEvidence[] {
  const target = isEvidencePurpose(askedPurpose)
    ? askedPurpose
    : askedPurpose === "introduce"
      ? "accurate"
      : undefined;
  let grantedUntargeted = false;

  return evidence.map((item) => {
    if (item.strength !== "sufficient") return item;
    if ((item.confidence ?? 0.8) < 0.7) return { ...item, strength: "weak" };
    if (askedPurpose === "doubt-check") return { ...item, strength: "weak" };
    if (target && (item.criterion === target || (target !== "accurate" && item.criterion === "accurate"))) {
      return item;
    }
    if (!target && !grantedUntargeted) {
      grantedUntargeted = true;
      return item;
    }
    return { ...item, strength: "weak" };
  });
}

function unresolvedMisconceptions(nodeState: NodeLearningState | undefined, evaluation: TutorAnswerEvaluation) {
  const open = new Set(
    (nodeState?.misconceptions ?? [])
      .filter((item) => item.status === "open")
      .map((item) => item.description),
  );
  for (const update of evaluation.misconceptionUpdates) {
    if (update.status === "open") open.add(update.description);
    else open.delete(update.description);
  }
  if (evaluation.pedagogy.invented.trim()) open.add(evaluation.pedagogy.invented.trim());
  return [...open];
}

function selectQuestion(evaluation: TutorAnswerEvaluation, purpose: QuestionPurpose): string | undefined {
  const candidate = evaluation.questionCandidates.find((item) => item.purpose === purpose);
  const question = candidate?.text.trim();
  const hint = candidate?.thinkingHint.trim();
  if (!question || !hint || bannedQuestionPattern.test(question)) return undefined;
  return withThinkingHint(question, hint);
}

const doubtCheckQuestion = "关于这一节，你还有哪里不清楚吗？（思路：可以指出某个概念、例子或应用场景；如果都清楚，也可以直接说没有疑问。）";

function evidenceSet(nodeState: NodeLearningState | undefined, current: LearningEvidence[]) {
  return new Set(
    [...(nodeState?.evidence ?? []), ...current]
      .filter((item) => item.strength === "sufficient")
      .map((item) => item.criterion),
  );
}

type EvidenceDrivenDecisionInput = {
  model: TopicModel;
  activeConcept: number;
  nodeState?: NodeLearningState;
  evaluation: TutorAnswerEvaluation;
};

export function buildEvidenceDrivenDecision(input: EvidenceDrivenDecisionInput): TutorTurnDecision {
  const { model, activeConcept, nodeState, evaluation } = input;
  const current = nodeAt(model, activeConcept);
  const next = model.conceptRoute[activeConcept + 1];
  const acceptedEvidence = constrainEvaluationEvidence(evaluation.assessment.evidence, nodeState?.lastQuestionPurpose);
  const sufficient = evidenceSet(nodeState, acceptedEvidence);
  const required = requiredCriteria(model, activeConcept);
  const missing = required.find((criterion) => !sufficient.has(criterion));
  const openMisconceptions = unresolvedMisconceptions(nodeState, evaluation);
  const title = current?.title ?? "当前概念";
  const target = current?.target ?? model.coreOutcome;
  const directAnswer = ["direct_answer_request", "meta_question", "disagreement", "clarification"].includes(evaluation.intent);
  const base: Pick<TutorTurnDecision, "intent" | "understoodMeaning" | "evidence" | "assessment" | "misconceptionUpdates"> = {
    intent: evaluation.intent,
    understoodMeaning: evaluation.understoodMeaning,
    evidence: evaluation.observations,
    assessment: {
      ...evaluation.assessment,
      status: openMisconceptions.length
        ? "misconception"
        : missing
          ? evaluation.assessment.status === "not-answered" ? "not-answered" : "partial"
          : nodeState?.stage === "doubt-check" && evaluation.intent === "no_doubts"
            ? "mastered"
            : "partial",
      evidence: acceptedEvidence,
    },
    misconceptionUpdates: evaluation.misconceptionUpdates,
  };

  if (evaluation.intent === "stop") {
    return {
      ...base,
      nextAction: "complete",
      statePatch: {},
      responsePlan: {
        goal: "按用户要求暂停学习并保留进度",
        teachingAtom: "暂停",
        gapToRepair: "",
        keyPoints: [],
        allowedContent: ["确认已暂停"],
        forbiddenContent: ["继续提问", "继续讲解"],
      },
    };
  }

  if (evaluation.intent === "topic_switch") {
    return {
      ...base,
      nextAction: "switch-topic",
      statePatch: {},
      responsePlan: {
        goal: "确认用户要切换主题，不擅自覆盖当前学习状态",
        teachingAtom: "主题切换",
        gapToRepair: "需要建立新的学习对象",
        keyPoints: [],
        allowedContent: ["确认新主题"],
        forbiddenContent: ["继续当前节点", "假装已经建立新路线"],
      },
    };
  }

  if (nodeState?.stage === "doubt-check") {
    if (openMisconceptions.length > 0) {
      const question = selectQuestion(evaluation, "discrimination") ?? teacherProbe(current);
      return {
        ...base,
        nextAction: "repair-misconception",
        statePatch: { addMisconception: openMisconceptions[0] },
        responsePlan: {
          goal: `修复“${title}”中尚未解决的误区，再重新检查理解`,
          teachingAtom: evaluation.pedagogy.sourceMove || target,
          gapToRepair: openMisconceptions[0],
          keyPoints: [evaluation.pedagogy.sourceMove || target],
          allowedContent: [title, target, ...model.boundaryCases],
          forbiddenContent: [next ? `后续节点：${next.title}` : "新主题", "直接标记掌握"],
          question,
        },
        pedagogy: {
          ...evaluation.pedagogy,
          nextLayer: evaluation.pedagogy.sourceMove || target,
          nextQuestion: question ?? "",
          questionPurpose: "discrimination",
          restatedBiography: false,
        },
      };
    }
    if (evaluation.intent === "no_doubts" && !missing && openMisconceptions.length === 0) {
      if (next) {
        const question = openingQuestion(next) ?? teacherProbe(next);
        return {
          ...base,
          nextAction: "advance-concept",
          statePatch: { masteredConceptId: current?.id, activeConceptId: next.id },
          responsePlan: {
            goal: `确认“${title}”已掌握，并进入“${next.title}”`,
            teachingAtom: next.title,
            gapToRepair: next.target,
            keyPoints: [next.target],
            allowedContent: [title, next.title, next.target],
            forbiddenContent: ["完整课程总结", "尚未进入的后续节点"],
            question,
          },
          pedagogy: {
            hit: evaluation.pedagogy.hit,
            unpunched: "",
            invented: "",
            nextLayer: next.target,
            sourceMove: next.target,
            nextQuestion: question ?? "",
            questionPurpose: "introduce",
            restatedBiography: true,
          },
        };
      }
      return {
        ...base,
        nextAction: "complete",
        statePatch: { masteredConceptId: current?.id },
        responsePlan: {
          goal: `确认“${title}”已掌握并完成本轮学习`,
          teachingAtom: "学习总结",
          gapToRepair: "",
          keyPoints: [title],
          allowedContent: [title, model.coreOutcome],
          forbiddenContent: ["继续提出考核问题", "引入新主题"],
        },
      };
    }

    return {
      ...base,
      nextAction: "explain",
      statePatch: {},
      responsePlan: {
        goal: `回答学习者关于“${title}”的疑问，再次确认是否仍有问题`,
        teachingAtom: evaluation.pedagogy.unpunched || target,
        gapToRepair: evaluation.pedagogy.unpunched,
        keyPoints: [evaluation.pedagogy.sourceMove || target],
        allowedContent: [title, target],
        forbiddenContent: [next ? `后续节点：${next.title}` : "新主题", "把疑问回复算成新的掌握证据"],
        question: doubtCheckQuestion,
      },
      pedagogy: {
        ...evaluation.pedagogy,
        nextLayer: evaluation.pedagogy.unpunched || target,
        nextQuestion: doubtCheckQuestion,
        questionPurpose: "doubt-check",
        restatedBiography: false,
      },
    };
  }

  if (directAnswer) {
    const question = selectQuestion(evaluation, missing ?? "accurate") ?? teacherProbe(current);
    return {
      ...base,
      nextAction: "explain",
      statePatch: {},
      responsePlan: {
        goal: `直接讲清“${title}”中学习者追问的部分`,
        teachingAtom: evaluation.pedagogy.sourceMove || target,
        gapToRepair: evaluation.pedagogy.unpunched,
        keyPoints: [evaluation.pedagogy.sourceMove || target],
        allowedContent: [title, target, ...model.boundaryCases],
        forbiddenContent: [next ? `后续节点：${next.title}` : "新主题", "机械反问", "把追问算成掌握证据"],
        question,
      },
      pedagogy: {
        ...evaluation.pedagogy,
        nextLayer: evaluation.pedagogy.sourceMove || target,
        nextQuestion: question ?? "",
        questionPurpose: missing ?? "accurate",
        restatedBiography: false,
      },
    };
  }

  if (!missing && openMisconceptions.length === 0) {
    return {
      ...base,
      nextAction: "ask-clarification",
      statePatch: {},
      responsePlan: {
        goal: `完成“${title}”的疑问检查`,
        teachingAtom: "疑问检查",
        gapToRepair: "掌握证据已经齐全，只需确认没有遗留疑问",
        keyPoints: [],
        allowedContent: [title],
        forbiddenContent: [next ? `后续节点：${next.title}` : "新主题", "新的考核题", "提前标记掌握"],
        question: doubtCheckQuestion,
      },
      pedagogy: {
        ...evaluation.pedagogy,
        nextLayer: "疑问检查",
        nextQuestion: doubtCheckQuestion,
        questionPurpose: "doubt-check",
        restatedBiography: false,
      },
    };
  }

  const repairing = openMisconceptions.length > 0 || evaluation.assessment.status === "misconception";
  const purpose: QuestionPurpose = repairing
    ? "discrimination"
    : evaluation.intent === "dont_know"
      ? (isEvidencePurpose(nodeState?.lastQuestionPurpose) ? nodeState!.lastQuestionPurpose! : missing ?? "accurate")
      : missing ?? "accurate";
  const question = selectQuestion(evaluation, purpose) ?? teacherProbe(current);
  const nextAction: TutorTurnDecision["nextAction"] = repairing
    ? "repair-misconception"
    : evaluation.intent === "dont_know"
      ? "give-example"
      : purpose === "transfer" || purpose === "performance"
        ? "give-practice"
        : "ask-socratic-question";
  const gap = repairing
    ? openMisconceptions[0]
    : evaluation.pedagogy.unpunched || `缺少 ${purpose} 证据`;

  return {
    ...base,
    nextAction,
    statePatch: repairing && openMisconceptions[0] ? { addMisconception: openMisconceptions[0] } : {},
    responsePlan: {
      goal: `围绕“${title}”只补一个层次，并取得 ${purpose} 证据`,
      teachingAtom: evaluation.pedagogy.sourceMove || target,
      gapToRepair: gap,
      keyPoints: [evaluation.pedagogy.sourceMove || target],
      allowedContent: [title, target, ...model.boundaryCases],
      forbiddenContent: [
        ...(next ? [`后续节点：${next.title}`] : []),
        "完整课程讲解",
        "一次提出多个问题",
        "把语言流畅当成掌握",
      ],
      question,
    },
    pedagogy: {
      ...evaluation.pedagogy,
      nextLayer: evaluation.pedagogy.sourceMove || target,
      nextQuestion: question ?? "",
      questionPurpose: purpose,
      restatedBiography: false,
    },
  };
}

export function buildIntroDecision(model: TopicModel, firstQuestion?: string): TutorTurnDecision {
  return {
    intent: "answer",
    understoodMeaning: "用户希望系统学习当前主题",
    evidence: [{ quote: model.subject.userGoal, implication: "用户提出了明确的学习目标" }],
    assessment: { status: "not-answered", rubricEvidence: [], evidence: [] },
    nextAction: "ask-socratic-question",
    statePatch: {},
    responsePlan: {
      goal: `用一两句话说明接下来要摸底，然后立刻提出第一道诊断题`,
      teachingAtom: "诊断开场",
      gapToRepair: "尚无学习者起点证据",
      keyPoints: ["用一两句话说明接下来要摸底，立刻提出第一道诊断题"],
      allowedContent: ["第一道诊断问题"],
      forbiddenContent: ["完整课程讲解", "替学习者做诊断结论", "诊断题的答案或定义", "核心结论"],
      question: firstQuestion,
    },
    pedagogy: {
      hit: "",
      unpunched: "",
      invented: "",
      nextLayer: "摸清起点",
      sourceMove: "",
      nextQuestion: firstQuestion ?? "",
      questionPurpose: "introduce",
      restatedBiography: false,
    },
    thinking: `本轮是诊断开场。主题模型已生成，编排器直接出第一张诊断卡，没有对学习者回答做教学诊断。`,
  };
}

export function buildFirstTeachingDecision(model: TopicModel, diagnosisSummary: string, startIndex = 0): TutorTurnDecision {
  const first = nodeAt(model, startIndex);
  const next = nextTitle(model, startIndex);
  const title = first?.title ?? "第一个节点";
  const target = first?.target ?? "尚未获得当前节点的学习证据";
  const question = openingQuestion(first) ?? teacherProbe(first);
  return {
    intent: "answer",
    understoodMeaning: "用户已完成诊断，可以从第一个学习节点开始",
    evidence: [{ quote: diagnosisSummary, implication: "诊断已完成并形成学习起点，已知直觉应加快、不要从头问定义" }],
    assessment: { status: "not-answered", rubricEvidence: [], evidence: [] },
    nextAction: "ask-socratic-question",
    statePatch: {},
    responsePlan: {
      goal: `先用一段可独立理解的摘要建立主题全景，再开始学习“${title}”`,
      teachingAtom: `主题背景与${title}`,
      gapToRepair: target,
      keyPoints: first ? [model.backgroundBrief, target] : [model.backgroundBrief, model.coreOutcome],
      allowedContent: first ? [model.backgroundBrief, first.title, target] : [model.backgroundBrief, model.coreOutcome],
      forbiddenContent: next
        ? [`后续节点：${next}`, "完整课程讲解", "课堂摘要题", "最关键的区别、机制或作用"]
        : ["完整课程讲解", "课堂摘要题", "最关键的区别、机制或作用"],
      backgroundBrief: model.backgroundBrief,
      question,
    },
    pedagogy: {
      hit: diagnosisSummary,
      unpunched: "",
      invented: "",
      nextLayer: target,
      sourceMove: target,
      nextQuestion: question ?? "",
      questionPurpose: "introduce",
      restatedBiography: true,
    },
    thinking: `诊断已完成。编排器把首轮教学锚定到「${title}」，这一轮还没有学习者对本节点的口头回答，所以没有拆词诊断。`,
  };
}

export function buildFallbackTurnDecision(message: string, model: TopicModel, activeConcept: number): TutorTurnDecision {
  const current = nodeAt(model, activeConcept);
  const next = nextTitle(model, activeConcept);
  const title = current?.title ?? "当前概念";
  const target = current?.target ?? model.coreOutcome;
  const quote = message.trim() || "（空回答）";
  const question = teacherProbe(current);
  return {
    intent: "answer",
    understoodMeaning: "决策器不可用，但要带着原话继续教：肯定能用的半句，补当前节点缺的一层，问一个新问题",
    evidence: [{ quote, implication: "原话仍可继续使用，不能因为决策失败就丢掉" }],
    assessment: {
      status: "insufficient",
      rubricEvidence: [],
      evidence: [{ learnerQuote: quote, criterion: "explained", strength: "weak" }],
    },
    nextAction: "ask-socratic-question",
    statePatch: {},
    responsePlan: {
      goal: `带着原话继续教“${title}”：肯定可用的半句，补一层，问新问题`,
      teachingAtom: title,
      gapToRepair: "决策器不可用，但仍应根据原话继续教学",
      keyPoints: [target],
      allowedContent: [title, target],
      forbiddenContent: next
        ? [`后续节点：${next}`, "完整课程讲解", "请学习者复述刚才的机制", "再用一句话说明"]
        : ["完整课程讲解", "请学习者复述刚才的机制", "再用一句话说明"],
      question,
    },
    pedagogy: {
      hit: quote,
      unpunched: "",
      invented: "",
      nextLayer: target,
      sourceMove: target,
      nextQuestion: question ?? "",
      questionPurpose: "explained",
      restatedBiography: false,
    },
    thinking: `教学决策失败。带着原话继续教，不要求复述。原话：${quote}`,
  };
}
