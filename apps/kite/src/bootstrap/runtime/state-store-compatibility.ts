import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import type { RuntimeSnapshotCodec } from '@kite/runtime-host/storage';
import type {
  SqliteRuntimeCompatibilityFilePreimage,
  SqliteRuntimeCompatibilityMigrator,
  SqliteRuntimeCompatibilityNamedSnapshot,
  SqliteRuntimeCompatibilityTargetEvent,
  SqliteRuntimeCompatibilityTargetSession,
} from '@kite/runtime-storage-sqlite';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

const HISTORICAL_STATE_SCHEMA = 26;

function currentFilePreimages(
  input: readonly SqliteRuntimeCompatibilityFilePreimage[],
  state: RuntimeState,
  sourceStateSchemaVersion: number,
): readonly SqliteRuntimeCompatibilityFilePreimage[] | null {
  // State 26 file preimages can cause a future /rewind filesystem write and
  // therefore are old effect authority, not passive conversation history.
  if (sourceStateSchemaVersion === HISTORICAL_STATE_SCHEMA) return [];
  const workspace = resolve(state.session.workspace);
  for (const preimage of input) {
    if (
      !preimage.path ||
      preimage.path.includes('\0') ||
      preimage.path.split(/[\\/]+/u).includes('..') ||
      (process.platform !== 'win32' && win32.isAbsolute(preimage.path)) ||
      preimage.eventPosition > state.revision
    ) {
      return null;
    }
    const target = resolve(workspace, preimage.path);
    const workspaceRelative = relative(workspace, target);
    if (
      workspaceRelative === '' ||
      workspaceRelative === '..' ||
      workspaceRelative.startsWith(`..${sep}`) ||
      isAbsolute(workspaceRelative)
    ) {
      return null;
    }
  }
  return input;
}

function currentEventJson(
  codec: RuntimeSnapshotCodec<RuntimeEvent, RuntimeState>,
  event: RuntimeEvent,
): string {
  return codec.encodeHistoricalEvent?.(event) ?? codec.encodeEvent(event);
}

function migrateNamedSnapshot(
  snapshot: SqliteRuntimeCompatibilityNamedSnapshot,
  targetFormatEpoch: string,
  codec: RuntimeSnapshotCodec<RuntimeEvent, RuntimeState>,
  expected: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly workspaceDigest: string;
  },
): SqliteRuntimeCompatibilityNamedSnapshot | null {
  const state = codec.decodeCompatibleState?.(snapshot.stateJson, {
    schemaVersion: snapshot.schemaVersion,
    formatEpoch: snapshot.formatEpoch,
  });
  if (!state) return null;
  const metadata = codec.snapshotMetadata(state);
  const identity = codec.sessionIdentity?.(state);
  if (
    metadata.stateRevision !== snapshot.revision ||
    state.session.threadId !== expected.sessionId ||
    !identity ||
    identity.projectId !== expected.projectId ||
    identity.canonicalWorkspaceDigest !== expected.workspaceDigest
  )
    return null;
  try {
    codec.validateSnapshot?.({
      state,
      sessionId: expected.sessionId,
      eventPosition: snapshot.eventPosition,
      stateRevision: snapshot.revision,
      schemaVersion: metadata.schemaVersion,
      eventRevision: snapshot.revision,
    });
  } catch {
    return null;
  }
  return {
    ...snapshot,
    schemaVersion: metadata.schemaVersion,
    formatEpoch: targetFormatEpoch,
    stateJson: codec.encodeState(state),
    stateChecksum: '',
  };
}

/**
 * App composition for one silent compatibility import. SQLite owns row and
 * transaction mechanics; the Host codec owns State/Event semantics.
 */
export function createKiteRuntimeCompatibilityMigrator(
  codec: RuntimeSnapshotCodec<RuntimeEvent, RuntimeState>,
): SqliteRuntimeCompatibilityMigrator {
  return (input, source): SqliteRuntimeCompatibilityTargetSession | null => {
    const state = codec.decodeCompatibleState?.(input.snapshot.stateJson, {
      schemaVersion: input.snapshot.schemaVersion,
      formatEpoch: input.snapshot.formatEpoch,
    });
    if (!state) return null;
    const stateMetadata = codec.snapshotMetadata(state);
    const identity = codec.sessionIdentity?.(state);
    if (
      stateMetadata.stateRevision !== input.snapshot.revision ||
      state.session.threadId !== input.session.sessionId ||
      !identity ||
      identity.projectId !== input.session.projectId ||
      identity.canonicalWorkspaceDigest !== input.session.workspaceDigest
    ) {
      return null;
    }

    const events: SqliteRuntimeCompatibilityTargetEvent[] = [];
    let previousSequence = 0;
    for (const row of input.events) {
      if (
        !Number.isSafeInteger(row.sequence) ||
        row.sequence !== previousSequence + 1 ||
        row.schemaVersion !== source.stateSchemaVersion
      ) {
        return null;
      }
      const event = codec.decodeCompatibleEvent?.(row.eventJson, {
        schemaVersion: row.schemaVersion,
        formatEpoch: source.formatEpoch,
      });
      if (!event) return null;
      events.push({
        eventId: row.eventId,
        sequence: row.sequence,
        schemaVersion: stateMetadata.schemaVersion,
        eventJson: currentEventJson(codec, event),
        causationId: row.causationId,
        occurredAt: row.occurredAt,
        createdAt: row.createdAt,
      });
      previousSequence = row.sequence;
    }
    if (
      previousSequence !== input.session.revision ||
      input.snapshot.eventPosition !== input.snapshot.revision
    ) {
      return null;
    }

    try {
      codec.validateSnapshot?.({
        state,
        sessionId: input.session.sessionId,
        eventPosition: input.snapshot.eventPosition,
        stateRevision: input.snapshot.revision,
        schemaVersion: stateMetadata.schemaVersion,
        eventRevision: previousSequence,
      });
    } catch {
      return null;
    }

    const namedSnapshots: SqliteRuntimeCompatibilityNamedSnapshot[] = [];
    for (const snapshot of input.namedSnapshots) {
      const migrated = migrateNamedSnapshot(snapshot, state.formatEpoch, codec, {
        sessionId: input.session.sessionId,
        projectId: input.session.projectId,
        workspaceDigest: input.session.workspaceDigest,
      });
      // A named recovery point belongs to the selected session's durable
      // history. Silently dropping one would make a superficially successful
      // import incomplete and could change /rewind semantics. Keep the failure
      // scoped to this session instead.
      if (!migrated) return null;
      namedSnapshots.push(migrated);
    }
    const filePreimages = currentFilePreimages(
      input.filePreimages,
      state,
      source.stateSchemaVersion,
    );
    if (!filePreimages) return null;
    return {
      sessionId: input.session.sessionId,
      projectId: input.session.projectId,
      workspaceDigest: input.session.workspaceDigest,
      name: input.session.name,
      modelProvider: input.session.modelProvider,
      modelName: input.session.modelName,
      updatedAt: input.session.updatedAt,
      revision: input.snapshot.revision,
      eventPosition: input.snapshot.eventPosition,
      stateJson: codec.encodeState(state),
      events,
      namedSnapshots,
      filePreimages,
    };
  };
}
