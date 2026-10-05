import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import type { PairedServiceChild } from '@kite-ai/service/paired';

/** Trusted main-only adapter; launchPairedService remains the single protocol/lifecycle owner. */
export function spawnNodePairedChild(
  command: readonly string[],
  options: { env: Readonly<Record<string, string>> },
): PairedServiceChild {
  if (command.length !== 2 || command.some((value) => !isAbsolute(value)))
    throw Error('invalid_paired_command');
  const child = spawn(command[0]!, [command[1]!], {
    env: { ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
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
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
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
