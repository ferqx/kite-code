import { expect, test } from 'bun:test';
import { webcrypto } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  type NativeImageDisplayBridge,
  type NativeImageDisplayResult,
  nativeImageDisplayCancelChannel,
  nativeImageDisplayChannel,
} from '../../src/native-image-display-bridge';

async function bundle(entry: string) {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entry, import.meta.url))],
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  expect(built.success).toBe(true);
  return built.outputs[0]!.text();
}
const result: NativeImageDisplayResult = {
  bytes: new Uint8Array([1]),
  mimeType: 'image/webp',
  width: 1,
  height: 1,
  sourceWidth: 1,
  sourceHeight: 1,
  animated: false,
  frame: 'static',
};
const request = {
  id: 'request',
  bytes: new Uint8Array([1]),
  mediaType: 'image/png',
  edge: 512,
} as const;

test('Root preload exposes byte-only render/cancel, rejects extra authority and checks derivative DTO', async () => {
  const ipc = new EventEmitter(),
    exposed: Record<string, unknown> = {},
    sent: unknown[][] = [],
    calls: unknown[][] = [];
  let reply: unknown = { ok: true, value: result };
  Object.assign(ipc, {
    send: (...args: unknown[]) => sent.push(args),
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      return reply;
    },
  });
  runInNewContext(await bundle('../../electron/preload.ts'), {
    module: { exports: {} },
    exports: {},
    document: { getElementById: () => ({ inert: false }) },
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
  const bridge = exposed.kiteNativeImageDisplay as NativeImageDisplayBridge;
  expect(Object.keys(bridge).sort()).toEqual(['cancel', 'render']);
  for (const invalid of [
    { ...request, path: '/secret' },
    { ...request, source: { path: '/secret' } },
    { ...request, url: 'https://example.com' },
    { ...request, edge: 100000 },
    { ...request, mediaType: 'image/svg+xml' },
  ]) {
    await expect(bridge.render(invalid as never)).rejects.toThrow('native_image_display_invalid');
  }
  expect(calls).toHaveLength(0);
  expect(await bridge.render(request)).toEqual({ ok: true, value: result });
  expect(calls[0]).toEqual([nativeImageDisplayChannel, request]);
  const region = { left: 10, top: 5, width: 16, height: 8 };
  const roi = { ...result, width: 16, height: 8, sourceWidth: 96, sourceHeight: 48, region };
  reply = { ok: true, value: roi };
  expect(await bridge.render({ ...request, region })).toEqual({ ok: true, value: roi });
  await expect(bridge.render(request)).rejects.toThrow('native_image_display_output_invalid');
  reply = { ok: true, value: { ...roi, region: { ...region, left: 11 } } };
  await expect(bridge.render({ ...request, region })).rejects.toThrow(
    'native_image_display_output_invalid',
  );
  reply = { ok: true, value: { ...roi, region: { ...region, path: '/secret' } } };
  await expect(bridge.render({ ...request, region })).rejects.toThrow(
    'native_image_display_output_invalid',
  );
  await expect(bridge.render({ ...request, region, edge: 4096 })).rejects.toThrow(
    'native_image_display_invalid',
  );
  bridge.cancel('request');
  bridge.cancel('../secret');
  expect(sent).toEqual([[nativeImageDisplayCancelChannel, 'request']]);
  for (const value of [
    { ...result, path: '/secret' },
    { ...result, width: 4097 },
    { ...result, sourceWidth: 0 },
    { ...result, animated: true },
    { ...result, mimeType: 'image/svg+xml' },
  ]) {
    reply = { ok: true, value };
    await expect(bridge.render(request)).rejects.toThrow('native_image_display_output_invalid');
  }
});

test('renderer wrapper forwards cancellation and never admits late success or falls back to original bytes', async () => {
  let resolve!: (value: unknown) => void;
  const cancelled: string[] = [],
    calls: unknown[] = [];
  const bridge = {
    render(input: unknown) {
      calls.push(input);
      return new Promise((finish) => {
        resolve = finish;
      });
    },
    cancel(id: string) {
      cancelled.push(id);
    },
  };
  const module = {
    exports: {} as {
      renderNativeImageDisplay: typeof import('../../src/native-image-display-bridge').renderNativeImageDisplay;
    },
  };
  runInNewContext(await bundle('../../src/native-image-display-bridge.ts'), {
    module,
    exports: module.exports,
    crypto: webcrypto,
    window: { kiteNativeImageDisplay: bridge },
  });
  const controller = new AbortController();
  const pending = module.exports
    .renderNativeImageDisplay({
      bytes: request.bytes,
      mediaType: 'image/png',
      edge: 512,
      signal: controller.signal,
    })
    .catch((cause) => cause);
  expect(calls).toHaveLength(1);
  controller.abort(Error('gone'));
  expect(cancelled).toHaveLength(1);
  resolve({ ok: true, value: result });
  expect((await pending).message).toBe('gone');
  await expect(
    module.exports.renderNativeImageDisplay({
      bytes: request.bytes,
      mediaType: 'image/png',
      edge: 512,
      signal: controller.signal,
    }),
  ).rejects.toThrow('gone');
  expect(calls).toHaveLength(1);
});
