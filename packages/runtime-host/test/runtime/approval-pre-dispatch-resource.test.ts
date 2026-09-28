import { expect, test } from 'bun:test';
import {
  actualUsageForReservation,
  createRuntimeHostStateInitialState,
  createZeroResourceUsage,
} from '@kite-ai/runtime-host/kernel-adapter';

test('waiting for an exact user approval does not consume the Tool artifact ceiling', () => {
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'child-session',
    userId: 'user',
    workspace: '/',
  });
  const upper = createZeroResourceUsage('versioned_upper_bound', 'approval-test');
  upper.counters.toolInvocations = 1;
  upper.counters.artifactBytes = 64 * 1024 * 1024;
  const reservation = {
    version: 1 as const,
    reservationId: 'tool-reservation',
    runId: 'child-run',
    invocationId: 'tool:approved-tool',
    resourceKind: 'tool' as const,
    executableUpperBound: upper,
    state: 'dispatch_started' as const,
  };
  const waiting = {
    ...initial,
    tools: {
      ...initial.tools,
      calls: {
        ...initial.tools.calls,
        'approved-tool': { toolCallId: 'approved-tool', status: 'awaiting_approval' },
      },
    },
    pendingApprovals: new Map([
      [
        'approval-1',
        {
          interactionId: 'approval-1',
          toolCallId: 'approved-tool',
          route: 'user',
          status: 'awaiting_user',
        },
      ],
    ]),
  } as unknown as Parameters<typeof actualUsageForReservation>[0];
  expect(actualUsageForReservation(waiting, reservation).counters.artifactBytes).toBe(0);
  expect(actualUsageForReservation(waiting, reservation).counters.toolInvocations).toBe(0);
  const noApproval = {
    ...waiting,
    pendingApprovals: new Map(),
  } as Parameters<typeof actualUsageForReservation>[0];
  expect(actualUsageForReservation(noApproval, reservation).counters.artifactBytes).toBe(
    64 * 1024 * 1024,
  );
  const approved = {
    ...waiting,
    approvalReceipts: new Map([
      [
        'receipt-1',
        {
          receiptId: 'receipt-1',
          interactionId: 'approval-1',
          toolCallId: 'approved-tool',
          generation: 0,
          grant: 'approve_once' as const,
          status: 'authorized_queued' as const,
          dispatchState: 'before_dispatch' as const,
        },
      ],
    ]),
  } as Parameters<typeof actualUsageForReservation>[0];
  expect(
    actualUsageForReservation(
      approved,
      { ...reservation, invocationId: 'tool:approved-tool:approval:receipt-1' },
      [{ type: 'tool.file_change', toolCallId: 'approved-tool', path: 'missing', kind: 'edit' }],
    ).counters.artifactBytes,
  ).toBe(0);
});

test('waiting for automatic review does not consume the Tool artifact ceiling', () => {
  const initial = createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'b'.repeat(64),
    threadId: 'auto-review-session',
    userId: 'user',
    workspace: '/',
  });
  const upper = createZeroResourceUsage('versioned_upper_bound', 'approval-test');
  upper.counters.toolInvocations = 1;
  upper.counters.artifactBytes = 64 * 1024 * 1024;
  const reservation = {
    version: 1 as const,
    reservationId: 'auto-tool-reservation',
    runId: 'child-run',
    invocationId: 'tool:auto-reviewed-tool',
    resourceKind: 'tool' as const,
    executableUpperBound: upper,
    state: 'dispatch_started' as const,
  };
  const awaiting = {
    ...initial,
    tools: {
      ...initial.tools,
      calls: {
        ...initial.tools.calls,
        'auto-reviewed-tool': {
          toolCallId: 'auto-reviewed-tool',
          status: 'awaiting_auto_review',
        },
      },
    },
    pendingApprovals: new Map([
      [
        'auto-review-1',
        {
          interactionId: 'auto-review-1',
          toolCallId: 'auto-reviewed-tool',
          route: 'auto',
          status: 'auto_reviewing',
          dispatchState: 'before_dispatch',
        },
      ],
    ]),
  } as unknown as Parameters<typeof actualUsageForReservation>[0];
  expect(actualUsageForReservation(awaiting, reservation).counters.artifactBytes).toBe(0);
  expect(actualUsageForReservation(awaiting, reservation).counters.toolInvocations).toBe(0);
  const dispatched = {
    ...awaiting,
    tools: {
      ...awaiting.tools,
      calls: {
        ...awaiting.tools.calls,
        'auto-reviewed-tool': {
          toolCallId: 'auto-reviewed-tool',
          status: 'running',
        },
      },
    },
  } as unknown as Parameters<typeof actualUsageForReservation>[0];
  expect(actualUsageForReservation(dispatched, reservation).counters.artifactBytes).toBe(
    64 * 1024 * 1024,
  );
});
