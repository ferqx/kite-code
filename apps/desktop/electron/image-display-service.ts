import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Writable } from 'node:stream';
import {
  isNativeImageDisplayEdge,
  isNativeImageDisplayMediaType,
  isNativeImageDisplayRegion,
  isNativeImageDisplayResultForRequest,
  type NativeImageDisplayEdge,
  type NativeImageDisplayMediaType,
  type NativeImageDisplayRegion,
  type NativeImageDisplayResult,
  nativeImageDisplayOutputByteLimit,
  nativeImageDisplaySourceByteLimit,
} from '../src/native-image-display-bridge';
import { imageDisplayWebpDimensions } from './image-display-format';

export interface ImageDisplayAssets {
  child: string;
  sha256: string;
  executable: string;
}
export interface ImageDisplayInput {
  /** Paths are trusted Main snapshots, never an IPC parameter. */
  source: { path: string } | { bytes: Uint8Array };
  mediaType: NativeImageDisplayMediaType;
  edge: NativeImageDisplayEdge;
  signal: AbortSignal;
  region?: NativeImageDisplayRegion;
}
declare const __KITE_DESKTOP_IMAGE_DISPLAY__: { relativePath: string; sha256: string };
const error = (code: string) => Error(`native_image_display_${code}`);
function defaultAssets(): ImageDisplayAssets {
  if (typeof __KITE_DESKTOP_IMAGE_DISPLAY__ === 'undefined') throw error('unavailable');
  return {
    // Bun inlines source __dirname, which is not the relocated native app directory.
    child: join(
      (require('electron') as typeof import('electron')).app.getAppPath(),
      __KITE_DESKTOP_IMAGE_DISPLAY__.relativePath,
    ),
    sha256: __KITE_DESKTOP_IMAGE_DISPLAY__.sha256,
    executable: process.execPath,
  };
}

interface ImageDisplaySource {
  size: number;
  write(stream: Writable, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
const writeChunk = (stream: Writable, bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) =>
    stream.write(bytes, (cause?: Error | null) => (cause ? reject(cause) : resolve())),
  );
const endInput = (stream: Writable) =>
  new Promise<void>((resolve, reject) =>
    stream.end((cause?: Error | null) => (cause ? reject(cause) : resolve())),
  );
async function openSource(input: ImageDisplayInput): Promise<ImageDisplaySource> {
  input.signal.throwIfAborted();
  if ('bytes' in input.source) {
    const bytes = input.source.bytes;
    return {
      size: bytes.byteLength,
      async close() {},
      async write(stream, signal) {
        for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
          signal.throwIfAborted();
          await writeChunk(stream, bytes.subarray(offset, offset + 65536));
        }
        signal.throwIfAborted();
        await endInput(stream);
      },
    };
  }
  if (!isAbsolute(input.source.path)) throw error('invalid');
  // The authorized caller supplies a private immutable snapshot. No whole-file Main buffer.
  const handle = await open(input.source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) throw error('invalid');
    if (stat.size > nativeImageDisplaySourceByteLimit) throw error('source_too_large');
    return {
      size: stat.size,
      close: () => handle.close(),
      async write(stream, signal) {
        const bytes = Buffer.allocUnsafe(65536);
        let offset = 0;
        while (offset < stat.size) {
          signal.throwIfAborted();
          const result = await handle.read(
            bytes,
            0,
            Math.min(bytes.length, stat.size - offset),
            offset,
          );
          if (!result.bytesRead) throw error('invalid');
          await writeChunk(stream, bytes.subarray(0, result.bytesRead));
          offset += result.bytesRead;
        }
        const after = await handle.stat();
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw error('invalid');
        signal.throwIfAborted();
        await endInput(stream);
      },
    };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

/** One shared queue, independent from attachments and model image processing. */
export function createImageDisplayService(
  options: { assets?: () => ImageDisplayAssets; timeoutMs?: number; closeTimeoutMs?: number } = {},
) {
  type Work = {
    input: ImageDisplayInput;
    controller: AbortController;
    weight: number;
    abort(): void;
    resolve(value: NativeImageDisplayResult): void;
    reject(reason: unknown): void;
  };
  const queue: Work[] = [];
  let retainedBytes = 0,
    active: Work | undefined,
    disposed = false,
    uncertain = false;
  const idle: (() => void)[] = [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(closeTimeoutMs) ||
    closeTimeoutMs < 1 ||
    closeTimeoutMs > 5000
  )
    throw error('invalid');
  const release = (work: Work) => work.input.signal.removeEventListener('abort', work.abort);
  const pump = () => {
    if (active || uncertain) return;
    const work = queue.shift();
    if (!work) {
      for (const wake of idle.splice(0)) wake();
      return;
    }
    retainedBytes -= work.weight;
    active = work;
    void (async () => {
      const timer = setTimeout(() => work.controller.abort(error('timeout')), timeoutMs);
      try {
        const signal = work.controller.signal;
        signal.throwIfAborted();
        const asset = (options.assets ?? defaultAssets)();
        if (
          !isAbsolute(asset.child) ||
          !isAbsolute(asset.executable) ||
          !/^[a-f0-9]{64}$/.test(asset.sha256) ||
          createHash('sha256')
            .update(await readFile(asset.child))
            .digest('hex') !== asset.sha256
        )
          throw error('unavailable');
        signal.throwIfAborted();
        const source = await openSource({ ...work.input, signal });
        let result: NativeImageDisplayResult;
        try {
          signal.throwIfAborted();
          result = await execute(source, work.input, asset, signal, closeTimeoutMs);
        } finally {
          await source.close();
        }
        signal.throwIfAborted();
        work.resolve(result);
      } catch (cause) {
        if (cause instanceof Error && cause.message === 'native_image_display_exit_unconfirmed')
          uncertain = true;
        work.reject(cause);
      } finally {
        clearTimeout(timer);
        release(work);
        active = undefined;
        if (uncertain) {
          for (const pending of queue.splice(0)) {
            release(pending);
            pending.reject(error('exit_unconfirmed'));
          }
          retainedBytes = 0;
          for (const wake of idle.splice(0)) wake();
        } else pump();
      }
    })();
  };
  return {
    render(input: ImageDisplayInput): Promise<NativeImageDisplayResult> {
      if (disposed || uncertain)
        return Promise.reject(error(uncertain ? 'exit_unconfirmed' : 'unavailable'));
      if (input.signal.aborted) return Promise.reject(input.signal.reason);
      if (!isNativeImageDisplayMediaType(input.mediaType) || !isNativeImageDisplayEdge(input.edge))
        return Promise.reject(error('invalid'));
      if (
        input.region !== undefined &&
        (!isNativeImageDisplayRegion(input.region) || input.edge > 2048)
      )
        return Promise.reject(error('invalid'));
      input = { ...input, ...(input.region === undefined ? {} : { region: { ...input.region } }) };
      const bytes = 'bytes' in input.source ? input.source.bytes : undefined;
      if (bytes && (!(bytes instanceof Uint8Array) || bytes.byteLength < 1))
        return Promise.reject(error('invalid'));
      if (bytes && bytes.byteLength > nativeImageDisplaySourceByteLimit)
        return Promise.reject(error('source_too_large'));
      const weight = bytes?.byteLength ?? 0;
      if (queue.length >= 8 || retainedBytes + weight > nativeImageDisplaySourceByteLimit)
        return Promise.reject(error('queue_full'));
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const work: Work = {
          input,
          controller,
          weight,
          resolve,
          reject,
          abort() {
            controller.abort(input.signal.reason ?? error('cancelled'));
            const index = queue.indexOf(work);
            if (index >= 0) {
              queue.splice(index, 1);
              retainedBytes -= weight;
              release(work);
              reject(controller.signal.reason);
            }
          },
        };
        input.signal.addEventListener('abort', work.abort, { once: true });
        queue.push(work);
        retainedBytes += weight;
        if (input.signal.aborted) work.abort();
        pump();
      });
    },
    async dispose() {
      disposed = true;
      for (const work of queue.splice(0)) {
        release(work);
        work.reject(error('cancelled'));
      }
      retainedBytes = 0;
      if (active) {
        active.controller.abort(error('cancelled'));
        await new Promise<void>((resolve) => idle.push(resolve));
      }
      if (uncertain) throw error('exit_unconfirmed');
    },
  };
}

async function execute(
  source: ImageDisplaySource,
  input: ImageDisplayInput,
  asset: ImageDisplayAssets,
  signal: AbortSignal,
  closeTimeoutMs: number,
): Promise<NativeImageDisplayResult> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    VIPS_CONCURRENCY: '1',
    UV_THREADPOOL_SIZE: '1',
    MALLOC_ARENA_MAX: '2',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key]!;
  // No NODE_OPTIONS/PATH/preloads or app credentials. This fixed child never spawns descendants.
  const child = spawn(
    asset.executable,
    [
      asset.child,
      input.mediaType,
      String(input.edge),
      String(source.size),
      JSON.stringify(input.region ?? null),
    ],
    {
      cwd: dirname(asset.child),
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  let closed = false;
  const close = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      closed = true;
      resolve(code);
    }),
  );
  const failed = new Promise<never>((_, reject) =>
    child.once('error', () => reject(error('process_failed'))),
  );
  void failed.catch(() => {});
  let stopPromise: Promise<void> | undefined;
  const stop = () =>
    (stopPromise ??= (async () => {
      if (!closed && child.pid !== undefined) child.kill('SIGKILL');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          close,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(error('exit_unconfirmed')), closeTimeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })());
  // An unconfirmed exit poisons the queue, rather than launching a second decoder.
  let stopFailure!: (cause: unknown) => void;
  const failedStop = new Promise<never>((_, reject) => {
    stopFailure = reject;
  });
  void failedStop.catch(() => {});
  const abort = () => {
    void stop().catch(stopFailure);
  };
  const collect = async (stream: AsyncIterable<Uint8Array>, maximum: number) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of stream) {
      size += value.length;
      if (size > maximum) {
        abort();
        throw error('output_invalid');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  };
  child.stdin!.on('error', () => {});
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const io = [
    collect(child.stdout!, nativeImageDisplayOutputByteLimit + 4100),
    collect(child.stderr!, 4096),
    close,
    source.write(child.stdin!, signal),
  ] as const;
  try {
    const [output, stderr, code] = await Promise.race([Promise.all(io), failed, failedStop]);
    signal.throwIfAborted();
    if (code !== 0) {
      const reason = stderr.toString('utf8');
      throw /^native_image_display_(?:invalid|format_unsupported|source_too_large|dimensions_exceeded|output_invalid|decode_failed)$/.test(
        reason,
      )
        ? Error(reason)
        : error('process_failed');
    }
    if (output.length < 5) throw error('output_invalid');
    const headerLength = output.readUInt32BE(0);
    if (headerLength < 1 || headerLength > 4096 || headerLength + 4 >= output.length)
      throw error('output_invalid');
    let header: unknown;
    try {
      header = JSON.parse(output.toString('utf8', 4, 4 + headerLength));
    } catch {
      throw error('output_invalid');
    }
    const result = { ...(header as object), bytes: output.subarray(4 + headerLength) };
    if (!isNativeImageDisplayResultForRequest(result, input) || result.mimeType !== 'image/webp')
      throw error('output_invalid');
    const dimensions = imageDisplayWebpDimensions(result.bytes);
    if (dimensions.width !== result.width || dimensions.height !== result.height)
      throw error('output_invalid');
    return result;
  } catch (cause) {
    await stop();
    await Promise.allSettled(io);
    signal.throwIfAborted();
    throw cause;
  } finally {
    signal.removeEventListener('abort', abort);
    // Neither cancellation nor output admission releases the decoder slot before actual exit.
    await stop();
  }
}
const imageDisplayService = createImageDisplayService();
export const renderImageDisplay = imageDisplayService.render;
export const disposeImageDisplay = imageDisplayService.dispose;
