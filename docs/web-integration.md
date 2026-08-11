# Walry Web Agent 服务

## 用途

`src/web/server.ts` 是 Cheerful AI 方案 A 的独立 Agent 服务入口。

它不会导入 `src/main.ts`，因此不会启动 CLI、飞书、Cron、MCP、插件、Memory、RAG 或完整本地工具集。

Web MVP 只装配：

- 配置中的模型适配器；
- Web 专用 Prompt；
- 现有 Agent Loop；
- `calculator` 和 `get_weather` 两个低风险只读工具；
- Hono HTTP API。

文件工具、Shell、Cron、飞书和 Sub-Agent 代码仍保留在项目中，但不属于 Web 入口的装配图。

## 启动

在 WalrySuperAgent 目录执行：

```bash
pnpm web
```

项目当前使用 Node.js 22+。如果没有配置模型密钥，服务会使用项目内置的 Mock Model，适合先验证 Cheerful 到 Walry 的链路；接真实模型时再按现有配置提供对应的环境变量。

默认监听 `http://127.0.0.1:3100`，也可以使用：

```bash
WALRY_WEB_PORT=3100 pnpm web
```

Cheerful BFF 默认请求 `http://127.0.0.1:3100`。如果 Walry 部署在其他地址，在 Cheerful 服务端设置 `WALRY_AGENT_URL`。

## API

### 健康检查

```text
GET /health
```

### 创建一次 Agent Run

```text
POST /api/v1/runs
Content-Type: application/json
```

请求：

```json
{
  "conversationId": "product",
  "message": "帮我梳理一个 AI 产品的第一版需求"
}
```

成功响应：

```json
{
  "runId": "run_xxx",
  "conversationId": "product",
  "message": {
    "role": "assistant",
    "content": "..."
  }
}
```

错误响应统一使用：

```json
{
  "error": {
    "code": "AGENT_RUN_FAILED",
    "message": "..."
  }
}
```

## 当前限制

- 首版接口是非流式 JSON；等 Cheerful 闭环稳定后再加入 AgentEvent 流。
- 会话暂存在 Walry 进程内，服务重启后丢失。
- 首版服务串行执行 Agent Run，以隔离现有模块级循环检测状态。
- 首版不提供文件、Shell、Cron、飞书、MCP、插件和 Sub-Agent 能力。
- 模型密钥只从 Walry 服务端配置读取，不经过 Cheerful 浏览器。

## 接入边界

浏览器不直接访问 Walry，而是请求 Cheerful 的同源接口：

```text
Browser → Cheerful /api/agent/runs → Walry /api/v1/runs → Model
```

这样可以把模型凭证、Walry 内部地址、用户身份和限流策略留在服务端。

## 后续流式化

下一阶段给 `agentLoop()` 注入 Event Sink：

- 文本增量转换为 `message.delta`；
- 工具调用转换为 `tool.started` / `tool.completed`；
- 完成转换为 `run.completed`；
- 错误转换为 `run.failed`。

CLI 继续使用 Console Sink，Web 使用 HTTP Stream Sink，二者共享 Agent Core。
