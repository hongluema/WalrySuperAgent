import { basename, extname } from "node:path";
import type { MineruClient, MineruParsedDocument } from "./types.js";

type MineruResponse = {
  version?: string;
  results?: Record<string, {
    md_content?: string | null;
    content_list?: string | unknown[] | null;
    images?: Record<string, string>;
  }>;
};

function positiveTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : fallback;
}

function formBoolean(value: boolean): string {
  return value ? "true" : "false";
}

function parseContentList(value: string | unknown[] | null | undefined): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function resultKey(fileName: string): string {
  return basename(fileName, extname(fileName));
}

export class HttpMineruClient implements MineruClient {
  constructor(
    private readonly baseUrl = process.env.MINERU_BASE_URL ?? "http://127.0.0.1:8000",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = positiveTimeout(process.env.MINERU_TIMEOUT_MS, 600_000),
    private readonly backend = process.env.MINERU_BACKEND ?? "pipeline",
  ) {}

  async parse(input: { file: Uint8Array; fileName: string; mimeType: string; signal?: AbortSignal }): Promise<MineruParsedDocument> {
    const form = new FormData();
    form.append("files", new Blob([input.file], { type: input.mimeType || "application/octet-stream" }), input.fileName);
    form.append("return_md", formBoolean(true));
    form.append("return_content_list", formBoolean(true));
    form.append("return_images", formBoolean(true));
    form.append("return_original_file", formBoolean(false));
    form.append("backend", this.backend);
    form.append("parse_method", process.env.MINERU_PARSE_METHOD ?? "auto");

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/u, "")}/file_parse`, {
      method: "POST",
      body: form,
      signal,
    });
    if (!response.ok) {
      throw new Error(`MinerU 解析失败: HTTP ${response.status} ${await response.text()}`);
    }

    const payload = await response.json() as MineruResponse;
    const results = payload.results ?? {};
    const result = results[resultKey(input.fileName)] ?? Object.values(results)[0];
    if (!result) throw new Error("MinerU 返回中没有文档结果");

    const markdown = result.md_content?.trim() ?? "";
    const contentList = parseContentList(result.content_list);
    if (!markdown && (!Array.isArray(contentList) || contentList.length === 0)) {
      throw new Error("MinerU 返回了空文档");
    }

    return {
      markdown,
      contentList,
      images: result.images ?? {},
      parserVersion: payload.version,
    };
  }
}
