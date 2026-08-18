import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { readWithProgress } from '@/core/tools/shell';
import type { ShellInput, ShellResult } from '@/core/types';
import type { SandboxExecutionDispatchRecordV1 } from '@/protocol/capabilities';
import type { PreparedSandboxExecutionV1 } from '@/protocol/sandbox-execution-provider';
import type { SandboxPreparationLifecycleV1 } from './consumer';
import {
  type PosixSupervisorIdentityV1,
  posixSupervisorIdentityPathV1,
  readComparablePosixProcessStartIdentityV1,
  readPosixSupervisorIdentityV1,
} from './posix-supervisor-identity';
import {
  confirmPosixSupervisorLockReleasedV1,
  createPosixSupervisorLockV1,
  type PosixSupervisorLockHandleV1,
  type PosixSupervisorLockIdentityV1,
} from './posix-supervisor-lock';

const SUPERVISOR_HANDSHAKE_TIMEOUT_MS = 5_000;
const SUPERVISOR_GRACEFUL_EXIT_MS = 500;
const SUPERVISOR_FORCED_EXIT_MS = 2_000;
const SUPERVISOR_OUTPUT_DRAIN_MS = 2_000;

export async function executePosixSupervisedV1(input: {
  readonly shell: ShellInput;
  readonly prepared: Readonly<PreparedSandboxExecutionV1>;
  readonly lifecycle: SandboxPreparationLifecycleV1;
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
  readonly timeoutMs: number;
  /** Test-only proof that the packaged release entrypoint embeds supervisor mode. */
  readonly supervisorExecutablePath?: string;
}): Promise<{ readonly outcome: ShellResult; readonly cleanupConfirmed: boolean }> {
  const controlRoot = input.prepared.cleanup.recoveryPayload.controlRoot;
  const dataRoot = input.prepared.cleanup.recoveryPayload.dataRoot;
  if (
    typeof controlRoot !== 'string' ||
    typeof dataRoot !== 'string' ||
    controlRoot === dataRoot ||
    process.platform === 'win32'
  ) {
    return failed(input.shell, 'POSIX supervisor runtime identity is unavailable.', true);
  }
  const socketPath = controlSocketPath(controlRoot, input.dispatchId);
  const identityPath = posixSupervisorIdentityPathV1(controlRoot, input.dispatchId);
  let server: ReturnType<typeof createServer> | undefined;
  let socket: Socket | undefined;
  let proc: Bun.Subprocess<'inherit', 'pipe', 'pipe'> | undefined;
  let identity: PosixSupervisorIdentityV1 | undefined;
  let supervisorLock: PosixSupervisorLockHandleV1 | undefined;
  const lockIdentity: PosixSupervisorLockIdentityV1 = {
    version: 1,
    dispatchId: input.dispatchId,
    supervisorNonce: input.supervisorNonce,
    dispatchIntentDigest: input.dispatchIntentDigest,
  };
  try {
    if (existsSync(socketPath)) {
      return failed(input.shell, 'POSIX supervisor control identity already exists.', false);
    }
    const connection = deferred<Socket>();
    server = createServer((candidate) => connection.resolve(candidate));
    await listen(server, socketPath);
    const childPath = join(import.meta.dir, 'posix-supervisor-child.ts');
    const supervisorCommand = input.supervisorExecutablePath
      ? [input.supervisorExecutablePath, '--kite-internal-posix-supervisor-v1']
      : process.env.KITE_STANDALONE_EXECUTABLE === '1'
        ? [process.execPath, '--kite-internal-posix-supervisor-v1']
        : [process.execPath, childPath];
    supervisorLock = createPosixSupervisorLockV1(controlRoot, lockIdentity);
    proc = Bun.spawn(
      [
        ...supervisorCommand,
        socketPath,
        identityPath,
        controlRoot,
        dataRoot,
        input.dispatchId,
        input.supervisorNonce,
        input.dispatchIntentDigest,
      ],
      {
        detached: true,
        stdio: ['inherit', 'pipe', 'pipe', supervisorLock.fd],
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          TMPDIR: dataRoot,
        },
      },
    );
    supervisorLock.close();
    supervisorLock = undefined;
    socket = await withTimeout(connection.promise, SUPERVISOR_HANDSHAKE_TIMEOUT_MS);
    // Only the first exact control connection is admissible. Stop accepting
    // before reading its handshake so later peers fail immediately.
    server.close();
    const frames = createFrameReader(socket);
    const ready = await withTimeout(frames.next(), SUPERVISOR_HANDSHAKE_TIMEOUT_MS);
    identity = readPosixSupervisorIdentityV1(identityPath);
    if (
      !identity ||
      ready.type !== 'ready' ||
      ready.dispatchId !== input.dispatchId ||
      ready.supervisorNonce !== input.supervisorNonce ||
      ready.dispatchIntentDigest !== input.dispatchIntentDigest ||
      ready.pid !== proc.pid ||
      ready.processGroupId !== proc.pid ||
      ready.processStartIdentity !== identity.processStartIdentity ||
      identity.pid !== proc.pid ||
      identity.dispatchIntentDigest !== input.dispatchIntentDigest ||
      readComparablePosixProcessStartIdentityV1(proc.pid) !== identity.processStartIdentity
    ) {
      throw new Error('POSIX supervisor handshake identity mismatch.');
    }
    const supervisorStarted = await input.lifecycle.recordExecutionSupervisorStarted(
      input.prepared,
      {
        dispatchId: input.dispatchId,
        dispatchIntentDigest: input.dispatchIntentDigest,
        supervisorPid: identity.pid,
        processGroupId: identity.processGroupId,
        processStartIdentity: identity.processStartIdentity,
      },
    );
    if (!supervisorStarted) {
      throw new Error('POSIX supervisor start acknowledgement failed.');
    }
    const outputAbort = new AbortController();
    const stdoutPromise = readWithProgress(
      proc.stdout,
      input.shell.onProgress ? (line) => input.shell.onProgress!(line, 'stdout') : undefined,
      outputAbort.signal,
    );
    const stderrPromise = readWithProgress(
      proc.stderr,
      input.shell.onProgress ? (line) => input.shell.onProgress!(line, 'stderr') : undefined,
      outputAbort.signal,
    );
    socket.write(
      `${JSON.stringify({
        type: 'go',
        dispatchId: input.dispatchId,
        supervisorNonce: input.supervisorNonce,
        dispatchIntentDigest: input.dispatchIntentDigest,
        argv: input.prepared.argv,
        cwd: input.prepared.cwd,
        env: input.prepared.env,
        stdin: input.prepared.stdin,
      })}\n`,
    );
    const terminal = await waitForTerminal(frames, input.shell.signal, input.timeoutMs);
    if (
      terminal.reason === 'completed' &&
      (terminal.frame.dispatchId !== input.dispatchId ||
        terminal.frame.supervisorNonce !== input.supervisorNonce ||
        terminal.frame.dispatchIntentDigest !== input.dispatchIntentDigest)
    ) {
      throw new Error('POSIX supervisor terminal identity mismatch.');
    }
    const termination =
      (await terminatePosixSupervisorV1(identity)) &&
      (await confirmPosixSupervisorLockReleasedV1(controlRoot, lockIdentity)) &&
      darwinSeatbeltDescendantContainmentUnproven(input.prepared) === false;
    socket.destroy();
    let stdout: string;
    let stderr: string;
    try {
      [stdout, stderr] = await withDeadline(
        Promise.all([stdoutPromise, stderrPromise]),
        SUPERVISOR_OUTPUT_DRAIN_MS,
        'POSIX supervisor output drain timed out.',
      );
    } catch (error) {
      outputAbort.abort();
      return failed(input.shell, error instanceof Error ? error.message : String(error), false);
    }
    if (terminal.reason === 'timeout') {
      return {
        cleanupConfirmed: termination,
        outcome: {
          ok: false,
          command: input.shell.command,
          exitCode: 124,
          stdout,
          stderr: append(stderr, `Command timed out after ${input.timeoutMs}ms.`),
          terminationReason: 'timed_out',
          processCleanup: cleanupEvidence(termination, true),
        },
      };
    }
    if (terminal.reason === 'cancelled') {
      return {
        cleanupConfirmed: termination,
        outcome: {
          ok: false,
          command: input.shell.command,
          exitCode: 130,
          stdout,
          stderr: append(stderr, 'Command cancelled by user.'),
          terminationReason: 'cancelled',
          processCleanup: cleanupEvidence(termination, true),
        },
      };
    }
    if (terminal.reason !== 'completed') {
      throw new Error('POSIX supervisor returned an invalid terminal state.');
    }
    if (terminal.frame.type === 'error') {
      return {
        cleanupConfirmed: termination,
        outcome: {
          ok: false,
          command: input.shell.command,
          exitCode: -1,
          stdout,
          stderr: append(stderr, terminal.frame.message),
          processCleanup: cleanupEvidence(termination, true),
        },
      };
    }
    const exitCode = terminal.frame.exitCode;
    return {
      cleanupConfirmed: termination,
      outcome: {
        ok: exitCode === 0 && termination,
        command: input.shell.command,
        exitCode: termination ? exitCode : -1,
        stdout,
        stderr: termination
          ? stderr
          : append(stderr, 'Sandbox process cleanup could not confirm descendant exit.'),
        processCleanup: cleanupEvidence(termination, true),
      },
    };
  } catch (error) {
    socket?.destroy();
    supervisorLock?.close();
    supervisorLock = undefined;
    let cleanupConfirmed = true;
    if (identity) {
      cleanupConfirmed =
        (await terminatePosixSupervisorV1(identity)) &&
        (await confirmPosixSupervisorLockReleasedV1(controlRoot, lockIdentity)) &&
        darwinSeatbeltDescendantContainmentUnproven(input.prepared) === false;
    } else if (proc) {
      // GO is never sent before an exact identity and durable start record.
      try {
        proc.kill('SIGKILL');
      } catch {
        // It may already have exited without ever owning the approved command.
      }
      cleanupConfirmed =
        (await confirmUnidentifiedSupervisorExit(proc)) &&
        (await confirmPosixSupervisorLockReleasedV1(controlRoot, lockIdentity)) &&
        darwinSeatbeltDescendantContainmentUnproven(input.prepared) === false;
    } else {
      cleanupConfirmed = await confirmPosixSupervisorLockReleasedV1(controlRoot, lockIdentity);
    }
    return failed(
      input.shell,
      error instanceof Error ? error.message : String(error),
      cleanupConfirmed,
    );
  } finally {
    socket?.destroy();
    supervisorLock?.close();
    if (server) await closeServer(server);
  }
}

export async function reconcilePosixSupervisorV1(input: {
  readonly runtimePath: string;
  readonly dispatch: Readonly<SandboxExecutionDispatchRecordV1>;
  /**
   * Process-group termination is not descendant containment. Every caller
   * must explicitly state whether an OS-owned authority for detached/session
   * descendants was proven; production recovery sets this false on Darwin
   * Seatbelt. Explicit true keeps this low-level helper useful for
   * process-group-only tests and diagnostics without a permissive default.
   */
  readonly descendantContainmentProven: boolean;
}): Promise<boolean> {
  const identityPath = posixSupervisorIdentityPathV1(input.runtimePath, input.dispatch.dispatchId);
  const identity = readPosixSupervisorIdentityV1(identityPath);
  const lockIdentity: PosixSupervisorLockIdentityV1 = {
    version: 1,
    dispatchId: input.dispatch.dispatchId,
    supervisorNonce: input.dispatch.supervisorNonce,
    dispatchIntentDigest: input.dispatch.dispatchIntentDigest,
  };
  if (!identity && input.dispatch.status === 'intent_recorded' && !existsSync(identityPath)) {
    // No supervisor identity means GO was never durably acknowledged; once
    // the inherited pre-spawn lock is re-acquired there is no descendant to
    // contain, so the explicit proof flag is intentionally irrelevant here.
    return confirmPosixSupervisorLockReleasedV1(input.runtimePath, lockIdentity);
  }
  if (
    !identity ||
    identity.dispatchId !== input.dispatch.dispatchId ||
    identity.supervisorNonce !== input.dispatch.supervisorNonce ||
    identity.dispatchIntentDigest !== input.dispatch.dispatchIntentDigest
  ) {
    return false;
  }
  if (
    input.dispatch.status === 'supervisor_started' &&
    (identity.pid !== input.dispatch.supervisorPid ||
      identity.processGroupId !== input.dispatch.processGroupId ||
      identity.processStartIdentity !== input.dispatch.processStartIdentity)
  ) {
    return false;
  }
  const groupCleanupConfirmed =
    (await terminatePosixSupervisorV1(identity)) &&
    (await confirmPosixSupervisorLockReleasedV1(input.runtimePath, lockIdentity));
  return groupCleanupConfirmed && input.descendantContainmentProven;
}

export async function terminatePosixSupervisorV1(
  identity: Readonly<PosixSupervisorIdentityV1>,
): Promise<boolean> {
  const groupAlive = isProcessGroupAlive(identity.processGroupId);
  if (!groupAlive) return true;
  const observed = readComparablePosixProcessStartIdentityV1(identity.pid);
  if (observed !== identity.processStartIdentity) {
    // The PID may have been reused. Never signal a group without its exact leader identity.
    return !(await waitForProcessGroupExit(identity.processGroupId, SUPERVISOR_FORCED_EXIT_MS));
  }
  try {
    process.kill(-identity.processGroupId, 'SIGTERM');
  } catch {
    return !isProcessGroupAlive(identity.processGroupId);
  }
  if (!(await waitForProcessGroupExit(identity.processGroupId, SUPERVISOR_GRACEFUL_EXIT_MS))) {
    return true;
  }
  try {
    process.kill(-identity.processGroupId, 'SIGKILL');
  } catch {
    // The group exited between observations.
  }
  return !(await waitForProcessGroupExit(identity.processGroupId, SUPERVISOR_FORCED_EXIT_MS));
}

type SupervisorFrame =
  | {
      type: 'ready';
      dispatchId: string;
      supervisorNonce: string;
      dispatchIntentDigest: string;
      pid: number;
      processGroupId: number;
      processStartIdentity: string;
    }
  | {
      type: 'exit';
      dispatchId: string;
      supervisorNonce: string;
      dispatchIntentDigest: string;
      exitCode: number;
    }
  | {
      type: 'error';
      dispatchId: string;
      supervisorNonce: string;
      dispatchIntentDigest: string;
      message: string;
    };

function createFrameReader(socket: Socket): { next(): Promise<SupervisorFrame> } {
  let buffer = '';
  const queue: SupervisorFrame[] = [];
  const waiters: Array<(frame: SupervisorFrame) => void> = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n');
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      let frame: SupervisorFrame;
      try {
        frame = JSON.parse(line) as SupervisorFrame;
      } catch {
        continue;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    }
  });
  return {
    next: () => {
      const frame = queue.shift();
      return frame
        ? Promise.resolve(frame)
        : new Promise<SupervisorFrame>((resolve) => waiters.push(resolve));
    },
  };
}

async function waitForTerminal(
  frames: ReturnType<typeof createFrameReader>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<
  | { reason: 'completed'; frame: Extract<SupervisorFrame, { type: 'exit' | 'error' }> }
  | { reason: 'timeout' | 'cancelled' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      frames.next().then((frame) => {
        if (frame.type === 'ready') throw new Error('Duplicate supervisor ready frame.');
        return { reason: 'completed' as const, frame };
      }),
      new Promise<{ reason: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ reason: 'timeout' }), timeoutMs);
      }),
      new Promise<{ reason: 'cancelled' }>((resolve) => {
        cancel = () => resolve({ reason: 'cancelled' });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

function controlSocketPath(runtimePath: string, dispatchId: string): string {
  const key = createHash('sha256').update(dispatchId).digest('hex').slice(0, 24);
  return join(runtimePath, `.s-${key.slice(0, 8)}`);
}

function listen(server: ReturnType<typeof createServer>, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('POSIX supervisor handshake timed out.')),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accepted) => {
    resolve = accepted;
  });
  return { promise, resolve };
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Darwin's public Seatbelt/launchd surface does not provide an invocation-
 * owned descendant handle. A process group therefore cannot certify cleanup
 * after a command calls setsid()/daemonizes. Keep this explicit gate beside
 * the supervisor so a future caller cannot accidentally treat PGID exit as
 * full descendant containment.
 */
function darwinSeatbeltDescendantContainmentUnproven(
  prepared: Readonly<PreparedSandboxExecutionV1>,
): boolean {
  return process.platform === 'darwin' && prepared.backend === 'seatbelt';
}

/** True while the group still exists. */
async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) return false;
    await Bun.sleep(10);
  }
  return isProcessGroupAlive(processGroupId);
}

async function confirmUnidentifiedSupervisorExit(
  proc: Bun.Subprocess<'inherit', 'pipe', 'pipe'>,
): Promise<boolean> {
  try {
    await withTimeout(proc.exited, SUPERVISOR_FORCED_EXIT_MS);
  } catch {
    return false;
  }
  return !(await waitForProcessGroupExit(proc.pid, SUPERVISOR_FORCED_EXIT_MS));
}

function cleanupEvidence(confirmed: boolean, forced: boolean) {
  return {
    confirmedExited: confirmed,
    gracefulRequested: true,
    forced,
    unconfirmedDescendantCount: confirmed ? 0 : 1,
  };
}

function failed(
  shell: ShellInput,
  stderr: string,
  cleanupConfirmed: boolean,
): { readonly outcome: ShellResult; readonly cleanupConfirmed: boolean } {
  return {
    cleanupConfirmed,
    outcome: {
      ok: false,
      command: shell.command,
      exitCode: -1,
      stdout: '',
      stderr,
      processCleanup: {
        confirmedExited: cleanupConfirmed,
        gracefulRequested: false,
        forced: false,
        unconfirmedDescendantCount: cleanupConfirmed ? 0 : 1,
      },
    },
  };
}

function append(stderr: string, message: string): string {
  return stderr.trimEnd() ? `${stderr.trimEnd()}\n${message}` : message;
}
