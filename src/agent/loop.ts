import { streamText, type ModelMessage } from 'ai';
import { ToolRegistry } from '../tools/registry.js';
import { detect, recordCall, recordResult, resetHistory } from './loop-detection.js';
import { isRetryable, calculateDelay, sleep } from './retry.js';
import { type UsageTracker, normalizeUsage } from '../usage/tracker.js';

const MAX_STEPS = 30;
const MAX_RETRIES = 3;
const TOKEN_BUDGET = 200000;

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  tracker?: UsageTracker,
  tag?: string,
  maxSteps?: number,
  signal?: AbortSignal,
) {
  let step = 0;
  let totalTokens = 0;
  resetHistory();
  const prefix = tag ? `  ${tag} ` : '';
  const stepLimit = maxSteps ?? MAX_STEPS;

  while (step < stepLimit) {
    if (signal?.aborted) {
      if (tag) console.log(`${prefix}已取消`);
      break;
    }
    step++;
    if (tag) {
      console.log(`${prefix}Step ${step}/${stepLimit}`);
    } else {
      console.log(`\n--- Step ${step} ---`);
    }

    let hasToolCall = false;
    let fullText = '';
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: any;
    let stepUsage: any;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0,
          abortSignal: signal,
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => {},
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              if (!tag) process.stdout.write(part.text);
              fullText += part.text;
              break;

            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              if (tag) {
                console.log(`${prefix}调用 ${part.toolName}`);
              } else {
                console.log(`  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);
              }

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === 'critical') {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);
              break;
            }

            case 'tool-result': {
              const output = typeof part.output === 'string' ? part.output : JSON.stringify(part.output);
              const isSubAgent = part.toolName === 'spawn_agent';
              const preview = isSubAgent ? output : (output.length > 120 ? output.slice(0, 120) + '...' : output);
              if (!tag) console.log(`  [结果: ${part.toolName}] ${preview}`);
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output);
              }
              break;
            }
          }
        }

        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(`  [重试] 第 ${attempt}/${MAX_RETRIES} 次，${delay}ms 后...`);
        await sleep(delay);
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    if (shouldBreak) {
      if (!tag) console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    messages.push(...stepResponse!.messages);

    const norm = normalizeUsage(stepUsage);
    const stepRecord = tracker?.record(model?.modelId || 'mock-model', norm);
    totalTokens += norm.inputTokens + norm.outputTokens + norm.cacheReadTokens + norm.cacheWriteTokens;

    if (!tag && stepRecord && (norm.cacheReadTokens > 0 || norm.cacheWriteTokens > 0)) {
      const cacheTag = norm.cacheReadTokens > 0 ? `\x1b[38;5;36m✓ cache hit\x1b[0m` : `\x1b[38;5;220m✎ cache write\x1b[0m`;
      const detail = norm.cacheReadTokens > 0 ? `read ${norm.cacheReadTokens}` : `write ${norm.cacheWriteTokens}`;
      console.log(`  [${cacheTag}] ${detail} tokens · 本步 $${stepRecord.cost.toFixed(5)}`);
    }

    if (!tag && totalTokens > TOKEN_BUDGET * 0.9) {
      console.log(`  [Token] ${totalTokens}/${TOKEN_BUDGET} (${Math.round(totalTokens / TOKEN_BUDGET * 100)}%)`);
    }
    if (totalTokens > TOKEN_BUDGET) {
      if (!tag) console.log('\n[Token 预算耗尽]');
      break;
    }

    if (!hasToolCall) {
      if (!tag && fullText) console.log();
      break;
    }

    if (!tag) console.log('  → 继续下一步...');
  }

  if (step >= stepLimit) {
    if (tag) {
      console.log(`${prefix}达到步数上限 (${stepLimit})`);
    } else {
      console.log('\n[达到最大步数]');
    }
  }
}