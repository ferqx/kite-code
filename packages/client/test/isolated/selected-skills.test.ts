import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createClient, type StartCommandRequest, validateRequest } from '../../src';

test('per-Run selection requires actual capability including empty selection and preserves physical lost reply intent without POST retry', async () => {
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
      selectedSkills: [],
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
          selectedSkills: [],
        }),
      ),
      'capability_unavailable',
    );
    expect(posts).toBe(0);
    capabilities = [...capabilities, 'run_skill_selection'];
    await client.connect();
    for (const selectedSkills of [null, [''], ['x'.repeat(129)], Array(257).fill('a')])
      expect(() => validateRequest('StartCommandRequest', { ...intent, selectedSkills })).toThrow();
    await failed(
      Promise.resolve().then(() => client.startRun('s', null as unknown as StartCommandRequest)),
      'invalid_request',
    );
    const array = ['b', 'a', 'b'];
    intent.selectedSkills = array;
    const pending = client.startRun('s', intent);
    array[0] = 'mutated';
    intent.commandId = 'replacement';
    await failed(pending, 'invalid_response');
    expect(posts).toBe(1);
    expect(received).toEqual([
      {
        kind: 'run.start',
        expectedStoreId: 'store',
        commandId: 'original',
        content: 'text',
        selectedSkills: ['b', 'a', 'b'],
      },
    ]);
  } finally {
    client.disposeNetwork();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
