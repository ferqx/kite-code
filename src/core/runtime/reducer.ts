// ── Agent Runtime Kernel 运行时状态 reducer / Runtime state reducer ──
// Phase 2: 纯函数 reduceRuntimeState — 将 RuntimeEvent 应用到 RuntimeState，返回新的不可变状态
// Phase 2: Pure function reduceRuntimeState — applies a RuntimeEvent to RuntimeState, returns new immutable state

import type { AgentPlan, PlanDocument, PlanStep } from '@/protocol/events';
import type { RuntimeEvent } from './events';
import type { RuntimeState } from './state';
import { computePlanStructuralDigest } from './state';

/**
 * 纯函数：将运行时事件应用到状态，返回新的不可变状态。
 * Pure function: applies a runtime event to the state, returns a new immutable state.
 *
 * 所有状态更新均通过展开运算符实现不可变更新，绝不修改原状态。
 * All state updates use spread operators for immutability; the original state is never mutated.
 *
 * @param state - 当前运行时状态 / Current runtime state
 * @param event - 要应用的运行时事件 / Runtime event to apply
 * @returns 新的不可变运行时状态 / New immutable runtime state
 */
export function reduceRuntimeState(state: RuntimeState, event: RuntimeEvent): RuntimeState {
  switch (event.type) {
    // ── 方案生命周期 / Plan lifecycle ──

    case 'plan.review_requested': {
      // 从 planning_draft 继承 planId 和 version
      // Inherit planId and version from planning_draft
      const doc = planDocumentFromAgentPlan(event.plan, state.turn.turnId);
      const inherited =
        state.planning.kind === 'planning_draft'
          ? { planId: state.planning.document.planId, version: state.planning.document.version + 1 }
          : { planId: doc.planId, version: 1 };
      const structuralDigest = computePlanStructuralDigest(doc);
      const document: PlanDocument = {
        ...doc,
        planId: inherited.planId,
        version: inherited.version,
        structuralDigest,
      };
      return {
        ...state,
        tools: updateToolStatus(state.tools, event.toolCallId, 'awaiting_review'),
        planning: {
          kind: 'awaiting_review',
          document,
          interactionId: event.interactionId,
          exitToolCallId: event.toolCallId,
        },
        interactions: {
          kind: 'awaiting_review',
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
          planId: document.planId,
          version: document.version,
          structuralDigest: document.structuralDigest,
          plan: event.plan,
          planSummary: event.planSummary,
        },
      };
    }

    case 'plan.approved': {
      // 仅当方案在 awaiting_review 状态时转换为 executing
      // Only transition to executing when plan is in awaiting_review
      if (state.planning.kind !== 'awaiting_review') return state;
      if (
        state.interactions.kind !== 'idle' &&
        (state.interactions.kind !== 'awaiting_review' ||
          state.interactions.interactionId !== event.interactionId)
      ) {
        return state;
      }
      return {
        ...state,
        planning: {
          kind: 'executing',
          document: state.planning.document,
          executionMode: event.executionMode as 'manual' | 'accept_edits' | 'auto',
          approvedAtTurnId: state.turn.turnId,
        },
        interactions: { kind: 'idle' },
      };
    }

    case 'plan.revision_requested': {
      // 从 awaiting_review 迁回 planning_draft，携带修订反馈
      // Transition from awaiting_review back to planning_draft with revision feedback
      if (state.planning.kind !== 'awaiting_review') return state;
      if (
        state.interactions.kind !== 'idle' &&
        (state.interactions.kind !== 'awaiting_review' ||
          state.interactions.interactionId !== event.interactionId)
      ) {
        return state;
      }
      return {
        ...state,
        planning: {
          kind: 'planning_draft',
          document: state.planning.document,
          revisionFeedback: event.feedback,
        },
        interactions: { kind: 'idle' },
      };
    }

    case 'plan.rejected':
      // plan.rejected → plan.cancelled (event naming migration)
      // plan.rejected → plan.cancelled (event naming migration)
      if (
        state.interactions.kind !== 'idle' &&
        (state.interactions.kind !== 'awaiting_review' ||
          state.interactions.interactionId !== event.interactionId)
      ) {
        return state;
      }
      return {
        ...state,
        planning: {
          kind: 'cancelled',
          document: state.planning.kind === 'awaiting_review' ? state.planning.document : undefined,
          reason: event.reason,
          cancelledAtTurnId: state.turn.turnId,
        },
        interactions: { kind: 'idle' },
      };

    // ── 工具生命周期 / Tool lifecycle ──

    case 'tool.queued': {
      // LangGraph can replay an interrupted node.  A replayed queue event must
      // not reset a terminal call or append the same id to the queue again.
      if (state.tools.calls[event.toolCallId]) return state;
      const call = {
        toolCallId: event.toolCallId,
        modelMessageId: '',
        name: event.name,
        args: event.args,
        status: 'queued' as const,
        createdAtTurnId: state.turn.turnId,
      };
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: { ...state.tools.calls, [event.toolCallId]: call },
          queue: [...state.tools.queue, event.toolCallId],
        },
      };
    }

    case 'tool.started': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall) return state;
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: { ...existingCall, status: 'running' as const },
          },
          queue: state.tools.queue.filter((id) => id !== event.toolCallId),
          active: [...state.tools.active, event.toolCallId],
        },
      };
    }

    case 'tool.finished': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall) return state;
      const status =
        event.result.status === 'exhausted'
          ? ('exhausted' as const)
          : event.result.ok
            ? ('succeeded' as const)
            : ('failed' as const);
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: {
              ...existingCall,
              status,
              result: {
                ok: event.result.ok,
                summary: `Command: ${event.result.command}, exit code: ${event.result.exitCode}`,
                exitCode: event.result.exitCode,
              },
            },
          },
          queue: state.tools.queue.filter((id) => id !== event.toolCallId),
          active: state.tools.active.filter((id) => id !== event.toolCallId),
        },
        transcript: {
          ...state.transcript,
          messages: [
            ...state.transcript.messages,
            {
              kind: 'tool',
              toolCallId: event.toolCallId,
              name: event.name,
              content: event.result.stdout || event.result.stderr,
              ok: event.result.ok,
            },
          ],
        },
      };
    }

    case 'tool.failed': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall) return state;
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: {
              ...existingCall,
              status: 'failed' as const,
              error: event.error,
            },
          },
          queue: state.tools.queue.filter((id) => id !== event.toolCallId),
          active: state.tools.active.filter((id) => id !== event.toolCallId),
        },
      };
    }

    case 'tool.rejected': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (existingCall) {
        return {
          ...state,
          tools: {
            ...state.tools,
            calls: {
              ...state.tools.calls,
              [event.toolCallId]: { ...existingCall, status: 'rejected' as const },
            },
            queue: state.tools.queue.filter((id) => id !== event.toolCallId),
            active: state.tools.active.filter((id) => id !== event.toolCallId),
          },
        };
      }
      return {
        ...state,
        tools: {
          ...state.tools,
          queue: state.tools.queue.filter((id) => id !== event.toolCallId),
          active: state.tools.active.filter((id) => id !== event.toolCallId),
        },
      };
    }

    // tool.progress does not modify state — progress data is consumed via event stream
    case 'tool.progress':
    // tool.file_change is informational — consumed via event stream
    case 'tool.file_change':
      return state;

    // ── 用户输入交互 / User input interaction ──

    case 'user_input.requested':
      return {
        ...state,
        tools: updateToolStatus(state.tools, event.toolCallId, 'awaiting_user_input'),
        interactions: {
          kind: 'awaiting_user_input',
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
          request: event.request,
        },
      };

    case 'user_input.answered':
      if (
        state.interactions.kind !== 'awaiting_user_input' ||
        state.interactions.interactionId !== event.interactionId
      ) {
        return state;
      }
      return {
        ...state,
        interactions: { kind: 'idle' },
      };

    // ── 工具审批交互 / Approval interaction ──

    case 'approval.requested':
      return {
        ...state,
        tools: updateToolStatus(state.tools, event.toolCallId, 'awaiting_approval'),
        interactions: {
          kind: 'awaiting_tool_approval',
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
          approval: event.approval,
        },
      };

    case 'approval.granted':
      if (
        state.interactions.kind !== 'awaiting_tool_approval' ||
        state.interactions.interactionId !== event.interactionId
      ) {
        return state;
      }
      return {
        ...state,
        tools: {
          ...updateToolStatus(state.tools, state.interactions.toolCallId, 'approved'),
          calls: {
            ...state.tools.calls,
            [state.interactions.toolCallId]: {
              ...state.tools.calls[state.interactions.toolCallId]!,
              status: 'approved',
              approvalGrant: event.grant,
            },
          },
        },
        interactions: { kind: 'idle' },
      };

    case 'approval.rejected':
      if (
        state.interactions.kind !== 'awaiting_tool_approval' ||
        state.interactions.interactionId !== event.interactionId
      ) {
        return state;
      }
      return {
        ...state,
        tools: updateToolStatus(state.tools, state.interactions.toolCallId, 'rejected'),
        interactions: { kind: 'idle' },
      };

    // ── 运行时环境 / Runtime environment ──

    case 'authorization.changed':
      return {
        ...state,
        authorization: {
          ...state.authorization,
          mode: event.mode,
          ...(event.commandGrants ? { commandGrants: event.commandGrants } : {}),
        },
      };

    // phase.changed — deprecated; phase is now derived from planning.kind via getAgentPhase()
    // phase.changed — deprecated; phase is now derived from planning.kind via getAgentPhase()
    case 'phase.changed':
      return state;

    // ── Turn 生命周期 / Turn lifecycle ──

    // turn.started / turn.completed / turn.aborted 为信息性事件，
    // 当前不修改 RuntimeState（turn 在初始化时已设置）。
    // Informational events — no state mutation needed (turn is set at init).
    case 'turn.started':
    case 'turn.completed':
    case 'turn.aborted':
      return state;

    // ── 用户消息 / User message ──

    case 'user.message_appended':
      return {
        ...state,
        transcript: {
          ...state.transcript,
          final: undefined,
          messages: [
            ...state.transcript.messages,
            { kind: 'user', messageId: event.messageId, content: event.content },
          ],
        },
      };

    // ── 模型交互 / Model interaction ──

    // model.requested / model.responded 为信息性事件，由 TranscriptState 管理（未来）。
    // Informational — managed by TranscriptState (future).
    case 'model.requested':
      return state;

    case 'model.retry':
    case 'model.cache_metrics':
    case 'run.completed':
    case 'run.error':
      return state;

    case 'model.responded':
      return {
        ...state,
        transcript: {
          ...state.transcript,
          final: event.toolCalls?.length ? undefined : (event.text ?? state.transcript.final),
          messages: [
            ...state.transcript.messages,
            {
              kind: 'assistant',
              messageId: event.messageId,
              content: event.text,
              reasoningText: event.reasoningText,
              toolCalls: event.toolCalls ?? [],
            },
          ],
        },
      };

    // ── Plan 生命周期补充 / Additional plan lifecycle ──

    case 'plan.drafted': {
      // plan.drafted → plan.draft_saved (event naming migration)
      // Accept new draft when planning is empty or in planning_draft (revision cycle)
      if (state.planning.kind === 'planning_empty' || state.planning.kind === 'planning_draft') {
        const doc = planDocumentFromAgentPlan(event.plan, state.turn.turnId);
        const digest = computePlanStructuralDigest(doc);
        const planId =
          state.planning.kind === 'planning_draft' ? state.planning.document.planId : doc.planId;
        const version =
          state.planning.kind === 'planning_draft' ? state.planning.document.version + 1 : 1;
        const document: PlanDocument = {
          ...doc,
          planId,
          version,
          structuralDigest: digest,
        };
        return {
          ...state,
          planning: {
            kind: 'planning_draft',
            document,
          },
        };
      }
      return state;
    }

    case 'plan.progress_updated': {
      // 仅当 plan 在 executing 状态时更新步骤进度
      // Only update step progress when plan is in executing state
      if (state.planning.kind === 'executing') {
        const updatedSteps = mergeStepUpdates(
          state.planning.document.steps,
          agentPlanToSteps(event.plan),
        );
        return {
          ...state,
          planning: {
            ...state.planning,
            document: {
              ...state.planning.document,
              steps: updatedSteps,
              updatedAtTurnId: state.turn.turnId,
            },
          },
        };
      }
      return state;
    }

    case 'plan.completed': {
      // 从 executing 状态转换到 completed
      // Transition from executing to completed
      if (state.planning.kind === 'executing') {
        return {
          ...state,
          planning: {
            kind: 'completed',
            document: state.planning.document,
            completedAtTurnId: state.turn.turnId,
          },
        };
      }
      return state;
    }

    // ── Approval 补充 / Additional approval ──

    // approval.command_replaced 为信息性事件，审批结果通过 approval.granted 体现。
    // Informational — approval result is reflected via approval.granted.
    case 'approval.command_replaced':
      return state;

    // ── Auto-review 事件 / Auto-review events ──

    case 'auto_review.requested':
      return {
        ...state,
        tools: updateToolStatus(state.tools, event.toolCallId, 'awaiting_auto_review'),
        interactions: {
          kind: 'awaiting_auto_review',
          interactionId: event.reviewId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          reason: event.reason,
          approval: event.approval,
        },
      };

    case 'auto_review.completed': {
      if (
        state.interactions.kind !== 'awaiting_auto_review' ||
        state.interactions.interactionId !== event.reviewId
      ) {
        return state;
      }
      const result = event.result;
      if (result.ok && result.approved) {
        return {
          ...state,
          tools: updateToolStatus(state.tools, state.interactions.toolCallId, 'approved'),
          interactions: { kind: 'idle' },
        };
      }
      return {
        ...state,
        tools: updateToolStatus(state.tools, state.interactions.toolCallId, 'rejected'),
        interactions: { kind: 'idle' },
      };
    }

    default:
      return state;
  }
}

function updateToolStatus(
  tools: RuntimeState['tools'],
  toolCallId: string,
  status:
    | 'awaiting_user_input'
    | 'awaiting_review'
    | 'awaiting_approval'
    | 'awaiting_auto_review'
    | 'approved'
    | 'rejected',
): RuntimeState['tools'] {
  const call = tools.calls[toolCallId];
  if (!call) return tools;
  return {
    ...tools,
    calls: { ...tools.calls, [toolCallId]: { ...call, status } },
  };
}

// ── Helper: convert legacy AgentPlan → PlanDocument ──

function planDocumentFromAgentPlan(
  plan: AgentPlan,
  turnId: string,
): Omit<PlanDocument, 'structuralDigest'> {
  return {
    planId: crypto.randomUUID(),
    version: 1,
    title: plan.name.slice(0, 120),
    bodyMarkdown: plan.description,
    steps: plan.steps.map((s) => ({
      id: sanitizeStepId(s.step),
      title: s.step.slice(0, 160),
      status: mapLegacyStatus(s.status),
    })),
    createdAtTurnId: turnId,
    updatedAtTurnId: turnId,
  };
}

function agentPlanToSteps(plan: AgentPlan): PlanStep[] {
  return plan.steps.map((s) => ({
    id: sanitizeStepId(s.step),
    title: s.step.slice(0, 160),
    status: mapLegacyStatus(s.status),
  }));
}

function mapLegacyStatus(status: string): PlanStep['status'] {
  switch (status) {
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    default:
      return 'pending';
  }
}

function sanitizeStepId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'step'
  );
}

function mergeStepUpdates(existing: PlanStep[], updates: PlanStep[]): PlanStep[] {
  const updateMap = new Map(updates.map((u) => [u.id, u]));
  return existing.map((step) => {
    const update = updateMap.get(step.id);
    if (update && update.status !== 'pending') {
      return { ...step, status: update.status, note: update.note ?? step.note };
    }
    return step;
  });
}
