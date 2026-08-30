import type { Database } from 'bun:sqlite';
import type {
  ArtifactPort,
  CheckpointPort,
  EffectLeasePort,
  RuntimeCommandReceiptLookupInput,
  RuntimeCommandReceiptPort,
  RuntimeEventMetadata,
  RuntimeRecoveryIdentityPort,
  RuntimeSessionDeletionInput,
  RuntimeSessionInfo,
  RuntimeSessionModelRoute,
  RuntimeStorage,
  RuntimeTransactionInput,
  SessionStore,
} from '@kite-ai/runtime-host/storage';
import {
  assertRuntimeRunStartResourceResult,
  createArtifactPort,
} from '@kite-ai/runtime-host/storage';
import type { SqliteWorkspaceAuthority } from './authority';
import { createKiteHomeArtifactStore, type KiteHomeArtifactStore } from './kite-home-artifacts';
import { createKiteHomeWorkspaceAuthority } from './kite-home-authority';
import {
  createKiteHomeDirectoryQuery,
  type KiteHomeDirectoryQueryPort,
} from './kite-home-directory';
import { createKiteHomeWorkspaceRuntimeJournal } from './kite-home-runtime-journal';
import { assertKiteHomeStoreSchema, KITE_HOME_STORE_SCHEMA_VERSION } from './kite-home-store';
import {
  createKiteHomeWorkspaceAdmissionPort,
  type KiteHomeWorkspaceAdmissionPort,
} from './kite-home-workspaces';
import { createKiteHomeWriteTransactionPort } from './kite-home-write';
import type { SqliteRuntimeSnapshotCodec } from './preflight';
import type { SqliteWorkspaceSessionCreationPort } from './transaction';

type Journal<Event, State> = ReturnType<typeof createKiteHomeWorkspaceRuntimeJournal<Event, State>>;

export interface KiteHomeRuntimeStorageOwner<Event, State> extends AsyncDisposable {
  readonly database: Database;
  readonly storage: RuntimeStorage<Event, State> & {
    readonly runs: NonNullable<RuntimeStorage<Event, State>['runs']>;
  };
  readonly admissions: KiteHomeWorkspaceAdmissionPort;
  readonly directory: KiteHomeDirectoryQueryPort;
  readonly artifactStore: KiteHomeArtifactStore;
  authorityForWorkspace(workspaceId: string): SqliteWorkspaceAuthority;
  sessionCreationForWorkspace(
    workspaceId: string,
  ): SqliteWorkspaceSessionCreationPort<Event, State>;
  close(): void;
}

/**
 * One connection/one writer Store 9 owner. Public RuntimeStorage methods route by the durable
 * Session Workspace FK; a new Session is routed only from its codec-owned State identity.
 */
export function createKiteHomeRuntimeStorageForConnection<Event, State>(input: {
  readonly database: Database;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly artifacts?: ArtifactPort;
  readonly ownsDatabase?: boolean;
  readonly now?: () => number;
}): KiteHomeRuntimeStorageOwner<Event, State> {
  assertKiteHomeStoreSchema(input.database);
  if (!Number.isSafeInteger(input.stateSchemaVersion) || input.stateSchemaVersion < 1) {
    throw new TypeError('Kite Home Runtime State schema is invalid.');
  }
  if (!input.formatEpoch || input.formatEpoch.length > 512 || /\p{Cc}/u.test(input.formatEpoch)) {
    throw new TypeError('Kite Home Runtime State format is invalid.');
  }
  const writer = createKiteHomeWriteTransactionPort(input.database);
  const rawAdmissions = createKiteHomeWorkspaceAdmissionPort({
    database: input.database,
    writer,
    ...(input.now ? { now: input.now } : {}),
  });
  const rawDirectory = createKiteHomeDirectoryQuery(input.database);
  const rawArtifacts = createKiteHomeArtifactStore(input.database);
  const artifacts = input.artifacts ?? createArtifactPort();
  const journals = new Map<string, Journal<Event, State>>();
  const authorities = new Map<string, SqliteWorkspaceAuthority>();
  let closed = false;

  const selectWorkspaceForSession = input.database.query<{ workspace_id: string }, [string]>(
    'SELECT workspace_id FROM runtime_sessions WHERE session_id = ? LIMIT 1',
  );
  const selectWorkspaceForReceipt = input.database.query<
    { workspace_id: string },
    [string, string]
  >(
    `SELECT workspace_id FROM runtime_command_receipts
      WHERE scope_session_id = ? AND command_id = ? LIMIT 1`,
  );
  const selectWorkspaceForIdentity = input.database.query<
    { workspace_id: string },
    [string, string]
  >(
    `SELECT workspace_id FROM workspaces
      WHERE project_id = ? AND workspace_digest = ?
      ORDER BY workspace_id LIMIT 2`,
  );

  const assertOpen = (): void => {
    if (closed) throw new Error('Kite Home Runtime storage is closed.');
  };
  const admissionPort: KiteHomeWorkspaceAdmissionPort = {
    admit(workspace) {
      assertOpen();
      return rawAdmissions.admit(workspace);
    },
    get(workspaceId) {
      assertOpen();
      return rawAdmissions.get(workspaceId);
    },
  };
  const admissions = Object.freeze(admissionPort);
  const directory: KiteHomeDirectoryQueryPort = Object.freeze({
    list() {
      assertOpen();
      return rawDirectory.list();
    },
  });
  const artifactStore = transactionalArtifactStore(rawArtifacts, writer, assertOpen);
  const authorityForWorkspace = (workspaceId: string): SqliteWorkspaceAuthority => {
    assertOpen();
    const current = authorities.get(workspaceId);
    if (current) return current;
    const workspace = admissions.get(workspaceId);
    if (!workspace) throw new Error('Runtime Workspace is not admitted.');
    const authority = createKiteHomeWorkspaceAuthority({
      database: input.database,
      writer,
      workspace,
      ...(input.now ? { nowMs: input.now } : {}),
    });
    authorities.set(workspaceId, authority);
    return authority;
  };
  const journalForWorkspace = (workspaceId: string): Journal<Event, State> => {
    assertOpen();
    const current = journals.get(workspaceId);
    if (current) return current;
    const workspace = admissions.get(workspaceId);
    if (!workspace) throw new Error('Runtime Workspace is not admitted.');
    const journal = createKiteHomeWorkspaceRuntimeJournal({
      database: input.database,
      writer,
      workspace,
      codec: input.codec,
      stateSchemaVersion: input.stateSchemaVersion,
      formatEpoch: input.formatEpoch,
      isClosed: () => closed,
      ...(input.now ? { now: input.now } : {}),
    });
    journals.set(workspaceId, journal);
    return journal;
  };
  const journalForSession = (sessionId: string): Journal<Event, State> | null => {
    assertOpen();
    const row = selectWorkspaceForSession.get(sessionId);
    return row ? journalForWorkspace(row.workspace_id) : null;
  };
  const journalForState = (state: State): Journal<Event, State> => {
    const identity = input.codec.sessionIdentity?.(state);
    if (!identity) throw new Error('Runtime State has no Workspace identity.');
    const rows = selectWorkspaceForIdentity.all(
      identity.projectId,
      identity.canonicalWorkspaceDigest,
    );
    if (rows.length !== 1) {
      throw new Error('Runtime State Workspace identity is absent or ambiguous.');
    }
    return journalForWorkspace(rows[0]!.workspace_id);
  };
  const journalForTransaction = (
    transaction: RuntimeTransactionInput<Event, State>,
  ): Journal<Event, State> =>
    journalForSession(transaction.sessionId) ?? journalForState(transaction.snapshot);

  const sessions: SessionStore<Event, State> = Object.freeze({
    appendEvents(
      sessionId: string,
      events: readonly Event[],
      metadata?: readonly RuntimeEventMetadata[],
    ): void {
      const journal = journalForSession(sessionId);
      if (!journal) throw new Error('Runtime Session is not admitted.');
      journal.sessions.appendEvents(sessionId, events, metadata);
    },
    loadEventsStrict: (sessionId: string, since?: number) =>
      journalForSession(sessionId)?.sessions.loadEventsStrict(sessionId, since) ?? [],
    saveSnapshot(sessionId: string, state: State): void {
      (journalForSession(sessionId) ?? journalForState(state)).sessions.saveSnapshot(
        sessionId,
        state,
      );
    },
    loadSnapshot: <Loaded = State>(sessionId: string): Loaded | null =>
      journalForSession(sessionId)?.sessions.loadSnapshot<Loaded>(sessionId) ?? null,
    loadSnapshotRecord: <Loaded = State>(sessionId: string) =>
      journalForSession(sessionId)?.sessions.loadSnapshotRecord<Loaded>(sessionId) ?? null,
    getLastEventPosition: (sessionId: string) =>
      journalForSession(sessionId)?.sessions.getLastEventPosition(sessionId) ?? 0,
    listSessions(query = '', limit = 50): RuntimeSessionInfo[] {
      assertListLimit(limit);
      const entries = input.database
        .query<{ workspace_id: string }, []>('SELECT workspace_id FROM workspaces')
        .all()
        .flatMap((row) => journalForWorkspace(row.workspace_id).sessions.listSessions(query, 256))
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId),
        );
      return entries.slice(0, limit);
    },
    setSessionName(sessionId: string, name: string): void {
      const journal = journalForSession(sessionId);
      if (!journal) throw new Error('Runtime Session is not admitted.');
      journal.sessions.setSessionName(sessionId, name);
    },
    getSessionModelRoute(sessionId: string): RuntimeSessionModelRoute | null {
      return journalForSession(sessionId)?.sessions.getSessionModelRoute(sessionId) ?? null;
    },
    setSessionModelRoute(sessionId: string, route: RuntimeSessionModelRoute): void {
      const journal = journalForSession(sessionId);
      if (!journal) throw new Error('Runtime Session is not admitted.');
      journal.sessions.setSessionModelRoute(sessionId, route);
    },
    deleteSession(sessionId: string, deletion?: RuntimeSessionDeletionInput): void {
      const journal = journalForSession(sessionId);
      if (journal) journal.sessions.deleteSession(sessionId, deletion);
    },
  });

  const transactions: RuntimeStorage<Event, State>['transactions'] = {
    commitDecision: (transaction) =>
      journalForTransaction(transaction).transactions.commitDecision(transaction),
    commitAttemptStart: (transaction) =>
      journalForTransaction(transaction).transactions.commitAttemptStart(transaction),
    commitReceiptEvidence: (transaction) =>
      journalForTransaction(transaction).transactions.commitReceiptEvidence(transaction),
    commitTerminalRecovery: (transaction) =>
      journalForTransaction(transaction).transactions.commitTerminalRecovery(transaction),
  };
  Object.freeze(transactions);

  const effects: EffectLeasePort = {
    tryAcquireEffectLease(sessionId, effectId, ownerId, expiresAtMs) {
      const journal = journalForSession(sessionId);
      return (
        journal?.effects.tryAcquireEffectLease(sessionId, effectId, ownerId, expiresAtMs) ?? false
      );
    },
    renewEffectLease(sessionId, effectId, ownerId, expiresAtMs) {
      const journal = journalForSession(sessionId);
      return journal?.effects.renewEffectLease(sessionId, effectId, ownerId, expiresAtMs) ?? false;
    },
    releaseEffectLease(sessionId, effectId, ownerId) {
      journalForSession(sessionId)?.effects.releaseEffectLease(sessionId, effectId, ownerId);
    },
  };
  Object.freeze(effects);

  const recoveryIdentities: RuntimeRecoveryIdentityPort = {
    read(sessionId) {
      const journal = journalForSession(sessionId);
      return journal?.recoveryIdentities.read(sessionId) ?? null;
    },
    getOrCreate(sessionId, allocate) {
      const journal = journalForSession(sessionId);
      if (!journal) throw new Error('Runtime Session is not admitted.');
      return journal.recoveryIdentities.getOrCreate(sessionId, allocate);
    },
    remove(sessionId) {
      journalForSession(sessionId)?.recoveryIdentities.remove(sessionId);
    },
  };
  Object.freeze(recoveryIdentities);

  const commandReceipts: RuntimeCommandReceiptPort = {
    lookup(receipt: RuntimeCommandReceiptLookupInput) {
      assertReceiptLookup(receipt);
      const row = selectWorkspaceForReceipt.get(receipt.scopeSessionId, receipt.commandId);
      return row
        ? journalForWorkspace(row.workspace_id).commandReceipts.lookup(receipt)
        : { status: 'missing' as const };
    },
  };
  Object.freeze(commandReceipts);

  const checkpoints: CheckpointPort<State> = {
    saveNamedSnapshot(sessionId, name, state, position) {
      (journalForSession(sessionId) ?? journalForState(state)).checkpoints.saveNamedSnapshot(
        sessionId,
        name,
        state,
        position,
      );
    },
    loadNamedSnapshot: <Loaded = State>(sessionId: string, name: string) =>
      journalForSession(sessionId)?.checkpoints.loadNamedSnapshot<Loaded>(sessionId, name) ?? null,
    listNamedSnapshots: (sessionId) =>
      journalForSession(sessionId)?.checkpoints.listNamedSnapshots(sessionId) ?? [],
    getNamedSnapshotEntry: (sessionId, snapshotId) =>
      journalForSession(sessionId)?.checkpoints.getNamedSnapshotEntry(sessionId, snapshotId) ??
      null,
    restoreNamedSnapshot: (sessionId, snapshotId) =>
      journalForSession(sessionId)?.checkpoints.restoreNamedSnapshot(sessionId, snapshotId) ??
      false,
    forkSession: (source, snapshot, target, recovery) =>
      journalForSession(source)?.checkpoints.forkSession(source, snapshot, target, recovery) ??
      false,
    forkSessionForCommand: (forkInput) =>
      journalForSession(forkInput.sourceSessionId)?.checkpoints.forkSessionForCommand(
        forkInput,
      ) ?? {
        status: 'unavailable',
      },
    forkCurrentSession: (source, target, recovery) =>
      journalForSession(source)?.checkpoints.forkCurrentSession(source, target, recovery) ?? false,
    recordFilePreimage(sessionId, path, content, existed) {
      journalForSession(sessionId)?.checkpoints.recordFilePreimage(
        sessionId,
        path,
        content,
        existed,
      );
    },
    recordFilePostimage(sessionId, path, hash, existed) {
      journalForSession(sessionId)?.checkpoints.recordFilePostimage(sessionId, path, hash, existed);
    },
    fileRestorePlan: (sessionId, position) =>
      journalForSession(sessionId)?.checkpoints.fileRestorePlan(sessionId, position) ?? [],
  };
  Object.freeze(checkpoints);

  const runs: NonNullable<RuntimeStorage<Event, State>['runs']> = {
    get(sessionId, runId) {
      return journalForSession(sessionId)?.runs.get(sessionId, runId) ?? null;
    },
    getActive(sessionId) {
      return journalForSession(sessionId)?.runs.getActive(sessionId) ?? null;
    },
    list(request) {
      const journal = journalForSession(request.sessionId);
      if (!journal) throw new Error('Runtime Session is not admitted.');
      return journal.runs.list(request);
    },
    insert(run) {
      const journal = journalForSession(run.sessionId);
      if (!journal) throw new Error('Runtime Session is not admitted.');
      journal.runs.insert(run);
    },
    transition(transition) {
      const journal = journalForSession(transition.sessionId);
      return journal?.runs.transition(transition) ?? 'missing';
    },
    rewindSession(sessionId, revision) {
      const journal = journalForSession(sessionId);
      return (
        journal?.runs.rewindSession(sessionId, revision) ?? {
          status: 'invalid_boundary',
        }
      );
    },
    forkSession(forkInput) {
      const journal = journalForSession(forkInput.sourceSessionId);
      return journal?.runs.forkSession(forkInput) ?? { status: 'invalid_boundary' };
    },
  };
  Object.freeze(runs);

  validateExistingFacts();

  const storage: KiteHomeRuntimeStorageOwner<Event, State>['storage'] = Object.freeze({
    adapterId: 'kite-home-sqlite',
    stateSchemaVersion: input.stateSchemaVersion,
    storeSchemaVersion: KITE_HOME_STORE_SCHEMA_VERSION,
    formatEpoch: input.formatEpoch,
    sessions,
    transactions,
    effects,
    checkpoints,
    artifacts,
    recoveryIdentities,
    commandReceipts,
    runs,
    close,
  });

  const owner: KiteHomeRuntimeStorageOwner<Event, State> = {
    database: input.database,
    storage,
    admissions,
    directory,
    artifactStore,
    authorityForWorkspace,
    sessionCreationForWorkspace: (workspaceId) =>
      journalForWorkspace(workspaceId).workspaceSessionCreation,
    close,
    [Symbol.asyncDispose]: async () => close(),
  };
  return Object.freeze(owner);

  function close(): void {
    if (closed) return;
    closed = true;
    journals.clear();
    authorities.clear();
    if (input.ownsDatabase) input.database.close(false);
  }

  function validateExistingFacts(): void {
    const workspaceRows = input.database
      .query<{ workspace_id: string }, []>(
        'SELECT workspace_id FROM workspaces ORDER BY workspace_id',
      )
      .all();
    for (const row of workspaceRows) admissions.get(row.workspace_id);

    const sessionRows = input.database
      .query<
        {
          session_id: string;
          workspace_id: string;
          project_id: string;
          workspace_digest: string;
          state_schema: number;
          format_epoch: string;
          revision: number;
        },
        []
      >(
        `SELECT session_id, workspace_id, project_id, workspace_digest,
                state_schema, format_epoch, revision
           FROM runtime_sessions ORDER BY session_id`,
      )
      .all();
    for (const session of sessionRows) {
      const workspace = admissions.get(session.workspace_id);
      if (
        !workspace ||
        session.project_id !== workspace.projectId ||
        session.workspace_digest !== workspace.workspaceDigest ||
        session.state_schema !== input.stateSchemaVersion ||
        session.format_epoch !== input.formatEpoch
      ) {
        throw new Error('Kite Home Runtime Session binding is invalid.');
      }
      const journal = journalForWorkspace(session.workspace_id);
      const record = journal.sessions.loadSnapshotRecord<State>(session.session_id);
      if (
        !record ||
        record.metadata.schemaVersion !== input.stateSchemaVersion ||
        record.metadata.stateRevision !== session.revision
      ) {
        throw new Error('Kite Home Runtime rolling snapshot is incomplete.');
      }
      const identity = input.codec.sessionIdentity?.(record.state);
      if (
        !identity ||
        identity.projectId !== workspace.projectId ||
        identity.canonicalWorkspaceDigest !== workspace.workspaceDigest
      ) {
        throw new Error('Kite Home Runtime snapshot Workspace identity is invalid.');
      }
      const events = input.database
        .query<{ sequence: number; schema_version: number; event_json: string }, [string]>(
          `SELECT sequence, schema_version, event_json FROM runtime_events
            WHERE session_id = ? ORDER BY sequence`,
        )
        .all(session.session_id);
      for (const [index, event] of events.entries()) {
        if (event.sequence !== index + 1 || event.schema_version !== input.stateSchemaVersion) {
          throw new Error('Kite Home Runtime event sequence or schema is invalid.');
        }
        input.codec.decodeEvent(event.event_json);
      }
      const eventRevision =
        journal.sessions
          .loadEventsStrict(session.session_id)
          .filter((event) => event.id <= record.metadata.eventPosition)
          .at(-1)?.revision ?? 0;
      input.codec.validateSnapshot?.({
        state: record.state,
        sessionId: session.session_id,
        eventPosition: record.metadata.eventPosition,
        stateRevision: record.metadata.stateRevision,
        schemaVersion: record.metadata.schemaVersion,
        eventRevision,
      });
      let cursor: { readonly createdRevision: number; readonly runId: string } | undefined;
      for (;;) {
        const page = journal.runs.list({
          sessionId: session.session_id,
          ...(cursor ? { cursor } : {}),
          limit: 200,
        });
        for (const run of page.entries) {
          if (run.originSessionId !== undefined) continue;
          const lookup = journal.commandReceipts.lookup({
            scopeSessionId: session.session_id,
            commandId: run.startCommandId,
            requestDigest:
              input.database
                .query<{ request_digest: string }, [string, string]>(
                  `SELECT request_digest FROM runtime_command_receipts
                    WHERE scope_session_id = ? AND command_id = ? LIMIT 1`,
                )
                .get(session.session_id, run.startCommandId)?.request_digest ?? '',
          });
          if (lookup.status !== 'replay' || !lookup.receipt.resourceResult) {
            throw new Error('Kite Home Runtime Run start receipt is missing.');
          }
          assertRuntimeRunStartResourceResult(lookup.receipt.resourceResult, run);
        }
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }
    const activeDuplicates = input.database
      .query<{ session_id: string }, []>(
        `SELECT session_id FROM runtime_runs
          WHERE status IN ('queued', 'running', 'waiting')
          GROUP BY session_id HAVING count(*) > 1 LIMIT 1`,
      )
      .get();
    if (activeDuplicates) throw new Error('Kite Home Runtime has multiple active Runs.');

    for (const receipt of input.database
      .query<
        {
          scope_session_id: string;
          command_id: string;
          workspace_id: string;
          request_digest: string;
        },
        []
      >(
        `SELECT scope_session_id, command_id, workspace_id, request_digest
           FROM runtime_command_receipts ORDER BY scope_session_id, command_id`,
      )
      .all()) {
      const lookup = journalForWorkspace(receipt.workspace_id).commandReceipts.lookup({
        scopeSessionId: receipt.scope_session_id,
        commandId: receipt.command_id,
        requestDigest: receipt.request_digest,
      });
      if (lookup.status !== 'replay') {
        throw new Error('Kite Home Runtime command receipt is invalid.');
      }
    }
    validateArtifactPayloadLengths(input.database);
  }
}

function transactionalArtifactStore(
  store: KiteHomeArtifactStore,
  writer: ReturnType<typeof createKiteHomeWriteTransactionPort>,
  assertOpen: () => void,
): KiteHomeArtifactStore {
  const transactional: KiteHomeArtifactStore = {
    writeModel(input) {
      assertOpen();
      writer.run(() => store.writeModel(input));
    },
    readModel(ref) {
      assertOpen();
      return store.readModel(ref);
    },
    collectModelGarbage(input) {
      assertOpen();
      return writer.run(() => store.collectModelGarbage(input));
    },
    writePlan(input) {
      assertOpen();
      writer.run(() => store.writePlan(input));
    },
    readPlan(ref) {
      assertOpen();
      return store.readPlan(ref);
    },
    collectPlanGarbage(input) {
      assertOpen();
      return writer.run(() => store.collectPlanGarbage(input));
    },
    writeCapability(input) {
      assertOpen();
      writer.run(() => store.writeCapability(input));
    },
    readCapability(ref) {
      assertOpen();
      return store.readCapability(ref);
    },
    collectCapabilityGarbage(input) {
      assertOpen();
      return writer.run(() => store.collectCapabilityGarbage(input));
    },
    writeFilesystemPreimage(input) {
      assertOpen();
      writer.run(() => store.writeFilesystemPreimage(input));
    },
    readFilesystemPreimage(ref) {
      assertOpen();
      return store.readFilesystemPreimage(ref);
    },
    collectFilesystemPreimageGarbage(input) {
      assertOpen();
      return writer.run(() => store.collectFilesystemPreimageGarbage(input));
    },
    writeSandboxPreparation(input) {
      assertOpen();
      writer.run(() => store.writeSandboxPreparation(input));
    },
    readSandboxPreparation(ref) {
      assertOpen();
      return store.readSandboxPreparation(ref);
    },
    collectSandboxPreparationGarbage(input) {
      assertOpen();
      return writer.run(() => store.collectSandboxPreparationGarbage(input));
    },
    writeSubagentTask(input) {
      assertOpen();
      writer.run(() => store.writeSubagentTask(input));
    },
    readSubagentTask(ref) {
      assertOpen();
      return store.readSubagentTask(ref);
    },
    collectSubagentTaskGarbage(input) {
      assertOpen();
      return writer.run(() => store.collectSubagentTaskGarbage(input));
    },
    writeSubagentLifecycle(input) {
      assertOpen();
      writer.run(() => store.writeSubagentLifecycle(input));
    },
    readSubagentLifecycle(ref) {
      assertOpen();
      return store.readSubagentLifecycle(ref);
    },
    collectSubagentLifecycleGarbage(input) {
      assertOpen();
      return writer.run(() => store.collectSubagentLifecycleGarbage(input));
    },
    writeSubagentContinuation(input) {
      assertOpen();
      writer.run(() => store.writeSubagentContinuation(input));
    },
    readSubagentContinuation(ref) {
      assertOpen();
      return store.readSubagentContinuation(ref);
    },
    collectSubagentContinuationGarbage(input) {
      assertOpen();
      return writer.run(() => store.collectSubagentContinuationGarbage(input));
    },
  };
  return Object.freeze(transactional);
}

function assertListLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
    throw new RangeError('Runtime Session list limit is invalid.');
  }
}

function assertReceiptLookup(input: RuntimeCommandReceiptLookupInput): void {
  if (!input.scopeSessionId || !input.commandId || !/^[a-f0-9]{64}$/u.test(input.requestDigest)) {
    throw new TypeError('Runtime command receipt lookup is invalid.');
  }
}

function validateArtifactPayloadLengths(database: Database): void {
  const domains = [
    ['model_artifacts', 'canonical_json'],
    ['plan_artifacts', 'markdown'],
    ['capability_artifacts', 'canonical_json'],
    ['filesystem_preimage_artifacts', 'canonical_json'],
    ['sandbox_preparation_artifacts', 'canonical_json'],
    ['subagent_task_artifacts', 'canonical_json'],
    ['subagent_lifecycle_artifacts', 'canonical_json'],
    ['subagent_continuation_artifacts', 'canonical_json'],
  ] as const;
  for (const [table, payload] of domains) {
    for (const row of database
      .query<{ body: string; byte_length: number }, []>(
        `SELECT ${payload} AS body, byte_length FROM ${table}`,
      )
      .iterate()) {
      if (Buffer.byteLength(row.body, 'utf8') !== row.byte_length) {
        throw new Error(`Kite Home ${table} payload length is invalid.`);
      }
      if (payload === 'canonical_json') {
        JSON.parse(row.body);
      }
    }
  }
}
