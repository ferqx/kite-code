import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { createClient, type StartCommandRequest, validateRequest } from '../../src';

test('per-Run selection requires actual capability including empty selection and preserves physical lost reply intent without POST retry', async () => {
  const profile = { dataRoot: '/owned', name: 'new', accessKey: 'owned' };
  let capabilities = ['commands', 'inputs'];
  let posts = 0;
  const received: unknown[] = [];
  let replyPhase: 'empty-json' | 'lost-reply' = 'empty-json';
  let emptyReplySocket: Socket | undefined;
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
    if (replyPhase === 'empty-json') {
      // Complete real HTTP framing, but no JSON value: the Client must reject parsing.
      emptyReplySocket = request.socket;
      response.setHeader('content-type', 'application/json');
      response.end();
      return;
    }
    // The original physical loss occurs before any response headers or body exist.
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
    // The first Client rejection confirms the empty response was actually consumed.
    // Closing this socket is cleanup, not the physical lost-reply injection below.
    if (!emptyReplySocket) throw Error('empty_json_response_socket_missing');
    if (!emptyReplySocket.closed) {
      const emptyClosed = new Promise<void>((resolve) => emptyReplySocket!.once('close', resolve));
      emptyReplySocket.destroy();
      await emptyClosed;
    }
    replyPhase = 'lost-reply';
    const lostIntent = {
      ...structuredClone(received[0] as StartCommandRequest),
      commandId: 'physical-lost-original',
    };
    const expectedLost = structuredClone(lostIntent);
    const lostPending = client.startRun('s', lostIntent);
    lostIntent.commandId = 'physical-lost-replacement';
    lostIntent.selectedSkills![0] = 'later-mutated';
    await failed(lostPending, 'network_outcome_unknown');
    expect(posts).toBe(2);
    expect(received.slice(1)).toEqual([expectedLost]);
    console.log(
      JSON.stringify({
        emptyJSON: { actualResponseConsumed: true, error: 'invalid_response', posts: 1 },
        physicalLostReply: { responseStarted: false, error: 'network_outcome_unknown', posts: 1 },
        originalSelectionSnapshotPreserved: true,
      }),
    );
  } finally {
    client.disposeNetwork();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
