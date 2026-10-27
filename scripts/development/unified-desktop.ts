import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { releaseErrorCode } from '../release/release-arguments';
import { selectDevelopmentServiceArtifact } from './unified-cli';
import { initializeDesktopBuildEnvironment } from './windows-desktop-environment';
import { ensureWindowsElectronPermissions } from './windows-electron-permissions';

const repositoryRoot = resolve(import.meta.dir, '../..');
const help = `Kite desktop development
  npm run desktop:dev
  npm run desktop:dev -- --help
Uses local Service sources, built workspace assets, and installed Electron.
UI changes use Vite HMR; Service source changes rebuild and restart the paired Service.
Development data stays in ~/.kite-code/development.
`;

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
    ) => Bun.Subprocess<'pipe', 'pipe', 'inherit'>;
  } = {},
): Promise<number> {
  const argv = input.argv ?? process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(help);
    return 0;
  }
  if (argv.length) throw Error('desktop_development_arguments_invalid');
  const root = input.root ?? repositoryRoot;
  const artifact = selectDevelopmentServiceArtifact(root, input.executable);
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
  let child: Bun.Subprocess<'pipe', 'pipe', 'inherit'> | undefined;
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
    const service = await buildDevelopmentService(root, outdir);
    if (watchError) throw watchError;
    let sourceSha256 = service.sourceSha256;
    await buildNativeDesktop(
      {
        kind: 'development',
        serviceEntrypoint: join(outdir, 'services', service.id, 'main.js'),
        serviceSha256: service.sha256,
        bunExecutable: artifact.executable,
        bunSha256: artifact.executableSha256,
        buildId: `development-${service.sha256}`,
        apiMajor: artifact.apiMajor,
        requiredCapabilities: ['file_recovery'],
        profile: {
          dataRoot: join(homedir(), '.kite-code'),
          profile: 'development',
        },
      },
      outdir,
      { development: { ...renderer.configuration, control: control.configuration } },
    );
    if (watchError) throw watchError;
    if (requested) return requested === 'SIGINT' ? 130 : 143;
    const env = { ...process.env };
    for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
      delete env[name];
    child =
      input.spawnElectron?.(electron, outdir, env) ??
      Bun.spawn([electron, outdir], {
        cwd: root,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
      });
    channel = await control.attach(child.exited);
    if (watchError) throw watchError;
    reloadQueue = createDesktopReloadQueue({
      async reload() {
        const fresh = await buildDevelopmentService(root, outdir);
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
      process.stderr.write('Build the local workspaces first: npm run build\n');
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
        'Install Visual Studio C++ Build Tools (x64/x86) and a Windows SDK, then run npm run desktop:dev again.\n',
      );
    if (code === 'windows_desktop_build_environment_failed')
      process.stderr.write('Visual Studio x64 build environment initialization failed.\n');
    if (code === 'windows_desktop_compiler_override_invalid')
      process.stderr.write('KITE_WINDOWS_MSVC must point to an existing absolute compiler path.\n');
    process.exitCode = 1;
  }
}
