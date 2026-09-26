import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { validateChildApprovalProxyContinuity } from './kite-child-approval-proxy';
import { validateCrossSessionInterruptContinuity } from './kite-cross-session-agent-interrupt';
import { readCrossSessionFollowupGrant } from './kite-cross-session-followup';
import { createKiteHomeArtifactStore, type KiteHomeArtifactStore } from './kite-home-artifacts';
import { createKiteHomeRuntimeStorageForConnection } from './kite-home-runtime-storage';
import { assertKiteSessionStoreSchema, assertKiteStoreIntegrity } from './kite-home-store';
import { createKiteHomeWriteTransactionPort } from './kite-home-write';
import { createKiteSessionExecutionAuthority } from './kite-session-execution-authority';
import { KITE_SESSION_STORE_SCHEMA_VERSION } from './kite-session-store-format';
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
    validateChildApprovalProxyContinuity(database);
    validateCrossSessionInterruptContinuity(database);
    const owner = createKiteHomeRuntimeStorageForConnection({
      database,
      assertStoreSchema: assertKiteSessionStoreSchema,
      storeSchemaVersion: KITE_SESSION_STORE_SCHEMA_VERSION,
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
    const rootSessionIds = database
      .query<{ session_id: string }, []>(
        'SELECT session_id FROM runtime_sessions WHERE parent_session_id IS NULL ORDER BY session_id',
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
        validateStateReferences(state, artifacts, database);
        for (const entry of owner.storage.sessions.loadEventsStrict(sessionId))
          validateEventReferences(entry.event, artifacts, database);
        const named = owner.storage.checkpoints.listNamedSnapshots(sessionId);
        for (const snapshot of named) {
          const namedState = owner.storage.checkpoints.loadNamedSnapshot(
            sessionId,
            snapshot.snapshotId,
          );
          if (!namedState) throw new Error('Session continuity named snapshot is missing.');
          validateStateReferences(namedState, artifacts, database);
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
      if (listed.size !== rootSessionIds.length || rootSessionIds.some((id) => !listed.has(id)))
        throw new Error('Session continuity directory differs from persisted root Sessions.');
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

function validateStateReferences(
  state: unknown,
  artifacts: KiteHomeArtifactStore,
  database: Database,
): void {
  const root = object(state);
  if (object(root.activeFollowupTurn).grantRef)
    validateFollowupGrantRef(object(root.activeFollowupTurn).grantRef, database);
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

function validateEventReferences(
  event: unknown,
  artifacts: KiteHomeArtifactStore,
  database: Database,
): void {
  const value = object(event);
  if (value.grantRef) validateFollowupGrantRef(value.grantRef, database);
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

function validateFollowupGrantRef(value: unknown, database: Database): void {
  const ref = object(value);
  const stored =
    typeof ref.artifactId === 'string'
      ? readCrossSessionFollowupGrant(database, ref.artifactId)
      : null;
  if (!stored || JSON.stringify(stored.ref) !== JSON.stringify(ref))
    throw new Error('Session continuity followup grant reference is invalid.');
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
  for (const row of privateRefs(database, 'subagent_checkpoint_artifacts'))
    store.readSubagentCheckpoint({ ...row, kind: 'subagent_checkpoint' });
  counts.subagentCheckpoint = count(database, 'subagent_checkpoint_artifacts');
  for (const row of privateRefs(database, 'agent_followup_admission_artifacts'))
    store.readAgentFollowupAdmission({ ...row, kind: 'agent_followup_admission' });
  counts.agentFollowupAdmission = count(database, 'agent_followup_admission_artifacts');
  for (const row of database
    .query<{ artifact_id: string }, []>('SELECT artifact_id FROM agent_followup_grant_artifacts')
    .iterate())
    readCrossSessionFollowupGrant(database, row.artifact_id);
  counts.agentFollowupGrant = count(database, 'agent_followup_grant_artifacts');
  for (const row of database
    .query<
      {
        session_id: string;
        body_id: string;
        integrity_identifier: string;
        byte_length: number;
        body_text: string;
      },
      []
    >(`SELECT session_id,body_id,integrity_identifier,byte_length,body_text FROM agent_mail_bodies`)
    .iterate()) {
    if (
      Buffer.byteLength(row.body_text, 'utf8') !== row.byte_length ||
      `sha256:${createHash('sha256').update(row.body_text).digest('hex')}` !==
        row.integrity_identifier
    )
      throw new Error('Agent mail body failed offline integrity validation.');
  }
  counts.agentMailBody = count(database, 'agent_mail_bodies');
  const invalidCrossSessionOutbox = database
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM agent_mail_outbox o
       LEFT JOIN runtime_sessions s ON s.session_id=o.source_session_id
       LEFT JOIN runtime_sessions t ON t.session_id=o.target_session_id
       LEFT JOIN runtime_command_receipts r
         ON r.scope_session_id=o.source_session_id AND r.command_id=o.command_id
       LEFT JOIN runtime_runs tr
         ON tr.session_id=o.target_session_id AND tr.run_id=o.target_run_id
       LEFT JOIN child_session_intents child
         ON child.child_thread_id=o.source_session_id
       WHERE s.session_id IS NULL OR t.session_id IS NULL
         OR s.workspace_id<>t.workspace_id OR s.project_id<>t.project_id
         OR s.workspace_digest<>t.workspace_digest
         OR NOT (s.parent_session_id=t.session_id OR t.parent_session_id=s.session_id)
         OR o.source_revision>s.revision OR r.request_digest<>o.request_digest
         OR r.committed_revision<>o.source_revision OR r.target_session_id<>o.source_session_id
         OR r.command_id IS NULL
         OR (o.target_run_id IS NOT NULL AND tr.run_id IS NULL)
         OR (s.parent_session_id IS NULL AND o.source_grant_id IS NOT NULL)
         OR (s.parent_session_id IS NOT NULL AND
           (o.source_grant_id IS NULL OR child.child_thread_id IS NULL
            OR child.grant_digest<>o.source_grant_digest
            OR json_extract(child.sealed_grant_json,'$.grantId')<>o.source_grant_id))`,
    )
    .get()?.count;
  if (invalidCrossSessionOutbox)
    throw new Error('Cross-Session Agent mail outbox continuity is invalid.');
  const invalidCrossSessionInbox = database
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM agent_mail_inbox i
       LEFT JOIN agent_mail_outbox o
         ON o.source_session_id=i.source_session_id AND o.message_id=i.message_id
       LEFT JOIN agent_followup_routes route
         ON route.target_session_id=i.target_session_id AND route.message_id=i.message_id
       LEFT JOIN runtime_sessions t ON t.session_id=i.target_session_id
       WHERE o.message_id IS NULL OR t.session_id IS NULL
         OR o.target_session_id<>i.target_session_id OR i.target_revision>t.revision
         OR (o.mode='queue_only' AND NOT (i.target_run_id IS o.target_run_id))
         OR (o.mode='trigger_turn' AND NOT (i.target_run_id IS o.target_run_id)
           AND (route.submission_id IS NULL OR route.target_run_id IS NOT i.target_run_id
             OR route.source_session_id<>i.source_session_id))
         OR (o.mode='trigger_turn' AND route.submission_id IS NOT NULL AND
           (i.prepared_invocation_id IS NOT route.invocation_id OR
            i.prepared_model_admission_id IS NOT route.model_admission_id))
         OR (i.prepared_invocation_id IS NOT NULL AND i.target_run_id IS NULL)
         OR (o.delivered_target_revision IS NOT NULL
           AND o.delivered_target_revision<>i.target_revision)`,
    )
    .get()?.count;
  if (invalidCrossSessionInbox)
    throw new Error('Cross-Session Agent mail inbox continuity is invalid.');
  const invalidFollowupOutbox = database
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM agent_mail_outbox o
       LEFT JOIN agent_followup_admission_artifacts a
         ON a.artifact_id=o.followup_admission_artifact_id
       WHERE (o.mode='trigger_turn')<>
         (o.submission_id IS NOT NULL AND o.followup_admission_artifact_id IS NOT NULL
          AND o.followup_admission_digest IS NOT NULL)
         OR (o.mode='trigger_turn' AND
           (a.artifact_id IS NULL OR a.integrity_identifier<>o.followup_admission_digest
            OR json_extract(a.canonical_json,'$.submissionId')<>o.submission_id
            OR json_extract(a.canonical_json,'$.sourceSessionId')<>o.source_session_id
            OR json_extract(a.canonical_json,'$.targetSessionId')<>o.target_session_id
            OR json_extract(a.canonical_json,'$.messageId')<>o.message_id))`,
    )
    .get()?.count;
  if (invalidFollowupOutbox)
    throw new Error('Cross-Session followup admission continuity is invalid.');
  const invalidFundingReceipts = database
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM agent_followup_funding_receipts f
       LEFT JOIN agent_mail_outbox o
         ON o.source_session_id=f.source_session_id AND o.message_id=f.message_id
       LEFT JOIN runtime_sessions source ON source.session_id=f.source_session_id
       LEFT JOIN runtime_sessions target ON target.session_id=f.target_session_id
       LEFT JOIN runtime_runs run
         ON run.session_id=f.target_session_id AND run.run_id=f.target_run_id
       LEFT JOIN model_artifacts surface ON surface.artifact_id=f.surface_artifact_id
       WHERE o.message_id IS NULL OR o.mode<>'trigger_turn'
         OR o.submission_id<>f.submission_id OR o.target_session_id<>f.target_session_id
         OR o.source_run_id<>f.funding_run_id
         OR source.session_id IS NULL OR target.session_id IS NULL
         OR target.parent_session_id<>source.session_id
         OR source.workspace_id<>target.workspace_id
         OR source.project_id<>target.project_id
         OR source.workspace_digest<>target.workspace_digest
         OR f.source_revision>source.revision OR f.target_revision>target.revision
         OR run.run_id IS NULL OR surface.artifact_id IS NULL OR surface.kind<>'model_surface'
         OR surface.integrity_identifier<>f.surface_digest`,
    )
    .get()?.count;
  if (invalidFundingReceipts)
    throw new Error('Cross-Session followup funding receipt continuity is invalid.');
  const invalidFollowupRoutes = database
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM agent_followup_routes r
       LEFT JOIN agent_mail_outbox o
         ON o.source_session_id=r.source_session_id AND o.message_id=r.message_id
       LEFT JOIN agent_mail_inbox i
         ON i.target_session_id=r.target_session_id AND i.message_id=r.message_id
       LEFT JOIN runtime_runs run
         ON run.session_id=r.target_session_id AND run.run_id=r.target_run_id
       LEFT JOIN runtime_sessions target ON target.session_id=r.target_session_id
       LEFT JOIN agent_followup_funding_receipts funding
         ON funding.source_session_id=r.source_session_id AND funding.submission_id=r.submission_id
       WHERE o.message_id IS NULL OR i.message_id IS NULL OR run.run_id IS NULL
         OR funding.submission_id IS NULL OR funding.message_id<>r.message_id
         OR funding.target_run_id<>r.target_run_id
         OR funding.model_invocation_id<>r.invocation_id
         OR target.session_id IS NULL OR target.parent_session_id<>r.source_session_id
         OR o.mode<>'trigger_turn' OR o.target_session_id<>r.target_session_id
         OR o.submission_id<>r.submission_id OR i.source_session_id<>r.source_session_id
         OR r.routed_revision>target.revision
         OR (r.route='current_turn' AND i.target_run_id IS NOT r.target_run_id)
         OR (r.route='new_turn' AND run.start_command_id<>('followup:' || r.submission_id))`,
    )
    .get()?.count;
  if (invalidFollowupRoutes) throw new Error('Cross-Session followup route continuity is invalid.');
  counts.agentMailOutbox = count(database, 'agent_mail_outbox');
  counts.agentMailInbox = count(database, 'agent_mail_inbox');
  counts.agentFollowupRoutes = count(database, 'agent_followup_routes');
  for (const row of database
    .query<
      {
        session_id: string;
        target_agent_id: string;
        source_run_id: string;
        recipient_run_id: string | null;
      },
      []
    >(
      `SELECT session_id,target_agent_id,source_run_id,recipient_run_id FROM agent_mail WHERE recipient_run_id IS NOT NULL`,
    )
    .iterate()) {
    if (row.target_agent_id !== row.session_id || row.recipient_run_id !== row.source_run_id)
      throw new Error('Agent mail recipient Run binding is invalid.');
  }
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
