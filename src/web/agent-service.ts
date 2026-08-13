import "dotenv/config";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { createMockModel } from "../mock-model.js";
import { agentLoop, type AgentLoopEvent } from "../agent/loop.js";
import {
  PromptBuilder,
  sessionContext,
  toolGuide,
} from "../context/prompt-builder.js";
import { loadConfig } from "../config/loader.js";
import type { SuperAgentConfig } from "../config/schema.js";
import { calculatorTool, weatherTool } from "../tools/utility-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { TutorOrchestrator } from "../tutor/orchestrator.js";
import type { TutorEvent, VisibleReasoningTrace } from "../tutor/types.js";
import { LocalTraceRecorder } from "../trace/recorder.js";
import { AiTutorModelClient } from "../tutor/model-client.js";

export interface WebAgentRunInput {
  conversationId: string;
  message: string;
  diagnosticAnswers?: Record<string, string>;
}

export interface WebAgentRunResult {
  runId: string;
  conversationId: string;
  message: {
    role: "assistant";
    content: string;
  };
}

function createModel(config: SuperAgentConfig["model"]): any {
  if (!config.apiKey) return createMockModel();
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
  return provider.chat(config.name);
}

function assistantText(message: ModelMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("");
}

function makeWebTrace(
  _input: WebAgentRunInput,
  evidence: string[],
  action: string,
  reason: string,
  stateUpdates: string[],
  sourceCount = 0,
): VisibleReasoningTrace {
  return {
    phase: "teach",
    rawThinking: [reason, ...evidence, ...stateUpdates].join("\n"),
    selectedAction: action,
    sourceCount,
  };
}

/**
 * Web 专用 Agent Facade。
 *
 * 它刻意不复用 src/main.ts：main.ts 会启动 CLI、飞书、Cron、Memory、
 * MCP 和完整本地工具集。Web 首版只装配模型、Prompt、Agent Loop 以及
 * 两个低风险只读工具，避免把本地自动化能力暴露给浏览器请求。
 */
export class WebAgentService {
  private readonly model: any;
  private readonly promptBuilder: PromptBuilder;
  private readonly sessions = new Map<string, ModelMessage[]>();
  private readonly tutor: TutorOrchestrator;
  private runQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    const config = loadConfig();
    this.model = createModel(config.model);
    this.tutor = new TutorOrchestrator(undefined, new AiTutorModelClient(this.model));
    this.promptBuilder = new PromptBuilder()
      .pipe(
        "webRules",
        () =>
          "你是 Cheerful AI 的 Web Agent。只回答用户问题；不要尝试访问本地文件、执行命令或调用未提供的工具。回答清晰、诚实、简洁。",
      )
      .pipe("toolGuide", toolGuide())
      .pipe("sessionContext", sessionContext());
  }

  /**
   * 串行化首版运行，避免当前 loop-detection 模块级历史在并发请求间串扰。
   * 后续将循环检测改为 Run Context 后，再开放并发执行。
   */
  run(
    input: WebAgentRunInput,
    signal?: AbortSignal,
    onEvent?: (event: AgentLoopEvent | TutorEvent) => void | Promise<void>,
  ): Promise<WebAgentRunResult> {
    const task = this.runQueue.then(() => this.runInternal(input, signal, onEvent));
    this.runQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async runInternal(
    input: WebAgentRunInput,
    signal?: AbortSignal,
    onEvent?: (event: AgentLoopEvent | TutorEvent) => void | Promise<void>,
  ): Promise<WebAgentRunResult> {
    let traceRecorder: LocalTraceRecorder | undefined;
    try {
      traceRecorder = await LocalTraceRecorder.start({
        sessionId: input.conversationId,
        model: this.model?.modelId ?? "web-model",
      });
    } catch (error) {
      console.warn("  [Trace] 无法启动本地 trace，继续执行 Agent:", error);
    }

    const emit = async (event: AgentLoopEvent | TutorEvent) => {
      await traceRecorder?.recordEvent(event);
      await onEvent?.(event);
    };

    const tutorSession = await this.tutor.hasActiveSession(input.conversationId);
    try {
      if (tutorSession || this.tutor.isTutorIntent(input.message)) {
        await this.tutor.run(
          input.conversationId,
          input.message,
          emit,
          signal,
          { diagnosticAnswers: input.diagnosticAnswers },
        );
        await traceRecorder?.finish("completed");
        return {
          runId: `run_${Date.now().toString(36)}`,
          conversationId: input.conversationId,
          message: { role: "assistant", content: "" },
        };
      }

      const messages = this.sessions.get(input.conversationId) ?? [];
      messages.push({ role: "user", content: input.message });

      const registry = new ToolRegistry();
      // Web MVP 只开放显式允许的只读工具；文件、Shell、Cron、MCP 和子 Agent
      // 都不会被注册，因此模型拿不到这些工具定义。
      registry.register(calculatorTool, weatherTool);

      const system = this.promptBuilder.build({
        toolCount: registry.getActiveTools().length,
        deferredToolSummary: "",
        sessionMessageCount: messages.length - 1,
        sessionId: input.conversationId,
      });

      const beforeLength = messages.length;

      const toolCalls: string[] = [];
      await emit({
        type: "reasoning.trace.ready",
        trace: makeWebTrace(
          input,
          ["已接收到用户消息", `当前会话已有 ${messages.length - 1} 条历史消息`],
          "分析问题并决定是否调用工具",
          "先确认问题目标，再依据工具结果或模型知识组织回答",
          ["Agent Loop 已启动"],
        ),
      });

      const emitAgentEvent = async (event: AgentLoopEvent) => {
        if (event.type === "tool-call") toolCalls.push(event.toolName);
        await emit(event);
        if (event.type === "tool-call") {
          await emit({
            type: "reasoning.trace.ready",
            trace: makeWebTrace(
              input,
              [`已选择工具：${event.toolName}`, "工具调用正在执行"],
              `调用 ${event.toolName}`,
              "工具可以补充当前回答所需的外部事实或计算结果",
              [`已记录 ${toolCalls.length} 次工具调用`],
            ),
          });
        }
      };

      await agentLoop(
        this.model,
        registry,
        messages,
        system,
        undefined,
        "[web]",
        8,
        signal,
        traceRecorder,
        emitAgentEvent,
      );
      await traceRecorder?.finish("completed");

      const reply = assistantText(messages.slice(beforeLength).at(-1));
      if (!reply) {
        throw new Error("Agent 没有生成文本回答");
      }

      await emit({
        type: "reasoning.trace.ready",
        trace: makeWebTrace(
          input,
          ["模型已生成文本回答", ...(toolCalls.length ? [`使用工具：${toolCalls.join("、")}`] : ["本轮无需调用工具"])],
          "输出回答",
          "回答已生成，并完成了本轮 Agent Loop",
          [`回答长度：${reply.length} 字符`, "会话消息已更新", "本地 trace 已完成"],
          toolCalls.length,
        ),
      });

      this.sessions.set(input.conversationId, messages.slice(-20));
      return {
        runId: `run_${Date.now().toString(36)}`,
        conversationId: input.conversationId,
        message: { role: "assistant", content: reply },
      };
    } catch (error) {
      await traceRecorder?.finish(signal?.aborted ? "cancelled" : "failed", error);
      throw error;
    }
  }
}
