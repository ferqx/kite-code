import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

async function deadline<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { mode, root, hostPath, input, pidPath, storeId } = JSON.parse(process.argv[2]!) as {
    mode: 'first' | 'crash' | 'restored' | 'conflict';
    root: string;
    hostPath: string;
    input: string;
    pidPath: string;
    storeId: string;
  };
  const control = createInterface({ input: process.stdin });
  const commands = control[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip actual PTY ANSI CSI bytes.
  const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g;
  let buffer = '';
  let resolveEOF!: () => void;
  const eof = new Promise<void>((resolve) => {
    resolveEOF = resolve;
  });
  let resolveForced!: () => void;
  const forced = new Promise<void>((resolve) => {
    resolveForced = resolve;
  });
  const host = Bun.spawn({
    cmd: [process.execPath, '--no-install', hostPath, input],
    cwd: root,
    detached: process.platform !== 'win32',
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, bytes) {
        buffer += decoder.decode(bytes, { stream: true });
      },
      exit() {
        buffer += decoder.decode();
        resolveEOF();
      },
    },
    ...(process.platform === 'win32'
      ? {
          ipc(message: unknown) {
            if (message === 'draft-force-exit-dispatched') resolveForced();
          },
        }
      : {}),
  });
  const wait = async (text: string, end = Date.now() + 12000) => {
    while (!buffer.replace(ansi, '').replace(/\s+/g, ' ').includes(text)) {
      if (Date.now() > end) throw Error(`expected ${text} tail=${buffer.slice(-2500)}`);
      if (host.exitCode !== null) throw Error(`host ended tail=${buffer.slice(-2500)}`);
      await Bun.sleep(50);
    }
  };
  const key = (value: string) => {
    host.terminal!.write(value);
  };
  const command = async (expected: string) => {
    const line = await deadline(commands.next(), 12000, 'protocol timeout');
    if (line.done || line.value !== expected) throw Error('unexpected protocol command');
  };
  const cleanup = async () => {
    control.close();
    process.stdin.pause();
    if (host.exitCode === null) {
      if (process.platform === 'win32') {
        const killed = Bun.spawnSync(['taskkill.exe', '/pid', String(host.pid), '/t', '/f'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (killed.exitCode !== 0 && host.exitCode === null)
          throw Error('draft host tree cleanup failed');
      } else {
        process.kill(-host.pid, 'SIGKILL');
      }
      await deadline(host.exited, 5000, 'draft host cleanup timeout');
    }
    host.terminal?.close();
  };
  let failure: unknown;
  let exitDeadline: number | undefined;
  try {
    const startupDeadline = Date.now() + 12000;
    let trustConfirmed = false;
    for (;;) {
      const rendered = buffer.replace(ansi, '').replace(/\s+/g, ' ');
      if (rendered.includes('New Run')) break;
      if (
        !trustConfirmed &&
        rendered.includes('Open this workspace?') &&
        rendered.includes('› Exit Kite Code')
      ) {
        key('\x1b[A');
        await wait('› Trust this workspace and continue', startupDeadline);
        key('\r');
        trustConfirmed = true;
      }
      if (Date.now() > startupDeadline)
        throw Error(`expected original draft main input tail=${buffer.slice(-2500)}`);
      if (host.exitCode !== null) throw Error(`draft host ended tail=${buffer.slice(-2500)}`);
      await Bun.sleep(50);
    }
    if (mode === 'first') {
      key('cold original');
      await wait('cold original');
      key('\x11');
    } else if (mode === 'crash') {
      await wait('cold original');
      process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGKILL');
      if (host.exitCode !== null) throw Error('host ended with Service');
      key(' last edit');
      await wait('cold original last edit');
      console.log('HELD');
      await command('quit');
      key('\x11');
    } else if (mode === 'conflict') {
      await wait('/drafts');
      key(' local conflict');
      await wait('/drafts local conflict');
      console.log('EDITED');
      await command('quit');
      key('\x11');
      await wait('exit_blocked');
      if (host.exitCode !== null) throw Error('conflicted host exited');
      console.log('BLOCKED');
      await command('force');
      exitDeadline = Date.now() + 8000;
      if (process.platform === 'win32') {
        // Windows TerminateProcess cannot deliver a catchable SIGTERM. This
        // private fixture channel exercises the same registered host handler.
        host.send('draft-force-exit');
        await deadline(forced, exitDeadline - Date.now(), 'force exit was not dispatched');
      } else {
        host.kill('SIGTERM');
      }
    } else {
      if (buffer.includes('cold original last edit')) throw Error('restored original inserted');
      key('/drafts');
      await wait('/drafts');
      key('\r');
      await wait(`Store ${storeId}`);
      key('\x11');
    }
    const end = exitDeadline ?? Date.now() + 8000;
    while (host.exitCode === null && Date.now() < end) await Bun.sleep(50);
    // Product status and PTY EOF are different facts: the terminal callback
    // can report 0 even when the host correctly returns 1 after a failed flush.
    const [exit] = await deadline(Promise.all([host.exited, eof]), 5000, 'host exit timeout');
    const expected = mode === 'conflict' ? 1 : 0;
    if (exit !== expected) throw Error(`expected host exit ${expected}, got ${exit}`);
    console.log(`HOST_EXIT_${expected}`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'draft host failed') : error;
    }
  }
  if (failure) throw failure;
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
