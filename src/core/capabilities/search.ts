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

export type CapabilityDisclosureMode = 'all' | 'search' | 'fail_closed';

export interface CapabilityDisclosureDecision {
  mode: CapabilityDisclosureMode;
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

export function chooseCapabilityDisclosure(input: {
  featureEnabled: boolean;
  providerSupportsToolCalls: boolean;
  descriptors: CapabilityDescriptor[];
  contextWindowTokens?: number;
  budgetTokens?: number;
}): CapabilityDisclosureDecision {
  const estimatedTokens = estimateCapabilityCatalogTokens(input.descriptors);
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
      reason: 'The provider cannot issue the capability_search tool call.',
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
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

const MCP_INVENTORY_TERMS = new Set([
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

export function isMcpInventoryQuery(query: string): boolean {
  const queryTerms = terms(query.trim().slice(0, 512));
  const normalized = query.toLocaleLowerCase();
  if (!queryTerms.includes('mcp')) return false;
  if (
    !queryTerms.some((term) =>
      ['available', 'catalog', 'configured', 'list', 'server', 'servers', 'tool', 'tools'].includes(
        term,
      ),
    )
  ) {
    return false;
  }
  return (
    queryTerms.every((term) => MCP_INVENTORY_TERMS.has(term)) ||
    /(?:what|which)\s+(?:mcp\s+)?tools?/u.test(normalized)
  );
}

/** Stable names-only context; remote prose and executable identities stay hidden. */
export function capabilityNameSummary(descriptors: CapabilityDescriptor[]) {
  return descriptors
    .filter((descriptor) => descriptor.kind === 'mcp_tool')
    .map((descriptor) => ({
      provider: safeMetadata(descriptor.provider.id),
      tool: safeMetadata(descriptor.displayName),
    }))
    .filter(({ provider, tool }) => provider.length > 0 && tool.length > 0)
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.tool.localeCompare(right.tool),
    );
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
  const inventoryQuery = isMcpInventoryQuery(query);

  return input.snapshot.descriptors
    .filter(
      (descriptor): descriptor is CapabilityDescriptor & { kind: 'mcp_tool' | 'skill' } =>
        (descriptor.kind === 'mcp_tool' || descriptor.kind === 'skill') &&
        descriptor.availability === 'available' &&
        (!inventoryQuery || descriptor.kind === 'mcp_tool'),
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
      const score = inventoryQuery
        ? 1
        : (phrase.length > 1 && searchable.includes(phrase) ? 100 : 0) +
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
          status: Exclude<McpProviderDirectoryEntry['status'], 'ready'>;
        }
      > => entry.status !== 'ready',
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
      nextAction: providerNextAction(entry.status),
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

/**
 * Names-only fallback for an inventory request that crossed a catalog revision boundary.
 * These entries are informational and never become search candidates or bindings.
 */
export function lastKnownMcpToolMetadata(input: {
  directory?: McpProviderDirectorySnapshot;
  limit?: number;
}): Array<{
  kind: 'mcp_tool';
  name: string;
  provider_type: 'mcp';
  provider: string;
  catalog_status: 'last_known';
}> {
  const limit = Math.max(1, Math.min(12, Math.floor(input.limit ?? 8)));
  return (input.directory?.entries ?? [])
    .flatMap((entry) =>
      entry.lastKnownCapabilityNames.map((name) => ({
        kind: 'mcp_tool' as const,
        name: safeMetadata(name),
        provider_type: 'mcp' as const,
        provider: safeMetadata(entry.providerId),
        catalog_status: 'last_known' as const,
      })),
    )
    .filter(
      (entry, index, all) =>
        entry.name.length > 0 &&
        entry.provider.length > 0 &&
        all.findIndex(
          (candidate) => candidate.provider === entry.provider && candidate.name === entry.name,
        ) === index,
    )
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

export function hasUnavailableMcpProviders(
  directory: McpProviderDirectorySnapshot | undefined,
): boolean {
  return directory?.entries.some((entry) => entry.status !== 'ready') ?? false;
}

function providerNextAction(status: CapabilitySearchProviderDiagnostic['status']): string {
  switch (status) {
    case 'pending_approval':
      return 'Complete the MCP project approval prompt.';
    case 'rejected':
      return 'Update the MCP project approval decision.';
    case 'disabled':
      return 'Enable the provider in MCP configuration.';
    case 'login_required':
      return 'Complete the MCP authentication prompt.';
    case 'connecting':
      return 'Wait for the provider to finish connecting.';
    case 'degraded':
    case 'failed':
      return 'Retry the provider connection outside the current tool call.';
    case 'quarantined':
      return 'Fix the MCP provider configuration or capability schema.';
  }
}
