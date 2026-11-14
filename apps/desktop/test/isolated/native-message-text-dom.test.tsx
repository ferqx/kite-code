import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge } from '../../src/native-bridge';
import { NativeMessageText } from '../../src/native-message-text';

test('visible saved text silently recovers from a transient error and ignores an unselected read', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IntersectionObserver: globalThis.IntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  let updateViewport: (visible: boolean) => void = () => {};
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: class {
      constructor(callback: IntersectionObserverCallback) {
        updateViewport = (visible) =>
          callback(
            [
              {
                isIntersecting: visible,
                intersectionRect: { height: visible ? 20 : 0 },
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  });
  const { createRoot } = await import('react-dom/client');
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const text = 'Verified complete text';
  const bytes = Buffer.from(text);
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const message: Message = {
    id: 'message',
    sessionId: 'session',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    runId: null,
    content: 'Saved preview',
    deferredText: { bytes: String(bytes.length), sha256 },
  };
  const chunk = {
    kind: 'messages.text' as const,
    storeId: 'store',
    sessionId: message.sessionId,
    messageId: message.id,
    seq: message.seq,
    sha256,
    bytes: String(bytes.length),
    offset: '0',
    nextOffset: String(bytes.length),
    data: bytes.toString('base64'),
  };
  let calls = 0;
  let release: (() => void) | undefined;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request() {
      calls++;
      if (calls === 1 || calls === 3) throw Error('connection_failed');
      if (calls === 4)
        return new Promise((resolve) => {
          release = () => resolve(chunk);
        });
      return chunk;
    },
  };
  const render = (available: boolean, key = 'initial') =>
    act(async () =>
      root.render(
        <NativeMessageText
          key={key}
          bridge={bridge}
          generation={1}
          viewSelection={1}
          historyEpoch={1}
          storeId="store"
          message={message}
          available={available}
          automatic
        />,
      ),
    );
  async function until(ready: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!ready() && Date.now() < deadline)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(ready()).toBe(true);
  }

  try {
    await render(true);
    expect(calls).toBe(0);
    const preview = host.querySelector('pre')!;
    await act(async () => updateViewport(true));
    expect(calls).toBe(1);
    expect(host.textContent).toBe(message.content);
    expect(host.querySelector('[role="status"], button')).toBeNull();
    await until(() => host.textContent === text);
    expect(calls).toBe(2);
    expect(host.querySelector('pre')).toBe(preview);

    await render(true, 'reopen');
    await act(async () => updateViewport(true));
    await until(() => calls === 4);
    await render(false, 'reopen');
    await act(async () => release?.());
    expect(host.textContent).toBe(message.content);
    await act(async () => updateViewport(false));
    await render(true, 'reopen');
    expect(calls).toBe(4);
    await act(async () => updateViewport(true));
    await until(() => host.textContent === text);
    expect(calls).toBe(5);
  } finally {
    await act(async () => root.unmount());
    release?.();
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
