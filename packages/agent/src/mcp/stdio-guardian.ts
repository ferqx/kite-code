import { type ChildProcess, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

interface Start {
  type: 'start';
  nonce: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  graceMs: number;
  stderrBytes: number;
  frameBytes: number;
}
let start: Start | undefined,
  child: ChildProcess | undefined,
  buffer = Buffer.alloc(0),
  closing: Promise<void> | undefined,
  parentGone = false,
  sequence = 0,
  exited: Promise<void> | undefined,
  drained: Promise<unknown> | undefined,
  cancelling = false;
const CONTROL = 2 * 1024 * 1024 + 64 * 1024;
async function send(value: object) {
  if (parentGone) return;
  await new Promise<void>((resolve) =>
    process.stdout.write(
      `${JSON.stringify({ nonce: start?.nonce, sequence: ++sequence, ...value })}\n`,
      (error) => {
        if (error) {
          parentGone = true;
          void stop();
        }
        resolve();
      },
    ),
  );
}
function alive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
async function waitGone(pid: number, ms: number) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await Bun.sleep(20);
  return !alive(pid);
}
async function terminate(pid: number) {
  if (!alive(pid)) return { groupStopped: true, forced: false };
  for (const [signal, ms] of [
    ['SIGTERM', start!.graceMs],
    ['SIGKILL', 2000],
  ] as const) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        return { groupStopped: false, forced: signal === 'SIGKILL' };
    }
    if (await waitGone(pid, ms)) return { groupStopped: true, forced: signal === 'SIGKILL' };
  }
  return { groupStopped: false, forced: true };
}
function stop(): Promise<void> {
  cancelling = true;
  if (closing) return closing;
  closing = (async () => {
    if (!child?.pid) {
      return;
    }
    const proof = await terminate(child.pid);
    if (proof.groupStopped) await exited;
    else {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    await drained?.catch(() => {});
    await send({ type: 'terminal', ...proof });
    process.exit(proof.groupStopped ? 0 : 125);
  })();
  return closing;
}
async function run() {
  const input = start!;
  try {
    child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const current = child;
    current.stdin!.on('error', () => {
      void stop();
    });
    exited = new Promise((resolve) => {
      current.once('exit', () => resolve());
      current.once('error', () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      current.once('spawn', resolve);
      current.once('error', reject);
    });
    let stderrBytes = 0;
    drained = Promise.all([
      (async () => {
        for await (const raw of current.stdout!) {
          const chunk = raw as Buffer;
          for (let offset = 0; offset < chunk.length; offset += 16384)
            await send({
              type: 'rpc',
              content: chunk.subarray(offset, offset + 16384).toString('base64'),
            });
        }
      })(),
      (async () => {
        for await (const raw of current.stderr!) {
          stderrBytes += (raw as Buffer).length;
          if (stderrBytes > input.stderrBytes) {
            void stop();
            return;
          }
        }
      })(),
    ]);
    void drained.catch(() => void stop());
    await send({ type: 'ready', processGroupId: current.pid, guardianPid: process.pid });
    if (cancelling) {
      closing = undefined;
      await stop();
      return;
    }
    await exited;
    if (closing) {
      await closing;
      return;
    }
    await stop();
  } catch {
    const proof = child?.pid ? await terminate(child.pid) : { groupStopped: true, forced: false };
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    await send({ type: 'terminal', ...proof });
    process.exit(proof.groupStopped ? 0 : 125);
  }
}
process.stdin.on('data', (chunk: Buffer) => {
  try {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset),
        end = newline < 0 ? chunk.length : newline;
      if (buffer.length + end - offset > CONTROL) throw new Error('control_limit');
      buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
      if (newline < 0) break;
      const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (!start) {
        if (
          frame.type !== 'start' ||
          typeof frame.nonce !== 'string' ||
          !isAbsolute(frame.command) ||
          !isAbsolute(frame.cwd) ||
          !Array.isArray(frame.args) ||
          frame.args.some((x: unknown) => typeof x !== 'string') ||
          !frame.env ||
          typeof frame.env !== 'object' ||
          Array.isArray(frame.env) ||
          Object.values(frame.env).some((x) => typeof x !== 'string') ||
          !Number.isSafeInteger(frame.graceMs) ||
          frame.graceMs < 0 ||
          frame.graceMs > 5000 ||
          !Number.isSafeInteger(frame.stderrBytes) ||
          frame.stderrBytes < 1 ||
          !Number.isSafeInteger(frame.frameBytes) ||
          frame.frameBytes < 1 ||
          process.platform !== 'darwin'
        )
          throw new Error('start_invalid');
        start = frame;
        void run();
      } else if (frame.nonce !== start.nonce) throw new Error('control_identity');
      else if (frame.type === 'cancel') {
        void stop();
      } else if (
        frame.type === 'rpc' &&
        typeof frame.content === 'string' &&
        Buffer.byteLength(frame.content) <= start.frameBytes + 1 &&
        child?.stdin?.writable &&
        !cancelling
      ) {
        if (!child.stdin.write(frame.content)) {
          process.stdin.pause();
          child.stdin.once('drain', () => process.stdin.resume());
        }
      } else throw new Error('control_invalid');
    }
  } catch {
    parentGone = true;
    void stop();
  }
});
process.stdin.on('end', () => {
  parentGone = true;
  void stop();
});
process.stdin.on('error', () => {
  parentGone = true;
  void stop();
});
process.stdout.on('error', () => {
  parentGone = true;
  void stop();
});
process.on('SIGTERM', () => {
  parentGone = true;
  void stop();
});
