import type { CapabilityDescriptor as RuntimeCapabilityDescriptor } from '@kite-ai/runtime-contract';
import type {
  CapabilityApproval,
  CapabilityAvailabilityDecision,
  CapabilityDescriptor,
  CapabilityEffects,
  CapabilityEffectsClassifier,
  CapabilityExecutionInvocation,
  CapabilityExecutionMechanism,
  CapabilityExecutionPolicy,
  CapabilityExecutionPort,
  CapabilityExecutionTraits,
  CapabilityExecutionTraitsDeclaration,
  CapabilityExecutionTraitsProjector,
  CapabilityInternalDescriptor,
  CapabilityKind,
  CapabilityParseResult,
  CapabilityParser,
  CapabilityPolicyCompilation,
  CapabilityPolicyContext,
  CapabilityRegistrySnapshot,
  CapabilityTurnContext,
  CapabilityUnknownFieldObservation,
  ExecutionReceipt,
  RuntimeJsonValue,
  RuntimeModuleRegistry,
} from '@kite-ai/runtime-spi';
import {
  CAPABILITY_EXECUTION_MECHANISMS_,
  capabilityBindingIdentityFailure,
} from '@kite-ai/runtime-spi';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { digestCapabilityBindingValue } from './capability-binding';
import { projectBuiltinExecutionTraits } from './catalog-contract';

/** Opaque model tool surface owned and constructed by Builtin Runtime. */
export type BuiltinModelToolSet = ToolSet;

/** Availability is a projection fact, not an execution fallback. */
export type BuiltinToolAvailability =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'quarantined'
  | 'hidden';

export interface BuiltinUnknownToolFieldsProjection {
  readonly hasUnknown: boolean;
  readonly count: number;
  readonly toolClass:
    | 'builtin_read'
    | 'builtin_write'
    | 'builtin_execute'
    | 'builtin_other'
    | 'mcp_tool';
  readonly schemaRevision: string;
}

export type BuiltinToolEffectClass =
  | 'read_only'
  | 'plan_only'
  | 'workspace_write'
  | 'external_side_effect'
  | 'unknown';

export interface BuiltinToolCapabilityProjection {
  readonly effectClass: BuiltinToolEffectClass;
  readonly sideEffect: boolean;
  readonly classificationReason: string;
}

/** Missing captured effects are conservatively unsafe and never name-classified. */
export function failClosedBuiltinToolCapability(toolName: string): BuiltinToolCapabilityProjection {
  return Object.freeze({
    effectClass: 'unknown',
    sideEffect: true,
    classificationReason: `No captured capability classification exists for ${toolName}.`,
  });
}

/**
 * Project parser-owned unknown-field facts into the bounded State shape.
 * Field names and values never cross this concrete Builtin semantic boundary.
 */
export function projectBuiltinUnknownToolFieldsObservation(input: {
  readonly toolName: string;
  readonly unknownFieldCount: number;
  readonly schemaRevision: string;
}): BuiltinUnknownToolFieldsProjection {
  const toolClass = input.toolName.startsWith('mcp__')
    ? 'mcp_tool'
    : /^(read|search|list)_/u.test(input.toolName)
      ? 'builtin_read'
      : /^(write|edit|update)_/u.test(input.toolName)
        ? 'builtin_write'
        : input.toolName === 'shell_execute' || input.toolName === 'task'
          ? 'builtin_execute'
          : 'builtin_other';
  const count = Number.isSafeInteger(input.unknownFieldCount)
    ? Math.max(0, Math.min(input.unknownFieldCount, 255))
    : 255;
  return Object.freeze({
    hasUnknown: count > 0,
    count,
    toolClass,
    schemaRevision: /^[a-zA-Z0-9_.:-]{1,64}$/u.test(input.schemaRevision)
      ? input.schemaRevision
      : 'unknown',
  });
}

interface BuiltinToolCatalogEntryCommon {
  /** Stable operation identity owned by the registered Builtin module. */
  readonly operationId: string;
  readonly capabilityId: string;
  readonly providerId: string;
  readonly revision: string;
  readonly executorRevision: string;
  readonly kind: CapabilityKind;
  readonly executionMechanism: CapabilityExecutionMechanism;
  readonly description: string;
  readonly modelDescription: string;
  readonly inputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  readonly modelInputSchema?: Readonly<Record<string, RuntimeJsonValue>>;
  readonly inputSchemaDigest?: string;
  readonly effects: CapabilityEffects;
  readonly availability: BuiltinToolAvailability;
  readonly availabilityReason?: string;
  readonly availabilityDiagnostics: readonly string[];
  readonly minimumApproval: CapabilityApproval;
  readonly workspaceTrustRequired: boolean;
  readonly execution?: CapabilityExecutionPolicy;
  readonly executionTraitsDeclaration?: CapabilityExecutionTraitsDeclaration;
  readonly executionTraitsProjector?: CapabilityExecutionTraitsProjector;
  readonly parser: CapabilityParser;
  readonly modelParser?: CapabilityParser;
  readonly effectsClassifier?: CapabilityEffectsClassifier;
  projectApprovalSummary(input: RuntimeJsonValue, context?: CapabilityTurnContext): string;
  parse(input: unknown, context?: CapabilityTurnContext): CapabilityParseResult;
  parseModelInput(input: unknown, context?: CapabilityTurnContext): CapabilityParseResult;
  canonicalize(input: unknown, context?: CapabilityTurnContext): RuntimeJsonValue;
  observeUnknownFields(
    input: unknown,
    context?: CapabilityTurnContext,
  ): CapabilityUnknownFieldObservation;
  classifyEffects(
    input: RuntimeJsonValue,
    context?: CapabilityTurnContext,
  ): ReturnType<CapabilityEffectsClassifier>;
  projectExecutionTraits(
    input: RuntimeJsonValue,
    context?: CapabilityTurnContext,
  ): CapabilityExecutionTraits;
}

export interface BuiltinModelToolCatalogEntry extends BuiltinToolCatalogEntryCommon {
  readonly visibility: 'model';
  readonly name: string;
  readonly descriptor: CapabilityDescriptor;
  /** Runtime-contract descriptor projected from the same frozen SPI descriptor. */
  readonly runtimeDescriptor: RuntimeCapabilityDescriptor;
  /**
   * Compiles operation-specific policy facts from this entry's canonical
   * parser. Authorization mode and grant matching are intentionally absent.
   */
  readonly compilePolicy: (
    input: RuntimeJsonValue,
    context?: CapabilityPolicyContext,
  ) => CapabilityPolicyCompilation;
}

export interface BuiltinInternalOperationCatalogEntry extends BuiltinToolCatalogEntryCommon {
  readonly visibility: 'internal';
  readonly name?: never;
  readonly descriptor: CapabilityInternalDescriptor;
}

export type BuiltinToolCatalogEntry =
  | BuiltinModelToolCatalogEntry
  | BuiltinInternalOperationCatalogEntry;

export interface BuiltinToolCatalogProjection {
  /** Stable revision composed only from the frozen registered definitions. */
  readonly revision: string;
  /** Includes model-visible and internal operations for parity/audit. */
  readonly entries: readonly BuiltinToolCatalogEntry[];
  /** Model-facing ToolSet; entries without model visibility are never exposed. */
  readonly toolSet: ToolSet;
  /** Re-projects one immutable snapshot for a new turn context. */
  forTurn(context: CapabilityTurnContext): BuiltinToolCatalogProjection;
  /**
   * Dispatches one exact operation through the Host-selected execution port.
   * The projection never selects a second handler or calls an executor itself.
   */
  dispatch(
    operationId: string,
    port: CapabilityExecutionPort,
    invocation: CapabilityExecutionInvocation,
  ): Promise<ExecutionReceipt>;
}

export interface CreateBuiltinToolCatalogProjectionOptions {
  /** One immutable turn context consumed by all definition availability gates. */
  readonly turnContext?: CapabilityTurnContext;
}

/**
 * Build the sole Builtin catalog projection from the already-frozen SPI
 * registry. Schemas, capability revisions, and executor revisions are copied
 * from registered definitions; no Core registry or hand-written schema table
 * participates in this projection.
 */
export function createBuiltinToolCatalogProjection(
  registryOrSnapshot: RuntimeModuleRegistry | CapabilityRegistrySnapshot,
  options: CreateBuiltinToolCatalogProjectionOptions = {},
): BuiltinToolCatalogProjection {
  const snapshot =
    'snapshot' in registryOrSnapshot ? registryOrSnapshot.snapshot() : registryOrSnapshot;
  assertFrozenBuiltinRegistrySnapshot(snapshot);
  const turnContext = options.turnContext ?? EMPTY_TURN_CONTEXT_;
  const entries = snapshot.capabilities
    .map(({ definition, executor }) => {
      if (!executor) {
        throw new Error(
          `Builtin capability has no registered executor: ${definition.capabilityId}`,
        );
      }
      if (
        executor.providerId !== definition.providerId ||
        executor.capabilityId !== definition.capabilityId ||
        executor.capabilityRevision !== definition.revision
      ) {
        throw new Error(`Builtin capability executor binding mismatch: ${definition.capabilityId}`);
      }
      if (!definition.effects) {
        throw new Error(`Builtin capability is missing effect facts: ${definition.capabilityId}`);
      }

      const visibility = definition.visibility ?? 'internal';
      const base = Object.freeze({
        operationId: definition.capabilityId,
        capabilityId: definition.capabilityId,
        providerId: definition.providerId,
        revision: definition.revision,
      });
      const availabilityDecision: CapabilityAvailabilityDecision = definition.availability?.(
        turnContext,
      ) ?? { status: 'available' };
      const availability = normalizeBuiltinAvailability(availabilityDecision);
      if (visibility === 'model' && (!definition.toolName || !definition.inputSchema)) {
        throw new Error(
          `Model-visible Builtin capability is missing tool name or input schema: ${definition.capabilityId}`,
        );
      }
      if (visibility === 'model' && !definition.policyCompiler) {
        throw new Error(
          `Model-visible Builtin capability is missing its policy compiler: ${definition.capabilityId}`,
        );
      }
      if (visibility !== 'model' && definition.policyCompiler) {
        throw new Error(
          `Internal Builtin capability must not expose a model policy compiler: ${definition.capabilityId}`,
        );
      }
      if (visibility === 'model' && !definition.description) {
        throw new Error(
          `Model-visible Builtin capability is missing its canonical description: ${definition.capabilityId}`,
        );
      }
      const parser = definition.parser;
      if (!parser) {
        throw new Error(`Builtin capability is missing its parser: ${definition.capabilityId}`);
      }
      const executionMechanism = requireBuiltinExecutionMechanism(definition);
      const descriptor = definition.descriptor ?? createFallbackDescriptor(definition);
      if (descriptor.executionMechanism !== executionMechanism) {
        throw new Error(
          `Builtin capability descriptor mechanism mismatch: ${definition.capabilityId}`,
        );
      }
      const modelInputSchema = definition.modelInputSchemaForContext
        ? definition.modelInputSchemaForContext(turnContext)
        : definition.modelInputSchema;
      const frozenModelInputSchema = modelInputSchema
        ? freezeRuntimeJsonRecord(modelInputSchema)
        : undefined;
      const commonEntry = Object.freeze({
        ...base,
        executorRevision: executor.executorRevision,
        kind: definition.kind ?? (visibility === 'model' ? 'computer' : 'internal_runtime'),
        executionMechanism,
        description: definition.description ?? definition.title,
        modelDescription: definition.modelDescription ?? definition.description ?? definition.title,
        ...(definition.inputSchema ? { inputSchema: definition.inputSchema } : {}),
        ...(frozenModelInputSchema ? { modelInputSchema: frozenModelInputSchema } : {}),
        ...(definition.inputSchemaDigest
          ? { inputSchemaDigest: definition.inputSchemaDigest }
          : {}),
        effects: definition.effects,
        availability: availability.status,
        ...(availability.reason ? { availabilityReason: availability.reason } : {}),
        availabilityDiagnostics: Object.freeze([...(availabilityDecision.diagnostics ?? [])]),
        minimumApproval: definition.minimumApproval ?? 'none',
        workspaceTrustRequired: definition.workspaceTrustRequired ?? false,
        ...(definition.execution ? { execution: definition.execution } : {}),
        ...(definition.executionTraitsDeclaration
          ? { executionTraitsDeclaration: definition.executionTraitsDeclaration }
          : {}),
        ...(definition.executionTraitsProjector
          ? { executionTraitsProjector: definition.executionTraitsProjector }
          : {}),
        parser,
        ...(definition.modelParser ? { modelParser: definition.modelParser } : {}),
        ...(definition.effectsClassifier
          ? { effectsClassifier: definition.effectsClassifier }
          : {}),
        projectApprovalSummary(input: RuntimeJsonValue, context?: CapabilityTurnContext): string {
          return (
            definition.approvalSummary?.(input, context ?? turnContext) ??
            definition.toolName ??
            definition.capabilityId
          );
        },
        parse(input: unknown, context?: CapabilityTurnContext): CapabilityParseResult {
          return parser.parse(input, context ?? turnContext);
        },
        parseModelInput(input: unknown, context?: CapabilityTurnContext): CapabilityParseResult {
          return (definition.modelParser ?? parser).parse(input, context ?? turnContext);
        },
        canonicalize(input: unknown, context?: CapabilityTurnContext): RuntimeJsonValue {
          return parser.canonicalize(input, context ?? turnContext);
        },
        observeUnknownFields(
          input: unknown,
          context?: CapabilityTurnContext,
        ): CapabilityUnknownFieldObservation {
          return parser.observeUnknownFields(input, context ?? turnContext);
        },
        classifyEffects(input: RuntimeJsonValue, context?: CapabilityTurnContext) {
          return (
            definition.effectsClassifier?.(input, context ?? turnContext) ??
            defaultEffectsClassification(definition.effects)
          );
        },
        projectExecutionTraits(input: RuntimeJsonValue, context?: CapabilityTurnContext) {
          const effectiveContext = context ?? turnContext;
          const invocationEffects =
            definition.effectsClassifier?.(input, effectiveContext) ??
            defaultEffectsClassification(definition.effects);
          return (
            definition.executionTraitsProjector?.(input, effectiveContext, invocationEffects) ??
            projectBuiltinExecutionTraits(
              definition.executionTraitsDeclaration,
              input,
              effectiveContext,
              invocationEffects,
            )
          );
        },
      });

      if (visibility === 'model') {
        if (descriptor.kind !== 'builtin_tool' || !definition.toolName) {
          throw new Error(
            `Model-visible Builtin capability has an invalid descriptor: ${definition.capabilityId}`,
          );
        }
        const compilePolicy = (
          input: RuntimeJsonValue,
          context?: CapabilityPolicyContext,
        ): CapabilityPolicyCompilation => {
          const policyContext = normalizeBuiltinPolicyContext(context ?? turnContext);
          const canonicalInput = parser.canonicalize(input, policyContext);
          const compiled = definition.policyCompiler!(canonicalInput, policyContext);
          return validateBuiltinPolicyCompilation(compiled, definition, parser, policyContext);
        };
        return Object.freeze({
          ...commonEntry,
          visibility: 'model' as const,
          name: definition.toolName,
          descriptor,
          runtimeDescriptor: createRuntimeContractDescriptor(descriptor),
          compilePolicy,
        }) satisfies BuiltinModelToolCatalogEntry;
      }

      if (descriptor.kind !== 'internal_runtime') {
        throw new Error(
          `Internal Builtin capability has a model descriptor: ${definition.capabilityId}`,
        );
      }
      return Object.freeze({
        ...commonEntry,
        visibility: 'internal' as const,
        descriptor,
      }) satisfies BuiltinInternalOperationCatalogEntry;
    })
    .sort((left, right) => left.operationId.localeCompare(right.operationId));

  const frozenEntries = Object.freeze(entries);
  const names = new Set<string>();
  for (const entry of frozenEntries) {
    if (entry.visibility !== 'model' || entry.availability !== 'available') continue;
    if (!entry.name) throw new Error(`Model-visible capability has no name: ${entry.operationId}`);
    if (names.has(entry.name)) throw new Error(`Duplicate Builtin model tool name: ${entry.name}`);
    names.add(entry.name);
  }

  const toolSet = createBuiltinModelToolSet(frozenEntries, turnContext);
  const revision = digestCatalogRevision(snapshot, frozenEntries);
  const entryByOperationId = new Map(frozenEntries.map((entry) => [entry.operationId, entry]));
  const definitionByOperationId = new Map(
    snapshot.capabilities.map(({ definition }) => [definition.capabilityId, definition]),
  );

  return Object.freeze({
    revision,
    entries: frozenEntries,
    toolSet,
    forTurn(context: CapabilityTurnContext): BuiltinToolCatalogProjection {
      return createBuiltinToolCatalogProjection(snapshot, { turnContext: context });
    },
    async dispatch(
      operationId: string,
      port: CapabilityExecutionPort,
      invocation: CapabilityExecutionInvocation,
    ): Promise<ExecutionReceipt> {
      const entry = entryByOperationId.get(operationId);
      if (!entry) throw new Error(`Unknown Builtin capability operation: ${operationId}`);
      const definition = definitionByOperationId.get(operationId);
      if (!definition) throw new Error(`Builtin capability definition is missing: ${operationId}`);
      const bindingFailure = capabilityBindingIdentityFailure(definition, invocation.binding);
      const expectedBindingId = digestCapabilityBindingValue({
        capabilityId: invocation.binding.capabilityId,
        revision: invocation.binding.capabilityRevision,
        exposedToolName: invocation.binding.exposedToolName,
        schemaDigest: invocation.binding.schemaDigest,
        turnId: invocation.binding.issuedForTurnId,
      });
      if (
        bindingFailure !== undefined ||
        invocation.binding.bindingId !== expectedBindingId ||
        invocation.request.capabilityId !== entry.capabilityId ||
        invocation.request.capabilityRevision !== entry.revision ||
        invocation.grant.capabilityId !== entry.capabilityId ||
        invocation.grant.capabilityRevision !== entry.revision ||
        invocation.request.invocationId !== invocation.attempt.invocationId
      ) {
        throw new Error(`Builtin capability invocation identity mismatch: ${operationId}`);
      }
      const dispatchAvailability =
        definition.availability?.(turnContext) ?? ({ status: 'available' } as const);
      if (dispatchAvailability.status !== 'available') {
        throw new Error(`Builtin capability is not available: ${operationId}`);
      }
      if (entry.kind === 'interrupt') {
        throw new Error(`Builtin interrupt requires the Runtime user-input owner: ${operationId}`);
      }
      const receipt = await port.invoke(invocation);
      if (
        receipt.invocationId !== invocation.request.invocationId ||
        receipt.attemptId !== invocation.attempt.attemptId ||
        receipt.providerId !== entry.providerId ||
        receipt.executorRevision !== entry.executorRevision ||
        receipt.requestDigest !== invocation.requestDigest
      ) {
        throw new Error(`Builtin capability receipt identity mismatch: ${operationId}`);
      }
      return receipt;
    },
  });
}

/** Build a schema-only AI SDK ToolSet from the immutable catalog projection. */
export function createBuiltinModelToolSet(
  entries: readonly BuiltinToolCatalogEntry[],
  _context?: CapabilityTurnContext,
): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.visibility !== 'model' || entry.availability !== 'available') continue;
    if (!entry.name || !(entry.modelInputSchema ?? entry.inputSchema)) continue;
    tools[entry.name] = dynamicTool({
      description: entry.modelDescription,
      inputSchema: jsonSchema(
        (entry.modelInputSchema ?? entry.inputSchema) as Parameters<typeof jsonSchema>[0],
      ),
    });
  }
  return Object.freeze(tools) as ToolSet;
}

const EMPTY_TURN_CONTEXT_: CapabilityTurnContext = Object.freeze({});

function normalizeBuiltinPolicyContext(context: CapabilityTurnContext): CapabilityPolicyContext {
  return Object.freeze({
    ...context,
    workspace: context.workspace ?? '',
    phase: context.phase ?? 'building',
    interactionMode: context.interactionMode ?? 'accept_edits',
  });
}

function validateBuiltinPolicyCompilation(
  compiled: CapabilityPolicyCompilation,
  definition: CapabilityRegistrySnapshot['capabilities'][number]['definition'],
  parser: CapabilityParser,
  _context: CapabilityPolicyContext,
): CapabilityPolicyCompilation {
  if (!compiled || typeof compiled !== 'object') {
    throw new Error(`Builtin policy compiler returned no compilation: ${definition.capabilityId}`);
  }
  if (
    compiled.schema !== 'kite.capability-policy-compilation.v1' ||
    compiled.operationId !== definition.capabilityId ||
    compiled.capabilityRevision !== definition.revision ||
    compiled.parserRevision !== parser.parserRevision ||
    compiled.minimumApproval !== (definition.minimumApproval ?? 'none')
  ) {
    throw new Error(`Builtin policy compilation identity mismatch: ${definition.capabilityId}`);
  }
  if (
    (compiled.decision === 'allow' && (!compiled.allowed || compiled.requiresApproval)) ||
    (compiled.decision === 'ask' && (!compiled.allowed || !compiled.requiresApproval)) ||
    (compiled.decision === 'deny' && (compiled.allowed || compiled.requiresApproval))
  ) {
    throw new Error(`Builtin policy compilation decision mismatch: ${definition.capabilityId}`);
  }
  if (
    !['allow', 'ask', 'deny'].includes(compiled.decision) ||
    typeof compiled.allowed !== 'boolean' ||
    typeof compiled.requiresApproval !== 'boolean' ||
    ![
      'read',
      'plan',
      'write_file',
      'execute_code',
      'destructive',
      'network',
      'vcs_mutation',
      'mcp',
      'unknown',
    ].includes(compiled.risk) ||
    typeof compiled.reason !== 'string' ||
    typeof compiled.userVisibleSummary !== 'string' ||
    !Array.isArray(compiled.expectedEffects) ||
    compiled.expectedEffects.length === 0 ||
    !compiled.expectedEffects.every((effect) => typeof effect === 'string') ||
    (compiled.phaseConstraint !== undefined && compiled.phaseConstraint !== 'planning') ||
    !compiled.effectiveEffects ||
    typeof compiled.effectiveEffects !== 'object' ||
    !['none', 'read', 'write', 'destructive', 'unknown'].includes(
      compiled.effectiveEffects.filesystem,
    ) ||
    !['none', 'read', 'write', 'destructive', 'unknown'].includes(
      compiled.effectiveEffects.network,
    ) ||
    !['none', 'read', 'write', 'destructive', 'unknown'].includes(
      compiled.effectiveEffects.externalState,
    ) ||
    (compiled.effects !== undefined &&
      (typeof compiled.effects !== 'object' ||
        !Object.values(compiled.effects).every((value) => value === true))) ||
    (compiled.recovery !== undefined &&
      (typeof compiled.recovery !== 'object' ||
        !['never', 'retry', 'defer', 'redirect'].includes(compiled.recovery.disposition) ||
        !Number.isSafeInteger(compiled.recovery.maximumAdditionalCalls) ||
        compiled.recovery.maximumAdditionalCalls < 0 ||
        typeof compiled.recovery.safeAutomaticRetry !== 'boolean' ||
        (compiled.recovery.capabilityIntent !== undefined &&
          (typeof compiled.recovery.capabilityIntent !== 'string' ||
            compiled.recovery.capabilityIntent.length === 0)))) ||
    typeof compiled.fullAccessMayBypassApproval !== 'boolean' ||
    typeof compiled.sameCommandMayBypassApproval !== 'boolean' ||
    (compiled.sandboxScope !== undefined && !validSandboxScope(compiled.sandboxScope))
  ) {
    throw new Error(`Builtin policy compilation facts are invalid: ${definition.capabilityId}`);
  }
  return freezeBuiltinPolicyCompilation(compiled);
}

function freezeBuiltinPolicyCompilation(
  compiled: CapabilityPolicyCompilation,
): CapabilityPolicyCompilation {
  return Object.freeze({
    ...compiled,
    ...(compiled.effects ? { effects: Object.freeze({ ...compiled.effects }) } : {}),
    ...(compiled.sandboxScope ? { sandboxScope: Object.freeze({ ...compiled.sandboxScope }) } : {}),
    ...(compiled.recovery ? { recovery: Object.freeze({ ...compiled.recovery }) } : {}),
    effectiveEffects: Object.freeze({ ...compiled.effectiveEffects }),
    expectedEffects: Object.freeze([...compiled.expectedEffects]),
  });
}

function validSandboxScope(
  value: NonNullable<CapabilityPolicyCompilation['sandboxScope']>,
): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['baseline', 'expanded', 'unrestricted'].includes(value.kind) &&
    ['read_only', 'workspace_write', 'full_access'].includes(value.filesystem) &&
    ['disabled', 'allow_all'].includes(value.network) &&
    typeof value.digest === 'string' &&
    value.digest.length > 0 &&
    value.digest ===
      digestCapabilityBindingValue({
        kind: value.kind,
        filesystem: value.filesystem,
        network: value.network,
      })
  );
}

function assertFrozenBuiltinRegistrySnapshot(snapshot: CapabilityRegistrySnapshot): void {
  if (
    !Object.isFrozen(snapshot) ||
    !Object.isFrozen(snapshot.modules) ||
    !Object.isFrozen(snapshot.capabilities) ||
    !Object.isFrozen(snapshot.contextSources)
  ) {
    throw new Error('Builtin catalog requires a frozen Runtime SPI registry snapshot');
  }

  const moduleIds = new Set<string>();
  const providerIds = new Set<string>();
  for (const module of snapshot.modules) {
    if (
      !Object.isFrozen(module) ||
      moduleIds.has(module.moduleId) ||
      providerIds.has(module.providerId)
    ) {
      throw new Error('Builtin catalog Runtime SPI module snapshot is invalid');
    }
    moduleIds.add(module.moduleId);
    providerIds.add(module.providerId);
  }

  const capabilityIds = new Set<string>();
  for (const entry of snapshot.capabilities) {
    const definition = entry.definition;
    if (
      !Object.isFrozen(entry) ||
      !Object.isFrozen(definition) ||
      (entry.executor !== undefined && !Object.isFrozen(entry.executor)) ||
      capabilityIds.has(definition.capabilityId)
    ) {
      throw new Error('Builtin catalog Runtime SPI capability snapshot is invalid');
    }
    capabilityIds.add(definition.capabilityId);
  }

  const sourceIds = new Set<string>();
  for (const source of snapshot.contextSources) {
    if (!Object.isFrozen(source) || sourceIds.has(source.sourceId)) {
      throw new Error('Builtin catalog Runtime SPI context snapshot is invalid');
    }
    sourceIds.add(source.sourceId);
  }
}

function normalizeBuiltinAvailability(
  decision: CapabilityAvailabilityDecision,
): Readonly<{ status: BuiltinToolAvailability; reason?: string }> {
  return Object.freeze({
    status: decision.status,
    ...(decision.reason ? { reason: decision.reason } : {}),
  });
}

function createFallbackDescriptor(
  definition: CapabilityRegistrySnapshot['capabilities'][number]['definition'],
): CapabilityDescriptor | CapabilityInternalDescriptor {
  const effects = definition.effects ?? {
    filesystem: 'unknown' as const,
    network: 'unknown' as const,
    externalState: 'unknown' as const,
  };
  return Object.freeze({
    capabilityId: definition.capabilityId,
    revision: definition.revision,
    kind: 'builtin_tool',
    executionMechanism: requireBuiltinExecutionMechanism(definition),
    displayName: definition.toolName ?? definition.capabilityId,
    description: definition.description ?? definition.title,
    modelDescription: definition.modelDescription ?? definition.description ?? definition.title,
    descriptionProvenance: 'builtin',
    provider: Object.freeze({
      type: 'builtin',
      id: definition.visibility === 'model' ? 'kite-code' : definition.providerId,
      provenance: 'builtin',
    }),
    ...(definition.inputSchema ? { inputSchema: definition.inputSchema } : {}),
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
    declaredEffects: effects,
    effectiveEffects: effects,
    policy: Object.freeze({
      workspaceTrustRequired: definition.workspaceTrustRequired ?? false,
      minimumApproval: definition.minimumApproval ?? 'none',
      ...(definition.governanceRevision
        ? { governanceRevision: definition.governanceRevision }
        : {}),
    }),
    availability: 'available',
    diagnostics: [],
  });
}

function requireBuiltinExecutionMechanism(
  definition: CapabilityRegistrySnapshot['capabilities'][number]['definition'],
): CapabilityExecutionMechanism {
  const mechanism = definition.executionMechanism;
  if (mechanism === undefined || !CAPABILITY_EXECUTION_MECHANISMS_.includes(mechanism)) {
    throw new Error(
      `Builtin capability execution mechanism is invalid: ${definition.capabilityId}`,
    );
  }
  return mechanism;
}

/**
 * Adapt the frozen SPI descriptor to the Runtime Contract shape once. The
 * Runtime Contract currently has no governanceRevision field, so that
 * optional SPI policy fact remains available on `entry.descriptor` while the
 * contract projection carries every field in its declared type.
 */
function createRuntimeContractDescriptor(
  descriptor: CapabilityDescriptor,
): RuntimeCapabilityDescriptor {
  if (descriptor.kind !== 'builtin_tool') {
    throw new Error(`Model Builtin descriptor must be builtin_tool: ${descriptor.capabilityId}`);
  }
  const diagnostics = [...descriptor.diagnostics];
  Object.freeze(diagnostics);
  return Object.freeze({
    capabilityId: descriptor.capabilityId,
    revision: descriptor.revision,
    kind: descriptor.kind,
    displayName: descriptor.displayName,
    description: descriptor.description,
    ...(descriptor.modelDescription ? { modelDescription: descriptor.modelDescription } : {}),
    ...(descriptor.descriptionProvenance
      ? { descriptionProvenance: descriptor.descriptionProvenance }
      : {}),
    provider: Object.freeze({ ...descriptor.provider }),
    ...(descriptor.inputSchema ? { inputSchema: descriptor.inputSchema } : {}),
    ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
    declaredEffects: Object.freeze({ ...descriptor.declaredEffects }),
    effectiveEffects: Object.freeze({ ...descriptor.effectiveEffects }),
    policy: Object.freeze({
      workspaceTrustRequired: descriptor.policy.workspaceTrustRequired,
      minimumApproval: descriptor.policy.minimumApproval,
    }),
    ...(descriptor.execution ? { execution: Object.freeze({ ...descriptor.execution }) } : {}),
    availability: descriptor.availability,
    diagnostics,
  });
}

function defaultEffectsClassification(
  effects: CapabilityEffects | undefined,
): ReturnType<CapabilityEffectsClassifier> {
  const effectiveEffects =
    effects ??
    ({
      filesystem: 'unknown',
      network: 'unknown',
      externalState: 'unknown',
    } as const);
  return Object.freeze({
    effectClass: 'unknown',
    sideEffect: true,
    classificationReason: 'No Builtin invocation classifier was registered.',
    risk: 'unknown',
    effectiveEffects,
  });
}

function digestCatalogRevision(
  snapshot: CapabilityRegistrySnapshot,
  entries: readonly BuiltinToolCatalogEntry[],
): string {
  return digestCapabilityBindingValue({
    schema: 'kite.builtin-tool-catalog-projection.v1',
    modules: snapshot.modules,
    capabilities: entries.map((entry) => ({
      operationId: entry.operationId,
      capabilityId: entry.capabilityId,
      providerId: entry.providerId,
      revision: entry.revision,
      executorRevision: entry.executorRevision,
      visibility: entry.visibility,
      name: entry.name ?? null,
      kind: entry.kind,
      executionMechanism: entry.executionMechanism,
      effects: entry.effects,
      descriptorRevision: entry.descriptor.revision,
      parserRevision: entry.parser.parserRevision,
      parserSchemaDigest: entry.parser.schemaDigest ?? null,
      modelParserRevision: entry.modelParser?.parserRevision ?? null,
      modelParserSchemaDigest: entry.modelParser?.schemaDigest ?? null,
    })),
  });
}

function freezeRuntimeJsonRecord(
  value: Readonly<Record<string, RuntimeJsonValue>>,
): Readonly<Record<string, RuntimeJsonValue>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeRuntimeJsonValue(item)]),
    ),
  );
}

function freezeRuntimeJsonValue(value: RuntimeJsonValue): RuntimeJsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeRuntimeJsonValue));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return freezeRuntimeJsonRecord(value as Readonly<Record<string, RuntimeJsonValue>>);
  }
  return value;
}
