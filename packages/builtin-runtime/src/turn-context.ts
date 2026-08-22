import type { CapabilityTurnContextV1 } from '@kite/runtime-spi';
import type { SkillCatalogSnapshot } from './skills/catalog';

export interface BuiltinCapabilityTurnContextInputV1 {
  readonly workspace: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly activeTaskId?: string;
  readonly modelMessageId?: string;
  readonly toolCallId?: string;
  readonly phase?: CapabilityTurnContextV1['phase'];
  readonly workspaceTrust?: CapabilityTurnContextV1['workspaceTrust'];
  readonly featureFlags?: CapabilityTurnContextV1['featureFlags'];
  readonly brokeredGitFeatureRevision?: string | null;
  readonly hasTaskAdapter?: boolean;
  readonly hasGitBroker?: boolean;
  readonly toolSearchEnabled?: boolean;
  readonly activeSkillFrames?: readonly { readonly activationId: string }[];
  readonly activeSkillFrameIds?: readonly string[];
  readonly skillCatalog?: SkillCatalogSnapshot;
  readonly availableSkillIds?: readonly string[];
}

export type BuiltinCapabilityTurnContextV1 = CapabilityTurnContextV1 & {
  readonly workspace: string;
};

/** Build the immutable facts consumed by one frozen Builtin registry turn projection. */
export function createBuiltinCapabilityTurnContextV1(
  input: BuiltinCapabilityTurnContextInputV1,
): BuiltinCapabilityTurnContextV1 {
  const featureFlags = input.featureFlags ? Object.freeze({ ...input.featureFlags }) : undefined;
  return Object.freeze({
    workspace: input.workspace,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.activeTaskId ? { activeTaskId: input.activeTaskId } : {}),
    ...(input.modelMessageId ? { modelMessageId: input.modelMessageId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    promptContractV2: input.featureFlags?.promptContractV2 === true,
    brokeredGitFeatureRevision: input.brokeredGitFeatureRevision ?? null,
    hasTaskAdapter: input.hasTaskAdapter === true,
    hasGitBroker: input.hasGitBroker === true,
    toolSearchEnabled: input.toolSearchEnabled === true,
    activeSkillFrameIds: Object.freeze(
      [
        ...(input.activeSkillFrameIds ??
          (input.activeSkillFrames ?? []).map((frame) => frame.activationId)),
      ].sort(),
    ),
    availableSkillIds: Object.freeze(
      [
        ...(input.availableSkillIds ??
          (input.skillCatalog?.capabilities.descriptors ?? [])
            .filter(
              (descriptor) =>
                descriptor.kind === 'skill' && descriptor.availability === 'available',
            )
            .map((descriptor) => descriptor.capabilityId)),
      ].sort(),
    ),
    ...(input.workspaceTrust ? { workspaceTrust: input.workspaceTrust } : {}),
    ...(featureFlags ? { featureFlags } : {}),
  });
}
