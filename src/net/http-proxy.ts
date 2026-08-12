// ---------- TODO:代理配置 start---------- 
import { ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

let installed = false;
let activeProxyUrl: string | undefined;

function resolveProxyUrl(): string | undefined {
  return (
    process.env.PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.all_proxy ||
    undefined
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function shouldBypassProxy(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/**
 * 让 Node 内置 fetch / AI SDK 走本地 HTTP 代理。
 * 读取 PROXY_URL / HTTPS_PROXY / HTTP_PROXY（.env 即可）。
 * 未配置时不改动任何网络行为。
 */
export function installHttpProxy(): string | undefined {
  if (installed) return activeProxyUrl;
  installed = true;

  const proxyUrl = resolveProxyUrl()?.trim();
  if (!proxyUrl) return undefined;

  const agent = new ProxyAgent(proxyUrl);
  activeProxyUrl = proxyUrl;
  setGlobalDispatcher(agent);

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (shouldBypassProxy(url)) {
      return originalFetch(input, init);
    }
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as object),
      dispatcher: agent,
    }) as unknown as ReturnType<typeof fetch>;
  }) as typeof fetch;

  console.log(`  ✓ HTTP 代理已启用: ${proxyUrl}`);
  return proxyUrl;
}

export function getProxiedFetch(): typeof fetch {
  installHttpProxy();
  return globalThis.fetch;
}
// ---------- TODO:代理配置 end---------- 