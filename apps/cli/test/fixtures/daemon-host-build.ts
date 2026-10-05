import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../../../..');
async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('daemon_fixture_deadline')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function runBuild(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  try {
    const [code, stdout, stderr] = await deadline(
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      20000,
    );
    if (code !== 0) throw Error(`daemon_fixture_build_failed:${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
export async function buildOwnedDaemon(artifact: string): Promise<string> {
  const modules = join(artifact, 'node_modules');
  const dependencies = new Map<string, Set<string>>();
  for (const directory of ['packages/agent', 'packages/ai', 'packages/client', 'apps/service']) {
    const source = join(repository, directory);
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      exports: Record<string, string>;
      scripts: { build: string };
      dependencies?: Record<string, string>;
    };
    const destination = join(modules, manifest.name);
    mkdirSync(destination, { recursive: true });
    for (const segment of manifest.scripts.build.split(/\s*&&\s*/)) {
      const words = segment.trim().split(/\s+/);
      if (words.shift() !== 'bun') throw Error('daemon_fixture_manifest_unknown');
      const args = words.map((word) =>
        word === 'dist' || word === './dist'
          ? destination
          : word.replace(/^--outdir=(?:\.\/)?dist$/, `--outdir=${destination}`),
      );
      const output = args.indexOf('--outdir');
      if (output >= 0) args[output + 1] = destination;
      await runBuild(args, source);
    }
    const exports = Object.fromEntries(
      Object.entries(manifest.exports).map(([key, value]) => [
        key,
        value.replace(/^\.\/src\//, './').replace(/\.ts$/, '.js'),
      ]),
    );
    writeFileSync(
      join(destination, 'package.json'),
      JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const owners = dependencies.get(dependency) ?? new Set<string>();
      owners.add(source);
      dependencies.set(dependency, owners);
    }
    if (existsSync(join(destination, 'src'))) throw Error('daemon_fixture_source_fallback');
  }
  for (const [dependency, owners] of dependencies) {
    if (dependency.startsWith('@kite-ai/')) continue;
    const installed = [
      ...Array.from(owners, (owner) => join(owner, 'node_modules', dependency)),
      join(repository, 'node_modules', dependency),
    ].find(existsSync);
    if (!installed) throw Error(`daemon_fixture_dependency_missing:${dependency}`);
    const target = join(modules, dependency);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(installed), target, 'dir');
  }
  const fixtureBuild = await Bun.build({
    entrypoints: [new URL('./daemon-host-child.ts', import.meta.url).pathname],
    target: 'bun',
    packages: 'external',
    outdir: artifact,
  });
  if (!fixtureBuild.success)
    throw new AggregateError(fixtureBuild.logs, 'daemon_fixture_build_failed');
  return join(artifact, 'daemon-host-child.js');
}
