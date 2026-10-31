import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

test('the installed React refresh runtime accepts the reevaluated real browser component boundary', async () => {
  const dom = new JSDOM('<!doctype html><div></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
  });
  try {
    const plugin = dirname(fileURLToPath(import.meta.resolve('@vitejs/plugin-react')));
    const runtime = (await import(pathToFileURL(join(plugin, 'refresh-runtime.js')).href)) as {
      registerExportsForReactRefresh(id: string, exports: object): void;
      validateRefreshBoundaryAndEnqueueUpdate(
        id: string,
        previous: object,
        next: object,
      ): string | undefined;
    };
    const path = '../../src/native-browser-pane.tsx';
    const first = (await import(
      `${path}?refresh-boundary-first`
    )) as typeof import('../../src/native-browser-pane');
    const next = (await import(
      `${path}?refresh-boundary-next`
    )) as typeof import('../../src/native-browser-pane');
    expect(first.NativeBrowserPane).not.toBe(next.NativeBrowserPane);
    const id = 'native-browser-pane';
    const adaptersPath = '../../src/native-browser-session.tsx';
    const oldAdapters = (await import(
      `${adaptersPath}?refresh-boundary-first`
    )) as typeof import('../../src/native-browser-session');
    const nextAdapters = (await import(
      `${adaptersPath}?refresh-boundary-next`
    )) as typeof import('../../src/native-browser-session');
    for (const key of Object.keys(oldAdapters) as (keyof typeof oldAdapters)[]) {
      expect(oldAdapters[key]).not.toBe(nextAdapters[key]);
      // These real helpers used to share the component module. Reevaluate each
      // one as that old mixed boundary to prove the installed rejection path.
      expect(
        runtime.validateRefreshBoundaryAndEnqueueUpdate(
          id,
          { ...first, [key]: oldAdapters[key] },
          { ...next, [key]: nextAdapters[key] },
        ),
      ).toContain(`"${key}" export is incompatible`);
    }
    runtime.registerExportsForReactRefresh(id, first);
    runtime.registerExportsForReactRefresh(id, next);
    let queued = false;
    const completed = new Promise<void>((resolve) => {
      const register = Reflect.get(window, '__registerBeforePerformReactRefresh') as (
        callback: () => void,
      ) => void;
      register(() => {
        queued = true;
        resolve();
      });
    });
    expect(runtime.validateRefreshBoundaryAndEnqueueUpdate(id, first, next)).toBeUndefined();
    await completed;
    expect(queued).toBe(true);
    expect(Object.keys(next)).toEqual(['NativeBrowserPane']);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
