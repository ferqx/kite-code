import { readFileSync } from 'node:fs';
import { spawnRuntimeHostProcess } from './spawn';

const MAX_REQUEST_BYTES = 1_048_576;

/** POSIX watchdog used by the generic Host process port; request bytes arrive only on inherited stdin. */
export function runProcessTreeChild(args: readonly string[]): void {
  if (args.length !== 0 || process.platform === 'win32') process.exit(125);
  // The guard owns graceful-to-forced escalation for the whole process group.
  // Keep the watchdog alive for SIGTERM so an ignoring command cannot turn a
  // required forced cleanup into an apparent graceful watchdog exit.
  process.on('SIGTERM', () => undefined);
  let buffer = Buffer.alloc(0);
  let started = false;
  let terminal = false;
  let child: ReturnType<typeof spawnRuntimeHostProcess> | undefined;
  let parentWatch: ReturnType<typeof setInterval> | undefined;

  process.stdin.on('data', (chunk: Buffer | string) => {
    if (started) return emergencyExit();
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    buffer = Buffer.concat([buffer, bytes]);
    if (buffer.byteLength > MAX_REQUEST_BYTES + 1) return emergencyExit();
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    if (newline !== buffer.byteLength - 1) return emergencyExit();
    const request = decodeRequest(buffer.subarray(0, newline));
    buffer.fill(0);
    buffer = Buffer.alloc(0);
    if (!request) return emergencyExit();
    started = true;
    parentWatch = setInterval(() => {
      if (!isProcessAlive(request.ownerPid)) emergencyExit();
    }, 100);
    child = spawnRuntimeHostProcess(request.argv, {
      cwd: request.cwd,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      ...(request.env ? { env: request.env } : {}),
    });
    void child.exited.then(
      (exitCode) => {
        terminal = true;
        if (parentWatch) clearInterval(parentWatch);
        process.exit(exitCode);
      },
      () => emergencyExit(),
    );
  });
  process.stdin.on('end', emergencyExit);
  process.stdin.on('error', emergencyExit);

  function emergencyExit(): void {
    if (terminal) return;
    if (started) {
      try {
        child?.kill('SIGKILL');
      } catch {
        // The direct child may already have exited; the process-group kill remains authoritative.
      }
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        process.exit(125);
      }
      return;
    }
    process.exit(125);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closing = stat.lastIndexOf(')');
    if (closing < 0) return true;
    const state = stat
      .slice(closing + 2)
      .trim()
      .split(/\s+/u)[0];
    return state !== 'Z' && state !== 'X';
  } catch {
    return true;
  }
}

function decodeRequest(bytes: Uint8Array): {
  readonly argv: string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly ownerPid: number;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== ['argv', 'cwd', 'env', 'ownerPid'].sort().join('\0')
  )
    return null;
  if (
    !Array.isArray(record.argv) ||
    record.argv.length === 0 ||
    record.argv.length > 256 ||
    record.argv.some(
      (part) => typeof part !== 'string' || part.length === 0 || part.length > 65_536,
    ) ||
    typeof record.cwd !== 'string' ||
    record.cwd.length === 0 ||
    record.cwd.length > 4_096 ||
    !Number.isSafeInteger(record.ownerPid) ||
    (record.ownerPid as number) <= 1 ||
    (record.env !== null && !isStringRecord(record.env))
  ) {
    return null;
  }
  return {
    argv: [...(record.argv as string[])],
    cwd: record.cwd,
    ownerPid: record.ownerPid as number,
    ...(record.env === null ? {} : { env: { ...(record.env as Record<string, string>) } }),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 256 &&
    Object.entries(value).every(
      ([key, item]) => key.length > 0 && key.length <= 256 && item.length <= 65_536,
    )
  );
}
