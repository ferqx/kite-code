import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type {
  KiteServiceManagerChild,
  KiteServiceManagerProcessPort,
  KiteServiceManagerReadinessSignal,
  KiteServiceManagerSpawnPort,
} from './ports';

const READINESS_FD = 3;
const MAX_READINESS_BYTES = 4_096;

function isNativeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function decodeReadiness(value: string): KiteServiceManagerReadinessSignal {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !('instanceId' in parsed) ||
    typeof parsed.instanceId !== 'string' ||
    parsed.instanceId.length === 0 ||
    parsed.instanceId.length > 512 ||
    /\p{Cc}/u.test(parsed.instanceId)
  ) {
    throw new TypeError('Service readiness signal is invalid.');
  }
  return Object.freeze({ instanceId: parsed.instanceId });
}

async function readReadiness(stream: Readable): Promise<KiteServiceManagerReadinessSignal> {
  let value = '';
  for await (const chunk of stream) {
    value += Buffer.from(chunk as Uint8Array).toString('utf8');
    if (Buffer.byteLength(value, 'utf8') > MAX_READINESS_BYTES) {
      throw new RangeError('Service readiness signal is oversized.');
    }
    const newline = value.indexOf('\n');
    if (newline < 0) continue;
    if (value.slice(newline + 1).length !== 0) {
      throw new TypeError('Service readiness channel contains trailing data.');
    }
    return decodeReadiness(value.slice(0, newline));
  }
  throw new Error('Service readiness channel closed before ready.');
}

/** Detached spawn with a dedicated fd3 readiness pipe; stdout is never a protocol channel. */
export function createKiteServiceManagerNativeSpawnPort(): KiteServiceManagerSpawnPort {
  return Object.freeze({
    async spawn(
      input: Parameters<KiteServiceManagerSpawnPort['spawn']>[0],
    ): Promise<KiteServiceManagerChild> {
      const child = spawn(input.executable.path, [...input.args], {
        cwd: input.cwd,
        env: { ...input.env, KITE_SERVICE_READINESS_FD: String(READINESS_FD) },
        detached: input.detached,
        stdio: ['ignore', input.stdout, 'ignore', 'pipe'],
        windowsHide: true,
      });
      const pid = child.pid;
      const readinessStream = child.stdio[READINESS_FD] as Readable | null;
      if (!Number.isSafeInteger(pid) || !pid || pid <= 0 || !readinessStream) {
        readinessStream?.destroy();
        throw new Error('Detached Service child did not expose PID/readiness.');
      }
      child.unref();
      let released = false;
      const readinessPromise = readReadiness(readinessStream);
      return Object.freeze({
        pid,
        readiness: Object.freeze({
          async release() {
            if (released) return;
            released = true;
            readinessStream.destroy();
          },
        }),
        waitForReady: () => readinessPromise,
      });
    },
  });
}

/** Conservative PID existence probe. EPERM/unknown is uncertain; the adapter never kills. */
export function createKiteServiceManagerNativeProcessPort(): KiteServiceManagerProcessPort {
  return Object.freeze({
    async inspect(pid: number) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return 'uncertain';
      try {
        process.kill(pid, 0);
        return 'alive';
      } catch (error) {
        if (isNativeError(error, 'ESRCH')) return 'dead';
        return 'uncertain';
      }
    },
  });
}
