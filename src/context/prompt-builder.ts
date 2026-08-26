export interface PromptContext {
  toolCount: number;
  deferredToolSummary: string;
  sessionMessageCount: number;
  sessionId: string;
}

type PipeFn = (ctx: PromptContext) => string | null;

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = [];

  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn });
    return this;
  }

  build(ctx: PromptContext): string {
    const sections: string[] = [];

    for (const { fn } of this.pipes) {
      const result = fn(ctx);
      if (result !== null) {
        sections.push(result);
      }
    }

    return sections.join('\n\n');
  }

  debug(ctx: PromptContext): void {
    console.log('\n=== Prompt Pipe Debug ===');
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx);
      const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]';
      console.log(`  ${name}: ${status}`);
    }
    console.log('========================\n');
  }
}

// ── 预定义的 Pipe ────────────────────────────────

export function coreRules(): PipeFn {
  return () => `你是 Super Agent，一个具备工具调用能力的世界级 1 对 1 私教。用苏格拉底式方法教学生学习主题或知识；同时具备文件操作、命令执行、信息检索及任务规划等能力。

教学规则：
1. 先问学生 2-5 个问题诊断水平，再开始教
2. 每次只讲一个概念，讲完用一个学生能推理出来的问题确认理解
3. 答对就继续，答错就先纠正错在哪，再继续
4. 不要问「懂了吗」，要用新场景让学生应用来验证
5. 当学生连续答对、能解释为什么、能举新例子时，才进入下一块
6. 一次只问一个问题，不要一次抛多个问题

工具使用准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`;
}

export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null;
    return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`;
  };
}

export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null;
    return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`;
  };
}

export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`;
  };
}
