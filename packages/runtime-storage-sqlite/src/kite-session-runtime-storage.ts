import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type {
  ArtifactPort,
  RuntimeChildSessionIntentMutation,
  RuntimeLogQueryPort,
  RuntimeStorage,
  RuntimeStoredCommandReceipt,
  RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';
import {
  inspectSqliteWorkspaceAuthorityMetadataKey,
  SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA,
  type SqliteWorkspaceControllerOperationResult,
  type SqliteWorkspaceInitialControllerInput,
} from './authority';
import { assertSqliteRuntimeCommandReceipt } from './command-receipts';
import {
  decideChildApprovalProxyInTransaction,
  listPendingChildApprovalProxies,
  readChildApprovalProxy,
  synchronizeChildApprovalProxyInTransaction,
} from './kite-child-approval-proxy';
import {
  assertChildRecoveryDiagnosticInTransaction,
  assertChildRuntimeActivationInTransaction,
  assertChildUnknownTerminalSealInTransaction,
  type KiteChildSessionIntentRecord,
  type KitePendingChildTerminalSeal,
  listPendingChildSessionIntents,
  persistChildSessionIntentInTransaction,
  readChildSealedGrant,
  readChildSessionIntent,
  readPendingAfterTurnChildTerminalSeal,
  recordChildDispatchAckInTransaction,
  recordChildParentSettlementInTransaction,
  settleChildCreationFailureInTransaction,
} from './kite-child-session-intents';
import {
  acceptCrossSessionInterruptInTransaction,
  acknowledgeCrossSessionInterruptInTransaction,
  assertNoQueuedInterruptBeforeChildActivation,
  listPendingCrossSessionInterrupts,
  listPendingCrossSessionInterruptTargets,
  readCrossSessionInterruptIntent,
  readCrossSessionInterruptTarget,
  settleCrossSessionInterruptInTransaction,
  settleQueuedCrossSessionInterruptInTransaction,
} from './kite-cross-session-agent-interrupt';
import {
  acceptCrossSessionAcceptedReleaseNoticeInTransaction,
  acceptCrossSessionFollowupTerminalReplyInTransaction,
  acceptCrossSessionQueueMailInTransaction,
  type CrossSessionInboxReceipt,
  type CrossSessionMailOutboxRecord,
  type CrossSessionQueuedMail,
  confirmCrossSessionQueueMailInTransaction,
  listPendingCrossSessionQueueMail,
  listPendingCrossSessionQueueMailSources,
  listPendingCrossSessionTerminalReplyMail,
  listPendingCrossSessionTerminalReplyMailSources,
  listQueuedCrossSessionInbox,
  listUnnotifiedAcceptedFollowupReleases,
  listUnrepliedSettledFollowupTerminalSources,
  nextCrossSessionSourceSequence,
  nextCrossSessionTargetSequence,
  prepareCrossSessionQueueMailInputInTransaction,
  readCrossSessionInboxReceipt,
  readCrossSessionMail,
  readCrossSessionPreparedThrough,
  readDirectChildInboxWatermark,
  readUnreadDirectChildMail,
  receiveCrossSessionQueueMailInTransaction,
} from './kite-cross-session-agent-mail';
import {
  acceptCrossSessionFollowupInTransaction,
  activateCrossSessionFollowupFundingInTransaction,
  activateIndependentCrossSessionFollowupTurnInTransaction,
  assertCrossSessionFollowupRunStartInTransaction,
  type CrossSessionFollowupActivationReceipt,
  type CrossSessionFollowupFundingReceipt,
  type CrossSessionFollowupRouteReceipt,
  type CrossSessionFollowupTerminalReceipt,
  isAdmittedQueuedChildFollowupTarget,
  listPendingCrossSessionFollowupFunding,
  listPendingCrossSessionFollowupSources,
  type PendingCrossSessionFollowupFunding,
  readAcceptedIndependentFollowupSourcePolicyProof,
  readChildTerminalCheckpoint,
  readCrossSessionCurrentTurnBackupReleaseForTarget,
  readCrossSessionCurrentTurnPreparedNoAttemptProof,
  readCrossSessionFollowupActivationReceipt,
  readCrossSessionFollowupAdmissionBySubmissionForTarget,
  readCrossSessionFollowupDeliveryForTarget,
  readCrossSessionFollowupFundingReceipt,
  readCrossSessionFollowupGrant,
  readCrossSessionFollowupRoute,
  readCrossSessionFollowupTerminalReceipt,
  readCurrentTurnDispatchedChildProofForSource,
  readCurrentTurnRoutedNoAttemptChildProofForSource,
  readDirectChildFollowupOutcomeWatermark,
  readDirectChildFollowupReleaseWatermark,
  readIndependentCrossSessionFollowupActivation,
  readLastFollowupOutcomeForDirectChild,
  readLastReleasedFollowupForDirectChild,
  readPreparedCrossSessionFollowupRecoveryProof,
  readTargetSnapshotEvidence,
  readUnroutedCrossSessionFollowupMessage,
  receiveCrossSessionFollowupInTransaction,
  releaseAcceptedCrossSessionFollowupBackupInTransaction,
  releaseCrossSessionCurrentTurnBackupInTransaction,
  replaceCrossSessionFollowupBackupInTransaction,
  routeCrossSessionFollowupInTransaction,
  sealChildTerminalCheckpointInTransaction,
  settleCancelledAcceptedFollowupsInTransaction,
  settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction,
  settleCrossSessionFollowupFundingInTransaction,
  settleIndependentCrossSessionFollowupFundingInTransaction,
  verifyPersistedCrossSessionFollowupRunStart,
} from './kite-cross-session-followup';
import type { KiteHomeArtifactStore } from './kite-home-artifacts';
import type { KiteHomeDirectoryQueryPort } from './kite-home-directory';
import {
  createKiteHomeRuntimeStorageForConnection,
  type KiteHomeRuntimeStorageOwner,
} from './kite-home-runtime-storage';
import { assertKiteSessionStoreSchema, KITE_SESSION_STORE_SCHEMA_VERSION } from './kite-home-store';
import type { KiteHomeWorkspaceAdmissionPort } from './kite-home-workspaces';
import {
  createKiteHomeWriteTransactionPort,
  type KiteHomeWriteTransactionPort,
} from './kite-home-write';
import {
  applyKiteSessionAgentMailboxMutations,
  assertModelAdmissionForPreparedMail,
  createKiteSessionAgentMetadataPort,
  ensureRootAgentOnInitialCreationInTransaction,
  type KiteSessionAgentMetadataPort,
  settleRootAgentRunInTransaction,
  startRootAgentRunInTransaction,
} from './kite-session-agent-mailbox';
import { createKiteSessionEffectPort, type KiteSessionEffectRecord } from './kite-session-effects';
import {
  createKiteSessionExecutionAuthority,
  type KiteSessionExecutionAuthority,
  type KiteSessionExecutionAuthorityRecord,
} from './kite-session-execution-authority';
import {
  acquireKiteSessionStoreMaintenance,
  type KiteSessionWindowsPathSecurity,
} from './kite-session-maintenance';
import {
  createKiteSessionMutationPort,
  KiteSessionMutationError,
  type KiteSessionMutationInput,
} from './kite-session-mutation';
import {
  KiteSessionStoreOpenError,
  openKiteSessionStoreDatabase,
} from './kite-session-runtime-file';
import { inspectKiteSessionPublication } from './kite-session-store-publication';
import { assertKiteSessionStoreSourcesReconciled } from './kite-session-store-sources';
import {
  prepareKiteSessionTreeArtifactDeletion,
  prepareKiteSessionTreeDeletion,
  prepareKiteWorkspaceSessionDeletion,
  removeKiteSessionTreeReferences,
  removeUnreferencedKiteSessionTreeArtifacts,
} from './kite-session-tree-deletion';
import {
  createKiteWorkspaceDeletionFence,
  workspaceDeletionFenceKey,
} from './kite-workspace-deletion-fence';
import { createSqliteRuntimeLogQueryPortFromDatabase_ } from './log-query';
import type { SqliteRuntimeSnapshotCodec } from './preflight';
import {
  type DirectChildSessionCursor,
  type DirectChildSessionRecord,
  listDirectChildSessions,
  readDirectChildSession,
} from './session-lineage';
import type {
  InitialControllerTransactionPort,
  SqliteWorkspaceSessionCreationInput,
  SqliteWorkspaceSessionCreationPort,
  SqliteWorkspaceSessionCreationResult,
} from './transaction';

export class KiteSessionRuntimeStorageError extends Error {
  readonly code:
    | 'execution_scope_required'
    | 'foreign_execution_handle'
    | 'stale_execution_handle'
    | 'session_busy'
    | 'unsupported_mutation';

  constructor(code: KiteSessionRuntimeStorageError['code'], message: string) {
    super(message);
    this.name = 'KiteSessionRuntimeStorageError';
    this.code = code;
  }
}

export interface KiteSessionExecutionHandle {
  readonly sessionId: string;
  snapshot(): KiteSessionMutationInput;
}

export type KiteSessionExecutionControl = Pick<
  KiteSessionExecutionAuthority,
  'read' | 'acquire' | 'renew' | 'detach' | 'release'
>;

export interface KiteSessionRecoveryPort {
  confirmCleanup(input: {
    readonly sessionId: string;
    readonly expectedAuthorityRevision: number;
  }): void;
  inspect(sessionId: string): Readonly<{
    authority: KiteSessionExecutionAuthorityRecord;
    pendingEffects: readonly KiteSessionEffectRecord[];
    unknownEffects: readonly KiteSessionEffectRecord[];
  }>;
  reconcile(input: {
    readonly sessionId: string;
    readonly expectedAuthorityRevision: number;
  }): Readonly<{
    authority: KiteSessionExecutionAuthorityRecord;
    unknownEffects: readonly KiteSessionEffectRecord[];
  }>;
}

export interface KiteSessionRuntimeStorageOwner<Event, State> extends AsyncDisposable {
  readonly storage: RuntimeStorage<Event, State> & {
    readonly runs: NonNullable<RuntimeStorage<Event, State>['runs']>;
    readonly agentMailbox: KiteSessionAgentMailboxPort;
    readonly agentMailInput: KiteSessionAgentMailInputPort;
    readonly crossSessionQueueMail: KiteCrossSessionQueueMailPort;
    readonly currentExecutionGeneration: (sessionId: string) => string;
  };
  readonly admissions: KiteHomeWorkspaceAdmissionPort;
  getAdmittedWorkspace(workspaceId: string): ReturnType<KiteHomeWorkspaceAdmissionPort['get']>;
  getAdmittedWorkspaceByDigest(
    workspaceDigest: string,
  ): ReturnType<KiteHomeWorkspaceAdmissionPort['get']>;
  readonly workspaceDeletion: ReturnType<typeof createKiteWorkspaceDeletionFence>;
  readonly directory: KiteHomeDirectoryQueryPort;
  readonly openHistoryLogs: import('./kite-home-runtime-storage').KiteHomeRuntimeStorageOwner<
    Event,
    State
  >['openHistoryLogs'];
  readonly readSessionLineage: import('./kite-home-runtime-storage').KiteHomeRuntimeStorageOwner<
    Event,
    State
  >['readSessionLineage'];
  listChildSessions(
    parentSessionId: string,
    limit: number,
    cursor?: DirectChildSessionCursor,
  ): {
    readonly entries: readonly DirectChildSessionRecord[];
    readonly nextCursor?: DirectChildSessionCursor;
  };
  readChildSession(
    parentSessionId: string,
    childSessionId: string,
  ): (DirectChildSessionRecord & { readonly state: Readonly<State> }) | null;
  openChildSessionHistoryLogs(
    parentSessionId: string,
    childSessionId: string,
    currentEventTypes: readonly string[],
  ): Pick<RuntimeLogQueryPort<Event>, 'getSession' | 'listEvents' | 'close'>;
  readChildSessionIntent(childThreadId: string): KiteChildSessionIntentRecord | null;
  readPendingAfterTurnChildTerminalSeal(
    parentSessionId: string,
    childThreadId: string,
  ): KitePendingChildTerminalSeal | null;
  /** Private bytes require the exact parent execution or recovery handle scope. */
  readChildSealedGrant(childThreadId: string): ReturnType<typeof readChildSealedGrant>;
  listPendingChildSessionIntents(
    parentSessionId: string,
    limit: number,
    cursor?: string,
  ): { readonly entries: readonly KiteChildSessionIntentRecord[]; readonly nextCursor?: string };
  readChildApprovalProxy(
    parentSessionId: string,
    proxyInteractionId: string,
  ): ReturnType<typeof readChildApprovalProxy>;
  listPendingChildApprovalProxies(
    parentSessionId: string,
    limit: number,
    afterProxyInteractionId?: string,
  ): ReturnType<typeof listPendingChildApprovalProxies>;
  /** Read-only, bounded source index for restart delivery; it grants no execution authority. */
  listPendingCrossSessionQueueMailSources(
    limit: number,
    afterSessionId?: string,
  ): readonly string[];
  listPendingCrossSessionTerminalReplyMailSources(
    limit: number,
    afterSessionId?: string,
  ): readonly string[];
  listUnrepliedSettledFollowupTerminalSources(
    limit: number,
    after?: { readonly childSessionId: string; readonly submissionId: string },
  ): ReturnType<typeof listUnrepliedSettledFollowupTerminalSources>;
  listUnnotifiedAcceptedFollowupReleases(
    limit: number,
    after?: { readonly childSessionId: string; readonly submissionId: string },
  ): ReturnType<typeof listUnnotifiedAcceptedFollowupReleases>;
  /** Global read-only recovery candidate index; it grants no target execution owner. */
  listPendingCrossSessionInterruptTargets(
    limit: number,
    afterSessionId?: string,
  ): readonly string[];
  /** Separate TriggerTurn index; QueueOnly recovery never reads these rows. */
  listPendingCrossSessionFollowupSources(limit: number, afterSessionId?: string): readonly string[];
  readonly artifactStore: KiteHomeArtifactStore;
  readonly agentMailbox: KiteSessionAgentMailboxPort;
  readonly agentMailInput: KiteSessionAgentMailInputPort;
  readonly crossSessionQueueMail: KiteCrossSessionQueueMailPort;
  readonly currentExecutionGeneration: (sessionId: string) => string;
  readonly authority: KiteSessionExecutionControl;
  readonly recovery: KiteSessionRecoveryPort;
  /** Settle a fenced, fully terminal Session without changing its historical State or Runs. */
  reconcileSettledSession(input: {
    readonly sessionId: string;
    readonly expectedAuthorityRevision: number;
    readonly isSettledState: (state: Readonly<State>) => boolean;
  }): boolean;
  /** Fence recovery facts and lease an execution generation for terminal cleanup only. */
  beginRecoveryExecution(input: {
    readonly sessionId: string;
    readonly expectedAuthorityRevision: number;
    readonly hostInstanceId: string;
    readonly clientId: string | null;
    readonly connectionGeneration: number;
    readonly leaseUntilMs: number;
  }): KiteSessionExecutionAuthorityRecord;
  sessionCreationForWorkspace(
    workspaceId: string,
  ): SqliteWorkspaceSessionCreationPort<Event, State>;
  createChildSession(
    creation: SqliteWorkspaceSessionCreationInput<Event, State> & {
      readonly childSessionIntent: RuntimeChildSessionIntentMutation;
    },
  ): SqliteWorkspaceSessionCreationResult;
  bindExecution(authority: KiteSessionExecutionAuthorityRecord): KiteSessionExecutionHandle;
  refreshExecution(
    handle: KiteSessionExecutionHandle,
    authority: KiteSessionExecutionAuthorityRecord,
  ): void;
  runWithExecution<Result>(handle: KiteSessionExecutionHandle, operation: () => Result): Result;
  /** Delete one root tree as data, retaining one exact command receipt. */
  deleteSessionDataTree(
    rootSessionId: string,
    makeReceipt: (currentRevision: number) => RuntimeStoredCommandReceipt,
  ): RuntimeStoredCommandReceipt | null;
  /** Delete all Session data in one Workspace in one writer transaction. */
  deleteWorkspaceSessionData(workspaceId: string): Readonly<{
    rootSessionIds: readonly string[];
    sessionIds: readonly string[];
  }>;
  /** Read-only metadata enumeration for starting local cancellation before deletion. */
  listWorkspaceSessionIds(workspaceId: string): readonly string[];
  /** Metadata-only identity for delete admission, including an existing tombstone. */
  readSessionDataDeletionIdentity(sessionId: string): Readonly<{
    workspaceId: string;
    projectId: string;
    workspaceDigest: string;
    canonicalPath: string;
    deleted: boolean;
  }> | null;
  readSnapshot<Result>(operation: () => Result): Result;
  /** Receipt-bearing, effect-free State decision when no execution writer is present. */
  commitRecoveryDecision(
    transaction: RuntimeTransactionInput<Event, State>,
    expectedRevision: number,
    expectedAuthorityRevision: number,
  ): void;
  commitUnownedDecision(
    transaction: RuntimeTransactionInput<Event, State>,
    expectedRevision: number,
  ): void;
  close(): void;
}

export interface KiteSessionAgentMailboxPort extends KiteSessionAgentMetadataPort {
  readActiveTaskProof(
    sessionId: string,
    sourceAgentId: string,
    targetAgentId: string,
    taskId: string,
  ): Readonly<{ ownerGeneration: string; grantDigest: string }> | null;
}

/** Every read and confirmation is scoped to the active source or target Session owner. */
export interface KiteCrossSessionQueueMailPort {
  acceptAcceptedReleaseNotice(
    childSessionId: string,
    parentSessionId: string,
    submissionId: string,
    acceptedAtMs: number,
  ): CrossSessionMailOutboxRecord;
  acceptFollowupTerminalReply(
    childSessionId: string,
    parentSessionId: string,
    submissionId: string,
    acceptedAtMs: number,
  ): CrossSessionMailOutboxRecord;
  listPendingTerminalReplies(
    sourceSessionId: string,
    limit: number,
    afterMessageId?: string,
  ): readonly CrossSessionMailOutboxRecord[];
  readInterruptTarget(
    sourceSessionId: string,
    targetSessionId: string,
  ): ReturnType<typeof readCrossSessionInterruptTarget>;
  readInterruptIntent(
    sourceSessionId: string,
    commandId: string,
  ): ReturnType<typeof readCrossSessionInterruptIntent>;
  listPendingInterrupts(
    targetSessionId: string,
    limit: number,
  ): ReturnType<typeof listPendingCrossSessionInterrupts>;
  readFollowupDeliveryForTarget(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readCrossSessionFollowupDeliveryForTarget>;
  readFollowupAdmissionForTarget(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readCrossSessionFollowupAdmissionBySubmissionForTarget>;
  readAcceptedIndependentFollowupSourcePolicyProof(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readAcceptedIndependentFollowupSourcePolicyProof>;
  readIndependentFollowupActivationForTarget(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readIndependentCrossSessionFollowupActivation>;
  readTargetSnapshotEvidence(
    targetSessionId: string,
    expectedRevision: number,
  ): ReturnType<typeof readTargetSnapshotEvidence>;
  readUnroutedFollowupMessage(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
    messageId: string,
  ): ReturnType<typeof readUnroutedCrossSessionFollowupMessage>;
  readFollowupTerminalForSource(
    sourceSessionId: string,
    submissionId: string,
  ): CrossSessionFollowupTerminalReceipt | null;
  readFollowupGrantForTarget(
    targetSessionId: string,
    artifactId: string,
  ): ReturnType<typeof readCrossSessionFollowupGrant>;
  listPendingFollowupFunding(
    sourceSessionId: string,
    limit: number,
    afterSubmissionId?: string,
  ): readonly PendingCrossSessionFollowupFunding[];
  readLastReleasedFollowupForDirectChild(
    sourceSessionId: string,
    currentRunId: string,
    childSessionId: string,
  ): ReturnType<typeof readLastReleasedFollowupForDirectChild>;
  readDirectChildFollowupReleaseWatermark(
    sourceSessionId: string,
    currentRunId: string,
  ): ReturnType<typeof readDirectChildFollowupReleaseWatermark>;
  readLastFollowupOutcomeForDirectChild(
    sourceSessionId: string,
    currentRunId: string,
    childSessionId: string,
  ): ReturnType<typeof readLastFollowupOutcomeForDirectChild>;
  readDirectChildFollowupOutcomeWatermark(
    sourceSessionId: string,
    currentRunId: string,
  ): ReturnType<typeof readDirectChildFollowupOutcomeWatermark>;
  readFollowupTarget(
    sourceSessionId: string,
    targetSessionId: string,
  ): Readonly<{
    targetSessionId: string;
    status: 'active' | 'idle' | 'waiting' | 'context_unavailable';
    targetRunId: string | null;
    checkpointReady: boolean;
    originRole?: 'explore' | 'plan' | 'code' | 'review';
    originalGrantDigest?: string;
    observedTargetRevision?: number;
  }> | null;
  readChildTerminalCheckpoint(
    targetSessionId: string,
  ): ReturnType<typeof readChildTerminalCheckpoint>;
  readFollowupFundingForTarget(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): CrossSessionFollowupFundingReceipt | null;
  readFollowupActivationForTarget(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): CrossSessionFollowupActivationReceipt | null;
  readCurrentTurnBackupReleaseForTarget(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readCrossSessionCurrentTurnBackupReleaseForTarget>;
  readCurrentTurnPreparedNoAttemptProof(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readCrossSessionCurrentTurnPreparedNoAttemptProof>;
  readCurrentTurnDispatchedChildProofForSource(
    sourceSessionId: string,
    targetSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readCurrentTurnDispatchedChildProofForSource>;
  readCurrentTurnRoutedNoAttemptChildProofForSource(
    sourceSessionId: string,
    targetSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readCurrentTurnRoutedNoAttemptChildProofForSource>;
  readFollowupRoute(
    targetSessionId: string,
    submissionId: string,
  ): CrossSessionFollowupRouteReceipt | null;
  /** Source owner may inspect a funded target's immutable prepared/no-attempt proof without acquiring target authority. */
  readActivatedNoAttemptTargetProofForSource(
    sourceSessionId: string,
    targetSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readPreparedCrossSessionFollowupRecoveryProof>;
  readPreparedFollowupRecoveryProof(
    targetSessionId: string,
    sourceSessionId: string,
    submissionId: string,
  ): ReturnType<typeof readPreparedCrossSessionFollowupRecoveryProof>;
  readUnreadDirectChildMail(
    parentSessionId: string,
    currentRunId: string,
    childSessionId: string,
  ): Readonly<{ count: number; throughSequence: number }>;
  readDirectChildInboxWatermark(
    parentSessionId: string,
    currentRunId: string,
  ): Readonly<{ unreadCount: number; throughSequence: number }>;
  nextSourceSequence(sourceSessionId: string): number;
  nextTargetSequence(targetSessionId: string): number;
  readOutbox(sourceSessionId: string, messageId: string): CrossSessionMailOutboxRecord | null;
  listPendingOutbox(
    sourceSessionId: string,
    limit: number,
    afterMessageId?: string,
  ): readonly CrossSessionMailOutboxRecord[];
  readInboxReceipt(targetSessionId: string, messageId: string): CrossSessionInboxReceipt | null;
  listQueuedInbox(
    targetSessionId: string,
    currentRunId: string,
    limit: number,
  ): readonly CrossSessionQueuedMail[];
  readPreparedThrough(targetSessionId: string, currentRunId: string): number;
  confirmDelivered(sourceSessionId: string, messageId: string): CrossSessionMailOutboxRecord;
}

export interface KiteSessionModelMail {
  readonly messageId: string;
  readonly sequence: number;
  readonly senderAgentId: string;
  readonly sourceTaskId: string | null;
  readonly mode: 'queue_only' | 'trigger_turn' | 'reply';
  readonly bodyRef: {
    readonly artifactId: string;
    readonly kind: 'agent_mail';
    readonly integrityIdentifier: string;
    readonly byteLength: number;
  };
  readonly bodyText: string;
}

export interface KiteSessionAgentMailInputPort {
  /** Prospective Surface read; caller must hold the exact active Session execution scope. */
  readPendingMailForActiveTask(input: {
    readonly sessionId: string;
    readonly targetAgentId: string;
    readonly currentTaskId: string;
    readonly modelInvocationId: string;
    readonly fromSequence: number;
  }): readonly KiteSessionModelMail[];
  /** Restart read for a previously committed prepared input and admission. */
  readPreparedMailForModel(input: {
    readonly sessionId: string;
    readonly targetAgentId: string;
    readonly currentTaskId: string;
    readonly modelInvocationId: string;
    readonly modelAdmissionId: string;
  }): readonly KiteSessionModelMail[];
}

interface ExecutionHandleState {
  current: KiteSessionMutationInput;
  leaseUntilMs: number;
  deleted: boolean;
  recoveryOnly: boolean;
}

/**
 * Opens one WAL connection without a Workspace process lock. Every exposed Session/Run/checkpoint
 * or Artifact execution write requires a bound scope and enters the durable sessionMutation fence.
 * Receipt-bearing unowned decisions have a separate atomic no-execution-owner/revision check.
 */
export function openKiteSessionRuntimeStorage<Event, State>(input: {
  readonly databasePath: string;
  readonly windowsPathSecurity?: KiteSessionWindowsPathSecurity;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly artifacts?: ArtifactPort;
  readonly now?: () => number;
}): KiteSessionRuntimeStorageOwner<Event, State> {
  const maintenance = acquireKiteSessionStoreMaintenance(input.databasePath, 'shared', {
    ...(input.windowsPathSecurity ? { windowsPathSecurity: input.windowsPathSecurity } : {}),
  });
  try {
    // Publication holds the exclusive counterpart. Recheck both admission facts
    // only after this shared lock is held, before an absent Store can be created.
    if (inspectKiteSessionPublication(input.databasePath).status === 'pending') {
      throw new KiteSessionStoreOpenError(
        'store_busy',
        'Store publication is pending; retry startup so its maintenance can resume.',
      );
    }
    assertKiteSessionStoreSourcesReconciled(input.databasePath);
    const owner = openAdmittedKiteSessionRuntimeStorage(input);
    const close = () => {
      try {
        owner.close();
      } finally {
        maintenance?.release();
      }
    };
    return Object.freeze({ ...owner, close, [Symbol.asyncDispose]: async () => close() });
  } catch (error) {
    maintenance?.release();
    throw error;
  }
}

function openAdmittedKiteSessionRuntimeStorage<Event, State>(input: {
  readonly databasePath: string;
  readonly codec: SqliteRuntimeSnapshotCodec<Event, State>;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly artifacts?: ArtifactPort;
  readonly now?: () => number;
}): KiteSessionRuntimeStorageOwner<Event, State> {
  const database = openKiteSessionStoreDatabase(input.databasePath);
  const rawWriter = createKiteHomeWriteTransactionPort(database, assertKiteSessionStoreSchema);
  const workspaceDeletion = createKiteWorkspaceDeletionFence(database, rawWriter);
  const selectWorkspaceByDigest = database.query<{ workspace_id: string }, [string]>(
    'SELECT workspace_id FROM workspaces WHERE workspace_digest=? LIMIT 2',
  );
  const authority = createKiteSessionExecutionAuthority({
    database,
    writer: rawWriter,
    ...(input.now ? { nowMs: input.now } : {}),
  });
  const mutations = createKiteSessionMutationPort({ database, writer: rawWriter, authority });
  const effectPort = createKiteSessionEffectPort({
    database,
    mutations,
    authority,
    writer: rawWriter,
    ...(input.now ? { nowMs: input.now } : {}),
  });
  const scope = new AsyncLocalStorage<KiteSessionExecutionHandle>();
  const deletionScope = new AsyncLocalStorage<true>();
  const rejectDeletionScopeMutation = (): void => {
    if (deletionScope.getStore())
      throw new KiteSessionRuntimeStorageError(
        'execution_scope_required',
        'Deletion scope cannot perform a general Session mutation.',
      );
  };
  // Synchronous and private: callers cannot use this scope for arbitrary Store writes.
  let committingUnownedDecision = false;
  const handles = new WeakMap<object, ExecutionHandleState>();
  // A recovery lease can be used to persist old execution facts, never to dispatch new work.
  // This marker is connection-local and is tied to the exact fenced generation.
  const recoveryGenerations = new Map<string, number>();
  const effectLeaseRevisions = new Map<string, number>();
  const selectRevision = database.query<{ revision: number }, [string]>(
    'SELECT revision FROM runtime_sessions WHERE session_id = ? LIMIT 1',
  );

  const executionControl: KiteSessionExecutionControl = Object.freeze({
    read: authority.read,
    acquire: (request) => {
      rejectDeletionScopeMutation();
      return authority.acquire(request);
    },
    renew: (request) => {
      rejectDeletionScopeMutation();
      return authority.renew(request);
    },
    detach: (request) => {
      rejectDeletionScopeMutation();
      return authority.detach(request);
    },
    release: (request) => {
      rejectDeletionScopeMutation();
      return rawWriter.run(() => {
        if (!request.cleanupConfirmed) {
          effectPort.markGenerationUnknownInTransaction({
            sessionId: request.sessionId,
            controllerGeneration: request.controllerGeneration,
          });
        } else if (effectPort.listPrepared(request.sessionId).length > 0) {
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Clean Session release requires every prepared effect to be settled.',
          );
        }
        return authority.releaseInTransaction(request);
      });
    },
  });

  const recovery: KiteSessionRecoveryPort = Object.freeze({
    confirmCleanup: (request: Parameters<KiteSessionRecoveryPort['confirmCleanup']>[0]) => {
      rejectDeletionScopeMutation();
      authority.confirmRecoveryCleanup({
        sessionId: request.sessionId,
        expectedRevision: request.expectedAuthorityRevision,
        retainRecoveryRequired: true,
      });
    },
    inspect: (sessionId: string) =>
      Object.freeze({
        authority: authority.read(sessionId),
        pendingEffects: effectPort.listPrepared(sessionId),
        unknownEffects: effectPort.listUnknown(sessionId),
      }),
    reconcile: (request: Parameters<KiteSessionRecoveryPort['reconcile']>[0]) => {
      rejectDeletionScopeMutation();
      return rawWriter.run(() => {
        const current = authority.read(request.sessionId);
        if (
          current.status !== 'recovery_required' ||
          current.revision !== request.expectedAuthorityRevision ||
          current.controllerGeneration < 2
        ) {
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Session recovery authority has changed or is not awaiting reconciliation.',
          );
        }
        const unknownEffects = effectPort.markGenerationUnknownInTransaction({
          sessionId: request.sessionId,
          controllerGeneration: current.controllerGeneration - 1,
        });
        const reconciled = authority.confirmRecoveryCleanupInTransaction({
          sessionId: request.sessionId,
          expectedRevision: current.revision,
        });
        return Object.freeze({ authority: reconciled, unknownEffects });
      });
    },
  });

  const currentHandle = (): ExecutionHandleState => {
    const handle = scope.getStore();
    if (!handle) {
      throw new KiteSessionRuntimeStorageError(
        'execution_scope_required',
        'Session mutation requires an active execution scope.',
      );
    }
    const state = handles.get(handle);
    if (!state || state.deleted) {
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Session execution handle no longer has durable facts.',
      );
    }
    return state;
  };

  const sessionWriter: KiteHomeWriteTransactionPort = Object.freeze({
    get inTransaction() {
      return rawWriter.inTransaction;
    },
    run<Result>(write: () => Result): Result {
      const deletion = deletionScope.getStore();
      if (deletion)
        throw new KiteSessionRuntimeStorageError(
          'execution_scope_required',
          'Deletion scope cannot perform a general Session mutation.',
        );
      if (committingUnownedDecision) return write();
      const handle = currentHandle();
      const result = mutations.run(handle.current, write);
      const row = selectRevision.get(handle.current.sessionId);
      if (!row) {
        handle.deleted = true;
      } else {
        handle.current = Object.freeze({
          ...handle.current,
          expectedSessionRevision: row.revision,
        });
      }
      return result;
    },
  });

  const activeEffect = (sessionId: string, effectId: string, ownerId: string) => {
    const handle = currentHandle();
    if (handle.current.sessionId !== sessionId) {
      throw new KiteSessionRuntimeStorageError(
        'foreign_execution_handle',
        'Effect Session does not match the active execution scope.',
      );
    }
    const key = effectKey(sessionId, effectId, ownerId);
    const revision = effectLeaseRevisions.get(key);
    return { handle, key, revision };
  };

  const runtimeEffects: RuntimeStorage<Event, State>['effects'] = Object.freeze({
    tryAcquireEffectLease(
      sessionId: string,
      effectId: string,
      ownerId: string,
      expiresAtMs: number,
    ) {
      const { handle, key } = activeEffect(sessionId, effectId, ownerId);
      if (handle.recoveryOnly) {
        throw new KiteSessionRuntimeStorageError(
          'unsupported_mutation',
          'Recovery execution cannot dispatch a new effect.',
        );
      }
      const prepared = effectPort.prepare({
        ...handle.current,
        effectId,
        ownerId,
        expiresAtMs,
      });
      if (prepared.status !== 'prepared') return false;
      effectLeaseRevisions.set(key, prepared.effect.leaseRevision);
      return true;
    },
    renewEffectLease(sessionId: string, effectId: string, ownerId: string, expiresAtMs: number) {
      const { handle, key, revision } = activeEffect(sessionId, effectId, ownerId);
      if (revision === undefined) return false;
      try {
        const renewed = effectPort.renew({
          ...handle.current,
          effectId,
          ownerId,
          expectedLeaseRevision: revision,
          expiresAtMs,
        });
        effectLeaseRevisions.set(key, renewed.leaseRevision);
        return true;
      } catch {
        return false;
      }
    },
    releaseEffectLease(sessionId: string, effectId: string, ownerId: string) {
      const { handle, key, revision } = activeEffect(sessionId, effectId, ownerId);
      if (revision === undefined) return;
      try {
        const current = effectPort.inspect(sessionId, effectId);
        if (current?.state === 'prepared') {
          effectPort.markOutcomeUnknown({
            ...handle.current,
            effectId,
            ownerId,
            expectedLeaseRevision: revision,
          });
        }
      } finally {
        effectLeaseRevisions.delete(key);
      }
    },
  });

  const hasEffectLease = (
    sessionId: string,
    effectId: string,
    ownerId: string,
    _observedAtMs: number,
  ): boolean => {
    try {
      const { handle, revision } = activeEffect(sessionId, effectId, ownerId);
      if (revision === undefined) return false;
      effectPort.assertDispatchable({
        ...handle.current,
        effectId,
        ownerId,
        expectedLeaseRevision: revision,
      });
      return true;
    } catch {
      return false;
    }
  };

  const afterPersistInTransaction = (
    channel:
      | 'session_create'
      | 'decision'
      | 'attempt_start'
      | 'receipt_evidence'
      | 'terminal_recovery',
    transaction: Parameters<RuntimeStorage<Event, State>['transactions']['commitDecision']>[0],
  ): void => {
    persistChildSessionIntentInTransaction(database, channel, transaction);
    assertChildRecoveryDiagnosticInTransaction(database, channel, transaction);
    settleChildCreationFailureInTransaction(database, channel, transaction);
    recordChildDispatchAckInTransaction(database, channel, transaction);
    recordChildParentSettlementInTransaction(database, channel, transaction);
    if (transaction.childBudgetActivation || transaction.runMutation?.type === 'insert')
      assertNoQueuedInterruptBeforeChildActivation(database, transaction.sessionId);
    assertChildRuntimeActivationInTransaction(database, channel, transaction);
    assertChildUnknownTerminalSealInTransaction(
      database,
      channel,
      transaction,
      recoveryGenerations.get(transaction.sessionId) ===
        authority.read(transaction.sessionId).controllerGeneration,
    );
    const committedRevision = selectRevision.get(transaction.sessionId)?.revision;
    if (committedRevision !== undefined)
      synchronizeChildApprovalProxyInTransaction(database, transaction, committedRevision);
    if (transaction.childApprovalProxyDecision) {
      const receipt = transaction.commandReceipt;
      const decision = transaction.childApprovalProxyDecision;
      if (
        channel !== 'decision' ||
        !receipt ||
        transaction.requiredEffectLease ||
        receipt.scopeSessionId !== transaction.sessionId ||
        receipt.targetSessionId !== transaction.sessionId ||
        receipt.committedRevision !== committedRevision
      )
        unsupported('Child approval decision requires its exact parent command receipt.');
      decideChildApprovalProxyInTransaction(database, {
        parentSessionId: transaction.sessionId,
        proxyInteractionId: decision.proxyInteractionId,
        childRequestRevision: decision.childRequestRevision,
        childGeneration: decision.childGeneration,
        approvalDigest: decision.approvalDigest,
        decision: decision.decision,
        parentCommandId: receipt.commandId,
        parentCommandDigest: receipt.requestDigest,
        parentDecisionRevision: receipt.committedRevision,
      });
    }
    if (channel === 'session_create') {
      ensureRootAgentOnInitialCreationInTransaction(database, transaction);
      return;
    }
    const startsAgentTurn = transaction.agentMailboxMutations?.some(
      (mutation) => mutation.kind === 'turn_started',
    );
    applyKiteSessionAgentMailboxMutations(
      database,
      transaction,
      startsAgentTurn ? currentExecutionGeneration(transaction.sessionId) : undefined,
    );
    startRootAgentRunInTransaction(database, transaction);
    settleRootAgentRunInTransaction(database, transaction);
    const sourceRevision = selectRevision.get(transaction.sessionId)?.revision;
    if (sourceRevision !== undefined)
      settleCancelledAcceptedFollowupsInTransaction(database, {
        sourceSessionId: transaction.sessionId,
        sourceRevision,
        sourceSnapshot: transaction.snapshot as Readonly<Record<string, unknown>>,
        events: transaction.events as readonly Readonly<Record<string, unknown>>[],
      });
    if (transaction.followupRunStart) {
      const handle = currentHandle();
      const prepared = transaction.events.filter(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          (event as { type?: unknown }).type === 'agent.followup_turn_prepared',
      );
      if (
        channel !== 'decision' ||
        transaction.commandReceipt ||
        transaction.requiredEffectLease ||
        handle.current.sessionId !== transaction.sessionId ||
        handle.recoveryOnly ||
        transaction.runMutation?.type !== 'insert' ||
        transaction.runMutation.run.runId !== transaction.followupRunStart.targetRunId ||
        prepared.length !== 1
      )
        unsupported('Followup Run start requires its exact target Session decision.');
      authority.assertActive(handle.current);
      assertCrossSessionFollowupRunStartInTransaction(database, {
        targetSessionId: transaction.sessionId,
        mutation: transaction.followupRunStart,
        preparedEvent: prepared[0] as Record<string, unknown>,
      });
    }
    if (transaction.childTerminalCheckpointMutation) {
      const handle = currentHandle();
      if (
        channel !== 'decision' ||
        transaction.commandReceipt ||
        transaction.requiredEffectLease ||
        handle.current.sessionId !== transaction.sessionId ||
        handle.recoveryOnly ||
        transaction.events.length !== 1
      )
        unsupported('Child terminal checkpoint requires its exact target Session seal decision.');
      authority.assertActive(handle.current);
      const event = transaction.events[0] as Record<string, unknown>;
      const revision = selectRevision.get(transaction.sessionId)?.revision;
      if (!Number.isSafeInteger(revision) || revision! < 1)
        unsupported('Child terminal checkpoint Session revision is invalid.');
      sealChildTerminalCheckpointInTransaction(database, {
        sessionId: transaction.sessionId,
        revision: revision!,
        mutation: transaction.childTerminalCheckpointMutation,
        terminalEvent: event,
      });
    }
    const crossMail = transaction.crossSessionAgentMailMutation;
    if (crossMail) {
      const handle = currentHandle();
      if (handle.current.sessionId !== transaction.sessionId || handle.recoveryOnly)
        unsupported('Cross-Session mail requires its active Session execution owner.');
      authority.assertActive(handle.current);
      const events = transaction.events.filter(
        (event): event is Event & Record<string, unknown> =>
          typeof event === 'object' && event !== null,
      ) as readonly Record<string, unknown>[];
      const exactEvent = (type: string): Record<string, unknown> => {
        const found = events.filter((event) => event.type === type);
        if (found.length !== 1)
          unsupported('Cross-Session mail requires one exact canonical Event.');
        return found[0]!;
      };
      const revision = selectRevision.get(transaction.sessionId)?.revision;
      if (!Number.isSafeInteger(revision) || revision! < 1)
        unsupported('Cross-Session mail Session revision is invalid.');
      if (crossMail.kind === 'request_interrupt' || crossMail.kind === 'request_queued_interrupt') {
        const receipt = transaction.commandReceipt;
        const lease = transaction.requiredEffectLease;
        if (
          channel !== 'receipt_evidence' ||
          !receipt ||
          !lease ||
          events.length !== 1 ||
          receipt.scopeSessionId !== transaction.sessionId ||
          receipt.targetSessionId !== transaction.sessionId ||
          receipt.commandId !== crossMail.commandId ||
          receipt.requestDigest !== crossMail.requestDigest ||
          receipt.committedRevision !== revision
        )
          unsupported('Cross-Session interrupt requires its exact Tool receipt and lease.');
        const { revision: leaseRevision } = activeEffect(
          transaction.sessionId,
          lease.effectId,
          lease.ownerId,
        );
        if (leaseRevision === undefined)
          unsupported('Cross-Session interrupt Tool lease is absent.');
        effectPort.assertDispatchable({
          ...handle.current,
          effectId: lease.effectId,
          ownerId: lease.ownerId,
          expectedLeaseRevision: leaseRevision,
        });
        const event = exactEvent('background_execution.stop_requested');
        if (
          event.commandId !== crossMail.commandId ||
          event.executionId !== crossMail.targetTaskId ||
          event.executionKind !== 'subagent' ||
          event.ownerGeneration !==
            (crossMail.kind === 'request_queued_interrupt'
              ? `accepted:${crossMail.queuedIntentEventId}`
              : `child:${crossMail.targetOwnerGeneration}`)
        )
          unsupported('Cross-Session interrupt Event differs from its private intent.');
        const { kind: _kind, ...privateIntent } = crossMail;
        acceptCrossSessionInterruptInTransaction(database, {
          ...privateIntent,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
        });
      } else if (crossMail.kind === 'settle_queued_interrupt') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 1
        )
          unsupported('Queued interrupt settlement requires its parent Session decision.');
        const event = events[0]!;
        if (
          event.type !== 'background_execution.stop_settled' &&
          event.type !== 'background_execution.stop_unknown'
        )
          unsupported('Queued interrupt has no terminal stop Event.');
        settleQueuedCrossSessionInterruptInTransaction(database, {
          sourceSessionId: transaction.sessionId,
          commandId: crossMail.commandId,
          targetSessionId: crossMail.targetSessionId,
          sourceRevision: revision!,
          event,
        });
      } else if (crossMail.kind === 'ack_interrupt' || crossMail.kind === 'settle_interrupt') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 1 ||
          crossMail.targetGeneration !== handle.current.controllerGeneration
        )
          unsupported('Cross-Session interrupt target decision lacks owner identity.');
        const event = events[0]!;
        const input = {
          sourceSessionId: crossMail.sourceSessionId,
          commandId: crossMail.commandId,
          targetSessionId: transaction.sessionId,
          targetGeneration: crossMail.targetGeneration,
          targetRevision: revision!,
          event,
        };
        if (crossMail.kind === 'ack_interrupt')
          acknowledgeCrossSessionInterruptInTransaction(database, input);
        else settleCrossSessionInterruptInTransaction(database, input);
      } else if (crossMail.kind === 'accept_queue' || crossMail.kind === 'accept_followup') {
        const receipt = transaction.commandReceipt;
        const lease = transaction.requiredEffectLease;
        if (
          channel !== 'receipt_evidence' ||
          !receipt ||
          !lease ||
          receipt.scopeSessionId !== transaction.sessionId ||
          receipt.targetSessionId !== transaction.sessionId ||
          receipt.commandId !== crossMail.commandId ||
          receipt.requestDigest !== crossMail.requestDigest ||
          receipt.committedRevision !== revision
        )
          unsupported('Cross-Session mail source receipt or Tool lease is invalid.');
        const { revision: leaseRevision } = activeEffect(
          transaction.sessionId,
          lease.effectId,
          lease.ownerId,
        );
        if (leaseRevision === undefined)
          unsupported('Cross-Session mail requires the current Tool effect lease.');
        effectPort.assertDispatchable({
          ...handle.current,
          effectId: lease.effectId,
          ownerId: lease.ownerId,
          expectedLeaseRevision: leaseRevision,
        });
        const bodyDigest = `sha256:${createHash('sha256').update(crossMail.bodyText).digest('hex')}`;
        const byteLength = Buffer.byteLength(crossMail.bodyText, 'utf8');
        const event = exactEvent('agent.mail_accepted');
        if (
          !matchesCrossMailEvent(event, {
            messageId: crossMail.messageId,
            senderSessionId: transaction.sessionId,
            targetSessionId: crossMail.targetSessionId,
            sequence: crossMail.sourceSequence,
            bodyDigest,
            byteLength,
            sourceRunId: crossMail.sourceRunId,
            sourceTurnId: crossMail.sourceTurnId,
            sourceModelInvocationId: crossMail.sourceModelInvocationId,
            sourceToolCallId: crossMail.sourceToolCallId,
            sourceEffectAttemptId: crossMail.sourceEffectAttemptId,
            sourceTaskId: crossMail.sourceTaskId ?? null,
            ...(crossMail.kind === 'accept_followup'
              ? {
                  mode: 'trigger_turn' as const,
                  submissionId: crossMail.submissionId,
                  followupAdmissionRef: crossMail.admission.ref,
                  followupAdmissionDigest: crossMail.admission.digest,
                }
              : { mode: 'queue_only' as const }),
          })
        )
          unsupported('Cross-Session source Event differs from the private mail intent.');
        const source = {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot,
          sourceOwnerGeneration: handle.current.controllerGeneration,
        };
        if (crossMail.kind === 'accept_followup') {
          if (
            events.length !== 2 ||
            exactEvent('resource_budget.reserved').type !== 'resource_budget.reserved'
          )
            unsupported('Cross-Session followup requires one exact backup reservation Event.');
          acceptCrossSessionFollowupInTransaction(database, {
            ...crossMail,
            sourceSessionId: transaction.sessionId,
            sourceRevision: revision!,
            sourceOwnerGeneration: handle.current.controllerGeneration,
            acceptedEvent: event,
            reservationEvent: exactEvent('resource_budget.reserved'),
            sourceSnapshot: transaction.snapshot as Record<string, unknown>,
          });
        } else {
          acceptCrossSessionQueueMailInTransaction(database, source);
        }
      } else if (crossMail.kind === 'receive_queue') {
        if (channel !== 'decision' || transaction.commandReceipt || transaction.requiredEffectLease)
          unsupported('Cross-Session target receipt must be its own Session decision.');
        const outbox = readCrossSessionMail(
          database,
          crossMail.sourceSessionId,
          crossMail.messageId,
        );
        if (
          !outbox ||
          outbox.targetSessionId !== transaction.sessionId ||
          (outbox.mode !== 'queue_only' && outbox.mode !== 'reply')
        )
          unsupported('Cross-Session target has no exact source outbox.');
        const event = exactEvent('agent.mail_accepted');
        const targetSequence = nextCrossSessionTargetSequence(database, transaction.sessionId);
        if (
          !matchesCrossMailEvent(event, {
            messageId: crossMail.messageId,
            senderSessionId: outbox.sourceSessionId,
            targetSessionId: transaction.sessionId,
            sequence: targetSequence,
            bodyDigest: outbox.bodyRef.integrityIdentifier,
            byteLength: outbox.bodyRef.byteLength,
            sourceRunId: outbox.sourceRunId,
            sourceTurnId: outbox.sourceTurnId,
            sourceModelInvocationId: outbox.sourceModelInvocationId,
            sourceToolCallId: outbox.sourceToolCallId,
            sourceEffectAttemptId: outbox.sourceEffectAttemptId,
            sourceTaskId: outbox.sourceTaskId,
            mode: outbox.mode,
          })
        )
          unsupported('Cross-Session target Event differs from the source outbox.');
        receiveCrossSessionQueueMailInTransaction(database, {
          ...crossMail,
          targetSessionId: transaction.sessionId,
          targetRevision: revision!,
        });
      } else if (crossMail.kind === 'receive_followup') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 1
        )
          unsupported('Cross-Session followup receipt must be its own target Session decision.');
        const delivery = readCrossSessionFollowupDeliveryForTarget(
          database,
          transaction.sessionId,
          crossMail.sourceSessionId,
          crossMail.submissionId,
        );
        if (
          !delivery ||
          delivery.status !== 'pending' ||
          delivery.messageId !== crossMail.messageId
        )
          unsupported('Cross-Session followup has no pending target delivery.');
        const event = exactEvent('agent.mail_accepted');
        if (
          !matchesCrossMailEvent(event, {
            messageId: delivery.messageId,
            senderSessionId: crossMail.sourceSessionId,
            targetSessionId: transaction.sessionId,
            sequence: delivery.sequence,
            bodyDigest: delivery.bodyDigest,
            byteLength: delivery.bodyRef.byteLength,
            sourceRunId: delivery.source.runId,
            sourceTurnId: delivery.source.turnId,
            sourceModelInvocationId: delivery.source.modelInvocationId,
            sourceToolCallId: delivery.source.toolCallId,
            sourceEffectAttemptId: delivery.source.effectAttemptId,
            sourceTaskId: delivery.source.sourceTaskId ?? null,
            mode: 'trigger_turn',
            submissionId: crossMail.submissionId,
            followupAdmissionRef: delivery.followupAdmissionRef,
            followupAdmissionDigest: delivery.followupAdmissionDigest,
          })
        )
          unsupported('Cross-Session followup target Event differs from the source admission.');
        receiveCrossSessionFollowupInTransaction(database, {
          ...crossMail,
          targetSessionId: transaction.sessionId,
          targetRevision: revision!,
        });
      } else if (crossMail.kind === 'replace_followup_backup') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 1
        )
          unsupported('Cross-Session backup replacement requires its own source Session decision.');
        replaceCrossSessionFollowupBackupInTransaction(database, {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot as Record<string, unknown>,
          replacementEvent: exactEvent('resource_budget.bounded_replaced'),
        });
      } else if (crossMail.kind === 'activate_followup_funding') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 2 ||
          events.some((event) => event.type !== 'resource_budget.dispatch_started')
        )
          unsupported(
            'Followup funding activation requires two exact source budget dispatch events.',
          );
        activateCrossSessionFollowupFundingInTransaction(database, {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot as Record<string, unknown>,
          events,
        });
      } else if (crossMail.kind === 'activate_independent_followup_turn') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 1 ||
          events[0]?.type !== 'resource_budget.dispatch_started'
        )
          unsupported('Independent followup activation requires one source backup dispatch.');
        activateIndependentCrossSessionFollowupTurnInTransaction(database, {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot as Record<string, unknown>,
          events,
        });
      } else if (crossMail.kind === 'settle_followup_funding') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 2 ||
          events.some(
            (event) =>
              ![
                'resource_budget.reconciled',
                'resource_budget.unknown',
                'resource_budget.released',
              ].includes(String(event.type)),
          )
        )
          unsupported('Followup funding settlement requires two exact source budget events.');
        settleCrossSessionFollowupFundingInTransaction(database, {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot as Record<string, unknown>,
          events,
        });
      } else if (crossMail.kind === 'settle_independent_followup_funding') {
        const budgetEvents = events.filter((event) =>
          [
            'resource_budget.reconciled',
            'resource_budget.unknown',
            'resource_budget.released',
          ].includes(String(event.type)),
        );
        const auditEvents = events.filter(
          (event) => event.type === 'agent.followup_independent_settled',
        );
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          auditEvents.length !== 1 ||
          budgetEvents.length > 1 ||
          events.length !== budgetEvents.length + 1 ||
          (budgetEvents.length === 0 && crossMail.disposition !== 'unknown')
        )
          unsupported('Independent followup settlement requires exact budget and audit Events.');
        settleIndependentCrossSessionFollowupFundingInTransaction(database, {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot as Record<string, unknown>,
          events,
        });
      } else if (crossMail.kind === 'settle_followup_funding_after_unknown_recovery') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 0
        )
          unsupported(
            'Recovered unknown followup ACK requires one source-only zero-Event decision.',
          );
        settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction(database, {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot as Record<string, unknown>,
        });
      } else if (crossMail.kind === 'release_accepted_followup_backup') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 1 ||
          events[0]?.type !== 'resource_budget.released'
        )
          unsupported(
            'Accepted followup backup release requires one source budget release decision.',
          );
        releaseAcceptedCrossSessionFollowupBackupInTransaction(database, {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot as Record<string, unknown>,
          releaseEvent: events[0]!,
        });
      } else if (crossMail.kind === 'release_current_turn_backup') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 1 ||
          events[0]?.type !== 'resource_budget.released'
        )
          unsupported('Current-turn backup release requires one source budget release decision.');
        releaseCrossSessionCurrentTurnBackupInTransaction(database, {
          ...crossMail,
          sourceSessionId: transaction.sessionId,
          sourceRevision: revision!,
          sourceSnapshot: transaction.snapshot as Record<string, unknown>,
          releaseEvent: events[0]!,
        });
      } else if (crossMail.kind === 'route_followup') {
        if (
          channel !== 'decision' ||
          transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          events.length !== 2
        )
          unsupported('Cross-Session followup route must be its own target Session decision.');
        routeCrossSessionFollowupInTransaction(database, {
          ...crossMail,
          targetSessionId: transaction.sessionId,
          routedRevision: revision!,
          routedEvent: exactEvent('agent.followup_routed'),
          preparedEvent: exactEvent('agent.mail_input_prepared'),
          targetSnapshot: transaction.snapshot as Record<string, unknown>,
        });
      } else {
        if (channel !== 'decision' || transaction.commandReceipt || transaction.requiredEffectLease)
          unsupported('Cross-Session model input must be its own Session decision.');
        const event = exactEvent('agent.mail_input_prepared');
        if (
          event.targetAgentId !== transaction.sessionId ||
          event.invocationId !== crossMail.modelInvocationId ||
          event.modelAdmissionId !== crossMail.modelAdmissionId ||
          event.fromSequence !== crossMail.fromSequence ||
          event.throughSequence !== crossMail.throughSequence ||
          JSON.stringify(event.messageIds) !== JSON.stringify(crossMail.messageIds)
        )
          unsupported('Cross-Session model input Event differs from the selected inbox batch.');
        assertModelAdmissionForPreparedMail(events, transaction.snapshot, crossMail);
        const preparedModel = events.find(
          (candidate) => candidate.type === 'model.invocation_prepared',
        );
        const preparedBudget = preparedModel?.budget as { kind?: unknown } | undefined;
        const resourceBudget = (transaction.snapshot as { resourceBudget?: { runId?: unknown } })
          .resourceBudget;
        if (
          !crossMail.currentRunId ||
          (preparedBudget?.kind === 'reservation' &&
            resourceBudget?.runId !== crossMail.currentRunId)
        )
          unsupported('Cross-Session model admission does not belong to the current target Run.');
        const preparedThrough = readCrossSessionPreparedThrough(
          database,
          transaction.sessionId,
          crossMail.currentRunId,
        );
        if (crossMail.messageIds.length < 1 || crossMail.messageIds.length > 8)
          unsupported('Cross-Session model input batch must contain one to eight messages.');
        const queued = listQueuedCrossSessionInbox(
          database,
          transaction.sessionId,
          crossMail.currentRunId,
          crossMail.messageIds.length,
        );
        if (
          preparedThrough !== crossMail.fromSequence ||
          queued.length !== crossMail.messageIds.length ||
          JSON.stringify(queued.map((mail) => mail.messageId)) !==
            JSON.stringify(crossMail.messageIds) ||
          queued.at(-1)?.sequence !== crossMail.throughSequence
        )
          unsupported('Cross-Session model input watermark or ordered batch changed.');
        const applied = prepareCrossSessionQueueMailInputInTransaction(database, {
          targetSessionId: transaction.sessionId,
          targetRevision: revision!,
          currentRunId: crossMail.currentRunId,
          modelInvocationId: crossMail.modelInvocationId,
          modelAdmissionId: crossMail.modelAdmissionId,
        });
        if (applied.length !== queued.length)
          unsupported('Cross-Session model input preparation did not accept its exact batch.');
      }
    }
    const lease = transaction.requiredEffectLease;
    if (!lease || (channel !== 'receipt_evidence' && channel !== 'terminal_recovery')) return;
    const { handle, revision } = activeEffect(transaction.sessionId, lease.effectId, lease.ownerId);
    if (revision === undefined) {
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Effect receipt has no current lease revision.',
      );
    }
    effectPort.commitTerminalInTransaction({
      ...handle.current,
      effectId: lease.effectId,
      ownerId: lease.ownerId,
      expectedLeaseRevision: revision,
      terminalDigest: effectTerminalDigest(transaction, input.codec),
    });
  };

  const initialController: InitialControllerTransactionPort = Object.freeze({
    create(request: SqliteWorkspaceInitialControllerInput, mode: 'create' | 'replay') {
      const leaseUntilMs = request.executionLeaseUntilMs;
      if (!Number.isSafeInteger(leaseUntilMs) || (leaseUntilMs ?? 0) <= (input.now ?? Date.now)()) {
        throw new KiteSessionRuntimeStorageError(
          'stale_execution_handle',
          'Initial Session execution lease is missing or expired.',
        );
      }
      if (mode === 'create') {
        const record = authority.acquireInitialInTransaction({
          sessionId: request.sessionId,
          hostInstanceId: request.workerInstanceId,
          clientId: request.clientId,
          connectionGeneration: request.connectionGeneration,
          leaseUntilMs: leaseUntilMs!,
        });
        return initialControllerResult(request, record, 'applied');
      }
      const record = authority.read(request.sessionId);
      if (
        record.status !== 'active' ||
        record.hostInstanceId !== request.workerInstanceId ||
        record.clientId !== request.clientId ||
        record.connectionGeneration !== request.connectionGeneration
      ) {
        return initialControllerRejected(request, record);
      }
      return initialControllerResult(request, record, 'replay');
    },
  });

  let base: KiteHomeRuntimeStorageOwner<Event, State>;
  try {
    base = createKiteHomeRuntimeStorageForConnection({
      database,
      assertStoreSchema: assertKiteSessionStoreSchema,
      storeSchemaVersion: KITE_SESSION_STORE_SCHEMA_VERSION,
      writer: rawWriter,
      sessionWriter,
      removeSessionAuthorityInTransaction: () => {
        const handle = currentHandle();
        authority.removeInTransaction(handle.current);
      },
      removeSettledChildAuthorityInTransaction: (sessionId) => {
        const child = authority.read(sessionId);
        if (
          child.status === 'active' ||
          child.status === 'recovery_required' ||
          !child.cleanupConfirmed ||
          effectPort.listPrepared(sessionId).length !== 0 ||
          effectPort.listUnknown(sessionId).length !== 0 ||
          storage.runs.getActive(sessionId) !== null ||
          storage.runs.list({ sessionId, status: 'unknown', limit: 1 }).entries.length !== 0
        ) {
          throw new KiteSessionRuntimeStorageError(
            'session_busy',
            'Internal child Session cleanup is not confirmed.',
          );
        }
        database.query('DELETE FROM kite_meta WHERE key = ?').run(`session_execution/${sessionId}`);
      },
      createForkTargetAuthorityInTransaction: (targetSessionId) => {
        const handle = currentHandle();
        authority.acquireInitialInTransaction({
          sessionId: targetSessionId,
          hostInstanceId: handle.current.hostInstanceId,
          clientId: handle.current.clientId,
          connectionGeneration: handle.current.connectionGeneration,
          leaseUntilMs: handle.leaseUntilMs,
        });
      },
      hasEffectLease,
      afterPersistInTransaction,
      authorizeInternalFollowupRunStart: (transaction) => {
        const handle = currentHandle();
        if (
          handle.recoveryOnly ||
          handle.current.sessionId !== transaction.sessionId ||
          !transaction.followupRunStart ||
          transaction.runMutation?.type !== 'insert' ||
          transaction.runMutation.run.runId !== transaction.followupRunStart.targetRunId
        ) {
          unsupported('Internal followup Run is outside its fenced target owner.');
        }
        authority.assertActive(handle.current);
      },
      verifyInternalFollowupRunStart: (run) =>
        verifyPersistedCrossSessionFollowupRunStart(database, run),
      initialController,
      runCreateTransaction: (write) => rawWriter.run(write),
      codec: input.codec,
      stateSchemaVersion: input.stateSchemaVersion,
      formatEpoch: input.formatEpoch,
      ownsDatabase: true,
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    database.close(false);
    throw error;
  }

  const runs = Object.freeze({
    ...base.storage.runs,
    forkSession: () => unsupported('Cross-Session Run fork requires atomic target authority.'),
  });
  const transactions: RuntimeStorage<Event, State>['transactions'] = Object.freeze({
    ...base.storage.transactions,
    commitAttemptStart(
      transaction: Parameters<
        RuntimeStorage<Event, State>['transactions']['commitAttemptStart']
      >[0],
    ) {
      if (currentHandle().recoveryOnly) {
        throw new KiteSessionRuntimeStorageError(
          'unsupported_mutation',
          'Recovery execution cannot start a new attempt.',
        );
      }
      base.storage.transactions.commitAttemptStart(transaction);
    },
  });
  const storage = Object.freeze({
    ...base.storage,
    effects: runtimeEffects,
    runs,
    transactions,
  });
  const artifactStore = disableArtifactGarbageCollection(base.artifactStore);

  const assertHandle = (handle: KiteSessionExecutionHandle): ExecutionHandleState => {
    const state = typeof handle === 'object' && handle !== null ? handles.get(handle) : undefined;
    if (!state) {
      throw new KiteSessionRuntimeStorageError(
        'foreign_execution_handle',
        'Session execution handle belongs to another Store connection.',
      );
    }
    return state;
  };

  const bindExecution = (
    record: KiteSessionExecutionAuthorityRecord,
  ): KiteSessionExecutionHandle => {
    const binding = mutationInput(record, selectRevision);
    authority.assertActive(binding);
    const state: ExecutionHandleState = {
      current: binding,
      leaseUntilMs: requiredLeaseUntil(record),
      deleted: false,
      recoveryOnly: recoveryGenerations.get(record.sessionId) === record.controllerGeneration,
    };
    const handle: KiteSessionExecutionHandle = {
      sessionId: record.sessionId,
      snapshot() {
        if (state.deleted) {
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Session execution handle no longer has durable facts.',
          );
        }
        return state.current;
      },
    };
    const frozen = Object.freeze(handle);
    handles.set(frozen, state);
    return frozen;
  };

  const refreshExecution = (
    external: KiteSessionExecutionHandle,
    record: KiteSessionExecutionAuthorityRecord,
  ): void => {
    const handle = assertHandle(external);
    if (handle.current.sessionId !== record.sessionId || handle.deleted) {
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Session execution handle cannot be rebound.',
      );
    }
    const next = mutationInput(record, selectRevision);
    authority.assertActive(next);
    handle.current = next;
    handle.leaseUntilMs = requiredLeaseUntil(record);
    handle.recoveryOnly = recoveryGenerations.get(record.sessionId) === record.controllerGeneration;
  };

  const runWithExecution = <Result>(
    external: KiteSessionExecutionHandle,
    operation: () => Result,
  ): Result => {
    if (deletionScope.getStore())
      throw new KiteSessionRuntimeStorageError(
        'execution_scope_required',
        'Deletion scope cannot enter a general execution scope.',
      );
    assertHandle(external);
    const nested = scope.getStore();
    if (nested && nested !== external) {
      throw new KiteSessionRuntimeStorageError(
        'foreign_execution_handle',
        'Nested Session execution scopes must use the same handle.',
      );
    }
    return nested ? operation() : scope.run(external, operation);
  };

  const runDataDeletion = <Result>(operation: () => Result): Result => {
    if (scope.getStore() || deletionScope.getStore())
      throw new KiteSessionRuntimeStorageError(
        'execution_scope_required',
        'Data deletion cannot share or nest an execution scope.',
      );
    return deletionScope.run(true, () => rawWriter.run(operation));
  };

  const deleteMeta = database.query('DELETE FROM kite_meta WHERE key=?');
  const selectWorkspaceAuthorityKeys = database.query<{ key: string }, [number, string]>(
    'SELECT key FROM kite_meta WHERE substr(key,1,?)=? ORDER BY key',
  );
  const insertDeletionReceipt = database.query(
    `INSERT INTO runtime_command_receipts(
      scope_session_id,command_id,workspace_id,project_id,workspace_digest,
      request_digest,target_session_id,original_receipt_json,committed_revision,
      committed_at,result_schema,result_json,result_digest
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const deleteSelectedData = (
    workspaceId: string,
    sessionIds: readonly string[],
    wholeWorkspace: boolean,
  ): void => {
    const namespace = `workspace_authority/${workspaceId}/`;
    if (!sessionIds.length) {
      if (wholeWorkspace)
        database
          .query('DELETE FROM kite_meta WHERE substr(key,1,?)=?')
          .run(namespace.length, namespace);
      return;
    }
    const candidates = prepareKiteSessionTreeArtifactDeletion(database);
    removeKiteSessionTreeReferences(database);
    const ids = new Set(sessionIds);
    for (const sessionId of sessionIds) deleteMeta.run(`session_execution/${sessionId}`);
    if (wholeWorkspace) {
      database
        .query('DELETE FROM kite_meta WHERE substr(key,1,?)=?')
        .run(namespace.length, namespace);
    } else {
      const prefix = `${namespace}workspace_authority_v1:`;
      for (const { key } of selectWorkspaceAuthorityKeys.all(prefix.length, prefix)) {
        try {
          if (
            ids.has(
              inspectSqliteWorkspaceAuthorityMetadataKey(key.slice(namespace.length)).sessionId,
            )
          )
            deleteMeta.run(key);
        } catch {
          // A malformed historical key has no proven Session owner. It cannot
          // block deletion of the Session rows or grant a future execution.
        }
      }
    }
    database
      .query(
        `INSERT INTO runtime_session_tombstones(
          session_id,workspace_id,project_id,workspace_digest,deleted_revision,deleted_at
        ) SELECT session_id,workspace_id,project_id,workspace_digest,revision,?
            FROM runtime_sessions
           WHERE session_id IN (SELECT session_id FROM temp.kite_delete_tree_ids)`,
      )
      .run(Math.floor((input.now ?? Date.now)() / 1000));
    database.run(
      'DELETE FROM runtime_sessions WHERE session_id IN (SELECT session_id FROM temp.kite_delete_tree_ids)',
    );
    removeUnreferencedKiteSessionTreeArtifacts(database, candidates);
  };

  const deleteSessionDataTree: KiteSessionRuntimeStorageOwner<
    Event,
    State
  >['deleteSessionDataTree'] = (rootSessionId, makeReceipt) =>
    runDataDeletion(() => {
      if (!rootSessionId || typeof makeReceipt !== 'function')
        throw new KiteSessionRuntimeStorageError(
          'execution_scope_required',
          'Session data deletion requires one root and a receipt factory.',
        );
      const root = database
        .query<
          { workspace_id: string; project_id: string; workspace_digest: string; revision: number },
          [string]
        >(
          `SELECT workspace_id,project_id,workspace_digest,revision
             FROM runtime_sessions WHERE session_id=? LIMIT 1`,
        )
        .get(rootSessionId);
      if (!root) return null;
      const sessionIds = prepareKiteSessionTreeDeletion(database, rootSessionId, root.workspace_id);
      const receipt = makeReceipt(root.revision);
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        receipt.scopeSessionId !== rootSessionId ||
        receipt.targetSessionId !== rootSessionId
      )
        throw new KiteSessionRuntimeStorageError(
          'execution_scope_required',
          'Session deletion receipt does not identify its root.',
        );
      assertSqliteRuntimeCommandReceipt(receipt, rootSessionId, root.revision, true);
      deleteSelectedData(root.workspace_id, sessionIds, false);
      insertDeletionReceipt.run(
        receipt.scopeSessionId,
        receipt.commandId,
        root.workspace_id,
        root.project_id,
        root.workspace_digest,
        receipt.requestDigest,
        receipt.targetSessionId,
        receipt.originalReceiptJson,
        receipt.committedRevision,
        receipt.committedAt,
        receipt.resourceResult?.schema ?? null,
        receipt.resourceResult?.json ?? null,
        receipt.resourceResult?.digest ?? null,
      );
      return receipt;
    });

  const deleteWorkspaceSessionData: KiteSessionRuntimeStorageOwner<
    Event,
    State
  >['deleteWorkspaceSessionData'] = (workspaceId) =>
    runDataDeletion(() => {
      workspaceDeletionFenceKey(workspaceId);
      const selected = prepareKiteWorkspaceSessionDeletion(database, workspaceId);
      deleteSelectedData(workspaceId, selected.sessionIds, true);
      deleteMeta.run(workspaceDeletionFenceKey(workspaceId));
      return Object.freeze({
        rootSessionIds: Object.freeze([...selected.rootSessionIds]),
        sessionIds: Object.freeze([...selected.sessionIds]),
      });
    });

  const readSnapshot = <Result>(operation: () => Result): Result => {
    if (rawWriter.inTransaction || database.inTransaction) return operation();
    database.run('BEGIN');
    try {
      const result = operation();
      database.run('COMMIT');
      return result;
    } catch (error) {
      try {
        database.run('ROLLBACK');
      } catch {
        /* SQLite may already have rolled back after an I/O or corruption fault. */
      }
      throw error;
    }
  };

  const listWorkspaceSessionIds: KiteSessionRuntimeStorageOwner<
    Event,
    State
  >['listWorkspaceSessionIds'] = (workspaceId) => {
    workspaceDeletionFenceKey(workspaceId);
    return readSnapshot(() =>
      database
        .query<{ session_id: string }, [string]>(
          'SELECT session_id FROM runtime_sessions WHERE workspace_id=? ORDER BY session_id',
        )
        .all(workspaceId)
        .map((row) => row.session_id),
    );
  };

  const readSessionDataDeletionIdentity: KiteSessionRuntimeStorageOwner<
    Event,
    State
  >['readSessionDataDeletionIdentity'] = (sessionId) => {
    if (!sessionId) return null;
    return readSnapshot(() => {
      type IdentityRow = {
        workspace_id: string;
        project_id: string;
        workspace_digest: string;
        canonical_path: string;
      };
      const active = database
        .query<IdentityRow, [string]>(
          `SELECT s.workspace_id,s.project_id,s.workspace_digest,w.canonical_path
             FROM runtime_sessions AS s
             JOIN workspaces AS w ON w.workspace_id=s.workspace_id
            WHERE s.session_id=? LIMIT 1`,
        )
        .get(sessionId);
      if (active)
        return Object.freeze({
          workspaceId: active.workspace_id,
          projectId: active.project_id,
          workspaceDigest: active.workspace_digest,
          canonicalPath: active.canonical_path,
          deleted: false,
        });
      const deleted = database
        .query<IdentityRow, [string]>(
          `SELECT t.workspace_id,t.project_id,t.workspace_digest,w.canonical_path
             FROM runtime_session_tombstones AS t
             JOIN workspaces AS w ON w.workspace_id=t.workspace_id
            WHERE t.session_id=? LIMIT 1`,
        )
        .get(sessionId);
      if (!deleted) return null;
      return Object.freeze({
        workspaceId: deleted.workspace_id,
        projectId: deleted.project_id,
        workspaceDigest: deleted.workspace_digest,
        canonicalPath: deleted.canonical_path,
        deleted: true,
      });
    });
  };

  const currentExecutionGeneration = (sessionId: string): string => {
    const handle = currentHandle();
    if (handle.current.sessionId !== sessionId || handle.recoveryOnly)
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Agent owner generation is outside the active Session.',
      );
    authority.assertActive(handle.current);
    return String(handle.current.controllerGeneration);
  };

  const assertCrossMailOwner = (sessionId: string): void => {
    const handle = currentHandle();
    if (handle.current.sessionId !== sessionId)
      throw new KiteSessionRuntimeStorageError(
        'foreign_execution_handle',
        'Cross-Session mail is outside the bound Session owner.',
      );
    authority.assertActive(handle.current);
  };

  const crossSessionQueueMail: KiteCrossSessionQueueMailPort = Object.freeze({
    acceptAcceptedReleaseNotice: (
      childSessionId: string,
      parentSessionId: string,
      submissionId: string,
      acceptedAtMs: number,
    ) => {
      assertCrossMailOwner(childSessionId);
      return sessionWriter.run(() =>
        acceptCrossSessionAcceptedReleaseNoticeInTransaction(database, {
          childSessionId,
          parentSessionId,
          submissionId,
          acceptedAtMs,
        }),
      );
    },
    acceptFollowupTerminalReply: (
      childSessionId: string,
      parentSessionId: string,
      submissionId: string,
      acceptedAtMs: number,
    ) => {
      assertCrossMailOwner(childSessionId);
      return sessionWriter.run(() =>
        acceptCrossSessionFollowupTerminalReplyInTransaction(database, {
          childSessionId,
          parentSessionId,
          submissionId,
          acceptedAtMs,
        }),
      );
    },
    listPendingTerminalReplies: (sourceSessionId: string, limit: number, afterMessageId?: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return listPendingCrossSessionTerminalReplyMail(
          database,
          sourceSessionId,
          limit,
          afterMessageId,
        );
      }),
    readFollowupAdmissionForTarget: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readCrossSessionFollowupAdmissionBySubmissionForTarget(
          database,
          targetSessionId,
          sourceSessionId,
          submissionId,
        );
      }),
    readAcceptedIndependentFollowupSourcePolicyProof: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readAcceptedIndependentFollowupSourcePolicyProof(
          database,
          targetSessionId,
          sourceSessionId,
          submissionId,
        );
      }),
    readIndependentFollowupActivationForTarget: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        const receipt = readIndependentCrossSessionFollowupActivation(
          database,
          sourceSessionId,
          submissionId,
        );
        return receipt?.targetSessionId === targetSessionId ? receipt : null;
      }),
    readTargetSnapshotEvidence: (targetSessionId: string, expectedRevision: number) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readTargetSnapshotEvidence(database, targetSessionId, expectedRevision);
      }),
    readUnroutedFollowupMessage: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
      messageId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readUnroutedCrossSessionFollowupMessage(
          database,
          targetSessionId,
          sourceSessionId,
          submissionId,
          messageId,
        );
      }),
    readFollowupTerminalForSource: (sourceSessionId: string, submissionId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readCrossSessionFollowupTerminalReceipt(database, sourceSessionId, submissionId);
      }),
    readFollowupGrantForTarget: (targetSessionId: string, artifactId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        const stateRow = database
          .query<{ state_json: string }, [string]>(
            'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
          )
          .get(targetSessionId);
        if (!stateRow) return null;
        const state = JSON.parse(stateRow.state_json) as {
          activeFollowupTurn?: { grantRef?: { artifactId?: string } };
        };
        if (state.activeFollowupTurn?.grantRef?.artifactId !== artifactId) return null;
        return readCrossSessionFollowupGrant(database, artifactId);
      }),
    listPendingFollowupFunding: (
      sourceSessionId: string,
      limit: number,
      afterSubmissionId?: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return listPendingCrossSessionFollowupFunding(
          database,
          sourceSessionId,
          limit,
          afterSubmissionId,
        );
      }),
    readLastReleasedFollowupForDirectChild: (
      sourceSessionId: string,
      currentRunId: string,
      childSessionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readLastReleasedFollowupForDirectChild(
          database,
          sourceSessionId,
          currentRunId,
          childSessionId,
        );
      }),
    readDirectChildFollowupReleaseWatermark: (sourceSessionId: string, currentRunId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readDirectChildFollowupReleaseWatermark(database, sourceSessionId, currentRunId);
      }),
    readLastFollowupOutcomeForDirectChild: (
      sourceSessionId: string,
      currentRunId: string,
      childSessionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readLastFollowupOutcomeForDirectChild(
          database,
          sourceSessionId,
          currentRunId,
          childSessionId,
        );
      }),
    readDirectChildFollowupOutcomeWatermark: (sourceSessionId: string, currentRunId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readDirectChildFollowupOutcomeWatermark(database, sourceSessionId, currentRunId);
      }),
    readFollowupTarget: (sourceSessionId: string, targetSessionId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        const target = database
          .query<
            {
              target_session_id: string;
              node_status: string;
            },
            [string, string]
          >(`SELECT child.session_id AS target_session_id,n.status AS node_status
          FROM runtime_sessions source JOIN runtime_sessions child
            ON child.parent_session_id=source.session_id
          JOIN agent_nodes n ON n.session_id=child.session_id AND n.agent_id=child.session_id
          WHERE source.session_id=? AND child.session_id=?
            AND source.workspace_id=child.workspace_id AND source.project_id=child.project_id
            AND source.workspace_digest=child.workspace_digest`)
          .get(sourceSessionId, targetSessionId);
        if (!target) return null;
        const snapshot = database
          .query<{ state_json: string }, [string]>(
            'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
          )
          .get(targetSessionId);
        const targetState = snapshot
          ? (JSON.parse(snapshot.state_json) as {
              revision?: unknown;
              childSessionOrigin?: {
                parentSessionId?: unknown;
                role?: unknown;
                grantDigest?: unknown;
              };
            })
          : null;
        const origin = targetState?.childSessionOrigin;
        const role = origin?.role;
        const exactOrigin =
          origin?.parentSessionId === sourceSessionId &&
          (role === 'explore' || role === 'plan' || role === 'code' || role === 'review') &&
          typeof origin.grantDigest === 'string' &&
          /^sha256:[a-f0-9]{64}$/u.test(origin.grantDigest) &&
          Number.isSafeInteger(targetState?.revision);
        const run = database
          .query<{ run_id: string; status: string }, [string]>(
            `SELECT run_id,status FROM runtime_runs WHERE session_id=?
           ORDER BY created_revision DESC LIMIT 1`,
          )
          .get(targetSessionId);
        const active =
          run?.status === 'running' ||
          run?.status === 'waiting' ||
          (run?.status === 'queued' &&
            isAdmittedQueuedChildFollowupTarget(
              database,
              sourceSessionId,
              targetSessionId,
              run.run_id,
            ));
        const checkpointReady =
          target.node_status === 'idle' &&
          readChildTerminalCheckpoint(database, targetSessionId) !== null;
        return Object.freeze({
          targetSessionId,
          status:
            target.node_status === 'context_unavailable'
              ? ('context_unavailable' as const)
              : run?.status === 'waiting'
                ? ('waiting' as const)
                : active
                  ? ('active' as const)
                  : checkpointReady
                    ? ('idle' as const)
                    : ('context_unavailable' as const),
          targetRunId: active ? run.run_id : null,
          checkpointReady,
          ...(exactOrigin
            ? {
                originRole: role as 'explore' | 'plan' | 'code' | 'review',
                originalGrantDigest: origin!.grantDigest as string,
                observedTargetRevision: targetState!.revision as number,
              }
            : {}),
        });
      }),
    readChildTerminalCheckpoint: (targetSessionId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readChildTerminalCheckpoint(database, targetSessionId);
      }),
    readFollowupFundingForTarget: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        const row = readCrossSessionFollowupFundingReceipt(database, sourceSessionId, submissionId);
        if (row?.targetSessionId !== targetSessionId) return null;
        const target = database
          .query<{ parent_session_id: string | null }, [string]>(
            'SELECT parent_session_id FROM runtime_sessions WHERE session_id=?',
          )
          .get(targetSessionId);
        return target?.parent_session_id === sourceSessionId ? row : null;
      }),
    readFollowupActivationForTarget: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        const row = readCrossSessionFollowupActivationReceipt(
          database,
          sourceSessionId,
          submissionId,
        );
        if (row?.targetSessionId !== targetSessionId) return null;
        const target = database
          .query<{ parent_session_id: string | null }, [string]>(
            'SELECT parent_session_id FROM runtime_sessions WHERE session_id=?',
          )
          .get(targetSessionId);
        return target?.parent_session_id === sourceSessionId ? row : null;
      }),
    readCurrentTurnBackupReleaseForTarget: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readCrossSessionCurrentTurnBackupReleaseForTarget(
          database,
          targetSessionId,
          sourceSessionId,
          submissionId,
        );
      }),
    readCurrentTurnPreparedNoAttemptProof: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readCrossSessionCurrentTurnPreparedNoAttemptProof(
          database,
          targetSessionId,
          sourceSessionId,
          submissionId,
        );
      }),
    readCurrentTurnDispatchedChildProofForSource: (
      sourceSessionId: string,
      targetSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readCurrentTurnDispatchedChildProofForSource(
          database,
          sourceSessionId,
          targetSessionId,
          submissionId,
        );
      }),
    readCurrentTurnRoutedNoAttemptChildProofForSource: (
      sourceSessionId: string,
      targetSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readCurrentTurnRoutedNoAttemptChildProofForSource(
          database,
          sourceSessionId,
          targetSessionId,
          submissionId,
        );
      }),
    readFollowupRoute: (targetSessionId: string, submissionId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
      }),
    readInterruptTarget: (sourceSessionId: string, targetSessionId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readCrossSessionInterruptTarget(database, sourceSessionId, targetSessionId);
      }),
    readInterruptIntent: (sourceSessionId: string, commandId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        return readCrossSessionInterruptIntent(database, sourceSessionId, commandId);
      }),
    listPendingInterrupts: (targetSessionId: string, limit: number) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return listPendingCrossSessionInterrupts(database, targetSessionId, limit);
      }),
    readFollowupDeliveryForTarget: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readCrossSessionFollowupDeliveryForTarget(
          database,
          targetSessionId,
          sourceSessionId,
          submissionId,
        );
      }),
    readActivatedNoAttemptTargetProofForSource: (
      sourceSessionId: string,
      targetSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(sourceSessionId);
        if (
          !sourceSessionId ||
          !targetSessionId ||
          !submissionId ||
          sourceSessionId === targetSessionId
        )
          return null;
        const pair = database
          .query<
            {
              source_revision: number;
              target_revision: number;
            },
            [string, string]
          >(`SELECT source.revision AS source_revision,target.revision AS target_revision
        FROM runtime_sessions source JOIN runtime_sessions target
          ON target.parent_session_id=source.session_id
          AND target.workspace_id=source.workspace_id
          AND target.project_id=source.project_id
          AND target.workspace_digest=source.workspace_digest
        WHERE source.session_id=? AND target.session_id=?`)
          .get(sourceSessionId, targetSessionId);
        const funding = readCrossSessionFollowupFundingReceipt(
          database,
          sourceSessionId,
          submissionId,
        );
        const activation = readCrossSessionFollowupActivationReceipt(
          database,
          sourceSessionId,
          submissionId,
        );
        const outbox = database
          .query<
            {
              target_session_id: string;
              mode: string;
              message_id: string;
            },
            [string, string]
          >(`SELECT target_session_id,mode,message_id FROM agent_mail_outbox
        WHERE source_session_id=? AND submission_id=?`)
          .get(sourceSessionId, submissionId);
        if (
          !pair ||
          !outbox ||
          outbox.target_session_id !== targetSessionId ||
          outbox.mode !== 'trigger_turn'
        )
          return null;
        if (
          readAcceptedIndependentFollowupSourcePolicyProof(
            database,
            targetSessionId,
            sourceSessionId,
            submissionId,
          )
        ) {
          const independent = readIndependentCrossSessionFollowupActivation(
            database,
            sourceSessionId,
            submissionId,
          );
          if (
            !independent ||
            independent.targetSessionId !== targetSessionId ||
            independent.sourceRevision > pair.source_revision
          )
            return null;
          return readPreparedCrossSessionFollowupRecoveryProof(
            database,
            targetSessionId,
            sourceSessionId,
            submissionId,
          );
        }
        if (
          !funding ||
          !activation ||
          funding.targetSessionId !== targetSessionId ||
          activation.targetSessionId !== targetSessionId ||
          outbox.message_id !== funding.messageId ||
          funding.sourceRevision > pair.source_revision ||
          activation.sourceRevision > pair.source_revision ||
          funding.targetRevision > pair.target_revision
        )
          return null;
        return readPreparedCrossSessionFollowupRecoveryProof(
          database,
          targetSessionId,
          sourceSessionId,
          submissionId,
        );
      }),
    readPreparedFollowupRecoveryProof: (
      targetSessionId: string,
      sourceSessionId: string,
      submissionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(targetSessionId);
        return readPreparedCrossSessionFollowupRecoveryProof(
          database,
          targetSessionId,
          sourceSessionId,
          submissionId,
        );
      }),
    readUnreadDirectChildMail: (
      parentSessionId: string,
      currentRunId: string,
      childSessionId: string,
    ) =>
      readSnapshot(() => {
        assertCrossMailOwner(parentSessionId);
        return readUnreadDirectChildMail(database, parentSessionId, currentRunId, childSessionId);
      }),
    readDirectChildInboxWatermark: (parentSessionId: string, currentRunId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(parentSessionId);
        return readDirectChildInboxWatermark(database, parentSessionId, currentRunId);
      }),
    nextSourceSequence: (sessionId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sessionId);
        return nextCrossSessionSourceSequence(database, sessionId);
      }),
    nextTargetSequence: (sessionId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sessionId);
        return nextCrossSessionTargetSequence(database, sessionId);
      }),
    readOutbox: (sessionId: string, messageId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sessionId);
        return readCrossSessionMail(database, sessionId, messageId);
      }),
    listPendingOutbox: (sessionId: string, limit: number, afterMessageId?: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sessionId);
        return listPendingCrossSessionQueueMail(database, sessionId, limit, afterMessageId);
      }),
    readInboxReceipt: (sessionId: string, messageId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sessionId);
        return readCrossSessionInboxReceipt(database, sessionId, messageId);
      }),
    listQueuedInbox: (sessionId: string, currentRunId: string, limit: number) =>
      readSnapshot(() => {
        assertCrossMailOwner(sessionId);
        return listQueuedCrossSessionInbox(database, sessionId, currentRunId, limit);
      }),
    readPreparedThrough: (sessionId: string, currentRunId: string) =>
      readSnapshot(() => {
        assertCrossMailOwner(sessionId);
        return readCrossSessionPreparedThrough(database, sessionId, currentRunId);
      }),
    confirmDelivered: (sessionId: string, messageId: string) => {
      assertCrossMailOwner(sessionId);
      return sessionWriter.run(() =>
        confirmCrossSessionQueueMailInTransaction(database, {
          sourceSessionId: sessionId,
          messageId,
        }),
      );
    },
  });

  const metadataReader = createKiteSessionAgentMetadataPort(database);
  const agentMailbox: KiteSessionAgentMailboxPort = Object.freeze({
    readAgent: (sessionId: string, sourceAgentId: string, targetAgentId: string) =>
      readSnapshot(() => metadataReader.readAgent(sessionId, sourceAgentId, targetAgentId)),
    listAgents: (sessionId: string, sourceAgentId: string) =>
      readSnapshot(() => metadataReader.listAgents(sessionId, sourceAgentId)),
    nextSequence: (sessionId: string, sourceAgentId: string) =>
      readSnapshot(() => metadataReader.nextSequence(sessionId, sourceAgentId)),
    readActiveTaskProof: (
      sessionId: string,
      sourceAgentId: string,
      targetAgentId: string,
      taskId: string,
    ) =>
      readSnapshot(() => {
        const handle = currentHandle();
        if (handle.current.sessionId !== sessionId)
          throw new KiteSessionRuntimeStorageError(
            'foreign_execution_handle',
            'Agent task proof is outside the active Session.',
          );
        authority.assertActive(handle.current);
        if (!metadataReader.readAgent(sessionId, sourceAgentId, targetAgentId)) return null;
        const row = database
          .query<
            {
              current_task_id: string | null;
              status: string;
              current_owner_generation: string | null;
              current_grant_digest: string | null;
            },
            [string, string]
          >(`SELECT current_task_id,status,current_owner_generation,current_grant_digest
        FROM agent_nodes WHERE session_id=? AND agent_id=?`)
          .get(sessionId, targetAgentId);
        if (
          !taskId ||
          row?.status !== 'active' ||
          row.current_task_id !== taskId ||
          !row.current_owner_generation ||
          !row.current_grant_digest
        )
          return null;
        return Object.freeze({
          ownerGeneration: row.current_owner_generation,
          grantDigest: row.current_grant_digest,
        });
      }),
  });

  const agentMailInput: KiteSessionAgentMailInputPort = Object.freeze({
    readPendingMailForActiveTask: (
      request: Parameters<KiteSessionAgentMailInputPort['readPendingMailForActiveTask']>[0],
    ) =>
      readSnapshot(() => {
        assertModelMailTask(request.sessionId, request.targetAgentId, request.currentTaskId);
        if (
          !request.modelInvocationId ||
          !Number.isSafeInteger(request.fromSequence) ||
          request.fromSequence < 0
        )
          throw new KiteSessionRuntimeStorageError(
            'unsupported_mutation',
            'Agent model input identity is invalid.',
          );
        const boundary = database
          .query<{ prepared_through_sequence: number }, [string, string]>(
            'SELECT prepared_through_sequence FROM agent_nodes WHERE session_id=? AND agent_id=?',
          )
          .get(request.sessionId, request.targetAgentId);
        if (boundary?.prepared_through_sequence !== request.fromSequence)
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Agent mail input watermark changed.',
          );
        const prior =
          database
            .query<{ count: number }, [string, string, string]>(
              "SELECT count(*) AS count FROM agent_mail WHERE session_id=? AND target_agent_id=? AND status='prepared' AND prepared_invocation_id=?",
            )
            .get(request.sessionId, request.targetAgentId, request.modelInvocationId)?.count ?? 0;
        if (prior > 0)
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Agent model invocation already has a prepared input.',
          );
        return readModelMailRows(
          request.sessionId,
          request.targetAgentId,
          request.currentTaskId,
          "m.status='queued' AND m.sequence>?",
          request.fromSequence,
        );
      }),
    readPreparedMailForModel: (
      request: Parameters<KiteSessionAgentMailInputPort['readPreparedMailForModel']>[0],
    ) =>
      readSnapshot(() => {
        assertModelMailTask(request.sessionId, request.targetAgentId, request.currentTaskId);
        if (!request.modelInvocationId || !request.modelAdmissionId)
          throw new KiteSessionRuntimeStorageError(
            'unsupported_mutation',
            'Agent model admission identity is invalid.',
          );
        return readModelMailRows(
          request.sessionId,
          request.targetAgentId,
          request.currentTaskId,
          "m.status='prepared' AND m.prepared_invocation_id=? AND m.model_admission_id=?",
          request.modelInvocationId,
          request.modelAdmissionId,
        );
      }),
  });

  function assertModelMailTask(sessionId: string, targetAgentId: string, taskId: string): void {
    const handle = currentHandle();
    if (handle.current.sessionId !== sessionId || handle.recoveryOnly)
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Agent mail target is outside the active execution scope.',
      );
    authority.assertActive(handle.current);
    const row = database
      .query<{ current_task_id: string | null; status: string }, [string, string]>(
        'SELECT current_task_id,status FROM agent_nodes WHERE session_id=? AND agent_id=?',
      )
      .get(sessionId, targetAgentId);
    if (!taskId || row?.status !== 'active' || row.current_task_id !== taskId)
      throw new KiteSessionRuntimeStorageError(
        'stale_execution_handle',
        'Agent mail target task is not active.',
      );
  }

  function readModelMailRows(
    sessionId: string,
    targetAgentId: string,
    currentTaskId: string,
    where: string,
    ...params: (number | string)[]
  ): readonly KiteSessionModelMail[] {
    const recipientClause = targetAgentId === sessionId ? ' AND m.recipient_run_id=?' : '';
    const rows = database
      .query<
        {
          message_id: string;
          sequence: number;
          sender_agent_id: string;
          source_task_id: string | null;
          mode: KiteSessionModelMail['mode'];
          body_id: string;
          integrity_identifier: string;
          byte_length: number;
          body_text: string;
        },
        (string | number)[]
      >(`SELECT m.message_id,m.sequence,m.sender_agent_id,m.source_task_id,m.mode,
      b.body_id,b.integrity_identifier,b.byte_length,b.body_text FROM agent_mail m
      JOIN agent_mail_bodies b ON b.session_id=m.session_id AND b.body_id=m.body_id
      WHERE m.session_id=? AND m.target_agent_id=? AND ${where}${recipientClause} ORDER BY m.sequence LIMIT 9`)
      .all(
        sessionId,
        targetAgentId,
        ...params,
        ...(targetAgentId === sessionId ? [currentTaskId] : []),
      );
    if (rows.length > 8)
      throw new KiteSessionRuntimeStorageError(
        'unsupported_mutation',
        'Agent model mail batch exceeds eight messages.',
      );
    return Object.freeze(
      rows.map((row) => {
        if (
          Buffer.byteLength(row.body_text, 'utf8') !== row.byte_length ||
          `sha256:${createHash('sha256').update(row.body_text).digest('hex')}` !==
            row.integrity_identifier
        )
          throw new KiteSessionRuntimeStorageError(
            'unsupported_mutation',
            'Agent mail body failed integrity validation.',
          );
        return Object.freeze({
          messageId: row.message_id,
          sequence: row.sequence,
          senderAgentId: row.sender_agent_id,
          sourceTaskId: row.source_task_id,
          mode: row.mode,
          bodyRef: Object.freeze({
            artifactId: row.body_id,
            kind: 'agent_mail' as const,
            integrityIdentifier: row.integrity_identifier,
            byteLength: row.byte_length,
          }),
          bodyText: row.body_text,
        });
      }),
    );
  }

  const owner: KiteSessionRuntimeStorageOwner<Event, State> = {
    storage: Object.freeze({
      ...storage,
      agentMailbox,
      agentMailInput,
      crossSessionQueueMail,
      currentExecutionGeneration,
    }),
    admissions: base.admissions,
    getAdmittedWorkspace: (workspaceId) => base.admissions.get(workspaceId),
    getAdmittedWorkspaceByDigest: (workspaceDigest) => {
      if (!/^sha256:[a-f0-9]{64}$/u.test(workspaceDigest))
        throw new TypeError('Workspace digest is invalid.');
      const matches = selectWorkspaceByDigest.all(workspaceDigest);
      if (matches.length > 1) throw new Error('Workspace digest is ambiguous.');
      return matches[0] ? base.admissions.get(matches[0].workspace_id) : null;
    },
    workspaceDeletion,
    directory: base.directory,
    openHistoryLogs: base.openHistoryLogs,
    artifactStore,
    agentMailbox,
    agentMailInput,
    crossSessionQueueMail,
    currentExecutionGeneration,
    authority: executionControl,
    recovery,
    reconcileSettledSession(request) {
      rejectDeletionScopeMutation();
      return rawWriter.run(() => {
        const current = authority.read(request.sessionId);
        if (
          current.revision !== request.expectedAuthorityRevision ||
          current.status !== 'recovery_required' ||
          current.hostInstanceId !== null ||
          current.clientId !== null ||
          current.leaseUntilMs !== null ||
          effectPort.listPrepared(request.sessionId).length !== 0 ||
          effectPort.listUnknown(request.sessionId).length !== 0 ||
          storage.runs.getActive(request.sessionId) !== null ||
          storage.runs.list({ sessionId: request.sessionId, status: 'unknown', limit: 1 }).entries
            .length !== 0
        ) {
          return false;
        }
        const state = storage.sessions.loadSnapshot<State>(request.sessionId);
        if (state === null || !request.isSettledState(state)) return false;
        authority.confirmRecoveryCleanupInTransaction({
          sessionId: request.sessionId,
          expectedRevision: current.revision,
        });
        return true;
      });
    },
    beginRecoveryExecution(request) {
      rejectDeletionScopeMutation();
      const acquired = rawWriter.run(() => {
        const current = authority.read(request.sessionId);
        if (
          current.revision !== request.expectedAuthorityRevision ||
          current.status !== 'recovery_required' ||
          current.hostInstanceId !== null ||
          current.clientId !== null ||
          current.leaseUntilMs !== null
        ) {
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Session recovery authority changed before execution could be acquired.',
          );
        }
        const prepared = effectPort.listPrepared(request.sessionId);
        if (current.controllerGeneration < 2 && prepared.length > 0) {
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Prepared effects have no previous execution generation to reconcile.',
          );
        }
        if (current.controllerGeneration >= 2) {
          effectPort.markGenerationUnknownInTransaction({
            sessionId: request.sessionId,
            controllerGeneration: current.controllerGeneration - 1,
          });
        }
        return authority.acquireRecoveryInTransaction({
          sessionId: request.sessionId,
          expectedRevision: current.revision,
          hostInstanceId: request.hostInstanceId,
          clientId: request.clientId,
          connectionGeneration: request.connectionGeneration,
          leaseUntilMs: request.leaseUntilMs,
        });
      });
      recoveryGenerations.set(request.sessionId, acquired.controllerGeneration);
      return acquired;
    },
    sessionCreationForWorkspace: (workspaceId) => base.sessionCreationForWorkspace(workspaceId),
    createChildSession(creation) {
      const intent = creation.childSessionIntent;
      const parent = database
        .query<{ workspace_id: string }, [string]>(
          'SELECT workspace_id FROM runtime_sessions WHERE session_id = ? LIMIT 1',
        )
        .get(intent.parentSessionId);
      if (!parent) throw new Error('Child Session parent has no admitted Store Session.');
      return base.sessionCreationForWorkspace(parent.workspace_id).create(creation);
    },
    readSessionLineage: (sessionId) => base.readSessionLineage(sessionId),
    listChildSessions: (parentSessionId, limit, cursor) =>
      readSnapshot(() => listDirectChildSessions(database, parentSessionId, limit, cursor)),
    readChildSession: (parentSessionId, childSessionId) =>
      readSnapshot(() => {
        const child = readDirectChildSession(database, parentSessionId, childSessionId);
        if (!child) return null;
        const state = storage.sessions.loadSnapshot<State>(childSessionId);
        return state === null ? null : { ...child, state };
      }),
    openChildSessionHistoryLogs(parentSessionId, childSessionId, currentEventTypes) {
      const logs = createSqliteRuntimeLogQueryPortFromDatabase_({
        database,
        codec: input.codec,
        currentEventTypes,
        childScope: { parentSessionId, childSessionId },
      });
      return Object.freeze({
        getSession: (sessionId: string) => logs.getSession!(sessionId),
        listEvents: (request: Parameters<typeof logs.listEvents>[0]) => logs.listEvents(request),
        close: () => logs.close(),
      });
    },
    readChildSessionIntent: (childThreadId) =>
      readSnapshot(() => readChildSessionIntent(database, childThreadId)),
    readPendingAfterTurnChildTerminalSeal: (parentSessionId, childThreadId) =>
      readSnapshot(() =>
        readPendingAfterTurnChildTerminalSeal(database, parentSessionId, childThreadId),
      ),
    readChildSealedGrant: (childThreadId) =>
      readSnapshot(() => {
        const handle = currentHandle();
        authority.assertActive(handle.current);
        return readChildSealedGrant(database, handle.current.sessionId, childThreadId);
      }),
    listPendingChildSessionIntents: (parentSessionId, limit, cursor) =>
      readSnapshot(() => listPendingChildSessionIntents(database, parentSessionId, limit, cursor)),
    readChildApprovalProxy: (parentSessionId, proxyInteractionId) =>
      readSnapshot(() => readChildApprovalProxy(database, parentSessionId, proxyInteractionId)),
    listPendingChildApprovalProxies: (parentSessionId, limit, afterProxyInteractionId) =>
      readSnapshot(() =>
        listPendingChildApprovalProxies(database, parentSessionId, limit, afterProxyInteractionId),
      ),
    listPendingCrossSessionQueueMailSources: (limit, afterSessionId) =>
      readSnapshot(() => listPendingCrossSessionQueueMailSources(database, limit, afterSessionId)),
    listPendingCrossSessionTerminalReplyMailSources: (limit, afterSessionId) =>
      readSnapshot(() =>
        listPendingCrossSessionTerminalReplyMailSources(database, limit, afterSessionId),
      ),
    listUnrepliedSettledFollowupTerminalSources: (limit, after) =>
      readSnapshot(() => listUnrepliedSettledFollowupTerminalSources(database, limit, after)),
    listUnnotifiedAcceptedFollowupReleases: (limit, after) =>
      readSnapshot(() => listUnnotifiedAcceptedFollowupReleases(database, limit, after)),
    listPendingCrossSessionInterruptTargets: (limit, afterSessionId) =>
      readSnapshot(() => listPendingCrossSessionInterruptTargets(database, limit, afterSessionId)),
    listPendingCrossSessionFollowupSources: (limit, afterSessionId) =>
      readSnapshot(() => listPendingCrossSessionFollowupSources(database, limit, afterSessionId)),
    bindExecution,
    refreshExecution,
    runWithExecution,
    deleteSessionDataTree,
    deleteWorkspaceSessionData,
    listWorkspaceSessionIds,
    readSessionDataDeletionIdentity,
    readSnapshot,
    commitRecoveryDecision(transaction, expectedRevision, expectedAuthorityRevision) {
      rejectDeletionScopeMutation();
      rawWriter.run(() => {
        const stored = storage.sessions.loadSnapshot<State>(transaction.sessionId);
        if (
          !stored ||
          !transaction.commandReceipt ||
          transaction.requiredEffectLease ||
          transaction.runMutation ||
          transaction.sessionModelRoute ||
          transaction.commandReceipt.scopeSessionId !== transaction.sessionId ||
          transaction.commandReceipt.targetSessionId !== transaction.sessionId ||
          transaction.events.length !== 0 ||
          input.codec.encodeState(stored) !== input.codec.encodeState(transaction.snapshot)
        )
          unsupported('Recovery decisions cannot rewrite Session history or State.');
        const facts = recovery.inspect(transaction.sessionId);
        if (facts.authority.revision !== expectedAuthorityRevision)
          throw new KiteSessionMutationError('revision_conflict', 'Recovery authority changed.');
        if (
          facts.authority.status !== 'recovery_required' ||
          !facts.authority.cleanupConfirmed ||
          facts.pendingEffects.length > 0 ||
          facts.unknownEffects.length > 0
        )
          throw new KiteSessionRuntimeStorageError(
            'stale_execution_handle',
            'Recovery requires confirmed cleanup and settled effects.',
          );
        if (selectRevision.get(transaction.sessionId)?.revision !== expectedRevision)
          throw new KiteSessionMutationError(
            'revision_conflict',
            'Session changed before recovery.',
          );
        authority.confirmRecoveryCleanupInTransaction({
          sessionId: transaction.sessionId,
          expectedRevision: expectedAuthorityRevision,
        });
        committingUnownedDecision = true;
        try {
          base.storage.transactions.commitDecision(transaction);
        } finally {
          committingUnownedDecision = false;
        }
      });
    },
    commitUnownedDecision(transaction, expectedRevision) {
      rejectDeletionScopeMutation();
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        !transaction.commandReceipt ||
        transaction.requiredEffectLease ||
        transaction.runMutation ||
        transaction.sessionModelRoute ||
        transaction.commandReceipt.scopeSessionId !== transaction.sessionId ||
        transaction.commandReceipt.targetSessionId !== transaction.sessionId
      )
        unsupported(
          'Unowned decisions require a Session receipt and cannot mutate execution resources.',
        );
      rawWriter.run(() => {
        const current = authority.read(transaction.sessionId);
        // Detached/expired owners must be fenced by explicit recovery first; never take over here.
        if (current.status !== 'idle' && current.status !== 'recovery_required') {
          throw new KiteSessionRuntimeStorageError(
            'session_busy',
            'Session has an execution owner.',
          );
        }
        if (selectRevision.get(transaction.sessionId)?.revision !== expectedRevision) {
          throw new KiteSessionMutationError(
            'revision_conflict',
            'Session revision changed before decision.',
          );
        }
        committingUnownedDecision = true;
        try {
          base.storage.transactions.commitDecision(transaction);
        } finally {
          committingUnownedDecision = false;
        }
      });
    },
    close: () => base.close(),
    [Symbol.asyncDispose]: async () => base.close(),
  };
  return Object.freeze(owner);
}

function initialControllerResult(
  request: SqliteWorkspaceInitialControllerInput,
  record: KiteSessionExecutionAuthorityRecord,
  status: 'applied' | 'replay',
): SqliteWorkspaceControllerOperationResult {
  return {
    status,
    receipt: initialControllerReceipt(request, record, 'acquired'),
    lease: {
      sessionId: record.sessionId,
      clientId: request.clientId,
      connectionGeneration: record.connectionGeneration,
      controllerGeneration: record.controllerGeneration,
      workerInstanceId: request.workerInstanceId,
      status: 'active',
    },
  };
}

function initialControllerRejected(
  request: SqliteWorkspaceInitialControllerInput,
  record: KiteSessionExecutionAuthorityRecord,
): SqliteWorkspaceControllerOperationResult {
  return {
    status: 'rejected',
    receipt: initialControllerReceipt(request, record, 'stale_lease', 'rejected'),
  };
}

function initialControllerReceipt(
  request: SqliteWorkspaceInitialControllerInput,
  record: KiteSessionExecutionAuthorityRecord,
  code: 'acquired' | 'stale_lease',
  status: 'applied' | 'rejected' = 'applied',
) {
  return {
    schema: SQLITE_WORKSPACE_CONTROLLER_RECEIPT_SCHEMA,
    sessionId: request.sessionId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    operation: 'request_control' as const,
    status,
    code,
    controllerGeneration: record.controllerGeneration,
    connectionGeneration: record.connectionGeneration,
    interactionGeneration: record.interactionGeneration,
    clientId: record.clientId,
    workerInstanceId: record.hostInstanceId,
    completedAt: record.updatedAt,
  };
}

function mutationInput(
  record: KiteSessionExecutionAuthorityRecord,
  selectRevision: { get(sessionId: string): { revision: number } | null },
): KiteSessionMutationInput {
  if (
    record.status !== 'active' ||
    !record.hostInstanceId ||
    record.leaseUntilMs === null ||
    record.cleanupConfirmed
  ) {
    throw new KiteSessionRuntimeStorageError(
      'stale_execution_handle',
      'Session execution authority is not active.',
    );
  }
  const session = selectRevision.get(record.sessionId);
  if (!session) {
    throw new KiteSessionRuntimeStorageError(
      'stale_execution_handle',
      'Session execution authority has no durable Session.',
    );
  }
  return Object.freeze({
    sessionId: record.sessionId,
    controllerGeneration: record.controllerGeneration,
    hostInstanceId: record.hostInstanceId,
    clientId: record.clientId,
    connectionGeneration: record.connectionGeneration,
    expectedAuthorityRevision: record.revision,
    expectedSessionRevision: session.revision,
  });
}

function disableArtifactGarbageCollection(store: KiteHomeArtifactStore): KiteHomeArtifactStore {
  const disabled = () => unsupported('Artifact garbage collection is disabled for KASD.');
  return Object.freeze({
    ...store,
    collectModelGarbage: disabled,
    collectPlanGarbage: disabled,
    collectCapabilityGarbage: disabled,
    collectFilesystemPreimageGarbage: disabled,
    collectSandboxPreparationGarbage: disabled,
    collectSubagentTaskGarbage: disabled,
    collectSubagentLifecycleGarbage: disabled,
    collectSubagentContinuationGarbage: disabled,
    collectSubagentCheckpointGarbage: disabled,
    collectAgentFollowupAdmissionGarbage: disabled,
  });
}

function requiredLeaseUntil(record: KiteSessionExecutionAuthorityRecord): number {
  if (record.status !== 'active' || record.leaseUntilMs === null) {
    throw new KiteSessionRuntimeStorageError(
      'stale_execution_handle',
      'Session execution authority has no active lease.',
    );
  }
  return record.leaseUntilMs;
}

function effectKey(sessionId: string, effectId: string, ownerId: string): string {
  return `${sessionId}\0${effectId}\0${ownerId}`;
}

function effectTerminalDigest<Event, State>(
  transaction: RuntimeTransactionInput<Event, State>,
  codec: SqliteRuntimeSnapshotCodec<Event, State>,
): string {
  const digest = createHash('sha256').update('kite-session-effect-terminal-v1\0');
  digest.update(transaction.sessionId).update('\0');
  for (const event of transaction.events) {
    digest.update(codec.encodeEvent(event)).update('\0');
  }
  digest.update(codec.encodeState(transaction.snapshot));
  return digest.digest('hex');
}

function matchesCrossMailEvent(
  event: Readonly<Record<string, unknown>>,
  expected: {
    readonly messageId: string;
    readonly senderSessionId: string;
    readonly targetSessionId: string;
    readonly sequence: number;
    readonly bodyDigest: string;
    readonly byteLength: number;
    readonly sourceRunId: string;
    readonly sourceTurnId: string;
    readonly sourceModelInvocationId: string;
    readonly sourceToolCallId: string;
    readonly sourceEffectAttemptId: string;
    readonly sourceTaskId: string | null;
    readonly mode: 'queue_only' | 'trigger_turn' | 'reply';
    readonly submissionId?: string;
    readonly followupAdmissionRef?: Readonly<{
      artifactId: string;
      kind: string;
      integrityIdentifier: string;
      byteLength: number;
    }>;
    readonly followupAdmissionDigest?: string;
  },
): boolean {
  const source = event.source as Readonly<Record<string, unknown>> | undefined;
  const ref = event.bodyRef as Readonly<Record<string, unknown>> | undefined;
  const admissionRef = event.followupAdmissionRef as Readonly<Record<string, unknown>> | undefined;
  const expectedAdmissionRef = expected.followupAdmissionRef;
  return (
    event.messageId === expected.messageId &&
    event.senderAgentId === expected.senderSessionId &&
    event.targetAgentId === expected.targetSessionId &&
    event.mode === expected.mode &&
    event.submissionId === expected.submissionId &&
    event.followupAdmissionDigest === expected.followupAdmissionDigest &&
    (expectedAdmissionRef
      ? admissionRef?.artifactId === expectedAdmissionRef.artifactId &&
        admissionRef.kind === expectedAdmissionRef.kind &&
        admissionRef.integrityIdentifier === expectedAdmissionRef.integrityIdentifier &&
        admissionRef.byteLength === expectedAdmissionRef.byteLength
      : admissionRef === undefined) &&
    event.sequence === expected.sequence &&
    event.bodyDigest === expected.bodyDigest &&
    ref?.artifactId === `pa_${expected.bodyDigest.slice('sha256:'.length)}` &&
    ref.kind === 'agent_mail' &&
    ref.integrityIdentifier === expected.bodyDigest &&
    ref.byteLength === expected.byteLength &&
    source?.runId === expected.sourceRunId &&
    source.turnId === expected.sourceTurnId &&
    source.modelInvocationId === expected.sourceModelInvocationId &&
    source.toolCallId === expected.sourceToolCallId &&
    source.effectAttemptId === expected.sourceEffectAttemptId &&
    (source.sourceTaskId ?? null) === expected.sourceTaskId
  );
}

function unsupported(message: string): never {
  throw new KiteSessionRuntimeStorageError('unsupported_mutation', message);
}
