import { createRequire } from 'node:module';
import type { Socket } from 'node:net';

interface ConptyTerminal {
  pid: number;
  setEncoding(encoding: null): void;
  onData(callback: (data: Buffer) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  _agent: { inSocket: Socket };
}

interface Options {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

const require = createRequire(import.meta.url);

export function openWindowsTestPty(
  file: string,
  args: string[],
  options: Options,
  onData: (bytes: Buffer) => void,
) {
  const { spawn } = require('node-pty') as {
    spawn(file: string, args: string[], options: Options & { useConpty: true }): ConptyTerminal;
  };
  const terminal = spawn(file, args, { ...options, useConpty: true });
  // The pinned Windows adapter wraps the native pipes in net.Socket. Select raw
  // output bytes and confirm a write through the original ConPTY input pipe.
  terminal.setEncoding(null);
  terminal.onData((data) => {
    if (!Buffer.isBuffer(data)) throw Error('test_windows_pty_raw_output_required');
    onData(data);
  });
  const exited = new Promise<number>((resolve, reject) => {
    // node-pty publishes this event after the native process exit and pipe close.
    terminal.onExit(({ exitCode }) => {
      if (!Number.isSafeInteger(exitCode)) reject(Error('test_windows_pty_exit_unconfirmed'));
      else resolve(exitCode);
    });
  });
  void exited.catch(() => {});
  return {
    pid: terminal.pid,
    exited,
    write(data: Buffer): Promise<void> {
      return new Promise((resolve, reject) => {
        terminal._agent.inSocket.write(data, (error) => (error ? reject(error) : resolve()));
      });
    },
    resize: (cols: number, rows: number) => terminal.resize(cols, rows),
    hangup: () => terminal._agent.inSocket.end(),
    kill: () => terminal.kill(),
  };
}
