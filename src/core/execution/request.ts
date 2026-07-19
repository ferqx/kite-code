import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { stableStringify } from '@/core/harness/tool-policy';

export type ToolExecutionSource = 'main_agent' | 'code_subagent';

export interface ToolExecutionRequest {
  toolCallId: string;
  toolName: string;
  rawArgs: Record<string, unknown>;
  normalizedArgs: Readonly<Record<string, unknown>>;
  argsHash: string;
  source: ToolExecutionSource;
  signal: AbortSignal;
}

export function normalizeToolArgs(
  schema: z.ZodTypeAny,
  rawArgs: Record<string, unknown>,
): { normalized: Readonly<Record<string, unknown>>; hash: string } {
  const parsed = schema.parse(rawArgs) as Record<string, unknown>;
  const normalized = stripUndefined(parsed);
  const canonical = stableStringify(normalized);
  return {
    normalized: Object.freeze(normalized),
    hash: createHash('sha256').update(canonical).digest('hex'),
  };
}

export function createToolExecutionRequest(input: {
  toolCallId: string;
  toolName: string;
  rawArgs: Record<string, unknown>;
  schema: z.ZodTypeAny;
  source: ToolExecutionSource;
  signal: AbortSignal;
}): ToolExecutionRequest {
  const { normalized, hash } = normalizeToolArgs(input.schema, input.rawArgs);
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    rawArgs: input.rawArgs,
    normalizedArgs: normalized,
    argsHash: hash,
    source: input.source,
    signal: input.signal,
  };
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
