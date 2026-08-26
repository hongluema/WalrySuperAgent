import { createInterface } from 'node:readline';
import { createRuntime } from './runtime.js';
import { estimateMessageTokens } from './context/defense.js';
import { createDispatcher, type CommandContext } from './commands/index.js';
import { debugCommands } from './commands/debug.js';
import { contextCommands } from './commands/context.js';
import { memoryCommands } from './commands/memory.js';
import { ragCommands } from './commands/rag.js';
import { dreamCommands } from './commands/dream.js';
import { createSkillCommands } from './commands/skill.js';
import { createPluginCommands } from './commands/plugin.js';
import { createChannelCommands } from './commands/channel.js';
import { createSecurityCommands } from './commands/security.js';
import { createCronCommands } from './commands/cron.js';
import { createAgentCommands } from './commands/agent.js';
import { supabasePlugin } from './plugins/supabase-plugin.js';
import type { PluginDefinition } from './plugins/types.js';

export async function startAgent() {
  const rt = createRuntime();
  await rt.start({ channels: true, cron: true });

  const availablePlugins = new Map<string, PluginDefinition>([
    ['supabase', supabasePlugin],
  ]);

  const dispatch = createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...memoryCommands,
    ...ragCommands,
    ...dreamCommands,
    ...createSkillCommands(rt.skillLoader, rt.activeSkills),
    ...createPluginCommands(rt.pluginManager, availablePlugins),
    ...createChannelCommands(rt.gateway),
    ...createSecurityCommands(rt.registry, rt.hookPipeline),
    ...createCronCommands(rt.cronService),
    ...createAgentCommands(rt.agentRegistry),
  ]);

  const { messages, store } = rt.getConversation('default');
  const timestamps = new Map<number, number>();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        await rt.shutdown();
        rl.close();
        return;
      }

      const ctx: CommandContext = {
        messages, timestamps, registry: rt.registry, builder: rt.builder, tracker: rt.tracker,
        sessionStore: store, model: rt.model, makePromptCtx: rt.makePromptCtx, ask,
        memoryStore: rt.memoryStore, vectorStore: rt.vectorStore,
      };
      const handled = dispatch(trimmed, ctx);
      if (handled === 'async') return;
      if (handled) { ask(); return; }

      await rt.runTurn({ conversationId: 'default', message: trimmed });

      console.log(`  [Token] ~${estimateMessageTokens(messages)} tokens`);
      ask();
    });
  }

  const role = rt.registry.getRole();
  const toolCount = rt.registry.getActiveTools().length;
  const alwaysOn = rt.skillLoader.alwaysOnSkills();

  console.log('\nSuper Agent v1.0 CLI (type "exit" to quit)');
  console.log('快捷命令：');
  console.log('  /agents           — 查看子 Agent 记录');
  console.log('  /cron             — 查看定时任务');
  console.log('  /role [角色]      — 查看/切换角色');
  console.log('');
  console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
  if (alwaysOn.length > 0) {
    console.log(`  教学法: ${alwaysOn.map(s => s.name).join(', ')} （始终启用，直接说「教我 XX」即可）`);
  }
  console.log(`  Sub-Agent: 最大深度 ${rt.agentRegistry.getConfig().maxSpawnDepth}，最大并发 ${rt.agentRegistry.getConfig().maxConcurrent}`);
  console.log('');
  console.log('  试试：');
  console.log('    帮我对比 Hono、Fastify 和 Express 的性能和生态');
  console.log('    /agents       — 查看子 Agent 执行记录');
  console.log('');

  ask();
}
