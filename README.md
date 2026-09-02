# WalrySuperAgent

### 启动web端

执行命令：pnpm web

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
