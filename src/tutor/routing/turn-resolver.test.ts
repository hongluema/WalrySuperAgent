import assert from "node:assert/strict";
import test from "node:test";
import { TurnResolver } from "./turn-resolver.js";

test("帮我学一个主题默认创建长期课程", async () => {
  const resolution = await new TurnResolver().resolve({
    message: "帮我学概率论",
    hasActiveSession: false,
  });

  assert.equal(resolution.target, "tutor");
  assert.equal(resolution.mode, "course");
  assert.equal(resolution.sessionCommand, "CREATE");
  assert.equal(resolution.primaryIntent, "START_LEARNING");
  assert.equal(resolution.explicitAction, "DIAGNOSE");
  assert.equal(resolution.policyVersion, "turn-routing.v1");
});

test("课程中的换例子请求只改变本轮教学动作", async () => {
  const resolution = await new TurnResolver().resolve({
    message: "换个工作里的例子",
    hasActiveSession: true,
    phase: "teach",
    currentTopic: "概率论",
  });

  assert.equal(resolution.target, "tutor");
  assert.equal(resolution.sessionCommand, "CONTINUE");
  assert.equal(resolution.primaryIntent, "REQUEST_EXAMPLE");
  assert.equal(resolution.explicitAction, "DEMONSTRATE");
});

test("课程中的直接讲解请求不会被当成学习证据", async () => {
  const resolution = await new TurnResolver().resolve({
    message: "别反问了，直接给我讲清楚",
    hasActiveSession: true,
    phase: "teach",
  });

  assert.equal(resolution.primaryIntent, "REQUEST_EXPLANATION");
  assert.equal(resolution.explicitAction, "EXPLAIN");
  assert.equal(resolution.sessionCommand, "CONTINUE");
});

test("活动课程中的明确新学习目标被识别为主题切换", async () => {
  const resolution = await new TurnResolver().resolve({
    message: "这门先放一下，我想改学写作",
    hasActiveSession: true,
    phase: "diagnose",
    currentTopic: "Vibe Coding",
  });

  assert.equal(resolution.target, "tutor");
  assert.equal(resolution.sessionCommand, "SWITCH");
  assert.equal(resolution.primaryIntent, "START_LEARNING");
  assert.match(resolution.requestedTopic ?? "", /写作/);
});

test("活动课程中的明确旁路快问交给通用 Agent 且不改课程", async () => {
  const resolution = await new TurnResolver().resolve({
    message: "顺便问一下，今天天气怎么样？",
    hasActiveSession: true,
    phase: "teach",
  });

  assert.equal(resolution.target, "generic");
  assert.equal(resolution.mode, "quick");
  assert.equal(resolution.sessionCommand, "NONE");
  assert.equal(resolution.primaryIntent, "ASK_QUESTION");
});

test("语义分类失败时保守回退到当前课程回答，不丢学习轮次", async () => {
  const resolver = new TurnResolver(async () => {
    throw new Error("classifier unavailable");
  });
  const resolution = await resolver.resolve({
    message: "我觉得这里关键是条件概率",
    hasActiveSession: true,
    phase: "teach",
  });

  assert.equal(resolution.target, "tutor");
  assert.equal(resolution.sessionCommand, "CONTINUE");
  assert.equal(resolution.primaryIntent, "SUBMIT_ANSWER");
  assert.ok(resolution.reasonCodes.includes("semantic-classifier-fallback"));
});
