import { randomUUID } from "node:crypto";
import type { TutorEvent, TutorState, VisibleReasoningTrace } from "./types.js";
import { TutorStore } from "./store.js";

const lessonTitle = "如何进行高效的 Vibe Coding";
const outcome = "能够把模糊开发需求变成有上下文、有边界、有验收闭环的 Agent 任务，并判断哪些产出必须人工审查。";

const cards = [
  {
    id: "workflow",
    tab: "实际工作流",
    question: "你让 AI 完成一个现有项目功能时，通常怎么开始？",
    options: [
      { id: "A", label: "先检查相关代码和项目约定，再写清范围、限制和验收标准" },
      { id: "B", label: "会给出需求和相关文件，但通常一次让 AI 完成整个功能" },
      { id: "C", label: "主要描述目标，让 AI 自己寻找文件、决定方案并修改" },
      { id: "D", label: "还没有在真实项目里让 AI 完成功能" },
    ],
  },
  {
    id: "validation",
    tab: "验证闭环",
    question: "AI 表示任务完成后，你通常做到哪一步？",
    options: [
      { id: "A", label: "检查 diff，运行构建/测试，再实际验证关键路径和边界条件" },
      { id: "B", label: "会运行构建或测试，但很少实际操作页面或复现运行时状态" },
      { id: "C", label: "主要看 AI 的完成说明，没有报错就继续" },
      { id: "D", label: "目前没有固定验收方式" },
    ],
  },
  {
    id: "trust",
    tab: "信任边界",
    question: "AI 新增依赖并修改鉴权代码时，你通常会怎么处理？",
    options: [
      { id: "A", label: "核验依赖真实性、维护状态和许可，并审查鉴权边界后再接受" },
      { id: "B", label: "会看 diff 和基本逻辑，但一般不会单独核验依赖与安全边界" },
      { id: "C", label: "只要测试通过就接受" },
      { id: "D", label: "不确定应该检查什么" },
    ],
  },
];

const roadmap = [
  { id: "scope", title: "任务边界与验收标准", target: "把模糊需求拆成 Agent 可执行且可验证的任务", status: "active" as const },
  { id: "context", title: "高质量上下文包", target: "提供结构、约定和相似实现，减少 Agent 猜测", status: "locked" as const },
  { id: "iteration", title: "增量任务与迭代节奏", target: "用小步交付控制返工和上下文漂移", status: "locked" as const },
  { id: "runtime", title: "运行时验证闭环", target: "把网络、DOM、错误态和边界场景纳入验收", status: "locked" as const },
  { id: "review", title: "代码审查与信任边界", target: "识别依赖、安全和 AI 特有错误", status: "locked" as const },
  { id: "production", title: "生产环境红线", target: "判断哪些变更必须人工确认和分阶段发布", status: "locked" as const },
];

const phaseLabels = {
  research: "正在阅读资料并建立课程模型",
  diagnose: "正在进行诊断",
  plan: "正在整理学习路线",
  teach: "正在进行一对一练习",
  complete: "本轮学习已完成",
  idle: "准备开始",
};

function cardFor(index: number) {
  const card = cards[index];
  return { ...card, index, total: cards.length };
}

function answerLetter(input: string): string {
  const match = input.trim().toUpperCase().match(/\b([ABCD])\b|^([ABCD])/);
  return match?.[1] ?? match?.[2] ?? "";
}

function makeTrace(state: TutorState, evidence: string[], action: string, reason: string): VisibleReasoningTrace {
  return {
    phase: state.phase,
    currentGoal: "找到最早一个会影响 Vibe Coding 效率的工作流缺口",
    inputsUsed: ["当前会话消息", "三张诊断卡答案", "Vibe Coding TutorProfile"],
    observedEvidence: evidence,
    candidateInterpretations: [
      { interpretation: "工具不熟", supportingEvidence: ["已经在真实项目中使用 AI 工具"] },
      { interpretation: "任务边界和验收没有闭环", supportingEvidence: evidence },
    ],
    rejectedInterpretations: [{ interpretation: "从工具基础开始", reason: "现有行为已经证明具备基本工具接触经验" }],
    selectedInterpretation: "当前起点是任务边界与验收标准",
    policyChecks: ["下一轮只考察一个概念", "提问答案会改变后续教学动作", "不提前评价诊断答案"],
    selectedAction: action,
    actionReason: reason,
    stateUpdates: [`当前阶段：${state.phase}`, `当前路线节点：${roadmap[state.activeConcept]?.title ?? roadmap[0].title}`],
    sourceCount: 4,
  };
}

export class TutorOrchestrator {
  constructor(private readonly store = new TutorStore()) {}

  async hasActiveSession(conversationId: string): Promise<boolean> {
    const state = await this.store.load(conversationId);
    return Boolean(state && state.phase !== "idle");
  }

  isTutorIntent(message: string, state?: TutorState) {
    return Boolean(state?.phase !== "idle" || /vibe\s*coding|私教|学习.*编程|高效.*编码/i.test(message));
  }

  async run(conversationId: string, message: string, emit: (event: TutorEvent) => Promise<void> | void, signal?: AbortSignal) {
    const runId = `run_${randomUUID().slice(0, 8)}`;
    await emit({ type: "run.started", runId, conversationId });
    let state = await this.store.load(conversationId);
    if (!state) {
      state = {
        schemaVersion: 1,
        conversationId,
        phase: "idle",
        diagnosticCards: cards.map((_, index) => cardFor(index)),
        diagnosticAnswers: {},
        currentCard: 0,
        roadmap: roadmap.map((node) => ({ ...node })),
        activeConcept: 0,
        turnCount: 0,
        messages: [],
        updatedAt: new Date().toISOString(),
      };
    }
    const isResumePrompt = state.phase !== "idle" && /vibe\s*coding|如何进行高效/i.test(message);
    if (!isResumePrompt) state.messages.push({ role: "user", content: message });

    const sendText = async (text: string) => {
      for (const chunk of text.match(/.{1,24}/gs) ?? [text]) {
        if (signal?.aborted) throw new Error("请求已取消");
        await emit({ type: "message.delta", text: chunk });
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
      state!.messages.push({ role: "assistant", content: text });
    };

    try {
      if (message.includes("直接告诉我") || message.includes("直接讲解")) {
        state.phase = "teach";
        await emit({ type: "tutor.phase.changed", phase: "teach", label: phaseLabels.teach });
        await sendText("高效的 Vibe Coding 不是把一句模糊需求交给 AI，而是建立一个可验证的协作闭环：先说明目标和范围，再提供项目上下文，按小任务迭代，最后用测试和真实运行验证结果。关键原则是：让 Agent 少猜一点，让验收多观察一层。\n\n第一步可以把需求写成五块：目标、修改范围、必要上下文、约束和验收标准。验收至少覆盖成功、空数据、失败和页面运行时状态。\n\n这也是为什么“构建通过”不等于功能完成：构建只能证明代码能编译，不能证明浏览器消费了正确的接口、页面渲染了正确状态。\n\n参考来源：GitHub Copilot Best Practices、OpenAI Codex 使用指南。 ");
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      if (state.phase === "idle") {
        state.topic = "vibe-coding";
        state.lessonTitle = lessonTitle;
        state.phase = "research";
        await emit({ type: "tutor.phase.changed", phase: "research", label: phaseLabels.research });
        await emit({ type: "research.completed", sourceCount: 4, researchedAt: new Date().toISOString() });
        await emit({ type: "lesson.model.ready", title: lessonTitle, outcome });
        state.phase = "diagnose";
        await emit({ type: "tutor.phase.changed", phase: "diagnose", label: phaseLabels.diagnose });
        await sendText(`我是你的 Vibe Coding 私教。这一节我们学习【${lessonTitle}】。\n\n开始前先摸一下你的实际工作流，3 个问题，逐个答完就开始。`);
        await emit({ type: "diagnostic.card.ready", card: cardFor(0) });
        state.currentCard = 0;
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      if (state.phase === "diagnose") {
        const answer = answerLetter(message);
        if (isResumePrompt) {
          await emit({ type: "diagnostic.card.ready", card: cardFor(state.currentCard) });
          await this.persist(state, runId, emit);
          await emit({ type: "run.completed", runId });
          return;
        }
        if (!answer) {
          await sendText("请从当前诊断卡选择 A、B、C 或 D，也可以直接描述你的实际做法。");
          await emit({ type: "diagnostic.card.ready", card: cardFor(state.currentCard) });
        } else {
          const card = state.diagnosticCards[state.currentCard];
          state.diagnosticAnswers[card.id] = answer;
          if (state.currentCard < state.diagnosticCards.length - 1) {
            state.currentCard += 1;
            await emit({ type: "diagnostic.card.ready", card: cardFor(state.currentCard) });
          } else {
            state.phase = "plan";
            const answers = state.diagnosticAnswers;
            const evidence = [
              answers.workflow === "A" ? "你会先检查代码和约定" : "你已经在尝试把需求和相关文件交给 AI",
              answers.validation === "A" ? "你已经形成了运行时验证习惯" : "验收目前主要停在构建或测试",
              answers.trust === "A" ? "你会主动核验依赖和安全边界" : "依赖与安全边界还没有固定检查方式",
            ];
            const background = [
              "主题：如何进行高效的 Vibe Coding",
              evidence[0],
              evidence[1],
              evidence[2],
            ];
            const diagnosis = `诊断很清楚：${evidence[0]}，${evidence[1]}；${evidence[2]}。当前瓶颈不是“不会写 Prompt”，而是还没有把上下文、任务边界和验收闭成一个循环。学完这一节，你要能把模糊需求整理成 Agent 可执行、可验收的任务。`;
            await emit({ type: "diagnosis.ready", diagnosis, background });
            await emit({ type: "roadmap.ready", roadmap: state.roadmap });
            state.phase = "teach";
            await emit({ type: "tutor.phase.changed", phase: "teach", label: phaseLabels.teach });
            await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, evidence, "开始练习任务边界与验收标准", "这是最早且最能减少返工的未解决依赖") });
            await sendText("先从第一关开始。下面两种任务描述，哪一种更可能减少返工？请选择并说出两个原因。\n\nA. 给这个项目增加导出 Excel 功能，完成后告诉我。\n\nB. 在订单列表页增加导出当前筛选结果的 Excel 按钮；复用现有订单查询；字段固定为订单号、金额、状态；无数据时按钮禁用；只改订单模块；完成后运行相关测试并实际验证有数据/无数据两种状态。");
          }
        }
        await this.persist(state, runId, emit);
        await emit({ type: "run.completed", runId });
        return;
      }

      state.turnCount += 1;
      const hasBoundaryEvidence = /范围|上下文|验收|测试|运行时|边界|失败|构建|DOM|网络/.test(message);
      const score = hasBoundaryEvidence ? 88 : 62;
      await emit({ type: "reasoning.trace.ready", trace: makeTrace(state, [hasBoundaryEvidence ? "回答包含可观察的范围、上下文或验收证据" : "回答主要停留在结论，机制证据不足"], hasBoundaryEvidence ? "继续进行迁移练习" : "给出一个最小反例并追问机制", hasBoundaryEvidence ? "答案已经包含影响实现和验收的证据" : "尚未证明能把结论迁移到新场景") });
      await emit({ type: "assessment.updated", score, status: score >= 80 ? "mastered" : "in-progress" });
      if (score >= 80) state.roadmap[0].status = "mastered";
      await sendText(hasBoundaryEvidence ? "这个回答已经把静态结果和运行时证据区分开了。再迁移一步：如果 Agent stdout 有内容但页面仍空白，你会先检查网络响应、控制台和 DOM 状态，还是继续让 Agent 猜代码？请说明理由。" : "方向对了，但我还需要看到你的机制解释：如果构建通过而页面仍空白，你会检查哪两个运行时证据？");
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
