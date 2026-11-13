import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '#kite-test';
import { build as buildFixture } from '../../../scripts/tooling/build';
import { spawn as spawnFixtureProcess } from '../../../scripts/tooling/process';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const register = join(repositoryRoot, 'scripts/tooling/register.mjs');

test('retained old Terminal entrypoints reject before loading legacy dependencies or touching profiles', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-retired-applications-')));
  const home = join(root, 'home');
  const profile = join(home, '.kite-code');
  mkdirSync(profile, { recursive: true });
  const sentinel = join(profile, 'original-profile');
  const bytes = new Uint8Array([0, 13, 10, 255]);
  writeFileSync(sentinel, bytes);
  const commands: { args: string[]; cwd?: string }[] = [
    { args: [join(repositoryRoot, 'apps/kite-cli/src/index.ts')] },
    { args: [join(repositoryRoot, 'apps/kite-cli/src/cli/executable.ts'), '--version'] },
    {
      args: [
        '--import',
        register,
        join(repositoryRoot, 'apps/kite-cli/src/tui/executable.tsx'),
        '--version',
      ],
    },
    ...['build', 'test'].map((script) => ({
      args: [`--run=${script}`],
      cwd: join(repositoryRoot, 'apps/kite-cli'),
    })),
  ];
  try {
    for (const { args, cwd } of commands) {
      const child = spawnFixtureProcess([process.execPath, ...args], {
        cwd: cwd ?? root,
        env: {
          ...process.env,
          PATH: dirname(process.execPath),
          HOME: home,
          USERPROFILE: home,
          APPDATA: home,
          LOCALAPPDATA: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          KITE_CODE_HOME: profile,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeout = setTimeout(() => child.kill(), 5000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        // node --run reports a failed package script as 1; direct entrypoints return 2.
        expect(code).toBe(cwd ? 1 : 2);
        expect(stdout).toBe('');
        expect(stderr).toContain('legacy_terminal_entrypoint_retired');
        expect(stderr).toContain('请在仓库根使用当前入口');
        expect(new Uint8Array(readFileSync(sentinel))).toEqual(bytes);
        expect(readdirSync(profile)).toEqual(['original-profile']);
        expect(readdirSync(home)).toEqual(['.kite-code']);
        expect(readdirSync(root)).toEqual(['home']);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('retained Terminal wrappers preserve historical function identities and synchronous APIs in source and bundles', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-retired-imports-')));
  const sourcePaths = [
    'scripts/development/retired-entrypoints.ts',
    'apps/kite-cli/src/index.ts',
    'apps/kite-cli/src/cli/executable.ts',
    'apps/kite-cli/src/tui/executable.tsx',
  ];
  const add = (path: string, content: string) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  const execute = (entry: string, args: string[] = []) => {
    const child = spawnSync(process.execPath, ['--import', register, entry, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (child.status !== 0) console.error(child.stderr);
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    return child.stdout;
  };
  try {
    for (const path of sourcePaths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(repositoryRoot, path), join(root, path));
    }
    // Harmless historical ports isolate only module loading and binding semantics.
    add(
      'apps/kite-cli/src/cli/legacy-executable.ts',
      'export async function runCli() { return 7; }',
    );
    add('apps/kite-cli/src/tui/legacy-executable.tsx', 'export function runTui() { return 11; }');
    const entry = add(
      'consumer.ts',
      `import assert from 'node:assert/strict';
      import * as root from './apps/kite-cli/src/index.ts';
      import * as cli from './apps/kite-cli/src/cli/executable.ts';
      import * as tui from './apps/kite-cli/src/tui/executable.tsx';
      import * as originalCli from './apps/kite-cli/src/cli/legacy-executable.ts';
      import * as originalTui from './apps/kite-cli/src/tui/legacy-executable.tsx';
      assert.equal(root.runCli, cli.runCli); assert.equal(cli.runCli, originalCli.runCli);
      assert.equal(root.runTui, tui.runTui); assert.equal(tui.runTui, originalTui.runTui);
      assert.equal(await root.runCli(), 7); assert.equal(root.runTui(), 11);
      console.log('historical_import_contract_verified');`,
    );
    expect(execute(entry)).toBe('historical_import_contract_verified\n');
    const outdir = join(root, 'bundle');
    const build = await buildFixture({
      entrypoints: [entry],
      target: 'node',
      outdir,
      // The retired modules are only library imports in this bundle.
      define: { 'import.meta.main': 'false' },
    });
    expect(build.success).toBe(true);
    expect(execute(join(outdir, 'consumer.js'))).toBe('historical_import_contract_verified\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
