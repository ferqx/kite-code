import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import {
  officeBinaryAssets,
  officeCommit,
  officeFontAsset,
  officeReleaseBase,
  officeVersion,
} from './office-assets-lock';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Build-time only. Runtime never downloads, installs or updates dependencies. */
export async function prepareOfficeAssets(destination: string) {
  const binary = officeBinaryAssets[`${process.platform}-${process.arch}`];
  if (!binary || (process.platform === 'win32' && process.arch !== 'x64'))
    throw Error('office_platform_not_qualified');
  const cache = resolve(import.meta.dir, '../../../../../.cache/office-assets');
  await mkdir(cache, { recursive: true });
  try {
    const stat = await lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('office_asset_destination_unsafe');
    await rm(destination, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(destination, { recursive: true });
  async function fixed(url: string, sha256: string, name: string) {
    const cached = join(cache, sha256);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(cached);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw Error(`office_asset_download_failed:${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 64 * 1024 * 1024 || digest(bytes) !== sha256)
        throw Error('office_asset_checksum_mismatch');
      await writeFile(cached, bytes, { mode: 0o600 });
    }
    if (digest(bytes) !== sha256) throw Error('office_asset_checksum_mismatch');
    await writeFile(join(destination, name), bytes, {
      mode: name.startsWith('officecli') ? 0o755 : 0o644,
    });
  }
  await fixed(
    officeReleaseBase + binary.name,
    binary.sha256,
    process.platform === 'win32' ? 'officecli.exe' : 'officecli',
  );
  await fixed(officeFontAsset.url, officeFontAsset.sha256, 'font.ttf');
  await copyFile(
    join(import.meta.dir, 'office-license.txt'),
    join(destination, 'OfficeCLI-LICENSE.txt'),
  );
  await copyFile(join(import.meta.dir, 'font-license.txt'), join(destination, 'Font-LICENSE.txt'));
  await copyFile(
    join(import.meta.dir, 'office-notice.txt'),
    join(destination, 'OfficeCLI-NOTICE.txt'),
  );
  await copyFile(
    join(import.meta.dir, 'office-third-party-notices.txt'),
    join(destination, 'OfficeCLI-THIRD-PARTY-NOTICES.txt'),
  );
  const katex = dirname(createRequire(import.meta.url).resolve('katex/package.json'));
  const pkg = JSON.parse(await readFile(join(katex, 'package.json'), 'utf8'));
  if (pkg.version !== '0.16.11') throw Error('office_katex_version_mismatch');
  await mkdir(join(destination, 'katex'), { recursive: true });
  for (const name of ['katex.min.js', 'katex.min.css'])
    await copyFile(join(katex, 'dist', name), join(destination, 'katex', name));
  await cp(join(katex, 'dist/fonts'), join(destination, 'katex/fonts'), { recursive: true });
  await copyFile(join(katex, 'LICENSE'), join(destination, 'KaTeX-LICENSE.txt'));
  const files: { path: string; size: number; sha256: string }[] = [];
  async function inventory(root: string, prefix = '') {
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!prefix && item.name === 'manifest.json') continue;
      const path = prefix + item.name;
      if (item.isSymbolicLink()) throw Error('office_asset_link_denied');
      if (item.isDirectory()) await inventory(join(root, item.name), `${path}/`);
      else {
        const bytes = await readFile(join(root, item.name));
        files.push({ path, size: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  await inventory(destination);
  await writeFile(
    join(destination, 'manifest.json'),
    JSON.stringify({
      officeVersion,
      officeCommit,
      target: `${process.platform}-${process.arch}`,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    }),
  );
  await chmod(
    join(destination, process.platform === 'win32' ? 'officecli.exe' : 'officecli'),
    0o755,
  );
}
