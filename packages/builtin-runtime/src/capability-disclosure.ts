import type {
  CapabilityDescriptor,
  CapabilitySearchCandidate,
  CapabilitySearchProviderDiagnostic,
  CapabilitySnapshot,
} from '@kite/runtime-contract';
import type { RuntimeJsonValue } from '@kite/runtime-spi';
import { safeCapabilityMetadata } from './mcp/capability-domain';
import type { McpDiagnosticCode } from './mcp/diagnostics';
import { isMcpProviderUnavailable, mcpProviderSearchNextAction } from './mcp/provider-status';
import type {
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
} from './mcp/runtime-provider';
import { createCapabilitySnapshot, digestCapabilityValue } from './skills/capability-domain';

export type CapabilityDisclosureMode = 'all' | 'search' | 'fail_closed';

export interface CapabilityDisclosureDecision {
  readonly mode: CapabilityDisclosureMode;
  readonly skillMode?: CapabilityDisclosureMode;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  readonly reason: string;
}

export interface SearchableCapabilityDescriptor {
  readonly capabilityId: string;
  readonly revision: string;
  readonly kind: 'mcp_tool' | 'skill';
  readonly displayName: string;
  readonly description: string;
  readonly providerType: 'builtin' | 'mcp' | 'skill' | 'subagent';
  readonly providerId: string;
}

export interface SearchableProviderEntry {
  readonly providerId: string;
  readonly status: McpProviderDirectoryEntry['status'];
  readonly lastKnownCapabilityNames: readonly string[];
  readonly diagnosticCode?: McpDiagnosticCode;
}

export type BuiltinCapabilitySearchCandidate = RuntimeJsonValue &
  Readonly<CapabilitySearchCandidate>;
export type BuiltinCapabilitySearchProviderDiagnostic = RuntimeJsonValue &
  Readonly<CapabilitySearchProviderDiagnostic>;

const SEARCHABLE_KINDS = new Set<CapabilityDescriptor['kind']>(['mcp_tool', 'skill']);
const MODEL_HIDDEN_SCHEMA_ANNOTATIONS = new Set([
  'description',
  'title',
  '$comment',
  'examples',
  'default',
]);
const MAX_DIRECT_BIND_TOOL_COUNT = 20;

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
  readonly mcp?: CapabilitySnapshot;
  readonly skills?: CapabilitySnapshot;
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
  return createCapabilitySnapshot(descriptors);
}

export function estimateCapabilityCatalogTokens(
  descriptors: readonly CapabilityDescriptor[],
): number {
  const characters = descriptors.reduce(
    (total, descriptor) =>
      total +
      JSON.stringify({
        id: descriptor.capabilityId,
        name: descriptor.displayName,
        description: descriptor.modelDescription ?? descriptor.description,
        input: descriptor.inputSchema,
      }).length,
    0,
  );
  return Math.ceil(characters / 4);
}

export function chooseCapabilityDisclosure(input: {
  readonly featureEnabled: boolean;
  readonly providerSupportsToolCalls: boolean;
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly contextWindowTokens?: number;
  readonly budgetTokens?: number;
}): CapabilityDisclosureDecision {
  const mcpDescriptors = input.descriptors.filter((descriptor) => descriptor.kind === 'mcp_tool');
  const skillDescriptors = input.descriptors.filter((descriptor) => descriptor.kind === 'skill');
  const estimatedMcpTokens = estimateCapabilityCatalogTokens(mcpDescriptors);
  const estimatedSkillTokens = estimateCapabilityCatalogTokens(skillDescriptors);
  const estimatedTokens = estimatedMcpTokens + estimatedSkillTokens;
  const budgetTokens =
    input.budgetTokens ??
    (input.contextWindowTokens
      ? Math.min(8_192, Math.max(1_024, Math.floor(input.contextWindowTokens * 0.01)))
      : 1_024);
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
  const mcpToolCount = mcpDescriptors.length;
  if (
    mcpToolCount > 0 &&
    mcpToolCount <= MAX_DIRECT_BIND_TOOL_COUNT &&
    estimatedMcpTokens <= budgetTokens
  ) {
    const remainingBudget = Math.max(0, budgetTokens - estimatedMcpTokens);
    const skillBehindSearch = skillDescriptors.length > 0 && estimatedSkillTokens > remainingBudget;
    return {
      mode: 'all',
      ...(skillBehindSearch ? { skillMode: 'search' as const } : {}),
      estimatedTokens,
      budgetTokens,
      reason: skillBehindSearch
        ? `${mcpToolCount} MCP tool(s) ≤ ${MAX_DIRECT_BIND_TOOL_COUNT} within token budget; remaining budget ${remainingBudget} insufficient for ${skillDescriptors.length} Skill(s) — use tool_search for skills.`
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

export function searchCapabilitySnapshot(input: {
  readonly snapshot: CapabilitySnapshot;
  readonly query: string;
  readonly limit?: number;
}): readonly BuiltinCapabilitySearchCandidate[] {
  return projectCapabilitySearchCandidates({
    catalogRevision: input.snapshot.revision,
    descriptors: input.snapshot.descriptors
      .filter(
        (descriptor): descriptor is CapabilityDescriptor & { kind: 'mcp_tool' | 'skill' } =>
          (descriptor.kind === 'mcp_tool' || descriptor.kind === 'skill') &&
          descriptor.availability === 'available',
      )
      .map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        revision: descriptor.revision,
        kind: descriptor.kind,
        displayName: descriptor.displayName,
        description: descriptor.modelDescription ?? descriptor.description,
        providerType: descriptor.provider.type,
        providerId: descriptor.provider.id,
      })),
    query: input.query,
    limit: input.limit,
  });
}

export function projectCapabilitySearchCandidates(input: {
  readonly catalogRevision: string;
  readonly descriptors: readonly SearchableCapabilityDescriptor[];
  readonly query: string;
  readonly limit?: number;
}): readonly BuiltinCapabilitySearchCandidate[] {
  const query = input.query.trim().slice(0, 512);
  const queryTerms = terms(query);
  const phrase = query.toLocaleLowerCase();
  const limit = Math.max(1, Math.min(12, Math.floor(input.limit ?? 8)));
  return Object.freeze(
    input.descriptors
      .map((descriptor) => {
        const searchable = [
          descriptor.capabilityId,
          descriptor.displayName,
          descriptor.description,
          descriptor.providerId,
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
      .map(({ descriptor }) =>
        Object.freeze({
          candidateRef: digestCapabilityValue({
            catalogRevision: input.catalogRevision,
            capabilityId: descriptor.capabilityId,
            revision: descriptor.revision,
          }).slice(0, 24),
          capabilityId: descriptor.capabilityId,
          capabilityRevision: descriptor.revision,
          kind: descriptor.kind,
          displayName: safeCapabilityMetadata(descriptor.displayName),
          providerType: descriptor.providerType,
          providerId: safeCapabilityMetadata(descriptor.providerId),
        }),
      ),
  );
}

export function searchUnavailableProviders(input: {
  readonly directory?: McpProviderDirectorySnapshot;
  readonly query: string;
  readonly limit?: number;
}): readonly BuiltinCapabilitySearchProviderDiagnostic[] {
  return projectUnavailableProviderSearch({
    entries: input.directory?.entries ?? [],
    query: input.query,
    limit: input.limit,
  });
}

export function projectUnavailableProviderSearch(input: {
  readonly entries: readonly SearchableProviderEntry[];
  readonly query: string;
  readonly limit?: number;
}): readonly BuiltinCapabilitySearchProviderDiagnostic[] {
  const query = input.query.trim().slice(0, 512);
  const queryTerms = terms(query);
  const phrase = query.toLocaleLowerCase();
  const limit = Math.max(1, Math.min(4, Math.floor(input.limit ?? 4)));
  return Object.freeze(
    input.entries
      .filter(
        (
          entry,
        ): entry is SearchableProviderEntry & {
          readonly status: Exclude<McpProviderDirectoryEntry['status'], 'ready'>;
        } => isMcpProviderUnavailable(entry.status),
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
      .map(({ entry }) =>
        Object.freeze({
          providerId: safeCapabilityMetadata(entry.providerId),
          status: entry.status,
          nextAction: mcpProviderSearchNextAction(entry.status),
          ...(entry.diagnosticCode ? { diagnosticCode: entry.diagnosticCode } : {}),
        }),
      ),
  );
}

function terms(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1)
    .slice(0, 32);
}
