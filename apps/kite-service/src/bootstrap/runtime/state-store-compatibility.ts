import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import {
  LEGACY_STATE26_FORMAT_EPOCH,
  LEGACY_STATE26_SCHEMA_VERSION,
  resolveProjectIdentity,
} from '@kite-ai/runtime-host';
import type { RuntimeSnapshotCodec } from '@kite-ai/runtime-host/storage';
import type {
  SqliteRuntimeCompatibilityFilePreimage,
  SqliteRuntimeCompatibilityMigrator,
  SqliteRuntimeCompatibilityNamedSnapshot,
  SqliteRuntimeCompatibilityTargetEvent,
  SqliteRuntimeCompatibilityTargetSession,
} from '@kite-ai/runtime-storage-sqlite';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

const HISTORICAL_STATE_SCHEMA = LEGACY_STATE26_SCHEMA_VERSION;

interface CompatibilitySessionIdentity {
  readonly sessionId: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
}

function coordinatorProjectIdentity(
  workspace: string,
): { readonly projectId: string; readonly workspaceDigest: string } | null {
  if (!workspace || workspace.includes('\0') || !isAbsolute(workspace)) return null;
  try {
    return resolveProjectIdentity(workspace);
  } catch {
    return null;
  }
}

function normalizeState26Identity(
  state: RuntimeState,
  expected: CompatibilitySessionIdentity,
): RuntimeState | null {
  const session = state.session;
  if (
    !expected.sessionId ||
    !expected.projectId ||
    !/^sha256:[a-f0-9]{64}$/u.test(expected.workspaceDigest) ||
    session.threadId !== expected.sessionId ||
    session.projectId !== expected.projectId ||
    session.canonicalWorkspaceDigest !== expected.workspaceDigest
  ) {
    return null;
  }
  const identity = coordinatorProjectIdentity(session.workspace);
  if (!identity || identity.workspaceDigest !== expected.workspaceDigest) return null;
  const deterministicProjectId = identity.projectId;
  if (/^project_[a-f0-9]{64}$/u.test(session.projectId)) {
    return session.projectId === deterministicProjectId ? state : null;
  }
  return {
    ...state,
    session: {
      ...session,
      projectId: deterministicProjectId,
    },
  };
}

function safeSessionIdentity(
  codec: RuntimeSnapshotCodec<RuntimeEvent, RuntimeState>,
  state: RuntimeState,
): { readonly projectId: string; readonly canonicalWorkspaceDigest: string } | null {
  try {
    return codec.sessionIdentity?.(state) ?? null;
  } catch {
    return null;
  }
}

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
  normalizeLegacyIdentity: boolean,
): SqliteRuntimeCompatibilityNamedSnapshot | null {
  if (
    normalizeLegacyIdentity &&
    (snapshot.schemaVersion !== LEGACY_STATE26_SCHEMA_VERSION ||
      snapshot.formatEpoch !== LEGACY_STATE26_FORMAT_EPOCH)
  ) {
    return null;
  }
  const decoded = codec.decodeCompatibleState?.(snapshot.stateJson, {
    schemaVersion: snapshot.schemaVersion,
    formatEpoch: snapshot.formatEpoch,
  });
  if (!decoded) return null;
  const state = normalizeLegacyIdentity ? normalizeState26Identity(decoded, expected) : decoded;
  if (!state) return null;
  const metadata = codec.snapshotMetadata(state);
  const identity = safeSessionIdentity(codec, state);
  if (
    metadata.stateRevision !== snapshot.revision ||
    state.session.threadId !== expected.sessionId ||
    !identity ||
    identity.projectId !==
      (normalizeLegacyIdentity ? state.session.projectId : expected.projectId) ||
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
    const normalizeLegacyIdentity =
      source.stateSchemaVersion === HISTORICAL_STATE_SCHEMA &&
      source.formatEpoch === LEGACY_STATE26_FORMAT_EPOCH;
    if (
      normalizeLegacyIdentity &&
      (input.snapshot.schemaVersion !== LEGACY_STATE26_SCHEMA_VERSION ||
        input.snapshot.formatEpoch !== LEGACY_STATE26_FORMAT_EPOCH)
    ) {
      return null;
    }
    const decoded = codec.decodeCompatibleState?.(input.snapshot.stateJson, {
      schemaVersion: input.snapshot.schemaVersion,
      formatEpoch: input.snapshot.formatEpoch,
    });
    if (!decoded) return null;
    const state = normalizeLegacyIdentity
      ? normalizeState26Identity(decoded, {
          sessionId: input.session.sessionId,
          projectId: input.session.projectId,
          workspaceDigest: input.session.workspaceDigest,
        })
      : decoded;
    if (!state) return null;
    const stateMetadata = codec.snapshotMetadata(state);
    const identity = safeSessionIdentity(codec, state);
    if (
      stateMetadata.stateRevision !== input.snapshot.revision ||
      state.session.threadId !== input.session.sessionId ||
      !identity ||
      identity.projectId !==
        (normalizeLegacyIdentity ? state.session.projectId : input.session.projectId) ||
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
      const event = codec.decodeCompatibleEvent?.(
        row.eventJson,
        {
          schemaVersion: row.schemaVersion,
          formatEpoch: source.formatEpoch,
        },
        {
          sequence: row.sequence,
        },
      );
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
      const migrated = migrateNamedSnapshot(
        snapshot,
        state.formatEpoch,
        codec,
        {
          sessionId: input.session.sessionId,
          projectId: input.session.projectId,
          workspaceDigest: input.session.workspaceDigest,
        },
        normalizeLegacyIdentity,
      );
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
    const targetProjectId = state.session.projectId;
    const targetWorkspaceDigest = state.session.canonicalWorkspaceDigest;
    if (!targetProjectId || !targetWorkspaceDigest) return null;
    return {
      sessionId: input.session.sessionId,
      projectId: targetProjectId,
      workspaceDigest: targetWorkspaceDigest,
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
