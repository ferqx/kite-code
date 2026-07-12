import { applyApprovalGrant } from '@/core/harness/tool-policy';
import { assertAuthorizationElevation } from '@/core/policies/mode-policy';
import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
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
            clearPlanningContext: boolean;
          }
        | { kind: 'revise'; feedback: string }
        | { kind: 'cancel'; reason?: string };
    }
  | { type: 'cancel'; interactionId: string; reason?: string };

/** Convert a validated user action to facts.  An invalid action intentionally has no effects. */
export function eventsForRuntimeAction(
  state: RuntimeState,
  action: RuntimeUserAction,
  options: { sandboxAvailable?: boolean } = {},
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
            stdout: interaction.planSummary,
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
            stdout: JSON.stringify({ decision: 'revise', feedback: decision.feedback }),
            stderr: '',
          },
        },
      ];
    }
    if (decision.kind === 'cancel') {
      return [
        {
          type: 'plan.rejected',
          interactionId: action.interactionId,
          reason: decision.reason ?? 'Plan cancelled by user.',
        },
      ];
    }
    return [];
  }

  return [];
}
