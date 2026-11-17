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
import { installImagePreviewWorker } from '../image-preview-worker.fixture';
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
  const restoreDisplay = installImagePreviewWorker();
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
      restoreDisplay();
      restoreLayout();
      for (const [key, descriptor] of old)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      dom.window.close();
    },
  };
}

test('Native gallery forwards only the selected derived bytes and scopes viewer actions and close to its presentation', async () => {
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
      mimeType: 'image/webp',
      bytes: new TextEncoder().encode('derived'),
      display: {
        key: expect.any(String),
        sourceWidth: 1,
        sourceHeight: 1,
        edge: 1024,
        frame: 'static',
      },
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
    const oversized = new Blob([new Uint8Array(1)], { type: 'image/png' });
    Object.defineProperty(oversized, 'size', { value: 256 * 1024 * 1024 + 1 });
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

test('large sources enter only the byte codec, quality upgrades retain source identity and close cancels late pixels', async () => {
  const f = fixture();
  try {
    const requests: import('../../src/native-image-display-bridge').NativeImageDisplayRequest[] =
      [];
    const cancelled: string[] = [];
    let release!: (
      value: import('../../src/native-image-display-bridge').NativeImageDisplayReply,
    ) => void;
    window.kiteNativeImageDisplay = {
      render(request) {
        requests.push(request);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      cancel(id) {
        cancelled.push(id);
      },
    };
    const blob = new Blob([new Uint8Array(17 * 1024 * 1024)], { type: 'image/png' });
    await f.render({ status: 'ready', blob });
    await f.until(() => requests.length === 1);
    expect(requests[0]!.edge).toBe(1024);
    expect(requests[0]!.bytes.byteLength).toBe(blob.size);
    const value = {
      bytes: new Uint8Array([7]),
      mimeType: 'image/png' as const,
      width: 1024,
      height: 512,
      sourceWidth: 8000,
      sourceHeight: 4000,
      animated: true,
      frame: 'first' as const,
    };
    await act(async () => release({ ok: true, value }));
    const first = f.states.at(-1)!;
    if (first.image.status !== 'ready') throw Error('expected_ready');
    expect(first.image.bytes).toEqual(new Uint8Array([7]));
    expect(first.image.display?.frame).toBe('first');
    await f.action({ sessionId: first.sessionId, type: 'quality', id: '0', edge: 2048 });
    await f.until(() => requests.length === 2);
    expect(requests[1]!.edge).toBe(2048);
    expect(f.states.at(-1)).toBe(first); // Keep prior pixels while sharpening.
    await act(async () => release({ ok: true, value: { ...value, width: 2048, height: 1024 } }));
    const second = f.states.at(-1)!.image;
    expect(second.status === 'ready' && second.display?.key).toBe(first.image.display?.key);
    expect(second.status === 'ready' && second.revision).not.toBe(first.image.revision);
    await f.action({ sessionId: first.sessionId, type: 'quality', id: '0', edge: 4096 });
    await f.until(() => requests.length === 3);
    const count = f.states.length;
    await f.unmount();
    expect(cancelled).toContain(requests[2]!.id);
    await act(async () => release({ ok: true, value }));
    expect(f.states).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test('ROI uses only current admitted Blob and exact source key, cancels older crops and shows retryable failure', async () => {
  const f = fixture();
  try {
    const requests: import('../../src/native-image-display-bridge').NativeImageDisplayRequest[] =
      [];
    const cancelled: string[] = [];
    const replies = new Map<
      string,
      (reply: import('../../src/native-image-display-bridge').NativeImageDisplayReply) => void
    >();
    window.kiteNativeImageDisplay = {
      render(request) {
        requests.push(request);
        return new Promise((resolve) => replies.set(request.id, resolve));
      },
      cancel(id) {
        cancelled.push(id);
      },
    };
    const blob = new Blob(['unchanged-original'], { type: 'image/png' });
    await f.render({ status: 'ready', blob });
    await f.until(() => requests.length === 1);
    const base = {
      bytes: new Uint8Array([1]),
      mimeType: 'image/webp' as const,
      width: 1024,
      height: 512,
      sourceWidth: 8000,
      sourceHeight: 4000,
      animated: false,
      frame: 'static' as const,
    };
    await act(async () => replies.get(requests[0]!.id)!({ ok: true, value: base }));
    const state = f.states.at(-1)!;
    if (state.image.status !== 'ready') throw Error('ready');
    const sourceKey = state.image.display!.key;
    await f.action({
      sessionId: state.sessionId,
      type: 'detail',
      id: '0',
      sourceKey: 'wrong',
      requestId: 'wrong',
      region: { left: 0, top: 0, width: 500, height: 400 },
    });
    expect(requests).toHaveLength(1);
    const region = { left: 2000, top: 1000, width: 500, height: 400 };
    await f.action({
      sessionId: state.sessionId,
      type: 'detail',
      id: '0',
      sourceKey,
      requestId: 'first',
      region,
    });
    await f.until(() => requests.length === 2);
    expect(requests[1]!.edge).toBe(2048);
    expect(requests[1]!.region).toEqual(region);
    expect(new TextDecoder().decode(requests[1]!.bytes)).toBe('unchanged-original');
    await f.action({
      sessionId: state.sessionId,
      type: 'detail',
      id: '0',
      sourceKey,
      requestId: 'cancel',
      region: null,
    });
    expect(cancelled).toContain(requests[1]!.id);
    await act(async () =>
      replies.get(requests[1]!.id)!({
        ok: true,
        value: { ...base, width: 500, height: 400, region },
      }),
    );
    expect(f.states.at(-1)).toBe(state);
    await f.action({
      sessionId: state.sessionId,
      type: 'detail',
      id: '0',
      sourceKey,
      requestId: 'second',
      region,
    });
    await f.until(() => requests.length === 3);
    await act(async () =>
      replies.get(requests[2]!.id)!({ ok: false, code: 'native_image_display_decode_failed' }),
    );
    expect(f.states.at(-1)!.image).toMatchObject({
      status: 'ready',
      detail: { status: 'error', requestId: 'second', region },
    });
    await f.action({
      sessionId: state.sessionId,
      type: 'detail',
      id: '0',
      sourceKey,
      requestId: 'retry',
      region,
    });
    await f.until(() => requests.length === 4);
    const count = f.states.length;
    await f.unmount();
    expect(cancelled).toContain(requests[3]!.id);
    await act(async () =>
      replies.get(requests[3]!.id)!({
        ok: true,
        value: { ...base, width: 500, height: 400, region },
      }),
    );
    expect(f.states).toHaveLength(count);
  } finally {
    await f.close();
  }
});
