import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { View } from 'electron';
import { nativeContentBounds, watchNativeContentWindow } from '../electron/native-content-layout';
import type { NativeRootWindow } from '../electron/native-root-window';

test('shared content projection scales CSS bounds inward and clips to native viewport', () => {
  expect(
    nativeContentBounds({ x: 10.2, y: 20.2, width: 100.8, height: 80.8 }, 1.5, 140, 120),
  ).toEqual({ x: 16, y: 31, width: 124, height: 89 });
  expect(nativeContentBounds({ x: 200, y: 0, width: 10, height: 10 }, 1, 100, 100)).toBeUndefined();
  expect(nativeContentBounds({ x: 0, y: 0, width: 0, height: 10 }, 1, 100, 100)).toBeUndefined();
  expect(nativeContentBounds({ x: NaN, y: 0, width: 10, height: 10 }, 1, 100, 100)).toBeUndefined();
});
test('shared window lifetime subscribes and retires resize zoom root and visibility callbacks', () => {
  const owner = new EventEmitter(),
    root = new EventEmitter(),
    window = Object.assign(new EventEmitter(), { webContents: owner });
  const events: string[] = [];
  const stop = watchNativeContentWindow(
    window as unknown as NativeRootWindow,
    root as unknown as View,
    {
      resize: () => events.push('resize'),
      hide: () => events.push('hide'),
      minimize: () => events.push('minimize'),
      show: () => events.push('show'),
      restore: () => events.push('restore'),
    },
  );
  window.emit('resize');
  root.emit('bounds-changed');
  owner.emit('zoom-changed');
  for (const e of ['hide', 'minimize', 'show', 'restore']) window.emit(e);
  expect(events).toEqual(['resize', 'resize', 'resize', 'hide', 'minimize', 'show', 'restore']);
  stop();
  stop();
  window.emit('resize');
  root.emit('bounds-changed');
  owner.emit('zoom-changed');
  window.emit('show');
  expect(events).toHaveLength(7);
});
