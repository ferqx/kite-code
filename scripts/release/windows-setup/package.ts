import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { retainWindowsCandidateFiles } from '@kite-ai/agent/artifact-access';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { initializeDesktopBuildEnvironment } from '../../development/windows-desktop-environment';
import { packNativeBundle } from '../native-archive';

function preparedElectron(root: string, inputs: string): string | undefined {
  const { devDependencies } = JSON.parse(
    readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'),
  );
  const version = devDependencies?.electron;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) return undefined;
  const path = join(inputs, `electron-${version}`, 'dist');
  return lstatSync(path, { throwIfNoEntry: false }) ? path : undefined;
}

export async function buildWindowsSetup(
  root: string,
  values: Readonly<Partial<Record<'directory' | 'zstd-archive' | 'bun' | 'electron', string>>>,
) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_setup_requires_windows_x64');

  const cache = join(root, '.cache/desktop-win-x64-setup');
  const inputs = join(cache, 'inputs');
  const decoder = resolve(values['zstd-archive'] ?? join(cache, 'zstd-1.5.7.tar.gz'));
  if (!statSync(decoder, { throwIfNoEntry: false })?.isFile())
    throw Error('windows_setup_zstd_archive_unavailable');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw Error('windows_setup_powershell_unavailable');
  const powerShell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');

  const output = resolve(
    values.directory ??
      join(root, 'dist/windows-setup', new Date().toISOString().replace(/[:.]/g, '-')),
  );
  if (lstatSync(output, { throwIfNoEntry: false })) throw Error('windows_setup_destination_exists');

  const cachedBun = join(inputs, `bun-${Bun.version}`, 'bin/bun.exe');
  const bun = realpathSync.native(
    resolve(
      values.bun ??
        (lstatSync(cachedBun, { throwIfNoEntry: false }) ? cachedBun : process.execPath),
    ),
  );
  const electron = values.electron ?? preparedElectron(root, inputs);
  const bunSource = retainWindowsCandidateFiles(dirname(bun), [basename(bun)]);
  try {
    const env = { ...process.env };
    initializeDesktopBuildEnvironment({ env });
    privateDirectory(output);
    const bundle = join(output, 'native');
    const native = Bun.spawn(
      [
        bun,
        'run',
        join(root, 'scripts/release/unified.ts'),
        'build',
        '--product',
        'native',
        '--desktop-only',
        'true',
        '--directory',
        bundle,
        ...(electron ? ['--electron', resolve(electron)] : []),
      ],
      { cwd: root, env, stdout: 'inherit', stderr: 'inherit' },
    );
    if ((await native.exited) !== 0) throw Error('windows_setup_native_build_failed');
    const archive = await packNativeBundle({
      bundleRoot: bundle,
      archivePath: join(output, 'KiteDesktop.tar.zst'),
    });

    const installer = join(output, 'KiteDesktopSetup.exe');
    // Windows PowerShell needs its own modules even when the caller uses PowerShell 7.
    const setupEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
    );
    setupEnv.PSModulePath = join(dirname(powerShell), 'Modules');
    const setup = Bun.spawn(
      [
        powerShell,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(import.meta.dir, 'build.ps1'),
        '-Archive',
        archive.archivePath,
        '-Sha256',
        archive.sha256,
        '-ZstdArchive',
        decoder,
        '-OutFile',
        installer,
        '-Bun',
        bun,
      ],
      { cwd: root, env: setupEnv, stdout: 'inherit', stderr: 'inherit' },
    );
    if ((await setup.exited) !== 0) throw Error('windows_setup_build_failed');
    return { installer, checksum: `${installer}.sha256`, ...archive };
  } finally {
    bunSource.release();
  }
}
