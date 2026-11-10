import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, createRuntime } from '@kite-ai/agent';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import {
  linuxShellInitAsset,
  shellSupervisorAsset,
  windowsShellAssets,
  withBundledRipgrep,
} from '@kite-ai/agent/jobs/shell';
import { McpStdioPortError, mcpStdioGuardianAsset, mcpStdioLinuxAssets } from '@kite-ai/agent/mcp';
import { type ProfileSelection, selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { readSessionLogs } from '@kite-ai/agent/storage';
import { type ConfigureProcessHost, type PrivateStartup, privateStartupSchema } from './bootstrap';
import { createDefaultProcessConfiguration, type ShellConfigurationOptions } from './configuration';
import { startService } from './index';
import { assertMcpSourceStdioAssetsClosed } from './mcp-source-configuration';
import { windowsRuntimePinCloseUnknown } from './native-runtime-assets';
import { runtimeProtectionRoots, verifyRuntimeProtection } from './runtime-protection';
import { encodeServiceStartupDiagnostic } from './startup-diagnostic';
import { measureServiceStartup } from './startup-timing';
import {
  createProfileTraceRuntime,
  type ProfileTraceRuntime,
  selectTraceRuntimeAssetPaths,
  TraceRuntimeCleanupError,
} from './trace-runtime';
import { createTrajectorySource } from './trajectory';
import {
  borrowWindowsPairedArtifact,
  retainWindowsPairedArtifact,
} from './windows-paired-artifact';

type ProcessResources = {
  runtime?: ReturnType<typeof createRuntime>;
  store?: Awaited<ReturnType<typeof openSqliteStore>>;
  artifacts?: ReturnType<typeof createArtifactStore>;
  workspaceSerialLocks?: ReturnType<typeof createWorkspaceSerialLocks>;
  runtimeAssetAccess?: { release(): void };
  trace?: ProfileTraceRuntime;
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
  /** Genuine same-process owner only; never accepted from private startup JSON. */
  windowsArtifact?: ReturnType<typeof retainWindowsPairedArtifact>;
  configure?: ConfigureProcessHost;
  /** Concrete host ports; never accepted from startup JSON, workspace configuration or HTTP. */
  mcpSources?: NonNullable<Parameters<typeof createDefaultProcessConfiguration>[0]['mcpSources']>;
  credentialBackend?: NonNullable<
    Parameters<typeof createDefaultProcessConfiguration>[0]['credentialBackend']
  >;
  /** Trusted composition only; unavailable to startup JSON, configuration and HTTP callers. */
  decorateConfiguration?: (
    configuration: Awaited<ReturnType<ConfigureProcessHost>>,
  ) =>
    | Awaited<ReturnType<ConfigureProcessHost>>
    | Promise<Awaited<ReturnType<ConfigureProcessHost>>>;
  /** Trusted observer identity; never read from startup/configuration JSON. */
  subjectId?: string;
  beforeResourceClose?: () => Promise<void>;
}

/** Standard development hosts share one service module and protect both actual entries. */
function defaultRuntimeAssets(entrypoint: string | undefined): string[] {
  if (!entrypoint || !isAbsolute(entrypoint)) return [];
  const module = fileURLToPath(import.meta.url);
  const suffix = module.endsWith('.ts') ? '.ts' : '.js';
  const entries = ['main', 'daemon-main'].map((name) => join(dirname(module), name + suffix));
  if (!entries.includes(entrypoint)) return [entrypoint];
  for (const path of entries) {
    if (!existsSync(path)) return [entrypoint];
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) return [entrypoint];
  }
  return entries;
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
  let runtimeAssets = startup.runtimeProtection
    ? []
    : [...defaultRuntimeAssets(entrypoint), ...Object.values(selectTraceRuntimeAssetPaths())];
  if (startup.runtimeProtection && process.platform === 'win32') {
    try {
      const actual = {
        entrypoint: entrypoint ?? '',
        executable: process.execPath,
        buildId: startup.buildId,
      };
      const access = options.windowsArtifact
        ? borrowWindowsPairedArtifact(options.windowsArtifact, startup.runtimeProtection, actual)
        : retainWindowsPairedArtifact(startup.runtimeProtection, actual);
      runtimeAssetAccess = access;
      runtimeAssets = [...runtimeProtectionRoots(startup.runtimeProtection)];
    } catch (error) {
      if (
        windowsRuntimePinCloseUnknown(error) ||
        (error instanceof Error && error.message === 'paired_artifact_close_unknown')
      )
        throw new ProcessServiceCleanupError('runtime_assembly', error, error, {
          runtimeAssetAccess,
        });
      throw error;
    }
  } else if (startup.runtimeProtection) {
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
      if (windowsRuntimePinCloseUnknown(error))
        throw new ProcessServiceCleanupError('runtime_assembly', error, error, {
          runtimeAssetAccess,
        });
      try {
        runtimeAssetAccess.release();
      } catch (cleanupError) {
        throw new ProcessServiceCleanupError('runtime_assembly', error, cleanupError, {
          runtimeAssetAccess,
        });
      }
      throw error;
    }
  }
  let configuration: Awaited<ReturnType<ConfigureProcessHost>>;
  try {
    const shell = configure
      ? undefined
      : await measureServiceStartup('shell_runtime', () => packagedShellAssets(selected));
    configuration = await measureServiceStartup('configuration', async () => {
      const configured = configure
        ? await configure(startup, hostContext)
        : createDefaultProcessConfiguration({
            ordinaryHostTools: true,
            profile: selected,
            observerSubjectId: subjectId,
            hostConfiguration: startup.hostConfiguration,
            desktopBrowser: startup.desktopBrowser,
            mcpSources: { ...packagedMcpSourceAssets(), ...options.mcpSources },
            ...(options.credentialBackend ? { credentialBackend: options.credentialBackend } : {}),
            runtimeAssets,
            shell,
          });
      return options.decorateConfiguration
        ? await options.decorateConfiguration(configured)
        : configured;
    });
  } catch (error) {
    try {
      assertMcpSourceStdioAssetsClosed(selected.profileAccessKey);
      runtimeAssetAccess?.release();
    } catch (cleanupError) {
      throw new ProcessServiceCleanupError('runtime_assembly', error, cleanupError, {
        runtimeAssetAccess,
      });
    }
    throw error;
  }
  const {
    configurationManagement,
    permissionManagement,
    diagnosticSource,
    skillCatalogue,
    userMcpManagement,
    bindWorkspaceSerialLocks,
    ...runtimeConfiguration
  } = configuration;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let artifacts: ReturnType<typeof createArtifactStore> | undefined;
  let workspaceSerialLocks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let trace: ProfileTraceRuntime | undefined;
  try {
    store = await measureServiceStartup('store', () =>
      openSqliteStore({
        dataRoot: selected.dataRoot,
        profile: selected.profile,
      }),
    );
  } catch {
    // Safe diagnostic HTTP survives Store failure; no replacement empty Store.
    process.stderr.write(`${JSON.stringify({ code: 'data_unavailable' })}\n`);
    process.stderr.write(
      encodeServiceStartupDiagnostic({ code: 'data_unavailable', stage: 'opening_store' }),
    );
  }
  if (store) {
    try {
      await measureServiceStartup('runtime', () => {
        try {
          artifacts = createArtifactStore({ profile: selected, store });
        } catch (error) {
          if (!(error instanceof AgentError) || error.code !== 'artifact_platform_unsupported')
            throw error;
          process.stderr.write(`${JSON.stringify({ code: 'artifact_platform_unsupported' })}\n`);
        }
        if (!runtimeConfiguration.workspaceSerialLocks)
          workspaceSerialLocks = createWorkspaceSerialLocks(selected);
        bindWorkspaceSerialLocks?.(
          (runtimeConfiguration.workspaceSerialLocks ?? workspaceSerialLocks)!,
        );
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
      });
    } catch (error) {
      try {
        assertMcpSourceStdioAssetsClosed(selected.profileAccessKey);
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
  const trajectory = store
    ? createTrajectorySource(
        store,
        runtime ? (input) => runtime!.readTrajectoryEvidence(input) : undefined,
      )
    : undefined;
  try {
    if (trajectory) {
      try {
        trace = createProfileTraceRuntime({
          profile: selected,
          source: trajectory,
          subjectId,
          ...(options.credentialBackend ? { credentialBackend: options.credentialBackend } : {}),
        });
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'trace_unavailable')
          throw error;
        process.stderr.write(`${JSON.stringify({ code: 'trace_unavailable' })}\n`);
      }
    }
    return await measureServiceStartup('http', () =>
      startService({
        subjectId,
        runtime,
        beforeResourceClose: async () => {
          await trace?.close();
          assertMcpSourceStdioAssetsClosed(selected.profileAccessKey);
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
        userMcpManagement: userMcpManagement?.(runtime),
        sessionLogs: store
          ? (query, observer) => readSessionLogs(store!, query, observer)
          : undefined,
        trajectory,
        traceHost: trace?.host,
        buildId: startup.buildId,
        instanceId: startup.instanceId,
        token: startup.token,
        capabilities: startup.capabilities,
        profile: {
          dataRoot: selected.dataRoot,
          name: selected.profile,
          accessKey: selected.profileAccessKey,
        },
      }),
    );
  } catch (error) {
    try {
      assertMcpSourceStdioAssetsClosed(selected.profileAccessKey);
      await trace?.close();
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
        trace,
      });
    }
    if (error instanceof TraceRuntimeCleanupError)
      throw new ProcessServiceCleanupError('http_assembly', error, error, {
        runtime,
        store,
        artifacts,
        workspaceSerialLocks,
        runtimeAssetAccess,
        trace,
      });
    throw error;
  }
}

/** Process assembly selects only this built package's finite assets; no .ts fallback. */
function packagedMcpSourceAssets() {
  try {
    return {
      stdio: {
        guardianPath: mcpStdioGuardianAsset(),
        bunExecutable: process.execPath,
        ...(process.platform === 'linux' ? { linux: mcpStdioLinuxAssets() } : {}),
      },
    };
  } catch (error) {
    if (!(error instanceof McpStdioPortError) || error.code !== 'mcp_stdio_asset_unavailable')
      throw error;
    return {};
  }
}

async function packagedShellAssets(
  profile: ProfileSelection,
): Promise<ShellConfigurationOptions | undefined> {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) return;
  if (process.platform === 'win32' && !process.versions.bun) return;
  let supervisorPath: string;
  let windows: Awaited<ReturnType<typeof windowsShellAssets>> | undefined;
  try {
    if (process.platform === 'win32')
      windows = await windowsShellAssets(join(profile.profilePath, 'windows-sandbox'));
    supervisorPath =
      windows?.runner ??
      (process.platform === 'linux' ? linuxShellInitAsset() : shellSupervisorAsset());
  } catch (error) {
    if (
      !(error instanceof Error) ||
      ![
        'shell_supervisor_asset_unavailable',
        'linux_shell_init_asset_unavailable',
        'windows_shell_asset_unavailable',
        'windows_git_bash_unavailable',
      ].includes(error.message)
    )
      throw error;
    return;
  }
  const bubblewrap = process.platform === 'linux' ? Bun.which('bwrap') : undefined;
  if (process.platform === 'linux' && !bubblewrap) return;
  const ripgrep = withBundledRipgrep(
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  );
  return {
    platform: process.platform as 'linux' | 'darwin' | 'win32',
    configurationId: windows
      ? 'default.windows-host-shell-v1'
      : process.platform === 'linux'
        ? 'default.linux-host-shell-v1'
        : 'default.macos-host-shell-v1',
    env: ripgrep.env,
    supervisorPath,
    bunExecutable: process.execPath,
    shellExecutable: windows?.shell ?? '/bin/sh',
    ...(windows
      ? {
          windows: {
            coreutilsPath: windows.coreutils,
            fullShellExecutable: windows.fullShell,
            stateRoot: windows.stateRoot,
          },
        }
      : {}),
    ...(bubblewrap ? { linux: { bubblewrapPath: realpathSync.native(bubblewrap) } } : {}),
    host: {
      controlBase: profile.coordinationPath,
      protectedRoots: [],
      readonlyAssets: [],
      runtimeReadOnlyRoots: [],
    },
  };
}
