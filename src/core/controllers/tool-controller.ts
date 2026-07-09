import { ToolMessage } from '@langchain/core/messages';
import type { AgentConfig } from '@/core/config/index';
import { isFingerprintExhausted } from '@/core/execution/journal';
import type { PermitBatch } from '@/core/execution/permit';
import type { ToolExecutionSideEffects } from '@/core/harness/tool-result';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { McpManager } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink, SubAgentResult } from '@/core/subagent/types';
import type { ShellExecutor } from '@/core/tools/shell';
import type { AuthorizationOverride, ThreadAuthorizationState } from '@/core/types';
import type {
  AgentPhase,
  InteractionMode,
  ShellGrantUsed,
  WorkspaceAccess,
} from '@/protocol/events';

/** Preflight guard result / 预检守卫结果 */
export interface PreflightGuardResult {
  blocked: boolean;
  toolMessage?: ToolMessage;
}

/**
 * Check if a tool call is blocked by the exhaustion preflight guard.
 * If blocked, emits tool.finished RuntimeEvent and returns a blocked ToolMessage.
 *
 * 检查工具调用是否被耗尽预检守卫阻止。
 * 如果被阻止，发出 tool.finished 运行时事件并返回一个被阻止的 ToolMessage。
 */
export function preflightExhaustionCheck(params: {
  requestName: string;
  requestId: string;
  requestArgs: Record<string, unknown>;
  protectedCommand: string;
  exhaustedFingerprints: Record<string, true>;
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
}): PreflightGuardResult {
  const preflightPath = params.requestArgs.path as string | undefined;
  if (!isFingerprintExhausted(params.exhaustedFingerprints, params.requestName, preflightPath)) {
    return { blocked: false };
  }

  const stderr = `Execution blocked: too many repeated failures for ${params.requestName}${preflightPath ? ` on ${preflightPath}` : ''}.`;

  const toolMessage = new ToolMessage({
    content: JSON.stringify({
      ok: false,
      command: params.protectedCommand,
      exitCode: -1,
      stdout: '',
      stderr,
      status: 'exhausted' as const,
      failure: {
        message: 'Tool execution failed.' as const,
        tool: params.requestName,
        reason: `Execution blocked by exhaustion guard for ${params.requestName}.`,
        guidance: 'Stop retrying this operation. Skip this step, replan, or safely finalize.',
      },
    }),
    tool_call_id: params.requestId || 'missing-tool-call-id',
    name: params.requestName,
    status: 'exhausted' as unknown as ToolMessage['status'],
  });

  params.emitRuntimeEvent?.({
    type: 'tool.finished',
    toolCallId: params.requestId,
    name: params.requestName,
    result: {
      ok: false,
      command: params.protectedCommand,
      exitCode: -1,
      stdout: '',
      stderr,
      status: 'exhausted',
    },
  });

  return { blocked: true, toolMessage };
}

/** executeTool 输入参数 / Input for executeTool */
export interface ExecuteToolParams {
  workspace: string;
  request: { id?: string; name: string; args: Record<string, unknown>; protectedCommand: string };
  shellExecutor?: ShellExecutor;
  workspaceAccess: WorkspaceAccess;
  phase: AgentPhase;
  authorization: ThreadAuthorizationState | null;
  approvedGrant: ShellGrantUsed;
  threadId: string;
  override?: AuthorizationOverride;
  mcpManager?: McpManager;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  signal?: AbortSignal;
  permitBatch?: PermitBatch;
  interactionMode: InteractionMode;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  subagentEventSink?: SubAgentEventSink;
  onShellProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** 运行时事件回调 — RuntimeEvent 是唯一 TUI 通知路径 */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  pendingWarnings?: Record<string, string>;
  mcpRiskOverride?: Record<string, 'read'>;
}

/**
 * 执行工具调用的薄封装 — 包装 runApprovedTool，在其返回后发出
 * tool.finished RuntimeEvent，并构造 ToolMessage 与副作用。
 *
 * Thin wrapper around runApprovedTool that emits tool.finished RuntimeEvent
 * after execution, then constructs ToolMessage and side effects.
 *
 * RuntimeEvent 是唯一 TUI 通知路径 — 不再使用 toolResultSink 双写。
 * RuntimeEvent is the sole TUI notification path — no more toolResultSink dual-write.
 */
export async function executeTool(params: ExecuteToolParams): Promise<{
  toolMessage: ToolMessage | null;
  sideEffects: ToolExecutionSideEffects;
  /** 子 agent 工具被阻塞时的信息（仅 'task' 工具）/ Subagent blocking info (only for 'task' tool) */
  subagentBlocked?: NonNullable<SubAgentResult['blocked']>;
}> {
  let result: Awaited<ReturnType<typeof runApprovedTool>>;
  try {
    result = await runApprovedTool({
      workspace: params.workspace,
      request: params.request as import('@/core/harness/tool-requests').PendingToolRequest,
      shellExecutor: params.shellExecutor,
      workspaceAccess: params.workspaceAccess,
      phase: params.phase,
      authorization: params.authorization,
      approvedGrant: params.approvedGrant,
      threadId: params.threadId,
      override: params.override,
      mcpManager: params.mcpManager,
      mcpRiskOverride: params.mcpRiskOverride,
      skillManifests: params.skillManifests,
      skillOptions: params.skillOptions,
      signal: params.signal,
      permitBatch: params.permitBatch,
      interactionMode: params.interactionMode,
      taskConfig: params.taskConfig,
      taskModel: params.taskModel,
      subagentEventSink: params.subagentEventSink,
      onShellProgress: params.onShellProgress,
    });
  } catch (error) {
    params.emitRuntimeEvent?.({
      type: 'tool.failed',
      toolCallId: params.request.id ?? '',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // 子 agent 阻塞 — 不发出 tool.finished，返回阻塞信息供调用方处理
  // Subagent blocked — don't emit tool.finished, return blocking info for caller
  if (params.request.name === 'task' && result.subagentResult?.blocked) {
    return {
      toolMessage: null,
      sideEffects: {} as ToolExecutionSideEffects,
      subagentBlocked: result.subagentResult.blocked,
    };
  }

  // 发出 RuntimeEvent — 唯一 TUI 通知路径 / Emit RuntimeEvent — sole TUI notification path
  params.emitRuntimeEvent?.({
    type: 'tool.finished',
    toolCallId: params.request.id ?? '',
    name: params.request.name,
    result: {
      ok: result.ok !== false,
      command: params.request.protectedCommand ?? '',
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    },
  });

  const toolMessage = new ToolMessage({
    content: JSON.stringify(result),
    tool_call_id: params.request.id ?? 'missing-tool-call-id',
    name: params.request.name,
    status: result.ok === false ? 'error' : 'success',
  });

  const sideEffects: ToolExecutionSideEffects = {
    plan: result.plan,
    workspaceAccess: result.workspaceAccess,
    authorization: result.authorization,
    activeSkillInstructions: result.activeSkillInstructions,
  };

  return { toolMessage, sideEffects };
}
