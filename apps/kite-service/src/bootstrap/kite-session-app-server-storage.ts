import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isRuntimeHostStateSettledForMigration } from '@kite-ai/runtime-host';
import type { RuntimeStorage, RuntimeTransactionInput } from '@kite-ai/runtime-host/storage';
import type {
  KiteSessionExecutionAuthorityRecord,
  KiteSessionExecutionHandle,
  KiteSessionRuntimeStorageOwner,
} from '@kite-ai/runtime-storage-sqlite';
import type { AdmittedWorkspace } from '../runtime-application';
import {
  eventsForSettledSubagentHistory,
  hasSettledSubagentHistoryCandidate,
} from './runtime/state-actions';
import type { RuntimeEvent, RuntimeState } from './runtime/state-runtime';
import { hasPendingSubagentProviderRecovery } from './runtime/subagent-provider-recovery';

const DEFAULT_EXECUTION_LEASE_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 10_000;

export type KiteAppServerSessionErrorCode =
  | 'session_busy'
  | 'recovery_required'
  | 'session_unavailable'
  | 'storage_closed';

export class KiteAppServerSessionError extends Error {
  readonly code: KiteAppServerSessionErrorCode;

  constructor(code: KiteAppServerSessionErrorCode, message: string) {
    super(message);
    this.name = 'KiteAppServerSessionError';
    this.code = code;
  }
}

export interface KiteSessionAppServerStorageOwner extends AsyncDisposable {
  /** Exact instance identity that must own internally created child controllers. */
  readonly hostInstanceId: string;
  readonly executionClientId: string;
  readonly executionConnectionGeneration: number;
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState> &
    Pick<
      KiteSessionRuntimeStorageOwner<RuntimeEvent, RuntimeState>['storage'],
      'agentMailbox' | 'crossSessionQueueMail' | 'currentExecutionGeneration'
    >;
  readonly artifactStore: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['artifactStore'];
  readonly directory: KiteSessionRuntimeStorageOwner<RuntimeEvent, RuntimeState>['directory'];
  readonly workspaceDeletion: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['workspaceDeletion'];
  readonly getAdmittedWorkspace: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['getAdmittedWorkspace'];
  readonly getAdmittedWorkspaceByDigest: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['getAdmittedWorkspaceByDigest'];
  readonly openHistoryLogs: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['openHistoryLogs'];
  readonly readSessionLineage: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['readSessionLineage'];
  readonly listChildSessions: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['listChildSessions'];
  readonly readChildSession: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['readChildSession'];
  readonly openChildSessionHistoryLogs: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['openChildSessionHistoryLogs'];
  /** Private D0 admission after the exact parent Tool receipt has committed. */
  readonly createChildSession: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['createChildSession'];
  readonly readChildSessionIntent: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['readChildSessionIntent'];
  readonly readPendingAfterTurnChildTerminalSeal: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['readPendingAfterTurnChildTerminalSeal'];
  readonly readChildApprovalProxy: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['readChildApprovalProxy'];
  /** Deterministic Store identity passed through the unique composition root. */
  readonly childApprovalProxyId: (input: {
    readonly childThreadId: string;
    readonly childInteractionId: string;
    readonly childGeneration: number;
  }) => string;
  readonly listPendingChildApprovalProxies: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['listPendingChildApprovalProxies'];
  readonly listPendingChildSessionIntents: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['listPendingChildSessionIntents'];
  /** Status-only pre-dispatch proof; Store repeats the full CAS at settlement. */
  readChildPreDispatchProof(
    parentSessionId: string,
    childThreadId: string,
  ): Readonly<{
    childRevision: number;
    ownerStatus: 'idle' | 'active' | 'detached' | 'recovery_required';
    cleanupConfirmed: boolean;
  }> | null;
  readChildExecutionAuthority(
    parentSessionId: string,
    childThreadId: string,
  ): Readonly<{
    status: 'idle' | 'active' | 'detached' | 'recovery_required';
    controllerGeneration: number;
    revision: number;
    hostInstanceId: string | null;
    leaseUntilMs: number | null;
    cleanupConfirmed: boolean;
  }> | null;
  readonly readChildSealedGrant: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['readChildSealedGrant'];
  admitWorkspace(workspace: AdmittedWorkspace): void;
  listCurrentSessions(
    query?: string,
    limit?: number,
  ): ReturnType<RuntimeStorage<RuntimeEvent, RuntimeState>['sessions']['listSessions']>;
  /** Startup index only; callers must acquire each source Session before reading mail. */
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
    after?: { childSessionId: string; submissionId: string },
  ): ReturnType<
    KiteSessionRuntimeStorageOwner<
      RuntimeEvent,
      RuntimeState
    >['listUnrepliedSettledFollowupTerminalSources']
  >;
  listUnnotifiedAcceptedFollowupReleases(
    limit: number,
    after?: { childSessionId: string; submissionId: string },
  ): ReturnType<
    KiteSessionRuntimeStorageOwner<
      RuntimeEvent,
      RuntimeState
    >['listUnnotifiedAcceptedFollowupReleases']
  >;
  /** TriggerTurn startup index; source owner rechecks each unsettled submission. */
  listPendingCrossSessionFollowupSources(limit: number, afterSessionId?: string): readonly string[];
  /** Read-only target index; the target owner rechecks every pending stop intent. */
  listPendingCrossSessionInterruptTargets(
    limit: number,
    afterSessionId?: string,
  ): readonly string[];
  loadCurrentSnapshot(sessionId: string): RuntimeState | null;
  getCurrentSessionModelRoute(
    sessionId: string,
  ): ReturnType<RuntimeStorage<RuntimeEvent, RuntimeState>['sessions']['getSessionModelRoute']>;
  runWithSessionExecution<Result>(sessionId: string, operation: () => Result): Result;
  reconcileInterruptedSession(
    sessionId: string,
    recover: (
      generation: number,
      assertCurrent: () => boolean,
    ) => Promise<undefined | 'cleanup_unconfirmed'>,
  ): Promise<void>;
  commitUnownedInteractionMode(
    transaction: RuntimeTransactionInput<RuntimeEvent, RuntimeState>,
    expectedRevision: number,
  ): void;
  readSnapshot<Result>(operation: () => Result): Result;
  ownsSessionExecution(sessionId: string): boolean;
  setExecutionLossHandler(handler: (sessionId: string) => Promise<void>): void;
  commitRecoveryDecision: KiteSessionRuntimeStorageOwner<
    RuntimeEvent,
    RuntimeState
  >['commitRecoveryDecision'];
  readonly recovery: KiteSessionRuntimeStorageOwner<RuntimeEvent, RuntimeState>['recovery'];
  ownedSessionIds(): readonly string[];
  releaseSessionExecution(sessionId: string, cleanup: () => Promise<void>): Promise<boolean>;
  releaseExecutions(cleanupConfirmed: boolean): void;
  disposeStorage(): void;
  close(): void;
}

interface OwnedExecution {
  record: KiteSessionExecutionAuthorityRecord;
  readonly handle: KiteSessionExecutionHandle;
}

export function createKiteSessionAppServerStorage(input: {
  readonly target: KiteSessionRuntimeStorageOwner<RuntimeEvent, RuntimeState>;
  readonly childApprovalProxyId: KiteSessionAppServerStorageOwner['childApprovalProxyId'];
  readonly hostInstanceId: string;
  readonly clientId?: string;
  readonly connectionGeneration?: number;
  readonly executionLeaseMs?: number;
  readonly renewIntervalMs?: number;
  readonly now?: () => number;
}): KiteSessionAppServerStorageOwner {
  assertIdentity(input.hostInstanceId, 'Host instance');
  const clientId = input.clientId ?? `parent-${input.hostInstanceId}`;
  const connectionGeneration = input.connectionGeneration ?? 1;
  assertIdentity(clientId, 'Client');
  assertPositive(connectionGeneration, 'Connection generation');
  const executionLeaseMs = input.executionLeaseMs ?? DEFAULT_EXECUTION_LEASE_MS;
  const renewIntervalMs = input.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  assertPositive(executionLeaseMs, 'Execution lease duration');
  assertPositive(renewIntervalMs, 'Execution renewal interval');
  if (renewIntervalMs >= executionLeaseMs) {
    throw new TypeError('Execution renewal interval must be shorter than the lease duration.');
  }
  const now = input.now ?? Date.now;
  const target = input.target;
  const owned = new Map<string, OwnedExecution>();
  const pendingRecoveryIdentities = new Map<string, string>();
  let executionLossHandler: ((sessionId: string) => Promise<void>) | undefined;
  const loseExecution = (sessionId: string): void => {
    const execution = owned.get(sessionId);
    if (!execution || !owned.delete(sessionId) || !executionLossHandler) return;
    void executionLossHandler(sessionId)
      .then(() => {
        const current = target.authority.read(sessionId);
        // Only the generation whose local cleanup we just awaited may confirm cleanup.
        if (
          current.status === 'recovery_required' &&
          current.controllerGeneration === execution.record.controllerGeneration + 1 &&
          !hasUnconfirmedExecution(target.storage.sessions.loadSnapshot<RuntimeState>(sessionId))
        ) {
          target.recovery.confirmCleanup({
            sessionId,
            expectedAuthorityRevision: current.revision,
          });
        }
      })
      .catch((error) =>
        console.error('Session cleanup confirmation failed.', { sessionId, error }),
      );
  };
  let hostClosed = false;
  let closed = false;

  const leaseUntil = (): number => {
    const value = now() + executionLeaseMs;
    if (!Number.isSafeInteger(value)) throw new Error('Session execution lease overflowed.');
    return value;
  };

  const bind = (record: KiteSessionExecutionAuthorityRecord): OwnedExecution => {
    const existing = owned.get(record.sessionId);
    if (existing) {
      target.refreshExecution(existing.handle, record);
      existing.record = record;
      return existing;
    }
    const execution = { record, handle: target.bindExecution(record) };
    owned.set(record.sessionId, execution);
    return execution;
  };

  const ensureExecution = (sessionId: string): OwnedExecution => {
    assertOpen();
    let current = target.authority.read(sessionId);
    if (
      current.status === 'active' &&
      current.hostInstanceId === input.hostInstanceId &&
      current.clientId === clientId &&
      current.connectionGeneration === connectionGeneration
    ) {
      if (current.leaseUntilMs === null || current.leaseUntilMs <= now()) {
        loseExecution(sessionId);
        throw new KiteAppServerSessionError(
          'recovery_required',
          'Session execution lease expired before renewal.',
        );
      }
      // Synchronous tool/Store continuations may postpone timer callbacks.
      // Renew from real mutation progress while the existing lease is valid;
      // never revive an expired lease or bypass the generation fence above.
      if (current.leaseUntilMs - now() <= executionLeaseMs - renewIntervalMs) {
        const renewed = target.authority.renew({
          sessionId,
          expectedRevision: current.revision,
          controllerGeneration: current.controllerGeneration,
          hostInstanceId: input.hostInstanceId,
          leaseUntilMs: leaseUntil(),
        });
        if (renewed.status !== 'acquired') {
          loseExecution(sessionId);
          throw new KiteAppServerSessionError(
            'recovery_required',
            'Session execution lease could not be renewed.',
          );
        }
        return bind(renewed.authority);
      }
      return bind(current);
    }
    if (current.status === 'recovery_required') {
      // A previous Store generation may have fenced a completed Session solely
      // because a rejected, never-dispatched Tool left a historical recovery
      // journal entry. Check all durable execution facts under one writer
      // transaction before admitting a new turn on the same Session.
      if (
        target.reconcileSettledSession({
          sessionId,
          expectedAuthorityRevision: current.revision,
          isSettledState: isCompletedStateWithoutUnconfirmedExecution,
        })
      ) {
        current = target.authority.read(sessionId);
      }
    }
    if (current.status === 'recovery_required') {
      throw new KiteAppServerSessionError(
        'recovery_required',
        'Session requires explicit effect reconciliation before resume.',
      );
    }
    let acquired = target.authority.acquire({
      sessionId,
      expectedRevision: current.revision,
      hostInstanceId: input.hostInstanceId,
      clientId,
      connectionGeneration,
      leaseUntilMs: leaseUntil(),
    });
    if (acquired.status === 'recovery_required') {
      // An expired old owner may only become fenced during this acquire.
      // Apply the same complete-facts check to that new fence on this send.
      if (
        target.reconcileSettledSession({
          sessionId,
          expectedAuthorityRevision: acquired.authority.revision,
          isSettledState: isCompletedStateWithoutUnconfirmedExecution,
        })
      ) {
        const settled = target.authority.read(sessionId);
        acquired = target.authority.acquire({
          sessionId,
          expectedRevision: settled.revision,
          hostInstanceId: input.hostInstanceId,
          clientId,
          connectionGeneration,
          leaseUntilMs: leaseUntil(),
        });
      }
      if (acquired.status === 'recovery_required') {
        throw new KiteAppServerSessionError(
          'recovery_required',
          'Session requires explicit effect reconciliation before resume.',
        );
      }
    }
    if (acquired.status === 'busy') {
      throw new KiteAppServerSessionError(
        'session_busy',
        'Session execution is owned by another App Server.',
      );
    }
    return bind(acquired.authority);
  };

  const runWithSessionExecution = <Result>(sessionId: string, operation: () => Result): Result => {
    const execution = ensureExecution(sessionId);
    return target.runWithExecution(execution.handle, operation);
  };

  const recovering = new Map<string, Promise<void>>();
  const reconcileInterruptedSession = (
    sessionId: string,
    recover: (
      generation: number,
      assertCurrent: () => boolean,
    ) => Promise<undefined | 'cleanup_unconfirmed'>,
  ): Promise<void> => {
    const pending = recovering.get(sessionId);
    if (pending) return pending;
    const recovery = (async () => {
      assertOpen();
      if (owned.has(sessionId)) return;
      const state = target.storage.sessions.loadSnapshot<RuntimeState>(sessionId);
      if (!state) return;
      let current = target.authority.read(sessionId);
      // A live owner survives renderer reconnects. Only an expired lease may be fenced.
      if (
        (current.status === 'active' || current.status === 'detached') &&
        current.leaseUntilMs !== null &&
        current.leaseUntilMs > now()
      )
        return;
      // Terminal business State can still have an unmatched historical start.
      // Inspect history only when durable Tool/lifecycle facts prove a candidate.
      const needsHistoryCorrection =
        hasSettledSubagentHistoryCandidate(state) &&
        eventsForSettledSubagentHistory(
          state,
          target.storage.sessions.loadEventsStrict(sessionId).map((entry) => entry.event),
        ).length > 0;
      if (
        !needsHistoryCorrection &&
        current.status === 'idle' &&
        state.turn.status !== 'active' &&
        !hasUnconfirmedExecution(state)
      )
        return;
      if (
        !needsHistoryCorrection &&
        current.status === 'recovery_required' &&
        target.reconcileSettledSession({
          sessionId,
          expectedAuthorityRevision: current.revision,
          isSettledState: isRuntimeHostStateSettledForMigration,
        })
      )
        return;
      if (current.status !== 'recovery_required') {
        const acquired = target.authority.acquire({
          sessionId,
          expectedRevision: current.revision,
          hostInstanceId: input.hostInstanceId,
          clientId,
          connectionGeneration,
          leaseUntilMs: leaseUntil(),
        });
        if (acquired.status === 'busy') return;
        current = acquired.authority;
        if (acquired.status === 'acquired') {
          // Even a cleanly released owner can leave unfinished business State.
          // Fence the recovery attempt before claiming a scoped recovery writer.
          current = target.authority.release({
            sessionId,
            expectedRevision: current.revision,
            controllerGeneration: current.controllerGeneration,
            hostInstanceId: input.hostInstanceId,
            cleanupConfirmed: false,
          });
        }
      }
      const execution = bind(
        target.beginRecoveryExecution({
          sessionId,
          expectedAuthorityRevision: current.revision,
          hostInstanceId: input.hostInstanceId,
          clientId,
          connectionGeneration,
          leaseUntilMs: leaseUntil(),
        }),
      );
      let cleaned = false;
      try {
        const completion = await target.runWithExecution(execution.handle, () =>
          recover(execution.record.controllerGeneration, () => {
            const observed = target.authority.read(sessionId);
            return (
              observed.status === 'active' &&
              observed.hostInstanceId === input.hostInstanceId &&
              observed.controllerGeneration === execution.record.controllerGeneration &&
              observed.leaseUntilMs !== null &&
              observed.leaseUntilMs > now()
            );
          }),
        );
        cleaned = completion !== 'cleanup_unconfirmed';
      } finally {
        const observed = target.authority.read(sessionId);
        if (
          observed.status === 'active' &&
          observed.hostInstanceId === input.hostInstanceId &&
          observed.controllerGeneration === execution.record.controllerGeneration
        ) {
          target.authority.release({
            sessionId,
            expectedRevision: observed.revision,
            controllerGeneration: observed.controllerGeneration,
            hostInstanceId: input.hostInstanceId,
            cleanupConfirmed: cleaned,
          });
        }
        owned.delete(sessionId);
      }
    })();
    recovering.set(sessionId, recovery);
    return recovery.finally(() => {
      if (recovering.get(sessionId) === recovery) recovering.delete(sessionId);
    });
  };

  const renewTimer = setInterval(() => {
    if (closed || hostClosed) return;
    for (const [sessionId, execution] of owned) {
      try {
        const current = target.authority.read(sessionId);
        if (
          current.status !== 'active' ||
          current.hostInstanceId !== input.hostInstanceId ||
          current.clientId !== clientId ||
          current.connectionGeneration !== connectionGeneration
        ) {
          loseExecution(sessionId);
          continue;
        }
        const renewed = target.authority.renew({
          sessionId,
          expectedRevision: current.revision,
          controllerGeneration: current.controllerGeneration,
          hostInstanceId: input.hostInstanceId,
          leaseUntilMs: leaseUntil(),
        });
        if (renewed.status !== 'acquired') {
          console.error('Session execution renewal lost ownership.', {
            sessionId,
            status: renewed.status,
            previousLeaseUntilMs: current.leaseUntilMs,
            observedAtMs: now(),
          });
          loseExecution(sessionId);
          continue;
        }
        execution.record = renewed.authority;
        target.refreshExecution(execution.handle, renewed.authority);
      } catch (error) {
        console.error('Session execution renewal failed.', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
          cause:
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : undefined,
        });
        loseExecution(sessionId);
      }
    }
  }, renewIntervalMs);
  renewTimer.unref?.();

  const commit = (
    channel: keyof RuntimeStorage<RuntimeEvent, RuntimeState>['transactions'],
    transaction: Parameters<
      RuntimeStorage<RuntimeEvent, RuntimeState>['transactions']['commitDecision']
    >[0],
  ): void => {
    if (target.storage.sessions.loadSnapshotRecord(transaction.sessionId)) {
      runWithSessionExecution(transaction.sessionId, () =>
        target.storage.transactions[channel](transaction),
      );
      return;
    }
    if (channel !== 'commitDecision' || !transaction.commandReceipt) {
      throw new KiteAppServerSessionError(
        'session_unavailable',
        'Only a receipt-bearing create decision may initialize a Session.',
      );
    }
    const workspace = workspaceFromState(transaction.snapshot);
    admitWorkspace(workspace);
    const recoveryIdentity = pendingRecoveryIdentities.get(transaction.sessionId);
    if (!recoveryIdentity) {
      throw new KiteAppServerSessionError(
        'session_unavailable',
        'Initial Session recovery identity was not allocated.',
      );
    }
    const result = target.sessionCreationForWorkspace(workspaceIdFor(workspace)).create({
      runtime: transaction,
      controller: {
        sessionId: transaction.sessionId,
        requestId: transaction.commandReceipt.commandId,
        requestDigest: transaction.commandReceipt.requestDigest,
        clientId,
        connectionGeneration,
        workerInstanceId: input.hostInstanceId,
        resumeSecret: createHash('sha256')
          .update(`kite.app-server.initial-resume.v1\0${transaction.commandReceipt.commandId}`)
          .digest('base64url'),
        resumeExpiresAtMs: leaseUntil(),
        executionLeaseUntilMs: leaseUntil(),
      },
      recoveryIdentity,
    });
    pendingRecoveryIdentities.delete(transaction.sessionId);
    bind(target.authority.read(transaction.sessionId));
    if (result.runtimeReceipt.committedRevision !== transaction.commandReceipt.committedRevision) {
      throw new Error('Initial Session receipt revision changed after commit.');
    }
  };

  const transactions = Object.freeze({
    commitDecision: (transaction) => commit('commitDecision', transaction),
    commitAttemptStart: (transaction) => commit('commitAttemptStart', transaction),
    commitReceiptEvidence: (transaction) => commit('commitReceiptEvidence', transaction),
    commitTerminalRecovery: (transaction) => commit('commitTerminalRecovery', transaction),
  } satisfies RuntimeStorage<RuntimeEvent, RuntimeState>['transactions']);

  const recoveryIdentities = Object.freeze({
    read(sessionId) {
      return (
        pendingRecoveryIdentities.get(sessionId) ??
        target.storage.recoveryIdentities.read(sessionId)
      );
    },
    getOrCreate(sessionId, allocate) {
      if (target.storage.sessions.loadSnapshotRecord(sessionId)) {
        return target.storage.recoveryIdentities.getOrCreate(sessionId, allocate);
      }
      const existing = pendingRecoveryIdentities.get(sessionId);
      if (existing) return existing;
      const value = allocate();
      if (!/^[a-f0-9]{64}$/u.test(value)) {
        throw new Error('Initial Session recovery identity is invalid.');
      }
      pendingRecoveryIdentities.set(sessionId, value);
      return value;
    },
    remove(sessionId) {
      if (pendingRecoveryIdentities.delete(sessionId)) return;
      target.storage.recoveryIdentities.remove(sessionId);
    },
  } satisfies RuntimeStorage<RuntimeEvent, RuntimeState>['recoveryIdentities']);

  const storage: KiteSessionAppServerStorageOwner['storage'] = Object.freeze({
    ...target.storage,
    transactions,
    recoveryIdentities,
    close: () => {
      hostClosed = true;
    },
  });

  function admitWorkspace(workspace: AdmittedWorkspace): void {
    const digest = workspaceIdentityDigest(workspace);
    target.admissions.admit({
      workspaceId: workspaceIdFor(workspace),
      canonicalPath: workspace.canonicalPath,
      workspaceIdentityDigest: digest,
      projectId: workspace.projectId,
      workspaceDigest: workspace.workspaceDigest,
      displayName: basename(workspace.canonicalPath),
    });
  }

  function assertOpen(): void {
    if (closed || hostClosed) {
      throw new KiteAppServerSessionError('storage_closed', 'App Server storage is closed.');
    }
  }

  const releaseExecutions = (cleanupConfirmed: boolean): void => {
    clearInterval(renewTimer);
    for (const [sessionId, execution] of owned) {
      try {
        const current = target.authority.read(sessionId);
        if (
          current.status !== 'active' ||
          current.hostInstanceId !== input.hostInstanceId ||
          current.controllerGeneration !== execution.record.controllerGeneration
        ) {
          continue;
        }
        target.authority.release({
          sessionId,
          expectedRevision: current.revision,
          controllerGeneration: current.controllerGeneration,
          hostInstanceId: input.hostInstanceId,
          cleanupConfirmed,
        });
      } catch {
        if (!cleanupConfirmed) continue;
        let current: KiteSessionExecutionAuthorityRecord;
        try {
          current = target.authority.read(sessionId);
        } catch {
          continue;
        }
        if (current.status !== 'active' || current.hostInstanceId !== input.hostInstanceId)
          continue;
        target.authority.release({
          sessionId,
          expectedRevision: current.revision,
          controllerGeneration: current.controllerGeneration,
          hostInstanceId: input.hostInstanceId,
          cleanupConfirmed: false,
        });
      }
    }
    owned.clear();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    hostClosed = true;
    clearInterval(renewTimer);
    pendingRecoveryIdentities.clear();
    executionLossHandler = undefined;
    target.close();
  };

  return Object.freeze({
    hostInstanceId: input.hostInstanceId,
    executionClientId: clientId,
    executionConnectionGeneration: connectionGeneration,
    storage,
    artifactStore: target.artifactStore,
    directory: target.directory,
    workspaceDeletion: target.workspaceDeletion,
    getAdmittedWorkspace: target.getAdmittedWorkspace,
    getAdmittedWorkspaceByDigest: target.getAdmittedWorkspaceByDigest,
    openHistoryLogs: target.openHistoryLogs,
    readSessionLineage: (sessionId) => target.readSessionLineage(sessionId),
    listChildSessions: (parentSessionId, limit, cursor) =>
      target.listChildSessions(parentSessionId, limit, cursor),
    readChildSession: (parentSessionId, childSessionId) =>
      target.readChildSession(parentSessionId, childSessionId),
    openChildSessionHistoryLogs: (parentSessionId, childSessionId, currentEventTypes) =>
      target.openChildSessionHistoryLogs(parentSessionId, childSessionId, currentEventTypes),
    createChildSession: (creation) => target.createChildSession(creation),
    readChildSessionIntent: (childThreadId) => target.readChildSessionIntent(childThreadId),
    readPendingAfterTurnChildTerminalSeal: (parentSessionId, childThreadId) =>
      target.readPendingAfterTurnChildTerminalSeal(parentSessionId, childThreadId),
    readChildApprovalProxy: (parentSessionId, proxyInteractionId) =>
      target.readChildApprovalProxy(parentSessionId, proxyInteractionId),
    childApprovalProxyId: input.childApprovalProxyId,
    listPendingChildApprovalProxies: (parentSessionId, limit, afterProxyInteractionId) =>
      target.listPendingChildApprovalProxies(parentSessionId, limit, afterProxyInteractionId),
    listPendingChildSessionIntents: (parentSessionId, limit, cursor) =>
      target.listPendingChildSessionIntents(parentSessionId, limit, cursor),
    readChildPreDispatchProof: (parentSessionId, childThreadId) => {
      const lineage = target.readSessionLineage(childThreadId);
      if (!lineage) return null;
      if (lineage.parentSessionId !== parentSessionId)
        throw new Error('Child pre-dispatch proof belongs to another parent Session.');
      const state = target.storage.sessions.loadSnapshot<RuntimeState>(childThreadId);
      if (!state) throw new Error('Child pre-dispatch State is unavailable.');
      const authority = target.authority.read(childThreadId);
      return {
        childRevision: state.revision,
        ownerStatus: authority.status,
        cleanupConfirmed: authority.cleanupConfirmed,
      };
    },
    readChildExecutionAuthority: (parentSessionId, childThreadId) => {
      const lineage = target.readSessionLineage(childThreadId);
      if (!lineage) return null;
      if (lineage.parentSessionId !== parentSessionId)
        throw new Error('Child execution authority belongs to another parent Session.');
      const authority = target.authority.read(childThreadId);
      return {
        status: authority.status,
        controllerGeneration: authority.controllerGeneration,
        revision: authority.revision,
        hostInstanceId: authority.hostInstanceId,
        leaseUntilMs: authority.leaseUntilMs,
        cleanupConfirmed: authority.cleanupConfirmed,
      };
    },
    readChildSealedGrant: (childThreadId) => target.readChildSealedGrant(childThreadId),
    admitWorkspace,
    listCurrentSessions: (query = '', limit = 50) => storage.sessions.listSessions(query, limit),
    listPendingCrossSessionQueueMailSources: (limit, afterSessionId) =>
      target.listPendingCrossSessionQueueMailSources(limit, afterSessionId),
    listPendingCrossSessionTerminalReplyMailSources: (limit, afterSessionId) =>
      target.listPendingCrossSessionTerminalReplyMailSources(limit, afterSessionId),
    listUnrepliedSettledFollowupTerminalSources: (limit, after) =>
      target.listUnrepliedSettledFollowupTerminalSources(limit, after),
    listUnnotifiedAcceptedFollowupReleases: (limit, after) =>
      target.listUnnotifiedAcceptedFollowupReleases(limit, after),
    listPendingCrossSessionFollowupSources: (limit, afterSessionId) =>
      target.listPendingCrossSessionFollowupSources(limit, afterSessionId),
    listPendingCrossSessionInterruptTargets: (limit, afterSessionId) =>
      target.listPendingCrossSessionInterruptTargets(limit, afterSessionId),
    loadCurrentSnapshot: (sessionId) => storage.sessions.loadSnapshot<RuntimeState>(sessionId),
    getCurrentSessionModelRoute: (sessionId) => storage.sessions.getSessionModelRoute(sessionId),
    runWithSessionExecution,
    reconcileInterruptedSession,
    commitUnownedInteractionMode(transaction, expectedRevision) {
      if (
        transaction.events.length > 1 ||
        transaction.events.some((event) => event.type !== 'interaction_mode.changed')
      ) {
        throw new Error('Unowned policy decisions may only change interaction mode.');
      }
      target.commitUnownedDecision(transaction, expectedRevision);
    },
    readSnapshot: target.readSnapshot,
    ownsSessionExecution: (sessionId) => owned.has(sessionId),
    setExecutionLossHandler: (handler) => {
      executionLossHandler = handler;
    },
    recovery: target.recovery,
    commitRecoveryDecision: target.commitRecoveryDecision,
    ownedSessionIds: () => Object.freeze([...owned.keys()]),
    async releaseSessionExecution(sessionId, cleanup) {
      const execution = owned.get(sessionId);
      if (!execution) {
        await cleanup();
        return false;
      }
      if (!target.storage.sessions.loadSnapshotRecord(sessionId)) {
        await cleanup();
        owned.delete(sessionId);
        return true;
      }
      if (
        target.recovery.inspect(sessionId).pendingEffects.length > 0 ||
        hasUnconfirmedExecution(target.storage.sessions.loadSnapshot<RuntimeState>(sessionId))
      )
        return false;
      await cleanup();
      const current = target.authority.read(sessionId);
      if (
        current.status !== 'active' ||
        current.hostInstanceId !== input.hostInstanceId ||
        current.controllerGeneration !== execution.record.controllerGeneration
      )
        return false;
      target.authority.release({
        sessionId,
        expectedRevision: current.revision,
        controllerGeneration: current.controllerGeneration,
        hostInstanceId: input.hostInstanceId,
        cleanupConfirmed: true,
      });
      owned.delete(sessionId);
      return true;
    },
    releaseExecutions,
    disposeStorage: close,
    close,
    [Symbol.asyncDispose]: async () => close(),
  } satisfies KiteSessionAppServerStorageOwner);
}

function workspaceFromState(state: RuntimeState): AdmittedWorkspace {
  const canonicalPath = state.session.workspace;
  const projectId = state.session.projectId;
  const workspaceDigest = state.session.canonicalWorkspaceDigest;
  assertIdentity(canonicalPath, 'Workspace path');
  assertIdentity(projectId, 'Project');
  if (typeof workspaceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(workspaceDigest)) {
    throw new TypeError('Workspace digest identity is invalid.');
  }
  const workspace: AdmittedWorkspace = {
    canonicalPath,
    projectId,
    workspaceDigest: workspaceDigest as `sha256:${string}`,
  };
  return Object.freeze(workspace);
}

function workspaceIdentityDigest(workspace: AdmittedWorkspace): string {
  const material = JSON.stringify({
    canonicalPath: workspace.canonicalPath,
    projectId: workspace.projectId,
    workspaceDigest: workspace.workspaceDigest,
  });
  return `sha256:${createHash('sha256').update(`kite.workspace-identity.v1\0${material}`).digest('hex')}`;
}

function workspaceIdFor(workspace: AdmittedWorkspace): string {
  return `workspace_${workspaceIdentityDigest(workspace).slice('sha256:'.length)}`;
}

function assertIdentity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} identity is invalid.`);
  }
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid.`);
}

function hasUnconfirmedExecution(state: RuntimeState | null): boolean {
  return (
    state !== null &&
    (hasPendingSubagentProviderRecovery(state) ||
      Object.values(state.modelInvocations).some(
        (invocation) => invocation.status === 'dispatching',
      ))
  );
}

function isCompletedStateWithoutUnconfirmedExecution(state: Readonly<RuntimeState>): boolean {
  return (
    state.turn.status === 'completed' &&
    state.terminalOutcome?.status === 'completed' &&
    state.terminalOutcome.pendingVerification === false &&
    isRuntimeHostStateSettledForMigration(state)
  );
}
