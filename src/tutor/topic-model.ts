import type { TopicModel } from "./types.js";

function fallbackBackground(model: TopicModel): string {
  const route = model.conceptRoute.map((item) => item.title).filter(Boolean).join("、");
  const boundaries = model.boundaryCases.slice(0, 2).join("；");
  return `${model.lessonTitle}是本次要系统理解的学习主题。${model.subject?.description || "它包含一组需要结合背景、概念关系和真实场景才能理解的知识。"}学习这个主题，不只是记住定义，而是要知道它试图解决什么问题、核心部分如何配合、常见场景中怎样使用，以及哪些相似说法其实超出了它的边界。本课程将围绕${route || "基本定位、核心机制、边界辨析和实际应用"}逐层展开，并通过解释、比较和新情境练习检查理解。需要特别留意的边界包括：${boundaries || "不要把局部技巧等同于完整主题，也不要把相近概念混为一谈"}。学完后，你应能用自己的话说明它是什么、为什么有用，并在具体情境中作出有依据的判断。`;
}

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
  model.backgroundBrief = model.backgroundBrief?.trim() || fallbackBackground(model);
  model.conceptRoute = model.conceptRoute.map((node) => ({
    ...node,
    openingQuestion: node.openingQuestion?.trim()
      || `如果把“${node.title}”放进一个具体场景，你会先关注什么？`,
    openingHint: node.openingHint?.trim()
      || `先从“${node.target}”中找一个会影响判断的条件，再联系你熟悉的场景`,
  }));
  const defaultKinds = ["baseline", "motivation", "focus", "misconception", "constraints"] as const;
  model.diagnosticDimensions = model.diagnosticDimensions.map((dimension, index) => ({
    ...dimension,
    kind: dimension.kind ?? defaultKinds[Math.min(index, defaultKinds.length - 1)],
    rationale: dimension.rationale ?? "这个信息会影响讲解起点、重点或练习方式",
    teachingUse: dimension.teachingUse ?? "根据答案调整后续教学的深浅和侧重",
    thinkingHint: dimension.thinkingHint ?? "按你目前最真实的情况选择，不需要猜标准答案",
  }));
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
    backgroundBrief: "当前学习主题尚在建立中。私教会先确认它是什么、解决什么问题、核心内容和适用边界，再结合你的基础、学习动机与内容侧重生成个性化路线。完成主题建模后，这里会形成一段可以独立阅读的背景摘要，帮助你在进入具体知识点前先建立整体认识，而不是只看到几句定义。",
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
