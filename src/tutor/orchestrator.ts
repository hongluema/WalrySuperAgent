import { randomUUID } from "node:crypto";
import type { DiagnosticCard, TopicModel, TutorEvent, TutorState, TutorTurnDecision, VisibleReasoningTrace } from "./types.js";
import { ensureTopicModelDefaults, isDirectHelpRequest, isSystematicLearningIntent, topicModelFromUnknownTopic } from "./topic-model.js";
import { TutorStore } from "./store.js";
import type { TutorModelClient } from "./model-client.js";
import { buildEvidenceDrivenDecision, buildFallbackTurnDecision, buildFirstTeachingDecision, buildIntroDecision, hasAskedQuestion, nodeProgress, questionAlreadyAsked, withThinkingHint } from "./pedagogy.js";
import { pickSearchTool } from "../tools/web-search.js";
import { truncateResult } from "../tools/registry.js";

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
  return model.diagnosticDimensions.map((dimension, index) => ({
    ...dimension,
    question: withThinkingHint(dimension.question, dimension.thinkingHint),
    index,
    total: model.diagnosticDimensions.length,
  }));
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

function makeTrace(state: TutorState, decision: TutorTurnDecision, thinking: string): VisibleReasoningTrace {
  const observedEvidence = decision.assessment.evidence.map((item) => (
    `${item.learnerQuote} -> ${item.criterion}/${item.strength}`
  ));
  const traceText = thinking.trim() || [
    ...decision.evidence.map((item) => `${item.quote}：${item.implication}`),
    ...observedEvidence,
    `选择动作：${decision.nextAction}`,
    `本轮目标：${decision.responsePlan.goal}`,
  ].join("\n");
  return {
    phase: state.phase,
    rawThinking: traceText,
    selectedAction: decision.nextAction,
    currentGoal: decision.responsePlan.goal,
    observedEvidence,
    actionReason: decision.responsePlan.gapToRepair,
  };
}

async function emitThinking(emit: (event: TutorEvent) => Promise<void> | void, text: string) {
  await emit({ type: "reasoning.delta", text: text.endsWith("\n") ? text : `${text}\n` });
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
    knownIntuitions: [],
    nodeLearningStates: {},
    updatedAt: new Date().toISOString(),
  };
}

export class TutorOrchestrator {
  constructor(
    private readonly store = new TutorStore(),
    private readonly modelClient?: TutorModelClient,
    private readonly search = async (query: string) => {
      const tool = pickSearchTool();
      const result = await tool.execute({ query, max_results: 5 });
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return truncateResult(text, tool.maxResultChars);
    },
  ) {}

  async hasActiveSession(conversationId: string): Promise<boolean> {
    const state = await this.store.load(conversationId);
    return Boolean(state && state.phase !== "idle");
  }

  isTutorIntent(message: string): boolean {
    return isSystematicLearningIntent(message);
  }

  private async decide(message: string, state: TutorState, topicModel: TopicModel, emit: (event: TutorEvent) => Promise<void> | void, signal?: AbortSignal) {
    const activeConcept = topicModel.conceptRoute[state.activeConcept] ?? topicModel.conceptRoute[0];
    const nodeState = activeConcept ? state.nodeLearningStates[activeConcept.id] : undefined;
    try {
      await emitThinking(emit, "正在根据你的回答做教学判断…");
      const evaluation = await this.modelClient!.evaluateAnswer({ message, state, topicModel }, signal);
      const decision = buildEvidenceDrivenDecision({
        model: topicModel,
        activeConcept: state.activeConcept,
        nodeState,
        evaluation,
      });
      decision.thinking = makeTrace(state, decision, "").rawThinking;
      await emit({ type: "reasoning.delta", text: decision.thinking });
      return decision;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "模型决策失败";
      console.error("[Tutor] 教学决策降级", error);
      await emit({ type: "model.degraded", stage: "decision", reason });
      const fallback = buildFallbackTurnDecision(message, topicModel, state.activeConcept, nodeState?.questionsAsked ?? []);
      fallback.thinking = `教学评估失败：${reason}。带着原话继续教，不要求复述，也不推进掌握状态。`;
      await emit({ type: "reasoning.delta", text: fallback.thinking });
      return fallback;
    }
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
      state.knownIntuitions ??= [];
      state.nodeLearningStates ??= {};
    }

    try {
      state.messages.push({ role: "user", content: message });
      let topicModel = state.topicModel ? ensureTopicModelDefaults(state.topicModel) : undefined;

      const isNewTopic = !topicModel;

      if (isNewTopic) {
        await emit({ type: "tutor.phase.changed", phase: "research", label: phaseLabels.research });
        await emitThinking(emit, "正在检索主题相关资料…");
        let researchMaterial: string | undefined;
        const researchQuery = `${message} 背景 核心内容 结构`;
        try {
          const result = await this.search(researchQuery);
          const text = typeof result === "string" ? result.trim() : JSON.stringify(result);
          if (text && !text.startsWith("[web_search]") && text !== "没有找到相关结果") {
            researchMaterial = text;
          } else {
            await emit({ type: "grounding.degraded", reason: text || "搜索没有返回可用内容" });
          }
        } catch (error) {
          await emit({ type: "grounding.degraded", reason: error instanceof Error ? error.message : "搜索失败" });
        }
        await emitThinking(emit, researchMaterial
          ? "已找到参考资料，正在生成主题模型和诊断题…"
          : "未取到检索结果，正在用已有知识生成主题模型和诊断题…");
        topicModel = ensureTopicModelDefaults(await this.modelClient.buildTopicModel({
          userGoal: message,
          history: state.messages,
          materials: researchMaterial ? [researchMaterial] : [],
        }, signal));
        if (researchMaterial) {
          const urls = [...new Set(researchMaterial.match(/https?:\/\/\S+/g) ?? [])];
          topicModel.grounding = {
            mode: "web-search",
            sources: (urls.length ? urls : [researchQuery]).map((label) => ({ label, verified: true })),
            limitations: [],
          };
          topicModel.evidenceSources = topicModel.grounding.sources.map((source) => source.label);
        } else {
          topicModel.grounding = {
            mode: "model-knowledge",
            sources: [],
            limitations: ["真实搜索未取得可用内容，本次课程使用模型已有知识，可能不完整"],
          };
          topicModel.evidenceSources = [];
        }
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
        if (researchMaterial && verifiedSourceCount > 0) await emit({ type: "research.completed", sourceCount: verifiedSourceCount, researchedAt: new Date().toISOString() });
        await emit({ type: "topic.model.ready", title: topicModel.lessonTitle, outcome: topicModel.coreOutcome, topic: topicModel.topic });

        if (isDirectHelpRequest(message)) {
          state.phase = "teach";
          await emit({ type: "tutor.phase.changed", phase: "teach", label: phaseLabels.teach });
          const decision = await this.decide(message, state, topicModel, emit, signal);
          state.lastDecision = decision;
          this.applyStatePatch(state, topicModel, decision);
          await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, decision, decision.thinking ?? "") });
          const responseText = await this.streamResponse(state, topicModel, decision, message, emit, signal);
          this.recordQuestion(state, topicModel, decision, responseText);
          await this.persist(state, runId, emit);
          await emit({ type: "run.completed", runId });
          return;
        }

        state.phase = "diagnose";
        await emit({ type: "tutor.phase.changed", phase: "diagnose", label: phaseLabels.diagnose });
        await emit({ type: "diagnostic.cards.ready", cards: state.diagnosticCards });
        await emit({ type: "diagnostic.card.ready", card: state.diagnosticCards[0] });
        const introDecision = buildIntroDecision(topicModel, state.diagnosticCards[0]?.question);
        const introTrace = makeTrace(state, introDecision, introDecision.thinking ?? "");
        await emitThinking(emit, introTrace.rawThinking);
        await emit({ type: "reasoning.trace.ready", trace: introTrace });
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
        await emit({ type: "tutor.phase.changed", phase: "plan", label: phaseLabels.plan });
        await emitThinking(emit, "正在根据摸底答案整理诊断结果和学习路线…");
        const diagnosis = await this.modelClient.compileDiagnosis({
          state,
          topicModel,
          answeredDiagnostics: answeredDiagnostics(state),
        }, signal);

        const decision = buildFirstTeachingDecision(topicModel, diagnosis.summary, state.activeConcept);
        state.learnerProfile = diagnosis.learnerProfile;
        state.teachingApproach = diagnosis.teachingApproach;
        state.knownIntuitions = diagnosis.skipSuggestions ?? [];
        state.lastDecision = decision;
        await emit({
          type: "diagnosis.ready",
          diagnosis: diagnosis.summary,
          background: diagnosis.learnerProfile,
          teachingApproach: diagnosis.teachingApproach,
        });
        await emit({ type: "topic.background.ready", summary: topicModel.backgroundBrief });
        await emit({ type: "roadmap.ready", roadmap: state.roadmap });
        state.phase = "teach";
        await emit({ type: "tutor.phase.changed", phase: "teach", label: phaseLabels.teach });
        const teachingTrace = makeTrace(state, decision, decision.thinking ?? "");
        await emitThinking(emit, teachingTrace.rawThinking);
        await emit({ type: "reasoning.trace.ready", trace: teachingTrace });
        const responseText = await this.streamResponse(state, topicModel, decision, message, emit, signal);
        this.recordQuestion(state, topicModel, decision, responseText);
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      state.turnCount += 1;
      const taughtIndex = state.activeConcept;
      const decision = await this.decide(message, state, topicModel, emit, signal);
      state.lastDecision = decision;
      this.applyStatePatch(state, topicModel, decision);
      await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, decision, decision.thinking ?? "") });
      const scoredIndex = decision.statePatch.masteredConceptId
        ? topicModel.conceptRoute.findIndex((item) => item.id === decision.statePatch.masteredConceptId)
        : taughtIndex;
      const scoredNode = topicModel.conceptRoute[scoredIndex >= 0 ? scoredIndex : taughtIndex];
      const progress = nodeProgress(
        topicModel,
        scoredIndex >= 0 ? scoredIndex : taughtIndex,
        scoredNode ? state.nodeLearningStates[scoredNode.id] : undefined,
      );
      await emit({ type: "assessment.updated", score: progress.score, status: progress.status });
      const responseText = await this.streamResponse(state, topicModel, decision, message, emit, signal);
      this.recordQuestion(state, topicModel, decision, responseText);
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
        hintLevel: 0 as const,
      };
      for (const evidence of decision.assessment.evidence) {
        const duplicate = nodeState.evidence.some((item) => (
          item.learnerQuote === evidence.learnerQuote
          && item.criterion === evidence.criterion
          && item.strength === evidence.strength
        ));
        if (!duplicate) nodeState.evidence.push(evidence);
      }
      for (const update of decision.misconceptionUpdates ?? []) {
        const existing = nodeState.misconceptions.find((item) => item.description === update.description);
        if (existing) {
          existing.status = update.status;
          existing.evidenceQuote = update.evidenceQuote;
        } else if (update.status === "open") {
          nodeState.misconceptions.push(update);
        }
      }
      const invented = decision.pedagogy?.invented?.trim();
      if (invented && !decision.statePatch.addMisconception) {
        decision.statePatch.addMisconception = invented;
      }
      if (decision.statePatch.addMisconception) {
        const existing = nodeState.misconceptions.find((item) => item.description === decision.statePatch.addMisconception);
        if (existing) existing.status = "open";
        else nodeState.misconceptions.push({ description: decision.statePatch.addMisconception, status: "open" });
        nodeState.stage = "repair";
      }
      if (decision.intent === "dont_know") {
        nodeState.hintLevel = Math.min(4, (nodeState.hintLevel ?? 0) + 1) as 0 | 1 | 2 | 3 | 4;
      }
      if (decision.pedagogy?.questionPurpose === "doubt-check") nodeState.stage = "doubt-check";
      else if (decision.nextAction === "give-practice") {
        nodeState.stage = decision.pedagogy?.questionPurpose === "transfer" ? "transfer" : "practice";
      } else if (decision.nextAction === "ask-socratic-question" && nodeState.stage !== "repair") {
        nodeState.stage = "elicit";
      }
      state.nodeLearningStates[current.id] = nodeState;
    }
    let masteryAccepted = !decision.statePatch.masteredConceptId;
    if (decision.statePatch.masteredConceptId) {
      const index = model.conceptRoute.findIndex((item) => item.id === decision.statePatch.masteredConceptId);
      const nodeState = index >= 0 ? state.nodeLearningStates[decision.statePatch.masteredConceptId] : undefined;
      const sufficient = new Set(nodeState?.evidence.filter((item) => item.strength === "sufficient").map((item) => item.criterion));
      const rubric = model.rubricAnchors.find((item) => item.conceptId === decision.statePatch.masteredConceptId);
      const required = ["accurate", "explained", "discrimination", "transfer", ...(rubric?.performance?.trim() ? ["performance"] : [])];
      const hasRequiredEvidence = required.every((criterion) => sufficient.has(criterion as any));
      const hasOpenMisconception = nodeState?.misconceptions.some((item) => item.status === "open") ?? false;
      if (index >= 0 && state.roadmap[index] && hasRequiredEvidence && !hasOpenMisconception && nodeState?.stage === "doubt-check") {
        state.roadmap[index].status = "mastered";
        if (nodeState) nodeState.stage = "mastered";
        masteryAccepted = true;
      }
    }
    if (decision.statePatch.activeConceptId && masteryAccepted) {
      const index = model.conceptRoute.findIndex((item) => item.id === decision.statePatch.activeConceptId);
      if (index >= 0) {
        state.activeConcept = index;
        if (state.roadmap[index]?.status === "locked") state.roadmap[index].status = "active";
      }
    }
    if (state.roadmap.length > 0 && state.roadmap.every((item) => item.status === "mastered")) {
      state.phase = "complete";
    }
  }

  private recordQuestion(state: TutorState, model: TopicModel, decision: TutorTurnDecision, responseText: string) {
    const question = decision.responsePlan.question
      || decision.pedagogy?.nextQuestion
      || responseText.match(/[^。！？\n]*(?:[？?])(?=\s*$)/u)?.[0]?.trim();
    if (!question || !decision.pedagogy?.questionPurpose) return;
    const current = model.conceptRoute[state.activeConcept] ?? model.conceptRoute[0];
    if (!current) return;
    const nodeState = state.nodeLearningStates[current.id] ?? {
      nodeId: current.id,
      stage: "introduce" as const,
      evidence: [],
      misconceptions: [],
      questionsAsked: [],
      hintLevel: 0 as const,
    };
    if (!nodeState.questionsAsked.includes(question)) nodeState.questionsAsked.push(question);
    nodeState.lastQuestionPurpose = decision.pedagogy.questionPurpose === "introduce"
      ? "accurate"
      : decision.pedagogy.questionPurpose;
    state.nodeLearningStates[current.id] = nodeState;
  }

  private async streamResponse(state: TutorState, model: TopicModel, decision: TutorTurnDecision, message: string, emit: (event: TutorEvent) => Promise<void> | void, signal?: AbortSignal): Promise<string> {
    if (!this.modelClient) throw new Error("Tutor 模型客户端未配置");
    await emitThinking(emit, "正在组织回复…");
    let text = "";
    try {
      await this.modelClient.streamResponse({ message, state, topicModel: model, decision }, async (delta) => {
        if (signal?.aborted) throw new Error("请求已取消");
        text += delta;
        await emit({ type: "message.delta", text: delta });
      }, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : "模型回答失败";
      console.error("[Tutor] 教学回答降级", error);
      await emit({ type: "model.degraded", stage: "response", reason });
      const fallback = text
        ? "\n\n这次回答没有完整生成，你的学习进度已保留。请再发送一次，我会从当前节点继续。"
        : "我已收到你的回答，但这次讲解没有成功生成。你的学习进度已保留，请再发送一次，我会从当前节点继续。";
      text += fallback;
      await emit({ type: "message.delta", text: fallback });
    }
    const plannedQuestion = decision.responsePlan.question || decision.pedagogy?.nextQuestion;
    const current = model.conceptRoute[state.activeConcept] ?? model.conceptRoute[0];
    const asked = current ? state.nodeLearningStates[current.id]?.questionsAsked ?? [] : [];
    if (plannedQuestion && !hasAskedQuestion(text, plannedQuestion) && !questionAlreadyAsked(asked, plannedQuestion)) {
      const questionSuffix = `${text.trim() ? "\n\n" : ""}${plannedQuestion}`;
      text += questionSuffix;
      await emit({ type: "message.delta", text: questionSuffix });
    }
    if (text) state.messages.push({ role: "assistant", content: text });
    return text;
  }

  private async persist(state: TutorState, runId: string, emit: (event: TutorEvent) => Promise<void> | void) {
    state.updatedAt = new Date().toISOString();
    await this.store.save(state, { type: "state.saved", runId, phase: state.phase, activeConcept: state.activeConcept });
    await emit({ type: "state.saved", phase: state.phase, activeConcept: state.activeConcept });
  }
}

export { topicModelFromUnknownTopic };
