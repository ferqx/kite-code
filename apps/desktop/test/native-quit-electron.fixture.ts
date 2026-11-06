import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { _electron } from 'playwright';
import { loopbackModelEnvironment } from '../../../tests/fixtures/loopback-model-environment';
import { nativeRootPage } from './native-root-page.fixture';
import { promptText } from './prompt-editor-text.fixture';

const [candidate, home, control] = process.argv.slice(2) as [string, string, string];
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let child: { pid: number; identity: string } | undefined;
const locks = async () => await (await fetch(`${control}/locks`)).json();
const stage = (name: string, facts: unknown) =>
  console.log(`native_quit_stage:${JSON.stringify({ stage: name, at: Date.now(), facts })}`);
const remaining = (start: number) => Math.max(0, start + 5000 - Date.now());
async function exitWithin(pending: Promise<number | null>, start: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('quit_exceeded_five_seconds')), remaining(start));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const dead = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
const candidateProcesses = () =>
  String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.slice(2).join(' ').startsWith(`${candidate}/`))
    .map((parts) => ({
      pid: Number(parts[0]),
      ppid: Number(parts[1]),
      command: parts.slice(2).join(' '),
    }));
const identity = (pid: number) =>
  String(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart=,comm='])).trim();
function ownedChild(mainPid: number) {
  const children = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) =>
        Number(parts[1]) === mainPid &&
        parts.slice(2).join(' ') === join(candidate, 'terminal/runtime/bun'),
    );
  assert.equal(children.length, 1);
  const pid = Number(children[0]![0]);
  return { pid, identity: identity(pid) };
}
function signalOwned(signal: NodeJS.Signals) {
  if (!child || identity(child.pid) !== child.identity) throw Error('quit_child_identity_changed');
  process.kill(child.pid, signal);
}
async function until(read: () => Promise<boolean>, milliseconds: number, message: string) {
  const deadline = Date.now() + milliseconds;
  while (!(await read())) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function launch() {
  return _electron.launch({
    executablePath: join(candidate, 'electron/Electron.app/Contents/MacOS/Electron'),
    args: [join(candidate, 'app'), `--user-data-dir=${join(home, 'electron-data')}`],
    cwd: home,
    env: {
      HOME: home,
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      ...loopbackModelEnvironment(new URL(control)),
    },
    timeout: 10000,
  });
}
try {
  app = await launch();
  const page = await nativeRootPage(app, 10000);
  page.setDefaultTimeout(10000);
  await page.locator('.session-header').waitFor();
  child = ownedChild(app.process().pid!);
  const count = await (await fetch(`${control}/count`)).text();
  assert.deepEqual(await locks(), { outer: true, inner: true });
  const draft = page.getByRole('textbox', { name: '新对话草稿', exact: true });
  await draft.fill('关闭和退出仍保留原草稿\n雪🙂');
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.close());
  assert.equal(
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isVisible()),
    false,
  );
  signalOwned('SIGCONT');
  await app.evaluate(({ app }) => app.emit('activate'));
  assert.equal(
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isVisible()),
    true,
  );
  assert.equal(await promptText(draft), '关闭和退出仍保留原草稿\n雪🙂');
  stage('ordinary-close-activate', {
    main: app.process().pid,
    child,
    locks: await locks(),
    visible: true,
  });

  let quitEvents = '';
  app.process().stdout!.on('data', (chunk: Buffer) => {
    quitEvents += chunk.toString();
  });
  await app.evaluate(({ dialog, BaseWindow }, pid) => {
    const record = (event: string, facts?: unknown) =>
      process
        .getBuiltinModule('node:fs')
        .writeSync(1, `owned_quit_event:${JSON.stringify({ event, at: Date.now(), facts })}\n`);
    type Child = { pid?: number; once(event: string, callback: () => void): void };
    const owned = (process as unknown as { _getActiveHandles(): Child[] })
      ._getActiveHandles()
      .find((child) => child.pid === pid);
    if (!owned) throw Error('owned_paired_child_unavailable');
    Reflect.set(globalThis, 'ownedObservedPairedChild', owned);
    owned.once('close', () => record('service-closed'));
    BaseWindow.getAllWindows()[0]!.once('hide', () => record('window-hidden'));
    BaseWindow.getAllWindows()[0]!.once('closed', () => record('window-closed'));
    Reflect.set(globalThis, 'ownedRecordQuitEvent', record);
    Reflect.set(globalThis, 'ownedQuitPromptCount', 0);
    dialog.showMessageBox = (async () => {
      Reflect.set(
        globalThis,
        'ownedQuitPromptCount',
        Number(Reflect.get(globalThis, 'ownedQuitPromptCount')) + 1,
      );
      throw Error('explicit_quit_must_not_prompt');
    }) as typeof dialog.showMessageBox;
  }, child.pid);
  const stoppedProcesses = candidateProcesses();
  signalOwned('SIGSTOP');
  const quitProcess = app.process();
  const exit = new Promise<number | null>((resolve) => quitProcess.once('close', resolve));
  const committedAt = Date.now();
  const returned = await app.evaluate(({ app, BaseWindow }) => {
    const record = Reflect.get(globalThis, 'ownedRecordQuitEvent') as (
      event: string,
      facts?: unknown,
    ) => void;
    record('quit-requested', { visible: BaseWindow.getAllWindows()[0]!.isVisible() });
    app.quit();
    const facts = {
      windows: BaseWindow.getAllWindows().length,
      visible: BaseWindow.getAllWindows().some((window) => window.isVisible()),
      dock: app.dock?.isVisible() ?? false,
      prompts: Reflect.get(globalThis, 'ownedQuitPromptCount'),
    };
    record('quit-returned', facts);
    return facts;
  });
  assert.deepEqual(returned, { windows: 1, visible: false, dock: false, prompts: 0 });
  assert.equal(page.isClosed(), false, 'original renderer must remain alive for lease release');
  assert.ok(Date.now() - committedAt < 1000, 'explicit quit kept UI visible for one second');
  process.kill(quitProcess.pid!, 0);
  assert.deepEqual(await locks(), { outer: true, inner: true });
  stage('explicit-quit-returned', {
    ...returned,
    elapsedMs: Date.now() - committedAt,
    locks: await locks(),
  });

  for (const point of [0, 1000, 2500]) {
    while (Date.now() - committedAt < point)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await app.evaluate(({ app }) => {
      app.quit();
      app.emit('activate');
      app.quit();
    });
    const state: { windows: number; visible: boolean; prompts: unknown } = await app.evaluate(
      ({ BaseWindow }) => ({
        windows: BaseWindow.getAllWindows().length,
        visible: BaseWindow.getAllWindows().some((window) => window.isVisible()),
        prompts: Reflect.get(globalThis, 'ownedQuitPromptCount'),
      }),
    );
    assert.deepEqual(state, { windows: 1, visible: false, prompts: 0 });
    assert.equal(identity(child.pid), child.identity);
    assert.ok(
      String(execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'state='])).includes('T'),
    );
    assert.deepEqual(await locks(), { outer: true, inner: true });
    stage('stopped-service-deadline-pending', {
      ...state,
      elapsedMs: Date.now() - committedAt,
      serviceStillStopped: true,
      locks: await locks(),
    });
  }
  assert.equal(await exitWithin(exit, committedAt), 1);
  app = undefined;
  const mainExitedMs = Date.now() - committedAt;
  await until(
    async () => stoppedProcesses.every((process) => dead(process.pid)),
    remaining(committedAt),
    'owned Main, Service or helper survived the five-second exit budget',
  );
  child = undefined;
  await until(
    async () => {
      const state = await locks();
      return !state.outer && !state.inner;
    },
    remaining(committedAt),
    'forced exit did not release both candidate locks within five seconds',
  );
  assert.ok(Date.now() - committedAt < 5000);
  const events = quitEvents
    .split('\n')
    .filter((line) => line.startsWith('owned_quit_event:'))
    .map(
      (line) => JSON.parse(line.slice('owned_quit_event:'.length)) as { event: string; at: number },
    );
  const hidden = events.filter(({ event }) => event === 'window-hidden');
  assert.equal(hidden.length, 1);
  assert.ok(hidden[0]!.at - events[0]!.at < 1000);
  assert.equal(
    events.some(({ event }) => event === 'service-resuming'),
    false,
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), count);
  stage('stopped-service-forced-exit-complete', {
    exitCode: 1,
    mainExitedMs,
    allOwnedProcessesGoneAndLocksFreeMs: Date.now() - committedAt,
    processes: stoppedProcesses,
    locks: await locks(),
    events,
    unexpectedModelRequests: count,
  });

  app = await launch();
  const normalPage = await nativeRootPage(app, 10000);
  await normalPage.locator('.session-header').waitFor();
  await until(
    () => normalPage.getByRole('button', { name: '项目空间', exact: true }).isEnabled(),
    10000,
    'normal quit sample did not finish initial project preparation',
  );
  child = ownedChild(app.process().pid!);
  const normalProcesses = candidateProcesses();
  let normalEvents = '';
  app.process().stdout!.on('data', (chunk: Buffer) => {
    normalEvents += chunk.toString();
  });
  await app.evaluate(({ dialog, BaseWindow }, pid) => {
    const record = (event: string, facts?: unknown) =>
      process
        .getBuiltinModule('node:fs')
        .writeSync(1, `owned_quit_event:${JSON.stringify({ event, at: Date.now(), facts })}\n`);
    type Child = { pid?: number; once(event: string, callback: () => void): void };
    const owned = (process as unknown as { _getActiveHandles(): Child[] })
      ._getActiveHandles()
      .find((child) => child.pid === pid);
    if (!owned) throw Error('owned_paired_child_unavailable');
    Reflect.set(globalThis, 'ownedObservedPairedChild', owned);
    owned.once('close', () => record('service-closed'));
    BaseWindow.getAllWindows()[0]!.once('hide', () => record('window-hidden'));
    BaseWindow.getAllWindows()[0]!.once('closed', () => record('window-closed'));
    Reflect.set(globalThis, 'ownedRecordQuitEvent', record);
    Reflect.set(globalThis, 'ownedQuitPromptCount', 0);
    dialog.showMessageBox = (async () => {
      Reflect.set(
        globalThis,
        'ownedQuitPromptCount',
        Number(Reflect.get(globalThis, 'ownedQuitPromptCount')) + 1,
      );
      throw Error('explicit_quit_must_not_prompt');
    }) as typeof dialog.showMessageBox;
  }, child.pid);
  const normalExit = new Promise<number | null>((resolve) => app!.process().once('close', resolve));
  const normalCommittedAt = Date.now();
  await app.evaluate(({ app, BaseWindow }) => {
    setTimeout(() => {
      const record = Reflect.get(globalThis, 'ownedRecordQuitEvent') as (
        event: string,
        facts?: unknown,
      ) => void;
      record('quit-requested', { visible: BaseWindow.getAllWindows()[0]!.isVisible() });
      app.quit();
      record('quit-returned', {
        windows: BaseWindow.getAllWindows().length,
        visible: BaseWindow.getAllWindows().some((window) => window.isVisible()),
        dock: app.dock?.isVisible() ?? false,
        prompts: Reflect.get(globalThis, 'ownedQuitPromptCount'),
      });
    }, 0);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (app.process().exitCode === null) {
    const pending = await app.evaluate(() => {
      const owned = Reflect.get(globalThis, 'ownedObservedPairedChild') as {
        stdin: { writableEnded: boolean };
        exitCode: number | null;
        signalCode: string | null;
      };
      return {
        serviceEofRequested: owned.stdin.writableEnded,
        serviceExitCode: owned.exitCode,
        serviceSignalCode: owned.signalCode,
      };
    });
    stage('ordinary-cleanup-pending', { elapsedMs: Date.now() - normalCommittedAt, ...pending });
  }
  const normalCode = await exitWithin(normalExit, normalCommittedAt);
  stage('normal-quit-observed', {
    exitCode: normalCode,
    elapsedMs: Date.now() - normalCommittedAt,
    normalEvents,
  });
  assert.ok(normalCode === 0 || normalCode === 1);
  app = undefined;
  const normalTrace = normalEvents
    .split('\n')
    .filter((line) => line.startsWith('owned_quit_event:'))
    .map(
      (line) =>
        JSON.parse(line.slice('owned_quit_event:'.length)) as {
          event: string;
          at: number;
          facts?: unknown;
        },
    );
  if (normalCode === 0)
    assert.deepEqual(
      normalTrace.filter(({ event }) => event !== 'window-hidden').map(({ event }) => event),
      ['quit-requested', 'quit-returned', 'service-closed', 'window-closed'],
    );
  else {
    assert.ok(Date.now() - normalCommittedAt >= 4000);
    assert.ok(normalTrace.some(({ event }) => event === 'window-closed'));
  }
  assert.deepEqual(normalTrace.find(({ event }) => event === 'quit-returned')!.facts, {
    windows: 1,
    visible: false,
    dock: false,
    prompts: 0,
  });
  await until(
    async () => normalProcesses.every((process) => dead(process.pid)),
    remaining(normalCommittedAt),
    'normal exit left an owned process beyond five seconds',
  );
  child = undefined;
  await until(
    async () => {
      const state = await locks();
      return !state.outer && !state.inner;
    },
    remaining(normalCommittedAt),
    'normal exit did not release candidate locks',
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), count);
  stage('ordinary-request-exit-complete', {
    exitCode: normalCode,
    cleanupConfirmed: normalCode === 0,
    elapsedMs: Date.now() - normalCommittedAt,
    locks: await locks(),
    events: normalTrace,
    unexpectedModelRequests: count,
  });

  app = await launch();
  const failedPage = await nativeRootPage(app, 10000);
  await failedPage.locator('.session-header').waitFor();
  child = ownedChild(app.process().pid!);
  let failedEvents = '';
  app.process().stdout!.on('data', (chunk: Buffer) => {
    failedEvents += chunk.toString();
  });
  await app.evaluate(({ dialog, BaseWindow }, pid) => {
    const record = (event: string) => process.stdout.write(`owned_failed_event:${event}\n`);
    BaseWindow.getAllWindows()[0]!.once('hide', () => record('window-hidden'));
    BaseWindow.getAllWindows()[0]!.once('closed', () => record('window-closed'));
    type Child = { pid?: number; once(event: string, callback: () => void): void };
    const owned = (process as unknown as { _getActiveHandles(): Child[] })
      ._getActiveHandles()
      .find((child) => child.pid === pid);
    if (!owned) throw Error('owned_paired_child_unavailable');
    owned.once('close', () => record('service-closed'));
    dialog.showMessageBox = (async () => {
      record('unexpected-prompt');
      throw Error('explicit_quit_must_not_prompt');
    }) as typeof dialog.showMessageBox;
  }, child.pid);
  signalOwned('SIGKILL');
  await until(
    async () => failedEvents.includes('owned_failed_event:service-closed'),
    5000,
    'nonzero Service exit was not observed before quit',
  );
  const failedExit = new Promise<number | null>((resolve) => app!.process().once('close', resolve));
  // Failed cleanup can end Main immediately; schedule after the evaluate response.
  const failedCommittedAt = Date.now();
  await app.evaluate(({ app, BaseWindow }) => {
    setTimeout(() => {
      app.quit();
      const returned = {
        windows: BaseWindow.getAllWindows().length,
        visible: BaseWindow.getAllWindows().some((window) => window.isVisible()),
        dock: app.dock?.isVisible() ?? false,
      };
      // The nonzero exit may precede macOS's asynchronous hide notification.
      // Record the synchronous visibility boundary before background cleanup runs.
      process
        .getBuiltinModule('node:fs')
        .writeSync(1, `owned_failed_quit_returned:${JSON.stringify(returned)}\n`);
    }, 0);
  });
  assert.equal(await exitWithin(failedExit, failedCommittedAt), 1);
  app = undefined;
  assert.ok(Date.now() - failedCommittedAt < 1000, 'failed Service quit did not exit immediately');
  const returnedFailure = failedEvents
    .split('\n')
    .find((line) => line.startsWith('owned_failed_quit_returned:'));
  assert.ok(returnedFailure, 'failed quit did not record its synchronous presentation state');
  assert.deepEqual(JSON.parse(returnedFailure.slice('owned_failed_quit_returned:'.length)), {
    windows: 1,
    visible: false,
    dock: false,
  });
  assert.ok(failedEvents.includes('owned_failed_event:window-closed'));
  assert.equal(failedEvents.includes('owned_failed_event:unexpected-prompt'), false);
  assert.throws(() => process.kill(child!.pid, 0));
  child = undefined;
  await until(
    async () => {
      const state = await locks();
      return !state.outer && !state.inner;
    },
    remaining(failedCommittedAt),
    'failed cleanup exit did not release owned leases',
  );
  assert.equal(await (await fetch(`${control}/count`)).text(), count);
  stage('failed-service-exit-complete', {
    exitCode: 1,
    locks: await locks(),
    failedEvents,
    unexpectedModelRequests: count,
  });
} finally {
  if (child) {
    try {
      signalOwned('SIGKILL');
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
