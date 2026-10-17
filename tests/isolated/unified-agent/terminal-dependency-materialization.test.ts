import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { desktopBundledDependencies } from '../../../packages/ui/scripts/bundled-dependencies';
import { copyTerminalDependencies } from '../../../scripts/release/terminal-dependencies';

function pkg(path: string, manifest: Record<string, unknown>, code?: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ main: 'index.js', ...manifest }));
  writeFileSync(
    join(path, 'index.js'),
    code ?? 'module.exports=require("./package.json").version;',
  );
  writeFileSync(join(path, 'LICENSE'), 'original fixture license');
  return path;
}
function edge(from: string, name: string, to: string) {
  const path = join(from, 'node_modules', name);
  mkdirSync(dirname(path), { recursive: true });
  // Source installed graphs may be linked; the materialized output must not be.
  symlinkSync(to, path, process.platform === 'win32' ? 'junction' : 'dir');
}
function physicalTree(path: string) {
  for (const name of readdirSync(path)) {
    const file = join(path, name);
    const stat = lstatSync(file);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(name).not.toBe('.kite-deps');
    expect(name).not.toBe('.bin');
    if (stat.isDirectory()) physicalTree(file);
    else {
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(1);
    }
  }
}

test('physical dependency ancestry preserves exact versions, peers, aliases, cycles and package-local bins after independent relocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-terminal-materialized-'));
  const children: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = [];
  let failed = false;
  let businessError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const repositoryRoot = join(root, 'repository');
    const pool = join(repositoryRoot, 'node_modules/.installed');
    mkdirSync(pool, { recursive: true });
    const manifest = {
      name: '@kite-ai/fixture',
      version: '1',
      dependencies: {
        '@kite-ai/other': 'workspace:*',
        left: '1',
        right: '1',
        peer: '1',
        alias: 'npm:shared@1',
        'cycle-a': '1',
        platform: '1',
        'node:fs': '*',
      },
    };
    const code =
      'module.exports={left:require("left"),right:require("right"),alias:require("alias"),cycle:require("cycle-a")(),other:require("@kite-ai/other")};';
    const workspace = pkg(join(repositoryRoot, 'workspace'), manifest, code);
    const other = pkg(join(repositoryRoot, 'other'), { name: '@kite-ai/other', version: '9' });
    const one = pkg(join(pool, 'one'), { name: 'shared', version: '1' });
    const two = pkg(join(pool, 'two'), { name: 'shared', version: '2' });
    const peer = pkg(join(pool, 'peer'), { name: 'peer', version: '1' });
    const peerTwo = pkg(join(pool, 'peer-two'), { name: 'peer', version: '2' });
    const left = pkg(
      join(pool, 'left'),
      {
        name: 'left',
        version: '1',
        dependencies: { shared: '1', right: '1' },
        peerDependencies: { peer: '1' },
      },
      'module.exports={shared:require("shared"),peer:require("peer"),right:require("right")};',
    );
    const right = pkg(
      join(pool, 'right'),
      {
        name: 'right',
        version: '1',
        dependencies: { shared: '2' },
        peerDependencies: { peer: '2' },
      },
      'module.exports={shared:require("shared"),peer:require("peer")};',
    );
    const cycleA = pkg(
      join(pool, 'cycle-a'),
      { name: 'cycle-a', version: '1', dependencies: { 'cycle-b': '1' } },
      'module.exports=()=>"a:"+require("cycle-b")();',
    );
    const cycleB = pkg(
      join(pool, 'cycle-b'),
      { name: 'cycle-b', version: '1', dependencies: { 'cycle-a': '1' } },
      'module.exports=()=>"b:"+require("cycle-a/package.json").version;',
    );
    const native = pkg(join(pool, 'native'), {
      name: 'native',
      version: '1',
      os: [process.platform],
      cpu: [process.arch],
      bin: { 'native-check': 'tool.js' },
    });
    writeFileSync(join(native, 'native.node'), Buffer.from([0, 1, 255, 42]));
    writeFileSync(
      join(native, 'tool.js'),
      'if(require.main!==module)throw Error("not_original_main");console.log(JSON.stringify({version:require("./package.json").version,arg:process.argv[2]}));',
    );
    const foreign = pkg(join(pool, 'foreign'), {
      name: 'foreign',
      version: '1',
      os: [process.platform === 'win32' ? 'linux' : 'win32'],
    });
    const platform = pkg(join(pool, 'platform'), {
      name: 'platform',
      version: '1',
      optionalDependencies: { native: '1', foreign: '1', absent: '1' },
      peerDependencies: { 'optional-peer': '1' },
      peerDependenciesMeta: { 'optional-peer': { optional: true } },
    });
    for (const [name, source] of [
      ['@kite-ai/other', other],
      ['left', left],
      ['right', right],
      ['peer', peer],
      ['alias', one],
      ['cycle-a', cycleA],
      ['platform', platform],
    ] as const)
      edge(workspace, name, source);
    edge(left, 'shared', one);
    edge(left, 'right', right);
    edge(left, 'peer', peer);
    edge(right, 'shared', two);
    edge(right, 'peer', peerTwo);
    edge(cycleA, 'cycle-b', cycleB);
    edge(cycleB, 'cycle-a', cycleA);
    edge(platform, 'native', native);
    edge(platform, 'foreign', foreign);
    const bundle = join(root, 'bundle');
    const destination = join(bundle, 'node_modules');
    const built = pkg(join(destination, manifest.name), manifest, code);
    const builtOther = pkg(join(destination, '@kite-ai/other'), {
      name: '@kite-ai/other',
      version: '9',
    });
    const result = copyTerminalDependencies({
      repositoryRoot,
      destination,
      dependencyLayout: 'materialized',
      workspacePackages: [
        { name: manifest.name, source: workspace, destination: built },
        { name: '@kite-ai/other', source: other, destination: builtOther },
      ],
    });
    expect(result.links).toEqual([]);
    expect(
      result.packages.some((entry) =>
        ['foreign', 'absent', 'optional-peer', '@kite-ai/other'].includes(entry.name),
      ),
    ).toBe(false);
    expect(result.packages.filter((entry) => entry.name === 'right')).toHaveLength(1);
    expect(result.packages.filter((entry) => entry.name === 'cycle-a')).toHaveLength(1);
    expect(result.packages.filter((entry) => entry.name === 'cycle-b')).toHaveLength(1);
    expect(result.packages.filter((entry) => entry.name === 'peer')).toHaveLength(2);
    expect(result.packages.filter((entry) => entry.name === 'shared')).toHaveLength(3);
    expect(existsSync(join(built, 'node_modules/left/node_modules/right'))).toBe(false);
    physicalTree(bundle);
    const run = async (cwd: string, arguments_: string[]) => {
      const child = Bun.spawn([process.execPath, ...arguments_], {
        cwd,
        env: {
          ...process.env,
          PATH: '',
          NODE_PATH: '',
          NODE_OPTIONS: '',
          BUN_OPTIONS: '',
          ELECTRON_RUN_AS_NODE: '',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      children.push(child);
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe('');
      return JSON.parse(stdout);
    };
    const expected = {
      left: { shared: '1', peer: '1', right: { shared: '2', peer: '2' } },
      right: { shared: '2', peer: '2' },
      alias: '1',
      cycle: 'a:b:1',
      other: '9',
    };
    expect(
      await run(bundle, ['-e', 'console.log(JSON.stringify(require("@kite-ai/fixture")));']),
    ).toEqual(expected);
    rmSync(repositoryRoot, { recursive: true });
    const moved = join(root, 'relocated');
    renameSync(bundle, moved);
    physicalTree(moved);
    expect(
      await run(moved, ['-e', 'console.log(JSON.stringify(require("@kite-ai/fixture")));']),
    ).toEqual(expected);
    const bin = result.packages.find((entry) => entry.name === 'native')!;
    expect(
      await run(moved, [join(moved, 'node_modules', bin.destination, 'tool.js'), '原参数 "x"']),
    ).toEqual({ version: '1', arg: '原参数 "x"' });
  } catch (error) {
    failed = true;
    businessError = error;
  } finally {
    for (const child of children) {
      try {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!cleanupErrors.length) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(failed ? [businessError] : []), ...cleanupErrors],
      `terminal_materialization_cleanup_failed_root_retained:${root}`,
    );
  if (failed) throw businessError;
}, 20000);

test('an unrepresentable same-name version-shadowing cycle fails instead of changing resolution or making a link', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-terminal-shadow-cycle-'));
  try {
    const repositoryRoot = join(root, 'repository');
    const pool = join(repositoryRoot, 'node_modules/.installed');
    mkdirSync(pool, { recursive: true });
    const manifest = { name: '@kite-ai/fixture', version: '1', dependencies: { a: '1' } };
    const workspace = pkg(join(repositoryRoot, 'workspace'), manifest);
    const a1 = pkg(join(pool, 'a1'), { name: 'a', version: '1', dependencies: { b: '1' } });
    const b1 = pkg(join(pool, 'b1'), { name: 'b', version: '1', dependencies: { a: '2' } });
    const a2 = pkg(join(pool, 'a2'), { name: 'a', version: '2', dependencies: { b: '2' } });
    const b2 = pkg(join(pool, 'b2'), { name: 'b', version: '2', dependencies: { a: '1' } });
    edge(workspace, 'a', a1);
    edge(a1, 'b', b1);
    edge(b1, 'a', a2);
    edge(a2, 'b', b2);
    edge(b2, 'a', a1);
    const destination = join(root, 'bundle/node_modules');
    const built = pkg(join(destination, manifest.name), manifest);
    expect(() =>
      copyTerminalDependencies({
        repositoryRoot,
        destination,
        dependencyLayout: 'materialized',
        workspacePackages: [{ name: manifest.name, source: workspace, destination: built }],
      }),
    ).toThrow('terminal_dependency_materialization_cycle');
    physicalTree(join(root, 'bundle'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test(
  'the complete installed materialized graph keeps every resolution edge and original asset while sharing real common ancestors',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-terminal-actual-materialized-'));
    try {
      const repositoryRoot = realpathSync(join(import.meta.dir, '../../..'));
      const destination = join(root, 'node_modules');
      const workspacePackages = [
        'packages/ai',
        'packages/agent',
        'packages/client',
        'packages/ui',
        'apps/service',
        'apps/cli',
      ].map((location) => {
        const source = join(repositoryRoot, location);
        const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
        return {
          name: manifest.name,
          source,
          destination: pkg(join(destination, manifest.name), {
            name: manifest.name,
            version: manifest.version,
          }),
          bundledDependencies: manifest.name === '@kite-ai/ui' ? desktopBundledDependencies : [],
        };
      });
      const result = copyTerminalDependencies({
        repositoryRoot,
        destination,
        workspacePackages,
        dependencyLayout: 'materialized',
      });
      expect(result.links).toEqual([]);
      const lookup = (from: string, name: string): string | undefined => {
        for (const search of createRequire(join(from, 'package.json')).resolve.paths(
          `${name}/package.json`,
        ) ?? []) {
          const path = join(search, name, 'package.json');
          if (existsSync(path)) return realpathSync(path);
        }
        return undefined;
      };
      const supports = (values: string[] | undefined, actual: string) =>
        !values ||
        (!values.includes(`!${actual}`) &&
          (!values.some((value) => !value.startsWith('!')) ||
            values.includes(actual) ||
            values.includes('any')));
      for (const placement of [
        ...workspacePackages,
        ...result.packages.map((row) => ({
          ...row,
          destination: join(destination, row.destination),
          bundledDependencies: [] as readonly string[],
        })),
      ]) {
        const manifest = JSON.parse(readFileSync(join(placement.source, 'package.json'), 'utf8'));
        for (const name of Object.keys({
          ...manifest.dependencies,
          ...manifest.peerDependencies,
          ...manifest.optionalDependencies,
        })) {
          if (
            name.startsWith('node:') ||
            name.startsWith('bun:') ||
            placement.bundledDependencies.includes(name)
          )
            continue;
          const original = lookup(placement.source, name);
          const actual = lookup(placement.destination, name);
          if (!original) {
            expect(actual).toBeUndefined();
            continue;
          }
          const dep = JSON.parse(readFileSync(original, 'utf8'));
          if (!supports(dep.os, process.platform) || !supports(dep.cpu, process.arch)) {
            expect(actual).toBeUndefined();
            continue;
          }
          expect(actual).toBeDefined();
          if (name.startsWith('@kite-ai/')) expect(dirname(actual!)).toBe(join(destination, name));
          else expect(readFileSync(actual!)).toEqual(readFileSync(original));
        }
      }
      for (const placement of result.packages) {
        const target = join(destination, placement.destination);
        const assets = (relative: string) => {
          const source = realpathSync(join(placement.source, relative));
          if (lstatSync(source).isDirectory()) {
            for (const name of readdirSync(source))
              if (name !== 'node_modules') assets(join(relative, name));
          } else expect(readFileSync(join(target, relative))).toEqual(readFileSync(source));
        };
        assets('');
      }
      physicalTree(destination);
      expect(result.packages.some((row) => row.destination === 'zod')).toBe(true);
      expect(result.packages.some((row) => row.name === 'typescript')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  process.platform === 'win32' ? 10 * 60_000 : 60_000,
);

test('shared physical defaults do not make an absent optional peer available to another workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-terminal-absent-materialized-'));
  try {
    const repositoryRoot = join(root, 'repository'),
      destination = join(root, 'bundle/node_modules');
    const present = pkg(join(repositoryRoot, 'node_modules/.installed/present'), {
      name: 'optional',
      version: '1',
    });
    const one = pkg(join(repositoryRoot, 'one'), {
      name: '@kite-ai/one',
      version: '1',
      dependencies: { optional: '1' },
    });
    const two = pkg(join(repositoryRoot, 'two'), {
      name: '@kite-ai/two',
      version: '1',
      peerDependencies: { optional: '1' },
      peerDependenciesMeta: { optional: { optional: true } },
    });
    edge(one, 'optional', present);
    const result = copyTerminalDependencies({
      repositoryRoot,
      destination,
      dependencyLayout: 'materialized',
      workspacePackages: [
        {
          name: '@kite-ai/one',
          source: one,
          destination: pkg(join(destination, '@kite-ai/one'), {
            name: '@kite-ai/one',
            version: '1',
          }),
        },
        {
          name: '@kite-ai/two',
          source: two,
          destination: pkg(join(destination, '@kite-ai/two'), {
            name: '@kite-ai/two',
            version: '1',
          }),
        },
      ],
    });
    expect(result.packages).toHaveLength(1);
    expect(existsSync(join(destination, 'optional'))).toBe(false);
    expect(existsSync(join(destination, '@kite-ai/one/node_modules/optional/index.js'))).toBe(true);
    expect(existsSync(join(destination, '@kite-ai/two/node_modules/optional'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
