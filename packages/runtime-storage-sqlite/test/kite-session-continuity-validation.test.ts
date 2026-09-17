import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import {
  assertKiteSessionStoreSchema,
  createKiteHomeWorkspaceRuntimeJournal,
  createKiteHomeWriteTransactionPort,
  createKiteSessionExecutionAuthority,
  openKiteSessionRuntimeStorage,
  openKiteSessionStoreDatabase,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
} from '../src';
import { validateKiteSessionStoreContinuity } from '../src/kite-session-continuity-validation';

type State = {
  revision: number;
  recoveryIdentity: string;
  session: { projectId: string; canonicalWorkspaceDigest: string };
};
type Event = { type: string; text: string };
const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  eventSummary: (event: Event) => ({ isSessionNameCandidate: true, searchText: event.text }),
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

function fixture(withFork = false) {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-validation-')),
  );
  const database = openKiteSessionStoreDatabase(join(root, 'kite-session.sqlite'));
  const canonicalPath = '/workspace/continuity';
  const hex = createHash('sha256').update(canonicalPath).digest('hex');
  const projectId = `project_${hex}`;
  const workspaceDigest = `sha256:${hex}`;
  const workspaceIdentityDigest = `sha256:${createHash('sha256')
    .update(
      `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath, projectId, workspaceDigest })}`,
    )
    .digest('hex')}`;
  const workspace = {
    workspaceId: `workspace_${workspaceIdentityDigest.slice(7)}`,
    canonicalPath,
    workspaceIdentityDigest,
    projectId,
    workspaceDigest,
    displayName: 'Validation',
  };
  database
    .query(
      `INSERT INTO workspaces(workspace_id, canonical_path, workspace_identity_digest, project_id,
      workspace_digest, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      workspace.workspaceId,
      canonicalPath,
      workspaceIdentityDigest,
      projectId,
      workspaceDigest,
      workspace.displayName,
    );
  const writer = createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema);
  const journal = createKiteHomeWorkspaceRuntimeJournal<Event, State>({
    database,
    writer,
    assertStoreSchema: assertKiteSessionStoreSchema,
    workspace,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    now: () => 100,
  });
  const queued: RuntimeStoredRun = {
    sessionId: 'session-1',
    runId: 'run-1',
    startCommandId: 'start-1',
    phase: 'building',
    status: 'queued',
    createdRevision: 1,
    lastRevision: 1,
    createdAtMs: 1_000,
  };
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
  const state = (revision: number, recoveryIdentity = 'e'.repeat(64)): State => ({
    revision,
    recoveryIdentity,
    session: { projectId, canonicalWorkspaceDigest: workspaceDigest },
  });
  journal.transactions.commitDecision({
    sessionId: 'session-1',
    events: [{ type: 'message', text: 'Fixture' }],
    metadata: [{ eventId: 'event-1', revision: 1 }],
    snapshot: state(1),
    ...(withFork
      ? { commandReceipt: receipt, runMutation: { type: 'insert' as const, run: queued } }
      : {}),
  });
  if (withFork) {
    const running: RuntimeStoredRun = { ...queued, status: 'running', startedAtMs: 1_010 };
    journal.transactions.commitAttemptStart({
      sessionId: 'session-1',
      events: [],
      snapshot: state(1),
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
    journal.transactions.commitTerminalRecovery({
      sessionId: 'session-1',
      events: [{ type: 'completed', text: '' }],
      metadata: [{ eventId: 'event-2', revision: 2 }],
      snapshot: state(2),
      runMutation: {
        type: 'transition',
        transition: {
          sessionId: 'session-1',
          runId: 'run-1',
          expectedLastRevision: 1,
          next: { ...running, status: 'completed', lastRevision: 2, finishedAtMs: 1_020 },
        },
      },
    });
    if (!journal.checkpoints.forkCurrentSession('session-1', 'session-fork', 'f'.repeat(64)))
      throw new Error('Fixture Fork failed');
  }
  const authority = createKiteSessionExecutionAuthority({ database, writer, nowMs: () => 10 });
  for (const sessionId of withFork ? ['session-1', 'session-fork'] : ['session-1']) {
    const acquired = authority.acquire({
      sessionId,
      expectedRevision: 0,
      hostInstanceId: 'host-1',
      clientId: 'client-1',
      connectionGeneration: 1,
      leaseUntilMs: 100,
    });
    if (acquired.status !== 'acquired') throw new Error('Fixture acquire failed');
    authority.release({
      sessionId,
      expectedRevision: acquired.authority.revision,
      controllerGeneration: acquired.authority.controllerGeneration,
      hostInstanceId: 'host-1',
      cleanupConfirmed: true,
    });
  }
  return {
    database,
    path: join(root, 'kite-session.sqlite'),
    [Symbol.dispose]: () => {
      database.close(false);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('Session Store offline continuity validation', () => {
  test('reads every persisted Session through production readers and counts it in the directory', () => {
    using data = fixture();
    const { database } = data;
    expect(validateKiteSessionStoreContinuity({ database, codec })).toMatchObject({
      sessions: 1,
      listedSessions: 1,
      tombstones: 0,
      events: 1,
      runs: 0,
      commandReceipts: 0,
      namedSnapshots: 0,
      forkOrigins: 0,
      recoveryRequired: 0,
    });
  });

  test('a valid JSON snapshot with a broken checksum is rejected', () => {
    using data = fixture();
    const { database } = data;
    database.query('UPDATE runtime_snapshots SET state_json = ?').run(
      JSON.stringify({
        revision: 2,
        recoveryIdentity: 'e'.repeat(64),
        session: { projectId: 'different', canonicalWorkspaceDigest: 'different' },
      }),
    );
    expect(() => validateKiteSessionStoreContinuity({ database, codec })).toThrow();
  });

  test('an event reference to a missing Artifact fails validation', () => {
    using data = fixture();
    data.database.query('UPDATE runtime_events SET event_json = ?').run(
      JSON.stringify({
        type: 'model.invocation_prepared',
        surfaceArtifact: {
          artifactId: `pa_${'a'.repeat(64)}`,
          kind: 'model_surface',
          integrityIdentifier: `sha256:${'a'.repeat(64)}`,
          byteLength: 2,
        },
      }),
    );
    expect(() => validateKiteSessionStoreContinuity({ database: data.database, codec })).toThrow();
  });

  test('production deletion becomes a tombstone and disappears from the directory', () => {
    using data = fixture();
    const owner = openKiteSessionRuntimeStorage({
      databasePath: data.path,
      codec,
      stateSchemaVersion: 27,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    try {
      const current = owner.authority.read('session-1');
      const acquired = owner.authority.acquire({
        sessionId: 'session-1',
        expectedRevision: current.revision,
        hostInstanceId: 'host-delete',
        clientId: 'client-delete',
        connectionGeneration: 2,
        leaseUntilMs: Date.now() + 60_000,
      });
      if (acquired.status !== 'acquired') throw new Error('Fixture delete acquire failed');
      const handle = owner.bindExecution(acquired.authority);
      owner.runWithExecution(handle, () => owner.storage.sessions.deleteSession('session-1'));
    } finally {
      owner.close();
    }
    expect(validateKiteSessionStoreContinuity({ database: data.database, codec })).toMatchObject({
      sessions: 0,
      listedSessions: 0,
      tombstones: 1,
    });
  });

  test('production Fork keeps a resolvable source Run after validation', () => {
    using data = fixture(true);
    expect(validateKiteSessionStoreContinuity({ database: data.database, codec })).toMatchObject({
      sessions: 2,
      listedSessions: 2,
      runs: 2,
      forkOrigins: 1,
    });
  });
});
