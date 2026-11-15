import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { nativeContentBounds, watchNativeContentWindow } from '../electron/native-content-layout';
import { waitForNativeFrame } from '../electron/native-frame-readiness';
import { projectNativeBrowserLayout } from '../src/native-content-geometry';

/** Execute the production owner's lifecycle closure, not an alternative implementation. */
function fixture(fail = false) {
  const source = readFileSync(new URL('../electron/output-preview.ts', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('      let drawable = false;'),
    source.indexOf(
      '      addNativeWindowView(input.window, view);',
      source.indexOf('      let drawable = false;'),
    ),
  );
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(body);
  let frame:
    | ((image: { isEmpty(): boolean; getSize(): { width: number; height: number } }) => void)
    | undefined;
  let started = 0,
    ended = 0,
    visible = false,
    shown = true;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  const wakes: unknown[] = [];
  const owner = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    send: (_channel: string, value: unknown) => wakes.push(value),
  });
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    getBackgroundThrottling: () => true,
    setBackgroundThrottling: () => {},
    beginFrameSubscription: (_dirty: boolean, callback: typeof frame) => {
      started++;
      if (fail) throw Error('compositor_broken');
      frame = callback;
    },
    endFrameSubscription: () => {
      ended++;
    },
    invalidate: () => {},
  });
  const view = {
    webContents: contents,
    setVisible: (value: boolean) => {
      visible = value;
    },
    getBounds: () => bounds,
    setBounds: (value: typeof bounds) => {
      bounds = value;
    },
    setBorderRadius: () => {},
  };
  const root = Object.assign(new EventEmitter(), {
    getVisible: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
  });
  const children: unknown[] = [root, view];
  const window = Object.assign(new EventEmitter(), {
    webContents: owner,
    isDestroyed: () => false,
    isVisible: () => shown,
    isMinimized: () => false,
    getContentSize: () => [1000, 700],
    contentView: { children },
  });
  const active = {
    bounds: { x: 500, y: 40, width: 500, height: 660 },
    presentation: { bounds: { x: 500, y: 40, width: 500, height: 660, radius: 8 } },
    abort: new AbortController(),
    check: () => {},
    nativeBounds: undefined,
    layout: undefined,
    presentationError: undefined as string | undefined,
  };
  const adapter = new Function(
    'deps',
    `const exports = this; const {active,input,view,nativeContentBounds,watchNativeContentWindow,getNativeRootView,projectNativeBrowserLayout,addNativeWindowView,waitForNativeFrame,nativePreviewPresentationChannel}=deps;${compiled}; return {ready(){contentReady=true;sync();},sync,dispose:active.layout.dispose};`,
  ).call(
    { active },
    {
      active,
      input: { window },
      view,
      nativeContentBounds,
      watchNativeContentWindow,
      getNativeRootView: () => root,
      projectNativeBrowserLayout,
      waitForNativeFrame,
      nativePreviewPresentationChannel: 'wake',
      addNativeWindowView: (_window: unknown, target: unknown, index: number) => {
        const old = children.indexOf(target);
        if (old >= 0) children.splice(old, 1);
        children.splice(index, 0, target);
      },
    },
  ) as { ready(): void; sync(): void; dispose(): void };
  return {
    adapter,
    active,
    children,
    view,
    root,
    wakes,
    frame: () => frame,
    visible: () => visible,
    started: () => started,
    ended: () => ended,
    hide() {
      shown = false;
      window.emit('hide');
    },
    restore() {
      shown = true;
      window.emit('restore');
    },
  };
}
const tick = () => new Promise((done) => setImmediate(done));
test('preview first frame draws below Root and only promotes matching frame; restore withdraws until new measurement', async () => {
  const f = fixture();
  try {
    expect(f.visible()).toBe(false);
    f.adapter.ready();
    expect(f.visible()).toBe(true);
    expect(f.children.indexOf(f.view)).toBeLessThan(f.children.indexOf(f.root));
    f.frame()?.({ isEmpty: () => false, getSize: () => ({ width: 500, height: 660 }) });
    await tick();
    expect(f.children.indexOf(f.view)).toBeGreaterThan(f.children.indexOf(f.root));
    expect(f.ended()).toBe(1);
    f.hide();
    expect(f.visible()).toBe(false);
    f.restore();
    expect(f.visible()).toBe(false);
    expect(f.wakes).toEqual([true]);
    expect(f.active.presentation).toBeUndefined();
  } finally {
    f.adapter.dispose();
  }
});
test('a toolbar resize before the first frame keeps the replacement draw covered', async () => {
  const f = fixture();
  try {
    f.adapter.ready();
    const firstFrame = f.frame();
    f.active.presentation.bounds = { x: 500, y: 60, width: 500, height: 640, radius: 8 };
    f.adapter.sync();

    expect(f.started()).toBe(2);
    expect(f.ended()).toBe(1);
    expect(f.children.indexOf(f.view)).toBeLessThan(f.children.indexOf(f.root));
    firstFrame?.({ isEmpty: () => false, getSize: () => ({ width: 500, height: 660 }) });
    await tick();
    expect(f.children.indexOf(f.view)).toBeLessThan(f.children.indexOf(f.root));
    f.frame()?.({ isEmpty: () => false, getSize: () => ({ width: 500, height: 640 }) });
    await tick();
    expect(f.children.indexOf(f.view)).toBeGreaterThan(f.children.indexOf(f.root));
    expect(f.visible()).toBe(true);
    expect(f.ended()).toBe(2);
  } finally {
    f.adapter.dispose();
  }
});
test('compositor failure is sticky and reported; lifecycle cancellation is not file failure', async () => {
  const failed = fixture(true);
  try {
    failed.adapter.ready();
    await tick();
    expect(failed.active.presentationError).toBe('preview_paint_failed');
    expect(failed.visible()).toBe(false);
    expect(failed.wakes).toEqual([true]);
    failed.adapter.sync();
    await tick();
    expect(failed.started()).toBe(1);
  } finally {
    failed.adapter.dispose();
  }
  const cancelled = fixture();
  try {
    cancelled.adapter.ready();
    cancelled.hide();
    await tick();
    expect(cancelled.active.presentationError).toBeUndefined();
    expect(cancelled.ended()).toBe(1);
    expect(cancelled.visible()).toBe(false);
  } finally {
    cancelled.adapter.dispose();
  }
});
