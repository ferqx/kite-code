import {
  type BuiltinCapabilityTurnContext,
  createBuiltinCapabilityTurnContext,
} from '@kite-ai/builtin-runtime';
import type { SkillCatalogSnapshot } from '@kite-ai/builtin-runtime/skills';
import type { CapabilityTurnContext } from '@kite-ai/runtime-spi';
import { getFeatureFlags } from '#kite-service/config/features';
import type { AgentConfig } from '#kite-service/config/index';

export interface AppToolTurnContextInput {
  readonly workspace: string;
  readonly config?: AgentConfig;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly taskId?: string;
  readonly activeTaskId?: string;
  readonly modelMessageId?: string;
  readonly toolCallId?: string;
  readonly phase?: CapabilityTurnContext['phase'];
  readonly interactionMode?: import('@kite-ai/runtime-contract').InteractionMode;
  readonly workspaceTrust?: CapabilityTurnContext['workspaceTrust'];
  readonly hasTaskAdapter?: boolean;
  readonly hasGitBroker?: boolean;
  readonly toolSearchEnabled?: boolean;
  readonly activeSkillFrames?: readonly { readonly activationId: string }[];
  readonly skillCatalog?: SkillCatalogSnapshot;
}

export type AppToolTurnContext = BuiltinCapabilityTurnContext & {
  readonly interactionMode?: import('@kite-ai/runtime-contract').InteractionMode;
};

/** App projects ambient configuration into immutable Builtin turn facts once. */
export function createAppToolTurnContext(input: AppToolTurnContextInput): AppToolTurnContext {
  const featureFlags = input.config ? getFeatureFlags(input.config) : undefined;
  const context = createBuiltinCapabilityTurnContext({
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
