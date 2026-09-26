import {
  assertRestoredCapabilityArtifactEvidence,
  type BuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import {
  type ModelArtifactEvidenceAvailability,
  verifyCompletedModelInvocationEvidence,
  verifyPendingModelInvocationEvidence,
} from '@kite-ai/builtin-runtime/model';
import { canonicalPathForComparison } from '@kite-ai/builtin-runtime/sandbox';
import type { RuntimeCommand } from '@kite-ai/runtime-contract';
import {
  type RuntimeHostExecutionServices,
  resolveProjectIdentity,
  restoreRuntimeHostStateSession,
} from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateSession,
  projectRuntimeHostStateRestartRecoveryEvents,
  runtimeHostStateProjectAcceptedEvent,
  runtimeHostStateRestartRecoveryCapabilityInvocationIds,
  type StateRuntimeSession,
  type StateRuntimeSessionEffectLease,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeCrossSessionAgentMailMutation,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import type { CapabilityExecutionPort, CapabilityRegistrySnapshot } from '@kite-ai/runtime-spi';
import { persistedWorkspaceIdentity } from '../../config/persisted-workspace-identity';
import type {
  InstalledKiteRuntimeComposition,
  InstalledKiteRuntimeCompositionFactory,
} from '../model-runtime-composition';
import {
  type CommittedCloseSessionCommand,
  type CommittedControlCommand,
  commitCancelTurnCommand,
  commitClearSessionCommandGrantsCommand,
  commitCloseSessionCommand,
  commitInteractionModeCommand,
} from './command-control-decision';
import {
  type CommittedForkSessionCommand,
  commitForkSessionCommand,
} from './command-fork-decision';
import {
  type CommittedInteractionCommand,
  commitInteractionCommand,
  type RuntimeInteractionCommandCommitInput,
} from './command-interaction-decision';
import { type CommittedRewindCommand, commitRewindCommand } from './command-rewind-decision';
import { createAppRuntimeEffectExecutor } from './runtime-effect-coordinator';
import type { RuntimeExecutorDependencies } from './runtime-effect-dependencies';
import {
  approvalRejectionSettlementEvents,
  eventsForRuntimeAction,
  type RuntimeActionResult,
  type RuntimeUserAction,
} from './state-actions';
import type {
  RuntimeActionProvider,
  RuntimeAgentMailboxCommandCommitInput,
  RuntimeAgentMailboxFactsCommitInput,
  RuntimeAgentMailModelAdmissionInput,
  RuntimeCrossSessionFollowupCommandInput,
  RuntimeCrossSessionInterruptCommandInput,
  RuntimeCrossSessionQueueMailCommandInput,
  RuntimeCrossSessionQueueMailModelInput,
  RuntimeStateSessionPort,
} from './state-runner';
import type {
  RuntimeEffectExecutor,
  RuntimeEffectLeaseExpectation,
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from './state-runtime';
import {
  type CommittedSteerTurnCommand,
  commitSteerTurnCommand,
  steerQueueHasCapacity,
} from './steer-command-decision';
import { prepareBackgroundAgentTerminalReply } from './subagent/task-tool';
import type { AppToolPipelineComposition } from './tool-pipeline-composition';
import {
  type CommittedStartTurnCommand,
  commitStartTurnCommand,
  type StartTurnSkillPlanningContext,
} from './turn-command-decision';
import {
  executeRuntimeTurn,
  type RuntimeCommittedCommandCancellation,
  type RuntimeTurnInput,
} from './turn-coordinator';
import { projectVerificationSchemaAdmissions } from './verification-schema-admission';

/** App-private transition control used by the State 27 coordinator. */
export interface AuthorizedExecutionControl {
  getState: () => Readonly<RuntimeState>;
  processEvent: (event: RuntimeEvent) => void;
  processEventBatch: (events: RuntimeEvent[]) => RuntimeEvent[];
  cancelRun: (reason?: string, cause?: 'user' | 'error') => RuntimeEvent[];
}

export interface RuntimeSessionCoordinatorIdentity {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectId: string;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
  /** Bootstrap value for a fresh Session. Restored Sessions use durable State. */
  readonly interactionMode: RuntimeState['mode'];
  readonly recoveryIdentityKey: string;
  readonly sandboxAvailable?: boolean;
  readonly modelArtifactEvidence?: ModelArtifactEvidenceAvailability;
  readonly capabilityArtifactEvidence?: import('@kite-ai/builtin-runtime').CapabilityArtifactReader;
  readonly preserveReservedChildDelegations?: readonly string[];
  readonly preservePendingAfterTurnDelegations?: NonNullable<
    import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preservePendingAfterTurnDelegations']
  >;
  readonly preserveLiveAfterTurnDelegations?: NonNullable<
    import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preserveLiveAfterTurnDelegations']
  >;
  readonly preserveSealedAfterTurnReports?: NonNullable<
    import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preserveSealedAfterTurnReports']
  >;
  readonly preservePendingFollowupFunding?: NonNullable<
    import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preservePendingFollowupFunding']
  >;
  readonly preservePreparedFollowupModels?: NonNullable<
    import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preservePreparedFollowupModels']
  >;
  readonly preservePreparedCurrentTurnModels?: NonNullable<
    import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preservePreparedCurrentTurnModels']
  >;
  readonly preserveDispatchedChildDelegations?: NonNullable<
    import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preserveDispatchedChildDelegations']
  >;
}

export function projectRuntimeSessionLiveMode(
  state: Pick<RuntimeState, 'mode' | 'interactionModeRevision'>,
): Readonly<{
  interactionMode: RuntimeState['mode'];
  interactionModeRevision: number;
}> {
  if (!Number.isSafeInteger(state.interactionModeRevision) || state.interactionModeRevision < 0) {
    throw new Error('Runtime interaction mode revision is invalid.');
  }
  return Object.freeze({
    interactionMode: state.mode,
    interactionModeRevision: state.interactionModeRevision,
  });
}

export interface RuntimeSessionCoordinator {
  readonly sessionId: string;
  readonly control: AuthorizedExecutionControl;
  readonly session: StateRuntimeSession;
  readonly recoveryChanged: boolean;
  readonly lifecycle: 'idle' | 'running' | 'compacting' | 'closing' | 'closed';

  getState(): Readonly<RuntimeState>;
  /** Exact persisted revision assigned to one event yielded by this coordinator. */
  revisionForEvent?(event: RuntimeEvent): number | undefined;
  /** Drain the existing canonical commit queue in revision order for Bridge publication. */
  takeCommittedEventsThrough(revision: number): readonly RuntimeEvent[];
  /** Exact post-event State retained for current-process notification projection. */
  stateForEvent?(event: RuntimeEvent): Readonly<RuntimeState> | undefined;
  getStateRuntimeStorage(): StateRuntimeStorage;
  commitBackgroundAgentSettlement(
    input: import('./subagent/task-tool').BackgroundAgentSettlementCommitInput,
  ): ReturnType<StateRuntimeSession['commitBackgroundAgentSettlement']>;
  commitChildBudgetActivation(
    events: Parameters<StateRuntimeSession['commitChildBudgetActivation']>[0],
    mutation: Parameters<StateRuntimeSession['commitChildBudgetActivation']>[1],
    evidence: Parameters<StateRuntimeSession['commitChildBudgetActivation']>[2],
  ): ReturnType<StateRuntimeSession['commitChildBudgetActivation']>;
  commitChildDispatchAck(
    childThreadId: string,
  ): ReturnType<StateRuntimeSession['commitChildDispatchAck']>;
  commitCrossSessionQueueMailReceive(
    event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'receive_queue' }>,
  ): readonly RuntimeEvent[];
  commitChildCreationFailure(
    input: Parameters<StateRuntimeSession['commitChildCreationFailure']>[0],
  ): ReturnType<StateRuntimeSession['commitChildCreationFailure']>;
  commitChildRecoveryRequired(
    event: Parameters<StateRuntimeSession['commitChildRecoveryRequired']>[0],
  ): ReturnType<StateRuntimeSession['commitChildRecoveryRequired']>;
  commitChildSessionTerminalImport(
    input: Parameters<StateRuntimeSession['commitChildSessionTerminalImport']>[0],
  ): ReturnType<StateRuntimeSession['commitChildSessionTerminalImport']>;
  commitChildSlotAcquisition(reservationId: string): void;
  isTurnActive(): boolean;
  beginTurn(): void;
  endTurn(): void;
  /** Explicitly records a durable interaction-mode mutation for identity checks. */
  updateInteractionMode(mode: RuntimeState['mode']): void;
  /** Live mutable mode is revisioned Session state, not coordinator identity. */
  getInteractionModeState(): Readonly<{
    interactionMode: RuntimeState['mode'];
    interactionModeRevision: number;
  }>;
  /** Applies the Host-prepared sandbox fact before the next turn. */
  updateSandboxAvailable(available: boolean): void;
  getSandboxAvailable(): boolean | undefined;
  setActiveCancelRun(
    cancelRun: (reason?: string, cause?: 'user' | 'error') => RuntimeEvent[],
  ): void;
  clearActiveCancelRun(): void;
  commitInteractionModeCommand(
    command: Extract<RuntimeCommand, { readonly type: 'set_interaction_mode' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedControlCommand;
  commitCancelTurnCommand(
    command: Extract<RuntimeCommand, { readonly type: 'cancel_turn' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedControlCommand;
  commitCloseSessionCommand(
    command: Extract<RuntimeCommand, { readonly type: 'close_session' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedCloseSessionCommand;
  commitClearSessionCommandGrantsCommand(
    command: Extract<RuntimeCommand, { readonly type: 'clear_session_command_grants' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedControlCommand;
  commitForkSessionCommand(
    command: Extract<RuntimeCommand, { readonly type: 'fork_session' }>,
    targetSessionId: string,
    targetRecoveryIdentityKey: string,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedForkSessionCommand;
  commitRewindCommand?(
    command: Extract<RuntimeCommand, { readonly type: 'rewind_session' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedRewindCommand;
  persistRewindTerminal?(
    event: Extract<RuntimeEvent, { type: 'session.rewind_completed' | 'session.rewind_failed' }>,
  ): readonly RuntimeEvent[];
  /**
   * Commits the entire start-turn State decision and applied command receipt.
   * Calling this method never begins a runner; the caller may schedule only
   * after it receives this committed descriptor.
   */
  commitStartTurnCommand(
    command: Extract<RuntimeCommand, { readonly type: 'start_turn' }>,
    evidence: RuntimeCommandCommitEvidence,
    context?: StartTurnSkillPlanningContext,
    admittedModelRoute?: { readonly provider: string; readonly name: string },
  ): CommittedStartTurnCommand;
  commitSteerTurnCommand(
    command: Extract<RuntimeCommand, { readonly type: 'steer_turn' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedSteerTurnCommand;
  canAcceptSteerInput(): boolean;
  /** Commits the queued-to-running Store 8 activation before execution scheduling. */
  activateStartTurnRun?(runId: string): void;
  /** Commits one Host-inspected interaction command against its exact accepted revision. */
  commitInteractionCommand?(
    input: RuntimeInteractionCommandCommitInput,
  ): CommittedInteractionCommand;
  /** Commits the old global-admission settlement through the canonical revision projector. */
  commitObsoleteAdmissionResumeCommand(
    events: readonly Extract<RuntimeEvent, { type: 'provider.admission_cancelled' }>[],
    evidence: RuntimeCommandCommitEvidence,
  ): Readonly<{ receipt: RuntimeStoredCommandReceipt; events: readonly RuntimeEvent[] }>;
  /** Commits the inspected manual-compaction intent and retains each exact post-event State. */
  commitCompactionCommandEvents?(
    events: readonly RuntimeEvent[],
    evidence: RuntimeCommandCommitEvidence,
  ): Readonly<{
    receipt: RuntimeStoredCommandReceipt;
    events: readonly RuntimeEvent[];
  }>;
  executeTurn(
    input: Omit<RuntimeTurnInput, 'runtimeSession' | 'createRuntimeEffectPort'>,
    provider: RuntimeActionProvider,
  ): AsyncGenerator<RuntimeEvent>;
  createRuntimeEffectPort(dependencies: RuntimeExecutorDependencies): RuntimeEffectExecutor;
  executePendingCompaction(input: {
    readonly dependencies: RuntimeExecutorDependencies;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeEvent[]>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeSessionCoordinatorAccess {
  ensure(input: RuntimeSessionCoordinatorIdentity): RuntimeSessionCoordinator;
  get(sessionId: string): RuntimeSessionCoordinator | undefined;
  release(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeSessionCoordinatorBinding {
  bind(input: {
    readonly services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
    readonly capabilities: CapabilityExecutionPort;
    readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
    readonly builtinToolCatalog: BuiltinToolCatalogProjection;
    readonly toolPipelineComposition?: AppToolPipelineComposition;
    readonly modelRuntimeFactory: InstalledKiteRuntimeCompositionFactory;
    readonly store: StateRuntimeStorage;
  }): void;
  access(): RuntimeSessionCoordinatorAccess;
}

/** Pure admission check; Store retains the ordered mailbox and watermark authority. */
export function validateRootAgentMailModelAdmission(input: {
  readonly events: readonly RuntimeEvent[];
  readonly mutation: RuntimeAgentMailModelAdmissionInput['mutation'];
  readonly resourceBudget: RuntimeState['resourceBudget'];
  readonly sessionId: string;
}): void {
  const models = input.events.filter((event) => event.type === 'model.invocation_prepared');
  const prepared = input.events.filter((event) => event.type === 'agent.mail_input_prepared');
  const model = models[0];
  const mail = prepared[0];
  const sameBatchReservations = input.events.flatMap((event) => {
    if (event.type === 'resource_budget.reserved') return [event.reservation];
    if (event.type === 'resource_budget.bounded_replaced') return [event.replacement];
    return [];
  });
  const reservationId =
    model?.type === 'model.invocation_prepared' && model.budget.kind === 'reservation'
      ? model.budget.reservationId
      : undefined;
  const sameBatch = sameBatchReservations.find(
    (reservation) => reservation.reservationId === reservationId,
  );
  const persisted =
    input.resourceBudget.status === 'active' && reservationId
      ? input.resourceBudget.reservations[reservationId]
      : undefined;
  const reservation = sameBatch ?? persisted;
  if (
    models.length !== 1 ||
    prepared.length !== 1 ||
    !model ||
    !mail ||
    model.purpose !== 'primary_agent' ||
    model.parentInvocationId !== null ||
    model.parentToolCallId !== null ||
    mail.targetAgentId !== input.sessionId ||
    mail.invocationId !== model.invocationId ||
    input.mutation.targetAgentId !== input.sessionId ||
    input.mutation.modelInvocationId !== model.invocationId ||
    input.mutation.modelAdmissionId !== mail.modelAdmissionId ||
    input.mutation.fromSequence !== mail.fromSequence ||
    input.mutation.throughSequence !== mail.throughSequence ||
    input.mutation.messageIds.length !== mail.messageIds.length ||
    input.mutation.messageIds.some((id, index) => id !== mail.messageIds[index]) ||
    (input.resourceBudget.status === 'active'
      ? model.budget.kind !== 'reservation' ||
        !reservationId ||
        mail.modelAdmissionId !== reservationId ||
        !reservation ||
        reservation.runId !== input.resourceBudget.runId ||
        reservation.resourceKind !== 'model' ||
        reservation.invocationId !== `model-invocation:${model.invocationId}` ||
        (persisted !== undefined &&
          (persisted.runId !== reservation.runId ||
            persisted.invocationId !== reservation.invocationId ||
            persisted.resourceKind !== reservation.resourceKind)) ||
        sameBatchReservations.some(
          (candidate) =>
            candidate.resourceKind === 'model' &&
            candidate.invocationId === `model-invocation:${model.invocationId}` &&
            candidate.reservationId !== reservationId,
        )
      : model.budget.kind !== 'no_budget' ||
        mail.modelAdmissionId !== model.invocationId ||
        sameBatchReservations.length > 0)
  )
    throw new Error('Agent mail model admission identity is invalid.');
}

class RuntimeSessionCoordinatorImpl implements RuntimeSessionCoordinator {
  readonly sessionId: string;
  readonly session: StateRuntimeSession;
  readonly control: AuthorizedExecutionControl;
  readonly recoveryChanged: boolean;
  #lifecycle: RuntimeSessionCoordinator['lifecycle'] = 'idle';
  #activeOperation: 'turn' | 'compacting' | null = null;
  #activeCancelRun: (reason?: string, cause?: 'user' | 'error') => RuntimeEvent[] = () => [];
  #activeCommittedCommandCancel: RuntimeCommittedCommandCancellation = () => undefined;
  #operationCompletion: Promise<void> = Promise.resolve();
  #resolveOperationCompletion: (() => void) | null = null;
  #closePromise: Promise<void> | null = null;
  readonly #store: StateRuntimeStorage;
  readonly #workspace: string;
  readonly #projectId: string;
  readonly #canonicalWorkspaceDigest: `sha256:${string}`;
  readonly #userId: string;
  readonly #recoveryIdentityKey: string;
  #sandboxAvailable: boolean | undefined;
  #interactionMode: RuntimeState['mode'];
  #interactionModeRevision = 0;
  readonly #modelArtifactEvidence: ModelArtifactEvidenceAvailability | undefined;
  readonly #capabilityArtifactEvidence:
    | import('@kite-ai/builtin-runtime').CapabilityArtifactReader
    | undefined;
  readonly #services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
  readonly #capabilities: CapabilityExecutionPort;
  readonly #capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
  readonly #builtinToolCatalog: BuiltinToolCatalogProjection;
  readonly #toolPipelineComposition: AppToolPipelineComposition | undefined;
  readonly #modelRuntime: InstalledKiteRuntimeComposition;
  readonly #runtimePort: RuntimeStateSessionPort & {
    readonly runtimeStore: StateRuntimeStorage;
    processEvents(events: RuntimeEvent[]): void;
  };
  readonly #eventRevisions = new WeakMap<object, number>();
  readonly #eventStates = new WeakMap<object, Readonly<RuntimeState>>();
  readonly #pendingEventRevisions: Array<{
    readonly event: RuntimeEvent;
    readonly revision: number;
  }> = [];
  #lastRecordedEventRevision = 0;

  constructor(
    identity: RuntimeSessionCoordinatorIdentity,
    input: {
      readonly services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
      readonly capabilities: CapabilityExecutionPort;
      readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
      readonly builtinToolCatalog: BuiltinToolCatalogProjection;
      readonly toolPipelineComposition?: AppToolPipelineComposition;
      readonly modelRuntime: InstalledKiteRuntimeComposition;
      readonly store: StateRuntimeStorage;
    },
  ) {
    this.sessionId = identity.sessionId;
    this.#workspace = canonicalPathForComparison(identity.workspace);
    // Project identity owns its canonical filesystem spelling. Sandbox path
    // comparison intentionally case-folds Windows paths, but re-hashing that
    // separate projection would invalidate durable identities created from
    // native realpaths (notably 8.3 aliases and drive-letter casing).
    const projectIdentity = (() => {
      try {
        return resolveProjectIdentity(identity.workspace);
      } catch {
        const persisted = persistedWorkspaceIdentity(identity.workspace);
        if (!persisted) throw new Error('Runtime session Workspace is unavailable.');
        return persisted;
      }
    })();
    if (
      !identity.projectId.startsWith('project_') ||
      identity.canonicalWorkspaceDigest !== projectIdentity.workspaceDigest
    ) {
      throw new Error('Runtime session Project identity is invalid.');
    }
    this.#projectId = identity.projectId;
    this.#canonicalWorkspaceDigest = identity.canonicalWorkspaceDigest;
    this.#userId = identity.userId;
    this.#recoveryIdentityKey = identity.recoveryIdentityKey;
    this.#sandboxAvailable = identity.sandboxAvailable;
    this.#interactionMode = identity.interactionMode;
    this.#modelArtifactEvidence = identity.modelArtifactEvidence;
    this.#capabilityArtifactEvidence = identity.capabilityArtifactEvidence;
    this.#services = input.services;
    this.#capabilities = input.capabilities;
    this.#capabilityRegistrySnapshot = input.capabilityRegistrySnapshot;
    this.#builtinToolCatalog = input.builtinToolCatalog;
    this.#toolPipelineComposition = input.toolPipelineComposition;
    this.#modelRuntime = input.modelRuntime;
    this.#store = input.store;
    const restored = restoreRuntimeHostStateSession({
      sessions: input.services.sessions,
      sessionId: identity.sessionId,
      userId: identity.userId,
      workspace: identity.workspace,
      projectId: identity.projectId,
      canonicalWorkspaceDigest: identity.canonicalWorkspaceDigest,
      turnId: crypto.randomUUID(),
      recoveryIdentityKey: identity.recoveryIdentityKey,
      interactionMode: this.#interactionMode,
      phase: 'building',
      validateRestoredState: identity.capabilityArtifactEvidence
        ? (state) =>
            assertRestoredCapabilityArtifactEvidence(state, identity.capabilityArtifactEvidence!)
        : undefined,
    });
    this.session = createRuntimeHostStateSession({
      state: restored.state,
      services: input.services,
      clock: () => new Date().toISOString(),
      id: () => crypto.randomUUID(),
      sandboxAvailable: () => this.#sandboxAvailable === true,
      verificationSchemaAdmissions: (event) => projectVerificationSchemaAdmissions(event),
      eventBatchAdmissionValidator: (events) => {
        for (const event of events) {
          if (event.type !== 'interaction_mode.changed') continue;
          if (!Number.isFinite(Date.parse(event.changedAt))) {
            throw new Error('interaction_mode.changed requires a valid changedAt timestamp.');
          }
        }
        return true;
      },
      onNamedTurnSnapshot: ({ sessionId, turnId, state, eventPosition }) => {
        input.services.checkpoints.saveNamedSnapshot(
          sessionId,
          `turn-${turnId}-${eventPosition}`,
          state,
          eventPosition,
        );
      },
    });
    this.#interactionMode = restored.state.mode;
    this.#interactionModeRevision =
      'interactionModeRevision' in restored.state &&
      Number.isSafeInteger(restored.state.interactionModeRevision)
        ? Number(restored.state.interactionModeRevision)
        : 0;
    this.#runtimePort = this.#createRuntimePort();
    const recoveryEvents =
      restored.state.recoveryState.kind === 'normal'
        ? projectRuntimeHostStateRestartRecoveryEvents(restored.state, {
            preserveReservedChildDelegations: identity.preserveReservedChildDelegations,
            preservePendingAfterTurnDelegations: identity.preservePendingAfterTurnDelegations,
            preserveLiveAfterTurnDelegations: identity.preserveLiveAfterTurnDelegations,
            preserveSealedAfterTurnReports: identity.preserveSealedAfterTurnReports,
            preservePendingFollowupFunding: identity.preservePendingFollowupFunding,
            preservePreparedFollowupModels: identity.preservePreparedFollowupModels,
            preservePreparedCurrentTurnModels: identity.preservePreparedCurrentTurnModels,
            preserveDispatchedChildDelegations: identity.preserveDispatchedChildDelegations,
            capabilityFinishedAtByInvocationId: Object.fromEntries(
              runtimeHostStateRestartRecoveryCapabilityInvocationIds(restored.state).map(
                (invocationId) => [invocationId, new Date().toISOString()],
              ),
            ),
            pendingModelEvidenceFailures: Object.fromEntries(
              Object.values(restored.state.modelInvocations)
                .filter(
                  (invocation) =>
                    invocation.status === 'prepared' || invocation.status === 'dispatching',
                )
                .map((invocation) => [
                  invocation.invocationId,
                  verifyPendingModelInvocationEvidence(invocation, identity.modelArtifactEvidence),
                ]),
            ),
            completedModelEvidenceFailures: Object.fromEntries(
              Object.values(restored.state.modelInvocations)
                .filter((invocation) => invocation.status === 'completed')
                .map((invocation) => [
                  invocation.invocationId,
                  verifyCompletedModelInvocationEvidence(
                    invocation,
                    identity.modelArtifactEvidence,
                  ),
                ]),
            ),
          })
        : [];
    const appliedRecoveryEvents =
      recoveryEvents.length > 0
        ? this.session.processEventBatch(recoveryEvents, {
            acknowledgement: 'terminal_recovery',
            source: 'host_fact',
          })
        : [];
    this.recoveryChanged = appliedRecoveryEvents.length > 0;
    this.control = Object.freeze({
      getState: () => this.getState(),
      processEvent: (event: RuntimeEvent) => {
        this.#assertOpen();
        const before = this.session.getState();
        this.session.processEvent(event);
        this.#recordLastAppliedEventRevisions(before);
      },
      processEventBatch: (events: RuntimeEvent[]) => {
        this.#assertOpen();
        const before = this.session.getState();
        const applied = [...this.session.processEventBatch(events)];
        this.#recordLastAppliedEventRevisions(before);
        return applied;
      },
      cancelRun: (reason?: string, cause?: 'user' | 'error') => {
        this.#assertOpen();
        // The registered turn cancellation persists through #runtimePort,
        // which records the exact State for every canonical event.
        return this.#activeCancelRun(reason, cause);
      },
    });
  }

  get lifecycle(): RuntimeSessionCoordinator['lifecycle'] {
    return this.#lifecycle;
  }

  getState(): Readonly<RuntimeState> {
    this.#assertOpen();
    return this.session.getState();
  }

  revisionForEvent(event: RuntimeEvent): number | undefined {
    return this.#eventRevisions.get(event);
  }

  takeCommittedEventsThrough(revision: number): readonly RuntimeEvent[] {
    const end = this.#pendingEventRevisions.findIndex((pending) => pending.revision > revision);
    return this.#pendingEventRevisions
      .splice(0, end < 0 ? this.#pendingEventRevisions.length : end)
      .map((pending) => pending.event);
  }

  stateForEvent(event: RuntimeEvent): Readonly<RuntimeState> | undefined {
    return this.#eventStates.get(event);
  }

  getStateRuntimeStorage(): StateRuntimeStorage {
    this.#assertOpen();
    return this.#store;
  }

  commitBackgroundAgentSettlement(
    input: import('./subagent/task-tool').BackgroundAgentSettlementCommitInput,
  ): ReturnType<StateRuntimeSession['commitBackgroundAgentSettlement']> {
    this.#assertOpen();
    const mailbox = this.#store.agentMailbox;
    if (!mailbox || input.notification.originRunId.length === 0)
      throw new Error('Background Agent settlement authority is unavailable.');
    const agentId = input.notification.taskId;
    const agent = mailbox.readAgent(this.sessionId, this.sessionId, agentId);
    if (!agent) throw new Error('Background Agent identity is unavailable.');
    const activeTaskProof = mailbox.readActiveTaskProof(
      this.sessionId,
      this.sessionId,
      agentId,
      agentId,
    );
    const before = this.session.getState();
    const call = before.tools.calls[input.notification.originToolCallId];
    const reply =
      agent.status === 'active' && call?.modelInvocationId
        ? prepareBackgroundAgentTerminalReply({
            sessionId: this.sessionId,
            notification: input.notification,
            parentModelInvocationId: call.modelInvocationId,
            parentCapabilityInvocationId: input.parentCapabilityInvocationId,
            sequence: mailbox.nextSequence(this.sessionId, this.sessionId),
            acceptedAtMs: Date.now(),
          })
        : undefined;
    const result = this.session.commitBackgroundAgentSettlement({
      resultEvent: input.resultEvent,
      resultRef: input.notification.resultArtifact,
      readResultArtifact: input.readResultArtifact,
      grantDigest: input.grantDigest,
      activeTaskProof,
      ...(reply ? { reply } : {}),
      agent: {
        agentId,
        currentTaskId: agent.currentTaskId,
        status: agent.status,
      },
    });
    this.#recordLastAppliedEventRevisions(before);
    return result;
  }

  commitChildBudgetActivation(
    events: Parameters<StateRuntimeSession['commitChildBudgetActivation']>[0],
    mutation: Parameters<StateRuntimeSession['commitChildBudgetActivation']>[1],
    evidence: Parameters<StateRuntimeSession['commitChildBudgetActivation']>[2],
  ): ReturnType<StateRuntimeSession['commitChildBudgetActivation']> {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = this.session.commitChildBudgetActivation(events, mutation, evidence);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  commitChildSlotAcquisition(reservationId: string): void {
    this.#assertOpen();
    const before = this.session.getState();
    this.session.processEventBatch([
      { type: 'resource_budget.child_slot_acquired', reservationId },
    ]);
    this.#recordLastAppliedEventRevisions(before);
  }

  commitChildDispatchAck(
    childThreadId: string,
  ): ReturnType<StateRuntimeSession['commitChildDispatchAck']> {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = this.session.commitChildDispatchAck(childThreadId);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  commitCrossSessionQueueMailReceive(
    event: Extract<RuntimeEvent, { type: 'agent.mail_accepted' }>,
    mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'receive_queue' }>,
  ): readonly RuntimeEvent[] {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = this.session.commitCrossSessionQueueMailReceive(event, mutation);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  commitChildCreationFailure(
    input: Parameters<StateRuntimeSession['commitChildCreationFailure']>[0],
  ): ReturnType<StateRuntimeSession['commitChildCreationFailure']> {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = this.session.commitChildCreationFailure(input);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  commitChildRecoveryRequired(
    event: Parameters<StateRuntimeSession['commitChildRecoveryRequired']>[0],
  ): ReturnType<StateRuntimeSession['commitChildRecoveryRequired']> {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = this.session.commitChildRecoveryRequired(event);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  commitChildSessionTerminalImport(
    input: Parameters<StateRuntimeSession['commitChildSessionTerminalImport']>[0],
  ): ReturnType<StateRuntimeSession['commitChildSessionTerminalImport']> {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = this.session.commitChildSessionTerminalImport(input);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  isTurnActive(): boolean {
    return this.#activeOperation === 'turn';
  }

  beginTurn(): void {
    this.#beginOperation('turn');
    this.#lifecycle = 'running';
  }

  endTurn(): void {
    if (this.#activeOperation !== 'turn') return;
    this.#activeOperation = null;
    if (this.#lifecycle !== 'closing') this.#lifecycle = 'idle';
    this.#resolveOperationCompletion?.();
    this.#resolveOperationCompletion = null;
  }

  updateInteractionMode(mode: RuntimeState['mode']): void {
    this.#assertOpen();
    if (this.#interactionMode === mode) return;
    this.#interactionMode = mode;
    const persistedRevision = this.session.getState().interactionModeRevision;
    this.#interactionModeRevision = Number.isSafeInteger(persistedRevision)
      ? persistedRevision
      : this.#interactionModeRevision + 1;
  }

  getInteractionModeState(): Readonly<{
    interactionMode: RuntimeState['mode'];
    interactionModeRevision: number;
  }> {
    this.#assertOpen();
    return projectRuntimeSessionLiveMode({
      mode: this.#interactionMode,
      interactionModeRevision: this.#interactionModeRevision,
    });
  }

  updateSandboxAvailable(available: boolean): void {
    this.#assertOpen();
    if (this.#activeOperation) {
      throw new Error('Runtime sandbox identity cannot change during an active operation.');
    }
    this.#sandboxAvailable = available;
  }

  getSandboxAvailable(): boolean | undefined {
    return this.#sandboxAvailable;
  }

  setActiveCancelRun(
    cancelRun: (reason?: string, cause?: 'user' | 'error') => RuntimeEvent[],
  ): void {
    this.#assertOpen();
    this.#activeCancelRun = cancelRun;
  }

  clearActiveCancelRun(): void {
    this.#activeCancelRun = () => [];
    this.#activeCommittedCommandCancel = () => undefined;
  }

  commitInteractionModeCommand(
    command: Extract<RuntimeCommand, { readonly type: 'set_interaction_mode' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedControlCommand {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = commitInteractionModeCommand(this.session, command, evidence);
    this.#recordLastAppliedEventRevisions(before);
    // State is authoritative; the live coordinator view follows only after
    // the command receipt transaction has succeeded.
    this.#interactionMode = command.mode;
    this.#interactionModeRevision = this.session.getState().interactionModeRevision;
    return committed;
  }

  commitCancelTurnCommand(
    command: Extract<RuntimeCommand, { readonly type: 'cancel_turn' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedControlCommand {
    this.#assertOpen();
    const before = this.session.getState();
    const history = this.#store.sessions
      .loadEventsStrict(this.sessionId)
      .map((entry) => entry.event);
    const committed = commitCancelTurnCommand(this.session, command, evidence, history);
    this.#recordLastAppliedEventRevisions(before);
    this.#activeCommittedCommandCancel(committed.events, 'Cancelled by user.');
    return committed;
  }

  commitCloseSessionCommand(
    command: Extract<RuntimeCommand, { readonly type: 'close_session' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedCloseSessionCommand {
    this.#assertOpen();
    if (this.#activeOperation && this.#activeOperation !== 'turn') {
      throw new Error(`Runtime session is busy with ${this.#activeOperation}.`);
    }
    const before = this.session.getState();
    const history = this.#store.sessions
      .loadEventsStrict(this.sessionId)
      .map((entry) => entry.event);
    const committed = commitCloseSessionCommand(this.session, command, evidence, history);
    this.#recordLastAppliedEventRevisions(before);
    if (committed.wasActive) {
      this.#activeCommittedCommandCancel(committed.events, 'Runtime session closed.');
    }
    return committed;
  }

  commitClearSessionCommandGrantsCommand(
    command: Extract<RuntimeCommand, { readonly type: 'clear_session_command_grants' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedControlCommand {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = commitClearSessionCommandGrantsCommand(this.session, command, evidence);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  commitForkSessionCommand(
    command: Extract<RuntimeCommand, { readonly type: 'fork_session' }>,
    targetSessionId: string,
    targetRecoveryIdentityKey: string,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedForkSessionCommand {
    this.#assertOpen();
    if (this.#activeOperation) {
      throw new Error(`Runtime session is busy with ${this.#activeOperation}.`);
    }
    return commitForkSessionCommand(
      this.session,
      this.#store,
      command,
      targetSessionId,
      targetRecoveryIdentityKey,
      evidence,
    );
  }

  commitRewindCommand(
    command: Extract<RuntimeCommand, { readonly type: 'rewind_session' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedRewindCommand {
    this.#assertOpen();
    if (this.#activeOperation) {
      throw new Error(`Runtime session is busy with ${this.#activeOperation}.`);
    }
    const before = this.session.getState();
    const committed = commitRewindCommand(this.session, command, evidence);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  persistRewindTerminal(
    event: Extract<RuntimeEvent, { type: 'session.rewind_completed' | 'session.rewind_failed' }>,
  ): readonly RuntimeEvent[] {
    this.#assertOpen();
    const before = this.session.getState();
    const applied = this.session.processEventBatch([event]);
    this.#recordLastAppliedEventRevisions(before);
    return applied;
  }

  commitStartTurnCommand(
    command: Extract<RuntimeCommand, { readonly type: 'start_turn' }>,
    evidence: RuntimeCommandCommitEvidence,
    context?: StartTurnSkillPlanningContext,
    admittedModelRoute?: { readonly provider: string; readonly name: string },
  ): CommittedStartTurnCommand {
    this.#assertOpen();
    if (this.#activeOperation) {
      throw new Error(`Runtime session is busy with ${this.#activeOperation}.`);
    }
    const before = this.session.getState();
    const committed = commitStartTurnCommand(
      this.session,
      command,
      evidence,
      context,
      admittedModelRoute,
    );
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  commitSteerTurnCommand(
    command: Extract<RuntimeCommand, { readonly type: 'steer_turn' }>,
    evidence: RuntimeCommandCommitEvidence,
  ): CommittedSteerTurnCommand {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = commitSteerTurnCommand(
      this.session,
      command,
      evidence,
      this.#store.sessions.loadEventsStrict(this.sessionId),
    );
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  canAcceptSteerInput(): boolean {
    this.#assertOpen();
    return steerQueueHasCapacity(
      this.getState(),
      this.#store.sessions.loadEventsStrict(this.sessionId),
    );
  }

  activateStartTurnRun(runId: string): void {
    this.#assertOpen();
    this.session.activateRun(runId);
  }

  commitInteractionCommand(
    input: RuntimeInteractionCommandCommitInput,
  ): CommittedInteractionCommand {
    this.#assertOpen();
    const before = this.session.getState();
    const result = commitInteractionCommand(this.session, input);
    this.#recordLastAppliedEventRevisions(before);
    return result;
  }

  commitObsoleteAdmissionResumeCommand(
    events: readonly Extract<RuntimeEvent, { type: 'provider.admission_cancelled' }>[],
    evidence: RuntimeCommandCommitEvidence,
  ): Readonly<{ receipt: RuntimeStoredCommandReceipt; events: readonly RuntimeEvent[] }> {
    this.#assertOpen();
    if (this.#activeOperation || events.length === 0) {
      throw new Error('Runtime obsolete admission resume is unavailable.');
    }
    const before = this.session.getState();
    const committed = this.session.commitCommandBatch(events, evidence);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  commitCompactionCommandEvents(
    events: readonly RuntimeEvent[],
    evidence: RuntimeCommandCommitEvidence,
  ): Readonly<{
    receipt: RuntimeStoredCommandReceipt;
    events: readonly RuntimeEvent[];
  }> {
    this.#assertOpen();
    const before = this.session.getState();
    const committed = this.session.commitCommandBatch(events, evidence);
    this.#recordLastAppliedEventRevisions(before);
    return committed;
  }

  async *executeTurn(
    input: Omit<RuntimeTurnInput, 'runtimeSession' | 'createRuntimeEffectPort'>,
    provider: RuntimeActionProvider,
  ): AsyncGenerator<RuntimeEvent> {
    this.#assertOpen();
    if (
      input.threadId !== this.sessionId ||
      canonicalPathForComparison(input.workspace) !== this.#workspace ||
      input.userId !== this.#userId
    ) {
      throw new Error('Runtime turn identity mismatch.');
    }
    this.beginTurn();
    try {
      yield* executeRuntimeTurn(
        {
          ...input,
          runtimeSession: this.#runtimePort,
          createRuntimeEffectPort: (dependencies) => this.createRuntimeEffectPort(dependencies),
          registerRunCancellation: (cancelRun) => {
            if (cancelRun) this.setActiveCancelRun(cancelRun);
            else this.clearActiveCancelRun();
          },
          registerCommittedCommandCancellation: (cancel) => {
            this.#activeCommittedCommandCancel = cancel ?? (() => undefined);
          },
        },
        provider,
      );
    } finally {
      this.clearActiveCancelRun();
      this.endTurn();
    }
  }

  createRuntimeEffectPort(dependencies: RuntimeExecutorDependencies): RuntimeEffectExecutor {
    this.#assertOpen();
    if (dependencies.runtimeStore !== this.#store) {
      throw new Error('Runtime effect store identity mismatch.');
    }
    if (dependencies.capabilityExecution !== this.#capabilities) {
      throw new Error('Runtime capability execution port identity mismatch.');
    }
    if (dependencies.builtinToolCatalog !== this.#builtinToolCatalog) {
      throw new Error('Runtime Builtin catalog identity mismatch.');
    }
    if (
      this.#toolPipelineComposition &&
      dependencies.toolPipelineComposition !== this.#toolPipelineComposition
    ) {
      throw new Error('Runtime Tool Pipeline composition identity mismatch.');
    }
    if (
      !Object.isFrozen(this.#capabilityRegistrySnapshot) ||
      !Object.isFrozen(this.#capabilityRegistrySnapshot.modules) ||
      !Object.isFrozen(this.#capabilityRegistrySnapshot.capabilities) ||
      !Object.isFrozen(this.#capabilityRegistrySnapshot.contextSources)
    ) {
      throw new Error('Runtime capability snapshot is no longer frozen.');
    }
    if (
      !this.#services.sessions ||
      !this.#services.transactions ||
      !this.#services.leases ||
      !this.#services.checkpoints ||
      !this.#services.recoveryIdentities
    ) {
      throw new Error('Runtime Host services are incomplete.');
    }
    if (this.#modelRuntime.status !== 'available') {
      throw new Error('Runtime Model composition is unavailable.');
    }
    if (
      dependencies.modelInvocationGateway !== this.#modelRuntime.gateway ||
      dependencies.modelEffectCoordinator !== this.#modelRuntime.modelEffects
    ) {
      throw new Error('Runtime Model composition identity mismatch.');
    }
    return createAppRuntimeEffectExecutor(dependencies);
  }

  async executePendingCompaction(input: {
    readonly dependencies: RuntimeExecutorDependencies;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeEvent[]> {
    this.#assertOpen();
    this.#beginOperation('compacting');
    this.#lifecycle = 'compacting';
    let runnerId: string | null = null;
    let effectLease: StateRuntimeSessionEffectLease | null = null;
    try {
      runnerId = this.session.acquireRunner();
      if (!runnerId) {
        throw new Error('Runtime session already has an active Kernel runner.');
      }
      const pending = this.session.getState().context.pendingCompaction;
      if (!pending) return [];
      const effect = {
        type: 'compact_context' as const,
        compactionId: pending.compactionId,
      };
      const dependencies: RuntimeExecutorDependencies = {
        ...input.dependencies,
        runtimeStore: this.#store,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const executor = this.createRuntimeEffectPort(dependencies);
      const lease = this.session.beginEffect(effect);
      effectLease = lease;
      const persistedDuringExecution: RuntimeEvent[] = [];
      let terminalPersisted = false;
      const isTerminalForThisCompaction = (event: RuntimeEvent): boolean =>
        (event.type === 'context.compaction_completed' ||
          event.type === 'context.compaction_failed') &&
        event.compactionId === pending.compactionId;
      const persistEvents = async (
        events: RuntimeEvent[],
        requiredEffectLease?: RuntimeEffectLeaseExpectation,
      ): Promise<boolean> => {
        if (terminalPersisted && events.some(isTerminalForThisCompaction)) return false;
        const before = this.session.getState();
        const applied = this.session.applyEffectResult(
          lease,
          events,
          requiredEffectLease
            ? {
                sessionId: this.sessionId,
                effectId: requiredEffectLease.effectId,
                ownerId: requiredEffectLease.ownerId,
              }
            : undefined,
        );
        if (applied) {
          this.#recordLastAppliedEventRevisions(before);
          const appliedEvents = [...this.session.getLastAppliedEvents()];
          persistedDuringExecution.push(...appliedEvents);
          if (appliedEvents.some(isTerminalForThisCompaction)) terminalPersisted = true;
        }
        return applied;
      };
      const events = await executor(effect, this.session.getState(), undefined, {
        reservationIds: [],
        getState: () => this.session.getState(),
        persistEvent: async (event) => {
          if (terminalPersisted && isTerminalForThisCompaction(event)) return false;
          const before = this.session.getState();
          const applied = this.session.applyEffectEvent(lease, event);
          if (applied) {
            this.#recordLastAppliedEventRevisions(before);
            if (isTerminalForThisCompaction(event)) terminalPersisted = true;
          }
          return applied;
        },
        persistEvents,
      });
      if (events.length === 0) return persistedDuringExecution;
      if (terminalPersisted && events.some(isTerminalForThisCompaction)) {
        return persistedDuringExecution;
      }
      const before = this.session.getState();
      if (!this.session.applyEffectResult(lease, events)) return persistedDuringExecution;
      this.#recordLastAppliedEventRevisions(before);
      const appliedEvents = [...this.session.getLastAppliedEvents()];
      return [...persistedDuringExecution, ...appliedEvents];
    } finally {
      if (effectLease) this.session.releaseEffect(effectLease);
      if (runnerId) this.session.releaseRunner(runnerId);
      this.#finishOperation();
    }
  }

  waitForIdle(): Promise<void> {
    return this.#operationCompletion;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#lifecycle = 'closing';
    this.#closePromise = this.#operationCompletion.then(() => {
      this.clearActiveCancelRun();
      this.#lifecycle = 'closed';
    });
    return this.#closePromise;
  }

  #beginOperation(operation: 'turn' | 'compacting'): void {
    this.#assertOpen();
    if (this.#activeOperation) {
      throw new Error(`Runtime session is busy with ${this.#activeOperation}.`);
    }
    this.#activeOperation = operation;
    this.#operationCompletion = new Promise<void>((resolve) => {
      this.#resolveOperationCompletion = resolve;
    });
  }

  #finishOperation(): void {
    this.#activeOperation = null;
    if (this.#lifecycle !== 'closing' && this.#lifecycle !== 'closed') this.#lifecycle = 'idle';
    this.#resolveOperationCompletion?.();
    this.#resolveOperationCompletion = null;
    this.#operationCompletion = Promise.resolve();
  }

  #assertOpen(): void {
    if (this.#lifecycle === 'closing' || this.#lifecycle === 'closed') {
      throw new Error(`Runtime session is ${this.#lifecycle}.`);
    }
  }

  assertIdentity(identity: RuntimeSessionCoordinatorIdentity): void {
    if (
      canonicalPathForComparison(identity.workspace) !== this.#workspace ||
      identity.sessionId !== this.sessionId ||
      identity.userId !== this.#userId ||
      identity.projectId !== this.#projectId ||
      identity.canonicalWorkspaceDigest !== this.#canonicalWorkspaceDigest ||
      identity.recoveryIdentityKey !== this.#recoveryIdentityKey ||
      identity.sandboxAvailable !== this.#sandboxAvailable ||
      identity.modelArtifactEvidence !== this.#modelArtifactEvidence ||
      identity.capabilityArtifactEvidence !== this.#capabilityArtifactEvidence
    ) {
      throw new Error('Runtime session identity drifted.');
    }
  }

  #createRuntimePort(): RuntimeStateSessionPort & {
    readonly runtimeStore: StateRuntimeStorage;
    processEvents(events: RuntimeEvent[]): void;
  } {
    const applyAction = (
      action: RuntimeUserAction,
      additionalEvents: RuntimeEvent[] = [],
    ): RuntimeActionResult => {
      const events = eventsForRuntimeAction(this.session.getState(), action, {
        sandboxAvailable: this.#sandboxAvailable === true,
      });
      if (events.length === 0) {
        const reason =
          this.session.getState().interactions.kind === 'idle'
            ? 'No active interaction accepts this action.'
            : 'The action does not match the active interaction.';
        return {
          status: this.session.getState().interactions.kind === 'idle' ? 'rejected' : 'stale',
          reason,
          telemetry: {
            type: 'runtime.action_ignored',
            ...('interactionId' in action ? { interactionId: action.interactionId } : {}),
            reason,
          },
        };
      }
      const batchRelease =
        events.length === 1 &&
        additionalEvents.length === 0 &&
        events[0]?.type === 'approval.batch_released'
          ? events[0]
          : undefined;
      let applied: readonly RuntimeEvent[];
      if (batchRelease) {
        const before = this.session.getState();
        this.session.commitApprovalBatch(batchRelease, batchRelease.sessionRevision);
        this.#recordLastAppliedEventRevisions(before);
        applied = this.session.getLastAppliedEvents();
      } else {
        const before = this.session.getState();
        const settlement = approvalRejectionSettlementEvents(this.session.getState(), events);
        applied = this.session.processEventBatch([...events, ...additionalEvents, ...settlement], {
          source: 'command',
        });
        this.#recordLastAppliedEventRevisions(before);
      }
      return { status: 'applied', events: [...applied] };
    };
    const port: RuntimeStateSessionPort & {
      readonly runtimeStore: StateRuntimeStorage;
      processEvents(events: RuntimeEvent[]): void;
    } = {
      runtimeStore: this.#store,
      getState: () => this.session.getState(),
      currentRunId: () => this.session.getLifecycleProjection().currentRun?.runId ?? null,
      waitForRevisionChange: (revision, signal) =>
        this.session.waitForRevisionChange!(revision, signal),
      processEvent: (event: RuntimeEvent) => {
        const before = this.session.getState();
        const result = this.session.processEvent(event);
        this.#recordLastAppliedEventRevisions(before);
        return result;
      },
      processEventBatch: (events: RuntimeEvent[]) => {
        const before = this.session.getState();
        const result = this.session.processEventBatch(events);
        this.#recordLastAppliedEventRevisions(before);
        return result;
      },
      processEvents: (events: RuntimeEvent[]) => {
        for (const event of events) {
          const before = this.session.getState();
          this.session.processEvent(event);
          this.#recordLastAppliedEventRevisions(before);
        }
      },
      getLastAppliedEvents: () => this.session.getLastAppliedEvents(),
      selectPendingEffects: (
        state?: Readonly<RuntimeState>,
        facts?: Parameters<StateRuntimeSession['selectPendingEffects']>[1],
      ) => this.session.selectPendingEffects(state, facts),
      acquireRunner: () => this.session.acquireRunner(),
      releaseRunner: (runnerId: string) => this.session.releaseRunner(runnerId),
      beginEffect: (effect) => this.session.beginEffect(effect),
      isEffectEventCurrent: (lease, event) => this.session.isEffectEventCurrent(lease, event),
      applyEffectEvent: (lease, event) => {
        const before = this.session.getState();
        const result = this.session.applyEffectEvent(lease, event);
        this.#recordLastAppliedEventRevisions(before);
        return result;
      },
      applyEffectEvents: (lease, events, acknowledgement, requiredEffectLease) => {
        const before = this.session.getState();
        const result = this.session.applyEffectEvents(
          lease,
          events,
          acknowledgement,
          requiredEffectLease
            ? {
                sessionId: this.sessionId,
                effectId: requiredEffectLease.effectId,
                ownerId: requiredEffectLease.ownerId,
              }
            : undefined,
        );
        this.#recordLastAppliedEventRevisions(before);
        return result;
      },
      commitBackgroundChildAcceptance: (lease, events, requiredEffectLease, sealedGrant) => {
        const before = this.session.getState();
        const result = this.session.commitBackgroundChildAcceptance(
          lease,
          events,
          {
            sessionId: this.sessionId,
            effectId: requiredEffectLease.effectId,
            ownerId: requiredEffectLease.ownerId,
          },
          sealedGrant,
        );
        this.#recordLastAppliedEventRevisions(before);
        return result;
      },
      applyEffectResult: (lease, events, requiredEffectLease) => {
        const before = this.session.getState();
        const result = this.session.applyEffectResult(
          lease,
          events,
          requiredEffectLease
            ? {
                sessionId: this.sessionId,
                effectId: requiredEffectLease.effectId,
                ownerId: requiredEffectLease.ownerId,
              }
            : undefined,
        );
        this.#recordLastAppliedEventRevisions(before);
        return result;
      },
      applyLateResourceReconciliation: (events) => {
        const before = this.session.getState();
        const result = this.session.applyLateResourceReconciliation(events);
        this.#recordLastAppliedEventRevisions(before);
        return result;
      },
      applyAction,
      getSandboxAvailable: () => this.#sandboxAvailable === true,
      commitInteractionCommand: (input) => {
        const before = this.session.getState();
        const result = commitInteractionCommand(this.session, input);
        this.#recordLastAppliedEventRevisions(before);
        return result;
      },
      releaseEffect: (lease) => this.session.releaseEffect(lease),
      commitAgentMailboxCommand: (
        lease: StateRuntimeSessionEffectLease,
        input: RuntimeAgentMailboxCommandCommitInput,
      ) => {
        const runTools = lease.effect.type === 'run_tools' ? lease.effect : undefined;
        const state = this.session.getState();
        if (
          !runTools ||
          !this.session.isEffectLeaseCurrent(lease) ||
          input.events.some((event) => {
            if (event.type !== 'agent.mail_accepted') return false;
            const tool = state.tools.calls[event.source.toolCallId];
            const response = state.transcript.messages.find(
              (message) =>
                message.kind === 'assistant' && message.messageId === tool?.modelMessageId,
            );
            return (
              !runTools.toolCallIds.includes(event.source.toolCallId) ||
              event.source.turnId !== lease.turnId ||
              tool?.createdAtTurnId !== lease.turnId ||
              response?.kind !== 'assistant' ||
              response.modelInvocationId !== event.source.modelInvocationId
            );
          })
        )
          throw new Error('Agent mailbox command is outside its active Tool effect lease.');
        const storeEffectId = `agent-mail-command:${input.evidence.commandId}`;
        const ownerId = `agent_mail_${crypto.randomUUID()}`;
        const leaseDeadline = () => Date.now() + 30_000;
        if (
          !this.#services.leases.tryAcquire(this.sessionId, storeEffectId, ownerId, leaseDeadline())
        )
          throw new Error('Agent mailbox Store effect lease is unavailable.');
        try {
          if (
            !this.session.isEffectLeaseCurrent(lease) ||
            !this.#services.leases.renew(this.sessionId, storeEffectId, ownerId, leaseDeadline())
          )
            throw new Error('Agent mailbox Tool or Store effect lease became stale.');
          const before = this.session.getState();
          const result = this.session.commitAgentMailboxCommand(
            input.events,
            input.mutations,
            input.evidence,
            { sessionId: this.sessionId, effectId: storeEffectId, ownerId },
          );
          this.#recordLastAppliedEventRevisions(before);
          // The same Tool effect still owns its eventual terminal receipt.
          // Advance only this in-process lease after the durable mail commit.
          lease.expectedRevision = this.session.getState().revision;
          return result;
        } finally {
          this.#services.leases.release(this.sessionId, storeEffectId, ownerId);
        }
      },
      commitCrossSessionQueueMailCommand: (
        lease: StateRuntimeSessionEffectLease,
        input: RuntimeCrossSessionQueueMailCommandInput,
      ) => {
        if (lease.effect.type !== 'run_tools' || !this.session.isEffectLeaseCurrent(lease))
          throw new Error('Cross-Session mail requires the current Tool effect.');
        const storeEffectId = `cross-agent-mail-command:${input.evidence.commandId}`;
        const ownerId = `cross_mail_${crypto.randomUUID()}`;
        const deadline = () => Date.now() + 30_000;
        if (!this.#services.leases.tryAcquire(this.sessionId, storeEffectId, ownerId, deadline()))
          throw new Error('Cross-Session mail Store lease is unavailable.');
        try {
          if (
            !this.session.isEffectLeaseCurrent(lease) ||
            !this.#services.leases.renew(this.sessionId, storeEffectId, ownerId, deadline())
          )
            throw new Error('Cross-Session mail Tool or Store lease became stale.');
          const before = this.session.getState();
          const committed = this.session.commitCrossSessionQueueMailCommand(
            lease,
            input.event,
            input.mutation,
            input.evidence,
            { sessionId: this.sessionId, effectId: storeEffectId, ownerId },
          );
          this.#recordLastAppliedEventRevisions(before);
          return committed;
        } finally {
          this.#services.leases.release(this.sessionId, storeEffectId, ownerId);
        }
      },
      commitCrossSessionInterruptCommand: (
        lease: StateRuntimeSessionEffectLease,
        input: RuntimeCrossSessionInterruptCommandInput,
      ) => {
        if (lease.effect.type !== 'run_tools' || !this.session.isEffectLeaseCurrent(lease))
          throw new Error('Cross-Session interrupt requires the current Tool effect.');
        const storeEffectId = `cross-agent-interrupt-command:${input.evidence.commandId}`;
        const ownerId = `cross_interrupt_${crypto.randomUUID()}`;
        const deadline = () => Date.now() + 30_000;
        if (!this.#services.leases.tryAcquire(this.sessionId, storeEffectId, ownerId, deadline()))
          throw new Error('Cross-Session interrupt Store lease is unavailable.');
        try {
          if (
            !this.session.isEffectLeaseCurrent(lease) ||
            !this.#services.leases.renew(this.sessionId, storeEffectId, ownerId, deadline())
          )
            throw new Error('Cross-Session interrupt Tool or Store lease became stale.');
          const before = this.session.getState();
          const committed = this.session.commitCrossSessionInterruptCommand(
            lease,
            input.event,
            input.mutation,
            input.evidence,
            { sessionId: this.sessionId, effectId: storeEffectId, ownerId },
          );
          this.#recordLastAppliedEventRevisions(before);
          return committed;
        } finally {
          this.#services.leases.release(this.sessionId, storeEffectId, ownerId);
        }
      },
      commitCrossSessionFollowupCommand: (
        lease: StateRuntimeSessionEffectLease,
        input: RuntimeCrossSessionFollowupCommandInput,
      ) => {
        if (lease.effect.type !== 'run_tools' || !this.session.isEffectLeaseCurrent(lease))
          throw new Error('Cross-Session followup requires the current Tool effect.');
        const storeEffectId = `cross-agent-followup-command:${input.evidence.commandId}`;
        const ownerId = `cross_followup_${crypto.randomUUID()}`;
        const deadline = () => Date.now() + 30_000;
        if (!this.#services.leases.tryAcquire(this.sessionId, storeEffectId, ownerId, deadline()))
          throw new Error('Cross-Session followup Store lease is unavailable.');
        try {
          if (
            !this.session.isEffectLeaseCurrent(lease) ||
            !this.#services.leases.renew(this.sessionId, storeEffectId, ownerId, deadline())
          )
            throw new Error('Cross-Session followup Tool or Store lease became stale.');
          const before = this.session.getState();
          const committed = this.session.commitCrossSessionFollowupCommand(
            lease,
            input.reservationEvent,
            input.event,
            input.mutation,
            input.evidence,
            { sessionId: this.sessionId, effectId: storeEffectId, ownerId },
          );
          this.#recordLastAppliedEventRevisions(before);
          return committed;
        } finally {
          this.#services.leases.release(this.sessionId, storeEffectId, ownerId);
        }
      },
      commitCurrentTurnFollowupRoute: (
        lease: StateRuntimeSessionEffectLease,
        events: readonly [
          Extract<RuntimeEvent, { type: 'agent.followup_routed' }>,
          Extract<RuntimeEvent, { type: 'agent.mail_input_prepared' }>,
        ],
        mutation: Extract<RuntimeCrossSessionAgentMailMutation, { kind: 'route_followup' }>,
      ) => {
        const before = this.session.getState();
        const committed = this.session.commitCrossSessionFollowupRouteForModelEffect(
          lease,
          events,
          mutation,
        );
        this.#recordLastAppliedEventRevisions(before);
        return committed;
      },
      persistCrossSessionQueueMailModelInput: (
        lease: StateRuntimeSessionEffectLease,
        input: RuntimeCrossSessionQueueMailModelInput,
      ) => {
        if (lease.effect.type !== 'call_model' || !this.session.isEffectLeaseCurrent(lease))
          throw new Error('Cross-Session mail requires the current model effect.');
        const currentRun = this.session.getLifecycleProjection().currentRun;
        if (
          !currentRun ||
          currentRun.runId !== input.mutation.currentRunId ||
          (currentRun.status !== 'running' && currentRun.status !== 'waiting')
        )
          throw new Error('Cross-Session mail model Run changed.');
        const before = this.session.getState();
        const committed = this.session.commitCrossSessionQueueMailModelInput(
          lease,
          input.events,
          input.mutation,
        );
        this.#recordLastAppliedEventRevisions(before);
        return committed;
      },
      commitAgentMailboxFacts: (
        lease: StateRuntimeSessionEffectLease,
        input: RuntimeAgentMailboxFactsCommitInput,
      ) => {
        const runTools = lease.effect.type === 'run_tools' ? lease.effect : undefined;
        const starts = input.events.filter((event) => event.type === 'subagent.started');
        const created = input.events.filter((event) => event.type === 'agent.created');
        const turns = input.events.filter((event) => event.type === 'agent.turn_started');
        const dispatches = input.events.filter(
          (event) => event.type === 'capability.subagent_dispatch_intent_recorded',
        );
        const creates = input.mutations.filter((mutation) => mutation.kind === 'create_agent');
        const mutationsTurn = input.mutations.filter(
          (mutation) => mutation.kind === 'turn_started',
        );
        const started = starts[0];
        const childId = started?.type === 'subagent.started' ? started.subagent.id : undefined;
        const parentToolCallId =
          started?.type === 'subagent.started' && 'parentToolCallId' in started.subagent
            ? started.subagent.parentToolCallId
            : undefined;
        if (
          !runTools ||
          !this.session.isEffectLeaseCurrent(lease) ||
          starts.length !== 1 ||
          created.length !== 1 ||
          turns.length !== 1 ||
          dispatches.length !== 1 ||
          creates.length !== 1 ||
          mutationsTurn.length !== 1 ||
          input.mutations.length !== 2 ||
          !childId ||
          !parentToolCallId ||
          !runTools.toolCallIds.includes(parentToolCallId) ||
          created[0]?.agentId !== childId ||
          created[0]?.parentAgentId !== this.sessionId ||
          created[0]?.initialTaskId !== childId ||
          turns[0]?.agentId !== childId ||
          turns[0]?.taskId !== childId ||
          turns[0]?.turnOrdinal !== 1 ||
          dispatches[0]?.childInvocationId !== childId ||
          creates[0]?.agentId !== childId ||
          creates[0]?.parentAgentId !== this.sessionId ||
          creates[0]?.initialTaskId !== childId ||
          mutationsTurn[0]?.agentId !== childId ||
          mutationsTurn[0]?.taskId !== childId ||
          mutationsTurn[0]?.turnOrdinal !== 1
        )
          throw new Error('Agent child registration is outside its active Tool dispatch.');
        const storeEffectId = `agent-child-registration:${childId}`;
        const ownerId = `agent_mail_${crypto.randomUUID()}`;
        const leaseDeadline = () => Date.now() + 30_000;
        if (
          !this.#services.leases.tryAcquire(this.sessionId, storeEffectId, ownerId, leaseDeadline())
        )
          throw new Error('Agent mailbox Store effect lease is unavailable.');
        try {
          if (
            !this.session.isEffectLeaseCurrent(lease) ||
            !this.#services.leases.renew(this.sessionId, storeEffectId, ownerId, leaseDeadline())
          )
            throw new Error('Agent child registration lease became stale.');
          const before = this.session.getState();
          const committed = this.session.commitAgentMailboxFacts(input.events, input.mutations, {
            sessionId: this.sessionId,
            effectId: storeEffectId,
            ownerId,
          });
          this.#recordLastAppliedEventRevisions(before);
          lease.expectedRevision = this.session.getState().revision;
          return committed;
        } finally {
          this.#services.leases.release(this.sessionId, storeEffectId, ownerId);
        }
      },
      persistAgentMailModelAdmission: (
        lease: StateRuntimeSessionEffectLease,
        input: RuntimeAgentMailModelAdmissionInput,
      ) => {
        const state = this.session.getState();
        const run = this.session.getLifecycleProjection(state).currentRun;
        const root = this.#store.agentMailbox?.readAgent(
          this.sessionId,
          this.sessionId,
          this.sessionId,
        );
        if (
          lease.effect.type !== 'call_model' ||
          !this.session.isEffectLeaseCurrent(lease) ||
          state.turn.status !== 'active' ||
          !run ||
          (run.status !== 'running' && run.status !== 'waiting') ||
          run.activeTurnId !== state.turn.turnId ||
          root?.currentTaskId !== run.runId ||
          root.status !== 'active'
        )
          throw new Error('Agent mail model admission is outside its active root Run.');
        validateRootAgentMailModelAdmission({
          events: input.events,
          mutation: input.mutation,
          resourceBudget: state.resourceBudget,
          sessionId: this.sessionId,
        });
        const storeEffectId = `agent-mail-model:${input.mutation.modelInvocationId}`;
        const ownerId = `agent_mail_${crypto.randomUUID()}`;
        const leaseDeadline = () => Date.now() + 30_000;
        if (
          !this.#services.leases.tryAcquire(this.sessionId, storeEffectId, ownerId, leaseDeadline())
        )
          throw new Error('Agent mail model Store lease is unavailable.');
        try {
          if (
            !this.session.isEffectLeaseCurrent(lease) ||
            !this.#services.leases.renew(this.sessionId, storeEffectId, ownerId, leaseDeadline())
          )
            throw new Error('Agent mail model admission lease became stale.');
          const before = this.session.getState();
          const committed = this.session.commitAgentMailboxFacts(input.events, [input.mutation], {
            sessionId: this.sessionId,
            effectId: storeEffectId,
            ownerId,
          });
          this.#recordLastAppliedEventRevisions(before);
          lease.expectedRevision = this.session.getState().revision;
          return committed;
        } finally {
          this.#services.leases.release(this.sessionId, storeEffectId, ownerId);
        }
      },
    };
    return Object.freeze(port);
  }

  #recordLastAppliedEventRevisions(before: Readonly<RuntimeState>): void {
    const events = this.session.getLastAppliedEvents();
    const finalRevision = this.session.getState().revision;
    const firstRevision = finalRevision - events.length + 1;
    let projectedState = before;
    for (const [index, event] of events.entries()) {
      const revision = firstRevision + index;
      projectedState = {
        ...runtimeHostStateProjectAcceptedEvent(projectedState, event),
        revision,
      } as RuntimeState;
      if (revision <= this.#lastRecordedEventRevision) continue;
      this.#eventRevisions.set(event, revision);
      this.#eventStates.set(event, projectedState);
      this.#pendingEventRevisions.push({ event, revision });
      this.#lastRecordedEventRevision = revision;
    }
  }
}

class RuntimeSessionCoordinatorRegistry implements RuntimeSessionCoordinatorAccess {
  readonly #coordinators = new Map<string, RuntimeSessionCoordinatorImpl>();
  readonly #services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
  readonly #store: StateRuntimeStorage;
  readonly #modelRuntimeFactory: InstalledKiteRuntimeCompositionFactory;
  readonly #capabilities: CapabilityExecutionPort;
  readonly #snapshot: CapabilityRegistrySnapshot;
  readonly #builtinToolCatalog: BuiltinToolCatalogProjection;
  readonly #toolPipelineComposition: AppToolPipelineComposition | undefined;
  #closed = false;

  constructor(input: {
    readonly services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>;
    readonly store: StateRuntimeStorage;
    readonly capabilities: CapabilityExecutionPort;
    readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
    readonly builtinToolCatalog: BuiltinToolCatalogProjection;
    readonly toolPipelineComposition?: AppToolPipelineComposition;
    readonly modelRuntimeFactory: InstalledKiteRuntimeCompositionFactory;
  }) {
    if (
      !Object.isFrozen(input.capabilityRegistrySnapshot) ||
      !Object.isFrozen(input.capabilityRegistrySnapshot.modules) ||
      !Object.isFrozen(input.capabilityRegistrySnapshot.capabilities) ||
      !Object.isFrozen(input.capabilityRegistrySnapshot.contextSources) ||
      !Object.isFrozen(input.builtinToolCatalog) ||
      !Object.isFrozen(input.builtinToolCatalog.entries)
    ) {
      throw new Error('Runtime coordinator requires a frozen capability snapshot.');
    }
    const catalogEntries = new Map(
      input.builtinToolCatalog.entries.map((entry) => [entry.operationId, entry]),
    );
    if (catalogEntries.size !== input.builtinToolCatalog.entries.length) {
      throw new Error('Runtime Builtin catalog contains duplicate operation owners.');
    }
    for (const { definition, executor } of input.capabilityRegistrySnapshot.capabilities) {
      const entry = catalogEntries.get(definition.capabilityId);
      if (
        !entry ||
        entry.providerId !== definition.providerId ||
        entry.revision !== definition.revision ||
        (executor && entry.executorRevision !== executor.executorRevision)
      ) {
        throw new Error(
          `Runtime Builtin catalog does not match capability snapshot: ${definition.capabilityId}`,
        );
      }
    }
    this.#services = input.services;
    this.#store = input.store;
    this.#capabilities = input.capabilities;
    this.#snapshot = input.capabilityRegistrySnapshot;
    this.#builtinToolCatalog = input.builtinToolCatalog;
    this.#toolPipelineComposition = input.toolPipelineComposition;
    this.#modelRuntimeFactory = input.modelRuntimeFactory;
  }

  ensure(identity: RuntimeSessionCoordinatorIdentity): RuntimeSessionCoordinator {
    if (this.#closed) throw new Error('Runtime coordinator registry is closed.');
    const existing = this.#coordinators.get(identity.sessionId);
    if (existing) {
      existing.assertIdentity(identity);
      return existing;
    }

    const modelRuntime = this.#modelRuntimeFactory(identity.workspace);
    if (
      modelRuntime.status === 'available' &&
      (!modelRuntime.gateway || !modelRuntime.modelEffects)
    ) {
      throw new Error('Runtime Model composition is incomplete.');
    }
    const coordinator = new RuntimeSessionCoordinatorImpl(identity, {
      services: this.#services,
      capabilities: this.#capabilities,
      capabilityRegistrySnapshot: this.#snapshot,
      builtinToolCatalog: this.#builtinToolCatalog,
      toolPipelineComposition: this.#toolPipelineComposition,
      modelRuntime,
      store: this.#store,
    });
    this.#coordinators.set(identity.sessionId, coordinator);
    return coordinator;
  }

  get(sessionId: string): RuntimeSessionCoordinator | undefined {
    return this.#coordinators.get(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    const coordinator = this.#coordinators.get(sessionId);
    if (!coordinator) return;
    await coordinator.close();
    if (this.#coordinators.get(sessionId) === coordinator) {
      this.#coordinators.delete(sessionId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const coordinators = [...this.#coordinators.values()];
    await Promise.all(coordinators.map((coordinator) => coordinator.close()));
    this.#coordinators.clear();
  }
}

export function createRuntimeSessionCoordinatorBinding(): RuntimeSessionCoordinatorBinding {
  let access: RuntimeSessionCoordinatorAccess | undefined;
  let bound = false;
  return {
    bind(input) {
      if (bound) throw new Error('Runtime coordinator binding is already bound.');
      bound = true;
      access = new RuntimeSessionCoordinatorRegistry(input);
    },
    access() {
      if (!access) throw new Error('Runtime coordinator binding is unavailable.');
      return access;
    },
  };
}
