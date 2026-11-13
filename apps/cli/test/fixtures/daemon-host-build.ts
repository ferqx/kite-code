import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as testBuild } from '../../../../scripts/tooling/build';
import { spawn as testSpawn } from '../../../../scripts/tooling/process';
import { hostBuildEnvironment } from '../../../../tests/fixtures/build-tool-environment';

const repository = resolve(import.meta.dirname, '../../../..');
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
  const child = testSpawn([process.execPath, ...args], {
    cwd,
    env: hostBuildEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const [code, stdout, stderr] = await deadline(
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      120000,
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
  for (const directory of [
    'packages/trajectory',
    'packages/trace-extension-sdk',
    'packages/agent',
    'packages/ai',
    'packages/client',
    'apps/service',
  ]) {
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
      if (
        words.shift() !== 'node' ||
        words[0] !== '--import' ||
        words[1] !== '../../scripts/tooling/register.mjs'
      )
        throw Error('daemon_fixture_manifest_unknown');
      const args = words.map((word) =>
        word === 'dist' || word === './dist'
          ? destination
          : word.replace(/^--outdir=(?:\.\/)?dist$/, `--outdir=${destination}`),
      );
      const output = args.indexOf('--outdir');
      if (output >= 0) args[output + 1] = destination;
      if (manifest.name === '@kite-ai/agent' && words[2] === 'scripts/build-node-runtime.ts') {
        cpSync(join(source, 'dist/runtime-native.node'), join(destination, 'runtime-native.node'));
      } else await runBuild(args, source);
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
    if (manifest.name === '@kite-ai/agent') {
      // The reviewed source fixture build reuses the selected checkout SQLite
      // engine. The package can start without a source loader or host SQLite.
      cpSync(join(source, 'dist/storage/engine'), join(destination, 'storage/engine'), {
        recursive: true,
      });
    }
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
    symlinkSync(realpathSync(installed), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const fixtureBuild = await testBuild({
    entrypoints: [fileURLToPath(new URL('./daemon-host-child.ts', import.meta.url))],
    target: 'node',
    packages: 'external',
    outdir: artifact,
  });
  if (!fixtureBuild.success)
    throw new AggregateError(fixtureBuild.logs, 'daemon_fixture_build_failed');
  return join(artifact, 'daemon-host-child.js');
}
