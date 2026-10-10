/** Private Windows stdio guardian. Only the trusted port writes its fixed start frame. */
import { isAbsolute } from 'node:path';
import {
  retainWindowsOwnedProcessObservation,
  startWindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../platform/process/windows-owned-child';

interface Start {
  type: 'start';
  nonce: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  controlBase: string;
  graceMs: number;
  stderrBytes: number;
  frameBytes: number;
}
let start: Start | undefined;
let child: ReturnType<typeof startWindowsOwnedChild> | undefined;
let self: ReturnType<typeof retainWindowsOwnedProcessObservation> | undefined;
let closing: Promise<void> | undefined;
let failedStartCleanup: Promise<void> | undefined;
let drained: Promise<unknown> | undefined;
let parentGone = false;
let sequence = 0;
let buffer = Buffer.alloc(0);
let pendingWrites = 0;
let writes = Promise.resolve();
let _unknownKeepAlive: ReturnType<typeof setInterval> | undefined;
const CONTROL = 2 * 1024 * 1024 + 64 * 1024;
function send(value: object): Promise<void> {
  if (parentGone) return Promise.resolve();
  const frame = `${JSON.stringify({ ...value, nonce: start?.nonce, sequence: ++sequence })}\n`;
  return new Promise((resolve) => {
    process.stdout.write(frame, (error) => {
      if (error) {
        parentGone = true;
        void stop();
      }
      resolve();
    });
  });
}
function guardian() {
  if (!self?.creationTime) throw Error('mcp_stdio_guardian_identity_unavailable');
  return { pid: process.pid, parentPid: process.ppid, creationTime: self.creationTime };
}
function stop(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    let confirmed = false;
    if (!child) {
      try {
        await failedStartCleanup;
        self?.close();
        process.exit(125);
      } catch {
        _unknownKeepAlive ??= setInterval(() => {}, 1000);
        return;
      }
    }
    try {
      if (child) {
        const stopped = await child.stop({ graceMs: start?.graceMs ?? 200 });
        if (stopped.job.treeStopped) await drained?.catch(() => {});
        await child.close();
        const proof = child.readEvidence();
        confirmed =
          proof.closed &&
          !proof.closeUnknown &&
          proof.root.waitConfirmed &&
          proof.job.treeStopped &&
          proof.job.activeProcesses === 0;
      }
    } catch {
      // Keep the original Job/HANDLE owner. A cancel request is not a stop receipt.
    }
    await send({
      type: 'terminal',
      guardian: self?.creationTime ? guardian() : null,
      evidence: child?.readEvidence() ?? null,
      treeStopped: confirmed,
    });
    if (confirmed) {
      try {
        self?.close();
      } catch {
        confirmed = false;
      }
    }
    if (confirmed) process.exit(0);
    // The original native owner may still have pending I/O or unclosed handles.
    // Parent loss never converts that state into a confirmed terminal.
    _unknownKeepAlive ??= setInterval(() => {}, 1000);
  })();
  return closing;
}
async function run() {
  try {
    self = retainWindowsOwnedProcessObservation(process.pid);
    if (!self.creationTime || !self.verify()) throw Error('identity_unavailable');
    const input = start!;
    child = startWindowsOwnedChild({
      executable: input.command,
      argv: input.args,
      cwd: input.cwd,
      env: input.env,
      stdin: 'pipe',
    });
    await send({ type: 'ready', guardian: guardian(), evidence: child.readEvidence() });
    if (closing || parentGone) {
      await stop();
      return;
    }
    let stderrBytes = 0;
    const output = (async () => {
      for await (const raw of child!.stdout) {
        const chunk = Buffer.from(raw);
        for (let at = 0; at < chunk.length; at += 16384)
          await send({ type: 'rpc', content: chunk.subarray(at, at + 16384).toString('base64') });
      }
    })();
    const errors = (async () => {
      for await (const chunk of child!.stderr) {
        stderrBytes += chunk.length;
        if (stderrBytes > input.stderrBytes) {
          void stop();
          return;
        }
      }
    })();
    drained = Promise.all([output, errors]);
    void drained.catch(() => void stop());
    await child.exited;
    await stop();
  } catch (error) {
    if (error instanceof WindowsOwnedChildStartError) failedStartCleanup = error.cleanup;
    await stop();
  }
}
process.stdin.on('data', (chunk: Buffer) => {
  try {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset),
        end = newline < 0 ? chunk.length : newline;
      if (buffer.length + end - offset > CONTROL) throw Error('control_limit');
      buffer = Buffer.concat([buffer, chunk.subarray(offset, end)]);
      if (newline < 0) break;
      const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (!start) {
        if (
          process.platform !== 'win32' ||
          frame.type !== 'start' ||
          typeof frame.nonce !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(frame.nonce) ||
          typeof frame.command !== 'string' ||
          !isAbsolute(frame.command) ||
          !/\.exe$/i.test(frame.command) ||
          typeof frame.cwd !== 'string' ||
          !isAbsolute(frame.cwd) ||
          !Array.isArray(frame.args) ||
          frame.args.length > 128 ||
          frame.args.some(
            (v: unknown) => typeof v !== 'string' || v.length > 8192 || v.includes('\0'),
          ) ||
          !frame.env ||
          typeof frame.env !== 'object' ||
          Array.isArray(frame.env) ||
          Object.entries(frame.env).some(
            ([k, v]) =>
              !/^[A-Z_][A-Z0-9_]{0,127}$/.test(k) ||
              typeof v !== 'string' ||
              v.length > 8192 ||
              v.includes('\0'),
          ) ||
          !Number.isSafeInteger(frame.graceMs) ||
          frame.graceMs < 0 ||
          frame.graceMs > 5000 ||
          !Number.isSafeInteger(frame.stderrBytes) ||
          frame.stderrBytes < 1 ||
          frame.stderrBytes > 16 * 1024 * 1024 ||
          !Number.isSafeInteger(frame.frameBytes) ||
          frame.frameBytes < 1 ||
          frame.frameBytes > 1024 * 1024
        )
          throw Error('start_invalid');
        start = frame;
        void run();
      } else if (frame.nonce !== start.nonce) throw Error('control_identity');
      else if (frame.type === 'cancel') void stop();
      else if (
        frame.type === 'rpc' &&
        typeof frame.content === 'string' &&
        Buffer.byteLength(frame.content) <= start.frameBytes + 1 &&
        !closing &&
        child
      ) {
        if (++pendingWrites > 32) throw Error('write_capacity');
        const content = Buffer.from(frame.content);
        writes = writes
          .then(async () => {
            if (!closing) await child!.writeStdin(content);
          })
          .catch(() => {
            void stop();
          })
          .finally(() => {
            pendingWrites--;
          });
      } else throw Error('control_invalid');
    }
  } catch {
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
