import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AgentError, createRuntime } from '@kite-ai/agent';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { McpStdioPortError, mcpStdioGuardianAsset } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { readSessionLogs } from '@kite-ai/agent/storage';
import { type ConfigureProcessHost, type PrivateStartup, privateStartupSchema } from './bootstrap';
import { createDefaultProcessConfiguration } from './configuration';
import { startService } from './index';
import { runtimeProtectionRoots, verifyRuntimeProtection } from './runtime-protection';

type ProcessResources = {
  runtime?: ReturnType<typeof createRuntime>;
  store?: Awaited<ReturnType<typeof openSqliteStore>>;
  artifacts?: ReturnType<typeof createArtifactStore>;
  workspaceSerialLocks?: ReturnType<typeof createWorkspaceSerialLocks>;
  runtimeAssetAccess?: { release(): void };
};

/** Trusted process marker; errors and retained owners must never become HTTP diagnostics. */
export class ProcessServiceCleanupError extends Error {
  readonly code = 'process_service_cleanup_unconfirmed';
  readonly phase: 'runtime_assembly' | 'http_assembly';

  constructor(
    phase: ProcessServiceCleanupError['phase'],
    originalError: unknown,
    cleanupError: unknown,
    resources: ProcessResources,
  ) {
    super('process_service_cleanup_unconfirmed', {
      cause: Object.freeze({
        originalError,
        cleanupError,
        resources: Object.freeze({ ...resources }),
      }),
    });
    this.name = 'ProcessServiceCleanupError';
    this.phase = phase;
  }

  toJSON() {
    return { code: this.code, phase: this.phase };
  }
}

export interface ProcessServiceOptions {
  configure?: ConfigureProcessHost;
  /** Trusted observer identity; never read from startup/configuration JSON. */
  subjectId?: string;
  beforeResourceClose?: () => Promise<void>;
}

/** One selected profile, Runtime and HTTP listener; the caller owns process liveness. */
export async function assembleProcessService(
  input: PrivateStartup,
  options: ProcessServiceOptions = {},
): Promise<Awaited<ReturnType<typeof startService>>> {
  const startup = privateStartupSchema.parse(input);
  const configure = options.configure;
  const subjectId = options.subjectId ?? 'local-user';
  if (typeof subjectId !== 'string' || !subjectId || subjectId.length > 256)
    throw new AgentError('invalid_subject');
  const hostContext = Object.freeze({ subjectId });
  const beforeResourceClose = options.beforeResourceClose;
  const entrypoint = process.argv[1];
  const selected = selectProfile({
    dataRoot: startup.profile.dataRoot,
    profile: startup.profile.profile,
  });
  if (
    selected.dataRoot !== startup.profile.dataRoot ||
    selected.profileAccessKey !== startup.profile.profileAccessKey
  )
    throw new Error('profile_identity_mismatch');
  let runtimeAssetAccess: { release(): void } | undefined;
  let runtimeAssets = entrypoint && isAbsolute(entrypoint) ? [entrypoint] : [];
  if (startup.runtimeProtection) {
    const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
    runtimeAssetAccess = {
      release() {
        for (;;) {
          const lease = leases.at(-1);
          if (!lease) return;
          lease.release();
          leases.pop();
        }
      },
    };
    try {
      for (const root of runtimeProtectionRoots(startup.runtimeProtection))
        leases.push(acquireArtifactAccess({ root: realpathSync(root), mode: 'shared' }));
      runtimeAssets = [
        ...verifyRuntimeProtection(startup.runtimeProtection, {
          entrypoint: entrypoint ?? '',
          executable: process.execPath,
          buildId: startup.buildId,
        }),
      ];
    } catch (error) {
      runtimeAssetAccess.release();
      throw error;
    }
  }
  let configuration: Awaited<ReturnType<ConfigureProcessHost>>;
  try {
    configuration = configure
      ? await configure(startup, hostContext)
      : createDefaultProcessConfiguration({
          profile: selected,
          observerSubjectId: subjectId,
          hostConfiguration: startup.hostConfiguration,
          mcpSources: packagedMcpSourceAssets(),
          runtimeAssets,
        });
  } catch (error) {
    runtimeAssetAccess?.release();
    throw error;
  }
  const {
    configurationManagement,
    permissionManagement,
    diagnosticSource,
    skillCatalogue,
    ...runtimeConfiguration
  } = configuration;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let artifacts: ReturnType<typeof createArtifactStore> | undefined;
  let workspaceSerialLocks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  try {
    store = await openSqliteStore({
      dataRoot: selected.dataRoot,
      profile: selected.profile,
    });
  } catch {
    // Safe diagnostic HTTP survives Store failure; no replacement empty Store.
    process.stderr.write(`${JSON.stringify({ code: 'data_unavailable' })}\n`);
  }
  if (store) {
    try {
      try {
        artifacts = createArtifactStore({ profile: selected, store });
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'artifact_platform_unsupported')
          throw error;
        process.stderr.write(`${JSON.stringify({ code: 'artifact_platform_unsupported' })}\n`);
      }
      if (!runtimeConfiguration.workspaceSerialLocks)
        workspaceSerialLocks = createWorkspaceSerialLocks(selected);
      runtime = createRuntime({
        ...runtimeConfiguration,
        workspaceSerialLocks: runtimeConfiguration.workspaceSerialLocks ?? workspaceSerialLocks,
        artifacts,
        store,
        instanceId: startup.instanceId,
        permissions: configuration.permissions ?? {
          async authorize() {
            return { allowed: false, revision: 'unconfigured' };
          },
        },
      });
    } catch (error) {
      try {
        await workspaceSerialLocks?.close();
        await artifacts?.close();
        await store.close();
        runtimeAssetAccess?.release();
      } catch (cleanupError) {
        throw new ProcessServiceCleanupError('runtime_assembly', error, cleanupError, {
          store,
          artifacts,
          workspaceSerialLocks,
          runtimeAssetAccess,
        });
      }
      throw error;
    }
  }
  try {
    return await startService({
      subjectId,
      runtime,
      beforeResourceClose: async () => {
        await beforeResourceClose?.();
        await workspaceSerialLocks?.close();
      },
      afterResourceClose: async () => {
        runtimeAssetAccess?.release();
      },
      configurationManagement: configurationManagement?.(runtime),
      permissionManagement: permissionManagement?.(runtime),
      diagnosticSource,
      skillCatalogue,
      sessionLogs: store
        ? (query, observer) => readSessionLogs(store!, query, observer)
        : undefined,
      buildId: startup.buildId,
      instanceId: startup.instanceId,
      token: startup.token,
      capabilities: startup.capabilities,
      profile: {
        dataRoot: selected.dataRoot,
        name: selected.profile,
        accessKey: selected.profileAccessKey,
      },
    });
  } catch (error) {
    try {
      await runtime?.close();
      await workspaceSerialLocks?.close();
      runtimeAssetAccess?.release();
    } catch (cleanupError) {
      throw new ProcessServiceCleanupError('http_assembly', error, cleanupError, {
        runtime,
        store,
        artifacts,
        workspaceSerialLocks,
        runtimeAssetAccess,
      });
    }
    throw error;
  }
}

/** Process assembly selects only this built package's finite assets; no .ts fallback. */
function packagedMcpSourceAssets() {
  try {
    return { stdio: { guardianPath: mcpStdioGuardianAsset(), bunExecutable: process.execPath } };
  } catch (error) {
    if (!(error instanceof McpStdioPortError) || error.code !== 'mcp_stdio_asset_unavailable')
      throw error;
    return {};
  }
}
