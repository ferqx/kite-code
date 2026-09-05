import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import {
  createKiteHomeWorkspaceAdmissionPort,
  createKiteHomeWorkspaceRuntimeJournal,
  createKiteHomeWriteTransactionPort,
  initializeKiteHomeStoreSchema,
  type KiteHomeWorkspaceAdmission,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
} from '../src';

type Event = { readonly type: string; readonly text?: string };
type State = {
  readonly revision: number;
  readonly recoveryIdentity: string;
  readonly session: {
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  eventSummary: (event: Event) => ({
    isSessionNameCandidate: event.type === 'message',
    searchText: event.text ?? '',
  }),
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 27 }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  recoveryIdentity: (state: State) => state.recoveryIdentity,
  rebindForkState: (state: State, _sessionId: string, recoveryIdentity: string) => ({
    ...state,
    recoveryIdentity,
  }),
  isCurrentPendingInteractionRequest: () => false,
};

describe('Kite Home Workspace Runtime journal', () => {
  test('commits Session, event and snapshot through the first-write owner', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const workspace = identity('a', 'b');
    createKiteHomeWorkspaceAdmissionPort({ database, writer, now: () => 100 }).admit(workspace);
    const journal = createJournal(database, writer, workspace);
    const state = stateFor(workspace, 1);

    journal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'message', text: 'First prompt' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: state,
    });

    expect(journal.sessions.loadSnapshot<State>('session-1')).toEqual(state);
    expect(journal.sessions.loadEventsStrict('session-1')).toMatchObject([
      { event_id: 'event-1', revision: 1, event: { type: 'message', text: 'First prompt' } },
    ]);
    expect(journal.sessions.listSessions()).toEqual([
      {
        threadId: 'session-1',
        name: 'First prompt',
        updatedAt: 200,
        needsSmartName: true,
      },
    ]);
    expect(
      database
        .query<{ format_epoch: string }, []>(
          "SELECT format_epoch FROM runtime_sessions WHERE session_id = 'session-1'",
        )
        .get()?.format_epoch,
    ).toBe(SQLITE_RUNTIME_RUN_FORMAT_EPOCH);
  });

  test('persists resource receipt atomically and rejects a duplicate decision without partial rows', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const workspace = identity('a', 'b');
    createKiteHomeWorkspaceAdmissionPort({ database, writer }).admit(workspace);
    const journal = createJournal(database, writer, workspace);
    journal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'created' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: stateFor(workspace, 1),
    });
    const receipt = createRuntimeStoredCommandReceipt(
      {
        scopeSessionId: 'session-1',
        commandId: 'command-2',
        requestDigest: 'c'.repeat(64),
        targetSessionId: 'session-1',
        committedAt: 300,
      },
      2,
    );
    journal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'updated' }],
      metadata: [{ eventId: 'event-2', revision: 2 }],
      snapshot: stateFor(workspace, 2),
      commandReceipt: receipt,
    });
    expect(
      journal.commandReceipts.lookup({
        scopeSessionId: receipt.scopeSessionId,
        commandId: receipt.commandId,
        requestDigest: receipt.requestDigest,
      }),
    ).toEqual({ status: 'replay', receipt });

    expect(() =>
      journal.transactions.commitDecision({
        sessionId: 'session-1',
        events: [{ type: 'partial' }],
        metadata: [{ eventId: 'event-3', revision: 3 }],
        snapshot: stateFor(workspace, 3),
        commandReceipt: { ...receipt, committedRevision: 3 },
      }),
    ).toThrow();
    expect(journal.sessions.getLastEventPosition('session-1')).toBe(2);
    expect(journal.sessions.loadSnapshot<State>('session-1')?.revision).toBe(2);
  });

  test('retains a scoped deletion receipt and tombstone after Session facts cascade', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const workspace = identity('a', 'b');
    createKiteHomeWorkspaceAdmissionPort({ database, writer }).admit(workspace);
    const journal = createJournal(database, writer, workspace);
    journal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'created' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: stateFor(workspace, 1),
    });
    const receipt = createRuntimeStoredCommandReceipt(
      {
        scopeSessionId: 'session-1',
        commandId: 'delete-1',
        requestDigest: 'd'.repeat(64),
        targetSessionId: 'session-1',
        committedAt: 400,
      },
      1,
    );
    expect(journal.recoveryIdentities.getOrCreate('session-1', () => 'e'.repeat(64))).toBe(
      'e'.repeat(64),
    );
    expect(
      journal.recoveryIdentities.getOrCreate('session-1', () => {
        throw new Error('allocator must not be replayed');
      }),
    ).toBe('e'.repeat(64));
    expect(journal.recoveryIdentities.read('session-1')).toBe('e'.repeat(64));
    journal.sessions.deleteSession('session-1', {
      expectedRevision: 1,
      commandReceipt: receipt,
    });

    expect(journal.sessions.loadSnapshot('session-1')).toBeNull();
    expect(journal.sessions.loadEventsStrict('session-1')).toEqual([]);
    expect(
      journal.commandReceipts.lookup({
        scopeSessionId: 'session-1',
        commandId: 'delete-1',
        requestDigest: 'd'.repeat(64),
      }),
    ).toEqual({ status: 'replay', receipt });
    expect(
      database
        .query<{ workspace_id: string }, []>(
          "SELECT workspace_id FROM runtime_session_tombstones WHERE session_id = 'session-1'",
        )
        .get()?.workspace_id,
    ).toBe(workspace.workspaceId);
    expect(
      database
        .query<{ count: number }, [string]>('SELECT count(*) AS count FROM kite_meta WHERE key = ?')
        .get(
          `workspace_authority/${workspace.workspaceId}/recovery_identity_v1:${Buffer.from('session-1').toString('hex')}`,
        )?.count,
    ).toBe(0);
  });

  test('owns effect leases through the same first-write transaction and guards commits', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const workspace = identity('a', 'b');
    createKiteHomeWorkspaceAdmissionPort({ database, writer }).admit(workspace);
    const journal = createJournal(database, writer, workspace);
    journal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'created' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: stateFor(workspace, 1),
    });
    const observedAtMs = Date.now();
    expect(
      journal.effects.tryAcquireEffectLease(
        'session-1',
        'effect-1',
        'owner-1',
        observedAtMs + 60_000,
      ),
    ).toBe(true);
    journal.transactions.commitAttemptStart({
      sessionId: 'session-1',
      events: [{ type: 'attempted' }],
      metadata: [{ eventId: 'event-2', revision: 2 }],
      snapshot: stateFor(workspace, 2),
      requiredEffectLease: {
        effectId: 'effect-1',
        ownerId: 'owner-1',
        observedAtMs,
      },
    });
    journal.effects.releaseEffectLease('session-1', 'effect-1', 'owner-1');
    expect(() =>
      journal.transactions.commitTerminalRecovery({
        sessionId: 'session-1',
        events: [{ type: 'partial' }],
        metadata: [{ eventId: 'event-3', revision: 3 }],
        snapshot: stateFor(workspace, 3),
        requiredEffectLease: {
          effectId: 'effect-1',
          ownerId: 'owner-1',
          observedAtMs,
        },
      }),
    ).toThrow();
    expect(journal.sessions.getLastEventPosition('session-1')).toBe(2);
  });

  test('commits canonical Run insert and lifecycle transitions with State and receipt', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const workspace = identity('a', 'b');
    createKiteHomeWorkspaceAdmissionPort({ database, writer }).admit(workspace);
    const journal = createJournal(database, writer, workspace);
    const queued: RuntimeStoredRun = Object.freeze({
      sessionId: 'session-1',
      runId: 'run-1',
      startCommandId: 'start-1',
      phase: 'building',
      status: 'queued',
      createdRevision: 1,
      lastRevision: 1,
      createdAtMs: 1_000,
    });
    const receipt = createRuntimeStoredCommandReceipt(
      {
        scopeSessionId: 'session-1',
        commandId: 'start-1',
        requestDigest: 'a'.repeat(64),
        targetSessionId: 'session-1',
        committedAt: 1_000,
        resourceResult: createRuntimeRunStartResourceResult(queued),
      },
      1,
    );
    journal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'run-started' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: stateFor(workspace, 1),
      commandReceipt: receipt,
      runMutation: { type: 'insert', run: queued },
    });
    expect(journal.runs.get('session-1', 'run-1')).toEqual(queued);

    const running: RuntimeStoredRun = Object.freeze({
      ...queued,
      status: 'running',
      startedAtMs: 1_010,
    });
    journal.transactions.commitAttemptStart({
      sessionId: 'session-1',
      events: [],
      snapshot: stateFor(workspace, 1),
      runMutation: {
        type: 'transition',
        transition: {
          sessionId: 'session-1',
          runId: 'run-1',
          expectedLastRevision: 1,
          next: running,
        },
      },
    });
    const completed: RuntimeStoredRun = Object.freeze({
      ...running,
      status: 'completed',
      lastRevision: 2,
      finishedAtMs: 1_020,
    });
    journal.transactions.commitTerminalRecovery({
      sessionId: 'session-1',
      events: [{ type: 'run-completed' }],
      metadata: [{ eventId: 'event-2', revision: 2 }],
      snapshot: stateFor(workspace, 2),
      runMutation: {
        type: 'transition',
        transition: {
          sessionId: 'session-1',
          runId: 'run-1',
          expectedLastRevision: 1,
          next: completed,
        },
      },
    });
    expect(journal.runs.getActive('session-1')).toBeNull();
    expect(journal.runs.list({ sessionId: 'session-1', limit: 10 })).toMatchObject({
      entries: [completed],
      hasMore: false,
    });
    journal.sessions.setSessionModelRoute('session-1', { provider: 'provider', name: 'model' });
    journal.checkpoints.recordFilePreimage('session-1', 'file.txt', 'before', true);
    journal.checkpoints.recordFilePostimage('session-1', 'file.txt', 'f'.repeat(64), true);
    expect(
      journal.checkpoints.forkCurrentSession('session-1', 'session-fork', 'f'.repeat(64)),
    ).toBe(true);
    expect(journal.sessions.loadSnapshot<State>('session-fork')).toMatchObject({
      revision: 2,
      recoveryIdentity: 'f'.repeat(64),
    });
    expect(journal.sessions.getSessionModelRoute('session-fork')).toEqual({
      provider: 'provider',
      name: 'model',
    });
    expect(journal.recoveryIdentities.read('session-1')).toBe('e'.repeat(64));
    expect(journal.recoveryIdentities.read('session-fork')).toBe('f'.repeat(64));
    expect(journal.runs.get('session-fork', 'run-1')).toMatchObject({
      sessionId: 'session-fork',
      originSessionId: 'session-1',
      originRunId: 'run-1',
      status: 'completed',
    });
    expect(journal.checkpoints.fileRestorePlan('session-fork', 0)).toEqual([
      {
        path: 'file.txt',
        content: 'before',
        existed: true,
        postHash: 'f'.repeat(64),
        postExisted: true,
      },
    ]);
  });

  test('saves and restores named snapshots with event and preimage rewind', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const workspace = identity('a', 'b');
    createKiteHomeWorkspaceAdmissionPort({ database, writer }).admit(workspace);
    const journal = createJournal(database, writer, workspace);
    journal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'first' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: stateFor(workspace, 1),
    });
    journal.checkpoints.saveNamedSnapshot('session-1', 'checkpoint-1', stateFor(workspace, 1), 1);
    journal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'second' }],
      metadata: [{ eventId: 'event-2', revision: 2 }],
      snapshot: stateFor(workspace, 2),
    });
    journal.checkpoints.recordFilePreimage('session-1', 'changed.txt', 'old', true);
    journal.checkpoints.recordFilePostimage('session-1', 'changed.txt', 'c'.repeat(64), true);
    expect(journal.checkpoints.fileRestorePlan('session-1', 1)).toHaveLength(1);
    expect(journal.checkpoints.restoreNamedSnapshot('session-1', 'checkpoint-1')).toBe(true);
    expect(journal.sessions.loadSnapshot<State>('session-1')?.revision).toBe(1);
    expect(journal.sessions.getLastEventPosition('session-1')).toBe(1);
    expect(journal.checkpoints.fileRestorePlan('session-1', 1)).toEqual([]);
    expect(journal.checkpoints.listNamedSnapshots('session-1')).toEqual([
      {
        snapshotId: 'checkpoint-1',
        eventPosition: 1,
        createdAt: 0,
        affectedFileCount: 0,
      },
    ]);
  });

  test('forks a named snapshot with its exact command receipt', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const workspace = identity('a', 'b');
    createKiteHomeWorkspaceAdmissionPort({ database, writer }).admit(workspace);
    const journal = createJournal(database, writer, workspace);
    journal.transactions.commitDecision({
      sessionId: 'source',
      events: [{ type: 'first' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: stateFor(workspace, 1),
    });
    journal.checkpoints.saveNamedSnapshot('source', 'checkpoint-1', stateFor(workspace, 1), 1);
    const result = journal.checkpoints.forkSessionForCommand({
      sourceSessionId: 'source',
      snapshotId: 'checkpoint-1',
      targetSessionId: 'target',
      targetRecoveryIdentityKey: 'f'.repeat(64),
      commandEvidence: {
        scopeSessionId: 'source',
        commandId: 'fork-1',
        requestDigest: '9'.repeat(64),
        targetSessionId: 'target',
        committedAt: 1_000,
      },
    });
    expect(result).toMatchObject({
      status: 'applied',
      receipt: { targetSessionId: 'target', committedRevision: 1 },
    });
    expect(
      journal.commandReceipts.lookup({
        scopeSessionId: 'source',
        commandId: 'fork-1',
        requestDigest: '9'.repeat(64),
      }),
    ).toMatchObject({ status: 'replay', receipt: { targetSessionId: 'target' } });
  });

  test('fails closed when another Workspace addresses a Session id', () => {
    using database = preparedDatabase();
    const writer = createKiteHomeWriteTransactionPort(database);
    const admissions = createKiteHomeWorkspaceAdmissionPort({ database, writer });
    const first = identity('a', 'b');
    const second = identity('c', 'd');
    admissions.admit(first);
    admissions.admit(second);
    const firstJournal = createJournal(database, writer, first);
    const secondJournal = createJournal(database, writer, second);
    firstJournal.transactions.commitDecision({
      sessionId: 'session-1',
      events: [{ type: 'created' }],
      metadata: [{ eventId: 'event-1', revision: 1 }],
      snapshot: stateFor(first, 1),
    });

    expect(() => secondJournal.sessions.loadSnapshot('session-1')).toThrow();
    expect(() => secondJournal.recoveryIdentities.read('session-1')).toThrow();
    expect(() => secondJournal.runs.get('session-1', 'run-1')).toThrow();
    expect(() =>
      secondJournal.effects.tryAcquireEffectLease(
        'session-1',
        'effect-1',
        'owner-1',
        Date.now() + 60_000,
      ),
    ).toThrow();
    expect(() =>
      secondJournal.transactions.commitDecision({
        sessionId: 'session-1',
        events: [{ type: 'forged' }],
        metadata: [{ eventId: 'event-2', revision: 2 }],
        snapshot: stateFor(second, 2),
      }),
    ).toThrow();
    expect(firstJournal.sessions.getLastEventPosition('session-1')).toBe(1);
  });
});

function createJournal(
  database: Database,
  writer: ReturnType<typeof createKiteHomeWriteTransactionPort>,
  workspace: KiteHomeWorkspaceAdmission,
) {
  return createKiteHomeWorkspaceRuntimeJournal<Event, State>({
    database,
    writer,
    workspace,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    now: () => 200,
  });
}

function preparedDatabase(): Database {
  const database = new Database(':memory:', { strict: true });
  initializeKiteHomeStoreSchema(database);
  return database;
}

function identity(identitySeed: string, _workspaceSeed: string): KiteHomeWorkspaceAdmission {
  const canonicalPath = `/workspace/${identitySeed}`;
  const pathHex = createHash('sha256').update(canonicalPath).digest('hex');
  const projectId = `project_${pathHex}`;
  const workspaceDigest = `sha256:${pathHex}`;
  const identityDigest = `sha256:${createHash('sha256')
    .update(
      `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath, projectId, workspaceDigest })}`,
    )
    .digest('hex')}`;
  return Object.freeze({
    workspaceId: `workspace_${identityDigest.slice('sha256:'.length)}`,
    canonicalPath,
    workspaceIdentityDigest: identityDigest,
    projectId,
    workspaceDigest,
    displayName: identitySeed.toUpperCase(),
  });
}

function stateFor(workspace: KiteHomeWorkspaceAdmission, revision: number): State {
  return Object.freeze({
    revision,
    recoveryIdentity: 'e'.repeat(64),
    session: Object.freeze({
      projectId: workspace.projectId,
      canonicalWorkspaceDigest: workspace.workspaceDigest,
    }),
  });
}
