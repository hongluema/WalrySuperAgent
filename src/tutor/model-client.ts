import { generateText, streamText } from "ai";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { withAgentRules } from "../agent-md.js";
import type { TopicModel, TutorAnswerEvaluation, TutorDiagnosis, TutorTurnDecision, TutorState } from "./types.js";

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
  confidence: z.number().min(0).max(1).optional(),
});

const questionPurposeSchema = z.enum(["accurate", "explained", "discrimination", "transfer", "performance", "introduce", "doubt-check"]);
const diagnosticKindSchema = z.enum(["baseline", "motivation", "focus", "misconception", "constraints"]);

const answerEvaluationSchema = z.object({
  intent: z.enum(["answer", "dont_know", "no_doubts", "disagreement", "clarification", "direct_answer_request", "topic_switch", "meta_question", "stop"]),
  understoodMeaning: z.string(),
  observations: z.array(z.object({ quote: z.string(), implication: z.string() })),
  assessment: z.object({
    status: z.enum(["not-answered", "insufficient", "partial", "misconception", "mastered"]),
    score: z.number().min(0).max(100).optional(),
    rubricEvidence: z.array(z.string()),
    evidence: z.array(learningEvidenceSchema),
  }),
  misconceptionUpdates: z.array(z.object({
    description: z.string(),
    status: z.enum(["open", "repaired"]),
    evidenceQuote: z.string(),
  })),
  pedagogy: z.object({
    hit: z.string(),
    unpunched: z.string(),
    invented: z.string(),
    sourceMove: z.string(),
  }),
  questionCandidates: z.array(z.object({
    purpose: questionPurposeSchema,
    text: z.string(),
    thinkingHint: z.string().min(4),
  })).max(5),
});

const diagnosticOptionSchema = z.object({ id: z.string(), label: z.string() });
const topicModelSchema = z.object({
  id: z.string(),
  topic: z.string(),
  lessonTitle: z.string(),
  coreOutcome: z.string(),
  backgroundBrief: z.string().min(120).max(1600),
  diagnosticDimensions: z.array(z.object({
    id: z.string(),
    kind: diagnosticKindSchema,
    tab: z.string(),
    rationale: z.string(),
    teachingUse: z.string(),
    question: z.string(),
    thinkingHint: z.string().min(4),
    options: z.array(diagnosticOptionSchema).min(2).max(6),
  })).min(4).max(6),
  conceptRoute: z.array(z.object({
    id: z.string(),
    title: z.string(),
    target: z.string(),
    openingQuestion: z.string().min(4),
    openingHint: z.string().min(4),
  })).min(2).max(10),
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
}).superRefine((model, context) => {
  const kinds = new Set(model.diagnosticDimensions.map((item) => item.kind));
  for (const required of ["baseline", "motivation", "focus"] as const) {
    if (!kinds.has(required)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["diagnosticDimensions"],
        message: `诊断必须包含 ${required} 维度`,
      });
    }
  }
});

const diagnosisSchema = z.object({
  summary: z.string(),
  learnerProfile: z.array(z.string()).min(3).max(8),
  evidence: z.array(z.object({ quote: z.string(), implication: z.string() })),
  teachingApproach: z.object({
    startingPoint: z.string(),
    emphasis: z.array(z.string()).min(1).max(6),
    exampleContext: z.string(),
    pacing: z.string(),
    rationale: z.array(z.string()).min(3).max(8),
  }),
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
  evaluateAnswer(input: {
    message: string;
    state: TutorState;
    topicModel: TopicModel;
  }, signal?: AbortSignal): Promise<TutorAnswerEvaluation>;
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
    backgroundBrief: model.backgroundBrief,
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
  requiredFields: ["id", "topic", "lessonTitle", "coreOutcome", "backgroundBrief", "diagnosticDimensions", "conceptRoute", "boundaryCases", "practiceTarget", "rubricAnchors", "evidenceSources", "confidence", "subject", "grounding", "capabilities"],
  diagnosticDimensionFields: ["id", "kind: baseline|motivation|focus|misconception|constraints", "tab", "rationale", "teachingUse", "question", "thinkingHint", "options: { id: A|B|C..., label }[]"],
  conceptRouteFields: ["id", "title", "target", "openingQuestion", "openingHint"],
  rubricFields: ["conceptId", "accuracy", "explanation", "discrimination", "transfer", "performance?"],
  subjectFields: ["kind", "description", "userGoal"],
  groundingFields: ["mode", "sources: { label, verified }[]", "limitations"],
  capabilityFields: ["acquisition", "structuring", "interaction", "assessment", "missing"],
};

const answerEvaluationContract = {
  requiredFields: ["intent", "understoodMeaning", "observations", "assessment", "misconceptionUpdates", "pedagogy", "questionCandidates"],
  intentValues: ["answer", "dont_know", "no_doubts", "disagreement", "clarification", "direct_answer_request", "topic_switch", "meta_question", "stop"],
  assessmentStatusValues: ["not-answered", "insufficient", "partial", "misconception", "mastered"],
  assessmentFields: ["status", "score?", "rubricEvidence: string[]", "evidence"],
  evidenceFields: ["learnerQuote", "criterion: accurate|explained|discrimination|transfer|performance", "strength: weak|sufficient", "confidence?"],
  misconceptionUpdateFields: ["description", "status: open|repaired", "evidenceQuote"],
  pedagogyFields: ["hit: string", "unpunched: string", "invented: string", "sourceMove: string"],
  questionCandidateFields: ["purpose: accurate|explained|discrimination|transfer|performance|introduce|doubt-check", "text", "thinkingHint"],
};

const diagnosisContract = {
  requiredFields: ["summary", "learnerProfile", "evidence", "teachingApproach", "skipSuggestions"],
  evidenceFields: ["quote", "implication"],
  teachingApproachFields: ["startingPoint", "emphasis", "exampleContext", "pacing", "rationale"],
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

function letterOptionId(index: number): string {
  return String.fromCharCode(65 + index);
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

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textValue(item) ?? "").filter(Boolean).join("；");
  return textValue(value) ?? "";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => textValue(item) ?? "").filter(Boolean);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map((item) => textValue(item) ?? "").filter(Boolean);
  const text = textValue(value);
  return text ? [text] : [];
}

function mapCriterion(value: unknown): string | undefined {
  const raw = textValue(value)?.toLowerCase().replace(/_/g, "-");
  if (raw === "accuracy") return "accurate";
  if (raw === "explanation") return "explained";
  return raw;
}

function mapStrength(value: unknown): string | undefined {
  const raw = textValue(value)?.toLowerCase();
  if (raw === "partial" || raw === "none" || raw === "insufficient") return "weak";
  return raw;
}

function mapStatus(value: unknown): string | undefined {
  const raw = textValue(value)?.toLowerCase().replace(/_/g, "-");
  if (raw === "in-progress") return "partial";
  return raw;
}

function percentScore(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  if (value > 0 && value <= 1) return Math.round(value * 100);
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function normalizeEvaluation(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, any>;
  const assessment = source.assessment ?? {};
  const pedagogy = source.pedagogy ?? {};
  const observationsRaw = source.observations ?? [];
  const evidenceRaw = assessment.evidence ?? [];
  const candidatesRaw = source.questionCandidates ?? [];
  const updatesRaw = source.misconceptionUpdates ?? [];

  return {
    ...source,
    understoodMeaning: textValue(source.understoodMeaning) ?? asString(source.understoodMeaning),
    observations: (Array.isArray(observationsRaw) ? observationsRaw : [])
      .map((item) => normalizeQuoteImplication(item))
      .filter((item): item is { quote: string; implication: string } => Boolean(item)),
    assessment: {
      ...assessment,
      status: mapStatus(assessment.status) ?? assessment.status,
      score: percentScore(assessment.score) ?? assessment.score,
      rubricEvidence: asStringArray(assessment.rubricEvidence),
      evidence: (Array.isArray(evidenceRaw) ? evidenceRaw : []).map((item: any) => ({
        learnerQuote: textValue(item?.learnerQuote) ?? textValue(item?.quote) ?? asString(item?.learnerQuote),
        criterion: mapCriterion(item?.criterion) ?? item?.criterion,
        strength: mapStrength(item?.strength) ?? item?.strength,
        confidence: typeof item?.confidence === "number" ? item.confidence : undefined,
      })),
    },
    misconceptionUpdates: Array.isArray(updatesRaw) ? updatesRaw : [],
    pedagogy: {
      hit: asString(pedagogy.hit),
      unpunched: asString(pedagogy.unpunched),
      invented: asString(pedagogy.invented),
      sourceMove: asString(pedagogy.sourceMove),
    },
    questionCandidates: (Array.isArray(candidatesRaw) ? candidatesRaw : []).map((item: any) => ({
      purpose: mapCriterion(item?.purpose) ?? item?.purpose,
      text: textValue(item?.text) ?? asString(item?.text),
      thinkingHint: textValue(item?.thinkingHint) || "从刚才的原话里找还没说清的一层",
    })),
  };
}

function diagnosticKind(value: unknown, index: number): "baseline" | "motivation" | "focus" | "misconception" | "constraints" {
  const normalized = textValue(value)?.toLowerCase();
  if (normalized === "baseline" || normalized === "motivation" || normalized === "focus" || normalized === "misconception" || normalized === "constraints") {
    return normalized;
  }
  return (["baseline", "motivation", "focus", "misconception", "constraints"] as const)[Math.min(index, 4)];
}

export function normalizeDiagnosis(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, any>;
  const learnerProfileRaw = source.learnerProfile ?? source.profile ?? source.traits ?? [];
  const evidenceRaw = source.evidence ?? source.evidences ?? source.observations ?? [];
  const skipRaw = source.skipSuggestions ?? source.skips ?? source.knownConcepts ?? source.skipNodes ?? [];
  const approach = source.teachingApproach ?? source.teachingStrategy ?? source.adaptation ?? {};

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
    teachingApproach: {
      startingPoint: textValue(approach.startingPoint) ?? textValue(approach.start) ?? "从学习者当前能理解的整体框架开始",
      emphasis: Array.isArray(approach.emphasis) ? approach.emphasis.map(String).filter(Boolean) : ["围绕学习者最关心的内容安排案例和练习"],
      exampleContext: textValue(approach.exampleContext) ?? textValue(approach.examples) ?? "优先使用与学习动机最接近的真实场景",
      pacing: textValue(approach.pacing) ?? textValue(approach.depth) ?? "已知直觉快速确认，陌生概念逐层展开",
      rationale: Array.isArray(approach.rationale)
        ? approach.rationale.map(String).filter(Boolean)
        : ["依据已有经验调整起点", "依据学习动机选择案例", "依据内容侧重调整讲解比重"],
    },
    skipSuggestions,
  };
}

export function normalizeTopicModel(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, any>;
  const dimensions = source.diagnosticDimensions ?? source.diagnostics ?? source.dimensions ?? [];
  const route = source.conceptRoute ?? source.learningRoute ?? source.learningPath ?? source.route ?? source.concepts ?? [];
  const boundaryCases = source.boundaryCases ?? source.boundaries ?? source.edgeCases ?? [];
  const rubrics = source.rubricAnchors ?? source.rubrics ?? source.masteryRubrics ?? [];
  const lessonTitle = textValue(source.lessonTitle) ?? textValue(source.title) ?? textValue(source.name) ?? "当前学习主题";
  const coreOutcome = textValue(source.coreOutcome) ?? textValue(source.expectedOutcome) ?? textValue(source.outcome) ?? textValue(source.goal) ?? "理解并应用当前学习主题";
  const routeTitles = Array.isArray(route)
    ? route.map((item: any) => textValue(item?.title) ?? textValue(item?.name) ?? textValue(item?.concept)).filter(Boolean).join("、")
    : "";
  const backgroundBrief = textValue(source.backgroundBrief)
    ?? textValue(source.topicBackground)
    ?? textValue(source.background)
    ?? `${lessonTitle}是本次需要系统理解的学习对象。它要解决的核心问题是：${coreOutcome}。为了形成完整认识，需要先知道它产生的背景和适用场景，再理解其中的关键概念、组成部分与作用关系，最后通过辨析和实际情境验证理解。课程会围绕${routeTitles || "基础定位、核心机制、边界辨析和实践应用"}逐层展开，而不是只记住一个定义或几条结论。学习时还要特别区分主题本身的核心原则、常见误解和超出本课程范围的延伸内容，这样才能知道它是什么、为什么有用、在什么条件下适用，以及遇到真实问题时应该如何判断。`;

  return {
    id: textValue(source.id) ?? `topic-${Date.now().toString(36)}`,
    topic: textValue(source.topic) ?? textValue(source.topicId) ?? "general",
    lessonTitle,
    coreOutcome,
    backgroundBrief,
    diagnosticDimensions: Array.isArray(dimensions) ? dimensions.map((item: any, index: number) => {
      const options = item?.options ?? item?.choices ?? item?.answers ?? [];
      return {
        id: textValue(item?.id) ?? textValue(item?.key) ?? `dimension-${index + 1}`,
        kind: diagnosticKind(item?.kind ?? item?.type ?? item?.aspect, index),
        tab: textValue(item?.tab) ?? textValue(item?.name) ?? textValue(item?.title) ?? textValue(item?.dimension) ?? `学习维度 ${index + 1}`,
        rationale: textValue(item?.rationale) ?? textValue(item?.reason) ?? "这个信息会影响讲解起点、重点或练习方式",
        teachingUse: textValue(item?.teachingUse) ?? textValue(item?.use) ?? textValue(item?.impact) ?? "根据答案调整后续教学的深浅和侧重",
        question: textValue(item?.question) ?? textValue(item?.prompt) ?? textValue(item?.description) ?? textValue(item?.goal) ?? textValue(item?.问题),
        thinkingHint: textValue(item?.thinkingHint) ?? textValue(item?.hint) ?? "按你目前最真实的情况选择，不需要猜标准答案",
        options: Array.isArray(options) ? options.map((option: any, optionIndex: number) => ({
          id: letterOptionId(optionIndex),
          label: textValue(option?.label) ?? textValue(option?.text) ?? textValue(option?.description) ?? textValue(option?.内容),
        })) : options,
      };
    }) : dimensions,
    conceptRoute: Array.isArray(route) ? route.map((item: any, index: number) => ({
      id: textValue(item?.id) ?? textValue(item?.key) ?? `concept-${index + 1}`,
      title: textValue(item?.title) ?? textValue(item?.name) ?? textValue(item?.concept) ?? textValue(item?.label) ?? textValue(item?.名称),
      target: textValue(item?.target) ?? textValue(item?.outcome) ?? textValue(item?.description) ?? textValue(item?.goal) ?? textValue(item?.目标),
      openingQuestion: textValue(item?.openingQuestion) ?? textValue(item?.firstQuestion)
        ?? `如果把“${textValue(item?.title) ?? textValue(item?.name) ?? "这个知识点"}”放进一个具体场景，你会先关注什么？`,
      openingHint: textValue(item?.openingHint) ?? textValue(item?.questionHint)
        ?? `先从“${textValue(item?.target) ?? textValue(item?.description) ?? "这个知识点的核心内容"}”中找一个会影响判断的条件`,
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
    system: withAgentRules(`${input.system}\n只输出一个合法 JSON 对象，不要输出 Markdown、解释或代码围栏。`),
    prompt: input.prompt,
  });

  try {
    const parsed = JSON.parse(extractJson(result.text));
    return input.schema.parse(input.normalize ? input.normalize(parsed) : parsed);
  } catch (firstError) {
    const retry = await generateText({
      model: input.model,
      abortSignal: input.signal,
      system: withAgentRules("把用户提供的模型输出修复成符合要求的合法 JSON。只输出 JSON 对象，不要解释。自然语言字段使用简体中文。"),
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
        "你是一位优秀、专业、会因材施教的一对一私教老师，同时负责课程设计。",
        "你不能依赖预设主题列表，必须为任意用户主题动态建立 TopicModel。",
        "不要把学习对象归入封闭类型枚举；subject.kind 是开放标签。请按知识取得、内容组织、教学互动、掌握验证四组能力描述任务。",
        "忠于用户原始学习对象和目标，不得擅自扩张成更大的领域课程、考试课或项目课。",
        "只有真实提供或检索到的来源 verified 才能为 true；模型已有知识不是已验证研究。",
        "materials 非空时，它们是真实取得的搜索结果或用户材料。课程背景、核心内容、路线和例子必须优先以 materials 为依据，不得只凭模型记忆另起一套内容。",
        "先真正理解这个学习主题是什么、能解决什么问题、典型使用场景和边界，再决定为了教好它需要先了解学生哪些方面；不能先套一组固定题再往主题里填词。",
        "backgroundBrief 必须是一段可独立阅读的主题摘要，建议 300-600 个中文字符。读者只读这一段，也应大致知道：主题是什么、为何产生或要解决什么问题、核心组成/机制、典型用途、适用边界，以及接下来会学什么。不能只写两三句定义。",
        "每个路线节点的 target 必须写出进入教学时要介绍的具体背景、核心内容或例子，不能只写‘理解某概念’之类的抽象目标。",
        "每个路线节点都必须预先设计 openingQuestion 和 openingHint。openingQuestion 是老师讲完该节点第一个最小知识块后，用来摸学生当前理解的主题专属问题；应要求判断、比较、解释或联系真实场景，不能让学生复述摘要。openingHint 只给思考入口，不能泄露答案。",
        "核心概念必须在节点标题中明确出现，不能藏在‘基础知识’‘重要性’等泛化标题下。",
        "像专业私教一样设计 4-5 道高信息量摸底题：必须覆盖 baseline（了解程度/既往经验）、motivation（学习动机/未来用途）、focus（最想深入的内容侧重）；再按主题需要选择 misconception（真实判断/常见误区）或 constraints（时间、工具、场景等约束）。",
        "每道题都必须填写 rationale（为什么一个好老师需要知道它）和 teachingUse（不同回答会怎样改变后续讲解、案例或练习），避免收集不会影响教学的无用信息。",
        "baseline 不能只让学生自评分数，至少结合一次既往接触、口头理解或真实判断校准。至少一题要求用户完成真实判断，不要全部使用自我评价题，也不要在诊断前泄露答案。",
        "当前诊断卡只支持单选：每题必须能仅靠选择一个 option 完整作答，禁止要求额外写一句话、补充说明、多选或选择 1-2 项。需要校准理解时，用单独的 misconception 真实判断题完成。",
        "每道诊断题的 options.id 必须按出现顺序依次为 A、B、C、D（最多到 F）。id 是给学习者看的选项序号，禁止使用 opt-misc-1、choice_1 这类内部键。",
        "每道诊断题提供 thinkingHint：只指出回忆或思考方向，不暗示正确选项，不替学生作答。",
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
        "必须分别归纳学习者的真实起点、学习动机/使用场景、内容侧重以及现实约束；不能只按答对几题总结成‘初级/中级’。",
        "teachingApproach 是可执行的因材施教方案：startingPoint 决定从哪里开讲；emphasis 决定哪些内容加重；exampleContext 决定用什么场景举例；pacing 决定哪些快讲或慢练；rationale 必须逐条引用诊断答案说明为什么这样教。",
        "skipSuggestions 标注学习者可能已有直觉的节点，供后续教学加快、不问已会的定义；编排器不会因此跳过节点。",
        "evidence 必须是 { quote, implication } 对象数组，禁止输出字符串数组。",
        "skipSuggestions 每项必须是 { conceptId, reason, confidence }，conceptId 必须对应 conceptRoute 中的 id。",
        `必须严格遵守字段要求：${JSON.stringify(diagnosisContract)}`,
      ].join("\n"),
      prompt: JSON.stringify({ answeredDiagnostics: input.answeredDiagnostics, topic: formatTopicContext(input.topicModel), currentState: input.state }),
    });
  }

  async evaluateAnswer(input: {
    message: string;
    state: TutorState;
    topicModel: TopicModel;
  }, signal?: AbortSignal): Promise<TutorAnswerEvaluation> {
    const activeConcept = input.topicModel.conceptRoute[input.state.activeConcept] ?? input.topicModel.conceptRoute[0];
    const activeRubric = input.topicModel.rubricAnchors.find((item) => item.conceptId === activeConcept?.id);
    const nodeState = activeConcept ? input.state.nodeLearningStates[activeConcept.id] : undefined;
    const lastAssistantMessage = [...input.state.messages].reverse().find((item) => item.role === "assistant");
    const lastQuestion = nodeState?.questionsAsked.at(-1) || lastAssistantMessage?.content || "";
    const timeoutSignal = AbortSignal.timeout(180_000);
    const abortSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return generateJson({
      model: this.model,
      schema: answerEvaluationSchema,
      signal: abortSignal,
      contract: answerEvaluationContract,
      normalize: normalizeEvaluation,
      system: [
        "你是答案证据评估器，不负责决定教学阶段，不负责直接教学，也不能标记节点完成。",
        "只根据学生原话和给定 Rubric 评估可观察证据；不得替学生补全观点，不得因为表达流畅就判定掌握。",
        "observations 与 assessment.evidence 必须引用学生实际说过的词句。",
        "区分 hit（已经证明的部分）、unpunched（提到但没打透）、invented（与来源或边界冲突的概念）。",
        "同一个回答可以包含多个信号，但只有直接被原话支持的维度才可标 sufficient；猜对结论不能自动证明解释、辨析或迁移。",
        "confidence 表示证据映射置信度，不是对学生的总体分数。",
        "如果学生明确说不知道，intent=dont_know，不能记充分证据；如果要求直接讲，intent=direct_answer_request。",
        "只有当前节点处于 doubt-check 且学生明确表示没有疑问时，intent 才是 no_doubts；没有疑问本身不是掌握证据。",
        "misconceptionUpdates 中，open 记录新误区；repaired 只能复制 currentMisconceptions 中已有 description，并由本轮原话明确证明已修复。",
        "questionCandidates 只是候选探针，不得决定 nextAction。每个候选必须绑定一个 purpose，并来自当前节点。",
        "每个 questionCandidate 必须提供 thinkingHint，只提示思考方向、比较维度或可回忆的经历，不能泄露答案。",
        "禁止摘要题：最关键的区别、机制或作用是什么。禁止再用一句话说明。禁止同义反复上一问。",
        `必须严格返回：${JSON.stringify(answerEvaluationContract)}`,
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
        currentStage: nodeState?.stage ?? "elicit",
        lastQuestionPurpose: nodeState?.lastQuestionPurpose,
        hintLevel: nodeState?.hintLevel ?? 0,
        grounding: input.topicModel.grounding,
        evidenceSources: input.topicModel.evidenceSources,
        boundaryCases: input.topicModel.boundaryCases,
        learnerProfile: input.state.learnerProfile,
        teachingApproach: input.state.teachingApproach,
        knownIntuitions: input.state.knownIntuitions ?? [],
      }),
    });
  }

  async streamResponse(input: { message: string; state: TutorState; topicModel: TopicModel; decision: TutorTurnDecision }, onDelta: (text: string) => Promise<void> | void, signal?: AbortSignal): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(180_000);
    const abortSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const activeConcept = input.topicModel.conceptRoute[input.state.activeConcept];
    const nodeState = activeConcept ? input.state.nodeLearningStates[activeConcept.id] : undefined;
    const result = streamText({
      model: this.model,
      abortSignal,
      maxRetries: 1,
      system: withAgentRules([
        "你是一对一私教。根据教学诊断开口，不要暴露隐藏推理过程。",
        "teachingApproach 是诊断后形成的因材施教约束：必须从 startingPoint 开始，优先覆盖 emphasis，例子贴近 exampleContext，并按 pacing 控制深浅；不能生成了画像却仍按通用模板教学。",
        "结构：先回应对话中的原话（肯定 hit；把 unpunched 打透；invented 非空就当场叫停并纠正，那不是源材料里的东西），再只教 nextLayer / sourceMove 这一层，最后只问一个问题。只要仍处于 teach 阶段且不是 complete 或 switch-topic，老师就不能讲完停住。",
        "问题优先逐字使用 pedagogy.nextQuestion 或 responsePlan.question。两者都空且 nextAction 需要继续取证时，才根据 questionPurpose 设计一个带提示的对比、机制或场景题。",
        "凡是向学习者提问，问题后必须紧跟全角括号提示，格式为：问题？（思路：从……方向想一想。）提示只给思考入口，不得直接包含答案或标准结论。",
        "nextAction=complete 或 switch-topic 时不得自行追加问题。其他 teach 阶段必须逐字使用给定的 pedagogy.nextQuestion / responsePlan.question，并以它结束回复；nextAction=advance-concept 时先收束旧节点、只介绍新节点的一个最小知识块，再问新节点问题。",
        "questionPurpose=doubt-check 时只能使用给定的疑问检查问题，不得再加考核题。整条回复最多出现一个问号。",
        "禁止摘要题（最关键的区别 / 机制 / 作用是什么）。禁止复述题（再用一句话说明为什么会产生这种结果）。禁止同义反复上一问。",
        "questionsAsked 非空或 pedagogy.restatedBiography 为 false 时，禁止重讲人物背景、传记或节点开场故事。",
        "诊断开场（teachingAtom 含“诊断”或 phase 为 diagnose）：只用 1-2 句说明要摸底，立刻问诊断题。禁止讲解 coreOutcome，禁止给出定义或答案。",
        "首次正式教学且 responsePlan.backgroundBrief 非空时，先输出“主题背景”，完整讲清该摘要，再进入第一个知识节点；不能把背景压缩成几句开场白，也不要重复整条学习路线。",
        "首次进入节点（questionsAsked 为空且 questionPurpose 为 introduce）：先把 keyPoints / target 里不可推导的事实讲清楚，再问对比题，不要问课堂摘要。",
        "严格执行 forbiddenContent。不得一次总结整门课程，不得提前教授后续节点。",
        "如果用户表示不知道，降低难度并给例子；如果用户反驳，先承认并澄清，不要强行评价。",
      ].join("\n")),
      prompt: JSON.stringify({
        userMessage: input.message,
        phase: input.state.phase,
        topic: formatTopicContext(input.topicModel),
        decision: input.decision,
        pedagogy: input.decision.pedagogy,
        learnerProfile: input.state.learnerProfile,
        teachingApproach: input.state.teachingApproach,
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
