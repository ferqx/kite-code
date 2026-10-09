import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { desktopBundledDependencies } from './bundled-dependencies';

const [output] = process.argv.slice(2);
if (!output?.startsWith('--outdir=') || process.argv.slice(2).length !== 1)
  throw Error('usage_build_desktop_outdir');
const outdir = resolve(output.slice('--outdir='.length));
const source = resolve(import.meta.dir, '../src/desktop');
const manifest = JSON.parse(
  await readFile(resolve(import.meta.dir, '../package.json'), 'utf8'),
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
  const root = dirname(require.resolve(`${name}/package.json`));
  const notices = (await readdir(root)).filter((file) =>
    /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.(?:md|txt))?$/i.test(file),
  );
  if (!notices.some((file) => /^(?:LICENSE|LICENCE|COPYING)(?:\.(?:md|txt))?$/i.test(file))) {
    // The locked npm publication omits LICENSE; retain the fixed upstream bytes offline.
    const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      license: string;
    };
    if (
      name !== '@hugeicons/core-free-icons' ||
      installed.name !== name ||
      installed.version !== '4.3.2' ||
      installed.license !== 'MIT'
    )
      throw Error(`desktop_bundled_dependency_license_missing:${name}`);
    const attached = join(import.meta.dir, 'licenses/core-free-icons-4.3.2');
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
const result = await Bun.build({
  entrypoints: [join(source, 'index.ts')],
  target: 'browser',
  packages: 'bundle',
  external: [
    ...Object.keys(manifest.dependencies).filter(
      (name) => !desktopBundledDependencies.includes(name),
    ),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ],
  outdir,
});
if (!result.success) throw new AggregateError(result.logs, 'desktop_ui_build_failed');
await copyFile(join(source, 'style.css'), join(outdir, 'style.css'));
for (const license of licenses) {
  await mkdir(dirname(license.destination), { recursive: true });
  await copyFile(license.source, license.destination);
}
