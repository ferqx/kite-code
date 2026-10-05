import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../../..');
type Manifest = {
  name: string;
  version: string;
  exports: Record<string, string>;
  scripts: { build: string };
  dependencies?: Record<string, string>;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function child(command: string[], cwd: string, deadlineMs = 20000) {
  const process = Bun.spawn(command, {
    cwd,
    env: { PATH: globalThis.process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => process.kill('SIGKILL'), deadlineMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (code !== 0)
      throw Error(`external_fixture_failed:${code}\n${stderr}\n${stdout.slice(-4000)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (process.exitCode === null) {
      process.kill('SIGKILL');
      await process.exited;
    }
  }
}
async function build(source: string, destination: string) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as Manifest;
  mkdirSync(destination, { recursive: true });
  for (const segment of manifest.scripts.build.split(/\s*&&\s*/)) {
    const words = segment.trim().split(/\s+/);
    if (words.shift() !== 'bun') throw Error('unsupported_real_manifest');
    const args = words.map((word) =>
      word === 'dist' || word === './dist'
        ? destination
        : word
            .replace(/^--outdir=(?:\.\/)?dist(?=\/|$)/, `--outdir=${destination}`)
            .replace(/^dist\/node$/, `${destination}/node`),
    );
    const index = args.indexOf('--outdir');
    if (index >= 0) args[index + 1] = args[index + 1]!.replace(/^\.\/dist(?=\/|$)/, destination);
    await child([process.execPath, ...args], source);
  }
  const exports = Object.fromEntries(
    Object.entries(manifest.exports).map(([name, path]) => [
      name,
      path.replace(/^\.\/src\//, './').replace(/\.tsx?$/, '.js'),
    ]),
  );
  writeFileSync(
    join(destination, 'package.json'),
    JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
  );
  for (const value of Object.values(exports))
    expect(existsSync(join(destination, value))).toBe(true);
  return manifest;
}

test('independent label station closes real generic UI/HTTP/controlled print/record/Query/reissue through built public exports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-e14-label-'));
  const directory = join(root, 'application'),
    modules = join(directory, 'node_modules');
  const frozenPaths = [
    'packages/agent/package.json',
    'packages/agent/src/index.ts',
    'packages/agent/src/loop.ts',
    'packages/agent/src/runtime.ts',
    'packages/agent/src/extensions/index.ts',
    'packages/agent/src/storage/port.ts',
    'packages/agent/src/storage/types.ts',
    'packages/agent/src/storage/migrations/0001-baseline.sql',
    'packages/client/package.json',
    'packages/client/src/index.ts',
    'packages/ui/src/index.tsx',
    'apps/service/src/index.ts',
  ];
  const baseline = Object.fromEntries(
    frozenPaths.map((path) => [path, sha(readFileSync(join(repository, path)))]),
  );
  try {
    mkdirSync(modules, { recursive: true });
    const dependencies = new Map<string, Set<string>>();
    const addDependencies = (manifest: Manifest, source: string) => {
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        const owners = dependencies.get(dependency) ?? new Set<string>();
        owners.add(source);
        dependencies.set(dependency, owners);
      }
    };
    for (const name of ['ai', 'agent', 'client', 'ui']) {
      const source = join(repository, `packages/${name}`);
      addDependencies(await build(source, join(modules, `@kite-ai/${name}`)), source);
    }
    const service = join(repository, 'apps/service');
    addDependencies(await build(service, join(modules, '@kite-ai/service')), service);
    const extension = join(directory, 'label-station');
    const manifest = await build(
      join(repository, 'tests/fixtures/extensions/label-station'),
      extension,
    );
    addDependencies(manifest, join(repository, 'tests/fixtures/extensions/label-station'));
    for (const [dependency, owners] of dependencies) {
      if (dependency.startsWith('@kite-ai/')) continue;
      const installed = [
        ...Array.from(owners, (owner) => join(owner, 'node_modules', dependency)),
        join(repository, 'node_modules', dependency),
      ].find(existsSync);
      if (!installed) throw Error(`public_dependency_missing:${dependency}`);
      const target = join(modules, dependency);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(
        realpathSync(installed),
        target,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    cpSync(
      join(repository, 'tests/fixtures/extensions/label-station/resources'),
      join(extension, 'resources'),
      { recursive: true },
    );
    expect(existsSync(join(modules, '@kite-ai/agent/src'))).toBe(false);
    expect(existsSync(join(modules, '@kite-ai/agent/storage/worker/main.js'))).toBe(true);
    expect(existsSync(join(extension, 'src'))).toBe(false);
    const evidence = JSON.parse(
      await child(
        [
          process.execPath,
          join(extension, 'host.js'),
          root,
          join(extension, 'resources/prefix.txt'),
        ],
        directory,
      ),
    ) as {
      storeId: string;
      modelCalls: number;
      runs: number;
      deniedEffects: number;
      deniedAction: { id: string; receipt: { status: string } };
      deniedTool: { id: string; receipt: { status: string } };
      effects: { ordinal: number; sha256: string; executionId: string }[];
      records: {
        originStoreId: null;
        value: { originStoreId: string; ordinal: number; executionId: string };
      }[];
      requests: { method: string; path: string; commandId?: string }[];
      ui: { genericCard: boolean; rawUnknownContent: boolean; clicks: number };
      final: { payload: { receipt: { ordinal: number } } }[];
    };
    expect(evidence.storeId).toBeTruthy();
    expect(evidence.modelCalls).toBe(0);
    expect(evidence.runs).toBe(0);
    expect(evidence.deniedEffects).toBe(0);
    expect(evidence.deniedAction).toMatchObject({
      id: 'user-print-1',
      receipt: { status: 'failed' },
    });
    expect(evidence.deniedTool).toMatchObject({
      id: 'user-print-2',
      receipt: { status: 'failed' },
    });
    expect(evidence.ui).toEqual({ genericCard: true, rawUnknownContent: true, clicks: 4 });
    expect(evidence.effects.map((effect) => effect.ordinal)).toEqual([1, 2]);
    expect(new Set(evidence.effects.map((effect) => effect.executionId)).size).toBe(2);
    for (const effect of evidence.effects) {
      expect(effect.sha256).toBe(
        sha(
          new TextEncoder().encode(
            JSON.stringify([
              readFileSync(join(extension, 'resources/prefix.txt'), 'utf8'),
              'Parcel <script>public text</script>',
              effect.ordinal,
            ]),
          ),
        ),
      );
    }
    expect(evidence.records).toHaveLength(1);
    expect(evidence.records[0]?.originStoreId).toBeNull();
    expect(evidence.records[0]?.value.originStoreId).toBe(evidence.storeId);
    expect(evidence.records[0]?.value).toMatchObject({
      ordinal: 2,
      executionId: evidence.effects[1]?.executionId,
    });
    expect(evidence.final[0]?.payload.receipt.ordinal).toBe(2);
    expect(
      evidence.requests
        .filter(
          (request) => request.method === 'POST' && request.path === '/v1/sessions/s/commands',
        )
        .map((request) => request.commandId),
    ).toEqual(['user-print-1', 'user-print-2', 'user-print-3', 'user-print-4']);
    expect(
      evidence.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.path.includes('/extensions/fixture.label-station/queries/slip'),
      ),
    ).toBe(true);
    expect(
      Object.fromEntries(
        frozenPaths.map((path) => [path, sha(readFileSync(join(repository, path)))]),
      ),
    ).toEqual(baseline);
    console.log(
      JSON.stringify({
        qualification: 'E01/E02/E03/E14 label-station bounded sample',
        ...evidence,
        publicCoreHashes: baseline,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
