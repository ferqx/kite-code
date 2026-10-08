import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';

const [candidate, home, control] = process.argv.slice(2) as [string, string, string];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, childPid: number | undefined;
const locks = async () => await (await fetch(`${control}/locks`)).json();
async function until(read: () => Promise<boolean>, milliseconds: number, message: string) {
  const deadline = Date.now() + milliseconds;
  while (!(await read())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.locator('.session-header').waitFor();
  const children = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app!.process().pid &&
        parts.slice(2).join(' ') === join(candidate, 'terminal/runtime/bun'),
    );
  assert.equal(children.length, 1);
  childPid = Number(children[0]![0]);
  const count = await (await fetch(`${control}/count`)).text();
  assert.deepEqual(await locks(), { outer: true, inner: true });
  const draft = page.getByRole('textbox', { name: '新对话草稿', exact: true });
  await draft.fill('关闭和退出仍保留原草稿\n雪🙂');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    false,
  );
  process.kill(childPid, 0);
  await app.evaluate(({ app }) => {
    app.emit('activate');
  });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    true,
  );
  assert.equal(await draft.inputValue(), '关闭和退出仍保留原草稿\n雪🙂');

  await app.evaluate(({ dialog }) => {
    Object.assign(globalThis, { ownedQuitPrompts: [] });
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { buttons: string[]; defaultId: number; cancelId: number };
      (Reflect.get(globalThis, 'ownedQuitPrompts') as unknown[]).push(options);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  process.kill(childPid, 'SIGSTOP');
  const inspectionStart = Date.now();
  await app.evaluate(({ app }) => app.quit());
  await until(
    () =>
      app!.evaluate(() => (Reflect.get(globalThis, 'ownedQuitPrompts') as unknown[]).length === 1),
    10000,
    'unknown quit inspection did not reach its confirmation',
  );
  assert.ok(Date.now() - inspectionStart >= 1800);
  const prompt = await app.evaluate(
    () =>
      (
        Reflect.get(globalThis, 'ownedQuitPrompts') as {
          buttons: string[];
          defaultId: number;
          cancelId: number;
        }[]
      )[0]!,
  );
  assert.deepEqual(prompt.buttons, ['保留服务', '退出']);
  assert.equal(prompt.defaultId, 0);
  assert.equal(prompt.cancelId, 0);
  process.kill(childPid, 'SIGCONT');
  await until(
    () =>
      page.evaluate(async () => {
        try {
          await window.kiteNative!.request({ method: 'state', generation: 1 });
          return true;
        } catch {
          return false;
        }
      }),
    10000,
    'cancelled quit did not preserve the original caller',
  );
  assert.equal(await draft.inputValue(), '关闭和退出仍保留原草稿\n雪🙂');
  assert.deepEqual(await locks(), { outer: true, inner: true });
  console.log(
    'native_quit_stage: original close/activate, bounded unknown inspection, default retention and exact draft',
  );

  // Withhold only the owned Node adapter's completion notification. The production
  // candidate and Service stay unchanged; this is a finite lifecycle-port fault.
  await app.evaluate(({ dialog }, pid) => {
    type Child = { pid?: number; emit(event: string | symbol, ...args: unknown[]): boolean };
    const children = (process as unknown as { _getActiveHandles(): Child[] })._getActiveHandles();
    const owned = children.find((child) => child.pid === pid);
    if (!owned) throw Error('owned_paired_child_unavailable');
    const original = owned.emit;
    owned.emit = function (event, ...args) {
      if (event === 'close') {
        Reflect.set(globalThis, 'ownedCompletionWithheld', true);
        return true;
      }
      return original.call(this, event, ...args);
    };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      Reflect.set(globalThis, 'ownedSettlementWarning', args.at(-1));
      return await new Promise((resolve) =>
        Reflect.set(globalThis, 'ownedConfirmForce', () =>
          resolve({ response: 0, checkboxChecked: false }),
        ),
      );
    }) as typeof dialog.showMessageBox;
  }, childPid);
  const settlementStart = Date.now();
  await app.evaluate(({ app }) => app.quit());
  await until(
    () => app!.evaluate(() => !!Reflect.get(globalThis, 'ownedSettlementWarning')),
    30000,
    'original 20-second settlement warning did not appear',
  );
  assert.ok(Date.now() - settlementStart >= 19800);
  const warning = await app.evaluate(() => ({
    options: Reflect.get(globalThis, 'ownedSettlementWarning') as {
      title: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
    },
    withheld: Reflect.get(globalThis, 'ownedCompletionWithheld'),
  }));
  assert.equal(warning.withheld, true);
  assert.equal(warning.options.title, '服务仍在收尾');
  assert.deepEqual(warning.options.buttons, ['强制退出', '继续等待']);
  assert.equal(warning.options.defaultId, 1);
  assert.equal(warning.options.cancelId, 1);
  assert.deepEqual(await locks(), { outer: true, inner: true });
  const exit = new Promise<number | null>((resolve) => app!.process().once('exit', resolve));
  await app.evaluate(() => {
    setTimeout(() => (Reflect.get(globalThis, 'ownedConfirmForce') as () => void)(), 0);
  });
  assert.equal(await exit, 1);
  app = undefined;
  assert.throws(() => process.kill(childPid!, 0));
  childPid = undefined;
  await until(
    async () => {
      const state = (await locks()) as { outer: boolean; inner: boolean };
      return !state.outer && !state.inner;
    },
    5000,
    'forced Main exit did not release owned candidate leases',
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), count);
  console.log(
    'native_quit_stage: actual 20-second Main warning, explicit force port, exit=1, owned Service terminal, both leases free and zero Model replay',
  );
  app = await _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    timeout: 10000,
  });
  const failedPage = await app.firstWindow();
  failedPage.setDefaultTimeout(10000);
  await failedPage.locator('.session-header').waitFor();
  const failedChildren = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === app!.process().pid &&
        parts.slice(2).join(' ') === join(candidate, 'terminal/runtime/bun'),
    );
  assert.equal(failedChildren.length, 1);
  childPid = Number(failedChildren[0]![0]);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string };
      if (options.title !== '服务收尾未正常完成') return { response: 1, checkboxChecked: false };
      Reflect.set(globalThis, 'ownedFailedWarning', options);
      return await new Promise((resolve) =>
        Reflect.set(globalThis, 'ownedConfirmFailedExit', () =>
          resolve({ response: 0, checkboxChecked: false }),
        ),
      );
    }) as typeof dialog.showMessageBox;
  });
  process.kill(childPid, 'SIGKILL');
  await app.evaluate(({ app }) => app.quit());
  await until(
    () => app!.evaluate(() => !!Reflect.get(globalThis, 'ownedFailedWarning')),
    10000,
    'nonzero Service exit was incorrectly treated as clean',
  );
  const failedWarning = await app.evaluate(
    () =>
      Reflect.get(globalThis, 'ownedFailedWarning') as {
        buttons: string[];
        defaultId: number;
        cancelId: number;
      },
  );
  assert.deepEqual(failedWarning.buttons, ['退出应用']);
  assert.equal(failedWarning.defaultId, 0);
  assert.equal(failedWarning.cancelId, 0);
  assert.deepEqual(await locks(), { outer: true, inner: true });
  const failedExit = new Promise<number | null>((resolve) => app!.process().once('exit', resolve));
  await app.evaluate(() => {
    setTimeout(() => (Reflect.get(globalThis, 'ownedConfirmFailedExit') as () => void)(), 0);
  });
  assert.equal(await failedExit, 1);
  app = undefined;
  assert.throws(() => process.kill(childPid!, 0));
  childPid = undefined;
  await until(
    async () => {
      const state = (await locks()) as { outer: boolean; inner: boolean };
      return !state.outer && !state.inner;
    },
    5000,
    'failed cleanup exit did not release owned leases',
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), count);
  console.log(
    'native_quit_stage: actual nonzero Service exit, truthful failed-cleanup warning, explicit exit=1, both leases free and zero Model replay',
  );
} finally {
  if (childPid) {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  }
  if (app) {
    const owned = app;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owned.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            owned.process().kill('SIGKILL');
            resolve();
          }, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
