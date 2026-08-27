import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function loadAgentMd(): string {
  if (cached !== undefined) return cached;
  const candidates = [
    join(process.cwd(), "agent.md"),
    join(dirname(fileURLToPath(import.meta.url)), "../agent.md"),
  ];
  for (const file of candidates) {
    try {
      cached = readFileSync(file, "utf8").trim();
      return cached;
    } catch {
      // try next path
    }
  }
  cached = "";
  return cached;
}

export function withAgentRules(system: string): string {
  const rules = loadAgentMd();
  return rules ? `${rules}\n\n${system}` : system;
}
