import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createClient, type ReconcileJobRequest } from '@kite-ai/client';
import { parseCLIArguments } from '../src/arguments';
import { lookupJobReconcile, reconcileJob } from '../src/job-reconcile';

test('CLI reconciliation preserves the original intent after a physical lost reply and never treats unknown supervision as verified', async () => {
  let posts = 0,
    gets = 0,
    mode = 'drop';
  const requests: ReconcileJobRequest[] = [];
  const profile = { dataRoot: '/owned', name: 'new', accessKey: 'owned' };
  const command = (id: string) => ({
    id,
    sessionId: 's',
    kind: 'job.reconcile',
    status: 'applied',
    originStoreId: 'store',
    cancelRequestedAt: null,
    receipt: {
      executionId: mode === 'wrong' ? 'different-job' : 'job',
      resultRevision: '1',
      outcome: mode === 'unresolved' ? 'unresolved' : 'verified',
      supervision: mode === 'unresolved' || mode === 'invalid' ? 'unknown' : 'ended',
      result: { outcome: 'succeeded', content: 'Original external result' },
      evidence: { exact: 'original-reference' },
      evidenceSource: 'adapter_reconcile',
      reason: null,
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
          capabilities: ['commands', 'job_reconcile'],
          storeId: 'store',
          dataAvailability: 'available',
        }),
      );
      return;
    }
    if (req.method === 'GET') {
      gets++;
      res.end(JSON.stringify(command(req.url!.split('/').at(-1)!)));
      return;
    }
    posts++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ReconcileJobRequest;
    requests.push(body);
    if (mode === 'drop') {
      req.socket.destroy();
      return;
    }
    res.statusCode = 202;
    res.end(JSON.stringify(command(body.commandId)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = createClient({
    endpoint,
    token: 'owned',
    expected: {
      apiMajor: 1,
      instanceId: 'owned',
      profile,
      requiredCapabilities: ['commands', 'job_reconcile'],
    },
  });
  const written: string[] = [];
  const options = { client, write: (line: string) => written.push(line) };
  const intent = (commandId: string) => ({
    sessionId: 's',
    request: {
      kind: 'job.reconcile' as const,
      commandId,
      expectedStoreId: 'store',
      executionId: 'job',
      expectedResultRevision: '1',
    },
  });
  try {
    await client.connect();
    const original = intent('lost');
    const pending = reconcileJob(original, options);
    original.request.executionId = 'mutated-after-submit';
    const saved = await pending;
    expect(saved.status).toBe('verified');
    expect(saved.exitCode).toBe(0);
    expect(saved.intent).toEqual(intent('lost'));
    expect(posts).toBe(1);
    expect(gets).toBe(1);
    expect(requests).toEqual([intent('lost').request]);
    expect(JSON.parse(written[0]!)).toEqual({ kind: 'job.reconcile.intent', ...intent('lost') });
    expect(await reconcileJob(intent('lost'), options)).toBe(saved);
    await expect(reconcileJob(original, options)).rejects.toMatchObject({
      code: 'command_conflict',
    });
    expect(posts).toBe(1);
    mode = 'unresolved';
    expect((await reconcileJob(intent('unresolved'), options)).status).toBe('unresolved');
    expect((await lookupJobReconcile(intent('unresolved'), options)).exitCode).toBe(2);
    mode = 'invalid';
    expect((await reconcileJob(intent('invalid'), options)).status).toBe('outcome_unknown');
    mode = 'wrong';
    expect((await lookupJobReconcile(intent('lost'), options)).status).toBe('outcome_unknown');
    expect(posts).toBe(3);
  } finally {
    client.disposeNetwork();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Job reconcile has a distinct closed CLI command and cannot smuggle adapter authority', () => {
  const request = {
    kind: 'job.reconcile',
    expectedStoreId: 'store',
    commandId: 'reconcile',
    executionId: 'job',
    expectedResultRevision: '1',
  };
  const argv = [
    'job',
    'reconcile',
    'root',
    '--input',
    JSON.stringify(request),
    '--server',
    '/owned/socket',
  ];
  expect(parseCLIArguments(argv)).toEqual({
    kind: 'job',
    action: 'reconcile',
    sessionId: 'root',
    input: request,
    server: '/owned/socket',
  });
  for (const extra of [
    { owner: 'spoof' },
    { reference: 'spoof' },
    { expectedResultRevision: '01' },
    { kind: 'session.recover' },
  ])
    expect(() =>
      parseCLIArguments([
        'job',
        'reconcile',
        'root',
        '--input',
        JSON.stringify({ ...request, ...extra }),
      ]),
    ).toThrow();
  expect(() => parseCLIArguments([...argv, '--execution', 'second-target'])).toThrow();
  expect(() =>
    parseCLIArguments(['job', 'resume', 'root', '--input', JSON.stringify(request)]),
  ).toThrow();
  expect(parseCLIArguments(['resume', '--thread', 'root', '--task', 'Continue'])).toMatchObject({
    kind: 'resume',
    thread: 'root',
    task: 'Continue',
  });
});
