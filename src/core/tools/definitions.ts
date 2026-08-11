import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { modelVisibleCapabilitySchema } from '@/core/capabilities/search';
import { getFeatureFlags } from '@/core/config/features';
import type { SupportedChatModel } from '@/core/model/factory';
import { isDescriptorAdmittedByExecutionCapabilitySurfaceV1 } from '@/core/sandbox/execution-capability-surface';
import type { SkillCatalogSnapshot } from '@/core/skills/catalog';
import type { CapabilityBinding, CapabilityDescriptor } from '@/protocol/capabilities';
import { builtinToolRegistry } from './registry/builtins';
import type { ToolAvailabilityContext } from './registry/spec';
import type { ShellExecutor } from './shell';

/** 创建 Agent 工具集输入 / Input for creating agent tools */
export interface CreateAgentToolsInput {
  /** 工作目录 / Workspace directory */
  workspace: string;
  /** 可选 Shell 执行器 / Optional shell executor */
  shellExecutor?: ShellExecutor;
  /** App-composed typed Git broker. */
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  /** 可选 MCP Runtime provider / Optional MCP Runtime provider */
  mcpManager?: import('@/core/mcp').McpRuntimeProvider;
  /** Runtime-issued MCP tool bindings for the current model call. */
  mcpBindings?: Array<{ binding: CapabilityBinding; descriptor: CapabilityDescriptor }>;
  /** Expose provider-neutral metadata discovery instead of the full catalog. */
  toolSearch?: boolean;
  /** 可选技能清单 / Optional skill manifests */
  skills?: import('@/core/skills/types').SkillManifest[];
  /** 可选技能扫描选项 / Optional skill scan options */
  skillOptions?: import('@/core/skills/types').SkillScanOptions;
  /** Compiled Workflow Contract catalog for this model request. */
  skillCatalog?: SkillCatalogSnapshot;
  activeSkillFrames?: Array<{ activationId: string }>;
  /** Agent 配置（task 工具创建模型实例时需要） */
  config?: import('@/core/config/index').AgentConfig;
  /** 子 agent 事件回调（用于 task 工具） */
  subagentEventSink?: import('@/core/subagent/types').SubAgentEventSink;
  /** 外部中止信号（用于 task 工具） */
  subagentSignal?: AbortSignal;
  /** 中止信号，传递给 shell 执行器以 kill 子进程 / Abort signal passed to shell executor to kill child processes */
  signal?: AbortSignal;
  /** 可选自定义模型实例（用于 E2E mock 注入）/ Optional custom model instance (for E2E mock injection) */
  model?: SupportedChatModel;
  /** 最大允许子 agent 嵌套深度（0 = 不允许再派生）/ Max sub-agent nesting depth (0 = no further nesting) */
  maxDepth?: number;
  /** 线程 ID，用于多 session 缓存隔离 / Thread ID for multi-session cache isolation */
  threadId?: string;
  authorization?: import('@/core/types').ThreadAuthorizationState;
  workspaceAccess?: import('@/protocol/events').WorkspaceAccess;
  phase?: import('@/protocol/events').AgentPhase;
  interactionMode?: import('@/protocol/events').InteractionMode;
}

/** 兼容旧调用；工具表投影成本很低，现阶段不缓存，避免跨 session 无界增长和陈旧 feature flag。 */
export function clearToolCache(): void {
  // Intentionally empty.
}

export function toolAvailabilityContext(input: CreateAgentToolsInput): ToolAvailabilityContext {
  const featureFlags = input.config ? getFeatureFlags(input.config) : undefined;
  return Object.freeze({
    workspace: input.workspace,
    threadId: input.threadId,
    phase: input.phase,
    interactionMode: input.interactionMode,
    featureFlags,
    brokeredGitFeatureRevision:
      input.config?.executionCapabilitySurface?.brokeredGitFeatureRevision ?? null,
    hasTaskAdapter: Boolean(input.subagentEventSink && input.config),
    hasGitBroker: Boolean(input.gitBroker),
    toolSearchEnabled: input.toolSearch === true,
    activeSkillFrameIds: Object.freeze(
      (input.activeSkillFrames ?? []).map((frame) => frame.activationId).sort(),
    ),
    availableSkillIds: Object.freeze(
      (input.skillCatalog?.capabilities.descriptors ?? [])
        .filter(
          (descriptor) => descriptor.kind === 'skill' && descriptor.availability === 'available',
        )
        .map((descriptor) => descriptor.capabilityId)
        .sort(),
    ),
  });
}

/** 创建 Agent 工具集（跨工作区访问权限保持 schema 稳定，由工具执行层强制边界） */
export function createAgentTools(
  input: CreateAgentToolsInput,
  context?: ToolAvailabilityContext,
): ToolSet {
  const ctx = context ?? toolAvailabilityContext(input);
  let builtinTools = builtinToolRegistry.toSchemaOnlyToolSet(ctx) as ToolSet;
  const executionSurface = input.config?.executionCapabilitySurface;
  if (executionSurface) {
    builtinTools = Object.fromEntries(
      Object.entries(builtinTools).filter(([name]) => {
        const spec = builtinToolRegistry.get(name);
        if (!spec) return false;
        return isDescriptorAdmittedByExecutionCapabilitySurfaceV1({
          surface: executionSurface,
          descriptor: builtinToolRegistry.descriptorOf(spec),
        });
      }),
    );
  }

  const mcpTools: ToolSet = {};
  for (const { binding, descriptor } of input.mcpBindings ?? []) {
    if (descriptor.kind !== 'mcp_tool' || descriptor.availability !== 'available') continue;
    if (!descriptor.inputSchema) continue;
    if (
      ctx.featureFlags?.promptContractV2 &&
      ctx.phase === 'planning' &&
      Object.values(descriptor.effectiveEffects).some(
        (effect) => effect !== 'none' && effect !== 'read',
      )
    ) {
      continue;
    }
    if (
      executionSurface &&
      !isDescriptorAdmittedByExecutionCapabilitySurfaceV1({
        surface: executionSurface,
        descriptor,
      })
    ) {
      continue;
    }
    // AI SDK's JSONSchema7 type is narrower than MCP's runtime schema. The
    // binding was validated by compileCapabilitySchema before it reaches here.
    const inputSchema = jsonSchema(
      modelVisibleCapabilitySchema(descriptor.inputSchema) as Parameters<typeof jsonSchema>[0],
    );
    mcpTools[binding.exposedToolName] = dynamicTool({
      description: ctx.featureFlags?.promptContractV2
        ? (descriptor.modelDescription ?? `MCP capability ${descriptor.displayName}.`)
        : 'Runtime-bound MCP capability. The Runtime validates its current revision, arguments, policy, approval, execution receipt, and verification before use.',
      inputSchema,
    });
  }
  const tools = { ...builtinTools, ...mcpTools };
  return tools;
}

/** 兼容旧名称：创建代码 Agent 工具集 / Backward-compatible alias for agent tools */
export function createCodeAgentTools(input: CreateAgentToolsInput) {
  return createAgentTools(input);
}

/** 兼容旧名称：创建计划 Agent 工具集 / Backward-compatible alias for agent tools */
export function createPlanAgentTools(input: CreateAgentToolsInput) {
  return createAgentTools(input);
}

export {
  isReadOnlyShellCommand,
  isReadOnlyShellCommand as isPlanReadOnlyShellCommand,
} from '@/core/policies/shell-classification';
