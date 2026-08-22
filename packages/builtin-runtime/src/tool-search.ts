import type {
  CapabilityExecutorV1,
  ExecutionReceiptV1,
  RuntimeJsonValueV1,
  RuntimeModuleV1,
} from '@kite/runtime-spi';
import { defineRuntimeModuleV1 } from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import type {
  BuiltinCapabilitySearchCandidateV1,
  BuiltinCapabilitySearchProviderDiagnosticV1,
} from './capability-disclosure';
import {
  projectCapabilitySearchCandidatesV1,
  projectUnavailableProviderSearchV1,
} from './capability-disclosure';
import {
  defineBuiltinCapabilityContractV1,
  parserForBuiltinOperationV1,
  staticEffectsClassifierV1,
  toolSearchAvailabilityV1,
} from './catalog-contract';
import type { McpDiagnosticCode } from './mcp/diagnostics';
import { isMcpProviderUnavailableV1 } from './mcp/provider-status';
import { createBuiltinPolicyCompilerV1, readOnlyBuiltinPolicyRuleV1 } from './policy-compiler';
import { builtinToolDescriptionV1 } from './tool-contracts';
import { BUILTIN_JSON_SCHEMAS_V1 } from './tool-schemas';

export const TOOL_SEARCH_CAPABILITY_ID_V1 = 'builtin:tool_search' as const;
export const TOOL_SEARCH_PROVIDER_ID_V1 = 'kite-code' as const;

export const TOOL_SEARCH_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:tool_search'];

const TOOL_SEARCH_EFFECTS_V1 = Object.freeze({
  filesystem: 'none',
  network: 'read',
  externalState: 'none',
});

export const TOOL_SEARCH_CAPABILITY_REVISION_V1 = digestCapabilityBindingValueV1({
  schema: 'kite.builtin-tool-search-capability.v1',
  inputSchema: TOOL_SEARCH_INPUT_SCHEMA_V1,
  providerId: TOOL_SEARCH_PROVIDER_ID_V1,
  effects: TOOL_SEARCH_EFFECTS_V1,
});

export const TOOL_SEARCH_EXECUTOR_REVISION_V1 = digestCapabilityBindingValueV1({
  schema: 'kite.builtin-tool-search-executor.v1',
  capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_V1,
});

type SearchableKindV1 = 'mcp_tool' | 'skill';
type ProviderTypeV1 = 'builtin' | 'mcp' | 'skill' | 'subagent';
type ProviderStatusV1 =
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'login_required'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'quarantined';

export interface ToolSearchDescriptorInputV1 {
  readonly capabilityId: string;
  readonly revision: string;
  readonly kind: string;
  readonly displayName: string;
  readonly description: string;
  readonly modelDescription?: string;
  readonly provider: Readonly<{ type: ProviderTypeV1; id: string }>;
  readonly availability: string;
}

export interface ToolSearchProviderEntryInputV1 {
  readonly providerId: string;
  readonly status: ProviderStatusV1;
  readonly lastKnownCapabilityNames: readonly string[];
  readonly diagnosticCode?: McpDiagnosticCode;
}

type FrozenSearchDescriptorV1 = Readonly<{
  capabilityId: string;
  revision: string;
  kind: SearchableKindV1;
  displayName: string;
  description: string;
  providerType: ProviderTypeV1;
  providerId: string;
}>;

type FrozenProviderEntryV1 = Readonly<{
  providerId: string;
  status: ProviderStatusV1;
  lastKnownCapabilityNames: readonly string[];
  diagnosticCode?: McpDiagnosticCode;
}>;

export type ToolSearchProviderFactsV1 = RuntimeJsonValueV1 &
  Readonly<{
    schema: 'kite.builtin-tool-search-facts.v1';
    threadId: string;
    turnId: string;
    toolCallId: string;
    catalogRevision: string;
    descriptors: readonly FrozenSearchDescriptorV1[];
    providers: readonly FrozenProviderEntryV1[];
    catalogSummary: Readonly<{
      availableMcpToolCount: number;
      availableSkillCount: number;
      configuredProviderCount: number;
      unavailableProviderCount: number;
      nonHealthyProviderCount: number;
    }>;
  }>;

export type ToolSearchCandidateV1 = BuiltinCapabilitySearchCandidateV1;
export type ToolSearchProviderDiagnosticV1 = BuiltinCapabilitySearchProviderDiagnosticV1;

export type ToolSearchResultV1 = RuntimeJsonValueV1 &
  Readonly<{
    searchId: string;
    query: string;
    catalogRevision: string;
    requestedAtTurnId: string;
    candidates: readonly ToolSearchCandidateV1[];
    providers?: readonly ToolSearchProviderDiagnosticV1[];
  }>;

export type ToolSearchExecutionValueV1 = RuntimeJsonValueV1 &
  Readonly<{
    schema: 'kite.builtin-tool-search-result.v1';
    stdout: string;
    searchResult?: ToolSearchResultV1;
  }>;

export function createToolSearchProviderFactsV1(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly mcpDescriptors?: readonly ToolSearchDescriptorInputV1[];
  readonly skillDescriptors?: readonly ToolSearchDescriptorInputV1[];
  readonly providerEntries?: readonly ToolSearchProviderEntryInputV1[];
}): ToolSearchProviderFactsV1 {
  const allDescriptors = [...(input.mcpDescriptors ?? []), ...(input.skillDescriptors ?? [])];
  const searchable = allDescriptors
    .filter(
      (descriptor): descriptor is ToolSearchDescriptorInputV1 & { kind: SearchableKindV1 } =>
        (descriptor.kind === 'mcp_tool' || descriptor.kind === 'skill') &&
        descriptor.availability === 'available',
    )
    .filter(
      (descriptor, index, all) =>
        all.findIndex((candidate) => candidate.capabilityId === descriptor.capabilityId) === index,
    )
    .map((descriptor) =>
      Object.freeze({
        capabilityId: descriptor.capabilityId,
        revision: descriptor.revision,
        kind: descriptor.kind,
        displayName: descriptor.displayName,
        description: descriptor.modelDescription ?? descriptor.description,
        providerType: descriptor.provider.type,
        providerId: descriptor.provider.id,
      }),
    )
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  const providers = (input.providerEntries ?? []).map((entry) =>
    Object.freeze({
      providerId: entry.providerId,
      status: entry.status,
      lastKnownCapabilityNames: Object.freeze([...entry.lastKnownCapabilityNames]),
      ...(entry.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}),
    }),
  );
  const catalogRevision = digestCapabilityBindingValueV1(
    searchable.map((descriptor) => ({
      capabilityId: descriptor.capabilityId,
      revision: descriptor.revision,
    })),
  );
  return Object.freeze({
    schema: 'kite.builtin-tool-search-facts.v1',
    threadId: input.threadId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    catalogRevision,
    descriptors: Object.freeze(searchable),
    providers: Object.freeze(providers),
    catalogSummary: Object.freeze({
      availableMcpToolCount: (input.mcpDescriptors ?? []).filter(
        (descriptor) => descriptor.kind === 'mcp_tool' && descriptor.availability === 'available',
      ).length,
      availableSkillCount: (input.skillDescriptors ?? []).filter(
        (descriptor) => descriptor.kind === 'skill' && descriptor.availability === 'available',
      ).length,
      configuredProviderCount: providers.length,
      unavailableProviderCount: providers.filter((entry) =>
        isMcpProviderUnavailableV1(entry.status),
      ).length,
      nonHealthyProviderCount: providers.filter((entry) => entry.status !== 'ready').length,
    }),
  }) as ToolSearchProviderFactsV1;
}

export function createToolSearchRuntimeModuleV1(): RuntimeModuleV1 {
  const executor: CapabilityExecutorV1 = Object.freeze({
    providerId: TOOL_SEARCH_PROVIDER_ID_V1,
    capabilityId: TOOL_SEARCH_CAPABILITY_ID_V1,
    capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_V1,
    executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_V1,
    execute: executeToolSearchV1,
  });
  return defineRuntimeModuleV1({
    moduleId: 'kite-builtin-runtime',
    providerId: TOOL_SEARCH_PROVIDER_ID_V1,
    revision: 'rmv1-10',
    operationIds: [TOOL_SEARCH_CAPABILITY_ID_V1],
    register: (registry) => {
      registry.registerCapability(
        defineBuiltinCapabilityContractV1(
          {
            capabilityId: TOOL_SEARCH_CAPABILITY_ID_V1,
            revision: TOOL_SEARCH_CAPABILITY_REVISION_V1,
            providerId: TOOL_SEARCH_PROVIDER_ID_V1,
            title: 'Tool search catalog observation',
            executionMechanism: 'catalog',
            toolName: 'tool_search',
            description: builtinToolDescriptionV1('tool_search'),
            visibility: 'model',
            effects: TOOL_SEARCH_EFFECTS_V1,
            inputSchema: TOOL_SEARCH_INPUT_SCHEMA_V1,
            inputSchemaDigest: digestCapabilityBindingValueV1(TOOL_SEARCH_INPUT_SCHEMA_V1),
          },
          {
            parser: parserForBuiltinOperationV1(
              TOOL_SEARCH_CAPABILITY_ID_V1,
              TOOL_SEARCH_CAPABILITY_REVISION_V1,
            ),
            kind: 'coordination',
            minimumApproval: 'none',
            availability: toolSearchAvailabilityV1,
            effectsClassifier: staticEffectsClassifierV1(
              'read_only',
              false,
              'Searches governed capability metadata without issuing a binding.',
              TOOL_SEARCH_EFFECTS_V1,
            ),
            policyCompiler: createBuiltinPolicyCompilerV1({
              operationId: TOOL_SEARCH_CAPABILITY_ID_V1,
              capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_V1,
              parserRevision: TOOL_SEARCH_CAPABILITY_REVISION_V1,
              declaredEffects: TOOL_SEARCH_EFFECTS_V1,
              minimumApproval: 'none',
              rule: readOnlyBuiltinPolicyRuleV1,
            }),
          },
        ),
      );
      registry.registerExecutor(executor);
    },
  });
}

export function isToolSearchExecutionValueV1(
  value: RuntimeJsonValueV1 | undefined,
): value is ToolSearchExecutionValueV1 {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schema === 'kite.builtin-tool-search-result.v1' &&
      typeof record.stdout === 'string',
  );
}

async function executeToolSearchV1(
  request: Parameters<CapabilityExecutorV1['execute']>[0],
  context: Parameters<CapabilityExecutorV1['execute']>[1],
): Promise<ExecutionReceiptV1> {
  const input = asRecord(request.input);
  const facts = readToolSearchFactsV1(request.facts);
  if (!input || typeof input.query !== 'string' || !facts) {
    return failedReceipt(request.invocationId, context, 'tool_search_invalid_input');
  }
  const query = input.query.trim().slice(0, 512);
  const limitValue = input.limit;
  if (
    query.length < 2 ||
    (limitValue !== undefined &&
      (typeof limitValue !== 'number' ||
        !Number.isSafeInteger(limitValue) ||
        limitValue < 1 ||
        limitValue > 12))
  ) {
    return failedReceipt(request.invocationId, context, 'tool_search_invalid_input');
  }
  if (context.signal.aborted) {
    return Object.freeze({
      invocationId: request.invocationId,
      attemptId: context.attempt.attemptId,
      providerId: TOOL_SEARCH_PROVIDER_ID_V1,
      executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_V1,
      requestDigest: context.requestDigest,
      status: 'cancelled',
      dispatchCertainty: 'none',
      cleanupCertainty: 'not_required',
    });
  }
  const redirect = inventoryRedirect(query);
  if (redirect) {
    return succeededReceipt(request.invocationId, context, {
      schema: 'kite.builtin-tool-search-result.v1',
      stdout: JSON.stringify(redirect),
    });
  }

  const candidates = projectCapabilitySearchCandidatesV1({
    catalogRevision: facts.catalogRevision,
    descriptors: facts.descriptors,
    query,
    limit: limitValue as number | undefined,
  });
  const providers = projectUnavailableProviderSearchV1({
    entries: facts.providers,
    query,
    limit: limitValue as number | undefined,
  });
  const searchId = digestCapabilityBindingValueV1({
    threadId: facts.threadId,
    turnId: facts.turnId,
    toolCallId: facts.toolCallId,
    query,
    catalogRevision: facts.catalogRevision,
  });
  const searchResult = Object.freeze({
    searchId,
    query,
    catalogRevision: facts.catalogRevision,
    requestedAtTurnId: facts.turnId,
    candidates,
    ...(providers.length > 0 ? { providers } : {}),
  }) as ToolSearchResultV1;
  const showSummary = candidates.length === 0;
  const catalogMessage =
    providers.length > 0
      ? 'No executable capabilities matched. Matching providers are currently unavailable; the overall catalog may still contain other tools.'
      : 'No capabilities matched this query. This does not mean the capability catalog is empty.';
  return succeededReceipt(request.invocationId, context, {
    schema: 'kite.builtin-tool-search-result.v1',
    stdout: JSON.stringify({
      ok: true,
      search_id: searchId,
      candidate_count: candidates.length,
      candidates: candidates.map((candidate) => ({
        candidate_ref: candidate.candidateRef,
        kind: candidate.kind,
        name: candidate.displayName,
        provider_type: candidate.providerType,
        provider: candidate.providerId,
      })),
      executable_candidate_count: candidates.length,
      provider_count: providers.length,
      providers: providers.map((provider) => ({
        name: provider.providerId,
        status: provider.status,
        next_action: provider.nextAction,
        ...(provider.diagnosticCode ? { diagnostic_code: provider.diagnosticCode } : {}),
      })),
      ...(showSummary
        ? {
            catalog_summary: {
              available_mcp_tool_count: facts.catalogSummary.availableMcpToolCount,
              available_skill_count: facts.catalogSummary.availableSkillCount,
              configured_provider_count: facts.catalogSummary.configuredProviderCount,
              unavailable_provider_count: facts.catalogSummary.unavailableProviderCount,
              ...(facts.catalogSummary.nonHealthyProviderCount > 0
                ? { non_healthy_provider_count: facts.catalogSummary.nonHealthyProviderCount }
                : {}),
            },
            message: catalogMessage,
          }
        : {}),
      next_step:
        candidates.length > 0
          ? 'The Runtime will disclose current matching capabilities on the next model call.'
          : providers.length > 0
            ? 'The matching providers are unavailable and no executable binding was issued.'
            : 'No matching capability or known unavailable provider was found.',
    }),
    searchResult,
  });
}

function succeededReceipt(
  invocationId: string,
  context: Parameters<CapabilityExecutorV1['execute']>[1],
  value: ToolSearchExecutionValueV1,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: TOOL_SEARCH_PROVIDER_ID_V1,
    executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_V1,
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  invocationId: string,
  context: Parameters<CapabilityExecutorV1['execute']>[1],
  code: string,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: TOOL_SEARCH_PROVIDER_ID_V1,
    executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_V1,
    requestDigest: context.requestDigest,
    status: 'failed',
    dispatchCertainty: 'none',
    cleanupCertainty: 'not_required',
    failure: Object.freeze({
      code,
      message: 'Tool search request or provider facts are invalid.',
      retryable: false,
    }),
  });
}

function inventoryRedirect(query: string): RuntimeJsonValueV1 | null {
  const normalized = query.trim().slice(0, 512).toLocaleLowerCase();
  const containsMcp = /mcp/i.test(normalized);
  const chineseInventory =
    /(有哪些|有什么|列出|显示|查看|当前|可用).{0,10}(工具|服务|服务器|能力)/u.test(normalized) ||
    /(工具|服务|服务器|能力).{0,10}(有哪些|有什么|列表|清单)/u.test(normalized);
  if (!containsMcp && !chineseInventory) return null;
  if (containsMcp) {
    const queryTerms = terms(normalized);
    const inventoryTerms = new Set([
      'available',
      'catalog',
      'configured',
      'list',
      'mcp',
      'server',
      'servers',
      'tool',
      'tools',
    ]);
    if (
      queryTerms.some((term) => inventoryTerms.has(term)) &&
      (queryTerms.every((term) => inventoryTerms.has(term)) ||
        /(?:what|which)\s+(?:mcp\s+)?tools?/u.test(normalized))
    ) {
      return inventoryRedirectValue();
    }
  }
  return chineseInventory ? inventoryRedirectValue() : null;
}

function inventoryRedirectValue(): RuntimeJsonValueV1 {
  return Object.freeze({
    ok: false,
    code: 'inventory_query',
    message: 'Use list_mcp_tools to enumerate MCP providers and tools.',
    next_tool: 'list_mcp_tools',
  });
}

function terms(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1)
    .slice(0, 32);
}

function asRecord(
  value: RuntimeJsonValueV1 | undefined,
): Readonly<Record<string, RuntimeJsonValueV1>> | null {
  return value && typeof value === 'object' && !isRuntimeJsonArrayV1(value) ? value : null;
}

function isRuntimeJsonArrayV1(value: RuntimeJsonValueV1): value is readonly RuntimeJsonValueV1[] {
  return Array.isArray(value);
}

function readToolSearchFactsV1(
  value: RuntimeJsonValueV1 | undefined,
): ToolSearchProviderFactsV1 | null {
  const record = asRecord(value);
  if (
    record?.schema !== 'kite.builtin-tool-search-facts.v1' ||
    typeof record.threadId !== 'string' ||
    typeof record.turnId !== 'string' ||
    typeof record.toolCallId !== 'string' ||
    typeof record.catalogRevision !== 'string' ||
    !Array.isArray(record.descriptors) ||
    !Array.isArray(record.providers) ||
    !record.catalogSummary ||
    typeof record.catalogSummary !== 'object' ||
    Array.isArray(record.catalogSummary)
  ) {
    return null;
  }
  return value as ToolSearchProviderFactsV1;
}
