import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawn as spawnProcess } from '../tooling/process';
import type { MacosTerminalSigning } from './macos-dmg/terminal-signing';
import {
  assertReleaseSource,
  parseReleaseArguments,
  releaseErrorCode,
  requiredReleaseValue,
  sourceCandidateBuildHint,
  validateReleaseSourceArguments,
} from './release-arguments';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const options = {
  build: ['directory', 'terminal', 'electron', 'desktop-only', 'node-distribution'],
  pack: ['directory', 'archive'],
  unpack: ['archive', 'sha256', 'directory'],
  verify: ['directory', 'source-commit', 'clean-source'],
  smoke: ['directory'],
  launch: ['directory'],
  install: ['archive', 'sha256', 'prefix', 'cli-prefix'],
  rollback: ['prefix'],
  uninstall: ['prefix'],
  'register-cli': ['prefix', 'cli-prefix'],
  'unregister-cli': ['prefix'],
} as const;
const help = `Native candidate tooling (native platform only)
  build [--directory <new-directory>] [--terminal <verified-terminal>] [--electron <installed-dist>]
        [--desktop-only true] [--node-distribution <pinned Node archive for desktop builds>]
  pack [--directory <candidate>] --archive <new-archive>
  unpack --archive <archive> --sha256 <SHA256> --directory <new-directory>
  verify|smoke|launch [--directory <candidate>]
  install --archive <archive> --sha256 <SHA256> --prefix <managed-directory> [--cli-prefix <independent-terminal>]
  rollback|uninstall --prefix <managed-directory>
  register-cli --prefix <desktop> --cli-prefix <terminal>
  unregister-cli --prefix <desktop>
Default output: dist/unified-native. macOS arm64 and Windows x64 build the desktop runtime by default.
Use --terminal to embed a complete Terminal. Other targets retain dist/unified-terminal as the default input.
The default Electron input is the installed Electron dist.
Archive compression: .tar.zst for Zstandard or .tar.gz for gzip. For the macOS Node installer, use .zip.
Verify additionally accepts --source-commit <40-hex-commit> and --clean-source true.
Checksums establish integrity, not publisher authenticity. Installation preserves profile data.
`;

export async function runNativeRelease(
  argv: readonly string[],
  root = repositoryRoot,
  buildOptions: {
    macosSignElectron?: (app: string) => void;
    macosTerminalSigning?: MacosTerminalSigning;
  } = {},
): Promise<unknown> {
  const { command, values } = parseReleaseArguments(argv, options);
  if (command === 'help') return { help };
  validateReleaseSourceArguments(values);
  const required: Readonly<Record<string, readonly string[]>> = {
    pack: ['archive'],
    unpack: ['archive', 'sha256', 'directory'],
    install: ['archive', 'sha256', 'prefix'],
    rollback: ['prefix'],
    uninstall: ['prefix'],
    'register-cli': ['prefix', 'cli-prefix'],
    'unregister-cli': ['prefix'],
  };
  for (const key of required[command] ?? []) requiredReleaseValue(values, key);
  if (values.sha256 && !/^[a-f0-9]{64}$/.test(values.sha256))
    throw Error('release_arguments_invalid');
  const directory = resolve(values.directory ?? join(root, 'dist/unified-native'));
  const value = (key: string) => requiredReleaseValue(values, key);
  switch (command) {
    case 'build': {
      const macosArm64 = process.platform === 'darwin' && process.arch === 'arm64';
      const windowsX64 = process.platform === 'win32' && process.arch === 'x64';
      const desktopSupported = macosArm64 || windowsX64;
      const desktop = desktopSupported && values.terminal === undefined;
      if (
        (values['desktop-only'] !== undefined && (values['desktop-only'] !== 'true' || !desktop)) ||
        (values['node-distribution'] !== undefined && !desktop)
      )
        throw Error('native_desktop_release_arguments_invalid');
      const { buildNativeCandidate } = await import('../../apps/desktop/scripts/build-native');
      const electron =
        values.electron ??
        join(
          dirname(
            createRequire(join(root, 'apps/desktop/package.json')).resolve('electron/package.json'),
          ),
          'dist',
        );
      const build = async (terminalRoot: string) => {
        const bundle = await buildNativeCandidate({
          terminalRoot,
          requireTerminal: !desktop,
          electronDist: resolve(electron),
          outdir: directory,
          ...(buildOptions.macosSignElectron
            ? { macosSignElectron: buildOptions.macosSignElectron }
            : {}),
          ...(process.platform === 'win32'
            ? {
                windowsBuildPort: (await import('./windows-native-build'))
                  .windowsNativeCandidateBuildPort,
              }
            : {}),
        });
        return { root: bundle.root, candidateId: bundle.digest };
      };
      if (!desktop) return build(resolve(values.terminal ?? join(root, 'dist/unified-terminal')));
      const { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { buildTerminalBundle } = await import('./terminal-bundle');
      const outputParent = dirname(directory);
      if (macosArm64) {
        mkdirSync(outputParent, { recursive: true });
        const parent = realpathSync.native(outputParent);
        const work = mkdtempSync(join(parent, '.kite-desktop-runtime-'));
        try {
          const terminal = await buildTerminalBundle({
            destination: join(work, 'runtime'),
            repositoryRoot: root,
            desktopOnly: true,
            ...(values['node-distribution']
              ? { nodeDistribution: resolve(values['node-distribution']) }
              : {}),
            ...(buildOptions.macosTerminalSigning
              ? { macosSigning: buildOptions.macosTerminalSigning }
              : {}),
          });
          return await build(terminal.root);
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }
      const { privateDirectory, defaultWindowsPathSecurity } = await import(
        '../../packages/agent/src/platform/windows-path-security'
      );
      if (!existsSync(outputParent)) privateDirectory(outputParent);
      const parent = realpathSync.native(outputParent);
      // Build beside the requested candidate, under the same admitted directory.
      // Windows' per-user Temp can inherit grants outside this artifact scope.
      const work = join(parent, `kite-desktop-runtime-${randomUUID()}`);
      privateDirectory(work);
      const terminal = await buildTerminalBundle({
        destination: join(work, 'runtime'),
        desktopOnly: true,
        ...(values['node-distribution']
          ? { nodeDistribution: resolve(values['node-distribution']) }
          : {}),
      });
      const result = await build(terminal.root);
      const security = defaultWindowsPathSecurity()!;
      security.verifyDirectory(work);
      if (realpathSync.native(work) !== work) throw Error('native_desktop_build_scratch_unknown');
      for (const file of terminal.manifest.files)
        security.verifyPath(join(terminal.root, file.path));
      rmSync(work, { recursive: true });
      return result;
    }
    case 'verify': {
      const { verifyNativeRuntimeBundle } = await import('@kite-ai/service/native-runtime-assets');
      const bundle = verifyNativeRuntimeBundle(directory);
      assertReleaseSource(bundle.terminal.manifest.source, values);
      return { root: bundle.root, candidateId: bundle.digest, manifest: bundle.manifest };
    }
    case 'smoke': {
      const { verifyNativeRuntimeBundle } = await import('@kite-ai/service/native-runtime-assets');
      const { acquireArtifactAccess } = await import('@kite-ai/agent/artifact-access');
      const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const canonical = realpathSync(directory);
      const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
      let home: string | undefined;
      try {
        for (const selected of [canonical, join(canonical, 'terminal')])
          leases.push(acquireArtifactAccess({ root: selected, mode: 'shared' }));
        const bundle = verifyNativeRuntimeBundle(directory);
        home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-smoke-')));
        const child = spawnProcess(
          [join(bundle.root, bundle.manifest.entries.electron), '--version'],
          {
            env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
        try {
          const [code, version, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          if (
            code ||
            version.trim() !== `v${bundle.manifest.electronVersion}` ||
            stderr.length > 16384
          )
            throw Error('native_smoke_runtime_mismatch');
        } finally {
          clearTimeout(timeout);
          if (child.exitCode === null) {
            child.kill('SIGKILL');
            await child.exited;
          }
        }
        if (verifyNativeRuntimeBundle(directory).digest !== bundle.digest)
          throw Error('native_smoke_candidate_changed');
        const { probeNativeSqliteEngine } = await import(
          '../../apps/desktop/scripts/sqlite-engine'
        );
        const sqlite = await probeNativeSqliteEngine({
          executable: join(bundle.root, bundle.manifest.entries.electron),
          root: bundle.root,
          electronVersion: bundle.manifest.electronVersion,
        });
        const { assertSqliteReleaseIdentity } = await import(
          '@kite-ai/service/sqlite-release-assets'
        );
        assertSqliteReleaseIdentity(bundle.manifest.sqlite, sqlite);
        return {
          candidateId: bundle.digest,
          electronVersion: bundle.manifest.electronVersion,
          closure: true,
          electronVersionProbe: true,
          mainLifecycleQualified: false,
          sqlite,
        };
      } finally {
        if (home) rmSync(home, { recursive: true, force: true });
        for (const lease of leases.reverse()) lease.release();
      }
    }
    case 'launch': {
      if (!['darwin', 'linux'].includes(process.platform))
        throw Error('native_platform_unsupported');
      const { NativeRuntimeAssetError, verifyNativeRuntimeBundle } = await import(
        '@kite-ai/service/native-runtime-assets'
      );
      const { acquireArtifactAccess } = await import('@kite-ai/agent/artifact-access');
      const { realpathSync } = await import('node:fs');
      const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
      try {
        const canonical = realpathSync(directory);
        for (const selected of [canonical, join(canonical, 'terminal')])
          leases.push(acquireArtifactAccess({ root: selected, mode: 'shared' }));
        const bundle = verifyNativeRuntimeBundle(directory);
        const env = { ...process.env };
        for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
          delete env[key];
        const child = spawnProcess(
          [join(bundle.root, bundle.manifest.entries.electron), join(bundle.root, 'app')],
          { env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
        );
        const terminate = () => child.kill('SIGTERM');
        process.once('SIGTERM', terminate);
        process.once('SIGINT', terminate);
        try {
          return { exitCode: await child.exited };
        } finally {
          process.removeListener('SIGTERM', terminate);
          process.removeListener('SIGINT', terminate);
        }
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        )
          throw Object.assign(new NativeRuntimeAssetError('native_bundle_unavailable'), {
            cause: error,
          });
        throw error;
      } finally {
        for (const lease of leases.reverse()) lease.release();
      }
    }
    case 'pack': {
      const { packNativeBundle } = await import('./native-archive');
      return packNativeBundle({ bundleRoot: directory, archivePath: value('archive') });
    }
    case 'unpack': {
      const { unpackNativeBundle } = await import('./native-archive');
      const bundle = unpackNativeBundle({
        archivePath: value('archive'),
        sha256: value('sha256'),
        destination: resolve(value('directory')),
      });
      return { root: bundle.root, candidateId: bundle.digest };
    }
    case 'install': {
      if (process.platform === 'win32') {
        const { installWindowsNativeBundle } = await import('./windows-native-install');
        return installWindowsNativeBundle({
          archivePath: value('archive'),
          sha256: value('sha256'),
          prefix: value('prefix'),
          ...(values['cli-prefix'] ? { cliPrefix: values['cli-prefix'] } : {}),
        });
      }
      const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { unpackNativeBundle } = await import('./native-archive');
      const { installNativeBundle } = await import('./native-install');
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-install-unpack-')));
      try {
        const bundle = unpackNativeBundle({
          archivePath: value('archive'),
          sha256: value('sha256'),
          destination: join(scratch, 'candidate'),
        });
        return installNativeBundle({
          bundleRoot: bundle.root,
          prefix: value('prefix'),
          ...(values['cli-prefix'] ? { cliPrefix: values['cli-prefix'] } : {}),
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    case 'rollback':
      return (await import('./native-install')).rollbackNativeBundle(value('prefix'));
    case 'uninstall':
      (await import('./native-install')).uninstallNativeBundle(value('prefix'));
      return { removed: value('prefix') };
    case 'register-cli':
      return (await import('./cli-registration')).registerNativeCLI({
        nativePrefix: value('prefix'),
        terminalPrefix: value('cli-prefix'),
      });
    case 'unregister-cli':
      (await import('./cli-registration')).unregisterNativeCLI(value('prefix'));
      return { unregistered: value('prefix') };
    default:
      throw Error('release_arguments_invalid');
  }
}
if (import.meta.main) {
  try {
    const result = await runNativeRelease(process.argv.slice(2));
    if (result && typeof result === 'object' && 'help' in result) console.log(result.help);
    else if (
      result &&
      typeof result === 'object' &&
      'exitCode' in result &&
      typeof result.exitCode === 'number'
    )
      process.exitCode = result.exitCode;
    else console.log(JSON.stringify(result));
  } catch (error) {
    const code = releaseErrorCode(error);
    process.stderr.write(`${code}\n${sourceCandidateBuildHint(code)}`);
    process.exitCode = 1;
  }
}
