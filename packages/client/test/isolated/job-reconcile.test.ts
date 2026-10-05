import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import {
  createClient,
  decodeJobReconcileCommand,
  type ReconcileJobRequest,
  validateRequest,
} from '../../src';

test('Job reconcile is a closed exact original intent; absent capability, malformed receipt and physical lost reply never retry', async () => {
  const profile = { dataRoot: '/owned', name: 'new', accessKey: 'owned' };
  let capabilities = ['commands'],
    posts = 0,
    gets = 0,
    mode = 'correct';
  const bodies: ReconcileJobRequest[] = [];
  const command = (id: string) => ({
    id,
    sessionId: 's',
    kind: 'job.reconcile',
    status: 'applied' as const,
    originStoreId: 'store',
    cancelRequestedAt: null,
    receipt: {
      executionId: 'job',
      resultRevision: '1',
      outcome: 'verified',
      supervision: 'ended',
      result: { outcome: 'succeeded', content: 'external fact' },
      evidence: { source: 'original-query' },
      reason: null,
      evidenceSource: 'adapter_reconcile',
    },
  });
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/server') {
      res.end(
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
    if (req.method === 'GET' && req.url?.startsWith('/v1/commands/')) {
      gets++;
      res.end(JSON.stringify(command(req.url.split('/').at(-1)!)));
      return;
    }
    posts++;
    expect(req.url).toBe('/v1/sessions/s/commands');
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ReconcileJobRequest;
    bodies.push(body);
    if (mode === 'drop') {
      req.socket.destroy();
      return;
    }
    if (mode === 'conflict') {
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          code: 'command_conflict',
          message: 'conflict',
          scope: 'request',
          requestId: 'fixture',
          retryable: false,
        }),
      );
      return;
    }
    const reply = command(body.commandId);
    if (mode === 'accepted') {
      res.end(JSON.stringify({ ...reply, status: 'accepted', receipt: null }));
      return;
    }
    if (mode === 'unresolved') {
      res.end(
        JSON.stringify({
          ...reply,
          receipt: {
            ...reply.receipt,
            outcome: 'unresolved',
            supervision: 'running',
            result: null,
            reason: 'not_terminal',
          },
        }),
      );
      return;
    }
    if (mode === 'bad_supervision') reply.receipt.supervision = 'unknown';
    if (mode === 'bad_known_result') reply.receipt.result.outcome = 'outcome_unknown';
    if (mode === 'wrong_revision') reply.receipt.resultRevision = '2';
    if (mode === 'wrong_source') reply.receipt.evidenceSource = 'manual';
    if (mode === 'wrong_id') reply.id = 'another';
    if (mode === 'wrong_session') reply.sessionId = 'another';
    if (mode === 'wrong_store') reply.originStoreId = 'another';
    if (mode === 'wrong_execution') reply.receipt.executionId = 'another';
    if (mode === 'wrong_kind') reply.kind = 'run.start';
    if (mode === 'wrong_outcome') reply.receipt.outcome = 'made_up';
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number },
    client = createClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: 'private',
      expected: { profile, apiMajor: 1, requiredCapabilities: [] },
    });
  const fail = async (work: () => Promise<unknown>, code: string) => {
    const error = await Promise.resolve()
      .then(work)
      .catch((e) => e as unknown);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code: string }).code).toBe(code);
  };
  try {
    await client.connect();
    const input: ReconcileJobRequest = {
      kind: 'job.reconcile',
      expectedStoreId: 'store',
      commandId: 'original',
      executionId: 'job',
      expectedResultRevision: '1',
    };
    await fail(() => client.reconcileJob('s', input), 'capability_unavailable');
    expect(posts).toBe(0);
    capabilities = ['commands', 'job_reconcile'];
    await client.connect();
    expect(() =>
      validateRequest('ReconcileJobRequest', { ...input, subjectId: 'spoof' }),
    ).toThrow();
    await fail(
      () => client.reconcileJob('s', { ...input, expectedStoreId: 'other' }),
      'store_identity_mismatch',
    );
    await fail(() => client.reconcileJob('bad/session', input), 'invalid_request');
    expect(posts).toBe(0);
    const pending = client.reconcileJob('s', input);
    input.commandId = 'changed-after-call';
    const good = await pending;
    expect(good.id).toBe('original');
    expect(bodies).toEqual([
      {
        kind: 'job.reconcile',
        executionId: 'job',
        expectedResultRevision: '1',
        expectedStoreId: 'store',
        commandId: 'original',
      },
    ]);
    mode = 'accepted';
    expect((await client.reconcileJob('s', { ...input, commandId: 'accepted' })).status).toBe(
      'accepted',
    );
    mode = 'unresolved';
    const unresolved = await client.reconcileJob('s', { ...input, commandId: 'unresolved' });
    expect(unresolved.receipt).toMatchObject({
      outcome: 'unresolved',
      result: null,
      supervision: 'running',
    });
    for (const invalid of [
      'wrong_id',
      'wrong_session',
      'wrong_store',
      'wrong_execution',
      'wrong_kind',
      'wrong_outcome',
      'bad_supervision',
      'bad_known_result',
      'wrong_revision',
      'wrong_source',
    ]) {
      mode = invalid;
      const before = posts;
      await fail(
        () =>
          client.reconcileJob('s', {
            kind: 'job.reconcile',
            executionId: 'job',
            expectedResultRevision: '1',
            expectedStoreId: 'store',
            commandId: invalid,
          }),
        'network_outcome_unknown',
      );
      expect(posts).toBe(before + 1);
    }
    mode = 'drop';
    const before = posts;
    await fail(
      () =>
        client.reconcileJob('s', {
          kind: 'job.reconcile',
          executionId: 'job',
          expectedResultRevision: '1',
          expectedStoreId: 'store',
          commandId: 'lost',
        }),
      'network_outcome_unknown',
    );
    expect(posts).toBe(before + 1);
    expect(await client.getCommand('lost')).toEqual(command('lost'));
    expect(decodeJobReconcileCommand(await client.getCommand('lost')).kind).toBe('job.reconcile');
    expect(() => decodeJobReconcileCommand({ ...command('lost'), kind: 'other' })).toThrow();
    expect(gets).toBe(2);
    expect(posts).toBe(before + 1);
    expect(bodies.at(-1)).toEqual({
      kind: 'job.reconcile',
      executionId: 'job',
      expectedResultRevision: '1',
      expectedStoreId: 'store',
      commandId: 'lost',
    });
    mode = 'conflict';
    await fail(
      () =>
        client.reconcileJob('s', {
          kind: 'job.reconcile',
          executionId: 'job',
          expectedResultRevision: '1',
          expectedStoreId: 'store',
          commandId: 'conflict',
        }),
      'command_conflict',
    );
  } finally {
    client.disposeNetwork();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
