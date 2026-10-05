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
import {
  type NativeBundleManifest,
  nativeBundleEntries,
  verifyNativeRuntimeBundle,
} from '@kite-ai/service/native-runtime-assets';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';
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
  await mkdir(outdir, { recursive: true });
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
  const result = await Bun.build({
    entrypoints: [join(root, 'src/native.tsx')],
    target: 'browser',
    format: 'esm',
    outdir,
    naming: 'renderer.js',
  });
  if (!result.success) throw new AggregateError(result.logs, 'native_renderer_build_failed');
  await writeFile(
    join(outdir, 'index.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>kite</title><div id="root"></div><script type="module" src="./renderer.js"></script></html>',
  );
  await writeFile(
    join(outdir, 'package.json'),
    JSON.stringify({ name: 'kite-native', version: '0.1.0', main: 'main.cjs' }),
  );
}
/** Formal candidate uses the existing complete terminal closure and installed Electron dist. */
export async function buildNativeCandidate(input: {
  terminalRoot: string;
  electronDist: string;
  outdir: string;
}) {
  if (!isAbsolute(input.outdir) || existsSync(input.outdir))
    throw Error('native_outdir_must_be_new_absolute');
  const terminal = verifyTerminalRuntimeBundle(input.terminalRoot),
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
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
    else if (stat.isDirectory()) {
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(source)) copy(join(source, name), join(destination, name));
    } else if (stat.isFile()) {
      copyFileSync(source, destination);
      chmodSync(destination, stat.mode & 0o111 ? 0o755 : 0o644);
    } else throw Error('native_copy_unsupported');
  }
  mkdirSync(input.outdir, { mode: 0o700 });
  try {
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
    writeFileSync(join(root, '.use-terminal.lock'), '', { mode: 0o600, flag: 'wx' });
    const files: NativeBundleManifest['files'][number][] = [],
      links: NativeBundleManifest['links'][number][] = [],
      directories: string[] = [];
    function walk(directory: string) {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name),
          item = relative(root, path).split(sep).join('/');
        if (item === 'terminal') continue;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) links.push({ path: item, target: readlinkSync(path) });
        else if (stat.isDirectory()) {
          if (readdirSync(path).length === 0 && item.startsWith('electron/'))
            directories.push(item);
          else walk(path);
        } else if (stat.isFile()) {
          const mode = item === '.use-terminal.lock' ? 384 : stat.mode & 0o111 ? 493 : 420;
          chmodSync(path, mode);
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
    writeFileSync(join(root, 'native-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o644,
      flag: 'wx',
    });
    return verifyNativeRuntimeBundle(root);
  } catch (error) {
    rmSync(input.outdir, { recursive: true, force: true });
    throw error;
  }
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
