import { lstatSync, realpathSync } from 'node:fs';
import { selectProfile } from '@kite-ai/agent/profile';
import { preflightSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { type ConfigureProcessHost, startupLimitBytes } from './bootstrap';
import { bootstrapSchema } from './daemon/bootstrap';
import { reserveDaemonEndpoint, selectDaemonEndpoint } from './daemon/endpoint';
import { DaemonEndpointCleanupError, endpointCleanupUnknown } from './daemon/reservation';
import { loadDaemonWebAssets } from './daemon/web-assets';
import { type DaemonStartup, daemonPreflightSchema, daemonStartupSchema } from './daemon-startup';
import { startDevelopmentWeb } from './development-web';
import { retainFailedProcess } from './process-failure';
import { assembleProcessService, ProcessServiceCleanupError } from './process-service';
import { retainWindowsPairedArtifact } from './windows-paired-artifact';

export async function runDaemonProcess(options: { configure?: ConfigureProcessHost } = {}) {
  let artifact: ReturnType<typeof retainWindowsPairedArtifact> | undefined;
  try {
    return await runDaemonProcessInner(options, (startup) => {
      if (process.platform === 'win32' && startup.runtimeProtection)
        artifact = retainWindowsPairedArtifact(startup.runtimeProtection, {
          entrypoint: process.argv[1] ?? '',
          executable: process.execPath,
          buildId: startup.buildId,
        });
    });
  } catch (error) {
    if (
      process.platform === 'win32' &&
      error instanceof Error &&
      [
        'paired_artifact_close_unknown',
        'artifact_access_acquire_close_unknown',
        'artifact_scope_release_failed',
        'windows_installation_coordination_close_failed',
      ].includes(error.message)
    )
      await retainFailedProcess({
        code: 'daemon_artifact_close_unknown',
        phase: 'daemon_artifact',
        cause: { error, artifact },
      });
    if (endpointCleanupUnknown(error))
      await retainFailedProcess(
        error instanceof DaemonEndpointCleanupError
          ? error
          : new DaemonEndpointCleanupError(error, { artifact }),
      );
    throw error;
  } finally {
    try {
      artifact?.release();
    } catch (error) {
      await retainFailedProcess({
        code: 'daemon_artifact_close_unknown',
        phase: 'daemon_artifact',
        cause: { error, artifact },
      });
    }
  }
}

async function readStartup(): Promise<DaemonStartup> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '',
    bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw Error('daemon_startup_closed');
      bytes += chunk.value.byteLength;
      if (bytes > startupLimitBytes) throw Error('daemon_startup_too_large');
      text += decoder.decode(chunk.value, { stream: true });
      const end = text.indexOf('\n');
      if (end < 0) continue;
      text += decoder.decode();
      if (end !== text.length - 1) throw Error('daemon_startup_invalid');
      return daemonStartupSchema.parse(JSON.parse(text.slice(0, end)));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Explicit shared process. Parent EOF only ends private startup; it is never daemon shutdown. */
async function runDaemonProcessInner(
  options: { configure?: ConfigureProcessHost },
  admit: (startup: DaemonStartup['startup']) => void,
) {
  // A launcher may leave after the private handoff. Broken diagnostic pipes must not kill work.
  process.stderr.on('error', () => {});
  process.stdout.on('error', () => {});
  const input = await readStartup();
  const { startup } = input;
  // A preflight/endpoint failure must not drop the selected candidate's usage protection.
  admit(startup);
  const selected = selectProfile({
    dataRoot: startup.profile.dataRoot,
    profile: startup.profile.profile,
  });
  if (
    selected.dataRoot !== startup.profile.dataRoot ||
    selected.profileAccessKey !== startup.profile.profileAccessKey
  )
    throw Error('profile_identity_mismatch');
  if (
    realpathSync(input.workspace) !== input.workspace ||
    !lstatSync(input.workspace).isDirectory()
  )
    throw Error('daemon_invalid_workspace');
  const assets = loadDaemonWebAssets(input.web);
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: startup.profile.profileAccessKey,
    explicitSocket: input.socket,
  });
  const profile = {
    dataRoot: startup.profile.dataRoot,
    name: startup.profile.profile,
    accessKey: startup.profile.profileAccessKey,
  };
  if (input.operation === 'preflight') {
    const result = await preflightSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.name,
    });
    process.stdout.write(
      `${JSON.stringify(daemonPreflightSchema.parse({ operation: 'preflight', instanceId: startup.instanceId, buildId: startup.buildId, profile, result }))}\n`,
    );
    return;
  }
  const owner = await reserveDaemonEndpoint(endpoint, {
    profile,
    instanceId: startup.instanceId,
    buildId: startup.buildId,
    workspace: input.workspace,
  });
  let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
  let gateway: ReturnType<typeof startDevelopmentWeb> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let signalled = false;
  let ready = false;
  const close = () => {
    signalled = true;
    if (ready) void service?.close().catch(() => {});
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  try {
    service = await assembleProcessService(startup, {
      configure: options.configure,
      beforeResourceClose: async () => {
        await gateway?.close();
        client?.disposeNetwork();
      },
    });
    if (signalled) {
      await service.close();
      return;
    }
    client = createClient({
      endpoint: service.endpoint,
      token: startup.token,
      expected: {
        profile,
        instanceId: startup.instanceId,
        buildId: startup.buildId,
        apiMajor: 1,
        requiredCapabilities: [],
      },
      bootstrap: service.bootstrap,
    });
    await client.connect();
    gateway = startDevelopmentWeb({ admittedClient: client, assets });
    await owner.listen({
      httpEndpoint: service.endpoint,
      token: startup.token,
      webOrigin: gateway.endpoint,
    });
    ready = true;
    if (signalled) {
      await service.close();
      return;
    }
    const record = owner.reservation;
    const bootstrap = bootstrapSchema.parse({
      requestVersion: 1,
      requestId: startup.instanceId,
      operation: 'bootstrap',
      profile,
      instanceId: startup.instanceId,
      buildId: startup.buildId,
      httpEndpoint: service.endpoint,
      token: startup.token,
      pid: record.pid,
      processStartIdentity: record.processStartIdentity,
      workspace: record.workspace,
      webOrigin: gateway.endpoint,
    });
    process.stdout.write(`${JSON.stringify(bootstrap)}\n`);
    await service.closedPromise;
  } catch (error) {
    if (error instanceof ProcessServiceCleanupError) await retainFailedProcess(error);
    if (service) {
      try {
        await service.close();
      } catch {
        process.stderr.write(`${JSON.stringify({ code: 'shutdown_cleanup_unconfirmed' })}\n`);
        // Keep the original diagnostic Service and native owner until actual successful cleanup.
        await service.closedPromise;
      }
    }
    throw error;
  } finally {
    process.removeListener('SIGTERM', close);
    process.removeListener('SIGINT', close);
    await owner.close();
  }
}

if (import.meta.main) {
  try {
    await runDaemonProcess();
  } catch {
    process.stderr.write(`${JSON.stringify({ code: 'daemon_process_failed' })}\n`);
    process.exitCode = 1;
  }
}
