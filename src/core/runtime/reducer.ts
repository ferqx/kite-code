// ── Agent Runtime Kernel 运行时状态 reducer / Runtime state reducer ──
// Phase 2: 纯函数 reduceRuntimeState — 将 RuntimeEvent 应用到 RuntimeState，返回新的不可变状态
// Phase 2: Pure function reduceRuntimeState — applies a RuntimeEvent to RuntimeState, returns new immutable state

import { createHash } from 'node:crypto';
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  evaluateCircuitBreaker,
} from '@/core/execution/circuit-breaker';
import { updateAutoCompactionGuard } from '@/core/model/context-compaction-decision';
import { classifyToolCapability } from '@/core/policies/tool-capabilities';
import { validateVerificationSpec } from '@/core/verification/spec';
import type { AgentPlan, PlanDocument, PlanStep } from '@/protocol/events';
import {
  createContextCorrectnessBlock,
  isContextHardBlockReason,
  normalizeContextCompactionReason,
} from './context-compaction';
import type { RuntimeEvent } from './events';
import { classifyFailure } from './failures';
import { reduceResourceBudgetStateV1 } from './resource-budget';
import {
  computePlanStructuralDigest,
  getActivePlanning,
  getActiveTask,
  type RuntimeState,
  setActivePlanning,
  type ToolCallRecord,
  type ToolResultMeta,
  type TranscriptMessage,
  updateActiveTask,
} from './state';
import { normalizeTerminalRuntimeEventV1 } from './terminal-outcome';

function transcriptMeta(state: RuntimeState, messageId: string, createdAt?: string) {
  return {
    messageId,
    turnId: state.turn.turnId,
    ordinal: state.transcript.messages.length,
    createdAt: createdAt ?? new Date(0).toISOString(),
  };
}

type ToolTranscriptMessage = Extract<TranscriptMessage, { kind: 'tool' }>;

/**
 * Runtime events remain chronological, but the canonical transcript keeps
 * sibling Tool Results in assistant declaration order. This makes model
 * context deterministic when parallel reads finish in a different order.
 */
function appendToolTranscriptMessage(
  state: RuntimeState,
  message: ToolTranscriptMessage,
): RuntimeState['transcript'] {
  const messages: TranscriptMessage[] = [...state.transcript.messages, message];
  const sourceCall = state.tools.calls[message.toolCallId];
  if (sourceCall?.modelMessageId) {
    const positions = messages.flatMap((candidate, index) => {
      if (candidate.kind !== 'tool') return [];
      return state.tools.calls[candidate.toolCallId]?.modelMessageId === sourceCall.modelMessageId
        ? [index]
        : [];
    });
    const ordered = positions
      .map((index) => ({ index, message: messages[index] as ToolTranscriptMessage }))
      .sort((left, right) => {
        const leftOrdinal = state.tools.calls[left.message.toolCallId]?.ordinal;
        const rightOrdinal = state.tools.calls[right.message.toolCallId]?.ordinal;
        if (leftOrdinal == null && rightOrdinal == null) return left.index - right.index;
        if (leftOrdinal == null) return 1;
        if (rightOrdinal == null) return -1;
        return leftOrdinal - rightOrdinal || left.index - right.index;
      })
      .map((entry) => entry.message);
    for (const [orderedIndex, position] of positions.entries()) {
      messages[position] = ordered[orderedIndex]!;
    }
  }
  return {
    ...state.transcript,
    messages: messages.map((candidate, ordinal) => ({ ...candidate, ordinal })),
  };
}

function stringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toolResultMeta(
  call: ToolCallRecord,
  event: Extract<RuntimeEvent, { type: 'tool.finished' }>,
): ToolResultMeta {
  const supplied = event.result.resultMeta ?? {};
  const path = supplied.path ?? stringArg(call.args, 'path') ?? stringArg(call.args, 'uri');
  const intent =
    supplied.intent ??
    (call.args && typeof call.args === 'object'
      ? stringArg((call.args as Record<string, unknown>).action, 'intent')
      : undefined);
  const effect = call.effectClass ?? classifyToolCapability(call.name, call.args).effectClass;
  const workspaceMutationScope =
    supplied.workspaceMutationScope ??
    (event.result.ok &&
    (effect === 'workspace_write' || (effect === 'unknown' && call.sideEffect)) &&
    path
      ? [path]
      : undefined);
  const fallbackModelDigest = createHash('sha256')
    .update(event.result.stdout || event.result.stderr)
    .digest('hex');
  return {
    ...supplied,
    ...(path ? { path } : {}),
    ...(event.result.totalLines != null ? { totalLines: event.result.totalLines } : {}),
    ...(event.result.command ? { command: event.result.command } : {}),
    ...(intent ? { intent } : {}),
    ...(workspaceMutationScope ? { workspaceMutationScope } : {}),
    contentDigest: supplied.contentDigest ?? supplied.modelContentDigest ?? fallbackModelDigest,
    modelContentDigest:
      supplied.modelContentDigest ?? supplied.contentDigest ?? fallbackModelDigest,
    rawResultDigest:
      supplied.rawResultDigest ??
      (supplied.truncated ? undefined : (supplied.contentDigest ?? fallbackModelDigest)),
    digestScope:
      supplied.digestScope ??
      (supplied.truncated ? 'projected' : supplied.contentDigest ? 'raw' : 'legacy_unknown'),
  };
}

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
  event = normalizeTerminalRuntimeEventV1(event);
  switch (event.type) {
    case 'resource_budget.configured':
    case 'resource_budget.reserved':
    case 'resource_budget.dispatch_started':
    case 'resource_budget.reconciled':
    case 'resource_budget.released':
    case 'resource_budget.unknown':
    case 'resource_budget.waiter_enqueued':
    case 'resource_budget.waiter_promoted':
    case 'resource_budget.waiter_cancelled':
    case 'resource_budget.waiter_timed_out':
      return {
        ...state,
        resourceBudget: reduceResourceBudgetStateV1(state.resourceBudget, event),
      };

    case 'context.compaction_requested': {
      const pending = state.context.pendingCompaction;
      if (pending && pending.compactionId !== event.compactionId) return state;
      const reason = normalizeContextCompactionReason(event.reason);
      if (!reason) return state;
      const consumesRecovery =
        reason === 'auto' &&
        state.context.lastFailure?.reason === 'auto' &&
        state.context.lastFailure.retryable &&
        state.context.lastFailure.requestedAtTurnId !== event.requestedAtTurnId;
      return {
        ...state,
        context: {
          ...state.context,
          pendingCompaction: {
            compactionId: event.compactionId,
            reason,
            requestedAtRevision: event.requestedAtRevision,
            requestedAtTurnId: event.requestedAtTurnId,
            force: false,
            estimate: event.estimate,
            ...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
          },
          lastFailure: undefined,
          autoGuard: consumesRecovery
            ? { ...state.context.autoGuard, recoveryAttempted: true }
            : state.context.autoGuard,
        },
      };
    }

    case 'context.compaction_completed': {
      if (
        state.context.pendingCompaction?.compactionId !== event.compactionId ||
        event.checkpoint.compactionId !== event.compactionId ||
        event.checkpoint.sourceRevision !== event.sourceRevision
      )
        return state;
      const reason = normalizeContextCompactionReason(event.checkpoint.reason);
      if (!reason) return state;
      const checkpoint = { ...event.checkpoint, reason };
      const reductionRatio =
        checkpoint.inputTokensBefore > 0
          ? 1 - checkpoint.inputTokensAfter / checkpoint.inputTokensBefore
          : 0;
      return {
        ...state,
        context: {
          ...state.context,
          activeCheckpoint: checkpoint,
          pendingCompaction: undefined,
          lastFailure: undefined,
          history: [...state.context.history, { kind: 'completed' as const, checkpoint }].slice(
            -128,
          ),
          lastCompactionTurnIndex: state.turn.turnIndex,
          autoGuard:
            checkpoint.reason === 'auto'
              ? updateAutoCompactionGuard(state.context.autoGuard, {
                  kind: 'completed',
                  turnIndex: state.turn.turnIndex,
                  reductionRatio,
                  tokensAfter: checkpoint.inputTokensAfter,
                })
              : checkpoint.reason === 'manual'
                ? updateAutoCompactionGuard(state.context.autoGuard, { kind: 'manual_reset' })
                : state.context.autoGuard,
        },
      };
    }

    case 'context.compaction_failed': {
      if (state.context.pendingCompaction?.compactionId !== event.compactionId) return state;
      const reason = state.context.pendingCompaction.reason;
      const failure = {
        compactionId: event.compactionId,
        sourceRevision: event.sourceRevision,
        errorKind: event.errorKind,
        message: event.message,
        retryable: event.retryable,
        reason,
        requestedAtTurnId:
          event.requestedAtTurnId ?? state.context.pendingCompaction.requestedAtTurnId,
      };
      // Automatic failures may update the breaker, but never create or refresh
      // a durable Runtime correctness block.
      const isAutoLowGain = reason === 'auto' && event.errorKind === 'insufficient_reduction';
      const autoGuard = isAutoLowGain
        ? updateAutoCompactionGuard(state.context.autoGuard, { kind: 'low_gain' })
        : state.context.autoGuard;

      return {
        ...state,
        context: {
          ...state.context,
          pendingCompaction: undefined,
          lastFailure: failure,
          autoGuard,
          history: [...state.context.history, { kind: 'failed' as const, failure }].slice(-128),
        },
      };
    }

    case 'context.compaction_reset': {
      if (state.context.activeCheckpoint?.compactionId !== event.checkpointId) return state;
      return {
        ...state,
        context: {
          ...state.context,
          activeCheckpoint: undefined,
          autoGuard: updateAutoCompactionGuard(state.context.autoGuard, { kind: 'manual_reset' }),
          history: [
            ...state.context.history,
            {
              kind: 'reset' as const,
              compactionId: event.checkpointId,
              reason: event.reason,
            },
          ].slice(-128),
        },
      };
    }

    case 'context.hard_blocked': {
      if (!isContextHardBlockReason(event.reason)) return state;
      return {
        ...state,
        context: {
          ...state.context,
          hardBlock: createContextCorrectnessBlock({
            reason: event.reason,
            sourceDigest: event.sourceDigest,
            message: event.message,
            createdAtTurnId: event.createdAtTurnId,
          }),
        },
      };
    }

    case 'context.hard_block_cleared': {
      const block = state.context.hardBlock;
      if (!block || block.reason !== event.reason || block.sourceDigest !== event.sourceDigest)
        return state;
      return {
        ...state,
        context: { ...state.context, hardBlock: undefined },
      };
    }

    case 'task.started': {
      const task = {
        taskId: event.taskId,
        userGoal: event.userGoal,
        status: 'active' as const,
        startedAtTurnId: event.turnId,
        sideEffectsStarted: false,
        planning: { kind: 'building_without_plan' as const },
        planHistory: [],
      };
      return {
        ...state,
        activeTaskId: task.taskId,
        tasks: { ...state.tasks, [task.taskId]: task },
        planning: task.planning,
        interactions: { kind: 'idle' },
      };
    }

    case 'planning.entered': {
      const active = getActiveTask(state);
      if (!active || active.taskId !== event.taskId || active.status !== 'active') return state;
      const planning = getActivePlanning(state);
      if (
        active.sideEffectsStarted ||
        planning.kind === 'executing' ||
        planning.kind === 'awaiting_review' ||
        planning.kind === 'completed' ||
        planning.kind === 'cancelled'
      )
        return state;
      if (
        planning.kind === 'planning_empty' ||
        planning.kind === 'planning_draft' ||
        planning.kind === 'replanning_draft'
      )
        return state;
      return setActivePlanning(state, { kind: 'planning_empty' });
    }

    case 'task.completed': {
      const active = getActiveTask(state);
      if (!active || active.taskId !== event.taskId) return state;
      const completed = {
        ...active,
        status: 'completed' as const,
        completedAtTurnId: event.turnId,
        executionMode: undefined,
      };
      return {
        ...state,
        activeTaskId: null,
        tasks: { ...state.tasks, [completed.taskId]: completed },
        planning: completed.planning,
      };
    }

    case 'task.cancelled': {
      const active = getActiveTask(state);
      if (!active || active.taskId !== event.taskId) return state;
      const cancelled = { ...active, status: 'cancelled' as const, executionMode: undefined };
      return {
        ...state,
        activeTaskId: null,
        tasks: { ...state.tasks, [cancelled.taskId]: cancelled },
        planning: cancelled.planning,
      };
    }

    case 'planning.exited':
      return state;

    // ── 方案生命周期 / Plan lifecycle ──

    case 'plan.review_requested': {
      if (event.taskId && state.activeTaskId !== event.taskId) return state;
      const planning = getActivePlanning(state);
      const doc = planDocumentFromAgentPlan(event.plan, state.turn.turnId);
      const inherited =
        planning.kind === 'planning_draft' || planning.kind === 'replanning_draft'
          ? {
              planId: planning.document.planId,
              version: event.version ?? planning.document.version,
            }
          : { planId: event.planId ?? doc.planId, version: event.version ?? 1 };
      const priorDocument =
        planning.kind === 'planning_draft' || planning.kind === 'replanning_draft'
          ? planning.document
          : undefined;
      const document: PlanDocument = {
        ...doc,
        planId: inherited.planId,
        version: inherited.version,
        structuralDigest: event.structuralDigest ?? computePlanStructuralDigest(doc),
        ...(event.artifact ? { artifact: event.artifact } : {}),
        ...(planning.kind === 'replanning_draft' || priorDocument?.supersedesPlanVersion != null
          ? {
              supersedesPlanVersion:
                planning.kind === 'replanning_draft'
                  ? planning.supersedesPlanVersion
                  : priorDocument?.supersedesPlanVersion,
              replanReason:
                planning.kind === 'replanning_draft'
                  ? planning.replanReason
                  : (priorDocument?.replanReason ?? ''),
            }
          : {}),
      };
      const next = setActivePlanning(state, {
        kind: 'awaiting_review',
        document,
        interactionId: event.interactionId,
        exitToolCallId: event.toolCallId,
      });
      return {
        ...next,
        tools: updateToolStatus(next.tools, event.toolCallId, 'awaiting_review'),
        interactions: {
          kind: 'awaiting_review',
          interactionId: event.interactionId,
          toolCallId: event.toolCallId,
          planId: document.planId,
          version: document.version,
          structuralDigest: document.structuralDigest,
          plan: event.plan,
          planSummary: event.planSummary,
          ...(event.artifact ? { artifact: event.artifact } : {}),
        },
      };
    }

    case 'plan.approved': {
      // 仅当方案在 awaiting_review 状态时转换为 executing
      // Only transition to executing when plan is in awaiting_review
      const planning = getActivePlanning(state);
      if (planning.kind !== 'awaiting_review') return state;
      if (
        state.interactions.kind !== 'awaiting_review' ||
        state.interactions.interactionId !== event.interactionId ||
        event.toolCallId !== state.interactions.toolCallId ||
        event.planId !== state.interactions.planId ||
        event.version !== state.interactions.version ||
        event.structuralDigest !== state.interactions.structuralDigest
      ) {
        return state;
      }
      const next = setActivePlanning(state, {
        kind: 'executing',
        document: planning.document,
        executionMode: event.executionMode,
        approvedAtTurnId: state.turn.turnId,
      });
      const legacyMode = getActiveTask(state) ? {} : { mode: event.executionMode };
      return updateActiveTask(
        { ...next, ...legacyMode, interactions: { kind: 'idle' } },
        (task) => ({ ...task, executionMode: event.executionMode }),
      );
    }

    case 'plan.revision_requested': {
      // 从 awaiting_review 迁回 planning_draft，携带修订反馈
      // Transition from awaiting_review back to planning_draft with revision feedback
      const planning = getActivePlanning(state);
      if (planning.kind !== 'awaiting_review') return state;
      if (
        state.interactions.kind !== 'awaiting_review' ||
        state.interactions.interactionId !== event.interactionId ||
        event.toolCallId !== state.interactions.toolCallId ||
        event.planId !== state.interactions.planId ||
        event.version !== state.interactions.version ||
        event.structuralDigest !== state.interactions.structuralDigest
      ) {
        return state;
      }
      return {
        ...setActivePlanning(state, {
          kind: 'planning_draft',
          document: planning.document,
          revisionFeedback: event.feedback,
        }),
        interactions: { kind: 'idle' },
      };
    }

    case 'plan.review_cancelled': {
      const planning = getActivePlanning(state);
      if (planning.kind !== 'awaiting_review') return state;
      if (
        state.interactions.kind !== 'awaiting_review' ||
        state.interactions.interactionId !== event.interactionId ||
        event.toolCallId !== state.interactions.toolCallId ||
        event.planId !== state.interactions.planId ||
        event.version !== state.interactions.version ||
        event.structuralDigest !== state.interactions.structuralDigest
      )
        return state;
      return {
        ...setActivePlanning(state, {
          kind: 'planning_draft',
          document: planning.document,
          revisionFeedback: event.reason,
        }),
        interactions: { kind: 'idle' },
      };
    }

    case 'plan.replan_requested': {
      const planning = getActivePlanning(state);
      if (planning.kind !== 'executing') return state;
      const nextPlanning = {
        kind: 'replanning_draft' as const,
        document: planning.document,
        supersedesPlanVersion: event.supersedesPlanVersion,
        replanReason: event.reason,
      };
      return updateActiveTask(
        {
          ...setActivePlanning(state, nextPlanning),
          interactions: { kind: 'idle' },
        },
        (task) => ({ ...task, planHistory: [...task.planHistory, planning.document] }),
      );
    }

    case 'plan.rejected': {
      if (
        state.interactions.kind !== 'awaiting_review' ||
        state.interactions.interactionId !== event.interactionId ||
        event.toolCallId !== state.interactions.toolCallId ||
        event.planId !== state.interactions.planId ||
        event.version !== state.interactions.version ||
        event.structuralDigest !== state.interactions.structuralDigest
      ) {
        return state;
      }
      const rejectedPlanning = getActivePlanning(state);
      if (rejectedPlanning.kind !== 'awaiting_review') return state;
      const toolCallId =
        state.interactions.kind === 'awaiting_review'
          ? state.interactions.toolCallId
          : rejectedPlanning.exitToolCallId;
      const next = setActivePlanning(state, {
        kind: 'planning_draft',
        document: rejectedPlanning.document,
        revisionFeedback: event.reason,
      });
      return {
        ...next,
        tools: closeToolCall(next.tools, toolCallId),
        interactions: { kind: 'idle' },
      };
    }

    // ── 工具生命周期 / Tool lifecycle ──

    case 'capability.bindings_issued': {
      const bindings = Object.fromEntries(
        event.bindings.map((binding) => [binding.bindingId, binding]),
      );
      const disclosures = Object.fromEntries(
        (event.disclosures ?? []).map((disclosure) => [disclosure.capabilityId, disclosure]),
      );
      const loadedCapabilities = Object.fromEntries(
        (
          event.loadedCapabilities ?? Object.values(state.capabilities.loadedCapabilities ?? {})
        ).map((loaded) => [loaded.capabilityId, loaded]),
      );
      return {
        ...state,
        capabilities: {
          catalogRevision: event.catalogRevision,
          bindings,
          disclosures,
          loadedCapabilities,
          ...(event.searchId === state.capabilities.pendingSearch?.searchId
            ? {}
            : state.capabilities.pendingSearch
              ? { pendingSearch: state.capabilities.pendingSearch }
              : {}),
          invocations: state.capabilities.invocations,
        },
      };
    }

    case 'capability.search_completed':
      return {
        ...state,
        capabilities: {
          ...state.capabilities,
          pendingSearch: event.result,
        },
      };

    case 'skill.catalog_refreshed':
      return {
        ...state,
        skills: { ...state.skills, catalogRevision: event.catalogRevision },
      };

    case 'skill.activation_started': {
      const activation = event.activation;
      if (state.skills.frames[activation.activationId]) return state;
      if (state.activeTaskId !== activation.taskId) return state;
      return {
        ...state,
        skills: {
          ...state.skills,
          frames: {
            ...state.skills.frames,
            [activation.activationId]: { ...activation, status: 'active' },
          },
        },
      };
    }

    case 'skill.frame_closed': {
      const frame = state.skills.frames[event.activationId];
      if (frame?.status !== 'active') return state;
      return {
        ...state,
        skills: {
          ...state.skills,
          frames: {
            ...state.skills.frames,
            [event.activationId]: {
              ...frame,
              status: event.status,
              closedAt: event.closedAt,
              closeReason: event.reason,
              ...(event.output ? { output: event.output } : {}),
            },
          },
        },
      };
    }

    case 'capability.invocation_recorded': {
      if (state.capabilities.invocations[event.invocationId]) return state;
      return {
        ...state,
        capabilities: {
          ...state.capabilities,
          invocations: {
            ...state.capabilities.invocations,
            [event.invocationId]: {
              invocationId: event.invocationId,
              toolCallId: event.toolCallId,
              capabilityId: event.capabilityId,
              capabilityRevision: event.capabilityRevision,
              ...(event.taskId ? { taskId: event.taskId } : {}),
              ...(event.planId ? { planId: event.planId } : {}),
              ...(event.planStepId ? { planStepId: event.planStepId } : {}),
              argumentsDigest: event.argumentsDigest,
              authorizationDigest: event.authorizationDigest,
              effectiveEffectsDigest: event.effectiveEffectsDigest,
              status: 'recorded',
              recordedAt: event.recordedAt,
              ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
            },
          },
        },
      };
    }

    case 'capability.execution_started':
      return updateCapabilityInvocation(state, event.invocationId, (invocation) =>
        invocation.status === 'recorded'
          ? { ...invocation, status: 'running', startedAt: event.startedAt }
          : invocation,
      );

    case 'capability.execution_succeeded':
      return updateCapabilityInvocation(state, event.invocationId, (invocation) => ({
        ...invocation,
        status: 'succeeded',
        finishedAt: event.finishedAt,
        resultDigest: event.resultDigest,
        evidenceDigest: event.evidenceDigest,
        ...(event.artifact ? { artifact: event.artifact } : {}),
        ...(event.externalReferences ? { externalReferences: event.externalReferences } : {}),
        error: undefined,
      }));

    case 'capability.execution_failed':
      return updateCapabilityInvocation(state, event.invocationId, (invocation) => ({
        ...invocation,
        status: 'failed',
        finishedAt: event.finishedAt,
        error: event.error,
      }));

    case 'capability.execution_unknown':
      return updateCapabilityInvocation(state, event.invocationId, (invocation) => ({
        ...invocation,
        status: 'unknown',
        finishedAt: event.finishedAt,
        error: event.reason,
      }));

    case 'capability.reconciliation_resolved':
      return updateCapabilityInvocation(state, event.invocationId, (invocation) => ({
        ...invocation,
        status: event.decision === 'confirmed_success' ? 'succeeded' : 'failed',
        finishedAt: event.reconciledAt,
        reconciliation: event.decision,
        reconciledAt: event.reconciledAt,
        ...(event.decision === 'confirmed_success'
          ? { error: undefined }
          : { error: event.reason ?? 'External invocation outcome was not confirmed.' }),
      }));

    case 'verification.requested': {
      if (state.verification.records[event.verificationId]) return state;
      if (event.taskId && event.taskId !== state.activeTaskId) return state;
      const diagnostics = validateVerificationSpec(event.spec);
      return {
        ...state,
        verification: {
          records: {
            ...state.verification.records,
            [event.verificationId]: {
              verificationId: event.verificationId,
              ...(event.taskId ? { taskId: event.taskId } : {}),
              mode: event.mode,
              status:
                event.mode === 'not_required'
                  ? 'passed'
                  : diagnostics.length > 0
                    ? 'budget_exhausted'
                    : 'pending',
              spec: event.spec,
              requestedAt: event.requestedAt,
              attempts: 0,
              repairAttempts: 0,
              checkResults: {},
              ...(diagnostics.length > 0 ? { diagnostics } : {}),
            },
          },
        },
      };
    }

    case 'verification.started':
      return updateVerification(state, event.verificationId, (record) => {
        if (!['pending', 'running', 'repair_pending'].includes(record.status)) return record;
        return {
          ...record,
          status: 'running',
          attempts: Math.max(record.attempts, event.attempt),
          checkResults: {},
          completedAt: undefined,
        };
      });

    case 'verification.check_completed':
      return updateVerification(state, event.verificationId, (record) =>
        record.status !== 'running'
          ? record
          : {
              ...record,
              checkResults: { ...record.checkResults, [event.result.checkId]: event.result },
            },
      );

    case 'verification.completed':
      return updateVerification(state, event.verificationId, (record) => {
        if (record.status !== 'running') return record;
        const failedStatus = event.outcome === 'failed' ? 'failed' : 'inconclusive';
        const status =
          event.outcome === 'passed'
            ? 'passed'
            : record.mode === 'required' && record.repairAttempts >= record.spec.repair.maxAttempts
              ? 'budget_exhausted'
              : failedStatus;
        return { ...record, status, completedAt: event.completedAt };
      });

    case 'verification.repair_requested': {
      const record = state.verification.records[event.verificationId];
      if (!record || !['failed', 'inconclusive'].includes(record.status)) return state;
      const next = updateVerification(state, event.verificationId, (current) => ({
        ...current,
        status: 'repair_pending',
        repairAttempts: Math.max(current.repairAttempts, event.repairAttempt),
      }));
      return appendVerificationInstruction(next, event.verificationId, event.instruction);
    }

    case 'verification.replan_requested': {
      const record = state.verification.records[event.verificationId];
      if (!record || record.status === 'passed' || record.status === 'waived') return state;
      const next = updateVerification(state, event.verificationId, (current) => ({
        ...current,
        status: 'repair_pending',
        repairAttempts: 0,
      }));
      return appendVerificationInstruction(next, event.verificationId, event.instruction);
    }

    case 'verification.waived':
      return updateVerification(state, event.verificationId, (record) =>
        record.status === 'passed'
          ? record
          : {
              ...record,
              status: 'waived',
              waiver: { actor: event.actor, reason: event.reason, waivedAt: event.waivedAt },
            },
      );

    case 'verification.compensation_requested':
      return updateVerification(state, event.verificationId, (record) =>
        record.spec.compensation &&
        ['failed', 'inconclusive', 'budget_exhausted'].includes(record.status)
          ? { ...record, status: 'compensating' }
          : record,
      );

    case 'verification.compensation_completed':
      return updateVerification(state, event.verificationId, (record) =>
        record.status !== 'compensating'
          ? record
          : {
              ...record,
              status: 'compensated',
              compensation: {
                outcome: event.outcome,
                summary: event.summary,
                completedAt: event.completedAt,
              },
            },
      );

    case 'tool.queued': {
      // LangGraph can replay an interrupted node.  A replayed queue event must
      // not reset a terminal call or append the same id to the queue again.
      if (state.tools.calls[event.toolCallId]) return state;
      const taskId = event.taskId ?? state.activeTaskId ?? undefined;
      const call = {
        toolCallId: event.toolCallId,
        ...(taskId ? { taskId } : {}),
        modelMessageId: event.modelMessageId ?? '',
        ordinal: event.ordinal,
        name: event.name,
        args: event.args,
        status: 'queued' as const,
        createdAtTurnId: state.turn.turnId,
        ...(event.bindingId ? { bindingId: event.bindingId } : {}),
        ...(event.capabilityId ? { capabilityId: event.capabilityId } : {}),
        ...(event.capabilityRevision ? { capabilityRevision: event.capabilityRevision } : {}),
        ...(event.effectClass
          ? {
              effectClass: event.effectClass,
              sideEffect:
                event.sideEffect ??
                (event.effectClass !== 'read_only' && event.effectClass !== 'plan_only'),
              classificationReason: event.classificationReason,
            }
          : (() => {
              const capability = classifyToolCapability(event.name, event.args);
              return {
                effectClass: capability.effectClass,
                sideEffect: capability.sideEffect,
                classificationReason: capability.classificationReason,
              };
            })()),
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

    case 'tool.execution_ready': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (existingCall?.status !== 'queued') return state;
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: { ...existingCall, status: 'approved' as const },
          },
        },
      };
    }

    case 'tool.started': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall) return state;
      const next = {
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
      const sideEffect =
        existingCall.sideEffect ??
        classifyToolCapability(existingCall.name, existingCall.args).sideEffect;
      return sideEffect
        ? updateActiveTask(next, (task) => ({ ...task, sideEffectsStarted: true }))
        : next;
    }

    case 'tool.finished': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall) return state;
      const isTaskCall = existingCall.name === 'task';
      const clearsMatchingApproval =
        isTaskCall &&
        state.interactions.kind === 'awaiting_tool_approval' &&
        state.interactions.toolCallId === event.toolCallId;
      const clearsMatchingUserInput =
        state.interactions.kind === 'awaiting_user_input' &&
        state.interactions.toolCallId === event.toolCallId;
      const clearsLegacyMarker =
        isTaskCall && state.legacyUnrecoverableSubagentApproval?.toolCallId === event.toolCallId;
      const { legacyUnrecoverableSubagentApproval: _legacyMarker, ...stateWithoutLegacyMarker } =
        state;
      const status =
        event.result.status === 'exhausted'
          ? ('exhausted' as const)
          : event.result.ok
            ? ('succeeded' as const)
            : ('failed' as const);
      return {
        ...(clearsLegacyMarker ? stateWithoutLegacyMarker : state),
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
                resultMeta: toolResultMeta(existingCall, event),
              },
            },
          },
          queue: state.tools.queue.filter((id) => id !== event.toolCallId),
          active: state.tools.active.filter((id) => id !== event.toolCallId),
        },
        transcript: appendToolTranscriptMessage(state, {
          kind: 'tool',
          ...transcriptMeta(state, `tool-${event.toolCallId}`, event.createdAt),
          toolCallId: event.toolCallId,
          name: event.name,
          content: event.result.stdout || event.result.stderr,
          ok: event.result.ok,
          resultMeta: toolResultMeta(existingCall, event),
        }),
        suspendedSubagents: clearSuspendedSubagent(state, event.toolCallId, isTaskCall),
        interactions:
          clearsMatchingApproval || clearsMatchingUserInput ? { kind: 'idle' } : state.interactions,
      };
    }

    case 'tool.failed': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall) return state;
      if (existingCall.status === 'failed') return state;
      const failure =
        event.failure ??
        classifyFailure('tool_runtime_error', event.error ?? 'Tool failed unexpectedly.');
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: {
              ...existingCall,
              status: 'failed' as const,
              error: failure.message,
              failure,
            },
          },
          queue: state.tools.queue.filter((id) => id !== event.toolCallId),
          active: state.tools.active.filter((id) => id !== event.toolCallId),
        },
        transcript: appendToolTranscriptMessage(state, {
          kind: 'tool',
          ...transcriptMeta(state, `tool-${event.toolCallId}`),
          toolCallId: event.toolCallId,
          name: existingCall.name,
          content: JSON.stringify({
            ok: false,
            error: {
              kind: failure.kind,
              message: failure.message,
              retryable: failure.retryable,
              model_fixable: failure.modelFixable,
            },
            next_step: failure.modelFixable
              ? 'Explain the failure, adjust the request or choose another available capability, and continue the conversation.'
              : 'Explain the failure to the user and continue without assuming the tool succeeded.',
          }),
          ok: false,
        }),
        suspendedSubagents: clearSuspendedSubagent(
          state,
          event.toolCallId,
          existingCall.name === 'task',
        ),
      };
    }

    case 'tool.rejected': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (existingCall) {
        if (existingCall.status === 'rejected') return state;
        const failure = event.failure ?? classifyFailure('policy_denied', event.reason);
        const deferredUntilBuilding = failure.kind === 'phase_deferred';
        const deniedByPlanningPhase = failure.kind === 'phase_denied';
        return {
          ...state,
          tools: {
            ...state.tools,
            calls: {
              ...state.tools.calls,
              [event.toolCallId]: {
                ...existingCall,
                status: 'rejected' as const,
                error: event.reason,
                failure,
              },
            },
            queue: state.tools.queue.filter((id) => id !== event.toolCallId),
            active: state.tools.active.filter((id) => id !== event.toolCallId),
          },
          transcript: appendToolTranscriptMessage(state, {
            kind: 'tool',
            ...transcriptMeta(state, `tool-${event.toolCallId}`),
            toolCallId: event.toolCallId,
            name: existingCall.name,
            content: JSON.stringify(
              deferredUntilBuilding
                ? {
                    ok: false,
                    deferred: true,
                    reason: 'phase_constraint',
                    until_phase: 'building',
                    tool: existingCall.name,
                    arguments: existingCall.args,
                    next_step:
                      'Do not retry or request approval while planning. Preserve this command in the plan execution or verification section, then invoke it only after plan approval changes the phase to building.',
                  }
                : deniedByPlanningPhase
                  ? {
                      ok: false,
                      rejected: true,
                      reason: 'phase_constraint',
                      phase: 'planning',
                      tool: existingCall.name,
                      arguments: existingCall.args,
                      message: event.reason,
                      next_step:
                        'Do not retry or request approval while planning. Use read-only inspection capabilities and preserve the intended implementation in the plan for execution after plan approval.',
                    }
                  : {
                      ok: false,
                      rejected: true,
                      error: {
                        kind: failure.kind,
                        message: event.reason,
                        retryable: failure.retryable,
                        model_fixable: failure.modelFixable,
                      },
                      next_step:
                        'Respect the rejection, explain it when relevant, and continue without assuming the tool ran.',
                    },
            ),
            ok: false,
          }),
          suspendedSubagents: clearSuspendedSubagent(
            state,
            event.toolCallId,
            existingCall.name === 'task',
          ),
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

    case 'tool.cancelled': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall) return state;
      if (
        existingCall.status === 'succeeded' ||
        existingCall.status === 'failed' ||
        existingCall.status === 'rejected' ||
        existingCall.status === 'cancelled' ||
        existingCall.status === 'exhausted'
      ) {
        return state;
      }
      const clearsMatchingInteraction =
        state.interactions.kind !== 'idle' &&
        state.interactions.kind !== 'awaiting_provider_action' &&
        state.interactions.kind !== 'awaiting_provider_admission' &&
        state.interactions.toolCallId === event.toolCallId;
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: { ...existingCall, status: 'cancelled' as const },
          },
          queue: state.tools.queue.filter((id) => id !== event.toolCallId),
          active: state.tools.active.filter((id) => id !== event.toolCallId),
        },
        transcript: appendToolTranscriptMessage(state, {
          kind: 'tool',
          ...transcriptMeta(state, `tool-${event.toolCallId}`),
          toolCallId: event.toolCallId,
          name: existingCall.name,
          content: event.reason,
          ok: false,
        }),
        suspendedSubagents: clearSuspendedSubagent(
          state,
          event.toolCallId,
          existingCall.name === 'task',
        ),
        interactions: clearsMatchingInteraction ? { kind: 'idle' } : state.interactions,
      };
    }

    case 'subagent.suspended': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (existingCall?.name !== 'task') return state;
      return {
        ...state,
        suspendedSubagents: {
          ...state.suspendedSubagents,
          [event.toolCallId]: event.snapshot,
        },
      };
    }

    // tool.progress does not modify state — progress data is consumed via event stream
    case 'tool.progress':
    // tool.file_change is informational — consumed via event stream
    case 'tool.file_change':
      return state;

    case 'network.admission_decided': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall || event.decision.toolCallId !== event.toolCallId) return state;
      if (
        existingCall.networkDecisions?.some(
          (decision) => decision.receiptDigest === event.decision.receiptDigest,
        )
      ) {
        return state;
      }
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: {
              ...existingCall,
              networkDecisions: [...(existingCall.networkDecisions ?? []), event.decision],
            },
          },
        },
      };
    }

    case 'mcp.egress_decided': {
      const existingCall = state.tools.calls[event.toolCallId];
      if (!existingCall || event.decision.toolCallId !== event.toolCallId) return state;
      if (
        existingCall.remoteMcpEgressDecisions?.some(
          (decision) => decision.receiptDigest === event.decision.receiptDigest,
        )
      ) {
        return state;
      }
      return {
        ...state,
        tools: {
          ...state.tools,
          calls: {
            ...state.tools.calls,
            [event.toolCallId]: {
              ...existingCall,
              remoteMcpEgressDecisions: [
                ...(existingCall.remoteMcpEgressDecisions ?? []),
                event.decision,
              ],
            },
          },
        },
      };
    }

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
        state.interactions.interactionId !== event.interactionId ||
        state.interactions.toolCallId !== event.toolCallId
      ) {
        return state;
      }
      return {
        ...state,
        interactions: { kind: 'idle' },
      };

    case 'user_input.cancelled':
      if (
        state.interactions.kind !== 'awaiting_user_input' ||
        state.interactions.interactionId !== event.interactionId ||
        state.interactions.toolCallId !== event.toolCallId
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
        state.interactions.interactionId !== event.interactionId ||
        event.toolCallId !== state.interactions.toolCallId
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

    case 'approval.rejected': {
      if (
        state.interactions.kind !== 'awaiting_tool_approval' ||
        state.interactions.interactionId !== event.interactionId ||
        event.toolCallId !== state.interactions.toolCallId
      ) {
        return state;
      }
      const toolCallId = state.interactions.toolCallId;
      const rejectedTools = updateToolStatus(state.tools, toolCallId, 'rejected');
      const failure = event.failure ?? classifyFailure('approval_rejected', event.reason);
      return {
        ...state,
        tools: {
          ...rejectedTools,
          calls: {
            ...rejectedTools.calls,
            [toolCallId]: {
              ...rejectedTools.calls[toolCallId]!,
              status: 'rejected',
              error: event.reason,
              failure,
            },
          },
          queue: rejectedTools.queue.filter((id) => id !== toolCallId),
          active: rejectedTools.active.filter((id) => id !== toolCallId),
        },
        transcript: appendToolTranscriptMessage(state, {
          kind: 'tool',
          ...transcriptMeta(state, `tool-${toolCallId}`),
          toolCallId,
          name: state.tools.calls[toolCallId]?.name ?? 'unknown',
          content: JSON.stringify({
            ok: false,
            rejected: true,
            error: {
              kind: failure.kind,
              message: event.reason,
              retryable: failure.retryable,
              model_fixable: failure.modelFixable,
            },
          }),
          ok: false,
        }),
        suspendedSubagents: clearSuspendedSubagent(
          state,
          toolCallId,
          state.tools.calls[toolCallId]?.name === 'task',
        ),
        interactions: { kind: 'idle' },
      };
    }

    // ── Required MCP Provider admission ──

    case 'provider.admission_required': {
      if (
        (state.interactions.kind !== 'idle' &&
          state.interactions.kind !== 'awaiting_provider_admission') ||
        state.providerAdmission.waivers[event.providerId] ||
        state.providerAdmission.pending.some((entry) => entry.providerId === event.providerId)
      ) {
        return state;
      }
      const record = {
        interactionId: event.interactionId,
        providerId: event.providerId,
        source: event.source,
        providerStatus: event.providerStatus,
        ...(event.diagnosticCode ? { diagnosticCode: event.diagnosticCode } : {}),
        retryable: event.retryable,
      };
      return {
        ...state,
        providerAdmission: {
          ...state.providerAdmission,
          pending: [...state.providerAdmission.pending, record],
        },
        interactions:
          state.interactions.kind === 'idle'
            ? { kind: 'awaiting_provider_admission', ...record }
            : state.interactions,
      };
    }

    case 'provider.admission_retry_requested':
      return state;

    case 'provider.admission_retry_failed': {
      if (
        state.interactions.kind !== 'awaiting_provider_admission' ||
        state.interactions.interactionId !== event.interactionId
      ) {
        return state;
      }
      const update = (entry: (typeof state.providerAdmission.pending)[number]) =>
        entry.interactionId === event.interactionId
          ? {
              ...entry,
              providerStatus: event.providerStatus,
              ...(event.diagnosticCode ? { diagnosticCode: event.diagnosticCode } : {}),
            }
          : entry;
      const pending = state.providerAdmission.pending.map(update);
      const current = pending.find((entry) => entry.interactionId === event.interactionId)!;
      return {
        ...state,
        providerAdmission: { ...state.providerAdmission, pending },
        interactions: { kind: 'awaiting_provider_admission', ...current },
      };
    }

    case 'provider.admission_satisfied': {
      if (
        state.interactions.kind !== 'awaiting_provider_admission' ||
        state.interactions.interactionId !== event.interactionId
      ) {
        return state;
      }
      return settleProviderAdmission(state, event.interactionId);
    }

    case 'provider.admission_waived': {
      if (
        state.interactions.kind !== 'awaiting_provider_admission' ||
        state.interactions.interactionId !== event.interactionId ||
        state.interactions.providerId !== event.providerId
      ) {
        return state;
      }
      const settled = settleProviderAdmission(state, event.interactionId);
      return {
        ...settled,
        providerAdmission: {
          ...settled.providerAdmission,
          waivers: {
            ...settled.providerAdmission.waivers,
            [event.providerId]: {
              providerId: event.providerId,
              source: event.source,
              reason: event.reason,
              waivedAt: event.waivedAt,
            },
          },
        },
        transcript: {
          ...settled.transcript,
          messages: [
            ...settled.transcript.messages,
            {
              kind: 'runtime',
              ...transcriptMeta(
                settled,
                `provider-admission-waiver-${event.interactionId}`,
                event.waivedAt,
              ),
              content:
                `Required MCP provider '${event.providerId}' is unavailable. ` +
                'The user waived it for this session; its capabilities remain unavailable.',
            },
          ],
        },
      };
    }

    case 'provider.admission_cancelled':
      if (
        state.interactions.kind !== 'awaiting_provider_admission' ||
        state.interactions.interactionId !== event.interactionId ||
        state.interactions.providerId !== event.providerId
      ) {
        return state;
      }
      return settleProviderAdmission(state, event.interactionId);

    // ── MCP Provider recovery interaction ──

    case 'provider.action_required': {
      if (state.interactions.kind !== 'idle') return state;
      const call = state.tools.calls[event.originatingToolCallId];
      if (call?.status !== 'failed') return state;
      const alreadyHasToolResult = state.transcript.messages.some(
        (message) => message.kind === 'tool' && message.toolCallId === event.originatingToolCallId,
      );
      return {
        ...state,
        interactions: {
          kind: 'awaiting_provider_action',
          interactionId: event.interactionId,
          providerId: event.providerId,
          action: event.action,
          originatingToolCallId: event.originatingToolCallId,
          status: 'required',
        },
        transcript: alreadyHasToolResult
          ? state.transcript
          : appendToolTranscriptMessage(state, {
              kind: 'tool',
              ...transcriptMeta(state, `tool-${call.toolCallId}`),
              toolCallId: call.toolCallId,
              name: call.name,
              content: call.error ?? 'MCP provider action is required.',
              ok: false,
            }),
      };
    }

    case 'provider.action_started':
      if (
        state.interactions.kind !== 'awaiting_provider_action' ||
        state.interactions.interactionId !== event.interactionId
      ) {
        return state;
      }
      return {
        ...state,
        interactions: { ...state.interactions, status: 'started' },
      };

    case 'provider.action_completed':
    case 'provider.action_deferred':
    case 'provider.action_failed': {
      if (
        state.interactions.kind !== 'awaiting_provider_action' ||
        state.interactions.interactionId !== event.interactionId ||
        event.originatingToolCallId !== state.interactions.originatingToolCallId
      ) {
        return state;
      }
      const providerId = state.interactions.providerId;
      const outcome =
        event.type === 'provider.action_completed'
          ? 'completed'
          : event.type === 'provider.action_deferred'
            ? 'deferred'
            : `failed (${event.failureCode})`;
      return {
        ...state,
        interactions: { kind: 'idle' },
        transcript: {
          ...state.transcript,
          messages: [
            ...state.transcript.messages,
            {
              kind: 'runtime',
              ...transcriptMeta(state, `provider-action-${event.interactionId}`),
              content: `MCP provider '${providerId}' recovery ${outcome}.`,
            },
          ],
        },
      };
    }

    // ── 运行时环境 / Runtime environment ──

    case 'authorization.changed':
      return {
        ...state,
        authorization: {
          ...state.authorization,
          mode: event.mode,
          ...(event.commandGrants ? { commandGrants: event.commandGrants } : {}),
          ...(event.modeSource ? { modeSource: event.modeSource } : {}),
          ...(event.modeGrantedAt ? { modeGrantedAt: event.modeGrantedAt } : {}),
        },
      };

    case 'interaction_mode.changed': {
      // A selector change is immediately authoritative, including during an
      // active task. An approved plan retains its historical presentation
      // mode, but its task-scoped override must not mask the newer user choice.
      const authorization =
        event.mode === 'full'
          ? {
              ...state.authorization,
              mode: 'full_access' as const,
              modeSource: event.source,
              modeGrantedAt: event.changedAt,
            }
          : (() => {
              const {
                modeSource: _modeSource,
                modeGrantedAt: _modeGrantedAt,
                ...rest
              } = state.authorization;
              return { ...rest, mode: 'default' as const };
            })();
      return updateActiveTask(
        {
          ...state,
          mode: event.mode,
          authorization,
        },
        (task) => ({ ...task, executionMode: undefined }),
      );
    }

    // phase.changed — removed; phase is derived from planning.kind via getAgentPhase()
    case 'turn.started':
      return {
        ...state,
        turn: {
          turnId: event.turnId,
          turnIndex: state.turn.turnIndex + 1,
          status: 'active',
        },
      };
    case 'turn.completed':
      return event.turnId === state.turn.turnId
        ? { ...state, turn: { ...state.turn, status: 'completed' } }
        : state;
    case 'turn.aborted':
      return event.turnId === state.turn.turnId
        ? {
            ...state,
            turn: {
              ...state.turn,
              status: 'aborted',
              abortReason: event.reason,
              ...(event.cause ? { abortCause: event.cause } : {}),
            },
          }
        : state;

    // ── 用户消息 / User message ──

    case 'user.message_appended': {
      // Generate the id once so the task map key and activeTaskId always match.
      let nextState =
        state.activeTaskId === null
          ? (() => {
              const taskId = crypto.randomUUID();
              const task = {
                taskId,
                userGoal: event.content,
                status: 'active' as const,
                startedAtTurnId: state.turn.turnId,
                sideEffectsStarted: false,
                planning: { kind: 'building_without_plan' as const },
                planHistory: [],
              };
              return {
                ...state,
                activeTaskId: taskId,
                tasks: { ...state.tasks, [taskId]: task },
                planning: task.planning,
              };
            })()
          : state;
      const activeTask = getActiveTask(nextState);
      if (activeTask && activeTask.userGoal.length === 0 && event.content.length > 0) {
        nextState = updateActiveTask(nextState, (task) => ({ ...task, userGoal: event.content }));
      }
      return {
        ...nextState,
        transcript: {
          ...nextState.transcript,
          final: undefined,
          messages: [
            ...nextState.transcript.messages,
            {
              kind: 'user',
              ...transcriptMeta(nextState, event.messageId, event.createdAt),
              content: event.content,
            },
          ],
        },
      };
    }
    case 'user.command_invoked':
      // Durable audit/display event only. Local commands must not enter the
      // model transcript or alter the active task.
      return state;

    // ── 模型交互 / Model interaction ──

    // model.requested / model.responded 为信息性事件，由 TranscriptState 管理（未来）。
    // Informational — managed by TranscriptState (future).
    case 'model.requested':
    case 'model.reasoning_delta':
    case 'model.reasoning_completed':
    case 'model.text_delta':
      return state;

    case 'model.retry':
    case 'model.cache_metrics':
      return state;
    case 'model.context_metrics':
      return state;
    case 'run.completed': {
      const active = getActiveTask(state);
      if (!active) return state;
      const completed = {
        ...active,
        status: 'completed' as const,
        completedAtTurnId: event.turnId,
        executionMode: undefined,
      };
      return {
        ...state,
        terminalOutcome: event.outcome,
        activeTaskId: null,
        tasks: { ...state.tasks, [completed.taskId]: completed },
        planning: completed.planning,
      };
    }
    case 'run.error':
      return event.outcome ? { ...state, terminalOutcome: event.outcome } : state;
    case 'runtime.action_ignored':
    case 'provider.data_policy_status':
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
              ...transcriptMeta(state, event.messageId, event.createdAt),
              content: event.text,
              reasoningText: event.reasoningText,
              toolCalls: event.toolCalls ?? [],
            },
          ],
        },
      };

    // ── Plan 生命周期补充 / Additional plan lifecycle ──

    case 'plan.drafted': {
      if (event.taskId && state.activeTaskId !== event.taskId) return state;
      const planning = getActivePlanning(state);
      if (
        planning.kind !== 'planning_empty' &&
        planning.kind !== 'planning_draft' &&
        planning.kind !== 'replanning_draft'
      )
        return state;
      const draftDocument =
        planning.kind === 'planning_draft' || planning.kind === 'replanning_draft'
          ? planning.document
          : undefined;
      const document = {
        ...planDocumentFromAgentPlan(event.plan, state.turn.turnId),
        planId: event.planId,
        version: event.version,
        structuralDigest: event.structuralHash,
        ...(event.artifact ? { artifact: event.artifact } : {}),
        ...(planning.kind === 'replanning_draft'
          ? {
              supersedesPlanVersion: planning.supersedesPlanVersion,
              replanReason: planning.replanReason,
            }
          : draftDocument?.supersedesPlanVersion != null
            ? {
                supersedesPlanVersion: draftDocument.supersedesPlanVersion,
                replanReason: draftDocument.replanReason,
              }
            : {}),
        ...(event.supersedesPlanVersion != null
          ? { supersedesPlanVersion: event.supersedesPlanVersion }
          : {}),
        ...(event.replanReason ? { replanReason: event.replanReason } : {}),
      };
      const nextPlanning =
        planning.kind === 'replanning_draft'
          ? {
              kind: 'replanning_draft' as const,
              document,
              supersedesPlanVersion: event.supersedesPlanVersion ?? planning.supersedesPlanVersion,
              replanReason: event.replanReason ?? planning.replanReason,
            }
          : { kind: 'planning_draft' as const, document };
      return setActivePlanning(state, nextPlanning);
    }

    case 'plan.progress_updated': {
      // 仅当 plan 在 executing 状态时更新步骤进度
      // Only update step progress when plan is in executing state
      const currentPlanning = getActivePlanning(state);
      if (currentPlanning.kind === 'executing') {
        const executing = currentPlanning;
        const updatedSteps = mergeStepUpdates(
          executing.document.steps,
          agentPlanToSteps(event.plan),
        );
        return setActivePlanning(state, {
          ...executing,
          document: {
            ...executing.document,
            steps: updatedSteps,
            updatedAtTurnId: state.turn.turnId,
          },
        });
      }
      return state;
    }

    case 'plan.completed': {
      // 从 executing 状态转换到 completed
      // Transition from executing to completed
      const executing = getActivePlanning(state);
      if (executing.kind === 'executing') {
        const updatedSteps = mergeStepUpdates(
          executing.document.steps,
          agentPlanToSteps(event.plan),
        );
        const next = setActivePlanning(state, {
          kind: 'completed',
          document: { ...executing.document, steps: updatedSteps },
          completedAtTurnId: state.turn.turnId,
        });
        return updateActiveTask(next, (task) => ({ ...task, executionMode: undefined }));
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
        state.interactions.interactionId !== event.reviewId ||
        state.interactions.toolCallId !== event.toolCallId
      ) {
        return state;
      }
      const result = event.result;
      // A failed automatic review is not a rejection.  The executor emits a
      // following approval.requested event with a fresh interaction id. Keep
      // the current interaction coherent until that event is reduced.
      if (!result.ok) return state;
      if (result.ok && result.approved) {
        const call = state.tools.calls[state.interactions.toolCallId];
        // Reset circuit breaker on successful auto-review
        const breaker = evaluateCircuitBreaker(
          state.autoReview.consecutiveRejects,
          state.autoReview.rejectionHistory,
          DEFAULT_CIRCUIT_BREAKER_CONFIG,
          false, // not a rejection — reset
        );
        return {
          ...state,
          tools: {
            ...state.tools,
            calls: {
              ...state.tools.calls,
              ...(call
                ? {
                    [state.interactions.toolCallId]: {
                      ...call,
                      status: 'approved' as const,
                      approvalGrant: (result.grant ??
                        'approve_once') as import('@/protocol/events').ShellApprovalGrant,
                    },
                  }
                : {}),
            },
          },
          interactions: { kind: 'idle' },
          autoReview: {
            ...state.autoReview,
            consecutiveRejects: breaker.newConsecutiveRejects,
            rejectionHistory: breaker.newRejectionHistory,
            circuitBreakerTripped: false,
          },
        };
      }
      // Auto-review rejected — update circuit breaker
      const breaker = evaluateCircuitBreaker(
        state.autoReview.consecutiveRejects,
        state.autoReview.rejectionHistory,
        DEFAULT_CIRCUIT_BREAKER_CONFIG,
        true, // isRejection
        {
          timestamp: Date.now(),
          toolName: state.interactions.toolName,
          reason: result.reason ?? 'auto-review rejected',
        },
      );
      const toolCallId = state.interactions.toolCallId;
      const rejectedTools = updateToolStatus(state.tools, toolCallId, 'rejected');
      return {
        ...state,
        tools: {
          ...rejectedTools,
          calls: {
            ...rejectedTools.calls,
            [toolCallId]: {
              ...rejectedTools.calls[toolCallId]!,
              status: 'rejected',
              error: result.reason ?? 'auto-review rejected',
              failure: classifyFailure(
                'auto_review_rejected',
                result.reason ?? 'auto-review rejected',
              ),
            },
          },
          queue: rejectedTools.queue.filter((id) => id !== toolCallId),
          active: rejectedTools.active.filter((id) => id !== toolCallId),
        },
        interactions: { kind: 'idle' },
        autoReview: {
          ...state.autoReview,
          consecutiveRejects: breaker.newConsecutiveRejects,
          rejectionHistory: breaker.newRejectionHistory,
          circuitBreakerTripped: state.autoReview.circuitBreakerTripped || breaker.tripped,
        },
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

function settleProviderAdmission(state: RuntimeState, interactionId: string): RuntimeState {
  const pending = state.providerAdmission.pending.filter(
    (entry) => entry.interactionId !== interactionId,
  );
  const next = pending[0];
  return {
    ...state,
    providerAdmission: { ...state.providerAdmission, pending },
    interactions: next ? { kind: 'awaiting_provider_admission', ...next } : { kind: 'idle' },
  };
}

function updateCapabilityInvocation(
  state: RuntimeState,
  invocationId: string,
  update: (
    invocation: import('@/protocol/capabilities').CapabilityInvocationRecord,
  ) => import('@/protocol/capabilities').CapabilityInvocationRecord,
): RuntimeState {
  const invocation = state.capabilities.invocations[invocationId];
  if (!invocation) return state;
  return {
    ...state,
    capabilities: {
      ...state.capabilities,
      invocations: {
        ...state.capabilities.invocations,
        [invocationId]: update(invocation),
      },
    },
  };
}

function updateVerification(
  state: RuntimeState,
  verificationId: string,
  update: (
    record: RuntimeState['verification']['records'][string],
  ) => RuntimeState['verification']['records'][string],
): RuntimeState {
  const record = state.verification.records[verificationId];
  if (!record) return state;
  return {
    ...state,
    verification: {
      records: { ...state.verification.records, [verificationId]: update(record) },
    },
  };
}

function appendVerificationInstruction(
  state: RuntimeState,
  verificationId: string,
  instruction: string,
): RuntimeState {
  return {
    ...state,
    transcript: {
      ...state.transcript,
      final: undefined,
      messages: [
        ...state.transcript.messages,
        {
          kind: 'runtime',
          ...transcriptMeta(state, `verification-${verificationId}-${state.revision}`),
          content: instruction,
        },
      ],
    },
  };
}

/** Close a legacy plan rejection without reviving the retired cancelled state. */
function closeToolCall(tools: RuntimeState['tools'], toolCallId: string): RuntimeState['tools'] {
  const call = tools.calls[toolCallId];
  if (!call) return tools;
  return {
    ...tools,
    calls: { ...tools.calls, [toolCallId]: { ...call, status: 'succeeded' } },
    queue: tools.queue.filter((id) => id !== toolCallId),
    active: tools.active.filter((id) => id !== toolCallId),
  };
}

function clearSuspendedSubagent(
  state: RuntimeState,
  toolCallId: string,
  isTaskCall: boolean,
): RuntimeState['suspendedSubagents'] {
  if (!isTaskCall || !state.suspendedSubagents[toolCallId]) return state.suspendedSubagents;
  const { [toolCallId]: _snapshot, ...remaining } = state.suspendedSubagents;
  return remaining;
}

function planDocumentFromAgentPlan(
  plan: AgentPlan,
  turnId: string,
): Omit<PlanDocument, 'structuralDigest'> {
  return {
    planId: crypto.randomUUID(),
    version: 1,
    title: plan.name.slice(0, 120),
    bodyMarkdown: plan.description,
    steps: agentPlanToSteps(plan),
    createdAtTurnId: turnId,
    updatedAtTurnId: turnId,
  };
}

function agentPlanToSteps(plan: AgentPlan): PlanStep[] {
  return plan.steps.map((step) => ({
    id: step.id ?? sanitizeStepId(step.step),
    title: step.step.slice(0, 160),
    status: step.status,
    note: step.note,
  }));
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
    if (update) {
      return { ...step, status: update.status, note: update.note ?? step.note };
    }
    return step;
  });
}
