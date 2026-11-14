import { contextBridge, ipcRenderer } from 'electron';

// Test-only entrypoint, never included in the application.
contextBridge.exposeInMainWorld('readonlyFixture', {
  request: (request: unknown) => ipcRenderer.invoke('readonly-fixture-request', request),
});
