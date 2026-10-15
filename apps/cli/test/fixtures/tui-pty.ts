import assert from 'node:assert/strict';
import { Terminal } from '@xterm/headless';

export function readTuiRender(screen: Terminal): string {
  return Array.from(
    { length: screen.buffer.active.length },
    (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? '',
  ).join('\n');
}

export async function ptyDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function spawnTuiPTY(input: {
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onData?: (bytes: Uint8Array) => void;
  /** Explicit raw-material consumer; provides no cursor or screen projection. */
  observation?: 'screen' | 'stream';
}) {
  const screen =
    input.observation === 'stream'
      ? undefined
      : new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
  const requireScreen = () => {
    if (!screen) throw Error('stream_observation_has_no_screen');
    return screen;
  };
  const output: Uint8Array[] = [];
  let parsed = Promise.resolve();
  let revision = 0;
  let actionRevision = -1;
  let actionOffset = 0;
  let byteLength = 0;
  let ended = false;
  let closed = false;
  let resolveEOF!: () => void;
  const eof = new Promise<void>((resolve) => {
    resolveEOF = resolve;
  });
  const host = Bun.spawn({
    cmd: input.cmd,
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    detached: process.platform !== 'win32',
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, bytes) {
        const copy = bytes.slice();
        output.push(copy);
        input.onData?.(copy);
        byteLength += copy.byteLength;
        if (screen) {
          parsed = parsed
            .then(() => new Promise<void>((resolve) => screen.write(copy, resolve)))
            .then(() => {
              revision++;
            });
        } else revision++;
      },
      exit() {
        resolveEOF();
      },
    },
  });
  void host.exited.then(() => {
    ended = true;
  });
  return {
    host,
    eof,
    get ended() {
      return ended;
    },
    text: () => Buffer.concat(output).toString('utf8'),
    sinceAction: () => Buffer.concat(output).subarray(actionOffset).toString('utf8'),
    viewport: () => {
      const actual = requireScreen();
      return Array.from(
        { length: 24 },
        (_, row) =>
          actual.buffer.active
            .getLine(actual.buffer.active.viewportY + row)
            ?.translateToString(true) ?? '',
      ).join('\n');
    },
    async key(value: string) {
      await parsed;
      actionRevision = revision;
      actionOffset = byteLength;
      host.terminal!.write(value);
    },
    /** Navigation only: do not turn an already painted target into a no-op action. */
    async keyUnlessVisible(value: string, target: string) {
      const actual = requireScreen();
      await parsed;
      const viewport = Array.from(
        { length: 24 },
        (_, row) =>
          actual.buffer.active
            .getLine(actual.buffer.active.viewportY + row)
            ?.translateToString(true) ?? '',
      ).join('\n');
      if (viewport.includes(target)) return false;
      actionRevision = revision;
      actionOffset = byteLength;
      host.terminal!.write(value);
      return true;
    },
    async projection() {
      const actual = requireScreen();
      await parsed;
      return { fresh: revision > actionRevision, text: readTuiRender(actual) };
    },
    async drain() {
      await parsed;
    },
    close() {
      if (closed) return;
      closed = true;
      host.terminal?.close();
      screen?.dispose();
    },
  };
}

export type TuiPTY = ReturnType<typeof spawnTuiPTY>;

export async function terminateTuiTree(
  owned: TuiPTY,
  input: {
    exitTimeoutMs: number;
    servicePid?: number;
    serviceExitTimeoutMs?: number;
    requireServiceAlive?: boolean;
  },
) {
  assert.equal(owned.ended, false, 'original host must be alive before tree termination');
  if (input.servicePid !== undefined) {
    assert.ok(Number.isSafeInteger(input.servicePid) && input.servicePid > 0);
    if (input.requireServiceAlive !== false) process.kill(input.servicePid, 0);
  }
  if (process.platform === 'win32') {
    const result = Bun.spawnSync(['taskkill.exe', '/pid', String(owned.host.pid), '/t', '/f'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(result.exitCode, 0, 'original host tree termination failed');
  } else {
    process.kill(-owned.host.pid, 'SIGKILL');
  }
  await ptyDeadline(
    Promise.all([owned.host.exited, owned.eof]),
    input.exitTimeoutMs,
    'original host tree did not exit',
  );
  if (process.platform !== 'win32') assert.equal(owned.host.signalCode, 'SIGKILL');
  if (input.servicePid !== undefined) {
    const end = Date.now() + (input.serviceExitTimeoutMs ?? input.exitTimeoutMs);
    for (;;) {
      try {
        process.kill(input.servicePid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
        throw error;
      }
      if (Date.now() >= end) throw Error('original Service remains alive after tree termination');
      await Bun.sleep(20);
    }
  }
  await owned.drain();
}
