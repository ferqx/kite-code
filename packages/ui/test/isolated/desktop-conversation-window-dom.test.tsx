import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Conversation as ConversationType,
  ReadingState,
} from '../../src/desktop/Conversation';
import type { Message } from '../../src/desktop/types';

type Props = ComponentProps<typeof ConversationType>;
let Conversation: typeof ConversationType;
const messages = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `u-${index}`,
    role: 'user',
    text: `History #${index} marker.`,
    settled: true,
  }));

async function fixture(count = 220) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const original = new Map<string, PropertyDescriptor | undefined>();
  const frames = new Map<number, FrameRequestCallback>();
  const tasks = new Map<number, () => void>();
  let serial = 0;
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++serial;
    frames.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number) => frames.delete(id);
  const originalSchedule = dom.window.setTimeout.bind(dom.window);
  const originalCancel = dom.window.clearTimeout.bind(dom.window);
  dom.window.setTimeout = ((callback, delay, ...args) => {
    if (delay !== 0 || typeof callback !== 'function')
      return originalSchedule(callback, delay, ...args);
    const id = ++serial;
    tasks.set(id, () => callback(...args));
    return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = (id) => {
    if (id !== undefined && tasks.delete(id)) return;
    originalCancel(id);
  };
  const resizeObservers = new Set<ResizeObserverStub>();
  class ResizeObserverStub {
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe() {
      resizeObservers.add(this);
    }
    unobserve() {}
    disconnect() {
      resizeObservers.delete(this);
    }
  }
  Object.assign(dom.window, {
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const host = dom.window.document.getElementById('root')!;
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-conversation-entry-key]')];
  const isViewport = (node: HTMLElement) => node.classList.contains('conversation-viewport');
  const scrollPositions = new WeakMap<HTMLElement, number>();
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return isViewport(this) ? 100 : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return isViewport(this)
          ? rows().length * 30 + host.querySelectorAll('.conversation-history-boundary').length * 20
          : 0;
      },
    },
    scrollTop: {
      configurable: true,
      get() {
        return scrollPositions.get(this) ?? 0;
      },
      set(value: number) {
        scrollPositions.set(
          this,
          isViewport(this)
            ? Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
            : value,
        );
      },
    },
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const viewport = host.querySelector<HTMLElement>('.conversation-viewport');
    const index = rows().indexOf(this);
    const preceding = host.querySelector('.reading-column')?.firstElementChild;
    const header = preceding?.classList.contains('conversation-history-boundary') ? 20 : 0;
    const top = index >= 0 ? header + index * 30 - (viewport?.scrollTop ?? 0) : 0;
    const height = isViewport(this) ? 100 : index >= 0 ? 30 : 0;
    return {
      x: 0,
      y: top,
      top,
      bottom: top + height,
      left: 0,
      right: 800,
      width: 800,
      height,
      toJSON() {},
    };
  };
  Conversation ??= (await import('../../src/desktop/Conversation')).Conversation;
  const root = createRoot(host);
  let identity = 0;
  let saved: ReadingState | undefined;
  const props: Props = {
    messages: messages(count),
    loading: false,
    connected: true,
    selected: true,
    lazyHistory: true,
    saveReading(value) {
      saved = structuredClone(value);
    },
    renderMessageContent: (message) => <p>{message.text}</p>,
  };
  const render = (update: Partial<Props> = {}) =>
    act(async () => {
      Object.assign(props, update);
      root.render(<Conversation key={identity} {...props} />);
    });
  const frame = () =>
    act(async () => {
      const work = [...frames.values()];
      frames.clear();
      for (const callback of work) callback(performance.now());
    });
  const task = () =>
    act(async () => {
      const work = [...tasks.values()];
      tasks.clear();
      for (const callback of work) callback();
    });
  const viewport = () => host.querySelector<HTMLElement>('.conversation-viewport')!;
  return {
    dom,
    host,
    rows,
    render,
    frame,
    task,
    viewport,
    frames,
    tasks,
    resize() {
      for (const observer of resizeObservers)
        observer.callback([], observer as unknown as ResizeObserver);
    },
    get saved() {
      return saved;
    },
    row: (key: string) => rows().find((row) => row.dataset.conversationEntryKey === key),
    async scroll(top: number) {
      viewport().scrollTop = top;
      await act(async () =>
        viewport().dispatchEvent(new dom.window.Event('scroll', { bubbles: true })),
      );
    },
    async selectAll() {
      await act(async () =>
        viewport().dispatchEvent(
          new dom.window.KeyboardEvent('keydown', {
            key: 'a',
            ctrlKey: true,
            bubbles: true,
          }),
        ),
      );
      return dom.window.document.getSelection()!.toString();
    },
    async step() {
      await frame();
      await task();
    },
    async unmount() {
      await act(async () => root.render(null));
    },
    async other() {
      await act(async () => root.render(<p data-other="">Other conversation</p>));
    },
    async reopen(initialReading = saved) {
      identity++;
      await render({ initialReading });
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('native conversation applies its 100 entry threshold and initially renders the last forty whole messages', async () => {
  for (const count of [100, 101, 220]) {
    const f = await fixture(count);
    try {
      await f.render();
      expect(f.rows()).toHaveLength(count <= 100 ? count : 40);
      expect(f.rows()[0]!.dataset.conversationEntryKey).toBe(`u-${count <= 100 ? 0 : count - 40}`);
      expect(f.rows().at(-1)!.dataset.conversationEntryKey).toBe(`u-${count - 1}`);
      expect(f.host.querySelector('.conversation-loading')).toBeNull();
      expect(f.viewport().tagName).toBe('SECTION');
      expect(f.host.querySelector('[data-radix-scroll-area-viewport]')).toBeNull();
      expect(f.viewport().scrollHeight - f.viewport().clientHeight - f.viewport().scrollTop).toBe(
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test('scrolling up prepends twenty only after frame and task, preserving the previous DOM anchor and loaded selection', async () => {
  const f = await fixture();
  try {
    await f.render();
    const first = f.row('u-180')!;
    let selected = await f.selectAll();
    expect(selected).toContain('History #180 marker.');
    expect(selected).toContain('History #219 marker.');
    expect(selected).not.toContain('History #179 marker.');
    await f.scroll(0);
    const top = first.getBoundingClientRect().top;
    expect(f.rows()).toHaveLength(40);
    await f.frame();
    expect(f.rows()).toHaveLength(40);
    await f.task();
    expect(f.rows()).toHaveLength(60);
    expect(f.row('u-180') === first).toBe(true);
    expect(first.getBoundingClientRect().top).toBe(top);
    expect(f.rows()[0]!.dataset.conversationEntryKey).toBe('u-160');
    selected = await f.selectAll();
    expect(selected).toContain('History #160 marker.');
    expect(selected).not.toContain('History #159 marker.');
    expect(selected).not.toContain('History #0 marker.');
  } finally {
    await f.close();
  }
});

test('crossing one hundred live entries preserves the already loaded DOM and manual reading', async () => {
  const f = await fixture(100);
  try {
    await f.render();
    const first = f.row('u-0')!;
    const last = f.row('u-99')!;
    await f.scroll(300);
    const anchor = f.rows().find((row) => row.getBoundingClientRect().bottom > 0)!;
    const offset = anchor.getBoundingClientRect().top;
    await f.render({ messages: messages(101) });
    expect(f.rows()).toHaveLength(100);
    expect(f.row('u-0') === first).toBe(true);
    expect(f.row('u-99') === last).toBe(true);
    expect(f.row('u-100')).toBeUndefined();
    expect(f.viewport().scrollTop).toBe(300);
    expect(anchor.getBoundingClientRect().top).toBe(offset);
    expect(f.host.textContent).toContain('加载后续消息');
  } finally {
    await f.close();
  }
});

test('tail updates follow only the latest reading, retain loaded prefix and restore a manual anchor on cold reopen', async () => {
  const f = await fixture();
  try {
    await f.render();
    const first = f.row('u-180');
    await f.render({ messages: messages(221) });
    f.resize();
    expect(f.rows()).toHaveLength(41);
    expect(f.row('u-180') === first).toBe(true);
    expect(f.viewport().scrollHeight - f.viewport().clientHeight - f.viewport().scrollTop).toBe(0);
    await f.scroll(300);
    const anchor = f.rows().find((row) => row.getBoundingClientRect().bottom > 0)!;
    const key = anchor.dataset.conversationEntryKey!;
    const offset = anchor.getBoundingClientRect().top;
    await f.render({ messages: messages(222) });
    expect(f.rows()).toHaveLength(41);
    expect(f.row('u-180') === first).toBe(true);
    expect(f.viewport().scrollTop).toBe(300);
    expect(f.row('u-221')).toBeUndefined();
    expect(anchor.getBoundingClientRect().top).toBe(offset);
    await f.unmount();
    expect(f.saved?.anchor).toEqual({ entryKey: key, offset });
    await f.reopen();
    expect(f.rows().length).toBeLessThanOrEqual(40);
    expect(f.row(key)!.getBoundingClientRect().top).toBe(offset);
    const jump = f.host.querySelector<HTMLButtonElement>('.jump-latest')!;
    await act(async () => jump.click());
    expect(f.rows()).toHaveLength(40);
    expect(f.rows().at(-1)!.dataset.conversationEntryKey).toBe('u-221');
    expect(f.viewport().scrollHeight - f.viewport().clientHeight - f.viewport().scrollTop).toBe(0);
    expect(f.host.querySelector('.jump-latest')).toBeNull();
  } finally {
    await f.close();
  }
});

test('navigation cancels pending history frames and tasks, including callbacks delivered after cancellation', async () => {
  const f = await fixture();
  try {
    await f.render();
    const old = f.row('u-180')!;
    await f.scroll(0);
    const staleFrames = [...f.frames.values()];
    await f.frame();
    const staleTasks = [...f.tasks.values()];
    await f.unmount();
    await f.other();
    await act(async () => {
      for (const callback of staleFrames) callback(performance.now());
      for (const callback of staleTasks) callback();
    });
    expect(f.host.textContent).toBe('Other conversation');
    expect(f.rows()).toHaveLength(0);
    expect(f.frames.size).toBe(0);
    expect(f.tasks.size).toBe(0);
    expect(old.isConnected).toBe(false);
    await f.reopen(undefined);
    expect(f.row('u-180') === old).toBe(false);
  } finally {
    await f.close();
  }
});

test('a cold manual reading loads newer entries at its local bottom without moving the old visible anchor', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.scroll(300);
    await f.unmount();
    await f.reopen();
    expect(f.rows()).toHaveLength(40);
    expect(f.host.textContent).toContain('加载后续消息');
    const first = f.rows()[0]!;
    const oldLast = f.rows().at(-1)!;
    const oldCount = f.rows().length;
    await f.scroll(f.viewport().scrollHeight - f.viewport().clientHeight);
    const top = oldLast.getBoundingClientRect().top;
    await f.frame();
    expect(f.rows()).toHaveLength(oldCount);
    await f.task();
    expect(f.rows().length).toBeGreaterThan(oldCount);
    expect(f.rows()[0] === first).toBe(true);
    expect(f.row(oldLast.dataset.conversationEntryKey!) === oldLast).toBe(true);
    expect(oldLast.getBoundingClientRect().top).toBe(top);
    expect(f.rows().at(-1)!.dataset.conversationEntryKey).toBe('u-219');
    expect(f.host.textContent).not.toContain('加载后续消息');
    expect(f.host.querySelector('.jump-latest')).not.toBeNull();
  } finally {
    await f.close();
  }
});

test('windowing counts visible grouped entries, and closed turn tools are not projected until expansion', async () => {
  const f = await fixture();
  let toolCalls = 0;
  const history = Array.from({ length: 20 }, (_, turn) => [
    { id: `question-${turn}`, role: 'user' as const, text: `Question #${turn}`, settled: true },
    ...Array.from({ length: 30 }, (_, step) => ({
      id: `tool:${turn}-${step}`,
      role: 'tool' as const,
      turnId: `run-${turn}`,
      toolName: 'files.read',
      presentation: 'exploration' as const,
      text: `Tool step ${step}`,
      status: 'completed' as const,
      settled: true,
    })),
    {
      id: `answer-${turn}`,
      role: 'assistant' as const,
      turnId: `run-${turn}`,
      text: `Answer #${turn} complete.`,
      finalReply: true,
      settled: true,
    },
  ]).flat();
  try {
    await f.render({
      messages: history,
      renderToolActivity(group) {
        toolCalls++;
        return <div data-host-tools="">Tool records {group.length}</div>;
      },
    });
    expect(history.length).toBeGreaterThan(100);
    expect(f.rows()).toHaveLength(40);
    expect(f.rows()[0]!.dataset.conversationEntryKey).toBe('question-0');
    expect(f.host.textContent).toContain('Answer #19 complete.');
    expect(toolCalls).toBe(0);
    expect(f.host.querySelector('[data-host-tools]')).toBeNull();
    const summary = f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    await act(async () => summary.click());
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(toolCalls).toBe(1);
    expect(f.host.querySelector('[data-host-tools]')!.textContent).toBe('Tool records 30');
  } finally {
    await f.close();
  }
});
