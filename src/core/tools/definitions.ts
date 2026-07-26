import { dynamicTool, jsonSchema, type ToolSet, tool, zodSchema } from 'ai';
import { modelVisibleCapabilitySchema } from '@/core/capabilities/search';
import { getFeatureFlags } from '@/core/config/features';
import type { SupportedChatModel } from '@/core/model/factory';
import type { SkillCatalogSnapshot } from '@/core/skills/catalog';
import type { CapabilityBinding, CapabilityDescriptor } from '@/protocol/capabilities';
import { askUserSpec } from './registry/builtins/ask-user';
import { editFileSpec } from './registry/builtins/edit-file';
import {
  listMcpResourcesSpec,
  listMcpToolsSpec,
  readMcpResourceSpec,
} from './registry/builtins/mcp-inventory';
import { readFileSpec } from './registry/builtins/read-file';
import { readPlanSpec } from './registry/builtins/read-plan';
import { searchContentSpec } from './registry/builtins/search-content';
import { searchFilesSpec } from './registry/builtins/search-files';
import { shellExecuteSpec } from './registry/builtins/shell-execute';
import {
  activateSkillSpec,
  completeSkillSpec,
  readSkillReferenceSpec,
} from './registry/builtins/skill-runtime';
import { taskSpec } from './registry/builtins/task';
import { toolSearchSpec } from './registry/builtins/tool-search';
import { updatePlanSpec } from './registry/builtins/update-plan';
import { webFetchSpec } from './registry/builtins/web-fetch';
import { writeFileSpec } from './registry/builtins/write-file';
import { writePlanSpec } from './registry/builtins/write-plan';
import type { ShellExecutor } from './shell';
import { buildDescription } from './tool-contracts';

/** 创建 Agent 工具集输入 / Input for creating agent tools */
export interface CreateAgentToolsInput {
  /** 工作目录 / Workspace directory */
  workspace: string;
  /** 可选 Shell 执行器 / Optional shell executor */
  shellExecutor?: ShellExecutor;
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

/** 模块级工具缓存：按 cacheKey 隔离，防止多 session 并发时竞态覆盖 / Module-level tool cache isolated by cacheKey to prevent race conditions with concurrent sessions */
const _toolCache = new Map<string, ToolSet>();

function stableCacheStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCacheStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableCacheStringify(record[key])}`)
    .join(',')}}`;
}

/** 清除工具缓存（MCP server 重连或工具列表变化时调用）/ Clear tool cache (call on MCP reconnect or tool list change) */
export function clearToolCache(): void {
  _toolCache.clear();
}

/** 创建 Agent 工具集（跨工作区访问权限保持 schema 稳定，由工具执行层强制边界） */
export function createAgentTools(input: CreateAgentToolsInput): ToolSet {
  // Bindings, not the number of discovered tools, determine MCP declaration identity.
  const mcpBindingRevision = stableCacheStringify(
    input.mcpBindings?.map(({ binding }) => ({
      name: binding.exposedToolName,
      revision: binding.capabilityRevision,
      schema: binding.schemaDigest,
    })) ?? [],
  );
  const authorizationCacheKey = input.authorization
    ? stableCacheStringify({
        mode: input.authorization.mode,
        commandGrants: input.authorization.commandGrants ?? {},
      })
    : '';
  const activeSkillFrameKey = (input.activeSkillFrames ?? [])
    .map((frame) => frame.activationId)
    .sort()
    .join(',');
  const cacheKey = `${input.workspace}|${!!input.shellExecutor}|${mcpBindingRevision}|${input.skillCatalog?.revision ?? ''}|${activeSkillFrameKey}|${!!input.toolSearch}|${!!input.subagentEventSink}|${!!input.config}|${!!input.model}|${input.threadId ?? ''}|${input.workspaceAccess ?? ''}|${input.phase ?? ''}|${input.interactionMode ?? ''}|${authorizationCacheKey}`;
  const cached = _toolCache.get(cacheKey);
  if (cached) return cached;
  // 已迁入 ToolSpec Registry（ADR-0026 S1.2）：schema-only 条目，
  // 真实执行只经 Registry dispatch（tool-runner read_file 分支），模型 ToolSet 不携带 execute。
  const readFileTool = tool({
    description: buildDescription(readFileSpec.contract),
    inputSchema: zodSchema(readFileSpec.inputSchema),
  });

  // 已迁入 ToolSpec Registry（ADR-0026 S1.2，含 §3 严格精确匹配）：
  // schema-only 条目，真实执行只经 Registry dispatch。
  const editFileTool = tool({
    description: buildDescription(editFileSpec.contract),
    inputSchema: zodSchema(editFileSpec.inputSchema),
  });

  // 已迁入 ToolSpec Registry（ADR-0026 S1.2，含 ADR-0025 §2 append 移除）：
  // schema-only 条目，真实执行只经 Registry dispatch；mode 参数不再存在。
  const writeFileTool = tool({
    description: buildDescription(writeFileSpec.contract),
    inputSchema: zodSchema(writeFileSpec.inputSchema),
  });

  const shellExecute = tool({
    description: buildDescription(shellExecuteSpec.contract),
    inputSchema: zodSchema(shellExecuteSpec.inputSchema),
  });

  const listMcpResources = tool({
    description: buildDescription(listMcpResourcesSpec.contract),
    inputSchema: zodSchema(listMcpResourcesSpec.inputSchema),
  });
  const listMcpTools = tool({
    description: buildDescription(listMcpToolsSpec.contract),
    inputSchema: zodSchema(listMcpToolsSpec.inputSchema),
  });
  const readMcpResource = tool({
    description: buildDescription(readMcpResourceSpec.contract),
    inputSchema: zodSchema(readMcpResourceSpec.inputSchema),
  });

  // ── search_content / search_files: 已迁入 ToolSpec Registry（ADR-0026 S1.2）──
  // schema-only 条目，真实执行只经 Registry dispatch（tool-runner 对应分支）。
  const searchContent = tool({
    description: buildDescription(searchContentSpec.contract),
    inputSchema: zodSchema(searchContentSpec.inputSchema),
  });

  const searchFiles = tool({
    description: buildDescription(searchFilesSpec.contract),
    inputSchema: zodSchema(searchFilesSpec.inputSchema),
  });

  const skillActivationEnabled =
    Boolean(input.config) &&
    getFeatureFlags(input.config).skillWorkflowV1 &&
    getFeatureFlags(input.config).skillActivationV2 &&
    Boolean(
      input.skillCatalog?.capabilities.descriptors.some(
        (item) => item.availability === 'available',
      ),
    );
  const activateSkillTool = skillActivationEnabled
    ? tool({
        description: buildDescription(activateSkillSpec.contract),
        inputSchema: zodSchema(activateSkillSpec.inputSchema),
      })
    : null;
  const completeSkillTool =
    input.activeSkillFrames && input.activeSkillFrames.length > 0
      ? tool({
          description: buildDescription(completeSkillSpec.contract),
          inputSchema: zodSchema(completeSkillSpec.inputSchema),
        })
      : null;
  const readSkillReferenceTool =
    input.activeSkillFrames && input.activeSkillFrames.length > 0
      ? tool({
          description: buildDescription(readSkillReferenceSpec.contract),
          inputSchema: zodSchema(readSkillReferenceSpec.inputSchema),
        })
      : null;
  const toolSearchTool = input.toolSearch
    ? tool({
        description: buildDescription(toolSearchSpec.contract),
        inputSchema: zodSchema(toolSearchSpec.inputSchema),
      })
    : null;

  const taskTool =
    input.subagentEventSink && input.config
      ? tool({
          description: buildDescription(taskSpec.contract),
          inputSchema: zodSchema(taskSpec.inputSchema),
        })
      : null;

  const webFetchTool = tool({
    description: buildDescription(webFetchSpec.contract),
    inputSchema: zodSchema(webFetchSpec.inputSchema),
  });

  const builtinTools: ToolSet = {
    read_file: readFileTool,
    read_plan: tool({
      description: buildDescription(readPlanSpec.contract),
      inputSchema: zodSchema(readPlanSpec.inputSchema),
    }),
    edit_file: editFileTool,
    write_file: writeFileTool,
    shell_execute: shellExecute,
    search_content: searchContent,
    search_files: searchFiles,
    list_mcp_resources: listMcpResources,
    list_mcp_tools: listMcpTools,
    read_mcp_resource: readMcpResource,
    web_fetch: webFetchTool,
    ...(activateSkillTool ? { activate_skill: activateSkillTool } : {}),
    ...(completeSkillTool ? { complete_skill: completeSkillTool } : {}),
    ...(readSkillReferenceTool ? { read_skill_reference: readSkillReferenceTool } : {}),
    ...(toolSearchTool ? { tool_search: toolSearchTool } : {}),
    ...(taskTool ? { task: taskTool } : {}),
    write_plan: tool({
      description: buildDescription(writePlanSpec.contract),
      inputSchema: zodSchema(writePlanSpec.inputSchema),
    }),
    update_plan: tool({
      description: buildDescription(updatePlanSpec.contract),
      inputSchema: zodSchema(updatePlanSpec.inputSchema),
    }),
    ask_user: tool({
      description: buildDescription(askUserSpec.contract),
      inputSchema: zodSchema(askUserSpec.inputSchema),
    }),
  };

  const mcpTools: ToolSet = {};
  for (const { binding, descriptor } of input.mcpBindings ?? []) {
    if (descriptor.kind !== 'mcp_tool' || descriptor.availability !== 'available') continue;
    if (!descriptor.inputSchema) continue;
    // AI SDK's JSONSchema7 type is narrower than MCP's runtime schema. The
    // binding was validated by compileCapabilitySchema before it reaches here.
    const inputSchema = jsonSchema(
      modelVisibleCapabilitySchema(descriptor.inputSchema) as Parameters<typeof jsonSchema>[0],
    );
    mcpTools[binding.exposedToolName] = dynamicTool({
      description:
        'Runtime-bound MCP capability. The Runtime validates its current revision, arguments, policy, approval, execution receipt, and verification before use.',
      inputSchema,
    });
  }
  const tools = { ...builtinTools, ...mcpTools };
  _toolCache.set(cacheKey, tools);
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
