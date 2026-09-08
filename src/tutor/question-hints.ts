import type { KnowledgeType } from "./types.js";

export type ScaffoldedTask = { text: string; hint: string };

/** These are known non-hints, not a general semantic quality or answer-leak detector. */
export function usableHint(hint: string, question: string): string {
  const text = hint.trim();
  const compact = (value: string) => value.replace(/[\s，。！？、：；,.!?;:“”「」]/gu, "");
  if (!text || compact(text) === compact(question)) return "";
  const emptyInstructions = /^(?:先给一个具体例子或步骤|不必概括整节课|从刚才的原话里找还没说清的一层|请?仔细思考|再想一想|结合实际情况|根据自己的理解回答|回忆一下相关知识|从不同角度思考|先给一个具体例子)$/u;
  const clauses = text.split(/[，。！？；,.!?;\n]/u).map((part) => part.trim()).filter(Boolean);
  return clauses.length && clauses.every((part) => emptyInstructions.test(part)) ? "" : text;
}

export const QUESTION_HINT_GUIDANCE = [
  "把问题和提示作为一对设计：题面交代可用的对象、情境和已知条件，只留下一个主要判断；不要把整段节点标题塞进题目后让学生自己发明场景。",
  "thinkingHint 必须帮助学生完成本题的第一步：点名题面中的具体对象，并提供一个可执行操作（固定一个条件、标出两项、列一个未完成的式子、追踪一个输入、定位一处原文）。它要减少搜索或推理负担，而不是重复答题要求。",
  "只搭一步支架，保留本题要考的结论或关键关系给学生判断；不得复制 expectedSignals，不得把答案改成反问。缺少不可推导的事实时应在教学或题干中提供，不要让学生猜。",
  "出题后自检：提示多提供了哪一步？学生照着它能立刻做什么？本题仍剩哪个判断？把提示换到另一题仍完全通用，或只说‘举个例子/仔细想/联系实际/找关键条件’，都要重写。无法提供可靠提示时 thinkingHint 返回空字符串，不编填充文案。",
  "按本题实际操作选择支架：数学标已知/未知与适用前提；因果只追一个变化的第一跳、固定其余条件；代码追一个具体输入的执行步骤；概念做只变一个特征的对照；语言定位语境与一个待修改片段；论证把原文证据和主张分开；决策先固定目标和约束。不要仅凭宏观学科标签套用因果链。",
].join("\n");

/** Recovery can supply a method, but cannot invent a domain fact or expose a rubric answer. */
export function explanationTasks(title: string, types: KnowledgeType[] = []): ScaffoldedTask[] {
  const methods: Partial<Record<KnowledgeType, ScaffoldedTask[]>> = {
    causal: [
      { text: `在“${title}”的一个具体例子里，哪个环节把条件与结果联系起来？`, hint: "画出「条件改变 → [中间一步] → 结果」。先固定其他条件，只找条件刚改变时最先受影响的对象，暂时不要跳到最终结果。" },
      { text: `如果去掉“${title}”中的一个关键条件，原来的过程会在哪一步中断？`, hint: "先保留原来的过程顺序，只删掉一个条件；从第一步往后检查哪一步最先失去成立依据。" },
    ],
    formal: [
      { text: `在“${title}”的一个推导中，选相邻两步：后一步为什么能由前一步得到？`, hint: "把两行中没有变化的部分划去，圈出发生变化的符号；再检查允许这次变换的定义或规则需要什么前提。" },
      { text: `“${title}”的这个推导去掉一项前提后，哪一步首先不再成立？`, hint: "一次只删一项前提，逐行标出该行用了什么依据，停在第一次用到被删前提的位置。" },
    ],
    procedural: [
      { text: `在“${title}”的一次操作中，选一个步骤：下一步为什么需要它的输出？`, hint: "列出「这一步的输入｜做的操作｜输出」，再将输出与下一步需要的输入逐项对应。代码题可以在纸上记录一个输入经过这一步后的变量值。" },
      { text: `“${title}”的一次操作如果少做一步，后续哪一步会先受到影响？`, hint: "从被省略步骤后面开始，检查下一步所需的数据或状态是否仍然存在，先别讨论最终成败。" },
    ],
    language: [
      { text: `在“${title}”的一处表达中，为什么这里的措辞适合它的语境？`, hint: "先标出说话者、听者和表达目的，再只替换一个词，比较原句与改句的语气或含义，不必重写整段。" },
      { text: `如果改变“${title}”这个表达的交流对象，哪一处措辞需要重新考虑，为什么？`, hint: "保留要表达的信息，只改变听者身份；圈出依赖双方关系或共同背景的那一小段。" },
    ],
    argument: [
      { text: `围绕“${title}”，选一条主张：哪一处材料能够支持它，二者怎样关联？`, hint: "分两栏写「原文实际说了什么｜主张还多说了什么」，先检查中间是否有未说明的假设。" },
      { text: `“${title}”的一条论证如果删去一项依据，哪个判断会失去支持？`, hint: "给每个判断标出它依赖的原文依据，一次只删一条，找出没有剩余依据的判断。" },
    ],
    strategic: [
      { text: `在“${title}”的一次选择中，一项约束为什么会影响方案取舍？`, hint: "把目标和不能违反的约束分开列出，先固定目标，只比较两个方案在同一项约束上的差别。" },
      { text: `如果放宽“${title}”这次选择的一项约束，原先的取舍依据还成立吗？`, hint: "其他目标与条件保持不变，只改变一项限制，检查原先排除一个方案的那条理由是否还存在。" },
    ],
  };
  const method = types.find((type) => methods[type]);
  return (method && methods[method]) || [
    { text: `围绕“${title}”，选一个已经讨论过的判断：你依据哪个具体条件作出它？`, hint: "分两栏写「材料直接给出的信息｜自己得出的判断」，用一条连线把判断连到所依据的信息，检查有没有漏写的前提。" },
    { text: `“${title}”的一个具体例子为什么符合它的适用条件？`, hint: "把例子中的特征与定义要求逐项对应，先检查最容易混淆的一项；只报出名称还不能说明对应关系。" },
  ];
}
