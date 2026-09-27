import type { AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  computeProviderEndpointIdentityDigest,
  createChatModel,
  createModelSecretDetector,
  humanMessage,
  type ModelInvocationPersistence,
  normalizedModelResponseToAIMessage,
  providerRouteIdentityFromModelConfig,
  resumeBuiltinPreparedPrimaryModelEffect,
  verifyCompletedModelInvocationEvidence,
} from '@kite-ai/builtin-runtime/model';
import { getRoleConfig } from '@kite-ai/builtin-runtime/subagent';
import {
  createRuntimeAbortReason,
  getAgentPhase,
  RUNTIME_NOTIFICATION_SCHEMA_,
  type RuntimeNotification,
  type RuntimeSessionProjection,
  runtimeAbortCause,
} from '@kite-ai/runtime-contract';
import type { RuntimeHostLeasePort } from '@kite-ai/runtime-host';
import {
  type CrossSessionFollowupAdmission,
  type CrossSessionFollowupPolicy,
  type CrossSessionIndependentTurnPolicyProof,
  type CrossSessionTargetFollowupPolicyProof,
  committedResourceUsage,
  createAgentMessageContextFrame,
  createZeroResourceUsage,
  fundingBudgetForRun,
  planCrossSessionFirstModelReplacement,
  planCrossSessionFollowupSlotAcquisition,
  planCrossSessionIndependentTurnActivation,
  runtimeHostStateActivePlanning,
  runtimeHostStateDecideCompletion,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED,
  childDelegatedUpperBoundDigest,
} from '@kite-ai/runtime-host/storage';
import type { RuntimeJsonValue, SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import { TOOL_PIPELINE_STAGE_SCHEMA_ } from '@kite-ai/runtime-spi';
import { appSandboxBackendAvailable } from '#kite-service/sandbox/types';
import { projectRuntimeClientEvent } from '../../../runtime-client/event-projector';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { InstalledKiteRuntimeComposition } from '../../model-runtime-composition';
import { projectRuntimeEphemeralNotification } from '../../presentation-notification';
import type { RootFollowupPolicyEvidence } from '../agent-mailbox-port';
import type { CliRuntimeBridgeInput } from '../CliRuntimeBridge';
import { classifyFailure } from '../failures';
import {
  type CurrentSourceFollowupPolicyInput,
  currentSourceFollowupPolicy,
} from '../followup-policy-proof';
import { projectPrimaryModelEffect } from '../model-effect';
import type {
  RuntimeSessionCoordinatorAccess,
  RuntimeSessionCoordinatorIdentity,
} from '../RuntimeSessionCoordinator';
import { reconcileRuntimeSessionAfterRestart } from '../session-restart-recovery';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';
import { completedTerminalOutcome, failedTerminalOutcome } from '../terminal-outcome';
import type { RuntimeTurnInput } from '../turn-coordinator';
import { backgroundSubagentOwnerKey } from './background-runtime';
import { createChildApprovalProxyOwner } from './child-approval-owner';
import { classifyChildApprovalRecovery } from './child-approval-proxy';
import { settleAcceptedChildCreationFailure } from './child-creation-failure';
import {
  classifyChildApprovalFirstTurnRecovery,
  classifyChildFirstTurnRecovery,
} from './child-first-turn-recovery';
import { planChildFollowupTurn, verifiedTargetFollowupCatalog } from './child-followup-turn';
import type { AcceptedChildSession } from './child-session-acceptance';
import { activateAcceptedChildSession } from './child-session-activation';
import { projectIndependentChildExecutions } from './child-session-background-projection';
import { buildChildSessionCreation } from './child-session-creation';
import { planChildSessionRecovery } from './child-session-recovery';
import { createChildApprovalActionProvider, runAcceptedChildSession } from './child-session-runner';
import { createChildSessionTaskControl } from './child-session-task-control';
import { importChildTerminalResult, sealChildTerminalResult } from './child-terminal-bridge';
import { recoverUnknownChildTerminal } from './child-unknown-recovery';
import type { SubAgentResult } from './types';

type ChildTurn = Parameters<typeof runAcceptedChildSession>[0]['turn'];
type LaunchChild = Pick<
  AcceptedChildSession,
  'childThreadId' | 'childInvocationId' | 'parentSessionId'
> &
  Partial<Pick<AcceptedChildSession, 'childBudget' | 'childDeadlineAt'>>;

type ChildRecoveryResult = Readonly<{
  processed: number;
  recoveryRequired: readonly Readonly<{ childThreadId: string; reason: string }>[];
  nextCursor?: string;
}>;

type ScheduledChildRecovery = Readonly<{
  scheduled: number;
  recoveryRequired: ChildRecoveryResult['recoveryRequired'];
  nextCursor?: string;
  completion: Promise<ChildRecoveryResult>;
}>;

type FollowupRecoveryResult = Readonly<{
  processed: number;
  recoveryRequired: readonly Readonly<{ submissionId: string; reason: string }>[];
  nextCursor?: string;
}>;

type ScheduledFollowupRecovery = Readonly<{
  scheduled: number;
  completion: Promise<FollowupRecoveryResult>;
  nextCursor?: string;
}>;

type InterruptRecoveryResult = Readonly<{
  observed: number;
  processed: number;
  recoveryRequired: readonly string[];
}>;

type ScheduledInterruptRecovery = Readonly<{
  scheduled: number;
  completion: Promise<InterruptRecoveryResult>;
}>;

const MAX_CONCURRENT_CHILD_RECOVERIES = 8;

function childRunId(childThreadId: string): string {
  return `run_${createHash('sha256').update(`kite.child-run.v1\0${childThreadId}`).digest('hex')}`;
}

function terminalStatus(state: RuntimeState): NonNullable<SubAgentResult['terminalStatus']> {
  const outcome = state.terminalOutcome;
  if (!outcome && state.turn.status === 'aborted' && state.turn.abortCause === 'user')
    return 'cancelled';
  if (!outcome) throw new Error('Child Session finished without a terminal outcome.');
  if (outcome.status === 'completed') return 'completed';
  if (outcome.status === 'budget_exhausted') return 'exhausted';
  if (outcome.status === 'blocked') return 'suspended';
  if (outcome.status === 'unknown') return 'interrupted';
  if (outcome.status === 'aborted' && state.turn.abortCause === 'user') return 'cancelled';
  return 'failed';
}

/** Use only the Kernel's bounded reason code in parent-visible child failures. */
export function childTerminalResult(state: RuntimeState, output: string): SubAgentResult {
  const status = terminalStatus(state);
  const reasonCode = status === 'completed' ? undefined : state.terminalOutcome?.reasonCode;
  return {
    ok: status === 'completed',
    summary:
      status === 'completed'
        ? output
        : `Child Session ${status}${reasonCode ? `: ${reasonCode}` : ''}.`,
    ...(reasonCode ? { error: reasonCode } : {}),
    toolCallCount: Object.keys(state.tools.calls).length,
    durationMs:
      state.resourceBudget.status === 'active'
        ? Math.max(0, Date.now() - Date.parse(state.resourceBudget.startedAt))
        : 0,
    terminalStatus: status,
  };
}

const localChildRunners = new WeakMap<
  KiteSessionAppServerStorageOwner,
  {
    active: Map<string, AbortController>;
    queued: Map<string, AbortController>;
  }
>();

function childRunnersFor(owner: KiteSessionAppServerStorageOwner): {
  active: Map<string, AbortController>;
  queued: Map<string, AbortController>;
} {
  const existing = localChildRunners.get(owner);
  if (existing) return existing;
  const created = {
    active: new Map<string, AbortController>(),
    queued: new Map<string, AbortController>(),
  };
  localChildRunners.set(owner, created);
  return created;
}

/** Private App Server owner. Cross-Session work enters a clean async scope. */
export function createChildSessionOrchestrator(input: {
  readonly detachedScope: AsyncResource;
  readonly owner: KiteSessionAppServerStorageOwner;
  readonly effectLeases: Pick<RuntimeHostLeasePort, 'tryAcquire' | 'release'>;
  readonly parentSessionId: string;
  readonly bridgeInput: CliRuntimeBridgeInput;
  readonly coordinators: RuntimeSessionCoordinatorAccess;
  readonly modelRuntimeFactory: (
    workspace: string,
  ) => InstalledKiteRuntimeComposition & RuntimeTurnInput['modelInvocationRuntime'];
  readonly capabilityExecution: RuntimeTurnInput['capabilityExecution'];
  readonly enqueueSessionWork: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  readonly projectChildSession?: (
    childSessionId: string,
    state: Readonly<RuntimeState>,
  ) => RuntimeSessionProjection | undefined;
  readonly publishChildNotification?: (notification: RuntimeNotification) => void;
  /** The Store outbox is durable before this best-effort online delivery wake. */
  readonly scheduleTerminalReplyDelivery?: (
    childSessionId: string,
    messageId: string,
  ) => void | Promise<void>;
  /** Current source catalog and Router flags; unavailable evidence keeps replacement closed. */
  readonly readCurrentSourceFollowupContext?: (input: {
    readonly sourceState: Readonly<RuntimeState>;
    readonly submissionId: string;
  }) => Pick<
    CurrentSourceFollowupPolicyInput,
    | 'mcpSnapshot'
    | 'skillCatalog'
    | 'agentMailboxPortAvailable'
    | 'agentMailboxQueueOnlyAvailable'
    | 'interactionModeOverride'
  > | null;
  /** The current target directory is read separately from source Tool authority. */
  readonly readCurrentTargetPolicyContext?: (input: {
    readonly targetState: Readonly<RuntimeState>;
    readonly submissionId: string;
  }) => Readonly<{
    observedTargetRevision: number;
    mcpSnapshot: CurrentSourceFollowupPolicyInput['mcpSnapshot'];
    skillCatalog: CurrentSourceFollowupPolicyInput['skillCatalog'];
  }> | null;
}): NonNullable<RuntimeTurnInput['childSessionAcceptance']> & {
  schedulePendingRecovery(cursor?: string): Promise<ScheduledChildRecovery>;
  recoverPending(cursor?: string): Promise<ChildRecoveryResult>;
  stopPendingRecovery(): Promise<void>;
  /** Commits only a checkpoint-backed new Run; Provider dispatch is a later fenced stage. */
  startAcceptedFollowup(targetSessionId: string, submissionId: string): boolean;
  receiveAcceptedFollowup(targetSessionId: string, submissionId: string): Promise<boolean>;
  replacePreparedFollowupBackup(targetSessionId: string, submissionId: string): boolean;
  routePreparedFollowup(targetSessionId: string, submissionId: string): boolean;
  activateRoutedFollowup(targetSessionId: string, submissionId: string): boolean;
  /** One gated first Model attempt; a blocked source proof leaves prepared State for recovery. */
  executeAcceptedFollowupFirstModel(
    targetSessionId: string,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  resumePreparedFollowupFirstModel(
    targetSessionId: string,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  settleTerminalFollowupFunding(targetSessionId: string, submissionId: string): boolean;
  schedulePendingFollowupRecovery(cursor?: string): ScheduledFollowupRecovery;
  recoverPendingFollowups(cursor?: string): Promise<FollowupRecoveryResult>;
  schedulePendingInterruptRecovery(targetSessionId: string): ScheduledInterruptRecovery;
  bindParentApprovalWake(
    publish: (
      event: Extract<RuntimeEvent, { type: 'subagent.child_approval_proxy_changed' }>,
    ) => void,
  ): void;
} {
  const { active: activeChildren, queued: queuedChildren } = childRunnersFor(input.owner);
  const recoveryActiveChildren = new Set<AbortController>();
  const recoveryQueuedChildren = new Set<AbortController>();
  const pendingRecoveries = new Set<Promise<ChildRecoveryResult>>();
  const pendingFollowupRecoveries = new Set<Promise<FollowupRecoveryResult>>();
  const pendingInterruptRecoveries = new Set<Promise<InterruptRecoveryResult>>();
  const activeInterruptTargets = new Set<string>();
  const followupRecoveryControllers = new Set<AbortController>();
  const activeFollowupControllers = new Map<string, AbortController>();
  const currentTurnCandidates = new Map<
    string,
    Readonly<{
      targetSessionId: string;
      submissionId: string;
      messageId: string;
      sequence: number;
      fundingRunId: string;
      backupReservationId: string;
    }>
  >();
  const activeFollowupSubmissions = new Set<string>();
  let stoppingRecovery = false;
  let publishParentApprovalWake:
    | ((event: Extract<RuntimeEvent, { type: 'subagent.child_approval_proxy_changed' }>) => void)
    | undefined;
  const ensureChild = (
    childThreadId: string,
    modelRuntime: ReturnType<typeof input.modelRuntimeFactory>,
    preparedFollowupProof?: NonNullable<
      RuntimeSessionCoordinatorIdentity['preservePreparedFollowupModels']
    >[number],
  ) => {
    const state = input.owner.storage.sessions.loadSnapshot<RuntimeState>(childThreadId);
    if (!state) throw new Error('Child Session State is unavailable.');
    if (!/^sha256:[a-f0-9]{64}$/u.test(state.session.canonicalWorkspaceDigest ?? ''))
      throw new Error('Child Session Workspace digest is invalid.');
    const currentTurnRoutes = input.owner.storage.sessions
      .loadEventsStrict(childThreadId)
      .flatMap(({ event }) =>
        event.type === 'agent.followup_routed' &&
        event.route === 'current_turn' &&
        event.targetAgentId === childThreadId &&
        event.invocationId in state.modelInvocations &&
        state.modelInvocations[event.invocationId]?.status === 'prepared'
          ? [event]
          : [],
      );
    if (currentTurnRoutes.length > 1)
      throw new Error('Child Session has multiple prepared current-turn routes.');
    const currentTurnProof =
      currentTurnRoutes.length === 1 &&
      state.childSessionOrigin?.parentSessionId === input.parentSessionId
        ? input.detachedScope.runInAsyncScope(() =>
            input.owner.runWithSessionExecution(childThreadId, () =>
              input.owner.storage.crossSessionQueueMail?.readCurrentTurnPreparedNoAttemptProof(
                childThreadId,
                input.parentSessionId,
                currentTurnRoutes[0]!.submissionId,
              ),
            ),
          )
        : null;
    return input.coordinators.ensure({
      sessionId: childThreadId,
      userId: state.session.userId,
      workspace: state.session.workspace,
      projectId: state.session.projectId!,
      canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest as `sha256:${string}`,
      interactionMode: state.mode,
      recoveryIdentityKey: state.toolRecovery.identityKey,
      sandboxAvailable: appSandboxBackendAvailable(input.bridgeInput.sandboxBackend),
      modelArtifactEvidence: modelRuntime.evidence,
      capabilityArtifactEvidence: modelRuntime.capabilityArtifacts,
      ...(preparedFollowupProof ? { preservePreparedFollowupModels: [preparedFollowupProof] } : {}),
      ...(currentTurnProof ? { preservePreparedCurrentTurnModels: [currentTurnProof] } : {}),
    });
  };
  const childStreamSequences = new Map<string, number>();
  const publishChildNotification = (notification: RuntimeNotification): void => {
    try {
      input.publishChildNotification?.(notification);
    } catch (error) {
      console.error(
        'Independent child live notification failed; durable History remains readable.',
        {
          sessionId: notification.sessionId,
          revision:
            notification.durability === 'durable' ? notification.revision : notification.sequence,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        },
      );
    }
  };
  const clearSettledChildStream = (
    child: ReturnType<typeof ensureChild>,
    fallbackRunId: string,
  ): void => {
    const state = child.getState();
    if (state.turn.status !== 'active')
      childStreamSequences.delete(`${child.sessionId}\0${state.turn.turnId ?? fallbackRunId}`);
  };
  const publishChildPresentation = (
    child: ReturnType<typeof ensureChild>,
    event: RuntimeEvent,
    identity: { readonly runId: string; readonly taskId: string },
  ): void => {
    if (!input.publishChildNotification) return;
    const state = child.getState();
    const streamId = state.turn.turnId ?? identity.runId;
    const key = `${child.sessionId}\0${streamId}`;
    const sequence = (childStreamSequences.get(key) ?? 0) + 1;
    const notification = projectRuntimeEphemeralNotification(event, {
      sessionId: child.sessionId,
      workId: identity.taskId,
      runId: identity.runId,
      taskId: identity.taskId,
      turnId: streamId,
      actorId: 'runtime-agent',
      attemptId: streamId,
      streamId,
      sequence,
    });
    if (!notification) return;
    childStreamSequences.set(key, sequence);
    publishChildNotification(notification);
  };
  const publishChildCommittedThrough = (
    child: ReturnType<typeof ensureChild>,
    revision: number,
    identity: { readonly runId: string; readonly taskId: string },
  ): void => {
    if (!input.publishChildNotification) return;
    for (const committed of child.takeCommittedEventsThrough?.(revision) ?? []) {
      try {
        const committedRevision = child.revisionForEvent?.(committed);
        const state = child.stateForEvent?.(committed);
        if (committedRevision === undefined || !state || state.revision !== committedRevision)
          throw new Error('Child committed event State projection is unavailable.');
        const session = input.projectChildSession?.(child.sessionId, state);
        if (!session) throw new Error('Child committed event projection is unavailable.');
        const projected = projectRuntimeClientEvent(committed, {
          sessionRevision: committedRevision,
        });
        publishChildNotification({
          schema: RUNTIME_NOTIFICATION_SCHEMA_,
          durability: 'durable',
          sessionId: child.sessionId,
          revision: committedRevision,
          runId: identity.runId,
          taskId: identity.taskId,
          ...(state.turn.turnId ? { turnId: state.turn.turnId } : {}),
          projection: {
            kind: 'turn',
            session,
            ...(projected === undefined ? {} : { event: projected }),
          },
        });
      } catch (error) {
        console.error(
          'Independent child committed projection failed; durable History remains readable.',
          {
            sessionId: child.sessionId,
            revision: child.revisionForEvent?.(committed),
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
        );
      }
    }
  };
  const targetModelConfig = (targetSessionId: string): CliRuntimeBridgeInput['config'] | null => {
    const route = input.owner.storage.sessions.getSessionModelRoute(targetSessionId);
    if (!route) return null;
    const resolved = input.bridgeInput.resolveModelConfig?.(route);
    if (resolved) return resolved;
    return route.provider === input.bridgeInput.config.providerName &&
      route.name === input.bridgeInput.config.modelName
      ? input.bridgeInput.config
      : null;
  };
  const sourceModelConfig = (): CliRuntimeBridgeInput['config'] | null => {
    const route = input.owner.storage.sessions.getSessionModelRoute(input.parentSessionId);
    if (!route) return null;
    const config =
      input.bridgeInput.resolveModelConfig?.(route) ??
      (route.provider === input.bridgeInput.config.providerName &&
      route.name === input.bridgeInput.config.modelName
        ? input.bridgeInput.config
        : null);
    return config?.providerName === route.provider && config.modelName === route.name
      ? config
      : null;
  };
  const receiveAcceptedFollowup = async (
    targetSessionId: string,
    submissionId: string,
  ): Promise<boolean> => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery) return false;
    const receive = () =>
      input.owner.runWithSessionExecution(targetSessionId, async () => {
        const delivery = mail.readFollowupDeliveryForTarget(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        );
        if (!delivery) return false;
        if (delivery.status === 'received') return true;
        const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
        const child = ensureChild(targetSessionId, runtime);
        const event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }> = {
          type: 'agent.mail_accepted',
          messageId: delivery.messageId,
          submissionId,
          senderAgentId: input.parentSessionId,
          targetAgentId: targetSessionId,
          mode: 'trigger_turn',
          source: delivery.source,
          bodyRef: delivery.bodyRef,
          bodyDigest: delivery.bodyDigest,
          followupAdmissionRef: delivery.followupAdmissionRef,
          followupAdmissionDigest: delivery.followupAdmissionDigest,
          sequence: delivery.sequence,
        };
        child.session.commitCrossSessionFollowupReceive(event, {
          kind: 'receive_followup',
          sourceSessionId: input.parentSessionId,
          messageId: delivery.messageId,
          submissionId,
          receivedAtMs: Date.now(),
        });
        const received = mail.readFollowupDeliveryForTarget(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        );
        return received?.status === 'received' && received.messageId === delivery.messageId;
      });
    return activeChildren.has(targetSessionId)
      ? receive()
      : input.enqueueSessionWork(targetSessionId, receive);
  };
  const startAcceptedFollowup = (targetSessionId: string, submissionId: string): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || !targetSessionId || !submissionId || stoppingRecovery) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      const accepted = mail.readFollowupAdmissionForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      if (!accepted) return false;
      const resumedState = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
      if (resumedState?.activeFollowupTurn?.submissionId === submissionId) {
        const resumed = resumedState.activeFollowupTurn;
        const grant = mail.readFollowupGrantForTarget(targetSessionId, resumed.grantRef.artifactId);
        return (
          resumed.sourceSessionId === input.parentSessionId &&
          resumed.targetRunId === resumedState.turn.turnId &&
          resumedState.resourceBudget.status === 'active' &&
          resumedState.resourceBudget.runId === resumed.targetRunId &&
          grant?.ref.integrityIdentifier === resumed.grantDigest
        );
      }
      if (resumedState?.activeFollowupTurn) return false;
      const latestSettled = input.owner.storage.sessions
        .loadEventsStrict(targetSessionId)
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<RuntimeEvent, { type: 'agent.followup_turn_settled' }> =>
            event.type === 'agent.followup_turn_settled' &&
            event.sourceSessionId === input.parentSessionId,
        )
        .at(-1);
      if (latestSettled && latestSettled.submissionId !== submissionId) {
        const funded = input.detachedScope.runInAsyncScope(() =>
          input.owner.runWithSessionExecution(input.parentSessionId, () =>
            mail.readFollowupTerminalForSource(input.parentSessionId, latestSettled.submissionId),
          ),
        );
        if (!funded) return false;
      }
      const pending = mail.readUnroutedFollowupMessage(
        targetSessionId,
        input.parentSessionId,
        submissionId,
        accepted.messageId,
      );
      if (!pending) return false;
      const checkpoint = mail.readChildTerminalCheckpoint(targetSessionId);
      if (!checkpoint) return false;
      const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
      const child = ensureChild(targetSessionId, runtime);
      const state = child.getState();
      if (state.activeFollowupTurn?.submissionId === submissionId) return true;
      if (state.activeFollowupTurn) return false;
      const currentTarget = input.readCurrentTargetPolicyContext?.({
        targetState: state,
        submissionId,
      });
      if (
        !currentTarget ||
        !verifiedTargetFollowupCatalog({ state, ...currentTarget }) ||
        child.getState().revision !== state.revision
      )
        return false;
      const payload = JSON.parse(accepted.admission.canonicalJson) as Record<string, unknown>;
      if (
        (payload.schema !== 'kite.cross-session-followup-admission.v1' &&
          payload.schema !== 'kite.cross-session-followup-admission.v2') ||
        payload.messageId !== accepted.messageId ||
        payload.submissionId !== submissionId ||
        payload.sourceSessionId !== input.parentSessionId ||
        payload.targetSessionId !== targetSessionId ||
        typeof payload.sourceRunId !== 'string' ||
        typeof payload.backupReservationId !== 'string' ||
        typeof payload.fundingRunId !== 'string' ||
        typeof payload.deadlineAt !== 'number' ||
        typeof payload.policy !== 'object' ||
        payload.policy === null ||
        typeof payload.preparedTool !== 'object' ||
        payload.preparedTool === null ||
        typeof payload.executableUpperBound !== 'object' ||
        payload.executableUpperBound === null
      )
        throw new Error('Accepted child followup admission Artifact is invalid.');
      const admission: CrossSessionFollowupAdmission & {
        readonly preparedTool: NonNullable<RootFollowupPolicyEvidence['preparedTool']>;
      } = {
        sourceSessionId: input.parentSessionId,
        targetSessionId,
        sourceRunId: payload.sourceRunId,
        submissionId,
        fundingRunId: payload.fundingRunId,
        backupReservationId: payload.backupReservationId,
        deadlineAt: payload.deadlineAt,
        executableUpperBound:
          payload.executableUpperBound as CrossSessionFollowupAdmission['executableUpperBound'],
        policy: payload.policy as CrossSessionFollowupAdmission['policy'],
        preparedTool: payload.preparedTool as NonNullable<
          RootFollowupPolicyEvidence['preparedTool']
        >,
      };
      const latestPhase = getAgentPhase(runtimeHostStateActivePlanning(state));
      const phaseCeiling =
        admission.policy.phaseCeiling === 'planning' || latestPhase === 'planning'
          ? 'planning'
          : 'building';
      let allowedTools: readonly string[] | undefined;
      if (admission.policy.executionMode === 'independent_turn_v2') {
        const origin = state.childSessionOrigin;
        const sealed = input.detachedScope.runInAsyncScope(() =>
          input.owner.runWithSessionExecution(input.parentSessionId, () =>
            input.owner.readChildSealedGrant(targetSessionId),
          ),
        );
        if (
          !origin ||
          !sealed ||
          sealed.sealedGrantDigest !== origin.grantDigest ||
          admission.policy.targetGrantDigest !== origin.grantDigest ||
          admission.policy.targetRole !== origin.role
        )
          throw new Error('Independent followup has no exact original child grant.');
        const original = JSON.parse(sealed.sealedGrantJson) as SubagentDelegationGrant;
        const originalNames = original.capabilityCeiling.allowedTools;
        if (
          original.role !== origin.role ||
          !Array.isArray(originalNames) ||
          originalNames.some((name) => typeof name !== 'string') ||
          new Set(originalNames).size !== originalNames.length
        )
          throw new Error('Independent followup original Tool ceiling is invalid.');
        const roleNames = getRoleConfig(origin.role).allowedTools;
        const initialCodeAll = origin.role === 'code' && originalNames.length === 0;
        allowedTools = runtime.builtinToolCatalog.entries
          .filter((entry) => entry.visibility === 'model')
          .map((entry) => entry.name)
          .filter(
            (name) =>
              name !== 'task' &&
              (!roleNames || roleNames.has(name)) &&
              (initialCodeAll || originalNames.includes(name)),
          )
          .sort();
        if (allowedTools.length === 0 || new Set(allowedTools).size !== allowedTools.length)
          throw new Error('Independent followup has no explicit role-authorized Tool names.');
        const acquired = input.detachedScope.runInAsyncScope(() =>
          input.owner.runWithSessionExecution(input.parentSessionId, () => {
            const parent = ensureParent();
            const slot = planCrossSessionFollowupSlotAcquisition({
              sourceState: parent.getState(),
              sourceSessionId: input.parentSessionId,
              fundingRunId: admission.fundingRunId,
              submissionId,
              backupReservationId: admission.backupReservationId,
            });
            if (slot.status === 'already_acquired') return true;
            if (slot.status !== 'ready') return false;
            parent.commitChildSlotAcquisition(admission.backupReservationId);
            return true;
          }),
        );
        if (!acquired) return false;
      }
      const plan = planChildFollowupTurn({
        state,
        admission,
        sourceAdmissionRef: accepted.admission.ref,
        sourceAdmissionDigest: accepted.admission.digest,
        checkpoint,
        nowMs: Date.now(),
        ...(allowedTools ? { allowedTools } : {}),
        targetPolicy: {
          workspaceDigest: state.session.canonicalWorkspaceDigest ?? '',
          interactionModeRevision: state.interactionModeRevision,
          capabilityDigest: state.capabilities.catalogRevision,
          phaseCeiling,
        },
      });
      const committed = child.session.commitChildFollowupRunStart(plan.events, plan.mutation);
      return committed.length === plan.events.length;
    });
  };
  const activateIndependentFollowup = (targetSessionId: string, submissionId: string): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    const accepted = mail.readAcceptedIndependentFollowupSourcePolicyProof(
      targetSessionId,
      input.parentSessionId,
      submissionId,
    );
    if (!accepted) return false;
    const target = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
    const active = target?.activeFollowupTurn;
    const grant = active
      ? mail.readFollowupGrantForTarget(targetSessionId, active.grantRef.artifactId)
      : null;
    const current =
      target && input.readCurrentTargetPolicyContext?.({ targetState: target, submissionId });
    if (
      !target ||
      !active ||
      active.submissionId !== submissionId ||
      !grant ||
      grant.ref.integrityIdentifier !== active.grantDigest ||
      !current ||
      !verifiedTargetFollowupCatalog({ state: target, ...current })
    )
      return false;
    const sealed = JSON.parse(grant.canonicalJson) as {
      schema?: string;
      originRole?: 'explore' | 'plan' | 'code' | 'review';
      denyTools?: boolean;
      allowedTools?: string[];
    };
    if (
      sealed.schema !== 'kite.child-followup-grant.v2' ||
      !sealed.originRole ||
      sealed.originRole !== target.childSessionOrigin?.role ||
      sealed.denyTools !== false ||
      !Array.isArray(sealed.allowedTools) ||
      sealed.allowedTools.length === 0
    )
      return false;
    const targetPolicyProof: CrossSessionIndependentTurnPolicyProof = {
      observedTargetRevision: target.revision,
      grantDigest: active.grantDigest,
      capabilityDigest: target.capabilities.catalogRevision,
      interactionModeRevision: target.interactionModeRevision,
      phaseCeiling: getAgentPhase(runtimeHostStateActivePlanning(target)),
      mode: target.mode,
      workspaceAccess: target.workspaceAccess,
      originRole: sealed.originRole,
      denyTools: false,
      allowedTools: sealed.allowedTools,
    };
    const committed = input.detachedScope.runInAsyncScope(() =>
      input.owner.runWithSessionExecution(input.parentSessionId, () => {
        const source = ensureParent();
        const planned = planCrossSessionIndependentTurnActivation({
          fundingState: source.getState(),
          targetState: target,
          admission: accepted.admission as unknown as CrossSessionFollowupAdmission,
          currentPolicy: accepted.policy as unknown as CrossSessionFollowupPolicy,
          targetPolicyProof,
          nowMs: Date.now(),
        });
        if (planned.status === 'already_activated') return true;
        const applied = source.session.commitCrossSessionFollowupFunding([planned.event], {
          kind: 'activate_independent_followup_turn',
          targetSessionId,
          submissionId,
          targetRunId: active.targetRunId,
          grantDigest: active.grantDigest,
          targetRevision: target.revision,
          createdAtMs: Date.now(),
        });
        return applied.length === 1;
      }),
    );
    return (
      committed &&
      mail.readIndependentFollowupActivationForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      ) !== null
    );
  };
  const assertCurrentSourceFollowupPolicy = (
    source: Readonly<RuntimeState>,
    admission: CrossSessionFollowupAdmission & {
      preparedTool?: RootFollowupPolicyEvidence['preparedTool'];
    },
    messageId: string,
    submissionId: string,
  ): CrossSessionFollowupPolicy => {
    const policy = admission.policy;
    const context = input.readCurrentSourceFollowupContext?.({
      sourceState: source,
      submissionId,
    });
    const originalTool = admission.preparedTool;
    const storedCall = originalTool && source.tools.calls[originalTool.toolCallId];
    const outbox = input.owner.storage.crossSessionQueueMail?.readOutbox(
      input.parentSessionId,
      messageId,
    );
    const sourceModel = outbox && source.modelInvocations[outbox.sourceModelInvocationId];
    const sourceConfig = sourceModelConfig();
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    const sourceSurface =
      sourceModel?.surfaceArtifact && runtime.artifacts.readSurface(sourceModel.surfaceArtifact);
    const pipeline = runtime.toolPipelineComposition;
    if (
      !context ||
      !originalTool ||
      !storedCall ||
      !pipeline ||
      !outbox ||
      outbox.sourceToolCallId !== originalTool.toolCallId ||
      !sourceModel ||
      sourceModel.status !== 'completed' ||
      !sourceConfig ||
      !sourceSurface ||
      sourceSurface.route.routeFingerprint !== sourceModel.routeFingerprint ||
      sourceSurface.route.routeFingerprint !==
        computeProviderEndpointIdentityDigest(providerRouteIdentityFromModelConfig(sourceConfig))
    )
      throw new Error('Current source TriggerTurn policy cannot be independently verified.');
    const call = {
      schema: TOOL_PIPELINE_STAGE_SCHEMA_,
      stage: 'snapshot' as const,
      toolCallId: storedCall.toolCallId,
      name: storedCall.name,
      rawArguments: storedCall.args as RuntimeJsonValue,
      argumentOrigin: 'model_public' as const,
      createdAtTurnId: storedCall.createdAtTurnId,
      modelMessageId: storedCall.modelMessageId,
      bindingId: null,
      capabilityId: null,
      capabilityRevision: null,
    };
    const classified = currentSourceFollowupPolicy({
      state: source,
      settledCall: call,
      admitted: { ...policy, preparedTool: originalTool },
      config: sourceConfig,
      pipeline,
      ...context,
    });
    if (!classified.ok)
      throw new Error('Current source TriggerTurn policy proof is stale or wider.');
    const currentModelCeiling = sourceConfig.modelCapabilities;
    if (
      currentModelCeiling?.contextWindowTokens !== policy.contextWindowTokens ||
      currentModelCeiling.maxOutputTokens !== policy.maxOutputTokens
    )
      throw new Error('Current source Model context ceiling cannot be verified.');
    const currentPolicy: CrossSessionFollowupPolicy = {
      ...policy,
      capabilityDigest: classified.proof.catalogRevision,
      workspaceDigest: source.session.canonicalWorkspaceDigest ?? '',
      interactionModeRevision: source.interactionModeRevision,
      phaseCeiling: classified.proof.phase,
    };
    if (
      source.session.canonicalWorkspaceDigest !== policy.workspaceDigest ||
      source.capabilities.catalogRevision !== policy.capabilityDigest ||
      source.interactionModeRevision !== policy.interactionModeRevision ||
      getAgentPhase(runtimeHostStateActivePlanning(source)) !== policy.phaseCeiling
    )
      throw new Error('Source TriggerTurn policy changed before routing.');
    return currentPolicy;
  };
  const replaceFollowupBackup = (inputProof: {
    targetSessionId: string;
    submissionId: string;
    messageId: string;
    admission: CrossSessionFollowupAdmission;
    targetState: Readonly<RuntimeState>;
    modelInvocationId: string;
    modelRuntime: ReturnType<typeof input.modelRuntimeFactory>;
  }): void => {
    const model = inputProof.targetState.modelInvocations[inputProof.modelInvocationId];
    const mail = input.owner.storage.crossSessionQueueMail;
    const followup = inputProof.targetState.activeFollowupTurn;
    const storedGrant =
      followup &&
      mail?.readFollowupGrantForTarget(inputProof.targetSessionId, followup.grantRef.artifactId);
    const targetContext = input.readCurrentTargetPolicyContext?.({
      targetState: inputProof.targetState,
      submissionId: inputProof.submissionId,
    });
    if (
      !followup ||
      followup.submissionId !== inputProof.submissionId ||
      !storedGrant ||
      storedGrant.ref.integrityIdentifier !== followup.grantDigest ||
      !targetContext ||
      !verifiedTargetFollowupCatalog({ state: inputProof.targetState, ...targetContext })
    )
      throw new Error('Current child followup grant or catalog proof is unavailable.');
    const grant = JSON.parse(storedGrant.canonicalJson) as {
      grantDigest?: unknown;
      capabilityDigest?: unknown;
      interactionModeRevision?: unknown;
      phaseCeiling?: unknown;
      workspaceDigest?: unknown;
      denyTools?: unknown;
      allowedTools?: unknown;
    };
    if (
      grant.capabilityDigest !== inputProof.targetState.capabilities.catalogRevision ||
      grant.interactionModeRevision !== inputProof.targetState.interactionModeRevision ||
      grant.phaseCeiling !==
        getAgentPhase(runtimeHostStateActivePlanning(inputProof.targetState)) ||
      grant.workspaceDigest !== inputProof.targetState.session.canonicalWorkspaceDigest ||
      grant.denyTools !== true ||
      !Array.isArray(grant.allowedTools) ||
      grant.allowedTools.length !== 0
    )
      throw new Error('Current child followup policy exceeds its sealed grant.');
    const targetPolicyProof: CrossSessionTargetFollowupPolicyProof = {
      observedTargetRevision: inputProof.targetState.revision,
      grantDigest: followup.grantDigest,
      capabilityDigest: inputProof.targetState.capabilities.catalogRevision,
      interactionModeRevision: inputProof.targetState.interactionModeRevision,
      phaseCeiling: grant.phaseCeiling as 'planning' | 'building',
      mode: inputProof.targetState.mode,
      workspaceAccess: inputProof.targetState.workspaceAccess,
      denyTools: true,
      allowedTools: [],
    };
    const estimate = model?.estimatedInputTokens;
    if (
      model?.status !== 'prepared' ||
      model.attempts !== 0 ||
      !Number.isSafeInteger(estimate) ||
      (estimate ?? -1) < 0 ||
      model.budget.kind !== 'reservation'
    )
      throw new Error('Child followup has no exact frozen first Model Surface.');
    const surface = inputProof.modelRuntime.artifacts.readSurface(model.surfaceArtifact);
    const maxOutputTokens = surface.request.maxOutputTokens;
    if (!Number.isSafeInteger(maxOutputTokens) || Number(maxOutputTokens) < 1)
      throw new Error('Child followup Surface has no bounded output ceiling.');
    input.detachedScope.runInAsyncScope(() =>
      input.owner.runWithSessionExecution(input.parentSessionId, () => {
        const parent = ensureParent();
        const slot = planCrossSessionFollowupSlotAcquisition({
          sourceState: parent.getState(),
          sourceSessionId: input.parentSessionId,
          fundingRunId: inputProof.admission.fundingRunId,
          submissionId: inputProof.submissionId,
          backupReservationId: inputProof.admission.backupReservationId,
        });
        if (slot.status === 'waiting') throw new Error('Child followup slot is still occupied.');
        if (slot.status === 'ready')
          parent.commitChildSlotAcquisition(inputProof.admission.backupReservationId);
        const source = parent.getState();
        const currentPolicy = assertCurrentSourceFollowupPolicy(
          source,
          inputProof.admission,
          inputProof.messageId,
          inputProof.submissionId,
        );
        if (parent.getState().revision !== source.revision)
          throw new Error('Current source TriggerTurn policy proof became stale.');
        const planned = planCrossSessionFirstModelReplacement({
          fundingState: source,
          targetState: inputProof.targetState,
          admission: inputProof.admission,
          receipt: { status: 'missing' },
          requestDigest: inputProof.submissionId,
          frozenSurface: {
            invocationId: inputProof.modelInvocationId,
            artifactId: model.surfaceArtifact.artifactId,
            integrityIdentifier: model.surfaceArtifact.integrityIdentifier,
            inputTokens: estimate!,
            maxOutputTokens: Number(maxOutputTokens),
            verified: true,
          },
          currentPolicy,
          targetPolicyProof,
          nowMs: Date.now(),
        });
        if (planned.status !== 'planned')
          throw new Error('Child followup source funding receipt conflicted.');
        parent.session.commitCrossSessionFollowupFunding(planned.plan.preparationEvents, {
          kind: 'replace_followup_backup',
          targetSessionId: inputProof.targetSessionId,
          messageId: inputProof.messageId,
          submissionId: inputProof.submissionId,
          targetRunId: inputProof.targetState.turn.turnId,
          modelInvocationId: inputProof.modelInvocationId,
          targetRevision: inputProof.targetState.revision,
          surfaceArtifact: model.surfaceArtifact,
          surfaceInputTokens: estimate!,
          surfaceMaxOutputTokens: Number(maxOutputTokens),
          createdAtMs: Date.now(),
        });
      }),
    );
  };
  const replacePreparedFollowupBackup = (
    targetSessionId: string,
    submissionId: string,
  ): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery || !input.readCurrentSourceFollowupContext) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      const accepted = mail.readFollowupAdmissionForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      if (!accepted) return false;
      if (mail.readFollowupFundingForTarget(targetSessionId, input.parentSessionId, submissionId))
        return true;
      const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
      const child = ensureChild(targetSessionId, runtime);
      const targetState = child.getState();
      if (targetState.activeFollowupTurn?.submissionId !== submissionId) return false;
      const prepared = Object.values(targetState.modelInvocations).filter(
        (item) =>
          item.status === 'prepared' &&
          item.preparedStateRevision >= 0 &&
          item.budget.kind === 'reservation' &&
          targetState.resourceBudget.status === 'active' &&
          targetState.resourceBudget.runId === targetState.activeFollowupTurn?.targetRunId &&
          targetState.resourceBudget.reservations[item.budget.reservationId] !== undefined,
      );
      if (prepared.length !== 1) return false;
      const payload = JSON.parse(
        accepted.admission.canonicalJson,
      ) as CrossSessionFollowupAdmission & {
        schema?: string;
      };
      if (payload.schema !== 'kite.cross-session-followup-admission.v1') return false;
      replaceFollowupBackup({
        targetSessionId,
        submissionId,
        messageId: accepted.messageId,
        admission: payload,
        targetState,
        modelInvocationId: prepared[0]!.invocationId,
        modelRuntime: runtime,
      });
      return (
        mail.readFollowupFundingForTarget(targetSessionId, input.parentSessionId, submissionId) !==
        null
      );
    });
  };
  const routePreparedFollowup = (targetSessionId: string, submissionId: string): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      if (mail.readFollowupRoute(targetSessionId, submissionId)) return true;
      const accepted = mail.readFollowupAdmissionForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      const funding = mail.readFollowupFundingForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      if (!accepted || !funding || funding.messageId !== accepted.messageId) return false;
      const message = mail.readUnroutedFollowupMessage(
        targetSessionId,
        input.parentSessionId,
        submissionId,
        accepted.messageId,
      );
      if (!message) return false;
      const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
      const child = ensureChild(targetSessionId, runtime);
      const state = child.getState();
      const followup = state.activeFollowupTurn;
      const model = state.modelInvocations[funding.modelInvocationId];
      if (
        followup?.submissionId !== submissionId ||
        followup.targetRunId !== funding.targetRunId ||
        model?.status !== 'prepared' ||
        model.budget.kind !== 'reservation' ||
        model.budget.reservationId !== funding.targetModelReservationId
      )
        return false;
      const reservationId = funding.targetModelReservationId;
      const routed: Extract<RuntimeEvent, { type: 'agent.followup_routed' }> = {
        type: 'agent.followup_routed',
        submissionId,
        targetAgentId: targetSessionId,
        route: 'new_turn',
        taskId: followup.taskId,
        invocationId: funding.modelInvocationId,
        modelAdmissionId: reservationId,
        reservationId,
        fundingRunId: funding.fundingRunId,
        sequence: message.sequence,
      };
      const prepared: Extract<RuntimeEvent, { type: 'agent.mail_input_prepared' }> = {
        type: 'agent.mail_input_prepared',
        targetAgentId: targetSessionId,
        invocationId: funding.modelInvocationId,
        modelAdmissionId: reservationId,
        fromSequence: message.sequence - 1,
        throughSequence: message.sequence,
        messageIds: [accepted.messageId],
      };
      const committed = child.session.commitCrossSessionFollowupRoute([routed, prepared], {
        kind: 'route_followup',
        sourceSessionId: input.parentSessionId,
        messageId: accepted.messageId,
        submissionId,
        route: 'new_turn',
        targetRunId: funding.targetRunId,
        taskId: followup.taskId,
        invocationId: funding.modelInvocationId,
        modelAdmissionId: reservationId,
        reservationId,
        createdAtMs: Date.now(),
      });
      return committed.length === 2;
    });
  };
  const routePreparedIndependentFollowup = (
    targetSessionId: string,
    submissionId: string,
  ): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      if (mail.readFollowupRoute(targetSessionId, submissionId)) return true;
      const accepted = mail.readFollowupAdmissionForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      const message = accepted
        ? mail.readUnroutedFollowupMessage(
            targetSessionId,
            input.parentSessionId,
            submissionId,
            accepted.messageId,
          )
        : null;
      const state = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
      const followup = state?.activeFollowupTurn;
      const models = state
        ? Object.values(state.modelInvocations).filter(
            (item) =>
              item.status === 'prepared' &&
              item.attempts === 0 &&
              item.purpose === 'primary_agent' &&
              item.budget.kind === 'reservation' &&
              state.resourceBudget.status === 'active' &&
              state.resourceBudget.reservations[item.budget.reservationId]?.resourceKind ===
                'model',
          )
        : [];
      if (
        !accepted ||
        !message ||
        !state ||
        !followup ||
        followup.submissionId !== submissionId ||
        models.length !== 1 ||
        state.resourceBudget.status !== 'active'
      )
        return false;
      const model = models[0]!;
      if (model.budget.kind !== 'reservation') return false;
      const reservationId = model.budget.reservationId;
      const admission = JSON.parse(accepted.admission.canonicalJson) as {
        fundingRunId?: string;
        schema?: string;
      };
      if (
        admission.schema !== 'kite.cross-session-followup-admission.v2' ||
        !admission.fundingRunId
      )
        return false;
      const routed: Extract<RuntimeEvent, { type: 'agent.followup_routed' }> = {
        type: 'agent.followup_routed',
        submissionId,
        targetAgentId: targetSessionId,
        route: 'new_turn',
        taskId: followup.taskId,
        invocationId: model.invocationId,
        modelAdmissionId: reservationId,
        reservationId,
        fundingRunId: admission.fundingRunId,
        sequence: message.sequence,
      };
      const prepared: Extract<RuntimeEvent, { type: 'agent.mail_input_prepared' }> = {
        type: 'agent.mail_input_prepared',
        targetAgentId: targetSessionId,
        invocationId: model.invocationId,
        modelAdmissionId: reservationId,
        fromSequence: message.sequence - 1,
        throughSequence: message.sequence,
        messageIds: [accepted.messageId],
      };
      const child = ensureChild(
        targetSessionId,
        input.modelRuntimeFactory(input.bridgeInput.workspace),
      );
      const committed = child.session.commitCrossSessionFollowupRoute([routed, prepared], {
        kind: 'route_followup',
        sourceSessionId: input.parentSessionId,
        messageId: accepted.messageId,
        submissionId,
        route: 'new_turn',
        targetRunId: followup.targetRunId,
        taskId: followup.taskId,
        invocationId: model.invocationId,
        modelAdmissionId: reservationId,
        reservationId,
        createdAtMs: Date.now(),
      });
      return committed.length === 2;
    });
  };
  const activateRoutedFollowup = (targetSessionId: string, submissionId: string): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      if (
        mail.readFollowupActivationForTarget(targetSessionId, input.parentSessionId, submissionId)
      )
        return true;
      const route = mail.readFollowupRoute(targetSessionId, submissionId);
      const funding = mail.readFollowupFundingForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      if (
        !route ||
        !funding ||
        route.route !== 'new_turn' ||
        route.targetRunId !== funding.targetRunId ||
        route.invocationId !== funding.modelInvocationId
      )
        return false;
      input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(input.parentSessionId, () => {
          const parent = ensureParent();
          parent.session.commitCrossSessionFollowupFunding(
            [
              {
                type: 'resource_budget.dispatch_started',
                reservationId: funding.turnReservationId,
              },
              {
                type: 'resource_budget.dispatch_started',
                reservationId: funding.modelReservationId,
              },
            ],
            {
              kind: 'activate_followup_funding',
              targetSessionId,
              submissionId,
              targetRunId: funding.targetRunId,
              modelInvocationId: funding.modelInvocationId,
              createdAtMs: Date.now(),
            },
          );
        }),
      );
      return (
        mail.readFollowupActivationForTarget(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        ) !== null
      );
    });
  };
  const continueIndependentFollowup = async (
    targetSessionId: string,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    const config = targetModelConfig(targetSessionId);
    if (!config) return false;
    const child = ensureChild(targetSessionId, runtime);
    const state = child.getState();
    const followup = state.activeFollowupTurn;
    const taskId = state.childSessionOrigin?.childInvocationId;
    if (!followup || followup.submissionId !== submissionId || !taskId) return false;
    const stored = mail.readFollowupGrantForTarget(targetSessionId, followup.grantRef.artifactId);
    const grant = stored
      ? (JSON.parse(stored.canonicalJson) as {
          schema?: string;
          originRole?: string;
          allowedTools?: string[];
        })
      : null;
    if (
      stored?.ref.integrityIdentifier !== followup.grantDigest ||
      grant?.schema !== 'kite.child-followup-grant.v2' ||
      grant.originRole !== state.childSessionOrigin?.role ||
      !Array.isArray(grant.allowedTools) ||
      grant.allowedTools.length === 0
    )
      return false;
    const original = input.detachedScope.runInAsyncScope(() =>
      input.owner.runWithSessionExecution(input.parentSessionId, () =>
        input.owner.readChildSealedGrant(targetSessionId),
      ),
    );
    const originalGrant = original
      ? (JSON.parse(original.sealedGrantJson) as SubagentDelegationGrant)
      : null;
    if (
      !original ||
      !originalGrant ||
      original.sealedGrantDigest !== state.childSessionOrigin?.grantDigest ||
      originalGrant.role !== state.childSessionOrigin.role
    )
      return false;
    const approvals = [...state.pendingApprovals.values()].filter((approval) => {
      const tool = state.tools.calls[approval.toolCallId];
      return tool && ['awaiting_approval', 'authorized_queued', 'rejected'].includes(tool.status);
    });
    if (approvals.length > 1) return false;
    const approval = approvals[0];
    if (approval) {
      const proxyId = input.owner.childApprovalProxyId({
        childThreadId: targetSessionId,
        childInteractionId: approval.interactionId,
        childGeneration: approval.generation,
      });
      const source = input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(input.parentSessionId, () => ({
          state: ensureParent().getState(),
          proxy: input.owner.readChildApprovalProxy(input.parentSessionId, proxyId),
        })),
      );
      if (!source.proxy) return false;
      const classified = classifyChildApprovalRecovery({
        parentState: source.state,
        childState: state,
        proxy: source.proxy,
      });
      if (classified.kind === 'recovery_required') return false;
      if (classified.kind === 'wait_for_parent') approvalProxy.publishRequested(source.proxy);
      if (classified.kind === 'apply_parent_decision') {
        approvalProxy.publishDecided(proxyId);
        approvalProxy.activateDecision(proxyId);
      }
    }
    child.session.activateRun(followup.targetRunId);
    const identity = { runId: followup.targetRunId, taskId };
    for await (const event of child.executeTurn(
      {
        ...childTurnFor(child.getState(), runtime, signal ?? new AbortController().signal),
        config,
        model: createChatModel(config),
        task: '',
        initialSkillActivations: [],
        resumeCommittedInteraction: true,
        childToolCeiling: {
          grantDigest: followup.grantDigest,
          role: state.childSessionOrigin.role,
          allowedTools: grant.allowedTools,
        },
        crossSessionChildIdentity: {
          parentSessionId: input.parentSessionId,
          taskId,
          grantId: originalGrant.grantId,
          grantDigest: state.childSessionOrigin.grantDigest,
        },
      },
      createChildApprovalActionProvider({
        owner: input.owner,
        parentSessionId: input.parentSessionId,
        proxyOwner: approvalProxy,
        signal: signal ?? new AbortController().signal,
        onProxyOpened: (opened) => approvalProxy.publishRequested(opened),
      }),
    )) {
      const revision = child.revisionForEvent?.(event);
      if (revision === undefined) publishChildPresentation(child, event, identity);
      else publishChildCommittedThrough(child, revision, identity);
    }
    await child.waitForIdle();
    const terminal = child.getState();
    if (terminal.turn.status !== 'completed' || terminal.terminalOutcome?.status !== 'completed')
      return false;
    if (
      !child.session.commitChildFollowupTurnSettlement({
        type: 'agent.followup_turn_settled',
        sourceSessionId: input.parentSessionId,
        submissionId,
        targetRunId: followup.targetRunId,
        taskId: followup.taskId,
        status: 'completed',
      }).length
    )
      return false;
    if (!settleTerminalFollowupFunding(targetSessionId, submissionId)) return false;
    clearSettledChildStream(child, followup.targetRunId);
    return true;
  };
  const executeAcceptedFollowupFirstModel = async (
    targetSessionId: string,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery) return false;
    return input.enqueueSessionWork(targetSessionId, () =>
      input.owner.runWithSessionExecution(targetSessionId, async () => {
        if (!startAcceptedFollowup(targetSessionId, submissionId)) return false;
        const accepted = mail.readFollowupAdmissionForTarget(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        );
        if (!accepted) return false;
        const message = mail.readUnroutedFollowupMessage(
          targetSessionId,
          input.parentSessionId,
          submissionId,
          accepted.messageId,
        );
        if (!message) return false;
        const frame = createAgentMessageContextFrame({
          messageId: accepted.messageId,
          senderAgentId: input.parentSessionId,
          ...(message.sourceTaskId ? { sourceTaskId: message.sourceTaskId } : {}),
          body: message.bodyText,
        });
        const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
        const config = targetModelConfig(targetSessionId);
        if (!config) throw new Error('Child followup target Model route is unavailable.');
        const child = ensureChild(targetSessionId, runtime);
        const state = child.getState();
        const followup = state.activeFollowupTurn;
        if (!followup || followup.submissionId !== submissionId) return false;
        const taskId = state.childSessionOrigin?.childInvocationId;
        if (!taskId) throw new Error('Child followup has no origin identity.');
        const storedGrant = mail.readFollowupGrantForTarget(
          targetSessionId,
          followup.grantRef.artifactId,
        );
        if (!storedGrant || storedGrant.ref.integrityIdentifier !== followup.grantDigest)
          throw new Error('Child followup fresh grant is unavailable.');
        const grant = JSON.parse(storedGrant.canonicalJson) as {
          schema?: string;
          originRole?: string;
          denyTools?: boolean;
          allowedTools?: string[];
          firstAttemptTimeoutMs?: number;
        };
        if (grant.schema === 'kite.child-followup-grant.v2') {
          if (
            grant.originRole !== state.childSessionOrigin?.role ||
            grant.denyTools !== false ||
            !Array.isArray(grant.allowedTools) ||
            grant.allowedTools.length === 0 ||
            grant.allowedTools.some((name) => !name || name === 'task') ||
            !Number.isSafeInteger(grant.firstAttemptTimeoutMs) ||
            !activateIndependentFollowup(targetSessionId, submissionId)
          )
            throw new Error('Independent followup has no activated role-bound grant.');
          child.session.activateRun(followup.targetRunId);
          const persistence = Object.freeze({
            getState: () => child.getState(),
            persistEvents: async (events: RuntimeEvent[]): Promise<boolean> => {
              if (events.length === 0) return true;
              const prepared = events.filter((event) => event.type === 'model.invocation_prepared');
              if (prepared.length > 1) return false;
              if (
                events.some((event) => event.type === 'model.invocation_attempt_started') &&
                (mail.readIndependentFollowupActivationForTarget(
                  targetSessionId,
                  input.parentSessionId,
                  submissionId,
                ) === null ||
                  mail.readFollowupRoute(targetSessionId, submissionId)?.route !== 'new_turn')
              )
                return false;
              const applied = child.session.processEventBatch(events);
              if (applied.length !== events.length) return false;
              if (prepared.length === 1)
                return routePreparedIndependentFollowup(targetSessionId, submissionId);
              return true;
            },
          });
          const identity = { runId: followup.targetRunId, taskId };
          try {
            const modeled = await projectPrimaryModelEffect({
              model: createChatModel(config),
              state: child.getState() as RuntimeState,
              config,
              builtinToolCatalog: runtime.builtinToolCatalog,
              modelEffectCoordinator: runtime.modelEffects,
              modelInvocationPersistence: persistence,
              delegatedTaskArtifacts: runtime.delegatedTaskArtifacts,
              childToolCeiling: {
                grantDigest: followup.grantDigest,
                role: state.childSessionOrigin!.role,
                allowedTools: grant.allowedTools,
              },
              firstAttemptTimeoutMs: grant.firstAttemptTimeoutMs,
              prepareAgentMail: async () => ({
                frames: [
                  humanMessage({
                    id: frame.messageId,
                    name: 'agent_message',
                    content: frame.content,
                    response_metadata: { source: 'agent_message' },
                  }),
                ],
              }),
              emitRuntimeEvent: (event) => {
                if (
                  event.type === 'model.text_delta' ||
                  event.type === 'model.reasoning_delta' ||
                  event.type === 'model.reasoning_completed'
                ) {
                  publishChildPresentation(child, event, identity);
                  return;
                }
                throw new Error('Independent followup Model emitted an uncommitted event.');
              },
              signal,
            });
            if (modeled.length !== 0)
              throw new Error('Independent followup Model returned uncommitted events.');
            if (completeFollowupTurn(child, followup, targetSessionId, submissionId)) {
              publishChildCommittedThrough(child, child.getState().revision, identity);
              clearSettledChildStream(child, followup.targetRunId);
              return true;
            }
            if (child.getState().turn.status !== 'active')
              throw new Error('Independent followup terminal funding was not acknowledged.');
            return continueIndependentFollowup(targetSessionId, submissionId, signal);
          } catch (error) {
            if (markAttemptedFollowupUnknown(targetSessionId, submissionId)) return false;
            if (!signal?.aborted && markUnattemptedFollowupFailed(targetSessionId, submissionId))
              return false;
            throw error;
          }
        }
        if (
          grant.originRole !== state.childSessionOrigin?.role ||
          grant.denyTools !== true ||
          !Array.isArray(grant.allowedTools) ||
          grant.allowedTools.length !== 0 ||
          !Number.isSafeInteger(grant.firstAttemptTimeoutMs) ||
          (grant.firstAttemptTimeoutMs ?? 0) < 1
        )
          throw new Error('Child followup grant does not deny every Tool.');
        child.session.activateRun(followup.targetRunId);
        const persistence = Object.freeze({
          getState: () => child.getState(),
          persistEvents: async (events: RuntimeEvent[]): Promise<boolean> => {
            if (events.length === 0) return true;
            const prepared = events.filter(
              (event): event is Extract<RuntimeEvent, { type: 'model.invocation_prepared' }> =>
                event.type === 'model.invocation_prepared',
            );
            if (prepared.length > 1 || events.some((event) => event.type === 'tool.queued'))
              return false;
            if (prepared.length === 1) {
              if (
                prepared[0]!.purpose !== 'primary_agent' ||
                prepared[0]!.budget.kind !== 'reservation' ||
                child.getState().activeFollowupTurn?.submissionId !== submissionId
              )
                return false;
              if (child.session.processEventBatch(events).length !== events.length) return false;
              const funded =
                replacePreparedFollowupBackup(targetSessionId, submissionId) &&
                routePreparedFollowup(targetSessionId, submissionId) &&
                activateRoutedFollowup(targetSessionId, submissionId);
              return funded;
            }
            if (events.some((event) => event.type === 'model.invocation_attempt_started')) {
              const proof = mail.readPreparedFollowupRecoveryProof(
                targetSessionId,
                input.parentSessionId,
                submissionId,
              );
              const attempted = events.find(
                (event) => event.type === 'model.invocation_attempt_started',
              );
              if (
                !proof ||
                !attempted ||
                proof.invocationId !== attempted.invocationId ||
                proof.preparedStateRevision !== child.getState().revision ||
                !events.some(
                  (event) =>
                    event.type === 'resource_budget.dispatch_started' &&
                    event.reservationId === proof.modelReservationId,
                )
              )
                return false;
            }
            const applied = child.session.processEventBatch(events);
            const durable = (batch: readonly RuntimeEvent[]) =>
              batch
                .filter(
                  (event) =>
                    event.type !== 'model.cache_metrics' && event.type !== 'model.context_metrics',
                )
                .map((event) =>
                  event.type === 'model.responded' ? { ...event, createdAt: undefined } : event,
                );
            // Metrics can be idempotent replays; the Host also normalizes responded.createdAt.
            return JSON.stringify(durable(applied)) === JSON.stringify(durable(events));
          },
        });
        try {
          const modeled = await projectPrimaryModelEffect({
            model: createChatModel(config),
            state: child.getState() as RuntimeState,
            config,
            builtinToolCatalog: runtime.builtinToolCatalog,
            modelEffectCoordinator: runtime.modelEffects,
            modelInvocationPersistence: persistence,
            delegatedTaskArtifacts: runtime.delegatedTaskArtifacts,
            childToolCeiling: {
              grantDigest: followup.grantDigest,
              role: state.childSessionOrigin!.role,
              allowedTools: [],
              denyTools: true,
            },
            firstAttemptTimeoutMs: grant.firstAttemptTimeoutMs,
            prepareAgentMail: async () => ({
              frames: [
                humanMessage({
                  id: frame.messageId,
                  name: 'agent_message',
                  content: frame.content,
                  response_metadata: { source: 'agent_message' },
                }),
              ],
            }),
            emitRuntimeEvent: (event) => {
              if (
                event.type === 'model.text_delta' ||
                event.type === 'model.reasoning_delta' ||
                event.type === 'model.reasoning_completed'
              ) {
                publishChildPresentation(child, event, { runId: followup.targetRunId, taskId });
                return;
              }
              throw new Error('Child followup first Model catalog changed before its Surface.');
            },
            signal,
          });
          if (modeled.length !== 0)
            throw new Error('Child followup first Model returned an uncommitted result.');
          const completed = completeFollowupTurn(child, followup, targetSessionId, submissionId);
          publishChildCommittedThrough(child, child.getState().revision, {
            runId: followup.targetRunId,
            taskId,
          });
          clearSettledChildStream(child, followup.targetRunId);
          return completed;
        } catch (error) {
          if (markAttemptedFollowupUnknown(targetSessionId, submissionId)) return false;
          if (!signal?.aborted && markUnattemptedFollowupFailed(targetSessionId, submissionId))
            return false;
          throw error;
        }
      }),
    );
  };
  const completeFollowupTurn = (
    child: ReturnType<typeof ensureChild>,
    followup: NonNullable<RuntimeState['activeFollowupTurn']>,
    targetSessionId: string,
    submissionId: string,
  ): boolean => {
    const completedState = child.getState();
    if (
      completedState.activeFollowupTurn?.submissionId !== submissionId ||
      completedState.turn.turnId !== followup.targetRunId ||
      completedState.turn.status !== 'active' ||
      completedState.resourceBudget.status !== 'active' ||
      completedState.resourceBudget.runId !== followup.targetRunId
    )
      return false;
    const completedModels = Object.values(completedState.modelInvocations).filter((model) => {
      if (model.purpose !== 'primary_agent' || model.budget.kind !== 'reservation') return false;
      const reservation = completedState.resourceBudget.reservations[model.budget.reservationId];
      return reservation?.runId === followup.targetRunId && reservation.resourceKind === 'model';
    });
    if (completedModels.length !== 1) return false;
    const model = completedModels[0]!;
    const reservation =
      completedState.resourceBudget.reservations[
        model.budget.kind === 'reservation' ? model.budget.reservationId : ''
      ];
    if (
      model.status !== 'completed' ||
      !model.responseArtifact ||
      reservation?.state !== 'reconciled' ||
      !completedState.transcript.messages.some(
        (message) =>
          message.kind === 'assistant' &&
          message.turnId === followup.targetRunId &&
          message.modelInvocationId === model.invocationId &&
          message.toolCalls.length === 0,
      )
    )
      return false;
    const decision = runtimeHostStateDecideCompletion(completedState);
    if (decision.status !== 'accepted') return false;
    const terminal: Extract<RuntimeEvent, { type: 'run.completed' }> = {
      type: 'run.completed',
      turnId: followup.targetRunId,
      output: completedState.transcript.final ?? '',
      completionGuardVersion: decision.version,
      ...(decision.version === 'completion_guard_v2'
        ? { planIdentity: decision.planIdentity }
        : {}),
      outcome: completedTerminalOutcome(),
    };
    const turn: Extract<RuntimeEvent, { type: 'turn.completed' }> = {
      type: 'turn.completed',
      turnId: followup.targetRunId,
    };
    if (child.session.processEventBatch([terminal, turn]).length !== 2) return false;
    if (
      child.session.commitChildFollowupTurnSettlement({
        type: 'agent.followup_turn_settled',
        sourceSessionId: input.parentSessionId,
        submissionId,
        targetRunId: followup.targetRunId,
        taskId: followup.taskId,
        status: 'completed',
      }).length !== 1
    )
      return false;
    return settleTerminalFollowupFunding(targetSessionId, submissionId);
  };
  const resumePreparedFollowupFirstModel = async (
    targetSessionId: string,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery) return false;
    return input.enqueueSessionWork(targetSessionId, () =>
      input.owner.runWithSessionExecution(targetSessionId, async () => {
        const proof = mail.readPreparedFollowupRecoveryProof(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        );
        if (!proof) return false;
        const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
        const config = targetModelConfig(targetSessionId);
        if (!config) throw new Error('Child followup target Model route is unavailable.');
        const child = ensureChild(targetSessionId, runtime);
        const state = child.getState();
        const followup = state.activeFollowupTurn;
        const prepared = state.modelInvocations[proof.invocationId];
        const grant = followup
          ? mail.readFollowupGrantForTarget(targetSessionId, followup.grantRef.artifactId)
          : null;
        const grantPayload = grant
          ? (JSON.parse(grant.canonicalJson) as { firstAttemptTimeoutMs?: number })
          : null;
        if (
          !followup ||
          followup.submissionId !== submissionId ||
          followup.targetRunId !== proof.targetRunId ||
          !prepared ||
          !grant ||
          grant.ref.integrityIdentifier !== followup.grantDigest ||
          !Number.isSafeInteger(grantPayload?.firstAttemptTimeoutMs) ||
          (grantPayload?.firstAttemptTimeoutMs ?? 0) < 1
        )
          return false;
        const persistence: ModelInvocationPersistence<RuntimeState, RuntimeEvent> = {
          getState: () => child.getState() as RuntimeState,
          persistEvents: async (events) => {
            if (events.length === 0) return true;
            if (events.some((event) => event.type === 'tool.queued')) return false;
            if (events.some((event) => event.type === 'model.invocation_attempt_started')) {
              const current = mail.readPreparedFollowupRecoveryProof(
                targetSessionId,
                input.parentSessionId,
                submissionId,
              );
              if (!current || current.preparedStateRevision !== child.getState().revision)
                return false;
            }
            return child.session.processEventBatch(events).length === events.length;
          },
        };
        const startedAt = Date.now();
        try {
          const pending = await resumeBuiltinPreparedPrimaryModelEffect(runtime.gateway, {
            model: createChatModel(config),
            persistence,
            invocationId: proof.invocationId,
            expectedStateRevision: proof.preparedStateRevision,
            expectedTurnId: proof.targetRunId,
            expectedRouteFingerprint: prepared.routeFingerprint,
            surfaceArtifact: proof.surfaceRef,
            surfaceIntegrityIdentifier: proof.surfaceDigest,
            hardAttemptTimeoutMs: grantPayload!.firstAttemptTimeoutMs!,
            beforeDispatch: async (identity) => {
              const current = mail.readPreparedFollowupRecoveryProof(
                targetSessionId,
                input.parentSessionId,
                submissionId,
              );
              return Boolean(
                current &&
                  current.invocationId === identity.invocationId &&
                  identity.sessionId === targetSessionId &&
                  current.targetRunId === identity.turnId &&
                  current.modelReservationId === identity.reservationId &&
                  current.preparedStateRevision === identity.observedStateRevision &&
                  prepared.preparedStateRevision === identity.preparedStateRevision &&
                  current.surfaceRef.artifactId === identity.surfaceArtifact.artifactId &&
                  current.surfaceRef.byteLength === identity.surfaceArtifact.byteLength &&
                  current.surfaceDigest === identity.surfaceIntegrityIdentifier,
              );
            },
            signal,
          });
          await pending.commitWith((normalized) => {
            const response = normalizedModelResponseToAIMessage(normalized);
            if (
              normalized.finishReason !== 'stop' ||
              (response.tool_calls?.length ?? 0) !== 0 ||
              typeof response.content !== 'string'
            )
              throw new Error('Child followup resumed Model did not produce one final text.');
            return {
              events: [
                {
                  type: 'model.responded',
                  invocationId: proof.invocationId,
                  messageId: response.id ?? proof.invocationId,
                  durationMs: Math.max(0, Date.now() - startedAt),
                  toolCalls: [],
                  text: response.content,
                  ...(normalized.usage.inputTokens === null
                    ? {}
                    : { inputTokens: normalized.usage.inputTokens }),
                  ...(normalized.usage.outputTokens === null
                    ? {}
                    : { outputTokens: normalized.usage.outputTokens }),
                },
              ],
              value: undefined,
            };
          });
          return completeFollowupTurn(child, followup, targetSessionId, submissionId);
        } catch (error) {
          if (markAttemptedFollowupUnknown(targetSessionId, submissionId)) return false;
          if (!signal?.aborted && markUnattemptedFollowupFailed(targetSessionId, submissionId))
            return false;
          throw error;
        }
      }),
    );
  };
  const settleCompletedFollowupFunding = (
    targetSessionId: string,
    submissionId: string,
  ): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      const funding = mail.readFollowupFundingForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      if (!funding) return false;
      const target = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
      const ledger = target?.resourceBudget;
      const local =
        ledger?.status === 'active'
          ? ledger.reservations[funding.targetModelReservationId]
          : undefined;
      if (
        !target ||
        target.turn.turnId !== funding.targetRunId ||
        target.turn.status !== 'completed' ||
        target.terminalOutcome?.status !== 'completed' ||
        local?.state !== 'reconciled' ||
        !local.actual
      )
        return false;
      const turnActual = createZeroResourceUsage();
      turnActual.counters.turns = 1;
      turnActual.gauges.activeSubagents = 1;
      input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(input.parentSessionId, () => {
          if (mail.readFollowupTerminalForSource(input.parentSessionId, submissionId)) return;
          const parent = ensureParent();
          parent.session.commitCrossSessionFollowupFunding(
            [
              {
                type: 'resource_budget.reconciled',
                reservationId: funding.turnReservationId,
                actual: turnActual,
              },
              {
                type: 'resource_budget.reconciled',
                reservationId: funding.modelReservationId,
                actual: local.actual!,
              },
            ],
            {
              kind: 'settle_followup_funding',
              targetSessionId,
              submissionId,
              targetRunId: funding.targetRunId,
              modelInvocationId: funding.modelInvocationId,
              targetRevision: target.revision,
              disposition: 'completed',
              createdAtMs: Date.now(),
            },
          );
        }),
      );
      const acknowledged = input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(
          input.parentSessionId,
          () => mail.readFollowupTerminalForSource(input.parentSessionId, submissionId) !== null,
        ),
      );
      if (!acknowledged) return false;
      const reply = mail.acceptFollowupTerminalReply(
        targetSessionId,
        input.parentSessionId,
        submissionId,
        Date.now(),
      );
      input.scheduleTerminalReplyDelivery?.(targetSessionId, reply.messageId);
      return true;
    });
  };
  const settleIndependentFollowupFunding = (
    targetSessionId: string,
    submissionId: string,
  ): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    const accepted = mail.readAcceptedIndependentFollowupSourcePolicyProof(
      targetSessionId,
      input.parentSessionId,
      submissionId,
    );
    const target = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
    const followup = target?.activeFollowupTurn;
    const route = mail.readFollowupRoute(targetSessionId, submissionId);
    const prepared = input.owner.storage.sessions
      .loadEventsStrict(targetSessionId)
      .map(({ event }) => event)
      .filter(
        (event): event is Extract<RuntimeEvent, { type: 'agent.followup_turn_prepared' }> =>
          event.type === 'agent.followup_turn_prepared' &&
          event.sourceSessionId === input.parentSessionId &&
          event.submissionId === submissionId,
      );
    if (prepared.length !== 1) return false;
    const targetRunId =
      followup?.targetRunId ??
      (route?.route === 'new_turn' ? route.targetRunId : prepared[0]!.targetRunId);
    if (
      !accepted ||
      !target ||
      (followup !== undefined && followup.submissionId !== submissionId) ||
      !targetRunId ||
      targetRunId !== prepared[0]!.targetRunId ||
      (route !== null && (route.route !== 'new_turn' || route.targetRunId !== targetRunId)) ||
      target.resourceBudget.status !== 'active' ||
      target.resourceBudget.runId !== targetRunId
    )
      return false;
    const disposition =
      target.turn.status === 'completed' && target.terminalOutcome?.status === 'completed'
        ? 'completed'
        : target.terminalOutcome?.status === 'unknown'
          ? 'unknown'
          : target.turn.status === 'aborted'
            ? 'pre_dispatch_released'
            : null;
    if (!disposition) return false;
    const receipt = input.detachedScope.runInAsyncScope(() =>
      input.owner.runWithSessionExecution(input.parentSessionId, () =>
        mail.readFollowupTerminalForSource(input.parentSessionId, submissionId),
      ),
    );
    if (receipt) return true;
    const admission = accepted.admission;
    const backupId = String(admission.backupReservationId);
    const sourceLedger = input.detachedScope.runInAsyncScope(() =>
      input.owner.runWithSessionExecution(input.parentSessionId, () =>
        fundingBudgetForRun(ensureParent().getState(), String(admission.fundingRunId)),
      ),
    );
    const backup = sourceLedger?.reservations[backupId];
    if (!backup) return false;
    const targetEvidence = mail.readTargetSnapshotEvidence(targetSessionId, target.revision);
    if (!targetEvidence || targetEvidence.revision !== target.revision) return false;
    const audit: Extract<RuntimeEvent, { type: 'agent.followup_independent_settled' }> = {
      type: 'agent.followup_independent_settled',
      submissionId,
      targetAgentId: targetSessionId,
      targetRunId,
      targetRevision: target.revision,
      disposition,
      evidenceDigest: targetEvidence.digest,
      createdAtMs: Date.now(),
    };
    const events: RuntimeEvent[] = [];
    if (disposition === 'completed') {
      if (backup.state !== 'dispatch_started') return false;
      events.push({
        type: 'resource_budget.reconciled',
        reservationId: backupId,
        actual: {
          ...target.resourceBudget.reconciledUsage,
          counters: {
            ...target.resourceBudget.reconciledUsage.counters,
            turns: 1,
          },
          gauges: { ...target.resourceBudget.reconciledUsage.gauges, activeSubagents: 1 },
        },
      });
    } else if (disposition === 'unknown') {
      if (backup.state === 'dispatch_started')
        events.push({ type: 'resource_budget.unknown', reservationId: backupId });
      else if (backup.state !== 'unknown') return false;
    } else {
      if (backup.state !== 'reserved' && backup.state !== 'dispatch_started') return false;
      events.push({
        type: 'resource_budget.released',
        reservationId: backupId,
        proof: 'local_pre_dispatch_failure',
      });
    }
    events.push(audit);
    const committed = input.detachedScope.runInAsyncScope(() =>
      input.owner.runWithSessionExecution(input.parentSessionId, () =>
        ensureParent().session.commitCrossSessionFollowupFunding(events, {
          kind: 'settle_independent_followup_funding',
          targetSessionId,
          submissionId,
          targetRunId,
          targetRevision: target.revision,
          disposition,
          createdAtMs: audit.createdAtMs,
        }),
      ),
    );
    if (committed.length !== events.length) return false;
    if (
      !input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(input.parentSessionId, () =>
          mail.readFollowupTerminalForSource(input.parentSessionId, submissionId),
        ),
      )
    )
      return false;
    const reply = mail.acceptFollowupTerminalReply(
      targetSessionId,
      input.parentSessionId,
      submissionId,
      Date.now(),
    );
    input.scheduleTerminalReplyDelivery?.(targetSessionId, reply.messageId);
    return true;
  };
  const settleTerminalFollowupFunding = (
    targetSessionId: string,
    submissionId: string,
  ): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      if (
        mail.readAcceptedIndependentFollowupSourcePolicyProof(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        )
      )
        return settleIndependentFollowupFunding(targetSessionId, submissionId);
      const target = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
      if (!target) return false;
      if (target.turn.status === 'completed' && target.terminalOutcome?.status === 'completed')
        return settleCompletedFollowupFunding(targetSessionId, submissionId);
      if (
        target.turn.status === 'aborted' &&
        target.terminalOutcome?.status !== 'unknown' &&
        (target.turn.abortCause === 'error' || target.turn.abortCause === 'user')
      ) {
        const funding = mail.readFollowupFundingForTarget(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        );
        const route = mail.readFollowupRoute(targetSessionId, submissionId);
        const followup = target.activeFollowupTurn;
        const model = funding ? target.modelInvocations[funding.modelInvocationId] : undefined;
        const local =
          target.resourceBudget.status === 'active' && funding
            ? target.resourceBudget.reservations[funding.targetModelReservationId]
            : undefined;
        if (
          !funding ||
          !route ||
          route.route !== 'new_turn' ||
          route.sourceSessionId !== input.parentSessionId ||
          route.targetRunId !== funding.targetRunId ||
          (followup !== undefined &&
            (followup.submissionId !== submissionId ||
              followup.targetRunId !== route.targetRunId ||
              followup.taskId !== route.taskId)) ||
          model?.attempts !== 0 ||
          (local?.state !== 'reserved' && local?.state !== 'released') ||
          !mail.readFollowupActivationForTarget(
            targetSessionId,
            input.parentSessionId,
            submissionId,
          )
        )
          return false;
        const status = target.turn.abortCause === 'user' ? 'cancelled' : 'failed';
        const priorSettlements = input.owner.storage.sessions
          .loadEventsStrict(targetSessionId, route.routedRevision)
          .filter(
            ({ event }) =>
              event.type === 'agent.followup_turn_settled' && event.submissionId === submissionId,
          );
        if (priorSettlements.length > 1) return false;
        const priorSettlement = priorSettlements[0]?.event;
        let settledTargetRevision = target.revision;
        if (priorSettlement?.type === 'agent.followup_turn_settled') {
          if (
            priorSettlements[0]!.revision !== target.revision ||
            priorSettlement.sourceSessionId !== input.parentSessionId ||
            priorSettlement.targetRunId !== funding.targetRunId ||
            priorSettlement.taskId !== route.taskId ||
            priorSettlement.status !== status
          )
            return false;
        } else {
          const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
          const child = ensureChild(targetSessionId, runtime);
          if (child.getState().revision !== target.revision) return false;
          if (
            child.session.commitChildFollowupTurnSettlement({
              type: 'agent.followup_turn_settled',
              sourceSessionId: input.parentSessionId,
              submissionId,
              targetRunId: funding.targetRunId,
              taskId: route.taskId,
              status,
            }).length !== 1
          )
            return false;
          settledTargetRevision = child.getState().revision;
        }
        input.detachedScope.runInAsyncScope(() =>
          input.owner.runWithSessionExecution(input.parentSessionId, () => {
            const prior = mail.readFollowupTerminalForSource(input.parentSessionId, submissionId);
            if (prior) {
              if (prior.disposition !== 'pre_dispatch_released')
                throw new Error('Followup source funding ACK conflicts with target terminal.');
              return;
            }
            const parent = ensureParent();
            const ledger = fundingBudgetForRun(parent.getState(), funding.fundingRunId);
            const turn = ledger?.reservations[funding.turnReservationId];
            const modelFunding = ledger?.reservations[funding.modelReservationId];
            if (turn?.state !== 'dispatch_started' || modelFunding?.state !== 'dispatch_started')
              throw new Error('Pre-dispatch followup has no releasable source funding.');
            parent.session.commitCrossSessionFollowupFunding(
              [
                {
                  type: 'resource_budget.released',
                  reservationId: funding.turnReservationId,
                  proof: 'local_pre_dispatch_failure',
                },
                {
                  type: 'resource_budget.released',
                  reservationId: funding.modelReservationId,
                  proof: 'local_pre_dispatch_failure',
                },
              ],
              {
                kind: 'settle_followup_funding',
                targetSessionId,
                submissionId,
                targetRunId: funding.targetRunId,
                modelInvocationId: funding.modelInvocationId,
                targetRevision: settledTargetRevision,
                disposition: 'pre_dispatch_released',
                createdAtMs: Date.now(),
              },
            );
          }),
        );
        const acknowledged = input.detachedScope.runInAsyncScope(() =>
          input.owner.runWithSessionExecution(
            input.parentSessionId,
            () =>
              mail.readFollowupTerminalForSource(input.parentSessionId, submissionId)
                ?.disposition === 'pre_dispatch_released',
          ),
        );
        if (!acknowledged) return false;
        const reply = mail.acceptFollowupTerminalReply(
          targetSessionId,
          input.parentSessionId,
          submissionId,
          Date.now(),
        );
        input.scheduleTerminalReplyDelivery?.(targetSessionId, reply.messageId);
        return true;
      }
      if (target.turn.status !== 'aborted' || target.terminalOutcome?.status !== 'unknown')
        return false;
      const funding = mail.readFollowupFundingForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      const local =
        target.resourceBudget.status === 'active' && funding
          ? target.resourceBudget.reservations[funding.targetModelReservationId]
          : undefined;
      const model = funding ? target.modelInvocations[funding.modelInvocationId] : undefined;
      if (
        !funding ||
        model?.attempts === undefined ||
        model.attempts < 1 ||
        local?.state !== 'unknown'
      )
        return false;
      input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(input.parentSessionId, () => {
          if (mail.readFollowupTerminalForSource(input.parentSessionId, submissionId)) return;
          const parent = ensureParent();
          const ledger = fundingBudgetForRun(parent.getState(), funding.fundingRunId);
          const turn = ledger?.reservations[funding.turnReservationId];
          const modelFunding = ledger?.reservations[funding.modelReservationId];
          const receiptIdentity = {
            targetSessionId,
            submissionId,
            targetRunId: funding.targetRunId,
            modelInvocationId: funding.modelInvocationId,
            targetRevision: target.revision,
            createdAtMs: Date.now(),
          };
          if (turn?.state === 'unknown' && modelFunding?.state === 'unknown') {
            parent.session.commitCrossSessionFollowupUnknownAck({
              kind: 'settle_followup_funding_after_unknown_recovery',
              ...receiptIdentity,
            });
          } else if (
            turn?.state === 'dispatch_started' &&
            modelFunding?.state === 'dispatch_started'
          ) {
            parent.session.commitCrossSessionFollowupFunding(
              [
                { type: 'resource_budget.unknown', reservationId: funding.turnReservationId },
                { type: 'resource_budget.unknown', reservationId: funding.modelReservationId },
              ],
              { kind: 'settle_followup_funding', ...receiptIdentity, disposition: 'unknown' },
            );
          }
        }),
      );
      return input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(
          input.parentSessionId,
          () => mail.readFollowupTerminalForSource(input.parentSessionId, submissionId) !== null,
        ),
      );
    });
  };
  const markUnattemptedFollowupFailed = (
    targetSessionId: string,
    submissionId: string,
  ): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      if (
        mail.readAcceptedIndependentFollowupSourcePolicyProof(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        )
      ) {
        const durable = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
        const child = ensureChild(
          targetSessionId,
          input.modelRuntimeFactory(input.bridgeInput.workspace),
        );
        const state = child.getState();
        const followup = state.activeFollowupTurn;
        if (
          !durable ||
          durable.revision !== state.revision ||
          !followup ||
          followup.submissionId !== submissionId ||
          state.turn.status !== 'active' ||
          state.resourceBudget.status !== 'active'
        )
          return false;
        const prepared = Object.values(state.modelInvocations).filter(
          (model) =>
            model.purpose === 'primary_agent' &&
            model.budget.kind === 'reservation' &&
            model.status === 'prepared' &&
            model.attempts === 0 &&
            state.resourceBudget.reservations[model.budget.reservationId]?.runId ===
              followup.targetRunId,
        );
        if (prepared.length !== 1 || prepared[0]!.budget.kind !== 'reservation') return false;
        const local = state.resourceBudget.reservations[prepared[0]!.budget.reservationId];
        if (local?.state !== 'reserved') return false;
        const failure = classifyFailure(
          'provider_unavailable',
          'Independent followup could not dispatch its first Model attempt.',
        );
        const events: RuntimeEvent[] = [
          {
            type: 'resource_budget.released',
            reservationId: local.reservationId,
            proof: 'local_pre_dispatch_failure',
          },
          { type: 'task.failed', taskId: followup.taskId, reason: failure.message },
          {
            type: 'turn.aborted',
            turnId: followup.targetRunId,
            reason: failure.message,
            cause: 'error',
          },
          {
            type: 'run.error',
            turnId: followup.targetRunId,
            message: failure.message,
            recoverable: false,
            failure,
            outcome: failedTerminalOutcome(failure, { knownExternalEffects: 'known' }),
          },
        ];
        if (child.session.processEventBatch(events).length !== events.length) return false;
        if (
          child.session.commitChildFollowupTurnSettlement({
            type: 'agent.followup_turn_settled',
            sourceSessionId: input.parentSessionId,
            submissionId,
            targetRunId: followup.targetRunId,
            taskId: followup.taskId,
            status: 'failed',
          }).length !== 1
        )
          return false;
        return settleTerminalFollowupFunding(targetSessionId, submissionId);
      }
      const funding = mail.readFollowupFundingForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      if (
        !funding ||
        !mail.readFollowupActivationForTarget(targetSessionId, input.parentSessionId, submissionId)
      )
        return false;
      const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
      const child = ensureChild(targetSessionId, runtime);
      const state = child.getState();
      const followup = state.activeFollowupTurn;
      const model = state.modelInvocations[funding.modelInvocationId];
      const local =
        state.resourceBudget.status === 'active'
          ? state.resourceBudget.reservations[funding.targetModelReservationId]
          : undefined;
      if (
        followup?.submissionId !== submissionId ||
        followup.targetRunId !== funding.targetRunId ||
        state.turn.status !== 'active' ||
        model?.status !== 'prepared' ||
        model.attempts !== 0 ||
        local?.state !== 'reserved'
      )
        return false;
      const failure = classifyFailure(
        'provider_unavailable',
        'Child followup could not dispatch its first Model attempt.',
      );
      const events: RuntimeEvent[] = [
        {
          type: 'resource_budget.released',
          reservationId: local.reservationId,
          proof: 'local_pre_dispatch_failure',
        },
        { type: 'task.failed', taskId: followup.taskId, reason: failure.message },
        {
          type: 'turn.aborted',
          turnId: followup.targetRunId,
          reason: failure.message,
          cause: 'error',
        },
        {
          type: 'run.error',
          turnId: followup.targetRunId,
          message: failure.message,
          recoverable: false,
          failure,
          outcome: failedTerminalOutcome(failure, { knownExternalEffects: 'known' }),
        },
      ];
      if (child.session.processEventBatch(events).length !== events.length) return false;
      return settleTerminalFollowupFunding(targetSessionId, submissionId);
    });
  };
  const settleUnfundedPreparedExpiry = (targetSessionId: string, submissionId: string): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      const admitted = mail.readFollowupAdmissionForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      if (
        !admitted ||
        mail.readFollowupRoute(targetSessionId, submissionId) ||
        mail.readFollowupFundingForTarget(targetSessionId, input.parentSessionId, submissionId)
      )
        return false;
      const admission = JSON.parse(admitted.admission.canonicalJson) as { deadlineAt?: number };
      if (!Number.isSafeInteger(admission.deadlineAt) || Date.now() < admission.deadlineAt!)
        return false;
      const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
      const child = ensureChild(targetSessionId, runtime);
      const state = child.getState();
      const followup = state.activeFollowupTurn;
      if (
        followup?.submissionId !== submissionId ||
        followup.sourceSessionId !== input.parentSessionId ||
        state.turn.turnId !== followup.targetRunId ||
        state.turn.status !== 'active' ||
        state.resourceBudget.status !== 'active' ||
        state.resourceBudget.runId !== followup.targetRunId
      )
        return false;
      const prepared = Object.values(state.modelInvocations).filter(
        (model) =>
          model.purpose === 'primary_agent' &&
          model.status === 'prepared' &&
          model.attempts === 0 &&
          model.budget.kind === 'reservation' &&
          state.resourceBudget.reservations[model.budget.reservationId]?.state === 'reserved',
      );
      if (prepared.length !== 1 || prepared[0]!.budget.kind !== 'reservation') return false;
      const failure = classifyFailure(
        'provider_unavailable',
        CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED,
      );
      const events: RuntimeEvent[] = [
        {
          type: 'resource_budget.released',
          reservationId: prepared[0]!.budget.reservationId,
          proof: 'local_pre_dispatch_failure',
        },
        { type: 'task.failed', taskId: followup.taskId, reason: failure.message },
        {
          type: 'turn.aborted',
          turnId: followup.targetRunId,
          reason: failure.message,
          cause: 'error',
        },
        {
          type: 'run.error',
          turnId: followup.targetRunId,
          message: failure.message,
          recoverable: false,
          failure,
          outcome: failedTerminalOutcome(failure, { knownExternalEffects: 'known' }),
        },
      ];
      return child.session.processEventBatch(events).length === events.length;
    });
  };
  const markAttemptedFollowupUnknown = (targetSessionId: string, submissionId: string): boolean => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) return false;
    return input.owner.runWithSessionExecution(targetSessionId, () => {
      if (
        mail.readAcceptedIndependentFollowupSourcePolicyProof(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        )
      ) {
        const child = ensureChild(
          targetSessionId,
          input.modelRuntimeFactory(input.bridgeInput.workspace),
        );
        const state = child.getState();
        const followup = state.activeFollowupTurn;
        if (
          !followup ||
          followup.submissionId !== submissionId ||
          state.resourceBudget.status !== 'active' ||
          state.turn.status !== 'active'
        )
          return false;
        const attempted = Object.values(state.modelInvocations).filter(
          (model) =>
            model.purpose === 'primary_agent' &&
            model.budget.kind === 'reservation' &&
            model.attempts > 0 &&
            (model.status === 'dispatching' || model.status === 'interrupted') &&
            state.resourceBudget.reservations[model.budget.reservationId]?.runId ===
              followup.targetRunId,
        );
        if (attempted.length !== 1 || attempted[0]!.budget.kind !== 'reservation') return false;
        const model = attempted[0]!;
        const local =
          state.resourceBudget.reservations[
            model.budget.kind === 'reservation' ? model.budget.reservationId : ''
          ];
        if (local?.state !== 'dispatch_started' && local?.state !== 'unknown') return false;
        const failure = classifyFailure(
          'unknown',
          'Independent followup Model attempt ended without verifiable Provider usage.',
        );
        const events: RuntimeEvent[] = [
          ...(model.status === 'dispatching'
            ? ([
                {
                  type: 'model.invocation_interrupted',
                  invocationId: model.invocationId,
                  dispatchCertainty: 'unknown',
                  reasonCode: 'persistence_unavailable',
                },
              ] as const)
            : []),
          ...(local.state === 'dispatch_started'
            ? ([{ type: 'resource_budget.unknown', reservationId: local.reservationId }] as const)
            : []),
          { type: 'task.failed', taskId: followup.taskId, reason: failure.message },
          {
            type: 'turn.aborted',
            turnId: followup.targetRunId,
            reason: failure.message,
            cause: 'error',
          },
          {
            type: 'run.error',
            turnId: followup.targetRunId,
            message: failure.message,
            recoverable: false,
            failure,
            outcome: failedTerminalOutcome(failure, { knownExternalEffects: 'unknown' }),
          },
        ];
        if (child.session.processEventBatch(events).length !== events.length) return false;
        if (
          child.session.commitChildFollowupTurnSettlement({
            type: 'agent.followup_turn_settled',
            sourceSessionId: input.parentSessionId,
            submissionId,
            targetRunId: followup.targetRunId,
            taskId: followup.taskId,
            status: 'unknown',
          }).length !== 1
        )
          return false;
        return settleTerminalFollowupFunding(targetSessionId, submissionId);
      }
      const funding = mail.readFollowupFundingForTarget(
        targetSessionId,
        input.parentSessionId,
        submissionId,
      );
      if (!funding) return false;
      const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
      const child = ensureChild(targetSessionId, runtime);
      const state = child.getState();
      const followup = state.activeFollowupTurn;
      const model = state.modelInvocations[funding.modelInvocationId];
      const local =
        state.resourceBudget.status === 'active'
          ? state.resourceBudget.reservations[funding.targetModelReservationId]
          : undefined;
      if (
        !followup ||
        followup.submissionId !== submissionId ||
        model?.attempts === undefined ||
        model.attempts < 1 ||
        (model.status !== 'dispatching' && model.status !== 'interrupted') ||
        (local?.state !== 'dispatch_started' && local?.state !== 'unknown')
      )
        return false;
      if (state.turn.status === 'active') {
        const failure = classifyFailure(
          'unknown',
          'Child followup Model attempt ended without verifiable Provider usage.',
        );
        const events: RuntimeEvent[] = [
          ...(model.status === 'dispatching'
            ? ([
                {
                  type: 'model.invocation_interrupted',
                  invocationId: model.invocationId,
                  dispatchCertainty: 'unknown',
                  reasonCode: 'persistence_unavailable',
                },
              ] as const)
            : []),
          ...(local.state === 'dispatch_started'
            ? ([{ type: 'resource_budget.unknown', reservationId: local.reservationId }] as const)
            : []),
          {
            type: 'task.failed',
            taskId: followup.taskId,
            reason: failure.message,
          },
          {
            type: 'turn.aborted',
            turnId: followup.targetRunId,
            reason: failure.message,
            cause: 'error',
          },
          {
            type: 'run.error',
            turnId: followup.targetRunId,
            message: failure.message,
            recoverable: false,
            failure,
            outcome: failedTerminalOutcome(failure, { knownExternalEffects: 'unknown' }),
          },
        ];
        if (child.session.processEventBatch(events).length !== events.length) return false;
        if (
          child.session.commitChildFollowupTurnSettlement({
            type: 'agent.followup_turn_settled',
            sourceSessionId: input.parentSessionId,
            submissionId,
            targetRunId: followup.targetRunId,
            taskId: followup.taskId,
            status: 'unknown',
          }).length !== 1
        )
          return false;
      }
      return settleTerminalFollowupFunding(targetSessionId, submissionId);
    });
  };
  const schedulePendingFollowupRecovery = (cursor?: string): ScheduledFollowupRecovery => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery)
      return { scheduled: 0, completion: Promise.resolve({ processed: 0, recoveryRequired: [] }) };
    const listed = input.owner.runWithSessionExecution(input.parentSessionId, () =>
      mail.listPendingFollowupFunding(input.parentSessionId, 100, cursor),
    );
    const nextCursor = listed.length === 100 ? listed.at(-1)?.submissionId : undefined;
    const rows = listed.filter((row) => !activeFollowupSubmissions.has(row.submissionId));
    for (const row of rows) activeFollowupSubmissions.add(row.submissionId);
    let next = 0;
    const failures: { submissionId: string; reason: string }[] = [];
    let processed = 0;
    const waitForSourceTool = async (
      row: (typeof rows)[number],
      signal: AbortSignal,
    ): Promise<void> => {
      const admission = input.owner.runWithSessionExecution(row.targetSessionId, () =>
        mail.readFollowupAdmissionForTarget(
          row.targetSessionId,
          input.parentSessionId,
          row.submissionId,
        ),
      );
      if (!admission) throw new Error('Accepted followup admission is unavailable.');
      const admitted = JSON.parse(admission.admission.canonicalJson) as {
        schema?: string;
        deadlineAt?: unknown;
      };
      if (typeof admitted.deadlineAt !== 'number' || !Number.isSafeInteger(admitted.deadlineAt))
        throw new Error('Accepted followup deadline is invalid.');
      for (;;) {
        if (signal.aborted) throw new Error('Followup source Tool wait was aborted.');
        const facts = input.owner.runWithSessionExecution(input.parentSessionId, () => {
          const outbox = mail.readOutbox(input.parentSessionId, row.messageId);
          const parent = ensureParent();
          const state = parent.getState();
          const attemptMarker = outbox?.sourceEffectAttemptId.lastIndexOf(':attempt:') ?? -1;
          const invocationId =
            attemptMarker > 0 ? outbox!.sourceEffectAttemptId.slice(0, attemptMarker) : '';
          const expectedSubmissionId = `submission_${createHash('sha256')
            .update(JSON.stringify([row.messageId, 'trigger_turn']))
            .digest('hex')}`;
          const invocation = state.capabilities.invocations[invocationId];
          const tool = outbox ? state.tools.calls[outbox.sourceToolCallId] : undefined;
          if (
            outbox?.mode !== 'trigger_turn' ||
            expectedSubmissionId !== row.submissionId ||
            outbox.targetSessionId !== row.targetSessionId ||
            !invocation ||
            invocation.toolCallId !== outbox.sourceToolCallId ||
            !tool ||
            tool.name !== 'followup_task'
          )
            throw new Error('Accepted followup source Tool identity is unavailable.');
          const funding = fundingBudgetForRun(state, row.fundingRunId);
          const waitDeadline = outbox
            ? outbox.acceptedAtMs + Math.max(60_000, funding?.budget.maxConcurrencyWaitMs ?? 0)
            : NaN;
          return { parent, revision: state.revision, invocation, tool, waitDeadline };
        });
        if (facts.invocation.status === 'succeeded' && facts.tool.status === 'succeeded') return;
        const deadline =
          admitted.schema === 'kite.cross-session-followup-admission.v2'
            ? facts.waitDeadline
            : admitted.deadlineAt;
        const remainingMs = deadline - Date.now();
        if (!Number.isSafeInteger(deadline) || remainingMs <= 0)
          throw new Error('Accepted followup source Tool deadline expired.');
        if (
          !['recorded', 'running'].includes(facts.invocation.status) ||
          !['queued', 'running'].includes(facts.tool.status)
        )
          throw new Error('Accepted followup source Tool did not finish successfully.');
        if (!facts.parent.session.waitForRevisionChange)
          throw new Error('Accepted followup source Tool has no revision waiter.');
        await facts.parent.session.waitForRevisionChange(
          facts.revision,
          AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]),
        );
      }
    };
    const releaseUndispatchedAcceptedBackup = (
      row: (typeof rows)[number],
      reason:
        | 'tool_failed'
        | 'expired'
        | 'context_unavailable'
        | 'authorization_changed'
        | 'capacity_timeout',
    ): boolean => {
      if (row.stage !== 'accepted') return false;
      const released = input.owner.runWithSessionExecution(input.parentSessionId, () => {
        const outbox = mail.readOutbox(input.parentSessionId, row.messageId);
        const parent = ensureParent();
        const state = parent.getState();
        const marker = outbox?.sourceEffectAttemptId.lastIndexOf(':attempt:') ?? -1;
        const invocationId = marker > 0 ? outbox!.sourceEffectAttemptId.slice(0, marker) : '';
        const invocation = state.capabilities.invocations[invocationId];
        const tool = outbox && state.tools.calls[outbox.sourceToolCallId];
        if (
          outbox?.mode !== 'trigger_turn' ||
          outbox.targetSessionId !== row.targetSessionId ||
          !invocation ||
          !tool
        )
          return false;
        const ledger = fundingBudgetForRun(state, row.fundingRunId);
        const backup = ledger?.reservations[row.backupReservationId];
        if (
          (backup?.state !== 'queued' && backup?.state !== 'reserved') ||
          backup.resourceKind !== 'subagent'
        )
          return false;
        const committed = parent.session.commitCrossSessionFollowupFunding(
          [{ type: 'resource_budget.released', reservationId: row.backupReservationId }],
          {
            kind: 'release_accepted_followup_backup',
            targetSessionId: row.targetSessionId,
            submissionId: row.submissionId,
            reason,
            createdAtMs: Date.now(),
          },
        );
        return committed.length === 1;
      });
      if (!released) return false;
      const notice = input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(row.targetSessionId, () =>
          mail.acceptAcceptedReleaseNotice(
            row.targetSessionId,
            input.parentSessionId,
            row.submissionId,
            Date.now(),
          ),
        ),
      );
      input.scheduleTerminalReplyDelivery?.(row.targetSessionId, notice.messageId);
      return true;
    };
    const acceptedFailureReason = (
      row: (typeof rows)[number],
    ):
      | 'tool_failed'
      | 'expired'
      | 'context_unavailable'
      | 'authorization_changed'
      | 'capacity_timeout'
      | null => {
      if (row.stage !== 'accepted') return null;
      const target = input.owner.runWithSessionExecution(input.parentSessionId, () =>
        mail.readFollowupTarget(input.parentSessionId, row.targetSessionId),
      );
      if (target?.status === 'context_unavailable') return 'context_unavailable';
      const acceptedProof = input.owner.runWithSessionExecution(row.targetSessionId, () =>
        mail.readAcceptedIndependentFollowupSourcePolicyProof(
          row.targetSessionId,
          input.parentSessionId,
          row.submissionId,
        ),
      );
      const admission = acceptedProof
        ? null
        : input.owner.runWithSessionExecution(row.targetSessionId, () =>
            mail.readFollowupAdmissionForTarget(
              row.targetSessionId,
              input.parentSessionId,
              row.submissionId,
            ),
          );
      if (!acceptedProof && !admission) return null;
      const payload = (acceptedProof?.admission ??
        JSON.parse(admission!.admission.canonicalJson)) as {
        schema?: string;
        backupReservationId?: string;
        deadlineAt?: number;
        policy?: {
          interactionMode?: string;
          interactionModeRevision?: number;
          workspaceAccess?: string;
          workspaceDigest?: string;
          capabilityDigest?: string;
        };
      };
      const independent = payload.schema === 'kite.cross-session-followup-admission.v2';
      if (
        payload.backupReservationId !== undefined &&
        payload.backupReservationId !== row.backupReservationId
      )
        return null;
      const now = Date.now();
      if (!independent && Number.isSafeInteger(payload.deadlineAt) && now >= payload.deadlineAt!)
        return 'expired';
      if (independent && !acceptedProof) return null;
      const parent = input.owner.runWithSessionExecution(input.parentSessionId, () =>
        ensureParent().getState(),
      );
      const outbox = input.owner.runWithSessionExecution(input.parentSessionId, () =>
        mail.readOutbox(input.parentSessionId, row.messageId),
      );
      const marker = outbox?.sourceEffectAttemptId.lastIndexOf(':attempt:') ?? -1;
      const invocationId = marker > 0 ? outbox!.sourceEffectAttemptId.slice(0, marker) : '';
      if (
        parent.capabilities.invocations[invocationId]?.status === 'failed' &&
        parent.tools.calls[outbox?.sourceToolCallId ?? '']?.status === 'failed'
      )
        return 'tool_failed';
      if (
        (!independent ||
          (parent.turn.status === 'active' &&
            parent.resourceBudget.status === 'active' &&
            parent.resourceBudget.runId === row.fundingRunId)) &&
        (payload.policy?.interactionMode !== parent.mode ||
          payload.policy?.interactionModeRevision !== parent.interactionModeRevision ||
          payload.policy?.workspaceAccess !== parent.workspaceAccess ||
          payload.policy?.workspaceDigest !== parent.session.canonicalWorkspaceDigest ||
          payload.policy?.capabilityDigest !== parent.capabilities.catalogRevision)
      )
        return 'authorization_changed';
      const ledger = fundingBudgetForRun(parent, row.fundingRunId);
      const waitMs = ledger?.budget.maxConcurrencyWaitMs;
      if (
        ledger &&
        outbox &&
        Number.isSafeInteger(waitMs) &&
        Number.isSafeInteger(outbox.acceptedAtMs + waitMs!) &&
        now >= outbox.acceptedAtMs + waitMs! &&
        planCrossSessionFollowupSlotAcquisition({
          sourceState: parent,
          sourceSessionId: input.parentSessionId,
          fundingRunId: row.fundingRunId,
          submissionId: row.submissionId,
          backupReservationId: row.backupReservationId,
        }).status === 'waiting'
      )
        return 'capacity_timeout';
      return null;
    };
    const waitForFollowupSlot = async (
      row: (typeof rows)[number],
      signal: AbortSignal,
    ): Promise<boolean> => {
      for (;;) {
        if (signal.aborted) throw new Error('Followup slot waiter was aborted.');
        const reason = acceptedFailureReason(row);
        if (reason) {
          if (releaseUndispatchedAcceptedBackup(row, reason)) return false;
          throw new Error('Accepted followup could not release its undispatched backup.');
        }
        const independent = input.owner.runWithSessionExecution(row.targetSessionId, () =>
          mail.readAcceptedIndependentFollowupSourcePolicyProof(
            row.targetSessionId,
            input.parentSessionId,
            row.submissionId,
          ),
        );
        const source = input.owner.runWithSessionExecution(input.parentSessionId, () => {
          const parent = ensureParent();
          const state = parent.getState();
          const outbox = mail.readOutbox(input.parentSessionId, row.messageId);
          const ledger = fundingBudgetForRun(state, row.fundingRunId);
          if (!outbox || !ledger) throw new Error('Accepted followup has no source slot funding.');
          const plan = planCrossSessionFollowupSlotAcquisition({
            sourceState: state,
            sourceSessionId: input.parentSessionId,
            fundingRunId: row.fundingRunId,
            submissionId: row.submissionId,
            backupReservationId: row.backupReservationId,
          });
          return {
            parent,
            revision: state.revision,
            plan,
            waitUntil: independent
              ? outbox.acceptedAtMs + ledger.budget.maxConcurrencyWaitMs
              : Math.min(
                  Date.parse(ledger.deadlineAt),
                  outbox.acceptedAtMs + ledger.budget.maxConcurrencyWaitMs,
                ),
          };
        });
        if (source.plan.status === 'already_acquired') return true;
        if (source.plan.status === 'ready') {
          try {
            input.owner.runWithSessionExecution(input.parentSessionId, () =>
              source.parent.commitChildSlotAcquisition(row.backupReservationId),
            );
          } catch (error) {
            if (source.parent.getState().revision === source.revision) throw error;
          }
          continue;
        }
        if (!Number.isSafeInteger(source.waitUntil))
          throw new Error('Accepted followup slot wait has no finite deadline.');
        const remainingMs = source.waitUntil - Date.now();
        if (remainingMs <= 0) continue;
        if (!source.parent.session.waitForRevisionChange)
          throw new Error('Accepted followup slot has no source revision waiter.');
        try {
          await source.parent.session.waitForRevisionChange(
            source.revision,
            AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]),
          );
        } catch (error) {
          if (signal.aborted) throw error;
          if (Date.now() < source.waitUntil) throw error;
        }
      }
    };
    const readCurrentTurnRelease = (row: (typeof rows)[number]) =>
      input.owner.runWithSessionExecution(row.targetSessionId, () =>
        mail.readCurrentTurnBackupReleaseForTarget(
          row.targetSessionId,
          input.parentSessionId,
          row.submissionId,
        ),
      );
    const releaseRoutedCurrentTurnBackup = async (
      row: (typeof rows)[number],
      signal: AbortSignal,
    ): Promise<boolean> => {
      const routed = input.owner.runWithSessionExecution(row.targetSessionId, () =>
        mail.readFollowupRoute(row.targetSessionId, row.submissionId),
      );
      if (
        routed?.route !== 'current_turn' ||
        routed.sourceSessionId !== input.parentSessionId ||
        routed.messageId !== row.messageId
      )
        return false;
      const existing = readCurrentTurnRelease(row);
      if (existing) return existing.invocationId === routed.invocationId;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (signal.aborted) throw new Error('Current-turn backup release owner stopped.');
        try {
          input.detachedScope.runInAsyncScope(() =>
            input.owner.runWithSessionExecution(input.parentSessionId, () => {
              const parent = ensureParent();
              const backup = fundingBudgetForRun(parent.getState(), row.fundingRunId)?.reservations[
                row.backupReservationId
              ];
              if (backup?.state !== 'queued' && backup?.state !== 'reserved')
                throw new Error('Routed current-turn followup has no held source backup.');
              parent.session.commitCrossSessionFollowupFunding(
                [{ type: 'resource_budget.released', reservationId: backup.reservationId }],
                {
                  kind: 'release_current_turn_backup',
                  targetSessionId: row.targetSessionId,
                  submissionId: row.submissionId,
                  targetRunId: routed.targetRunId,
                  invocationId: routed.invocationId,
                  modelAdmissionId: routed.modelAdmissionId,
                  reservationId: routed.reservationId,
                  targetRevision: routed.routedRevision,
                  createdAtMs: Date.now(),
                },
              );
            }),
          );
          break;
        } catch (error) {
          if (readCurrentTurnRelease(row)) break;
          const cause = error instanceof Error ? error.cause : undefined;
          const inner = cause instanceof Error ? cause.cause : undefined;
          if (
            attempt === 39 ||
            !inner ||
            typeof inner !== 'object' ||
            !('code' in inner) ||
            inner.code !== 'unsupported_mutation'
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      return readCurrentTurnRelease(row)?.invocationId === routed.invocationId;
    };
    const recoverFollowupTargetOwner = async (row: (typeof rows)[number]): Promise<void> => {
      const durable = input.owner.storage.sessions.loadSnapshot<RuntimeState>(row.targetSessionId);
      const resident = input.coordinators.get(row.targetSessionId);
      if (durable && resident && resident.getState().revision < durable.revision)
        await input.coordinators.release(row.targetSessionId);
      const proof =
        row.stage === 'activated'
          ? input.owner.runWithSessionExecution(input.parentSessionId, () =>
              mail.readActivatedNoAttemptTargetProofForSource(
                input.parentSessionId,
                row.targetSessionId,
                row.submissionId,
              ),
            )
          : null;
      await input.owner.reconcileInterruptedSession(
        row.targetSessionId,
        async (generation, assertCurrent) => {
          const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
          const child = ensureChild(row.targetSessionId, runtime, proof ?? undefined);
          const result = await reconcileRuntimeSessionAfterRestart({
            control: child.control,
            modelInvocationRuntime: runtime,
            shellExecutor: input.bridgeInput.shellExecutor,
            historyEvents: input.owner.storage.sessions
              .loadEventsStrict(row.targetSessionId)
              .map(({ event }) => event),
            recoveryOwnership: {
              kind: 'fenced_previous_execution',
              controllerGeneration: generation,
              assertCurrent,
            },
            ...(proof ? { preservePreparedFollowupModels: [proof] } : {}),
          });
          return result.complete ? undefined : 'cleanup_unconfirmed';
        },
      );
    };
    const runOne = async (row: (typeof rows)[number], signal: AbortSignal): Promise<void> => {
      if (signal.aborted) throw new Error('Followup recovery owner stopped.');
      if (row.stage === 'accepted' && activeChildren.has(row.targetSessionId)) {
        if (!(await receiveAcceptedFollowup(row.targetSessionId, row.submissionId)))
          throw new Error('Live child followup target receipt is unavailable.');
        await waitForSourceTool(row, signal);
        for (;;) {
          if (signal.aborted) throw new Error('Live child followup waiter was aborted.');
          const routed = input.owner.runWithSessionExecution(row.targetSessionId, () =>
            mail.readFollowupRoute(row.targetSessionId, row.submissionId),
          );
          if (routed?.route === 'current_turn') {
            if (!(await releaseRoutedCurrentTurnBackup(row, signal)))
              throw new Error('Live current-turn route has no source backup release ACK.');
            return;
          }
          if (!activeChildren.has(row.targetSessionId)) break;
          const reason = acceptedFailureReason(row);
          if (reason) {
            if (releaseUndispatchedAcceptedBackup(row, reason)) return;
            throw new Error('Live child followup failure could not be durably settled.');
          }
          const child = input.coordinators.get(row.targetSessionId);
          if (!child?.session.waitForRevisionChange)
            throw new Error('Live child followup has no revision waiter.');
          const revision = child.getState().revision;
          try {
            await child.session.waitForRevisionChange(
              revision,
              AbortSignal.any([signal, AbortSignal.timeout(1000)]),
            );
          } catch (error) {
            if (signal.aborted) throw error;
          }
        }
      }
      const currentRoute =
        row.stage === 'accepted'
          ? input.owner.runWithSessionExecution(row.targetSessionId, () =>
              mail.readFollowupRoute(row.targetSessionId, row.submissionId),
            )
          : null;
      if (currentRoute?.route === 'current_turn') {
        const released = readCurrentTurnRelease(row);
        if (released?.invocationId === currentRoute.invocationId) return;
        const routedNoAttempt = input.owner.runWithSessionExecution(input.parentSessionId, () =>
          mail.readCurrentTurnRoutedNoAttemptChildProofForSource(
            input.parentSessionId,
            row.targetSessionId,
            row.submissionId,
          ),
        );
        if (!routedNoAttempt || !(await releaseRoutedCurrentTurnBackup(row, signal)))
          throw new Error('Routed current-turn Model has no source backup release ACK.');
        return; // The original D0 child Run owns this already-routed Model.
      }
      await recoverFollowupTargetOwner(row);
      const targetSessionId = row.targetSessionId;
      const submissionId = row.submissionId;
      if (!(await receiveAcceptedFollowup(targetSessionId, submissionId)))
        throw new Error('Accepted followup target receipt is unavailable.');
      try {
        await waitForSourceTool(row, signal);
      } catch (error) {
        const reason = !signal.aborted ? acceptedFailureReason(row) : null;
        if (reason && releaseUndispatchedAcceptedBackup(row, reason)) return;
        throw error;
      }
      const acceptedReason = acceptedFailureReason(row);
      if (acceptedReason) {
        if (releaseUndispatchedAcceptedBackup(row, acceptedReason)) return;
        throw new Error('Accepted followup failure could not be durably settled.');
      }
      if (row.stage === 'accepted' && !(await waitForFollowupSlot(row, signal))) return;
      const target = input.owner.runWithSessionExecution(targetSessionId, () =>
        input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId),
      );
      const independentProof = input.owner.runWithSessionExecution(targetSessionId, () =>
        mail.readAcceptedIndependentFollowupSourcePolicyProof(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        ),
      );
      if (independentProof && target && target.turn.status !== 'active') {
        const route = input.owner.runWithSessionExecution(targetSessionId, () =>
          mail.readFollowupRoute(targetSessionId, submissionId),
        );
        const prepared = input.owner.storage.sessions
          .loadEventsStrict(targetSessionId)
          .map(({ event }) => event)
          .filter(
            (event): event is Extract<RuntimeEvent, { type: 'agent.followup_turn_prepared' }> =>
              event.type === 'agent.followup_turn_prepared' &&
              event.sourceSessionId === input.parentSessionId &&
              event.submissionId === submissionId,
          );
        if (
          prepared.length === 1 &&
          prepared[0]!.targetRunId === target.turn.turnId &&
          (route === null ||
            (route.route === 'new_turn' && route.targetRunId === target.turn.turnId))
        ) {
          if (!settleTerminalFollowupFunding(targetSessionId, submissionId))
            throw new Error('Terminal independent followup has no source funding ACK.');
          return;
        }
      }
      if (target?.activeFollowupTurn && target.activeFollowupTurn.submissionId !== submissionId)
        throw new Error('Followup target is owned by another submission.');
      if (
        target?.activeFollowupTurn?.submissionId === submissionId &&
        (target.turn.status === 'completed' ||
          (target.turn.status === 'aborted' &&
            (target.terminalOutcome?.status === 'unknown' ||
              target.turn.abortCause === 'error' ||
              target.turn.abortCause === 'user')))
      ) {
        if (target.turn.status === 'aborted' && target.terminalOutcome?.status !== 'unknown') {
          if (!settleTerminalFollowupFunding(targetSessionId, submissionId))
            throw new Error('Pre-dispatch followup lacks an exact source funding ACK.');
          return;
        }
        const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
        const child = ensureChild(targetSessionId, runtime);
        const status =
          target.turn.status === 'completed' && target.terminalOutcome?.status === 'completed'
            ? 'completed'
            : 'unknown';
        input.owner.runWithSessionExecution(targetSessionId, () =>
          child.session.commitChildFollowupTurnSettlement({
            type: 'agent.followup_turn_settled',
            sourceSessionId: input.parentSessionId,
            submissionId,
            targetRunId: target.activeFollowupTurn!.targetRunId,
            taskId: target.activeFollowupTurn!.taskId,
            status,
          }),
        );
        if (!settleTerminalFollowupFunding(targetSessionId, submissionId))
          throw new Error('Settled target lacks an exact source funding ACK.');
        return;
      }
      if (!startAcceptedFollowup(targetSessionId, submissionId))
        throw new Error('Accepted followup has no checkpoint-backed target Run.');
      const current = input.owner.runWithSessionExecution(targetSessionId, () =>
        input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId),
      );
      if (independentProof) {
        if (
          !current?.activeFollowupTurn ||
          current.activeFollowupTurn.submissionId !== submissionId
        )
          throw new Error('Independent followup lost its active target Run.');
        const localModels = Object.values(current.modelInvocations).filter(
          (candidate) =>
            candidate.purpose === 'primary_agent' &&
            candidate.budget.kind === 'reservation' &&
            current.resourceBudget.status === 'active' &&
            current.resourceBudget.reservations[candidate.budget.reservationId]?.runId ===
              current.activeFollowupTurn!.targetRunId,
        );
        if (localModels.length === 0) {
          if (!(await executeAcceptedFollowupFirstModel(targetSessionId, submissionId, signal)))
            throw new Error('Independent followup first Model did not complete.');
          return;
        }
        if (localModels.some((candidate) => candidate.status !== 'completed')) {
          if (
            localModels.length === 1 &&
            localModels[0]?.status === 'prepared' &&
            localModels[0].attempts === 0
          ) {
            if (await resumePreparedFollowupFirstModel(targetSessionId, submissionId, signal))
              return;
            const recovered =
              input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
            if (recovered?.turn.status !== 'active') return;
          }
          if (markAttemptedFollowupUnknown(targetSessionId, submissionId)) return;
          throw new Error('Independent followup prepared Model requires exact Surface recovery.');
        }
        const child = ensureChild(
          targetSessionId,
          input.modelRuntimeFactory(input.bridgeInput.workspace),
        );
        if (
          input.owner.runWithSessionExecution(targetSessionId, () =>
            completeFollowupTurn(child, current.activeFollowupTurn!, targetSessionId, submissionId),
          )
        )
          return;
        if (child.getState().turn.status !== 'active')
          throw new Error('Independent followup terminal lacks a source funding ACK.');
        if (
          !(await input.enqueueSessionWork(targetSessionId, () =>
            input.owner.runWithSessionExecution(targetSessionId, () =>
              continueIndependentFollowup(targetSessionId, submissionId, signal),
            ),
          ))
        )
          throw new Error('Independent followup tool loop did not reach a durable terminal.');
        return;
      }
      const belongsToFollowup = (model: RuntimeState['modelInvocations'][string]): boolean =>
        current?.activeFollowupTurn?.submissionId === submissionId &&
        current.resourceBudget.status === 'active' &&
        current.resourceBudget.runId === current.activeFollowupTurn.targetRunId &&
        model.purpose === 'primary_agent' &&
        model.budget.kind === 'reservation' &&
        current.resourceBudget.reservations[model.budget.reservationId] !== undefined;
      const models = current
        ? Object.values(current.modelInvocations).filter(
            (model) => belongsToFollowup(model) && model.status !== 'completed',
          )
        : [];
      if (models.length > 1) throw new Error('Followup target has multiple first Model intents.');
      const model = models[0];
      if (!model) {
        if (current?.activeFollowupTurn && current.turn.status === 'active') {
          const completed = Object.values(current.modelInvocations).find(
            (candidate) => belongsToFollowup(candidate) && candidate.status === 'completed',
          );
          if (completed) {
            const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
            const child = ensureChild(targetSessionId, runtime);
            if (
              !input.owner.runWithSessionExecution(targetSessionId, () =>
                completeFollowupTurn(
                  child,
                  current.activeFollowupTurn!,
                  targetSessionId,
                  submissionId,
                ),
              )
            )
              throw new Error('Completed followup Model cannot be settled without replay.');
            return;
          }
        }
        if (!(await executeAcceptedFollowupFirstModel(targetSessionId, submissionId, signal)))
          throw new Error('First followup Model did not complete.');
        return;
      }
      if (model.attempts > 0 || model.status === 'dispatching' || model.status === 'interrupted') {
        if (!markAttemptedFollowupUnknown(targetSessionId, submissionId))
          throw new Error('Attempted followup needs manual unknown reconciliation.');
        return;
      }
      if (model.status !== 'prepared')
        throw new Error('Followup first Model has no safe prepared state.');
      if (
        !replacePreparedFollowupBackup(targetSessionId, submissionId) ||
        !routePreparedFollowup(targetSessionId, submissionId) ||
        !activateRoutedFollowup(targetSessionId, submissionId)
      )
        throw new Error('Prepared followup funding or route is not durable.');
      if (!(await resumePreparedFollowupFirstModel(targetSessionId, submissionId, signal)))
        throw new Error('Prepared followup Model did not complete.');
    };
    const completion = input.detachedScope.runInAsyncScope(async () => {
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT_CHILD_RECOVERIES, rows.length) }, async () => {
          for (;;) {
            const index = next++;
            const row = rows[index];
            if (!row) return;
            const controller = new AbortController();
            followupRecoveryControllers.add(controller);
            activeFollowupControllers.set(row.submissionId, controller);
            try {
              await runOne(row, controller.signal);
              processed += 1;
            } catch {
              let reason: ReturnType<typeof acceptedFailureReason> = null;
              if (!controller.signal.aborted) {
                try {
                  reason = acceptedFailureReason(row);
                  if (reason === 'expired')
                    settleUnfundedPreparedExpiry(row.targetSessionId, row.submissionId);
                  if (reason && releaseUndispatchedAcceptedBackup(row, reason)) {
                    processed += 1;
                    continue;
                  }
                } catch {
                  reason = null;
                }
              }
              failures.push({
                submissionId: row.submissionId,
                reason: reason ?? 'followup_recovery_required',
              });
            } finally {
              followupRecoveryControllers.delete(controller);
              if (activeFollowupControllers.get(row.submissionId) === controller)
                activeFollowupControllers.delete(row.submissionId);
              activeFollowupSubmissions.delete(row.submissionId);
            }
          }
        }),
      );
      return {
        processed,
        recoveryRequired: Object.freeze(failures),
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
    pendingFollowupRecoveries.add(completion);
    void completion.finally(() => pendingFollowupRecoveries.delete(completion));
    return { scheduled: rows.length, completion, ...(nextCursor ? { nextCursor } : {}) };
  };
  const recoverPendingFollowups = async (cursor?: string): Promise<FollowupRecoveryResult> =>
    schedulePendingFollowupRecovery(cursor).completion;
  const acceptedFollowupsForTarget = (targetSessionId: string) => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery) return [];
    return input.detachedScope.runInAsyncScope(() =>
      input.owner.runWithSessionExecution(input.parentSessionId, () => {
        const matching: ReturnType<typeof mail.listPendingFollowupFunding>[number][] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = mail.listPendingFollowupFunding(input.parentSessionId, 100, cursor);
          matching.push(
            ...page.filter(
              (row) => row.stage === 'accepted' && row.targetSessionId === targetSessionId,
            ),
          );
          if (page.length < 100) return matching;
          const nextCursor = page.at(-1)?.submissionId;
          if (!nextCursor || (cursor !== undefined && nextCursor <= cursor))
            throw new Error('Pending followup cursor did not advance.');
          cursor = nextCursor;
        }
      }),
    );
  };
  const currentTurnFollowupForTarget = (
    targetSessionId: string,
  ): NonNullable<RuntimeTurnInput['currentTurnFollowup']> => ({
    safeToolNames: (stage) => {
      const mail = input.owner.storage.crossSessionQueueMail;
      if (!mail || stoppingRecovery) return undefined;
      const target = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
      if (
        !target?.childSessionOrigin ||
        !['explore', 'plan', 'review'].includes(target.childSessionOrigin.role) ||
        target.childSessionOrigin.terminal ||
        target.interactionModeRevision !== 0 ||
        target.turn.status !== 'active'
      )
        return undefined;
      const routed = input.owner.storage.sessions
        .loadEventsStrict(targetSessionId)
        .some(
          ({ event }) =>
            event.type === 'agent.followup_routed' &&
            event.route === 'current_turn' &&
            event.targetAgentId === targetSessionId &&
            event.taskId === target.activeTaskId,
        );
      const matching =
        stage === 'model' &&
        acceptedFollowupsForTarget(targetSessionId).some((row) => {
          const accepted = mail.readFollowupAdmissionForTarget(
            targetSessionId,
            input.parentSessionId,
            row.submissionId,
          );
          if (!accepted) return false;
          const admission = JSON.parse(accepted.admission.canonicalJson) as {
            schema?: unknown;
            policy?: { interactionMode?: unknown };
          };
          return (
            admission.schema === 'kite.cross-session-followup-admission.v1' &&
            admission.policy?.interactionMode === target.mode &&
            mail.readUnroutedFollowupMessage(
              targetSessionId,
              input.parentSessionId,
              row.submissionId,
              accepted.messageId,
            ) !== null
          );
        });
      if (!matching && !routed) return undefined;
      const sealed = input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(input.parentSessionId, () =>
          input.owner.readChildSealedGrant(targetSessionId),
        ),
      );
      const grant = sealed
        ? (JSON.parse(sealed.sealedGrantJson) as {
            capabilityCeiling?: { allowedTools?: unknown; bindingIds?: unknown };
          })
        : null;
      if (
        !Array.isArray(grant?.capabilityCeiling?.allowedTools) ||
        !grant.capabilityCeiling.allowedTools.every((name) => typeof name === 'string') ||
        !Array.isArray(grant.capabilityCeiling.bindingIds) ||
        grant.capabilityCeiling.bindingIds.length !== 0
      )
        return undefined;
      const permitted = new Set(['read_file', 'search_content', 'search_files']);
      return grant.capabilityCeiling.allowedTools.filter(
        (name): name is string => typeof name === 'string' && permitted.has(name),
      );
    },
    firstAttemptTimeoutMs: () => {
      const mail = input.owner.storage.crossSessionQueueMail;
      if (!mail || stoppingRecovery) return undefined;
      return acceptedFollowupsForTarget(targetSessionId).some((row) => {
        const accepted = mail.readFollowupAdmissionForTarget(
          targetSessionId,
          input.parentSessionId,
          row.submissionId,
        );
        if (!accepted) return false;
        const admission = JSON.parse(accepted.admission.canonicalJson) as { schema?: unknown };
        return admission.schema === 'kite.cross-session-followup-admission.v1';
      })
        ? 60_000
        : undefined;
    },
    prepareAgentMail: async ({ invocationId }) => {
      const mail = input.owner.storage.crossSessionQueueMail;
      if (!mail || stoppingRecovery) return { frames: [] };
      const target = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
      if (
        !target ||
        target.childSessionOrigin?.parentSessionId !== input.parentSessionId ||
        !['explore', 'plan', 'review'].includes(target.childSessionOrigin.role) ||
        target.childSessionOrigin.terminal ||
        target.activeFollowupTurn ||
        target.turn.status !== 'active' ||
        !target.activeTaskId
      )
        return { frames: [] };
      const sealed = input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(input.parentSessionId, () =>
          input.owner.readChildSealedGrant(targetSessionId),
        ),
      );
      if (!sealed) return { frames: [] };
      const grant = JSON.parse(sealed.sealedGrantJson) as {
        capabilityCeiling?: { allowedTools?: unknown; bindingIds?: unknown };
      };
      if (
        !Array.isArray(grant.capabilityCeiling?.allowedTools) ||
        !grant.capabilityCeiling.allowedTools.every(
          (tool): tool is string => typeof tool === 'string' && tool.length > 0,
        ) ||
        new Set(grant.capabilityCeiling.allowedTools).size !==
          grant.capabilityCeiling.allowedTools.length ||
        !Array.isArray(grant.capabilityCeiling?.bindingIds) ||
        grant.capabilityCeiling.bindingIds.length !== 0
      )
        return { frames: [] };
      const rows = acceptedFollowupsForTarget(targetSessionId);
      const candidates = rows
        .flatMap((row) => {
          const accepted = mail.readFollowupAdmissionForTarget(
            targetSessionId,
            input.parentSessionId,
            row.submissionId,
          );
          if (!accepted) return [];
          const payload = JSON.parse(accepted.admission.canonicalJson) as {
            schema?: unknown;
            policy?: { interactionMode?: unknown };
            backupReservationId?: unknown;
          };
          if (
            payload.schema !== 'kite.cross-session-followup-admission.v1' ||
            target.interactionModeRevision !== 0 ||
            payload.policy?.interactionMode !== target.mode ||
            typeof payload.backupReservationId !== 'string'
          )
            return [];
          const message = mail.readUnroutedFollowupMessage(
            targetSessionId,
            input.parentSessionId,
            row.submissionId,
            accepted.messageId,
          );
          return message
            ? [{ row, accepted, message, backupReservationId: payload.backupReservationId }]
            : [];
        })
        .sort((left, right) => left.message.sequence - right.message.sequence);
      const selected = candidates[0];
      if (!selected) return { frames: [] };
      const { row, accepted, message, backupReservationId } = selected;
      currentTurnCandidates.set(invocationId, {
        targetSessionId,
        submissionId: row.submissionId,
        messageId: accepted.messageId,
        sequence: message.sequence,
        fundingRunId: row.fundingRunId,
        backupReservationId,
      });
      const frame = createAgentMessageContextFrame({
        messageId: accepted.messageId,
        senderAgentId: input.parentSessionId,
        ...(message.sourceTaskId ? { sourceTaskId: message.sourceTaskId } : {}),
        body: message.bodyText,
      });
      return {
        frames: [
          humanMessage({
            id: frame.messageId,
            name: 'agent_message',
            content: frame.content,
            response_metadata: { source: 'agent_message' },
          }),
        ],
      };
    },
    afterPrepared: async (invocationId, commitRoute) => {
      const candidate = currentTurnCandidates.get(invocationId);
      const mail = input.owner.storage.crossSessionQueueMail;
      if (!candidate || !mail) return candidate === undefined;
      const {
        targetSessionId,
        submissionId,
        messageId,
        sequence,
        fundingRunId,
        backupReservationId,
      } = candidate;
      return input.owner.runWithSessionExecution(targetSessionId, async () => {
        const target = input.owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
        const model = target?.modelInvocations[invocationId];
        const reservationId =
          model?.budget.kind === 'reservation' ? model.budget.reservationId : '';
        const reservation =
          target?.resourceBudget.status === 'active'
            ? target.resourceBudget.reservations[reservationId]
            : undefined;
        if (
          !target ||
          target.turn.status !== 'active' ||
          !target.activeTaskId ||
          !model ||
          model.status !== 'prepared' ||
          model.attempts !== 0 ||
          model.limits.maxAttempts !== 1 ||
          model.limits.perAttemptTimeoutMs !== 60_000 ||
          model.limits.totalTimeBudgetMs !== 60_000 ||
          !reservation ||
          reservation.state !== 'reserved' ||
          reservation.runId !== target.turn.turnId
        )
          return false;
        const accepted = mail.readFollowupAdmissionForTarget(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        );
        if (!accepted || accepted.messageId !== messageId) return false;
        const admission = JSON.parse(
          accepted.admission.canonicalJson,
        ) as CrossSessionFollowupAdmission & {
          preparedTool?: RootFollowupPolicyEvidence['preparedTool'];
        };
        input.detachedScope.runInAsyncScope(() =>
          input.owner.runWithSessionExecution(input.parentSessionId, () => {
            const parent = ensureParent();
            const source = parent.getState();
            assertCurrentSourceFollowupPolicy(source, admission, messageId, submissionId);
            if (parent.getState().revision !== source.revision)
              throw new Error('Current source TriggerTurn policy proof became stale.');
          }),
        );
        const routed: Extract<RuntimeEvent, { type: 'agent.followup_routed' }> = {
          type: 'agent.followup_routed',
          submissionId,
          targetAgentId: targetSessionId,
          route: 'current_turn',
          taskId: target.activeTaskId,
          invocationId,
          modelAdmissionId: reservationId,
          reservationId,
          fundingRunId,
          sequence,
        };
        const prepared: Extract<RuntimeEvent, { type: 'agent.mail_input_prepared' }> = {
          type: 'agent.mail_input_prepared',
          targetAgentId: targetSessionId,
          invocationId,
          modelAdmissionId: reservationId,
          fromSequence: sequence - 1,
          throughSequence: sequence,
          messageIds: [messageId],
        };
        const routeMutation = {
          kind: 'route_followup',
          sourceSessionId: input.parentSessionId,
          messageId,
          submissionId,
          route: 'current_turn',
          targetRunId: target.turn.turnId,
          taskId: target.activeTaskId,
          invocationId,
          modelAdmissionId: reservationId,
          reservationId,
          createdAtMs: Date.now(),
        } as const;
        const committed = await commitRoute([routed, prepared], routeMutation);
        if (committed.length !== 2) return false;
        const route = mail.readFollowupRoute(targetSessionId, submissionId);
        if (!route || route.route !== 'current_turn') return false;
        if (
          !mail.readCurrentTurnBackupReleaseForTarget(
            targetSessionId,
            input.parentSessionId,
            submissionId,
          )
        ) {
          try {
            input.detachedScope.runInAsyncScope(() =>
              input.owner.runWithSessionExecution(input.parentSessionId, () => {
                const parent = ensureParent();
                const source = parent.getState();
                const outbox = mail.readOutbox(input.parentSessionId, messageId);
                const backup = fundingBudgetForRun(source, fundingRunId)?.reservations[
                  backupReservationId
                ];
                if (
                  outbox?.targetSessionId !== targetSessionId ||
                  (backup?.state !== 'queued' && backup?.state !== 'reserved') ||
                  backup?.reservationId !== backupReservationId
                )
                  throw new Error('Current-turn backup lacks its exact source reservation.');
                parent.session.commitCrossSessionFollowupFunding(
                  [{ type: 'resource_budget.released', reservationId: backup.reservationId }],
                  {
                    kind: 'release_current_turn_backup',
                    targetSessionId,
                    submissionId,
                    targetRunId: target.turn.turnId,
                    invocationId,
                    modelAdmissionId: reservationId,
                    reservationId,
                    targetRevision: route.routedRevision,
                    createdAtMs: Date.now(),
                  },
                );
              }),
            );
          } catch (error) {
            if (
              !mail.readCurrentTurnBackupReleaseForTarget(
                targetSessionId,
                input.parentSessionId,
                submissionId,
              )
            )
              throw error;
          }
        }
        const ack = mail.readCurrentTurnBackupReleaseForTarget(
          targetSessionId,
          input.parentSessionId,
          submissionId,
        );
        return ack?.invocationId === invocationId;
      });
    },
    beforeDispatch: async (invocationId) => {
      const candidate = currentTurnCandidates.get(invocationId);
      if (!candidate) return true;
      const mail = input.owner.storage.crossSessionQueueMail;
      if (!mail) return false;
      return input.owner.runWithSessionExecution(candidate.targetSessionId, () => {
        const ack = mail.readCurrentTurnBackupReleaseForTarget(
          candidate.targetSessionId,
          input.parentSessionId,
          candidate.submissionId,
        );
        return ack?.invocationId === invocationId && ack.reservationId.length > 0;
      });
    },
  });
  const pendingDelegationReservations = (): readonly string[] => {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = input.owner.listPendingChildSessionIntents(input.parentSessionId, 100, cursor);
      for (const listed of page.entries) {
        const intent = input.owner.readChildSessionIntent(listed.childThreadId);
        if (
          intent &&
          JSON.stringify(intent) === JSON.stringify(listed) &&
          intent.parentSessionId === input.parentSessionId &&
          intent.disposition === 'required' &&
          !intent.failureReceiptDigest &&
          !intent.parentClaimSettledEventId &&
          intent.delegatedReservationId === `child-allotment:${intent.childThreadId}`
        )
          ids.push(intent.delegatedReservationId);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return Object.freeze(ids);
  };
  const pendingAfterTurnDelegations = () => {
    const state = input.owner.storage.sessions.loadSnapshot<RuntimeState>(input.parentSessionId);
    if (!state) return [];
    const proofs: NonNullable<
      import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preservePendingAfterTurnDelegations']
    >[number][] = [];
    let cursor: string | undefined;
    do {
      const page = input.owner.listPendingChildSessionIntents(input.parentSessionId, 100, cursor);
      for (const listed of page.entries) {
        const intent = input.owner.readChildSessionIntent(listed.childThreadId);
        if (
          !intent ||
          JSON.stringify(intent) !== JSON.stringify(listed) ||
          intent.parentSessionId !== input.parentSessionId ||
          intent.disposition !== 'after_turn' ||
          intent.failureReceiptDigest ||
          intent.parentClaimSettledEventId ||
          intent.dispatchAckEventId ||
          intent.delegatedReservationId !== `child-allotment:${intent.childThreadId}`
        )
          continue;
        const funding = fundingBudgetForRun(state, intent.fundingRunId);
        const delegated = funding?.reservations[intent.delegatedReservationId];
        const report = Object.values(funding?.reservations ?? {}).find(
          (reservation) =>
            reservation.invocationId === `model-invocation:after-turn:${intent.childInvocationId}`,
        );
        if (
          (delegated?.state === 'reserved' || delegated?.state === 'queued') &&
          report?.state === 'reserved'
        )
          proofs.push({
            childThreadId: intent.childThreadId,
            parentInvocationId: intent.parentInvocationId,
            childInvocationId: intent.childInvocationId,
            fundingRunId: intent.fundingRunId,
            delegatedReservationId: intent.delegatedReservationId,
            reportReservationId: report.reservationId,
          });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return Object.freeze(proofs);
  };
  const liveAfterTurnDelegations = () => {
    const state = input.owner.storage.sessions.loadSnapshot<RuntimeState>(input.parentSessionId);
    if (!state) return [];
    const proofs: NonNullable<
      import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preserveLiveAfterTurnDelegations']
    >[number][] = [];
    for (const [childThreadId, controller] of new Map([...queuedChildren, ...activeChildren])) {
      const intent = input.owner.readChildSessionIntent(childThreadId);
      if (!intent || intent.parentSessionId !== input.parentSessionId) continue;
      const authority = input.owner.readChildExecutionAuthority(
        input.parentSessionId,
        childThreadId,
      );
      const child = input.owner.storage.sessions.loadSnapshot<RuntimeState>(childThreadId);
      if (
        controller.signal.aborted ||
        !input.owner.ownsSessionExecution(childThreadId) ||
        intent.disposition !== 'after_turn' ||
        intent.failureReceiptDigest ||
        intent.parentClaimSettledEventId ||
        !intent.dispatchAckEventId ||
        !intent.dispatchAckRevision ||
        authority?.status !== 'active' ||
        authority.hostInstanceId !== input.owner.hostInstanceId ||
        authority.cleanupConfirmed ||
        !child ||
        child.childSessionOrigin?.parentSessionId !== input.parentSessionId ||
        child.childSessionOrigin.childInvocationId !== intent.childInvocationId ||
        child.childSessionOrigin.terminal
      )
        continue;
      const funding = fundingBudgetForRun(state, intent.fundingRunId);
      const delegated = funding?.reservations[intent.delegatedReservationId];
      const report = Object.values(funding?.reservations ?? {}).find(
        (reservation) =>
          reservation.invocationId === `model-invocation:after-turn:${intent.childInvocationId}`,
      );
      if (delegated?.state === 'dispatch_started' && report?.state === 'reserved')
        proofs.push({
          childThreadId,
          parentInvocationId: intent.parentInvocationId,
          childInvocationId: intent.childInvocationId,
          fundingRunId: intent.fundingRunId,
          delegatedReservationId: intent.delegatedReservationId,
          reportReservationId: report.reservationId,
          dispatchAckEventId: intent.dispatchAckEventId,
          dispatchAckRevision: intent.dispatchAckRevision,
          controllerGeneration: authority.controllerGeneration,
        });
    }
    return Object.freeze(proofs);
  };
  const sealedAfterTurnReports = () => {
    const state = input.owner.storage.sessions.loadSnapshot<RuntimeState>(input.parentSessionId);
    if (!state) return [];
    const proofs: NonNullable<
      import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preserveSealedAfterTurnReports']
    >[number][] = [];
    let cursor: string | undefined;
    do {
      const page = input.owner.listPendingChildSessionIntents(input.parentSessionId, 100, cursor);
      for (const intent of page.entries) {
        if (
          intent.parentSessionId !== input.parentSessionId ||
          intent.disposition !== 'after_turn' ||
          intent.failureReceiptDigest ||
          intent.parentClaimSettledEventId ||
          !intent.dispatchAckEventId
        )
          continue;
        const seal = input.owner.readPendingAfterTurnChildTerminalSeal(
          input.parentSessionId,
          intent.childThreadId,
        );
        const funding = fundingBudgetForRun(state, intent.fundingRunId);
        const report = Object.values(funding?.reservations ?? {}).find(
          (reservation) =>
            reservation.invocationId === `model-invocation:after-turn:${intent.childInvocationId}`,
        );
        if (!seal || report?.state !== 'reserved') continue;
        proofs.push({
          childThreadId: intent.childThreadId,
          parentInvocationId: intent.parentInvocationId,
          childInvocationId: intent.childInvocationId,
          fundingRunId: intent.fundingRunId,
          delegatedReservationId: intent.delegatedReservationId,
          reportReservationId: report.reservationId,
          sealEventId: seal.sealEventId,
          sealRevision: seal.sealRevision,
          terminalReceiptId: seal.terminalReceiptId,
          status: seal.status,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return Object.freeze(proofs);
  };
  const ensureParent = () => {
    const current = input.coordinators.get(input.parentSessionId);
    if (current) return current;
    const state = input.owner.storage.sessions.loadSnapshot<RuntimeState>(input.parentSessionId);
    if (
      !state ||
      state.session.threadId !== input.parentSessionId ||
      !/^sha256:[a-f0-9]{64}$/u.test(state.session.canonicalWorkspaceDigest ?? '')
    )
      throw new Error('Independent child parent Session State is unavailable.');
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    return input.coordinators.ensure({
      sessionId: input.parentSessionId,
      userId: state.session.userId,
      workspace: state.session.workspace,
      projectId: state.session.projectId!,
      canonicalWorkspaceDigest: state.session.canonicalWorkspaceDigest as `sha256:${string}`,
      interactionMode: state.mode,
      recoveryIdentityKey: state.toolRecovery.identityKey,
      sandboxAvailable: appSandboxBackendAvailable(input.bridgeInput.sandboxBackend),
      modelArtifactEvidence: runtime.evidence,
      capabilityArtifactEvidence: runtime.capabilityArtifacts,
      preserveReservedChildDelegations: pendingDelegationReservations(),
      preservePendingAfterTurnDelegations: pendingAfterTurnDelegations(),
      preserveLiveAfterTurnDelegations: liveAfterTurnDelegations(),
      preserveSealedAfterTurnReports: sealedAfterTurnReports(),
      preservePendingFollowupFunding: input.bridgeInput.pendingFollowupFunding?.() ?? [],
      preserveDispatchedChildDelegations: input.bridgeInput.dispatchedChildRecoveryProofs?.() ?? [],
      preservePreparedFollowupModels: input.bridgeInput.preparedFollowupRecoveryProofs?.() ?? [],
      preservePreparedCurrentTurnModels:
        input.bridgeInput.preparedCurrentTurnRecoveryProofs?.() ?? [],
    });
  };
  const childTurnFor = (
    state: Readonly<RuntimeState>,
    modelRuntime: ReturnType<typeof input.modelRuntimeFactory>,
    signal: AbortSignal,
  ): ChildTurn => ({
    userId: state.session.userId,
    threadId: state.session.threadId,
    workspace: state.session.workspace,
    recoveryIdentityKey: state.toolRecovery.identityKey,
    capabilityExecution: input.capabilityExecution,
    modelInvocationRuntime: modelRuntime,
    config: input.bridgeInput.config,
    model: createChatModel(input.bridgeInput.config),
    shellExecutor: input.bridgeInput.shellExecutor,
    mcpManager: input.bridgeInput.mcpManager,
    interactionMode: state.mode,
    sandboxBackend: input.bridgeInput.sandboxBackend,
    frontend: 'cli',
    signal,
    sessionLoggingPolicy: input.bridgeInput.config.sessionLoggingPolicy,
    sessionLoggingContentInspector: createModelSecretDetector({
      knownSecrets: [input.bridgeInput.config.apiKey],
    }),
    skillOptions: input.bridgeInput.skillOptions,
    skills: input.bridgeInput.skillManifests ? [...input.bridgeInput.skillManifests] : [],
    ...(input.bridgeInput.crossSessionQueueMail === undefined
      ? {}
      : { crossSessionQueueMail: input.bridgeInput.crossSessionQueueMail }),
    currentTurnFollowup: currentTurnFollowupForTarget(state.session.threadId),
  });
  const approvalProxy = createChildApprovalProxyOwner({
    owner: input.owner,
    parentSessionId: input.parentSessionId,
    getParentState: () => ensureParent().getState(),
    publishParentEvent: (event) => {
      if (!publishParentApprovalWake)
        throw new Error('Child approval parent wake has no bound Bridge publisher.');
      input.detachedScope.runInAsyncScope(() =>
        input.owner.runWithSessionExecution(input.parentSessionId, () =>
          publishParentApprovalWake!(event),
        ),
      );
    },
  });
  const importSealed = async (
    childThreadId: string,
    preDispatchAlreadyImported = false,
  ): Promise<void> => {
    const parent = ensureParent();
    const intent = input.owner.readChildSessionIntent(childThreadId);
    if (!parent || !intent || intent.parentSessionId !== input.parentSessionId)
      throw new Error('Child terminal import lost its exact parent intent.');
    const parentState = parent.getState();
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    const parentOwnerKey = backgroundSubagentOwnerKey(
      input.parentSessionId,
      parentState.toolRecovery.identityKey,
    );
    const sealedGrant =
      intent.disposition === 'after_turn'
        ? input.owner.runWithSessionExecution(input.parentSessionId, () =>
            input.owner.readChildSealedGrant(childThreadId),
          )
        : null;
    const phaseValue = sealedGrant
      ? (JSON.parse(sealedGrant.sealedGrantJson) as { authorization?: { phase?: unknown } })
          .authorization?.phase
      : undefined;
    const afterTurnPhase =
      phaseValue === 'planning' || phaseValue === 'building' ? phaseValue : undefined;
    if (!preDispatchAlreadyImported)
      input.owner.runWithSessionExecution(input.parentSessionId, () =>
        importChildTerminalResult({
          parentState,
          readChildState: (id) => {
            const state = input.owner.storage.sessions.loadSnapshot<RuntimeState>(id);
            if (!state) throw new Error('Child terminal State is unavailable.');
            return state;
          },
          childThreadId,
          parentInvocationId: intent.parentInvocationId,
          parentOwnerKey,
          artifacts: runtime.childResultArtifacts,
          ...(intent.disposition === 'after_turn' ? { afterTurnPhase } : {}),
          commitImport: (proof) => parent.commitChildSessionTerminalImport(proof),
        }),
      );
    if (intent.disposition !== 'after_turn') return;
    const current = parent.getState();
    const lifecycle =
      current.capabilities.invocations[intent.parentInvocationId]?.subagentProviderLifecycle;
    const link = lifecycle?.childSession;
    const result = lifecycle?.backgroundResult;
    const funding = fundingBudgetForRun(current, intent.fundingRunId);
    const reservation = Object.values(funding?.reservations ?? {}).find(
      (candidate) =>
        candidate.invocationId === `model-invocation:after-turn:${intent.childInvocationId}`,
    );
    if (link?.childThreadId !== childThreadId || !link.terminalImport || !funding || !reservation)
      throw new Error('After-turn child import lost its report funding.');
    if (reservation.state !== 'reserved') return;
    if (!result?.afterTurn) {
      const released = input.owner.runWithSessionExecution(input.parentSessionId, () =>
        parent.control.processEventBatch([
          { type: 'resource_budget.released', reservationId: reservation.reservationId },
        ]),
      );
      if (released.length !== 1)
        throw new Error('After-turn terminal report funding was not released.');
      return;
    }
    if (result.afterTurn.reservationId !== reservation.reservationId)
      throw new Error('After-turn result changed its report reservation.');
    const continuation = runtime.afterTurnContinuationRuntime;
    if (!continuation) throw new Error('After-turn scheduler is unavailable.');
    const owned = runtime.childResultArtifacts.lookup(parentOwnerKey, intent.childInvocationId);
    if (
      !owned ||
      owned.ref.integrityIdentifier !== result.artifactIntegrityIdentifier ||
      owned.ref.integrityIdentifier !== link.terminalImport.resultRef.integrityIdentifier
    )
      throw new Error('After-turn report has no exact child result Artifact.');
    const summary = owned.result.summary;
    void continuation
      .deliver({
        sessionId: input.parentSessionId,
        admissionRevision: result.afterTurn.admissionRevision,
        phase: result.afterTurn.phase,
        attempt: result.attempt,
        reservation: {
          reservationId: reservation.reservationId,
          originRunId: result.originRunId,
          deadlineAt: funding.deadlineAt,
          preparationEvents: [],
        },
        notification: {
          notificationId: result.notificationId,
          source: 'subagent',
          modelRole: 'user',
          ownerKey: parentOwnerKey,
          taskId: result.taskId,
          originRunId: result.originRunId,
          originTurnId: result.originTurnId,
          originToolCallId: result.originToolCallId,
          attempt: result.attempt,
          status: result.afterTurn.status,
          shortReport: typeof summary === 'string' ? summary.slice(0, 2_000) : '',
          resultArtifact: owned.ref,
          cancelRequested: result.afterTurn.cancelRequested,
        },
        persistEvents: async (events) =>
          input.owner.runWithSessionExecution(
            input.parentSessionId,
            () => parent.control.processEventBatch([...events]).length === events.length,
          ),
      })
      .catch((error) => {
        console.error('After-turn child report delivery requires recovery.', {
          childThreadId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      });
  };
  const launch = async (
    accepted: LaunchChild,
    parentSignal?: AbortSignal,
    queuedAbort?: AbortController,
  ): Promise<void> => {
    if (accepted.parentSessionId !== input.parentSessionId)
      throw new Error('Independent child parent identity changed.');
    const parent = input.coordinators.get(input.parentSessionId);
    if (!parent) throw new Error('Accepted child lost its parent coordinator.');
    const intent = input.owner.readChildSessionIntent(accepted.childThreadId);
    if (!intent || intent.parentSessionId !== input.parentSessionId)
      throw new Error('Accepted child has no exact Store intent.');
    if (intent.dispatchAckEventId) {
      let fenced = input.owner.ownsSessionExecution(accepted.childThreadId);
      await input.owner.reconcileInterruptedSession(
        accepted.childThreadId,
        async (_generation, assertCurrent) => {
          if (!assertCurrent()) throw new Error('Recovered child lost its execution generation.');
          fenced = true;
          return undefined;
        },
      );
      if (!fenced) throw new Error('Recovered child still has a live previous execution owner.');
      const latestIntent = input.owner.readChildSessionIntent(accepted.childThreadId);
      if (JSON.stringify(latestIntent) !== JSON.stringify(intent))
        throw new Error('Recovered child intent changed while fencing its previous owner.');
    }
    const sealed = input.owner.runWithSessionExecution(input.parentSessionId, () =>
      input.owner.readChildSealedGrant(accepted.childThreadId),
    );
    if (!sealed) throw new Error('Accepted child sealed grant is unavailable.');
    const fullIntent = { ...intent, ...sealed };
    const modelRuntime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    const funding = fundingBudgetForRun(parent.getState(), intent.fundingRunId);
    const allotment = funding?.reservations[intent.delegatedReservationId];
    const independentTurn =
      allotment?.resourceKind === 'subagent' &&
      allotment.runId === intent.fundingRunId &&
      allotment.executableUpperBound.independentChildTurnDeadline === true &&
      childDelegatedUpperBoundDigest(allotment.executableUpperBound) ===
        intent.delegatedUpperBoundDigest;
    const queuedDeadlineAt = independentTurn
      ? (JSON.parse(sealed.sealedGrantJson) as { expiresAtMs?: number }).expiresAtMs
      : Date.parse(intent.deadlineAt);
    if (typeof queuedDeadlineAt !== 'number' || !Number.isSafeInteger(queuedDeadlineAt))
      throw new Error('Accepted child has no finite signed queue deadline.');
    if (intent.failureReceiptDigest || intent.parentClaimSettledEventId)
      throw new Error('Accepted child is already settled.');
    if (!intent.dispatchAckEventId && !intent.childSessionCreated) {
      const creation = buildChildSessionCreation({
        intent: fullIntent,
        parentState: parent.getState(),
        admittedWorkspace: input.bridgeInput.workspace,
        parentModelRoute: input.owner.storage.sessions.getSessionModelRoute(
          input.parentSessionId,
        ) ?? {
          provider: input.bridgeInput.config.providerName,
          name: input.bridgeInput.config.modelName,
        },
        workerInstanceId: input.owner.hostInstanceId,
        executionClientId: input.owner.executionClientId,
        executionConnectionGeneration: input.owner.executionConnectionGeneration,
        nowMs: Date.now(),
      });
      input.owner.createChildSession(creation);
    }
    if (!intent.dispatchAckEventId) {
      for (;;) {
        const current = parent.getState();
        const funding = fundingBudgetForRun(current, intent.fundingRunId);
        const reservation = funding?.reservations[intent.delegatedReservationId];
        if (queuedAbort?.signal.aborted) throw new Error('Queued child was cancelled.');
        if (reservation?.state === 'reserved') break;
        if (reservation?.state !== 'queued' || !funding)
          throw new Error('Queued child lost its exact parent allotment.');
        if (
          (parentSignal?.aborted &&
            (!independentTurn || runtimeAbortCause(parentSignal.reason) === 'user')) ||
          queuedAbort?.signal.aborted ||
          Date.now() >=
            (independentTurn
              ? queuedDeadlineAt
              : Math.min(Date.parse(intent.deadlineAt), Date.parse(funding.deadlineAt)))
        )
          throw new Error('Queued child was stopped or its deadline elapsed.');
        const committed = committedResourceUsage(funding);
        const upper = reservation.executableUpperBound.gauges;
        if (
          committed.gauges.activeSubagents + upper.activeSubagents <=
            funding.budget.maxConcurrentSubagents &&
          committed.gauges.activeWriters + upper.activeWriters <=
            funding.budget.maxConcurrentWriters &&
          committed.gauges.activeToolInvocations + upper.activeToolInvocations <=
            funding.budget.maxConcurrentToolInvocations &&
          committed.gauges.activeShellInvocations + upper.activeShellInvocations <=
            funding.budget.maxConcurrentShellInvocations
        ) {
          input.owner.runWithSessionExecution(input.parentSessionId, () =>
            parent.commitChildSlotAcquisition(intent.delegatedReservationId),
          );
          continue;
        }
        if (!parent.session.waitForRevisionChange)
          throw new Error('Queued child has no parent revision wait port.');
        const wait = new AbortController();
        const abort = () => wait.abort();
        const abortFromParentWait = () => {
          if (!independentTurn || runtimeAbortCause(parentSignal?.reason) === 'user') abort();
        };
        parentSignal?.addEventListener('abort', abortFromParentWait, { once: true });
        queuedAbort?.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, Math.min(1000, queuedDeadlineAt - Date.now()));
        try {
          await parent.session.waitForRevisionChange(current.revision, wait.signal);
        } finally {
          clearTimeout(timer);
          parentSignal?.removeEventListener('abort', abortFromParentWait);
          queuedAbort?.signal.removeEventListener('abort', abort);
        }
      }
    }
    const parentState = parent.getState();
    const runId = childRunId(accepted.childThreadId);
    const evidence = {
      scopeSessionId: accepted.childThreadId,
      commandId: `activate-child:${accepted.childThreadId}`,
      requestDigest: createHash('sha256')
        .update(JSON.stringify(['kite.child-activate.v1', accepted.childThreadId, runId]))
        .digest('hex'),
      targetSessionId: accepted.childThreadId,
      committedAt: Date.now(),
    };
    const inspectGrant = (serialized: unknown) =>
      modelRuntime.inspectChildStartGrant(serialized as SubagentDelegationGrant);
    const inspectActivatedGrant = (serialized: unknown) =>
      modelRuntime.inspectActivatedChildStartGrant(serialized as SubagentDelegationGrant);
    const grant = intent.dispatchAckEventId
      ? (() => {
          if (allotment?.state !== 'dispatch_started')
            throw new Error('Acknowledged child lost its parent allotment.');
          const inspected = inspectActivatedGrant(JSON.parse(sealed.sealedGrantJson) as unknown);
          const childState = input.owner.storage.sessions.loadSnapshot<RuntimeState>(
            accepted.childThreadId,
          );
          if (!childState) throw new Error('Acknowledged child State is unavailable.');
          const recovery = classifyChildFirstTurnRecovery({
            childState,
            intent,
            grant: inspected,
            nowMs: Date.now(),
            independentTurnDeadline: independentTurn,
          });
          if (recovery.kind !== 'begin_first_turn')
            throw new Error(`Acknowledged child cannot restart: ${recovery.kind}.`);
          return inspected;
        })()
      : (() => {
          if (!accepted.childBudget || !accepted.childDeadlineAt)
            throw new Error('Child activation has no recoverable finite budget.');
          const creation = buildChildSessionCreation({
            intent: fullIntent,
            parentState,
            admittedWorkspace: input.bridgeInput.workspace,
            parentModelRoute: input.owner.storage.sessions.getSessionModelRoute(
              input.parentSessionId,
            ) ?? {
              provider: input.bridgeInput.config.providerName,
              name: input.bridgeInput.config.modelName,
            },
            workerInstanceId: input.owner.hostInstanceId,
            executionClientId: input.owner.executionClientId,
            executionConnectionGeneration: input.owner.executionConnectionGeneration,
            nowMs: Date.now(),
          });
          return activateAcceptedChildSession({
            owner: input.owner,
            parent,
            ensureChild: () => ensureChild(accepted.childThreadId, modelRuntime),
            creation,
            childBudget: accepted.childBudget,
            childDeadlineAt: accepted.childDeadlineAt,
            childRunId: runId,
            evidence,
            inspectGrant,
            startedAt: Date.now(),
          });
        })();
    const childAbort = new AbortController();
    const abortFromParent = () => {
      if (independentTurn && runtimeAbortCause(parentSignal?.reason) !== 'user') return;
      input.detachedScope.runInAsyncScope(() => {
        childAbort.abort(parentSignal?.reason);
      });
    };
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const child = ensureChild(accepted.childThreadId, modelRuntime);
    const childState = child.getState();
    const childTurn = childTurnFor(childState, modelRuntime, childAbort.signal);
    const descriptor = {
      sessionId: accepted.childThreadId,
      committedRevision: childState.revision,
      childRunId: runId,
      parentSessionId: intent.parentSessionId,
      parentInvocationId: intent.parentInvocationId,
      parentToolCallId: intent.originToolCallId,
      attempt: intent.attempt,
      childInvocationId: intent.childInvocationId,
      grantDigest: intent.grantDigest,
      taskArtifactId: intent.taskArtifactId,
      taskArtifactByteLength: intent.taskArtifactByteLength,
      taskArtifactDigest: intent.taskArtifactDigest,
      taskTextDigest: intent.taskTextDigest,
      fundingRunId: intent.fundingRunId,
      delegatedReservationId: intent.delegatedReservationId,
      delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
    };
    if (activeChildren.has(accepted.childThreadId))
      throw new Error('Independent child already has a live local runner.');
    activeChildren.set(accepted.childThreadId, childAbort);
    let output = '';
    const publishChildEvent = (event: RuntimeEvent): void => {
      const revision = child.revisionForEvent?.(event);
      if (revision === undefined) {
        publishChildPresentation(child, event, { runId, taskId: intent.childInvocationId });
        return;
      }
      publishChildCommittedThrough(child, revision, { runId, taskId: intent.childInvocationId });
    };
    try {
      await input.owner.runWithSessionExecution(accepted.childThreadId, async () => {
        for await (const event of runAcceptedChildSession({
          owner: input.owner,
          child,
          descriptor,
          grant,
          turn: childTurn,
          consumeStartGrant: modelRuntime.consumeChildStartGrant,
          ...(intent.dispatchAckEventId
            ? { activatedRecovery: { independentTurnDeadline: independentTurn } }
            : {}),
          actionProvider: createChildApprovalActionProvider({
            owner: input.owner,
            parentSessionId: input.parentSessionId,
            proxyOwner: approvalProxy,
            signal: childAbort.signal,
            onProxyOpened: (proxy) => approvalProxy.publishRequested(proxy),
          }),
        })) {
          publishChildEvent(event);
          if (event.type === 'run.completed') output = event.output;
        }
        await child.waitForIdle();
        const state = child.getState();
        const result = childTerminalResult(state, output);
        sealChildTerminalResult({
          getChildState: () => child.getState(),
          artifacts: modelRuntime.childResultArtifacts,
          parentOwnerKey: backgroundSubagentOwnerKey(
            input.parentSessionId,
            parentState.toolRecovery.identityKey,
          ),
          result,
          cleanupConfirmed: true,
          cancelRequested: state.turn.abortCause === 'user',
          terminalReceiptId: `child-terminal:${accepted.childThreadId}:${state.revision}`,
          commitSeal: (event) => child.session.commitChildSessionTerminalSeal(event),
        });
        const sealed = child.getState().childSessionOrigin?.terminal;
        if (!sealed) throw new Error('Current-turn terminal notification has no child seal.');
        const settledStatus =
          child.getState().terminalOutcome?.status === 'unknown' || sealed.status === 'unknown'
            ? 'unknown'
            : sealed.status === 'completed'
              ? 'completed'
              : sealed.status === 'cancelled'
                ? 'cancelled'
                : 'failed';
        const childEvents = input.owner.storage.sessions
          .loadEventsStrict(accepted.childThreadId)
          .map(({ event }) => event);
        for (const route of childEvents) {
          if (
            route.type !== 'agent.followup_routed' ||
            route.route !== 'current_turn' ||
            route.targetAgentId !== accepted.childThreadId ||
            route.taskId !== child.getState().childSessionOrigin?.childInvocationId
          )
            continue;
          const prior = childEvents.filter(
            (event) =>
              event.type === 'agent.followup_turn_settled' &&
              event.submissionId === route.submissionId,
          );
          if (prior.length > 1) throw new Error('Current-turn terminal notification conflicts.');
          if (prior.length === 0)
            child.session.commitChildCurrentTurnFollowupSettlement({
              type: 'agent.followup_turn_settled',
              sourceSessionId: input.parentSessionId,
              submissionId: route.submissionId,
              targetRunId: child.getState().turn.turnId,
              taskId: route.taskId,
              status: settledStatus,
            });
        }
      });
      await importSealed(accepted.childThreadId);
      const terminalMail = input.owner.storage.crossSessionQueueMail;
      if (terminalMail) {
        const settled = input.owner.storage.sessions
          .loadEventsStrict(accepted.childThreadId)
          .flatMap(({ event }) =>
            event.type === 'agent.followup_turn_settled' &&
            event.taskId === accepted.childInvocationId &&
            event.status !== 'unknown'
              ? [event]
              : [],
          );
        for (const event of settled) {
          try {
            const reply = input.owner.runWithSessionExecution(accepted.childThreadId, () =>
              terminalMail.acceptFollowupTerminalReply(
                accepted.childThreadId,
                input.parentSessionId,
                event.submissionId,
                Date.now(),
              ),
            );
            input.scheduleTerminalReplyDelivery?.(accepted.childThreadId, reply.messageId);
          } catch (error) {
            console.error('Current-turn terminal reply requires recovery.', {
              childThreadId: accepted.childThreadId,
              submissionId: event.submissionId,
              errorName: error instanceof Error ? error.name : 'UnknownError',
            });
          }
        }
      }
      await input.owner.releaseSessionExecution(accepted.childThreadId, () =>
        input.coordinators.release(accepted.childThreadId),
      );
    } finally {
      try {
        clearSettledChildStream(child, runId);
      } catch {
        // The coordinator may have been released after a sealed terminal.
        for (const key of childStreamSequences.keys())
          if (key.startsWith(`${accepted.childThreadId}\0`)) childStreamSequences.delete(key);
      }
      activeChildren.delete(accepted.childThreadId);
      for (const [invocationId, candidate] of currentTurnCandidates)
        if (candidate.targetSessionId === accepted.childThreadId)
          currentTurnCandidates.delete(invocationId);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };
  const settlePreDispatchFailure = async (
    accepted: Pick<AcceptedChildSession, 'childThreadId'>,
    cancelled = false,
  ): Promise<void> => {
    const intent = input.owner.readChildSessionIntent(accepted.childThreadId);
    if (!intent || intent.dispatchAckEventId) return;
    const parent = ensureParent();
    if (intent.childSessionCreated) {
      if (!input.owner.ownsSessionExecution(accepted.childThreadId))
        input.owner.runWithSessionExecution(accepted.childThreadId, () => undefined);
      await input.owner.releaseSessionExecution(accepted.childThreadId, () =>
        input.coordinators.release(accepted.childThreadId),
      );
    }
    const parentState = parent.getState();
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    const sealedGrant =
      intent.disposition === 'after_turn'
        ? input.owner.runWithSessionExecution(input.parentSessionId, () =>
            input.owner.readChildSealedGrant(accepted.childThreadId),
          )
        : null;
    const phaseValue = sealedGrant
      ? (JSON.parse(sealedGrant.sealedGrantJson) as { authorization?: { phase?: unknown } })
          .authorization?.phase
      : undefined;
    const afterTurnPhase =
      phaseValue === 'planning' || phaseValue === 'building' ? phaseValue : undefined;
    input.owner.runWithSessionExecution(input.parentSessionId, () =>
      settleAcceptedChildCreationFailure({
        parentState,
        childThreadId: accepted.childThreadId,
        parentOwnerKey: backgroundSubagentOwnerKey(
          input.parentSessionId,
          parentState.toolRecovery.identityKey,
        ),
        readIntent: input.owner.readChildSessionIntent,
        readPreDispatchChildProof: (id) =>
          input.owner.readChildPreDispatchProof(input.parentSessionId, id),
        artifacts: runtime.childResultArtifacts,
        commitFailure: (proof) => parent.commitChildCreationFailure(proof),
        cancelled,
        ...(intent.disposition === 'after_turn' ? { afterTurnPhase } : {}),
      }),
    );
    if (intent.disposition === 'after_turn') await importSealed(accepted.childThreadId, true);
  };
  const resumePreparedCurrentTurnModel = async (
    intent: NonNullable<ReturnType<typeof input.owner.readChildSessionIntent>>,
  ): Promise<void> => {
    const targetSessionId = intent.childThreadId;
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail) throw new Error('Current-turn recovery has no Store proof reader.');
    const routes = input.owner.storage.sessions
      .loadEventsStrict(targetSessionId)
      .flatMap(({ event }) =>
        event.type === 'agent.followup_routed' &&
        event.route === 'current_turn' &&
        event.targetAgentId === targetSessionId
          ? [event]
          : [],
      );
    if (routes.length !== 1)
      throw new Error('Current-turn recovery has no unique routed Model identity.');
    const route = routes[0]!;
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    const config = targetModelConfig(targetSessionId);
    if (!config) throw new Error('Current-turn recovery has no persisted target Model route.');
    const parentOwnerKey = input.detachedScope.runInAsyncScope(() =>
      input.owner.runWithSessionExecution(input.parentSessionId, () =>
        backgroundSubagentOwnerKey(
          input.parentSessionId,
          ensureParent().getState().toolRecovery.identityKey,
        ),
      ),
    );
    await input.owner.reconcileInterruptedSession(
      targetSessionId,
      async (generation, assertCurrent) => {
        let proof = mail.readCurrentTurnPreparedNoAttemptProof(
          targetSessionId,
          input.parentSessionId,
          route.submissionId,
        );
        if (!proof) {
          // A crash may separate the target route decision from the source
          // backup release. The source Store mutation rechecks the frozen target
          // Surface and no-attempt facts before it can release that backup.
          const accepted = mail.readFollowupAdmissionForTarget(
            targetSessionId,
            input.parentSessionId,
            route.submissionId,
          );
          const routed = mail.readFollowupRoute(targetSessionId, route.submissionId);
          const admission = accepted
            ? (JSON.parse(accepted.admission.canonicalJson) as {
                backupReservationId?: unknown;
                fundingRunId?: unknown;
              })
            : null;
          if (
            !accepted ||
            !routed ||
            routed.route !== 'current_turn' ||
            routed.invocationId !== route.invocationId ||
            accepted.messageId !== routed.messageId ||
            typeof admission?.backupReservationId !== 'string' ||
            typeof admission.fundingRunId !== 'string'
          )
            throw new Error('Current-turn routed Model has no exact source backup admission.');
          for (let attempt = 0; attempt < 40; attempt += 1) {
            if (stoppingRecovery)
              throw new Error('Current-turn recovery owner stopped before source release.');
            try {
              input.detachedScope.runInAsyncScope(() =>
                input.owner.runWithSessionExecution(input.parentSessionId, () => {
                  const parent = ensureParent();
                  const source = parent.getState();
                  const backup = fundingBudgetForRun(source, admission.fundingRunId as string)
                    ?.reservations[admission.backupReservationId as string];
                  if (backup?.state !== 'queued' && backup?.state !== 'reserved')
                    throw new Error('Current-turn routed source backup cannot be safely released.');
                  parent.session.commitCrossSessionFollowupFunding(
                    [{ type: 'resource_budget.released', reservationId: backup.reservationId }],
                    {
                      kind: 'release_current_turn_backup',
                      targetSessionId,
                      submissionId: route.submissionId,
                      targetRunId: routed.targetRunId,
                      invocationId: routed.invocationId,
                      modelAdmissionId: routed.modelAdmissionId,
                      reservationId: routed.reservationId,
                      targetRevision: routed.routedRevision,
                      createdAtMs: Date.now(),
                    },
                  );
                }),
              );
              break;
            } catch (error) {
              const cause = error instanceof Error ? error.cause : undefined;
              const inner = cause instanceof Error ? cause.cause : undefined;
              if (
                attempt === 39 ||
                !inner ||
                typeof inner !== 'object' ||
                !('code' in inner) ||
                inner.code !== 'unsupported_mutation'
              )
                throw error;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          proof = mail.readCurrentTurnPreparedNoAttemptProof(
            targetSessionId,
            input.parentSessionId,
            route.submissionId,
          );
        }
        if (
          !proof ||
          proof.invocationId !== route.invocationId ||
          proof.targetRunId !== intent.childBudgetActivatedRunId ||
          !assertCurrent()
        )
          throw new Error('Current-turn Model lacks an exact prepared/no-attempt Store proof.');
        const child = ensureChild(targetSessionId, runtime);
        const recovered = await reconcileRuntimeSessionAfterRestart({
          control: child.control,
          modelInvocationRuntime: runtime,
          shellExecutor: input.bridgeInput.shellExecutor,
          historyEvents: input.owner.storage.sessions
            .loadEventsStrict(targetSessionId)
            .map(({ event }) => event),
          preservePreparedCurrentTurnModels: [proof],
          recoveryOwnership: {
            kind: 'fenced_previous_execution',
            controllerGeneration: generation,
            assertCurrent,
          },
        });
        if (!recovered.complete || !assertCurrent())
          throw new Error('Current-turn Model recovery could not retain its exact identity.');
        return undefined;
      },
    );
    await input.owner.runWithSessionExecution(targetSessionId, async () => {
      const proof = mail.readCurrentTurnPreparedNoAttemptProof(
        targetSessionId,
        input.parentSessionId,
        route.submissionId,
      );
      if (
        !proof ||
        proof.invocationId !== route.invocationId ||
        proof.targetRunId !== intent.childBudgetActivatedRunId
      )
        throw new Error('Current-turn Model route/release proof changed before dispatch.');
      const child = ensureChild(targetSessionId, runtime);
      const prepared = child.getState().modelInvocations[proof.invocationId];
      if (
        prepared?.status !== 'prepared' ||
        prepared.attempts !== 0 ||
        prepared.limits.maxAttempts !== 1 ||
        prepared.limits.perAttemptTimeoutMs !== 60_000 ||
        prepared.limits.totalTimeBudgetMs !== 60_000
      )
        throw new Error('Current-turn Model prepared limits changed during recovery.');
      const persistence: ModelInvocationPersistence<RuntimeState, RuntimeEvent> = {
        getState: () => child.getState() as RuntimeState,
        persistEvents: async (events) => {
          if (events.length === 0) return true;
          if (events.some((event) => event.type === 'tool.queued')) return false;
          if (events.some((event) => event.type === 'model.invocation_attempt_started')) {
            const current = mail.readCurrentTurnPreparedNoAttemptProof(
              targetSessionId,
              input.parentSessionId,
              route.submissionId,
            );
            if (!current || current.preparedStateRevision !== child.getState().revision)
              return false;
          }
          return child.session.processEventBatch(events).length === events.length;
        },
      };
      const startedAt = Date.now();
      const pending = await resumeBuiltinPreparedPrimaryModelEffect(runtime.gateway, {
        model: createChatModel(config),
        persistence,
        invocationId: proof.invocationId,
        expectedStateRevision: proof.preparedStateRevision,
        expectedTurnId: proof.targetRunId,
        expectedRouteFingerprint: prepared.routeFingerprint,
        surfaceArtifact: proof.surfaceRef,
        surfaceIntegrityIdentifier: proof.surfaceDigest,
        hardAttemptTimeoutMs: 60_000,
        beforeDispatch: async (identity) => {
          const current = mail.readCurrentTurnPreparedNoAttemptProof(
            targetSessionId,
            input.parentSessionId,
            route.submissionId,
          );
          return Boolean(
            current &&
              identity.sessionId === targetSessionId &&
              identity.invocationId === current.invocationId &&
              identity.turnId === current.targetRunId &&
              identity.reservationId === current.modelReservationId &&
              identity.observedStateRevision === current.preparedStateRevision &&
              identity.surfaceArtifact.artifactId === current.surfaceRef.artifactId &&
              identity.surfaceIntegrityIdentifier === current.surfaceDigest,
          );
        },
      });
      await pending.commitWith((normalized) => {
        const response = normalizedModelResponseToAIMessage(normalized);
        if (
          normalized.finishReason !== 'stop' ||
          (response.tool_calls?.length ?? 0) !== 0 ||
          typeof response.content !== 'string'
        )
          throw new Error('Current-turn resumed Model did not produce one final text.');
        return {
          events: [
            {
              type: 'model.responded',
              invocationId: proof.invocationId,
              messageId: response.id ?? proof.invocationId,
              durationMs: Math.max(0, Date.now() - startedAt),
              toolCalls: [],
              text: response.content,
              ...(normalized.usage.inputTokens === null
                ? {}
                : { inputTokens: normalized.usage.inputTokens }),
              ...(normalized.usage.outputTokens === null
                ? {}
                : { outputTokens: normalized.usage.outputTokens }),
            },
          ],
          value: undefined,
        };
      });
      const completedState = child.getState();
      const decision = runtimeHostStateDecideCompletion(completedState);
      if (
        completedState.turn.turnId !== proof.targetRunId ||
        completedState.activeTaskId !== intent.childInvocationId ||
        completedState.modelInvocations[proof.invocationId]?.status !== 'completed' ||
        decision.status !== 'accepted'
      )
        throw new Error('Current-turn resumed Model has no exact completion proof.');
      const terminal: Extract<RuntimeEvent, { type: 'run.completed' }> = {
        type: 'run.completed',
        turnId: proof.targetRunId,
        output: completedState.transcript.final ?? '',
        completionGuardVersion: decision.version,
        ...(decision.version === 'completion_guard_v2'
          ? { planIdentity: decision.planIdentity }
          : {}),
        outcome: completedTerminalOutcome(),
      };
      if (
        child.session.processEventBatch([
          terminal,
          { type: 'turn.completed', turnId: proof.targetRunId },
        ]).length !== 2
      )
        throw new Error('Current-turn resumed Run terminal did not persist.');
      const state = child.getState();
      sealChildTerminalResult({
        getChildState: () => child.getState(),
        artifacts: runtime.childResultArtifacts,
        parentOwnerKey,
        result: {
          ok: true,
          summary: completedState.transcript.final ?? '',
          terminalStatus: 'completed',
          toolCallCount: Object.keys(state.tools.calls).length,
          durationMs:
            state.resourceBudget.status === 'active'
              ? Math.max(0, Date.now() - Date.parse(state.resourceBudget.startedAt))
              : 0,
        },
        cleanupConfirmed: true,
        cancelRequested: false,
        terminalReceiptId: `child-terminal:${targetSessionId}:${state.revision}`,
        commitSeal: (event) => child.session.commitChildSessionTerminalSeal(event),
      });
      return undefined;
    });
    await importSealed(targetSessionId);
  };
  const cancelAcknowledgedChild = async (
    intent: NonNullable<ReturnType<typeof input.owner.readChildSessionIntent>>,
  ): Promise<void> => {
    const parent = input.coordinators.get(input.parentSessionId);
    if (!parent || !intent.dispatchAckEventId || !intent.childBudgetActivatedRunId)
      throw new Error('Stopped child has no acknowledged parent claim.');
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    await input.owner.reconcileInterruptedSession(
      intent.childThreadId,
      async (_generation, assertCurrent) => {
        const stored = input.owner.storage.sessions.loadSnapshot<RuntimeState>(
          intent.childThreadId,
        );
        const journal = input.owner.storage.sessions.loadEventsStrict(intent.childThreadId);
        if (
          !assertCurrent() ||
          !stored ||
          stored.revision !== 5 ||
          stored.childSessionOrigin?.parentSessionId !== input.parentSessionId ||
          stored.childSessionOrigin.childInvocationId !== intent.childInvocationId ||
          stored.childSessionOrigin.terminal ||
          stored.turn.status !== 'active' ||
          stored.activeTaskId !== intent.childInvocationId ||
          Object.keys(stored.modelInvocations).length > 0 ||
          Object.keys(stored.tools.calls).length > 0 ||
          journal.some(
            ({ event }) =>
              event.type === 'model.invocation_attempt_started' || event.type === 'tool.started',
          )
        )
          throw new Error('Stopped child crossed an external dispatch boundary.');
        const child = ensureChild(intent.childThreadId, runtime);
        if (child.getState().revision !== 5)
          throw new Error('Stopped child restore changed its pre-dispatch State.');
        child.session.processEventBatch(
          [
            {
              type: 'turn.aborted',
              turnId: stored.turn.turnId,
              reason: 'Delegated task stopped before external execution.',
              cause: 'user',
            },
          ],
          { acknowledgement: 'terminal_recovery', source: 'host_fact' },
        );
        sealChildTerminalResult({
          getChildState: () => child.getState(),
          artifacts: runtime.childResultArtifacts,
          parentOwnerKey: backgroundSubagentOwnerKey(
            input.parentSessionId,
            parent.getState().toolRecovery.identityKey,
          ),
          result: {
            ok: false,
            summary: 'Child Session was stopped before external execution.',
            terminalStatus: 'cancelled',
            toolCallCount: 0,
            durationMs: 0,
          },
          cleanupConfirmed: true,
          cancelRequested: true,
          terminalReceiptId: `child-stopped:${intent.childThreadId}`,
          commitSeal: (event) => child.session.commitChildSessionTerminalSeal(event),
        });
        if (!assertCurrent()) throw new Error('Stopped child recovery generation was lost.');
        return undefined;
      },
    );
    await importSealed(intent.childThreadId);
  };
  const resumeChildApproval = async (
    intent: NonNullable<ReturnType<typeof input.owner.readChildSessionIntent>>,
    proxyInteractionId: string,
  ): Promise<void> => {
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    const sealed = input.owner.runWithSessionExecution(input.parentSessionId, () =>
      input.owner.readChildSealedGrant(intent.childThreadId),
    );
    if (
      !sealed ||
      sealed.sealedGrantDigest !== intent.sealedGrantDigest ||
      sealed.sealedGrantByteLength !== intent.sealedGrantByteLength
    )
      throw new Error('Recovered child approval has no exact sealed grant.');
    const grant = runtime.inspectActivatedChildStartGrant(
      JSON.parse(sealed.sealedGrantJson) as SubagentDelegationGrant,
    );
    if (
      grant.purpose !== 'start' ||
      grant.childInvocationId !== intent.childInvocationId ||
      grant.parentInvocationId !== intent.parentInvocationId ||
      grant.parentToolCallId !== intent.originToolCallId
    )
      throw new Error('Recovered child approval grant identity changed.');
    const verifyCurrent = () => {
      const parent = ensureParent();
      const child = ensureChild(intent.childThreadId, runtime);
      const proxy = input.owner.readChildApprovalProxy(input.parentSessionId, proxyInteractionId);
      if (!proxy) throw new Error('Recovered child approval proxy is unavailable.');
      const classified = classifyChildApprovalFirstTurnRecovery({
        parentState: parent.getState(),
        childState: child.getState(),
        intent,
        proxy,
      });
      if (classified.kind === 'recovery_required')
        throw new Error(`Recovered child approval is unsafe: ${classified.reason}.`);
      const budget = child.getState().resourceBudget;
      const activatedAt = budget.status === 'active' ? Date.parse(budget.startedAt) : NaN;
      if (
        !Number.isSafeInteger(activatedAt) ||
        activatedAt < grant.issuedAtMs ||
        activatedAt >= grant.expiresAtMs ||
        budget.status !== 'active' ||
        Date.parse(budget.deadlineAt) <= Date.now()
      )
        throw new Error('Recovered child approval has no live, authorized child Run.');
      const tool = child.getState().tools.calls[proxy.childToolCallId];
      const invocation = tool?.modelInvocationId
        ? child.getState().modelInvocations[tool.modelInvocationId]
        : undefined;
      if (
        !invocation ||
        verifyCompletedModelInvocationEvidence(invocation, runtime.evidence) !== undefined
      )
        throw new Error('Recovered child approval has no verified Model response artifact.');
      if (proxy.status === 'decided' || proxy.status === 'applied') {
        if (
          !proxy.parentCommandId ||
          !proxy.parentCommandDigest ||
          proxy.parentDecisionRevision === null
        )
          throw new Error('Recovered child approval has no exact parent receipt identity.');
        const receipt = input.owner.storage.commandReceipts.lookup({
          scopeSessionId: input.parentSessionId,
          commandId: proxy.parentCommandId,
          requestDigest: proxy.parentCommandDigest,
        });
        if (
          receipt.status !== 'replay' ||
          receipt.receipt.targetSessionId !== input.parentSessionId ||
          receipt.receipt.committedRevision !== proxy.parentDecisionRevision
        )
          throw new Error('Recovered child approval parent receipt changed.');
      }
      return { parent, child, proxy };
    };
    const childAbort = new AbortController();
    if (activeChildren.has(intent.childThreadId))
      throw new Error('Recovered approval already has a local child runner.');
    activeChildren.set(intent.childThreadId, childAbort);
    recoveryActiveChildren.add(childAbort);
    let fenced = false;
    try {
      await input.owner.reconcileInterruptedSession(
        intent.childThreadId,
        async (_generation, assertCurrent) => {
          if (!assertCurrent())
            throw new Error('Child approval recovery lost its owner generation.');
          verifyCurrent();
          fenced = true;
          return undefined;
        },
      );
      if (!fenced) throw new Error('Previous child approval owner still holds its lease.');
      await input.owner.runWithSessionExecution(intent.childThreadId, async () => {
        const { parent, child, proxy } = verifyCurrent();
        if (proxy.status === 'pending') approvalProxy.publishRequested(proxy);
        else if (proxy.status === 'decided') {
          approvalProxy.publishDecided(proxyInteractionId);
          approvalProxy.activateDecision(proxyInteractionId);
        }
        const parentOwnerKey = backgroundSubagentOwnerKey(
          input.parentSessionId,
          parent.getState().toolRecovery.identityKey,
        );
        const recoveryRunId = intent.childBudgetActivatedRunId;
        if (!recoveryRunId) throw new Error('Recovered child has no active Run identity.');
        let output = '';
        for await (const event of child.executeTurn(
          {
            ...childTurnFor(child.getState(), runtime, childAbort.signal),
            task: '',
            initialSkillActivations: [],
            resumeCommittedInteraction: true,
            childToolCeiling: {
              grantDigest: intent.grantDigest,
              role: intent.role,
              allowedTools: [...grant.capabilityCeiling.allowedTools],
            },
            crossSessionChildIdentity: {
              parentSessionId: intent.parentSessionId,
              taskId: intent.childInvocationId,
              grantId: grant.grantId,
              grantDigest: intent.grantDigest,
            },
          },
          createChildApprovalActionProvider({
            owner: input.owner,
            parentSessionId: input.parentSessionId,
            proxyOwner: approvalProxy,
            signal: childAbort.signal,
            onProxyOpened: (opened) => approvalProxy.publishRequested(opened),
          }),
        )) {
          const revision = child.revisionForEvent?.(event);
          const identity = { runId: recoveryRunId, taskId: intent.childInvocationId };
          if (revision === undefined) publishChildPresentation(child, event, identity);
          else publishChildCommittedThrough(child, revision, identity);
          if (event.type === 'run.completed') output = event.output;
        }
        await child.waitForIdle();
        if (stoppingRecovery || childAbort.signal.aborted) return;
        const state = child.getState();
        sealChildTerminalResult({
          getChildState: () => child.getState(),
          artifacts: runtime.childResultArtifacts,
          parentOwnerKey,
          result: childTerminalResult(state, output),
          cleanupConfirmed: true,
          cancelRequested: state.turn.abortCause === 'user',
          terminalReceiptId: `child-terminal:${intent.childThreadId}:${state.revision}`,
          commitSeal: (event) => child.session.commitChildSessionTerminalSeal(event),
        });
      });
      if (!stoppingRecovery && !childAbort.signal.aborted) await importSealed(intent.childThreadId);
    } finally {
      const recoveredChild = input.coordinators.get(intent.childThreadId);
      if (recoveredChild && intent.childBudgetActivatedRunId)
        clearSettledChildStream(recoveredChild, intent.childBudgetActivatedRunId);
      activeChildren.delete(intent.childThreadId);
      recoveryActiveChildren.delete(childAbort);
      input.coordinators.release(intent.childThreadId);
    }
  };
  const reportRecoveryRequired = (
    failures: readonly Readonly<{ childThreadId: string; reason: string }>[],
  ): void => {
    if (stoppingRecovery) return;
    for (const failure of failures) {
      const intent = input.owner.readChildSessionIntent(failure.childThreadId);
      const parent = input.coordinators.get(input.parentSessionId);
      if (
        !parent ||
        !intent ||
        intent.parentSessionId !== input.parentSessionId ||
        intent.failureReceiptDigest ||
        intent.parentClaimSettledEventId
      )
        continue;
      try {
        input.owner.runWithSessionExecution(input.parentSessionId, () =>
          parent.commitChildRecoveryRequired({
            type: 'subagent.child_recovery_required',
            parentSessionId: input.parentSessionId,
            parentInvocationId: intent.parentInvocationId,
            childInvocationId: intent.childInvocationId,
            childThreadId: intent.childThreadId,
            originToolCallId: intent.originToolCallId,
            attempt: intent.attempt,
            grantDigest: intent.grantDigest,
            diagnosticCode: 'recovery_blocked',
            observedAt: new Date().toISOString(),
          }),
        );
      } catch {
        // A live foreign owner or changed intent must not be replaced by a
        // guessed terminal. The pending Store intent remains recoverable.
      }
    }
  };
  const schedulePendingRecovery = async (cursor?: string): Promise<ScheduledChildRecovery> =>
    input.detachedScope.runInAsyncScope(async () => {
      if (stoppingRecovery)
        return {
          scheduled: 0,
          recoveryRequired: Object.freeze([]),
          completion: Promise.resolve({ processed: 0, recoveryRequired: Object.freeze([]) }),
        };
      const parent = input.coordinators.get(input.parentSessionId);
      if (!parent) throw new Error('Child recovery has no parent coordinator.');
      const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
      const stopRequested = new Set(
        input.owner.storage.sessions
          .loadEventsStrict(input.parentSessionId)
          .flatMap(({ event }) =>
            event.type === 'background_execution.stop_requested' &&
            event.executionKind === 'subagent'
              ? [event.executionId]
              : [],
          ),
      );
      for (const call of Object.values(parent.getState().tools.calls)) {
        const args = call.args;
        if (
          call.name === 'task_cancel' &&
          (call.status === 'running' || call.status === 'succeeded' || call.status === 'failed') &&
          args &&
          typeof args === 'object' &&
          'task_id' in args &&
          typeof args.task_id === 'string'
        )
          stopRequested.add(args.task_id);
      }
      const plan = input.owner.runWithSessionExecution(input.parentSessionId, () =>
        planChildSessionRecovery({
          parentSessionId: input.parentSessionId,
          parentState: parent.getState(),
          listPending: input.owner.listPendingChildSessionIntents,
          readIntent: input.owner.readChildSessionIntent,
          readSealedGrant: input.owner.readChildSealedGrant,
          readChildState: (id) => input.owner.storage.sessions.loadSnapshot<RuntimeState>(id),
          readChildApprovalProxy: input.owner.readChildApprovalProxy,
          childApprovalProxyId: input.owner.childApprovalProxyId,
          readParentCommandReceipt: input.owner.storage.commandReceipts.lookup,
          isParentRunLive: (runId) => {
            const status = input.owner.storage.runs?.get(input.parentSessionId, runId)?.status;
            return status === 'running' || status === 'waiting';
          },
          isAfterTurnOriginCompleted: (runId) =>
            input.owner.storage.runs?.get(input.parentSessionId, runId)?.status === 'completed',
          hasStopRequest: (childInvocationId) => stopRequested.has(childInvocationId),
          hasPreparedCurrentTurnRoute: (childThreadId) => {
            const child = input.owner.storage.sessions.loadSnapshot<RuntimeState>(childThreadId);
            if (!child || child.childSessionOrigin?.parentSessionId !== input.parentSessionId)
              return false;
            const prepared = Object.values(child.modelInvocations).filter(
              (model) => model.status === 'prepared' && model.attempts === 0,
            );
            return (
              prepared.length === 1 &&
              input.owner.storage.sessions
                .loadEventsStrict(childThreadId)
                .some(
                  ({ event }) =>
                    event.type === 'agent.followup_routed' &&
                    event.route === 'current_turn' &&
                    event.targetAgentId === childThreadId &&
                    event.invocationId === prepared[0]!.invocationId,
                )
            );
          },
          inspectGrant: (value) => runtime.inspectChildStartGrant(value as SubagentDelegationGrant),
          inspectActivatedGrant: (value) =>
            runtime.inspectActivatedChildStartGrant(value as SubagentDelegationGrant),
          nowMs: Date.now(),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      );
      const immediateFailures = plan.actions.flatMap((action) =>
        action.kind === 'recovery_required'
          ? [{ childThreadId: action.intent.childThreadId, reason: action.reason }]
          : [],
      );
      reportRecoveryRequired(immediateFailures);
      const scheduledActions = plan.actions.filter((action) => action.kind !== 'recovery_required');
      const runAction = async (action: (typeof scheduledActions)[number]) => {
        try {
          await input.enqueueSessionWork(action.intent.childThreadId, async () => {
            if (action.kind === 'import_terminal') {
              await importSealed(action.intent.childThreadId);
              return;
            }
            if (action.kind === 'resume_approval') {
              await resumeChildApproval(action.intent, action.proxyInteractionId);
              return;
            }
            if (action.kind === 'resume_current_turn_model') {
              await resumePreparedCurrentTurnModel(action.intent);
              return;
            }
            if (
              action.kind === 'abandon_stopped_child' ||
              action.kind === 'abandon_unstartable_child'
            ) {
              if (
                action.intent.childSessionCreated &&
                !input.owner.ownsSessionExecution(action.intent.childThreadId)
              ) {
                await input.owner.reconcileInterruptedSession(
                  action.intent.childThreadId,
                  async () => {
                    const child = input.owner.storage.sessions.loadSnapshot<RuntimeState>(
                      action.intent.childThreadId,
                    );
                    if (
                      !child ||
                      child.childSessionOrigin?.parentSessionId !== input.parentSessionId ||
                      child.childSessionOrigin.terminal ||
                      Object.keys(child.modelInvocations).length > 0 ||
                      Object.keys(child.tools.calls).length > 0 ||
                      (child.revision !== 0 && child.revision !== 5)
                    )
                      throw new Error('Stopped child has no safe pre-dispatch abandonment proof.');
                    return undefined;
                  },
                );
              }
              const queuedInterrupt =
                action.kind === 'abandon_stopped_child' &&
                input.owner.runWithSessionExecution(input.parentSessionId, () =>
                  input.owner.storage.sessions
                    .loadEventsStrict(input.parentSessionId)
                    .some(({ event }) => {
                      if (
                        event.type !== 'background_execution.stop_requested' ||
                        event.executionId !== action.intent.childInvocationId
                      )
                        return false;
                      const stop = input.owner.storage.crossSessionQueueMail?.readInterruptIntent(
                        input.parentSessionId,
                        event.commandId,
                      );
                      return (
                        stop?.targetSessionId === action.intent.childThreadId &&
                        stop.targetRunId === null &&
                        stop.targetTaskId === action.intent.childInvocationId
                      );
                    }),
                );
              await settlePreDispatchFailure(action.intent, queuedInterrupt === true);
              return;
            }
            if (action.kind === 'cancel_acknowledged_child') {
              await cancelAcknowledgedChild(action.intent);
              return;
            }
            if (action.kind === 'reconcile_unknown_child') {
              const parentState = parent.getState();
              const sealed = await recoverUnknownChildTerminal({
                owner: input.owner,
                childThreadId: action.intent.childThreadId,
                ensureChild: () => ensureChild(action.intent.childThreadId, runtime),
                modelRuntime: runtime,
                shellExecutor: input.bridgeInput.shellExecutor,
                artifacts: runtime.childResultArtifacts,
                parentOwnerKey: backgroundSubagentOwnerKey(
                  input.parentSessionId,
                  parentState.toolRecovery.identityKey,
                ),
              });
              if (!sealed) throw new Error('Previous child execution is still owned.');
              await importSealed(action.intent.childThreadId);
              return;
            }
            const queuedAbort = new AbortController();
            if (queuedChildren.has(action.intent.childThreadId))
              throw new Error('Recovered child already has a local queued runner.');
            queuedChildren.set(action.intent.childThreadId, queuedAbort);
            recoveryQueuedChildren.add(queuedAbort);
            try {
              await launch(
                {
                  childThreadId: action.intent.childThreadId,
                  childInvocationId: action.intent.childInvocationId,
                  parentSessionId: action.intent.parentSessionId,
                  ...('budget' in action ? action.budget : {}),
                },
                undefined,
                queuedAbort,
              );
            } catch (error) {
              if (queuedAbort.signal.aborted && !stoppingRecovery) {
                await settlePreDispatchFailure(action.intent, true);
                const settled = input.owner.readChildSessionIntent(action.intent.childThreadId);
                if (settled?.failureReceiptDigest || settled?.parentClaimSettledEventId) return;
              }
              throw error;
            } finally {
              queuedChildren.delete(action.intent.childThreadId);
              recoveryQueuedChildren.delete(queuedAbort);
            }
          });
          return undefined;
        } catch {
          return {
            childThreadId: action.intent.childThreadId,
            reason: `recovery_action_${action.kind}_failed`,
          };
        }
      };
      // Scheduling belongs to the existing per-Session work queue. Bound only this
      // recovery sweep's fanout; no second persistent queue or owner is created.
      const completion: Promise<ChildRecoveryResult> = Promise.resolve()
        .then(async () => {
          const outcomes: Awaited<ReturnType<typeof runAction>>[] = new Array(
            scheduledActions.length,
          );
          let next = 0;
          await Promise.all(
            Array.from(
              { length: Math.min(MAX_CONCURRENT_CHILD_RECOVERIES, scheduledActions.length) },
              async () => {
                while (next < scheduledActions.length) {
                  const index = next++;
                  if (stoppingRecovery) {
                    outcomes[index] = {
                      childThreadId: scheduledActions[index]!.intent.childThreadId,
                      reason: 'recovery_owner_stopped',
                    };
                    continue;
                  }
                  outcomes[index] = await runAction(scheduledActions[index]!);
                }
              },
            ),
          );
          const failures = outcomes.filter((outcome) => outcome !== undefined);
          return {
            processed: scheduledActions.length - failures.length,
            recoveryRequired: Object.freeze([...immediateFailures, ...failures]),
            ...(plan.nextCursor ? { nextCursor: plan.nextCursor } : {}),
          };
        })
        .catch(() => ({
          processed: 0,
          recoveryRequired: Object.freeze([
            ...immediateFailures,
            ...scheduledActions.map((action) => ({
              childThreadId: action.intent.childThreadId,
              reason: 'recovery_batch_failed',
            })),
          ]),
          ...(plan.nextCursor ? { nextCursor: plan.nextCursor } : {}),
        }))
        .then((result) => {
          reportRecoveryRequired(
            result.recoveryRequired.filter(
              (failure) =>
                !immediateFailures.some(
                  (immediate) => immediate.childThreadId === failure.childThreadId,
                ),
            ),
          );
          return result;
        });
      pendingRecoveries.add(completion);
      void completion.then(
        () => pendingRecoveries.delete(completion),
        () => pendingRecoveries.delete(completion),
      );
      return {
        scheduled: scheduledActions.length,
        recoveryRequired: Object.freeze(immediateFailures),
        completion,
        ...(plan.nextCursor ? { nextCursor: plan.nextCursor } : {}),
      };
    });
  const recoverPending = async (cursor?: string): Promise<ChildRecoveryResult> =>
    (await schedulePendingRecovery(cursor)).completion;
  const taskControl = () => {
    const parent = input.coordinators.get(input.parentSessionId);
    if (!parent) throw new Error('Independent child Task control has no parent coordinator.');
    const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
    return createChildSessionTaskControl({
      parentSessionId: input.parentSessionId,
      getParentState: () => parent.getState(),
      readIntent: input.owner.readChildSessionIntent,
      readChildState: (id) => input.owner.storage.sessions.loadSnapshot<RuntimeState>(id),
      readChildEvents: (id) => input.owner.storage.sessions.loadEventsStrict(id),
      artifacts: runtime.childResultArtifacts,
      parentArtifactOwnerKey: backgroundSubagentOwnerKey(
        input.parentSessionId,
        parent.getState().toolRecovery.identityKey,
      ),
      waitForParentRevisionChange: (revision, signal) => {
        if (!parent.session.waitForRevisionChange)
          throw new Error('Independent child Task wait has no parent revision port.');
        return parent.session.waitForRevisionChange(revision, signal);
      },
      waitForChildRevisionChange: (id, revision, signal) =>
        input.coordinators.get(id)?.session.waitForRevisionChange?.(revision, signal) ?? null,
    });
  };
  const schedulePendingInterruptRecovery = (
    targetSessionId: string,
  ): ScheduledInterruptRecovery => {
    const mail = input.owner.storage.crossSessionQueueMail;
    if (!mail || stoppingRecovery || activeInterruptTargets.has(targetSessionId))
      return {
        scheduled: 0,
        completion: Promise.resolve({ observed: 0, processed: 0, recoveryRequired: [] }),
      };
    activeInterruptTargets.add(targetSessionId);
    const completion = input.detachedScope.runInAsyncScope(
      async (): Promise<InterruptRecoveryResult> => {
        const recoveryRequired: string[] = [];
        let processed = 0;
        let observed = 0;
        try {
          const leaseWaitDeadline = Date.now() + 65_000;
          while (!stoppingRecovery && Date.now() < leaseWaitDeadline) {
            const authority = input.owner.readChildExecutionAuthority(
              input.parentSessionId,
              targetSessionId,
            );
            if (
              input.owner.ownsSessionExecution(targetSessionId) ||
              (authority?.hostInstanceId === input.owner.hostInstanceId &&
                !queuedChildren.has(targetSessionId) &&
                !activeChildren.has(targetSessionId)) ||
              !authority ||
              (authority.status !== 'active' && authority.status !== 'detached') ||
              authority.leaseUntilMs === null ||
              authority.leaseUntilMs <= Date.now()
            )
              break;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(1_000, authority.leaseUntilMs! - Date.now() + 10)),
            );
          }
          if (stoppingRecovery) throw new Error('Interrupt recovery owner stopped.');
          await input.owner.reconcileInterruptedSession(
            targetSessionId,
            async (generation, assertCurrent) => {
              const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
              const child = ensureChild(targetSessionId, runtime);
              const result = await reconcileRuntimeSessionAfterRestart({
                control: child.control,
                modelInvocationRuntime: runtime,
                shellExecutor: input.bridgeInput.shellExecutor,
                historyEvents: input.owner.storage.sessions
                  .loadEventsStrict(targetSessionId)
                  .map(({ event }) => event),
                recoveryOwnership: {
                  kind: 'fenced_previous_execution',
                  controllerGeneration: generation,
                  assertCurrent,
                },
              });
              return result.complete ? undefined : 'cleanup_unconfirmed';
            },
          );
          const rows = input.owner.runWithSessionExecution(targetSessionId, () =>
            mail.listPendingInterrupts(targetSessionId, 64),
          );
          observed = rows.length;
          for (const row of rows) {
            if (row.sourceSessionId !== input.parentSessionId) {
              recoveryRequired.push(row.commandId);
              continue;
            }
            try {
              if (row.targetRunId === null) {
                const queued = queuedChildren.get(targetSessionId);
                queued?.abort(
                  createRuntimeAbortReason('user', 'Delegated task cancelled by parent.'),
                );
                if (!queued) {
                  await settlePreDispatchFailure({ childThreadId: targetSessionId }, true);
                }
                const deadline = Date.now() + 2_000;
                let intent = input.owner.readChildSessionIntent(targetSessionId);
                while (
                  !stoppingRecovery &&
                  intent &&
                  !intent.failureReceiptDigest &&
                  !intent.parentClaimSettledEventId &&
                  Date.now() < deadline
                ) {
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  intent = input.owner.readChildSessionIntent(targetSessionId);
                }
                const terminal = Boolean(
                  intent?.failureReceiptDigest || intent?.parentClaimSettledEventId,
                );
                const task = terminal
                  ? await input.detachedScope.runInAsyncScope(() =>
                      input.owner.runWithSessionExecution(input.parentSessionId, () =>
                        taskControl().readTask(row.targetTaskId),
                      ),
                    )
                  : null;
                input.owner.runWithSessionExecution(input.parentSessionId, () =>
                  ensureParent().session.commitCrossSessionQueuedInterruptSettlement(
                    task?.status === 'cancelled'
                      ? {
                          type: 'background_execution.stop_settled',
                          commandId: row.commandId,
                          executionId: row.targetTaskId,
                          cleanupConfirmed: true,
                        }
                      : {
                          type: 'background_execution.stop_unknown',
                          commandId: row.commandId,
                          executionId: row.targetTaskId,
                          reason: terminal ? 'target_already_idle' : 'cleanup_unconfirmed',
                        },
                    {
                      kind: 'settle_queued_interrupt',
                      commandId: row.commandId,
                      targetSessionId,
                    },
                  ),
                );
                processed += 1;
                continue;
              }
              const acknowledgement = input.owner.runWithSessionExecution(targetSessionId, () => {
                const authority = input.owner.readChildExecutionAuthority(
                  input.parentSessionId,
                  targetSessionId,
                );
                if (authority?.status !== 'active')
                  throw new Error('Interrupt target has no fenced execution owner.');
                const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
                const child = ensureChild(targetSessionId, runtime);
                const state = child.getState();
                const live =
                  state.turn.turnId === row.targetRunId &&
                  state.turn.status === 'active' &&
                  state.activeTaskId === row.targetTaskId;
                if (row.status === 'pending') {
                  child.session.commitCrossSessionInterruptTarget(
                    live
                      ? {
                          type: 'background_execution.stop_requested',
                          commandId: row.commandId,
                          executionId: row.targetTaskId,
                          executionKind: 'subagent',
                          ownerGeneration: `child:${authority.controllerGeneration}`,
                        }
                      : {
                          type: 'background_execution.stop_unknown',
                          commandId: row.commandId,
                          executionId: row.targetTaskId,
                          reason: 'target_already_idle',
                        },
                    {
                      kind: 'ack_interrupt',
                      sourceSessionId: row.sourceSessionId,
                      commandId: row.commandId,
                      targetGeneration: authority.controllerGeneration,
                    },
                  );
                }
                return {
                  live,
                  generation: authority.controllerGeneration,
                  followupSubmissionId:
                    state.activeFollowupTurn?.targetRunId === row.targetRunId &&
                    state.activeFollowupTurn.taskId === row.targetTaskId
                      ? state.activeFollowupTurn.submissionId
                      : undefined,
                };
              });
              if (!acknowledgement.live && row.status === 'pending') {
                processed += 1;
                continue;
              }
              const controller =
                activeChildren.get(targetSessionId) ??
                (acknowledgement.followupSubmissionId
                  ? activeFollowupControllers.get(acknowledgement.followupSubmissionId)
                  : undefined);
              controller?.abort(
                createRuntimeAbortReason('user', 'Delegated task cancelled by parent.'),
              );
              const deadline = Date.now() + 2_000;
              let runStatus: string | undefined;
              while (!stoppingRecovery && Date.now() <= deadline) {
                runStatus = input.owner.runWithSessionExecution(
                  targetSessionId,
                  () => input.owner.storage.runs?.get(targetSessionId, row.targetRunId!)?.status,
                );
                if (
                  runStatus === 'cancelled' ||
                  runStatus === 'unknown' ||
                  runStatus === 'completed' ||
                  runStatus === 'failed'
                )
                  break;
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              if (
                runStatus !== 'cancelled' &&
                runStatus !== 'unknown' &&
                runStatus !== 'completed' &&
                runStatus !== 'failed'
              )
                throw new Error('Interrupt target cleanup is not yet durable.');
              input.owner.runWithSessionExecution(targetSessionId, () => {
                const runtime = input.modelRuntimeFactory(input.bridgeInput.workspace);
                const child = ensureChild(targetSessionId, runtime);
                child.session.commitCrossSessionInterruptTarget(
                  runStatus === 'cancelled'
                    ? {
                        type: 'background_execution.stop_settled',
                        commandId: row.commandId,
                        executionId: row.targetTaskId,
                        cleanupConfirmed: true,
                      }
                    : {
                        type: 'background_execution.stop_unknown',
                        commandId: row.commandId,
                        executionId: row.targetTaskId,
                        reason:
                          runStatus === 'unknown'
                            ? 'cleanup_unconfirmed'
                            : 'target_completed_before_cleanup',
                      },
                  {
                    kind: 'settle_interrupt',
                    sourceSessionId: row.sourceSessionId,
                    commandId: row.commandId,
                    targetGeneration: acknowledgement.generation,
                  },
                );
              });
              processed += 1;
            } catch {
              recoveryRequired.push(row.commandId);
            }
          }
        } catch {
          recoveryRequired.push(targetSessionId);
        } finally {
          activeInterruptTargets.delete(targetSessionId);
        }
        return { observed, processed, recoveryRequired: Object.freeze(recoveryRequired) };
      },
    );
    pendingInterruptRecoveries.add(completion);
    void completion.finally(() => pendingInterruptRecoveries.delete(completion));
    return { scheduled: 1, completion };
  };
  return {
    startAcceptedFollowup,
    receiveAcceptedFollowup,
    replacePreparedFollowupBackup,
    routePreparedFollowup,
    activateRoutedFollowup,
    executeAcceptedFollowupFirstModel,
    resumePreparedFollowupFirstModel,
    settleTerminalFollowupFunding,
    schedulePendingFollowupRecovery,
    recoverPendingFollowups,
    schedulePendingInterruptRecovery,
    pendingDelegationReservations,
    pendingAfterTurnDelegations,
    liveAfterTurnDelegations,
    sealedAfterTurnReports,
    effectLeases: {
      tryAcquireEffectLease: (sessionId, effectId, ownerId, expiresAtMs) =>
        input.effectLeases.tryAcquire(sessionId, effectId, ownerId, expiresAtMs),
      releaseEffectLease: (sessionId, effectId, ownerId) =>
        input.effectLeases.release(sessionId, effectId, ownerId),
    },
    schedulePendingRecovery,
    approvalProxy,
    recoverPending,
    bindParentApprovalWake: (publish) => {
      if (publishParentApprovalWake)
        throw new Error('Child approval parent wake is already bound.');
      publishParentApprovalWake = publish;
    },
    stopPendingRecovery: async () => {
      stoppingRecovery = true;
      for (const controller of followupRecoveryControllers)
        controller.abort(createRuntimeAbortReason('error', 'Followup recovery owner stopped.'));
      for (const controller of recoveryQueuedChildren)
        controller.abort(new Error('Independent child Session recovery owner stopped.'));
      for (const controller of recoveryActiveChildren)
        controller.abort(
          createRuntimeAbortReason('error', 'Independent child recovery owner stopped.'),
        );
      await Promise.allSettled([
        ...pendingRecoveries,
        ...pendingFollowupRecoveries,
        ...pendingInterruptRecoveries,
      ]);
    },
    taskControl: {
      readTask: (taskId) => taskControl().readTask(taskId),
      waitTasks: (taskIds, timeoutMs, signal) =>
        taskControl().waitTasks(taskIds, timeoutMs, signal),
      cancelTask: async (taskId, options) => {
        const waitMs = options?.waitMs ?? 60_000;
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000)
          throw new Error('Child Task cancellation wait must be within 0–60000 ms.');
        const current = await taskControl().readTask(taskId);
        if (current.status !== 'running') return current;
        const parent = input.coordinators.get(input.parentSessionId);
        const matches = Object.values(parent?.getState().capabilities.invocations ?? {}).filter(
          (invocation) =>
            invocation.subagentProviderLifecycle?.childInvocationId === taskId &&
            invocation.subagentProviderLifecycle.childSession,
        );
        const childThreadId = matches[0]?.subagentProviderLifecycle?.childSession?.childThreadId;
        const abort =
          matches.length === 1 && childThreadId
            ? (activeChildren.get(childThreadId) ?? queuedChildren.get(childThreadId))
            : undefined;
        if (!abort)
          return {
            ...current,
            ok: false,
            status: 'unknown',
            error: 'Child Session runner is not locally owned; recovery is required.',
          };
        input.detachedScope.runInAsyncScope(() =>
          abort.abort(
            createRuntimeAbortReason(
              options?.abortCause ?? 'user',
              options?.abortCause === 'error'
                ? 'Independent child execution owner is shutting down.'
                : 'Delegated task cancelled by user.',
            ),
          ),
        );
        let waited: Awaited<ReturnType<ReturnType<typeof taskControl>['waitTasks']>>;
        try {
          waited = await taskControl().waitTasks([taskId], waitMs);
        } catch (error) {
          if (options?.abortCause !== 'error') throw error;
          return {
            ...current,
            ok: false,
            status: 'unknown',
            cleanup_confirmed: false,
            error: 'Child Task cleanup could not be confirmed during owner shutdown.',
          };
        }
        const tasks = Array.isArray(waited.tasks) ? waited.tasks : [];
        const observed =
          (tasks[0] as Readonly<Record<string, unknown>> | undefined) ??
          (options?.abortCause === 'error' ? current : await taskControl().readTask(taskId));
        if (observed.status === 'running' || observed.status === 'cancelling')
          return {
            ...observed,
            ok: false,
            status: 'unknown',
            cleanup_confirmed: false,
            error: 'Child Task cancellation cleanup is unconfirmed.',
          };
        return observed;
      },
    },
    backgroundSnapshot: () => {
      const parentState =
        input.coordinators.get(input.parentSessionId)?.getState() ??
        input.owner.storage.sessions.loadSnapshot<RuntimeState>(input.parentSessionId);
      if (!parentState) throw new Error('Independent child background snapshot has no parent.');
      return projectIndependentChildExecutions({
        parentState,
        readIntent: input.owner.readChildSessionIntent,
        readChildState: (id) => input.owner.storage.sessions.loadSnapshot<RuntimeState>(id),
        readAuthority: input.owner.readChildExecutionAuthority,
        nowMs: Date.now(),
      });
    },
    onAccepted: (accepted, parentSignal) => {
      const queuedAbort = new AbortController();
      queuedChildren.set(accepted.childThreadId, queuedAbort);
      return input.detachedScope.runInAsyncScope(() =>
        input.enqueueSessionWork(accepted.childThreadId, async () => {
          try {
            await launch(accepted, parentSignal, queuedAbort);
          } catch {
            try {
              await settlePreDispatchFailure(accepted, queuedAbort.signal.aborted);
            } catch {
              // The accepted Store intent remains the recovery source.
            }
          } finally {
            queuedChildren.delete(accepted.childThreadId);
          }
        }),
      );
    },
  };
}
