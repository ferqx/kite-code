import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AgentConfig } from '@/core/config/index';
import { claimPermit, type PermitBatch } from '@/core/execution/permit';
import type { McpRuntimeProvider } from '@/core/mcp';
import { buildMcpInventory, isMcpProviderError, normalizeMcpToolResult } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import {
  evaluateToolApproval,
  isReadOnlyMcpPolicy,
  type RuntimeMcpPolicy,
} from '@/core/policies/approval-policy';
import { createModePolicy } from '@/core/policies/mode-policy';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import type { SubAgentEventSink } from '@/core/subagent/types';
import { computeLineDiff, formatContentOutput, formatDiffOutput } from '@/core/tools/diff';
import { editFile, readFile, readTextContent, writeFile } from '@/core/tools/file';
import {
  searchContent as searchContentNative,
  searchFiles as searchFilesNative,
} from '@/core/tools/search';
import { type ShellExecutor, shellTool } from '@/core/tools/shell';
import { formatToolParseError } from '@/core/tools/tool-parse-error';
import type {
  AuthorizationOverride,
  ShellNetworkMode,
  ShellResult,
  ThreadAuthorizationState,
} from '@/core/types';
import { fetchAndExtract } from '@/core/web/extractor';
import type {
  AgentPhase,
  InteractionMode,
  ShellGrantUsed,
  WorkspaceAccess,
} from '@/protocol/events';
import { defaultPhaseForWorkspaceAccess, normalizeAuthorizationState } from './tool-policy';
import type { PendingToolRequest } from './tool-requests';
import type { ToolExecutionResult } from './tool-result';

function resultContentDigest(stdout: string, stderr: string, exitCode: number): string {
  return createHash('sha256').update(JSON.stringify({ stdout, stderr, exitCode })).digest('hex');
}

/**
 * ADR-0025 §4：best-effort 原像捕获 —— 记录器抛错绝不允许中断工具执行。
 * Best-effort pre-image capture: a throwing recorder must never fail the tool.
 */
function safeRecordPreimage(
  recorder: ((path: string, content: string | null, existed: boolean) => void) | undefined,
  path: string,
  content: string | null,
  existed: boolean,
): void {
  if (!recorder) return;
  try {
    recorder(path, content, existed);
  } catch {
    /* best-effort */
  }
}

/** runApprovedTool 输入参数 / Input for runApprovedTool */
export interface RunApprovedToolInput {
  workspace: string;
  request: PendingToolRequest;
  shellExecutor?: ShellExecutor;
  workspaceAccess?: WorkspaceAccess;
  phase?: AgentPhase;
  authorization?: ThreadAuthorizationState | null;
  approvedGrant?: ShellGrantUsed;
  threadId?: string;
  override?: AuthorizationOverride;
  mcpManager?: McpRuntimeProvider;
  mcpInvocation?: {
    capabilityId: string;
    expectedRevision: string;
  };
  /** Runtime-resolved policy for a binding-validated MCP capability. */
  mcpPolicy?: RuntimeMcpPolicy;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  signal?: AbortSignal;
  permitBatch?: PermitBatch;
  interactionMode?: import('@/protocol/events').InteractionMode;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  subagentEventSink?: SubAgentEventSink;
  /** Shell 实时输出回调，仅对 shell_execute 生效 / Live output callback, only for shell_execute */
  onShellProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /**
   * 写入前文件原像记录器（ADR-0025 §4），供 /rewind 恢复工作区文件。
   * best-effort：实现自身吞错，工具层直接调用即可。
   * File pre-image recorder invoked before workspace writes (ADR-0025 §4),
   * enabling /rewind to restore files. Best-effort by contract.
   */
  recordFilePreimage?: (path: string, content: string | null, existed: boolean) => void;
}

/** 执行经过审批的工具调用 / Execute an approved tool call */
export async function runApprovedTool(input: RunApprovedToolInput): Promise<ToolExecutionResult> {
  const {
    workspace,
    request,
    shellExecutor,
    workspaceAccess = 'write',
    phase = defaultPhaseForWorkspaceAccess(workspaceAccess),
    authorization = null,
    approvedGrant = 'none',
    threadId = '',
    override,
    mcpManager,
    mcpInvocation,
    mcpPolicy,
    skillManifests,
    skillOptions,
    signal,
    permitBatch,
    interactionMode = 'accept_edits',
    taskConfig,
    taskModel,
    subagentEventSink,
  } = input;
  // 合成调用：parseToolCall 失败后由 invokeModel 注入 _raw_invalid_args 标记。
  // 跳过正常执行，直接生成工具特定的错误反馈让模型重试。
  // Synthetic call: injected by invokeModel after parseToolCall failure.
  // Skip normal execution, generate tool-specific error so model can retry.
  const args = (request.args ?? {}) as Record<string, unknown>;
  if (typeof args._raw_invalid_args === 'string') {
    const errDetail = formatToolParseError(
      request.name,
      args._raw_invalid_args,
      (args._parse_error as string) ?? 'invalid JSON arguments',
    );
    return {
      ok: false,
      command: request.name,
      exitCode: -1,
      stdout: '',
      stderr: errDetail,
    };
  }

  const policy = evaluateToolApproval({
    toolName: request.name,
    toolArgs: request.args as Record<string, unknown>,
    phase,
    workspace,
    threadId,
    authorization: normalizeAuthorizationState(authorization),
    override,
    mcpPolicy,
  });
  if (!policy.allowed) {
    return withFailureGuidance(request, {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: '',
      stderr: `Rejected by tool policy: ${policy.reason}`,
      status: 'rejected',
    });
  }

  // 防御性检查仍复用同一 mode policy，避免控制器与执行器对免审批范围产生漂移。
  // Defense-in-depth reuses the same mode policy so controller and runner cannot drift.
  const modeDecision = createModePolicy(interactionMode).shouldApproveTool({
    interactionMode,
    phase,
    planKind: 'building_without_plan',
    toolName: request.name,
    toolRisk: policy.risk,
    effects: policy.effects,
  });
  const requiresModeApproval =
    !isReadOnlyMcpPolicy(mcpPolicy) &&
    (modeDecision.kind === 'need_tool_approval' || modeDecision.kind === 'need_auto_review');
  const hasExecutionGrant =
    approvedGrant !== 'none' ||
    policy.grantUsed === 'same_command' ||
    policy.grantUsed === 'full_access';
  if (!hasExecutionGrant && requiresModeApproval) {
    return withFailureGuidance(request, {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: '',
      stderr: `Rejected by tool policy: ${request.name} requires approval but was not approved.`,
      status: 'rejected',
    });
  }

  if (permitBatch && request.id && (policy.requiresApproval || permitBatch[request.id])) {
    const claimed = claimPermit({
      batch: permitBatch,
      workspace,
      threadId,
      request,
    });
    if (!claimed.ok) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: claimed.reason,
        status: 'rejected',
      });
    }
  }

  if (request.name === 'task') {
    if (!taskConfig || !subagentEventSink) {
      return withFailureGuidance(request, {
        ok: false,
        command: 'task',
        exitCode: -1,
        stdout: '',
        stderr: 'task tool is unavailable in this execution context.',
        status: 'error',
      });
    }
    try {
      const taskArgs = request.args as {
        subagent_type: 'explore' | 'plan' | 'code' | 'review';
        task: string;
      };
      const result = await runTaskSubAgent(
        {
          config: taskConfig,
          workspace,
          shellExecutor,
          mcpManager,
          skills: skillManifests,
          skillOptions,
          authorization: normalizeAuthorizationState(authorization),
          workspaceAccess,
          phase,
          threadId,
          eventSink: subagentEventSink,
          signal,
          model: taskModel,
          recordFilePreimage: input.recordFilePreimage,
        },
        taskArgs,
      );
      const output = JSON.stringify(result);
      const ok = result.ok !== false;
      return withFailureGuidance(request, {
        ok,
        command: 'task',
        exitCode: ok ? 0 : -1,
        stdout: output,
        stderr: ok ? '' : output,
        status: ok ? 'success' : 'error',
        subagentResult: result,
      });
    } catch (error) {
      return withFailureGuidance(request, {
        ok: false,
        command: 'task',
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        status: 'error',
      });
    }
  }

  if (request.name === 'read_file') {
    const filePath = (request.args.path ?? '') as string;
    const isExternal = isAbsolute(filePath) || filePath.startsWith('~');
    const allowExternal = hasExecutionGrant && isExternal;
    const result = readFile({
      workspace,
      path: filePath,
      offset: request.args.offset,
      limit: request.args.limit,
      allowExternal,
    });
    return withFailureGuidance(request, {
      ok: result.ok,
      command: `read_file ${filePath}`,
      exitCode: result.ok ? 0 : -1,
      stdout: result.content,
      stderr: result.error ?? '',
      path: filePath,
      totalLines: result.totalLines,
      resultMeta: { path: filePath, totalLines: result.totalLines },
    });
  }

  if (request.name === 'edit_file') {
    if (!request.args.old_string) {
      return withFailureGuidance(request, {
        ok: false,
        command: `edit_file ${request.args.path ?? ''}`,
        exitCode: -1,
        stdout: '',
        stderr: 'edit_file requires old_string to locate the text to replace.',
      });
    }
    const editPath = (request.args.path ?? '') as string;
    const isExternal = isAbsolute(editPath) || editPath.startsWith('~');
    const allowExternal = hasExecutionGrant && isExternal;
    // ADR-0025 §4：改动前捕获原像，供 /rewind 恢复（best-effort）
    // Capture pre-image before mutating, for /rewind restore (best-effort).
    const preEditRead = readTextContent(workspace, editPath, { allowExternal });
    safeRecordPreimage(
      input.recordFilePreimage,
      editPath,
      preEditRead.ok ? preEditRead.content : null,
      preEditRead.ok,
    );
    const result = editFile({
      workspace,
      path: editPath,
      oldString: request.args.old_string as string,
      newString: (request.args.new_string ?? '') as string,
      replaceAll: request.args.replace_all as boolean | undefined,
      allowExternal,
    });
    let stdout = '';
    if (result.ok) {
      const diff = computeLineDiff(
        request.args.old_string,
        request.args.new_string ?? '',
        result.fromLine ?? 1,
      );
      const parts: string[] = [];
      if (request.args.replace_all) {
        const count = result.replacements ?? 1;
        parts.push(`(replaced ${count} time${count > 1 ? 's' : ''})`);
      }
      parts.push(formatDiffOutput(diff));
      if (request.args.old_string === (request.args.new_string ?? '')) {
        parts.push('(no effective change)');
      }
      // 保护 LLM 上下文：diff 超长时截断
      // Cap for LLM context: truncate overlong diff output
      stdout = parts.join('\n');
      const rawResultDigest = resultContentDigest(stdout, result.error ?? '', 0);
      if (stdout.length > 2000) {
        stdout = `${stdout.slice(0, 2000)}\n... (truncated)`;
      }
      return withFailureGuidance(request, {
        ok: result.ok,
        command: `edit_file ${request.args.path ?? ''}`,
        exitCode: 0,
        stdout,
        stderr: '',
        path: request.args.path,
        resultMeta: {
          path: editPath,
          truncated: stdout.endsWith('... (truncated)'),
          workspaceMutationScope: editPath ? [editPath] : [],
          rawResultDigest,
        },
      });
    }
    return withFailureGuidance(request, {
      ok: result.ok,
      command: `edit_file ${request.args.path ?? ''}`,
      exitCode: result.ok ? 0 : -1,
      stdout,
      stderr: result.error ?? '',
      path: request.args.path,
      resultMeta: {
        path: editPath,
        truncated: stdout.endsWith('... (truncated)'),
        workspaceMutationScope: editPath ? [editPath] : [],
      },
    });
  }

  if (request.name === 'write_file') {
    const filePath = (request.args.path ?? '') as string;
    const isExternal = isAbsolute(filePath) || filePath.startsWith('~');
    const allowExternal = hasExecutionGrant && isExternal;

    // 写入前读取旧内容，用于生成 diff / Read old content before writing for diff
    const oldRead = readTextContent(workspace, filePath, { allowExternal });
    const oldExisted = oldRead.ok;

    // ADR-0025 §4：覆写/追加前捕获原像（复用上面已读取的旧内容，零额外 I/O）
    // Capture pre-image before overwrite/append (reuses oldRead, zero extra I/O).
    safeRecordPreimage(
      input.recordFilePreimage,
      filePath,
      oldRead.ok ? oldRead.content : null,
      oldRead.ok,
    );

    const result = writeFile({
      workspace,
      path: filePath,
      content: (request.args.content ?? '') as string,
      mode: request.args.mode as 'overwrite' | 'append' | undefined,
      allowExternal,
    });

    let stdout = '';
    if (result.ok) {
      if (oldExisted && request.args.mode !== 'append') {
        // 覆写已有文件：diff 旧内容 → 新内容
        // Overwrite existing file: diff old → new
        const newContent = request.args.content ?? '';
        const diff = computeLineDiff(oldRead.content, newContent, 1);
        if (diff.addedLines === 0 && diff.removedLines === 0) {
          // 内容未变更 — 展示实际行数而非无意义的 0 diff
          // Content unchanged — show actual line count instead of meaningless 0 diff
          const actualLines = result.lines ?? 0;
          const linesWord = actualLines === 1 ? 'line' : 'lines';
          const header = `Wrote ${actualLines} ${linesWord} to ${request.args.path} (content unchanged)`;
          stdout = formatContentOutput(newContent, header);
        } else {
          stdout = formatDiffOutput(diff);
        }
      } else {
        // 新建文件 / 追加模式：展示带行号的纯文本内容，无需 diff 样式
        // New file or append: show plain content with line numbers, no diff markers
        const verb = request.args.mode === 'append' ? 'Appended' : 'Wrote';
        const header = `${verb} ${result.lines ?? 0} lines to ${request.args.path}`;
        stdout = formatContentOutput(request.args.content ?? '', header);
      }
      const rawResultDigest = resultContentDigest(stdout, result.error ?? '', 0);
      // 保护 LLM 上下文：超长时截断 / Cap for LLM context
      if (stdout.length > 2000) {
        stdout = `${stdout.slice(0, 2000)}\n... (truncated)`;
      }
      return withFailureGuidance(request, {
        ok: result.ok,
        command: `write_file ${request.args.path ?? ''}`,
        exitCode: 0,
        stdout,
        stderr: '',
        path: request.args.path,
        resultMeta: {
          path: filePath,
          truncated: stdout.endsWith('... (truncated)'),
          workspaceMutationScope: filePath ? [filePath] : [],
          rawResultDigest,
        },
      });
    }

    return withFailureGuidance(request, {
      ok: result.ok,
      command: `write_file ${request.args.path ?? ''}`,
      exitCode: result.ok ? 0 : -1,
      stdout,
      stderr: result.error ?? '',
      path: request.args.path,
      resultMeta: {
        path: filePath,
        truncated: stdout.endsWith('... (truncated)'),
        workspaceMutationScope: filePath ? [filePath] : [],
      },
    });
  }

  if (request.name === 'ask_user') {
    // 通过 policy 判断 ask_user 是否被当前 mode 禁止（替代 isFullAccessMode 直接检查）
    // Use policy to determine if ask_user is forbidden by current mode
    const askPolicy = createModePolicy(interactionMode);
    if (
      askPolicy.shouldAskUser({
        interactionMode: interactionMode as InteractionMode,
        phase: phase as 'planning' | 'building',
        planKind: 'building_without_plan',
        toolName: 'ask_user',
      }).kind === 'deny'
    ) {
      return withFailureGuidance(request, {
        ok: false,
        command: 'ask_user',
        exitCode: -1,
        stdout: '',
        stderr: JSON.stringify({
          ok: false,
          rejected: true,
          replan: {
            reasonCode: 'FULL_NO_USER_INTERACTION',
            reason: 'Full mode cannot ask the user. Make the best safe assumption and continue.',
            blockedCapability: 'ask_user',
          },
        }),
        status: 'rejected',
      });
    }
    return withFailureGuidance(request, {
      ok: false,
      command: 'ask_user',
      exitCode: -1,
      stdout: '',
      stderr: 'ask_user must be handled by the user_input interrupt node.',
    });
  }

  if (request.name === 'search_content') {
    const searchPath = (request.args.path ?? '.') as string;
    const isExternal = isAbsolute(searchPath) || searchPath.startsWith('~');
    const allowExternal = hasExecutionGrant && isExternal;
    const result = searchContentNative({
      workspace,
      pattern: request.args.pattern,
      path: searchPath,
      glob: request.args.glob,
      allowExternal,
    });
    const stdout = truncateToolOutput(result.stdout);
    const stderr = truncateToolOutput(result.stderr);
    return withFailureGuidance(request, {
      ...result,
      stdout,
      stderr,
      command: `search_content ${request.args.pattern ?? ''}`,
      resultMeta: {
        path: searchPath,
        matchCount: result.stdout.split('\n').filter(Boolean).length,
        truncated: stdout.length < result.stdout.length,
        rawResultDigest: resultContentDigest(result.stdout, result.stderr, result.exitCode),
      },
    });
  }

  if (request.name === 'search_files') {
    const searchPath = (request.args.path ?? '.') as string;
    const isExternal = isAbsolute(searchPath) || searchPath.startsWith('~');
    const allowExternal = hasExecutionGrant && isExternal;
    const result = searchFilesNative({
      workspace,
      pattern: request.args.pattern,
      path: searchPath,
      allowExternal,
    });
    const stdout = truncateToolOutput(result.stdout);
    const stderr = truncateToolOutput(result.stderr);
    return withFailureGuidance(request, {
      ...result,
      stdout,
      stderr,
      command: `search_files ${request.args.pattern ?? ''}`,
      resultMeta: {
        path: searchPath,
        matchCount: result.stdout.split('\n').filter(Boolean).length,
        truncated: stdout.length < result.stdout.length,
        rawResultDigest: resultContentDigest(result.stdout, result.stderr, result.exitCode),
      },
    });
  }

  if (request.name === 'list_mcp_resources') {
    if (!mcpManager) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr:
          'MCP Runtime is not available in this execution context. Use list_mcp_tools or /mcp to inspect configured providers.',
      });
    }
    const { server } = request.args;
    const snapshot = mcpManager.getResourceDirectorySnapshot();
    const matching = snapshot.resources
      .filter((resource) => server == null || resource.providerId === server)
      .slice()
      .sort(
        (left, right) =>
          left.providerId.localeCompare(right.providerId) ||
          left.uri.localeCompare(right.uri) ||
          left.name.localeCompare(right.name),
      );
    if (server && matching.length === 0) {
      const provider = mcpManager
        .getProviderDirectorySnapshot()
        .entries.find((entry) => entry.providerId === server);
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: provider
          ? `No available static MCP resources were discovered for server: ${server}`
          : `Unknown MCP server: ${server}`,
      });
    }
    const resources = matching.slice(0, 100).map((resource) => ({
      server: resource.providerId,
      uri: resource.uri,
      name: resource.name,
      ...(resource.mimeType ? { mime_type: resource.mimeType } : {}),
    }));
    return withFailureGuidance(request, {
      ok: true,
      command: request.protectedCommand,
      exitCode: 0,
      stdout: JSON.stringify({
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
      }),
      stderr: '',
    });
  }

  if (request.name === 'list_mcp_tools') {
    if (!mcpManager) {
      return withFailureGuidance(request, {
        ok: true,
        command: request.protectedCommand,
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          configured_provider_count: 0,
          callable_provider_count: 0,
          available_tool_count: 0,
          providers: [],
          tools: [],
          truncated: false,
        }),
        stderr: '',
      });
    }
    const result = buildMcpInventory({
      capabilities: mcpManager.getCapabilitySnapshot(),
      providers: mcpManager.getProviderDirectorySnapshot(),
      query: {
        provider: request.args.provider,
        limit: request.args.limit,
        cursor: request.args.cursor,
      },
    });
    return withFailureGuidance(request, {
      ok: result.ok,
      command: request.protectedCommand,
      exitCode: result.ok ? 0 : -1,
      stdout: JSON.stringify(result),
      stderr: '',
    });
  }

  if (request.name === 'read_mcp_resource') {
    if (!mcpManager) {
      return withFailureGuidance(request, {
        ok: false,
        command: `read_mcp_resource ${request.args.server ?? ''}`,
        exitCode: -1,
        stdout: '',
        stderr:
          'MCP Runtime is not available in this execution context. Use list_mcp_tools or /mcp to inspect configured providers.',
      });
    }
    const { server, uri } = request.args;
    if (!server || !uri) {
      return withFailureGuidance(request, {
        ok: false,
        command: `read_mcp_resource ${server ?? ''}`,
        exitCode: -1,
        stdout: '',
        stderr: 'server and uri are required',
      });
    }
    try {
      const content = await mcpManager.readResource(server, uri, signal);
      const serialized = serializeMcpResourceForModel(content);
      return withFailureGuidance(request, {
        ok: true,
        command: `read_mcp_resource ${server}`,
        exitCode: 0,
        stdout: serialized.modelContent,
        stderr: '',
        resultMeta: {
          rawResultDigest: resultContentDigest(content, '', 0),
          truncated: serialized.truncated,
        },
      });
    } catch (err) {
      if (isMcpProviderError(err)) throw err;
      return withFailureGuidance(request, {
        ok: false,
        command: `read_mcp_resource ${server}`,
        exitCode: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (request.name.startsWith('mcp__')) {
    if (!mcpManager) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.name,
        exitCode: -1,
        stdout: '',
        stderr:
          'MCP Runtime is not available in this execution context. Use list_mcp_tools or /mcp to inspect configured providers.',
      });
    }
    if (!mcpInvocation) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.name,
        exitCode: -1,
        stdout: '',
        stderr: 'MCP capability invocation identity is missing.',
      });
    }
    try {
      const raw = await mcpManager.callCapability({
        capabilityId: mcpInvocation.capabilityId,
        expectedRevision: mcpInvocation.expectedRevision,
        arguments: request.args as unknown as Record<string, unknown>,
        signal,
      });
      const rawContent = JSON.stringify(raw);
      const descriptor = mcpManager.findCapability(mcpInvocation.capabilityId);
      const capabilityResult = normalizeMcpToolResult(raw, descriptor?.outputSchema);
      const output = serializeMcpResultForModel(capabilityResult);
      return withFailureGuidance(request, {
        ok: !raw.isError,
        command: request.name,
        exitCode: 0,
        stdout: output.modelContent,
        stderr: '',
        capabilityResult,
        resultMeta: {
          rawResultDigest: resultContentDigest(rawContent, '', 0),
          truncated: output.truncated,
        },
      });
    } catch (err) {
      if (isMcpProviderError(err)) throw err;
      return withFailureGuidance(request, {
        ok: false,
        command: request.name,
        exitCode: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (request.name === 'web_fetch') {
    try {
      const result = await fetchAndExtract(request.args.url ?? '', {
        signal,
        maxChars: request.args.max_chars,
        timeoutMs: request.args.timeout_ms,
      });
      const stdout = result.ok
        ? [
            `Fetched: ${result.title ?? result.finalUrl ?? request.args.url}`,
            result.contentType ? `Type: ${result.contentType}` : '',
            result.truncated ? '(content truncated)' : '',
            '',
            result.content ?? '',
          ]
            .filter(Boolean)
            .join('\n')
        : `Failed to fetch ${request.args.url}: ${result.error ?? 'unknown error'}`;

      // 截断上限对齐 max_chars（含标题/元数据行的开销，+500 余量）
      // truncation limit matches max_chars (with ~500 char overhead for metadata lines)
      const contentLimit = Math.max(8000, (request.args.max_chars ?? 8000) + 500);
      const projectedStdout = truncateToolOutput(stdout, contentLimit);
      return withFailureGuidance(request, {
        ok: result.ok,
        command: `web_fetch ${request.args.url ?? ''}`,
        exitCode: result.ok ? 0 : -1,
        stdout: projectedStdout,
        stderr: result.error ?? '',
        resultMeta: {
          ...(result.truncated
            ? {}
            : {
                rawResultDigest: resultContentDigest(
                  stdout,
                  result.error ?? '',
                  result.ok ? 0 : -1,
                ),
              }),
          truncated: projectedStdout !== stdout || result.truncated,
        },
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const isTimeout = isAbort && error.message === 'Fetch timeout';
      return withFailureGuidance(request, {
        ok: false,
        command: `web_fetch ${request.args.url ?? ''}`,
        exitCode: isTimeout ? 124 : isAbort ? 130 : -1,
        stdout: '',
        stderr: isTimeout
          ? 'Fetch timed out.'
          : isAbort
            ? 'Web fetch cancelled by user.'
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }

  if (request.name === 'shell_execute') {
    const networkMode = resolveShellNetworkMode(policy, hasExecutionGrant);
    const raw = await runShellForTool(
      workspace,
      request.args.command,
      shellExecutor,
      signal,
      input.onShellProgress,
      request.args.timeout_ms,
      networkMode,
    );
    const result: ShellResult = {
      ...raw,
      stdout: truncateToolOutput(raw.stdout),
      stderr: truncateToolOutput(raw.stderr),
    };
    return withFailureGuidance(request, {
      ...result,
      resultMeta: {
        rawResultDigest: resultContentDigest(raw.stdout, raw.stderr, raw.exitCode),
        truncated: result.stdout !== raw.stdout || result.stderr !== raw.stderr,
      },
      action: {
        intent: request.args.intent,
        objective: request.args.objective,
        expectedObservation: request.args.expected_observation,
        failureStrategy: request.args.failure_strategy,
        prefixRule: request.args.prefix_rule,
        grantUsed: approvedGrant === 'none' ? policy.grantUsed : approvedGrant,
      },
    });
  }

  return {
    ok: false,
    command: 'unsupported_tool',
    exitCode: -1,
    stdout: '',
    stderr: 'Unsupported tool request.',
  };
}

const MAX_MODEL_MCP_RESULT_CHARS = 128 * 1024;

function serializeMcpResourceForModel(content: string): {
  modelContent: string;
  truncated: boolean;
} {
  if (content.length <= MAX_MODEL_MCP_RESULT_CHARS) {
    return { modelContent: content, truncated: false };
  }
  return {
    modelContent: JSON.stringify({
      status: 'partial',
      content: content.slice(0, MAX_MODEL_MCP_RESULT_CHARS),
      truncated: true,
      original_characters: content.length,
      message: 'The MCP resource exceeded the model-facing output limit.',
    }),
    truncated: true,
  };
}

function serializeMcpResultForModel(result: import('@/core/capabilities/result').CapabilityResult) {
  const serialized = JSON.stringify(result);
  if (serialized.length <= MAX_MODEL_MCP_RESULT_CHARS) {
    return { modelContent: serialized, truncated: false };
  }
  return {
    modelContent: JSON.stringify({
      status: 'partial',
      content: [
        {
          type: 'text',
          text: serialized.slice(0, MAX_MODEL_MCP_RESULT_CHARS),
        },
      ],
      truncated: true,
      original_characters: serialized.length,
      message:
        'The MCP result exceeded the model-facing output limit. The complete governed result remains available to Runtime execution records when applicable.',
    }),
    truncated: true,
  };
}

/** 共享截断函数：保留头部 + 尾部，中间标注省略行数。
 *  Shared truncation: keep head + tail with omitted-line marker in between.
 *  Zero hallucination risk — preserves verbatim content, just drops the middle. */
export function truncateToolOutput(output: string, maxLen = 4000): string {
  if (output.length <= maxLen) return output;
  const keep = Math.floor(maxLen / 2);
  const head = output.slice(0, keep);
  const tail = output.slice(-keep);
  const omittedLines = output.slice(keep, -keep).split('\n').filter(Boolean).length;
  return `${head}\n... [${omittedLines} lines omitted, ${output.length - 2 * keep} total chars truncated]\n${tail}`;
}

async function runShellForTool(
  workspace: string,
  command: string,
  shellExecutor?: ShellExecutor,
  signal?: AbortSignal,
  onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  timeoutMs?: number,
  networkMode?: ShellNetworkMode,
): Promise<ShellResult> {
  try {
    return await (shellExecutor ?? shellTool)({
      workspace,
      command,
      signal,
      onProgress,
      timeoutMs,
      networkMode,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      command,
      exitCode: isAbort ? 130 : -1,
      stdout: '',
      stderr: isAbort
        ? 'Command cancelled by user.'
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

function resolveShellNetworkMode(
  policy: ReturnType<typeof evaluateToolApproval>,
  hasExecutionGrant: boolean,
): ShellNetworkMode {
  const mayNeedNetwork = policy.effects?.network || policy.effects?.uncertainEffects;
  return mayNeedNetwork && hasExecutionGrant ? 'allow_all' : 'disabled';
}

/** 给失败工具结果补充模型可直接使用的原因和正确用法 / Add model-facing failure guidance to failed tool results */
function withFailureGuidance(
  request: PendingToolRequest,
  result: ToolExecutionResult,
): ToolExecutionResult {
  const resultWithTool = {
    ...result,
    tool: request.name,
  };

  if (result.ok !== false) {
    return resultWithTool;
  }

  const reason =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `Tool ${request.name} failed with exit code ${result.exitCode}.`;

  return {
    ...resultWithTool,
    failure: {
      message: 'Tool execution failed.',
      tool: request.name,
      reason,
      guidance: toolUsageGuidance(request),
    },
  };
}

/** 按工具类型生成失败后的正确使用提示 / Build per-tool usage guidance after failure */
function toolUsageGuidance(request: PendingToolRequest): string {
  switch (request.name) {
    case 'read_file':
      return 'Use read_file with a relative path inside the workspace. If the path is uncertain, use shell_execute with intent inspect and a read-only command such as rg, ls, find, or git status to locate the file first, then retry with the exact path.';
    case 'edit_file':
      return 'Use edit_file only after read_file. old_string must exactly match existing file content, including whitespace and indentation; if the same text appears multiple times, make old_string more specific or set replace_all: true.';
    case 'write_file':
      return 'Use write_file with a relative path and complete file content when creating or fully overwriting a file. For small changes to an existing file, prefer read_file followed by edit_file.';
    case 'shell_execute':
      return 'Use shell_execute with a concrete command and action metadata. Set intent to inspect for read-only checks such as rg, ls, cat, or git status; set intent to verify for tests, typecheck, build, lint, or smoke checks. Provide description to explain what the command does. Include grant_request for commands needing approval.';
    case 'ask_user':
      return 'Use ask_user only when progress is blocked by a focused clarification. Provide one concise question, concrete options, and allow free text when appropriate; the user_input node handles the interrupt.';
    case 'web_fetch':
      return 'Use web_fetch with a complete http/https URL. Verify the URL is public and accessible before calling. If fetch fails with HTTP error, the page may not exist or may be behind authentication. If readability fails, the page may not be a text article — try a different source.';
    default:
      return '';
  }
}
