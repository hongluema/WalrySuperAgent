import type { TopicModel, UniversalTutorProfile } from "./types.js";

export const universalTutorProfile: UniversalTutorProfile = {
  id: "universal-mastery-tutor",
  version: "1.0.0",
  diagnosticCardMin: 3,
  diagnosticCardMax: 6,
  evidenceLayers: ["既往接触", "当前行为", "心智模型", "边界辨析", "迁移能力"],
  masteryThreshold: 80,
  masteryCheckThreshold: 3,
  questionPolicy: "有学习价值时提问，一轮一个核心问题，必要时最多一个紧密追问",
};

type TopicSeed = Omit<TopicModel, "id" | "topic" | "lessonTitle" | "confidence"> & {
  matches: RegExp;
  topic: string;
  lessonTitle: string;
};

const seeds: TopicSeed[] = [
  {
    matches: /vibe\s*coding|高效编程|ai编程|agent.*代码/i,
    topic: "vibe-coding",
    lessonTitle: "如何进行高效的 Vibe Coding",
    coreOutcome: "能够把模糊开发需求变成有上下文、有边界、有验收闭环的 Agent 任务，并判断哪些产出必须人工审查。",
    diagnosticDimensions: [
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
    ],
    conceptRoute: [
      { id: "scope", title: "任务边界与验收标准", target: "把模糊需求拆成 Agent 可执行且可验证的任务" },
      { id: "context", title: "高质量上下文包", target: "提供结构、约定和相似实现，减少 Agent 猜测" },
      { id: "iteration", title: "增量任务与迭代节奏", target: "用小步交付控制返工和上下文漂移" },
      { id: "runtime", title: "运行时验证闭环", target: "把网络、DOM、错误态和边界场景纳入验收" },
      { id: "review", title: "代码审查与信任边界", target: "识别依赖、安全和 AI 特有错误" },
      { id: "production", title: "生产环境红线", target: "判断哪些变更必须人工确认和分阶段发布" },
    ],
    boundaryCases: ["构建通过不等于运行时正确", "模型输出不等于功能验收通过"],
    practiceTarget: "完成一个小功能的任务拆解、实现和成功/空数据/失败/视觉验收",
    rubricAnchors: [{ conceptId: "scope", accuracy: "能区分目标、范围、约束和验收", transfer: "能把新需求改写成可执行任务" }],
    evidenceSources: ["用户提供的项目上下文", "Vibe Coding 黄金对话与验收标准"],
  },
  {
    matches: /写作|文章|表达|文案|论文/i,
    topic: "writing",
    lessonTitle: "如何写出清晰、有说服力的文章",
    coreOutcome: "能够围绕读者和目的组织观点、证据与结构，并通过修改验证表达是否真正有效。",
    diagnosticDimensions: [
      { id: "purpose", tab: "写作目标", question: "你开始写一篇文章时，通常先确定什么？", options: [{ id: "A", label: "先明确读者、场景和希望读者采取的行动" }, { id: "B", label: "先列几个想表达的观点，再考虑读者" }, { id: "C", label: "通常直接开始写，写到哪里算哪里" }, { id: "D", label: "还没有固定方法" }] },
      { id: "structure", tab: "文章结构", question: "面对一篇观点很多但读起来混乱的文章，你会先怎么改？", options: [{ id: "A", label: "先找主张和论证关系，再重排段落层级" }, { id: "B", label: "先润色句子和替换更好的词" }, { id: "C", label: "主要删掉读起来不顺的句子" }, { id: "D", label: "不确定应该从哪里开始" }] },
      { id: "revision", tab: "修改验证", question: "你通常如何判断一稿真的变好了？", options: [{ id: "A", label: "用目标读者和具体阅读任务检查理解、说服和行动结果" }, { id: "B", label: "通读几遍，感觉流畅就提交" }, { id: "C", label: "主要检查错别字和语法" }, { id: "D", label: "没有固定的验证方式" }] },
    ],
    conceptRoute: [
      { id: "audience", title: "读者与写作目的", target: "让每个段落服务于明确读者和结果" },
      { id: "claim", title: "核心观点与论据", target: "区分主张、理由、证据和例子" },
      { id: "structure", title: "信息结构", target: "用层级和顺序降低理解成本" },
      { id: "revision", title: "基于任务的修改", target: "围绕读者反馈而不是只改句子" },
      { id: "transfer", title: "不同场景迁移", target: "在不同文体和约束下保持表达有效" },
    ],
    boundaryCases: ["语言流畅不等于论证成立", "信息完整不等于读者能理解"],
    practiceTarget: "围绕一个真实读者和行动目标完成一稿，并用任务结果修改二稿",
    rubricAnchors: [{ conceptId: "claim", accuracy: "能区分观点、理由和证据", transfer: "能在新主题中搭建可验证论证" }],
    evidenceSources: ["用户提供的文本", "当前写作任务和读者约束"],
  },
  {
    matches: /英语|英文|口语|语法|english/i,
    topic: "english",
    lessonTitle: "如何在真实场景中清晰表达英语",
    coreOutcome: "能够根据语境理解和组织英语表达，并通过复述、纠错和迁移验证是否真正会用。",
    diagnosticDimensions: [
      { id: "exposure", tab: "接触经验", question: "你平时主要在哪些场景使用英语？", options: [{ id: "A", label: "能在工作或生活场景中持续听说读写并完成任务" }, { id: "B", label: "能读懂熟悉主题，但输出较少" }, { id: "C", label: "主要靠翻译或背单词，很少使用完整表达" }, { id: "D", label: "几乎没有实际使用经验" }] },
      { id: "meaning", tab: "语境理解", question: "遇到一句字面意思熟悉但语气不确定的话，你会先判断什么？", options: [{ id: "A", label: "结合说话人、关系、场景和下一步行动判断含义" }, { id: "B", label: "先按词典意思翻译，再猜语气" }, { id: "C", label: "只关注语法是否正确" }, { id: "D", label: "不确定如何判断" }] },
      { id: "transfer", tab: "表达迁移", question: "学会一个新表达后，你通常怎样确认自己会用了？", options: [{ id: "A", label: "在不同场景主动造句、复述并根据反馈修正" }, { id: "B", label: "记住例句，遇到相似场景再尝试" }, { id: "C", label: "只做选择题或背诵" }, { id: "D", label: "没有固定练习方式" }] },
    ],
    conceptRoute: [
      { id: "context", title: "语境与意图", target: "根据关系、场景和目的理解表达" },
      { id: "pattern", title: "句型与搭配", target: "从规则记忆转向可复用表达模式" },
      { id: "output", title: "可理解输出", target: "组织清晰、符合语境的表达" },
      { id: "feedback", title: "反馈与纠错", target: "区分影响理解的错误与风格差异" },
      { id: "transfer", title: "场景迁移", target: "在新场景中稳定调用表达" },
    ],
    boundaryCases: ["语法正确不等于语境自然", "记住例句不等于能迁移使用"],
    practiceTarget: "完成一次真实场景对话、复述和自我修订",
    rubricAnchors: [{ conceptId: "context", accuracy: "能结合场景解释表达意图", transfer: "能在新关系和新任务中改写表达" }],
    evidenceSources: ["用户实际表达", "对话场景和目标任务"],
  },
];

export function buildTopicModel(request: string): TopicModel {
  const seed = seeds.find((candidate) => candidate.matches.test(request)) ?? {
    ...seeds[1],
    topic: "general",
    lessonTitle: request.replace(/[？?！!。]$/u, "").slice(0, 40) || "当前主题",
    coreOutcome: `能够理解并应用“${request.slice(0, 40)}”的核心概念，在新场景中独立完成实践。`,
  };

  return {
    id: `${seed.topic}-${Date.now().toString(36)}`,
    topic: seed.topic,
    lessonTitle: seed.lessonTitle,
    coreOutcome: seed.coreOutcome,
    diagnosticDimensions: seed.diagnosticDimensions,
    conceptRoute: seed.conceptRoute,
    boundaryCases: seed.boundaryCases,
    practiceTarget: seed.practiceTarget,
    rubricAnchors: seed.rubricAnchors,
    evidenceSources: seed.evidenceSources,
    confidence: seed.topic === "general" ? 0.55 : 0.9,
  };
}

export function isSystematicLearningIntent(message: string): boolean {
  return /(我想|想要|希望|一起|带我|教我|学习|学会|掌握|练习|复习|系统了解|深入了解|怎么学|如何学)/u.test(message);
}

export function isDirectHelpRequest(message: string): boolean {
  return /(直接告诉我|直接讲解|直接回答|给我答案|不要提问|不用提问)/u.test(message);
}
