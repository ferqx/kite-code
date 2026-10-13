import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../..');

test('retired Desktop commands reject before reading archives, building assets or opening the old profile', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-retired-desktop-')));
  const home = join(root, 'home');
  mkdirSync(home);
  const oldData = join(home, '.kite-code');
  mkdirSync(oldData);
  const sentinel = join(oldData, 'original-profile');
  const bytes = new Uint8Array([0, 1, 13, 10, 255]);
  writeFileSync(sentinel, bytes);
  const commands = [
    [
      join(repositoryRoot, 'scripts/release/prepare-desktop-service.ts'),
      join(root, 'absent.tar.gz'),
    ],
    [join(repositoryRoot, 'apps/kite-desktop/scripts/dev.ts')],
    [join(repositoryRoot, 'apps/kite-desktop/scripts/build-electron.ts')],
    [join(repositoryRoot, 'apps/kite-desktop/scripts/package.ts')],
    ...['dev', 'dev:web', 'build', 'build:desktop', 'prepare:service', 'build:electron'].map(
      (command) => ['run', '--cwd', join(repositoryRoot, 'apps/kite-desktop'), command],
    ),
  ];
  try {
    for (const args of commands) {
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          APPDATA: home,
          LOCALAPPDATA: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          KITE_CODE_HOME: oldData,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
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
        expect(code).toBe(2);
        expect(stdout).toBe('');
        expect(stderr).toContain('legacy_desktop_entrypoint_retired');
        expect(stderr).toContain('bun run release:build --product native');
        expect(stderr).toContain('bun run desktop');
        expect(stderr).toContain('bun run test:desktop:native');
        expect(new Uint8Array(await Bun.file(sentinel).arrayBuffer())).toEqual(bytes);
        expect(readdirSync(oldData)).toEqual(['original-profile']);
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
