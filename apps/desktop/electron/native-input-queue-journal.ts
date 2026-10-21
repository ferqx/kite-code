import type { ReorderPendingInputsRequest, WithdrawPendingInputRequest } from '@kite-ai/client';
import { validateRequest } from '@kite-ai/client';
import type { NativeInputQueueSubmission } from '../src/input-queue-bridge';
import { callerCanonical, callerDigest } from './caller-journal';

export type NativeQueueRecord = {
  scope: NativeInputQueueSubmission['scope'];
  subjectId: string;
  request: WithdrawPendingInputRequest | ReorderPendingInputsRequest;
  operation: NativeInputQueueSubmission['operation'];
  phase: NativeInputQueueSubmission['phase'];
  requestDigest: string;
  text?: string;
  error?: string;
  delivered?: boolean;
};
export interface NativeQueueData {
  inputQueueRecords(): NativeQueueRecord[];
  saveInputQueueRecord(record: NativeQueueRecord): void;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function parseNativeQueueRecord(raw: unknown): NativeQueueRecord {
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (k) =>
        ![
          'scope',
          'subjectId',
          'request',
          'operation',
          'phase',
          'requestDigest',
          'text',
          'error',
          'delivered',
        ].includes(k),
    ) ||
    !object(raw.scope) ||
    Object.keys(raw.scope).sort().join(',') !== 'sessionId,storeId,workspaceId' ||
    !Object.values(raw.scope).every(id) ||
    typeof raw.subjectId !== 'string' ||
    !raw.subjectId ||
    raw.subjectId.length > 256 ||
    !object(raw.request) ||
    (raw.operation === 'edit' ? typeof raw.delivered !== 'boolean' : raw.delivered !== undefined) ||
    (raw.delivered === true && raw.phase !== 'applied')
  )
    throw Error('input_queue_storage_unavailable');
  const request = raw.request;
  const schema =
    request.kind === 'input.withdraw'
      ? 'WithdrawPendingInputRequest'
      : request.kind === 'input.reorder'
        ? 'ReorderPendingInputsRequest'
        : undefined;
  if (!schema) throw Error('input_queue_storage_unavailable');
  validateRequest(schema, request);
  const { expectedStoreId, commandId: _command, ...body } = request;
  const keys =
    request.kind === 'input.withdraw'
      ? ['kind', 'expectedStoreId', 'commandId', 'targetCommandId', 'expectedRevision']
      : ['kind', 'expectedStoreId', 'commandId', 'commandIds', 'expectedRevision'];
  if (
    Object.keys(request).sort().join(',') !== keys.sort().join(',') ||
    expectedStoreId !== raw.scope.storeId ||
    callerDigest(body) !== raw.requestDigest ||
    !['submitting', 'unknown', 'applied', 'rejected'].includes(String(raw.phase)) ||
    (request.kind === 'input.withdraw'
      ? !['edit', 'delete'].includes(String(raw.operation))
      : raw.operation !== 'reorder') ||
    (raw.operation === 'edit'
      ? typeof raw.text !== 'string' || !raw.text.trim() || Buffer.byteLength(raw.text) > 1048576
      : raw.text !== undefined) ||
    (raw.error !== undefined &&
      (typeof raw.error !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(raw.error)))
  )
    throw Error('input_queue_storage_unavailable');
  return structuredClone(raw) as NativeQueueRecord;
}
export function assertQueueRecordTransition(old: NativeQueueRecord, next: NativeQueueRecord) {
  const identity = ({
    phase: _phase,
    error: _error,
    delivered: _delivered,
    ...rest
  }: NativeQueueRecord) => callerCanonical(rest);
  if (
    identity(old) !== identity(next) ||
    (['applied', 'rejected'].includes(old.phase) && old.phase !== next.phase) ||
    (old.delivered === true && next.delivered !== true) ||
    (next.delivered === true && next.phase !== 'applied')
  )
    throw Error('input_queue_intent_conflict');
}
