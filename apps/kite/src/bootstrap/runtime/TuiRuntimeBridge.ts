import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeCheckpointProjection,
  type RuntimeClientEvent,
  type RuntimeClientInteraction,
  type RuntimeCommand,
  type RuntimeCommandErrorCode,
  type RuntimeCommandReceipt,
  type RuntimeInteractionResponse,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeRewindPreviewProjection,
  type RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import type {
  RuntimeHostCommandInspection,
  RuntimeHostCommandInspectionContext,
  RuntimeHostCoordinatorPort,
  RuntimeHostExecutionBridge,
  RuntimeHostPreparedExecution,
} from '@kite-ai/runtime-host';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import type { ProjectIdentity } from '@kite-ai/runtime-spi';
import { getFeatureFlags } from '#app/config/features';
import type { TuiSessionManager } from '../../adapters/tui/session-adapter';
import { type SessionDeps, SessionManager, type SessionRuntime } from '../../runtime/session';
import {
  createRuntimeCommandIdAllocator,
  type RuntimeCommandIdAllocator,
} from '../../runtime-client/command-id';
import { projectRuntimeClientEvent } from '../../runtime-client/event-projector';
import {
  mapRuntimeInteractionResponseToUserAction,
  projectCurrentRuntimeClientInteraction,
  resolveRuntimeInteractionEffect,
} from '../../runtime-client/interaction-projector';
import { projectRuntimeClientText } from '../../runtime-client/safe-text';
import { createTuiHistoryFacade } from '../../runtime-client/tui-history-facade';
import { commitRewindCommand } from './command-rewind-decision';
import type { RuntimeSessionCoordinator } from './RuntimeSessionCoordinator';
import type { PrecommittedStartTurnDescriptor } from './turn-command-decision';

interface SessionAuthority {
  revision: number;
  workspace: string;
  lifecycle: 'open' | 'closed';
  activeWork?: RuntimeSessionProjection['activeWork'];
}

interface PendingRun {
  readonly dependencies: Parameters<SessionRuntime['runTask']>[1];
  readonly requestedPhase?: Parameters<SessionRuntime['runTask']>[2];
  readonly initialSkills?: Parameters<SessionRuntime['runTask']>[3];
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

type ContextCompactionResult = Awaited<ReturnType<SessionManager['handleContextCompaction']>>;
type ContextCompactionProgress = Parameters<SessionManager['handleContextCompaction']>[2];
type ContextCompactionCommand = Parameters<SessionManager['handleContextCompaction']>[3];
type RewindResult = Awaited<ReturnType<SessionManager['executeRewind']>>;
type TuiRuntimeDispatch = Parameters<SessionRuntime['runTask']>[1]['dispatch'];

interface PendingCompaction {
  readonly instructions?: string;
  readonly onProgress?: ContextCompactionProgress;
  readonly onCommand?: ContextCompactionCommand;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  result?: ContextCompactionResult;
}

interface PendingRewind {
  readonly workspace: string;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  result?: RewindResult;
}

const TUI_CANCEL_REVISION_RETRY_LIMIT = 8;

export function createTuiRuntimeClient(
  input: SessionDeps & { readonly workspace: string },
  createHost: (bridge: RuntimeHostExecutionBridge) => RuntimeHostCoordinatorPort,
  resolveProjectIdentity: (workspace: string) => ProjectIdentity,
  commandIds: RuntimeCommandIdAllocator = createRuntimeCommandIdAllocator(),
): TuiSessionManager {
  return new TuiRuntimeBridge(input, createHost, resolveProjectIdentity, commandIds).client;
}

class TuiRuntimeBridge implements RuntimeHostExecutionBridge {
  readonly #manager: SessionManager;
  readonly #access: RuntimeHostCoordinatorPort;
  readonly #history: ReturnType<typeof createTuiHistoryFacade>;
  readonly #sessions = new Map<string, SessionAuthority>();
  readonly #sessionReadiness = new Map<string, Promise<void>>();
  readonly #runtimeClients = new Map<string, object>();
  readonly #managerMembers = new Map<PropertyKey, unknown>();
  readonly #pendingRuns = new Map<string, PendingRun>();
  readonly #pendingCompactions = new Map<string, PendingCompaction>();
  readonly #pendingRewinds = new Map<string, PendingRewind>();
  readonly #streamSequences = new Map<string, number>();
  readonly #activePublishes = new Map<string, (notification: RuntimeNotification) => void>();
  readonly #subscriptionControllers = new Map<string, AbortController>();
  readonly #subscriptionReadiness = new Map<string, Promise<void>>();
  readonly #interactionHints = new Map<
    string,
    Pick<RuntimeClientInteraction, 'kind' | 'interactionId'>
  >();
  readonly #resolveProjectIdentity: (workspace: string) => ProjectIdentity;
  readonly #runtimeSessionCoordinator: SessionDeps['runtimeSessionCoordinator'];
  readonly #allocateRecoveryIdentity: SessionDeps['allocateRecoveryIdentity'];
  readonly #admittedWorkspace: string;
  readonly #commandIds: RuntimeCommandIdAllocator;
  readonly client: TuiSessionManager;

  constructor(
    input: SessionDeps & { readonly workspace: string },
    createHost: (bridge: RuntimeHostExecutionBridge) => RuntimeHostCoordinatorPort,
    resolveProjectIdentity: (workspace: string) => ProjectIdentity,
    commandIds: RuntimeCommandIdAllocator,
  ) {
    this.#manager = new SessionManager(input);
    this.#access = createHost(this);
    const history = (
      this.#access as RuntimeHostCoordinatorPort & { history?: RuntimeHistoryClient }
    ).history;
    if (!history) throw new Error('TUI Runtime Client history is unavailable.');
    this.#history = createTuiHistoryFacade(history);
    this.#resolveProjectIdentity = resolveProjectIdentity;
    this.#runtimeSessionCoordinator = input.runtimeSessionCoordinator;
    this.#allocateRecoveryIdentity = input.allocateRecoveryIdentity;
    this.#admittedWorkspace = input.workspace;
    this.#commandIds = commandIds;
    input.provider.setActionSink?.((action) => this.#submitClientInteraction(action));
    this.client = this.#createManagerClient();
  }

  async recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    const runtime = this.#manager.getRuntime(sessionId);
    if (!runtime) return;
    const recoveryChanged = await this.#manager.recoverRuntimeState(sessionId);
    const coordinator = this.#coordinator(sessionId);
    if (!coordinator) return;
    const authority = this.#ensureAuthority(sessionId, runtime, coordinator);
    authority.revision = coordinator.getState().revision;
    if (recoveryChanged) publish(this.#notification(sessionId, 'session'));
  }

  async inspectCommand(
    command: RuntimeCommand,
    context: RuntimeHostCommandInspectionContext,
  ): Promise<RuntimeHostCommandInspection> {
    const terminal = (
      receipt: Exclude<RuntimeCommandReceipt, { readonly status: 'applied' }>,
    ): RuntimeHostCommandInspection => ({ kind: 'terminal', receipt });
    if (command.type === 'create_session') {
      const sessionId = command.bootstrapSessionId;
      const runtime = sessionId ? this.#manager.getRuntime(sessionId) : undefined;
      if (
        !sessionId ||
        context.targetSessionId !== sessionId ||
        !runtime ||
        runtime.workspace !== command.workspace
      ) {
        return terminal(this.#reject(command, 'invalid_session'));
      }
      return this.#snapshotDecision(sessionId, {
        activate: (coordinator) => {
          const authority = this.#ensureAuthority(sessionId, runtime, coordinator);
          authority.lifecycle = 'open';
          authority.revision = coordinator.getState().revision;
        },
        releaseOnFailure: true,
      });
    }
    if (command.type === 'resume_session') {
      const runtime = this.#manager.getRuntime(command.sessionId);
      if (!runtime || context.targetSessionId !== command.sessionId)
        return terminal(this.#notFound(command));
      return this.#snapshotDecision(command.sessionId, {
        activate: (coordinator) => {
          const authority = this.#ensureAuthority(command.sessionId, runtime, coordinator);
          authority.lifecycle = 'open';
          authority.revision = coordinator.getState().revision;
        },
      });
    }
    if (command.type === 'fork_session') {
      const sourceRuntime = this.#manager.getRuntime(command.sourceSessionId);
      const coordinator = this.#coordinator(command.sourceSessionId);
      if (!sourceRuntime || !coordinator || context.targetSessionId === command.sourceSessionId) {
        return terminal(this.#notFound(command));
      }
      const store = coordinator.getStateRuntimeStorage();
      const checkpointAvailable = command.checkpointId
        ? store.checkpoints.getNamedSnapshotEntry(command.sourceSessionId, command.checkpointId) !==
          null
        : store.sessions.loadSnapshot(command.sourceSessionId) !== null;
      if (!checkpointAvailable) return terminal(this.#reject(command, 'checkpoint_unavailable'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: context.targetSessionId,
          commit: async (evidence) => {
            const committed = coordinator.commitForkSessionCommand(
              command,
              context.targetSessionId,
              this.#allocateRecoveryIdentity(),
              evidence,
            );
            if (committed.status === 'unavailable') {
              throw new Error('Runtime fork checkpoint is unavailable.');
            }
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async () => {
                const targetRuntime = this.#manager.registerSession(
                  committed.targetSessionId,
                  sourceRuntime.workspace,
                );
                const targetCoordinator = this.#coordinator(committed.targetSessionId);
                if (!targetCoordinator) {
                  throw new Error('Runtime fork target coordinator is unavailable.');
                }
                const authority = this.#ensureAuthority(
                  committed.targetSessionId,
                  targetRuntime,
                  targetCoordinator,
                );
                authority.revision = targetCoordinator.getState().revision;
              },
            };
          },
        },
      };
    }
    const sessionId = command.sessionId;
    const authority = this.#sessions.get(sessionId);
    const runtime = this.#manager.getRuntime(sessionId);
    if (context.targetSessionId !== sessionId || !authority || !runtime) {
      return terminal(this.#notFound(command));
    }
    if (command.type === 'respond_interaction') {
      const coordinator = this.#coordinator(sessionId);
      const state = coordinator?.getState();
      const port = runtime.getPendingInteractionCommandPort(command.interaction.interactionId);
      const expected = state
        ? projectCurrentRuntimeClientInteraction(
            state,
            { kind: command.interaction.kind, interactionId: command.interaction.interactionId },
            { sessionRevision: command.interaction.sessionRevision },
          )
        : null;
      const effect = expected && state ? resolveRuntimeInteractionEffect(state, expected) : null;
      const action =
        expected && effect && state && sameInteractionIdentity(expected, command.interaction)
          ? mapRuntimeInteractionResponseToUserAction({
              state,
              effect,
              interaction: command.interaction,
              response: command.response,
              expectedStateRevision: state.revision,
            })
          : null;
      if (!port || !expected || !action)
        return terminal(this.#reject(command, 'interaction_mismatch'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: sessionId,
          commit: async (evidence) => {
            const committed = port.commit(action, evidence);
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                authority.revision = receipt.revision;
                authority.activeWork = clearActiveInteraction(authority.activeWork);
                this.#interactionHints.delete(command.interaction.interactionId);
                this.#publishCommittedEvents(
                  sessionId,
                  committed.events,
                  receipt.revision,
                  publish,
                  'turn',
                );
                if (!runtime.resolveCommittedInteraction(committed.descriptor)) {
                  throw new Error(
                    'Runtime interaction activation no longer owns its pending waiter.',
                  );
                }
              },
            };
          },
        },
      };
    }
    if (command.type === 'close_session') {
      const coordinator = this.#coordinator(sessionId);
      if (!coordinator) return terminal(this.#reject(command, 'session_unavailable'));
      return this.#controlDecision(
        command,
        (evidence) => coordinator.commitCloseSessionCommand(command, evidence),
        (receipt, events, publish) => {
          authority.lifecycle = 'closed';
          authority.revision = receipt.revision;
          this.#publishCommittedEvents(sessionId, events, receipt.revision, publish, 'session');
        },
      );
    }
    if (command.type === 'start_turn') {
      const pending = this.#pendingRuns.get(command.commandId);
      const coordinator = this.#coordinator(sessionId);
      if (!pending) return terminal(this.#reject(command, 'invalid_command'));
      if (!coordinator) return terminal(this.#reject(command, 'session_unavailable'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: sessionId,
          commit: async (evidence) => {
            const committed = coordinator.commitStartTurnCommand(
              command,
              evidence,
              this.#startSkillPlanningContext(command, runtime, pending),
            );
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                authority.revision = receipt.revision;
                this.#activePublishes.set(sessionId, publish);
                authority.activeWork = {
                  workId: command.commandId,
                  phase: committed.descriptor.phase,
                  status: 'running',
                  activeTurn: { turnId: committed.descriptor.turnId, status: 'running' },
                };
                this.#publishCommittedEvents(
                  sessionId,
                  committed.events,
                  receipt.revision,
                  publish,
                  'turn',
                );
              },
              preparedExecution: this.#preparedStart(
                command,
                runtime,
                pending,
                committed.descriptor,
                receipt,
              ),
            };
          },
        },
      };
    }
    if (command.type === 'cancel_turn') {
      const coordinator = this.#coordinator(sessionId);
      if (!coordinator) return terminal(this.#reject(command, 'session_unavailable'));
      const state = coordinator.getState();
      if (state.turn.status !== 'active' || state.turn.turnId !== command.turnId) {
        return terminal(this.#reject(command, 'turn_not_found'));
      }
      return this.#controlDecision(command, (evidence) =>
        coordinator.commitCancelTurnCommand(command, evidence),
      );
    }
    if (command.type === 'set_interaction_mode') {
      const coordinator = this.#coordinator(sessionId);
      if (!coordinator) return terminal(this.#reject(command, 'session_unavailable'));
      return this.#controlDecision(command, (evidence) =>
        coordinator.commitInteractionModeCommand(command, evidence),
      );
    }
    if (command.type === 'clear_session_command_grants') {
      const coordinator = this.#coordinator(sessionId);
      if (!coordinator) {
        return terminal(this.#reject(command, 'session_unavailable'));
      }
      return this.#controlDecision(
        command,
        (evidence) => coordinator.commitClearSessionCommandGrantsCommand(command, evidence),
        (receipt, events, publish) => {
          authority.revision = receipt.revision;
          this.#publishCommittedEvents(sessionId, events, receipt.revision, publish, 'session');
        },
      );
    }
    if (command.type === 'rewind_session') {
      const pending = this.#pendingRewinds.get(command.commandId);
      const coordinator = this.#coordinator(sessionId);
      if (!pending || !coordinator) return terminal(this.#reject(command, 'session_unavailable'));
      if (!this.#manager.isRewindCheckpointAvailable(sessionId, command.checkpointId)) {
        return terminal(this.#reject(command, 'checkpoint_unavailable'));
      }
      return {
        kind: 'accepted',
        decision: {
          // Rewind receipts are source-scoped; the deterministic conversation
          // target is durable outcome evidence, never the receipt target.
          targetSessionId: sessionId,
          commit: async (evidence) => {
            const committed = commitRewindCommand(coordinator.session, command, evidence);
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                authority.revision = receipt.revision;
                this.#publishCommittedEvents(
                  sessionId,
                  committed.events,
                  receipt.revision,
                  publish,
                  'turn',
                );
                const settled = await this.#manager.executeCommittedRewindIntent({
                  intent: committed.events[0],
                  workspace: pending.workspace,
                  persistTerminal: (terminalEvent) => {
                    const applied = coordinator.control.processEventBatch([terminalEvent]);
                    if (applied.length !== 1) {
                      throw new Error('Runtime rewind terminal event was not persisted.');
                    }
                    this.#publishStateEvents(sessionId, applied, publish);
                  },
                });
                if (settled.status === 'completed') {
                  pending.result = settled.result;
                  if (command.scope !== 'code_only') {
                    const targetRuntime = this.#manager.registerSession(
                      settled.result.targetThreadId,
                      pending.workspace,
                    );
                    const targetCoordinator = this.#coordinator(settled.result.targetThreadId);
                    if (!targetCoordinator) {
                      throw new Error('Runtime rewind target coordinator is unavailable.');
                    }
                    const targetAuthority = this.#ensureAuthority(
                      settled.result.targetThreadId,
                      targetRuntime,
                      targetCoordinator,
                    );
                    targetAuthority.revision = targetCoordinator.getState().revision;
                  }
                }
                pending.resolve();
              },
            };
          },
        },
      };
    }
    if (command.type === 'compact_session') {
      const pending = this.#pendingCompactions.get(command.commandId);
      const coordinator = this.#coordinator(sessionId);
      if (!pending || !coordinator) return terminal(this.#reject(command, 'session_unavailable'));
      const plan = this.#manager.inspectHostCompactionCommand({
        threadId: sessionId,
        commandId: command.commandId,
        mode: command.mode,
        ...(command.instructions === undefined ? {} : { customInstructions: command.instructions }),
      });
      if (plan.events.length === 0)
        return terminal(this.#reject(command, 'checkpoint_unavailable'));
      return {
        kind: 'accepted',
        decision: {
          targetSessionId: sessionId,
          commit: async (evidence) => {
            const committed = coordinator.session.commitCommandBatch(plan.events, evidence);
            const receipt = receiptFromStored(committed.receipt);
            return {
              receipt,
              activation: async (publish) => {
                authority.revision = receipt.revision;
                this.#publishCommittedEvents(
                  sessionId,
                  committed.events as readonly import('./state-runtime').RuntimeEvent[],
                  receipt.revision,
                  publish,
                  'turn',
                );
                if (!plan.shouldSchedule) {
                  pending.result = this.#compactionResult(plan, []);
                  pending.resolve();
                } else {
                  this.#activePublishes.set(sessionId, publish);
                }
              },
              ...(plan.shouldSchedule
                ? {
                    preparedExecution: this.#preparedCompaction(command, plan, pending, receipt),
                  }
                : {}),
            };
          },
        },
      };
    }
    return terminal(this.#reject(command, 'unsupported'));
  }

  async shutdownSession(
    sessionId: string,
    reason: string,
    _publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    const coordinator = this.#coordinator(sessionId);
    if (!coordinator) return;
    coordinator.control.cancelRun(reason);
  }

  async close(): Promise<void> {
    await this.#manager.closeRuntimeSessionCoordinators();
    await this.#manager.dispose();
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    if (query.type === 'list_sessions') {
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        sessions: [...this.#sessions.keys()].map((sessionId) => this.#projection(sessionId)),
      });
    }
    if ('sessionId' in query && !this.#sessions.has(query.sessionId)) {
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
        revision: this.#sessions.get(query.sessionId)?.revision,
        session: this.#projection(query.sessionId),
      });
    }
    if (query.type === 'list_checkpoints') {
      const checkpoints = this.#manager
        .listRewindCheckpoints(query.sessionId)
        .slice(0, 10_000)
        .map((checkpoint) =>
          checkpointProjection(query.sessionId, this.#revision(query.sessionId), checkpoint),
        );
      return Promise.resolve({
        status: 'ok',
        queryType: query.type,
        revision: this.#revision(query.sessionId),
        checkpoints,
      });
    }
    if (query.type === 'get_rewind_preview') {
      const authority = this.#sessions.get(query.sessionId);
      const preview = authority
        ? this.#manager.previewRewind(query.sessionId, query.checkpointId, authority.workspace)
        : null;
      return Promise.resolve(
        preview === null
          ? {
              status: 'not_found' as const,
              queryType: query.type,
              code: 'checkpoint_unavailable' as const,
            }
          : {
              status: 'ok' as const,
              queryType: query.type,
              revision: this.#revision(query.sessionId),
              rewindPreview: rewindPreviewProjection(
                query.sessionId,
                query.checkpointId,
                this.#revision(query.sessionId),
                preview,
              ),
            },
      );
    }
    return Promise.resolve({
      status: 'rejected',
      queryType: query.type,
      code: 'unsupported',
    });
  }

  #snapshotDecision(
    sessionId: string,
    afterCommit: {
      readonly activate: (coordinator: RuntimeSessionCoordinator) => void;
      readonly releaseOnFailure?: boolean;
    },
  ): RuntimeHostCommandInspection {
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: sessionId,
        commit: async (evidence) => {
          const coordinator = this.#coordinator(sessionId);
          if (!coordinator) throw new Error('Runtime TUI session coordinator is unavailable.');
          try {
            const receipt = receiptFromStored(coordinator.session.commitCommandSnapshot(evidence));
            return {
              receipt,
              activation: async () => afterCommit.activate(coordinator),
            };
          } catch (error) {
            if (afterCommit.releaseOnFailure) {
              await this.#manager.releaseRuntimeSessionCoordinator(sessionId);
            }
            throw error;
          }
        },
      },
    };
  }

  #controlDecision(
    command: Extract<
      RuntimeCommand,
      {
        type:
          | 'cancel_turn'
          | 'set_interaction_mode'
          | 'close_session'
          | 'clear_session_command_grants';
      }
    >,
    commit: (evidence: RuntimeCommandCommitEvidence) => {
      readonly receipt: RuntimeStoredCommandReceipt;
      readonly events: readonly import('./state-runtime').RuntimeEvent[];
    },
    activate?: (
      receipt: Extract<RuntimeCommandReceipt, { status: 'applied' }>,
      events: readonly import('./state-runtime').RuntimeEvent[],
      publish: (notification: RuntimeNotification) => void,
    ) => void,
  ): RuntimeHostCommandInspection {
    const sessionId = command.sessionId;
    return {
      kind: 'accepted',
      decision: {
        targetSessionId: sessionId,
        commit: async (evidence) => {
          const committed = commit(evidence);
          const receipt = receiptFromStored(committed.receipt);
          return {
            receipt,
            activation: async (publish) => {
              const authority = this.#sessions.get(sessionId);
              if (!authority) throw new Error(`Unknown TUI session: ${sessionId}`);
              authority.revision = receipt.revision;
              if (command.type === 'cancel_turn' || command.type === 'close_session') {
                this.#interactionHints.clear();
                this.#applyControlTerminal(authority, committed.events);
              }
              if (activate) activate(receipt, committed.events, publish);
              else
                this.#publishCommittedEvents(
                  sessionId,
                  committed.events,
                  receipt.revision,
                  publish,
                  'turn',
                );
            },
          };
        },
      },
    };
  }

  #preparedStart(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    runtime: SessionRuntime,
    pending: PendingRun,
    descriptor: PrecommittedStartTurnDescriptor,
    receipt: Extract<RuntimeCommandReceipt, { status: 'applied' }>,
  ): RuntimeHostPreparedExecution {
    return {
      execution: {
        sessionId: command.sessionId,
        operationId: command.commandId,
        committedRevision: receipt.revision,
        operation: 'turn',
        run: (signal, requestAbort) =>
          this.#executeRun(command, runtime, pending, descriptor, signal, requestAbort),
        cancel: (reason) => pending.reject(abortError(reason)),
      },
    };
  }

  #preparedCompaction(
    command: Extract<RuntimeCommand, { type: 'compact_session' }>,
    plan: ReturnType<SessionManager['inspectHostCompactionCommand']>,
    pending: PendingCompaction,
    receipt: Extract<RuntimeCommandReceipt, { status: 'applied' }>,
  ): RuntimeHostPreparedExecution {
    return {
      execution: {
        sessionId: command.sessionId,
        operationId: command.commandId,
        committedRevision: receipt.revision,
        operation: 'compaction',
        run: async (signal) => {
          try {
            const events = await this.#manager.executeCommittedHostCompaction(
              command.sessionId,
              plan,
              signal,
            );
            this.#publishStateEvents(command.sessionId, events);
            pending.result = this.#compactionResult(plan, events);
            pending.resolve();
          } catch (error) {
            pending.reject(error);
            throw error;
          } finally {
            this.#activePublishes.delete(command.sessionId);
            this.#pendingCompactions.delete(command.commandId);
          }
        },
        cancel: (reason) => pending.reject(abortError(reason)),
      },
    };
  }

  #compactionResult(
    plan: ReturnType<SessionManager['inspectHostCompactionCommand']>,
    events: readonly import('./state-runtime').RuntimeEvent[],
  ): ContextCompactionResult {
    return {
      events: events.flatMap((event) => {
        const projected = safelyProjectRuntimeEvent(event, 0);
        return projected ? [projected] : [];
      }),
      text: plan.presentation.text,
      ...(plan.presentation.isError ? { isError: true } : {}),
    };
  }

  #publishStateEvents(
    sessionId: string,
    events: readonly import('./state-runtime').RuntimeEvent[],
    publishOverride?: (notification: RuntimeNotification) => void,
  ): void {
    const authority = this.#sessions.get(sessionId);
    const coordinator = this.#coordinator(sessionId);
    const publish = publishOverride ?? this.#activePublishes.get(sessionId);
    if (!authority || !coordinator || !publish) return;
    const stateRevision = coordinator.getState().revision;
    for (const event of events) {
      const revision = authority.revision + 1;
      if (revision > stateRevision) break;
      authority.revision = revision;
      const projected = safelyProjectRuntimeEvent(event, revision);
      const interaction = projected ? interactionFromClientEvent(projected) : undefined;
      if (interaction) {
        this.#interactionHints.set(interaction.interactionId, {
          kind: interaction.kind,
          interactionId: interaction.interactionId,
        });
        authority.activeWork = setActiveInteraction(authority.activeWork, interaction);
      }
      this.#applyProjectedTerminal(authority, projected);
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId,
        revision,
        projection: {
          kind: 'turn',
          session: this.#projection(sessionId),
          ...(projected === undefined ? {} : { event: projected }),
        },
      });
    }
    this.#publishFinalStateSnapshot(sessionId, 'work');
  }

  #applyControlTerminal(
    authority: SessionAuthority,
    events: readonly import('./state-runtime').RuntimeEvent[],
  ): void {
    const terminal = events.find((event) => event.type === 'turn.aborted');
    if (!terminal || !authority.activeWork) return;
    authority.activeWork = {
      ...authority.activeWork,
      status: 'cancelled',
      activeTurn: authority.activeWork.activeTurn
        ? {
            ...authority.activeWork.activeTurn,
            turnId: terminal.turnId,
            status: 'cancelled',
            interaction: undefined,
          }
        : undefined,
    };
  }

  /** Keep the notification projection terminal at the same durable revision. */
  #applyProjectedTerminal(
    authority: SessionAuthority,
    event: RuntimeClientEvent | undefined,
  ): void {
    if (!authority.activeWork || !event) return;
    if (event.type === 'interaction.settled' || event.type === 'plan.approved') {
      authority.activeWork = clearActiveInteraction(authority.activeWork);
      return;
    }
    if (
      event.type !== 'task.terminal' &&
      event.type !== 'turn.terminal' &&
      event.type !== 'run.terminal'
    ) {
      return;
    }
    const status = event.status === 'aborted' ? 'cancelled' : event.status;
    authority.activeWork = {
      ...authority.activeWork,
      status,
      activeTurn: authority.activeWork.activeTurn
        ? { ...authority.activeWork.activeTurn, status, interaction: undefined }
        : undefined,
    };
  }

  #coordinator(sessionId: string): RuntimeSessionCoordinator | undefined {
    return this.#runtimeSessionCoordinator?.get(sessionId);
  }

  #ensureAuthority(
    sessionId: string,
    runtime: SessionRuntime,
    coordinator: RuntimeSessionCoordinator,
  ): SessionAuthority {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const authority: SessionAuthority = {
      revision: coordinator.getState().revision,
      workspace: runtime.workspace,
      lifecycle: 'open',
    };
    this.#sessions.set(sessionId, authority);
    return authority;
  }

  #startSkillPlanningContext(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    runtime: SessionRuntime,
    pending: PendingRun,
  ) {
    if (!command.initialSkills || command.initialSkills.length === 0) return undefined;
    const skillOptions = runtime.skillOptions;
    if (!skillOptions) {
      throw new Error('Runtime start command with initial skills requires TUI skill options.');
    }
    const flags = getFeatureFlags(pending.dependencies.config ?? runtime.config);
    return {
      skillOptions,
      mcpManager: runtime.mcpManager ?? undefined,
      flags: {
        skillActivation: flags.skillActivation,
        skillWorkflow: flags.skillWorkflow,
      },
    };
  }

  #publishCommittedEvents(
    sessionId: string,
    events: readonly import('./state-runtime').RuntimeEvent[],
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
        sessionId,
        revision,
        projection: {
          kind,
          session: { ...this.#projection(sessionId), revision },
          ...(projectedEvent === undefined ? {} : { event: projectedEvent }),
        },
      });
    }
  }

  async #executeRun(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    runtime: SessionRuntime,
    pending: PendingRun,
    precommittedStart: PrecommittedStartTurnDescriptor,
    signal: AbortSignal,
    requestAbort: (reason: string) => void,
  ): Promise<void> {
    const sessionId = command.sessionId;
    const authority = this.#sessions.get(sessionId);
    if (!authority) {
      pending.reject(new Error(`Unknown TUI session: ${sessionId}`));
      return;
    }
    const dispatch = pending.dependencies.dispatch;
    try {
      const coordinator = this.#coordinator(sessionId);
      if (!coordinator) {
        throw new Error(`TUI Runtime coordinator is unavailable: ${sessionId}`);
      }
      // start_turn already committed the mode used by this execution. Mirror
      // that authority into the legacy SessionRuntime before it compiles any
      // model/tool context; execution must not append a post-receipt mode fact.
      runtime.interactionMode = coordinator.getState().mode;
      await runtime.runTask(
        command.input,
        {
          ...pending.dependencies,
          onRuntimeStateEvent: (event) => this.#publishStateEvents(sessionId, [event]),
          dispatch: (action) => {
            if (action.type === 'RUNTIME_EVENT') {
              this.#publishPresentation(sessionId, action.event);
              return;
            }
            dispatch(action);
          },
        },
        pending.requestedPhase,
        pending.initialSkills,
        signal,
        requestAbort,
        precommittedStart,
      );
      const status = signal.aborted ? 'cancelled' : 'completed';
      authority.activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status,
        activeTurn: { turnId: precommittedStart.turnId, status },
      };
      this.#publishFinalStateSnapshot(sessionId, 'work');
      pending.resolve();
    } catch (error) {
      authority.activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status: 'failed',
        activeTurn: { turnId: precommittedStart.turnId, status: 'failed' },
      };
      this.#publishFinalStateSnapshot(sessionId, 'work');
      pending.reject(error);
    } finally {
      this.#activePublishes.delete(command.sessionId);
      this.#pendingRuns.delete(command.commandId);
    }
  }

  #createManagerClient(): TuiSessionManager {
    return new Proxy(this.#manager, {
      get: (target, property) => {
        if (this.#managerMembers.has(property)) return this.#managerMembers.get(property);
        const member = (() => {
          if (property === 'createSession') {
            return (workspace: string): string => {
              this.#assertAdmittedWorkspace(workspace);
              const project = this.#resolveProjectIdentity(workspace);
              const sessionId = target.createSession(workspace, {
                projectId: project.projectId,
                canonicalWorkspaceDigest: project.workspaceDigest,
              });
              this.#trackSessionReadiness(sessionId, {
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId: this.#nextCommandId(sessionId, 'create'),
                type: 'create_session',
                workspace,
                bootstrapSessionId: sessionId,
              });
              return sessionId;
            };
          }
          if (property === 'dispose') {
            return async (): Promise<void> => {
              await this.#awaitAllSessionReadiness();
              for (const controller of this.#subscriptionControllers.values()) controller.abort();
              await this.#access[Symbol.asyncDispose]();
            };
          }
          if (property === 'abortAll') {
            return async (): Promise<void> => {
              await this.#awaitAllSessionReadiness();
              await this.#access.cancelAllSessions('TUI shutdown requested.');
            };
          }
          if (property === 'cancelRuntimeOperations') {
            return async (sessionId: string): Promise<void> => {
              await this.#awaitSessionReadiness(sessionId);
              const runtime = target.getRuntime(sessionId);
              if (runtime) await this.#cancelTurn(runtime);
              await this.#access.waitForSessionIdle(sessionId);
            };
          }
          if (property === 'registerSession') {
            return (sessionId: string, workspace: string): object => {
              this.#assertAdmittedWorkspace(workspace);
              const runtime = target.registerSession(sessionId, workspace);
              this.#trackSessionReadiness(sessionId, {
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId: this.#nextCommandId(sessionId, 'resume'),
                type: 'resume_session',
                sessionId,
              });
              return this.#runtimeClient(runtime);
            };
          }
          if (property === 'waitForSessionReady') {
            return async (sessionId: string): Promise<void> => {
              await this.#awaitSessionReadiness(sessionId);
            };
          }
          if (property === 'clearSessionCommandGrants') {
            return async (sessionId: string): Promise<RuntimeCommandReceipt> => {
              await this.#awaitSessionReadiness(sessionId);
              const receipt = await this.#access.command({
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId: this.#nextCommandId(sessionId, 'clear-grants'),
                type: 'clear_session_command_grants',
                sessionId,
                expectedRevision: this.#revision(sessionId),
              });
              this.#assertApplied(receipt);
              return receipt;
            };
          }
          if (property === 'listRewindCheckpoints') {
            return async (sessionId: string): Promise<readonly RuntimeCheckpointProjection[]> => {
              await this.#awaitSessionReadiness(sessionId);
              const result = await this.#access.query({
                schema: 'kite.runtime-query.v1',
                type: 'list_checkpoints',
                sessionId,
              });
              return result.status === 'ok' && result.queryType === 'list_checkpoints'
                ? (result.checkpoints ?? [])
                : [];
            };
          }
          if (property === 'previewRewind') {
            return async (
              sessionId: string,
              checkpointId: string,
            ): Promise<RuntimeRewindPreviewProjection | null> => {
              await this.#awaitSessionReadiness(sessionId);
              const result = await this.#access.query({
                schema: 'kite.runtime-query.v1',
                type: 'get_rewind_preview',
                sessionId,
                checkpointId,
              });
              return result.status === 'ok' && result.queryType === 'get_rewind_preview'
                ? (result.rewindPreview ?? null)
                : null;
            };
          }
          if (property === 'getSessionProjection') {
            return async (sessionId: string): Promise<RuntimeSessionProjection | null> => {
              await this.#awaitSessionReadiness(sessionId);
              const result = await this.#access.query({
                schema: 'kite.runtime-query.v1',
                type: 'get_session_projection',
                sessionId,
              });
              return result.status === 'ok' && result.queryType === 'get_session_projection'
                ? (result.session ?? null)
                : null;
            };
          }
          if (property === 'listPersistedSessions') {
            return (query = '') => this.#history.listPersistedSessions(query);
          }
          if (property === 'loadPersistedSession') {
            return (sessionId: string) => this.#history.loadPersistedSession(sessionId);
          }
          if (property === 'getRuntime') {
            return (sessionId: string): object | undefined => {
              const runtime = target.getRuntime(sessionId);
              return runtime ? this.#runtimeClient(runtime) : undefined;
            };
          }
          if (property === 'forkRecoveredSessionForContinuation') {
            return (sessionId: string): object | undefined => {
              const runtime = target.forkRecoveredSessionForContinuation(sessionId);
              if (!runtime) return undefined;
              if (!this.#sessions.has(runtime.threadId)) {
                this.#sessions.set(runtime.threadId, {
                  revision: 0,
                  workspace: runtime.workspace,
                  lifecycle: 'open',
                });
              }
              return this.#runtimeClient(runtime);
            };
          }
          if (property === 'deletePersistedSession') {
            return async (sessionId: string): Promise<void> => {
              await this.#awaitSessionReadiness(sessionId);
              const authority = this.#sessions.get(sessionId);
              if (!authority) throw new Error(`Unknown TUI session: ${sessionId}`);
              const receipt = await this.#access.command({
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId: this.#nextCommandId(sessionId, 'delete'),
                type: 'delete_session',
                sessionId,
                expectedRevision: authority.revision,
              });
              this.#assertApplied(receipt);

              // The Runtime Host has already atomically removed durable State
              // and retained the receipt. Release only App-local handles;
              // never issue a close command that could rebuild the snapshot.
              await target.releaseRuntimeSessionCoordinator(sessionId);
              target.removeRuntimeAfterHostClose(sessionId);
              this.#subscriptionControllers.get(sessionId)?.abort();
              this.#subscriptionControllers.delete(sessionId);
              this.#subscriptionReadiness.delete(sessionId);
              this.#runtimeClients.delete(sessionId);
              this.#sessionReadiness.delete(sessionId);
              this.#sessions.delete(sessionId);
            };
          }
          if (property === 'removeRuntime') {
            return async (sessionId: string): Promise<void> => {
              let cleanupError: unknown;
              const rememberError = (error: unknown): void => {
                cleanupError ??= error;
              };

              let readinessSettled = false;
              try {
                await this.#awaitSessionReadiness(sessionId);
                readinessSettled = true;
              } catch (error) {
                // A rejected resume/create admission still leaves a local
                // Runtime that must be removed. Preserve the rejection for
                // the caller, but do not strand the registration behind it.
                rememberError(error);
              }

              let operationActive = false;
              try {
                operationActive = this.#access.isSessionOperationActive(sessionId);
              } catch (error) {
                // If the Host cannot answer, fail closed and attempt the
                // draining close path before releasing the coordinator.
                operationActive = true;
                rememberError(error);
              }
              // A settled admission owns a Host lifecycle entry even when it
              // never started work. Close that entry without manufacturing a
              // cancellation fact; a failed admission has no confirmed Host
              // lifecycle to close. An observed live operation remains a
              // fail-closed close candidate even if readiness reporting failed.
              const shouldCloseHost = readinessSettled || operationActive;

              try {
                const authority = this.#sessions.get(sessionId);
                let closeApplied = false;
                if (authority && shouldCloseHost) {
                  try {
                    const receipt = await this.#access.command({
                      schema: RUNTIME_COMMAND_SCHEMA_,
                      commandId: this.#nextCommandId(sessionId, 'close'),
                      type: 'close_session',
                      sessionId,
                      expectedRevision: authority.revision,
                    });
                    this.#assertApplied(receipt);
                    closeApplied = true;
                  } catch (error) {
                    rememberError(error);
                  }
                }

                // A failed close can leave a scheduled operation alive;
                // always make one bounded drain attempt before releasing
                // the State coordinator and manager registration. This also
                // covers a Host operation whose local bridge authority was
                // lost while readiness was failing.
                if (closeApplied || operationActive) {
                  try {
                    await this.#access.waitForSessionIdle(sessionId);
                  } catch (error) {
                    rememberError(error);
                  }
                }
              } catch (error) {
                rememberError(error);
              }

              try {
                await target.releaseRuntimeSessionCoordinator(sessionId);
              } catch (error) {
                rememberError(error);
              }

              try {
                target.removeRuntimeAfterHostClose(sessionId);
              } catch (error) {
                rememberError(error);
              } finally {
                this.#subscriptionControllers.get(sessionId)?.abort();
                this.#subscriptionControllers.delete(sessionId);
                this.#subscriptionReadiness.delete(sessionId);
                this.#runtimeClients.delete(sessionId);
                this.#sessionReadiness.delete(sessionId);
                this.#sessions.delete(sessionId);
              }

              if (cleanupError !== undefined) throw cleanupError;
            };
          }
          if (property === 'handleContextCompaction') {
            return async (
              sessionId: string,
              instructions?: string,
              onProgress?: ContextCompactionProgress,
              onCommand?: ContextCompactionCommand,
            ): Promise<ContextCompactionResult | undefined> => {
              await this.#awaitSessionReadiness(sessionId);
              const commandId = this.#nextCommandId(sessionId, 'compact');
              const deferred = createDeferred();
              const pending: PendingCompaction = {
                instructions,
                onProgress,
                onCommand,
                ...deferred,
              };
              this.#pendingCompactions.set(commandId, pending);
              try {
                const receipt = await this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_,
                  commandId,
                  type: 'compact_session',
                  sessionId,
                  expectedRevision: this.#revision(sessionId),
                  mode: 'manual',
                  ...(instructions === undefined ? {} : { instructions }),
                });
                this.#assertApplied(receipt);
                await pending.completion;
                return pending.result;
              } finally {
                this.#pendingCompactions.delete(commandId);
              }
            };
          }
          if (property === 'handleContextReset') {
            return async (sessionId: string): Promise<ContextCompactionResult | undefined> => {
              await this.#awaitSessionReadiness(sessionId);
              const commandId = this.#nextCommandId(sessionId, 'reset');
              const pending: PendingCompaction = { ...createDeferred() };
              this.#pendingCompactions.set(commandId, pending);
              try {
                const receipt = await this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_,
                  commandId,
                  type: 'compact_session',
                  sessionId,
                  expectedRevision: this.#revision(sessionId),
                  mode: 'reset',
                });
                this.#assertApplied(receipt);
                await pending.completion;
                return pending.result;
              } finally {
                this.#pendingCompactions.delete(commandId);
              }
            };
          }
          if (property === 'executeRewind') {
            return async (input: {
              sourceThreadId: string;
              snapshotId: string;
              scope: 'code_and_conversation' | 'code_only' | 'conversation_only';
              workspace: string;
            }): Promise<RewindResult | undefined> => {
              await this.#awaitSessionReadiness(input.sourceThreadId);
              const commandId = this.#nextCommandId(input.sourceThreadId, 'rewind');
              const pending: PendingRewind = {
                workspace: input.workspace,
                ...createDeferred(),
              };
              this.#pendingRewinds.set(commandId, pending);
              try {
                const receipt = await this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_,
                  commandId,
                  type: 'rewind_session',
                  sessionId: input.sourceThreadId,
                  expectedRevision: this.#revision(input.sourceThreadId),
                  checkpointId: input.snapshotId,
                  scope:
                    input.scope === 'code_and_conversation'
                      ? 'conversation_and_workspace'
                      : input.scope,
                });
                this.#assertApplied(receipt);
                await pending.completion;
                return pending.result;
              } finally {
                this.#pendingRewinds.delete(commandId);
              }
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        })();
        if (typeof member === 'function') this.#managerMembers.set(property, member);
        return member;
      },
    }) as unknown as TuiSessionManager;
  }

  #runtimeClient(runtime: SessionRuntime): object {
    const existing = this.#runtimeClients.get(runtime.threadId);
    if (existing) return existing;
    const client = new Proxy(runtime, {
      get: (target, property) => {
        if (property === 'runTask') {
          return async (
            task: string,
            dependencies: Parameters<SessionRuntime['runTask']>[1],
            requestedPhase?: Parameters<SessionRuntime['runTask']>[2],
            initialSkills?: Parameters<SessionRuntime['runTask']>[3],
          ): Promise<void> => {
            await this.#awaitSessionReadiness(target.threadId);
            await this.#ensureSessionSubscription(target.threadId, dependencies.dispatch);
            const commandId = this.#nextCommandId(target.threadId, 'turn');
            const pending: PendingRun = {
              dependencies,
              requestedPhase,
              initialSkills,
              ...createDeferred(),
            };
            this.#pendingRuns.set(commandId, pending);
            try {
              const receipt = await this.#access.command({
                schema: RUNTIME_COMMAND_SCHEMA_,
                commandId,
                type: 'start_turn',
                sessionId: target.threadId,
                expectedRevision: this.#revision(target.threadId),
                input: task,
                ...(requestedPhase === undefined ? {} : { phase: requestedPhase }),
                ...(initialSkills === undefined ? {} : { initialSkills }),
              });
              this.#assertApplied(receipt);
              await pending.completion;
            } finally {
              this.#pendingRuns.delete(commandId);
            }
          };
        }
        if (property === 'waitForRunCompletion') {
          return async (): Promise<void> => {
            await this.#awaitSessionReadiness(target.threadId);
            await this.#access.waitForSessionIdle(target.threadId);
          };
        }
        if (property === 'abort') {
          return (): void => {
            // Cancellation is a Runtime command. The Host commits the exact
            // turn identity before its lifecycle supervisor aborts execution;
            // the Client must never become a second State/lifecycle owner.
            void this.#cancelTurn(target).catch((error) => {
              target.reportRuntimeFailure(
                error instanceof Error
                  ? error.message
                  : `TUI Runtime cancellation failed: ${String(error)}`,
              );
            });
          };
        }
        if (property === 'setInteractionMode') {
          return (mode: 'accept_edits' | 'auto' | 'full'): void => {
            void this.#awaitSessionReadiness(target.threadId)
              .then(() =>
                this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_,
                  commandId: this.#nextCommandId(target.threadId, 'mode'),
                  type: 'set_interaction_mode',
                  sessionId: target.threadId,
                  expectedRevision: this.#revision(target.threadId),
                  mode,
                }),
              )
              .catch(() => {});
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set: (target, property, value) => Reflect.set(target, property, value, target),
    });
    this.#runtimeClients.set(runtime.threadId, client);
    return client;
  }

  #ensureSessionSubscription(sessionId: string, dispatch: TuiRuntimeDispatch): Promise<void> {
    const existing = this.#subscriptionReadiness.get(sessionId);
    if (existing) return existing;
    const controller = new AbortController();
    this.#subscriptionControllers.set(sessionId, controller);
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let ready = false;
    const readiness = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#subscriptionReadiness.set(sessionId, readiness);
    const notifications = this.#access.subscribe({
      spec: { scope: 'session', sessionId, includeEphemeral: true },
      signal: controller.signal,
    });
    void (async () => {
      try {
        for await (const notification of notifications) {
          if (!ready) {
            ready = true;
            resolveReady();
          }
          this.#dispatchClientNotification(sessionId, notification, dispatch);
        }
        if (!ready && !controller.signal.aborted) {
          rejectReady(new Error(`Runtime Client subscription closed before ready: ${sessionId}`));
        }
      } catch (error) {
        if (!ready) rejectReady(error);
      }
    })();
    return readiness;
  }

  #dispatchClientNotification(
    sessionId: string,
    notification: RuntimeAccessNotification,
    dispatch: TuiRuntimeDispatch,
  ): void {
    if (!('durability' in notification)) return;
    if (notification.durability === 'ephemeral') {
      const event = clientEventFromEphemeral(notification);
      if (event) dispatch({ type: 'RUNTIME_EVENT', event });
      return;
    }
    const authority = this.#sessions.get(sessionId);
    if (authority && notification.revision > authority.revision) {
      authority.revision = notification.revision;
      authority.lifecycle =
        notification.projection.session.lifecycle === 'closed' ? 'closed' : 'open';
      authority.activeWork = notification.projection.session.activeWork;
    }
    const event = notification.projection.event;
    if (!event) return;
    const interaction = interactionFromClientEvent(event);
    if (interaction) {
      this.#interactionHints.set(interaction.interactionId, {
        kind: interaction.kind,
        interactionId: interaction.interactionId,
      });
    }
    dispatch({ type: 'RUNTIME_EVENT', event });
  }

  #submitClientInteraction(action: Parameters<SessionRuntime['resolveInterrupt']>[0]): void {
    const sessionId = this.#manager.getActiveId();
    const runtime = sessionId ? this.#manager.getRuntime(sessionId) : undefined;
    const authority = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!sessionId || !runtime || !authority) return;
    const hint = this.#interactionHints.get(action.interactionId);
    const state = runtime.authorizedExecutionControl?.getState();
    if (action.type === 'cancel' && (!hint || !state)) {
      void this.#cancelTurn(runtime).catch((error) => {
        runtime.reportRuntimeFailure(
          error instanceof Error ? error.message : `TUI interaction cancellation failed: ${error}`,
        );
      });
      return;
    }
    if (!hint || !state) {
      runtime.reportRuntimeFailure('TUI Runtime interaction identity is unavailable.');
      return;
    }
    const interaction = projectCurrentRuntimeClientInteraction(state, hint, {
      sessionRevision: authority.revision,
    });
    const response = interaction ? clientResponseForSessionAction(interaction, action) : null;
    if (!interaction || !response) {
      if (interaction && action.type === 'cancel') {
        void this.#cancelTurn(runtime).catch((error) => {
          runtime.reportRuntimeFailure(
            error instanceof Error
              ? error.message
              : `TUI Runtime interaction cancellation failed: ${error}`,
          );
        });
        return;
      }
      runtime.reportRuntimeFailure('TUI Runtime interaction response is invalid.');
      return;
    }
    void this.#awaitSessionReadiness(sessionId)
      .then(() =>
        this.#access.command(
          respondInteractionCommand(
            this.#nextCommandId(sessionId, 'interaction'),
            sessionId,
            interaction,
            response,
          ),
        ),
      )
      .then((receipt) => this.#assertApplied(receipt))
      .catch((error) => {
        runtime.reportRuntimeFailure(
          error instanceof Error ? error.message : `TUI Runtime interaction failed: ${error}`,
        );
      });
  }

  async #cancelTurn(runtime: SessionRuntime): Promise<void> {
    await this.#awaitSessionReadiness(runtime.threadId);
    const initialAuthority = this.#sessions.get(runtime.threadId);
    const initialWork = initialAuthority?.activeWork;
    if (initialAuthority && !isCancellableRuntimeWork(initialWork)) return;
    const turnId = initialWork?.activeTurn?.turnId ?? runtime.threadId;
    let expectedRevision = this.#revision(runtime.threadId);
    for (let attempt = 0; attempt < TUI_CANCEL_REVISION_RETRY_LIMIT; attempt += 1) {
      const receipt = await this.#access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: this.#nextCommandId(runtime.threadId, 'cancel'),
        type: 'cancel_turn',
        sessionId: runtime.threadId,
        expectedRevision,
        turnId,
      });
      if (receipt.status === 'applied' || receipt.status === 'idempotent_replay') return;
      if (receipt.code === 'turn_not_found') return;
      if (
        receipt.status === 'conflict' &&
        receipt.code === 'revision_conflict' &&
        Number.isSafeInteger(receipt.currentRevision) &&
        receipt.currentRevision! >= 0
      ) {
        const currentAuthority = this.#sessions.get(runtime.threadId);
        const currentWork = currentAuthority?.activeWork;
        if (
          currentAuthority &&
          (!isCancellableRuntimeWork(currentWork) || currentWork.activeTurn.turnId !== turnId)
        ) {
          return;
        }
        expectedRevision = receipt.currentRevision!;
        continue;
      }
      throw new Error(`TUI Runtime cancellation rejected: ${receipt.code}`);
    }
    throw new Error('TUI Runtime cancellation rejected: revision_conflict');
  }

  #publishPresentation(sessionId: string, event: RuntimeClientEvent): void {
    const authority = this.#sessions.get(sessionId);
    if (!authority) return;
    const publish = this.#activePublishes.get(sessionId);
    if (!publish) return;
    const sequence = (this.#streamSequences.get(sessionId) ?? 0) + 1;
    const workId = authority.activeWork?.workId ?? sessionId;
    const turnId = authority.activeWork?.activeTurn?.turnId ?? workId;
    if (
      event.type === 'model.text_delta' ||
      event.type === 'tool.progress' ||
      event.type === 'reasoning.activity'
    ) {
      this.#streamSequences.set(sessionId, sequence);
      publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'ephemeral',
        sessionId,
        workId,
        turnId,
        actorId: 'runtime-agent',
        attemptId: workId,
        compositionRevision: 'runtime-client-v1',
        streamId: workId,
        sequence,
        event,
      });
      return;
    }
    // All durable facts arrive through RUNTIME_STATE_EVENT and
    // #publishStateEvents, which retains their exact State revision even when
    // the safe projector omits the event. Do not create a second compressed
    // durable stream from the already-projected presentation event.
  }

  #publishFinalStateSnapshot(sessionId: string, _kind: 'session' | 'work' | 'turn'): void {
    const authority = this.#sessions.get(sessionId);
    const coordinator = this.#coordinator(sessionId);
    const publish = this.#activePublishes.get(sessionId);
    if (!authority || !coordinator || !publish) return;
    const revision = coordinator.getState().revision;
    if (revision <= authority.revision) return;
    // A caller with an unreported durable mutation must publish the mutation
    // itself through #publishStateEvents. Never synthesize a revision range
    // here: doing so would bind future safe events to the wrong State fact.
    return;
  }

  #notification(
    sessionId: string,
    kind: 'snapshot' | 'session' | 'work' | 'turn' | 'interaction' | 'evidence',
  ): Extract<RuntimeNotification, { durability: 'durable' }> {
    const projection = this.#projection(sessionId);
    return {
      schema: RUNTIME_NOTIFICATION_SCHEMA_,
      durability: 'durable',
      sessionId,
      revision: projection.revision,
      projection: { kind, session: projection },
    };
  }

  #projection(sessionId: string): RuntimeSessionProjection {
    const authority = this.#sessions.get(sessionId);
    if (!authority) throw new Error(`Unknown TUI session: ${sessionId}`);
    const runtime = this.#manager.getRuntime(sessionId);
    const coordinator = this.#coordinator(sessionId);
    return {
      schema: RUNTIME_PROJECTION_SCHEMA_,
      sessionId,
      revision: authority.revision,
      displayName: runtime?.name,
      workspace: authority.workspace,
      lifecycle: authority.lifecycle,
      sessionCommandGrantCount: coordinator?.getState()?.sessionCommandGrants?.size ?? 0,
      activeWork: authority.activeWork,
    };
  }

  #revision(sessionId: string): number {
    return this.#sessions.get(sessionId)?.revision ?? 0;
  }

  #trackSessionReadiness(
    sessionId: string,
    command: Extract<RuntimeCommand, { type: 'create_session' | 'resume_session' }>,
  ): void {
    const previous = this.#sessionReadiness.get(sessionId) ?? Promise.resolve();
    const readiness = previous.then(async () => {
      const receipt = await this.#access.command(command);
      this.#assertApplied(receipt);
    });
    this.#sessionReadiness.set(sessionId, readiness);
    // Creation remains a synchronous client API, so attach a rejection
    // observer here. Promise-returning follow-up operations still await and
    // surface the same failure; synchronous fire-and-forget methods attach
    // their own sinks instead of racing an absent Host authority.
    void readiness.catch(() => {});
  }

  async #awaitSessionReadiness(sessionId: string): Promise<void> {
    await this.#sessionReadiness.get(sessionId);
  }

  async #awaitAllSessionReadiness(): Promise<void> {
    await Promise.allSettled(this.#sessionReadiness.values());
  }

  #nextCommandId(_sessionId: string, _operation: string): string {
    return this.#commandIds.next();
  }

  #assertAdmittedWorkspace(workspace: string): void {
    const expected = this.#resolveProjectIdentity(this.#admittedWorkspace);
    const actual = this.#resolveProjectIdentity(workspace);
    if (
      actual.projectId !== expected.projectId ||
      actual.workspaceDigest !== expected.workspaceDigest
    ) {
      throw new Error('TUI Runtime Workspace is outside the admitted App scope.');
    }
  }

  #reject(
    command: RuntimeCommand,
    code: RuntimeCommandErrorCode,
  ): Exclude<RuntimeCommandReceipt, { readonly status: 'applied' }> {
    return {
      status: 'rejected',
      commandId: command.commandId,
      code,
      currentRevision:
        'sessionId' in command ? this.#sessions.get(command.sessionId)?.revision : undefined,
    };
  }

  #notFound(
    command: RuntimeCommand,
  ): Exclude<RuntimeCommandReceipt, { readonly status: 'applied' }> {
    return {
      status: 'not_found',
      commandId: command.commandId,
      code: 'session_not_found',
    };
  }

  #assertApplied(receipt: RuntimeCommandReceipt): void {
    if (receipt.status === 'applied' || receipt.status === 'idempotent_replay') return;
    throw new Error(`TUI Runtime command rejected: ${receipt.code}`);
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

function isCancellableRuntimeWork(
  work: RuntimeSessionProjection['activeWork'],
): work is NonNullable<RuntimeSessionProjection['activeWork']> & {
  readonly activeTurn: NonNullable<
    NonNullable<RuntimeSessionProjection['activeWork']>['activeTurn']
  >;
} {
  if (!work?.activeTurn) return false;
  return (
    (work.status === 'queued' || work.status === 'running' || work.status === 'waiting') &&
    (work.activeTurn.status === 'queued' ||
      work.activeTurn.status === 'running' ||
      work.activeTurn.status === 'waiting')
  );
}

function safelyProjectRuntimeEvent(
  event: import('./state-runtime').RuntimeEvent,
  revision: number,
): RuntimeClientEvent | undefined {
  try {
    return projectRuntimeClientEvent(event, { sessionRevision: revision });
  } catch {
    return undefined;
  }
}

function interactionFromClientEvent(
  event: RuntimeClientEvent,
): RuntimeClientInteraction | undefined {
  switch (event.type) {
    case 'interaction.available':
    case 'approval.queued':
    case 'input.requested':
    case 'plan.review_requested':
    case 'provider.action':
    case 'verification.status':
      return event.interaction;
    default:
      return undefined;
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

function clientResponseForSessionAction(
  interaction: RuntimeClientInteraction,
  action: Parameters<SessionRuntime['resolveInterrupt']>[0],
): RuntimeInteractionResponse | null {
  switch (interaction.kind) {
    case 'approval':
      if (action.type === 'approve') {
        return {
          kind: 'approval',
          decision: action.grant === 'same_command' ? 'same_command' : 'approve_once',
        };
      }
      return action.type === 'reject' ? { kind: 'approval', decision: 'reject' } : null;
    case 'input':
      return action.type === 'input'
        ? { kind: 'text', value: action.text }
        : action.type === 'cancel'
          ? { kind: 'input_cancel' }
          : null;
    case 'plan_review':
      if (action.type === 'cancel') return { kind: 'plan_review', decision: 'cancel' };
      if (action.type !== 'plan_review_decision') return null;
      if (action.decision.kind === 'approve') {
        return {
          kind: 'plan_review',
          decision: action.decision.nextMode === 'auto' ? 'auto' : 'accept_edits',
        };
      }
      if (action.decision.kind === 'revise') {
        return { kind: 'plan_review', decision: 'feedback', feedback: action.decision.feedback };
      }
      return { kind: 'plan_review', decision: 'cancel' };
    case 'provider_action': {
      if (action.type === 'cancel') return { kind: 'provider_action', outcome: 'cancelled' };
      if (action.type !== 'input') return null;
      const answer = action.text.trim().toLowerCase();
      return {
        kind: 'provider_action',
        outcome: /^(?:later|defer|session\s+waive|waive)/u.test(answer)
          ? 'deferred'
          : /^(?:cancel|stop)/u.test(answer)
            ? 'cancelled'
            : 'completed',
      };
    }
    case 'verification': {
      if (action.type !== 'input') return null;
      const answer = action.text.trim();
      const normalized = answer.toLowerCase();
      return {
        kind: 'verification',
        decision: normalized.startsWith('compensate')
          ? 'compensate'
          : normalized.startsWith('waive')
            ? 'waive'
            : 'replan',
        detail:
          answer.replace(/^(?:compensate|waive|replan)\s*:?\s*/iu, '').trim() ||
          'TUI client selected this verification action.',
      };
    }
  }
}

function respondInteractionCommand(
  commandId: string,
  sessionId: string,
  interaction: RuntimeClientInteraction,
  response: RuntimeInteractionResponse,
): RuntimeCommand {
  const base = {
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId,
    type: 'respond_interaction' as const,
    sessionId,
    expectedRevision: interaction.sessionRevision,
  };
  switch (interaction.kind) {
    case 'approval':
      if (response.kind !== 'approval') throw new Error('Approval response kind changed.');
      return { ...base, interaction, response };
    case 'input':
      if (response.kind !== 'text' && response.kind !== 'input_cancel') {
        throw new Error('Input response kind changed.');
      }
      return { ...base, interaction, response };
    case 'plan_review':
      if (response.kind !== 'plan_review') throw new Error('Plan response kind changed.');
      return { ...base, interaction, response };
    case 'provider_action':
      if (response.kind !== 'provider_action') throw new Error('Provider response kind changed.');
      return { ...base, interaction, response };
    case 'verification':
      if (response.kind !== 'verification') throw new Error('Verification response kind changed.');
      return { ...base, interaction, response };
  }
}

function clientEventFromEphemeral(
  notification: Extract<RuntimeAccessNotification, { durability: 'ephemeral' }>,
): RuntimeClientEvent {
  return notification.event;
}

function createDeferred(): Pick<PendingRun, 'completion' | 'resolve' | 'reject'> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { completion, resolve, reject };
}

function checkpointProjection(
  sessionId: string,
  revision: number,
  checkpoint: {
    readonly snapshotId: string;
    readonly eventPosition: number;
    readonly createdAt: number;
    readonly targetMessage?: string;
    readonly targetMessageCreatedAt?: number;
    readonly affectedFileCount?: number;
  },
): RuntimeCheckpointProjection {
  const targetMessage =
    checkpoint.targetMessage === undefined
      ? undefined
      : projectRuntimeClientText(checkpoint.targetMessage, 8_192);
  return {
    checkpointId: checkpoint.snapshotId,
    sessionId,
    revision,
    eventPosition: checkpoint.eventPosition,
    createdAt: checkpoint.createdAt,
    ...(targetMessage ? { targetMessage } : {}),
    ...(checkpoint.targetMessageCreatedAt === undefined
      ? {}
      : { targetMessageCreatedAt: checkpoint.targetMessageCreatedAt }),
    affectedFileCount: checkpoint.affectedFileCount ?? 0,
  };
}

function rewindPreviewProjection(
  sessionId: string,
  checkpointId: string,
  revision: number,
  preview: {
    readonly files: readonly {
      readonly path: string;
      readonly addedLines: number;
      readonly removedLines: number;
    }[];
    readonly lineStatsAvailable: boolean;
    readonly addedLines: number;
    readonly removedLines: number;
    readonly conflictCount: number;
    readonly failureCount: number;
  },
): RuntimeRewindPreviewProjection {
  return {
    checkpointId,
    sessionId,
    revision,
    files: preview.files.slice(0, 256).flatMap((file) => {
      const path = projectRuntimeClientText(file.path, 8_192);
      return path ? [{ path, addedLines: file.addedLines, removedLines: file.removedLines }] : [];
    }),
    lineStatsAvailable: preview.lineStatsAvailable,
    addedLines: preview.addedLines,
    removedLines: preview.removedLines,
    conflictCount: preview.conflictCount,
    failureCount: preview.failureCount,
  };
}

function abortError(reason: string): Error {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}
