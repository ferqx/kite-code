import { expect, test } from 'bun:test';
import type { AgentClient, UserSkillCataloguePage } from '@kite-ai/client';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';
import { NativeSkillCatalogueReads } from '../electron/skill-catalogue-reads';
import type { NativeBridge, NativeSkillsScope } from '../src/native-bridge';
import { readNativeSkillCatalogue } from '../src/native-skills';

const originalScope: NativeSkillsScope = {
  generation: 1,
  storeId: 'store',
};
const entries: UserSkillCataloguePage['entries'] = Array.from({ length: 301 }, (_, index) => ({
  id: `skill-${String(index).padStart(3, '0')}`,
  name: `Skill ${index}`,
  description: `原摘要 ${index}`,
  source: { scope: 'user', origin: 'configured' },
  version: 'a'.repeat(64),
  enabled: true,
  state: 'available',
  reason: null,
  requiredCapabilities: [],
  missingCapabilities: [],
}));
const page = (
  rows: UserSkillCataloguePage['entries'],
  complete = true,
): UserSkillCataloguePage => ({
  version: 1,
  storeId: 'store',
  scope: 'user',
  revision: 'b'.repeat(64),
  availability: 'available',
  reason: null,
  entries: rows,
  complete,
  nextAfterId: complete ? null : rows.at(-1)!.id,
});
const client = (listUserSkills: AgentClient['listUserSkills']) =>
  ({
    serverInfo: { capabilities: ['user_skill_catalogue'] },
    listUserSkills,
  }) as unknown as AgentClient;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Main owns fixed-revision user pagination without a Session, Workspace or total cap', async () => {
  const calls: Parameters<AgentClient['listUserSkills']>[0][] = [];
  const reads = new NativeSkillCatalogueReads(
    client(async (options) => {
      calls.push(options);
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
    calls.every((call) => call.storeId === originalScope.storeId && call.byteLimit === 131072),
  ).toBe(true);
  expect(calls.slice(1).every((call) => call.revision === all.revision && call.afterId)).toBe(true);
  expect(calls.every((call) => call.signal?.aborted)).toBe(true);
  await expect(reads.next('expired')).rejects.toMatchObject({
    code: 'skill_catalogue_read_missing',
  });
});

test('close during a pending controller refresh aborts the user read and stale generations cannot reopen', async () => {
  const refresh = deferred<void>(),
    response = deferred<UserSkillCataloguePage>();
  let scope = { ...originalScope },
    signal: AbortSignal | undefined,
    getCount = 0;
  const reads = new NativeSkillCatalogueReads(
    client(async (options) => {
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
  });
  const rejected = opened.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(getCount).toBe(1);
  await caller.invoke({ method: 'settings.skills.close', generation: 1, readId: 'original' });
  expect(signal?.aborted).toBe(true);
  scope = { ...scope, generation: 2, storeId: 'other' };
  Object.assign(caller, { generation: 2 });
  refresh.resolve();
  response.resolve(page(entries.slice(0, 1)));
  expect(await rejected).toMatchObject({ code: 'skill_catalogue_view_changed' });
  expect(getCount).toBe(1);
  await expect(
    caller.invoke({
      method: 'settings.skills.open',
      generation: 1,
      readId: 'late',
    }),
  ).rejects.toMatchObject({ code: 'native_generation_changed' });
  expect(getCount).toBe(1);
});

test('refresh replaces only its own lease; old close and a late page cannot change the new facts', async () => {
  const late = deferred<UserSkillCataloguePage>();
  let request = 0;
  const signals: AbortSignal[] = [];
  const reads = new NativeSkillCatalogueReads(
    client(async (options) => {
      signals.push(options.signal!);
      request++;
      return request === 1 ? late.promise : page(entries.slice(0, 1));
    }),
    () => originalScope,
  );
  const first = reads.open({ readId: 'old' });
  const rejected = first.then(
    () => undefined,
    (error: unknown) => error,
  );
  const next = await reads.open({ readId: 'new' });
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

test('store replacement, wrong revision and an oversized public page reject locally instead of publishing a prefix', async () => {
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
  await reads.open({ readId: 'reset' });
  scope = { ...scope, storeId: 'replacement' };
  await expect(reads.next('reset')).rejects.toMatchObject({ code: 'skill_catalogue_view_changed' });
  expect(count).toBe(1);
  scope = { ...originalScope };
  await reads.open({ readId: 'revision' });
  // A separate fixed-revision lease receives two individually valid public pages.
  count = 0;
  await reads.open({ readId: 'changed' });
  await expect(reads.next('changed')).rejects.toMatchObject({ code: 'skill_catalogue_changed' });
  const large = new NativeSkillCatalogueReads(
    client(async () =>
      page(entries.slice(0, 40).map((entry) => ({ ...entry, description: 'x'.repeat(4096) }))),
    ),
    () => originalScope,
  );
  await expect(large.open({ readId: 'large' })).rejects.toMatchObject({
    code: 'skill_catalogue_page_too_large',
  });
});

test('closed global Skills IPC accepts read handles, never Session, Workspace, workflow or filesystem authority', () => {
  const open = {
    method: 'settings.skills.open' as const,
    generation: 1,
    readId: 'read',
  };
  expect(decodeNativeRequest(open)).toEqual(open);
  for (const patch of [
    { workspaceId: 'other' },
    { sessionId: 'other' },
    { workflow: 'manual' },
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
