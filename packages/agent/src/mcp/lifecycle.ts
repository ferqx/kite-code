import { createHash, randomUUID } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpSourceReadSet } from '../config/mcp-sources';
import type {
  ActionContext,
  Extension,
  JobDefinition,
  JobHandle,
  Json,
  OperationRef,
  StopConfirmation,
  ToolResult,
} from '../extensions';
import { readConnection } from './connection-query';
import {
  createMcpAdapter,
  McpAdapterError,
  type McpAdapterOptions,
  type McpReadRequest,
  type McpTransportConfiguration,
} from './index';
import {
  confirmedStop,
  decodeReconnectionInput,
  equal as proofEqual,
  hash as proofHash,
  object as proofObject,
  proveCarrier,
  type ReconnectionStage,
  reconnectionId,
  reconnectionInputSchema,
  reconnectionType,
  stoppedOrUnopened,
} from './reconnection-proof';
import { readReconnection } from './reconnection-query';
import type { McpReconnectionInput } from './reconnection-types';
import {
  publishToolsSnapshot,
  readToolsPage,
  readToolsSnapshot,
  toolsSnapshotType,
} from './tools-metadata';

export const mcpLifecycleExtensionId = 'builtin.mcp';
const contentType = 'builtin.mcp.catalogue';
const refreshContentType = 'builtin.mcp.refresh';
const refreshId = 'mcp.catalogue.refresh';
function toolsView(contentType: string, payload: Json) {
  const result = [
    {
      extensionId: mcpLifecycleExtensionId,
      contentType,
      contentVersion: 1,
      summary: 'Original tool metadata; not permissions',
      payload,
      actions: [],
      artifactRefs: [],
    },
  ];
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024)
    throw new McpAdapterError('mcp_tools_metadata_limit');
  return result;
}
async function admitToolsRead(context: import('../extensions').ReadContext) {
  if (!context.readExecutionGroupSafety) throw new McpAdapterError('mcp_tools_scope_unavailable');
  await context.readExecutionGroupSafety();
}

export const mcpReadToolIds = [
  'mcp.resources.list',
  'mcp.resources.read',
  'mcp.prompts.list',
  'mcp.prompts.get',
] as const;
const readContentTypes = { resources: 'builtin.mcp.resources', prompts: 'builtin.mcp.prompts' };
const canonical = (value: Json): Json =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key]!)]),
        )
      : value;
const digest = (value: Json): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const object = (value: Json | undefined): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const bindingProperties = {
  serverId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
  connectionKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  configDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  generation: { type: 'integer', minimum: 1 },
};
const targetProperties = {
  catalogueExecutionId: { type: 'string', minLength: 1, maxLength: 128 },
  descriptorDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
};
function readSchema(id: (typeof mcpReadToolIds)[number]) {
  const target = id.endsWith('.read') || id.endsWith('.get');
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      ...Object.keys(bindingProperties),
      ...(target ? Object.keys(targetProperties) : []),
      ...(id.endsWith('.read') ? ['uri'] : id.endsWith('.get') ? ['name', 'arguments'] : []),
    ],
    properties: {
      ...bindingProperties,
      ...(target ? targetProperties : {}),
      ...(id.endsWith('.read') ? { uri: { type: 'string', minLength: 1, maxLength: 8192 } } : {}),
      ...(id.endsWith('.get')
        ? {
            name: { type: 'string', minLength: 1, maxLength: 256 },
            arguments: {
              type: 'object',
              maxProperties: 128,
              additionalProperties: { type: 'string', maxLength: 8192 },
            },
          }
        : {}),
    },
  };
}
const refreshSchema = {
  ...readSchema('mcp.resources.list'),
  required: [...readSchema('mcp.resources.list').required, 'connectionExecutionId'],
  properties: {
    ...readSchema('mcp.resources.list').properties,
    connectionExecutionId: { type: 'string', minLength: 1, maxLength: 256 },
  },
};
export interface McpLifecycleTransportPort {
  /** Called exclusively by the dispatched connection Job. The host owns qualification. */
  open(
    binding: Readonly<{
      serverId: string;
      scopeId: string;
      sessionId: string;
      executionId: string;
      configDigest: string;
      originalStoreId: string;
      configuration: McpTransportConfiguration;
    }>,
    options: { signal: AbortSignal },
  ): Promise<{
    transport: Transport;
    stop(): Promise<StopConfirmation>;
    /** Confirms only this owned transport's lifetime, never remote Tool termination. */
    stopped: Promise<{ supervision: 'ended' | 'unknown' }>;
  }>;
}
export interface McpLifecycleOptions {
  servers: readonly {
    id: string;
    transport: McpTransportConfiguration;
    limits?: McpAdapterOptions['limits'];
  }[];
  transportPort?: McpLifecycleTransportPort;
  /** Trusted late host resolver. Only safe bootstrap identity is persisted by the source Job. */
  scopedSources?: McpScopedSourcePort;
  readyTimeoutMs?: number;
}
export const mcpSourceConnectionJobId = 'mcp.source.connection';
export interface McpScopedSourceResolution {
  server: McpLifecycleOptions['servers'][number];
  captureDigest: string;
  /** Same selected snapshot identity only; never a bootstrap permit. */
  snapshotDigest?: string;
  transportPort: McpLifecycleTransportPort;
  /** Synchronous original-source check at the final local wire boundary. */
  assertFresh(options: { signal: AbortSignal }): void;
}
export interface McpScopedSourcePort {
  resolveReplacement?(
    input: {
      serverId: string;
      sessionId: string;
      executionId: string;
      expectedConfigDigest: string;
      expectedReadSet: McpSourceReadSet;
    },
    options: { signal: AbortSignal },
  ): Promise<McpScopedSourceResolution>;
  resolve(
    input: { serverId: string; sessionId: string; executionId: string },
    options: { signal: AbortSignal },
  ): Promise<McpScopedSourceResolution>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A Job may fail before its parent begins waiting. Preserve rejection without an unhandled promise.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const scopeKey = (storeId: string, sessionId: string, serverId: string) =>
  JSON.stringify([storeId, sessionId, serverId]);
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['serverId', 'key'],
  properties: {
    serverId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  },
};

/** Optional bounded host composition. No connection, discovery or history restoration at construction. */
export function createMcpLifecycle(options: McpLifecycleOptions) {
  const port = options.transportPort;
  const timeout = options.readyTimeoutMs ?? 10000;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 60000 ||
    options.servers.length > 32
  )
    throw new McpAdapterError('invalid_mcp_configuration');
  const servers = new Map(
    options.servers.map((server) => {
      const captured = structuredClone(server);
      // Validates configuration and computes its fixed digest without constructing a transport.
      const probe = createMcpAdapter({
        id: captured.id,
        transport: captured.transport,
        limits: captured.limits,
      });
      return [captured.id, { ...captured, configDigest: probe.getCatalogue().configDigest }];
    }),
  );
  if (servers.size !== options.servers.length)
    throw new McpAdapterError('invalid_mcp_configuration');
  type Server = typeof servers extends Map<string, infer T> ? T : never;
  type Adapter = ReturnType<typeof createMcpAdapter>;
  type Scope = ReturnType<Adapter['scope']>;
  type OwnedTransport = Awaited<ReturnType<McpLifecycleTransportPort['open']>>;
  type Entry = {
    epoch: number;
    executionId: string;
    sessionId: string;
    storeId: string;
    serverId: string;
    server: Server;
    definitionId: string;
    definitionVersion: string;
    source?: McpScopedSourceResolution;
    signal: AbortSignal;
    key: string;
    ready: ReturnType<typeof deferred<void>>;
    end: ReturnType<typeof deferred<'ended' | 'unknown'>>;
    adapter?: Adapter;
    scope?: Scope;
    transport?: OwnedTransport;
    terminal?: 'ended' | 'unknown';
    failureCode?: string;
    ref?: OperationRef;
    stopping?: Promise<StopConfirmation>;
    stopRequested?: boolean;
    confirmPublication?: () => Promise<void>;
  };
  type Ticket = {
    scope: string;
    epoch: number;
    executionId: string;
    inputDigest: string;
    holder?: Entry;
    holderEpoch?: number;
    holderRef?: string;
    newEntry?: Entry;
    mode: 'opening' | 'replacing' | 'publishing' | 'quarantined';
    bootstrapId?: string;
    bootstrapExecutionId?: string;
    ref?: OperationRef;
    jobInputDigest?: string;
    jobDefinitionId?: string;
    jobDefinitionVersion?: string;
    rootWorkCommandId?: string | null;
    rootWorkSeq?: string | null;
    ensureAttempted?: boolean;
    completed?: boolean;
    safeTerminal?: boolean;
    releaseAfterStoppedOpening?: boolean;
    openAllowed: ReturnType<typeof deferred<void>>;
    onRef?: (ref: OperationRef) => Promise<void>;
    verifyUnopened?: (sessionId: string, executionId: string, input: Json) => Promise<boolean>;
  };
  const tickets = new Map<string, Ticket>();
  let holderEpoch = 0;
  function claim(
    storeId: string,
    sessionId: string,
    serverId: string,
    executionId: string,
    inputDigest: string,
    mode: Ticket['mode'],
  ): Ticket {
    const scope = scopeKey(storeId, sessionId, serverId);
    if (tickets.has(scope)) throw new McpAdapterError('mcp_scope_transition_unconfirmed');
    if (tickets.size >= 512) throw new McpAdapterError('mcp_scope_limit');
    const holder = live.get(scope);
    if (holder?.terminal === 'unknown' || (holder?.stopRequested && holder.terminal !== 'ended'))
      throw new McpAdapterError('mcp_scope_transition_unconfirmed');
    const ticket: Ticket = {
      scope,
      epoch: ++holderEpoch,
      executionId,
      inputDigest,
      holder,
      holderEpoch: holder?.epoch,
      holderRef: holder?.ref ? proofHash(holder.ref) : undefined,
      mode,
      openAllowed: deferred<void>(),
    };
    tickets.set(scope, ticket);
    return ticket;
  }
  function assertTicket(ticket: Ticket) {
    if (closed || tickets.get(ticket.scope) !== ticket || ticket.mode === 'quarantined')
      throw new McpAdapterError('mcp_scope_transition_unconfirmed');
    const entry = live.get(ticket.scope);
    if (
      ticket.holder &&
      (ticket.holder.epoch !== ticket.holderEpoch ||
        (ticket.holderRef !== undefined && proofHash(ticket.holder.ref) !== ticket.holderRef))
    )
      throw new McpAdapterError('mcp_holder_changed');
    if (entry !== ticket.holder && entry !== ticket.newEntry)
      throw new McpAdapterError('mcp_holder_changed');
  }
  function wireFresh(entry: Entry, publicationProbe = false) {
    const ticket = tickets.get(scopeKey(entry.storeId, entry.sessionId, entry.serverId));
    if (
      closed ||
      entry.stopRequested ||
      entry.terminal ||
      live.get(scopeKey(entry.storeId, entry.sessionId, entry.serverId)) !== entry ||
      (ticket &&
        (ticket.mode === 'quarantined' ||
          (ticket.mode === 'publishing' && !publicationProbe) ||
          (ticket.mode === 'replacing' && entry === ticket.holder) ||
          (entry !== ticket.holder && entry !== ticket.newEntry)))
    )
      throw new McpAdapterError('mcp_scope_transition_unconfirmed');
  }
  async function confirmPublication(entry: Entry) {
    await entry.confirmPublication?.();
    const scope = scopeKey(entry.storeId, entry.sessionId, entry.serverId);
    const ticket = tickets.get(scope);
    if (ticket?.mode === 'publishing') {
      if (!entry.confirmPublication || ticket.newEntry !== entry || !ticket.completed)
        throw new McpAdapterError('mcp_scope_transition_unconfirmed');
      assertTicket(ticket);
      tickets.delete(scope);
      if (ticket.bootstrapId) admitted.delete(ticket.bootstrapId);
    }
  }
  async function confirmScopePublication(storeId: string, sessionId: string, serverId: string) {
    const entry = live.get(scopeKey(storeId, sessionId, serverId));
    if (entry) await confirmPublication(entry);
  }
  const admitted = new Map<
    string,
    {
      storeId: string;
      sessionId: string;
      serverId: string;
      key: string;
      ticket: Ticket;
      parentExecutionId?: string;
      parentInputDigest?: string;
      source?: McpScopedSourceResolution;
      server?: Server;
    }
  >();
  const entries = new Map<string, Entry>();
  const unopened = new Map<string, { handle: JobHandle; code: string }>();
  const live = new Map<string, Entry>();
  const starting = new Map<string, ReturnType<typeof deferred<Entry>>>();
  let closed = false;
  function end(entry: Entry, supervision: 'ended' | 'unknown') {
    if (entry.terminal) return;
    entry.terminal = supervision;
    entry.adapter?.invalidateCatalogue();
    entry.end.resolve(supervision);
    entry.ready.reject(new McpAdapterError('mcp_connection_unavailable'));
  }
  function stop(entry: Entry): Promise<StopConfirmation> {
    entry.stopRequested = true;
    entry.adapter?.invalidateCatalogue();
    if (entry.terminal === 'ended') return Promise.resolve({ status: 'already_finished' });
    if (entry.stopping) return entry.stopping;
    const task = (async (): Promise<StopConfirmation> => {
      if (!entry.transport) return { status: 'unknown' };
      let confirmation: StopConfirmation;
      try {
        confirmation = await entry.transport.stop();
      } catch {
        confirmation = { status: 'unknown' };
      }
      if (['stopped', 'already_finished'].includes(confirmation.status)) {
        await entry.adapter?.close();
        end(entry, 'ended');
      }
      return confirmation;
    })();
    entry.stopping = task;
    void task.finally(() => {
      if (entry.stopping === task) entry.stopping = undefined;
    });
    return task;
  }
  async function waitReady(
    ref: OperationRef,
    signal: AbortSignal,
    operations: ActionContext['operations'],
  ) {
    const executionId = ref.executionId!;
    if (!starting.has(executionId)) starting.set(executionId, deferred<Entry>());
    const source = entries.has(executionId)
      ? Promise.resolve(entries.get(executionId)!)
      : starting.get(executionId)!.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const observation = new AbortController();
    try {
      return await Promise.race([
        source.then(async (entry) => {
          await entry.ready.promise;
          return entry;
        }),
        ...(typeof operations.wait === 'function'
          ? [
              operations
                .wait(ref, {
                  signal: AbortSignal.any([signal, observation.signal]),
                  timeoutMs: timeout,
                })
                .then(() => {
                  throw new McpAdapterError('mcp_connection_unavailable');
                }),
            ]
          : []),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new McpAdapterError('mcp_ready_timeout')), timeout);
          abort = () => reject(new McpAdapterError('mcp_cancelled_before_ready'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
      observation.abort();
    }
  }
  const createConnectionJob = (staticServer?: Server): JobDefinition => ({
    id: staticServer ? `mcp.connection.${staticServer.id}` : mcpSourceConnectionJobId,
    version: staticServer?.configDigest ?? '1',
    description: 'Own one scoped MCP transport; opening requires ordinary Job permission',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'serverId',
        'configDigest',
        'originStoreId',
        'key',
        'bootstrapId',
        ...(!staticServer ? ['captureDigest', 'parentExecutionId', 'parentInputDigest'] : []),
      ],
      properties: {
        serverId: staticServer ? { const: staticServer.id } : inputSchema.properties.serverId,
        configDigest: staticServer
          ? { const: staticServer.configDigest }
          : bindingProperties.configDigest,
        originStoreId: { type: 'string' },
        bootstrapId: { type: 'string' },
        key: inputSchema.properties.key,
        ...(!staticServer
          ? {
              captureDigest: bindingProperties.configDigest,
              parentExecutionId: { type: 'string', minLength: 1, maxLength: 256 },
              parentInputDigest: bindingProperties.configDigest,
            }
          : {}),
      },
    },
    ...(!staticServer || staticServer.transport.type === 'stdio'
      ? { resources: { slot: 'process' as const } }
      : {}),
    async start(input, context) {
      const value = input as {
        serverId: string;
        configDigest: string;
        originStoreId: string;
        key: string;
        bootstrapId: string;
        captureDigest?: string;
        parentExecutionId?: string;
        parentInputDigest?: string;
      };
      const prepare = async () => {
        if (closed) throw new McpAdapterError('mcp_transport_unavailable');
        const admission = admitted.get(value.bootstrapId);
        const server = staticServer ?? admission?.server;
        const source = staticServer ? undefined : admission?.source;
        const jobPort = source?.transportPort ?? port;
        if (!server || !jobPort) throw new McpAdapterError('mcp_bootstrap_unavailable');
        if (value.serverId !== server.id || value.configDigest !== server.configDigest)
          throw new McpAdapterError('mcp_catalogue_stale');
        if (
          !admission ||
          admission.storeId !== value.originStoreId ||
          admission.sessionId !== context.sessionId ||
          admission.serverId !== server.id ||
          admission.key !== value.key
        )
          throw new McpAdapterError('mcp_bootstrap_unavailable');
        if (
          !staticServer &&
          (!source ||
            source.captureDigest !== value.captureDigest ||
            admission.parentExecutionId !== value.parentExecutionId ||
            admission.parentInputDigest !== value.parentInputDigest)
        )
          throw new McpAdapterError('mcp_bootstrap_unavailable');
        assertTicket(admission.ticket);
        await Promise.race([
          admission.ticket.openAllowed.promise,
          new Promise<never>((_resolve, reject) => {
            if (context.signal.aborted) {
              reject(context.signal.reason);
              return;
            }
            const abort = () => reject(context.signal.reason);
            context.signal.addEventListener('abort', abort, { once: true });
            void admission.ticket.openAllowed.promise.then(
              () => context.signal.removeEventListener('abort', abort),
              () => context.signal.removeEventListener('abort', abort),
            );
          }),
        ]);
        context.signal.throwIfAborted();
        assertTicket(admission.ticket);
        if (admission.ticket.bootstrapExecutionId !== context.executionId)
          throw new McpAdapterError('mcp_bootstrap_unavailable');
        admitted.delete(value.bootstrapId);
        if (entries.size >= 512) throw new McpAdapterError('mcp_scope_limit');
        const scopeId = scopeKey(value.originStoreId, context.sessionId, server.id);
        const existing = live.get(scopeId);
        if (existing && !existing.terminal)
          throw new McpAdapterError('mcp_connection_already_live');
        return { admission, server, source, jobPort, scopeId };
      };
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try {
        prepared = await prepare();
      } catch (error) {
        // Only this local preflight has run: neither an Entry nor an owned port was created.
        const ticket = [...tickets.values()].find(
          (candidate) =>
            candidate.bootstrapId === value.bootstrapId &&
            candidate.bootstrapExecutionId === context.executionId &&
            candidate.scope === scopeKey(value.originStoreId, context.sessionId, value.serverId),
        );
        if (
          !ticket?.verifyUnopened ||
          entries.has(context.executionId) ||
          unopened.has(context.executionId) ||
          ticket.newEntry?.executionId === context.executionId ||
          !(await ticket.verifyUnopened(context.sessionId, context.executionId, input))
        )
          throw error;
        if (unopened.size >= 512 || unopened.has(context.executionId))
          throw new McpAdapterError('mcp_scope_limit');
        const handle: JobHandle = {
          reference: { executionId: context.executionId, unopened: true },
        };
        unopened.set(context.executionId, {
          handle,
          code: error instanceof McpAdapterError ? error.code : 'mcp_bootstrap_unavailable',
        });
        return handle;
      }
      const { admission, server, source, jobPort, scopeId } = prepared;
      const entry: Entry = {
        epoch: ++holderEpoch,
        executionId: context.executionId,
        sessionId: context.sessionId,
        storeId: value.originStoreId,
        serverId: server.id,
        server,
        signal: context.signal,
        definitionId: staticServer ? `mcp.connection.${server.id}` : mcpSourceConnectionJobId,
        definitionVersion: staticServer ? server.configDigest : '1',
        ...(source ? { source } : {}),
        key: value.key,
        ready: deferred(),
        end: deferred(),
      };
      entries.set(context.executionId, entry);
      starting.get(context.executionId)?.resolve(entry);
      starting.delete(context.executionId);
      admission.ticket.newEntry = entry;
      live.set(scopeId, entry);
      let openingAttempted = false;
      try {
        context.signal.throwIfAborted();
        source?.assertFresh({ signal: context.signal });
        entry.adapter = createMcpAdapter({
          id: server.id,
          transport: server.transport,
          limits: server.limits,
          tasks: true,
          admitToolCall: async () => {
            await confirmPublication(entry);
            wireFresh(entry);
            if (tickets.has(scopeId)) throw new McpAdapterError('mcp_scope_transition_unconfirmed');
          },
          assertFresh: () => {
            // This local probe performs no RPC. Every Tool/Task wire then awaits admitToolCall;
            // explicit resource/prompt reads await confirmPublication in their leaf adapter.
            wireFresh(entry, true);
            source?.assertFresh({ signal: context.signal });
          },
          createTransport: async () => {
            source?.assertFresh({ signal: context.signal });
            assertTicket(admission.ticket);
            if (admission.ticket.newEntry !== entry)
              throw new McpAdapterError('mcp_holder_changed');
            openingAttempted = true;
            entry.transport = await jobPort.open(
              Object.freeze({
                serverId: server.id,
                scopeId,
                sessionId: context.sessionId,
                executionId: context.executionId,
                configDigest: server.configDigest,
                originalStoreId: value.originStoreId,
                configuration: structuredClone(server.transport),
              }),
              { signal: context.signal },
            );
            void entry.transport.stopped.then(
              (value) => end(entry, value.supervision),
              () => end(entry, 'unknown'),
            );
            if (
              closed ||
              entry.stopRequested ||
              context.signal.aborted ||
              tickets.get(admission.ticket.scope) !== admission.ticket ||
              admission.ticket.mode === 'quarantined'
            ) {
              // A stop may have arrived before there was a handle. Collect the actual late handle
              // before the SDK starts it, and retain unknown supervision if stop is unconfirmed.
              await stop(entry);
              throw new McpAdapterError('mcp_connection_stopped_before_ready');
            }
            return entry.transport.transport;
          },
        });
        entry.scope = entry.adapter.scope(scopeId);
        // Discovery belongs to the admitted opening; later cached calls use wireFresh.
        await entry.scope.snapshotTools();
        assertTicket(admission.ticket);
        context.signal.throwIfAborted();
        if (closed || entry.stopRequested || entry.terminal)
          throw new McpAdapterError('mcp_connection_unavailable');
        entry.ready.resolve();
        return {
          reference: {
            executionId: context.executionId,
            serverId: server.id,
            scopeId,
            configDigest: server.configDigest,
          },
        };
      } catch (error) {
        entry.failureCode = error instanceof McpAdapterError ? error.code : 'mcp_connection_failed';
        entry.ready.reject(new McpAdapterError(entry.failureCode));
        if (source && !openingAttempted) {
          // This local source fence ran before the owned port was ever invoked. No handle exists.
          end(entry, 'ended');
        } else {
          const confirmation = await stop(entry);
          if (!entry.transport && confirmation.status === 'unknown') end(entry, 'unknown');
        }
        // Preserve a real owned handle even when discovery failed; later exact cancel can retry stop.
        return {
          reference: {
            executionId: context.executionId,
            serverId: server.id,
            scopeId,
            configDigest: server.configDigest,
          },
        };
      }
    },
    async *observe(handle) {
      const neverOpened = unopened.get(String(object(handle.reference).executionId));
      if (neverOpened?.handle === handle) {
        yield {
          type: 'terminal',
          result: {
            outcome: 'failed',
            content: neverOpened.code,
            details: { transportStopped: true, remoteToolStopConfirmed: false },
          },
          supervision: 'ended',
        };
        return;
      }
      const entry = entries.get((handle.reference as { executionId: string }).executionId);
      if (!entry) {
        yield {
          type: 'terminal',
          result: { outcome: 'outcome_unknown', content: 'mcp_handle_unavailable' },
          supervision: 'unknown',
        };
        return;
      }
      yield {
        type: 'progress',
        value: { ready: !entry.failureCode && !entry.terminal, serverId: entry.serverId },
      };
      const supervision = await entry.end.promise;
      yield {
        type: 'terminal',
        result: {
          outcome:
            supervision === 'ended'
              ? entry.failureCode
                ? 'failed'
                : 'cancelled'
              : 'outcome_unknown',
          content: entry.failureCode ?? 'MCP owned transport ended',
          details: { transportStopped: supervision === 'ended', remoteToolStopConfirmed: false },
        },
        supervision,
      };
    },
    async cancel(handle) {
      const neverOpened = unopened.get(String(object(handle.reference).executionId));
      if (neverOpened?.handle === handle) return { status: 'already_finished' };
      const entry = entries.get((handle.reference as { executionId: string }).executionId);
      return entry ? stop(entry) : { status: 'unknown' };
    },
    async dispose(handle) {
      const id = String(object(handle.reference).executionId);
      if (unopened.get(id)?.handle === handle) {
        unopened.delete(id);
        return;
      }
      const entry = entries.get((handle.reference as { executionId: string }).executionId);
      if (entry?.terminal === 'ended') await entry.scope?.release();
    },
  });
  const jobs: JobDefinition[] = [...servers.values()].map(createConnectionJob);
  if (options.scopedSources) jobs.push(createConnectionJob());
  async function safeJobTerminal(context: ActionContext, ticket: Ticket) {
    try {
      if (!ticket.ref?.executionId || !ticket.jobInputDigest) return false;
      const n = await context.getExecution(ticket.ref.executionId);
      return (
        !!n &&
        n.id === ticket.ref.executionId &&
        n.kind === 'job' &&
        n.parentExecutionId === ticket.executionId &&
        n.originCommandId === ticket.ref.commandId &&
        n.originStoreId === ticket.ref.originStoreId &&
        n.sessionId === ticket.ref.sessionId &&
        n.inputDigest === ticket.jobInputDigest &&
        n.definitionId === ticket.jobDefinitionId &&
        n.definitionVersion === ticket.jobDefinitionVersion &&
        n.rootWorkCommandId === ticket.rootWorkCommandId &&
        n.rootWorkSeq === ticket.rootWorkSeq &&
        stoppedOrUnopened(n)
      );
    } catch {
      return false;
    }
  }
  async function releaseStoppedOpening(
    context: ActionContext,
    storeId: string,
    sessionId: string,
    serverId: string,
  ) {
    const scope = scopeKey(storeId, sessionId, serverId);
    const ticket = tickets.get(scope);
    if (
      !ticket?.releaseAfterStoppedOpening ||
      ticket.mode !== 'quarantined' ||
      ticket.completed ||
      !ticket.ref?.executionId ||
      closed ||
      context.signal.aborted
    )
      return;
    const identity = () =>
      proofHash({
        scope: ticket.scope,
        epoch: ticket.epoch,
        executionId: ticket.executionId,
        inputDigest: ticket.inputDigest,
        ref: ticket.ref as unknown as Json,
        bootstrapId: ticket.bootstrapId ?? null,
        bootstrapExecutionId: ticket.bootstrapExecutionId ?? null,
        jobInputDigest: ticket.jobInputDigest ?? null,
        jobDefinitionId: ticket.jobDefinitionId ?? null,
        jobDefinitionVersion: ticket.jobDefinitionVersion ?? null,
        rootWorkCommandId: ticket.rootWorkCommandId ?? null,
        rootWorkSeq: ticket.rootWorkSeq ?? null,
      });
    const originalIdentity = identity();
    const entry = ticket.newEntry;
    const entryStopped = () =>
      entry
        ? ticket.newEntry === entry &&
          entries.get(ticket.ref!.executionId!) === entry &&
          live.get(scope) === entry &&
          entry.terminal === 'ended'
        : !ticket.newEntry &&
          !entries.has(ticket.ref!.executionId!) &&
          live.get(scope) === ticket.holder;
    if (!entryStopped()) return;
    const parent = await context.getExecution(ticket.executionId);
    if (
      !parent ||
      parent.id !== ticket.executionId ||
      parent.originStoreId !== storeId ||
      parent.sessionId !== sessionId ||
      parent.inputDigest !== ticket.inputDigest ||
      !['tool', 'job'].includes(parent.kind) ||
      !['mcp.connect', `${mcpLifecycleExtensionId}/mcp.connect`].includes(
        parent.definitionId ?? '',
      ) ||
      parent.definitionVersion !== '1' ||
      !['failed', 'cancelled', 'outcome_unknown'].includes(parent.status) ||
      !(await safeJobTerminal(context, ticket))
    )
      return;
    if (
      closed ||
      context.signal.aborted ||
      tickets.get(scope) !== ticket ||
      ticket.mode !== 'quarantined' ||
      !ticket.releaseAfterStoppedOpening ||
      ticket.completed ||
      identity() !== originalIdentity ||
      !entryStopped()
    )
      return;
    tickets.delete(scope);
    if (ticket.bootstrapId && admitted.get(ticket.bootstrapId)?.ticket === ticket)
      admitted.delete(ticket.bootstrapId);
  }
  async function connect(input: Json, context: ActionContext): Promise<ToolResult> {
    const request = input as { serverId: string; key: string };
    const own = await context.getExecution(context.executionId);
    if (
      !own?.originStoreId ||
      !own.inputDigest ||
      own.sessionId !== context.sessionId ||
      own.definitionVersion !== '1' ||
      !['tool', 'job'].includes(own.kind) ||
      !['mcp.connect', `${mcpLifecycleExtensionId}/mcp.connect`].includes(own.definitionId ?? '') ||
      own.inputDigest !== proofHash(input)
    )
      return {
        outcome: 'failed',
        content: 'operation_unverifiable',
        details: { adapterAttempted: false },
      };
    let ticket: Ticket;
    try {
      await confirmScopePublication(own.originStoreId, context.sessionId, request.serverId);
      await releaseStoppedOpening(context, own.originStoreId, context.sessionId, request.serverId);
      ticket = claim(
        own.originStoreId,
        context.sessionId,
        request.serverId,
        own.id,
        own.inputDigest,
        'opening',
      );
    } catch (error) {
      return {
        outcome: 'failed',
        content: error instanceof McpAdapterError ? error.code : 'mcp_connection_unavailable',
        details: { adapterAttempted: false },
      };
    }
    try {
      const result = await connectCore(input, context, ticket);
      ticket.completed = result.outcome === 'succeeded';
      return result;
    } finally {
      if (tickets.get(ticket.scope) === ticket) {
        const settled = await safeJobTerminal(context, ticket);
        if (ticket.ensureAttempted && !ticket.completed && !settled) {
          ticket.mode = 'quarantined';
          ticket.releaseAfterStoppedOpening = true;
        } else {
          tickets.delete(ticket.scope);
          if (ticket.bootstrapId) admitted.delete(ticket.bootstrapId);
        }
        if (!ticket.completed)
          ticket.openAllowed.reject(new McpAdapterError('mcp_connection_unavailable'));
      }
    }
  }
  async function connectCore(
    input: Json,
    context: ActionContext,
    ticket: Ticket,
    replacement?: { server: Server; source?: McpScopedSourceResolution },
  ): Promise<ToolResult> {
    if (closed || (!port && !options.scopedSources))
      return {
        outcome: 'failed',
        content: 'mcp_transport_unavailable',
        details: { adapterAttempted: false },
      };
    const request = input as { serverId: string; key: string };
    const own = await context.getExecution(context.executionId);
    if (!own?.originStoreId) return { outcome: 'failed', content: 'operation_unverifiable' };
    let server = replacement?.server ?? servers.get(request.serverId);
    let source: McpScopedSourceResolution | undefined = replacement?.source;
    if (!server && !replacement && options.scopedSources) {
      try {
        if (
          own.id !== context.executionId ||
          own.sessionId !== context.sessionId ||
          own.definitionVersion !== '1' ||
          !['mcp.connect', `${mcpLifecycleExtensionId}/mcp.connect`].includes(
            own.definitionId ?? '',
          ) ||
          !own.inputDigest
        )
          throw new McpAdapterError('operation_unverifiable');
        source = await options.scopedSources.resolve(
          {
            serverId: request.serverId,
            sessionId: context.sessionId,
            executionId: context.executionId,
          },
          { signal: context.signal },
        );
        const captured = freeze(structuredClone(source.server));
        if (
          captured.id !== request.serverId ||
          !/^[a-f0-9]{64}$/.test(source.captureDigest) ||
          (source.snapshotDigest !== undefined && !/^[a-f0-9]{64}$/.test(source.snapshotDigest))
        )
          throw new McpAdapterError('mcp_source_unavailable');
        server = {
          ...captured,
          configDigest: createMcpAdapter(captured).getCatalogue().configDigest,
        };
        source.assertFresh({ signal: context.signal });
      } catch (error) {
        return {
          outcome: context.signal.aborted ? 'cancelled' : 'failed',
          content: error instanceof McpAdapterError ? error.code : 'mcp_source_unavailable',
          details: { adapterAttempted: false },
        };
      }
    }
    if (!server)
      return {
        outcome: 'failed',
        content: 'mcp_server_unavailable',
        details: { adapterAttempted: false },
      };
    assertTicket(ticket);
    const recordKey = `connection/${server.id}/${request.key}`;
    const prior = await context.records.get(recordKey);
    assertTicket(ticket);
    if (
      prior &&
      (prior.originStoreId !== own.originStoreId ||
        prior.sessionId !== context.sessionId ||
        prior.forkProvenance ||
        prior.contentType !== contentType ||
        prior.contentVersion !== 1 ||
        object(prior.value).serverId !== server.id ||
        object(prior.value).configDigest !== server.configDigest)
    )
      return { outcome: 'failed', content: 'operation_unverifiable' };
    let entry = live.get(scopeKey(own.originStoreId, context.sessionId, server.id));
    if (prior) {
      const original = (prior.value as { operationRef?: OperationRef }).operationRef;
      if (!entry || entry.terminal || !entry.ref || original?.executionId !== entry.ref.executionId)
        return {
          outcome: 'failed',
          content: 'mcp_historical_connection_unavailable',
          details: { adapterAttempted: false },
        };
    }
    if (entry?.terminal) entry = undefined;
    if (
      entry &&
      (entry.server.configDigest !== server.configDigest ||
        (entry.source?.snapshotDigest !== undefined && source?.snapshotDigest !== undefined
          ? entry.source.snapshotDigest !== source.snapshotDigest
          : entry.source?.captureDigest !== source?.captureDigest))
    )
      return {
        outcome: 'failed',
        content: 'mcp_source_stale',
        details: { adapterAttempted: false },
      };
    let ref = entry?.ref;
    if (!ref) {
      if (entries.size >= 512 || starting.size >= 512 || admitted.size >= 512)
        return {
          outcome: 'failed',
          content: 'mcp_scope_limit',
          details: { adapterAttempted: false },
        };
      const bootstrapId = randomUUID();
      assertTicket(ticket);
      ticket.bootstrapId = bootstrapId;
      admitted.set(bootstrapId, {
        ticket,
        storeId: own.originStoreId,
        sessionId: context.sessionId,
        serverId: server.id,
        key: request.key,
        ...(source
          ? { source, server, parentExecutionId: own.id, parentInputDigest: own.inputDigest! }
          : {}),
      });
      try {
        const jobInput: Json = {
          serverId: server.id,
          configDigest: server.configDigest,
          originStoreId: own.originStoreId,
          key: request.key,
          bootstrapId,
          ...(source
            ? {
                captureDigest: source.captureDigest,
                parentExecutionId: own.id,
                parentInputDigest: own.inputDigest!,
              }
            : {}),
        };
        ticket.jobInputDigest = proofHash(jobInput);
        ticket.jobDefinitionId = source ? mcpSourceConnectionJobId : `mcp.connection.${server.id}`;
        ticket.jobDefinitionVersion = source ? '1' : server.configDigest;
        ticket.rootWorkCommandId = own.rootWorkCommandId;
        ticket.rootWorkSeq = own.rootWorkSeq;
        ticket.ensureAttempted = true;
        ref = await context.operations.ensure({
          key: recordKey,
          cancellation: 'detached',
          request: {
            kind: 'job',
            definitionId: ticket.jobDefinitionId,
            definitionVersion: ticket.jobDefinitionVersion,
            input: jobInput,
          },
        });
        assertTicket(ticket);
        if (
          !ref.executionId ||
          ref.sessionId !== context.sessionId ||
          ref.originStoreId !== own.originStoreId ||
          ref.extensionId !== mcpLifecycleExtensionId ||
          ref.key !== recordKey
        )
          throw new McpAdapterError('operation_unverifiable');
        ticket.ref = ref;
        ticket.bootstrapExecutionId = ref.executionId;
        const originalRef = structuredClone(ref);
        const originalJobInputDigest = ticket.jobInputDigest;
        const originalJobDefinitionId = ticket.jobDefinitionId;
        const originalJobDefinitionVersion = ticket.jobDefinitionVersion;
        ticket.verifyUnopened = async (sessionId, executionId, originalInput) => {
          if (
            ticket.bootstrapId !== bootstrapId ||
            ticket.bootstrapExecutionId !== executionId ||
            originalRef.executionId !== executionId ||
            originalRef.sessionId !== sessionId ||
            originalRef.originStoreId !== own.originStoreId ||
            originalRef.extensionId !== mcpLifecycleExtensionId ||
            originalRef.key !== recordKey ||
            ticket.jobInputDigest !== originalJobInputDigest ||
            proofHash(originalInput) !== originalJobInputDigest ||
            entries.has(executionId)
          )
            return false;
          const actual = await context.getExecution(executionId);
          return (
            !!actual &&
            actual.id === executionId &&
            actual.kind === 'job' &&
            actual.originCommandId === originalRef.commandId &&
            actual.originStoreId === own.originStoreId &&
            actual.sessionId === sessionId &&
            actual.runId === own.runId &&
            actual.parentExecutionId === own.id &&
            actual.rootWorkCommandId === own.rootWorkCommandId &&
            actual.rootWorkSeq === own.rootWorkSeq &&
            actual.definitionId === originalJobDefinitionId &&
            actual.definitionVersion === originalJobDefinitionVersion &&
            actual.inputDigest === originalJobInputDigest &&
            ['dispatching', 'running'].includes(actual.status) &&
            !entries.has(executionId)
          );
        };
        await ticket.onRef?.(ref);
        ticket.openAllowed.resolve();
      } catch (error) {
        ticket.openAllowed.reject(error);
        admitted.delete(bootstrapId);
        throw error;
      }
      try {
        entry = await waitReady(ref, context.signal, context.operations);
      } catch (error) {
        return {
          outcome: 'failed',
          content: error instanceof McpAdapterError ? error.code : 'mcp_connection_unavailable',
          details: { operationRef: ref as unknown as Json, ready: false, stopConfirmed: false },
        };
      }
      entry.ref = ref;
    }
    assertTicket(ticket);
    source?.assertFresh({ signal: context.signal });
    if (
      !entry?.scope ||
      entry.stopRequested ||
      entry.terminal ||
      !entry.adapter?.getCatalogue().available
    )
      return { outcome: 'failed', content: 'mcp_connection_unavailable' };
    wireFresh(entry);
    const metadata = entry.adapter.getToolsMetadata();
    const catalogue = {
      configDigest: metadata.configDigest,
      generation: metadata.generation,
      definitions: metadata.tools.map((tool) => ({
        id: tool.definitionId,
        version: tool.definitionVersion,
      })),
    };
    const value: Json = prior
      ? structuredClone(prior.value)
      : {
          originalStoreId: own.originStoreId,
          serverId: server.id,
          configDigest: catalogue.configDigest,
          generation: catalogue.generation,
          definitions: catalogue.definitions,
          operationRef: ref as unknown as Json,
        };
    if (!prior)
      await context.records.write({
        key: recordKey,
        expectedRevision: null,
        contentType,
        contentVersion: 1,
        executable: true,
        value,
      });
    if (!prior) {
      try {
        const snapshot = await publishToolsSnapshot(
          context,
          recordKey,
          ref!.executionId!,
          metadata,
        );
        return {
          outcome: 'succeeded',
          content: 'MCP catalogue ready; remote calls still require ordinary permission',
          details: {
            ...object(value),
            toolsMetadata: {
              recordKey: snapshot.recordKey,
              availability: snapshot.availability,
              reason: snapshot.reason,
            },
          },
        };
      } catch {
        return {
          outcome: 'outcome_unknown',
          content: 'mcp_tools_record_persistence_unconfirmed',
          details: { ...object(value), adapterAttempted: true, remoteStopConfirmed: false },
        };
      }
    }
    return {
      outcome: 'succeeded',
      content: 'MCP catalogue ready; remote calls still require ordinary permission',
      details: value,
    };
  }
  async function reconnect(raw: Json, context: ActionContext): Promise<ToolResult> {
    const input = decodeReconnectionInput(raw);
    const own = await context.getExecution(context.executionId);
    if (
      !own?.originStoreId ||
      own.sessionId !== context.sessionId ||
      own.definitionId !== `${mcpLifecycleExtensionId}/${reconnectionId}` ||
      own.definitionVersion !== '1' ||
      own.kind !== 'job' ||
      own.inputDigest !== proofHash(input)
    )
      throw new McpAdapterError('operation_unverifiable');
    let ticket: Ticket | undefined,
      stage: ReconnectionStage | undefined,
      revision: string | null = null;
    let stopAttempted = false,
      stopConfirmed = false;
    const details = () => ({
      originalStoreId: own.originStoreId!,
      serverId: input.serverId,
      target: input.target,
      oldStop: stage?.oldStop ?? null,
      stopAttempted,
      newConnectionAttempted: ticket?.ensureAttempted === true,
      newOperationRef: stage?.newOperationRef ?? null,
      catalogue: stage?.catalogue ?? null,
    });
    const persist = async (next: ReconnectionStage['stage']) => {
      if (!stage) throw new McpAdapterError('mcp_reconnection_unconfirmed');
      stage = { ...stage, stage: next };
      const receipt = await context.records.write({
        key: `reconnection/${own.id}`,
        expectedRevision: revision,
        contentType: reconnectionType,
        contentVersion: 1,
        executable: true,
        value: stage as unknown as Json,
      });
      revision = receipt.revision;
    };
    try {
      context.signal.throwIfAborted();
      const observed = live.get(scopeKey(own.originStoreId, context.sessionId, input.serverId));
      const observedAdapter = observed?.adapter;
      if (observed) await confirmPublication(observed);
      const old = await proveCarrier(
        context,
        input.target.carrierExecutionId,
        input.target.carrierKey,
        input.serverId,
      );
      if (
        !observed?.scope ||
        !observedAdapter ||
        observed.terminal ||
        observed.stopRequested ||
        observed.executionId !== input.target.connectionExecutionId ||
        !proofEqual(observed.ref, input.target.operationRef) ||
        !proofEqual(old.ref, input.target.operationRef) ||
        old.catalogue.configDigest !== input.target.configDigest ||
        old.connection.id !== observed.executionId ||
        !['running', 'dispatching'].includes(old.connection.status) ||
        observedAdapter.getCatalogue().generation !== input.target.currentGeneration ||
        !observedAdapter.getCatalogue().available
      )
        throw new McpAdapterError('mcp_reconnection_target_stale');
      let source: McpScopedSourceResolution | undefined, server: Server | undefined;
      if (input.replacement.kind === 'static') server = servers.get(input.serverId);
      else {
        if (servers.has(input.serverId) || !options.scopedSources?.resolveReplacement)
          throw new McpAdapterError('mcp_source_unavailable');
        source = await options.scopedSources.resolveReplacement(
          {
            serverId: input.serverId,
            sessionId: context.sessionId,
            executionId: own.id,
            expectedConfigDigest: input.replacement.expectedConfigDigest,
            expectedReadSet: input.replacement.expectedReadSet,
          },
          { signal: context.signal },
        );
        const captured = freeze(structuredClone(source.server));
        if (
          captured.id !== input.serverId ||
          !/^[a-f0-9]{64}$/.test(source.captureDigest) ||
          (source.snapshotDigest !== undefined && !/^[a-f0-9]{64}$/.test(source.snapshotDigest))
        )
          throw new McpAdapterError('mcp_source_unavailable');
        source.assertFresh({ signal: context.signal });
        server = {
          ...captured,
          configDigest: createMcpAdapter(captured).getCatalogue().configDigest,
        };
      }
      if (
        !server ||
        server.configDigest !== input.replacement.expectedConfigDigest ||
        (!source && !port)
      )
        throw new McpAdapterError('mcp_source_stale');
      context.signal.throwIfAborted();
      if (await context.records.get(`connection/${input.serverId}/${input.key}`))
        throw new McpAdapterError('mcp_result_already_recorded');
      ticket = claim(
        own.originStoreId,
        context.sessionId,
        input.serverId,
        own.id,
        own.inputDigest,
        'replacing',
      );
      if (ticket.holder !== observed) throw new McpAdapterError('mcp_holder_changed');
      const checked = await proveCarrier(
        context,
        input.target.carrierExecutionId,
        input.target.carrierKey,
        input.serverId,
      );
      assertTicket(ticket);
      if (
        checked.record.revision !== old.record.revision ||
        !proofEqual(checked.ref, input.target.operationRef) ||
        observedAdapter.getCatalogue().generation !== input.target.currentGeneration
      )
        throw new McpAdapterError('mcp_reconnection_target_stale');
      stage = {
        version: 1,
        originalStoreId: own.originStoreId,
        sessionId: context.sessionId,
        executionId: own.id,
        input,
        inputDigest: own.inputDigest,
        targetRecordKey: old.record.key,
        targetRecordRevision: old.record.revision,
        stage: 'prepared',
        oldStop: null,
        newOperationRef: null,
        catalogue: null,
      };
      await persist('prepared');
      assertTicket(ticket);
      source?.assertFresh({ signal: context.signal });
      context.signal.throwIfAborted();
      stopAttempted = true;
      const confirmation = await stop(observed);
      if (!['stopped', 'already_finished'].includes(confirmation.status))
        throw new McpAdapterError('mcp_reconnection_stop_unconfirmed');
      await context.operations.wait(old.ref, { signal: context.signal, timeoutMs: timeout });
      const terminal = await context.getExecution(observed.executionId);
      if (!terminal) throw new McpAdapterError('mcp_reconnection_stop_unconfirmed');
      stage.oldStop = {
        connectionExecutionId: terminal.id,
        resultRevision: terminal.resultRevision,
        resultDigest: proofHash(terminal.result),
      };
      await confirmedStop(context, input, stage.oldStop);
      await persist('old_stopped');
      stopConfirmed = true;
      assertTicket(ticket);
      source?.assertFresh({ signal: context.signal });
      context.signal.throwIfAborted();
      ticket.mode = 'opening';
      ticket.onRef = async (ref) => {
        if (
          !stage ||
          !ref.executionId ||
          !proofEqual(ref, {
            commandId: ref.commandId,
            sessionId: context.sessionId,
            originStoreId: own.originStoreId,
            extensionId: mcpLifecycleExtensionId,
            key: `connection/${input.serverId}/${input.key}`,
            executionId: ref.executionId,
          })
        )
          throw new McpAdapterError('operation_unverifiable');
        stage.newOperationRef = ref as McpReconnectionInput['target']['operationRef'];
        await persist('new_planned');
      };
      const result = await connectCore(
        { serverId: input.serverId, key: input.key },
        context,
        ticket,
        { server, source },
      );
      if (result.outcome !== 'succeeded')
        throw new McpAdapterError('mcp_reconnection_new_unconfirmed');
      const catalogue = { ...proofObject(result.details) };
      const metadata = catalogue.toolsMetadata;
      delete catalogue.toolsMetadata;
      stage.catalogue = catalogue as Json;
      await persist('ready');
      const publishedEntry = ticket.newEntry;
      if (!publishedEntry || !stage.newOperationRef)
        throw new McpAdapterError('mcp_reconnection_unconfirmed');
      const originalInputDigest = own.inputDigest;
      const originalRef = structuredClone(stage.newOperationRef);
      const originalCatalogue = structuredClone(stage.catalogue);
      publishedEntry.confirmPublication = async () => {
        if (!context.readExecutionGroupSafety)
          throw new McpAdapterError('mcp_reconnection_scope_unavailable');
        const safety = await context.readExecutionGroupSafety();
        if (safety.originStoreId !== own.originStoreId)
          throw new McpAdapterError('mcp_reconnection_scope_unavailable');
        const proof = await proveCarrier(context, own.id, input.key, input.serverId);
        if (
          proof.e.originStoreId !== publishedEntry.storeId ||
          proof.e.sessionId !== publishedEntry.sessionId ||
          proof.e.inputDigest !== originalInputDigest ||
          !proofEqual(proof.ref, originalRef) ||
          !proofEqual(proof.catalogue, originalCatalogue) ||
          proof.connection.id !== publishedEntry.executionId ||
          proof.connection.parentExecutionId !== own.id ||
          !['dispatching', 'running'].includes(proof.connection.status) ||
          !proofEqual(publishedEntry.ref, originalRef)
        )
          throw new McpAdapterError('mcp_reconnection_scope_unavailable');
      };
      ticket.completed = true;
      ticket.mode = 'publishing';
      return {
        outcome: 'succeeded',
        content: 'MCP replacement ready; remote calls still require ordinary permission',
        details: {
          ...details(),
          ...(metadata === undefined ? {} : { toolsMetadata: metadata }),
        } as unknown as Json,
      };
    } catch (error) {
      if (ticket?.ensureAttempted && stage?.newOperationRef) {
        ticket.openAllowed.reject(error);
        ticket.safeTerminal = await safeJobTerminal(context, ticket);
      }
      const knownNoNew = !ticket?.ensureAttempted || ticket.safeTerminal === true;
      const knownStop = stopConfirmed;
      const outcome: ToolResult['outcome'] =
        (!stopAttempted || knownStop) && knownNoNew
          ? context.signal.aborted
            ? 'cancelled'
            : 'failed'
          : 'outcome_unknown';
      if (stage) {
        try {
          await persist(outcome === 'outcome_unknown' ? 'outcome_unknown' : 'failed');
        } catch {
          if (ticket) ticket.mode = 'quarantined';
          return {
            outcome: 'outcome_unknown',
            content: 'mcp_reconnection_persistence_unconfirmed',
            details: details() as unknown as Json,
          };
        }
      }
      return {
        outcome,
        content: error instanceof McpAdapterError ? error.code : 'mcp_reconnection_unconfirmed',
        details: details() as unknown as Json,
      };
    } finally {
      if (ticket && tickets.get(ticket.scope) === ticket) {
        if (
          ticket.mode === 'quarantined' ||
          (stopAttempted && !stopConfirmed) ||
          (ticket.ensureAttempted && !ticket.completed && !ticket.safeTerminal)
        )
          ticket.mode = 'quarantined';
        else if (ticket.mode !== 'publishing') {
          tickets.delete(ticket.scope);
          if (ticket.bootstrapId) admitted.delete(ticket.bootstrapId);
        }
        if (!ticket.completed)
          ticket.openAllowed.reject(new McpAdapterError('mcp_reconnection_unconfirmed'));
      }
    }
  }
  async function refresh(input: Json, context: ActionContext): Promise<ToolResult> {
    const reject = (code: string): ToolResult => ({
      outcome: context.signal.aborted ? 'cancelled' : 'failed',
      content: code,
      details: { adapterAttempted: false },
    });
    if (closed) return reject('mcp_connection_unavailable');
    const request = freeze(structuredClone(object(input)));
    const own = await context.getExecution(context.executionId);
    if (
      !own?.originStoreId ||
      own.id !== context.executionId ||
      own.sessionId !== context.sessionId ||
      own.definitionVersion !== '1' ||
      ![refreshId, `${mcpLifecycleExtensionId}/${refreshId}`].includes(own.definitionId ?? '')
    )
      return reject('operation_unverifiable');
    const entry = live.get(
      scopeKey(own.originStoreId, context.sessionId, String(request.serverId)),
    );
    if (entry) {
      try {
        await confirmPublication(entry);
        wireFresh(entry);
      } catch {
        return reject('mcp_scope_transition_unconfirmed');
      }
    }
    const server = servers.get(String(request.serverId)) ?? entry?.server;
    if (!server || server.configDigest !== request.configDigest)
      return reject('mcp_catalogue_stale');
    const connection = await context.records.get(
      `connection/${server.id}/${request.connectionKey}`,
    );
    const saved = object(connection?.value);
    const originalRef = object(saved.operationRef);
    if (
      !connection ||
      connection.originStoreId !== own.originStoreId ||
      connection.sessionId !== context.sessionId ||
      connection.forkProvenance ||
      connection.contentType !== contentType ||
      connection.contentVersion !== 1 ||
      saved.originalStoreId !== own.originStoreId ||
      saved.serverId !== server.id ||
      saved.configDigest !== request.configDigest ||
      !Number.isSafeInteger(saved.generation) ||
      Number(saved.generation) > Number(request.generation) ||
      !entry?.scope ||
      entry.terminal ||
      !entry.ref ||
      entry.ref.executionId !== originalRef.executionId ||
      entry.executionId !== request.connectionExecutionId ||
      entry.storeId !== own.originStoreId ||
      entry.sessionId !== context.sessionId ||
      entry.adapter?.getCatalogue().generation !== request.generation ||
      !entry.adapter?.getCatalogue().available
    )
      return reject('mcp_historical_connection_unavailable');
    const actualConnection = await context.getExecution(entry.executionId);
    if (
      !actualConnection ||
      actualConnection.originStoreId !== own.originStoreId ||
      actualConnection.sessionId !== context.sessionId ||
      actualConnection.definitionId !== entry.definitionId ||
      actualConnection.definitionVersion !== entry.definitionVersion ||
      !['dispatching', 'running'].includes(actualConnection.status) ||
      originalRef.key !== entry.ref.key ||
      originalRef.commandId !== entry.ref.commandId ||
      originalRef.sessionId !== context.sessionId ||
      originalRef.originStoreId !== own.originStoreId ||
      originalRef.extensionId !== mcpLifecycleExtensionId
    )
      return reject('operation_unverifiable');

    const key = `refresh/${own.id}`;
    if (await context.records.get(key)) return reject('mcp_result_already_recorded');
    let result: ToolResult;
    let capturedRefresh: ReturnType<typeof entry.scope.captureRefresh>;
    try {
      capturedRefresh = entry.scope.captureRefresh(Number(request.generation));
      result = await capturedRefresh.execute({ signal: context.signal });
    } catch (error) {
      return reject(error instanceof McpAdapterError ? error.code : 'mcp_connection_unavailable');
    }
    if (result.outcome !== 'succeeded') return result;
    const value: Json = {
      originalStoreId: own.originStoreId,
      sessionId: context.sessionId,
      executionId: own.id,
      runId: own.runId,
      inputDigest: own.inputDigest ?? null,
      definitionId: own.definitionId!,
      definitionVersion: own.definitionVersion!,
      serverId: server.id,
      configDigest: server.configDigest,
      connectionKey: String(request.connectionKey),
      operationRef: originalRef,
      originalConnectionRevision: connection.revision,
      previousGeneration: Number(request.generation),
      ...object(result.details),
    };
    try {
      await context.records.write({
        key,
        expectedRevision: null,
        contentType: refreshContentType,
        contentVersion: 1,
        executable: true,
        value,
      });
    } catch {
      entry.adapter!.invalidateCatalogue();
      return {
        outcome: 'outcome_unknown',
        content: 'mcp_result_persistence_unconfirmed',
        details: { adapterAttempted: true, remoteStopConfirmed: false },
      };
    }
    try {
      const metadata = capturedRefresh.getToolsMetadata();
      if (!metadata || metadata.generation !== object(result.details).generation)
        throw new McpAdapterError('mcp_tools_metadata_unavailable');
      const snapshot = await publishToolsSnapshot(context, key, entry.executionId, metadata);
      return {
        ...result,
        details: {
          ...object(value),
          toolsMetadata: {
            recordKey: snapshot.recordKey,
            availability: snapshot.availability,
            reason: snapshot.reason,
          },
        },
      };
    } catch {
      return {
        outcome: 'outcome_unknown',
        content: 'mcp_tools_record_persistence_unconfirmed',
        details: { ...object(value), adapterAttempted: true, remoteStopConfirmed: false },
      };
    }
  }
  async function read(
    id: (typeof mcpReadToolIds)[number],
    input: Json,
    context: ActionContext,
  ): Promise<ToolResult> {
    const reject = (code: string): ToolResult => ({
      outcome: context.signal.aborted ? 'cancelled' : 'failed',
      content: code,
      details: { adapterAttempted: false },
    });
    if (closed) return reject('mcp_connection_unavailable');
    const request = freeze(structuredClone(object(input)));
    const own = await context.getExecution(context.executionId);
    if (
      !own?.originStoreId ||
      own.sessionId !== context.sessionId ||
      own.id !== context.executionId ||
      own.definitionVersion !== '1' ||
      ![id, `${mcpLifecycleExtensionId}/${id}`].includes(own.definitionId ?? '')
    )
      return reject('operation_unverifiable');
    const entry = live.get(
      scopeKey(own.originStoreId, context.sessionId, String(request.serverId)),
    );
    if (entry) {
      try {
        await confirmPublication(entry);
        wireFresh(entry);
      } catch {
        return reject('mcp_scope_transition_unconfirmed');
      }
    }
    const server = servers.get(String(request.serverId)) ?? entry?.server;
    if (!server || server.configDigest !== request.configDigest)
      return reject('mcp_catalogue_stale');
    const connection = await context.records.get(
      `connection/${server.id}/${request.connectionKey}`,
    );
    const saved = object(connection?.value);
    const originalRef = object(saved.operationRef);
    if (
      !connection ||
      connection.originStoreId !== own.originStoreId ||
      connection.sessionId !== context.sessionId ||
      connection.forkProvenance ||
      connection.contentType !== contentType ||
      connection.contentVersion !== 1 ||
      saved.originalStoreId !== own.originStoreId ||
      saved.serverId !== server.id ||
      saved.configDigest !== request.configDigest ||
      !Number.isSafeInteger(saved.generation) ||
      Number(saved.generation) > Number(request.generation) ||
      !entry?.scope ||
      entry.terminal ||
      !entry.ref ||
      entry.ref.executionId !== originalRef.executionId ||
      entry.storeId !== own.originStoreId ||
      entry.sessionId !== context.sessionId ||
      entry.adapter?.getCatalogue().generation !== request.generation ||
      !entry.adapter?.getCatalogue().available
    )
      return reject('mcp_historical_connection_unavailable');
    const actualConnection = await context.getExecution(entry.executionId);
    if (
      !actualConnection ||
      actualConnection.originStoreId !== own.originStoreId ||
      actualConnection.sessionId !== context.sessionId ||
      actualConnection.definitionId !== entry.definitionId ||
      actualConnection.definitionVersion !== entry.definitionVersion ||
      !['dispatching', 'running'].includes(actualConnection.status) ||
      originalRef.key !== entry.ref.key ||
      originalRef.commandId !== entry.ref.commandId ||
      originalRef.sessionId !== context.sessionId ||
      originalRef.originStoreId !== own.originStoreId ||
      originalRef.extensionId !== mcpLifecycleExtensionId
    )
      return reject('operation_unverifiable');
    const family = id.startsWith('mcp.resources.') ? 'resources' : 'prompts';
    const recordType = readContentTypes[family];
    const resultKey = `${family}/${own.id}`;
    // Core replay retains this Execution. An existing immutable result never starts another RPC.
    if (await context.records.get(resultKey)) return reject('mcp_result_already_recorded');
    const binding = freeze({
      originalStoreId: own.originStoreId,
      sessionId: context.sessionId,
      runId: own.runId,
      executionId: own.id,
      definitionId: own.definitionId!,
      definitionVersion: own.definitionVersion!,
      inputDigest: own.inputDigest ?? null,
      serverId: server.id,
      configDigest: server.configDigest,
      generation: Number(request.generation),
      connectionKey: String(request.connectionKey),
      connectionExecutionId: entry.executionId,
    });
    let rpc: McpReadRequest;
    if (id.endsWith('.list'))
      rpc = { method: family === 'resources' ? 'resources/list' : 'prompts/list' };
    else {
      const catalogueRecord = await context.records.get(
        `${family}/${request.catalogueExecutionId}`,
      );
      const catalogue = object(catalogueRecord?.value);
      const source = object(catalogue.binding);
      if (
        !catalogueRecord ||
        catalogueRecord.originStoreId !== own.originStoreId ||
        catalogueRecord.sessionId !== context.sessionId ||
        catalogueRecord.forkProvenance ||
        catalogueRecord.contentType !== recordType ||
        catalogueRecord.contentVersion !== 1 ||
        catalogue.kind !== 'list' ||
        source.executionId !== request.catalogueExecutionId ||
        source.originalStoreId !== own.originStoreId ||
        source.sessionId !== context.sessionId ||
        source.serverId !== server.id ||
        source.connectionExecutionId !== entry.executionId ||
        source.configDigest !== request.configDigest ||
        source.generation !== request.generation ||
        !Array.isArray(catalogue.descriptors)
      )
        return reject('mcp_catalogue_stale');
      const catalogueExecution = await context.getExecution(String(request.catalogueExecutionId));
      if (
        catalogueExecution?.status !== 'succeeded' ||
        catalogueExecution.originStoreId !== own.originStoreId ||
        catalogueExecution.sessionId !== context.sessionId ||
        catalogueExecution.runId !== source.runId ||
        catalogueExecution.definitionVersion !== '1' ||
        catalogueExecution.definitionId !== source.definitionId ||
        catalogueExecution.inputDigest !== source.inputDigest ||
        ![`mcp.${family}.list`, `${mcpLifecycleExtensionId}/mcp.${family}.list`].includes(
          catalogueExecution.definitionId ?? '',
        )
      )
        return reject('mcp_catalogue_stale');
      const target = catalogue.descriptors
        .map((value) => object(value))
        .find((descriptor) =>
          family === 'resources'
            ? descriptor.uri === request.uri
            : descriptor.name === request.name,
        );
      if (!target || digest(target) !== request.descriptorDigest)
        return reject('mcp_descriptor_stale');
      if (family === 'resources') rpc = { method: 'resources/read', uri: String(request.uri) };
      else {
        const args = object(request.arguments);
        const declared = Array.isArray(target.arguments)
          ? target.arguments.map((arg) => object(arg))
          : [];
        if (
          Object.keys(args).some(
            (name) => !declared.some((arg) => arg.name === name) || typeof args[name] !== 'string',
          ) ||
          declared.some(
            (arg) => arg.required === true && typeof args[String(arg.name)] !== 'string',
          )
        )
          return reject('mcp_arguments_invalid');
        rpc = {
          method: 'prompts/get',
          name: String(request.name),
          arguments: args as Record<string, string>,
        };
      }
    }
    let result: ToolResult;
    try {
      result = await entry.scope
        .captureRead(Number(request.generation))
        .execute(rpc, { signal: context.signal });
    } catch (error) {
      return reject(error instanceof McpAdapterError ? error.code : 'mcp_connection_unavailable');
    }
    if (result.outcome !== 'succeeded') return result;
    const raw = object(result.details).actualResult!;
    if (id.endsWith('.list')) {
      if (!Array.isArray(raw))
        return {
          outcome: 'outcome_unknown',
          content: 'mcp_output_invalid',
          details: { adapterAttempted: true },
        };
      const names = raw.map(
        (descriptor) => object(descriptor)[family === 'resources' ? 'uri' : 'name'],
      );
      if (
        names.some(
          (name) =>
            typeof name !== 'string' ||
            !name.length ||
            name.length > (family === 'resources' ? 8192 : 256),
        ) ||
        new Set(names).size !== names.length ||
        (family === 'prompts' &&
          raw.some((descriptor) => {
            const args = object(descriptor).arguments;
            if (args === undefined) return false;
            if (!Array.isArray(args) || args.length > 128) return true;
            const keys = args.map((arg) => object(arg).name);
            return (
              keys.some((name) => typeof name !== 'string' || !name.length || name.length > 256) ||
              new Set(keys).size !== keys.length
            );
          }))
      )
        return {
          outcome: 'outcome_unknown',
          content: 'mcp_output_invalid',
          details: { adapterAttempted: true },
        };
    }
    if (
      id === 'mcp.resources.read' &&
      (!Array.isArray(object(raw).contents) ||
        (object(raw).contents as Json[]).some((content) => object(content).uri !== request.uri))
    )
      return {
        outcome: 'outcome_unknown',
        content: 'mcp_resource_uri_unconfirmed',
        details: { adapterAttempted: true, remoteStopConfirmed: false },
      };
    // Remote role labels remain data inside this ordinary Tool body, never privileged instructions.
    const descriptors = id.endsWith('.list')
      ? (raw as Json[]).map((descriptor) => ({ descriptor, descriptorDigest: digest(descriptor) }))
      : undefined;
    const body = JSON.stringify({
      source: 'external_mcp_data',
      binding,
      request,
      result: raw,
      ...(descriptors ? { descriptors } : {}),
    });
    try {
      const large = Buffer.byteLength(body) > 8192;
      if (large && !context.artifacts)
        return {
          outcome: 'outcome_unknown',
          content: 'mcp_complete_body_unavailable',
          details: { adapterAttempted: true },
        };
      const artifact = large
        ? await context.artifacts!.publish({
            key: `mcp-read-${own.id}`,
            content: new TextEncoder().encode(body),
            mediaType: 'application/json; charset=utf-8',
          })
        : undefined;
      const value: Json = {
        kind: id.endsWith('.list') ? 'list' : family === 'resources' ? 'read' : 'get',
        binding,
        request,
        bodyBytes: Buffer.byteLength(body),
        ...(id.endsWith('.list')
          ? {
              descriptors: raw,
              descriptorDigests: descriptors!.map((value) => value.descriptorDigest),
              ...(artifact ? { resultArtifact: artifact as unknown as Json } : {}),
            }
          : artifact
            ? { resultArtifact: artifact as unknown as Json }
            : { result: raw }),
      };
      await context.records.write({
        key: `${family}/${own.id}`,
        expectedRevision: null,
        contentType: recordType,
        contentVersion: 1,
        executable: true,
        value,
      });
      return {
        outcome: 'succeeded',
        content: artifact ? 'Complete external MCP data in the original scoped artifact.' : body,
        details: {
          binding,
          recordKey: `${family}/${own.id}`,
          ...(id.endsWith('.list')
            ? {
                descriptors: (raw as Json[]).map((descriptor) => ({
                  descriptor,
                  descriptorDigest: digest(descriptor),
                })),
              }
            : {}),
        },
        ...(artifact
          ? {
              artifactRefs: [artifact],
              modelContent: { kind: 'artifact', reference: artifact, encoding: 'utf-8' },
            }
          : {}),
      };
    } catch {
      return {
        outcome: 'outcome_unknown',
        content: 'mcp_result_persistence_unconfirmed',
        details: { adapterAttempted: true, remoteStopConfirmed: false },
      };
    }
  }
  const extension: Extension = {
    id: mcpLifecycleExtensionId,
    version: '1',
    apiMajor: 1,
    jobs,
    tools: [
      {
        id: 'mcp.connect',
        version: '1',
        description: 'Explicitly admit one scoped MCP connection',
        inputSchema,
        execute: connect,
      },
      {
        id: refreshId,
        version: '1',
        description: 'Explicitly refresh the exact live MCP tool catalogue; never reconnect',
        inputSchema: refreshSchema,
        execute: refresh,
      },
      ...mcpReadToolIds.map((id) => ({
        id,
        version: '1',
        description:
          'Read external MCP data through the exact original live connection; independent ordinary permission required',
        inputSchema: readSchema(id),
        execute: (input: Json, context: ActionContext) => read(id, input, context),
      })),
    ],
    actions: [
      {
        id: reconnectionId,
        version: '1',
        description:
          'Explicitly stop the exact owned MCP connection before admitting a replacement',
        inputSchema: reconnectionInputSchema,
        prepare: async (input: Json) => decodeReconnectionInput(input) as unknown as Json,
        execute: reconnect,
      },
      {
        id: 'mcp.connect',
        version: '1',
        description: 'Explicitly admit one scoped MCP connection',
        inputSchema,
        async prepare(input) {
          return input;
        },
        execute: connect,
      },
      {
        id: refreshId,
        version: '1',
        description: 'Explicitly refresh the exact live MCP tool catalogue; never reconnect',
        inputSchema: refreshSchema,
        prepare: async (input: Json) => structuredClone(input),
        execute: refresh,
      },
      ...mcpReadToolIds.map((id) => ({
        id,
        version: '1',
        description:
          'Read external MCP data through the exact original live connection; independent ordinary permission required',
        inputSchema: readSchema(id),
        prepare: async (input: Json) => structuredClone(input),
        execute: (input: Json, context: ActionContext) => read(id, input, context),
      })),
    ],
    records: [
      contentType,
      refreshContentType,
      reconnectionType,
      toolsSnapshotType,
      ...Object.values(readContentTypes),
    ].map((contentType) => ({
      contentType,
      contentVersion: 1,
      schema: { type: 'object' },
    })),
    queries: [
      {
        id: 'mcp.reconnection',
        version: '1',
        outputSchema: { type: 'array' },
        description: 'Read one original forced reconnection; never reconnects',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['executionId'],
          properties: { executionId: bindingProperties.serverId },
        },
        async execute(input, context) {
          const originalId = String(object(input).executionId);
          const payload = await readReconnection(
            context,
            originalId,
            async (storeId, serverId, executionId, configDigest) => {
              const scope = scopeKey(storeId, context.sessionId, serverId);
              const entry = live.get(scope);
              if (
                !entry ||
                entry.executionId !== executionId ||
                entry.server.configDigest !== configDigest
              )
                return { live: false, generation: null };
              const ticket = tickets.get(scope);
              if (ticket?.mode === 'publishing' && ticket.executionId !== originalId)
                return { live: false, generation: null };
              try {
                await confirmPublication(entry);
                wireFresh(entry);
              } catch {
                return { live: false, generation: null };
              }
              const c = entry.adapter?.getCatalogue();
              return { live: !!c?.available, generation: c?.available ? c.generation : null };
            },
          );
          const result = [
            {
              extensionId: mcpLifecycleExtensionId,
              contentType: reconnectionType,
              contentVersion: 1,
              summary: 'Original forced reconnection; not permissions',
              payload: payload as unknown as Json,
              actions: [],
              artifactRefs: [],
            },
          ];
          if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024)
            throw new McpAdapterError('mcp_reconnection_metadata_limit');
          return result;
        },
      },
      {
        id: 'mcp.connection',
        version: '1',
        outputSchema: { type: 'array' },
        description: 'Read one original connection request; never connects',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['executionId', 'serverId', 'key'],
          properties: {
            executionId: bindingProperties.serverId,
            ...inputSchema.properties,
          },
        },
        async execute(input, context) {
          const payload = await readConnection(
            context,
            input as { executionId: string; serverId: string; key: string },
            (storeId, serverId, executionId, configDigest) => {
              const entry = live.get(scopeKey(storeId, context.sessionId, serverId));
              if (
                !entry ||
                entry.ref?.executionId !== executionId ||
                entry.server.configDigest !== configDigest ||
                entry.terminal ||
                !entry.adapter
              )
                return { live: false, generation: null };
              const catalogue = entry.adapter.getToolsMetadata();
              return {
                live: catalogue.available,
                generation: catalogue.available ? catalogue.generation : null,
              };
            },
          );
          const result = [
            {
              extensionId: mcpLifecycleExtensionId,
              contentType: 'builtin.mcp.connection',
              contentVersion: 1,
              summary: 'Original connection request; not permissions',
              payload: payload as unknown as Json,
              actions: [],
              artifactRefs: [],
            },
          ];
          if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024)
            throw new McpAdapterError('mcp_connection_limit');
          return result;
        },
      },
      {
        id: 'mcp.tools.snapshots',
        version: '1',
        description: 'Read original complete tool metadata snapshots without connecting',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            serverId: bindingProperties.serverId,
            afterKey: { type: 'string', maxLength: 256 },
            limit: { type: 'integer', minimum: 1, maximum: 32 },
          },
        },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          await admitToolsRead(context);
          const request = input as { serverId?: string; afterKey?: string; limit?: number };
          const limit = request.limit ?? 32;
          const records = await context.records.list({
            contentType: toolsSnapshotType,
            limit: limit + 1,
            ...(request.afterKey ? { afterKey: request.afterKey } : {}),
          });
          const items: Awaited<ReturnType<typeof readToolsSnapshot>>[] = [];
          let consumed = 0;
          for (const record of records.slice(0, limit)) {
            const snapshot = await readToolsSnapshot(context, record.key);
            if (!request.serverId || snapshot.origin.serverId === request.serverId) {
              if (
                Buffer.byteLength(
                  JSON.stringify({
                    version: 1,
                    sessionId: context.sessionId,
                    items: [...items, snapshot],
                    nextAfterKey: record.key,
                  }),
                ) >
                31 * 1024
              ) {
                if (!items.length) throw new McpAdapterError('mcp_tools_metadata_limit');
                break;
              }
              items.push(snapshot);
            }
            consumed++;
          }
          const nextAfterKey =
            consumed < records.length ? (records[consumed - 1]?.key ?? null) : null;
          return toolsView('builtin.mcp.tools.snapshots', {
            version: 1,
            sessionId: context.sessionId,
            items,
            nextAfterKey,
          } as unknown as Json);
        },
      },
      {
        id: 'mcp.tools',
        version: '1',
        description: 'Read an immutable tool metadata index page without connecting',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['recordKey', 'generation'],
          properties: {
            recordKey: { type: 'string', minLength: 1, maxLength: 256 },
            generation: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            indexDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            afterIndex: { type: 'integer', minimum: 0, maximum: 16384 },
            limit: { type: 'integer', minimum: 1, maximum: 32 },
          },
        },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          await admitToolsRead(context);
          const request = input as {
            recordKey: string;
            generation: number;
            indexDigest?: string;
            afterIndex?: number;
            limit?: number;
          };
          const snapshot = await readToolsSnapshot(context, request.recordKey);
          if (snapshot.origin.generation !== request.generation)
            throw new McpAdapterError('mcp_tools_generation_mismatch');
          const payload = await readToolsPage(
            context,
            snapshot,
            request.afterIndex ?? 0,
            request.limit ?? 32,
            request.indexDigest,
          );
          const entry = live.get(
            scopeKey(snapshot.origin.originStoreId, context.sessionId, snapshot.origin.serverId),
          );
          const current = entry?.adapter?.getCatalogue();
          if (
            !closed &&
            !entry?.terminal &&
            entry?.executionId === snapshot.origin.connectionExecutionId &&
            current?.available
          ) {
            payload.currentGeneration = current.generation;
            payload.live = current.generation === snapshot.origin.generation;
          }
          return toolsView('builtin.mcp.tools', payload as unknown as Json);
        },
      },
      ...(['resources', 'prompts'] as const).map((family) => ({
        id: `mcp.${family}`,
        version: '1',
        description: 'Read original cached external MCP data without connecting',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            serverId: bindingProperties.serverId,
            afterKey: { type: 'string', maxLength: 256 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        outputSchema: { type: 'array' },
        async execute(input: Json, context: import('../extensions').ReadContext) {
          const request = object(input);
          const limit = Number(request.limit ?? 100);
          const records = await context.records.list({
            limit: limit + 1,
            contentType: readContentTypes[family],
            ...(request.afterKey ? { afterKey: String(request.afterKey) } : {}),
          });
          const selected = records.slice(0, limit);
          return [
            {
              extensionId: mcpLifecycleExtensionId,
              contentType: readContentTypes[family],
              contentVersion: 1,
              summary:
                'Cached external MCP data; historical availability does not restore a connection',
              payload: {
                items: selected
                  .filter(
                    (record) =>
                      !request.serverId ||
                      object(object(record.value).binding).serverId === request.serverId,
                  )
                  .map((record) => {
                    const value = object(record.value),
                      binding = object(value.binding);
                    const entry = live.get(
                      scopeKey(
                        record.originStoreId ?? '',
                        context.sessionId,
                        String(binding.serverId),
                      ),
                    );
                    return {
                      key: record.key,
                      record: value,
                      live:
                        !closed &&
                        !record.forkProvenance &&
                        record.originStoreId === binding.originalStoreId &&
                        record.sessionId === binding.sessionId &&
                        !entry?.terminal &&
                        entry?.executionId === binding.connectionExecutionId &&
                        entry?.adapter?.getCatalogue().available === true &&
                        entry.adapter.getCatalogue().generation === binding.generation,
                    };
                  }),
                nextAfterKey: records.length > limit ? selected[selected.length - 1]!.key : null,
              },
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      })),
      {
        id: 'mcp.catalogue',
        version: '1',
        description: 'Read cached scoped catalogue facts without connecting',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            afterKey: { type: 'string', maxLength: 256 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        outputSchema: { type: 'array' },
        async execute(input, context) {
          const request = input as { afterKey?: string; limit?: number };
          const limit = request.limit ?? 100;
          const records = await context.records.list({
            limit: limit + 1,
            contentType,
            ...(request.afterKey ? { afterKey: request.afterKey } : {}),
          });
          const selected = records.slice(0, limit);
          return [
            {
              extensionId: mcpLifecycleExtensionId,
              contentType,
              contentVersion: 1,
              summary: 'Saved MCP catalogue; live availability is separate',
              payload: {
                items: selected.map((record) => {
                  const value =
                    record.value && typeof record.value === 'object' && !Array.isArray(record.value)
                      ? record.value
                      : {};
                  const operation =
                    value.operationRef &&
                    typeof value.operationRef === 'object' &&
                    !Array.isArray(value.operationRef)
                      ? value.operationRef
                      : {};
                  const entry = live.get(
                    scopeKey(
                      record.originStoreId ?? '',
                      context.sessionId,
                      typeof value.serverId === 'string' ? value.serverId : '',
                    ),
                  );
                  return {
                    key: record.key,
                    record: record.value,
                    originStoreId: record.originStoreId,
                    currentCatalogue:
                      !closed &&
                      !record.forkProvenance &&
                      record.sessionId === context.sessionId &&
                      entry?.ref &&
                      entry.ref.executionId === operation.executionId &&
                      !entry.terminal &&
                      entry.adapter?.getCatalogue().available
                        ? entry.adapter.getCatalogue()
                        : null,
                    live:
                      !closed &&
                      !record.forkProvenance &&
                      record.sessionId === context.sessionId &&
                      !!entry?.ref &&
                      entry.ref.executionId === operation.executionId &&
                      !entry.terminal &&
                      !!entry.adapter?.getCatalogue().available,
                  };
                }),
                nextAfterKey: records.length > limit ? selected[selected.length - 1]!.key : null,
              },
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
  };
  return {
    extension,
    async readStepCapabilities(input: {
      command: { originStoreId: string };
      session: { id: string };
    }) {
      const extensions: Extension[] = [];
      const toolIds: string[] = [];
      const facts: Json[] = [];
      if (closed) return { extensions, toolIds, snapshot: { mcp: facts } as Json };
      for (const entry of live.values()) {
        try {
          await confirmPublication(entry);
          wireFresh(entry);
          if (tickets.has(scopeKey(entry.storeId, entry.sessionId, entry.serverId))) continue;
        } catch {
          continue;
        }
        if (
          entry.storeId !== input.command.originStoreId ||
          entry.sessionId !== input.session.id ||
          entry.terminal ||
          !entry.scope ||
          !entry.adapter?.getCatalogue().available
        )
          continue;
        if (entry.source) {
          try {
            entry.source.assertFresh({ signal: entry.signal });
          } catch {
            // A stale source only withdraws its cached capabilities from this step.
            // It cannot reconnect, authorize another capture, or block unrelated Tools.
            continue;
          }
        }
        const catalogue = entry.adapter.getCatalogue();
        const tools = entry.scope.getCachedTools();
        extensions.push({
          id: `builtin.mcp.remote.${entry.serverId}`,
          version: String(catalogue.generation),
          apiMajor: 1,
          tools,
          jobs: entry.scope.getCachedJobs(),
        });
        toolIds.push(...tools.map((tool) => tool.id));
        facts.push({
          serverId: entry.serverId,
          configDigest: catalogue.configDigest,
          generation: catalogue.generation,
          definitions: catalogue.definitions,
          originalStoreId: entry.storeId,
        });
      }
      return { extensions, toolIds, snapshot: { mcp: facts } as Json };
    },
    async close() {
      closed = true;
      for (const pending of starting.values())
        pending.reject(new McpAdapterError('mcp_adapter_closed'));
      starting.clear();
      admitted.clear();
      await Promise.all([...entries.values()].map(stop));
    },
  };
}
