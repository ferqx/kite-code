import { describe, expect, test } from 'bun:test';

import {
  type AgentApprovalCommandIdentity,
  type AgentState,
  approvalCommandGrantKey,
  createInitialAgentState,
  type KernelEvent,
  reduceAgentState,
} from '@kite-ai/agent-kernel';

import { createRuntimeHostStateStorageBinding } from '@kite-ai/runtime-host';

// biome-ignore lint/suspicious/noExplicitAny: deliberate structural test helper for private state assertions
type JsonRecord = Record<string, any>;

function record(value: unknown): JsonRecord {
  return value as JsonRecord;
}

function commandIdentity(
  overrides: Partial<AgentApprovalCommandIdentity> = {},
): AgentApprovalCommandIdentity {
  return {
    sessionId: 'session-host-recovery',
    threadId: 'session-host-recovery',
    workspace: '/workspace/project',
    canonicalWorkspaceIdentity: `sha256:${'a'.repeat(64)}`,
    cwd: '/workspace/project',
    executor: 'shell',
    environment: 'env-digest-1',
    scope: 'workspace',
    effects: 'read-only',
    parserRevision: 'shell-parser-v1',
    commandDigest: 'command-digest-a',
    ...overrides,
  };
}

function approvalPayload(overrides: JsonRecord = {}): JsonRecord {
  return {
    toolName: 'shell_execute',
    command: 'printf hello',
    summary: 'Print hello',
    reason: 'The shell command needs approval',
    cwd: '/workspace/project',
    scope: 'workspace',
    effects: 'read-only',
    risk: 'read-only',
    grantOptions: ['approve_once', 'same_command'],
    recommendedGrant: 'approve_once',
    commandIdentity: commandIdentity(),
    ...overrides,
  };
}

function toolQueued(toolCallId: string): KernelEvent {
  return {
    type: 'tool.queued',
    toolCallId,
    name: 'shell_execute',
    args: { command: 'printf hello' },
    modelMessageId: `message-${toolCallId}`,
    ordinal: 0,
    invocationFingerprint: `fingerprint-${toolCallId}`,
  } as KernelEvent;
}

function approvalRequested(interactionId: string, toolCallId: string): KernelEvent {
  return {
    type: 'approval.requested',
    interactionId,
    toolCallId,
    approval: approvalPayload(),
    commandIdentity: commandIdentity(),
    fullModeBypassEligible: false,
    fullModePolicyBypassAllowed: false,
    owner: { kind: 'root_tool', toolCallId },
    createdAt: '2026-08-25T00:00:00.000Z',
  } as KernelEvent;
}

function batchReleaseEvent(): KernelEvent {
  const identity = commandIdentity();
  return {
    type: 'approval.batch_released',
    interactionId: 'approval-a',
    toolCallId: 'call-a',
    grant: 'same_command',
    grantKey: approvalCommandGrantKey(identity),
    sessionRevision: 0,
    generation: 0,
    commandIdentity: identity,
    owner: { kind: 'root_tool', toolCallId: 'call-a' },
    matches: [
      {
        interactionId: 'approval-a',
        toolCallId: 'call-a',
        receiptId: 'receipt-a',
        generation: 0,
        owner: { kind: 'root_tool', toolCallId: 'call-a' },
      },
      {
        interactionId: 'approval-b',
        toolCallId: 'call-b',
        receiptId: 'receipt-b',
        generation: 0,
        owner: { kind: 'root_tool', toolCallId: 'call-b' },
      },
    ],
    createdAt: '2026-08-25T00:10:00.000Z',
  } as KernelEvent;
}

function stateWithDurableApprovalQueue(): AgentState {
  const initial = createInitialAgentState({
    threadId: 'session-host-recovery',
    userId: 'user-1',
    workspace: '/workspace/project',
    turnId: 'turn-1',
    recoveryIdentityKey: 'a'.repeat(64),
  });
  const queued = [
    toolQueued('call-a'),
    approvalRequested('approval-a', 'call-a'),
    toolQueued('call-b'),
    approvalRequested('approval-b', 'call-b'),
  ].reduce((state, event) => reduceAgentState(state, event), initial);
  return reduceAgentState(queued, batchReleaseEvent());
}

describe('runtime-host approval batch recovery', () => {
  test('snapshot round-trip retains authorized_queued receipts at the dispatch boundary', () => {
    const binding = createRuntimeHostStateStorageBinding();
    const source = stateWithDurableApprovalQueue();
    const restored = binding.codec.decodeState(binding.codec.encodeState(source));
    const queue = record(restored);

    expect(queue.pendingApprovals.get('approval-a').status).toBe('authorized_queued');
    expect(queue.pendingApprovals.get('approval-a').dispatchState).toBe('before_dispatch');
    expect(queue.pendingApprovals.get('approval-b').status).toBe('authorized_queued');
    expect(queue.approvalReceipts.get('receipt-a')).toMatchObject({
      generation: 0,
      status: 'authorized_queued',
    });
  });

  test('event codec accepts and replays one atomic same_command batch event', () => {
    const binding = createRuntimeHostStateStorageBinding();
    const event = batchReleaseEvent();
    const replayed = binding.codec.decodeEvent(binding.codec.encodeEvent(event));

    expect(record(replayed).type).toBe('approval.batch_released');
    expect(record(replayed).grant).toBe('same_command');
    expect(record(replayed).commandIdentity).toMatchObject({
      sessionId: 'session-host-recovery',
      commandDigest: 'command-digest-a',
    });
    expect(record(replayed).matches).toHaveLength(2);
  });

  test('fork rebind clears queue, session grants, generations, and replay receipts', () => {
    const binding = createRuntimeHostStateStorageBinding();
    const source = stateWithDurableApprovalQueue();
    const fork = binding.codec.rebindForkState(source, 'fork-session', 'b'.repeat(64));
    const queue = record(fork);

    expect(queue.pendingApprovals).toBeInstanceOf(Map);
    expect(queue.pendingApprovals.size).toBe(0);
    expect(queue.sessionCommandGrants.size).toBe(0);
    expect(queue.approvalReceipts.size).toBe(0);
    expect(queue.approvalGeneration).toBe(0);
    expect(queue.nextQueueSequence).toBe(0);
    expect(queue.activeApprovalId).toBeNull();
  });

  test('recovery replays an identical batch exactly once', () => {
    const event = batchReleaseEvent();
    const initial = createInitialAgentState({
      threadId: 'session-host-recovery',
      userId: 'user-1',
      workspace: '/workspace/project',
      turnId: 'turn-1',
      recoveryIdentityKey: 'a'.repeat(64),
    });
    const source = [
      toolQueued('call-a'),
      approvalRequested('approval-a', 'call-a'),
      toolQueued('call-b'),
      approvalRequested('approval-b', 'call-b'),
    ].reduce((state, queuedEvent) => reduceAgentState(state, queuedEvent), initial);
    const first = reduceAgentState(source, event);
    const second = reduceAgentState(first, event);

    expect(second).toEqual(first);
    expect(second.approvalReceipts.size).toBe(2);
    expect(second.sessionCommandGrants.size).toBe(1);
  });
});
