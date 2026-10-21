import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationCache } from '../../../../packages/ui/src/desktop/ConversationCache';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';
import { NativeImagePreviews } from '../../src/native-image-previews';
import { NativeUserImages } from '../../src/native-user-images';
import { installImagePreviewWorker } from '../image-preview-worker.fixture';

const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VQAAAABJRU5ErkJggg==';
const bytes = Buffer.from(data, 'base64');
const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

function fixture() {
  const restoreWorker = installImagePreviewWorker();
  const previews = new NativeImagePreviews();
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const old = globals.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const observers = new Set<Observer>();
  class Observer {
    readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe() {
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  }
  Object.assign(dom.window, { IntersectionObserver: Observer });
  const urls: string[] = [],
    revoked: string[] = [];
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {
    const url = `blob:preview-${urls.length}`;
    urls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  let hidden = false,
    corrupt = false,
    peak = 0;
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  const calls: NativeRequest[] = [],
    pending: (() => void)[] = [];
  const active = new Set<string>();
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest): Promise<NativeResult> {
      calls.push(request);
      if (request.method === 'input.image.open') {
        active.add(request.readId);
        peak = Math.max(peak, active.size);
        const expectedHash = corrupt ? 'c'.repeat(64) : hash;
        return new Promise((resolve) =>
          pending.push(() =>
            resolve({
              kind: 'input.image.open',
              readId: request.readId,
              size: bytes.length,
              mediaType: 'image/png',
              hash: expectedHash,
            }),
          ),
        );
      }
      if (request.method === 'input.image.read')
        return {
          kind: 'input.image.chunk',
          readId: request.readId,
          offset: 0,
          nextOffset: bytes.length,
          data,
          done: true,
        };
      if (request.method === 'input.image.close') active.delete(request.readId);
      return null;
    },
  } as NativeBridge;
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const until = async (ready: () => boolean) => {
    for (let index = 0; index < 80 && !ready(); index++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    expect(ready()).toBe(true);
  };
  return {
    host,
    calls,
    urls,
    revoked,
    until,
    peak: () => peak,
    corrupt: (value: boolean) => {
      corrupt = value;
    },
    async render(count = 1, available = true, viewSelection = 1, cacheIdentity?: string) {
      const sessionId = cacheIdentity ?? 'session-' + viewSelection;
      const content = (
        <div className="conversation-viewport">
          {Array.from({ length: count }, (_, index) => (
            <NativeUserImages
              key={index}
              bridge={bridge}
              previews={previews}
              generation={1}
              viewSelection={viewSelection}
              historyEpoch={0}
              readAvailable={available}
              message={
                {
                  id: `message-${index}`,
                  role: 'user',
                  status: 'complete',
                  sessionId,
                  seq: '1',
                  content: '',
                  images: [
                    {
                      name: `${index}.png`,
                      reference: {
                        id: `image-${index}`,
                        storeId: 'store',
                        sessionId,
                        subjectId: 'owner',
                        scope: { kind: 'session', id: sessionId },
                        hash,
                        size: String(bytes.length),
                        mediaType: 'image/png',
                      },
                    },
                  ],
                } as Message
              }
            />
          ))}
        </div>
      );
      await act(async () =>
        root.render(
          cacheIdentity ? (
            <ConversationCache
              identity={cacheIdentity}
              loading={!available}
              visible
              cache={{ scope: 'window', revision: '0', readActive: available }}
            >
              {content}
            </ConversationCache>
          ) : (
            content
          ),
        ),
      );
    },
    intersect: (visible: boolean) =>
      act(async () => {
        for (const observer of observers)
          observer.callback(
            [{ isIntersecting: visible } as IntersectionObserverEntry],
            observer as unknown as IntersectionObserver,
          );
      }),
    release: () =>
      act(async () => {
        pending.shift()?.();
      }),
    visibility: (value: boolean) =>
      act(async () => {
        hidden = !value;
        dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      }),
    async close() {
      await act(async () => root.unmount());
      previews.clear();
      await act(async () => {
        for (const resolve of pending.splice(0)) resolve();
      });
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
      dom.window.close();
      restoreWorker();
      for (const [key, descriptor] of old)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('visible history images share one read queue, retain verified previews during calibration and release out-of-view and hidden resources', async () => {
  const f = fixture();
  try {
    await f.render(6);
    expect(f.calls).toHaveLength(0);
    await f.intersect(true);
    expect(f.calls.filter((request) => request.method === 'input.image.open')).toHaveLength(1);
    for (let index = 0; index < 6; index++) {
      await f.until(
        () =>
          f.calls.filter((request) => request.method === 'input.image.open').length === index + 1,
      );
      await f.release();
      await f.until(() => f.host.querySelectorAll('img').length === index + 1);
    }
    expect(f.peak()).toBe(1);
    const image = f.host.querySelector('img');
    await f.render(6, false);
    await f.render(6, true);
    expect(f.host.querySelector('img')).toBe(image);
    expect(f.urls).toHaveLength(6);
    expect(f.revoked).toHaveLength(0);
    await f.intersect(false);
    expect(f.host.querySelectorAll('img')).toHaveLength(0);
    expect(f.revoked).toEqual(f.urls);
    await f.intersect(true);
    await f.until(
      () => f.calls.filter((request) => request.method === 'input.image.open').length === 7,
    );
    await f.release();
    await f.until(() => f.host.querySelectorAll('img').length === 1);
    await f.visibility(false);
    expect(f.host.querySelectorAll('img')).toHaveLength(0);
    expect(f.revoked).toEqual(f.urls);
  } finally {
    await f.close();
  }
});

test('leaving a session cancels the active image lease and queued thumbnails never read or publish late URLs', async () => {
  const f = fixture();
  try {
    await f.render(6);
    await f.intersect(true);
    expect(f.calls.filter((request) => request.method === 'input.image.open')).toHaveLength(1);
    await f.render(1, true, 2);
    await f.intersect(true);
    await f.release();
    await f.until(
      () => f.calls.filter((request) => request.method === 'input.image.open').length === 2,
    );
    expect(f.urls).toHaveLength(0);
    const opened = f.calls.filter((request) => request.method === 'input.image.open');
    expect(opened.map((request) => request.viewSelection)).toEqual([1, 2]);
    await f.release();
    await f.until(() => f.host.querySelectorAll('img').length === 1);
    expect(f.urls).toHaveLength(1);
    expect(f.peak()).toBe(1);
  } finally {
    await f.close();
  }
});

test('image metadata failures provide a retry without repeated reads and do not create an unverified preview', async () => {
  const f = fixture();
  try {
    f.corrupt(true);
    await f.render();
    await f.intersect(true);
    await f.release();
    await f.until(() => !!f.host.querySelector('button'));
    expect(f.host.textContent).toContain('预览失败，重试');
    expect(f.urls).toHaveLength(0);
    await f.render();
    expect(f.calls.filter((request) => request.method === 'input.image.open')).toHaveLength(1);
    f.corrupt(false);
    await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
    await f.release();
    await f.until(() => !!f.host.querySelector('img'));
    expect(f.urls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('cached image identity survives a new read selection without reopening and cached eviction releases its URL', async () => {
  const f = fixture();
  try {
    await f.render(1, true, 1, 'a');
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelectorAll('img').length === 1);
    const image = f.host.querySelector('img')!;
    const url = image.getAttribute('src');
    await f.render(1, false, 2, 'b');
    expect(image.isConnected).toBe(false);
    expect(f.revoked).toHaveLength(0);
    await f.render(1, false, 3, 'a');
    expect(f.host.querySelector('img') === image).toBe(true);
    expect(image.getAttribute('src')).toBe(url);
    expect(f.calls.filter((r) => r.method === 'input.image.open')).toHaveLength(1);
    await f.render(1, true, 3, 'a');
    expect(f.host.querySelector('img') === image).toBe(true);
    expect(f.urls).toHaveLength(1);
    for (const [index, id] of ['b', 'c', 'd', 'e'].entries())
      await f.render(1, true, index + 4, id);
    expect(f.revoked).toEqual([url!]);
  } finally {
    await f.close();
  }
});

test('removing an active image and hiding the window release media even for paused cached trees', async () => {
  const f = fixture();
  try {
    await f.render(1, true, 1, 'a');
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelectorAll('img').length === 1);
    await f.render(0, true, 1, 'a');
    expect(f.revoked).toEqual(f.urls);
    await f.render(1, true, 1, 'a');
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelectorAll('img').length === 1);
    await f.render(1, true, 2, 'b');
    await f.visibility(false);
    expect(f.revoked).toEqual(f.urls);
    await f.render(1, false, 3, 'a');
    expect(f.host.querySelectorAll('img')).toHaveLength(0);
    const before = f.calls.filter((r) => r.method === 'input.image.open').length;
    await f.visibility(true);
    expect(f.calls.filter((r) => r.method === 'input.image.open').length).toBe(before);
  } finally {
    await f.close();
  }
});

test('pausing a still mounted image read aborts its lease and ignores late bytes before a fresh selection reads', async () => {
  const f = fixture();
  try {
    await f.render(1, true, 1, 'a');
    await f.intersect(true);
    const opened = f.calls.find((r) => r.method === 'input.image.open')!;
    await f.render(1, false, 1, 'a');
    expect(
      f.calls.some(
        (r) => r.method === 'input.image.close' && 'readId' in opened && r.readId === opened.readId,
      ),
    ).toBe(true);
    await f.release();
    expect(f.urls).toHaveLength(0);
    await f.render(1, true, 2, 'a');
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 2);
    await f.release();
    await f.until(() => f.host.querySelectorAll('img').length === 1);
    expect(f.urls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
