import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { AGENT_API_ARTIFACT_DIGEST, AGENT_API_VERSION } from '@kite-ai/agent-api-contract';
import { AgentApiClientError, createAgentApiBrowserClient } from '../src';

const headers = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'kite-agent-api-schema-digest': AGENT_API_ARTIFACT_DIGEST,
  'kite-agent-api-version': AGENT_API_VERSION,
};

describe('Agent API Browser client', () => {
  test('requests a replacement Browser session without holding cookie material', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createAgentApiBrowserClient({
      baseUrl: 'http://127.0.0.1:43123',
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(null, { status: 204, headers });
      },
    });

    await client.refreshBrowserSession();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'http://127.0.0.1:43123/v1/auth/browser/session',
      init: {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      },
    });
  });

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
    let corruptDigest = false;
    let injectUnknown = false;
    const context = {
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
    };
    const bytes = Buffer.from(JSON.stringify(context));
    const client = createAgentApiBrowserClient({
      fetch: async (input) => {
        url = String(input);
        const payload = injectUnknown
          ? Buffer.from(JSON.stringify({ ...context, artifact_ref: 'private-artifact' }))
          : bytes;
        return new Response(
          JSON.stringify({
            schema: 'kite.agent-api.model-context-page.v1',
            session_id: 'session-1',
            invocation_id: 'invocation-1',
            sequence: 3,
            snapshot_id: 'snapshot-1',
            sha256: corruptDigest
              ? '0'.repeat(64)
              : createHash('sha256').update(payload).digest('hex'),
            offset: 0,
            total_bytes: payload.length,
            payload_base64: payload.toString('base64'),
          }),
          { status: 200, headers },
        );
      },
    });
    expect((await client.getModelContext('session-1', 'invocation-1')).system_prompt.text).toBe(
      'System prompt',
    );
    expect(url).toBe('/v1/sessions/session-1/model-invocations/invocation-1/context');
    corruptDigest = true;
    await expect(client.getModelContext('session-1', 'invocation-1')).rejects.toMatchObject({
      status: 409,
    });
    corruptDigest = false;
    injectUnknown = true;
    await expect(client.getModelContext('session-1', 'invocation-1')).rejects.toMatchObject({
      status: 409,
    });
  });

  test('assembles a large Model Context with full text and more than 200 messages and tools', async () => {
    const context = {
      schema: 'kite.agent-api.model-context.v1',
      session_id: 'session-1',
      invocation_id: 'invocation-1',
      sequence: 3,
      purpose: 'primary_agent',
      model: { provider: 'openai', name: 'model-1' },
      system_prompt: { text: `开头${'内容'.repeat(300_000)}结尾`, truncated: false },
      messages: Array.from({ length: 211 }, (_, index) => ({
        index,
        role: 'user',
        parts: [{ type: 'text', text: `message-${index}`, truncated: false }],
      })),
      messages_truncated: false,
      tools: Array.from({ length: 213 }, (_, index) => ({
        name: `tool-${index}`,
        description: `description-${index}`,
        input_schema_json: `{"tool":${index}}`,
        truncated: false,
      })),
      tools_truncated: false,
      request_settings: {
        transport: 'stream',
        temperature: 0,
        max_output_tokens: 4096,
        stop_policy: { kind: 'single_step', max_steps: 1 },
        message_count: 211,
        tool_count: 213,
      },
    };
    const bytes = Buffer.from(JSON.stringify(context));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let pages = 0;
    const client = createAgentApiBrowserClient({
      fetch: async (input) => {
        const query = new URL(String(input), 'http://localhost').searchParams;
        const offset = Number(query.get('cursor') ?? 0);
        const next = Math.min(offset + 96 * 1024, bytes.length);
        pages += 1;
        return new Response(
          JSON.stringify({
            schema: 'kite.agent-api.model-context-page.v1',
            session_id: 'session-1',
            invocation_id: 'invocation-1',
            sequence: 3,
            snapshot_id: 'snapshot-large',
            sha256,
            offset,
            total_bytes: bytes.length,
            payload_base64: bytes.subarray(offset, next).toString('base64'),
            ...(next < bytes.length ? { next_cursor: String(next) } : {}),
          }),
          { status: 200, headers },
        );
      },
    });
    const result = await client.getModelContext('session-1', 'invocation-1');
    expect(pages).toBeGreaterThan(10);
    expect(result.system_prompt.text.endsWith('结尾')).toBe(true);
    expect(result.messages).toHaveLength(211);
    expect(result.tools).toHaveLength(213);
    expect(result.messages_truncated).toBe(false);
    expect(result.tools_truncated).toBe(false);
  });

  test('waits FIFO for a Model Context read slot and cancels a queued read without sending it', async () => {
    let started = 0;
    let signalFour!: () => void;
    let release!: () => void;
    const fourStarted = new Promise<void>((resolve) => {
      signalFour = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createAgentApiBrowserClient({
      fetch: async (input) => {
        started += 1;
        if (started === 4) signalFour();
        await gate;
        const invocationId = String(input).split('/').at(-2)!;
        const context = {
          schema: 'kite.agent-api.model-context.v1',
          session_id: 'session-1',
          invocation_id: invocationId,
          sequence: 1,
          purpose: 'primary_agent',
          model: { provider: 'openai', name: 'model-1' },
          system_prompt: { text: 'prompt', truncated: false },
          messages: [],
          messages_truncated: false,
          tools: [],
          tools_truncated: false,
          request_settings: {
            transport: 'stream',
            temperature: 0,
            max_output_tokens: null,
            stop_policy: { kind: 'single_step', max_steps: 1 },
            message_count: 0,
            tool_count: 0,
          },
        };
        const bytes = Buffer.from(JSON.stringify(context));
        return new Response(
          JSON.stringify({
            schema: 'kite.agent-api.model-context-page.v1',
            session_id: 'session-1',
            invocation_id: invocationId,
            sequence: 1,
            snapshot_id: `snapshot-${invocationId}`,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            offset: 0,
            total_bytes: bytes.length,
            payload_base64: bytes.toString('base64'),
          }),
          { status: 200, headers },
        );
      },
    });
    const first = Array.from({ length: 4 }, (_, index) =>
      client.getModelContext('session-1', `invocation-${index}`),
    );
    const cancelled = new AbortController();
    const fifth = client.getModelContext('session-1', 'invocation-4', cancelled.signal);
    await fourStarted;
    expect(started).toBe(4);
    cancelled.abort('cancelled');
    await expect(fifth).rejects.toBe('cancelled');
    release();
    expect((await Promise.all(first)).map((item) => item.invocation_id)).toEqual([
      'invocation-0',
      'invocation-1',
      'invocation-2',
      'invocation-3',
    ]);
    expect(started).toBe(4);
  });

  test('reads a closed background execution snapshot through the canonical client', async () => {
    let url = '';
    const client = createAgentApiBrowserClient({
      fetch: async (input) => {
        url = String(input);
        return new Response(
          JSON.stringify({
            schema: 'kite.agent-api.background-execution-page.v1',
            session_id: 'session-1',
            session_revision: 7,
            aggregate_generation: 'aggregate-1',
            watermark: 2,
            stale: false,
            items: [
              {
                schema: 'kite.agent-api.background-execution.v1',
                execution_id: 'shell-1',
                owner_generation: 'owner-1',
                revision: 3,
                kind: 'shell',
                status: 'running',
                cleanup_confirmed: false,
                cursor: 3,
              },
            ],
          }),
          { status: 200, headers },
        );
      },
    });
    const page = await client.listBackgroundExecutions('session-1');
    expect(url).toBe('/v1/sessions/session-1/background-executions');
    expect(page.items[0]?.execution_id).toBe('shell-1');
    await client.listBackgroundExecutions('session-1', { cursor: 'next-page', limit: 50 });
    expect(url).toBe('/v1/sessions/session-1/background-executions?cursor=next-page&limit=50');
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
