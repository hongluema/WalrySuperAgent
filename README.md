# WalrySuperAgent

## 动态意图识别的版本 - 很完善了

### 启动web端

执行命令：pnpm web

## 知识库第一阶段：MinerU 解析与检索

第一阶段已经提供独立的知识库 HTTP 接口：Walry 负责上传、调用 MinerU、保存解析产物、分块和向量化；Tutor 仍未在本阶段自动使用知识库，第二阶段再接入 `TutorOrchestrator`。

### 启动 MinerU

建议把 MinerU 作为单独的 Python 服务运行，不放进 Node Agent 容器：

```bash
mineru-api --host 127.0.0.1 --port 8000
```

如果想只启动一个命令，可以在修复当前 Python 环境的 `_lzma` 支持后使用：

```bash
pnpm web:with-mineru
```

这个命令会复用项目根目录的 `.venv-mineru`，先启动并检查 MinerU，再启动 Walry Web；退出 Walry 时会回收由它启动的 MinerU。如果 MinerU 已经在 `127.0.0.1:8000` 运行，则会直接复用已有进程。

Walry `.env` 至少配置：

```env
MINERU_BASE_URL=http://127.0.0.1:8000
KNOWLEDGE_DATA_DIR=.knowledge-data
DASHSCOPE_API_KEY=你的EmbeddingKey
KNOWLEDGE_BASE_ID=default
KNOWLEDGE_OWNER_ID=local
KNOWLEDGE_MAX_UPLOAD_BYTES=52428800
MINERU_TIMEOUT_MS=600000
MINERU_BACKEND=pipeline
# 如果 Walry 不是只监听本机，必须配置；请求使用 Authorization: Bearer <token>
KNOWLEDGE_API_TOKEN=替换成随机长字符串
# 配置后使用 PostgreSQL/pgvector；不配置时使用 .knowledge-data/index.json
POSTGRES_URL=postgresql://...
```

如果使用 PostgreSQL，数据库用户需要能够启用 `vector` 扩展。知识库服务首次访问时会创建 `knowledge_documents` 和 `knowledge_chunks` 表。

### 上传文档

```bash
curl -X POST http://127.0.0.1:3100/api/v1/knowledge/documents \
  -F 'file=@/absolute/path/lesson.pdf' \
  -H 'Authorization: Bearer 替换成随机长字符串'
```

支持范围由当前 MinerU 服务决定，通常包括 PDF、图片、DOCX、PPTX 和 XLSX。原文件、Markdown、`content-list.json` 和解析出的图片会保存在 `KNOWLEDGE_DATA_DIR/documents/<documentId>/`。

### 检索文档

```bash
curl -X POST http://127.0.0.1:3100/api/v1/knowledge/search \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer 替换成随机长字符串' \
  -d '{"query":"现金流和资产的关系","topK":5}'
```

第一阶段固定使用 `KNOWLEDGE_BASE_ID + KNOWLEDGE_OWNER_ID` 作为单知识库 scope，客户端不能通过请求体伪造 owner。默认只允许本机访问；如果部署到非本机监听地址，必须配置 `KNOWLEDGE_API_TOKEN`。第二阶段接入 Sitor 登录后，再把 owner 替换为服务端解析出的真实用户 ID。

检索结果会返回文档名、页码、章节、分块内容和分数。

## 最成熟

目前做的最好的agent分支是gpt-cheerful-sitor

## 错题记录

和grok 每次修agent问题，修复几轮之后，可以要求记录下，这样说：

```
把咱俩今天的对话，修复agent和前端问题的日志总结记录下，放到walrySuperAgent 的Error.md 中，格式是：

错误【index】:
【时间】：xxx
【问题描述】：xxx
【错误原因分析】：xxxx
【解决思路】：xxxx
【解决办法】：xxxx

不用写改动的代码，只需要写思路，都是总结的，切记：写之前，先查看下的Error.md，之前记录过的不要在记录了，只记录新的
```

## 本地调试pg数据库

1. 在你自己电脑的本地终端执行，不是在服务器上执行。
   Mac 可以打开“终端”后运行：
   `ssh -N -L 5433:127.0.0.1:5432 ubuntu@124.221.211.24`

输入服务器密码后，终端会一直停在那里、不显示内容，这是正常的：SSH 隧道正在运行。不要关闭这个终端。

此时你本地的 Agent 项目连接：

postgresql://agent_user:你的数据库密码@127.0.0.1:5433/agent_db

先在本地保持 SSH 隧道运行，再另开一个终端，连接数据库：

```bash
psql -h 127.0.0.1 -p 5433 -U agent_user -d agent_db
```

关闭该终端或按 Ctrl+C，隧道就会断开。

它会提示你输入数据库密码。进入后常用命令：

```SQL
-- 查看所有数据库
\l

-- 切换数据库
\c agent_db

-- 查看当前库里的表
\dt

-- 查看某张表的结构
\d 表名

-- 查看表数据（建议先限制数量）
SELECT * FROM 表名 LIMIT 20;

-- 查看表的列信息
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = '表名';

-- 查看已启用的扩展，确认 pgvector
\dx

-- 退出
\q
```
