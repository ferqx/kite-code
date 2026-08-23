import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeStorageV5,
  SQLITE_RUNTIME_FORMAT_EPOCH_V2,
  sqliteRuntimeStorePathForV2,
} from '@kite/runtime-storage-sqlite';
import {
  createTestWorkspace,
  observePersistedCommandSession,
  observePersistedSessionIds,
  observePersistedSessionSummaries,
  observePersistedTurnEvents,
  type TestWorkspace,
} from './test-workspace';

function writeStoreObserverFixture(
  databasePath: string,
  sessionId: string,
  events: readonly Record<string, unknown>[],
  name = '',
) {
  type State = {
    schemaVersion: 26;
    formatEpoch: string;
    revision: number;
    session: {
      threadId: string;
      projectId: string;
      canonicalWorkspaceDigest: string;
    };
  };
  const storage = createSqliteRuntimeStorageV5<Record<string, unknown>, State>({
    databasePath,
    codec: {
      encodeEvent: JSON.stringify,
      decodeEvent: JSON.parse,
      encodeState: JSON.stringify,
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: (state) => ({ stateRevision: state.revision, schemaVersion: 26 }),
      sessionIdentity: (state) => ({
        projectId: state.session.projectId,
        canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
      }),
      rebindForkState: (state, targetSessionId) => ({
        ...state,
        session: { ...state.session, threadId: targetSessionId },
      }),
    },
    options: { journalMode: 'delete' },
  });
  storage.transactions.commitDecision({
    sessionId,
    events,
    snapshot: {
      schemaVersion: 26,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision: events.length,
      session: {
        threadId: sessionId,
        projectId: `project_${sessionId}`,
        canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
      },
    },
    metadata: events.map((_event, index) => ({
      eventId: `${sessionId}:event:${index + 1}`,
      revision: index + 1,
    })),
  });
  if (name) storage.sessions.setSessionName(sessionId, name);
  return storage;
}

describe('TUI persisted Runtime observers', () => {
  let workspace: TestWorkspace | undefined;

  afterEach(() => {
    workspace?.cleanup();
    workspace = undefined;
  });

  test('reports an uninitialized isolated workspace as not yet persisted', () => {
    workspace = createTestWorkspace();

    expect(observePersistedSessionIds(workspace)).toMatchObject({ status: 'not_created' });
    expect(observePersistedSessionSummaries(workspace)).toMatchObject({
      status: 'not_created',
    });
    expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
      status: 'not_created',
    });
    expect(observePersistedTurnEvents(workspace, 'turn marker')).toMatchObject({
      status: 'not_created',
    });
  });

  test('fails fast when the Runtime database path is a directory', () => {
    workspace = createTestWorkspace();
    const runtimePath = sqliteRuntimeStorePathForV2(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    mkdirSync(runtimePath);

    expect(() => observePersistedSessionIds(workspace!)).toThrow(
      'Failed to observe isolated Runtime Store',
    );
  });

  test('treats an existing database without Runtime schema as not ready', () => {
    workspace = createTestWorkspace();
    const runtimePath = sqliteRuntimeStorePathForV2(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    new Database(runtimePath).close();

    expect(observePersistedSessionIds(workspace)).toMatchObject({ status: 'initializing' });
    expect(observePersistedSessionSummaries(workspace)).toMatchObject({ status: 'initializing' });
    expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
      status: 'initializing',
    });
    expect(observePersistedTurnEvents(workspace, 'turn marker')).toMatchObject({
      status: 'initializing',
    });
  });

  test('fails fast when the Runtime database is corrupt', () => {
    workspace = createTestWorkspace();
    const runtimePath = sqliteRuntimeStorePathForV2(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    writeFileSync(runtimePath, 'not a sqlite database');

    expect(() => observePersistedSessionSummaries(workspace!)).toThrow(
      'Failed to observe isolated Runtime Store',
    );
  });

  test('reads exact persistence evidence without competing with the child writer', () => {
    workspace = createTestWorkspace();
    const runtimePath = sqliteRuntimeStorePathForV2(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    const store = writeStoreObserverFixture(
      runtimePath,
      'thread-a',
      [
        {
          type: 'user.command_invoked',
          commandId: 'command-a',
          command: '/compact marker',
        },
        {
          type: 'user.message_appended',
          messageId: 'message-a',
          content: 'turn marker',
        },
        { type: 'turn.started', turnId: 'turn-a' },
        {
          type: 'completion.blocked',
          turnId: 'turn-a',
          guardVersion: 'completion_guard_v1',
          code: 'plan_draft_pending',
          nextAction: 'submit_plan',
          planning: 'planning_draft',
          correctionAttempt: 1,
        },
        { type: 'model.requested', requestId: 'correction-request-a' },
        {
          type: 'run.completed',
          turnId: 'turn-a',
          output: 'completed',
          completionGuardVersion: 'completion_guard_v1',
        },
        { type: 'turn.completed', turnId: 'turn-a' },
      ],
      'Command session',
    );
    store.close();

    // BEGIN IMMEDIATE holds the single writer slot. A harness observer that
    // reran RuntimeStore initialization would contend here; readonly queries
    // must remain available while the real child owns that slot.
    const writer = new Database(runtimePath);
    writer.run('PRAGMA journal_mode = WAL');
    writer.run('BEGIN IMMEDIATE');
    try {
      expect(observePersistedSessionIds(workspace)).toMatchObject({
        status: 'ready',
        value: ['thread-a'],
      });
      expect(observePersistedSessionSummaries(workspace)).toMatchObject({
        status: 'ready',
        value: [{ threadId: 'thread-a', name: 'Command session' }],
      });
      expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
        status: 'ready',
        value: { threadId: 'thread-a', name: 'Command session' },
      });
      expect(observePersistedCommandSession(workspace, '/compact other')).toMatchObject({
        status: 'ready',
        value: undefined,
      });
      expect(observePersistedTurnEvents(workspace, 'turn marker')).toMatchObject({
        status: 'ready',
        value: {
          threadId: 'thread-a',
          turnId: 'turn-a',
          events: [
            { type: 'turn.started', turnId: 'turn-a' },
            {
              type: 'completion.blocked',
              turnId: 'turn-a',
              code: 'plan_draft_pending',
              correctionAttempt: 1,
            },
            { type: 'model.requested', requestId: 'correction-request-a' },
            { type: 'run.completed', turnId: 'turn-a' },
            { type: 'turn.completed', turnId: 'turn-a' },
          ],
        },
      });
    } finally {
      writer.run('ROLLBACK');
      writer.close();
    }
  });

  test('matches RuntimeStore name fallback when the first user message is empty', () => {
    workspace = createTestWorkspace();
    const runtimePath = sqliteRuntimeStorePathForV2(
      join(workspace.home, '.kite-code', 'checkpoints.sqlite'),
    );
    const store = writeStoreObserverFixture(runtimePath, 'thread-empty', [
      {
        type: 'user.message_appended',
        messageId: 'message-empty',
        content: '',
      },
      {
        type: 'user.command_invoked',
        commandId: 'command-empty',
        command: '/compact empty',
      },
    ]);
    try {
      expect(observePersistedSessionSummaries(workspace)).toMatchObject({
        status: 'ready',
        value: [{ threadId: 'thread-empty', name: 'thread-empty' }],
      });
      expect(observePersistedCommandSession(workspace, '/compact empty')).toMatchObject({
        status: 'ready',
        value: { threadId: 'thread-empty', name: 'thread-empty' },
      });
    } finally {
      store.close();
    }
  });
});
