import { applyApprovalGrant } from '@/core/harness/tool-policy';
import { assertAuthorizationElevation } from '@/core/policies/mode-policy';
import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import type { RuntimeState } from './state';

/** 生成取消方案审核时的事件，统一处理显式拒绝和 Esc/取消动作。 */
function planReviewCancelledEvents(
  interaction: Extract<RuntimeState['interactions'], { kind: 'awaiting_review' }>,
  reason?: string,
): RuntimeEvent[] {
  return [
    {
      type: 'plan.review_cancelled',
      interactionId: interaction.interactionId,
      reason: reason ?? 'Plan review cancelled by user.',
    },
    {
      type: 'tool.finished',
      toolCallId: interaction.toolCallId,
      name: 'write_plan',
      result: {
        ok: true,
        command: '',
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          status: 'review_cancelled',
          plan_id: interaction.planId,
          version: interaction.version,
          ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
          feedback: reason,
        }),
        stderr: '',
      },
    },
  ];
}

/** 生成取消用户提问时的工具结果，确保挂起的 ask_user 交互可以继续收敛。 */
function userInputCancelledEvents(
  interaction: Extract<RuntimeState['interactions'], { kind: 'awaiting_user_input' }>,
  reason?: string,
): RuntimeEvent[] {
  return [
    {
      type: 'tool.finished',
      toolCallId: interaction.toolCallId,
      name: 'ask_user',
      result: {
        ok: false,
        command: '',
        exitCode: -1,
        stdout: 'Cancelled',
        stderr: reason ?? 'User input cancelled by user.',
        status: 'error',
      },
    },
  ];
}

/** Actions accepted by the Kernel.  They are correlated to exactly one waiting interaction. */
export type RuntimeUserAction =
  | { type: 'input'; interactionId: string; text: string; answers?: Record<string, string> }
  | {
      type: 'approve';
      interactionId: string;
      grant: import('@/protocol/events').ShellApprovalGrant;
    }
  | { type: 'reject'; interactionId: string; reason?: string }
  // ── Plan Mode v2: unified plan_review_decision ──
  | {
      type: 'plan_review_decision';
      interactionId: string;
      planId: string;
      version: number;
      structuralDigest: string;
      decision:
        | {
            kind: 'approve';
            nextMode: 'accept_edits' | 'auto';
            /** @deprecated accepted from older TUI clients and intentionally ignored. */
            clearPlanningContext?: boolean;
          }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    }
  | { type: 'cancel'; interactionId: string; reason?: string };

export type RuntimeActionResult =
  | { status: 'applied'; events: RuntimeEvent[] }
  | { status: 'stale'; reason: string; telemetry: RuntimeEvent }
  | { status: 'rejected'; reason: string; telemetry: RuntimeEvent };

/** Convert a validated user action to facts.  An invalid action intentionally has no effects. */
export function eventsForRuntimeAction(
  state: RuntimeState,
  action: RuntimeUserAction,
  options: { sandboxAvailable?: boolean } = {},
): RuntimeEvent[] {
  const interaction = state.interactions;
  if (interaction.kind === 'idle' || interaction.interactionId !== action.interactionId) return [];

  if (interaction.kind === 'awaiting_user_input') {
    if (action.type === 'cancel') {
      return userInputCancelledEvents(interaction, action.reason);
    }
    if (action.type !== 'input') return [];
    return [
      {
        type: 'user_input.answered',
        interactionId: action.interactionId,
        answer: action.text,
        answers: action.answers,
      },
      {
        type: 'tool.finished',
        toolCallId: interaction.toolCallId,
        name: 'ask_user',
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: JSON.stringify({ answer: action.text, answers: action.answers }),
          stderr: '',
          userInput: { answer: action.text, answers: action.answers },
        },
      },
    ];
  }

  if (interaction.kind === 'awaiting_tool_approval') {
    if (action.type === 'approve') {
      if (action.grant === 'full_access') {
        try {
          assertAuthorizationElevation({
            mode: 'full_access',
            source: 'user',
            sandboxAvailable: options.sandboxAvailable ?? false,
          });
        } catch (error) {
          return [
            {
              type: 'approval.rejected',
              interactionId: action.interactionId,
              reason: error instanceof Error ? error.message : String(error),
              failure: classifyFailure(
                'sandbox_error',
                error instanceof Error ? error.message : String(error),
              ),
            },
          ];
        }
      }
      const nextAuthorization = applyApprovalGrant({
        authorization: state.authorization,
        grant: action.grant,
        source: 'user',
        workspace: state.session.workspace,
        threadId: state.session.threadId,
        request: {
          id: interaction.toolCallId,
          name: 'shell_execute',
          args: { command: interaction.approval.command },
          reason: 'User approved tool execution.',
          protectedCommand: interaction.approval.command,
        },
      });
      return [
        { type: 'approval.granted', interactionId: action.interactionId, grant: action.grant },
        {
          type: 'authorization.changed',
          mode: nextAuthorization.mode,
          commandGrants: nextAuthorization.commandGrants,
          modeSource: nextAuthorization.modeSource,
          modeGrantedAt: nextAuthorization.modeGrantedAt,
        },
      ];
    }
    if (action.type === 'reject' || action.type === 'cancel') {
      return [
        {
          type: 'approval.rejected',
          interactionId: action.interactionId,
          reason: action.reason ?? 'Rejected by user.',
          failure: classifyFailure('approval_rejected', action.reason ?? 'Rejected by user.'),
        },
      ];
    }
    return [];
  }

  // TUI 的 Esc/取消操作使用通用 cancel；Plan 审核需要落成完整的审核取消事件，
  // 否则运行循环会收到空事件并报 Runtime action does not match active interaction。
  if (interaction.kind === 'awaiting_review' && action.type === 'cancel') {
    return planReviewCancelledEvents(interaction, action.reason);
  }

  // ── Plan Mode v2: unified plan_review_decision ──
  if (interaction.kind === 'awaiting_review' && action.type === 'plan_review_decision') {
    // Validate planId + version + structuralDigest match
    if (
      action.planId !== interaction.planId ||
      action.version !== interaction.version ||
      action.structuralDigest !== interaction.structuralDigest
    ) {
      return [];
    }
    const { decision } = action;
    if (decision.kind === 'approve') {
      return [
        {
          type: 'plan.approved',
          interactionId: action.interactionId,
          executionMode: decision.nextMode,
        },
        {
          type: 'tool.finished',
          toolCallId: interaction.toolCallId,
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'approved',
              plan_id: interaction.planId,
              version: interaction.version,
              ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
              execution_mode: decision.nextMode,
            }),
            stderr: '',
          },
        },
      ];
    }
    if (decision.kind === 'revise') {
      return [
        {
          type: 'plan.revision_requested',
          interactionId: action.interactionId,
          feedback: decision.feedback,
        },
        {
          type: 'tool.finished',
          toolCallId: interaction.toolCallId,
          name: 'write_plan',
          result: {
            ok: true,
            command: '',
            exitCode: 0,
            stdout: JSON.stringify({
              ok: true,
              status: 'revision_requested',
              plan_id: interaction.planId,
              version: interaction.version,
              ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
              feedback: decision.feedback,
            }),
            stderr: '',
          },
        },
      ];
    }
    if (decision.kind === 'cancel') {
      return planReviewCancelledEvents(interaction, decision.reason);
    }
    return [];
  }

  return [];
}
