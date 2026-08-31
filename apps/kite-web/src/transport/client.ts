import {
  type AgentApiBrowserClient,
  AgentApiClientError,
  createAgentApiBrowserClient,
} from '@kite-ai/agent-api-client';
import type { AgentApiHistoryItem, AgentApiSession } from '@kite-ai/agent-api-contract';
import type {
  WebCheckpointSnapshot,
  WebDirectorySnapshot,
  WebHistorySnapshot,
  WebPresentationMessage,
  WebSessionStatus,
} from '../presentation/types';

const MAX_PAGES = 32;

export type WebRestTransportFailure =
  | 'service_unavailable'
  | 'history_unavailable'
  | 'session_unavailable'
  | 'protocol_error';

export class WebRestTransportError extends Error {
  readonly reason: WebRestTransportFailure;
  readonly status: number | undefined;

  constructor(reason: WebRestTransportFailure, status?: number) {
    super('Kite Web REST transport is unavailable.');
    this.name = 'WebRestTransportError';
    this.reason = reason;
    this.status = status;
  }
}

export interface WebRestTransportOptions {
  readonly client?: AgentApiBrowserClient;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface WebRestConnection {
  readonly generation: number;
}

export interface WebRestTransport {
  connect(): Promise<WebRestConnection>;
  listDirectory(): Promise<WebDirectorySnapshot>;
  listWorkspaceSessions(workspaceId: string): Promise<readonly ReturnType<typeof projectSession>[]>;
  getSession(sessionId: string): Promise<ReturnType<typeof projectSession>>;
  loadHistory(sessionId: string, afterSequence?: number): Promise<WebHistorySnapshot>;
  loadCheckpoints(sessionId: string): Promise<WebCheckpointSnapshot>;
  disconnect(): Promise<void>;
}

export function createWebRestTransport(options: WebRestTransportOptions = {}): WebRestTransport {
  const client = options.client ?? createAgentApiBrowserClient({ fetch: options.fetch });
  let generation = 0;
  let connected = false;

  return Object.freeze({
    async connect() {
      if (connected) return { generation };
      try {
        const info = await client.getServerInfo();
        for (const required of ['workspaces', 'sessions', 'history'] as const) {
          if (!info.capabilities.includes(required)) {
            throw new WebRestTransportError('protocol_error');
          }
        }
      } catch (error) {
        throw normalizeError(error);
      }
      connected = true;
      generation += 1;
      return { generation };
    },
    async listDirectory() {
      requireConnected(connected);
      try {
        const workspaces: WebDirectorySnapshot['workspaces'][number][] = [];
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
          const page = await client.listWorkspaces({ cursor, limit: 100 });
          for (const workspace of page.items) {
            workspaces.push({
              workspaceId: workspace.workspace_id,
              label: workspace.display_name,
              sessionCount: workspace.session_count,
              sessionState: 'idle' as const,
              sessions: [],
            });
          }
          if (!page.next_cursor) {
            const first = workspaces[0];
            if (!first) return { workspaces };
            const sessions = await listAllSessions(client, first.workspaceId);
            return {
              workspaces: [
                { ...first, sessionState: 'loaded' as const, sessions },
                ...workspaces.slice(1),
              ],
            };
          }
          cursor = page.next_cursor;
        }
        throw new WebRestTransportError('protocol_error');
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async listWorkspaceSessions(workspaceId: string) {
      requireConnected(connected);
      try {
        return await listAllSessions(client, workspaceId);
      } catch (error) {
        throw normalizeError(error, 'session_unavailable');
      }
    },
    async getSession(sessionId: string) {
      requireConnected(connected);
      try {
        return projectSession(await client.getSession(sessionId));
      } catch (error) {
        throw normalizeError(error, 'session_unavailable');
      }
    },
    async loadHistory(sessionId: string, afterSequence?: number) {
      requireConnected(connected);
      try {
        const messages: WebPresentationMessage[] = [];
        let cursor: string | undefined;
        let observedLastSequence = 0;
        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
          const page = await client.listHistory(sessionId, {
            cursor,
            limit: 200,
            ...(cursor === undefined && afterSequence !== undefined ? { afterSequence } : {}),
          });
          if (page.session_id !== sessionId) throw new WebRestTransportError('protocol_error');
          observedLastSequence = page.through_sequence;
          messages.push(...page.items.map(projectHistoryItem));
          if (!page.next_cursor) {
            return {
              sessionId,
              messages: messages.sort(
                (left, right) =>
                  left.sequence - right.sequence || left.messageId.localeCompare(right.messageId),
              ),
              observedLastSequence,
            };
          }
          cursor = page.next_cursor;
        }
        throw new WebRestTransportError('protocol_error');
      } catch (error) {
        throw normalizeError(error, 'history_unavailable');
      }
    },
    async loadCheckpoints(sessionId: string) {
      requireConnected(connected);
      try {
        const checkpoints: WebCheckpointSnapshot['checkpoints'][number][] = [];
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
          const page = await client.listCheckpoints(sessionId, { cursor, limit: 100 });
          if (page.session_id !== sessionId) throw new WebRestTransportError('protocol_error');
          checkpoints.push(
            ...page.items.map((item) => ({
              checkpointId: item.checkpoint_id,
              revision: item.revision,
              scope: item.scope,
              ...(item.created_at ? { createdAt: Date.parse(item.created_at) } : {}),
              ...(item.label ? { label: item.label } : {}),
            })),
          );
          if (!page.next_cursor) return { sessionId, checkpoints };
          cursor = page.next_cursor;
        }
        throw new WebRestTransportError('protocol_error');
      } catch (error) {
        throw normalizeError(error, 'history_unavailable');
      }
    },
    async disconnect() {
      if (!connected) return;
      connected = false;
      await client.revokeBrowser().catch(() => undefined);
    },
  });
}

async function listAllSessions(client: AgentApiBrowserClient, workspaceId: string) {
  const sessions: ReturnType<typeof projectSession>[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await client.listWorkspaceSessions(workspaceId, { cursor, limit: 100 });
    if (page.workspace_id !== workspaceId) throw new WebRestTransportError('protocol_error');
    sessions.push(...page.items.map(projectSession));
    if (!page.next_cursor) {
      return sessions;
    }
    cursor = page.next_cursor;
  }
  throw new WebRestTransportError('protocol_error');
}

function projectSession(session: AgentApiSession) {
  const updatedAt = session.updated_at ? Date.parse(session.updated_at) : 0;
  return {
    sessionId: session.session_id,
    displayName: session.display_name ?? session.session_id,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    lastSequence: session.last_sequence ?? session.revision,
    status: sessionStatus(session),
  };
}

function sessionStatus(session: AgentApiSession): WebSessionStatus {
  if (session.lifecycle === 'closed') return session.status === 'error' ? 'failed' : 'completed';
  if (session.status === 'queued' || session.status === 'running') return 'running';
  if (session.status === 'waiting') return 'waiting';
  if (session.status === 'error') return 'failed';
  return session.status;
}

function projectHistoryItem(item: AgentApiHistoryItem): WebPresentationMessage {
  const id = `${item.sequence}:${item.public_ordinal}`;
  switch (item.content.type) {
    case 'user.message':
      return {
        messageId: item.content.message_id,
        sequence: item.sequence,
        role: 'user',
        blocks: [{ kind: 'text', text: item.content.text }],
      };
    case 'model.message':
      return {
        messageId: item.content.message_id,
        sequence: item.sequence,
        role: 'assistant',
        blocks: [{ kind: 'text', text: item.content.text }],
      };
    case 'model.reasoning':
      return {
        messageId: id,
        sequence: item.sequence,
        role: 'assistant',
        blocks: [{ kind: 'thinking', text: item.content.text, complete: true }],
      };
    case 'tool.lifecycle':
      return {
        messageId: id,
        sequence: item.sequence,
        role: 'assistant',
        blocks:
          item.content.status === 'queued' || item.content.status === 'running'
            ? [
                {
                  kind: 'tool_activity',
                  toolId: item.content.tool_call_id,
                  label: item.content.label,
                  status: item.content.status,
                  ...(item.content.summary ? { summary: item.content.summary } : {}),
                },
              ]
            : [
                {
                  kind: 'tool_result',
                  toolId: item.content.tool_call_id,
                  label: item.content.label,
                  ok: item.content.status === 'completed',
                  stdout: item.content.summary ?? '',
                  stderr: '',
                },
              ],
      };
    case 'run.status':
      return {
        messageId: id,
        sequence: item.sequence,
        role: 'system',
        blocks: [
          {
            kind: 'status',
            status: runStatus(item.content.status),
            ...(item.content.reason_code ? { text: item.content.reason_code } : {}),
          },
        ],
      };
  }
}

function runStatus(status: string): WebSessionStatus {
  if (status === 'running' || status === 'queued') return 'running';
  if (status === 'waiting') return 'waiting';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled' || status === 'unknown') return 'failed';
  return 'unavailable';
}

function requireConnected(connected: boolean): void {
  if (!connected) throw new WebRestTransportError('service_unavailable');
}

function normalizeError(
  error: unknown,
  fallback: WebRestTransportFailure = 'service_unavailable',
): WebRestTransportError {
  if (error instanceof WebRestTransportError) return error;
  if (error instanceof AgentApiClientError) {
    if (error.status === 404) return new WebRestTransportError('session_unavailable', error.status);
    if (error.status === 400 || error.status === 409) {
      return new WebRestTransportError('protocol_error', error.status);
    }
    return new WebRestTransportError(fallback, error.status);
  }
  return new WebRestTransportError(fallback);
}
