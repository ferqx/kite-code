import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import {
  createClient,
  decodeRunResumeCommand,
  type ResumeRunRequest,
  validateRequest,
} from '../../src';

test('Run resume preserves the frozen original identity and never replays a lost or invalid response', async () => {
  const profile = { dataRoot: '/owned', name: 'resume', accessKey: 'owned' };
  let capabilities = ['commands'];
  let mode = 'good';
  let posts = 0;
  let gets = 0;
  const bodies: ResumeRunRequest[] = [];
  const response = (id: string) => ({
    id,
    sessionId: 's',
    originStoreId: 'store',
    kind: 'run.resume',
    status: 'applied',
    cancelRequestedAt: null,
    receipt: {
      outcome: 'run_resumed',
      runId: 'original-run',
      originalCommandId: 'original-work',
      boundary: 'tool_calls',
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
    if (request.method === 'GET' && request.url?.startsWith('/v1/commands/')) {
      gets++;
      reply.end(JSON.stringify(response(request.url.split('/').at(-1)!)));
      return;
    }
    posts++;
    expect(request.url).toBe('/v1/sessions/s/commands');
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString()) as ResumeRunRequest;
    bodies.push(body);
    if (mode === 'drop') {
      request.socket.destroy();
      return;
    }
    if (mode === 'conflict') {
      reply.statusCode = 409;
      reply.end(
        JSON.stringify({
          code: 'owner_changed',
          message: 'Owner changed',
          scope: 'request',
          requestId: 'fixture',
          retryable: false,
        }),
      );
      return;
    }
    const result = response(body.commandId);
    if (mode === 'accepted') {
      reply.end(JSON.stringify({ ...result, status: 'accepted', receipt: null }));
      return;
    }
    if (mode === 'wrong_run') result.receipt.runId = 'other-run';
    if (mode === 'wrong_store') result.originStoreId = 'other-store';
    if (mode === 'wrong_session') result.sessionId = 'other-session';
    if (mode === 'wrong_id') result.id = 'other-command';
    if (mode === 'wrong_kind') result.kind = 'run.start';
    if (mode === 'wrong_boundary') result.receipt.boundary = 'unverified';
    if (mode === 'missing_original')
      delete (result.receipt as { originalCommandId?: string }).originalCommandId;
    reply.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createClient({
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: 'owned',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const input: ResumeRunRequest = {
    kind: 'run.resume',
    expectedStoreId: 'store',
    commandId: 'resume-original',
    runId: 'original-run',
  };
  const fail = async (operation: Promise<unknown>, code: string) => {
    const error = await operation.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code: string }).code).toBe(code);
  };
  try {
    await client.connect();
    await fail(client.resumeRun('s', input), 'capability_unavailable');
    expect(posts).toBe(0);
    capabilities = ['commands', 'run_resume'];
    await client.connect();
    expect(() => validateRequest('ResumeRunRequest', { ...input, owner: 'spoof' })).toThrow();
    expect(() =>
      validateRequest('ResumeRunRequest', { ...input, expectedOwnerGeneration: '7' }),
    ).toThrow();
    await fail(
      client.resumeRun('s', { ...input, expectedStoreId: 'old-store' }),
      'store_identity_mismatch',
    );
    await fail(client.resumeRun('bad/path', input), 'invalid_request');
    expect(posts).toBe(0);
    const frozen = client.resumeRun('s', input);
    input.commandId = 'mutated-command';
    expect((await frozen).receipt).toMatchObject({ runId: 'original-run', outcome: 'run_resumed' });
    expect(bodies[0]!.commandId).toBe('resume-original');
    mode = 'accepted';
    expect(await client.resumeRun('s', { ...input, commandId: mode })).toMatchObject({
      status: 'accepted',
      receipt: null,
    });
    for (const invalid of [
      'wrong_run',
      'wrong_store',
      'wrong_session',
      'wrong_id',
      'wrong_kind',
      'wrong_boundary',
      'missing_original',
    ]) {
      mode = invalid;
      const before = posts;
      await fail(client.resumeRun('s', { ...input, commandId: mode }), 'network_outcome_unknown');
      expect(posts).toBe(before + 1);
    }
    mode = 'conflict';
    await fail(client.resumeRun('s', { ...input, commandId: mode }), 'owner_changed');
    mode = 'drop';
    const before = posts;
    await fail(
      client.resumeRun('s', { ...input, commandId: 'lost-original' }),
      'network_outcome_unknown',
    );
    expect(posts).toBe(before + 1);
    expect(gets).toBe(0);
    const original = decodeRunResumeCommand(await client.getCommand('lost-original'));
    expect(original.id).toBe('lost-original');
    expect(original.receipt).toMatchObject({
      runId: 'original-run',
      originalCommandId: 'original-work',
    });
    expect(gets).toBe(1);
    expect(posts).toBe(before + 1);
  } finally {
    client.disposeNetwork();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
