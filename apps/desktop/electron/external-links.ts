import { type BrowserWindow, dialog, shell } from 'electron';

/** Hand web links to the OS without allowing a new privileged app window. */
export function registerNativeExternalLinks(window: BrowserWindow, rendererUrl: string): void {
  const current = () =>
    !window.isDestroyed() && window.webContents.mainFrame.url.split('#')[0] === rendererUrl;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!current() || url.length > 8192 || !/^https?:\/\//i.test(url)) return { action: 'deny' };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (!target.hostname || target.username || target.password) return { action: 'deny' };
    setImmediate(() => {
      if (!current()) return;
      void shell.openExternal(target.href).catch(() => {
        if (current())
          dialog.showErrorBox('无法打开链接', '无法打开浏览器，请检查系统默认浏览器设置后重试。');
      });
    });
    return { action: 'deny' };
  });
}
