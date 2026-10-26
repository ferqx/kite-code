import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  CONVERSATION_WINDOW_THRESHOLD,
  captureConversationScrollAnchor,
  createConversationWindow,
  expandConversationWindow,
  jumpConversationWindowToLatest,
  resolveConversationWindow,
  restoreConversationScrollAnchor,
  scheduleConversationWindowLoad,
} from '../../src/desktop/conversation-window';

const history = (count: number) => Array.from({ length: count }, (_, index) => `entry-${index}`);

test('histories through one hundred entries stay complete and only larger cold presentations mount the latest forty', () => {
  expect(CONVERSATION_WINDOW_THRESHOLD).toBe(100);
  for (const count of [0, 1, 12, 40, 41, 100, 101, 140]) {
    const keys = history(count);
    const state = createConversationWindow(keys);
    const range = resolveConversationWindow(keys, state);
    expect(range.start).toBe(count > 100 ? count - 40 : 0);
    expect(range.end).toBe(count);
    expect(range.hasBefore).toBe(count > 100);
    expect(range.hasAfter).toBe(false);
    expect(range.state === state).toBe(true);
    expect(resolveConversationWindow([...keys], state).state === state).toBe(true);
  }
});

test('prepend reveals twenty earlier groups at a time without removing the loaded suffix', () => {
  const keys = history(140);
  let state = createConversationWindow(keys);
  for (const start of [80, 60, 40, 20, 0, 0]) {
    state = expandConversationWindow(keys, state, 'before');
    const range = resolveConversationWindow(keys, state);
    expect(range.start).toBe(start);
    expect(range.end).toBe(140);
    expect(state.firstKey).toBe(keys[start]);
    expect(state.lastKey).toBe(keys[139]);
  }
});

test('cold manual restore mounts around its anchor and expands down independently before jumping to latest', () => {
  const keys = history(140);
  let state = createConversationWindow(keys, { anchorKey: 'entry-50' });
  let range = resolveConversationWindow(keys, state);
  expect([range.start, range.end]).toEqual([40, 80]);
  expect(range.hasBefore).toBe(true);
  expect(range.hasAfter).toBe(true);
  state = expandConversationWindow(keys, state, 'after');
  range = resolveConversationWindow(keys, state);
  expect([range.start, range.end]).toEqual([40, 100]);
  state = expandConversationWindow(keys, state, 'before');
  range = resolveConversationWindow(keys, state);
  expect([range.start, range.end]).toEqual([20, 100]);
  state = jumpConversationWindowToLatest(keys);
  range = resolveConversationWindow(keys, state);
  expect([range.start, range.end]).toEqual([100, 140]);
  const tailAnchor = resolveConversationWindow(
    keys,
    createConversationWindow(keys, { anchorKey: 'entry-139' }),
  );
  expect([tailAnchor.start, tailAnchor.end]).toEqual([129, 140]);
  const headAnchor = resolveConversationWindow(
    keys,
    createConversationWindow(keys, { anchorKey: 'entry-2' }),
  );
  expect([headAnchor.start, headAnchor.end]).toEqual([0, 32]);
});

test('legacy manual positions preserve their complete mounted coordinate system once', () => {
  const keys = history(140);
  const legacy = createConversationWindow(keys, { legacyManual: true });
  expect(resolveConversationWindow(keys, legacy).start).toBe(0);
  expect(resolveConversationWindow(keys, legacy).end).toBe(140);
  const anchored = createConversationWindow(keys, {
    anchorKey: 'entry-50',
    legacyManual: true,
  });
  expect(resolveConversationWindow(keys, anchored).start).toBe(40);
  expect(resolveConversationWindow(keys, anchored).end).toBe(80);
});

test('new tail entries do not reset manual windows and following retains the loaded prefix', () => {
  const original = history(140);
  const current = history(145);
  const state = createConversationWindow(original);
  const manual = resolveConversationWindow(current, state);
  expect([manual.start, manual.end]).toEqual([100, 140]);
  expect(manual.state.firstKey).toBe('entry-100');
  expect(manual.hasAfter).toBe(true);
  const following = resolveConversationWindow(current, state, { followTail: true });
  expect([following.start, following.end]).toEqual([100, 145]);
  expect(following.state.firstKey).toBe('entry-100');
  const middle = createConversationWindow(original, { anchorKey: 'entry-40' });
  const stillMiddle = resolveConversationWindow(current, middle, { followTail: true });
  expect([stillMiddle.start, stillMiddle.end]).toEqual([30, 70]);
  expect(stillMiddle.hasAfter).toBe(true);
});

test('stable keys survive prepend and replacement arrays without relying on old indexes', () => {
  const original = history(140);
  const state = createConversationWindow(original);
  const current = ['new-older-entry', ...original];
  const range = resolveConversationWindow(current, state);
  expect([range.start, range.end]).toEqual([101, 141]);
  expect(range.state.firstKey).toBe('entry-100');
  expect(range.state.lastKey).toBe('entry-139');
  expect(range.state.order).toEqual(current);
  expect(state.order).toEqual(original);
});

test('regrouped boundaries conservatively include replacement groups and all surviving loaded identities', () => {
  const original = history(140);
  const state = createConversationWindow(original);
  const regrouped = original.map((key) => (key === 'entry-100' ? 'regrouped-first' : key));
  const range = resolveConversationWindow(regrouped, state);
  expect([range.start, range.end]).toEqual([99, 140]);
  expect(regrouped.slice(range.start, range.end)).toContain('regrouped-first');
  const middle = createConversationWindow(original, { anchorKey: 'entry-50' });
  const newLast = original.map((key) => (key === 'entry-79' ? 'regrouped-last' : key));
  const restored = resolveConversationWindow(newLast, middle);
  expect([restored.start, restored.end]).toEqual([40, 81]);
  expect(newLast.slice(restored.start, restored.end)).toContain('regrouped-last');
  const moved = ['entry-115', ...original.filter((key) => key !== 'entry-115')];
  const movedRange = resolveConversationWindow(moved, state);
  for (const key of original.slice(100))
    expect(moved.slice(movedRange.start, movedRange.end)).toContain(key);
});

test('losing every grouping identity does not silently discard the previous reading region for a tail default', () => {
  const original = history(140);
  const state = createConversationWindow(original);
  const regrouped = original.map((key) => `replacement-${key}`);
  const range = resolveConversationWindow(regrouped, state);
  expect([range.start, range.end]).toEqual([0, 140]);
});

test('the one hundred entry threshold applies to cold creation and explicit latest jumps without clipping live growth', () => {
  const hundred = history(100);
  const hundredOne = history(101);
  const state = createConversationWindow(hundred, { anchorKey: 'entry-50' });
  expect([
    resolveConversationWindow(hundred, state).start,
    resolveConversationWindow(hundred, state).end,
  ]).toEqual([0, 100]);
  const manual = resolveConversationWindow(hundredOne, state);
  expect([manual.start, manual.end]).toEqual([0, 100]);
  expect(manual.hasAfter).toBe(true);
  const following = resolveConversationWindow(hundredOne, state, { followTail: true });
  expect([following.start, following.end]).toEqual([0, 101]);
  const continued = resolveConversationWindow(history(110), following.state, { followTail: true });
  expect([continued.start, continued.end]).toEqual([0, 110]);
  const cold = resolveConversationWindow(hundredOne, createConversationWindow(hundredOne));
  expect([cold.start, cold.end]).toEqual([61, 101]);
  const anchoredCold = resolveConversationWindow(
    hundredOne,
    createConversationWindow(hundredOne, { anchorKey: 'entry-50' }),
  );
  expect([anchoredCold.start, anchoredCold.end]).toEqual([40, 80]);
  const latestSmall = resolveConversationWindow(hundred, jumpConversationWindowToLatest(hundred));
  expect([latestSmall.start, latestSmall.end]).toEqual([0, 100]);
  const latestLarge = resolveConversationWindow(
    hundredOne,
    jumpConversationWindowToLatest(hundredOne),
  );
  expect([latestLarge.start, latestLarge.end]).toEqual([61, 101]);
});

test('anchor restoration follows the visible entry itself and ignores simultaneous tail growth', () => {
  const dom = new JSDOM('<main id="viewport"></main>');
  try {
    const viewport = dom.window.document.getElementById('viewport')!;
    viewport.scrollTop = 500;
    viewport.getBoundingClientRect = () => new dom.window.DOMRect(0, 100, 400, 300);
    Object.defineProperty(viewport, 'scrollHeight', {
      get() {
        throw Error('tail_height_is_not_a_reading_anchor');
      },
    });
    let prependHeight = 0;
    const entry = (key: string, top: number, height: number) => {
      const element = dom.window.document.createElement('article');
      element.setAttribute('data-conversation-entry-key', key);
      element.getBoundingClientRect = () =>
        new dom.window.DOMRect(0, 100 + top + prependHeight - viewport.scrollTop, 400, height);
      viewport.append(element);
      return element;
    };
    entry('above', 100, 100);
    const firstVisible = entry('visible', 440, 140);
    entry('later', 650, 100);
    const anchor = captureConversationScrollAnchor(viewport)!;
    expect(anchor).toEqual({ entryKey: 'visible', offset: -60 });
    prependHeight = 80;
    expect(restoreConversationScrollAnchor(viewport, anchor)).toBe(true);
    expect(viewport.scrollTop).toBe(580);
    expect(firstVisible.getBoundingClientRect().top).toBe(40);
    // Replacing a DOM node during metadata regrouping still uses its exact entry key.
    const replacement = entry('visible', 440, 140);
    firstVisible.replaceWith(replacement);
    prependHeight = 120;
    expect(restoreConversationScrollAnchor(viewport, anchor)).toBe(true);
    expect(viewport.scrollTop).toBe(620);
    expect(replacement.getBoundingClientRect().top).toBe(40);
  } finally {
    dom.window.close();
  }
});

test('missing, hidden or invalid anchors cannot write a fabricated scroll position', () => {
  const dom = new JSDOM('<main id="viewport"></main>');
  try {
    const viewport = dom.window.document.getElementById('viewport')!;
    viewport.scrollTop = 200;
    viewport.getBoundingClientRect = () => new dom.window.DOMRect(0, 100, 400, 300);
    expect(captureConversationScrollAnchor(viewport)).toBeUndefined();
    expect(restoreConversationScrollAnchor(viewport, { entryKey: 'missing', offset: 0 })).toBe(
      false,
    );
    expect(
      restoreConversationScrollAnchor(viewport, { entryKey: 'missing', offset: Number.NaN }),
    ).toBe(false);
    expect(viewport.scrollTop).toBe(200);
    viewport.getBoundingClientRect = () => new dom.window.DOMRect(0, 100, 400, 0);
    expect(captureConversationScrollAnchor(viewport)).toBeUndefined();
    viewport.remove();
    expect(restoreConversationScrollAnchor(viewport, { entryKey: 'missing', offset: 0 })).toBe(
      false,
    );
    expect(viewport.scrollTop).toBe(200);
  } finally {
    dom.window.close();
  }
});

test('window loads wait for a frame and its next task and cancel safely at either scheduling stage', () => {
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const tasks = new Map<number, () => void>();
  const view = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = ++serial;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
    setTimeout(callback: () => void) {
      const id = ++serial;
      tasks.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      tasks.delete(id);
    },
  } as unknown as Window;
  const frame = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  const task = () => {
    const pending = [...tasks.values()];
    tasks.clear();
    for (const callback of pending) callback();
  };
  const calls: string[] = [];
  const cancelCompleted = scheduleConversationWindowLoad(view, () => calls.push('complete'));
  expect(frames.size).toBe(1);
  expect(tasks.size).toBe(0);
  frame();
  expect(calls).toEqual([]);
  expect(tasks.size).toBe(1);
  task();
  expect(calls).toEqual(['complete']);
  cancelCompleted();
  cancelCompleted();
  expect(frames.size).toBe(0);
  expect(tasks.size).toBe(0);

  const cancelFrame = scheduleConversationWindowLoad(view, () => calls.push('canceled-frame'));
  const lateFrame = [...frames.values()][0]!;
  cancelFrame();
  cancelFrame();
  lateFrame(0);
  expect(frames.size).toBe(0);
  expect(tasks.size).toBe(0);

  const cancelTask = scheduleConversationWindowLoad(view, () => calls.push('canceled-task'));
  frame();
  const lateTask = [...tasks.values()][0]!;
  cancelTask();
  cancelTask();
  lateTask();
  frame();
  task();
  expect(calls).toEqual(['complete']);
  expect(frames.size).toBe(0);
  expect(tasks.size).toBe(0);
});
