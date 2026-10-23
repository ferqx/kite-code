import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation, type ReadingState } from '../../src/desktop/Conversation';
import type { Message } from '../../src/desktop/types';

test('native Conversation scroll follows, restores manual reading and retires RAF/observers/listeners on immediate repeated unmount', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    'HTMLElement',
  ] as const;
  const original = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  let frameId = 0,
    height = 1000;
  const frames = new Map<number, FrameRequestCallback>();
  const observers = new Set<ResizeObserverStub>();
  const keydown = new Set<EventListenerOrEventListenerObject>();
  class ResizeObserverStub {
    readonly callback: ResizeObserverCallback;
    readonly targets = new Set<Element>();
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.targets.add(target);
      observers.add(this);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
      if (!this.targets.size) observers.delete(this);
    }
  }
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number) => {
    frames.delete(id);
  };
  Object.assign(dom.window, {
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
  });
  const add = dom.window.document.addEventListener.bind(dom.window.document);
  const remove = dom.window.document.removeEventListener.bind(dom.window.document);
  dom.window.document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'keydown') keydown.add(listener);
    add(type, listener, options);
  }) as typeof dom.window.document.addEventListener;
  dom.window.document.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === 'keydown') keydown.delete(listener);
    remove(type, listener, options);
  }) as typeof dom.window.document.removeEventListener;
  for (const [key, value] of Object.entries({
    window: dom.window,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  let saved: ReadingState | undefined;
  let guidance: 'sending' | 'saved' | undefined;
  let terminal = false;
  let initialReading: ReadingState | undefined;
  const guidedMessages = (text: string): Message[] => [
    { id: 'reading-anchor', role: 'user', text: '阅读锚点：保持选区与原位', settled: true },
    {
      id: guidance === 'sending' ? 'local-guide' : 'persisted-guide',
      role: 'user',
      text: '完整引导\n第二段雪🙂',
      inputKind: 'input.steer',
      turnId: 'original-run',
      settled: guidance === 'saved',
    },
    {
      id: 'guided-reply',
      role: 'assistant',
      text,
      turnId: 'original-run',
      settled: terminal,
      finalReply: terminal,
    },
  ];
  const render = (
    id: number,
    text = 'stream text',
    initialPresentationPending = false,
    settled = false,
  ) =>
    act(async () =>
      root.render(
        <Conversation
          key={id}
          messages={
            guidance ? guidedMessages(text) : [{ id: 'message', role: 'assistant', text, settled }]
          }
          initialReading={initialReading}
          turnActivity={
            guidance && !terminal ? { turnId: 'original-run', status: 'running' } : undefined
          }
          loading={false}
          initialPresentationPending={initialPresentationPending}
          selected
          connected
          saveReading={(reading) => {
            saved = reading;
          }}
        />,
      ),
    );
  try {
    await render(0, 'unprepared history', true);
    expect(host.querySelectorAll('.message')).toHaveLength(0);
    expect(!!host.querySelector('.conversation-loading')).toBe(true);
    expect(!!host.querySelector('.welcome')).toBe(false);
    await render(0);
    let viewport = host.querySelector<HTMLDivElement>('.conversation-viewport')!;
    expect(viewport.getAttribute('role')).toBe('region');
    expect(viewport.getAttribute('aria-label')).toBe('会话消息');
    expect(viewport.getAttribute('aria-busy')).toBe('true');
    expect(viewport.querySelector('.reading-column')).not.toBeNull();
    // The transcript must not mount the third-party thumb's unowned perpetual RAF loop.
    expect(host.querySelector('[data-radix-scroll-area-viewport]')).toBeNull();
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 100 },
    });
    await render(0, 'tail 1');
    expect(viewport.scrollTop).toBe(1000);
    const message = host.querySelector('.message');
    await render(0, 'tail 1 while later metadata loads', true);
    expect(host.querySelector('.message') === message).toBe(true);
    expect(host.textContent).toContain('tail 1 while later metadata loads');
    expect(!!host.querySelector('.conversation-loading')).toBe(false);
    const column = viewport.querySelector('.reading-column')!;
    const resize = (target: Element) => {
      for (const observer of observers)
        if (observer.targets.has(target))
          observer.callback([], observer as unknown as ResizeObserver);
    };
    // Child-local body reads and collapse animations resize content without a parent commit.
    height = 1500;
    resize(column);
    expect(viewport.scrollTop).toBe(1500);
    expect(frames.size).toBe(0);
    // A queued scroll notification from the previous bottom write can arrive
    // after the next stream chunk grows the content, before its resize callback.
    height = 1800;
    await act(async () => viewport.dispatchEvent(new dom.window.Event('scroll')));
    resize(column);
    expect(viewport.scrollTop).toBe(1800);
    viewport.scrollTop = 200;
    await act(async () => viewport.dispatchEvent(new dom.window.Event('scroll')));
    height = 2000;
    resize(column);
    expect(viewport.scrollTop).toBe(200);
    await render(0, 'tail 2');
    expect(viewport.scrollTop).toBe(200);
    // Approaching the bottom while reading must not opt into following or
    // snap to the tail on the scroll-state commit / a later stream update.
    for (const gap of [47, 16, 2]) {
      const top = height - viewport.clientHeight - gap;
      viewport.scrollTop = top;
      await act(async () => viewport.dispatchEvent(new dom.window.Event('scroll')));
      expect(viewport.scrollTop).toBe(top);
      expect(host.querySelector('.jump-latest')).not.toBeNull();
      await render(0, `near-bottom gap ${gap}`);
      expect(viewport.scrollTop).toBe(top);
      height += 100;
      resize(column);
      expect(viewport.scrollTop).toBe(top);
    }
    // Native scrollTop can be fractional while scroll/clientHeight are rounded.
    viewport.scrollTop = height - viewport.clientHeight - 0.5;
    await act(async () => viewport.dispatchEvent(new dom.window.Event('scroll')));
    expect(host.querySelector('.jump-latest')).toBeNull();
    height += 100;
    resize(column);
    expect(viewport.scrollTop).toBe(height);
    height = 2000;
    viewport.scrollTop = 200;
    await act(async () => viewport.dispatchEvent(new dom.window.Event('scroll')));
    const jump = host.querySelector<HTMLButtonElement>('.jump-latest')!;
    expect(jump.getAttribute('aria-label')).toBe('回到最新消息');
    expect(jump.querySelectorAll('.jump-latest-dots > span')).toHaveLength(3);
    await render(0, 'tail 2', false, true);
    expect(host.querySelector('.jump-latest')).toBe(jump);
    expect(jump.querySelector('.jump-latest-dots')).toBeNull();
    expect(jump.querySelector('svg')).not.toBeNull();
    expect(viewport.scrollTop).toBe(200);

    guidance = 'sending';
    await render(0, '原引导尚在发送');
    const anchor = host.querySelector('article.message.user')!;
    const selection = dom.window.document.getSelection()!;
    const range = dom.window.document.createRange();
    range.selectNodeContents(anchor);
    selection.removeAllRanges();
    selection.addRange(range);
    const anchorText = selection.toString();
    expect(anchorText).toContain('阅读锚点');
    const staysAtAnchor = () => {
      expect(host.querySelector('article.message.user')).toBe(anchor);
      expect(selection.toString()).toBe(anchorText);
      expect(viewport.scrollTop).toBe(200);
      expect(host.querySelectorAll('.agent-turn')).toHaveLength(1);
    };
    guidance = 'saved';
    height = 2100;
    await render(0, '原文接管，回复开始');
    resize(column);
    staysAtAnchor();
    expect(host.textContent).toContain('完整引导');
    height = 2300;
    await render(0, '原文接管，回复增量追加，用户仍在离底阅读', true);
    resize(column);
    staysAtAnchor();
    terminal = true;
    height = 2000;
    await render(0, '唯一最终回复');
    resize(column);
    staysAtAnchor();
    const summary = host.querySelector<HTMLButtonElement>('.agent-turn-summary')!;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    await act(async () => summary.click());
    resize(column);
    staysAtAnchor();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('完整引导');
    await act(async () => root.render(null));
    expect(saved).toMatchObject({ top: 200, follow: false });
    expect(Object.values(saved!.expanded)).toContain(true);
    initialReading = saved;
    await render(0, '唯一最终回复');
    const restoredViewport = host.querySelector<HTMLDivElement>('.conversation-viewport')!;
    Object.defineProperties(restoredViewport, {
      scrollHeight: { get: () => height },
      clientHeight: { value: 100 },
    });
    expect(restoredViewport.scrollTop).toBe(200);
    expect(host.querySelector('.agent-turn-summary')!.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('完整引导');
    // Restore the original non-Turn harness for its existing cleanup/lifetime checks.
    guidance = undefined;
    terminal = false;
    initialReading = undefined;
    await render(0, 'tail 2');
    viewport = restoredViewport;

    await act(async () => host.querySelector<HTMLButtonElement>('.jump-latest')!.click());
    expect(viewport.scrollTop).toBe(2000);
    expect(host.querySelector('.jump-latest')).toBeNull();
    await act(async () => root.render(null));
    expect(saved).toMatchObject({ follow: true, top: 2000 });
    await render(1, 'another cold reading', true);
    expect(host.querySelectorAll('.message')).toHaveLength(0);
    expect(!!host.querySelector('.conversation-loading')).toBe(true);
    await act(async () => root.render(null));
    for (let index = 1; index <= 100; index++) {
      await render(index);
      const node = host.querySelector<HTMLDivElement>('.conversation-viewport')!;
      await act(async () => node.dispatchEvent(new dom.window.Event('scroll')));
      expect(frames.size).toBe(0);
      expect(observers.size).toBe(1);
      expect(keydown.size).toBe(1);
      // Follow resizes before paint without leaving a frame behind at navigation.
      resize(node);
      expect(frames.size).toBe(0);
      await act(async () => root.render(null));
      expect(frames.size).toBe(0);
      expect(observers.size).toBe(0);
      expect(keydown.size).toBe(0);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of original)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
