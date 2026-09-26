import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type Browser, chromium } from 'playwright';

if (process.platform !== 'darwin') throw new Error('This Electron quit smoke targets macOS.');

const root = resolve(import.meta.dir, '..');
const repeatedQuit = process.argv.includes('--repeat-quit');
const stalledStartup = process.argv.includes('--stalled-startup');
const packagedExecutable = resolve(
  process.argv
    .slice(2)
    .find((value) => value !== '--repeat-quit' && value !== '--stalled-startup') ??
    join(root, `out/kite-darwin-${process.arch}/kite.app/Contents/MacOS/kite`),
);
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-electron-quit-failure-')));
const application = join(home, 'kite.app');
const appData = join(home, 'app-data');
cpSync(resolve(dirname(packagedExecutable), '../..'), application, {
  recursive: true,
  verbatimSymlinks: true,
});
mkdirSync(appData);
mkdirSync(join(home, '.kite-code'), { mode: 0o700 });

const child = spawn(
  join(application, 'Contents/MacOS/kite'),
  ['--inspect-brk=0', '--remote-debugging-port=0'],
  { cwd: home, stdio: ['ignore', 'ignore', 'pipe'] },
);
const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
let logs = '';
child.stderr.on('data', (chunk: Buffer) => {
  logs = (logs + chunk.toString()).slice(-65_536);
});
const endpoint = async (pattern: RegExp): Promise<string> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = logs.match(pattern);
    if (match?.[1]) return match[1];
    if (child.exitCode !== null) throw new Error('Packaged Electron exited before inspection.');
    await Bun.sleep(25);
  }
  throw new Error('Packaged Electron debugger did not start.');
};

let inspector: WebSocket | undefined;
let browser: Browser | undefined;
let ownedServicePid: number | undefined;
try {
  inspector = new WebSocket(await endpoint(/Debugger listening on (ws:\/\/[^\s]+)/u));
  await new Promise<void>((resolve, reject) => {
    inspector!.addEventListener('open', () => resolve(), { once: true });
    inspector!.addEventListener('error', () => reject(new Error('Inspector unavailable.')), {
      once: true,
    });
  });
  let nextId = 0;
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  let onPause: (callFrameId: string) => void = () => undefined;
  inspector.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: { callFrames?: Array<{ callFrameId: string }> };
      result?: Record<string, unknown>;
    };
    if (message.method === 'Debugger.paused' && message.params?.callFrames?.[0])
      onPause(message.params.callFrames[0].callFrameId);
    if (typeof message.id !== 'number') return;
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message.result ?? {});
    }
  });
  const command = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Inspector timed out: ${method}`));
      }, 30_000);
      pending.set(id, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      inspector!.send(JSON.stringify({ id, method, params }));
    });
  };
  await command('Runtime.enable');
  await command('Debugger.enable');
  const paused = new Promise<string>((resolve) => {
    onPause = resolve;
  });
  await command('Runtime.runIfWaitingForDebugger');
  const callFrameId = await paused;
  const injection = await command('Debugger.evaluateOnCallFrame', {
    callFrameId,
    expression: `globalThis.__kiteQuitSmoke = require('electron');
${
  stalledStartup
    ? `const ChildProcess = require('node:child_process').ChildProcess;
const originalKill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function (signal) {
  if (signal === 'SIGTERM' && this.spawnfile?.endsWith('/service/kite-service')) {
    process.stderr.write('[quit-smoke] startup cancellation held\\n');
    return true;
  }
  return originalKill.call(this, signal);
};
const originalHandle = __kiteQuitSmoke.ipcMain.handle.bind(__kiteQuitSmoke.ipcMain);
__kiteQuitSmoke.ipcMain.handle = (channel, listener) => {
  originalHandle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'kite:desktop:runtime-open') {
      const output = require('node:child_process').execFileSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' });
      const service = output.split('\\n').map((line) => line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/u)).find((match) => match?.[2] === String(process.pid) && match[3]?.includes('/Resources/service/kite-service app-server run-stdio'));
      if (!service) throw new Error('Quit smoke could not find its owned Service.');
      process.kill(Number(service[1]), 'SIGSTOP');
      process.stderr.write('[quit-smoke] startup service paused\\n');
    }
    return result;
  });
};`
    : ''
}
__kiteQuitSmoke.app.setPath('home', ${JSON.stringify(home)});
__kiteQuitSmoke.app.setPath('appData', ${JSON.stringify(appData)});
__kiteQuitSmoke.app.setPath('userData', ${JSON.stringify(join(appData, 'dev.kite-code.desktop'))});
__kiteQuitSmoke.dialog.showMessageBox = async (...args) => {
  process.stderr.write('[quit-smoke] ' + args.at(-1)?.title + '\\n');
  return { response: 0, checkboxChecked: false };
};`,
  });
  assert.equal(injection.exceptionDetails, undefined, 'Test main-process injection failed.');
  await command('Debugger.resume');
  browser = await chromium.connectOverCDP(await endpoint(/DevTools listening on (ws:\/\/[^\s]+)/u));
  const page =
    browser.contexts()[0]!.pages()[0] ?? (await browser.contexts()[0]!.waitForEvent('page'));
  if (!stalledStartup)
    await page.getByRole('button', { name: '新对话', exact: true }).waitFor({ timeout: 30_000 });
  const servicePid = await (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const output = spawnSync('ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8' }).stdout;
      const line = output.split('\n').find((value) => {
        const match = value.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
        return (
          match?.[2] === String(child.pid) &&
          match[3]?.includes(
            `${application}/Contents/Resources/service/kite-service app-server run-stdio`,
          )
        );
      });
      if (line) return Number(line.trim().split(/\s+/u)[0]);
      await Bun.sleep(50);
    }
    throw new Error('Owned Service process was not observed.');
  })();
  ownedServicePid = servicePid;
  if (stalledStartup) {
    const state = spawnSync('ps', ['-o', 'state=', '-p', String(servicePid)], {
      encoding: 'utf8',
    }).stdout.trim();
    assert.match(state, /^T/u, `Service was not stopped before quit: ${state}`);
  }
  const quitRequest = await command('Runtime.evaluate', {
    expression: repeatedQuit
      ? '__kiteQuitSmoke.app.quit(); __kiteQuitSmoke.app.quit();'
      : stalledStartup
        ? '__kiteQuitSmoke.app.quit();'
        : `process.kill(${servicePid}, 'SIGKILL'); __kiteQuitSmoke.app.quit();`,
    awaitPromise: false,
  });
  assert.equal(quitRequest.exceptionDetails, undefined, 'Test quit request failed.');
  inspector.close();
  const code = await Promise.race([
    exited,
    Bun.sleep(stalledStartup ? 35_000 : 10_000).then(() => {
      throw new Error(`Electron did not exit after Service cleanup failed. ${logs}`);
    }),
  ]);
  assert.equal(code, 1, `Emergency exit must use a nonzero status. ${logs}`);
  if (!repeatedQuit)
    assert.ok(
      logs.includes(
        stalledStartup ? '[quit-smoke] 服务仍在收尾' : '[quit-smoke] 服务收尾未正常完成',
      ),
      'The user warning was not shown.',
    );
  console.log(
    repeatedQuit
      ? 'Packaged Electron exited on a repeated explicit quit request.'
      : stalledStartup
        ? 'Packaged Electron exited after a stalled Service startup reached the emergency choice.'
        : 'Packaged Electron exited after its owned Service failed, with an inspection warning.',
  );
} finally {
  inspector?.close();
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null) child.kill('SIGKILL');
  if (ownedServicePid) {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(ownedServicePid)], {
      encoding: 'utf8',
    }).stdout.trim();
    if (command.startsWith(`${application}/Contents/Resources/service/kite-service `)) {
      try {
        process.kill(ownedServicePid, 'SIGKILL');
      } catch {
        // The test-owned child may finish between ps and kill.
      }
    }
  }
  rmSync(home, { recursive: true, force: true });
}
