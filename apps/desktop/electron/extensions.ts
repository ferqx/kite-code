import { createHash } from 'node:crypto';
import {
  type AgentClient,
  type Command,
  canonicalModelBody,
  type ExtensionCatalogue,
  type ExtensionCommandRequest,
  type PublicView,
} from '@kite-ai/client';
import type {
  NativeExtensionChunk,
  NativeExtensionHead,
  NativeExtensionScope,
  NativeExtensionSubmission,
  NativeExtensionsRequest,
} from '../src/extensions-bridge';
import type { NativeCallerRecord } from '../src/native-bridge';
import { callerMetadata } from './caller-journal';

export type NativeExtensionsPort = {
  prepare(sessionId: string, request: ExtensionCommandRequest): Promise<NativeCallerRecord>;
  submit(commandId: string): Promise<Command>;
  lookup(commandId: string): Promise<Command>;
  records(): NativeCallerRecord[];
  releaseFirst(commandId: string): void;
};
type Observation = {
  id: number;
  ready: boolean;
  subjectId: string;
  scope: NativeExtensionScope;
  catalogue: ExtensionCatalogue[];
  views?: PublicView[];
};
type Body = {
  readId: string;
  observation: Observation;
  abort: AbortController;
  bytes?: Buffer;
  offset: number;
  content: 'catalogue' | 'views';
};
type Request<M extends NativeExtensionsRequest['method']> = Extract<
  NativeExtensionsRequest,
  { method: M }
>;
const same = (left: unknown, right: unknown) =>
  canonicalModelBody(left) === canonicalModelBody(right);
const unavailable = (): never => {
  throw Error('extensions_observation_unavailable');
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Main owns observed definitions and first-submit authority; renderers receive immutable bounded bodies. */
export class NativeExtensions {
  private serial = 0;
  private catalogue?: Observation;
  private views?: Observation;
  private readonly bodies = new Map<string, Body>();
  private readonly client: AgentClient;
  private readonly current: () => NativeExtensionScope | undefined;
  private readonly port: NativeExtensionsPort;
  constructor(
    client: AgentClient,
    current: () => NativeExtensionScope | undefined,
    port: NativeExtensionsPort,
  ) {
    this.client = client;
    this.current = current;
    this.port = port;
  }

  private check(observation: Observation) {
    const actual = this.current();
    if (
      !actual ||
      !same(actual, observation.scope) ||
      this.client.serverInfo?.storeId !== observation.scope.storeId ||
      this.client.serverInfo.subjectId !== observation.subjectId ||
      (this.catalogue !== observation && this.views !== observation)
    )
      unavailable();
  }
  private observation(id: number) {
    const observation =
      this.catalogue?.id === id ? this.catalogue : this.views?.id === id ? this.views : undefined;
    if (!observation) return unavailable();
    this.check(observation);
    if (!observation.ready) unavailable();
    return observation;
  }
  private allocate(readId: string, observation: Observation, content: Body['content']) {
    if (this.bodies.has(readId) || this.bodies.size >= 2)
      throw Error('extensions_read_capacity_exceeded');
    const body: Body = { readId, observation, abort: new AbortController(), offset: 0, content };
    this.bodies.set(readId, body);
    return body;
  }
  private checkBody(body: Body) {
    if (this.bodies.get(body.readId) !== body || body.abort.signal.aborted) unavailable();
    // Replaced action observations may still finish their already-fixed immutable body.
    const scope = this.current();
    if (
      !scope ||
      !same(scope, body.observation.scope) ||
      this.client.serverInfo?.storeId !== body.observation.scope.storeId ||
      this.client.serverInfo.subjectId !== body.observation.subjectId
    )
      unavailable();
  }
  private head(body: Body, value: ExtensionCatalogue[] | PublicView[]): NativeExtensionHead {
    this.checkBody(body);
    body.bytes = Buffer.from(JSON.stringify(value));
    return {
      kind: 'extensions.head',
      readId: body.readId,
      observationId: body.observation.id,
      scope: structuredClone(body.observation.scope),
      bodyBytes: body.bytes.length,
      sha256: createHash('sha256').update(body.bytes).digest('hex'),
      content: body.content,
    };
  }
  async open(input: Request<'extensions.open'>) {
    this.release();
    const scope = this.current();
    if (
      !scope ||
      scope.generation !== input.generation ||
      scope.viewSelection !== input.viewSelection ||
      scope.historyEpoch !== input.historyEpoch
    )
      throw Error('extensions_observation_unavailable');
    const observation: Observation = {
      id: ++this.serial,
      ready: false,
      subjectId: this.client.serverInfo?.subjectId ?? '',
      scope: structuredClone(scope),
      catalogue: [],
    };
    this.catalogue = observation;
    const body = this.allocate(input.readId, observation, 'catalogue');
    try {
      const catalogue = await this.client.listExtensions({ signal: body.abort.signal });
      this.check(observation);
      observation.catalogue = structuredClone(catalogue);
      return this.head(body, catalogue);
    } catch (error) {
      if (this.bodies.get(input.readId) === body) this.close(input.readId);
      if (this.catalogue === observation) this.catalogue = undefined;
      throw error;
    }
  }
  async query(input: Request<'extensions.query'>) {
    const parent = this.observation(input.observationId);
    if (input.generation !== parent.scope.generation) unavailable();
    if (
      !parent.catalogue
        .find((extension) => extension.extensionId === input.extensionId)
        ?.queries.some((query) => query.id === input.queryId)
    )
      unavailable();
    const observation: Observation = {
      id: ++this.serial,
      ready: false,
      subjectId: parent.subjectId,
      scope: structuredClone(parent.scope),
      catalogue: parent.catalogue,
    };
    const body = this.allocate(input.readId, observation, 'views');
    this.views = observation;
    try {
      const views = await this.client.queryExtension(
        parent.scope.sessionId,
        input.extensionId,
        input.queryId,
        input.input,
        { signal: body.abort.signal },
      );
      this.check(observation);
      if (views.some((view) => view.extensionId !== input.extensionId))
        throw Error('extensions_result_scope_mismatch');
      observation.views = structuredClone(views);
      return this.head(body, views);
    } catch (error) {
      if (this.bodies.get(input.readId) === body) this.close(input.readId);
      if (this.views === observation) this.views = undefined;
      throw error;
    }
  }
  read(input: Request<'extensions.read'>): NativeExtensionChunk {
    const body = this.bodies.get(input.readId);
    if (!body?.bytes) return unavailable();
    this.checkBody(body);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset !== body.offset ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 65536
    )
      throw Error('extensions_read_invalid');
    const end = Math.min(body.bytes.length, input.offset + input.limit);
    const data = body.bytes.subarray(input.offset, end).toString('base64');
    body.offset = end;
    if (end === body.bytes.length) body.observation.ready = true;
    return {
      kind: 'extensions.chunk',
      readId: input.readId,
      offset: input.offset,
      nextOffset: end,
      eof: end === body.bytes.length,
      data,
    };
  }
  close(readId: string) {
    this.bodies.get(readId)?.abort.abort();
    this.bodies.delete(readId);
  }
  release() {
    for (const body of this.bodies.values()) body.abort.abort();
    this.bodies.clear();
    this.catalogue = undefined;
    this.views = undefined;
  }
  async invoke(input: Request<'extensions.invoke'>): Promise<NativeExtensionSubmission> {
    const observation = this.observation(input.observationId);
    if (input.generation !== observation.scope.generation) unavailable();
    const definition = observation.catalogue
      .find((extension) => extension.extensionId === input.extensionId)
      ?.actions.find(
        (action) => action.id === input.actionId && action.version === input.definitionVersion,
      );
    if (!definition) unavailable();
    if (input.viewIndex !== undefined || input.actionIndex !== undefined) {
      if (!Number.isSafeInteger(input.viewIndex) || !Number.isSafeInteger(input.actionIndex))
        unavailable();
      const view = observation.views?.[input.viewIndex!],
        action = view?.actions[input.actionIndex!];
      if (
        !view ||
        view.extensionId !== input.extensionId ||
        !action ||
        action.actionId !== input.actionId ||
        action.definitionVersion !== input.definitionVersion ||
        !same(action.input, input.input)
      )
        unavailable();
    }
    const request: ExtensionCommandRequest = {
      kind: 'extension.invoke',
      expectedStoreId: observation.scope.storeId,
      commandId: input.commandId,
      extensionId: input.extensionId,
      actionId: input.actionId,
      definitionVersion: input.definitionVersion,
      input: structuredClone(input.input),
    };
    const row = await this.port.prepare(observation.scope.sessionId, request);
    try {
      this.check(observation);
    } catch (error) {
      this.port.releaseFirst(input.commandId);
      throw error;
    }
    try {
      return await this.project(row, await this.port.submit(input.commandId));
    } catch {
      return this.unknown(input.commandId);
    }
  }
  private unknown(commandId: string): NativeExtensionSubmission {
    const row = this.port
      .records()
      .find(
        (value) =>
          value.intent.request.commandId === commandId &&
          value.intent.request.kind === 'extension.invoke',
      );
    if (!row) throw Error('extensions_original_unavailable');
    return { kind: 'extensions.command', metadata: callerMetadata(row), outcome: 'unknown' };
  }
  async lookup(commandId: string): Promise<NativeExtensionSubmission> {
    const row = this.port
      .records()
      .find(
        (value) =>
          value.intent.request.commandId === commandId &&
          value.intent.request.kind === 'extension.invoke',
      );
    if (!row) throw Error('extensions_original_unavailable');
    if (
      this.client.serverInfo?.storeId !== row.intent.scope.storeId ||
      this.client.serverInfo.subjectId !== row.intent.subjectId
    )
      return this.unknown(commandId);
    try {
      return await this.project(row, await this.port.lookup(commandId));
    } catch {
      return this.unknown(commandId);
    }
  }
  private async project(
    row: NativeCallerRecord,
    command: Command,
  ): Promise<NativeExtensionSubmission> {
    const i = row.intent,
      r = i.request;
    if (r.kind !== 'extension.invoke') throw Error('extensions_original_unavailable');
    if (
      command.id !== r.commandId ||
      command.kind !== r.kind ||
      command.originStoreId !== i.scope.storeId ||
      command.sessionId !== i.scope.sessionId ||
      command.subjectId !== i.subjectId ||
      command.requestDigest !== i.requestDigest
    )
      unavailable();
    const view = await this.client.getView(i.scope.sessionId);
    if (
      view.storeId !== i.scope.storeId ||
      view.session.id !== i.scope.sessionId ||
      view.session.workspaceId !== i.scope.workspaceId ||
      this.client.serverInfo?.storeId !== i.scope.storeId ||
      this.client.serverInfo.subjectId !== i.subjectId
    )
      unavailable();
    const result: NativeExtensionSubmission = {
      kind: 'extensions.command',
      metadata: callerMetadata(
        this.port.records().find((value) => value.intent.request.commandId === r.commandId) ?? row,
      ),
      commandStatus: command.status,
      outcome: 'unknown',
    };
    if (command.status === 'rejected') return { ...result, outcome: 'rejected' };
    if (command.status === 'accepted') return { ...result, outcome: 'accepted' };
    const receipt = object(command.receipt);
    if (command.status !== 'applied' || typeof receipt.executionId !== 'string') return result;
    const e = await this.client.getExecution(receipt.executionId);
    if (
      e.id !== receipt.executionId ||
      e.originStoreId !== i.scope.storeId ||
      e.sessionId !== i.scope.sessionId ||
      e.runId !== null ||
      e.parentExecutionId !== null ||
      e.kind !== 'job' ||
      e.definitionId !== `${r.extensionId}/${r.actionId}` ||
      e.definitionVersion !== r.definitionVersion ||
      this.client.serverInfo?.storeId !== i.scope.storeId ||
      this.client.serverInfo.subjectId !== i.subjectId
    )
      unavailable();
    result.execution = { id: e.id, status: e.status, resultRevision: e.resultRevision };
    if (['planned', 'dispatching', 'running'].includes(e.status))
      return { ...result, outcome: 'running' };
    if (
      receipt.status !== e.status ||
      receipt.preparingNextAttempt !== false ||
      typeof receipt.finalizationDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.finalizationDigest) ||
      !/^[1-9][0-9]{0,18}$/.test(e.resultRevision) ||
      BigInt(e.resultRevision) > 9223372036854775807n
    )
      return result;
    return {
      ...result,
      outcome:
        e.status === 'outcome_unknown'
          ? 'unknown'
          : (e.status as 'succeeded' | 'failed' | 'cancelled'),
    };
  }
}
