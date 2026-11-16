import { expect, test } from 'bun:test';
import {
  ErrorFeedbackContext,
  ImageGallery,
  type ImageGalleryPresentationProps,
} from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  NativeImageGalleryPresentation,
  NativeImageGalleryProvider,
} from '../../src/native-image-gallery';
import type {
  NativeImageGalleryPresentation as GalleryState,
  NativeImageGalleryAction,
} from '../../src/native-image-gallery-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

function fixture() {
  const dom = new JSDOM('<!doctype html><div id="root"></div><button id="source">image</button>', {
    pretendToBeVisual: true,
  });
  const restoreLayout = prepareDesktopDom(dom);
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const states: GalleryState[] = [];
  const closed: string[] = [];
  const watchers = new Set<(action: NativeImageGalleryAction) => void>();
  Object.assign(dom.window, {
    kiteNativeImageGallery: {
      present: (state: GalleryState) => states.push(state),
      close: (id: string) => closed.push(id),
      watchActions: (listener: (action: NativeImageGalleryAction) => void) => {
        watchers.add(listener);
        return () => watchers.delete(listener);
      },
    },
  });
  let hidden = false;
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  const selected: (string | null)[] = [];
  const errors: string[] = [];
  const feedback = (message: string) => errors.push(message);
  let retries = 0;
  const defaults: ImageGalleryPresentationProps = {
    images: [
      { id: '0', name: 'first.png' },
      { id: '1', name: 'second.png' },
    ],
    selectedId: '0',
    status: 'loading',
    onSelectedIdChange: (id) => selected.push(id),
    onRetry: () => retries++,
    canRestoreFocus: () => true,
  };
  const root = createRoot(dom.window.document.getElementById('root')!);
  const render = async (props: Partial<ImageGalleryPresentationProps> = {}) => {
    await act(async () =>
      root.render(
        <ErrorFeedbackContext.Provider value={feedback}>
          <NativeImageGalleryPresentation {...defaults} {...props} />
        </ErrorFeedbackContext.Provider>,
      ),
    );
  };
  const until = async (check: () => boolean) => {
    for (let index = 0; index < 40 && !check(); index++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(check()).toBe(true);
  };
  return {
    states,
    errors,
    closed,
    selected,
    watchers,
    render,
    until,
    retries: () => retries,
    async renderMissingNativePort(load: (signal: AbortSignal) => Promise<Blob>) {
      delete window.kiteNativeImageGallery;
      function Gallery() {
        const [id, select] = useState<string | null>('0');
        return (
          <ImageGallery
            images={[{ id: '0', name: 'original.png', source: { load } }]}
            selectedId={id}
            onSelectedIdChange={(next) => {
              selected.push(next);
              select(next);
            }}
          />
        );
      }
      await act(async () =>
        root.render(
          <ErrorFeedbackContext.Provider value={feedback}>
            <NativeImageGalleryProvider nativeWindow>
              <Gallery />
            </NativeImageGalleryProvider>
          </ErrorFeedbackContext.Provider>,
        ),
      );
    },
    hasRootDialog: () => dom.window.document.querySelector('.image-gallery-dialog') !== null,
    async action(action: NativeImageGalleryAction) {
      await act(async () => {
        for (const listener of watchers) listener(action);
      });
    },
    async hide() {
      await act(async () => {
        hidden = true;
        dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      });
    },
    async unmount() {
      await act(async () => root.unmount());
    },
    async close() {
      await act(async () => root.unmount());
      restoreLayout();
      for (const [key, descriptor] of old)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      dom.window.close();
    },
  };
}

test('Native gallery forwards only the selected original bytes and scopes viewer actions and close to its presentation', async () => {
  const f = fixture();
  try {
    await f.render();
    expect(f.states).toHaveLength(1);
    const sessionId = f.states[0]!.sessionId;
    expect(f.states[0]!.image).toEqual({ status: 'loading' });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await f.render({ status: 'ready', blob, src: 'blob:root-only-do-not-transmit' });
    await f.until(() => f.states.at(-1)?.image.status === 'ready');
    expect(f.states.at(-1)!.image).toEqual({
      status: 'ready',
      revision: expect.any(String),
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(JSON.stringify(f.states)).not.toContain('root-only');
    await f.action({ sessionId: 'unrelated', type: 'close' });
    await f.action({ sessionId, type: 'select', id: 'missing' });
    expect(f.selected).toEqual([]);
    await f.action({ sessionId, type: 'select', id: '1' });
    await f.action({ sessionId, type: 'retry' });
    expect(f.selected).toEqual(['1']);
    expect(f.retries()).toBe(1);
    await f.action({ sessionId, type: 'close' });
    expect(f.selected).toEqual(['1', null]);
    expect(f.errors).toEqual([]);
    await f.unmount();
    expect(f.closed).toEqual([sessionId]);
    expect(f.watchers.size).toBe(0);
  } finally {
    await f.close();
  }
});

test('Native original copying is latest-selection-only and cannot revive after close or hidden', async () => {
  const f = fixture();
  try {
    let release!: (buffer: ArrayBuffer) => void;
    const deferred = new Blob(['pending'], { type: 'image/png' });
    Object.defineProperty(deferred, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        }),
    });
    await f.render();
    await f.render({ status: 'ready', blob: deferred });
    const sessionId = f.states[0]!.sessionId;
    await f.render({ selectedId: '1', status: 'loading' });
    await act(async () => release(new Uint8Array([4]).buffer));
    expect(f.states.some((state) => state.image.status === 'ready')).toBe(false);
    await f.render({ selectedId: '1', status: 'ready', blob: deferred });
    await f.hide();
    expect(f.closed).toContain(sessionId);
    expect(f.selected).toEqual([null]);
    const count = f.states.length;
    await f.unmount();
    await act(async () => release(new Uint8Array([5]).buffer));
    expect(f.states).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test('Native presentation refuses URL-only, unsupported and oversized originals without copying them', async () => {
  const f = fixture();
  try {
    await f.render({ status: 'ready', src: 'https://untrusted.example/image.png' });
    expect(f.states.at(-1)?.image).toEqual({ status: 'error' });
    const unsupported = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    Object.defineProperty(unsupported, 'arrayBuffer', {
      value: () => {
        throw Error('must_not_read');
      },
    });
    await f.render({ status: 'ready', blob: unsupported });
    expect(f.states.at(-1)?.image).toEqual({ status: 'error' });
    const oversized = new Blob([new Uint8Array(16 * 1024 * 1024 + 1)], { type: 'image/png' });
    Object.defineProperty(oversized, 'arrayBuffer', {
      value: () => {
        throw Error('must_not_read');
      },
    });
    await f.render({ status: 'ready', blob: oversized });
    expect(f.states.at(-1)?.image).toEqual({ status: 'error' });
    expect(f.states.every((state) => state.image.status === 'error')).toBe(true);
  } finally {
    await f.close();
  }
});

test('an outdated Native preload reports the missing feature once without a Root fallback or original read', async () => {
  const f = fixture();
  try {
    let reads = 0;
    await f.renderMissingNativePort(async () => {
      reads++;
      return new Blob(['original'], { type: 'image/png' });
    });
    expect(f.errors).toEqual(['图片预览功能尚未加载，请完全退出后重新启动。']);
    expect(f.selected).toEqual([null]);
    expect(reads).toBe(0);
    expect(f.hasRootDialog()).toBe(false);
    expect(f.states).toEqual([]);
  } finally {
    await f.close();
  }
});

test('an exact Native surface failure reports once and retires late bytes while normal close remains silent', async () => {
  const f = fixture();
  try {
    let release!: (buffer: ArrayBuffer) => void;
    const blob = new Blob(['original'], { type: 'image/png' });
    Object.defineProperty(blob, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        }),
    });
    await f.render();
    await f.render({ status: 'ready', blob });
    const sessionId = f.states[0]!.sessionId;
    await f.action({ sessionId: 'retired', type: 'unavailable' });
    expect(f.errors).toEqual([]);
    await f.action({ sessionId, type: 'unavailable' });
    await f.action({ sessionId, type: 'unavailable' });
    expect(f.errors).toEqual(['图片预览暂时不可用，请重新打开。']);
    expect(f.selected).toEqual([null]);
    expect(f.closed).toContain(sessionId);
    const count = f.states.length;
    await act(async () => release(new Uint8Array(8).buffer));
    expect(f.states).toHaveLength(count);
    expect(f.states.every((state) => state.image.status !== 'ready')).toBe(true);
  } finally {
    await f.close();
  }
});

test('Root Blob revision stays stable without extra ready-to-loading transitions and changes for a new same-id Blob', async () => {
  const f = fixture();
  try {
    const a = new Blob(['one'], { type: 'image/png' }),
      b = new Blob(['two'], { type: 'image/png' });
    await f.render();
    await f.render({ status: 'ready', blob: a });
    expect(f.states.map((state) => state.image.status)).toEqual(['loading', 'ready']);
    const first = f.states.at(-1)!.image;
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') throw Error('expected_ready');
    expect(first.revision).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    await f.render({ status: 'loading' });
    await f.render({ status: 'ready', blob: a });
    const again = f.states.at(-1)!.image;
    expect(again.status === 'ready' && again.revision).toBe(first.revision);
    const before = f.states.length;
    await f.render({ status: 'ready', blob: b });
    expect(f.states.length).toBe(before + 1);
    const changed = f.states.at(-1)!.image;
    expect(changed.status === 'ready' && changed.revision).not.toBe(first.revision);
  } finally {
    await f.close();
  }
});
