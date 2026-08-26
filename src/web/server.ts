import { serve } from '@hono/node-server';
import { createRuntime } from '../runtime.js';
import { createWebApp } from './app.js';

const DEFAULT_PORT = 3100;

export async function startWeb() {
  const port = Number(process.env.WALRY_PORT || process.env.WEB_PORT || DEFAULT_PORT);
  const rt = createRuntime();

  await rt.start({
    channels: false,
    cron: true,
  });

  const app = createWebApp(async (input) => {
    await rt.runTurn(input);
  });

  let server: ReturnType<typeof serve>;
  try {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ 无法监听 127.0.0.1:${port}: ${message}`);
    console.error('  换一个端口：WALRY_PORT=3101 pnpm web');
    await rt.shutdown();
    process.exit(1);
  }

  const shutdown = async () => {
    console.log('\n正在关闭 Web 服务...');
    server.close();
    await rt.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const role = rt.registry.getRole();
  const toolCount = rt.registry.getActiveTools().length;
  console.log('\nSuper Agent v1.0 Web');
  console.log(`  监听 http://127.0.0.1:${port}`);
  console.log(`  对话流 POST /api/v1/runs  （SSE: text-delta / tool-call / done）`);
  console.log(`  健康检查 GET /health`);
  console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
  console.log(`  前端 cheerful-sitor 用 WALRY_AGENT_URL 指向这里（默认 http://127.0.0.1:3100）\n`);
}
