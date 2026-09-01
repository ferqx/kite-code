import type { AgentApiBrowserClient } from '@kite-ai/agent-api-client';
import { describe, expect, it, vi } from 'vitest';
import { createWebRestTransport } from '@/transport/client';

function client(): AgentApiBrowserClient {
  return {
    revokeBrowser: vi.fn(async () => undefined),
    getServerInfo: vi.fn(async () => ({
      schema: 'kite.agent-api.server-info.v1',
      api_version: 'v1',
      server_version: 'service-test',
      build_id: 'build-test',
      capabilities: ['history', 'sessions', 'workspaces'],
    })),
    listWorkspaces: vi.fn(async () => ({
      schema: 'kite.agent-api.workspace-page.v1',
      items: [
        {
          schema: 'kite.agent-api.workspace.v1',
          workspace_id: 'workspace-empty',
          display_name: 'Empty Workspace',
          session_count: 0,
        },
        {
          schema: 'kite.agent-api.workspace.v1',
          workspace_id: 'workspace-one',
          display_name: 'Workspace one',
          session_count: 1,
        },
      ],
    })),
    listWorkspaceSessions: vi.fn(async (workspaceId: string) => ({
      schema: 'kite.agent-api.session-page.v1',
      workspace_id: workspaceId,
      items:
        workspaceId === 'workspace-one'
          ? [
              {
                schema: 'kite.agent-api.session.v1',
                session_id: 'session-one',
                revision: 2,
                display_name: 'Session one',
                lifecycle: 'open',
                status: 'running',
                last_sequence: 2,
                updated_at: '2026-08-31T00:00:00.000Z',
              },
            ]
          : [],
    })),
    getSession: vi.fn(async () => {
      throw new Error('unused');
    }),
    listHistory: vi.fn(async () => ({
      schema: 'kite.agent-api.history-page.v1',
      session_id: 'session-one',
      through_sequence: 2,
      items: [
        {
          schema: 'kite.agent-api.history-item.v1',
          session_id: 'session-one',
          sequence: 1,
          public_ordinal: 0,
          occurred_at: '2026-08-31T00:00:00.000Z',
          content: { type: 'user.message', message_id: 'message-one', text: 'hello' },
        },
      ],
    })),
    listLogs: vi.fn(async () => ({
      schema: 'kite.agent-api.log-page.v1',
      session_id: 'session-one',
      through_sequence: 2,
      items: [
        {
          schema: 'kite.agent-api.log-item.v1',
          session_id: 'session-one',
          sequence: 1,
          occurred_at: '2026-08-31T00:00:00.000Z',
          event_type: 'user.message_appended',
          category: 'turn',
          status: 'unknown',
          summary: 'hello',
          detail: {
            kind: 'message',
            fields: [
              { name: 'content', value: 'hello' },
              { name: 'message_id', value: 'message-one' },
            ],
          },
        },
      ],
    })),
    getModelContext: vi.fn(async () => ({
      schema: 'kite.agent-api.model-context.v1',
      session_id: 'session-one',
      invocation_id: 'invocation-one',
      sequence: 2,
      purpose: 'primary_agent',
      model: { provider: 'openai-compatible', name: 'model-one' },
      system_prompt: { text: 'You are Kite.', truncated: false },
      messages: [
        {
          index: 0,
          role: 'user',
          parts: [{ type: 'text', text: 'hello', truncated: false }],
        },
      ],
      messages_truncated: false,
      tools: [],
      tools_truncated: false,
      request_settings: {
        transport: 'stream',
        temperature: 0,
        max_output_tokens: 4096,
        stop_policy: { kind: 'single_step', max_steps: 1 },
        message_count: 1,
        tool_count: 0,
      },
    })),
    listCheckpoints: vi.fn(async () => ({
      schema: 'kite.agent-api.checkpoint-page.v1',
      session_id: 'session-one',
      items: [],
    })),
    previewCheckpoint: vi.fn(async () => {
      throw new Error('unused');
    }),
  } as AgentApiBrowserClient;
}

it('revokes a shell-created Browser session before REST connect', async () => {
  const api = client();
  const transport = createWebRestTransport({ client: api });

  await transport.disconnect();

  expect(api.revokeBrowser).toHaveBeenCalledOnce();
});

describe('Web REST transport', () => {
  it('coalesces each tool lifecycle into one terminal or current message', async () => {
    const api: AgentApiBrowserClient = {
      ...client(),
      listHistory: vi.fn(async () => ({
        schema: 'kite.agent-api.history-page.v1' as const,
        session_id: 'session-one',
        through_sequence: 6,
        items: [
          toolLifecycleItem(2, 'tool-read', 'read_file', 'queued'),
          toolLifecycleItem(3, 'tool-read', 'Tool', 'running'),
          toolLifecycleItem(4, 'tool-read', 'read_file', 'completed'),
          toolLifecycleItem(5, 'tool-search', 'search_files', 'queued'),
          toolLifecycleItem(6, 'tool-search', 'Tool', 'running'),
        ],
      })),
    };
    const transport = createWebRestTransport({ client: api });
    await transport.connect();

    const history = await transport.loadHistory('session-one');

    expect(history.messages).toHaveLength(2);
    expect(history.messages[0]).toMatchObject({
      messageId: 'tool:tool-read',
      sequence: 4,
      blocks: [{ kind: 'tool_result', label: 'read_file', ok: true }],
    });
    expect(history.messages[1]).toMatchObject({
      messageId: 'tool:tool-search',
      sequence: 6,
      blocks: [{ kind: 'tool_activity', label: 'search_files', status: 'running' }],
    });
  });

  it('presents a pre-dispatch rejection separately from execution failure', async () => {
    const api: AgentApiBrowserClient = {
      ...client(),
      listHistory: vi.fn(async () => ({
        schema: 'kite.agent-api.history-page.v1' as const,
        session_id: 'session-one',
        through_sequence: 3,
        items: [
          toolLifecycleItem(2, 'tool-shell', 'shell_execute', 'queued'),
          {
            ...toolLifecycleItem(3, 'tool-shell', 'Tool', 'rejected'),
            content: {
              type: 'tool.lifecycle' as const,
              tool_call_id: 'tool-shell',
              label: 'Tool',
              status: 'rejected' as const,
              reason_code: 'policy_denied',
              summary: 'Tool execution was rejected by policy before dispatch.',
            },
          },
        ],
      })),
    };
    const transport = createWebRestTransport({ client: api });
    await transport.connect();

    const history = await transport.loadHistory('session-one');

    expect(history.messages).toEqual([
      expect.objectContaining({
        messageId: 'tool:tool-shell',
        sequence: 3,
        blocks: [
          expect.objectContaining({
            kind: 'tool_rejected',
            label: 'shell_execute',
            summary: 'Tool execution was rejected by policy before dispatch.',
          }),
        ],
      }),
    ]);
  });

  it('uses the root-created cookie and loads Workspace, Session and History snapshots', async () => {
    const api = client();
    const transport = createWebRestTransport({ client: api });
    await expect(transport.connect()).resolves.toEqual({ generation: 1 });
    expect(api.getServerInfo).toHaveBeenCalledOnce();

    const directory = await transport.listDirectory();
    expect(directory.workspaces).toHaveLength(2);
    expect(directory.workspaces[0]).toMatchObject({
      workspaceId: 'workspace-empty',
      sessionState: 'loaded',
      sessions: [],
    });
    expect(directory.workspaces[1]).toMatchObject({
      workspaceId: 'workspace-one',
      sessionState: 'idle',
      sessions: [],
    });
    const sessions = await transport.listWorkspaceSessions('workspace-one');
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-one',
      status: 'running',
      lastSequence: 2,
    });

    await expect(transport.loadCheckpoints('session-one')).resolves.toEqual({
      sessionId: 'session-one',
      checkpoints: [],
    });

    const history = await transport.loadHistory('session-one');
    expect(history).toMatchObject({
      sessionId: 'session-one',
      observedLastSequence: 2,
      messages: [{ messageId: 'message-one', role: 'user' }],
    });
    await transport.loadHistory('session-one', 2);
    expect(api.listHistory).toHaveBeenLastCalledWith('session-one', {
      afterSequence: 2,
      cursor: undefined,
      limit: 200,
    });
    await expect(transport.loadLogs('session-one')).resolves.toMatchObject({
      sessionId: 'session-one',
      observedLastSequence: 2,
      entries: [
        {
          sequence: 1,
          eventType: 'user.message_appended',
          detail: {
            fields: [
              { name: 'content', value: 'hello' },
              { name: 'message_id', value: 'message-one' },
            ],
          },
        },
      ],
    });
    await expect(
      transport.loadModelContext('session-one', 'invocation-one'),
    ).resolves.toMatchObject({
      sessionId: 'session-one',
      invocationId: 'invocation-one',
      systemPrompt: { text: 'You are Kite.', truncated: false },
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    });
    await transport.disconnect();
    expect(api.revokeBrowser).toHaveBeenCalledOnce();
  });
});

function toolLifecycleItem(
  sequence: number,
  toolCallId: string,
  label: string,
  status: 'queued' | 'running' | 'completed' | 'rejected',
) {
  return {
    schema: 'kite.agent-api.history-item.v1' as const,
    session_id: 'session-one',
    sequence,
    public_ordinal: 0,
    occurred_at: '2026-08-31T00:00:00.000Z',
    content: {
      type: 'tool.lifecycle' as const,
      tool_call_id: toolCallId,
      label,
      status,
    },
  };
}
