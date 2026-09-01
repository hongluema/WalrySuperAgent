import type {
  DomainPackId,
  EvidenceCriterion,
  KnowledgeType,
  MacroDomain,
  SubjectClassification,
  SubjectCorrection,
  TopicModel,
} from "../types.js";

export const SUBJECT_CLASSIFIER_VERSION = "subject-classifier.v1";
export const DOMAIN_CATALOG_VERSION = "domain-catalog.v1";
export const MASTERY_POLICY_VERSION = "mastery-policy.v1";

export const MACRO_DOMAINS = [
  "formal-sciences",
  "natural-and-health-sciences",
  "computing-and-engineering",
  "social-and-behavioral-sciences",
  "business-economics-and-law",
  "humanities",
  "language-and-communication",
  "arts-and-design",
  "life-and-work-practice",
] as const satisfies readonly MacroDomain[];

export const MACRO_DOMAIN_LABELS: Record<MacroDomain, string> = {
  "formal-sciences": "形式科学",
  "natural-and-health-sciences": "自然与健康科学",
  "computing-and-engineering": "计算与工程",
  "social-and-behavioral-sciences": "社会与行为科学",
  "business-economics-and-law": "商业、经济与法律",
  humanities: "人文学科",
  "language-and-communication": "语言与传播",
  "arts-and-design": "艺术与设计",
  "life-and-work-practice": "生活与工作实践",
};

export const KNOWLEDGE_TYPES = [
  "factual",
  "conceptual",
  "causal",
  "procedural",
  "formal",
  "strategic",
  "language",
  "argument",
] as const satisfies readonly KnowledgeType[];

type DomainPack = {
  id: DomainPackId;
  requiredCapabilities: string[];
};

const PACKS: Record<DomainPackId, DomainPack> = {
  generic: {
    id: "generic",
    requiredCapabilities: ["source-grounding", "adaptive-dialogue"],
  },
  "formal-stem": {
    id: "formal-stem",
    requiredCapabilities: ["symbolic-reasoning", "worked-example", "step-check"],
  },
  "software-engineering": {
    id: "software-engineering",
    requiredCapabilities: ["code-reading", "code-execution", "test-verification"],
  },
  "language-communication": {
    id: "language-communication",
    requiredCapabilities: ["production-sample", "rubric-assessment"],
  },
  "argument-case": {
    id: "argument-case",
    requiredCapabilities: ["claim-evidence-analysis", "case-comparison"],
  },
  "high-risk-policy": {
    id: "high-risk-policy",
    requiredCapabilities: ["source-verification", "safety-review"],
  },
};

const DOMAIN_RULES: Array<{ domain: MacroDomain; pattern: RegExp; subdomain: string }> = [
  { domain: "computing-and-engineering", pattern: /(?:编程|代码|软件|计算机|后端|前端|数据库|算法工程|api|typescript|javascript|python|java|工程)/iu, subdomain: "计算与工程" },
  { domain: "formal-sciences", pattern: /(?:数学|概率|统计|贝叶斯|逻辑|集合|代数|几何|微积分|证明|公式|运筹)/u, subdomain: "数学与形式科学" },
  { domain: "natural-and-health-sciences", pattern: /(?:物理|化学|生物|医学|临床|健康|药学|护理|营养|天文|地质|环境科学)/u, subdomain: "自然与健康科学" },
  { domain: "business-economics-and-law", pattern: /(?:商业|经济|金融|投资|会计|市场营销|管理|运营|法律|法学|合规|财务)/u, subdomain: "商业、经济与法律" },
  { domain: "social-and-behavioral-sciences", pattern: /(?:心理|社会学|教育学|政治学|人类学|行为科学|公共管理|国际关系)/u, subdomain: "社会与行为科学" },
  { domain: "language-and-communication", pattern: /(?:语言|英语|中文|日语|法语|翻译|写作|演讲|沟通|表达|语法|词汇)/u, subdomain: "语言与传播" },
  { domain: "arts-and-design", pattern: /(?:艺术|设计|绘画|音乐|影视|摄影|建筑|舞蹈|戏剧|美术)/u, subdomain: "艺术与设计" },
  { domain: "humanities", pattern: /(?:历史|哲学|文学|宗教|伦理|文化|古典|史学|论证分析)/u, subdomain: "人文学科" },
];

const TYPE_RULES: Array<{ type: KnowledgeType; pattern: RegExp }> = [
  { type: "procedural", pattern: /(?:怎么做|如何做|步骤|流程|操作|实操|实践|部署|开发|编程|代码|调试|配置|执行|完成任务)/u },
  { type: "formal", pattern: /(?:公式|计算|证明|推导|定理|概率|统计|数学|逻辑符号|算法复杂度)/u },
  { type: "language", pattern: /(?:语言|语法|词汇|翻译|写作|演讲|沟通|表达|听力|口语)/u },
  { type: "argument", pattern: /(?:论证|观点|主张|证据|批判|评论|文章分析|案例分析)/u },
  { type: "strategic", pattern: /(?:战略|策略|决策|投资|管理|规划|取舍|博弈)/u },
  { type: "causal", pattern: /(?:原因|因果|机制|为什么|如何导致|作用关系|影响因素)/u },
  { type: "factual", pattern: /(?:事实|年代|日期|名称|术语|清单|记忆|识别)/u },
];

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function subjectText(model: TopicModel): string {
  return [model.topic, model.lessonTitle, model.coreOutcome, model.subject?.description, model.subject?.userGoal]
    .filter(Boolean)
    .join(" ");
}

function inferSubject(model: TopicModel): SubjectClassification {
  const text = subjectText(model);
  const matched = DOMAIN_RULES.filter((rule) => rule.pattern.test(text));
  const primary = matched[0] ?? {
    domain: "life-and-work-practice" as const,
    subdomain: "生活与工作实践",
  };
  return {
    macroDomain: primary.domain,
    subdomainPath: [primary.subdomain],
    secondaryDomains: unique(matched.slice(1).map((item) => item.domain)).filter((item) => item !== primary.domain),
    confidence: matched.length > 0 ? 0.84 : 0.55,
    source: "inferred",
    version: SUBJECT_CLASSIFIER_VERSION,
  };
}

function inferKnowledgeTypes(model: TopicModel, node: TopicModel["conceptRoute"][number]): KnowledgeType[] {
  const text = `${subjectText(model)} ${node.title} ${node.target}`;
  const matches = unique(TYPE_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.type));
  return matches.length > 0 ? matches.slice(0, 3) : ["conceptual"];
}

function resolvePackIds(model: TopicModel, classification: SubjectClassification, knowledgeTypes: KnowledgeType[][]): DomainPackId[] {
  const text = subjectText(model);
  const allTypes = new Set(knowledgeTypes.flat());
  const ids: DomainPackId[] = ["generic"];
  if (["formal-sciences", "natural-and-health-sciences"].includes(classification.macroDomain) || allTypes.has("formal")) ids.push("formal-stem");
  if (/(?:编程|代码|软件|计算机|前端|后端|数据库|api|typescript|javascript|python|java)/iu.test(text)) ids.push("software-engineering");
  if (classification.macroDomain === "language-and-communication" || allTypes.has("language")) ids.push("language-communication");
  if (allTypes.has("argument") || allTypes.has("strategic")) ids.push("argument-case");
  if (/(?:医学|临床|健康|药学|法律|合规|金融|投资)/u.test(text)) ids.push("high-risk-policy");
  return unique(ids);
}

/**
 * A pure catalog seam: it enriches a TopicModel with domain defaults and
 * constraints, while the orchestrator remains the owner of teaching state.
 */
export class DomainCatalog {
  enrich(model: TopicModel): TopicModel {
    const classification = model.subjectClassification?.source === "user-corrected"
      || model.subjectClassification?.version === SUBJECT_CLASSIFIER_VERSION
      ? model.subjectClassification
      : inferSubject(model);
    const routeKnowledgeTypes = model.conceptRoute.map((node) => (
      node.knowledgeTypes?.length ? unique(node.knowledgeTypes) : inferKnowledgeTypes(model, node)
    ));
    const domainPackIds = resolvePackIds(model, classification, routeKnowledgeTypes);
    const packCapabilities = unique(domainPackIds.flatMap((id) => PACKS[id].requiredCapabilities));

    return {
      ...model,
      subjectClassification: classification,
      domainPackIds,
      domainCatalogVersion: DOMAIN_CATALOG_VERSION,
      conceptRoute: model.conceptRoute.map((node, index) => ({
        ...node,
        knowledgeTypes: routeKnowledgeTypes[index],
        requiredCapabilities: unique([...(node.requiredCapabilities ?? []), ...packCapabilities]),
      })),
    };
  }

  correctSubject(model: TopicModel, correction: SubjectCorrection): TopicModel {
    const classification: SubjectClassification = {
      macroDomain: correction.macroDomain,
      subdomainPath: unique((correction.subdomainPath ?? []).map((item) => item.trim()).filter(Boolean)),
      secondaryDomains: unique(correction.secondaryDomains ?? [])
        .filter((item) => item !== correction.macroDomain),
      confidence: 1,
      source: "user-corrected",
      version: SUBJECT_CLASSIFIER_VERSION,
    };
    return this.enrich({ ...model, subjectClassification: classification });
  }
}

const CRITERIA_BY_TYPE: Record<KnowledgeType, EvidenceCriterion[]> = {
  factual: ["accurate", "discrimination"],
  conceptual: ["accurate", "explained", "discrimination", "transfer"],
  causal: ["accurate", "explained", "discrimination", "transfer"],
  procedural: ["accurate", "transfer"],
  formal: ["accurate", "explained", "transfer"],
  strategic: ["explained", "discrimination", "transfer"],
  language: ["accurate", "discrimination", "transfer"],
  argument: ["explained", "discrimination", "transfer"],
};

const CRITERIA_ORDER: EvidenceCriterion[] = ["accurate", "explained", "discrimination", "transfer", "performance"];

export function resolveMasteryPolicy(model: TopicModel, nodeIndex: number): {
  requiredCriteria: EvidenceCriterion[];
  knowledgeTypes: KnowledgeType[];
  version: string;
} {
  const node = model.conceptRoute[nodeIndex] ?? model.conceptRoute[0];
  const knowledgeTypes = node?.knowledgeTypes?.length ? unique(node.knowledgeTypes) : ["conceptual" as const];
  const rubric = model.rubricAnchors.find((item) => item.conceptId === node?.id);
  const criteria = unique(knowledgeTypes.flatMap((type) => CRITERIA_BY_TYPE[type]));
  if (rubric?.performance?.trim() && knowledgeTypes.some((type) => type === "procedural" || type === "formal" || type === "language")) {
    criteria.push("performance");
  }
  return {
    requiredCriteria: CRITERIA_ORDER.filter((criterion) => criteria.includes(criterion)),
    knowledgeTypes,
    version: MASTERY_POLICY_VERSION,
  };
}

export function isMacroDomain(value: unknown): value is MacroDomain {
  return typeof value === "string" && (MACRO_DOMAINS as readonly string[]).includes(value);
}

export function isKnowledgeType(value: unknown): value is KnowledgeType {
  return typeof value === "string" && (KNOWLEDGE_TYPES as readonly string[]).includes(value);
}
