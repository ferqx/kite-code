import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeStorage,
  createSqliteWorkspaceAuthority,
  ensureSqliteRuntimeGenerationRoot,
  ensureSqliteRuntimeLayoutRoot,
  ensureSqliteWorkspaceStoreDirectory,
  markSqliteWorkspaceStoreWritten,
  readSqliteRuntimeMigrationJournal,
  resolveSqliteRuntimeLayoutPaths,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
  SqliteRuntimeFormatMismatchError,
  SqliteWorkspaceAuthorityError,
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
  layoutGeneration: 'generation-authority',
  workerScopeId: 'worker-scope-authority',
  workspaceIdentityDigest: 'd'.repeat(64),
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

function fixture(): {
  readonly root: string;
  readonly path: string;
  readonly layout: ReturnType<typeof resolveSqliteRuntimeLayoutPaths>;
  readonly clock: { value: number };
  readonly storage: ReturnType<typeof createSqliteRuntimeStorage<Event, State>>;
  cleanup(): void;
} {
  const root = mkdtempSync(join(process.cwd(), '.kite-authority-'));
  const layout = resolveSqliteRuntimeLayoutPaths(join(root, 'home'));
  ensureSqliteRuntimeLayoutRoot(layout.root);
  ensureSqliteRuntimeGenerationRoot(layout, binding.layoutGeneration);
  const path = ensureSqliteWorkspaceStoreDirectory(
    layout,
    binding.layoutGeneration,
    binding.workerScopeId,
  );
  const target = new Database(path);
  initializeSqliteRuntimeSchema(target, {
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: 7,
    formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    workspaceBinding: binding,
  });
  target
    .query(
      'INSERT INTO runtime_sessions (session_id, project_id, workspace_digest, worker_scope_id, workspace_identity_digest, state_schema, format_epoch, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'session-authority',
      'project-authority',
      'sha256:workspace-authority',
      binding.workerScopeId,
      binding.workspaceIdentityDigest,
      SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
      1,
    );
  target.close();
  chmodSync(path, 0o600);
  publishActiveLayout(layout, path);
  const storage = createSqliteRuntimeStorage<Event, State>({
    databasePath: path,
    codec,
    workspaceBinding: binding,
    workspaceLayout: layout,
    options: { journalMode: 'delete' },
  });
  storage.close();
  const clock = { value: 1_000 };
  return {
    root,
    path,
    layout,
    clock,
    storage,
    cleanup: () => {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function publishActiveLayout(
  layout: ReturnType<typeof resolveSqliteRuntimeLayoutPaths>,
  databasePath: string,
): void {
  const digest = sqliteRuntimeStoreDigest(databasePath);
  const journal = {
    schema: 'kite.runtime-migration-journal.v1' as const,
    sourceStoreIdentity: 'source-authority',
    sourceStoreDigest: digest,
    sourceProfile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: 6,
      formatEpoch: 'kite-runtime-server-v1-2026-08-26',
    },
    targetLayoutGeneration: binding.layoutGeneration,
    targetCatalogDigest: digest,
    workspaceStoreDigests: [{ workerScopeId: binding.workerScopeId, digest }],
    pointerPhase: 'committed' as const,
    targetWriteState: 'none' as const,
    migrationNonce: 'authority-migration',
  };
  const fence = {
    schema: 'kite.runtime-migration-fence.v1' as const,
    sourceStoreIdentity: journal.sourceStoreIdentity,
    sourceStoreDigest: journal.sourceStoreDigest,
    sourceProfile: journal.sourceProfile,
    targetLayoutGeneration: journal.targetLayoutGeneration,
    migrationNonce: journal.migrationNonce,
    state: 'active' as const,
  };
  writeSqliteRuntimeMigrationJournal(layout, journal);
  writeSqliteRuntimeMigrationFence(layout, fence);
  writeSqliteRuntimeLayoutManifest(layout, {
    schema: 'kite.runtime-layout-manifest.v1',
    generation: binding.layoutGeneration,
    profile: {
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      storeSchemaVersion: 7,
      formatEpoch: SQLITE_RUNTIME_WORKSPACE_FORMAT_EPOCH,
    },
    catalogDigest: digest,
    workspaceStores: [{ workerScopeId: binding.workerScopeId, digest }],
  });
  writeSqliteActiveLayoutPointer(layout, {
    schema: 'kite.runtime-active-layout.v1',
    generation: binding.layoutGeneration,
  });
}

function operationBase(requestId: string, requestDigest: string) {
  return {
    sessionId: 'session-authority',
    requestId,
    requestDigest,
  } as const;
}

function controllerLease(
  overrides: Partial<{
    sessionId: string;
    clientId: string;
    connectionGeneration: number;
    controllerGeneration: number;
    workerInstanceId: string;
  }> = {},
) {
  return {
    sessionId: 'session-authority',
    clientId: 'client-1',
    connectionGeneration: 1,
    controllerGeneration: 1,
    workerInstanceId: 'worker-1',
    ...overrides,
  } as const;
}

describe('Store 7 Worker authority facade', () => {
  test('atomically acquires, detaches, resumes with rotation, and replays after reopen', () => {
    const testFixture = fixture();
    expect(readSqliteRuntimeMigrationJournal(testFixture.layout)?.targetWriteState).toBe('none');
    markSqliteWorkspaceStoreWritten(testFixture.layout, binding, testFixture.path);
    const authorityDatabase = new Database(testFixture.path);
    try {
      const authority = createSqliteWorkspaceAuthority({
        db: authorityDatabase,
        binding,
        nowMs: () => testFixture.clock.value,
      });
      const firstSecret = secret(1);
      const secondSecret = secret(2);
      const acquired = authority.controller.requestControl({
        ...operationBase('request-1', digest('a')),
        clientId: 'client-1',
        connectionGeneration: 1,
        workerInstanceId: 'worker-1',
        resumeSecret: firstSecret,
        resumeExpiresAtMs: 2_000,
      });
      expect(acquired).toMatchObject({ status: 'applied', receipt: { code: 'acquired' } });
      expect(authority.controller.lease('session-authority')).toMatchObject({
        clientId: 'client-1',
        controllerGeneration: 1,
        connectionGeneration: 1,
      });
      expect(
        authority.controller.requestControl({
          ...operationBase('request-1', digest('a')),
          clientId: 'client-1',
          connectionGeneration: 1,
          workerInstanceId: 'worker-1',
          resumeSecret: firstSecret,
          resumeExpiresAtMs: 2_000,
        }),
      ).toMatchObject({ status: 'replay' });
      expect(() =>
        authority.controller.requestControl({
          ...operationBase('request-1', digest('b')),
          clientId: 'client-1',
          connectionGeneration: 1,
          workerInstanceId: 'worker-1',
          resumeSecret: firstSecret,
          resumeExpiresAtMs: 2_000,
        }),
      ).toThrow(SqliteWorkspaceAuthorityError);
      expect(
        authority.controller.requestControl({
          ...operationBase('request-2', digest('c')),
          clientId: 'client-2',
          connectionGeneration: 1,
          workerInstanceId: 'worker-1',
          resumeSecret: secondSecret,
          resumeExpiresAtMs: 2_000,
        }),
      ).toMatchObject({ status: 'rejected', receipt: { code: 'controller_busy' } });

      expect(
        authority.controller.validateResumeCapability({
          sessionId: 'session-authority',
          clientId: 'client-1',
          controllerGeneration: 1,
          secret: firstSecret,
          nowMs: 1_500,
        }),
      ).toMatchObject({ status: 'valid' });
      expect(
        authority.controller.detachController({
          ...operationBase('detach-1', digest('d')),
          sessionId: 'session-authority',
          clientId: 'client-1',
          connectionGeneration: 1,
          controllerGeneration: 1,
          workerInstanceId: 'worker-1',
          interactionGeneration: 9,
        }),
      ).toMatchObject({ status: 'applied', receipt: { code: 'detached' } });
      expect(authority.controller.readRecovery('session-authority')).toMatchObject({
        status: 'detached',
        interactionGeneration: 9,
      });
      expect(
        authority.controller.resumeController({
          ...operationBase('resume-1', digest('e')),
          clientId: 'client-1',
          controllerGeneration: 1,
          connectionGeneration: 2,
          workerInstanceId: 'worker-2',
          currentSecret: firstSecret,
          nextSecret: secondSecret,
          expiresAtMs: 3_000,
        }),
      ).toMatchObject({ status: 'applied', receipt: { code: 'resumed' } });
      expect(
        authority.controller.validateResumeCapability({
          sessionId: 'session-authority',
          clientId: 'client-1',
          controllerGeneration: 1,
          secret: firstSecret,
          nowMs: 2_000,
        }),
      ).toMatchObject({ status: 'invalid' });
      expect(
        authority.controller.validateResumeCapability({
          sessionId: 'session-authority',
          clientId: 'client-1',
          controllerGeneration: 1,
          secret: secondSecret,
          nowMs: 2_000,
        }),
      ).toMatchObject({ status: 'valid', connectionGeneration: 2 });

      const database = new Database(testFixture.path, { readonly: true });
      const metadata = database
        .query<{ value: string }, []>('SELECT value FROM runtime_store_meta ORDER BY key')
        .all()
        .map((row) => row.value)
        .join('\n');
      expect(metadata).not.toContain(firstSecret);
      expect(metadata).not.toContain(secondSecret);
      database.close();
      authorityDatabase.close();
      testFixture.storage.close();

      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: testFixture.path,
        codec,
        workspaceBinding: binding,
        workspaceLayout: testFixture.layout,
        options: { journalMode: 'delete' },
      });
      const reopenedAuthority = reopened.workspaceAuthority!;
      expect(
        reopenedAuthority.controller.validateResumeCapability({
          sessionId: 'session-authority',
          clientId: 'client-1',
          controllerGeneration: 1,
          secret: secondSecret,
          nowMs: 2_000,
        }),
      ).toMatchObject({ status: 'valid' });
      expect(
        reopenedAuthority.controller.releaseControl({
          ...operationBase('release-1', digest('f')),
          sessionId: 'session-authority',
          clientId: 'client-1',
          connectionGeneration: 2,
          controllerGeneration: 1,
          workerInstanceId: 'worker-2',
        }),
      ).toMatchObject({ status: 'applied', receipt: { code: 'released' } });
      expect(reopenedAuthority.controller.lease('session-authority')).toBeNull();
      expect(readSqliteRuntimeMigrationJournal(testFixture.layout)?.targetWriteState).toBe(
        'written',
      );
      reopened.close();
    } finally {
      try {
        authorityDatabase.close();
      } catch {
        // The first assertion may have failed before the authority was closed.
      }
      testFixture.cleanup();
    }
  });

  test('requires confirmed absent detached recovery and consumes its capability once', () => {
    const testFixture = fixture();
    try {
      const authority = createSqliteWorkspaceAuthority({
        db: new Database(testFixture.path),
        binding,
        nowMs: () => testFixture.clock.value,
      });
      const resume = secret(3);
      const recovery = secret(4);
      authority.controller.requestControl({
        ...operationBase('request-3', digest('1')),
        clientId: 'client-1',
        connectionGeneration: 1,
        workerInstanceId: 'worker-1',
        resumeSecret: resume,
        resumeExpiresAtMs: 4_000,
      });
      authority.controller.detachController({
        ...operationBase('detach-2', digest('2')),
        sessionId: 'session-authority',
        clientId: 'client-1',
        connectionGeneration: 1,
        controllerGeneration: 1,
        workerInstanceId: 'worker-1',
        interactionGeneration: 11,
      });
      expect(() =>
        authority.controller.mintDetachedRecoveryCapability({
          ...operationBase('mint-1', digest('3')),
          clientId: 'observer-1',
          connectionGeneration: 2,
          workerInstanceId: 'worker-2',
          expectedControllerGeneration: 1,
          expectedInteractionGeneration: 11,
          expiresAtMs: 3_000,
          connectionConfirmedAbsent: false,
          absenceEvidenceDigest: digest('4'),
          secret: recovery,
        }),
      ).toThrow(SqliteWorkspaceAuthorityError);
      expect(
        authority.controller.mintDetachedRecoveryCapability({
          ...operationBase('mint-1', digest('3')),
          clientId: 'observer-1',
          connectionGeneration: 2,
          workerInstanceId: 'worker-2',
          expectedControllerGeneration: 1,
          expectedInteractionGeneration: 11,
          expiresAtMs: 3_000,
          connectionConfirmedAbsent: true,
          absenceEvidenceDigest: digest('4'),
          secret: recovery,
        }),
      ).toMatchObject({ status: 'applied' });
      expect(
        authority.controller.abandonDetachedController({
          ...operationBase('abandon-1', digest('5')),
          sessionId: 'session-authority',
          clientId: 'observer-1',
          connectionGeneration: 2,
          workerInstanceId: 'worker-2',
          expectedControllerGeneration: 1,
          expectedInteractionGeneration: 11,
          connectionConfirmedAbsent: true,
          secret: recovery,
        }),
      ).toMatchObject({ status: 'applied', receipt: { code: 'abandoned' } });
      expect(authority.controller.read('session-authority')).toMatchObject({ status: 'idle' });
      const database = new Database(testFixture.path, { readonly: true });
      const recoveryValue = database
        .query<{ value: string }, [string]>('SELECT value FROM runtime_store_meta WHERE key LIKE ?')
        .get('workspace_authority_v1:detached-recovery:%')?.value;
      expect(recoveryValue).toContain('"state":"consumed"');
      expect(recoveryValue).not.toContain(recovery);
      database.close();
    } finally {
      testFixture.cleanup();
    }
  });

  test('persists effect terminal evidence and records external resource lease evidence without acquiring it', () => {
    const testFixture = fixture();
    try {
      const authority = createSqliteWorkspaceAuthority({
        db: new Database(testFixture.path),
        binding,
        nowMs: () => testFixture.clock.value,
      });
      authority.controller.requestControl({
        ...operationBase('effect-controller', digest('e')),
        clientId: 'client-1',
        connectionGeneration: 1,
        workerInstanceId: 'worker-1',
        resumeSecret: secret(5),
        resumeExpiresAtMs: 4_000,
      });
      expect(
        authority.effects.terminal({
          sessionId: 'session-authority',
          effectId: 'effect-missing',
          ownerId: 'owner-1',
          invocationId: 'invocation-1',
          attemptId: 'attempt-1',
          requestDigest: digest('6'),
          outcome: 'unknown',
          terminalDigest: digest('7'),
          controllerLease: controllerLease(),
        }),
      ).toEqual({ status: 'unknown', reason: 'missing_preparation' });
      expect(
        authority.effects.prepare({
          sessionId: 'session-authority',
          effectId: 'effect-1',
          ownerId: 'owner-1',
          invocationId: 'invocation-1',
          attemptId: 'attempt-1',
          requestDigest: digest('8'),
          expiresAtMs: 2_000,
          capabilityDigest: digest('9'),
          controllerLease: controllerLease(),
        }),
      ).toMatchObject({ status: 'prepared', evidence: { state: 'prepared' } });
      testFixture.clock.value = 2_001;
      expect(
        authority.effects.terminal({
          sessionId: 'session-authority',
          effectId: 'effect-1',
          ownerId: 'owner-1',
          invocationId: 'invocation-1',
          attemptId: 'attempt-1',
          requestDigest: digest('8'),
          outcome: 'succeeded',
          terminalDigest: digest('a'),
          controllerLease: controllerLease(),
        }),
      ).toEqual({ status: 'unknown', reason: 'stale_lease' });
      expect(authority.effects.inspect('session-authority', 'effect-1')).toMatchObject({
        status: 'unknown',
        evidence: { outcome: 'unknown' },
      });
      expect(
        authority.effects.prepare({
          sessionId: 'session-authority',
          effectId: 'effect-1',
          ownerId: 'owner-1',
          invocationId: 'invocation-1',
          attemptId: 'attempt-1',
          requestDigest: digest('8'),
          expiresAtMs: 4_000,
          controllerLease: controllerLease(),
        }),
      ).toMatchObject({ status: 'rejected', reason: 'unknown_result' });

      const resource = authority.resources.prepare({
        sessionId: 'session-authority',
        resourceId: 'git-resource',
        ownerId: 'owner-1',
        attemptId: 'attempt-resource',
        requestDigest: digest('b'),
        expiresAtMs: 4_000,
        controllerLease: controllerLease(),
      });
      expect(resource).toMatchObject({ state: 'prepared', externalLeaseDigest: null });
      const held = authority.resources.recordAcquired({
        sessionId: 'session-authority',
        resourceId: 'git-resource',
        ownerId: 'owner-1',
        attemptId: 'attempt-resource',
        requestDigest: digest('b'),
        leaseRevision: resource.leaseRevision,
        expiresAtMs: 4_000,
        externalLeaseDigest: digest('c'),
        controllerLease: controllerLease(),
      });
      expect(held).toMatchObject({ state: 'held', externalLeaseDigest: digest('c') });
      expect(
        authority.resources.recordReleased({
          sessionId: 'session-authority',
          resourceId: 'git-resource',
          ownerId: 'owner-1',
          attemptId: 'attempt-resource',
          requestDigest: digest('b'),
          leaseRevision: resource.leaseRevision,
          externalLeaseDigest: digest('c'),
          controllerLease: controllerLease(),
        }),
      ).toMatchObject({ state: 'released' });
      const database = new Database(testFixture.path, { readonly: true });
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM runtime_effect_leases WHERE effect_id LIKE 'workspace-authority-resource:%'",
          )
          .get(),
      ).toEqual({ count: 0 });
      database.close();
    } finally {
      testFixture.cleanup();
    }
  });

  test('fails closed on owner drift and rejects weak capability secrets', () => {
    const testFixture = fixture();
    try {
      const authority = createSqliteWorkspaceAuthority({
        db: new Database(testFixture.path),
        binding,
        nowMs: () => testFixture.clock.value,
      });
      expect(() =>
        authority.controller.requestControl({
          ...operationBase('weak-secret', digest('d')),
          clientId: 'client-1',
          connectionGeneration: 1,
          workerInstanceId: 'worker-1',
          resumeSecret: 'A'.repeat(43),
          resumeExpiresAtMs: 2_000,
        }),
      ).toThrow(SqliteWorkspaceAuthorityError);
      expect(() =>
        createSqliteWorkspaceAuthority({
          db: new Database(testFixture.path),
          binding: { ...binding, workerScopeId: 'wrong-scope' },
        }),
      ).toThrow(SqliteRuntimeFormatMismatchError);
    } finally {
      testFixture.cleanup();
    }
  });

  test('rejects effect and resource writes from a Controller generation that was released', () => {
    const testFixture = fixture();
    try {
      const authority = createSqliteWorkspaceAuthority({
        db: new Database(testFixture.path),
        binding,
        nowMs: () => testFixture.clock.value,
      });
      const firstLease = controllerLease();
      authority.controller.requestControl({
        ...operationBase('rollover-request-1', digest('1')),
        clientId: firstLease.clientId,
        connectionGeneration: firstLease.connectionGeneration,
        workerInstanceId: firstLease.workerInstanceId,
        resumeSecret: secret(21),
        resumeExpiresAtMs: 4_000,
      });
      authority.effects.prepare({
        sessionId: firstLease.sessionId,
        effectId: 'rollover-effect',
        ownerId: firstLease.workerInstanceId,
        invocationId: 'rollover-invocation',
        attemptId: 'rollover-effect',
        requestDigest: digest('2'),
        expiresAtMs: 4_000,
        controllerLease: firstLease,
      });
      const preparedResource = authority.resources.prepare({
        sessionId: firstLease.sessionId,
        resourceId: 'rollover-resource',
        ownerId: firstLease.workerInstanceId,
        attemptId: 'rollover-attempt',
        requestDigest: digest('3'),
        expiresAtMs: 4_000,
        controllerLease: firstLease,
      });
      authority.controller.releaseControl({
        ...operationBase('rollover-release', digest('4')),
        ...firstLease,
      });
      const secondLease = controllerLease({
        clientId: 'client-2',
        connectionGeneration: 2,
        controllerGeneration: 3,
      });
      authority.controller.requestControl({
        ...operationBase('rollover-request-2', digest('5')),
        clientId: secondLease.clientId,
        connectionGeneration: secondLease.connectionGeneration,
        workerInstanceId: secondLease.workerInstanceId,
        resumeSecret: secret(22),
        resumeExpiresAtMs: 4_000,
      });

      expect(() =>
        authority.effects.terminal({
          sessionId: firstLease.sessionId,
          effectId: 'rollover-effect',
          ownerId: firstLease.workerInstanceId,
          invocationId: 'rollover-invocation',
          attemptId: 'rollover-effect',
          requestDigest: digest('2'),
          outcome: 'succeeded',
          terminalDigest: digest('6'),
          controllerLease: firstLease,
        }),
      ).toThrow(SqliteWorkspaceAuthorityError);
      expect(authority.effects.inspect(firstLease.sessionId, 'rollover-effect')).toMatchObject({
        status: 'prepared',
      });

      expect(() =>
        authority.resources.recordAcquired({
          sessionId: firstLease.sessionId,
          resourceId: 'rollover-resource',
          ownerId: firstLease.workerInstanceId,
          attemptId: 'rollover-attempt',
          requestDigest: digest('3'),
          leaseRevision: preparedResource.leaseRevision,
          expiresAtMs: 4_000,
          externalLeaseDigest: digest('7'),
          controllerLease: firstLease,
        }),
      ).toThrow(SqliteWorkspaceAuthorityError);
      expect(authority.resources.inspect(firstLease.sessionId, 'rollover-resource')).toMatchObject({
        state: 'prepared',
      });
      expect(() =>
        authority.resources.recordReleased({
          sessionId: firstLease.sessionId,
          resourceId: 'rollover-resource',
          ownerId: firstLease.workerInstanceId,
          attemptId: 'rollover-attempt',
          requestDigest: digest('3'),
          leaseRevision: preparedResource.leaseRevision,
          externalLeaseDigest: digest('7'),
          controllerLease: firstLease,
        }),
      ).toThrow(SqliteWorkspaceAuthorityError);
    } finally {
      testFixture.cleanup();
    }
  });
});
