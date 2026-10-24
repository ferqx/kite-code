import {
  type AgentClient,
  ClientError,
  canonicalModelBody,
  type UserMcpOperationResult,
  type UserMcpSettingsRequest,
  type UserMcpSettingsView,
} from '@kite-ai/client';
import type {
  NativeMcpPhase,
  NativeUserMcpFacts,
  NativeUserMcpOperation,
  NativeUserMcpSubmission,
  NativeUserMcpTools,
} from '../src/mcp-bridge';
import { parseNativeUserMcpOperation } from './mcp-input';
import {
  canonicalUserMcpRequest,
  mcpSha,
  type NativeMcpRecord,
  type NativeUserMcpData,
  type NativeUserMcpRecord,
  parseNativeMcpRecord,
  parseNativeUserMcpRecord,
} from './mcp-journal';
import { lookupNativeMcpResult } from './mcp-results';

type Scope = { generation: number; storeId: string };
type Entry = {
  row: NativeUserMcpRecord;
  state: NativeUserMcpSubmission;
  promise?: Promise<NativeUserMcpSubmission>;
};
type Legacy = { row: NativeMcpRecord; state: NativeUserMcpSubmission; user: boolean };
const equal = (a: unknown, b: unknown) => canonicalModelBody(a) === canonicalModelBody(b);
const pending = (phase: NativeMcpPhase) =>
  ['submitting', 'pending', 'outcome_unknown'].includes(phase);
const errorCode = (error: unknown) => {
  const value = (error as { code?: string })?.code ?? (error as Error)?.message;
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value)
    ? value
    : 'mcp_outcome_unknown';
};

/** Only the hot first submission can POST; persisted records provide lookup identity only. */
export class NativeUserMcpSettings {
  private readonly client: AgentClient;
  private readonly current: () => Scope | undefined;
  private readonly notify: () => void;
  private readonly data?: NativeUserMcpData;
  private readonly entries = new Map<string, Entry>();
  private readonly legacy = new Map<string, Legacy>();
  private readonly actions = new Map<string, string>();
  private readonly lookups = new Map<string, Promise<NativeUserMcpSubmission>>();
  private readonly readers = new Set<AbortController>();
  private observed?: {
    scope: Scope;
    subjectId: string;
    view: UserMcpSettingsView;
    facts: NativeUserMcpFacts;
  };
  private sequence = 0;
  private readEpoch = 0;
  private unavailable = false;
  constructor(
    client: AgentClient,
    current: () => Scope | undefined,
    notify: () => void,
    data?: NativeUserMcpData,
  ) {
    this.client = client;
    this.current = current;
    this.notify = notify;
    this.data = data;
    try {
      for (const raw of data?.userMcps() ?? []) {
        const row = parseNativeUserMcpRecord(raw);
        this.entries.set(row.request.commandId, {
          row,
          state: this.metadata(row, pending(row.phase) ? 'outcome_unknown' : row.phase),
        });
      }
      // Old project configuration is never a global source. Unscoped historical connections
      // retain a separate original-result notice because their provenance cannot be inferred.
      for (const raw of data?.mcps() ?? []) {
        const row = parseNativeMcpRecord(raw),
          input = row.request.input;
        if (
          !pending(row.phase) ||
          ('scope' in input && input.scope === 'workspace') ||
          row.request.actionId === 'mcp.source.approve'
        )
          continue;
        const operation = this.legacyOperation(row);
        if (!operation) continue;
        const user =
          ('scope' in input && input.scope === 'user') ||
          ('expectedReadSet' in input &&
            'workspace' in input.expectedReadSet &&
            input.expectedReadSet.workspace === null);
        this.legacy.set(row.request.commandId, {
          row,
          user,
          state: {
            kind: 'settings.userMcp.submission',
            commandId: row.request.commandId,
            storeId: row.request.expectedStoreId,
            operation,
            phase: 'outcome_unknown',
            association: this.associated(row.request.expectedStoreId, row.subjectId)
              ? 'current'
              : 'unavailable',
            legacy: true,
            ...(user ? { legacyUser: true as const } : {}),
          },
        });
      }
    } catch {
      this.unavailable = true;
    }
  }
  private associated(storeId: string, subjectId: string) {
    return (
      this.current()?.storeId === storeId &&
      this.client.serverInfo?.storeId === storeId &&
      this.client.serverInfo.subjectId === subjectId
    );
  }
  private metadata(row: NativeUserMcpRecord, phase = row.phase): NativeUserMcpSubmission {
    return {
      kind: 'settings.userMcp.submission',
      commandId: row.request.commandId,
      storeId: row.request.storeId,
      operation: structuredClone(row.request.operation),
      phase,
      association: this.associated(row.request.storeId, row.subjectId) ? 'current' : 'unavailable',
    };
  }
  private legacyOperation(row: NativeMcpRecord): NativeUserMcpOperation | undefined {
    const input = row.request.input;
    if (row.request.actionId === 'mcp.source.add')
      return { kind: 'add', name: row.request.input.name, entry: row.request.input.entry };
    if (!('serverId' in input)) return undefined;
    switch (row.request.actionId) {
      case 'mcp.server.select':
        return { kind: 'enabled', serverId: input.serverId, enabled: row.request.input.enabled };
      case 'mcp.source.remove':
        return { kind: 'remove', serverId: input.serverId };
      case 'mcp.auth.login':
        return { kind: 'login', serverId: input.serverId };
      case 'mcp.auth.refresh':
        return { kind: 'authRefresh', serverId: input.serverId };
      case 'mcp.auth.clear':
        return { kind: 'clear', serverId: input.serverId };
      case 'mcp.auth.revoke':
        return { kind: 'revoke', serverId: input.serverId };
      case 'mcp.credential.bind':
        return { kind: 'bind', serverId: input.serverId, expiresAt: row.request.input.expiresAt };
      case 'mcp.connect':
        return { kind: 'connect', serverId: input.serverId };
      case 'mcp.reconnect':
        return { kind: 'reconnect', serverId: input.serverId };
      case 'mcp.catalogue.refresh':
        return { kind: 'refresh', serverId: input.serverId };
      default:
        return undefined;
    }
  }
  get submissions(): NativeUserMcpSubmission[] {
    return [
      ...[...this.entries.values()].map((entry) => ({
        ...entry.state,
        association: this.metadata(entry.row).association,
      })),
      ...[...this.legacy.values()].map((entry) => ({
        ...entry.state,
        association: this.associated(entry.row.request.expectedStoreId, entry.row.subjectId)
          ? ('current' as const)
          : ('unavailable' as const),
      })),
    ].map((state) => structuredClone(state));
  }
  get storageUnavailable() {
    return this.unavailable;
  }
  release() {
    this.readEpoch++;
    for (const reader of this.readers) reader.abort();
    this.readers.clear();
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
    return { generation: scope.generation, storeId: scope.storeId };
  }
  private same(scope: Scope) {
    const current = this.current();
    return (
      !!current && current.generation === scope.generation && current.storeId === scope.storeId
    );
  }
  private async reading<T>(scope: Scope, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const reader = new AbortController();
    this.readers.add(reader);
    try {
      const result = await work(reader.signal);
      reader.signal.throwIfAborted();
      if (!this.same(scope)) throw new ClientError('native_generation_changed');
      return result;
    } finally {
      this.readers.delete(reader);
    }
  }
  private observation(id: number) {
    const observed = this.observed;
    if (
      !observed ||
      observed.facts.observationId !== id ||
      !this.same(observed.scope) ||
      !this.associated(observed.scope.storeId, observed.subjectId)
    )
      throw new ClientError('mcp_observation_changed');
    return observed;
  }
  async read(): Promise<NativeUserMcpFacts> {
    if (this.unavailable) throw new ClientError('mcp_storage_unavailable');
    this.release();
    const scope = this.scope(),
      subjectId = this.client.serverInfo?.subjectId;
    if (!subjectId) throw new ClientError('mcp_scope_unavailable');
    const observationId = ++this.sequence;
    return this.reading(scope, async (signal) => {
      const view = await this.client.getUserMcpSettings({ storeId: scope.storeId, signal });
      if (view.scope !== 'user' || view.storeId !== scope.storeId)
        throw new ClientError('mcp_scope_mismatch');
      const facts: NativeUserMcpFacts = {
        kind: 'settings.userMcp',
        observationId,
        storeId: view.storeId,
        canWrite: !!this.data && view.readSet !== null && !view.errors.length,
        errors: [...view.errors],
        sources: structuredClone(view.sources),
      };
      signal.throwIfAborted();
      if (!this.same(scope) || this.client.serverInfo?.subjectId !== subjectId)
        throw new ClientError('native_generation_changed');
      this.observed = {
        scope,
        subjectId,
        view: structuredClone(view),
        facts: structuredClone(facts),
      };
      return facts;
    });
  }
  submit(observationId: number, raw: NativeUserMcpOperation): Promise<NativeUserMcpSubmission> {
    if (this.unavailable || !this.data) throw new ClientError('mcp_storage_unavailable');
    const observed = this.observation(observationId),
      operation = parseNativeUserMcpOperation(raw);
    const source =
      operation.kind === 'add'
        ? undefined
        : observed.view.sources.find((source) => source.id === operation.serverId);
    const cleanupServerId =
      operation.kind === 'disconnect' &&
      source &&
      source.connection.state !== 'disconnected' &&
      (!source.configured || !observed.facts.canWrite)
        ? operation.serverId
        : undefined;
    const cleanup = cleanupServerId !== undefined;
    if (
      !observed.view.readSet ||
      (!observed.facts.canWrite && !cleanup) ||
      (operation.kind !== 'add' && (!source || (!source.configured && !cleanup)))
    )
      throw new ClientError('mcp_source_unavailable');
    const action = `${observationId}:${canonicalModelBody(operation)}`,
      priorId = this.actions.get(action),
      prior = priorId ? this.entries.get(priorId) : undefined;
    if (prior?.promise) return prior.promise;
    if (priorId) throw new ClientError('mcp_intent_consumed');
    if (
      [...this.entries.values()].some(
        (entry) =>
          entry.row.request.storeId === observed.scope.storeId &&
          pending(entry.state.phase) &&
          (!cleanup ||
            (entry.row.request.operation.kind === 'disconnect' &&
              entry.row.request.operation.serverId === cleanupServerId)),
      ) ||
      (!cleanup &&
        [...this.legacy.values()].some(
          (entry) =>
            entry.user &&
            entry.row.request.expectedStoreId === observed.scope.storeId &&
            pending(entry.state.phase),
        ))
    )
      throw new ClientError('mcp_operation_pending');
    if (this.data.userMcps().length + this.data.mcps().length >= 128) {
      const terminal = [...this.entries.values()].find(
        (entry) =>
          !pending(entry.state.phase) &&
          ![...this.actions].some(
            ([key, id]) =>
              id === entry.row.request.commandId && key.startsWith(`${observationId}:`),
          ),
      );
      if (!terminal) throw new ClientError('mcp_capacity_exceeded');
      this.data.clearMcp(terminal.row.request.commandId);
      this.entries.delete(terminal.row.request.commandId);
      for (const [key, id] of this.actions)
        if (id === terminal.row.request.commandId) this.actions.delete(key);
    }
    const request: UserMcpSettingsRequest = {
      storeId: observed.scope.storeId,
      commandId: crypto.randomUUID(),
      expectedReadSet: observed.view.readSet,
      operation,
    };
    const row = parseNativeUserMcpRecord({
      version: 2,
      scope: 'user',
      subjectId: observed.subjectId,
      request,
      bodySha256: mcpSha(canonicalModelBody(request)),
      requestSha256: mcpSha(canonicalUserMcpRequest(request)),
      phase: 'submitting',
    });
    const durable = this.data.beginUserMcp(row);
    if (!durable.created) throw new ClientError('mcp_intent_consumed');
    const entry: Entry = { row: durable.value, state: this.metadata(durable.value) };
    this.entries.set(request.commandId, entry);
    this.actions.set(action, request.commandId);
    this.notify();
    const flight = this.dispatch(entry, observed.scope);
    entry.promise = flight;
    return flight;
  }
  private async dispatch(entry: Entry, scope: Scope) {
    try {
      if (!this.same(scope) || !this.associated(entry.row.request.storeId, entry.row.subjectId))
        throw new ClientError('mcp_scope_mismatch');
      const result = await this.client.updateUserMcpSettings(entry.row.request);
      return this.accept(entry, result);
    } catch (error) {
      return this.unknown(entry, error);
    }
  }
  private accept(entry: Entry, result: UserMcpOperationResult): NativeUserMcpSubmission {
    const request = entry.row.request;
    if (
      result.scope !== 'user' ||
      result.storeId !== request.storeId ||
      result.commandId !== request.commandId ||
      result.expectedReadSet !== request.expectedReadSet ||
      !equal(result.operation, request.operation)
    )
      throw new ClientError('mcp_original_proof_unavailable');
    const phase: NativeMcpPhase =
      result.state === 'applied'
        ? 'completed'
        : result.state === 'failed'
          ? result.receipt.cancelled
            ? 'cancelled'
            : 'failed'
          : result.state;
    if (!['completed', 'failed', 'cancelled'].includes(entry.row.phase))
      entry.row = this.data!.finishUserMcp(request.commandId, phase);
    else if (phase !== entry.row.phase) throw new ClientError('mcp_original_proof_unavailable');
    entry.state = {
      ...this.metadata(entry.row),
      ...(result.receipt.code ? { error: result.receipt.code } : {}),
    };
    this.notify();
    return structuredClone(entry.state);
  }
  private unknown(entry: Entry, error: unknown): NativeUserMcpSubmission {
    if (pending(entry.row.phase)) {
      try {
        entry.row = this.data!.finishUserMcp(entry.row.request.commandId, 'outcome_unknown');
      } catch {
        this.unavailable = true;
      }
      entry.state = { ...this.metadata(entry.row, 'outcome_unknown'), error: errorCode(error) };
    } else entry.state = { ...this.metadata(entry.row), error: errorCode(error) };
    this.notify();
    return structuredClone(entry.state);
  }
  lookup(commandId: string): Promise<NativeUserMcpSubmission> {
    const prior = this.lookups.get(commandId);
    if (prior) return prior;
    const flight = this.lookupOriginal(commandId).finally(() => {
      if (this.lookups.get(commandId) === flight) this.lookups.delete(commandId);
    });
    this.lookups.set(commandId, flight);
    return flight;
  }
  private async lookupOriginal(commandId: string): Promise<NativeUserMcpSubmission> {
    const scope = this.scope(),
      epoch = this.readEpoch,
      entry = this.entries.get(commandId),
      legacy = this.legacy.get(commandId);
    if (legacy) {
      if (!this.associated(legacy.row.request.expectedStoreId, legacy.row.subjectId))
        return { ...legacy.state, association: 'unavailable' };
      const result = await this.reading(scope, (signal) =>
        lookupNativeMcpResult(this.client, legacy.row, signal),
      );
      if (result.association === 'current') {
        if (!['completed', 'failed', 'cancelled'].includes(legacy.row.phase))
          legacy.row = this.data!.finishMcp(commandId, result.phase);
        legacy.state = {
          ...legacy.state,
          phase: legacy.row.phase,
          association: result.association,
          ...(result.error ? { error: result.error } : {}),
        };
      }
      this.notify();
      return structuredClone(legacy.state);
    }
    if (!entry) throw new ClientError('mcp_intent_missing');
    if (!this.associated(entry.row.request.storeId, entry.row.subjectId))
      return { ...entry.state, association: 'unavailable' };
    try {
      const result = await this.reading(scope, (signal) =>
        this.client.getUserMcpOperation(commandId, { storeId: entry.row.request.storeId, signal }),
      );
      return this.accept(entry, result);
    } catch (error) {
      if (!this.same(scope) || epoch !== this.readEpoch) throw error;
      return this.unknown(entry, error);
    }
  }
  async cancel(commandId: string): Promise<NativeUserMcpSubmission> {
    const entry = this.entries.get(commandId);
    if (!entry) throw new ClientError('mcp_cancel_original_unavailable');
    const scope = this.scope();
    if (
      !this.associated(entry.row.request.storeId, entry.row.subjectId) ||
      !pending(entry.state.phase)
    )
      throw new ClientError('mcp_cancel_original_unavailable');
    // Cancel targets the saved global ID. Closing the page only aborts reads.
    try {
      const result = await this.client.cancelUserMcpOperation(commandId, {
        storeId: entry.row.request.storeId,
      });
      if (!this.same(scope)) throw new ClientError('native_generation_changed');
      return this.accept(entry, result);
    } catch (error) {
      if (!this.same(scope)) throw error;
      return this.unknown(entry, error);
    }
  }
  clear(commandId: string) {
    const entry = this.entries.get(commandId) ?? this.legacy.get(commandId);
    if (!entry || pending(entry.state.phase)) throw new ClientError('mcp_clear_unconfirmed');
    this.data!.clearMcp(commandId);
    this.entries.delete(commandId);
    this.legacy.delete(commandId);
    this.notify();
  }
  async tools(
    observationId: number,
    serverId: string,
    generation: number,
    afterIndex?: number,
  ): Promise<NativeUserMcpTools> {
    const observed = this.observation(observationId),
      source = observed.view.sources.find((source) => source.id === serverId);
    if (
      source?.connection.state !== 'ready' ||
      source.connection.generation !== generation ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      (afterIndex !== undefined && (!Number.isSafeInteger(afterIndex) || afterIndex < 0))
    )
      throw new ClientError('mcp_tools_unavailable');
    return this.reading(observed.scope, async (signal) => {
      const page = await this.client.listUserMcpTools(
        {
          storeId: observed.scope.storeId,
          serverId,
          generation,
          ...(afterIndex === undefined ? {} : { afterIndex }),
        },
        { signal },
      );
      if (
        page.scope !== 'user' ||
        page.storeId !== observed.scope.storeId ||
        page.serverId !== serverId ||
        page.generation !== generation
      )
        throw new ClientError('mcp_tools_unavailable');
      return { kind: 'settings.userMcp.tools', observationId, page };
    });
  }
}
