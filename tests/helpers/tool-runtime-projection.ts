import {
  type BuiltinModelToolSetV1,
  type BuiltinToolCatalogProjectionV1,
  createBuiltinModelToolSurfaceFromProjectionV1,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjectionV1,
  type SkillCatalogSnapshot,
} from '@kite/builtin-runtime';
import type { SupportedChatModel } from '@kite/builtin-runtime/model';
import type { ShellExecutor } from '@kite/builtin-runtime/sandbox';
import type {
  CapabilityBinding,
  CapabilityDescriptor,
  SubAgentEventSink,
} from '@kite/runtime-contract';
import { type CapabilityTurnContextV1, createRuntimeModuleRegistryV1 } from '@kite/runtime-spi';
import {
  type AppToolTurnContextV1,
  createAppToolTurnContextV1,
} from '#app/bootstrap/runtime/tool-turn-context';
import type { AgentConfig } from '#app/config/index';

export interface CreateAgentToolsInput {
  workspace: string;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite/builtin-runtime/git').GitBrokerV1;
  mcpManager?: import('@kite/builtin-runtime/mcp').McpRuntimeProvider;
  mcpBindings?: Array<{ binding: CapabilityBinding; descriptor: CapabilityDescriptor }>;
  toolSearch?: boolean;
  skills?: import('@kite/builtin-runtime').SkillManifest[];
  skillOptions?: import('@kite/builtin-runtime').SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  activeSkillFrames?: Array<{ activationId: string }>;
  config?: AgentConfig;
  subagentEventSink?: SubAgentEventSink;
  model?: SupportedChatModel;
  threadId?: string;
  authorization?: import('@kite/runtime-host').State25AuthorizationStateV1;
  workspaceAccess?: import('@kite/runtime-contract').WorkspaceAccess;
  phase?: import('@kite/runtime-contract').AgentPhase;
  interactionMode?: import('@kite/runtime-contract').InteractionMode;
  turnId?: string;
  taskId?: string;
  activeTaskId?: string;
  modelMessageId?: string;
  toolCallId?: string;
  workspaceTrust?: CapabilityTurnContextV1['workspaceTrust'];
}

export type ToolAvailabilityContext = AppToolTurnContextV1;

export function toolAvailabilityContext(input: CreateAgentToolsInput): ToolAvailabilityContext {
  return createAppToolTurnContextV1({
    workspace: input.workspace,
    config: input.config,
    threadId: input.threadId,
    turnId: input.turnId,
    taskId: input.taskId,
    activeTaskId: input.activeTaskId,
    modelMessageId: input.modelMessageId,
    toolCallId: input.toolCallId,
    phase: input.phase,
    interactionMode: input.interactionMode,
    workspaceTrust: input.workspaceTrust,
    hasTaskAdapter: Boolean(input.subagentEventSink && input.config),
    hasGitBroker: Boolean(input.gitBroker),
    toolSearchEnabled: input.toolSearch,
    activeSkillFrames: input.activeSkillFrames,
    skillCatalog: input.skillCatalog,
  });
}

export function builtinCapabilityTurnContextV1(
  input: CreateAgentToolsInput,
  context: ToolAvailabilityContext = toolAvailabilityContext(input),
): ToolAvailabilityContext {
  return Object.freeze({
    ...context,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.activeTaskId ? { activeTaskId: input.activeTaskId } : {}),
    ...(input.modelMessageId ? { modelMessageId: input.modelMessageId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  });
}

export function createAgentToolsFromBuiltinProjectionV1(
  input: CreateAgentToolsInput,
  projection: BuiltinToolCatalogProjectionV1,
): BuiltinModelToolSetV1 {
  const turnContext = builtinCapabilityTurnContextV1(input);
  return createBuiltinModelToolSurfaceFromProjectionV1({
    projection,
    turnContext,
    ...(input.config?.executionCapabilitySurface
      ? { executionCapabilitySurface: input.config.executionCapabilitySurface }
      : {}),
    canSpawnSubagents: true,
    exposeInterrupts: true,
    ...(input.mcpBindings ? { dynamicMcpBindings: input.mcpBindings } : {}),
  }).tools;
}

const TEST_RUNTIME_REGISTRY_SNAPSHOT_V1 = createRuntimeModuleRegistryV1(
  createBuiltinRuntimeModules(),
).snapshot();
const TEST_BUILTIN_TOOL_CATALOG_V1 = createBuiltinToolCatalogProjectionV1(
  TEST_RUNTIME_REGISTRY_SNAPSHOT_V1,
);

export function projectTestAgentToolsV1(
  input: CreateAgentToolsInput,
  context: ToolAvailabilityContext = toolAvailabilityContext(input),
) {
  const projection = TEST_BUILTIN_TOOL_CATALOG_V1.forTurn(
    builtinCapabilityTurnContextV1(input, context),
  );
  return Object.freeze({
    projection,
    tools: createAgentToolsFromBuiltinProjectionV1(input, projection),
  });
}

export function createTestAgentToolsV1(
  input: CreateAgentToolsInput,
  context: ToolAvailabilityContext = toolAvailabilityContext(input),
) {
  return projectTestAgentToolsV1(input, context).tools;
}
