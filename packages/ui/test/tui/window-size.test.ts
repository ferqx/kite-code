import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { inkWindowStore } from '../../src/tui/ink/window-size';

class WindowSource extends EventEmitter {
  columns = 80;
  rows = 24;
}
test('many renderer leaves own exactly one resize listener and release it at the last unmount', () => {
  const source = new WindowSource();
  const existing = () => {};
  source.on('resize', existing);
  const store = inkWindowStore(source);
  expect(inkWindowStore(source)).toBe(store);
  const updates = Array.from({ length: 70 }, () => 0);
  const releases = updates.map((_, index) =>
    store.subscribe(() => {
      updates[index] = (updates[index] ?? 0) + 1;
    }),
  );
  expect(source.listenerCount('resize')).toBe(2);
  source.columns = 48;
  source.rows = 20;
  source.emit('resize');
  expect(updates.every((value) => value === 1)).toBe(true);
  expect(store.getSnapshot()).toBe('48:20');
  source.emit('resize');
  expect(updates.every((value) => value === 1)).toBe(true);
  releases.slice(0, -1).forEach((release) => {
    release();
  });
  expect(source.listenerCount('resize')).toBe(2);
  source.columns = 120;
  source.rows = 40;
  source.emit('resize');
  expect(updates.slice(0, -1).every((value) => value === 1)).toBe(true);
  expect(updates.at(-1)).toBe(2);
  releases.at(-1)!();
  releases.at(-1)!();
  expect(source.listeners('resize')).toEqual([existing]);
});
test('reopening reads dimensions changed without a mounted view and owns only its own subscriber', () => {
  const source = new WindowSource();
  const store = inkWindowStore(source);
  let count = 0;
  const update = () => count++;
  const first = store.subscribe(update),
    second = store.subscribe(update);
  first();
  source.columns = 100;
  source.emit('resize');
  expect(count).toBe(1);
  second();
  expect(source.listenerCount('resize')).toBe(0);
  source.rows = 30;
  expect(store.getSnapshot()).toBe('100:30');
  const third = store.subscribe(update);
  source.emit('resize');
  expect(count).toBe(1);
  source.columns = 101;
  source.emit('resize');
  expect(count).toBe(2);
  third();
  expect(source.listenerCount('resize')).toBe(0);
});
test('different stdout surfaces retain independent stores and absent terminal size uses original fallback', () => {
  const first = new WindowSource(),
    second = new WindowSource();
  second.columns = 0;
  second.rows = 0;
  const a = inkWindowStore(first),
    b = inkWindowStore(second);
  let count = 0;
  const release = a.subscribe(() => count++);
  second.emit('resize');
  expect(count).toBe(0);
  expect(b.getSnapshot()).toBe('80:24');
  expect(second.listenerCount('resize')).toBe(0);
  release();
});
