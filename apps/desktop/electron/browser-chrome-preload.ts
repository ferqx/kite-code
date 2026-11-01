import { contextBridge, ipcRenderer } from 'electron';
import {
  isNativeBrowserChromeEnvelope,
  isNativeBrowserChromeEvent,
  isNativeBrowserChromeRendered,
  type NativeBrowserChromeBridge,
  type NativeBrowserChromeResult,
  nativeBrowserChromeChannel,
  nativeBrowserChromeStateChannel,
} from '../src/native-browser-chrome-bridge';

/** This isolated renderer has no Kite caller, Service access or browser automation bridge. */
const bridge: NativeBrowserChromeBridge = {
  async rendered(input) {
    if (!isNativeBrowserChromeRendered(input)) throw Error('invalid_browser_chrome_rendered');
    if (
      (await ipcRenderer.invoke(nativeBrowserChromeChannel, { action: 'rendered', ...input })) !==
      undefined
    )
      throw Error('invalid_browser_chrome_rendered');
  },
  async read() {
    const value: unknown = await ipcRenderer.invoke(nativeBrowserChromeChannel, { action: 'read' });
    if (value !== null && !isNativeBrowserChromeEnvelope(value))
      throw Error('invalid_browser_chrome_envelope');
    return value;
  },
  watch(receive) {
    const listener = (_event: unknown, value: unknown) => {
      if (value === null || isNativeBrowserChromeEnvelope(value)) receive(value);
    };
    ipcRenderer.on(nativeBrowserChromeStateChannel, listener);
    return () => ipcRenderer.removeListener(nativeBrowserChromeStateChannel, listener);
  },
  async send(event) {
    if (!isNativeBrowserChromeEvent(event)) throw Error('invalid_browser_chrome_event');
    const result: unknown = await ipcRenderer.invoke(nativeBrowserChromeChannel, {
      action: 'send',
      event,
    });
    return ['forwarded', 'stale', 'unconfirmed'].includes(String(result))
      ? (result as NativeBrowserChromeResult)
      : 'unconfirmed';
  },
};

if (process.isMainFrame)
  contextBridge.exposeInMainWorld('kiteBrowserChrome', Object.freeze(bridge));
