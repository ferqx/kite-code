import { createHash } from 'node:crypto';
import { countTokens } from '@/core/token-counter';
import type { FrameToolResult, ToolCallBlockFrame } from './context-frame';

/**
 * The only result kinds that can be replaced by an offload reference.  This is
 * deliberately narrower than the general read-only capability set: a replay
 * must be deterministic, local, and have a durable locator in the receipt.
 */
export const OVERSIZED_BLOCK_OFFLOADABLE_TOOLS_V1 = Object.freeze([
  'read_file',
  'search_content',
  'search_files',
] as const);

/** Stable policy identity persisted by callers that record an offload decision. */
export const OFFLOAD_POLICY_V1 = Object.freeze({
  version: 1 as const,
  policyId: 'oversized-block-offload:v1' as const,
  eligibleTools: OVERSIZED_BLOCK_OFFLOADABLE_TOOLS_V1,
});

export type OversizedBlockOffloadToolV1 = (typeof OVERSIZED_BLOCK_OFFLOADABLE_TOOLS_V1)[number];

export type OversizedBlockOffloadReasonV1 =
  | 'invalid_pairing'
  | 'unsupported_or_mixed_tool'
  | 'tool_unavailable'
  | 'unsuccessful_result'
  | 'not_read_only'
  | 'legacy_provenance'
  | 'missing_digest'
  | 'digest_mismatch'
  | 'missing_locator'
  | 'no_positive_saving';

export interface OversizedBlockOffloadInputV1 {
  /** The complete atomic tool-call block. It is never partially offloaded. */
  frame: Readonly<ToolCallBlockFrame>;
  /** The tools available in the provider request that will receive this projection. */
  availableToolNames: ReadonlySet<string>;
}

export interface OversizedBlockOffloadSuccessV1 {
  status: 'offloaded';
  frame: ToolCallBlockFrame;
  offloadedToolResultCount: number;
  originalTokens: number;
  projectedTokens: number;
  savedTokens: number;
  originalBytes: number;
  projectedBytes: number;
}

export interface OversizedBlockOffloadRejectedV1 {
  status: 'unavailable';
  reason: OversizedBlockOffloadReasonV1;
}

export type OversizedBlockOffloadResultV1 =
  | OversizedBlockOffloadSuccessV1
  | OversizedBlockOffloadRejectedV1;

const OFFLOADABLE_TOOLS = new Set<string>(OVERSIZED_BLOCK_OFFLOADABLE_TOOLS_V1);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function validOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function hasStableLocator(call: FrameToolResult): boolean {
  const args = asRecord(call.args);
  const meta = call.resultMeta;
  if (!args || !meta || typeof meta.path !== 'string' || meta.path.length === 0) return false;
  if (call.name === 'read_file') {
    return (
      typeof args.path === 'string' &&
      args.path.length > 0 &&
      args.path === meta.path &&
      validOptionalPositiveInteger(args.offset) &&
      validOptionalPositiveInteger(args.limit)
    );
  }
  if (typeof args.pattern !== 'string' || args.pattern.length === 0) return false;
  if (
    (call.name === 'search_content' || call.name === 'search_files') &&
    args.path !== undefined &&
    args.path !== meta.path
  ) {
    return false;
  }
  if (call.name === 'search_content' && args.glob !== undefined && typeof args.glob !== 'string') {
    return false;
  }
  return true;
}

function hasCanonicalPairing(frame: Readonly<ToolCallBlockFrame>): boolean {
  const toolCalls = (frame.assistantMessage as unknown as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length !== frame.calls.length) return false;
  return frame.calls.every((call, index) => {
    const candidate = asRecord(toolCalls[index]);
    return (
      candidate?.id === call.toolCallId &&
      candidate.name === call.name &&
      canonical(candidate.args ?? {}) === canonical(call.args ?? {})
    );
  });
}

function rejectionReason(
  frame: Readonly<ToolCallBlockFrame>,
  availableToolNames: ReadonlySet<string>,
): OversizedBlockOffloadReasonV1 | undefined {
  if (!hasCanonicalPairing(frame)) return 'invalid_pairing';
  if (frame.calls.length === 0 || frame.calls.some((call) => !OFFLOADABLE_TOOLS.has(call.name))) {
    return 'unsupported_or_mixed_tool';
  }
  if (frame.calls.some((call) => !availableToolNames.has(call.name))) return 'tool_unavailable';
  if (frame.calls.some((call) => !call.ok)) return 'unsuccessful_result';
  if (frame.calls.some((call) => call.effectClass !== 'read_only')) return 'not_read_only';
  if (
    frame.calls.some((call) => {
      const meta = call.resultMeta;
      return (
        (meta?.digestScope !== 'raw' && meta?.digestScope !== 'projected') ||
        meta.terminalMigration !== undefined ||
        meta.toolResultReceipt?.version !== 2 ||
        meta.toolResultReceipt.projectionMode !== 'budget_v2'
      );
    })
  ) {
    return 'legacy_provenance';
  }
  if (
    frame.calls.some((call) => {
      const meta = call.resultMeta;
      return (
        !DIGEST_PATTERN.test(meta?.rawResultDigest ?? '') ||
        !DIGEST_PATTERN.test(meta?.modelContentDigest ?? '') ||
        !DIGEST_PATTERN.test(meta?.toolResultReceipt?.rawResultDigest ?? '') ||
        !DIGEST_PATTERN.test(meta?.toolResultReceipt?.modelContentDigest ?? '')
      );
    })
  ) {
    return 'missing_digest';
  }
  if (
    frame.calls.some((call) => {
      const meta = call.resultMeta!;
      const receipt = meta.toolResultReceipt!;
      return (
        meta.rawResultDigest !== receipt.rawResultDigest ||
        meta.modelContentDigest !== receipt.modelContentDigest ||
        createHash('sha256').update(call.content).digest('hex') !== meta.modelContentDigest
      );
    })
  ) {
    return 'digest_mismatch';
  }
  if (frame.calls.some((call) => !hasStableLocator(call))) return 'missing_locator';
  return undefined;
}

export function oversizedBlockOffloadStubV1(input: {
  toolCallId: string;
  tool: OversizedBlockOffloadToolV1;
  originalTokens: number;
  originalBytes: number;
  rawResultDigest: string;
  modelContentDigest: string;
}): string {
  return JSON.stringify({
    version: 1,
    ref: `tool-result-offload:v1:${input.toolCallId}:${input.rawResultDigest}:${input.modelContentDigest}`,
    tool: input.tool,
    originalTokens: input.originalTokens,
    originalBytes: input.originalBytes,
    digest: {
      raw: input.rawResultDigest,
      projected: input.modelContentDigest,
    },
    replay: 'replay_tool_call_with_original_arguments',
  });
}

/**
 * Safely replaces every result in one oversized *atomic* read-only block.
 * A rejection returns the original frame untouched; callers must never offload
 * individual calls from a rejected block.
 */
export function tryProjectOversizedToolBlockV1(
  input: OversizedBlockOffloadInputV1,
): OversizedBlockOffloadResultV1 {
  const reason = rejectionReason(input.frame, input.availableToolNames);
  if (reason) return { status: 'unavailable', reason };

  const originals = input.frame.calls.map((call) => ({
    originalTokens: countTokens(call.content),
    originalBytes: Buffer.byteLength(call.content, 'utf8'),
  }));
  const calls = input.frame.calls.map((call, index) => {
    const meta = call.resultMeta!;
    return {
      ...call,
      content: oversizedBlockOffloadStubV1({
        toolCallId: call.toolCallId,
        tool: call.name as OversizedBlockOffloadToolV1,
        originalTokens: originals[index]!.originalTokens,
        originalBytes: originals[index]!.originalBytes,
        rawResultDigest: meta.rawResultDigest!,
        modelContentDigest: meta.modelContentDigest!,
      }),
    };
  });
  const originalTokens = originals.reduce((total, entry) => total + entry.originalTokens, 0);
  const originalBytes = originals.reduce((total, entry) => total + entry.originalBytes, 0);
  const projectedTokens = calls.reduce((total, call) => total + countTokens(call.content), 0);
  const projectedBytes = calls.reduce(
    (total, call) => total + Buffer.byteLength(call.content, 'utf8'),
    0,
  );
  if (projectedTokens >= originalTokens || projectedBytes >= originalBytes) {
    return { status: 'unavailable', reason: 'no_positive_saving' };
  }
  return {
    status: 'offloaded',
    frame: { ...input.frame, calls },
    offloadedToolResultCount: calls.length,
    originalTokens,
    projectedTokens,
    savedTokens: originalTokens - projectedTokens,
    originalBytes,
    projectedBytes,
  };
}

/** @deprecated Use tryProjectOversizedToolBlockV1. */
export const offloadOversizedToolCallBlockV1 = tryProjectOversizedToolBlockV1;
