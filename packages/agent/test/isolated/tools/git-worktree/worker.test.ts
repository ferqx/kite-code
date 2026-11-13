import * as childProcesses from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as filesystem from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, spyOn, test } from '#kite-test';
import { which as findExecutable } from '../../../../../../scripts/tooling/process';
import { persistentWorktreeDirectory } from '../../../../../../tests/fixtures/worktree-filesystem';
import * as ffi from '../../../../src/runtime-ffi';
import { Git, parseWorktrees } from '../../../../src/tools/git-worktree/git';
import { mountTargets, sha256 } from '../../../../src/tools/git-worktree/paths';
import {
  digest,
  type GitWorktreeInput,
  resolveDefaultWorktreeTarget,
  type WorktreeFrame,
  type WorktreePlan,
  type WorktreeRequest,
} from '../../../../src/tools/git-worktree/protocol';
import { executeWorktreeRequest } from '../../../../src/tools/git-worktree/worker';

// Failed/protected fixtures deliberately remain in owned persistent acceptance directories: teardown never
// bypasses the very deletion checks under test with force or recursive filesystem removal.
function fixture(format?: 'sha256') {
  const root = persistentWorktreeDirectory('kite-worktree-worker-'),
    source = join(root, 'source'),
    hooks = join(root, 'hooks');
  mkdirSync(source);
  mkdirSync(hooks);
  const gitPath = findExecutable('git')!;
  const run = (args: string[], cwd = source) =>
    execFileSync(gitPath, args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '0',
        GIT_CONFIG_PARAMETERS: undefined,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
      encoding: 'utf8',
    }).replace(/\n$/, '');
  run(['init', '-q', ...(format ? [`--object-format=${format}`] : [])]);
  run(['config', 'user.name', 'Worktree Test']);
  run(['config', 'user.email', 'worktree@example.test']);
  writeFileSync(join(source, 'tracked.txt'), 'original\n');
  writeFileSync(join(source, '.gitignore'), 'ignored*\n');
  run(['add', '.']);
  run(['commit', '-qm', 'base']);
  const target = join(root, "目标 ' space\nworktree");
  let token = 0;
  const request = (
    phase: WorktreeRequest['phase'],
    input?: GitWorktreeInput,
    plan?: WorktreePlan,
  ): WorktreeRequest => ({
    schemaVersion: 1,
    configurationId: 'fixture',
    operationToken: sha256(String(++token)),
    phase,
    sourceCwd: source,
    git: { path: gitPath, sha256: sha256(readFileSync(gitPath)) },
    hooksPath: hooks,
    ...(input ? { input } : {}),
    ...(plan ? { plan, planDigest: digest(plan) } : {}),
  });
  const createInput = (
    extra: Partial<Extract<GitWorktreeInput, { action: 'create' }>> = {},
  ): Extract<GitWorktreeInput, { action: 'create' }> => ({
    action: 'create',
    key: 'create',
    path: target,
    baseRef: 'HEAD',
    timeoutMs: 120000,
    permissions: { filesystem: 'full_access', network: 'none' },
    ...extra,
  });
  const removeInput = (path = target): Extract<GitWorktreeInput, { action: 'remove' }> => ({
    action: 'remove',
    key: 'remove',
    path,
    timeoutMs: 60000,
    permissions: { filesystem: 'full_access', network: 'none' },
  });
  const create = async (extra: Partial<Extract<GitWorktreeInput, { action: 'create' }>> = {}) => {
    const prepared = await executeWorktreeRequest(request('prepare_create', createInput(extra)));
    expect(prepared.businessOutcome).toBe('prepared');
    return executeWorktreeRequest(request('create', undefined, prepared.plan!));
  };
  const prepareRemove = () => executeWorktreeRequest(request('prepare_remove', removeInput()));
  const remove = async () => {
    const prepared = await prepareRemove();
    expect(prepared.businessOutcome).toBe('prepared');
    return executeWorktreeRequest(request('remove', undefined, prepared.plan!));
  };
  return {
    root,
    source,
    hooks,
    target,
    run,
    request,
    createInput,
    removeInput,
    create,
    prepareRemove,
    remove,
  };
}
function success(frame: WorktreeFrame) {
  expect(frame.businessOutcome).toBe('succeeded');
  expect(frame.details.mutation).toBe('completed');
}
function mockLateMountSnapshot(late: () => boolean, unavailable: boolean) {
  if (process.platform === 'darwin') {
    return spyOn(ffi, 'dlopen').mockImplementation((() => {
      if (late() && unavailable) throw Error('injected late mount denial');
      return {
        symbols: {
          getfsstat64(pointer: ffi.Pointer | null) {
            if (pointer === null) return 1;
            const bytes = new Uint8Array(ffi.toArrayBuffer(pointer, 0, 17 * 2168));
            bytes.fill(0);
            bytes.set(Buffer.from('/'), 88);
            if (late()) bytes[48] = 1;
            return 1;
          },
        },
        close() {},
      };
    }) as unknown as typeof ffi.dlopen);
  }
  const original = filesystem.readFileSync;
  return spyOn(filesystem, 'readFileSync').mockImplementation(((
    path: filesystem.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (path === '/proc/self/mountinfo') {
      if (late() && unavailable) throw Error('injected late mount denial');
      return Buffer.from(`1 0 8:${late() ? 2 : 1} / / rw - ext4 /dev/test rw\n`);
    }
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof filesystem.readFileSync);
}

describe('trusted worktree worker: real Git', () => {
  test('default-root preparation is read-only; original mutation creates missing parents and returns a removable real path', async () => {
    const f = fixture();
    const defaultRoot = join(f.root, 'home', '.kite-code', 'worktrees');
    const path = resolveDefaultWorktreeTarget({
      defaultRoot,
      sourceCwd: f.source,
      sessionId: 's',
      key: 'default',
    });
    const input = { ...f.createInput({ key: 'default' }), path: undefined };
    delete input.path;
    const prepared = await executeWorktreeRequest({
      ...f.request('prepare_create', input),
      resolvedTarget: { path, defaultRoot },
    });
    expect(prepared.businessOutcome).toBe('prepared');
    expect(prepared.details.mutation).toBe('not_started');
    expect(() => readdirSync(join(f.root, 'home'))).toThrow();
    expect(prepared.plan!.evidence).toMatchObject({
      parent: {
        path: f.root,
        defaultRoot,
        missingParents: [join(f.root, 'home'), join(f.root, 'home', '.kite-code'), defaultRoot],
      },
    });
    const created = await executeWorktreeRequest(f.request('create', undefined, prepared.plan));
    success(created);
    expect(created.details.path).toBe(path);
    expect(readFileSync(join(path, 'tracked.txt'), 'utf8')).toBe('original\n');
    const removal = await executeWorktreeRequest(f.request('prepare_remove', f.removeInput(path)));
    expect(removal.businessOutcome).toBe('prepared');
    success(await executeWorktreeRequest(f.request('remove', undefined, removal.plan)));
    expect(readdirSync(defaultRoot)).toEqual([]);
  });

  test('default-root ancestor changes and newly appeared directories fail before target allocation', async () => {
    const f = fixture();
    const defaultRoot = join(f.root, 'home', 'worktrees');
    const path = resolveDefaultWorktreeTarget({
      defaultRoot,
      sourceCwd: f.source,
      sessionId: 's',
      key: 'default',
    });
    const input = { ...f.createInput(), path: undefined };
    delete input.path;
    const prepared = await executeWorktreeRequest({
      ...f.request('prepare_create', input),
      resolvedTarget: { path, defaultRoot },
    });
    expect(prepared.businessOutcome).toBe('prepared');
    mkdirSync(join(f.root, 'home'));
    const result = await executeWorktreeRequest(f.request('create', undefined, prepared.plan));
    expect(result.details).toMatchObject({
      code: 'target_identity_changed',
      mutation: 'not_started',
    });
    expect(() => readdirSync(defaultRoot)).toThrow();
  });

  test('failure after the first default parent mkdir reports partial effects and retains its directory', async () => {
    const f = fixture();
    const home = join(f.root, 'home'),
      defaultRoot = join(home, '.kite-code', 'worktrees');
    const path = resolveDefaultWorktreeTarget({
      defaultRoot,
      sourceCwd: f.source,
      sessionId: 's',
      key: 'default',
    });
    const input = { ...f.createInput(), path: undefined };
    delete input.path;
    const prepared = await executeWorktreeRequest({
      ...f.request('prepare_create', input),
      resolvedTarget: { path, defaultRoot },
    });
    expect(prepared.businessOutcome).toBe('prepared');
    const original = filesystem.mkdirSync;
    const mkdir = spyOn(filesystem, 'mkdirSync').mockImplementation(((
      ...args: Parameters<typeof filesystem.mkdirSync>
    ) => {
      if (args[0] === join(home, '.kite-code')) throw Error('injected parent allocation failure');
      return original(...args);
    }) as typeof filesystem.mkdirSync);
    try {
      const result = await executeWorktreeRequest(f.request('create', undefined, prepared.plan));
      expect(result.businessOutcome).toBe('failed');
      expect(result.details.mutation).toBe('partial');
      expect(result.details.observed).toMatchObject({ pathExists: false, registered: false });
      expect(readdirSync(home)).toEqual([]);
      expect(f.run(['worktree', 'list', '--porcelain'])).not.toContain(path);
      expect(() => readdirSync(path)).toThrow();
    } finally {
      mkdir.mockRestore();
    }
  });

  test('temporary targets are refused for prepare and forged mutation, but old temporary worktrees remain removable', async () => {
    const f = fixture();
    const target = join(
      tmpdir(),
      `kite-denied-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const prepare = await executeWorktreeRequest(
      f.request('prepare_create', f.createInput({ path: target })),
    );
    expect(prepare.details).toMatchObject({
      code: 'temporary_worktree_target',
      mutation: 'not_started',
    });
    const persistent = await executeWorktreeRequest(f.request('prepare_create', f.createInput()));
    expect(persistent.businessOutcome).toBe('prepared');
    const forged = { ...persistent.plan!, targetPath: target };
    const denied = await executeWorktreeRequest(f.request('create', undefined, forged));
    expect(denied.details).toMatchObject({
      code: 'temporary_worktree_target',
      mutation: 'not_started',
    });
    success(await executeWorktreeRequest(f.request('create', undefined, persistent.plan)));
    // Model an older worktree whose directory is now designated temporary. The
    // fixture itself stays in durable acceptance storage; no worktree is created in OS temp.
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = f.root;
    try {
      const old = await executeWorktreeRequest(f.request('prepare_remove', f.removeInput()));
      expect(old.businessOutcome).toBe('prepared');
      success(await executeWorktreeRequest(f.request('remove', undefined, old.plan)));
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  test('lists exact paths, creates detached from frozen HEAD, preserves source files, removes normally', async () => {
    const f = fixture();
    const originalHead = f.run(['rev-parse', 'HEAD']);
    writeFileSync(join(f.source, 'tracked.txt'), 'staged\n');
    f.run(['add', 'tracked.txt']);
    writeFileSync(join(f.source, 'tracked.txt'), 'unstaged\n');
    writeFileSync(join(f.source, 'local.txt'), 'local');
    writeFileSync(join(f.source, 'ignored.bin'), 'ignored');
    const sourceIndex = readFileSync(join(f.source, '.git/index'));
    const created = await f.create();
    success(created);
    expect(created.details.path).toBe(f.target);
    expect(created.details.detached).toBe(true);
    expect(created.details.head).toBe(originalHead);
    expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(readdirSync(f.target)).not.toContain('local.txt');
    expect(readFileSync(join(f.source, 'tracked.txt'), 'utf8')).toBe('unstaged\n');
    expect(readFileSync(join(f.source, '.git/index'))).toEqual(sourceIndex);
    const listed = await executeWorktreeRequest(f.request('list', { action: 'list' }));
    expect(listed.businessOutcome).toBe('succeeded');
    const worktrees = listed.details.worktrees as unknown as {
      path: string;
      isCurrent: boolean;
      isMain: boolean;
    }[];
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toMatchObject({ path: f.source, isCurrent: true, isMain: true });
    expect(worktrees[1]!.path).toBe(f.target);
    success(await f.remove());
    expect(f.run(['rev-parse', 'HEAD'])).toBe(originalHead);
  });
  test('creates a new local branch without upstream and removal preserves it', async () => {
    const f = fixture();
    success(await f.create({ newBranch: 'topic/新分支' }));
    expect(f.run(['symbolic-ref', 'HEAD'], f.target)).toBe('refs/heads/topic/新分支');
    expect(f.run(['for-each-ref', '--format=%(upstream)', 'refs/heads/topic/新分支'])).toBe('');
    success(await f.remove());
    expect(f.run(['rev-parse', 'refs/heads/topic/新分支'])).toBe(f.run(['rev-parse', 'HEAD']));
  });
  test('prepare freezes OID even if source branch moves', async () => {
    const f = fixture(),
      base = f.run(['rev-parse', 'HEAD']);
    const prepared = await executeWorktreeRequest(f.request('prepare_create', f.createInput()));
    expect(prepared.businessOutcome).toBe('prepared');
    writeFileSync(join(f.source, 'new.txt'), 'later');
    f.run(['add', '.']);
    f.run(['commit', '-qm', 'later']);
    const created = await executeWorktreeRequest(f.request('create', undefined, prepared.plan!));
    success(created);
    expect(created.details.head).toBe(base);
    success(await f.remove());
  });
  test('supports SHA256 commits without hardcoding SHA1', async () => {
    const f = fixture('sha256');
    success(await f.create());
    expect(f.run(['rev-parse', 'HEAD'], f.target)).toHaveLength(64);
    success(await f.remove());
  });
  test('rejects existing empty target and does not create missing parents', async () => {
    const f = fixture();
    mkdirSync(f.target);
    expect(
      (await executeWorktreeRequest(f.request('prepare_create', f.createInput()))).details.code,
    ).toBe('target_exists');
    expect(
      (
        await executeWorktreeRequest(
          f.request('prepare_create', f.createInput({ path: join(f.root, 'absent', 'target') })),
        )
      ).businessOutcome,
    ).toBe('failed');
  });
  test('source and destination includeIf filter commands never run; dotted equals driver names are exact', async () => {
    const f = fixture(),
      marker = join(f.root, 'filter-ran');
    writeFileSync(join(f.source, '.gitattributes'), 'tracked.txt filter=a.b=c\n');
    f.run(['add', '.gitattributes']);
    f.run(['commit', '-qm', 'attributes']);
    const config = join(f.root, 'destination.cfg');
    writeFileSync(
      config,
      `[filter "a.b=c"]\n process = touch '${marker}'\n clean = touch '${marker}'\n smudge = touch '${marker}'\n required = true\n`,
    );
    f.run(['config', `includeIf.gitdir:${f.source}/.git/worktrees/**.path`, config]);
    success(await f.create());
    expect(readdirSync(f.root)).not.toContain('filter-ran');
    success(await f.remove());
  });
  for (const phase of ['prepare', 'mutation'] as const)
    test(`rejects stat-cache-hidden same-size content at ${phase}, retaining the file`, async () => {
      const f = fixture();
      f.run(['config', 'core.trustctime', 'false']);
      f.run(['config', 'core.checkStat', 'minimal']);
      success(await f.create());
      const path = join(f.target, 'tracked.txt'),
        timestamp = new Date('2000-01-01T00:00:00Z');
      filesystem.utimesSync(path, timestamp, timestamp);
      f.run(['update-index', '--refresh'], f.target);
      const prepared = phase === 'mutation' ? await f.prepareRemove() : undefined;
      if (prepared) expect(prepared.businessOutcome).toBe('prepared');
      writeFileSync(path, 'modified\n');
      filesystem.utimesSync(path, timestamp, timestamp);
      expect(f.run(['--no-optional-locks', 'status', '--porcelain=v2'], f.target)).toBe('');
      const result = prepared
        ? await executeWorktreeRequest(f.request('remove', undefined, prepared.plan!))
        : await f.prepareRemove();
      expect(result.businessOutcome).toBe('failed');
      expect(result.details).toMatchObject({ code: 'worktree_dirty', mutation: 'not_started' });
      expect(readFileSync(path, 'utf8')).toBe('modified\n');
      expect(f.run(['rev-parse', '--show-toplevel'], f.target)).toBe(f.target);
    });

  test('hashes with CRLF, ident and working-tree-encoding conversions without rejecting clean files', async () => {
    const f = fixture();
    writeFileSync(
      join(f.source, '.gitattributes'),
      'tracked.txt text eol=crlf\nident.txt ident\nencoded.txt text working-tree-encoding=UTF-16LE\n',
    );
    writeFileSync(join(f.source, 'ident.txt'), '$Id$\n');
    writeFileSync(join(f.source, 'encoded.txt'), Buffer.from('encoded content\n', 'utf16le'));
    f.run(['add', '.']);
    f.run(['commit', '-qm', 'attributes']);
    success(await f.create());
    expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('original\r\n');
    expect(readFileSync(join(f.target, 'ident.txt'), 'utf8')).toMatch(/^\$Id: [a-f0-9]+ \$\n$/);
    expect(readFileSync(join(f.target, 'encoded.txt'), 'utf16le')).toBe('encoded content\n');
    success(await f.remove());
  });

  test.skipIf(process.platform === 'win32')(
    'proves executable modes independently of core.filemode and accepts matching executable files',
    async () => {
      const f = fixture();
      filesystem.chmodSync(join(f.source, 'tracked.txt'), 0o755);
      f.run(['add', 'tracked.txt']);
      f.run(['commit', '-qm', 'executable']);
      f.run(['config', 'core.filemode', 'false']);
      success(await f.create());
      expect((await f.prepareRemove()).businessOutcome).toBe('prepared');
      filesystem.chmodSync(join(f.target, 'tracked.txt'), 0o644);
      expect(f.run(['status', '--porcelain=v2'], f.target)).toBe('');
      expect((await f.prepareRemove()).details.code).toBe('worktree_dirty');
      filesystem.chmodSync(join(f.target, 'tracked.txt'), 0o755);
      success(await f.remove());
    },
  );

  test('refuses a missing index blob even when its only file copy hashes to the same OID', async () => {
    const f = fixture();
    success(await f.create());
    const blob = f.run(['rev-parse', 'HEAD:tracked.txt']);
    unlinkSync(join(f.source, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expect(f.run(['status', '--porcelain=v2'], f.target)).toBe('');
    const result = await f.prepareRemove();
    expect(result.businessOutcome).toBe('failed');
    expect(result.details.mutation).toBe('not_started');
    expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  test('verifies the entire retained blob body rather than trusting an intact object header', async () => {
    const f = fixture();
    success(await f.create());
    const blob = f.run(['rev-parse', 'HEAD:tracked.txt']);
    const path = join(f.source, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    unlinkSync(path);
    writeFileSync(path, deflateSync(Buffer.from('blob 9\0modified\n')));
    // Native Git exposes the damaged body under the original OID, so header-only
    // existence/type checks would silently accept the loss of the original file.
    expect(f.run(['cat-file', '-t', blob])).toBe('blob');
    expect(f.run(['cat-file', 'blob', blob])).toBe('modified');
    const result = await f.prepareRemove();
    expect(result.details).toMatchObject({
      code: 'worktree_verification_failed',
      mutation: 'not_started',
    });
    expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  test('streams complete retained blobs larger than the diagnostic output limit', async () => {
    const f = fixture();
    writeFileSync(join(f.source, 'large.bin'), Buffer.alloc(17 * 1024 * 1024, 0xa5));
    f.run(['add', '.']);
    f.run(['commit', '-qm', 'large blob']);
    success(await f.create());
    expect(filesystem.statSync(join(f.target, 'large.bin')).size).toBe(17 * 1024 * 1024);
    success(await f.remove());
  });

  test('retains files that change after content proof but before deletion', async () => {
    const f = fixture(),
      original = Git.prototype.run;
    success(await f.create());
    const prepared = await f.prepareRemove();
    expect(prepared.businessOutcome).toBe('prepared');
    let injected = false;
    const mocked = spyOn(Git.prototype, 'run').mockImplementation(async function (
      this: Git,
      ...args: Parameters<Git['run']>
    ) {
      const result = await original.apply(this, args);
      if (args[1][0] === 'rev-list' && !injected) {
        injected = true;
        writeFileSync(join(f.target, 'tracked.txt'), 'modified\n');
      }
      return result;
    });
    try {
      const result = await executeWorktreeRequest(f.request('remove', undefined, prepared.plan!));
      expect(injected).toBe(true);
      expect(result.details).toMatchObject({
        code: 'target_identity_changed',
        mutation: 'not_started',
      });
      expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('modified\n');
    } finally {
      mocked.mockRestore();
    }
  });

  for (const local of ['ignored-file', 'empty-directory'] as const)
    test(`preserves a nested ${local} introduced after the complete tree scan`, async () => {
      const f = fixture(),
        original = Git.prototype.run;
      mkdirSync(join(f.source, 'dir'));
      writeFileSync(join(f.source, 'dir', 'tracked'), 'tracked');
      f.run(['add', '.']);
      f.run(['commit', '-qm', 'nested tracked directory']);
      success(await f.create());
      const prepared = await f.prepareRemove();
      expect(prepared.businessOutcome).toBe('prepared');
      const path = join(
        f.target,
        'dir',
        local === 'ignored-file' ? 'ignored-local.txt' : 'empty-local-directory',
      );
      let injected = false,
        removals = 0;
      const mocked = spyOn(Git.prototype, 'run').mockImplementation(async function (
        this: Git,
        ...args: Parameters<Git['run']>
      ) {
        if (args[1][0] === 'worktree' && args[1][1] === 'remove') removals++;
        const result = await original.apply(this, args);
        if (args[1][0] === 'rev-list' && !injected) {
          injected = true;
          if (local === 'ignored-file') writeFileSync(path, 'preserve local data');
          else mkdirSync(path);
        }
        return result;
      });
      try {
        const result = await executeWorktreeRequest(f.request('remove', undefined, prepared.plan!));
        expect(injected).toBe(true);
        expect(result.details).toMatchObject({
          code: 'path_scan_incomplete',
          mutation: 'not_started',
        });
        expect(removals).toBe(0);
        if (local === 'ignored-file')
          expect(readFileSync(path, 'utf8')).toBe('preserve local data');
        else expect(readdirSync(path)).toEqual([]);
        expect(readFileSync(join(f.target, 'dir', 'tracked'), 'utf8')).toBe('tracked');
      } finally {
        mocked.mockRestore();
      }
    });

  for (const fault of ['changed', 'unavailable'] as const)
    test.skipIf(process.platform === 'win32')(
      `preserves the target when the final mount snapshot is ${fault}`,
      async () => {
        const f = fixture(),
          original = Git.prototype.run;
        success(await f.create());
        const prepared = await f.prepareRemove();
        expect(prepared.businessOutcome).toBe('prepared');
        let late = false,
          removals = 0;
        const mounts = mockLateMountSnapshot(() => late, fault === 'unavailable');
        const mocked = spyOn(Git.prototype, 'run').mockImplementation(async function (
          this: Git,
          ...args: Parameters<Git['run']>
        ) {
          if (args[1][0] === 'worktree' && args[1][1] === 'remove') removals++;
          const result = await original.apply(this, args);
          if (args[1][0] === 'rev-list') late = true;
          return result;
        });
        try {
          const result = await executeWorktreeRequest(
            f.request('remove', undefined, prepared.plan!),
          );
          expect(late).toBe(true);
          expect(result.details).toMatchObject({
            code: 'unsupported_mount_inspection',
            mutation: 'not_started',
          });
          expect(removals).toBe(0);
          expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('original\n');
        } finally {
          mocked.mockRestore();
          mounts.mockRestore();
        }
      },
    );

  test('ordinary shared packed references retain commits after successful removal', async () => {
    const f = fixture();
    success(await f.create());
    f.run(['pack-refs', '--all']);
    const branch = f.run(['symbolic-ref', 'HEAD']);
    const retained = f.run(['rev-parse', branch]);
    success(await f.remove());
    expect(f.run(['rev-parse', branch])).toBe(retained);
    expect(filesystem.lstatSync(join(f.source, '.git', 'packed-refs')).isFile()).toBe(true);
  });

  for (const phase of ['prepare', 'mutation'] as const)
    test.skipIf(process.platform === 'win32')(
      `rejects packed-ref backing aliased into disposable admin at ${phase}`,
      async () => {
        const f = fixture(),
          original = Git.prototype.run;
        success(await f.create());
        f.run(['pack-refs', '--all']);
        const branch = f.run(['symbolic-ref', 'HEAD']);
        const retained = f.run(['rev-parse', branch]);
        const packed = join(f.source, '.git', 'packed-refs');
        const backing = join(
          f.run(['rev-parse', '--absolute-git-dir'], f.target),
          'retained-packed-refs',
        );
        writeFileSync(backing, readFileSync(packed));
        const prepared = phase === 'mutation' ? await f.prepareRemove() : undefined;
        if (prepared) expect(prepared.businessOutcome).toBe('prepared');
        unlinkSync(packed);
        symlinkSync(backing, packed, 'file');
        expect(f.run(['rev-parse', branch])).toBe(retained);
        let removals = 0;
        const mocked = spyOn(Git.prototype, 'run').mockImplementation(async function (
          this: Git,
          ...args: Parameters<Git['run']>
        ) {
          if (args[1][0] === 'worktree' && args[1][1] === 'remove') removals++;
          return original.apply(this, args);
        });
        try {
          const result = prepared
            ? await executeWorktreeRequest(f.request('remove', undefined, prepared.plan!))
            : await f.prepareRemove();
          expect(result.details).toMatchObject({ code: 'unsafe_symlink', mutation: 'not_started' });
          expect(removals).toBe(0);
          expect(f.run(['rev-parse', branch])).toBe(retained);
          expect(readFileSync(backing)).toEqual(readFileSync(packed));
          expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('original\n');
        } finally {
          mocked.mockRestore();
        }
      },
    );

  test('does not count a branch symref through the removed worktree HEAD as commit protection', async () => {
    const f = fixture();
    success(await f.create());
    writeFileSync(join(f.target, 'tracked.txt'), 'unique commit\n');
    f.run(['add', '.'], f.target);
    f.run(['commit', '-qm', 'unique'], f.target);
    const admin = f.run(['rev-parse', '--absolute-git-dir'], f.target).split(/[\\/]/).at(-1)!;
    f.run(['symbolic-ref', 'refs/heads/apparent-retention', `worktrees/${admin}/HEAD`]);
    f.run(['symbolic-ref', 'refs/heads/indirect-retention', 'refs/heads/apparent-retention']);
    const result = await f.prepareRemove();
    expect(result.details).toMatchObject({ code: 'unprotected_commits', mutation: 'not_started' });
    expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('unique commit\n');
    expect(f.run(['rev-parse', 'refs/heads/indirect-retention'])).toBe(
      f.run(['rev-parse', 'HEAD'], f.target),
    );
    // A stable shared branch symref still counts, including a multi-hop chain.
    f.run(['update-ref', 'refs/heads/retained', 'HEAD'], f.target);
    f.run(['symbolic-ref', 'refs/heads/apparent-retention', 'refs/heads/retained']);
    success(await f.remove());
    expect(f.run(['rev-parse', 'refs/heads/indirect-retention'])).toBe(
      f.run(['rev-parse', 'refs/heads/retained']),
    );
  });

  test('a symbolic branch depending on another detached worktree HEAD is not independent protection', async () => {
    const f = fixture();
    success(await f.create());
    writeFileSync(join(f.target, 'tracked.txt'), 'unique commit\n');
    f.run(['add', '.'], f.target);
    f.run(['commit', '-qm', 'unique'], f.target);
    const other = join(f.root, 'other');
    success(
      await f.create({
        path: other,
        baseRef: f.run(['rev-parse', 'HEAD'], f.target),
        key: 'other',
      }),
    );
    const admin = f.run(['rev-parse', '--absolute-git-dir'], other).split(/[\\/]/).at(-1)!;
    f.run(['symbolic-ref', 'refs/heads/apparent-retention', `worktrees/${admin}/HEAD`]);
    expect((await f.prepareRemove()).details).toMatchObject({
      code: 'unprotected_commits',
      mutation: 'not_started',
    });
    expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('unique commit\n');
  });

  for (const phase of ['prepare', 'mutation'] as const)
    test(`rejects a dangling newBranch symref at ${phase} without creating its referent`, async () => {
      const f = fixture(),
        input = f.createInput({ newBranch: 'requested' });
      const prepared =
        phase === 'mutation'
          ? await executeWorktreeRequest(f.request('prepare_create', input))
          : undefined;
      if (prepared) expect(prepared.businessOutcome).toBe('prepared');
      f.run(['symbolic-ref', 'refs/heads/requested', 'refs/heads/unrequested']);
      const result = prepared
        ? await executeWorktreeRequest(f.request('create', undefined, prepared.plan!))
        : await executeWorktreeRequest(f.request('prepare_create', input));
      expect(result.details).toMatchObject({ code: 'branch_exists', mutation: 'not_started' });
      expect(filesystem.existsSync(f.target)).toBe(false);
      expect(filesystem.existsSync(join(f.source, '.git/refs/heads/unrequested'))).toBe(false);
      expect(f.run(['symbolic-ref', 'refs/heads/requested'])).toBe('refs/heads/unrequested');
    });

  test('lists locked and missing prunable registrations without claiming removable', async () => {
    const f = fixture();
    success(await f.create());
    f.run(['worktree', 'lock', '--reason', 'a reason', f.target]);
    const listed = await executeWorktreeRequest(f.request('list', { action: 'list' }));
    const rows = listed.details.worktrees as unknown as Record<string, unknown>[];
    expect(rows[1]).toMatchObject({ locked: true, lockReason: 'a reason' });
    expect(rows[1]).not.toHaveProperty('removable');
    expect((await f.prepareRemove()).details.code).toBe('worktree_locked');
    f.run(['worktree', 'unlock', f.target]);
    success(await f.remove());
  });
  test.each([
    'staged',
    'unstaged',
    'untracked',
    'ignored',
    'empty',
    'ignored-empty',
    'assume',
    'skip',
  ] as const)('refuses %s local content', async (kind) => {
    const f = fixture();
    success(await f.create());
    if (kind === 'staged' || kind === 'unstaged') {
      writeFileSync(join(f.target, 'tracked.txt'), 'local\n');
      if (kind === 'staged') f.run(['add', 'tracked.txt'], f.target);
    }
    if (kind === 'untracked' || kind === 'ignored')
      writeFileSync(join(f.target, kind === 'ignored' ? 'ignored.bin' : 'extra.txt'), 'local');
    if (kind === 'empty' || kind === 'ignored-empty')
      mkdirSync(join(f.target, kind === 'empty' ? 'extra-empty' : 'ignored-empty'));
    if (kind === 'assume' || kind === 'skip') {
      f.run(
        [
          'update-index',
          kind === 'assume' ? '--assume-unchanged' : '--skip-worktree',
          'tracked.txt',
        ],
        f.target,
      );
      writeFileSync(join(f.target, 'tracked.txt'), 'hidden local\n');
    }
    const result = await f.prepareRemove();
    expect(result.businessOutcome).toBe('failed');
    expect(result.details.mutation).toBe('not_started');
    expect(['worktree_dirty', 'local_content_present', 'unsupported_index_flags']).toContain(
      result.details.code as string,
    );
    expect(readFileSync(join(f.source, 'tracked.txt'), 'utf8')).toBe('original\n');
  });
  test('protects current HEAD and old-only reflog commits; remote references do not retain them', async () => {
    const f = fixture();
    success(await f.create());
    const base = f.run(['rev-parse', 'HEAD']);
    writeFileSync(join(f.target, 'unique.txt'), 'unique');
    f.run(['add', '.'], f.target);
    f.run(['commit', '-qm', 'unique'], f.target);
    const unique = f.run(['rev-parse', 'HEAD'], f.target);
    expect((await f.prepareRemove()).details.code).toBe('unprotected_commits');
    f.run(['update-ref', 'refs/remotes/origin/retained', unique]);
    f.run(['reset', '--hard', base], f.target);
    const logPath = f.run(
      ['rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD'],
      f.target,
    );
    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    writeFileSync(logPath, `${lines.at(-1)!}\n`);
    expect((await f.prepareRemove()).details.code).toBe('unprotected_commits');
    f.run(['update-ref', 'refs/tags/retained', unique]);
    success(await f.remove());
  });
  test('missing or damaged reflog fails closed', async () => {
    const f = fixture();
    success(await f.create());
    const path = f.run(
        ['rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD'],
        f.target,
      ),
      original = readFileSync(path);
    writeFileSync(path, 'bad reflog\n');
    expect((await f.prepareRemove()).details.code).toBe('unsupported_reflog');
    unlinkSync(path);
    expect((await f.prepareRemove()).details.code).toBe('unsupported_reflog');
    writeFileSync(path, original);
    success(await f.remove());
  });
  test('main and source linked checkout cannot be removed', async () => {
    const f = fixture();
    expect(
      (await executeWorktreeRequest(f.request('prepare_remove', f.removeInput(f.source)))).details
        .code,
    ).toBe('main_worktree');
    success(await f.create());
    const request = f.request('prepare_remove', f.removeInput());
    request.sourceCwd = f.target;
    expect((await executeWorktreeRequest(request)).details.code).toBe('current_worktree');
    success(await f.remove());
  });
  test('target replacement after prepare is preserved', async () => {
    const f = fixture();
    success(await f.create());
    const plan = (await f.prepareRemove()).plan!;
    f.run(['worktree', 'remove', '--', f.target]);
    success(await f.create());
    const result = await executeWorktreeRequest(f.request('remove', undefined, plan));
    expect(result.details.code).toBe('target_identity_changed');
    expect(readFileSync(join(f.target, 'tracked.txt'), 'utf8')).toBe('original\n');
    success(await f.remove());
  });
  test('parent replacement after prepare cannot redirect create', async () => {
    const f = fixture(),
      parent = join(f.root, 'parent');
    mkdirSync(parent);
    const target = join(parent, 'new');
    const prepared = await executeWorktreeRequest(
      f.request('prepare_create', f.createInput({ path: target })),
    );
    expect(prepared.businessOutcome).toBe('prepared');
    renameSync(parent, join(f.root, 'original-parent'));
    mkdirSync(parent);
    const result = await executeWorktreeRequest(f.request('create', undefined, prepared.plan!));
    expect(result.details.code).toBe('target_identity_changed');
    expect(readdirSync(parent)).toEqual([]);
  });
  test('unknown repository locks are never claimed or removed', async () => {
    const f = fixture();
    const plan = (await executeWorktreeRequest(f.request('prepare_create', f.createInput()))).plan!;
    const lock = join(f.source, '.git', 'kite-worktree-operation.lock');
    mkdirSync(lock);
    const result = await executeWorktreeRequest(f.request('create', undefined, plan));
    expect(result.details.code).toBe('lock_state_unknown');
    expect(readdirSync(lock)).toEqual([]);
  });
  test('symlink inside target is refused without following it', async () => {
    const f = fixture();
    success(await f.create());
    symlinkSync(
      f.source,
      join(f.target, 'linked-source'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect((await f.prepareRemove()).businessOutcome).toBe('failed');
    expect(readFileSync(join(f.source, 'tracked.txt'), 'utf8')).toBe('original\n');
    if (process.platform === 'win32') rmdirSync(join(f.target, 'linked-source'));
    else unlinkSync(join(f.target, 'linked-source'));
    success(await f.remove());
  });
  test('grafts, sparse and core.worktree configurations reject before mutation', async () => {
    for (const option of ['core.worktree', 'core.sparseCheckout'] as const) {
      const f = fixture();
      f.run(['config', option, option === 'core.worktree' ? f.source : 'true']);
      const result = await executeWorktreeRequest(f.request('prepare_create', f.createInput()));
      expect(result.details.code).toBe('unsupported_repository_configuration');
    }
    const f = fixture();
    mkdirSync(join(f.source, '.git/info'), { recursive: true });
    writeFileSync(join(f.source, '.git/info/grafts'), '');
    expect(
      (await executeWorktreeRequest(f.request('prepare_create', f.createInput()))).details.code,
    ).toBe('unsupported_repository_configuration');
  });
  test('changed Git asset is rejected', async () => {
    const f = fixture(),
      request = f.request('list', { action: 'list' });
    request.git.sha256 = '0'.repeat(64);
    expect((await executeWorktreeRequest(request)).details.code).toBe('worktree_asset_changed');
  });
  test('add branch failure reports partial registration and leaves branch intact', async () => {
    const f = fixture(),
      original = Git.prototype.run;
    const mocked = spyOn(Git.prototype, 'run').mockImplementation(async function (
      this: Git,
      ...args: Parameters<Git['run']>
    ) {
      const result = await original.apply(this, args);
      if (args[1][0] === 'worktree' && args[1][1] === 'add')
        throw new Error('injected failure after accepted add');
      return result;
    });
    try {
      const result = await f.create({ newBranch: 'retained-partial' });
      expect(result.businessOutcome).toBe('failed');
      expect(result.details.mutation).toBe('partial');
      expect(result.details.observed).toMatchObject({
        pathExists: true,
        registered: true,
        newBranchExists: true,
      });
      expect(f.run(['rev-parse', 'refs/heads/retained-partial'])).toBe(
        f.run(['rev-parse', 'HEAD']),
      );
    } finally {
      mocked.mockRestore();
    }
  });
  test('foreign file after no-checkout is preserved and reset never starts', async () => {
    const f = fixture(),
      original = Git.prototype.run;
    let resets = 0;
    const mocked = spyOn(Git.prototype, 'run').mockImplementation(async function (
      this: Git,
      ...args: Parameters<Git['run']>
    ) {
      if (args[1][0] === 'reset') resets++;
      const result = await original.apply(this, args);
      if (args[1][0] === 'worktree' && args[1][1] === 'add')
        writeFileSync(join(f.target, 'foreign.txt'), 'preserve');
      return result;
    });
    try {
      const result = await f.create();
      expect(result.businessOutcome).toBe('failed');
      expect(result.details.mutation).toBe('partial');
      expect(resets).toBe(0);
      expect(readFileSync(join(f.target, 'foreign.txt'), 'utf8')).toBe('preserve');
    } finally {
      mocked.mockRestore();
    }
  });
  test('lock release failure returns failed completed mutation and retains lock facts', async () => {
    const f = fixture(),
      original = Git.prototype.run;
    const mocked = spyOn(Git.prototype, 'run').mockImplementation(async function (
      this: Git,
      ...args: Parameters<Git['run']>
    ) {
      const result = await original.apply(this, args);
      if (args[1][0] === 'reset')
        writeFileSync(
          join(f.source, '.git/kite-worktree-operation.lock', 'foreign-owner'),
          'preserve',
        );
      return result;
    });
    try {
      const result = await f.create();
      expect(result.businessOutcome).toBe('failed');
      expect(result.details.code).toBe('worktree_lock_cleanup_failed');
      expect(result.details.mutation).toBe('completed');
      expect(
        readFileSync(join(f.source, '.git/kite-worktree-operation.lock', 'foreign-owner'), 'utf8'),
      ).toBe('preserve');
    } finally {
      mocked.mockRestore();
    }
  });
  test('two clone workers racing for the same path only let one reserve and create its branch', async () => {
    const first = fixture(),
      second = fixture();
    const a = await executeWorktreeRequest(
      first.request('prepare_create', first.createInput({ newBranch: 'first' })),
    );
    const b = await executeWorktreeRequest(
      second.request(
        'prepare_create',
        second.createInput({ path: first.target, newBranch: 'second' }),
      ),
    );
    expect(a.businessOutcome).toBe('prepared');
    expect(b.businessOutcome).toBe('prepared');
    const results = await Promise.all([
      executeWorktreeRequest(first.request('create', undefined, a.plan!)),
      executeWorktreeRequest(second.request('create', undefined, b.plan!)),
    ]);
    expect(results.filter((result) => result.businessOutcome === 'succeeded')).toHaveLength(1);
    const branches = [
      first.run(['for-each-ref', '--format=%(refname)', 'refs/heads/first']),
      second.run(['for-each-ref', '--format=%(refname)', 'refs/heads/second']),
    ];
    expect(branches.filter(Boolean)).toHaveLength(1);
  });
  test('replacement objects cannot fabricate retained detached commits', async () => {
    const f = fixture();
    success(await f.create());
    const base = f.run(['rev-parse', 'HEAD']);
    writeFileSync(join(f.target, 'unique.txt'), 'unique');
    f.run(['add', '.'], f.target);
    f.run(['commit', '-qm', 'unique'], f.target);
    const unique = f.run(['rev-parse', 'HEAD'], f.target);
    f.run(['replace', base, unique]);
    expect((await f.prepareRemove()).details.code).toBe('unprotected_commits');
  });
  test('gitlink index entries are refused even before submodule initialization', async () => {
    const f = fixture();
    const head = f.run(['rev-parse', 'HEAD']);
    f.run(['update-index', '--add', '--cacheinfo', `160000,${head},module`]);
    f.run(['commit', '-qm', 'gitlink']);
    success(await f.create());
    expect((await f.prepareRemove()).details.code).toBe('unsupported_submodule_worktree');
  });
  test('invalid UTF8 in real Git registration is rejected without replacing bytes', async () => {
    if (process.platform === 'win32') return;
    const f = fixture();
    success(await f.create());
    const admin = f.run(['rev-parse', '--path-format=absolute', '--git-dir'], f.target),
      backlink = join(admin, 'gitdir'),
      original = readFileSync(backlink);
    writeFileSync(
      backlink,
      Buffer.concat([Buffer.from(`${f.root}/`), Buffer.from([0xff]), Buffer.from('/.git\n')]),
    );
    try {
      expect(
        (await executeWorktreeRequest(f.request('list', { action: 'list' }))).details.code,
      ).toBe('unsupported_path_encoding');
    } finally {
      writeFileSync(backlink, original);
    }
    success(await f.remove());
  });
  test('nested tracked directories are scanned using Git slash names', async () => {
    const f = fixture();
    mkdirSync(join(f.source, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(f.source, 'nested', 'deep', 'file.txt'), 'nested');
    f.run(['add', '.']);
    f.run(['commit', '-qm', 'nested']);
    success(await f.create());
    success(await f.remove());
  });
  test('missing Git, non-repository, unborn and bare sources fail explicitly without mutation', async () => {
    const f = fixture(),
      missing = f.request('list', { action: 'list' });
    missing.git.path = join(f.root, 'missing-git');
    expect((await executeWorktreeRequest(missing)).details.code).toBe('git_not_found');
    const nonrepo = f.request('list', { action: 'list' });
    // The persistent fixture is inside the source repository; use an ordinary
    // temporary directory solely for this read-only non-repository probe.
    nonrepo.sourceCwd = mkdtempSync(join(tmpdir(), 'kite-worktree-nonrepo-'));
    expect((await executeWorktreeRequest(nonrepo)).details.code).toBe('not_git_repository');
    const unborn = join(f.root, 'unborn');
    mkdirSync(unborn);
    f.run(['init', '-q'], unborn);
    const u = f.request('prepare_create', f.createInput());
    u.sourceCwd = unborn;
    expect((await executeWorktreeRequest(u)).details.code).toBe(
      'unsupported_repository_configuration',
    );
    const bare = join(f.root, 'bare');
    mkdirSync(bare);
    f.run(['init', '--bare', '-q'], bare);
    const b = f.request('prepare_create', f.createInput());
    b.sourceCwd = bare;
    expect((await executeWorktreeRequest(b)).details.code).toBe(
      'unsupported_repository_configuration',
    );
    const listed = f.request('list', { action: 'list' });
    listed.sourceCwd = bare;
    expect((await executeWorktreeRequest(listed)).businessOutcome).toBe('succeeded');
  });
  test('partial clone, shallow and alternates sources reject before reservation', async () => {
    const partial = fixture();
    partial.run(['config', 'remote.origin.promisor', 'true']);
    expect(
      (await executeWorktreeRequest(partial.request('prepare_create', partial.createInput())))
        .details.code,
    ).toBe('unsupported_repository_configuration');
    const shallow = fixture();
    writeFileSync(join(shallow.source, '.git/shallow'), `${shallow.run(['rev-parse', 'HEAD'])}\n`);
    expect(
      (await executeWorktreeRequest(shallow.request('prepare_create', shallow.createInput())))
        .details.code,
    ).toBe('unsupported_repository_configuration');
    const alternates = fixture();
    writeFileSync(join(alternates.source, '.git/objects/info/alternates'), '');
    expect(
      (await executeWorktreeRequest(alternates.request('prepare_create', alternates.createInput())))
        .details.code,
    ).toBe('unsupported_repository_configuration');
  });
  test('missing registered paths remain listed with their prunable reason', async () => {
    const f = fixture();
    success(await f.create());
    const moved = join(f.root, 'moved-worktree');
    renameSync(f.target, moved);
    try {
      const result = await executeWorktreeRequest(f.request('list', { action: 'list' }));
      expect(result.businessOutcome).toBe('succeeded');
      const rows = result.details.worktrees as unknown as {
        path: string;
        prunable: boolean;
        pruneReason: string | null;
      }[];
      expect(rows[1]!.path).toBe(f.target);
      expect(rows[1]!.prunable).toBe(true);
      expect(rows[1]!.pruneReason).toBeString();
    } finally {
      renameSync(moved, f.target);
    }
    success(await f.remove());
  });
  test('creation rejects repository overlap but accepts a similar path prefix', async () => {
    const f = fixture();
    expect(
      (
        await executeWorktreeRequest(
          f.request('prepare_create', f.createInput({ path: join(f.source, 'nested') })),
        )
      ).details.code,
    ).toBe('unsafe_target_path');
    expect(
      (
        await executeWorktreeRequest(
          f.request(
            'prepare_create',
            f.createInput({ path: join(f.source, '.git', 'metadata-child') }),
          ),
        )
      ).details.code,
    ).toBe('unsafe_target_path');
    const path = `${f.source}-linked`;
    success(await f.create({ path }));
    const prepared = await executeWorktreeRequest(f.request('prepare_remove', f.removeInput(path)));
    expect(prepared.businessOutcome).toBe('prepared');
    success(await executeWorktreeRequest(f.request('remove', undefined, prepared.plan!)));
  });
  test('default HEAD belongs to the source linked checkout and explicit tags stay independent', async () => {
    const f = fixture();
    const base = f.run(['rev-parse', 'HEAD']);
    f.run(['tag', 'base-tag', base]);
    success(await f.create());
    writeFileSync(join(f.target, 'only-linked.txt'), 'linked');
    f.run(['add', '.'], f.target);
    f.run(['commit', '-qm', 'linked source'], f.target);
    const linkedHead = f.run(['rev-parse', 'HEAD'], f.target);
    f.run(['tag', 'linked-retained', linkedHead]);
    const sibling = join(f.root, 'from-linked');
    const request = f.request('prepare_create', f.createInput({ path: sibling }));
    request.sourceCwd = f.target;
    const prepared = await executeWorktreeRequest(request);
    expect(prepared.businessOutcome).toBe('prepared');
    expect(prepared.plan!.baseOid).toBe(linkedHead);
    const mutation = f.request('create', undefined, prepared.plan!);
    mutation.sourceCwd = f.target;
    success(await executeWorktreeRequest(mutation));
    expect(f.run(['rev-parse', 'HEAD'], sibling)).toBe(linkedHead);
    const removal = await executeWorktreeRequest(
      f.request('prepare_remove', f.removeInput(sibling)),
    );
    expect(removal.businessOutcome).toBe('prepared');
    success(await executeWorktreeRequest(f.request('remove', undefined, removal.plan!)));
    success(await f.remove());
    success(await f.create({ baseRef: 'base-tag' }));
    expect(f.run(['rev-parse', 'HEAD'], f.target)).toBe(base);
    success(await f.remove());
    // Six real create/remove phases and their native Git checks can exceed Bun's
    // macOS 5s default under the repository's concurrent default runner.
  }, 30000);
  test('native mount snapshot is available on this test platform', () => {
    if (process.platform !== 'win32') expect(mountTargets()).toContain('/');
  });
  test('every Git child disables automatic maintenance and daemon detachment', async () => {
    const f = fixture();
    f.run(['config', 'maintenance.auto', 'true']);
    f.run(['config', 'gc.auto', '1']);
    const spawn = childProcesses.spawn;
    let calls = 0;
    const intercepted = spyOn(childProcesses, 'spawn').mockImplementation(((
      ...args: Parameters<typeof childProcesses.spawn>
    ) => {
      const options = args[2] as import('node:child_process').SpawnOptions;
      const env = options.env!;
      const overrides = new Map<string, string>();
      for (let index = 0; index < Number(env.GIT_CONFIG_COUNT); index++)
        overrides.set(env[`GIT_CONFIG_KEY_${index}`]!, env[`GIT_CONFIG_VALUE_${index}`]!);
      expect(overrides.get('maintenance.auto')).toBe('false');
      expect(overrides.get('maintenance.autoDetach')).toBe('false');
      expect(overrides.get('gc.auto')).toBe('0');
      expect(overrides.get('gc.autoDetach')).toBe('false');
      calls++;
      return spawn(...args);
    }) as typeof childProcesses.spawn);
    try {
      success(await f.create());
      success(await f.remove());
      expect(calls).toBeGreaterThan(10);
    } finally {
      intercepted.mockRestore();
    }
  });
  test('a broken shared local ref refuses deletion rather than skipping damaged protection evidence', async () => {
    const f = fixture();
    success(await f.create());
    writeFileSync(join(f.source, '.git', 'refs', 'heads', 'broken'), 'not-an-object\n');
    const result = await f.prepareRemove();
    expect(result.businessOutcome).toBe('failed');
    expect(result.details.code).toBe('worktree_verification_failed');
    expect(result.details.mutation).toBe('not_started');
    unlinkSync(join(f.source, '.git', 'refs', 'heads', 'broken'));
    success(await f.remove());
  });
  test('strict porcelain parser rejects malformed boolean and contradictory fields', () => {
    const head = 'a'.repeat(40);
    for (const record of [
      `worktree /example\0bare unexpected\0\0`,
      `worktree /example\0HEAD ${head}\0detached unexpected\0\0`,
      `worktree /example\0bare\0HEAD ${head}\0\0`,
      `worktree /example\0bare\0branch refs/heads/main\0\0`,
      `worktree /example\0bare\0detached\0\0`,
      `worktree relative\0bare\0\0`,
      `worktree /example\0HEAD ${head}\0branch arbitrary\0\0`,
      `worktree /example\0HEAD ${head}\0branch refs/heads/main\0detached\0\0`,
    ])
      expect(() => parseWorktrees(Buffer.from(record), '/')).toThrow();
    expect(
      parseWorktrees(
        Buffer.from(
          `worktree /example\0HEAD ${head}\0detached\0future-field preserved-as-unknown\0\0`,
        ),
        '/',
      )[0]!.detached,
    ).toBe(true);
  });
  test('strict NUL parser rejects corrupt UTF8 and incomplete record', () => {
    expect(() => parseWorktrees(Buffer.from([0xff, 0]), '/')).toThrow('UTF-8');
    expect(() => parseWorktrees(Buffer.from('worktree /tmp\0HEAD abc\0'), '/')).toThrow();
  });
});
