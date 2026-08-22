import type {
  CapabilityApprovalSummaryProjectorV1,
  CapabilityApprovalV1,
  CapabilityAvailabilityResolverV1,
  CapabilityDefinitionV1,
  CapabilityDescriptorV1,
  CapabilityEffectsClassifierV1,
  CapabilityEffectsV1,
  CapabilityExecutionPolicyV1,
  CapabilityExecutionTraitsDeclarationV1,
  CapabilityExecutionTraitsProjectorV1,
  CapabilityExecutionTraitsV1,
  CapabilityInternalDescriptorV1,
  CapabilityInvocationEffectsV1,
  CapabilityParseResultV1,
  CapabilityParserV1,
  CapabilityPolicyCompilerV1,
  CapabilityResourceScopeV1,
  CapabilityTurnContextV1,
  CapabilityUnknownFieldObservationV1,
  RuntimeJsonValueV1,
} from '@kite/runtime-spi';
import { z } from 'zod';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import { buildDescription, getToolContract, normalizeToolContract } from './tool-contracts';
import {
  BUILTIN_JSON_SCHEMAS_V1,
  BUILTIN_TASK_LEGACY_PLANNING_SCHEMA_V1,
  BUILTIN_TASK_PUBLIC_SCHEMA_V1,
  BUILTIN_TASK_RUNTIME_SCHEMA_V1,
  BUILTIN_ZOD_SCHEMAS_V1,
  type BuiltinOperationIdV1,
  builtinJsonSchemaV1,
} from './tool-schemas';

export type BuiltinToolTurnContextV1 = CapabilityTurnContextV1;

export interface BuiltinToolContractOptionsV1 {
  readonly parser: CapabilityParserV1;
  readonly modelParser?: CapabilityParserV1;
  /** Zod source for the model-facing parser; it may differ from runtime input. */
  readonly modelSchema?: z.ZodType;
  /** Context-selected Zod source for model-facing schema variants. */
  readonly modelSchemaForContext?: (context: CapabilityTurnContextV1) => z.ZodType;
  readonly modelInputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly modelInputSchemaForContext?: (
    context: CapabilityTurnContextV1,
  ) => Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly kind?: CapabilityDefinitionV1['kind'];
  /** Runtime-backed descriptors reuse the capability revision; static descriptors use content. */
  readonly descriptorRevisionSource?: 'capability' | 'content';
  readonly minimumApproval?: CapabilityApprovalV1;
  readonly workspaceTrustRequired?: boolean;
  readonly governanceRevision?: string;
  readonly executionTraitsDeclaration?: CapabilityExecutionTraitsDeclarationV1;
  readonly executionTraitsProjector?: CapabilityExecutionTraitsProjectorV1;
  readonly effectsClassifier?: CapabilityEffectsClassifierV1;
  readonly approvalSummary?: CapabilityApprovalSummaryProjectorV1;
  readonly availability?: CapabilityAvailabilityResolverV1;
  readonly execution?: CapabilityExecutionPolicyV1;
  /** Operation-specific policy facts; authorization is intentionally absent. */
  readonly policyCompiler?: CapabilityPolicyCompilerV1;
}

/**
 * The minimum typed model-surface facts needed to format a parse diagnostic.
 *
 * This deliberately accepts a catalog-shaped entry rather than a ToolSpec,
 * Core registry, or Zod schema.  The catalog is the only authority for the
 * disclosed Builtin schema; MCP and unknown names are handled by the generic
 * formatter without importing or inspecting their provider schema.
 */
export interface BuiltinToolSchemaHintEntryV1 {
  readonly name: string;
  readonly inputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
  readonly modelInputSchema?: Readonly<Record<string, RuntimeJsonValueV1>>;
}

/** Format the model-facing schema and contract constraints from one catalog entry. */
export function formatBuiltinToolSchemaHintV1(entry: BuiltinToolSchemaHintEntryV1): string {
  const schema = entry.modelInputSchema ?? entry.inputSchema;
  const properties = schemaRecordFieldV1(schema, 'properties');
  const required = schemaStringArrayFieldV1(schema, 'required');
  const contract = getToolContract(entry.name);
  const constraints = contract ? normalizeToolContract(contract.sections).constraints : '';
  return [
    `Arguments must match the disclosed JSON schema fields: ${Object.keys(properties).join(', ') || '(none)'}.`,
    required.length > 0 ? `Required fields: ${required.join(', ')}.` : '',
    constraints,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Generic parse-error formatter for a model-facing Builtin entry.
 *
 * The optional entry is intentionally structural so callers can pass the
 * immutable projection entry without coupling this formatter to the catalog
 * implementation.  No fallback parser or schema is selected here.
 */
export function formatBuiltinToolParseErrorV1(input: {
  readonly toolName: string;
  readonly rawArgs: string;
  readonly parseError: string;
  readonly entry?: BuiltinToolSchemaHintEntryV1;
}): string {
  const schemaHint = input.entry
    ? formatBuiltinToolSchemaHintV1(input.entry)
    : input.toolName.startsWith('mcp__')
      ? "MCP tool — check the Available MCP Tools section in the system prompt for this tool's JSON schema. Arguments must be a valid JSON object."
      : 'Unknown tool. Arguments must be a valid JSON object with tool-specific fields.';
  const truncatedArgs =
    input.rawArgs.length > 1200 ? `${input.rawArgs.slice(0, 1200)}...` : input.rawArgs;

  return [
    `**Tool**: \`${input.toolName}\``,
    ``,
    `**Your arguments** (raw, could not be parsed as JSON):`,
    '```json',
    truncatedArgs,
    '```',
    ``,
    `**Parse error**: ${input.parseError}`,
    ``,
    `**Expected format**:`,
    schemaHint,
  ].join('\n');
}

function schemaRecordFieldV1(
  schema: Readonly<Record<string, RuntimeJsonValueV1>> | undefined,
  field: string,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  const value = schema?.[field];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, RuntimeJsonValueV1>>)
    : {};
}

function schemaStringArrayFieldV1(
  schema: Readonly<Record<string, RuntimeJsonValueV1>> | undefined,
  field: string,
): readonly string[] {
  const value = schema?.[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export interface BuiltinExecutionTraitsInputV1 {
  readonly resourceScopes: readonly CapabilityResourceScopeV1[];
  readonly conflictKeys?: readonly string[];
  readonly isolation?: CapabilityExecutionTraitsDeclarationV1['isolation'];
  readonly interactionBarrier?: boolean;
  readonly concurrencyGroup?: string;
  readonly leaseFenceRequired?: boolean;
}

export function builtinExecutionTraitsV1(
  input: BuiltinExecutionTraitsInputV1,
): CapabilityExecutionTraitsDeclarationV1 {
  return Object.freeze({
    resourceScopes: Object.freeze(input.resourceScopes.map((scope) => Object.freeze({ ...scope }))),
    ...(input.conflictKeys ? { conflictKeys: Object.freeze([...input.conflictKeys]) } : {}),
    ...(input.isolation ? { isolation: input.isolation } : {}),
    interactionBarrier: input.interactionBarrier ?? true,
    ...(input.concurrencyGroup ? { concurrencyGroup: input.concurrencyGroup } : {}),
    leaseFenceRequired: input.leaseFenceRequired ?? true,
  });
}

/** Project full scheduler identity from the same invocation effects and turn facts. */
export function projectBuiltinExecutionTraitsV1(
  declaration: CapabilityExecutionTraitsDeclarationV1 | undefined,
  _input: RuntimeJsonValueV1,
  context: CapabilityTurnContextV1,
  effects: import('@kite/runtime-spi').CapabilityInvocationEffectsV1,
): CapabilityExecutionTraitsV1 {
  const access =
    effects.effectClass === 'read_only' && effects.sideEffect === false
      ? 'read'
      : effects.effectClass === 'workspace_write' || effects.sideEffect === true
        ? 'write'
        : 'unknown';
  const resourceScopes = declaration?.resourceScopes ?? [
    { kind: 'runtime' as const, key: 'capability' },
  ];
  const conflictKeys =
    access === 'read'
      ? []
      : declaration?.conflictKeys && declaration.conflictKeys.length > 0
        ? declaration.conflictKeys
        : ['workspace'];
  const isolation =
    access === 'read'
      ? 'shared'
      : declaration?.isolation === 'exclusive_workspace' || declaration?.isolation === 'worktree'
        ? declaration.isolation
        : 'exclusive_workspace';
  return Object.freeze({
    resourceScopes: Object.freeze(resourceScopes.map((scope) => Object.freeze({ ...scope }))),
    access,
    conflictKeys: Object.freeze([...conflictKeys]),
    isolation,
    causalGroup: `${context.taskId ?? context.activeTaskId ?? ''}\0${context.modelMessageId ?? context.toolCallId ?? ''}`,
    interactionBarrier: declaration?.interactionBarrier ?? true,
    ...(declaration?.concurrencyGroup ? { concurrencyGroup: declaration.concurrencyGroup } : {}),
    leaseFenceRequired: declaration?.leaseFenceRequired ?? true,
  });
}

/**
 * Adds the Builtin-owned contract to one already-declared SPI capability.
 * Registration JSON schemas are generated aliases of the Zod source in
 * `tool-schemas.ts`; the parity assertion below proves that the parser and
 * registration consume the same source and preserve the existing digest.
 */
export function defineBuiltinCapabilityContractV1(
  definition: CapabilityDefinitionV1,
  options: BuiltinToolContractOptionsV1,
): CapabilityDefinitionV1 {
  if (!definition.executionMechanism) {
    throw new Error(
      `Builtin capability is missing its execution mechanism: ${definition.capabilityId}`,
    );
  }
  if (!definition.inputSchema) {
    throw new Error(`Builtin capability is missing an input schema: ${definition.capabilityId}`);
  }
  assertParserSchemaParityV1(definition, options.parser);
  if (options.modelParser) {
    assertModelSchemaParityV1(definition, options);
  }
  const parser = Object.freeze({
    ...options.parser,
    schemaDigest: definition.inputSchemaDigest ?? options.parser.schemaDigest,
  });
  const declaredEffects = definition.effects ?? {
    filesystem: 'unknown' as const,
    network: 'unknown' as const,
    externalState: 'unknown' as const,
  };
  const kind =
    options.kind ?? (definition.visibility === 'model' ? 'computer' : 'internal_runtime');
  const descriptorKind = definition.visibility === 'model' ? 'builtin_tool' : 'internal_runtime';
  const minimumApproval = options.minimumApproval ?? 'none';
  const description = definition.description ?? definition.title;
  const modelDescription =
    definition.modelDescription ??
    (definition.toolName && getToolContract(definition.toolName)
      ? buildDescription(getToolContract(definition.toolName)!.sections, 'v2')
      : description);
  const descriptorRevisionBase = {
    capabilityId: definition.capabilityId,
    kind: descriptorKind,
    displayName: definition.toolName ?? definition.capabilityId,
    description,
    modelDescription,
    descriptionProvenance: 'builtin',
    provider: Object.freeze({
      type: 'builtin',
      id: definition.visibility === 'model' ? 'kite-code' : definition.providerId,
      provenance: 'builtin',
    }),
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
    declaredEffects,
    effectiveEffects: declaredEffects,
    policy: Object.freeze({
      workspaceTrustRequired: options.workspaceTrustRequired ?? false,
      minimumApproval,
      ...(options.governanceRevision ? { governanceRevision: options.governanceRevision } : {}),
    }),
    availability: 'available',
    diagnostics: [],
  } satisfies
    | Omit<CapabilityDescriptorV1, 'revision'>
    | Omit<CapabilityInternalDescriptorV1, 'revision'>;
  const descriptorBase = {
    ...descriptorRevisionBase,
    executionMechanism: definition.executionMechanism,
  } satisfies
    | Omit<CapabilityDescriptorV1, 'revision'>
    | Omit<CapabilityInternalDescriptorV1, 'revision'>;
  const descriptor = {
    ...descriptorBase,
    revision:
      options.descriptorRevisionSource === 'content'
        ? digestCapabilityBindingValueV1(descriptorRevisionBase)
        : definition.revision,
  };
  // Mechanism metadata is a projection fact and must not perturb the
  // established content-descriptor revision digest.
  Object.defineProperty(descriptor, 'executionMechanism', {
    value: definition.executionMechanism,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const frozenDescriptor = Object.freeze(descriptor) as
    | CapabilityDescriptorV1
    | CapabilityInternalDescriptorV1;
  return Object.freeze({
    ...definition,
    kind,
    modelDescription,
    parser,
    ...(options.modelParser ? { modelParser: options.modelParser } : {}),
    ...(options.modelInputSchema ? { modelInputSchema: options.modelInputSchema } : {}),
    ...(options.modelInputSchemaForContext
      ? { modelInputSchemaForContext: options.modelInputSchemaForContext }
      : {}),
    ...(options.availability ? { availability: options.availability } : {}),
    ...(options.effectsClassifier ? { effectsClassifier: options.effectsClassifier } : {}),
    approvalSummary:
      options.approvalSummary ?? builtinApprovalSummaryProjectorV1(definition.capabilityId),
    ...(options.executionTraitsDeclaration
      ? { executionTraitsDeclaration: options.executionTraitsDeclaration }
      : {}),
    executionTraitsProjector:
      options.executionTraitsProjector ??
      ((
        input: RuntimeJsonValueV1,
        context: CapabilityTurnContextV1,
        invocationEffects: CapabilityInvocationEffectsV1,
      ) =>
        projectBuiltinExecutionTraitsV1(
          options.executionTraitsDeclaration,
          input,
          context,
          invocationEffects,
        )),
    minimumApproval,
    workspaceTrustRequired: options.workspaceTrustRequired ?? false,
    ...(options.governanceRevision ? { governanceRevision: options.governanceRevision } : {}),
    ...(options.execution ? { execution: options.execution } : {}),
    ...(options.policyCompiler ? { policyCompiler: options.policyCompiler } : {}),
    descriptor: frozenDescriptor,
  });
}

export interface CreateBuiltinZodParserOptionsV1 {
  readonly parserRevision: string;
  readonly schemaDigest?: string;
  readonly schema?: z.ZodType;
  readonly schemaForContext?: (context: CapabilityTurnContextV1 | undefined) => z.ZodType;
  readonly knownFields: readonly string[];
  readonly knownFieldsForContext?: (
    context: CapabilityTurnContextV1 | undefined,
  ) => readonly string[];
}

export function createBuiltinZodParserV1(
  options: CreateBuiltinZodParserOptionsV1,
): CapabilityParserV1 {
  if (!options.schema && !options.schemaForContext) {
    throw new Error('Builtin parser requires a schema');
  }
  const selectSchema = (context?: CapabilityTurnContextV1): z.ZodType =>
    options.schemaForContext?.(context) ?? options.schema!;
  const selectKnownFields = (context?: CapabilityTurnContextV1): readonly string[] =>
    options.knownFieldsForContext?.(context) ?? options.knownFields;
  const parse = (value: unknown, context?: CapabilityTurnContextV1): CapabilityParseResultV1 => {
    const parsed = selectSchema(context).safeParse(value);
    if (!parsed.success) {
      return Object.freeze({
        success: false,
        issues: Object.freeze(
          parsed.error.issues.map((issue) =>
            Object.freeze({
              code: issue.code,
              path: Object.freeze(
                issue.path.map((part): string | number =>
                  typeof part === 'number' || typeof part === 'string' ? part : String(part),
                ),
              ),
              message: issue.message,
            }),
          ),
        ),
      });
    }
    return Object.freeze({
      success: true,
      data: freezeRuntimeJsonV1(toRuntimeJsonV1(parsed.data)),
    });
  };
  return Object.freeze({
    parserRevision: options.parserRevision,
    schemaDigest:
      options.schemaDigest ?? digestCapabilityBindingValueV1(z.toJSONSchema(selectSchema())),
    knownFields: Object.freeze([...options.knownFields]),
    parse,
    canonicalize(value: unknown, context?: CapabilityTurnContextV1): RuntimeJsonValueV1 {
      const result = parse(value, context);
      if (!result.success) {
        const issue = result.issues[0];
        throw new Error(
          issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid Builtin input',
        );
      }
      return result.data;
    },
    observeUnknownFields(
      value: unknown,
      context?: CapabilityTurnContextV1,
    ): CapabilityUnknownFieldObservationV1 {
      const record =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Readonly<Record<string, unknown>>)
          : undefined;
      const known = new Set(selectKnownFields(context));
      const fields = Object.keys(record ?? {})
        .filter((field) => !known.has(field))
        .sort();
      return Object.freeze({
        schemaRevision: options.parserRevision,
        fields: Object.freeze(fields),
        count: fields.length,
      });
    },
  });
}

function assertParserSchemaParityV1(
  definition: CapabilityDefinitionV1,
  parser: CapabilityParserV1,
): void {
  const operationId = definition.capabilityId as BuiltinOperationIdV1;
  const schema = BUILTIN_ZOD_SCHEMAS_V1[operationId];
  if (!schema) return;
  const generated = BUILTIN_JSON_SCHEMAS_V1[operationId];
  const generatedDigest = digestCapabilityBindingValueV1(generated);
  if (
    definition.inputSchema &&
    generatedDigest !== digestCapabilityBindingValueV1(definition.inputSchema)
  ) {
    throw new Error(`Builtin parser/schema parity mismatch: ${definition.capabilityId}`);
  }
  if (
    parser.parserRevision.trim() !== parser.parserRevision ||
    parser.parserRevision.length === 0
  ) {
    throw new Error(`Builtin parser revision is not canonical: ${definition.capabilityId}`);
  }
}

function assertParserContractV1(parser: CapabilityParserV1, capabilityId: string): void {
  if (
    parser.parserRevision.trim() !== parser.parserRevision ||
    parser.parserRevision.length === 0
  ) {
    throw new Error(`Builtin model parser revision is not canonical: ${capabilityId}`);
  }
  if (!parser.schemaDigest) {
    throw new Error(`Builtin model parser schema digest is missing: ${capabilityId}`);
  }
}

function assertModelSchemaParityV1(
  definition: CapabilityDefinitionV1,
  options: BuiltinToolContractOptionsV1,
): void {
  const parser = options.modelParser;
  if (!parser) throw new Error(`Builtin model parser is missing: ${definition.capabilityId}`);
  assertParserContractV1(parser, definition.capabilityId);
  const sourceSchemaForContext = options.modelSchemaForContext
    ? options.modelSchemaForContext
    : options.modelSchema
      ? () => options.modelSchema!
      : undefined;
  const projectedSchemaForContext = options.modelInputSchemaForContext
    ? options.modelInputSchemaForContext
    : options.modelInputSchema
      ? () => options.modelInputSchema!
      : undefined;
  if (!sourceSchemaForContext || !projectedSchemaForContext) {
    throw new Error(`Builtin model schema projection is missing: ${definition.capabilityId}`);
  }

  const contexts: readonly CapabilityTurnContextV1[] = [
    Object.freeze({ phase: 'building', promptContractV2: true }),
    Object.freeze({ phase: 'planning', promptContractV2: false }),
  ];
  for (const context of contexts) {
    const source = builtinJsonSchemaV1(sourceSchemaForContext(context));
    const projected = projectedSchemaForContext(context);
    if (digestCapabilityBindingValueV1(source) !== digestCapabilityBindingValueV1(projected)) {
      throw new Error(`Builtin model parser/schema parity mismatch: ${definition.capabilityId}`);
    }
  }
  const publicSchema = builtinJsonSchemaV1(sourceSchemaForContext(contexts[0]!));
  if (parser.schemaDigest !== digestCapabilityBindingValueV1(publicSchema)) {
    throw new Error(`Builtin model parser digest mismatch: ${definition.capabilityId}`);
  }
}

export function parserForBuiltinOperationV1(
  operationId: BuiltinOperationIdV1,
  revision: string,
): CapabilityParserV1 {
  const schema = BUILTIN_ZOD_SCHEMAS_V1[operationId];
  if (!schema) throw new Error(`Builtin parser schema is missing: ${operationId}`);
  const knownFields = topLevelSchemaFieldsV1(schema);
  return createBuiltinZodParserV1({
    schema,
    parserRevision: revision,
    knownFields,
    schemaDigest: digestCapabilityBindingValueV1(BUILTIN_JSON_SCHEMAS_V1[operationId]),
  });
}

export function taskRuntimeParserV1(revision: string): CapabilityParserV1 {
  return createBuiltinZodParserV1({
    schema: BUILTIN_TASK_RUNTIME_SCHEMA_V1,
    parserRevision: revision,
    knownFields: ['subagent_type', 'task', 'taskArtifact'],
    schemaDigest: digestCapabilityBindingValueV1(BUILTIN_JSON_SCHEMAS_V1['builtin:task']),
  });
}

export function taskModelParserV1(revision: string): CapabilityParserV1 {
  return createBuiltinZodParserV1({
    parserRevision: revision,
    schemaForContext: taskModelSchemaV1,
    knownFields: ['subagent_type', 'task'],
    schemaDigest: digestCapabilityBindingValueV1(z.toJSONSchema(BUILTIN_TASK_PUBLIC_SCHEMA_V1)),
  });
}

export function taskModelSchemaV1(context?: CapabilityTurnContextV1): z.ZodType {
  return !context?.promptContractV2 && context?.phase === 'planning'
    ? BUILTIN_TASK_LEGACY_PLANNING_SCHEMA_V1
    : BUILTIN_TASK_PUBLIC_SCHEMA_V1;
}

export function taskModelInputSchemaV1(
  context: CapabilityTurnContextV1,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  const schema = taskModelSchemaV1(context);
  return builtinJsonSchemaV1(schema);
}

export function staticEffectsClassifierV1(
  effectClass: 'read_only' | 'plan_only' | 'workspace_write' | 'external_side_effect' | 'unknown',
  sideEffect: boolean,
  classificationReason: string,
  effectiveEffects: CapabilityDefinitionV1['effects'],
): CapabilityEffectsClassifierV1 {
  const effects = effectiveEffects ?? {
    filesystem: 'unknown' as const,
    network: 'unknown' as const,
    externalState: 'unknown' as const,
  };
  return (_input, _context) =>
    Object.freeze({
      effectClass,
      sideEffect,
      classificationReason,
      risk: riskFromInvocationEffectsV1(effectClass, effects),
      effectiveEffects: effects,
    });
}

export const alwaysAvailableV1: CapabilityAvailabilityResolverV1 = () =>
  Object.freeze({ status: 'available' as const });

export const toolSearchAvailabilityV1: CapabilityAvailabilityResolverV1 = (context) =>
  context.toolSearchEnabled === true
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({ status: 'hidden' as const, reason: 'tool_search_disabled' });

export const gitAvailabilityV1: CapabilityAvailabilityResolverV1 = (context) =>
  context.featureFlags?.brokeredGitV1 === true &&
  context.hasGitBroker === true &&
  context.brokeredGitFeatureRevision === 'brokered-git-r1'
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({ status: 'hidden' as const, reason: 'brokered_git_unavailable' });

export const taskAvailabilityV1: CapabilityAvailabilityResolverV1 = (context) =>
  context.hasTaskAdapter === true
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({ status: 'hidden' as const, reason: 'task_adapter_unavailable' });

export const readSkillAvailabilityV1: CapabilityAvailabilityResolverV1 = (context) =>
  (context.activeSkillFrameIds?.length ?? 0) > 0
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({ status: 'hidden' as const, reason: 'no_active_skill_frame' });

export const activateSkillAvailabilityV1: CapabilityAvailabilityResolverV1 = (context) =>
  context.featureFlags?.skillWorkflowV1 === true &&
  context.featureFlags?.skillActivationV2 === true &&
  (context.availableSkillIds?.length ?? 0) > 0
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({ status: 'hidden' as const, reason: 'skill_activation_unavailable' });

export function taskEffectsClassifierV1(
  declaredEffects: CapabilityDefinitionV1['effects'],
): CapabilityEffectsClassifierV1 {
  const effects = declaredEffects ?? {
    filesystem: 'unknown' as const,
    network: 'unknown' as const,
    externalState: 'none' as const,
  };
  return (input) => {
    const role =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>).subagent_type
        : undefined;
    if (role === 'code') {
      return Object.freeze({
        effectClass: 'workspace_write' as const,
        sideEffect: true,
        classificationReason: 'Code sub-agent may modify the workspace.',
        risk: 'workspace_write' as const,
        effectiveEffects: Object.freeze({
          filesystem: 'write' as const,
          network: effects.network,
          externalState: effects.externalState,
        }),
      });
    }
    if (role === 'explore' || role === 'plan' || role === 'review') {
      return Object.freeze({
        effectClass: 'read_only' as const,
        sideEffect: false,
        classificationReason: `${String(role)} sub-agent is read-only by role.`,
        risk: 'read' as const,
        effectiveEffects: readOnlyEffectsV1(effects),
      });
    }
    return Object.freeze({
      effectClass: 'unknown' as const,
      sideEffect: true,
      classificationReason: 'Unknown sub-agent role is not safe to classify.',
      risk: 'unknown' as const,
      effectiveEffects: effects,
    });
  };
}

export function shellEffectsClassifierV1(
  declaredEffects: CapabilityDefinitionV1['effects'],
): CapabilityEffectsClassifierV1 {
  const effects = declaredEffects ?? {
    filesystem: 'unknown' as const,
    network: 'unknown' as const,
    externalState: 'unknown' as const,
  };
  return (input) => {
    const command =
      input && typeof input === 'object' && !Array.isArray(input)
        ? String((input as Record<string, unknown>).command ?? '')
        : '';
    const canonicalCommand = command.trim().replace(/\s+/g, ' ');
    const normalized = canonicalCommand.toLowerCase();
    if (isReadOnlyShellCommandV1(canonicalCommand)) {
      return Object.freeze({
        effectClass: 'read_only' as const,
        sideEffect: false,
        classificationReason: 'Shell command matches the conservative read-only allowlist.',
        risk: 'read' as const,
        effectiveEffects: readOnlyEffectsV1(effects),
      });
    }
    if (isNetworkShellCommandV1(normalized)) {
      return Object.freeze({
        effectClass: 'external_side_effect' as const,
        sideEffect: true,
        classificationReason: 'Shell command may access the network.',
        risk: isDestructiveShellCommandV1(normalized)
          ? ('destructive' as const)
          : ('network' as const),
        effectiveEffects: effects,
      });
    }
    if (
      isDestructiveShellCommandV1(normalized) ||
      isVcsMutationShellCommandV1(normalized) ||
      isWriteShellCommandV1(normalized)
    ) {
      return Object.freeze({
        effectClass: 'workspace_write' as const,
        sideEffect: true,
        classificationReason: 'Shell command may mutate files or version-control state.',
        risk: isDestructiveShellCommandV1(normalized)
          ? ('destructive' as const)
          : isVcsMutationShellCommandV1(normalized)
            ? ('external_state' as const)
            : ('workspace_write' as const),
        effectiveEffects: Object.freeze({
          filesystem: 'write' as const,
          network: effects.network,
          externalState: effects.externalState,
        }),
      });
    }
    return Object.freeze({
      effectClass: 'unknown' as const,
      sideEffect: true,
      classificationReason: 'Shell command could not be proven read-only.',
      risk: 'unknown' as const,
      effectiveEffects: effects,
    });
  };
}

const READ_ONLY_SHELL_COMMANDS_V1 = new Set([
  'awk',
  'cat',
  'cut',
  'du',
  'echo',
  'file',
  'find',
  'grep',
  'head',
  'ls',
  'nl',
  'pwd',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'test',
  'tr',
  'uniq',
  'wc',
]);
const LOCAL_RUNTIME_VERSION_COMMANDS_V1 = new Set(['bun', 'node', 'npm', 'pnpm', 'yarn']);
const FILE_FLAG_OPTIONS_V1 = new Set([
  '--brief',
  '--checking-printout',
  '--exclude-quiet',
  '--extension',
  '--keep-going',
  '--mime',
  '--mime-encoding',
  '--mime-type',
  '--no-buffer',
  '--no-pad',
  '--print0',
  '--raw',
  '--special-files',
]);
const FILE_VALUE_OPTIONS_V1 = new Set([
  '--apple',
  '--exclude',
  '--magic-file',
  '--parameter',
  '--separator',
]);

function isReadOnlyFileV1(tokens: string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotesV1(tokens[index] ?? '');
    if (token === '--') return true;
    if (!token.startsWith('-') || token === '-') continue;
    if (FILE_FLAG_OPTIONS_V1.has(token)) continue;
    const longName = token.split('=', 1)[0]!;
    if (FILE_VALUE_OPTIONS_V1.has(longName)) {
      if (!token.includes('=') && !tokens[index + 1]) return false;
      if (!token.includes('=')) index += 1;
      continue;
    }
    if (/^-[bcEhikLlNnPrs]+$/.test(token)) continue;
    if (/^-[deFm].+/.test(token)) continue;
    if (['-d', '-e', '-F', '-m'].includes(token)) {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

const FIND_BOOLEAN_TOKENS_V1 = new Set([
  '!',
  '(',
  ')',
  ',',
  '-a',
  '-and',
  '-daystart',
  '-empty',
  '-executable',
  '-false',
  '-follow',
  '-ignore_readdir_race',
  '-ls',
  '-mount',
  '-noignore_readdir_race',
  '-noleaf',
  '-not',
  '-o',
  '-or',
  '-print',
  '-print0',
  '-prune',
  '-quit',
  '-readable',
  '-true',
  '-writable',
  '-xdev',
]);
const FIND_ONE_VALUE_TOKENS_V1 = new Set([
  '-amin',
  '-anewer',
  '-atime',
  '-cmin',
  '-cnewer',
  '-ctime',
  '-fstype',
  '-gid',
  '-group',
  '-ilname',
  '-iname',
  '-inum',
  '-ipath',
  '-iregex',
  '-links',
  '-lname',
  '-maxdepth',
  '-mindepth',
  '-mmin',
  '-mtime',
  '-name',
  '-newer',
  '-path',
  '-perm',
  '-printf',
  '-regex',
  '-regextype',
  '-samefile',
  '-size',
  '-type',
  '-uid',
  '-user',
  '-used',
  '-wholename',
  '-xtype',
]);

function isReadOnlyFindV1(tokens: string[]): boolean {
  let expressionStarted = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotesV1(tokens[index] ?? '');
    if (!expressionStarted && (/^-[HLP]$/.test(token) || /^-O\d+$/.test(token))) continue;
    if (!expressionStarted && token === '-D') {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    if (!expressionStarted && !token.startsWith('-') && !['!', '(', ')'].includes(token)) continue;
    expressionStarted = true;
    if (FIND_BOOLEAN_TOKENS_V1.has(token)) continue;
    if (/^-newer[A-Za-z]{2}$/.test(token) || FIND_ONE_VALUE_TOKENS_V1.has(token)) {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function isReadOnlySedScriptV1(script: string): boolean {
  const value = stripShellQuotesV1(script).trim();
  if (value.length < 4 || value[0] !== 's') return false;
  const delimiter = value[1]!;
  if (/\s|[A-Za-z0-9\\]/.test(delimiter)) return false;
  let cursor = 2;
  const consumeSection = (): boolean => {
    let escaped = false;
    for (; cursor < value.length; cursor += 1) {
      const char = value[cursor]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === delimiter) {
        cursor += 1;
        return true;
      }
    }
    return false;
  };
  if (!consumeSection() || !consumeSection()) return false;
  return /^[0-9gimpIM]*$/.test(value.slice(cursor));
}

function isReadOnlySedV1(tokens: string[]): boolean {
  const scripts: string[] = [];
  let sawBareScript = false;
  let optionsEnded = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotesV1(tokens[index] ?? '');
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if ((sawBareScript || optionsEnded) && token.startsWith('-') && token !== '-') return false;
    if (
      !sawBareScript &&
      [
        '-n',
        '--quiet',
        '--silent',
        '-E',
        '-r',
        '--regexp-extended',
        '-u',
        '--unbuffered',
        '-s',
        '--separate',
        '-z',
        '--null-data',
        '--sandbox',
      ].includes(token)
    ) {
      continue;
    }
    if (!sawBareScript && (token === '-e' || token === '--expression')) {
      const script = tokens[index + 1];
      if (!script) return false;
      scripts.push(script);
      index += 1;
      continue;
    }
    if (!sawBareScript && token.startsWith('--expression=')) {
      scripts.push(token.slice('--expression='.length));
      continue;
    }
    if (!sawBareScript && token.startsWith('-e') && token.length > 2) {
      scripts.push(token.slice(2));
      continue;
    }
    if (!sawBareScript && token.startsWith('-')) return false;
    if (!sawBareScript && scripts.length === 0) {
      scripts.push(tokens[index]!);
      sawBareScript = true;
      continue;
    }
    sawBareScript = true;
  }
  return scripts.length > 0 && scripts.every(isReadOnlySedScriptV1);
}

const SORT_FLAG_OPTIONS_V1 = new Set([
  '--check',
  '--debug',
  '--dictionary-order',
  '--general-numeric-sort',
  '--human-numeric-sort',
  '--ignore-case',
  '--ignore-leading-blanks',
  '--ignore-nonprinting',
  '--merge',
  '--month-sort',
  '--numeric-sort',
  '--random-sort',
  '--reverse',
  '--stable',
  '--unique',
  '--version-sort',
  '--zero-terminated',
]);
const SORT_VALUE_OPTIONS_V1 = new Set([
  '--batch-size',
  '--field-separator',
  '--key',
  '--parallel',
  '--random-source',
  '--sort',
]);

function isReadOnlySortV1(tokens: string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotesV1(tokens[index] ?? '');
    if (token === '--') return true;
    if (!token.startsWith('-') || token === '-') continue;
    if (SORT_FLAG_OPTIONS_V1.has(token)) continue;
    const longName = token.split('=', 1)[0]!;
    if (SORT_VALUE_OPTIONS_V1.has(longName)) {
      if (!token.includes('=') && !tokens[index + 1]) return false;
      if (!token.includes('=')) index += 1;
      continue;
    }
    if (/^-[bcCdfghinmMNRrSsuvVz]+$/.test(token)) continue;
    if (/^-[kt].+/.test(token)) continue;
    if (token === '-k' || token === '-t') {
      if (!tokens[index + 1]) return false;
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

const UNIQ_FLAG_OPTIONS_V1 = new Set([
  '--all-repeated',
  '--count',
  '--group',
  '--ignore-case',
  '--repeated',
  '--unique',
  '--zero-terminated',
]);
const UNIQ_VALUE_OPTIONS_V1 = new Set(['--check-chars', '--skip-chars', '--skip-fields']);

function isReadOnlyUniqV1(tokens: string[]): boolean {
  let operands = 0;
  let optionsEnded = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotesV1(tokens[index] ?? '');
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && UNIQ_FLAG_OPTIONS_V1.has(token)) continue;
    if (!optionsEnded) {
      const longName = token.split('=', 1)[0]!;
      if (UNIQ_VALUE_OPTIONS_V1.has(longName)) {
        if (!token.includes('=') && !tokens[index + 1]) return false;
        if (!token.includes('=')) index += 1;
        continue;
      }
      if (/^-[cduiz]+$/.test(token)) continue;
      if (/^-[fsw].+/.test(token)) continue;
      if (['-f', '-s', '-w'].includes(token)) {
        if (!tokens[index + 1]) return false;
        index += 1;
        continue;
      }
      if (token.startsWith('-') && token !== '-') return false;
    }
    operands += 1;
    if (/[*?[\]{}]/.test(token)) return false;
    if (operands > 1) return false;
  }
  return true;
}

const RG_FLAG_OPTIONS_V1 = new Set([
  '--binary',
  '--case-sensitive',
  '--column',
  '--count',
  '--count-matches',
  '--crlf',
  '--debug',
  '--files',
  '--files-with-matches',
  '--files-without-match',
  '--fixed-strings',
  '--follow',
  '--heading',
  '--hidden',
  '--ignore-case',
  '--invert-match',
  '--json',
  '--line-number',
  '--line-regexp',
  '--multiline',
  '--multiline-dotall',
  '--no-config',
  '--no-filename',
  '--no-heading',
  '--no-hidden',
  '--no-ignore',
  '--no-line-number',
  '--no-messages',
  '--no-pcre2',
  '--no-unicode',
  '--null',
  '--null-data',
  '--one-file-system',
  '--only-matching',
  '--passthru',
  '--pcre2',
  '--quiet',
  '--smart-case',
  '--stats',
  '--text',
  '--trace',
  '--trim',
  '--unicode',
  '--vimgrep',
  '--with-filename',
  '--word-regexp',
]);
const RG_VALUE_OPTIONS_V1 = new Set([
  '--after-context',
  '--before-context',
  '--color',
  '--colors',
  '--context',
  '--context-separator',
  '--encoding',
  '--engine',
  '--field-context-separator',
  '--field-match-separator',
  '--file',
  '--glob',
  '--iglob',
  '--max-columns',
  '--max-count',
  '--max-depth',
  '--max-filesize',
  '--path-separator',
  '--regexp',
  '--replace',
  '--sort',
  '--sortr',
  '--threads',
  '--type',
  '--type-add',
  '--type-clear',
  '--type-not',
]);

function isReadOnlyRipgrepV1(tokens: string[]): boolean {
  const shortFlags = new Set('0acHhIiLlnoqSUuvwx'.split(''));
  const shortWithValue = new Set('ABCEefgMmrTt'.split(''));
  for (let index = 1; index < tokens.length; index += 1) {
    const token = stripShellQuotesV1(tokens[index] ?? '');
    if (token === '--') return true;
    if (!token.startsWith('-') || token === '-') continue;
    if (RG_FLAG_OPTIONS_V1.has(token)) continue;
    const longName = token.split('=', 1)[0]!;
    if (RG_VALUE_OPTIONS_V1.has(longName)) {
      if (!token.includes('=') && !tokens[index + 1]) return false;
      if (!token.includes('=')) index += 1;
      continue;
    }
    if (token.startsWith('--')) return false;
    const flags = token.slice(1);
    for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
      const flag = flags[flagIndex]!;
      if (shortFlags.has(flag)) continue;
      if (!shortWithValue.has(flag)) return false;
      if (flagIndex === flags.length - 1) {
        if (!tokens[index + 1]) return false;
        index += 1;
      }
      break;
    }
  }
  return true;
}

export function isReadOnlyShellCommandV1(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || hasUnsafeOutputRedirectV1(trimmed)) return false;
  if (/[$`]/.test(trimmed) || /[<>]\(/.test(trimmed)) return false;
  if (hasUnquotedBraceExpansionV1(trimmed)) return false;
  const stripped = trimmed.replace(/&&/g, '').replace(/\d?>&\d?/g, '');
  if (stripped.includes('&')) return false;
  return splitReadOnlySegmentsV1(trimmed).every(isReadOnlySegmentV1);
}

const BROKERED_GIT_EXECUTABLE_TOKEN_V1 =
  /(?:^|[\s"'`;&|()=,])(?:(?:[a-z]:)?[\\/][^\s"'`;&|()=,]*[\\/])?git(?:\.exe)?(?=$|[\s"'`;&|()=,])/iu;

/**
 * Conservative Builtin-owned Git token detector. It matches executable
 * tokens in nested/indirect command text and fails closed before a process
 * can start; dotted path substrings such as `.git/config` do not match.
 */
export function hasBrokeredGitExecutableTokenV1(command: string): boolean {
  return BROKERED_GIT_EXECUTABLE_TOKEN_V1.test(command);
}

function hasUnquotedBraceExpansionV1(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '}') return true;
  }
  return false;
}

function hasUnsafeOutputRedirectV1(command: string): boolean {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const rawToken = tokens[index] ?? '';
    if (
      (rawToken.startsWith("'") && rawToken.endsWith("'")) ||
      (rawToken.startsWith('"') && rawToken.endsWith('"'))
    ) {
      continue;
    }
    if (/^\d?>&\d?$/.test(rawToken) || /^\d?>{1,2}\/dev\/null$/.test(rawToken)) continue;
    if (
      /^\d?>{1,2}$/.test(rawToken) &&
      stripShellQuotesV1(tokens[index + 1] ?? '') === '/dev/null'
    ) {
      index += 1;
      continue;
    }
    if (rawToken.includes('>')) return true;
  }
  return false;
}

function splitReadOnlySegmentsV1(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|[|;])\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function withoutHarmlessOutputRedirectsV1(tokens: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripShellQuotesV1(tokens[index] ?? '');
    if (/^\d?>&\d?$/.test(token) || /^\d?>{1,2}\/dev\/null$/.test(token)) continue;
    if (/^\d?>{1,2}$/.test(token) && stripShellQuotesV1(tokens[index + 1] ?? '') === '/dev/null') {
      index += 1;
      continue;
    }
    result.push(tokens[index]!);
  }
  return result;
}

function isReadOnlySegmentV1(segment: string): boolean {
  const tokens = withoutHarmlessOutputRedirectsV1(
    segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [],
  );
  const command = stripShellQuotesV1(tokens[0] ?? '').toLowerCase();
  if (!command) return false;
  const portableCommand = command.replace(/\.(?:cmd|exe)$/i, '');
  if (LOCAL_RUNTIME_VERSION_COMMANDS_V1.has(portableCommand)) {
    return tokens.length === 2 && ['--version', '-v'].includes(stripShellQuotesV1(tokens[1] ?? ''));
  }
  if (portableCommand === 'git') return false;
  if (portableCommand === 'file') return isReadOnlyFileV1(tokens);
  if (portableCommand === 'rg') return isReadOnlyRipgrepV1(tokens);
  if (portableCommand === 'sed') return isReadOnlySedV1(tokens);
  if (portableCommand === 'find') return isReadOnlyFindV1(tokens);
  if (portableCommand === 'sort') return isReadOnlySortV1(tokens);
  if (portableCommand === 'uniq') return isReadOnlyUniqV1(tokens);
  if (portableCommand === 'awk' || portableCommand === 'xargs') return false;
  return READ_ONLY_SHELL_COMMANDS_V1.has(portableCommand);
}

function stripShellQuotesV1(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

export function isNetworkShellCommandV1(command: string): boolean {
  return (
    /\b(?:curl|wget|ssh|scp|sftp|rsync|ftp|nc|ncat|telnet)\b/.test(command) ||
    /\bgit\s+(?:clone|fetch|pull|push|ls-remote)\b/.test(command) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|remove|update|upgrade)\b/.test(command) ||
    /\b(?:pip|pip3|cargo|gem|go|brew|apt|apt-get|choco)\s+(?:install|update|upgrade)\b/.test(
      command,
    )
  );
}

export function isWriteShellCommandV1(command: string): boolean {
  return (
    /(^|[^>])>{1,2}(?!&[12])(?:$|[^>])/.test(command) ||
    /(?:^|[;&|]\s*)(?:cp|mv|mkdir|touch|tee|rm|unlink)\b/.test(command) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|remove|update)\b/.test(command) ||
    /\b(?:pip|pip3|cargo|gem|go|brew|apt|apt-get|choco)\s+install\b/.test(command)
  );
}

export function isDestructiveShellCommandV1(command: string): boolean {
  return (
    /(?:(?:^|[;&|]\s*)|\/)(?:sudo|runas)\b/.test(command) ||
    /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\s+-f|-f\s+-r|--recursive.*--force|--force.*--recursive)\b/.test(
      command,
    ) ||
    /\brm\s+-[^\s]*f\b/.test(command) ||
    /\b(?:del|rmdir|rd)\s+\/[^\s]*[sq]/i.test(command) ||
    /\bchmod\s+(?:-[^\s]*[rR]|--recursive)\b/.test(command) ||
    /\bchown\s+(?:-[^\s]*[rR]|--recursive)\b/.test(command) ||
    /(?:(?:^|[;&|]\s*)|\/)(?:kill|taskkill)(?:all)?\b/.test(command) ||
    /\bdd\b.*\bof=\/dev\//.test(command) ||
    /\bmkfs\b/.test(command) ||
    /\b(?:shutdown|reboot|halt|poweroff)\b/.test(command) ||
    /\binit\s+[06]\b/.test(command) ||
    /\bfdisk\b/.test(command) ||
    /\bparted\b/.test(command) ||
    /:\(\)\s*\{.*:.*\|.*:.*\}/.test(command) ||
    />\s*\/dev\/sd/.test(command) ||
    /\b(?:diskpart|format)\b/.test(command)
  );
}

export function isVcsMutationShellCommandV1(command: string): boolean {
  return /\bgit\s+(?:add|branch|clone|commit|checkout|switch|merge|rebase|tag|restore|stash|pull|fetch|push|reset|clean)\b/.test(
    command,
  );
}

function readOnlyEffectsV1(
  effects: NonNullable<CapabilityDefinitionV1['effects']>,
): CapabilityEffectsV1 {
  return Object.freeze({
    filesystem: effects.filesystem === 'none' ? 'none' : 'read',
    network: effects.network === 'none' ? 'none' : 'read',
    externalState: effects.externalState === 'none' ? 'none' : 'read',
  });
}

function riskFromInvocationEffectsV1(
  effectClass: 'read_only' | 'plan_only' | 'workspace_write' | 'external_side_effect' | 'unknown',
  effects: CapabilityEffectsV1,
): import('@kite/runtime-spi').CapabilityRiskClassV1 {
  if (
    effects.filesystem === 'destructive' ||
    effects.network === 'destructive' ||
    effects.externalState === 'destructive'
  ) {
    return 'destructive';
  }
  if (effects.filesystem === 'write') return 'workspace_write';
  if (effects.network === 'read' || effects.network === 'write') return 'network';
  if (effects.externalState === 'read' || effects.externalState === 'write') {
    return 'external_state';
  }
  if (effectClass === 'read_only') return 'read';
  if (effectClass === 'plan_only') return 'plan';
  if (effectClass === 'workspace_write') return 'workspace_write';
  if (effectClass === 'external_side_effect') return 'execute';
  return 'unknown';
}

function builtinApprovalSummaryProjectorV1(
  operationId: string,
): CapabilityApprovalSummaryProjectorV1 {
  return (input) => {
    const record =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Readonly<Record<string, RuntimeJsonValueV1>>)
        : {};
    const text = (field: string): string =>
      typeof record[field] === 'string' ? record[field] : '';
    switch (operationId) {
      case 'builtin:web_fetch':
        return `web_fetch ${text('url')}`;
      case 'builtin:list_mcp_resources':
        return `list_mcp_resources ${text('server')}`.trim();
      case 'builtin:read_mcp_resource':
        return `read_mcp_resource ${text('server')}`;
      case 'builtin:read_file':
        return `read_file ${text('path')}`;
      case 'builtin:search_content':
        return `search_content ${text('pattern')}`;
      case 'builtin:search_files':
        return `search_files ${text('pattern')}`;
      case 'builtin:write_file':
        return `write_file ${text('path')}`;
      case 'builtin:edit_file':
        return `edit_file ${text('path')}`;
      case 'builtin:shell_execute':
        return text('command');
      default:
        return operationId.startsWith('builtin:')
          ? operationId.slice('builtin:'.length)
          : operationId;
    }
  };
}

function topLevelSchemaFieldsV1(schema: z.ZodType): readonly string[] {
  const json = z.toJSONSchema(schema) as {
    properties?: Record<string, unknown>;
    anyOf?: unknown[];
  };
  if (json.properties) return Object.freeze(Object.keys(json.properties).sort());
  return Object.freeze([]);
}

function toRuntimeJsonV1(value: unknown): RuntimeJsonValueV1 {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toRuntimeJsonV1);
  if (value && typeof value === 'object') {
    const result: Record<string, RuntimeJsonValueV1> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toRuntimeJsonV1(item);
    }
    return result;
  }
  throw new Error('Builtin parser produced a non-JSON value');
}

function freezeRuntimeJsonV1(value: RuntimeJsonValueV1): RuntimeJsonValueV1 {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeRuntimeJsonV1));
  if (value && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, freezeRuntimeJsonV1(item)]),
      ),
    );
  }
  return value;
}
