import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import type { JobDefinition, Json, ToolDefinition, ToolResult } from '../extensions';
import { createTaskBinding } from './tasks';
import { BoundedStdioTransport, boundedFetch } from './transport';

export type McpTransportConfiguration =
  | {
      type: 'stdio';
      command: string;
      args: readonly string[];
      cwd: string;
      env: Readonly<Record<string, string>>;
    }
  | { type: 'http'; url: string; headers?: Readonly<Record<string, string>> };
export interface McpCallBinding {
  readonly serverId: string;
  readonly scopeId: string;
  readonly configDigest: string;
  readonly catalogueGeneration: number;
  readonly definitionId: string;
  readonly definitionVersion: string;
}
export type McpReadRequest =
  | { method: 'resources/list' }
  | { method: 'prompts/list' }
  | { method: 'resources/read'; uri: string }
  | { method: 'prompts/get'; name: string; arguments: Record<string, string> };
export interface McpAdapterOptions {
  id: string;
  /** Lifecycle-only ordinary Job registration; direct adapters remain synchronous by default. */
  tasks?: boolean;
  transport: McpTransportConfiguration;
  /** Trusted host gate; does not qualify the built-in process/network transports. */
  admitToolCall?: (binding: McpCallBinding, options: { signal: AbortSignal }) => Promise<void>;
  /** Trusted synchronous source fence; invoked again immediately before each captured wire call. */
  assertFresh?: () => void;
  /** Optional trusted transport mechanism; lifecycle invokes this only from its dispatched Job.start. */
  createTransport?: () => Promise<Transport>;
  limits?: {
    maxFrameBytes?: number;
    maxItems?: number;
    maxPages?: number;
    maxInFlight?: number;
    timeoutMs?: number;
  };
}
export class McpAdapterError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Explicit optional adapter. Import/factory does not spawn or connect. */
export function createMcpAdapter(options: McpAdapterOptions) {
  const serverId = options.id;
  const admitToolCall = options.admitToolCall;
  const assertSourceFresh = options.assertFresh;
  const createTransport = options.createTransport;
  const configuration = structuredClone(options.transport);
  const maximum = options.limits?.maxFrameBytes ?? 1024 * 1024;
  const items = options.limits?.maxItems ?? 1024;
  const pages = options.limits?.maxPages ?? 32;
  const concurrency = options.limits?.maxInFlight ?? 16;
  const timeout = options.limits?.timeoutMs ?? 10000;
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(serverId) ||
    [maximum, items, pages, concurrency, timeout].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    maximum > 64 * 1024 * 1024 ||
    items > 16384 ||
    pages > 256 ||
    concurrency > 128 ||
    timeout > 60000
  )
    throw new McpAdapterError('invalid_mcp_configuration');
  if (configuration.type === 'stdio') {
    if (
      !isAbsolute(configuration.command) ||
      !isAbsolute(configuration.cwd) ||
      configuration.command.length > 4096 ||
      configuration.cwd.length > 4096 ||
      configuration.args.length > 128 ||
      configuration.args.some((arg) => typeof arg !== 'string' || arg.length > 8192) ||
      Object.keys(configuration.env).length > 256 ||
      Object.values(configuration.env).some(
        (value) => typeof value !== 'string' || value.length > 8192,
      )
    )
      throw new McpAdapterError('invalid_mcp_configuration');
  } else {
    const url = new URL(configuration.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 8192 ||
      Object.keys(configuration.headers ?? {}).length > 128
    )
      throw new McpAdapterError('invalid_mcp_configuration');
  }
  const identity = digest({ id: serverId, configuration });
  const leases = new Set<object>();
  let closed = false;
  let clientTask: Promise<Client> | undefined;
  let current: Client | undefined;
  let dead = false;
  let generation = 0;
  let catalogueGeneration = 0;
  type Cache = {
    tools: readonly Tool[];
    client: Client;
    connectionGeneration: number;
    catalogueGeneration: number;
    digest: string;
  };
  function definitionVersion(captured: Cache, descriptor: Tool) {
    return descriptor.execution?.taskSupport === 'required' && options.tasks
      ? digest({
          identity,
          descriptor,
          taskAdapterVersion: 1,
          capabilities: captured.client.getServerCapabilities()?.tasks ?? null,
        })
      : digest({ identity, descriptor });
  }
  let cache: Cache | undefined;
  function getToolsMetadata() {
    const captured = cache;
    return freeze({
      serverId,
      configDigest: identity,
      generation: catalogueGeneration,
      available: !!captured && !closed && !dead,
      tools: (captured?.tools ?? []).map((descriptor) => ({
        definitionId: `mcp.${serverId}.${digest(descriptor.name).slice(0, 32)}`,
        definitionVersion: definitionVersion(captured!, descriptor),
        descriptor,
      })),
    });
  }

  function invalidateCatalogue() {
    catalogueGeneration++;
    cache = undefined;
  }
  let inflight = 0;
  let closeTask: Promise<void> | undefined;
  const idle = new Set<() => void>();
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  function bounded(value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value)) > maximum)
      throw new McpAdapterError('mcp_payload_limit');
  }
  async function disconnect() {
    generation++;
    invalidateCatalogue();
    const client = current;
    current = undefined;
    clientTask = undefined;
    if (client) await client.close().catch(() => {});
  }
  async function connection() {
    if (closed) throw new McpAdapterError('mcp_adapter_closed');
    if (clientTask && !dead) return clientTask;
    dead = false;
    const ticket = ++generation;
    clientTask = (async () => {
      const client = new Client({ name: 'kite-agent-mcp', version: '1' }, { capabilities: {} });
      current = client;
      client.onclose = () => {
        if (current === client) {
          dead = true;
          invalidateCatalogue();
        }
      };
      try {
        const transport = createTransport
          ? await createTransport()
          : configuration.type === 'stdio'
            ? new BoundedStdioTransport(
                { ...configuration, args: [...configuration.args], env: { ...configuration.env } },
                maximum,
              )
            : new StreamableHTTPClientTransport(new URL(configuration.url), {
                requestInit: { headers: { ...configuration.headers } },
                fetch: boundedFetch(maximum),
                reconnectionOptions: {
                  maxRetries: 0,
                  initialReconnectionDelay: 1,
                  maxReconnectionDelay: 1,
                  reconnectionDelayGrowFactor: 1,
                },
              });
        await client.connect(transport, { timeout });
        if (closed || !leases.size || generation !== ticket)
          throw new McpAdapterError('mcp_scope_released');
        return client;
      } catch {
        await client.close().catch(() => {});
        if (generation === ticket) {
          clientTask = undefined;
          current = undefined;
        }
        throw new McpAdapterError('mcp_connection_failed');
      }
    })();
    return clientTask;
  }
  async function request<T>(work: () => Promise<T>): Promise<T> {
    if (inflight >= concurrency) throw new McpAdapterError('mcp_request_capacity');
    inflight++;
    try {
      const value = await work();
      bounded(value);
      return value;
    } finally {
      inflight--;
      if (!inflight) {
        for (const wake of idle) wake();
        idle.clear();
        if (!leases.size) await disconnect();
      }
    }
  }
  async function catalogue<T>(
    read: (cursor?: string) => Promise<{ values: T[]; nextCursor?: string }>,
  ): Promise<T[]> {
    const result: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < pages; page++) {
      const value = await read(cursor);
      if (result.length + value.values.length > items)
        throw new McpAdapterError('mcp_catalogue_limit');
      result.push(...value.values);
      if (!value.nextCursor) return result;
      if (cursors.has(value.nextCursor)) throw new McpAdapterError('mcp_cursor_repeated');
      cursors.add(value.nextCursor);
      cursor = value.nextCursor;
    }
    throw new McpAdapterError('mcp_catalogue_limit');
  }
  return {
    invalidateCatalogue,
    getToolsMetadata,
    getCatalogue() {
      return freeze({
        serverId,
        configDigest: identity,
        generation: catalogueGeneration,
        available: !!cache && !closed && !dead,
        definitions: (cache?.tools ?? []).map((descriptor) => ({
          id: `mcp.${serverId}.${digest(descriptor.name).slice(0, 32)}`,
          version: definitionVersion(cache!, descriptor),
        })),
      });
    },
    scope(scopeId: string) {
      if (closed || !scopeId || scopeId.length > 256 || leases.size >= 512)
        throw new McpAdapterError('invalid_mcp_scope');
      const lease = { scopeId };
      leases.add(lease);
      let released = false;
      let releaseTask: Promise<void> | undefined;
      function check() {
        if (released || closed) throw new McpAdapterError('mcp_scope_released');
        assertSourceFresh?.();
      }
      let boundJobs: readonly JobDefinition[] = Object.freeze([]);
      let boundCache: Cache | undefined;
      let boundTools: readonly ToolDefinition[] = Object.freeze([]);
      function bindTools(captured: Cache): readonly ToolDefinition[] {
        const names = new Set<string>();
        const jobs: JobDefinition[] = [];
        const tools = Object.freeze(
          captured.tools.map((raw) => {
            if (names.has(raw.name) || raw.name.length > 256)
              throw new McpAdapterError('mcp_duplicate_tool');
            names.add(raw.name);
            const descriptor = freeze(structuredClone(raw));
            bounded(descriptor);
            if (descriptor.execution?.taskSupport === 'required' && !options.tasks)
              throw new McpAdapterError('mcp_task_unsupported');
            const outputValidator = descriptor.outputSchema
              ? ajv.compile(descriptor.outputSchema)
              : undefined;
            const inputValidator = ajv.compile(descriptor.inputSchema);
            const version = definitionVersion(captured, descriptor);
            if (descriptor.execution?.taskSupport === 'required' && options.tasks) {
              const capabilities = captured.client.getServerCapabilities();
              if (!capabilities?.tasks?.requests?.tools?.call)
                throw new McpAdapterError('mcp_task_capability_missing');
              const task = createTaskBinding({
                descriptor,
                tool: {
                  id: `mcp.${serverId}.${digest(descriptor.name).slice(0, 32)}`,
                  version,
                  description: `External MCP Task: ${[...descriptor.name].map((char) => (char.charCodeAt(0) < 32 ? ' ' : char)).join('')}`,
                  inputSchema: freeze(
                    structuredClone(descriptor.inputSchema),
                  ) as ToolDefinition['inputSchema'],
                },
                identity: {
                  serverId,
                  scopeId,
                  configDigest: identity,
                  catalogueGeneration: captured.catalogueGeneration,
                  definitionVersion: version,
                  taskAdapterVersion: 1,
                  capabilities: JSON.parse(JSON.stringify(capabilities.tasks)) as Json,
                },
                client: captured.client,
                timeout,
                request,
                validateInput: (input) => {
                  bounded(input);
                  return (
                    input !== null &&
                    typeof input === 'object' &&
                    !Array.isArray(input) &&
                    !!inputValidator(input)
                  );
                },
                validateOutput: (input) =>
                  !outputValidator || (input !== undefined && !!outputValidator(input)),
                async beforeStart(signal) {
                  const assert = () => {
                    check();
                    if (
                      dead ||
                      cache !== captured ||
                      current !== captured.client ||
                      generation !== captured.connectionGeneration
                    )
                      throw new McpAdapterError('mcp_catalogue_stale');
                    signal.throwIfAborted();
                  };
                  assert();
                  if (admitToolCall)
                    await admitToolCall(
                      freeze({
                        serverId,
                        scopeId,
                        configDigest: identity,
                        catalogueGeneration: captured.catalogueGeneration,
                        definitionId: task.tool.id,
                        definitionVersion: version,
                      }),
                      { signal },
                    );
                  assert();
                },
                retain() {
                  const taskLease = {};
                  leases.add(taskLease);
                  let done = false;
                  return async () => {
                    if (done) return;
                    done = true;
                    leases.delete(taskLease);
                    if (!leases.size && !inflight) await disconnect();
                  };
                },
              });
              jobs.push(task.job);
              return freeze(task.tool);
            }
            const definition: ToolDefinition = {
              id: `mcp.${serverId}.${digest(descriptor.name).slice(0, 32)}`,
              version,
              description: `External MCP tool: ${[...(descriptor.description ?? descriptor.name)]
                .map((char) => (char.charCodeAt(0) < 32 ? ' ' : char))
                .join('')
                .slice(0, 8192)}`,
              inputSchema: freeze(
                structuredClone(descriptor.inputSchema),
              ) as ToolDefinition['inputSchema'],
              async execute(input, context): Promise<ToolResult> {
                if (released || closed)
                  return {
                    outcome: 'failed',
                    content: 'mcp_scope_released',
                    details: { adapterAttempted: false },
                  };
                if (context.signal.aborted)
                  return {
                    outcome: 'cancelled',
                    content: 'mcp_cancelled_before_call',
                    details: { adapterAttempted: false },
                  };
                let argumentsSnapshot: Json;
                try {
                  argumentsSnapshot = freeze(structuredClone(input));
                  bounded(argumentsSnapshot);
                } catch {
                  return {
                    outcome: 'failed',
                    content: 'mcp_payload_limit',
                    details: { adapterAttempted: false },
                  };
                }
                if (
                  argumentsSnapshot === null ||
                  typeof argumentsSnapshot !== 'object' ||
                  Array.isArray(argumentsSnapshot) ||
                  !inputValidator(argumentsSnapshot)
                )
                  return { outcome: 'failed', content: 'mcp_arguments_invalid' };
                const binding: McpCallBinding = freeze({
                  serverId,
                  scopeId,
                  configDigest: identity,
                  catalogueGeneration: captured.catalogueGeneration,
                  definitionId: definition.id,
                  definitionVersion: version,
                });
                function assertFresh() {
                  check();
                  if (
                    cache !== captured ||
                    dead ||
                    current !== captured.client ||
                    generation !== captured.connectionGeneration
                  )
                    throw new McpAdapterError('mcp_catalogue_stale');
                  if (context.signal.aborted)
                    throw new McpAdapterError('mcp_cancelled_before_call');
                }
                let attempted = false;
                try {
                  const result = await request(async () => {
                    assertFresh();
                    if (admitToolCall) await admitToolCall(binding, { signal: context.signal });
                    // No await between this final local check and the actual RPC.
                    assertFresh();
                    attempted = true;
                    return captured.client.request(
                      {
                        method: 'tools/call',
                        params: { name: descriptor.name, arguments: argumentsSnapshot },
                      },
                      CallToolResultSchema,
                      { timeout, signal: context.signal },
                    );
                  });
                  if (context.signal.aborted)
                    return {
                      outcome: 'outcome_unknown',
                      content: 'mcp_cancel_unconfirmed',
                      details: { remoteStopConfirmed: false },
                    };
                  if (
                    outputValidator &&
                    !result.isError &&
                    (!result.structuredContent || !outputValidator(result.structuredContent))
                  )
                    return {
                      outcome: 'outcome_unknown',
                      content: 'mcp_output_invalid',
                      details: {
                        remoteStopConfirmed: false,
                        actualResult: JSON.parse(JSON.stringify(result)) as Json,
                      },
                    };
                  return {
                    outcome: result.isError ? 'failed' : 'succeeded',
                    content: JSON.stringify(result.content),
                    details: JSON.parse(JSON.stringify(result)) as Json,
                  };
                } catch (error) {
                  return {
                    outcome: attempted
                      ? 'outcome_unknown'
                      : error instanceof McpAdapterError &&
                          error.code === 'mcp_cancelled_before_call'
                        ? 'cancelled'
                        : 'failed',
                    content: attempted
                      ? 'mcp_call_unconfirmed'
                      : error instanceof McpAdapterError
                        ? error.code
                        : 'mcp_admission_rejected',
                    details: { remoteStopConfirmed: false, adapterAttempted: attempted },
                  };
                }
              },
            };
            return freeze(definition);
          }),
        );
        boundJobs = Object.freeze(jobs);
        return tools;
      }
      function getCachedTools(): readonly ToolDefinition[] {
        check();
        if (!cache) return Object.freeze([]);
        if (boundCache !== cache) {
          boundTools = bindTools(cache);
          boundCache = cache;
        }
        return boundTools;
      }
      return {
        getCachedTools,
        getCachedJobs() {
          getCachedTools();
          return boundJobs;
        },
        async snapshotTools(): Promise<readonly ToolDefinition[]> {
          check();
          const client = await connection();
          check();
          const connectionGeneration = generation;
          const revision = catalogueGeneration;
          // Direct typed request avoids mutable SDK catalogue/output-validator caches.
          const tools = await catalogue(async (cursor) => {
            const result = await request(() =>
              client.request(
                { method: 'tools/list', params: cursor ? { cursor } : {} },
                ListToolsResultSchema,
                { timeout },
              ),
            );
            return {
              values: result.tools,
              ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
            };
          });
          check();
          if (
            dead ||
            current !== client ||
            generation !== connectionGeneration ||
            catalogueGeneration !== revision
          )
            throw new McpAdapterError('mcp_catalogue_stale');
          const catalogueDigest = digest(tools);
          if (!cache || cache.digest !== catalogueDigest || cache.client !== client) {
            const candidate: Cache = {
              tools: freeze(structuredClone(tools)),
              client,
              connectionGeneration,
              catalogueGeneration: catalogueGeneration + 1,
              digest: catalogueDigest,
            };
            const definitions = bindTools(candidate); // validate before publishing the cache
            catalogueGeneration++;
            cache = candidate;
            boundCache = candidate;
            boundTools = definitions;
          }
          return getCachedTools();
        },
        /** One explicit refresh on the captured live client; never lazy-connects. */
        captureRefresh(expectedGeneration: number) {
          const captured = cache;
          const fresh = (signal?: AbortSignal) => {
            check();
            if (
              !captured ||
              dead ||
              cache !== captured ||
              current !== captured.client ||
              generation !== captured.connectionGeneration ||
              captured.catalogueGeneration !== expectedGeneration
            )
              throw new McpAdapterError('mcp_catalogue_stale');
            if (signal?.aborted) throw new McpAdapterError('mcp_cancelled_before_call');
          };
          fresh();
          let metadata: ReturnType<typeof getToolsMetadata> | undefined;
          return {
            getToolsMetadata: () => metadata,
            async execute(options: { signal: AbortSignal }): Promise<ToolResult> {
              let attempted = false;
              try {
                const tools = await catalogue(async (cursor) => {
                  const page = await request(() => {
                    fresh(options.signal);
                    attempted = true;
                    return captured!.client.request(
                      { method: 'tools/list', params: cursor ? { cursor } : {} },
                      ListToolsResultSchema,
                      { timeout, signal: options.signal },
                    );
                  });
                  return { values: page.tools, nextCursor: page.nextCursor };
                });
                fresh(options.signal);
                bounded(tools);
                const catalogueDigest = digest(tools);
                if (captured!.digest !== catalogueDigest) {
                  const candidate: Cache = {
                    tools: freeze(structuredClone(tools)),
                    client: captured!.client,
                    connectionGeneration: captured!.connectionGeneration,
                    catalogueGeneration: catalogueGeneration + 1,
                    digest: catalogueDigest,
                  };
                  const definitions = bindTools(candidate);
                  fresh(options.signal);
                  catalogueGeneration++;
                  cache = candidate;
                  boundCache = candidate;
                  boundTools = definitions;
                }
                metadata = getToolsMetadata();
                return {
                  outcome: 'succeeded',
                  content: 'MCP live catalogue refreshed',
                  details: {
                    adapterAttempted: true,
                    generation: catalogueGeneration,
                    definitions: getCachedTools().map(({ id, version }) => ({ id, version })),
                  },
                };
              } catch (error) {
                return {
                  outcome: attempted
                    ? 'outcome_unknown'
                    : options.signal.aborted
                      ? 'cancelled'
                      : 'failed',
                  content: attempted
                    ? 'mcp_refresh_unconfirmed'
                    : error instanceof McpAdapterError
                      ? error.code
                      : 'mcp_connection_unavailable',
                  details: { adapterAttempted: attempted, remoteStopConfirmed: false },
                };
              }
            },
          };
        },
        async listResources() {
          check();
          const client = await connection();
          check();
          return catalogue(async (cursor) => {
            const value = await request(() =>
              client.listResources(cursor ? { cursor } : {}, { timeout }),
            );
            return {
              values: value.resources,
              ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
            };
          });
        },
        async readResource(uri: string) {
          check();
          if (uri.length > 8192) throw new McpAdapterError('mcp_arguments_invalid');
          const client = await connection();
          check();
          return request(() => client.readResource({ uri }, { timeout }));
        },
        async listPrompts() {
          check();
          const client = await connection();
          check();
          return catalogue(async (cursor) => {
            const value = await request(() =>
              client.listPrompts(cursor ? { cursor } : {}, { timeout }),
            );
            return {
              values: value.prompts,
              ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
            };
          });
        },
        async getPrompt(name: string, args: Record<string, string> = {}) {
          check();
          bounded(args);
          if (name.length > 256) throw new McpAdapterError('mcp_arguments_invalid');
          const client = await connection();
          check();
          return request(() => client.getPrompt({ name, arguments: args }, { timeout }));
        },
        /** Captures only an already-live client. Never connects or replaces an unavailable client. */
        captureRead(expectedGeneration: number) {
          const captured = cache;
          function assertFresh(signal?: AbortSignal) {
            check();
            if (
              !captured ||
              dead ||
              cache !== captured ||
              current !== captured.client ||
              generation !== captured.connectionGeneration ||
              captured.catalogueGeneration !== expectedGeneration
            )
              throw new McpAdapterError('mcp_catalogue_stale');
            if (signal?.aborted) throw new McpAdapterError('mcp_cancelled_before_call');
          }
          assertFresh();
          return {
            async execute(
              value: McpReadRequest,
              options: { signal: AbortSignal },
            ): Promise<ToolResult> {
              let attempted = false;
              try {
                const input = freeze(structuredClone(value));
                bounded(input);
                if (
                  (input.method === 'resources/read' &&
                    (typeof input.uri !== 'string' ||
                      !input.uri.length ||
                      input.uri.length > 8192)) ||
                  (input.method === 'prompts/get' &&
                    (typeof input.name !== 'string' ||
                      !input.name.length ||
                      input.name.length > 256 ||
                      !input.arguments ||
                      typeof input.arguments !== 'object' ||
                      Array.isArray(input.arguments) ||
                      Object.keys(input.arguments).length > 128 ||
                      Object.values(input.arguments).some(
                        (value) => typeof value !== 'string' || value.length > 8192,
                      ))) ||
                  !['resources/list', 'resources/read', 'prompts/list', 'prompts/get'].includes(
                    input.method,
                  )
                )
                  throw new McpAdapterError('mcp_arguments_invalid');
                assertFresh(options.signal);
                const capabilities = captured!.client.getServerCapabilities();
                if (
                  !(input.method.startsWith('resources/')
                    ? capabilities?.resources
                    : capabilities?.prompts)
                )
                  throw new McpAdapterError('mcp_read_unsupported');
                const rpc = async <T>(work: () => Promise<T>) =>
                  request(async () => {
                    // No await between this exact captured-client check and the RPC.
                    assertFresh(options.signal);
                    attempted = true;
                    return work();
                  });
                const client = captured!.client;
                const rpcOptions = { timeout, signal: options.signal };
                const result =
                  input.method === 'resources/list'
                    ? await catalogue(async (cursor) => {
                        const page = await rpc(() =>
                          client.request(
                            { method: input.method, params: cursor ? { cursor } : {} },
                            ListResourcesResultSchema,
                            rpcOptions,
                          ),
                        );
                        return { values: page.resources, nextCursor: page.nextCursor };
                      })
                    : input.method === 'prompts/list'
                      ? await catalogue(async (cursor) => {
                          const page = await rpc(() =>
                            client.request(
                              { method: input.method, params: cursor ? { cursor } : {} },
                              ListPromptsResultSchema,
                              rpcOptions,
                            ),
                          );
                          return { values: page.prompts, nextCursor: page.nextCursor };
                        })
                      : input.method === 'resources/read'
                        ? await rpc(() =>
                            client.request(
                              { method: input.method, params: { uri: input.uri } },
                              ReadResourceResultSchema,
                              rpcOptions,
                            ),
                          )
                        : await rpc(() =>
                            client.request(
                              {
                                method: input.method,
                                params: { name: input.name, arguments: input.arguments },
                              },
                              GetPromptResultSchema,
                              rpcOptions,
                            ),
                          );
                bounded(result);
                if (options.signal.aborted)
                  return {
                    outcome: 'outcome_unknown',
                    content: 'mcp_cancel_unconfirmed',
                    details: { adapterAttempted: true, remoteStopConfirmed: false },
                  };
                return {
                  outcome: 'succeeded',
                  content: JSON.stringify(result),
                  details: {
                    actualResult: JSON.parse(JSON.stringify(result)) as Json,
                    adapterAttempted: true,
                    remoteStopConfirmed: false,
                  },
                };
              } catch (error) {
                return {
                  outcome: attempted
                    ? 'outcome_unknown'
                    : options.signal.aborted
                      ? 'cancelled'
                      : 'failed',
                  content: attempted
                    ? 'mcp_read_unconfirmed'
                    : error instanceof McpAdapterError
                      ? error.code
                      : 'mcp_arguments_invalid',
                  details: {
                    adapterAttempted: attempted,
                    remoteStopConfirmed: false,
                    ...(error instanceof McpAdapterError ? { code: error.code } : {}),
                  },
                };
              }
            },
          };
        },
        release() {
          if (releaseTask) return releaseTask;
          released = true;
          leases.delete(lease);
          releaseTask = (async () => {
            if (leases.size) return;
            if (inflight) await new Promise<void>((resolve) => idle.add(resolve));
            if (!leases.size) await disconnect();
          })();
          return releaseTask;
        },
      };
    },
    close() {
      if (closeTask) return closeTask;
      closed = true;
      leases.clear();
      closeTask = disconnect();
      return closeTask;
    },
  };
}

export {
  createMcpCredentialBroker,
  type McpCredentialBroker,
  McpCredentialError,
  type McpCredentialIdentity,
  type McpCredentialRef,
  type McpCredentialUse,
} from './credentials';
export {
  createMcpLifecycle,
  type McpLifecycleOptions,
  type McpLifecycleTransportPort,
  type McpScopedSourcePort,
  type McpScopedSourceResolution,
  mcpLifecycleExtensionId,
  mcpReadToolIds,
  mcpSourceConnectionJobId,
} from './lifecycle';
export type {
  McpReconnectionInput,
  McpReconnectionReplacement,
  McpReconnectionTarget,
} from './reconnection-types';
export {
  createMcpStdioTransportPort,
  McpStdioPortError,
  type McpStdioPortOptions,
  mcpStdioGuardianAsset,
} from './stdio-port';
