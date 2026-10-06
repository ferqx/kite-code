import {
  type AgentClient,
  ClientError,
  canonicalMcpCommandRequest,
  canonicalModelBody,
  decodeMcpAuthStatus,
  decodeMcpManagementSnapshot,
  decodeMcpSourceRemovalPreview,
  decodeMcpSourcesPage,
  decodeMcpToolsPage,
  decodeMcpToolsSnapshots,
  type ExtensionCommandRequest,
  type Json,
  type McpCommandRequest,
  type McpManagementSnapshot,
  type McpSourceItem,
  type McpSourcesPage,
  type McpToolsPage,
  type McpToolsSnapshot,
  readMcpToolDescriptor,
  validateMcpCommandRequest,
} from '@kite-ai/client';
import type {
  NativeMcpAuthFacts,
  NativeMcpDescriptorChunk,
  NativeMcpDescriptorOpen,
  NativeMcpFacts,
  NativeMcpOperation,
  NativeMcpRemovalPreview,
  NativeMcpSnapshots,
  NativeMcpSources,
  NativeMcpSubmission,
  NativeMcpTools,
} from '../src/mcp-bridge';
import { parseNativeMcpOperation } from './mcp-input';
import {
  mcpSha,
  type NativeMcpData,
  type NativeMcpRecord,
  parseNativeMcpRecord,
} from './mcp-journal';
import { lookupNativeMcpResult, nativeMcpMetadata, verifyNativeMcpCommand } from './mcp-results';

type Scope = { generation: number; selection: number; storeId: string; sessionId: string };
type Observation = {
  scope: Scope;
  facts: NativeMcpFacts;
  management?: McpManagementSnapshot;
  source?: McpSourcesPage;
  sources: Map<string, McpSourceItem>;
  snapshots: Map<string, McpToolsSnapshot>;
  pages: Map<string, McpToolsPage>;
  previews: Map<string, NativeMcpRemovalPreview>;
};
type Entry = {
  row: NativeMcpRecord;
  state: NativeMcpSubmission;
  promise?: Promise<NativeMcpSubmission>;
};
const equal = (left: unknown, right: unknown) =>
  canonicalModelBody(left) === canonicalModelBody(right);
const code = (error: unknown) => {
  const name = (error as { code?: string })?.code ?? (error as Error)?.message;
  return typeof name === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(name)
    ? name
    : 'mcp_outcome_unknown';
};
const pending = (state: NativeMcpSubmission) =>
  ['submitting', 'pending', 'outcome_unknown'].includes(state.phase);

/** Main owns fixed requests and observations. Renderer and cold rows cannot supply authority. */
export class NativeMcpSettings {
  private readonly entries = new Map<string, Entry>();
  private readonly actions = new Map<string, string>();
  private readonly readers = new Set<AbortController>();
  private readonly descriptors = new Map<
    string,
    { scope: Scope; body?: Buffer; offset: number; reader?: AbortController }
  >();
  private readonly lookups = new Map<string, Promise<NativeMcpSubmission>>();
  private observed?: Observation;
  private sequence = 0;
  private unavailable = false;
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly notify: () => void;
  private readonly data?: NativeMcpData;
  private readonly cancelExecution?: (row: NativeMcpRecord, executionId: string) => Promise<void>;
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    notify: () => void,
    data?: NativeMcpData,
    cancelExecution?: (row: NativeMcpRecord, executionId: string) => Promise<void>,
  ) {
    this.client = client;
    this.current = current;
    this.notify = notify;
    this.data = data;
    this.cancelExecution = cancelExecution;
    try {
      for (const raw of data?.mcps() ?? []) {
        const row = parseNativeMcpRecord(raw);
        this.entries.set(row.request.commandId, {
          row,
          state: { ...nativeMcpMetadata(row, client), phase: 'outcome_unknown' },
        });
      }
    } catch {
      this.unavailable = true;
    }
  }
  get submissions() {
    return [...this.entries.values()].map((entry) => structuredClone(entry.state));
  }
  get storageUnavailable() {
    return this.unavailable;
  }
  release() {
    for (const reader of this.readers) reader.abort();
    this.readers.clear();
    for (const descriptor of this.descriptors.values()) descriptor.reader?.abort();
    this.descriptors.clear();
    this.observed = undefined;
  }
  private scope(): Scope {
    const scope = this.current();
    if (
      !scope ||
      this.client.serverInfo?.storeId !== scope.storeId ||
      !this.client.serverInfo.subjectId
    )
      throw new ClientError('mcp_scope_unavailable');
    return { ...scope };
  }
  private same(scope: Scope): boolean {
    return equal(this.current(), scope);
  }
  private observation(id: number): Observation {
    const value = this.observed;
    if (!value || value.facts.observationId !== id || !this.same(value.scope))
      throw new ClientError('mcp_observation_changed');
    return value;
  }
  private async reading<T>(scope: Scope, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const reader = new AbortController();
    this.readers.add(reader);
    try {
      const result = await work(reader.signal);
      reader.signal.throwIfAborted();
      if (!this.same(scope)) throw new ClientError('native_selection_changed');
      return result;
    } finally {
      this.readers.delete(reader);
    }
  }
  private query(
    scope: Scope,
    extension: string,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    return this.client.queryExtension(
      scope.sessionId,
      extension,
      name,
      JSON.parse(JSON.stringify(input)) as Json,
      { signal },
    );
  }
  async read(): Promise<NativeMcpFacts> {
    this.release();
    const scope = this.scope(),
      observationId = ++this.sequence;
    return this.reading(scope, async (signal) => {
      const view = await this.client.getView(scope.sessionId, { signal });
      if (
        view.storeId !== scope.storeId ||
        view.session.id !== scope.sessionId ||
        view.session.deletedAt !== null
      )
        throw new ClientError('mcp_scope_unavailable');
      const facts: NativeMcpFacts = {
        kind: 'settings.mcp',
        observationId,
        storeId: scope.storeId,
        sessionId: scope.sessionId,
        workspaceId: view.session.workspaceId,
        canWrite: false,
        errors: [],
        servers: [],
        sources: [],
        nextAfterId: null,
        snapshots: [],
        nextAfterKey: null,
      };
      let management: McpManagementSnapshot | undefined, source: McpSourcesPage | undefined;
      try {
        management = decodeMcpManagementSnapshot(
          await this.query(scope, 'builtin.mcp.management', 'mcp.servers', {}, signal),
        );
        if (
          management.storeId !== scope.storeId ||
          management.sessionId !== scope.sessionId ||
          management.workspaceId !== facts.workspaceId
        )
          throw new ClientError('mcp_scope_mismatch');
        facts.servers = management.items;
      } catch (error) {
        facts.errors.push(code(error));
      }
      try {
        source = decodeMcpSourcesPage(
          await this.query(scope, 'builtin.mcp.sources', 'mcp.sources', { limit: 25 }, signal),
        );
        facts.sources = source.items;
        facts.nextAfterId = source.nextAfterId;
        facts.errors.push(
          ...(Array.isArray(source.errors)
            ? source.errors
            : Object.values(source.errors).filter((v): v is string => v !== null)),
        );
      } catch (error) {
        facts.errors.push(code(error));
      }
      const snapshots = new Map<string, McpToolsSnapshot>();
      try {
        const page = decodeMcpToolsSnapshots(
          await this.query(scope, 'builtin.mcp', 'mcp.tools.snapshots', { limit: 32 }, signal),
        );
        if (
          page.sessionId !== scope.sessionId ||
          page.items.some((item) => item.origin.sessionId !== scope.sessionId)
        )
          throw new ClientError('mcp_tools_scope_mismatch');
        facts.snapshots = page.items;
        facts.nextAfterKey = page.nextAfterKey;
        for (const item of page.items) snapshots.set(item.recordKey, item);
      } catch (error) {
        facts.errors.push(code(error));
      }
      signal.throwIfAborted();
      if (observationId !== this.sequence || !this.same(scope))
        throw new ClientError('mcp_observation_changed');
      // A malformed or absent source is local. Programmatic read facts remain visible.
      facts.canWrite = !!management && !!this.data && !this.unavailable;
      this.observed = {
        scope,
        facts,
        management,
        source,
        sources: new Map((source?.items ?? []).map((item) => [item.id, item])),
        snapshots,
        pages: new Map(),
        previews: new Map(),
      };
      return structuredClone(facts);
    });
  }
  async sources(observationId: number, afterId: string): Promise<NativeMcpSources> {
    const observed = this.observation(observationId);
    if (!observed.source || afterId !== observed.facts.nextAfterId)
      throw new ClientError('mcp_sources_cursor_changed');
    return this.reading(observed.scope, async (signal) => {
      const page = decodeMcpSourcesPage(
        await this.query(
          observed.scope,
          'builtin.mcp.sources',
          'mcp.sources',
          { afterId, limit: 25 },
          signal,
        ),
      );
      if (
        !equal(
          { readSet: page.readSet, registryRevision: page.registryRevision, errors: page.errors },
          {
            readSet: observed.source!.readSet,
            registryRevision: observed.source!.registryRevision,
            errors: observed.source!.errors,
          },
        ) ||
        !page.items.length ||
        page.items[0]!.id <= afterId ||
        observed.sources.size + page.items.length > 8192
      )
        throw new ClientError('mcp_sources_changed');
      this.observation(observationId);
      for (const item of page.items) observed.sources.set(item.id, item);
      observed.facts.nextAfterId = page.nextAfterId;
      return {
        kind: 'settings.mcp.sources',
        observationId,
        sources: page.items,
        nextAfterId: page.nextAfterId,
      };
    });
  }
  async snapshots(observationId: number, afterKey: string): Promise<NativeMcpSnapshots> {
    const observed = this.observation(observationId);
    if (afterKey !== observed.facts.nextAfterKey) throw new ClientError('mcp_tools_cursor_changed');
    return this.reading(observed.scope, async (signal) => {
      const page = decodeMcpToolsSnapshots(
        await this.query(
          observed.scope,
          'builtin.mcp',
          'mcp.tools.snapshots',
          { afterKey, limit: 32 },
          signal,
        ),
      );
      if (
        page.sessionId !== observed.scope.sessionId ||
        !page.items.length ||
        page.items.some(
          (item) =>
            item.recordKey <= afterKey || item.origin.sessionId !== observed.scope.sessionId,
        ) ||
        observed.snapshots.size + page.items.length > 8192
      )
        throw new ClientError('mcp_tools_scope_mismatch');
      this.observation(observationId);
      for (const item of page.items) observed.snapshots.set(item.recordKey, item);
      observed.facts.nextAfterKey = page.nextAfterKey;
      return {
        kind: 'settings.mcp.snapshots',
        observationId,
        snapshots: page.items,
        nextAfterKey: page.nextAfterKey,
      };
    });
  }
  async auth(observationId: number, serverId: string): Promise<NativeMcpAuthFacts> {
    const observed = this.observation(observationId),
      readSet = observed.source?.readSet;
    if (!readSet || !observed.sources.has(serverId))
      throw new ClientError('mcp_source_unavailable');
    return this.reading(observed.scope, async (signal) => {
      const status = decodeMcpAuthStatus(
        await this.query(
          observed.scope,
          'builtin.mcp.sources',
          'mcp.auth.status',
          { serverId, expectedReadSet: readSet },
          signal,
        ),
      );
      if (status.serverId !== serverId || status.workspaceId !== observed.facts.workspaceId)
        throw new ClientError('mcp_auth_scope_mismatch');
      this.observation(observationId);
      return { kind: 'settings.mcp.auth', observationId, status };
    });
  }
  async removePreview(
    observationId: number,
    serverId: string,
    scope: 'user' | 'workspace',
  ): Promise<NativeMcpRemovalPreview> {
    const observed = this.observation(observationId),
      source = observed.source,
      item = observed.sources.get(serverId);
    if (!source?.readSet || !item || item.source.kind !== scope)
      throw new ClientError('mcp_source_scope_mismatch');
    return this.reading(observed.scope, async (signal) => {
      const result = decodeMcpSourceRemovalPreview(
        await this.query(
          observed.scope,
          'builtin.mcp.sources',
          'mcp.source.entry.preview',
          { scope, serverId, expectedReadSet: source.readSet },
          signal,
        ),
      );
      const read = scope === 'user' ? source.readSet!.user : source.readSet!.workspace;
      if (
        result.storeId !== observed.scope.storeId ||
        result.sessionId !== observed.scope.sessionId ||
        result.workspaceId !== observed.facts.workspaceId ||
        !equal(result.readSet, source.readSet) ||
        result.preview.target.serverId !== serverId ||
        result.preview.target.rawEntryDigest !== item.rawEntryDigest ||
        !read ||
        !equal(result.preview.target.source, read.identity) ||
        (result.preview.fallback &&
          !equal(result.preview.fallback.source, source.readSet!.user.identity))
      )
        throw new ClientError('mcp_source_preview_changed');
      this.observation(observationId);
      const facts: NativeMcpRemovalPreview = {
        kind: 'settings.mcp.removePreview',
        observationId,
        serverId,
        scope,
        preview: result.preview,
      };
      observed.previews.set(`${scope}:${serverId}`, facts);
      return structuredClone(facts);
    });
  }
  async tools(
    observationId: number,
    recordKey: string,
    startIndex: number,
  ): Promise<NativeMcpTools> {
    const observed = this.observation(observationId),
      snapshot = observed.snapshots.get(recordKey);
    if (
      !snapshot ||
      !Number.isSafeInteger(startIndex) ||
      startIndex < 0 ||
      startIndex > snapshot.toolCount
    )
      throw new ClientError('mcp_tools_observation_changed');
    return this.reading(observed.scope, async (signal) => {
      const page = decodeMcpToolsPage(
        await this.query(
          observed.scope,
          'builtin.mcp',
          'mcp.tools',
          {
            recordKey,
            generation: snapshot.origin.generation,
            afterIndex: startIndex,
            ...(snapshot.index ? { indexDigest: snapshot.index.hash } : {}),
            limit: 32,
          },
          signal,
        ),
      );
      const { indexDigest, ...origin } = page.binding;
      if (
        page.recordKey !== recordKey ||
        page.startIndex !== startIndex ||
        !equal(origin, snapshot.origin) ||
        indexDigest !== (snapshot.index?.hash ?? null) ||
        page.toolCount !== snapshot.toolCount
      )
        throw new ClientError('mcp_tools_snapshot_changed');
      this.observation(observationId);
      observed.pages.set(recordKey, page);
      return { kind: 'settings.mcp.tools', observationId, page };
    });
  }
  async descriptor(
    observationId: number,
    recordKey: string,
    index: number,
    readId: string,
  ): Promise<NativeMcpDescriptorOpen> {
    const observed = this.observation(observationId),
      page = observed.pages.get(recordKey),
      entry = page?.entries.find((item) => item.index === index);
    if (!page || !entry || this.descriptors.has(readId) || this.descriptors.size >= 2)
      throw new ClientError('mcp_descriptor_observation_changed');
    const reservation = { scope: observed.scope, offset: 0, reader: new AbortController() };
    this.descriptors.set(readId, reservation);
    try {
      return await this.reading(observed.scope, async (parentSignal) => {
        const signal = AbortSignal.any([parentSignal, reservation.reader.signal]);
        const metadata = await readMcpToolDescriptor({
          currentStoreId: observed.scope.storeId,
          sessionId: observed.scope.sessionId,
          binding: page.binding,
          entry,
          signal,
          readArtifact: this.client.readArtifact.bind(this.client),
        });
        const body = Buffer.from(canonicalModelBody(metadata));
        if (
          body.byteLength !== Number(entry.descriptorBytes) ||
          mcpSha(body.toString('utf8')) !== entry.descriptorHash
        )
          throw new ClientError('mcp_descriptor_invalid');
        this.observation(observationId);
        signal.throwIfAborted();
        if (this.descriptors.get(readId) !== reservation)
          throw new ClientError('mcp_descriptor_observation_changed');
        this.descriptors.set(readId, { scope: observed.scope, body, offset: 0 });
        return {
          kind: 'settings.mcp.descriptor',
          readId,
          bodySha256: entry.descriptorHash,
          bodyBytes: body.byteLength,
        };
      });
    } catch (error) {
      if (this.descriptors.get(readId) === reservation) this.descriptors.delete(readId);
      throw error;
    }
  }
  descriptorRead(readId: string, offset: number, limit: number): NativeMcpDescriptorChunk {
    const read = this.descriptors.get(readId);
    if (
      !read?.body ||
      !this.same(read.scope) ||
      offset !== read.offset ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      throw new ClientError('mcp_descriptor_cursor_changed');
    const bytes = read.body.subarray(offset, offset + limit),
      nextOffset = offset + bytes.byteLength;
    read.offset = nextOffset;
    return {
      kind: 'settings.mcp.descriptor.chunk',
      readId,
      offset,
      nextOffset,
      eof: nextOffset === read.body.byteLength,
      data: bytes.toString('base64'),
    };
  }
  descriptorClose(readId: string) {
    this.descriptors.get(readId)?.reader?.abort();
    this.descriptors.delete(readId);
  }
  private async fresh(observed: Observation, sourceRequired: boolean): Promise<void> {
    await this.reading(observed.scope, async (signal) => {
      const management = decodeMcpManagementSnapshot(
        await this.query(observed.scope, 'builtin.mcp.management', 'mcp.servers', {}, signal),
      );
      if (!observed.management || !equal(management, observed.management))
        throw new ClientError('mcp_observation_changed');
      if (sourceRequired) {
        const source = decodeMcpSourcesPage(
          await this.query(
            observed.scope,
            'builtin.mcp.sources',
            'mcp.sources',
            { limit: 25 },
            signal,
          ),
        );
        if (!observed.source || !equal(source, observed.source))
          throw new ClientError('mcp_sources_changed');
      }
      this.observation(observed.facts.observationId);
    });
  }
  submit(observationId: number, raw: NativeMcpOperation): Promise<NativeMcpSubmission> {
    const operation = parseNativeMcpOperation(raw),
      observed = this.observation(observationId);
    if (!this.data || this.unavailable || !observed.management || !observed.facts.canWrite)
      throw new ClientError('mcp_storage_unavailable');
    const key = `${observationId}:${canonicalModelBody(operation)}`,
      previousId = this.actions.get(key);
    const flight = previousId ? this.flights.get(previousId) : undefined;
    if (flight) return flight;
    const previous = previousId ? this.entries.get(previousId) : undefined;
    if (previous?.promise) return previous.promise;
    if (previous) throw new ClientError('mcp_intent_consumed');
    if (
      [...this.entries.values()].some(
        (entry) =>
          entry.row.request.expectedStoreId === observed.scope.storeId && pending(entry.state),
      )
    )
      throw new ClientError('mcp_operation_pending');
    // Reserve this UI operation before asynchronous preflight so double clicks coalesce.
    const commandId = crypto.randomUUID();
    this.actions.set(key, commandId);
    const work = this.first(observed, operation, commandId);
    // Preflight has not created a row yet. A separate flight covers that interval.
    this.flights.set(commandId, work);
    void work.finally(() => this.flights.delete(commandId)).catch(() => {});
    return work;
  }
  private readonly flights = new Map<string, Promise<NativeMcpSubmission>>();
  private async first(
    observed: Observation,
    operation: NativeMcpOperation,
    commandId: string,
  ): Promise<NativeMcpSubmission> {
    let saved: Entry | undefined;
    try {
      const management = observed.management!,
        source = observed.source,
        sourceItem = 'serverId' in operation ? observed.sources.get(operation.serverId) : undefined;
      const server =
        'serverId' in operation
          ? management.items.find((item) => item.id === operation.serverId)
          : undefined;
      const sourceRequired =
        !['select', 'connect', 'refresh'].includes(operation.kind) ||
        (operation.kind === 'connect' && server?.source.kind !== 'programmatic');
      await this.fresh(observed, sourceRequired);
      if ('serverId' in operation && !server && !sourceItem)
        throw new ClientError('mcp_server_unavailable');
      let extensionId = 'builtin.mcp.sources',
        actionId: string,
        input: unknown,
        targetRequest: McpCommandRequest | null = null;
      if (operation.kind === 'select') {
        if (!server) throw new ClientError('mcp_server_unavailable');
        extensionId = 'builtin.mcp.management';
        actionId = 'mcp.server.select';
        input = {
          serverId: operation.serverId,
          enabled: operation.enabled,
          scope: operation.scope,
          expectedReadSet: management.readSet,
        };
      } else if (operation.kind === 'connect') {
        if (!server?.admitted || !server.available) throw new ClientError('mcp_server_unavailable');
        extensionId = 'builtin.mcp';
        actionId = 'mcp.connect';
        input = { serverId: operation.serverId, key: crypto.randomUUID() };
      } else if (operation.kind === 'refresh' || operation.kind === 'reconnect') {
        const prior = this.entries.get(operation.commandId);
        if (
          !prior ||
          (prior.row.request.actionId !== 'mcp.connect' &&
            prior.row.request.actionId !== 'mcp.reconnect') ||
          prior.row.sessionId !== observed.scope.sessionId ||
          prior.row.workspaceId !== observed.facts.workspaceId ||
          prior.row.workspaceIdentity !== mcpSha(management.workspaceIdentity) ||
          prior.row.request.input.serverId !== operation.serverId
        )
          throw new ClientError('mcp_connection_original_unavailable');
        const outcome = await this.reading(observed.scope, (signal) =>
          lookupNativeMcpResult(this.client, prior.row, signal),
        );
        const fact = outcome.fact;
        if (
          outcome.phase !== 'completed' ||
          !fact ||
          !('ready' in fact) ||
          !fact.ready ||
          !fact.live ||
          !fact.currentGeneration ||
          !server
        )
          throw new ClientError('mcp_live_connection_unavailable');
        const ref = 'operationRef' in fact ? fact.operationRef : fact.newOperationRef;
        const connection = 'connection' in fact ? fact.connection : fact.newConnection;
        if (
          !ref?.executionId ||
          !connection ||
          ref.originStoreId !== observed.scope.storeId ||
          ref.sessionId !== observed.scope.sessionId ||
          (operation.kind === 'refresh' && server.configDigest !== fact.ready.configDigest)
        )
          throw new ClientError('mcp_live_connection_unavailable');
        extensionId = 'builtin.mcp';
        if (operation.kind === 'refresh') {
          actionId = 'mcp.catalogue.refresh';
          input = {
            serverId: operation.serverId,
            connectionKey: ref.key.split('/')[2],
            connectionExecutionId: connection.id,
            configDigest: fact.ready.configDigest,
            generation: fact.currentGeneration,
          };
        } else {
          if (!server.admitted || !server.available)
            throw new ClientError('mcp_server_unavailable');
          actionId = 'mcp.reconnect';
          targetRequest = prior.row.request;
          input = {
            serverId: operation.serverId,
            key: crypto.randomUUID(),
            target: {
              carrierExecutionId: fact.execution.id,
              carrierKey: prior.row.request.input.key,
              operationRef: ref,
              connectionExecutionId: connection.id,
              configDigest: fact.ready.configDigest,
              currentGeneration: fact.currentGeneration,
            },
            replacement:
              server.source.kind === 'programmatic'
                ? { kind: 'static', expectedConfigDigest: server.configDigest }
                : {
                    kind: 'source',
                    expectedConfigDigest: server.configDigest,
                    expectedReadSet: source?.readSet,
                  },
          };
        }
      } else {
        if (!source?.readSet) throw new ClientError('mcp_source_unavailable');
        if (operation.kind !== 'add' && !sourceItem)
          throw new ClientError('mcp_source_unavailable');
        if (operation.kind === 'add') {
          actionId = 'mcp.source.add';
          input = {
            scope: operation.scope,
            name: operation.name,
            entry: operation.entry,
            expectedReadSet: source.readSet,
          };
        } else if (operation.kind === 'remove') {
          if (sourceItem!.source.kind !== operation.scope)
            throw new ClientError('mcp_source_scope_mismatch');
          if (!observed.previews.has(`${operation.scope}:${operation.serverId}`))
            throw new ClientError('mcp_source_preview_required');
          actionId = 'mcp.source.remove';
          input = {
            scope: operation.scope,
            serverId: operation.serverId,
            expectedRawEntryDigest: sourceItem!.rawEntryDigest,
            expectedReadSet: source.readSet,
          };
        } else if (operation.kind === 'bind') {
          actionId = 'mcp.credential.bind';
          input = {
            serverId: operation.serverId,
            expectedReadSet: source.readSet,
            expiresAt: operation.expiresAt,
          };
        } else {
          if (operation.kind === 'approve' && sourceItem!.source.kind !== 'workspace')
            throw new ClientError('mcp_source_approval_not_required');
          actionId = {
            approve: 'mcp.source.approve',
            login: 'mcp.auth.login',
            authRefresh: 'mcp.auth.refresh',
            clear: 'mcp.auth.clear',
            revoke: 'mcp.auth.revoke',
          }[operation.kind];
          input = { serverId: operation.serverId, expectedReadSet: source.readSet };
        }
      }
      const request = validateMcpCommandRequest({
        expectedStoreId: observed.scope.storeId,
        commandId,
        kind: 'extension.invoke',
        extensionId,
        actionId,
        definitionVersion: '1',
        input,
      });
      this.observation(observed.facts.observationId);
      const subjectId = this.client.serverInfo?.subjectId;
      if (!subjectId || this.client.serverInfo?.storeId !== observed.scope.storeId)
        throw new ClientError('mcp_scope_unavailable');
      const row = parseNativeMcpRecord({
        version: 1,
        sessionId: observed.scope.sessionId,
        workspaceId: observed.facts.workspaceId,
        workspaceIdentity: mcpSha(management.workspaceIdentity),
        subjectId,
        request,
        targetRequest,
        bodySha256: mcpSha(canonicalModelBody(request)),
        requestSha256: mcpSha(canonicalMcpCommandRequest(request)),
        phase: 'submitting',
      });
      if (
        [...this.entries.values()].some(
          (entry) =>
            entry.row.request.expectedStoreId === observed.scope.storeId && pending(entry.state),
        )
      )
        throw new ClientError('mcp_operation_pending');
      const durable = this.data!.beginMcp(row);
      if (!durable.created) throw new ClientError('mcp_intent_consumed');
      saved = { row: durable.value, state: nativeMcpMetadata(durable.value, this.client) };
      this.entries.set(commandId, saved);
      this.notify();
      // Only this hot first path owns a POST. Switching/closing the reader never cancels this business request.
      if (!this.same(observed.scope) || this.client.serverInfo?.subjectId !== subjectId)
        throw new ClientError('mcp_scope_changed');
      const command = await this.client.invokeExtension(
        row.sessionId,
        JSON.parse(JSON.stringify(request)) as ExtensionCommandRequest,
      );
      verifyNativeMcpCommand(command, row);
      return await this.lookup(commandId);
    } catch (error) {
      if (!saved) {
        for (const [key, id] of this.actions) if (id === commandId) this.actions.delete(key);
        throw error;
      }
      saved.state = {
        ...nativeMcpMetadata(saved.row, this.client),
        phase: 'outcome_unknown',
        error: code(error),
      };
      try {
        saved.row = this.data!.finishMcp(commandId, 'outcome_unknown');
      } catch {
        this.unavailable = true;
      }
      this.notify();
      return structuredClone(saved.state);
    }
  }
  lookup(commandId: string): Promise<NativeMcpSubmission> {
    const existing = this.lookups.get(commandId);
    if (existing) return existing;
    const flight = this.lookupOriginal(commandId).finally(() => {
      if (this.lookups.get(commandId) === flight) this.lookups.delete(commandId);
    });
    this.lookups.set(commandId, flight);
    return flight;
  }
  private async lookupOriginal(commandId: string): Promise<NativeMcpSubmission> {
    const entry = this.entries.get(commandId);
    if (!entry) throw new ClientError('mcp_intent_missing');
    const scope = this.current();
    if (!scope) throw new ClientError('mcp_scope_unavailable');
    const state = await this.reading({ ...scope }, (signal) =>
      lookupNativeMcpResult(this.client, entry.row, signal),
    );
    // Lookup changes only the exact original row, even when another Session is selected.
    if (
      state.association === 'current' &&
      !['completed', 'failed', 'cancelled'].includes(entry.row.phase)
    ) {
      try {
        entry.row = this.data!.finishMcp(commandId, state.phase);
      } catch {
        this.unavailable = true;
        throw new ClientError('mcp_storage_unavailable');
      }
    }
    const retained =
      state.association === 'current' &&
      pending(state) &&
      ['completed', 'failed', 'cancelled'].includes(entry.state.phase);
    entry.state = retained
      ? {
          ...entry.state,
          fact: undefined,
          error: state.error ?? 'mcp_original_lookup_unavailable',
          summary: '已核对的原执行终态保留；本次查询结果未知',
        }
      : state;
    this.notify();
    return structuredClone(entry.state);
  }
  async cancel(commandId: string): Promise<NativeMcpSubmission> {
    const entry = this.entries.get(commandId);
    if (!entry || !this.cancelExecution) throw new ClientError('mcp_intent_missing');
    const state = await this.lookup(commandId);
    if (state.association !== 'current' || state.phase !== 'pending' || !state.executionId)
      throw new ClientError('mcp_cancel_original_unavailable');
    await this.cancelExecution(entry.row, state.executionId);
    return this.lookup(commandId);
  }
  clear(commandId: string) {
    const entry = this.entries.get(commandId);
    if (!entry || pending(entry.state)) throw new ClientError('mcp_clear_unconfirmed');
    this.data!.clearMcp(commandId);
    this.entries.delete(commandId);
    this.notify();
  }
}
