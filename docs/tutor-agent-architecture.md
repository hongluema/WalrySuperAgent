# 私教 Agent 核心引导架构

## 总体设计

系统是一个通用一对一私教，核心思路：**不预设主题，为任意学习目标动态建模 → 诊断起点 → 按概念路线逐节点苏格拉底式教学 → 基于证据判定掌握**。

整个引导过程由四层分工：

| 层 | 职责 | 实现 |
|---|---|---|
| **路由层** | 判断消息走私教还是通用 agent | `agent-service.ts` |
| **编排层** | 状态机驱动阶段流转 | `orchestrator.ts` |
| **决策层** | 每轮教学决策（分析意图 → 选动作 → 规划回复） | `model-client.ts` → `analyzeTurn` |
| **执行层** | 根据决策生成自然语言回复 | `model-client.ts` → `streamResponse` |

## 阶段流转（状态机）

```
idle → research → diagnose → plan → teach → (complete)
```

### 1. idle → research：入口判断

**触发条件**：用户首条消息且 `isSystematicLearningIntent(message)` 匹配成功（正则匹配"学习/掌握/练习"等关键词）。

**执行**：`agent-service.ts:150` 路由到 `TutorOrchestrator.run()`。

**注意**：一旦有活跃会话（`hasActiveSession`），后续消息直接进入 orchestrator，不再经过正则判断。

### 2. research：动态建模

**做什么**：调用 `buildTopicModel`，从用户目标动态生成完整的 `TopicModel`。

**TopicModel 包含**：
- `lessonTitle` / `coreOutcome`：课程标题和核心目标
- `diagnosticDimensions`：2-6 道摸底题（柔性维度，按主题选最有区分度的）
- `conceptRoute`：2-10 个知识节点组成的学习路线（必须是内容节点，不是方法论节点）
- `boundaryCases`：边界情况和常见误解
- `rubricAnchors`：每个概念的掌握评估锚点（准确、解释、辨析、迁移、实操）
- `subject`：开放标签描述学习对象
- `grounding`：知识来源和局限性声明
- `capabilities`：系统在本主题上的能力评估

**关键 prompt 约束**：
- 路线节点必须是知识/内容节点，不能是"明确学习目标""批判性思考"等教学技法
- 对于有源材料的学习（书/论文），路线忠于源材料结构
- 诊断题至少一道要求真实判断，不能全是自我评价题

**直接帮助的短路**：如果用户消息匹配 `isDirectHelpRequest`（"直接告诉我/直接讲解"等），跳过诊断，直接进 teach 阶段。

### 3. diagnose：摸底诊断

**做什么**：逐张展示诊断卡片，收集用户选择。

**两种输入方式**：
- **逐题回答**：用户发送 A/B/C/D 字母，`answerLetter()` 解析后记录
- **批量提交**：前端通过 `options.diagnosticAnswers` 一次提交所有答案

**流转逻辑**：
- 答案未收齐 → 展示下一张诊断卡 → 等待用户回答
- 答案全部收齐 → 进入 plan 阶段

### 4. plan：诊断编译 + 路线规划

**做什么**：调用 `compileDiagnosis`，将结构化答案编译为诊断报告。

**诊断输出**：
- `summary`：一句话总结学习起点
- `learnerProfile`：学习者画像标签
- `evidence`：每条判断引用具体题目和选项
- `skipSuggestions`：建议跳过的节点及置信度（high/medium）

**跳过逻辑**（诊断结果影响路线起点）：
```
高置信度跳过 → 节点标记为 "known"
中等置信度 → 不跳过，保留在路线中
找到第一个非 known/mastered 的节点 → 设为起点
```

**然后**：构建 `firstTeachingDecision`，锚定到起始内容节点，直接进入教学。

### 5. teach：苏格拉底式教学循环

这是核心循环，每轮消息经过两步处理：

#### 步骤 A：analyzeTurn（决策层）

模型生成 `TutorTurnDecision` JSON，包含：

| 字段 | 作用 |
|---|---|
| `intent` | 用户意图分类：answer / dont_know / disagreement / clarification / direct_answer_request / topic_switch / meta_question / stop |
| `understoodMeaning` | 模型对用户消息的理解 |
| `evidence` | 用户原话引用及推断 |
| `assessment.status` | 掌握评估：not-answered / insufficient / partial / misconception / mastered |
| `assessment.evidence` | 按 rubric 维度分类的学习证据（准确/解释/辨析/迁移/实操 × 弱/充分） |
| `nextAction` | 下一步教学动作：explain / give-example / ask-clarification / repair-misconception / ask-socratic-question / give-practice / advance-concept / switch-topic / complete |
| `statePatch` | 状态变更：切换活跃概念 / 记录误解 / 标记掌握 |
| `responsePlan` | 回复规划：goal / teachingAtom / gapToRepair / keyPoints / allowedContent / forbiddenContent / question |

**关键教学约束**（写在 prompt 中）：
- 用户说"不知道"不是错误答案，用户说"错了"是对老师的异议
- 只有可观察证据才能推进掌握状态，不能凭关键词评分
- 每轮只选一个 teachingAtom，只修复一个 gapToRepair
- forbiddenContent 阻止提前教授后续节点

#### 步骤 B：streamResponse（执行层）

根据 decision 生成自然语言回复，流式输出。

**执行约束**：
- 先回应用户意图 → 最小必要解释/例子 → 只问一个核心问题
- 严格执行 responsePlan，只讲 allowedContent，不输出 forbiddenContent
- 正文不超过 600 字
- 用户不知道 → 降低难度给例子；用户反驳 → 先承认再澄清

#### 状态更新：applyStatePatch

每轮结束后，orchestrator 根据 decision 更新状态：

- **记录学习证据**：按 rubric 维度分类存入 `nodeLearningStates`
- **记录误解**：如果模型识别了误解，标记为 open，进入 repair 阶段
- **切换概念**：如果模型建议前进，更新 `activeConcept`
- **掌握判定**（硬门槛）：必须在准确、解释、辨析、迁移四个维度都有 sufficient 证据，才能标记 mastered。模型单方面说 mastered 不够——orchestrator 有独立校验

## 数据流总览

```
用户消息
  ↓
agent-service.ts ── 路由判断 ──→ 通用 agent（非私教消息）
  ↓ (私教消息)
orchestrator.run()
  ↓
  ├─ 无 topicModel → buildTopicModel → 诊断卡 → 等待答案
  ├─ phase=diagnose → 收集答案 → compileDiagnosis → skipSuggestions → firstTeachingDecision
  └─ phase=teach → analyzeTurn → applyStatePatch → streamResponse
  ↓
TutorStore.save()  ← 每轮持久化状态到磁盘（JSON + 事件日志）
```

## 掌握验证模型

每个概念节点有 5 个 rubric 维度：

| 维度 | 含义 | 掌握要求 |
|---|---|---|
| `accurate` | 能准确复述核心结论 | sufficient |
| `explained` | 能说明"为什么" | sufficient |
| `discrimination` | 能区分相近概念和常见误解 | sufficient |
| `transfer` | 能在新场景中应用 | sufficient |
| `performance` | 能实操完成任务 | 可选 |

**掌握 = 前四个维度全部 sufficient**。这是 orchestrator 层的硬编码校验，不依赖模型判断。

## 状态持久化

- **状态文件**：`.tutor-data/sessions/{conversationId}.json` —— 完整的 TutorState，包含 topicModel、roadmap、所有消息历史、nodeLearningStates
- **事件日志**：`.tutor-data/events/{conversationId}.jsonl` —— 追加写入的事件流
- **写入方式**：先写 `.tmp` 再 rename，保证原子性
- **恢复**：下次 `run()` 时从磁盘加载状态，继续上次进度

## 核心设计原则

1. **内容优先**：路线节点是知识节点不是方法论节点；诊断维度按主题灵活选择不强制凑满
2. **证据驱动**：掌握状态只由可观察证据推进，不凭关键词或模型单方面判断
3. **单原子教学**：每轮只教一个最小概念，明确边界（allowedContent / forbiddenContent）
4. **苏格拉底式引导**：以提问驱动，不直接灌输；用户不知道就降难度，用户反驳就先承认
5. **决策-执行分离**：analyzeTurn 只生成 JSON 决策，streamResponse 只执行决策生成回复，两步不混合
