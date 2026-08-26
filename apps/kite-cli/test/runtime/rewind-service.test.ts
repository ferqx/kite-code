import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceFilesystemContentHash } from '@kite-ai/builtin-runtime/filesystem';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeEvent } from '#kite-cli/bootstrap/runtime/state-runtime';
import { findPendingRewindIntents, RewindService } from '#kite-cli/runtime/session/rewind-service';
import { openStateStoreForTest } from '../../../../scripts/support/runtime-storage';

const request: Extract<RuntimeEvent, { type: 'session.rewind_requested' }> = {
  type: 'session.rewind_requested',
  rewindId: 'rewind-1',
  commandId: 'command-1',
  sourceSessionId: 'source',
  targetSessionId: 'rewind_session_target',
  checkpointId: 'checkpoint-1',
  scope: 'conversation_and_workspace',
};

describe('durable rewind intent recovery', () => {
  test('returns only unmatched requests from strict event history', () => {
    const completed: RuntimeEvent = { ...request, type: 'session.rewind_completed' };
    expect(findPendingRewindIntents([request, completed])).toEqual([]);
  });

  test('does not let a mismatched terminal suppress the deterministic retry', () => {
    const mismatched: RuntimeEvent = {
      ...request,
      type: 'session.rewind_failed',
      checkpointId: 'other-checkpoint',
      failureCode: 'checkpoint_unavailable',
    };
    expect(findPendingRewindIntents([request, mismatched])).toEqual([request]);
  });

  test('retries a pre-terminal file restore with zero second writes', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-rewind-files-'));
    const databasePath = join(root, 'runtime.sqlite');
    const workspace = join(root, 'workspace');
    const sourceSessionId = 'rewind-files-source';
    const filePath = join(workspace, 'notes.md');
    const state = createRuntimeHostStateInitialState({
      threadId: sourceSessionId,
      userId: 'user',
      workspace,
      recoveryIdentityKey: '0'.repeat(64),
    });
    const source = openStateStoreForTest(databasePath, { sessionId: sourceSessionId });
    try {
      mkdirSync(workspace);
      source.sessions.saveSnapshot(sourceSessionId, state);
      source.checkpoints.saveNamedSnapshot(sourceSessionId, 'checkpoint-1', state, 0);
      source.sessions.appendEvents(sourceSessionId, [
        { type: 'user.message_appended', messageId: 'after-checkpoint', content: 'after' },
      ]);
      writeFileSync(filePath, 'after\n');
      source.checkpoints.recordFilePreimage(sourceSessionId, 'notes.md', 'before\n', true);
      source.checkpoints.recordFilePostimage(
        sourceSessionId,
        'notes.md',
        workspaceFilesystemContentHash('after\n'),
        true,
      );
    } finally {
      source.close();
    }
    const service = new RewindService({
      openStateRuntimeStorage: (threadId) =>
        openStateStoreForTest(databasePath, { sessionId: threadId }) as never,
      resolveRecoveryIdentity: () => 'f'.repeat(64),
      allocateRecoveryIdentity: () => 'e'.repeat(64),
    });
    const intent: Extract<RuntimeEvent, { type: 'session.rewind_requested' }> = {
      ...request,
      sourceSessionId,
      targetSessionId: sourceSessionId,
      scope: 'code_only',
    };

    try {
      const first = await service.executeIntent({ intent, workspace });
      const second = await service.executeIntent({ intent, workspace });
      expect(first.fileOutcome).toMatchObject({ restored: ['notes.md'] });
      expect(second.fileOutcome).toMatchObject({
        restored: [],
        deleted: [],
        failed: [],
        conflicts: [],
      });
      expect(readFileSync(filePath, 'utf8')).toBe('before\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retries a deterministic conversation fork without a duplicate target or identity', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-rewind-fork-'));
    const databasePath = join(root, 'runtime.sqlite');
    const sourceSessionId = 'rewind-fork-source';
    const targetSessionId = 'rewind_session_deterministic';
    const state = createRuntimeHostStateInitialState({
      threadId: sourceSessionId,
      userId: 'user',
      workspace: root,
      recoveryIdentityKey: '0'.repeat(64),
    });
    const source = openStateStoreForTest(databasePath, { sessionId: sourceSessionId });
    try {
      source.sessions.saveSnapshot(sourceSessionId, state);
      source.checkpoints.saveNamedSnapshot(sourceSessionId, 'checkpoint-1', state, 0);
    } finally {
      source.close();
    }
    let allocations = 0;
    const open = (threadId?: string) =>
      openStateStoreForTest(databasePath, { sessionId: threadId });
    const service = new RewindService({
      openStateRuntimeStorage: (threadId) => open(threadId) as never,
      resolveRecoveryIdentity: (threadId) => {
        const store = open(threadId);
        try {
          return store.recoveryIdentities.getOrCreate(threadId, () => 'd'.repeat(64));
        } finally {
          store.close();
        }
      },
      allocateRecoveryIdentity: () => {
        allocations++;
        return 'e'.repeat(64);
      },
    });
    const intent: Extract<RuntimeEvent, { type: 'session.rewind_requested' }> = {
      ...request,
      sourceSessionId,
      targetSessionId,
      scope: 'conversation_only',
    };

    try {
      const first = await service.executeIntent({ intent, workspace: root });
      const second = await service.executeIntent({ intent, workspace: root });
      expect(first.targetThreadId).toBe(targetSessionId);
      expect(second.targetThreadId).toBe(targetSessionId);
      expect(allocations).toBe(1);
      const store = open(targetSessionId);
      try {
        expect(store.sessions.loadSnapshot(targetSessionId)?.session.threadId).toBe(
          targetSessionId,
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records an unavailable checkpoint terminal once, so restart performs zero more effects', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-rewind-terminal-'));
    const databasePath = join(root, 'runtime.sqlite');
    const sourceSessionId = 'rewind-terminal-source';
    const state = createRuntimeHostStateInitialState({
      threadId: sourceSessionId,
      userId: 'user',
      workspace: root,
      recoveryIdentityKey: '0'.repeat(64),
    });
    const initial = openStateStoreForTest(databasePath, { sessionId: sourceSessionId });
    try {
      initial.sessions.saveSnapshot(sourceSessionId, state);
      initial.sessions.appendEvents(sourceSessionId, [
        {
          ...request,
          sourceSessionId,
          targetSessionId: sourceSessionId,
          scope: 'code_only',
          checkpointId: 'missing-checkpoint',
        },
      ]);
    } finally {
      initial.close();
    }
    const open = (threadId?: string) =>
      openStateStoreForTest(databasePath, { sessionId: threadId });
    const service = new RewindService({
      openStateRuntimeStorage: (threadId) => open(threadId) as never,
      resolveRecoveryIdentity: () => 'f'.repeat(64),
      allocateRecoveryIdentity: () => 'e'.repeat(64),
    });
    const terminalEvents: RuntimeEvent[] = [];
    const persistTerminal = (event: RuntimeEvent) => {
      terminalEvents.push(event);
      const store = open(sourceSessionId);
      try {
        store.sessions.appendEvents(sourceSessionId, [event]);
      } finally {
        store.close();
      }
    };

    try {
      const first = await service.recoverPendingIntents({
        sourceThreadId: sourceSessionId,
        workspace: root,
        persistTerminal,
      });
      const second = await service.recoverPendingIntents({
        sourceThreadId: sourceSessionId,
        workspace: root,
        persistTerminal,
      });
      expect(first).toMatchObject({ executed: 1, completed: 0, failed: 1 });
      expect(second).toMatchObject({ executed: 0, completed: 0, failed: 0 });
      expect(terminalEvents).toEqual([
        expect.objectContaining({
          type: 'session.rewind_failed',
          failureCode: 'checkpoint_unavailable',
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
