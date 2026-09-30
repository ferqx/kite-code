import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AGENT_API_LIMITS } from '@kite-ai/agent-api-contract';
import type { RuntimeLogEventEntry, RuntimeQuery } from '@kite-ai/runtime-contract';
import {
  type AgentApiReadContext,
  dispatchAgentApiReadRequest,
  disposeModelContextPageSnapshots,
} from '../../src/agent-api/read-adapter';

const sessionProjection = {
  schema: 'kite.runtime-projection.v2',
  sessionId: 'session-1',
  revision: 7,
  displayName: 'Session one',
  updatedAt: '2026-08-30T01:02:03.000Z',
  lifecycle: 'open',
  model: { provider: 'provider-1', name: 'model-1', reasoningEnabled: true },
  interactionQueue: { revision: 7, interactions: [] },
  activeTask: { taskId: 'task-1', phase: 'building' },
  currentRun: {
    runId: 'run-1',
    initialTurnId: 'turn-1',
    activeTurnId: 'turn-1',
    taskId: 'task-1',
    status: 'running',
    revision: 7,
  },
} as const;

function fixture(
  options: {
    readonly boundaryEventId?: string;
    readonly directorySessionName?: string;
    readonly events?: readonly RuntimeLogEventEntry[];
    readonly projectionDisplayName?: string;
    readonly backgroundExecutionCount?: number;
    readonly backgroundGeneration?: string;
  } = {},
) {
  const queries: RuntimeQuery[] = [];
  const sessionPages: unknown[] = [];
  const eventPages: unknown[] = [];
  let closed = 0;
  const events: readonly RuntimeLogEventEntry[] = options.events ?? [
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
              session: {
                ...sessionProjection,
                displayName: options.projectionDisplayName ?? sessionProjection.displayName,
              },
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
      if (query.type === 'list_background_executions') {
        const executions = Array.from(
          { length: options.backgroundExecutionCount ?? 1 },
          (_, index) => ({
            executionId: `shell-${index + 1}`,
            sessionId: query.sessionId,
            sessionRevision: 7,
            kind: 'service' as const,
            status: 'running' as const,
            ownerGeneration: 'owner-1',
            revision: 3,
            cleanupConfirmed: false,
            cursor: 7,
          }),
        );
        const offset = query.cursor ?? 0;
        const selected = executions.slice(offset, offset + (query.limit ?? executions.length));
        return {
          status: 'ok',
          queryType: query.type,
          backgroundSnapshot: {
            sessionId: query.sessionId,
            sessionRevision: 7,
            aggregateGeneration: options.backgroundGeneration ?? 'aggregate-1',
            watermark: 3,
            executions: selected,
          },
          ...(offset + selected.length < executions.length
            ? { nextBackgroundCursor: offset + selected.length }
            : {}),
        };
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
            entry.sequence < (request.beforeSequence ?? Number.MAX_SAFE_INTEGER) &&
            (!request.eventTypes || request.eventTypes.includes(entry.type)),
        );
        const selected = candidates.slice(0, request.limit);
        return {
          entries: selected,
          ...(candidates.length > selected.length ? { nextCursor: selected.at(-1)!.sequence } : {}),
          hasMore: candidates.length > selected.length,
          observedLastSequence: events.at(-1)?.sequence ?? 0,
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
    modelContexts: {
      get: (sessionId, invocationId) =>
        sessionId === 'session-1' && invocationId === 'invocation-1'
          ? {
              sessionId,
              invocationId,
              sequence: 3,
              purpose: 'primary_agent',
              provider: 'openai-compatible',
              model: 'model-1',
              systemPrompt: 'You are Kite.\n\nUse the available tools carefully.',
              messages: [
                { role: 'user', parts: [{ type: 'text', text: 'Inspect this workspace.' }] },
                {
                  role: 'assistant',
                  parts: [
                    {
                      type: 'tool_call',
                      toolCallId: 'tool-call-1',
                      toolName: 'read_file',
                      inputJson: '{"path":"README.md"}',
                    },
                  ],
                },
              ],
              tools: [
                {
                  name: 'read_file',
                  description: 'Read a file.',
                  inputSchemaJson: '{"type":"object"}',
                },
              ],
              settings: {
                transport: 'stream',
                temperature: 0,
                maxOutputTokens: 4_096,
                stopPolicy: { kind: 'single_step', maxSteps: 1 },
              },
            }
          : undefined,
    },
    directory: {
      list: () => [
        {
          workspaceId: 'workspace-1',
          displayName: 'Workspace one',
          sessions: [
            {
              sessionId: 'session-1',
              name: options.directorySessionName ?? 'Session one',
              updatedAt: 1_777_680_000,
              lastSequence: 2,
            },
          ],
        },
      ],
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
  test('lists path-free Workspaces and their projected Sessions from one directory authority', async () => {
    const f = fixture();
    const workspaces = await dispatch(f.context, '/v1/workspaces?limit=10');
    expect(workspaces).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          schema: 'kite.agent-api.workspace-page.v1',
          items: [
            {
              workspace_id: 'workspace-1',
              display_name: 'Workspace one',
              session_count: 1,
            },
          ],
        },
      },
    });
    expect(JSON.stringify(workspaces)).not.toContain('/');

    const sessions = await dispatch(
      f.context,
      '/v1/workspaces/workspace-1/sessions?limit=10&status=running',
    );
    expect(sessions).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          schema: 'kite.agent-api.session-page.v1',
          workspace_id: 'workspace-1',
          items: [{ session_id: 'session-1', status: 'running' }],
        },
      },
    });
  });

  test('derives an unnamed Workspace Session title from its first user message', async () => {
    const f = fixture({ directorySessionName: '', projectionDisplayName: '' });
    const sessions = await dispatch(f.context, '/v1/workspaces/workspace-1/sessions?limit=10');
    expect(sessions).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          items: [{ session_id: 'session-1', display_name: 'hello' }],
        },
      },
    });
    expect(f.eventPages).toEqual([
      {
        sessionId: 'session-1',
        direction: 'forward',
        limit: 1,
        eventTypes: ['user.message_appended'],
      },
    ]);
  });

  test('falls back to the Session ID when an unnamed Session has no user message', async () => {
    const f = fixture({
      directorySessionName: '',
      projectionDisplayName: '',
      events: [],
    });
    const sessions = await dispatch(f.context, '/v1/workspaces/workspace-1/sessions?limit=10');
    expect(sessions).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          items: [{ session_id: 'session-1', display_name: 'session-1' }],
        },
      },
    });
  });

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

  test('projects a pre-dispatch rejection without collapsing it into execution failure', async () => {
    const base = {
      sessionId: 'session-1',
      occurredAt: '2026-08-30T01:00:00.000Z',
      createdAt: 1_777_680_000,
      category: 'tool' as const,
    };
    const f = fixture({
      events: [
        {
          ...base,
          sequence: 1,
          eventId: 'event-tool-queued',
          type: 'tool.queued',
          status: 'waiting',
          detail: {
            kind: 'tool',
            fields: { tool_call_id: 'tool-shell', label: 'shell_execute' },
          },
        },
        {
          ...base,
          sequence: 2,
          eventId: 'event-tool-rejected',
          type: 'tool.rejected',
          status: 'failed',
          detail: {
            kind: 'tool',
            fields: {
              tool_call_id: 'tool-shell',
              label: 'Tool',
              reason_code: 'policy_denied',
              rejection_summary: 'Tool execution was rejected by policy before dispatch.',
            },
          },
        },
      ],
    });

    const result = await dispatch(f.context, '/v1/sessions/session-1/history?limit=10');

    expect(result).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          items: [
            { content: { type: 'tool.lifecycle', status: 'queued' } },
            {
              content: {
                type: 'tool.lifecycle',
                status: 'rejected',
                reason_code: 'policy_denied',
                summary: 'Tool execution was rejected by policy before dispatch.',
              },
            },
          ],
        },
      },
    });
  });

  test('lists developer-readable safe logs without exposing raw event objects', async () => {
    const f = fixture();
    const first = await dispatch(f.context, '/v1/sessions/session-1/logs?limit=1');
    if (!first.matched || !first.result.ok) throw new Error('Log page was unavailable.');
    const firstBody = first.result.body as {
      through_sequence: number;
      items: Array<{
        sequence: number;
        event_type: string;
        category: string;
        status: string;
        detail: { kind: string; fields: Array<{ name: string; value: string }> };
      }>;
      next_cursor: string;
    };
    expect(firstBody).toMatchObject({
      through_sequence: 2,
      items: [
        {
          sequence: 1,
          event_type: 'user.message_appended',
          category: 'turn',
          status: 'unknown',
          detail: {
            kind: 'message',
            fields: [
              { name: 'content', value: 'hello' },
              { name: 'message_id', value: 'message-1' },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(firstBody)).not.toContain('eventId');

    const second = await dispatch(
      f.context,
      `/v1/sessions/session-1/logs?limit=1&cursor=${firstBody.next_cursor}`,
    );
    expect(second).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          through_sequence: 2,
          items: [{ sequence: 2, event_type: 'model.responded', category: 'model' }],
        },
      },
    });
  });

  test('reads a bounded Browser-only Model Context without Artifact identity', async () => {
    const f = fixture();
    const result = await dispatch(
      f.context,
      '/v1/sessions/session-1/model-invocations/invocation-1/context',
    );
    expect(result).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          schema: 'kite.agent-api.model-context-page.v1',
          session_id: 'session-1',
          invocation_id: 'invocation-1',
          sequence: 3,
        },
      },
    });
    if (!result.matched || !result.result.ok) throw new Error('Expected context page.');
    const page = result.result.body as { payload_base64: string };
    const context = JSON.parse(Buffer.from(page.payload_base64, 'base64').toString('utf8'));
    expect(context).toMatchObject({
      schema: 'kite.agent-api.model-context.v1',
      purpose: 'primary_agent',
      model: { provider: 'openai-compatible', name: 'model-1' },
      system_prompt: {
        text: 'You are Kite.\n\nUse the available tools carefully.',
        truncated: false,
      },
      messages: [
        { index: 0, role: 'user' },
        { index: 1, role: 'assistant' },
      ],
      tools: [{ name: 'read_file', input_schema_json: '{"type":"object"}' }],
      request_settings: { message_count: 2, tool_count: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/artifact|integrity|credential|api[_-]?key/iu);
  });

  test('pages complete large Model Context without dropping messages, tools or field tails', async () => {
    const f = fixture();
    const original = f.context.modelContexts!.get('session-1', 'invocation-1')!;
    const source = {
      ...original,
      systemPrompt: `System start ${'指令'.repeat(200_000)} system end`,
      messages: Array.from({ length: 211 }, (_, index) => ({
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: `message-${index}-${'内容'.repeat(1_000)}` }],
      })),
      tools: Array.from({ length: 213 }, (_, index) => ({
        name: `tool-${index}`,
        description: `description-${index}-${'说明'.repeat(1_000)}`,
        inputSchemaJson: `{"name":"tool-${index}","body":"${'x'.repeat(8_000)}"}`,
      })),
    };
    const context: AgentApiReadContext = {
      ...f.context,
      modelContexts: { get: () => source },
    };
    const pages: Buffer[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    let digest: string | undefined;
    let totalBytes = 0;
    let offset = 0;
    try {
      do {
        const result = await dispatch(
          context,
          `/v1/sessions/session-1/model-invocations/invocation-1/context${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        if (!result.matched || !result.result.ok) {
          throw new Error(`Expected context page: ${JSON.stringify(result)}`);
        }
        const page = result.result.body as {
          session_id: string;
          invocation_id: string;
          offset: number;
          total_bytes: number;
          sha256: string;
          payload_base64: string;
          next_cursor?: string;
        };
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_048_576);
        expect(page.session_id).toBe('session-1');
        expect(page.invocation_id).toBe('invocation-1');
        expect(page.offset).toBe(offset);
        const bytes = Buffer.from(page.payload_base64, 'base64');
        pages.push(bytes);
        offset += bytes.length;
        totalBytes = page.total_bytes;
        digest = page.sha256;
        cursor = page.next_cursor;
        firstCursor ??= cursor;
      } while (cursor);
      expect(pages.length).toBeGreaterThan(32);
      expect(offset).toBe(totalBytes);
      const complete = Buffer.concat(pages);
      expect(createHash('sha256').update(complete).digest('hex')).toBe(digest);
      const projection = JSON.parse(complete.toString('utf8'));
      expect(projection.system_prompt.text.endsWith(' system end')).toBe(true);
      expect(projection.system_prompt.truncated).toBe(false);
      expect(projection.messages).toHaveLength(211);
      expect(projection.messages[210].parts[0].text.endsWith('内容')).toBe(true);
      expect(projection.tools).toHaveLength(213);
      expect(projection.tools[212].input_schema_json.endsWith('"}')).toBe(true);
      expect(projection.tools[212].description.endsWith('说明')).toBe(true);
      expect(projection.messages_truncated).toBe(false);
      expect(projection.tools_truncated).toBe(false);
      const wrongInvocation = await dispatch(
        context,
        `/v1/sessions/session-1/model-invocations/other/context?cursor=${encodeURIComponent(firstCursor!)}`,
      );
      expect(wrongInvocation).toMatchObject({
        matched: true,
        result: { ok: false, status: 400, code: 'invalid_cursor' },
      });
    } finally {
      disposeModelContextPageSnapshots(context.modelContexts!);
    }
  });

  test('hides Model Context from an Agent bearer read context', async () => {
    const f = fixture();
    const result = await dispatch(
      { ...f.context, directory: undefined },
      '/v1/sessions/session-1/model-invocations/invocation-1/context',
    );
    expect(result).toMatchObject({
      matched: true,
      result: { ok: false, status: 404, code: 'not_found' },
    });
  });

  test('reads only durable History after the requested sequence for bounded polling', async () => {
    const f = fixture();
    const incremental = await dispatch(
      f.context,
      '/v1/sessions/session-1/history?after_sequence=1&limit=10',
    );
    expect(incremental).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          through_sequence: 2,
          items: [
            { sequence: 2, content: { type: 'model.reasoning' } },
            { sequence: 2, content: { type: 'model.message' } },
          ],
        },
      },
    });
    expect(f.eventPages).toContainEqual({
      sessionId: 'session-1',
      afterSequence: 1,
      direction: 'forward',
      limit: 10,
    });
    expect(
      await dispatch(
        f.context,
        '/v1/sessions/session-1/history?after_sequence=1&cursor=eyJub3QiOiJ2YWxpZCJ9',
      ),
    ).toMatchObject({ matched: true, result: { ok: false, status: 400 } });
  });

  test('hides Session reads outside the Browser directory authority', async () => {
    const f = fixture();
    expect(await dispatch(f.context, '/v1/sessions/session-hidden')).toMatchObject({
      matched: true,
      result: { ok: false, status: 404, code: 'not_found' },
    });
    expect(f.queries).toEqual([]);
  });

  test('checks indexed root membership without loading the directory for Session pages', async () => {
    const f = fixture();
    const checked: string[] = [];
    const context: AgentApiReadContext = {
      ...f.context,
      directory: {
        list: () => {
          throw new Error('Full directory scan is forbidden for Session reads.');
        },
        hasRootSession: (sessionId) => {
          checked.push(sessionId);
          return sessionId === 'session-1';
        },
      },
    };
    expect(await dispatch(context, '/v1/sessions/session-1')).toMatchObject({
      matched: true,
      result: { ok: true },
    });
    expect(await dispatch(context, '/v1/sessions/session-1/history?limit=1')).toMatchObject({
      matched: true,
      result: { ok: true },
    });
    expect(await dispatch(context, '/v1/sessions/session-hidden')).toMatchObject({
      matched: true,
      result: { ok: false, status: 404 },
    });
    expect(checked).toEqual(['session-1', 'session-1', 'session-hidden']);
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

  test('projects owner-scoped background executions through GET only', async () => {
    const f = fixture();
    const result = await dispatch(f.context, '/v1/sessions/session-1/background-executions');
    expect(result).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: {
          schema: 'kite.agent-api.background-execution-page.v1',
          session_id: 'session-1',
          stale: false,
          items: [
            {
              schema: 'kite.agent-api.background-execution.v1',
              execution_id: 'shell-1',
              owner_generation: 'owner-1',
              revision: 3,
              kind: 'service',
              status: 'running',
              cleanup_confirmed: false,
              cursor: 7,
            },
          ],
        },
      },
    });
    expect(
      await dispatch(f.context, '/v1/sessions/session-hidden/background-executions'),
    ).toMatchObject({
      result: { ok: false, status: 404 },
    });
  });

  test('paginates background executions with a scoped cursor', async () => {
    const f = fixture({ backgroundExecutionCount: 3 });
    const first = await dispatch(f.context, '/v1/sessions/session-1/background-executions?limit=2');
    expect(first).toMatchObject({
      matched: true,
      result: {
        ok: true,
        body: { items: [{ execution_id: 'shell-1' }, { execution_id: 'shell-2' }] },
      },
    });
    if (!first.matched || !first.result.ok) throw new Error('Missing background page.');
    const cursor = (first.result.body as { next_cursor?: string }).next_cursor;
    expect(typeof cursor).toBe('string');
    const second = await dispatch(
      f.context,
      `/v1/sessions/session-1/background-executions?limit=2&cursor=${cursor}`,
    );
    expect(second).toMatchObject({
      matched: true,
      result: { ok: true, body: { items: [{ execution_id: 'shell-3' }] } },
    });
    const queries = f.queries.filter((query) => query.type === 'list_background_executions');
    expect(queries[0]).not.toHaveProperty('cursor');
    expect(queries[0]).toMatchObject({ limit: 2 });
    expect(queries[1]).toMatchObject({ cursor: 2, limit: 2 });
    const changed = fixture({ backgroundExecutionCount: 3, backgroundGeneration: 'aggregate-2' });
    expect(
      await dispatch(
        changed.context,
        `/v1/sessions/session-1/background-executions?limit=2&cursor=${cursor}`,
      ),
    ).toMatchObject({ result: { ok: false, status: 409, code: 'cursor_invalidated' } });
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

  test('ends a large History page before the encoded response exceeds one MiB', async () => {
    const text = 'x'.repeat(65_536);
    const events: RuntimeLogEventEntry[] = Array.from({ length: 24 }, (_, index) => ({
      sessionId: 'session-1',
      sequence: index + 1,
      eventId: `large-event-${index + 1}`,
      occurredAt: '2026-08-30T01:00:00.000Z',
      createdAt: 1_777_680_000 + index,
      type: 'user.message_appended',
      category: 'turn',
      status: 'unknown',
      detail: {
        kind: 'message',
        fields: { message_id: `large-message-${index + 1}`, content: text },
      },
    }));
    const f = fixture({ events });
    let path = '/v1/sessions/session-1/history?limit=200';
    const sequences: number[] = [];
    let pages = 0;
    for (;;) {
      const result = await dispatch(f.context, path);
      if (!result.matched || !result.result.ok) throw new Error('History page was unavailable.');
      const body = result.result.body as {
        readonly items: readonly { readonly sequence: number }[];
        readonly next_cursor?: string;
      };
      expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(
        AGENT_API_LIMITS.maxMessageBytes,
      );
      sequences.push(...body.items.map((item) => item.sequence));
      pages += 1;
      if (!body.next_cursor) break;
      path = `/v1/sessions/session-1/history?limit=200&cursor=${body.next_cursor}`;
    }

    expect(pages).toBeGreaterThan(1);
    expect(sequences).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
  });
});
