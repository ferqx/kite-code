import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, type watch } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Workspace } from '@kite-ai/client';
import { afterEach, expect, test } from '#kite-test';
import { NativeProcessOwner } from '../../electron/native-processes';
import { NativeWorkspaceChanges } from '../../electron/workspace-changes';
import type { NativeWorkspaceChangeEvent } from '../../src/workspace-changes-bridge';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});
async function setup(
  repository = true,
  watchOptions?: ConstructorParameters<typeof NativeWorkspaceChanges>[5],
) {
  const root = await mkdtemp(join(tmpdir(), 'kite-workspace-changes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
  if (repository) {
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  }
  let scope = {
    generation: 1,
    viewSelection: 1,
    storeId: 'store',
    sessionId: 'session',
    workspaceId: 'workspace',
  };
  const processes = new NativeProcessOwner();
  cleanup.push(() => processes.close());
  const events: NativeWorkspaceChangeEvent[] = [];
  const owner = new NativeWorkspaceChanges(
    () => scope,
    () => ({ rootUri: pathToFileURL(root).href }) as Workspace,
    [],
    processes,
    (event) => events.push(event),
    watchOptions,
  );
  cleanup.push(async () => owner.release());
  const list = () => owner.list({ generation: 1, viewSelection: 1, readId: 'read' });
  return {
    root,
    events,
    git,
    owner,
    list,
    changeSelection: () => {
      scope = { ...scope, viewSelection: 2 };
    },
  };
}
test('HEAD to final workspace includes staged, unstaged, untracked, deletion and rename', async () => {
  const f = await setup();
  for (const name of ['mixed', 'deleted', 'renamed', 'cancelled'])
    await writeFile(join(f.root, name), 'original\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  await writeFile(join(f.root, 'mixed'), 'staged\n');
  await writeFile(join(f.root, 'cancelled'), 'staged\n');
  f.git('add', '.');
  await writeFile(join(f.root, 'mixed'), 'final\n');
  await writeFile(join(f.root, 'cancelled'), 'original\n');
  await rm(join(f.root, 'deleted'));
  await rename(join(f.root, 'renamed'), join(f.root, 'new-name'));
  f.git('add', 'renamed', 'new-name');
  await writeFile(join(f.root, 'odd\nname\t.txt'), 'untracked\n');
  const page = await f.list();
  expect(page.repository).toBe(true);
  expect(page.truncated).toBe(false);
  const mixed = page.entries.find((e) => e.path === 'mixed')!;
  expect(mixed.indexStatus).toBe('M');
  expect(mixed.worktreeStatus).toBe('M');
  const patch = await f.owner.detail('read', mixed.changeId);
  expect(patch.text).toContain('-original');
  expect(patch.text).toContain('+final');
  expect(patch.text).not.toContain('+staged');
  const cancelled = page.entries.find((e) => e.path === 'cancelled')!;
  expect((await f.owner.detail('read', cancelled.changeId)).text).toBe('');
  expect(
    (await f.owner.detail('read', page.entries.find((e) => e.path === 'deleted')!.changeId)).text,
  ).toContain('-original');
  const renamed = page.entries.find((e) => e.path === 'new-name')!;
  expect(renamed.oldPath).toBe('renamed');
  expect((await f.owner.detail('read', renamed.changeId)).text).toContain('+original');
  const odd = page.entries.find((e) => e.untracked)!;
  expect(odd.path).toBe('odd\nname\t.txt');
  expect((await f.owner.detail('read', odd.changeId)).text).toContain('+untracked');
});
test('bounded content, binary and symlink are explicit; closed and changed selection reject', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'large'), 'a'.repeat(1048577));
  await writeFile(join(f.root, 'binary'), Buffer.from([0, 1]));
  await symlink('/etc/passwd', join(f.root, 'link'));
  const page = await f.list();
  for (const [path, reason] of [
    ['large', 'too_large'],
    ['binary', 'binary'],
    ['link', 'unsupported'],
  ] as const)
    expect(
      (await f.owner.detail('read', page.entries.find((e) => e.path === path)!.changeId)).reason,
    ).toBe(reason);
  f.changeSelection();
  await expect(f.owner.detail('read', page.entries[0]!.changeId)).rejects.toThrow(
    'workspace_changes_stale',
  );
  f.owner.close('read');
  await expect(f.owner.detail('read', page.entries[0]!.changeId)).rejects.toThrow();
});
test('unborn repository shows additions', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'new'), 'hello\n');
  f.git('add', '.');
  const page = await f.list();
  expect((await f.owner.detail('read', page.entries[0]!.changeId)).text).toContain('+hello');
});
test('subdirectory selection covers repository; broad protected root rejected', async () => {
  const f = await setup();
  await mkdir(join(f.root, 'project'));
  await writeFile(join(f.root, 'outside-project'), 'yes');
  const scope = { generation: 1, viewSelection: 1, storeId: 's', sessionId: 's', workspaceId: 'w' };
  const workspace = () => ({ rootUri: pathToFileURL(join(f.root, 'project')).href }) as Workspace;
  const owner = new NativeWorkspaceChanges(() => scope, workspace, []);
  cleanup.push(async () => owner.release());
  expect(
    (await owner.list({ generation: 1, viewSelection: 1, readId: 'r' })).entries[0]?.path,
  ).toBe('outside-project');
  const protectedOwner = new NativeWorkspaceChanges(() => scope, workspace, [
    join(f.root, 'private'),
  ]);
  await expect(
    protectedOwner.list({ generation: 1, viewSelection: 1, readId: 'r' }),
  ).rejects.toThrow('workspace_changes_protected_root');
});

test('refresh revokes old IDs and explicit close cancels pending metadata', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'a'), 'one');
  const first = await f.list();
  const oldId = first.entries[0]!.changeId;
  await f.list();
  await expect(f.owner.detail('read', oldId)).rejects.toThrow('workspace_changes_stale');
  const pending = f.list();
  f.owner.close('read');
  await expect(pending).rejects.toThrow('workspace_changes_stale');
});

test('bounded metadata and preview report omissions rather than a clean repository', async () => {
  const f = await setup();
  await Promise.all(
    Array.from({ length: 1002 }, (_, i) => writeFile(join(f.root, `file-${i}`), 'x')),
  );
  const page = await f.list();
  expect(page.entries.length).toBe(1000);
  expect(page.truncated).toBe(true);
  await writeFile(join(f.root, 'file-0'), 'line\n'.repeat(20000));
  const detail = await f.owner.detail(
    'read',
    page.entries.find((e) => e.path === 'file-0')!.changeId,
  );
  expect(detail.truncated).toBe(true);
  expect(detail.text!.length).toBeLessThanOrEqual(65536);
});

test('broken repository is an error, never an empty clean result', async () => {
  const f = await setup(false);
  await mkdir(join(f.root, '.git'));
  await expect(f.list()).rejects.toThrow('workspace_changes_unavailable');
});

test('HEAD change invalidates a previously listed detail', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'a'), 'original');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  await writeFile(join(f.root, 'a'), 'changed');
  const page = await f.list();
  f.git('add', '.');
  f.git('commit', '-m', 'next');
  await expect(f.owner.detail('read', page.entries[0]!.changeId)).rejects.toThrow(
    'workspace_changes_stale',
  );
});

test('independent detail IDs close and switch without retiring the list', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'a'), 'hello');
  const page = await f.list();
  const id = page.entries[0]!.changeId;
  expect((await f.owner.detail('detail-1', id)).text).toContain('+hello');
  f.owner.close('detail-1');
  const pending = f.owner.detail('detail-2', id);
  f.owner.close('detail-2');
  await expect(pending).rejects.toThrow('workspace_changes_stale');
  expect((await f.owner.detail('detail-3', id)).text).toContain('+hello');
  const stale = f.owner.detail('detail-4', id);
  const fresh = f.list();
  await expect(stale).rejects.toThrow('workspace_changes_stale');
  await fresh;
  await expect(f.owner.detail('detail-5', id)).rejects.toThrow('workspace_changes_stale');
});

test('untracked empty files and missing final newline retain exact line facts', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'empty'), '');
  await writeFile(join(f.root, 'no-newline'), 'text');
  const page = await f.list();
  const empty = await f.owner.detail(
    'empty',
    page.entries.find((e) => e.path === 'empty')!.changeId,
  );
  expect(empty.text).toBe('--- /dev/null\n+++ "b/empty"\n');
  const text = await f.owner.detail(
    'text',
    page.entries.find((e) => e.path === 'no-newline')!.changeId,
  );
  expect(text.text).toContain('@@ -0,0 +1,1 @@\n+text\n\\ No newline at end of file\n');
});

test('untracked Unicode previews drop incomplete UTF-8 at every cap boundary', async () => {
  const f = await setup();
  const header = '--- /dev/null\n+++ "b/unicode"\n@@ -0,0 +1,1 @@\n+';
  for (const char of ['界', '🙂']) {
    for (let bytes = 1; bytes < Buffer.byteLength(char); bytes++) {
      const prefix = 'a'.repeat(65536 - Buffer.byteLength(header) - bytes);
      await writeFile(join(f.root, 'unicode'), `${prefix}${char}tail`);
      const page = await f.list();
      const detail = await f.owner.detail('unicode', page.entries[0]!.changeId);
      expect(detail.truncated).toBe(true);
      expect(detail.text).toBe(header + prefix);
      expect(Buffer.byteLength(detail.text!)).toBeLessThanOrEqual(65536);
    }
  }
});

test('Git diff Unicode truncation never adds a replacement character', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'unicode'), 'base\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  for (let padding = 0; padding < 4; padding++) {
    await writeFile(join(f.root, 'unicode'), `${'a'.repeat(padding)}${'🙂'.repeat(20000)}\n`);
    const full = f.git(
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-color',
      '--unified=3',
      'HEAD',
      '--',
      'unicode',
    );
    const page = await f.list();
    const detail = await f.owner.detail('unicode', page.entries[0]!.changeId);
    expect(detail.truncated).toBe(true);
    expect(detail.text).not.toContain('\uFFFD');
    expect(full.startsWith(detail.text!)).toBe(true);
    expect(Buffer.byteLength(detail.text!)).toBeLessThanOrEqual(65536);
    expect(Buffer.byteLength(detail.text!)).toBeGreaterThanOrEqual(65533);
  }
});

test('AA and DD unmerged index states have explicitly unsupported previews', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'conflict'), 'base\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  const blob = f.git('rev-parse', 'HEAD:conflict').trim();
  for (const stages of [[2, 3], [1]]) {
    f.git('update-index', '--force-remove', 'conflict');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: f.root,
      input: stages.map((stage) => `100644 ${blob} ${stage}\tconflict\n`).join(''),
    });
    const page = await f.list();
    const entry = page.entries.find((e) => e.path === 'conflict')!;
    expect(entry.indexStatus + entry.worktreeStatus).toBe(stages.length === 2 ? 'AA' : 'DD');
    expect((await f.owner.detail('conflict', entry.changeId)).reason).toBe('unsupported');
  }
});

test('intent-to-add is a workspace addition with an absent HEAD path', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'base'), 'base');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  await writeFile(join(f.root, 'intent'), 'not staged\n');
  f.git('add', '-N', 'intent');
  const page = await f.list();
  const entry = page.entries.find((e) => e.path === 'intent')!;
  expect(entry.indexStatus).toBe(' ');
  expect(entry.worktreeStatus).toBe('A');
  expect((await f.owner.detail('intent', entry.changeId)).text).toContain('+not staged');
});

test('configured clean/process filters are refused without executing repository programs', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'file'), 'base\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  await writeFile(join(f.root, '.gitattributes'), 'file filter=malicious\n');
  const marker = join(f.root, 'filter-ran');
  for (const type of ['clean', 'process']) {
    f.git('config', `filter.malicious.${type}`, `echo unsafe > '${marker}'; cat`);
    await writeFile(join(f.root, 'file'), `${type}\n`);
    await expect(f.list()).rejects.toThrow('workspace_changes_filters_unsupported');
    expect(existsSync(marker)).toBe(false);
    f.git('config', '--unset', `filter.malicious.${type}`);
  }
});

test('filter configuration introduced after a list cannot execute during detail', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'file'), 'base\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  await writeFile(join(f.root, 'file'), 'changed\n');
  const page = await f.list();
  await writeFile(join(f.root, '.gitattributes'), 'file filter=malicious\n');
  const marker = join(f.root, 'filter-ran');
  f.git('config', 'filter.malicious.clean', `echo unsafe > '${marker}'; cat`);
  await expect(f.owner.detail('detail', page.entries[0]!.changeId)).rejects.toThrow(
    'workspace_changes_filters_unsupported',
  );
  expect(
    await import('node:fs/promises').then((fs) =>
      fs.stat(marker).then(
        () => true,
        () => false,
      ),
    ),
  ).toBe(false);
});

test('split index is explicitly unsupported rather than an incorrect clean result', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'file'), 'base');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  f.git('update-index', '--split-index');
  await expect(f.list()).rejects.toThrow('workspace_changes_split_index_unsupported');
});

test('shadow Git blocks filters introduced after preflight, and retired snapshots are removed', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'file'), 'base\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  await writeFile(join(f.root, '.gitattributes'), 'file filter=malicious\n');
  await writeFile(join(f.root, 'file'), 'changed\n');
  const marker = join(f.root, 'filter-ran');
  const snapshots = new Set<string>();
  let inject = 'status';
  const processes = new NativeProcessOwner((command, args, options) => {
    if (options.env?.GIT_DIR) snapshots.add(options.env.GIT_DIR);
    if (args.includes(inject))
      f.git('config', 'filter.malicious.clean', `echo unsafe > '${marker}'; cat`);
    return spawn(command, [...args], options);
  });
  cleanup.push(() => processes.close());
  const scope = { generation: 1, viewSelection: 1, storeId: 's', sessionId: 's', workspaceId: 'w' };
  const owner = new NativeWorkspaceChanges(
    () => scope,
    () => ({ rootUri: pathToFileURL(f.root).href }) as Workspace,
    [],
    processes,
  );
  cleanup.push(async () => owner.release());
  await expect(owner.list({ generation: 1, viewSelection: 1, readId: 'list' })).rejects.toThrow(
    'workspace_changes_filters_unsupported',
  );
  expect(existsSync(marker)).toBe(false);
  expect(snapshots.size).toBe(1);
  f.git('config', '--unset', 'filter.malicious.clean');
  inject = 'none';
  const page = await owner.list({ generation: 1, viewSelection: 1, readId: 'list2' });
  inject = 'diff';
  const detail = await owner.detail(
    'detail',
    page.entries.find((e) => e.path === 'file')!.changeId,
  );
  expect(detail.text).toContain('+changed');
  expect(existsSync(marker)).toBe(false);
  owner.release();
  for (let i = 0; i < 100 && [...snapshots].some(existsSync); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect([...snapshots].some(existsSync)).toBe(false);
});

test('source info attributes are explicitly unsupported instead of silently ignored', async () => {
  const f = await setup();
  await writeFile(join(f.root, '.git', 'info', 'attributes'), '*.txt text\n');
  await expect(f.list()).rejects.toThrow('workspace_changes_attributes_unsupported');
});

test('shadow status preserves source info exclude and configured global excludes', async () => {
  const f = await setup();
  await writeFile(join(f.root, '.git', 'info', 'exclude'), 'local-hidden\n');
  const excludes = join(f.root, '.git', 'custom-excludes');
  await writeFile(excludes, 'global-hidden\n');
  f.git('config', 'core.excludesfile', excludes);
  for (const name of ['local-hidden', 'global-hidden', 'visible'])
    await writeFile(join(f.root, name), 'x');
  const page = await f.list();
  expect(page.entries.map((e) => e.path)).toEqual(['visible']);
});

async function until(predicate: () => boolean, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw Error('notification timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test('watch invalidates worktree creation, rename, deletion and Git index with current lease only', async () => {
  const f = await setup();
  await f.list();
  for (const change of [
    () => writeFile(join(f.root, 'new-file'), 'new'),
    () => rename(join(f.root, 'new-file'), join(f.root, 'renamed')),
    () => rm(join(f.root, 'renamed')),
    async () => {
      f.git('read-tree', '--empty');
    },
  ]) {
    const count = f.events.length;
    await change();
    await until(() => f.events.length > count);
    expect(f.events.at(-1)).toEqual({
      kind: 'workspaceChanges.changed',
      generation: 1,
      readId: 'read',
      scope: {
        generation: 1,
        viewSelection: 1,
        storeId: 'store',
        sessionId: 'session',
        workspaceId: 'workspace',
      },
    });
  }
  f.owner.close('read');
  const count = f.events.length;
  await writeFile(join(f.root, 'closed'), 'closed');
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(f.events.length).toBe(count);
});
test('linked worktree observes its own index and common HEAD refs', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'file'), 'base');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  const linked = join(f.root, 'linked');
  f.git('worktree', 'add', '-b', 'linked-branch', linked);
  const events: NativeWorkspaceChangeEvent[] = [];
  const scope = {
    generation: 1,
    viewSelection: 1,
    storeId: 'store',
    sessionId: 'session',
    workspaceId: 'workspace',
  };
  const owner = new NativeWorkspaceChanges(
    () => scope,
    () => ({ rootUri: pathToFileURL(linked).href }) as Workspace,
    [],
    undefined,
    (event) => events.push(event),
  );
  cleanup.push(async () => owner.release());
  await owner.list({ generation: 1, viewSelection: 1, readId: 'linked' });
  execFileSync('git', ['read-tree', '--empty'], { cwd: linked });
  await until(() => events.length > 0);
  const count = events.length;
  f.git('update-ref', 'refs/heads/linked-branch', f.git('rev-parse', 'HEAD').trim());
  await until(() => events.length > count);
  expect(events.every((event) => event.readId === 'linked')).toBe(true);
});
test('watch bursts have max wait, failures fall back, and stale selection tears down', async () => {
  const callbacks: (() => void)[] = [];
  const watchers: (EventEmitter & { close: () => void })[] = [];
  let closed = 0;
  const fakeWatch = ((_path: string, _options: unknown, callback: () => void) => {
    callbacks.push(callback);
    const watcher = Object.assign(new EventEmitter(), {
      close: () => {
        closed++;
      },
    });
    watchers.push(watcher);
    return watcher;
  }) as unknown as typeof watch;
  const f = await setup(true, {
    watch: fakeWatch,
    recursive: true,
    debounceMs: 50,
    maxWaitMs: 90,
    fallbackMs: 100,
  });
  await f.list();
  const burst = setInterval(() => callbacks[0]!(), 10);
  try {
    await until(() => f.events.length > 0);
  } finally {
    clearInterval(burst);
  }
  expect(f.events.length).toBeGreaterThan(0);
  const count = f.events.length;
  watchers[0]!.emit('error', Error('watch unavailable'));
  await until(() => f.events.length > count + 1);
  f.changeSelection();
  await until(() => closed >= watchers.length);
  const stale = f.events.length;
  callbacks[0]!();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(f.events.length).toBe(stale);
});
test('unsupported watcher fallback retires on list replacement and release', async () => {
  const f = await setup(true, {
    watch: (() => {
      throw Error('unsupported');
    }) as unknown as typeof watch,
    recursive: true,
    fallbackMs: 30,
    debounceMs: 5,
    maxWaitMs: 20,
  });
  await f.list();
  await until(() => f.events.length > 0);
  await f.owner.list({ generation: 1, viewSelection: 1, readId: 'replacement' });
  const start = f.events.length;
  await until(() => f.events.length > start);
  expect(f.events.slice(start).every((event) => event.readId === 'replacement')).toBe(true);
  f.owner.release();
  const count = f.events.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.events.length).toBe(count);
});
test('index removal plus untracked same path is one HEAD-to-current entry', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'file'), 'original\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  f.git('rm', '--cached', 'file');
  let page = await f.list();
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]).toMatchObject({ path: 'file', indexStatus: 'D', untracked: true });
  expect((await f.owner.detail('same', page.entries[0]!.changeId)).text).toBe('');
  await writeFile(join(f.root, 'file'), 'current\n');
  page = await f.list();
  const detail = await f.owner.detail('changed', page.entries[0]!.changeId);
  expect(detail.text).toContain('-original');
  expect(detail.text).toContain('+current');
  expect(f.git('status', '--porcelain')).toBe('D  file\n?? file\n');
});
test('watch changes during initial read are delivered after readiness; healthy idle does not poll', async () => {
  let callback: ((_event: string, filename: string) => void) | undefined;
  const fakeWatch = ((_path: string, _options: unknown, changed: typeof callback) => {
    callback ??= changed;
    return Object.assign(new EventEmitter(), { close() {} });
  }) as unknown as typeof watch;
  const f = await setup(true, {
    watch: fakeWatch,
    recursive: true,
    debounceMs: 5,
    maxWaitMs: 10,
    fallbackMs: 20,
  });
  const listing = f.list();
  await until(() => callback !== undefined);
  callback!('change', 'file');
  expect(f.events).toHaveLength(0);
  await listing;
  await until(() => f.events.length === 1);
  callback!('change', '.git/objects/aa/bb');
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(f.events).toHaveLength(1);
});
