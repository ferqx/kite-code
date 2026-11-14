import { expect, test } from 'bun:test';
import { createClient, type ServerInfo } from '../src';

const profile = { dataRoot: '/test', name: 'fixture', accessKey: 'key' };
const info: ServerInfo = {
  profile,
  instanceId: 'instance',
  buildId: 'build',
  apiMajor: 1,
  capabilities: ['output_files'],
  dataAvailability: 'available',
  storeId: 'store',
};
const expected = {
  profile,
  instanceId: 'instance',
  buildId: 'build',
  apiMajor: 1,
  requiredCapabilities: ['output_files'],
};
const input = {
  expectedStoreId: 'store',
  sessionId: 'session',
  sourceHash: 'a'.repeat(64),
  page: 1,
  data: 'JVBERi0=',
};
test('local snapshot refuses remote endpoints before transmitting bytes', async () => {
  for (const endpoint of [
    'https://example.invalid',
    'http://localhost',
    'http://127.0.0.1.example.invalid',
  ]) {
    const client = createClient({ endpoint, token: 'fixture', expected });
    try {
      await expect(client.renderLocalPdfSnapshot(input)).rejects.toThrow(
        'local_preview_service_required',
      );
    } finally {
      client.disposeNetwork();
    }
  }
});
test('local snapshot uses authenticated loopback route and binds response page', async () => {
  let posts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer fixture');
      const url = new URL(request.url);
      if (url.pathname === '/v1/server') return Response.json(info);
      expect(url.pathname).toBe('/v1/sessions/session/preview/pdf-snapshot');
      expect(await request.json()).toEqual(input);
      posts++;
      return Response.json({ page: 2, totalPages: 2, mediaType: 'image/png', data: 'aA==' });
    },
  });
  const client = createClient({ endpoint: server.url.href, token: 'fixture', expected });
  try {
    await client.connect();
    await expect(client.renderLocalPdfSnapshot(input)).rejects.toThrow();
    expect(posts).toBe(1);
    await expect(
      client.renderLocalPdfSnapshot({ ...input, expectedStoreId: 'other' }),
    ).rejects.toThrow('store_identity_mismatch');
    expect(posts).toBe(1);
  } finally {
    client.disposeNetwork();
    server.stop(true);
  }
});
