import { type ZodType, z } from 'zod';
import { AGENT_API_LIMITS } from './limits';
import {
  AGENT_API_VERSION,
  agentApiCancelRunRequestSchema,
  agentApiCheckpointPageSchema,
  agentApiCheckpointPreviewSchema,
  agentApiCheckpointSchema,
  agentApiCloseSessionRequestSchema,
  agentApiContextSchema,
  agentApiCreateRunRequestSchema,
  agentApiCreateSessionRequestSchema,
  agentApiDeletedSessionSchema,
  agentApiEventSchema,
  agentApiExchangeRequestSchema,
  agentApiForkSessionRequestSchema,
  agentApiHistoryItemSchema,
  agentApiHistoryPageSchema,
  agentApiInteractionQueueSchema,
  agentApiInteractionResponseRequestSchema,
  agentApiInteractionSchema,
  agentApiMutationHeadersSchema,
  agentApiMutationResultSchema,
  agentApiPageQuerySchema,
  agentApiProblemSchema,
  agentApiResumeSessionRequestSchema,
  agentApiResyncSchema,
  agentApiRewindSessionRequestSchema,
  agentApiRunListQuerySchema,
  agentApiRunPageSchema,
  agentApiRunSchema,
  agentApiServerInfoSchema,
  agentApiSessionListQuerySchema,
  agentApiSessionPageSchema,
  agentApiSessionSchema,
  agentApiStreamQuerySchema,
  agentApiWaitQuerySchema,
  agentApiWorkspacePageSchema,
  agentApiWorkspaceSchema,
} from './schemas';

type JsonPrimitive = null | boolean | number | string;
export type AgentApiArtifactJson =
  | JsonPrimitive
  | readonly AgentApiArtifactJson[]
  | { readonly [key: string]: AgentApiArtifactJson };
type JsonObject = { readonly [key: string]: AgentApiArtifactJson };

export interface AgentApiArtifactInput {
  readonly examples: Readonly<Record<string, AgentApiArtifactJson>>;
}

export interface AgentApiGeneratedArtifacts {
  readonly files: ReadonlyMap<string, string>;
  readonly schemas: Readonly<Record<string, JsonObject>>;
  readonly openapi: JsonObject;
}

const schemaRegistry = Object.freeze([
  ['AgentApiServerInfo', 'server-info', agentApiServerInfoSchema],
  ['AgentApiExchangeRequest', 'exchange-request', agentApiExchangeRequestSchema],
  ['AgentApiContext', 'context', agentApiContextSchema],
  ['AgentApiWorkspace', 'workspace', agentApiWorkspaceSchema],
  ['AgentApiWorkspacePage', 'workspace-page', agentApiWorkspacePageSchema],
  ['AgentApiSession', 'session', agentApiSessionSchema],
  ['AgentApiSessionPage', 'session-page', agentApiSessionPageSchema],
  ['AgentApiRun', 'run', agentApiRunSchema],
  ['AgentApiRunPage', 'run-page', agentApiRunPageSchema],
  ['AgentApiInteraction', 'interaction', agentApiInteractionSchema],
  ['AgentApiInteractionQueue', 'interaction-queue', agentApiInteractionQueueSchema],
  ['AgentApiCheckpoint', 'checkpoint', agentApiCheckpointSchema],
  ['AgentApiCheckpointPreview', 'checkpoint-preview', agentApiCheckpointPreviewSchema],
  ['AgentApiCheckpointPage', 'checkpoint-page', agentApiCheckpointPageSchema],
  ['AgentApiHistoryItem', 'history-item', agentApiHistoryItemSchema],
  ['AgentApiHistoryPage', 'history-page', agentApiHistoryPageSchema],
  ['AgentApiEvent', 'event', agentApiEventSchema],
  ['AgentApiResync', 'resync', agentApiResyncSchema],
  ['AgentApiProblem', 'problem', agentApiProblemSchema],
  ['AgentApiMutationResult', 'mutation-result', agentApiMutationResultSchema],
  ['AgentApiDeletedSession', 'deleted-session', agentApiDeletedSessionSchema],
  ['AgentApiMutationHeaders', 'mutation-headers', agentApiMutationHeadersSchema],
  ['AgentApiSessionListQuery', 'session-list-query', agentApiSessionListQuerySchema],
  ['AgentApiRunListQuery', 'run-list-query', agentApiRunListQuerySchema],
  ['AgentApiPageQuery', 'page-query', agentApiPageQuerySchema],
  ['AgentApiWaitQuery', 'wait-query', agentApiWaitQuerySchema],
  ['AgentApiStreamQuery', 'stream-query', agentApiStreamQuerySchema],
  ['AgentApiCreateSessionRequest', 'create-session-request', agentApiCreateSessionRequestSchema],
  ['AgentApiResumeSessionRequest', 'resume-session-request', agentApiResumeSessionRequestSchema],
  ['AgentApiCloseSessionRequest', 'close-session-request', agentApiCloseSessionRequestSchema],
  ['AgentApiCreateRunRequest', 'create-run-request', agentApiCreateRunRequestSchema],
  ['AgentApiCancelRunRequest', 'cancel-run-request', agentApiCancelRunRequestSchema],
  ['AgentApiRewindSessionRequest', 'rewind-session-request', agentApiRewindSessionRequestSchema],
  ['AgentApiForkSessionRequest', 'fork-session-request', agentApiForkSessionRequestSchema],
  [
    'AgentApiInteractionResponseRequest',
    'interaction-response-request',
    agentApiInteractionResponseRequestSchema,
  ],
] as const satisfies readonly (readonly [string, string, ZodType])[]);

export const AGENT_API_ARTIFACT_SCHEMA_NAMES = Object.freeze(schemaRegistry.map(([name]) => name));

export function generateAgentApiArtifacts(
  input: AgentApiArtifactInput,
): AgentApiGeneratedArtifacts {
  const schemas = Object.fromEntries(
    schemaRegistry.map(([name, fileName, schema]) => [
      name,
      withSchemaIdentity(toJsonSchema(schema), name, fileName),
    ]),
  ) as Readonly<Record<string, JsonObject>>;
  const openapi = createOpenApiDocument(schemas, input.examples);
  const files = new Map<string, string>();
  files.set('openapi.json', `${canonicalAgentApiJson(openapi)}\n`);
  for (const [name, fileName] of schemaRegistry) {
    const schema = schemas[name];
    if (!schema) throw new TypeError(`Missing generated schema ${name}`);
    files.set(`schema/${fileName}.json`, `${canonicalAgentApiJson(schema)}\n`);
  }
  files.set('wire.d.ts', generateAgentApiWireDeclarations(schemas));
  for (const [name, value] of Object.entries(input.examples).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    files.set(`examples/${name}.json`, `${canonicalAgentApiJson(value)}\n`);
  }
  return Object.freeze({ files, schemas, openapi });
}

export function canonicalAgentApiJson(value: AgentApiArtifactJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Artifact JSON contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalAgentApiJson(entry)).join(',')}]`;
  }
  if (typeof value !== 'object') throw new TypeError('Artifact contains a non-JSON value');
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalAgentApiJson(entry)}`)
    .join(',')}}`;
}

export function generateAgentApiWireDeclarations(
  schemas: Readonly<Record<string, JsonObject>>,
): string {
  const declarations = Object.entries(schemas)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, schema]) => `export type ${name} = ${jsonSchemaToTypeScript(schema, 0)};`);
  return `${[
    '// Generated from @kite-ai/agent-api-contract schemas. Do not edit.',
    `export type AgentApiVersion = ${JSON.stringify(AGENT_API_VERSION)};`,
    ...declarations,
  ].join('\n\n')}\n`;
}

function toJsonSchema(schema: ZodType): JsonObject {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    cycles: 'ref',
    reused: 'inline',
  }) as unknown as JsonObject;
}

function withSchemaIdentity(schema: JsonObject, name: string, fileName: string): JsonObject {
  return {
    ...schema,
    $id: `urn:kite:agent-api:schema:${fileName}`,
    title: name,
    'x-kite-contract-limits': AGENT_API_LIMITS,
    'x-kite-text-length-unit': 'utf8-bytes',
  };
}

function createOpenApiDocument(
  schemas: Readonly<Record<string, JsonObject>>,
  examples: Readonly<Record<string, AgentApiArtifactJson>>,
): JsonObject {
  const components = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, withoutJsonSchemaIdentity(schema)]),
  ) as JsonObject;
  return {
    openapi: '3.1.0',
    'x-kite-contract-limits': AGENT_API_LIMITS,
    'x-kite-text-length-unit': 'utf8-bytes',
    info: {
      title: 'Kite Agent API',
      version: AGENT_API_VERSION,
      description:
        'Stable local, loopback-only Agent API contract. The document contains no live endpoint or credential.',
    },
    servers: [
      {
        url: 'http://127.0.0.1:{port}',
        description: 'Placeholder only; Native bootstrap supplies the admitted loopback endpoint.',
        variables: {
          port: {
            default: '0',
            description: 'Placeholder; port 0 is not a usable Agent API endpoint.',
          },
        },
      },
    ],
    tags: [
      { name: 'Authentication' },
      { name: 'System' },
      { name: 'Workspaces' },
      { name: 'Sessions' },
      { name: 'Runs' },
      { name: 'Interactions' },
      { name: 'History' },
      { name: 'Checkpoints' },
      { name: 'Streaming' },
    ],
    paths: createPaths(examples),
    components: {
      schemas: components,
      securitySchemes: {
        AgentApiContext: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque Agent API context token',
          description: 'Obtained only from the one-shot local capability exchange.',
        },
        WorkerConnectionCapability: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: 'Exact form: Kite-Connection <one-shot-token>. Exchange route only.',
        },
        BrowserSession: {
          type: 'apiKey',
          in: 'cookie',
          name: 'kite_web_session',
          description: 'HttpOnly loopback Browser session created by one-shot launch exchange.',
        },
      },
      headers: commonHeaderComponents(),
      responses: problemResponseComponents(),
    },
    externalDocs: {
      description: 'Kite Agent API V1 contract documentation',
      url: 'https://example.invalid/kite-agent-api-v1',
    },
  };
}

function createPaths(examples: Readonly<Record<string, AgentApiArtifactJson>>): JsonObject {
  const bearer = [{ AgentApiContext: [] }];
  const browser = [{ BrowserSession: [] }];
  const authenticated = [...bearer, ...browser];
  const workspacePath = pathParameter('workspace_id', 'Opaque Workspace identity');
  const sessionPath = pathParameter('session_id', 'Session identity');
  const runPath = pathParameter('run_id', 'Run identity scoped by Session');
  const interactionPath = pathParameter('interaction_id', 'Interaction identity');
  const checkpointPath = pathParameter('checkpoint_id', 'Checkpoint identity');
  return {
    '/v1/auth/exchange': {
      post: operation({
        id: 'exchangeAgentApiContext',
        tag: 'Authentication',
        summary: 'Consume one Worker connection capability and create an Agent API context',
        security: [{ WorkerConnectionCapability: [] }],
        request: 'AgentApiExchangeRequest',
        success: {
          201: jsonResponse('AgentApiContext', 'Agent API context created'),
        },
        errors: [400, 401, 403, 413, 415, 426, 429, 503],
      }),
    },
    '/v1/auth/session': {
      delete: operation({
        id: 'revokeAgentApiContext',
        tag: 'Authentication',
        summary: 'Revoke the current Agent API context',
        security: bearer,
        success: { 204: emptyResponse('Context revoked') },
        errors: [401, 403, 429, 503],
      }),
    },
    '/v1/auth/browser/session': {
      delete: operation({
        id: 'revokeAgentApiBrowserSession',
        tag: 'Authentication',
        summary: 'Revoke the current Browser session',
        security: browser,
        success: { 204: emptyResponse('Browser session revoked') },
        errors: [401, 403, 429, 503],
      }),
    },
    '/v1': {
      get: operation({
        id: 'getAgentApiServerInfo',
        tag: 'System',
        summary: 'Read API version and admitted capabilities',
        security: authenticated,
        success: {
          200: jsonResponse('AgentApiServerInfo', 'Server information', examples['server-info']),
        },
        errors: [401, 403, 406, 429, 503],
      }),
    },
    '/v1/workspaces': {
      get: operation({
        id: 'listAgentApiWorkspaces',
        tag: 'Workspaces',
        summary: 'List path-free Workspaces visible to the current principal',
        security: authenticated,
        parameters: [limitParameter(), cursorParameter()],
        success: { 200: jsonResponse('AgentApiWorkspacePage', 'Workspace page') },
        errors: [400, 401, 403, 406, 429, 503],
      }),
    },
    '/v1/workspaces/{workspace_id}/sessions': {
      parameters: [workspacePath],
      get: operation({
        id: 'listAgentApiWorkspaceSessions',
        tag: 'Sessions',
        summary: 'List Sessions for one visible Workspace',
        security: authenticated,
        parameters: [
          queryParameter('lifecycle', 'open, closed or unavailable'),
          queryParameter('status', 'Closed Session status filter'),
          limitParameter(),
          cursorParameter(),
        ],
        success: { 200: jsonResponse('AgentApiSessionPage', 'Workspace Session page') },
        errors: [400, 401, 403, 404, 406, 429, 503],
      }),
    },
    '/v1/sessions': {
      get: operation({
        id: 'listAgentApiSessions',
        tag: 'Sessions',
        summary: 'List Sessions with a bounded live keyset cursor',
        security: bearer,
        parameters: [
          queryParameter('lifecycle', 'open, closed or unavailable'),
          queryParameter('status', 'Closed Session status filter'),
          limitParameter(),
          cursorParameter(),
        ],
        success: { 200: jsonResponse('AgentApiSessionPage', 'Session page') },
        errors: [400, 401, 403, 406, 429, 503],
      }),
      post: operation({
        id: 'createAgentApiSession',
        tag: 'Sessions',
        summary: 'Create a Session in the admitted Workspace',
        security: bearer,
        parameters: [idempotencyParameter()],
        request: 'AgentApiCreateSessionRequest',
        success: {
          201: mutationResponse('create_session', 'AgentApiSession', 'Session created', {
            location: true,
            etag: true,
          }),
        },
        errors: [400, 401, 403, 409, 413, 415, 426, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}': {
      parameters: [sessionPath],
      get: operation({
        id: 'getAgentApiSession',
        tag: 'Sessions',
        summary: 'Get the closed Session projection without triggering recovery',
        security: authenticated,
        success: { 200: jsonResponse('AgentApiSession', 'Session', undefined, { etag: true }) },
        errors: [400, 401, 403, 404, 406, 429, 503],
      }),
      delete: operation({
        id: 'deleteAgentApiSession',
        tag: 'Sessions',
        summary: 'Permanently delete a Session while retaining the applied receipt',
        security: bearer,
        parameters: [idempotencyParameter(), ifMatchParameter()],
        success: {
          200: mutationResponse('delete_session', 'AgentApiDeletedSession', 'Session deleted'),
        },
        errors: [400, 401, 403, 404, 409, 412, 428, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/resume': {
      parameters: [sessionPath],
      post: operation({
        id: 'resumeAgentApiSession',
        tag: 'Sessions',
        summary: 'Run the explicit recovery and presentation barrier',
        security: bearer,
        parameters: [idempotencyParameter()],
        request: 'AgentApiResumeSessionRequest',
        success: {
          200: mutationResponse('resume_session', 'AgentApiSession', 'Session resumed', {
            etag: true,
          }),
        },
        errors: [400, 401, 403, 404, 409, 413, 415, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/close': {
      parameters: [sessionPath],
      post: operation({
        id: 'closeAgentApiSession',
        tag: 'Sessions',
        summary: 'Close a Session',
        security: bearer,
        parameters: [idempotencyParameter(), ifMatchParameter()],
        request: 'AgentApiCloseSessionRequest',
        success: {
          200: mutationResponse('close_session', 'AgentApiSession', 'Session closed', {
            etag: true,
          }),
        },
        errors: [400, 401, 403, 404, 409, 412, 413, 415, 428, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/runs': {
      parameters: [sessionPath],
      get: operation({
        id: 'listAgentApiRuns',
        tag: 'Runs',
        summary: 'List Store 8 Runs for one Session',
        security: bearer,
        parameters: [
          queryParameter('status', 'Closed Run status filter'),
          queryParameter('phase', 'planning or building'),
          limitParameter(),
          cursorParameter(),
        ],
        success: { 200: jsonResponse('AgentApiRunPage', 'Run page') },
        errors: [400, 401, 403, 404, 406, 409, 429, 503],
      }),
      post: operation({
        id: 'createAgentApiRun',
        tag: 'Runs',
        summary: 'Create a durable background Run',
        security: bearer,
        parameters: [idempotencyParameter(), ifMatchParameter()],
        request: 'AgentApiCreateRunRequest',
        requestExample: examples['create-run-request'],
        success: {
          202: mutationResponse('create_run', 'AgentApiRun', 'Run applied', {
            location: true,
            etag: true,
          }),
        },
        errors: [400, 401, 403, 404, 409, 412, 413, 415, 428, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/runs/{run_id}': {
      parameters: [sessionPath, runPath],
      get: operation({
        id: 'getAgentApiRun',
        tag: 'Runs',
        summary: 'Get one Run',
        security: bearer,
        success: {
          200: jsonResponse('AgentApiRun', 'Run', examples.run, { etag: true }),
        },
        errors: [400, 401, 403, 404, 406, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/runs/{run_id}/cancel': {
      parameters: [sessionPath, runPath],
      post: operation({
        id: 'cancelAgentApiRun',
        tag: 'Runs',
        summary: 'Apply durable Run cancellation',
        security: bearer,
        parameters: [idempotencyParameter(), ifMatchParameter()],
        request: 'AgentApiCancelRunRequest',
        success: {
          202: mutationResponse('cancel_run', 'AgentApiRun', 'Cancellation applied', {
            etag: true,
          }),
        },
        errors: [400, 401, 403, 404, 409, 412, 413, 415, 428, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/runs/{run_id}/wait': {
      parameters: [sessionPath, runPath],
      get: operation({
        id: 'waitForAgentApiRun',
        tag: 'Runs',
        summary: 'Wait at most 30 seconds without cancelling the Run',
        security: bearer,
        parameters: [waitParameter()],
        success: {
          200: jsonResponse('AgentApiRun', 'Terminal Run', undefined, { etag: true }),
          202: jsonResponse('AgentApiRun', 'Nonterminal Run at timeout', undefined, {
            etag: true,
            retryAfter: true,
          }),
        },
        errors: [400, 401, 403, 404, 406, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/events': streamPath('streamAgentApiSessionEvents', [sessionPath]),
    '/v1/sessions/{session_id}/runs/{run_id}/events': streamPath('streamAgentApiRunEvents', [
      sessionPath,
      runPath,
    ]),
    '/v1/sessions/{session_id}/interactions': {
      parameters: [sessionPath],
      get: operation({
        id: 'listAgentApiInteractions',
        tag: 'Interactions',
        summary: 'Read the complete replacement Interaction queue',
        security: bearer,
        success: {
          200: jsonResponse('AgentApiInteractionQueue', 'Interaction queue', undefined, {
            etag: true,
          }),
        },
        errors: [400, 401, 403, 404, 406, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/interactions/{interaction_id}/responses': {
      parameters: [sessionPath, interactionPath],
      post: operation({
        id: 'respondToAgentApiInteraction',
        tag: 'Interactions',
        summary: 'Settle one exact Interaction identity',
        security: bearer,
        parameters: [idempotencyParameter(), ifMatchParameter()],
        request: 'AgentApiInteractionResponseRequest',
        success: {
          200: mutationResponse(
            'respond_interaction',
            'AgentApiInteractionQueue',
            'Interaction settled',
            { etag: true },
          ),
        },
        errors: [400, 401, 403, 404, 409, 412, 413, 415, 428, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/history': {
      parameters: [sessionPath],
      get: operation({
        id: 'listAgentApiHistory',
        tag: 'History',
        summary: 'Read a bounded durable client-safe History page',
        security: authenticated,
        parameters: [afterSequenceParameter(), limitParameter(), cursorParameter()],
        success: { 200: jsonResponse('AgentApiHistoryPage', 'History page') },
        errors: [400, 401, 403, 404, 406, 409, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/checkpoints': {
      parameters: [sessionPath],
      get: operation({
        id: 'listAgentApiCheckpoints',
        tag: 'Checkpoints',
        summary: 'List safe Checkpoint metadata',
        security: authenticated,
        parameters: [limitParameter(), cursorParameter()],
        success: { 200: jsonResponse('AgentApiCheckpointPage', 'Checkpoint page') },
        errors: [400, 401, 403, 404, 406, 409, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/checkpoints/{checkpoint_id}/preview': {
      parameters: [sessionPath, checkpointPath],
      get: operation({
        id: 'previewAgentApiCheckpoint',
        tag: 'Checkpoints',
        summary: 'Read a bounded rewind preview',
        security: authenticated,
        success: {
          200: jsonResponse('AgentApiCheckpointPreview', 'Checkpoint preview', undefined, {
            etag: true,
          }),
        },
        errors: [400, 401, 403, 404, 406, 409, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/rewinds': {
      parameters: [sessionPath],
      post: operation({
        id: 'rewindAgentApiSession',
        tag: 'Checkpoints',
        summary: 'Rewind to a safe between-turn Checkpoint',
        security: bearer,
        parameters: [idempotencyParameter(), ifMatchParameter()],
        request: 'AgentApiRewindSessionRequest',
        success: {
          200: mutationResponse('rewind_session', 'AgentApiSession', 'Session rewound', {
            etag: true,
          }),
        },
        errors: [400, 401, 403, 404, 409, 412, 413, 415, 428, 429, 503],
      }),
    },
    '/v1/sessions/{session_id}/forks': {
      parameters: [sessionPath],
      post: operation({
        id: 'forkAgentApiSession',
        tag: 'Checkpoints',
        summary: 'Fork a Session at a safe Checkpoint',
        security: bearer,
        parameters: [idempotencyParameter(), ifMatchParameter()],
        request: 'AgentApiForkSessionRequest',
        success: {
          201: mutationResponse('fork_session', 'AgentApiSession', 'Target Session created', {
            location: true,
            etag: true,
          }),
        },
        errors: [400, 401, 403, 404, 409, 412, 413, 415, 428, 429, 503],
      }),
    },
  };
}

interface OperationInput {
  readonly id: string;
  readonly tag: string;
  readonly summary: string;
  readonly security: AgentApiArtifactJson;
  readonly success: Readonly<Record<number, JsonObject>>;
  readonly errors: readonly number[];
  readonly parameters?: readonly AgentApiArtifactJson[];
  readonly request?: string;
  readonly requestExample?: AgentApiArtifactJson;
}

function operation(input: OperationInput): JsonObject {
  const responses = Object.fromEntries([
    ...Object.entries(input.success),
    ...input.errors.map((status) => [
      String(status),
      { $ref: `#/components/responses/Problem${status}` },
    ]),
  ]) as JsonObject;
  return {
    operationId: input.id,
    tags: [input.tag],
    summary: input.summary,
    security: input.security,
    ...(input.parameters ? { parameters: input.parameters } : {}),
    ...(input.request
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: schemaReference(input.request),
                ...(input.requestExample ? { example: input.requestExample } : {}),
              },
            },
          },
        }
      : {}),
    responses,
  };
}

function streamPath(operationId: string, parameters: readonly AgentApiArtifactJson[]): JsonObject {
  return {
    parameters,
    get: operation({
      id: operationId,
      tag: 'Streaming',
      summary: 'Open the bounded Session event stream with explicit resync',
      security: [{ AgentApiContext: [] }],
      parameters: [channelsParameter(), lastEventIdParameter()],
      success: {
        200: {
          description: 'SSE stream',
          headers: successHeaders(),
          content: {
            'text/event-stream': {
              schema: { type: 'string' },
              'x-kite-event-schemas': [
                schemaReference('AgentApiEvent'),
                schemaReference('AgentApiResync'),
              ],
            },
          },
        },
      },
      errors: [400, 401, 403, 404, 406, 409, 429, 503],
    }),
  };
}

function jsonResponse(
  schemaName: string,
  description: string,
  example?: AgentApiArtifactJson,
  options: { readonly etag?: boolean; readonly retryAfter?: boolean } = {},
): JsonObject {
  return {
    description,
    headers: successHeaders(options),
    content: {
      'application/json': {
        schema: schemaReference(schemaName),
        ...(example ? { example } : {}),
      },
    },
  };
}

function mutationResponse(
  operationName: string,
  resourceSchemaName: string,
  description: string,
  options: { readonly etag?: boolean; readonly location?: boolean } = {},
): JsonObject {
  const constrainedSchema = {
    allOf: [
      schemaReference('AgentApiMutationResult'),
      {
        type: 'object',
        properties: {
          operation: { type: 'string', const: operationName },
          resource: schemaReference(resourceSchemaName),
        },
        required: ['operation', 'resource'],
      },
    ],
  } satisfies JsonObject;
  return {
    description,
    content: { 'application/json': { schema: constrainedSchema } },
    headers: {
      ...successHeaders({ etag: options.etag }),
      ...(options.location ? { Location: { $ref: '#/components/headers/Location' } } : {}),
    },
  };
}

function emptyResponse(description: string): JsonObject {
  return { description, headers: successHeaders() };
}

function schemaReference(name: string): JsonObject {
  return { $ref: `#/components/schemas/${name}` };
}

function pathParameter(name: string, description: string): JsonObject {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$', maxLength: 128 },
  };
}

function queryParameter(name: string, description: string): JsonObject {
  return { name, in: 'query', required: false, description, schema: { type: 'string' } };
}

function limitParameter(): JsonObject {
  return {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  };
}

function cursorParameter(): JsonObject {
  return {
    name: 'cursor',
    in: 'query',
    required: false,
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', maxLength: 1024 },
  };
}

function afterSequenceParameter(): JsonObject {
  return {
    name: 'after_sequence',
    in: 'query',
    required: false,
    description: 'Return durable History strictly after this sequence',
    schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  };
}

function waitParameter(): JsonObject {
  return {
    name: 'timeout_ms',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: 30000, default: 0 },
  };
}

function channelsParameter(): JsonObject {
  return {
    name: 'channels',
    in: 'query',
    required: false,
    description: 'Comma-separated closed channel set; order is canonicalized.',
    schema: { type: 'string' },
  };
}

function idempotencyParameter(): JsonObject {
  return {
    name: 'Idempotency-Key',
    in: 'header',
    required: true,
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{22,128}$' },
  };
}

function ifMatchParameter(): JsonObject {
  return {
    name: 'If-Match',
    in: 'header',
    required: true,
    schema: {
      type: 'string',
      pattern: '^"session:[A-Za-z0-9][A-Za-z0-9._:-]*:rev:(?:0|[1-9][0-9]*)"$',
    },
  };
}

function lastEventIdParameter(): JsonObject {
  return {
    name: 'Last-Event-ID',
    in: 'header',
    required: false,
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', maxLength: 1024 },
  };
}

function commonHeaderComponents(): JsonObject {
  return {
    RequestId: { description: 'Server-generated request identity', schema: { type: 'string' } },
    ApiVersion: { description: 'Public API major', schema: { type: 'string', const: 'v1' } },
    SchemaDigest: {
      description: 'Lowercase SHA-256 contract artifact digest',
      schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
    CacheControl: {
      description: 'Data-plane responses are never cached',
      schema: { type: 'string' },
    },
    ETag: { description: 'Exact Session revision ETag', schema: { type: 'string' } },
    Location: { description: 'Canonical absolute-path resource URL', schema: { type: 'string' } },
    RetryAfter: {
      description: 'Retry delay in seconds',
      schema: { type: 'integer', minimum: 1, maximum: 30 },
    },
  };
}

function successHeaders(
  options: { readonly etag?: boolean; readonly retryAfter?: boolean } = {},
): JsonObject {
  return {
    'X-Request-ID': { $ref: '#/components/headers/RequestId' },
    'Kite-Agent-API-Version': { $ref: '#/components/headers/ApiVersion' },
    'Kite-Agent-API-Schema-Digest': { $ref: '#/components/headers/SchemaDigest' },
    'Cache-Control': { $ref: '#/components/headers/CacheControl' },
    ...(options.etag ? { ETag: { $ref: '#/components/headers/ETag' } } : {}),
    ...(options.retryAfter ? { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } } : {}),
  };
}

function problemResponseComponents(): JsonObject {
  return Object.fromEntries(
    [400, 401, 403, 404, 405, 406, 409, 412, 413, 415, 426, 428, 429, 503].map((status) => [
      `Problem${status}`,
      {
        description: `Agent API Problem (${status})`,
        headers: {
          ...successHeaders(),
          ...([429, 503].includes(status)
            ? { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } }
            : {}),
        },
        content: { 'application/problem+json': { schema: schemaReference('AgentApiProblem') } },
      },
    ]),
  ) as JsonObject;
}

function withoutJsonSchemaIdentity(schema: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== '$schema' && key !== '$id'),
  ) as JsonObject;
}

function jsonSchemaToTypeScript(schema: JsonObject, depth: number): string {
  if (
    typeof schema.const === 'string' ||
    typeof schema.const === 'number' ||
    typeof schema.const === 'boolean'
  ) {
    return JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ') || 'never';
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives) {
    return alternatives
      .map((entry) => (isJsonObject(entry) ? jsonSchemaToTypeScript(entry, depth) : 'unknown'))
      .join(' | ');
  }
  if (schema.type === 'object' || isJsonObject(schema.properties)) {
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === 'string')
        : [],
    );
    const indent = '  '.repeat(depth + 1);
    const closeIndent = '  '.repeat(depth);
    const fields = Object.entries(properties)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        const type = isJsonObject(value) ? jsonSchemaToTypeScript(value, depth + 1) : 'unknown';
        return `${indent}readonly ${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${type};`;
      });
    if (fields.length === 0) return 'Readonly<Record<string, unknown>>';
    return `{\n${fields.join('\n')}\n${closeIndent}}`;
  }
  if (schema.type === 'array') {
    const item = isJsonObject(schema.items)
      ? jsonSchemaToTypeScript(schema.items, depth)
      : 'unknown';
    return `readonly (${item})[]`;
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  return 'unknown';
}

function isJsonObject(value: AgentApiArtifactJson | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
