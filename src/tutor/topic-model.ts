import type { TopicModel } from "./types.js";

export function ensureTopicModelDefaults(model: TopicModel): TopicModel {
  model.subject ??= {
    kind: "open-learning-subject",
    description: model.lessonTitle,
    userGoal: model.coreOutcome,
  };
  model.grounding ??= {
    mode: "model-knowledge",
    sources: [],
    limitations: ["未提供可直接核验的学习材料"],
  };
  model.capabilities ??= {
    acquisition: ["model-knowledge"],
    structuring: ["concept-dependency"],
    interaction: ["socratic-dialogue"],
    assessment: ["explanation", "transfer"],
    missing: [],
  };
  model.rubricAnchors = model.rubricAnchors.map((rubric) => ({
    ...rubric,
    explanation: rubric.explanation ?? "能说明关键结论为什么成立",
    discrimination: rubric.discrimination ?? "能区分相近概念和常见误解",
  }));
  return model;
}

/**
 * 这里只识别“是否进入私教模式”，不识别主题。
 * 主题内容必须由模型根据用户目标和证据动态生成。
 */
export function isSystematicLearningIntent(message: string): boolean {
  return /(我想|想要|希望|带我|教我|学习|学会|掌握|练习|复习|系统了解|深入了解|怎么学|如何学|应该怎么做)/u.test(message);
}

export function isDirectHelpRequest(message: string): boolean {
  return /(直接告诉我|直接讲解|直接回答|给我答案|不要提问|不用提问)/u.test(message);
}

export function topicModelFromUnknownTopic(request: string): TopicModel {
  return {
    id: `pending-${Date.now().toString(36)}`,
    topic: "pending",
    lessonTitle: request.replace(/[？?！!。]$/u, "").slice(0, 80) || "当前主题",
    coreOutcome: "",
    diagnosticDimensions: [],
    conceptRoute: [],
    boundaryCases: [],
    practiceTarget: "",
    rubricAnchors: [],
    evidenceSources: [],
    confidence: 0,
    subject: {
      kind: "open-learning-subject",
      description: request,
      userGoal: request,
    },
    grounding: {
      mode: "model-knowledge",
      sources: [],
      limitations: ["尚未建立可核验的知识依据"],
    },
    capabilities: {
      acquisition: ["model-knowledge"],
      structuring: ["concept-dependency"],
      interaction: ["socratic-dialogue"],
      assessment: ["explanation", "transfer"],
      missing: [],
    },
  };
}
