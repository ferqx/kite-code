import { expect, test } from 'bun:test';
import { type ChildProcess, fork, spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireArtifactAccess,
  acquireInheritedArtifactAccess,
} from '../../../src/artifact-access';

const posix = process.platform === 'darwin' || process.platform === 'linux';
const helper = fileURLToPath(new URL('./helper.ts', import.meta.url));
const holder = fileURLToPath(new URL('./node-holder.cjs', import.meta.url));
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'kite-artifact-access-')));
  chmodSync(parent, 0o700);
  const root = join(parent, 'bundle');
  mkdirSync(root, { mode: 0o700 });
  const path = join(parent, '.use-bundle.lock');
  acquireArtifactAccess({ root, mode: 'shared' }).release();
  return {
    parent,
    root,
    path,
    close() {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}
test.skipIf(!posix)(
  'inherited Artifact adopts only actual sibling private fd, closes all failures, and preserves ordinary modes',
  () => {
    const f = fixture();
    try {
      const fd = openSync(f.path, constants.O_RDWR | constants.O_NOFOLLOW);
      const lock = acquireInheritedArtifactAccess({ root: f.root, fd });
      expect(lock.path).toBe(f.path);
      expect(lock.mode).toBe('shared');
      expect(() => acquireArtifactAccess({ root: f.root, mode: 'exclusive' })).toThrow(
        'Lock is busy.',
      );
      acquireArtifactAccess({ root: f.root, mode: 'shared' }).release();
      lock.release();
      lock.release();
      expect(() => fstatSync(fd)).toThrow();
      acquireArtifactAccess({ root: f.root, mode: 'exclusive' }).release();
      function rejects(root: string, path = f.path) {
        const fd = openSync(path, constants.O_RDWR);
        expect(() => acquireInheritedArtifactAccess({ root, fd })).toThrow();
        expect(() => fstatSync(fd)).toThrow();
      }
      rejects('relative');
      rejects(join(f.parent, 'missing'));
      rejects(`${f.root}/`);
      const other = join(f.parent, 'other');
      mkdirSync(other, { mode: 0o700 });
      acquireArtifactAccess({ root: other, mode: 'shared' }).release();
      rejects(other);
      const foreignParent = join(f.parent, 'foreign');
      mkdirSync(foreignParent, { mode: 0o700 });
      const sameName = join(foreignParent, 'bundle');
      mkdirSync(sameName, { mode: 0o700 });
      acquireArtifactAccess({ root: sameName, mode: 'shared' }).release();
      rejects(sameName);
      const control = join(f.parent, 'control\nname');
      mkdirSync(control, { mode: 0o700 });
      rejects(control);
      const alias = join(f.parent, 'alias');
      symlinkSync(f.root, alias);
      rejects(alias);
      unlinkSync(alias);
      chmodSync(f.root, 0o777);
      rejects(f.root);
      chmodSync(f.root, 0o700);
      chmodSync(f.parent, 0o777);
      rejects(f.root);
      chmodSync(f.parent, 0o700);
      linkSync(f.path, alias);
      rejects(f.root);
      unlinkSync(alias);
      chmodSync(f.path, 0o644);
      rejects(f.root);
      chmodSync(f.path, 0o600);
      const exclusive = acquireArtifactAccess({ root: f.root, mode: 'exclusive' });
      rejects(f.root);
      exclusive.release();
      const replaced = openSync(f.path, constants.O_RDWR);
      renameSync(f.path, alias);
      writeFileSync(f.path, '', { mode: 0o600 });
      expect(() => acquireInheritedArtifactAccess({ root: f.root, fd: replaced })).toThrow(
        'Lock is not a stable private regular file.',
      );
      expect(() => fstatSync(replaced)).toThrow();
      unlinkSync(alias);
      const privateFile = join(f.parent, 'private');
      writeFileSync(privateFile, '', { mode: 0o600 });
      unlinkSync(f.path);
      symlinkSync(privateFile, f.path);
      rejects(f.root);
      unlinkSync(f.path);
      writeFileSync(f.path, '', { mode: 0o600 });
      for (const fd of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1])
        expect(() => acquireInheritedArtifactAccess({ root: f.root, fd })).toThrow(
          'Invalid inherited lock descriptor.',
        );
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      const unsupported = openSync(f.path, constants.O_RDWR);
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        expect(() => acquireInheritedArtifactAccess({ root: f.root, fd: unsupported })).toThrow(
          'require POSIX',
        );
        expect(() => fstatSync(unsupported)).toThrow();
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    } finally {
      f.close();
    }
  },
);
type Reply = {
  event: string;
  result: { ok: boolean; closed?: boolean; path: string; mode: string };
  helperSignal: string | null;
  fdIdentity: { dev: number; ino: number };
};
function message(child: ChildProcess, event: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('message', listener);
      reject(Error(`artifact_fixture_timeout_${event}`));
    }, 10000);
    const listener = (reply: Reply) => {
      if (reply.event === event) {
        clearTimeout(timeout);
        child.off('message', listener);
        resolve(reply);
      }
    };
    child.on('message', listener);
    child.once('error', reject);
  });
}
async function stop(child: ChildProcess, kill = false) {
  const exited = new Promise<string | null>((resolve) =>
    child.once('exit', (_code, signal) => resolve(signal)),
  );
  if (kill) {
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await exited).toBe('SIGKILL');
  } else {
    const closed = message(child, 'closed');
    child.send('close');
    await closed;
    await exited;
  }
}
function exclusive(root: string, busy: boolean) {
  const result = spawnSync(process.execPath, [helper, 'exclusive', root], {
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.status).toBe(busy ? 75 : 0);
  const reply = JSON.parse(result.stdout);
  expect(reply.ok).toBe(!busy);
  if (busy) expect(reply.code).toBe('owner_busy');
}
test.skipIf(!posix)(
  'actual Node shared OFD survives helper release, exit and SIGKILL; two holders isolate close and parent SIGKILL',
  async () => {
    const f = fixture(),
      nodes = new Set<ChildProcess>();
    async function start(killHelper = false) {
      const child = fork(
        holder,
        [process.execPath, helper, f.root, f.path, killHelper ? 'kill_helper' : 'release'],
        { execPath: 'node', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
      );
      nodes.add(child);
      child.once('exit', () => nodes.delete(child));
      const ready = await message(child, 'ready');
      expect(ready.result.ok).toBe(true);
      expect(ready.result.mode).toBe('shared');
      expect(ready.result.path).toBe(f.path);
      if (!killHelper) expect(ready.result.closed).toBe(true);
      expect(ready.helperSignal).toBe(killHelper ? 'SIGKILL' : null);
      const original = lstatSync(f.path);
      expect(ready.fdIdentity).toEqual({ dev: original.dev, ino: original.ino });
      return child;
    }
    try {
      exclusive(f.root, false);
      const a = await start(),
        b = await start();
      exclusive(f.root, true);
      await stop(a);
      exclusive(f.root, true);
      await stop(b);
      exclusive(f.root, false);
      const c = await start(true);
      exclusive(f.root, true);
      await stop(c, true);
      exclusive(f.root, false);
      const d = await start(),
        e = await start();
      await stop(d, true);
      exclusive(f.root, true);
      await stop(e, true);
      exclusive(f.root, false);
      expect(nodes.size).toBe(0);
    } finally {
      await Promise.all([...nodes].map((c) => stop(c, true)));
      f.close();
    }
  },
  30000,
);
test.skipIf(!posix)(
  'source-free built public Artifact leaf adopts real Node fd without source fallback or extra permissions',
  async () => {
    const f = fixture();
    try {
      const packageRoot = join(f.parent, 'node_modules/@kite-ai/agent');
      mkdirSync(packageRoot, { recursive: true });
      const built = await Bun.build({
        entrypoints: [fileURLToPath(new URL('../../../src/artifact-access.ts', import.meta.url))],
        outdir: join(packageRoot, 'dist'),
        target: 'bun',
        packages: 'external',
        naming: 'artifact-access.js',
      });
      expect(built.success).toBe(true);
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@kite-ai/agent',
          type: 'module',
          exports: { './artifact-access': './dist/artifact-access.js' },
        }),
      );
      const consumer = join(f.parent, 'consumer.js');
      writeFileSync(
        consumer,
        `import {fstatSync} from 'node:fs';import {acquireArtifactAccess,acquireInheritedArtifactAccess} from '@kite-ai/agent/artifact-access';if(process.argv[3]==='exclusive'){try{const lease=acquireArtifactAccess({root:process.argv[2],mode:'exclusive'});lease.release();process.exit(0)}catch{process.exit(75)}}const lease=acquireInheritedArtifactAccess({root:process.argv[2],fd:3});lease.release();let closed=false;try{fstatSync(3)}catch(e){closed=e.code==='EBADF'};console.log(JSON.stringify({path:lease.path,mode:lease.mode,closed}));`,
      );
      const runner = join(f.parent, 'node.cjs');
      writeFileSync(
        runner,
        `const fs=require('node:fs'),cp=require('node:child_process');const [bun,consumer,root,path]=process.argv.slice(2);const fd=fs.openSync(path,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);const child=cp.spawnSync(bun,[consumer,root],{cwd:root,stdio:['ignore','pipe','pipe',fd],encoding:'utf8'});if(child.status!==0)throw Error(child.stderr);const busy=cp.spawnSync(bun,[consumer,root,'exclusive'],{encoding:'utf8'});fs.closeSync(fd);const released=cp.spawnSync(bun,[consumer,root,'exclusive'],{encoding:'utf8'});console.log(JSON.stringify({child:JSON.parse(child.stdout),busy:busy.status,released:released.status}));`,
      );
      const actual = spawnSync('node', [runner, process.execPath, consumer, f.root, f.path], {
        cwd: f.root,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(actual.status).toBe(0);
      expect(JSON.parse(actual.stdout)).toEqual({
        child: { path: f.path, mode: 'shared', closed: true },
        busy: 75,
        released: 0,
      });
    } finally {
      f.close();
    }
  },
  15000,
);
