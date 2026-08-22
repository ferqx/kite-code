import {
  type BuiltinCapabilityTurnContextV1,
  createBuiltinCapabilityTurnContextV1,
  type SkillCatalogSnapshot,
} from '@kite/builtin-runtime';
import type { CapabilityTurnContextV1 } from '@kite/runtime-spi';
import { getFeatureFlags } from '#app/config/features';
import type { AgentConfig } from '#app/config/index';

export interface AppToolTurnContextInputV1 {
  readonly workspace: string;
  readonly config?: AgentConfig;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly activeTaskId?: string;
  readonly modelMessageId?: string;
  readonly toolCallId?: string;
  readonly phase?: CapabilityTurnContextV1['phase'];
  readonly interactionMode?: import('@kite/runtime-contract').InteractionMode;
  readonly workspaceTrust?: CapabilityTurnContextV1['workspaceTrust'];
  readonly hasTaskAdapter?: boolean;
  readonly hasGitBroker?: boolean;
  readonly toolSearchEnabled?: boolean;
  readonly activeSkillFrames?: readonly { readonly activationId: string }[];
  readonly skillCatalog?: SkillCatalogSnapshot;
}

export type AppToolTurnContextV1 = BuiltinCapabilityTurnContextV1 & {
  readonly interactionMode?: import('@kite/runtime-contract').InteractionMode;
};

/** App projects ambient configuration into immutable Builtin turn facts once. */
export function createAppToolTurnContextV1(input: AppToolTurnContextInputV1): AppToolTurnContextV1 {
  const featureFlags = input.config ? getFeatureFlags(input.config) : undefined;
  const context = createBuiltinCapabilityTurnContextV1({
    workspace: input.workspace,
    threadId: input.threadId,
    turnId: input.turnId,
    taskId: input.taskId,
    activeTaskId: input.activeTaskId,
    modelMessageId: input.modelMessageId,
    toolCallId: input.toolCallId,
    phase: input.phase,
    workspaceTrust: input.workspaceTrust,
    featureFlags,
    brokeredGitFeatureRevision:
      input.config?.executionCapabilitySurface?.brokeredGitFeatureRevision ?? null,
    hasTaskAdapter: input.hasTaskAdapter,
    hasGitBroker: input.hasGitBroker,
    toolSearchEnabled: input.toolSearchEnabled,
    activeSkillFrames: input.activeSkillFrames,
    skillCatalog: input.skillCatalog,
  });
  return Object.freeze({
    ...context,
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
  });
}
