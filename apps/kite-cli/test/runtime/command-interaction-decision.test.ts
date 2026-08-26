import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  type StateRuntimeSession,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeCommandCommitEvidence } from '@kite-ai/runtime-host/storage';
import {
  commitInteractionCommand,
  type RuntimeInteractionCommandCommitInput,
} from '../../src/bootstrap/runtime/command-interaction-decision';
import type { RuntimeUserAction } from '../../src/bootstrap/runtime/state-actions';
import type { RuntimeEvent, RuntimeState } from '../../src/bootstrap/runtime/state-runtime';

function evidence(commandId = 'command_interaction_fixture'): RuntimeCommandCommitEvidence {
  return {
    scopeSessionId: 'interaction-session',
    commandId,
    requestDigest: 'a'.repeat(64),
    targetSessionId: 'interaction-session',
    committedAt: 1_700_000_000_000,
  };
}

function state(): RuntimeState {
  return createRuntimeHostStateInitialState({
    threadId: 'interaction-session',
    userId: 'test-user',
    workspace: '/workspace',
    recoveryIdentityKey: 'b'.repeat(64),
  });
}

function setInteraction(current: RuntimeState, interaction: RuntimeState['interactions']): void {
  (current as { interactions: RuntimeState['interactions'] }).interactions = interaction;
}

function fakeSession(current: RuntimeState, options: { fail?: boolean } = {}) {
  const writes: RuntimeEvent[][] = [];
  const session = {
    sessionId: current.session.threadId,
    getState: () => current,
    commitCommandBatch: (events: readonly RuntimeEvent[], input: RuntimeCommandCommitEvidence) => {
      if (options.fail) throw new Error('injected interaction transaction failure');
      writes.push([...events]);
      return {
        receipt: {
          scopeSessionId: input.scopeSessionId,
          commandId: input.commandId,
          requestDigest: input.requestDigest,
          targetSessionId: input.targetSessionId,
          originalReceiptJson: '{}',
          committedRevision: current.revision + events.length,
          committedAt: input.committedAt,
        },
        events,
      };
    },
  } as unknown as StateRuntimeSession;
  return { session, writes };
}

function input(
  action: RuntimeUserAction,
  current: RuntimeState,
): RuntimeInteractionCommandCommitInput {
  return {
    action,
    sessionId: current.session.threadId,
    interactionId: 'interaction-1',
    expectedRevision: current.revision,
    effectType: 'request_user_input',
    reservationReconciliationEvents: [],
    sandboxAvailable: false,
    evidence: evidence(),
  };
}

describe('interaction command decision', () => {
  test('commits input facts and receipt together without a waiter-side effect', () => {
    const current = state();
    setInteraction(current, {
      kind: 'awaiting_user_input',
      interactionId: 'interaction-1',
      toolCallId: 'ask-1',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    });
    const fixture = fakeSession(current);
    const committed = commitInteractionCommand(
      fixture.session,
      input({ type: 'input', interactionId: 'interaction-1', text: 'yes' }, current),
    );

    expect(committed.events.map((event) => event.type)).toEqual([
      'user_input.answered',
      'tool.finished',
    ]);
    expect(fixture.writes).toEqual([[...committed.events]]);
    expect(committed.descriptor.interactionId).toBe('interaction-1');
  });

  test('keeps approval settlement and provider reservation reconciliation in the command batch', () => {
    const approval = state();
    setInteraction(approval, {
      kind: 'awaiting_tool_approval',
      interactionId: 'interaction-1',
      toolCallId: 'shell-1',
      approval: {
        scope: 'once',
        cwd: '/workspace',
        threadId: approval.session.threadId,
        tool: 'shell_execute',
        command: 'printf test',
        risk: 'execute_code',
        approvalHash: 'approval-hash',
        summary: 'Run fixture',
        reason: 'test',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    });
    const approvalCommitted = commitInteractionCommand(
      fakeSession(approval).session,
      input(
        { type: 'reject', interactionId: 'interaction-1', generation: 0, reason: 'no' },
        approval,
      ),
    );
    expect(approvalCommitted.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['approval.rejected', 'tool.rejected']),
    );

    const provider = state();
    setInteraction(provider, {
      kind: 'awaiting_provider_action',
      interactionId: 'interaction-1',
      providerId: 'provider-1',
      action: 'login',
      originatingToolCallId: 'tool-1',
      status: 'required',
    });
    const reconciliation: RuntimeEvent = {
      type: 'resource_budget.released',
      reservationId: 'reservation-1',
    };
    const providerCommitted = commitInteractionCommand(fakeSession(provider).session, {
      ...input(
        { type: 'provider_action_result', interactionId: 'interaction-1', outcome: 'deferred' },
        provider,
      ),
      effectType: 'request_provider_action',
      reservationReconciliationEvents: [reconciliation],
      evidence: evidence('command_provider_fixture'),
    });
    expect(providerCommitted.events).toContainEqual(reconciliation);
  });

  test('commits a plan cancellation as one terminal interaction batch', () => {
    const current = state();
    setInteraction(current, {
      kind: 'awaiting_review',
      interactionId: 'interaction-1',
      toolCallId: 'plan-tool-1',
      planId: 'plan-1',
      version: 1,
      structuralDigest: 'plan-digest',
      plan: { name: 'Plan', description: '', status: 'pending', steps: [] },
      planSummary: 'Plan',
    });
    const committed = commitInteractionCommand(fakeSession(current).session, {
      ...input({ type: 'cancel', interactionId: 'interaction-1' }, current),
      effectType: 'request_plan_review',
      evidence: evidence('command_plan_fixture'),
    });
    expect(committed.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['plan.review_cancelled', 'tool.cancelled', 'turn.aborted']),
    );
  });

  test('fails before write on stale/no-event input and leaves a failed commit retryable', () => {
    const current = state();
    setInteraction(current, {
      kind: 'awaiting_user_input',
      interactionId: 'interaction-1',
      toolCallId: 'ask-1',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    });
    const stale = fakeSession(current);
    expect(() =>
      commitInteractionCommand(
        stale.session,
        input({ type: 'input', interactionId: 'other', text: 'no' }, current),
      ),
    ).toThrow('produced no accepted events');
    expect(stale.writes).toEqual([]);

    const failed = fakeSession(current, { fail: true });
    expect(() =>
      commitInteractionCommand(
        failed.session,
        input({ type: 'input', interactionId: 'interaction-1', text: 'yes' }, current),
      ),
    ).toThrow('injected interaction transaction failure');
    expect(failed.writes).toEqual([]);
    expect(() =>
      commitInteractionCommand(
        fakeSession(current).session,
        input({ type: 'input', interactionId: 'interaction-1', text: 'yes' }, current),
      ),
    ).not.toThrow();
  });
});
