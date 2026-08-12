# WalrySuperAgent 通用私教架构

## 1. 目标

WalrySuperAgent 的核心定位不是课程大纲生成器，而是证据驱动的一对一私教：根据学习者每次可观察的回答，判断已经掌握什么、还缺什么，并只选择一个最小教学动作，直到学习者能够独立解释、辨析和应用。

系统必须支持开放的学习对象。书籍、文章、主题、代码库只是常见标签，不是核心代码的封闭枚举。未来遇到视频、论文、设计文件、数据集、业务流程或其他对象时，应优先组合已有能力；只有确实缺少读取、操作或验证能力时才扩展能力模块。

## 2. 设计原则

### 2.1 开放描述，封闭执行

模型可以自由描述学习对象和所需能力，但只能使用注册表中真实存在的能力。未注册能力必须标记为 `missing` 或进入降级模式，不能假装已经读取、研究或验证。

### 2.2 类型是标签，不是分支主轴

`kind` 使用开放字符串，仅用于 UI、默认策略和统计。核心执行依据是四组能力：

- acquisition：如何取得可靠知识；
- structuring：如何组织学习内容；
- interaction：如何教学和练习；
- assessment：如何证明掌握。

### 2.3 统一教学中间表示

所有学习对象最终转换为统一的 `LearningModel`：学习对象、知识依据、所需能力、学习节点、节点依赖和掌握标准。教学状态机只消费该模型，不直接判断它是书还是代码库。

### 2.4 目标忠实

私教可以设计路径，但不能未经授权重新定义学习目标：

- 学书不能自动扩张为整个领域训练营；
- 学文章不能自动改成主题百科；
- 学主题不能擅自改成考试或项目课程；
- 学代码库不能退化成通用编程知识讲解。

不同对象可以提供默认结构策略，但实际用户目标始终优先。

### 2.5 真实依据，不伪装研究

知识依据必须区分：用户提供材料、本地资源、真实检索、环境观察和模型已有知识。模型自行列出的主题名不能算作已验证来源；没有真实检索时不得发出“研究完成”信号。

## 3. 通用学习模型

```ts
type LearningModel = {
  subject: {
    kind: string;
    description: string;
    userGoal: string;
  };
  grounding: {
    mode: string;
    sources: Array<{ label: string; verified: boolean }>;
    limitations: string[];
  };
  capabilities: {
    acquisition: string[];
    structuring: string[];
    interaction: string[];
    assessment: string[];
    missing: string[];
  };
  nodes: LearningNode[];
};

type LearningNode = {
  id: string;
  title: string;
  learningOutcome: string;
  prerequisites: string[];
  masteryCriteria: {
    accurate: string;
    explained: string;
    discrimination: string;
    transfer: string;
    performance?: string;
  };
};
```

当前代码可在保留 `TopicModel` 旧字段供 UI 兼容的同时逐步迁移到上述语义。

## 4. 教学闭环

每个节点内部使用统一循环：

```text
introduce -> elicit -> assess -> repair/practice
          -> transfer -> discriminate -> doubt-check -> mastered
```

每轮决策必须明确：

1. 学习者原话提供了什么证据；
2. 当前仍缺哪个掌握维度；
3. 是否存在未修复误解；
4. 本轮唯一的教学单元；
5. 允许讲什么、禁止提前讲什么；
6. 用哪一个问题获得下一份证据。

掌握至少考虑：准确性、因果解释、相似概念辨析、跨场景迁移；需要真实操作的任务还要考虑 performance。没有对应证据，不得推进节点。

## 5. 状态与证据

```ts
type NodeLearningState = {
  nodeId: string;
  stage: "introduce" | "elicit" | "repair" | "practice" |
    "transfer" | "doubt-check" | "mastered";
  evidence: Array<{
    learnerQuote: string;
    criterion: "accurate" | "explained" | "discrimination" |
      "transfer" | "performance";
    strength: "weak" | "sufficient";
  }>;
  misconceptions: Array<{
    description: string;
    status: "open" | "repaired";
  }>;
  questionsAsked: string[];
};
```

诊断选择必须和题目、选项文本一起保存，不能只把 `B/B/B/B` 交给模型。诊断完成使用专门的诊断编译步骤，不应通过普通回合决策器解释成“不知道”。

## 6. 能力扩展协议

遇到未知学习对象时：

1. 描述用户真正想学会什么；
2. 分解 acquisition、structuring、interaction、assessment 能力；
3. 与注册能力匹配；
4. 对缺失能力明确降级或请求补充材料；
5. 生成统一 LearningModel；
6. 进入同一个证据驱动教学闭环。

扩展规则：

- 新标签或新组合：零代码扩展；
- 新默认组合：增加轻量 preset；
- 新媒介读取：增加 Source Provider；
- 新环境操作：增加 Environment Adapter；
- 新掌握验证：增加 Assessment Evaluator；
- 教学状态机原则上不修改。

## 7. 当前改造优先级

### P0 决策正确性

- 删除会污染输出的语义化 JSON 示例；
- 诊断完成走专门的 `compileDiagnosis`；
- 诊断答案展开成真实题目与选项证据；
- 输出层必须执行决策层的单一教学计划。

### P1 教学闭环

- 保存节点证据、误解、问题历史和缺失维度；
- 每轮只推进一个教学单元；
- 只有证据充分时才标记掌握。

### P2 Grounding 与能力注册

- 区分真实来源和模型知识；
- 引入能力匹配和显式降级；
- 再逐步接入新媒介、新环境和新验证器。

## 8. 回归验收

- 任意主题仍进入同一私教内核；
- 诊断完成后不会被判断成“不知道”；
- 诊断输出引用实际题目和选项含义；
- 第一教学轮不会倾倒整门课程；
- 每轮只有一个 `teachingAtom` 和一个核心问题；
- 没有迁移或操作证据时不能错误标记 mastered；
- 新学习对象能通过能力组合进入系统，不需要新增中心类型分支。
