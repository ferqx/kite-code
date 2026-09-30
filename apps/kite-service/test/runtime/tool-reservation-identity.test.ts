import { describe, expect, test } from 'bun:test';
import type { AgentPendingApproval } from '@kite-ai/agent-kernel';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import {
  createRuntimeHostStateInitialState,
  LIMITED_RESOURCE_BUDGET_,
  planRuntimeBudgetAdmission,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { executeTestRuntimeTools } from '../../../../tests/helpers/runtime-model';
import { resourceReservationBelongsToToolCall } from '../../src/bootstrap/runtime/tool-reservation-identity';

function reservedState(toolCallIds: string[], siblingId = 'call-extra'): RuntimeState {
  let state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'tool-reservation-identity',
    userId: 'user',
    workspace: '/workspace',
  });
  state = reduceRuntimeState(state, {
    type: 'resource_budget.configured',
    runId: state.turn.turnId,
    startedAt: '2026-09-30T00:00:00Z',
    deadlineAt: '2026-09-30T00:30:00Z',
    budget: LIMITED_RESOURCE_BUDGET_,
  });
  for (const toolCallId of ['call', siblingId]) {
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'message',
      ordinal: toolCallId === 'call' ? 0 : 1,
      name: 'list_mcp_resources',
      args: {},
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
  }
  state.tools.queue = ['call', siblingId];
  const plan = planRuntimeBudgetAdmission(
    state,
    { type: 'run_tools', toolCallIds },
    new Date('2026-09-30T00:00:01Z'),
  );
  expect(plan.status).toBe('admitted');
  return [...plan.preparationEvents, ...plan.dispatchEvents].reduce(reduceRuntimeState, state);
}

function suffixFacts(state: RuntimeState): void {
  (state.pendingApprovals as Map<string, AgentPendingApproval>).set('approval', {
    interactionId: 'approval',
    toolCallId: 'call',
    route: 'user',
    fullModeBypassEligible: false,
    fullModePolicyBypassAllowed: false,
    bindingDigest: 'a'.repeat(64),
    approval: {
      scope: 'once',
      cwd: state.session.workspace,
      threadId: state.session.threadId,
      tool: 'list_mcp_resources',
      command: 'list_mcp_resources',
      risk: 'read',
      approvalHash: 'a'.repeat(64),
      summary: 'Read resources',
      reason: 'Fixture approval',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
    },
    invocation: {},
    sequence: 1,
    generation: 1,
    createdAt: '2026-09-30T00:00:00Z',
    status: 'authorized_queued',
    dispatchState: 'before_dispatch',
    receiptId: 'receipt',
  });
  state.suspendedSubagents.call = {
    storage: 'private_artifact_v1',
    subagentId: 'subagent',
    role: 'code',
    continuationId: `continuation-${'a'.repeat(64)}`,
    modelInvocationOrdinal: 0,
    continuationArtifact: {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'subagent_continuation',
      integrityIdentifier: `sha256:${'c'.repeat(64)}`,
      byteLength: 1,
    },
    parentInvocationId: 'parent',
    parentAttempt: 1,
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'nested',
      toolName: 'shell_execute',
    },
  };
}

describe('Tool reservation identity', () => {
  test('accepts only live reservations with the current approval receipt or resume attempt', () => {
    const state = reservedState(['call']);
    suffixFacts(state);
    if (state.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
    const reservation = Object.values(state.resourceBudget.reservations)[0]!;
    const belongs = (invocationId: string) =>
      resourceReservationBelongsToToolCall(state, 'call', { ...reservation, invocationId });
    expect(belongs('tool:call')).toBe(true);
    expect(belongs('tool:call:approval:receipt')).toBe(true);
    expect(belongs('tool:call:resume:1')).toBe(true);
    expect(belongs('tool:call:approval:old-receipt')).toBe(false);
    expect(belongs('tool:call:resume:2')).toBe(false);
    expect(belongs('tool:call:other')).toBe(false);
    expect(
      resourceReservationBelongsToToolCall(state, 'call', {
        ...reservation,
        state: 'released',
      }),
    ).toBe(false);
    expect(
      resourceReservationBelongsToToolCall(state, 'call', {
        ...reservation,
        state: 'reconciled',
      }),
    ).toBe(false);
  });

  test.each([
    'call:resume:1',
    'call:approval:receipt',
  ])('rejects ambiguous sibling %s even when matching suffix facts exist', (siblingId) => {
    const state = reservedState([siblingId], siblingId);
    suffixFacts(state);
    if (state.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
    const reservation = Object.values(state.resourceBudget.reservations)[0]!;
    expect(resourceReservationBelongsToToolCall(state, 'call', reservation)).toBe(false);
    expect(resourceReservationBelongsToToolCall(state, siblingId, reservation)).toBe(true);
  });

  test.each([
    'call-extra',
    'call:other',
    'call:resume:1',
    'call:approval:receipt',
  ])('does not dispatch a call using only sibling %s reservation', async (siblingId) => {
    let reads = 0;
    const events = await executeTestRuntimeTools({
      state: reservedState([siblingId], siblingId),
      toolCallIds: ['call'],
      mcpManager: {
        getCapabilitySnapshot: () => ({ revision: 'empty', descriptors: [] }),
        getProviderDirectorySnapshot: () => ({ revision: 'empty', entries: [] }),
        getResourceDirectorySnapshot: () => {
          reads++;
          return { revision: 'empty', resources: [] };
        },
        findCapability: () => undefined,
        callCapability: async () => ({ content: [] }),
        readResource: async () => '',
      },
    });
    expect(reads).toBe(0);
    expect(events.filter((event) => event.type === 'capability.execution_started')).toEqual([]);
    expect(events.find((event) => event.type === 'tool.rejected')).toMatchObject({
      toolCallId: 'call',
      reason: 'A current Runtime reservation is required before admission.',
    });
  });

  test.each([
    'call-extra',
    'call:other',
    'call:resume:1',
    'call:approval:receipt',
  ])('binds admission to the exact call while sibling %s is reserved', async (siblingId) => {
    const state = reservedState(['call', siblingId], siblingId);
    if (state.resourceBudget.status !== 'active') throw new Error('Expected active budget.');
    const ownReservationIds = Object.values(state.resourceBudget.reservations)
      .filter((reservation) => reservation.invocationId === 'tool:call')
      .map((reservation) => reservation.reservationId);
    expect(ownReservationIds).toHaveLength(1);
    const events = await executeTestRuntimeTools({
      state,
      toolCallIds: ['call'],
      mcpManager: {
        getCapabilitySnapshot: () => ({ revision: 'empty', descriptors: [] }),
        getProviderDirectorySnapshot: () => ({ revision: 'empty', entries: [] }),
        getResourceDirectorySnapshot: () => ({ revision: 'empty', resources: [] }),
        findCapability: () => undefined,
        callCapability: async () => ({ content: [] }),
        readResource: async () => '',
      },
    });
    const recorded = events.find((event) => event.type === 'capability.invocation_recorded');
    if (recorded?.type !== 'capability.invocation_recorded')
      throw new Error('Expected acknowledged capability invocation.');
    expect(recorded.admissionDigest).toBe(
      digestCapabilityValue({
        authorizationDigest: recorded.authorizationDigest,
        reservationIds: ownReservationIds,
        freshness: 'current',
      }),
    );
    expect(events.find((event) => event.type === 'tool.finished')).toMatchObject({
      toolCallId: 'call',
      result: { ok: true },
    });
  });
});
