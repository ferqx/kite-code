import {
  type ClientPresentationEvent,
  RUNTIME_COMMAND_SCHEMA_V1,
  RUNTIME_NOTIFICATION_SCHEMA_V1,
  RUNTIME_PROJECTION_SCHEMA_V1,
  type RuntimeCommand,
  type RuntimeCommandErrorCode,
  type RuntimeCommandReceipt,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
} from '@kite/runtime-contract';
import {
  type RuntimeHostCoordinatorPortV1,
  type RuntimeHostExecutionBridge,
  type RuntimeHostKernelInput,
  type RuntimeHostPreparedExecution,
  runtimeCommandFromKernelInput,
} from '@kite/runtime-host';
import type { ProjectIdentityV1 } from '@kite/runtime-spi';
import type { Action } from '#app/tui/reducers/actions';
import { projectRuntimeEphemeralNotificationV1 } from '../presentation-notification';
import { type SessionDeps, SessionManager, type SessionRuntime } from './SessionManager';
import type { RuntimeEvent } from './state-runtime';

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
  result?: RewindResult;
}

export function createTuiRuntimeClientV1(
  input: SessionDeps,
  createHost: (bridge: RuntimeHostExecutionBridge) => RuntimeHostCoordinatorPortV1,
  resolveProjectIdentity: (workspace: string) => ProjectIdentityV1,
): object {
  return new TuiRuntimeBridgeV1(input, createHost, resolveProjectIdentity).client;
}

class TuiRuntimeBridgeV1 implements RuntimeHostExecutionBridge {
  readonly #manager: SessionManager;
  readonly #access: RuntimeHostCoordinatorPortV1;
  readonly #sessions = new Map<string, SessionAuthority>();
  readonly #runtimeClients = new Map<string, object>();
  readonly #managerMembers = new Map<PropertyKey, unknown>();
  readonly #pendingRuns = new Map<string, PendingRun>();
  readonly #pendingCompactions = new Map<string, PendingCompaction>();
  readonly #pendingRewinds = new Map<string, PendingRewind>();
  readonly #streamSequences = new Map<string, number>();
  readonly #resolveProjectIdentity: (workspace: string) => ProjectIdentityV1;
  #commandSequence = 0;
  readonly client: object;

  constructor(
    input: SessionDeps,
    createHost: (bridge: RuntimeHostExecutionBridge) => RuntimeHostCoordinatorPortV1,
    resolveProjectIdentity: (workspace: string) => ProjectIdentityV1,
  ) {
    this.#manager = new SessionManager(input);
    this.#access = createHost(this);
    this.#resolveProjectIdentity = resolveProjectIdentity;
    this.client = this.#createManagerClient();
  }

  async recoverSession(
    sessionId: string,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    const authority = this.#sessions.get(sessionId);
    if (!this.#manager.recoverRuntimeState(sessionId) || !authority) return;
    authority.revision += 1;
    publish(this.#notification(sessionId, 'session'));
  }

  async prepare(
    input: RuntimeHostKernelInput,
    publish: (notification: RuntimeNotification) => void,
  ): Promise<RuntimeHostPreparedExecution> {
    const command = runtimeCommandFromKernelInput(input);
    if (command.type === 'create_session') {
      const sessionId = command.bootstrapSessionId;
      if (!sessionId) return { receipt: this.#reject(command, 'invalid_session') };
      if (!this.#sessions.has(sessionId)) {
        this.#sessions.set(sessionId, {
          revision: 0,
          workspace: command.workspace,
          lifecycle: 'open',
        });
      }
      return { receipt: this.#applied(command, sessionId) };
    }
    if (command.type === 'resume_session') {
      const runtime = this.#manager.getRuntime(command.sessionId);
      if (!runtime) return { receipt: this.#notFound(command) };
      if (!this.#sessions.has(command.sessionId)) {
        this.#sessions.set(command.sessionId, {
          revision: command.afterRevision ?? 0,
          workspace: runtime.workspace,
          lifecycle: 'open',
        });
      }
      return { receipt: this.#applied(command, command.sessionId) };
    }
    const sessionId = 'sessionId' in command ? command.sessionId : command.sourceSessionId;
    const authority = this.#sessions.get(sessionId);
    const runtime = this.#manager.getRuntime(sessionId);
    if (!authority) return { receipt: this.#notFound(command) };
    if (command.type === 'close_session') {
      runtime?.persistCancellation('Runtime session closed.');
      authority.lifecycle = 'closed';
      authority.revision += 1;
      return { receipt: this.#applied(command, sessionId) };
    }
    if (!runtime) return { receipt: this.#notFound(command) };
    if (command.type === 'start_turn') {
      const pending = this.#pendingRuns.get(command.commandId);
      if (!pending) return { receipt: this.#reject(command, 'invalid_command') };
      authority.revision += 1;
      authority.activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status: 'running',
        activeTurn: { turnId: command.commandId, status: 'running' },
      };
      const receipt = this.#applied(command, sessionId);
      return {
        receipt,
        execution: {
          sessionId,
          operationId: command.commandId,
          committedRevision: receipt.revision,
          operation: 'turn',
          run: (signal, requestAbort) =>
            this.#executeRun(command, runtime, pending, publish, signal, requestAbort),
          cancel: (reason) => pending.reject(abortError(reason)),
        },
      };
    }
    if (command.type === 'cancel_turn') {
      runtime.persistCancellation('Cancelled by user.');
      authority.revision += 1;
      return { receipt: this.#applied(command, sessionId) };
    }
    if (command.type === 'set_interaction_mode') {
      runtime.setInteractionMode(command.mode);
      authority.revision += 1;
      return { receipt: this.#applied(command, sessionId) };
    }
    if (command.type === 'compact_session') {
      const pending = this.#pendingCompactions.get(command.commandId);
      if (!pending) return { receipt: this.#reject(command, 'invalid_command') };
      authority.revision += 1;
      const receipt = this.#applied(command, sessionId);
      return {
        receipt,
        execution: {
          sessionId,
          operationId: command.commandId,
          committedRevision: receipt.revision,
          operation: 'compaction',
          run: (signal, _requestAbort) => this.#executeCompaction(command, pending, signal),
          cancel: (reason) => pending.reject(abortError(reason)),
        },
      };
    }
    if (command.type === 'rewind_session') {
      const pending = this.#pendingRewinds.get(command.commandId);
      if (!pending) return { receipt: this.#reject(command, 'invalid_command') };
      pending.result = await this.#manager.executeRewind({
        sourceThreadId: sessionId,
        snapshotId: command.checkpointId,
        scope:
          command.scope === 'conversation_and_workspace' ? 'code_and_conversation' : command.scope,
        workspace: pending.workspace,
      });
      authority.revision += 1;
      return { receipt: this.#applied(command, sessionId) };
    }
    return { receipt: this.#reject(command, 'unsupported') };
  }

  async shutdownSession(
    sessionId: string,
    reason: string,
    _publish: (notification: RuntimeNotification) => void,
  ): Promise<void> {
    this.#manager.getRuntime(sessionId)?.persistCancellation(reason);
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
    return Promise.resolve({
      status: 'rejected',
      queryType: query.type,
      code: 'unsupported',
    });
  }

  async #executeRun(
    command: Extract<RuntimeCommand, { type: 'start_turn' }>,
    runtime: SessionRuntime,
    pending: PendingRun,
    publish: (notification: RuntimeNotification) => void,
    signal: AbortSignal,
    requestAbort: (reason: string) => void,
  ): Promise<void> {
    const sessionId = command.sessionId;
    const authority = this.#sessions.get(sessionId);
    if (!authority) {
      pending.reject(new Error(`Unknown legacy TUI session: ${sessionId}`));
      return;
    }
    const dispatch = pending.dependencies.dispatch;
    try {
      await runtime.runTask(
        command.input,
        {
          ...pending.dependencies,
          dispatch: (action: Action) => {
            if (action.type === 'RUNTIME_EVENT') {
              this.#publishPresentation(sessionId, action.event, publish);
            }
            dispatch(action);
          },
        },
        pending.requestedPhase,
        pending.initialSkills,
        signal,
        requestAbort,
      );
      const status = signal.aborted ? 'cancelled' : 'completed';
      authority.revision += 1;
      authority.activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status,
        activeTurn: { turnId: command.commandId, status },
      };
      publish(this.#notification(sessionId, 'work'));
      pending.resolve();
    } catch (error) {
      authority.revision += 1;
      authority.activeWork = {
        workId: command.commandId,
        phase: command.phase ?? 'building',
        status: 'failed',
        activeTurn: { turnId: command.commandId, status: 'failed' },
      };
      publish(this.#notification(sessionId, 'work'));
      pending.reject(error);
    } finally {
      this.#pendingRuns.delete(command.commandId);
    }
  }

  async #executeCompaction(
    command: Extract<RuntimeCommand, { type: 'compact_session' }>,
    pending: PendingCompaction,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      pending.result =
        command.mode === 'reset'
          ? await this.#manager.handleContextResetFromHost(command.sessionId, signal)
          : await this.#manager.executeHostCompactionV1(
              command.sessionId,
              pending.instructions,
              pending.onProgress,
              pending.onCommand,
              signal,
            );
      pending.resolve();
    } catch (error) {
      pending.reject(error);
    }
  }

  #createManagerClient(): object {
    return new Proxy(this.#manager, {
      get: (target, property) => {
        if (this.#managerMembers.has(property)) return this.#managerMembers.get(property);
        const member = (() => {
          if (property === 'createSession') {
            return (workspace: string): string => {
              const project = this.#resolveProjectIdentity(workspace);
              const sessionId = target.createSession(workspace, {
                projectId: project.projectId,
                canonicalWorkspaceDigest: project.workspaceDigest,
              });
              void this.#access.command({
                schema: RUNTIME_COMMAND_SCHEMA_V1,
                commandId: this.#nextCommandId(sessionId, 'create'),
                type: 'create_session',
                workspace,
                bootstrapSessionId: sessionId,
              });
              return sessionId;
            };
          }
          if (property === 'dispose') {
            return (): Promise<void> => this.#access[Symbol.asyncDispose]();
          }
          if (property === 'abortAll') {
            return (): Promise<void> => this.#access.cancelAllSessions('TUI shutdown requested.');
          }
          if (property === 'cancelRuntimeOperations') {
            return async (sessionId: string): Promise<void> => {
              await this.#access.cancelSession(sessionId, 'Session operation cancelled.');
              await this.#access.waitForSessionIdle(sessionId);
            };
          }
          if (property === 'registerSession') {
            return (sessionId: string, workspace: string): object => {
              const runtime = target.registerSession(sessionId, workspace);
              void this.#access.command({
                schema: RUNTIME_COMMAND_SCHEMA_V1,
                commandId: this.#nextCommandId(sessionId, 'resume'),
                type: 'resume_session',
                sessionId,
              });
              return this.#runtimeClient(runtime);
            };
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
          if (property === 'removeRuntime') {
            return async (sessionId: string): Promise<void> => {
              const authority = this.#sessions.get(sessionId);
              if (authority) {
                const receipt = await this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_V1,
                  commandId: this.#nextCommandId(sessionId, 'close'),
                  type: 'close_session',
                  sessionId,
                  expectedRevision: authority.revision,
                });
                this.#assertApplied(receipt);
                await this.#access.waitForSessionIdle(sessionId);
              }
              await target.releaseRuntimeSessionCoordinator(sessionId);
              target.removeRuntimeAfterHostClose(sessionId);
              this.#runtimeClients.delete(sessionId);
            };
          }
          if (property === 'handleContextCompaction') {
            return async (
              sessionId: string,
              instructions?: string,
              onProgress?: ContextCompactionProgress,
              onCommand?: ContextCompactionCommand,
            ): Promise<ContextCompactionResult | undefined> => {
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
                  schema: RUNTIME_COMMAND_SCHEMA_V1,
                  commandId,
                  type: 'compact_session',
                  sessionId,
                  expectedRevision: this.#revision(sessionId),
                  mode: 'manual',
                  instructions,
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
              const commandId = this.#nextCommandId(sessionId, 'reset');
              const pending: PendingCompaction = { ...createDeferred() };
              this.#pendingCompactions.set(commandId, pending);
              try {
                const receipt = await this.#access.command({
                  schema: RUNTIME_COMMAND_SCHEMA_V1,
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
              const commandId = this.#nextCommandId(input.sourceThreadId, 'rewind');
              const pending: PendingRewind = { workspace: input.workspace };
              this.#pendingRewinds.set(commandId, pending);
              const receipt = await this.#access.command({
                schema: RUNTIME_COMMAND_SCHEMA_V1,
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
              this.#pendingRewinds.delete(commandId);
              this.#assertApplied(receipt);
              return pending.result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        })();
        if (typeof member === 'function') this.#managerMembers.set(property, member);
        return member;
      },
    });
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
                schema: RUNTIME_COMMAND_SCHEMA_V1,
                commandId,
                type: 'start_turn',
                sessionId: target.threadId,
                expectedRevision: this.#revision(target.threadId),
                input: task,
                phase: requestedPhase,
                initialSkills,
              });
              this.#assertApplied(receipt);
              await pending.completion;
            } finally {
              this.#pendingRuns.delete(commandId);
            }
          };
        }
        if (property === 'waitForRunCompletion') {
          return (): Promise<void> => this.#access.waitForSessionIdle(target.threadId);
        }
        if (property === 'abort') {
          return (): void => {
            void this.#access.command({
              schema: RUNTIME_COMMAND_SCHEMA_V1,
              commandId: this.#nextCommandId(target.threadId, 'cancel'),
              type: 'cancel_turn',
              sessionId: target.threadId,
              expectedRevision: this.#revision(target.threadId),
              turnId: target.threadId,
            });
          };
        }
        if (property === 'setInteractionMode') {
          return (mode: 'accept_edits' | 'auto' | 'full'): void => {
            void this.#access.command({
              schema: RUNTIME_COMMAND_SCHEMA_V1,
              commandId: this.#nextCommandId(target.threadId, 'mode'),
              type: 'set_interaction_mode',
              sessionId: target.threadId,
              expectedRevision: this.#revision(target.threadId),
              mode,
            });
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

  #publishPresentation(
    sessionId: string,
    event: RuntimeEvent,
    publish: (notification: RuntimeNotification) => void,
  ): void {
    const authority = this.#sessions.get(sessionId);
    if (!authority) return;
    const sequence = (this.#streamSequences.get(sessionId) ?? 0) + 1;
    const workId = authority.activeWork?.workId ?? sessionId;
    const turnId = authority.activeWork?.activeTurn?.turnId ?? workId;
    const ephemeral = projectRuntimeEphemeralNotificationV1(event, {
      sessionId,
      workId,
      turnId,
      actorId: 'legacy-agent',
      attemptId: workId,
      streamId: workId,
      sequence,
    });
    if (ephemeral) {
      this.#streamSequences.set(sessionId, sequence);
      publish(ephemeral);
      return;
    }
    authority.revision += 1;
    publish({
      ...this.#notification(sessionId, 'turn'),
      projection: {
        kind: 'turn',
        session: this.#projection(sessionId),
        presentation: event as ClientPresentationEvent,
      },
    });
  }

  #notification(
    sessionId: string,
    kind: 'snapshot' | 'session' | 'work' | 'turn' | 'interaction' | 'evidence',
  ): Extract<RuntimeNotification, { durability: 'durable' }> {
    const projection = this.#projection(sessionId);
    return {
      schema: RUNTIME_NOTIFICATION_SCHEMA_V1,
      durability: 'durable',
      sessionId,
      revision: projection.revision,
      projection: { kind, session: projection },
    };
  }

  #projection(sessionId: string): RuntimeSessionProjection {
    const authority = this.#sessions.get(sessionId);
    if (!authority) throw new Error(`Unknown legacy TUI session: ${sessionId}`);
    const runtime = this.#manager.getRuntime(sessionId);
    return {
      schema: RUNTIME_PROJECTION_SCHEMA_V1,
      sessionId,
      revision: authority.revision,
      displayName: runtime?.name,
      workspace: authority.workspace,
      lifecycle: authority.lifecycle,
      activeWork: authority.activeWork,
    };
  }

  #revision(sessionId: string): number {
    return this.#sessions.get(sessionId)?.revision ?? 0;
  }

  #nextCommandId(sessionId: string, operation: string): string {
    this.#commandSequence += 1;
    return `tui:${sessionId}:${operation}:${this.#commandSequence}`;
  }

  #applied(
    command: RuntimeCommand,
    sessionId: string,
  ): Extract<RuntimeCommandReceipt, { readonly status: 'applied' }> {
    return {
      status: 'applied',
      commandId: command.commandId,
      sessionId,
      revision: this.#revision(sessionId),
    };
  }

  #reject(command: RuntimeCommand, code: RuntimeCommandErrorCode): RuntimeCommandReceipt {
    return {
      status: 'rejected',
      commandId: command.commandId,
      code,
      currentRevision:
        'sessionId' in command ? this.#sessions.get(command.sessionId)?.revision : undefined,
    };
  }

  #notFound(command: RuntimeCommand): RuntimeCommandReceipt {
    return {
      status: 'not_found',
      commandId: command.commandId,
      code: 'session_not_found',
    };
  }

  #assertApplied(receipt: RuntimeCommandReceipt): void {
    if (receipt.status === 'applied' || receipt.status === 'idempotent_replay') return;
    throw new Error(`Legacy TUI Runtime command rejected: ${receipt.code}`);
  }
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

function abortError(reason: string): Error {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}
