import 'dotenv/config';
import { loadConfig } from './config/loader.js';
import type { SuperAgentConfig } from './config/schema.js';
import fs from 'node:fs';
import { type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model.js';
import { ToolRegistry } from './tools/registry.js';
import { allTools } from './tools/index.js';
import { createToolSearchTool } from './tools/tool-search.js';
import { createMemoryTool } from './tools/memory-tools.js';
import { createRagTools } from './tools/rag-tools.js';
import { MockMCPClient } from './tools/mcp-client.js';
import { agentLoop, type AgentLoopListener } from './agent/loop.js';
import { SessionStore } from './session/store.js';
import {
  PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext,
  type PromptContext,
} from './context/prompt-builder.js';
import { UsageTracker } from './usage/tracker.js';
import { MemoryStore } from './memory/store.js';
import { memoryContext, ragContext, tutorPedagogy } from './context/prompt-pipes.js';
import { chunkDocument } from './rag/chunker.js';
import { createMockEmbedder, createDashScopeEmbedder, embed } from './rag/embedder.js';
import { VectorStore } from './rag/store.js';
import { SkillLoader } from './skills/loader.js';
import { PluginManager } from './plugins/manager.js';
import { supabasePlugin } from './plugins/supabase-plugin.js';
import type { PluginDefinition } from './plugins/types.js';
import { ChannelGateway } from './channels/gateway.js';
import { FeishuChannel } from './channels/feishu.js';
import { HookPipeline } from './security/hooks.js';
import { CronService } from './cron/service.js';
import { createCronTool } from './tools/cron-tools.js';
import { SubAgentRegistry } from './agents/registry.js';
import { createSpawnTool } from './tools/spawn-tools.js';
import type { SpawnContext } from './agents/spawn.js';

export interface AgentRuntime {
  config: SuperAgentConfig;
  model: any;
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
  gateway: ChannelGateway;
  cronService: CronService;
  pluginManager: PluginManager;
  hookPipeline: HookPipeline;
  agentRegistry: SubAgentRegistry;
  skillLoader: SkillLoader;
  activeSkills: Set<string>;
  makePromptCtx: () => PromptContext;
  getConversation(conversationId: string): { messages: ModelMessage[]; store: SessionStore };
  start(opts?: { channels?: boolean; cron?: boolean }): Promise<void>;
  shutdown(): Promise<void>;
  runTurn(input: {
    conversationId: string;
    message: string;
    onEvent?: AgentLoopListener;
    signal?: AbortSignal;
  }): Promise<void>;
}

function createModel(cfg: SuperAgentConfig['model']) {
  if (!cfg.apiKey) return createMockModel();
  const provider = createOpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  return provider.chat(cfg.name);
}

export function sanitizeConversationId(raw: string): string {
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'new';
}

export function createRuntime(): AgentRuntime {
  const config = loadConfig();
  const model = createModel(config.model);

  const registry = new ToolRegistry();
  registry.register(...allTools);
  registry.register(createToolSearchTool(registry));

  const memoryStore = new MemoryStore(config.memory.dataDir);
  memoryStore.init();
  registry.register(createMemoryTool(memoryStore));

  const vectorStore = new VectorStore();
  const dashscopeKey = process.env.DASHSCOPE_API_KEY;
  const embedFn = dashscopeKey
    ? createDashScopeEmbedder(dashscopeKey)
    : createMockEmbedder();
  registry.register(...createRagTools(vectorStore, embedFn));

  const skillLoader = new SkillLoader('.');
  skillLoader.load();
  const activeSkills = new Set<string>();

  const pluginManager = new PluginManager(registry);
  const availablePlugins = new Map<string, PluginDefinition>([
    ['supabase', supabasePlugin],
  ]);

  const hookPipeline = new HookPipeline();
  hookPipeline.registerPre('audit-log', (toolName, input) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = (input as { path?: string })?.path || 'unknown';
      console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
    }
    return { action: 'allow' };
  });
  hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
    if (toolName === 'bash') {
      const timestamp = new Date().toISOString();
      return { action: 'modify', modifiedOutput: `[${timestamp}]\n${output}` };
    }
    return { action: 'allow' };
  });
  registry.setHookPipeline(hookPipeline);

  const cronService = new CronService(config.cron.dataDir);
  registry.register(createCronTool(cronService));

  const agentRegistry = new SubAgentRegistry({
    maxSpawnDepth: config.agents.maxSpawnDepth,
    maxConcurrent: config.agents.maxConcurrent,
  });

  function makePromptCtx(): PromptContext {
    return {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: 0,
      sessionId: config.session.id,
    };
  }

  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('tutorPedagogy', tutorPedagogy(skillLoader))
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', memoryContext(memoryStore))
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
    .pipe('sessionContext', sessionContext());

  function getSpawnCtx(): SpawnContext {
    return {
      model,
      registry,
      agentRegistry,
      buildSystem: () => builder.build(makePromptCtx()),
      currentDepth: 0,
    };
  }
  registry.register(createSpawnTool(agentRegistry, getSpawnCtx));

  const gateway = new ChannelGateway({
    model,
    registry,
    buildSystem: () => builder.build(makePromptCtx()),
  });

  const FEISHU_PORT = Number(process.env.FEISHU_PORT || config.channels.feishu.port || '3000');
  gateway.register(new FeishuChannel({
    appId: process.env.FEISHU_APP_ID || config.channels.feishu.appId || '',
    appSecret: process.env.FEISHU_APP_SECRET || config.channels.feishu.appSecret || '',
    port: FEISHU_PORT,
  }));

  const tracker = new UsageTracker(config.usage.trackingFile);
  const conversations = new Map<string, ModelMessage[]>();
  const stores = new Map<string, SessionStore>();
  const turnLocks = new Map<string, Promise<void>>();

  function conversation(id: string) {
    const key = sanitizeConversationId(id);
    if (!conversations.has(key)) {
      const store = new SessionStore(key);
      conversations.set(key, store.load());
      stores.set(key, store);
    }
    return {
      key,
      messages: conversations.get(key)!,
      store: stores.get(key)!,
    };
  }

  async function start(opts: { channels?: boolean; cron?: boolean } = {}) {
    const mockClient = new MockMCPClient();
    const tools = await registry.registerMCPServer('github', mockClient);
    console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);

    console.log('  加载插件...');
    for (const [name, def] of availablePlugins) {
      try {
        const loaded = await pluginManager.load(def);
        console.log(`  ✓ ${name} — ${loaded.length} 个工具`);
      } catch {
        console.log(`  ✗ ${name} — 加载失败`);
      }
    }

    if (opts.channels !== false) {
      console.log('  启动 Channel...');
      await gateway.startAll();
    }

    if (opts.cron !== false) {
      cronService.load();
      cronService.setExecutor({
        runAgentPrompt: async (prompt) => {
          const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
          const system = builder.build(makePromptCtx());
          await agentLoop(model, registry, cronMessages, system);
          const lastMsg = cronMessages[cronMessages.length - 1];
          if (!lastMsg) return '(无输出)';
          if (typeof lastMsg.content === 'string') return lastMsg.content;
          if (Array.isArray(lastMsg.content)) {
            return lastMsg.content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('') || '(无输出)';
          }
          return String(lastMsg.content);
        },
        notify: (message) => {
          console.log(`\n${message}`);
        },
      });
      cronService.start();
    }

    if (fs.existsSync('docs')) {
      const files = fs.readdirSync('docs').filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
        for (const f of files) {
          const path = `docs/${f}`;
          const text = fs.readFileSync(path, 'utf-8');
          const chunks = chunkDocument(path, text);
          const embeddings = await embed(embedFn, chunks.map(c => c.text));
          vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })));
        }
        console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段`);
      }
    }
  }

  async function shutdown() {
    cronService.stop();
    await gateway.stopAll();
    await pluginManager.unloadAll();
  }

  async function runTurn(input: {
    conversationId: string;
    message: string;
    onEvent?: AgentLoopListener;
    signal?: AbortSignal;
  }) {
    const { key, messages, store } = conversation(input.conversationId);
    const previous = turnLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turnLocks.set(key, previous.then(() => gate));
    await previous;

    try {
      const userMsg: ModelMessage = { role: 'user', content: input.message };
      messages.push(userMsg);
      store.append(userMsg);

      const beforeLen = messages.length;
      await agentLoop(
        model,
        registry,
        messages,
        builder.build(makePromptCtx()),
        tracker,
        undefined,
        undefined,
        input.signal,
        input.onEvent,
      );

      store.appendAll(messages.slice(beforeLen));
    } finally {
      release();
    }
  }

  return {
    config,
    model,
    registry,
    builder,
    tracker,
    memoryStore,
    vectorStore,
    gateway,
    cronService,
    pluginManager,
    hookPipeline,
    agentRegistry,
    skillLoader,
    activeSkills,
    makePromptCtx,
    getConversation: (conversationId: string) => {
      const { messages, store } = conversation(conversationId);
      return { messages, store };
    },
    start,
    shutdown,
    runTurn,
  };
}
