import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createClient, type ResumeJobReportRequest, validateRequest } from '../../src';

test('Job report resume is a closed exact original intent; absent capability, malformed receipt and physical lost reply never retry', async () => {
  const profile = { dataRoot: '/owned', name: 'new', accessKey: 'owned' };
  let capabilities = ['commands'],
    posts = 0,
    gets = 0,
    mode = 'correct';
  const bodies: ResumeJobReportRequest[] = [];
  const command = (id: string) => ({
    id,
    sessionId: 's',
    kind: 'job.report.resume',
    status: 'applied' as const,
    originStoreId: 'store',
    cancelRequestedAt: null,
    receipt: { reportCommandId: 'report', runId: 'report-run', outcome: 'report_resumed' },
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
    expect(req.url).toBe('/v1/sessions/s/job-reports/report/resume');
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ResumeJobReportRequest;
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
    if (mode === 'suppressed' || mode === 'bad_suppression') {
      res.end(
        JSON.stringify({
          ...reply,
          receipt: {
            reportCommandId: 'report',
            runId: mode === 'suppressed' ? null : 'fake-run',
            outcome: 'report_suppressed',
            reason: 'context_selection_changed',
          },
        }),
      );
      return;
    }
    if (mode === 'wrong_id') reply.id = 'another';
    if (mode === 'wrong_session') reply.sessionId = 'another';
    if (mode === 'wrong_store') reply.originStoreId = 'another';
    if (mode === 'wrong_report') reply.receipt.reportCommandId = 'another';
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
    const input: ResumeJobReportRequest = { expectedStoreId: 'store', commandId: 'original' };
    await fail(() => client.resumeJobReport('s', 'report', input), 'capability_unavailable');
    expect(posts).toBe(0);
    capabilities = ['commands', 'job_report_resume'];
    await client.connect();
    expect(() =>
      validateRequest('ResumeJobReportRequest', { ...input, subjectId: 'spoof' }),
    ).toThrow();
    await fail(
      () => client.resumeJobReport('s', 'report', { ...input, expectedStoreId: 'other' }),
      'store_identity_mismatch',
    );
    await fail(() => client.resumeJobReport('s', 'bad/report', input), 'invalid_request');
    expect(posts).toBe(0);
    const pending = client.resumeJobReport('s', 'report', input);
    input.commandId = 'changed-after-call';
    const good = await pending;
    expect(good.id).toBe('original');
    expect(bodies).toEqual([{ expectedStoreId: 'store', commandId: 'original' }]);
    mode = 'suppressed';
    const suppressed = await client.resumeJobReport('s', 'report', {
      expectedStoreId: 'store',
      commandId: 'suppressed',
    });
    expect(suppressed.receipt).toEqual({
      reportCommandId: 'report',
      runId: null,
      outcome: 'report_suppressed',
      reason: 'context_selection_changed',
    });
    for (const invalid of [
      'wrong_id',
      'wrong_session',
      'wrong_store',
      'wrong_report',
      'wrong_kind',
      'wrong_outcome',
      'bad_suppression',
    ]) {
      mode = invalid;
      const before = posts;
      await fail(
        () =>
          client.resumeJobReport('s', 'report', { expectedStoreId: 'store', commandId: invalid }),
        'network_outcome_unknown',
      );
      expect(posts).toBe(before + 1);
    }
    mode = 'drop';
    const before = posts;
    await fail(
      () => client.resumeJobReport('s', 'report', { expectedStoreId: 'store', commandId: 'lost' }),
      'network_outcome_unknown',
    );
    expect(posts).toBe(before + 1);
    expect(await client.getCommand('lost')).toEqual(command('lost'));
    expect(gets).toBe(1);
    expect(posts).toBe(before + 1);
    expect(bodies.at(-1)).toEqual({ expectedStoreId: 'store', commandId: 'lost' });
    mode = 'conflict';
    await fail(
      () =>
        client.resumeJobReport('s', 'report', { expectedStoreId: 'store', commandId: 'conflict' }),
      'command_conflict',
    );
  } finally {
    client.disposeNetwork();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
