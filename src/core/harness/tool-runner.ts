import { createHash } from 'node:crypto';
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
import type { RuntimeEvent } from '@/core/runtime/events';
import type { FilePreimageRecorder } from '@/core/runtime/file-checkpoints';
import { DescendantResourceAdmissionError } from '@/core/runtime/resource-budget-admission';
import { isDescriptorAdmittedByExecutionCapabilitySurfaceV1 } from '@/core/sandbox/execution-capability-surface';
import type { NetworkDecisionRecorderV1 } from '@/core/sandbox/network-enforcer';
import {
  type NetworkBoundaryPolicyV1,
  networkBoundaryPolicyFromExecutionBoundaryV1,
} from '@/core/sandbox/network-policy';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import { validateDelegatedTaskV1 } from '@/core/subagent/delegation-contract';
import { runTaskSubAgent } from '@/core/subagent/task-tool';
import type { SubAgentEventSink } from '@/core/subagent/types';
import { normalizeEOL, readTextContent, resolvePath } from '@/core/tools/file';
import { msys2ToWindowsPath } from '@/core/tools/path-utils';
import { fileContentHash, sessionReadTracker } from '@/core/tools/read-state';
import { builtinToolRegistry } from '@/core/tools/registry/builtins';
import { projectedShellIntent } from '@/core/tools/registry/builtins/shell-execute';
import { taskSpec } from '@/core/tools/registry/builtins/task';
import {
  dispatchRegisteredTool,
  evaluateRegisteredToolProtectedPaths,
} from '@/core/tools/registry/dispatch';
import type { ToolAvailabilityContext, ToolExecutionContext } from '@/core/tools/registry/spec';
import type { ShellExecutor } from '@/core/tools/shell';
import { normalizeToolContract } from '@/core/tools/tool-contracts';
import type {
  AuthorizationOverride,
  ShellFilesystemMode,
  ShellNetworkMode,
  ThreadAuthorizationState,
} from '@/core/types';
import type { AgentPhase, ShellGrantUsed, WorkspaceAccess } from '@/protocol/events';
import { BROKERED_GIT_FEATURE_REVISION_V1 } from '@/protocol/git';
import { defaultPhaseForWorkspaceAccess, normalizeAuthorizationState } from './tool-policy';
import { isMcpRequest, type PendingToolRequest } from './tool-requests';
import type { ToolExecutionResult } from './tool-result';

const BROKERED_GIT_EXECUTABLE_TOKEN_V1 =
  /(?:^|[\s"'`;&|()=,])(?:(?:[a-z]:)?[\\/][^\s"'`;&|()=,]*[\\/])?git(?:\.exe)?(?=$|[\s"'`;&|()=,])/iu;

/** Conservative command-language scan: uncertainty is denied before shell dispatch. */
export function containsBrokeredGitInvocationV1(command: string): boolean {
  return BROKERED_GIT_EXECUTABLE_TOKEN_V1.test(command);
}

/** Rebuild the ordinary execution result for a resumed Task that already completed. */
export function completedTaskExecutionResult(input: {
  workspace: string;
  subagentType: Parameters<typeof taskSpec.projectResult>[1]['invocationInput']['subagent_type'];
  task: string;
  result: import('@/core/subagent/types').SubAgentResult;
}): ToolExecutionResult {
  const projected = taskSpec.projectResult(
    { available: true, result: input.result },
    {
      workspace: input.workspace,
      invocationInput: { subagent_type: input.subagentType, task: input.task },
    },
  );
  return {
    ok: projected.ok,
    command: 'task',
    exitCode: projected.ok ? 0 : -1,
    stdout: projected.ok ? projected.modelContent : '',
    stderr: projected.ok ? '' : projected.modelContent,
    resultMeta: projected.resultMeta,
    status: projected.ok ? 'success' : 'error',
    ...(projected.outcomeAdviceV1 ? { classifierAdviceV1: projected.outcomeAdviceV1 } : {}),
    ...(projected.classifierDiagnostic
      ? { classifierDiagnostic: projected.classifierDiagnostic }
      : {}),
  };
}

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
function isExternalPathArg(workspace: string, pathArg: string): boolean {
  const normalized = msys2ToWindowsPath(pathArg);
  if (normalized.startsWith('~')) return true;
  try {
    resolvePath(workspace, normalized, { allowExternal: false });
    return false;
  } catch {
    return true;
  }
}

/** Production capability surfaces reject every path that does not resolve
 * inside the canonical workspace, including relative traversal and symlink
 * escape. Keep this separate from isExternalPathArg: the latter is the legacy
 * approval-shape predicate, while this is a fail-closed execution ceiling. */
function isOutsideProductionWorkspace(workspace: string, pathArg: string): boolean {
  if (!pathArg) return false;
  if (isExternalPathArg(workspace, pathArg)) return true;
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

/** invokeGovernedTool 输入参数 / Input for invokeGovernedTool */
export interface GovernedToolInvocationInput {
  workspace: string;
  request: PendingToolRequest;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@/core/git/broker').GitBrokerV1;
  workspaceAccess?: WorkspaceAccess;
  phase?: AgentPhase;
  authorization?: ThreadAuthorizationState | null;
  approvedGrant?: ShellGrantUsed;
  threadId?: string;
  /** Stable actor identity for read-before-edit isolation. Parent calls omit it. */
  readStateActorId?: string;
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
  /** Parent Runtime canonical-private recovery identity inherited by task subagents. */
  recoveryIdentityKey?: string;
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
  /** Runtime-owned inputs for coordination and Runtime-action ToolSpecs. */
  toolSearch?: ToolExecutionContext['toolSearch'];
  skillRuntime?: ToolExecutionContext['skillRuntime'];
  planRuntime?: ToolExecutionContext['planRuntime'];
}

function runtimeEventsFromToolOutput(output: unknown): RuntimeEvent[] | undefined {
  if (typeof output !== 'object' || output === null || !('runtimeEvents' in output)) {
    return undefined;
  }
  const runtimeEvents = (output as { runtimeEvents?: unknown }).runtimeEvents;
  return Array.isArray(runtimeEvents) ? (runtimeEvents as RuntimeEvent[]) : undefined;
}

/** 执行经过审批的工具调用 / Execute an approved tool call */
export async function invokeGovernedTool(
  input: GovernedToolInvocationInput,
): Promise<ToolExecutionResult> {
  const {
    workspace,
    request,
    shellExecutor,
    gitBroker,
    workspaceAccess = 'write',
    phase = defaultPhaseForWorkspaceAccess(workspaceAccess),
    authorization = null,
    approvedGrant = 'none',
    threadId = '',
    readStateActorId,
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
    recoveryIdentityKey,
    providerDataAdmission,
    descendantResourceAdmission,
    beforeDispatch,
    subagentEventSink,
    availabilityContext,
    projectInstructionSnapshot,
    toolSearch,
    skillRuntime,
    planRuntime,
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
  if (request.name === 'task') {
    const validation = validateDelegatedTaskV1({
      delegatedTask: request.args.task,
    });
    if (!validation.valid) {
      return withFailureGuidance(request, {
        ok: false,
        command: 'task',
        exitCode: -1,
        stdout: '',
        stderr: `Sub-agent task rejected (${validation.reason}).`,
        status: 'rejected',
      });
    }
  }
  if (builtinSpec && protectedPathEvaluator) {
    const pathDecision = evaluateRegisteredToolProtectedPaths(builtinSpec, request.args, {
      workspace,
      threadId,
      protectedPathEvaluator,
      gitBroker,
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
  if (
    request.name === 'shell_execute' &&
    taskConfig &&
    getFeatureFlags(taskConfig).brokeredGitV1 &&
    executionSurface?.brokeredGitFeatureRevision === BROKERED_GIT_FEATURE_REVISION_V1 &&
    containsBrokeredGitInvocationV1(request.args.command)
  ) {
    const remoteOperation = /\b(?:fetch|pull|push|clone|ls-remote)\b/iu.test(request.args.command);
    return withFailureGuidance(request, {
      ok: false,
      command: request.protectedCommand,
      exitCode: -1,
      stdout: '',
      stderr: remoteOperation
        ? 'Remote Git is deferred until a governed network and credential capability is available.'
        : 'Git through shell_execute is denied by the brokered Git boundary. Use git_inspect for local status, diff, log, or branches.',
      status: 'rejected',
      resultMeta: remoteOperation
        ? { gitFailureCode: 'managed_network_setup_required' }
        : { nextCapability: 'git_inspect' },
    });
  }
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
      approvalRoute:
        mcpPolicy?.minimumApproval !== 'user' && modeDecision.kind === 'need_auto_review'
          ? 'auto_review'
          : 'user',
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

  const pathArgument = String((request.args as Record<string, unknown>).path ?? '');
  const allowExternalPaths = pathArgument
    ? isExternalPathArg(workspace, pathArgument) && hasExecutionGrant
    : false;
  const readTracker = sessionReadTracker(threadId || workspace, readStateActorId);
  let fileBeforeWrite: ReturnType<typeof readTextContent> | undefined;
  const executionContext: ToolExecutionContext = {
    ...(availabilityContext ?? {}),
    workspace,
    threadId,
    toolCallId: request.id,
    signal,
    gitBroker,
    protectedPathEvaluator,
    toolSearch,
    skillRuntime,
    planRuntime,
    mcpManager,
    phase,
    allowExternalPaths,
    networkBoundaryPolicy,
    recordNetworkDecision: input.recordNetworkDecision,
  };

  if (request.name === 'task') {
    executionContext.runTask =
      taskConfig && subagentEventSink
        ? (taskInput) =>
            runTaskSubAgent(
              {
                config: taskConfig,
                workspace,
                shellExecutor,
                gitBroker,
                mcpManager,
                skills: skillManifests,
                skillOptions,
                authorization: normalizeAuthorizationState(authorization),
                workspaceAccess,
                phase,
                interactionMode,
                projectInstructions: projectInstructionSnapshot,
                threadId,
                recoveryIdentityKey,
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
  }

  if (request.name === 'edit_file') {
    if (!request.args.old_string) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: 'edit_file requires old_string to locate the text to replace.',
      });
    }
    const editPath = request.args.path;
    fileBeforeWrite = readTextContent(workspace, editPath, {
      allowExternal: allowExternalPaths,
    });
    const canonicalPath = canonicalFilePath(workspace, editPath, allowExternalPaths);
    executionContext.writeTarget = {
      path: editPath,
      readState: readTracker.check(
        canonicalPath,
        fileBeforeWrite.ok ? fileContentHash(fileBeforeWrite.content) : null,
      ),
    };
    executionContext.beforeExecute = () =>
      safeRecordPreimage(
        input.recordFilePreimage,
        editPath,
        fileBeforeWrite?.ok ? fileBeforeWrite.content : null,
        fileBeforeWrite?.ok === true,
      );
  } else if (request.name === 'write_file') {
    const filePath = request.args.path;
    fileBeforeWrite = readTextContent(workspace, filePath, {
      allowExternal: allowExternalPaths,
    });
    executionContext.writeTarget = {
      path: filePath,
      previousContent: fileBeforeWrite.ok ? fileBeforeWrite.content : undefined,
      existed: fileBeforeWrite.ok,
    };
    executionContext.beforeExecute = () =>
      safeRecordPreimage(
        input.recordFilePreimage,
        filePath,
        fileBeforeWrite?.ok ? fileBeforeWrite.content : null,
        fileBeforeWrite?.ok === true,
      );
  } else if (request.name === 'shell_execute') {
    executionContext.shellExecutor = shellExecutor;
    executionContext.shellNetworkMode = resolveShellNetworkMode(policy, hasExecutionGrant);
    executionContext.shellFilesystemMode = resolveShellFilesystemMode(policy, hasExecutionGrant);
    executionContext.onShellProgress = input.onShellProgress;
  }

  if (request.name === 'ask_user') {
    return withFailureGuidance(request, {
      ok: false,
      command: 'ask_user',
      exitCode: -1,
      stdout: '',
      stderr: 'ask_user must be handled by the user_input interrupt node.',
    });
  }

  if (
    networkBoundaryPolicy &&
    (isMcpRequest(request) ||
      request.name === 'list_mcp_resources' ||
      request.name === 'list_mcp_tools' ||
      request.name === 'read_mcp_resource')
  ) {
    return ungovernedMcpNetworkResult(request, networkBoundaryPolicy);
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

  // Every executable builtin reaches the same Registry dispatch and result mapper.
  if (builtinSpec && 'execute' in builtinSpec) {
    let dispatched: Awaited<ReturnType<typeof dispatchRegisteredTool>>;
    try {
      dispatched = await dispatchRegisteredTool(builtinSpec, request.args, executionContext);
    } catch (error) {
      if (error instanceof DescendantResourceAdmissionError) throw error;
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        status: 'error',
      });
    }
    if (!dispatched.dispatched) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: dispatched.rejection.error,
      });
    }
    const output = dispatched.output as Record<string, unknown>;
    if (request.name === 'task' && output.available === false) {
      return withFailureGuidance(request, {
        ok: false,
        command: request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: typeof output.error === 'string' ? output.error : 'Sub-agent is unavailable.',
        status: 'error',
      });
    }

    if (
      request.name === 'read_file' &&
      output.ok === true &&
      typeof output.rawContent === 'string'
    ) {
      readTracker.record(
        canonicalFilePath(workspace, request.args.path, allowExternalPaths),
        fileContentHash(output.rawContent),
      );
    } else if (
      request.name === 'edit_file' &&
      output.ok === true &&
      typeof output.content === 'string'
    ) {
      safeRecordPostimage(input.recordFilePreimage, request.args.path, output.content, true);
      readTracker.record(
        canonicalFilePath(workspace, request.args.path, allowExternalPaths),
        fileContentHash(output.content),
      );
    } else if (request.name === 'write_file' && output.ok === true) {
      const content = normalizeEOL(request.args.content);
      safeRecordPostimage(input.recordFilePreimage, request.args.path, content, true);
      readTracker.record(
        canonicalFilePath(workspace, request.args.path, allowExternalPaths),
        fileContentHash(content),
      );
    }

    const projected = dispatched.projected;
    const terminationExitCode =
      projected.terminationReason === 'timed_out'
        ? 124
        : projected.terminationReason === 'cancelled'
          ? 130
          : -1;
    const rawExitCode = typeof output.exitCode === 'number' ? output.exitCode : undefined;
    const result: ToolExecutionResult = {
      ok: projected.ok,
      command: request.protectedCommand,
      exitCode: rawExitCode ?? (projected.ok ? 0 : terminationExitCode),
      stdout: projected.streams?.stdout ?? (projected.ok ? projected.modelContent : ''),
      stderr: projected.streams?.stderr ?? (projected.ok ? '' : projected.modelContent),
      resultMeta: projected.resultMeta,
      ...(typeof output.timedOut === 'boolean' ? { timedOut: output.timedOut } : {}),
      ...(typeof output.aborted === 'boolean' ? { aborted: output.aborted } : {}),
      ...(projected.terminationReason ? { terminationReason: projected.terminationReason } : {}),
      ...(projected.outcomeAdviceV1 ? { classifierAdviceV1: projected.outcomeAdviceV1 } : {}),
      ...(projected.classifierDiagnostic
        ? { classifierDiagnostic: projected.classifierDiagnostic }
        : {}),
      ...(runtimeEventsFromToolOutput(dispatched.output)
        ? { runtimeEvents: runtimeEventsFromToolOutput(dispatched.output) }
        : {}),
      ...(pathArgument ? { path: pathArgument } : {}),
      ...(typeof output.totalLines === 'number' ? { totalLines: output.totalLines } : {}),
      ...(request.name === 'task' && output.result
        ? { subagentResult: output.result as import('@/core/subagent/types').SubAgentResult }
        : {}),
      ...(request.name === 'shell_execute'
        ? {
            action: {
              intent: projectedShellIntent(projected.resultMeta),
              grantUsed: approvedGrant === 'none' ? policy.grantUsed : approvedGrant,
            },
          }
        : {}),
    };
    return withFailureGuidance(request, result);
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

function serializeMcpResultForModel(result: import('@/protocol/capabilities').CapabilityResult) {
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

function resolveShellNetworkMode(
  policy: ReturnType<typeof evaluateToolApproval>,
  hasExecutionGrant: boolean,
): ShellNetworkMode {
  const mayNeedNetwork = policy.effects?.network || policy.effects?.uncertainEffects;
  return mayNeedNetwork && hasExecutionGrant ? 'allow_all' : 'disabled';
}

function resolveShellFilesystemMode(
  policy: import('@/core/policies/approval-policy').ApprovalDecision,
  hasExecutionGrant: boolean,
): ShellFilesystemMode {
  if (!hasExecutionGrant) return 'workspace_only';
  return policy.effects?.externalRead ||
    policy.effects?.externalWrite ||
    policy.effects?.uncertainEffects
    ? 'allow_all'
    : 'workspace_only';
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

/** Single-source recovery guidance projected from the builtin ToolSpec contract. */
export function recoveryGuidanceForTool(toolName: string): string {
  const spec = builtinToolRegistry.get(toolName);
  return spec ? normalizeToolContract(spec.contract).recovery : '';
}

function toolUsageGuidance(request: PendingToolRequest): string {
  return recoveryGuidanceForTool(request.name);
}
