import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { NativeBridge } from '../../src/native-bridge';
import type {
  NativePreviewLayoutIdentity,
  NativePreviewLayoutRequest,
} from '../../src/native-preview-layout-bridge';
import { presentNativePreview } from '../../src/native-preview-presentation';

test('preview presentation shares clipping, synchronous motion and ordered withdrawal without reopening files', async () => {
  const dom = new JSDOM('<div id="clip" style="overflow:hidden"><div id="node"></div></div>', {
    pretendToBeVisual: true,
  });
  const keys = [
    'window',
    'document',
    'HTMLElement',
    'DOMRect',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
  ] as const;
  const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        key === 'ResizeObserver'
          ? class {
              observe() {}
              disconnect() {}
            }
          : key === 'getComputedStyle'
            ? dom.window.getComputedStyle.bind(dom.window)
            : Reflect.get(dom.window, key),
    });
  const node = document.getElementById('node')!;
  const clip = document.getElementById('clip')!;
  let left = 100;
  let reads = 0;
  node.getBoundingClientRect = () => {
    reads++;
    return new DOMRect(left, 30, 300, 300);
  };
  clip.getBoundingClientRect = () => new DOMRect(150, 40, 200, 200);
  const sync: NativePreviewLayoutRequest[] = [],
    async: NativePreviewLayoutRequest[] = [];
  let resolve: (() => void) | undefined;
  let rejectWithdrawal = false;
  let wake: ((interrupted?: NativePreviewLayoutIdentity) => void) | undefined;
  const bridge = {
    presentPreviewLayout(input: NativePreviewLayoutRequest) {
      sync.push(input);
      if (rejectWithdrawal && input.bounds === null) throw Error('owner_retired');
    },
    presentPreviewLayoutAsync(input: NativePreviewLayoutRequest) {
      async.push(input);
      return new Promise<void>((done) => {
        resolve = done;
      });
    },
    subscribePreviewPresentation(listener: (interrupted?: NativePreviewLayoutIdentity) => void) {
      wake = listener;
      return () => {
        wake = undefined;
      };
    },
  } as unknown as NativeBridge;
  let interrupted = 0;
  const controller = presentNativePreview(node, bridge, 7, 'preview', undefined, () => {
    interrupted++;
  });
  const tick = () => new Promise((done) => setTimeout(done, 40));
  const scroll = () => window.dispatchEvent(new dom.window.Event('scroll'));
  try {
    expect(sync).toHaveLength(0);
    controller.ready();
    expect(sync.at(-1)!.bounds).toMatchObject({ x: 150, y: 40, width: 200, height: 200 });
    left = 180;
    const idleReads = reads;
    await tick();
    expect(reads).toBe(idleReads);
    scroll();
    await tick();
    expect(async).toHaveLength(1);
    left = 200;
    scroll();
    await tick();
    expect(async).toHaveLength(1);
    clip.style.visibility = 'hidden';
    await tick();
    expect(sync.at(-1)!.bounds).toBeNull();
    expect(sync.at(-1)!.presentationRevision).toBeGreaterThan(async[0]!.presentationRevision);
    resolve?.();
    await tick();
    expect(sync.at(-1)!.bounds).toBeNull();
    clip.style.visibility = 'visible';
    await tick();
    expect(sync.at(-1)!.bounds!.x).toBe(200);
    clip.dataset.slot = 'resizable-panel-group';
    clip.dataset.animateWidth = 'true';
    const asyncCount = async.length;
    left = 210;
    await tick();
    expect(sync.at(-1)!.bounds!.x).toBe(210);
    left = 215;
    await tick();
    expect(sync.at(-1)!.bounds!.x).toBe(215);
    expect(async.length).toBe(asyncCount);
    clip.dataset.animateWidth = 'false';
    await tick();
    const settledReads = reads;
    await tick();
    expect(reads).toBe(settledReads);
    wake?.({ previewId: 'retired', generation: 7 });
    wake?.({ previewId: 'preview', generation: 6 });
    expect(interrupted).toBe(0);
    const previous = sync.at(-1)!.presentationRevision;
    wake?.();
    expect(sync.at(-1)!.presentationRevision).toBeGreaterThan(previous);
    rejectWithdrawal = true;
    expect(() => controller.dispose()).not.toThrow();
    expect(sync.at(-1)!.bounds).toBeNull();
    expect(wake).toBeUndefined();
    rejectWithdrawal = false;
    const successor = presentNativePreview(node, bridge, 7, 'successor', undefined, () => {
      interrupted++;
    });
    successor.ready();
    const staleListener = wake;
    staleListener?.({ previewId: 'successor', generation: 7 });
    staleListener?.({ previewId: 'successor', generation: 7 });
    successor.ready();
    successor.dispose();
    expect(interrupted).toBe(1);
    expect(wake).toBeUndefined();
    expect(sync.at(-1)!.bounds).not.toBeNull();
    const issues: string[] = [];
    const missing = presentNativePreview(node, {} as NativeBridge, 7, 'missing', (issue) =>
      issues.push(issue),
    );
    missing.ready();
    await tick();
    expect(issues).toEqual(['预览显示尚未确认，请重新打开文件。']);
    missing.dispose();
    for (const asyncFailure of [false, true]) {
      const messages: string[] = [];
      let attempts = 0;
      let notify: (() => void) | undefined;
      const failed = presentNativePreview(
        node,
        {
          presentPreviewLayout(input: NativePreviewLayoutRequest) {
            if (!input.bounds) return;
            attempts++;
            if (!asyncFailure) throw Error('preview_paint_failed');
          },
          async presentPreviewLayoutAsync() {
            attempts++;
            throw Error('preview_paint_failed');
          },
          subscribePreviewPresentation(listener: () => void) {
            notify = listener;
            return () => {};
          },
        } as unknown as NativeBridge,
        7,
        'failed',
        (issue) => {
          if (issue) messages.push(issue);
        },
      );
      failed.ready();
      if (asyncFailure) {
        left++;
        scroll();
        await tick();
      }
      const count = attempts;
      notify?.();
      left++;
      scroll();
      await tick();
      expect(attempts).toBe(count);
      expect(messages).toEqual(['预览绘制失败，请关闭后重新打开。']);
      failed.dispose();
    }
  } finally {
    controller.dispose();
    dom.window.close();
    for (const [key, descriptor] of old)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
