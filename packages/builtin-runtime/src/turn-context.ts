import type { CapabilityTurnContext } from '@kite/runtime-spi';
import type { SkillCatalogSnapshot } from './skills/catalog';

export interface BuiltinCapabilityTurnContextInput {
  readonly workspace: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly activeTaskId?: string;
  readonly modelMessageId?: string;
  readonly toolCallId?: string;
  readonly phase?: CapabilityTurnContext['phase'];
  readonly workspaceTrust?: CapabilityTurnContext['workspaceTrust'];
  readonly featureFlags?: CapabilityTurnContext['featureFlags'];
  readonly brokeredGitFeatureRevision?: string | null;
  readonly hasTaskAdapter?: boolean;
  readonly hasGitBroker?: boolean;
  readonly toolSearchEnabled?: boolean;
  readonly activeSkillFrames?: readonly { readonly activationId: string }[];
  readonly activeSkillFrameIds?: readonly string[];
  readonly skillCatalog?: SkillCatalogSnapshot;
  readonly availableSkillIds?: readonly string[];
}

export type BuiltinCapabilityTurnContext = CapabilityTurnContext & {
  readonly workspace: string;
};

/** Build the immutable facts consumed by one frozen Builtin registry turn projection. */
export function createBuiltinCapabilityTurnContext(
  input: BuiltinCapabilityTurnContextInput,
): BuiltinCapabilityTurnContext {
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
    promptContract: input.featureFlags?.promptContract === true,
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
