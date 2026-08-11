import { generateText, streamText } from "ai";
import { z } from "zod";
import type { ModelMessage } from "ai";
import type { TopicModel, TutorTurnDecision, TutorState } from "./types.js";

const diagnosticOptionSchema = z.object({ id: z.string(), label: z.string() });
const topicModelSchema = z.object({
  id: z.string(),
  topic: z.string(),
  lessonTitle: z.string(),
  coreOutcome: z.string(),
  diagnosticDimensions: z.array(z.object({
    id: z.string(),
    tab: z.string(),
    question: z.string(),
    options: z.array(diagnosticOptionSchema).min(2).max(6),
  })).min(3).max(6),
  conceptRoute: z.array(z.object({ id: z.string(), title: z.string(), target: z.string() })).min(2).max(10),
  boundaryCases: z.array(z.string()).min(1).max(8),
  practiceTarget: z.string(),
  rubricAnchors: z.array(z.object({ conceptId: z.string(), accuracy: z.string(), transfer: z.string() })),
  evidenceSources: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const turnDecisionSchema = z.object({
  intent: z.enum(["answer", "dont_know", "disagreement", "clarification", "direct_answer_request", "topic_switch", "meta_question", "stop"]),
  understoodMeaning: z.string(),
  evidence: z.array(z.object({ quote: z.string(), implication: z.string() })),
  assessment: z.object({
    status: z.enum(["not-answered", "insufficient", "partial", "misconception", "mastered"]),
    score: z.number().min(0).max(100).optional(),
    rubricEvidence: z.array(z.string()),
  }),
  nextAction: z.enum(["explain", "give-example", "ask-clarification", "repair-misconception", "ask-socratic-question", "give-practice", "advance-concept", "switch-topic", "complete"]),
  statePatch: z.object({
    activeConceptId: z.string().optional(),
    addMisconception: z.string().optional(),
    masteredConceptId: z.string().optional(),
  }),
  responsePlan: z.object({ goal: z.string(), keyPoints: z.array(z.string()), question: z.string().optional() }),
});

export type TutorModelClient = {
  buildTopicModel(input: {
    userGoal: string;
    history: ModelMessage[];
    materials?: string[];
  }, signal?: AbortSignal): Promise<TopicModel>;
  analyzeTurn(input: {
    message: string;
    state: TutorState;
    topicModel: TopicModel;
  }, signal?: AbortSignal): Promise<TutorTurnDecision>;
  streamResponse(input: {
    message: string;
    state: TutorState;
    topicModel: TopicModel;
    decision: TutorTurnDecision;
  }, onDelta: (text: string) => Promise<void> | void, signal?: AbortSignal): Promise<string>;
};

function formatTopicContext(model: TopicModel): string {
  return JSON.stringify({
    title: model.lessonTitle,
    outcome: model.coreOutcome,
    route: model.conceptRoute,
    boundaries: model.boundaryCases,
    practice: model.practiceTarget,
    rubric: model.rubricAnchors,
  });
}

function extractJson(text: string): string {
  const withoutFence = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/u, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");
  return withoutFence.slice(start, end + 1);
}

const topicModelContract = {
  id: "ai-comic-course",
  topic: "ai-comic",
  lessonTitle: "如何用 AI 制作漫剧",
  coreOutcome: "能够从创意、剧本、分镜到成片完成一个可验证的小作品。",
  diagnosticDimensions: [
    {
      id: "experience",
      tab: "已有经验",
      question: "你目前做过哪些相关尝试？",
      options: [
        { id: "A", label: "做过完整作品" },
        { id: "B", label: "尝试过部分环节" },
        { id: "C", label: "还没有实际尝试" },
      ],
    },
  ],
  conceptRoute: [
    { id: "concept-1", title: "第一个关键概念", target: "完成一个可验证的小任务" },
  ],
  boundaryCases: ["看起来完成不等于在真实场景中有效"],
  practiceTarget: "完成一个最小可行作品并验证结果",
  rubricAnchors: [
    { conceptId: "concept-1", accuracy: "能解释关键机制", transfer: "能在新场景中独立应用" },
  ],
  evidenceSources: ["用户目标", "相关主题资料"],
  confidence: 0.8,
};

const turnDecisionContract = {
  intent: "dont_know",
  understoodMeaning: "用户暂时无法回答当前问题",
  evidence: [
    { quote: "不知道", implication: "用户没有提供可评估的知识证据" },
  ],
  assessment: {
    status: "not-answered",
    rubricEvidence: [],
  },
  nextAction: "give-example",
  statePatch: {},
  responsePlan: {
    goal: "降低难度并通过例子帮助用户理解",
    keyPoints: ["先给出一个具体例子"],
    question: "你能指出例子中的哪一步吗？",
  },
};

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function normalizeTopicModel(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, any>;
  const dimensions = source.diagnosticDimensions ?? source.diagnostics ?? source.dimensions ?? [];
  const route = source.conceptRoute ?? source.learningRoute ?? source.learningPath ?? source.route ?? source.concepts ?? [];
  const boundaryCases = source.boundaryCases ?? source.boundaries ?? source.edgeCases ?? [];
  const rubrics = source.rubricAnchors ?? source.rubrics ?? source.masteryRubrics ?? [];

  return {
    id: textValue(source.id) ?? `topic-${Date.now().toString(36)}`,
    topic: textValue(source.topic) ?? textValue(source.topicId) ?? "general",
    lessonTitle: textValue(source.lessonTitle) ?? textValue(source.title) ?? textValue(source.name),
    coreOutcome: textValue(source.coreOutcome) ?? textValue(source.expectedOutcome) ?? textValue(source.outcome) ?? textValue(source.goal),
    diagnosticDimensions: Array.isArray(dimensions) ? dimensions.map((item: any, index: number) => {
      const options = item?.options ?? item?.choices ?? item?.answers ?? [];
      return {
        id: textValue(item?.id) ?? textValue(item?.key) ?? `dimension-${index + 1}`,
        tab: textValue(item?.tab) ?? textValue(item?.name) ?? textValue(item?.title) ?? textValue(item?.dimension) ?? `学习维度 ${index + 1}`,
        question: textValue(item?.question) ?? textValue(item?.prompt) ?? textValue(item?.description) ?? textValue(item?.goal) ?? textValue(item?.问题),
        options: Array.isArray(options) ? options.map((option: any, optionIndex: number) => ({
          id: textValue(option?.id) ?? textValue(option?.key) ?? String.fromCharCode(65 + optionIndex),
          label: textValue(option?.label) ?? textValue(option?.text) ?? textValue(option?.description) ?? textValue(option?.内容),
        })) : options,
      };
    }) : dimensions,
    conceptRoute: Array.isArray(route) ? route.map((item: any, index: number) => ({
      id: textValue(item?.id) ?? textValue(item?.key) ?? `concept-${index + 1}`,
      title: textValue(item?.title) ?? textValue(item?.name) ?? textValue(item?.concept) ?? textValue(item?.label) ?? textValue(item?.名称),
      target: textValue(item?.target) ?? textValue(item?.outcome) ?? textValue(item?.description) ?? textValue(item?.goal) ?? textValue(item?.目标),
    })) : route,
    boundaryCases: Array.isArray(boundaryCases) ? boundaryCases.map((item: any) => textValue(item) ?? [textValue(item?.title), textValue(item?.description)].filter(Boolean).join("：")) : boundaryCases,
    practiceTarget: textValue(source.practiceTarget) ?? textValue(source.practiceTask) ?? textValue(source.practice) ?? textValue(source.project),
    rubricAnchors: Array.isArray(rubrics) ? rubrics.map((item: any, index: number) => ({
      conceptId: textValue(item?.conceptId) ?? textValue(item?.concept) ?? textValue(item?.id) ?? `concept-${index + 1}`,
      accuracy: textValue(item?.accuracy) ?? textValue(item?.criteria) ?? textValue(item?.understanding) ?? textValue(item?.description) ?? textValue(item?.准确性),
      transfer: textValue(item?.transfer) ?? textValue(item?.application) ?? textValue(item?.practice) ?? textValue(item?.迁移),
    })) : rubrics,
    evidenceSources: Array.isArray(source.evidenceSources ?? source.sources) ? (source.evidenceSources ?? source.sources).map((item: any) => textValue(item) ?? JSON.stringify(item)) : [],
    confidence: typeof source.confidence === "number" ? source.confidence : 0.6,
  };
}

async function generateJson<T>(input: {
  model: any;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  contract?: unknown;
  normalize?: (value: unknown) => unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const result = await generateText({
    model: input.model,
    abortSignal: input.signal,
    system: `${input.system}\n只输出一个合法 JSON 对象，不要输出 Markdown、解释或代码围栏。`,
    prompt: input.prompt,
  });

  try {
    const parsed = JSON.parse(extractJson(result.text));
    return input.schema.parse(input.normalize ? input.normalize(parsed) : parsed);
  } catch (firstError) {
    const retry = await generateText({
      model: input.model,
      abortSignal: input.signal,
      system: "把用户提供的模型输出修复成符合要求的合法 JSON。只输出 JSON 对象，不要解释。",
      prompt: JSON.stringify({
        requiredContract: input.contract,
        originalOutput: result.text,
        validationError: String(firstError),
      }),
    });
    try {
      const parsed = JSON.parse(extractJson(retry.text));
      return input.schema.parse(input.normalize ? input.normalize(parsed) : parsed);
    } catch (secondError) {
      console.error("[Tutor] 模型结构化输出两次校验失败", { firstError, secondError });
      throw new Error("模型结构化输出不完整，请稍后重试");
    }
  }
}

export class AiTutorModelClient implements TutorModelClient {
  constructor(private readonly model: any) {}

  async buildTopicModel(input: { userGoal: string; history: ModelMessage[]; materials?: string[] }, signal?: AbortSignal): Promise<TopicModel> {
    return generateJson({
      model: this.model,
      schema: topicModelSchema,
      signal,
      contract: topicModelContract,
      normalize: normalizeTopicModel,
      system: [
        "你是一个通用的一对一学习教练的课程设计器。",
        "你不能依赖预设主题列表，必须为任意用户主题动态建立 TopicModel。",
        "诊断问题要覆盖既往经验、概念理解、边界辨析和迁移能力。",
        "路线必须服务于用户目标，不能把不相关主题的模板套进来。",
        `必须严格返回以下字段结构，字段名不能改名：${JSON.stringify(topicModelContract)}`,
        "只输出符合 schema 的结构化对象。",
      ].join("\n"),
      prompt: JSON.stringify({ userGoal: input.userGoal, history: input.history, materials: input.materials ?? [] }),
    });
  }

  async analyzeTurn(input: { message: string; state: TutorState; topicModel: TopicModel }, signal?: AbortSignal): Promise<TutorTurnDecision> {
    const activeConcept = input.topicModel.conceptRoute[input.state.activeConcept] ?? input.topicModel.conceptRoute[0];
    return generateJson({
      model: this.model,
      schema: turnDecisionSchema,
      signal,
      contract: turnDecisionContract,
      system: [
        "你是通用私教的教学决策器。你现在只生成 TutorTurnDecision JSON，不要直接回答用户。",
        "特别区分：回答、不知道、反驳老师、请求澄清、要求直接讲解和切换主题。",
        "用户说“不知道”不是错误答案；用户说“错了”不是知识作答，而是对老师判断的异议。",
        "只有用户提供了与当前 rubric 相关的可观察证据，才能评估为 partial 或 mastered。",
        "不要凭固定关键词评分，不要假设用户接受了老师上一轮判断。",
        `必须严格遵守以下字段结构，字段名和值类型不能改变：${JSON.stringify(turnDecisionContract)}`,
        "只输出符合 schema 的结构化对象。",
      ].join("\n"),
      prompt: JSON.stringify({
        userMessage: input.message,
        currentState: input.state,
        topicModel: input.topicModel,
        activeConcept,
      }),
    });
  }

  async streamResponse(input: { message: string; state: TutorState; topicModel: TopicModel; decision: TutorTurnDecision }, onDelta: (text: string) => Promise<void> | void, signal?: AbortSignal): Promise<string> {
    const result = streamText({
      model: this.model,
      abortSignal: signal,
      system: [
        "你是一个专业、耐心、使用苏格拉底式引导的通用私教。",
        "根据教学决策生成自然语言回答，不要暴露隐藏推理过程。",
        "先回应用户当前真实意图，再给最小必要解释或例子，最后只问一个核心问题。",
        "如果用户表示不知道，降低难度并给例子；如果用户反驳，先承认并澄清，不要强行评价。",
      ].join("\n"),
      prompt: JSON.stringify({
        userMessage: input.message,
        topic: formatTopicContext(input.topicModel),
        decision: input.decision,
        currentState: input.state,
      }),
    });
    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        text += part.text;
        await onDelta(part.text);
      }
    }
    return text;
  }
}
