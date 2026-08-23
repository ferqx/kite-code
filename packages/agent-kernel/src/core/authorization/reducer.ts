import { kernelToolDoomLoopFingerprint, kernelUpdateDoomLoopTracker } from '../../doom-loop';
import type { KernelEvent } from '../../events';
import {
  asJsonObject,
  eventRecord,
  jsonRecord,
  nonEmptyStringField,
  recordField,
  stringField,
  updateToolCall,
} from '../../reducer-utils';
import type { AgentState } from '../../state';

type AuthorizationSource = NonNullable<AgentState['authorization']['modeSource']>;

const AUTHORIZATION_SOURCES: readonly AuthorizationSource[] = ['user', 'config', 'test', 'system'];

function isAuthorizationSource(value: string | undefined): value is AuthorizationSource {
  return value !== undefined && AUTHORIZATION_SOURCES.includes(value as AuthorizationSource);
}

function evaluateAutoReviewCircuit(
  state: AgentState['autoReview'],
  input:
    | { readonly kind: 'approval'; readonly observedAt: number }
    | {
        readonly kind: 'rejection';
        readonly observedAt: number;
        readonly toolName: string;
        readonly reason: string;
      },
): AgentState['autoReview'] {
  const windowStart = input.observedAt - 30_000;
  const rejectionHistory = state.rejectionHistory.filter((entry) => entry.timestamp >= windowStart);
  if (input.kind === 'approval') {
    return {
      ...state,
      consecutiveRejects: 0,
      rejectionHistory,
      circuitBreakerTripped: false,
    };
  }
  const consecutiveRejects = state.consecutiveRejects + 1;
  const nextHistory = [
    ...rejectionHistory,
    {
      timestamp: input.observedAt,
      toolName: input.toolName,
      reason: input.reason,
    },
  ];
  return {
    ...state,
    consecutiveRejects,
    rejectionHistory: nextHistory,
    circuitBreakerTripped:
      state.circuitBreakerTripped || consecutiveRejects >= 3 || nextHistory.length >= 20,
  };
}

function elapsedBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

function interactionMode(value: string | undefined): AgentState['mode'] | undefined {
  return value === 'accept_edits' || value === 'auto' || value === 'full' ? value : undefined;
}

function authorizationMode(value: string | undefined): 'default' | 'full_access' | undefined {
  return value === 'default' || value === 'full_access' ? value : undefined;
}

function approvalGrant(
  value: unknown,
): 'approve_once' | 'same_command' | 'full_access' | undefined {
  return value === 'approve_once' || value === 'same_command' || value === 'full_access'
    ? value
    : undefined;
}

/** Authorization and mode facts have one compile-time reducer owner. */
export function reduceAuthorizationState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'authorization.changed': {
      const mode = authorizationMode(stringField(payload, 'mode'));
      if (!mode) return state;
      const source = stringField(payload, 'modeSource');
      const modeGrantedAt = stringField(payload, 'modeGrantedAt');
      const commandGrants = payload.commandGrants;
      return {
        ...state,
        authorization: asJsonObject({
          ...state.authorization,
          mode,
          ...(commandGrants ? { commandGrants: jsonRecord(commandGrants) } : {}),
          ...(isAuthorizationSource(source) ? { modeSource: source } : {}),
          ...(modeGrantedAt ? { modeGrantedAt } : {}),
        }),
      };
    }
    case 'interaction_mode.changed': {
      const mode = interactionMode(stringField(payload, 'mode'));
      const source = stringField(payload, 'source');
      const changedAt = stringField(payload, 'changedAt');
      if (!mode || !isAuthorizationSource(source) || !changedAt) return state;
      const authorization =
        mode === 'full'
          ? {
              ...state.authorization,
              mode: 'full_access' as const,
              modeSource: source,
              modeGrantedAt: changedAt,
            }
          : (() => {
              const {
                modeSource: _modeSource,
                modeGrantedAt: _modeGrantedAt,
                ...rest
              } = state.authorization;
              return { ...rest, mode: 'default' as const };
            })();
      const activeTask = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
      return {
        ...state,
        mode,
        authorization,
        ...(activeTask
          ? {
              tasks: {
                ...state.tasks,
                [activeTask.taskId]: { ...activeTask, executionMode: undefined },
              },
            }
          : {}),
      };
    }
    case 'approval.requested': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      if (!interactionId || !toolCallId) return state;
      const approval = recordField(payload, 'approval');
      const approvalHash = approval ? nonEmptyStringField(approval, 'approvalHash') : undefined;
      const next = updateToolCall(state, toolCallId, (call) =>
        call
          ? {
              ...call,
              status: 'awaiting_approval',
              ...(approvalHash ? { approvalHash } : {}),
              ...(stringField(payload, 'createdAt')
                ? { approvalRequestedAt: stringField(payload, 'createdAt') }
                : {}),
            }
          : call,
      );
      return {
        ...next,
        interactions: jsonRecord({
          kind: 'awaiting_tool_approval',
          interactionId,
          toolCallId,
          approval: jsonRecord(payload.approval),
        }),
      };
    }
    case 'approval.granted': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      if (
        !interactionId ||
        stringField(state.interactions, 'kind') !== 'awaiting_tool_approval' ||
        stringField(state.interactions, 'interactionId') !== interactionId
      )
        return state;
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const interactionToolCallId = nonEmptyStringField(state.interactions, 'toolCallId');
      const grant = approvalGrant(payload.grant);
      if (!toolCallId || !grant || interactionToolCallId !== toolCallId) return state;
      const next = updateToolCall(state, toolCallId, (call) =>
        call
          ? {
              ...call,
              status: 'approved',
              approvalGrant: grant,
              approvalWaitMs:
                (call.approvalWaitMs ?? 0) +
                (elapsedBetween(call.approvalRequestedAt, stringField(payload, 'createdAt')) ?? 0),
            }
          : call,
      );
      return { ...next, interactions: { kind: 'idle' } };
    }
    case 'approval.rejected': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      if (
        !interactionId ||
        !toolCallId ||
        stringField(state.interactions, 'kind') !== 'awaiting_tool_approval' ||
        stringField(state.interactions, 'interactionId') !== interactionId ||
        stringField(state.interactions, 'toolCallId') !== toolCallId
      )
        return state;
      const reason = stringField(payload, 'reason') ?? '';
      const suppliedFailure = recordField(payload, 'failure');
      const failure =
        suppliedFailure ??
        ({
          kind: 'approval_rejected',
          message: reason,
          retryable: false,
          modelFixable: false,
          needsUserIntervention: false,
          terminatesTurn: false,
          journal: true,
        } as const);
      const next = updateToolCall(state, toolCallId, (call) =>
        call
          ? {
              ...call,
              status: 'rejected',
              error: reason,
              failure: failure as unknown as NonNullable<
                AgentState['tools']['calls'][string]['failure']
              >,
              ...(recordField(payload, 'outcome')
                ? {
                    outcome: recordField(payload, 'outcome') as unknown as NonNullable<
                      AgentState['tools']['calls'][string]['outcome']
                    >,
                  }
                : {}),
            }
          : call,
      );
      return { ...next, interactions: { kind: 'idle' } };
    }
    case 'approval.command_replaced':
      return state;
    case 'auto_review.requested': {
      const interactionId = nonEmptyStringField(payload, 'reviewId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const toolName = stringField(payload, 'toolName');
      const reason = stringField(payload, 'reason');
      if (!interactionId || !toolCallId || !toolName || reason === undefined) return state;
      const approval = recordField(payload, 'approval');
      const approvalHash = approval ? nonEmptyStringField(approval, 'approvalHash') : undefined;
      const next = updateToolCall(state, toolCallId, (call) =>
        call
          ? {
              ...call,
              status: 'awaiting_auto_review',
              ...(approvalHash ? { approvalHash } : {}),
            }
          : call,
      );
      const call = state.tools.calls[toolCallId];
      const suppliedFingerprint = nonEmptyStringField(payload, 'requestFingerprint');
      const fingerprint =
        suppliedFingerprint ??
        (call ? kernelToolDoomLoopFingerprint({ name: call.name, args: call.args }) : undefined);
      const createdAt = stringField(payload, 'createdAt');
      const observedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
      return {
        ...next,
        ...(fingerprint
          ? {
              doomLoop: kernelUpdateDoomLoopTracker(
                next.doomLoop,
                fingerprint,
                Number.isFinite(observedAt) ? observedAt : 0,
              ),
            }
          : {}),
        interactions: jsonRecord({
          kind: 'awaiting_auto_review',
          interactionId,
          toolCallId,
          toolName,
          reason,
          approval: jsonRecord(payload.approval),
        }),
      };
    }
    case 'auto_review.completed':
      if (stringField(state.interactions, 'kind') !== 'awaiting_auto_review') return state;
      {
        const toolCallId = nonEmptyStringField(payload, 'toolCallId');
        const reviewId = nonEmptyStringField(payload, 'reviewId');
        if (
          !toolCallId ||
          !reviewId ||
          stringField(state.interactions, 'interactionId') !== reviewId ||
          stringField(state.interactions, 'toolCallId') !== toolCallId
        ) {
          return state;
        }
        const result = jsonRecord(payload.result);
        const resultFields = result as Readonly<Record<string, unknown>>;
        if (
          resultFields.ok === false ||
          (resultFields.approved !== true && resultFields.escalatedToUser === true)
        ) {
          return state;
        }
        const approved = resultFields.approved === true;
        const createdAt = stringField(payload, 'createdAt');
        const parsedObservedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
        const observedAt = Number.isFinite(parsedObservedAt) ? parsedObservedAt : 0;
        const rejectionReason =
          typeof resultFields.reason === 'string' ? resultFields.reason : 'auto-review rejected';
        const next = updateToolCall(state, toolCallId, (call) =>
          call
            ? {
                ...call,
                status: approved ? 'approved' : 'rejected',
                ...(approved
                  ? { approvalGrant: approvalGrant(resultFields.grant) ?? 'approve_once' }
                  : {}),
                ...(approved && typeof resultFields.durationMs === 'number'
                  ? { approvalWaitMs: (call.approvalWaitMs ?? 0) + resultFields.durationMs }
                  : {}),
                ...(typeof resultFields.reason === 'string' ? { error: resultFields.reason } : {}),
                ...(!approved
                  ? {
                      failure: {
                        kind: 'auto_review_rejected' as const,
                        message: rejectionReason,
                        retryable: false,
                        modelFixable: false,
                        needsUserIntervention: true,
                        terminatesTurn: false,
                        journal: true,
                      },
                      ...(recordField(payload, 'outcome')
                        ? {
                            outcome: recordField(payload, 'outcome') as unknown as NonNullable<
                              AgentState['tools']['calls'][string]['outcome']
                            >,
                          }
                        : {}),
                    }
                  : {}),
              }
            : call,
        );
        return {
          ...next,
          interactions: { kind: 'idle' },
          autoReview: evaluateAutoReviewCircuit(
            next.autoReview,
            approved
              ? { kind: 'approval', observedAt }
              : {
                  kind: 'rejection',
                  observedAt,
                  toolName: stringField(next.interactions, 'toolName') ?? '',
                  reason: rejectionReason,
                },
          ),
        };
      }
    default:
      return state;
  }
}
