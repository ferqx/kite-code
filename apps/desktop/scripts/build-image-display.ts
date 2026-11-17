import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { terminalBundledNotices } from '../../../scripts/release/terminal-dependencies';

/** Fixed JS bundle and private native assets, with the existing desktop no-node_modules layout. */
export async function buildImageDisplay(outdir: string) {
  const root = resolve(import.meta.dir, '..');
  const repository = resolve(root, '../..');
  const target = join(outdir, 'image-display-codec');
  await mkdir(target, { recursive: true });
  // This exact generated closure belonged to the previous builder; it is reproducible
  // from the installed lockfile. Never carry it into a new native candidate.
  await rm(join(target, 'node_modules'), { recursive: true, force: true });
  const installed = realpathSync(join(repository, 'node_modules'));
  const dependency = (path: string) => {
    const canonical = realpathSync(path),
      part = relative(installed, canonical);
    if (!part || part.startsWith('..') || isAbsolute(part))
      throw Error('native_image_display_dependency_escape');
    return canonical;
  };
  const require = createRequire(join(root, 'package.json'));
  const sharp = dependency(require.resolve('sharp'));
  const fromSharp = createRequire(sharp);
  const libc =
    process.platform === 'linux' && fromSharp('detect-libc').isNonGlibcLinuxSync() ? 'musl' : '';
  const platform = `${process.platform}${libc}-${process.arch}`;
  const sharpPlatform = `sharp-${platform}`;
  const manifest = dependency(fromSharp.resolve(`@img/${sharpPlatform}/package`));
  const version = (JSON.parse(await readFile(manifest, 'utf8')) as { version: string }).version;
  const native = dependency(join(dirname(manifest), 'lib', `${sharpPlatform}-${version}.node`));
  const windows = process.platform === 'win32';
  const nativeDirectory = windows ? 'assets/sharp' : `assets/sharp/${sharpPlatform}/lib`;
  const nativeRelative = `${nativeDirectory}/${basename(native)}`;
  const copy = async (source: string, destination: string) => {
    const output = join(target, destination);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(dependency(source), output);
  };
  await copy(native, nativeRelative);
  if (windows) {
    // Same pinned DLL closure as scripts/release/desktop-runtime.ts.
    for (const library of ['libvips-42.dll', 'libvips-cpp-8.18.7.dll'])
      await copy(join(dirname(native), library), `assets/sharp/${library}`);
  } else {
    const libvipsPlatform = `sharp-libvips-${platform}`;
    const library = dependency(createRequire(manifest).resolve(`@img/${libvipsPlatform}/binary`));
    // Preserve the addon's existing relative LC_RPATH / ELF RUNPATH layout.
    await copy(library, `assets/sharp/${libvipsPlatform}/lib/${basename(library)}`);
  }
  let versionsPath: string;
  try {
    versionsPath = fromSharp.resolve(`@img/${sharpPlatform}/versions`);
  } catch {
    versionsPath = fromSharp.resolve(`@img/sharp-libvips-${platform}/versions`);
  }
  const versions = JSON.parse(await readFile(dependency(versionsPath), 'utf8'));
  const nativeLoader = dependency(join(dirname(sharp), 'sharp.cjs'));
  const utility = dependency(join(dirname(sharp), 'utility.cjs'));
  const result = await Bun.build({
    entrypoints: [join(root, 'electron/image-display-child.ts')],
    target: 'node',
    format: 'cjs',
    naming: 'child.cjs',
    outdir: target,
    plugins: [
      {
        name: 'image-display-private-sharp',
        setup(build) {
          build.onResolve({ filter: /^sharp$/ }, () => ({ path: sharp }));
          build.onLoad({ filter: /\.(?:mjs|cjs|js)$/ }, (input) => {
            const path = input.path.toLowerCase();
            if (path === nativeLoader.toLowerCase())
              return {
                // argv[1] is the fixed child entry selected by Main, not a renderer parameter.
                // Unlike __dirname, Bun cannot inline it to the source checkout.
                contents: `module.exports = require(require('node:path').join(require('node:path').dirname(process.argv[1]), ${JSON.stringify(nativeRelative)}));`,
                loader: 'js',
              };
            if (path !== utility.toLowerCase()) return;
            const source = readFileSync(input.path, 'utf8');
            const start = source.indexOf('let versions = {');
            const end = source.indexOf('versions.sharp = pkg.version;', start);
            if (start < 0 || end <= start || source.indexOf('let versions = {', start + 1) !== -1)
              throw Error('native_image_display_dependency_changed');
            // Embed installed native version metadata, rather than runtime optional npm lookups.
            return {
              contents:
                source.slice(0, start) +
                `let versions = ${JSON.stringify(versions)};\n` +
                source.slice(end),
              loader: 'js',
            };
          });
        },
      },
    ],
  });
  if (!result.success || result.outputs.length !== 1)
    throw new AggregateError(result.logs, 'native_image_display_build_failed');
  const notices = terminalBundledNotices({
    repositoryRoot: repository,
    workspaceRoot: root,
    names: ['sharp'],
  });
  await writeFile(
    join(target, 'THIRD_PARTY_BUNDLED.txt'),
    notices.packages
      .map(
        (pkg) =>
          `${pkg.name} ${pkg.version}\n${pkg.manifestText}\n${pkg.notices.map(({ name, text }) => `${name}\n${text}`).join('\n\n')}`,
      )
      .join('\n\n'),
  );
  return {
    relativePath: 'image-display-codec/child.cjs',
    sha256: createHash('sha256')
      .update(await readFile(join(target, 'child.cjs')))
      .digest('hex'),
  };
}
