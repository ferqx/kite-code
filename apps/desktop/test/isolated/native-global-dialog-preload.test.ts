import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  nativeGlobalDialogEventChannel,
  nativeGlobalDialogStateChannel,
} from '../../src/native-global-dialog-bridge';

test('the isolated dialog preload exposes only its fixed decision bridge and rejects other payloads', async () => {
  const result = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL('../../electron/global-dialog-preload.ts', import.meta.url)),
    ],
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  expect(result.success).toBe(true);
  const ipcRenderer = new EventEmitter();
  const sent: unknown[] = [],
    exposed: Record<string, unknown> = {};
  Object.assign(ipcRenderer, { send: (...args: unknown[]) => sent.push(args) });
  runInNewContext(await result.outputs[0]!.text(), {
    exports: {},
    module: { exports: {} },
    require(name: string) {
      if (name !== 'electron') throw Error('unexpected_authority');
      return {
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld(name: string, value: unknown) {
            exposed[name] = value;
          },
        },
      };
    },
  });
  expect(Object.keys(exposed)).toEqual(['kiteGlobalDialog']);
  const bridge =
    exposed.kiteGlobalDialog as import('../../src/native-global-dialog-bridge').NativeGlobalDialogBridge;
  expect(Object.keys(bridge).sort()).toEqual(['decide', 'presented', 'ready', 'watch']);
  bridge.ready();
  bridge.presented('one');
  bridge.decide('one', false);
  expect(sent).toEqual([
    [nativeGlobalDialogEventChannel, { type: 'ready' }],
    [nativeGlobalDialogEventChannel, { type: 'presented', requestId: 'one' }],
    [nativeGlobalDialogEventChannel, { type: 'decision', requestId: 'one', confirmed: false }],
  ]);
  expect(() => bridge.decide('bad id', true)).toThrow('invalid_global_dialog_request');
  expect(() => bridge.decide('one', 1 as unknown as boolean)).toThrow(
    'invalid_global_dialog_request',
  );
  const values: unknown[] = [],
    stop = bridge.watch((value) => values.push(value));
  const state = { requestId: 'one', kind: 'full-permission', language: 'zh', theme: 'light' };
  const workspace = { ...state, kind: 'workspace-removal', label: '<img src=x> My space' };
  const provider = { ...state, kind: 'provider-removal', label: 'Fixture', modelCount: 2 };
  const quit = { ...state, kind: 'quit-active-work' };
  for (const value of [
    { ...state, kind: 'remote-html' },
    { ...state, html: '<script>' },
    { ...state, theme: 'system' },
    { ...workspace, label: '' },
    { ...workspace, label: 'x'.repeat(257) },
    { ...workspace, label: 1 },
    { ...workspace, html: '<script>' },
    { ...provider, modelCount: -1 },
    { ...provider, modelCount: 0.5 },
    { ...provider, modelCount: '2' },
    { ...provider, modelNames: ['unexpected'] },
    quit,
    { ...quit, label: 'unexpected' },
    { ...state, label: 'unexpected' },
    undefined,
  ])
    ipcRenderer.emit(nativeGlobalDialogStateChannel, {}, value);
  expect(values).toEqual([]);
  ipcRenderer.emit(nativeGlobalDialogStateChannel, {}, state);
  ipcRenderer.emit(nativeGlobalDialogStateChannel, {}, workspace);
  ipcRenderer.emit(nativeGlobalDialogStateChannel, {}, provider);
  ipcRenderer.emit(nativeGlobalDialogStateChannel, {}, null);
  expect(values).toEqual([state, workspace, provider, null]);
  stop();
  expect(ipcRenderer.listenerCount(nativeGlobalDialogStateChannel)).toBe(0);
});
