import { expect, test } from 'bun:test';
import { afterNativePresentation } from '../src/native-presentation-frame';

function fixture({ hidden = false, frames = true } = {}) {
  const originals = new Map(
    ['setTimeout', 'clearTimeout'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  let nextTask = 0;
  let nextFrame = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  const document = { hidden };
  // This fixture supplies only the Window surface used by the presentation wait.
  const view = {
    document,
    requestAnimationFrame: frames
      ? (callback: FrameRequestCallback) => {
          const id = ++nextFrame;
          callbacks.set(id, callback);
          return id;
        }
      : undefined,
    cancelAnimationFrame(id: number) {
      cancelled.push(id);
      callbacks.delete(id);
    },
  } as unknown as Window;
  Object.defineProperties(globalThis, {
    setTimeout: {
      configurable: true,
      writable: true,
      value(callback: () => void, delay = 0) {
        const id = ++nextTask;
        tasks.set(id, { callback, delay });
        return id;
      },
    },
    clearTimeout: {
      configurable: true,
      writable: true,
      value(id: number) {
        tasks.delete(id);
      },
    },
  });
  return {
    view,
    document,
    tasks,
    callbacks,
    cancelled,
    frame() {
      const entry = callbacks.entries().next().value;
      expect(entry).toBeDefined();
      const [id, callback] = entry!;
      callbacks.delete(id);
      callback(16);
    },
    task(delay: number) {
      const entry = [...tasks].find(([, task]) => task.delay === delay);
      expect(entry).toBeDefined();
      const [id, task] = entry!;
      tasks.delete(id);
      task.callback();
    },
    restore() {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('presentation waits until the task following RAF rather than resolving inside the frame callback', async () => {
  const f = fixture();
  try {
    let resolved = false;
    const pending = afterNativePresentation(f.view).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(f.callbacks.size).toBe(1);
    f.frame();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(f.callbacks.size).toBe(0);
    expect([...f.tasks.values()].map((task) => task.delay).sort((a, b) => a - b)).toEqual([0, 100]);
    f.task(0);
    await pending;
    expect(resolved).toBe(true);
    expect(f.tasks.size).toBe(0);
    expect(f.cancelled).toEqual([]);
  } finally {
    f.restore();
  }
});

for (const options of [{ hidden: true }, { frames: false }]) {
  test(`presentation returns without scheduling when ${options.hidden ? 'the window is hidden' : 'RAF is unavailable'}`, async () => {
    const f = fixture(options);
    try {
      await afterNativePresentation(f.view);
      expect(f.callbacks.size).toBe(0);
      expect(f.tasks.size).toBe(0);
      expect(f.cancelled).toEqual([]);
    } finally {
      f.restore();
    }
  });
}

test('the deadline releases a window hidden after admission and cancels its paused RAF', async () => {
  const f = fixture();
  try {
    const pending = afterNativePresentation(f.view);
    const frame = f.callbacks.keys().next().value!;
    f.document.hidden = true;
    f.task(100);
    await pending;
    expect(f.cancelled).toEqual([frame]);
    expect(f.callbacks.size).toBe(0);
    expect(f.tasks.size).toBe(0);
  } finally {
    f.restore();
  }
});

test('the deadline also retires a queued post-frame task without leaving a second completion', async () => {
  const f = fixture();
  try {
    let completions = 0;
    const pending = afterNativePresentation(f.view).then(() => {
      completions++;
    });
    f.frame();
    f.task(100);
    await pending;
    expect(completions).toBe(1);
    expect(f.tasks.size).toBe(0);
    expect(f.callbacks.size).toBe(0);
    expect(f.cancelled).toEqual([]);
  } finally {
    f.restore();
  }
});
