import { expect, test } from 'bun:test';
import {
  createClient,
  type ServerInfo,
  type SkillCataloguePage,
  verifySkillCataloguePage,
} from '../src';

const info: ServerInfo = {
  instanceId: 'i',
  buildId: 'b',
  apiMajor: 1,
  profile: { dataRoot: '/owned', name: 'p', accessKey: 'k' },
  dataAvailability: 'available',
  storeId: 'store',
  capabilities: ['skill_catalogue'],
};
const entries = Array.from({ length: 301 }, (_, i) => ({
  id: `skill-${String(i).padStart(3, '0')}`,
  name: '',
  description: 'metadata only',
  version: 'a'.repeat(64),
  enabled: true,
  state: 'available' as const,
  reason: null,
  requiredCapabilities: [],
  missingCapabilities: [],
}));
function fixture(supportsWorkflow = false) {
  const requests: URL[] = [];
  let identity = {
    ...info,
    capabilities: [...info.capabilities, ...(supportsWorkflow ? ['skill_workflow_catalogue'] : [])],
  };
  let transform = (page: SkillCataloguePage): unknown => page;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      expect(request.method).toBe('GET');
      const url = new URL(request.url);
      if (url.pathname === '/v1/server') return Response.json(identity);
      requests.push(url);
      const after = url.searchParams.get('afterId');
      const start = after ? entries.findIndex((e) => e.id === after) + 1 : 0;
      const items = entries.slice(start, start + 37);
      return Response.json(
        transform({
          version: 1,
          storeId: 'store',
          workspaceId: 'w',
          revision: 'b'.repeat(64),
          availability: 'available',
          reason: null,
          entries: items,
          complete: start + items.length === entries.length,
          nextAfterId: start + items.length === entries.length ? null : items.at(-1)!.id,
        }),
      );
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'owned',
    expected: {
      apiMajor: 1,
      profile: info.profile,
      instanceId: 'i',
      buildId: 'b',
      requiredCapabilities: ['skill_catalogue'],
    },
  });
  return {
    client,
    requests,
    identity: (next: ServerInfo) => {
      identity = next;
    },
    set: (next: typeof transform) => {
      transform = next;
    },
    close() {
      client.disposeNetwork();
      server.stop(true);
    },
  };
}
test('full Skill metadata reads every fixed-revision page beyond 256 without mutating or advancing observations', async () => {
  const f = fixture();
  try {
    await f.client.connect();
    const result = await f.client.listAllSkills('w', { storeId: 'store' });
    expect(result.entries).toEqual(entries);
    expect(result.complete).toBe(true);
    expect(result.nextAfterId).toBeNull();
    expect(f.requests).toHaveLength(9);
    expect(
      f.requests.slice(1).every((url) => url.searchParams.get('revision') === 'b'.repeat(64)),
    ).toBe(true);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    const options = { storeId: 'store', afterId: undefined, revision: undefined };
    const read = f.client.listSkills('w', options);
    options.storeId = 'forged';
    expect((await read).storeId).toBe('store');
    expect(f.requests.at(-1)!.search).toBe('?storeId=store');
  } finally {
    f.close();
  }
});
test('catalogue rejects private additive fields, forged scope, unstable pages and invalid bounds with no retries', async () => {
  const f = fixture();
  try {
    await f.client.connect();
    for (const change of [
      (p: SkillCataloguePage) => ({ ...p, body: 'secret' }),
      (p: SkillCataloguePage) => ({
        ...p,
        entries: [{ ...p.entries[0]!, path: '/private', token: 'secret' }],
      }),
      (p: SkillCataloguePage) => ({ ...p, storeId: 'other' }),
      (p: SkillCataloguePage) => ({ ...p, workspaceId: 'other' }),
      (p: SkillCataloguePage) => ({ ...p, nextAfterId: 'wrong' }),
      (p: SkillCataloguePage) => ({ ...p, entries: [p.entries[1]!, p.entries[0]!] }),
    ]) {
      f.set(change);
      const count = f.requests.length;
      await expect(f.client.listSkills('w', { storeId: 'store' })).rejects.toBeDefined();
      expect(f.requests.length).toBe(count + 1);
    }
    f.set((p) => p);
    await expect(f.client.listSkills('w', { storeId: 'store', limit: 1 })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const count = f.requests.length;
    await expect(
      f.client.listSkills('w', { storeId: 'store', afterId: 'skill-001' }),
    ).rejects.toMatchObject({ code: 'invalid_skill_catalogue_query' });
    expect(f.requests).toHaveLength(count);
    f.set((p) => ({
      ...p,
      revision: f.requests.at(-1)!.searchParams.has('revision') ? 'c'.repeat(64) : p.revision,
    }));
    const before = f.requests.length;
    await expect(f.client.listAllSkills('w', { storeId: 'store' })).rejects.toMatchObject({
      code: 'skill_catalogue_changed',
    });
    expect(f.requests.length).toBe(before + 2);
    const abort = new AbortController();
    abort.abort();
    const prior = f.requests.length;
    await expect(
      f.client.listAllSkills('w', { storeId: 'store', signal: abort.signal }),
    ).rejects.toBeDefined();
    expect(f.requests).toHaveLength(prior);
  } finally {
    f.close();
  }
});

test('same Store replacement host cannot supply another catalogue under the original connection identity', async () => {
  const f = fixture();
  try {
    await f.client.connect();
    f.identity({ ...info, instanceId: 'replacement' });
    await expect(f.client.listAllSkills('w', { storeId: 'store' })).rejects.toBeDefined();
    expect(f.requests).toHaveLength(0);
    expect(f.client.lastAppliedCursor).toBeUndefined();
  } finally {
    f.close();
  }
});

function manualWorkflow(entry: SkillCataloguePage['entries'][number]) {
  const name = `flow-${entry.id}`;
  return {
    extensionId: 'builtin.skill-workflow' as const,
    definitionVersion: '1' as const,
    skillId: `skill:${name}`,
    name,
    revision: 'c'.repeat(64),
    state: 'available' as const,
    reason: null,
    manualAllowed: true,
    emptyInputValid: true,
    contextMode: 'inline' as const,
  };
}

test('manual Workflow metadata requires a capability and explicit stable opt-in across every page', async () => {
  const unsupported = fixture();
  try {
    await unsupported.client.connect();
    await expect(
      unsupported.client.listAllSkills('w', { storeId: 'store', workflow: 'manual' }),
    ).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(unsupported.requests).toHaveLength(0);
  } finally {
    unsupported.close();
  }
  const f = fixture(true);
  try {
    await f.client.connect();
    f.set((page) => ({
      ...page,
      entries: page.entries.map((entry) => ({ ...entry, workflow: manualWorkflow(entry) })),
    }));
    const options: { storeId: string; workflow?: 'manual' } = {
      storeId: 'store',
      workflow: 'manual',
    };
    const pending = f.client.listAllSkills('w', options);
    options.storeId = 'changed';
    options.workflow = undefined;
    const page = await pending;
    expect(page.entries).toHaveLength(301);
    expect(page.entries.at(-1)?.workflow).toEqual(manualWorkflow(entries.at(-1)!));
    expect(f.requests).toHaveLength(9);
    expect(f.requests.every((url) => url.searchParams.get('workflow') === 'manual')).toBe(true);
    expect(f.requests.every((url) => url.searchParams.get('storeId') === 'store')).toBe(true);
    expect(f.client.lastAppliedCursor).toBeUndefined();
    const before = f.requests.length;
    await expect(f.client.listAllSkills('w', { storeId: 'store' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(f.requests).toHaveLength(before + 1);
    f.set((value) => value);
    expect(
      (await f.client.listSkills('w', { storeId: 'store' })).entries[0]?.workflow,
    ).toBeUndefined();
  } finally {
    f.close();
  }
});

test('manual Workflow metadata rejects missing, private, inconsistent and changed projections without retry', async () => {
  const f = fixture(true);
  try {
    await f.client.connect();
    for (const patch of [
      undefined,
      { instructions: 'private original instructions' },
      { definitionVersion: '2' },
      { skillId: 'skill:forged' },
      { manualAllowed: false },
      { emptyInputValid: false },
      { contextMode: null },
      { state: 'unavailable', reason: null },
    ]) {
      f.set((page) => ({
        ...page,
        entries: page.entries.map((entry) => ({
          ...entry,
          ...(patch === undefined ? {} : { workflow: { ...manualWorkflow(entry), ...patch } }),
        })),
      }));
      const count = f.requests.length;
      await expect(
        f.client.listSkills('w', { storeId: 'store', workflow: 'manual' }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
      expect(f.requests).toHaveLength(count + 1);
    }
    f.set((page) => ({
      ...page,
      revision: f.requests.at(-1)!.searchParams.has('revision') ? 'd'.repeat(64) : page.revision,
      entries: page.entries.map((entry) => ({ ...entry, workflow: manualWorkflow(entry) })),
    }));
    const before = f.requests.length;
    await expect(
      f.client.listAllSkills('w', { storeId: 'store', workflow: 'manual' }),
    ).rejects.toMatchObject({ code: 'skill_catalogue_changed' });
    expect(f.requests).toHaveLength(before + 2);
    expect(f.client.lastAppliedCursor).toBeUndefined();
  } finally {
    f.close();
  }
});

function publicPage(): SkillCataloguePage {
  return {
    version: 1,
    storeId: 'store',
    workspaceId: 'w',
    revision: 'b'.repeat(64),
    availability: 'available',
    reason: null,
    entries: [structuredClone(entries[0]!)],
    complete: true,
    nextAfterId: null,
  };
}

test('public Skill verifier clones closed source metadata and consumes older omitted sources', () => {
  for (const source of [
    undefined,
    null,
    { scope: 'project', origin: '.agents' },
    { scope: 'project', origin: '.kite-code' },
    { scope: 'project', origin: 'configured' },
    { scope: 'user', origin: 'profile' },
  ] as const) {
    const input = publicPage();
    if (source !== undefined) input.entries[0]!.source = structuredClone(source);
    const result = verifySkillCataloguePage(input, { storeId: 'store', workspaceId: 'w' });
    expect(result).toEqual(input);
    input.entries[0]!.description = 'late mutation';
    if (input.entries[0]!.source) input.entries[0]!.source.origin = 'configured';
    expect(result.entries[0]!.description).toBe('metadata only');
    expect(result.entries[0]!.source).toEqual(source);
    result.entries[0]!.requiredCapabilities.push('private mutation');
    expect(input.entries[0]!.requiredCapabilities).toEqual([]);
  }
  for (const source of [
    {},
    { scope: 'global', origin: 'profile' },
    { scope: 'project', origin: 'unknown' },
    { scope: 'project', origin: '.agents', path: '/secret/SKILL.md' },
    '/secret/SKILL.md',
  ]) {
    const input = publicPage();
    Object.assign(input.entries[0]!, { source });
    expect(() => verifySkillCataloguePage(input)).toThrow('Invalid SkillCataloguePage response.');
  }
});

test('pure public Skill verifier retains identity, state, cursor, and availability checks', () => {
  const valid = publicPage();
  expect(() => verifySkillCataloguePage(valid, { storeId: 'other' })).toThrow(
    'skill_catalogue_identity_mismatch',
  );
  expect(() => verifySkillCataloguePage(valid, { workspaceId: 'other' })).toThrow(
    'skill_catalogue_identity_mismatch',
  );
  expect(() => verifySkillCataloguePage(valid, { revision: 'c'.repeat(64) })).toThrow(
    'skill_catalogue_changed',
  );
  expect(() => verifySkillCataloguePage(valid, { afterId: valid.entries[0]!.id })).toThrow(
    'invalid_response',
  );
  for (const mutate of [
    (page: SkillCataloguePage) => {
      page.entries[0]!.enabled = false;
    },
    (page: SkillCataloguePage) => {
      page.entries.push(structuredClone(page.entries[0]!));
    },
    (page: SkillCataloguePage) => {
      page.complete = false;
      page.nextAfterId = 'wrong';
    },
    (page: SkillCataloguePage) => {
      page.availability = 'unavailable';
      page.reason = 'configuration_unavailable';
    },
  ]) {
    const page = publicPage();
    mutate(page);
    expect(() => verifySkillCataloguePage(page)).toThrow('invalid_response');
  }
  const privateFields = publicPage();
  Object.assign(privateFields.entries[0]!, { body: 'private' });
  expect(() => verifySkillCataloguePage(privateFields)).toThrow(
    'Invalid SkillCataloguePage response.',
  );
  expect(() => verifySkillCataloguePage(valid, { workflow: 'manual' })).toThrow('invalid_response');
  const unavailable = publicPage();
  unavailable.availability = 'unavailable';
  unavailable.reason = 'configuration_unavailable';
  unavailable.entries = [];
  expect(verifySkillCataloguePage(unavailable)).toEqual(unavailable);
});
