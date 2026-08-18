import {
  resolveWindowsSandboxRunnerV1,
  WINDOWS_SANDBOX_PROTOCOL_VERSION,
  type WindowsSandboxRunnerV1,
} from '@/core/sandbox/windows-runner';
import { appendTimeoutMessage, readWithProgress, timeoutMessage } from '@/core/tools/shell';
import { BoundedOutputBuffer, BoundedProgressLineBuffer } from '@/core/tools/stream-output';
import type { ShellInput, ShellResult } from '@/core/types';
import { cleanupWindowsSandboxRuntimeDirNoSpawnV1 } from './local-runtime-filesystem';
import type {
  RestrictedTokenInvocationRequestV1,
  WindowsRestrictedTokenPreparedTransportV1,
} from './windows-preparation';

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

/** Runtime consumer adapter for the framed native runner. */
export async function executeWindowsRestrictedTokenPreparedV1(
  input: ShellInput,
  prepared: WindowsRestrictedTokenPreparedTransportV1,
): Promise<ShellResult> {
  const { runner, request, workspaceRoot, runtimeRoot } = prepared;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([runner.path], {
      cwd: workspaceRoot,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
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
    void sendCancelFrame(proc);
  };
  const cancel = () => terminate('cancelled');

  try {
    if (!proc.stdin) throw new Error('runner stdin unavailable');
    (proc.stdin as { write(data: Uint8Array): void }).write(encodeFrame(request));
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
    const framePromise = (async () => {
      let receipt: ExecutionReceipt | undefined;
      try {
        for await (const payload of readFrames(proc.stdout as ReadableStream<Uint8Array>)) {
          const frame = decodeWindowsSandboxRunnerFrameV1(payload, request.invocationName);
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
        recovered = await recoverRestrictedTokenAcl(runner, request, workspaceRoot);
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
): Promise<boolean> {
  let cleanup: ReturnType<typeof Bun.spawn> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    cleanup = Bun.spawn([runner.path, '--cleanup'], {
      cwd,
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (!cleanup.stdin) return false;
    (cleanup.stdin as { write(data: Uint8Array): void }).write(encodeFrame(request));
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
  }
}

/** Runtime crash-recovery consumer; the Provider itself never launches cleanup processes. */
export async function reconcileWindowsRestrictedTokenPreparedV1(
  prepared: WindowsRestrictedTokenPreparedTransportV1,
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
  return recoverRestrictedTokenAcl(prepared.runner, prepared.request, prepared.workspaceRoot);
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

async function sendCancelFrame(proc: { stdin?: unknown } | undefined): Promise<void> {
  const stdin = proc?.stdin;
  if (stdin && typeof stdin === 'object' && 'write' in stdin) {
    try {
      (stdin as { write(data: Uint8Array): void }).write(encodeFrame({ type: 'cancel' }));
    } catch {
      // The runner may already be gone; its Job kill-on-close backstop applies.
    }
  }
}

function encodeFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame.set(payload, 4);
  return frame;
}

async function* readFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = stream.getReader();
  let buffer = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, value]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) break;
        yield buffer.subarray(4, 4 + length);
        buffer = Buffer.from(buffer.subarray(4 + length));
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

export type WindowsSandboxRunnerFrameV1 =
  | { type: 'log'; level: string; message: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; receipt: ExecutionReceipt };

export function decodeWindowsSandboxRunnerFrameV1(
  payload: Uint8Array,
  expectedInvocationName: string,
): WindowsSandboxRunnerFrameV1 {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (
      exactRecord(value, ['type', 'level', 'message']) &&
      value.type === 'log' &&
      typeof value.level === 'string' &&
      typeof value.message === 'string'
    ) {
      return { type: 'log', level: value.level, message: value.message };
    }
    if (
      exactRecord(value, ['type', 'data']) &&
      value.type === 'stdout' &&
      validBase64(value.data)
    ) {
      return { type: 'stdout', data: value.data };
    }
    if (
      exactRecord(value, ['type', 'data']) &&
      value.type === 'stderr' &&
      validBase64(value.data)
    ) {
      return { type: 'stderr', data: value.data };
    }
    if (
      exactRecord(value, ['type', 'receipt']) &&
      value.type === 'exit' &&
      validExecutionReceipt(value.receipt, expectedInvocationName)
    ) {
      return { type: 'exit', receipt: value.receipt };
    }
    throw new Error('malformed frame');
  } catch {
    throw new Error('Windows sandbox runner emitted a malformed frame.');
  }
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
