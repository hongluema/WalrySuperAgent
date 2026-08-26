import type { MemoryStore } from '../memory/store.js';
import type { VectorStore } from '../rag/store.js';
import type { SkillLoader } from '../skills/loader.js';
import type { PromptContext } from './prompt-builder.js';

export function memoryContext(memoryStore: MemoryStore): (ctx: PromptContext) => string | null {
  return () => memoryStore.buildPromptSection();
}

export function ragContext(vectorStore: VectorStore): (ctx: PromptContext) => string | null {
  return () => {
    const size = vectorStore.size();
    if (size === 0) return null;
    const sources = vectorStore.sources();
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`;
  };
}

export function tutorPedagogy(skillLoader: SkillLoader): (ctx: PromptContext) => string | null {
  return () => skillLoader.buildAlwaysOnPromptSection();
}
