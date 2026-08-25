import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createInitialAgentState,
  encodeCurrentAgentStateJson,
  LEGACY_STATE26_FORMAT_EPOCH,
  LEGACY_STATE26_SCHEMA_VERSION,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
} from '@kite/agent-kernel';
import { createRuntimeHostStateStorageBinding, resolveProjectIdentity } from '@kite/runtime-host';
import {
  createSqliteRuntimeCompatibilityWriter,
  createSqliteRuntimeStorage,
  discoverSqliteRuntimeCompatibilitySource,
  SQLITE_RUNTIME_DDL,
  type SqliteRuntimeCompatibilitySession,
  sqliteCurrentRuntimeStorePath,
  sqliteRuntimeStorePath,
} from '@kite/runtime-storage-sqlite';
import {
  compatibilitySourcePaths,
  compatibleSessionList,
  createKiteRuntimeStorageOwner,
  importCompatibleKiteSession,
  prepareKiteRuntimeSessionResume,
} from '../src/bootstrap';
import { loadSession } from '../src/bootstrap/runtime/session-persistence';
import type { StateRuntimeStorage } from '../src/bootstrap/runtime/state-runtime';
import { createKiteRuntimeCompatibilityMigrator } from '../src/bootstrap/runtime/state-store-compatibility';

const EVENT = { type: 'user.message_appended', messageId: 'message-1', content: 'hello' } as const;

function checksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function currentSession(eventJson = JSON.stringify(EVENT)): SqliteRuntimeCompatibilitySession {
  const base = createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    projectId: 'project-1',
    canonicalWorkspaceDigest: `sha256:${'d'.repeat(64)}`,
    turnId: 'turn-1',
    recoveryIdentityKey: 'e'.repeat(64),
  });
  const state = { ...base, revision: 1 };
  const stateJson = encodeCurrentAgentStateJson(state);
  return {
    session: {
      sessionId: 'session-1',
      projectId: 'project-1',
      workspaceDigest: `sha256:${'d'.repeat(64)}`,
      stateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
      revision: 1,
      name: 'session name',
      updatedAt: 1,
      modelProvider: 'provider',
      modelName: 'model',
    },
    snapshot: {
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
      revision: 1,
      stateJson,
      eventPosition: 1,
      stateChecksum: 'source-checksum',
      createdAt: 1,
    },
    events: [
      {
        eventId: 'event-1',
        sequence: 1,
        schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
        eventJson,
        causationId: null,
        occurredAt: '2026-08-25T00:00:00.000Z',
        createdAt: 1,
      },
    ],
    namedSnapshots: [
      {
        name: 'turn-1',
        schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
        formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
        revision: 1,
        stateJson,
        eventPosition: 1,
        stateChecksum: 'source-checksum',
        createdAt: 1,
      },
    ],
    filePreimages: [],
  };
}

function legacySession(eventJson: string): SqliteRuntimeCompatibilitySession {
  const workspace = process.cwd();
  const identity = resolveProjectIdentity(workspace);
  const stateJson = JSON.stringify({
    schemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
    formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
    revision: 1,
    appliedEventIds: ['event-1'],
    session: {
      threadId: 'session-1',
      userId: 'user-1',
      workspace,
      projectId: 'project-1',
      canonicalWorkspaceDigest: identity.workspaceDigest,
    },
    turn: { turnId: 'turn-1', turnIndex: 1, status: 'completed' },
    transcript: { messages: [] },
    context: {
      history: [],
      autoGuard: {
        recentAutomaticCompactions: [],
        consecutiveLowGain: 0,
        disabledUntilManualAction: false,
        recoveryAttempted: false,
      },
    },
    toolRecovery: {
      schemaVersion: 1,
      identityKey: 'e'.repeat(64),
      failures: {},
      order: [],
      progressRevision: 0,
      qualityGuard: { blocked: false, observedFailures: 0 },
    },
    mode: 'accept_edits',
    workspaceAccess: 'write',
    tasks: {},
  });
  return {
    ...currentSession(eventJson),
    session: {
      ...currentSession(eventJson).session,
      projectId: 'project-1',
      workspaceDigest: identity.workspaceDigest,
      stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
      formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
    },
    snapshot: {
      ...currentSession(eventJson).snapshot,
      schemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
      formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
      stateJson,
    },
    events: currentSession(eventJson).events.map((event) => ({
      ...event,
      schemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
    })),
    namedSnapshots: [],
  };
}

function writeLegacyStore(sourcePath: string, fixture: SqliteRuntimeCompatibilitySession): void {
  const sourceDatabase = new Database(sourcePath);
  for (const ddl of SQLITE_RUNTIME_DDL) sourceDatabase.run(ddl);
  sourceDatabase.run(
    "INSERT INTO runtime_store_meta (key, value) VALUES ('format_version', '5'), ('runtime_format_epoch', ?)",
    [LEGACY_STATE26_FORMAT_EPOCH],
  );
  sourceDatabase.run(
    'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, state_schema, format_epoch, revision, name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      fixture.session.sessionId,
      fixture.session.projectId,
      fixture.session.workspaceDigest,
      LEGACY_STATE26_SCHEMA_VERSION,
      LEGACY_STATE26_FORMAT_EPOCH,
      fixture.session.revision,
      fixture.session.name,
      fixture.session.updatedAt,
    ],
  );
  sourceDatabase.run(
    'INSERT INTO runtime_snapshots (session_id, schema_version, format_epoch, revision, state_json, event_position, state_checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      fixture.session.sessionId,
      LEGACY_STATE26_SCHEMA_VERSION,
      LEGACY_STATE26_FORMAT_EPOCH,
      fixture.snapshot.revision,
      fixture.snapshot.stateJson,
      fixture.snapshot.eventPosition,
      checksum(fixture.snapshot.stateJson),
      fixture.snapshot.createdAt,
    ],
  );
  for (const event of fixture.events) {
    sourceDatabase.run(
      'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, causation_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        fixture.session.sessionId,
        event.eventId,
        event.sequence,
        LEGACY_STATE26_SCHEMA_VERSION,
        event.eventJson,
        event.causationId,
        event.occurredAt,
        event.createdAt,
      ],
    );
  }
  sourceDatabase.close();
}

describe('Kite Runtime Store compatibility composition', () => {
  test('converts one known session to current rows without changing event identity', () => {
    const codec = createRuntimeHostStateStorageBinding().codec;
    const migrate = createKiteRuntimeCompatibilityMigrator(codec);
    const result = migrate(currentSession(), {
      storeSchemaVersion: 5,
      stateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
    });
    expect(result).not.toBeNull();
    expect(result?.events).toEqual([
      expect.objectContaining({
        eventId: 'event-1',
        sequence: 1,
        schemaVersion: 27,
        eventJson: JSON.stringify(EVENT),
      }),
    ]);
    expect(result?.namedSnapshots).toHaveLength(1);
    expect(result?.stateJson).toContain('kite-runtime-saq-v1-2026-08-25');
  });

  test('fails only the selected session instead of dropping an invalid named recovery point', () => {
    const codec = createRuntimeHostStateStorageBinding().codec;
    const migrate = createKiteRuntimeCompatibilityMigrator(codec);
    const fixture = currentSession();
    const named = fixture.namedSnapshots[0]!;
    const namedState = JSON.parse(named.stateJson) as {
      session: { threadId: string };
    };
    namedState.session.threadId = 'other-session';

    expect(
      migrate(
        {
          ...fixture,
          namedSnapshots: [{ ...named, stateJson: JSON.stringify(namedState) }],
        },
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
          formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
        },
      ),
    ).toBeNull();
  });

  test('drops State 26 file-effect history and rejects unsafe current preimage paths', () => {
    const migrate = createKiteRuntimeCompatibilityMigrator(
      createRuntimeHostStateStorageBinding().codec,
    );
    const preimage = {
      path: '/outside/workspace.txt',
      eventPosition: 1,
      content: 'before',
      existed: true,
      postHash: null,
      postExisted: null,
      createdAt: 1,
    } as const;
    const legacy = legacySession(JSON.stringify(EVENT));
    expect(
      migrate(
        { ...legacy, filePreimages: [preimage] },
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
          formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
        },
      )?.filePreimages,
    ).toEqual([]);

    const current = currentSession();
    expect(
      migrate(
        {
          ...current,
          filePreimages: [{ ...preimage, path: '../workspace.txt' }],
        },
        {
          storeSchemaVersion: 5,
          stateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
          formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
        },
      ),
    ).toBeNull();
  });

  test('keeps a known legacy session readable by reducing an unknown event to a no-op', () => {
    const migrate = createKiteRuntimeCompatibilityMigrator(
      createRuntimeHostStateStorageBinding().codec,
    );
    const result = migrate(legacySession(JSON.stringify({ type: 'future.event' })), {
      storeSchemaVersion: 5,
      stateSchemaVersion: LEGACY_STATE26_SCHEMA_VERSION,
      formatEpoch: LEGACY_STATE26_FORMAT_EPOCH,
    });
    expect(result?.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        eventJson: JSON.stringify({
          type: 'runtime.action_ignored',
          reason: 'legacy_unknown_event_compatibility',
        }),
      }),
    ]);
  });

  test('imports one State 26 SQLite session and restores it through the current Host codec', () => {
    const directory = mkdtempSync(join(process.cwd(), '.kite-app-compat-'));
    const sourcePath = join(directory, 'legacy.db');
    const targetPath = join(directory, 'current.db');
    try {
      const fixture = legacySession(JSON.stringify(EVENT));
      writeLegacyStore(sourcePath, fixture);
      const sourceBytes = readFileSync(sourcePath);

      const source = discoverSqliteRuntimeCompatibilitySource(sourcePath);
      const writer = createSqliteRuntimeCompatibilityWriter({ databasePath: targetPath });
      expect(source).not.toBeNull();
      expect(
        writer.importSession(
          source!,
          fixture.session.sessionId,
          createKiteRuntimeCompatibilityMigrator(createRuntimeHostStateStorageBinding().codec),
        ),
      ).toMatchObject({ status: 'imported' });
      writer.close();
      source?.close();
      expect(readFileSync(sourcePath)).toEqual(sourceBytes);

      const codec = createRuntimeHostStateStorageBinding().codec;
      const current = createSqliteRuntimeStorage({
        databasePath: targetPath,
        codec,
        sessionId: fixture.session.sessionId,
      });
      const restored = current.sessions.loadSnapshot(fixture.session.sessionId);
      expect(restored).toMatchObject({
        schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
        formatEpoch: RUNTIME_STATE_FORMAT_EPOCH,
        mode: 'accept_edits',
        activeApprovalId: null,
      });
      expect(current.sessions.loadEventsStrict(fixture.session.sessionId)).toHaveLength(1);
      expect(current.sessions.listSessions()).toEqual([
        expect.objectContaining({
          threadId: fixture.session.sessionId,
          name: fixture.session.name,
        }),
      ]);
      current.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('discovers, lazily imports, and durably suppresses a source session through App paths', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.kite-app-catalog-'));
    const checkpointPath = join(directory, 'checkpoints.sqlite');
    const sourcePath = sqliteRuntimeStorePath(checkpointPath);
    const targetPath = sqliteCurrentRuntimeStorePath(checkpointPath);
    const fixture = legacySession(JSON.stringify(EVENT));
    try {
      writeLegacyStore(sourcePath, fixture);
      const sourceBytes = readFileSync(sourcePath);
      expect(targetPath).not.toBe(sourcePath);
      expect(compatibilitySourcePaths(checkpointPath)).toContain(sourcePath);
      expect(compatibleSessionList(checkpointPath)).toEqual([
        expect.objectContaining({
          threadId: fixture.session.sessionId,
          name: fixture.session.name,
        }),
      ]);

      expect(importCompatibleKiteSession(checkpointPath, fixture.session.sessionId)).toMatchObject({
        status: 'imported',
      });
      const loadOwner = createKiteRuntimeStorageOwner(checkpointPath);
      await expect(
        loadSession(
          () => loadOwner.storage as unknown as StateRuntimeStorage,
          fixture.session.sessionId,
          'e'.repeat(64),
        ),
      ).resolves.toMatchObject({
        threadId: fixture.session.sessionId,
        interactionMode: 'accept_edits',
      });
      const owner = createKiteRuntimeStorageOwner(checkpointPath);
      expect(owner.storage.sessions.loadSnapshot(fixture.session.sessionId)).toMatchObject({
        schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      });
      expect(owner.storage.sessions.listSessions()).toHaveLength(1);
      owner.storage.sessions.setSessionName(fixture.session.sessionId, 'renamed current');
      expect(owner.storage.sessions.listSessions('session name')).toEqual([]);
      expect(owner.storage.sessions.listSessions('renamed current')).toEqual([
        expect.objectContaining({ threadId: fixture.session.sessionId }),
      ]);
      owner.storage.sessions.deleteSession(fixture.session.sessionId);
      expect(owner.storage.sessions.listSessions()).toEqual([]);
      owner.storage.close();

      // A normal restart opens the current generation before /resume
      // discovery, allowing SQLite to reconcile any retained WAL state.
      const restarted = createKiteRuntimeStorageOwner(checkpointPath);
      expect(restarted.storage.sessions.listSessions()).toEqual([]);
      expect(compatibleSessionList(checkpointPath)).toEqual([]);
      expect(importCompatibleKiteSession(checkpointPath, fixture.session.sessionId)).toMatchObject({
        status: 'ignored',
      });
      restarted.storage.close();
      expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('lazily imports through an already-open Runtime owner before restoring the session', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.kite-app-live-import-'));
    const checkpointPath = join(directory, 'checkpoints.sqlite');
    const sourcePath = sqliteRuntimeStorePath(checkpointPath);
    const fixture = legacySession(JSON.stringify(EVENT));
    try {
      writeLegacyStore(sourcePath, fixture);
      const owner = createKiteRuntimeStorageOwner(checkpointPath);

      // TUI startup opens the current Store before /resume. The selected
      // historical row must still become visible on that same long-lived
      // owner immediately after the independent compatibility transaction.
      expect(owner.storage.sessions.listSessions()).toEqual([
        expect.objectContaining({ threadId: fixture.session.sessionId }),
      ]);
      expect(owner.storage.sessions.loadSnapshot(fixture.session.sessionId)).toMatchObject({
        schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      });
      owner.storage.close();

      const restoredOwner = createKiteRuntimeStorageOwner(checkpointPath);
      await expect(
        loadSession(
          () => restoredOwner.storage as unknown as StateRuntimeStorage,
          fixture.session.sessionId,
          'e'.repeat(64),
        ),
      ).resolves.toMatchObject({
        threadId: fixture.session.sessionId,
        interactionMode: 'accept_edits',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('refuses a malformed explicit CLI resume without creating an empty target session', () => {
    const directory = mkdtempSync(join(process.cwd(), '.kite-cli-compat-'));
    const checkpointPath = join(directory, 'checkpoints.sqlite');
    const sourcePath = sqliteRuntimeStorePath(checkpointPath);
    const targetPath = sqliteCurrentRuntimeStorePath(checkpointPath);
    try {
      const fixture = legacySession('{not-json');
      writeLegacyStore(sourcePath, fixture);

      expect(prepareKiteRuntimeSessionResume(checkpointPath, fixture.session.sessionId)).toBe(
        'failed',
      );
      const target = new Database(targetPath, { readonly: true });
      expect(target.query('SELECT COUNT(*) AS count FROM runtime_sessions').get()).toEqual({
        count: 0,
      });
      target.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
