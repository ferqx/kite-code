import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ComponentProps, type ReactNode, useLayoutEffect, useState } from 'react';
import type {
  ImageGalleryItem,
  ImageGalleryPresentationProps,
} from '../../src/desktop/ImageGallery';

const dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">outside</button>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
Object.assign(dom.window.Range.prototype, {
  getBoundingClientRect: () => new dom.window.DOMRect(),
  getClientRects: () => [],
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom.window,
  Window: dom.window.Window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  addEventListener: dom.window.addEventListener.bind(dom.window),
  removeEventListener: dom.window.removeEventListener.bind(dom.window),
  dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
  DocumentFragment: dom.window.DocumentFragment,
  Element: dom.window.Element,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const created: string[] = [];
const revoked: string[] = [];
URL.createObjectURL = () => {
  const url = `blob:gallery-${created.length + 1}`;
  created.push(url);
  return url;
};
URL.revokeObjectURL = (url) => revoked.push(url);
const { createRoot } = await import('react-dom/client');
const { ImageGallery, ImageGalleryHostContext, ImageGallerySurface } = await import(
  '../../src/desktop/ImageGallery'
);
const { Composer } = await import('../../src/desktop/Composer');
const { ConversationActivityContext } = await import('../../src/conversation-activity');
const { ReadGate } = await import('../../src/desktop/ReadGate');
let root: ReturnType<typeof createRoot> | undefined;
let select: (id: string | null) => void;
let selected: string | null;
const selections: (string | null)[] = [];
function Harness({
  images,
  initialId = images[0]?.id ?? null,
  ...props
}: Omit<ComponentProps<typeof ImageGallery>, 'selectedId' | 'onSelectedIdChange'> & {
  initialId?: string | null;
}) {
  const [id, setId] = useState(initialId);
  selected = id;
  select = (value) => {
    selections.push(value);
    setId(value);
  };
  return <ImageGallery {...props} images={images} selectedId={id} onSelectedIdChange={select} />;
}
async function render(node: ReactNode) {
  root ??= createRoot(document.getElementById('root')!);
  await act(async () => root!.render(node));
}
async function flush() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function click(label: string) {
  const button =
    document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`) ??
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent === label,
    );
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
async function key(
  value: string,
  node: Element | Document = document.querySelector('[role="dialog"]')!,
) {
  await act(async () =>
    node.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    ),
  );
}
async function decode() {
  const image = (document.querySelector<HTMLImageElement>(
    '.image-gallery-candidate .image-gallery-image',
  ) ?? document.querySelector<HTMLImageElement>('.image-gallery-image'))!;
  expect(image).not.toBeNull();
  Object.defineProperties(image, {
    naturalWidth: { value: 1200, configurable: true },
    naturalHeight: { value: 800, configurable: true },
  });
  await act(async () => image.dispatchEvent(new dom.window.Event('load')));
}
function image(id: string): ImageGalleryItem {
  return { id, name: `${id}.png`, source: { src: `data:image/png;base64,YQ==` } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const blob = () => new Blob(['original image'], { type: 'image/png' });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  await flush();
  root = undefined;
  document.getElementById('root')!.innerHTML = '';
  created.length = 0;
  revoked.length = 0;
  selections.length = 0;
});
afterAll(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('six-image group preserves original order, unavailable slots, keyboard bounds and zoom reset', async () => {
  const images = Array.from({ length: 6 }, (_, index) => image(String(index + 1)));
  images[2] = { id: '3', name: 'unavailable.png' };
  await render(<Harness images={images} />);
  expect(document.querySelector('.image-gallery-caption')?.textContent).toContain('1 / 6');
  expect(document.querySelector<HTMLButtonElement>('[aria-label="上一张图片"]')!.disabled).toBe(
    true,
  );
  await decode();
  await click('放大图片');
  expect(document.querySelector('.image-gallery-zoom-reset')?.textContent).toBe('125%');
  await click('重置图片缩放');
  expect(document.querySelector('.image-gallery-zoom-reset')?.textContent).toBe('100%');
  await click('放大图片');
  for (const id of ['2', '3', '4', '5', '6']) {
    await key('ArrowRight');
    expect(selected).toBe(id);
    if (id === '3') {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('图片预览不可用');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('3 / 6');
      expect(document.querySelector('.image-gallery-caption')?.textContent).toContain('2 / 6');
    } else {
      await decode();
      expect(document.querySelector('.image-gallery-caption')?.textContent).toContain(`${id} / 6`);
      expect(document.querySelector('.image-gallery-zoom-reset')?.textContent).toBe('100%');
    }
  }
  await key('ArrowRight');
  expect(selected).toBe('6');
  expect(document.querySelector<HTMLButtonElement>('[aria-label="下一张图片"]')!.disabled).toBe(
    true,
  );
  await key('ArrowLeft');
  expect(selected).toBe('5');
  expect(selections).toEqual(['2', '3', '4', '5', '6', '5']);
});

test('opens with trapped focus, restores thumbnail focus without forwarding Escape to the sidebar', async () => {
  const target = document.getElementById('outside')!;
  target.focus();
  let outerEscapes = 0;
  const listener = (event: KeyboardEvent) => {
    if (event.key === 'Escape') outerEscapes += 1;
  };
  window.addEventListener('keydown', listener);
  try {
    await render(<Harness images={[image('1')]} />);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭图片预览');
    target.focus();
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
    await key('Escape');
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(selected).toBeNull();
    expect(document.activeElement).toBe(target);
    expect(outerEscapes).toBe(0);
  } finally {
    window.removeEventListener('keydown', listener);
  }
});

test('loads only selected original, cancels stale reads and revokes exactly its owned active URL', async () => {
  const first = deferred<Blob>();
  const second = deferred<Blob>();
  const calls: { id: string; signal: AbortSignal }[] = [];
  const images = [
    {
      id: '1',
      name: 'one.png',
      source: {
        load: (signal: AbortSignal) => {
          calls.push({ id: '1', signal });
          return first.promise;
        },
      },
    },
    {
      id: '2',
      name: 'two.png',
      source: {
        load: (signal: AbortSignal) => {
          calls.push({ id: '2', signal });
          return second.promise;
        },
      },
    },
  ];
  await render(<Harness images={images} initialId={null} />);
  expect(calls).toHaveLength(0);
  await act(async () => select('1'));
  expect(calls.map((call) => call.id)).toEqual(['1']);
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  await key('ArrowRight');
  expect(calls.map((call) => call.id)).toEqual(['1', '2']);
  expect(calls[0]!.signal.aborted).toBe(true);
  await act(async () => first.resolve(blob()));
  expect(created).toHaveLength(0);
  await act(async () => second.resolve(blob()));
  expect(created).toEqual(['blob:gallery-1']);
  await decode();
  expect(document.querySelector('a[download="two.png"]')?.getAttribute('href')).toBe(
    'blob:gallery-1',
  );
  await click('关闭图片预览');
  expect(calls[1]!.signal.aborted).toBe(true);
  expect(revoked).toEqual(['blob:gallery-1']);
});

test('read failure retries only the current original and source replacement retires its URL', async () => {
  let calls = 0;
  const load = async () => {
    if (++calls === 1) throw Error('offline');
    return blob();
  };
  await render(<Harness images={[{ id: '1', name: 'one.png', source: { load } }]} />);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('图片预览不可用');
  await click('重试');
  expect(calls).toBe(2);
  await decode();
  await render(
    <Harness
      images={[{ id: '1', name: 'replacement.png', source: { src: 'data:image/gif;base64,Yg==' } }]}
    />,
  );
  expect(revoked).toEqual(['blob:gallery-1']);
  expect(selected).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => select('1'));
  expect(document.querySelector('.image-gallery-image')?.getAttribute('src')).toBe(
    'data:image/gif;base64,Yg==',
  );
});

for (const revokedBy of ['scope', 'disabled', 'removed', 'paused', 'gated'] as const) {
  test(`${revokedBy} closes preview and aborts an in-flight original without publishing late bytes`, async () => {
    const pending = deferred<Blob>();
    let signal!: AbortSignal;
    const images = [
      {
        id: '1',
        name: 'one.png',
        source: {
          load: (value: AbortSignal) => {
            signal = value;
            return pending.promise;
          },
        },
      },
    ];
    const view = (revoked: boolean) => (
      <ConversationActivityContext.Provider
        value={{ readActive: !(revoked && revokedBy === 'paused'), resume: 0 }}
      >
        <ReadGate blocked={revoked && revokedBy === 'gated'}>
          <Harness
            images={revoked && revokedBy === 'removed' ? [] : images}
            scopeKey={revoked && revokedBy === 'scope' ? 'new' : 'old'}
            disabled={revoked && revokedBy === 'disabled'}
          />
        </ReadGate>
      </ConversationActivityContext.Provider>
    );
    await render(view(false));
    expect(signal.aborted).toBe(false);
    await render(view(true));
    expect(selected).toBeNull();
    expect(signal.aborted).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => pending.resolve(blob()));
    expect(created).toHaveLength(0);
  });
}

for (const src of [
  'https://example.test/image.png',
  'file:///tmp/image.png',
  'data:image/svg+xml;base64,YQ==',
  'data:text/html;base64,YQ==',
]) {
  test(`never loads unadmitted source ${src.split(':')[0]}`, async () => {
    await render(<Harness images={[{ id: '1', name: 'unsafe', source: { src } }]} />);
    expect(document.querySelector('.image-gallery-image')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('图片预览不可用');
    expect(created).toHaveLength(0);
  });
}

for (const invalid of [
  new Blob(['svg'], { type: 'image/svg+xml' }),
  new Blob([new Uint8Array(16 * 1024 * 1024 + 1)], { type: 'image/png' }),
  new Blob([], { type: 'image/png' }),
]) {
  test(`rejects original bytes outside current format/size contract (${invalid.type}, ${invalid.size})`, async () => {
    await render(
      <Harness
        images={[{ id: '1', name: 'unsupported', source: { load: async () => invalid } }]}
      />,
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(created).toHaveLength(0);
  });
}

test('native host receives only the selected admitted Blob without a Root dialog or object URL', async () => {
  let latest!: ImageGalleryPresentationProps;
  const Host = (props: ImageGalleryPresentationProps) => {
    latest = props;
    return null;
  };
  let reads = 0;
  const images = [1, 2].map((id) => ({
    id: String(id),
    name: `${id}.png`,
    source: {
      load: async () => {
        reads += 1;
        return blob();
      },
    },
  }));
  await render(
    <ImageGalleryHostContext.Provider value={Host}>
      <Harness images={images} />
    </ImageGalleryHostContext.Provider>,
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(created).toHaveLength(0);
  expect(latest.status).toBe('ready');
  expect(latest.blob?.type).toBe('image/png');
  expect(reads).toBe(1);
  await act(async () => latest.onSelectedIdChange('2'));
  expect(latest.selectedId).toBe('2');
  expect(reads).toBe(2);
  expect(created).toHaveLength(0);
  await act(async () => latest.onSelectedIdChange(null));
  expect(selected).toBeNull();
});

test('presentation-only native surface never reads sources and reports image decoding failure with retry', async () => {
  let retries = 0;
  await render(
    <ImageGallerySurface
      images={[image('1')]}
      selectedId="1"
      status="ready"
      src="blob:native-local"
      onSelectedIdChange={() => {}}
      onRetry={() => {
        retries += 1;
      }}
    />,
  );
  await act(async () =>
    document.querySelector('.image-gallery-image')!.dispatchEvent(new dom.window.Event('error')),
  );
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  await click('重试');
  expect(retries).toBe(1);
  expect(created).toHaveLength(0);
});

test('draft thumbnails open one ordered group while remove remains a separate action and draft stays intact', async () => {
  let removed = '';
  const props = {
    draft: 'keep this draft',
    onChange: () => {},
    active: false,
    stopping: false,
    disabled: false,
    scopeKey: 'draft',
    onRemoveImage: (id: string) => {
      removed = id;
    },
    images: [1, 2].map((id) => ({
      id: String(id),
      name: `${id}.png`,
      url: 'data:image/png;base64,YQ==',
      previewSource: { load: async () => blob() },
    })),
  };
  await render(
    <div className="kite-client">
      <Composer {...props} />
    </div>,
  );
  await click('移除图片 1.png');
  expect(removed).toBe('1');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click('预览图片 2.png');
  expect(document.querySelector('.image-gallery-caption')?.textContent).toContain('2 / 2');
  await click('关闭图片预览');
  expect(document.querySelector<HTMLTextAreaElement>('[role="textbox"]')?.value).toBe(
    'keep this draft',
  );
  await click('预览图片 1.png');
  await render(
    <div className="kite-client">
      <Composer {...props} scopeKey="next-draft" />
    </div>,
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('restricted native surface hides download while retaining its shared overlay and controls', async () => {
  await render(
    <ImageGallerySurface
      images={[image('1')]}
      selectedId="1"
      status="ready"
      src="blob:native-local"
      allowDownload={false}
      onSelectedIdChange={() => {}}
      onRetry={() => {}}
    />,
  );
  await decode();
  expect(document.querySelector('[aria-label="下载图片"]')).toBeNull();
  expect(document.querySelector('[aria-label="关闭图片预览"]')).not.toBeNull();
  expect(document.querySelector('.bg-black\\/50')).not.toBeNull();
});

test('source object rebuild does not reread, while document hide closes exactly once and releases original', async () => {
  let reads = 0;
  const load = async () => {
    reads += 1;
    return blob();
  };
  await render(<Harness images={[{ id: '1', name: 'one.png', source: { load } }]} />);
  await render(<Harness images={[{ id: '1', name: 'one.png', source: { load } }]} />);
  expect(reads).toBe(1);
  expect(document.querySelector('.image-gallery-caption')?.textContent).toContain('one.png');
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange')));
    expect(selections).toEqual([null]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(revoked).toEqual(['blob:gallery-1']);
  } finally {
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
});

test('selecting duplicate source URLs remounts decoding and retry re-decodes the same admitted source', async () => {
  await render(<Harness images={[image('1'), image('2')]} />);
  const first = document.querySelector('.image-gallery-image');
  await decode();
  await key('ArrowRight');
  const second = document.querySelector('.image-gallery-candidate .image-gallery-image');
  expect(second).not.toBe(first);
  await decode();
  expect(document.querySelector('[role="status"]')).toBeNull();
  await act(async () => second!.dispatchEvent(new dom.window.Event('error')));
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  await click('重试');
  expect(document.querySelector('.image-gallery-candidate .image-gallery-image')).not.toBe(second);
  await decode();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('fullscreen surface removes inherited centered-dialog translation utilities before production CSS compilation', async () => {
  await render(<Harness images={[image('1')]} />);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.classList.contains('-translate-x-1/2')).toBe(false);
  expect(dialog.classList.contains('-translate-y-1/2')).toBe(false);
  expect(dialog.classList.contains('translate-x-0')).toBe(true);
  expect(dialog.classList.contains('translate-y-0')).toBe(true);
});

const atomicItems = ['a', 'b', 'c'].map((id) => ({ id, name: `${id}.png` }));
function displayedImage() {
  return document.querySelector<HTMLImageElement>(
    '.image-gallery-stage:not(.image-gallery-candidate) .image-gallery-image',
  );
}
function candidateImage() {
  return document.querySelector<HTMLImageElement>('.image-gallery-candidate .image-gallery-image');
}
function captionText() {
  return document.querySelector('.image-gallery-caption')?.textContent;
}
function prepareDecode(element: HTMLImageElement, promise?: Promise<void>) {
  Object.defineProperties(element, {
    naturalWidth: { value: 1200, configurable: true },
    naturalHeight: { value: 800, configurable: true },
    ...(promise ? { decode: { value: () => promise, configurable: true } } : {}),
  });
}

test('surface keeps the old decoded node and caption until target decode commits both atomically', async () => {
  const commits: { src: string; caption: string | null | undefined; alt: string | undefined }[] =
    [];
  const onImageCommit = (src: string) =>
    commits.push({ src, caption: captionText(), alt: displayedImage()?.alt });
  const view = (
    selectedId: string,
    status: ImageGalleryPresentationProps['status'],
    src?: string,
  ) => (
    <ImageGallerySurface
      images={atomicItems}
      selectedId={selectedId}
      status={status}
      src={src}
      onImageCommit={onImageCommit}
      onSelectedIdChange={() => {}}
      onRetry={() => {}}
    />
  );
  await render(view('a', 'ready', 'blob:a'));
  expect(displayedImage()).toBeNull();
  await decode();
  const a = displayedImage()!;
  await click('放大图片');
  await render(view('b', 'loading'));
  expect(displayedImage()).toBe(a);
  expect(a.alt).toBe('a.png');
  expect(captionText()).toContain('a.png1 / 3');
  expect(document.querySelector('[role="status"]')?.textContent).toContain('b.png · 2 / 3');
  expect(document.querySelector('.image-gallery-viewport')?.getAttribute('aria-busy')).toBe('true');
  expect(document.querySelector<HTMLButtonElement>('[aria-label="下载图片"]')!.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('[aria-label="放大图片"]')!.disabled).toBe(true);
  expect(document.querySelector('.image-gallery-zoom-reset')?.textContent).toBe('125%');
  await render(view('b', 'ready', 'blob:b'));
  const b = candidateImage()!;
  expect(displayedImage()).toBe(a);
  expect(document.querySelectorAll('.image-gallery-image')).toHaveLength(2);
  expect(b.closest('[aria-hidden="true"]')).not.toBeNull();
  const decoding = deferred<void>();
  prepareDecode(b, decoding.promise);
  await act(async () => b.dispatchEvent(new dom.window.Event('load')));
  expect(displayedImage()).toBe(a);
  expect(captionText()).toContain('a.png1 / 3');
  expect(commits).toHaveLength(1);
  await act(async () => decoding.resolve(undefined));
  expect(displayedImage()).toBe(b);
  expect(a.isConnected).toBe(false);
  expect(captionText()).toContain('b.png2 / 3');
  expect(document.querySelectorAll('.image-gallery-image')).toHaveLength(1);
  expect(document.querySelector('.image-gallery-zoom-reset')?.textContent).toBe('100%');
  expect(document.querySelector('.image-gallery-viewport')?.getAttribute('aria-busy')).toBe(
    'false',
  );
  expect(document.querySelector('a[download="b.png"]')?.getAttribute('href')).toBe('blob:b');
  await render(view('a', 'ready', 'blob:a'));
  expect(displayedImage()).toBe(b);
  expect(captionText()).toContain('b.png2 / 3');
  await decode();
  expect(displayedImage()?.alt).toBe('a.png');
  expect(captionText()).toContain('a.png1 / 3');
  expect(commits).toEqual([
    { src: 'blob:a', caption: 'a.png1 / 3', alt: 'a.png' },
    { src: 'blob:b', caption: 'b.png2 / 3', alt: 'b.png' },
    { src: 'blob:a', caption: 'a.png1 / 3', alt: 'a.png' },
  ]);
});

test('rapid target changes and late decode completion never commit an obsolete candidate or wrong caption', async () => {
  const commits: string[] = [];
  const view = (selectedId: string, src: string) => (
    <ImageGallerySurface
      images={atomicItems}
      selectedId={selectedId}
      src={src}
      status="ready"
      onImageCommit={(url) => commits.push(url)}
      onSelectedIdChange={() => {}}
      onRetry={() => {}}
    />
  );
  await render(view('a', 'blob:a'));
  await decode();
  const a = displayedImage()!;
  await render(view('b', 'blob:b'));
  const b = candidateImage()!;
  const pendingB = deferred<void>();
  prepareDecode(b, pendingB.promise);
  await act(async () => b.dispatchEvent(new dom.window.Event('load')));
  await render(view('c', 'blob:c'));
  expect(document.querySelectorAll('.image-gallery-image')).toHaveLength(2);
  expect(displayedImage()).toBe(a);
  expect(b.isConnected).toBe(false);
  await act(async () => pendingB.resolve(undefined));
  expect(displayedImage()).toBe(a);
  expect(captionText()).toContain('a.png1 / 3');
  await decode();
  expect(displayedImage()?.alt).toBe('c.png');
  expect(captionText()).toContain('c.png3 / 3');
  expect(commits).toEqual(['blob:a', 'blob:c']);
});

test('A to pending B to A reuses the committed A node and ignores B decoding without blanking', async () => {
  const commits: string[] = [];
  const view = (selectedId: string) => (
    <ImageGallerySurface
      images={atomicItems}
      selectedId={selectedId}
      src={`blob:${selectedId}`}
      status="ready"
      onImageCommit={(url) => commits.push(url)}
      onSelectedIdChange={() => {}}
      onRetry={() => {}}
    />
  );
  await render(view('a'));
  await decode();
  const a = displayedImage()!;
  await render(view('b'));
  const b = candidateImage()!;
  const pending = deferred<void>();
  prepareDecode(b, pending.promise);
  await act(async () => b.dispatchEvent(new dom.window.Event('load')));
  await render(view('a'));
  expect(displayedImage()).toBe(a);
  expect(candidateImage()).toBeNull();
  expect(document.querySelector('[role="status"]')).toBeNull();
  await act(async () => pending.resolve(undefined));
  expect(displayedImage()).toBe(a);
  expect(captionText()).toContain('a.png1 / 3');
  expect(commits).toEqual(['blob:a']);
});

test('target errors name the failed target separately and retry cannot act on retained old image', async () => {
  let retries = 0;
  const view = (
    selectedId: string,
    status: ImageGalleryPresentationProps['status'],
    src?: string,
    sourceKey = 0,
  ) => (
    <ImageGallerySurface
      images={atomicItems}
      selectedId={selectedId}
      status={status}
      src={src}
      sourceKey={sourceKey}
      onSelectedIdChange={() => {}}
      onRetry={() => {
        retries += 1;
      }}
    />
  );
  await render(view('a', 'ready', 'blob:a'));
  await decode();
  const a = displayedImage();
  await render(view('b', 'error'));
  expect(displayedImage()).toBe(a);
  expect(captionText()).toContain('a.png1 / 3');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('b.png · 2 / 3');
  expect(document.querySelector('a[download]')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[aria-label="重置图片缩放"]')!.disabled).toBe(
    true,
  );
  await click('重试');
  expect(retries).toBe(1);
  await render(view('b', 'ready', 'blob:b', 1));
  const b = candidateImage()!;
  await act(async () => b.dispatchEvent(new dom.window.Event('error')));
  expect(displayedImage()).toBe(a);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('b.png · 2 / 3');
  await render(view('b', 'ready', 'blob:b', 2));
  expect(candidateImage()).not.toBe(b);
  await decode();
  expect(displayedImage()?.alt).toBe('b.png');
  expect(captionText()).toContain('b.png2 / 3');
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

for (const change of ['id', 'name', 'load', 'src', 'order'] as const) {
  test(`changing any group ${change} identity closes the original gallery session`, async () => {
    let retired: AbortSignal | undefined;
    const load = (signal: AbortSignal) => {
      retired = signal;
      return new Promise<Blob>(() => {});
    };
    const images: ImageGalleryItem[] = [
      { id: 'a', name: 'a.png', source: { load } },
      { id: 'b', name: 'b.png', source: { src: 'blob:b' } },
    ];
    await render(<Harness images={images} />);
    const changed = images.map((item) => ({ ...item }));
    if (change === 'id') changed[1]!.id = 'new-b';
    if (change === 'name') changed[1]!.name = 'renamed.png';
    if (change === 'load') changed[1]!.source = { load: async () => blob() };
    if (change === 'src') changed[1]!.source = { src: 'blob:new-b' };
    if (change === 'order') changed.reverse();
    await render(<Harness images={changed} />);
    expect(selected).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(retired?.aborted).toBe(true);
  });
}

test('unmount and read revocation clear retained images and prevent late decoded candidates from publishing', async () => {
  const commits: string[] = [];
  const props = {
    images: atomicItems,
    selectedId: 'a',
    status: 'ready' as const,
    src: 'blob:a',
    onSelectedIdChange: () => {},
    onRetry: () => {},
    onImageCommit: (src: string) => {
      commits.push(src);
    },
  };
  await render(<ImageGallerySurface {...props} />);
  await decode();
  await render(<ImageGallerySurface {...props} selectedId="b" src="blob:b" />);
  const b = candidateImage()!;
  const pending = deferred<void>();
  prepareDecode(b, pending.promise);
  await act(async () => b.dispatchEvent(new dom.window.Event('load')));
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () => pending.resolve(undefined));
  expect(document.querySelectorAll('.image-gallery-image')).toHaveLength(0);
  expect(commits).toEqual(['blob:a']);

  const images = [image('a'), image('b')];
  const view = (readActive: boolean) => (
    <ConversationActivityContext.Provider value={{ readActive, resume: 0 }}>
      <Harness images={images} />
    </ConversationActivityContext.Provider>
  );
  await render(view(true));
  await decode();
  await act(async () => select('b'));
  expect(document.querySelectorAll('.image-gallery-image')).toHaveLength(2);
  await render(view(false));
  expect(document.querySelectorAll('.image-gallery-image')).toHaveLength(0);
  expect(selected).toBeNull();
});

test('identical admitted ready deliveries keep the displayed node, decoded state, zoom and commit pin', async () => {
  const commits: string[] = [];
  const view = () => (
    <ImageGallerySurface
      images={atomicItems.map((item) => ({ ...item }))}
      selectedId="a"
      src="blob:a"
      status="ready"
      onSelectedIdChange={() => {}}
      onRetry={() => {}}
      onImageCommit={(src) => commits.push(src)}
    />
  );
  await render(view());
  await decode();
  const a = displayedImage();
  await click('放大图片');
  await render(view());
  expect(displayedImage()).toBe(a);
  expect(candidateImage()).toBeNull();
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector('.image-gallery-zoom-reset')?.textContent).toBe('125%');
  expect(commits).toEqual(['blob:a']);
});

test('source group changes unmount Native host ownership before a new selection can start another session', async () => {
  let mounts = 0,
    unmounts = 0;
  const Host = () => {
    useLayoutEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);
    return null;
  };
  const images = [image('a'), image('b')];
  const view = (items: readonly ImageGalleryItem[]) => (
    <ImageGalleryHostContext.Provider value={Host}>
      <Harness images={items} />
    </ImageGalleryHostContext.Provider>
  );
  await render(view(images));
  expect(mounts).toBe(1);
  await render(view([images[0]!, { ...images[1]!, source: { src: 'blob:replacement-b' } }]));
  expect(selected).toBeNull();
  expect(unmounts).toBe(1);
  await act(async () => select('a'));
  expect(mounts).toBe(2);
});

test('Native host accepts large admitted sources without Root URLs while the Web size contract stays separate', async () => {
  let latest!: ImageGalleryPresentationProps;
  const Host = (props: ImageGalleryPresentationProps) => {
    latest = props;
    return null;
  };
  const source = new Blob([new Uint8Array(17 * 1024 * 1024)], { type: 'image/png' });
  await render(
    <ImageGalleryHostContext.Provider value={Host}>
      <Harness
        images={[{ id: 'large', name: 'large.png', source: { load: async () => source } }]}
      />
    </ImageGalleryHostContext.Provider>,
  );
  expect(latest.status).toBe('ready');
  expect(latest.blob).toBe(source);
  expect(created).toHaveLength(0);
  expect(document.querySelector('img')).toBeNull();
});
