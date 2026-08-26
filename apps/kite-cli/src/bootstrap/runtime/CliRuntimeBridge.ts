import type { GitBroker } from '@kite-ai/builtin-runtime/git';
import { createChatModel, createModelSecretDetector } from '@kite-ai/builtin-runtime/model';
import type { ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type { InteractionMode, SkillScanOptions } from '@kite-ai/runtime-contract';
import {
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeClientInteraction,
  type RuntimeCommand,
  type RuntimeCommandErrorCode,
  type RuntimeCommandReceipt,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import type {
  RuntimeHostCommandInspection,
  RuntimeHostCommandInspectionContext,
  RuntimeHostExecutionBridge,
  RuntimeHostPreparedExecution,
} from '@kite-ai/runtime-host';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import type { ProjectIdentity } from '@kite-ai/runtime-spi';
import type { AgentConfig } from '#kite-cli/config';
import { getFeatureFlags } from '#kite-cli/config/features';
import { appSandboxBackendAvailable, type SandboxBackend } from '#kite-cli/sandbox/types';
import { projectRuntimeClientEvent } from '../../runtime-client/event-projector';
import {
  mapRuntimeInteractionResponseToUserAction,
  projectRuntimeClientInteraction,
  type RuntimeInteractionEffect,
} from '../../runtime-client/interaction-projector';
import { projectRuntimeEphemeralNotification } from '../presentation-notification';
import type { PrecommittedInteractionActionDescriptor } from './command-interaction-decision';
import type {
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorAccess,
} from './RuntimeSessionCoordinator';
import type { RuntimeUserAction } from './state-actions';
import type { RuntimeActionProvider, RuntimeInteractionCommandCommitPort } from './state-runner';
import type { RuntimeEffect, RuntimeEvent, RuntimeState } from './state-runtime';
import type {
  PrecommittedStartTurnDescriptor,
  StartTurnSkillPlanningContext,
} from './turn-command-decision';
import type { RuntimeTurnInput } from './turn-coordinator';

export interface CliRuntimeBridgeInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspace: string;
  readonly projectIdentity: ProjectIdentity;
  readonly checkpointPath: string;
  readonly config: AgentConfig;
  readonly shellExecutor: ShellExecutor;
  readonly gitBroker?: GitBroker;
  readonly interactionMode: InteractionMode;
  readonly sandboxBackend: SandboxBackend;
  readonly skillOptions: SkillScanOptions;
  readonly initialSkillActivations: readonly {
    readonly skillId: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[];
  readonly onSessionLoggingStatus?: (status: {
    readonly mode: 'off' | 'metadata' | 'content';
  }) => void;
  readonly onSessionLoggingDiagnostic?: (message: string) => void;
}

interface PendingCliInteraction {
  readonly effect: RuntimeInteractionEffect;
  readonly interaction: RuntimeClientInteraction;
  readonly stateRevision: number;
  readonly commandCommit: RuntimeInteractionCommandCommitPort;
  readonly completion: Promise<RuntimeUserAction | PrecommittedInteractionActionDescriptor>;
  readonly resolve: (action: RuntimeUserAction | PrecommittedInteractionActionDescriptor) => void;
  readonly reject: (error: unknown) => void;
}

export function createCliRuntimeBridge(
  input: CliRuntimeBridgeInput,
  capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>,
  modelInvocationRuntimeFactory: (workspace: string) => RuntimeTurnInput['modelInvocationRuntime'],
  resolveRecoveryIdentity: (sessionId: string) => string,
  runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess,
): RuntimeHostExecutionBridge {
  return new CliRuntimeBridge(
    input,
    capabilityExecution,
    modelInvocationRuntimeFactory,
    resolveRecoveryIdentity,
    runtimeSessionCoordinator,
  );
}

class CliRuntimeBridge implements RuntimeHostExecutionBridge {
  readonly #input: CliRuntimeBridgeInput;
  readonly #capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>;
  readonly #modelInvocationRuntimeFactory: (
    workspace: string,
  ) => RuntimeTurnInput['modelInvocationRuntime'];
  readonly #resolveRecoveryIdentity: (sessionId: string) => string;
  readonly #runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess;
  #revision = 0;
  #created = false;
  #running = false;
  #closed = false;
  #activePublish: ((notification: RuntimeNotification) => void) | undefined;
  #activeWork: RuntimeSessionProjection['activeWork'];
  #pendingInteraction: PendingCliInteraction | undefined;

  constructor(
    input: CliRuntimeBridgeInput,
    capabilityExecution: NonNullable<RuntimeTurnInput['capabilityExecution']>,
    modelInvocationRuntimeFactory: (
      workspace: string,
    ) => RuntimeTurnInput['modelInvocationRuntime'],
    resolveRecoveryIdentity: (sessionId: string) => string,
    runtimeSessionCoordinator: RuntimeSessionCoordinatorAccess,
  ) {
    this.#input = input;
    this.#capabilityExecution = capabilityExecution;
    this.#modelInvocationRuntimeFactory = modelInvocationRuntimeFactory;
    this.#resolveRecoveryIdentity = resolveRecoveryIdentity;
    this.#runtimeSessionCoordinator = runtimeSessionCoordinator;
  }

  async recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    if (sessionId !== this.#input.sessionId) return;
    const coordinator = this.#ensureCoordinator();
    this.#created = true;
    this.#closed = false;
    this.#revision = coordinator.getState().revision;
    if (!coordinator.recoveryChanged) return;
    publish({
      schema: RUNTIME_NOTIFICATION_SCHEMA_,
      durability: 'durable',
      sessionId,
      revision: this.#revision,
      projection: { kind: 'session', session: this.#projection() },
    });
  }

  async inspectCommand(
    command: RuntimeCommand,
    context: RuntimeHostCommandInspectionContext,
  ): Promise<RuntimeHostCommandInspection> {
    const terminal = (
      receipt: Exclude<RuntimeCommandReceipt, { readonly status: 'applied' }>,
    ): RuntimeHostCommandInspection => ({
      kind: 'terminal',
      receipt,
    });
    if (context.targetSessionId !== this.#input.sessionId) {
      return terminal(this.#rejected(command, 'invalid_session'));
    }
    if (command.type === 'create_session') {
      if (
        this.#created ||
        command.workspace !== this.#input.workspace ||
        (command.bootstrapSessionId !== undefined &&
          command.bootstrapSessionId !== this.#input.sessionId)
      ) {
        return terminal(this.#rejected(command, 'invalid_session'));
      }
      return this.#snapshotDecision((coordinator) => ({
        activate: () => {
          this.#created = true;
          this.#closed = false;
          this.#revision = coordinator.getState().revision;
        },
        releaseOnFailure: true,
      }));
    }
    if (!this.#created || this.#closed) {
      return terminal(this.#rejected(command, 'session_unavailable'));
    }
    if ('sessionId' in command && command.sessionId !== this.#input.sessionId) {
      return terminal(this.#notFound(command));
    }
    if (command.type === 'respond_interaction') {
      const pending = this.#pendingInteraction;
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (
        !pending ||
        !coordinator ||
        !sameInteractionIdentity(pending.interaction, command.interaction)
      ) {
        return terminal(this.#rejected(command, 'interaction_mismatch'));
      }
      const action = mapRuntimeInteractionResponseToUserAction({
        state: coordinator.getState(),
        effect: pending.effect,
        interaction: command.interaction,
        response: command.response,
        expectedStateRevision: pending.stateRevision,
      });
      if (!action) return terminal(this.#rejected(command, 'interaction_mismatch'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          commit: async (evidence) => {
            const committed = pending.commandCommit.commit(action, evidence);
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                if (this.#pendingInteraction !== pending) {
                  throw new Error(
                    'Runtime interaction activation no longer owns its pending waiter.',
                  );
                }
                this.#pendingInteraction = undefined;
                this.#revision = receipt.revision;
                this.#activeWork = clearActiveInteraction(this.#activeWork);
                this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'turn');
                pending.resolve(committed.descriptor);
              },
            };
          },
        },
      };
    }
    if (command.type === 'resume_session') {
      return this.#snapshotDecision((coordinator) => ({
        activate: () => {
          this.#revision = coordinator.getState().revision;
          this.#created = true;
          this.#closed = false;
        },
      }));
    }
    if (command.type === 'start_turn') {
      if (this.#running) return terminal(this.#rejected(command, 'runtime_busy'));
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: this.#input.sessionId,
          commit: async (evidence) => {
            const committed = coordinator.commitStartTurnCommand(
              command,
              evidence,
              this.#startSkillPlanningContext(command),
            );
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                this.#revision = receipt.revision;
                this.#running = true;
                this.#activePublish = publish;
                this.#activeWork = {
                  workId: command.commandId,
                  phase: committed.descriptor.phase,
                  status: 'running',
                  activeTurn: { turnId: committed.descriptor.turnId, status: 'running' },
                };
                this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'turn');
              },
              preparedExecution: this.#preparedStart(command, committed.descriptor, receipt),
            };
          },
        },
      };
    }
    if (command.type === 'cancel_turn') {
      if (!this.#running) return terminal(this.#rejected(command, 'turn_not_found'));
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      return this.#controlDecision(command, (evidence) =>
        coordinator.commitCancelTurnCommand(command, evidence),
      );
    }
    if (command.type === 'set_interaction_mode') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      return this.#controlDecision(command, (evidence) =>
        coordinator.commitInteractionModeCommand(command, evidence),
      );
    }
    if (command.type === 'close_session') {
      const coordinator = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
      if (!coordinator) return terminal(this.#rejected(command, 'session_unavailable'));
      return this.#closeDecision(command, (evidence) =>
        coordinator.commitCloseSessionCommand(command, evidence),
      );
    }
    return terminal(this.#rejected(command, 'unsupported'));
  }

  #snapshotDecision(
    afterCommit: (coordinator: RuntimeSessionCoordinator) => {
      readonly activate: () => void;
      readonly releaseOnFailure?: boolean;
    },
  ): RuntimeHostCommandInspection {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          const existing = this.#runtimeSessionCoordinator.get(this.#input.sessionId);
          const coordinator = existing ?? this.#ensureCoordinator();
          const committed = afterCommit(coordinator);
          try {
            const receipt = receiptFromStored(coordinator.session.commitCommandSnapshot(evidence));
            return { receipt, activation: async () => committed.activate() };
          } catch (error) {
            if (!existing && committed.releaseOnFailure) {
              await this.#runtimeSessionCoordinator.release(this.#input.sessionId);
            }
            throw error;
          }
        },
      },
    };
  }

  #controlDecision(
    command: Extract<RuntimeCommand, { type: 'cancel_turn' | 'set_interaction_mode' }>,
    commit: (evidence: RuntimeCommandCommitEvidence) => {
      readonly receipt: RuntimeStoredCommandReceipt;
      readonly events: readonly RuntimeEvent[];
    },
  ): RuntimeHostCommandInspection {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          const committed = commit(evidence);
          const receipt = receiptFromStored(committed.receipt);
          return {
            receipt,
            activation: async (publish) => {
              this.#revision = receipt.revision;
              if (command.type === 'cancel_turn') {
                this.#running = false;
                this.#rejectPendingInteraction(new Error('Runtime interaction cancelled.'));
              }
              this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'turn');
            },
          };
        },
      },
    };
  }

  #closeDecision(
    _command: Extract<RuntimeCommand, { type: 'close_session' }>,
    commit: (evidence: RuntimeCommandCommitEvidence) => {
      readonly receipt: RuntimeStoredCommandReceipt;
      readonly events: readonly RuntimeEvent[];
      readonly wasActive: boolean;
    },
  ): RuntimeHostCommandInspection {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: this.#input.sessionId,
        commit: async (evidence) => {
          const committed = commit(evidence);
          const receipt = receiptFromStored(committed.receipt);
          return {
            receipt,
            activation: async (publish) => {
              this.#revision = receipt.revision;
              this.#closed = true;
              this.#running = false;
              this.#rejectPendingInteraction(new Error('Runtime session closed.'));
              this.#activeWork = terminalizeActiveWork(this.#activeWork, 'cancelled');
              this.#publishCommittedEvents(committed.events, receipt.revision, publish, 'session');
            },
          };
        },
      },
    };
  }

  #preparedStart(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    descriptor: PrecommittedStartTurnDescriptor,
    receipt: Extract<RuntimeCommandReceipt, { status: 'applied' }>,
  ): RuntimeHostPreparedExecution {
    return {
      execution: {
        sessionId: this.#input.sessionId,
        operationId: command.commandId,
        committedRevision: receipt.revision,
        operation: 'turn',
        run: (signal, requestAbort) =>
          this.#runTurn(command, this.#ensureCoordinator(), descriptor, signal, requestAbort),
      },
    };
  }

  #publishCommittedEvents(
    events: readonly RuntimeEvent[],
    finalRevision: number,
    publish: (notification: RuntimeNotification) => void,
    kind: 'session' | 'turn',
  ): void {
    const firstRevision = finalRevision - events.length + 1;
    for (const [index, event] of events.entries()) {
      const revision = firstRevision + index;
      const projectedEvent = safelyProjectRuntimeEvent(event, revision);
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: this.#input.sessionId,
        revision,
        projection: {
          kind,
          session: { ...this.#projection(), revision },
          ...(projectedEvent === undefined ? {} : { event: projectedEvent }),
        },
      });
    }
  }

  async shutdownSession(
    sessionId: string,
    reason: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    if (sessionId !== this.#input.sessionId || !this.#created) return;
    this.#rejectPendingInteraction(new Error(reason));
    if (!this.#closed) this.#persistCancellation(reason, publish);
    this.#closed = true;
  }

  close(): Promise<void> {
    return this.#runtimeSessionCoordinator.close();
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    const projection = this.#projection();
    if (query.type === 'list_sessions') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        sessions: this.#created ? [projection] : [],
      });
    }
    if ('sessionId' in query && query.sessionId !== this.#input.sessionId) {
      return Promise.resolve({
        status: 'not_found',
        queryType: query.type,
        code: 'session_not_found',
      });
    }
    if (query.type === 'get_session_projection') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: this.#revision,
        session: projection,
      });
    }
    return Promise.resolve({
      status: 'rejected',
      queryType: query.type,
      code: 'unsupported',
    });
  }

  async #runTurn(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    coordinator: RuntimeSessionCoordinator,
    precommittedStart: PrecommittedStartTurnDescriptor,
    signal: AbortSignal,
    requestAbort: (reason: string) => void,
  ): Promise<void> {
    coordinator.updateSandboxAvailable(appSandboxBackendAvailable(this.#input.sandboxBackend));
    const publish = this.#activePublish;
    if (!publish) throw new Error('Runtime CLI command activation is unavailable.');
    let status: NonNullable<RuntimeSessionProjection['activeWork']>['status'] = 'completed';
    let publishedRevision = this.#revision;
    try {
      const generator = coordinator.executeTurn(
        {
          task: command.input,
          userGoal: command.input,
          userId: this.#input.userId,
          threadId: this.#input.sessionId,
          workspace: this.#input.workspace,
          recoveryIdentityKey: this.#resolveRecoveryIdentity(this.#input.sessionId),
          capabilityExecution: this.#capabilityExecution,
          modelInvocationRuntime: this.#modelInvocationRuntimeFactory(this.#input.workspace),
          config: this.#input.config,
          model: createChatModel(this.#input.config),
          shellExecutor: this.#input.shellExecutor,
          gitBroker: this.#input.gitBroker,
          interactionMode: this.#input.interactionMode,
          sandboxBackend: this.#input.sandboxBackend,
          frontend: 'cli',
          signal,
          abortExecution: requestAbort,
          sessionLoggingPolicy: this.#input.config.sessionLoggingPolicy,
          sessionLoggingContentInspector: createModelSecretDetector({
            knownSecrets: [this.#input.config.apiKey],
          }),
          onSessionLoggingStatus: this.#input.onSessionLoggingStatus,
          onSessionLoggingDiagnostic: this.#input.onSessionLoggingDiagnostic,
          skillOptions: this.#input.skillOptions,
          initialSkillActivations: [],
          precommittedStart,
        },
        this.#createClientActionProvider(publish),
      );
      let sequence = 0;
      for await (const event of generator) {
        const ephemeral = projectRuntimeEphemeralNotification(event, {
          sessionId: this.#input.sessionId,
          workId: command.commandId,
          turnId: command.commandId,
          actorId: 'runtime-agent',
          attemptId: command.commandId,
          streamId: command.commandId,
          sequence: sequence + 1,
        });
        if (ephemeral) {
          sequence += 1;
          publish(ephemeral);
          continue;
        }
        this.#revision = coordinator.getState().revision;
        publishedRevision = this.#revision;
        const projectedEvent = projectRuntimeClientEvent(event, {
          sessionRevision: this.#revision,
        });
        const interaction = interactionFromClientEvent(projectedEvent);
        if (interaction) {
          this.#activeWork = setActiveInteraction(this.#activeWork, interaction);
        }
        if (
          projectedEvent?.type === 'interaction.settled' ||
          projectedEvent?.type === 'plan.approved'
        ) {
          this.#activeWork = clearActiveInteraction(this.#activeWork);
        }
        const terminalStatus = terminalStatusFromClientEvent(projectedEvent);
        if (terminalStatus) {
          status = terminalStatus;
          this.#activeWork = terminalizeActiveWork(this.#activeWork, status);
        }
        publish({
          schema: RUNTIME_NOTIFICATION_SCHEMA_,
          durability: 'durable',
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          projection: {
            kind: 'turn',
            session: this.#projection(),
            event: projectedEvent,
          },
        });
      }
    } catch {
      status = signal.aborted ? 'cancelled' : 'failed';
    } finally {
      this.#running = false;
      this.#activePublish = undefined;
      this.#revision = coordinator.getState().revision;
      this.#activeWork = terminalizeActiveWork(this.#activeWork, status);
      if (this.#revision > publishedRevision) {
        publish({
          schema: RUNTIME_NOTIFICATION_SCHEMA_,
          durability: 'durable',
          sessionId: this.#input.sessionId,
          revision: this.#revision,
          projection: { kind: 'work', session: this.#projection() },
        });
      }
    }
  }

  #startSkillPlanningContext(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
  ): StartTurnSkillPlanningContext | undefined {
    if (!command.initialSkills || command.initialSkills.length === 0) return undefined;
    const flags = getFeatureFlags(this.#input.config);
    // CLI deliberately has no MCP manager. MCP-backed catalog entries are
    // therefore rejected by the shared planner instead of acquiring I/O in
    // Host's pure inspection/commit phase.
    return {
      skillOptions: this.#input.skillOptions,
      flags: {
        skillActivation: flags.skillActivation,
        skillWorkflow: flags.skillWorkflow,
      },
    };
  }

  #ensureCoordinator(): RuntimeSessionCoordinator {
    const modelRuntime = this.#modelInvocationRuntimeFactory(this.#input.workspace);
    return this.#runtimeSessionCoordinator.ensure({
      sessionId: this.#input.sessionId,
      userId: this.#input.userId,
      workspace: this.#input.workspace,
      projectId: this.#input.projectIdentity.projectId,
      canonicalWorkspaceDigest: this.#input.projectIdentity.workspaceDigest,
      interactionMode: this.#input.interactionMode,
      recoveryIdentityKey: this.#resolveRecoveryIdentity(this.#input.sessionId),
      sandboxAvailable: appSandboxBackendAvailable(this.#input.sandboxBackend),
      modelArtifactEvidence: modelRuntime.evidence,
      capabilityArtifactEvidence:
        'capabilityArtifacts' in modelRuntime ? modelRuntime.capabilityArtifacts : undefined,
    });
  }

  #createClientActionProvider(
    publish: (notification: RuntimeNotification) => void,
  ): RuntimeActionProvider {
    return Object.freeze({
      requestAction: (
        effect: RuntimeEffect,
        state: RuntimeState,
        commandCommit: RuntimeInteractionCommandCommitPort,
      ): Promise<RuntimeUserAction | PrecommittedInteractionActionDescriptor> => {
        if (!isRuntimeInteractionEffect(effect) || this.#pendingInteraction) {
          return Promise.reject(new Error('Runtime interaction request is unavailable.'));
        }
        const interaction = projectRuntimeClientInteraction(state, effect, {
          sessionRevision: state.revision,
        });
        if (!interaction) {
          return Promise.reject(new Error('Runtime interaction identity is invalid.'));
        }
        let resolve!: (action: RuntimeUserAction | PrecommittedInteractionActionDescriptor) => void;
        let reject!: (error: unknown) => void;
        const completion = new Promise<RuntimeUserAction | PrecommittedInteractionActionDescriptor>(
          (resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
          },
        );
        const priorRevision = this.#revision;
        this.#revision = state.revision;
        this.#activeWork = setActiveInteraction(this.#activeWork, interaction);
        this.#pendingInteraction = {
          effect,
          interaction,
          stateRevision: state.revision,
          commandCommit,
          completion,
          resolve,
          reject,
        };
        if (state.revision > priorRevision) {
          publish({
            schema: RUNTIME_NOTIFICATION_SCHEMA_,
            durability: 'durable',
            sessionId: this.#input.sessionId,
            revision: state.revision,
            projection: {
              kind: 'interaction',
              session: this.#projection(),
              event: { type: 'interaction.available', interaction },
            },
          });
        }
        return completion;
      },
    });
  }

  #rejectPendingInteraction(error: unknown): void {
    const pending = this.#pendingInteraction;
    if (!pending) return;
    this.#pendingInteraction = undefined;
    pending.reject(error);
  }

  #persistCancellation(
    reason: string,
    publish: (notification: RuntimeNotification) => void = this.#activePublish ?? (() => undefined),
  ): void {
    const events =
      this.#runtimeSessionCoordinator.get(this.#input.sessionId)?.control.cancelRun(reason) ?? [];
    for (const event of events) {
      this.#revision =
        this.#runtimeSessionCoordinator.get(this.#input.sessionId)?.getState().revision ??
        this.#revision;
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: this.#input.sessionId,
        revision: this.#revision,
        projection: {
          kind: 'turn',
          session: this.#projection(),
          event: projectRuntimeClientEvent(event, { sessionRevision: this.#revision }),
        },
      });
    }
  }

  #projection(): RuntimeSessionProjection {
    return {
      schema: RUNTIME_PROJECTION_SCHEMA_,
      sessionId: this.#input.sessionId,
      revision: this.#revision,
      workspace: this.#input.workspace,
      lifecycle: this.#closed ? 'closed' : 'open',
      activeWork: this.#activeWork,
    };
  }

  #rejected(
    command: RuntimeCommand,
    code: RuntimeCommandErrorCode,
  ): {
    readonly status: 'rejected';
    readonly commandId: string;
    readonly code: RuntimeCommandErrorCode;
    readonly currentRevision: number;
  } {
    return {
      status: 'rejected',
      commandId: command.commandId,
      code,
      currentRevision: this.#revision,
    };
  }

  #notFound(command: RuntimeCommand): {
    readonly status: 'not_found';
    readonly commandId: string;
    readonly code: 'session_not_found';
  } {
    return {
      status: 'not_found',
      commandId: command.commandId,
      code: 'session_not_found',
    };
  }
}

function isRuntimeInteractionEffect(effect: RuntimeEffect): effect is RuntimeInteractionEffect {
  switch (effect.type) {
    case 'request_tool_approval':
    case 'request_user_input':
    case 'request_plan_review':
    case 'request_provider_action':
    case 'request_provider_admission':
    case 'request_verification_decision':
      return true;
    default:
      return false;
  }
}

function setActiveInteraction(
  work: RuntimeSessionProjection['activeWork'],
  interaction: RuntimeClientInteraction,
): RuntimeSessionProjection['activeWork'] {
  if (!work) return work;
  return {
    ...work,
    status: 'waiting',
    activeTurn: work.activeTurn
      ? { ...work.activeTurn, status: 'waiting', interaction }
      : undefined,
  };
}

function interactionFromClientEvent(
  event: ReturnType<typeof projectRuntimeClientEvent>,
): RuntimeClientInteraction | undefined {
  switch (event?.type) {
    case 'interaction.available':
    case 'approval.queued':
    case 'input.requested':
    case 'plan.review_requested':
      return event.interaction;
    case 'provider.action':
      return event.status === 'required' ? event.interaction : undefined;
    case 'verification.status':
      return event.status === 'pending' ? event.interaction : undefined;
    default:
      return undefined;
  }
}

function terminalStatusFromClientEvent(
  event: ReturnType<typeof projectRuntimeClientEvent>,
): 'cancelled' | 'failed' | 'completed' | undefined {
  switch (event?.type) {
    case 'task.terminal':
    case 'turn.terminal':
    case 'run.terminal':
      return event.status === 'aborted' ? 'cancelled' : event.status;
    default:
      return undefined;
  }
}

function clearActiveInteraction(
  work: RuntimeSessionProjection['activeWork'],
): RuntimeSessionProjection['activeWork'] {
  if (!work) return work;
  return {
    ...work,
    status: 'running',
    activeTurn: work.activeTurn
      ? { ...work.activeTurn, status: 'running', interaction: undefined }
      : undefined,
  };
}

function terminalizeActiveWork(
  work: RuntimeSessionProjection['activeWork'],
  status: 'cancelled' | 'failed' | 'completed',
): RuntimeSessionProjection['activeWork'] {
  if (!work) return work;
  return {
    ...work,
    status,
    activeTurn: work.activeTurn
      ? { ...work.activeTurn, status, interaction: undefined }
      : undefined,
  };
}

function sameInteractionIdentity(
  expected: RuntimeClientInteraction,
  actual: RuntimeClientInteraction,
): boolean {
  if (
    expected.kind !== actual.kind ||
    expected.interactionId !== actual.interactionId ||
    expected.sessionRevision !== actual.sessionRevision
  ) {
    return false;
  }
  switch (expected.kind) {
    case 'approval':
      return (
        actual.kind === 'approval' &&
        expected.generation === actual.generation &&
        expected.grants.length === actual.grants.length &&
        expected.grants.every((grant, index) => grant === actual.grants[index])
      );
    case 'input':
      return actual.kind === 'input';
    case 'plan_review':
      return (
        actual.kind === 'plan_review' &&
        expected.plan.planId === actual.plan.planId &&
        expected.plan.version === actual.plan.version &&
        expected.plan.structuralDigest === actual.plan.structuralDigest
      );
    case 'provider_action':
      return (
        actual.kind === 'provider_action' &&
        expected.action === actual.action &&
        expected.provider.providerId === actual.provider.providerId &&
        expected.provider.directoryRevision === actual.provider.directoryRevision
      );
    case 'verification':
      return (
        actual.kind === 'verification' &&
        expected.verification.verificationId === actual.verification.verificationId &&
        expected.verification.revision === actual.verification.revision
      );
  }
}

function receiptFromStored(
  receipt: RuntimeStoredCommandReceipt,
): Extract<RuntimeCommandReceipt, { readonly status: 'applied' }> {
  return {
    status: 'applied',
    commandId: receipt.commandId,
    sessionId: receipt.targetSessionId,
    revision: receipt.committedRevision,
  };
}

function safelyProjectRuntimeEvent(event: RuntimeEvent, revision: number) {
  try {
    return projectRuntimeClientEvent(event, { sessionRevision: revision });
  } catch {
    return undefined;
  }
}
