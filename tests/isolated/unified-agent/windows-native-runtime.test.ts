import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { probeNativeSqliteEngine } from '../../../apps/desktop/scripts/sqlite-engine';
import { retainWindowsCandidateFiles } from '../../../packages/agent/src/platform/windows-candidate-files';
import { defaultWindowsPathSecurity } from '../../../packages/agent/src/platform/windows-path-security';
import { copyWindowsSystemExecutable } from '../../../scripts/release/build-windows-terminal-launcher';
import { releaseDirectory, releaseScratch } from '../../fixtures/unified-agent/release-filesystem';

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'actual sealed Electron distribution resolves eager imports and its independent SQLite with a poisoned cwd and empty PATH',
  async () => {
    const source = join(
      dirname(
        createRequire(resolve(import.meta.dir, '../../../apps/desktop/package.json')).resolve(
          'electron/package.json',
        ),
      ),
      'dist',
    );
    const root = releaseScratch(join(tmpdir(), 'kite-windows-electron-imports-'));
    const input = join(root, 'input'),
      runtime = join(root, 'runtime'),
      cwd = join(root, 'cwd');
    const sourceHashes = new Map<string, string>();
    const files: string[] = [];
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    let pin: ReturnType<typeof retainWindowsCandidateFiles> | undefined;
    try {
      releaseDirectory(cwd);
      const copy = (relative: string) => {
        const from = join(source, relative),
          to = join(input, relative);
        const stat = lstatSync(from);
        expect(stat.isSymbolicLink()).toBe(false);
        if (stat.isDirectory()) {
          releaseDirectory(to);
          for (const name of readdirSync(from)) copy(join(relative, name));
        } else {
          sourceHashes.set(relative, hash(from));
          copyFileSync(from, to);
          expect(hash(to)).toBe(sourceHashes.get(relative)!);
          files.push(relative.split('\\').join('/'));
        }
      };
      copy('');
      pin = retainWindowsCandidateFiles(realpathSync(input), files);
      const seal = (relative: string) => {
        const from = join(input, relative),
          to = join(runtime, relative);
        if (lstatSync(from).isDirectory()) {
          releaseDirectory(to);
          for (const name of readdirSync(from)) seal(join(relative, name));
        } else if (/\.(exe|dll)$/i.test(relative))
          copyWindowsSystemExecutable(from, to, 'electron');
        else defaultWindowsPathSecurity()!.copyPrivateFile(from, to);
      };
      seal('');
      pin.verify();
      const binary = join(runtime, 'electron.exe');
      const bytes = readFileSync(binary),
        optional = bytes.readUInt32LE(60) + 24;
      expect(bytes.readUInt32LE(optional + 216)).toBe(0);
      expect(bytes.readUInt32LE(optional + 220)).toBe(0);
      expect(bytes.length).toBe(readFileSync(join(input, 'electron.exe')).length);
      for (const name of [
        'ffmpeg.dll',
        'dbghelp.dll',
        'USERENV.dll',
        'WINSPOOL.DRV',
        'bthprops.cpl',
      ])
        defaultWindowsPathSecurity()!.writePrivateFile(
          join(cwd, name),
          Buffer.from('INVALID_SHADOW_IMAGE'),
        );
      const version = readFileSync(join(input, 'version'), 'utf8').trim();
      const output = await new Promise<string>((done, reject) =>
        execFile(
          binary,
          ['--version'],
          {
            cwd,
            timeout: 15_000,
            windowsHide: true,
            maxBuffer: 65536,
            env: { SystemRoot: process.env.SystemRoot, PATH: '', HOME: cwd, USERPROFILE: cwd },
          },
          (error, stdout) => (error ? reject(error) : done(stdout.trim())),
        ),
      );
      expect(output).toBe(`v${version}`);
      expect(
        await probeNativeSqliteEngine({ executable: binary, root: cwd, electronVersion: version }),
      ).toMatchObject({ driver: 'node:sqlite', linkage: 'builtin' });
      pin.verify();
      for (const [relative, expected] of sourceHashes)
        expect(hash(join(source, relative))).toBe(expected);
    } finally {
      pin?.release();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
