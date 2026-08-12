import { aiMessage, humanMessage, systemMessage, toolMessage } from '@/core/messages';
import type { VerifiedContextCheckpointV3 } from '@/core/runtime/context-compaction';
import type { RuntimeState, TranscriptMessage } from '@/core/runtime/state';
import {
  buildCanonicalTranscriptBlocksV1,
  CHECKPOINT_V3_PROMPT_CONTRACT_ID,
  CHECKPOINT_V3_SOURCE_POLICY_ID,
  canonicalContextDigestV3,
  canonicalSourceRangeDigestV1,
  checkpointProjectionBaseIdentityV1,
} from './context-checkpoint-v3';
import type { ContextFrame } from './context-frame';
import { isToolCallBlockFrame } from './context-frame';
import { buildCanonicalFrames } from './context-frame-builder';
import { OFFLOAD_POLICY_V1, tryProjectOversizedToolBlockV1 } from './oversized-block-offload';

export const CHECKPOINT_WORKING_SET_POLICY_V1 = Object.freeze({
  policyId: 'checkpoint-working-set:v1',
  minRecentTokens: 2_048,
  minTextMessages: 4,
  maxRecentTokens: 8_192,
  maxKnownWindowRatio: 0.25,
});

export type CheckpointWorkingSetUnavailableReasonV1 =
  | 'missing_v3_checkpoint'
  | 'canonical_source_unavailable'
  | 'checkpoint_boundary_missing'
  | 'checkpoint_not_prefix'
  | 'checkpoint_proof_incomplete'
  | 'checkpoint_tampered'
  | 'checkpoint_future_cut'
  | 'checkpoint_event_cut_unavailable'
  | 'unsafe_runtime_barrier'
  | 'recent_window_exceeds_capacity';

export type CheckpointWorkingSetV1 =
  | {
      status: 'available';
      policyId: typeof CHECKPOINT_WORKING_SET_POLICY_V1.policyId;
      checkpoint: VerifiedContextCheckpointV3;
      checkpointBlockBoundary: number;
      recentBlockStart: number;
      totalBlockCount: number;
      recentTokens: number;
      frames: ContextFrame[];
      /** Ephemeral L2.5 replacements; raw transcript and V3 proof remain unchanged. */
      oversizedBlockOffload?: {
        policyId: typeof OFFLOAD_POLICY_V1.policyId;
        offloadedBlockCount: number;
        offloadedToolResultCount: number;
        savedTokens: number;
      };
      projectionDigest: string;
    }
  | { status: 'unavailable'; reason: CheckpointWorkingSetUnavailableReasonV1 };

/** Pure bounded branch proof used by Kernel to publish a child-owned rebound event. */
export function deriveCheckpointV3ReboundV1(input: {
  state: Readonly<RuntimeState>;
  generation: number;
}):
  | {
      type: 'context.checkpoint_v3_rebound_v1';
      parentCheckpointId: string;
      checkpoint: VerifiedContextCheckpointV3;
      proof: Extract<
        import('@/core/runtime/events').RuntimeEvent,
        { type: 'context.checkpoint_v3_rebound_v1' }
      >['proof'];
    }
  | undefined {
  const checkpoint = input.state.context.activeCheckpoint;
  if (
    checkpoint?.version !== 3 ||
    input.state.context.projectionBaseIdentity != null ||
    (input.state.storageFormat.ledgerBase.kind !== 'fork_rebound_v24' &&
      input.state.storageFormat.ledgerBase.kind !== 'verified_named_v24') ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  )
    return undefined;
  const built = buildCanonicalTranscriptBlocksV1(input.state);
  if (built.status === 'unavailable') return undefined;
  const boundary = built.blocks.findIndex(
    (block) => block.lastMessageId === checkpoint.source.coveredThroughMessageId,
  );
  if (
    boundary < 0 ||
    built.blocks[0]?.firstMessageId !== checkpoint.source.firstMessageId ||
    canonicalSourceRangeDigestV1(built.blocks.slice(0, boundary + 1)) !==
      checkpoint.source.sourceRangeDigest ||
    canonicalContextDigestV3('checkpoint-summary:v3', checkpoint.summary) !==
      checkpoint.summaryContentDigest ||
    checkpoint.source.sourceProducingEventCutV1.revision > input.state.revision
  )
    return undefined;
  const ledgerBaseId = input.state.storageFormat.ledgerBase.baseId;
  const forkLocalSourceProducingEventCutV1 = {
    revision: Math.max(1, input.state.storageFormat.ledgerBase.baseRevision),
    eventId: canonicalContextDigestV3('checkpoint-v3-fork-local-source-cut:v1', {
      threadId: input.state.session.threadId,
      generation: input.generation,
      ledgerBaseId,
      parentSourceProducingEventCutV1: checkpoint.source.sourceProducingEventCutV1,
      sourceRangeDigest: checkpoint.source.sourceRangeDigest,
    }),
  };
  if (forkLocalSourceProducingEventCutV1.revision > input.state.revision) return undefined;
  const checkpointId = canonicalContextDigestV3('checkpoint-v3-rebound-id:v1', {
    parentCheckpointId: checkpoint.checkpointId,
    threadId: input.state.session.threadId,
    generation: input.generation,
    sourceRangeDigest: checkpoint.source.sourceRangeDigest,
    sourceProducingEventCutV1: forkLocalSourceProducingEventCutV1,
  });
  const reboundCheckpoint = {
    ...checkpoint,
    checkpointId,
    source: {
      ...checkpoint.source,
      sourceRevision: forkLocalSourceProducingEventCutV1.revision,
      sourceProducingEventCutV1: forkLocalSourceProducingEventCutV1,
    },
  };
  const proofBody = {
    version: 1 as const,
    generation: input.generation,
    ledgerBaseId,
    parentSourceProducingEventCutV1: checkpoint.source.sourceProducingEventCutV1,
    forkLocalSourceProducingEventCutV1,
    sourceRangeDigest: checkpoint.source.sourceRangeDigest,
  };
  return {
    type: 'context.checkpoint_v3_rebound_v1',
    parentCheckpointId: checkpoint.checkpointId,
    checkpoint: reboundCheckpoint,
    proof: {
      ...proofBody,
      checksum: canonicalContextDigestV3('checkpoint-v3-rebound-proof:v1', proofBody),
    },
  };
}

export function validateCheckpointV3ReboundProofV1(
  event: Extract<
    import('@/core/runtime/events').RuntimeEvent,
    { type: 'context.checkpoint_v3_rebound_v1' }
  >,
): boolean {
  const { checksum, ...body } = event.proof;
  return (
    checksum === canonicalContextDigestV3('checkpoint-v3-rebound-proof:v1', body) &&
    event.checkpoint.source.sourceProducingEventCutV1.eventId ===
      event.proof.forkLocalSourceProducingEventCutV1.eventId &&
    event.checkpoint.source.sourceProducingEventCutV1.revision ===
      event.proof.forkLocalSourceProducingEventCutV1.revision &&
    event.checkpoint.source.sourceRangeDigest === event.proof.sourceRangeDigest
  );
}

function transcriptMessageToModel(
  state: Readonly<RuntimeState>,
  message: TranscriptMessage,
  includeOffloadMetadata = false,
) {
  const identity = { messageId: message.messageId, turnId: message.turnId };
  switch (message.kind) {
    case 'user':
      return Object.assign(
        humanMessage({ id: message.messageId, content: message.content }),
        identity,
      );
    case 'runtime':
      return Object.assign(systemMessage(message.content), identity);
    case 'assistant':
      return Object.assign(
        aiMessage({
          id: message.messageId,
          content: message.content ?? '',
          tool_calls: message.toolCalls.map((call) => ({
            ...call,
            args:
              call.args && typeof call.args === 'object' && !Array.isArray(call.args)
                ? (call.args as Record<string, unknown>)
                : {},
            type: 'tool_call' as const,
          })),
        }),
        identity,
      );
    case 'tool': {
      if (!includeOffloadMetadata) {
        return Object.assign(
          toolMessage({
            id: message.messageId,
            tool_call_id: message.toolCallId,
            name: message.name,
            content: message.content,
            status: message.ok ? 'success' : 'error',
          }),
          identity,
        );
      }
      const call = state.tools.calls[message.toolCallId];
      return Object.assign(
        toolMessage({
          id: message.messageId,
          tool_call_id: message.toolCallId,
          name: message.name,
          content: message.content,
          status: message.ok ? 'success' : 'error',
        }),
        identity,
        structuredClone(message.resultMeta ?? {}),
        {
          args: call?.args === undefined ? undefined : structuredClone(call.args),
          effectClass: call?.effectClass,
        },
      );
    }
  }
}

function framesForTranscriptBlock(
  state: Readonly<RuntimeState>,
  messages: readonly TranscriptMessage[],
  includeOffloadMetadata = false,
): ContextFrame[] {
  return buildCanonicalFrames(
    messages.map((message) => transcriptMessageToModel(state, message, includeOffloadMetadata)),
  );
}

function unsafeBarrier(state: Readonly<RuntimeState>, boundary: number): boolean {
  const coveredIds = new Set(
    state.transcript.messages.slice(0, boundary).map((message) => message.messageId),
  );
  if (state.interactions.kind !== 'idle') return true;
  if (
    state.turn.status === 'active' &&
    state.transcript.messages
      .slice(0, boundary)
      .some((message) => message.turnId === state.turn.turnId)
  )
    return true;
  if (
    Object.values(state.verification.records).some(
      (record) =>
        !['passed', 'failed', 'inconclusive', 'waived', 'compensated', 'budget_exhausted'].includes(
          record.status,
        ),
    )
  )
    return true;
  return Object.values(state.tools.calls).some((call) => {
    if (!coveredIds.has(call.modelMessageId)) return false;
    return !['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status);
  });
}

/** Pure `[0,c) + [w,c) + [c,n)` selector. It never dispatches or persists. */
export function selectCheckpointWorkingSetV1(input: {
  state: Readonly<RuntimeState>;
  checkpoint?: VerifiedContextCheckpointV3 | { version: number };
  contextWindowTokens?: number;
  expectedRouteIdentityDigest?: string;
  /** Default-off L2.5: only eligible complete blocks inside the covered W overlap. */
  oversizedBlockOffloadV1?: boolean;
  availableToolNames?: readonly string[];
}): CheckpointWorkingSetV1 {
  const checkpoint = input.checkpoint;
  if (checkpoint?.version !== 3) {
    return { status: 'unavailable', reason: 'missing_v3_checkpoint' };
  }
  const v3 = checkpoint as VerifiedContextCheckpointV3;
  if (
    v3.promptContractId !== CHECKPOINT_V3_PROMPT_CONTRACT_ID ||
    v3.source.sourceProjectionPolicyId !== CHECKPOINT_V3_SOURCE_POLICY_ID ||
    !v3.source.sourceProducingEventCutV1.eventId ||
    !v3.routeIdentityDigest ||
    (input.expectedRouteIdentityDigest != null &&
      v3.routeIdentityDigest !== input.expectedRouteIdentityDigest)
  )
    return { status: 'unavailable', reason: 'checkpoint_proof_incomplete' };
  if (v3.source.sourceProducingEventCutV1.revision > input.state.revision) {
    return { status: 'unavailable', reason: 'checkpoint_future_cut' };
  }
  if (
    input.state.lastAppliedEventId !== v3.source.sourceProducingEventCutV1.eventId &&
    !input.state.appliedEventIds.includes(v3.source.sourceProducingEventCutV1.eventId) &&
    input.state.context.projectionBaseIdentity !== checkpointProjectionBaseIdentityV1(v3)
  )
    return { status: 'unavailable', reason: 'checkpoint_event_cut_unavailable' };

  const built = buildCanonicalTranscriptBlocksV1(input.state);
  if (built.status === 'unavailable') {
    return { status: 'unavailable', reason: 'canonical_source_unavailable' };
  }
  const cIndex = built.blocks.findIndex(
    (block) => block.lastMessageId === v3.source.coveredThroughMessageId,
  );
  if (cIndex < 0) return { status: 'unavailable', reason: 'checkpoint_boundary_missing' };
  const c = cIndex + 1;
  const prefix = built.blocks.slice(0, c);
  const prefixFirst = prefix[0];
  if (!prefixFirst || prefixFirst.firstMessageId !== v3.source.firstMessageId) {
    return { status: 'unavailable', reason: 'checkpoint_not_prefix' };
  }
  const sourceDigest = canonicalSourceRangeDigestV1(prefix);
  if (
    sourceDigest !== v3.source.sourceRangeDigest ||
    v3.summaryContentDigest !== canonicalContextDigestV3('checkpoint-summary:v3', v3.summary) ||
    prefix.at(-1)?.turnId !== v3.source.coveredThroughTurnId
  )
    return { status: 'unavailable', reason: 'checkpoint_tampered' };
  const coveredMessageCount = prefix.reduce((sum, block) => sum + block.messageCount, 0);
  if (unsafeBarrier(input.state, coveredMessageCount)) {
    return { status: 'unavailable', reason: 'unsafe_runtime_barrier' };
  }

  let w = c;
  let recentTokens = 0;
  let textMessages = 0;
  const selectedRecent: ContextFrame[][] = [];
  let offloadedBlockCount = 0;
  let offloadedToolResultCount = 0;
  let offloadedSavedTokens = 0;
  const availableToolNames = new Set(input.availableToolNames ?? []);
  const knownWindowCap = input.contextWindowTokens
    ? Math.floor(input.contextWindowTokens * CHECKPOINT_WORKING_SET_POLICY_V1.maxKnownWindowRatio)
    : Number.POSITIVE_INFINITY;
  const capacity = Math.min(CHECKPOINT_WORKING_SET_POLICY_V1.maxRecentTokens, knownWindowCap);
  while (w > 0) {
    const block = built.blocks[w - 1]!;
    if (
      recentTokens >= CHECKPOINT_WORKING_SET_POLICY_V1.minRecentTokens &&
      textMessages >= CHECKPOINT_WORKING_SET_POLICY_V1.minTextMessages
    )
      break;
    let estimatedTokens = block.estimatedTokens;
    let frames = framesForTranscriptBlock(input.state, block.messages);
    if (recentTokens + estimatedTokens > capacity && input.oversizedBlockOffloadV1 === true) {
      const offloadFrames = framesForTranscriptBlock(input.state, block.messages, true);
      if (offloadFrames.length === 1 && isToolCallBlockFrame(offloadFrames[0]!)) {
        const offloaded = tryProjectOversizedToolBlockV1({
          frame: offloadFrames[0],
          availableToolNames,
        });
        if (offloaded.status === 'offloaded') {
          frames = [offloaded.frame];
          // `estimatedTokens` uses the same canonical token estimator as the
          // original block. Replacing only tool-result content can only reduce
          // it by the helper's positive content-token delta.
          estimatedTokens = Math.max(1, block.estimatedTokens - offloaded.savedTokens);
          offloadedBlockCount++;
          offloadedToolResultCount += offloaded.offloadedToolResultCount;
          offloadedSavedTokens += offloaded.savedTokens;
        }
      }
    }
    if (recentTokens + estimatedTokens > capacity) {
      return { status: 'unavailable', reason: 'recent_window_exceeds_capacity' };
    }
    w--;
    recentTokens += estimatedTokens;
    textMessages += block.textMessageCount;
    selectedRecent.unshift(frames);
  }
  const frames = selectedRecent
    .flat()
    .concat(
      built.blocks
        .slice(c)
        .flatMap((block) => framesForTranscriptBlock(input.state, block.messages)),
    );
  return {
    status: 'available',
    policyId: CHECKPOINT_WORKING_SET_POLICY_V1.policyId,
    checkpoint: v3,
    checkpointBlockBoundary: c,
    recentBlockStart: w,
    totalBlockCount: built.blocks.length,
    recentTokens,
    frames,
    ...(offloadedBlockCount > 0
      ? {
          oversizedBlockOffload: {
            policyId: OFFLOAD_POLICY_V1.policyId,
            offloadedBlockCount,
            offloadedToolResultCount,
            savedTokens: offloadedSavedTokens,
          },
        }
      : {}),
    projectionDigest: canonicalContextDigestV3('checkpoint-working-set:v1', {
      checkpointId: v3.checkpointId,
      checkpointBlockBoundary: c,
      recentBlockStart: w,
      totalBlockCount: built.blocks.length,
      blockDigests: built.blocks.slice(w).map((block) => block.canonicalDigest),
      ...(offloadedBlockCount > 0
        ? {
            oversizedBlockOffload: {
              policyId: OFFLOAD_POLICY_V1.policyId,
              offloadedBlockCount,
              offloadedToolResultCount,
              savedTokens: offloadedSavedTokens,
            },
          }
        : {}),
    }),
  };
}
