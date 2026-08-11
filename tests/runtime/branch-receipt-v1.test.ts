import { describe, expect, test } from 'bun:test';
import {
  decodeBranchCopiedTerminalClosureV1,
  decodeBranchMutationCompletionV1,
  decodeBranchMutationReceiptV1,
  encodeBranchCopiedTerminalClosureV1,
  encodeBranchMutationCompletionV1,
  encodeBranchMutationReceiptV1,
  finalizeBranchCopiedTerminalClosureV1,
  finalizeBranchMutationCompletionV1,
  finalizeBranchMutationReceiptV1,
} from '@/core/runtime/branch-receipt-v1';
import type { RuntimeEvent } from '@/core/runtime/events';
import { buildRuntimeEventEnvelopeV24 } from '@/core/runtime/runtime-event-v24';

const zeroUsage = {
  counters: {
    turns: 0,
    modelRequests: 0,
    toolInvocations: 0,
    inputTokens: 0,
    outputTokens: 0,
    artifactBytes: 0,
  },
  gauges: {
    elapsedRunMs: 0,
    activeSubagents: 0,
    activeWriters: 0,
    activeToolInvocations: 0,
    activeShellInvocations: 0,
  },
  source: 'actual' as const,
};

function envelope(type: RuntimeEvent['type'], revision: number) {
  const summarySourceIdentity = {
    version: 1 as const,
    firstMessageId: 'first',
    coveredThroughMessageId: 'last',
    coveredThroughTurnId: 'turn',
    canonicalSourceDigest: '1'.repeat(64),
    sourceProjectionPolicyId: 'canonical-transcript-blocks:v1',
  };
  const continuation = {
    turnId: 'turn',
    requestedAtRevision: 1,
    summarySourceIdentity,
  };
  const originReceipt = {
    version: 1 as const,
    generation: 2,
    attemptId: 'attempt',
    compactionId: 'compaction',
    continuation,
    origin: {
      kind: 'summary_terminal' as const,
      terminalBatchId: 'terminal',
      terminalEventId: '2'.repeat(64),
      resourceTerminalEventId: '3'.repeat(64),
    },
  };
  const consumptionKey = {
    version: 1 as const,
    generation: 2,
    consumptionBatchId: 'consumption',
    attemptId: 'attempt',
    compactionId: 'compaction',
    continuation,
    originReceipt,
    primaryEffectLeaseId: 'lease',
    primaryInvocationId: 'invocation',
    primaryRequestId: 'request',
    resourceReservationId: 'reservation',
  };
  const payload = (
    type === 'context.normal_reprepare_consumed_v1'
      ? { type, consumptionKey }
      : type === 'resource_budget.reserved'
        ? {
            type,
            reservation: {
              version: 1,
              reservationId: 'reservation',
              runId: 'run',
              invocationId: 'invocation',
              resourceKind: 'model',
              executableUpperBound: zeroUsage,
              state: 'reserved',
            },
          }
        : type === 'resource_budget.dispatch_started'
          ? { type, reservationId: 'reservation' }
          : type === 'resource_budget.reconciled'
            ? { type, reservationId: 'reservation', actual: zeroUsage }
            : type === 'model.responded'
              ? { type, messageId: 'message' }
              : { type }
  ) as RuntimeEvent;
  return buildRuntimeEventEnvelopeV24({
    threadId: 'source',
    generation: 2,
    revision,
    occurredAt: new Date(revision).toISOString(),
    payload,
  });
}

describe('branch receipt v1', () => {
  test('encodes the exact five-role success closure as bounded BCTC authority', () => {
    const body = {
      version: 1 as const,
      targetThreadId: 'target',
      targetGeneration: 3,
      branchMutationReceiptId: 'a'.repeat(64),
      sourceThreadId: 'source',
      sourceGeneration: 2,
      sourceSelectedCutProofDigest: 'b'.repeat(64),
      terminal: {
        kind: 'success' as const,
        envelopes: [
          {
            role: 'continuation_consumed' as const,
            envelope: envelope('context.normal_reprepare_consumed_v1', 1),
          },
          {
            role: 'primary_resource_reserved' as const,
            envelope: envelope('resource_budget.reserved', 2),
          },
          {
            role: 'primary_resource_dispatch_started' as const,
            envelope: envelope('resource_budget.dispatch_started', 3),
          },
          { role: 'primary_terminal' as const, envelope: envelope('model.responded', 4) },
          {
            role: 'resource_terminal' as const,
            envelope: envelope('resource_budget.reconciled', 5),
          },
        ],
      },
    };
    const closure = finalizeBranchCopiedTerminalClosureV1(body);
    const bytes = encodeBranchCopiedTerminalClosureV1(body);
    expect(bytes.subarray(0, 7)).toEqual(Buffer.from([0x42, 0x43, 0x54, 0x43, 1, 1, 5]));
    expect(closure.closureChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(bytes.length).toBeLessThanOrEqual(768 * 1024);
    expect(decodeBranchCopiedTerminalClosureV1(bytes, closure.closureChecksum)).toEqual(closure);

    expect(() =>
      encodeBranchCopiedTerminalClosureV1({
        ...body,
        terminal: {
          ...body.terminal,
          envelopes: [...body.terminal.envelopes].reverse(),
        },
      }),
    ).toThrow('exact five/six-role ordering');
  });

  test('freezes receipt and completion checksums under their independent domains', () => {
    const receipt = finalizeBranchMutationReceiptV1({
      version: 1,
      receiptId: 'c'.repeat(64),
      reason: 'fork',
      sourceThreadId: 'source',
      sourceGeneration: 2,
      targetThreadId: 'target',
      targetGeneration: 3,
      selectedCutDigest: 'd'.repeat(64),
      targetLedgerBaseId: 'e'.repeat(64),
      manifest: {
        kind: 'settled_detach',
        eventIds: ['f'.repeat(64)],
        eventTypes: ['context.normal_reprepare_consumption_detached_v1'],
      },
      baseRevision: 10,
      finalRevision: 11,
      postSnapshotDigest: '1'.repeat(64),
      terminalClosure: { kind: 'copied', closureChecksum: '2'.repeat(64) },
    });
    const completion = finalizeBranchMutationCompletionV1({
      version: 1,
      receiptId: receipt.receiptId,
      targetThreadId: 'target',
      targetGeneration: 3,
      requestDigest: '3'.repeat(64),
      candidateDigest: '4'.repeat(64),
      manifestDigest: '5'.repeat(64),
      postSnapshotDigest: receipt.postSnapshotDigest,
    });
    expect(receipt.receiptChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(completion.completionChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(completion.completionChecksum).not.toBe(receipt.receiptChecksum);
    expect(decodeBranchMutationReceiptV1(encodeBranchMutationReceiptV1(receipt))).toEqual(receipt);
    expect(decodeBranchMutationCompletionV1(encodeBranchMutationCompletionV1(completion))).toEqual(
      completion,
    );
  });

  test('rejects trailing BCTC bytes and non-canonical receipt fields', () => {
    const body = {
      version: 1 as const,
      targetThreadId: 'target',
      targetGeneration: 3,
      branchMutationReceiptId: 'a'.repeat(64),
      sourceThreadId: 'source',
      sourceGeneration: 2,
      sourceSelectedCutProofDigest: 'b'.repeat(64),
      terminal: {
        kind: 'success' as const,
        envelopes: [
          {
            role: 'continuation_consumed' as const,
            envelope: envelope('context.normal_reprepare_consumed_v1', 1),
          },
          {
            role: 'primary_resource_reserved' as const,
            envelope: envelope('resource_budget.reserved', 2),
          },
          {
            role: 'primary_resource_dispatch_started' as const,
            envelope: envelope('resource_budget.dispatch_started', 3),
          },
          { role: 'primary_terminal' as const, envelope: envelope('model.responded', 4) },
          {
            role: 'resource_terminal' as const,
            envelope: envelope('resource_budget.reconciled', 5),
          },
        ],
      },
    };
    const closure = finalizeBranchCopiedTerminalClosureV1(body);
    expect(() =>
      decodeBranchCopiedTerminalClosureV1(
        Buffer.concat([encodeBranchCopiedTerminalClosureV1(body), Buffer.from([0])]),
        closure.closureChecksum,
      ),
    ).toThrow('trailing bytes');

    const forged = Buffer.from(
      JSON.stringify({
        version: 1,
        receiptId: 'c'.repeat(64),
        unexpected: true,
      }),
    );
    expect(() => decodeBranchMutationReceiptV1(forged)).toThrow('missing or unknown fields');
  });
});
