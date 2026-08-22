import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimePersistedAuthorityCodecV1 } from '@kite/runtime-host';
import {
  RUNTIME_DATA_ORIGIN_ARTIFACT_NAMESPACE_V1,
  RUNTIME_EGRESS_AUTHORITY_ARTIFACT_NAMESPACE_V1,
  type RuntimeDataOriginLedgerPortV1,
  type RuntimeDataOriginRecordV1,
  type RuntimeEgressAuthorityLedgerPortV1,
  type RuntimeEgressAuthorityRecordV1,
} from '@kite/runtime-host/storage';
import { canonicalDataOriginSetV1, type DataOriginV1 } from '@kite/runtime-spi';
import { createSqliteRuntimeStorage } from '../src/sqlite-store';
import {
  createSqliteRuntimeStorageV5,
  SQLITE_RUNTIME_FORMAT_EPOCH_V2,
  SQLITE_RUNTIME_STATE26_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE5_SCHEMA_VERSION,
  sqliteRuntimeStorePathForV2,
} from '../src/store5';

const persistedAuthority = createRuntimePersistedAuthorityCodecV1({
  issuer: 'store5-test',
  currentKey: { keyId: 'store5-test-key', key: new Uint8Array(32).fill(5) },
});

function storeChecksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

describe('RAV1 State26/Store5 production format', () => {
  test('publishes State26/Store5/new epoch as the only production boundary', () => {
    expect(SQLITE_RUNTIME_STATE26_SCHEMA_VERSION).toBe(26);
    expect(SQLITE_RUNTIME_STORE5_SCHEMA_VERSION).toBe(5);
    expect(SQLITE_RUNTIME_FORMAT_EPOCH_V2).toBe('kite-runtime-modularization-v1-2026-08-19');
  });
  test('derives an independent target path and never aliases Store4', () => {
    expect(sqliteRuntimeStorePathForV2('/tmp/checkpoints.sqlite')).toBe(
      '/tmp/checkpoints.runtime-state26-store5.db',
    );
    expect(sqliteRuntimeStorePathForV2('/tmp/checkpoints.sqlite')).not.toBe(
      '/tmp/checkpoints.runtime.db',
    );
    expect(sqliteRuntimeStorePathForV2('/tmp/checkpoints.sqlite')).not.toBe(
      '/tmp/checkpoints.runtime-v5.db',
    );
  });
  test('opens the target adapter only with the State26/Store5 profile', () => {
    const codec = {
      encodeEvent: (event: string) => event,
      decodeEvent: (json: string) => json,
      encodeState: (state: { schemaVersion: number; formatEpoch: string }) => JSON.stringify(state),
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: () => ({ stateRevision: 0, schemaVersion: 26 }),
      rebindForkState: <T>(state: T) => state,
    };
    const storage = createSqliteRuntimeStorageV5({
      databasePath: ':memory:',
      codec,
      persistedAuthority,
    });
    expect(storage.stateSchemaVersion).toBe(26);
    expect(storage.storeSchemaVersion).toBe(5);
    expect(storage.compatibilityEpoch).toBe('kite-runtime-modularization-v1-2026-08-19');
    storage.close();
  });

  test('rejects an explicit legacy snapshot metadata hint instead of normalizing it', () => {
    const state = {
      schemaVersion: 26 as const,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision: 0,
      session: {
        threadId: 'metadata-downgrade',
        projectId: 'project_metadata',
        canonicalWorkspaceDigest: `sha256:${'d'.repeat(64)}`,
      },
    };
    const storage = createSqliteRuntimeStorageV5({
      databasePath: ':memory:',
      persistedAuthority,
      codec: {
        encodeEvent: JSON.stringify,
        decodeEvent: JSON.parse,
        encodeState: JSON.stringify,
        decodeState: <T>(json: string) => JSON.parse(json) as T,
        snapshotMetadata: (value: typeof state) => ({
          stateRevision: value.revision,
          schemaVersion: value.schemaVersion,
        }),
        sessionIdentity: (value: typeof state) => ({
          projectId: value.session.projectId,
          canonicalWorkspaceDigest: value.session.canonicalWorkspaceDigest,
        }),
        rebindForkState: <T>(value: T) => value,
      },
    });
    expect(() =>
      storage.transactions.commitDecision({
        sessionId: state.session.threadId,
        events: [],
        snapshot: state,
        snapshotMetadata: {
          eventPosition: 0,
          stateRevision: 0,
          stateChecksum: '',
          schemaVersion: 25,
        },
      }),
    ).toThrow(/Runtime format is incompatible \(schema=25/u);
    expect(storage.sessions.loadSnapshot(state.session.threadId)).toBeNull();
    storage.close();
  });

  test('persists and replays a State26 session through the target tables', () => {
    type TargetState = {
      schemaVersion: 26;
      formatEpoch: string;
      revision: number;
      session: {
        threadId: string;
        projectId: string;
        canonicalWorkspaceDigest: string;
      };
    };
    const codec = {
      encodeEvent: JSON.stringify,
      decodeEvent: JSON.parse,
      encodeState: JSON.stringify,
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: (state: TargetState) => ({
        stateRevision: state.revision,
        schemaVersion: 26,
      }),
      sessionIdentity: (state: TargetState) => ({
        projectId: state.session.projectId,
        canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
      }),
      rebindForkState: (state: TargetState, sessionId: string) => ({
        ...state,
        session: { ...state.session, threadId: sessionId },
      }),
    };
    const state: TargetState = {
      schemaVersion: 26,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision: 1,
      session: {
        threadId: 'target-session',
        projectId: 'project_target',
        canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
      },
    };
    const storage = createSqliteRuntimeStorageV5({
      databasePath: ':memory:',
      codec,
      persistedAuthority,
    });
    storage.transactions.commitDecision({
      sessionId: state.session.threadId,
      events: [{ type: 'target.event' }],
      snapshot: state,
      metadata: [{ eventId: 'target-event-1', revision: 1 }],
    });
    expect(storage.sessions.loadEventsStrict(state.session.threadId)).toHaveLength(1);
    expect(storage.sessions.loadSnapshot<TargetState>(state.session.threadId)).toEqual(state);
    storage.checkpoints.saveNamedSnapshot(state.session.threadId, 'checkpoint', state, 1);
    expect(
      storage.checkpoints.loadNamedSnapshot<TargetState>(state.session.threadId, 'checkpoint'),
    ).toEqual(state);
    expect(
      storage.checkpoints.forkSession(
        state.session.threadId,
        'checkpoint',
        'target-session-fork',
        'f'.repeat(64),
      ),
    ).toBe(true);
    expect(storage.sessions.loadEventsStrict('target-session-fork')).toHaveLength(1);
    expect(storage.sessions.loadSnapshot<TargetState>('target-session-fork')).toMatchObject({
      session: { threadId: 'target-session-fork' },
    });
    storage.close();
  });

  test('atomically authenticates DataOrigin lineage and fails closed on parent or row drift', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-store5-origin-'));
    const path = join(root, 'runtime.db');
    type OriginEvent = {
      type: string;
      origins: readonly RuntimeDataOriginRecordV1[];
      authorities: readonly RuntimeEgressAuthorityRecordV1[];
    };
    type TargetState = {
      schemaVersion: 26;
      formatEpoch: string;
      revision: number;
      session: {
        threadId: string;
        projectId: string;
        canonicalWorkspaceDigest: string;
      };
    };
    const codec = {
      encodeEvent: JSON.stringify,
      decodeEvent: (json: string) => JSON.parse(json) as OriginEvent,
      encodeState: JSON.stringify,
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: (state: TargetState) => ({
        stateRevision: state.revision,
        schemaVersion: 26,
      }),
      sessionIdentity: (state: TargetState) => ({
        projectId: state.session.projectId,
        canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
      }),
      dataOriginsForEvent: (event: OriginEvent) => event.origins,
      egressAuthoritiesForEvent: (event: OriginEvent) => event.authorities,
      rebindForkState: (state: TargetState, sessionId: string) => ({
        ...state,
        session: { ...state.session, threadId: sessionId },
      }),
    };
    const origin = (
      ordinal: number,
      parentOriginIds: readonly string[] = [],
    ): RuntimeDataOriginRecordV1 => ({
      originId: `sha256:${String(ordinal).repeat(64)}`,
      kind: ordinal === 1 ? 'user' : 'runtime',
      classification: 'confidential',
      ownerProjectId: 'project_origin',
      parentOriginIds,
      observationId: `sha256:${'9'.repeat(64)}`,
    });
    const origins = [
      origin(1),
      origin(2, [`sha256:${'1'.repeat(64)}`]),
      origin(3, [`sha256:${'2'.repeat(64)}`]),
      origin(4, [`sha256:${'3'.repeat(64)}`]),
    ];
    const state: TargetState = {
      schemaVersion: 26,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision: 1,
      session: {
        threadId: 'origin-session',
        projectId: 'project_origin',
        canonicalWorkspaceDigest: `sha256:${'8'.repeat(64)}`,
      },
    };
    const authority: RuntimeEgressAuthorityRecordV1 = {
      egressId: `sha256:${'6'.repeat(64)}`,
      destinationId: 'model:test-route',
      destinationKind: 'model',
      routeIdentity: 'test-route',
      nonceNamespace: 'model.egress.v1',
      invocationId: 'origin-invocation',
      originIds: [origins[3]!.originId],
      allowedClassifications: ['public', 'internal', 'confidential'],
      allowedOriginKinds: ['runtime', 'user'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    try {
      const storage = createSqliteRuntimeStorageV5<OriginEvent, TargetState>({
        databasePath: path,
        codec,
        persistedAuthority,
        options: { journalMode: 'delete' },
      });
      storage.transactions.commitDecision({
        sessionId: state.session.threadId,
        events: [{ type: 'model.invocation_prepared', origins, authorities: [authority] }],
        snapshot: state,
        metadata: [{ eventId: 'origin-event-1', revision: 1 }],
      });
      const ledger = storage.artifacts.getNamespace<RuntimeDataOriginLedgerPortV1>(
        RUNTIME_DATA_ORIGIN_ARTIFACT_NAMESPACE_V1,
      );
      expect(ledger?.read(origins[3]!.originId)).toEqual(origins[3]);
      expect(ledger?.readByObservation(origins[0]!.observationId)).toHaveLength(4);
      const authorityLedger = storage.artifacts.getNamespace<RuntimeEgressAuthorityLedgerPortV1>(
        RUNTIME_EGRESS_AUTHORITY_ARTIFACT_NAMESPACE_V1,
      );
      expect(authorityLedger?.read(authority.egressId)).toEqual(authority);
      expect(authorityLedger?.readByInvocation(authority.invocationId)).toEqual([authority]);
      expect(() => ledger?.record([origin(5, [`sha256:${'7'.repeat(64)}`])])).toThrow(
        'parent is unavailable',
      );
      expect(storage.sessions.loadEventsStrict(state.session.threadId)).toHaveLength(1);
      storage.close();

      const database = new Database(path);
      database.run(
        "UPDATE runtime_data_origins SET classification = 'public' WHERE origin_id = ?",
        [origins[3]!.originId],
      );
      database.close();
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: path,
          codec,
          persistedAuthority,
          options: { journalMode: 'delete' },
        }),
      ).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('forks authenticated provenance without duplicating one-shot receipt authority and GC follows reachability', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-store5-provenance-fork-'));
    const path = join(root, 'runtime.db');
    type Receipt = {
      nonceDigest: string;
      invocationId: string;
      receiptDigest: string;
      originDigest: string;
      sourceOriginIds: readonly string[];
      egressAuthorityId: string;
      routeIdentity: string;
      expiresAt: string;
    };
    type LedgerEvent = {
      type: 'mcp.egress_decided';
      origins: readonly RuntimeDataOriginRecordV1[];
      authorities: readonly RuntimeEgressAuthorityRecordV1[];
      receipt: Receipt;
    };
    type TargetState = {
      schemaVersion: 26;
      formatEpoch: string;
      revision: number;
      session: {
        threadId: string;
        projectId: string;
        canonicalWorkspaceDigest: string;
      };
    };
    const codec = {
      encodeEvent: JSON.stringify,
      decodeEvent: (json: string) => JSON.parse(json) as LedgerEvent,
      encodeState: JSON.stringify,
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: (state: TargetState) => ({
        stateRevision: state.revision,
        schemaVersion: 26,
      }),
      sessionIdentity: (state: TargetState) => ({
        projectId: state.session.projectId,
        canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
      }),
      rebindForkState: (state: TargetState, sessionId: string) => ({
        ...state,
        session: { ...state.session, threadId: sessionId },
      }),
      dataOriginsForEvent: (event: LedgerEvent) => event.origins,
      egressAuthoritiesForEvent: (event: LedgerEvent) => event.authorities,
    };
    const sourceOrigin: DataOriginV1 = Object.freeze({
      originId: `sha256:${'1'.repeat(64)}`,
      kind: 'user',
      classification: 'confidential',
      ownerProjectId: 'project_fork',
      parentOriginIds: Object.freeze([]),
      observationId: `sha256:${'2'.repeat(64)}`,
    });
    const origin: RuntimeDataOriginRecordV1 = {
      originId: sourceOrigin.originId,
      kind: sourceOrigin.kind,
      classification: sourceOrigin.classification,
      ownerProjectId: sourceOrigin.ownerProjectId!,
      parentOriginIds: sourceOrigin.parentOriginIds,
      observationId: sourceOrigin.observationId,
    };
    const authority: RuntimeEgressAuthorityRecordV1 = {
      egressId: `sha256:${'3'.repeat(64)}`,
      destinationId: 'mcp:fork-server',
      destinationKind: 'mcp',
      routeIdentity: 'fork-server',
      nonceNamespace: 'mcp.egress.v1',
      invocationId: 'fork-invocation',
      originIds: [origin.originId],
      allowedClassifications: ['confidential'],
      allowedOriginKinds: ['user'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const receipt: Receipt = {
      nonceDigest: `sha256:${'4'.repeat(64)}`,
      invocationId: authority.invocationId,
      receiptDigest: `sha256:${'5'.repeat(64)}`,
      originDigest: new Bun.CryptoHasher('sha256')
        .update(canonicalDataOriginSetV1([sourceOrigin]))
        .digest('hex'),
      sourceOriginIds: [origin.originId],
      egressAuthorityId: authority.egressId,
      routeIdentity: authority.routeIdentity,
      expiresAt: authority.expiresAt,
    };
    const event: LedgerEvent = {
      type: 'mcp.egress_decided',
      origins: [origin],
      authorities: [authority],
      receipt,
    };
    const state = (threadId: string, revision = 1): TargetState => ({
      schemaVersion: 26,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision,
      session: {
        threadId,
        projectId: 'project_fork',
        canonicalWorkspaceDigest: `sha256:${'6'.repeat(64)}`,
      },
    });
    try {
      const storage = createSqliteRuntimeStorageV5<LedgerEvent, TargetState>({
        databasePath: path,
        codec,
        persistedAuthority,
        uniqueReceiptForEvent: (candidate) => candidate.receipt,
        options: { journalMode: 'delete' },
      });
      storage.transactions.commitDecision({
        sessionId: 'source-session',
        events: [event],
        snapshot: state('source-session'),
        metadata: [{ eventId: 'source-event-1', revision: 1 }],
      });
      storage.checkpoints.saveNamedSnapshot(
        'source-session',
        'before-second-egress',
        state('source-session'),
        1,
      );
      const secondOrigin: DataOriginV1 = Object.freeze({
        ...sourceOrigin,
        originId: `sha256:${'8'.repeat(64)}`,
        observationId: `sha256:${'9'.repeat(64)}`,
      });
      const secondAuthority: RuntimeEgressAuthorityRecordV1 = {
        ...authority,
        egressId: `sha256:${'a'.repeat(64)}`,
        invocationId: 'second-invocation',
        originIds: [secondOrigin.originId],
      };
      const secondReceipt: Receipt = {
        ...receipt,
        nonceDigest: `sha256:${'b'.repeat(64)}`,
        invocationId: secondAuthority.invocationId,
        receiptDigest: `sha256:${'c'.repeat(64)}`,
        originDigest: new Bun.CryptoHasher('sha256')
          .update(canonicalDataOriginSetV1([secondOrigin]))
          .digest('hex'),
        sourceOriginIds: [secondOrigin.originId],
        egressAuthorityId: secondAuthority.egressId,
      };
      storage.transactions.commitDecision({
        sessionId: 'source-session',
        events: [
          {
            type: 'mcp.egress_decided',
            origins: [
              {
                originId: secondOrigin.originId,
                kind: secondOrigin.kind,
                classification: secondOrigin.classification,
                ownerProjectId: secondOrigin.ownerProjectId!,
                parentOriginIds: secondOrigin.parentOriginIds,
                observationId: secondOrigin.observationId,
              },
            ],
            authorities: [secondAuthority],
            receipt: secondReceipt,
          },
        ],
        snapshot: state('source-session', 2),
        metadata: [{ eventId: 'source-event-2', revision: 2 }],
      });
      expect(
        storage.checkpoints.restoreNamedSnapshot('source-session', 'before-second-egress'),
      ).toBe(true);
      expect(storage.sessions.loadEventsStrict('source-session')).toHaveLength(1);
      expect(
        storage.artifacts
          .getNamespace<RuntimeDataOriginLedgerPortV1>(RUNTIME_DATA_ORIGIN_ARTIFACT_NAMESPACE_V1)
          ?.read(secondOrigin.originId),
      ).toBeNull();
      expect(
        storage.artifacts
          .getNamespace<RuntimeEgressAuthorityLedgerPortV1>(
            RUNTIME_EGRESS_AUTHORITY_ARTIFACT_NAMESPACE_V1,
          )
          ?.read(secondAuthority.egressId),
      ).toBeNull();
      expect(
        storage.checkpoints.forkCurrentSession('source-session', 'target-session', '7'.repeat(64)),
      ).toBe(true);
      storage.sessions.deleteSession('source-session');
      storage.close();

      for (const [table, predicate] of [
        ['runtime_data_origins', '1 = 1'],
        ['runtime_egress_authorities', '1 = 1'],
        ['runtime_mcp_egress_nonces', '1 = 1'],
      ] as const) {
        const missingLedgerPath = join(root, `${table}.db`);
        copyFileSync(path, missingLedgerPath);
        const tampered = new Database(missingLedgerPath);
        tampered.run(`DELETE FROM ${table} WHERE ${predicate}`);
        tampered.close();
        expect(() =>
          createSqliteRuntimeStorageV5<LedgerEvent, TargetState>({
            databasePath: missingLedgerPath,
            codec,
            persistedAuthority,
            uniqueReceiptForEvent: (candidate) => candidate.receipt,
            options: { journalMode: 'delete' },
          }),
        ).toThrow('Runtime format is incompatible');
      }

      const reopened = createSqliteRuntimeStorageV5<LedgerEvent, TargetState>({
        databasePath: path,
        codec,
        persistedAuthority,
        sessionId: 'target-session',
        uniqueReceiptForEvent: (candidate) => candidate.receipt,
        options: { journalMode: 'delete' },
      });
      expect(reopened.sessions.loadEventsStrict('target-session')).toHaveLength(1);
      reopened.sessions.deleteSession('target-session');
      reopened.close();

      const database = new Database(path, { readonly: true });
      expect(
        database
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_data_origins')
          .get()?.count,
      ).toBe(0);
      expect(
        database
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_egress_authorities')
          .get()?.count,
      ).toBe(0);
      expect(
        database
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runtime_mcp_egress_nonces')
          .get()?.count,
      ).toBe(0);
      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a Store4 database at the target path before any write', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-store5-negative-'));
    const path = join(root, 'runtime.db');
    try {
      const legacy = createSqliteRuntimeStorage({
        databasePath: path,
        codec: {
          encodeEvent: JSON.stringify,
          decodeEvent: JSON.parse,
          encodeState: JSON.stringify,
          decodeState: <T>(json: string) => JSON.parse(json) as T,
          snapshotMetadata: () => ({ stateRevision: 0, schemaVersion: 25 }),
          rebindForkState: <T>(state: T) => state,
        },
        options: { journalMode: 'delete' },
      });
      legacy.close();
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: path,
          codec: {
            encodeEvent: JSON.stringify,
            decodeEvent: JSON.parse,
            encodeState: JSON.stringify,
            decodeState: <T>(json: string) => JSON.parse(json) as T,
            snapshotMetadata: () => ({ stateRevision: 0, schemaVersion: 26 }),
            rebindForkState: <T>(state: T) => state,
          },
          persistedAuthority,
        }),
      ).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects extra Store4-shaped authority and Project identity drift on reopen', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-store5-shape-negative-'));
    const path = join(root, 'runtime.db');
    type TargetState = {
      schemaVersion: 26;
      formatEpoch: string;
      revision: number;
      session: {
        threadId: string;
        projectId: string;
        canonicalWorkspaceDigest: string;
      };
    };
    const codec = {
      encodeEvent: JSON.stringify,
      decodeEvent: JSON.parse,
      encodeState: JSON.stringify,
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: (state: TargetState) => ({
        stateRevision: state.revision,
        schemaVersion: 26,
      }),
      sessionIdentity: (state: TargetState) => ({
        projectId: state.session.projectId,
        canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
      }),
      rebindForkState: (state: TargetState, sessionId: string) => ({
        ...state,
        session: { ...state.session, threadId: sessionId },
      }),
    };
    const state: TargetState = {
      schemaVersion: 26,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision: 1,
      session: {
        threadId: 'identity-session',
        projectId: 'project_target',
        canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}`,
      },
    };
    try {
      const storage = createSqliteRuntimeStorageV5({
        databasePath: path,
        codec,
        persistedAuthority,
        options: { journalMode: 'delete' },
      });
      storage.transactions.commitDecision({
        sessionId: state.session.threadId,
        events: [{ type: 'target.event' }],
        snapshot: state,
        metadata: [{ eventId: 'target-event-1', revision: 1 }],
      });
      storage.close();

      const database = new Database(path);
      database.run("UPDATE runtime_sessions SET project_id = 'project_attacker'");
      database.close();
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: path,
          codec,
          persistedAuthority,
          sessionId: state.session.threadId,
          options: { journalMode: 'delete' },
        }),
      ).toThrow('Runtime format is incompatible');

      const repair = new Database(path);
      repair.run("UPDATE runtime_sessions SET project_id = 'project_target'");
      repair.run('CREATE TABLE legacy_authority_bypass (value TEXT)');
      repair.close();
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: path,
          codec,
          persistedAuthority,
          options: { journalMode: 'delete' },
        }),
      ).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('never converts missing, corrupt, or unauthentic Store5 snapshots into a fresh session', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-store5-snapshot-negative-'));
    const path = join(root, 'runtime.db');
    type TargetState = {
      schemaVersion: 26;
      formatEpoch: string;
      revision: number;
      session: {
        threadId: string;
        projectId: string;
        canonicalWorkspaceDigest: string;
      };
    };
    const codec = {
      encodeEvent: JSON.stringify,
      decodeEvent: JSON.parse,
      encodeState: JSON.stringify,
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: (state: TargetState) => ({
        stateRevision: state.revision,
        schemaVersion: 26,
      }),
      sessionIdentity: (state: TargetState) => ({
        projectId: state.session.projectId,
        canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
      }),
      rebindForkState: (state: TargetState, sessionId: string) => ({
        ...state,
        session: { ...state.session, threadId: sessionId },
      }),
    };
    const state = (threadId: string): TargetState => ({
      schemaVersion: 26,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision: 1,
      session: {
        threadId,
        projectId: 'project_snapshot',
        canonicalWorkspaceDigest: `sha256:${'7'.repeat(64)}`,
      },
    });
    try {
      const storage = createSqliteRuntimeStorageV5({
        databasePath: path,
        codec,
        persistedAuthority,
        options: { journalMode: 'delete' },
      });
      expect(storage.sessions.loadSnapshotRecord('never-created-session')).toBeNull();
      for (const threadId of ['healthy-session', 'corrupt-session']) {
        storage.transactions.commitDecision({
          sessionId: threadId,
          events: [{ type: 'target.event', threadId }],
          snapshot: state(threadId),
          metadata: [{ eventId: `${threadId}-event-1`, revision: 1 }],
        });
      }
      storage.close();

      const mutateAndReject = (name: string, mutate: (database: Database) => void): void => {
        const candidatePath = join(root, `${name}.db`);
        copyFileSync(path, candidatePath);
        const database = new Database(candidatePath);
        mutate(database);
        database.close();
        expect(() =>
          createSqliteRuntimeStorageV5({
            databasePath: candidatePath,
            codec,
            persistedAuthority,
            options: { journalMode: 'delete' },
          }),
        ).toThrow('Runtime format is incompatible');
      };

      mutateAndReject('missing', (database) => {
        database.run("DELETE FROM runtime_snapshots WHERE session_id = 'corrupt-session'");
      });
      mutateAndReject('old-schema', (database) => {
        database.run(
          "UPDATE runtime_snapshots SET schema_version = 25 WHERE session_id = 'corrupt-session'",
        );
      });
      mutateAndReject('old-epoch', (database) => {
        database.run(
          "UPDATE runtime_snapshots SET format_epoch = 'legacy-rmv1-state25-store4' WHERE session_id = 'corrupt-session'",
        );
      });
      mutateAndReject('checksum', (database) => {
        database.run(
          "UPDATE runtime_snapshots SET state_checksum = '00000000' WHERE session_id = 'corrupt-session'",
        );
      });
      mutateAndReject('authenticator', (database) => {
        const row = database
          .query<{ state_json: string }, []>(
            "SELECT state_json FROM runtime_snapshots WHERE session_id = 'corrupt-session'",
          )
          .get();
        if (!row) throw new Error('Missing snapshot fixture.');
        const tampered = `${row.state_json}x`;
        database.run(
          "UPDATE runtime_snapshots SET state_json = ?, state_checksum = ? WHERE session_id = 'corrupt-session'",
          [tampered, storeChecksum(tampered)],
        );
      });
      mutateAndReject('json', (database) => {
        const invalidJsonEnvelope = persistedAuthority.seal({
          kind: 'snapshot',
          domain: 'runtime-snapshot-v1',
          identity: 'corrupt-session/snapshot/1',
          payload: '{invalid-json',
        });
        database.run(
          "UPDATE runtime_snapshots SET state_json = ?, state_checksum = ? WHERE session_id = 'corrupt-session'",
          [invalidJsonEnvelope, storeChecksum(invalidJsonEnvelope)],
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reopens the exact Store5 schema and rejects authenticated row tampering or key loss', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-store5-authority-negative-'));
    const path = join(root, 'runtime.db');
    type TargetState = {
      schemaVersion: 26;
      formatEpoch: string;
      revision: number;
      session: {
        threadId: string;
        projectId: string;
        canonicalWorkspaceDigest: string;
      };
    };
    const codec = {
      encodeEvent: JSON.stringify,
      decodeEvent: JSON.parse,
      encodeState: JSON.stringify,
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: (state: TargetState) => ({
        stateRevision: state.revision,
        schemaVersion: 26,
      }),
      sessionIdentity: (state: TargetState) => ({
        projectId: state.session.projectId,
        canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
      }),
      rebindForkState: (state: TargetState, sessionId: string) => ({
        ...state,
        session: { ...state.session, threadId: sessionId },
      }),
    };
    const state: TargetState = {
      schemaVersion: 26,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision: 1,
      session: {
        threadId: 'authority-session',
        projectId: 'project_authority',
        canonicalWorkspaceDigest: `sha256:${'c'.repeat(64)}`,
      },
    };
    try {
      const first = createSqliteRuntimeStorageV5({
        databasePath: path,
        codec,
        persistedAuthority,
        options: { journalMode: 'delete' },
      });
      first.transactions.commitDecision({
        sessionId: state.session.threadId,
        events: [{ type: 'authority.event' }],
        snapshot: state,
        metadata: [{ eventId: 'authority-event-1', revision: 1 }],
      });
      first.checkpoints.saveNamedSnapshot(state.session.threadId, 'trusted', state, 1);
      first.close();

      const reopened = createSqliteRuntimeStorageV5({
        databasePath: path,
        codec,
        persistedAuthority,
        sessionId: state.session.threadId,
        options: { journalMode: 'delete' },
      });
      expect(reopened.sessions.loadEventsStrict(state.session.threadId)).toHaveLength(1);
      expect(reopened.sessions.loadSnapshot<TargetState>(state.session.threadId)).toEqual(state);
      expect(
        reopened.checkpoints.loadNamedSnapshot<TargetState>(state.session.threadId, 'trusted'),
      ).toEqual(state);
      reopened.close();

      const database = new Database(path);
      const snapshot = database
        .query<{ state_json: string }, []>(
          "SELECT state_json FROM runtime_snapshots WHERE session_id = 'authority-session'",
        )
        .get();
      if (!snapshot) throw new Error('Expected Store5 snapshot fixture.');
      const envelope = JSON.parse(snapshot.state_json) as Record<string, unknown>;
      const forged = JSON.stringify({
        ...envelope,
        payload: JSON.stringify({ ...state, revision: 2 }),
      });
      database.run(
        "UPDATE runtime_snapshots SET state_json = ?, state_checksum = ? WHERE session_id = 'authority-session'",
        [forged, storeChecksum(forged)],
      );
      database.close();
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: path,
          codec,
          persistedAuthority,
          sessionId: state.session.threadId,
          options: { journalMode: 'delete' },
        }),
      ).toThrow('Runtime format is incompatible');
      expect(() =>
        createSqliteRuntimeStorageV5({
          databasePath: path,
          codec,
          persistedAuthority: createRuntimePersistedAuthorityCodecV1({
            issuer: 'store5-test',
            currentKey: { keyId: 'lost-store5-key', key: new Uint8Array(32).fill(7) },
          }),
          sessionId: state.session.threadId,
          options: { journalMode: 'delete' },
        }),
      ).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('authenticates one-shot receipt rows before conflict or expiry pruning', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-store5-receipt-negative-'));
    const path = join(root, 'runtime.db');
    type Receipt = {
      nonceDigest: string;
      invocationId: string;
      receiptDigest: string;
      originDigest: string;
      sourceOriginIds: readonly string[];
      egressAuthorityId: string;
      routeIdentity: string;
      expiresAt: string;
      pruneBefore?: string;
    };
    type ReceiptEvent = { type: string; receipt: Receipt };
    type TargetState = {
      schemaVersion: 26;
      formatEpoch: string;
      revision: number;
      session: {
        threadId: string;
        projectId: string;
        canonicalWorkspaceDigest: string;
      };
    };
    const codec = {
      encodeEvent: JSON.stringify,
      decodeEvent: JSON.parse,
      encodeState: JSON.stringify,
      decodeState: <T>(json: string) => JSON.parse(json) as T,
      snapshotMetadata: (state: TargetState) => ({
        stateRevision: state.revision,
        schemaVersion: 26,
      }),
      sessionIdentity: (state: TargetState) => ({
        projectId: state.session.projectId,
        canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
      }),
      rebindForkState: (state: TargetState, sessionId: string) => ({
        ...state,
        session: { ...state.session, threadId: sessionId },
      }),
      dataOriginsForEvent: (event: ReceiptEvent) => [
        {
          originId: `origin:${event.receipt.originDigest}`,
          kind: 'user' as const,
          classification: 'confidential' as const,
          ownerProjectId: 'project_receipt',
          parentOriginIds: [],
          observationId: `observation:${event.receipt.originDigest}`,
        },
      ],
      egressAuthoritiesForEvent: (event: ReceiptEvent) => [
        {
          egressId: event.receipt.egressAuthorityId,
          destinationId: `mcp:${event.receipt.routeIdentity}`,
          destinationKind: 'mcp' as const,
          routeIdentity: event.receipt.routeIdentity,
          nonceNamespace: 'mcp.egress.v1',
          invocationId: event.receipt.invocationId,
          originIds: [`origin:${event.receipt.originDigest}`],
          allowedClassifications: ['confidential' as const],
          allowedOriginKinds: ['user' as const],
          expiresAt: event.receipt.expiresAt,
        },
      ],
    };
    const state = (revision: number): TargetState => ({
      schemaVersion: 26,
      formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH_V2,
      revision,
      session: {
        threadId: 'receipt-session',
        projectId: 'project_receipt',
        canonicalWorkspaceDigest: `sha256:${'d'.repeat(64)}`,
      },
    });
    const receipt1: Receipt = {
      nonceDigest: `sha256:${'1'.repeat(64)}`,
      invocationId: 'invocation-1',
      receiptDigest: `sha256:${'2'.repeat(64)}`,
      originDigest: `sha256:${'3'.repeat(64)}`,
      sourceOriginIds: [`origin:sha256:${'3'.repeat(64)}`],
      egressAuthorityId: `sha256:${'4'.repeat(64)}`,
      routeIdentity: 'server-receipt',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    try {
      const first = createSqliteRuntimeStorageV5<ReceiptEvent, TargetState>({
        databasePath: path,
        codec,
        persistedAuthority,
        uniqueReceiptForEvent: (event) => event.receipt,
        options: { journalMode: 'delete' },
      });
      first.transactions.commitDecision({
        sessionId: 'receipt-session',
        events: [{ type: 'mcp.egress_decided', receipt: receipt1 }],
        snapshot: state(1),
        metadata: [{ eventId: 'receipt-event-1', revision: 1 }],
      });
      first.close();

      const database = new Database(path);
      database.run("UPDATE runtime_mcp_egress_nonces SET expires_at = '2000-01-01T00:00:00.000Z'");
      database.close();

      expect(() =>
        createSqliteRuntimeStorageV5<ReceiptEvent, TargetState>({
          databasePath: path,
          codec,
          persistedAuthority,
          sessionId: 'receipt-session',
          uniqueReceiptForEvent: (event) => event.receipt,
          options: { journalMode: 'delete' },
        }),
      ).toThrow('Runtime format is incompatible');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
