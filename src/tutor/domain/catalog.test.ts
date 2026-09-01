import assert from "node:assert/strict";
import test from "node:test";
import { DomainCatalog, resolveMasteryPolicy } from "./catalog.js";
import type { TopicModel } from "../types.js";

function model(topic: string): TopicModel {
  return {
    id: "domain-test",
    topic,
    lessonTitle: topic,
    coreOutcome: `掌握${topic}`,
    backgroundBrief: "用于验证领域分类和知识类型默认值的学习主题。".repeat(8),
    diagnosticDimensions: [],
    conceptRoute: [{
      id: "node-1",
      title: "核心节点",
      target: "解释并应用核心节点",
      openingQuestion: "你会怎样判断？",
      openingHint: "先找关键条件",
    }],
    boundaryCases: [],
    practiceTarget: "完成一个任务",
    rubricAnchors: [{
      conceptId: "node-1",
      accuracy: "准确",
      explanation: "解释",
      discrimination: "辨析",
      transfer: "迁移",
    }],
    evidenceSources: [],
    confidence: 0.8,
    subject: { kind: "open", description: topic, userGoal: `学习${topic}` },
    grounding: { mode: "model-knowledge", sources: [], limitations: [] },
    capabilities: { acquisition: [], structuring: [], interaction: [], assessment: [], missing: [] },
  };
}

test("classifies a subject into one of nine macro domains and selects packs", () => {
  const enriched = new DomainCatalog().enrich(model("概率论与贝叶斯推断"));

  assert.equal(enriched.subjectClassification?.macroDomain, "formal-sciences");
  assert.equal(enriched.subjectClassification?.source, "inferred");
  assert.ok(enriched.domainPackIds?.includes("formal-stem"));
  assert.equal(enriched.subjectClassification?.version, "subject-classifier.v1");
  assert.equal(enriched.domainCatalogVersion, "domain-catalog.v1");
});

test("domain enrichment adds node metadata without rewriting the learning route", () => {
  const original = model("TypeScript 后端开发");
  const enriched = new DomainCatalog().enrich(original);

  assert.deepEqual(enriched.conceptRoute.map(({ id, title, target }) => ({ id, title, target })), [
    { id: "node-1", title: "核心节点", target: "解释并应用核心节点" },
  ]);
  assert.ok(enriched.conceptRoute[0].knowledgeTypes?.includes("procedural"));
  assert.ok(enriched.conceptRoute[0].requiredCapabilities?.includes("code-execution"));
  assert.ok(enriched.domainPackIds?.includes("software-engineering"));
});

test("mastery policy follows node knowledge type instead of macro domain", () => {
  const factual = model("历史事实");
  factual.conceptRoute[0].knowledgeTypes = ["factual"];
  assert.deepEqual(resolveMasteryPolicy(factual, 0).requiredCriteria, ["accurate", "discrimination"]);

  const procedural = model("部署服务");
  procedural.conceptRoute[0].knowledgeTypes = ["procedural"];
  procedural.rubricAnchors[0].performance = "能够独立完成部署";
  assert.deepEqual(resolveMasteryPolicy(procedural, 0).requiredCriteria, ["accurate", "transfer", "performance"]);

  const causal = model("解释通胀机制");
  causal.conceptRoute[0].knowledgeTypes = ["causal"];
  assert.deepEqual(resolveMasteryPolicy(causal, 0).requiredCriteria, ["accurate", "explained", "discrimination", "transfer"]);
});

test("a user correction replaces inferred classification and remains authoritative", () => {
  const catalog = new DomainCatalog();
  const enriched = catalog.enrich(model("分析一篇投资文章的论证"));
  const corrected = catalog.correctSubject(enriched, {
    macroDomain: "humanities",
    subdomainPath: ["逻辑与论证分析"],
  });
  const enrichedAgain = catalog.enrich(corrected);

  assert.equal(enrichedAgain.subjectClassification?.macroDomain, "humanities");
  assert.deepEqual(enrichedAgain.subjectClassification?.subdomainPath, ["逻辑与论证分析"]);
  assert.equal(enrichedAgain.subjectClassification?.source, "user-corrected");
  assert.equal(enrichedAgain.subjectClassification?.confidence, 1);
  assert.deepEqual(enrichedAgain.subjectClassification?.secondaryDomains, []);
  assert.ok(enrichedAgain.domainPackIds?.includes("high-risk-policy"));
});

test("subject correction does not remove capabilities required by the actual topic", () => {
  const catalog = new DomainCatalog();
  const corrected = catalog.correctSubject(catalog.enrich(model("TypeScript 后端开发")), {
    macroDomain: "business-economics-and-law",
    subdomainPath: ["技术管理"],
  });

  assert.ok(corrected.domainPackIds?.includes("software-engineering"));
  assert.ok(corrected.conceptRoute[0].requiredCapabilities?.includes("code-execution"));
});
