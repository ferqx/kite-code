import { createHash } from 'node:crypto';
import { runtimeHostStateNormalizeToolRecoveryJournal } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  SubagentHandle,
  SubagentObservation,
  SuspendedSubagentSnapshot,
} from '@kite-ai/runtime-spi';
import { SUBAGENT_PROVIDER_SCHEMA_ } from '@kite-ai/runtime-spi';
import { deserializeSubagentContinuation } from './continuation-codec';
import type { SubAgentResult } from './types';

const RESOURCE_ADMISSION_FAILURE_REASONS_ = new Set([
  'budget_unconfigured',
  'persistence_unavailable',
  'budget_exhausted',
  'reconciliation_required',
  'tool_concurrency_saturated',
  'shell_concurrency_saturated',
]);
const SUBAGENT_FAILURE_CODES_ = new Set([
  'aborted',
  'timed_out',
  'invalid_input',
  'consumer_protocol',
  'model_step_failed',
  'internal_error',
]);
const SUBAGENT_FAILURE_STAGES_ = new Set([
  'initialization',
  'next_round_preparation',
  'model_step',
  'model_response_validation',
  'tool_consumption',
  'transcript_validation',
  'terminal_projection',
]);

/** Parent-only decoder for the bounded Provider observation envelope. */
export function subagentResultFromObservation(
  observation: Readonly<SubagentObservation>,
  expectedHandle: Readonly<SubagentHandle>,
  expectedRecoveryIdentityKey: string,
): SubAgentResult {
  const payload = observation.privatePayload as Record<string, unknown>;
  const envelopeKeys = [
    'schema',
    'handleId',
    'childInvocationId',
    'status',
    'summary',
    'toolCallCount',
    'durationMs',
    'observationDigest',
    'privatePayload',
  ].sort();
  const expectedKeys = [
    'blocked',
    'durationMs',
    'error',
    'executionJournal',
    'exhaustedFingerprints',
    'failureDiagnostic',
    'ok',
    'resourceAdmissionFailure',
    'steps',
    'summary',
    'terminalStatus',
    'toolCallCount',
    'toolRecovery',
  ].sort();
  if (
    observation.schema !== SUBAGENT_PROVIDER_SCHEMA_ ||
    observation.handleId !== expectedHandle.handleId ||
    observation.childInvocationId !== expectedHandle.childInvocationId ||
    JSON.stringify(Object.keys(observation).sort()) !== JSON.stringify(envelopeKeys) ||
    JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys) ||
    typeof payload.ok !== 'boolean' ||
    payload.summary !== observation.summary ||
    payload.toolCallCount !== observation.toolCallCount ||
    payload.durationMs !== observation.durationMs ||
    !Array.isArray(payload.steps) ||
    !Array.isArray(payload.executionJournal) ||
    !isRecord(payload.exhaustedFingerprints) ||
    !isRecord(payload.toolRecovery) ||
    ![null, 'completed', 'failed', 'cancelled', 'exhausted', 'suspended'].includes(
      payload.terminalStatus as null | string,
    ) ||
    !(payload.error === null || typeof payload.error === 'string') ||
    !validFailureDiagnostic(payload.failureDiagnostic) ||
    !(
      payload.resourceAdmissionFailure === null ||
      (isRecord(payload.resourceAdmissionFailure) &&
        JSON.stringify(Object.keys(payload.resourceAdmissionFailure).sort()) ===
          JSON.stringify([
            'childInvocationId',
            'message',
            'parentInvocationId',
            'parentToolCallId',
            'reason',
          ]) &&
        RESOURCE_ADMISSION_FAILURE_REASONS_.has(
          payload.resourceAdmissionFailure.reason as string,
        ) &&
        typeof payload.resourceAdmissionFailure.message === 'string' &&
        payload.resourceAdmissionFailure.message.length > 0 &&
        payload.resourceAdmissionFailure.parentInvocationId === expectedHandle.parentInvocationId &&
        payload.resourceAdmissionFailure.parentToolCallId === expectedHandle.parentToolCallId &&
        payload.resourceAdmissionFailure.childInvocationId === expectedHandle.childInvocationId)
    ) ||
    !(payload.blocked === null || isRecord(payload.blocked))
  ) {
    throw new Error('Subagent Provider observation payload is malformed or inconsistent.');
  }
  const body = {
    schema: observation.schema,
    handleId: observation.handleId,
    childInvocationId: observation.childInvocationId,
    status: observation.status,
    summary: observation.summary,
    toolCallCount: observation.toolCallCount,
    durationMs: observation.durationMs,
    privatePayload: observation.privatePayload,
  };
  const expectedDigest = `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
  if (observation.observationDigest !== expectedDigest) {
    throw new Error('Subagent Provider observation digest is invalid.');
  }
  const blockedSnapshot = payload.blocked as SuspendedSubagentSnapshot | null;
  const continuation = blockedSnapshot
    ? deserializeSubagentContinuation(blockedSnapshot, expectedRecoveryIdentityKey)
    : undefined;
  if ((observation.status === 'blocked') !== Boolean(continuation)) {
    throw new Error('Subagent Provider observation status does not match its continuation.');
  }
  const terminalStatus = payload.terminalStatus;
  const statusMatches =
    (observation.status === 'completed' && payload.ok === true && terminalStatus === 'completed') ||
    (observation.status === 'failed' && payload.ok === false && terminalStatus === 'failed') ||
    (observation.status === 'cancelled' &&
      payload.ok === false &&
      terminalStatus === 'cancelled') ||
    (observation.status === 'exhausted' &&
      payload.ok === false &&
      terminalStatus === 'exhausted') ||
    (observation.status === 'blocked' && payload.ok === false && terminalStatus === 'suspended');
  if (!statusMatches) {
    throw new Error('Subagent Provider observation terminal status is inconsistent.');
  }
  if (payload.resourceAdmissionFailure !== null && observation.status !== 'failed') {
    throw new Error('Subagent Provider resource terminal is inconsistent.');
  }
  if (
    payload.failureDiagnostic !== null &&
    observation.status !== 'failed' &&
    observation.status !== 'cancelled'
  ) {
    throw new Error('Subagent Provider failure diagnostic is inconsistent.');
  }
  const failureDiagnostic = validFailureDiagnostic(payload.failureDiagnostic)
    ? payload.failureDiagnostic
    : null;
  return {
    ok: payload.ok,
    summary: payload.summary as string,
    toolCallCount: payload.toolCallCount as number,
    durationMs: payload.durationMs as number,
    ...(typeof payload.terminalStatus === 'string'
      ? { terminalStatus: payload.terminalStatus as SubAgentResult['terminalStatus'] }
      : {}),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
    ...(failureDiagnostic ? { failureDiagnostic } : {}),
    ...(isRecord(payload.resourceAdmissionFailure)
      ? {
          resourceAdmissionFailure: payload.resourceAdmissionFailure as NonNullable<
            SubAgentResult['resourceAdmissionFailure']
          >,
        }
      : {}),
    steps: payload.steps as NonNullable<SubAgentResult['steps']>,
    executionJournal: payload.executionJournal as NonNullable<SubAgentResult['executionJournal']>,
    exhaustedFingerprints: payload.exhaustedFingerprints as NonNullable<
      SubAgentResult['exhaustedFingerprints']
    >,
    toolRecovery: runtimeHostStateNormalizeToolRecoveryJournal(
      payload.toolRecovery,
      expectedRecoveryIdentityKey,
    ),
    ...(continuation
      ? {
          blocked: {
            reasonCode: continuation.blockedTool.reasonCode,
            toolCallId: continuation.blockedTool.toolCallId,
            ...(continuation.blockedTool.runtimeToolCallId
              ? { runtimeToolCallId: continuation.blockedTool.runtimeToolCallId }
              : {}),
            toolName: continuation.blockedTool.toolName,
            command: continuation.blockedTool.command,
            args: continuation.blockedTool.args,
            ...(continuation.blockedTool.approvalBinding
              ? { approvalBinding: continuation.blockedTool.approvalBinding }
              : {}),
            message: `Sub-agent tool '${continuation.blockedTool.toolName}' requires approval.`,
            continuation,
          },
        }
      : {}),
  };
}

function validFailureDiagnostic(
  value: unknown,
): value is NonNullable<SubAgentResult['failureDiagnostic']> | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'code',
    'stage',
    ...(typeof value.modelInvocationId === 'string' ? ['modelInvocationId'] : []),
  ].sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    SUBAGENT_FAILURE_CODES_.has(value.code as string) &&
    SUBAGENT_FAILURE_STAGES_.has(value.stage as string) &&
    value.admissionReason === undefined &&
    (value.modelInvocationId === undefined ||
      (typeof value.modelInvocationId === 'string' && value.modelInvocationId.length > 0))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
