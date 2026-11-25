import type { NativeWindowAppearance } from '../src/native-bridge';
import { type NativeRootWindow, onNativeRootWillShow } from './native-root-window';

export function selectWindowMaterial(
  platform: NodeJS.Platform,
  release: string,
  windowsAcrylicAvailable: boolean,
): NativeWindowAppearance['backgroundMaterial'] {
  if (platform === 'darwin') return 'vibrancy';
  if (platform !== 'win32') return 'none';
  const build = Number(release.split('.')[2]);
  if (build >= 22621) return 'mica';
  if (build >= 17763 && windowsAcrylicAvailable) return 'acrylic';
  return 'none';
}

export function solidWindowColor(dark: boolean): string {
  return dark ? '#191919' : '#fafafa';
}

const windowsAppearanceMessages = [
  0x0015, // WM_SYSCOLORCHANGE
  0x001a, // WM_SETTINGCHANGE
  0x0218, // WM_POWERBROADCAST
  0x031e, // WM_DWMCOMPOSITIONCHANGED
];

export function attachWindowsAcrylic(
  window: NativeRootWindow,
  apply: (handle: Buffer, dark: boolean) => boolean,
  darkMode: () => boolean,
): () => void {
  const handle = window.getNativeWindowHandle();
  let color: string | undefined;
  const update = () => {
    if (window.isDestroyed()) return;
    const dark = darkMode();
    const next = apply(handle, dark) ? '#00000000' : solidWindowColor(dark);
    if (next !== color) {
      window.setBackgroundColor(next);
      color = next;
    }
  };
  for (const message of windowsAppearanceMessages) window.hookWindowMessage(message, update);
  const unwatchShow = onNativeRootWillShow(window, update);
  let pending: ReturnType<typeof setImmediate> | undefined;
  const afterActivation = () => {
    if (pending) return;
    // DWM can rebuild the client surface during the native show or activation callback.
    pending = setImmediate(() => {
      pending = undefined;
      color = undefined;
      update();
    });
  };
  window.on('show', afterActivation);
  window.on('focus', afterActivation);
  window.once('closed', () => {
    unwatchShow();
    if (pending) clearImmediate(pending);
  });
  update();
  return update;
}
