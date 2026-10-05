import type { NativeRecoveryIntent } from '../src/native-bridge';

const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const recoveryPending = (value: NativeRecoveryIntent) =>
  ['submitting', 'accepted', 'outcome_unknown'].includes(value.phase);

/** Private UI metadata only. Neither a receipt nor permission to resume an Execution. */
export function validateRecoveryIntent(value: unknown): NativeRecoveryIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('recovery_storage_unavailable');
  const item = value as NativeRecoveryIntent;
  if (
    Object.keys(item).some(
      (key) =>
        ![
          'observationId',
          'storeId',
          'sessionId',
          'kind',
          'targetId',
          'originalCommandId',
          'commandId',
          'phase',
          'error',
        ].includes(key),
    ) ||
    !Number.isSafeInteger(item.observationId) ||
    item.observationId < 1 ||
    ![item.storeId, item.sessionId, item.commandId].every(id) ||
    !['run', 'report', 'interrupt'].includes(item.kind) ||
    ![
      'submitting',
      'accepted',
      'resumed',
      'interrupted',
      'suppressed',
      'failed',
      'outcome_unknown',
    ].includes(item.phase) ||
    (item.error !== undefined &&
      (typeof item.error !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item.error)))
  )
    throw Error('recovery_storage_unavailable');
  if (
    item.kind === 'interrupt'
      ? item.targetId !== undefined || item.originalCommandId !== undefined
      : !id(item.targetId) ||
        !id(item.originalCommandId) ||
        (item.kind === 'report' && item.targetId !== item.originalCommandId)
  )
    throw Error('recovery_storage_unavailable');
  if (Buffer.byteLength(JSON.stringify(item)) > 8192) throw Error('recovery_storage_unavailable');
  return structuredClone(item);
}
