import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeImageGalleryAction,
  NativeImageGalleryState,
  NativeImageGalleryViewerBridge,
} from '../../src/native-image-gallery-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
const restoreDom = prepareDesktopDom(dom);
const globals = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const originalGlobals = globals.map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const originalCreate = URL.createObjectURL,
  originalRevoke = URL.revokeObjectURL;
const created: string[] = [],
  revoked: string[] = [];
URL.createObjectURL = () => {
  const src = `blob:native-viewer-${created.length}`;
  created.push(src);
  return src;
};
URL.revokeObjectURL = (src) => {
  revoked.push(src);
};
let hidden = false;
Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
const { createRoot } = await import('react-dom/client');
const { NativeImageGalleryViewer } = await import('../../src/native-image-gallery-viewer');
let root: ReturnType<typeof createRoot> | undefined;
let listener: (state: NativeImageGalleryState) => void;
const actions: NativeImageGalleryAction[] = [];
const bridge: NativeImageGalleryViewerBridge = {
  watch(next) {
    listener = next;
    return () => {};
  },
  ready() {},
  act(action) {
    actions.push(action);
  },
};
function ready(id = 'a', revision = id, sessionId = 'one'): NonNullable<NativeImageGalleryState> {
  return {
    sessionId,
    items: [
      { id: 'a', name: 'first.png' },
      { id: 'b', name: 'second.png' },
    ],
    selectedId: id,
    language: 'zh',
    theme: 'dark',
    image: { status: 'ready', revision, mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
  };
}
async function mount() {
  root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(<NativeImageGalleryViewer bridge={bridge} />));
}
async function receive(state: NativeImageGalleryState) {
  await act(async () => listener(state));
}
const displayed = () =>
  document.querySelector<HTMLImageElement>(
    '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
  );
const candidate = () =>
  document.querySelector<HTMLImageElement>('.image-gallery-candidate .image-gallery-image');
const caption = () => document.querySelector('.image-gallery-caption')?.textContent;
async function decode(element = candidate()!) {
  expect(element).not.toBeNull();
  Object.defineProperties(element, {
    naturalWidth: { value: 1200, configurable: true },
    naturalHeight: { value: 800, configurable: true },
  });
  await act(async () => element.dispatchEvent(new dom.window.Event('load')));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  document.getElementById('root')!.innerHTML = '';
  created.length = 0;
  revoked.length = 0;
  actions.length = 0;
  hidden = false;
});
afterAll(async () => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  restoreDom();
  for (const [key, descriptor] of originalGlobals)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  dom.window.close();
});

test('duplicate ready/theme retain URL and image DOM; same-id revision replacement commits only after decode', async () => {
  await mount();
  await receive(ready());
  await decode();
  const first = displayed()!,
    firstSrc = first.src;
  expect(created).toHaveLength(1);
  expect(caption()).toContain('first.png');
  await receive({ ...ready(), theme: 'light' });
  expect(created).toHaveLength(1);
  expect(displayed()).toBe(first);
  expect(candidate()).toBeNull();
  expect(document.documentElement.dataset.theme).toBe('light');
  await receive(ready('a', 'new-blob'));
  expect(created).toHaveLength(2);
  expect(displayed()).toBe(first);
  expect(candidate()!.src).not.toBe(firstSrc);
  expect(revoked).not.toContain(firstSrc);
  const next = candidate()!;
  await decode(next);
  expect(displayed()).toBe(next);
  expect(displayed()!.src).not.toBe(firstSrc);
});

test('loading never borrows an unadmitted cached target; current image and caption survive each transition', async () => {
  await mount();
  await receive(ready('a'));
  await decode();
  const a = displayed()!.src;
  await receive({ ...ready('b'), image: { status: 'loading' } });
  expect(displayed()!.src).toBe(a);
  expect(caption()).toContain('first.png');
  expect(candidate()).toBeNull();
  await receive(ready('b'));
  expect(displayed()!.src).toBe(a);
  expect(caption()).toContain('first.png');
  await decode();
  const b = displayed()!.src;
  expect(caption()).toContain('second.png');
  await receive({ ...ready('a'), image: { status: 'loading' } });
  expect(displayed()!.src).toBe(b);
  expect(caption()).toContain('second.png');
  expect(candidate()).toBeNull();
  await receive(ready('a'));
  expect(created).toHaveLength(2);
  expect(candidate()!.src).toBe(a);
  expect(displayed()!.src).toBe(b);
  await decode();
  expect(displayed()!.src).toBe(a);
  expect(caption()).toContain('first.png');
});

test('retry retires a failed target without breaking the old image, and close/session/hidden dispose every URL', async () => {
  await mount();
  await receive(ready('a'));
  await decode();
  const a = displayed()!.src;
  await receive(ready('b'));
  const failed = candidate()!,
    failedSrc = failed.src;
  await act(async () => failed.dispatchEvent(new dom.window.Event('error')));
  const retry = document.querySelector<HTMLButtonElement>('.image-gallery-retry')!;
  expect(retry).not.toBeNull();
  await act(async () => retry.click());
  expect(actions.at(-1)).toEqual({ sessionId: 'one', type: 'retry' });
  expect(displayed()!.src).toBe(a);
  expect(revoked).not.toContain(a);
  expect(revoked).toContain(failedSrc);
  await receive({ ...ready('b'), image: { status: 'loading' } });
  await receive(ready('b'));
  expect(candidate()!.src).not.toBe(failedSrc);
  await decode();
  await receive(null);
  expect(displayed()).toBeNull();
  expect(new Set(revoked).size).toBe(created.length);
  await receive(ready('a', 'a', 'two'));
  expect(created).toHaveLength(4);
  await decode();
  await act(async () => {
    hidden = true;
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
  });
  expect(actions.at(-1)).toEqual({ sessionId: 'two', type: 'close' });
  expect(new Set(revoked).size).toBe(created.length);
  await act(async () => root!.unmount());
  root = undefined;
  await receive(ready('b', 'late', 'two'));
  expect(created).toHaveLength(4);
});

test('retry re-admits same-revision ready when loading and ready coalesce into one React batch', async () => {
  await mount();
  await receive(ready('a'));
  await decode();
  const original = displayed()!;
  const sameReady = ready('b');
  await receive(sameReady);
  const failedSrc = candidate()!.src;
  await act(async () => candidate()!.dispatchEvent(new dom.window.Event('error')));
  await act(async () => document.querySelector<HTMLButtonElement>('.image-gallery-retry')!.click());
  expect(candidate()).toBeNull();
  expect(displayed()).toBe(original);
  expect(created).toHaveLength(2); // Retry alone cannot reuse an old ready admission.
  await act(async () => {
    listener({ ...sameReady, image: { status: 'loading' } });
    listener(sameReady); // Deliberately reuse the exact earlier DTO object, too.
  });
  expect(candidate()).not.toBeNull();
  expect(candidate()!.src).not.toBe(failedSrc);
  expect(displayed()).toBe(original);
  expect(caption()).toContain('first.png');
  await decode();
  const recovered = displayed()!;
  expect(caption()).toContain('second.png');
  expect(created).toHaveLength(3);
  await receive({ ...sameReady, theme: 'light' });
  expect(displayed()).toBe(recovered);
  expect(candidate()).toBeNull();
  expect(created).toHaveLength(3);
});
