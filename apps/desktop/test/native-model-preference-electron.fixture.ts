import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import { nativeModelPreferences } from '../electron/model-preference';
import { registerNativeModelPreferenceIpc } from '../electron/native-ipc';
import { createNativeRootWindow } from '../electron/native-root-window';

const url = process.argv.find((value) => value.startsWith('--fixture-url='))!.slice(14);
void app.whenReady().then(async () => {
  const window = createNativeRootWindow({
    width: 900,
    height: 600,
    title: '模型记忆退出恢复验证',
    webPreferences: {
      preload: join(app.getAppPath(), 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  registerNativeModelPreferenceIpc({
    ipcMain,
    window: () => window,
    rendererUrl: url,
    preferences: () => nativeModelPreferences(join(app.getPath('userData'), 'model-preferences')),
  });
  await window.loadURL(url);
});
app.on('window-all-closed', () => app.quit());
