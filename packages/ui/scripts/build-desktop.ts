import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { build as bundle } from '../../../scripts/tooling/bun-build';
import { desktopBundledDependencies } from './bundled-dependencies';

const [output] = process.argv.slice(2);
if (!output?.startsWith('--outdir=') || process.argv.slice(2).length !== 1)
  throw Error('usage_build_desktop_outdir');
const outdir = resolve(output.slice('--outdir='.length));
const source = resolve(import.meta.dirname, '../src/desktop');
const manifest = JSON.parse(
  await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
) as {
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const require = createRequire(import.meta.url);
const licenses: { source: string; destination: string }[] = [];
for (const name of desktopBundledDependencies) {
  if (
    !Object.hasOwn(manifest.dependencies, name) ||
    Object.hasOwn(manifest.peerDependencies ?? {}, name) ||
    Object.hasOwn(manifest.optionalDependencies ?? {}, name)
  )
    throw Error('desktop_bundled_dependency_invalid');
  // Some dependencies expose only subpath modules. Read their installed metadata
  // from Node's package search directories without resolving a private export.
  let installed: { name: string; version: string; license: string } | undefined;
  let root: string | undefined;
  for (const directory of require.resolve.paths(name) ?? []) {
    const path = join(directory, name);
    try {
      installed = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      root = await realpath(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!root || installed?.name !== name)
    throw Error(`desktop_bundled_dependency_root_missing:${name}`);
  const notices = (await readdir(root)).filter((file) =>
    /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.(?:md|txt))?$/i.test(file),
  );
  if (!notices.some((file) => /^(?:LICENSE|LICENCE|COPYING)(?:\.(?:md|txt))?$/i.test(file))) {
    // The locked npm publication omits LICENSE; retain the fixed upstream bytes offline.
    if (
      name !== '@hugeicons/core-free-icons' ||
      installed.name !== name ||
      installed.version !== '4.3.2' ||
      installed.license !== 'MIT'
    )
      throw Error(`desktop_bundled_dependency_license_missing:${name}`);
    const attached = join(import.meta.dirname, 'licenses/core-free-icons-4.3.2');
    const provenance = JSON.parse(await readFile(join(attached, 'SOURCE.json'), 'utf8')) as {
      package: string;
      version: string;
      license: string;
      sha256: string;
    };
    const bytes = await readFile(join(attached, 'LICENSE.md'));
    if (
      provenance.package !== installed.name ||
      provenance.version !== installed.version ||
      provenance.license !== installed.license ||
      createHash('sha256').update(bytes).digest('hex') !== provenance.sha256
    )
      throw Error('desktop_bundled_dependency_license_identity_mismatch');
    for (const file of ['LICENSE.md', 'SOURCE.json'])
      licenses.push({
        source: join(attached, file),
        destination: join(outdir, 'licenses', name, file),
      });
  }
  for (const file of notices)
    licenses.push({ source: join(root, file), destination: join(outdir, 'licenses', name, file) });
}
await mkdir(outdir, { recursive: true });
const result = await bundle({
  entrypoints: [
    join(source, 'index.ts'),
    join(source, 'confirmation.ts'),
    join(source, 'markdown-parser.ts'),
  ],
  target: 'browser',
  splitting: true,
  packages: 'bundle',
  external: [
    'react-dom',
    ...Object.keys(manifest.dependencies).filter(
      (name) => !desktopBundledDependencies.includes(name),
    ),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ],
  outdir,
});
if (!result.success) throw new AggregateError(result.logs, 'desktop_ui_build_failed');
for (const name of ['style.css', 'file-diff.css'])
  await copyFile(join(source, name), join(outdir, name));
for (const license of licenses) {
  await mkdir(dirname(license.destination), { recursive: true });
  await copyFile(license.source, license.destination);
}
