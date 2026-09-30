import {
  AGENT_API_ARTIFACT_DIGEST,
  AGENT_API_VERSION,
  type AgentApiBackgroundExecutionPage,
  type AgentApiCheckpointPage,
  type AgentApiCheckpointPreview,
  type AgentApiHistoryPage,
  type AgentApiLogPage,
  type AgentApiModelContext,
  type AgentApiProblem,
  type AgentApiServerInfo,
  type AgentApiSession,
  type AgentApiSessionPage,
  type AgentApiWorkspacePage,
  agentApiBackgroundExecutionPageSchema,
  agentApiCheckpointPageSchema,
  agentApiCheckpointPreviewSchema,
  agentApiCompleteModelContextSchema,
  agentApiHistoryPageSchema,
  agentApiLogPageSchema,
  agentApiModelContextPageSchema,
  agentApiProblemSchema,
  agentApiServerInfoSchema,
  agentApiSessionPageSchema,
  agentApiSessionSchema,
  agentApiWorkspacePageSchema,
  assertSameAgentApiJsonShape,
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
  refreshBrowserSession(signal?: AbortSignal): Promise<void>;
  revokeBrowser(signal?: AbortSignal): Promise<void>;
  getServerInfo(signal?: AbortSignal): Promise<AgentApiServerInfo>;
  listWorkspaces(options?: AgentApiPageOptions): Promise<AgentApiWorkspacePage>;
  listWorkspaceSessions(
    workspaceId: string,
    options?: AgentApiSessionPageOptions,
  ): Promise<AgentApiSessionPage>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<AgentApiSession>;
  listBackgroundExecutions(
    sessionId: string,
    options?: AgentApiPageOptions,
  ): Promise<AgentApiBackgroundExecutionPage>;
  listHistory(
    sessionId: string,
    options?: AgentApiHistoryPageOptions,
  ): Promise<AgentApiHistoryPage>;
  listLogs(sessionId: string, options?: AgentApiHistoryPageOptions): Promise<AgentApiLogPage>;
  getModelContext(
    sessionId: string,
    invocationId: string,
    signal?: AbortSignal,
  ): Promise<AgentApiModelContext>;
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

class ModelContextReadQueue {
  #running = 0;
  readonly #pending: {
    start: () => void;
    signal?: AbortSignal;
    reject: (error: unknown) => void;
    onAbort: () => void;
  }[] = [];

  run<Result>(signal: AbortSignal | undefined, read: () => Promise<Result>): Promise<Result> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<Result>((resolve, reject) => {
      const job = {
        signal,
        reject,
        onAbort: () => {
          const index = this.#pending.indexOf(job);
          if (index < 0) return;
          this.#pending.splice(index, 1);
          reject(signal?.reason);
        },
        start: () => {
          signal?.removeEventListener('abort', job.onAbort);
          this.#running += 1;
          void read()
            .then(resolve, reject)
            .finally(() => {
              this.#running -= 1;
              this.#drain();
            });
        },
      };
      this.#pending.push(job);
      signal?.addEventListener('abort', job.onAbort, { once: true });
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#running < 4) {
      const next = this.#pending.shift();
      if (!next) return;
      if (next.signal?.aborted) {
        next.signal.removeEventListener('abort', next.onAbort);
        next.reject(next.signal.reason);
        continue;
      }
      next.start();
    }
  }
}

export function createAgentApiBrowserClient(
  options: AgentApiBrowserClientOptions = {},
): AgentApiBrowserClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const modelContextQueue = new ModelContextReadQueue();

  const client: AgentApiBrowserClient = {
    async refreshBrowserSession(signal) {
      await request('/v1/auth/browser/session', { method: 'POST', signal });
    },
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
    listBackgroundExecutions: (sessionId, page = {}) =>
      requestJson(
        `/v1/sessions/${identifier(sessionId)}/background-executions${pageQuery(page)}`,
        agentApiBackgroundExecutionPageSchema,
        { method: 'GET', signal: page.signal },
      ),
    listHistory: (sessionId, page = {}) =>
      requestJson(
        `/v1/sessions/${identifier(sessionId)}/history${historyPageQuery(page)}`,
        agentApiHistoryPageSchema,
        { method: 'GET', signal: page.signal },
      ),
    listLogs: (sessionId, page = {}) =>
      requestJson(
        `/v1/sessions/${identifier(sessionId)}/logs${historyPageQuery(page)}`,
        agentApiLogPageSchema,
        { method: 'GET', signal: page.signal },
      ),
    getModelContext: (sessionId, invocationId, signal) =>
      modelContextQueue.run(signal, async () => {
        const path = `/v1/sessions/${identifier(sessionId)}/model-invocations/${identifier(invocationId)}/context`;
        const chunks: Uint8Array[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let snapshotId: string | undefined;
        let sha256: string | undefined;
        let sequence: number | undefined;
        let totalBytes: number | undefined;
        let offset = 0;
        for (;;) {
          if (signal?.aborted) throw signal.reason;
          const page = await requestJson(
            `${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
            agentApiModelContextPageSchema,
            { method: 'GET', signal },
          );
          if (
            page.session_id !== sessionId ||
            page.invocation_id !== invocationId ||
            page.offset !== offset ||
            (snapshotId !== undefined &&
              (page.snapshot_id !== snapshotId ||
                page.sha256 !== sha256 ||
                page.sequence !== sequence ||
                page.total_bytes !== totalBytes))
          ) {
            throw new AgentApiClientError(409);
          }
          snapshotId = page.snapshot_id;
          sha256 = page.sha256;
          sequence = page.sequence;
          totalBytes = page.total_bytes;
          const bytes = Uint8Array.from(atob(page.payload_base64), (character) =>
            character.charCodeAt(0),
          );
          if (bytes.length === 0 || offset + bytes.length > page.total_bytes) {
            throw new AgentApiClientError(409);
          }
          chunks.push(bytes);
          offset += bytes.length;
          if (!page.next_cursor) break;
          if (cursors.has(page.next_cursor)) throw new AgentApiClientError(409);
          cursors.add(page.next_cursor);
          cursor = page.next_cursor;
        }
        if (offset !== totalBytes || sha256 === undefined) throw new AgentApiClientError(409);
        const complete = new Uint8Array(offset);
        let copied = 0;
        for (const chunk of chunks) {
          complete.set(chunk, copied);
          copied += chunk.length;
        }
        const digest = await globalThis.crypto.subtle.digest('SHA-256', complete);
        if (signal?.aborted) throw signal.reason;
        const actual = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        if (actual !== sha256) throw new AgentApiClientError(409);
        try {
          const body: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(complete),
          );
          const parsed = agentApiCompleteModelContextSchema.parse(body);
          assertSameAgentApiJsonShape(body, parsed, 'model context');
          return parsed;
        } catch {
          throw new AgentApiClientError(409);
        }
      }),
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
      headers: { accept: 'application/json' },
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
