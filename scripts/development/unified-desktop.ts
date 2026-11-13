import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { releaseErrorCode } from '../release/release-arguments';
import { type Subprocess, spawn as spawnProcess } from '../tooling/process';
import { selectDevelopmentServiceArtifact } from './unified-cli';
import { initializeDesktopBuildEnvironment } from './windows-desktop-environment';
import { ensureWindowsElectronPermissions } from './windows-electron-permissions';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const help = `Kite desktop development
  bun run desktop:dev
  bun run desktop:dev --help
Uses local Service sources, built workspace assets, and installed Electron.
UI changes use Vite HMR; Service source changes rebuild and restart the paired Service.
Development data stays in ~/.kite-code/development.
Incompatible development data can be backed up and replaced after interactive confirmation (default: No).
`;

async function confirmDevelopmentProfileBackup(backup: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error('development_profile_confirmation_required');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    const finish = (accepted: boolean) => {
      resolve(accepted);
      terminal.close();
    };
    terminal.once('close', () => finish(false));
    terminal.once('SIGINT', () => finish(false));
    terminal.question(
      `[desktop:dev] The development Store is incompatible. Old history and attachments will stay in:\n${backup}\nGlobal model configuration is kept.\nBack up the old directory and start a fresh development profile? [y/N] `,
      (answer) => finish(['y', 'yes'].includes(answer.trim().toLowerCase())),
    );
  });
}

/** Development-only recovery; never migrate old authorization facts or delete user data. */
export async function prepareDevelopmentDesktopProfile(
  dataRoot: string,
  confirmBackup: (backup: string) => Promise<boolean> = confirmDevelopmentProfileBackup,
): Promise<string | undefined> {
  const options = { dataRoot, profile: 'development' };
  const { preflightSqliteStore, sqliteStorageAssets } = await import('@kite-ai/agent/sqlite');
  try {
    await preflightSqliteStore(options);
    return undefined;
  } catch (error) {
    if (releaseErrorCode(error) !== 'store_incompatible') throw error;
  }
  // This repository-only host uses the original profile authority. Another client
  // must not be reading/writing the directory while it is moved out of service.
  const { acquireProfileAccess } = await import('../../packages/agent/src/platform/profile');
  const { preflightDatabase } = await import('../../packages/agent/src/storage/sqlite/connection');
  const access = acquireProfileAccess(options, 'exclusive');
  try {
    // A peer may have repaired/replaced the profile after the first check.
    try {
      preflightDatabase(access, sqliteStorageAssets().baseline);
      return undefined;
    } catch (error) {
      // Missing legacy columns and malformed SQLite bytes also identify an
      // incompatible Store. Access/I/O, lock and cleanup failures must stop.
      if (
        releaseErrorCode(error) !== 'store_incompatible' &&
        !(
          error instanceof Error &&
          'code' in error &&
          ['SQLITE_ERROR', 'SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(String(error.code))
        )
      )
        throw error;
    }
    const backup = join(access.dataRoot, `development-backup-${Date.now()}-${randomUUID()}`);
    if (!(await confirmBackup(backup))) throw Error('development_profile_reset_cancelled');
    try {
      if (existsSync(backup)) throw Error('development_profile_backup_exists');
      // Same-parent rename preserves the complete directory, sidecars and ACLs;
      // failure leaves the original profile in place and stops startup.
      renameSync(access.profilePath, backup);
    } catch (cause) {
      throw Error('development_profile_backup_failed', { cause });
    }
    return backup;
  } finally {
    access.lock.release();
  }
}

/** Create each application's private directory before Native verifies its permissions. */
export function createDevelopmentDesktopDirectory(root: string): string {
  const cache = join(root, '.cache');
  mkdirSync(cache, { recursive: true });
  if (process.platform !== 'win32') return mkdtempSync(join(cache, 'unified-desktop-'));
  const outdir = join(cache, `unified-desktop-${randomUUID()}`);
  privateDirectory(outdir);
  return outdir;
}

export async function runDevelopmentDesktop(
  input: {
    readonly argv?: readonly string[];
    readonly root?: string;
    readonly executable?: string;
    readonly spawnElectron?: (
      electron: string,
      outdir: string,
      env: NodeJS.ProcessEnv,
    ) => Subprocess<'pipe', 'pipe', 'inherit'>;
  } = {},
): Promise<number> {
  const argv = input.argv ?? process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(help);
    return 0;
  }
  if (argv.length) throw Error('desktop_development_arguments_invalid');
  const startedAt = performance.now();
  const reportTiming = (step: string, since: number) =>
    process.stdout.write(
      `[desktop:dev] ${step} (${((performance.now() - since) / 1000).toFixed(2)}s).\n`,
    );
  const root = input.root ?? repositoryRoot;
  const artifact = selectDevelopmentServiceArtifact(root, input.executable);
  const profile = {
    dataRoot: join(homedir(), '.kite-code'),
    profile: 'development',
  };
  const backup = await prepareDevelopmentDesktopProfile(profile.dataRoot);
  if (backup)
    process.stdout.write(
      `[desktop:dev] Incompatible development data preserved at ${backup}; starting a fresh development profile.\n`,
    );
  let electron: string, electronPackageDirectory: string;
  try {
    const require = createRequire(join(root, 'apps/desktop/package.json'));
    const installed: unknown = require('electron');
    if (typeof installed !== 'string') throw Error('development_electron_asset_unavailable');
    electron = realpathSync(installed);
    if (!lstatSync(electron).isFile()) throw Error('development_electron_asset_unavailable');
    electronPackageDirectory = dirname(realpathSync(require.resolve('electron/package.json')));
  } catch {
    throw Error('development_electron_asset_unavailable');
  }
  const permissions = ensureWindowsElectronPermissions({
    executable: electron,
    packageDirectory: electronPackageDirectory,
  });
  if (permissions.repaired)
    process.stdout.write(
      `[desktop:dev] Electron sandbox permissions repaired (${permissions.repaired} entries).\n`,
    );
  initializeDesktopBuildEnvironment();
  const { buildNativeDesktop } = await import('../../apps/desktop/scripts/build-native');
  const {
    buildDevelopmentService,
    developmentServiceSourceRoots,
    startDesktopRenderer,
    startDevelopmentServiceWatcher,
    isDevelopmentServiceSourceEvent,
    createDesktopReloadQueue,
    createDesktopReloadChannel,
    startDesktopControl,
  } = await import('./desktop-reload');
  const outdir = createDevelopmentDesktopDirectory(root);
  let child: Subprocess<'pipe', 'pipe', 'inherit'> | undefined;
  let requested: 'SIGINT' | 'SIGTERM' | undefined;
  let control: Awaited<ReturnType<typeof startDesktopControl>> | undefined;
  const watchAbort = new AbortController();
  const terminate = (signal: 'SIGINT' | 'SIGTERM') => {
    requested = signal;
    watchAbort.abort();
    control?.stop();
  };
  const interrupt = () => terminate('SIGINT');
  const stop = () => terminate('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', stop);
  let renderer: Awaited<ReturnType<typeof startDesktopRenderer>> | undefined;
  let reloadQueue: ReturnType<typeof createDesktopReloadQueue> | undefined;
  let channel: ReturnType<typeof createDesktopReloadChannel> | undefined;
  let sourceWatcher: Awaited<ReturnType<typeof startDevelopmentServiceWatcher>> | undefined;
  let watchError: Error | undefined;
  let sourceChanged = false;
  try {
    const runtimeStartedAt = performance.now();
    const macosRuntime =
      process.platform === 'darwin' && process.arch === 'arm64'
        ? (
            await import('../../apps/desktop/scripts/macos-electron-runtime')
          ).prepareMacosElectronRuntime({
            sourceDist: resolve(dirname(electron), '../../..'),
            outdir: join(outdir, 'electron'),
          })
        : null;
    if (macosRuntime) {
      electron = macosRuntime.executable;
      reportTiming('Electron runtime prepared', runtimeStartedAt);
    }
    const rendererStartedAt = performance.now();
    renderer = await startDesktopRenderer(root);
    control = await startDesktopControl();
    sourceWatcher = await startDevelopmentServiceWatcher({
      template: renderer.server.watcher,
      roots: developmentServiceSourceRoots(root),
      signal: watchAbort.signal,
      changed(event, file) {
        if (!isDevelopmentServiceSourceEvent(root, event, file)) return;
        if (reloadQueue) reloadQueue.changed();
        else sourceChanged = true;
      },
      failed(error) {
        watchError ??= error;
        control?.stop();
      },
    });
    if (requested) return requested === 'SIGINT' ? 130 : 143;
    if (watchError) throw watchError;
    reportTiming('Renderer and source watcher ready', rendererStartedAt);
    const serviceStartedAt = performance.now();
    const service = await buildDevelopmentService(root, outdir, artifact.executable);
    if (watchError) throw watchError;
    reportTiming('Service built and checked', serviceStartedAt);
    let sourceSha256 = service.sourceSha256;
    const nativeStartedAt = performance.now();
    await buildNativeDesktop(
      {
        kind: 'development',
        serviceEntrypoint: join(outdir, 'services', service.id, 'main.js'),
        serviceSha256: service.sha256,
        runtimeExecutable: artifact.executable,
        runtimeSha256: artifact.executableSha256,
        buildId: `development-${service.sha256}`,
        apiMajor: artifact.apiMajor,
        requiredCapabilities: ['file_recovery'],
        profile,
      },
      outdir,
      {
        development: { ...renderer.configuration, control: control.configuration },
        macosResize: macosRuntime?.resize ?? null,
        runtimeAddon: join(repositoryRoot, 'packages/agent/dist/runtime-native.node'),
      },
    );
    if (watchError) throw watchError;
    if (requested) return requested === 'SIGINT' ? 130 : 143;
    reportTiming('Main and preloads built', nativeStartedAt);
    const launchStartedAt = performance.now();
    const env = { ...process.env };
    for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
      delete env[name];
    child =
      input.spawnElectron?.(electron, outdir, env) ??
      spawnProcess([electron, outdir], {
        cwd: root,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
      });
    channel = await control.attach(child.exited);
    reportTiming('Electron and Service handshake ready', launchStartedAt);
    if (watchError) throw watchError;
    reloadQueue = createDesktopReloadQueue({
      async reload() {
        const fresh = await buildDevelopmentService(root, outdir, artifact.executable);
        if (fresh.sourceSha256 === sourceSha256) return;
        await channel!.reload({ id: fresh.id, sha256: fresh.sha256 });
        sourceSha256 = fresh.sourceSha256;
        process.stdout.write('[desktop:dev] Service updated; page reloaded.\n');
      },
      failed(error) {
        process.stderr.write(
          `[desktop:dev] ${releaseErrorCode(error, 'development_service_reload_failed')}\n`,
        );
        if (error instanceof Error && releaseErrorCode(error) === 'development_service_load_failed')
          process.stderr.write(`${error.message}\n`);
      },
    });
    if (sourceChanged) reloadQueue.changed();
    process.stdout.write(
      `[desktop:dev] Service ready; UI hot update: ${renderer.configuration.rendererUrl}\n`,
    );
    reportTiming('Startup completed', startedAt);
    const code = await child.exited;
    if (watchError) throw watchError;
    return requested ? (requested === 'SIGINT' ? 130 : 143) : code;
  } catch (error) {
    if (requested) return requested === 'SIGINT' ? 130 : 143;
    if (watchError) throw watchError;
    throw error;
  } finally {
    try {
      try {
        await sourceWatcher?.close();
      } finally {
        await reloadQueue?.close();
        await renderer?.close();
        await control?.close();
        await child?.exited;
        await channel?.read;
        rmSync(outdir, { recursive: true, force: true });
      }
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', stop);
    }
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runDevelopmentDesktop();
  } catch (error) {
    const code = releaseErrorCode(error, 'desktop_development_failed');
    process.stderr.write(`${code}\n`);
    if (code === 'development_service_load_failed' && error instanceof Error)
      process.stderr.write(`${error.message}\n`);
    if (code === 'development_service_asset_unavailable')
      process.stderr.write('Build the local workspaces first: bun run build\n');
    if (code === 'store_incompatible')
      process.stderr.write(
        'The development Store is incompatible and could not be prepared automatically. Its data was preserved.\n',
      );
    if (code === 'owner_busy')
      process.stderr.write('Close other clients using the development profile, then retry.\n');
    if (code === 'development_profile_confirmation_required')
      process.stderr.write(
        'Run bun run desktop:dev in an interactive terminal to confirm backing up the incompatible data and starting fresh. No data was changed.\n',
      );
    if (code === 'development_profile_reset_cancelled')
      process.stderr.write('Development profile recovery cancelled. No data was changed.\n');
    if (code === 'development_profile_backup_failed')
      process.stderr.write(
        'Could not preserve the incompatible development profile; startup stopped without resetting it.\n',
      );
    if (code === 'development_electron_runtime_scope_invalid')
      process.stderr.write(
        "Electron must use its installed package's physical dist directory without links or hard-linked files.\n",
      );
    if (
      code === 'development_electron_permissions_failed' ||
      code === 'development_electron_permissions_denied'
    )
      process.stderr.write(
        'Could not prepare Electron sandbox read/execute permissions. Check access to the installed Electron dist directory.\n',
      );
    if (
      code === 'windows_access_compiler_unavailable' ||
      code === 'windows_desktop_build_tools_unavailable'
    )
      process.stderr.write(
        'Install Visual Studio C++ Build Tools (x64/x86) and a Windows SDK, then run bun run desktop:dev again.\n',
      );
    if (code === 'windows_desktop_build_environment_failed')
      process.stderr.write('Visual Studio x64 build environment initialization failed.\n');
    if (code === 'windows_desktop_compiler_override_invalid')
      process.stderr.write('KITE_WINDOWS_MSVC must point to an existing absolute compiler path.\n');
    process.exitCode = 1;
  }
}
