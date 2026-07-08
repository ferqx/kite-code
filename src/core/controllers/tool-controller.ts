import { ToolMessage } from '@langchain/core/messages';
import type { AgentConfig } from '@/core/config/index';
import type { PermitBatch } from '@/core/execution/permit';
import type { ToolExecutionSideEffects } from '@/core/harness/tool-result';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { McpManager } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import type { RuntimeEvent } from '@/core/runtime/events';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import type { ShellExecutor } from '@/core/tools/shell';
import type { AuthorizationOverride, ThreadAuthorizationState } from '@/core/types';
import type {
  AgentPhase,
  InteractionMode,
  ShellGrantUsed,
  WorkspaceAccess,
} from '@/protocol/events';

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
  toolResultSink?: (
    callId: string,
    toolName: string,
    ok: boolean,
    summary: string,
    totalLines?: number,
    toolTokenCount?: number,
    exitCode?: number,
    status?: string,
    reviewFailure?: string,
  ) => void;
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  pendingWarnings?: Record<string, string>;
  mcpRiskOverride?: Record<string, 'read'>;
}

/**
 * 执行工具调用的薄封装 — 包装 runApprovedTool，在其返回后统一发出
 * toolResultSink 和 tool.finished RuntimeEvent，并构造 ToolMessage 与副作用。
 *
 * Thin wrapper around runApprovedTool that emits toolResultSink and
 * tool.finished RuntimeEvent after execution, then constructs ToolMessage
 * and side effects.
 */
export async function executeTool(params: ExecuteToolParams): Promise<{
  toolMessage: ToolMessage | null;
  sideEffects: ToolExecutionSideEffects;
}> {
  const result = await runApprovedTool({
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

  // 与 graph.ts executeOneTool 保持一致：调用 toolResultSink 通知 TUI
  // Mirror graph.ts executeOneTool: invoke toolResultSink to notify TUI
  const summary =
    params.request.name === 'shell_execute' && result.exitCode === 124 && result.stdout
      ? result.stdout
      : (result.stdout || result.stderr || '').slice(0, 200);
  const reviewFailure = params.request.id ? params.pendingWarnings?.[params.request.id] : undefined;
  params.toolResultSink?.(
    params.request.id ?? '',
    params.request.name,
    result.ok !== false,
    summary,
    result.totalLines,
    undefined, // toolTokenCount — computed in runner's parseToolResultEvents
    result.exitCode,
    undefined, // status — determined by runner
    reviewFailure,
  );

  // 发出 RuntimeEvent（与 toolResultSink 并行，不替代）
  // Emit RuntimeEvent alongside toolResultSink, not replacing it
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
