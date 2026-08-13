import type { TopicModel, TutorTurnDecision } from "./types.js";

function nodeAt(model: TopicModel, index: number) {
  return model.conceptRoute[index] ?? model.conceptRoute[0];
}

function nextTitle(model: TopicModel, index: number) {
  return model.conceptRoute[index + 1]?.title;
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
  return {
    intent: "answer",
    understoodMeaning: "用户已完成诊断，可以从第一个学习节点开始",
    evidence: [{ quote: diagnosisSummary, implication: "诊断已完成并形成学习起点，已知直觉应加快、不要从头问定义" }],
    assessment: { status: "not-answered", rubricEvidence: [], evidence: [] },
    nextAction: "explain",
    statePatch: {},
    responsePlan: {
      goal: `开始学习“${title}”：先讲不可推导的事实，再问一个对比或机制问题`,
      teachingAtom: title,
      gapToRepair: target,
      keyPoints: first ? [target] : [model.coreOutcome],
      allowedContent: first ? [first.title, target] : [model.coreOutcome],
      forbiddenContent: next
        ? [`后续节点：${next}`, "完整课程讲解", "课堂摘要题", "最关键的区别、机制或作用"]
        : ["完整课程讲解", "课堂摘要题", "最关键的区别、机制或作用"],
    },
    pedagogy: {
      hit: diagnosisSummary,
      unpunched: "",
      invented: "",
      nextLayer: target,
      sourceMove: target,
      nextQuestion: "",
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
    },
    pedagogy: {
      hit: quote,
      unpunched: "",
      invented: "",
      nextLayer: target,
      sourceMove: target,
      nextQuestion: "",
      questionPurpose: "explained",
      restatedBiography: false,
    },
    thinking: `教学决策失败。带着原话继续教，不要求复述。原话：${quote}`,
  };
}
