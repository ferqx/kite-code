import { expect, test } from 'bun:test';
import { createClient } from '../../src';
import { decodeResponse } from '../../src/decode';
import { verifyFileCheckpointRecoveryBoundary } from '../../src/file-checkpoints';
import type { FileCheckpointRecoveryBoundary } from '../../src/generated/api';

const pointId = 'a'.repeat(64);
function boundary(): FileCheckpointRecoveryBoundary {
  return {
    storeId: 'current',
    sessionId: 'child',
    workspaceId: 'current-w',
    contextSelectionId: 'current-selection',
    checkpoint: {
      id: pointId,
      boundary: {
        storeId: 'origin',
        sessionId: 'parent',
        workspaceId: 'origin-w',
        runId: 'run',
        contextSelectionId: 'original-selection',
        messageId: 'original-before',
        messageSeq: '2',
        triggerMessageId: 'original-user',
        triggerSeq: '3',
      },
      workspace: { device: '1', inode: '2' },
    },
    boundary: { messageId: 'alias-before', seq: '9007199254740993' },
    trigger: { messageId: 'alias-user', seq: '9007199254740994' },
  };
}

test('Native recovery boundary is closed and keeps current aliases separate from immutable source identity', () => {
  const value = boundary();
  expect(decodeResponse('FileCheckpointRecoveryBoundary', value)).toEqual(value);
  expect(verifyFileCheckpointRecoveryBoundary(value, pointId)).toEqual(value);
  for (const wrong of [
    { ...value, actions: [] },
    { ...value, authority: 'grant' },
    { ...value, checkpoint: { ...value.checkpoint, raw: 'secret' } },
    { ...value, trigger: { ...value.trigger, seq: '9223372036854775808' } },
    { ...value, boundary: { ...value.trigger } },
    { ...value, trigger: { ...value.trigger, seq: '0' } },
  ]) {
    let refused = false;
    try {
      verifyFileCheckpointRecoveryBoundary(
        decodeResponse('FileCheckpointRecoveryBoundary', wrong),
        pointId,
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }
  expect(() => verifyFileCheckpointRecoveryBoundary(value, 'b'.repeat(64))).toThrow();
});

test('Native named file reads enforce capability, exact targets and optional query omission; abort and connection disposal never POST', async () => {
  const profile = { dataRoot: '/owned', name: 'owned', accessKey: 'fixed' };
  let enabled = false,
    wrongScope = false,
    posts = 0,
    held = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/server')
        return Response.json({
          instanceId: 'fixed',
          buildId: 'fixed',
          apiMajor: 1,
          capabilities: enabled ? ['file_recovery'] : [],
          profile,
          dataAvailability: 'available',
          storeId: 'current',
        });
      paths.push(url.pathname + url.search);
      if (request.method !== 'GET') posts++;
      if (held) await barrier;
      const value = { ...boundary(), ...(wrongScope ? { sessionId: 'foreign' } : {}) };
      if (url.pathname.endsWith('/recovery-boundary')) return Response.json(value);
      const observation = {
        storeId: value.storeId,
        sessionId: value.sessionId,
        workspaceId: value.workspaceId,
      };
      if (url.pathname.endsWith('/restores/restore'))
        return Response.json({ ...observation, payload: { journal: null, execution: null } });
      if (url.pathname.endsWith(pointId))
        return Response.json({
          ...observation,
          payload: { checkpoint: value.checkpoint, files: [] },
        });
      return Response.json({ ...observation, payload: { items: [], nextAfterKey: null } });
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'owned',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const failure = async (work: Promise<unknown>, expected?: string) => {
    let error: unknown;
    try {
      await work;
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeDefined();
    if (expected) expect((error as { code?: string }).code).toBe(expected);
  };
  try {
    await client.connect();
    await failure(
      client.getFileCheckpointRecoveryBoundary('child', pointId),
      'capability_unavailable',
    );
    expect(paths).toHaveLength(0);
    enabled = true;
    await client.connect();
    await failure(client.getFileCheckpoint('child', 'bad'), 'invalid_file_checkpoint_target');
    await failure(client.listFileCheckpoints('child', { limit: 0 }), 'invalid_request');
    expect(paths).toHaveLength(0);
    expect(
      await client.listFileCheckpoints('child', { afterKey: undefined, limit: undefined }),
    ).toMatchObject({ payload: { items: [] } });
    expect(paths.at(-1)).toBe('/v1/sessions/child/file-checkpoints');
    expect((await client.getFileCheckpoint('child', pointId)).payload.checkpoint).toEqual(
      boundary().checkpoint,
    );
    expect((await client.getFileRestoreStatus('child', pointId, 'restore')).payload).toEqual({
      journal: null,
      execution: null,
    });
    expect(await client.getFileCheckpointRecoveryBoundary('child', pointId)).toEqual(boundary());
    wrongScope = true;
    await failure(
      client.getFileCheckpointRecoveryBoundary('child', pointId),
      'file_checkpoint_identity_mismatch',
    );
    wrongScope = false;
    const abort = new AbortController();
    abort.abort();
    const count = paths.length;
    await failure(
      client.getFileCheckpointRecoveryBoundary('child', pointId, { signal: abort.signal }),
    );
    expect(paths).toHaveLength(count);
    held = true;
    const pending = client.getFileCheckpointRecoveryBoundary('child', pointId);
    for (let i = 0; paths.length === count && i < 100; i++) await Bun.sleep(5);
    expect(paths.length).toBe(count + 1);
    client.disposeNetwork();
    release();
    await failure(pending);
    expect(posts).toBe(0);
  } finally {
    release();
    client.disposeNetwork();
    server.stop(true);
  }
});
