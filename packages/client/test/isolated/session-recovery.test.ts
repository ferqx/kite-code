import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import {
  createClient,
  decodeSessionRecoveryCommand,
  type RecoverSessionRequest,
  type RecoverSessionResponse,
  validateRequest,
} from '../../src';

test('Session recovery client rejects unqualified or malformed authority and preserves the single original mutation on unknown wire responses', async () => {
  const profile = { dataRoot: '/owned', name: 'recovery', accessKey: 'owned' };
  let capabilities = ['commands'];
  let mode = 'good',
    posts = 0,
    gets = 0;
  let entered!: () => void, release!: () => void;
  let held: Promise<void> | undefined;
  const requests: RecoverSessionRequest[] = [];
  const response = (id: string): RecoverSessionResponse => ({
    id,
    sessionId: 's',
    originStoreId: 'store',
    kind: 'session.recover',
    status: 'applied',
    cancelRequestedAt: null,
    receipt: {
      kind: 'session_interrupted',
      sessionId: 's',
      storeId: 'store',
      interruptedRunIds: ['original-run'],
      settledExecutionIds: [],
      unknownExecutionIds: ['original-tool'],
      cancelledExecutionIds: [],
      partialMessageIds: ['original-partial'],
      snapshotCursor: '9007199254740993',
    },
  });
  const server = createServer(async (request, reply) => {
    reply.setHeader('content-type', 'application/json');
    if (request.url === '/v1/server') {
      reply.end(
        JSON.stringify({
          instanceId: 'instance',
          buildId: 'build',
          apiMajor: 1,
          profile,
          capabilities,
          storeId: 'store',
          dataAvailability: 'available',
        }),
      );
      return;
    }
    if (request.method === 'GET') {
      gets++;
      reply.end(JSON.stringify(response(request.url!.split('/').at(-1)!)));
      return;
    }
    posts++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as RecoverSessionRequest;
    requests.push(input);
    expect(request.url).toBe('/v1/sessions/s/commands');
    if (held) {
      entered();
      await held;
    }
    const result = response(input.commandId);
    if (mode === 'lost') {
      request.socket.destroy();
      return;
    }
    if (mode === 'invalid_json') reply.end('{');
    else if (mode === 'wrong_id') reply.end(JSON.stringify({ ...result, id: 'other' }));
    else if (mode === 'wrong_store')
      reply.end(JSON.stringify({ ...result, originStoreId: 'other' }));
    else if (mode === 'wrong_session') reply.end(JSON.stringify({ ...result, sessionId: 'other' }));
    else if (mode === 'wrong_target')
      reply.end(
        JSON.stringify({
          ...result,
          receipt: { ...result.receipt, sessionId: 'other' },
        }),
      );
    else if (mode === 'wrong_receipt_store')
      reply.end(
        JSON.stringify({
          ...result,
          receipt: { ...result.receipt, storeId: 'other' },
        }),
      );
    else if (mode === 'private_fence')
      reply.end(
        JSON.stringify({
          ...result,
          receipt: { ...result.receipt, generation: '123' },
        }),
      );
    else if (mode === 'wrong_kind') reply.end(JSON.stringify({ ...result, kind: 'run.resume' }));
    else if (mode === 'too_large') reply.end(' '.repeat(8192));
    else reply.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createClient({
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: 'owned-token',
    maxResponseBytes: 4096,
    expected: {
      apiMajor: 1,
      profile,
      instanceId: 'instance',
      buildId: 'build',
      requiredCapabilities: ['commands'],
    },
  });
  const input: RecoverSessionRequest = {
    kind: 'session.recover',
    expectedStoreId: 'store',
    commandId: 'original',
    decision: 'interrupt',
  };
  try {
    await client.connect();
    expect(await client.recoverSession('s', input).catch((error: unknown) => error)).toMatchObject({
      code: 'capability_unavailable',
    });
    expect(posts).toBe(0);
    capabilities = ['commands', 'session_recovery'];
    await client.connect();
    for (const changed of [
      { generation: '1' },
      { expectedOwnerGeneration: '1' },
      { subjectId: 'forged' },
      { owner: 'forged' },
      { decision: 'resume' },
      { kind: 'run.resume' },
    ])
      expect(() => validateRequest('RecoverSessionRequest', { ...input, ...changed })).toThrow(
        'Invalid RecoverSessionRequest',
      );
    expect(
      await client
        .recoverSession('s', { ...input, expectedStoreId: 'other' })
        .catch((error: unknown) => error),
    ).toMatchObject({ code: 'store_identity_mismatch' });
    expect(posts).toBe(0);
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutable = structuredClone(input);
    const running = client.recoverSession('s', mutable);
    await seen;
    mutable.commandId = 'replacement';
    mutable.expectedStoreId = 'other';
    release();
    expect(await running).toEqual(response('original'));
    expect(requests).toEqual([input]);
    expect(posts).toBe(1);
    expect(gets).toBe(0);
    held = undefined;
    for (const value of [
      'lost',
      'invalid_json',
      'wrong_id',
      'wrong_store',
      'wrong_session',
      'wrong_target',
      'wrong_receipt_store',
      'private_fence',
      'wrong_kind',
      'too_large',
    ]) {
      mode = value;
      const original = { ...input, commandId: value };
      const before = posts,
        beforeGets = gets;
      expect(
        await client.recoverSession('s', original).catch((error: unknown) => error),
      ).toMatchObject({ code: 'network_outcome_unknown' });
      expect(posts).toBe(before + 1);
      expect(gets).toBe(beforeGets);
      const receipt = decodeSessionRecoveryCommand(await client.getCommand(original.commandId));
      expect(receipt).toEqual(response(original.commandId));
      expect(receipt.receipt.unknownExecutionIds).toEqual(['original-tool']);
      expect(receipt.receipt.snapshotCursor).toBe('9007199254740993');
      expect(posts).toBe(before + 1);
      expect(gets).toBe(beforeGets + 1);
    }
    expect(() =>
      decodeSessionRecoveryCommand({ ...response('original'), status: 'accepted', receipt: null }),
    ).toThrow('Invalid RecoverSessionResponse');
  } finally {
    release?.();
    client.disposeNetwork();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
