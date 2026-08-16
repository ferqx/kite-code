import { verificationRequestForCapability } from '@/core/verification';
import { isCommittedToolReceiptV1 } from './receipt';
import {
  type ReceiptCommittedOutcomeV1,
  TOOL_PIPELINE_STAGE_SCHEMA_V1,
  type ToolVerificationStageContextV1,
  type ToolVerificationStageOutcomeV1,
  type VerificationPlannedOutcomeV1,
} from './types';

/**
 * Build verification only from the unforgeable receipt returned after the
 * immutable result Artifact has been published. The resulting event remains
 * in the same Kernel terminal batch as that receipt and the Tool terminal.
 */
export function planCommittedToolVerificationV1(
  receipt: Readonly<ReceiptCommittedOutcomeV1>,
  context: Readonly<ToolVerificationStageContextV1>,
): Readonly<ToolVerificationStageOutcomeV1> {
  assertCommittedReceipt(receipt);
  if (!context.enabled) return Object.freeze({ kind: 'not_requested', reason: 'disabled' });

  const classified = receipt.normalized.dispatched.recorded.admitted.authorized.policy.classified;
  if (classified.validated.resolved.target.executionFamily !== 'mcp') {
    return Object.freeze({ kind: 'not_requested', reason: 'unsupported_family' });
  }
  const terminal = receipt.terminalEvents[0];
  if (terminal?.type !== 'capability.execution_succeeded') {
    return Object.freeze({ kind: 'not_requested', reason: 'receipt_failed' });
  }

  const descriptor = classified.validated.resolved.target.descriptor;
  const event = verificationRequestForCapability({
    invocationId: receipt.normalized.dispatched.recorded.invocationId,
    capabilityId: descriptor.capabilityId,
    effects: classified.effectiveEffects,
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(terminal.externalReferences
      ? { externalReferences: [...terminal.externalReferences] }
      : {}),
    ...(context.requestedAt ? { requestedAt: context.requestedAt } : {}),
  });
  return Object.freeze({
    kind: 'planned',
    value: Object.freeze({
      schema: TOOL_PIPELINE_STAGE_SCHEMA_V1,
      stage: 'verification_planned',
      receipt,
      verificationEvents: Object.freeze([event]),
    } satisfies VerificationPlannedOutcomeV1),
  });
}

function assertCommittedReceipt(receipt: Readonly<ReceiptCommittedOutcomeV1>): void {
  const invocationId = receipt.normalized?.dispatched?.recorded?.invocationId;
  const terminal = receipt.terminalEvents?.[0];
  if (
    !isCommittedToolReceiptV1(receipt) ||
    receipt.schema !== TOOL_PIPELINE_STAGE_SCHEMA_V1 ||
    receipt.stage !== 'receipt_committed' ||
    receipt.terminalEvents.length !== 1 ||
    (terminal?.type !== 'capability.execution_succeeded' &&
      terminal?.type !== 'capability.execution_failed') ||
    terminal.invocationId !== invocationId
  ) {
    throw new Error('Tool verification requires a matching committed capability receipt.');
  }
}
