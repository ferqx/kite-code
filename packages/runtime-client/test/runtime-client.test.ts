import { describe, expect, test } from 'bun:test';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  RUNTIME_CLIENT_BOUNDARY_,
  RuntimeClient,
  type RuntimeClientConnection,
  type RuntimeClientTransport,
  toAcceptedPresentationEnvelope,
} from '../src/index';

describe('Runtime Client boundary', () => {
  test('exposes only a framework-neutral logical transport seam', () => {
    expect(RUNTIME_CLIENT_BOUNDARY_).toEqual({
      frameworkNeutral: true,
      transport: 'logical-message',
      protocolSchema: 'kite.runtime-protocol.v2',
    });
    const transport = undefined as RuntimeClientTransport | undefined;
    expect(transport).toBeUndefined();
  });
});

describe('RuntimeClient protocol state machine', () => {
  test('accepts a late turn event from explicit admission identity after the snapshot settles', () => {
    const envelope = toAcceptedPresentationEnvelope(
      {
        schema: 'kite.runtime-notification.v2',
        durability: 'durable',
        sessionId: 'session-1',
        revision: 5,
        runId: 'run-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        projection: {
          kind: 'turn',
          session: session('session-1', 5),
          event: {
            type: 'subagent.failed',
            subagentId: 'subagent-1',
            summary: 'Cancelled during provider cleanup.',
          },
        },
      },
      1,
    );

    expect(envelope).toMatchObject({
      runId: 'run-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      event: { type: 'subagent.failed', subagentId: 'subagent-1' },
    });
  });

  test('rejects a predecessor envelope identity when the terminal event names a successor Run', () => {
    expect(() =>
      toAcceptedPresentationEnvelope(
        {
          schema: 'kite.runtime-notification.v2',
          durability: 'durable',
          sessionId: 'session-1',
          revision: 4,
          runId: 'run-predecessor',
          projection: {
            kind: 'turn',
            session: session('session-1', 4),
            event: { type: 'run.terminal', runId: 'run-successor', status: 'completed' },
          },
        },
        1,
      ),
    ).toThrow('Invalid AcceptedPresentationEnvelope');
  });

  test('uses the same initialized connection for durable History reads', async () => {
    const sessionEntry = {
      sessionId: 'session-history',
      displayName: 'History',
      needsSmartName: false,
      updatedAt: 10,
      lastSequence: 0,
    };
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-history')));
      } else if (message.method === 'history/list_sessions') {
        target.push(result(message.id, { entries: [sessionEntry], hasMore: false }));
      } else if (message.method === 'history/list_events') {
        target.push(
          result(message.id, {
            entries: [],
            hasMore: false,
            observedLastSequence: 0,
          }),
        );
      } else if (message.method === 'history/load_session') {
        target.push(
          result(message.id, {
            type: 'history_session_page',
            session: sessionEntry,
            records: [],
            interactionMode: 'auto',
            recovery: 'normal',
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    await expect(client.history?.listSessions({ limit: 10 })).resolves.toMatchObject({
      entries: [{ sessionId: 'session-history' }],
    });
    await expect(
      client.history?.listEvents({
        sessionId: 'session-history',
        direction: 'forward',
        limit: 10,
      }),
    ).resolves.toMatchObject({ observedLastSequence: 0 });
    await expect(client.history?.loadSession('session-history')).resolves.toMatchObject({
      session: { sessionId: 'session-history' },
      recovery: 'normal',
    });
    expect(connection.requests('initialize')).toHaveLength(1);
    await client.close();
  });

  test('bounds a thousand concurrent History loads before transport send', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('history-bounded')));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    await client.connect();
    const loads = Array.from({ length: 1041 }, (_, index) =>
      client.history!.loadSession(`session-${index}`),
    );
    const settled = Promise.allSettled(loads);
    try {
      await until(() => connection.requests('history/load_session').length === 4);
      expect(connection.requests('history/load_session')).toHaveLength(4);
      expect(await loads[1040]!.catch((error: unknown) => error)).toMatchObject({
        code: 'request_overloaded',
      });

      expect(connection.requests('history/load_child_session')).toHaveLength(0);
    } finally {
      await client.close();
      await settled;
    }
  });

  test('preserves a server overload as a typed client error', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('history-overload')));
      else if (message.method === 'history/load_session')
        target.push({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32001, message: 'Overloaded', data: { code: 'overloaded' } },
        });
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    try {
      await expect(client.history!.loadSession('session-overloaded')).rejects.toMatchObject({
        code: 'request_overloaded',
        protocol: { data: { code: 'overloaded' } },
      });
    } finally {
      await client.close();
    }
  });

  test('preserves the server History size detail as a typed client error', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('history-too-large')));
      else if (message.method === 'history/load_session')
        target.push({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32603,
            message: 'History too large',
            data: { code: 'internal_error', detailCode: 'history_too_large' },
          },
        });
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    try {
      await expect(client.history!.loadSession('session-too-large')).rejects.toMatchObject({
        code: 'history_too_large',
        protocol: { data: { detailCode: 'history_too_large' } },
      });
    } finally {
      await client.close();
    }
  });

  test('stops assembling a History transcript beyond 50,000 records', async () => {
    const lastSequence = 50_001;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('history-record-limit')));
      } else if (message.method === 'history/load_session') {
        const after = message.params.page?.afterSequence ?? 0;
        const end = Math.min(after + 10_000, lastSequence);
        target.push(
          result(message.id, {
            type: 'history_session_page',
            session: {
              sessionId: 'history-record-limit',
              displayName: 'History',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence,
            },
            records: Array.from({ length: end - after }, (_, index) => ({
              sequence: after + index + 1,
              events: [],
            })),
            ...(end < lastSequence ? { nextCursor: end } : {}),
            interactionMode: 'auto',
            recovery: 'normal',
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    try {
      await expect(client.history!.loadSession('history-record-limit')).rejects.toMatchObject({
        code: 'history_too_large',
      });
      expect(connection.requests('history/load_session')).toHaveLength(6);
    } finally {
      await client.close();
    }
  });

  test('stops assembling a History transcript beyond 40 MiB of encoded records', async () => {
    const lastSequence = 660;
    const text = 'x'.repeat(64_000);
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('history-byte-limit')));
      } else if (message.method === 'history/load_session') {
        const after = message.params.page?.afterSequence ?? 0;
        const end = Math.min(after + 10, lastSequence);
        target.push(
          result(message.id, {
            type: 'history_session_page',
            session: {
              sessionId: 'history-byte-limit',
              displayName: 'History',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence,
            },
            records: Array.from({ length: end - after }, (_, index) => ({
              sequence: after + index + 1,
              events: [
                {
                  type: 'user.message',
                  messageId: `message-${after + index + 1}`,
                  kind: 'task',
                  text,
                },
              ],
            })),
            ...(end < lastSequence ? { nextCursor: end } : {}),
            interactionMode: 'auto',
            recovery: 'normal',
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    try {
      await expect(client.history!.loadSession('history-byte-limit')).rejects.toMatchObject({
        code: 'history_too_large',
      });
      expect(connection.requests('history/load_session').length).toBeGreaterThan(60);
    } finally {
      await client.close();
    }
  });

  test('removes aborted and expired History waiters before transport send', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('history-waiters')));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
      requestTimeoutMs: 500,
    });
    await client.connect();
    const active = Array.from({ length: 4 }, (_, index) =>
      client.history!.loadSession(`active-${index}`),
    );
    const activeSettled = Promise.allSettled(active);
    const controller = new AbortController();
    const aborted = client.history!.loadChildSession!('parent', 'aborted', undefined, {
      signal: controller.signal,
    });
    const expired = client.history!.loadChildSession!('parent', 'expired');
    try {
      await until(() => connection.requests('history/load_session').length === 4);
      controller.abort(new Error('cancel waiting'));
      await expect(aborted).rejects.toThrow('cancel waiting');
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const request of connection.requests('history/load_session')) {
        connection.push(
          result(request.id, {
            type: 'history_session_page',
            session: {
              sessionId: (request.params as { sessionId: string }).sessionId,
              displayName: 'Active',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 2,
            },
            records: [{ sequence: 1, events: [] }],
            nextCursor: 1,
            interactionMode: 'auto',
            recovery: 'normal',
          }),
        );
      }
      await until(() => connection.requests('history/load_session').length === 8);
      await expect(expired).rejects.toMatchObject({ code: 'request_timeout' });
      expect(connection.requests('history/load_child_session')).toHaveLength(0);
    } finally {
      await client.close();
      await activeSettled;
    }
  });

  test('discards queued History loads on reconnect', async () => {
    const first = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('history-first')));
    });
    const second = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('history-second')));
      if (message.method === 'history/load_session')
        target.push(
          result(message.id, {
            type: 'history_session_page',
            session: {
              sessionId: 'fresh',
              displayName: 'Fresh',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 0,
            },
            records: [],
            interactionMode: 'auto',
            recovery: 'normal',
          }),
        );
    });
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    await client.connect();
    const old = Array.from({ length: 5 }, (_, index) =>
      client.history!.loadSession(`old-${index}`),
    );
    const oldSettled = Promise.allSettled(old);
    try {
      await until(() => first.requests('history/load_session').length === 4);
      await client.reconnect();
      expect((await oldSettled).every((outcome) => outcome.status === 'rejected')).toBe(true);
      expect(first.requests('history/load_session')).toHaveLength(4);
      expect(second.requests('history/load_session')).toHaveLength(0);
      await expect(client.history!.loadSession('fresh')).resolves.toMatchObject({
        session: { sessionId: 'fresh' },
      });
    } finally {
      await client.close();
    }
  });

  test('rejects queued History loads when the connection closes', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('history-disconnect')));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    await client.connect();
    const loads = Array.from({ length: 5 }, (_, index) =>
      client.history!.loadSession(`old-${index}`),
    );
    const settled = Promise.allSettled(loads);
    try {
      await until(() => connection.requests('history/load_session').length === 4);
      connection.end();
      const outcomes = await settled;
      expect(outcomes).toHaveLength(5);
      expect(
        outcomes.every(
          (outcome) =>
            outcome.status === 'rejected' && outcome.reason?.code === 'connection_closed',
        ),
      ).toBe(true);
      expect(connection.requests('history/load_session')).toHaveLength(4);
    } finally {
      await client.close();
    }
  });

  test('pins explicit child History pages to one source sequence and parent scope', async () => {
    let pages = 0;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('child-history')));
      } else if (message.method === 'history/load_child_session') {
        pages++;
        expect(message.params).toMatchObject({
          parentSessionId: 'parent',
          childSessionId: 'child',
          page: pages === 1 ? {} : { afterSequence: 1, throughSequence: 2 },
        });
        target.push(
          result(message.id, {
            type: 'history_session_page',
            session: {
              sessionId: 'child',
              displayName: 'Child',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 2,
            },
            records: [{ sequence: pages, events: [] }],
            interactionMode: 'auto',
            recovery: 'normal',
            ...(pages === 1 ? { nextCursor: 1 } : {}),
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    try {
      const transcript = await client.history?.loadChildSession?.('parent', 'child');
      expect(transcript?.records.map((record) => record.sequence)).toEqual([1, 2]);
      expect(pages).toBe(2);
    } finally {
      await client.close();
    }
  });

  test('restarts pagination after a same-sequence History rewrite without mixing records', async () => {
    const firstDigest = 'a'.repeat(64);
    const secondDigest = 'b'.repeat(64);
    let pages = 0;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('history-rewrite')));
      } else if (message.method === 'history/load_session') {
        pages++;
        const expectedPage =
          pages === 1 || pages === 3
            ? {}
            : {
                afterSequence: 1,
                throughSequence: 2,
                snapshotDigest: pages === 2 ? firstDigest : secondDigest,
              };
        expect(message.params.page).toEqual(expectedPage);
        const generation = pages === 1 ? 'old' : 'new';
        const sequence = pages % 2 === 1 ? 1 : 2;
        target.push(
          result(message.id, {
            type: 'history_session_page',
            session: {
              sessionId: 'history-rewrite',
              displayName: 'History',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 2,
            },
            records: [
              {
                sequence,
                events: [
                  {
                    type: 'user.message',
                    messageId: `${generation}-${sequence}`,
                    kind: 'task',
                    text: `${generation} ${sequence}`,
                  },
                ],
              },
            ],
            interactionMode: 'auto',
            recovery: 'normal',
            snapshotDigest: pages === 1 ? firstDigest : secondDigest,
            ...(sequence === 1 ? { nextCursor: 1 } : {}),
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    try {
      const transcript = await client.history!.loadSession('history-rewrite');
      expect(
        transcript.events.map((event) => (event.type === 'user.message' ? event.text : undefined)),
      ).toEqual(['new 1', 'new 2']);
      expect(pages).toBe(4);
    } finally {
      await client.close();
    }
  });

  test('retries once when the carrier rejects a stale History continuation', async () => {
    const digest = 'c'.repeat(64);
    let pages = 0;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('history-stale')));
      } else if (message.method === 'history/load_session') {
        pages++;
        if (pages === 2) {
          expect(message.params.page).toEqual({
            afterSequence: 1,
            throughSequence: 2,
            snapshotDigest: digest,
          });
          target.push({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: 'Internal error.',
              data: { code: 'internal_error', detailCode: 'history_snapshot_changed' },
            },
          });
          return;
        }
        expect(message.params.page).toEqual(
          pages === 1
            ? {}
            : pages === 3
              ? {}
              : { afterSequence: 1, throughSequence: 2, snapshotDigest: digest },
        );
        const sequence = pages === 1 || pages === 3 ? 1 : 2;
        target.push(
          result(message.id, {
            type: 'history_session_page',
            session: {
              sessionId: 'history-stale',
              displayName: 'History',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: 2,
            },
            records: [{ sequence, events: [] }],
            interactionMode: 'auto',
            recovery: 'normal',
            snapshotDigest: digest,
            ...(sequence === 1 ? { nextCursor: 1 } : {}),
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    try {
      expect(
        (await client.history!.loadSession('history-stale')).records.map(
          (record) => record.sequence,
        ),
      ).toEqual([1, 2]);
      expect(pages).toBe(4);
    } finally {
      await client.close();
    }
  });

  test.each([
    'valid',
    'stalled',
    'snapshot-drift',
    'overlap',
    'aborted-before',
    'aborted-response',
  ] as const)('pins paginated History and rejects invalid continuation: %s', async (scenario) => {
    let pages = 0;
    const controller = new AbortController();
    if (scenario === 'aborted-before') controller.abort();
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('history-pages')));
      } else if (message.method === 'history/load_session') {
        pages++;
        if (scenario === 'aborted-response') controller.abort();
        if (pages === 1) expect(message.params.page).toEqual({});
        else expect(message.params.page).toEqual({ afterSequence: 1, throughSequence: 2 });
        const sequence = pages === 1 || scenario === 'overlap' ? 1 : 2;
        target.push(
          result(message.id, {
            type: 'history_session_page',
            session: {
              sessionId: 'history-pages',
              displayName: 'History',
              needsSmartName: false,
              updatedAt: 1,
              lastSequence: pages > 1 && scenario === 'snapshot-drift' ? 3 : 2,
            },
            records: [
              {
                sequence,
                events: [
                  {
                    type: 'user.message',
                    messageId: `message-${sequence}`,
                    kind: 'task',
                    text: `message ${sequence}`,
                  },
                ],
              },
            ],
            interactionMode: 'auto',
            recovery: 'normal',
            ...(pages === 1 ? { nextCursor: scenario === 'stalled' ? 0 : 1 } : {}),
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    try {
      if (scenario.startsWith('aborted-')) {
        await expect(
          client.history!.loadSession('history-pages', undefined, { signal: controller.signal }),
        ).rejects.toThrow();
        expect(pages).toBe(scenario === 'aborted-before' ? 0 : 1);
        return;
      }
      if (scenario === 'valid') {
        const transcript = await client.history!.loadSession('history-pages');
        expect(transcript.records.map((record) => record.sequence)).toEqual([1, 2]);
        expect(transcript.events).toHaveLength(2);
      } else
        await expect(client.history!.loadSession('history-pages')).rejects.toMatchObject({
          code: 'protocol_error',
        });
      expect(pages).toBe(scenario === 'stalled' ? 1 : 2);
    } finally {
      await client.close();
    }
  });

  test('correlates exact App Control envelopes on the initialized connection', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-app-control')));
      } else if (message.method === 'app/release/status') {
        target.push(
          result(message.id, {
            method: 'app/release/status',
            response: { schema: 'kite.app.release-status.response.v1', serverVersion: 'test' },
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await expect(
      client.requestApp('app/release/status', {
        schema: 'kite.app.release-status.request.v1',
      }),
    ).resolves.toEqual({
      schema: 'kite.app.release-status.response.v1',
      serverVersion: 'test',
    });
    expect(connection.requests('initialize')).toHaveLength(1);
    await client.close();
  });

  test('fails closed when an App Server identity or required capability does not match', async () => {
    for (const expectedServer of [
      { version: 'expected-version', requiredMethods: [] as const },
      { version: '1', requiredMethods: ['history/list_sessions'] as const },
    ]) {
      const connection = new FakeConnection((message, target) => {
        if (message.method === 'initialize') {
          target.push(result(message.id, initializeResult('wrong-server')));
        }
      });
      const client = new RuntimeClient({
        transport: transport(connection),
        clientInfo: clientInfo(),
        expectedServer,
      });
      await expect(client.connect()).rejects.toMatchObject({ code: 'server_mismatch' });
      expect(client.snapshotStore.getSnapshot().status).toBe('disconnected');
      await client.close();
    }
  });

  test('round-trips private Run queries and original command resources', async () => {
    const run = {
      schema: 'kite.runtime-run.v1' as const,
      sessionId: 'session-1',
      runId: 'run-1',
      phase: 'building' as const,
      status: 'queued' as const,
      createdRevision: 2,
      lastRevision: 2,
      createdAtMs: 100,
    };
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-runs')));
      }
      if (message.method === 'runtime/command') {
        target.push(
          result(message.id, {
            status: 'applied',
            commandId: message.params.command.commandId,
            sessionId: 'session-1',
            revision: 2,
            resource: { kind: 'run', run, messageId: 'message-1' },
          }),
        );
      }
      if (message.method === 'runtime/query') {
        target.push(
          result(message.id, {
            status: 'ok',
            queryType: 'list_runs',
            runs: [run],
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    await expect(client.command(startCommand())).resolves.toMatchObject({
      status: 'applied',
      resource: { kind: 'run', run: { runId: 'run-1', status: 'queued' } },
    });
    await expect(
      client.query({
        schema: 'kite.runtime-query.v1',
        type: 'list_runs',
        sessionId: 'session-1',
        limit: 10,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      queryType: 'list_runs',
      runs: [{ runId: 'run-1' }],
    });
    await client.close();
  });

  test('correlates RPC responses and rejects pending work on disconnect', async () => {
    const connection = new FakeConnection(async (message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
      if (message.method === 'runtime/command') {
        target.push(result('unknown-rpc', { status: 'ok' }));
        target.push(
          result(message.id, {
            status: 'applied',
            commandId: message.params.command.commandId,
            sessionId: 'session-1',
            revision: 2,
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    await expect(client.command(startCommand())).resolves.toMatchObject({
      status: 'applied',
      revision: 2,
    });

    const pending = client.query({ schema: 'kite.runtime-query.v1', type: 'list_sessions' });
    connection.end();
    await expect(pending).rejects.toMatchObject({ code: 'connection_closed' });
    await client.close();
  });

  test('treats omitted feature capabilities as unsupported without sending fallback mutations', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        if ('featureNegotiation' in message.params) {
          target.push({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32602,
              message: 'Unknown initialize field.',
              data: { code: 'invalid_params' },
            },
          });
        } else {
          target.push(result(message.id, initializeResult('old-host')));
        }
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    expect(client.features).toEqual({
      steer: false,
      backgroundQuery: false,
      backgroundControl: false,
    });
    await expect(
      client.command({
        schema: 'kite.runtime-command.v1',
        commandId: 'steer-1',
        type: 'steer_turn',
        sessionId: 'session-1',
        expectedRunId: 'run-1',
        expectedTurnId: 'turn-1',
        input: 'keep going',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_command' });
    await expect(
      client.query({
        schema: 'kite.runtime-query.v1',
        type: 'list_background_executions',
        sessionId: 'session-1',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_query' });
    expect(connection.requests('runtime/command')).toHaveLength(0);
    expect(connection.requests('runtime/query')).toHaveLength(0);
    expect(connection.requests('initialize')).toHaveLength(2);
    await client.close();
  });

  test('two clients preserve server admission order while steering the same Run', async () => {
    const admitted: string[] = [];
    const connection = () =>
      new FakeConnection((message, target) => {
        if (message.method === 'initialize')
          target.push(
            result(
              message.id,
              initializeResult('shared-host', {
                steer: true,
                backgroundQuery: false,
                backgroundControl: false,
              }),
            ),
          );
        if (message.method === 'runtime/command') {
          admitted.push(message.params.command.commandId);
          target.push(
            result(message.id, {
              status: 'applied',
              commandId: message.params.command.commandId,
              sessionId: 'session-1',
              revision: admitted.length,
              input: {
                inputId: `input-${admitted.length}`,
                runId: 'run-1',
                turnId: 'turn-1',
                sequence: admitted.length,
              },
            }),
          );
        }
      });
    const first = new RuntimeClient({
      transport: transport(connection()),
      clientInfo: clientInfo(),
    });
    const second = new RuntimeClient({
      transport: transport(connection()),
      clientInfo: clientInfo(),
    });
    await Promise.all([first.connect(), second.connect()]);
    const steer = (commandId: string, input: string) => ({
      schema: 'kite.runtime-command.v1' as const,
      type: 'steer_turn' as const,
      commandId,
      sessionId: 'session-1',
      expectedRunId: 'run-1',
      expectedTurnId: 'turn-1',
      input,
    });
    const receipts = await Promise.all([
      first.command(steer('steer-a', 'first')),
      second.command(steer('steer-b', 'second')),
    ]);
    expect(admitted).toEqual(['steer-a', 'steer-b']);
    expect(receipts.map((receipt) => receipt.status)).toEqual(['applied', 'applied']);
    const inputs = receipts.flatMap((receipt) =>
      receipt.status === 'applied' && receipt.input ? [receipt.input] : [],
    );
    expect(inputs.map((input) => input.runId)).toEqual(['run-1', 'run-1']);
    expect(inputs.map((input) => input.sequence)).toEqual([1, 2]);
    await Promise.all([first.close(), second.close()]);
  });

  test('exposes advertised features while background control remains independently false', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(
          result(
            message.id,
            initializeResult('new-host', {
              steer: true,
              backgroundQuery: true,
              backgroundControl: false,
            }),
          ),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    expect(client.features).toEqual({
      steer: true,
      backgroundQuery: true,
      backgroundControl: false,
    });
    await client.close();
  });

  test('stops one exact background projection and refreshes its detail after admission', async () => {
    const projection = {
      executionId: 'shell-1',
      sessionId: 'session-1',
      sessionRevision: 42,
      kind: 'shell' as const,
      status: 'running' as const,
      ownerGeneration: 'shell-owner',
      revision: 7,
      cleanupConfirmed: false,
    };
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(
          result(
            message.id,
            initializeResult('new-host', {
              steer: true,
              backgroundQuery: true,
              backgroundControl: true,
            }),
          ),
        );
      if (message.method === 'runtime/command')
        target.push(
          result(
            message.id,
            message.params.command.commandId === 'stop-conflict'
              ? {
                  status: 'conflict',
                  commandId: 'stop-conflict',
                  code: 'revision_conflict',
                  currentRevision: 9,
                }
              : {
                  status: 'applied',
                  commandId: message.params.command.commandId,
                  sessionId: 'session-1',
                  revision: 8,
                },
          ),
        );
      if (message.method === 'runtime/query')
        target.push(
          result(message.id, {
            status: 'ok',
            queryType: 'get_background_execution',
            backgroundExecution: { ...projection, status: 'stopping', revision: 8 },
          }),
        );
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    const stopped = await client.stopBackgroundExecution({
      commandId: 'stop-1',
      execution: projection,
    });
    expect(stopped).toMatchObject({
      receipt: { status: 'applied', commandId: 'stop-1' },
      execution: { executionId: 'shell-1', status: 'stopping' },
    });
    expect(connection.requests('runtime/command')[0]).toMatchObject({
      params: {
        command: {
          commandId: 'stop-1',
          sessionId: 'session-1',
          expectedRevision: 42,
          executionId: 'shell-1',
          executionKind: 'shell',
          expectedOwnerGeneration: 'shell-owner',
          expectedExecutionRevision: 7,
        },
      },
    });
    expect(connection.requests('runtime/query')).toHaveLength(1);
    await expect(
      client.stopBackgroundExecution({ commandId: 'stop-conflict', execution: projection }),
    ).resolves.toMatchObject({
      receipt: { status: 'conflict', currentRevision: 9 },
      execution: { executionId: 'shell-1' },
    });
    expect(connection.requests('runtime/command')[1]).toMatchObject({
      params: { command: { executionId: 'shell-1', expectedOwnerGeneration: 'shell-owner' } },
    });
    expect(connection.requests('runtime/query')[1]).toMatchObject({
      params: { query: { type: 'get_background_execution', executionId: 'shell-1' } },
    });
    await client.close();
  });

  test('times out an unanswered command without replaying it or accepting a late receipt', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      requestTimeoutMs: 10,
    });
    await client.connect();
    await expect(client.command(startCommand())).rejects.toMatchObject({ code: 'request_timeout' });
    expect(connection.requests('runtime/command')).toHaveLength(1);
    const command = connection.requests('runtime/command')[0]!;
    connection.push(result(command.id, { status: 'applied', commandId: 'late-command' }));
    await tick();
    expect(connection.requests('runtime/command')).toHaveLength(1);
    await client.close();
  });

  test('times out a transport send that never settles', async () => {
    const connection = new FakeConnection(async (message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
      if (message.method === 'runtime/query') await new Promise<void>(() => undefined);
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      requestTimeoutMs: 10,
    });
    await client.connect();
    await expect(
      client.query({ schema: 'kite.runtime-query.v1', type: 'list_sessions' }),
    ).rejects.toMatchObject({ code: 'request_timeout' });
    await client.close();
  });

  test('times out a request waiting for transport connection', async () => {
    const client = new RuntimeClient({
      transport: { connect: () => new Promise<RuntimeClientConnection>(() => undefined) },
      clientInfo: clientInfo(),
      requestTimeoutMs: 10,
    });
    await expect(
      client.query({ schema: 'kite.runtime-query.v1', type: 'list_sessions' }),
    ).rejects.toMatchObject({ code: 'request_timeout' });
    await client.close();
  });

  test('cancels a History request while connection is pending', async () => {
    const controller = new AbortController();
    const client = new RuntimeClient({
      transport: { connect: () => new Promise<RuntimeClientConnection>(() => undefined) },
      clientInfo: clientInfo(),
      history: 'protocol',
      requestTimeoutMs: 100,
    });
    const pending = client.history!.loadSession('session-1', undefined, {
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    await client.close();
  });

  test.each([
    true,
    false,
  ])('sends exact History cancellation only when the connected server advertises it: %s', async (advertised) => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        const initialize = initializeResult('history-cancel') as {
          capabilities: { methods: string[] };
        };
        if (advertised) initialize.capabilities.methods.push('history/cancel');
        target.push(result(message.id, initialize));
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
    });
    await client.connect();
    const controller = new AbortController();
    const pending = client.history!.loadSession('session-1', undefined, {
      signal: controller.signal,
    });
    await until(() => connection.requests('history/load_session').length === 1);
    const originalId = connection.requests('history/load_session')[0]!.id;
    controller.abort(new Error('selection changed'));
    await expect(pending).rejects.toThrow('selection changed');
    const cancellations = connection.sent.filter(
      (message) => 'method' in message && message.method === 'history/cancel',
    );
    expect(cancellations).toEqual(
      advertised
        ? [{ jsonrpc: '2.0', method: 'history/cancel', params: { requestId: originalId } }]
        : [],
    );
    await client.close();
  });

  test('releases a sent History request after response timeout when cancellation is supported', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        const initialize = initializeResult('history-timeout') as {
          capabilities: { methods: string[] };
        };
        initialize.capabilities.methods.push('history/cancel');
        target.push(result(message.id, initialize));
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      history: 'protocol',
      requestTimeoutMs: 20,
    });
    await client.connect();
    await expect(client.history!.loadSession('session-1')).rejects.toMatchObject({
      code: 'request_timeout',
    });
    const originalId = connection.requests('history/load_session')[0]!.id;
    expect(
      connection.sent.filter(
        (message) => 'method' in message && message.method === 'history/cancel',
      ),
    ).toEqual([{ jsonrpc: '2.0', method: 'history/cancel', params: { requestId: originalId } }]);
    await client.close();
  });

  test('times out subscribeReady while connection is pending', async () => {
    const client = new RuntimeClient({
      transport: { connect: () => new Promise<RuntimeClientConnection>(() => undefined) },
      clientInfo: clientInfo(),
      requestTimeoutMs: 10,
    });
    await expect(client.subscribeReady({ spec: { scope: 'sessions' } })).rejects.toMatchObject({
      code: 'request_timeout',
    });
    await client.close();
  });

  test('times out subscribeReady when the initial ready boundary never arrives', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
      if (message.method === 'runtime/subscribe')
        target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      requestTimeoutMs: 10,
    });
    await expect(client.subscribeReady({ spec: { scope: 'sessions' } })).rejects.toMatchObject({
      code: 'request_timeout',
    });
    expect(connection.requests('runtime/subscribe')).toHaveLength(1);
    await expect(
      connection.send({ jsonrpc: '2.0', id: 'after-timeout', method: 'server/ping', params: {} }),
    ).rejects.toThrow('closed');
    await client.close();
  });

  test('cancelling an in-flight subscribe detaches by request id without waiting for its ack', async () => {
    const controller = new AbortController();
    let subscribeRequestId: string | undefined;
    let subscriptions = 0;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
      if (message.method === 'runtime/subscribe') {
        if (++subscriptions === 1)
          target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
        else subscribeRequestId = message.id;
      }
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    const root = client
      .subscribe({ spec: { scope: 'session', sessionId: 'parent' } })
      [Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    const pending = client.subscribeChildReadyWithGeneration({
      spec: { scope: 'child_session', parentSessionId: 'parent', childSessionId: 'child' },
      signal: controller.signal,
    });
    await tick();
    expect(connection.requests('runtime/subscribe')).toHaveLength(2);
    controller.abort(new Error('subscribe cancelled'));
    await expect(pending).rejects.toThrow('subscribe cancelled');
    await until(() => connection.requests('runtime/unsubscribe').length === 1);
    expect(connection.requests('runtime/unsubscribe')[0]).toMatchObject({
      params: { subscribeRequestId },
    });
    connection.push(
      result(subscribeRequestId!, { subscriptionId: 'abandoned-child', generation: 1 }),
    );
    expect(client.snapshotStore.getSnapshot().status).toBe('active');
    connection.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'durable',
        sessionId: 'parent',
        revision: 1,
        session: session('parent', 1),
      }),
    );
    await expect(root.next()).resolves.toMatchObject({ value: { sessionId: 'parent' } });
    await root.return?.();
    await client.close();
  });

  test('closes the connection when cancellation itself is never acknowledged', async () => {
    const controller = new AbortController();
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      requestTimeoutMs: 20,
    });
    await client.connect();
    const pending = client.subscribeReady({
      spec: { scope: 'sessions' },
      signal: controller.signal,
    });
    await until(() => connection.requests('runtime/subscribe').length === 1);
    controller.abort(new Error('subscribe cancelled'));
    await expect(pending).rejects.toThrow('subscribe cancelled');
    await until(() => connection.requests('runtime/unsubscribe').length === 1);
    expect(connection.requests('runtime/unsubscribe')[0]).toMatchObject({
      params: { subscribeRequestId: connection.requests('runtime/subscribe')[0]?.id },
    });
    await Bun.sleep(40);
    await until(() => client.snapshotStore.getSnapshot().status === 'disconnected');
    await expect(
      connection.send({ jsonrpc: '2.0', id: 'after-timeout', method: 'server/ping', params: {} }),
    ).rejects.toThrow('closed');
    await client.close();
  });

  test('a confirmed request-id cancellation stays connected without the original subscribe ack', async () => {
    const controller = new AbortController();
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
      requestTimeoutMs: 40,
    });
    await client.connect();
    const pending = client.subscribeChildReadyWithGeneration({
      spec: { scope: 'child_session', parentSessionId: 'parent', childSessionId: 'child' },
      signal: controller.signal,
    });
    await until(() => connection.requests('runtime/subscribe').length === 1);
    controller.abort(new Error('left detail'));
    await expect(pending).rejects.toThrow('left detail');
    await until(() => connection.requests('runtime/unsubscribe').length === 1);
    await Bun.sleep(80);
    expect(client.snapshotStore.getSnapshot().status).toBe('active');
    await client.close();
  });

  test('cancels two pending child subscriptions by their exact request ids', async () => {
    const controllers = [new AbortController(), new AbortController()];
    const requests: string[] = [];
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('server-1')));
      if (message.method === 'runtime/subscribe') requests.push(message.id);
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    const pending = controllers.map((controller, index) =>
      client.subscribeChildReadyWithGeneration({
        spec: {
          scope: 'child_session',
          parentSessionId: 'parent',
          childSessionId: `child-${index}`,
        },
        signal: controller.signal,
      }),
    );
    await until(() => requests.length === 2);
    const cancelled = pending.map((subscription) => subscription.catch((error: unknown) => error));
    for (const controller of controllers) controller.abort(new Error('left child detail'));
    const cancellation = await Promise.all(cancelled);
    for (const error of cancellation) expect(error).toBeInstanceOf(Error);
    await until(() => connection.requests('runtime/unsubscribe').length === 2);
    connection.push(result(requests[1]!, { subscriptionId: 'remote-child-1', generation: 1 }));
    connection.push(result(requests[0]!, { subscriptionId: 'remote-child-0', generation: 1 }));
    await tick();
    const cleanupRequests = connection.requests('runtime/unsubscribe');
    const status = client.snapshotStore.getSnapshot().status;
    await client.close();
    expect(cleanupRequests).toHaveLength(2);
    expect(
      cleanupRequests.map((request) =>
        'subscribeRequestId' in request.params ? request.params.subscribeRequestId : undefined,
      ),
    ).toEqual(requests);
    expect(status).toBe('active');
  });

  test('a failed automatic resubscribe closes its iterator instead of leaving a live waiter', async () => {
    let subscriptions = 0;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('resync-failure')));
      if (message.method === 'runtime/subscribe') {
        subscriptions++;
        if (subscriptions > 1) throw new Error('injected resubscribe send failure');
        target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
      }
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();
    try {
      await until(() => subscriptions === 1);
      connection.push(
        subscriptionUpdate(1, {
          type: 'notification',
          durability: 'durable',
          sessionId: 'session-1',
          revision: 1,
          session: session('session-1', 1),
        }),
      );
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      connection.push(
        subscriptionUpdate(1, {
          type: 'notification',
          durability: 'durable',
          sessionId: 'session-1',
          revision: 3,
          session: session('session-1', 3),
        }),
      );
      let ended = false;
      const finished = iterator.next().then((step) => {
        ended = step.done === true;
      });
      await until(() => ended);
      await finished;
      expect(subscriptions).toBe(2);
      expect(client.snapshotStore.getSnapshot().status).toBe('active');
    } finally {
      await iterator.return?.();
      await client.close();
    }
  });

  test('an old resync cannot activate a second subscription after explicit reconnect', async () => {
    const first = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('resync-old')));
      if (message.method === 'runtime/subscribe')
        target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
      // Hold the unsubscribe receipt so reconnect crosses the resync boundary.
    });
    const second = respondingConnection('resync-new');
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();
    try {
      await until(() => first.requests('runtime/subscribe').length === 1);
      first.push(
        subscriptionUpdate(1, {
          type: 'notification',
          durability: 'durable',
          sessionId: 'session-1',
          revision: 1,
          session: session('session-1', 1),
        }),
      );
      await iterator.next();
      first.push(
        subscriptionUpdate(1, {
          type: 'notification',
          durability: 'durable',
          sessionId: 'session-1',
          revision: 3,
          session: session('session-1', 3),
        }),
      );
      await until(() => first.requests('runtime/unsubscribe').length === 1);
      await client.reconnect();
      await tick();
      expect(second.requests('runtime/subscribe')).toHaveLength(1);
      expect(second.requests('runtime/unsubscribe')).toHaveLength(0);
      expect(second.requests('runtime/command')).toHaveLength(0);
      second.push(
        subscriptionUpdate(1, {
          type: 'notification',
          durability: 'durable',
          sessionId: 'session-1',
          revision: 1,
          session: session('session-1', 1),
        }),
      );
      await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { revision: 1 } });
    } finally {
      await iterator.return?.();
      await client.close();
    }
  });

  test('explicit reconnect increments generation and restores subscriptions without replaying mutations', async () => {
    const first = respondingConnection('server-1');
    const second = respondingConnection('server-2');
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
    });
    await client.connect();
    await client.subscribeHandle({ scope: 'sessions' });
    await client.reconnect();

    expect(client.connectionGeneration).toBe(2);
    expect(first.requests('runtime/command')).toHaveLength(0);
    expect(second.requests('runtime/command')).toHaveLength(0);
    expect(second.requests('runtime/subscribe')).toHaveLength(1);
    expect(client.snapshotStore.getSnapshot().serverInstanceId).toBe('server-2');
    await client.close();
  });

  test('applies index reset atomically and ignores an old connection after reconnect', async () => {
    const first = respondingConnection('server-1');
    const second = respondingConnection('server-2');
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
    });
    let iterator: AsyncIterator<unknown> | undefined;
    try {
      await client.connect();
      iterator = client.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
      await until(() => first.requests('runtime/subscribe').length === 1);
      await tick();
      first.push(
        subscriptionUpdate(1, {
          type: 'index_reset_begin',
          serverInstanceId: 'server-1',
          generation: 1,
          indexRevision: 3,
        }),
      );
      first.push(
        subscriptionUpdate(1, {
          type: 'session_upsert',
          serverInstanceId: 'server-1',
          generation: 1,
          indexRevision: 3,
          session: session('session-1', 4),
        }),
      );
      first.push(
        subscriptionUpdate(1, {
          type: 'index_reset_end',
          serverInstanceId: 'server-1',
          generation: 1,
          indexRevision: 3,
        }),
      );
      await tick();
      expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_begin' });
      expect((await iterator.next()).value).toMatchObject({
        type: 'session_upsert',
        session: { sessionId: 'session-1', revision: 4 },
      });
      expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_end' });
      expect(client.snapshotStore.getSnapshot().index.ready).toBe(true);
      expect(client.snapshotStore.getSnapshot().sessions['session-1']?.projection.revision).toBe(4);

      await client.reconnect();
      first.push(
        subscriptionUpdate(1, {
          type: 'session_upsert',
          serverInstanceId: 'server-1',
          generation: 1,
          indexRevision: 4,
          session: session('forged-session', 99),
        }),
      );
      await tick();
      expect(client.snapshotStore.getSnapshot().sessions['forged-session']).toBeUndefined();
    } finally {
      try {
        await iterator?.return?.();
      } finally {
        await client.close();
      }
    }
  });

  test('observes Session removal without replacing a live Session snapshot', async () => {
    const connection = respondingConnection('server-1');
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    await client.connect();
    const iterator = client.observeSessionIndex()[Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    connection.push(
      subscriptionUpdate(1, {
        type: 'index_reset_begin',
        serverInstanceId: 'server-1',
        generation: 1,
        indexRevision: 1,
      }),
    );
    connection.push(
      subscriptionUpdate(1, {
        type: 'index_reset_end',
        serverInstanceId: 'server-1',
        generation: 1,
        indexRevision: 1,
      }),
    );
    connection.push(
      subscriptionUpdate(1, {
        type: 'session_remove',
        serverInstanceId: 'server-1',
        generation: 1,
        indexRevision: 2,
        sessionId: 'session-1',
      }),
    );
    expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_begin' });
    expect((await iterator.next()).value).toMatchObject({ type: 'index_reset_end' });
    expect((await iterator.next()).value).toMatchObject({
      type: 'session_remove',
      sessionId: 'session-1',
    });
    expect(client.snapshotStore.getSnapshot().index.ready).toBe(false);
    await iterator.return?.();
    await client.close();
  });

  test('does not let a previous connection subscription identity accept messages on its replacement', async () => {
    const first = respondingConnection('server-1');
    let deferredSubscribe: Request | undefined;
    const second = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-2')));
        return;
      }
      if (message.method === 'runtime/subscribe') deferredSubscribe = message;
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
    });
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();
    await until(() => first.requests('runtime/subscribe').length === 1);
    await tick();

    const reconnecting = client.reconnect();
    await until(() => second.requests('runtime/subscribe').length === 1);
    // The server is allowed to reuse a subscription id and remote generation.
    // The local connection generation is the additional anti-stale guard.
    second.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'durable',
        sessionId: 'forged-session',
        revision: 1,
        session: session('forged-session', 1),
      }),
    );
    await tick();
    expect(client.snapshotStore.getSnapshot().sessions['forged-session']).toBeUndefined();

    second.push(result(deferredSubscribe!.id, { subscriptionId: 'subscription-1', generation: 1 }));
    await reconnecting;
    second.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'durable',
        sessionId: 'session-1',
        revision: 1,
        session: session('session-1', 1),
      }),
    );
    await expect(iterator.next()).resolves.toMatchObject({
      value: { sessionId: 'session-1', revision: 1 },
    });
    await iterator.return?.();
    await client.close();
  });

  test('structurally implements RuntimeAccess with independently returnable streams', async () => {
    const connection = respondingConnection('server-1');
    const client: RuntimeAccess = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client.subscribe({ spec: { scope: 'sessions' } })[Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    await iterator.return?.();
    expect(connection.requests('runtime/unsubscribe')).toHaveLength(1);
    await (client as RuntimeClient).close();
  });

  test('binds a subscribe ack before an immediately following initial notification', async () => {
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-1')));
        return;
      }
      if (message.method === 'runtime/subscribe') {
        target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
        target.push(
          subscriptionUpdate(1, {
            type: 'notification',
            durability: 'durable',
            sessionId: 'session-1',
            revision: 1,
            session: session('session-1', 1),
          }),
        );
        target.push(
          subscriptionUpdate(1, {
            type: 'ready',
            sessionId: 'session-1',
            revision: 1,
          }),
        );
      }
      if (message.method === 'runtime/unsubscribe') {
        target.push(result(message.id, { unsubscribed: true }));
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { durability: 'durable', sessionId: 'session-1', revision: 1 },
    });
    await until(() => client.snapshotStore.getSnapshot().sessions['session-1']?.ready === true);
    await iterator.return?.();
    await client.close();
  });

  test('releases snapshot state while switching among 120 distinct sessions', async () => {
    let nextSubscription = 0;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(
          result(
            message.id,
            initializeResult('snapshot-retention', {
              steer: false,
              backgroundQuery: true,
              backgroundControl: false,
            }),
          ),
        );
      if (message.method === 'runtime/subscribe')
        target.push(
          result(message.id, {
            subscriptionId: `subscription-${++nextSubscription}`,
            generation: nextSubscription,
          }),
        );
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
      if (
        message.method === 'runtime/query' &&
        message.params.query.type === 'list_background_executions'
      ) {
        const sessionId = message.params.query.sessionId;
        target.push(
          result(message.id, {
            status: 'ok',
            queryType: 'list_background_executions',
            backgroundSnapshot: {
              sessionId,
              sessionRevision: 1,
              aggregateGeneration: `aggregate-${sessionId}`,
              watermark: 1,
              executions: [],
            },
          }),
        );
      }
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    try {
      for (let index = 0; index < 120; index += 1) {
        const sessionId = `session-${index}`;
        const handle = await client.subscribeHandle({ scope: 'session', sessionId });
        connection.push({
          jsonrpc: '2.0',
          method: 'runtime/subscription',
          params: {
            subscriptionId: `subscription-${index + 1}`,
            generation: index + 1,
            message: {
              type: 'notification',
              durability: 'durable',
              sessionId,
              revision: 1,
              session: session(sessionId, 1),
            },
          },
        });
        await until(() => client.snapshotStore.getSnapshot().sessions[sessionId] !== undefined);
        await client.query({
          schema: 'kite.runtime-query.v1',
          type: 'list_background_executions',
          sessionId,
        });
        expect(Object.keys(client.snapshotStore.getSnapshot().sessions)).toHaveLength(1);
        expect(Object.keys(client.snapshotStore.getSnapshot().background)).toHaveLength(1);
        await handle.unsubscribe();
        expect(Object.keys(client.snapshotStore.getSnapshot().sessions)).toHaveLength(0);
        expect(Object.keys(client.snapshotStore.getSnapshot().streams)).toHaveLength(0);
        expect(Object.keys(client.snapshotStore.getSnapshot().background)).toHaveLength(0);
      }
      expect(connection.requests('runtime/subscribe')).toHaveLength(120);
      expect(connection.requests('runtime/unsubscribe')).toHaveLength(120);
    } finally {
      await client.close();
    }
  });

  test('keeps shared session state until its last subscriber detaches', async () => {
    let nextSubscription = 0;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(result(message.id, initializeResult('shared-snapshot')));
      if (message.method === 'runtime/subscribe')
        target.push(
          result(message.id, {
            subscriptionId: `subscription-${++nextSubscription}`,
            generation: nextSubscription,
          }),
        );
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    try {
      const first = await client.subscribeHandle({ scope: 'session', sessionId: 'session-1' });
      const second = await client.subscribeHandle({ scope: 'session', sessionId: 'session-1' });
      connection.push({
        jsonrpc: '2.0',
        method: 'runtime/subscription',
        params: {
          subscriptionId: 'subscription-1',
          generation: 1,
          message: {
            type: 'notification',
            durability: 'durable',
            sessionId: 'session-1',
            revision: 1,
            session: session('session-1', 1),
          },
        },
      });
      await until(() => client.snapshotStore.getSnapshot().sessions['session-1'] !== undefined);
      await first.unsubscribe();
      expect(client.snapshotStore.getSnapshot().sessions['session-1']).toBeDefined();
      await second.unsubscribe();
      expect(client.snapshotStore.getSnapshot().sessions['session-1']).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test('an old background query cannot refill a detached or newly reopened session', async () => {
    let nextSubscription = 0;
    const connection = new FakeConnection((message, target) => {
      if (message.method === 'initialize')
        target.push(
          result(
            message.id,
            initializeResult('background-read-owner', {
              steer: false,
              backgroundQuery: true,
              backgroundControl: false,
            }),
          ),
        );
      if (message.method === 'runtime/subscribe')
        target.push(
          result(message.id, {
            subscriptionId: `subscription-${++nextSubscription}`,
            generation: nextSubscription,
          }),
        );
      if (message.method === 'runtime/unsubscribe')
        target.push(result(message.id, { unsubscribed: true }));
    });
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const query = () =>
      client.query({
        schema: 'kite.runtime-query.v1',
        type: 'list_background_executions',
        sessionId: 'session-1',
      });
    const reply = (index: number, watermark: number) => {
      const request = connection.requests('runtime/query')[index]!;
      connection.push(
        result(request.id, {
          status: 'ok',
          queryType: 'list_background_executions',
          backgroundSnapshot: {
            sessionId: 'session-1',
            sessionRevision: watermark,
            aggregateGeneration: 'aggregate-1',
            watermark,
            executions: [],
          },
        }),
      );
    };
    try {
      const first = await client.subscribeHandle({ scope: 'session', sessionId: 'session-1' });
      const detachedQuery = query();
      await until(() => connection.requests('runtime/query').length === 1);
      await first.unsubscribe();
      reply(0, 1);
      await detachedQuery;
      expect(client.snapshotStore.getSnapshot().background['session-1']).toBeUndefined();

      const second = await client.subscribeHandle({ scope: 'session', sessionId: 'session-1' });
      const oldQuery = query();
      await until(() => connection.requests('runtime/query').length === 2);
      await second.unsubscribe();
      const third = await client.subscribeHandle({ scope: 'session', sessionId: 'session-1' });
      const currentQuery = query();
      await until(() => connection.requests('runtime/query').length === 3);
      reply(2, 2);
      await currentQuery;
      reply(1, 3);
      await oldQuery;
      expect(client.snapshotStore.getSnapshot().background['session-1']?.snapshot.watermark).toBe(
        2,
      );
      await third.unsubscribe();
      expect(client.snapshotStore.getSnapshot().background['session-1']).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test('reconstructs a complete ephemeral RuntimeAccess notification from the closed Protocol event', async () => {
    const connection = respondingConnection('server-1');
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1', includeEphemeral: true } })
      [Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    connection.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'ephemeral',
        sessionId: 'session-1',
        workId: 'work-1',
        runId: 'run-1',
        turnId: 'turn-1',
        actorId: 'actor-1',
        attemptId: 'attempt-1',
        compositionRevision: 'composition-1',
        streamId: 'stream-1',
        sequence: 1,
        event: {
          type: 'run.terminal',
          runId: 'run-1',
          status: 'failed',
          outcome: {
            status: 'resource_saturated',
            reasonCode: 'queue_exhausted',
            safeRetry: true,
            recoveryEntry: 'reconcile',
          },
        },
      }),
    );
    expect((await iterator.next()).value).toMatchObject({
      schema: 'kite.runtime-notification.v2',
      durability: 'ephemeral',
      sessionId: 'session-1',
      workId: 'work-1',
      turnId: 'turn-1',
      actorId: 'actor-1',
      attemptId: 'attempt-1',
      compositionRevision: 'composition-1',
      streamId: 'stream-1',
      sequence: 1,
      event: {
        type: 'run.terminal',
        outcome: { reasonCode: 'queue_exhausted', recoveryEntry: 'reconcile' },
      },
    });
    expect(Object.values(client.snapshotStore.getSnapshot().streams)[0]).toMatchObject({
      compositionRevision: 'composition-1',
      event: { type: 'run.terminal', runId: 'run-1' },
    });
    await iterator.return?.();
    await client.close();
  });

  test('retains receipt generation on the ready notification stream', async () => {
    const first = new FakeConnection((message, target) => {
      if (message.method === 'initialize') {
        target.push(result(message.id, initializeResult('server-1')));
      } else if (message.method === 'runtime/subscribe') {
        target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
        target.push(
          subscriptionUpdate(1, {
            type: 'notification',
            durability: 'durable',
            sessionId: 'session-1',
            revision: 1,
            session: session('session-1', 1),
          }),
        );
        target.push(subscriptionUpdate(1, { type: 'ready', scope: 'session' }));
      } else if (message.method === 'runtime/unsubscribe') {
        target.push(result(message.id, { unsubscribed: true }));
      }
    });
    const second = respondingConnection('server-2');
    const client = new RuntimeClient({
      transport: transport(first, second),
      clientInfo: clientInfo(),
    });
    const stream = await client.subscribeReadyWithGeneration({
      spec: { scope: 'session', sessionId: 'session-1', includeEphemeral: true },
    });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { connectionGeneration: 1, notification: { durability: 'durable', revision: 1 } },
    });
    first.push(ephemeralUpdate(1));
    await tick();

    await client.reconnect();

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        connectionGeneration: 1,
        notification: { durability: 'ephemeral', streamId: 'stream-1', sequence: 1 },
      },
    });
    second.push(ephemeralUpdate(1));
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        connectionGeneration: 2,
        notification: { durability: 'ephemeral', streamId: 'stream-1', sequence: 1 },
      },
    });
    await iterator.return?.();
    await client.close();
  });

  test('evicts queued ephemeral notifications before a durable subscription fact', async () => {
    const connection = respondingConnection('server-1');
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1', includeEphemeral: true } })
      [Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    for (let sequence = 1; sequence <= 256; sequence += 1) {
      connection.push(ephemeralUpdate(sequence));
    }
    connection.push(
      subscriptionUpdate(1, {
        type: 'notification',
        durability: 'durable',
        sessionId: 'session-1',
        revision: 2,
        session: session('session-1', 2),
      }),
    );
    await until(
      () => client.snapshotStore.getSnapshot().sessions['session-1']?.projection.revision === 2,
      600,
    );
    expect((await iterator.next()).value).toMatchObject({
      durability: 'durable',
      sessionId: 'session-1',
      revision: 2,
    });
    expect(connection.requests('runtime/unsubscribe')).toHaveLength(0);
    await iterator.return?.();
    await client.close();
  });

  test('fails closed and releases the remote subscription when durable-only backlog overflows', async () => {
    const connection = respondingConnection('server-1');
    const client = new RuntimeClient({
      transport: transport(connection),
      clientInfo: clientInfo(),
    });
    const iterator = client
      .subscribe({ spec: { scope: 'session', sessionId: 'session-1' } })
      [Symbol.asyncIterator]();
    await until(() => connection.requests('runtime/subscribe').length === 1);
    await tick();
    for (let revision = 1; revision <= 257; revision += 1) {
      connection.push(
        subscriptionUpdate(1, {
          type: 'notification',
          durability: 'durable',
          sessionId: 'session-1',
          revision,
          session: session('session-1', revision),
        }),
      );
    }
    await until(() => connection.requests('runtime/unsubscribe').length === 1, 600);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await client.close();
  });
});

type Request = Extract<RuntimeProtocolMessage, { readonly id: string; readonly method: string }>;

class FakeConnection implements RuntimeClientConnection {
  readonly #incoming = new AsyncQueue<unknown>();
  readonly sent: RuntimeProtocolMessage[] = [];
  readonly #onSend: (message: Request, target: FakeConnection) => Promise<void> | void;
  #closed = false;

  constructor(onSend: (message: Request, target: FakeConnection) => Promise<void> | void) {
    this.#onSend = onSend;
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    if (this.#closed) throw new Error('closed');
    this.sent.push(message);
    if ('id' in message && typeof message.id === 'string' && 'method' in message) {
      await this.#onSend(message, this);
    }
  }

  messages(): AsyncIterable<unknown> {
    return this.#incoming;
  }
  async close(): Promise<void> {
    this.end();
  }
  push(message: unknown): void {
    this.#incoming.push(message);
  }
  end(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#incoming.close();
    }
  }
  requests(method: string): readonly Request[] {
    return this.sent.filter(
      (message): message is Request =>
        'id' in message &&
        typeof message.id === 'string' &&
        'method' in message &&
        message.method === method,
    );
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters = new Set<(value: IteratorResult<T>) => void>();
  #closed = false;
  push(value: T): void {
    const waiter = this.#waiters.values().next().value as
      | ((result: IteratorResult<T>) => void)
      | undefined;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
      return;
    }
    this.#items.push(value);
  }
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#items.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.add(resolve));
      },
    };
  }
}

function respondingConnection(serverInstanceId: string): FakeConnection {
  return new FakeConnection((message, target) => {
    if (message.method === 'initialize')
      target.push(result(message.id, initializeResult(serverInstanceId)));
    if (message.method === 'runtime/subscribe')
      target.push(result(message.id, { subscriptionId: 'subscription-1', generation: 1 }));
    if (message.method === 'runtime/unsubscribe')
      target.push(result(message.id, { unsubscribed: true }));
  });
}

function transport(...connections: readonly FakeConnection[]): RuntimeClientTransport {
  let offset = 0;
  return {
    connect: async () => {
      const connection = connections[offset++];
      if (!connection) throw new Error('unexpected connection');
      return connection;
    },
  };
}

function result(id: string, value: object): object {
  return { jsonrpc: '2.0', id, result: value };
}
function initializeResult(
  instanceId: string,
  features?: { steer: boolean; backgroundQuery: boolean; backgroundControl: boolean },
): object {
  return {
    protocolVersion: 2,
    protocolSchema: 'kite.runtime-protocol.v2',
    serverInfo: { version: '1', instanceId },
    capabilities: {
      methods: [
        'initialize',
        'runtime/command',
        'runtime/query',
        'runtime/subscribe',
        'runtime/unsubscribe',
        'server/ping',
      ],
      subscriptions: ['session', 'sessions'],
      ...(features === undefined ? {} : { features }),
    },
    limits: {
      maxMessageBytes: 1024,
      maxDepth: 8,
      maxInFlightRequests: 8,
      maxSubscriptions: 8,
      maxOutboundMessages: 8,
    },
  };
}
function clientInfo() {
  return { name: 'test-client', version: '1', instanceId: 'client-test-1' };
}
function startCommand() {
  return {
    schema: 'kite.runtime-command.v1' as const,
    commandId: 'command-1',
    type: 'start_turn' as const,
    sessionId: 'session-1',
    expectedRevision: 1,
    input: 'continue',
  };
}
function session(sessionId: string, revision: number) {
  return {
    schema: 'kite.runtime-projection.v2' as const,
    sessionId,
    revision,
    lifecycle: 'open' as const,
    sessionCommandGrantCount: 0,
    interactionQueue: { revision, interactions: [] },
  };
}
function subscriptionUpdate(generation: number, message: object): object {
  return {
    jsonrpc: '2.0',
    method: 'runtime/subscription',
    params: { subscriptionId: 'subscription-1', generation, message },
  };
}
function ephemeralUpdate(sequence: number): object {
  return subscriptionUpdate(1, {
    type: 'notification',
    durability: 'ephemeral',
    sessionId: 'session-1',
    workId: 'work-1',
    turnId: 'turn-1',
    actorId: 'actor-1',
    attemptId: 'attempt-1',
    compositionRevision: 'composition-1',
    streamId: 'stream-1',
    sequence,
    event: {
      type: 'model.text_delta',
      requestId: 'request-ephemeral-update',
      text: `delta-${sequence}`,
    },
  });
}
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
async function until(predicate: () => boolean, maxAttempts = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('condition was not reached');
}
