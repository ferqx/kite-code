import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';
import { promptText } from './prompt-editor-text.fixture';

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
  assert.equal(await promptText(draft), '关闭和退出仍保留原草稿\n雪🙂');

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
  assert.equal(await promptText(draft), '关闭和退出仍保留原草稿\n雪🙂');
  assert.deepEqual(await locks(), { outer: true, inner: true });
  console.log(
    'native_quit_stage: original close/activate, bounded unknown inspection, default retention and exact draft',
  );

  // Faults stay inside the owned fixture process: production candidate and Service
  // bytes remain unchanged. Record dialog, window and Service close order across
  // Main exit; SIGSTOP alone holds the real owned Service cleanup in progress.
  let quitEvents = '';
  app.process().stdout!.on('data', (chunk: Buffer) => {
    quitEvents += chunk.toString();
  });
  await app.evaluate(({ dialog, BrowserWindow }, pid) => {
    const record = (event: string, options?: unknown) => {
      process.stdout.write(
        `owned_quit_event:${JSON.stringify({ event, at: Date.now(), options })}\n`,
      );
    };
    type Child = { pid?: number; once(event: string, callback: () => void): void };
    const children = (process as unknown as { _getActiveHandles(): Child[] })._getActiveHandles();
    const owned = children.find((child) => child.pid === pid);
    if (!owned) throw Error('owned_paired_child_unavailable');
    owned.once('close', () => record('service-closed'));
    BrowserWindow.getAllWindows()[0]!.once('closed', () => record('window-closed'));
    Reflect.set(globalThis, 'ownedRecordQuitEvent', record);
    Reflect.set(globalThis, 'ownedQuitPromptCount', 0);
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { buttons: string[] };
      record('prompt', options);
      Reflect.set(
        globalThis,
        'ownedQuitPromptCount',
        Number(Reflect.get(globalThis, 'ownedQuitPromptCount')) + 1,
      );
      return await new Promise((resolve) =>
        Reflect.set(globalThis, 'ownedConfirmQuit', () => {
          record('confirmed');
          resolve({ response: 1, checkboxChecked: false });
        }),
      );
    }) as typeof dialog.showMessageBox;
  }, childPid);
  process.kill(childPid, 'SIGSTOP');
  await app.evaluate(({ app }) => app.quit());
  await until(
    () => app!.evaluate(() => Number(Reflect.get(globalThis, 'ownedQuitPromptCount')) === 1),
    10000,
    'unknown Service state did not request its single quit confirmation',
  );
  await app.evaluate(({ app }) => {
    app.quit();
    app.quit();
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await app.evaluate(() => Reflect.get(globalThis, 'ownedQuitPromptCount')), 1);
  assert.deepEqual(await locks(), { outer: true, inner: true });
  const quitProcess = app.process();
  const exit = new Promise<number | null>((resolve) => quitProcess.once('close', resolve));
  await app.evaluate(() => {
    (Reflect.get(globalThis, 'ownedConfirmQuit') as () => void)();
  });
  const committedAt = Date.now();
  await until(
    () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 0),
    1000,
    'confirmed quit did not immediately destroy the application window',
  );
  await until(async () => page.isClosed(), 1000, 'confirmed quit did not close its renderer');
  assert.ok(Date.now() - committedAt < 1000, 'confirmed quit kept UI visible for one second');
  assert.equal(await app.evaluate(({ app }) => app.dock?.isVisible() ?? false), false);
  process.kill(quitProcess.pid!, 0);
  process.kill(childPid, 0);
  assert.deepEqual(await locks(), { outer: true, inner: true });
  await app.evaluate(({ app }) => {
    app.quit();
    app.emit('activate');
    app.quit();
  });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  assert.equal(await app.evaluate(() => Reflect.get(globalThis, 'ownedQuitPromptCount')), 1);
  // Cross the former 20-second force deadline with the real Service still stopped.
  // Main must own the leases in the background while every application window is gone.
  const resumeAfter = committedAt + 20500;
  while (Date.now() < resumeAfter) {
    assert.equal(quitProcess.exitCode, null, 'background cleanup force-exited at its old deadline');
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, resumeAfter - Date.now())));
  }
  process.kill(quitProcess.pid!, 0);
  process.kill(childPid, 0);
  assert.deepEqual(await locks(), { outer: true, inner: true });
  await app.evaluate(({ app }) => {
    app.emit('activate');
    app.quit();
  });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  assert.equal(await app.evaluate(() => Reflect.get(globalThis, 'ownedQuitPromptCount')), 1);
  await app.evaluate(() => {
    (Reflect.get(globalThis, 'ownedRecordQuitEvent') as (event: string) => void)(
      'service-resuming',
    );
  });
  process.kill(childPid, 'SIGCONT');
  assert.equal(await exit, 0);
  app = undefined;
  const events = quitEvents
    .split('\n')
    .filter((line) => line.startsWith('owned_quit_event:'))
    .map(
      (line) =>
        JSON.parse(line.slice('owned_quit_event:'.length)) as {
          event: string;
          at: number;
          options?: { buttons: string[]; defaultId: number; cancelId: number };
        },
    );
  assert.deepEqual(
    events.map(({ event }) => event),
    ['prompt', 'confirmed', 'window-closed', 'service-resuming', 'service-closed'],
  );
  assert.deepEqual(events[0]!.options!.buttons, ['保留服务', '退出']);
  assert.equal(events[0]!.options!.defaultId, 0);
  assert.equal(events[0]!.options!.cancelId, 0);
  assert.ok(
    events[2]!.at - events[1]!.at < 1000,
    'window did not close immediately after confirmation',
  );
  assert.ok(
    events[3]!.at - events[1]!.at >= 20500,
    'Service was resumed before the old force deadline',
  );
  assert.throws(() => process.kill(childPid!, 0));
  childPid = undefined;
  await until(
    async () => {
      const state = (await locks()) as { outer: boolean; inner: boolean };
      return !state.outer && !state.inner;
    },
    5000,
    'natural background cleanup did not release owned candidate leases',
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), count);
  console.log(
    'native_quit_stage: confirmed window closes immediately, one prompt despite repeats/activate, stopped Service owned beyond 20 seconds, natural background exit=0, both leases free and zero Model replay',
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
  let failedEvents = '';
  app.process().stdout!.on('data', (chunk: Buffer) => {
    failedEvents += chunk.toString();
  });
  await app.evaluate(({ dialog, BrowserWindow }, pid) => {
    BrowserWindow.getAllWindows()[0]!.once('closed', () => {
      process.stdout.write('owned_failed_window_closed\n');
    });
    type Child = { pid?: number; once(event: string, callback: () => void): void };
    const owned = (process as unknown as { _getActiveHandles(): Child[] })
      ._getActiveHandles()
      .find((child) => child.pid === pid);
    if (!owned) throw Error('owned_paired_child_unavailable');
    owned.once('close', () => {
      process.stdout.write('owned_failed_service_closed\n');
    });
    dialog.showMessageBox = (async (...args: unknown[]) => {
      process.stdout.write(`owned_failed_prompt:${JSON.stringify(args.at(-1))}\n`);
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, childPid);
  process.kill(childPid, 'SIGKILL');
  await until(
    async () => failedEvents.includes('owned_failed_service_closed'),
    5000,
    'nonzero Service exit was not observed before quit',
  );
  const failedExit = new Promise<number | null>((resolve) => app!.process().once('close', resolve));
  // Schedule quit after the evaluate reply, as failed cleanup may exit immediately.
  await app.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0);
  });
  assert.equal(await failedExit, 1);
  app = undefined;
  const failedPrompts = failedEvents
    .split('\n')
    .filter((line) => line.startsWith('owned_failed_prompt:'))
    .map((line) => JSON.parse(line.slice('owned_failed_prompt:'.length)) as { buttons: string[] });
  assert.ok(
    failedEvents.includes('owned_failed_window_closed'),
    'failed Service quit did not destroy its window',
  );
  assert.ok(failedPrompts.length <= 1, 'failed Service quit displayed repeated dialogs');
  for (const options of failedPrompts) assert.deepEqual(options.buttons, ['保留服务', '退出']);
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
    'native_quit_stage: actual nonzero Service exit, automatic exit=1, at most one initial prompt and no cleanup warning, both leases free and zero Model replay',
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
