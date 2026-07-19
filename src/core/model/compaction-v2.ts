import { createHash } from 'node:crypto';
import type { RuntimeState, TranscriptMessage } from '@/core/runtime/state';
import { countTokens } from '@/core/token-counter';

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
  coveredMessages: TranscriptMessage[];
}

function stableMessageId(message: TranscriptMessage): string | undefined {
  return message.messageId;
}

/** Select only complete historical turns and never cover the latest user request. */
export function findSafeCompactionBoundary(
  state: Readonly<RuntimeState>,
  options: { recentTurns?: number } = {},
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
  const recentCount = options.recentTurns ?? 3;
  const protectedTurns = new Set(turnIds.slice(-recentCount));
  // Always protect the sentinel — messages without a turnId are never safe to compact.
  protectedTurns.add(SENTINEL_NO_TURN);
  const latestUser = [...messages].reverse().find((message) => message.kind === 'user');
  if (latestUser?.turnId) protectedTurns.add(latestUser.turnId);
  const firstProtected = messages.findIndex((message) => protectedTurns.has(message.turnId ?? ''));
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
    (message): message is Extract<TranscriptMessage, { kind: 'assistant' }> =>
      message.kind === 'assistant',
  )) {
    for (const call of assistant.toolCalls) {
      if (
        !coveredMessages.some(
          (message) => message.kind === 'tool' && message.toolCallId === call.id,
        )
      ) {
        return {
          eligible: false,
          reason: `Tool call ${call.id} has no paired result inside the boundary.`,
          protectedMessageIds: protectedMessages.flatMap((message) =>
            stableMessageId(message) ? [stableMessageId(message)!] : [],
          ),
          coveredMessages: [],
        };
      }
    }
  }
  for (const tool of coveredMessages.filter(
    (message): message is Extract<TranscriptMessage, { kind: 'tool' }> => message.kind === 'tool',
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

export function digestCompactionSource(messages: TranscriptMessage[]): string {
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

export interface ContextMessageChunk {
  messages: TranscriptMessage[];
  tokenCount: number;
  sourceDigest: string;
}

function messageTokens(message: TranscriptMessage): number {
  return countTokens(JSON.stringify(message)) + 4;
}

/** Chunk by complete turns; an oversized turn remains intact for fail-closed handling upstream. */
export function chunkCompactionMessages(
  messages: TranscriptMessage[],
  maxTokens: number,
): ContextMessageChunk[] {
  const turns: TranscriptMessage[][] = [];
  for (const message of messages) {
    const current = turns.at(-1);
    if (!current || current[0]?.turnId !== message.turnId) turns.push([message]);
    else current.push(message);
  }
  const chunks: TranscriptMessage[][] = [];
  for (const turn of turns) {
    const turnTokens = turn.reduce((total, message) => total + messageTokens(message), 0);
    const current = chunks.at(-1);
    const currentTokens = current?.reduce((total, message) => total + messageTokens(message), 0);
    if (current && (currentTokens ?? 0) + turnTokens <= maxTokens) current.push(...turn);
    else chunks.push([...turn]);
  }
  return chunks.map((chunk) => ({
    messages: chunk,
    tokenCount: chunk.reduce((total, message) => total + messageTokens(message), 0),
    sourceDigest: digestCompactionSource(chunk),
  }));
}
