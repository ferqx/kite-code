import { describe, expect, test } from 'bun:test';
import {
  type AgentApprovalCommandIdentity,
  approvalCommandGrantKey,
  assertCurrentRuntimeEvent,
  createInitialAgentState,
  reduceAgentState,
} from '../src';

const IDENTITY: AgentApprovalCommandIdentity = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  workspace: '/workspace',
  canonicalWorkspaceIdentity: 'workspace-digest',
  cwd: '/workspace/src',
  executor: 'builtin:shell_execute',
  environment: 'environment-digest',
  scope: 'workspace_write',
  effects: 'effects-digest',
  parserRevision: 'parser-revision',
  executorRevision: 'executor-revision',
  commandDigest: 'command-digest',
};

describe('approval command identity and grant key', () => {
  test('is deterministic and binds every security-relevant subject field', () => {
    const first = approvalCommandGrantKey(IDENTITY);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(approvalCommandGrantKey(IDENTITY)).toBe(first);

    for (const field of [
      'sessionId',
      'threadId',
      'workspace',
      'canonicalWorkspaceIdentity',
      'cwd',
      'executor',
      'environment',
      'scope',
      'effects',
      'parserRevision',
      'executorRevision',
      'commandDigest',
    ] as const) {
      const changed = { ...IDENTITY, [field]: `${IDENTITY[field] ?? ''}-changed` };
      expect(approvalCommandGrantKey(changed)).not.toBe(first);
    }
  });

  test('does not accept legacy full_access approval or authorization events', () => {
    const legacyApproval = {
      type: 'approval.granted',
      interactionId: 'interaction-1',
      toolCallId: 'call-1',
      grant: 'full_access',
      receiptId: 'receipt-1',
      generation: 1,
      owner: { kind: 'root_tool', toolCallId: 'call-1' },
    };
    expect(() => assertCurrentRuntimeEvent(legacyApproval)).toThrow(
      'approval.granted may only issue approve_once.',
    );

    const legacyAuthorization = {
      type: 'authorization.changed',
      mode: 'full_access',
      modeSource: 'user',
      modeGrantedAt: '2026-08-25T00:00:00.000Z',
      commandGrants: {},
    };
    expect(() => assertCurrentRuntimeEvent(legacyAuthorization)).toThrow();
    const state = createInitialAgentState({
      threadId: 'session-1',
      userId: 'user-1',
      workspace: '/workspace',
      turnId: 'turn-1',
      recoveryIdentityKey: 'a'.repeat(64),
    });
    expect(() => reduceAgentState(state, legacyAuthorization as never)).toThrow();
  });
});
