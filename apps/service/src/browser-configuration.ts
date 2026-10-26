import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  agentBrowserExecutableAsset,
  agentBrowserRuntimeAssets,
  browserToolIds,
  createAgentBrowserController,
  createBrowserExtension,
  createUnavailableBrowserController,
  type NativeBrowserTransportOptions,
  nativeBrowserUnavailableReason,
} from '@kite-ai/agent/browser';
import { linuxShellInitAsset } from '@kite-ai/agent/jobs/shell';
import { builtinCapability, type CapabilityDescription } from '@kite-ai/agent/permissions';

/** Programmatic host policy only. Never read these assets, limits or private roots from JSONC. */
export type BrowserConfigurationOptions = NativeBrowserTransportOptions;

function executable(path: string): string | null {
  if (!isAbsolute(path) || path.includes('\0')) return null;
  try {
    const resolved = realpathSync.native(path);
    if (!statSync(resolved).isFile()) return null;
    accessSync(resolved, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}
function installedBrowser(): string | null {
  // Fixed vendor locations only: no PATH, environment browser flags, user profile or download.
  const candidates =
    process.platform === 'linux'
      ? [
          '/opt/google/chrome/chrome',
          '/usr/lib/chromium/chromium',
          '/usr/lib64/chromium-browser/chromium-browser',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : [];
  return candidates.map(executable).find((path) => path !== null) ?? null;
}

/** One inert Service-scoped controller; the ordinary browser.session Job owns all live resources. */
export function createBrowserConfiguration(options: {
  readonly configuration?: BrowserConfigurationOptions | false;
  readonly privateDirectory: string;
}) {
  const enabled = options.configuration !== false;
  let transport: NativeBrowserTransportOptions | undefined;
  let unavailableReason: string | undefined;
  let runtimeAssets: readonly string[] = [];
  if (!enabled) unavailableReason = 'browser_disabled_by_host';
  else if (options.configuration) {
    const configured = structuredClone(options.configuration);
    const paths = [
      configured.executable,
      configured.browserPath,
      configured.linux.bubblewrapPath,
      configured.linux.initExecutable,
    ];
    const resolved = paths.map(executable);
    runtimeAssets = resolved.filter((path): path is string => path !== null);
    if (runtimeAssets.length !== paths.length) unavailableReason = 'browser_runtime_unavailable';
    else
      transport = {
        ...configured,
        // Dispatch the captured canonical files, not a mutable host-path alias.
        executable: resolved[0]!,
        browserPath: resolved[1]!,
        linux: { bubblewrapPath: resolved[2]!, initExecutable: resolved[3]! },
        runtimeDirectory: configured.runtimeDirectory ?? options.privateDirectory,
      };
  } else if (process.platform !== 'linux')
    unavailableReason = nativeBrowserUnavailableReason() ?? 'browser_native_platform_unavailable';
  else {
    try {
      const native = agentBrowserExecutableAsset();
      runtimeAssets = agentBrowserRuntimeAssets();
      const browserPath = installedBrowser();
      if (!browserPath) unavailableReason = 'browser_executable_unavailable';
      else {
        const bubblewrapPath = ['/usr/bin/bwrap', '/bin/bwrap']
          .map(executable)
          .find((path) => path !== null);
        if (!bubblewrapPath) unavailableReason = 'browser_process_boundary_unavailable';
        else {
          let initExecutable: string | undefined;
          try {
            initExecutable = linuxShellInitAsset();
          } catch {
            unavailableReason = 'browser_process_boundary_unavailable';
          }
          if (initExecutable)
            transport = {
              executable: native,
              browserPath,
              linux: { bubblewrapPath, initExecutable },
              runtimeDirectory: options.privateDirectory,
            };
          runtimeAssets = [
            ...runtimeAssets,
            browserPath,
            bubblewrapPath,
            ...(initExecutable ? [initExecutable] : []),
          ];
        }
      }
    } catch {
      unavailableReason = 'browser_runtime_unavailable';
    }
  }
  const privateDirectory = transport?.runtimeDirectory ?? options.privateDirectory;
  if (!isAbsolute(privateDirectory) || privateDirectory.includes('\0')) {
    unavailableReason = 'browser_private_directory_unavailable';
    transport = undefined;
  }
  // The same passive guard is repeated at actual native dispatch. It never launches a probe.
  if (!unavailableReason) unavailableReason = nativeBrowserUnavailableReason();
  const available = transport !== undefined && unavailableReason === undefined;
  const controller =
    transport && !unavailableReason
      ? createAgentBrowserController(transport)
      : createUnavailableBrowserController(unavailableReason ?? 'browser_runtime_unavailable');
  const extension = createBrowserExtension({ controller });
  const capabilities: CapabilityDescription[] = [
    ...(extension.tools ?? []).map((tool) => ({
      kind: 'tool' as const,
      definitionId: tool.id,
      definitionVersion: tool.version,
      revision: `${extension.id}:${extension.version}:${tool.version}`,
      hardAllowed: enabled && available,
      ...(unavailableReason ? { denialReason: unavailableReason } : {}),
      ...builtinCapability(extension.id, tool.id, 'tool', '', tool.version),
    })),
    ...(extension.jobs ?? []).map((job) => ({
      kind: 'job' as const,
      definitionId: job.id,
      definitionVersion: job.version,
      revision: `${extension.id}:${extension.version}:${job.version}`,
      hardAllowed: enabled && available,
      ...(unavailableReason ? { denialReason: unavailableReason } : {}),
      ...builtinCapability(extension.id, job.id, 'job', '', job.version),
    })),
    ...(extension.actions ?? []).map((action) => ({
      kind: 'job' as const,
      definitionId: `${extension.id}/${action.id}`,
      definitionVersion: action.version,
      revision: `${extension.id}:${extension.version}:${action.version}`,
      hardAllowed: enabled && available,
      ...(unavailableReason ? { denialReason: unavailableReason } : {}),
      ...builtinCapability(extension.id, action.id, 'action', '', action.version),
    })),
  ];
  return {
    extension,
    available,
    capabilities,
    toolIds: browserToolIds,
    runtimeAssets: [...new Set(runtimeAssets)],
    // Protect the entire private base, including future ephemeral profiles and sockets.
    privateDirectory:
      isAbsolute(privateDirectory) && !privateDirectory.includes('\0')
        ? privateDirectory
        : options.privateDirectory,
    snapshot: {
      definition: { id: extension.id, version: extension.version },
      enabled,
      available,
      runtime: 'agent-browser-0.39.4',
      ownership: 'browser.session-job',
      configurationDigest: createHash('sha256')
        .update(JSON.stringify(transport ?? null))
        .digest('hex'),
      ...(unavailableReason ? { unavailableReason } : {}),
    },
  };
}
