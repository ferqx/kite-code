import { expect, test } from 'bun:test';
import {
  type AgentClient,
  ClientError,
  type PermissionGrantPage,
  type PermissionMutation,
} from '@kite-ai/client';
import { NativePermissionGrants } from '../electron/permission-grants';

const page = (sessionId: string, revision = '4'): PermissionGrantPage => ({
  storeId: 'store',
  sessionId,
  revision,
  items: [],
  highWaterSeq: '0',
  upperSeq: '0',
  nextAfterSeq: null,
  snapshotCursor: '4',
});
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}
test('grant clear preserves exact observed child epoch and original command across view switch and lost response; duplicate sends once and lookup cannot POST', async () => {
  let current = {
    generation: 1,
    selection: 1,
    storeId: 'store',
    sessionId: 'child',
    workspaceId: 'w',
  };
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const sent: unknown[] = [],
    reads: unknown[] = [];
  let original!: Parameters<AgentClient['clearPermissionGrants']>[1];
  const client = {
    serverInfo: { capabilities: ['permission_grants'] },
    listPermissionGrants: async (id: string) => page(id),
    async clearPermissionGrants(id: string, intent: typeof original) {
      original = intent;
      sent.push([id, intent]);
      await barrier;
      throw new ClientError('network_outcome_unknown');
    },
    async getPermissionMutation(id: string, input: unknown) {
      reads.push([id, input]);
      return {
        commandId: id,
        kind: 'permission.grants.clear',
        state: 'applied',
        receipt: { status: 'applied', sessionId: 'child', revision: '5' },
      } as PermissionMutation;
    },
  } as unknown as AgentClient;
  const host = new NativePermissionGrants(
    client,
    () => current,
    () => {},
  );
  const facts = await host.read({ sessionId: 'child' });
  const first = host.clear(facts.observationId),
    duplicate = host.clear(facts.observationId);
  expect(first).toBe(duplicate);
  expect(sent).toHaveLength(1);
  current = { ...current, selection: 2, sessionId: 'other' };
  host.release();
  release();
  expect(await code(first)).toBe('network_outcome_unknown');
  expect(host.submissions[0]).toMatchObject({
    sessionId: 'child',
    phase: 'unknown',
    intent: { expectedStoreId: 'store', ifRevision: '4' },
  });
  await host.lookup(original.commandId);
  expect(sent).toHaveLength(1);
  expect(reads).toEqual([[original.commandId, { storeId: 'store' }]]);
  expect(host.submissions[0]?.phase).toBe('applied');
});
test('failed or drifting pages remove writable facts; absent capability, stale view and foreign page never permit a clear', async () => {
  let current = { generation: 1, selection: 1, storeId: 'store', sessionId: 's', workspaceId: 'w' },
    requests = 0;
  let fail = false,
    foreign = false;
  const client = {
    serverInfo: { capabilities: ['permission_grants'] },
    async listPermissionGrants(id: string) {
      requests++;
      if (fail) throw new ClientError('network_outcome_unknown');
      return page(foreign ? 'foreign' : id);
    },
  } as unknown as AgentClient;
  const host = new NativePermissionGrants(
    client,
    () => current,
    () => {},
  );
  const first = await host.read({ sessionId: 's' });
  fail = true;
  expect(await code(host.read({ sessionId: 's' }))).toBe('network_outcome_unknown');
  expect(await code(Promise.resolve().then(() => host.clear(first.observationId)))).toBe(
    'permission_observation_changed',
  );
  fail = false;
  expect(
    await code(host.read({ sessionId: 's', afterSeq: '1', upperSeq: '3', revision: '3' })),
  ).toBe('directory_snapshot_changed');
  foreign = true;
  expect(await code(host.read({ sessionId: 's' }))).toBe('permission_scope_mismatch');
  foreign = false;
  const facts = await host.read({ sessionId: 's' });
  current = { ...current, selection: 2, sessionId: 'other' };
  expect(await code(Promise.resolve().then(() => host.clear(facts.observationId)))).toBe(
    'permission_observation_changed',
  );
  client.serverInfo!.capabilities = [];
  const prior = requests;
  expect(await code(host.read({ sessionId: 'other' }))).toBe('capability_unavailable');
  expect(requests).toBe(prior);
});
