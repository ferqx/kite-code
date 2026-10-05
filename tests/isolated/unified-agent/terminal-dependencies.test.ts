import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { copyTerminalDependencies } from '../../../scripts/release/terminal-dependencies';

function pkg(
  path: string,
  manifest: Record<string, unknown>,
  code = 'module.exports=require("./package.json").version;',
) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ ...manifest, main: 'index.js' }));
  writeFileSync(join(path, 'index.js'), code);
  writeFileSync(join(path, 'LICENSE'), 'fixture license');
  return path;
}
function link(from: string, name: string, to: string) {
  const path = join(from, 'node_modules', name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(to, path);
}
function validateTree(path: string, root: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isSymbolicLink()) expect(realpathSync(target).startsWith(`${root}/`)).toBe(true);
    else if (entry.isDirectory()) validateTree(target, root);
  }
}
test('finite installed graph preserves multiversion, peer contexts, aliases, cycles, optional platform native files and bins without source links', async () => {
  const root = mkdtempSync('/private/tmp/kite-terminal-deps-');
  try {
    const repository = join(root, 'repository');
    mkdirSync(join(repository, 'node_modules'), { recursive: true });
    const workspace = pkg(join(repository, 'workspace'), {
      name: '@kite-ai/fixture',
      version: '1',
      dependencies: { left: '1', right: '1', platform: '1', 'node:fs': '*', alias: 'npm:shared@1' },
      peerDependencies: { peer: '1' },
      devDependencies: { 'must-not-copy': '1' },
    });
    const pool = join(repository, 'node_modules/.installed');
    const one = pkg(join(pool, 'one'), { name: 'shared', version: '1' }),
      two = pkg(join(pool, 'two'), { name: 'shared', version: '2' }),
      peer = pkg(join(pool, 'peer'), { name: 'peer', version: '1' }),
      peerTwo = pkg(join(pool, 'peer-two'), { name: 'peer', version: '2' });
    const left = pkg(
      join(pool, 'left'),
      {
        name: 'left',
        version: '1',
        dependencies: { shared: '1', right: '1' },
        peerDependencies: { peer: '1' },
      },
      'module.exports={shared:require("shared"),peer:require("peer"),right:require.resolve("right")};',
    );
    const right = pkg(
      join(pool, 'right'),
      {
        name: 'right',
        version: '1',
        dependencies: { shared: '2' },
        peerDependencies: { peer: '1' },
      },
      'module.exports={shared:require("shared"),peer:require("peer")};',
    );
    const native = pkg(join(pool, 'native'), {
      name: 'native',
      version: '1',
      os: [process.platform],
      cpu: [process.arch],
      bin: { 'native-check': 'tool.js' },
    });
    writeFileSync(join(native, 'native.node'), Buffer.from([0, 1, 255, 42]));
    writeFileSync(join(native, 'tool.js'), '#!/usr/bin/env bun\nconsole.log("native-bin");', {
      mode: 0o755,
    });
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
    for (const [name, path] of [
      ['left', left],
      ['right', right],
      ['peer', peer],
      ['platform', platform],
    ] as const)
      link(workspace, name, path);
    link(workspace, 'alias', one);
    link(left, 'shared', one);
    link(left, 'right', right);
    link(left, 'peer', peer);
    link(right, 'shared', two);
    link(right, 'peer', peerTwo);
    link(platform, 'native', native);
    link(platform, 'foreign', foreign);
    const cycleA = pkg(join(pool, 'cycle-a'), {
        name: 'cycle-a',
        version: '1',
        dependencies: { 'cycle-b': '1' },
      }),
      cycleB = pkg(join(pool, 'cycle-b'), {
        name: 'cycle-b',
        version: '1',
        dependencies: { 'cycle-a': '1' },
      });
    link(cycleA, 'cycle-b', cycleB);
    link(cycleB, 'cycle-a', cycleA);
    const manifest = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
    manifest.dependencies['cycle-a'] = '1';
    writeFileSync(join(workspace, 'package.json'), JSON.stringify(manifest));
    link(workspace, 'cycle-a', cycleA);
    symlinkSync(join(native, 'tool.js'), join(native, 'internal-link.js'));
    const destination = join(root, 'bundle/node_modules'),
      built = pkg(join(destination, '@kite-ai/fixture'), manifest);
    const report = copyTerminalDependencies({
      repositoryRoot: repository,
      destination,
      workspacePackages: [{ name: '@kite-ai/fixture', source: workspace, destination: built }],
    });
    expect(report.packages).toHaveLength(10);
    expect(realpathSync(join(built, 'node_modules/alias'))).toBe(
      realpathSync(
        join(
          destination,
          report.packages.find((p) => p.name === 'shared' && p.version === '1')!.destination,
        ),
      ),
    );
    expect(
      report.packages
        .filter((p) => p.name === 'shared')
        .map((p) => p.version)
        .sort(),
    ).toEqual(['1', '2']);
    expect(
      report.packages.some((p) =>
        ['foreign', 'absent', 'must-not-copy', 'optional-peer'].includes(p.name),
      ),
    ).toBe(false);
    validateTree(destination, destination);
    const nativeCopy = join(
      destination,
      report.packages.find((p) => p.name === 'native')!.destination,
    );
    expect(readFileSync(join(nativeCopy, 'native.node'))).toEqual(Buffer.from([0, 1, 255, 42]));
    expect(readFileSync(join(nativeCopy, 'LICENSE'), 'utf8')).toBe('fixture license');
    expect(lstatSync(join(nativeCopy, 'internal-link.js')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(nativeCopy, 'tool.js')).mode & 0o111).not.toBe(0);
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        'const m=require("@kite-ai/fixture");console.log(JSON.stringify({left:require(require.resolve("left",{paths:[require.resolve("@kite-ai/fixture")]})),right:require(require.resolve("right",{paths:[require.resolve("@kite-ai/fixture")]}))}));',
      ],
      { cwd: join(root, 'bundle'), env: { PATH: '' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      left: { shared: '1', peer: '1' },
      right: { shared: '2', peer: '2' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real locked terminal workspace graph copies actual native assets and resolves production npm outside the repository', async () => {
  const root = mkdtempSync('/private/tmp/kite-terminal-real-deps-');
  try {
    const repositoryRoot = resolve(import.meta.dir, '../../..');
    const destination = join(root, 'node_modules');
    const locations = [
      'packages/agent',
      'packages/ai',
      'packages/client',
      'packages/ui',
      'apps/service',
      'apps/cli',
    ];
    const workspacePackages = locations.map((location) => {
      const source = join(repositoryRoot, location);
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
      const target = pkg(join(destination, manifest.name), {
        name: manifest.name,
        version: manifest.version,
      });
      return { name: manifest.name as string, source, destination: target };
    });
    const report = copyTerminalDependencies({ repositoryRoot, destination, workspacePackages });
    const native = report.packages.filter((p) => p.name.startsWith('@napi-rs/keyring-'));
    expect(native.length).toBeGreaterThan(0);
    for (const asset of native) {
      const target = join(destination, asset.destination);
      const binary = readdirSync(target).find((name) => name.endsWith('.node'));
      expect(binary).toBeDefined();
      expect(readFileSync(join(target, binary!))).toEqual(
        readFileSync(join(asset.source, binary!)),
      );
    }
    expect(report.packages.some((p) => p.name === 'typescript')).toBe(false);
    expect(report.packages.some((p) => p.name === 'ink')).toBe(true);
    expect(report.packages.some((p) => p.name === 'react')).toBe(true);
    expect(report.packages.some((p) => p.name === 'punycode')).toBe(true);
    expect(report.packages.find((p) => p.name === 'zod' && p.version === '4.3.6')).toBeDefined();
    validateTree(destination, destination);
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const {createRequire}=require('node:module'); const req=createRequire(${JSON.stringify(join(destination, '@kite-ai/service/package.json'))}); const agent=createRequire(${JSON.stringify(join(destination, '@kite-ai/agent/package.json'))}); const {JSDOM}=agent('jsdom'); const dom=new JSDOM('<p>actual parser npm closure</p>',{url:'https://éxample.test/'}); console.log(JSON.stringify({value:req('zod').z.string().parse('production-npm'),body:dom.window.document.body.textContent,url:dom.window.location.href})); dom.window.close();`,
      ],
      { cwd: root, env: { PATH: '' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe('');
    expect(JSON.parse(output)).toEqual({
      value: 'production-npm',
      body: 'actual parser npm closure',
      url: 'https://xn--xample-9ua.test/',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('missing required, unknown workspace, external package and escaping asset are rejected without installing', () => {
  const root = mkdtempSync('/private/tmp/kite-terminal-reject-deps-');
  try {
    const repositoryRoot = join(root, 'repo');
    mkdirSync(join(repositoryRoot, 'node_modules'), { recursive: true });
    const workspace = pkg(join(repositoryRoot, 'workspace'), {
      name: '@kite-ai/fixture',
      version: '1',
    });
    let attempt = 0;
    const run = (
      dependencies: Record<string, string>,
      optionalDependencies?: Record<string, string>,
    ) => {
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify({
          name: '@kite-ai/fixture',
          version: '1',
          dependencies,
          optionalDependencies,
        }),
      );
      const destination = join(root, `bundle-${attempt++}/node_modules`);
      const built = pkg(join(destination, '@kite-ai/fixture'), {
        name: '@kite-ai/fixture',
        version: '1',
      });
      return copyTerminalDependencies({
        repositoryRoot,
        destination,
        workspacePackages: [{ name: '@kite-ai/fixture', source: workspace, destination: built }],
      });
    };
    expect(() => run({ 'missing-required': '1' })).toThrow('terminal_dependency_missing');
    expect(() => run({ fs: '*' })).toThrow('terminal_dependency_missing');
    expect(() => run({}, { '@kite-ai/unknown': 'workspace:*' })).toThrow(
      'terminal_dependency_workspace_unknown',
    );
    const external = pkg(join(root, 'external'), { name: 'external', version: '1' });
    link(workspace, 'external', external);
    expect(() => run({ external: '1' })).toThrow('terminal_dependency_source_escape');
    const asset = pkg(join(repositoryRoot, 'node_modules/asset'), { name: 'asset', version: '1' });
    link(workspace, 'asset', asset);
    symlinkSync(join(external, 'LICENSE'), join(asset, 'escape'));
    expect(() => run({ asset: '1' })).toThrow('terminal_dependency_asset_escape');
    rmSync(join(asset, 'escape'));
    symlinkSync(asset, join(asset, 'cycle'));
    expect(() => run({ asset: '1' })).toThrow('terminal_dependency_asset_cycle');
    const foreign = pkg(join(repositoryRoot, 'node_modules/foreign'), {
      name: 'foreign',
      version: '1',
      os: [process.platform === 'win32' ? 'linux' : 'win32'],
    });
    link(workspace, 'foreign', foreign);
    expect(() => run({ foreign: '1' })).toThrow('terminal_dependency_platform_mismatch');
    expect(run({}, { foreign: '1', missing: '1' }).packages).toHaveLength(0);
    expect(existsSync(join(repositoryRoot, 'node_modules/missing'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
