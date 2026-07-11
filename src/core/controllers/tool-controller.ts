import type { AgentConfig } from '@/core/config/index';
import { buildToolApproval } from '@/core/harness/tool-policy';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import type { ToolExecutionResult } from '@/core/harness/tool-result';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { McpManager } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import { evaluateToolApproval } from '@/core/policies/approval-policy';
import { createModePolicy } from '@/core/policies/mode-policy';
import type { RuntimeEvent } from '@/core/runtime/events';
import { genInteractionId } from '@/core/runtime/ids';
import type { RuntimeState } from '@/core/runtime/state';
import { computePlanStructuralDigest, getAgentPhase } from '@/core/runtime/state';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import { resumeSubAgent } from '@/core/subagent/runner';
import type { SubAgentContinuation, SubAgentEventSink } from '@/core/subagent/types';
import type { ShellExecutor } from '@/core/tools/shell';

type SubagentEvent = Parameters<SubAgentEventSink>[0];

/** Pending sub-agent continuations keyed by the main agent's task toolCallId.
 *  When a sub-agent pauses for approval, the continuation is stored here.
 *  After approval (grant or reject), the kernel resumes or terminates the sub-agent. */
const pendingSubagentContinuations = new Map<string, SubAgentContinuation>();

/** Resolve a sub-agent continuation that was rejected (user denied the approval).
 *  Emits subagent.failed + tool.finished so the TUI transitions the sub-agent block
 *  from awaiting_approval to error, and the task tool produces a result for the model.
 *  Called by the runner after approval.rejected is processed. */
export function resolveRejectedSubagentContinuation(toolCallId: string): RuntimeEvent[] {
  const continuation = pendingSubagentContinuations.get(toolCallId);
  if (!continuation) return [];
  pendingSubagentContinuations.delete(toolCallId);

  const lastStep = continuation.steps[continuation.steps.length - 1];
  const blockedToolName = lastStep?.toolName ?? 'unknown';
  const subagentId = continuation.id;
  const rejectionMsg = `Sub-agent tool "${blockedToolName}" was rejected by user.`;

  return [
    {
      type: 'subagent.failed',
      subagent: {
        id: subagentId,
        error: rejectionMsg,
        summary: rejectionMsg,
        toolCallCount: continuation.toolCallCount,
        durationMs: 0,
      },
    } as RuntimeEvent,
    {
      type: 'tool.finished',
      toolCallId,
      name: 'task',
      result: {
        ok: false,
        command: '',
        exitCode: -1,
        stdout: '',
        stderr: rejectionMsg,
        status: 'error',
      },
    },
  ];
}

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
 * Resume a sub-agent after approval: execute the blocked tool with the
 * approved grant, then continue the sub-agent loop from the saved state.
 * Returns all RuntimeEvents produced by the resumed sub-agent execution.
 */
async function handleSubAgentResume(params: {
  state: RuntimeState;
  toolCallId: string;
  continuation: SubAgentContinuation;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  emitSubagentEvent: SubAgentEventSink;
}): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const { continuation } = params;
  const lastStep = continuation.steps[continuation.steps.length - 1];
  const blockedToolName = lastStep?.toolName ?? 'unknown';
  const blockedToolArgs = lastStep?.toolArgs ?? {};

  // Execute the previously-blocked tool with the approval grant
  const call = params.state.tools.calls[params.toolCallId];
  const blockedRequest = toolRequestFromCall(
    {
      id: params.toolCallId,
      name: blockedToolName,
      args: blockedToolArgs,
    },
    params.state.session.workspace,
  );

  let toolResult: ToolExecutionResult;
  if (blockedRequest) {
    toolResult = await runApprovedTool({
      workspace: params.state.session.workspace,
      request: blockedRequest,
      shellExecutor: params.shellExecutor,
      workspaceAccess: params.state.workspaceAccess,
      phase: getAgentPhase(params.state.planning),
      authorization: params.state.authorization,
      approvedGrant: call?.approvalGrant ?? 'none',
      threadId: params.state.session.threadId,
      mcpManager: params.mcpManager,
      skillManifests: params.skillManifests,
      skillOptions: params.skillOptions,
      signal: params.signal,
      taskConfig: params.taskConfig,
      taskModel: params.taskModel,
      subagentEventSink: params.emitSubagentEvent,
    });
  } else {
    toolResult = {
      ok: false,
      command: blockedToolName,
      exitCode: -1,
      stdout: '',
      stderr: `Failed to build tool request for "${blockedToolName}".`,
      status: 'error',
    };
  }

  // Resume the sub-agent with the tool result
  const result = await resumeSubAgent(
    {
      config: params.taskConfig!,
      workspace: params.state.session.workspace,
      role: continuation.role,
      task: continuation.task,
      shellExecutor: params.shellExecutor,
      mcpManager: params.mcpManager,
      skills: params.skillManifests,
      skillOptions: params.skillOptions,
      authorization: params.state.authorization,
      workspaceAccess: params.state.workspaceAccess,
      phase: getAgentPhase(params.state.planning),
      threadId: params.state.session.threadId,
      timeoutMs: 30 * 60 * 1000,
      signal: params.signal ?? new AbortController().signal,
      eventSink: params.emitSubagentEvent,
      model: params.taskModel,
      depth: 1,
      maxDepth: 0,
    },
    continuation,
    {
      toolCallId: `${continuation.id}-resume`,
      toolName: blockedToolName,
      result: toolResult,
    },
  );

  // Emit tool.finished for the task tool — the sub-agent has produced its final result
  const output = JSON.stringify(result);
  const ok = result.ok !== false;
  events.push({
    type: 'tool.finished',
    toolCallId: params.toolCallId,
    name: 'task',
    result: {
      ok,
      command: 'task',
      exitCode: ok ? 0 : -1,
      stdout: output,
      stderr: ok ? '' : output,
      status: ok ? ('success' as const) : ('error' as const),
    },
  });

  return events;
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
        action: 'save' | 'submit';
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
      const previous =
        params.state.planning.kind === 'planning_draft'
          ? params.state.planning.document
          : undefined;
      const document = {
        planId: previous?.planId ?? crypto.randomUUID(),
        version: (previous?.version ?? 0) + 1,
        title: args.title,
        bodyMarkdown: args.body_markdown,
        steps: args.steps.map(({ id, title }) => ({ id, title, status: 'pending' as const })),
        structuralDigest: '',
        createdAtTurnId: previous?.createdAtTurnId ?? params.state.turn.turnId,
        updatedAtTurnId: params.state.turn.turnId,
      };
      document.structuralDigest = computePlanStructuralDigest(document);
      const submit = args.action === 'submit';

      events.push({
        type: 'plan.drafted',
        toolCallId,
        planId: document.planId,
        version: document.version,
        plan: {
          name: document.title,
          description: document.bodyMarkdown,
          status: 'pending',
          steps: document.steps.map((step) => ({
            step: step.title,
            id: step.id,
            status: step.status,
          })),
        },
        structuralHash: document.structuralDigest,
      });

      if (submit) {
        // Emit review_requested — tool stays pending until user decision
        const interactionId = genInteractionId();
        events.push({
          type: 'plan.review_requested',
          interactionId,
          toolCallId,
          plan: {
            name: document.title,
            description: document.bodyMarkdown,
            status: 'pending',
            steps: document.steps.map((step) => ({
              step: step.title,
              id: step.id,
              status: step.status,
            })),
          },
          planSummary: `${document.title}\n\n${document.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`,
        });
        // Cancel later sibling tool calls
        for (const sibling of Object.values(params.state.tools.calls)) {
          if (
            sibling.status === 'queued' &&
            sibling.modelMessageId === call.modelMessageId &&
            (sibling.ordinal ?? 0) > (call.ordinal ?? 0)
          ) {
            events.push({
              type: 'tool.cancelled',
              toolCallId: sibling.toolCallId,
              reason: 'Cancelled because an earlier tool call opened an interaction.',
            });
          }
        }
      } else {
        // Save-only: finish tool call immediately
        events.push({
          type: 'tool.finished',
          toolCallId,
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'draft_saved',
              plan_id: document.planId,
              version: document.version,
              structural_digest: document.structuralDigest,
            }),
            stderr: '',
          },
        });
      }
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
      const unknownStep = args.updates.find(
        (update) => !doc.steps.some((step) => step.id === update.step_id),
      );
      if (unknownStep) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: `Unknown plan step ID: ${unknownStep.step_id}.`,
        });
        continue;
      }
      const plan = {
        name: doc.title,
        description: doc.bodyMarkdown,
        status: args.complete_plan ? ('completed' as const) : ('in_progress' as const),
        steps: doc.steps.map((step) => {
          const update = args.updates.find((candidate) => candidate.step_id === step.id);
          return {
            step: step.title,
            id: step.id,
            status: (update?.status ?? step.status) as
              | 'pending'
              | 'in_progress'
              | 'completed'
              | 'skipped',
            note: update?.note ?? step.note,
          };
        }),
      };
      events.push({
        type: 'plan.progress_updated',
        toolCallId,
        plan,
      });
      if (args.complete_plan) {
        events.push({
          type: 'plan.completed',
          toolCallId,
          plan,
        });
      }
      events.push({
        type: 'tool.finished',
        toolCallId,
        name: 'update_plan',
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            plan_id: doc.planId,
            updated_steps: args.updates.map((update) => update.step_id),
            plan_completed: args.complete_plan ?? false,
          }),
          stderr: '',
        },
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
    const requiresEffectReview =
      params.state.mode !== 'full' &&
      Boolean(
        decision.effects?.network ||
          decision.effects?.externalWrite ||
          decision.effects?.uncertainEffects,
      );
    if ((decision.requiresApproval || requiresEffectReview) && call.status !== 'approved') {
      // Delegate mode-specific routing to mode-policy
      const modePolicy = createModePolicy(params.state.mode);
      const modeDecision = modePolicy.shouldApproveTool({
        interactionMode: params.state.mode as 'accept_edits' | 'auto' | 'accept_edits' | 'full',
        phase: getAgentPhase(params.state.planning),
        planKind: params.state.planning.kind,
        toolName: request.name,
        toolRisk: decision.risk,
        effects: decision.effects,
        circuitBreakerTripped: params.state.autoReview.circuitBreakerTripped,
      });

      if (modeDecision.kind === 'deny') {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: modeDecision.reason ?? decision.userVisibleSummary,
        });
        continue;
      }

      if (modeDecision.kind === 'allow') {
        // Mode policy auto-approves this tool (e.g. accept_edits file edits, full_access)
        // Fall through to direct execution below
      } else if (modeDecision.kind === 'need_auto_review') {
        const approval = buildToolApproval({
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          request,
          decision,
        }) as unknown as import('@/protocol/events').ToolApprovalPayload;
        events.push({
          type: 'auto_review.requested',
          reviewId: genInteractionId(),
          toolCallId,
          toolName: request.name,
          reason: decision.reason,
          approval,
        });
        continue;
      } else {
        // need_tool_approval (default)
        const approval = buildToolApproval({
          workspace: params.state.session.workspace,
          threadId: params.state.session.threadId,
          request,
          decision,
        }) as unknown as import('@/protocol/events').ToolApprovalPayload;
        events.push({
          type: 'approval.requested',
          interactionId: genInteractionId(),
          toolCallId,
          approval,
        });
        continue;
      }
    }

    if (request.name === 'task') {
      // ── Sub-agent approval resume path ──
      // When a sub-agent paused for approval, the task tool call was set to
      // 'approved' by the reducer.  Instead of starting a fresh sub-agent,
      // execute the blocked tool with the approved grant and resume.
      const pendingCont = pendingSubagentContinuations.get(toolCallId);
      if (pendingCont && call.status === 'approved') {
        pendingSubagentContinuations.delete(toolCallId);
        const resumeEvents = await handleSubAgentResume({
          state: params.state,
          toolCallId,
          continuation: pendingCont,
          shellExecutor: params.shellExecutor,
          mcpManager: params.mcpManager,
          skillManifests: params.skillManifests,
          skillOptions: params.skillOptions,
          signal: params.signal,
          taskConfig: params.taskConfig,
          taskModel: params.taskModel,
          emitSubagentEvent,
        });
        events.push(...resumeEvents);
        continue;
      }

      // ── Normal sub-agent execution ──
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

        // ── Sub-agent blocked for approval → surface through Runtime Kernel ──
        if (result.subagentResult?.blocked) {
          const blocked = result.subagentResult.blocked;
          const subagentId = blocked.continuation.id;
          pendingSubagentContinuations.set(toolCallId, blocked.continuation);

          // Build approval payload for the blocked sub-agent tool
          const blockedDecision = evaluateToolApproval({
            toolName: blocked.toolName,
            toolArgs: blocked.args,
            phase: getAgentPhase(params.state.planning),
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            authorization: params.state.authorization,
          });
          const blockedApproval = buildToolApproval({
            workspace: params.state.session.workspace,
            threadId: params.state.session.threadId,
            request: {
              id: blocked.toolCallId,
              name: blocked.toolName,
              args: blocked.args,
              protectedCommand: blocked.command,
            } as import('@/core/harness/tool-requests').PendingToolRequest,
            decision: blockedDecision,
          }) as import('@/protocol/events').ToolApprovalPayload;
          blockedApproval.subagentId = subagentId;

          events.push({
            type: 'approval.requested',
            interactionId: genInteractionId(),
            toolCallId,
            approval: blockedApproval,
          });
          // Do NOT emit tool.finished — the task tool is paused, waiting for approval
          continue;
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
              result.status === 'exhausted'
                ? 'exhausted'
                : result.ok === false
                  ? 'error'
                  : 'success',
          },
        });
      } catch (error) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          error: error instanceof Error ? error.message : String(error),
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
