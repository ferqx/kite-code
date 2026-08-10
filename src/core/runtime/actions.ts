import { applyApprovalGrant } from '@/core/harness/tool-policy';
import { assertAuthorizationElevation } from '@/core/policies/mode-policy';
import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import { getActivePlanning, getActiveTask, type RuntimeState, type ToolCallStatus } from './state';

const TERMINAL_TOOL_STATUSES: ReadonlySet<ToolCallStatus> = new Set([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'exhausted',
]);

/**
 * Build the durable facts for stopping the current turn.
 *
 * The active task remains resumable. Every unfinished tool call receives a
 * result-pairing cancellation event before the turn is marked aborted.
 */
export function eventsForRunCancellation(
  state: Readonly<RuntimeState>,
  reason = 'Cancelled by user.',
  cause: 'user' | 'error' = 'user',
): RuntimeEvent[] {
  // auto_review is never a human approval surface. If a user aborts while it
  // is running, preserve that precise durable reason instead of pretending an
  // approval was rejected or silently escalating it.
  const toolReason =
    cause === 'user' && state.interactions.kind === 'awaiting_auto_review'
      ? 'user_cancelled'
      : reason;
  return [
    ...unfinishedToolCancellationEvents(state, toolReason),
    ...resourceReservationCancellationEvents(state),
    ...resourceWaiterCancellationEvents(state),
    {
      type: 'turn.aborted',
      turnId: state.turn.turnId,
      reason,
      cause,
    },
  ];
}

function resourceReservationCancellationEvents(state: Readonly<RuntimeState>): RuntimeEvent[] {
  if (state.resourceBudget.status !== 'active') return [];
  const events: RuntimeEvent[] = [];
  for (const reservation of Object.values(state.resourceBudget.reservations)) {
    if (reservation.state === 'reserved') {
      events.push({
        type: 'resource_budget.released',
        reservationId: reservation.reservationId,
      });
    } else if (reservation.state === 'dispatch_started') {
      events.push({
        type: 'resource_budget.unknown',
        reservationId: reservation.reservationId,
      });
    }
  }
  return events;
}

function resourceWaiterCancellationEvents(state: Readonly<RuntimeState>): RuntimeEvent[] {
  return state.resourceBudget.status === 'active'
    ? Object.values(state.resourceBudget.waiters)
        .filter((waiter) => waiter.state === 'waiting')
        .map((waiter) => ({
          type: 'resource_budget.waiter_cancelled' as const,
          invocationId: waiter.invocationId,
        }))
    : [];
}

function unfinishedToolCancellationEvents(
  state: Readonly<RuntimeState>,
  reason: string,
  excludedToolCallId?: string,
): RuntimeEvent[] {
  return Object.values(state.tools.calls)
    .filter((call) => !TERMINAL_TOOL_STATUSES.has(call.status))
    .filter((call) => call.toolCallId !== excludedToolCallId)
    .map((call) => ({
      type: 'tool.cancelled',
      toolCallId: call.toolCallId,
      reason,
    }));
}

function approvalCancellationEvents(
  state: Readonly<RuntimeState>,
  interaction: Extract<RuntimeState['interactions'], { kind: 'awaiting_tool_approval' }>,
  reason: string,
): RuntimeEvent[] {
  return [
    {
      type: 'approval.rejected',
      interactionId: interaction.interactionId,
      toolCallId: interaction.toolCallId,
      reason,
      failure: classifyFailure('approval_rejected', reason),
    },
    ...unfinishedToolCancellationEvents(state, reason, interaction.toolCallId),
    ...resourceReservationCancellationEvents(state),
    ...resourceWaiterCancellationEvents(state),
    {
      type: 'turn.aborted',
      turnId: state.turn.turnId,
      reason,
      cause: 'user',
    },
  ];
}

/** 生成取消方案审核时的事件，统一处理显式拒绝和 Esc/取消动作。 */
function planReviewCancelledEvents(
  state: Readonly<RuntimeState>,
  interaction: Extract<RuntimeState['interactions'], { kind: 'awaiting_review' }>,
  reason?: string,
): RuntimeEvent[] {
  const cancellationReason = reason ?? 'Plan execution confirmation cancelled by user.';
  return [
    {
      type: 'plan.review_cancelled',
      interactionId: interaction.interactionId,
      toolCallId: interaction.toolCallId,
      planId: interaction.planId,
      version: interaction.version,
      structuralDigest: interaction.structuralDigest,
      reason: cancellationReason,
    },
    {
      type: 'tool.cancelled',
      toolCallId: interaction.toolCallId,
      reason: cancellationReason,
    },
    ...unfinishedToolCancellationEvents(state, cancellationReason, interaction.toolCallId),
    ...resourceReservationCancellationEvents(state),
    ...resourceWaiterCancellationEvents(state),
    {
      type: 'turn.aborted',
      turnId: state.turn.turnId,
      reason: cancellationReason,
      cause: 'user',
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
      type: 'user_input.cancelled',
      interactionId: interaction.interactionId,
      toolCallId: interaction.toolCallId,
      reason: reason ?? 'User input cancelled by user.',
    },
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
  | {
      type: 'reconcile_invocation';
      invocationId: string;
      decision: 'confirmed_success' | 'confirmed_failure' | 'waived';
      reason?: string;
    }
  | { type: 'waive_verification'; verificationId: string; reason: string }
  | { type: 'replan_verification'; verificationId: string; instruction: string }
  | { type: 'request_verification_compensation'; verificationId: string }
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
  | {
      type: 'provider_action_result';
      interactionId: string;
      outcome: 'completed' | 'deferred' | 'failed';
      providerDirectoryRevision?: string;
      failureCode?:
        | 'authentication_failed'
        | 'approval_denied'
        | 'provider_unavailable'
        | 'unknown';
    }
  | {
      type: 'provider_admission_decision';
      interactionId: string;
      decision:
        | {
            kind: 'retry';
            outcome: 'ready';
            providerDirectoryRevision: string;
          }
        | {
            kind: 'retry';
            outcome: 'unavailable';
            providerStatus: import('@/core/mcp/runtime-provider').McpProviderDirectoryStatus;
            diagnosticCode?: import('@/core/mcp/runtime-provider').McpProviderDirectoryEntry['diagnosticCode'];
          }
        | { kind: 'waive' }
        | { kind: 'cancel' };
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
  if (action.type === 'reconcile_invocation') {
    const invocation = state.capabilities.invocations[action.invocationId];
    if (invocation?.status !== 'unknown') return [];
    return [
      {
        type: 'capability.reconciliation_resolved',
        invocationId: action.invocationId,
        decision: action.decision,
        reconciledAt: new Date().toISOString(),
        ...(action.reason ? { reason: action.reason } : {}),
      },
    ];
  }
  if (action.type === 'waive_verification') {
    const record = state.verification.records[action.verificationId];
    if (!record || record.status === 'passed' || !action.reason.trim()) return [];
    return [
      {
        type: 'verification.waived',
        verificationId: action.verificationId,
        actor: 'user',
        reason: action.reason.trim(),
        waivedAt: new Date().toISOString(),
      },
    ];
  }
  if (action.type === 'replan_verification') {
    const record = state.verification.records[action.verificationId];
    if (!record || record.status === 'passed' || !action.instruction.trim()) return [];
    return [
      {
        type: 'verification.replan_requested',
        verificationId: action.verificationId,
        instruction: action.instruction.trim(),
        requestedAt: new Date().toISOString(),
      },
    ];
  }
  if (action.type === 'request_verification_compensation') {
    const record = state.verification.records[action.verificationId];
    if (
      !record?.spec.compensation ||
      !['failed', 'inconclusive', 'budget_exhausted'].includes(record.status)
    )
      return [];
    return [
      {
        type: 'verification.compensation_requested',
        verificationId: action.verificationId,
        requestedAt: new Date().toISOString(),
      },
    ];
  }
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
        toolCallId: interaction.toolCallId,
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
      if (!interaction.approval.grantOptions.includes(action.grant)) return [];
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
              toolCallId: interaction.toolCallId,
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
          source: 'builtin' as const,
          id: interaction.toolCallId,
          name: 'shell_execute',
          args: { command: interaction.approval.command },
          reason: 'User approved tool execution.',
          protectedCommand: interaction.approval.command,
        },
      });
      return [
        {
          type: 'approval.granted',
          interactionId: action.interactionId,
          toolCallId: interaction.toolCallId,
          grant: action.grant,
        },
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
      return approvalCancellationEvents(
        state,
        interaction,
        action.reason ??
          (action.type === 'reject'
            ? 'Tool approval rejected by user.'
            : 'Tool approval cancelled by user.'),
      );
    }
    return [];
  }

  if (interaction.kind === 'awaiting_auto_review') {
    if (action.type !== 'cancel') return [];
    return [
      {
        type: 'tool.cancelled',
        toolCallId: interaction.toolCallId,
        reason: action.reason ?? 'user_cancelled',
      },
    ];
  }

  if (interaction.kind === 'awaiting_provider_action') {
    if (action.type === 'cancel') {
      return [
        {
          type: 'provider.action_deferred',
          interactionId: interaction.interactionId,
          originatingToolCallId: interaction.originatingToolCallId,
        },
      ];
    }
    if (action.type !== 'provider_action_result') return [];
    if (action.outcome === 'completed') {
      return [
        {
          type: 'provider.action_completed',
          interactionId: interaction.interactionId,
          originatingToolCallId: interaction.originatingToolCallId,
          ...(action.providerDirectoryRevision
            ? { providerDirectoryRevision: action.providerDirectoryRevision }
            : {}),
        },
        { type: 'turn.started', turnId: crypto.randomUUID() },
      ];
    }
    if (action.outcome === 'deferred') {
      return [
        {
          type: 'provider.action_deferred',
          interactionId: interaction.interactionId,
          originatingToolCallId: interaction.originatingToolCallId,
        },
      ];
    }
    return [
      {
        type: 'provider.action_failed',
        interactionId: interaction.interactionId,
        originatingToolCallId: interaction.originatingToolCallId,
        failureCode: action.failureCode ?? 'unknown',
      },
    ];
  }

  if (interaction.kind === 'awaiting_provider_admission') {
    const decision =
      action.type === 'cancel'
        ? ({ kind: 'cancel' } as const)
        : action.type === 'provider_admission_decision'
          ? action.decision
          : undefined;
    if (!decision) return [];
    if (decision.kind === 'retry') {
      return decision.outcome === 'ready'
        ? [
            {
              type: 'provider.admission_retry_requested',
              interactionId: interaction.interactionId,
            },
            {
              type: 'provider.admission_satisfied',
              interactionId: interaction.interactionId,
              providerDirectoryRevision: decision.providerDirectoryRevision,
            },
          ]
        : [
            {
              type: 'provider.admission_retry_requested',
              interactionId: interaction.interactionId,
            },
            {
              type: 'provider.admission_retry_failed',
              interactionId: interaction.interactionId,
              providerStatus: decision.providerStatus,
              ...(decision.diagnosticCode ? { diagnosticCode: decision.diagnosticCode } : {}),
            },
          ];
    }
    if (decision.kind === 'waive') {
      return [
        {
          type: 'provider.admission_waived',
          interactionId: interaction.interactionId,
          providerId: interaction.providerId,
          source: interaction.source,
          reason: 'user_session_waiver',
          waivedAt: new Date().toISOString(),
        },
      ];
    }
    const activeTask = getActiveTask(state);
    return [
      {
        type: 'provider.admission_cancelled',
        interactionId: interaction.interactionId,
        providerId: interaction.providerId,
      },
      ...(activeTask
        ? [
            {
              type: 'task.cancelled' as const,
              taskId: activeTask.taskId,
              reason: `Required MCP provider '${interaction.providerId}' admission was cancelled.`,
            },
          ]
        : []),
      {
        type: 'turn.aborted',
        turnId: state.turn.turnId,
        reason: `Required MCP provider '${interaction.providerId}' admission was cancelled.`,
        cause: 'user',
      },
    ];
  }

  // TUI 的 Esc/取消操作使用通用 cancel；Plan 审核需要落成完整的审核取消事件，
  // 否则运行循环会收到空事件并报 Runtime action does not match active interaction。
  if (interaction.kind === 'awaiting_review' && action.type === 'cancel') {
    return planReviewCancelledEvents(state, interaction, action.reason);
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
      const planning = getActivePlanning(state);
      if (planning.kind !== 'awaiting_review') return [];
      if (planning.document.planSchemaVersion !== 2) {
        const feedback = 'legacy_plan_replan_required: revise and save a V2 Plan before approval.';
        return [
          {
            type: 'plan.revision_requested',
            interactionId: action.interactionId,
            toolCallId: interaction.toolCallId,
            planId: interaction.planId,
            version: interaction.version,
            structuralDigest: interaction.structuralDigest,
            feedback,
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
                structural_digest: interaction.structuralDigest,
                ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
                feedback,
              }),
              stderr: '',
            },
          },
        ];
      }
      return [
        {
          type: 'plan.approved',
          interactionId: action.interactionId,
          toolCallId: interaction.toolCallId,
          planId: interaction.planId,
          version: interaction.version,
          structuralDigest: interaction.structuralDigest,
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
              structural_digest: interaction.structuralDigest,
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
          toolCallId: interaction.toolCallId,
          planId: interaction.planId,
          version: interaction.version,
          structuralDigest: interaction.structuralDigest,
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
              structural_digest: interaction.structuralDigest,
              ...(interaction.artifact ? { artifact: interaction.artifact } : {}),
              feedback: decision.feedback,
            }),
            stderr: '',
          },
        },
      ];
    }
    if (decision.kind === 'cancel') {
      return planReviewCancelledEvents(state, interaction, decision.reason);
    }
    return [];
  }

  return [];
}
