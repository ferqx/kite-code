import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import {
  createSqliteRuntimeStorage,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  resolveSqliteRuntimeLayoutPaths,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  sqliteRuntimeStoreDigest,
  writeSqliteActiveLayoutPointer,
  writeSqliteRuntimeLayoutManifest,
  writeSqliteRuntimeMigrationFence,
  writeSqliteRuntimeMigrationJournal,
} from '../src/index';
import { initializeSqliteRuntimeSchema } from '../src/schema';

type Event = { readonly type: string };
type State = {
  readonly schemaVersion: number;
  readonly formatEpoch: string;
  readonly revision: number;
  readonly session: {
    readonly threadId: string;
    readonly projectId: string;
    readonly canonicalWorkspaceDigest: string;
  };
};

const binding = {
  layoutGeneration: 'generation-create',
  workerScopeId: 'worker-scope-create',
  workspaceIdentityDigest: 'e'.repeat(64),
} as const;

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  snapshotMetadata: (state: State) => ({
    stateRevision: state.revision,
    schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  rebindForkState: (state: State, sessionId: string) => ({
    ...state,
    session: { ...state.session, threadId: sessionId },
  }),
};

function digest(letter: string): string {
  return letter.repeat(64);
}

function secret(seed: number): string {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 37) % 256);
  return Buffer.from(bytes).toString('base64url');
}

function createFixture(): {
  readonly root: string;
  readonly path: string;
  readonly layout: ReturnType<typeof resolveSqliteRuntimeLayoutPaths>;
  readonly storage: ReturnType<typeof createSqliteRuntimeStorage<Event, State>>;
  cleanup(): void;
} {
  const root = mkdtempSync(join(process.cwd(), '.kite-session-create-'));
  const layout = resolveSqliteRuntimeLayoutPaths(join(root, 'home'));
  ensureSqliteRuntimeLayoutRoot(layout.root);
  ensureSqliteRuntimeGenerationRoot(layout, binding.layoutGeneration);
  const path = ensureSqliteWorkspaceStoreDirectory(
    layout,
    binding.layoutGeneration,
    binding.workerScopeId,
  );
  const database = new Database(path);
  initializeSqliteRuntimeSchema(database, {
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: 7,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    workspaceBinding: binding,
  });
  database.close();
  chmodSync(path, 0o600);
  const digestValue = sqliteRuntimeStoreDigest(path);
  writeSqliteRuntimeMigrationJournal(layout, {
    schema: 'kite.runtime-migration-journal.v1',
    sourceStoreIdentity: 'source-create',
    sourceStoreDigest: digestValue,
    sourceProfile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: 6,
      formatEpoch: 'kite-runtime-server-v1-2026-08-26',
    },
    targetLayoutGeneration: binding.layoutGeneration,
    targetCatalogDigest: digestValue,
    workspaceStoreDigests: [{ workerScopeId: binding.workerScopeId, digest: digestValue }],
    pointerPhase: 'committed',
    targetWriteState: 'none',
    migrationNonce: 'nonce-create',
  });
  writeSqliteRuntimeMigrationFence(layout, {
    schema: 'kite.runtime-migration-fence.v1',
    sourceStoreIdentity: 'source-create',
    sourceStoreDigest: digestValue,
    sourceProfile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: 6,
      formatEpoch: 'kite-runtime-server-v1-2026-08-26',
    },
    targetLayoutGeneration: binding.layoutGeneration,
    migrationNonce: 'nonce-create',
    state: 'active',
  });
  writeSqliteRuntimeLayoutManifest(layout, {
    schema: 'kite.runtime-layout-manifest.v1',
    generation: binding.layoutGeneration,
    profile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: 7,
      formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    },
    catalogDigest: digestValue,
    workspaceStores: [{ workerScopeId: binding.workerScopeId, digest: digestValue }],
  });
  writeSqliteActiveLayoutPointer(layout, {
    schema: 'kite.runtime-active-layout.v1',
    generation: binding.layoutGeneration,
  });
  const storage = createSqliteRuntimeStorage<Event, State>({
    databasePath: path,
    codec,
    workspaceBinding: binding,
    workspaceLayout: layout,
    options: { journalMode: 'delete' },
  });
  return {
    root,
    path,
    layout,
    storage,
    cleanup: () => {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createInput(sessionId: string, commandLetter: string, controllerLetter: string) {
  const commandReceipt = createRuntimeStoredCommandReceipt(
    {
      scopeSessionId: sessionId,
      commandId: `command-${commandLetter}`,
      requestDigest: digest(commandLetter),
      targetSessionId: sessionId,
      committedAt: 1_000,
    },
    0,
  );
  const snapshot: State = {
    schemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    revision: 0,
    session: {
      threadId: sessionId,
      projectId: 'project-create',
      canonicalWorkspaceDigest: 'sha256:create-workspace',
    },
  };
  return {
    runtime: {
      sessionId,
      events: [],
      snapshot,
      commandReceipt,
    },
    controller: {
      sessionId,
      requestId: `controller-${controllerLetter}`,
      requestDigest: digest(controllerLetter),
      clientId: 'client-create',
      connectionGeneration: 1,
      workerInstanceId: 'worker-create',
      resumeSecret: secret(17),
      resumeExpiresAtMs: Date.now() + 60_000,
    },
  } as const;
}

describe('Store 7 atomic session creation', () => {
  test('commits Runtime facts and generation-one Controller lease together and replays', () => {
    const fixture = createFixture();
    try {
      const input = createInput('session-created', 'a', 'b');
      const first = fixture.storage.workspaceSessionCreation?.create(input);
      expect(first).toMatchObject({
        status: 'applied',
        runtimeReceipt: {
          targetSessionId: 'session-created',
          committedRevision: 0,
        },
        controller: {
          status: 'applied',
          receipt: { operation: 'request_control', code: 'acquired', controllerGeneration: 1 },
          lease: { controllerGeneration: 1, clientId: 'client-create' },
        },
      });
      expect(fixture.storage.sessions.loadSnapshot<State>('session-created')).toEqual(
        input.runtime.snapshot,
      );
      expect(fixture.storage.workspaceAuthority?.controller.lease('session-created')).toMatchObject(
        {
          controllerGeneration: 1,
          clientId: 'client-create',
        },
      );
      expect(
        fixture.storage.commandReceipts.lookup({
          scopeSessionId: 'session-created',
          commandId: 'command-a',
          requestDigest: digest('a'),
        }),
      ).toMatchObject({ status: 'replay' });

      const replay = fixture.storage.workspaceSessionCreation?.create(input);
      expect(replay).toMatchObject({
        status: 'replay',
        controller: { status: 'replay', receipt: { controllerGeneration: 1 } },
      });
      expect(fixture.storage.workspaceAuthority?.controller.read('session-created')).toMatchObject({
        status: 'active',
        controllerGeneration: 1,
      });
      const metadataDatabase = new Database(fixture.path, { readonly: true });
      const metadata = metadataDatabase
        .query<{ value: string }, []>('SELECT value FROM runtime_store_meta ORDER BY key')
        .all()
        .map((row) => row.value)
        .join('\n');
      expect(metadata).not.toContain(input.controller.resumeSecret);
      metadataDatabase.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('rolls back Runtime writes when Controller initialization fails', () => {
    const fixture = createFixture();
    try {
      const input = createInput('session-rollback', 'c', 'd');
      const invalid = {
        ...input,
        controller: { ...input.controller, resumeSecret: 'invalid' },
      };
      expect(() => fixture.storage.workspaceSessionCreation?.create(invalid)).toThrow();
      expect(fixture.storage.sessions.loadSnapshot('session-rollback')).toBeNull();
      expect(
        fixture.storage.commandReceipts.lookup({
          scopeSessionId: 'session-rollback',
          commandId: 'command-c',
          requestDigest: digest('c'),
        }),
      ).toEqual({ status: 'missing' });
      const database = new Database(fixture.path, { readonly: true });
      expect(
        database
          .query<{ count: number }, [string]>(
            'SELECT COUNT(*) AS count FROM runtime_store_meta WHERE key LIKE ?',
          )
          .get('workspace_authority_v1:%session-rollback%'),
      ).toEqual({ count: 0 });
      database.close();
    } finally {
      fixture.cleanup();
    }
  });
});
