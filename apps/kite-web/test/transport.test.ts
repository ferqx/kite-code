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

describe('Web REST transport', () => {
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
    await transport.disconnect();
    expect(api.revokeBrowser).toHaveBeenCalledOnce();
  });
});
