import type {
  GitProcessAdapterV1,
  GitProcessRequestV1,
  GitProcessResultV1,
} from '@/core/git/broker';

async function consume(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  onOverflow: () => void,
): Promise<{ text: string; overflow: boolean }> {
  if (!stream) return { text: '', overflow: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let overflow = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (retained + value.byteLength > maximumBytes) {
      const remaining = Math.max(0, maximumBytes - retained);
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      retained += remaining;
      overflow = true;
      onOverflow();
      continue;
    }
    chunks.push(value);
    retained += value.byteLength;
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let safeEnd = bytes.byteLength;
  while (safeEnd > 0) {
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, safeEnd)),
        overflow,
      };
    } catch {
      safeEnd -= 1;
    }
  }
  return { text: '', overflow };
}

async function confirmUnixProcessGroupExited(pid: number, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await Bun.sleep(Math.min(10, remainingMs));
  }
}

/** App-owned process adapter. Core owns argv/env/schema and never imports this implementation. */
export function createAppGitProcessAdapterV1(
  input: { spawn?: typeof Bun.spawn } = {},
): GitProcessAdapterV1 {
  return {
    async run(request: GitProcessRequestV1): Promise<GitProcessResultV1> {
      if (request.signal?.aborted) {
        return {
          exitCode: 130,
          stdout: '',
          stderr: 'Git process cancelled.',
          cancelled: true,
          cleanupConfirmed: true,
        };
      }
      let timedOut = false;
      let interrupted = false;
      let outputExceeded = false;
      let wakeInterruption: (() => void) | undefined;
      const interruption = new Promise<void>((resolve) => {
        wakeInterruption = resolve;
      });
      const onAbort = (): void => {
        interrupted = true;
        wakeInterruption?.();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        interrupted = true;
        wakeInterruption?.();
      }, request.timeoutMs);
      try {
        const child = (input.spawn ?? Bun.spawn)([request.executable, ...request.args], {
          cwd: request.cwd,
          env: request.env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          detached: process.platform !== 'win32',
        });
        const onOverflow = () => {
          outputExceeded = true;
          interrupted = true;
          wakeInterruption?.();
        };
        const stdoutPromise = consume(child.stdout, request.maxStdoutBytes, onOverflow);
        const stderrPromise = consume(child.stderr, request.maxStderrBytes, onOverflow);
        const exited = child.exited;
        await Promise.race([exited.then(() => undefined), interruption]);
        let cleanupConfirmed: boolean | undefined;
        if (interrupted) {
          const terminate = (signal: NodeJS.Signals): void => {
            try {
              if (process.platform !== 'win32') process.kill(-child.pid, signal);
              else child.kill(signal);
            } catch {
              try {
                child.kill(signal);
              } catch {
                // Confirmation below remains fail-closed.
              }
            }
          };
          terminate('SIGTERM');
          let exitedAfterTermination = false;
          await Promise.race([
            exited.then(() => {
              exitedAfterTermination = true;
            }),
            Bun.sleep(150),
          ]);
          if (!exitedAfterTermination) terminate('SIGKILL');
          await Promise.race([exited, Bun.sleep(1_000)]);
          if (process.platform === 'win32') {
            cleanupConfirmed = false;
          } else {
            cleanupConfirmed = await confirmUnixProcessGroupExited(child.pid);
          }
        }
        const [exitCode, stdoutResult, stderrResult] = await Promise.all([
          exited,
          stdoutPromise,
          stderrPromise,
        ]);
        const stdout = stdoutResult.text;
        const stderr = stderrResult.text;
        return {
          exitCode,
          stdout,
          stderr,
          ...(timedOut ? { timedOut: true } : {}),
          ...(request.signal?.aborted ? { cancelled: true } : {}),
          ...(cleanupConfirmed !== undefined ? { cleanupConfirmed } : {}),
          ...(cleanupConfirmed === false
            ? { adapterErrorCode: 'cleanup_unconfirmed' as const }
            : outputExceeded || stdoutResult.overflow || stderrResult.overflow
              ? { adapterErrorCode: 'output_limit_exceeded' as const }
              : {}),
        };
      } catch {
        if (timedOut || request.signal?.aborted) {
          return {
            exitCode: timedOut ? 124 : 130,
            stdout: '',
            stderr: timedOut ? 'Git process timed out.' : 'Git process cancelled.',
            ...(timedOut ? { timedOut: true } : {}),
            ...(request.signal?.aborted ? { cancelled: true } : {}),
            cleanupConfirmed: false,
            adapterErrorCode: 'cleanup_unconfirmed',
          };
        }
        return {
          exitCode: -1,
          stdout: '',
          stderr: '',
          adapterErrorCode: 'spawn_failed',
        };
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
