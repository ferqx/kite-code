import { expect, test } from 'bun:test';
import { type AnswerInteractionRequest, createClient } from '../src';

test('Interaction reads and answers require admission/capability and validate closed original write intents before HTTP', async () => {
  let requests = 0;
  let capabilities: string[] = ['sessions'];
  const profile = { dataRoot: '/selected-disposable', name: 'new', accessKey: 'selected-access' };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests++;
      if (new URL(request.url).pathname !== '/v1/server')
        throw new Error('Unexpected business HTTP request');
      return Response.json({
        instanceId: 'fixture',
        buildId: 'fixture',
        apiMajor: 1,
        capabilities,
        profile,
        dataAvailability: 'available',
        storeId: 'store',
      });
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private-header-only',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const answer: AnswerInteractionRequest = {
    expectedStoreId: 'original-store',
    commandId: 'original-command',
    expectedRevision: '9223372036854775807',
    answer: { kind: 'approval', decision: 'approve' },
  };
  const operations = [
    () => client.listInteractions('root', { storeId: 'store' }),
    () => client.getInteraction('root', 'card', { storeId: 'store' }),
    () => client.answerInteraction('root', 'card', answer),
  ];
  try {
    for (const operation of operations) expect(operation).toThrow('connection_not_admitted');
    expect(requests).toBe(0);
    await client.connect();
    for (const operation of operations) expect(operation).toThrow('capability_unavailable');
    expect(requests).toBe(1);
    capabilities = ['sessions', 'interactions'];
    await client.connect();
    expect(() => client.listInteractions('root', { storeId: 'store', limit: 101 })).toThrow(
      'Invalid InteractionListQuery',
    );
    expect(() =>
      client.answerInteraction('root', 'card', {
        ...answer,
        subjectId: 'caller-authority',
      } as unknown as AnswerInteractionRequest),
    ).toThrow('Invalid AnswerInteractionRequest');
    expect(() =>
      client.answerInteraction('root', 'card', {
        ...answer,
        expectedRevision: '9223372036854775808',
      }),
    ).toThrow('signed SQLite 64-bit range');
    expect(requests).toBe(2);
    expect(answer.expectedStoreId).toBe('original-store');
    expect(answer.commandId).toBe('original-command');
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
});
