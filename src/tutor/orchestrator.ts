import { randomUUID } from "node:crypto";
import type { DiagnosticCard, TopicModel, TutorEvent, TutorState, TutorTurnDecision, VisibleReasoningTrace } from "./types.js";
import { ensureTopicModelDefaults, isDirectHelpRequest, isSystematicLearningIntent, topicModelFromUnknownTopic } from "./topic-model.js";
import { TutorStore } from "./store.js";
import type { TutorModelClient } from "./model-client.js";

const phaseLabels = {
  research: "正在建立学习对象与能力模型",
  diagnose: "正在进行诊断",
  plan: "正在整理学习路线",
  teach: "正在进行一对一练习",
  complete: "本轮学习已完成",
  idle: "准备开始",
};

type RunOptions = { diagnosticAnswers?: Record<string, string> };

function cardsFor(model: TopicModel): DiagnosticCard[] {
  return model.diagnosticDimensions.map((dimension, index) => ({ ...dimension, index, total: model.diagnosticDimensions.length }));
}

function answerLetter(input: string): string {
  const match = input.trim().toUpperCase().match(/\b([ABCD])\b|^([ABCD])/);
  return match?.[1] ?? match?.[2] ?? "";
}

function makeRoadmap(model: TopicModel) {
  return model.conceptRoute.map((node, index) => ({ ...node, status: index === 0 ? "active" as const : "locked" as const }));
}

function answeredDiagnostics(state: TutorState) {
  return state.diagnosticCards.flatMap((card) => {
    const optionId = state.diagnosticAnswers[card.id];
    const option = card.options.find((item) => item.id === optionId);
    return option ? [{ id: card.id, question: card.question, optionId, optionLabel: option.label }] : [];
  });
}

function firstTeachingDecision(model: TopicModel, diagnosisSummary: string): TutorTurnDecision {
  const first = model.conceptRoute[0];
  const next = model.conceptRoute[1];
  return {
    intent: "answer",
    understoodMeaning: "用户已完成诊断，可以从第一个学习节点开始",
    evidence: [{ quote: diagnosisSummary, implication: "诊断已完成并形成学习起点" }],
    assessment: { status: "not-answered", rubricEvidence: [], evidence: [] },
    nextAction: "explain",
    statePatch: {},
    responsePlan: {
      goal: `开始学习“${first?.title ?? "第一个节点"}”`,
      teachingAtom: first?.title ?? "第一个节点",
      gapToRepair: first?.target ?? "尚未获得当前节点的学习证据",
      keyPoints: first ? [first.target] : [model.coreOutcome],
      allowedContent: [first?.title ?? "当前节点", first?.target ?? model.coreOutcome],
      forbiddenContent: next ? [`后续节点：${next.title}`, "完整课程讲解"] : ["完整课程讲解"],
      question: first ? `结合你的理解，你认为“${first.title}”最关键的区别或机制是什么？` : "你目前对这个主题的理解是什么？",
    },
  };
}

function makeTrace(state: TutorState, model: TopicModel, decision: TutorTurnDecision, evidence: string[]): VisibleReasoningTrace {
  const current = model.conceptRoute[state.activeConcept] ?? model.conceptRoute[0];
  return {
    phase: state.phase,
    currentGoal: decision.responsePlan.goal,
    inputsUsed: ["当前用户消息", "会话历史", "动态 TopicModel", "当前概念 rubric", "LearnerProfile（如有）"],
    observedEvidence: evidence,
    candidateInterpretations: [{ interpretation: decision.understoodMeaning, supportingEvidence: decision.evidence.map((item) => item.implication) }],
    rejectedInterpretations: [],
    selectedInterpretation: decision.understoodMeaning,
    policyChecks: ["先理解用户意图，再选择教学动作", "不展示隐藏推理文本", "只有可观察证据才能推进掌握状态"],
    selectedAction: decision.nextAction,
    actionReason: decision.responsePlan.goal,
    stateUpdates: [`当前阶段：${state.phase}`, `当前路线节点：${current?.title ?? "动态主题模型尚未建立"}`],
    sourceCount: model.grounding.sources.filter((source) => source.verified).length,
  };
}

function emptyState(conversationId: string): TutorState {
  return {
    schemaVersion: 4,
    conversationId,
    phase: "idle",
    diagnosticCards: [],
    diagnosticAnswers: {},
    currentCard: 0,
    roadmap: [],
    activeConcept: 0,
    turnCount: 0,
    messages: [],
    learnerProfile: [],
    nodeLearningStates: {},
    updatedAt: new Date().toISOString(),
  };
}

export class TutorOrchestrator {
  constructor(
    private readonly store = new TutorStore(),
    private readonly modelClient?: TutorModelClient,
  ) {}

  async hasActiveSession(conversationId: string): Promise<boolean> {
    const state = await this.store.load(conversationId);
    return Boolean(state && state.phase !== "idle");
  }

  isTutorIntent(message: string): boolean {
    return isSystematicLearningIntent(message);
  }

  async run(
    conversationId: string,
    message: string,
    emit: (event: TutorEvent) => Promise<void> | void,
    signal?: AbortSignal,
    options: RunOptions = {},
  ) {
    if (!this.modelClient) throw new Error("Tutor 模型客户端未配置，无法进行动态主题建模");

    const runId = `run_${randomUUID().slice(0, 8)}`;
    await emit({ type: "run.started", runId, conversationId });
    let state = await this.store.load(conversationId);
    if (!state) state = emptyState(conversationId);
    else {
      state.schemaVersion = 4;
      state.learnerProfile ??= [];
      state.nodeLearningStates ??= {};
    }

    try {
      state.messages.push({ role: "user", content: message });
      let topicModel = state.topicModel ? ensureTopicModelDefaults(state.topicModel) : undefined;

      const isNewTopic = !topicModel || (
        state.phase !== "idle" &&
        isSystematicLearningIntent(message) &&
        !isDirectHelpRequest(message) &&
        !Object.keys(options.diagnosticAnswers ?? {}).length
      );

      if (isNewTopic) {
        await emit({ type: "tutor.phase.changed", phase: "research", label: phaseLabels.research });
        topicModel = ensureTopicModelDefaults(await this.modelClient.buildTopicModel({ userGoal: message, history: state.messages }, signal));
        state.topicModel = topicModel;
        state.topic = topicModel.topic;
        state.lessonTitle = topicModel.lessonTitle;
        state.diagnosticCards = cardsFor(topicModel);
        state.roadmap = makeRoadmap(topicModel);
        state.diagnosticAnswers = {};
        state.currentCard = 0;
        state.activeConcept = 0;
        state.phase = "research";
        const verifiedSourceCount = topicModel.grounding.sources.filter((source) => source.verified).length;
        if (verifiedSourceCount > 0) await emit({ type: "research.completed", sourceCount: verifiedSourceCount, researchedAt: new Date().toISOString() });
        await emit({ type: "topic.model.ready", title: topicModel.lessonTitle, outcome: topicModel.coreOutcome, topic: topicModel.topic });

        if (isDirectHelpRequest(message)) {
          state.phase = "teach";
          await emit({ type: "tutor.phase.changed", phase: "teach", label: phaseLabels.teach });
          const decision = await this.modelClient.analyzeTurn({ message, state, topicModel }, signal);
          state.lastDecision = decision;
          await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, topicModel, decision, ["用户明确要求直接回答", `动态主题：${topicModel.lessonTitle}`]) });
          await this.streamResponse(state, topicModel, decision, message, emit, signal);
          await this.persist(state, runId, emit);
          await emit({ type: "run.completed", runId });
          return;
        }

        state.phase = "diagnose";
        await emit({ type: "tutor.phase.changed", phase: "diagnose", label: phaseLabels.diagnose });
        await emit({ type: "diagnostic.cards.ready", cards: state.diagnosticCards });
        await emit({ type: "diagnostic.card.ready", card: state.diagnosticCards[0] });
        const introDecision: TutorTurnDecision = {
          intent: "answer",
          understoodMeaning: "用户希望系统学习当前主题",
          evidence: [{ quote: message, implication: "用户提出了明确的学习目标" }],
          assessment: { status: "not-answered", rubricEvidence: [], evidence: [] },
          nextAction: "ask-socratic-question",
          statePatch: {},
          responsePlan: {
            goal: `建立“${topicModel.lessonTitle}”的初始学习地图，并收集当前经验`,
            teachingAtom: "说明学习目标并收集第一份起点证据",
            gapToRepair: "尚无学习者起点证据",
            keyPoints: [topicModel.coreOutcome],
            allowedContent: ["学习目标", "第一道诊断问题"],
            forbiddenContent: ["完整课程讲解", "替学习者做诊断结论"],
            question: state.diagnosticCards[0]?.question,
          },
        };
        await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, topicModel, introDecision, ["主题模型已生成", "诊断卡已生成"]) });
        await this.streamResponse(state, topicModel, introDecision, message, emit, signal);
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      if (!topicModel) throw new Error("当前会话缺少动态 TopicModel");

      if (state.phase === "diagnose") {
        const answers = options.diagnosticAnswers ?? {};
        const answer = answerLetter(message);
        const card = state.diagnosticCards[state.currentCard];
        if (Object.keys(answers).length) {
          state.diagnosticAnswers = { ...state.diagnosticAnswers, ...answers };
          state.currentCard = state.diagnosticCards.length - 1;
        }
        else if (answer && card) state.diagnosticAnswers[card.id] = answer;

        if (Object.keys(state.diagnosticAnswers).length < state.diagnosticCards.length) {
          if (state.currentCard < state.diagnosticCards.length - 1) state.currentCard += 1;
          await emit({ type: "diagnostic.card.ready", card: state.diagnosticCards[state.currentCard] });
          await this.persist(state, runId, emit);
          await emit({ type: "run.completed", runId });
          return;
        }

        state.phase = "plan";
        const diagnosis = await this.modelClient.compileDiagnosis({
          state,
          topicModel,
          answeredDiagnostics: answeredDiagnostics(state),
        }, signal);
        const decision = firstTeachingDecision(topicModel, diagnosis.summary);
        state.learnerProfile = diagnosis.learnerProfile;
        state.lastDecision = decision;
        await emit({ type: "diagnosis.ready", diagnosis: diagnosis.summary, background: diagnosis.learnerProfile });
        await emit({ type: "roadmap.ready", roadmap: state.roadmap });
        state.phase = "teach";
        await emit({ type: "tutor.phase.changed", phase: "teach", label: phaseLabels.teach });
        await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, topicModel, decision, decision.evidence.map((item) => item.implication)) });
        await this.streamResponse(state, topicModel, decision, message, emit, signal);
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      state.turnCount += 1;
      const decision = await this.modelClient.analyzeTurn({ message, state, topicModel }, signal);
      state.lastDecision = decision;
      this.applyStatePatch(state, topicModel, decision);
      await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, topicModel, decision, decision.evidence.map((item) => `${item.quote}：${item.implication}`)) });
      if (decision.assessment.score !== undefined) {
        await emit({ type: "assessment.updated", score: decision.assessment.score, status: decision.assessment.status === "mastered" ? "mastered" : "in-progress" });
      }
      await this.streamResponse(state, topicModel, decision, message, emit, signal);
      await this.persist(state, runId, emit);
      await emit({ type: "run.completed", runId });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Tutor 运行失败";
      await emit({ type: "run.failed", runId, message: messageText });
      throw error;
    }
  }

  private applyStatePatch(state: TutorState, model: TopicModel, decision: TutorTurnDecision) {
    const current = model.conceptRoute[state.activeConcept] ?? model.conceptRoute[0];
    if (current) {
      const nodeState = state.nodeLearningStates[current.id] ?? {
        nodeId: current.id,
        stage: "elicit" as const,
        evidence: [],
        misconceptions: [],
        questionsAsked: [],
      };
      nodeState.evidence.push(...decision.assessment.evidence);
      if (decision.responsePlan.question && !nodeState.questionsAsked.includes(decision.responsePlan.question)) {
        nodeState.questionsAsked.push(decision.responsePlan.question);
      }
      if (decision.statePatch.addMisconception) {
        nodeState.misconceptions.push({ description: decision.statePatch.addMisconception, status: "open" });
        nodeState.stage = "repair";
      }
      state.nodeLearningStates[current.id] = nodeState;
    }
    if (decision.statePatch.activeConceptId) {
      const index = model.conceptRoute.findIndex((item) => item.id === decision.statePatch.activeConceptId);
      if (index >= 0) state.activeConcept = index;
    }
    if (decision.statePatch.masteredConceptId) {
      const index = model.conceptRoute.findIndex((item) => item.id === decision.statePatch.masteredConceptId);
      const nodeState = index >= 0 ? state.nodeLearningStates[decision.statePatch.masteredConceptId] : undefined;
      const sufficient = new Set(nodeState?.evidence.filter((item) => item.strength === "sufficient").map((item) => item.criterion));
      const hasCoreEvidence = ["accurate", "explained", "discrimination", "transfer"].every((criterion) => sufficient.has(criterion as any));
      if (index >= 0 && state.roadmap[index] && hasCoreEvidence) {
        state.roadmap[index].status = "mastered";
        if (nodeState) nodeState.stage = "mastered";
      }
    }
  }

  private async streamResponse(state: TutorState, model: TopicModel, decision: TutorTurnDecision, message: string, emit: (event: TutorEvent) => Promise<void> | void, signal?: AbortSignal) {
    if (!this.modelClient) throw new Error("Tutor 模型客户端未配置");
    let text = "";
    await this.modelClient.streamResponse({ message, state, topicModel: model, decision }, async (delta) => {
      if (signal?.aborted) throw new Error("请求已取消");
      text += delta;
      await emit({ type: "message.delta", text: delta });
    }, signal);
    if (text) state.messages.push({ role: "assistant", content: text });
  }

  private async persist(state: TutorState, runId: string, emit: (event: TutorEvent) => Promise<void> | void) {
    state.updatedAt = new Date().toISOString();
    await this.store.save(state, { type: "state.saved", runId, phase: state.phase, activeConcept: state.activeConcept });
    await emit({ type: "state.saved", phase: state.phase, activeConcept: state.activeConcept });
  }
}

export { topicModelFromUnknownTopic };
