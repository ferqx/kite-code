import type {
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
} from '@/core/mcp/runtime-provider';
import type {
  CapabilityDescriptor,
  CapabilitySearchCandidate,
  CapabilitySearchProviderDiagnostic,
  CapabilitySnapshot,
} from '@/protocol/capabilities';
import { createSnapshot, digestCapability } from './catalog';
import { isProviderUnavailable, providerSearchNextAction } from './provider-status';
import { safeCapabilityMetadata } from './public-metadata';

export type CapabilityDisclosureMode = 'all' | 'search' | 'fail_closed';

export interface CapabilityDisclosureDecision {
  mode: CapabilityDisclosureMode;
  /** When MCP tools are directly bound but Skills are behind tool_search,
   *  this field carries the Skill-specific mode.  Undefined when the
   *  single `mode` field applies uniformly to both kinds. */
  skillMode?: CapabilityDisclosureMode;
  estimatedTokens: number;
  budgetTokens: number;
  reason: string;
}

const SEARCHABLE_KINDS = new Set<CapabilityDescriptor['kind']>(['mcp_tool', 'skill']);
const MODEL_HIDDEN_SCHEMA_ANNOTATIONS = new Set([
  'description',
  'title',
  '$comment',
  'examples',
  'default',
]);

/** Remove untrusted prose while preserving the schema structure needed to form arguments. */
export function modelVisibleCapabilitySchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelVisibleCapabilitySchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !MODEL_HIDDEN_SCHEMA_ANNOTATIONS.has(key))
      .map(([key, item]) => [key, modelVisibleCapabilitySchema(item)]),
  );
}

export function searchableCapabilitySnapshot(input: {
  mcp?: CapabilitySnapshot;
  skills?: CapabilitySnapshot;
}): CapabilitySnapshot {
  const descriptors = [...(input.mcp?.descriptors ?? []), ...(input.skills?.descriptors ?? [])]
    .filter(
      (descriptor) =>
        SEARCHABLE_KINDS.has(descriptor.kind) && descriptor.availability === 'available',
    )
    .filter(
      (descriptor, index, all) =>
        all.findIndex((candidate) => candidate.capabilityId === descriptor.capabilityId) === index,
    );
  return createSnapshot(descriptors);
}

export function estimateCapabilityCatalogTokens(descriptors: CapabilityDescriptor[]): number {
  const characters = descriptors.reduce(
    (total, descriptor) =>
      total +
      JSON.stringify({
        id: descriptor.capabilityId,
        name: descriptor.displayName,
        description: descriptor.description,
        input: descriptor.inputSchema,
      }).length,
    0,
  );
  return Math.ceil(characters / 4);
}

/** Maximum number of MCP tools directly bound without requiring search. */
const MAX_DIRECT_BIND_TOOL_COUNT = 20;

export function chooseCapabilityDisclosure(input: {
  featureEnabled: boolean;
  providerSupportsToolCalls: boolean;
  descriptors: CapabilityDescriptor[];
  contextWindowTokens?: number;
  budgetTokens?: number;
}): CapabilityDisclosureDecision {
  const mcpDescriptors = input.descriptors.filter((d) => d.kind === 'mcp_tool');
  const skillDescriptors = input.descriptors.filter((d) => d.kind === 'skill');
  const estimatedMcpTokens = estimateCapabilityCatalogTokens(mcpDescriptors);
  const estimatedSkillTokens = estimateCapabilityCatalogTokens(skillDescriptors);
  const estimatedTokens = estimatedMcpTokens + estimatedSkillTokens;
  const contextWindow = input.contextWindowTokens ?? 128_000;
  const budgetTokens =
    input.budgetTokens ?? Math.min(8_192, Math.max(1_024, Math.floor(contextWindow * 0.01)));

  if (!input.featureEnabled) {
    return {
      mode: 'all',
      estimatedTokens,
      budgetTokens,
      reason: 'Progressive disclosure is disabled; use the governed all-binding path.',
    };
  }
  if (!input.providerSupportsToolCalls) {
    return {
      mode: 'fail_closed',
      estimatedTokens,
      budgetTokens,
      reason: 'The provider cannot issue the tool_search tool call.',
    };
  }
  // Small MCP catalogs skip the search round-trip: tools are bound directly so
  // the model can call them without a tool_search → bind → call two-turn delay.
  // The fast path only applies when BOTH MCP count AND token budget are within
  // bounds.  Skill count is intentionally excluded — a large Skill catalog must
  // not be force-disclosed just because MCP tools are few.
  const mcpToolCount = mcpDescriptors.length;
  if (
    mcpToolCount > 0 &&
    mcpToolCount <= MAX_DIRECT_BIND_TOOL_COUNT &&
    estimatedMcpTokens <= budgetTokens
  ) {
    // Skills follow their own decision path — if they exceed budget, they stay
    // behind tool_search while MCP tools are directly bound.
    const skillBehindSearch = skillDescriptors.length > 0 && estimatedSkillTokens > budgetTokens;
    return {
      mode: 'all',
      ...(skillBehindSearch ? { skillMode: 'search' as const } : {}),
      estimatedTokens,
      budgetTokens,
      reason: skillBehindSearch
        ? `${mcpToolCount} MCP tool(s) ≤ ${MAX_DIRECT_BIND_TOOL_COUNT} within token budget; ${skillDescriptors.length} Skill(s) exceed budget — use tool_search for skills.`
        : `${mcpToolCount} MCP tool(s) ≤ ${MAX_DIRECT_BIND_TOOL_COUNT} within token budget; direct binding avoids search latency.`,
    };
  }
  if (estimatedTokens <= budgetTokens) {
    return {
      mode: 'all',
      estimatedTokens,
      budgetTokens,
      reason: 'The governed catalog fits inside the configured disclosure budget.',
    };
  }
  return {
    mode: 'search',
    estimatedTokens,
    budgetTokens,
    reason: 'The catalog exceeds the disclosure budget; expose metadata search only.',
  };
}

function terms(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1)
    .slice(0, 32);
}

function safeMetadata(value: string, maximum = 96): string {
  return safeCapabilityMetadata(value, maximum);
}

/**
 * Detect whether a query is asking for MCP tool/provider inventory.
 * Supports both English (set-based) and Chinese (regex-based) detection
 * without depending on whitespace tokenization.
 */
export function isMcpInventoryIntent(query: string): boolean {
  const normalized = query.trim().slice(0, 512).toLocaleLowerCase();

  const containsMcp = /mcp/i.test(normalized);

  // Chinese inventory patterns — do NOT depend on whitespace tokenization
  const chineseInventory =
    /(有哪些|有什么|列出|显示|查看|当前|可用).{0,10}(工具|服务|服务器|能力)/u.test(normalized) ||
    /(工具|服务|服务器|能力).{0,10}(有哪些|有什么|列表|清单)/u.test(normalized);

  if (!containsMcp && !chineseInventory) return false;

  // English set-based detection (preserve existing logic for backward compat)
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
    if (queryTerms.some((term) => inventoryTerms.has(term))) {
      return (
        queryTerms.every((term) => inventoryTerms.has(term)) ||
        /(?:what|which)\s+(?:mcp\s+)?tools?/u.test(normalized)
      );
    }
  }

  return chineseInventory;
}

/**
 * Return a redirect result when the query is an inventory request.
 * This is an error-recovery mechanism — the primary inventory path is `list_mcp_tools`.
 */
export interface CapabilitySearchInventoryRedirect {
  ok: false;
  code: 'inventory_query';
  message: string;
  next_tool: 'list_mcp_tools';
}

export function checkInventoryRedirect(query: string): CapabilitySearchInventoryRedirect | null {
  if (isMcpInventoryIntent(query)) {
    return {
      ok: false,
      code: 'inventory_query',
      message: 'Use list_mcp_tools to enumerate MCP providers and tools.',
      next_tool: 'list_mcp_tools',
    };
  }
  return null;
}

export function searchCapabilities(input: {
  snapshot: CapabilitySnapshot;
  query: string;
  limit?: number;
}): CapabilitySearchCandidate[] {
  const query = input.query.trim().slice(0, 512);
  const queryTerms = terms(query);
  const phrase = query.toLocaleLowerCase();
  const limit = Math.max(1, Math.min(12, Math.floor(input.limit ?? 8)));

  return input.snapshot.descriptors
    .filter(
      (descriptor): descriptor is CapabilityDescriptor & { kind: 'mcp_tool' | 'skill' } =>
        (descriptor.kind === 'mcp_tool' || descriptor.kind === 'skill') &&
        descriptor.availability === 'available',
    )
    .map((descriptor) => {
      const searchable = [
        descriptor.capabilityId,
        descriptor.displayName,
        descriptor.description,
        descriptor.provider.id,
        descriptor.kind,
      ]
        .join(' ')
        .toLocaleLowerCase();
      const matchedTerms = queryTerms.filter((term) => searchable.includes(term));
      const score =
        (phrase.length > 1 && searchable.includes(phrase) ? 100 : 0) +
        matchedTerms.length * 10 +
        (queryTerms.length > 0 && matchedTerms.length === queryTerms.length ? 25 : 0);
      return { descriptor, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.descriptor.capabilityId.localeCompare(right.descriptor.capabilityId),
    )
    .slice(0, limit)
    .map(({ descriptor }) => ({
      candidateRef: digestCapability({
        catalogRevision: input.snapshot.revision,
        capabilityId: descriptor.capabilityId,
        revision: descriptor.revision,
      }).slice(0, 24),
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      kind: descriptor.kind,
      displayName: safeMetadata(descriptor.displayName),
      providerType: descriptor.provider.type,
      providerId: safeMetadata(descriptor.provider.id),
    }));
}

export function searchUnavailableProviders(input: {
  directory?: McpProviderDirectorySnapshot;
  query: string;
  limit?: number;
}): CapabilitySearchProviderDiagnostic[] {
  const query = input.query.trim().slice(0, 512);
  const queryTerms = terms(query);
  const phrase = query.toLocaleLowerCase();
  const limit = Math.max(1, Math.min(4, Math.floor(input.limit ?? 4)));

  return (input.directory?.entries ?? [])
    .filter(
      (
        entry,
      ): entry is Readonly<
        McpProviderDirectoryEntry & {
          status: Exclude<McpProviderDirectoryEntry['status'], 'ready' | 'degraded'>;
        }
      > => isProviderUnavailable(entry.status),
    )
    .map((entry) => {
      const searchable = [entry.providerId, ...entry.lastKnownCapabilityNames]
        .join(' ')
        .toLocaleLowerCase();
      const matchedTerms = queryTerms.filter((term) => searchable.includes(term));
      const score =
        (phrase.length > 1 && searchable.includes(phrase) ? 100 : 0) +
        matchedTerms.length * 10 +
        (queryTerms.length > 0 && matchedTerms.length === queryTerms.length ? 25 : 0);
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.providerId.localeCompare(right.entry.providerId),
    )
    .slice(0, limit)
    .map(({ entry }) => ({
      providerId: safeMetadata(entry.providerId),
      status: entry.status,
      nextAction: providerSearchNextAction(entry.status),
      ...(entry.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}),
    }));
}

/** Public result intentionally omits IDs, descriptions, schemas, and executable handles. */
export function publicSearchMetadata(candidates: CapabilitySearchCandidate[]) {
  return candidates.map((candidate) => ({
    candidate_ref: candidate.candidateRef,
    kind: candidate.kind,
    name: candidate.displayName,
    provider_type: candidate.providerType,
    provider: candidate.providerId,
  }));
}

export function publicProviderSearchMetadata(
  providers: CapabilitySearchProviderDiagnostic[],
): Array<{ name: string; status: string; next_action: string; diagnostic_code?: string }> {
  return providers.map((provider) => ({
    name: provider.providerId,
    status: provider.status,
    next_action: provider.nextAction,
    ...(provider.diagnosticCode ? { diagnostic_code: provider.diagnosticCode } : {}),
  }));
}
