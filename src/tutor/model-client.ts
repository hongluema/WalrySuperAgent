import { generateText, streamText } from "ai";
import { z } from "zod";
import type { ModelMessage } from "ai";
import type { TopicModel, TutorDiagnosis, TutorTurnDecision, TutorState } from "./types.js";

const capabilityPlanSchema = z.object({
  acquisition: z.array(z.string()),
  structuring: z.array(z.string()),
  interaction: z.array(z.string()),
  assessment: z.array(z.string()),
  missing: z.array(z.string()),
});

const learningEvidenceSchema = z.object({
  learnerQuote: z.string(),
  criterion: z.enum(["accurate", "explained", "discrimination", "transfer", "performance"]),
  strength: z.enum(["weak", "sufficient"]),
});

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
  })).min(2).max(6),
  conceptRoute: z.array(z.object({ id: z.string(), title: z.string(), target: z.string() })).min(2).max(10),
  boundaryCases: z.array(z.string()).min(1).max(8),
  practiceTarget: z.string(),
  rubricAnchors: z.array(z.object({
    conceptId: z.string(),
    accuracy: z.string(),
    explanation: z.string(),
    discrimination: z.string(),
    transfer: z.string(),
    performance: z.string().optional(),
  })),
  evidenceSources: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  subject: z.object({ kind: z.string(), description: z.string(), userGoal: z.string() }),
  grounding: z.object({
    mode: z.string(),
    sources: z.array(z.object({ label: z.string(), verified: z.boolean() })),
    limitations: z.array(z.string()),
  }),
  capabilities: capabilityPlanSchema,
});

const turnDecisionSchema = z.object({
  intent: z.enum(["answer", "dont_know", "disagreement", "clarification", "direct_answer_request", "topic_switch", "meta_question", "stop"]),
  understoodMeaning: z.string(),
  evidence: z.array(z.object({ quote: z.string(), implication: z.string() })),
  assessment: z.object({
    status: z.enum(["not-answered", "insufficient", "partial", "misconception", "mastered"]),
    score: z.number().min(0).max(100).optional(),
    rubricEvidence: z.array(z.string()),
    evidence: z.array(learningEvidenceSchema),
  }),
  nextAction: z.enum(["explain", "give-example", "ask-clarification", "repair-misconception", "ask-socratic-question", "give-practice", "advance-concept", "switch-topic", "complete"]),
  statePatch: z.object({
    activeConceptId: z.string().optional(),
    addMisconception: z.string().optional(),
    masteredConceptId: z.string().optional(),
  }),
  responsePlan: z.object({
    goal: z.string(),
    teachingAtom: z.string(),
    gapToRepair: z.string(),
    keyPoints: z.array(z.string()),
    allowedContent: z.array(z.string()),
    forbiddenContent: z.array(z.string()),
    question: z.string().optional(),
  }),
});

const diagnosisSchema = z.object({
  summary: z.string(),
  learnerProfile: z.array(z.string()),
  evidence: z.array(z.object({ quote: z.string(), implication: z.string() })),
  skipSuggestions: z.array(z.object({
    conceptId: z.string(),
    reason: z.string(),
    confidence: z.enum(["high", "medium"]),
  })).optional().default([]),
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
  compileDiagnosis(input: {
    state: TutorState;
    topicModel: TopicModel;
    answeredDiagnostics: Array<{ id: string; question: string; optionId: string; optionLabel: string }>;
  }, signal?: AbortSignal): Promise<TutorDiagnosis>;
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
    subject: model.subject,
    grounding: model.grounding,
    capabilities: model.capabilities,
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
  requiredFields: ["id", "topic", "lessonTitle", "coreOutcome", "diagnosticDimensions", "conceptRoute", "boundaryCases", "practiceTarget", "rubricAnchors", "evidenceSources", "confidence", "subject", "grounding", "capabilities"],
  diagnosticDimensionFields: ["id", "tab", "question", "options: { id, label }[]"],
  conceptRouteFields: ["id", "title", "target"],
  rubricFields: ["conceptId", "accuracy", "explanation", "discrimination", "transfer", "performance?"],
  subjectFields: ["kind", "description", "userGoal"],
  groundingFields: ["mode", "sources: { label, verified }[]", "limitations"],
  capabilityFields: ["acquisition", "structuring", "interaction", "assessment", "missing"],
};

const turnDecisionContract = {
  requiredFields: ["intent", "understoodMeaning", "evidence", "assessment", "nextAction", "statePatch", "responsePlan"],
  intentValues: ["answer", "dont_know", "disagreement", "clarification", "direct_answer_request", "topic_switch", "meta_question", "stop"],
  assessmentStatusValues: ["not-answered", "insufficient", "partial", "misconception", "mastered"],
  nextActionValues: ["explain", "give-example", "ask-clarification", "repair-misconception", "ask-socratic-question", "give-practice", "advance-concept", "switch-topic", "complete"],
  assessmentFields: ["status", "score?", "rubricEvidence", "evidence"],
  learningEvidenceFields: ["learnerQuote", "criterion: accurate|explained|discrimination|transfer|performance", "strength: weak|sufficient"],
  statePatchFields: ["activeConceptId?", "addMisconception?", "masteredConceptId?"],
  responsePlanFields: ["goal", "teachingAtom", "gapToRepair", "keyPoints", "allowedContent", "forbiddenContent", "question?"],
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
      explanation: textValue(item?.explanation) ?? textValue(item?.reasoning) ?? "能说明关键结论为什么成立",
      discrimination: textValue(item?.discrimination) ?? textValue(item?.comparison) ?? "能区分相近概念和常见误解",
      transfer: textValue(item?.transfer) ?? textValue(item?.application) ?? textValue(item?.practice) ?? textValue(item?.迁移),
      performance: textValue(item?.performance),
    })) : rubrics,
    evidenceSources: Array.isArray(source.evidenceSources ?? source.sources) ? (source.evidenceSources ?? source.sources).map((item: any) => textValue(item) ?? JSON.stringify(item)) : [],
    confidence: typeof source.confidence === "number" ? source.confidence : 0.6,
    subject: {
      kind: textValue(source.subject?.kind) ?? textValue(source.kind) ?? "open-learning-subject",
      description: textValue(source.subject?.description) ?? textValue(source.lessonTitle) ?? textValue(source.title) ?? "当前学习对象",
      userGoal: textValue(source.subject?.userGoal) ?? textValue(source.userGoal) ?? textValue(source.coreOutcome) ?? textValue(source.outcome) ?? "理解并应用当前学习对象",
    },
    grounding: {
      mode: textValue(source.grounding?.mode) ?? "model-knowledge",
      sources: Array.isArray(source.grounding?.sources)
        ? source.grounding.sources.map((item: any) => ({ label: textValue(item?.label) ?? String(item), verified: item?.verified === true }))
        : [],
      limitations: Array.isArray(source.grounding?.limitations) ? source.grounding.limitations.map((item: any) => String(item)) : ["未提供可直接核验的学习材料"],
    },
    capabilities: {
      acquisition: Array.isArray(source.capabilities?.acquisition) ? source.capabilities.acquisition.map(String) : ["model-knowledge"],
      structuring: Array.isArray(source.capabilities?.structuring) ? source.capabilities.structuring.map(String) : ["concept-dependency"],
      interaction: Array.isArray(source.capabilities?.interaction) ? source.capabilities.interaction.map(String) : ["socratic-dialogue"],
      assessment: Array.isArray(source.capabilities?.assessment) ? source.capabilities.assessment.map(String) : ["explanation", "transfer"],
      missing: Array.isArray(source.capabilities?.missing) ? source.capabilities.missing.map(String) : [],
    },
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
        "不要把学习对象归入封闭类型枚举；subject.kind 是开放标签。请按知识取得、内容组织、教学互动、掌握验证四组能力描述任务。",
        "忠于用户原始学习对象和目标，不得擅自扩张成更大的领域课程、考试课或项目课。",
        "只有真实提供或检索到的来源 verified 才能为 true；模型已有知识不是已验证研究。",
        "诊断问题从既往经验、概念理解、边界辨析、迁移能力等维度中，选择 2-4 个对当前主题最有区分度的维度出题，不需要凑满所有维度。",
        "至少一题要求用户完成真实判断，不要全部使用自我评价题，也不要在诊断前泄露答案。",
        `路线节点必须是学习对象本身的知识/内容节点。判断标准：去掉这个节点后，学习者对该领域的理解是否有实质缺失？\u201C明确学习目标\u201D\u201C批判性思考\u201D\u201C形成应用清单\u201D等属于教学技法，应融入内容节点的教学过程，不作为独立节点。`,
        "对于有明确源材料的学习（书/论文/代码库），路线应忠于源材料自身的结构。",
        "路线必须服务于用户目标，不能把不相关主题的模板套进来。",
        `必须严格返回以下字段结构，字段名不能改名：${JSON.stringify(topicModelContract)}`,
        "只输出符合 schema 的结构化对象。",
      ].join("\n"),
      prompt: JSON.stringify({ userGoal: input.userGoal, history: input.history, materials: input.materials ?? [] }),
    });
  }

  async compileDiagnosis(input: { state: TutorState; topicModel: TopicModel; answeredDiagnostics: Array<{ id: string; question: string; optionId: string; optionLabel: string }> }, signal?: AbortSignal): Promise<TutorDiagnosis> {
    return generateJson({
      model: this.model,
      schema: diagnosisSchema,
      signal,
      contract: { requiredFields: ["summary", "learnerProfile", "evidence", "skipSuggestions"] },
      system: [
        "你是通用私教的诊断编译器，只处理已经完成的结构化诊断答案。",
        "每条判断必须引用具体题目和所选选项，不能把已作答诊断解释成不知道或没有证据。",
        "诊断只描述学习起点，不要讲课程内容，也不要生成教学计划。",
        "学习对象是开放的；忠于用户目标，不根据类型擅自扩大课程范围。",
        "根据诊断答案，判断路线中哪些节点学习者可能已掌握，输出 skipSuggestions 数组。对于高置信度的判断（学习者明确答对核心概念题），confidence 标记为 high；对于中等置信度的判断（有一定直觉但未验证），标记为 medium。如果没有可跳过的节点，返回空数组。",
        `必须严格遵守字段要求：${JSON.stringify({ requiredFields: ["summary", "learnerProfile", "evidence", "skipSuggestions"] })}`,
      ].join("\n"),
      prompt: JSON.stringify({ answeredDiagnostics: input.answeredDiagnostics, topic: formatTopicContext(input.topicModel), currentState: input.state }),
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
        "必须引用用户原话并分别记录准确、解释、辨析、迁移或实操证据；没有对应证据不得假定掌握。",
        "每轮只选择一个 teachingAtom，只修复一个 gapToRepair。allowedContent 必须足够窄，forbiddenContent 要阻止提前教授后续节点。",
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
        "严格执行 decision.responsePlan：只讲 teachingAtom 和 allowedContent，不得输出 forbiddenContent，不得一次总结整门课程。",
        "正文原则上不超过 600 个中文字符。",
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
