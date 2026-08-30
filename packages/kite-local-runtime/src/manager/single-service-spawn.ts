import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { resolveNativeServiceSpawnCommand } from './native-spawn-command';
import type { KiteServiceManagerExecutable } from './ports';
import type {
  KiteSingleServiceSpawnedChild,
  KiteSingleServiceSpawnPort,
} from './single-service-manager';

const READINESS_FD = 3;
const MAX_READINESS_BYTES = 4_096;

export interface KiteSingleServiceNativeSpawnOptions {
  readonly executable: KiteServiceManagerExecutable;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached?: boolean;
  readonly stderr?: 'ignore' | 'inherit';
}

/** Detached real-child adapter for the single-Service manager's fixed readiness channel. */
export function createKiteSingleServiceNativeSpawnPort(
  options: KiteSingleServiceNativeSpawnOptions,
): KiteSingleServiceSpawnPort {
  return Object.freeze({
    async spawn(): Promise<KiteSingleServiceSpawnedChild> {
      const invocation = resolveNativeServiceSpawnCommand(options.executable, options.args);
      const child = spawn(invocation.command, [...invocation.args], {
        cwd: options.cwd,
        env: { ...options.env, KITE_SERVICE_READINESS_FD: String(READINESS_FD) },
        detached: options.detached ?? true,
        stdio: ['ignore', 'ignore', options.stderr ?? 'ignore', 'pipe'],
        windowsHide: true,
      });
      const readiness = child.stdio[READINESS_FD] as Readable | null;
      if (!Number.isSafeInteger(child.pid) || !child.pid || child.pid <= 0 || !readiness) {
        readiness?.destroy();
        throw new Error('Single-Service child did not expose PID/readiness.');
      }
      child.unref();
      let released = false;
      const ready = readReadiness(readiness);
      return Object.freeze({
        waitForReady: async () => {
          await ready;
        },
        releaseReadiness: async () => {
          if (released) return;
          released = true;
          readiness.destroy();
        },
      });
    },
  });
}

async function readReadiness(stream: Readable): Promise<void> {
  let value = '';
  for await (const chunk of stream) {
    value += Buffer.from(chunk as Uint8Array).toString('utf8');
    if (Buffer.byteLength(value, 'utf8') > MAX_READINESS_BYTES) {
      throw new RangeError('Single-Service readiness signal is oversized.');
    }
    const newline = value.indexOf('\n');
    if (newline < 0) continue;
    if (value.slice(newline + 1).length !== 0) {
      throw new TypeError('Single-Service readiness channel contains trailing data.');
    }
    const parsed = JSON.parse(value.slice(0, newline)) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !('instanceId' in parsed) ||
      typeof parsed.instanceId !== 'string' ||
      parsed.instanceId.length < 1 ||
      parsed.instanceId.length > 512 ||
      /\p{Cc}/u.test(parsed.instanceId)
    ) {
      throw new TypeError('Single-Service readiness signal is invalid.');
    }
    return;
  }
  throw new Error('Single-Service readiness channel closed before ready.');
}
