import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { getFeatureFlags } from '@/core/config/features';
import type { AgentConfig } from '@/core/config/index';
import { claimPermit, type PermitBatch } from '@/core/execution/permit';
import {
  isMcpProviderError,
  type McpRuntimeProvider,
  normalizeMcpToolResult,
  RemoteMcpEgressDeniedError,
  type RemoteMcpEgressInvocationPolicyV1,
} from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import {
  type ProjectInstructionSnapshot,
  resolveProjectInstructionSnapshot,
} from '@/core/model/project-instructions';
import {
  evaluateToolApproval,
  isReadOnlyMcpPolicy,
  type RuntimeMcpPolicy,
} from '@/core/policies/approval-policy';
import { createModePolicy } from '@/core/policies/mode-policy';
import { createProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import type { FilePreimageRecorder } from '@/core/runtime/file-checkpoints';
import { DescendantResourceAdmissionError } from '@/core/runtime/resource-budget-admission';
import { isDescriptorAdmittedByExecutionCapabilitySurfaceV1 } from '@/core/sandbox/execution-capability-surface';
import type { NetworkDecisionRecorderV1 } from '@/core/sandbox/network-enforcer';
import {
  type NetworkBoundaryPolicyV1,
  networkBoundaryPolicyFromExecutionBoundaryV1,
} from '@/core/sandbox/network-policy';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import type { SubAgentEventSink } from '@/core/subagent/types';
import { normalizeEOL, readTextContent, resolvePath } from '@/core/tools/file';
import { msys2ToWindowsPath } from '@/core/tools/path-utils';
import { fileContentHash, sessionReadTracker } from '@/core/tools/read-state';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import { editFileSpec } from '@/core/tools/registry/builtins/edit-file';
import {
  listMcpResourcesSpec,
  listMcpToolsSpec,
  readMcpResourceSpec,
} from '@/core/tools/registry/builtins/mcp-inventory';
import { readFileSpec } from '@/core/tools/registry/builtins/read-file';
import { searchContentSpec } from '@/core/tools/registry/builtins/search-content';
import { searchFilesSpec } from '@/core/tools/registry/builtins/search-files';
import {
  projectedShellIntent,
  shellExecuteSpec,
} from '@/core/tools/registry/builtins/shell-execute';
import { taskSpec } from '@/core/tools/registry/builtins/task';
import { webFetchSpec } from '@/core/tools/registry/builtins/web-fetch';
import { writeFileSpec } from '@/core/tools/registry/builtins/write-file';
import {
  dispatchRegisteredTool,
  evaluateRegisteredToolProtectedPaths,
} from '@/core/tools/registry/dispatch';
import type { ToolAvailabilityContext } from '@/core/tools/registry/spec';
import { TOOL_RESULT_BUDGET_POLICY_V1 } from '@/core/tools/result-budget';
import type { ShellExecutor } from '@/core/tools/shell';
import type {
  AuthorizationOverride,
  ShellNetworkMode,
  ThreadAuthorizationState,
} from '@/core/types';
import type {
  AgentPhase,
  InteractionMode,
  ShellGrantUsed,
  WorkspaceAccess,
} from '@/protocol/events';
import { defaultPhaseForWorkspaceAccess, normalizeAuthorizationState } from './tool-policy';
import { isMcpRequest, type PendingToolRequest } from './tool-requests';
import type { ToolExecutionResult } from './tool-result';

function resultContentDigest(stdout: string, stderr: string, exitCode: number): string {
  return createHash('sha256').update(JSON.stringify({ stdout, stderr, exitCode })).digest('hex');
}

/**
 * ADR-0042 §4：best-effort 原像捕获 —— 记录器抛错绝不允许中断工具执行。
 * Best-effort pre-image capture: a throwing recorder must never fail the tool.
 */
function safeRecordPreimage(
  recorder: FilePreimageRecorder | undefined,
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

/** 记录最后一次 Kite 写入结果，供 rewind 在覆盖前识别后续手动/Bash 修改。 */
function safeRecordPostimage(
  recorder: FilePreimageRecorder | undefined,
  path: string,
  content: string | null,
  existed: boolean,
): void {
  if (!recorder?.recordPostimage) return;
  try {
    recorder.recordPostimage(path, content, existed);
  } catch {
    /* best-effort */
  }
}

/** 路径参数可能是 MSYS2 形式（/c/proj/...）——先归一化再判断外部性，
 * 与策略层（approval-policy）保持一致，避免工作区内路径被误判为外部。
 * Path args may arrive in MSYS2 form (/c/proj/...); normalize before the
 * external check, consistent with the policy layer, so in-workspace paths
 * are not treated as external. No-op outside Windows. */
function isExternalPathArg(pathArg: string): boolean {
  const normalized = msys2ToWindowsPath(pathArg);
  return isAbsolute(normalized) || normalized.startsWith('~');
}

/** Production capability surfaces reject every path that does not resolve
 * inside the canonical workspace, including relative traversal and symlink
 * escape. Keep this separate from isExternalPathArg: the latter is the legacy
 * approval-shape predicate, while this is a fail-closed execution ceiling. */
function isOutsideProductionWorkspace(workspace: string, pathArg: string): boolean {
  if (!pathArg) return false;
  if (isExternalPathArg(pathArg)) return true;
  try {
    resolvePath(workspace, pathArg, { allowExternal: false });
    return false;
  } catch {
    return true;
  }
}

/** 规范化路径参数（读取状态跟踪的键，与 readTextContent 的解析一致）。 */
function canonicalFilePath(workspace: string, pathArg: string, allowExternal: boolean): string {
  try {
    return resolvePath(workspace, pathArg, { allowExternal });
  } catch {
    return pathArg;
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
    remoteEgress?: RemoteMcpEgressInvocationPolicyV1;
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
  providerDataAdmission?: import('@/core/config/provider-data-admission').ProviderDataAdmissionGateV1;
  descendantResourceAdmission?: import('@/core/runtime/resource-budget-admission').DescendantResourceAdmissionV1;
  /** Runs after all local policy/approval checks and immediately before tool dispatch. */
  beforeDispatch?: () => Promise<void>;
  subagentEventSink?: SubAgentEventSink;
  /** Shell 实时输出回调，仅对 shell_execute 生效 / Live output callback, only for shell_execute */
  onShellProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /**
   * 写入前文件原像记录器（ADR-0042 §4），供 /rewind 恢复工作区文件。
   * best-effort：实现自身吞错，工具层直接调用即可。
   * File pre-image recorder invoked before workspace writes (ADR-0042 §4),
   * enabling /rewind to restore files. Best-effort by contract.
   */
  recordFilePreimage?: FilePreimageRecorder;
  /** Persists one network decision before the admitted socket can be opened. */
  recordNetworkDecision?: NetworkDecisionRecorderV1;
  /** 当前模型轮次的工具可用性快照，用于 Registry effects 分类。省略时回退到仅 workspace/threadId。 */
  availabilityContext?: ToolAvailabilityContext;
  /** Project instructions visible to the model that issued this request. */
  projectInstructionSnapshot?: ProjectInstructionSnapshot;
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
    providerDataAdmission,
    descendantResourceAdmission,
    beforeDispatch,
    subagentEventSink,
    availabilityContext,
    projectInstructionSnapshot,
  } = input;

  const executionSurface = taskConfig?.executionCapabilitySurface;
  const protectedPathEvaluator = taskConfig?.executionBoundary
    ? createProtectedPathEvaluatorV1({
        workspaceRoot: taskConfig.executionBoundary.workspaceRoot,
        mode: taskConfig.executionBoundary.protectedPathPolicy,
      })
    : undefined;
  const builtinSpec = builtinToolRegistry.get(request.name);
  if (taskConfig && getFeatureFlags(taskConfig).promptContractV2 && projectInstructionSnapshot) {
    const args = request.args as Record<string, unknown>;
    const target =
      request.name === 'edit_file' || request.name === 'write_file'
        ? typeof args.path === 'string'
          ? args.path
          : '.'
        : request.name === 'shell_execute' ||
            (request.name === 'task' && args.subagent_type === 'code')
          ? '.'
          : undefined;
    if (target) {
      const current = resolveProjectInstructionSnapshot({ workspace, targetPaths: [target] });
      const visible = new Map(
        projectInstructionSnapshot.documents.map((document) => [document.path, document.digest]),
      );
      const changed = current.documents.find(
        (document) => visible.get(document.path) !== document.digest,
      );
      if (changed) {
        return withFailureGuidance(request, {
          ok: false,
          command: request.protectedCommand,
          exitCode: -1,
          stdout: '',
          stderr: `project_instructions_changed: read ${changed.path} in the refreshed model context before retrying this side effect.`,
          status: 'rejected',
        });
      }
    }
  }
  if (
    taskConfig &&
    'productionExecution' in taskConfig &&
    (!executionSurface || !protectedPathEvaluator)
  ) {
    return withFailureGuidance(request, {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: '',
      stderr: 'Rejected by production execution boundary: protected-path gate is unavailable.',
      status: 'rejected',
    });
  }
  if (builtinSpec && protectedPathEvaluator) {
    const pathDecision = evaluateRegisteredToolProtectedPaths(builtinSpec, request.args, {
      workspace,
      threadId,
      protectedPathEvaluator,
    });
    if (!pathDecision.ok) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: pathDecision.error,
        status: 'rejected',
      });
    }
  }
  const networkBoundaryPolicy = taskConfig?.executionBoundary
    ? networkBoundaryPolicyFromExecutionBoundaryV1(
        taskConfig.executionBoundary,
        taskConfig.features?.networkBoundaryV1 === true,
      )
    : undefined;
  if (executionSurface) {
    const descriptor = builtinSpec
      ? builtinToolRegistry.descriptorOf(builtinSpec)
      : isMcpRequest(request) && mcpManager && mcpInvocation
        ? mcpManager.findCapability(mcpInvocation.capabilityId)
        : undefined;
    const externalPath = isOutsideProductionWorkspace(
      workspace,
      String((request.args as Record<string, unknown>).path ?? ''),
    );
    if (
      !descriptor ||
      externalPath ||
      !isDescriptorAdmittedByExecutionCapabilitySurfaceV1({
        surface: executionSurface,
        descriptor,
      })
    ) {
      const reason =
        executionSurface.process === false && executionSurface.write === false
          ? 'tool is not in the sealed read-only catalog'
          : 'capability is outside the admitted execution surface';
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: `Rejected by production execution boundary: ${reason}.`,
        status: 'rejected',
      });
    }
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
    capability: builtinToolRegistry.effectsOf(
      request.name,
      request.args,
      availabilityContext ?? { workspace, threadId },
    ),
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

  await beforeDispatch?.();

  // Approval/permit hooks are asynchronous and may allow an external actor to
  // replace a path component. Re-evaluate before write/edit perform any old
  // content read or pre-image capture; Registry dispatch repeats the same gate
  // immediately before execute.
  if (builtinSpec && protectedPathEvaluator) {
    const pathDecision = evaluateRegisteredToolProtectedPaths(builtinSpec, request.args, {
      workspace,
      threadId,
      protectedPathEvaluator,
    });
    if (!pathDecision.ok) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: pathDecision.error,
        status: 'rejected',
      });
    }
  }

  if (request.name === 'task') {
    try {
      const runTask =
        taskConfig && subagentEventSink
          ? (taskInput: { subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string }) =>
              runTaskSubAgent(
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
                  projectInstructions: projectInstructionSnapshot,
                  threadId,
                  eventSink: subagentEventSink,
                  signal,
                  model: taskModel,
                  providerDataAdmission,
                  descendantResourceAdmission,
                  recordFilePreimage: input.recordFilePreimage,
                },
                taskInput,
              )
          : undefined;
      const dispatched = await dispatchRegisteredTool(taskSpec, request.args, {
        workspace,
        threadId,
        signal,
        runTask,
        protectedPathEvaluator,
      });
      if (!dispatched.dispatched) {
        return withFailureGuidance(request, {
          ok: false,
          command: 'task',
          exitCode: -1,
          stdout: '',
          stderr: dispatched.rejection.error,
          status: 'error',
        });
      }
      if (!dispatched.output.available) {
        return withFailureGuidance(request, {
          ok: false,
          command: 'task',
          exitCode: -1,
          stdout: '',
          stderr: dispatched.output.error,
          status: 'error',
        });
      }
      const result = dispatched.output.result;
      return withFailureGuidance(request, {
        ok: dispatched.projected.ok,
        command: 'task',
        exitCode: dispatched.projected.ok ? 0 : -1,
        stdout: dispatched.projected.ok ? dispatched.projected.modelContent : '',
        stderr: dispatched.projected.ok ? '' : dispatched.projected.modelContent,
        status: dispatched.projected.ok ? 'success' : 'error',
        resultMeta: dispatched.projected.resultMeta,
        subagentResult: result,
      });
    } catch (error) {
      if (error instanceof DescendantResourceAdmissionError) throw error;
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
    const filePath = request.args.path;
    const isExternal = isExternalPathArg(filePath);
    const allowExternal = hasExecutionGrant && isExternal;
    // 已迁入 ToolSpec Registry（ADR-0043 S1.2）：执行经 dispatchRegisteredTool，
    // 结果组装保持与旧路径字节一致（resultMeta / digest / TUI 展示不受影响）。
    const dispatched = await dispatchRegisteredTool(
      readFileSpec,
      { path: filePath, offset: request.args.offset, limit: request.args.limit },
      {
        workspace,
        threadId,
        signal,
        allowExternalPaths: allowExternal,
        protectedPathEvaluator,
      },
    );
    const output = dispatched.dispatched
      ? dispatched.output
      : {
          ok: false as const,
          content: '',
          error: dispatched.rejection.error,
          totalLines: 0,
          path: filePath,
        };
    if (output.ok && output.rawContent !== undefined) {
      // ADR-0042 §1 读取状态记录：指纹取原始文本（output.content 是带行号的
      // 模型表面格式，与 edit 侧 preEditRead 指纹口径不一致，不可用于校验）。
      sessionReadTracker(threadId || workspace).record(
        canonicalFilePath(workspace, filePath, allowExternal),
        fileContentHash(output.rawContent),
      );
    }
    return withFailureGuidance(request, {
      ok: dispatched.dispatched && dispatched.projected.ok,
      command: `read_file ${filePath}`,
      exitCode: dispatched.dispatched && dispatched.projected.ok ? 0 : -1,
      stdout:
        dispatched.dispatched && dispatched.projected.ok ? dispatched.projected.modelContent : '',
      stderr:
        dispatched.dispatched && !dispatched.projected.ok
          ? dispatched.projected.modelContent
          : dispatched.dispatched
            ? ''
            : dispatched.rejection.error,
      path: filePath,
      totalLines: output.totalLines,
      resultMeta: dispatched.dispatched
        ? dispatched.projected.resultMeta
        : { path: filePath, totalLines: output.totalLines },
    });
  }

  if (request.name === 'edit_file') {
    const editInput = request.args;
    if (!editInput.old_string) {
      return withFailureGuidance(request, {
        ok: false,
        command: `edit_file ${editInput.path ?? ''}`,
        exitCode: -1,
        stdout: '',
        stderr: 'edit_file requires old_string to locate the text to replace.',
      });
    }
    const editPath = editInput.path;
    const isExternal = isExternalPathArg(editPath);
    const allowExternal = hasExecutionGrant && isExternal;
    // ADR-0042 §4：改动前读取文件内容用于 readState 计算；
    // 原像记录延迟到 preExecute 通过之后（只在实际写入前记录）。
    const preEditRead = readTextContent(workspace, editPath, { allowExternal });
    // 已迁入 ToolSpec Registry（ADR-0043 S1.2，含 §3 严格精确匹配）：
    // 执行经 dispatchRegisteredTool；ADR-0042 §1 先读后改校验由 spec.preExecute
    // 基于会话读取状态执行（not_read / stale → 硬失败，引导重读）。
    const tracker = sessionReadTracker(threadId || workspace);
    const canonicalPath = canonicalFilePath(workspace, editPath, allowExternal);
    const readState = tracker.check(
      canonicalPath,
      preEditRead.ok ? fileContentHash(preEditRead.content) : null,
    );
    const dispatched = await dispatchRegisteredTool(
      editFileSpec,
      {
        path: editPath,
        old_string: editInput.old_string,
        new_string: editInput.new_string ?? '',
        replace_all: editInput.replace_all,
      },
      {
        workspace,
        threadId,
        signal,
        allowExternalPaths: allowExternal,
        writeTarget: { path: editPath, readState },
        protectedPathEvaluator,
      },
    );
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: `edit_file ${editPath}`,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    // preExecute 已通过，在工作区变更前记录原像供 /rewind 恢复
    safeRecordPreimage(
      input.recordFilePreimage,
      editPath,
      preEditRead.ok ? preEditRead.content : null,
      preEditRead.ok,
    );
    const result = dispatched.output;
    if (result.ok && result.content !== undefined) {
      safeRecordPostimage(input.recordFilePreimage, editPath, result.content, true);
      tracker.record(canonicalPath, fileContentHash(result.content));
    }
    return withFailureGuidance(request, {
      ok: dispatched.projected.ok,
      command: `edit_file ${editInput.path ?? ''}`,
      exitCode: dispatched.projected.ok ? 0 : -1,
      stdout: dispatched.projected.ok ? dispatched.projected.modelContent : '',
      stderr: dispatched.projected.ok ? '' : dispatched.projected.modelContent,
      path: editInput.path,
      resultMeta: dispatched.projected.resultMeta,
    });
  }

  if (request.name === 'write_file') {
    const writeInput = request.args;
    const filePath = writeInput.path;
    const content = writeInput.content;
    const isExternal = isExternalPathArg(filePath);
    const allowExternal = hasExecutionGrant && isExternal;

    // 写入前读取旧内容，用于生成 diff / Read old content before writing for diff
    const oldRead = readTextContent(workspace, filePath, { allowExternal });
    const oldExisted = oldRead.ok;

    // ADR-0042 §4：覆写前捕获原像（复用上面已读取的旧内容，零额外 I/O）
    // Capture pre-image before overwrite (reuses oldRead, zero extra I/O).
    safeRecordPreimage(
      input.recordFilePreimage,
      filePath,
      oldRead.ok ? oldRead.content : null,
      oldRead.ok,
    );

    // 已迁入 ToolSpec Registry（ADR-0043 S1.2，含 ADR-0042 §2 append 移除）：
    // 执行经 dispatchRegisteredTool；mode 不再存在，创建/覆写统一语义。
    const dispatched = await dispatchRegisteredTool(
      writeFileSpec,
      { path: filePath, content },
      {
        workspace,
        threadId,
        signal,
        allowExternalPaths: allowExternal,
        writeTarget: {
          path: filePath,
          previousContent: oldRead.ok ? oldRead.content : undefined,
          existed: oldExisted,
        },
        protectedPathEvaluator,
      },
    );
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: `write_file ${filePath}`,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const result = dispatched.output;
    if (result.ok) {
      safeRecordPostimage(input.recordFilePreimage, filePath, normalizeEOL(content), true);
      // ADR-0042 §1 读取状态记录：写入成功后模型持有全部内容，等价于一次读取。
      // 哈希取换行正规化后的文本，与后续 read_file 回读指纹一致。
      sessionReadTracker(threadId || workspace).record(
        canonicalFilePath(workspace, filePath, allowExternal),
        fileContentHash(normalizeEOL(content)),
      );
    }

    return withFailureGuidance(request, {
      ok: dispatched.projected.ok,
      command: `write_file ${filePath}`,
      exitCode: dispatched.projected.ok ? 0 : -1,
      stdout: dispatched.projected.ok ? dispatched.projected.modelContent : '',
      stderr: dispatched.projected.ok ? '' : dispatched.projected.modelContent,
      path: filePath,
      resultMeta: dispatched.projected.resultMeta,
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
    const searchInput = request.args;
    const searchPath = searchInput.path ?? '.';
    const isExternal = isExternalPathArg(searchPath);
    const allowExternal = hasExecutionGrant && isExternal;
    // 已迁入 ToolSpec Registry（ADR-0043 S1.2）：执行经 dispatchRegisteredTool，
    // 截断与 resultMeta 组装保持与旧路径字节一致。
    const dispatched = await dispatchRegisteredTool(
      searchContentSpec,
      { pattern: searchInput.pattern, path: searchPath, glob: searchInput.glob },
      {
        workspace,
        threadId,
        signal,
        allowExternalPaths: allowExternal,
        protectedPathEvaluator,
      },
    );
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: `search_content ${searchInput.pattern}`,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const projected = dispatched.projected;
    return withFailureGuidance(request, {
      ...dispatched.output,
      // 双输出流工具消费逐流投影：失败时 stdout/stderr 两路保留（迁移前语义）。
      stdout: projected.streams?.stdout ?? (projected.ok ? projected.modelContent : ''),
      stderr: projected.streams?.stderr ?? (projected.ok ? '' : projected.modelContent),
      command: `search_content ${searchInput.pattern}`,
      resultMeta: projected.resultMeta,
    });
  }

  if (request.name === 'search_files') {
    const searchInput = request.args;
    const searchPath = searchInput.path ?? '.';
    const isExternal = isExternalPathArg(searchPath);
    const allowExternal = hasExecutionGrant && isExternal;
    // 已迁入 ToolSpec Registry（ADR-0043 S1.2）：执行经 dispatchRegisteredTool，
    // 截断与 resultMeta 组装保持与旧路径字节一致。
    const dispatched = await dispatchRegisteredTool(
      searchFilesSpec,
      { pattern: searchInput.pattern, path: searchPath },
      {
        workspace,
        threadId,
        signal,
        allowExternalPaths: allowExternal,
        protectedPathEvaluator,
      },
    );
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: `search_files ${searchInput.pattern}`,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const projected = dispatched.projected;
    return withFailureGuidance(request, {
      ...dispatched.output,
      // 双输出流工具消费逐流投影：失败时 stdout/stderr 两路保留（迁移前语义）。
      stdout: projected.streams?.stdout ?? (projected.ok ? projected.modelContent : ''),
      stderr: projected.streams?.stderr ?? (projected.ok ? '' : projected.modelContent),
      command: `search_files ${searchInput.pattern}`,
      resultMeta: projected.resultMeta,
    });
  }

  if (request.name === 'list_mcp_resources') {
    if (networkBoundaryPolicy) {
      return ungovernedMcpNetworkResult(request, networkBoundaryPolicy);
    }
    const dispatched = await dispatchRegisteredTool(listMcpResourcesSpec, request.args, {
      workspace,
      threadId,
      signal,
      mcpManager,
      protectedPathEvaluator,
    });
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const projected = dispatched.projected;
    return withFailureGuidance(request, {
      ok: projected.ok,
      command: request.protectedCommand,
      exitCode: projected.ok ? 0 : -1,
      // 消费逐流投影：MCP 清单 spec 产出模型就绪文本，
      // 失败时结构化载荷保留在原流（如 list_mcp_tools 的 stale_cursor JSON）。
      stdout: projected.streams?.stdout ?? (projected.ok ? projected.modelContent : ''),
      stderr: projected.streams?.stderr ?? (projected.ok ? '' : projected.modelContent),
      resultMeta: projected.resultMeta,
    });
  }

  if (request.name === 'list_mcp_tools') {
    if (networkBoundaryPolicy) {
      return ungovernedMcpNetworkResult(request, networkBoundaryPolicy);
    }
    const dispatched = await dispatchRegisteredTool(listMcpToolsSpec, request.args, {
      workspace,
      threadId,
      signal,
      mcpManager,
      protectedPathEvaluator,
    });
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const projected = dispatched.projected;
    return withFailureGuidance(request, {
      ok: projected.ok,
      command: request.protectedCommand,
      exitCode: projected.ok ? 0 : -1,
      // 消费逐流投影：MCP 清单 spec 产出模型就绪文本，
      // 失败时结构化载荷保留在原流（如 list_mcp_tools 的 stale_cursor JSON）。
      stdout: projected.streams?.stdout ?? (projected.ok ? projected.modelContent : ''),
      stderr: projected.streams?.stderr ?? (projected.ok ? '' : projected.modelContent),
      resultMeta: projected.resultMeta,
    });
  }

  if (request.name === 'read_mcp_resource') {
    if (networkBoundaryPolicy) {
      return ungovernedMcpNetworkResult(request, networkBoundaryPolicy);
    }
    const dispatched = await dispatchRegisteredTool(readMcpResourceSpec, request.args, {
      workspace,
      threadId,
      signal,
      mcpManager,
      protectedPathEvaluator,
    });
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const command = `read_mcp_resource ${request.args.server ?? ''}`;
    const projected = dispatched.projected;
    return withFailureGuidance(request, {
      ok: projected.ok,
      command,
      exitCode: projected.ok ? 0 : -1,
      // 消费逐流投影：资源内容/错误保留在 execute 产出的原流。
      stdout: projected.streams?.stdout ?? (projected.ok ? projected.modelContent : ''),
      stderr: projected.streams?.stderr ?? (projected.ok ? '' : projected.modelContent),
      resultMeta: projected.resultMeta,
    });
  }

  if (isMcpRequest(request)) {
    if (networkBoundaryPolicy) {
      return ungovernedMcpNetworkResult(request, networkBoundaryPolicy);
    }
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
        arguments: request.args,
        ...(mcpInvocation.remoteEgress ? { remoteEgress: mcpInvocation.remoteEgress } : {}),
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
      if (isMcpProviderError(err) || err instanceof RemoteMcpEgressDeniedError) throw err;
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
    const dispatched = await dispatchRegisteredTool(webFetchSpec, request.args, {
      workspace,
      threadId,
      signal,
      toolCallId: request.id,
      networkBoundaryPolicy,
      recordNetworkDecision: input.recordNetworkDecision,
      protectedPathEvaluator,
    });
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const result = dispatched.output;
    return withFailureGuidance(request, {
      ok: result.ok,
      command: request.protectedCommand,
      exitCode: result.ok ? 0 : result.timedOut ? 124 : result.aborted ? 130 : -1,
      stdout: dispatched.projected.ok ? dispatched.projected.modelContent : '',
      stderr: dispatched.projected.ok ? '' : dispatched.projected.modelContent,
      resultMeta: dispatched.projected.resultMeta,
    });
  }

  if (request.name === 'shell_execute') {
    const networkMode = resolveShellNetworkMode(policy, hasExecutionGrant, networkBoundaryPolicy);
    const shellNetworkBroker =
      networkBoundaryPolicy && hasExecutionGrant && input.recordNetworkDecision && request.id
        ? {
            policy: networkBoundaryPolicy,
            toolCallId: request.id,
            recordDecision: input.recordNetworkDecision,
          }
        : undefined;
    const dispatched = await dispatchRegisteredTool(shellExecuteSpec, request.args, {
      workspace,
      signal,
      shellExecutor,
      shellNetworkMode: networkMode,
      shellNetworkBroker,
      onShellProgress: input.onShellProgress,
      protectedPathEvaluator,
    });
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.args.command,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const result = dispatched.output;
    const projected = dispatched.projected;
    return withFailureGuidance(request, {
      ...result,
      // 双输出流工具消费逐流投影：失败命令的 stdout 与成功命令的 stderr
      // 警告都保留（迁移前 Runner 对两路分别截断，现由 spec 投影承接）。
      stdout: projected.streams?.stdout ?? (projected.ok ? projected.modelContent : ''),
      stderr: projected.streams?.stderr ?? (projected.ok ? '' : projected.modelContent),
      resultMeta: projected.resultMeta,
      action: {
        intent: projectedShellIntent(projected.resultMeta),
        grantUsed: approvedGrant === 'none' ? policy.grantUsed : approvedGrant,
      },
    });
  }

  // Generic Registry dispatch for registered tools without a dedicated
  // branch.  Each spec is the sole source for availability, schema,
  // execution, and result projection (ADR-0043).
  const spec = builtinToolRegistry.get(request.name);
  if (spec && 'execute' in spec) {
    const dispatched = await dispatchRegisteredTool(spec, request.args, {
      workspace,
      threadId,
      signal,
      protectedPathEvaluator,
      allowExternalPaths: isExternalPathArg(
        String((request.args as Record<string, unknown>).path ?? ''),
      )
        ? hasExecutionGrant
        : undefined,
    });
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    return {
      ok: dispatched.projected.ok,
      command: request.protectedCommand,
      exitCode: dispatched.projected.ok ? 0 : -1,
      stdout: dispatched.projected.ok ? dispatched.projected.modelContent : '',
      stderr: dispatched.projected.ok ? '' : dispatched.projected.modelContent,
      resultMeta: dispatched.projected.resultMeta,
      ...(dispatched.projected.streams
        ? {
            stdout: dispatched.projected.streams.stdout,
            stderr: dispatched.projected.streams.stderr,
          }
        : {}),
    };
  }

  return {
    ok: false,
    command: 'unsupported_tool',
    exitCode: -1,
    stdout: '',
    stderr: 'Unsupported tool request.',
  };
}

function serializeMcpResultForModel(result: import('@/core/capabilities/result').CapabilityResult) {
  const serialized = JSON.stringify(result);
  if (serialized.length <= TOOL_RESULT_BUDGET_POLICY_V1.mcpModelResultMaxChars) {
    return { modelContent: serialized, truncated: false };
  }
  return {
    modelContent: JSON.stringify({
      status: 'partial',
      content: [
        {
          type: 'text',
          text: serialized.slice(0, TOOL_RESULT_BUDGET_POLICY_V1.mcpModelResultMaxChars),
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

function resolveShellNetworkMode(
  policy: ReturnType<typeof evaluateToolApproval>,
  hasExecutionGrant: boolean,
  networkBoundaryPolicy?: NetworkBoundaryPolicyV1,
): ShellNetworkMode {
  // No supported native backend can enforce a host allowlist for arbitrary
  // descendants yet. A sealed execution boundary therefore tightens process
  // networking to off instead of falling back to legacy allow_all.
  if (networkBoundaryPolicy) return 'disabled';
  const mayNeedNetwork = policy.effects?.network || policy.effects?.uncertainEffects;
  return mayNeedNetwork && hasExecutionGrant ? 'allow_all' : 'disabled';
}

function ungovernedMcpNetworkResult(
  request: PendingToolRequest,
  policy: NetworkBoundaryPolicyV1,
): ToolExecutionResult {
  return withFailureGuidance(request, {
    ok: false,
    command: request.protectedCommand,
    exitCode: -1,
    stdout: '',
    stderr:
      'MCP execution is unavailable under the sealed network boundary until its transport uses per-invocation endpoint admission.',
    status: 'rejected',
    resultMeta: {
      networkPolicyRevision: policy.revision,
      networkAdmissionDigests: [],
      networkFailureCode: 'controller_unavailable',
    },
  });
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
      return 'Use read_file with a relative path inside the workspace. If the path is uncertain, use search_files to locate it, then retry with the exact path.';
    case 'edit_file':
      return 'Use edit_file only after read_file. old_string must exactly match existing file content, including whitespace and indentation; if the same text appears multiple times, make old_string more specific or set replace_all: true.';
    case 'write_file':
      return 'Use write_file with a relative path and complete file content when creating or fully overwriting a file. For small changes to an existing file, prefer read_file followed by edit_file.';
    case 'shell_execute':
      return 'Use shell_execute with a concrete command. Read-only checks such as rg, ls, cat, or git status are classified from the command itself. Provide description to explain what the command does; commands needing approval enter the user approval flow automatically.';
    case 'ask_user':
      return 'Use ask_user only when progress is blocked by a focused clarification. Provide one concise question, concrete options, and allow free text when appropriate; the user_input node handles the interrupt.';
    case 'web_fetch':
      return 'Use web_fetch with a complete http/https URL. Verify the URL is public and accessible before calling. If fetch fails with HTTP error, the page may not exist or may be behind authentication. If readability fails, the page may not be a text article — try a different source.';
    default:
      return '';
  }
}
