import { describe, expect, test } from 'bun:test';
import { AGENT_API_ARTIFACT_DIGEST, AGENT_API_VERSION } from '@kite-ai/agent-api-contract';
import { AgentApiClientError, createAgentApiBrowserClient } from '../src';

const headers = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'kite-agent-api-schema-digest': AGENT_API_ARTIFACT_DIGEST,
  'kite-agent-api-version': AGENT_API_VERSION,
};

describe('Agent API Browser client', () => {
  test('uses cookie-authenticated REST and validates path-free Workspace responses', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createAgentApiBrowserClient({
      baseUrl: 'http://127.0.0.1:43123',
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            schema: 'kite.agent-api.workspace-page.v1',
            items: [
              {
                schema: 'kite.agent-api.workspace.v1',
                workspace_id: 'workspace-1',
                display_name: 'kite-code',
                session_count: 1,
              },
            ],
          }),
          { status: 200, headers },
        );
      },
    });
    const page = await client.listWorkspaces({ limit: 20 });
    expect(page.items[0]?.workspace_id).toBe('workspace-1');
    expect(requests[0]?.url).toBe('http://127.0.0.1:43123/v1/workspaces?limit=20');
    expect(requests[0]?.init).toMatchObject({
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });
  });

  test('encodes an incremental History boundary without adding recovery policy', async () => {
    let url = '';
    const client = createAgentApiBrowserClient({
      fetch: async (input) => {
        url = String(input);
        return new Response(
          JSON.stringify({
            schema: 'kite.agent-api.history-page.v1',
            session_id: 'session-1',
            through_sequence: 7,
            items: [],
          }),
          { status: 200, headers },
        );
      },
    });
    await client.listHistory('session-1', { afterSequence: 6, limit: 20 });
    expect(url).toBe('/v1/sessions/session-1/history?limit=20&after_sequence=6');
    expect(() => client.listHistory('session-1', { afterSequence: -1 })).toThrow(TypeError);
  });

  test('reads the bounded diagnostic log surface with the same sequence boundary', async () => {
    let url = '';
    const client = createAgentApiBrowserClient({
      fetch: async (input) => {
        url = String(input);
        return new Response(
          JSON.stringify({
            schema: 'kite.agent-api.log-page.v1',
            session_id: 'session-1',
            through_sequence: 7,
            items: [],
          }),
          { status: 200, headers },
        );
      },
    });
    await client.listLogs('session-1', { afterSequence: 6, limit: 20 });
    expect(url).toBe('/v1/sessions/session-1/logs?limit=20&after_sequence=6');
  });

  test('reads one Browser-only Model Context by exact invocation identity', async () => {
    let url = '';
    const client = createAgentApiBrowserClient({
      fetch: async (input) => {
        url = String(input);
        return new Response(
          JSON.stringify({
            schema: 'kite.agent-api.model-context.v1',
            session_id: 'session-1',
            invocation_id: 'invocation-1',
            sequence: 3,
            purpose: 'primary_agent',
            model: { provider: 'openai', name: 'model-1' },
            system_prompt: { text: 'System prompt', truncated: false },
            messages: [],
            messages_truncated: false,
            tools: [],
            tools_truncated: false,
            request_settings: {
              transport: 'stream',
              temperature: 0,
              max_output_tokens: 4096,
              stop_policy: { kind: 'single_step', max_steps: 1 },
              message_count: 0,
              tool_count: 0,
            },
          }),
          { status: 200, headers },
        );
      },
    });
    await client.getModelContext('session-1', 'invocation-1');
    expect(url).toBe('/v1/sessions/session-1/model-invocations/invocation-1/context');
  });

  test('decodes closed Problem responses and rejects contract drift', async () => {
    const client = createAgentApiBrowserClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            schema: 'kite.agent-api.problem.v1',
            type: 'urn:kite:agent-api:problem:unauthorized',
            title: 'Unauthorized',
            status: 401,
            code: 'unauthorized',
            request_id: 'request-1',
            retryable: false,
          }),
          {
            status: 401,
            headers: { ...headers, 'content-type': 'application/problem+json; charset=utf-8' },
          },
        ),
    });
    await expect(client.getServerInfo()).rejects.toMatchObject({
      status: 401,
      problem: { code: 'unauthorized' },
    });

    const drifted = createAgentApiBrowserClient({
      fetch: async () =>
        new Response('{}', {
          status: 200,
          headers: { ...headers, 'kite-agent-api-version': 'v2' },
        }),
    });
    await expect(drifted.getServerInfo()).rejects.toBeInstanceOf(AgentApiClientError);
  });
});
