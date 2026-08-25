import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { PreparedSandboxExecution, RuntimeControlFrame } from '@kite/runtime-spi';
import {
  createRuntimeControlFrame,
  verifyRuntimeControlFrame,
} from '../kernel-adapter/control-frame';
import { readRuntimeHostProcessOutput } from './output';
import {
  type PosixSupervisorIdentity,
  posixSupervisorIdentityPath,
  readComparablePosixProcessStartIdentity,
  readPosixSupervisorIdentity,
} from './posix-supervisor-identity';
import {
  confirmPosixSupervisorLockReleased,
  createPosixSupervisorLock,
  type PosixSupervisorLockHandle,
  type PosixSupervisorLockIdentity,
} from './posix-supervisor-lock';
import { spawnRuntimeHostProcess } from './spawn';

// A standalone release executable cold-starts the full bundled graph before
// connecting. Five seconds is not reliable under normal CI or loaded-user
// contention; keep the startup bound finite without treating slow startup as
// forged process evidence.
const SUPERVISOR_HANDSHAKE_TIMEOUT_MS = 15_000;
const SUPERVISOR_GRACEFUL_EXIT_MS = 500;
const SUPERVISOR_FORCED_EXIT_MS = 2_000;
const SUPERVISOR_OUTPUT_DRAIN_MS = 2_000;
const POSIX_CONTROL_FRAME_DOMAIN_ = 'sandbox-posix-v1';
const POSIX_HOST_PEER_ID_ = 'runtime-host';
const POSIX_CHILD_PEER_ID_ = 'posix-supervisor-child';
const RUNTIME_CONTROL_FRAME_SCHEMA_ = 'kite.runtime-control-frame.v1' as const;

export interface RuntimeHostPreparedProcessInput {
  readonly prepared: Readonly<PreparedSandboxExecution>;
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Caller-owned ephemeral environment facts; never persisted. */
  readonly ephemeralEnvironment?: Readonly<Record<string, string>>;
  readonly lifecycle: RuntimeHostSandboxPreparationLifecycle;
  /** Host-internal phase marker invoked immediately before the GO frame write. */
  readonly onGoStarted?: () => void;
  /** Test-only proof that the packaged release entrypoint embeds supervisor mode. */
  readonly supervisorExecutablePath?: string;
}

export interface RuntimeHostPreparedProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly terminationReason?: 'timed_out' | 'cancelled';
  readonly processCleanup?: {
    readonly confirmedExited: boolean;
    readonly gracefulRequested: boolean;
    readonly forced: boolean;
    readonly unconfirmedDescendantCount: number;
  };
}

export interface RuntimeHostSandboxPreparationLifecycle {
  recordExecutionSupervisorStarted(
    prepared: Readonly<PreparedSandboxExecution>,
    input: {
      readonly dispatchId: string;
      readonly dispatchIntentDigest: string;
      readonly supervisorPid: number;
      readonly processGroupId: number;
      readonly processStartIdentity: string;
    },
  ): Promise<boolean>;
}

export interface RuntimeHostSandboxExecutionDispatchRecord {
  readonly attempt: number;
  readonly readyDigest: string;
  readonly planDigest: string;
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
  readonly status: 'intent_recorded' | 'supervisor_started';
  readonly supervisorPid?: number;
  readonly processGroupId?: number;
  readonly processStartIdentity?: string;
  readonly recordedAt: string;
  readonly supervisorStartedAt?: string;
}

export async function executePosixSupervised(input: RuntimeHostPreparedProcessInput): Promise<{
  readonly outcome: RuntimeHostPreparedProcessResult;
  readonly cleanupConfirmed: boolean;
}> {
  if (!isValidDispatchId(input.dispatchId)) {
    return failed('POSIX supervisor dispatch identity is invalid.', true);
  }
  // Capture the exact prepared object once. The SPI is not a hostile-process
  // boundary, but re-reading a mutable caller wrapper (or an accessor) after
  // validation would reintroduce a prepared-plan TOCTOU before GO.
  const prepared = input.prepared;
  try {
    assertPreparedProcessPlan(prepared);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), true);
  }
  const controlRoot = prepared.cleanup.recoveryPayload.controlRoot;
  const dataRoot = prepared.cleanup.recoveryPayload.dataRoot;
  if (
    typeof controlRoot !== 'string' ||
    typeof dataRoot !== 'string' ||
    controlRoot === dataRoot ||
    process.platform === 'win32'
  ) {
    return failed('POSIX supervisor runtime identity is unavailable.', true);
  }
  let commandEnvironment: Readonly<Record<string, string>> | null;
  try {
    commandEnvironment = mergePreparedProcessEnvironment(
      prepared.env,
      input.ephemeralEnvironment,
      dataRoot,
    );
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), true);
  }
  const socketPath = controlSocketPath(controlRoot, input.dispatchId);
  const identityPath = posixSupervisorIdentityPath(controlRoot, input.dispatchId);
  let server: ReturnType<typeof createServer> | undefined;
  let socket: Socket | undefined;
  let proc: Bun.Subprocess<'inherit', 'pipe', 'pipe'> | undefined;
  let identity: PosixSupervisorIdentity | undefined;
  let supervisorLock: PosixSupervisorLockHandle | undefined;
  const lockIdentity: PosixSupervisorLockIdentity = {
    version: 1,
    dispatchId: input.dispatchId,
    supervisorNonce: input.supervisorNonce,
    dispatchIntentDigest: input.dispatchIntentDigest,
  };
  try {
    if (existsSync(socketPath)) {
      return failed('POSIX supervisor control identity already exists.', false);
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
    supervisorLock = createPosixSupervisorLock(controlRoot, lockIdentity);
    proc = spawnRuntimeHostProcess(
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
        // The supervisor gets only fixed infrastructure values. The approved
        // ephemeral overlay is merged into the GO frame for the actual child
        // after durable preparation; it never enters the prepared plan or
        // recovery artifact.
        env: buildPosixSupervisorEnvironment(dataRoot),
      },
    );
    supervisorLock.close();
    supervisorLock = undefined;
    socket = await withTimeout(connection.promise, SUPERVISOR_HANDSHAKE_TIMEOUT_MS);
    // Only the first exact control connection is admissible. Stop accepting
    // before reading its handshake so later peers fail immediately.
    server.close();
    const frames = createFrameReader(socket, input.dispatchId);
    const ready = await withTimeout(frames.next(), SUPERVISOR_HANDSHAKE_TIMEOUT_MS);
    identity = readPosixSupervisorIdentity(identityPath);
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
      readComparablePosixProcessStartIdentity(proc.pid) !== identity.processStartIdentity
    ) {
      throw new Error('POSIX supervisor handshake identity mismatch.');
    }
    const supervisorStarted = await input.lifecycle.recordExecutionSupervisorStarted(prepared, {
      dispatchId: input.dispatchId,
      dispatchIntentDigest: input.dispatchIntentDigest,
      supervisorPid: identity.pid,
      processGroupId: identity.processGroupId,
      processStartIdentity: identity.processStartIdentity,
    });
    if (!supervisorStarted) {
      throw new Error('POSIX supervisor start acknowledgement failed.');
    }
    const outputAbort = new AbortController();
    const stdoutPromise = readRuntimeHostProcessOutput(
      proc.stdout,
      input.onProgress ? (line) => input.onProgress!(line, 'stdout') : undefined,
      outputAbort.signal,
    );
    const stderrPromise = readRuntimeHostProcessOutput(
      proc.stderr,
      input.onProgress ? (line) => input.onProgress!(line, 'stderr') : undefined,
      outputAbort.signal,
    );
    // From this point forward a transport error cannot prove that the command
    // did not start. The neutral Host adapter must therefore classify a lost
    // terminal as post-GO unknown rather than a retryable pre-GO failure.
    input.onGoStarted?.();
    socket.write(
      `${JSON.stringify(
        createRuntimeControlFrame({
          schema: RUNTIME_CONTROL_FRAME_SCHEMA_,
          domain: POSIX_CONTROL_FRAME_DOMAIN_,
          peerId: POSIX_HOST_PEER_ID_,
          invocationId: input.dispatchId,
          sequence: 0,
          payload: {
            type: 'go',
            dispatchId: input.dispatchId,
            supervisorNonce: input.supervisorNonce,
            dispatchIntentDigest: input.dispatchIntentDigest,
            argv: prepared.argv,
            cwd: prepared.cwd,
            env: commandEnvironment,
            stdin: prepared.stdin,
          },
        }),
      )}\n`,
    );
    const terminal = await waitForTerminal(frames, input.signal, input.timeoutMs);
    if (
      terminal.reason === 'completed' &&
      (terminal.frame.dispatchId !== input.dispatchId ||
        terminal.frame.supervisorNonce !== input.supervisorNonce ||
        terminal.frame.dispatchIntentDigest !== input.dispatchIntentDigest)
    ) {
      throw new Error('POSIX supervisor terminal identity mismatch.');
    }
    const termination =
      (await terminatePosixSupervisor(identity)) &&
      (await confirmPosixSupervisorLockReleased(controlRoot, lockIdentity));
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
      return failed(error instanceof Error ? error.message : String(error), false);
    }
    if (terminal.reason === 'timeout') {
      return {
        cleanupConfirmed: termination,
        outcome: {
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
        (await terminatePosixSupervisor(identity)) &&
        (await confirmPosixSupervisorLockReleased(controlRoot, lockIdentity));
    } else if (proc) {
      // GO is never sent before an exact identity and durable start record.
      try {
        proc.kill('SIGKILL');
      } catch {
        // It may already have exited without ever owning the approved command.
      }
      cleanupConfirmed =
        (await confirmUnidentifiedSupervisorExit(proc)) &&
        (await confirmPosixSupervisorLockReleased(controlRoot, lockIdentity));
    } else {
      cleanupConfirmed = await confirmPosixSupervisorLockReleased(controlRoot, lockIdentity);
    }
    return failed(error instanceof Error ? error.message : String(error), cleanupConfirmed);
  } finally {
    socket?.destroy();
    supervisorLock?.close();
    if (server) await closeServer(server);
  }
}

function mergePreparedProcessEnvironment(
  preparedEnvironment: Readonly<Record<string, string>> | null,
  ephemeralEnvironment: Readonly<Record<string, string>> | undefined,
  dataRoot: string,
): Readonly<Record<string, string>> | null {
  const overlay = ephemeralEnvironment ?? Object.freeze({});
  const fixedAndOverlay = buildPosixSupervisorEnvironment(dataRoot, overlay);
  if (preparedEnvironment === null) {
    return Object.keys(overlay).length === 0 ? null : Object.freeze(fixedAndOverlay);
  }
  if (
    typeof preparedEnvironment !== 'object' ||
    preparedEnvironment === null ||
    Array.isArray(preparedEnvironment)
  ) {
    throw new Error('Prepared process environment has an invalid shape.');
  }
  for (const [key, value] of Object.entries(preparedEnvironment)) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || typeof value !== 'string') {
      throw new Error('Prepared process environment contains an invalid entry.');
    }
  }
  for (const key of Object.keys(overlay)) {
    if (Object.hasOwn(preparedEnvironment, key)) {
      throw new Error(`Ephemeral process environment conflicts with prepared key '${key}'.`);
    }
  }
  return Object.freeze({ ...preparedEnvironment, ...overlay });
}

function assertPreparedProcessPlan(
  prepared: unknown,
): asserts prepared is Readonly<PreparedSandboxExecution> {
  const record = assertFrozenRecord(prepared, 'prepared process plan');
  assertFrozenStringArray(record.argv, 'prepared process argv');
  assertFrozenStringArray(record.approvedArgv, 'prepared approved argv');
  if (typeof record.cwd !== 'string') {
    throw new Error('Prepared process plan cwd is invalid.');
  }
  if (record.stdin !== null && typeof record.stdin !== 'string') {
    throw new Error('Prepared process plan stdin is invalid.');
  }
  const capabilities = assertFrozenRecord(
    record.backendCapabilities,
    'prepared backend capabilities',
  );
  assertFrozenStringRecord(capabilities.filesystem, 'prepared filesystem capabilities');
  assertFrozenStringRecord(capabilities.network, 'prepared network capabilities');
  const cleanup = assertFrozenRecord(record.cleanup, 'prepared cleanup handle');
  assertFrozenPrimitiveRecord(cleanup.recoveryPayload, 'prepared cleanup recovery payload');
  if (record.env !== null) assertFrozenStringRecord(record.env, 'prepared process environment');
}

function assertFrozenRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.isFrozen(value)
  ) {
    throw new Error(`${label} must be a frozen object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertFrozenStringArray(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    !Object.isFrozen(value) ||
    value.some((part) => typeof part !== 'string')
  ) {
    throw new Error(`${label} must be a frozen string array.`);
  }
}

function assertFrozenStringRecord(value: unknown, label: string): void {
  const record = assertFrozenRecord(value, label);
  if (Object.values(record).some((part) => typeof part !== 'string')) {
    throw new Error(`${label} must contain only strings.`);
  }
}

function assertFrozenPrimitiveRecord(value: unknown, label: string): void {
  const record = assertFrozenRecord(value, label);
  if (
    Object.values(record).some(
      (part) =>
        part !== null &&
        typeof part !== 'string' &&
        typeof part !== 'number' &&
        typeof part !== 'boolean',
    )
  ) {
    throw new Error(`${label} must contain only JSON scalar values.`);
  }
}

/** Supervisors start with fixed infrastructure values plus one ephemeral overlay. */
export function buildPosixSupervisorEnvironment(
  dataRoot: string,
  ephemeralEnvironment: Readonly<Record<string, string>> = Object.freeze({}),
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: dataRoot,
  };
  if (
    ephemeralEnvironment === null ||
    typeof ephemeralEnvironment !== 'object' ||
    Array.isArray(ephemeralEnvironment) ||
    !Object.isFrozen(ephemeralEnvironment)
  ) {
    throw new Error('Runtime Host ephemeral process environment must be a frozen object.');
  }
  for (const [key, value] of Object.entries(ephemeralEnvironment)) {
    if (FIXED_PROCESS_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`Runtime Host ephemeral environment cannot override '${key}'.`);
    }
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || typeof value !== 'string') {
      throw new Error('Runtime Host ephemeral process environment contains an invalid entry.');
    }
    env[key] = value;
  }
  return env;
}

const FIXED_PROCESS_ENVIRONMENT_KEYS = new Set(['PATH', 'LANG', 'LC_ALL', 'TMPDIR']);
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function reconcilePosixSupervisor(input: {
  readonly runtimePath: string;
  readonly dispatch: Readonly<RuntimeHostSandboxExecutionDispatchRecord>;
  /**
   * Process-group termination is not descendant containment. Every caller
   * must explicitly state whether an OS-owned containment for detached/session
   * descendants was proven; production recovery sets this false on Darwin
   * Seatbelt. Explicit true keeps this low-level helper useful for
   * process-group-only tests and diagnostics without a permissive default.
   */
  readonly descendantContainmentProven: boolean;
}): Promise<boolean> {
  const identityPath = posixSupervisorIdentityPath(input.runtimePath, input.dispatch.dispatchId);
  const identity = readPosixSupervisorIdentity(identityPath);
  const lockIdentity: PosixSupervisorLockIdentity = {
    version: 1,
    dispatchId: input.dispatch.dispatchId,
    supervisorNonce: input.dispatch.supervisorNonce,
    dispatchIntentDigest: input.dispatch.dispatchIntentDigest,
  };
  if (!identity && input.dispatch.status === 'intent_recorded' && !existsSync(identityPath)) {
    // No supervisor identity means GO was never durably acknowledged; once
    // the inherited pre-spawn lock is re-acquired there is no descendant to
    // contain, so the explicit proof flag is intentionally irrelevant here.
    return confirmPosixSupervisorLockReleased(input.runtimePath, lockIdentity);
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
    (await terminatePosixSupervisor(identity)) &&
    (await confirmPosixSupervisorLockReleased(input.runtimePath, lockIdentity));
  return groupCleanupConfirmed && input.descendantContainmentProven;
}

export async function terminatePosixSupervisor(
  identity: Readonly<PosixSupervisorIdentity>,
): Promise<boolean> {
  const groupAlive = isProcessGroupAlive(identity.processGroupId);
  if (!groupAlive) return true;
  const observed = readComparablePosixProcessStartIdentity(identity.pid);
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

function createFrameReader(
  socket: Socket,
  invocationId: string,
): { next(): Promise<SupervisorFrame> } {
  let buffer = '';
  let lastSequence = -1;
  const queue: Array<SupervisorFrame | Error> = [];
  const waiters: Array<{
    resolve: (frame: SupervisorFrame) => void;
    reject: (error: Error) => void;
  }> = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n');
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      let frame: SupervisorFrame;
      try {
        const encoded = JSON.parse(line) as Record<string, unknown>;
        const wire = encoded as unknown as RuntimeControlFrame<SupervisorFrame>;
        const payload = verifyRuntimeControlFrame<SupervisorFrame>({
          frame: wire,
          expectedDomain: POSIX_CONTROL_FRAME_DOMAIN_,
          expectedPeerId: POSIX_CHILD_PEER_ID_,
          expectedInvocationId: invocationId,
          lastSequence,
        });
        lastSequence = wire.sequence;
        frame = assertSupervisorFrame(payload);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const waiter = waiters.shift();
        if (waiter) waiter.reject(failure);
        else queue.push(failure);
        continue;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else queue.push(frame);
    }
  });
  return {
    next: () => {
      const frame = queue.shift();
      if (frame instanceof Error) return Promise.reject(frame);
      return frame
        ? Promise.resolve(frame)
        : new Promise<SupervisorFrame>((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

function assertSupervisorFrame(value: unknown): SupervisorFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('POSIX supervisor control frame payload is invalid.');
  }
  const frame = value as Record<string, unknown>;
  if (frame.type === 'ready') {
    assertExactKeys(frame, [
      'type',
      'dispatchId',
      'supervisorNonce',
      'dispatchIntentDigest',
      'pid',
      'processGroupId',
      'processStartIdentity',
    ]);
    if (
      typeof frame.dispatchId !== 'string' ||
      typeof frame.supervisorNonce !== 'string' ||
      typeof frame.dispatchIntentDigest !== 'string' ||
      !Number.isSafeInteger(frame.pid) ||
      !Number.isSafeInteger(frame.processGroupId) ||
      typeof frame.processStartIdentity !== 'string'
    )
      throw new Error('POSIX supervisor ready payload is invalid.');
    return frame as SupervisorFrame;
  }
  if (frame.type === 'exit') {
    assertExactKeys(frame, [
      'type',
      'dispatchId',
      'supervisorNonce',
      'dispatchIntentDigest',
      'exitCode',
    ]);
    if (
      typeof frame.dispatchId !== 'string' ||
      typeof frame.supervisorNonce !== 'string' ||
      typeof frame.dispatchIntentDigest !== 'string' ||
      !Number.isSafeInteger(frame.exitCode)
    )
      throw new Error('POSIX supervisor exit payload is invalid.');
    return frame as SupervisorFrame;
  }
  if (frame.type === 'error') {
    assertExactKeys(frame, [
      'type',
      'dispatchId',
      'supervisorNonce',
      'dispatchIntentDigest',
      'message',
    ]);
    if (
      typeof frame.dispatchId !== 'string' ||
      typeof frame.supervisorNonce !== 'string' ||
      typeof frame.dispatchIntentDigest !== 'string' ||
      typeof frame.message !== 'string'
    )
      throw new Error('POSIX supervisor error payload is invalid.');
    return frame as SupervisorFrame;
  }
  throw new Error('POSIX supervisor control frame type is invalid.');
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error('POSIX supervisor control frame contains unknown fields.');
  }
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

function isValidDispatchId(dispatchId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(dispatchId);
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
  stderr: string,
  cleanupConfirmed: boolean,
): {
  readonly outcome: RuntimeHostPreparedProcessResult;
  readonly cleanupConfirmed: boolean;
} {
  return {
    cleanupConfirmed,
    outcome: {
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
