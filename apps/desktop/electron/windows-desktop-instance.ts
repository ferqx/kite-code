import type { App } from 'electron';

/** Hold the Electron instance lock until process exit, including during Service drain. */
export function registerWindowsDesktopInstance(
  app: Pick<App, 'requestSingleInstanceLock' | 'on' | 'exit'>,
  activate: () => void,
): void {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on('second-instance', activate);
}
