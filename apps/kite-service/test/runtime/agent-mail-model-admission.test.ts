import { describe, expect, test } from 'bun:test';
import { validateRootAgentMailModelAdmission } from '#kite-service/bootstrap/runtime/RuntimeSessionCoordinator';
import type { RuntimeAgentMailModelAdmissionInput } from '#kite-service/bootstrap/runtime/state-runner';
import type { RuntimeEvent, RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';

const sessionId = 'session-1';
const runId = 'run-1';
const fundingLedgerId = 'funding-ledger-1';
const invocationId = 'model-1';
const reservationId = 'reserve-1';

function input(admissionId = invocationId) {
  const model = {
    type: 'model.invocation_prepared',
    invocationId,
    purpose: 'primary_agent',
    parentInvocationId: null,
    parentToolCallId: null,
    budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
  } as RuntimeEvent;
  const prepared = {
    type: 'agent.mail_input_prepared',
    targetAgentId: sessionId,
    invocationId,
    modelAdmissionId: admissionId,
    fromSequence: 0,
    throughSequence: 1,
    messageIds: ['mail-1'],
  } as RuntimeEvent;
  const mutation: RuntimeAgentMailModelAdmissionInput['mutation'] = {
    kind: 'prepare_input',
    targetAgentId: sessionId,
    modelInvocationId: invocationId,
    modelAdmissionId: admissionId,
    fromSequence: 0,
    throughSequence: 1,
    messageIds: ['mail-1'],
  };
  return { events: [model, prepared], mutation };
}

function budgeted() {
  const original = input(reservationId);
  return {
    ...original,
    events: original.events.map((event) =>
      event.type === 'model.invocation_prepared'
        ? ({
            ...event,
            budget: { kind: 'reservation', reservationId, parentReservationId: null },
          } as RuntimeEvent)
        : event,
    ),
  };
}

const reservation = {
  version: 1,
  reservationId,
  runId: fundingLedgerId,
  invocationId: `model-invocation:${invocationId}`,
  resourceKind: 'model',
  state: 'reserved',
  executableUpperBound: {},
} as unknown as Extract<
  RuntimeState['resourceBudget'],
  { status: 'active' }
>['reservations'][string];

function activeBudget(reservations: Record<string, typeof reservation> = {}) {
  return {
    status: 'active',
    runId: fundingLedgerId,
    reservations,
  } as RuntimeState['resourceBudget'];
}

describe('root Agent mail model admission', () => {
  test('requires invocation identity as unique admission when budget is unconfigured', () => {
    const valid = input();
    expect(() =>
      validateRootAgentMailModelAdmission({
        ...valid,
        resourceBudget: { status: 'unconfigured', reservations: {} },
        sessionId,
      }),
    ).not.toThrow();
    expect(() =>
      validateRootAgentMailModelAdmission({
        ...input('another-admission'),
        resourceBudget: { status: 'unconfigured', reservations: {} },
        sessionId,
      }),
    ).toThrow(/identity/u);
  });

  test('accepts exact same-batch, persisted, and bounded replacement model reservations', () => {
    // The persisted funding ledger has its own identity across foreground Runs.
    expect(fundingLedgerId).not.toBe(runId);
    const valid = budgeted();
    for (const events of [
      [...valid.events, { type: 'resource_budget.reserved', reservation } as RuntimeEvent],
      valid.events,
      [
        ...valid.events,
        {
          type: 'resource_budget.bounded_replaced',
          reservationId: 'backup-1',
          turnReservation: { ...reservation, reservationId: 'turn-1', resourceKind: 'subagent' },
          replacement: { ...reservation, replacesReservationId: 'backup-1' },
        } as RuntimeEvent,
      ],
    ]) {
      expect(() =>
        validateRootAgentMailModelAdmission({
          ...valid,
          events,
          resourceBudget: activeBudget({ [reservationId]: reservation }),
          sessionId,
        }),
      ).not.toThrow();
    }
    expect(() =>
      validateRootAgentMailModelAdmission({
        ...valid,
        events: [
          ...valid.events,
          { type: 'resource_budget.reserved', reservation } as RuntimeEvent,
        ],
        resourceBudget: activeBudget(),
        sessionId,
      }),
    ).not.toThrow();
  });

  test('rejects wrong funding Run, mismatched watermark, duplicate model, and admission conflicts', () => {
    const valid = budgeted();
    const base = {
      ...valid,
      resourceBudget: activeBudget({ [reservationId]: reservation }),
      sessionId,
    };
    expect(() =>
      validateRootAgentMailModelAdmission({
        ...base,
        resourceBudget: activeBudget({
          [reservationId]: { ...reservation, runId: 'wrong-funding-ledger' },
        }),
      }),
    ).toThrow();
    expect(() =>
      validateRootAgentMailModelAdmission({
        ...base,
        resourceBudget: activeBudget({
          [reservationId]: { ...reservation, invocationId },
        }),
      }),
    ).toThrow();
    expect(() =>
      validateRootAgentMailModelAdmission({
        ...base,
        mutation: { ...valid.mutation, throughSequence: 2 },
      }),
    ).toThrow();
    expect(() =>
      validateRootAgentMailModelAdmission({
        ...base,
        events: [...valid.events, valid.events[0]!],
      }),
    ).toThrow();
    expect(() =>
      validateRootAgentMailModelAdmission({
        ...base,
        events: [
          ...valid.events,
          {
            type: 'resource_budget.reserved',
            reservation: { ...reservation, reservationId: 'other-reservation' },
          } as RuntimeEvent,
        ],
      }),
    ).toThrow();
  });
});
