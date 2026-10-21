import {
  bootstrapLimitBytes,
  type PrivateStartup,
  privateStartupSchema,
  startupLimitBytes,
} from './bootstrap';
import { retainFailedProcess } from './process-failure';
import {
  assembleProcessService,
  ProcessServiceCleanupError,
  type ProcessServiceOptions,
} from './process-service';

/** stdin is startup once, then only the parent's liveness channel; never business RPC. */
async function startupChannel(signal: AbortSignal): Promise<{
  startup: PrivateStartup;
  parentEnded: Promise<void>;
  stopParentWatch: () => Promise<void>;
}> {
  signal.throwIfAborted();
  const reader = Bun.stdin.stream().getReader();
  const stop = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  const release = () => {
    signal.removeEventListener('abort', stop);
    reader.releaseLock();
  };
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    while (!text.includes('\n')) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) throw new Error('startup_channel_closed');
      bytes += chunk.value.byteLength;
      if (bytes > startupLimitBytes) throw new Error('startup_too_large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const line = text.slice(0, text.indexOf('\n'));
    if (text.slice(text.indexOf('\n') + 1).length) throw new Error('unexpected_startup_data');
    const startup = privateStartupSchema.parse(JSON.parse(line));
    signal.throwIfAborted();
    const parentEnded = (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          if (chunk.value.byteLength) throw new Error('unexpected_startup_data');
        }
      } finally {
        release();
      }
    })();
    // Retain protocol failures until the listener has been established and closed.
    void parentEnded.catch(() => {});
    return {
      startup,
      parentEnded,
      async stopParentWatch() {
        await reader.cancel().catch(() => {});
        await parentEnded.catch(() => {});
      },
    };
  } catch (error) {
    await reader.cancel().catch(() => {});
    release();
    throw error;
  }
}

/** Default model assembly is per Run; startup remains usable without model/config/credentials. */
export async function runServiceProcess(options: ProcessServiceOptions = {}): Promise<void> {
  let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
  const stop = new AbortController();
  const stopReason = new Error('service_stop_requested');
  let requestStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    requestStop = () => {
      stop.abort(stopReason);
      resolve();
    };
  });
  // Terminal process-group signals must enter the same drain as private parent EOF.
  // Keep these handlers until durable work and owned resources have actually closed.
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  try {
    const { startup, parentEnded, stopParentWatch } = await startupChannel(stop.signal);
    stop.signal.throwIfAborted();
    service = await assembleProcessService(startup, options);
    if (!stop.signal.aborted) {
      const bootstrap = `${JSON.stringify(service.bootstrap)}\n`;
      if (Buffer.byteLength(bootstrap) > bootstrapLimitBytes)
        throw new Error('bootstrap_too_large');
      process.stdout.write(bootstrap);
    }
    await Promise.race([parentEnded, service.closedPromise, stopping]);
    await service.close();
    await stopParentWatch();
  } catch (error) {
    if (error === stopReason && !service) return;
    if (error instanceof ProcessServiceCleanupError) await retainFailedProcess(error);
    process.stderr.write(`${JSON.stringify({ code: 'service_process_failed' })}\n`);
    process.exitCode = 1;
    try {
      await service?.close();
    } catch {
      process.stderr.write(`${JSON.stringify({ code: 'shutdown_cleanup_unconfirmed' })}\n`);
      await service?.closedPromise;
    }
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}

if (import.meta.main) await runServiceProcess();
