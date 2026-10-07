import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeState } from '../../../apps/desktop/src/native-bridge';

// Finite harness facade: the runtime remains the installed workspace Playwright, not a test implementation.
interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  waitFor(): Promise<void>;
}
interface Page {
  setDefaultTimeout(value: number): void;
  getByRole(role: string, options: { name: string; exact?: boolean }): Locator;
  getByText(text: string, options: { exact: boolean }): Locator;
  evaluate<T>(fn: () => Promise<T>): Promise<T>;
}
interface ElectronApp {
  process(): import('node:child_process').ChildProcess;
  firstWindow(): Promise<Page>;
  evaluate<T>(
    fn: (input: {
      app: { quit(): void; commandLine: { hasSwitch(name: string): boolean } };
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
const { _electron } = createRequire(process.argv[6]!)('playwright') as {
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
const [launcher, home, control, storeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const displayEnvironment: Record<string, string> =
  process.platform === 'linux'
    ? { DISPLAY: process.env.DISPLAY ?? '', XAUTHORITY: process.env.XAUTHORITY ?? '' }
    : {};
const security = async (current: ElectronApp) => {
  const actual = await current.evaluate(({ app, BrowserWindow }) => ({
    sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'),
    windows: BrowserWindow.getAllWindows().map((window) => {
      const options = window.webContents.getLastWebPreferences();
      return {
        sandbox: options.sandbox,
        contextIsolation: options.contextIsolation,
        nodeIntegration: options.nodeIntegration,
      };
    }),
  }));
  assert.deepEqual(actual, {
    sandboxDisabled: false,
    windows: [{ sandbox: true, contextIsolation: true, nodeIntegration: false }],
  });
};
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
const driverStarted = Date.now();
const diagnostic = (phase: string, detail: Record<string, unknown> = {}) => {
  const resources: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) resources[kind] = (resources[kind] ?? 0) + 1;
  console.log(
    JSON.stringify({
      stage: 'native_install_driver',
      phase,
      elapsedMs: Date.now() - driverStarted,
      resources,
      ...detail,
    }),
  );
};
process.on('SIGTERM', () => {
  diagnostic('sigterm', { appHeld: Boolean(app), childHeld: childPid !== undefined });
  if (childPid) {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  }
  if (app) {
    try {
      app.process().kill('SIGKILL');
    } catch {}
  }
  process.exitCode = 1;
});
const query = async (path: string) => {
  const started = Date.now();
  diagnostic('query_begin', { path });
  try {
    return (await (await fetch(`${control}/${path}`)).json()) as Record<string, unknown>;
  } finally {
    diagnostic('query_end', { path, durationMs: Date.now() - started });
  }
};
try {
  diagnostic('first_launch_begin');
  app = await _electron.launch({
    executablePath: launcher,
    args: [`--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: {
      ...displayEnvironment,
      HOME: home,
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      NODE_PATH: '/must-not-resolve',
      NODE_OPTIONS: '--must-never-load',
      BUN_OPTIONS: '--must-never-load',
      ELECTRON_RUN_AS_NODE: '1',
    },
    timeout: 10000,
    chromiumSandbox: true,
  });
  diagnostic('first_launch_ready');
  const page = await app.firstWindow();
  await security(app);
  page.setDefaultTimeout(10000);
  await page.getByRole('button', { name: 'Native installed', exact: true }).click();
  const state = await page.evaluate(
    async () => await window.kiteNative!.request({ method: 'state', generation: 1 }),
  );
  assert.equal((state as NativeState).selection?.storeId, storeId);
  const processColumn = process.platform === 'linux' ? 'args=' : 'comm=';
  const ps = String(execFileSync('/bin/ps', ['-axo', `pid=,ppid=,${processColumn}`]))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app!.process().pid &&
        (process.platform === 'linux' ? parts[2]! : parts.slice(2).join(' ')).endsWith(
          '/terminal/runtime/bun',
        ),
    );
  assert.equal(ps.length, 1);
  childPid = Number(ps[0]![0]);
  assert.deepEqual(await query('locks'), { outer: true, inner: true });
  assert.equal((await query('uninstall')).blocked, true);
  await page.getByRole('textbox', { name: '当前会话私有草稿' }).fill('real installed Native task');
  await page.getByRole('button', { name: '发送明确的新轮次' }).click();
  await page.getByText('轮次：completed', { exact: true }).waitFor();
  assert.equal((await query('count')).providerCalls, 1);
  const upgraded = await query('upgrade');
  assert.equal(upgraded.previousCandidateId, (await query('identity')).firstId);
  assert.deepEqual(await query('locks'), { outer: true, inner: true });
  assert.equal((await query('uninstall')).blocked, true);
  const pid = childPid!;
  diagnostic('first_normal_close_begin');
  await app.evaluate(({ app }) => app.quit());
  await app.close();
  diagnostic('first_normal_close_complete');
  app = undefined;
  assert.throws(() => process.kill(pid, 0));
  childPid = undefined;
  assert.deepEqual(await query('locks'), { outer: false, inner: false });
  const second = await _electron.launch({
    executablePath: launcher,
    args: [`--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { ...displayEnvironment, HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
    chromiumSandbox: true,
  });
  diagnostic('second_launch_ready');
  app = second;
  second.process().once('exit', (code, signal) => diagnostic('second_main_exit', { code, signal }));
  second
    .process()
    .once('close', (code, signal) => diagnostic('second_main_close', { code, signal }));
  const cold = await second.firstWindow();
  await security(second);
  cold.setDefaultTimeout(10000);
  await cold.getByRole('button', { name: 'Native installed', exact: true }).click();
  await cold.getByText('Native installed complete', { exact: true }).waitFor();
  assert.equal((await query('count')).providerCalls, 1);
  assert.equal((await query('uninstall')).blocked, true);
  const secondChildren = String(execFileSync('/bin/ps', ['-axo', `pid=,ppid=,${processColumn}`]))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === second.process().pid &&
        (process.platform === 'linux' ? parts[2]! : parts.slice(2).join(' ')).endsWith(
          '/terminal/runtime/bun',
        ),
    );
  assert.equal(secondChildren.length, 1);
  childPid = Number(secondChildren[0]![0]);
  process.kill(childPid, 'SIGSTOP');
  const exited = new Promise<void>((resolve) => second.process().once('exit', () => resolve()));
  second.process().kill('SIGKILL');
  await exited;
  diagnostic('second_main_exit_awaited');
  app = undefined;
  assert.deepEqual(await query('current-locks'), { outer: true, inner: true });
  assert.equal((await query('uninstall')).blocked, true);
  process.kill(childPid, 'SIGKILL');
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const locks = await query('current-locks');
    if (!locks.outer && !locks.inner) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await query('current-locks'), { outer: false, inner: false });
  diagnostic('second_service_locks_released');
  childPid = undefined;
  const rolled = await query('rollback');
  assert.equal(rolled.candidateId, (await query('identity')).firstId);
  assert.equal((await query('uninstall')).removed, true);
  diagnostic('before_success');
  console.log(
    JSON.stringify({
      actualMain: true,
      chromiumSandbox: true,
      normalClose: true,
      upgradeOriginalMainUnaffected: true,
      coldSecondZeroProvider: true,
      rollbackPointerOnly: true,
      mainKilledChildRetainsBothUntilOwnedKill: true,
      providerCalls: 1,
      uninstallAfterAllClosed: true,
    }),
  );
  diagnostic('after_success');
} finally {
  diagnostic('finally_begin', { appHeld: Boolean(app), childHeld: childPid !== undefined });
  if (childPid) {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  }
  if (app) {
    const current = app;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            current.process().kill('SIGKILL');
            resolve();
          }, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  diagnostic('finally_complete', { appHeld: Boolean(app), childHeld: childPid !== undefined });
}
