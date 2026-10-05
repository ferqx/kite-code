import { expect, test } from 'bun:test';
import { type AgentClient, createClient } from '@kite-ai/client';
import { observeCommand, run } from '../../src';

const profile = { dataRoot: '/explicit-cli-response-fixture', name: 'test', accessKey: 'test' };

async function fixture(options: {
  submission: 'bad-json' | 'bad-dto' | 'oversized' | 'rejected' | 'unavailable';
  lookup?: 'unavailable' | 'wrong-store';
}) {
  const counts = { posts: 0, commandReads: 0, runReads: 0 };
  const intents: unknown[] = [];
  let committed = false;
  const command = {
    id: 'original-command',
    sessionId: 'original-session',
    originStoreId: 'original-store',
    kind: 'run.start',
    status: 'applied',
    receipt: { runId: 'original-run' },
    cancelRequestedAt: null,
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/server')
        return Response.json({
          profile,
          instanceId: 'instance',
          buildId: 'build',
          apiMajor: 1,
          storeId: 'original-store',
          capabilities: ['commands'],
          dataAvailability: 'available',
        });
      if (request.method === 'POST') {
        counts.posts++;
        intents.push(await request.json());
        if (options.submission === 'rejected')
          return Response.json(
            {
              code: 'permission_denied',
              message: 'Rejected before acceptance.',
              scope: 'request',
              requestId: 'rejected',
              retryable: false,
            },
            { status: 403 },
          );
        if (options.submission === 'unavailable')
          return Response.json(
            {
              code: 'service_unavailable',
              message: 'Unconfirmed.',
              scope: 'request',
              requestId: 'unavailable',
              retryable: false,
            },
            { status: 503 },
          );
        // Persist the original acceptance before deliberately corrupting only the response.
        committed = true;
        if (options.submission === 'bad-json') return new Response('{');
        if (options.submission === 'oversized') return new Response('x'.repeat(5000));
        return Response.json({ ...command, originStoreId: undefined });
      }
      if (path === '/v1/commands/original-command') {
        counts.commandReads++;
        if (options.lookup === 'unavailable' || !committed) return new Response('{');
        return Response.json({
          ...command,
          originStoreId: options.lookup === 'wrong-store' ? 'other-store' : command.originStoreId,
        });
      }
      if (path === '/v1/runs/original-run') {
        counts.runReads++;
        return Response.json({
          id: 'original-run',
          sessionId: command.sessionId,
          originStoreId: command.originStoreId,
          originCommandId: command.id,
          status: 'completed',
          isActive: false,
          createdAt: 1,
          finishedAt: 2,
          reason: null,
        });
      }
      return new Response('Unexpected route', { status: 404 });
    },
  });
  const client = createClient({
    endpoint: server.url.origin,
    token: 'private-fixture-token',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['commands'] },
    maxResponseBytes: 4096,
  });
  try {
    await client.connect();
    const lines: string[] = [];
    const intent = {
      kind: 'run.start' as const,
      expectedStoreId: command.originStoreId,
      commandId: command.id,
      content: 'Harmless original intent',
    };
    const outcome = await run(command.sessionId, intent, {
      client,
      write: (line) => lines.push(line),
    });
    expect(intents).toEqual([intent]);
    expect(counts.posts).toBe(1);
    return { outcome, counts, lines, committed };
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
}

test('committed POST with malformed JSON, invalid DTO or oversized response queries only its original command', async () => {
  for (const submission of ['bad-json', 'bad-dto', 'oversized'] as const) {
    const actual = await fixture({ submission });
    expect(actual.committed).toBe(true);
    expect(actual.outcome).toEqual({
      commandId: 'original-command',
      status: 'succeeded',
      exitCode: 0,
    });
    expect(actual.counts.commandReads).toBe(2);
    expect(actual.counts.runReads).toBe(1);
    expect(actual.lines).toContain('accepted original-command');
  }
});

test('unverifiable original lookup and foreign Store remain unknown without a replacement submission', async () => {
  for (const lookup of ['unavailable', 'wrong-store'] as const) {
    const actual = await fixture({ submission: 'bad-json', lookup });
    expect(actual.outcome).toEqual({
      commandId: 'original-command',
      status: 'outcome_unknown',
      exitCode: 2,
    });
    expect(actual.counts.commandReads).toBe(1);
    expect(actual.counts.runReads).toBe(0);
  }
});

test('validated explicit rejection is failed, while server failure still checks the original command', async () => {
  const rejected = await fixture({ submission: 'rejected' });
  expect(rejected.outcome.status).toBe('failed');
  expect(rejected.counts.commandReads).toBe(0);
  const unavailable = await fixture({ submission: 'unavailable' });
  expect(unavailable.outcome.status).toBe('outcome_unknown');
  expect(unavailable.counts.commandReads).toBe(1);
});

test('unadmitted Client is a known preflight failure with zero business requests', async () => {
  const client = createClient({
    endpoint: 'http://127.0.0.1:1',
    token: 'unused',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['commands'] },
  });
  const outcome = await run(
    'original-session',
    {
      kind: 'run.start',
      expectedStoreId: 'original-store',
      commandId: 'original-command',
      content: 'Harmless',
    },
    { client, write() {} },
  );
  expect(outcome).toEqual({ commandId: 'original-command', status: 'failed', exitCode: 1 });
  client.disposeNetwork();
});

test('observation never submits the saved intent and Ctrl+C cancels only its original command', async () => {
  for (const cancelled of [false, true]) {
    let mutations = 0;
    const cancellations: unknown[] = [];
    const client = {
      async startRun() {
        mutations++;
        throw new Error('Must not submit');
      },
      async invokeExtension() {
        mutations++;
        throw new Error('Must not submit');
      },
      async getCommand(id: string) {
        expect(id).toBe('saved');
        return {
          id,
          sessionId: 's',
          originStoreId: 'store',
          kind: 'run.start',
          status: 'applied',
          receipt: { runId: 'r' },
          cancelRequestedAt: null,
        };
      },
      async cancelCommand(sessionId: string, request: unknown) {
        expect(sessionId).toBe('s');
        cancellations.push(request);
      },
      async getRun() {
        return {
          id: 'r',
          sessionId: 's',
          originStoreId: 'store',
          originCommandId: 'saved',
          status: cancelled ? 'cancelled' : 'completed',
          isActive: false,
        };
      },
    } as unknown as AgentClient;
    const signal = new AbortController();
    if (cancelled) signal.abort();
    const outcome = await observeCommand(
      's',
      {
        kind: 'run.start',
        expectedStoreId: 'store',
        commandId: 'saved',
        content: 'Original intent',
      },
      { client, signal: signal.signal, write() {} },
    );
    expect(outcome.status).toBe(cancelled ? 'cancelled' : 'succeeded');
    expect(outcome.cancellationAttempted).toBe(cancelled ? true : undefined);
    expect(mutations).toBe(0);
    expect(cancellations.length).toBe(cancelled ? 1 : 0);
    if (cancelled)
      expect(cancellations[0]).toMatchObject({
        kind: 'command.cancel',
        expectedStoreId: 'store',
        targetCommandId: 'saved',
      });
  }
});

test('observation cannot adopt another Store or replace an unverifiable original intent', async () => {
  for (const unavailable of [false, true]) {
    let reads = 0;
    const client = {
      async getCommand(id: string) {
        reads++;
        expect(id).toBe('saved');
        if (unavailable) throw new Error('Unavailable original lookup');
        return { id, sessionId: 's', originStoreId: 'other-store', receipt: {} };
      },
    } as unknown as AgentClient;
    const outcome = await observeCommand(
      's',
      {
        kind: 'run.start',
        expectedStoreId: 'store',
        commandId: 'saved',
        content: 'Original intent',
      },
      { client, write() {} },
    );
    expect(outcome.status).toBe('outcome_unknown');
    expect(reads).toBe(1);
  }
});
