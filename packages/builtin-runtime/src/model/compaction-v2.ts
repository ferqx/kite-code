import { createHash } from 'node:crypto';
import type { BuiltinRuntimeStateViewV1, BuiltinTranscriptMessageV1 } from './runtime-view';

const TERMINAL_TOOL_STATUSES = new Set([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);

export interface SafeCompactionBoundary {
  eligible: boolean;
  reason?: string;
  firstMessageId?: string;
  lastMessageId?: string;
  coveredThroughTurnId?: string;
  protectedMessageIds: string[];
  coveredMessages: BuiltinTranscriptMessageV1[];
}

function stableMessageId(message: BuiltinTranscriptMessageV1): string | undefined {
  return message.messageId;
}

/** Select complete settled turns, optionally protecting the latest active turn. */
export function findSafeCompactionBoundary(
  state: Readonly<BuiltinRuntimeStateViewV1>,
  options: { protectLatestTurn?: boolean } = {},
): SafeCompactionBoundary {
  if (state.interactions.kind !== 'idle') {
    return {
      eligible: false,
      reason: 'An external interaction is pending.',
      protectedMessageIds: state.transcript.messages.flatMap((message) =>
        stableMessageId(message) ? [stableMessageId(message)!] : [],
      ),
      coveredMessages: [],
    };
  }
  const messages = state.transcript.messages;
  // Messages without a turnId cannot be reliably assigned to a turn.
  // Use a sentinel so they are always protected (never compacted).
  const SENTINEL_NO_TURN = '__NO_TURN__';
  const turnIds = [
    ...new Set(messages.map((message) => message.turnId || SENTINEL_NO_TURN)),
  ] as string[];
  const protectedTurns = new Set(options.protectLatestTurn ? turnIds.slice(-1) : []);
  // Always protect the sentinel — messages without a turnId are never safe to compact.
  protectedTurns.add(SENTINEL_NO_TURN);
  const firstProtected = messages.findIndex((message) =>
    protectedTurns.has(message.turnId || SENTINEL_NO_TURN),
  );
  const coveredMessages = messages.slice(0, firstProtected < 0 ? messages.length : firstProtected);
  const protectedMessages = messages.slice(coveredMessages.length);
  if (coveredMessages.length === 0) {
    return {
      eligible: false,
      reason: 'No settled historical turn is old enough to compact.',
      protectedMessageIds: protectedMessages.flatMap((message) =>
        stableMessageId(message) ? [stableMessageId(message)!] : [],
      ),
      coveredMessages: [],
    };
  }

  const coveredTurnIds = new Set(coveredMessages.map((message) => message.turnId));
  if (protectedMessages.some((message) => coveredTurnIds.has(message.turnId))) {
    return {
      eligible: false,
      reason: 'A turn is interleaved across the proposed compaction boundary.',
      protectedMessageIds: protectedMessages.flatMap((message) => message.messageId ?? []),
      coveredMessages: [],
    };
  }

  const coveredIds = new Set(coveredMessages.flatMap((message) => stableMessageId(message) ?? []));
  for (const call of Object.values(state.tools.calls)) {
    if (coveredIds.has(call.modelMessageId) && !TERMINAL_TOOL_STATUSES.has(call.status)) {
      return {
        eligible: false,
        reason: `Tool ${call.toolCallId} is not terminal.`,
        protectedMessageIds: protectedMessages.flatMap((message) =>
          stableMessageId(message) ? [stableMessageId(message)!] : [],
        ),
        coveredMessages: [],
      };
    }
  }
  for (const assistant of coveredMessages.filter(
    (message): message is Extract<BuiltinTranscriptMessageV1, { kind: 'assistant' }> =>
      message.kind === 'assistant',
  )) {
    for (const call of assistant.toolCalls) {
      const pairedResults = coveredMessages.filter(
        (message) => message.kind === 'tool' && message.toolCallId === call.id,
      );
      if (pairedResults.length !== 1) {
        return {
          eligible: false,
          reason: `Tool call ${call.id} must have exactly one paired result inside the boundary.`,
          protectedMessageIds: protectedMessages.flatMap((message) =>
            stableMessageId(message) ? [stableMessageId(message)!] : [],
          ),
          coveredMessages: [],
        };
      }
    }
  }
  for (const tool of coveredMessages.filter(
    (message): message is Extract<BuiltinTranscriptMessageV1, { kind: 'tool' }> =>
      message.kind === 'tool',
  )) {
    if (
      !coveredMessages.some(
        (message) =>
          message.kind === 'assistant' &&
          message.toolCalls.some((call) => call.id === tool.toolCallId),
      )
    ) {
      return {
        eligible: false,
        reason: `Tool result ${tool.toolCallId} has no paired assistant call inside the boundary.`,
        protectedMessageIds: protectedMessages.flatMap((message) =>
          stableMessageId(message) ? [stableMessageId(message)!] : [],
        ),
        coveredMessages: [],
      };
    }
  }
  const first = coveredMessages[0];
  const last = coveredMessages.at(-1);
  if (!first?.messageId || !last?.messageId || !last.turnId) {
    return {
      eligible: false,
      reason: 'The source transcript lacks stable message identities.',
      protectedMessageIds: [],
      coveredMessages: [],
    };
  }
  return {
    eligible: true,
    firstMessageId: first.messageId,
    lastMessageId: last.messageId,
    coveredThroughTurnId: last.turnId,
    protectedMessageIds: protectedMessages.flatMap((message) =>
      stableMessageId(message) ? [stableMessageId(message)!] : [],
    ),
    coveredMessages,
  };
}

export function digestCompactionSource(messages: readonly BuiltinTranscriptMessageV1[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        messages.map((message) => ({
          ...message,
          createdAt: undefined,
        })),
      ),
    )
    .digest('hex');
}
