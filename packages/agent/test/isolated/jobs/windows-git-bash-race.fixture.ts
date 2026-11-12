import { mock } from 'bun:test';
import * as fs from 'node:fs';
import * as promises from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as locks from '../../../src/platform/locks';

const [root, role, target, failure] = process.argv.slice(2) as [string, string, string, string];
const original = { ...fs };
const io = { ...promises };
const acquire = locks.acquireFileLock;
const lockModule = new URL('../../../src/platform/locks.ts', import.meta.url).href;
const source = new URL('../../../src/jobs/windows-git-bash.ts', import.meta.url);
// Only the fixture module bypasses the Windows entry guard on POSIX. File locks,
// filesystem I/O and both independent processes still use their actual OS backend.
const text = original.readFileSync(source, 'utf8');
if (!text.includes("process.platform !== 'win32'")) throw Error('fixture_guard_missing');
const modulePath = join(root, `${role}.ts`);
original.writeFileSync(
  modulePath,
  text
    .replace("process.platform !== 'win32'", 'false')
    .replaceAll("'../platform/", `'${new URL('../../../src/platform/', import.meta.url).href}`)
    .replace(
      "'./launch-identity'",
      JSON.stringify(new URL('../../../src/jobs/launch-identity.ts', import.meta.url).href),
    ),
);
let busy = false;
mock.module(lockModule, () => ({
  ...locks,
  acquireFileLock(...args: Parameters<typeof acquire>) {
    try {
      return acquire(...args);
    } catch (error) {
      if (error instanceof locks.LockBusyError && !busy) {
        busy = true;
        process.stdout.write('busy\n');
      }
      throw error;
    }
  },
}));
let paused = false;
let reportPause!: () => void;
const pauseStarted = new Promise<void>((resolve) => {
  reportPause = resolve;
});
const matches = (path: unknown) => {
  const name = String(path).replaceAll('\\', '/');
  return role === 'owner' && !paused && name.endsWith(target);
};
const pause = async () => {
  paused = true;
  process.stdout.write('paused\n');
  reportPause();
  await new Response(Bun.stdin).text();
  if (failure === 'fail') throw Error('injected_write_failure');
};
mock.module('node:fs/promises', () => ({
  ...io,
  async copyFile(...args: Parameters<typeof io.copyFile>) {
    if (!matches(args[1])) return io.copyFile(...args);
    await io.writeFile(args[1], 'partial', { flag: 'wx' });
    await pause();
    // Finish the original writer rather than invoking EXCL a second time.
    await io.copyFile(args[0], args[1]);
  },
  async writeFile(...args: Parameters<typeof io.writeFile>) {
    if (role === 'owner' && failure === 'settle' && String(args[0]).endsWith('msys-2.0.dll')) {
      await io.writeFile(args[0], 'partial', { flag: 'wx' });
      throw Error('injected_write_failure');
    }
    if (!matches(args[0])) return io.writeFile(...args);
    await io.writeFile(args[0], 'partial', { flag: 'wx' });
    await pause();
    await io.writeFile(args[0], args[1]);
  },
}));
mock.module('node:fs', () => ({
  ...original,
  writeFileSync(...args: Parameters<typeof original.writeFileSync>) {
    if (!matches(args[0])) return original.writeFileSync(...args);
    paused = true;
    original.writeFileSync(args[0], 'partial', { flag: 'wx' });
    process.stdout.write('paused\n');
    // The manifest publisher is synchronous; hold its process at the exact write window.
    original.readSync(0, Buffer.alloc(1), 0, 1, null);
    original.writeFileSync(args[0], args[1]);
  },
}));
Bun.which = () => join(root, 'git/cmd/git.exe');
try {
  const { stageWindowsGitBash, captureWindowsGitBashRuntime } = await import(
    pathToFileURL(modulePath).href
  );
  const prepare = () => stageWindowsGitBash(join(root, 'state'), join(root, 'ktipc.dll'));
  const first = prepare();
  let second: ReturnType<typeof prepare> | undefined;
  if (failure === 'same-process') {
    await pauseStarted;
    second = prepare();
  }
  const [staged, duplicate] = await Promise.all([first, second]);
  if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(staged))
    throw Error('runtime_mismatch');
  const verify = await captureWindowsGitBashRuntime(staged.shell, staged.fullShell);
  await verify(false);
  await verify(true);
  process.stdout.write(`result:${JSON.stringify(staged)}\n`);
} catch (error) {
  process.stdout.write(`error:${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
