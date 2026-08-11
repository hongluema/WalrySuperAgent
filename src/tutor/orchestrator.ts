import { randomUUID } from "node:crypto";
import type { DiagnosticCard, TopicModel, TutorEvent, TutorState, VisibleReasoningTrace } from "./types.js";
import { buildTopicModel, isDirectHelpRequest, isSystematicLearningIntent, universalTutorProfile } from "./topic-model.js";
import { TutorStore } from "./store.js";

const phaseLabels = {
  research: "正在阅读资料并建立主题模型",
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
    index,
    total: model.diagnosticDimensions.length,
  }));
}

function answerLetter(input: string): string {
  const match = input.trim().toUpperCase().match(/\b([ABCD])\b|^([ABCD])/);
  return match?.[1] ?? match?.[2] ?? "";
}

function makeRoadmap(model: TopicModel) {
  return model.conceptRoute.map((node, index) => ({
    ...node,
    status: index === 0 ? "active" as const : "locked" as const,
  }));
}

function makeTrace(state: TutorState, model: TopicModel, evidence: string[], action: string, reason: string): VisibleReasoningTrace {
  const current = model.conceptRoute[state.activeConcept] ?? model.conceptRoute[0];
  return {
    phase: state.phase,
    currentGoal: `找到“${model.lessonTitle}”中最早一个会影响后续学习路线的缺口`,
    inputsUsed: ["当前会话消息", "本主题诊断卡答案", "LearnerProfile（如有）", "TopicModel", "UniversalTutorProfile"],
    observedEvidence: evidence,
    candidateInterpretations: [
      { interpretation: "已有接触，但还没有稳定迁移到真实场景", supportingEvidence: evidence },
      { interpretation: "当前需要从基础概念重新开始", supportingEvidence: ["诊断证据不足以确认已掌握"] },
    ],
    rejectedInterpretations: [{ interpretation: "仅凭自我熟悉度直接跳过诊断", reason: "熟悉度不能替代可观察的解释和迁移证据" }],
    selectedInterpretation: `从“${current?.title ?? "第一个未解决概念"}”开始，并保留后续概念作为迁移目标`,
    policyChecks: [universalTutorProfile.questionPolicy, "诊断答案全部收集后再统一评价", "未达到掌握门槛前不推进概念"],
    selectedAction: action,
    actionReason: reason,
    stateUpdates: [`当前阶段：${state.phase}`, `当前路线节点：${current?.title ?? "未建立"}`],
    sourceCount: model.evidenceSources.length,
  };
}

export class TutorOrchestrator {
  constructor(private readonly store = new TutorStore()) {}

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
    const runId = `run_${randomUUID().slice(0, 8)}`;
    await emit({ type: "run.started", runId, conversationId });
    let state = await this.store.load(conversationId);

    if (!state) {
      state = {
        schemaVersion: 2,
        conversationId,
        phase: "idle",
        diagnosticCards: [],
        diagnosticAnswers: {},
        currentCard: 0,
        roadmap: [],
        activeConcept: 0,
        turnCount: 0,
        messages: [],
        updatedAt: new Date().toISOString(),
      };
    }

    if (state.schemaVersion === 1) state.schemaVersion = 2;
    let topicModel = state.topicModel ?? buildTopicModel(state.topic ?? message);
    const requestedTopic = buildTopicModel(message);
    const isTopicSwitch = state.phase !== "idle"
      && isSystematicLearningIntent(message)
      && !isDirectHelpRequest(message)
      && !Object.keys(options.diagnosticAnswers ?? {}).length
      && requestedTopic.topic !== topicModel.topic;
    if (isTopicSwitch) {
      state.phase = "idle";
      state.topicModel = undefined;
      state.diagnosticCards = [];
      state.diagnosticAnswers = {};
      state.currentCard = 0;
      state.roadmap = [];
      state.activeConcept = 0;
      topicModel = requestedTopic;
    }
    state.topicModel = topicModel;
    state.universalProfileVersion = universalTutorProfile.version;
    state.topic = topicModel.topic;
    state.lessonTitle = topicModel.lessonTitle;

    const sendText = async (text: string) => {
      for (const chunk of text.match(/.{1,24}/gs) ?? [text]) {
        if (signal?.aborted) throw new Error("请求已取消");
        await emit({ type: "message.delta", text: chunk });
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
      state!.messages.push({ role: "assistant", content: text });
    };

    try {
      state.messages.push({ role: "user", content: message });

      if (isDirectHelpRequest(message)) {
        state.phase = "teach";
        await emit({ type: "tutor.phase.changed", phase: "teach", label: phaseLabels.teach });
        await sendText(`关于“${topicModel.lessonTitle}”，先给你一个直接结论：${topicModel.coreOutcome}\n\n接下来可以用一个真实的小任务验证是否真正掌握：${topicModel.practiceTarget}。如果你愿意系统学习，我会先根据你的实际经验进行摸底，再从最早的缺口开始。`);
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      if (state.phase === "idle") {
        state.diagnosticCards = cardsFor(topicModel);
        state.roadmap = makeRoadmap(topicModel);
        state.currentCard = 0;
        state.phase = "research";
        await emit({ type: "tutor.phase.changed", phase: "research", label: phaseLabels.research });
        await emit({ type: "research.completed", sourceCount: topicModel.evidenceSources.length, researchedAt: new Date().toISOString() });
        await emit({ type: "topic.model.ready", title: topicModel.lessonTitle, outcome: topicModel.coreOutcome, topic: topicModel.topic });
        state.phase = "diagnose";
        await emit({ type: "tutor.phase.changed", phase: "diagnose", label: phaseLabels.diagnose });
        await sendText(`我是你的通用私教。这一节我们学习【${topicModel.lessonTitle}】。\n\n开始前先摸一下你的当前情况，${state.diagnosticCards.length} 个问题，全部完成后统一开始。`);
        await emit({ type: "diagnostic.cards.ready", cards: state.diagnosticCards });
        await emit({ type: "diagnostic.card.ready", card: state.diagnosticCards[0] });
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      if (state.phase === "diagnose") {
        const answers = options.diagnosticAnswers ?? {};
        if (Object.keys(answers).length) {
          state.diagnosticAnswers = { ...state.diagnosticAnswers, ...answers };
          state.currentCard = state.diagnosticCards.length - 1;
        } else {
          const answer = answerLetter(message);
          const card = state.diagnosticCards[state.currentCard];
          if (answer && card) {
            state.diagnosticAnswers[card.id] = answer;
            if (state.currentCard < state.diagnosticCards.length - 1) {
              state.currentCard += 1;
              await emit({ type: "diagnostic.card.ready", card: state.diagnosticCards[state.currentCard] });
              await this.persist(state, runId, emit);
              await emit({ type: "run.completed", runId });
              return;
            }
          }
        }

        if (Object.keys(state.diagnosticAnswers).length < state.diagnosticCards.length) {
          await sendText("请完成当前诊断卡；可以选择 A、B、C 或 D，也可以描述你的实际做法。");
          await emit({ type: "diagnostic.card.ready", card: state.diagnosticCards[state.currentCard] });
          await this.persist(state, runId, emit);
          await emit({ type: "run.completed", runId });
          return;
        }

        state.phase = "plan";
        const evidence = state.diagnosticCards.map((card) => {
          const answer = state!.diagnosticAnswers[card.id] ?? "未回答";
          const option = card.options.find((item) => item.id === answer);
          return `${card.tab}：${option?.label ?? answer}`;
        });
        const diagnosis = `诊断很清楚：${evidence.slice(0, 2).join("；")}。这些证据显示，下一步应该从“${topicModel.conceptRoute[0]?.title ?? "第一个关键概念"}”开始，而不是直接跳到结论。接下来会用一个新场景验证你能否独立迁移。`;
        await emit({ type: "diagnosis.ready", diagnosis, background: ["主题：" + topicModel.lessonTitle, ...evidence] });
        await emit({ type: "roadmap.ready", roadmap: state.roadmap });
        state.phase = "teach";
        await emit({ type: "tutor.phase.changed", phase: "teach", label: phaseLabels.teach });
        await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, topicModel, evidence, `开始练习“${topicModel.conceptRoute[0]?.title ?? "第一个概念"}`, "这是当前 TopicModel 中最早且最能改变后续路线的依赖") });
        await sendText(`先从第一关开始。${topicModel.conceptRoute[0]?.target ?? topicModel.practiceTarget}\n\n请结合你自己的场景说说：你会如何判断自己真的做到了？`);
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      state.turnCount += 1;
      const concept = topicModel.conceptRoute[state.activeConcept] ?? topicModel.conceptRoute[0];
      const hasEvidence = message.length > 20 && /因为|所以|例如|如果|边界|验证|场景|读者|语境|上下文|验收/.test(message);
      const score = hasEvidence ? 88 : 62;
      await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, topicModel, [hasEvidence ? "回答包含机制、场景或验证证据" : "回答主要停留在结论，机制证据不足"], hasEvidence ? "继续进行新场景迁移" : "给出最小反例并追问机制", hasEvidence ? "答案已出现可观察的迁移证据" : "尚未证明能把结论迁移到新场景") });
      await emit({ type: "assessment.updated", score, status: score >= universalTutorProfile.masteryThreshold ? "mastered" : "in-progress" });
      if (score >= universalTutorProfile.masteryThreshold && state.roadmap[state.activeConcept]) state.roadmap[state.activeConcept].status = "mastered";
      await sendText(hasEvidence ? `这个回答已经体现出你能把“${concept?.title ?? "当前概念"}”放回真实场景。再换一个边界条件，你会如何验证它？` : `方向对了，但还需要看到机制解释：在“${concept?.title ?? "当前概念"}”里，你会用哪个具体场景或反例证明自己的判断？`);
      await this.persist(state, runId, emit);
      await emit({ type: "run.completed", runId });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Tutor 运行失败";
      await emit({ type: "run.failed", runId, message: messageText });
      throw error;
    }
  }

  private async persist(state: TutorState, runId: string, emit: (event: TutorEvent) => Promise<void> | void) {
    state.updatedAt = new Date().toISOString();
    await this.store.save(state, { type: "state.saved", runId, phase: state.phase, activeConcept: state.activeConcept });
    await emit({ type: "state.saved", phase: state.phase, activeConcept: state.activeConcept });
  }
}
