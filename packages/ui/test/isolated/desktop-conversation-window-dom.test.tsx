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
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const host = dom.window.document.getElementById('root')!;
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-conversation-entry-key]')];
  const rowHeight = () => 30;
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
        return isViewport(this) ? rows().length * rowHeight() : 0;
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
    const all = rows();
    const index = all.indexOf(this);
    const top =
      index >= 0
        ? index * rowHeight() - (viewport?.scrollTop ?? 0)
        : this.classList.contains('reading-column')
          ? -(viewport?.scrollTop ?? 0)
          : 0;
    const height = isViewport(this) ? 100 : index >= 0 ? rowHeight() : 0;
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
    preserveReadingAnchor: true,
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
  const viewport = () => host.querySelector<HTMLElement>('.conversation-viewport')!;
  return {
    dom,
    host,
    rows,
    render,
    viewport,
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
    async unmount() {
      await act(async () => root.render(null));
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

test('message navigation uses every input identity and preserves delivery handoff', async () => {
  const f = await fixture(140);
  const navigation = () => f.host.querySelector('nav[aria-label="会话消息导航"]');
  const markers = () => [...(navigation()?.querySelectorAll('button') ?? [])];
  const current = () => navigation()?.querySelector<HTMLButtonElement>('[aria-current="location"]');
  const click = (button: HTMLButtonElement) => act(async () => button.click());
  try {
    await f.render({ messageNavigation: true });
    expect(markers()).toHaveLength(140);
    expect(current()?.title).toContain('History #139 marker.');
    const target = markers()[110]!;
    await click(target);
    expect(current()).toBe(target);
    expect(f.row('u-110')!.getBoundingClientRect().top).toBe(12);
    expect(f.host.querySelector('.jump-latest')).toBeTruthy();
    await f.scroll(0);

    expect(markers()).toHaveLength(140);
    expect(markers()[110]).toBe(target);
    expect(current()?.title).toContain('History #0 marker.');
    await click(f.host.querySelector<HTMLButtonElement>('.jump-latest')!);
    expect(markers()).toHaveLength(140);

    const history = messages(140);
    const pending: Message = {
      id: 'local',
      presentationKey: 'send',
      role: 'user',
      text: 'History #139 marker.',
      settled: false,
      delivery: 'sending',
    };
    await f.render({
      messages: [
        ...history,
        pending,
        { ...pending, id: 'guidance', presentationKey: 'guidance', inputKind: 'input.steer' },
      ],
    });
    const outgoing = markers().at(-1)!;
    expect(markers()).toHaveLength(141);
    expect(outgoing).not.toBe(markers().at(-2));
    await f.render({
      messages: [...history, { ...pending, id: 'saved', settled: true, delivery: undefined }],
    });
    expect(markers().at(-1)).toBe(outgoing);
    expect(markers()).toHaveLength(141);
    expect(current()).toBe(outgoing);
    f.resize();
    expect(f.viewport().scrollTop).toBe(f.viewport().scrollHeight - f.viewport().clientHeight);

    await f.render({ loading: true });
    expect(navigation()).toBeNull();
    await f.render({ loading: false, messages: [] });
    expect(navigation()).toBeNull();
    await f.render({ messages: messages(1) });
    await click(markers()[0]!);
    expect(f.host.querySelector('.jump-latest')).toBeNull();
  } finally {
    await f.close();
  }
});

test('paging through overflowing message markers keeps the transcript and highlight in place', async () => {
  const f = await fixture(140);
  const earlier = () =>
    f.host.querySelector<HTMLButtonElement>('[aria-label="查看更早的消息刻度"]')!;
  const later = () => f.host.querySelector<HTMLButtonElement>('[aria-label="查看更新的消息刻度"]')!;
  try {
    await f.render({ messageNavigation: true });
    const list = f.host.querySelector<HTMLElement>('.conversation-marker-list')!;
    const markers = [...list.querySelectorAll('button')];
    let navigationHeight = 148;
    let listHeight = 120;
    let markerScroll = 0;
    Object.defineProperty(list.parentElement!, 'clientHeight', { get: () => navigationHeight });
    Object.defineProperties(list, {
      clientHeight: { get: () => listHeight },
      scrollHeight: { value: markers.length * 10 },
      scrollTop: {
        get: () => markerScroll,
        set: (value) => {
          markerScroll = Math.max(0, Math.min(value, markers.length * 10 - list.clientHeight));
        },
      },
    });
    markers.forEach((marker, index) => {
      Object.defineProperties(marker, {
        offsetTop: { value: index * 10 },
        offsetHeight: { value: 10 },
      });
    });
    await act(async () => f.resize());
    expect(list.scrollTop).toBe(1280);
    expect(later().getAttribute('aria-disabled')).toBe('true');
    const transcriptTop = f.viewport().scrollTop;
    await act(async () => earlier().click());
    expect(list.scrollTop).toBe(1160);
    expect(f.viewport().scrollTop).toBe(transcriptTop);
    expect(markers.at(-1)!.getAttribute('aria-current')).toBe('location');
    await act(async () => later().click());
    expect(list.scrollTop).toBe(1280);
    await act(async () => {
      list.scrollTop = 0;
      list.dispatchEvent(new f.dom.window.Event('scroll'));
    });
    expect(earlier().getAttribute('aria-disabled')).toBe('true');
    expect(f.viewport().scrollTop).toBe(transcriptTop);
    await act(async () => markers[1]!.click());
    expect(markers[1]!.getAttribute('aria-current')).toBe('location');
    expect(f.row('u-1')!.getBoundingClientRect().top).toBe(12);

    navigationHeight = 1505;
    listHeight = 1477;
    await act(async () => f.resize());
    expect(earlier()).toBeNull();
    expect(later()).toBeNull();
  } finally {
    await f.close();
  }
});

test('the complete timeline keeps its visible anchor through an update and a reopen', async () => {
  const f = await fixture(140);
  try {
    await f.render();
    expect(f.rows()).toHaveLength(140);
    expect(f.host.querySelector('[data-history-placeholder]')).toBeNull();
    expect(f.viewport().scrollTop).toBe(f.viewport().scrollHeight - f.viewport().clientHeight);
    await f.scroll(1507);
    const anchor = f.row('u-50')!;
    expect(anchor.getBoundingClientRect().top).toBe(-7);
    await f.render({
      messages: [
        { id: 'inserted', role: 'assistant', text: 'Earlier message', settled: true },
        ...messages(141),
      ],
    });
    expect(f.row('u-50')).toBe(anchor);
    expect(anchor.getBoundingClientRect().top).toBe(-7);
    expect(f.rows()).toHaveLength(142);
    await f.unmount();
    expect(f.saved?.anchor).toEqual({ entryKey: 'u-50', offset: -7 });
    await f.reopen();
    expect(f.rows()).toHaveLength(142);
    expect(f.row('u-50')?.getBoundingClientRect().top).toBe(-7);
    await act(async () => f.host.querySelector<HTMLButtonElement>('.jump-latest')!.click());
    expect(f.viewport().scrollTop).toBe(f.viewport().scrollHeight - f.viewport().clientHeight);
    const selected = await f.selectAll();
    expect(selected).toContain('History #0 marker.');
    expect(selected).toContain('History #140 marker.');
  } finally {
    await f.close();
  }
});
test('continuous history defers closed turn tools until expansion', async () => {
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
