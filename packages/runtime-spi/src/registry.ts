import {
  CAPABILITY_EXECUTION_MECHANISMS_V1,
  type CapabilityBindingV1,
  type CapabilityDefinitionV1,
  type CapabilityDescriptorV1,
  type CapabilityExecutionTraitsDeclarationV1,
  type CapabilityExecutorV1,
  type CapabilityInternalDescriptorV1,
  type CapabilityParserV1,
  type ContextSourceV1,
  normalizeRuntimeIdentifierV1,
  type RuntimeExecutionAdapterRegistrationV1,
  type RuntimeJsonValueV1,
  type RuntimeModuleRegistryWriterV1,
  type RuntimeModuleV1,
  type RuntimeReceiptNormalizerV1,
} from './contracts';

export interface CapabilityRegistrySnapshotEntryV1 {
  readonly definition: CapabilityDefinitionV1;
  readonly executor?: CapabilityExecutorV1;
}

export interface CapabilityRegistrySnapshotV1 {
  readonly modules: readonly Readonly<{
    moduleId: string;
    providerId: string;
    revision: string;
  }>[];
  readonly capabilities: readonly CapabilityRegistrySnapshotEntryV1[];
  readonly contextSources: readonly Readonly<{
    sourceId: string;
    providerId: string;
    revision: string;
  }>[];
}

export type CapabilityArbitrationFailureCodeV1 =
  | 'binding_invalid'
  | 'capability_missing'
  | 'capability_revision_mismatch'
  | 'schema_digest_mismatch'
  | 'exposed_tool_name_mismatch'
  | 'executor_missing'
  | 'executor_binding_mismatch';

export type CapabilityBindingIdentityFailureCodeV1 =
  | 'binding_invalid'
  | 'capability_id_mismatch'
  | 'capability_revision_mismatch'
  | 'schema_digest_mismatch'
  | 'exposed_tool_name_mismatch';

export type CapabilityArbitrationResultV1 =
  | {
      readonly status: 'resolved';
      readonly binding: CapabilityBindingV1;
      readonly definition: CapabilityDefinitionV1;
      readonly executor: CapabilityExecutorV1;
    }
  | {
      readonly status: 'failed';
      readonly code: CapabilityArbitrationFailureCodeV1;
    };

export type RuntimeModuleRegistryStateV1 =
  | 'registered'
  | 'starting'
  | 'started'
  | 'failed'
  | 'disposing'
  | 'disposed';

export interface RuntimeModuleRegistryV1 extends AsyncDisposable {
  readonly size: number;
  readonly moduleIds: readonly string[];
  readonly state: RuntimeModuleRegistryStateV1;
  get(moduleId: string): RuntimeModuleV1 | undefined;
  keys(): IterableIterator<string>;
  operationOwner(operationId: string): string | undefined;
  snapshot(): CapabilityRegistrySnapshotV1;
  capability(capabilityId: string): CapabilityDefinitionV1 | undefined;
  executor(capabilityId: string): CapabilityExecutorV1 | undefined;
  contextSource(sourceId: string): ContextSourceV1 | undefined;
  receiptNormalizer(normalizerId: string): RuntimeReceiptNormalizerV1 | undefined;
  executionAdapter<TContext, TAdapter>(
    adapterId: string,
  ): RuntimeExecutionAdapterRegistrationV1<TContext, TAdapter> | undefined;
  requireExecutionAdapter<TContext, TAdapter>(
    adapterId: string,
  ): RuntimeExecutionAdapterRegistrationV1<TContext, TAdapter>;
  start(): Promise<void>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface RuntimeModuleRegistryOptionsV1 {
  readonly lifecycleTimeoutMs?: number;
}

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 5_000;

export function createRuntimeModuleRegistryV1(
  modules: readonly RuntimeModuleV1[],
  options: RuntimeModuleRegistryOptionsV1 = {},
): RuntimeModuleRegistryV1 {
  return new FrozenRuntimeModuleRegistryV1(modules, options);
}

class FrozenRuntimeModuleRegistryV1 implements RuntimeModuleRegistryV1 {
  readonly #modules = new Map<string, RuntimeModuleV1>();
  readonly #providers = new Map<string, string>();
  readonly #operationOwners = new Map<string, string>();
  readonly #capabilities = new Map<string, CapabilityDefinitionV1>();
  readonly #executors = new Map<string, CapabilityExecutorV1>();
  readonly #contextSources = new Map<string, ContextSourceV1>();
  readonly #normalizers = new Map<string, RuntimeReceiptNormalizerV1>();
  readonly #executionAdapters = new Map<
    string,
    RuntimeExecutionAdapterRegistrationV1<unknown, unknown>
  >();
  readonly #moduleIds: readonly string[];
  readonly #lifecycleTimeoutMs: number;
  #state: RuntimeModuleRegistryStateV1 = 'registered';
  #startPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(modules: readonly RuntimeModuleV1[], options: RuntimeModuleRegistryOptionsV1) {
    const timeout = options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new Error('runtime module lifecycle timeout must be a positive integer');
    }
    this.#lifecycleTimeoutMs = timeout;
    for (const module of modules) this.#declareModule(module);
    for (const module of this.#modules.values()) {
      const writer = new ScopedRuntimeModuleRegistryWriterV1(this, module);
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

  get state(): RuntimeModuleRegistryStateV1 {
    return this.#state;
  }

  get(moduleId: string): RuntimeModuleV1 | undefined {
    return this.#modules.get(moduleId);
  }

  keys(): IterableIterator<string> {
    return this.#modules.keys();
  }

  operationOwner(operationId: string): string | undefined {
    return this.#operationOwners.get(operationId);
  }

  snapshot(): CapabilityRegistrySnapshotV1 {
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

  capability(capabilityId: string): CapabilityDefinitionV1 | undefined {
    return this.#capabilities.get(capabilityId);
  }

  executor(capabilityId: string): CapabilityExecutorV1 | undefined {
    return this.#executors.get(capabilityId);
  }

  contextSource(sourceId: string): ContextSourceV1 | undefined {
    return this.#contextSources.get(sourceId);
  }

  receiptNormalizer(normalizerId: string): RuntimeReceiptNormalizerV1 | undefined {
    return this.#normalizers.get(normalizerId);
  }

  executionAdapter<TContext, TAdapter>(
    adapterId: string,
  ): RuntimeExecutionAdapterRegistrationV1<TContext, TAdapter> | undefined {
    return this.#executionAdapters.get(adapterId) as
      | RuntimeExecutionAdapterRegistrationV1<TContext, TAdapter>
      | undefined;
  }

  requireExecutionAdapter<TContext, TAdapter>(
    adapterId: string,
  ): RuntimeExecutionAdapterRegistrationV1<TContext, TAdapter> {
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

  declareCapability(module: RuntimeModuleV1, definition: CapabilityDefinitionV1): void {
    this.#assertProvider(module, definition.providerId);
    const capabilityId = normalizeRuntimeIdentifierV1(
      'runtime capability id',
      definition.capabilityId,
    );
    normalizeRuntimeIdentifierV1('runtime capability revision', definition.revision);
    if (
      definition.executionMechanism !== undefined &&
      !CAPABILITY_EXECUTION_MECHANISMS_V1.includes(definition.executionMechanism)
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
      normalizeRuntimeIdentifierV1('runtime capability tool name', definition.toolName);
      if (definition.visibility !== 'model') {
        throw new Error(`runtime capability tool name requires model visibility: ${capabilityId}`);
      }
    }
    if (definition.description !== undefined) {
      normalizeRuntimeIdentifierV1('runtime capability description', definition.description);
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
      normalizeRuntimeIdentifierV1(
        'runtime capability model description',
        definition.modelDescription,
      );
    }
    if (definition.governanceRevision !== undefined) {
      normalizeRuntimeIdentifierV1(
        'runtime capability governance revision',
        definition.governanceRevision,
      );
    }
    for (const parser of [definition.parser, definition.modelParser]) {
      if (!parser) continue;
      normalizeRuntimeIdentifierV1('runtime capability parser revision', parser.parserRevision);
      if (parser.schemaDigest !== undefined) {
        normalizeRuntimeIdentifierV1(
          'runtime capability parser schema digest',
          parser.schemaDigest,
        );
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
      validateExecutionTraitsDeclarationV1(capabilityId, definition.executionTraitsDeclaration);
    }
    if (definition.execution) {
      if (!['never', 'safe_read', 'idempotency_key'].includes(definition.execution.retry)) {
        throw new Error(`runtime capability execution policy is invalid: ${capabilityId}`);
      }
      if (definition.execution.idempotencyKeyArgument !== undefined) {
        normalizeRuntimeIdentifierV1(
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
        !CAPABILITY_EXECUTION_MECHANISMS_V1.includes(definition.descriptor.executionMechanism)
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
      normalizeRuntimeIdentifierV1(
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
          ? { inputSchema: freezeRuntimeJsonRecordV1(definition.inputSchema) }
          : {}),
        ...(definition.outputSchema
          ? { outputSchema: freezeRuntimeJsonRecordV1(definition.outputSchema) }
          : {}),
        ...(definition.modelInputSchema
          ? { modelInputSchema: freezeRuntimeJsonRecordV1(definition.modelInputSchema) }
          : {}),
        ...(definition.effects ? { effects: Object.freeze({ ...definition.effects }) } : {}),
        ...(definition.executionTraitsDeclaration
          ? {
              executionTraitsDeclaration: freezeExecutionTraitsDeclarationV1(
                definition.executionTraitsDeclaration,
              ),
            }
          : {}),
        ...(definition.execution ? { execution: Object.freeze({ ...definition.execution }) } : {}),
        ...(definition.parser ? { parser: freezeCapabilityParserV1(definition.parser) } : {}),
        ...(definition.modelParser
          ? { modelParser: freezeCapabilityParserV1(definition.modelParser) }
          : {}),
        ...(definition.descriptor
          ? { descriptor: freezeCapabilityDescriptorV1(definition.descriptor) }
          : {}),
      }),
    );
  }

  declareExecutor(module: RuntimeModuleV1, executor: CapabilityExecutorV1): void {
    this.#assertProvider(module, executor.providerId);
    const capabilityId = normalizeRuntimeIdentifierV1(
      'runtime executor capability id',
      executor.capabilityId,
    );
    normalizeRuntimeIdentifierV1('runtime executor revision', executor.executorRevision);
    normalizeRuntimeIdentifierV1('runtime capability revision', executor.capabilityRevision);
    if (this.#executors.has(capabilityId)) {
      throw new Error(`duplicate runtime executor: ${capabilityId}`);
    }
    this.#executors.set(capabilityId, Object.freeze(executor));
  }

  declareContextSource(module: RuntimeModuleV1, source: ContextSourceV1): void {
    this.#assertProvider(module, source.providerId);
    const sourceId = normalizeRuntimeIdentifierV1('runtime context source id', source.sourceId);
    normalizeRuntimeIdentifierV1('runtime context source revision', source.revision);
    if (this.#contextSources.has(sourceId)) {
      throw new Error(`duplicate runtime context source: ${sourceId}`);
    }
    this.#contextSources.set(sourceId, Object.freeze(source));
  }

  declareNormalizer(_module: RuntimeModuleV1, normalizer: RuntimeReceiptNormalizerV1): void {
    const normalizerId = normalizeRuntimeIdentifierV1(
      'runtime receipt normalizer id',
      normalizer.normalizerId,
    );
    normalizeRuntimeIdentifierV1('runtime receipt normalizer revision', normalizer.revision);
    if (this.#normalizers.has(normalizerId)) {
      throw new Error(`duplicate runtime receipt normalizer: ${normalizerId}`);
    }
    this.#normalizers.set(normalizerId, Object.freeze(normalizer));
  }

  declareExecutionAdapter<TContext, TAdapter>(
    _module: RuntimeModuleV1,
    adapter: RuntimeExecutionAdapterRegistrationV1<TContext, TAdapter>,
  ): void {
    const adapterId = normalizeRuntimeIdentifierV1(
      'runtime execution adapter id',
      adapter.adapterId,
    );
    normalizeRuntimeIdentifierV1('runtime execution adapter revision', adapter.revision);
    if (this.#executionAdapters.has(adapterId)) {
      throw new Error(`duplicate runtime execution adapter: ${adapterId}`);
    }
    this.#executionAdapters.set(
      adapterId,
      Object.freeze(adapter) as RuntimeExecutionAdapterRegistrationV1<unknown, unknown>,
    );
  }

  #declareModule(module: RuntimeModuleV1): void {
    const manifest = module.manifest;
    const moduleId = normalizeRuntimeIdentifierV1('runtime module id', manifest.moduleId);
    const providerId = normalizeRuntimeIdentifierV1('runtime provider id', manifest.providerId);
    normalizeRuntimeIdentifierV1('runtime module revision', manifest.revision);
    if (manifest.contractRevision !== 'rmv1-03') {
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
      normalizeRuntimeIdentifierV1('runtime operation id', operationId);
      const priorOwner = this.#operationOwners.get(operationId);
      if (priorOwner) {
        throw new Error(
          `duplicate runtime operation owner: ${operationId} (${priorOwner}, ${moduleId})`,
        );
      }
      this.#operationOwners.set(operationId, moduleId);
    }
  }

  #assertProvider(module: RuntimeModuleV1, providerId: string): void {
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
export function arbitrateCapabilityV1(
  snapshot: Readonly<CapabilityRegistrySnapshotV1>,
  binding: Readonly<CapabilityBindingV1>,
): CapabilityArbitrationResultV1 {
  if (!binding.capabilityId) return { status: 'failed', code: 'binding_invalid' };
  const entry = snapshot.capabilities.find(
    (candidate) => candidate.definition.capabilityId === binding.capabilityId,
  );
  if (!entry) return { status: 'failed', code: 'capability_missing' };
  const identityFailure = capabilityBindingIdentityFailureV1(entry.definition, binding);
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
export function capabilityBindingIdentityFailureV1(
  definition: Readonly<CapabilityDefinitionV1>,
  binding: Readonly<CapabilityBindingV1>,
): CapabilityBindingIdentityFailureCodeV1 | undefined {
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

function freezeRuntimeJsonRecordV1(
  value: Readonly<Record<string, RuntimeJsonValueV1>>,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeRuntimeJsonV1(item)]),
    ),
  );
}

function freezeRuntimeJsonV1(value: RuntimeJsonValueV1): RuntimeJsonValueV1 {
  if (isRuntimeJsonArrayV1(value)) return Object.freeze(value.map(freezeRuntimeJsonV1));
  if (value && typeof value === 'object') return freezeRuntimeJsonRecordV1(value);
  return value;
}

function isRuntimeJsonArrayV1(value: RuntimeJsonValueV1): value is readonly RuntimeJsonValueV1[] {
  return Array.isArray(value);
}

function validateExecutionTraitsDeclarationV1(
  capabilityId: string,
  traits: CapabilityExecutionTraitsDeclarationV1,
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

function freezeExecutionTraitsDeclarationV1(
  traits: CapabilityExecutionTraitsDeclarationV1,
): CapabilityExecutionTraitsDeclarationV1 {
  return Object.freeze({
    ...traits,
    resourceScopes: Object.freeze(
      traits.resourceScopes.map((scope) => Object.freeze({ ...scope })),
    ),
    ...(traits.conflictKeys ? { conflictKeys: Object.freeze([...traits.conflictKeys]) } : {}),
  });
}

function freezeCapabilityParserV1(parser: CapabilityParserV1): CapabilityParserV1 {
  return Object.freeze({
    ...parser,
    knownFields: Object.freeze([...parser.knownFields]),
  });
}

function freezeCapabilityDescriptorV1(
  descriptor: CapabilityDescriptorV1 | CapabilityInternalDescriptorV1,
): CapabilityDescriptorV1 | CapabilityInternalDescriptorV1 {
  const diagnostics = [...descriptor.diagnostics];
  Object.freeze(diagnostics);
  const copy = {
    ...descriptor,
    provider: Object.freeze({ ...descriptor.provider }),
    ...(descriptor.inputSchema
      ? { inputSchema: freezeRuntimeJsonRecordV1(descriptor.inputSchema) }
      : {}),
    ...(descriptor.outputSchema
      ? { outputSchema: freezeRuntimeJsonRecordV1(descriptor.outputSchema) }
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
  return Object.freeze(copy) as CapabilityDescriptorV1 | CapabilityInternalDescriptorV1;
}

class ScopedRuntimeModuleRegistryWriterV1 implements RuntimeModuleRegistryWriterV1 {
  readonly #registry: FrozenRuntimeModuleRegistryV1;
  readonly #module: RuntimeModuleV1;
  #sealed = false;

  constructor(registry: FrozenRuntimeModuleRegistryV1, module: RuntimeModuleV1) {
    this.#registry = registry;
    this.#module = module;
  }

  registerCapability(definition: CapabilityDefinitionV1): void {
    this.#assertOpen();
    this.#registry.declareCapability(this.#module, definition);
  }

  registerExecutor(executor: CapabilityExecutorV1): void {
    this.#assertOpen();
    this.#registry.declareExecutor(this.#module, executor);
  }

  registerContextSource(source: ContextSourceV1): void {
    this.#assertOpen();
    this.#registry.declareContextSource(this.#module, source);
  }

  registerReceiptNormalizer(normalizer: RuntimeReceiptNormalizerV1): void {
    this.#assertOpen();
    this.#registry.declareNormalizer(this.#module, normalizer);
  }

  registerExecutionAdapter<TContext, TAdapter>(
    adapter: RuntimeExecutionAdapterRegistrationV1<TContext, TAdapter>,
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
