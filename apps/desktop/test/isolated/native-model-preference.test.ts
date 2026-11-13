import { readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { expect, test } from '#kite-test';
import { build as buildFixture } from '../../../../scripts/tooling/build';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { nativeModelPreferences } from '../../electron/model-preference';
import { registerNativeModelPreferenceIpc } from '../../electron/native-ipc';
import type { NativeRootWindow } from '../../electron/native-root-window';
import type {
  NativeModelPreferenceBridge,
  NativeModelPreferenceReply,
} from '../../src/native-model-preference-bridge';
import { nativeModelPreferenceChannel } from '../../src/native-model-preference-bridge';

function cleanPreferences(root: string) {
  const directory = join(root, 'preferences');
  for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
  rmdirSync(directory);
  rmdirSync(root);
}

test('host model preferences survive reopening, isolate Stores, and preserve corrupt bytes on reads', () => {
  const root = temporaryDirectory('kite-model-preference-');
  const directory = join(root, 'preferences');
  try {
    const preferences = nativeModelPreferences(directory);
    expect(preferences.read('store')).toBeNull();
    preferences.remember('store', { modelId: 'a', reasoningEffort: 'high' });
    const cold = nativeModelPreferences(directory);
    expect(cold.read('store')).toEqual({ modelId: 'a', reasoningEffort: 'high' });
    expect(cold.read('other')).toBeNull();
    const file = join(directory, readdirSync(directory)[0]!);
    for (const raw of ['broken', '{"modelId":"a","extra":true}', 'x'.repeat(1025)]) {
      writeFileSync(file, raw);
      expect(() => cold.read('store')).toThrow('model_preference_unavailable');
      expect(readFileSync(file, 'utf8')).toBe(raw);
    }
    cold.remember('store', { modelId: 'b' });
    expect(preferences.read('store')).toEqual({ modelId: 'b' });
    expect(() => preferences.remember('../escape', { modelId: 'bad id' })).toThrow(
      'model_preference_invalid',
    );
    expect(() => preferences.read('bad\u0000store')).toThrow('model_preference_invalid');
    expect(readdirSync(directory)).toHaveLength(1);
  } finally {
    cleanPreferences(root);
  }
});

test('actual preload and host IPC persist only bounded model preferences from the exact main frame', async () => {
  const root = temporaryDirectory('kite-model-preference-ipc-');
  type Handler = (event: IpcMainInvokeEvent, input: unknown) => NativeModelPreferenceReply;
  const handlers = new Map<string, Handler>();
  const frame = { url: 'http://127.0.0.1:41001/' };
  const contents = { mainFrame: frame };
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const preferences = nativeModelPreferences(join(root, 'preferences'));
  const stop = registerNativeModelPreferenceIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain,
    window: () =>
      ({ isDestroyed: () => false, webContents: contents }) as unknown as NativeRootWindow,
    rendererUrl: frame.url,
    preferences: () => preferences,
  });
  try {
    const built = await buildFixture({
      entrypoints: [resolve(import.meta.dirname, '../../electron/preload.ts')],
      target: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    expect(built.success).toBe(true);
    let bridge!: NativeModelPreferenceBridge;
    runInNewContext(await built.outputs[0]!.text(), {
      document: { defaultView: null },
      exports: {},
      module: { exports: {} },
      require(name: string) {
        if (name !== 'electron') throw Error('unexpected_dependency');
        return {
          contextBridge: {
            exposeInMainWorld: (_key: string, value: NativeModelPreferenceBridge) => {
              bridge = value;
            },
          },
          ipcRenderer: {
            on() {},
            invoke: (channel: string, input: unknown) => handlers.get(channel)!(event, input),
          },
        };
      },
    });
    expect(await bridge.readRecommendedModel('store')).toBeNull();
    await bridge.rememberRecommendedModel('store', { modelId: 'b', reasoningEffort: 'ultar' });
    expect(await bridge.readRecommendedModel('store')).toEqual({
      modelId: 'b',
      reasoningEffort: 'ultar',
    });
    const handler = handlers.get(nativeModelPreferenceChannel)!;
    for (const denied of [
      { ...event, senderFrame: { url: frame.url } },
      { ...event, sender: { mainFrame: frame } },
      { ...event, senderFrame: { url: 'http://127.0.0.1:41002/' } },
    ])
      expect(handler(denied as IpcMainInvokeEvent, { action: 'read', storeId: 'store' }).ok).toBe(
        false,
      );
    for (const input of [
      { action: 'read', storeId: 'store', path: root },
      { action: 'remember', storeId: 'store', choice: { modelId: 'a', extra: true } },
      {
        action: 'remember',
        storeId: 'store',
        choice: { modelId: 'a', reasoningEffort: 'invalid' },
      },
    ])
      expect(handler(event, input).ok).toBe(false);
    expect(preferences.read('store')).toEqual({ modelId: 'b', reasoningEffort: 'ultar' });
  } finally {
    stop();
    cleanPreferences(root);
  }
});
