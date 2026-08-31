import {
  AGENT_API_ARTIFACT_DIGEST,
  AGENT_API_VERSION,
  type AgentApiCheckpointPage,
  type AgentApiCheckpointPreview,
  type AgentApiHistoryPage,
  type AgentApiProblem,
  type AgentApiServerInfo,
  type AgentApiSession,
  type AgentApiSessionPage,
  type AgentApiWorkspacePage,
  agentApiCheckpointPageSchema,
  agentApiCheckpointPreviewSchema,
  agentApiHistoryPageSchema,
  agentApiProblemSchema,
  agentApiServerInfoSchema,
  agentApiSessionPageSchema,
  agentApiSessionSchema,
  agentApiWorkspacePageSchema,
  decodeAgentApiResponse,
} from '@kite-ai/agent-api-contract';

export interface AgentApiBrowserClientOptions {
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly baseUrl?: string;
}

export interface AgentApiPageOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface AgentApiSessionPageOptions extends AgentApiPageOptions {
  readonly lifecycle?: 'open' | 'closed' | 'unavailable';
  readonly status?: 'idle' | 'queued' | 'running' | 'waiting' | 'error' | 'unavailable';
}

export interface AgentApiHistoryPageOptions extends AgentApiPageOptions {
  readonly afterSequence?: number;
}

export interface AgentApiBrowserClient {
  revokeBrowser(signal?: AbortSignal): Promise<void>;
  getServerInfo(signal?: AbortSignal): Promise<AgentApiServerInfo>;
  listWorkspaces(options?: AgentApiPageOptions): Promise<AgentApiWorkspacePage>;
  listWorkspaceSessions(
    workspaceId: string,
    options?: AgentApiSessionPageOptions,
  ): Promise<AgentApiSessionPage>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<AgentApiSession>;
  listHistory(
    sessionId: string,
    options?: AgentApiHistoryPageOptions,
  ): Promise<AgentApiHistoryPage>;
  listCheckpoints(
    sessionId: string,
    options?: AgentApiPageOptions,
  ): Promise<AgentApiCheckpointPage>;
  previewCheckpoint(
    sessionId: string,
    checkpointId: string,
    signal?: AbortSignal,
  ): Promise<AgentApiCheckpointPreview>;
}

export class AgentApiClientError extends Error {
  readonly status: number;
  readonly problem: AgentApiProblem | undefined;

  constructor(status: number, problem?: AgentApiProblem) {
    super(problem?.title ?? `Kite Agent API request failed with HTTP ${status}.`);
    this.name = 'AgentApiClientError';
    this.status = status;
    this.problem = problem;
  }
}

export function createAgentApiBrowserClient(
  options: AgentApiBrowserClientOptions = {},
): AgentApiBrowserClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  const client: AgentApiBrowserClient = {
    async revokeBrowser(signal) {
      await request('/v1/auth/browser/session', { method: 'DELETE', signal });
    },
    getServerInfo: (signal) =>
      requestJson('/v1', agentApiServerInfoSchema, { method: 'GET', signal }),
    listWorkspaces: (page = {}) =>
      requestJson(`/v1/workspaces${pageQuery(page)}`, agentApiWorkspacePageSchema, {
        method: 'GET',
        signal: page.signal,
      }),
    listWorkspaceSessions: (workspaceId, page = {}) =>
      requestJson(
        `/v1/workspaces/${identifier(workspaceId)}/sessions${sessionPageQuery(page)}`,
        agentApiSessionPageSchema,
        { method: 'GET', signal: page.signal },
      ),
    getSession: (sessionId, signal) =>
      requestJson(`/v1/sessions/${identifier(sessionId)}`, agentApiSessionSchema, {
        method: 'GET',
        signal,
      }),
    listHistory: (sessionId, page = {}) =>
      requestJson(
        `/v1/sessions/${identifier(sessionId)}/history${historyPageQuery(page)}`,
        agentApiHistoryPageSchema,
        { method: 'GET', signal: page.signal },
      ),
    listCheckpoints: (sessionId, page = {}) =>
      requestJson(
        `/v1/sessions/${identifier(sessionId)}/checkpoints${pageQuery(page)}`,
        agentApiCheckpointPageSchema,
        { method: 'GET', signal: page.signal },
      ),
    previewCheckpoint: (sessionId, checkpointId, signal) =>
      requestJson(
        `/v1/sessions/${identifier(sessionId)}/checkpoints/${identifier(checkpointId)}/preview`,
        agentApiCheckpointPreviewSchema,
        { method: 'GET', signal },
      ),
  };
  return Object.freeze(client);

  async function requestJson<Output>(
    path: string,
    schema: { parse(input: unknown): Output },
    input: RequestInput,
  ): Promise<Output> {
    const response = await request(path, input);
    if (response.headers.get('content-type') !== 'application/json; charset=utf-8') {
      throw new AgentApiClientError(response.status);
    }
    return decodeAgentApiResponse(
      schema as Parameters<typeof decodeAgentApiResponse>[0],
      await response.json(),
    ) as Output;
  }

  async function request(path: string, input: RequestInput): Promise<Response> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: input.method,
      headers: {
        accept: 'application/json',
        ...(input.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      cache: 'no-store',
      credentials: 'include',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    assertContractHeaders(response);
    if (response.status >= 200 && response.status < 300) return response;
    let problem: AgentApiProblem | undefined;
    if (response.headers.get('content-type') === 'application/problem+json; charset=utf-8') {
      try {
        problem = decodeAgentApiResponse(agentApiProblemSchema, await response.json());
      } catch {
        problem = undefined;
      }
    }
    throw new AgentApiClientError(response.status, problem);
  }
}

interface RequestInput {
  readonly method: 'DELETE' | 'GET' | 'POST';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

function normalizeBaseUrl(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '';
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('Agent API base URL must be an origin.');
  }
  return url.origin;
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError('Agent API resource identity is invalid.');
  }
  return encodeURIComponent(value);
}

function pageQuery(input: AgentApiPageOptions): string {
  const query = new URLSearchParams();
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  const value = query.toString();
  return value ? `?${value}` : '';
}

function sessionPageQuery(input: AgentApiSessionPageOptions): string {
  const query = new URLSearchParams(pageQuery(input).slice(1));
  if (input.lifecycle) query.set('lifecycle', input.lifecycle);
  if (input.status) query.set('status', input.status);
  const value = query.toString();
  return value ? `?${value}` : '';
}

function historyPageQuery(input: AgentApiHistoryPageOptions): string {
  const query = new URLSearchParams(pageQuery(input).slice(1));
  if (input.afterSequence !== undefined) {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new TypeError('Agent API History sequence must be a non-negative safe integer.');
    }
    query.set('after_sequence', String(input.afterSequence));
  }
  const value = query.toString();
  return value ? `?${value}` : '';
}

function assertContractHeaders(response: Response): void {
  if (
    response.headers.get('kite-agent-api-version') !== AGENT_API_VERSION ||
    response.headers.get('kite-agent-api-schema-digest') !== AGENT_API_ARTIFACT_DIGEST ||
    response.headers.get('cache-control') !== 'no-store'
  ) {
    throw new AgentApiClientError(response.status);
  }
}
