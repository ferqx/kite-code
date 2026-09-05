import {
  approvalCommandGrantKey,
  approvalPayloadFromEvent,
  chooseApprovalFocus,
  commandIdentityFromApproval,
  focusedInteraction,
  normalizeApprovalPayload,
  pendingWithStatus,
  stringOrUndefined,
} from '../../approval-queue';
import { kernelToolDoomLoopFingerprint, kernelUpdateDoomLoopTracker } from '../../doom-loop';
import type { KernelEvent } from '../../events';
import {
  eventRecord,
  jsonRecord,
  nonEmptyStringField,
  numberField,
  recordField,
  stringField,
  updateToolCall,
} from '../../reducer-utils';
import type {
  AgentApprovalCommandIdentity,
  AgentApprovalReceipt,
  AgentPendingApproval,
  AgentSessionCommandGrant,
  AgentState,
  AgentToolCallState,
} from '../../state';

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

function interactionMode(value: string | undefined): AgentState['mode'] | undefined {
  return value === 'accept_edits' || value === 'auto' || value === 'full' ? value : undefined;
}

function approvalGrant(value: unknown): 'approve_once' | 'same_command' | undefined {
  return value === 'approve_once' || value === 'same_command' ? value : undefined;
}

function pendingCreatedAt(payload: Readonly<Record<string, unknown>>): string {
  return stringField(payload, 'createdAt') ?? '1970-01-01T00:00:00.000Z';
}

function pendingRoute(payload: Readonly<Record<string, unknown>>): 'user' | 'auto' {
  return stringField(payload, 'approvalRoute') === 'auto' ||
    stringField(payload, 'route') === 'auto'
    ? 'auto'
    : 'user';
}

/**
 * A same_command grant is only safe when the event carries the complete
 * subject.  The reducer also runs in replay/fault tests without necessarily
 * passing through the JSON codec, so do not let a partial object acquire a
 * synthetic fallback identity or command key here.
 */
function isCompleteCommandIdentity(value: unknown): value is AgentApprovalCommandIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const required = [
    'sessionId',
    'threadId',
    'workspace',
    'canonicalWorkspaceIdentity',
    'cwd',
    'executor',
    'environment',
    'scope',
    'effects',
    'parserRevision',
    'commandDigest',
  ] as const;
  if (!required.every((field) => typeof record[field] === 'string' && record[field].length > 0)) {
    return false;
  }
  return (
    record.executorRevision === undefined ||
    (typeof record.executorRevision === 'string' && record.executorRevision.length > 0)
  );
}

function pendingFromEvent(
  state: AgentState,
  payload: Readonly<Record<string, unknown>>,
  interactionId: string,
  toolCallId: string,
  route: 'user' | 'auto',
  status: AgentPendingApproval['status'],
): AgentPendingApproval {
  const approvalRecord = approvalPayloadFromEvent(payload);
  const approval = normalizeApprovalPayload(approvalRecord);
  const call = state.tools.calls[toolCallId];
  const suppliedCommandIdentity = recordField(payload, 'commandIdentity');
  const hasCompleteCommandIdentity = isCompleteCommandIdentity(suppliedCommandIdentity);
  const commandIdentity = commandIdentityFromApproval(
    state,
    hasCompleteCommandIdentity
      ? { ...approvalRecord, commandIdentity: suppliedCommandIdentity }
      : approvalRecord,
  );
  const suppliedSequence = numberField(payload, 'queueSequence');
  const sequence =
    suppliedSequence !== undefined &&
    Number.isSafeInteger(suppliedSequence) &&
    suppliedSequence >= 0
      ? suppliedSequence
      : state.nextQueueSequence;
  const suppliedGeneration = numberField(payload, 'queueGeneration');
  const generation =
    suppliedGeneration !== undefined &&
    Number.isSafeInteger(suppliedGeneration) &&
    suppliedGeneration >= 0
      ? suppliedGeneration
      : state.approvalGeneration;
  const approvalHash = stringOrUndefined(approvalRecord.approvalHash);
  const owner = recordField(payload, 'owner');
  const childToolCallId =
    stringField(owner ?? {}, 'kind') === 'subagent_tool'
      ? stringOrUndefined(stringField(owner ?? {}, 'toolCallId'))
      : undefined;
  return {
    interactionId,
    toolCallId,
    ...(stringOrUndefined(payload.parentToolCallId)
      ? { parentToolCallId: payload.parentToolCallId as string }
      : {}),
    ...(stringOrUndefined(payload.childSubagentId)
      ? { childSubagentId: payload.childSubagentId as string }
      : {}),
    ...(stringOrUndefined(payload.runtimeToolCallId)
      ? { runtimeToolCallId: payload.runtimeToolCallId as string }
      : {}),
    ...(childToolCallId ? { childToolCallId } : {}),
    route,
    fullModeBypassEligible: payload.fullModeBypassEligible as boolean,
    fullModePolicyBypassAllowed: payload.fullModePolicyBypassAllowed as boolean,
    bindingDigest:
      approvalHash ?? (hasCompleteCommandIdentity ? commandIdentity.commandDigest : ''),
    approval,
    invocation: (call
      ? {
          toolCallId: call.toolCallId,
          name: call.name,
          args: call.args,
          modelMessageId: call.modelMessageId,
          modelInvocationId: call.modelInvocationId,
          ordinal: call.ordinal,
          createdAtTurnId: call.createdAtTurnId,
          taskId: call.taskId,
        }
      : {}) as Readonly<Record<string, unknown>>,
    ...(hasCompleteCommandIdentity ? { commandIdentity } : {}),
    ...(hasCompleteCommandIdentity ? { commandKey: approvalCommandGrantKey(commandIdentity) } : {}),
    ...(approvalHash ? { approvalHash } : {}),
    sequence,
    generation,
    createdAt: pendingCreatedAt(payload),
    status,
  };
}

function ownerMatchesPending(pending: AgentPendingApproval, owner: unknown): boolean {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false;
  const candidate = owner as Record<string, unknown>;
  if (candidate.kind === 'root_tool') {
    return (
      pending.childSubagentId === undefined &&
      pending.parentToolCallId === undefined &&
      candidate.toolCallId === pending.toolCallId
    );
  }
  // A subagent request is only settleable when the canonical child owner was
  // persisted with the request.  Runtime and presentation call ids are
  // separate identities; accepting either as a fallback would let a parent
  // approval settle the wrong child after an admission boundary.
  const childToolCallId = pending.childToolCallId;
  if (!childToolCallId) return false;
  return (
    candidate.kind === 'subagent_tool' &&
    candidate.toolCallId === childToolCallId &&
    candidate.subagentId === pending.childSubagentId &&
    candidate.parentToolCallId === pending.parentToolCallId
  );
}

function approvalQueueState(
  state: AgentState,
  pendingApprovals: ReadonlyMap<string, AgentPendingApproval>,
  activeApprovalId: string | null,
  extra: Partial<AgentState> = {},
): AgentState {
  return {
    ...state,
    ...extra,
    pendingApprovals,
    activeApprovalId,
    interactions: focusedInteraction(pendingApprovals, activeApprovalId),
  };
}

function nextQueueSequence(state: AgentState, pending: AgentPendingApproval): number {
  return Math.max(state.nextQueueSequence, pending.sequence + 1);
}

function pendingToolStatus(
  state: AgentState,
  toolCallId: string,
  status: AgentToolCallState['status'],
  grant?: AgentToolCallState['approvalGrant'],
  approvedAt?: string,
  measuredApprovalWaitMs?: number,
): AgentState {
  const next = updateToolCall(state, toolCallId, (call) =>
    call
      ? (() => {
          const started = call.approvalRequestedAt
            ? Date.parse(call.approvalRequestedAt)
            : Number.NaN;
          const finished = approvedAt ? Date.parse(approvedAt) : Number.NaN;
          const elapsedFromTimestamps =
            Number.isFinite(started) && Number.isFinite(finished) && finished >= started
              ? finished - started
              : undefined;
          const elapsed =
            elapsedFromTimestamps ??
            (measuredApprovalWaitMs !== undefined &&
            Number.isFinite(measuredApprovalWaitMs) &&
            measuredApprovalWaitMs >= 0
              ? measuredApprovalWaitMs
              : undefined);
          return {
            ...call,
            status,
            ...(grant ? { approvalGrant: grant } : {}),
            ...(elapsed === undefined
              ? {}
              : { approvalWaitMs: (call.approvalWaitMs ?? 0) + elapsed }),
          };
        })()
      : call,
  );
  return next;
}

function terminalApprovalStatus(status: AgentPendingApproval['status']): boolean {
  return ['succeeded', 'failed', 'cancelled', 'rejected', 'expired'].includes(status);
}

function sameCommandIdentity(
  left: AgentPendingApproval['commandIdentity'],
  right: AgentPendingApproval['commandIdentity'],
): boolean {
  if (!left || !right) return false;
  return (
    left.sessionId === right.sessionId &&
    left.threadId === right.threadId &&
    left.workspace === right.workspace &&
    left.canonicalWorkspaceIdentity === right.canonicalWorkspaceIdentity &&
    left.cwd === right.cwd &&
    left.executor === right.executor &&
    left.environment === right.environment &&
    left.scope === right.scope &&
    left.effects === right.effects &&
    left.parserRevision === right.parserRevision &&
    (left.executorRevision ?? '') === (right.executorRevision ?? '') &&
    left.commandDigest === right.commandDigest
  );
}

function restorePendingAfterClear(
  pending: AgentPendingApproval,
  generation = pending.generation,
): AgentPendingApproval {
  const status = pending.route === 'auto' ? 'auto_reviewing' : 'awaiting_user';
  return pendingWithStatus(pending, status, {
    generation,
    fullModeBypassEligible: false,
    authorizationSource: undefined,
    receiptId: undefined,
  });
}

function pendingNeedsGenerationRebase(pending: AgentPendingApproval): boolean {
  return (
    !terminalApprovalStatus(pending.status) &&
    pending.status !== 'authorized_queued' &&
    pending.status !== 'running'
  );
}

/** Authorization and mode facts have one compile-time reducer owner. */
export function reduceAuthorizationState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'interaction_mode.changed': {
      const mode = interactionMode(stringField(payload, 'mode'));
      const changedAt = stringField(payload, 'changedAt');
      if (!mode || stringField(payload, 'source') !== 'user' || !changedAt) return state;
      const activeTask = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
      const modeChanged = state.mode !== mode;
      let next = {
        ...state,
        mode,
        interactionModeRevision: state.interactionModeRevision + (modeChanged ? 1 : 0),
        ...(activeTask
          ? {
              tasks: {
                ...state.tasks,
                [activeTask.taskId]: { ...activeTask, executionMode: undefined },
              },
            }
          : {}),
      };
      if (mode === 'full' && modeChanged) {
        // Eligibility was sealed by re-running the canonical governance
        // decision under Full mode when the request was created.  Release
        // only those still-current, not-yet-dispatched records, without
        // manufacturing an approval grant or user receipt.
        const pendingApprovals = new Map(state.pendingApprovals);
        let tools = next.tools;
        for (const [interactionId, pending] of pendingApprovals) {
          if (
            !pending.fullModePolicyBypassAllowed ||
            terminalApprovalStatus(pending.status) ||
            pending.status === 'authorized_queued' ||
            pending.status === 'running'
          ) {
            continue;
          }
          pendingApprovals.set(
            interactionId,
            pendingWithStatus(pending, 'authorized_queued', {
              fullModeBypassEligible: true,
              authorizationSource: 'mode_full',
              receiptId: undefined,
              dispatchState: 'before_dispatch',
            }),
          );
          tools = pendingToolStatus(
            { ...next, tools },
            pending.toolCallId,
            'authorized_queued',
          ).tools;
        }
        const activeApprovalId = chooseApprovalFocus(pendingApprovals);
        next = {
          ...next,
          tools,
          pendingApprovals,
          activeApprovalId,
          interactions: focusedInteraction(pendingApprovals, activeApprovalId),
        };
      } else if (mode !== 'full' && modeChanged) {
        const pendingApprovals = new Map(state.pendingApprovals);
        let tools = next.tools;
        for (const [interactionId, pending] of pendingApprovals) {
          if (pending.authorizationSource !== 'mode_full' || pending.status !== 'authorized_queued')
            continue;
          const restored = restorePendingAfterClear(pending);
          pendingApprovals.set(interactionId, restored);
          tools = pendingToolStatus(
            { ...next, tools },
            pending.toolCallId,
            restored.route === 'auto' ? 'awaiting_auto_review' : 'awaiting_approval',
          ).tools;
        }
        const activeApprovalId = chooseApprovalFocus(pendingApprovals);
        next = {
          ...next,
          tools,
          pendingApprovals,
          activeApprovalId,
          interactions: focusedInteraction(pendingApprovals, activeApprovalId),
        };
      }
      return next;
    }
    case 'approval.requested': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      if (!interactionId || !toolCallId) return state;
      if (state.pendingApprovals.has(interactionId)) return state;
      const route = pendingRoute(payload);
      const status = route === 'auto' ? 'queued_auto' : 'awaiting_user';
      const pending = pendingFromEvent(state, payload, interactionId, toolCallId, route, status);
      if (!ownerMatchesPending(pending, payload.owner)) return state;
      const pendingApprovals = new Map(state.pendingApprovals);
      pendingApprovals.set(interactionId, pending);
      const activeApprovalId = state.activeApprovalId ?? chooseApprovalFocus(pendingApprovals);
      const approvalHash = pending.approvalHash;
      let next = updateToolCall(state, toolCallId, (call) =>
        call
          ? {
              ...call,
              status: route === 'auto' ? 'awaiting_auto_review' : 'awaiting_approval',
              ...(approvalHash ? { approvalHash } : {}),
              ...(stringField(payload, 'createdAt')
                ? { approvalRequestedAt: stringField(payload, 'createdAt') }
                : {}),
            }
          : call,
      );
      next = {
        ...next,
        pendingApprovals,
        activeApprovalId,
        nextQueueSequence: nextQueueSequence(state, pending),
        approvalGeneration: Math.max(state.approvalGeneration, pending.generation),
        interactions: focusedInteraction(pendingApprovals, activeApprovalId),
      };
      return next;
    }
    case 'approval.granted': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const grant = approvalGrant(payload.grant);
      const generation = numberField(payload, 'generation');
      const receiptId = nonEmptyStringField(payload, 'receiptId');
      const pending = interactionId ? state.pendingApprovals.get(interactionId) : undefined;
      if (
        !interactionId ||
        !toolCallId ||
        grant !== 'approve_once' ||
        !receiptId ||
        generation === undefined ||
        !Number.isSafeInteger(generation) ||
        state.activeApprovalId !== interactionId ||
        !pending ||
        pending.toolCallId !== toolCallId ||
        !ownerMatchesPending(pending, payload.owner) ||
        pending.generation !== generation ||
        generation < state.approvalGeneration ||
        terminalApprovalStatus(pending.status) ||
        pending.status === 'authorized_queued'
      )
        return state;
      const pendingApprovals = new Map(state.pendingApprovals);
      pendingApprovals.set(
        interactionId,
        pendingWithStatus(pending, 'authorized_queued', {
          receiptId,
          authorizationSource: 'approve_once',
          dispatchState: 'before_dispatch',
        }),
      );
      const approvalReceipts = new Map(state.approvalReceipts);
      if (approvalReceipts.has(receiptId)) return state;
      const receipt: AgentApprovalReceipt = {
        receiptId,
        interactionId,
        toolCallId,
        generation,
        grant: 'approve_once',
        status: 'authorized_queued',
        dispatchState: 'before_dispatch',
      };
      approvalReceipts.set(receiptId, receipt);
      const next = pendingToolStatus(
        state,
        toolCallId,
        'authorized_queued',
        'approve_once',
        stringField(payload, 'createdAt'),
      );
      const activeApprovalId = chooseApprovalFocus(pendingApprovals);
      return approvalQueueState(next, pendingApprovals, activeApprovalId, {
        approvalReceipts,
        approvalGeneration: Math.max(state.approvalGeneration, generation),
      });
    }
    case 'approval.rejected': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const generation = numberField(payload, 'generation');
      const pending = interactionId ? state.pendingApprovals.get(interactionId) : undefined;
      if (
        !interactionId ||
        !toolCallId ||
        generation === undefined ||
        !Number.isSafeInteger(generation) ||
        state.activeApprovalId !== interactionId ||
        !pending ||
        pending.toolCallId !== toolCallId ||
        !ownerMatchesPending(pending, payload.owner) ||
        pending.generation !== generation ||
        generation < state.approvalGeneration ||
        terminalApprovalStatus(pending.status)
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
      const pendingApprovals = new Map(state.pendingApprovals);
      pendingApprovals.set(interactionId, pendingWithStatus(pending, 'rejected'));
      const activeApprovalId = chooseApprovalFocus(pendingApprovals);
      return approvalQueueState(next, pendingApprovals, activeApprovalId);
    }
    case 'approval.batch_released': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const grantKey = nonEmptyStringField(payload, 'grantKey');
      const grant = payload.grant;
      const generation = numberField(payload, 'generation');
      const sessionRevision = numberField(payload, 'sessionRevision');
      const matches = Array.isArray(payload.matches) ? payload.matches : [];
      const focused = interactionId ? state.pendingApprovals.get(interactionId) : undefined;
      if (
        !interactionId ||
        !toolCallId ||
        !grantKey ||
        grant !== 'same_command' ||
        generation === undefined ||
        sessionRevision === undefined ||
        !Number.isSafeInteger(generation) ||
        !Number.isSafeInteger(sessionRevision) ||
        sessionRevision !== state.revision ||
        state.activeApprovalId !== interactionId ||
        !focused ||
        focused.toolCallId !== toolCallId ||
        !ownerMatchesPending(focused, payload.owner) ||
        generation < state.approvalGeneration ||
        terminalApprovalStatus(focused.status)
      )
        return state;
      const pendingApprovals = new Map(state.pendingApprovals);
      const approvalReceipts = new Map(state.approvalReceipts);
      const suppliedCommandIdentity = recordField(payload, 'commandIdentity');
      if (!isCompleteCommandIdentity(suppliedCommandIdentity)) return state;
      const commandIdentity = suppliedCommandIdentity;
      const effectiveGrantKey = grantKey;
      const grantRecord: AgentSessionCommandGrant = {
        grant: 'same_command',
        grantKey: effectiveGrantKey,
        sessionId: commandIdentity.sessionId,
        threadId: commandIdentity.threadId,
        workspace: commandIdentity.workspace,
        canonicalWorkspaceIdentity: commandIdentity.canonicalWorkspaceIdentity,
        cwd: commandIdentity.cwd,
        executor: commandIdentity.executor,
        environment: commandIdentity.environment,
        scope: commandIdentity.scope,
        effects: commandIdentity.effects,
        parserRevision: commandIdentity.parserRevision,
        ...(commandIdentity.executorRevision
          ? { executorRevision: commandIdentity.executorRevision }
          : {}),
        commandDigest: commandIdentity.commandDigest,
        createdAt: stringField(payload, 'createdAt') ?? '1970-01-01T00:00:00.000Z',
        generation,
      };
      const canonicalGrantKey = approvalCommandGrantKey(commandIdentity);
      if (grantKey !== canonicalGrantKey) return state;
      const sessionCommandGrants = new Map(state.sessionCommandGrants);
      const matchIds = new Map(
        matches
          .map((value) =>
            value && typeof value === 'object' ? (value as Record<string, unknown>) : null,
          )
          .filter((value): value is Record<string, unknown> => value !== null)
          .map((value) => [stringOrUndefined(value.interactionId), value] as const)
          .filter(([id]) => id !== undefined),
      );
      const matchReceipts = new Set<string>();
      for (const match of matchIds.values()) {
        const matchReceipt = stringOrUndefined(match.receiptId);
        if (!matchReceipt || matchReceipts.has(matchReceipt)) return state;
        matchReceipts.add(matchReceipt);
      }
      const focusedMatch = matchIds.get(interactionId);
      if (
        !focusedMatch ||
        stringOrUndefined(focusedMatch.toolCallId) !== toolCallId ||
        stringOrUndefined(focusedMatch.receiptId) === undefined ||
        numberField(focusedMatch, 'generation') !== generation ||
        !ownerMatchesPending(focused, focusedMatch.owner)
      )
        return state;
      const eligibleMatches = new Set<string>();
      let next = state;
      for (const [pendingId, pending] of pendingApprovals) {
        const match = matchIds.get(pendingId);
        const sameGeneration =
          pending.generation === generation &&
          match !== undefined &&
          numberField(match, 'generation') === generation;
        const eligible =
          match !== undefined &&
          sameGeneration &&
          !terminalApprovalStatus(pending.status) &&
          pending.status !== 'running' &&
          pending.status !== 'authorized_queued' &&
          stringOrUndefined(match.toolCallId) === pending.toolCallId &&
          ownerMatchesPending(pending, match.owner) &&
          sameCommandIdentity(pending.commandIdentity, commandIdentity) &&
          (match.bindingDigest === undefined || match.bindingDigest === pending.bindingDigest);
        if (!eligible) continue;
        const matchReceipt = stringOrUndefined(match.receiptId);
        if (!matchReceipt || approvalReceipts.has(matchReceipt)) continue;
        eligibleMatches.add(pendingId);
        pendingApprovals.set(
          pendingId,
          pendingWithStatus(pending, 'authorized_queued', {
            receiptId: matchReceipt,
            authorizationSource: 'same_command',
            dispatchState: 'before_dispatch',
          }),
        );
        const receipt: AgentApprovalReceipt = {
          receiptId: matchReceipt,
          interactionId: pending.interactionId,
          toolCallId: pending.toolCallId,
          generation,
          grant: 'same_command',
          status: 'authorized_queued',
          dispatchState: 'before_dispatch',
        };
        approvalReceipts.set(matchReceipt, receipt);
        next = pendingToolStatus(
          next,
          pending.toolCallId,
          'authorized_queued',
          'same_command',
          stringField(payload, 'createdAt'),
        );
      }
      // The focused invocation must be one of the newly sealed matches. Do
      // not persist a session grant for an empty/losing batch.
      if (!eligibleMatches.has(interactionId)) return state;
      sessionCommandGrants.set(canonicalGrantKey, grantRecord);
      // An auto reviewer that is no longer awaiting dispatch cannot mutate the
      // invocation after this batch.  Keep it terminal so replay is a no-op.
      const cancelledReviewIds = Array.isArray(payload.cancelledReviewIds)
        ? payload.cancelledReviewIds.filter((value): value is string => typeof value === 'string')
        : [];
      for (const reviewId of cancelledReviewIds) {
        const pending = pendingApprovals.get(reviewId);
        if (
          !pending ||
          pending.status === 'authorized_queued' ||
          pending.status === 'running' ||
          terminalApprovalStatus(pending.status) ||
          pending.route !== 'auto'
        )
          continue;
        pendingApprovals.set(reviewId, pendingWithStatus(pending, 'cancelled'));
      }
      const activeApprovalId = chooseApprovalFocus(pendingApprovals);
      return approvalQueueState(next, pendingApprovals, activeApprovalId, {
        sessionCommandGrants,
        approvalReceipts,
        approvalGeneration: Math.max(state.approvalGeneration, generation),
      });
    }
    case 'approval.session_grants_cleared': {
      const sessionId = nonEmptyStringField(payload, 'sessionId');
      const sessionRevision = numberField(payload, 'sessionRevision');
      const generation = numberField(payload, 'generation');
      if (
        sessionId !== state.session.threadId ||
        sessionRevision === undefined ||
        !Number.isSafeInteger(sessionRevision) ||
        sessionRevision !== state.revision ||
        generation === undefined ||
        !Number.isSafeInteger(generation) ||
        generation <= state.approvalGeneration
      )
        return state;
      const pendingApprovals = new Map(state.pendingApprovals);
      let next = state;
      for (const [interactionId, pending] of pendingApprovals) {
        if (
          pending.authorizationSource === 'same_command' &&
          pending.status === 'authorized_queued'
        ) {
          const restored = restorePendingAfterClear(pending, generation);
          pendingApprovals.set(interactionId, restored);
          next = pendingToolStatus(
            { ...next, pendingApprovals },
            pending.toolCallId,
            restored.route === 'auto' ? 'awaiting_auto_review' : 'awaiting_approval',
          );
        } else if (pendingNeedsGenerationRebase(pending)) {
          pendingApprovals.set(
            interactionId,
            pendingWithStatus(pending, pending.status, { generation }),
          );
        }
      }
      const activeApprovalId = chooseApprovalFocus(pendingApprovals);
      return approvalQueueState(next, pendingApprovals, activeApprovalId, {
        sessionCommandGrants: new Map(),
        approvalGeneration: generation,
      });
    }
    case 'turn.aborted': {
      const turnId = nonEmptyStringField(payload, 'turnId');
      if (!turnId || turnId !== state.turn.turnId) return state;
      const calls = { ...state.tools.calls };
      const approvalReceipts = new Map(state.approvalReceipts);
      for (const pending of state.pendingApprovals.values()) {
        if (pending.receiptId) {
          const receipt = approvalReceipts.get(pending.receiptId);
          if (receipt && receipt.status !== 'terminal') {
            approvalReceipts.set(pending.receiptId, { ...receipt, status: 'terminal' });
          }
        }
        const call = calls[pending.toolCallId];
        if (
          call &&
          !['succeeded', 'failed', 'rejected', 'cancelled', 'exhausted'].includes(call.status)
        ) {
          calls[pending.toolCallId] = { ...call, status: 'cancelled' };
        }
      }
      return {
        ...state,
        pendingApprovals: new Map(),
        sessionCommandGrants: new Map(),
        approvalReceipts,
        activeApprovalId: null,
        approvalGeneration: state.approvalGeneration + 1,
        interactions: { kind: 'idle' },
        tools: { ...state.tools, calls, queue: [], active: [] },
        suspendedSubagents: {},
      };
    }
    case 'tool.started': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      if (!toolCallId) return state;
      const pendingApprovals = new Map(state.pendingApprovals);
      const approvalReceipts = new Map(state.approvalReceipts);
      let changed = false;
      for (const [interactionId, pending] of pendingApprovals) {
        if (pending.toolCallId !== toolCallId || pending.status !== 'authorized_queued') continue;
        pendingApprovals.set(
          interactionId,
          pendingWithStatus(pending, 'running', { dispatchState: 'dispatch_acked' }),
        );
        if (pending.receiptId) {
          const receipt = approvalReceipts.get(pending.receiptId);
          if (receipt)
            approvalReceipts.set(pending.receiptId, {
              ...receipt,
              status: 'running',
              dispatchState: 'dispatch_acked',
            });
        }
        changed = true;
      }
      return changed
        ? approvalQueueState(state, pendingApprovals, chooseApprovalFocus(pendingApprovals), {
            approvalReceipts,
          })
        : state;
    }
    case 'tool.finished':
    case 'tool.failed':
    case 'tool.rejected':
    case 'tool.cancelled': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      if (!toolCallId) return state;
      const terminalStatus: AgentPendingApproval['status'] =
        event.type === 'tool.finished'
          ? 'succeeded'
          : event.type === 'tool.cancelled'
            ? 'cancelled'
            : event.type === 'tool.rejected'
              ? 'rejected'
              : 'failed';
      const pendingApprovals = new Map(state.pendingApprovals);
      const approvalReceipts = new Map(state.approvalReceipts);
      let changed = false;
      for (const [interactionId, pending] of pendingApprovals) {
        if (pending.toolCallId !== toolCallId || terminalApprovalStatus(pending.status)) continue;
        pendingApprovals.set(
          interactionId,
          pendingWithStatus(pending, terminalStatus, { dispatchState: pending.dispatchState }),
        );
        if (pending.receiptId) {
          const receipt = approvalReceipts.get(pending.receiptId);
          if (receipt) approvalReceipts.set(pending.receiptId, { ...receipt, status: 'terminal' });
        }
        changed = true;
      }
      return changed
        ? approvalQueueState(state, pendingApprovals, chooseApprovalFocus(pendingApprovals), {
            approvalReceipts,
          })
        : state;
    }
    case 'approval.command_replaced':
      return state;
    case 'auto_review.requested': {
      const interactionId = nonEmptyStringField(payload, 'reviewId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const toolName = stringField(payload, 'toolName');
      const reason = stringField(payload, 'reason');
      if (!interactionId || !toolCallId || !toolName || reason === undefined) return state;
      if (state.pendingApprovals.has(interactionId)) return state;
      const queuePayload = { ...payload, approvalRoute: 'auto' };
      const pending = pendingFromEvent(
        state,
        queuePayload,
        interactionId,
        toolCallId,
        'auto',
        'auto_reviewing',
      );
      if (!ownerMatchesPending(pending, payload.owner)) return state;
      const pendingApprovals = new Map(state.pendingApprovals);
      pendingApprovals.set(interactionId, pending);
      const activeApprovalId = state.activeApprovalId ?? chooseApprovalFocus(pendingApprovals);
      const approvalHash = pending.approvalHash;
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
        pendingApprovals,
        activeApprovalId,
        nextQueueSequence: nextQueueSequence(state, pending),
        approvalGeneration: Math.max(state.approvalGeneration, pending.generation),
        ...(fingerprint
          ? {
              doomLoop: kernelUpdateDoomLoopTracker(
                next.doomLoop,
                fingerprint,
                Number.isFinite(observedAt) ? observedAt : 0,
              ),
            }
          : {}),
        interactions: focusedInteraction(pendingApprovals, activeApprovalId),
      };
    }
    case 'auto_review.completed': {
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const reviewId = nonEmptyStringField(payload, 'reviewId');
      const pending = reviewId ? state.pendingApprovals.get(reviewId) : undefined;
      if (
        !toolCallId ||
        !reviewId ||
        !pending ||
        pending.toolCallId !== toolCallId ||
        !ownerMatchesPending(pending, payload.owner) ||
        terminalApprovalStatus(pending.status) ||
        pending.status === 'authorized_queued' ||
        pending.status === 'running'
      )
        return state;
      const result = jsonRecord(payload.result);
      const resultFields = result as Readonly<Record<string, unknown>>;
      const createdAt = stringField(payload, 'createdAt');
      const parsedObservedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
      const observedAt = Number.isFinite(parsedObservedAt) ? parsedObservedAt : 0;
      const rejectionReason =
        typeof resultFields.reason === 'string' ? resultFields.reason : 'auto-review rejected';
      const reviewDurationMs = numberField(resultFields, 'durationMs');
      const pendingApprovals = new Map(state.pendingApprovals);
      const needsUser = resultFields.approved !== true && resultFields.escalatedToUser === true;
      if (needsUser) {
        const userPending = pendingWithStatus(pending, 'awaiting_user', { route: 'user' });
        pendingApprovals.set(reviewId, userPending);
        const next = pendingToolStatus(
          state,
          toolCallId,
          'awaiting_approval',
          undefined,
          undefined,
          reviewDurationMs,
        );
        const activeApprovalId = state.activeApprovalId ?? chooseApprovalFocus(pendingApprovals);
        return approvalQueueState(next, pendingApprovals, activeApprovalId);
      }
      const approved = resultFields.ok !== false && resultFields.approved === true;
      if (approved) {
        const receiptId = `auto:${reviewId}:${pending.generation}`;
        if (state.approvalReceipts.has(receiptId)) return state;
        pendingApprovals.set(
          reviewId,
          pendingWithStatus(pending, 'authorized_queued', {
            receiptId,
            authorizationSource: 'approve_once',
            dispatchState: 'before_dispatch',
          }),
        );
        const approvalReceipts = new Map(state.approvalReceipts);
        approvalReceipts.set(receiptId, {
          receiptId,
          interactionId: reviewId,
          toolCallId,
          generation: pending.generation,
          grant: 'approve_once',
          status: 'authorized_queued',
          dispatchState: 'before_dispatch',
        });
        const next = pendingToolStatus(
          state,
          toolCallId,
          'authorized_queued',
          'approve_once',
          undefined,
          reviewDurationMs,
        );
        const activeApprovalId = chooseApprovalFocus(pendingApprovals);
        return approvalQueueState(next, pendingApprovals, activeApprovalId, { approvalReceipts });
      }
      pendingApprovals.set(
        reviewId,
        pendingWithStatus(pending, 'rejected', { authorizationSource: undefined }),
      );
      const next = updateToolCall(state, toolCallId, (call) =>
        call
          ? {
              ...call,
              status: 'rejected',
              error: rejectionReason,
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
          : call,
      );
      const activeApprovalId = chooseApprovalFocus(pendingApprovals);
      return approvalQueueState(next, pendingApprovals, activeApprovalId, {
        autoReview: evaluateAutoReviewCircuit(next.autoReview, {
          kind: 'rejection',
          observedAt,
          toolName:
            stringOrUndefined((pending.approval as unknown as Record<string, unknown>).tool) ??
            'shell_execute',
          reason: rejectionReason,
        }),
      });
    }
    default:
      return state;
  }
}
