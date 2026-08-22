import type { CapabilityDescriptor as RuntimeCapabilityDescriptor } from '@kite/runtime-contract';
import type {
  CapabilityApprovalV1,
  CapabilityAvailabilityDecisionV1,
  CapabilityDescriptorV1,
  CapabilityEffectsClassifierV1,
  CapabilityEffectsV1,
  CapabilityExecutionInvocationV1,
  CapabilityExecutionMechanismV1,
  CapabilityExecutionPolicyV1,
  CapabilityExecutionPortV1,
  CapabilityExecutionTraitsDeclarationV1,
  CapabilityExecutionTraitsProjectorV1,
  CapabilityExecutionTraitsV1,
  CapabilityInternalDescriptorV1,
  CapabilityKindV1,
  CapabilityParseResultV1,
  CapabilityParserV1,
  CapabilityPolicyCompilationV1,
  CapabilityPolicyContextV1,
  CapabilityRegistrySnapshotV1,
  CapabilityTurnContextV1,
  CapabilityUnknownFieldObservationV1,
  ExecutionReceiptV1,
  RuntimeJsonValueV1,
  RuntimeModuleRegistryV1,
} from '@kite/runtime-spi';
import {
  CAPABILITY_EXECUTION_MECHANISMS_V1,
  capabilityBindingIdentityFailureV1,
} from '@kite/runtime-spi';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import { projectBuiltinExecutionTraitsV1 } from './catalog-contract';

/** Opaque model tool surface owned and constructed by Builtin Runtime. */
export type BuiltinModelToolSetV1 = ToolSet;

/** Availability is a projection fact, not an execution fallback. */
export type BuiltinToolAvailabilityV1 =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'quarantined'
  | 'hidden';

export interface BuiltinUnknownToolFieldsProjectionV1 {
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

export type BuiltinToolEffectClassV1 =
  | 'read_only'
  | 'plan_only'
  | 'workspace_write'
  | 'external_side_effect'
  | 'unknown';

export interface BuiltinToolCapabilityProjectionV1 {
  readonly effectClass: BuiltinToolEffectClassV1;
  readonly sideEffect: boolean;
  readonly classificationReason: string;
}

/** Missing captured effects are conservatively unsafe and never name-classified. */
export function failClosedBuiltinToolCapabilityV1(
  toolName: string,
): BuiltinToolCapabilityProjectionV1 {
  return Object.freeze({
    effectClass: 'unknown',
    sideEffect: true,
    classificationReason: `No captured capability classification exists for ${toolName}.`,
  });
}

/**
 * Project parser-owned unknown-field facts into the bounded State26 shape.
 * Field names and values never cross this concrete Builtin semantic boundary.
 */
export function projectBuiltinUnknownToolFieldsObservationV1(input: {
  readonly toolName: string;
  readonly unknownFieldCount: number;
  readonly schemaRevision: string;
}): BuiltinUnknownToolFieldsProjectionV1 {
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

interface BuiltinToolCatalogEntryCommonV1 {
  /** Stable operation identity owned by the registered Builtin module. */
  readonly operationId: string;
  readonly capabilityId: string;
  readonly providerId: string;
  readonly revision: string;
  readonly executorRevision: string;
  readonly kind: CapabilityKindV1;
  readonly executionMechanism: CapabilityExecutionMechanismV1;
  readonly description: string;
  readonly modelDescription: string;
  readonly inputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly modelInputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly inputSchemaDigest?: string;
  readonly effects: CapabilityEffectsV1;
  readonly availability: BuiltinToolAvailabilityV1;
  readonly availabilityReason?: string;
  readonly availabilityDiagnostics: readonly string[];
  readonly minimumApproval: CapabilityApprovalV1;
  readonly workspaceTrustRequired: boolean;
  readonly execution?: CapabilityExecutionPolicyV1;
  readonly executionTraitsDeclaration?: CapabilityExecutionTraitsDeclarationV1;
  readonly executionTraitsProjector?: CapabilityExecutionTraitsProjectorV1;
  readonly parser: CapabilityParserV1;
  readonly modelParser?: CapabilityParserV1;
  readonly effectsClassifier?: CapabilityEffectsClassifierV1;
  projectApprovalSummary(input: RuntimeJsonValueV1, context?: CapabilityTurnContextV1): string;
  parse(input: unknown, context?: CapabilityTurnContextV1): CapabilityParseResultV1;
  parseModelInput(input: unknown, context?: CapabilityTurnContextV1): CapabilityParseResultV1;
  canonicalize(input: unknown, context?: CapabilityTurnContextV1): RuntimeJsonValueV1;
  observeUnknownFields(
    input: unknown,
    context?: CapabilityTurnContextV1,
  ): CapabilityUnknownFieldObservationV1;
  classifyEffects(
    input: RuntimeJsonValueV1,
    context?: CapabilityTurnContextV1,
  ): ReturnType<CapabilityEffectsClassifierV1>;
  projectExecutionTraits(
    input: RuntimeJsonValueV1,
    context?: CapabilityTurnContextV1,
  ): CapabilityExecutionTraitsV1;
}

export interface BuiltinModelToolCatalogEntryV1 extends BuiltinToolCatalogEntryCommonV1 {
  readonly visibility: 'model';
  readonly name: string;
  readonly descriptor: CapabilityDescriptorV1;
  /** Runtime-contract descriptor projected from the same frozen SPI descriptor. */
  readonly runtimeDescriptor: RuntimeCapabilityDescriptor;
  /**
   * Compiles operation-specific policy facts from this entry's canonical
   * parser. Authorization mode and grant matching are intentionally absent.
   */
  readonly compilePolicy: (
    input: RuntimeJsonValueV1,
    context?: CapabilityPolicyContextV1,
  ) => CapabilityPolicyCompilationV1;
}

export interface BuiltinInternalOperationCatalogEntryV1 extends BuiltinToolCatalogEntryCommonV1 {
  readonly visibility: 'internal';
  readonly name?: never;
  readonly descriptor: CapabilityInternalDescriptorV1;
}

export type BuiltinToolCatalogEntryV1 =
  | BuiltinModelToolCatalogEntryV1
  | BuiltinInternalOperationCatalogEntryV1;

export interface BuiltinToolCatalogProjectionV1 {
  /** Stable revision composed only from the frozen registered definitions. */
  readonly revision: string;
  /** Includes model-visible and internal operations for parity/audit. */
  readonly entries: readonly BuiltinToolCatalogEntryV1[];
  /** Model-facing ToolSet; entries without model visibility are never exposed. */
  readonly toolSet: ToolSet;
  /** Re-projects one immutable snapshot for a new turn context. */
  forTurn(context: CapabilityTurnContextV1): BuiltinToolCatalogProjectionV1;
  /**
   * Dispatches one exact operation through the Host-selected execution port.
   * The projection never selects a second handler or calls an executor itself.
   */
  dispatch(
    operationId: string,
    port: CapabilityExecutionPortV1,
    invocation: CapabilityExecutionInvocationV1,
  ): Promise<ExecutionReceiptV1>;
}

export interface CreateBuiltinToolCatalogProjectionOptionsV1 {
  /** One immutable turn context consumed by all definition availability gates. */
  readonly turnContext?: CapabilityTurnContextV1;
}

/**
 * Build the sole Builtin catalog projection from the already-frozen SPI
 * registry. Schemas, capability revisions, and executor revisions are copied
 * from registered definitions; no Core registry or hand-written schema table
 * participates in this projection.
 */
export function createBuiltinToolCatalogProjectionV1(
  registryOrSnapshot: RuntimeModuleRegistryV1 | CapabilityRegistrySnapshotV1,
  options: CreateBuiltinToolCatalogProjectionOptionsV1 = {},
): BuiltinToolCatalogProjectionV1 {
  const snapshot =
    'snapshot' in registryOrSnapshot ? registryOrSnapshot.snapshot() : registryOrSnapshot;
  assertFrozenBuiltinRegistrySnapshotV1(snapshot);
  const turnContext = options.turnContext ?? EMPTY_TURN_CONTEXT_V1;
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
      const availabilityDecision: CapabilityAvailabilityDecisionV1 = definition.availability?.(
        turnContext,
      ) ?? { status: 'available' };
      const availability = normalizeBuiltinAvailabilityV1(availabilityDecision);
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
      const executionMechanism = requireBuiltinExecutionMechanismV1(definition);
      const descriptor = definition.descriptor ?? createFallbackDescriptorV1(definition);
      if (descriptor.executionMechanism !== executionMechanism) {
        throw new Error(
          `Builtin capability descriptor mechanism mismatch: ${definition.capabilityId}`,
        );
      }
      const modelInputSchema = definition.modelInputSchemaForContext
        ? definition.modelInputSchemaForContext(turnContext)
        : definition.modelInputSchema;
      const frozenModelInputSchema = modelInputSchema
        ? freezeRuntimeJsonRecordV1(modelInputSchema)
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
        projectApprovalSummary(
          input: RuntimeJsonValueV1,
          context?: CapabilityTurnContextV1,
        ): string {
          return (
            definition.approvalSummary?.(input, context ?? turnContext) ??
            definition.toolName ??
            definition.capabilityId
          );
        },
        parse(input: unknown, context?: CapabilityTurnContextV1): CapabilityParseResultV1 {
          return parser.parse(input, context ?? turnContext);
        },
        parseModelInput(
          input: unknown,
          context?: CapabilityTurnContextV1,
        ): CapabilityParseResultV1 {
          return (definition.modelParser ?? parser).parse(input, context ?? turnContext);
        },
        canonicalize(input: unknown, context?: CapabilityTurnContextV1): RuntimeJsonValueV1 {
          return parser.canonicalize(input, context ?? turnContext);
        },
        observeUnknownFields(
          input: unknown,
          context?: CapabilityTurnContextV1,
        ): CapabilityUnknownFieldObservationV1 {
          return parser.observeUnknownFields(input, context ?? turnContext);
        },
        classifyEffects(input: RuntimeJsonValueV1, context?: CapabilityTurnContextV1) {
          return (
            definition.effectsClassifier?.(input, context ?? turnContext) ??
            defaultEffectsClassificationV1(definition.effects)
          );
        },
        projectExecutionTraits(input: RuntimeJsonValueV1, context?: CapabilityTurnContextV1) {
          const effectiveContext = context ?? turnContext;
          const invocationEffects =
            definition.effectsClassifier?.(input, effectiveContext) ??
            defaultEffectsClassificationV1(definition.effects);
          return (
            definition.executionTraitsProjector?.(input, effectiveContext, invocationEffects) ??
            projectBuiltinExecutionTraitsV1(
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
          input: RuntimeJsonValueV1,
          context?: CapabilityPolicyContextV1,
        ): CapabilityPolicyCompilationV1 => {
          const policyContext = normalizeBuiltinPolicyContextV1(context ?? turnContext);
          const canonicalInput = parser.canonicalize(input, policyContext);
          const compiled = definition.policyCompiler!(canonicalInput, policyContext);
          return validateBuiltinPolicyCompilationV1(compiled, definition, parser, policyContext);
        };
        return Object.freeze({
          ...commonEntry,
          visibility: 'model' as const,
          name: definition.toolName,
          descriptor,
          runtimeDescriptor: createRuntimeContractDescriptorV1(descriptor),
          compilePolicy,
        }) satisfies BuiltinModelToolCatalogEntryV1;
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
      }) satisfies BuiltinInternalOperationCatalogEntryV1;
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

  const toolSet = createBuiltinModelToolSetV1(frozenEntries, turnContext);
  const revision = digestCatalogRevisionV1(snapshot, frozenEntries);
  const entryByOperationId = new Map(frozenEntries.map((entry) => [entry.operationId, entry]));
  const definitionByOperationId = new Map(
    snapshot.capabilities.map(({ definition }) => [definition.capabilityId, definition]),
  );

  return Object.freeze({
    revision,
    entries: frozenEntries,
    toolSet,
    forTurn(context: CapabilityTurnContextV1): BuiltinToolCatalogProjectionV1 {
      return createBuiltinToolCatalogProjectionV1(snapshot, { turnContext: context });
    },
    async dispatch(
      operationId: string,
      port: CapabilityExecutionPortV1,
      invocation: CapabilityExecutionInvocationV1,
    ): Promise<ExecutionReceiptV1> {
      const entry = entryByOperationId.get(operationId);
      if (!entry) throw new Error(`Unknown Builtin capability operation: ${operationId}`);
      const definition = definitionByOperationId.get(operationId);
      if (!definition) throw new Error(`Builtin capability definition is missing: ${operationId}`);
      const bindingFailure = capabilityBindingIdentityFailureV1(definition, invocation.binding);
      const expectedBindingId = digestCapabilityBindingValueV1({
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
export function createBuiltinModelToolSetV1(
  entries: readonly BuiltinToolCatalogEntryV1[],
  context?: CapabilityTurnContextV1,
): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.visibility !== 'model' || entry.availability !== 'available') continue;
    if (!entry.name || !(entry.modelInputSchema ?? entry.inputSchema)) continue;
    tools[entry.name] = dynamicTool({
      description: context?.promptContractV2 ? entry.modelDescription : entry.description,
      inputSchema: jsonSchema(
        (entry.modelInputSchema ?? entry.inputSchema) as Parameters<typeof jsonSchema>[0],
      ),
    });
  }
  return Object.freeze(tools) as ToolSet;
}

const EMPTY_TURN_CONTEXT_V1: CapabilityTurnContextV1 = Object.freeze({});

function normalizeBuiltinPolicyContextV1(
  context: CapabilityTurnContextV1,
): CapabilityPolicyContextV1 {
  return Object.freeze({
    ...context,
    workspace: context.workspace ?? '',
    phase: context.phase ?? 'building',
  });
}

function validateBuiltinPolicyCompilationV1(
  compiled: CapabilityPolicyCompilationV1,
  definition: CapabilityRegistrySnapshotV1['capabilities'][number]['definition'],
  parser: CapabilityParserV1,
  _context: CapabilityPolicyContextV1,
): CapabilityPolicyCompilationV1 {
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
    typeof compiled.sameCommandMayBypassApproval !== 'boolean'
  ) {
    throw new Error(`Builtin policy compilation facts are invalid: ${definition.capabilityId}`);
  }
  return freezeBuiltinPolicyCompilationV1(compiled);
}

function freezeBuiltinPolicyCompilationV1(
  compiled: CapabilityPolicyCompilationV1,
): CapabilityPolicyCompilationV1 {
  return Object.freeze({
    ...compiled,
    ...(compiled.effects ? { effects: Object.freeze({ ...compiled.effects }) } : {}),
    ...(compiled.recovery ? { recovery: Object.freeze({ ...compiled.recovery }) } : {}),
    effectiveEffects: Object.freeze({ ...compiled.effectiveEffects }),
    expectedEffects: Object.freeze([...compiled.expectedEffects]),
  });
}

function assertFrozenBuiltinRegistrySnapshotV1(snapshot: CapabilityRegistrySnapshotV1): void {
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

function normalizeBuiltinAvailabilityV1(
  decision: CapabilityAvailabilityDecisionV1,
): Readonly<{ status: BuiltinToolAvailabilityV1; reason?: string }> {
  return Object.freeze({
    status: decision.status,
    ...(decision.reason ? { reason: decision.reason } : {}),
  });
}

function createFallbackDescriptorV1(
  definition: CapabilityRegistrySnapshotV1['capabilities'][number]['definition'],
): CapabilityDescriptorV1 | CapabilityInternalDescriptorV1 {
  const effects = definition.effects ?? {
    filesystem: 'unknown' as const,
    network: 'unknown' as const,
    externalState: 'unknown' as const,
  };
  return Object.freeze({
    capabilityId: definition.capabilityId,
    revision: definition.revision,
    kind: 'builtin_tool',
    executionMechanism: requireBuiltinExecutionMechanismV1(definition),
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

function requireBuiltinExecutionMechanismV1(
  definition: CapabilityRegistrySnapshotV1['capabilities'][number]['definition'],
): CapabilityExecutionMechanismV1 {
  const mechanism = definition.executionMechanism;
  if (mechanism === undefined || !CAPABILITY_EXECUTION_MECHANISMS_V1.includes(mechanism)) {
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
function createRuntimeContractDescriptorV1(
  descriptor: CapabilityDescriptorV1,
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

function defaultEffectsClassificationV1(
  effects: CapabilityEffectsV1 | undefined,
): ReturnType<CapabilityEffectsClassifierV1> {
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

function digestCatalogRevisionV1(
  snapshot: CapabilityRegistrySnapshotV1,
  entries: readonly BuiltinToolCatalogEntryV1[],
): string {
  return digestCapabilityBindingValueV1({
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

function freezeRuntimeJsonRecordV1(
  value: Readonly<Record<string, RuntimeJsonValueV1>>,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeRuntimeJsonValueV1(item)]),
    ),
  );
}

function freezeRuntimeJsonValueV1(value: RuntimeJsonValueV1): RuntimeJsonValueV1 {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeRuntimeJsonValueV1));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return freezeRuntimeJsonRecordV1(value as Readonly<Record<string, RuntimeJsonValueV1>>);
  }
  return value;
}
