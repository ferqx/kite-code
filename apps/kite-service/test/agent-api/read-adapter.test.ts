import { describe, expect, test } from 'bun:test';
import type { RuntimeLogEventEntry, RuntimeQuery } from '@kite-ai/runtime-contract';
import {
  type AgentApiReadContext,
  dispatchAgentApiReadRequest,
} from '../../src/agent-api/read-adapter';

const sessionProjection = {
  schema: 'kite.runtime-projection.v1',
  sessionId: 'session-1',
  revision: 7,
  displayName: 'Session one',
  updatedAt: '2026-08-30T01:02:03.000Z',
  lifecycle: 'open',
  model: { provider: 'provider-1', name: 'model-1', reasoningEnabled: true },
  interactionQueue: { revision: 7, interactions: [] },
  activeWork: { workId: 'work-1', phase: 'building', status: 'running' },
} as const;

function fixture(options: { readonly boundaryEventId?: string } = {}) {
  const queries: RuntimeQuery[] = [];
  const sessionPages: unknown[] = [];
  const eventPages: unknown[] = [];
  let closed = 0;
  const events: RuntimeLogEventEntry[] = [
    {
      sessionId: 'session-1',
      sequence: 1,
      eventId: 'event-1',
      occurredAt: '2026-08-30T01:00:00.000Z',
      createdAt: 1_777_680_000,
      type: 'user.message_appended',
      category: 'turn',
      status: 'unknown',
      detail: {
        kind: 'message',
        fields: { message_id: 'message-1', content: 'hello' },
      },
    },
    {
      sessionId: 'session-1',
      sequence: 2,
      eventId: options.boundaryEventId ?? 'event-2',
      occurredAt: '2026-08-30T01:01:00.000Z',
      createdAt: 1_777_680_060,
      type: 'model.responded',
      category: 'model',
      status: 'unknown',
      detail: {
        kind: 'model',
        fields: {
          message_id: 'message-2',
          request_id: 'request-2',
          reasoning_text: 'thinking',
          text: 'world',
        },
      },
    },
  ];
  const context: AgentApiReadContext = {
    async query(query) {
      queries.push(query);
      if (query.type === 'get_session_projection') {
        return query.sessionId === 'session-1'
          ? {
              status: 'ok',
              queryType: query.type,
              revision: sessionProjection.revision,
              session: sessionProjection,
            }
          : { status: 'not_found', queryType: query.type, code: 'session_not_found' };
      }
      if (query.type === 'get_rewind_preview') {
        return query.checkpointId === 'checkpoint-1'
          ? {
              status: 'ok',
              queryType: query.type,
              revision: 7,
              rewindPreview: {
                checkpointId: 'checkpoint-1',
                sessionId: 'session-1',
                revision: 7,
                files: [{ path: 'hidden.ts', addedLines: 3, removedLines: 1 }],
                lineStatsAvailable: true,
                addedLines: 3,
                removedLines: 1,
                conflictCount: 0,
                failureCount: 0,
              },
            }
          : { status: 'not_found', queryType: query.type, code: 'checkpoint_unavailable' };
      }
      return { status: 'rejected', queryType: query.type, code: 'unsupported' };
    },
    history: {
      async listSessions(request) {
        sessionPages.push(request);
        if (!request.cursor) {
          return {
            entries: [
              {
                sessionId: 'session-1',
                displayName: 'Session one',
                needsSmartName: false,
                updatedAt: 1_777_680_000,
                lastSequence: 2,
              },
            ],
            nextCursor: { updatedAt: 1_777_680_000, sessionId: 'session-1' },
            hasMore: true,
          };
        }
        return { entries: [], hasMore: false };
      },
      async listEvents(request) {
        eventPages.push(request);
        const candidates = events.filter(
          (entry) =>
            entry.sequence > (request.afterSequence ?? 0) &&
            entry.sequence < (request.beforeSequence ?? Number.MAX_SAFE_INTEGER),
        );
        const selected = candidates.slice(0, request.limit);
        return {
          entries: selected,
          ...(candidates.length > selected.length ? { nextCursor: selected.at(-1)!.sequence } : {}),
          hasMore: candidates.length > selected.length,
          observedLastSequence: 2,
        };
      },
    },
    checkpoints: {
      list: ({ sessionId }) => ({
        entries: [
          {
            checkpointId: 'checkpoint-1',
            sessionId,
            revision: 5,
            eventPosition: 1,
            createdAt: 1_777_680_000,
            affectedFileCount: 1,
          },
        ],
        hasMore: false,
      }),
      get: (sessionId, checkpointId) =>
        checkpointId === 'checkpoint-1'
          ? {
              checkpointId,
              sessionId,
              revision: 5,
              eventPosition: 1,
              createdAt: 1_777_680_000,
              affectedFileCount: 1,
            }
          : undefined,
    },
    async close() {
      closed += 1;
    },
    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };
  return { context, queries, sessionPages, eventPages, closed: () => closed };
}

async function dispatch(context: AgentApiReadContext, path: string, method = 'GET') {
  const request = new Request(`http://127.0.0.1:43123${path}`, { method });
  return dispatchAgentApiReadRequest({ request, url: new URL(request.url), context });
}

describe('Agent API bounded read adapter', () => {
  test('joins a bounded Session page through the private Runtime query client', async () => {
    const f = fixture();
    const result = await dispatch(f.context, '/v1/sessions?limit=1&status=running');
    if (!result.matched || !result.result.ok) throw new Error('Session page was unavailable.');
    const cursor = (result.result.body as { next_cursor: string }).next_cursor;
    expect(result).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          schema: 'kite.agent-api.session-page.v1',
          items: [
            {
              session_id: 'session-1',
              revision: 7,
              status: 'running',
              lifecycle: 'open',
            },
          ],
          next_cursor: cursor,
        },
      },
    });
    expect(f.sessionPages).toEqual([{ limit: 1 }]);
    expect(f.queries).toEqual([
      {
        schema: 'kite.runtime-query.v1',
        type: 'get_session_projection',
        sessionId: 'session-1',
      },
    ]);

    const next = await dispatch(f.context, `/v1/sessions?limit=1&status=running&cursor=${cursor}`);
    expect(next).toMatchObject({ matched: true, result: { ok: true } });
    expect(f.sessionPages[1]).toEqual({
      limit: 1,
      cursor: { updatedAt: 1_777_680_000, sessionId: 'session-1' },
    });
  });

  test('keeps History fixed through one sequence and resumes inside expanded model output', async () => {
    const f = fixture();
    const first = await dispatch(f.context, '/v1/sessions/session-1/history?limit=2');
    if (!first.matched || !first.result.ok) throw new Error('History page was unavailable.');
    const firstBody = first.result.body as {
      through_sequence: number;
      items: Array<{ content: { type: string } }>;
      next_cursor: string;
    };
    expect(firstBody.through_sequence).toBe(2);
    expect(firstBody.items.map((item) => item.content.type)).toEqual([
      'user.message',
      'model.reasoning',
    ]);
    expect(firstBody.next_cursor).toEqual(expect.any(String));

    const second = await dispatch(
      f.context,
      `/v1/sessions/session-1/history?limit=2&cursor=${firstBody.next_cursor}`,
    );
    expect(second).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          through_sequence: 2,
          items: [{ sequence: 2, public_ordinal: 1, content: { type: 'model.message' } }],
        },
      },
    });
    expect(f.eventPages).toContainEqual({
      sessionId: 'session-1',
      afterSequence: 1,
      beforeSequence: 3,
      direction: 'forward',
      limit: 1,
    });
  });

  test('rejects cursor corruption and boundary replacement without disclosing event identity', async () => {
    const firstFixture = fixture();
    const first = await dispatch(firstFixture.context, '/v1/sessions/session-1/history?limit=1');
    if (!first.matched || !first.result.ok) throw new Error('History page was unavailable.');
    const cursor = (first.result.body as { next_cursor: string }).next_cursor;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    expect(
      await dispatch(firstFixture.context, `/v1/sessions/session-1/history?cursor=${tampered}`),
    ).toMatchObject({
      matched: true,
      result: { ok: false, status: 400, code: 'invalid_cursor' },
    });

    const replaced = fixture({ boundaryEventId: 'replacement-event-2' });
    expect(
      await dispatch(replaced.context, `/v1/sessions/session-1/history?cursor=${cursor}`),
    ).toMatchObject({
      matched: true,
      result: { ok: false, status: 409, code: 'cursor_invalidated' },
    });
  });

  test('projects Checkpoint metadata and preview counts without paths', async () => {
    const f = fixture();
    const listed = await dispatch(f.context, '/v1/sessions/session-1/checkpoints');
    expect(listed).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          items: [
            {
              checkpoint_id: 'checkpoint-1',
              revision: 5,
              scope: 'conversation_and_workspace',
            },
          ],
        },
      },
    });
    const preview = await dispatch(
      f.context,
      '/v1/sessions/session-1/checkpoints/checkpoint-1/preview',
    );
    expect(preview).toMatchObject({
      matched: true,
      result: {
        ok: true,
        etag: '"session:session-1:rev:7"',
        body: { files: { changed: 1, additions: 3, deletions: 1 }, conflict_summaries: [] },
      },
    });
    expect(JSON.stringify(preview)).not.toContain('hidden.ts');
  });

  test('does not register mutation methods or unknown read paths', async () => {
    const f = fixture();
    expect(await dispatch(f.context, '/v1/sessions', 'POST')).toEqual({ matched: false });
    expect(await dispatch(f.context, '/v1/sessions/session-1/runs')).toEqual({
      matched: false,
    });
  });

  test('maps private Runtime admission rejection to a non-disclosing 404', async () => {
    const f = fixture();
    f.context.query = async () => {
      throw { protocol: { data: { code: 'unauthorized' } } };
    };
    expect(await dispatch(f.context, '/v1/sessions/cross-scope')).toMatchObject({
      matched: true,
      result: { ok: false, status: 404, code: 'not_found' },
    });
  });
});
