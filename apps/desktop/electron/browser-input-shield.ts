import { randomUUID } from 'node:crypto';
import { type WebContents, WebContentsView } from 'electron';
import type { NativeRootWindow as BrowserWindow } from './native-root-window';

const document = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}</style><body aria-hidden="true"></body>`;

/** One Main-owned native hit surface above the page. It never forwards human input to CDP.
 * The virtual cursor/glow remain pointer-events:none in the actual page, separately. */
export function createBrowserInputShield(window: BrowserWindow, onFailure: () => void) {
  let shield: WebContentsView | undefined;
  let contents: WebContents | undefined;
  let preparing: Promise<void> | undefined;
  let disposed = false;
  let failed = false;
  let target: WebContentsView | undefined;
  const focusApp = () => {
    if (!disposed && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.focus();
      } catch {
        fail();
      }
    }
  };
  const fail = () => {
    if (disposed || failed) return;
    failed = true;
    onFailure();
  };
  return {
    available() {
      return !!contents && !disposed && !failed && !contents.isDestroyed();
    },
    prepare() {
      if (disposed || failed) return Promise.reject(Error('browser_input_shield_closed'));
      preparing ??= (async () => {
        shield = new WebContentsView({
          webPreferences: {
            partition: `kite-browser-input-shield-${randomUUID()}`,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            webSecurity: true,
            devTools: false,
            webviewTag: false,
            navigateOnDragDrop: false,
            disableDialogs: true,
          },
        });
        contents = shield.webContents;
        shield.setBackgroundColor('#00000000');
        shield.setVisible(false);
        window.contentView.addChildView(shield);
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-navigate', (event) => event.preventDefault());
        contents.on('will-attach-webview', (event) => event.preventDefault());
        contents.on('before-input-event', (event) => event.preventDefault());
        contents.on('focus', focusApp);
        contents.on('render-process-gone', fail);
        contents.on('destroyed', fail);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(Error('browser_input_shield_timeout')), 5000);
            }),
          ]);
          if (disposed || contents.isDestroyed()) throw Error('browser_input_shield_closed');
        } finally {
          clearTimeout(timer);
        }
      })().catch((error) => {
        fail();
        throw error;
      });
      return preparing.then(() => {
        if (disposed || failed || !contents || contents.isDestroyed())
          throw Error('browser_input_shield_closed');
      });
    },
    sync(view: WebContentsView | undefined, blocked: boolean) {
      target = blocked ? view : undefined;
      if (!shield || !contents || disposed || contents.isDestroyed()) return;
      if (!target?.getVisible()) {
        if (shield.getVisible()) shield.setVisible(false);
        return;
      }
      const next = target.getBounds(),
        previous = shield.getBounds();
      if (
        next.x !== previous.x ||
        next.y !== previous.y ||
        next.width !== previous.width ||
        next.height !== previous.height
      )
        shield.setBounds(next);
      const children = window.contentView.children;
      if (children[children.length - 1] !== shield) window.contentView.addChildView(shield);
      if (!shield.getVisible()) shield.setVisible(true);
      if (target.webContents.isFocused()) {
        focusApp();
        if (target.webContents.isFocused()) fail();
      }
    },
    protect(page: WebContents, blocked: () => boolean) {
      const focus = () => {
        if (blocked()) {
          focusApp();
          if (page.isFocused()) fail();
        }
      };
      page.on('focus', focus);
      return () => page.off('focus', focus);
    },
    hide() {
      target = undefined;
      shield?.setVisible(false);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      target = undefined;
      if (shield && !window.isDestroyed()) window.contentView.removeChildView(shield);
      // Captured reference: Electron may clear view.webContents after destruction.
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    },
  };
}
