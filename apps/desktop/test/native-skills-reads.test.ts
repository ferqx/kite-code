import { expect, test } from 'bun:test';
import type { AgentClient, SkillCataloguePage } from '@kite-ai/client';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';
import { NativeSkillCatalogueReads } from '../electron/skill-catalogue-reads';
import type { NativeBridge, NativeSkillsScope } from '../src/native-bridge';
import { readNativeSkillCatalogue } from '../src/native-skills';

const originalScope: NativeSkillsScope = {
  generation: 1,
  viewSelection: 2,
  historyEpoch: 0,
  storeId: 'store',
  sessionId: 'session',
  workspaceId: 'workspace',
};
const entries: SkillCataloguePage['entries'] = Array.from({ length: 301 }, (_, index) => ({
  id: `skill-${String(index).padStart(3, '0')}`,
  name: `Skill ${index}`,
  description: `原摘要 ${index}`,
  source: { scope: 'project', origin: '.agents' },
  version: 'a'.repeat(64),
  enabled: true,
  state: 'available',
  reason: null,
  requiredCapabilities: [],
  missingCapabilities: [],
}));
const page = (rows: SkillCataloguePage['entries'], complete = true): SkillCataloguePage => ({
  version: 1,
  storeId: 'store',
  workspaceId: 'workspace',
  revision: 'b'.repeat(64),
  availability: 'available',
  reason: null,
  entries: rows,
  complete,
  nextAfterId: complete ? null : rows.at(-1)!.id,
});
const client = (listSkills: AgentClient['listSkills']) =>
  ({ serverInfo: { capabilities: ['skill_catalogue'] }, listSkills }) as unknown as AgentClient;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Main owns the fixed-revision pagination and renderer exhausts the original workspace without a total cap', async () => {
  const calls: { workspaceId: string; options: Parameters<AgentClient['listSkills']>[1] }[] = [];
  const reads = new NativeSkillCatalogueReads(
    client(async (workspaceId, options) => {
      calls.push({ workspaceId, options });
      const start = options.afterId
        ? entries.findIndex((item) => item.id === options.afterId) + 1
        : 0;
      return page(entries.slice(start, start + 37), start + 37 >= entries.length);
    }),
    () => originalScope,
  );
  const bridge = {
    request: async (request) => {
      switch (request.method) {
        case 'settings.skills.open':
          return reads.open(request);
        case 'settings.skills.next':
          return reads.next(request.readId);
        case 'settings.skills.close':
          reads.close(request.readId);
          return null;
        default:
          throw Error('unexpected_business_operation');
      }
    },
  } as NativeBridge;
  const all = await readNativeSkillCatalogue({
    bridge,
    scope: originalScope,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(all.entries).toEqual(entries);
  expect(all.complete).toBe(true);
  expect(all.nextAfterId).toBeNull();
  expect(calls).toHaveLength(9);
  expect(
    calls.every(
      (call) =>
        call.workspaceId === originalScope.workspaceId &&
        call.options.storeId === originalScope.storeId &&
        call.options.byteLimit === 131072,
    ),
  ).toBe(true);
  expect(
    calls.slice(1).every((call) => call.options.revision === all.revision && call.options.afterId),
  ).toBe(true);
  expect(calls.every((call) => call.options.signal?.aborted)).toBe(true);
  await expect(reads.next('expired')).rejects.toMatchObject({
    code: 'skill_catalogue_read_missing',
  });
});

test('close during a pending controller refresh aborts the already admitted read and no late open can bind a new selection', async () => {
  const refresh = deferred<void>(),
    response = deferred<SkillCataloguePage>();
  let scope = { ...originalScope },
    signal: AbortSignal | undefined,
    getCount = 0;
  const reads = new NativeSkillCatalogueReads(
    client(async (_workspace, options) => {
      getCount++;
      signal = options.signal;
      return response.promise;
    }),
    () => scope,
  );
  const caller = Object.assign(Object.create(NativeCaller.prototype), {
    generation: 1,
    closed: false,
    refreshing: refresh.promise,
    skills: reads,
  }) as NativeCaller;
  const opened = caller.invoke({
    method: 'settings.skills.open',
    generation: 1,
    readId: 'original',
    viewSelection: 2,
    historyEpoch: 0,
  });
  const rejected = opened.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(getCount).toBe(1);
  await caller.invoke({ method: 'settings.skills.close', generation: 1, readId: 'original' });
  expect(signal?.aborted).toBe(true);
  scope = { ...scope, viewSelection: 3, sessionId: 'other' };
  refresh.resolve();
  response.resolve(page(entries.slice(0, 1)));
  expect(await rejected).toMatchObject({ code: 'skill_catalogue_view_changed' });
  expect(getCount).toBe(1);
  await expect(
    caller.invoke({
      method: 'settings.skills.open',
      generation: 1,
      readId: 'late',
      viewSelection: 2,
      historyEpoch: 0,
    }),
  ).rejects.toMatchObject({ code: 'native_selection_changed' });
  expect(getCount).toBe(1);
});

test('refresh replaces only its own lease; old close and a late page cannot change the new facts', async () => {
  const late = deferred<SkillCataloguePage>();
  let request = 0;
  const signals: AbortSignal[] = [];
  const reads = new NativeSkillCatalogueReads(
    client(async (_workspace, options) => {
      signals.push(options.signal!);
      request++;
      return request === 1 ? late.promise : page(entries.slice(0, 1));
    }),
    () => originalScope,
  );
  const first = reads.open({ readId: 'old', viewSelection: 2, historyEpoch: 0 });
  const rejected = first.then(
    () => undefined,
    (error: unknown) => error,
  );
  const next = await reads.open({ readId: 'new', viewSelection: 2, historyEpoch: 0 });
  reads.close('old');
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  expect(next.readId).toBe('new');
  late.resolve(page(entries));
  expect(await rejected).toMatchObject({ code: 'skill_catalogue_view_changed' });
  await expect(reads.next('new')).rejects.toMatchObject({ code: 'skill_catalogue_read_complete' });
  reads.close('new');
  expect(signals[1]?.aborted).toBe(true);
});

test('view reset, wrong revision and an oversized public page reject locally instead of publishing a prefix', async () => {
  let scope = { ...originalScope },
    count = 0;
  const reads = new NativeSkillCatalogueReads(
    client(async () => {
      count++;
      return count === 1
        ? page(entries.slice(0, 1), false)
        : { ...page(entries.slice(1, 2)), revision: 'c'.repeat(64) };
    }),
    () => scope,
  );
  await reads.open({ readId: 'reset', viewSelection: 2, historyEpoch: 0 });
  scope = { ...scope, historyEpoch: 1 };
  await expect(reads.next('reset')).rejects.toMatchObject({ code: 'skill_catalogue_view_changed' });
  expect(count).toBe(1);
  await reads.open({ readId: 'revision', viewSelection: 2, historyEpoch: 1 });
  // A separate fixed-revision lease receives two individually valid public pages.
  count = 0;
  await reads.open({ readId: 'changed', viewSelection: 2, historyEpoch: 1 });
  await expect(reads.next('changed')).rejects.toMatchObject({ code: 'skill_catalogue_changed' });
  const large = new NativeSkillCatalogueReads(
    client(async () =>
      page(entries.slice(0, 40).map((entry) => ({ ...entry, description: 'x'.repeat(4096) }))),
    ),
    () => originalScope,
  );
  await expect(
    large.open({ readId: 'large', viewSelection: 2, historyEpoch: 0 }),
  ).rejects.toMatchObject({ code: 'skill_catalogue_page_too_large' });
});

test('closed Skills IPC accepts read handles and original observations, never caller supplied authority or paths', () => {
  const open = {
    method: 'settings.skills.open' as const,
    generation: 1,
    readId: 'read',
    viewSelection: 2,
    historyEpoch: 0,
  };
  expect(decodeNativeRequest(open)).toEqual(open);
  for (const patch of [
    { workspaceId: 'other' },
    { storeId: 'other' },
    { path: '/private' },
    { viewSelection: '2' },
    { viewSelection: 0 },
    { historyEpoch: -1 },
    { readId: 'a/b' },
  ])
    expect(() => decodeNativeRequest({ ...open, ...patch })).toThrow('invalid_native_request');
  for (const method of ['settings.skills.next', 'settings.skills.close'] as const) {
    expect(decodeNativeRequest({ method, generation: 1, readId: 'read' })).toEqual({
      method,
      generation: 1,
      readId: 'read',
    });
    expect(() =>
      decodeNativeRequest({ method, generation: 1, readId: 'read', revision: 'b'.repeat(64) }),
    ).toThrow('invalid_native_request');
  }
});
