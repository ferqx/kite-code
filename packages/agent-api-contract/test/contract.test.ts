import { describe, expect, test } from 'bun:test';
import {
  AGENT_API_LIMITS,
  AgentApiContractValidationError,
  agentApiContextSchema,
  agentApiCreateRunRequestSchema,
  agentApiExchangeRequestSchema,
  agentApiInteractionResponseRequestSchema,
  agentApiMutationHeadersSchema,
  agentApiProblemSchema,
  agentApiResyncSchema,
  agentApiRunSchema,
  agentApiServerInfoSchema,
  agentApiSessionListQuerySchema,
  agentApiSessionSchema,
  agentApiWorkspaceSchema,
  assertAgentApiJsonValue,
  decodeAgentApiRequest,
  decodeAgentApiResponse,
  encodeAgentApiResponse,
  requestCodec,
  responseCodec,
  utf8ByteLength,
} from '../src/index';

async function fixture(name: string): Promise<unknown> {
  return Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).json();
}

describe('Agent API V1 contract', () => {
  test('decodes the committed request and response fixtures', async () => {
    const createRun = await fixture('create-run-request.json');
    expect(
      JSON.parse(JSON.stringify(decodeAgentApiRequest(agentApiCreateRunRequestSchema, createRun))),
    ).toEqual(createRun);

    const serverInfo = await fixture('server-info.json');
    expect(
      JSON.parse(JSON.stringify(decodeAgentApiResponse(agentApiServerInfoSchema, serverInfo))),
    ).toEqual(serverInfo);

    const run = await fixture('run.json');
    expect(JSON.parse(JSON.stringify(decodeAgentApiResponse(agentApiRunSchema, run)))).toEqual(run);

    const problem = await fixture('problem.json');
    expect(
      JSON.parse(JSON.stringify(decodeAgentApiResponse(agentApiProblemSchema, problem))),
    ).toEqual(problem);

    const workspace = await fixture('workspace.json');
    expect(
      JSON.parse(JSON.stringify(decodeAgentApiResponse(agentApiWorkspaceSchema, workspace))),
    ).toEqual(workspace);
  });

  test('keeps requests recursively closed and materializes only declared defaults', () => {
    expect(() =>
      decodeAgentApiRequest(agentApiCreateRunRequestSchema, {
        schema: 'kite.agent-api.create-run.v1',
        input: 'work',
        phase: 'building',
        initial_skills: [{ skill_id: 'skill', input: { safe: true }, extra: true }],
      }),
    ).toThrow('request.initial_skills[0].extra');
    expect(() =>
      decodeAgentApiRequest(agentApiCreateRunRequestSchema, {
        schema: 'kite.agent-api.create-run.v1',
        input: 'work',
        phase: 'building',
        workspace: '/private',
      }),
    ).toThrow('request.workspace');

    expect(decodeAgentApiRequest(agentApiSessionListQuerySchema, {})).toEqual({ limit: 50 });
    expect(
      requestCodec(agentApiExchangeRequestSchema).safeDecode({
        schema: 'kite.agent-api.exchange.v1',
        api_version: 'v1',
        required_capabilities: ['sessions', 'history'],
      }).success,
    ).toBeFalse();
  });

  test('lets clients ignore optional response additions but fails Server encoding closed', () => {
    const future = {
      schema: 'kite.agent-api.session.v1',
      session_id: 'session-1',
      revision: 2,
      lifecycle: 'open',
      status: 'idle',
      model: {
        provider: 'provider-1',
        name: 'model-1',
        future_nested_display: 'safe-to-ignore',
      },
      future_display: true,
    };
    expect(decodeAgentApiResponse(agentApiSessionSchema, future)).toEqual({
      schema: 'kite.agent-api.session.v1',
      session_id: 'session-1',
      revision: 2,
      lifecycle: 'open',
      status: 'idle',
      model: { provider: 'provider-1', name: 'model-1' },
    });
    expect(() => encodeAgentApiResponse(agentApiSessionSchema, future as never)).toThrow(
      'undeclared response field',
    );
    expect(
      responseCodec(agentApiSessionSchema).encode({
        schema: 'kite.agent-api.session.v1',
        session_id: 'session-1',
        revision: 2,
        lifecycle: 'open',
        status: 'idle',
      }),
    ).toEqual({
      schema: 'kite.agent-api.session.v1',
      session_id: 'session-1',
      revision: 2,
      lifecycle: 'open',
      status: 'idle',
    });
  });

  test('rejects unsafe, cyclic, accessor-bearing, deep and oversized JSON before schemas', () => {
    expect(() => assertAgentApiJsonValue({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      AgentApiContractValidationError,
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertAgentApiJsonValue(cyclic)).toThrow('cycle');

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'secret' });
    expect(() => assertAgentApiJsonValue(accessor)).toThrow('accessor');

    let deep: unknown = 'end';
    for (let index = 0; index <= AGENT_API_LIMITS.maxDepth; index += 1) {
      deep = { next: deep };
    }
    expect(() => assertAgentApiJsonValue(deep)).toThrow('depth');
    expect(() =>
      assertAgentApiJsonValue({ text: 'x'.repeat(AGENT_API_LIMITS.maxMessageBytes) }),
    ).toThrow('message size');
    expect(() => assertAgentApiJsonValue(JSON.parse('{"__proto__":{}}'))).toThrow(
      'forbidden object key',
    );
  });

  test('uses UTF-8 bytes and exact timestamps at scalar boundaries', () => {
    expect(utf8ByteLength('风筝')).toBe(6);
    const longName = '筝'.repeat(86);
    expect(() =>
      decodeAgentApiRequest(agentApiSessionListQuerySchema, { cursor: longName }),
    ).toThrow();
    expect(
      agentApiRunSchema.safeParse({
        schema: 'kite.agent-api.run.v1',
        run_id: 'run-1',
        session_id: 'session-1',
        status: 'completed',
        phase: 'building',
        created_at: '2026-08-29T08:00:00Z',
        started_at: '2026-08-29T08:00:00.001Z',
        finished_at: '2026-08-29T08:01:00.000Z',
      }).success,
    ).toBeFalse();
  });

  test('freezes context token, idempotency key, ETag and Problem mappings', () => {
    expect(
      agentApiContextSchema.safeParse({
        schema: 'kite.agent-api.context.v1',
        access_token: 'a'.repeat(43),
        token_type: 'Bearer',
        expires_at: '2026-08-29T08:00:00.000Z',
        role: 'observer',
        api_version: 'v1',
        capabilities: ['history', 'sessions'],
      }).success,
    ).toBeTrue();
    expect(
      agentApiContextSchema.safeParse({
        schema: 'kite.agent-api.context.v1',
        access_token: 'short',
        token_type: 'Bearer',
        expires_at: '2026-08-29T08:00:00.000Z',
        role: 'observer',
        api_version: 'v1',
        capabilities: [],
      }).success,
    ).toBeFalse();
    expect(
      decodeAgentApiRequest(agentApiMutationHeadersSchema, {
        idempotency_key: 'a'.repeat(22),
        if_match: '"session:session-1:rev:42"',
      }),
    ).toEqual({
      idempotency_key: 'a'.repeat(22),
      if_match: '"session:session-1:rev:42"',
    });
    expect(
      agentApiMutationHeadersSchema.safeParse({
        idempotency_key: 'predictable',
        if_match: '*',
      }).success,
    ).toBeFalse();
    expect(
      agentApiProblemSchema.safeParse({
        schema: 'kite.agent-api.problem.v1',
        type: 'urn:kite:agent-api:problem:revision_conflict',
        title: 'Conflict',
        status: 409,
        code: 'revision_conflict',
        request_id: 'request-1',
        retryable: true,
        current_revision: 42,
      }).success,
    ).toBeFalse();
  });

  test('enforces Run lifecycle and resync replacement invariants', () => {
    const activeWithFinish = {
      schema: 'kite.agent-api.run.v1',
      run_id: 'run-1',
      session_id: 'session-1',
      status: 'running',
      phase: 'building',
      created_at: '2026-08-29T08:00:00.000Z',
      started_at: '2026-08-29T08:00:00.001Z',
      finished_at: '2026-08-29T08:01:00.000Z',
    };
    expect(agentApiRunSchema.safeParse(activeWithFinish).success).toBeFalse();

    const session = {
      schema: 'kite.agent-api.session.v1' as const,
      session_id: 'session-1',
      revision: 3,
      lifecycle: 'open' as const,
      status: 'waiting' as const,
    };
    expect(
      agentApiResyncSchema.safeParse({
        schema: 'kite.agent-api.resync.v1',
        reason: 'initial',
        stream_generation: 'generation-1',
        history_through_sequence: 3,
        snapshot_revision: 3,
        session,
        interactions: {
          schema: 'kite.agent-api.interaction-queue.v1',
          session_id: 'session-other',
          revision: 3,
          interactions: [],
        },
        resume_after_event_id: 'cursor_1',
      }).success,
    ).toBeFalse();
  });

  test('pairs each complete Interaction identity with its matching response kind', () => {
    const approval = {
      schema: 'kite.agent-api.interaction-response.v1',
      interaction: {
        schema: 'kite.agent-api.interaction.v1',
        interaction_id: 'interaction-1',
        session_revision: 4,
        kind: 'approval',
        generation: 1,
        grants: ['approve_once'],
      },
      response: { kind: 'approval', decision: 'approve_once' },
    };
    expect(
      JSON.parse(
        JSON.stringify(decodeAgentApiRequest(agentApiInteractionResponseRequestSchema, approval)),
      ),
    ).toEqual(approval);
    expect(
      agentApiInteractionResponseRequestSchema.safeParse({
        ...approval,
        response: { kind: 'input_cancel' },
      }).success,
    ).toBeFalse();
  });
});
