import { expect, test } from 'bun:test';
import { parseCLIArguments } from '../src/arguments';

test('offline maintenance arguments require explicit profile, selected backup, observed identities and data-loss flag', () => {
  const scope = ['--data-root', '/explicit/data', '--profile', 'selected'];
  expect(
    parseCLIArguments(['maintenance', 'backup', ...scope, '--destination', '/explicit/backups']),
  ).toEqual({
    kind: 'maintenance',
    action: 'backup',
    dataRoot: '/explicit/data',
    profile: 'selected',
    destinationRoot: '/explicit/backups',
  });
  expect(parseCLIArguments(['maintenance', 'inspect', '/explicit/backup'])).toEqual({
    kind: 'maintenance',
    action: 'inspect',
    directory: '/explicit/backup',
  });
  expect(parseCLIArguments(['maintenance', 'status', ...scope])).toEqual({
    kind: 'maintenance',
    action: 'status',
    dataRoot: '/explicit/data',
    profile: 'selected',
  });
  expect(
    parseCLIArguments([
      'maintenance',
      'restore',
      '/explicit/backup',
      ...scope,
      '--expected-store',
      'original-store',
      '--confirm-data-loss',
    ]),
  ).toMatchObject({ action: 'restore', expectedStoreId: 'original-store', confirmDataLoss: true });
  expect(
    parseCLIArguments([
      'maintenance',
      'reconcile',
      ...scope,
      '--restore-id',
      '01234567-1234-1234-1234-012345678901',
      '--journal-digest',
      'a'.repeat(64),
      '--decision',
      'rollback',
      '--confirm-data-loss',
    ]),
  ).toMatchObject({ action: 'reconcile', decision: 'rollback', confirmDataLoss: true });
  for (const args of [
    ['maintenance', 'backup'],
    ['maintenance', 'backup', ...scope, '--destination', 'relative'],
    ['maintenance', 'status', '--data-root', 'relative', '--profile', 'selected'],
    ['maintenance', 'status', ...scope, '--profile', 'other'],
    ['maintenance', 'inspect', 'relative'],
    ['maintenance', 'inspect', '/backup', ...scope],
    ['maintenance', 'restore', '/backup', ...scope, '--expected-store', 'old'],
    ['maintenance', 'restore', '/backup', ...scope, '--confirm-data-loss'],
    [
      'maintenance',
      'reconcile',
      ...scope,
      '--restore-id',
      '01234567-1234-1234-1234-012345678901',
      '--journal-digest',
      'a'.repeat(64),
      '--decision',
      'auto',
      '--confirm-data-loss',
    ],
    ['maintenance', 'status', ...scope, '--server', '/socket'],
    ['maintenance', 'backup', ...scope, '--destination'],
    ['maintenance', 'status', ...scope, '--unknown'],
  ])
    expect(() => parseCLIArguments(args)).toThrow();
  expect(parseCLIArguments(['maintenance', '--help'])).toEqual({
    kind: 'help',
    command: 'maintenance',
  });
});
