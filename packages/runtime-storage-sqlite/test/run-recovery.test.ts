import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  type RuntimeRunTransactionMutation,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import {
  createSqliteRuntimeStorage,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
} from '../src';

type Event = { readonly type: string; readonly revision: number };
type State = {
  readonly schemaVersion: number;
  readonly formatEpoch: string;
  readonly revision: number;
  readonly session: {
    readonly threadId: string;
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
    readonly recoveryIdentityKey: string;
  };
};

const binding = {
  layoutGeneration: 'generation-run-recovery-1',
  workerScopeId: 'worker-scope-run-recovery',
  workspaceIdentityDigest:
    'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
} as const;

let failEncoding = false;

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: (value: State) => {
    if (failEncoding) throw new Error('injected rewind snapshot failure');
    return JSON.stringify(value);
  },
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  snapshotMetadata: (value: State) => ({
    stateRevision: value.revision,
    schemaVersion: value.schemaVersion,
  }),
  sessionIdentity: (value: State) => ({
    projectId: value.session.projectId,
    canonicalWorkspaceDigest: value.session.canonicalWorkspaceDigest,
  }),
  recoveryIdentity: (value: State) => value.session.recoveryIdentityKey,
  validateSnapshot: ({
    state: value,
    sessionId,
    stateRevision,
    eventRevision,
  }: {
    readonly state: State;
    readonly sessionId: string;
    readonly stateRevision: number;
    readonly eventRevision: number;
  }) => {
    if (
      value.session.threadId !== sessionId ||
      value.revision !== stateRevision ||
      stateRevision !== eventRevision
    ) {
      throw new Error('invalid test snapshot');
    }
  },
  rebindForkState: (value: State, sessionId: string, recoveryIdentityKey: string): State => ({
    ...value,
    session: { ...value.session, threadId: sessionId, recoveryIdentityKey },
  }),
  canFork: () => true,
};

describe('Store 8 delete, rewind and fork recovery semantics', () => {
  test('retains original resource receipts while current Run rows follow rewind and delete', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-run-recovery-'));
    const databasePath = join(root, 'runtime.db');
    try {
      const storage = open(databasePath);
      const first = queuedRun('source', 'run-1', 'start-run-1', 1, 100);
      commitStart(storage, first, '1'.repeat(64));
      commitTransition(storage, first, completed(first, 2, 110, 120));
      storage.checkpoints.saveNamedSnapshot('source', 'safe', state('source', 2));

      const second = queuedRun('source', 'run-2', 'start-run-2', 3, 200);
      commitStart(storage, second, '2'.repeat(64));
      const running = { ...second, status: 'running' as const, lastRevision: 4, startedAtMs: 210 };
      commitTransition(storage, second, running);
      storage.checkpoints.saveNamedSnapshot('source', 'partial', state('source', 4));
      commitTransition(storage, running, completed(running, 5, 210, 240));

      expect(
        storage.checkpoints.forkSession('source', 'partial', 'partial-fork', 'a'.repeat(64)),
      ).toBe(false);
      expect(storage.sessions.loadSnapshot('partial-fork')).toBeNull();
      expect(storage.checkpoints.restoreNamedSnapshot('source', 'partial')).toBe(false);
      expect(storage.sessions.loadSnapshot<State>('source')?.revision).toBe(5);
      expect(storage.runs?.get('source', 'run-2')?.lastRevision).toBe(5);

      failEncoding = true;
      expect(() => storage.checkpoints.restoreNamedSnapshot('source', 'safe')).toThrow(
        'injected rewind snapshot failure',
      );
      failEncoding = false;
      expect(storage.sessions.loadSnapshot<State>('source')?.revision).toBe(5);
      expect(storage.runs?.get('source', 'run-2')?.lastRevision).toBe(5);

      expect(storage.checkpoints.restoreNamedSnapshot('source', 'safe')).toBe(true);
      expect(storage.sessions.loadSnapshot<State>('source')?.revision).toBe(2);
      expect(storage.runs?.get('source', 'run-1')?.status).toBe('completed');
      expect(storage.runs?.get('source', 'run-2')).toBeNull();
      expect(
        storage.commandReceipts.lookup({
          scopeSessionId: 'source',
          commandId: 'start-run-2',
          requestDigest: '2'.repeat(64),
        }),
      ).toMatchObject({ status: 'replay', receipt: { resourceResult: expect.any(Object) } });

      expect(storage.checkpoints.forkSession('source', 'safe', 'fork', 'b'.repeat(64))).toBe(true);
      expect(storage.runs?.get('fork', 'run-1')).toMatchObject({
        sessionId: 'fork',
        runId: 'run-1',
        originSessionId: 'source',
        originRunId: 'run-1',
        status: 'completed',
        createdAtMs: 100,
        finishedAtMs: 120,
      });
      expect(
        storage.commandReceipts.lookup({
          scopeSessionId: 'fork',
          commandId: 'start-run-1',
          requestDigest: '1'.repeat(64),
        }),
      ).toEqual({ status: 'missing' });

      const deletionReceipt = createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: 'source',
          commandId: 'delete-source',
          requestDigest: 'd'.repeat(64),
          targetSessionId: 'source',
          committedAt: 300,
        },
        2,
      );
      const conflictingDeletion = createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: 'source',
          commandId: 'start-run-1',
          requestDigest: 'c'.repeat(64),
          targetSessionId: 'source',
          committedAt: 290,
        },
        2,
      );
      expect(() =>
        storage.sessions.deleteSession('source', {
          expectedRevision: 2,
          commandReceipt: conflictingDeletion,
        }),
      ).toThrow();
      expect(storage.sessions.loadSnapshot<State>('source')?.revision).toBe(2);
      expect(storage.runs?.get('source', 'run-1')?.status).toBe('completed');

      storage.sessions.deleteSession('source', {
        expectedRevision: 2,
        commandReceipt: deletionReceipt,
      });
      expect(storage.sessions.loadSnapshot('source')).toBeNull();
      expect(storage.runs?.list({ sessionId: 'source', limit: 10 }).entries).toEqual([]);
      expect(storage.runs?.get('fork', 'run-1')?.status).toBe('completed');
      storage.close();

      const reopened = open(databasePath);
      expect(reopened.sessions.loadSnapshot('source')).toBeNull();
      expect(reopened.runs?.get('source', 'run-1')).toBeNull();
      expect(reopened.runs?.get('fork', 'run-1')).toMatchObject({
        originSessionId: 'source',
        originRunId: 'run-1',
      });
      expect(
        reopened.commandReceipts.lookup({
          scopeSessionId: 'source',
          commandId: 'start-run-2',
          requestDigest: '2'.repeat(64),
        }),
      ).toMatchObject({ status: 'replay', receipt: { committedRevision: 3 } });
      expect(
        reopened.commandReceipts.lookup({
          scopeSessionId: 'source',
          commandId: 'delete-source',
          requestDigest: 'd'.repeat(64),
        }),
      ).toMatchObject({ status: 'replay' });
      reopened.close();
    } finally {
      failEncoding = false;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses a Store 8 reopen through a different Workspace owner', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-run-isolation-'));
    const databasePath = join(root, 'runtime.db');
    try {
      const storage = open(databasePath);
      commitStart(storage, queuedRun('isolated', 'run-1', 'start-run-1', 1, 100), '1'.repeat(64));
      storage.close();

      expect(() =>
        createSqliteRuntimeStorage<Event, State>({
          databasePath,
          codec,
          workspaceBinding: { ...binding, workerScopeId: 'another-worker-scope' },
          targetStore: 'run',
          options: { journalMode: 'delete' },
        }),
      ).toThrow();
      const reopened = open(databasePath);
      expect(reopened.runs?.get('isolated', 'run-1')?.runId).toBe('run-1');
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function open(databasePath: string) {
  const storage = createSqliteRuntimeStorage<Event, State>({
    databasePath,
    codec,
    workspaceBinding: binding,
    targetStore: 'run',
    options: { journalMode: 'delete' },
  });
  if (!storage.runs) throw new Error('Store 8 Run authority is unavailable.');
  return storage;
}

function state(sessionId: string, revision: number): State {
  return {
    schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    revision,
    session: {
      threadId: sessionId,
      projectId: 'project-run-recovery',
      canonicalWorkspaceDigest: 'sha256:workspace-run-recovery',
      recoveryIdentityKey: sessionId === 'source' ? 'f'.repeat(64) : 'e'.repeat(64),
    },
  };
}

function queuedRun(
  sessionId: string,
  runId: string,
  startCommandId: string,
  revision: number,
  createdAtMs: number,
): RuntimeStoredRun {
  return {
    sessionId,
    runId,
    startCommandId,
    phase: 'building',
    status: 'queued',
    createdRevision: revision,
    lastRevision: revision,
    createdAtMs,
  };
}

function completed(
  run: RuntimeStoredRun,
  revision: number,
  startedAtMs: number,
  finishedAtMs: number,
): RuntimeStoredRun {
  return {
    ...run,
    status: 'completed',
    lastRevision: revision,
    startedAtMs,
    finishedAtMs,
    terminal: { reasonCode: 'completed', safeRetry: false, recoveryEntry: 'none' },
  };
}

function commitStart(
  storage: ReturnType<typeof open>,
  run: RuntimeStoredRun,
  requestDigest: string,
): void {
  const resourceResult = createRuntimeRunStartResourceResult(run);
  const receipt = createRuntimeStoredCommandReceipt(
    {
      scopeSessionId: run.sessionId,
      commandId: run.startCommandId,
      requestDigest,
      targetSessionId: run.sessionId,
      committedAt: run.createdAtMs,
      resourceResult,
    },
    run.createdRevision,
  );
  commit(
    storage,
    run.sessionId,
    run.createdRevision,
    {
      type: 'insert',
      run,
    },
    receipt,
  );
}

function commitTransition(
  storage: ReturnType<typeof open>,
  previous: RuntimeStoredRun,
  next: RuntimeStoredRun,
): void {
  commit(storage, next.sessionId, next.lastRevision, {
    type: 'transition',
    transition: {
      sessionId: next.sessionId,
      runId: next.runId,
      expectedLastRevision: previous.lastRevision,
      next,
    },
  });
}

function commit(
  storage: ReturnType<typeof open>,
  sessionId: string,
  revision: number,
  runMutation: RuntimeRunTransactionMutation,
  commandReceipt?: ReturnType<typeof createRuntimeStoredCommandReceipt>,
): void {
  storage.transactions.commitDecision({
    sessionId,
    events: [{ type: 'test.run.changed', revision }],
    snapshot: state(sessionId, revision),
    metadata: [
      {
        eventId: `${sessionId}-event-${revision}`,
        revision,
        occurredAt: `2026-08-30T00:00:0${Math.min(revision, 9)}.000Z`,
      },
    ],
    runMutation,
    ...(commandReceipt ? { commandReceipt } : {}),
  });
}
