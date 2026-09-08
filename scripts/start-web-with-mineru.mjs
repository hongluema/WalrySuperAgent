import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultMineruPython = resolve(projectRoot, "../.venv-mineru/bin/python");
const defaultMineruApi = resolve(projectRoot, "../.venv-mineru/bin/mineru-api");
const mineruPython = process.env.MINERU_PYTHON ?? defaultMineruPython;
const mineruApi = process.env.MINERU_API_BIN ?? defaultMineruApi;
const mineruHost = process.env.MINERU_API_HOST ?? "127.0.0.1";
const mineruPort = Number(process.env.MINERU_API_PORT ?? 8000);
const mineruBaseUrl = process.env.MINERU_BASE_URL ?? `http://${mineruHost}:${mineruPort}`;

if (!existsSync(mineruPython)) {
  console.error(`[web:with-mineru] 找不到 MinerU Python：${mineruPython}`);
  process.exit(1);
}
if (!existsSync(mineruApi)) {
  console.error(`[web:with-mineru] 找不到 mineru-api：${mineruApi}`);
  process.exit(1);
}

const lzmaCheck = spawnSync(mineruPython, ["-c", "import lzma"], { stdio: "pipe" });
if (lzmaCheck.status !== 0) {
  console.error("[web:with-mineru] 当前 Python 缺少 lzma 支持，请先修复 .venv-mineru 的基础 Python。");
  process.exit(1);
}

async function isMineruHealthy() {
  try {
    const response = await fetch(`${mineruBaseUrl.replace(/\/$/u, "")}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForMineru(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isMineruHealthy()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

const alreadyRunning = await isMineruHealthy();
let mineruProcess;
if (!alreadyRunning) {
  mineruProcess = spawn(mineruApi, ["--host", mineruHost, "--port", String(mineruPort)], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  mineruProcess.once("error", (error) => {
    console.error(`[web:with-mineru] MinerU 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}

if (!(await waitForMineru())) {
  console.error(`[web:with-mineru] MinerU 未在 30 秒内就绪：${mineruBaseUrl}`);
  mineruProcess?.kill("SIGTERM");
  process.exit(1);
}

console.log(`[web:with-mineru] MinerU 已就绪：${mineruBaseUrl}`);
const walryProcess = spawn("pnpm", ["web"], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  walryProcess.kill(signal);
  mineruProcess?.kill("SIGTERM");
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

walryProcess.once("error", (error) => {
  console.error(`[web:with-mineru] Walry 启动失败：${error.message}`);
  shutdown("SIGTERM");
  process.exitCode = 1;
});

walryProcess.once("exit", (code, signal) => {
  if (!shuttingDown) mineruProcess?.kill("SIGTERM");
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

mineruProcess?.once("exit", (code) => {
  if (!shuttingDown && code !== 0) {
    console.error(`[web:with-mineru] MinerU 已退出，退出码：${code}`);
    walryProcess.kill("SIGTERM");
  }
});
