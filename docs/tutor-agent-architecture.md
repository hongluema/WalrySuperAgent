# 私教 Agent 核心引导架构

## 总体设计

系统是一个通用一对一私教，核心思路：**不预设主题，为任意学习目标动态建模 → 诊断起点 → 按概念路线逐节点苏格拉底式教学 → 基于证据判定掌握**。

整个引导过程由五层分工：

| 层 | 职责 | 实现 |
|---|---|---|
| **路由层** | 判断消息走私教还是通用 agent | `agent-service.ts` |
| **编排层** | 状态机驱动阶段流转 | `orchestrator.ts` |
| **评估层** | 只从学生原话提取 Rubric 证据和误区 | `model-client.ts` → `evaluateAnswer` |
| **策略层** | 根据缺失证据和硬门槛确定下一动作 | `pedagogy.ts` → `buildEvidenceDrivenDecision` |
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
- `backgroundBrief`：可独立阅读的主题背景摘要，覆盖主题定位、问题、核心机制、用途、边界和学习范围
- `diagnosticDimensions`：4-6 道高信息量摸底题，每题记录类型、提问理由、教学用途和思路提示
- `conceptRoute`：2-10 个知识节点组成的学习路线（必须是内容节点，不是方法论节点）；每个节点预先带一个主题专属的开场问题和思路提示
- `boundaryCases`：边界情况和常见误解
- `rubricAnchors`：每个概念的掌握评估锚点（准确、解释、辨析、迁移、实操）
- `subject`：开放标签描述学习对象
- `grounding`：知识来源和局限性声明
- `capabilities`：系统在本主题上的能力评估

**关键 prompt 约束**：
- 路线节点必须是知识/内容节点，不能是"明确学习目标""批判性思考"等教学技法
- 对于有源材料的学习（书/论文），路线忠于源材料结构
- 先理解主题，再决定哪些学生变量会真正改变教法，不能套固定问卷
- 摸底是分班不是测验：探针粒度对齐原话。原话只到「想学 X」时先问站位（对象识别、活动经验、想带走哪块）；原话已带场景/先验只补未知；已在用行话才出节点判断。不要用课内最细误区当第一题，也不要按主题类型套模板
- 禁止「了解程度/学习动机/内容侧重」入学表和主题通用自评；活动经验可以问。每道题都说明答案将如何改变后续教学

**直接帮助的短路**：如果用户消息匹配 `isDirectHelpRequest`（"直接告诉我/直接讲解"等），跳过诊断，直接进 teach 阶段。

### 3. diagnose：摸底诊断

**做什么**：逐张展示诊断卡片，收集用户选择。

诊断不是第一堂测验。出哪些题由学生原话粒度决定，不强制三类画像。只有会改变讲解起点、案例选择、内容比重或练习方式的信息才值得提问。

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
- `teachingApproach`：把诊断转成可执行教法，包括开讲起点、重点、案例语境、节奏及逐条依据
- `skipSuggestions`：建议跳过的节点及置信度（high/medium）

`skipSuggestions` 只表示学习者可能已有直觉，用于加快讲解；选择题诊断不能直接证明完整掌握，因此不会跳过核心内容节点。

**然后**：先输出 `backgroundBrief` 形成主题全景，再构建 `firstTeachingDecision`，锚定到起始内容节点进入教学。

### 5. teach：苏格拉底式教学循环

这是核心循环，每轮消息经过三步处理：

#### 步骤 A：evaluateAnswer（评估层）

模型只生成 `TutorAnswerEvaluation` JSON，包含：

| 字段 | 作用 |
|---|---|
| `intent` | 用户意图分类，包括 answer / dont_know / no_doubts / direct_answer_request 等 |
| `understoodMeaning` | 模型对用户消息的理解 |
| `observations` | 学生原话引用及其可观察含义 |
| `assessment.status` | 掌握评估：not-answered / insufficient / partial / misconception / mastered |
| `assessment.evidence` | 按 rubric 维度分类的学习证据（准确/解释/辨析/迁移/实操 × 弱/充分） |
| `misconceptionUpdates` | 新发现或已修复的误区，必须绑定学生原话 |
| `pedagogy` | hit / unpunched / invented / sourceMove |
| `questionCandidates` | 按证据目标分类的候选探针；每题带不泄露答案的 `thinkingHint`，不能决定下一动作 |

**关键教学约束**（写在 prompt 中）：
- 用户说"不知道"不是错误答案，用户说"错了"是对老师的异议
- 只有可观察证据才能推进掌握状态，不能凭关键词评分
- 评估器不得输出 nextAction、statePatch 或 masteredConceptId
- 同一回答不能因为语言流畅就同时证明所有掌握维度

#### 步骤 B：buildEvidenceDrivenDecision（确定性策略层）

程序合并历史证据与本轮证据，按 `accurate → explained → discrimination → transfer → performance` 找到最早缺口，再决定 `give-example / repair-misconception / ask-socratic-question / give-practice / doubt-check / advance-concept`。

强证据受当前问题目标约束：一条回答最多证明当前目标，必要时附带 `accurate`；疑问检查回复不会产生新的充分证据。直接求答案、澄清或异议会先走直接讲解，但只要课程仍在进行，老师仍会围绕当前节点留下一个新的教学问题。

#### 步骤 C：streamResponse（表达层）

根据 decision 生成自然语言回复，流式输出。

**执行约束**：
- 先回应用户意图 → 最小必要解释/例子 → 只问一个核心问题
- 所有问题后都附 `（思路：……）`，只提示回忆方向、比较维度或分析入口，不直接给答案
- 首次正式教学、进入新节点、直接讲解和模型降级都必须继续提问；只有课程完成、暂停或切换主题时停止提问
- 编排器会检查最终回复是否包含计划问题；回复模型漏问时，程序自动补上，避免“讲完就停”
- 严格执行 responsePlan，只讲 allowedContent，不输出 forbiddenContent
- 正文不超过 600 字
- 用户不知道 → 降低难度给例子；用户反驳 → 先承认再澄清

#### 状态更新：applyStatePatch

每轮结束后，orchestrator 根据 decision 更新状态：

- **记录学习证据**：按 rubric 维度分类存入 `nodeLearningStates`
- **记录误解**：如果模型识别了误解，标记为 open，进入 repair 阶段
- **记录问题目标**：保存真实问题和 `lastQuestionPurpose`，下一轮只按被探测维度授予强证据
- **提示升级**：用户说不知道时递增 `hintLevel`，回复层据此降低难度
- **掌握判定**（硬门槛）：四个核心维度（以及要求时的 performance）均为 sufficient、没有 open 误区、完成 doubt-check，三项同时满足才标记 mastered
- **安全前进**：掌握校验未通过时，即使决策请求切换概念也不会更新 `activeConcept`

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
  └─ phase=teach → evaluateAnswer → buildEvidenceDrivenDecision → applyStatePatch → streamResponse
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

**掌握 = 必需维度全部 sufficient + 没有开放误区 + 完成疑问检查**。需要真实操作的节点还必须有 `performance` 证据。单次流畅回答不能直接获得四个维度的充分证据，“没有疑问”也不能替代掌握证据。

## 状态持久化

- **状态文件**：`.tutor-data/sessions/{conversationId}.json` —— 完整的 TutorState，包含 topicModel、roadmap、所有消息历史、nodeLearningStates
- **事件日志**：`.tutor-data/events/{conversationId}.jsonl` —— 追加写入的事件流
- **写入方式**：先写 `.tmp` 再 rename，保证原子性
- **恢复**：下次 `run()` 时从磁盘加载状态，继续上次进度

## 核心设计原则

1. **专业诊断**：先理解主题，再摸真实起点、学习动机和内容侧重；每道题都必须能够改变后续教法
2. **证据驱动**：掌握状态只由可观察证据推进，不凭关键词或模型单方面判断
3. **单原子教学**：每轮只教一个最小概念，明确边界（allowedContent / forbiddenContent）
4. **苏格拉底式引导**：以提问驱动，不直接灌输；用户不知道就降难度，用户反驳就先承认
5. **评估-策略-表达分离**：模型评估只描述证据；程序决定动作和门槛；回复模型只执行单一教学计划
