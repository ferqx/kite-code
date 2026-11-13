import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import type { PairedServiceChild } from './paired';
import { windowsTerminalRuntimeArguments } from './runtime-assets';

/** Node host adapter; launchPairedService remains the single protocol/lifecycle owner. */
export function spawnNodePairedChild(
  command: readonly string[],
  options: { env: Readonly<Record<string, string>> },
): PairedServiceChild {
  const executable = command[0] ?? '';
  const runtime = basename(executable).toLowerCase();
  const fixedWindowsArguments =
    process.platform === 'win32' && (runtime === 'bun.exe' || runtime === 'node.exe')
      ? windowsTerminalRuntimeArguments(
          dirname(dirname(executable)),
          runtime === 'node.exe' ? 'node' : 'bun',
        )
      : undefined;
  if (
    command.length < 2 ||
    !isAbsolute(executable) ||
    !isAbsolute(command.at(-1) ?? '') ||
    (command.length !== 2 &&
      (!fixedWindowsArguments ||
        command.length !== fixedWindowsArguments.length + 2 ||
        fixedWindowsArguments.some((value, index) => command[index + 1] !== value)))
  )
    throw Error('invalid_paired_command');
  const child = spawn(executable, [...command.slice(1)], {
    env: { ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    // libuv's default Windows child Job kills descendants when Main exits.
    // Preserve the private stdin EOF so Service can drain its own resources.
    detached: process.platform === 'win32',
    windowsHide: true,
  });
  return pairedNodeChild(child);
}

/** Adapt a trusted host's existing owned child without changing its process selection. */
export function pairedNodeChild(child: ChildProcessWithoutNullStreams): PairedServiceChild {
  child.stdin.on('error', () => {});
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  void exited.catch(() => {});
  if (!child.pid) throw Error('paired_spawn_failed');
  let tail = Promise.resolve();
  return {
    pid: child.pid,
    exited,
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
    stdin: {
      write(value: string) {
        tail = tail.then(
          () =>
            new Promise<void>((resolve, reject) =>
              child.stdin.write(value, (error) => (error ? reject(error) : resolve())),
            ),
        );
        void tail.catch(() => {});
      },
      flush: () => tail,
      end: () => child.stdin.end(),
    },
    kill: (signal) => child.kill(signal),
  };
}
