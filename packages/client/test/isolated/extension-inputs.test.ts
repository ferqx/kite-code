import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createClient, type StartCommandRequest, validateRequest } from '../../src';

test('per-Run extension inputs require actual capability including an empty envelope and preserves physical lost reply intent without POST retry', async () => {
  const profile = { dataRoot: '/owned', name: 'new', accessKey: 'owned' };
  let capabilities = ['commands', 'inputs'];
  let posts = 0;
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/server') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          instanceId: 'owned',
          buildId: 'owned',
          apiMajor: 1,
          profile,
          capabilities,
          storeId: 'store',
          dataAvailability: 'available',
        }),
      );
      return;
    }
    posts++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    request.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const client = createClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    token: 'private',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const failed = async (work: Promise<unknown>, code?: string) => {
    const error = await work.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    if (code) expect((error as { code?: string }).code).toBe(code);
  };
  try {
    await client.connect();
    const intent: StartCommandRequest = {
      kind: 'run.start',
      expectedStoreId: 'store',
      commandId: 'original',
      content: 'text',
      extensionInputs: [],
    };
    await failed(
      Promise.resolve().then(() => client.startRun('s', intent)),
      'capability_unavailable',
    );
    await failed(
      Promise.resolve().then(() =>
        client.followUp('s', {
          kind: 'input.follow_up',
          expectedStoreId: 'store',
          commandId: 'follow',
          content: 'text',
          afterRunId: null,
          contextSelectionId: 'selection',
          extensionInputs: [],
        }),
      ),
      'capability_unavailable',
    );
    expect(posts).toBe(0);
    capabilities = [...capabilities, 'run_extension_inputs'];
    await client.connect();
    for (const extensionInputs of [
      null,
      [{}],
      [{ extensionId: 'x', definitionVersion: '1', input: null, authority: true }],
      [{ extensionId: 'x', definitionVersion: '1' }],
    ])
      expect(() =>
        validateRequest('StartCommandRequest', { ...intent, extensionInputs }),
      ).toThrow();
    await failed(
      Promise.resolve().then(() => client.startRun('s', null as unknown as StartCommandRequest)),
      'invalid_request',
    );
    expect(() =>
      validateRequest('StartCommandRequest', {
        ...intent,
        extensionInputs: Array.from({ length: 65 }, () => ({
          extensionId: 'a',
          definitionVersion: '1',
          input: 'x'.repeat(1000),
        })),
      }),
    ).not.toThrow();
    const array = [
      { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
      { extensionId: 'a', definitionVersion: '2', input: null },
      { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
    ];
    intent.extensionInputs = array;
    const pending = client.startRun('s', intent);
    array[0]!.input = { text: 'mutated' };
    intent.commandId = 'replacement';
    await failed(pending, 'invalid_response');
    expect(posts).toBe(1);
    expect(received).toEqual([
      {
        kind: 'run.start',
        expectedStoreId: 'store',
        commandId: 'original',
        content: 'text',
        extensionInputs: [
          { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
          { extensionId: 'a', definitionVersion: '2', input: null },
          { extensionId: 'b', definitionVersion: '1', input: { text: 'first' } },
        ],
      },
    ]);
  } finally {
    client.disposeNetwork();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
