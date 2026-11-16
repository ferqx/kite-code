import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Workspace } from '@kite-ai/client';
import { NativeProcessOwner } from '../../electron/native-processes';
import { NativeWorkspaceChanges } from '../../electron/workspace-changes';
import type { NativeWorkspaceChangeEvent } from '../../src/workspace-changes-bridge';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kite-current-root-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    target = join(root, 'target');
  await mkdir(source);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Execution root fixture');
  await writeFile(join(source, 'same.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'base');
  git('worktree', 'add', '--detach', target, 'HEAD');
  await writeFile(join(source, 'same.txt'), 'source content\n');
  await writeFile(join(target, 'same.txt'), 'target content\n');
  const scope = {
    generation: 1,
    viewSelection: 1,
    storeId: 'store',
    sessionId: 'session',
    workspaceId: 'workspace',
  };
  let selected = { rootUri: pathToFileURL(source).href, revision: '0' };
  let read: (signal: AbortSignal) => Promise<typeof selected> = async () => selected;
  const processes = new NativeProcessOwner();
  cleanup.push(() => processes.close());
  const events: NativeWorkspaceChangeEvent[] = [];
  const owner = new NativeWorkspaceChanges(
    () => scope,
    () => ({ rootUri: pathToFileURL(source).href }) as Workspace,
    [],
    processes,
    (event) => events.push(event),
    {},
    async (requested, signal) => {
      expect(requested).toMatchObject(scope);
      return read(signal);
    },
  );
  cleanup.push(async () => owner.release());
  return {
    owner,
    events,
    scope,
    source,
    target,
    current: () => selected,
    list: (readId = 'list') => owner.list({ generation: 1, viewSelection: 1, readId }),
    select(path: string, revision: string, notify = true) {
      selected = { rootUri: pathToFileURL(path).href, revision };
      if (notify) owner.invalidateExecutionRoot();
    },
    readWith(value: typeof read) {
      read = value;
    },
  };
}

test('session use and exit read the selected worktree while workspace membership stays fixed', async () => {
  const f = await fixture();
  const initial = await f.list();
  const entry = initial.entries[0]!;
  expect((await f.owner.detail('source-detail', entry.changeId)).text).toContain('+source content');
  f.select(f.target, '1');
  expect(f.events.at(-1)).toMatchObject({ reset: true, readId: 'list', scope: f.scope });
  await expect(f.owner.detail('stale-source', entry.changeId)).rejects.toThrow(
    'workspace_changes_stale',
  );
  const worktree = await f.list('worktree-list');
  expect(worktree.scope).toEqual(initial.scope);
  const targetText = (await f.owner.detail('target-detail', worktree.entries[0]!.changeId)).text;
  expect(targetText).toContain('+target content');
  expect(targetText).not.toContain('+source content');
  f.select(f.source, '2');
  await expect(f.owner.detail('stale-target', worktree.entries[0]!.changeId)).rejects.toThrow(
    'workspace_changes_stale',
  );
  const returned = await f.list('returned-list');
  expect(returned.scope).toEqual(initial.scope);
  expect((await f.owner.detail('returned-detail', returned.entries[0]!.changeId)).text).toContain(
    '+source content',
  );
});

test('A to B to A while detail is reading rejects the old epoch even before the event arrives', async () => {
  const f = await fixture();
  const page = await f.list();
  let reads = 0;
  f.readWith(async () => {
    if (++reads === 2) {
      f.select(f.target, '1', false);
      f.select(f.source, '2', false);
    }
    return f.current();
  });
  await expect(f.owner.detail('detail', page.entries[0]!.changeId)).rejects.toThrow(
    'workspace_changes_stale',
  );
  expect(f.events.at(-1)).toMatchObject({ reset: true, readId: 'list' });
  await expect(f.owner.detail('old-entry', page.entries[0]!.changeId)).rejects.toThrow(
    'workspace_changes_stale',
  );
});

test('root invalidation aborts an in-flight list and cannot publish its late result', async () => {
  const f = await fixture();
  const original = f.current();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  let signal!: AbortSignal;
  f.readWith(async (abort) => {
    if (first) {
      first = false;
      signal = abort;
      entered();
      await gate;
      return original;
    }
    return f.current();
  });
  const pending = f.list('old-list');
  await started;
  f.select(f.target, '1');
  expect(signal.aborted).toBe(true);
  const fresh = await f.list('new-list');
  release();
  await expect(pending).rejects.toThrow('workspace_changes_stale');
  expect((await f.owner.detail('new-detail', fresh.entries[0]!.changeId)).text).toContain(
    '+target content',
  );
});

test('an unavailable trusted execution root never falls back to the source workspace', async () => {
  const f = await fixture();
  f.readWith(async () => {
    throw Error('execution_root_changed');
  });
  await expect(f.list()).rejects.toThrow('execution_root_changed');
  f.readWith(async () => f.current());
  const page = await f.list('recovered');
  expect((await f.owner.detail('detail', page.entries[0]!.changeId)).text).toContain(
    '+source content',
  );
});

test('a refreshed list that first discovers a new root resets same-path cached content', async () => {
  const f = await fixture();
  await f.list();
  f.owner.release();
  f.select(f.target, '1', false);
  await expect(f.list('refresh')).rejects.toThrow('workspace_changes_stale');
  expect(f.events.at(-1)).toMatchObject({ reset: true, readId: 'refresh' });
  const page = await f.list('after-reset');
  expect((await f.owner.detail('detail', page.entries[0]!.changeId)).text).toContain(
    '+target content',
  );
});

test('a root change replayed after disconnect still resets the previous displayed root', async () => {
  const f = await fixture();
  await f.list();
  f.owner.release();
  f.select(f.target, '1');
  await expect(f.list('reconnected')).rejects.toThrow('workspace_changes_stale');
  expect(f.events.at(-1)).toMatchObject({ reset: true, readId: 'reconnected' });
  const page = await f.list('after-reset');
  expect((await f.owner.detail('detail', page.entries[0]!.changeId)).text).toContain(
    '+target content',
  );
});
