import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeState } from '../../../apps/desktop/src/native-bridge';

interface Locator {
  click(): Promise<void>;
  waitFor(): Promise<void>;
}
interface Page {
  bringToFront(): Promise<void>;
  setDefaultTimeout(value: number): void;
  getByRole(role: string, options: { name: string; exact?: boolean }): Locator;
  getByText(text: string, options: { exact: boolean }): Locator;
  reload(): Promise<void>;
  evaluate<T>(fn: () => Promise<T>): Promise<T>;
}
interface ElectronApp {
  process(): import('node:child_process').ChildProcess;
  firstWindow(): Promise<Page>;
  evaluate<T>(
    fn: (input: {
      app: { commandLine: { hasSwitch(name: string): boolean } };
      BrowserWindow: {
        getAllWindows(): {
          webContents: {
            getLastWebPreferences(): {
              sandbox?: boolean;
              contextIsolation?: boolean;
              nodeIntegration?: boolean;
            };
          };
        }[];
      };
    }) => T,
  ): Promise<T>;
  close(): Promise<void>;
}
const [launcher, home, control, originalStoreId, dependencies] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
const { _electron } = createRequire(dependencies)('playwright') as {
  _electron: {
    launch(input: {
      executablePath: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      timeout: number;
      chromiumSandbox: boolean;
    }): Promise<ElectronApp>;
  };
};
const query = async (path: string, body?: unknown) => {
  const response = await fetch(new URL(path, control), {
    ...(body !== undefined
      ? {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }
      : {}),
  });
  assert.equal(response.ok, true);
  return response.json();
};
let app: ElectronApp | undefined, servicePid: number | undefined, page: Page | undefined;
const children = () =>
  String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app!.process().pid &&
        parts.slice(2).join(' ').endsWith('/terminal/runtime/bun'),
    );
process.on('SIGTERM', () => {
  if (servicePid) {
    try {
      process.kill(servicePid, 'SIGKILL');
    } catch {}
  }
  if (app) app.process().kill('SIGKILL');
  process.exitCode = 1;
});
try {
  app = await _electron.launch({
    executablePath: launcher,
    args: [`--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  await page.bringToFront();
  page.setDefaultTimeout(10000);
  assert.deepEqual(
    await app.evaluate(({ app, BrowserWindow }) => ({
      disabled: app.commandLine.hasSwitch('no-sandbox'),
      windows: BrowserWindow.getAllWindows().map((window) => {
        const prefs = window.webContents.getLastWebPreferences();
        return {
          sandbox: prefs.sandbox,
          contextIsolation: prefs.contextIsolation,
          nodeIntegration: prefs.nodeIntegration,
        };
      }),
    })),
    {
      disabled: false,
      windows: [{ sandbox: true, contextIsolation: true, nodeIntegration: false }],
    },
  );
  // Store failure leaves the diagnostic Service without the PC's required business capabilities.
  await page.getByText('启动未完成：required_capability_missing', { exact: true }).waitFor();
  assert.equal(children().length, 0);
  const held = await query('snapshot');
  assert.equal(held.profileExists, false);
  assert.equal(held.coreExists, false);
  const killed = await query('kill', {});
  assert.deepEqual(killed.lockIdentity, held.lockIdentity);
  const rejection = await page.evaluate(async () => {
    try {
      await window.kiteNative!.request({ method: 'attach' });
      return 'unexpected_attach';
    } catch (error) {
      return (error as Error).message;
    }
  });
  assert.equal(rejection, 'required_capability_missing');
  assert.equal(children().length, 0);
  const blocked = await query('snapshot');
  assert.equal(blocked.profileExists, false);
  assert.equal(blocked.coreExists, false);
  assert.deepEqual(blocked.lockIdentity, held.lockIdentity);
  const restored = await query('reconcile', {
    restoreId: killed.journal.restoreId,
    digest: killed.digest,
    decision: 'complete',
  });
  assert.notEqual(restored.storeId, originalStoreId);
  assert.deepEqual(restored.lockIdentity, held.lockIdentity);
  await page.reload();
  await page.getByRole('button', { name: 'Original backup session', exact: true }).click();
  const state = (await page.evaluate(
    async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
  )) as NativeState;
  assert.equal(state.selection?.storeId, restored.storeId);
  assert.equal(state.selection?.session.id, 's');
  assert.equal(state.selection?.session.title, 'Original backup session');
  const live = children();
  assert.equal(live.length, 1);
  servicePid = Number(live[0]![0]);
  await app.close();
  app = undefined;
  assert.throws(() => process.kill(servicePid!, 0));
  console.log(
    JSON.stringify({
      phase: 'installed_native_restore_interruption',
      servicePid,
      newStoreId: restored.storeId,
      sameLock: held.lockIdentity,
    }),
  );
  servicePid = undefined;
} catch (cause) {
  if (page)
    try {
      console.error(
        JSON.stringify({
          phase: 'installed_native_restore_failure',
          startup: await page.evaluate(async () => ({
            text: document
              .querySelector('main[aria-label="kite 启动页"]')
              ?.textContent?.slice(0, 300),
            readyState: document.readyState,
            focused: document.hasFocus(),
          })),
        }),
      );
    } catch {}
  throw cause;
} finally {
  if (app) await app.close();
}
