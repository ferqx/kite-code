import { expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { projectHistory } from '../src/history-projection';
import { projectEventWithIdentity } from '../src/presentation';

const event = (index: number): RuntimeClientEvent => ({
  type: 'user.message',
  messageId: String(index),
  text: `message ${index}`,
  kind: 'task',
});
const record = (index: number) => ({
  sequence: index,
  events: [event(index)],
  identity: { turnId: `turn-${index}` },
});

test('unchanged calibration preserves array and changed calibration reuses identical messages', async () => {
  const signal = new AbortController().signal;
  const records = [record(1), record(2)];
  const original = records.reduce(
    (messages, item) => projectEventWithIdentity(messages, item.events[0]!, item.identity),
    [] as Parameters<typeof projectEventWithIdentity>[0],
  );
  expect(await projectHistory(records, original, signal)).toBe(original);
  const changed = await projectHistory([...records, record(3)], original, signal);
  expect(changed).toHaveLength(3);
  expect(changed[0]).toBe(original[0]);
  expect(changed[1]).toBe(original[1]);
  expect(await projectHistory([], [], signal)).toEqual([]);
});

test('large historical projection yields and superseding it stops before publication', async () => {
  const controller = new AbortController();
  let heartbeat = false;
  const timer = setTimeout(() => {
    heartbeat = true;
    controller.abort();
  }, 0);
  await expect(
    projectHistory(
      Array.from({ length: 5000 }, (_, index) => record(index)),
      [],
      controller.signal,
    ),
  ).rejects.toThrow();
  clearTimeout(timer);
  expect(heartbeat).toBe(true);
});
