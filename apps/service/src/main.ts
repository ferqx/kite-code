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
async function startupChannel(): Promise<{
  startup: PrivateStartup;
  parentEnded: Promise<void>;
  stopParentWatch: () => Promise<void>;
}> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  while (!text.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('startup_channel_closed');
    bytes += chunk.value.byteLength;
    if (bytes > startupLimitBytes) throw new Error('startup_too_large');
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  const line = text.slice(0, text.indexOf('\n'));
  if (text.slice(text.indexOf('\n') + 1).length) throw new Error('unexpected_startup_data');
  const startup = privateStartupSchema.parse(JSON.parse(line));
  const parentEnded = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        if (chunk.value.byteLength) throw new Error('unexpected_startup_data');
      }
    } finally {
      reader.releaseLock();
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
}

/** Default model assembly is per Run; startup remains usable without model/config/credentials. */
export async function runServiceProcess(options: ProcessServiceOptions = {}): Promise<void> {
  let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
  try {
    const { startup, parentEnded, stopParentWatch } = await startupChannel();
    service = await assembleProcessService(startup, options);
    const bootstrap = `${JSON.stringify(service.bootstrap)}\n`;
    if (Buffer.byteLength(bootstrap) > bootstrapLimitBytes) throw new Error('bootstrap_too_large');
    process.stdout.write(bootstrap);
    await Promise.race([parentEnded, service.closedPromise]);
    await service.close();
    await stopParentWatch();
  } catch (error) {
    if (error instanceof ProcessServiceCleanupError) await retainFailedProcess(error);
    process.stderr.write(`${JSON.stringify({ code: 'service_process_failed' })}\n`);
    process.exitCode = 1;
    try {
      await service?.close();
    } catch {
      process.stderr.write(`${JSON.stringify({ code: 'shutdown_cleanup_unconfirmed' })}\n`);
      await service?.closedPromise;
    }
  }
}

if (import.meta.main) await runServiceProcess();
