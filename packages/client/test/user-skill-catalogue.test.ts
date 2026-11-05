import { expect, test } from 'bun:test';
import {
  createClient,
  type ServerInfo,
  type UserSkillCataloguePage,
  verifyUserSkillCataloguePage,
  verifyUserSkillDocument,
} from '../src';

const info: ServerInfo = {
  instanceId: 'i',
  buildId: 'b',
  apiMajor: 1,
  profile: { dataRoot: '/owned', name: 'p', accessKey: 'k' },
  dataAvailability: 'available',
  storeId: 'store',
  capabilities: ['user_skill_catalogue'],
};
const entries: UserSkillCataloguePage['entries'] = Array.from({ length: 301 }, (_, i) => ({
  id: `skill-${String(i).padStart(3, '0')}`,
  name: `Skill ${i}`,
  description: 'metadata only',
  source: { scope: 'user', origin: 'configured' },
  version: 'a'.repeat(64),
  enabled: true,
  state: 'available',
  reason: null,
  requiredCapabilities: [],
  missingCapabilities: [],
}));
const page = (rows = entries): UserSkillCataloguePage => ({
  version: 1,
  scope: 'user',
  storeId: 'store',
  revision: 'b'.repeat(64),
  availability: 'available',
  reason: null,
  entries: rows,
  complete: true,
  nextAfterId: null,
});

test('document preview verifies exact identity, connection and byte budget without acquiring execution capabilities', async () => {
  const identity = {
    storeId: 'store',
    skillId: 'computer-use',
    skillVersion: 'a'.repeat(64),
    revision: 'b'.repeat(64),
  };
  const document = { ...identity, body: '# 说明\n\n正文🙂' };
  expect(verifyUserSkillDocument(document, identity)).toEqual(document);
  for (const patch of [
    { storeId: 'foreign' },
    { skillId: 'other' },
    { skillVersion: 'c'.repeat(64) },
    { revision: 'c'.repeat(64) },
  ])
    expect(() => verifyUserSkillDocument({ ...document, ...patch }, identity)).toThrow(
      expect.objectContaining({ code: 'skill_catalogue_identity_mismatch' }),
    );
  for (const patch of [{ path: '/private' }, { resources: [] }, { body: null }])
    expect(() => verifyUserSkillDocument({ ...document, ...patch }, identity)).toThrow(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  expect(() =>
    verifyUserSkillDocument({ ...document, body: '雪'.repeat(400000) }, identity),
  ).toThrow(expect.objectContaining({ code: 'skill_text_limit' }));
  const originalFetch = globalThis.fetch;
  let enabled = true,
    reads = 0;
  const urls: URL[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(init?.method).toBe('GET');
    const url = new URL(String(input));
    if (url.pathname === '/v1/server')
      return Response.json({
        ...info,
        capabilities: enabled
          ? ['user_skill_catalogue', 'user_skill_document']
          : ['user_skill_catalogue'],
      });
    urls.push(url);
    reads++;
    return Response.json(document);
  }) as typeof fetch;
  const client = createClient({
    endpoint: 'http://owned.local',
    token: 'owned',
    expected: { apiMajor: 1, profile: info.profile, requiredCapabilities: [] },
  });
  try {
    await client.connect();
    expect(await client.readUserSkillDocument(identity)).toEqual(document);
    expect(urls[0]!.pathname).toBe('/v1/config/user/skills/document');
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual(identity);
    expect(client.lastAppliedCursor).toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      client.readUserSkillDocument({ ...identity, signal: aborted.signal }),
    ).rejects.toBeDefined();
    expect(reads).toBe(1);
    enabled = false;
    await client.connect();
    await expect(client.readUserSkillDocument(identity)).rejects.toMatchObject({
      code: 'capability_unavailable',
    });
    expect(reads).toBe(1);
  } finally {
    client.disposeNetwork();
    globalThis.fetch = originalFetch;
  }
});

test('global Skills decoder is closed at every level and rejects project, Session and Workflow metadata', () => {
  const value = page(structuredClone(entries.slice(0, 1)));
  const verified = verifyUserSkillCataloguePage(value, { storeId: 'store' });
  expect(verified).toEqual(value);
  value.entries[0]!.description = 'caller mutation';
  expect(verified.entries[0]!.description).toBe('metadata only');
  for (const invalid of [
    { ...page(), scope: 'project' },
    { ...page(), workspaceId: 'w' },
    { ...page(), sessionId: 's' },
    { ...page(), path: '/private' },
    { ...page(), body: 'private body' },
    { ...page(), entries: [{ ...entries[1], source: { scope: 'project', origin: '.agents' } }] },
    { ...page(), entries: [{ ...entries[1], workflow: {} }] },
    { ...page(), entries: [{ ...entries[1], token: 'private' }] },
    { ...page(), entries: [{ ...entries[1], body: 'private body' }] },
    {
      ...page(),
      entries: [{ ...entries[1], source: { scope: 'user', origin: 'profile', path: '/private' } }],
    },
  ])
    expect(() => verifyUserSkillCataloguePage(invalid)).toThrow(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  expect(() => verifyUserSkillCataloguePage(page(), { storeId: 'other' })).toThrow(
    expect.objectContaining({ code: 'skill_catalogue_identity_mismatch' }),
  );
  expect(() => verifyUserSkillCataloguePage(page(), { revision: 'c'.repeat(64) })).toThrow(
    expect.objectContaining({ code: 'skill_catalogue_changed' }),
  );
  expect(() =>
    verifyUserSkillCataloguePage({ ...page(), entries: [entries[2], entries[1]] }),
  ).toThrow(expect.objectContaining({ code: 'invalid_response' }));
  expect(() => verifyUserSkillCataloguePage({ ...page([]), complete: false })).toThrow(
    expect.objectContaining({ code: 'invalid_response' }),
  );
  expect(() =>
    verifyUserSkillCataloguePage({
      ...page(),
      availability: 'unavailable',
      reason: 'configuration_unavailable',
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid_response' }));
  expect(
    verifyUserSkillCataloguePage({
      ...page([]),
      availability: 'unavailable',
      reason: 'configuration_unavailable',
    }).availability,
  ).toBe('unavailable');
});

test('Client user Skills endpoint exhausts fixed-revision pages without project identifiers or observation changes', async () => {
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    expect(init?.method).toBe('GET');
    const url = new URL(String(input));
    if (url.pathname === '/v1/server') return Response.json(info);
    expect(url.pathname).toBe('/v1/config/user/skills');
    requests.push(url);
    const after = url.searchParams.get('afterId');
    const start = after ? entries.findIndex((row) => row.id === after) + 1 : 0;
    const rows = entries.slice(start, start + 37);
    const complete = start + rows.length === entries.length;
    return Response.json({
      ...page(rows),
      complete,
      nextAfterId: complete ? null : rows.at(-1)!.id,
    });
  }) as typeof fetch;
  const client = createClient({
    endpoint: 'http://owned.local',
    token: 'owned',
    expected: {
      apiMajor: 1,
      profile: info.profile,
      instanceId: 'i',
      buildId: 'b',
      requiredCapabilities: ['user_skill_catalogue'],
    },
  });
  try {
    await client.connect();
    const first = await client.listUserSkills({ storeId: 'store' });
    const all = [...first.entries];
    let next = first;
    while (!next.complete) {
      next = await client.listUserSkills({
        storeId: 'store',
        revision: first.revision,
        afterId: next.nextAfterId!,
      });
      all.push(...next.entries);
    }
    expect(all).toEqual(entries);
    expect(requests).toHaveLength(9);
    expect(requests[0]!.search).toBe('?storeId=store');
    expect(
      requests.slice(1).every((url) => url.searchParams.get('revision') === first.revision),
    ).toBe(true);
    expect(
      requests.every(
        (url) =>
          !url.searchParams.has('workspaceId') &&
          !url.searchParams.has('sessionId') &&
          !url.searchParams.has('workflow'),
      ),
    ).toBe(true);
    expect(client.lastAppliedCursor).toBeUndefined();
    const count = requests.length;
    await expect(
      client.listUserSkills({ storeId: 'store', afterId: 'skill-001' }),
    ).rejects.toMatchObject({ code: 'invalid_skill_catalogue_query' });
    expect(requests).toHaveLength(count);
    await expect(
      client.listUserSkills({ storeId: 'store', workflow: 'manual' } as Parameters<
        typeof client.listUserSkills
      >[0]),
    ).rejects.toBeDefined();
    expect(requests).toHaveLength(count);
  } finally {
    client.disposeNetwork();
    globalThis.fetch = originalFetch;
  }
});
