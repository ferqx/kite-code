import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '../../../src/artifact-access';
import { assertLiveLock, attachLockResource } from '../../../src/platform/locks';
import { retainWindowsArtifactScope } from '../../../src/platform/windows-artifact-scope';

const windows = process.platform === 'win32';
function command(args: string[]) {
  const result = spawnSync('icacls.exe', args, { encoding: 'utf8' });
  if (result.status !== 0)
    throw Error(`owned_acl_fixture_failed:${result.status}:${result.stderr}:${result.stdout}`);
  return result.stdout;
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kite-candidate-scope-')));
  const parent = join(base, 'releases');
  mkdirSync(parent);
  const user = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  if (user.status !== 0) throw Error('owned_user_fixture_failed');
  const sid = user.stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
  if (!sid) throw Error('owned_user_fixture_invalid');
  // Ordinary public readable directories: multiple ACEs, no exact private FA policy.
  command([
    parent,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)(F)`,
    '*S-1-5-18:(OI)(CI)(F)',
    '*S-1-5-32-544:(OI)(CI)(F)',
    '*S-1-1-0:(OI)(CI)(RX)',
  ]);
  const root = join(parent, 'bundle');
  mkdirSync(root);
  writeFileSync(join(root, 'asset'), 'original immutable asset');
  return {
    base,
    parent,
    root,
    sid,
    lock: join(parent, '.use-bundle.lock'),
    close: () => rmSync(base, { recursive: true, force: true }),
  };
}

test.skipIf(windows)(
  'candidate Windows scope import is inert and attachment cannot accept forged authority',
  async () => {
    expect(() => retainWindowsArtifactScope('/unused')).toThrow(
      'artifact_scope_platform_unsupported',
    );
    let touched = false;
    expect(() =>
      attachLockResource(
        { path: 'fake', mode: 'shared', release() {} },
        {
          verify() {
            touched = true;
          },
          release() {
            touched = true;
          },
        },
      ),
    ).toThrow('Invalid lock resource attachment');
    expect(touched).toBe(false);
    const root = mkdtempSync(join(tmpdir(), 'kite-scope-import-'));
    try {
      const result = await Bun.build({
        entrypoints: [
          fileURLToPath(
            new URL('../../../src/platform/windows-artifact-scope.ts', import.meta.url),
          ),
        ],
        target: 'node',
        outdir: root,
        packages: 'external',
      });
      expect(result.success).toBe(true);
      const child = spawnSync(
        'node',
        [
          '--input-type=module',
          '-e',
          `const m=await import(${JSON.stringify(pathToFileURL(join(root, 'windows-artifact-scope.js')).href)});if(typeof m.retainWindowsArtifactScope!=='function')throw Error('missing');`,
        ],
        { encoding: 'utf8' },
      );
      expect(child.status).toBe(0);
      expect(child.stderr).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// Native Windows cases are mandatory on win32, with no backend-availability skip.
test.skipIf(!windows)(
  'public inherited read ACL candidates pin ancestry and preserve real lock authority through release',
  () => {
    const f = fixture();
    try {
      const originalAcl = command([f.root]);
      const lease = acquireArtifactAccess({ root: f.root, mode: 'shared' });
      try {
        assertLiveLock(lease, f.lock, 'shared');
        expect(() => attachLockResource(lease, { verify() {}, release() {} })).toThrow();
        acquireArtifactAccess({ root: f.root, mode: 'shared' }).release();
        expect(() => acquireArtifactAccess({ root: f.root, mode: 'exclusive' })).toThrow(
          'Lock is busy',
        );
        expect(() => renameSync(f.root, join(f.parent, 'moved'))).toThrow();
        expect(() => renameSync(f.parent, `${f.parent}-moved`)).toThrow();
        expect(() => renameSync(f.base, `${f.base}-moved`)).toThrow();
        expect(readFileSync(join(f.root, 'asset'), 'utf8')).toBe('original immutable asset');
        expect(command([f.root])).toBe(originalAcl);
        command([f.root, '/grant', '*S-1-1-0:(WD)']);
        expect(() => assertLiveLock(lease, f.lock, 'shared')).toThrow('artifact_scope_denied');
      } finally {
        lease.release();
      }
      lease.release();
      expect(() => assertLiveLock(lease, f.lock, 'shared')).toThrow();
      command([f.root, '/remove:g', '*S-1-1-0']);
      command([f.root, '/grant', '*S-1-1-0:(RX)']);
      acquireArtifactAccess({ root: f.root, mode: 'exclusive' }).release();
      renameSync(f.root, join(f.parent, 'moved'));
      renameSync(join(f.parent, 'moved'), f.root);
    } finally {
      f.close();
    }
  },
);

test.skipIf(!windows)(
  'candidate root and parent unsafe ACL, owner, junction and lock hardlink are rejected without repair',
  () => {
    const f = fixture();
    try {
      for (const path of [f.root, f.parent])
        for (const right of ['W', 'D', 'WD', 'WO', 'DC']) {
          command([path, '/grant', `*S-1-1-0:(${right})`]);
          const unsafe = command([path]);
          expect(() => acquireArtifactAccess({ root: f.root, mode: 'shared' })).toThrow();
          expect(command([path])).toBe(unsafe);
          command([path, '/remove:g', '*S-1-1-0']);
          command([path, '/grant', '*S-1-1-0:(RX)']);
        }
      command([f.root, '/setowner', '*S-1-5-32-544']);
      expect(() => acquireArtifactAccess({ root: f.root, mode: 'shared' })).toThrow();
      command([f.root, '/setowner', `*${f.sid}`]);
      const alias = join(f.parent, 'alias');
      symlinkSync(f.root, alias, 'junction');
      expect(() => acquireArtifactAccess({ root: alias, mode: 'shared' })).toThrow();
      unlinkSync(alias);
      acquireArtifactAccess({ root: f.root, mode: 'shared' }).release();
      linkSync(f.lock, alias);
      expect(() => acquireArtifactAccess({ root: f.root, mode: 'shared' })).toThrow();
      unlinkSync(alias);
      expect(readFileSync(join(f.root, 'asset'), 'utf8')).toBe('original immutable asset');
      acquireArtifactAccess({ root: f.root, mode: 'exclusive' }).release();
    } finally {
      f.close();
    }
  },
);

test.skipIf(!windows)(
  'independent Windows Bun holders retain shared candidate usage until every original holder closes',
  async () => {
    const f = fixture();
    const entry = pathToFileURL(
      fileURLToPath(new URL('../../../src/artifact-access.ts', import.meta.url)),
    ).href;
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const marker = join(f.parent, `ready-${index}`);
        const code = `import {writeFileSync} from 'node:fs';import {acquireArtifactAccess} from ${JSON.stringify(entry)};const lock=acquireArtifactAccess({root:${JSON.stringify(f.root)},mode:'shared'});writeFileSync(${JSON.stringify(marker)},'held');for await(const _ of Bun.stdin.stream()){}lock.release();`;
        const child = Bun.spawn([process.execPath, '-e', code], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        children.push(child);
        const deadline = Date.now() + 5000;
        while (!existsSync(marker)) {
          if (child.exitCode !== null || Date.now() > deadline) {
            if (child.exitCode === null) {
              child.kill('SIGKILL');
              await child.exited;
            }
            throw Error(`owned_holder_not_ready:${await new Response(child.stderr).text()}`);
          }
          await Bun.sleep(10);
        }
      }
      expect(() => acquireArtifactAccess({ root: f.root, mode: 'exclusive' })).toThrow(
        'Lock is busy',
      );
      for (const [index, child] of children.entries()) {
        (child.stdin as import('bun').FileSink).end();
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stderr as ReadableStream<Uint8Array>).text()).toBe('');
        if (index === 0)
          expect(() => acquireArtifactAccess({ root: f.root, mode: 'exclusive' })).toThrow(
            'Lock is busy',
          );
      }
      acquireArtifactAccess({ root: f.root, mode: 'exclusive' }).release();
    } finally {
      for (const child of children)
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      f.close();
    }
  },
  15000,
);
