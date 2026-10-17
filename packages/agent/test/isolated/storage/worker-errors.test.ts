import { expect, test } from 'bun:test';
import { AgentError } from '../../../src/storage/types';
import {
  deserializeStorageError,
  isStorageTransactionUnconfirmed,
  markStorageTransactionUnconfirmed,
  serializeStorageError,
} from '../../../src/storage/worker/error';

test('Worker errors retain original code and both business/rollback causes as structured errors', () => {
  const business = new AgentError('business_failed', 'business');
  const rollback = new AgentError('rollback_failed', 'rollback');
  const original = Object.assign(
    new AggregateError([business, rollback], 'transaction', { cause: business }),
    { code: 'storage_transaction_unconfirmed' },
  );
  const decoded = deserializeStorageError(structuredClone(serializeStorageError(original)));
  expect(decoded).toBeInstanceOf(AggregateError);
  expect(decoded).toMatchObject({
    code: 'storage_transaction_unconfirmed',
    message: 'transaction',
    cause: { code: 'business_failed' },
    errors: [{ code: 'business_failed' }, { code: 'rollback_failed' }],
  });
  expect(deserializeStorageError(serializeStorageError(business))).toMatchObject({
    code: 'business_failed',
    message: 'business',
  });
});

test('Worker error serialization and decoding bound cycles, depth and aggregate fanout', () => {
  const cycle = new Error('cycle');
  cycle.cause = cycle;
  expect(serializeStorageError(cycle).cause?.code).toBe('storage_error_detail_limit');
  let deep: Error = new Error('leaf');
  for (let index = 0; index < 1000; index++) deep = new Error('level', { cause: deep });
  expect(JSON.stringify(serializeStorageError(deep)).length).toBeLessThan(2000);
  const wide = serializeStorageError(
    new AggregateError(
      Array.from({ length: 10000 }, () => new Error('child')),
      'wide',
    ),
  );
  expect(wide.errors!.length).toBeLessThanOrEqual(64);
  expect(wide.errors!.at(-1)?.code).toBe('storage_error_detail_limit');
  const record = {
    code: 'cyclic',
    message: 'record',
    cause: undefined as unknown as ReturnType<typeof serializeStorageError>,
  };
  record.cause = record;
  expect(deserializeStorageError(record).cause).toMatchObject({
    code: 'storage_error_detail_limit',
  });
});

test('only a genuine branded transaction fact survives Worker decoding as strict-close eligibility', () => {
  const fake = Object.assign(new AgentError('storage_transaction_unconfirmed'), {
    transactionUnconfirmed: true,
  });
  expect(isStorageTransactionUnconfirmed(fake)).toBe(false);
  expect(
    isStorageTransactionUnconfirmed(deserializeStorageError(serializeStorageError(fake))),
  ).toBe(false);
  const actual = markStorageTransactionUnconfirmed(
    new AgentError('storage_transaction_unconfirmed'),
  );
  expect(
    isStorageTransactionUnconfirmed(
      deserializeStorageError(structuredClone(serializeStorageError(actual))),
    ),
  ).toBe(true);
  const otherCleanup = new AggregateError(
    [actual, new Error('external cleanup unknown')],
    'cleanup',
  );
  expect(
    isStorageTransactionUnconfirmed(deserializeStorageError(serializeStorageError(otherCleanup))),
  ).toBe(false);
});
