import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { nativeGlobalDialogActiveChannel } from '../../src/native-global-dialog-bridge';
import {
  type NativeImageGalleryBridge,
  type NativeImageGalleryViewerBridge,
  nativeImageGalleryActionChannel,
  nativeImageGalleryActiveChannel,
  nativeImageGalleryEventChannel,
  nativeImageGalleryStateChannel,
} from '../../src/native-image-gallery-bridge';

async function preload(entry: string) {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(`../../electron/${entry}.ts`, import.meta.url))],
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  expect(result.success).toBe(true);
  const ipc = new EventEmitter();
  const sent: unknown[][] = [],
    exposed: Record<string, unknown> = {};
  const root = { inert: false };
  Object.assign(ipc, { send: (...args: unknown[]) => sent.push(args) });
  runInNewContext(await result.outputs[0]!.text(), {
    exports: {},
    module: { exports: {} },
    document: { getElementById: () => root },
    require(name: string) {
      if (name !== 'electron') throw Error('unexpected_authority');
      return {
        ipcRenderer: ipc,
        webUtils: {},
        contextBridge: {
          exposeInMainWorld(name: string, value: unknown) {
            exposed[name] = value;
          },
        },
      };
    },
  });
  return { ipc, sent, exposed, root };
}
test('isolated image preload has only watch, readiness and finite current-selection actions', async () => {
  const f = await preload('image-gallery-preload');
  expect(Object.keys(f.exposed)).toEqual(['kiteImageGalleryViewer']);
  const bridge = f.exposed.kiteImageGalleryViewer as NativeImageGalleryViewerBridge;
  expect(Object.keys(bridge).sort()).toEqual(['act', 'ready', 'watch']);
  bridge.ready();
  bridge.act({ sessionId: 'one', type: 'select', id: 'a' });
  expect(f.sent).toEqual([
    [nativeImageGalleryEventChannel, { type: 'ready' }],
    [nativeImageGalleryEventChannel, { sessionId: 'one', type: 'select', id: 'a' }],
  ]);
  for (const action of [
    { sessionId: 'one', type: 'read', path: '/private' },
    { sessionId: 'one', type: 'unavailable' },
    { sessionId: 'one', type: 'retry', bytes: [1] },
    { sessionId: 'bad id', type: 'close' },
  ])
    expect(() => bridge.act(action as never)).toThrow('invalid_image_gallery_action');
  const values: unknown[] = [];
  const unwatch = bridge.watch((value) => values.push(value));
  const state = {
    sessionId: 'one',
    items: [{ id: 'a', name: 'same.png' }],
    selectedId: 'a',
    language: 'zh',
    theme: 'dark',
    image: { status: 'loading' },
  };
  for (const value of [
    { ...state, url: 'https://evil.test' },
    { ...state, html: '<img>' },
    { ...state, theme: 'system' },
    { ...state, image: { status: 'ready', src: '/private' } },
  ])
    f.ipc.emit(nativeImageGalleryStateChannel, {}, value);
  expect(values).toEqual([]);
  f.ipc.emit(nativeImageGalleryStateChannel, {}, state);
  f.ipc.emit(nativeImageGalleryStateChannel, {}, null);
  expect(values).toEqual([state, null]);
  unwatch();
  expect(f.ipc.listenerCount(nativeImageGalleryStateChannel)).toBe(0);
});
test('Root presentation bridge rejects extra authority and modal inertness aggregates stacked owners', async () => {
  const f = await preload('preload');
  const bridge = f.exposed.kiteNativeImageGallery as NativeImageGalleryBridge;
  expect(Object.keys(bridge).sort()).toEqual(['close', 'present', 'watchActions']);
  const state = {
    sessionId: 'one',
    items: [{ id: 'a', name: 'a.png' }],
    selectedId: 'a',
    language: 'zh',
    image: { status: 'loading' },
  };
  bridge.present(state as never);
  expect(() => bridge.present({ ...state, path: '/private' } as never)).toThrow(
    'invalid_image_gallery_state',
  );
  const values: unknown[] = [];
  const stop = bridge.watchActions((value) => values.push(value));
  f.ipc.emit(nativeImageGalleryActionChannel, {}, { sessionId: 'one', type: 'select', id: 'a' });
  f.ipc.emit(
    nativeImageGalleryActionChannel,
    {},
    { sessionId: 'one', type: 'execute', code: 'bad' },
  );
  expect(values).toEqual([{ sessionId: 'one', type: 'select', id: 'a' }]);
  stop();
  f.ipc.emit(nativeImageGalleryActiveChannel, {}, true);
  expect(f.root.inert).toBe(true);
  f.ipc.emit(nativeGlobalDialogActiveChannel, {}, true);
  expect(f.root.inert).toBe(true);
  f.ipc.emit(nativeGlobalDialogActiveChannel, {}, false);
  expect(f.root.inert).toBe(true);
  f.ipc.emit(nativeImageGalleryActiveChannel, {}, false);
  expect(f.root.inert).toBe(false);
  f.root.inert = true;
  f.ipc.emit(nativeImageGalleryActiveChannel, {}, true);
  f.ipc.emit(nativeImageGalleryActiveChannel, {}, false);
  expect(f.root.inert).toBe(true);
});

test('ready revisions are finite opaque presentation identities, not paths or arbitrary payloads', async () => {
  const f = await preload('image-gallery-preload');
  const bridge = f.exposed.kiteImageGalleryViewer as NativeImageGalleryViewerBridge;
  const states: unknown[] = [];
  const stop = bridge.watch((value) => states.push(value));
  const state = {
    sessionId: 'one',
    items: [{ id: 'a', name: 'a.png' }],
    selectedId: 'a',
    language: 'zh',
    theme: 'dark',
    image: {
      status: 'ready',
      revision: 'opaque-Blob_1',
      mimeType: 'image/png',
      bytes: new Uint8Array([1]),
    },
  };
  for (const revision of [
    undefined,
    '',
    'file:///private/image',
    'https://remote/image',
    'a'.repeat(129),
    {},
    1,
  ])
    f.ipc.emit(
      nativeImageGalleryStateChannel,
      {},
      { ...state, image: { ...state.image, revision } },
    );
  expect(states).toEqual([]);
  f.ipc.emit(nativeImageGalleryStateChannel, {}, state);
  expect(states).toEqual([state]);
  stop();
});
