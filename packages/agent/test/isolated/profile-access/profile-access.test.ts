import { expect, test } from 'bun:test';
import { type ChildProcess, fork, spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProfileMaintenanceAccess } from '../../../src/platform/profile';
import { acquireInheritedProfileAccess, acquireProfileAccess } from '../../../src/profile-access';

const helper = fileURLToPath(new URL('./helper.ts', import.meta.url));
const holder = fileURLToPath(new URL('./node-holder.cjs', import.meta.url));
const posix = process.platform === 'darwin' || process.platform === 'linux';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-profile-access-')));
  const options = { dataRoot: join(root, 'data'), profile: 'test' };
  const original = acquireProfileAccess(options);
  original.lock.release();
  return {
    root,
    options,
    paths: original,
    path: original.lock.path,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
type Reply = {
  event: string;
  result: { ok: boolean; key: string };
  fdIdentity: { dev: number; ino: number };
  signal: string | null;
};
function message(child: ChildProcess, event: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`profile_access_fixture_timeout_${event}`)),
      10000,
    );
    const listener = (value: Reply) => {
      if (value.event === event) {
        clearTimeout(timeout);
        child.off('message', listener);
        resolve(value);
      }
    };
    child.on('message', listener);
    child.once('error', reject);
  });
}
async function close(child: ChildProcess) {
  const exit = new Promise((resolve) => child.once('exit', resolve));
  const closed = message(child, 'closed');
  child.send('close');
  await closed;
  await exit;
}
async function kill(child: ChildProcess) {
  const exit = new Promise<string | null>((resolve) =>
    child.once('exit', (_code, signal) => resolve(signal)),
  );
  expect(child.kill('SIGKILL')).toBe(true);
  expect(await exit).toBe('SIGKILL');
}
function exclusive(f: ReturnType<typeof fixture>, busy: boolean) {
  const result = spawnSync(
    process.execPath,
    [helper, 'exclusive', f.options.dataRoot, f.options.profile],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(result.status).toBe(busy ? 75 : 0);
  const value = JSON.parse(result.stdout);
  expect(value.ok).toBe(!busy);
  if (busy) expect(value.code).toBe('owner_busy');
}

test.skipIf(!posix)(
  'inherited shared admission matches canonical private file, preserves ordinary admission and closes every owned descriptor',
  () => {
    const f = fixture();
    try {
      const fd = openSync(f.path, constants.O_RDWR | constants.O_NOFOLLOW);
      const access = acquireInheritedProfileAccess({ ...f.options, fd });
      expect(access.profileAccessKey).toBe(f.paths.profileAccessKey);
      expect(access.lock.mode).toBe('shared');
      expect(access.lock.path).toBe(f.path);
      expect(() => acquireProfileMaintenanceAccess(f.options)).toThrow('Lock is busy.');
      access.lock.release();
      expect(() => fstatSync(fd)).toThrow();
      access.lock.release();
      exclusive(f, false);
      const foreign = join(f.root, 'foreign');
      writeFileSync(foreign, '', { mode: 0o600 });
      const foreignFd = openSync(foreign, constants.O_RDWR);
      expect(() => acquireInheritedProfileAccess({ ...f.options, fd: foreignFd })).toThrow(
        'Lock is not a stable private regular file.',
      );
      expect(() => fstatSync(foreignFd)).toThrow();
      const alias = join(f.root, 'alias');
      linkSync(f.path, alias);
      const linked = openSync(f.path, constants.O_RDWR);
      expect(() => acquireInheritedProfileAccess({ ...f.options, fd: linked })).toThrow(
        'Lock is not a stable private regular file.',
      );
      expect(() => fstatSync(linked)).toThrow();
      unlinkSync(alias);
      chmodSync(f.path, 0o644);
      const permissive = openSync(f.path, constants.O_RDWR);
      expect(() => acquireInheritedProfileAccess({ ...f.options, fd: permissive })).toThrow(
        'Lock is not a stable private regular file.',
      );
      expect(() => fstatSync(permissive)).toThrow();
      chmodSync(f.path, 0o600);
      const maintenance = acquireProfileMaintenanceAccess(f.options);
      const busyFd = openSync(f.path, constants.O_RDWR);
      expect(() => acquireInheritedProfileAccess({ ...f.options, fd: busyFd })).toThrow(
        'Lock is busy.',
      );
      expect(() => fstatSync(busyFd)).toThrow();
      maintenance.lock.release();
      symlinkSync(f.root, f.paths.profilePath);
      const symlinked = openSync(f.path, constants.O_RDWR);
      expect(() => acquireInheritedProfileAccess({ ...f.options, fd: symlinked })).toThrow(
        'Symlink paths are unsupported.',
      );
      expect(() => fstatSync(symlinked)).toThrow();
      unlinkSync(f.paths.profilePath);
      const journal = join(f.paths.coordinationPath, 'restore-journal.json');
      writeFileSync(journal, '{}', { mode: 0o600 });
      const guarded = openSync(f.path, constants.O_RDWR);
      expect(() => acquireInheritedProfileAccess({ ...f.options, fd: guarded })).toThrow(
        'restore_reconciliation_required',
      );
      expect(() => fstatSync(guarded)).toThrow();
      expect(() => acquireProfileAccess(f.options)).toThrow('restore_reconciliation_required');
      unlinkSync(journal);
      exclusive(f, false);
      const missing = openSync(f.path, constants.O_RDWR);
      expect(() =>
        acquireInheritedProfileAccess({
          dataRoot: join(f.root, 'missing'),
          profile: 'none',
          fd: missing,
        }),
      ).toThrow();
      expect(() => fstatSync(missing)).toThrow();
    } finally {
      f.close();
    }
  },
);

test.skipIf(!posix)(
  'actual Node fd keeps shared profile-use lock after one-shot Bun release/exit, independent child exit and SIGKILL release only owned copies',
  async () => {
    const f = fixture(),
      nodes = new Set<ChildProcess>();
    async function start() {
      const child = fork(
        holder,
        [process.execPath, helper, f.options.dataRoot, f.options.profile, f.path],
        { execPath: 'node', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
      );
      nodes.add(child);
      child.once('exit', () => nodes.delete(child));
      const ready = await message(child, 'ready');
      expect(ready.result.ok).toBe(true);
      expect(ready.result.key).toBe(f.paths.profileAccessKey);
      const actual = lstatSync(f.path);
      expect(ready.fdIdentity).toEqual({ dev: actual.dev, ino: actual.ino });
      return child;
    }
    try {
      exclusive(f, false);
      const a = await start();
      exclusive(f, true);
      const b = await start();
      exclusive(f, true);
      const unrelated = message(a, 'unrelated-exited');
      a.send('unrelated');
      expect((await unrelated).signal).toBe('SIGTERM');
      exclusive(f, true);
      await close(a);
      exclusive(f, true);
      await close(b);
      exclusive(f, false);
      const c = await start();
      exclusive(f, true);
      await kill(c);
      exclusive(f, false);
      const d = await start(),
        e = await start();
      await kill(d);
      exclusive(f, true);
      await kill(e);
      exclusive(f, false);
      expect(nodes.size).toBe(0);
    } finally {
      for (const child of nodes) child.kill('SIGKILL');
      f.close();
    }
  },
  30000,
);

test.skipIf(!posix)(
  'built profile identity remains pure Node and public profile-access leaf admits Bun consumers outside source tree',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-profile-access-build-')));
    try {
      const outdir = join(root, 'built');
      const result = await Bun.build({
        entrypoints: [
          fileURLToPath(new URL('../../../src/profile.ts', import.meta.url)),
          fileURLToPath(new URL('../../../src/profile-access.ts', import.meta.url)),
        ],
        outdir,
        target: 'bun',
        packages: 'external',
        naming: '[name].js',
      });
      expect(result.success).toBe(true);
      const dataRoot = join(root, 'new-data');
      const options = { dataRoot, profile: 'test' };
      const node = spawnSync(
        'node',
        [
          '--input-type=module',
          '--eval',
          `import {selectProfile} from ${JSON.stringify(join(outdir, 'profile.js'))};console.log(JSON.stringify(selectProfile(${JSON.stringify(options)})));`,
        ],
        { cwd: root, encoding: 'utf8', timeout: 10000 },
      );
      expect(node.status).toBe(0);
      const identity = JSON.parse(node.stdout);
      expect(identity.profile).toBe('test');
      expect(() => lstatSync(dataRoot)).toThrow();
      const bun = spawnSync(
        process.execPath,
        [
          '--eval',
          `import {acquireProfileAccess} from ${JSON.stringify(join(outdir, 'profile-access.js'))};const access=acquireProfileAccess(${JSON.stringify(options)});console.log(JSON.stringify({key:access.profileAccessKey,mode:access.lock.mode}));access.lock.release();`,
        ],
        { cwd: root, encoding: 'utf8', timeout: 10000 },
      );
      expect(bun.status).toBe(0);
      expect(JSON.parse(bun.stdout)).toEqual({ key: identity.profileAccessKey, mode: 'shared' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
