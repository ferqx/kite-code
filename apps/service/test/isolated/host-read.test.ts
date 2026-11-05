import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { readHostState } from '../../src/host-read';

test('fresh native checks run one per event-loop turn, without sharing observations', async () => {
  const root = temporaryDirectory('kite-host-read-'),
    path = join(root, 'authority');
  try {
    writeFileSync(path, 'before');
    const order: string[] = [];
    const first = readHostState(() => {
      order.push('first');
      return readFileSync(path, 'utf8');
    });
    const second = readHostState(() => {
      order.push('second');
      return readFileSync(path, 'utf8');
    });
    const pulse = turn().then(() => order.push('event-loop'));
    expect(await first).toBe('before');
    writeFileSync(path, 'after');
    expect(await second).toBe('after');
    await pulse;
    expect(order).toEqual(['first', 'event-loop', 'second']);
  } finally {
    removeTemporaryDirectory(root);
  }
});

test('queued cancellation performs zero native reads and failures do not stall later checks', async () => {
  const controller = new AbortController(),
    reason = Error('cancel-original');
  let reads = 0;
  const queued = readHostState(() => reads++, controller.signal);
  controller.abort(reason);
  await expect(queued).rejects.toBe(reason);
  expect(reads).toBe(0);
  const failure = Error('native-check-failed');
  await expect(
    readHostState(() => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await readHostState(() => ++reads)).toBe(1);
  const during = new AbortController();
  await expect(
    readHostState(() => {
      during.abort(reason);
      return ++reads;
    }, during.signal),
  ).rejects.toBe(reason);
  expect(reads).toBe(2);
});
