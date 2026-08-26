import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSqliteRuntimeStorage,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  SqliteRuntimeCommandReceiptConflictError,
  SqliteRuntimeCommandReceiptValidationError,
  SqliteRuntimeFormatMismatchError,
  sqliteRuntimeStorePath,
} from '../src/index';

type Event = { type: string; content?: string };
type State = {
  schemaVersion: 27;
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
  decodeEvent: (json: string) => JSON.parse(json) as Event,
  encodeState: JSON.stringify,
  decodeState: <T>(json: string) => JSON.parse(json) as T,
  snapshotMetadata: (state: State) => ({ stateRevision: state.revision, schemaVersion: 27 }),
  sessionIdentity: (state: State) => ({
    projectId: state.session.projectId,
    canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest,
  }),
  validateSnapshot: (input: {
    state: State;
    sessionId: string;
    stateRevision: number;
    schemaVersion: number;
    eventRevision: number;
  }) => {
    if (
      input.state.session.threadId !== input.sessionId ||
      input.state.schemaVersion !== 27 ||
      input.state.formatEpoch !== SQLITE_RUNTIME_FORMAT_EPOCH ||
      input.stateRevision !== input.state.revision ||
      input.schemaVersion !== 27 ||
      input.eventRevision !== input.state.revision
    ) {
      throw new Error('invalid current snapshot');
    }
  },
  rebindForkState: (state: State, sessionId: string) => ({
    ...state,
    session: { ...state.session, threadId: sessionId },
  }),
};

function state(threadId: string, revision = 1): State {
  return {
    schemaVersion: 27,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    revision,
    session: {
      threadId,
      projectId: `project_${threadId}`,
      canonicalWorkspaceDigest: `sha256:${'a'.repeat(64)}`,
    },
  };
}

function commandReceipt(
  scopeSessionId: string,
  commandId: string,
  targetSessionId: string,
  committedRevision: number,
  requestDigest = 'a'.repeat(64),
) {
  return {
    scopeSessionId,
    commandId,
    requestDigest,
    targetSessionId,
    originalReceiptJson: JSON.stringify({
      status: 'applied',
      commandId,
      sessionId: targetSessionId,
      revision: committedRevision,
    }),
    committedRevision,
    committedAt: 1_700_000_000_000,
  } as const;
}

function forkEvidence(
  sourceSessionId: string,
  targetSessionId: string,
  commandId = 'fork-command',
  requestDigest = 'c'.repeat(64),
) {
  return {
    scopeSessionId: sourceSessionId,
    commandId,
    requestDigest,
    targetSessionId,
    committedAt: 1_700_000_000_100,
  } as const;
}

function temporaryDatabase(): { path: string; cleanup(): void } {
  const directory = mkdtempSync(join(process.cwd(), '.kite-store-'));
  return {
    path: join(directory, 'runtime.db'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('State/Store production format', () => {
  test('publishes the current profile and a separate path', () => {
    expect(SQLITE_RUNTIME_STATE_SCHEMA_VERSION).toBe(27);
    expect(SQLITE_RUNTIME_STORE_SCHEMA_VERSION).toBe(6);
    expect(SQLITE_RUNTIME_FORMAT_EPOCH).toBe('kite-runtime-server-v1-2026-08-26');
    expect(sqliteRuntimeStorePath('/tmp/checkpoints.sqlite')).toBe(
      '/tmp/checkpoints.runtime-state-store.db',
    );
  });

  test('creates the Store 6 receipt table and only the two non-primary-key indexes', () => {
    const fixture = temporaryDatabase();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      storage.close();
      const database = new Database(fixture.path, { readonly: true });
      const tables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      const indexes = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      database.close();
      expect(tables).toEqual([
        'runtime_command_receipts',
        'runtime_effect_leases',
        'runtime_events',
        'runtime_file_preimages',
        'runtime_named_snapshots',
        'runtime_sessions',
        'runtime_snapshots',
        'runtime_store_meta',
      ]);
      expect(indexes).toEqual([
        'runtime_events_session_sequence',
        'runtime_file_preimages_position',
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects Store 6 receipt DDL drift and extra receipt indexes before opening a writer', () => {
    const fixture = temporaryDatabase();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      storage.close();
      const database = new Database(fixture.path);
      database.run(
        'CREATE INDEX runtime_command_receipts_target ON runtime_command_receipts(target_session_id)',
      );
      database.close();
      expect(() =>
        createSqliteRuntimeStorage<Event, State>({
          databasePath: fixture.path,
          codec,
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatMismatchError);
    } finally {
      fixture.cleanup();
    }
  });

  test('persists, reopens and forks current state without authority side tables', () => {
    const fixture = temporaryDatabase();
    try {
      const first = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      const source = state('source');
      first.transactions.commitDecision({
        sessionId: 'source',
        events: [{ type: 'committed' }],
        snapshot: source,
        metadata: [{ eventId: 'event-1', revision: 1 }],
      });
      first.checkpoints.saveNamedSnapshot('source', 'checkpoint', source, 1);
      expect(first.checkpoints.forkSession('source', 'checkpoint', 'fork', 'f'.repeat(64))).toBe(
        true,
      );
      first.close();

      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      expect(reopened.sessions.loadSnapshot<State>('source')).toEqual(source);
      expect(reopened.sessions.loadEventsStrict('fork')).toHaveLength(1);
      expect(reopened.sessions.loadSnapshot<State>('fork')).toMatchObject({
        session: { threadId: 'fork' },
      });
      reopened.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('persists a scoped command receipt atomically with its State decision', () => {
    const fixture = temporaryDatabase();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      const receipt = commandReceipt('scope-a', 'command-a', 'target-a', 1);
      storage.transactions.commitDecision({
        sessionId: 'target-a',
        events: [{ type: 'committed' }],
        snapshot: state('target-a'),
        metadata: [{ eventId: 'event-a', revision: 1 }],
        commandReceipt: receipt,
      });

      expect(
        storage.commandReceipts?.lookup({
          scopeSessionId: 'scope-a',
          commandId: 'command-a',
          requestDigest: 'a'.repeat(64),
        }),
      ).toEqual({ status: 'replay', receipt });
      expect(
        storage.commandReceipts?.lookup({
          scopeSessionId: 'scope-a',
          commandId: 'command-a',
          requestDigest: 'b'.repeat(64),
        }),
      ).toMatchObject({ status: 'digest_mismatch', receipt });
      storage.close();

      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      expect(
        reopened.commandReceipts?.lookup({
          scopeSessionId: 'scope-a',
          commandId: 'command-a',
          requestDigest: 'a'.repeat(64),
        }),
      ).toEqual({ status: 'replay', receipt });
      reopened.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('atomically deletes durable session State while retaining its scoped command receipt', () => {
    const fixture = temporaryDatabase();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      storage.transactions.commitDecision({
        sessionId: 'deleted-session',
        events: [{ type: 'committed' }],
        snapshot: state('deleted-session'),
        metadata: [{ eventId: 'deleted-event', revision: 1 }],
      });
      const receipt = commandReceipt('deleted-session', 'delete-command', 'deleted-session', 1);
      storage.sessions.deleteSession('deleted-session', {
        expectedRevision: 1,
        commandReceipt: receipt,
      });
      expect(storage.sessions.loadSnapshot('deleted-session')).toBeNull();
      expect(storage.sessions.loadEventsStrict('deleted-session')).toEqual([]);
      expect(
        storage.commandReceipts.lookup({
          scopeSessionId: 'deleted-session',
          commandId: 'delete-command',
          requestDigest: receipt.requestDigest,
        }),
      ).toEqual({ status: 'replay', receipt });
      storage.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('commits a snapshot-only command decision with its receipt, but never invents one', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    const receipt = commandReceipt('scope-idle', 'idle-close', 'idle-session', 1);
    storage.transactions.commitDecision({
      sessionId: 'idle-session',
      events: [],
      snapshot: state('idle-session', 1),
      commandReceipt: receipt,
    });
    expect(storage.sessions.loadEventsStrict('idle-session')).toEqual([]);
    expect(storage.sessions.loadSnapshot<State>('idle-session')).toEqual(state('idle-session', 1));
    expect(
      storage.commandReceipts?.lookup({
        scopeSessionId: 'scope-idle',
        commandId: 'idle-close',
        requestDigest: 'a'.repeat(64),
      }),
    ).toEqual({ status: 'replay', receipt });

    expect(() =>
      storage.transactions.commitDecision({
        sessionId: 'wrong-revision',
        events: [],
        snapshot: state('wrong-revision', 1),
        commandReceipt: commandReceipt('scope-idle', 'wrong-revision', 'wrong-revision', 2),
      }),
    ).toThrow(SqliteRuntimeCommandReceiptValidationError);
    expect(storage.sessions.loadSnapshot('wrong-revision')).toBeNull();

    storage.transactions.commitDecision({
      sessionId: 'ordinary-session',
      events: [],
      snapshot: state('ordinary-session', 0),
    });
    expect(storage.sessions.loadSnapshot<State>('ordinary-session')).toEqual(
      state('ordinary-session', 0),
    );
    expect(
      storage.commandReceipts?.lookup({
        scopeSessionId: 'ordinary-session',
        commandId: 'ordinary-snapshot',
        requestDigest: 'b'.repeat(64),
      }),
    ).toEqual({ status: 'missing' });
    storage.close();
  });

  test('rolls back event and snapshot writes on a duplicate or forged receipt', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    const initialReceipt = commandReceipt('scope-a', 'command-a', 'target-a', 1);
    storage.transactions.commitDecision({
      sessionId: 'target-a',
      events: [{ type: 'first' }],
      snapshot: state('target-a', 1),
      metadata: [{ eventId: 'event-1', revision: 1 }],
      commandReceipt: initialReceipt,
    });

    expect(() =>
      storage.transactions.commitDecision({
        sessionId: 'target-a',
        events: [{ type: 'must-roll-back' }],
        snapshot: state('target-a', 2),
        metadata: [{ eventId: 'event-2', revision: 2 }],
        commandReceipt: commandReceipt('scope-a', 'command-a', 'target-a', 2),
      }),
    ).toThrow(SqliteRuntimeCommandReceiptConflictError);
    expect(storage.sessions.loadEventsStrict('target-a')).toEqual([
      expect.objectContaining({ event: { type: 'first' } }),
    ]);
    expect(storage.sessions.loadSnapshot<State>('target-a')).toEqual(state('target-a', 1));

    const forged = {
      ...commandReceipt('scope-b', 'command-b', 'target-b', 1),
      originalReceiptJson:
        '{"commandId":"command-b","status":"applied","sessionId":"target-b","revision":1}',
    };
    expect(() =>
      storage.transactions.commitDecision({
        sessionId: 'target-b',
        events: [{ type: 'forged' }],
        snapshot: state('target-b', 1),
        metadata: [{ eventId: 'event-b', revision: 1 }],
        commandReceipt: forged,
      }),
    ).toThrow(SqliteRuntimeCommandReceiptValidationError);
    expect(storage.sessions.loadSnapshot('target-b')).toBeNull();
    expect(
      storage.commandReceipts?.lookup({
        scopeSessionId: 'scope-b',
        commandId: 'command-b',
        requestDigest: 'a'.repeat(64),
      }),
    ).toEqual({ status: 'missing' });
    storage.close();
  });

  test('rolls back a receipt-bearing decision on an injected SQLite full fault', () => {
    const fixture = temporaryDatabase();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete', faultInjectionMaxPageCount: 1 },
      });
      expect(() =>
        storage.transactions.commitDecision({
          sessionId: 'full-session',
          events: [{ type: 'full', content: 'x'.repeat(1_000_000) }],
          snapshot: state('full-session', 1),
          metadata: [{ eventId: 'full-event', revision: 1 }],
          commandReceipt: commandReceipt('full-session', 'full-command', 'full-session', 1),
        }),
      ).toThrow(/Failed to persist runtime transaction/u);
      expect(storage.sessions.loadSnapshot('full-session')).toBeNull();
      expect(
        storage.commandReceipts?.lookup({
          scopeSessionId: 'full-session',
          commandId: 'full-command',
          requestDigest: 'a'.repeat(64),
        }),
      ).toEqual({ status: 'missing' });
      storage.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('retains source receipts across delete and does not copy them while forking', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    const receipt = commandReceipt('source', 'command-a', 'source', 1);
    storage.transactions.commitDecision({
      sessionId: 'source',
      events: [{ type: 'committed' }],
      snapshot: state('source'),
      metadata: [{ eventId: 'event-1', revision: 1 }],
      commandReceipt: receipt,
    });
    storage.checkpoints.saveNamedSnapshot('source', 'checkpoint', state('source'), 1);
    expect(storage.checkpoints.forkSession('source', 'checkpoint', 'fork', 'f'.repeat(64))).toBe(
      true,
    );
    expect(
      storage.commandReceipts?.lookup({
        scopeSessionId: 'fork',
        commandId: 'command-a',
        requestDigest: 'a'.repeat(64),
      }),
    ).toEqual({ status: 'missing' });
    storage.sessions.deleteSession('source');
    expect(
      storage.commandReceipts?.lookup({
        scopeSessionId: 'source',
        commandId: 'command-a',
        requestDigest: 'a'.repeat(64),
      }),
    ).toEqual({ status: 'replay', receipt });
    storage.close();
  });

  test('commits a command fork and its scoped receipt atomically, then replays after reopen', () => {
    const fixture = temporaryDatabase();
    try {
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      const sourceReceipt = commandReceipt('source', 'source-command', 'source', 1);
      storage.transactions.commitDecision({
        sessionId: 'source',
        events: [{ type: 'source' }],
        snapshot: state('source'),
        metadata: [{ eventId: 'source-event', revision: 1 }],
        commandReceipt: sourceReceipt,
      });
      storage.checkpoints.saveNamedSnapshot('source', 'checkpoint', state('source'), 1);
      const evidence = forkEvidence('source', 'command-fork');
      const result = storage.checkpoints.forkSessionForCommand({
        sourceSessionId: 'source',
        snapshotId: 'checkpoint',
        targetSessionId: 'command-fork',
        targetRecoveryIdentityKey: 'f'.repeat(64),
        commandEvidence: evidence,
      });
      expect(result).toEqual({
        status: 'applied',
        receipt: {
          ...commandReceipt('source', 'fork-command', 'command-fork', 1, 'c'.repeat(64)),
          committedAt: evidence.committedAt,
        },
      });
      expect(storage.sessions.loadSnapshot<State>('command-fork')).toMatchObject({
        session: { threadId: 'command-fork' },
      });
      expect(
        storage.commandReceipts?.lookup({
          scopeSessionId: 'source',
          commandId: 'source-command',
          requestDigest: 'a'.repeat(64),
        }),
      ).toEqual({ status: 'replay', receipt: sourceReceipt });
      expect(
        storage.commandReceipts?.lookup({
          scopeSessionId: 'command-fork',
          commandId: 'source-command',
          requestDigest: 'a'.repeat(64),
        }),
      ).toEqual({ status: 'missing' });
      storage.close();

      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      expect(
        reopened.commandReceipts?.lookup({
          scopeSessionId: 'source',
          commandId: 'fork-command',
          requestDigest: 'c'.repeat(64),
        }),
      ).toEqual({
        status: 'replay',
        receipt: {
          ...commandReceipt('source', 'fork-command', 'command-fork', 1, 'c'.repeat(64)),
          committedAt: evidence.committedAt,
        },
      });
      reopened.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('rolls back a command fork target when its scoped receipt conflicts', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    storage.transactions.commitDecision({
      sessionId: 'source',
      events: [{ type: 'source' }],
      snapshot: state('source'),
      metadata: [{ eventId: 'source-event', revision: 1 }],
    });
    storage.checkpoints.saveNamedSnapshot('source', 'checkpoint', state('source'), 1);
    expect(storage.checkpoints.forkSession('source', 'checkpoint', 'target', 'f'.repeat(64))).toBe(
      true,
    );
    const targetBefore = storage.sessions.loadSnapshot<State>('target');
    storage.transactions.commitDecision({
      sessionId: 'receipt-holder',
      events: [{ type: 'receipt-holder' }],
      snapshot: state('receipt-holder'),
      metadata: [{ eventId: 'receipt-event', revision: 1 }],
      commandReceipt: commandReceipt('source', 'fork-command', 'receipt-holder', 1, 'c'.repeat(64)),
    });
    expect(() =>
      storage.checkpoints.forkSessionForCommand({
        sourceSessionId: 'source',
        snapshotId: 'checkpoint',
        targetSessionId: 'target',
        targetRecoveryIdentityKey: 'e'.repeat(64),
        commandEvidence: forkEvidence('source', 'target'),
      }),
    ).toThrow(SqliteRuntimeCommandReceiptConflictError);
    expect(storage.sessions.loadSnapshot<State>('target')).toEqual(targetBefore);
    storage.close();
  });

  test('throws an injected SQLite full fault while rolling back a command fork target and receipt', () => {
    const fixture = temporaryDatabase();
    try {
      const initial = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      initial.transactions.commitDecision({
        sessionId: 'source',
        events: [{ type: 'source', content: 'x'.repeat(1_000_000) }],
        snapshot: state('source'),
        metadata: [{ eventId: 'source-event', revision: 1 }],
      });
      initial.checkpoints.saveNamedSnapshot('source', 'checkpoint', state('source'), 1);
      initial.close();

      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete', faultInjectionMaxPageCount: 1 },
      });
      expect(() =>
        storage.checkpoints.forkSessionForCommand({
          sourceSessionId: 'source',
          snapshotId: 'checkpoint',
          targetSessionId: 'fault-target',
          targetRecoveryIdentityKey: 'e'.repeat(64),
          commandEvidence: forkEvidence('source', 'fault-target'),
        }),
      ).toThrow();
      expect(storage.sessions.loadSnapshot('fault-target')).toBeNull();
      expect(
        storage.commandReceipts?.lookup({
          scopeSessionId: 'source',
          commandId: 'fork-command',
          requestDigest: 'c'.repeat(64),
        }),
      ).toEqual({ status: 'missing' });
      storage.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects invalid or unavailable command fork inputs without target or receipt writes', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    storage.transactions.commitDecision({
      sessionId: 'source',
      events: [{ type: 'source' }],
      snapshot: state('source'),
      metadata: [{ eventId: 'source-event', revision: 1 }],
    });
    storage.checkpoints.saveNamedSnapshot('source', 'checkpoint', state('source'), 1);
    const base = {
      sourceSessionId: 'source',
      snapshotId: 'checkpoint',
      targetRecoveryIdentityKey: 'f'.repeat(64),
    };
    for (const input of [
      {
        ...base,
        targetSessionId: 'wrong-scope',
        commandEvidence: forkEvidence('other-scope', 'wrong-scope'),
      },
      {
        ...base,
        targetSessionId: 'wrong-target',
        commandEvidence: forkEvidence('source', 'not-the-target'),
      },
      {
        ...base,
        targetSessionId: 'bad-digest',
        commandEvidence: { ...forkEvidence('source', 'bad-digest'), requestDigest: 'invalid' },
      },
      {
        ...base,
        sourceSessionId: 'missing-source',
        targetSessionId: 'missing-target',
        commandEvidence: forkEvidence('missing-source', 'missing-target'),
      },
    ]) {
      expect(storage.checkpoints.forkSessionForCommand(input)).toEqual({ status: 'unavailable' });
      expect(storage.sessions.loadSnapshot(input.targetSessionId)).toBeNull();
      expect(
        storage.commandReceipts?.lookup({
          scopeSessionId: input.commandEvidence.scopeSessionId,
          commandId: input.commandEvidence.commandId,
          requestDigest: /^[a-f0-9]{64}$/u.test(input.commandEvidence.requestDigest)
            ? input.commandEvidence.requestDigest
            : 'd'.repeat(64),
        }),
      ).toEqual({ status: 'missing' });
    }
    expect(
      storage.checkpoints.forkSession('source', 'checkpoint', 'ordinary', 'd'.repeat(64)),
    ).toBe(true);
    expect(
      storage.commandReceipts?.lookup({
        scopeSessionId: 'source',
        commandId: 'ordinary-fork',
        requestDigest: 'd'.repeat(64),
      }),
    ).toEqual({ status: 'missing' });
    storage.close();
  });

  test('stops decoding a session journal after finding its naming event', () => {
    let decodedEvents = 0;
    const summaryCodec = {
      ...codec,
      decodeEvent: (json: string): Event => {
        decodedEvents += 1;
        return JSON.parse(json) as Event;
      },
      eventSummary: (event: Event) =>
        event.type === 'user.message_appended' && event.content
          ? { isSessionNameCandidate: true, searchText: event.content }
          : null,
    };
    const storage = createSqliteRuntimeStorage<Event, State>({
      databasePath: ':memory:',
      codec: summaryCodec,
    });
    const events: Event[] = [
      { type: 'turn.started' },
      { type: 'user.message_appended', content: 'fast startup' },
      ...Array.from({ length: 500 }, () => ({ type: 'model.delta' })),
    ];
    storage.transactions.commitDecision({
      sessionId: 'long-session',
      events,
      snapshot: state('long-session', events.length),
      metadata: events.map((_, index) => ({
        eventId: `event-${index + 1}`,
        revision: index + 1,
      })),
    });

    expect(storage.sessions.listSessions()).toEqual([
      expect.objectContaining({
        threadId: 'long-session',
        name: 'fast startup',
        needsSmartName: true,
      }),
    ]);
    expect(decodedEvents).toBe(2);
    storage.close();
  });

  test('keeps healthy sessions discoverable when one session summary event is malformed', () => {
    const fixture = temporaryDatabase();
    try {
      const summaryCodec = {
        ...codec,
        eventSummary: (event: Event) =>
          event.type === 'user.message_appended' && event.content
            ? { isSessionNameCandidate: true, searchText: event.content }
            : null,
      };
      const storage = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec: summaryCodec,
        options: { journalMode: 'delete' },
      });
      for (const sessionId of ['healthy', 'broken']) {
        storage.transactions.commitDecision({
          sessionId,
          events: [{ type: 'user.message_appended', content: sessionId }],
          snapshot: state(sessionId),
          metadata: [{ eventId: `${sessionId}-event`, revision: 1 }],
        });
      }
      storage.close();
      const database = new Database(fixture.path);
      database.run("UPDATE runtime_events SET event_json = '{broken' WHERE session_id = 'broken'");
      database.close();

      const reopened = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec: summaryCodec,
        options: { journalMode: 'delete' },
      });
      expect(reopened.sessions.listSessions()).toEqual(
        expect.arrayContaining([expect.objectContaining({ threadId: 'healthy', name: 'healthy' })]),
      );
      expect(() => reopened.sessions.loadEventsStrict('broken')).toThrow();
      reopened.close();
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects legacy metadata before a transaction creates current rows', () => {
    const storage = createSqliteRuntimeStorage<Event, State>({ databasePath: ':memory:', codec });
    expect(() =>
      storage.transactions.commitDecision({
        sessionId: 'legacy-metadata',
        events: [],
        snapshot: state('legacy-metadata', 0),
        snapshotMetadata: {
          eventPosition: 0,
          stateRevision: 0,
          stateChecksum: '',
          schemaVersion: 25,
        },
      }),
    ).toThrow(/Runtime format is incompatible/u);
    expect(storage.sessions.loadSnapshot('legacy-metadata')).toBeNull();
    storage.close();
  });

  test('distinguishes a truly fresh database from corrupt or missing current snapshots', () => {
    const fixture = temporaryDatabase();
    try {
      const first = createSqliteRuntimeStorage<Event, State>({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      first.transactions.commitDecision({
        sessionId: 'corrupt',
        events: [{ type: 'committed' }],
        snapshot: state('corrupt'),
        metadata: [{ eventId: 'event-1', revision: 1 }],
      });
      first.close();
      const database = new Database(fixture.path);
      database.run(
        "UPDATE runtime_snapshots SET state_json = '{\"tampered\":true}' WHERE session_id = 'corrupt'",
      );
      database.close();
      const discovery = createSqliteRuntimeStorage({
        databasePath: fixture.path,
        codec,
        options: { journalMode: 'delete' },
      });
      discovery.close();
      expect(() =>
        createSqliteRuntimeStorage({
          databasePath: fixture.path,
          codec,
          sessionId: 'corrupt',
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatMismatchError);
    } finally {
      fixture.cleanup();
    }

    const missing = temporaryDatabase();
    try {
      const first = createSqliteRuntimeStorage<Event, State>({
        databasePath: missing.path,
        codec,
        options: { journalMode: 'delete' },
      });
      first.transactions.commitDecision({
        sessionId: 'missing',
        events: [{ type: 'committed' }],
        snapshot: state('missing'),
        metadata: [{ eventId: 'event-1', revision: 1 }],
      });
      first.close();
      const database = new Database(missing.path);
      database.run("DELETE FROM runtime_snapshots WHERE session_id = 'missing'");
      database.close();
      const discovery = createSqliteRuntimeStorage({
        databasePath: missing.path,
        codec,
        options: { journalMode: 'delete' },
      });
      discovery.close();
      expect(() =>
        createSqliteRuntimeStorage({
          databasePath: missing.path,
          codec,
          sessionId: 'missing',
          options: { journalMode: 'delete' },
        }),
      ).toThrow(SqliteRuntimeFormatMismatchError);
    } finally {
      missing.cleanup();
    }
  });
});
