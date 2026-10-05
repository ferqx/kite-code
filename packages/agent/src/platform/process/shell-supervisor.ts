import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  type LaunchIdentity,
  removeRuntimeTemp,
  verifyLaunchIdentities,
} from '../../jobs/launch-identity';
import { type DarwinOwnedChild, startDarwinOwnedChild } from './darwin-owned-child';

interface Request {
  nonce: string;
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  graceMs: number;
  identities?: LaunchIdentity[];
  runtimeTemp?: LaunchIdentity;
  profileDigest?: string;
}
const MAX_FRAME = 1024 * 1024;
let request: Request | undefined;
let child: Pick<ChildProcess, 'pid' | 'stdout' | 'stderr'> | undefined;
let ownedChild: DarwinOwnedChild | undefined;
let buffer = '';
let closing: Promise<void> | undefined;
let parentGone = false;
let childExit: Promise<number | null> | undefined;
let outputDrain: Promise<unknown> | undefined;

async function send(frame: object): Promise<void> {
  if (parentGone) return;
  await new Promise<void>((resolve) => {
    process.stdout.write(`${JSON.stringify({ nonce: request?.nonce, ...frame })}\n`, (error) => {
      if (error) {
        parentGone = true;
        void stop();
      }
      resolve();
    });
  });
}
process.stdout.on('error', () => {
  parentGone = true;
  void stop();
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  if (buffer.length > MAX_FRAME) {
    parentGone = true;
    void stop();
    return;
  }
  while (buffer.includes('\n')) {
    const boundary = buffer.indexOf('\n');
    const line = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 1);
    try {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (!request) {
        if (
          frame.type !== 'start' ||
          typeof frame.nonce !== 'string' ||
          typeof frame.executable !== 'string' ||
          !frame.executable.startsWith('/') ||
          !Array.isArray(frame.argv) ||
          frame.argv.length > 256 ||
          frame.argv.some((value) => typeof value !== 'string' || value.includes('\0')) ||
          typeof frame.cwd !== 'string' ||
          typeof frame.env !== 'object' ||
          !frame.env ||
          Array.isArray(frame.env) ||
          Object.values(frame.env).some((value) => typeof value !== 'string') ||
          !Number.isSafeInteger(frame.graceMs) ||
          Number(frame.graceMs) < 0 ||
          Number(frame.graceMs) > 5000 ||
          process.platform === 'win32'
        )
          throw new Error('invalid_private_start');
        request = frame as unknown as Request;
        void start();
      } else if (frame.type === 'cancel' && frame.nonce === request.nonce) void stop();
      else throw new Error('invalid_private_control');
    } catch {
      parentGone = true;
      void stop();
    }
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
process.on('SIGTERM', () => {
  parentGone = true;
  void stop();
});

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
async function waitGroup(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (groupAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return !groupAlive(pid);
}
async function terminateGroup(pid: number): Promise<{ confirmed: boolean; forced: boolean }> {
  if (!groupAlive(pid)) return { confirmed: true, forced: false };
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      return { confirmed: false, forced: false };
  }
  if (await waitGroup(pid, request?.graceMs ?? 200)) return { confirmed: true, forced: false };
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      return { confirmed: false, forced: true };
  }
  return { confirmed: await waitGroup(pid, 2000), forced: true };
}
async function drain(stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr'): Promise<void> {
  const decoder = new TextDecoder();
  async function output(text: string) {
    let piece = '';
    let bytes = 0;
    for (const character of text) {
      const size = Buffer.byteLength(character);
      if (bytes + size > 32 * 1024) {
        await send({ type: 'output', stream: name, content: piece });
        piece = '';
        bytes = 0;
      }
      piece += character;
      bytes += size;
    }
    if (piece) await send({ type: 'output', stream: name, content: piece });
  }
  for await (const chunk of stream)
    await output(decoder.decode(chunk as Uint8Array, { stream: true }));
  await output(decoder.decode());
}
async function start(): Promise<void> {
  const input = request!;
  try {
    if (input.identities) verifyLaunchIdentities(input.identities);
    if (
      input.profileDigest &&
      (input.executable !== '/usr/bin/sandbox-exec' ||
        input.argv[0] !== '-p' ||
        createHash('sha256')
          .update(input.argv[1] ?? '')
          .digest('hex') !== input.profileDigest)
    )
      throw Error('confined_profile_changed');
    if (process.platform === 'darwin') {
      ownedChild = startDarwinOwnedChild({
        executable: input.executable,
        argv: input.argv,
        cwd: input.cwd,
        env: input.env,
      });
      child = ownedChild;
      childExit = ownedChild.exited;
    } else {
      const spawned = spawn(input.executable, input.argv, {
        cwd: input.cwd,
        env: input.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = spawned;
      childExit = new Promise((resolve) => {
        spawned.once('exit', (code) => resolve(code));
        spawned.once('error', () => resolve(null));
      });
      await new Promise<void>((resolve, reject) => {
        spawned.once('spawn', resolve);
        spawned.once('error', reject);
      });
    }
    const processChild = child;
    await send({ type: 'ready', processGroupId: processChild.pid, supervisorPid: process.pid });
    const outputs = Promise.all([
      drain(processChild.stdout!, 'stdout'),
      drain(processChild.stderr!, 'stderr'),
    ]);
    outputDrain = outputs;
    void outputs.catch(() => {
      void stop();
    });
    const code = await childExit;
    // A shell can exit with background descendants. Its terminal includes group cleanup, not pid-only exit.
    await close(code === 0 ? 'succeeded' : 'failed', code);
  } catch {
    await close('failed', null, true);
  }
}
function stop(): Promise<void> {
  if (closing) return closing;
  if (!child?.pid) process.exit(125);
  return close('cancelled', null);
}
function close(
  outcome: 'succeeded' | 'failed' | 'cancelled',
  exitCode: number | null,
  helperFailure = false,
): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    const stopped = child?.pid
      ? await (ownedChild
          ? ownedChild.terminateGroup(request?.graceMs ?? 200)
          : terminateGroup(child.pid))
      : { confirmed: true, forced: false };
    if (stopped.confirmed) await childExit;
    else {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }
    await outputDrain?.catch(() => {});
    if (stopped.confirmed && ownedChild) {
      try {
        ownedChild.reapAfterConfirmedStop();
      } catch {
        stopped.confirmed = false;
      }
    }
    if (stopped.confirmed && request?.runtimeTemp) {
      try {
        removeRuntimeTemp(request.runtimeTemp);
      } catch {
        stopped.confirmed = false;
      }
    }
    await send({
      type: 'terminal',
      outcome: stopped.confirmed ? outcome : 'outcome_unknown',
      exitCode,
      groupStopped: stopped.confirmed,
      forced: stopped.forced,
    });
    process.exit(stopped.confirmed && !helperFailure ? 0 : 125);
  })();
  return closing;
}
