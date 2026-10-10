import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import { z } from 'zod';
import {
  bootstrapLimitBytes,
  type PrivateBootstrap,
  privateStartupSchema,
  type SelectedProfile,
  startupLimitBytes,
} from './bootstrap';
import { schemas } from './http/schema';
import type { RuntimeProtection } from './runtime-protection';
import { parseServiceStartupDiagnostic, type ServiceStartupDiagnostic } from './startup-diagnostic';
import type { retainWindowsPairedArtifact } from './windows-paired-artifact';

export { formatServiceStartupReport, type ServiceStartupDiagnostic } from './startup-diagnostic';

export interface PairedServiceChild {
  readonly stdin: {
    write(value: string): unknown;
    flush(): unknown;
    end(): unknown;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal: 'SIGKILL'): unknown;
}
/** A trusted native host supplies process creation, while this launcher retains admission and lifecycle. */
export type PairedServiceSpawner = (
  command: readonly string[],
  options: { readonly env: Readonly<Record<string, string>> },
) => PairedServiceChild;

export interface PairedServiceOptions {
  /** Explicit chosen artifact. No credential or token is passed in argv. */
  entrypoint: string;
  profile: SelectedProfile;
  instanceId: string;
  buildId: string;
  apiMajor: number;
  requiredCapabilities: readonly string[];
  capabilities?: string[];
  hostConfiguration?: Json;
  runtimeProtection?: RuntimeProtection;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  executable?: string;
  spawnChild?: PairedServiceSpawner;
}
export class PairedServiceError extends Error {
  readonly code: string;
  readonly startupDiagnostic?: ServiceStartupDiagnostic;
  constructor(code: string, startupDiagnostic?: ServiceStartupDiagnostic) {
    super(code);
    this.code = code;
    this.startupDiagnostic = startupDiagnostic;
  }
}
const bootstrapSchema = z.intersection(
  schemas.ServerInfo,
  z.object({ endpoint: z.string().url(), token: z.string().min(32).max(256) }),
);

async function bootstrapFrom(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<PrivateBootstrap> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  while (!text.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new PairedServiceError('bootstrap_channel_closed');
    bytes += chunk.value.byteLength;
    if (bytes > bootstrapLimitBytes) throw new PairedServiceError('bootstrap_too_large');
    text += decoder.decode(chunk.value, { stream: true });
  }
  if (text.slice(text.indexOf('\n') + 1).length)
    throw new PairedServiceError('unexpected_bootstrap_data');
  try {
    return bootstrapSchema.parse(JSON.parse(text.slice(0, text.indexOf('\n'))));
  } catch {
    throw new PairedServiceError('invalid_bootstrap');
  }
}
async function deadline<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PairedServiceError(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A single private paired launch and connection admission; no execution Manager. */
export async function launchPairedService(options: PairedServiceOptions) {
  const selected = selectProfile({
    dataRoot: options.profile.dataRoot,
    profile: options.profile.profile,
  });
  if (
    selected.dataRoot !== options.profile.dataRoot ||
    selected.profileAccessKey !== options.profile.profileAccessKey
  )
    throw new PairedServiceError('profile_identity_mismatch');
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const parsed = privateStartupSchema.safeParse({
    profile: {
      dataRoot: options.profile.dataRoot,
      profile: options.profile.profile,
      profileAccessKey: options.profile.profileAccessKey,
    },
    instanceId: options.instanceId,
    buildId: options.buildId,
    token,
    capabilities: options.capabilities,
    hostConfiguration: options.hostConfiguration,
    ...(options.runtimeProtection ? { runtimeProtection: options.runtimeProtection } : {}),
  });
  if (!parsed.success) throw new PairedServiceError('invalid_startup');
  const startup = parsed.data;
  const encoded = `${JSON.stringify(startup)}\n`;
  if (Buffer.byteLength(encoded) > startupLimitBytes)
    throw new PairedServiceError('startup_too_large');
  const executable = options.executable ?? process.execPath;
  let artifact: ReturnType<typeof retainWindowsPairedArtifact> | undefined;
  if (process.platform === 'win32' && options.runtimeProtection) {
    try {
      const windows = await import('./windows-paired-artifact');
      artifact = windows.retainWindowsPairedArtifact(options.runtimeProtection, {
        entrypoint: options.entrypoint,
        executable,
        buildId: options.buildId,
      });
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'paired_artifact_admission_failed';
      throw Object.assign(new PairedServiceError(code), { cause: error });
    }
  }
  const command = [executable, ...(artifact?.arguments ?? []), options.entrypoint];
  // Private startup configuration is sent only through stdin, never inherited
  // from model credential environment variables or an endpoint query string.
  const env = { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' };
  let child: PairedServiceChild;
  try {
    child = options.spawnChild
      ? options.spawnChild(command, { env })
      : Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
  } catch (error) {
    try {
      artifact?.release();
    } catch (cleanupError) {
      throw Object.assign(new PairedServiceError('paired_artifact_close_unknown'), {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
  // Only the original child's fulfilled exit establishes that its parent pins can close.
  const retainedArtifact = artifact;
  const exited = retainedArtifact
    ? child.exited.then((code) => {
        try {
          retainedArtifact.release();
        } catch (error) {
          throw Object.assign(new PairedServiceError('paired_artifact_close_unknown'), {
            cause: error,
          });
        }
        return code;
      })
    : child.exited;
  void exited.catch(() => {});
  const stdout = child.stdout.getReader();
  let stderr = '';
  const diagnostics = () =>
    stderr
      .split('\n')
      .filter(Boolean)
      .slice(0, 64)
      .map((line) => {
        try {
          const value = JSON.parse(line) as { code?: unknown };
          return typeof value.code === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(value.code)
            ? value.code
            : 'unstructured_service_log';
        } catch {
          return 'unstructured_service_log';
        }
      });
  const stderrTask = (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let retainedBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const retained = chunk.value.subarray(0, Math.max(0, 16 * 1024 - retainedBytes));
        retainedBytes += retained.byteLength;
        stderr += decoder.decode(retained, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  })();
  void stderrTask.catch(() => {});
  let closing: Promise<void> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      client?.disposeNetwork();
      try {
        child.stdin.end();
      } catch {
        /* The owned child already closed its pipe. */
      }
      // Parent EOF is independent of every HTTP connection.
      try {
        await deadline(child.exited, options.shutdownTimeoutMs ?? 5000, 'shutdown_timeout');
      } catch {
        child.kill('SIGKILL');
        await child.exited;
      }
      if (!retainedArtifact) {
        await stderrTask;
        try {
          await stdout.cancel();
        } catch {
          /* Already consumed/closed. */
        }
        return;
      }
      // Stream cleanup must still run if closing the native artifact handle fails.
      const completed = await Promise.allSettled([
        exited,
        stderrTask,
        stdout.cancel().catch(() => {
          /* Already consumed/closed. */
        }),
      ]);
      const failures = completed.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failures.length === 1) throw failures[0]!.reason;
      if (failures.length > 1)
        throw Object.assign(new PairedServiceError('paired_close_failed'), {
          cause: new AggregateError(failures.map((failure) => failure.reason)),
        });
    })();
    return closing;
  };
  try {
    child.stdin.write(encoded);
    await child.stdin.flush();
    const bootstrap = await deadline(
      bootstrapFrom(stdout),
      options.startupTimeoutMs ?? 10000,
      'startup_timeout',
    );
    const endpoint = new URL(bootstrap.endpoint);
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new PairedServiceError('invalid_endpoint');
    if (bootstrap.token !== token) throw new PairedServiceError('bootstrap_token_mismatch');
    client = createClient({
      endpoint: bootstrap.endpoint,
      token,
      bootstrap,
      expected: {
        profile: {
          dataRoot: selected.dataRoot,
          name: selected.profile,
          accessKey: selected.profileAccessKey,
        },
        apiMajor: options.apiMajor,
        instanceId: options.instanceId,
        buildId: options.buildId,
        requiredCapabilities: options.requiredCapabilities,
      },
    });
    await deadline(client.connect(), options.startupTimeoutMs ?? 10000, 'connection_timeout');
    const stdoutTask = (async () => {
      try {
        while (true) {
          const next = await stdout.read();
          if (next.done) return;
          if (next.value.byteLength) throw new PairedServiceError('unexpected_bootstrap_data');
        }
      } catch {
        if (!closing) await close();
      }
    })();
    void stdoutTask.catch(() => {});
    return {
      client,
      bootstrap,
      pid: child.pid,
      exited,
      get diagnostics() {
        return diagnostics();
      },
      get startupDiagnostic() {
        return parseServiceStartupDiagnostic(stderr);
      },
      close,
    };
  } catch (error) {
    if (!retainedArtifact) await close();
    else {
      try {
        await close();
      } catch (cleanupError) {
        const code =
          cleanupError instanceof PairedServiceError ? cleanupError.code : 'paired_close_failed';
        throw Object.assign(new PairedServiceError(code, parseServiceStartupDiagnostic(stderr)), {
          cause: new AggregateError([error, cleanupError]),
        });
      }
    }
    const startupDiagnostic = parseServiceStartupDiagnostic(stderr);
    if (error instanceof PairedServiceError)
      throw new PairedServiceError(error.code, startupDiagnostic);
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'paired_startup_failed';
    throw new PairedServiceError(
      /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : 'paired_startup_failed',
      startupDiagnostic,
    );
  }
}
