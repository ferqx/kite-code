import { authorizeEffect } from '@kite-ai/agent-kernel';
import {
  assertRuntimeCommand,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccess,
  type RuntimeCommand,
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
  type RuntimeHostExecutionAdapterContext,
  type RuntimeHostExecutionBridge,
  type RuntimeHostPreparedExecution,
} from '../execution/execution-bridge';
import {
  runtimeCommandSessionId,
  translateRuntimeCommandToKernelInput,
} from '../kernel-adapter/input';
import { EffectSupervisor } from '../lifecycle/effect-supervisor';
import { SessionLifecycleSupervisor } from '../lifecycle/session-lifecycle-supervisor';
import type { RuntimeStorage } from '../storage';
import { NotificationProjector } from './notification-projector';
import { SessionRegistry } from './session-registry';

/**
 * Narrow command/query/lifecycle authority exposed to App clients.
 * Storage, registry snapshots, and composition mechanisms remain bootstrap-only.
 */
export interface RuntimeHostCoordinatorPort extends RuntimeAccess, AsyncDisposable {
  cancelSession(sessionId: string, reason?: string): Promise<void>;
  cancelAllSessions(reason?: string): Promise<void>;
  waitForSessionIdle(sessionId: string): Promise<void>;
  isSessionOperationActive(sessionId: string): boolean;
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
  readonly #receipts = new Map<string, RuntimeCommandReceipt>();
  readonly #pendingReceipts = new Map<string, Promise<RuntimeCommandReceipt>>();
  readonly #commandSignatures = new Map<string, string>();
  readonly #recoveredSessions = new Set<string>();
  readonly #activeAccesses = new Set<Promise<unknown>>();
  #startPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #closing = false;
  #disposed = false;

  constructor(input: {
    readonly storage: RuntimeStorage<Event, State>;
    readonly moduleRegistry: RuntimeModuleRegistry;
    readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
    readonly contextCompiler?: ContextCompilerPort;
  }) {
    this.storage = input.storage;
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

  command(command: RuntimeCommand): Promise<RuntimeCommandReceipt> {
    return this.#beginAccess(() => this.#executeCommand(command));
  }

  async #executeCommand(command: RuntimeCommand): Promise<RuntimeCommandReceipt> {
    assertRuntimeCommand(command);
    await this.start();

    const identity = commandIdentity(command);
    const signature = stableSerialize(command);
    const recordedSignature = this.#commandSignatures.get(identity);
    if (recordedSignature !== undefined && recordedSignature !== signature) {
      return {
        status: 'rejected',
        commandId: command.commandId,
        code: 'invalid_command',
      };
    }
    const prior = this.#receipts.get(identity);
    if (prior) return replayReceipt(prior);
    const pending = this.#pendingReceipts.get(identity);
    if (pending) return replayReceipt(await pending);
    this.#commandSignatures.set(identity, signature);

    const mailbox = this.#registry.mailbox(runtimeCommandSessionId(command));
    const execution = mailbox.run(async () => {
      const queuedPrior = this.#receipts.get(identity);
      if (queuedPrior) return replayReceipt(queuedPrior);

      const conflict = await this.#revisionConflict(command);
      if (conflict) {
        this.#receipts.set(identity, conflict);
        return conflict;
      }

      if (
        (command.type === 'start_turn' || command.type === 'compact_session') &&
        !this.#lifecycle.canSchedule(command.sessionId)
      ) {
        const busy: RuntimeCommandReceipt = {
          status: 'rejected',
          commandId: command.commandId,
          code: 'runtime_busy',
          currentRevision: this.#registry.projection(command.sessionId)?.revision,
        };
        this.#receipts.set(identity, busy);
        return busy;
      }

      if (
        command.type === 'resume_session' ||
        command.type === 'start_turn' ||
        command.type === 'compact_session'
      ) {
        await this.#recoverSession(command.sessionId);
      }

      const prepared = await this.#bridge.prepare(
        translateRuntimeCommandToKernelInput(command),
        (notification) => {
          this.#notifications.publish(notification);
        },
      );
      const receipt = prepared.receipt;
      const authorizedEffect = prepared.execution
        ? authorizePreparedExecution(command, receipt, prepared.execution)
        : undefined;
      this.#receipts.set(identity, receipt);
      await this.#refreshReceiptSession(receipt);
      if (receipt.status === 'applied') {
        if (prepared.execution) {
          if (!authorizedEffect) {
            throw new Error('Runtime Host prepared execution authorization is unavailable.');
          }
          const run = createSingleUsePreparedDispatch(prepared.execution.run, authorizedEffect);
          const scheduled = this.#lifecycle.schedule(receipt.sessionId, {
            operationId: command.commandId,
            operation: prepared.execution.operation,
            execute: run,
            onSkipped: prepared.execution.cancel,
          });
          if (!scheduled) {
            throw new Error(
              `Runtime session operation could not be scheduled: ${receipt.sessionId}`,
            );
          }
        }
        if (command.type === 'cancel_turn') {
          this.#lifecycle.abort(receipt.sessionId, 'Runtime turn cancelled.');
        } else if (command.type === 'close_session') {
          this.#lifecycle.close(receipt.sessionId, 'Runtime session closed.');
        }
      }
      return receipt;
    });
    this.#pendingReceipts.set(identity, execution);
    try {
      return await execution;
    } finally {
      this.#pendingReceipts.delete(identity);
      if (!this.#receipts.has(identity)) this.#commandSignatures.delete(identity);
    }
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
    const result = await this.#bridge.query(query);
    this.#commitQueryProjection(result);
    return result;
  }

  subscribe(subscription: RuntimeSubscription) {
    this.#assertOpen();
    return this.#notifications.subscribe(subscription);
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
    await Promise.all([...sessionIds].map((sessionId) => this.#cancelSession(sessionId, reason)));
  }

  waitForSessionIdle(sessionId: string): Promise<void> {
    return this.#lifecycle.waitForIdle(sessionId);
  }

  isSessionOperationActive(sessionId: string): boolean {
    return this.#lifecycle.isActive(sessionId);
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
      this.#registry.commitProjection(projection);
      await this.#recoverSession(projection.sessionId);
    }
  }

  async #recoverSession(sessionId: string): Promise<void> {
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
    if (result.session) this.#registry.commitProjection(result.session);
    for (const projection of result.sessions ?? []) this.#registry.commitProjection(projection);
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
    command.type === 'start_turn'
      ? 'turn'
      : command.type === 'compact_session'
        ? 'compaction'
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
    'prepare',
    'query',
    'shutdownSession',
    'close',
  ] as const) {
    if (typeof bridge[method] !== 'function') {
      throw new Error(`Runtime Host execution adapter bridge is missing ${method}`);
    }
  }
}

function commandIdentity(command: RuntimeCommand): string {
  return `${runtimeCommandSessionId(command)}\u0000${command.commandId}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function replayReceipt(receipt: RuntimeCommandReceipt): RuntimeCommandReceipt {
  if (receipt.status !== 'applied') return receipt;
  return {
    status: 'idempotent_replay',
    commandId: receipt.commandId,
    sessionId: receipt.sessionId,
    originalRevision: receipt.revision,
  };
}
