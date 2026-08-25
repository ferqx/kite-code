import type {
  CapabilityExecutor,
  ExecutionReceipt,
  RuntimeJsonValue,
  RuntimeModule,
} from '@kite/runtime-spi';
import { defineRuntimeModule } from '@kite/runtime-spi';
import { digestCapabilityBindingValue } from './capability-binding';
import type {
  BuiltinCapabilitySearchCandidate,
  BuiltinCapabilitySearchProviderDiagnostic,
} from './capability-disclosure';
import {
  projectCapabilitySearchCandidates,
  projectUnavailableProviderSearch,
} from './capability-disclosure';
import {
  defineBuiltinCapabilityContract,
  parserForBuiltinOperation,
  staticEffectsClassifier,
  toolSearchAvailability,
} from './catalog-contract';
import type { McpDiagnosticCode } from './mcp/diagnostics';
import { isMcpProviderUnavailable } from './mcp/provider-status';
import { createBuiltinPolicyCompiler, readOnlyBuiltinPolicyRule } from './policy-compiler';
import { builtinToolDescription } from './tool-contracts';
import { BUILTIN_JSON_SCHEMAS_ } from './tool-schemas';

export const TOOL_SEARCH_CAPABILITY_ID_ = 'builtin:tool_search' as const;
export const TOOL_SEARCH_PROVIDER_ID_ = 'kite-code' as const;

export const TOOL_SEARCH_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:tool_search'];

const TOOL_SEARCH_EFFECTS_ = Object.freeze({
  filesystem: 'none',
  network: 'read',
  externalState: 'none',
});

export const TOOL_SEARCH_CAPABILITY_REVISION_ = digestCapabilityBindingValue({
  schema: 'kite.builtin-tool-search-capability.v1',
  inputSchema: TOOL_SEARCH_INPUT_SCHEMA_,
  providerId: TOOL_SEARCH_PROVIDER_ID_,
  effects: TOOL_SEARCH_EFFECTS_,
});

export const TOOL_SEARCH_EXECUTOR_REVISION_ = digestCapabilityBindingValue({
  schema: 'kite.builtin-tool-search-executor.v1',
  capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_,
});

type SearchableKind = 'mcp_tool' | 'skill';
type ProviderType = 'builtin' | 'mcp' | 'skill' | 'subagent';
type ProviderStatus =
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'login_required'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'quarantined';

export interface ToolSearchDescriptorInput {
  readonly capabilityId: string;
  readonly revision: string;
  readonly kind: string;
  readonly displayName: string;
  readonly description: string;
  readonly modelDescription?: string;
  readonly provider: Readonly<{ type: ProviderType; id: string }>;
  readonly availability: string;
}

export interface ToolSearchProviderEntryInput {
  readonly providerId: string;
  readonly status: ProviderStatus;
  readonly lastKnownCapabilityNames: readonly string[];
  readonly diagnosticCode?: McpDiagnosticCode;
}

type FrozenSearchDescriptor = Readonly<{
  capabilityId: string;
  revision: string;
  kind: SearchableKind;
  displayName: string;
  description: string;
  providerType: ProviderType;
  providerId: string;
}>;

type FrozenProviderEntry = Readonly<{
  providerId: string;
  status: ProviderStatus;
  lastKnownCapabilityNames: readonly string[];
  diagnosticCode?: McpDiagnosticCode;
}>;

export type ToolSearchProviderFacts = RuntimeJsonValue &
  Readonly<{
    schema: 'kite.builtin-tool-search-facts.v1';
    threadId: string;
    turnId: string;
    toolCallId: string;
    catalogRevision: string;
    descriptors: readonly FrozenSearchDescriptor[];
    providers: readonly FrozenProviderEntry[];
    catalogSummary: Readonly<{
      availableMcpToolCount: number;
      availableSkillCount: number;
      configuredProviderCount: number;
      unavailableProviderCount: number;
      nonHealthyProviderCount: number;
    }>;
  }>;

export type ToolSearchCandidate = BuiltinCapabilitySearchCandidate;
export type ToolSearchProviderDiagnostic = BuiltinCapabilitySearchProviderDiagnostic;

export type ToolSearchResult = RuntimeJsonValue &
  Readonly<{
    searchId: string;
    query: string;
    catalogRevision: string;
    requestedAtTurnId: string;
    candidates: readonly ToolSearchCandidate[];
    providers?: readonly ToolSearchProviderDiagnostic[];
  }>;

export type ToolSearchExecutionValue = RuntimeJsonValue &
  Readonly<{
    schema: 'kite.builtin-tool-search-result.v1';
    stdout: string;
    searchResult?: ToolSearchResult;
  }>;

export function createToolSearchProviderFacts(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly mcpDescriptors?: readonly ToolSearchDescriptorInput[];
  readonly skillDescriptors?: readonly ToolSearchDescriptorInput[];
  readonly providerEntries?: readonly ToolSearchProviderEntryInput[];
}): ToolSearchProviderFacts {
  const allDescriptors = [...(input.mcpDescriptors ?? []), ...(input.skillDescriptors ?? [])];
  const searchable = allDescriptors
    .filter(
      (descriptor): descriptor is ToolSearchDescriptorInput & { kind: SearchableKind } =>
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
  const catalogRevision = digestCapabilityBindingValue(
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
      unavailableProviderCount: providers.filter((entry) => isMcpProviderUnavailable(entry.status))
        .length,
      nonHealthyProviderCount: providers.filter((entry) => entry.status !== 'ready').length,
    }),
  }) as ToolSearchProviderFacts;
}

export function createToolSearchRuntimeModule(): RuntimeModule {
  const executor: CapabilityExecutor = Object.freeze({
    providerId: TOOL_SEARCH_PROVIDER_ID_,
    capabilityId: TOOL_SEARCH_CAPABILITY_ID_,
    capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_,
    executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_,
    execute: executeToolSearch,
  });
  return defineRuntimeModule({
    moduleId: 'kite-builtin-runtime',
    providerId: TOOL_SEARCH_PROVIDER_ID_,
    revision: 'builtin-catalog-current',
    operationIds: [TOOL_SEARCH_CAPABILITY_ID_],
    register: (registry) => {
      registry.registerCapability(
        defineBuiltinCapabilityContract(
          {
            capabilityId: TOOL_SEARCH_CAPABILITY_ID_,
            revision: TOOL_SEARCH_CAPABILITY_REVISION_,
            providerId: TOOL_SEARCH_PROVIDER_ID_,
            title: 'Tool search catalog observation',
            executionMechanism: 'catalog',
            toolName: 'tool_search',
            description: builtinToolDescription('tool_search'),
            visibility: 'model',
            effects: TOOL_SEARCH_EFFECTS_,
            inputSchema: TOOL_SEARCH_INPUT_SCHEMA_,
            inputSchemaDigest: digestCapabilityBindingValue(TOOL_SEARCH_INPUT_SCHEMA_),
          },
          {
            parser: parserForBuiltinOperation(
              TOOL_SEARCH_CAPABILITY_ID_,
              TOOL_SEARCH_CAPABILITY_REVISION_,
            ),
            kind: 'coordination',
            minimumApproval: 'none',
            availability: toolSearchAvailability,
            effectsClassifier: staticEffectsClassifier(
              'read_only',
              false,
              'Searches governed capability metadata without issuing a binding.',
              TOOL_SEARCH_EFFECTS_,
            ),
            policyCompiler: createBuiltinPolicyCompiler({
              operationId: TOOL_SEARCH_CAPABILITY_ID_,
              capabilityRevision: TOOL_SEARCH_CAPABILITY_REVISION_,
              parserRevision: TOOL_SEARCH_CAPABILITY_REVISION_,
              declaredEffects: TOOL_SEARCH_EFFECTS_,
              minimumApproval: 'none',
              rule: readOnlyBuiltinPolicyRule,
            }),
          },
        ),
      );
      registry.registerExecutor(executor);
    },
  });
}

export function isToolSearchExecutionValue(
  value: RuntimeJsonValue | undefined,
): value is ToolSearchExecutionValue {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schema === 'kite.builtin-tool-search-result.v1' &&
      typeof record.stdout === 'string',
  );
}

async function executeToolSearch(
  request: Parameters<CapabilityExecutor['execute']>[0],
  context: Parameters<CapabilityExecutor['execute']>[1],
): Promise<ExecutionReceipt> {
  const input = asRecord(request.input);
  const facts = readToolSearchFacts(request.facts);
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
      providerId: TOOL_SEARCH_PROVIDER_ID_,
      executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_,
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

  const candidates = projectCapabilitySearchCandidates({
    catalogRevision: facts.catalogRevision,
    descriptors: facts.descriptors,
    query,
    limit: limitValue as number | undefined,
  });
  const providers = projectUnavailableProviderSearch({
    entries: facts.providers,
    query,
    limit: limitValue as number | undefined,
  });
  const searchId = digestCapabilityBindingValue({
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
  }) as ToolSearchResult;
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
  context: Parameters<CapabilityExecutor['execute']>[1],
  value: ToolSearchExecutionValue,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: TOOL_SEARCH_PROVIDER_ID_,
    executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_,
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  invocationId: string,
  context: Parameters<CapabilityExecutor['execute']>[1],
  code: string,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: TOOL_SEARCH_PROVIDER_ID_,
    executorRevision: TOOL_SEARCH_EXECUTOR_REVISION_,
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

function inventoryRedirect(query: string): RuntimeJsonValue | null {
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

function inventoryRedirectValue(): RuntimeJsonValue {
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
  value: RuntimeJsonValue | undefined,
): Readonly<Record<string, RuntimeJsonValue>> | null {
  return value && typeof value === 'object' && !isRuntimeJsonArray(value) ? value : null;
}

function isRuntimeJsonArray(value: RuntimeJsonValue): value is readonly RuntimeJsonValue[] {
  return Array.isArray(value);
}

function readToolSearchFacts(value: RuntimeJsonValue | undefined): ToolSearchProviderFacts | null {
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
  return value as ToolSearchProviderFacts;
}
