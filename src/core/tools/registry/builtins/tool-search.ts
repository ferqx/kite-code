import { z } from 'zod';
import { digestCapability } from '@/core/capabilities/catalog';
import { isProviderHealthy, isProviderUnavailable } from '@/core/capabilities/provider-status';
import {
  checkInventoryRedirect,
  publicProviderSearchMetadata,
  publicSearchMetadata,
  searchableCapabilitySnapshot,
  searchCapabilities,
  searchUnavailableProviders,
} from '@/core/capabilities/search';
import type { RuntimeEvent } from '@/core/runtime/events';
import { TOOL_SEARCH_CONTRACT } from '@/core/tools/tool-contracts';
import type { ToolSpec } from '../spec';

export const toolSearchInputSchema = z.object({
  query: z.string().trim().min(2).max(512).describe('Capability intent to search for'),
  limit: z.number().int().min(1).max(12).optional().describe('Maximum candidates'),
});

type ToolSearchInput = z.infer<typeof toolSearchInputSchema>;
type ToolSearchOutput = {
  ok: boolean;
  stdout: string;
  stderr: string;
  runtimeEvents?: RuntimeEvent[];
};

export const toolSearchSpec: ToolSpec<ToolSearchInput, ToolSearchOutput> = {
  name: 'tool_search',
  kind: 'coordination',
  contract: TOOL_SEARCH_CONTRACT.sections,
  inputSchema: toolSearchInputSchema,
  declaredEffects: { filesystem: 'none', network: 'read', externalState: 'none' },
  minimumApproval: 'none',
  availability: (context) => context.toolSearchEnabled === true,
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'Searches governed capability metadata without issuing a binding.',
  }),
  execute: async (input, context) => {
    const searchContext = context.toolSearch;
    if (!searchContext?.enabled) {
      return {
        ok: false,
        stdout: '',
        stderr: 'Capability search is disabled by feature flag.',
      };
    }
    const redirect = checkInventoryRedirect(input.query);
    if (redirect) {
      return { ok: true, stdout: JSON.stringify(redirect), stderr: '' };
    }

    let snapshot = searchableCapabilitySnapshot({
      mcp: searchContext.mcpManager?.getCapabilitySnapshot(),
      skills: searchContext.skillCatalog?.capabilities,
    });
    let providerDirectory = searchContext.mcpManager?.getProviderDirectorySnapshot();
    let candidates = searchCapabilities({ snapshot, query: input.query, limit: input.limit });
    let providers = searchUnavailableProviders({
      directory: providerDirectory,
      query: input.query,
      limit: input.limit,
    });
    const connecting = providers.filter((provider) => provider.status === 'connecting');
    if (
      candidates.length === 0 &&
      connecting.length > 0 &&
      searchContext.mcpManager?.ensureProviderReady
    ) {
      await Promise.all(
        connecting.map(async (provider) => {
          try {
            await searchContext.mcpManager!.ensureProviderReady!(
              provider.providerId,
              5_000,
              context.signal,
            );
          } catch (error) {
            if (context.signal?.aborted) throw context.signal.reason ?? error;
          }
        }),
      );
      snapshot = searchableCapabilitySnapshot({
        mcp: searchContext.mcpManager.getCapabilitySnapshot(),
        skills: searchContext.skillCatalog?.capabilities,
      });
      providerDirectory = searchContext.mcpManager.getProviderDirectorySnapshot();
      candidates = searchCapabilities({ snapshot, query: input.query, limit: input.limit });
      providers = searchUnavailableProviders({
        directory: providerDirectory,
        query: input.query,
        limit: input.limit,
      });
    }

    const searchId = digestCapability({
      threadId: context.threadId,
      turnId: searchContext.turnId,
      toolCallId: searchContext.toolCallId,
      query: input.query,
      catalogRevision: snapshot.revision,
    });
    const displayedCandidates = publicSearchMetadata(candidates);
    const providerDirectoryAfter = searchContext.mcpManager?.getProviderDirectorySnapshot();
    const showSummary = candidates.length === 0;
    const catalogMessage =
      providers.length > 0
        ? 'No executable capabilities matched. Matching providers are currently unavailable; the overall catalog may still contain other tools.'
        : 'No capabilities matched this query. This does not mean the capability catalog is empty.';
    const runtimeEvent: RuntimeEvent = {
      type: 'capability.search_completed',
      result: {
        searchId,
        query: input.query,
        catalogRevision: snapshot.revision,
        requestedAtTurnId: searchContext.turnId,
        candidates,
        ...(providers.length > 0 ? { providers } : {}),
      },
    };
    return {
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        search_id: searchId,
        candidate_count: displayedCandidates.length,
        candidates: displayedCandidates,
        executable_candidate_count: candidates.length,
        provider_count: providers.length,
        providers: publicProviderSearchMetadata(providers),
        ...(showSummary
          ? {
              catalog_summary: {
                available_mcp_tool_count:
                  searchContext.mcpManager
                    ?.getCapabilitySnapshot()
                    .descriptors.filter(
                      (descriptor) =>
                        descriptor.kind === 'mcp_tool' && descriptor.availability === 'available',
                    ).length ?? 0,
                available_skill_count:
                  searchContext.skillCatalog?.capabilities.descriptors.filter(
                    (descriptor) =>
                      descriptor.kind === 'skill' && descriptor.availability === 'available',
                  ).length ?? 0,
                configured_provider_count: providerDirectoryAfter?.entries.length ?? 0,
                unavailable_provider_count:
                  providerDirectoryAfter?.entries.filter((entry) =>
                    isProviderUnavailable(entry.status),
                  ).length ?? 0,
                ...(providerDirectoryAfter &&
                providerDirectoryAfter.entries.some((entry) => !isProviderHealthy(entry.status))
                  ? {
                      non_healthy_provider_count: providerDirectoryAfter.entries.filter(
                        (entry) => !isProviderHealthy(entry.status),
                      ).length,
                    }
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
      stderr: '',
      runtimeEvents: [runtimeEvent],
    };
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? output.stdout : output.stderr,
    resultMeta: {},
    display: { verb: 'Search', preview: 'capabilities' },
    runtimeEvents: output.runtimeEvents,
  }),
};
