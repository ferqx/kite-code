import { createHash } from 'node:crypto';
import type {
  SummarySourceIdentityV1,
  VerifiedContextCheckpointV3,
} from '@/core/runtime/context-compaction';
import type { RuntimeState, TranscriptMessage } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';

export const CHECKPOINT_V3_SOURCE_POLICY_ID = 'canonical-transcript-blocks:v1' as const;
export const CHECKPOINT_V3_PROMPT_CONTRACT_ID = 'summary-compact-markdown:v1' as const;

export interface CanonicalTranscriptBlockV1 {
  version: 1;
  blockIndex: number;
  firstMessageId: string;
  lastMessageId: string;
  turnId: string;
  messages: readonly TranscriptMessage[];
  messageCount: number;
  textMessageCount: number;
  estimatedTokens: number;
  canonicalDigest: string;
}

export type CanonicalTranscriptBlocksResultV1 =
  | { status: 'available'; blocks: CanonicalTranscriptBlockV1[] }
  | {
      status: 'unavailable';
      reason: 'missing_message_identity' | 'incomplete_tool_block' | 'mixed_turn_block';
    };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function canonicalContextDigestV3(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\0`).update(canonical(value)).digest('hex');
}

export function checkpointProjectionBaseIdentityV1(
  checkpoint: Pick<VerifiedContextCheckpointV3, 'checkpointId' | 'source'>,
): string {
  return `checkpoint:${checkpoint.checkpointId}:${checkpoint.source.sourceRangeDigest}`;
}

function blockFromMessages(
  blockIndex: number,
  messages: readonly TranscriptMessage[],
): CanonicalTranscriptBlockV1 | undefined {
  const first = messages[0];
  const last = messages.at(-1);
  if (!first?.messageId || !last?.messageId || !first.turnId) return undefined;
  if (messages.some((message) => !message.messageId || message.turnId !== first.turnId)) {
    return undefined;
  }
  const sourceMessages = messages.map((message) => structuredClone(message));
  const identity = sourceMessages.map((message) => {
    const normalized = {
      ...message,
      createdAt: message.createdAt ?? new Date(0).toISOString(),
    } as TranscriptMessage & { ordinal?: number };
    delete normalized.ordinal;
    return normalized;
  });
  const estimatedTokens = Math.max(1, countTokens(canonical(identity)));
  return {
    version: 1,
    blockIndex,
    firstMessageId: first.messageId,
    lastMessageId: last.messageId,
    turnId: first.turnId,
    messages: sourceMessages,
    messageCount: messages.length,
    textMessageCount: messages.filter(
      (message) =>
        (message.kind === 'user' || message.kind === 'assistant') &&
        Boolean(message.content?.trim()),
    ).length,
    estimatedTokens,
    canonicalDigest: canonicalContextDigestV3('canonical-transcript-block:v1', identity),
  };
}

/**
 * Build the sole checkpoint/working-set source. Tool calls and all of their
 * terminal messages are one indivisible block; incomplete or reordered pairs
 * make the source unavailable instead of being repaired heuristically.
 */
export function buildCanonicalTranscriptBlocksV1(
  state: Readonly<RuntimeState>,
): CanonicalTranscriptBlocksResultV1 {
  const blocks: CanonicalTranscriptBlockV1[] = [];
  const messages = state.transcript.messages;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (!message.messageId || !message.turnId) {
      return { status: 'unavailable', reason: 'missing_message_identity' };
    }
    if (message.kind === 'tool') {
      return { status: 'unavailable', reason: 'incomplete_tool_block' };
    }
    if (message.kind === 'assistant' && message.toolCalls.length > 0) {
      const callIds = new Set(message.toolCalls.map((call) => call.id));
      if (callIds.size !== message.toolCalls.length) {
        return { status: 'unavailable', reason: 'incomplete_tool_block' };
      }
      const blockMessages: TranscriptMessage[] = [message];
      for (let offset = 1; offset <= message.toolCalls.length; offset++) {
        const tool = messages[index + offset];
        if (
          tool?.kind !== 'tool' ||
          !callIds.has(tool.toolCallId) ||
          blockMessages.some(
            (candidate) => candidate.kind === 'tool' && candidate.toolCallId === tool.toolCallId,
          )
        ) {
          return { status: 'unavailable', reason: 'incomplete_tool_block' };
        }
        blockMessages.push(tool);
      }
      const block = blockFromMessages(blocks.length, blockMessages);
      if (!block) {
        return {
          status: 'unavailable',
          reason: blockMessages.some((candidate) => candidate.turnId !== message.turnId)
            ? 'mixed_turn_block'
            : 'missing_message_identity',
        };
      }
      blocks.push(block);
      index += message.toolCalls.length;
      continue;
    }
    const block = blockFromMessages(blocks.length, [message]);
    if (!block) return { status: 'unavailable', reason: 'missing_message_identity' };
    blocks.push(block);
  }
  return { status: 'available', blocks };
}

export function canonicalSourceRangeDigestV1(
  blocks: readonly CanonicalTranscriptBlockV1[],
): string {
  return canonicalContextDigestV3(
    'checkpoint-source-range:v1',
    blocks.map((block) => ({
      blockIndex: block.blockIndex,
      firstMessageId: block.firstMessageId,
      lastMessageId: block.lastMessageId,
      turnId: block.turnId,
      canonicalDigest: block.canonicalDigest,
    })),
  );
}

export function summarySourceIdentityV1(
  blocks: readonly CanonicalTranscriptBlockV1[],
): SummarySourceIdentityV1 | undefined {
  const first = blocks[0];
  const last = blocks.at(-1);
  if (!first || !last) return undefined;
  return {
    version: 1,
    firstMessageId: first.firstMessageId,
    coveredThroughMessageId: last.lastMessageId,
    coveredThroughTurnId: last.turnId,
    canonicalSourceDigest: canonicalSourceRangeDigestV1(blocks),
    sourceProjectionPolicyId: CHECKPOINT_V3_SOURCE_POLICY_ID,
  };
}

export function createVerifiedContextCheckpointV3(input: {
  state: Readonly<RuntimeState>;
  checkpointId: string;
  compactionId: string;
  reason: 'manual' | 'auto';
  coveredThroughMessageId: string;
  summary: string;
  inputTokensBefore: number;
  inputTokensAfter: number;
  routeIdentityDigest: string;
  sourceProducingEventCutV1: { revision: number; eventId: string };
  createdAt: string;
  baseCheckpoint?: VerifiedContextCheckpointV3;
}): VerifiedContextCheckpointV3 {
  const built = buildCanonicalTranscriptBlocksV1(input.state);
  if (built.status === 'unavailable')
    throw new Error(`Checkpoint source unavailable: ${built.reason}.`);
  const boundary = built.blocks.findIndex(
    (block) => block.lastMessageId === input.coveredThroughMessageId,
  );
  if (boundary < 0) throw new Error('Checkpoint boundary is not an atomic transcript block.');
  const sourceBlocks = built.blocks.slice(0, boundary + 1);
  const identity = summarySourceIdentityV1(sourceBlocks);
  if (!identity) throw new Error('Checkpoint source must contain at least one complete block.');
  const summary = input.summary.trim();
  if (!summary) throw new Error('Checkpoint summary must be a non-empty Markdown narrative.');
  if (input.inputTokensBefore <= input.inputTokensAfter || input.inputTokensAfter < 0) {
    throw new Error('Checkpoint must prove a positive token reduction.');
  }
  if (
    input.sourceProducingEventCutV1.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(input.sourceProducingEventCutV1.eventId)
  ) {
    throw new Error('Checkpoint source event cut is invalid.');
  }
  return {
    version: 3,
    checkpointId: input.checkpointId,
    compactionId: input.compactionId,
    reason: input.reason,
    source: {
      firstMessageId: identity.firstMessageId,
      coveredThroughMessageId: identity.coveredThroughMessageId,
      coveredThroughTurnId: identity.coveredThroughTurnId,
      sourceRevision: input.sourceProducingEventCutV1.revision,
      sourceProducingEventCutV1: input.sourceProducingEventCutV1,
      sourceRangeDigest: identity.canonicalSourceDigest,
      sourceProjectionPolicyId: identity.sourceProjectionPolicyId,
    },
    summary,
    summaryContentDigest: canonicalContextDigestV3('checkpoint-summary:v3', summary),
    inputTokensBefore: input.inputTokensBefore,
    inputTokensAfter: input.inputTokensAfter,
    promptContractId: CHECKPOINT_V3_PROMPT_CONTRACT_ID,
    routeIdentityDigest: input.routeIdentityDigest,
    ...(input.baseCheckpoint
      ? {
          baseCheckpoint: {
            checkpointId: input.baseCheckpoint.checkpointId,
            summaryContentDigest: input.baseCheckpoint.summaryContentDigest,
          },
        }
      : {}),
    createdAt: input.createdAt,
  };
}
