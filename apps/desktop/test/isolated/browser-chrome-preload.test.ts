import { expect, mock, test } from 'bun:test';
import {
  nativeBrowserChromeChannel,
  nativeBrowserChromeStateChannel,
} from '../../src/native-browser-chrome-bridge';

const exposed: Record<string, unknown> = {};
const listeners = new Map<string, (...args: unknown[]) => void>();
const calls: unknown[][] = [];
let reply: unknown = null;
mock.module('electron', () => ({
  contextBridge: {
    exposeInMainWorld(name: string, value: unknown) {
      exposed[name] = value;
    },
  },
  ipcRenderer: {
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      return reply;
    },
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel),
  },
}));

test('Chrome preload exposes only validated read/watch/render-ack/typed-send without Root or automation authority', async () => {
  const previous = process.isMainFrame;
  Object.defineProperty(process, 'isMainFrame', { configurable: true, value: true });
  try {
    await import('../../electron/browser-chrome-preload');
    expect(Object.keys(exposed)).toEqual(['kiteBrowserChrome']);
    const bridge = exposed.kiteBrowserChrome as {
      read(): Promise<unknown>;
      watch(receive: (value: unknown) => void): () => void;
      send(value: unknown): Promise<unknown>;
      rendered(value: unknown): Promise<void>;
    };
    expect(Object.keys(bridge).sort()).toEqual(['read', 'rendered', 'send', 'watch']);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(await bridge.read()).toBeNull();
    expect(calls.at(-1)).toEqual([nativeBrowserChromeChannel, { action: 'read' }]);
    reply = { arbitrary: 'authority' };
    await expect(bridge.read()).rejects.toThrow('invalid_browser_chrome_envelope');
    const received: unknown[] = [];
    const stop = bridge.watch((value) => received.push(value));
    listeners.get(nativeBrowserChromeStateChannel)!(null, { arbitrary: true });
    listeners.get(nativeBrowserChromeStateChannel)!(null, null);
    expect(received).toEqual([null]);
    stop();
    expect(listeners.has(nativeBrowserChromeStateChannel)).toBe(false);
    await expect(bridge.send({ action: 'execute', code: 'unsafe' })).rejects.toThrow(
      'invalid_browser_chrome_event',
    );
    const event = {
      attachment: 'attachment',
      pageToken: 'token',
      sequence: 1,
      revision: 1,
      part: 'toolbar',
      action: { type: 'reload' },
    };
    reply = 'business-success';
    expect(await bridge.send(event)).toBe('unconfirmed');
    reply = 'forwarded';
    expect(await bridge.send(event)).toBe('forwarded');
    expect(calls.at(-1)).toEqual([nativeBrowserChromeChannel, { action: 'send', event }]);
    const rendered = { attachment: 'attachment', pageToken: 'token', revision: 1 };
    const before = calls.length;
    for (const value of [
      null,
      {},
      { ...rendered, revision: 0 },
      { ...rendered, revision: 1.5 },
      { ...rendered, pageToken: '' },
      { ...rendered, attachment: 'x'.repeat(129) },
      { ...rendered, action: 'reload' },
      { ...rendered, code: 'unsafe' },
    ]) {
      await expect(bridge.rendered(value)).rejects.toThrow('invalid_browser_chrome_rendered');
    }
    expect(calls).toHaveLength(before);
    reply = undefined;
    await bridge.rendered(rendered);
    expect(calls.at(-1)).toEqual([nativeBrowserChromeChannel, { action: 'rendered', ...rendered }]);
    reply = 'forwarded';
    await expect(bridge.rendered(rendered)).rejects.toThrow('invalid_browser_chrome_rendered');
  } finally {
    Object.defineProperty(process, 'isMainFrame', { configurable: true, value: previous });
  }
});
