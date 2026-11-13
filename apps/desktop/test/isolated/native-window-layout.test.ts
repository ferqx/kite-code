import { expect, test } from '#kite-test';
import {
  cancelNativeWindowLayout,
  queueNativeWindowLayout,
} from '../../electron/native-window-layout';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('sibling layout tasks coalesce after the native callback and use the latest bounds', async () => {
  const window = { isDestroyed: () => false, width: 1000 };
  const observed: string[] = [];
  const root = () => observed.push(`root:${window.width}`);
  const page = () => observed.push(`page:${window.width}`);
  queueNativeWindowLayout(window, root);
  queueNativeWindowLayout(window, page);
  window.width = 820;
  queueNativeWindowLayout(window, root);
  queueNativeWindowLayout(window, page);
  expect(observed).toEqual([]);
  await nextTurn();
  expect(observed).toEqual(['root:820', 'page:820']);
});

test('cancellation and window destruction cannot revive a queued surface', async () => {
  let destroyed = false;
  const window = { isDestroyed: () => destroyed };
  const observed: string[] = [];
  const root = () => observed.push('root');
  const page = () => observed.push('page');
  queueNativeWindowLayout(window, root);
  queueNativeWindowLayout(window, page);
  cancelNativeWindowLayout(window, root);
  await nextTurn();
  expect(observed).toEqual(['page']);
  queueNativeWindowLayout(window, root);
  cancelNativeWindowLayout(window, root);
  await nextTurn();
  expect(observed).toEqual(['page']);
  queueNativeWindowLayout(window, page);
  destroyed = true;
  await nextTurn();
  expect(observed).toEqual(['page']);
});

test('a task queued while a batch runs belongs to a new native layout turn', async () => {
  const window = { isDestroyed: () => false };
  const observed: number[] = [];
  queueNativeWindowLayout(window, () => {
    observed.push(1);
    queueNativeWindowLayout(window, () => observed.push(2));
  });
  await nextTurn();
  expect(observed).toEqual([1]);
  await nextTurn();
  expect(observed).toEqual([1, 2]);
});
