import { expect, test } from 'bun:test';
import { createClient, type WebSearchEvidence, type WebSearchSettingsView } from '../../src';

const profile = { dataRoot: '/fixture', name: 'websearch', accessKey: 'fixture' };
const info = {
  apiMajor: 1,
  instanceId: 'instance',
  buildId: 'build',
  profile,
  subjectId: 'owner',
  storeId: 'store',
  dataAvailability: 'available',
  capabilities: ['web_search_evidence', 'web_search_settings', 'web_search_test'],
};
const evidence: WebSearchEvidence = {
  schema: 'kite.web-search',
  schemaVersion: 1,
  storeId: 'store',
  sessionId: 'session',
  executionId: 'model',
  revision: 1,
  blocks: [
    {
      callId: 'call',
      route: 'native',
      provider: 'fixture',
      status: 'completed',
      truncated: false,
      sources: [{ url: 'HTTPS://example.test' }],
      citations: [
        {
          url: 'https://example.test',
          anchor: {
            executionId: 'model',
            blockIndex: 0,
            textSha256: 'a'.repeat(64),
            blockLengthUtf16: 4,
            startUtf16: 1,
            endUtf16: 3,
          },
        },
      ],
    },
  ],
};
const scope = { storeId: 'store', sessionId: 'session' };
const digest = 'a'.repeat(64);
const readSet = {
  userEtag: digest,
  workspaceEtag: null,
  effectiveDigest: digest,
  explicitDigest: digest,
};
const command = {
  id: 'test',
  kind: 'extension.invoke',
  sessionId: 'session',
  subjectId: 'owner',
  originStoreId: 'store',
  status: 'applied',
  receipt: {},
  cancelRequestedAt: null,
};

test('native evidence validates the execution, URLs, bounds and closed DTOs from an admitted peer', async () => {
  let selected: unknown = evidence;
  let business = 0;
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/server') return Response.json(info);
      business++;
      methods.push(request.method);
      return Response.json(selected);
    },
  });
  const client = createClient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: 'fixture',
    expected: { profile, apiMajor: 1, requiredCapabilities: info.capabilities },
  });
  const read = () => client.getWebSearchEvidence('model', scope);
  try {
    await client.connect();
    expect(await read()).toEqual(evidence);
    const first = evidence.blocks[0]!;
    for (const mutation of [
      { ...evidence, storeId: 'other' },
      { ...evidence, sessionId: 'other' },
      { ...evidence, executionId: 'other' },
      { ...evidence, revision: 0 },
      { ...evidence, revision: 2, blocks: [first, first] },
      { ...evidence, secret: 'unrecognized' },
      {
        ...evidence,
        blocks: [{ ...first, sources: [{ url: 'https://example.test', authorization: 'secret' }] }],
      },
      {
        ...evidence,
        blocks: [
          {
            ...first,
            citations: [
              {
                ...first.citations[0],
                anchor: { ...first.citations[0]!.anchor, executionId: 'other' },
              },
            ],
          },
        ],
      },
      {
        ...evidence,
        blocks: [
          {
            ...first,
            citations: [
              { ...first.citations[0], anchor: { ...first.citations[0]!.anchor, endUtf16: 5 } },
            ],
          },
        ],
      },
      ...[
        'file:///tmp/x',
        'https://user:secret@example.test',
        'https://example.test:bad',
        'https://example.test/\u0001',
      ].map((url) => ({ ...evidence, blocks: [{ ...first, sources: [{ url }] }] })),
    ]) {
      selected = mutation;
      await expect(read()).rejects.toBeInstanceOf(Error);
    }
    const before = business;
    await expect(
      client.getWebSearchEvidence('model', { ...scope, storeId: 'other' }),
    ).rejects.toMatchObject({ code: 'store_identity_mismatch' });
    await expect(client.getWebSearchEvidence('../other', scope)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(business).toBe(before);
    selected = { ...evidence, extra: 'x'.repeat(1024 * 1024) };
    await expect(read()).rejects.toMatchObject({ code: 'response_too_large' });
    expect(methods.every((method) => method === 'GET')).toBe(true);
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
});

test('explicit search test rejects forged commands and unsafe settings without retrying a chargeable request', async () => {
  let selected: unknown = command;
  let posts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/server') return Response.json(info);
      if (request.method === 'POST') posts++;
      return Response.json(selected);
    },
  });
  const client = createClient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: 'fixture',
    expected: { profile, apiMajor: 1, requiredCapabilities: info.capabilities },
  });
  const input = {
    expectedStoreId: 'store',
    commandId: 'test',
    sessionId: 'session',
    expectedReadSet: readSet,
  };
  try {
    await client.connect();
    for (const change of [
      { id: 'other' },
      { originStoreId: 'other' },
      { sessionId: 'other' },
      { subjectId: 'other' },
      { kind: 'run.start' },
    ]) {
      selected = { ...command, ...change };
      const prior = posts;
      await expect(client.testWebSearch(input)).rejects.toMatchObject({
        code: 'network_outcome_unknown',
      });
      expect(posts).toBe(prior + 1);
    }
    const prior = posts;
    await expect(
      client.testWebSearch({ ...input, expectedReadSet: { ...readSet, workspaceEtag: digest } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(posts).toBe(prior);
    const connection = {
      providerAlias: 'alias',
      name: 'Configured model provider',
      adapter: 'openai-search' as const,
    };
    const view: WebSearchSettingsView = {
      storeId: 'store',
      readSet,
      webSearch: { mode: 'auto' },
      searchProviders: [],
      errors: [],
      eligibleConnections: [connection],
    };
    selected = view;
    expect(await client.getWebSearchSettings({ storeId: 'store' })).toEqual(view);
    selected = { ...view, eligibleConnections: [{ ...connection, credentialRef: 'private' }] };
    await expect(client.getWebSearchSettings({ storeId: 'store' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const attempt = client.saveWebSearchSettings({
      ...input,
      webSearch: { mode: 'auto' },
      searchProviders: [],
      eligibleConnections: [connection],
    } as unknown as Parameters<typeof client.saveWebSearchSettings>[0]);
    await expect(attempt).rejects.toMatchObject({ code: 'invalid_request' });
    selected = { ...view, credential: { secret: 'fixture' } };
    await expect(client.getWebSearchSettings({ storeId: 'store' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
});
