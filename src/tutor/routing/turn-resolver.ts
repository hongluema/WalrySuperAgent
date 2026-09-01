import type { ClientTutorCommand, PedagogicalAction, SessionCommand, TurnResolution, TutorPhase, UserIntent } from "../types.js";
import { isDirectHelpRequest, isSystematicLearningIntent } from "../topic-model.js";

export type TurnRoutingInput = {
  message: string;
  hasActiveSession: boolean;
  phase?: TutorPhase;
  currentTopic?: string;
  sessionMode?: "teach" | "explain";
  clientCommand?: ClientTutorCommand;
};

export type SemanticTurnCandidate = {
  target: "tutor" | "generic";
  primaryIntent: UserIntent;
  sessionCommand: SessionCommand;
  requestedTopic?: string;
  explicitAction?: PedagogicalAction;
  confidence: number;
  reason?: string;
};

export type SemanticTurnClassifier = (input: TurnRoutingInput) => Promise<SemanticTurnCandidate>;

export const TURN_ROUTING_POLICY_VERSION = "turn-routing.v1";

function resolution(input: Omit<TurnResolution, "intents" | "policyVersion">): TurnResolution {
  return {
    ...input,
    intents: [{ type: input.primaryIntent, confidence: input.confidence }],
    policyVersion: TURN_ROUTING_POLICY_VERSION,
  };
}

function requestedTopic(message: string): string | undefined {
  const match = message.match(/(?:改学|转学|换成学习|换成学|想学习|想学|学习|学)([^，。！？!?\n]{1,60})/u);
  return match?.[1]?.trim();
}

function explicitCourseCommand(input: TurnRoutingInput): TurnResolution | undefined {
  const message = input.message.trim();
  const nextTopic = requestedTopic(message);
  const normalizedCurrent = input.currentTopic?.replace(/\s+/gu, "").toLowerCase();
  const normalizedNext = nextTopic?.replace(/\s+/gu, "").toLowerCase();
  const asksForNewLearning = /(?:先放一下|先暂停|换个主题|切换主题|改学|转学|换成学|我想学|我想学习|想要学|想要学习)/u.test(message);
  const namesDifferentTopic = Boolean(normalizedNext && (!normalizedCurrent || !normalizedCurrent.includes(normalizedNext)));
  const base = {
    target: "tutor" as const,
    mode: "course" as const,
    sessionCommand: "CONTINUE" as const,
    confidence: 0.98,
  };

  if (asksForNewLearning && namesDifferentTopic) {
    return resolution({
      ...base,
      primaryIntent: "START_LEARNING",
      sessionCommand: "SWITCH",
      requestedTopic: nextTopic,
      explicitAction: "CLARIFY_GOAL",
      reasonCodes: ["explicit-topic-switch"],
    });
  }
  if (/(?:换|再来|举|给).{0,8}(?:例子|案例)|(?:例子|案例).{0,8}(?:换|再来|举|给)/u.test(message)) {
    return resolution({
      ...base,
      primaryIntent: "REQUEST_EXAMPLE",
      explicitAction: "DEMONSTRATE",
      reasonCodes: ["explicit-example-request"],
    });
  }
  if (isDirectHelpRequest(message) || /(?:别|不要|不用).{0,6}(?:反问|提问).{0,10}(?:直接|讲|告诉)/u.test(message)) {
    return resolution({
      ...base,
      primaryIntent: "REQUEST_EXPLANATION",
      explicitAction: "EXPLAIN",
      reasonCodes: ["explicit-explanation-request"],
    });
  }
  if (/(?:给我|来个|需要|再给).{0,6}(?:提示|思路|线索)|^(?:提示|给点提示)$/u.test(message)) {
    return resolution({
      ...base,
      primaryIntent: "REQUEST_HINT",
      explicitAction: "GIVE_HINT",
      reasonCodes: ["explicit-hint-request"],
    });
  }
  if (/(?:出|来|给).{0,8}(?:练习|题目|练练)|(?:我想|让我).{0,6}(?:练习|练练)/u.test(message)) {
    return resolution({
      ...base,
      primaryIntent: "REQUEST_PRACTICE",
      explicitAction: "GUIDED_PRACTICE",
      reasonCodes: ["explicit-practice-request"],
    });
  }
  if (/(?:测测我|考考我|做个测评|开始测试|检查掌握)/u.test(message)) {
    return resolution({
      ...base,
      primaryIntent: "REQUEST_ASSESSMENT",
      explicitAction: "ASSESS",
      reasonCodes: ["explicit-assessment-request"],
    });
  }
  if (/(?:先暂停|暂停学习|稍后继续|先到这里)/u.test(message)) {
    return resolution({
      ...base,
      primaryIntent: "PAUSE",
      sessionCommand: "PAUSE",
      reasonCodes: ["explicit-pause-request"],
    });
  }
  if (/(?:继续学习|接着学|恢复课程)/u.test(message)) {
    return resolution({
      ...base,
      primaryIntent: "RESUME",
      sessionCommand: "RESUME",
      reasonCodes: ["explicit-resume-request"],
    });
  }
  return undefined;
}

function obviousSideQuestion(message: string): boolean {
  const sideMarker = /(?:顺便|另外|题外|与课程无关|先问个别的)/u.test(message);
  const utilityQuestion = /(?:天气|几点|现在时间|汇率|算一下|计算一下|翻译成|股票价格|新闻)/u.test(message);
  return utilityQuestion && (sideMarker || /(?:天气|几点|现在时间)/u.test(message));
}

function fallback(input: TurnRoutingInput, reasonCode: string): TurnResolution {
  if (input.hasActiveSession) {
    return resolution({
      target: "tutor",
      mode: "course",
      primaryIntent: /(?:不知道|不明白|没懂)/u.test(input.message) ? "REPORT_CONFUSION" : "SUBMIT_ANSWER",
      sessionCommand: "CONTINUE",
      confidence: 0.55,
      reasonCodes: [reasonCode],
    });
  }
  return resolution({
    target: "generic",
    mode: "quick",
    primaryIntent: "ASK_QUESTION",
    sessionCommand: "NONE",
    confidence: 0.55,
    reasonCodes: [reasonCode],
  });
}

/**
 * 把每轮自然语言归一为一个当前教学决策。显式规则拥有最终裁决权，
 * 语义分类器只为规则未覆盖的消息提供候选；分类失败不会丢失活动课程。
 */
export class TurnResolver {
  constructor(private readonly classifySemantic?: SemanticTurnClassifier) {}

  async resolve(input: TurnRoutingInput): Promise<TurnResolution> {
    const message = input.message.trim();

    if (input.clientCommand?.type === "UPDATE_SUBJECT") {
      return resolution({
        target: "tutor",
        mode: "course",
        primaryIntent: "CHANGE_GOAL",
        sessionCommand: "MODIFY",
        explicitAction: "CLARIFY_GOAL",
        confidence: 1,
        reasonCodes: ["structured-subject-correction"],
      });
    }

    if (input.hasActiveSession) {
      const command = explicitCourseCommand(input);
      if (command) return command;
      if (obviousSideQuestion(message)) {
        return resolution({
          target: "generic",
          mode: "quick",
          primaryIntent: "ASK_QUESTION",
          sessionCommand: "NONE",
          confidence: 0.98,
          reasonCodes: ["explicit-side-question"],
        });
      }
      if (/^(?:[A-Da-d](?:[\.．、]|$)|完成诊断|不知道|不清楚|没有疑问|没有了|都清楚)/u.test(message)) {
        return fallback(input, "active-course-fast-path");
      }
    } else if (input.sessionMode || isSystematicLearningIntent(message)) {
      return resolution({
        target: "tutor",
        mode: "course",
        primaryIntent: "START_LEARNING",
        sessionCommand: "CREATE",
        requestedTopic: requestedTopic(message),
        explicitAction: input.sessionMode === "explain" ? "EXPLAIN" : "DIAGNOSE",
        confidence: 0.98,
        reasonCodes: [input.sessionMode ? "initial-mode-selection" : "systematic-learning-request"],
      });
    }

    if (!this.classifySemantic) return fallback(input, "deterministic-fallback");
    try {
      const candidate = await this.classifySemantic(input);
      if (input.hasActiveSession && candidate.target === "generic" && candidate.confidence < 0.8) {
        return fallback(input, "low-confidence-generic-rejected");
      }
      const target = candidate.target;
      const sessionCommand = target === "generic"
        ? "NONE"
        : input.hasActiveSession
          ? candidate.sessionCommand === "CREATE" ? "CONTINUE" : candidate.sessionCommand
          : "CREATE";
      return resolution({
        target,
        mode: target === "tutor" ? "course" : "quick",
        primaryIntent: target === "generic" ? "ASK_QUESTION" : candidate.primaryIntent,
        sessionCommand,
        requestedTopic: target === "tutor" ? candidate.requestedTopic : undefined,
        explicitAction: target === "tutor" ? candidate.explicitAction : undefined,
        confidence: candidate.confidence,
        reasonCodes: [candidate.reason || "semantic-classifier", "deterministic-arbitration"],
      });
    } catch {
      return fallback(input, "semantic-classifier-fallback");
    }
  }
}
