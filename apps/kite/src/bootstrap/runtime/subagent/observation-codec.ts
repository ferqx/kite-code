import { createHash } from 'node:crypto';
import { runtimeHostStateNormalizeToolRecoveryJournal } from '@kite/runtime-host/kernel-adapter';
import type {
  SubagentHandle,
  SubagentObservation,
  SuspendedSubagentSnapshot,
} from '@kite/runtime-spi';
import { SUBAGENT_PROVIDER_SCHEMA_ } from '@kite/runtime-spi';
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
  return {
    ok: payload.ok,
    summary: payload.summary as string,
    toolCallCount: payload.toolCallCount as number,
    durationMs: payload.durationMs as number,
    ...(typeof payload.terminalStatus === 'string'
      ? { terminalStatus: payload.terminalStatus as SubAgentResult['terminalStatus'] }
      : {}),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
