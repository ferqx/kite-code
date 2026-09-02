import type { Database } from 'bun:sqlite';
import type {
  CheckpointPort,
  RuntimeCommandForkInput,
  RuntimeCommandForkResult,
  RuntimeFileRestoreMaterial,
  RuntimeStoredCommandReceipt,
  StoredRuntimeEvent,
} from '@kite-ai/runtime-host/storage';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import type { SqliteRuntimeCommandReceiptWriter } from './command-receipts';
import type { createSqliteEventStore } from './event-store';
import type { KiteHomeRecoveryIdentityLedger } from './kite-home-recovery-identities';
import type { KiteHomeWorkspaceSessionStore } from './kite-home-workspaces';
import type { KiteHomeWriteTransactionPort } from './kite-home-write';
import {
  checksum,
  isCanonicalRecoveryIdentity,
  type NamedSnapshotRow,
  type SnapshotRow,
  type SqliteRuntimeSnapshotCodec,
} from './preflight';
import type { createSqliteSnapshotStore } from './snapshot-store';

type EventStore<Event> = ReturnType<typeof createSqliteEventStore<Event>>;
type SnapshotStore<Event, State> = ReturnType<typeof createSqliteSnapshotStore<Event, State>>;

/** Store 9 checkpoint, fork and file-preimage port over the already-open shared connection. */
export function createKiteHomeCheckpointStore<Event, State>(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly isClosed: () => boolean;
  readonly sessions: KiteHomeWorkspaceSessionStore<State>;
  readonly events: EventStore<Event>;
  readonly snapshots: SnapshotStore<Event, State>;
  readonly recovery: KiteHomeRecoveryIdentityLedger;
  readonly runs: NonNullable<import('@kite-ai/runtime-host/storage').RuntimeStorage['runs']>;
  readonly receiptWriter: SqliteRuntimeCommandReceiptWriter;
  /** Target Session generation 1, created after its row exists in the same fork transaction. */
  readonly createForkTargetAuthorityInTransaction?: (targetSessionId: string) => void;
  readonly now?: () => number;
}): CheckpointPort<State> {
  const now = input.now ?? Date.now;
  const upsertNamed = input.database.query(
    `INSERT OR REPLACE INTO runtime_named_snapshots(
      session_id, name, schema_version, format_epoch, revision, state_json,
      event_position, state_checksum, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertForkNamed = input.database.query(
    `INSERT INTO runtime_named_snapshots(
      session_id, name, schema_version, format_epoch, revision, state_json,
      event_position, state_checksum, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectNamed = input.database.query<NamedSnapshotRow, [string, string]>(
    `SELECT session_id AS thread_id, name, state_json, event_position,
            revision AS state_revision, state_checksum, schema_version, created_at
       FROM runtime_named_snapshots WHERE session_id = ? AND name = ? LIMIT 1`,
  );
  const selectNamedThrough = input.database.query<NamedSnapshotRow, [string, number]>(
    `SELECT session_id AS thread_id, name, state_json, event_position,
            revision AS state_revision, state_checksum, schema_version, created_at
       FROM runtime_named_snapshots WHERE session_id = ? AND event_position <= ?
      ORDER BY event_position ASC, name ASC`,
  );
  const listNamed = input.database.query<
    { name: string; event_position: number; created_at: number; affected_file_count: number },
    [string]
  >(
    `SELECT s.name, s.event_position, s.created_at,
      (SELECT count(DISTINCT p.path) FROM runtime_file_preimages AS p
        WHERE p.session_id = s.session_id AND p.event_position > s.event_position)
        AS affected_file_count
      FROM runtime_named_snapshots AS s WHERE s.session_id = ?
      ORDER BY s.event_position DESC, s.name DESC`,
  );
  const deleteNamedAfter = input.database.query(
    'DELETE FROM runtime_named_snapshots WHERE session_id = ? AND event_position > ?',
  );
  const selectLatestNamedPosition = input.database.query<
    { event_position: number | null },
    [string]
  >(
    'SELECT max(event_position) AS event_position FROM runtime_named_snapshots WHERE session_id = ?',
  );
  const selectPreimageInWindow = input.database.query<{ path: string }, [string, string, number]>(
    `SELECT path FROM runtime_file_preimages
      WHERE session_id = ? AND path = ? AND event_position > ? LIMIT 1`,
  );
  const insertPreimage = input.database.query(
    `INSERT OR REPLACE INTO runtime_file_preimages(
      session_id, path, event_position, content, existed, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertForkPreimage = input.database.query(
    `INSERT INTO runtime_file_preimages(
      session_id, path, event_position, content, existed, post_hash, post_existed, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updatePostimage = input.database.query(
    `UPDATE runtime_file_preimages SET post_hash = ?, post_existed = ?
      WHERE rowid = (
        SELECT rowid FROM runtime_file_preimages
        WHERE session_id = ? AND path = ? AND event_position > ?
        ORDER BY event_position DESC LIMIT 1
      )`,
  );
  const deletePreimagesAfter = input.database.query(
    'DELETE FROM runtime_file_preimages WHERE session_id = ? AND event_position > ?',
  );
  const selectPreimagesThrough = input.database.query<
    {
      path: string;
      event_position: number;
      content: string | null;
      existed: number;
      post_hash: string | null;
      post_existed: number | null;
      created_at: number;
    },
    [string, number]
  >(
    `SELECT path, event_position, content, existed, post_hash, post_existed, created_at
       FROM runtime_file_preimages WHERE session_id = ? AND event_position <= ?
      ORDER BY event_position ASC, path ASC`,
  );
  const selectRestorePlan = input.database.query<
    {
      path: string;
      content: string | null;
      existed: number;
      post_hash: string | null;
      post_existed: number | null;
    },
    [string, number]
  >(
    `WITH bounds AS (
      SELECT session_id, path, min(event_position) AS min_position,
             max(event_position) AS max_position
        FROM runtime_file_preimages
       WHERE session_id = ? AND event_position > ? GROUP BY session_id, path
    )
    SELECT first.path, first.content, first.existed, last.post_hash, last.post_existed
      FROM bounds
      JOIN runtime_file_preimages AS first
        ON first.session_id = bounds.session_id AND first.path = bounds.path
       AND first.event_position = bounds.min_position
      JOIN runtime_file_preimages AS last
        ON last.session_id = bounds.session_id AND last.path = bounds.path
       AND last.event_position = bounds.max_position`,
  );
  const selectTombstone = input.database.query<{ session_id: string }, [string]>(
    'SELECT session_id FROM runtime_session_tombstones WHERE session_id = ? LIMIT 1',
  );
  const selectRunCoverage = input.database.query<{ revision: number; boundary: number }, [string]>(
    `SELECT revision, run_index_from_revision AS boundary
       FROM runtime_sessions WHERE session_id = ? LIMIT 1`,
  );
  const selectInvalidForkRun = input.database.query<{ run_id: string }, [string, number, number]>(
    `SELECT run_id FROM runtime_runs WHERE session_id = ? AND created_revision <= ?
      AND (last_revision > ? OR status NOT IN ('completed', 'failed', 'cancelled')) LIMIT 1`,
  );

  const assertSession = (sessionId: string): void => {
    if (!input.sessions.binding(sessionId)) {
      throw new Error('Checkpoint Session is not admitted to this Workspace.');
    }
  };
  const createdAt = (): number => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Checkpoint clock is invalid.');
    return Math.floor(value / 1_000);
  };
  const decodeNamed = <Loaded = State>(row: NamedSnapshotRow): Loaded | null => {
    if (checksum(row.state_json) !== row.state_checksum) return null;
    try {
      return input.codec.decodeState<Loaded>(row.state_json);
    } catch {
      return null;
    }
  };
  const writeNamed = (
    sessionId: string,
    name: string,
    state: State,
    eventPosition: number,
    exactCreatedAt?: number,
    insertOnly = false,
  ): void => {
    const encoded = input.snapshots.encode(state, {
      eventPosition,
      stateRevision: input.codec.snapshotMetadata(state).stateRevision,
      stateChecksum: '',
      schemaVersion: input.stateSchemaVersion,
    });
    const statement = insertOnly ? insertForkNamed : upsertNamed;
    statement.run(
      sessionId,
      name,
      encoded.metadata.schemaVersion,
      input.formatEpoch,
      encoded.metadata.stateRevision,
      encoded.json,
      eventPosition,
      checksum(encoded.json),
      exactCreatedAt ?? createdAt(),
    );
  };

  const fork = (
    sourceSessionId: string,
    snapshotId: string,
    targetSessionId: string,
    targetRecoveryIdentityKey: string,
    commandEvidence?: RuntimeCommandForkInput['commandEvidence'],
  ): RuntimeCommandForkResult | { readonly status: 'applied' } => {
    const unavailable = (): RuntimeCommandForkResult => ({ status: 'unavailable' });
    if (
      input.isClosed() ||
      !sourceSessionId ||
      !targetSessionId ||
      sourceSessionId === targetSessionId ||
      !isCanonicalRecoveryIdentity(targetRecoveryIdentityKey)
    ) {
      return unavailable();
    }
    assertSession(sourceSessionId);
    if (input.sessions.binding(targetSessionId) || selectTombstone.get(targetSessionId)) {
      return unavailable();
    }
    const current = snapshotId === '__runtime_current__';
    const sourceRow: SnapshotRow | NamedSnapshotRow | null = current
      ? input.snapshots.getRollingRow(sourceSessionId)
      : (selectNamed.get(sourceSessionId, snapshotId) ?? null);
    if (!sourceRow || checksum(sourceRow.state_json) !== sourceRow.state_checksum) {
      return unavailable();
    }
    let state: State;
    try {
      state = input.codec.decodeState<State>(sourceRow.state_json);
      const eventRevision = input.events.revisionAtOrBefore(
        sourceSessionId,
        sourceRow.event_position,
      );
      input.snapshots.validateRestore(state, sourceSessionId, sourceRow, eventRevision);
      if (
        input.codec.canFork?.(state) === false ||
        sourceRow.schema_version !== input.stateSchemaVersion ||
        sourceRow.state_revision !== eventRevision
      ) {
        return unavailable();
      }
    } catch {
      return unavailable();
    }
    const sourceEvents = input.events
      .loadEvents(sourceSessionId)
      .filter(
        (entry) =>
          entry.id <= sourceRow.event_position &&
          (!current || !input.codec.isCurrentPendingInteractionRequest?.(state, entry.event)),
      );
    const positions = eventPositions(sourceEvents);
    const remap = (position: number): number =>
      remapEventPosition(sourceEvents, positions, position);
    const rebound = input.codec.rebindForkState(state, targetSessionId, targetRecoveryIdentityKey);
    const encoded = input.snapshots.encode(rebound);
    const targetEventPosition = remap(sourceRow.event_position);
    try {
      input.codec.validateSnapshot?.({
        state: rebound,
        sessionId: targetSessionId,
        eventPosition: targetEventPosition,
        stateRevision: encoded.metadata.stateRevision,
        schemaVersion: encoded.metadata.schemaVersion,
        eventRevision: encoded.metadata.stateRevision,
      });
    } catch {
      return unavailable();
    }
    const snapshotRecovery = input.codec.recoveryIdentity?.(state);
    const persistedRecovery = input.recovery.readValue(sourceSessionId);
    if (
      (snapshotRecovery !== undefined && !isCanonicalRecoveryIdentity(snapshotRecovery)) ||
      (persistedRecovery !== undefined && !isCanonicalRecoveryIdentity(persistedRecovery)) ||
      (snapshotRecovery !== undefined &&
        persistedRecovery !== undefined &&
        snapshotRecovery !== persistedRecovery)
    ) {
      return unavailable();
    }
    const sourceRecovery = persistedRecovery ?? snapshotRecovery;
    if (
      (input.codec.recoveryIdentity && sourceRecovery === undefined) ||
      sourceRecovery === targetRecoveryIdentityKey
    ) {
      return unavailable();
    }
    const coverage = selectRunCoverage.get(sourceSessionId);
    if (
      !coverage ||
      sourceRow.state_revision < coverage.boundary ||
      sourceRow.state_revision > coverage.revision ||
      selectInvalidForkRun.get(sourceSessionId, sourceRow.state_revision, sourceRow.state_revision)
    ) {
      return unavailable();
    }
    const sourceNamed = selectNamedThrough.all(sourceSessionId, sourceRow.event_position);
    const sourceFiles = selectPreimagesThrough.all(sourceSessionId, sourceRow.event_position);
    const route = input.sessions.getModelRoute(sourceSessionId);
    let receipt: RuntimeStoredCommandReceipt | undefined;
    if (commandEvidence) {
      if (
        commandEvidence.scopeSessionId !== sourceSessionId ||
        commandEvidence.targetSessionId !== targetSessionId
      ) {
        return unavailable();
      }
      receipt = createRuntimeStoredCommandReceipt(commandEvidence, encoded.metadata.stateRevision);
    }

    input.writer.run(() => {
      if (input.sessions.binding(targetSessionId) || selectTombstone.get(targetSessionId)) {
        throw new Error('Fork target appeared during the transaction.');
      }
      input.sessions.ensureInTransaction(targetSessionId, rebound);
      input.createForkTargetAuthorityInTransaction?.(targetSessionId);
      if (sourceRecovery !== undefined) {
        if (persistedRecovery === undefined) {
          input.recovery.putInTransaction(sourceSessionId, sourceRecovery);
        }
        input.recovery.putInTransaction(targetSessionId, targetRecoveryIdentityKey);
      }
      if (route) input.sessions.setModelRouteInTransaction(targetSessionId, route);
      for (const entry of sourceEvents) {
        input.events.insertSerializedForkEvent({
          sessionId: targetSessionId,
          eventJson:
            input.codec.encodeHistoricalEvent?.(entry.event) ??
            input.codec.encodeEvent(entry.event),
          eventId: entry.event_id ?? `${targetSessionId}:${entry.revision}`,
          revision: entry.revision ?? 0,
          causationId: entry.causation_id ?? null,
          occurredAt: entry.occurred_at ?? null,
          createdAt: entry.created_at,
        });
      }
      for (const file of sourceFiles) {
        insertForkPreimage.run(
          targetSessionId,
          file.path,
          remap(file.event_position),
          file.content,
          file.existed,
          file.post_hash,
          file.post_existed,
          file.created_at,
        );
      }
      input.snapshots.persist(
        targetSessionId,
        encoded.json,
        targetEventPosition,
        encoded.metadata.stateRevision,
        encoded.metadata.stateChecksum,
        encoded.metadata.schemaVersion,
      );
      const runFork = input.runs.forkSession({
        sourceSessionId,
        targetSessionId,
        throughRevision: sourceRow.state_revision,
      });
      if (runFork.status !== 'applied') {
        throw new Error('Runtime Run fork rejected a prevalidated boundary.');
      }
      for (const named of sourceNamed) {
        const namedState = decodeNamed<State>(named);
        if (!namedState || input.codec.canFork?.(namedState) === false) continue;
        try {
          const reboundNamed = input.codec.rebindForkState(
            namedState,
            targetSessionId,
            targetRecoveryIdentityKey,
          );
          writeNamed(
            targetSessionId,
            named.name,
            reboundNamed,
            remap(named.event_position),
            named.created_at,
            true,
          );
        } catch {
          // A corrupt optional recovery point is omitted; the rolling fork remains exact.
        }
      }
      if (receipt) {
        input.receiptWriter.insert(receipt, targetSessionId, encoded.metadata.stateRevision);
      }
    });
    return receipt ? { status: 'applied', receipt } : { status: 'applied' };
  };

  const checkpoints: CheckpointPort<State> = {
    saveNamedSnapshot(sessionId, name, state, eventPosition) {
      if (input.isClosed()) return;
      assertName(name);
      input.writer.run(() => {
        input.sessions.ensureInTransaction(sessionId, state);
        writeNamed(
          sessionId,
          name,
          state,
          eventPosition ?? input.events.lastEventPosition(sessionId),
        );
      });
    },
    loadNamedSnapshot<Loaded = State>(sessionId: string, name: string): Loaded | null {
      if (input.isClosed()) return null;
      assertSession(sessionId);
      assertName(name);
      const row = selectNamed.get(sessionId, name);
      return row ? decodeNamed<Loaded>(row) : null;
    },
    listNamedSnapshots(sessionId) {
      if (input.isClosed()) return [];
      assertSession(sessionId);
      const events = input.events.loadEvents(sessionId);
      return listNamed.all(sessionId).map((row) => {
        const target = events.find(
          (entry) =>
            entry.id > row.event_position &&
            input.codec.eventSummary?.(entry.event)?.isSessionNameCandidate,
        );
        const summary = target ? input.codec.eventSummary?.(target.event) : null;
        return {
          snapshotId: row.name,
          eventPosition: row.event_position,
          createdAt: row.created_at,
          ...(summary?.searchText !== undefined ? { targetMessage: summary.searchText } : {}),
          ...(target ? { targetMessageCreatedAt: target.created_at } : {}),
          affectedFileCount: row.affected_file_count,
        };
      });
    },
    getNamedSnapshotEntry(sessionId, snapshotId) {
      if (input.isClosed()) return null;
      assertSession(sessionId);
      assertName(snapshotId);
      const row = selectNamed.get(sessionId, snapshotId);
      return row
        ? {
            snapshotId: row.name,
            eventPosition: row.event_position,
            createdAt: row.created_at,
          }
        : null;
    },
    restoreNamedSnapshot(sessionId, snapshotId): boolean {
      if (input.isClosed()) return false;
      assertSession(sessionId);
      assertName(snapshotId);
      const row = selectNamed.get(sessionId, snapshotId);
      if (!row || checksum(row.state_json) !== row.state_checksum) return false;
      let state: State;
      try {
        state = input.codec.decodeState<State>(row.state_json);
        const revision = input.events.revisionAtOrBefore(sessionId, row.event_position);
        input.snapshots.validateRestore(state, sessionId, row, revision);
        if (
          row.schema_version !== input.stateSchemaVersion ||
          row.event_position > input.events.lastEventPosition(sessionId) ||
          row.state_revision !== revision
        ) {
          return false;
        }
      } catch {
        return false;
      }
      return input.writer.run(() => {
        const rewind = input.runs.rewindSession(sessionId, row.state_revision);
        if (rewind.status !== 'applied') return false;
        input.events.deleteAfter(sessionId, row.event_position);
        deleteNamedAfter.run(sessionId, row.event_position);
        deletePreimagesAfter.run(sessionId, row.event_position);
        const encoded = input.snapshots.encode(state);
        input.snapshots.persist(
          sessionId,
          encoded.json,
          row.event_position,
          row.state_revision,
          encoded.metadata.stateChecksum,
          encoded.metadata.schemaVersion,
        );
        input.sessions.ensureInTransaction(sessionId, state);
        return true;
      });
    },
    forkSession: (source, snapshot, target, recovery) =>
      fork(source, snapshot, target, recovery).status === 'applied',
    forkSessionForCommand(command): RuntimeCommandForkResult {
      const result = fork(
        command.sourceSessionId,
        command.snapshotId,
        command.targetSessionId,
        command.targetRecoveryIdentityKey,
        command.commandEvidence,
      );
      return result.status === 'applied' && 'receipt' in result
        ? result
        : { status: 'unavailable' };
    },
    forkCurrentSession: (source, target, recovery) =>
      fork(source, '__runtime_current__', target, recovery).status === 'applied',
    recordFilePreimage(sessionId, path, content, existed) {
      if (input.isClosed() || !sessionId || !path) return;
      try {
        assertSession(sessionId);
        const boundary = selectLatestNamedPosition.get(sessionId)?.event_position ?? -1;
        if (selectPreimageInWindow.get(sessionId, path, boundary)) return;
        input.writer.run(() => {
          insertPreimage.run(
            sessionId,
            path,
            input.events.lastEventPosition(sessionId),
            content,
            existed ? 1 : 0,
            createdAt(),
          );
        });
      } catch {
        // Best effort by Host contract; cross-scope and malformed writes still leave no row.
      }
    },
    recordFilePostimage(sessionId, path, contentHash, existed) {
      if (input.isClosed() || !sessionId || !path) return;
      try {
        assertSession(sessionId);
        const boundary = selectLatestNamedPosition.get(sessionId)?.event_position ?? -1;
        input.writer.run(() => {
          updatePostimage.run(contentHash, existed ? 1 : 0, sessionId, path, boundary);
        });
      } catch {
        // Best effort by Host contract.
      }
    },
    fileRestorePlan(sessionId, eventPosition): RuntimeFileRestoreMaterial[] {
      if (input.isClosed()) return [];
      assertSession(sessionId);
      return selectRestorePlan.all(sessionId, eventPosition).map((row) => ({
        path: row.path,
        content: row.content,
        existed: row.existed === 1,
        postHash: row.post_hash,
        postExisted: row.post_existed === null ? null : row.post_existed === 1,
      }));
    },
  };
  return Object.freeze(checkpoints);
}

function eventPositions<Event>(events: readonly StoredRuntimeEvent<Event>[]): Map<number, number> {
  return new Map(events.map((entry) => [entry.id, entry.revision ?? 0]));
}

function remapEventPosition<Event>(
  events: readonly StoredRuntimeEvent<Event>[],
  positions: ReadonlyMap<number, number>,
  position: number,
): number {
  let target = 0;
  for (const entry of events) {
    if (entry.id > position) break;
    target = positions.get(entry.id) ?? target;
  }
  return target;
}

function assertName(value: string): void {
  if (!value || value.length > 512 || value.includes('\0') || /\p{Cc}/u.test(value)) {
    throw new TypeError('Checkpoint identity is invalid.');
  }
}
