import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  createInitialAgentState,
  encodeCurrentAgentStateJson,
} from '@kite/agent-kernel';
import { createRuntimeHostStateStorageBinding } from '@kite/runtime-host';

const RECOVERY_KEY = 'c'.repeat(64);
const LEGACY_FORMAT = {
  schemaVersion: 26,
  formatEpoch: 'kite-runtime-modularization-v1-2026-08-19',
} as const;

function legacyStateJson(): string {
  const current = createInitialAgentState({
    threadId: 'legacy-session',
    userId: 'user',
    workspace: '/workspace',
    projectId: 'project',
    canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
    turnId: 'legacy-turn',
    recoveryIdentityKey: RECOVERY_KEY,
    interactionMode: 'full',
  });
  const legacy = JSON.parse(encodeCurrentAgentStateJson(current)) as Record<string, unknown>;
  legacy.schemaVersion = 26;
  legacy.formatEpoch = LEGACY_FORMAT.formatEpoch;
  legacy.authorization = {
    mode: 'full_access',
    commandGrants: {
      unsafe: {
        workspace: '/workspace',
        threadId: 'legacy-session',
        command: 'dangerous command',
        source: 'user',
        grantedAt: '2026-08-24T00:00:00.000Z',
      },
    },
  };
  for (const field of [
    'interactionModeRevision',
    'pendingApprovals',
    'activeApprovalId',
    'nextQueueSequence',
    'approvalGeneration',
    'sessionCommandGrants',
    'approvalReceipts',
  ]) {
    delete legacy[field];
  }
  return JSON.stringify(legacy);
}

describe('Runtime Host State compatibility codec', () => {
  test('silently migrates the exact State 26 profile without restoring authority', () => {
    const codec = createRuntimeHostStateStorageBinding().codec;
    const migrated = codec.decodeCompatibleState?.(
      legacyStateJson(),
      LEGACY_FORMAT,
    ) as AgentState | null;
    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(27);
    expect(migrated?.mode).toBe('accept_edits');
    expect(migrated?.pendingApprovals.size).toBe(0);
    expect(migrated?.sessionCommandGrants.size).toBe(0);
    expect(migrated?.approvalReceipts.size).toBe(0);
  });

  test('projects legacy authority and unknown event types to inert history', () => {
    const codec = createRuntimeHostStateStorageBinding().codec;
    expect(
      codec.decodeCompatibleEvent?.(
        JSON.stringify({ type: 'authorization.changed', mode: 'full_access' }),
        LEGACY_FORMAT,
      ),
    ).toEqual({
      type: 'runtime.action_ignored',
      reason: 'legacy_authorization_compatibility',
    });
    expect(
      codec.decodeCompatibleState?.(legacyStateJson(), {
        schemaVersion: 999,
        formatEpoch: 'unknown',
      }),
    ).toBeNull();
    expect(
      codec.decodeCompatibleState?.(legacyStateJson(), {
        schemaVersion: 26,
        formatEpoch: 'unknown',
      }),
    ).toBeNull();
    expect(
      codec.decodeCompatibleEvent?.(JSON.stringify({ type: 'future.event' }), LEGACY_FORMAT),
    ).toEqual({
      type: 'runtime.action_ignored',
      reason: 'legacy_unknown_event_compatibility',
    });
    expect(codec.decodeCompatibleEvent?.(JSON.stringify({ value: 1 }), LEGACY_FORMAT)).toBeNull();
  });

  test('keeps the write side current-only', () => {
    const codec = createRuntimeHostStateStorageBinding().codec;
    expect(() => codec.encodeState(JSON.parse(legacyStateJson()) as AgentState)).toThrow();
    expect(() =>
      codec.encodeEvent({
        type: 'authorization.changed',
        mode: 'full_access',
      } as never),
    ).toThrow();
  });
});
