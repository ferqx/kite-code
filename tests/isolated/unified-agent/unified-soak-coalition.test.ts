import { expect, test } from 'bun:test';
import {
  decodeCoalitionTaskCounters,
  observeOwnedDarwinCoalitionTasks,
} from '../../../scripts/runtime/unified-soak-coalition';

const counters = (started: bigint, exited: bigint) => {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, started, true);
  view.setBigUint64(16, exited, true);
  return bytes.subarray(8);
};
test('Mach task prefix preserves both full uint64 counters and byte offsets', () => {
  expect(decodeCoalitionTaskCounters(counters(9007199254740995n, 9007199254740993n), 0)).toEqual({
    tasksStarted: '9007199254740995',
    tasksExited: '9007199254740993',
  });
  expect(decodeCoalitionTaskCounters(counters(1n, 0n), 0)).toEqual({
    tasksStarted: '1',
    tasksExited: '0',
  });
});
test('failed syscall, untouched prefix, invalid lengths or no live guardian stay unknown', () => {
  expect(() => decodeCoalitionTaskCounters(counters(1n, 0n), -1)).toThrow(
    'coalition_task_counters_unavailable',
  );
  for (const bytes of [
    new Uint8Array(16).fill(255),
    new Uint8Array(8),
    new Uint8Array(24),
    counters(0n, 0n),
    counters(5n, 5n),
    counters(5n, 6n),
  ])
    expect(() => decodeCoalitionTaskCounters(bytes, 0)).toThrow('coalition_task_counters_invalid');
});
test('invalid original coalition identity is rejected before native observation on every OS', () => {
  const identity = { pid: 0, uniqueId: '1', pidVersion: 1, coalitionId: '1' };
  expect(() => observeOwnedDarwinCoalitionTasks(identity)).toThrow(
    'coalition_task_identity_invalid',
  );
  expect(() => observeOwnedDarwinCoalitionTasks({ ...identity, pid: 2, coalitionId: '0' })).toThrow(
    'coalition_task_identity_invalid',
  );
  expect(() =>
    observeOwnedDarwinCoalitionTasks({ ...identity, pid: 2, uniqueId: '18446744073709551616' }),
  ).toThrow('coalition_task_identity_invalid');
});
