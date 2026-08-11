import { createBinding } from '@/core/capabilities/catalog';
import {
  chooseCapabilityDisclosure,
  searchableCapabilitySnapshot,
} from '@/core/capabilities/search';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import { exposedMcpToolName, type McpRuntimeProvider } from '@/core/mcp';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { RuntimeState } from '@/core/runtime/state';
import { skillFrameInvalidationReason } from '@/core/skills/activation';
import type { SkillCatalogSnapshot } from '@/core/skills/catalog';
import type { CapabilityBinding, CapabilityDescriptor } from '@/protocol/capabilities';
import type { ResolvedModelCapabilities } from './model-capabilities';

export interface PreparedContextCapabilitySetV2 {
  readonly mcpBindings: readonly {
    readonly binding: CapabilityBinding;
    readonly descriptor: CapabilityDescriptor;
  }[];
  readonly disclosedDescriptors: readonly CapabilityDescriptor[];
}

/** Pure capability preparation; callers persist events and rerun before context prepare. */
export function prepareContextCapabilitySetV2(input: {
  state: Readonly<RuntimeState>;
  config: AgentConfig;
  modelSupportsToolCalls: boolean;
  modelCapabilities: ResolvedModelCapabilities;
  mcpManager?: McpRuntimeProvider;
  skillCatalog?: SkillCatalogSnapshot;
  now?: Date;
}): {
  preparationEvents: RuntimeEvent[];
  capabilitySet: PreparedContextCapabilitySetV2;
} {
  const flags = getFeatureFlags(input.config);
  const preparationEvents: RuntimeEvent[] = [];
  if (input.skillCatalog && input.state.skills.catalogRevision !== input.skillCatalog.revision) {
    preparationEvents.push({
      type: 'skill.catalog_refreshed',
      catalogRevision: input.skillCatalog.revision,
    });
  }
  if (input.skillCatalog) {
    for (const frame of Object.values(input.state.skills.frames)) {
      if (frame.status !== 'active') continue;
      const reason = skillFrameInvalidationReason(frame, input.skillCatalog);
      if (reason) {
        preparationEvents.push({
          type: 'skill.frame_closed',
          activationId: frame.activationId,
          status: 'invalidated',
          reason,
          closedAt: (input.now ?? new Date()).toISOString(),
        });
      }
    }
  }

  const snapshot = searchableCapabilitySnapshot({
    mcp: input.mcpManager?.getCapabilitySnapshot(),
    skills: input.skillCatalog?.capabilities,
  });
  const disclosure = chooseCapabilityDisclosure({
    featureEnabled: flags.toolSearchV1,
    providerSupportsToolCalls: input.modelSupportsToolCalls,
    descriptors: snapshot.descriptors,
    contextWindowTokens: input.modelCapabilities.contextWindowTokens,
    budgetTokens:
      typeof input.config.modelKwargs?.capabilityDisclosureBudgetTokens === 'number' &&
      input.config.modelKwargs.capabilityDisclosureBudgetTokens > 0
        ? Math.floor(input.config.modelKwargs.capabilityDisclosureBudgetTokens)
        : undefined,
  });
  const pendingSearch = input.state.capabilities.pendingSearch;
  const currentSearch =
    pendingSearch?.requestedAtTurnId === input.state.turn.turnId &&
    pendingSearch.catalogRevision === snapshot.revision
      ? pendingSearch
      : undefined;
  const searchedDescriptors =
    flags.toolSearchV1 && currentSearch
      ? currentSearch.candidates.flatMap((candidate) => {
          const descriptor = snapshot.descriptors.find(
            (item) =>
              item.capabilityId === candidate.capabilityId &&
              item.revision === candidate.capabilityRevision,
          );
          return descriptor ? [descriptor] : [];
        })
      : [];
  const loadedMcpDescriptors = Object.values(
    input.state.capabilities.loadedCapabilities ?? {},
  ).flatMap((loaded) => {
    const descriptor = snapshot.descriptors.find(
      (item) =>
        item.kind === 'mcp_tool' &&
        item.capabilityId === loaded.capabilityId &&
        item.revision === loaded.capabilityRevision,
    );
    return descriptor ? [descriptor] : [];
  });
  const searchedMcpDescriptors = searchedDescriptors.filter(
    (descriptor) => descriptor.kind === 'mcp_tool',
  );
  const disclosedMcpDescriptors = (
    flags.toolSearchV1
      ? disclosure.mode === 'all'
        ? snapshot.descriptors.filter((descriptor) => descriptor.kind === 'mcp_tool')
        : [...loadedMcpDescriptors, ...searchedMcpDescriptors]
      : snapshot.descriptors.filter((descriptor) => descriptor.kind === 'mcp_tool')
  ).filter(
    (descriptor, index, all) =>
      all.findIndex((candidate) => candidate.capabilityId === descriptor.capabilityId) === index,
  );
  const effectiveSkillMode = disclosure.skillMode ?? disclosure.mode;
  const disclosedSkillDescriptors =
    effectiveSkillMode === 'all'
      ? snapshot.descriptors.filter((descriptor) => descriptor.kind === 'skill')
      : effectiveSkillMode === 'search'
        ? searchedDescriptors.filter((descriptor) => descriptor.kind === 'skill')
        : [];
  const disclosedDescriptors = [...disclosedMcpDescriptors, ...disclosedSkillDescriptors];
  const loadedCapabilities = flags.toolSearchV1
    ? disclosedMcpDescriptors.map((descriptor) => {
        const existing = input.state.capabilities.loadedCapabilities?.[descriptor.capabilityId];
        return {
          capabilityId: descriptor.capabilityId,
          capabilityRevision: descriptor.revision,
          firstLoadedAtTurnId: existing?.firstLoadedAtTurnId ?? input.state.turn.turnId,
        };
      })
    : [];
  const mcpBindings =
    flags.capabilityCatalogV1 && flags.mcpRuntimeBindingV1
      ? disclosedDescriptors
          .filter(
            (descriptor) =>
              descriptor.kind === 'mcp_tool' && descriptor.availability === 'available',
          )
          .map((descriptor) => ({
            descriptor,
            binding: createBinding({
              descriptor,
              exposedToolName: exposedMcpToolName(descriptor.provider.id, descriptor.displayName),
              turnId: input.state.turn.turnId,
            }),
          }))
      : [];
  const disclosures = flags.toolSearchV1
    ? disclosedDescriptors.map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        capabilityRevision: descriptor.revision,
        issuedForTurnId: input.state.turn.turnId,
      }))
    : [];
  const bindingChanged =
    mcpBindings.length !== Object.keys(input.state.capabilities.bindings).length ||
    mcpBindings.some(
      ({ binding }) =>
        input.state.capabilities.bindings[binding.bindingId]?.schemaDigest !== binding.schemaDigest,
    );
  const disclosureChanged =
    disclosures.length !== Object.keys(input.state.capabilities.disclosures).length ||
    disclosures.some(
      (candidate) =>
        input.state.capabilities.disclosures[candidate.capabilityId]?.capabilityRevision !==
        candidate.capabilityRevision,
    );
  const loadedChanged =
    loadedCapabilities.length !== Object.keys(input.state.capabilities.loadedCapabilities).length ||
    loadedCapabilities.some(
      (candidate) =>
        input.state.capabilities.loadedCapabilities[candidate.capabilityId]?.capabilityRevision !==
        candidate.capabilityRevision,
    );
  if (
    bindingChanged ||
    disclosureChanged ||
    loadedChanged ||
    pendingSearch ||
    input.state.capabilities.catalogRevision !== snapshot.revision
  ) {
    preparationEvents.push({
      type: 'capability.bindings_issued',
      catalogRevision: snapshot.revision,
      bindings: mcpBindings.map(({ binding }) => binding),
      disclosures,
      loadedCapabilities,
      ...(pendingSearch ? { searchId: pendingSearch.searchId } : {}),
    });
  }
  return {
    preparationEvents,
    capabilitySet: Object.freeze({
      mcpBindings: Object.freeze(structuredClone(mcpBindings)),
      disclosedDescriptors: Object.freeze(structuredClone(disclosedDescriptors)),
    }),
  };
}
