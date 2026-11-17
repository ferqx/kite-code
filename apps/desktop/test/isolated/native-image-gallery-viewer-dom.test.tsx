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

test('viewport DPR and zoom request bounded quality, with first-frame label and stable zoom/pan during pixel replacement', async () => {
  await mount();
  const state = ready();
  if (state.image.status !== 'ready') throw Error('expected_ready');
  state.image.display = {
    key: 'source-one',
    sourceWidth: 8000,
    sourceHeight: 4000,
    edge: 1024,
    frame: 'first',
  };
  await receive(state);
  const viewport = document.querySelector<HTMLElement>('.image-gallery-viewport')!;
  Object.defineProperties(viewport, { clientWidth: { value: 900 }, clientHeight: { value: 600 } });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  await act(async () => window.dispatchEvent(new dom.window.Event('resize')));
  await decode();
  expect(caption()).toContain('动画首帧');
  expect(actions.at(-1)).toEqual({ sessionId: 'one', type: 'quality', id: 'a', edge: 2048 });
  const zoom = document.querySelector<HTMLButtonElement>('[aria-label="放大图片"]')!;
  await act(async () => zoom.click());
  expect(actions.at(-1)).toEqual({ sessionId: 'one', type: 'quality', id: 'a', edge: 4096 });
  viewport.scrollLeft = 23;
  viewport.scrollTop = 45;
  const oldImage = displayed();
  await receive({
    ...state,
    image: {
      ...state.image,
      revision: 'quality4096',
      display: { ...state.image.display!, edge: 4096 },
    },
  });
  expect(displayed()).toBe(oldImage);
  expect(document.querySelector('.image-gallery-status')).toBeNull();
  await decode();
  expect(document.querySelector('.image-gallery-zoom-reset')?.textContent).toBe('14%');
  expect(viewport.scrollLeft).toBe(23);
  expect(viewport.scrollTop).toBe(45);
  expect(document.querySelector<HTMLElement>('.image-gallery-stage')!.style.width).toBe('1125px');
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

test('oriented-source ROI follows native-size scrolling, aborts immediately, keeps two crop URLs and rejects stale sources', async () => {
  await mount();
  const state = ready('a', 'overview');
  if (state.image.status !== 'ready') throw Error('ready');
  state.image.display = {
    key: 'oriented-portrait',
    sourceWidth: 8000,
    sourceHeight: 40000,
    edge: 4096,
    frame: 'static',
  };
  await receive(state);
  await decode();
  const viewport = document.querySelector<HTMLElement>('.image-gallery-viewport')!;
  Object.defineProperties(viewport, {
    clientWidth: { value: 900 },
    clientHeight: { value: 600 },
    clientLeft: { value: 0 },
    clientTop: { value: 0 },
  });
  viewport.getBoundingClientRect = () => ({
    left: 100,
    top: 100,
    width: 900,
    height: 600,
    right: 1000,
    bottom: 700,
    x: 100,
    y: 100,
    toJSON() {},
  });
  const crop = document.querySelector<HTMLElement>('[data-image-detail-source]')!;
  crop.getBoundingClientRect = () => {
    const stage = crop.parentElement!;
    const width = parseFloat(stage.style.width),
      height = parseFloat(stage.style.height);
    return {
      left: 100 - viewport.scrollLeft,
      top: 100 - viewport.scrollTop,
      width,
      height,
      right: 100 - viewport.scrollLeft + width,
      bottom: 100 - viewport.scrollTop + height,
      x: 100,
      y: 100,
      toJSON() {},
    };
  };
  await act(async () => window.dispatchEvent(new dom.window.Event('resize')));
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="原始大小"]')!.click(),
  );
  expect(document.querySelector('.image-gallery-zoom-reset')?.textContent).toBe('100%');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 170)));
  const request = actions.filter((action) => action.type === 'detail' && action.region).at(-1)!;
  if (request.type !== 'detail' || !request.region) throw Error('detail');
  expect(request.region).toEqual({ left: 0, top: 0, width: 900, height: 600 });
  const result = {
    requestId: request.requestId,
    sourceKey: request.sourceKey,
    region: request.region,
    status: 'ready' as const,
    bytes: new Uint8Array([1]),
    mimeType: 'image/webp' as const,
    width: 900,
    height: 600,
  };
  await receive({ ...state, image: { ...state.image, detail: result } });
  const candidateCrop = document.querySelector<HTMLImageElement>('.image-gallery-detail')!;
  Object.defineProperties(candidateCrop, {
    naturalWidth: { value: 900 },
    naturalHeight: { value: 600 },
  });
  await act(async () => candidateCrop.dispatchEvent(new dom.window.Event('load')));
  expect(candidateCrop.style.visibility).toBe('visible');
  expect(candidateCrop.style.width).toBe('11.25%');
  const firstUrl = candidateCrop.src;
  await act(async () => {
    viewport.scrollTop = 12000;
    viewport.dispatchEvent(new dom.window.Event('scroll'));
    viewport.scrollTop = 12345;
    viewport.dispatchEvent(new dom.window.Event('scroll'));
  });
  expect(actions.at(-1)).toMatchObject({
    type: 'detail',
    region: null,
    sourceKey: 'oriented-portrait',
  });
  expect(revoked).not.toContain(firstUrl);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 170)));
  const next = actions.filter((action) => action.type === 'detail' && action.region).at(-1)!;
  if (next.type !== 'detail' || !next.region) throw Error('detail');
  expect(next.region).toEqual({ left: 0, top: 12345, width: 900, height: 600 });
  // A late prior viewport result cannot become a candidate.
  await receive({ ...state, image: { ...state.image, detail: result } });
  expect(document.querySelectorAll('.image-gallery-detail')).toHaveLength(1);
  await receive({
    ...state,
    image: {
      ...state.image,
      detail: {
        ...result,
        requestId: next.requestId,
        sourceKey: next.sourceKey,
        region: next.region,
      },
    },
  });
  expect(document.querySelectorAll('.image-gallery-detail')).toHaveLength(2);
  const failedCrop = [...document.querySelectorAll<HTMLImageElement>('.image-gallery-detail')].at(
    -1,
  )!;
  await act(async () => failedCrop.dispatchEvent(new dom.window.Event('error')));
  expect(document.querySelector('.image-gallery-detail-error')?.textContent).toContain(
    '高清预览不可用',
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('.image-gallery-detail-error button')!.click(),
  );
  const retry = actions.at(-1)!;
  if (retry.type !== 'detail' || !retry.region) throw Error('retry');
  expect(retry.region).toEqual(next.region);
  expect(retry.requestId).not.toBe(next.requestId);
  expect(revoked).toContain(failedCrop.src);
  expect(revoked).not.toContain(firstUrl);
  await receive({
    ...state,
    image: {
      ...state.image,
      detail: {
        ...result,
        requestId: retry.requestId,
        sourceKey: retry.sourceKey,
        region: retry.region,
      },
    },
  });
  const last = [...document.querySelectorAll<HTMLImageElement>('.image-gallery-detail')].at(-1)!;
  Object.defineProperties(last, { naturalWidth: { value: 900 }, naturalHeight: { value: 600 } });
  await act(async () => last.dispatchEvent(new dom.window.Event('load')));
  expect(parseFloat(last.style.top)).toBeCloseTo(30.8625, 8);
  expect(revoked).toContain(firstUrl);
  expect(document.querySelectorAll('.image-gallery-detail')).toHaveLength(1);
  const other = ready('b', 'landscape');
  if (other.image.status !== 'ready') throw Error('ready');
  other.image.display = {
    key: 'oriented-landscape',
    sourceWidth: 40000,
    sourceHeight: 8000,
    edge: 4096,
    frame: 'static',
  };
  await receive({
    ...other,
    image: {
      ...other.image,
      detail: {
        ...result,
        requestId: next.requestId,
        sourceKey: next.sourceKey,
        region: next.region,
      },
    },
  });
  expect(document.querySelectorAll('.image-gallery-detail')).toHaveLength(0);
  expect(revoked).toContain(last.src);
  await receive(null);
  expect(new Set(revoked).size).toBe(created.length);
});

test('same-source overview upgrade failure exposes retry, preserves old pixels, and recovers without permanent busy', async () => {
  await mount();
  const state = ready('a', 'small');
  if (state.image.status !== 'ready') throw Error('ready');
  state.image.display = {
    key: 'same-source',
    sourceWidth: 8000,
    sourceHeight: 4000,
    edge: 1024,
    frame: 'static',
  };
  await receive(state);
  await decode();
  const previous = displayed();
  const upgrade = {
    ...state,
    image: {
      ...state.image,
      revision: 'large',
      display: { ...state.image.display, edge: 4096 as const },
    },
  };
  await receive(upgrade);
  await act(async () => candidate()!.dispatchEvent(new dom.window.Event('error')));
  expect(displayed()).toBe(previous);
  expect(document.querySelector('.image-gallery-retry')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('图片预览不可用');
  await act(async () => document.querySelector<HTMLButtonElement>('.image-gallery-retry')!.click());
  expect(actions.at(-1)).toMatchObject({ type: 'retry' });
  await receive({ ...state, image: { status: 'loading' } });
  await receive(upgrade);
  await decode();
  expect(document.querySelector('.image-gallery-status')).toBeNull();
  expect(displayed()).not.toBe(previous);
});
