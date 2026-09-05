import { createHash } from 'node:crypto';
import { authorizeEffect } from '@kite-ai/agent-kernel';
import {
  assertRuntimeCommand,
  freezeRuntimeCommandContext,
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccess,
  type RuntimeCommand,
  type RuntimeCommandContext,
  type RuntimeCommandReceipt,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
  type RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import type {
  CapabilityDefinition,
  CapabilityRegistrySnapshot,
  ContextCompilerPort,
  RuntimeModuleRegistry,
} from '@kite-ai/runtime-spi';
import { createRuntimeHostCapabilityExecutionPortFromSnapshot } from '../execution/capability-execution';
import {
  createRuntimeHostContextCompilationPortFromSnapshot,
  type RuntimeHostContextCompilationPort,
} from '../execution/context-compilation';
import {
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
  type RuntimeHostCommandInspection,
  type RuntimeHostExecutionAdapterContext,
  type RuntimeHostExecutionBridge,
  type RuntimeHostPreparedExecution,
} from '../execution/execution-bridge';
import { runtimeCommandSessionId } from '../kernel-adapter/input';
import { EffectSupervisor } from '../lifecycle/effect-supervisor';
import { SessionLifecycleSupervisor } from '../lifecycle/session-lifecycle-supervisor';
import {
  createRuntimeStoredCommandReceipt,
  type RuntimeRunPage,
  type RuntimeRunStorePort,
  type RuntimeStorage,
  type RuntimeStoredCommandReceipt,
  type RuntimeStoredRun,
} from '../storage';
import {
  createRuntimeCommandCommitEvidence,
  parseRuntimeStoredCommandReceipt,
  resolveRuntimeCommandReceipt,
} from './command-receipt';
import { NotificationProjector } from './notification-projector';
import { parseRuntimeStoredCommandResource, projectRuntimeStoredRun } from './run-projection';
import { SessionRegistry } from './session-registry';

/**
 * Narrow command/query/lifecycle authority exposed to App clients.
 * Storage, registry snapshots, and composition mechanisms remain bootstrap-only.
 */
export interface RuntimeHostCoordinatorPort extends RuntimeAccess, AsyncDisposable {
  cancelSession(sessionId: string, reason?: string): Promise<void>;
  cancelAllSessions(reason?: string): Promise<void>;
  /** App-only local projection tombstone; it never deletes Store state or cancels work. */
  removeSessionProjection(sessionId: string): boolean;
  waitForSessionIdle(sessionId: string): Promise<void>;
  isSessionOperationActive(sessionId: string): boolean;
  /** Service lifecycle reads this aggregate after mutation admission is quiesced. */
  hasActiveSessionOperations(): boolean;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Bootstrap-only concrete Host composition surface. */
export interface RuntimeHost<Event = unknown, State = unknown> extends RuntimeHostCoordinatorPort {
  readonly storage: RuntimeStorage<Event, State>;
  readonly contractRevision: 'runtime-contract-current';
  readonly deterministicKernel: true;
  readonly moduleIds: readonly string[];
  /** The single frozen registry view shared with Host capability execution. */
  readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
  readonly contextCompilation: RuntimeHostContextCompilationPort;
  start(): Promise<void>;
}

export class DefaultRuntimeHost<Event = unknown, State = unknown>
  implements RuntimeHost<Event, State>
{
  readonly storage: RuntimeStorage<Event, State>;
  readonly contractRevision = 'runtime-contract-current' as const;
  readonly deterministicKernel = true as const;
  readonly moduleIds: readonly string[];
  readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
  readonly contextCompilation: RuntimeHostContextCompilationPort;
  readonly #bridge: RuntimeHostExecutionBridge;
  readonly #moduleRegistry: RuntimeModuleRegistry;
  readonly #registry = new SessionRegistry();
  readonly #notifications = new NotificationProjector(this.#registry);
  readonly #lifecycle = new SessionLifecycleSupervisor();
  readonly #pendingCommands = new Map<
    string,
    { readonly digest: string; readonly promise: Promise<RuntimeCommandReceipt> }
  >();
  readonly #recoveredSessions = new Set<string>();
  /** Durable deletion tombstones prevent bridge queries from rehydrating State. */
  readonly #deletedSessions = new Set<string>();
  readonly #activeAccesses = new Set<Promise<unknown>>();
  readonly #ownsSessionExecution: (sessionId: string) => boolean;
  readonly #runWithSessionExecution?: <Result>(
    sessionId: string,
    operation: () => Result,
  ) => Result;
  #startPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #closing = false;
  #disposed = false;

  constructor(input: {
    readonly storage: RuntimeStorage<Event, State>;
    readonly moduleRegistry: RuntimeModuleRegistry;
    readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
    readonly contextCompiler?: ContextCompilerPort;
    readonly ownsSessionExecution?: (sessionId: string) => boolean;
    readonly runWithSessionExecution?: <Result>(
      sessionId: string,
      operation: () => Result,
    ) => Result;
  }) {
    this.storage = input.storage;
    this.#ownsSessionExecution = input.ownsSessionExecution ?? (() => true);
    this.#runWithSessionExecution = input.runWithSessionExecution;
    this.#moduleRegistry = input.moduleRegistry;
    this.moduleIds = input.moduleRegistry.moduleIds;
    assertRuntimeHostRegistrySnapshot(input.moduleRegistry, input.capabilityRegistrySnapshot);
    this.capabilityRegistrySnapshot = input.capabilityRegistrySnapshot;
    this.contextCompilation = input.contextCompiler
      ? createRuntimeHostContextCompilationPortFromSnapshot(
          input.moduleRegistry,
          input.contextCompiler,
          this.capabilityRegistrySnapshot,
        )
      : Object.freeze({
          compile: () => Promise.reject(new Error('Runtime Context Compiler is unavailable.')),
        });
    const services = new EffectSupervisor(input.storage, Date.now, (sessionId) => {
      this.#lifecycle.abort(sessionId, 'Runtime effect lease was lost.');
    }).services;
    const capabilities = createRuntimeHostCapabilityExecutionPortFromSnapshot(
      this.capabilityRegistrySnapshot,
    );
    const adapter = input.moduleRegistry.requireExecutionAdapter<
      RuntimeHostExecutionAdapterContext<Event, State>,
      RuntimeHostExecutionBridge
    >(RUNTIME_HOST_EXECUTION_ADAPTER_ID_);
    this.#bridge = adapter.create(
      Object.freeze({
        services,
        capabilities,
        capabilityRegistrySnapshot: this.capabilityRegistrySnapshot,
      }) satisfies RuntimeHostExecutionAdapterContext<Event, State>,
    );
    assertRuntimeHostExecutionBridge(this.#bridge);
  }

  start(): Promise<void> {
    this.#assertOpen();
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  command(
    command: RuntimeCommand,
    context?: Readonly<RuntimeCommandContext>,
  ): Promise<RuntimeCommandReceipt> {
    const execute = () => this.#beginAccess(() => this.#executeCommand(command, context));
    return command.type === 'create_session'
      ? execute()
      : this.#withSessionExecution(runtimeCommandSessionId(command), execute);
  }

  async #executeCommand(
    command: RuntimeCommand,
    context?: Readonly<RuntimeCommandContext>,
  ): Promise<RuntimeCommandReceipt> {
    assertRuntimeCommand(command);
    const pinnedContext = context === undefined ? undefined : freezeRuntimeCommandContext(context);
    await this.start();
    const evidence = createRuntimeCommandCommitEvidence({
      command,
      targetSessionId: targetSessionIdFor(command),
      committedAt: Date.now(),
    });
    const persisted = this.#lookupCommandReceipt(command, evidence.requestDigest);
    if (persisted) return this.#replayAfterLookup(command, persisted);

    const identity = `${evidence.scopeSessionId}\u0000${command.commandId}`;
    const pending = this.#pendingCommands.get(identity);
    if (pending) {
      if (pending.digest !== evidence.requestDigest) return invalidCommand(command.commandId);
      const settled = await pending.promise;
      const replay = this.#lookupCommandReceipt(command, evidence.requestDigest);
      return replay ? this.#replayAfterLookup(command, replay) : settled;
    }

    const mailbox = this.#registry.mailbox(evidence.scopeSessionId);
    const execution = mailbox.run(async () => {
      const queued = this.#lookupCommandReceipt(command, evidence.requestDigest);
      if (queued) return this.#replayAfterLookup(command, queued);

      if (isDeletedSessionCommand(command, this.#deletedSessions)) {
        return {
          status: 'not_found',
          commandId: command.commandId,
          code: 'session_not_found',
        } satisfies RuntimeCommandReceipt;
      }

      const conflict = await this.#revisionConflict(command);
      if (conflict) return conflict;
      if (command.type === 'delete_session') return this.#deleteSession(command, evidence);
      const allowQueuedSuccessor =
        command.type === 'start_turn' &&
        isTerminalRunProjection(this.#registry.projection(command.sessionId));
      if (
        (command.type === 'start_turn' || command.type === 'compact_session') &&
        !this.#lifecycle.canSchedule(command.sessionId) &&
        !allowQueuedSuccessor
      ) {
        return {
          status: 'rejected',
          commandId: command.commandId,
          code: 'runtime_busy',
          currentRevision: this.#registry.projection(command.sessionId)?.revision,
        } satisfies RuntimeCommandReceipt;
      }
      if (
        command.type === 'resume_session' ||
        command.type === 'start_turn' ||
        command.type === 'compact_session'
      ) {
        await this.#recoverSession(command.sessionId);
      }

      const inspected = await this.#inspectCommand(
        command,
        targetSessionIdFor(command),
        pinnedContext,
      );
      if (inspected.kind === 'terminal') return assertTerminalReceipt(command, inspected);
      const expectedTarget = targetSessionIdFor(command);
      if (inspected.decision.targetSessionId !== expectedTarget) {
        throw new Error('Runtime Host inspected command target identity is invalid.');
      }
      const committed = await inspected.decision.commit(
        Object.freeze({ ...evidence, targetSessionId: expectedTarget }),
      );
      assertAppliedReceipt(command, committed.receipt, expectedTarget);
      const stored = this.#lookupStoredReceipt(command, evidence.requestDigest);
      if (!stored) throw new Error('Runtime Host command receipt was not persisted by commit.');
      const durable = parseRuntimeStoredCommandReceipt(stored);
      if (!sameAppliedReceipt(durable, committed.receipt)) {
        throw new Error('Runtime Host persisted command receipt does not match commit result.');
      }

      await committed.activation?.((notification) => this.#notifications.publish(notification));
      await this.#refreshReceiptSession(committed.receipt);
      const prepared = committed.preparedExecution;
      if (prepared?.execution)
        this.#schedulePreparedExecution(command, committed.receipt, prepared, allowQueuedSuccessor);
      if (command.type === 'cancel_turn') {
        this.#lifecycle.abort(committed.receipt.sessionId, 'Runtime turn cancelled.');
      } else if (command.type === 'close_session') {
        this.#lifecycle.close(committed.receipt.sessionId, 'Runtime session closed.');
      }
      return receiptFromStoredReceipt(stored);
    });
    this.#pendingCommands.set(identity, { digest: evidence.requestDigest, promise: execution });
    try {
      return await execution;
    } finally {
      if (this.#pendingCommands.get(identity)?.promise === execution) {
        this.#pendingCommands.delete(identity);
      }
    }
  }

  #lookupStoredReceipt(
    command: RuntimeCommand,
    requestDigest: string,
  ): RuntimeStoredCommandReceipt | undefined {
    const lookup = this.storage.commandReceipts.lookup({
      scopeSessionId: runtimeCommandSessionId(command),
      commandId: command.commandId,
      requestDigest,
    });
    return lookup.status === 'missing' ? undefined : lookup.receipt;
  }

  #lookupCommandReceipt(
    command: RuntimeCommand,
    requestDigest: string,
  ): RuntimeCommandReceipt | undefined {
    const stored = this.#lookupStoredReceipt(command, requestDigest);
    return stored ? resolveRuntimeCommandReceipt(command, stored) : undefined;
  }

  async #replayAfterLookup(
    command: RuntimeCommand,
    receipt: RuntimeCommandReceipt,
  ): Promise<RuntimeCommandReceipt> {
    if (receipt.status !== 'idempotent_replay') {
      return receipt;
    }
    // A delete receipt intentionally outlives its target Session. Replaying it
    // must never call App recovery or recreate a snapshot/Runtime owner.
    if (command.type === 'delete_session' || command.type === 'start_turn') return receipt;
    await this.#recoverSession(receipt.sessionId);
    return receipt;
  }

  #deleteSession(
    command: Extract<RuntimeCommand, { readonly type: 'delete_session' }>,
    evidence: ReturnType<typeof createRuntimeCommandCommitEvidence>,
  ): RuntimeCommandReceipt {
    const projection = this.#registry.projection(command.sessionId);
    if (!projection) {
      return {
        status: 'not_found',
        commandId: command.commandId,
        code: 'session_not_found',
      };
    }
    if (this.#lifecycle.isActive(command.sessionId)) {
      return {
        status: 'rejected',
        commandId: command.commandId,
        code: 'runtime_busy',
        currentRevision: projection.revision,
      };
    }
    const receipt = createRuntimeStoredCommandReceipt(evidence, projection.revision);
    this.storage.sessions.deleteSession(command.sessionId, {
      expectedRevision: projection.revision,
      commandReceipt: receipt,
    });
    const stored = this.#lookupStoredReceipt(command, evidence.requestDigest);
    if (!stored) throw new Error('Runtime Host delete receipt was not persisted by commit.');
    const durable = parseRuntimeStoredCommandReceipt(stored);
    if (!sameAppliedReceipt(durable, receiptFromStoredReceipt(receipt))) {
      throw new Error('Runtime Host persisted delete receipt does not match commit result.');
    }
    this.#lifecycle.close(command.sessionId, 'Runtime session deleted.');
    this.#recoveredSessions.delete(command.sessionId);
    this.#deletedSessions.add(command.sessionId);
    this.#notifications.removeSession(command.sessionId);
    return receiptFromStoredReceipt(receipt);
  }

  async #inspectCommand(
    command: RuntimeCommand,
    targetSessionId: string,
    context?: Readonly<RuntimeCommandContext>,
  ): Promise<RuntimeHostCommandInspection> {
    return this.#bridge.inspectCommand(
      command,
      Object.freeze({
        targetSessionId,
        ...(context === undefined ? {} : { commandContext: context }),
      }),
    );
  }

  #schedulePreparedExecution(
    command: RuntimeCommand,
    receipt: Extract<RuntimeCommandReceipt, { readonly status: 'applied' }>,
    prepared: RuntimeHostPreparedExecution,
    allowQueuedSuccessor = false,
  ): void {
    const execution = prepared.execution;
    if (!execution) return;
    const authorizedEffect = authorizePreparedExecution(command, receipt, execution);
    const run = createSingleUsePreparedDispatch(execution.run, authorizedEffect);
    const scheduled = this.#lifecycle.schedule(receipt.sessionId, {
      operationId: command.commandId,
      operation: execution.operation,
      execute: run,
      onSkipped: execution.cancel,
      ...(allowQueuedSuccessor ? { allowQueuedSuccessor: true } : {}),
    });
    if (!scheduled) {
      throw new Error(`Runtime session operation could not be scheduled: ${receipt.sessionId}`);
    }
  }

  #withSessionExecution<Result>(sessionId: string, operation: () => Result): Result {
    return this.#runWithSessionExecution
      ? this.#runWithSessionExecution(sessionId, operation)
      : operation();
  }

  query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    return this.#beginAccess(() => this.#executeQuery(query));
  }

  async #executeQuery(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    await this.start();
    if (query.type === 'list_sessions') {
      return {
        status: 'ok',
        queryType: query.type,
        sessions: this.#registry.projections(),
      };
    }
    if (query.type === 'get_session_projection') {
      const projection =
        this.#registry.projection(query.sessionId) ?? (await this.#loadProjection(query.sessionId));
      return projection
        ? {
            status: 'ok',
            queryType: query.type,
            revision: projection.revision,
            session: projection,
          }
        : {
            status: 'not_found',
            queryType: query.type,
            code: 'session_not_found',
          };
    }
    if (query.type === 'get_run' || query.type === 'list_runs') {
      const runs = this.storage.runs;
      if (!runs) {
        return {
          status: 'unavailable',
          queryType: query.type,
          code: 'unsupported',
        };
      }
      if (!this.storage.sessions.loadSnapshotRecord(query.sessionId)) {
        return {
          status: 'not_found',
          queryType: query.type,
          code: 'session_not_found',
        };
      }
      if (query.type === 'get_run') {
        const run = runs.get(query.sessionId, query.runId);
        return run
          ? {
              status: 'ok',
              queryType: query.type,
              revision: run.lastRevision,
              run: projectRuntimeStoredRun(run, {
                recoveryRequired: !this.#recoveredSessions.has(query.sessionId),
              }),
            }
          : {
              status: 'not_found',
              queryType: query.type,
              code: 'run_not_found',
            };
      }
      const recoveryRequired = !this.#recoveredSessions.has(query.sessionId);
      const page =
        recoveryRequired && query.status === 'unknown'
          ? listRecoveryRequiredUnknownRuns(runs, query)
          : runs.list({
              sessionId: query.sessionId,
              limit: query.limit,
              ...(query.status === undefined ? {} : { status: query.status }),
              ...(query.phase === undefined ? {} : { phase: query.phase }),
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            });
      return {
        status: 'ok',
        queryType: query.type,
        runs: page.entries
          .map((run) =>
            projectRuntimeStoredRun(run, {
              recoveryRequired,
            }),
          )
          .filter((run) => query.status === undefined || run.status === query.status),
        ...(page.nextCursor === undefined ? {} : { nextRunCursor: page.nextCursor }),
      };
    }
    const result = await this.#bridge.query(query);
    this.#commitQueryProjection(result);
    return result;
  }

  subscribe(subscription: RuntimeSubscription) {
    this.#assertOpen();
    // Register the subscriber before hydrating a Session that may have been
    // admitted through an external Store owner. The query path can be
    // read-only/direct in that composition, so relying on its return value to
    // seed this Host's local projector would otherwise leave the subscriber
    // waiting forever for the initial durable snapshot.
    const iterable = this.#notifications.subscribe(subscription);
    if (
      subscription.spec.scope === 'session' &&
      this.#registry.projection(subscription.spec.sessionId) === undefined
    ) {
      void this.#loadProjection(subscription.spec.sessionId).catch(() => undefined);
    }
    return iterable;
  }

  removeSessionProjection(sessionId: string): boolean {
    this.#assertOpen();
    return this.#notifications.removeSession(sessionId);
  }

  cancelSession(sessionId: string, reason = 'Runtime Host shutdown.'): Promise<void> {
    return this.#beginAccess(() => this.#cancelSession(sessionId, reason));
  }

  async #cancelSession(sessionId: string, reason: string): Promise<void> {
    await this.#bridge.shutdownSession(sessionId, reason, (notification) => {
      this.#notifications.publish(notification);
    });
    this.#lifecycle.abort(sessionId, reason);
  }

  cancelAllSessions(reason = 'Runtime Host shutdown.'): Promise<void> {
    return this.#beginAccess(() => this.#cancelAllSessions(reason));
  }

  async #cancelAllSessions(reason: string): Promise<void> {
    const sessionIds = new Set([
      ...this.#lifecycle.sessionIds(),
      ...this.#registry.projections().map((projection) => projection.sessionId),
    ]);
    await Promise.all(
      [...sessionIds]
        .filter((sessionId) => this.#ownsSessionExecution(sessionId))
        .map((sessionId) => this.#cancelSession(sessionId, reason)),
    );
  }

  waitForSessionIdle(sessionId: string): Promise<void> {
    return this.#lifecycle.waitForIdle(sessionId);
  }

  isSessionOperationActive(sessionId: string): boolean {
    return this.#lifecycle.isActive(sessionId);
  }

  hasActiveSessionOperations(): boolean {
    return this.#lifecycle.sessionIds().some((sessionId) => this.#lifecycle.isActive(sessionId));
  }

  [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#closing = true;
    this.#disposePromise = this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    if (this.#startPromise) await Promise.allSettled([this.#startPromise]);
    await Promise.allSettled([...this.#activeAccesses]);
    const sessionIds = new Set([
      ...this.#lifecycle.sessionIds(),
      ...this.#registry.projections().map((projection) => projection.sessionId),
    ]);
    for (const sessionId of [...sessionIds]) {
      if (!this.#ownsSessionExecution(sessionId)) sessionIds.delete(sessionId);
    }
    const failures: unknown[] = [];
    for (const sessionId of sessionIds) {
      try {
        await this.#bridge.shutdownSession(sessionId, 'Runtime Host disposed.', (notification) => {
          this.#notifications.publish(notification);
        });
      } catch (error) {
        failures.push(error);
      }
    }
    for (const sessionId of sessionIds) this.#lifecycle.close(sessionId, 'Runtime Host disposed.');
    await Promise.all([...sessionIds].map((sessionId) => this.#lifecycle.waitForIdle(sessionId)));
    try {
      await this.#bridge.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#moduleRegistry.dispose();
    } catch (error) {
      failures.push(error);
    }
    this.#disposed = true;
    this.#notifications.close();
    this.#registry.close();
    this.storage.close();
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime Host disposal failed');
  }

  #trackAccess<T>(access: Promise<T>): Promise<T> {
    this.#activeAccesses.add(access);
    void access.then(
      () => this.#activeAccesses.delete(access),
      () => this.#activeAccesses.delete(access),
    );
    return access;
  }

  #beginAccess<T>(create: () => Promise<T>): Promise<T> {
    try {
      this.#assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#trackAccess(create());
  }

  async #start(): Promise<void> {
    await this.#moduleRegistry.start();
    await this.#hydrateSessions();
  }

  async #hydrateSessions(): Promise<void> {
    const result = await this.#bridge.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'list_sessions',
    });
    if (result.status !== 'ok') return;
    for (const projection of result.sessions ?? []) {
      if (this.#ownsSessionExecution(projection.sessionId)) {
        this.#registry.commitProjection(projection);
      }
    }
  }

  async #recoverSession(sessionId: string): Promise<void> {
    if (this.#deletedSessions.has(sessionId)) return;
    if (this.#recoveredSessions.has(sessionId)) return;
    await this.#bridge.recoverSession(sessionId, (notification) => {
      this.#notifications.publish(notification);
    });
    this.#recoveredSessions.add(sessionId);
  }

  async #revisionConflict(command: RuntimeCommand): Promise<RuntimeCommandReceipt | undefined> {
    let expected: number;
    let sessionId: string;
    if (command.type === 'fork_session') {
      expected = command.sourceRevision;
      sessionId = command.sourceSessionId;
    } else if ('expectedRevision' in command) {
      expected = command.expectedRevision;
      sessionId = command.sessionId;
    } else {
      return undefined;
    }
    const projection =
      this.#registry.projection(sessionId) ?? (await this.#loadProjection(sessionId));
    if (!projection || projection.revision === expected) return undefined;
    return {
      status: 'conflict',
      commandId: command.commandId,
      code: 'revision_conflict',
      currentRevision: projection.revision,
    };
  }

  async #refreshReceiptSession(receipt: RuntimeCommandReceipt): Promise<void> {
    if (receipt.status !== 'applied') return;
    await this.#loadProjection(receipt.sessionId);
  }

  async #loadProjection(sessionId: string): Promise<RuntimeSessionProjection | undefined> {
    if (this.#deletedSessions.has(sessionId)) return undefined;
    const result = await this.#bridge.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    this.#commitQueryProjection(result);
    return result.status === 'ok' ? result.session : undefined;
  }

  #commitQueryProjection(result: RuntimeQueryResult): void {
    if (result.status !== 'ok') return;
    const publish = (projection: RuntimeSessionProjection): void => {
      // Query hydration is an observer projection, not execution ownership.
      // A Host must seed an explicitly subscribed historical Session even
      // when another generation (or no live generation) owns its mutations.
      // Command admission continues to enforce #ownsSessionExecution.
      this.#notifications.publish({
        schema: RUNTIME_NOTIFICATION_SCHEMA_,
        durability: 'durable',
        sessionId: projection.sessionId,
        revision: projection.revision,
        projection: { kind: 'snapshot', session: projection },
      });
    };
    if (result.session) publish(result.session);
    for (const projection of result.sessions ?? []) publish(projection);
  }

  #assertOpen(): void {
    if (this.#disposed || this.#closing) throw new Error('Runtime Host is disposed');
  }
}

function authorizePreparedExecution(
  command: RuntimeCommand,
  receipt: RuntimeCommandReceipt,
  execution: NonNullable<RuntimeHostPreparedExecution['execution']>,
) {
  if (receipt.status !== 'applied') {
    throw new Error('Runtime Host prepared execution requires an applied receipt.');
  }
  const expectedOperation =
    command.type === 'start_turn' || command.type === 'respond_interaction'
      ? 'turn'
      : command.type === 'compact_session'
        ? 'compaction'
        : command.type === 'rewind_session'
          ? 'rewind'
          : undefined;
  if (
    expectedOperation === undefined ||
    receipt.commandId !== command.commandId ||
    receipt.sessionId !== runtimeCommandSessionId(command) ||
    execution.sessionId !== receipt.sessionId ||
    execution.operationId !== command.commandId ||
    execution.committedRevision !== receipt.revision ||
    execution.operation !== expectedOperation
  ) {
    throw new Error(
      'Runtime Host prepared execution identity does not match the applied receipt and command.',
    );
  }
  return authorizeEffect({
    sessionId: receipt.sessionId,
    operationId: command.commandId,
    operation: expectedOperation,
    committedRevision: receipt.revision,
  });
}

function createSingleUsePreparedDispatch(
  run: NonNullable<RuntimeHostPreparedExecution['execution']>['run'],
  authorizedEffect: ReturnType<typeof authorizeEffect>,
): (signal: AbortSignal, requestAbort: (reason: string) => void) => Promise<void> {
  let started = false;
  return async (signal, requestAbort) => {
    if (started) throw new Error('Runtime Host prepared execution is single-use.');
    started = true;
    // Keep the identity token Host-owned. It is deliberately never passed to the bridge.
    if (!authorizedEffect.sessionId || !authorizedEffect.operationId) {
      throw new Error('Runtime Host prepared execution authorization is invalid.');
    }
    await run(signal, requestAbort);
  };
}

function assertRuntimeHostRegistrySnapshot(
  registry: RuntimeModuleRegistry,
  snapshot: CapabilityRegistrySnapshot,
): void {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !Object.isFrozen(snapshot) ||
    !Object.isFrozen(snapshot.modules) ||
    !Object.isFrozen(snapshot.capabilities) ||
    !Object.isFrozen(snapshot.contextSources)
  ) {
    throw new Error('Runtime Host requires a frozen capability registry snapshot.');
  }

  if (snapshot.modules.length !== registry.moduleIds.length) {
    throw new Error(
      'Runtime Host capability registry snapshot does not match its module registry.',
    );
  }
  for (const module of snapshot.modules) {
    if (!Object.isFrozen(module)) {
      throw new Error('Runtime Host requires frozen module snapshot entries.');
    }
  }
  const snapshotModules = new Map(snapshot.modules.map((module) => [module.moduleId, module]));
  if (snapshotModules.size !== snapshot.modules.length) {
    throw new Error('Runtime Host capability registry snapshot contains duplicate modules.');
  }
  for (const moduleId of registry.moduleIds) {
    const module = registry.get(moduleId);
    const snapshotModule = snapshotModules.get(moduleId);
    if (
      !module ||
      !snapshotModule ||
      snapshotModule.providerId !== module.manifest.providerId ||
      snapshotModule.revision !== module.manifest.revision
    ) {
      throw new Error(
        'Runtime Host capability registry snapshot does not match its module registry.',
      );
    }
  }

  const registryCapabilities = [...snapshot.capabilities];
  const snapshotCapabilityIds = new Set<string>();
  for (const entry of registryCapabilities) {
    if (
      !Object.isFrozen(entry) ||
      !Object.isFrozen(entry.definition) ||
      (entry.executor !== undefined && !Object.isFrozen(entry.executor))
    ) {
      throw new Error('Runtime Host requires frozen capability snapshot entries.');
    }
    const capabilityId = entry.definition.capabilityId;
    if (snapshotCapabilityIds.has(capabilityId)) {
      throw new Error('Runtime Host capability registry snapshot contains duplicate capabilities.');
    }
    snapshotCapabilityIds.add(capabilityId);
    if (registry.capability(capabilityId) !== entry.definition) {
      throw new Error(
        'Runtime Host capability registry snapshot does not match its capability registry.',
      );
    }
    const executor = registry.executor(capabilityId);
    if (executor !== entry.executor) {
      throw new Error(
        'Runtime Host capability registry snapshot does not match its executor registry.',
      );
    }
    if (executor && !isExecutorBoundToDefinition(entry.definition, executor)) {
      throw new Error(
        'Runtime Host capability registry snapshot contains an invalid executor binding.',
      );
    }
  }

  const registryContextSources = new Map(
    snapshot.contextSources.map((source) => [source.sourceId, source]),
  );
  if (registryContextSources.size !== snapshot.contextSources.length) {
    throw new Error(
      'Runtime Host capability registry snapshot contains duplicate context sources.',
    );
  }
  for (const source of snapshot.contextSources) {
    if (!Object.isFrozen(source)) {
      throw new Error('Runtime Host requires frozen context source snapshot entries.');
    }
    const registered = registry.contextSource(source.sourceId);
    if (
      !registered ||
      registered.providerId !== source.providerId ||
      registered.revision !== source.revision
    ) {
      throw new Error(
        'Runtime Host capability registry snapshot does not match its context registry.',
      );
    }
  }
}

function isExecutorBoundToDefinition(
  definition: CapabilityDefinition,
  executor: Readonly<{
    readonly providerId: string;
    readonly capabilityId: string;
    readonly capabilityRevision: string;
  }>,
): boolean {
  return (
    executor.providerId === definition.providerId &&
    executor.capabilityId === definition.capabilityId &&
    executor.capabilityRevision === definition.revision
  );
}

function assertRuntimeHostExecutionBridge(
  value: unknown,
): asserts value is RuntimeHostExecutionBridge {
  if (!value || typeof value !== 'object') {
    throw new Error('Runtime Host execution adapter returned an invalid bridge');
  }
  const bridge = value as Readonly<Record<string, unknown>>;
  for (const method of [
    'recoverSession',
    'inspectCommand',
    'query',
    'shutdownSession',
    'close',
  ] as const) {
    if (typeof bridge[method] !== 'function') {
      throw new Error(`Runtime Host execution adapter bridge is missing ${method}`);
    }
  }
}

function listRecoveryRequiredUnknownRuns(
  runs: RuntimeRunStorePort,
  query: Extract<RuntimeQuery, { readonly type: 'list_runs' }>,
): RuntimeRunPage {
  const stored = runs.list({
    sessionId: query.sessionId,
    status: 'unknown',
    limit: query.limit,
    ...(query.phase === undefined ? {} : { phase: query.phase }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });
  const active = runs.getActive(query.sessionId);
  const candidates: RuntimeStoredRun[] = [...stored.entries];
  if (
    active &&
    (query.phase === undefined || active.phase === query.phase) &&
    runIsAfterCursor(active, query.cursor)
  ) {
    candidates.push(active);
  }
  candidates.sort(
    (left, right) =>
      left.createdRevision - right.createdRevision ||
      compareSqliteBinaryText(left.runId, right.runId),
  );
  const entries = candidates.slice(0, query.limit);
  const hasMore = stored.hasMore || candidates.length > query.limit;
  const last = entries.at(-1);
  return {
    entries,
    hasMore,
    ...(hasMore && last
      ? { nextCursor: { createdRevision: last.createdRevision, runId: last.runId } }
      : {}),
  };
}

function runIsAfterCursor(
  run: RuntimeStoredRun,
  cursor: Extract<RuntimeQuery, { readonly type: 'list_runs' }>['cursor'],
): boolean {
  return (
    cursor === undefined ||
    run.createdRevision > cursor.createdRevision ||
    (run.createdRevision === cursor.createdRevision &&
      compareSqliteBinaryText(run.runId, cursor.runId) > 0)
  );
}

function compareSqliteBinaryText(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function targetSessionIdFor(command: RuntimeCommand): string {
  switch (command.type) {
    case 'create_session':
      return command.bootstrapSessionId ?? derivedTargetSessionId('create', command.commandId);
    case 'fork_session':
      return derivedTargetSessionId('fork', command.commandId);
    default:
      return runtimeCommandSessionId(command);
  }
}

function derivedTargetSessionId(domain: 'create' | 'fork', commandId: string): string {
  return `${domain}_${createHash('sha256')
    .update(`kite.runtime-host.target.v1\u0000${domain}\u0000${commandId}`)
    .digest('hex')}`;
}

function isDeletedSessionCommand(
  command: RuntimeCommand,
  deletedSessionIds: ReadonlySet<string>,
): boolean {
  if (command.type === 'create_session') {
    return (
      command.bootstrapSessionId !== undefined && deletedSessionIds.has(command.bootstrapSessionId)
    );
  }
  if ('sessionId' in command) return deletedSessionIds.has(command.sessionId);
  if (command.type === 'fork_session') return deletedSessionIds.has(command.sourceSessionId);
  return false;
}

function invalidCommand(commandId: string): RuntimeCommandReceipt {
  return { status: 'rejected', commandId, code: 'invalid_command' };
}

function assertTerminalReceipt(
  command: RuntimeCommand,
  inspection: Extract<RuntimeHostCommandInspection, { readonly kind: 'terminal' }>,
): RuntimeCommandReceipt {
  const receipt = inspection.receipt;
  if (receipt.status === 'idempotent_replay' || receipt.commandId !== command.commandId) {
    throw new Error('Runtime Host terminal inspection receipt is invalid.');
  }
  return receipt;
}

function assertAppliedReceipt(
  command: RuntimeCommand,
  receipt: Extract<RuntimeCommandReceipt, { readonly status: 'applied' }>,
  targetSessionId: string,
): void {
  if (
    receipt.commandId !== command.commandId ||
    receipt.sessionId !== targetSessionId ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 0
  ) {
    throw new Error('Runtime Host committed command receipt identity is invalid.');
  }
}

function sameAppliedReceipt(
  first: { readonly commandId: string; readonly sessionId: string; readonly revision: number },
  second: { readonly commandId: string; readonly sessionId: string; readonly revision: number },
): boolean {
  return (
    first.commandId === second.commandId &&
    first.sessionId === second.sessionId &&
    first.revision === second.revision
  );
}

function isTerminalRunProjection(projection: RuntimeSessionProjection | undefined): boolean {
  const status = projection?.currentRun?.status;
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function receiptFromStoredReceipt(
  receipt: RuntimeStoredCommandReceipt,
): Extract<RuntimeCommandReceipt, { readonly status: 'applied' }> {
  const resource = parseRuntimeStoredCommandResource(receipt.resourceResult, receipt.commandId);
  return {
    status: 'applied',
    commandId: receipt.commandId,
    sessionId: receipt.targetSessionId,
    revision: receipt.committedRevision,
    ...(resource === undefined ? {} : { resource }),
  };
}
