import {
  type BuiltinModelToolSet,
  type BuiltinToolCatalogProjection,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import type { SupportedChatModel } from '@kite-ai/builtin-runtime/model';
import type { ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type { SkillCatalogSnapshot } from '@kite-ai/builtin-runtime/skills';
import { createBuiltinModelToolSurfaceFromProjection } from '@kite-ai/builtin-runtime/subagent';
import type {
  CapabilityBinding,
  CapabilityDescriptor,
  SubAgentEventSink,
} from '@kite-ai/runtime-contract';
import { type CapabilityTurnContext, createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import {
  type AppToolTurnContext,
  createAppToolTurnContext,
} from '#kite-cli/bootstrap/runtime/tool-turn-context';
import type { AgentConfig } from '#kite-cli/config/index';

export interface CreateAgentToolsInput {
  workspace: string;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
  mcpManager?: import('@kite-ai/builtin-runtime/mcp').McpRuntimeProvider;
  mcpBindings?: Array<{ binding: CapabilityBinding; descriptor: CapabilityDescriptor }>;
  toolSearch?: boolean;
  skills?: import('@kite-ai/builtin-runtime/skills').SkillManifest[];
  skillOptions?: import('@kite-ai/builtin-runtime/skills').SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  activeSkillFrames?: Array<{ activationId: string }>;
  config?: AgentConfig;
  subagentEventSink?: SubAgentEventSink;
  model?: SupportedChatModel;
  threadId?: string;
  workspaceAccess?: import('@kite-ai/runtime-contract').WorkspaceAccess;
  phase?: import('@kite-ai/runtime-contract').AgentPhase;
  interactionMode?: import('@kite-ai/runtime-contract').InteractionMode;
  turnId?: string;
  taskId?: string;
  activeTaskId?: string;
  modelMessageId?: string;
  toolCallId?: string;
  workspaceTrust?: CapabilityTurnContext['workspaceTrust'];
}

export type ToolAvailabilityContext = AppToolTurnContext;

export function toolAvailabilityContext(input: CreateAgentToolsInput): ToolAvailabilityContext {
  return createAppToolTurnContext({
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

export function builtinCapabilityTurnContext(
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

export function createAgentToolsFromBuiltinProjection(
  input: CreateAgentToolsInput,
  projection: BuiltinToolCatalogProjection,
): BuiltinModelToolSet {
  const turnContext = builtinCapabilityTurnContext(input);
  return createBuiltinModelToolSurfaceFromProjection({
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

const TEST_RUNTIME_REGISTRY_SNAPSHOT_ = createRuntimeModuleRegistry(
  createBuiltinRuntimeModules(),
).snapshot();
const TEST_BUILTIN_TOOL_CATALOG_ = createBuiltinToolCatalogProjection(
  TEST_RUNTIME_REGISTRY_SNAPSHOT_,
);

export function projectTestAgentTools(
  input: CreateAgentToolsInput,
  context: ToolAvailabilityContext = toolAvailabilityContext(input),
) {
  const projection = TEST_BUILTIN_TOOL_CATALOG_.forTurn(
    builtinCapabilityTurnContext(input, context),
  );
  return Object.freeze({
    projection,
    tools: createAgentToolsFromBuiltinProjection(input, projection),
  });
}

export function createTestAgentTools(
  input: CreateAgentToolsInput,
  context: ToolAvailabilityContext = toolAvailabilityContext(input),
) {
  return projectTestAgentTools(input, context).tools;
}
