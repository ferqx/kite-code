import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation, type ReadingState } from '../../src/desktop/Conversation';

test('native Conversation scroll follows, restores manual reading and retires RAF/observers/listeners on immediate repeated unmount', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'IS_REACT_ACT_ENVIRONMENT',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
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
  const render = (id: number, text = 'stream text') =>
    act(async () =>
      root.render(
        <Conversation
          key={id}
          messages={[{ id: 'message', role: 'assistant', text, settled: false }]}
          loading={false}
          selected
          connected
          saveReading={(reading) => {
            saved = reading;
          }}
        />,
      ),
    );
  try {
    await render(0);
    const viewport = host.querySelector<HTMLDivElement>('.conversation-viewport')!;
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
    await act(async () => host.querySelector<HTMLButtonElement>('.jump-latest')!.click());
    expect(viewport.scrollTop).toBe(2000);
    await act(async () => root.render(null));
    expect(saved).toMatchObject({ follow: true, top: 2000 });
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
