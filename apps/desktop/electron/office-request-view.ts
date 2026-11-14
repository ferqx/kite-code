import { randomUUID } from 'node:crypto';
import { session, WebContentsView } from 'electron';
import type { OfficeRequestOutcome } from '../src/output-files-bridge';
import { addNativeWindowView, focusNativeWindowContent } from './native-overlay-layer';
import type { NativeRootWindow } from './native-root-window';
import {
  officeRequestHtml,
  officeRequestInstallScript,
  officeRequestReadScript,
  officeRequestSettleScript,
  officeRequestWorld,
} from './office-request-input';

type Bounds = { x: number; y: number; width: number; height: number };
export type OfficeRequestAnchor = { x: number; y: number; width: number; height: number };
/** Separate trusted DOM: the Office page cannot read, edit or submit this input. */
export class NativeOfficeRequestView {
  private view?: WebContentsView;
  private closed = false;
  private shown = true;
  private ready = false;
  private readonly window: NativeRootWindow;
  private anchor: OfficeRequestAnchor;
  constructor(window: NativeRootWindow, anchor: OfficeRequestAnchor) {
    this.window = window;
    this.anchor = anchor;
  }
  async open(bounds: Bounds, label: string) {
    const isolated = session.fromPartition(`kite-office-request-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_c, _p, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith('data:text/html,') }),
    );
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    this.view = view;
    view.setVisible(false);
    view.setBackgroundColor('#00000000');
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    view.webContents.on('will-redirect', (event) => event.preventDefault());
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    addNativeWindowView(this.window, view);
    this.bounds(bounds);
    await view.webContents.loadURL(`data:text/html,${encodeURIComponent(officeRequestHtml)}`);
    if (this.closed || this.view !== view) throw Error('preview_replaced');
    await view.webContents.executeJavaScriptInIsolatedWorld(officeRequestWorld, [
      { code: officeRequestInstallScript(label) },
    ]);
    if (this.closed || this.view !== view) throw Error('preview_replaced');
    this.ready = true;
    this.visible(this.shown);
    if (this.shown && this.window.isFocused())
      focusNativeWindowContent(this.window, view.webContents);
  }
  visible(shown: boolean) {
    this.shown = shown;
    if (!this.closed && this.view && !this.view.webContents.isDestroyed())
      this.view.setVisible(shown && this.ready);
  }
  bounds(bounds: Bounds, anchor?: OfficeRequestAnchor) {
    if (anchor) this.anchor = { ...anchor };
    const width = Math.max(1, Math.min(420, bounds.width));
    const height = Math.max(1, Math.min(194, bounds.height));
    const x = Math.max(0, Math.min(bounds.width - width, this.anchor.x));
    const below = this.anchor.y + this.anchor.height + 6;
    const y = Math.max(
      0,
      Math.min(
        bounds.height - height,
        below + height <= bounds.height ? below : this.anchor.y - height - 6,
      ),
    );
    this.view?.setBounds({
      x: bounds.x + Math.round(x),
      y: bounds.y + Math.round(y),
      width,
      height,
    });
  }
  async read(): Promise<{ cancelled: boolean; pending?: { serial: number; prompt: string } }> {
    if (!this.view || this.closed) return { cancelled: true };
    return this.view.webContents.executeJavaScriptInIsolatedWorld(officeRequestWorld, [
      { code: officeRequestReadScript },
    ]);
  }
  async settle(serial: number, outcome: OfficeRequestOutcome) {
    if (!this.view || this.closed) return;
    await this.view.webContents.executeJavaScriptInIsolatedWorld(officeRequestWorld, [
      { code: officeRequestSettleScript(serial, outcome) },
    ]);
  }
  close() {
    this.closed = true;
    const view = this.view;
    this.view = undefined;
    if (!view) return;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
}
