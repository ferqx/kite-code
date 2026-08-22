import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  createInitialAgentState,
  encodeCurrentAgentStateJson,
  type RuntimeEvent,
} from '@kite/agent-kernel';
import { createRuntimeHostState26StorageBindingV1 } from '@kite/runtime-host';

const RECOVERY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function state26(): AgentState {
  return createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
  });
}

describe('Runtime Host State26 storage binding', () => {
  test('owns exact event/state bytes and the session summary projection', () => {
    const binding = createRuntimeHostState26StorageBindingV1();
    const event: RuntimeEvent = {
      type: 'user.message_appended',
      messageId: 'message-1',
      content: 'hello',
    };
    expect(binding.codec.encodeEvent(event)).toBe(JSON.stringify(event));
    expect(binding.codec.decodeEvent(JSON.stringify(event))).toEqual(event);

    const state = state26();
    expect(binding.codec.encodeState(state)).toBe(encodeCurrentAgentStateJson(state));
    expect(binding.codec.decodeState<AgentState>(binding.codec.encodeState(state))).toEqual(state);
    expect(binding.codec.eventSummary?.(event)).toEqual({
      isSessionNameCandidate: true,
      searchText: 'hello',
    });
    expect(() => binding.codec.decodeEvent('{"type":"retired.event"}')).toThrow(
      /not part of the current format/u,
    );
  });

  test('fails closed on snapshot identity and preserves fork/request semantics', () => {
    const binding = createRuntimeHostState26StorageBindingV1();
    const state = state26();
    const valid = {
      state,
      sessionId: 'session-1',
      eventPosition: 0,
      stateRevision: 0,
      schemaVersion: 26,
      eventRevision: 0,
    };
    expect(() => binding.codec.validateSnapshot?.(valid)).not.toThrow();
    for (const invalid of [
      { ...valid, sessionId: 'session-2' },
      { ...valid, stateRevision: 1 },
      { ...valid, schemaVersion: 25 },
      { ...valid, eventRevision: 1 },
      { ...valid, eventPosition: -1 },
    ]) {
      expect(() => binding.codec.validateSnapshot?.(invalid)).toThrow(/identity or revision/u);
    }

    const request = { question: 'continue?', options: [], allow_free_text: true };
    const waiting: AgentState = {
      ...state,
      tools: {
        calls: {
          'tool-1': {
            toolCallId: 'tool-1',
            name: 'ask_user',
            modelMessageId: 'message-1',
            args: {},
            createdAtTurnId: 'turn-1',
            status: 'awaiting_user_input',
          },
        },
        queue: [],
        active: [],
      },
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        request,
      },
    };
    expect(
      binding.codec.isCurrentPendingInteractionRequest?.(waiting, {
        type: 'user_input.requested',
        interactionId: 'interaction-1',
        toolCallId: 'tool-1',
        request,
      }),
    ).toBe(true);
    const fork = binding.codec.rebindForkState(waiting, 'session-2', 'b'.repeat(64)) as AgentState;
    expect(fork.session.threadId).toBe('session-2');
    expect(fork.toolRecovery).toMatchObject({
      identityKey: 'b'.repeat(64),
      failures: {},
      order: [],
    });
    expect(fork.interactions).toEqual({ kind: 'idle' });
    expect(binding.codec.canFork?.(fork)).toBe(true);
  });

  test('projects only the current one-shot MCP receipt identity', () => {
    const binding = createRuntimeHostState26StorageBindingV1();
    const decision = {
      version: 1 as const,
      admitted: true,
      reason: 'permit_consumed',
      nonceDigest: 'nonce-1',
      invocationId: 'invocation-1',
      toolCallId: 'tool-1',
      endpointRevision: 'endpoint-1',
      toolRevision: 'tool-1',
      argumentDigest: 'argument-1',
      dataClassifications: ['confidential'] as const,
      payloadKinds: ['user_prompt'] as const,
      receiptDigest: 'receipt-1',
      originDigest: 'origin-1',
      sourceOriginIds: ['source-origin-1'],
      serverIdentity: 'server-1',
      dataOrigins: [
        {
          originId: 'source-origin-1',
          kind: 'user' as const,
          classification: 'confidential' as const,
          ownerProjectId: 'project-1',
          parentOriginIds: [],
          observationId: 'observation-1',
        },
      ],
      egressAuthority: {
        egressId: 'egress-1',
        destination: {
          destinationId: 'mcp:server-1',
          kind: 'mcp' as const,
          routeIdentity: 'server-1',
          nonceNamespace: 'mcp.egress.v1',
        },
        allowedClassifications: ['confidential'] as const,
        allowedOriginKinds: ['user'] as const,
        invocationId: 'invocation-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
      permitExpiresAt: '2026-08-20T00:01:00.000Z',
      decidedAt: '2026-08-20T00:00:00.000Z',
    };
    expect(
      binding.uniqueReceiptForEvent({
        type: 'mcp.egress_decided',
        toolCallId: 'tool-1',
        decision,
      }),
    ).toEqual({
      nonceDigest: 'nonce-1',
      invocationId: 'invocation-1',
      receiptDigest: 'receipt-1',
      originDigest: 'origin-1',
      sourceOriginIds: ['source-origin-1'],
      egressAuthorityId: 'egress-1',
      routeIdentity: 'server-1',
      expiresAt: '2026-08-20T00:01:00.000Z',
      pruneBefore: '2026-08-20T00:00:00.000Z',
    });
    expect(() =>
      binding.uniqueReceiptForEvent({
        type: 'mcp.egress_decided',
        toolCallId: 'tool-1',
        decision: { ...decision, nonceDigest: undefined },
      }),
    ).toThrow('MCP egress receipt authority is invalid');
    expect(
      binding.uniqueReceiptForEvent({
        type: 'mcp.egress_decided',
        toolCallId: 'tool-1',
        decision: { ...decision, admitted: false },
      }),
    ).toBeNull();
    expect(() =>
      binding.uniqueReceiptForEvent({
        type: 'mcp.egress_decided',
        toolCallId: 'tool-1',
        decision: { ...decision, receiptDigest: undefined },
      }),
    ).toThrow('MCP egress receipt authority is invalid');
  });
});
