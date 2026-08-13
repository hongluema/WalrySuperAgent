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

const pedagogySchema = z.object({
  hit: z.string(),
  unpunched: z.string(),
  invented: z.string(),
  nextLayer: z.string(),
  sourceMove: z.string(),
  nextQuestion: z.string(),
  questionPurpose: z.enum(["accurate", "explained", "discrimination", "transfer", "performance", "introduce"]),
  restatedBiography: z.boolean(),
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
  pedagogy: pedagogySchema.optional(),
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
    onThinking?: (text: string) => Promise<void> | void;
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

const bannedQuestionPattern = /最关键的区别|机制或作用是什么|再用一句话说明|为什么会产生这种结果|根据刚才介绍的内容/;

export function isBannedQuestion(question: string | undefined): boolean {
  return Boolean(question && bannedQuestionPattern.test(question));
}

export function splitThinkingAndJson(text: string): { thinking: string; json: string } {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
  if (fence?.index !== undefined) {
    return {
      thinking: trimmed.slice(0, fence.index).trim(),
      json: extractJson(fence[1]),
    };
  }
  const lineBrace = trimmed.search(/\n\{/);
  const start = lineBrace >= 0 ? lineBrace + 1 : trimmed.indexOf("{");
  if (start < 0) throw new Error("模型没有返回 JSON 对象");
  return {
    thinking: trimmed.slice(0, start).trim(),
    json: extractJson(trimmed.slice(start)),
  };
}

function thinkingPrefix(text: string): string {
  const fence = text.search(/```(?:json)?/);
  if (fence >= 0) return text.slice(0, fence).trimEnd();
  const lineBrace = text.search(/\n\{/);
  if (lineBrace >= 0) return text.slice(0, lineBrace).trimEnd();
  if (text.trimStart().startsWith("{")) return "";
  return text;
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
  requiredFields: ["intent", "understoodMeaning", "evidence", "assessment", "nextAction", "statePatch", "responsePlan", "pedagogy"],
  intentValues: ["answer", "dont_know", "disagreement", "clarification", "direct_answer_request", "topic_switch", "meta_question", "stop"],
  assessmentStatusValues: ["not-answered", "insufficient", "partial", "misconception", "mastered"],
  nextActionValues: ["explain", "give-example", "ask-clarification", "repair-misconception", "ask-socratic-question", "give-practice", "advance-concept", "switch-topic", "complete"],
  assessmentFields: ["status", "score?", "rubricEvidence", "evidence"],
  learningEvidenceFields: ["learnerQuote", "criterion: accurate|explained|discrimination|transfer|performance", "strength: weak|sufficient"],
  statePatchFields: ["activeConceptId?", "addMisconception?", "masteredConceptId?"],
  responsePlanFields: ["goal", "teachingAtom", "gapToRepair", "keyPoints", "allowedContent", "forbiddenContent", "question?"],
  pedagogyFields: ["hit", "unpunched", "invented", "nextLayer", "sourceMove", "nextQuestion", "questionPurpose", "restatedBiography"],
};

const diagnosisContract = {
  requiredFields: ["summary", "learnerProfile", "evidence", "skipSuggestions"],
  evidenceFields: ["quote", "implication"],
  skipSuggestionFields: ["conceptId", "reason", "confidence: high|medium"],
  notes: [
    "evidence 必须是对象数组，不能是字符串数组；每项含 quote（引用具体题干与选项）与 implication（由此得出的判断）",
    "skipSuggestions 每项必须含 conceptId（对应 conceptRoute[].id），不能用 id/nodeId 代替",
  ],
};

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function normalizeQuoteImplication(item: unknown): { quote: string; implication: string } | undefined {
  if (typeof item === "string") {
    const text = item.trim();
    if (!text) return undefined;
    const separators = ["：", ":", " -> ", " → ", " => ", " — ", " - "];
    for (const separator of separators) {
      const index = text.indexOf(separator);
      if (index > 0 && index < text.length - separator.length) {
        return {
          quote: text.slice(0, index).trim(),
          implication: text.slice(index + separator.length).trim(),
        };
      }
    }
    return { quote: text, implication: "诊断证据" };
  }
  if (!item || typeof item !== "object") return undefined;
  const source = item as Record<string, any>;
  const quote = textValue(source.quote)
    ?? textValue(source.text)
    ?? textValue(source.content)
    ?? textValue(source.source)
    ?? textValue(source.observation)
    ?? textValue(source.evidence);
  const implication = textValue(source.implication)
    ?? textValue(source.meaning)
    ?? textValue(source.reason)
    ?? textValue(source.why)
    ?? textValue(source.conclusion)
    ?? textValue(source.inference);
  if (!quote && !implication) return undefined;
  return {
    quote: quote ?? "诊断观察",
    implication: implication ?? "诊断证据",
  };
}

function normalizeSkipSuggestion(item: unknown): { conceptId: string; reason: string; confidence: "high" | "medium" } | undefined {
  if (!item || typeof item !== "object") return undefined;
  const source = item as Record<string, any>;
  const conceptId = textValue(source.conceptId)
    ?? textValue(source.concept_id)
    ?? textValue(source.nodeId)
    ?? textValue(source.node_id)
    ?? textValue(source.id)
    ?? textValue(source.concept)
    ?? textValue(source.routeId);
  if (!conceptId) return undefined;
  const reason = textValue(source.reason)
    ?? textValue(source.why)
    ?? textValue(source.explanation)
    ?? textValue(source.rationale)
    ?? "诊断结果表明可能已掌握";
  const rawConfidence = textValue(source.confidence)?.toLowerCase();
  const confidence: "high" | "medium" = rawConfidence === "high" || rawConfidence === "高" ? "high" : "medium";
  return { conceptId, reason, confidence };
}

export function normalizeDiagnosis(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, any>;
  const learnerProfileRaw = source.learnerProfile ?? source.profile ?? source.traits ?? [];
  const evidenceRaw = source.evidence ?? source.evidences ?? source.observations ?? [];
  const skipRaw = source.skipSuggestions ?? source.skips ?? source.knownConcepts ?? source.skipNodes ?? [];

  const evidence = (Array.isArray(evidenceRaw) ? evidenceRaw : [])
    .map((item) => normalizeQuoteImplication(item))
    .filter((item): item is { quote: string; implication: string } => Boolean(item));

  const skipSuggestions = (Array.isArray(skipRaw) ? skipRaw : [])
    .map((item) => normalizeSkipSuggestion(item))
    .filter((item): item is { conceptId: string; reason: string; confidence: "high" | "medium" } => Boolean(item));

  return {
    summary: textValue(source.summary) ?? textValue(source.diagnosis) ?? textValue(source.overview) ?? "已根据诊断答案形成学习起点",
    learnerProfile: Array.isArray(learnerProfileRaw)
      ? learnerProfileRaw.map((item: any) => textValue(item) ?? (item && typeof item === "object" ? JSON.stringify(item) : "")).filter(Boolean)
      : [],
    evidence,
    skipSuggestions,
  };
}

const questionPurposes = ["accurate", "explained", "discrimination", "transfer", "performance", "introduce"] as const;

export function normalizeTurnDecision(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, any>;
  const plan = source.responsePlan ?? source.plan ?? {};
  const pedagogyRaw = source.pedagogy ?? source.move ?? {};
  const rawNextQuestion = textValue(pedagogyRaw.nextQuestion)
    ?? textValue(plan.question)
    ?? "";
  const nextQuestion = isBannedQuestion(rawNextQuestion) ? "" : rawNextQuestion;
  const invented = textValue(pedagogyRaw.invented) ?? "";
  const questionPurposeRaw = textValue(pedagogyRaw.questionPurpose);
  const questionPurpose = questionPurposes.includes(questionPurposeRaw as typeof questionPurposes[number])
    ? questionPurposeRaw
    : "explained";
  const pedagogy = {
    hit: textValue(pedagogyRaw.hit) ?? textValue(source.understoodMeaning) ?? "",
    unpunched: textValue(pedagogyRaw.unpunched) ?? "",
    invented,
    nextLayer: textValue(pedagogyRaw.nextLayer) ?? textValue(plan.gapToRepair) ?? textValue(plan.teachingAtom) ?? "",
    sourceMove: textValue(pedagogyRaw.sourceMove) ?? textValue(plan.teachingAtom) ?? "",
    nextQuestion,
    questionPurpose,
    restatedBiography: pedagogyRaw.restatedBiography === true,
  };
  const nextAction = invented && (source.nextAction === "ask-clarification" || !source.nextAction)
    ? "repair-misconception"
    : source.nextAction ?? "ask-socratic-question";
  const evidence = (Array.isArray(source.evidence) ? source.evidence : [])
    .map((item: unknown) => normalizeQuoteImplication(item))
    .filter((item: { quote: string; implication: string } | undefined): item is { quote: string; implication: string } => Boolean(item));
  if (evidence.length === 0 && (pedagogy.hit || textValue(source.understoodMeaning))) {
    evidence.push({
      quote: pedagogy.hit || "学习者原话",
      implication: textValue(source.understoodMeaning) ?? "可继续用于本轮教学",
    });
  }
  const assessmentRaw = source.assessment ?? {};
  const assessmentEvidence = Array.isArray(assessmentRaw.evidence) ? assessmentRaw.evidence : [];
  return {
    intent: source.intent ?? "answer",
    understoodMeaning: textValue(source.understoodMeaning) ?? "已根据原话继续本轮教学",
    evidence,
    assessment: {
      status: assessmentRaw.status ?? "partial",
      score: typeof assessmentRaw.score === "number" ? assessmentRaw.score : undefined,
      rubricEvidence: Array.isArray(assessmentRaw.rubricEvidence) ? assessmentRaw.rubricEvidence : [],
      evidence: assessmentEvidence,
    },
    nextAction,
    responsePlan: {
      goal: textValue(plan.goal) ?? pedagogy.nextLayer ?? "继续当前节点",
      teachingAtom: textValue(plan.teachingAtom) ?? pedagogy.nextLayer ?? "当前节点",
      gapToRepair: textValue(plan.gapToRepair) ?? pedagogy.unpunched ?? pedagogy.nextLayer ?? "",
      keyPoints: Array.isArray(plan.keyPoints) ? plan.keyPoints : [pedagogy.nextLayer].filter(Boolean),
      allowedContent: Array.isArray(plan.allowedContent) ? plan.allowedContent : [],
      forbiddenContent: Array.isArray(plan.forbiddenContent) ? plan.forbiddenContent : ["后续节点", "完整课程讲解"],
      question: textValue(plan.question) || nextQuestion || undefined,
    },
    pedagogy,
    statePatch: {
      ...(source.statePatch ?? {}),
      addMisconception: textValue(source.statePatch?.addMisconception) || invented || undefined,
    },
  };
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

async function streamThinkThenJson<T>(input: {
  model: any;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  contract?: unknown;
  normalize?: (value: unknown) => unknown;
  signal?: AbortSignal;
  onThinking?: (text: string) => Promise<void> | void;
}): Promise<{ value: T; thinking: string }> {
  const result = streamText({
    model: input.model,
    abortSignal: input.signal,
    system: input.system,
    prompt: input.prompt,
  });

  let text = "";
  let nativeThinking = "";
  let emittedThinkingLength = 0;

  const emitThinking = async (chunk: string) => {
    if (!chunk) return;
    await input.onThinking?.(chunk);
  };

  for await (const part of result.fullStream) {
    if (part.type === "reasoning-delta") {
      const delta = "text" in part ? String(part.text ?? "") : "";
      nativeThinking += delta;
      await emitThinking(delta);
      continue;
    }
    if (part.type === "text-delta") {
      text += part.text;
      const prefix = thinkingPrefix(text);
      if (prefix.length > emittedThinkingLength) {
        await emitThinking(prefix.slice(emittedThinkingLength));
        emittedThinkingLength = prefix.length;
      }
    }
  }

  try {
    const split = splitThinkingAndJson(text);
    const value = input.schema.parse(input.normalize ? input.normalize(JSON.parse(split.json)) : JSON.parse(split.json));
    const thinking = [nativeThinking.trim(), split.thinking].filter(Boolean).join("\n\n");
    return { value, thinking };
  } catch (firstError) {
    const retry = await generateJson({
      model: input.model,
      schema: input.schema,
      system: "把用户提供的模型输出修复成符合要求的合法 JSON。只输出 JSON 对象，不要解释。",
      prompt: JSON.stringify({
        requiredContract: input.contract,
        originalOutput: text,
        validationError: String(firstError),
      }),
      contract: input.contract,
      normalize: input.normalize,
      signal: input.signal,
    });
    const thinking = [nativeThinking.trim(), thinkingPrefix(text).trim()].filter(Boolean).join("\n\n");
    return { value: retry, thinking };
  }
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
        "materials 非空时，它们是真实取得的搜索结果或用户材料。课程背景、核心内容、路线和例子必须优先以 materials 为依据，不得只凭模型记忆另起一套内容。",
        "每个路线节点的 target 必须写出进入教学时要介绍的具体背景、核心内容或例子，不能只写‘理解某概念’之类的抽象目标。",
        "核心概念必须在节点标题中明确出现，不能藏在‘基础知识’‘重要性’等泛化标题下。",
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
      contract: diagnosisContract,
      normalize: normalizeDiagnosis,
      system: [
        "你是通用私教的诊断编译器，只处理已经完成的结构化诊断答案。",
        "每条判断必须引用具体题目和所选选项，不能把已作答诊断解释成不知道或没有证据。",
        "诊断只描述学习起点，不要讲课程内容，也不要生成教学计划。",
        "学习对象是开放的；忠于用户目标，不根据类型擅自扩大课程范围。",
        "当前诊断是选择题，只用于判断讲解深浅和加快已有直觉的节点，不能证明完整掌握。",
        "skipSuggestions 标注学习者可能已有直觉的节点，供后续教学加快、不问已会的定义；编排器不会因此跳过节点。",
        "evidence 必须是 { quote, implication } 对象数组，禁止输出字符串数组。",
        "skipSuggestions 每项必须是 { conceptId, reason, confidence }，conceptId 必须对应 conceptRoute 中的 id。",
        `必须严格遵守字段要求：${JSON.stringify(diagnosisContract)}`,
      ].join("\n"),
      prompt: JSON.stringify({ answeredDiagnostics: input.answeredDiagnostics, topic: formatTopicContext(input.topicModel), currentState: input.state }),
    });
  }

  async analyzeTurn(input: {
    message: string;
    state: TutorState;
    topicModel: TopicModel;
    onThinking?: (text: string) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<TutorTurnDecision> {
    const activeConcept = input.topicModel.conceptRoute[input.state.activeConcept] ?? input.topicModel.conceptRoute[0];
    const activeRubric = input.topicModel.rubricAnchors.find((item) => item.conceptId === activeConcept?.id);
    const nodeState = activeConcept ? input.state.nodeLearningStates[activeConcept.id] : undefined;
    const lastAssistantMessage = [...input.state.messages].reverse().find((item) => item.role === "assistant");
    const lastQuestion = nodeState?.questionsAsked.at(-1) || lastAssistantMessage?.content || "";
    const timeoutSignal = AbortSignal.timeout(90_000);
    const abortSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const { value, thinking } = await streamThinkThenJson({
      model: this.model,
      schema: turnDecisionSchema,
      signal: abortSignal,
      contract: turnDecisionContract,
      normalize: normalizeTurnDecision,
      onThinking: input.onThinking,
      system: [
        "你是一对一私教。先写真实教学思考，再输出 JSON。思考是给开发者看的原文，不要写成条目摘要，不要写政策检查清单。",
        `思考第一句必须是：我问了「${lastQuestion.slice(0, 180) || "上一问"}」。他说了「${input.message.slice(0, 180)}」。`,
        "接着写：原话里对了哪半（引用原词）；哪个词用了但没打透；有没有发明源材料里没有的概念；本轮只补哪一层；下一问为什么换这一层。",
        "下一问必须来自当前节点，必须换一层（解释 / 场景迁移 / 辨析），必须带（是A还是B）支架。",
        "禁止摘要题：最关键的区别、机制或作用是什么。禁止再用一句话说明。禁止同义反复上一问。",
        "invented 非空时 nextAction 必须是 repair-misconception。questionsAsked 非空时 restatedBiography 必须为 false。",
        "用户说“不知道”不是错误答案；用户说“错了”是对老师的异议。",
        "思考写完后空一行，再输出一个 JSON 对象。JSON 字段：",
        JSON.stringify(turnDecisionContract),
      ].join("\n"),
      prompt: JSON.stringify({
        userMessage: input.message,
        lastAssistantMessage: lastAssistantMessage?.content ?? "",
        lastQuestion,
        questionsAsked: nodeState?.questionsAsked ?? [],
        activeConcept,
        activeRubric,
        currentEvidence: nodeState?.evidence ?? [],
        currentMisconceptions: nodeState?.misconceptions ?? [],
        learnerProfile: input.state.learnerProfile,
        knownIntuitions: input.state.knownIntuitions ?? [],
      }),
    });
    return { ...value, thinking };
  }

  async streamResponse(input: { message: string; state: TutorState; topicModel: TopicModel; decision: TutorTurnDecision }, onDelta: (text: string) => Promise<void> | void, signal?: AbortSignal): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(90_000);
    const abortSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const activeConcept = input.topicModel.conceptRoute[input.state.activeConcept];
    const nodeState = activeConcept ? input.state.nodeLearningStates[activeConcept.id] : undefined;
    const result = streamText({
      model: this.model,
      abortSignal,
      maxRetries: 1,
      system: [
        "你是一对一私教。根据教学诊断开口，不要暴露隐藏推理过程。",
        "结构：先回应对话中的原话（肯定 hit；把 unpunched 打透；invented 非空就当场叫停并纠正，那不是源材料里的东西），再只教 nextLayer / sourceMove 这一层，最后只问一个问题。",
        "问题优先用 pedagogy.nextQuestion 或 responsePlan.question。两者都空时，根据当前节点 target 现场设计一个带提示的对比、机制或场景题。",
        "禁止摘要题（最关键的区别 / 机制 / 作用是什么）。禁止复述题（再用一句话说明为什么会产生这种结果）。禁止同义反复上一问。",
        "questionsAsked 非空或 pedagogy.restatedBiography 为 false 时，禁止重讲人物背景、传记或节点开场故事。",
        "诊断开场（teachingAtom 含“诊断”或 phase 为 diagnose）：只用 1-2 句说明要摸底，立刻问诊断题。禁止讲解 coreOutcome，禁止给出定义或答案。",
        "首次进入节点（questionsAsked 为空且 questionPurpose 为 introduce）：先把 keyPoints / target 里不可推导的事实讲清楚，再问对比题，不要问课堂摘要。",
        "严格执行 forbiddenContent。不得一次总结整门课程，不得提前教授后续节点。",
        "如果用户表示不知道，降低难度并给例子；如果用户反驳，先承认并澄清，不要强行评价。",
      ].join("\n"),
      prompt: JSON.stringify({
        userMessage: input.message,
        phase: input.state.phase,
        topic: formatTopicContext(input.topicModel),
        decision: input.decision,
        pedagogy: input.decision.pedagogy,
        learnerProfile: input.state.learnerProfile,
        knownIntuitions: input.state.knownIntuitions ?? [],
        questionsAsked: nodeState?.questionsAsked ?? [],
        currentNodeState: nodeState,
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
