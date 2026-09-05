import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { type AgentState, createInitialAgentState, type KernelEvent } from '@kite-ai/agent-kernel';
import { createRuntimeHostStateStorageBinding } from '@kite-ai/runtime-host';

import { createSqliteRuntimeStorage } from '../src/index';

// biome-ignore lint/suspicious/noExplicitAny: deliberate structural test helper for private state assertions
type JsonRecord = Record<string, any>;

function record(value: unknown): JsonRecord {
  return value as JsonRecord;
}

function temporaryDatabase(): { path: string; cleanup(): void } {
  const directory = mkdtempSync(join(process.cwd(), '.kite-approval-queue-'));
  return {
    path: join(directory, 'runtime.db'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function state(sessionId: string, revision = 1): AgentState {
  const base = createInitialAgentState({
    threadId: sessionId,
    userId: 'user-1',
    workspace: '/workspace/project',
    turnId: 'turn-1',
    recoveryIdentityKey: 'a'.repeat(64),
  });
  return {
    ...base,
    revision,
    session: {
      ...base.session,
      projectId: `project-${sessionId}`,
      canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}`,
    },
    approvalGeneration: 3,
    activeApprovalId: 'approval-a',
    nextQueueSequence: 1,
    pendingApprovals: new Map([
      [
        'approval-a',
        {
          interactionId: 'approval-a',
          toolCallId: 'call-a',
          approval: {
            scope: 'once',
            cwd: '/workspace/project',
            threadId: sessionId,
            tool: 'shell_execute',
            command: 'printf approval',
            risk: 'read',
            approvalHash: `sha256:${'a'.repeat(64)}`,
            summary: 'approval',
            reason: 'test',
            expectedEffects: [],
            grantOptions: ['approve_once', 'same_command'],
            recommendedGrant: 'approve_once',
          },
          invocation: {},
          bindingDigest: `sha256:${'a'.repeat(64)}`,
          route: 'user',
          fullModeBypassEligible: false,
          fullModePolicyBypassAllowed: false,
          sequence: 0,
          generation: 3,
          createdAt: '2026-08-25T00:00:00.000Z',
          status: 'authorized_queued',
          grant: 'same_command',
          receiptId: 'receipt-a',
          dispatchState: 'before_dispatch',
        },
      ],
    ]),
    sessionCommandGrants: new Map([
      [
        'grant-key-a',
        {
          grant: 'same_command',
          grantKey: 'grant-key-a',
          sessionId,
          threadId: sessionId,
          workspace: '/workspace/project',
          canonicalWorkspaceIdentity: `sha256:${'b'.repeat(64)}`,
          cwd: '/workspace/project',
          executor: 'shell',
          environment: 'env-digest-1',
          scope: 'workspace',
          effects: 'read-only',
          parserRevision: 'shell-parser-v1',
          commandDigest: 'command-digest-a',
          createdAt: '2026-08-25T00:00:00.000Z',
          generation: 3,
        },
      ],
    ]),
    approvalReceipts: new Map([
      [
        'receipt-a',
        {
          receiptId: 'receipt-a',
          interactionId: 'approval-a',
          toolCallId: 'call-a',
          generation: 3,
          grant: 'same_command',
          status: 'authorized_queued',
        },
      ],
    ]),
  } as AgentState;
}

function seedEvent(messageId: string): KernelEvent {
  return {
    type: 'user.message_appended',
    messageId,
    content: 'approval queue recovery seed',
  };
}

function batchReleaseEvent(): KernelEvent {
  return {
    type: 'approval.batch_released',
    interactionId: 'approval-a',
    toolCallId: 'call-a',
    grant: 'same_command',
    grantKey: 'grant-key-a',
    generation: 3,
    sessionRevision: 1,
    owner: { kind: 'root_tool', toolCallId: 'call-a' },
    commandIdentity: {
      sessionId: 'session-sqlite-recovery',
      threadId: 'session-sqlite-recovery',
      workspace: '/workspace/project',
      canonicalWorkspaceIdentity: `sha256:${'b'.repeat(64)}`,
      cwd: '/workspace/project',
      executor: 'shell',
      environment: 'env-digest-1',
      scope: 'workspace',
      effects: 'read-only',
      parserRevision: 'shell-parser-v1',
      commandDigest: 'command-digest-a',
    },
    matches: [
      {
        interactionId: 'approval-a',
        toolCallId: 'call-a',
        receiptId: 'receipt-a',
        generation: 3,
        owner: { kind: 'root_tool', toolCallId: 'call-a' },
      },
    ],
    createdAt: '2026-08-25T00:20:00.000Z',
  } as KernelEvent;
}

describe('SQLite durable approval queue', () => {
  test('persists one atomic batch event and its queue snapshot across reopen', () => {
    const fixture = temporaryDatabase();
    try {
      const binding = createRuntimeHostStateStorageBinding();
      const storage = createSqliteRuntimeStorage<KernelEvent, AgentState>({
        databasePath: fixture.path,
        codec: binding.codec,
        options: { journalMode: 'delete' },
      });

      expect(() =>
        storage.transactions.commitDecision({
          sessionId: 'session-sqlite-recovery',
          events: [batchReleaseEvent()],
          snapshot: state('session-sqlite-recovery'),
          metadata: [{ eventId: 'batch-receipt-a', revision: 1 }],
        }),
      ).not.toThrow();
      storage.close();

      const reopened = createSqliteRuntimeStorage<KernelEvent, AgentState>({
        databasePath: fixture.path,
        codec: binding.codec,
        sessionId: 'session-sqlite-recovery',
        options: { journalMode: 'delete' },
      });
      const restored = reopened.sessions.loadSnapshot<AgentState>('session-sqlite-recovery');
      expect(record(restored).pendingApprovals.get('approval-a').receiptId).toBe('receipt-a');
      expect(reopened.sessions.loadEventsStrict('session-sqlite-recovery')).toHaveLength(1);
      reopened.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('forking a checkpoint clears session grants, pending approvals, and receipts', () => {
    const fixture = temporaryDatabase();
    try {
      const binding = createRuntimeHostStateStorageBinding();
      const storage = createSqliteRuntimeStorage<KernelEvent, AgentState>({
        databasePath: fixture.path,
        codec: binding.codec,
        options: { journalMode: 'delete' },
      });
      const source = state('session-sqlite-fork');
      storage.transactions.commitDecision({
        sessionId: 'session-sqlite-fork',
        events: [seedEvent('seed-a')],
        snapshot: source,
        metadata: [{ eventId: 'seed-a', revision: 1 }],
      });
      storage.checkpoints.saveNamedSnapshot(
        'session-sqlite-fork',
        'approval-checkpoint',
        source,
        1,
      );

      expect(
        storage.checkpoints.forkSession(
          'session-sqlite-fork',
          'approval-checkpoint',
          'session-sqlite-fork-child',
          'c'.repeat(64),
        ),
      ).toBe(true);
      const forked = storage.sessions.loadSnapshot<AgentState>('session-sqlite-fork-child');
      expect(record(forked).pendingApprovals).toBeInstanceOf(Map);
      expect(record(forked).pendingApprovals.size).toBe(0);
      expect(record(forked).sessionCommandGrants.size).toBe(0);
      expect(record(forked).approvalReceipts.size).toBe(0);
      expect(record(forked).activeApprovalId).toBeNull();
      storage.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('concurrent same-revision recovery commits are rejected atomically', () => {
    const fixture = temporaryDatabase();
    try {
      const binding = createRuntimeHostStateStorageBinding();
      const first = createSqliteRuntimeStorage<KernelEvent, AgentState>({
        databasePath: fixture.path,
        codec: binding.codec,
        options: { journalMode: 'delete' },
      });
      const second = createSqliteRuntimeStorage<KernelEvent, AgentState>({
        databasePath: fixture.path,
        codec: binding.codec,
        options: { journalMode: 'delete' },
      });
      first.transactions.commitDecision({
        sessionId: 'session-sqlite-race',
        events: [seedEvent('seed-a')],
        snapshot: state('session-sqlite-race'),
        metadata: [{ eventId: 'seed-a', revision: 1 }],
      });
      const next = state('session-sqlite-race', 2);
      first.transactions.commitDecision({
        sessionId: 'session-sqlite-race',
        events: [seedEvent('seed-b')],
        snapshot: next,
        metadata: [{ eventId: 'seed-b', revision: 2 }],
      });
      expect(() =>
        second.transactions.commitDecision({
          sessionId: 'session-sqlite-race',
          events: [seedEvent('seed-c')],
          snapshot: next,
          metadata: [{ eventId: 'seed-c', revision: 2 }],
        }),
      ).toThrow(/revision conflict/u);
      first.close();
      second.close();
    } finally {
      fixture.cleanup();
    }
  });
});
