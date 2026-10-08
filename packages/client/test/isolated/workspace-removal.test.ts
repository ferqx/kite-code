import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createClient, type ServerInfo, type WorkspaceRemoval } from '../../src';

test('Workspace receipt keeps the frozen original request through a delayed response and rejects forged outcome authority', async () => {
  const profile = { dataRoot: '/chosen/workspace-test', name: 'test', accessKey: 'fixture' };
  const identity: ServerInfo = {
    profile,
    instanceId: 'instance',
    buildId: 'workspace-test',
    apiMajor: 1,
    capabilities: ['sessions'],
    dataAvailability: 'available',
    storeId: 'store',
    subjectId: 'user',
  };
  const receipt: WorkspaceRemoval = {
    commandId: 'original',
    originStoreId: 'store',
    subjectId: 'user',
    workspaceId: 'w',
    requestDigest: createHash('sha256')
      .update('{"kind":"workspace.remove","workspaceId":"w"}')
      .digest('hex'),
    removedAt: 1,
    deletedRoots: 2,
    deletedSessions: 5,
    outcome: 'workspace_removed',
    stopConfirmed: false,
  };
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const posts: unknown[] = [];
  let answer: unknown = receipt;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/v1/server') return Response.json(identity);
      if (request.method === 'POST') {
        posts.push(await request.json());
        enter();
        await held;
      }
      return Response.json(answer);
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'fixture',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions'] },
  });
  try {
    await client.connect();
    const intent = { expectedStoreId: 'store', commandId: 'original' };
    const pending = client.removeWorkspace('w', intent);
    await entered;
    intent.commandId = 'forged';
    intent.expectedStoreId = 'foreign';
    release();
    expect(await pending).toEqual(receipt);
    expect(posts).toEqual([{ expectedStoreId: 'store', commandId: 'original' }]);
    expect(await client.getWorkspaceRemoval('w', 'original', { storeId: 'store' })).toEqual(
      receipt,
    );
    for (const changed of [
      { requestDigest: 'a'.repeat(64) },
      { subjectId: 'foreign' },
      { workspaceId: 'other' },
    ]) {
      answer = { ...receipt, ...changed };
      const error = await client
        .getWorkspaceRemoval('w', 'original', { storeId: 'store' })
        .catch((e) => e);
      expect(error.code).toBe('workspace_scope_mismatch');
    }
    answer = { ...receipt, stopConfirmed: true };
    const error = await client
      .getWorkspaceRemoval('w', 'original', { storeId: 'store' })
      .catch((e) => e);
    expect(error.code).toBe('invalid_response');
    expect(posts).toHaveLength(1);
  } finally {
    release();
    client.disposeNetwork();
    server.stop(true);
  }
});
