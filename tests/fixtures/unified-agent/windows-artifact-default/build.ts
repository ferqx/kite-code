import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Manifest = {
  name: string;
  version: string;
  exports: Record<string, string>;
  scripts: { build: string };
  dependencies?: Record<string, string>;
};
const repository = resolve(import.meta.dir, '../../../..');
async function build(manifest: Manifest, source: string, destination: string) {
  for (const segment of manifest.scripts.build.split(/\s*&&\s*/)) {
    const words = segment.trim().split(/\s+/);
    if (words.shift() !== 'bun') throw Error('owned_manifest_build_invalid');
    const args = words.map((word) =>
      word === 'dist' || word === './dist'
        ? destination
        : word.replace(/^--outdir=(?:\.\/)?dist$/, `--outdir=${destination}`),
    );
    const flag = args.indexOf('--outdir');
    if (flag >= 0) args[flag + 1] = destination;
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: source,
      env: { PATH: process.env.PATH ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0) throw Error(`owned_manifest_build_failed:${exit}\n${stdout}\n${stderr}`);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  }
  const exports = Object.fromEntries(
    Object.entries(manifest.exports).map(([key, path]) => [
      key,
      path.replace(/^\.\/src\//, './').replace(/\.ts$/, '.js'),
    ]),
  );
  for (const path of Object.values(exports))
    if (!existsSync(join(destination, path))) throw Error('owned_export_missing');
  writeFileSync(
    join(destination, 'package.json'),
    JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
  );
}
/** Source-free development modules, not a sealed Terminal release candidate/engine qualification. */
export async function buildOwnedDefaultArtifactConsumer(root: string) {
  const original = join(root, 'original'),
    modules = join(original, 'node_modules');
  const dependencies = new Set<string>();
  for (const relative of ['packages/ai', 'packages/agent', 'packages/client', 'apps/service']) {
    const source = join(repository, relative),
      manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Manifest;
    const destination = join(modules, manifest.name);
    mkdirSync(destination, { recursive: true });
    await build(manifest, source, destination);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      if (!dependency.startsWith('@kite-ai/')) dependencies.add(dependency);
  }
  for (const dependency of dependencies) {
    const installed = [
      join(repository, 'node_modules', dependency),
      join(repository, 'packages/agent/node_modules', dependency),
      join(repository, 'packages/ai/node_modules', dependency),
    ].find(existsSync);
    if (!installed) throw Error(`owned_dependency_missing:${dependency}`);
    const target = join(modules, dependency);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(installed), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const compiled = await Bun.build({
    entrypoints: [join(import.meta.dir, 'consumer.ts')],
    outdir: original,
    naming: 'consumer.js',
    target: 'bun',
    packages: 'external',
  });
  if (!compiled.success) throw new AggregateError(compiled.logs, 'owned_consumer_build_failed');
  const moved = join(root, 'moved');
  renameSync(original, moved);
  return { root: moved, entry: join(moved, 'consumer.js') };
}
