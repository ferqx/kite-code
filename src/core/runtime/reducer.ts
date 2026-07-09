// ── Agent Runtime Kernel 运行时状态 reducer / Runtime state reducer ──
// Phase 2: 纯函数 reduceRuntimeState — 将 RuntimeEvent 应用到 RuntimeState，返回新的不可变状态
// Phase 2: Pure function reduceRuntimeState — applies a RuntimeEvent to RuntimeState, returns new immutable state

import type { RuntimeEvent } from './events';
import type { RuntimeState } from './state';
import { computePlanStructuralHash } from './state';

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
      // 从 drafted/needs_revision 继承 planId 和 version，否则生成新的
      // Inherit planId and version from drafted/needs_revision, otherwise generate new
      const inherited =
        state.plan.kind === 'drafted' || state.plan.kind === 'needs_revision'
          ? { planId: state.plan.planId, version: state.plan.version + 1 }
          : { planId: crypto.randomUUID(), version: 1 };
      const structuralHash = computePlanStructuralHash(event.plan);
      return {
        ...state,
        plan: {
          kind: 'awaiting_review',
          planId: inherited.planId,
          version: inherited.version,
          draft: event.plan,
          structuralHash,
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
        },
        interactions: {
          kind: 'awaiting_plan_review',
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
          plan: event.plan,
          planSummary: event.planSummary,
        },
      };
    }

    case 'plan.approved': {
      // 仅当方案在 awaiting_review 状态时转换为 approved
      // Only transition to approved when plan is in awaiting_review
      const planData = state.plan.kind === 'awaiting_review' ? state.plan : null;
      return {
        ...state,
        plan: planData
          ? {
              kind: 'approved',
              planId: planData.planId,
              version: planData.version,
              plan: planData.draft,
              structuralHash: planData.structuralHash,
              approvedAtTurnId: state.turn.turnId,
              executionMode: event.executionMode,
            }
          : state.plan,
        interactions: { kind: 'idle' },
      };
    }

    case 'plan.revision_requested': {
      // 从 awaiting_review 或 drafted 迁出时携带方案数据
      // Carry plan data when transitioning from awaiting_review or drafted
      const planData =
        state.plan.kind === 'awaiting_review'
          ? state.plan
          : state.plan.kind === 'drafted'
            ? state.plan
            : null;
      return {
        ...state,
        plan: planData
          ? {
              kind: 'needs_revision',
              planId: planData.planId,
              version: planData.version,
              draft: planData.draft,
              reason: event.feedback,
            }
          : state.plan,
        interactions: { kind: 'idle' },
      };
    }

    case 'plan.rejected':
      return {
        ...state,
        plan: { kind: 'none' },
        interactions: { kind: 'idle' },
      };

    // ── 工具生命周期 / Tool lifecycle ──

    case 'tool.queued': {
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
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: {
              ...existingCall,
              status: 'succeeded' as const,
              result: {
                ok: event.result.ok,
                summary: `Command: ${event.result.command}, exit code: ${event.result.exitCode}`,
                exitCode: event.result.exitCode,
              },
            },
          },
          active: state.tools.active.filter((id) => id !== event.toolCallId),
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
      return state;

    // ── 用户输入交互 / User input interaction ──

    case 'user_input.requested':
      return {
        ...state,
        interactions: {
          kind: 'awaiting_user_input',
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
          request: event.request,
        },
      };

    case 'user_input.answered':
      return {
        ...state,
        interactions: { kind: 'idle' },
      };

    // ── 工具审批交互 / Approval interaction ──

    case 'approval.requested':
      return {
        ...state,
        interactions: {
          kind: 'awaiting_tool_approval',
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
          approval: event.approval,
        },
      };

    case 'approval.granted':
      return {
        ...state,
        interactions: { kind: 'idle' },
      };

    case 'approval.rejected':
      return {
        ...state,
        interactions: { kind: 'idle' },
      };

    // ── 运行时环境 / Runtime environment ──

    case 'authorization.changed':
      return {
        ...state,
        authorization: {
          ...state.authorization,
          mode: event.mode,
        },
      };

    case 'phase.changed':
      return {
        ...state,
        phase: event.phase,
      };

    // ── Turn 生命周期 / Turn lifecycle ──

    // turn.started / turn.completed / turn.aborted 为信息性事件，
    // 当前不修改 RuntimeState（turn 在初始化时已设置）。
    // Informational events — no state mutation needed (turn is set at init).
    case 'turn.started':
    case 'turn.completed':
    case 'turn.aborted':
      return state;

    // ── 用户消息 / User message ──

    // user.message_appended 为信息性事件，由 TranscriptState 管理（未来）。
    // Informational — managed by TranscriptState (future).
    case 'user.message_appended':
      return state;

    // ── 模型交互 / Model interaction ──

    // model.requested / model.responded 为信息性事件，由 TranscriptState 管理（未来）。
    // Informational — managed by TranscriptState (future).
    case 'model.requested':
    case 'model.responded':
      return state;

    // ── Plan 生命周期补充 / Additional plan lifecycle ──

    case 'plan.drafted': {
      // 仅当 plan 为 none 或 needs_revision 时接受新 draft
      // Only accept new draft when plan is none or needs_revision
      if (state.plan.kind === 'none' || state.plan.kind === 'needs_revision') {
        const hash = computePlanStructuralHash(event.plan) || event.structuralHash;
        const planId = state.plan.kind === 'needs_revision' ? state.plan.planId : hash.slice(0, 16);
        const version = state.plan.kind === 'needs_revision' ? state.plan.version + 1 : 1;
        return {
          ...state,
          plan: {
            kind: 'drafted',
            planId,
            version,
            draft: event.plan,
            structuralHash: hash,
          },
        };
      }
      return state;
    }

    case 'plan.progress_updated': {
      // 仅当 plan 在 building 状态时更新步骤进度
      // Only update step progress when plan is in building state
      if (state.plan.kind === 'building') {
        return {
          ...state,
          plan: {
            ...state.plan,
            plan: event.plan,
          },
        };
      }
      return state;
    }

    case 'plan.completed': {
      // 从 building 或 approved 状态转换到 completed
      // Transition from building or approved to completed
      if (state.plan.kind === 'building') {
        return {
          ...state,
          plan: {
            kind: 'completed',
            planId: state.plan.planId,
            version: state.plan.version,
            plan: {
              ...state.plan.plan,
              status: 'completed' as import('@/protocol/events').PlanStatus,
            },
            completedAtTurnId: state.turn.turnId,
          },
        };
      }
      if (state.plan.kind === 'approved') {
        return {
          ...state,
          plan: {
            kind: 'completed',
            planId: state.plan.planId,
            version: state.plan.version,
            plan: {
              ...state.plan.plan,
              status: 'completed' as import('@/protocol/events').PlanStatus,
            },
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

    // auto_review.requested 为信息性事件，auto-review 的触发和结果由
    // approval-controller 内部处理，不影响 RuntimeState。
    // Informational — auto-review trigger and result are handled internally
    // by approval-controller, no RuntimeState mutation needed.
    case 'auto_review.requested':
    // auto_review.completed 为信息性事件，审批决策通过 approval.granted/rejected 体现。
    // Informational — approval decisions are reflected via approval.granted/rejected.
    case 'auto_review.completed':
      return state;

    default:
      return state;
  }
}
