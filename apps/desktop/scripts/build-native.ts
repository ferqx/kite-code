import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireArtifactAccess, retainWindowsCandidateFiles } from '@kite-ai/agent/artifact-access';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import {
  type NativeBundleManifest,
  nativeBundleEntries,
  verifyNativeRuntimeBundle,
} from '@kite-ai/service/native-runtime-assets';
import {
  readTerminalRuntimeBundleContent,
  retainWindowsTerminalRuntimeFiles,
  verifyTerminalRuntimeBundle,
} from '@kite-ai/service/runtime-assets';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build as buildRenderer } from 'vite';
import { type NativeAssets, parseNativeAssets, verifyNativeAsset } from '../electron/native-assets';
import { buildWindowsAccess } from './build-windows-access';
import { probeNativeSqliteEngine } from './sqlite-engine';
export async function buildNativeDesktop(input: NativeAssets, outdir: string) {
  const assets = parseNativeAssets(input);
  if (!isAbsolute(outdir)) throw Error('native_outdir_must_be_absolute');
  verifyNativeAsset(assets.serviceEntrypoint, assets.serviceSha256);
  verifyNativeAsset(assets.bunExecutable, assets.bunSha256);
  await buildNativeApp(assets, outdir);
}
async function buildNativeApp(assets: NativeAssets | { kind: 'candidate' }, outdir: string) {
  if (process.platform === 'win32') privateDirectory(outdir);
  else await mkdir(outdir, { recursive: true });
  const root = resolve(import.meta.dir, '..');
  const windowsAccessAsset = process.platform === 'win32' ? await buildWindowsAccess(outdir) : null;
  const helper = await Bun.build({
    entrypoints: [join(root, 'electron/profile-access-helper.ts')],
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    outdir,
    naming: 'profile-access.js',
  });
  if (!helper.success) throw new AggregateError(helper.logs, 'native_profile_helper_build_failed');
  const artifactHelper = await Bun.build({
    entrypoints: [join(root, 'electron/artifact-access-helper.ts')],
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    outdir,
    naming: 'artifact-access.js',
  });
  if (!artifactHelper.success)
    throw new AggregateError(artifactHelper.logs, 'native_artifact_helper_build_failed');
  const profileAccessAsset = {
    relativePath: 'profile-access.js',
    sha256: createHash('sha256')
      .update(await readFile(join(outdir, 'profile-access.js')))
      .digest('hex'),
  };
  for (const entry of ['main', 'preload']) {
    const result = await Bun.build({
      entrypoints: [join(root, 'electron', `${entry}.ts`)],
      target: 'node',
      format: 'cjs',
      external: ['electron'],
      outdir,
      naming: `${entry}.cjs`,
      define: {
        __KITE_DESKTOP_NATIVE_ASSETS__: JSON.stringify(assets),
        __KITE_DESKTOP_PROFILE_ACCESS__: JSON.stringify(profileAccessAsset),
        __KITE_DESKTOP_WINDOWS_ACCESS__: JSON.stringify(windowsAccessAsset),
      },
    });
    if (!result.success) throw new AggregateError(result.logs, 'native_build_failed');
  }
  // Retain the original desktop renderer pipeline and its compiled CSS/fonts.
  // The already built Main, preload and helpers share this destination.
  if (process.platform === 'win32') privateDirectory(join(outdir, 'assets'));
  await buildRenderer({
    root,
    configFile: false,
    plugins: [react(), tailwindcss()],
    base: './',
    clearScreen: false,
    logLevel: 'warn',
    build: {
      target: 'es2022',
      outDir: outdir,
      emptyOutDir: false,
      rollupOptions: {
        input: join(root, 'index.html'),
        output: { entryFileNames: 'renderer.js' },
      },
    },
  });
  await writeFile(
    join(outdir, 'package.json'),
    JSON.stringify({ name: 'kite-native', version: '0.1.0', main: 'main.cjs' }),
  );
}
export type WindowsNativeBuildResource = { verify?(): void; release(): void };
export interface WindowsNativeCandidateBuildPort {
  copyElectronExecutable(source: string, target: string): void;
  buildFrontdoors(
    root: string,
    runtime: string,
    resources: { pins: WindowsNativeBuildResource[]; locks: WindowsNativeBuildResource[] },
  ): Promise<void>;
}
// A close uncertainty retains the actual source owners and candidate scratch, including its SH.
const pendingWindowsNativeBuilds = new Set<{
  pins: WindowsNativeBuildResource[];
  locks: WindowsNativeBuildResource[];
}>();
function windowsBuildCloseUnknown(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'windows_path_security_denied' ||
      /(?:close|release|acquire).*?(?:unknown|failed)/u.test(error.message) ||
      (error instanceof AggregateError && error.errors.some(windowsBuildCloseUnknown)) ||
      windowsBuildCloseUnknown(error.cause))
  );
}
/** Formal candidate uses the existing complete terminal closure and installed Electron dist. */
export async function buildNativeCandidate(input: {
  terminalRoot: string;
  electronDist: string;
  outdir: string;
  windowsBuildPort?: WindowsNativeCandidateBuildPort;
}) {
  if (process.platform === 'win32' && !input.windowsBuildPort)
    throw Error('native_windows_build_port_required');
  if (!isAbsolute(input.outdir) || existsSync(input.outdir))
    throw Error('native_outdir_must_be_new_absolute');
  const terminal = (
      process.platform === 'win32' ? readTerminalRuntimeBundleContent : verifyTerminalRuntimeBundle
    )(input.terminalRoot),
    electron = realpathSync(input.electronDist);
  let parent = resolve(input.outdir);
  while (!existsSync(parent)) parent = dirname(parent);
  const actualDestination = join(realpathSync(parent), relative(parent, input.outdir));
  if (
    [terminal.root, electron].some(
      (source) => actualDestination === source || actualDestination.startsWith(source + sep),
    )
  )
    throw Error('native_output_inside_source');
  function copy(source: string, destination: string) {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      if (process.platform === 'win32') throw Error('native_bundle_link_invalid');
      symlinkSync(readlinkSync(source), destination);
    } else if (stat.isDirectory()) {
      if (process.platform === 'win32') privateDirectory(destination);
      else mkdirSync(destination, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(source)) copy(join(source, name), join(destination, name));
    } else if (stat.isFile()) {
      if (process.platform === 'win32') {
        if (source.startsWith(electron + sep) && /\.(?:exe|dll)$/iu.test(source))
          input.windowsBuildPort!.copyElectronExecutable(source, destination);
        else defaultWindowsPathSecurity()!.copyPrivateFile(source, destination);
      } else {
        copyFileSync(source, destination);
        chmodSync(destination, stat.mode & 0o111 ? 0o755 : 0o644);
      }
    } else throw Error('native_copy_unsupported');
  }
  const resources = {
    pins: [] as WindowsNativeBuildResource[],
    locks: [] as WindowsNativeBuildResource[],
  };
  let failed = false;
  let failure: unknown;
  let succeeded: ReturnType<typeof verifyNativeRuntimeBundle> | undefined;
  let unsafe = false;
  try {
    if (process.platform === 'win32') {
      pendingWindowsNativeBuilds.add(resources);
      resources.locks.push(acquireArtifactAccess({ root: terminal.root, mode: 'shared' }));
      resources.pins.push(retainWindowsTerminalRuntimeFiles(terminal.root));
      if (verifyTerminalRuntimeBundle(terminal.root).digest !== terminal.digest)
        throw Error('native_terminal_source_changed');
      const electronFiles: string[] = [],
        emptyElectronDirectories: string[] = [];
      const collect = (directory: string) => {
        const names = readdirSync(directory);
        if (!names.length) emptyElectronDirectories.push(directory);
        for (const name of names) {
          const path = join(directory, name),
            stat = lstatSync(path);
          if (stat.isSymbolicLink()) throw Error('native_bundle_link_invalid');
          if (stat.isDirectory()) collect(path);
          else if (stat.isFile()) electronFiles.push(relative(electron, path).split(sep).join('/'));
          else throw Error('native_copy_unsupported');
        }
      };
      collect(electron);
      resources.pins.push(retainWindowsCandidateFiles(electron, electronFiles));
      for (const directory of emptyElectronDirectories)
        resources.pins.push(retainWindowsCandidateFiles(directory, []));
      privateDirectory(input.outdir);
    } else mkdirSync(input.outdir, { mode: 0o700 });
    const root = realpathSync(input.outdir);
    copy(terminal.root, join(root, 'terminal'));
    copy(electron, join(root, 'electron'));
    const electronVersion = readFileSync(join(electron, 'version'), 'utf8').trim();
    const entries = nativeBundleEntries(process.platform);
    const sqlite = await probeNativeSqliteEngine({
      executable: join(root, entries.electron),
      root,
      electronVersion,
    });
    if (verifyTerminalRuntimeBundle(join(root, 'terminal')).digest !== terminal.digest)
      throw Error('native_terminal_copy_mismatch');
    await buildNativeApp({ kind: 'candidate' }, join(root, 'app'));
    if (process.platform === 'win32') {
      await input.windowsBuildPort!.buildFrontdoors(
        root,
        join(terminal.root, terminal.manifest.entries.runtime),
        resources,
      );
      defaultWindowsPathSecurity()!.writePrivateFile(
        join(root, '.use-terminal.lock'),
        new Uint8Array(),
      );
    } else writeFileSync(join(root, '.use-terminal.lock'), '', { mode: 0o600, flag: 'wx' });
    const files: NativeBundleManifest['files'][number][] = [],
      links: NativeBundleManifest['links'][number][] = [],
      directories: string[] = [];
    function walk(directory: string) {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name),
          item = relative(root, path).split(sep).join('/');
        if (item === 'terminal') continue;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
          if (process.platform === 'win32') throw Error('native_bundle_link_invalid');
          links.push({ path: item, target: readlinkSync(path) });
        } else if (stat.isDirectory()) {
          if (readdirSync(path).length === 0 && item.startsWith('electron/'))
            directories.push(item);
          else walk(path);
        } else if (stat.isFile()) {
          const mode =
            item === '.use-terminal.lock'
              ? 384
              : (
                    process.platform === 'win32'
                      ? item.toLowerCase().endsWith('.exe')
                      : stat.mode & 0o111
                  )
                ? 493
                : 420;
          if (process.platform === 'win32') defaultWindowsPathSecurity()!.verifyFile(path);
          else chmodSync(path, mode);
          const bytes = readFileSync(path);
          files.push({
            path: item,
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            mode,
          });
        } else throw Error('native_copy_unsupported');
      }
    }
    walk(root);
    const manifest: NativeBundleManifest = {
      version: 1,
      apiMajor: 1,
      target: { platform: process.platform, arch: process.arch },
      electronVersion,
      sqlite,
      terminalRoot: 'terminal',
      terminalManifestSha256: terminal.digest,
      entries,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      links: links.sort((a, b) => a.path.localeCompare(b.path)),
      directories: directories.sort(),
    };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    if (process.platform === 'win32')
      defaultWindowsPathSecurity()!.writePrivateFile(
        join(root, 'native-manifest.json'),
        Buffer.from(manifestBytes),
      );
    else
      writeFileSync(join(root, 'native-manifest.json'), manifestBytes, { mode: 0o644, flag: 'wx' });
    for (const pin of resources.pins) pin.verify?.();
    succeeded = verifyNativeRuntimeBundle(root);
  } catch (error) {
    failed = true;
    failure = error;
    unsafe = windowsBuildCloseUnknown(error);
  }
  const cleanup: unknown[] = [];
  try {
    // A nested owner may still consume these exact sources: do not hand back its SH.
    if (unsafe) throw Error('native_windows_nested_owner_close_unknown');
    while (resources.pins.length) {
      resources.pins.at(-1)!.release();
      resources.pins.pop();
    }
    while (resources.locks.length) {
      resources.locks.at(-1)!.release();
      resources.locks.pop();
    }
    pendingWindowsNativeBuilds.delete(resources);
  } catch (error) {
    cleanup.push(error);
    unsafe = true;
  }
  if (failed || cleanup.length) {
    if (!unsafe) rmSync(input.outdir, { recursive: true, force: true });
    if (cleanup.length)
      throw new AggregateError(
        [...(failed ? [failure] : []), ...cleanup],
        'native_windows_build_close_unknown',
      );
    throw failure;
  }
  return succeeded!;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== '--assets' ||
    args[2] !== '--outdir' ||
    !isAbsolute(args[1]!) ||
    !isAbsolute(args[3]!)
  )
    throw Error('usage_build_native_assets_absolute_outdir_absolute');
  await buildNativeDesktop(JSON.parse(await readFile(args[1]!, 'utf8')), args[3]!);
}
