import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationCache } from '../../../../packages/ui/src/desktop/ConversationCache';
import { ConversationCacheCost } from '../../../../packages/ui/src/desktop/conversation-cache-cost';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';
import type {
  NativeImageGalleryPresentation as GalleryState,
  NativeImageGalleryAction,
} from '../../src/native-image-gallery-bridge';
import { NativeImagePreviews } from '../../src/native-image-previews';
import { installImagePreviewWorker } from '../image-preview-worker.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VQAAAABJRU5ErkJggg==';
const bytes = Buffer.from(data, 'base64');
const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

async function fixture(nativeHost = false) {
  const costs = new Set<ConversationCacheCost>();
  const startCost = ConversationCacheCost.prototype.start;
  const stopCost = ConversationCacheCost.prototype.stop;
  ConversationCacheCost.prototype.start = function (...args) {
    costs.add(this);
    return startCost.apply(this, args);
  };
  ConversationCacheCost.prototype.stop = function (...args) {
    costs.delete(this);
    return stopCost.apply(this, args);
  };
  const restoreWorker = installImagePreviewWorker();
  const previews = new NativeImagePreviews();
  const originalRecords: {
    scope: Parameters<NativeImagePreviews['rememberOriginal']>[0];
    identity: Parameters<NativeImagePreviews['rememberOriginal']>[1];
    blob: Blob;
    accepted: boolean;
  }[] = [];
  const remember = previews.rememberOriginal.bind(previews);
  previews.rememberOriginal = (scope, identity, blob) => {
    const accepted = remember(scope, identity, blob);
    originalRecords.push({ scope, identity, blob, accepted });
    return accepted;
  };
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const restoreLayout = prepareDesktopDom(dom);
  const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const old = globals.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { NativeUserImages } = await import('../../src/native-user-images');
  const { NativeImageGalleryProvider } = await import('../../src/native-image-gallery');
  const nativeStates: GalleryState[] = [];
  const nativeClosed: string[] = [];
  const nativeListeners = new Set<(action: NativeImageGalleryAction) => void>();
  if (nativeHost)
    Object.assign(dom.window, {
      kiteNativeImageGallery: {
        present: (state: GalleryState) => nativeStates.push(state),
        close: (sessionId: string) => nativeClosed.push(sessionId),
        watchActions: (listener: (action: NativeImageGalleryAction) => void) => {
          nativeListeners.add(listener);
          return () => nativeListeners.delete(listener);
        },
      },
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
  const blobs: Blob[] = [];
  const urls: string[] = [],
    revoked: string[] = [];
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    blobs.push(blob as Blob);
    const url = `blob:preview-${urls.length}`;
    urls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  let hidden = false,
    corrupt = false,
    deny = false,
    denialCode: string | undefined,
    closeDenialCode: string | undefined,
    holdClose = false,
    peak = 0;
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  Object.defineProperty(dom.window.document, 'visibilityState', {
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  const calls: NativeRequest[] = [],
    pending: (() => void)[] = [];
  const active = new Set<string>();
  const pendingCloses: (() => void)[] = [];
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest): Promise<NativeResult> {
      calls.push(request);
      if (
        request.method === 'input.image.open' ||
        request.method === 'background.child.image.open'
      ) {
        if (denialCode) throw Object.assign(Error(denialCode), { code: denialCode });
        if (deny) throw Error('input_image_permission_denied');
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
      if (request.method === 'input.image.read' || request.method === 'background.child.image.read')
        return {
          kind: 'input.image.chunk',
          readId: request.readId,
          offset: 0,
          nextOffset: bytes.length,
          data,
          done: true,
        };
      if (
        request.method === 'input.image.close' ||
        request.method === 'background.child.image.close'
      ) {
        active.delete(request.readId);
        if (holdClose) await new Promise<void>((resolve) => pendingCloses.push(resolve));
        if (closeDenialCode) throw Object.assign(Error(closeDenialCode), { code: closeDenialCode });
      }
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
    originalRecords,
    cached: (record: (typeof originalRecords)[number]) =>
      previews.getOriginal(record.scope, record.identity),
    denyCloseCode: (code: string | undefined) => {
      closeDenialCode = code;
    },
    denyCode: (code: string | undefined) => {
      denialCode = code;
    },
    deny: (value: boolean) => {
      deny = value;
    },
    holdCloses: (value: boolean) => {
      holdClose = value;
    },
    pendingCloses: () => pendingCloses.length,
    releaseCloses: () =>
      act(async () => {
        for (const resolve of pendingCloses.splice(0)) resolve();
      }),
    document: dom.window.document,
    blobs,
    nativeStates,
    nativeClosed,
    nativeAction: (action: NativeImageGalleryAction) =>
      act(async () => {
        for (const listener of nativeListeners) listener(action);
      }),
    calls,
    urls,
    revoked,
    until,
    measured: () => until(() => costs.size > 0 && [...costs].every((cost) => !!cost.snapshot())),
    peak: () => peak,
    corrupt: (value: boolean) => {
      corrupt = value;
    },
    async render(
      count = 1,
      available = true,
      viewSelection = 1,
      cacheIdentity?: string,
      options: {
        imageCount?: number;
        tool?: boolean;
        childHandle?: string;
        historyEpoch?: number;
        sourceRevision?: string;
      } = {},
    ) {
      const sessionId = cacheIdentity ?? `session-${viewSelection}`;
      const content = (
        <div className="conversation-viewport">
          {Array.from({ length: count }, (_, index) => (
            <NativeUserImages
              key={index}
              bridge={bridge}
              previews={previews}
              generation={1}
              viewSelection={viewSelection}
              historyEpoch={options.historyEpoch ?? 0}
              childHandle={options.childHandle}
              readAvailable={available}
              images={
                options.tool
                  ? Array.from({ length: options.imageCount ?? 1 }, (_, imageIndex) => ({
                      name: `tool-${imageIndex}.png`,
                      reference: { hash, size: String(bytes.length), mediaType: 'image/png' },
                    }))
                  : undefined
              }
              message={
                {
                  id: `message-${index}`,
                  role: 'user',
                  status: 'complete',
                  sessionId,
                  seq: '1',
                  content: '',
                  images: Array.from({ length: options.imageCount ?? 1 }, (_, imageIndex) => ({
                    name: `${index}-${imageIndex}.png`,
                    reference: {
                      id: `image-${index}${options.sourceRevision ?? ''}`,
                      storeId: 'store',
                      sessionId,
                      subjectId: 'owner',
                      scope: { kind: 'session', id: sessionId },
                      hash,
                      size: String(bytes.length),
                      mediaType: 'image/png',
                    },
                  })),
                } as Message
              }
            />
          ))}
        </div>
      );
      await act(async () =>
        root.render(
          <NativeImageGalleryProvider>
            {cacheIdentity ? (
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
            )}
          </NativeImageGalleryProvider>,
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
      holdClose = false;
      for (const resolve of pendingCloses.splice(0)) resolve();
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      previews.clear();
      await act(async () => {
        for (const resolve of pending.splice(0)) resolve();
      });
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
      dom.window.close();
      restoreWorker();
      restoreLayout();
      ConversationCacheCost.prototype.start = startCost;
      ConversationCacheCost.prototype.stop = stopCost;
      for (const [key, descriptor] of old)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('visible history images share one read queue, retain verified previews during calibration and release out-of-view and hidden resources', async () => {
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
  try {
    await f.render(1, true, 1, 'a');
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelectorAll('img').length === 1);
    const image = f.host.querySelector('img')!;
    const url = image.getAttribute('src');
    await f.measured();
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
    for (const [index, id] of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].entries()) {
      await f.render(1, true, index + 4, id);
      await f.measured();
    }
    expect(f.revoked).toEqual([url!]);
  } finally {
    await f.close();
  }
});

test('removing an active image and hiding the window release media even for paused cached trees', async () => {
  const f = await fixture();
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
  const f = await fixture();
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

test('closing tool clipping retains verified pixels only until exit unmount and never restarts reads', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelector('img') !== null);
    const body = f.host.querySelector('.conversation-viewport')!;
    body.classList.add('tool-activity-content');
    body.setAttribute('data-state', 'closed');
    const calls = f.calls.length;
    await f.intersect(false);
    expect(f.host.querySelector('img')).not.toBeNull();
    expect(f.revoked).toHaveLength(0);
    expect(f.calls).toHaveLength(calls);
    await f.render(0);
    expect(f.host.querySelector('img')).toBeNull();
    expect(f.revoked).toEqual(f.urls);
  } finally {
    await f.close();
  }
});

test('window hiding still releases a thumbnail retained during tool exit', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelector('img') !== null);
    const body = f.host.querySelector('.conversation-viewport')!;
    body.classList.add('tool-activity-content');
    body.setAttribute('data-state', 'closed');
    await f.intersect(false);
    await f.visibility(false);
    expect(f.host.querySelector('img')).toBeNull();
    expect(f.revoked).toEqual(f.urls);
  } finally {
    await f.close();
  }
});

test('one six-image tool invocation opens original verified bytes on demand and navigates in-group without decoding thumbnails again', async () => {
  const f = await fixture();
  try {
    await f.render(1, true, 1, undefined, { imageCount: 6, tool: true });
    await f.intersect(true);
    for (let index = 0; index < 6; index++) {
      await f.until(
        () => f.calls.filter((r) => r.method === 'input.image.open').length === index + 1,
      );
      await f.release();
      await f.until(() => f.host.querySelectorAll('img').length === index + 1);
    }
    expect(f.blobs.every((blob) => blob.type === 'image/webp')).toBe(true);
    expect(f.blobs).toHaveLength(6);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(() => !!f.document.querySelector('.image-gallery-dialog'));
    expect(f.document.querySelector('.image-gallery-caption')!.textContent).toContain('1 / 6');
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 7);
    await f.release();
    await f.until(() => f.blobs.length === 7);
    expect(f.blobs[6]!.type).toBe('image/png');
    expect(new Uint8Array(await f.blobs[6]!.arrayBuffer())).toEqual(new Uint8Array(bytes));
    const originalUrl = f.urls[6]!;
    await act(async () =>
      f.document.querySelector<HTMLButtonElement>('[aria-label="下一张图片"]')!.click(),
    );
    expect(f.revoked).toContain(originalUrl);
    expect(f.document.querySelector('.image-gallery-caption')!.textContent).toContain('2 / 6');
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 8);
    await f.release();
    await f.until(() => f.blobs.length === 8);
    const opens = f.calls.filter((r) => r.method === 'input.image.open');
    expect(opens.slice(6).map((r) => r.index)).toEqual([0, 1]);
    expect(f.peak()).toBe(1);
    await act(async () =>
      f.document.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')!.click(),
    );
    expect(f.document.querySelector('.image-gallery-dialog')).toBeNull();
    expect(f.revoked).toContain(f.urls[7]!);
    expect(f.host.querySelectorAll('img')).toHaveLength(6);
    expect(
      f.calls.every((r) =>
        ['input.image.open', 'input.image.read', 'input.image.close'].includes(r.method),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

for (const invalidation of [
  'read-permission',
  'selection',
  'epoch',
  'hidden',
  'removed',
] as const) {
  test(`a pending original is retired on ${invalidation} and late read bytes cannot publish a URL`, async () => {
    const f = await fixture();
    try {
      await f.render();
      await f.intersect(true);
      await f.release();
      await f.until(() => f.host.querySelector('img') !== null);
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
      );
      await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 2);
      const original = f.calls.filter((r) => r.method === 'input.image.open')[1]!;
      if (invalidation === 'read-permission') await f.render(1, false);
      if (invalidation === 'selection') await f.render(1, true, 2);
      if (invalidation === 'epoch') await f.render(1, true, 1, undefined, { historyEpoch: 1 });
      if (invalidation === 'hidden') await f.visibility(false);
      if (invalidation === 'removed') await f.render(0);
      expect(f.document.querySelector('.image-gallery-dialog')).toBeNull();
      expect(
        f.calls.some((r) => r.method === 'input.image.close' && r.readId === original.readId),
      ).toBe(true);
      const urls = f.urls.length;
      const reads = f.calls.filter((r) => r.method === 'input.image.read').length;
      await f.release();
      expect(f.urls).toHaveLength(urls);
      expect(f.calls.filter((r) => r.method === 'input.image.read')).toHaveLength(reads);
      expect(f.peak()).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test('closing an original queued behind six thumbnails prevents its Main open entirely', async () => {
  const f = await fixture();
  try {
    await f.render(1, true, 1, undefined, { imageCount: 6 });
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelectorAll('img').length === 1);
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 2);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await act(async () =>
      f.document.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')!.click(),
    );
    for (let index = 1; index < 6; index++) {
      await f.until(
        () => f.calls.filter((r) => r.method === 'input.image.open').length === index + 1,
      );
      await f.release();
      await f.until(() => f.host.querySelectorAll('img').length === index + 1);
    }
    expect(f.calls.filter((r) => r.method === 'input.image.open')).toHaveLength(6);
    expect(f.blobs).toHaveLength(6);
    expect(f.peak()).toBe(1);
  } finally {
    await f.close();
  }
});

test('child detail original images use only the admitted child handle read path', async () => {
  const f = await fixture();
  try {
    await f.render(1, true, 1, undefined, { childHandle: 'admitted-child' });
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelector('img') !== null);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(
      () => f.calls.filter((r) => r.method === 'background.child.image.open').length === 2,
    );
    await f.release();
    await f.until(() => f.blobs.length === 2);
    expect(new Uint8Array(await f.blobs[1]!.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect(f.calls.every((r) => r.method.startsWith('background.child.image.'))).toBe(true);
    expect(
      f.calls
        .filter((r) => r.method === 'background.child.image.open')
        .every((r) => r.handle === 'admitted-child'),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('Native host receives only one verified original from a six-image group, creates no Root original URL and retires on inactive reads', async () => {
  const f = await fixture(true);
  try {
    await f.render(1, true, 1, undefined, { imageCount: 6, tool: true });
    await f.intersect(true);
    for (let index = 0; index < 6; index++) {
      await f.until(
        () => f.calls.filter((r) => r.method === 'input.image.open').length === index + 1,
      );
      await f.release();
      await f.until(() => f.host.querySelectorAll('img').length === index + 1);
    }
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(() => f.nativeStates.length > 0);
    const sessionId = f.nativeStates[0]!.sessionId;
    expect(f.nativeStates[0]!.items).toHaveLength(6);
    expect(f.document.querySelector('.image-gallery-dialog')).toBeNull();
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 7);
    await f.release();
    await f.until(() => f.nativeStates.at(-1)?.image.status === 'ready');
    expect(f.nativeStates.at(-1)!.image).toEqual({
      status: 'ready',
      revision: expect.any(String),
      mimeType: 'image/png',
      bytes: new Uint8Array(bytes),
    });
    expect(f.blobs).toHaveLength(6);
    await f.nativeAction({ sessionId, type: 'select', id: '5' });
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 8);
    expect(f.nativeStates.at(-1)!.selectedId).toBe('5');
    await f.render(1, false, 1, undefined, { imageCount: 6, tool: true });
    expect(f.nativeClosed).toContain(sessionId);
    await f.release();
    expect(f.blobs).toHaveLength(6);
    expect(f.nativeStates.at(-1)!.image.status).toBe('loading');
    expect(f.peak()).toBe(1);
  } finally {
    await f.close();
  }
});

test('A to B to A reuses admitted thumbnail originals but every selection still opens and closes its own Main read', async () => {
  const f = await fixture(true);
  try {
    await f.render(1, true, 1, undefined, { imageCount: 2, tool: true });
    await f.intersect(true);
    for (let index = 0; index < 2; index++) {
      await f.until(
        () => f.calls.filter((r) => r.method === 'input.image.open').length === index + 1,
      );
      await f.release();
      await f.until(() => f.host.querySelectorAll('img').length === index + 1);
    }
    expect(f.originalRecords).toHaveLength(2);
    expect(f.originalRecords.every((record) => record.accepted)).toBe(true);
    const first = f.originalRecords[0]!;
    expect(f.cached(first)).toBe(first.blob);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 3);
    expect(f.nativeStates.at(-1)?.image.status).toBe('loading');
    await f.release();
    await f.until(() => f.nativeStates.at(-1)?.image.status === 'ready');
    const sessionId = f.nativeStates.at(-1)!.sessionId;
    const firstReady = f.nativeStates.at(-1)!.image;
    if (firstReady.status !== 'ready') throw Error('first_original_not_ready');
    await f.nativeAction({ sessionId, type: 'select', id: '1' });
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 4);
    await f.release();
    await f.until(() => f.nativeStates.at(-1)?.image.status === 'ready');
    await f.nativeAction({ sessionId, type: 'select', id: '0' });
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 5);
    await f.release();
    await f.until(() => f.nativeStates.at(-1)?.image.status === 'ready');
    const final = f.nativeStates.at(-1)!.image;
    expect(final.status === 'ready' && final.revision).toBe(firstReady.revision);
    expect(f.calls.filter((r) => r.method === 'input.image.read')).toHaveLength(2);
    expect(f.calls.filter((r) => r.method === 'input.image.close')).toHaveLength(5);
    expect(f.originalRecords).toHaveLength(2);
    expect(f.blobs).toHaveLength(2);
    expect(f.peak()).toBe(1);
  } finally {
    await f.close();
  }
});

test('an original cache hit cannot publish before close acknowledgement and never bypasses Main permission or metadata rejection', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelector('img') !== null);
    f.deny(true);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(() => f.document.querySelector('[role="alert"]') !== null);
    expect(f.blobs).toHaveLength(1);
    f.deny(false);
    f.corrupt(true);
    await act(async () =>
      f.document.querySelector<HTMLButtonElement>('.image-gallery-retry')!.click(),
    );
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 3);
    await f.release();
    await f.until(() => f.document.querySelector('[role="alert"]') !== null);
    expect(f.blobs).toHaveLength(1);
    f.corrupt(false);
    f.holdCloses(true);
    await act(async () =>
      f.document.querySelector<HTMLButtonElement>('.image-gallery-retry')!.click(),
    );
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 4);
    await f.release();
    await f.until(() => f.pendingCloses() > 0);
    expect(f.blobs).toHaveLength(1);
    await f.releaseCloses();
    await f.until(() => f.blobs.length === 2);
    expect(f.blobs[1]).toBe(f.originalRecords[0]!.blob);
    expect(f.calls.filter((r) => r.method === 'input.image.read')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const change of [
  'permission',
  'epoch',
  'selection',
  'child',
  'hidden',
  'source',
  'unmount',
] as const) {
  test(`original cache retirement on ${change} clears earlier bytes and requires a fresh body after readmission`, async () => {
    const f = await fixture();
    try {
      await f.render();
      await f.intersect(true);
      await f.release();
      await f.until(() => f.host.querySelector('img') !== null);
      const old = f.originalRecords[0]!;
      expect(f.cached(old)).toBe(old.blob);
      if (change === 'permission') {
        await f.render(1, false);
        await f.render();
      }
      if (change === 'epoch') await f.render(1, true, 1, undefined, { historyEpoch: 1 });
      if (change === 'selection') await f.render(1, true, 2);
      if (change === 'child') await f.render(1, true, 1, undefined, { childHandle: 'new-child' });
      if (change === 'hidden') {
        await f.visibility(false);
        await f.visibility(true);
      }
      if (change === 'source')
        await f.render(1, true, 1, undefined, { sourceRevision: '-changed' });
      if (change === 'unmount') {
        await f.render(0);
        await f.render();
      }
      expect(f.cached(old)).toBeUndefined();
      if (!f.host.querySelector('img')) {
        await f.intersect(true);
        await f.until(() => f.calls.filter((r) => r.method.endsWith('image.open')).length === 2);
        await f.release();
        await f.until(() => f.host.querySelector('img') !== null);
      } else {
        await act(async () =>
          f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
        );
        await f.until(() => f.calls.filter((r) => r.method.endsWith('image.open')).length === 2);
        await f.release();
        await f.until(() => f.blobs.length === 2);
      }
      expect(f.calls.filter((r) => r.method.endsWith('image.read'))).toHaveLength(2);
      expect(f.originalRecords).toHaveLength(2);
      expect(f.originalRecords[1]!.scope).not.toBe(old.scope);
    } finally {
      await f.close();
    }
  });
}

for (const code of [
  'input_image_view_changed',
  'artifact_scope_denied',
  'tool_images_invalid',
  'background_child_binding_changed',
]) {
  test(`Main ${code} rejection retires existing originals and closes the gallery before observation props update`, async () => {
    const f = await fixture();
    try {
      await f.render();
      await f.intersect(true);
      await f.release();
      await f.until(() => f.host.querySelector('img') !== null);
      const old = f.originalRecords[0]!;
      expect(f.cached(old)).toBe(old.blob);
      f.denyCode(code);
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
      );
      await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 2);
      expect(f.cached(old)).toBeUndefined();
      expect(f.document.querySelector('.image-gallery-dialog')).toBeNull();
      expect(f.calls.filter((r) => r.method === 'input.image.read')).toHaveLength(1);
      expect(f.blobs).toHaveLength(1);
      f.denyCode(undefined);
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
      );
      await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 3);
      await f.release();
      await f.until(() => f.blobs.length === 2);
      expect(f.calls.filter((r) => r.method === 'input.image.read')).toHaveLength(2);
      expect(f.cached(old)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
}

for (const revoke of ['hidden', 'permission'] as const) {
  test(`a cached original awaiting close ACK cannot reappear or refill after ${revoke}`, async () => {
    const f = await fixture();
    try {
      await f.render();
      await f.intersect(true);
      await f.release();
      await f.until(() => f.host.querySelector('img') !== null);
      const old = f.originalRecords[0]!;
      f.holdCloses(true);
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
      );
      await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 2);
      await f.release();
      await f.until(() => f.pendingCloses() > 0);
      expect(f.cached(old)).toBe(old.blob);
      if (revoke === 'hidden') await f.visibility(false);
      else await f.render(1, false);
      expect(f.cached(old)).toBeUndefined();
      expect(f.document.querySelector('.image-gallery-dialog')).toBeNull();
      await f.releaseCloses();
      expect(f.blobs).toHaveLength(1);
      expect(f.originalRecords).toHaveLength(1);
      expect(f.calls.filter((r) => r.method === 'input.image.read')).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

test('an explicit Main scope rejection during close retires a cache hit instead of publishing it', async () => {
  const f = await fixture();
  try {
    await f.render();
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelector('img') !== null);
    const old = f.originalRecords[0]!;
    f.denyCloseCode('input_image_view_changed');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 2);
    await f.release();
    expect(f.cached(old)).toBeUndefined();
    expect(f.document.querySelector('.image-gallery-dialog')).toBeNull();
    expect(f.blobs).toHaveLength(1);
    expect(f.calls.filter((r) => r.method === 'input.image.read')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('repeated explicit refusals still close a successfully reopened uncached image in the same observation', async () => {
  const f = await fixture(true);
  try {
    await f.render(1, true, 1, undefined, { imageCount: 2 });
    await f.intersect(true);
    for (let index = 0; index < 2; index++) {
      await f.until(
        () => f.calls.filter((r) => r.method === 'input.image.open').length === index + 1,
      );
      await f.release();
      await f.until(() => f.host.querySelectorAll('img').length === index + 1);
    }
    f.denyCode('artifact_scope_denied');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 3);
    const rejectedSession = f.nativeStates.at(-1)!.sessionId;
    expect(f.nativeClosed).toContain(rejectedSession);
    f.denyCode(undefined);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 4);
    await f.release();
    await f.until(() => f.nativeStates.at(-1)?.image.status === 'ready');
    const reopenedSession = f.nativeStates.at(-1)!.sessionId;
    expect(reopenedSession).not.toBe(rejectedSession);
    expect(f.originalRecords.at(-1)?.accepted).toBe(false);
    f.denyCode('permission_denied');
    await f.nativeAction({ sessionId: reopenedSession, type: 'select', id: '1' });
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 5);
    expect(f.nativeClosed).toContain(reopenedSession);
    expect(f.originalRecords).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test('a late close refusal from a retired activation cannot close the next exact activation', async () => {
  const f = await fixture();
  try {
    await f.render(1, true, 1, 'same-session');
    await f.intersect(true);
    await f.release();
    await f.until(() => f.host.querySelector('img') !== null);
    f.holdCloses(true);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 2);
    await f.release();
    await f.until(() => f.pendingCloses() > 0);
    await f.render(1, true, 2, 'same-session');
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.image-gallery-trigger')!.click(),
    );
    expect(f.document.querySelector('.image-gallery-dialog')).not.toBeNull();
    f.denyCloseCode('input_image_view_changed');
    await f.releaseCloses();
    await f.until(() => f.calls.filter((r) => r.method === 'input.image.open').length === 3);
    expect(f.document.querySelector('.image-gallery-dialog')).not.toBeNull();
    f.denyCloseCode(undefined);
    f.holdCloses(false);
    await f.release();
    await f.until(() => f.blobs.length === 2);
    expect(f.originalRecords.at(-1)?.accepted).toBe(true);
  } finally {
    await f.close();
  }
});
