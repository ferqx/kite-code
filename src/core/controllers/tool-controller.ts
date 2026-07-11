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

    // ── Plan tools ──

    if (request.name === 'write_plan') {
      const args = request.args as {
        title: string;
        body_markdown: string;
        steps: Array<{ id: string; title: string }>;
        expected_version?: number;
      };
      const phase = getAgentPhase(params.state.planning);
      if (phase !== 'planning') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'write_plan is only available in planning phase.',
        });
        continue;
      }
      // Version conflict check
      if (
        args.expected_version != null &&
        params.state.planning.kind === 'planning_draft' &&
        args.expected_version !== params.state.planning.document.version
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: `Version conflict: expected v${args.expected_version}, current is v${params.state.planning.document.version}.`,
        });
        continue;
      }
      // Emit plan.drafted — no interrupt
      events.push({
        type: 'plan.drafted',
        toolCallId,
        plan: {
          name: args.title,
          description: args.body_markdown,
          status: 'pending' as const,
          steps: args.steps.map((s) => ({ step: s.title, status: 'pending' as const })),
        },
        structuralHash: computePlanStructuralDigest({
          title: args.title,
          bodyMarkdown: args.body_markdown,
          steps: args.steps.map((s) => ({
            id: s.id,
            title: s.title,
            status: 'pending' as const,
          })),
        }),
      });
      continue;
    }

    if (request.name === 'exit_plan_mode') {
      const args = request.args as {
        plan_id: string;
        expected_version: number;
        expected_digest: string;
      };
      const phase = getAgentPhase(params.state.planning);
      if (phase !== 'planning') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'exit_plan_mode is only available in planning phase.',
        });
        continue;
      }
      // Must have a draft
      if (params.state.planning.kind !== 'planning_draft') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'No plan draft saved. Call write_plan first.',
        });
        continue;
      }
      const draft = params.state.planning.document;
      // Validate plan_id, version, digest
      if (
        args.plan_id !== draft.planId ||
        args.expected_version !== draft.version ||
        args.expected_digest !== draft.structuralDigest
      ) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: `Plan mismatch: expected plan_id=${args.plan_id} v${args.expected_version}, current is ${draft.planId} v${draft.version}.`,
        });
        continue;
      }
      const interactionId = genInteractionId();
      const plan: import('@/protocol/events').AgentPlan = {
        name: draft.title,
        description: draft.bodyMarkdown,
        status: 'pending',
        steps: draft.steps.map((s) => ({ step: s.title, status: s.status })),
      };
      events.push({
        type: 'plan.review_requested',
        interactionId,
        toolCallId,
        plan,
        planSummary: `${draft.title}\n\n${draft.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`,
      });
      continue;
    }

    if (request.name === 'update_plan') {
      const args = request.args as {
        plan_id: string;
        updates: Array<{ step_id: string; status: string; note?: string }>;
        complete_plan?: boolean;
      };
      const phase = getAgentPhase(params.state.planning);
      if (phase !== 'building') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'update_plan is only available in building phase after plan approval.',
        });
        continue;
      }
      if (params.state.planning.kind !== 'executing') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: 'No executing plan. Wait for plan approval first.',
        });
        continue;
      }
      const doc = params.state.planning.document;
      if (args.plan_id !== doc.planId) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: `Plan ID mismatch: expected ${args.plan_id}, current is ${doc.planId}.`,
        });
        continue;
      }
      const updatedPlan: import('@/protocol/events').AgentPlan = {
        name: doc.title,
        description: doc.bodyMarkdown,
        status: args.complete_plan ? 'completed' : 'in_progress',
        steps: doc.steps.map((s) => {
          const update = args.updates.find((u) => u.step_id === s.id);
          if (update) {
            return {
              step: s.title,
              status: update.status as 'pending' | 'in_progress' | 'completed',
            };
          }
          return { step: s.title, status: s.status as 'pending' | 'in_progress' | 'completed' };
        }),
      };
      events.push({
        type: 'plan.progress_updated',
        toolCallId,
        plan: updatedPlan,
      });
      if (args.complete_plan) {
        events.push({
          type: 'plan.completed',
          toolCallId,
          plan: updatedPlan,
        });
      }
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
