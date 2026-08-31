import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AGENT_API_LIMITS, type AgentApiProblem } from '@kite-ai/agent-api-contract';
import type {
  RuntimeLogEventEntry,
  RuntimeLogSessionEntry,
  RuntimeQuery,
} from '@kite-ai/runtime-contract';
import {
  type AgentApiCapabilityBinding,
  type AgentApiCheckpointMetadata,
  type AgentApiReadContext,
  createAgentApiRouteHandler,
} from '../../src/agent-api';
import { AgentApiReferenceClient } from './reference-client';

const WORKSPACE_DIGEST =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as const;
const PRIVATE_WORKSPACE_PATH = '/private/workspace/must-not-cross';

describe('Agent API read-only conformance and fault Gate', () => {
  test('drives both roles and every advertised read through the Public contract codecs', async () => {
    const server = conformanceServer();
    const observer = new AgentApiReferenceClient(server.send);
    const observerCapability = 'O'.repeat(43);
    server.issue(observerCapability, 'agent_api_observer', 'observer-client');
    const observerContext = await observer.exchange(observerCapability, [
      'checkpoints',
      'history',
      'sessions',
    ]);
    expect(observerContext.role).toBe('observer');
    expect(observerContext.capabilities).toEqual(['checkpoints', 'history', 'sessions']);
    expect((await observer.serverInfo()).capabilities).toEqual([
      'checkpoints',
      'history',
      'sessions',
    ]);

    const first = await observer.listSessions('?limit=1');
    expect(first.items.map((session) => session.session_id)).toEqual(['session-3']);
    expect(first.next_cursor).toEqual(expect.any(String));
    server.insertNewerSession();
    const second = await observer.listSessions(`?limit=1&cursor=${first.next_cursor}`);
    expect(second.items.map((session) => session.session_id)).toEqual(['session-2']);
    expect(second.items).not.toContainEqual(expect.objectContaining({ session_id: 'session-4' }));

    const running: string[] = [];
    let statusQuery = '?limit=1&status=running';
    for (;;) {
      const page = await observer.listSessions(statusQuery);
      running.push(...page.items.map((session) => session.session_id));
      if (!page.next_cursor) break;
      statusQuery = `?limit=1&status=running&cursor=${page.next_cursor}`;
    }
    expect(running).toEqual(['session-2']);
    expect((await observer.getSession('session-2')).status).toBe('running');

    const historyFirst = await observer.history('session-2', '?limit=2');
    expect(historyFirst.through_sequence).toBe(3);
    expect(historyFirst.next_cursor).toEqual(expect.any(String));
    server.appendConcurrentHistory();
    const historySecond = await observer.history(
      'session-2',
      `?limit=2&cursor=${historyFirst.next_cursor}`,
    );
    expect(historySecond.through_sequence).toBe(3);
    expect(historySecond.items.map((item) => item.sequence)).toEqual([2, 3]);
    expect(historySecond.items.every((item) => item.sequence < 4)).toBeTrue();

    const logs = await observer.logs('session-2', '?limit=4');
    expect(logs.through_sequence).toBe(4);
    expect(logs.items.map((item) => item.event_type)).toEqual([
      'user.message_appended',
      'model.responded',
      'tool.finished',
      'user.message_appended',
    ]);
    expect(logs.items[0]).toMatchObject({
      category: 'turn',
      detail: { kind: 'message' },
    });

    const checkpointFirst = await observer.checkpoints('session-2', '?limit=1');
    expect(checkpointFirst.items.map((checkpoint) => checkpoint.checkpoint_id)).toEqual([
      'checkpoint-1',
    ]);
    const checkpointSecond = await observer.checkpoints(
      'session-2',
      `?limit=1&cursor=${checkpointFirst.next_cursor}`,
    );
    expect(checkpointSecond.items.map((checkpoint) => checkpoint.checkpoint_id)).toEqual([
      'checkpoint-2',
    ]);
    const preview = await observer.checkpointPreview('session-2', 'checkpoint-1');
    expect(preview.files).toEqual({ changed: 1, conflicted: 0, additions: 4, deletions: 2 });

    const observerMutation = await observer.problem(
      '/v1/sessions/session-2/runs',
      { method: 'POST' },
      404,
    );
    const controller = new AgentApiReferenceClient(server.send);
    const controllerCapability = 'C'.repeat(43);
    server.issue(controllerCapability, 'agent_api_controller', 'controller-client');
    expect((await controller.exchange(controllerCapability)).role).toBe('controller');
    expect((await controller.listSessions('?limit=1')).schema).toBe(
      'kite.agent-api.session-page.v1',
    );
    const controllerMutation = await controller.problem(
      '/v1/sessions/session-2/runs',
      { method: 'POST' },
      404,
    );

    const publicOutput = JSON.stringify({
      first,
      second,
      historyFirst,
      historySecond,
      logs,
      checkpointFirst,
      checkpointSecond,
      preview,
      observerMutation,
      controllerMutation,
    });
    for (const privateValue of [
      PRIVATE_WORKSPACE_PATH,
      WORKSPACE_DIGEST,
      observerCapability,
      observer.accessToken!,
      'hidden/private/file.ts',
      'worker-scope-conformance',
    ]) {
      expect(publicOutput).not.toContain(privateValue);
    }
    await server.handler.close();
  });

  test('fails closed across capability errors, byte limits, unavailable streams, and replacement', async () => {
    const server = conformanceServer();
    const client = new AgentApiReferenceClient(server.send);
    const capability = 'A'.repeat(43);
    server.issue(capability, 'agent_api_observer', 'fault-client');
    const incompatible = await client.problem(
      '/v1/auth/exchange',
      {
        method: 'POST',
        includeContext: false,
        headers: {
          authorization: `Kite-Connection ${capability}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schema: 'kite.agent-api.exchange.v1',
          api_version: 'v1',
          required_capabilities: ['runs'],
        }),
      },
      426,
    );
    expect(incompatible.code).toBe('incompatible');
    await client.exchange(capability);

    const replay = new AgentApiReferenceClient(server.send);
    expect(
      (
        await replay.problem(
          '/v1/auth/exchange',
          {
            method: 'POST',
            includeContext: false,
            headers: {
              authorization: `Kite-Connection ${capability}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              schema: 'kite.agent-api.exchange.v1',
              api_version: 'v1',
              required_capabilities: [],
            }),
          },
          401,
        )
      ).code,
    ).toBe('unauthorized');

    const unavailableStream = await client.problem(
      '/v1/sessions/session-2/events',
      { headers: { accept: 'text/event-stream' } },
      404,
    );
    expect(unavailableStream.code).toBe('not_found');

    const oversizedCapability = 'X'.repeat(43);
    server.issue(oversizedCapability, 'agent_api_observer', 'oversized-client');
    const oversized = await client.problem(
      '/v1/auth/exchange',
      {
        method: 'POST',
        includeContext: false,
        headers: {
          authorization: `Kite-Connection ${oversizedCapability}`,
          'content-type': 'application/json',
        },
        body: `{"padding":"${'x'.repeat(AGENT_API_LIMITS.maxMessageBytes)}"}`,
      },
      413,
    );
    expect(oversized).toMatchObject({ code: 'payload_too_large', retryable: false });

    const oldToken = client.accessToken!;
    await server.handler.close();
    const draining = await client.problem('/v1', {}, 503);
    expect(draining.code).toBe('temporarily_unavailable');

    const replacement = conformanceServer();
    const stale = new AgentApiReferenceClient(replacement.send, oldToken);
    const staleProblem = await stale.problem('/v1', {}, 401);
    expect(staleProblem.code).toBe('unauthorized');
    const fresh = new AgentApiReferenceClient(replacement.send);
    const freshCapability = 'N'.repeat(43);
    replacement.issue(freshCapability, 'agent_api_observer', 'replacement-client');
    await fresh.exchange(freshCapability);
    expect((await fresh.serverInfo()).api_version).toBe('v1');

    const problems: readonly AgentApiProblem[] = [
      incompatible,
      unavailableStream,
      oversized,
      draining,
      staleProblem,
    ];
    const problemOutput = JSON.stringify(problems);
    for (const privateValue of [
      PRIVATE_WORKSPACE_PATH,
      WORKSPACE_DIGEST,
      capability,
      oldToken,
      'worker-scope-conformance',
      '/v1/sessions/session-2/events',
    ]) {
      expect(problemOutput).not.toContain(privateValue);
    }
    await replacement.handler.close();
  });

  test('keeps the read adapter free of direct RuntimeAccess and concrete authority imports', () => {
    const source = [
      readFileSync(new URL('../../src/agent-api/context.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../src/agent-api/read-adapter.ts', import.meta.url), 'utf8'),
    ].join('\n');
    expect(source).not.toMatch(
      /@kite-ai\/(?:agent-kernel|runtime-host|runtime-storage-sqlite)|\bRuntimeAccess\b/u,
    );
  });
});

function conformanceServer() {
  let randomValue = 1;
  const capabilities = new Map<string, AgentApiCapabilityBinding>();
  const metadata: RuntimeLogSessionEntry[] = [
    sessionMetadata('session-3', 3_000),
    sessionMetadata('session-2', 2_000),
    sessionMetadata('session-1', 1_000),
  ];
  const projections = new Map<string, ReturnType<typeof sessionProjection>>([
    ['session-3', sessionProjection('session-3', 3, 'idle')],
    ['session-2', sessionProjection('session-2', 2, 'running')],
    ['session-1', sessionProjection('session-1', 1, 'idle')],
  ]);
  const events: RuntimeLogEventEntry[] = [
    historyEvent(1, 'user.message_appended', {
      message_id: 'message-1',
      content: 'hello',
    }),
    historyEvent(2, 'model.responded', {
      message_id: 'message-2',
      request_id: 'request-2',
      reasoning_text: 'thinking',
      text: 'world',
    }),
    historyEvent(3, 'tool.finished', {
      tool_call_id: 'tool-call-3',
      label: 'Read file',
    }),
  ];
  const checkpointEntries: AgentApiCheckpointMetadata[] = [
    checkpoint('checkpoint-1', 4),
    checkpoint('checkpoint-2', 5),
  ];
  const readContext = (): AgentApiReadContext => {
    const close = async () => undefined;
    return {
      query: async (query: RuntimeQuery) => {
        if (query.type === 'get_session_projection') {
          const session = projections.get(query.sessionId);
          return session
            ? {
                status: 'ok' as const,
                queryType: query.type,
                revision: session.revision,
                session,
              }
            : { status: 'not_found' as const, queryType: query.type, code: 'session_not_found' };
        }
        if (query.type === 'get_rewind_preview') {
          return {
            status: 'ok' as const,
            queryType: query.type,
            revision: 8,
            rewindPreview: {
              checkpointId: query.checkpointId,
              sessionId: query.sessionId,
              revision: 8,
              files: [{ path: 'hidden/private/file.ts', addedLines: 4, removedLines: 2 }],
              lineStatsAvailable: true,
              addedLines: 4,
              removedLines: 2,
              conflictCount: 0,
              failureCount: 0,
            },
          };
        }
        return { status: 'rejected' as const, queryType: query.type, code: 'unsupported' };
      },
      history: {
        listSessions: async (request) => {
          const sorted = [...metadata].sort(
            (left, right) =>
              right.updatedAt - left.updatedAt || right.sessionId.localeCompare(left.sessionId),
          );
          const after = request.cursor
            ? sorted.filter(
                (entry) =>
                  entry.updatedAt < request.cursor!.updatedAt ||
                  (entry.updatedAt === request.cursor!.updatedAt &&
                    entry.sessionId < request.cursor!.sessionId),
              )
            : sorted;
          const entries = after.slice(0, request.limit);
          const hasMore = after.length > entries.length;
          const last = entries.at(-1);
          return {
            entries,
            hasMore,
            ...(hasMore && last
              ? { nextCursor: { updatedAt: last.updatedAt, sessionId: last.sessionId } }
              : {}),
          };
        },
        listEvents: async (request) => {
          const candidates = events.filter(
            (entry) =>
              entry.sequence > (request.afterSequence ?? 0) &&
              entry.sequence < (request.beforeSequence ?? Number.MAX_SAFE_INTEGER),
          );
          const entries = candidates.slice(0, request.limit);
          return {
            entries,
            hasMore: candidates.length > entries.length,
            observedLastSequence: events.at(-1)?.sequence ?? 0,
          };
        },
      },
      checkpoints: {
        list: ({ sessionId, cursor, limit }) => {
          const after = cursor
            ? checkpointEntries.filter(
                (entry) =>
                  entry.revision > cursor.revision ||
                  (entry.revision === cursor.revision && entry.checkpointId > cursor.checkpointId),
              )
            : checkpointEntries;
          const entries = after.slice(0, limit);
          const hasMore = after.length > entries.length;
          const last = entries.at(-1);
          return {
            entries: entries.map((entry) => ({ ...entry, sessionId })),
            hasMore,
            ...(hasMore && last
              ? { nextCursor: { revision: last.revision, checkpointId: last.checkpointId } }
              : {}),
          };
        },
        get: (sessionId, checkpointId) => {
          const entry = checkpointEntries.find(
            (candidate) => candidate.checkpointId === checkpointId,
          );
          return entry ? { ...entry, sessionId } : undefined;
        },
      },
      close,
      [Symbol.asyncDispose]: close,
    };
  };
  const handler = createAgentApiRouteHandler({
    serverVersion: 'conformance-server',
    buildId: 'conformance-build',
    randomBytes: (size) => new Uint8Array(size).fill(randomValue++),
    consumeCapability: (secret) => {
      const binding = capabilities.get(secret);
      if (binding) capabilities.delete(secret);
      return binding;
    },
    admitWorkspace: async () => 'admitted',
    isClientGenerationCurrent: () => true,
    openReadContext: async () => readContext(),
    capabilities: ['checkpoints', 'history', 'sessions'],
  });
  return {
    handler,
    send: (request: Request) => handler.handle(request),
    issue(secret: string, purpose: AgentApiCapabilityBinding['purpose'], clientId: string) {
      capabilities.set(secret, {
        workerScopeId: 'worker-scope-conformance',
        workerInstanceId: 'worker-instance-conformance',
        workspaceDigest: WORKSPACE_DIGEST,
        clientId,
        connectionGeneration: 1,
        purpose,
      });
    },
    insertNewerSession() {
      metadata.push(sessionMetadata('session-4', 4_000));
      projections.set('session-4', sessionProjection('session-4', 4, 'idle'));
    },
    appendConcurrentHistory() {
      events.push(
        historyEvent(4, 'user.message_appended', {
          message_id: 'message-4',
          content: 'new after first page',
        }),
      );
    },
  };
}

function sessionMetadata(sessionId: string, updatedAt: number): RuntimeLogSessionEntry {
  return {
    sessionId,
    displayName: sessionId,
    needsSmartName: false,
    updatedAt,
    lastSequence: sessionId === 'session-2' ? 3 : 0,
  };
}

function sessionProjection(sessionId: string, revision: number, status: 'idle' | 'running') {
  return {
    schema: 'kite.runtime-projection.v1' as const,
    sessionId,
    revision,
    displayName: sessionId,
    updatedAt: `2026-08-30T00:00:0${Math.min(revision, 9)}.000Z`,
    lifecycle: 'open' as const,
    interactionQueue: { revision, interactions: [] },
    ...(status === 'running'
      ? { activeWork: { workId: `work-${sessionId}`, phase: 'building' as const, status } }
      : {}),
  };
}

function historyEvent(
  sequence: number,
  type: string,
  fields: Readonly<Record<string, string>>,
): RuntimeLogEventEntry {
  return {
    sessionId: 'session-2',
    sequence,
    eventId: `event-${sequence}`,
    occurredAt: `2026-08-30T00:00:0${Math.min(sequence, 9)}.000Z`,
    createdAt: 1_777_680_000 + sequence,
    type,
    category: 'turn',
    status: 'unknown',
    detail: {
      kind: type.startsWith('model.') ? 'model' : type.startsWith('tool.') ? 'tool' : 'message',
      fields,
    },
  };
}

function checkpoint(checkpointId: string, revision: number): AgentApiCheckpointMetadata {
  return {
    checkpointId,
    sessionId: 'session-2',
    revision,
    eventPosition: revision,
    createdAt: 1_777_680_000 + revision,
    affectedFileCount: 1,
  };
}
