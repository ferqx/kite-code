import type { AgentConfig } from '@/core/config/index';
import { buildToolApproval } from '@/core/harness/tool-policy';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { McpManager } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import { evaluateToolApproval } from '@/core/policies/approval-policy';
import type { RuntimeEvent } from '@/core/runtime/events';
import { genInteractionId } from '@/core/runtime/ids';
import type { RuntimeState } from '@/core/runtime/state';
import { computePlanStructuralDigest, getAgentPhase } from '@/core/runtime/state';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { SubAgentEventSink } from '@/core/subagent/types';
import type { ShellExecutor } from '@/core/tools/shell';

type SubagentEvent = Parameters<SubAgentEventSink>[0];

/** Convert the subagent runner's private callback payload into a durable public fact. */
export function toRuntimeSubagentEvent(event: SubagentEvent): RuntimeEvent {
  switch (event.type) {
    case 'start':
      return { type: 'subagent.started', subagent: event.data };
    case 'step':
      return { type: 'subagent.step', subagent: event.data };
    case 'tool_result':
      return { type: 'subagent.tool_result', subagent: event.data };
    case 'done':
      return { type: 'subagent.completed', subagent: event.data };
    case 'error':
      return { type: 'subagent.failed', subagent: event.data };
    case 'cache_metrics':
      return { type: 'subagent.cache_metrics', subagent: event.data };
  }
}

/**
 * Kernel-native tool effect.  It derives the execution request from the
 * persisted call record and returns facts only; it never creates a ToolMessage
 * or mutates a graph channel.
 */
export async function executeRuntimeTools(params: {
  state: RuntimeState;
  toolCallIds: string[];
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  subagentEventSink?: SubAgentEventSink;
}): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const emitSubagentEvent: SubAgentEventSink = (event) => {
    events.push(toRuntimeSubagentEvent(event));
    params.subagentEventSink?.(event);
  };
  for (const toolCallId of params.toolCallIds) {
    const call = params.state.tools.calls[toolCallId];
    if (!call || (call.status !== 'queued' && call.status !== 'approved')) continue;
    const request = toolRequestFromCall(
      { id: call.toolCallId, name: call.name, args: (call.args ?? {}) as Record<string, unknown> },
      params.state.session.workspace,
    );
    if (!request) {
      events.push({ type: 'tool.failed', toolCallId, error: `Unsupported tool '${call.name}'.` });
      continue;
    }
    if (request.name === 'ask_user') {
      events.push({
        type: 'user_input.requested',
        interactionId: genInteractionId(),
        toolCallId,
        request: request.args,
      });
      continue;
    }
    if (request.name === 'update_plan') {
      const plan = request.args;
      const interactionId = genInteractionId();
      events.push({
        type: 'plan.drafted',
        toolCallId,
        plan,
        structuralHash: computePlanStructuralDigest({
          title: plan.name.slice(0, 120),
          bodyMarkdown: plan.description,
          steps: plan.steps.map((s: { step: string; status: string }) => ({
            id: s.step
              .toLowerCase()
              .replace(/[^a-z0-9_-]+/g, '-')
              .slice(0, 32),
            title: s.step.slice(0, 160),
            status: 'pending' as const,
          })),
        }),
      });
      events.push({
        type: 'plan.review_requested',
        interactionId,
        toolCallId,
        plan,
        planSummary: `${plan.description}\n\n${plan.steps.map((step, index) => `${index + 1}. ${step.step}`).join('\n')}`,
      });
      continue;
    }

    const decision = evaluateToolApproval({
      toolName: request.name,
      toolArgs: request.args as Record<string, unknown>,
      phase: getAgentPhase(params.state.planning),
      workspace: params.state.session.workspace,
      threadId: params.state.session.threadId,
      authorization: params.state.authorization,
    });
    if (!decision.allowed) {
      events.push({ type: 'tool.rejected', toolCallId, reason: decision.userVisibleSummary });
      continue;
    }
    if (decision.requiresApproval && call.status !== 'approved') {
      const approval = buildToolApproval({
        workspace: params.state.session.workspace,
        threadId: params.state.session.threadId,
        request,
        decision,
      }) as unknown as import('@/protocol/events').ToolApprovalPayload;

      // auto mode: use auto-review for non-destructive tools (unless circuit breaker tripped)
      if (
        params.state.mode === 'auto' &&
        decision.risk !== 'destructive' &&
        !params.state.autoReview.circuitBreakerTripped
      ) {
        events.push({
          type: 'auto_review.requested',
          reviewId: genInteractionId(),
          toolCallId,
          toolName: request.name,
          reason: decision.reason,
          approval,
        });
      } else {
        events.push({
          type: 'approval.requested',
          interactionId: genInteractionId(),
          toolCallId,
          approval,
        });
      }
      continue;
    }

    events.push({ type: 'tool.started', toolCallId });
    const progress: RuntimeEvent[] = [];
    try {
      const result = await runApprovedTool({
        workspace: params.state.session.workspace,
        request,
        shellExecutor: params.shellExecutor,
        workspaceAccess: params.state.workspaceAccess,
        phase: getAgentPhase(params.state.planning),
        authorization: params.state.authorization,
        approvedGrant: call.approvalGrant ?? 'none',
        threadId: params.state.session.threadId,
        mcpManager: params.mcpManager,
        skillManifests: params.skillManifests,
        skillOptions: params.skillOptions,
        signal: params.signal,
        interactionMode: params.state.mode,
        taskConfig: params.taskConfig,
        taskModel: params.taskModel,
        subagentEventSink: emitSubagentEvent,
        onShellProgress: (chunk, stream) =>
          progress.push({ type: 'tool.progress', toolCallId, chunk, stream }),
      });
      events.push(...progress);

      // 文件变更事件 — write_file / edit_file 的结果通知 TUI
      // File change event — notify TUI of write_file / edit_file results
      if (result.ok !== false && (request.name === 'write_file' || request.name === 'edit_file')) {
        const filePath = String((request.args as Record<string, unknown>).path ?? '');
        if (filePath) {
          events.push({
            type: 'tool.file_change',
            toolCallId,
            path: filePath,
            kind: request.name === 'edit_file' ? 'edit' : 'add',
            preview: (result.stdout ?? result.stderr ?? '').slice(0, 500) || undefined,
          });
        }
      }

      events.push({
        type: 'tool.finished',
        toolCallId,
        name: request.name,
        result: {
          ok: result.ok !== false,
          command: result.command ?? request.protectedCommand,
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          status:
            result.status === 'exhausted' ? 'exhausted' : result.ok === false ? 'error' : 'success',
        },
      });
    } catch (error) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return events;
}
