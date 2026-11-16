import { expect, test } from 'bun:test';
import type {
  AgentClient,
  BackgroundExecutionItem,
  OutputFilesPage,
  OutputFileTarget,
} from '@kite-ai/client';
import { NativeInputFiles } from '../electron/input-files';
import { decodeNativeRequest } from '../electron/native-ipc';
import { type NativeOutputScope, NativeOutputSources } from '../electron/output-sources';
import { backgroundItem } from './background-item.fixture';

function fixture() {
  let current: NativeOutputScope | undefined = {
    generation: 1,
    selection: 1,
    storeId: 'store',
    sessionId: 'root',
    subjectId: 'owner',
  };
  const items: BackgroundExecutionItem[] = [];
  for (let i = 1; i <= 3; i++) {
    const item = backgroundItem(i, true);
    const child = i === 3 ? 'a' : i === 2 ? 'b' : 'a';
    item.childSession!.id = child;
    item.childSession!.title = '同名 Agent';
    item.execution.childSessionId = child;
    item.childRun!.sessionId = child;
    item.childRun!.id = `child-run-${i}`;
    item.run!.id = i === 3 ? 'parent-followup' : 'parent-run';
    items.push(item);
  }
  const calls: string[] = [];
  let holdDirectory: Promise<void> | undefined;
  const file = (sessionId: string, runId: string) => ({
    storeId: 'store',
    sessionId,
    ownerRunId: runId,
    fileId: `${sessionId}-${runId}`,
    locator: {
      kind: 'delivery' as const,
      key: `delivery/00000000000000000001/${runId}/${sessionId}`,
    },
    name: 'report.txt',
    mediaType: 'text/plain',
    size: '4',
    publishedAt: '2026-11-16T00:00:00Z',
  });
  let pageOverride: ((page: OutputFilesPage) => OutputFilesPage) | undefined;
  let resolvedRun: string | undefined;
  const client = {
    async listAllBackgroundExecutions(input: { rootSessionId: string }) {
      calls.push(`directory:${input.rootSessionId}`);
      await holdDirectory;
      return structuredClone(items);
    },
    async listBackgroundExecutions(input: { executionId: string; rootSessionId: string }) {
      calls.push(`exact:${input.rootSessionId}/${input.executionId}`);
      return {
        items: structuredClone(items.filter((item) => item.execution.id === input.executionId)),
      };
    },
    async queryOutputFiles(input: {
      scope: { storeId: string; sessionId: string };
      runId?: string;
    }) {
      calls.push(`query:${input.scope.sessionId}/${input.runId}`);
      const runs =
        input.scope.sessionId === 'root'
          ? ['parent-run']
          : items
              .filter((item) => item.childSession?.id === input.scope.sessionId)
              .map((item) => item.childRun!.id);
      const page: OutputFilesPage = {
        scope: input.scope,
        revision: '100',
        items: runs
          .filter((run) => !input.runId || input.runId === run)
          .map((run) => file(input.scope.sessionId, run)),
        collections: [
          {
            collectionId: 'collection/00000000000000000001/producer',
            ownerRunId: input.runId ?? runs[0]!,
            revision: '7',
            state: 'failed',
            expectedCount: 2,
            publishedCount: 1,
            retryUntil: '2099-01-01T00:00:00Z',
          },
        ],
      };
      return pageOverride ? pageOverride(page) : page;
    },
    async resolveOutputFile(target: OutputFileTarget) {
      calls.push(`resolve:${target.sessionId}`);
      const run =
        resolvedRun ??
        items.find((item) => item.childSession?.id === target.sessionId)?.childRun?.id ??
        'parent-run';
      return {
        summary: { ...file(target.sessionId, run), ...target, ownerRunId: run },
        reference: { hash: 'a'.repeat(64), size: '4' },
      };
    },
    async retryOutputCollection(input: { scope: { sessionId: string }; collectionId: string }) {
      calls.push(`retry:${input.scope.sessionId}/${input.collectionId}`);
    },
  } as unknown as AgentClient;
  const owner = new NativeOutputSources(client, () => current);
  return {
    owner,
    calls,
    client,
    items,
    file,
    scope: { storeId: 'store', sessionId: 'root' },
    setCurrent(value: typeof current) {
      current = value;
    },
    getCurrent() {
      return current;
    },
    hold(value?: Promise<void>) {
      holdDirectory = value;
    },
    alterPage(value?: typeof pageOverride) {
      pageOverride = value;
    },
    resolveRun(value?: string) {
      resolvedRun = value;
    },
  };
}

test('original carriers project each child run to its initiating parent turn without basename or latest-child merging', async () => {
  const f = fixture();
  const result = await f.owner.read(1, f.scope);
  expect(
    result.sources.map((source) => [source.sessionId, source.runId, source.parentRunId]),
  ).toEqual([
    ['a', 'child-run-1', 'parent-run'],
    ['b', 'child-run-2', 'parent-run'],
    ['a', 'child-run-3', 'parent-followup'],
  ]);
  expect(result.sources.every((source) => source.name === '同名 Agent')).toBe(true);
  const a = await f.owner.query(1, {
    scope: { storeId: 'store', sessionId: 'a' },
    runId: 'child-run-1',
  });
  const b = await f.owner.query(1, {
    scope: { storeId: 'store', sessionId: 'b' },
    runId: 'child-run-2',
  });
  expect(a.items[0]!.name).toBe(b.items[0]!.name);
  expect(a.items[0]!.fileId).not.toBe(b.items[0]!.fileId);
  expect(a.items[0]!.sessionId).toBe('a');
  f.owner.checkTarget(1, a.items[0]!);
  f.owner.checkTarget(1, b.items[0]!);
  expect(f.calls.some((call) => call.startsWith('retry:'))).toBe(false);
});

test('unrelated roots, foreign stores, unproven child runs and changed exact targets never acquire read access', async () => {
  const f = fixture();
  await f.owner.read(1, f.scope);
  const before = f.calls.length;
  await expect(
    f.owner.query(1, { scope: { storeId: 'store', sessionId: 'foreign' } }),
  ).rejects.toThrow('output_scope_unavailable');
  await expect(
    f.owner.query(1, { scope: { storeId: 'other-store', sessionId: 'a' } }),
  ).rejects.toThrow('output_scope_unavailable');
  await expect(
    f.owner.query(1, { scope: { storeId: 'store', sessionId: 'a' }, runId: 'child-run-2' }),
  ).rejects.toThrow('output_scope_unavailable');
  expect(f.calls).toHaveLength(before);
  const page = await f.owner.query(1, {
    scope: { storeId: 'store', sessionId: 'a' },
    runId: 'child-run-1',
  });
  const target = page.items[0]!;
  expect(() =>
    f.owner.checkTarget(1, {
      ...target,
      locator: { kind: 'legacy-operation', executionId: 'forged' },
    }),
  ).toThrow('output_scope_unavailable');
  expect(() => f.owner.checkTarget(1, { ...target, fileId: 'forged' })).toThrow(
    'output_scope_unavailable',
  );
  f.resolveRun('foreign-run');
  await expect(f.owner.resolve(1, target)).rejects.toThrow('output_scope_unavailable');
});

test('fresh carrier proofs reject changed ancestry, deletion and later work substituted for an earlier source', async () => {
  for (const corrupt of [
    (item: BackgroundExecutionItem) => {
      item.childSession!.parentSessionId = 'other-root';
    },
    (item: BackgroundExecutionItem) => {
      item.childRun!.id = 'replacement-run';
    },
    (item: BackgroundExecutionItem) => {
      item.childSession!.deletedAt = 42;
    },
  ]) {
    const f = fixture();
    await f.owner.read(1, f.scope);
    corrupt(f.items[0]!);
    await expect(
      f.owner.query(1, { scope: { storeId: 'store', sessionId: 'a' }, runId: 'child-run-1' }),
    ).rejects.toThrow('output_source_unavailable');
    expect(f.calls.some((call) => call.startsWith('query:'))).toBe(false);
  }
});

test('cold reads rebuild source admission; selection ABA, disconnected epochs and late directories cannot revive an old read', async () => {
  const f = fixture();
  const page = await f.owner.query(1, {
    scope: { storeId: 'store', sessionId: 'a' },
    runId: 'child-run-1',
  });
  const target = page.items[0]!;
  const check = f.owner.targetCheck(1, target);
  const original = f.getCurrent()!;
  f.setCurrent({ ...original, selection: 2, sessionId: 'other' });
  expect(check).toThrow('output_scope_unavailable');
  f.setCurrent({ ...original, selection: 3 });
  await f.owner.resolve(1, target);
  expect(check).toThrow('output_scope_unavailable');
  f.owner.checkTarget(1, target);
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const reading = f.owner.read(1, f.scope);
  f.owner.reset();
  release();
  await expect(reading).rejects.toThrow('output_scope_unavailable');
  expect(() => f.owner.checkTarget(1, target)).toThrow('output_scope_unavailable');
  f.hold();
  await f.owner.resolve(1, target);
  f.owner.checkTarget(1, target);
});

test('collection retries retain exact child scope/revision and cannot be granted by reading another child', async () => {
  const f = fixture();
  const page = await f.owner.query(1, {
    scope: { storeId: 'store', sessionId: 'a' },
    runId: 'child-run-1',
  });
  const collectionId = page.collections[0]!.collectionId;
  const retry = {
    scope: { storeId: 'store', sessionId: 'a' },
    collectionId,
    expectedRevision: '7',
  };
  await expect(f.owner.retry(1, { ...retry, expectedRevision: '6' })).rejects.toThrow(
    'output_scope_unavailable',
  );
  await expect(
    f.owner.retry(1, { ...retry, scope: { storeId: 'store', sessionId: 'b' } }),
  ).rejects.toThrow('output_scope_unavailable');
  expect(f.calls.some((call) => call.startsWith('retry:'))).toBe(false);
  await f.owner.retry(1, retry);
  expect(f.calls.filter((call) => call.startsWith('retry:'))).toEqual([`retry:a/${collectionId}`]);
  expect(decodeNativeRequest({ method: 'outputs.retry', generation: 1, ...retry })).toMatchObject(
    retry,
  );
  expect(() =>
    decodeNativeRequest({
      method: 'outputs.retry',
      generation: 1,
      ...retry,
      collectionId: '../foreign',
    }),
  ).toThrow();
  expect(
    decodeNativeRequest({ method: 'outputs.sources', generation: 1, scope: f.scope }),
  ).toMatchObject({ scope: f.scope });
  expect(() =>
    decodeNativeRequest({ method: 'outputs.sources', generation: 1, scope: f.scope, path: '/tmp' }),
  ).toThrow();
});

test('warm child retry reacquires its exact paginated collection after selection ABA without reusing a mutation lease', async () => {
  for (const outcome of ['current', 'revised', 'deleted', 'foreign-subject'] as const) {
    const f = fixture();
    const scope = { storeId: 'store', sessionId: 'a' };
    const page = await f.owner.query(1, { scope, runId: 'child-run-1' });
    const collection = page.collections[0]!;
    f.setCurrent({ ...f.getCurrent()!, sessionId: 'other', selection: 2 });
    f.setCurrent({
      ...f.getCurrent()!,
      sessionId: 'root',
      selection: 3,
      ...(outcome === 'foreign-subject' ? { subjectId: 'other-user' } : {}),
    });
    if (outcome === 'deleted') f.items[0]!.childSession!.deletedAt = 42;
    const pages: (string | undefined)[] = [];
    f.client.queryOutputFiles = async (input) => {
      pages.push(input.collectionBeforeKey);
      expect(input.scope).toEqual(scope);
      expect(input.runId).toBe('child-run-1');
      return {
        ...page,
        collections: input.collectionBeforeKey
          ? [{ ...collection, revision: outcome === 'revised' ? '8' : '7' }]
          : [{ ...collection, collectionId: 'collection/00000000000000000001/newer' }],
        ...(input.collectionBeforeKey
          ? {}
          : { nextCollectionCursor: 'collection/00000000000000000001/newer' }),
      };
    };
    const retry = f.owner.retry(1, {
      scope,
      collectionId: collection.collectionId,
      expectedRevision: '7',
    });
    if (outcome === 'current') {
      await retry;
      expect(pages).toEqual([undefined, 'collection/00000000000000000001/newer']);
      expect(f.calls.filter((call) => call.startsWith('retry:'))).toEqual([
        `retry:a/${collection.collectionId}`,
      ]);
    } else {
      await expect(retry).rejects.toThrow(/output_(?:scope|source)_unavailable/);
      expect(f.calls.some((call) => call.startsWith('retry:'))).toBe(false);
      if (outcome !== 'revised') expect(pages).toEqual([]);
    }
  }
});

test('warm retry covers all 8192 retained collections and rejects cyclic, changing or overlong pages', async () => {
  for (const outcome of ['deep', 'cycle', 'changing', 'overlong']) {
    const f = fixture();
    const scope = { storeId: 'store', sessionId: 'a' };
    const page = await f.owner.query(1, { scope, runId: 'child-run-1' });
    const collection = page.collections[0]!;
    f.setCurrent({ ...f.getCurrent()!, selection: 3 });
    let reads = 0;
    f.client.queryOutputFiles = async (input) => {
      reads++;
      expect(input.limit).toBe(50);
      const offset = Number(input.collectionBeforeKey ?? 0);
      return {
        ...page,
        revision: outcome === 'changing' ? String(reads) : page.revision,
        collections: Array.from({ length: 50 }, (_, i) => ({
          ...collection,
          collectionId:
            outcome === 'deep' && offset + i === 8191
              ? collection.collectionId
              : `other-${offset + i}`,
        })),
        nextCollectionCursor: String(outcome === 'cycle' ? 50 : offset + 50),
      };
    };
    const retry = f.owner.retry(1, {
      scope,
      collectionId: collection.collectionId,
      expectedRevision: '7',
    });
    if (outcome === 'deep') {
      await retry;
      expect(reads).toBe(164);
      expect(f.calls.filter((call) => call.startsWith('retry:'))).toHaveLength(1);
    } else {
      await expect(retry).rejects.toThrow(
        /output_(?:scope_unavailable|source_observation_changed)/,
      );
      expect(reads).toBe(outcome === 'overlong' ? 164 : 2);
      expect(f.calls.some((call) => call.startsWith('retry:'))).toBe(false);
    }
  }
});

test('a mismatched single-source page is never relabeled as a parent delivery', async () => {
  const f = fixture();
  f.alterPage((page) => ({
    ...page,
    items: page.items.map((file) => ({ ...file, sessionId: 'root' })),
  }));
  await expect(
    f.owner.query(1, { scope: { storeId: 'store', sessionId: 'a' }, runId: 'child-run-1' }),
  ).rejects.toThrow('output_source_unavailable');
  expect(() => f.owner.checkTarget(1, f.file('a', 'child-run-1'))).toThrow(
    'output_scope_unavailable',
  );
});

test('explicit edit imports the original child snapshot into the parent and rechecks admission before cached publications are reused', async () => {
  const f = fixture();
  const inputs = new NativeInputFiles();
  const target = f.file('a', 'child-run-1');
  const imports: unknown[] = [];
  f.client.prepareInputFromOutput = async (input) => {
    imports.push(input);
    return { name: 'report.txt', uri: 'input-file:original' };
  };
  inputs.fromOutput('chip', target, 'report.txt');
  const verify = (source: OutputFileTarget) => f.owner.resolve(1, source);
  await inputs.publish(f.client, 'store', 'root', ['chip'], verify);
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({ source: target, targetSessionId: 'root' });
  f.items.splice(0, 1);
  await expect(inputs.publish(f.client, 'store', 'root', ['chip'], verify)).rejects.toThrow(
    'output_source_unavailable',
  );
  expect(imports).toHaveLength(1);
  await inputs.close();
});

test('out-of-order same-scope directory responses cannot overwrite a newer complete source catalog', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  f.client.listAllBackgroundExecutions = async () => {
    const snapshot = structuredClone(f.items);
    if (++calls === 1) await gate;
    return snapshot;
  };
  const old = f.owner.read(1, f.scope);
  f.items.splice(0, 1);
  const current = await f.owner.read(1, f.scope);
  expect(current.sources).toHaveLength(2);
  release();
  await expect(old).rejects.toThrow('output_source_observation_changed');
  const before = f.calls.length;
  await expect(
    f.owner.query(1, { scope: { storeId: 'store', sessionId: 'a' }, runId: 'child-run-1' }),
  ).rejects.toThrow('output_scope_unavailable');
  expect(f.calls).toHaveLength(before);
});
