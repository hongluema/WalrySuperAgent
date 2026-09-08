import type { MineruParsedDocument, KnowledgeChunk } from "./types.js";

type ParsedBlock = {
  text: string;
  page?: number;
  sectionPath: string[];
  blockType: string;
};

const TARGET_CHARS = 1_600;

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  for (const key of ["text", "content", "paragraph_content", "title_content", "code_body", "math_content", "caption"]) {
    const text = textFromValue(object[key]);
    if (text.trim()) return text;
  }
  return "";
}

function pageNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 ? value + 1 : undefined;
}

function flattenContentList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => Array.isArray(item) ? flattenContentList(item) : [item]);
}

function blocksFromContentList(contentList: unknown): ParsedBlock[] {
  const sectionPath: string[] = [];
  const blocks: ParsedBlock[] = [];
  for (const item of flattenContentList(contentList)) {
    if (!item || typeof item !== "object") continue;
    const object = item as Record<string, unknown>;
    const type = typeof object.type === "string" ? object.type : "text";
    const text = textFromValue(object.text ?? object.content ?? object.list_items ?? object.table_body);
    if (!text.trim()) continue;

    const level = typeof object.text_level === "number" ? object.text_level : undefined;
    if (type === "title" || (type === "text" && level !== undefined && level > 0)) {
      const title = text.trim();
      if (level && level <= sectionPath.length) sectionPath.splice(level - 1);
      sectionPath[level ? level - 1 : 0] = title;
      sectionPath.splice((level ?? 1));
    }

    blocks.push({
      text: text.trim(),
      page: pageNumber(object.page_idx),
      sectionPath: sectionPath.filter(Boolean),
      blockType: type,
    });
  }
  return blocks;
}

function blocksFromMarkdown(markdown: string): ParsedBlock[] {
  const sectionPath: string[] = [];
  return markdown
    .split(/\n{2,}/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((text) => {
      const heading = text.match(/^(#{1,6})\s+(.+)$/u);
      if (heading) {
        const level = heading[1].length;
        sectionPath.splice(level - 1);
        sectionPath[level - 1] = heading[2].trim();
        sectionPath.splice(level);
        return { text, sectionPath: [...sectionPath], blockType: "heading" };
      }
      return { text, sectionPath: [...sectionPath], blockType: "paragraph" };
    });
}

export function chunkMineruDocument(parsed: MineruParsedDocument, documentId: string): Array<Omit<KnowledgeChunk, "embedding">> {
  const blocks = blocksFromContentList(parsed.contentList);
  const sourceBlocks = blocks.length > 0 ? blocks : blocksFromMarkdown(parsed.markdown);
  const chunks: Array<Omit<KnowledgeChunk, "embedding">> = [];
  let current: ParsedBlock[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((block) => block.text).join("\n\n").trim();
    const pages = current.map((block) => block.page).filter((page): page is number => page !== undefined);
    const sectionPath = current.at(-1)?.sectionPath ?? [];
    const ordinal = chunks.length;
    chunks.push({
      id: `${documentId}#${ordinal}`,
      documentId,
      content: text,
      pageStart: pages.length ? Math.min(...pages) : undefined,
      pageEnd: pages.length ? Math.max(...pages) : undefined,
      sectionPath,
      blockType: current.length === 1 ? current[0].blockType : "mixed",
      ordinal,
      metadata: { parser: "mineru", blockCount: current.length },
    });
    current = [];
    currentLength = 0;
  };

  for (const block of sourceBlocks) {
    if (current.length > 0 && currentLength + block.text.length > TARGET_CHARS) flush();
    current.push(block);
    currentLength += block.text.length;
    if (["table", "equation", "code"].includes(block.blockType)) flush();
  }
  flush();
  return chunks;
}

