import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startWindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../../platform/process/windows-owned-child';
import { AgentError, type Json } from '../../storage/types';
import { imageInputBytes, imageOutputBytes, imageTimeoutMs } from './format';

export interface ImageAssets {
  child: string;
  checksum: string;
  dependencies: string[];
}
export function imageAssets(): ImageAssets {
  const child = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.js')
        ? './tools/images/image-child.js'
        : '../../../dist/tools/images/image-child.js',
      import.meta.url,
    ),
  );
  const dependencies = new Set<string>();
  const visit = (manifest: string) => {
    const root = dirname(manifest);
    if (dependencies.has(root)) return;
    dependencies.add(root);
    const require = createRequire(manifest),
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const name of Object.keys(pkg.dependencies ?? {}))
      visit(require.resolve(`${name}/package.json`));
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
      try {
        visit(require.resolve(`${name}/package.json`));
      } catch {
        /* Uninstalled platform companions. */
      }
    }
  };
  visit(createRequire(import.meta.url).resolve('sharp/package.json'));
  return { child, checksum: child.replace(/\.js$/, '.sha256'), dependencies: [...dependencies] };
}

export class ImageProcessCleanupError extends AgentError {
  constructor(cause: unknown) {
    super('image_process_exit_unconfirmed');
    this.cause = cause;
  }
}
const retained = new Set<object>();
let busy = false,
  uncertain = false;
const waiters = new Set<() => void>();
async function acquire(signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    if (uncertain) throw new ImageProcessCleanupError(undefined);
    if (!busy) {
      busy = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        waiters.delete(wake);
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        waiters.delete(wake);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
async function collect(
  stream: AsyncIterable<Uint8Array>,
  maximum: number,
  stop: () => Promise<void>,
) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) {
      await stop();
      throw new AgentError('image_process_output_invalid');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/** Fixed child/stdio supervision; options are trusted construction, never Tool/config/IPC input. */
export function createImageProcessor(
  options: { assets?: () => ImageAssets; timeoutMs?: number } = {},
) {
  return async <T extends { bytes: Uint8Array }>(
    read: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) => {
    await acquire(signal); // The queue retains no image bytes or native decoder.
    let confirmed = true;
    try {
      const timeout = options.timeoutMs ?? imageTimeoutMs;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > imageTimeoutMs)
        throw new AgentError('image_timeout_invalid');
      const asset = (options.assets ?? imageAssets)();
      const expected = (await readFile(asset.checksum, 'utf8')).trim();
      if (
        !/^[a-f0-9]{64}$/.test(expected) ||
        createHash('sha256')
          .update(await readFile(asset.child))
          .digest('hex') !== expected
      )
        throw new AgentError('image_assets_invalid');
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new AgentError('image_processing_timeout')),
        timeout,
      );
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        const source = await read(controller.signal);
        controller.signal.throwIfAborted();
        if (!source.bytes.length) throw new AgentError('image_invalid');
        if (source.bytes.length > imageInputBytes) throw new AgentError('image_input_too_large');
        const result = await execute(source.bytes, asset, controller.signal);
        return { source, ...result };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    } catch (error) {
      if (error instanceof ImageProcessCleanupError) {
        confirmed = false;
        uncertain = true;
      }
      throw error;
    } finally {
      if (confirmed) busy = false;
      for (const wake of waiters) wake();
    }
  };
}
export const processImage = createImageProcessor();

async function execute(
  bytes: Uint8Array,
  asset: ImageAssets,
  signal: AbortSignal,
): Promise<{ png: Uint8Array; metadata: Record<string, Json> }> {
  const env: Record<string, string> = {
    VIPS_CONCURRENCY: '1',
    UV_THREADPOOL_SIZE: '1',
    MALLOC_ARENA_MAX: '2',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key]!;
  // A fixed codec must not load cwd preloads or tsconfig aliases before its checked program.
  const emptyConfig = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';
  const argv = [
    `--config=${emptyConfig}`,
    `--tsconfig-override=${emptyConfig}`,
    '--no-env-file',
    '--no-install',
    '--smol',
    asset.child,
  ];
  let owner: {
    stdout: AsyncIterable<Uint8Array>;
    stderr: AsyncIterable<Uint8Array>;
    exited: Promise<number | null>;
    write(): Promise<void>;
    stop(): Promise<void>;
    close(): Promise<void>;
  };
  if (process.platform === 'win32') {
    let child: ReturnType<typeof startWindowsOwnedChild>;
    try {
      child = startWindowsOwnedChild({
        executable: process.execPath,
        argv,
        cwd: dirname(asset.child),
        env,
        stdin: 'pipe',
        maxMemoryBytes: 512 * 1024 * 1024,
        maxProcesses: 1,
      });
    } catch (error) {
      if (error instanceof WindowsOwnedChildStartError) {
        try {
          await error.cleanup;
        } catch (cause) {
          retained.add(error);
          throw new ImageProcessCleanupError(cause);
        }
      }
      throw new AgentError('image_process_start_failed');
    }
    owner = {
      stdout: child.stdout,
      stderr: child.stderr,
      exited: child.exited,
      async write() {
        for (let offset = 0; offset < bytes.length; offset += 1024 * 1024)
          await child.writeStdin(bytes.subarray(offset, offset + 1024 * 1024));
        await child.endStdin();
      },
      async stop() {
        const fact = await child.stop({ graceMs: 0 });
        if (!fact.job.treeStopped || !fact.root.waitConfirmed)
          throw new ImageProcessCleanupError(fact);
      },
      close: () => child.close(),
    };
  } else {
    // This sealed program has no subprocess or code execution API. A native crash is confined to it.
    const child = spawn(process.execPath, argv, {
      cwd: dirname(asset.child),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let exited = false;
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        exited = true;
        resolve(code);
      });
    });
    void closed.catch(() => {});
    const stop = async () => {
      if (!exited) child.kill('SIGKILL');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ImageProcessCleanupError(undefined)), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    owner = {
      stdout: child.stdout,
      stderr: child.stderr,
      exited: closed,
      stop,
      close: stop,
      write: () =>
        new Promise<void>((resolve, reject) => {
          child.stdin.once('error', reject);
          child.stdin.end(bytes, () => {
            child.stdin.removeListener('error', reject);
            resolve();
          });
        }),
    };
  }
  let stopping: Promise<void> | undefined;
  let rejectStop!: (error: ImageProcessCleanupError) => void;
  const stopFailure = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  void stopFailure.catch(() => {});
  const stop = () =>
    (stopping ??= owner.stop().catch((cause) => {
      const error =
        cause instanceof ImageProcessCleanupError ? cause : new ImageProcessCleanupError(cause);
      rejectStop(error);
      throw error;
    }));
  const abort = () => {
    void stop().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const io = [
    collect(owner.stdout, imageOutputBytes + 4100, stop),
    collect(owner.stderr, 4096, stop),
    owner.exited,
    owner.write(),
  ] as const;
  try {
    const [output, error, code] = await Promise.race([Promise.all(io), stopFailure]);
    signal.throwIfAborted();
    if (code !== 0) {
      const reason = error.toString('utf8');
      throw new AgentError(
        /^image_(?:invalid|format_unsupported|input_too_large|dimensions_exceeded|output_too_large|decode_failed)$/.test(
          reason,
        )
          ? reason
          : 'image_process_failed',
      );
    }
    if (output.length < 4) throw new AgentError('image_process_output_invalid');
    const size = output.readUInt32BE(0);
    if (size < 1 || size > 4096 || size + 4 >= output.length)
      throw new AgentError('image_process_output_invalid');
    let metadata: Record<string, Json>;
    try {
      metadata = JSON.parse(output.toString('utf8', 4, size + 4));
    } catch {
      throw new AgentError('image_process_output_invalid');
    }
    const png = output.subarray(size + 4);
    if (
      metadata?.mediaType !== 'image/png' ||
      metadata.size !== png.length ||
      png.length > imageOutputBytes ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.length < 24 ||
      png.readUInt32BE(16) !== metadata.width ||
      png.readUInt32BE(20) !== metadata.height ||
      typeof metadata.width !== 'number' ||
      typeof metadata.height !== 'number' ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width > 2048 ||
      metadata.height > 2048
    )
      throw new AgentError('image_process_output_invalid');
    return { png, metadata };
  } catch (error) {
    if (!(error instanceof ImageProcessCleanupError)) {
      await stop();
      await Promise.allSettled(io);
      signal.throwIfAborted();
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await stop();
      await owner.close();
    } catch (error) {
      retained.add(owner);
      // biome-ignore lint/correctness/noUnsafeFinally: unconfirmed cleanup must override ordinary read results.
      throw new ImageProcessCleanupError(error);
    }
  }
}
