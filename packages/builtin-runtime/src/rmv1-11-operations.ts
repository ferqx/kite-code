import { createHash } from 'node:crypto';
import type {
  CapabilityEffectsV1,
  CapabilityExecutionContextV1,
  CapabilityExecutionMechanismV1,
  CapabilityExecutorV1,
  ExecutionReceiptV1,
  RuntimeJsonValueV1,
  RuntimeModuleRegistryWriterV1,
  RuntimeModuleV1,
} from '@kite/runtime-spi';
import { defineRuntimeModuleV1 } from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import {
  activateSkillAvailabilityV1,
  builtinExecutionTraitsV1,
  defineBuiltinCapabilityContractV1,
  parserForBuiltinOperationV1,
  readSkillAvailabilityV1,
  staticEffectsClassifierV1,
} from './catalog-contract';
import { isMcpProviderError } from './mcp/provider-errors';
import { registerBuiltinContextSourcesV1 } from './model-context';
import {
  activateSkillBuiltinPolicyRuleV1,
  createBuiltinPolicyCompilerV1,
  readOnlyBuiltinPolicyRuleV1,
  webFetchBuiltinPolicyRuleV1,
} from './policy-compiler';
import { compileCapabilitySchemaV1 } from './skills/capability-domain';
import {
  activateSkillLifecycle,
  completeSkillLifecycle,
  readSkillReference,
  type SkillActivationContext,
  type SkillLifecycleEmission,
} from './skills/lifecycle';
import { builtinToolDescriptionV1 } from './tool-contracts';
import { BUILTIN_JSON_SCHEMAS_V1, BUILTIN_ZOD_SCHEMAS_V1 } from './tool-schemas';
import { fetchAndExtract } from './web/extractor';

export const RMV1_11_PROVIDER_ID_V1 = 'kite-builtin-runtime-rmv1-11' as const;

export const RMV1_11_OPERATION_IDS_V1 = Object.freeze([
  'builtin:web_fetch',
  'builtin:list_mcp_resources',
  'builtin:list_mcp_tools',
  'builtin:read_mcp_resource',
  'mcp:dynamic_tool',
  'builtin:read_skill_reference',
  'builtin:complete_skill',
  'builtin:activate_skill',
] as const);

export type Rmv111OperationIdV1 = (typeof RMV1_11_OPERATION_IDS_V1)[number];

export const WEB_FETCH_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:web_fetch'];
export const LIST_MCP_RESOURCES_INPUT_SCHEMA_V1 =
  BUILTIN_JSON_SCHEMAS_V1['builtin:list_mcp_resources'];
export const LIST_MCP_TOOLS_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:list_mcp_tools'];
export const READ_MCP_RESOURCE_INPUT_SCHEMA_V1 =
  BUILTIN_JSON_SCHEMAS_V1['builtin:read_mcp_resource'];
export const ACTIVATE_SKILL_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:activate_skill'];
export const READ_SKILL_REFERENCE_INPUT_SCHEMA_V1 =
  BUILTIN_JSON_SCHEMAS_V1['builtin:read_skill_reference'];
export const COMPLETE_SKILL_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:complete_skill'];
export const DYNAMIC_MCP_OPERATION_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['mcp:dynamic_tool'];

const INPUT_SCHEMAS_V1: Readonly<
  Record<Rmv111OperationIdV1, Readonly<Record<string, RuntimeJsonValueV1>>>
> = Object.freeze({
  'builtin:web_fetch': WEB_FETCH_INPUT_SCHEMA_V1,
  'builtin:list_mcp_resources': LIST_MCP_RESOURCES_INPUT_SCHEMA_V1,
  'builtin:list_mcp_tools': LIST_MCP_TOOLS_INPUT_SCHEMA_V1,
  'builtin:read_mcp_resource': READ_MCP_RESOURCE_INPUT_SCHEMA_V1,
  'mcp:dynamic_tool': DYNAMIC_MCP_OPERATION_INPUT_SCHEMA_V1,
  'builtin:read_skill_reference': READ_SKILL_REFERENCE_INPUT_SCHEMA_V1,
  'builtin:complete_skill': COMPLETE_SKILL_INPUT_SCHEMA_V1,
  'builtin:activate_skill': ACTIVATE_SKILL_INPUT_SCHEMA_V1,
});

const EFFECTS_V1: Readonly<Record<Rmv111OperationIdV1, CapabilityEffectsV1>> = Object.freeze({
  'builtin:web_fetch': Object.freeze({
    filesystem: 'none',
    network: 'read',
    externalState: 'none',
  }),
  'builtin:list_mcp_resources': Object.freeze({
    filesystem: 'none',
    network: 'read',
    externalState: 'none',
  }),
  'builtin:list_mcp_tools': Object.freeze({
    filesystem: 'none',
    network: 'read',
    externalState: 'none',
  }),
  'builtin:read_mcp_resource': Object.freeze({
    filesystem: 'none',
    network: 'read',
    externalState: 'none',
  }),
  'mcp:dynamic_tool': Object.freeze({
    filesystem: 'unknown',
    network: 'unknown',
    externalState: 'unknown',
  }),
  'builtin:read_skill_reference': Object.freeze({
    filesystem: 'read',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:complete_skill': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:activate_skill': Object.freeze({
    filesystem: 'unknown',
    network: 'unknown',
    externalState: 'unknown',
  }),
});

const EXECUTION_MECHANISMS_V1: Readonly<
  Record<Rmv111OperationIdV1, CapabilityExecutionMechanismV1>
> = Object.freeze({
  'builtin:web_fetch': 'web',
  'builtin:list_mcp_resources': 'mcp',
  'builtin:list_mcp_tools': 'mcp',
  'builtin:read_mcp_resource': 'mcp',
  'mcp:dynamic_tool': 'mcp',
  'builtin:read_skill_reference': 'skill',
  'builtin:complete_skill': 'skill',
  'builtin:activate_skill': 'skill',
});

export const RMV1_11_CAPABILITY_REVISIONS_V1: Readonly<Record<Rmv111OperationIdV1, string>> =
  Object.freeze(
    Object.fromEntries(
      RMV1_11_OPERATION_IDS_V1.map((operationId) => [
        operationId,
        digestCapabilityBindingValueV1({
          schema: 'kite.rmv1-11-operation-capability.v1',
          operationId,
          inputSchema: INPUT_SCHEMAS_V1[operationId],
          effects: EFFECTS_V1[operationId],
        }),
      ]),
    ) as Record<Rmv111OperationIdV1, string>,
  );

export const RMV1_11_EXECUTOR_REVISIONS_V1: Readonly<Record<Rmv111OperationIdV1, string>> =
  Object.freeze(
    Object.fromEntries(
      RMV1_11_OPERATION_IDS_V1.map((operationId) => [
        operationId,
        digestCapabilityBindingValueV1({
          schema: 'kite.rmv1-11-operation-executor.v1',
          operationId,
          capabilityRevision: RMV1_11_CAPABILITY_REVISIONS_V1[operationId],
        }),
      ]),
    ) as Record<Rmv111OperationIdV1, string>,
  );

export type BuiltinRuntimeEventValueV1 = RuntimeJsonValueV1 &
  Readonly<{ type: string; [key: string]: RuntimeJsonValueV1 }>;

export type BuiltinOperationExecutionValueV1 = RuntimeJsonValueV1 &
  Readonly<{
    schema: 'kite.builtin-operation-result.v1';
    ok: boolean;
    stdout: string;
    stderr: string;
    resultMeta?: Readonly<Record<string, RuntimeJsonValueV1>>;
    runtimeEvents?: readonly BuiltinRuntimeEventValueV1[];
    capabilityResult?: RuntimeJsonValueV1;
    subagentResult?: RuntimeJsonValueV1;
    filesystemObservation?: Readonly<Record<string, RuntimeJsonValueV1>>;
    classifierAdviceV1?: Readonly<Record<string, RuntimeJsonValueV1>>;
    terminationReason?: 'timed_out' | 'cancelled' | 'sandbox_denied';
    path?: string;
    totalLines?: number;
  }>;

const RMV1_11_MCP_PROVIDER_FAILURE_CODES_V1 = Object.freeze([
  'provider_auth_required',
  'provider_approval_required',
  'provider_unavailable',
  'provider_capability_changed',
] as const);

type Rmv111McpProviderFailureCodeV1 = (typeof RMV1_11_MCP_PROVIDER_FAILURE_CODES_V1)[number];

interface Rmv111McpProviderFailureV1 {
  readonly code: Rmv111McpProviderFailureCodeV1;
  readonly message: string;
  readonly retryable: boolean;
}

export interface BuiltinMcpRuntimePortV1 {
  getCapabilitySnapshot(): unknown;
  getProviderDirectorySnapshot(): unknown;
  getResourceDirectorySnapshot(): unknown;
  findCapability(capabilityId: string): unknown;
  callCapability(invocation: unknown): Promise<unknown>;
  readResource(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
    transportBoundary?: unknown,
  ): Promise<string>;
}

/**
 * The injected MCP mechanism uses this exact package-owned marker when a
 * readiness/transport outcome is uncertain and therefore cannot be projected
 * as a confirmed Builtin domain failure.
 */
export class BuiltinMcpExecutionUnknownErrorV1 extends Error {
  readonly code = 'BUILTIN_MCP_EXECUTION_UNKNOWN' as const;

  constructor(message = 'MCP execution outcome is unknown.') {
    super(safeMetadata(message, 256) || 'MCP execution outcome is unknown.');
    this.name = 'BuiltinMcpExecutionUnknownErrorV1';
  }
}

export interface BuiltinMcpExecutionMechanismV1 {
  readonly runtime: BuiltinMcpRuntimePortV1;
  readonly invocation?: Readonly<{
    capabilityId: string;
    expectedRevision: string;
    transportBoundary?: unknown;
    writeGovernance?: unknown;
  }>;
}

/** Invocation-scoped State view and fork mechanism; all Skill semantics stay in Builtin Runtime. */
export type BuiltinSkillExecutionMechanismV1 = SkillActivationContext;

export interface BuiltinWebExecutionMechanismV1 {
  readonly fetch?: typeof fetch;
  readonly networkBoundary?: Readonly<{
    policyRevision: string;
    admissionDigests: readonly string[];
  }>;
  readonly unavailable?: Readonly<{ code: string; message: string }>;
}

export interface Rmv111ExecutionMechanismsV1 extends Readonly<Record<string, unknown>> {
  readonly mcp?: BuiltinMcpExecutionMechanismV1;
  readonly skill?: BuiltinSkillExecutionMechanismV1;
  readonly web?: BuiltinWebExecutionMechanismV1;
}

export function isBuiltinOperationExecutionValueV1(
  value: RuntimeJsonValueV1 | undefined,
): value is BuiltinOperationExecutionValueV1 {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schema === 'kite.builtin-operation-result.v1' &&
      typeof record.ok === 'boolean' &&
      typeof record.stdout === 'string' &&
      typeof record.stderr === 'string',
  );
}

export function createRmv111RuntimeModuleV1(): RuntimeModuleV1 {
  return defineRuntimeModuleV1({
    moduleId: 'kite-builtin-runtime-rmv1-11',
    providerId: RMV1_11_PROVIDER_ID_V1,
    revision: 'rmv1-11',
    operationIds: RMV1_11_OPERATION_IDS_V1,
    register: (registry) => registerRmv111OperationsV1(registry),
  });
}

function registerRmv111OperationsV1(registry: RuntimeModuleRegistryWriterV1): void {
  registerBuiltinContextSourcesV1(registry);
  for (const operationId of RMV1_11_OPERATION_IDS_V1) {
    const capabilityRevision = RMV1_11_CAPABILITY_REVISIONS_V1[operationId];
    const executorRevision = RMV1_11_EXECUTOR_REVISIONS_V1[operationId];
    registry.registerCapability(
      defineBuiltinCapabilityContractV1(
        {
          capabilityId: operationId,
          revision: capabilityRevision,
          providerId: RMV1_11_PROVIDER_ID_V1,
          title: `Builtin Runtime operation ${operationId}`,
          executionMechanism: EXECUTION_MECHANISMS_V1[operationId],
          ...(operationId.startsWith('builtin:')
            ? {
                toolName: operationId.slice('builtin:'.length),
                description: builtinToolDescriptionV1(operationId.slice('builtin:'.length)),
                visibility: 'model' as const,
              }
            : { visibility: 'internal' as const }),
          effects: EFFECTS_V1[operationId],
          inputSchema: INPUT_SCHEMAS_V1[operationId],
          inputSchemaDigest: digestCapabilityBindingValueV1(INPUT_SCHEMAS_V1[operationId]),
        },
        rmv111ContractOptionsV1(operationId, capabilityRevision, EFFECTS_V1[operationId]),
      ),
    );
    registry.registerExecutor({
      providerId: RMV1_11_PROVIDER_ID_V1,
      capabilityId: operationId,
      capabilityRevision,
      executorRevision,
      execute: (request, context) => executeRmv111OperationV1(operationId, request, context),
    } satisfies CapabilityExecutorV1);
  }
}

function rmv111ContractOptionsV1(
  operationId: Rmv111OperationIdV1,
  revision: string,
  effects: CapabilityEffectsV1,
) {
  const modelVisible = operationId.startsWith('builtin:');
  const parser = parserForBuiltinOperationV1(operationId, revision);
  const readOnly =
    operationId === 'builtin:web_fetch' ||
    operationId === 'builtin:list_mcp_resources' ||
    operationId === 'builtin:list_mcp_tools' ||
    operationId === 'builtin:read_mcp_resource' ||
    operationId === 'builtin:read_skill_reference' ||
    operationId === 'builtin:complete_skill';
  const networkRead =
    operationId === 'builtin:web_fetch' ||
    operationId === 'builtin:list_mcp_resources' ||
    operationId === 'builtin:list_mcp_tools' ||
    operationId === 'builtin:read_mcp_resource';
  const policyRule =
    operationId === 'builtin:web_fetch'
      ? webFetchBuiltinPolicyRuleV1
      : operationId === 'builtin:activate_skill'
        ? activateSkillBuiltinPolicyRuleV1
        : readOnlyBuiltinPolicyRuleV1;
  return {
    parser,
    kind:
      operationId === 'builtin:web_fetch'
        ? ('computer' as const)
        : modelVisible
          ? ('coordination' as const)
          : ('internal_runtime' as const),
    minimumApproval:
      operationId === 'builtin:activate_skill' ? ('user' as const) : ('none' as const),
    ...(operationId === 'builtin:activate_skill'
      ? { availability: activateSkillAvailabilityV1 }
      : operationId === 'builtin:read_skill_reference' || operationId === 'builtin:complete_skill'
        ? { availability: readSkillAvailabilityV1 }
        : {}),
    effectsClassifier: staticEffectsClassifierV1(
      readOnly
        ? 'read_only'
        : operationId === 'builtin:activate_skill'
          ? 'external_side_effect'
          : 'unknown',
      !readOnly,
      operationId === 'builtin:web_fetch'
        ? 'Fetches public web content without external mutation.'
        : operationId === 'builtin:list_mcp_resources' ||
            operationId === 'builtin:list_mcp_tools' ||
            operationId === 'builtin:read_mcp_resource'
          ? 'Reads governed MCP inventory or static resource content.'
          : operationId === 'builtin:activate_skill'
            ? 'Skill effects are governed by the disclosed compiled descriptor.'
            : operationId === 'builtin:read_skill_reference' ||
                operationId === 'builtin:complete_skill'
              ? 'Operates on the active governed Skill frame.'
              : 'Dynamic MCP execution remains an internal Host-routed operation.',
      effects,
    ),
    ...(modelVisible
      ? {
          policyCompiler: createBuiltinPolicyCompilerV1({
            operationId,
            capabilityRevision: revision,
            parserRevision: parser.parserRevision,
            declaredEffects: effects,
            minimumApproval: operationId === 'builtin:activate_skill' ? 'user' : 'none',
            rule: policyRule,
          }),
        }
      : {}),
    ...(networkRead
      ? {
          executionTraitsDeclaration: builtinExecutionTraitsV1({
            resourceScopes: [{ kind: 'network', key: 'governed-network' }],
            interactionBarrier: false,
            concurrencyGroup: 'parallel-read',
          }),
        }
      : {}),
    execution: readOnly ? { retry: 'safe_read' as const } : { retry: 'never' as const },
  };
}

async function executeRmv111OperationV1(
  operationId: Rmv111OperationIdV1,
  request: Parameters<CapabilityExecutorV1['execute']>[0],
  context: CapabilityExecutionContextV1,
): Promise<ExecutionReceiptV1> {
  const parsed = BUILTIN_ZOD_SCHEMAS_V1[operationId].safeParse(request.input);
  const input = parsed.success ? asRecord(parsed.data) : undefined;
  if (!input) return failedReceipt(operationId, request.invocationId, context, 'invalid_input');
  const mechanisms = context.environment.mechanisms as Rmv111ExecutionMechanismsV1 | undefined;
  let value: BuiltinOperationExecutionValueV1;
  switch (operationId) {
    case 'builtin:list_mcp_resources':
      value = executeListMcpResourcesV1(input, mechanisms?.mcp?.runtime);
      break;
    case 'builtin:list_mcp_tools':
      value = executeListMcpToolsV1(input, mechanisms?.mcp?.runtime);
      break;
    case 'builtin:read_mcp_resource': {
      const readResult = await executeReadMcpResourceV1(
        input,
        request.invocationId,
        context,
        mechanisms?.mcp,
      );
      if (isExecutionReceiptV1(readResult)) return readResult;
      value = readResult;
      break;
    }
    case 'mcp:dynamic_tool': {
      const dynamicResult = await executeDynamicMcpToolV1(input, context, mechanisms?.mcp);
      if (isExecutionReceiptV1(dynamicResult)) return dynamicResult;
      value = dynamicResult;
      break;
    }
    case 'builtin:web_fetch':
      if (!mechanisms?.web)
        return failedReceipt(operationId, request.invocationId, context, 'web_port_missing');
      value = await executeWebFetchV1(input, context, mechanisms.web);
      break;
    case 'builtin:activate_skill':
      if (!mechanisms?.skill)
        return failedReceipt(operationId, request.invocationId, context, 'skill_port_missing');
      value = skillEmissionValueV1(
        await activateSkillLifecycle(mechanisms.skill, {
          skill_id: stringValue(input.skill_id),
          input: asRecord(input.input) ?? {},
        }),
      );
      break;
    case 'builtin:read_skill_reference':
      if (!mechanisms?.skill)
        return failedReceipt(operationId, request.invocationId, context, 'skill_port_missing');
      value = skillEmissionValueV1(
        readSkillReference(mechanisms.skill, {
          activation_id: stringValue(input.activation_id),
          path: stringValue(input.path),
        }),
      );
      break;
    case 'builtin:complete_skill':
      if (!mechanisms?.skill)
        return failedReceipt(operationId, request.invocationId, context, 'skill_port_missing');
      value = skillEmissionValueV1(
        completeSkillLifecycle(mechanisms.skill, {
          activation_id: stringValue(input.activation_id),
          output: asRecord(input.output) ?? {},
        }),
      );
      break;
  }
  return succeededReceipt(operationId, request.invocationId, context, value);
}

async function executeWebFetchV1(
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContextV1,
  mechanism: BuiltinWebExecutionMechanismV1,
): Promise<BuiltinOperationExecutionValueV1> {
  const url = stringValue(input.url);
  const maxChars = optionalIntegerValue(input.max_chars);
  const timeoutMs = optionalIntegerValue(input.timeout_ms);
  const boundary = mechanism.networkBoundary;
  const injectedFetch = mechanism.fetch;
  if (!injectedFetch && !mechanism.unavailable) {
    return operationFailure(
      'Builtin web execution requires an explicit fetch port or unavailable decision.',
    );
  }
  let output: {
    ok: boolean;
    url: string;
    finalUrl?: string;
    title?: string;
    content?: string;
    contentType?: string;
    truncated: boolean;
    error?: string;
    networkFailureCode?: string;
  };
  try {
    if (mechanism.unavailable) {
      const error = new Error(mechanism.unavailable.message) as Error & { code?: string };
      error.name = 'NetworkBoundaryError';
      error.code = mechanism.unavailable.code;
      throw error;
    }
    output = await fetchAndExtract(url, {
      signal: context.signal,
      ...(maxChars === undefined ? {} : { maxChars }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(injectedFetch ? { fetch: injectedFetch } : {}),
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    const timedOut = aborted && error.message === 'Fetch timeout';
    output = {
      ok: false,
      url,
      truncated: false,
      error: timedOut
        ? 'Fetch timed out.'
        : aborted
          ? 'Web fetch cancelled by user.'
          : error instanceof Error
            ? error.message
            : String(error),
      ...(networkFailureCodeV1(error) ? { networkFailureCode: networkFailureCodeV1(error) } : {}),
    };
  }
  const rawContent = output.ok
    ? [
        `Fetched: ${output.title ?? output.finalUrl ?? url}`,
        output.contentType ? `Type: ${output.contentType}` : '',
        output.truncated ? '(content truncated)' : '',
        '',
        output.content ?? '',
      ]
        .filter(Boolean)
        .join('\n')
    : `Failed to fetch ${url}: ${output.error ?? 'unknown error'}`;
  const modelContent = truncateProjectedOutputV1(
    rawContent,
    Math.max(8000, (maxChars ?? 8000) + 500),
  );
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok: output.ok,
    stdout: output.ok ? modelContent : '',
    stderr: output.ok ? '' : modelContent,
    resultMeta: Object.freeze({
      ...(output.ok && !output.truncated
        ? { rawResultDigest: projectionDigestV1(rawContent, '', 0) }
        : {}),
      truncated: modelContent !== rawContent || (output.ok && output.truncated),
      ...(boundary
        ? {
            networkPolicyRevision: boundary.policyRevision,
            networkAdmissionDigests: boundary.admissionDigests,
            ...(output.networkFailureCode ? { networkFailureCode: output.networkFailureCode } : {}),
          }
        : {}),
    }),
  }) as BuiltinOperationExecutionValueV1;
}

function executeListMcpResourcesV1(
  input: Readonly<Record<string, unknown>>,
  provider: BuiltinMcpRuntimePortV1 | undefined,
): BuiltinOperationExecutionValueV1 {
  if (
    input.server !== undefined &&
    (typeof input.server !== 'string' || input.server.length === 0)
  ) {
    return operationFailure('server must be a non-empty string.');
  }
  if (!provider) {
    return operationFailure(
      'MCP Runtime is not available in this execution context. Use list_mcp_tools or /mcp to inspect configured providers.',
    );
  }
  const resourceSnapshot = asRecord(provider.getResourceDirectorySnapshot());
  const providerSnapshot = asRecord(provider.getProviderDirectorySnapshot());
  const resources = arrayOfRecords(resourceSnapshot?.resources);
  const server = input.server as string | undefined;
  const matching = resources
    .filter((resource) => server == null || resource.providerId === server)
    .sort(
      (left, right) =>
        stringValue(left.providerId).localeCompare(stringValue(right.providerId)) ||
        stringValue(left.uri).localeCompare(stringValue(right.uri)) ||
        stringValue(left.name).localeCompare(stringValue(right.name)),
    );
  if (server && matching.length === 0) {
    const known = arrayOfRecords(providerSnapshot?.entries).some(
      (entry) => entry.providerId === server,
    );
    return operationFailure(
      known
        ? `No available static MCP resources were discovered for server: ${server}`
        : `Unknown MCP server: ${server}`,
    );
  }
  const projected = matching.slice(0, 100).map((resource) => ({
    server: stringValue(resource.providerId),
    uri: stringValue(resource.uri),
    name: stringValue(resource.name),
    ...(typeof resource.mimeType === 'string' ? { mime_type: resource.mimeType } : {}),
  }));
  return operationSuccess(
    JSON.stringify({
      ok: true,
      resource_count: projected.length,
      resources: projected,
      truncated: matching.length > projected.length,
      next_step:
        matching.length > projected.length
          ? 'Call list_mcp_resources with an exact server to narrow the result.'
          : projected.length > 0
            ? 'Call read_mcp_resource with an exact server and URI.'
            : 'No static MCP resources are currently available.',
    }),
  );
}

function executeListMcpToolsV1(
  input: Readonly<Record<string, unknown>>,
  provider: BuiltinMcpRuntimePortV1 | undefined,
): BuiltinOperationExecutionValueV1 {
  if (!provider) {
    return operationSuccess(
      JSON.stringify({
        ok: true,
        configured_provider_count: 0,
        callable_provider_count: 0,
        available_tool_count: 0,
        providers: [],
        tools: [],
        truncated: false,
      }),
    );
  }
  const result = buildMcpInventoryV1(
    provider.getCapabilitySnapshot(),
    provider.getProviderDirectorySnapshot(),
    input,
  );
  return operationSuccess(JSON.stringify(result));
}

async function executeReadMcpResourceV1(
  input: Readonly<Record<string, unknown>>,
  invocationId: string,
  context: CapabilityExecutionContextV1,
  service: BuiltinMcpExecutionMechanismV1 | undefined,
): Promise<BuiltinOperationExecutionValueV1 | ExecutionReceiptV1> {
  const server = typeof input.server === 'string' ? input.server : '';
  const uri = typeof input.uri === 'string' ? input.uri : '';
  if (!server || !uri) return operationFailure('server and uri are required');
  if (!service) {
    return operationFailure(
      'MCP Runtime is not available in this execution context. Use list_mcp_tools or /mcp to inspect configured providers.',
    );
  }
  let content: string;
  try {
    content = await service.runtime.readResource(
      server,
      uri,
      context.signal,
      service.invocation?.transportBoundary,
    );
  } catch (error) {
    if (error instanceof BuiltinMcpExecutionUnknownErrorV1) throw error;
    const providerFailure = classifyRmv111McpProviderFailureV1(error);
    if (providerFailure) {
      return providerFailureReceiptV1(
        'builtin:read_mcp_resource',
        invocationId,
        context,
        providerFailure,
      );
    }
    return operationFailure(error instanceof Error ? error.message : String(error));
  }
  const limit = 128 * 1024;
  if (content.length <= limit) {
    return operationSuccess(content, {
      rawResultDigest: projectionDigestV1(content, '', 0),
      truncated: false,
    });
  }
  return operationSuccess(
    JSON.stringify({
      status: 'partial',
      content: content.slice(0, limit),
      truncated: true,
      original_characters: content.length,
      message: 'The MCP resource exceeded the model-facing output limit.',
    }),
    { rawResultDigest: projectionDigestV1(content, '', 0), truncated: true },
  );
}

async function executeDynamicMcpToolV1(
  input: Readonly<Record<string, unknown>>,
  context: CapabilityExecutionContextV1,
  service: BuiltinMcpExecutionMechanismV1 | undefined,
): Promise<BuiltinOperationExecutionValueV1 | ExecutionReceiptV1> {
  const capabilityId = typeof input.capability_id === 'string' ? input.capability_id : '';
  const capabilityRevision =
    typeof input.capability_revision === 'string' ? input.capability_revision : '';
  const args = asRecord(input.arguments);
  if (!capabilityId || !capabilityRevision || !args) {
    return operationFailure('Dynamic MCP capability identity or arguments are invalid.');
  }
  if (
    !service?.invocation ||
    service.invocation.capabilityId !== capabilityId ||
    service.invocation.expectedRevision !== capabilityRevision
  ) {
    return operationFailure('Dynamic MCP invocation identity is unavailable or changed.');
  }
  const descriptor = asRecord(service.runtime.findCapability(capabilityId));
  if (!descriptor || descriptor.revision !== capabilityRevision) {
    return operationFailure('Dynamic MCP capability revision changed before execution.');
  }
  let raw: Readonly<Record<string, unknown>> | undefined;
  try {
    raw = asRecord(
      await service.runtime.callCapability({
        capabilityId,
        expectedRevision: capabilityRevision,
        arguments: args,
        ...(service.invocation.transportBoundary
          ? { transportBoundary: service.invocation.transportBoundary }
          : {}),
        ...(service.invocation.writeGovernance
          ? { writeGovernance: service.invocation.writeGovernance }
          : {}),
        signal: context.signal,
      }),
    );
  } catch (error) {
    if (error instanceof BuiltinMcpExecutionUnknownErrorV1) throw error;
    const providerFailure = classifyRmv111McpProviderFailureV1(error);
    if (providerFailure) {
      return providerFailureReceiptV1(
        'mcp:dynamic_tool',
        context.attempt.invocationId,
        context,
        providerFailure,
      );
    }
    return operationFailure(error instanceof Error ? error.message : String(error));
  }
  if (!raw) return operationFailure('MCP Provider returned an invalid result envelope.');
  const normalized: Record<string, RuntimeJsonValueV1> = {
    status: raw.isError === true ? 'error' : 'success',
    content: (Array.isArray(raw.content) ? raw.content : []) as RuntimeJsonValueV1[],
    ...(raw.structuredContent === undefined
      ? {}
      : { structuredContent: raw.structuredContent as RuntimeJsonValueV1 }),
  };
  const outputSchema = asRecord(descriptor.outputSchema);
  if (outputSchema && raw.structuredContent !== undefined) {
    const compiled = compileCapabilitySchemaV1(outputSchema);
    if (!compiled.ok || !compiled.compiled.validate(raw.structuredContent)) {
      normalized.status = 'partial';
      normalized.error = {
        kind: 'tool_invalid_args',
        message: compiled.ok
          ? 'MCP structuredContent does not match the advertised outputSchema.'
          : `MCP outputSchema is unsupported: ${compiled.diagnostic}`,
        retryable: false,
        modelFixable: true,
        needsUserIntervention: false,
        terminatesTurn: false,
        journal: true,
      };
    }
  }
  const serialized = JSON.stringify(normalized);
  const limit = 128 * 1024;
  const output =
    serialized.length <= limit
      ? serialized
      : JSON.stringify({
          status: 'partial',
          content: [{ type: 'text', text: serialized.slice(0, limit) }],
          truncated: true,
          original_characters: serialized.length,
          message:
            'The MCP result exceeded the model-facing output limit. The complete governed result remains available to Runtime execution records when applicable.',
        });
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok: raw.isError !== true,
    stdout: output,
    stderr: '',
    resultMeta: Object.freeze({
      rawResultDigest: projectionDigestV1(JSON.stringify(raw), '', 0),
      truncated: serialized.length > limit,
    }),
    capabilityResult: normalized,
  }) as BuiltinOperationExecutionValueV1;
}

function buildMcpInventoryV1(
  capabilityValue: unknown,
  providerValue: unknown,
  query: Readonly<Record<string, unknown>>,
): RuntimeJsonValueV1 {
  const capabilities = asRecord(capabilityValue);
  const providers = asRecord(providerValue);
  const descriptors = arrayOfRecords(capabilities?.descriptors);
  const entries = arrayOfRecords(providers?.entries);
  const catalogRevision = stringValue(capabilities?.revision);
  const providerDirectoryRevision = stringValue(providers?.revision);
  const providerFilter = typeof query.provider === 'string' ? query.provider : undefined;
  const requestedLimit = typeof query.limit === 'number' ? query.limit : undefined;
  if (
    requestedLimit !== undefined &&
    (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100)
  ) {
    return { ok: false, code: 'invalid_limit', message: 'limit must be between 1 and 100.' };
  }
  const limit = requestedLimit ?? 50;
  let offset = 0;
  if (typeof query.cursor === 'string') {
    const cursor = decodeInventoryCursorV1(query.cursor);
    if (!cursor) return { ok: false, code: 'invalid_cursor', message: 'Invalid cursor.' };
    if (
      cursor.catalogRevision !== catalogRevision ||
      cursor.providerDirectoryRevision !== providerDirectoryRevision ||
      cursor.provider !== providerFilter
    ) {
      return {
        ok: false,
        code: 'stale_cursor',
        message: 'The MCP inventory changed. Restart listing without a cursor.',
      };
    }
    offset = cursor.offset;
  }
  const available = descriptors.filter(
    (descriptor) => descriptor.kind === 'mcp_tool' && descriptor.availability === 'available',
  );
  const knownIds = new Set([
    ...entries.map((entry) => stringValue(entry.providerId)),
    ...available.map((descriptor) => stringValue(asRecord(descriptor.provider)?.id)),
  ]);
  if (providerFilter && !knownIds.has(providerFilter)) {
    return { ok: false, code: 'unknown_provider', message: `Unknown provider: ${providerFilter}` };
  }
  const providerRows = entries
    .filter((entry) => !providerFilter || entry.providerId === providerFilter)
    .map((entry) => {
      const providerId = stringValue(entry.providerId);
      const status = stringValue(entry.status);
      return {
        name: safeMetadata(providerId),
        status,
        required: entry.required === true,
        source: stringValue(entry.source) || 'explicit',
        available_tool_count: available.filter(
          (descriptor) => stringValue(asRecord(descriptor.provider)?.id) === providerId,
        ).length,
        last_known_tool_count: Array.isArray(entry.lastKnownCapabilityNames)
          ? entry.lastKnownCapabilityNames.length
          : 0,
        ...inventoryNextAction(status),
        ...(typeof entry.diagnosticCode === 'string'
          ? { diagnostic_code: entry.diagnosticCode }
          : {}),
      };
    });
  for (const descriptor of available) {
    const providerId = stringValue(asRecord(descriptor.provider)?.id);
    if (
      providerRows.some((row) => row.name === safeMetadata(providerId)) ||
      (providerFilter && providerId !== providerFilter)
    ) {
      continue;
    }
    const count = available.filter(
      (candidate) => stringValue(asRecord(candidate.provider)?.id) === providerId,
    ).length;
    providerRows.push({
      name: safeMetadata(providerId),
      status: 'ready',
      required: false,
      source: 'explicit',
      available_tool_count: count,
      last_known_tool_count: count,
    });
  }
  providerRows.sort((left, right) => left.name.localeCompare(right.name));
  const seen = new Set<string>();
  const tools: Array<{ provider: string; name: string }> = [];
  const globalCapabilityIds = new Set<string>();
  for (const descriptor of available) {
    globalCapabilityIds.add(stringValue(descriptor.capabilityId));
    const providerId = stringValue(asRecord(descriptor.provider)?.id);
    if (providerFilter && providerId !== providerFilter) continue;
    const name = stringValue(descriptor.displayName);
    const key = `${providerId}\0${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push({ provider: safeMetadata(providerId), name: safeMetadata(name) });
  }
  tools.sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name),
  );
  const sliced = tools.slice(offset, offset + limit);
  const truncated = offset + limit < tools.length;
  const callableIds = new Set(
    entries
      .filter((entry) => entry.status === 'ready' || entry.status === 'degraded')
      .map((entry) => stringValue(entry.providerId)),
  );
  for (const descriptor of available) {
    const providerId = stringValue(asRecord(descriptor.provider)?.id);
    if (!entries.some((entry) => entry.providerId === providerId)) callableIds.add(providerId);
  }
  return {
    ok: true,
    configured_provider_count: knownIds.size,
    ...(providerFilter ? { matched_provider_count: providerRows.length } : {}),
    callable_provider_count: callableIds.size,
    ...(providerFilter
      ? {
          matched_callable_provider_count: providerRows.filter(
            (row) => row.status === 'ready' || row.status === 'degraded',
          ).length,
        }
      : {}),
    available_tool_count: globalCapabilityIds.size,
    ...(providerFilter ? { matched_tool_count: tools.length } : {}),
    providers: providerRows,
    tools: sliced,
    truncated,
    ...(truncated
      ? {
          next_cursor: Buffer.from(
            JSON.stringify({
              catalogRevision,
              providerDirectoryRevision,
              offset: offset + limit,
              ...(providerFilter ? { provider: providerFilter } : {}),
            }),
          ).toString('base64url'),
        }
      : {}),
  };
}

function decodeInventoryCursorV1(raw: string):
  | Readonly<{
      catalogRevision: string;
      providerDirectoryRevision: string;
      offset: number;
      provider?: string;
    }>
  | undefined {
  try {
    if (raw.length > 2048) return undefined;
    const parsed = asRecord(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (
      !parsed ||
      typeof parsed.catalogRevision !== 'string' ||
      typeof parsed.providerDirectoryRevision !== 'string' ||
      typeof parsed.offset !== 'number' ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      (parsed.provider !== undefined && typeof parsed.provider !== 'string') ||
      Object.keys(parsed).some(
        (key) =>
          !['catalogRevision', 'providerDirectoryRevision', 'offset', 'provider'].includes(key),
      )
    ) {
      return undefined;
    }
    return parsed as {
      catalogRevision: string;
      providerDirectoryRevision: string;
      offset: number;
      provider?: string;
    };
  } catch {
    return undefined;
  }
}

function inventoryNextAction(status: string): Readonly<Record<string, string>> {
  switch (status) {
    case 'pending_approval':
      return { next_action: 'approve_project_provider' };
    case 'rejected':
      return { next_action: 'review_project_approval' };
    case 'disabled':
      return { next_action: 'enable_provider' };
    case 'login_required':
      return { next_action: 'authenticate' };
    case 'connecting':
      return { next_action: 'wait_or_retry' };
    case 'failed':
      return { next_action: 'retry_connection' };
    case 'degraded':
      return { next_action: 'retry_if_needed' };
    case 'quarantined':
      return { next_action: 'fix_configuration_or_schema' };
    default:
      return {};
  }
}

function succeededReceipt(
  operationId: Rmv111OperationIdV1,
  invocationId: string,
  context: CapabilityExecutionContextV1,
  value: BuiltinOperationExecutionValueV1,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_11_PROVIDER_ID_V1,
    executorRevision: RMV1_11_EXECUTOR_REVISIONS_V1[operationId],
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  operationId: Rmv111OperationIdV1,
  invocationId: string,
  context: CapabilityExecutionContextV1,
  code: string,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_11_PROVIDER_ID_V1,
    executorRevision: RMV1_11_EXECUTOR_REVISIONS_V1[operationId],
    requestDigest: context.requestDigest,
    status: 'failed',
    dispatchCertainty: 'none',
    cleanupCertainty: 'not_required',
    failure: Object.freeze({
      code,
      message: `Builtin Runtime operation ${operationId} is unavailable.`,
      retryable: false,
    }),
  });
}

function providerFailureReceiptV1(
  operationId: 'builtin:read_mcp_resource' | 'mcp:dynamic_tool',
  invocationId: string,
  context: CapabilityExecutionContextV1,
  failure: Readonly<Rmv111McpProviderFailureV1>,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_11_PROVIDER_ID_V1,
    executorRevision: RMV1_11_EXECUTOR_REVISIONS_V1[operationId],
    requestDigest: context.requestDigest,
    status: 'failed' as const,
    // The Builtin executor was entered.  The injected readiness wrapper may
    // have rejected before the underlying MCP read was attempted.
    dispatchCertainty: 'attempted' as const,
    cleanupCertainty: 'not_required' as const,
    failure: Object.freeze({
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    }),
  });
}

function operationSuccess(
  stdout: string,
  resultMeta: Readonly<Record<string, RuntimeJsonValueV1>> = {},
): BuiltinOperationExecutionValueV1 {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok: true,
    stdout,
    stderr: '',
    resultMeta: Object.freeze(resultMeta),
  }) as BuiltinOperationExecutionValueV1;
}

function operationFailure(stderr: string): BuiltinOperationExecutionValueV1 {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok: false,
    stdout: '',
    stderr,
    resultMeta: Object.freeze({}),
  }) as BuiltinOperationExecutionValueV1;
}

function skillEmissionValueV1(emission: SkillLifecycleEmission): BuiltinOperationExecutionValueV1 {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok: emission.ok,
    stdout: emission.stdout,
    stderr: emission.stderr,
    resultMeta: Object.freeze({}),
    ...(emission.runtimeEvents
      ? { runtimeEvents: emission.runtimeEvents as unknown as BuiltinRuntimeEventValueV1[] }
      : {}),
  }) as BuiltinOperationExecutionValueV1;
}

function safeMetadata(value: string, maximum = 96): string {
  return Array.from(
    Array.from(value, (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 || (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? ' '
        : character;
    })
      .join('')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
    .slice(0, Math.max(0, maximum))
    .join('');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalIntegerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function truncateProjectedOutputV1(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  const keep = Math.floor(maxLength / 2);
  const head = output.slice(0, keep);
  const tail = output.slice(-keep);
  const omittedLines = output.slice(keep, -keep).split('\n').filter(Boolean).length;
  return `${head}\n... [${omittedLines} lines omitted, ${output.length - 2 * keep} total chars truncated]\n${tail}`;
}

function networkFailureCodeV1(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function projectionDigestV1(stdout: string, stderr: string, exitCode: number): string {
  return createHash('sha256').update(JSON.stringify({ stdout, stderr, exitCode })).digest('hex');
}

function classifyRmv111McpProviderFailureV1(
  error: unknown,
): Readonly<Rmv111McpProviderFailureV1> | undefined {
  if (!isMcpProviderError(error)) return undefined;
  const kind = error.kind;
  const message = safeMetadata(error.message, 256);
  return Object.freeze({
    code: kind,
    message: message || defaultMcpProviderFailureMessageV1(kind),
    retryable: error.retryable,
  });
}

function defaultMcpProviderFailureMessageV1(code: Rmv111McpProviderFailureCodeV1): string {
  switch (code) {
    case 'provider_auth_required':
      return 'MCP provider authentication is required.';
    case 'provider_approval_required':
      return 'MCP provider approval is required.';
    case 'provider_unavailable':
      return 'MCP provider is unavailable.';
    case 'provider_capability_changed':
      return 'MCP provider capabilities changed.';
  }
}

function isExecutionReceiptV1(value: unknown): value is ExecutionReceiptV1 {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.invocationId === 'string' &&
      typeof record.attemptId === 'string' &&
      typeof record.providerId === 'string' &&
      typeof record.executorRevision === 'string' &&
      typeof record.requestDigest === 'string' &&
      typeof record.status === 'string' &&
      typeof record.dispatchCertainty === 'string' &&
      typeof record.cleanupCertainty === 'string',
  );
}
