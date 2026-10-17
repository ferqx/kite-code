import {
  isStorageTransactionUnconfirmed,
  markStorageTransactionUnconfirmed,
} from '../transaction-state';
import { AgentError } from '../types';

export {
  isStorageTransactionUnconfirmed,
  markStorageTransactionUnconfirmed,
} from '../transaction-state';

export type StorageWorkerError = {
  code: string;
  message: string;
  cause?: StorageWorkerError;
  errors?: StorageWorkerError[];
  transactionUnconfirmed?: true;
};
const detailLimit = (): StorageWorkerError => ({
  code: 'storage_error_detail_limit',
  message: 'Additional error details are cyclic or exceed the Worker error boundary.',
});

/** Preserve transaction/cleanup failures across the private Worker boundary, with finite traversal. */
export function serializeStorageError(error: unknown): StorageWorkerError {
  const path = new Set<object>();
  let remaining = 64;
  function visit(value: unknown, depth: number): StorageWorkerError {
    if (--remaining < 0 || depth > 16) return detailLimit();
    const object = value !== null && typeof value === 'object' ? value : undefined;
    if (object && path.has(object)) return detailLimit();
    if (object) path.add(object);
    try {
      const result: StorageWorkerError = {
        code: object && 'code' in object ? String(object.code) : 'storage_error',
        message: value instanceof Error ? value.message : String(value),
      };
      if (isStorageTransactionUnconfirmed(value)) result.transactionUnconfirmed = true;
      if (object && 'cause' in object && object.cause !== undefined)
        result.cause = visit(object.cause, depth + 1);
      if (value instanceof AggregateError) {
        result.errors = [];
        for (const child of value.errors) {
          if (remaining <= 0) {
            result.errors.push(detailLimit());
            break;
          }
          result.errors.push(visit(child, depth + 1));
        }
      }
      return result;
    } finally {
      if (object) path.delete(object);
    }
  }
  return visit(error, 0);
}

export function deserializeStorageError(input: StorageWorkerError): Error & { code: string } {
  let remaining = 64;
  const path = new Set<StorageWorkerError>();
  function visit(value: StorageWorkerError, depth: number): Error & { code: string } {
    if (--remaining < 0 || depth > 16 || path.has(value)) {
      const limit = detailLimit();
      return new AgentError(limit.code, limit.message);
    }
    path.add(value);
    try {
      const cause = value.cause ? visit(value.cause, depth + 1) : undefined;
      if (value.errors) {
        const errors: Error[] = [];
        for (const child of value.errors) {
          if (remaining <= 0) {
            const limit = detailLimit();
            errors.push(new AgentError(limit.code, limit.message));
            break;
          }
          errors.push(visit(child, depth + 1));
        }
        const aggregate = Object.assign(new AggregateError(errors, value.message, { cause }), {
          code: value.code,
        });
        return value.transactionUnconfirmed === true
          ? markStorageTransactionUnconfirmed(aggregate)
          : aggregate;
      }
      const error = new AgentError(value.code, value.message);
      if (cause) Object.defineProperty(error, 'cause', { value: cause, configurable: true });
      return value.transactionUnconfirmed === true
        ? markStorageTransactionUnconfirmed(error)
        : error;
    } finally {
      path.delete(value);
    }
  }
  return visit(input, 0);
}
