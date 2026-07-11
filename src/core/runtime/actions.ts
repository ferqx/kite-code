import { applyApprovalGrant } from '@/core/harness/tool-policy';
import type { RuntimeEvent } from './events';
import type { RuntimeState } from './state';

/** Actions accepted by the Kernel.  They are correlated to exactly one waiting interaction. */
export type RuntimeUserAction =
  | { type: 'input'; interactionId: string; text: string; answers?: Record<string, string> }
  | {
      type: 'approve';
      interactionId: string;
      grant: import('@/protocol/events').ShellApprovalGrant;
    }
  | { type: 'reject'; interactionId: string; reason?: string }
  | { type: 'approve_plan'; interactionId: string; executionMode: 'manual' | 'auto' }
  | { type: 'revise_plan'; interactionId: string; feedback: string }
  | { type: 'reject_plan'; interactionId: string; reason?: string }
  | { type: 'cancel'; interactionId: string; reason?: string };

/** Convert a validated user action to facts.  An invalid action intentionally has no effects. */
export function eventsForRuntimeAction(
  state: RuntimeState,
  action: RuntimeUserAction,
): RuntimeEvent[] {
  const interaction = state.interactions;
  if (interaction.kind === 'idle' || interaction.interactionId !== action.interactionId) return [];

  if (interaction.kind === 'awaiting_user_input') {
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
        },
      },
    ];
  }

  if (interaction.kind === 'awaiting_tool_approval') {
    if (action.type === 'approve') {
      const nextAuthorization = applyApprovalGrant({
        authorization: state.authorization,
        grant: action.grant,
        workspace: state.session.workspace,
        threadId: state.session.threadId,
        request: {
          id: interaction.toolCallId,
          // applyApprovalGrant only persists same-command grants for shell;
          // other tool grants are represented by the per-call approvalGrant.
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
        },
      ];
    }
    if (action.type === 'reject' || action.type === 'cancel') {
      return [
        {
          type: 'approval.rejected',
          interactionId: action.interactionId,
          reason: action.reason ?? 'Rejected by user.',
        },
      ];
    }
    return [];
  }

  if (interaction.kind === 'awaiting_plan_review' && action.type === 'approve_plan') {
    return [
      {
        type: 'plan.approved',
        interactionId: action.interactionId,
        executionMode: action.executionMode,
      },
      { type: 'phase.changed', phase: 'building' },
      {
        type: 'tool.finished',
        toolCallId: interaction.toolCallId,
        name: 'update_plan',
        result: { ok: true, command: '', exitCode: 0, stdout: interaction.planSummary, stderr: '' },
      },
    ];
  }
  if (action.type === 'revise_plan')
    return [
      {
        type: 'plan.revision_requested',
        interactionId: action.interactionId,
        feedback: action.feedback,
      },
    ];
  if (action.type === 'reject_plan' || action.type === 'cancel') {
    return [
      {
        type: 'plan.rejected',
        interactionId: action.interactionId,
        reason: action.reason ?? 'Plan rejected by user.',
      },
    ];
  }
  return [];
}
