import { createHash } from "node:crypto";
import { resolveMasteryPolicy } from "../domain/catalog.js";
import type { TutorState } from "../types.js";
import type { MemoryExperience, MemorySkill } from "./types.js";

export const memoryId = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** A projection only: it never mutates classroom evidence or mastery. */
export function projectSnapshot(state: TutorState): { experience: MemoryExperience; skills: MemorySkill[] } {
  const experience: MemoryExperience = { id: memoryId(state.conversationId, state.learningSessionId), conversationId: state.conversationId, learningSessionId: state.learningSessionId, title: state.lessonTitle || state.topic || "学习经历", topic: state.topic || "", updatedAt: state.updatedAt, status: state.sessionStatus };
  const skills = Object.values(state.nodeLearningStates ?? {}).map((node): MemorySkill => {
    const index = state.topicModel?.conceptRoute.findIndex((c) => c.id === node.nodeId) ?? -1;
    const concept = index >= 0 ? state.topicModel!.conceptRoute[index] : state.roadmap.find((c) => c.id === node.nodeId);
    const required = state.topicModel && index >= 0 ? resolveMasteryPolicy(state.topicModel, index).requiredCriteria : ["accurate", "explained", "discrimination", "transfer"];
    const questions = [...(node.questionHistory ?? []), ...(node.activeQuestion ? [node.activeQuestion] : [])];
    const verified = node.evidence.filter((e) => e.verification === "learner-response" && e.questionId && e.support && e.learnerQuote.trim() && questions.some((q) => q.id === e.questionId && q.nodeId === node.nodeId && q.text.trim()));
    const independent = verified.filter((e) => e.support === "none" && e.strength === "sufficient" && e.criterion !== "performance");
    const criteria = [...new Set(independent.map((e) => e.criterion))];
    const missingCriteria = required.filter((c) => !criteria.includes(c as typeof criteria[number]));
    const misconceptions = node.misconceptions.filter((m) => m.status === "open" && m.evidenceQuote?.trim()).map((m) => m.description);
    const evidence = [...new Map(verified.map((e) => {
      const id = memoryId(state.conversationId, state.learningSessionId, node.nodeId, e.questionId!, e.learnerQuote, e.criterion);
      return [id, { id, criterion: e.criterion, quote: e.learnerQuote, question: questions.find((q) => q.id === e.questionId)!.text, support: e.support!, observedAt: state.updatedAt, conversationId: state.conversationId, learningSessionId: state.learningSessionId }];
    })).values()];
    return { id: memoryId(state.conversationId, state.learningSessionId, node.nodeId), title: concept?.title || node.nodeId, scope: `${experience.title}（${experience.topic}）：${concept?.target || "仅限本课程练习范围"}`, status: missingCriteria.length === 0 && misconceptions.length === 0 ? "independent" : verified.some((e) => e.support !== "none") ? "assisted" : "exposed", needsRecheck: misconceptions.length > 0, ...(independent.length ? { lastVerifiedAt: state.updatedAt } : {}), criteria, missingCriteria, misconceptions, evidence };
  });
  return { experience, skills };
}

export function relevantSkills(skills: MemorySkill[], query: string): MemorySkill[] {
  const tokens = (query.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) ?? []).flatMap((t) => /\p{Script=Han}/u.test(t) ? Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)) : [t]);
  const stop = new Set(["学习", "什么", "一下", "帮我", "这个", "如何", "可以", "现在", "想学"]);
  return skills.map((skill) => ({ skill, score: [...new Set(tokens)].filter((t) => !stop.has(t) && `${skill.title} ${skill.scope}`.toLowerCase().includes(t)).length })).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map((r) => r.skill);
}
