import { dynamicTool, jsonSchema, type ToolSet, tool, zodSchema } from 'ai';
import { z } from 'zod';
import { modelVisibleCapabilitySchema } from '@/core/capabilities/search';
import { getFeatureFlags } from '@/core/config/features';
import type { SupportedChatModel } from '@/core/model/factory';
import type { SkillCatalogSnapshot } from '@/core/skills/catalog';
import { createTaskTool } from '@/core/subagent/task-tool';
import { fetchAndExtract } from '@/core/web/extractor';
import type { CapabilityBinding, CapabilityDescriptor } from '@/protocol/capabilities';
import { editFile, readFile, writeFile } from './file';
import { searchContent as searchContentNative, searchFiles as searchFilesNative } from './search';
import { type ShellExecutor, shellTool } from './shell';
import {
  ASK_USER_CONTRACT,
  EDIT_FILE_CONTRACT,
  LIST_MCP_RESOURCES_CONTRACT,
  LIST_MCP_TOOLS_CONTRACT,
  READ_FILE_CONTRACT,
  READ_MCP_RESOURCE_CONTRACT,
  READ_PLAN_CONTRACT,
  SEARCH_CONTENT_CONTRACT,
  SEARCH_FILES_CONTRACT,
  SHELL_EXECUTE_CONTRACT,
  TOOL_SEARCH_CONTRACT,
  UPDATE_PLAN_CONTRACT,
  WEB_FETCH_CONTRACT,
  WRITE_FILE_CONTRACT,
  WRITE_PLAN_CONTRACT,
} from './tool-contracts';

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
  const readFileTool = tool({
    description: READ_FILE_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        path: z.string().describe('Path to the file, relative to workspace'),
        offset: z.number().optional().describe('Starting line number (1-indexed, default 1)'),
        limit: z.number().optional().describe('Maximum number of lines to read'),
      }),
    ),
    execute: async ({ path, offset, limit }) =>
      JSON.stringify(readFile({ workspace: input.workspace, path, offset, limit })),
  });

  const editFileTool = tool({
    description: EDIT_FILE_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        path: z.string().describe('Path to the file to edit, relative to workspace'),
        old_string: z
          .string()
          .describe(
            'The exact text to replace. Must match the file content exactly, including whitespace.',
          ),
        new_string: z.string().describe('The new text to replace old_string with'),
        replace_all: z
          .boolean()
          .optional()
          .describe('Replace all occurrences (default: false, fails if multiple matches found)'),
        match_mode: z
          .enum(['exact', 'trimmed'])
          .optional()
          .describe(
            'Match mode: exact (default) for verbatim matching, trimmed for per-line whitespace trimming',
          ),
      }),
    ),
    execute: async ({ path, old_string, new_string, replace_all }) =>
      JSON.stringify(
        editFile({
          workspace: input.workspace,
          path,
          oldString: old_string,
          newString: new_string,
          replaceAll: replace_all,
        }),
      ),
  });

  const writeFileTool = tool({
    description: WRITE_FILE_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        path: z.string().describe('Path to the file, relative to workspace'),
        content: z.string().describe('Complete file content to write'),
        mode: z
          .enum(['overwrite', 'append'])
          .optional()
          .describe(
            'Write mode: overwrite (default) replaces entire file, append adds content at end',
          ),
      }),
    ),
    execute: async ({ path, content, mode }) =>
      JSON.stringify(writeFile({ workspace: input.workspace, path, content, mode })),
  });

  const shellExecute = tool({
    description: SHELL_EXECUTE_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        command: z.string().describe('Shell command to execute in the workspace'),
        description: z
          .string()
          .optional()
          .describe(
            'Short human-readable description of what this command does (shown to the user)',
          ),
        intent: z
          .enum(['inspect', 'verify', 'build', 'test', 'git', 'other'])
          .optional()
          .describe('Command intent'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Maximum runtime in milliseconds. Use this for commands that start a TUI, dev server, watcher, or other long-running process.',
          ),
        prefix_rule: z
          .array(z.string())
          .optional()
          .describe('Suggested future prefix grant rule for audit only'),
        grant_request: z
          .enum(['approve_once', 'same_command', 'full_access'])
          .optional()
          .describe('Suggested approval grant; the user resume payload decides the actual grant'),
      }),
    ),
    execute: async ({ command, timeout_ms }) =>
      JSON.stringify(
        await (input.shellExecutor ?? shellTool)({
          workspace: input.workspace,
          command,
          signal: input.signal,
          timeoutMs: timeout_ms,
        }),
      ),
  });

  const listMcpResources = tool({
    description: LIST_MCP_RESOURCES_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        server: z.string().min(1).optional().describe('Optional exact MCP server name'),
      }),
    ),
    execute: async ({ server }) => {
      if (!input.mcpManager) {
        return JSON.stringify({ ok: false, stderr: 'MCP manager is not available.' });
      }
      const snapshot = input.mcpManager.getResourceDirectorySnapshot();
      const matching = snapshot.resources.filter(
        (resource) => server == null || resource.providerId === server,
      );
      if (server && matching.length === 0) {
        return JSON.stringify({
          ok: false,
          stderr: `No available MCP resources were discovered for server: ${server}`,
        });
      }
      const resources = matching.slice(0, 100).map((resource) => ({
        server: resource.providerId,
        uri: resource.uri,
        name: resource.name,
        ...(resource.mimeType ? { mime_type: resource.mimeType } : {}),
      }));
      return JSON.stringify({
        ok: true,
        resource_count: resources.length,
        resources,
        truncated: matching.length > resources.length,
        next_step:
          matching.length > resources.length
            ? 'Call list_mcp_resources with an exact server to narrow the result.'
            : resources.length > 0
              ? 'Call read_mcp_resource with an exact server and URI.'
              : 'No static MCP resources are currently available.',
      });
    },
  });

  const listMcpTools = tool({
    description: LIST_MCP_TOOLS_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        provider: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .optional()
          .describe('Optional provider name to filter results'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum tools to return (default 50, max 100)'),
        cursor: z.string().max(2048).optional().describe('Opaque cursor for pagination'),
      }),
    ),
    execute: async () => JSON.stringify({ ok: false, stderr: 'Handled by tool runner.' }),
  });

  const readMcpResource = tool({
    description: READ_MCP_RESOURCE_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        server: z.string().describe('MCP server name'),
        uri: z.string().describe('Resource URI to read (e.g. file:///docs/api.md)'),
      }),
    ),
    execute: async ({ server, uri }) => {
      if (!input.mcpManager) {
        return JSON.stringify({
          ok: false,
          stderr: 'No MCP manager available. Open /mcp to manage MCP providers.',
        });
      }
      try {
        const content = await input.mcpManager.readResource(server, uri, input.signal);
        return JSON.stringify({ ok: true, content });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          stderr: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  // ── search_content: dedicated code search (replaces shell_execute grep/rg) ──
  const searchContent = tool({
    description: SEARCH_CONTENT_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        pattern: z.string().describe('Regex pattern to search for (e.g. "function\\s+\\w+")'),
        path: z
          .string()
          .optional()
          .describe('Directory or file path to search in (default: workspace root)'),
        glob: z.string().optional().describe('File glob filter (e.g. "*.ts", "*.{ts,tsx}")'),
      }),
    ),
    execute: async ({ pattern, path, glob }) => {
      return JSON.stringify(
        await searchContentNative({ workspace: input.workspace, pattern, path, glob }),
      );
    },
  });

  // ── search_files: dedicated file discovery (replaces shell_execute find/ls) ──
  const searchFiles = tool({
    description: SEARCH_FILES_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        pattern: z.string().describe('File name pattern (e.g. "*.test.ts", "config.*")'),
        path: z.string().optional().describe('Directory to search in (default: workspace root)'),
      }),
    ),
    execute: async ({ pattern, path }) => {
      return JSON.stringify(await searchFilesNative({ workspace: input.workspace, pattern, path }));
    },
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
    ? dynamicTool({
        description:
          'Request activation of a compiled Skill Workflow Contract. The Runtime validates the Skill, its input, revision and activation policy; this tool does not load arbitrary prompt text.',
        inputSchema: zodSchema(
          z.object({
            skill_id: z
              .string()
              .min(1)
              .describe('Capability ID of the skill, for example skill:read-report'),
            input: z
              .record(z.string(), z.unknown())
              .describe('Object input required by the Skill contract'),
          }),
        ),
      })
    : null;
  const completeSkillTool =
    input.activeSkillFrames && input.activeSkillFrames.length > 0
      ? dynamicTool({
          description:
            'Complete an active inline Skill Workflow with structured output. Runtime validates it against the compiled output schema.',
          inputSchema: zodSchema(
            z.object({
              activation_id: z.string().min(1),
              output: z.record(z.string(), z.unknown()),
            }),
          ),
        })
      : null;
  const readSkillReferenceTool =
    input.activeSkillFrames && input.activeSkillFrames.length > 0
      ? dynamicTool({
          description:
            'Read a declared scripts/, references/, assets/, or evals/ file from an active Skill on demand. Runtime permits only a file belonging to the current, revision-checked Skill Contract.',
          inputSchema: zodSchema(
            z.object({
              activation_id: z.string().min(1),
              path: z.string().min(1),
            }),
          ),
        })
      : null;
  const toolSearchTool = input.toolSearch
    ? dynamicTool({
        description: TOOL_SEARCH_CONTRACT.description,
        inputSchema: zodSchema(
          z.object({
            query: z.string().trim().min(2).max(512).describe('Capability intent to search for'),
            limit: z.number().int().min(1).max(12).optional().describe('Maximum candidates'),
          }),
        ),
      })
    : null;

  const taskTool =
    input.subagentEventSink && input.config
      ? createTaskTool({
          config: input.config,
          model: input.model,
          workspace: input.workspace,
          shellExecutor: input.shellExecutor,
          mcpManager: input.mcpManager,
          skills: input.skills,
          skillOptions: input.skillOptions,
          authorization: input.authorization,
          workspaceAccess: input.workspaceAccess,
          phase: input.phase,
          threadId: input.threadId,
          eventSink: input.subagentEventSink,
          signal: input.subagentSignal,
          maxDepth: input.maxDepth,
        })
      : null;

  const webFetchTool = tool({
    description: WEB_FETCH_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        url: z
          .string()
          .min(1)
          .max(8192)
          .describe('Public http/https URL to fetch (max 8192 chars)'),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(16000)
          .optional()
          .describe('Max characters of extracted content (default 8000)'),
        timeout_ms: z
          .number()
          .int()
          .min(3000)
          .max(30000)
          .optional()
          .describe(
            'Timeout in milliseconds (default 15000). Increase for large pages like Wikipedia or GitHub.',
          ),
      }),
    ),
    execute: async ({ url, max_chars, timeout_ms }) => {
      try {
        const result = await fetchAndExtract(url, {
          signal: input.signal,
          maxChars: max_chars,
          timeoutMs: timeout_ms,
        });
        const stdout = result.ok
          ? [
              `Fetched: ${result.title ?? result.finalUrl ?? url}`,
              result.contentType ? `Type: ${result.contentType}` : '',
              result.truncated ? '(content truncated)' : '',
              '',
              result.content ?? '',
            ]
              .filter(Boolean)
              .join('\n')
          : `Failed to fetch ${url}: ${result.error ?? 'unknown error'}`;
        return JSON.stringify({ ...result, stdout });
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === 'AbortError';
        const message = isAbort
          ? err.message === 'Fetch timeout'
            ? 'Fetch timed out.'
            : 'Web fetch cancelled by user.'
          : err instanceof Error
            ? err.message
            : String(err);
        return JSON.stringify({
          ok: false,
          url,
          stderr: message,
          error: message,
        });
      }
    },
  });

  const builtinTools: ToolSet = {
    read_file: readFileTool,
    read_plan: tool({
      description: READ_PLAN_CONTRACT.description,
      inputSchema: zodSchema(
        z.object({
          plan_id: z.string().min(1),
          version: z.number().int().positive().optional(),
          structural_digest: z.string().min(1).optional(),
        }),
      ),
      execute: async ({ plan_id, version, structural_digest }) =>
        JSON.stringify({
          ok: true,
          _params: { plan_id, version, structural_digest },
        }),
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
    write_plan: createWritePlanTool(),
    update_plan: createProgressUpdatePlanTool(),
    ask_user: createAskUserTool(),
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

/** 创建 write_plan 工具定义 — 保存草稿或提交审核。
 *  Create write_plan tool definition — save draft or submit for review. */
function createWritePlanTool() {
  const documentFields = {
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe('One-line plan title (required when writing a new Artifact)'),
    body_markdown: z
      .string()
      .trim()
      .min(20)
      .max(30_000)
      .describe('Full plan in Markdown (required when writing a new Artifact)'),
    steps: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[a-z][a-z0-9_-]{0,31}$/)
            .describe('Stable step ID (e.g. "inspect-runtime")'),
          title: z.string().trim().min(1).max(160).describe('One-line step description'),
        }),
      )
      .min(1)
      .max(12)
      .describe('Ordered execution steps (required when writing a new Artifact)'),
  };
  const artifactFields = {
    plan_id: z
      .string()
      .trim()
      .min(1)
      .describe('Existing Plan ID to submit without resending the document'),
    version: z.number().int().positive().describe('Existing Artifact version to submit'),
    structural_digest: z
      .string()
      .trim()
      .min(1)
      .describe('Digest returned by save for the Artifact being submitted'),
  };
  const optionalDocumentFields = {
    title: documentFields.title.optional(),
    body_markdown: documentFields.body_markdown.optional(),
    steps: documentFields.steps.optional(),
  };
  const optionalArtifactFields = {
    plan_id: artifactFields.plan_id.optional(),
    version: artifactFields.version.optional(),
    structural_digest: artifactFields.structural_digest.optional(),
  };
  const commonFields = {
    expected_version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Expected current version to prevent overwriting a newer draft'),
    replan_reason: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe('Why a new structural plan is needed while an approved plan is executing'),
  };
  const writePlanInputSchema = z
    .object({
      ...optionalDocumentFields,
      ...optionalArtifactFields,
      ...commonFields,
      action: z.enum(['save', 'submit']).optional(),
    })
    .superRefine((value, context) => {
      const action = value.action ?? 'save';
      const hasDocument =
        value.title !== undefined && value.body_markdown !== undefined && value.steps !== undefined;
      const hasArtifactReference =
        value.plan_id !== undefined &&
        value.version !== undefined &&
        value.structural_digest !== undefined;

      if (action === 'save' && !hasDocument) {
        if (value.title === undefined) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: 'Required' });
        }
        if (value.body_markdown === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['body_markdown'],
            message: 'Required',
          });
        }
        if (value.steps === undefined) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'Required' });
        }
      }

      if (action === 'submit' && !hasArtifactReference && !hasDocument) {
        if (value.plan_id === undefined && value.title === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['plan_id'],
            message: 'Submit requires an Artifact reference or a complete document',
          });
        }
        if (value.version === undefined && value.body_markdown === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['version'],
            message: 'Submit requires an Artifact reference or a complete document',
          });
        }
        if (value.structural_digest === undefined && value.steps === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['structural_digest'],
            message: 'Submit requires an Artifact reference or a complete document',
          });
        }
      }
    });

  return tool({
    description: WRITE_PLAN_CONTRACT.description,
    inputSchema: zodSchema(writePlanInputSchema),
    execute: async ({
      title,
      body_markdown,
      steps,
      expected_version,
      action,
      replan_reason,
      plan_id,
      version,
      structural_digest,
    }) => {
      const effectiveAction = action ?? 'save';
      const submit = effectiveAction === 'submit';
      return JSON.stringify({
        ok: true,
        plan_id: '', // filled by tool-controller
        version: 0, // filled by tool-controller
        structural_digest: '', // filled by tool-controller
        review_required: submit,
        _params: {
          title,
          body_markdown,
          steps,
          expected_version,
          action: effectiveAction,
          replan_reason,
          plan_id,
          version,
          structural_digest,
        },
      });
    },
  });
}

/** 创建 update_plan 工具定义 — 批准后更新步骤执行进度。
 *  Create update_plan tool definition — update step execution progress after approval. */
function createProgressUpdatePlanTool() {
  return tool({
    description: UPDATE_PLAN_CONTRACT.description,
    inputSchema: zodSchema(
      z.object({
        plan_id: z.string().min(1).describe('Plan ID from the approved plan'),
        updates: z
          .array(
            z.object({
              step_id: z.string().min(1).describe('Stable step ID from the plan'),
              status: z
                .enum(['pending', 'in_progress', 'completed', 'skipped'])
                .describe('New status for this step'),
              note: z.string().trim().max(500).optional().describe('Optional note about this step'),
            }),
          )
          .min(1)
          .max(12)
          .describe('Step status updates (1-12 items)'),
        complete_plan: z
          .boolean()
          .optional()
          .describe('Set to true when all steps are done to mark the plan as completed'),
      }),
    ),
    execute: async ({ plan_id, updates, complete_plan }) =>
      JSON.stringify({
        ok: true,
        plan_id,
        updated_steps: updates.map((u) => u.step_id),
        plan_completed: complete_plan ?? false,
        _params: { plan_id, updates, complete_plan },
      }),
  });
}

/** 创建 ask_user 工具定义，用于规划时向用户澄清关键不确定性。
 *  支持单问题模式和 questions 数组多问题模式。
 *  Create ask_user tool definition for user clarification.
 *  Supports single-question mode and multi-question (questions array) mode.
 *
 *  每个问题最多 3 个选项，必须标记一个为 recommended。
 *  Each question has at most 3 options, one must be marked as recommended. */
function createAskUserTool() {
  const optionSchema = z.object({
    id: z
      .string()
      .describe(
        "Stable option id, e.g. 'minimal' or 'full'. Required — referenced by recommended.",
      ),
    label: z.string().min(1).describe('User-facing option label'),
    description: z
      .string()
      .optional()
      .describe('Short explanation of the trade-off for this option'),
  });

  const questionItemSchema = z.object({
    id: z.string().optional().describe("Stable identifier, e.g. 'scope' or 'tech'"),
    question: z.string().min(1).describe('The question text'),
    options: z
      .array(optionSchema)
      .min(1)
      .max(3)
      .optional()
      .describe(
        'Suggested answer options (max 3). Always provide options to help non-expert users.',
      ),
    recommended: z
      .string()
      .optional()
      .describe(
        "Option id of the recommended choice. Mark exactly ONE option — this helps users who don't know which to pick.",
      ),
    allow_free_text: z
      .boolean()
      .optional()
      .describe('Whether user may type custom answer for this question; default true'),
  });

  return tool({
    description: ASK_USER_CONTRACT.description,
    inputSchema: zodSchema(
      z
        .object({
          question: z
            .string()
            .min(1)
            .optional()
            .describe('Main question or summary (required unless questions is provided)'),
          options: z
            .array(optionSchema)
            .min(1)
            .max(3)
            .optional()
            .describe(
              'Suggested answer options for single-question mode (max 3). Always provide options.',
            ),
          recommended: z
            .string()
            .optional()
            .describe('Option id of the recommended choice for single-question mode.'),
          allow_free_text: z
            .boolean()
            .optional()
            .describe('Whether the user may type a custom answer; default true'),
          context: z
            .string()
            .optional()
            .describe('Short context explaining why this clarification is needed'),
          questions: z
            .array(questionItemSchema)
            .min(1)
            .optional()
            .describe(
              'Multiple questions at once — TUI renders as a step wizard. Use this to batch clarifications instead of making multiple ask_user calls.',
            ),
        })
        .superRefine((value, context) => {
          if (!value.question && !value.questions) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['question'],
              message: 'Provide question or a non-empty questions array',
            });
          }
        }),
    ),
    execute: async ({ question, options, allow_free_text, context, questions }) =>
      JSON.stringify({
        ok: false,
        question,
        options,
        allow_free_text: allow_free_text ?? true,
        context,
        questions,
        stderr: 'ask_user is handled by the harness as a user_input interrupt.',
      }),
  });
}

/** shell_execute inspect 允许直通的只读命令白名单 / Read-only command allowlist for shell_execute inspect */
const PLAN_READ_ONLY_COMMANDS = new Set([
  'awk',
  'cat',
  'cut',
  'du',
  'echo',
  'file',
  'find',
  'grep',
  'head',
  'ls',
  'nl',
  'pwd',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'test',
  'tr',
  'uniq',
  'wc',
]);

/** shell_execute inspect 允许直通的 Git 只读子命令白名单 / Read-only git subcommand allowlist for shell_execute inspect */
const PLAN_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'grep',
  'log',
  'ls-files',
  'show',
  'status',
]);

/** 检查命令是否可作为 shell_execute inspect 直通 / Check if command can bypass approval as shell_execute inspect */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = (command ?? '').trim();
  // 拒绝对空命令和包含文件输出重定向的命令（允许 >&N stderr 重定向到 fd 和 /dev/null 抑制输出）
  // Reject empty commands and file output redirection; allow >&N stderr-to-fd and /dev/null sink
  if (!trimmed || /(^|[^>])>{1,2}(?!&[12]|\s*\/dev\/null)(?:$|[^>])/.test(trimmed)) {
    return false;
  }

  // 拒绝命令替换 — $() 和反引号中可能包含写入命令，直通会导致绕过审批
  // Reject command substitution — $() and backticks may contain write commands
  if (/\$\(/.test(trimmed) || /`/.test(trimmed)) {
    return false;
  }

  // 拒绝裸 & 命令分隔符（cmd.exe: cmd1 & cmd2, bash: cmd1 & cmd2）
  // 允许 &&（逻辑与，已按分隔符拆段）、>&N / N>&M（stderr 重定向）
  // Reject bare & command separator; allow && and >&N stderr redirect
  const stripped = trimmed.replace(/&&/g, '').replace(/\d?>&\d?/g, '');
  if (stripped.includes('&')) {
    return false;
  }

  // 拆分为多个命令段并逐一检查 / Split into multiple command segments and check each one
  return splitShellSegments(trimmed).every(isPlanReadOnlySegment);
}

/** 兼容旧名称 / Backward-compatible alias */
export const isPlanReadOnlyShellCommand = isReadOnlyShellCommand;

/** 将 Shell 命令按分隔符拆分为多个段 / Split shell command into segments by separators */
function splitShellSegments(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|[|;])\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** 检查单个命令段是否为允许直通的只读命令 / Check if individual segment is read-only */
function isPlanReadOnlySegment(segment: string): boolean {
  // 将命令段解析为 token 数组，支持引号 / Parse segment into token array, supporting quotes
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  // 第一个 token 为命令名，去除引号后转小写 / First token is the command name, strip quotes and lower-case
  const command = stripQuotes(tokens[0] ?? '').toLowerCase();
  if (!command) {
    return false;
  }

  // git 命令需额外检查子命令白名单 / Git command requires additional subcommand allowlist check
  if (command === 'git') {
    return PLAN_READ_ONLY_GIT_SUBCOMMANDS.has(stripQuotes(tokens[1] ?? '').toLowerCase());
  }

  // sed 命令禁止 -i 原地编辑标志 / sed command forbids -i in-place edit flag
  if (command === 'sed') {
    return (
      PLAN_READ_ONLY_COMMANDS.has(command) &&
      !tokens.some((token) => /^-.*i/.test(stripQuotes(token)))
    );
  }

  // find 命令禁止 -exec、-execdir、-delete 等危险选项 / find command forbids dangerous options: -exec, -execdir, -delete
  if (command === 'find') {
    return (
      PLAN_READ_ONLY_COMMANDS.has(command) &&
      !tokens.some((token) => ['-exec', '-execdir', '-delete'].includes(stripQuotes(token)))
    );
  }

  // awk 命令禁止 system() 调用 / awk command forbids system() call
  if (command === 'awk') {
    return PLAN_READ_ONLY_COMMANDS.has(command) && !/\bsystem\s*\(/.test(segment);
  }

  // xargs 根据其执行的命令判断是否只读 / xargs is read-only only when the command it invokes is read-only
  if (command === 'xargs') {
    // tokens[0] is 'xargs'; find the next non-option token (the command xargs runs)
    const invokedIdx = tokens.findIndex((t, i) => i > 0 && !t.startsWith('-'));
    const invoked = invokedIdx > 0 ? stripQuotes(tokens[invokedIdx] ?? '').toLowerCase() : '';
    if (!invoked) return false;
    return PLAN_READ_ONLY_COMMANDS.has(invoked);
  }

  return PLAN_READ_ONLY_COMMANDS.has(command);
}

/** 去除字符串首尾引号 / Strip surrounding quotes from string */
function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}
