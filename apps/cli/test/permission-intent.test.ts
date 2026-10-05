import { expect, test } from 'bun:test';
import { type AgentClient, ClientError, type PermissionGrantPage } from '@kite-ai/client';
import { clearPermissionGrants, getPermissionGrants, setPermissionMode } from '../src/permissions';

test('bad submitted permission response reads original mutation once; duplicate remains zero POST and original scope', async () => {
  let posts = 0,
    reads = 0;
  const client = {
    setPermissionMode: async () => {
      posts++;
      throw new ClientError('invalid_response');
    },
    getPermissionMutation: async (id: string, input: { storeId: string }) => {
      reads++;
      expect(id).toBe('original');
      expect(input.storeId).toBe('store');
      return {
        commandId: id,
        kind: 'permission.mode',
        state: 'applied',
        receipt: {
          status: 'applied',
          mode: 'ask',
          makeDefault: false,
          revision: '4',
          defaultRevision: '0',
        },
      };
    },
  } as unknown as AgentClient;
  const request = {
    expectedStoreId: 'store',
    commandId: 'original',
    mode: 'ask' as const,
    ifRevision: '3',
    makeDefault: false,
    ifDefaultRevision: '0',
  };
  const options = { client, write: () => {} };
  expect((await setPermissionMode('a', request, options)).status).toBe('applied');
  expect((await setPermissionMode('a', request, options)).status).toBe('applied');
  expect(posts).toBe(1);
  expect(reads).toBe(1);
  expect(() => setPermissionMode('b', request, options)).toThrow();
});
test('grants read completes 201 fixed upper items; changed epoch fails without returning prefix', async () => {
  const queries: unknown[] = [];
  const row = (n: number) => ({ seq: String(n), grant: { id: `g${n}` } });
  const page = (after?: string): PermissionGrantPage =>
    ({
      storeId: 'store',
      sessionId: 'a',
      revision: '4',
      highWaterSeq: '201',
      upperSeq: '201',
      snapshotCursor: after ? '9' : '8',
      items: (after ? [201] : Array.from({ length: 200 }, (_, i) => i + 1)).map(row),
      nextAfterSeq: after ? null : '200',
    }) as PermissionGrantPage;
  const client = {
    listPermissionGrants: async (_id: string, q: { afterSeq?: string }) => {
      queries.push(q);
      return page(q.afterSeq);
    },
  } as unknown as AgentClient;
  const options = { client, write: () => {} };
  const result = await getPermissionGrants('a', 'store', options);
  expect(result.page.items).toHaveLength(201);
  expect(queries[1]).toMatchObject({ upperSeq: '201', afterSeq: '200', limit: 200 });
  client.listPermissionGrants = async (_id, q) => ({
    ...page(q.afterSeq),
    revision: q.afterSeq ? '5' : '4',
  });
  await expect(getPermissionGrants('a', 'store', options)).rejects.toThrow(
    'directory_snapshot_changed',
  );
});
test('128 unknown permission intents are retained; clear never implicitly creates an approval', async () => {
  let posts = 0;
  const client = {
    clearPermissionGrants: async () => {
      posts++;
      throw new ClientError('network_outcome_unknown');
    },
    getPermissionMutation: async () => {
      throw Error('offline');
    },
  } as unknown as AgentClient;
  const options = { client, write: () => {} };
  for (let i = 0; i < 128; i++)
    expect(
      (
        await clearPermissionGrants(
          'a',
          { expectedStoreId: 'store', commandId: `c${i}`, ifRevision: '2' },
          options,
        )
      ).status,
    ).toBe('outcome_unknown');
  await expect(
    clearPermissionGrants(
      'a',
      { expectedStoreId: 'store', commandId: 'extra', ifRevision: '2' },
      options,
    ),
  ).rejects.toThrow('permission_intent_limit');
  expect(posts).toBe(128);
});
