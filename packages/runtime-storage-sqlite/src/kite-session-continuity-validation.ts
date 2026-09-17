import type { Database } from 'bun:sqlite';
import { createKiteHomeArtifactStore, type KiteHomeArtifactStore } from './kite-home-artifacts';
import { createKiteHomeRuntimeStorageForConnection } from './kite-home-runtime-storage';
import { assertKiteSessionStoreSchema, assertKiteStoreIntegrity } from './kite-home-store';
import { createKiteHomeWriteTransactionPort } from './kite-home-write';
import { createKiteSessionExecutionAuthority } from './kite-session-execution-authority';
import {
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  type SqliteRuntimeSnapshotCodec,
} from './preflight';

/** Full scan for offline maintenance, never for ordinary App Server startup. */
export function validateKiteSessionStoreContinuity<Event, State>(input: {
  readonly database: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
}): {
  readonly sessions: number;
  readonly listedSessions: number;
  readonly tombstones: number;
  readonly events: number;
  readonly runs: number;
  readonly commandReceipts: number;
  readonly namedSnapshots: number;
  readonly forkOrigins: number;
  readonly artifacts: Readonly<Record<string, number>>;
  readonly recoveryRequired: number;
} {
  const { database, codec } = input;
  return database.transaction(() => {
    assertKiteSessionStoreSchema(database);
    assertKiteStoreIntegrity(database);
    const owner = createKiteHomeRuntimeStorageForConnection({
      database,
      assertStoreSchema: assertKiteSessionStoreSchema,
      storeSchemaVersion: 10,
      codec,
      stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
      ownsDatabase: false,
    });
    const authority = createKiteSessionExecutionAuthority({
      database,
      writer: createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema),
    });
    const sessionIds = database
      .query<{ session_id: string }, []>(
        'SELECT session_id FROM runtime_sessions ORDER BY session_id',
      )
      .all()
      .map((row) => row.session_id);
    let runs = 0;
    let namedSnapshots = 0;
    let recoveryRequired = 0;
    const artifacts = createKiteHomeArtifactStore(database);
    try {
      for (const sessionId of sessionIds) {
        const state = owner.storage.sessions.loadSnapshot(sessionId);
        if (state === null) throw new Error('Session continuity snapshot is missing.');
        validateStateReferences(state, artifacts);
        for (const entry of owner.storage.sessions.loadEventsStrict(sessionId))
          validateEventReferences(entry.event, artifacts);
        const named = owner.storage.checkpoints.listNamedSnapshots(sessionId);
        for (const snapshot of named) {
          const namedState = owner.storage.checkpoints.loadNamedSnapshot(
            sessionId,
            snapshot.snapshotId,
          );
          if (!namedState) throw new Error('Session continuity named snapshot is missing.');
          validateStateReferences(namedState, artifacts);
        }
        namedSnapshots += named.length;
        let cursor: { createdRevision: number; runId: string } | undefined;
        for (;;) {
          const page = owner.storage.runs.list({
            sessionId,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          for (const run of page.entries) {
            if (!owner.storage.runs.get(sessionId, run.runId))
              throw new Error('Session continuity Run lookup failed.');
            runs++;
          }
          if (!page.hasMore || !page.nextCursor) break;
          cursor = page.nextCursor;
        }
        const current = authority.read(sessionId);
        if (current.status === 'recovery_required') recoveryRequired++;
        if (current.status !== 'idle' && current.status !== 'recovery_required')
          throw new Error('Session continuity has live execution authority.');
        if (
          current.hostInstanceId !== null ||
          current.clientId !== null ||
          current.leaseUntilMs !== null ||
          (current.status === 'idle' && !current.cleanupConfirmed) ||
          (current.status === 'recovery_required' && current.cleanupConfirmed)
        )
          throw new Error('Session continuity has an execution owner.');
      }
      const listed = new Set<string>();
      let directoryCursor: { updatedAt: number; sessionId: string } | undefined;
      for (;;) {
        const page = owner.directory.listSessions({
          limit: 100,
          ...(directoryCursor ? { cursor: directoryCursor } : {}),
        });
        for (const entry of page.entries) listed.add(entry.sessionId);
        if (!page.hasMore || !page.nextCursor) break;
        directoryCursor = page.nextCursor;
      }
      if (listed.size !== sessionIds.length || sessionIds.some((id) => !listed.has(id)))
        throw new Error('Session continuity directory omits a persisted Session.');
      const tombstoneRows = database
        .query<{ session_id: string }, []>('SELECT session_id FROM runtime_session_tombstones')
        .all();
      if (tombstoneRows.some((row) => listed.has(row.session_id)))
        throw new Error('Session continuity directory revived a tombstoned Session.');
      const forkOrigins =
        database
          .query<{ count: number }, []>(
            'SELECT COUNT(*) AS count FROM runtime_runs WHERE origin_session_id IS NOT NULL',
          )
          .get()?.count ?? 0;
      const missingOrigins =
        database
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count FROM runtime_runs child LEFT JOIN runtime_runs parent
          ON parent.session_id = child.origin_session_id AND parent.run_id = child.origin_run_id
          WHERE child.origin_session_id IS NOT NULL AND parent.run_id IS NULL`,
          )
          .get()?.count ?? 0;
      if (missingOrigins !== 0) throw new Error('Session continuity Fork origin is missing.');
      const events = count(database, 'runtime_events');
      const commandReceipts = count(database, 'runtime_command_receipts');
      if (
        runs !== count(database, 'runtime_runs') ||
        namedSnapshots !== count(database, 'runtime_named_snapshots')
      )
        throw new Error('Session continuity reader omitted persisted rows.');
      const artifactCounts = validateArtifacts(database);
      return Object.freeze({
        sessions: sessionIds.length,
        listedSessions: listed.size,
        tombstones: tombstoneRows.length,
        events,
        runs,
        commandReceipts,
        namedSnapshots,
        forkOrigins,
        artifacts: Object.freeze(artifactCounts),
        recoveryRequired,
      });
    } finally {
      owner.close();
    }
  })();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function entries(value: unknown): unknown[] {
  return Object.values(object(value));
}

function validateStateReferences(state: unknown, artifacts: KiteHomeArtifactStore): void {
  const root = object(state);
  for (const invocation of entries(root.modelInvocations)) {
    const model = object(invocation);
    readArtifactRef(model.surfaceArtifact, artifacts);
    if (model.responseArtifact) readArtifactRef(model.responseArtifact, artifacts);
  }
  for (const invocation of entries(object(root.capabilities).invocations)) {
    const capability = object(invocation);
    if (capability.artifact) readArtifactRef(capability.artifact, artifacts);
    const preimage = object(capability.filesystemMutationReady).preimageArtifact;
    if (preimage) readArtifactRef(preimage, artifacts);
    const preparation = object(capability.sandboxPreparationReady).preparationArtifact;
    if (preparation) readArtifactRef(preparation, artifacts);
    const lifecycle = object(capability.subagentProviderLifecycle);
    if (lifecycle.taskArtifact) readArtifactRef(lifecycle.taskArtifact, artifacts);
    if (lifecycle.handleArtifact) readArtifactRef(lifecycle.handleArtifact, artifacts);
  }
  for (const task of entries(root.tasks)) {
    const value = object(task);
    const currentPlanRef = object(object(value.planning).document).artifact;
    if (currentPlanRef) readArtifactRef(currentPlanRef, artifacts);
    if (Array.isArray(value.planHistory))
      for (const plan of value.planHistory) {
        const ref = object(plan).artifact;
        if (ref) readArtifactRef(ref, artifacts);
      }
  }
  const interactionArtifact = object(root.interactions).artifact;
  if (interactionArtifact) readArtifactRef(interactionArtifact, artifacts);
  for (const suspended of entries(root.suspendedSubagents)) {
    const ref = object(suspended).continuationArtifact;
    if (ref) readArtifactRef(ref, artifacts);
  }
}

function validateEventReferences(event: unknown, artifacts: KiteHomeArtifactStore): void {
  const value = object(event);
  for (const field of [
    'surfaceArtifact',
    'responseArtifact',
    'preimageArtifact',
    'preparationArtifact',
    'taskArtifact',
    'handleArtifact',
    'artifact',
  ]) {
    if (value[field]) readArtifactRef(value[field], artifacts);
  }
  const continuation = object(value.snapshot).continuationArtifact;
  if (continuation) readArtifactRef(continuation, artifacts);
}

function readArtifactRef(value: unknown, artifacts: KiteHomeArtifactStore): void {
  const ref = object(value);
  const artifactId = ref.artifactId;
  const byteLength = ref.byteLength;
  if (typeof artifactId !== 'string' || typeof byteLength !== 'number')
    throw new Error('Session continuity Artifact reference is invalid.');
  if (ref.kind === undefined) {
    if (
      typeof ref.taskId !== 'string' ||
      typeof ref.planId !== 'string' ||
      typeof ref.version !== 'number' ||
      typeof ref.structuralDigest !== 'string'
    )
      throw new Error('Session continuity Plan reference is invalid.');
    artifacts.readPlan({
      artifactId,
      byteLength,
      taskId: ref.taskId,
      planId: ref.planId,
      version: ref.version,
      structuralDigest: ref.structuralDigest,
    });
    return;
  }
  if (typeof ref.integrityIdentifier !== 'string')
    throw new Error('Session continuity Artifact integrity is invalid.');
  const kind = ref.kind;
  if (typeof kind !== 'string') throw new Error('Session continuity Artifact kind is invalid.');
  const base = { artifactId, byteLength, integrityIdentifier: ref.integrityIdentifier };
  switch (kind) {
    case 'model_surface':
    case 'model_response':
    case 'provider_options':
      artifacts.readModel({ ...base, kind });
      return;
    case 'capability_result':
      artifacts.readCapability({ ...base, kind });
      return;
    case 'filesystem_preimage':
      artifacts.readFilesystemPreimage({ ...base, kind });
      return;
    case 'sandbox_preparation':
      artifacts.readSandboxPreparation({ ...base, kind });
      return;
    case 'subagent_task_request':
    case 'subagent_task':
      artifacts.readSubagentTask({ ...base, kind });
      return;
    case 'subagent_handle':
      artifacts.readSubagentLifecycle({ ...base, kind });
      return;
    case 'subagent_continuation':
      artifacts.readSubagentContinuation({ ...base, kind });
      return;
    default:
      throw new Error('Session continuity Artifact kind is unsupported.');
  }
}

function validateArtifacts(database: Database): Record<string, number> {
  const store = createKiteHomeArtifactStore(database);
  const counts: Record<string, number> = {};
  for (const row of database
    .query<
      {
        artifact_id: string;
        kind: 'model_surface' | 'model_response' | 'provider_options';
        integrity_identifier: string;
        byte_length: number;
      },
      []
    >('SELECT artifact_id, kind, integrity_identifier, byte_length FROM model_artifacts')
    .iterate())
    store.readModel({
      artifactId: row.artifact_id,
      kind: row.kind,
      integrityIdentifier: row.integrity_identifier,
      byteLength: row.byte_length,
    });
  counts.model = count(database, 'model_artifacts');
  for (const row of database
    .query<
      {
        artifact_id: string;
        task_id: string;
        plan_id: string;
        version: number;
        structural_digest: string;
        byte_length: number;
      },
      []
    >(
      'SELECT artifact_id, task_id, plan_id, version, structural_digest, byte_length FROM plan_artifacts',
    )
    .iterate())
    store.readPlan({
      artifactId: row.artifact_id,
      taskId: row.task_id,
      planId: row.plan_id,
      version: row.version,
      structuralDigest: row.structural_digest,
      byteLength: row.byte_length,
    });
  counts.plan = count(database, 'plan_artifacts');
  for (const row of privateRefs(database, 'capability_artifacts'))
    store.readCapability({ ...row, kind: 'capability_result' });
  counts.capability = count(database, 'capability_artifacts');
  for (const row of privateRefs(database, 'filesystem_preimage_artifacts'))
    store.readFilesystemPreimage({ ...row, kind: 'filesystem_preimage' });
  counts.filesystemPreimage = count(database, 'filesystem_preimage_artifacts');
  for (const row of privateRefs(database, 'sandbox_preparation_artifacts'))
    store.readSandboxPreparation({ ...row, kind: 'sandbox_preparation' });
  counts.sandboxPreparation = count(database, 'sandbox_preparation_artifacts');
  for (const row of database
    .query<
      {
        artifact_id: string;
        kind: 'subagent_task_request' | 'subagent_task';
        integrity_identifier: string;
        byte_length: number;
      },
      []
    >('SELECT artifact_id, kind, integrity_identifier, byte_length FROM subagent_task_artifacts')
    .iterate())
    store.readSubagentTask({
      artifactId: row.artifact_id,
      kind: row.kind,
      integrityIdentifier: row.integrity_identifier,
      byteLength: row.byte_length,
    });
  counts.subagentTask = count(database, 'subagent_task_artifacts');
  for (const row of privateRefs(database, 'subagent_lifecycle_artifacts'))
    store.readSubagentLifecycle({ ...row, kind: 'subagent_handle' });
  counts.subagentLifecycle = count(database, 'subagent_lifecycle_artifacts');
  for (const row of privateRefs(database, 'subagent_continuation_artifacts'))
    store.readSubagentContinuation({ ...row, kind: 'subagent_continuation' });
  counts.subagentContinuation = count(database, 'subagent_continuation_artifacts');
  return counts;
}

function* privateRefs(
  database: Database,
  table: string,
): Generator<{
  artifactId: string;
  integrityIdentifier: string;
  byteLength: number;
}> {
  for (const row of database
    .query<
      {
        artifact_id: string;
        integrity_identifier: string;
        byte_length: number;
      },
      []
    >(`SELECT artifact_id, integrity_identifier, byte_length FROM ${table}`)
    .iterate())
    yield {
      artifactId: row.artifact_id,
      integrityIdentifier: row.integrity_identifier,
      byteLength: row.byte_length,
    };
}

function count(database: Database, table: string): number {
  return (
    database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ??
    0
  );
}
