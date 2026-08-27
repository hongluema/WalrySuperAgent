import type { TopicModel } from "./types.js";

function option(id: string, label: string) {
  return { id, label };
}

export function buildDiagnosticProtocol(model: TopicModel): TopicModel["diagnosticDimensions"] {
  const title = model.lessonTitle?.trim() || "这个主题";
  const focusOptions = model.conceptRoute
    .map((node) => node.title?.trim())
    .filter((label): label is string => Boolean(label))
    .slice(0, 6)
    .map((label, index) => option(String.fromCharCode(65 + index), label));
  if (focusOptions.length === 0) {
    focusOptions.push(option("A", "核心概念和原理"), option("B", "实际应用和操作"));
  } else if (focusOptions.length === 1) {
    focusOptions.push(option("B", "实际应用和操作"));
  }
  const boundary = model.boundaryCases.map((item) => item.trim()).find(Boolean) || "把记住定义当成已经学会";

  return [
    {
      id: "baseline",
      kind: "baseline",
      tab: "了解程度",
      rationale: "起点决定从哪一层开讲，避免对生手上过快或对熟手重复入门。",
      teachingUse: "几乎没接触就从整体框架讲起；有实践或专业经验就加快已知直觉、直接进入易混点。",
      question: `你目前和「${title}」的真实接触到哪一步了？`,
      thinkingHint: "按你现在最真实的接触程度选，不必往高了报",
      options: [
        option("A", "几乎没接触过，只听过名字或完全陌生"),
        option("B", "读过介绍或听过讲解，但没有自己实践过"),
        option("C", "在生活或工作里试过一些，还不系统"),
        option("D", "有比较完整的实践或专业经验"),
      ],
    },
    {
      id: "motivation",
      kind: "motivation",
      tab: "学习动机",
      rationale: "用途决定用什么场景举例，以及练习往哪边靠。",
      teachingUse: "家庭或个人场景用生活例子；工作或专业发展用岗位情境；没有明确用途就先建立整体认识。",
      question: `你学「${title}」主要想用在哪？`,
      thinkingHint: "想学完后最先会用到的那个场景",
      options: [
        option("A", "家庭或个人场景里直接用"),
        option("B", "工作、教学或专业发展"),
        option("C", "先建立整体认识，暂时没有明确用途"),
        option("D", "解决一个已经遇到的具体问题"),
      ],
    },
    {
      id: "focus",
      kind: "focus",
      tab: "内容侧重",
      rationale: "侧重决定路线里哪一段加重、哪一段加快。",
      teachingUse: "选中的节点多给例子和练习，其他节点确认直觉后尽快过。",
      question: `这次你最想先把「${title}」的哪一块搞清楚？`,
      thinkingHint: "选现在最想深入的那一块，而不是觉得最重要的全部",
      options: focusOptions,
    },
    {
      id: "misconception",
      kind: "misconception",
      tab: "边界判断",
      rationale: "真实判断能校准常见误区，避免后面把错误直觉当成已知。",
      teachingUse: "同意或说不准时，开讲就把这条边界讲透；明确不同意则加快，只在相关节点点一下。",
      question: `有人认为：${boundary}。你现在怎么看？`,
      thinkingHint: "按你此刻的真实想法选，不必猜老师想听什么",
      options: [
        option("A", "基本同意，可以按这个理解"),
        option("B", "不同意，这和主题的核心原则冲突"),
        option("C", "部分对，要看具体条件和场景"),
        option("D", "还说不准，想先听老师怎么界定"),
      ],
    },
  ];
}

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
  model.diagnosticDimensions = buildDiagnosticProtocol(model);
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
