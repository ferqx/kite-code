import {
  CAPABILITY_EXECUTION_MECHANISMS_,
  type CapabilityDescriptor,
  type CapabilityExecutionTraitsDeclaration,
  type CapabilityInternalDescriptor,
  type CapabilityParser,
  type RuntimeJsonValue,
} from './capability';
import type { CapabilityBinding, CapabilityExecutor } from './execution';
import type { ContextSource, RuntimeReceiptNormalizer } from './model';
import {
  type CapabilityDefinition,
  normalizeRuntimeIdentifier,
  type RuntimeExecutionAdapterRegistration,
  type RuntimeModule,
  type RuntimeModuleRegistryWriter,
} from './modules';

export interface CapabilityRegistrySnapshotEntry {
  readonly definition: CapabilityDefinition;
  readonly executor?: CapabilityExecutor;
}

export interface CapabilityRegistrySnapshot {
  readonly modules: readonly Readonly<{
    moduleId: string;
    providerId: string;
    revision: string;
  }>[];
  readonly capabilities: readonly CapabilityRegistrySnapshotEntry[];
  readonly contextSources: readonly Readonly<{
    sourceId: string;
    providerId: string;
    revision: string;
  }>[];
}

export type CapabilityArbitrationFailureCode =
  | 'binding_invalid'
  | 'capability_missing'
  | 'capability_revision_mismatch'
  | 'schema_digest_mismatch'
  | 'exposed_tool_name_mismatch'
  | 'executor_missing'
  | 'executor_binding_mismatch';

export type CapabilityBindingIdentityFailureCode =
  | 'binding_invalid'
  | 'capability_id_mismatch'
  | 'capability_revision_mismatch'
  | 'schema_digest_mismatch'
  | 'exposed_tool_name_mismatch';

export type CapabilityArbitrationResult =
  | {
      readonly status: 'resolved';
      readonly binding: CapabilityBinding;
      readonly definition: CapabilityDefinition;
      readonly executor: CapabilityExecutor;
    }
  | {
      readonly status: 'failed';
      readonly code: CapabilityArbitrationFailureCode;
    };

export type RuntimeModuleRegistryState =
  | 'registered'
  | 'starting'
  | 'started'
  | 'failed'
  | 'disposing'
  | 'disposed';

export interface RuntimeModuleRegistry extends AsyncDisposable {
  readonly size: number;
  readonly moduleIds: readonly string[];
  readonly state: RuntimeModuleRegistryState;
  get(moduleId: string): RuntimeModule | undefined;
  keys(): IterableIterator<string>;
  operationOwner(operationId: string): string | undefined;
  snapshot(): CapabilityRegistrySnapshot;
  capability(capabilityId: string): CapabilityDefinition | undefined;
  executor(capabilityId: string): CapabilityExecutor | undefined;
  contextSource(sourceId: string): ContextSource | undefined;
  receiptNormalizer(normalizerId: string): RuntimeReceiptNormalizer | undefined;
  executionAdapter<TContext, TAdapter>(
    adapterId: string,
  ): RuntimeExecutionAdapterRegistration<TContext, TAdapter> | undefined;
  requireExecutionAdapter<TContext, TAdapter>(
    adapterId: string,
  ): RuntimeExecutionAdapterRegistration<TContext, TAdapter>;
  start(): Promise<void>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface RuntimeModuleRegistryOptions {
  readonly lifecycleTimeoutMs?: number;
}

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 5_000;

export function createRuntimeModuleRegistry(
  modules: readonly RuntimeModule[],
  options: RuntimeModuleRegistryOptions = {},
): RuntimeModuleRegistry {
  return new FrozenRuntimeModuleRegistry(modules, options);
}

class FrozenRuntimeModuleRegistry implements RuntimeModuleRegistry {
  readonly #modules = new Map<string, RuntimeModule>();
  readonly #providers = new Map<string, string>();
  readonly #operationOwners = new Map<string, string>();
  readonly #capabilities = new Map<string, CapabilityDefinition>();
  readonly #executors = new Map<string, CapabilityExecutor>();
  readonly #contextSources = new Map<string, ContextSource>();
  readonly #normalizers = new Map<string, RuntimeReceiptNormalizer>();
  readonly #executionAdapters = new Map<
    string,
    RuntimeExecutionAdapterRegistration<unknown, unknown>
  >();
  readonly #moduleIds: readonly string[];
  readonly #lifecycleTimeoutMs: number;
  #state: RuntimeModuleRegistryState = 'registered';
  #startPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(modules: readonly RuntimeModule[], options: RuntimeModuleRegistryOptions) {
    const timeout = options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new Error('runtime module lifecycle timeout must be a positive integer');
    }
    this.#lifecycleTimeoutMs = timeout;
    for (const module of modules) this.#declareModule(module);
    for (const module of this.#modules.values()) {
      const writer = new ScopedRuntimeModuleRegistryWriter(this, module);
      try {
        module.register(writer);
      } finally {
        writer.seal();
      }
    }
    this.#validateExecutorBindings();
    this.#moduleIds = Object.freeze([...this.#modules.keys()]);
  }

  get size(): number {
    return this.#modules.size;
  }

  get moduleIds(): readonly string[] {
    return this.#moduleIds;
  }

  get state(): RuntimeModuleRegistryState {
    return this.#state;
  }

  get(moduleId: string): RuntimeModule | undefined {
    return this.#modules.get(moduleId);
  }

  keys(): IterableIterator<string> {
    return this.#modules.keys();
  }

  operationOwner(operationId: string): string | undefined {
    return this.#operationOwners.get(operationId);
  }

  snapshot(): CapabilityRegistrySnapshot {
    return Object.freeze({
      modules: Object.freeze(
        [...this.#modules.values()].map((module) =>
          Object.freeze({
            moduleId: module.manifest.moduleId,
            providerId: module.manifest.providerId,
            revision: module.manifest.revision,
          }),
        ),
      ),
      capabilities: Object.freeze(
        [...this.#capabilities.values()].map((definition) =>
          Object.freeze({
            definition,
            ...(this.#executors.get(definition.capabilityId)
              ? { executor: this.#executors.get(definition.capabilityId)! }
              : {}),
          }),
        ),
      ),
      contextSources: Object.freeze(
        [...this.#contextSources.values()].map((source) =>
          Object.freeze({
            sourceId: source.sourceId,
            providerId: source.providerId,
            revision: source.revision,
          }),
        ),
      ),
    });
  }

  capability(capabilityId: string): CapabilityDefinition | undefined {
    return this.#capabilities.get(capabilityId);
  }

  executor(capabilityId: string): CapabilityExecutor | undefined {
    return this.#executors.get(capabilityId);
  }

  contextSource(sourceId: string): ContextSource | undefined {
    return this.#contextSources.get(sourceId);
  }

  receiptNormalizer(normalizerId: string): RuntimeReceiptNormalizer | undefined {
    return this.#normalizers.get(normalizerId);
  }

  executionAdapter<TContext, TAdapter>(
    adapterId: string,
  ): RuntimeExecutionAdapterRegistration<TContext, TAdapter> | undefined {
    return this.#executionAdapters.get(adapterId) as
      | RuntimeExecutionAdapterRegistration<TContext, TAdapter>
      | undefined;
  }

  requireExecutionAdapter<TContext, TAdapter>(
    adapterId: string,
  ): RuntimeExecutionAdapterRegistration<TContext, TAdapter> {
    const adapter = this.executionAdapter<TContext, TAdapter>(adapterId);
    if (!adapter) throw new Error(`runtime execution adapter is not registered: ${adapterId}`);
    return adapter;
  }

  start(): Promise<void> {
    if (this.#state === 'disposed' || this.#state === 'disposing') {
      return Promise.reject(new Error('runtime module registry is disposed'));
    }
    if (this.#state === 'failed') {
      return this.#startPromise ?? Promise.reject(new Error('runtime module registry failed'));
    }
    this.#startPromise ??= this.#startModules();
    return this.#startPromise;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeModules();
    return this.#disposePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  declareCapability(module: RuntimeModule, definition: CapabilityDefinition): void {
    this.#assertProvider(module, definition.providerId);
    const capabilityId = normalizeRuntimeIdentifier(
      'runtime capability id',
      definition.capabilityId,
    );
    normalizeRuntimeIdentifier('runtime capability revision', definition.revision);
    if (
      definition.executionMechanism !== undefined &&
      !CAPABILITY_EXECUTION_MECHANISMS_.includes(definition.executionMechanism)
    ) {
      throw new Error(`runtime capability execution mechanism is invalid: ${capabilityId}`);
    }
    if (
      definition.visibility !== undefined &&
      definition.visibility !== 'model' &&
      definition.visibility !== 'internal'
    ) {
      throw new Error(`runtime capability visibility is invalid: ${definition.capabilityId}`);
    }
    if (definition.visibility === 'model' && !definition.toolName) {
      throw new Error(`model-visible runtime capability requires a tool name: ${capabilityId}`);
    }
    if (definition.visibility === 'internal' && definition.toolName) {
      throw new Error(`internal runtime capability cannot declare a tool name: ${capabilityId}`);
    }
    if (definition.toolName) {
      normalizeRuntimeIdentifier('runtime capability tool name', definition.toolName);
      if (definition.visibility !== 'model') {
        throw new Error(`runtime capability tool name requires model visibility: ${capabilityId}`);
      }
    }
    if (definition.description !== undefined) {
      normalizeRuntimeIdentifier('runtime capability description', definition.description);
    }
    if (definition.effects) {
      for (const value of Object.values(definition.effects)) {
        if (!['none', 'read', 'write', 'destructive', 'unknown'].includes(value)) {
          throw new Error(`runtime capability effect fact is invalid: ${capabilityId}`);
        }
      }
    }
    if (
      definition.kind !== undefined &&
      !['computer', 'coordination', 'runtime_action', 'interrupt', 'internal_runtime'].includes(
        definition.kind,
      )
    ) {
      throw new Error(`runtime capability kind is invalid: ${capabilityId}`);
    }
    if (
      definition.minimumApproval !== undefined &&
      !['none', 'auto_review', 'user'].includes(definition.minimumApproval)
    ) {
      throw new Error(`runtime capability approval is invalid: ${capabilityId}`);
    }
    if (definition.modelDescription !== undefined) {
      normalizeRuntimeIdentifier(
        'runtime capability model description',
        definition.modelDescription,
      );
    }
    if (definition.governanceRevision !== undefined) {
      normalizeRuntimeIdentifier(
        'runtime capability governance revision',
        definition.governanceRevision,
      );
    }
    for (const parser of [definition.parser, definition.modelParser]) {
      if (!parser) continue;
      normalizeRuntimeIdentifier('runtime capability parser revision', parser.parserRevision);
      if (parser.schemaDigest !== undefined) {
        normalizeRuntimeIdentifier('runtime capability parser schema digest', parser.schemaDigest);
      }
      if (
        typeof parser.parse !== 'function' ||
        typeof parser.canonicalize !== 'function' ||
        typeof parser.observeUnknownFields !== 'function'
      ) {
        throw new Error(`runtime capability parser is invalid: ${capabilityId}`);
      }
      const knownFields = [...parser.knownFields];
      if (
        knownFields.some((field) => !field || field.trim() !== field) ||
        new Set(knownFields).size !== knownFields.length
      ) {
        throw new Error(`runtime capability parser fields are invalid: ${capabilityId}`);
      }
    }
    if (definition.availability && typeof definition.availability !== 'function') {
      throw new Error(`runtime capability availability is invalid: ${capabilityId}`);
    }
    if (definition.effectsClassifier && typeof definition.effectsClassifier !== 'function') {
      throw new Error(`runtime capability effects classifier is invalid: ${capabilityId}`);
    }
    if (definition.policyCompiler && typeof definition.policyCompiler !== 'function') {
      throw new Error(`runtime capability policy compiler is invalid: ${capabilityId}`);
    }
    if (definition.executionTraitsDeclaration) {
      validateExecutionTraitsDeclaration(capabilityId, definition.executionTraitsDeclaration);
    }
    if (definition.execution) {
      if (!['never', 'safe_read', 'idempotency_key'].includes(definition.execution.retry)) {
        throw new Error(`runtime capability execution policy is invalid: ${capabilityId}`);
      }
      if (definition.execution.idempotencyKeyArgument !== undefined) {
        normalizeRuntimeIdentifier(
          'runtime capability idempotency key argument',
          definition.execution.idempotencyKeyArgument,
        );
      }
    }
    if (definition.descriptor) {
      if (definition.descriptor.capabilityId !== capabilityId || !definition.descriptor.revision) {
        throw new Error(`runtime capability descriptor identity mismatch: ${capabilityId}`);
      }
      if (definition.descriptor.declaredEffects) {
        for (const value of Object.values(definition.descriptor.declaredEffects)) {
          if (!['none', 'read', 'write', 'destructive', 'unknown'].includes(value)) {
            throw new Error(`runtime capability descriptor effects are invalid: ${capabilityId}`);
          }
        }
      }
      if (definition.descriptor.effectiveEffects) {
        for (const value of Object.values(definition.descriptor.effectiveEffects)) {
          if (!['none', 'read', 'write', 'destructive', 'unknown'].includes(value)) {
            throw new Error(`runtime capability descriptor effects are invalid: ${capabilityId}`);
          }
        }
      }
      if (
        definition.descriptor.executionMechanism !== undefined &&
        !CAPABILITY_EXECUTION_MECHANISMS_.includes(definition.descriptor.executionMechanism)
      ) {
        throw new Error(
          `runtime capability descriptor execution mechanism is invalid: ${capabilityId}`,
        );
      }
      if (
        definition.executionMechanism !== undefined &&
        definition.descriptor.executionMechanism !== undefined &&
        definition.executionMechanism !== definition.descriptor.executionMechanism
      ) {
        throw new Error(
          `runtime capability execution mechanism identity mismatch: ${capabilityId}`,
        );
      }
    }
    if (definition.inputSchemaDigest) {
      normalizeRuntimeIdentifier(
        'runtime capability input schema digest',
        definition.inputSchemaDigest,
      );
    }
    if (this.#capabilities.has(capabilityId)) {
      throw new Error(`duplicate runtime capability: ${capabilityId}`);
    }
    this.#capabilities.set(
      capabilityId,
      Object.freeze({
        ...definition,
        capabilityId,
        ...(definition.inputSchema
          ? { inputSchema: freezeRuntimeJsonRecord(definition.inputSchema) }
          : {}),
        ...(definition.outputSchema
          ? { outputSchema: freezeRuntimeJsonRecord(definition.outputSchema) }
          : {}),
        ...(definition.modelInputSchema
          ? { modelInputSchema: freezeRuntimeJsonRecord(definition.modelInputSchema) }
          : {}),
        ...(definition.effects ? { effects: Object.freeze({ ...definition.effects }) } : {}),
        ...(definition.executionTraitsDeclaration
          ? {
              executionTraitsDeclaration: freezeExecutionTraitsDeclaration(
                definition.executionTraitsDeclaration,
              ),
            }
          : {}),
        ...(definition.execution ? { execution: Object.freeze({ ...definition.execution }) } : {}),
        ...(definition.parser ? { parser: freezeCapabilityParser(definition.parser) } : {}),
        ...(definition.modelParser
          ? { modelParser: freezeCapabilityParser(definition.modelParser) }
          : {}),
        ...(definition.descriptor
          ? { descriptor: freezeCapabilityDescriptor(definition.descriptor) }
          : {}),
      }),
    );
  }

  declareExecutor(module: RuntimeModule, executor: CapabilityExecutor): void {
    this.#assertProvider(module, executor.providerId);
    const capabilityId = normalizeRuntimeIdentifier(
      'runtime executor capability id',
      executor.capabilityId,
    );
    normalizeRuntimeIdentifier('runtime executor revision', executor.executorRevision);
    normalizeRuntimeIdentifier('runtime capability revision', executor.capabilityRevision);
    if (this.#executors.has(capabilityId)) {
      throw new Error(`duplicate runtime executor: ${capabilityId}`);
    }
    this.#executors.set(capabilityId, Object.freeze(executor));
  }

  declareContextSource(module: RuntimeModule, source: ContextSource): void {
    this.#assertProvider(module, source.providerId);
    const sourceId = normalizeRuntimeIdentifier('runtime context source id', source.sourceId);
    normalizeRuntimeIdentifier('runtime context source revision', source.revision);
    if (this.#contextSources.has(sourceId)) {
      throw new Error(`duplicate runtime context source: ${sourceId}`);
    }
    this.#contextSources.set(sourceId, Object.freeze(source));
  }

  declareNormalizer(_module: RuntimeModule, normalizer: RuntimeReceiptNormalizer): void {
    const normalizerId = normalizeRuntimeIdentifier(
      'runtime receipt normalizer id',
      normalizer.normalizerId,
    );
    normalizeRuntimeIdentifier('runtime receipt normalizer revision', normalizer.revision);
    if (this.#normalizers.has(normalizerId)) {
      throw new Error(`duplicate runtime receipt normalizer: ${normalizerId}`);
    }
    this.#normalizers.set(normalizerId, Object.freeze(normalizer));
  }

  declareExecutionAdapter<TContext, TAdapter>(
    _module: RuntimeModule,
    adapter: RuntimeExecutionAdapterRegistration<TContext, TAdapter>,
  ): void {
    const adapterId = normalizeRuntimeIdentifier('runtime execution adapter id', adapter.adapterId);
    normalizeRuntimeIdentifier('runtime execution adapter revision', adapter.revision);
    if (this.#executionAdapters.has(adapterId)) {
      throw new Error(`duplicate runtime execution adapter: ${adapterId}`);
    }
    this.#executionAdapters.set(
      adapterId,
      Object.freeze(adapter) as RuntimeExecutionAdapterRegistration<unknown, unknown>,
    );
  }

  #declareModule(module: RuntimeModule): void {
    const manifest = module.manifest;
    const moduleId = normalizeRuntimeIdentifier('runtime module id', manifest.moduleId);
    const providerId = normalizeRuntimeIdentifier('runtime provider id', manifest.providerId);
    normalizeRuntimeIdentifier('runtime module revision', manifest.revision);
    if (manifest.contractRevision !== 'runtime-contract-current') {
      throw new Error(`runtime module contract revision mismatch: ${moduleId}`);
    }
    if (this.#modules.has(moduleId)) throw new Error(`duplicate runtime module: ${moduleId}`);
    const priorProvider = this.#providers.get(providerId);
    if (priorProvider) {
      throw new Error(`duplicate runtime provider: ${providerId} (${priorProvider}, ${moduleId})`);
    }
    this.#modules.set(moduleId, module);
    this.#providers.set(providerId, moduleId);
    for (const operationId of manifest.operationIds) {
      normalizeRuntimeIdentifier('runtime operation id', operationId);
      const priorOwner = this.#operationOwners.get(operationId);
      if (priorOwner) {
        throw new Error(
          `duplicate runtime operation owner: ${operationId} (${priorOwner}, ${moduleId})`,
        );
      }
      this.#operationOwners.set(operationId, moduleId);
    }
  }

  #assertProvider(module: RuntimeModule, providerId: string): void {
    if (providerId !== module.manifest.providerId) {
      throw new Error(
        `runtime registration provider mismatch: ${providerId} != ${module.manifest.providerId}`,
      );
    }
  }

  #validateExecutorBindings(): void {
    for (const [capabilityId, executor] of this.#executors) {
      const definition = this.#capabilities.get(capabilityId);
      if (!definition) {
        throw new Error(`runtime executor has no capability definition: ${capabilityId}`);
      }
      if (
        executor.providerId !== definition.providerId ||
        executor.capabilityRevision !== definition.revision
      ) {
        throw new Error(`runtime executor binding mismatch: ${capabilityId}`);
      }
    }
  }

  async #startModules(): Promise<void> {
    this.#state = 'starting';
    try {
      for (const module of this.#modules.values()) {
        if (module.start) {
          await boundedLifecycleCall(
            `start runtime module ${module.manifest.moduleId}`,
            this.#lifecycleTimeoutMs,
            () => module.start!(),
          );
        }
      }
      this.#state = 'started';
    } catch (startError) {
      this.#state = 'failed';
      try {
        await this.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [startError, disposeError],
          'runtime module startup and rollback failed',
        );
      }
      throw startError;
    }
  }

  async #disposeModules(): Promise<void> {
    if (this.#state === 'disposed') return;
    this.#state = 'disposing';
    const failures: unknown[] = [];
    const modules = [...this.#modules.values()].reverse();
    for (const module of modules) {
      try {
        await boundedLifecycleCall(
          `dispose runtime module ${module.manifest.moduleId}`,
          this.#lifecycleTimeoutMs,
          () => module.dispose(),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    this.#state = 'disposed';
    if (failures.length > 0) {
      throw new AggregateError(failures, 'runtime module disposal failed');
    }
  }
}

/**
 * Pure registry arbitration. It resolves identity only: no Policy state,
 * Provider call, approval decision, or ExecutionGrant can enter this step.
 */
export function arbitrateCapability(
  snapshot: Readonly<CapabilityRegistrySnapshot>,
  binding: Readonly<CapabilityBinding>,
): CapabilityArbitrationResult {
  if (!binding.capabilityId) return { status: 'failed', code: 'binding_invalid' };
  const entry = snapshot.capabilities.find(
    (candidate) => candidate.definition.capabilityId === binding.capabilityId,
  );
  if (!entry) return { status: 'failed', code: 'capability_missing' };
  const identityFailure = capabilityBindingIdentityFailure(entry.definition, binding);
  if (identityFailure) {
    return {
      status: 'failed',
      code: identityFailure === 'capability_id_mismatch' ? 'binding_invalid' : identityFailure,
    };
  }
  if (!entry.executor) return { status: 'failed', code: 'executor_missing' };
  if (
    entry.executor.providerId !== entry.definition.providerId ||
    entry.executor.capabilityId !== binding.capabilityId ||
    entry.executor.capabilityRevision !== binding.capabilityRevision
  ) {
    return { status: 'failed', code: 'executor_binding_mismatch' };
  }
  return Object.freeze({
    status: 'resolved',
    binding: Object.freeze({ ...binding }),
    definition: entry.definition,
    executor: entry.executor,
  });
}

/** Pure, ordered comparison shared by Registry arbitration and catalog dispatch. */
export function capabilityBindingIdentityFailure(
  definition: Readonly<CapabilityDefinition>,
  binding: Readonly<CapabilityBinding>,
): CapabilityBindingIdentityFailureCode | undefined {
  if (
    !binding.bindingId ||
    !binding.capabilityId ||
    !binding.capabilityRevision ||
    !binding.exposedToolName ||
    !binding.schemaDigest ||
    !binding.issuedForTurnId
  ) {
    return 'binding_invalid';
  }
  if (binding.capabilityId !== definition.capabilityId) return 'capability_id_mismatch';
  if (binding.capabilityRevision !== definition.revision) {
    return 'capability_revision_mismatch';
  }
  if (definition.inputSchemaDigest && binding.schemaDigest !== definition.inputSchemaDigest) {
    return 'schema_digest_mismatch';
  }
  const expectedToolName =
    definition.visibility === 'model'
      ? definition.toolName
      : definition.visibility === 'internal'
        ? definition.capabilityId
        : undefined;
  if (expectedToolName !== undefined && binding.exposedToolName !== expectedToolName) {
    return 'exposed_tool_name_mismatch';
  }
  return undefined;
}

function freezeRuntimeJsonRecord(
  value: Readonly<Record<string, RuntimeJsonValue>>,
): Readonly<Record<string, RuntimeJsonValue>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeRuntimeJson(item)])),
  );
}

function freezeRuntimeJson(value: RuntimeJsonValue): RuntimeJsonValue {
  if (isRuntimeJsonArray(value)) return Object.freeze(value.map(freezeRuntimeJson));
  if (value && typeof value === 'object') return freezeRuntimeJsonRecord(value);
  return value;
}

function isRuntimeJsonArray(value: RuntimeJsonValue): value is readonly RuntimeJsonValue[] {
  return Array.isArray(value);
}

function validateExecutionTraitsDeclaration(
  capabilityId: string,
  traits: CapabilityExecutionTraitsDeclaration,
): void {
  if (!Array.isArray(traits.resourceScopes)) {
    throw new Error(`runtime capability execution traits are invalid: ${capabilityId}`);
  }
  for (const scope of traits.resourceScopes) {
    if (
      !scope ||
      ![
        'runtime',
        'workspace',
        'process',
        'network',
        'external_state',
        'subagent',
        'skill',
      ].includes(scope.kind) ||
      typeof scope.key !== 'string' ||
      scope.key.trim() !== scope.key ||
      scope.key.length === 0
    ) {
      throw new Error(`runtime capability resource scope is invalid: ${capabilityId}`);
    }
  }
  if (
    traits.conflictKeys !== undefined &&
    (!Array.isArray(traits.conflictKeys) ||
      traits.conflictKeys.some((key) => typeof key !== 'string'))
  ) {
    throw new Error(`runtime capability conflict keys are invalid: ${capabilityId}`);
  }
  if (
    traits.isolation !== undefined &&
    !['shared', 'exclusive_workspace', 'worktree'].includes(traits.isolation)
  ) {
    throw new Error(`runtime capability isolation is invalid: ${capabilityId}`);
  }
  if (typeof traits.interactionBarrier !== 'boolean') {
    throw new Error(`runtime capability causal traits are invalid: ${capabilityId}`);
  }
  if (
    traits.concurrencyGroup !== undefined &&
    (typeof traits.concurrencyGroup !== 'string' ||
      traits.concurrencyGroup.trim() !== traits.concurrencyGroup)
  ) {
    throw new Error(`runtime capability concurrency group is invalid: ${capabilityId}`);
  }
  if (typeof traits.leaseFenceRequired !== 'boolean') {
    throw new Error(`runtime capability lease fence trait is invalid: ${capabilityId}`);
  }
}

function freezeExecutionTraitsDeclaration(
  traits: CapabilityExecutionTraitsDeclaration,
): CapabilityExecutionTraitsDeclaration {
  return Object.freeze({
    ...traits,
    resourceScopes: Object.freeze(
      traits.resourceScopes.map((scope) => Object.freeze({ ...scope })),
    ),
    ...(traits.conflictKeys ? { conflictKeys: Object.freeze([...traits.conflictKeys]) } : {}),
  });
}

function freezeCapabilityParser(parser: CapabilityParser): CapabilityParser {
  return Object.freeze({
    ...parser,
    knownFields: Object.freeze([...parser.knownFields]),
  });
}

function freezeCapabilityDescriptor(
  descriptor: CapabilityDescriptor | CapabilityInternalDescriptor,
): CapabilityDescriptor | CapabilityInternalDescriptor {
  const diagnostics = [...descriptor.diagnostics];
  Object.freeze(diagnostics);
  const copy = {
    ...descriptor,
    provider: Object.freeze({ ...descriptor.provider }),
    ...(descriptor.inputSchema
      ? { inputSchema: freezeRuntimeJsonRecord(descriptor.inputSchema) }
      : {}),
    ...(descriptor.outputSchema
      ? { outputSchema: freezeRuntimeJsonRecord(descriptor.outputSchema) }
      : {}),
    declaredEffects: Object.freeze({ ...descriptor.declaredEffects }),
    effectiveEffects: Object.freeze({ ...descriptor.effectiveEffects }),
    policy: Object.freeze({ ...descriptor.policy }),
    ...(descriptor.execution ? { execution: Object.freeze({ ...descriptor.execution }) } : {}),
    diagnostics,
  };
  if (descriptor.executionMechanism !== undefined) {
    Object.defineProperty(copy, 'executionMechanism', {
      value: descriptor.executionMechanism,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(copy) as CapabilityDescriptor | CapabilityInternalDescriptor;
}

class ScopedRuntimeModuleRegistryWriter implements RuntimeModuleRegistryWriter {
  readonly #registry: FrozenRuntimeModuleRegistry;
  readonly #module: RuntimeModule;
  #sealed = false;

  constructor(registry: FrozenRuntimeModuleRegistry, module: RuntimeModule) {
    this.#registry = registry;
    this.#module = module;
  }

  registerCapability(definition: CapabilityDefinition): void {
    this.#assertOpen();
    this.#registry.declareCapability(this.#module, definition);
  }

  registerExecutor(executor: CapabilityExecutor): void {
    this.#assertOpen();
    this.#registry.declareExecutor(this.#module, executor);
  }

  registerContextSource(source: ContextSource): void {
    this.#assertOpen();
    this.#registry.declareContextSource(this.#module, source);
  }

  registerReceiptNormalizer(normalizer: RuntimeReceiptNormalizer): void {
    this.#assertOpen();
    this.#registry.declareNormalizer(this.#module, normalizer);
  }

  registerExecutionAdapter<TContext, TAdapter>(
    adapter: RuntimeExecutionAdapterRegistration<TContext, TAdapter>,
  ): void {
    this.#assertOpen();
    this.#registry.declareExecutionAdapter(this.#module, adapter);
  }

  seal(): void {
    this.#sealed = true;
  }

  #assertOpen(): void {
    if (this.#sealed) throw new Error('runtime module registry writer is frozen');
  }
}

async function boundedLifecycleCall(
  label: string,
  timeoutMs: number,
  call: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
