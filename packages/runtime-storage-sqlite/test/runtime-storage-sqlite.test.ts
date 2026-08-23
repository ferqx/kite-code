import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createSqliteSessionTokenStatsV1 } from '../src/session-metadata';
import {
  createSqliteRuntimeStorage,
  createSqliteRuntimeStorageBoundaryV1,
  defaultSqliteRuntimeJournalModeV1,
  SqliteRuntimeEffectLeaseConflictError,
  SqliteRuntimeFormatIncompatibleError,
  SqliteRuntimeRevisionConflictError,
  type SqliteRuntimeSnapshotCodecV1,
  SqliteRuntimeStorageOpenError,
} from '../src/sqlite-store';

type Event = {
  type: string;
  content?: string;
  pendingRequestId?: string;
};
type State = {
  revision: number;
  schemaVersion: number;
  formatEpoch: string;
  sessionId: string;
  recoveryIdentity: string;
  pendingRequestId?: string;
  cleanupBlocked?: boolean;
};

const FORMAT_EPOCH = 'kite-runtime-2026-08-18';

const codec: SqliteRuntimeSnapshotCodecV1<Event, State> = {
  encodeEvent: JSON.stringify,
  decodeEvent: JSON.parse,
  encodeState: JSON.stringify,
  decodeState: JSON.parse,
  snapshotMetadata: (state) => ({
    stateRevision: state.revision,
    schemaVersion: state.schemaVersion,
  }),
  recoveryIdentity: (state) => state.recoveryIdentity,
  validateSnapshot: ({ state, sessionId, schemaVersion, stateRevision, eventRevision }) => {
    if (
      state.sessionId !== sessionId ||
      state.schemaVersion !== 25 ||
      state.formatEpoch !== FORMAT_EPOCH ||
      schemaVersion !== 25 ||
      state.revision !== stateRevision ||
      stateRevision !== eventRevision
    )
      throw new Error('invalid snapshot');
  },
  rebindForkState: (state, sessionId, recoveryIdentity) => ({
    ...state,
    sessionId,
    recoveryIdentity,
  }),
  canFork: (state) => !state.cleanupBlocked,
  isCurrentPendingInteractionRequest: (state, event) =>
    state.pendingRequestId !== undefined && event.pendingRequestId === state.pendingRequestId,
};

const state = (sessionId: string, revision = 1, options: Partial<State> = {}): State => ({
  sessionId,
  revision,
  schemaVersion: 25,
  formatEpoch: FORMAT_EPOCH,
  recoveryIdentity: 'a'.repeat(64),
  ...options,
});

function tempDatabasePath(prefix: string): { root: string; path: string } {
  const root = testTempRoot(prefix);
  return { root, path: join(root, 'runtime.db') };
}

function testTempRoot(prefix: string): string {
  // SQLite's SQLITE_OPEN_NOFOLLOW rejects the macOS /tmp and /var aliases;
  // keep test databases below the canonical repository path instead.
  return mkdtempSync(join(process.cwd(), `.${prefix}`));
}

function closeAndRead(path: string): { bytes: Uint8Array; mtimeMs: number } {
  return { bytes: readFileSync(path), mtimeMs: statSync(path).mtimeMs };
}

function mutateDatabase(path: string, statement: string, bindings: SQLQueryBindings[] = []): void {
  const db = new Database(path);
  try {
    db.run(statement, bindings);
  } finally {
    db.close();
  }
}

function createPersistedBaseline(options: { state?: State; eventRevision?: number } = {}): {
  root: string;
  path: string;
} {
  const database = tempDatabasePath('kite-store4-baseline-');
  const storage = createSqliteRuntimeStorage<Event, State>({
    databasePath: database.path,
    codec,
    options: { journalMode: 'delete' },
  });
  const eventRevision = options.eventRevision ?? options.state?.revision ?? 1;
  storage.transactions.commitDecision({
    sessionId: options.state?.sessionId ?? 'session-1',
    events: [{ type: 'fact' }],
    snapshot: options.state ?? state('session-1', eventRevision),
    metadata: [{ eventId: `event-${eventRevision}`, revision: eventRevision }],
  });
  storage.close();
  return database;
}

function expectInvalidOpenPreservesFile(path: string): void {
  const before = closeAndRead(path);
  expect(() =>
    createSqliteRuntimeStorage<Event, State>({
      databasePath: path,
      codec,
      sessionId: 'session-1',
      options: { journalMode: 'delete' },
    }),
  ).toThrow(SqliteRuntimeFormatIncompatibleError);
  const after = closeAndRead(path);
  expect(after.bytes).toEqual(before.bytes);
  expect(after.mtimeMs).toBe(before.mtimeMs);
}

describe('runtime SQLite Store 4 owner', () => {
  test('owns the unchanged platform journal and sidecar path composition', () => {
    expect(defaultSqliteRuntimeJournalModeV1()).toBe(
      process.platform === 'win32' ? 'delete' : 'wal',
    );
  });

  test('publishes the frozen State 25 / Store 4 boundary', () => {
    expect(createSqliteRuntimeStorageBoundaryV1()).toEqual({
      adapterId: 'sqlite',
      stateSchemaVersion: 25,
      storeSchemaVersion: 4,
      compatibilityEpoch: 'kite-runtime-2026-08-18',
    });
  });

  test('creates exactly the Store 4 tables and indexes', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    storage.close();
    const root = testTempRoot('kite-store4-shape-');
    const path = join(root, 'runtime.db');
    try {
      const fileStorage = createSqliteRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        options: { journalMode: 'delete' },
      });
      expect(
        fileStorage.recoveryIdentities.getOrCreate('identity-shape', () => 'a'.repeat(64)),
      ).toBe('a'.repeat(64));
      fileStorage.close();
      const db = new Database(path, { readonly: true });
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_runtime_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual([
        'runtime_effect_leases',
        'runtime_events',
        'runtime_file_preimages',
        'runtime_named_snapshots',
        'runtime_sessions',
        'runtime_snapshots',
        'runtime_store_meta',
      ]);
      expect(indexes).toEqual([
        'idx_runtime_events_event_id',
        'idx_runtime_events_thread',
        'idx_runtime_file_preimages_position',
      ]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('persists one Host identity per session across restart without a second writer', () => {
    const root = testTempRoot('kite-store4-recovery-identity-');
    const path = join(root, 'runtime.db');
    try {
      let allocatorCalls = 0;
      const first = createSqliteRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        options: { journalMode: 'delete' },
      });
      const firstIdentity = first.recoveryIdentities.getOrCreate('session-identity', () => {
        allocatorCalls += 1;
        return 'b'.repeat(64);
      });
      expect(firstIdentity).toBe('b'.repeat(64));
      expect(
        first.recoveryIdentities.getOrCreate('session-identity', () => {
          allocatorCalls += 1;
          return 'c'.repeat(64);
        }),
      ).toBe('b'.repeat(64));
      expect(allocatorCalls).toBe(1);
      first.close();

      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        sessionId: 'session-identity',
        options: { journalMode: 'delete' },
      });
      expect(reopened.recoveryIdentities.read('session-identity')).toBe('b'.repeat(64));
      expect(
        reopened.recoveryIdentities.getOrCreate('session-identity', () => {
          allocatorCalls += 1;
          return 'd'.repeat(64);
        }),
      ).toBe('b'.repeat(64));
      expect(allocatorCalls).toBe(1);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes same-session identity creation across two Store 4 adapters', () => {
    const root = testTempRoot('kite-store4-recovery-race-');
    try {
      for (const journalMode of ['wal', 'delete'] as const) {
        const modePath = join(root, `${journalMode}.db`);
        const first = createSqliteRuntimeStorage<Event, State>({
          databasePath: modePath,
          codec,
          options: { journalMode },
        });
        first.close();
        const left = createSqliteRuntimeStorage<Event, State>({
          databasePath: modePath,
          codec,
          options: { journalMode },
        });
        const right = createSqliteRuntimeStorage<Event, State>({
          databasePath: modePath,
          codec,
          options: { journalMode },
        });
        let leftCalls = 0;
        let rightCalls = 0;
        expect(
          left.recoveryIdentities.getOrCreate('same-session', () => {
            leftCalls += 1;
            return 'e'.repeat(64);
          }),
        ).toBe('e'.repeat(64));
        expect(
          right.recoveryIdentities.getOrCreate('same-session', () => {
            rightCalls += 1;
            return 'f'.repeat(64);
          }),
        ).toBe('e'.repeat(64));
        expect(leftCalls).toBe(1);
        expect(rightCalls).toBe(0);
        left.close();
        right.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects invalid identity inputs, malformed persisted values, and closed adapters', () => {
    const root = testTempRoot('kite-store4-recovery-invalid-');
    const path = join(root, 'runtime.db');
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        options: { journalMode: 'delete' },
      });
      expect(() => storage.recoveryIdentities.read('')).toThrow('requires a sessionId');
      expect(() => storage.recoveryIdentities.getOrCreate('', () => 'a'.repeat(64))).toThrow(
        'requires a sessionId',
      );
      expect(() =>
        storage.recoveryIdentities.getOrCreate('invalid-allocator', () => 'bad'),
      ).toThrow('allocator returned an invalid key');
      expect(() =>
        storage.recoveryIdentities.getOrCreate(
          'missing-allocator',
          undefined as unknown as () => string,
        ),
      ).toThrow('requires a Host allocator');
      expect(storage.recoveryIdentities.getOrCreate('malformed', () => 'a'.repeat(64))).toBe(
        'a'.repeat(64),
      );
      storage.close();

      mutateDatabase(
        path,
        "UPDATE runtime_store_meta SET value = 'not-a-key' WHERE key LIKE 'recovery_identity_v1:%'",
      );
      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        options: { journalMode: 'delete' },
      });
      expect(() => reopened.recoveryIdentities.read('malformed')).toThrow(
        'Persisted runtime recovery identity is malformed',
      );
      expect(() =>
        reopened.recoveryIdentities.getOrCreate('malformed', () => 'b'.repeat(64)),
      ).toThrow('Persisted runtime recovery identity is malformed');
      reopened.close();
      expect(() => reopened.recoveryIdentities.read('malformed')).toThrow('storage is closed');
      expect(() =>
        reopened.recoveryIdentities.getOrCreate('malformed', () => 'c'.repeat(64)),
      ).toThrow('storage is closed');
      expect(() => reopened.recoveryIdentities.remove('malformed')).toThrow('storage is closed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes identity with SessionStore.deleteSession and supports explicit remove', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    expect(storage.recoveryIdentities.getOrCreate('remove-session', () => 'a'.repeat(64))).toBe(
      'a'.repeat(64),
    );
    expect(storage.recoveryIdentities.read('remove-session')).toBe('a'.repeat(64));
    storage.recoveryIdentities.remove('remove-session');
    expect(storage.recoveryIdentities.read('remove-session')).toBeNull();

    storage.transactions.commitDecision({
      sessionId: 'delete-session',
      events: [{ type: 'fact' }],
      snapshot: state('delete-session'),
      metadata: [{ eventId: 'delete-event', revision: 1 }],
    });
    expect(storage.recoveryIdentities.getOrCreate('delete-session', () => 'b'.repeat(64))).toBe(
      'b'.repeat(64),
    );
    storage.sessions.deleteSession('delete-session');
    expect(storage.recoveryIdentities.read('delete-session')).toBeNull();
    expect(storage.sessions.loadEventsStrict('delete-session')).toEqual([]);
    expect(storage.sessions.loadSnapshot<State>('delete-session')).toBeNull();
    storage.close();
  });

  test('returns an empty event tail after close without touching finalized statements', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    storage.sessions.appendEvents('closed-session', [{ type: 'fact' }]);
    storage.close();
    expect(storage.sessions.loadEventsStrict('closed-session')).toEqual([]);
  });

  test('maps all four acknowledgement classes to the same atomic event/snapshot primitive', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    const input = {
      sessionId: 'session-1',
      events: [{ type: 'fact' }],
      snapshot: state('session-1'),
      metadata: [
        {
          eventId: 'event-1',
          revision: 1,
          causationId: 'command-1',
          occurredAt: '2026-08-20T00:00:00.000Z',
        },
      ],
    } as const;
    storage.transactions.commitDecision(input);
    storage.transactions.commitAttemptStart({
      ...input,
      snapshot: state('session-1', 2),
      metadata: [{ ...input.metadata[0], eventId: 'event-2', revision: 2 }],
    });
    storage.transactions.commitReceiptEvidence({
      ...input,
      snapshot: state('session-1', 3),
      metadata: [{ ...input.metadata[0], eventId: 'event-3', revision: 3 }],
    });
    storage.transactions.commitTerminalRecovery({
      ...input,
      snapshot: state('session-1', 4),
      metadata: [{ ...input.metadata[0], eventId: 'event-4', revision: 4 }],
    });
    expect(storage.sessions.loadEventsStrict('session-1')).toHaveLength(4);
    expect(storage.sessions.loadSnapshot<State>('session-1')?.revision).toBe(4);
    storage.close();
  });

  test('reopens bytes through the supplied opaque codec and keeps named/fork behavior', () => {
    const root = testTempRoot('kite-store4-reopen-');
    const path = join(root, 'runtime.db');
    try {
      const first = createSqliteRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        options: { journalMode: 'delete' },
      });
      first.transactions.commitDecision({
        sessionId: 'source',
        events: [{ type: 'message', content: 'hello' }],
        snapshot: state('source'),
        metadata: [{ eventId: 'event-1', revision: 1 }],
      });
      first.checkpoints.saveNamedSnapshot(
        'source',
        'checkpoint',
        state('source'),
        first.sessions.getLastEventPosition('source'),
      );
      expect(first.checkpoints.restoreNamedSnapshot('source', 'checkpoint')).toBe(true);
      expect(first.checkpoints.forkSession('source', 'checkpoint', 'target', 'b'.repeat(64))).toBe(
        true,
      );
      expect(first.recoveryIdentities.read('source')).toBe('a'.repeat(64));
      expect(first.recoveryIdentities.read('target')).toBe('b'.repeat(64));
      first.close();
      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: path,
        codec,
        options: { journalMode: 'delete' },
        sessionId: 'target',
      });
      expect(reopened.sessions.loadEventsStrict('source')).toHaveLength(1);
      expect(reopened.sessions.loadSnapshot<State>('target')?.sessionId).toBe('target');
      let targetAllocatorCalls = 0;
      expect(
        reopened.recoveryIdentities.getOrCreate('target', () => {
          targetAllocatorCalls += 1;
          return 'b'.repeat(64);
        }),
      ).toBe('b'.repeat(64));
      expect(targetAllocatorCalls).toBe(0);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preflight rejects every State/epoch/session/revision mismatch before write', () => {
    const cases: readonly [string, (path: string) => void][] = [
      [
        'session identity',
        (path) =>
          mutateDatabase(path, 'UPDATE runtime_snapshots SET state_json = ?', [
            JSON.stringify(state('another-session')),
          ]),
      ],
      [
        'state schema version',
        (path) => mutateDatabase(path, 'UPDATE runtime_snapshots SET schema_version = 24'),
      ],
      [
        'state format epoch',
        (path) =>
          mutateDatabase(path, 'UPDATE runtime_snapshots SET state_json = ?', [
            JSON.stringify(state('session-1', 1, { formatEpoch: 'old-epoch' })),
          ]),
      ],
      [
        'snapshot revision',
        (path) => mutateDatabase(path, 'UPDATE runtime_snapshots SET state_revision = 99'),
      ],
      ['event revision', (path) => mutateDatabase(path, 'UPDATE runtime_events SET revision = 99')],
      [
        'store marker',
        (path) =>
          mutateDatabase(
            path,
            "UPDATE runtime_store_meta SET value = '5' WHERE key = 'format_version'",
          ),
      ],
    ];
    for (const [label, mutate] of cases) {
      const database = createPersistedBaseline();
      try {
        mutate(database.path);
        expectInvalidOpenPreservesFile(database.path);
      } finally {
        rmSync(database.root, { recursive: true, force: true });
      }
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test.skipIf(process.platform === 'win32')(
    'rejects final database and parent symlinks before any write',
    () => {
      const baseline = createPersistedBaseline();
      const root = testTempRoot('kite-store4-nofollow-path-');
      try {
        const linkedDatabase = join(root, 'linked.db');
        symlinkSync(baseline.path, linkedDatabase);
        const before = closeAndRead(baseline.path);
        expect(() =>
          createSqliteRuntimeStorage<Event, State>({
            databasePath: linkedDatabase,
            codec,
            options: { journalMode: 'delete' },
          }),
        ).toThrow(SqliteRuntimeStorageOpenError);
        expect(closeAndRead(baseline.path)).toEqual(before);
        rmSync(linkedDatabase, { force: true });

        const realParent = join(root, 'real-parent');
        const linkedParent = join(root, 'linked-parent');
        mkdirSync(realParent);
        symlinkSync(realParent, linkedParent, 'dir');
        const nestedDatabase = join(linkedParent, 'runtime.db');
        expect(() =>
          createSqliteRuntimeStorage<Event, State>({
            databasePath: nestedDatabase,
            codec,
            options: { journalMode: 'delete' },
          }),
        ).toThrow(SqliteRuntimeStorageOpenError);
        expect(() => statSync(join(realParent, 'runtime.db'))).toThrow();
      } finally {
        rmSync(baseline.root, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects WAL and SHM symlink sources without modifying the main database',
    () => {
      const baseline = createPersistedBaseline();
      const external = testTempRoot('kite-store4-nofollow-sidecar-');
      try {
        for (const suffix of ['-wal', '-shm'] as const) {
          const sidecar = `${baseline.path}${suffix}`;
          const target = join(external, `external${suffix}`);
          writeFileSync(target, 'must-not-be-followed');
          symlinkSync(target, sidecar);
          const before = closeAndRead(baseline.path);
          expect(() =>
            createSqliteRuntimeStorage<Event, State>({
              databasePath: baseline.path,
              codec,
              options: { journalMode: 'delete' },
            }),
          ).toThrow(SqliteRuntimeStorageOpenError);
          expect(closeAndRead(baseline.path)).toEqual(before);
          rmSync(sidecar, { force: true });
        }
      } finally {
        rmSync(baseline.root, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    },
  );

  test('restores and forks with current-only pending-request filtering', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    storage.transactions.commitDecision({
      sessionId: 'source',
      events: [
        { type: 'pending-request', pendingRequestId: 'interaction-1' },
        { type: 'follow-up' },
      ],
      snapshot: state('source', 2, { pendingRequestId: 'interaction-1' }),
      metadata: [
        { eventId: 'event-1', revision: 1 },
        { eventId: 'event-2', revision: 2 },
      ],
    });
    storage.checkpoints.saveNamedSnapshot(
      'source',
      'checkpoint',
      state('source', 2, { pendingRequestId: 'interaction-1' }),
      2,
    );
    storage.transactions.commitDecision({
      sessionId: 'source',
      events: [{ type: 'after-checkpoint' }],
      snapshot: state('source', 3, { pendingRequestId: 'interaction-1' }),
      metadata: [{ eventId: 'event-3', revision: 3 }],
    });

    expect(storage.checkpoints.forkCurrentSession('source', 'current-target', 'b'.repeat(64))).toBe(
      true,
    );
    expect(
      storage.checkpoints.forkSession('source', 'checkpoint', 'named-target', 'c'.repeat(64)),
    ).toBe(true);
    expect(
      storage.sessions.loadEventsStrict('current-target').map((entry) => entry.event.type),
    ).toEqual(['follow-up', 'after-checkpoint']);
    expect(
      storage.sessions.loadEventsStrict('named-target').map((entry) => entry.event.type),
    ).toEqual(['pending-request', 'follow-up']);

    expect(storage.checkpoints.restoreNamedSnapshot('source', 'checkpoint')).toBe(true);
    expect(storage.sessions.loadEventsStrict('source')).toHaveLength(2);
    expect(storage.sessions.loadSnapshot<State>('source')?.revision).toBe(2);
    storage.close();
  });

  test('rejects pending cleanup forks without writing the target', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    storage.transactions.commitDecision({
      sessionId: 'blocked-source',
      events: [{ type: 'fact' }],
      snapshot: state('blocked-source', 1, { cleanupBlocked: true }),
      metadata: [{ eventId: 'event-1', revision: 1 }],
    });
    expect(
      storage.checkpoints.forkCurrentSession('blocked-source', 'blocked-target', 'b'.repeat(64)),
    ).toBe(false);
    expect(storage.sessions.loadEventsStrict('blocked-target')).toEqual([]);
    expect(storage.sessions.loadSnapshot<State>('blocked-target')).toBeNull();
    expect(storage.sessions.listSessions('', 50).map((session) => session.threadId)).toEqual([
      'blocked-source',
    ]);
    storage.close();
  });

  test('rejects a fork when persisted and State recovery identities disagree', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    storage.transactions.commitDecision({
      sessionId: 'identity-source',
      events: [{ type: 'fact' }],
      snapshot: state('identity-source', 1, { recoveryIdentity: 'a'.repeat(64) }),
      metadata: [{ eventId: 'event-1', revision: 1 }],
    });
    storage.transactions.commitDecision({
      sessionId: 'identity-target',
      events: [{ type: 'existing' }],
      snapshot: state('identity-target', 1, { recoveryIdentity: 'c'.repeat(64) }),
      metadata: [{ eventId: 'target-event-1', revision: 1 }],
    });
    expect(storage.recoveryIdentities.getOrCreate('identity-source', () => 'b'.repeat(64))).toBe(
      'b'.repeat(64),
    );
    expect(storage.recoveryIdentities.getOrCreate('identity-target', () => 'c'.repeat(64))).toBe(
      'c'.repeat(64),
    );

    expect(
      storage.checkpoints.forkCurrentSession('identity-source', 'identity-target', 'd'.repeat(64)),
    ).toBe(false);
    expect(
      storage.sessions.loadEventsStrict('identity-target').map((entry) => entry.event.type),
    ).toEqual(['existing']);
    expect(storage.recoveryIdentities.read('identity-target')).toBe('c'.repeat(64));
    storage.close();
  });

  test('rolls back revision conflicts before appending events', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    storage.transactions.commitDecision({
      sessionId: 'revision-session',
      events: [{ type: 'first' }],
      snapshot: state('revision-session'),
      metadata: [{ eventId: 'event-1', revision: 1 }],
    });
    expect(() =>
      storage.transactions.commitDecision({
        sessionId: 'revision-session',
        events: [{ type: 'conflicting' }],
        snapshot: state('revision-session', 3),
        metadata: [{ eventId: 'event-3', revision: 3 }],
      }),
    ).toThrow(SqliteRuntimeRevisionConflictError);
    expect(storage.sessions.loadEventsStrict('revision-session')).toHaveLength(1);
    expect(storage.sessions.loadSnapshot<State>('revision-session')?.revision).toBe(1);
    storage.close();
  });

  test('rejects stale effect leases atomically', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    expect(
      storage.effects.tryAcquireEffectLease(
        'lease-session',
        'effect-1',
        'owner-a',
        Date.now() + 60_000,
      ),
    ).toBe(true);
    expect(() =>
      storage.transactions.commitAttemptStart({
        sessionId: 'lease-session',
        events: [{ type: 'lease-attempt' }],
        snapshot: state('lease-session'),
        metadata: [{ eventId: 'lease-event-1', revision: 1 }],
        requiredEffectLease: {
          effectId: 'effect-1',
          ownerId: 'owner-b',
          observedAtMs: Date.now(),
        },
      }),
    ).toThrow(SqliteRuntimeEffectLeaseConflictError);
    expect(storage.sessions.loadEventsStrict('lease-session')).toEqual([]);
    expect(storage.sessions.loadSnapshot<State>('lease-session')).toBeNull();
    storage.close();
  });

  test('keeps token stats behind an explicit metadata port', () => {
    const root = testTempRoot('kite-rmv1-stats-');
    const databasePath = join(root, 'runtime.db');
    try {
      const first = createSqliteSessionTokenStatsV1({
        databasePath,
        journalMode: 'delete',
        assertCanOpen: () => {},
      });
      first.save('session-1', { cacheHitTokens: 3, cacheMissTokens: 5, totalTokens: 8 });
      first.close();
      const reopened = createSqliteSessionTokenStatsV1({
        databasePath,
        journalMode: 'delete',
        assertCanOpen: () => {},
      });
      expect(reopened.loadAll()).toEqual([
        {
          sessionId: 'session-1',
          value: { cacheHitTokens: 3, cacheMissTokens: 5, totalTokens: 8 },
        },
      ]);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
