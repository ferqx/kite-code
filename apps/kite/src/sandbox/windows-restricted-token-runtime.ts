import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ShellInput, ShellResult } from '@kite/builtin-runtime/sandbox';
import {
  appendTimeoutMessage,
  cleanupWindowsSandboxRuntimeDirNoSpawnV1,
  type RestrictedTokenInvocationRequestV1,
  resolveWindowsSandboxRunnerV1,
  timeoutMessage,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
  type WindowsRestrictedTokenPreparedTransportV1,
  type WindowsSandboxRunnerV1,
} from '@kite/builtin-runtime/sandbox';
import {
  BoundedOutputBuffer,
  BoundedProgressLineBuffer,
  readRuntimeHostProcessOutputV1 as readWithProgress,
  spawnRuntimeHostProcessV1,
} from '@kite/runtime-host';

/**
 * The direct restricted-token runner has no large workspace staging phase.
 * This is only a small outer watchdog in case its control plane wedges after
 * the shell's own timeout has elapsed.
 */
const WINDOWS_RESTRICTED_TOKEN_CONTROL_PLANE_GRACE_MS = 5_000;
const WINDOWS_RESTRICTED_TOKEN_WATCHDOG_MS = 5_000;

interface ExecutionReceipt {
  version: number;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  peakProcesses: number;
  activeProcessLimit: number;
  cleanupConfirmed: boolean;
  invocationName: string;
  error: string | null;
}

const WINDOWS_SANDBOX_AUTHORITY_DOMAIN_V1 = 'kite-windows-sandbox-frame-v1';
const WINDOWS_SANDBOX_AUTHORITY_HOST_PEER_ID_V1 = 'host';
const WINDOWS_SANDBOX_AUTHORITY_RUNNER_PEER_ID_V1 = 'runner';
const WINDOWS_SANDBOX_AUTHORITY_BOOTSTRAP_MAGIC_V1 = 'KITEKEY1';
const WINDOWS_SANDBOX_AUTHORITY_KEY_BYTES_V1 = 32;
const WINDOWS_SANDBOX_AUTHORITY_KEY_ID_BYTES_V1 = 71;
const WINDOWS_SANDBOX_AUTHORITY_BOOTSTRAP_BYTES_V1 =
  WINDOWS_SANDBOX_AUTHORITY_BOOTSTRAP_MAGIC_V1.length +
  WINDOWS_SANDBOX_AUTHORITY_KEY_BYTES_V1 +
  WINDOWS_SANDBOX_AUTHORITY_KEY_ID_BYTES_V1;

/** Ephemeral key custody for one real Host/native child-process boundary. */
export interface WindowsSandboxAuthoritySessionV1 {
  readonly invocationId: string;
  readonly keyId: `sha256:${string}`;
  readonly key: Uint8Array;
  hostSequence: number;
  runnerSequence: number;
}

type AuthorityFrameTypeV1 =
  | 'request'
  | 'ready'
  | 'go'
  | 'cancel'
  | 'log'
  | 'stdout'
  | 'stderr'
  | 'exit';

interface AuthorityFrameV1 {
  type: AuthorityFrameTypeV1;
  version: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
  invocationId: string;
  peerId: 'host' | 'runner';
  keyId: string;
  sequence: number;
  payloadBase64: string;
  authenticator: string;
}

export function createWindowsSandboxAuthoritySessionV1(
  input: Readonly<{
    invocationId: string;
    supervisorNonce: string;
  }>,
): WindowsSandboxAuthoritySessionV1 {
  if (!/^kitecode\.[a-z0-9]{32}$/u.test(input.invocationId)) {
    throw new Error('Windows sandbox authority invocation identity is invalid.');
  }
  if (input.supervisorNonce.length === 0) {
    throw new Error('Windows supervisor nonce is invalid.');
  }
  const key = new Uint8Array(randomBytes(32));
  return {
    invocationId: input.invocationId,
    keyId: `sha256:${createHash('sha256').update(key).digest('hex')}`,
    key,
    hostSequence: 0,
    runnerSequence: 0,
  };
}

export interface WindowsRestrictedTokenPreparedExecutionHooksV1 {
  /** Runs after the inert runner starts and before its first user-command frame. */
  readonly acknowledgeSupervisorStarted: (input: {
    readonly supervisorPid: number;
    readonly processGroupId: number;
    readonly processStartIdentity: string;
  }) => Promise<boolean>;
  /** Exact phase marker after bootstrap + authenticated request write succeeds. */
  readonly onGoStarted: () => void;
}

export interface WindowsSandboxAuthorityInputV1 {
  readonly supervisorNonce: string;
}

/** Runtime consumer adapter for the framed native runner. */
export async function executeWindowsRestrictedTokenPreparedV1(
  input: ShellInput,
  prepared: WindowsRestrictedTokenPreparedTransportV1,
  hooks: Readonly<WindowsRestrictedTokenPreparedExecutionHooksV1>,
  authorityInput: WindowsSandboxAuthorityInputV1,
): Promise<ShellResult> {
  const { runner, request, workspaceRoot, runtimeRoot } = prepared;
  let authority: WindowsSandboxAuthoritySessionV1;
  try {
    authority = createWindowsSandboxAuthoritySessionV1({
      ...authorityInput,
      invocationId: request.invocationName,
    });
  } catch (error) {
    return reject(
      input,
      `Sandbox runner authority setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawnRuntimeHostProcessV1([runner.path], {
      cwd: workspaceRoot,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    authority.key.fill(0);
    const runtimeCleaned = cleanupWindowsSandboxRuntimeDirNoSpawnV1(runtimeRoot);
    const message = `Sandbox runner launch failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return reject(
      input,
      runtimeCleaned ? message : appendTerminalMessage(message, 'Sandbox runtime cleanup failed.'),
    );
  }

  const timeoutMs = request.timeoutMs;
  let timedOut = false;
  let cancelled = false;
  let runnerKilled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let outputStop: AbortController | undefined;
  let outcome: ShellResult | undefined;
  let receiptSeen = false;
  let receiptCleanupConfirmed = false;

  const terminate = (reason: 'timeout' | 'cancelled') => {
    if (timedOut || cancelled) return;
    timedOut = reason === 'timeout';
    cancelled = reason === 'cancelled';
    outputStop?.abort();
    void sendCancelFrame(proc, authority);
  };
  const cancel = () => terminate('cancelled');

  try {
    if (!proc.stdin) throw new Error('runner stdin unavailable');
    const processStartIdentity = `windows-restricted-token:${proc.pid}:${request.invocationName}`;
    const bootstrap = encodeWindowsSandboxAuthorityBootstrapV1(authority);
    const requestFrame = encodeAuthorityFrameV1('request', request, authority, 'host');
    const initialInput = Buffer.concat([bootstrap, requestFrame]);
    try {
      writeRunnerInput(proc.stdin, initialInput);
    } finally {
      bootstrap.fill(0);
      requestFrame.fill(0);
      initialInput.fill(0);
    }
    timeoutId = setTimeout(
      () => terminate('timeout'),
      timeoutMs + WINDOWS_RESTRICTED_TOKEN_CONTROL_PLANE_GRACE_MS,
    );
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();

    outputStop = new AbortController();
    const stdoutAccumulator = new BoundedOutputBuffer();
    const stderrAccumulator = new BoundedOutputBuffer();
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const stdoutProgress = new BoundedProgressLineBuffer();
    const stderrProgress = new BoundedProgressLineBuffer();
    const runnerStderr = readWithProgress(
      proc.stderr as ReadableStream<Uint8Array>,
      undefined,
      outputStop.signal,
    );
    const frames = readFrames(proc.stdout as ReadableStream<Uint8Array>)[Symbol.asyncIterator]();
    const first = await nextRunnerFrameWithTimeout(
      frames,
      WINDOWS_RESTRICTED_TOKEN_CONTROL_PLANE_GRACE_MS,
    );
    if (first.done) throw new Error('Windows sandbox runner exited before authenticated ready.');
    const ready = decodeWindowsSandboxRunnerFrameV1(first.value, request.invocationName, authority);
    if (ready.type !== 'ready') {
      throw new Error('Windows sandbox runner did not authenticate readiness before GO.');
    }
    if (
      !(await hooks.acknowledgeSupervisorStarted({
        supervisorPid: proc.pid,
        processGroupId: proc.pid,
        processStartIdentity,
      }))
    ) {
      throw new Error('Windows restricted-token supervisor start acknowledgement failed.');
    }
    const goFrame = encodeAuthorityFrameV1(
      'go',
      { invocationName: request.invocationName, supervisorAcknowledged: true },
      authority,
      'host',
    );
    try {
      writeRunnerInput(proc.stdin, goFrame);
    } finally {
      goFrame.fill(0);
    }
    hooks.onGoStarted();
    const framePromise = (async () => {
      let receipt: ExecutionReceipt | undefined;
      try {
        while (true) {
          const next = await frames.next();
          if (next.done) break;
          const payload = next.value;
          const frame = decodeWindowsSandboxRunnerFrameV1(
            payload,
            request.invocationName,
            authority,
          );
          if (frame.type === 'stdout') {
            onOutputFrame(
              input,
              Buffer.from(frame.data, 'base64'),
              'stdout',
              stdoutDecoder,
              stdoutAccumulator,
              stdoutProgress,
            );
          } else if (frame.type === 'stderr') {
            onOutputFrame(
              input,
              Buffer.from(frame.data, 'base64'),
              'stderr',
              stderrDecoder,
              stderrAccumulator,
              stderrProgress,
            );
          } else if (frame.type === 'exit') {
            receipt = frame.receipt;
            closeRunnerInput(proc.stdin);
            break;
          }
        }
      } finally {
        flushOutputFrames(input, 'stdout', stdoutDecoder, stdoutAccumulator, stdoutProgress);
        flushOutputFrames(input, 'stderr', stderrDecoder, stderrAccumulator, stderrProgress);
      }
      return receipt;
    })();

    const watchdogId = setTimeout(
      () => {
        try {
          proc.kill();
          runnerKilled = true;
        } catch {
          // The runner already exited.
        }
      },
      timeoutMs +
        WINDOWS_RESTRICTED_TOKEN_CONTROL_PLANE_GRACE_MS +
        WINDOWS_RESTRICTED_TOKEN_WATCHDOG_MS,
    );
    watchdogId.unref?.();
    let receipt: ExecutionReceipt | undefined;
    let runnerDiag = '';
    try {
      receipt = await framePromise;
      // Keep the watchdog armed until both pipes settle. A malformed runner
      // can close stdout without an exit receipt while retaining stderr and
      // its Job Object; clearing it after stdout alone would reintroduce an
      // unbounded control-plane wait.
      runnerDiag = (await runnerStderr).trim();
    } finally {
      clearTimeout(watchdogId);
    }
    receiptSeen = receipt !== undefined;
    receiptCleanupConfirmed = receipt?.cleanupConfirmed === true && receipt.error === null;
    if (timeoutId) clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', cancel);

    if (!receipt) {
      // Final cleanup kills and bounded-waits the runner before it invokes
      // the ACL recovery executable. Do not await `proc.exited` here: a
      // runner that closed stdout can otherwise wedge this invocation.
      runnerKilled = true;
      outcome = {
        ok: false,
        command: input.command,
        exitCode: timedOut ? 124 : cancelled ? 130 : -1,
        stdout: stdoutAccumulator.value(),
        stderr: timedOut
          ? appendTimeoutMessage(stderrAccumulator.value(), timeoutMs)
          : cancelled
            ? appendTerminalMessage(
                runnerDiag || stderrAccumulator.value(),
                'Command cancelled by user.',
              )
            : runnerDiag
              ? appendTerminalMessage(
                  runnerDiag,
                  'Sandbox runner exited without a receipt; process cleanup could not be confirmed.',
                )
              : 'Sandbox runner exited without a receipt; process cleanup could not be confirmed.',
        ...(timedOut ? { terminationReason: 'timed_out' as const } : {}),
        ...(cancelled ? { terminationReason: 'cancelled' as const } : {}),
      };
      return outcome;
    }

    timedOut ||= receipt.timedOut;
    cancelled ||= receipt.cancelled;
    const stdout = stdoutAccumulator.value();
    const stderr = stderrAccumulator.value();
    const cleanupConfirmed = receipt.cleanupConfirmed && receipt.error === null;
    const processCleanup = {
      confirmedExited: cleanupConfirmed,
      gracefulRequested: !receipt.timedOut && !receipt.cancelled,
      forced: receipt.timedOut || receipt.cancelled,
      unconfirmedDescendantCount: cleanupConfirmed ? 0 : 1,
    };
    if (receipt.error) {
      outcome = {
        ok: false,
        command: input.command,
        exitCode: -1,
        stdout,
        stderr: appendTerminalMessage(stderr, `Sandbox error (${receipt.error}).`),
        processCleanup,
      };
      return outcome;
    }
    if (!receipt.cleanupConfirmed) {
      outcome = {
        ok: false,
        command: input.command,
        exitCode: timedOut ? 124 : cancelled ? 130 : receipt.exitCode,
        stdout,
        stderr: appendTerminalMessage(
          stderr,
          'Sandbox process cleanup could not confirm descendant exit.',
        ),
        processCleanup,
      };
      return outcome;
    }
    outcome = {
      ok: !timedOut && !cancelled && receipt.exitCode === 0,
      command: input.command,
      exitCode: timedOut ? 124 : cancelled ? 130 : receipt.exitCode,
      stdout,
      stderr: timedOut
        ? appendTimeoutMessage(stderr, timeoutMs)
        : cancelled
          ? appendTerminalMessage(stderr, 'Command cancelled by user.')
          : stderr,
      processCleanup,
      ...(timedOut ? { terminationReason: 'timed_out' as const } : {}),
      ...(cancelled ? { terminationReason: 'cancelled' as const } : {}),
    };
    return outcome;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', cancel);
    const baseError = error instanceof Error ? error.message : String(error);
    outcome = {
      ok: false,
      command: input.command,
      exitCode: timedOut ? 124 : cancelled ? 130 : -1,
      stdout: '',
      stderr: timedOut
        ? timeoutMessage(timeoutMs)
        : cancelled
          ? 'Command cancelled by user.'
          : baseError,
      ...(timedOut ? { terminationReason: 'timed_out' as const } : {}),
      ...(cancelled ? { terminationReason: 'cancelled' as const } : {}),
    };
    return outcome;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', cancel);
    const recoveryRequired = runnerKilled || !receiptSeen || !receiptCleanupConfirmed;
    let recovered = !recoveryRequired;
    let runnerShutdownConfirmed = !recoveryRequired;
    if (recoveryRequired) {
      // The runner owns the Job Object. Its exit closes the Job and is the
      // prerequisite for an out-of-process ACL recovery helper; otherwise
      // recovery could revoke an ACE while a restricted child is still live.
      try {
        proc.kill();
        runnerKilled = true;
      } catch {
        // The runner may already have exited.
      }
      runnerShutdownConfirmed = await waitForRunnerExit(proc, 5_000);
      if (runnerShutdownConfirmed) {
        recovered = await recoverRestrictedTokenAcl(runner, request, workspaceRoot, authorityInput);
        if (!recovered && outcome) {
          outcome.ok = false;
          outcome.exitCode = -1;
          outcome.stderr = appendTerminalMessage(
            outcome.stderr,
            'Sandbox ACL crash recovery failed.',
          );
        }
      } else {
        recovered = false;
        if (outcome) {
          outcome.ok = false;
          outcome.exitCode = -1;
          outcome.stderr = appendTerminalMessage(
            outcome.stderr,
            'Sandbox runner shutdown could not be confirmed; ACL crash recovery was skipped.',
          );
        }
      }
    } else {
      try {
        proc.kill();
      } catch {
        // The runner already exited.
      }
    }

    // Only a native receipt proves the restricted Job was empty. A recovery
    // helper can revoke the invocation ACL after the runner exits, but it
    // must not race a surviving child by deleting its runtime directory.
    if (outcome && receiptCleanupConfirmed) {
      if (!cleanupWindowsSandboxRuntimeDirNoSpawnV1(runtimeRoot)) {
        outcome.ok = false;
        outcome.exitCode = -1;
        outcome.stderr = appendTerminalMessage(outcome.stderr, 'Sandbox runtime cleanup failed.');
      }
    } else if (outcome && (!recovered || !runnerShutdownConfirmed)) {
      outcome.stderr = appendTerminalMessage(
        outcome.stderr,
        'Sandbox runtime retained because cleanup was not confirmed.',
      );
    }
    authority.key.fill(0);
  }
}

function reject(input: ShellInput, stderr: string): ShellResult {
  return {
    ok: false,
    command: input.command,
    exitCode: -1,
    stdout: '',
    stderr,
  };
}

async function waitForRunnerExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
async function recoverRestrictedTokenAcl(
  runner: WindowsSandboxRunnerV1,
  request: RestrictedTokenInvocationRequestV1,
  cwd: string,
  authorityInput: WindowsSandboxAuthorityInputV1,
): Promise<boolean> {
  let cleanup: ReturnType<typeof Bun.spawn> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let authority: WindowsSandboxAuthoritySessionV1;
  try {
    authority = createWindowsSandboxAuthoritySessionV1({
      ...authorityInput,
      invocationId: request.invocationName,
    });
  } catch {
    return false;
  }
  try {
    cleanup = spawnRuntimeHostProcessV1([runner.path, '--cleanup'], {
      cwd,
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (!cleanup.stdin) return false;
    const bootstrap = encodeWindowsSandboxAuthorityBootstrapV1(authority);
    const requestFrame = encodeAuthorityFrameV1('request', request, authority, 'host');
    const initialInput = Buffer.concat([bootstrap, requestFrame]);
    try {
      writeRunnerInput(cleanup.stdin, initialInput);
    } finally {
      bootstrap.fill(0);
      requestFrame.fill(0);
      initialInput.fill(0);
    }
    const timeout = new Promise<false>((resolve) => {
      timeoutId = setTimeout(() => {
        try {
          cleanup?.kill();
        } catch {
          // Already exited.
        }
        resolve(false);
      }, 5_000);
      timeoutId.unref?.();
    });
    const exitCode = await Promise.race([cleanup.exited.then((code) => code === 0), timeout]);
    return exitCode;
  } catch {
    try {
      cleanup?.kill();
    } catch {
      // Already exited.
    }
    return false;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    authority.key.fill(0);
  }
}

/** Runtime crash-recovery consumer; the Provider itself never launches cleanup processes. */
export async function reconcileWindowsRestrictedTokenPreparedV1(
  prepared: WindowsRestrictedTokenPreparedTransportV1,
  authorityInput: WindowsSandboxAuthorityInputV1,
): Promise<boolean> {
  const current = resolveWindowsSandboxRunnerV1();
  if (
    !current ||
    current.path !== prepared.runner.path ||
    current.version !== prepared.runner.version ||
    current.digest !== prepared.runner.digest ||
    current.minimumWindowsVersion !== prepared.runner.minimumWindowsVersion ||
    current.protocolVersion !== prepared.runner.protocolVersion ||
    current.shellRuntimePath !== prepared.runner.shellRuntimePath ||
    current.shellRuntime !== prepared.runner.shellRuntime ||
    current.shellRuntimeDigest !== prepared.runner.shellRuntimeDigest ||
    current.coreutilsDigest !== prepared.runner.coreutilsDigest ||
    prepared.request.version !== WINDOWS_SANDBOX_PROTOCOL_VERSION ||
    prepared.request.cwd !== prepared.workspaceRoot ||
    prepared.request.runtimeRoot !== prepared.runtimeRoot
  ) {
    return false;
  }
  return recoverRestrictedTokenAcl(
    prepared.runner,
    prepared.request,
    prepared.workspaceRoot,
    authorityInput,
  );
}

function onOutputFrame(
  input: ShellInput,
  bytes: Uint8Array,
  stream: 'stdout' | 'stderr',
  decoder: TextDecoder,
  accumulator: BoundedOutputBuffer,
  progress: BoundedProgressLineBuffer,
): void {
  const text = decoder.decode(bytes, { stream: true });
  accumulator.append(text);
  if (input.onProgress) progress.push(text, (line) => input.onProgress?.(line, stream));
}

function flushOutputFrames(
  input: ShellInput,
  stream: 'stdout' | 'stderr',
  decoder: TextDecoder,
  accumulator: BoundedOutputBuffer,
  progress: BoundedProgressLineBuffer,
): void {
  const text = decoder.decode();
  if (text) {
    accumulator.append(text);
    if (input.onProgress) progress.push(text, (line) => input.onProgress?.(line, stream));
  }
  if (input.onProgress) progress.flush((line) => input.onProgress?.(line, stream));
}

async function sendCancelFrame(
  proc: { stdin?: unknown } | undefined,
  authority: WindowsSandboxAuthoritySessionV1,
): Promise<void> {
  const stdin = proc?.stdin;
  if (stdin && typeof stdin === 'object' && 'write' in stdin) {
    try {
      const frame = encodeAuthorityFrameV1('cancel', {}, authority, 'host');
      try {
        writeRunnerInput(stdin, frame);
      } finally {
        frame.fill(0);
      }
    } catch {
      // The runner may already be gone; its Job kill-on-close backstop applies.
    }
  }
}

function writeRunnerInput(stdin: unknown, data: Uint8Array): void {
  if (!stdin || typeof stdin !== 'object' || !('write' in stdin)) {
    throw new Error('runner stdin unavailable');
  }
  const sink = stdin as {
    write(value: Uint8Array): number | undefined;
    flush?: () => void;
  };
  const written = sink.write(data);
  if (typeof written === 'number' && written !== data.byteLength) {
    throw new Error('runner stdin write was incomplete');
  }
  sink.flush?.();
}

function closeRunnerInput(stdin: unknown): void {
  if (!stdin || typeof stdin !== 'object') return;
  const sink = stdin as { end?: () => void; close?: () => void };
  try {
    if (typeof sink.end === 'function') sink.end();
    else sink.close?.();
  } catch {
    // Process-exit cleanup remains the backstop after the authenticated exit.
  }
}

function encodeFrame(value: unknown): Uint8Array {
  const serialized = canonicalAuthorityJsonV1(value);
  const payload = new TextEncoder().encode(serialized);
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame.set(payload, 4);
  return frame;
}

/**
 * Fixed-size, one-shot key custody record for the actual native child
 * boundary. It is deliberately not JSON or a length-prefixed authority frame:
 * the native runner consumes exactly these bytes before accepting request
 * frames, and then has no bootstrap fallback path.
 */
export function encodeWindowsSandboxAuthorityBootstrapV1(
  authority: WindowsSandboxAuthoritySessionV1,
): Uint8Array {
  const key = Buffer.from(authority.key);
  const keyId = new TextEncoder().encode(authority.keyId);
  const magic = new TextEncoder().encode(WINDOWS_SANDBOX_AUTHORITY_BOOTSTRAP_MAGIC_V1);
  if (
    key.length !== WINDOWS_SANDBOX_AUTHORITY_KEY_BYTES_V1 ||
    keyId.length !== WINDOWS_SANDBOX_AUTHORITY_KEY_ID_BYTES_V1 ||
    magic.length !== WINDOWS_SANDBOX_AUTHORITY_BOOTSTRAP_MAGIC_V1.length
  ) {
    throw new Error('Windows sandbox authority bootstrap material has an invalid size.');
  }
  try {
    const bootstrap = Buffer.alloc(WINDOWS_SANDBOX_AUTHORITY_BOOTSTRAP_BYTES_V1);
    bootstrap.set(magic, 0);
    bootstrap.set(key, magic.length);
    bootstrap.set(keyId, magic.length + key.length);
    return bootstrap;
  } finally {
    key.fill(0);
    keyId.fill(0);
    magic.fill(0);
  }
}

export function encodeWindowsSandboxAuthorityFrameV1(
  type: AuthorityFrameTypeV1,
  payload: unknown,
  authority: WindowsSandboxAuthoritySessionV1,
  peerId: 'host' | 'runner' = 'host',
): Uint8Array {
  return encodeAuthorityFrameV1(type, payload, authority, peerId);
}

function encodeAuthorityFrameV1(
  type: AuthorityFrameTypeV1,
  payload: unknown,
  authority: WindowsSandboxAuthoritySessionV1,
  peerId: 'host' | 'runner',
): Uint8Array {
  const sequence =
    peerId === WINDOWS_SANDBOX_AUTHORITY_HOST_PEER_ID_V1
      ? authority.hostSequence++
      : authority.runnerSequence++;
  const unsigned = {
    type,
    version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
    invocationId: authority.invocationId,
    peerId,
    keyId: authority.keyId,
    sequence,
    payloadBase64: Buffer.from(canonicalAuthorityJsonV1(payload), 'utf8').toString('base64'),
  } satisfies Omit<AuthorityFrameV1, 'authenticator'>;
  const authenticator = authorityAuthenticatorV1(unsigned, authority.key);
  return encodeFrame({ ...unsigned, authenticator });
}

function authorityAuthenticatorV1(
  unsigned: Omit<AuthorityFrameV1, 'authenticator'>,
  key: Uint8Array,
): `hmac-sha256:${string}` {
  const parts = [
    lengthDelimitedAuthorityPartV1(WINDOWS_SANDBOX_AUTHORITY_DOMAIN_V1),
    lengthDelimitedAuthorityPartV1(unsigned.type),
    numberAuthorityPartV1(unsigned.version, 4),
    lengthDelimitedAuthorityPartV1(unsigned.invocationId),
    lengthDelimitedAuthorityPartV1(unsigned.peerId),
    lengthDelimitedAuthorityPartV1(unsigned.keyId),
    numberAuthorityPartV1(unsigned.sequence, 8),
    lengthDelimitedAuthorityPartV1(unsigned.payloadBase64),
  ];
  const combined = Buffer.concat(parts);
  try {
    const digest = createHmac('sha256', key).update(combined).digest('hex');
    return `hmac-sha256:${digest}`;
  } finally {
    combined.fill(0);
    for (const part of parts) part.fill(0);
  }
}

function lengthDelimitedAuthorityPartV1(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.byteLength, 0);
  return Buffer.concat([length, bytes]);
}

function numberAuthorityPartV1(value: number, bytes: 4 | 8): Buffer {
  const output = Buffer.alloc(bytes);
  if (bytes === 4) output.writeUInt32LE(value, 0);
  else output.writeBigUInt64LE(BigInt(value), 0);
  return output;
}

function canonicalAuthorityJsonV1(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Authority JSON value is not serializable.');
    return encoded;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAuthorityJsonV1).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      compareAuthorityUtf8V1(left, right),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalAuthorityJsonV1(child)}`)
      .join(',')}}`;
  }
  throw new Error('Authority JSON value is not serializable.');
}

function compareAuthorityUtf8V1(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    }
  }
  return leftBytes.length - rightBytes.length;
}

async function* readFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = stream.getReader();
  let buffer = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, value]);
      if (buffer.length > 16 * 1024 * 1024 + 4) {
        throw new Error('Windows authority frame is too large.');
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length > 16 * 1024 * 1024) throw new Error('Windows authority frame is too large.');
        if (buffer.length < 4 + length) break;
        yield buffer.subarray(4, 4 + length);
        buffer = Buffer.from(buffer.subarray(4 + length));
      }
    }
    if (buffer.length !== 0) throw new Error('Windows authority frame is truncated.');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

async function nextRunnerFrameWithTimeout(
  frames: AsyncIterator<Buffer>,
  timeoutMs: number,
): Promise<IteratorResult<Buffer>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frames.next(),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Windows sandbox runner ready acknowledgement timed out.')),
          timeoutMs,
        );
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export type WindowsSandboxRunnerFrameV1 =
  | { type: 'ready'; invocationName: string; runtimeValidated: true }
  | { type: 'log'; level: string; message: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; receipt: ExecutionReceipt };

export function decodeWindowsSandboxRunnerFrameV1(
  payload: Uint8Array,
  expectedInvocationName: string,
  authority?: WindowsSandboxAuthoritySessionV1,
): WindowsSandboxRunnerFrameV1 {
  try {
    if (!authority) throw new Error('runner frame authority is required');
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    const value: unknown = JSON.parse(raw);
    if (canonicalAuthorityJsonV1(value) !== raw) throw new Error('non-canonical frame');
    if (!isAuthorityFrameV1(value)) throw new Error('malformed frame');
    if (
      value.version !== WINDOWS_SANDBOX_PROTOCOL_VERSION ||
      value.peerId !== WINDOWS_SANDBOX_AUTHORITY_RUNNER_PEER_ID_V1 ||
      value.invocationId !== expectedInvocationName ||
      value.invocationId !== authority.invocationId ||
      value.keyId !== authority.keyId ||
      value.sequence !== authority.runnerSequence ||
      !verifyAuthorityAuthenticatorV1(value, authority.key)
    ) {
      throw new Error('malformed frame');
    }
    const decodedPayload = decodeAuthorityPayloadV1(value.payloadBase64);
    authority.runnerSequence += 1;
    if (
      value.type === 'ready' &&
      exactRecord(decodedPayload, ['invocationName', 'runtimeValidated']) &&
      decodedPayload.invocationName === expectedInvocationName &&
      decodedPayload.runtimeValidated === true
    ) {
      return {
        type: 'ready',
        invocationName: expectedInvocationName,
        runtimeValidated: true,
      };
    }
    if (
      value.type === 'log' &&
      exactRecord(decodedPayload, ['level', 'message']) &&
      typeof decodedPayload.level === 'string' &&
      typeof decodedPayload.message === 'string'
    ) {
      return {
        type: 'log',
        level: decodedPayload.level,
        message: decodedPayload.message,
      };
    }
    if (
      (value.type === 'stdout' || value.type === 'stderr') &&
      exactRecord(decodedPayload, ['data']) &&
      validBase64(decodedPayload.data)
    ) {
      return { type: value.type, data: decodedPayload.data };
    }
    if (value.type === 'exit' && validExecutionReceipt(decodedPayload, expectedInvocationName)) {
      return { type: 'exit', receipt: decodedPayload };
    }
    throw new Error('malformed frame');
  } catch {
    throw new Error('Windows sandbox runner emitted a malformed frame.');
  }
}

function isAuthorityFrameV1(value: unknown): value is AuthorityFrameV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    exactRecord(value, [
      'type',
      'version',
      'invocationId',
      'peerId',
      'keyId',
      'sequence',
      'payloadBase64',
      'authenticator',
    ]) &&
    (value.type === 'ready' ||
      value.type === 'log' ||
      value.type === 'stdout' ||
      value.type === 'stderr' ||
      value.type === 'exit') &&
    (value.peerId === WINDOWS_SANDBOX_AUTHORITY_RUNNER_PEER_ID_V1 ||
      value.peerId === WINDOWS_SANDBOX_AUTHORITY_HOST_PEER_ID_V1) &&
    value.version === WINDOWS_SANDBOX_PROTOCOL_VERSION &&
    typeof value.invocationId === 'string' &&
    typeof value.keyId === 'string' &&
    nonNegativeSafeInteger(value.sequence) &&
    typeof value.payloadBase64 === 'string' &&
    typeof value.authenticator === 'string'
  );
}

function decodeAuthorityPayloadV1(payloadBase64: string): unknown {
  if (!validBase64(payloadBase64)) throw new Error('malformed payload');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.from(payloadBase64, 'base64'),
  );
  const parsed = JSON.parse(raw) as unknown;
  if (canonicalAuthorityJsonV1(parsed) !== raw) throw new Error('non-canonical payload');
  return parsed;
}

function verifyAuthorityAuthenticatorV1(frame: AuthorityFrameV1, key: Uint8Array): boolean {
  if (!/^hmac-sha256:[a-f0-9]{64}$/u.test(frame.authenticator)) return false;
  let actual: Buffer;
  try {
    actual = Buffer.from(frame.authenticator.slice('hmac-sha256:'.length), 'hex');
  } catch {
    return false;
  }
  const expected = Buffer.from(
    authorityAuthenticatorV1(
      {
        type: frame.type,
        version: frame.version,
        invocationId: frame.invocationId,
        peerId: frame.peerId,
        keyId: frame.keyId,
        sequence: frame.sequence,
        payloadBase64: frame.payloadBase64,
      },
      key,
    ).slice('hmac-sha256:'.length),
    'hex',
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validExecutionReceipt(
  value: unknown,
  expectedInvocationName: string,
): value is ExecutionReceipt {
  return (
    exactRecord(value, [
      'version',
      'exitCode',
      'timedOut',
      'cancelled',
      'stdoutBytes',
      'stderrBytes',
      'peakProcesses',
      'activeProcessLimit',
      'cleanupConfirmed',
      'invocationName',
      'error',
    ]) &&
    value.version === WINDOWS_SANDBOX_PROTOCOL_VERSION &&
    signedInt32(value.exitCode) &&
    typeof value.timedOut === 'boolean' &&
    typeof value.cancelled === 'boolean' &&
    nonNegativeSafeInteger(value.stdoutBytes) &&
    nonNegativeSafeInteger(value.stderrBytes) &&
    nonNegativeSafeInteger(value.peakProcesses) &&
    positiveSafeInteger(value.activeProcessLimit) &&
    Number(value.peakProcesses) <= Number(value.activeProcessLimit) &&
    typeof value.cleanupConfirmed === 'boolean' &&
    value.invocationName === expectedInvocationName &&
    (value.error === null || (typeof value.error === 'string' && value.error.length > 0))
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length % 4 === 0 &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function signedInt32(value: unknown): boolean {
  return (
    Number.isSafeInteger(value) && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647
  );
}

function appendTerminalMessage(stderr: string, message: string): string {
  return stderr.trimEnd() ? `${stderr.trimEnd()}\n${message}` : message;
}
