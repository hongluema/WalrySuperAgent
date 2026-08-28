import TurndownService from "turndown";

const WEIXIN_URL = /https?:\/\/mp\.weixin\.qq\.com\/s[^\s)\]>'"]*/gi;
const ARTICLE_MAX_CHARS = 12_000;
const MIN_ARTICLE_CHARS = 80;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndown.remove(["script", "style", "nav", "footer", "header", "iframe"]);

export type SourceArticle = {
  title: string;
  url: string;
  markdown: string;
};

export function extractWeixinUrls(text: string): string[] {
  const matches = text.match(WEIXIN_URL) ?? [];
  return [...new Set(matches.map((item) => item.replace(/[.,;!?。，；！？]+$/u, "")))];
}

export function stripWeixinUrls(text: string): string {
  return text
    .replace(/微信公众号文章[：:]\s*/g, "")
    .replace(WEIXIN_URL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isBlockedWeixinPage(text: string): boolean {
  return /环境异常|完成验证|请输入验证码|captcha/i.test(text);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function innerHtmlById(html: string, id: string): string {
  const open = html.search(new RegExp(`<div[^>]*id=["']${id}["'][^>]*>`, "i"));
  if (open < 0) return "";
  const start = html.indexOf(">", open) + 1;
  let depth = 1;
  let index = start;
  while (index < html.length && depth > 0) {
    const nextOpen = html.indexOf("<div", index);
    const nextClose = html.indexOf("</div>", index);
    if (nextClose < 0) return html.slice(start);
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      index = nextOpen + 4;
      continue;
    }
    depth -= 1;
    if (depth === 0) return html.slice(start, nextClose);
    index = nextClose + 6;
  }
  return html.slice(start);
}

export function parseWeixinHtml(html: string): { title: string; markdown: string } {
  const title = decodeEntities(
    (
      html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1]
      ?? html.match(/id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "")
      ?? ""
    ).trim(),
  );
  const bodyHtml = innerHtmlById(html, "js_content").replace(/\sdata-src=/g, " src=");
  const markdown = bodyHtml ? turndown.turndown(bodyHtml).trim() : "";
  return { title, markdown };
}

function usableMarkdown(markdown: string): boolean {
  return markdown.length >= MIN_ARTICLE_CHARS && !isBlockedWeixinPage(markdown);
}

async function readUrl(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.28",
      Accept: "text/html,application/xhtml+xml,text/plain",
      Referer: "https://mp.weixin.qq.com/",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`抓取失败: HTTP ${response.status}`);
  return response.text();
}

function clipMarkdown(markdown: string): string {
  if (markdown.length <= ARTICLE_MAX_CHARS) return markdown;
  return `${markdown.slice(0, ARTICLE_MAX_CHARS)}\n\n…（正文已截断）`;
}

async function extractWithTavily(url: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return "";
  const response = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, urls: [url] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) return "";
  const data = await response.json() as { results?: Array<{ raw_content?: string }> };
  return data.results?.[0]?.raw_content?.trim() ?? "";
}

export async function fetchWeixinArticle(url: string): Promise<SourceArticle> {
  let title = "微信公众号文章";
  let markdown = "";

  try {
    const html = await readUrl(url);
    if (!isBlockedWeixinPage(html)) {
      const parsed = parseWeixinHtml(html);
      title = parsed.title || title;
      markdown = parsed.markdown;
    }
  } catch (error) {
    console.error("[Tutor] 微信直连抓取失败", error instanceof Error ? error.message : error);
  }

  if (!usableMarkdown(markdown)) {
    try {
      const extracted = await extractWithTavily(url);
      if (usableMarkdown(extracted)) markdown = extracted;
    } catch (error) {
      console.error("[Tutor] Tavily 抽取公众号失败", error instanceof Error ? error.message : error);
    }
  }

  if (!usableMarkdown(markdown)) {
    try {
      const fallback = (await readUrl(`https://r.jina.ai/${url}`)).trim();
      if (usableMarkdown(fallback)) markdown = fallback;
    } catch (error) {
      console.error("[Tutor] Jina 读取公众号失败", error instanceof Error ? error.message : error);
    }
  }

  if (!usableMarkdown(markdown)) throw new Error("未能读取这篇微信公众号文章的正文");
  console.error(`[Tutor] 已抓取微信公众号《${title}》，${markdown.length} 字`);
  return { title, url, markdown: clipMarkdown(markdown) };
}
