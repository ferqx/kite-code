import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createClient } from '../src/index';

test('binary Artifact client checks full size/hash, bounds response bytes and keeps its cursor untouched', async () => {
  const profile = { dataRoot: '/disposable', name: 'test', accessKey: 'public-test' };
  const info = {
    instanceId: 'test',
    buildId: 'test',
    apiMajor: 1,
    profile,
    dataAvailability: 'available',
    storeId: 'store',
    capabilities: [],
  };
  let mode: 'valid' | 'hash' | 'size' | 'budget' = 'valid';
  const tokens: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      tokens.push(request.headers.get('authorization') ?? '');
      if (new URL(request.url).pathname === '/v1/server') return Response.json(info);
      return new Response(Uint8Array.from([65]), {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="ref"',
          'cache-control': 'no-store',
          'x-artifact-id': 'ref',
          'x-artifact-store-id': 'original-store',
          'x-artifact-hash':
            mode === 'hash'
              ? '0'.repeat(64)
              : createHash('sha256')
                  .update(Uint8Array.from([65]))
                  .digest('hex'),
          'x-artifact-size': mode === 'size' ? '2' : mode === 'budget' ? '99999999' : '1',
        },
      });
    },
  });
  const client = createClient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: 'private-fixture-token',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const input = {
    expectedStoreId: 'store',
    refId: 'ref',
    scope: { kind: 'session' as const, id: 'session' },
  };
  try {
    await client.connect();
    const before = client.lastAppliedCursor;
    const original = await client.readArtifact('session', input, {
      expectedReference: {
        storeId: 'original-store',
        size: '1',
        mediaType: 'application/octet-stream',
      },
    });
    expect(original.reference.storeId).toBe('original-store');
    expect(Array.from(original.content)).toEqual([65]);
    const drift = await client
      .readArtifact('session', input, {
        expectedReference: { storeId: 'foreign', size: '1', mediaType: 'application/octet-stream' },
      })
      .catch((error: unknown) => error);
    expect((drift as { code: string }).code).toBe('artifact_metadata_mismatch');
    mode = 'hash';
    await expect(client.readArtifact('session', input)).rejects.toMatchObject({
      code: 'artifact_content_mismatch',
    });
    mode = 'size';
    await expect(client.readArtifact('session', input)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    mode = 'budget';
    await expect(client.readArtifact('session', input)).rejects.toMatchObject({
      code: 'response_too_large',
    });
    expect(client.lastAppliedCursor).toEqual(before);
    expect(tokens.every((token) => token === 'Bearer private-fixture-token')).toBe(true);
  } finally {
    client.disposeNetwork();
    server.stop(true);
  }
});
