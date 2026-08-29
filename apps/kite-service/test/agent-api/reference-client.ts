import {
  AGENT_API_ARTIFACT_DIGEST,
  type AgentApiCheckpointPage,
  type AgentApiCheckpointPreview,
  type AgentApiContext,
  type AgentApiHistoryPage,
  type AgentApiProblem,
  type AgentApiServerInfo,
  type AgentApiSession,
  type AgentApiSessionPage,
  agentApiCheckpointPageSchema,
  agentApiCheckpointPreviewSchema,
  agentApiContextSchema,
  agentApiHistoryPageSchema,
  agentApiProblemSchema,
  agentApiServerInfoSchema,
  agentApiSessionPageSchema,
  agentApiSessionSchema,
  decodeAgentApiResponse,
} from '@kite-ai/agent-api-contract';
import type { z } from 'zod';
import { AGENT_API_CONNECTION_AUTHORIZATION_SCHEME } from '../../src/agent-api';

export type AgentApiReferenceTransport = (request: Request) => Promise<Response> | Response;

/** Test-only client: every successful response is decoded through the Public V1 contract. */
export class AgentApiReferenceClient {
  readonly #send: AgentApiReferenceTransport;
  #accessToken: string | undefined;

  constructor(send: AgentApiReferenceTransport, accessToken?: string) {
    this.#send = send;
    this.#accessToken = accessToken;
  }

  get accessToken(): string | undefined {
    return this.#accessToken;
  }

  async exchange(
    capability: string,
    requiredCapabilities: readonly string[] = [],
  ): Promise<AgentApiContext> {
    const response = await this.raw('/v1/auth/exchange', {
      method: 'POST',
      headers: {
        authorization: `${AGENT_API_CONNECTION_AUTHORIZATION_SCHEME} ${capability}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schema: 'kite.agent-api.exchange.v1',
        api_version: 'v1',
        required_capabilities: requiredCapabilities,
      }),
      includeContext: false,
    });
    const context = await decodeSuccess(response, 201, agentApiContextSchema);
    this.#accessToken = context.access_token;
    return context;
  }

  async serverInfo(): Promise<AgentApiServerInfo> {
    return decodeSuccess(await this.raw('/v1'), 200, agentApiServerInfoSchema);
  }

  async listSessions(query = ''): Promise<AgentApiSessionPage> {
    return decodeSuccess(await this.raw(`/v1/sessions${query}`), 200, agentApiSessionPageSchema);
  }

  async getSession(sessionId: string): Promise<AgentApiSession> {
    return decodeSuccess(await this.raw(`/v1/sessions/${sessionId}`), 200, agentApiSessionSchema);
  }

  async history(sessionId: string, query = ''): Promise<AgentApiHistoryPage> {
    return decodeSuccess(
      await this.raw(`/v1/sessions/${sessionId}/history${query}`),
      200,
      agentApiHistoryPageSchema,
    );
  }

  async checkpoints(sessionId: string, query = ''): Promise<AgentApiCheckpointPage> {
    return decodeSuccess(
      await this.raw(`/v1/sessions/${sessionId}/checkpoints${query}`),
      200,
      agentApiCheckpointPageSchema,
    );
  }

  async checkpointPreview(
    sessionId: string,
    checkpointId: string,
  ): Promise<AgentApiCheckpointPreview> {
    return decodeSuccess(
      await this.raw(`/v1/sessions/${sessionId}/checkpoints/${checkpointId}/preview`),
      200,
      agentApiCheckpointPreviewSchema,
    );
  }

  async problem(
    path: string,
    init: ReferenceRequestInit,
    status: number,
  ): Promise<AgentApiProblem> {
    return decodeProblem(await this.raw(path, init), status);
  }

  async raw(path: string, init: ReferenceRequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.includeContext !== false && this.#accessToken && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${this.#accessToken}`);
    }
    return this.#send(
      new Request(`http://127.0.0.1:43123${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    );
  }
}

export interface ReferenceRequestInit {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit;
  readonly includeContext?: boolean;
}

async function decodeSuccess<Schema extends z.ZodType>(
  response: Response,
  status: number,
  schema: Schema,
): Promise<z.output<Schema>> {
  assertCommonHeaders(response);
  if (response.status !== status) {
    throw new Error(`Agent API reference request returned ${response.status}, expected ${status}.`);
  }
  if (response.headers.get('content-type') !== 'application/json; charset=utf-8') {
    throw new Error('Agent API reference response media type drifted.');
  }
  return decodeAgentApiResponse(schema, await response.json());
}

async function decodeProblem(response: Response, status: number): Promise<AgentApiProblem> {
  assertCommonHeaders(response);
  if (response.status !== status) {
    throw new Error(`Agent API reference problem returned ${response.status}, expected ${status}.`);
  }
  if (response.headers.get('content-type') !== 'application/problem+json; charset=utf-8') {
    throw new Error('Agent API Problem media type drifted.');
  }
  return decodeAgentApiResponse(agentApiProblemSchema, await response.json());
}

function assertCommonHeaders(response: Response): void {
  if (response.headers.get('cache-control') !== 'no-store') {
    throw new Error('Agent API response is cacheable.');
  }
  if (response.headers.get('kite-agent-api-version') !== 'v1') {
    throw new Error('Agent API response version header drifted.');
  }
  if (response.headers.get('kite-agent-api-schema-digest') !== AGENT_API_ARTIFACT_DIGEST) {
    throw new Error('Agent API response artifact digest drifted.');
  }
  if (!/^req_[A-Za-z0-9_-]{22}$/u.test(response.headers.get('x-request-id') ?? '')) {
    throw new Error('Agent API response request identity is invalid.');
  }
  if (response.headers.get('x-content-type-options') !== 'nosniff') {
    throw new Error('Agent API response is missing nosniff.');
  }
}
