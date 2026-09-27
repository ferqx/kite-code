import type { SupportedChatModel } from '@kite-ai/builtin-runtime/model';
import { subagentDispatchIntentDigest } from '@kite-ai/builtin-runtime/subagent';
import {
  childSessionAcceptanceEffectId,
  childThreadIdForToolAttempt,
  committedResourceUsage,
  reduceResourceBudgetState,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  childDelegatedUpperBoundDigest,
  type EffectLeasePort,
  type RuntimeEffectLeaseExpectation,
  type RuntimeSealedChildGrantPayload,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import type { SubagentDelegationGrant } from '@kite-ai/runtime-spi';
import type { AgentConfig } from '#kite-service/config/index';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';
import { planAfterTurnContinuationReservation } from './after-turn-continuation';
import {
  canFundStagedChildCounterShares,
  planChildDelegatedAllotment,
} from './child-delegated-allotment';
import type { SubAgentResult } from './types';

type ChildRole = 'explore' | 'plan' | 'code' | 'review';

export interface StagedChildSession {
  readonly grant: Readonly<SubagentDelegationGrant>;
  readonly name: string;
  readonly role: ChildRole;
  readonly originRunId: string;
  readonly originTurnId: string;
  readonly disposition: 'required' | 'after_turn';
  readonly afterTurn?: Readonly<{
    config: AgentConfig;
    model: SupportedChatModel;
  }>;
}

export interface AcceptedChildSession {
  readonly childThreadId: string;
  readonly childInvocationId: string;
  readonly parentSessionId: string;
  readonly childBudget: ReturnType<typeof planChildDelegatedAllotment>['childBudget'];
  readonly childDeadlineAt: string;
  readonly disposition: 'required' | 'after_turn';
}

/**
 * One run_tools effect may accept sibling Task receipts in parallel. Stage only
 * immutable grant facts here; plan each budget under a serial, fresh parent
 * State read immediately before its receipt transaction.
 */
export function createChildSessionAcceptanceStage(input: {
  readonly getState: () => Readonly<RuntimeState>;
  readonly effectLeases: Pick<EffectLeasePort, 'tryAcquireEffectLease' | 'releaseEffectLease'>;
  readonly commit: (
    events: readonly RuntimeEvent[],
    requiredEffectLease: RuntimeEffectLeaseExpectation,
    sealedGrant: RuntimeSealedChildGrantPayload,
  ) => Promise<boolean>;
  readonly onAccepted: (
    accepted: AcceptedChildSession,
    parentSignal?: AbortSignal,
  ) => void | Promise<void>;
  readonly parentSignal?: AbortSignal;
  readonly now?: () => number;
}): Readonly<{
  stage(child: StagedChildSession): SubAgentResult;
  commitReceipt(events: RuntimeEvent[]): Promise<boolean | null>;
}> {
  const pending = new Map<string, StagedChildSession>();
  let commitTail: Promise<void> = Promise.resolve();
  const now = input.now ?? Date.now;
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const committed = commitTail.then(work, work);
    commitTail = committed.then(
      () => undefined,
      () => undefined,
    );
    return committed;
  };

  return Object.freeze({
    stage(child: StagedChildSession): SubAgentResult {
      const { grant } = child;
      const budget = input.getState().resourceBudget;
      if (budget.status !== 'active') {
        const reason = 'Background child Session requires an active Run resource budget.';
        return {
          ok: false,
          summary: reason,
          error: reason,
          terminalStatus: 'failed',
          toolCallCount: 0,
          durationMs: 0,
        };
      }
      if (
        grant.purpose !== 'start' ||
        grant.role !== child.role ||
        !child.originRunId ||
        !child.originTurnId ||
        (child.disposition === 'after_turn') !== Boolean(child.afterTurn) ||
        grant.expiresAtMs <= now() ||
        pending.has(grant.parentToolCallId)
      ) {
        throw new Error('Child Session staging identity is invalid or expired.');
      }
      if (
        !canFundStagedChildCounterShares({
          ledger: budget,
          children: [
            ...[...pending.values()].map((candidate) => ({
              parentToolCallId: candidate.grant.parentToolCallId,
              taskArtifactBytes: candidate.grant.taskArtifact.byteLength,
            })),
            {
              parentToolCallId: grant.parentToolCallId,
              taskArtifactBytes: grant.taskArtifact.byteLength,
            },
          ],
        })
      ) {
        const reason =
          'Sub-agent budget cannot provide a positive child allotment; the new child was not created.';
        return {
          ok: false,
          summary: reason,
          error: reason,
          terminalStatus: 'failed',
          toolCallCount: 0,
          durationMs: 0,
        };
      }
      const committed = committedResourceUsage(budget);
      const occupied = committed.gauges.activeSubagents + pending.size;
      if (occupied >= budget.budget.maxConcurrentSubagents) {
        const reason = `Sub-agent concurrency limit (${budget.budget.maxConcurrentSubagents}) reached; the new child was not created.`;
        return {
          ok: false,
          summary: reason,
          error: reason,
          terminalStatus: 'failed',
          toolCallCount: 0,
          durationMs: 0,
        };
      }
      const writers =
        committed.gauges.activeWriters +
        [...pending.values()].filter((candidate) => candidate.role === 'code').length;
      if (child.role === 'code' && writers >= budget.budget.maxConcurrentWriters) {
        const reason = 'Code sub-agent writer capacity is full; the new child was not created.';
        return {
          ok: false,
          summary: reason,
          error: reason,
          terminalStatus: 'failed',
          toolCallCount: 0,
          durationMs: 0,
        };
      }
      pending.set(grant.parentToolCallId, child);
      return {
        ok: true,
        summary: `Background sub-agent accepted as ${grant.childInvocationId}.`,
        backgroundTaskId: grant.childInvocationId,
        toolCallCount: 0,
        durationMs: 0,
      };
    },
    async commitReceipt(events: RuntimeEvent[]): Promise<boolean | null> {
      for (const event of events) {
        if (
          (event.type === 'tool.finished' && event.result.ok !== true) ||
          event.type === 'tool.failed' ||
          event.type === 'tool.rejected' ||
          event.type === 'tool.cancelled'
        ) {
          pending.delete(event.toolCallId);
        }
      }
      const finished = events.filter(
        (event): event is Extract<RuntimeEvent, { type: 'tool.finished' }> =>
          event.type === 'tool.finished' &&
          event.result.ok === true &&
          pending.has(event.toolCallId),
      );
      if (finished.length === 0) return null;
      if (finished.length !== 1)
        throw new Error('Child Session receipt contains multiple staged Task terminals.');
      const terminal = finished[0]!;
      return serialize(async () => {
        const child = pending.get(terminal.toolCallId);
        if (!child) throw new Error('Staged Child Session receipt disappeared.');
        const { grant } = child;
        const state = input.getState();
        if (
          state.session.threadId.length === 0 ||
          state.turn.turnId !== child.originTurnId ||
          state.resourceBudget.status !== 'active' ||
          state.resourceBudget.runId !== child.originRunId ||
          terminal.result.resultMeta?.taskId !== grant.childInvocationId ||
          terminal.result.resultMeta?.taskStatus !== 'running' ||
          terminal.result.resultMeta?.taskDisposition !== child.disposition ||
          grant.parentToolCallId !== terminal.toolCallId ||
          grant.parentAttempt < 1 ||
          grant.expiresAtMs <= now()
        )
          throw new Error('Child Session Task receipt lost its parent authority.');
        const childThreadId = childThreadIdForToolAttempt({
          parentSessionId: state.session.threadId,
          parentInvocationId: grant.parentInvocationId,
          parentToolCallId: grant.parentToolCallId,
          attempt: grant.parentAttempt,
        });
        const transient = Object.values(state.resourceBudget.reservations).filter(
          (reservation) =>
            reservation.invocationId === `tool:${grant.parentToolCallId}` &&
            reservation.resourceKind === 'subagent',
        );
        if (transient.length !== 1)
          throw new Error('Child Session Task has no exact transient reservation.');
        const allotment = planChildDelegatedAllotment({
          state,
          transientReservationId: transient[0]!.reservationId,
          toolFinished: terminal,
          childThreadId,
          role: child.role,
          taskArtifactBytes: grant.taskArtifact.byteLength,
          now: now(),
        });
        const afterAllotmentBudget = reduceResourceBudgetState(
          reduceResourceBudgetState(state.resourceBudget, allotment.events[0]),
          allotment.events[1],
        );
        const afterTurn = child.afterTurn
          ? planAfterTurnContinuationReservation({
              state: {
                ...state,
                resourceBudget: afterAllotmentBudget,
              },
              config: child.afterTurn.config,
              model: child.afterTurn.model,
              childInvocationId: grant.childInvocationId,
              originRunId: child.originRunId,
              now: now(),
            })
          : undefined;
        const sealedGrant = sealChildGrantPayload(grant);
        const dispatch: Extract<
          RuntimeEvent,
          { type: 'capability.subagent_dispatch_intent_recorded' }
        > = {
          type: 'capability.subagent_dispatch_intent_recorded',
          invocationId: grant.parentInvocationId,
          attempt: grant.parentAttempt,
          purpose: 'start',
          childInvocationId: grant.childInvocationId,
          taskArtifact: grant.taskArtifact,
          dispatchIntentDigest: subagentDispatchIntentDigest(grant),
          recordedAt: new Date(now()).toISOString(),
        };
        const started: Extract<RuntimeEvent, { type: 'subagent.started' }> = {
          type: 'subagent.started',
          subagent: {
            id: grant.childInvocationId,
            role: child.role,
            name: child.name,
            parentToolCallId: grant.parentToolCallId,
            status: 'creating',
          },
        };
        const intended: Extract<RuntimeEvent, { type: 'subagent.child_session_intended' }> = {
          type: 'subagent.child_session_intended',
          parentInvocationId: grant.parentInvocationId,
          parentSessionId: state.session.threadId,
          originRunId: child.originRunId,
          originTurnId: child.originTurnId,
          originToolCallId: grant.parentToolCallId,
          attempt: grant.parentAttempt,
          childInvocationId: grant.childInvocationId,
          childThreadId,
          grantDigest: sealedGrant.sealedGrantDigest,
          taskArtifactRef: grant.taskArtifact,
          taskArtifactDigest: grant.taskArtifact.integrityIdentifier,
          taskTextDigest: grant.taskDigest,
          disposition: child.disposition,
          role: child.role,
          fundingRunId: child.originRunId,
          delegatedReservationId: allotment.reservation.reservationId,
          delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(
            allotment.reservation.executableUpperBound,
          ),
          deadlineAt: state.resourceBudget.deadlineAt,
        };
        const batch: RuntimeEvent[] = [
          ...allotment.events,
          ...(afterTurn?.preparationEvents ?? []),
          dispatch,
          started,
          intended,
          ...events,
        ];
        const effectId = childSessionAcceptanceEffectId(childThreadId);
        const ownerId = `child-acceptance:${childThreadId}`;
        const observedAtMs = now();
        if (
          !input.effectLeases.tryAcquireEffectLease(
            state.session.threadId,
            effectId,
            ownerId,
            observedAtMs + 60_000,
          )
        )
          throw new Error('Child Session acceptance effect is already owned or unknown.');
        let accepted: boolean;
        try {
          accepted = await input.commit(batch, { effectId, ownerId, observedAtMs }, sealedGrant);
        } finally {
          try {
            input.effectLeases.releaseEffectLease(state.session.threadId, effectId, ownerId);
          } catch {
            // The committed Tool receipt remains authoritative; the lease expires.
          }
        }
        if (!accepted) throw new Error('Child Session parent Tool receipt was not accepted.');
        pending.delete(terminal.toolCallId);
        // The durable intent is the restart source if activation cannot begin
        // in this process. A callback failure cannot undo a committed receipt.
        try {
          void Promise.resolve(
            input.onAccepted(
              {
                childThreadId,
                childInvocationId: grant.childInvocationId,
                parentSessionId: state.session.threadId,
                childBudget: allotment.childBudget,
                childDeadlineAt: allotment.deadlineAt,
                disposition: child.disposition,
              },
              child.disposition === 'required' ? input.parentSignal : undefined,
            ),
          ).catch(() => undefined);
        } catch {
          // The Store intent is already committed and remains recoverable.
        }
        return true;
      });
    },
  });
}
