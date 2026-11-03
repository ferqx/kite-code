import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The fixed platform dependency ships the executable; never search the user's PATH or download. */
export function ripgrepAsset(): string {
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
  if (import.meta.url.endsWith('.js')) {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const root = ['jobs', 'permissions'].includes(basename(moduleDirectory))
      ? dirname(moduleDirectory)
      : moduleDirectory;
    const directory = join(root, 'platform/process/tools');
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    const executable = realpathSync.native(join(directory, name));
    if (
      manifest.platform !== process.platform ||
      manifest.arch !== process.arch ||
      createHash('sha256').update(readFileSync(executable)).digest('hex') !== manifest.rg.sha256
    )
      throw Error('ripgrep_asset_changed');
    return executable;
  }
  const require = createRequire(import.meta.url);
  const wrapper = require.resolve('@vscode/ripgrep');
  const platform = createRequire(wrapper);
  const executable = realpathSync(
    platform.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${name}`),
  );
  if (!lstatSync(executable).isFile()) throw Error('ripgrep_asset_unavailable');
  return executable;
}

/** One scoped child environment, with the bundled command ahead of ambient commands. */
export function withBundledRipgrep(environment: Readonly<Record<string, string>>) {
  const key = Object.hasOwn(environment, 'PATH')
    ? 'PATH'
    : Object.keys(environment).find((key) => key.toLowerCase() === 'path');
  const path = key === undefined ? '' : environment[key]!;
  const executable = ripgrepAsset();
  return {
    executable,
    root: dirname(executable),
    env: {
      ...Object.fromEntries(
        Object.entries(environment).filter(([name]) => name.toLowerCase() !== 'path'),
      ),
      PATH: [dirname(executable), ...(path ? [path] : [])].join(delimiter),
    },
  };
}
