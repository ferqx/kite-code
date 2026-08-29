import type { KiteWorkspaceIdentity, WebSessionStatus } from '@kite-ai/kite-app-contract';
import {
  createNativeRuntimeHistoryClient,
  createNativeRuntimeWebSocketTransport,
  LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME,
  type LocalRuntimeFetch,
  type NativeRuntimeHistoryClient,
  type NativeRuntimeWebSocketFactory,
} from '@kite-ai/kite-local-runtime/client';
import {
  COORDINATOR_LIMITS,
  type CoordinatorListSessionMetadataResult,
  type CoordinatorMethod,
  type CoordinatorRequestClient,
  type CoordinatorResponseFor,
  type CoordinatorResultByMethod,
  type CoordinatorSessionMetadata,
  type CoordinatorSuccessResponse,
  type CoordinatorWorkerReference,
  type CoordinatorWorkspaceIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import {
  decodeLocalRuntimeServiceDescriptor,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  type LocalRuntimeServiceDescriptor,
} from '@kite-ai/kite-local-runtime/service';
import { RuntimeClient, type RuntimeClientInfo } from '@kite-ai/runtime-client';
import type {
  RuntimeAccessNotification,
  RuntimeClientEvent,
  RuntimeHistorySessionTranscript,
  RuntimeLogSessionEntry,
} from '@kite-ai/runtime-contract';
import {
  createWebObserverCore,
  type WebObserverCore,
  type WebObserverDirectoryPort,
  type WebObserverHistoryPort,
  type WebObserverHistoryTranscript,
  type WebObserverLiveInput,
  type WebObserverLivePort,
} from '../web-observer';
import {
  KITE_WORKER_CLIENT_ID_HEADER,
  KITE_WORKER_CONNECTION_GENERATION_HEADER,
  KITE_WORKER_PURPOSE_HEADER,
} from '../workspace-worker/control-carrier';
import type { OfflineWebHistoryPort } from './offline-history';

const WORKER_CAPABILITY_PURPOSE = 'web_observer' as const;
const MAX_LABEL_LENGTH = 256;
const MAX_HISTORY_SESSIONS = 256;
const MAX_CLIENT_ID_LENGTH = 256;
const INTERNAL_NOOP_EVENT: RuntimeClientEvent = {
  type: 'interaction_mode.changed',
  mode: 'auto',
};

/**
 * The native Worker adapter used by the private Web Gateway BFF.  All
 * browser-facing values are produced by Web Observer's closed presentation
 * core; this object retains the Worker path, endpoint and capability only in
 * the Gateway process.
 */
export interface WorkspaceWorkerWebGatewayUpstreamOptions {
  readonly coordinator: CoordinatorRequestClient;
  readonly gatewayInstanceId: string;
  readonly contractRevision: string;
  /** Optional Coordinator-owned, path-free project label. */
  readonly workspaceLabel?: (workspace: CoordinatorWorkspaceIdentity) => string;
  readonly fetch?: LocalRuntimeFetch;
  readonly webSocketFactory?: NativeRuntimeWebSocketFactory;
  /** Service-owned Store 7 query facade used only when no Worker route is available. */
  readonly offlineHistory?: OfflineWebHistoryPort;
  readonly now?: () => number;
}

export interface WorkspaceWorkerWebGatewayObserverBinding {
  readonly tabHandle: string;
  readonly connectionGeneration: number;
}

export interface WorkspaceWorkerWebGatewayUpstream {
  readonly createObserver: (binding: WorkspaceWorkerWebGatewayObserverBinding) => WebObserverCore;
  /** Releases only Worker data-plane clients/subscriptions owned by this Gateway instance. */
  readonly close: () => Promise<void>;
}

/** Alias named after the Gateway boundary used by production composition code. */
export const createWebGatewayUpstream = createWorkspaceWorkerWebGatewayUpstream;

export function createWorkspaceWorkerWebGatewayUpstream(
  options: WorkspaceWorkerWebGatewayUpstreamOptions,
): WorkspaceWorkerWebGatewayUpstream {
  assertSafeIdentifier(options.gatewayInstanceId, 'gatewayInstanceId');
  assertSafeIdentifier(options.contractRevision, 'contractRevision');
  const now = options.now ?? Date.now;
  const observers = new Set<ObserverAdapter>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    createObserver(binding: WorkspaceWorkerWebGatewayObserverBinding): WebObserverCore {
      if (!Number.isSafeInteger(binding.connectionGeneration) || binding.connectionGeneration < 1) {
        // The Web carrier creates a bootstrap Observer before a browser tab has a generation.
        // It can answer bootstrap only; native Worker access is deliberately unavailable.
        if (binding.connectionGeneration !== 0) {
          throw new TypeError('Web Observer connection generation is invalid.');
        }
      }
      assertOpaqueTabHandle(binding.tabHandle);
      if (closed) throw new Error('Web Gateway upstream is closed.');
      const adapter = new ObserverAdapter(options, binding, now, () => closed);
      observers.add(adapter);
      const core = createWebObserverCore({
        gatewayInstanceId: options.gatewayInstanceId,
        contractRevision: options.contractRevision,
        createTabBinding: () => binding,
        directory: adapter.directory,
        history: adapter.history,
        live: adapter.live,
      });
      return Object.freeze({
        ...core,
        disconnect: async (request: Parameters<WebObserverCore['disconnect']>[0]) => {
          const response = await core.disconnect(request);
          await adapter.close();
          observers.delete(adapter);
          return response;
        },
      });
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        closed = true;
        const failures: unknown[] = [];
        for (const observer of observers) {
          try {
            await observer.close();
          } catch (error) {
            failures.push(error);
          }
        }
        observers.clear();
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures);
      })();
      return closePromise;
    },
  });
}

class ObserverAdapter {
  readonly directory: WebObserverDirectoryPort;
  readonly history: WebObserverHistoryPort;
  readonly live: WebObserverLivePort;
  readonly #options: WorkspaceWorkerWebGatewayUpstreamOptions;
  readonly #binding: WorkspaceWorkerWebGatewayObserverBinding;
  readonly #now: () => number;
  readonly #isClosed: () => boolean;
  readonly #workers = new Map<string, WorkerBinding>();
  readonly #workerCreates = new Map<string, Promise<WorkerBinding>>();
  #closed = false;

  constructor(
    options: WorkspaceWorkerWebGatewayUpstreamOptions,
    binding: WorkspaceWorkerWebGatewayObserverBinding,
    now: () => number,
    isClosed: () => boolean,
  ) {
    this.#options = options;
    this.#binding = binding;
    this.#now = now;
    this.#isClosed = isClosed;
    this.directory = Object.freeze({ list: () => this.listDirectory() });
    this.history = Object.freeze({
      loadSession: (sessionId: string) => this.loadHistory(sessionId),
    });
    this.live = Object.freeze({
      subscribe: (input: Parameters<WebObserverLivePort['subscribe']>[0]) =>
        this.subscribeLive(input),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const bindings = [...this.#workers.values()];
    this.#workers.clear();
    this.#workerCreates.clear();
    const failures: unknown[] = [];
    for (const binding of bindings) {
      try {
        await binding.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures);
  }

  private async listDirectory(): Promise<readonly WebDirectoryEntry[]> {
    this.ensureOpen();
    const metadata = await listAllMetadata(this.#options.coordinator);
    const groups = new Map<string, DirectoryGroup>();
    for (const entry of metadata) {
      const existing = groups.get(entry.workerScopeId);
      const group = existing ?? {
        workerScopeId: entry.workerScopeId,
        entries: [],
      };
      let resolved: CoordinatorResultByMethod['resolveSessionWorkspace'];
      try {
        resolved = coordinatorResult(
          await this.#options.coordinator.resolveSessionWorkspace({ sessionId: entry.sessionId }),
        );
      } catch {
        // Catalog metadata still carries the stable path-free Worker scope. Preserve the
        // existing Session in an unavailable group instead of making an idle Workspace vanish.
        group.entries.push({ metadata: entry });
        groups.set(entry.workerScopeId, group);
        continue;
      }
      if (resolved.workerScopeId !== entry.workerScopeId) {
        throw unavailable('Coordinator returned a mismatched Worker scope.');
      }
      const workspace = toWorkspaceIdentity(resolved.workspace);
      if (resolved.worker !== null) assertWorkerReference(resolved.worker, workspace);
      if (group.workspace !== undefined && !sameWorkspace(group.workspace, workspace)) {
        throw unavailable('Coordinator returned conflicting Workspace identities.');
      }
      if (
        group.source !== undefined &&
        group.source !== null &&
        resolved.worker !== null &&
        !sameWorkerReference(group.source, resolved.worker)
      ) {
        throw unavailable('Coordinator returned a changing Worker identity.');
      }
      if (group.source !== undefined && (group.source === null) !== (resolved.worker === null)) {
        throw unavailable('Coordinator returned an inconsistent Worker route.');
      }
      group.workspace = workspace;
      group.source = resolved.worker;
      group.entries.push({ metadata: entry });
      groups.set(entry.workerScopeId, group);
    }

    const output: WebDirectoryEntry[] = [];
    for (const group of groups.values()) {
      let historyEntries: ReadonlyMap<string, RuntimeLogSessionEntry> = new Map();
      let workerUnavailable = group.workspace === undefined || group.source == null;
      let workerBinding: WorkerBinding | undefined;
      const statuses = new Map<string, WebSessionStatus>();
      if (
        !workerUnavailable &&
        group.workspace !== undefined &&
        group.source !== undefined &&
        group.source !== null &&
        this.#binding.connectionGeneration >= 1
      ) {
        try {
          workerBinding = await this.workerFor(group.workspace, group.source);
          historyEntries = await loadAllWorkerSessions(workerBinding.history);
          await workerBinding.runtime.connect();
          for (const { metadata } of group.entries) {
            statuses.set(
              metadata.sessionId,
              await statusForSession(workerBinding, metadata.sessionId),
            );
          }
        } catch {
          workerUnavailable = true;
        }
      } else if (this.#binding.connectionGeneration < 1) {
        workerUnavailable = true;
      }
      const sessions = group.entries
        .map(({ metadata }) => {
          const entry = historyEntries.get(metadata.sessionId);
          const status = workerUnavailable
            ? ('unavailable' as const)
            : (statuses.get(metadata.sessionId) ?? ('unavailable' as const));
          return {
            sessionId: metadata.sessionId,
            displayName: displayNameFor(entry?.displayName, metadata.sessionId),
            updatedAt: entry?.updatedAt ?? parseTimestamp(metadata.updatedAt),
            lastSequence: entry?.lastSequence ?? 0,
            status: metadata.tombstone ? ('unavailable' as const) : status,
          };
        })
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId),
        );
      output.push({
        workspaceId: group.workerScopeId,
        label:
          group.workspace === undefined
            ? unavailableWorkspaceLabel(group.workerScopeId)
            : this.labelFor(group.workspace),
        sessions,
      });
    }
    return output.sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.workspaceId.localeCompare(right.workspaceId),
    );
  }

  private async loadHistory(sessionId: string): Promise<WebObserverHistoryTranscript> {
    this.ensureOpen();
    assertSessionId(sessionId);
    if (this.#binding.connectionGeneration < 1) throw unavailable('Observer tab is unavailable.');
    const metadata = (await listAllMetadata(this.#options.coordinator)).find(
      (entry) => entry.sessionId === sessionId,
    );
    if (!metadata || metadata.tombstone) throw unavailable('Session History is unavailable.');
    let resolved: CoordinatorResultByMethod['resolveSessionWorkspace'] | undefined;
    try {
      resolved = coordinatorResult(
        await this.#options.coordinator.resolveSessionWorkspace({ sessionId }),
      );
    } catch {
      resolved = undefined;
    }
    if (resolved && resolved.workerScopeId !== metadata.workerScopeId) {
      throw unavailable('Coordinator returned a mismatched Worker scope.');
    }
    if (resolved?.worker) {
      try {
        const workspace = toWorkspaceIdentity(resolved.workspace);
        assertWorkerReference(resolved.worker, workspace);
        const worker = await this.workerFor(workspace, resolved.worker);
        const transcript = await worker.history.loadSession(sessionId);
        if (transcript.session.sessionId !== sessionId) {
          throw new Error('Worker History returned a mismatched Session.');
        }
        return historyTranscript(sessionId, transcript);
      } catch {
        // The current-format Store reader below remains available when a
        // routed Worker exits between resolve and History load.
      }
    }
    const offline = this.#options.offlineHistory;
    if (!offline) throw unavailable('Worker History is unavailable.');
    try {
      const transcript = await offline.loadSession({
        workerScopeId: metadata.workerScopeId,
        sessionId,
      });
      if (transcript.sessionId !== sessionId) {
        throw new Error('Offline History returned a mismatched Session.');
      }
      return transcript;
    } catch {
      throw unavailable('Session History is unavailable.');
    }
  }

  private subscribeLive(input: {
    readonly sessionId: string;
    readonly afterSequence?: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<WebObserverLiveInput> {
    assertSessionId(input.sessionId);
    if (this.#closed || this.#isClosed()) {
      throw unavailable('Web Gateway upstream is closed.');
    }
    return {
      [Symbol.asyncIterator]: () => this.liveIterator(input),
    };
  }

  private liveIterator(input: {
    readonly sessionId: string;
    readonly afterSequence?: number;
    readonly signal: AbortSignal;
  }): AsyncIterator<WebObserverLiveInput> {
    const controller = new AbortController();
    let source: AsyncIterator<RuntimeAccessNotification> | undefined;
    let start: Promise<void> | undefined;
    let expected = input.afterSequence;
    let finished = false;
    let released = false;
    let workerBinding: WorkerBinding | undefined;

    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      input.signal.removeEventListener('abort', abort);
      // RuntimeClient's iterable return callback deliberately sends a remote
      // unsubscribe without exposing its completion promise. Close the
      // Worker client instead: RuntimeClient then tears down its subscription
      // locally without leaving an unobserved unsubscribe request rejection.
      // The one-shot Worker capability also makes a fresh connection on this
      // tab/generation unsafe; a new tab obtains a new generation/capability.
      await workerBinding?.close();
    };

    const abort = (): void => {
      finished = true;
      void release();
    };
    if (input.signal.aborted) abort();
    else input.signal.addEventListener('abort', abort, { once: true });

    const startSource = async (): Promise<void> => {
      if (released || this.#closed || this.#isClosed()) {
        throw unavailable('Web Gateway upstream is closed.');
      }
      const resolved = coordinatorResult(
        await this.#options.coordinator.resolveSessionWorkspace({ sessionId: input.sessionId }),
      );
      const workspace = toWorkspaceIdentity(resolved.workspace);
      if (resolved.worker === null) throw unavailable('Worker route is unavailable.');
      assertWorkerReference(resolved.worker, workspace);
      if (this.#binding.connectionGeneration < 1) throw unavailable('Observer tab is unavailable.');
      workerBinding = await this.workerFor(workspace, resolved.worker);
      if (released) {
        await workerBinding.close();
        throw unavailable('Worker subscription was released.');
      }
      const transcript = await workerBinding.history.loadSession(input.sessionId);
      if (transcript.session.sessionId !== input.sessionId) {
        throw unavailable('Worker History returned a mismatched Session.');
      }
      if (expected === undefined) expected = transcript.session.lastSequence;
      if (expected > transcript.session.lastSequence) {
        // The Web core performs its own exact History fold. This adapter keeps
        // the native source cursor conservative and lets a subsequent durable
        // gap produce the typed Web resync event.
        expected = transcript.session.lastSequence;
      }
      await workerBinding.runtime.connect();
      const iterable = await workerBinding.runtime.subscribeReady({
        spec: {
          scope: 'session',
          sessionId: input.sessionId,
          ...(expected === undefined ? {} : { afterRevision: expected }),
          includeEphemeral: false,
        },
        signal: controller.signal,
      });
      source = iterable[Symbol.asyncIterator]();
    };

    const next = async (): Promise<IteratorResult<WebObserverLiveInput>> => {
      if (finished) return { done: true, value: undefined };
      start ??= startSource();
      try {
        await start;
        if (!source) throw unavailable('Worker subscription is unavailable.');
        for (;;) {
          if (released) {
            finished = true;
            await release();
            return { done: true, value: undefined };
          }
          const result = await source.next();
          if (result.done) {
            finished = true;
            await release();
            if (input.signal.aborted) return { done: true, value: undefined };
            throw unavailable('Worker subscription ended.');
          }
          const notification = result.value;
          if (!isDurableNotification(notification)) {
            // Ephemeral sequence numbers are stream-local and do not prove a
            // History sequence. They must never become Web presentation input.
            continue;
          }
          const projected = durableLiveInput(notification, input.sessionId, expected);
          if (projected === undefined) {
            // A malformed durable identity cannot be made safe by guessing;
            // terminate the adapter and let the core emit unavailable.
            finished = true;
            await release();
            throw unavailable('Worker durable notification is invalid.');
          }
          if (projected.sequence <= (expected ?? -1)) continue;
          expected = projected.sequence;
          return { done: false, value: projected };
        }
      } catch (error) {
        finished = true;
        await release();
        throw error;
      }
    };

    return {
      next,
      return: async () => {
        finished = true;
        await release();
        return { done: true, value: undefined };
      },
    };
  }

  private async workerFor(
    workspace: KiteWorkspaceIdentity,
    reference: CoordinatorWorkerReference,
  ): Promise<WorkerBinding> {
    this.ensureOpen();
    assertWorkerReference(reference, workspace);
    const workerScopeId = reference.identity.workerScopeId;
    const existing = this.#workers.get(workerScopeId);
    if (existing) {
      if (existing.expiresAtMs <= this.#now()) {
        throw unavailable('Worker capability expired.');
      }
      if (
        !sameWorkspace(existing.workspace, workspace) ||
        !sameWorkerReference(existing.reference, reference)
      ) {
        throw unavailable('Worker identity changed during an Observer session.');
      }
      return existing;
    }
    const pending = this.#workerCreates.get(workerScopeId);
    if (pending !== undefined) {
      const binding = await pending;
      if (
        !sameWorkspace(binding.workspace, workspace) ||
        !sameWorkerReference(binding.reference, reference)
      ) {
        throw unavailable('Worker identity changed while creating an Observer client.');
      }
      return binding;
    }
    const creation = this.createWorkerBinding(workspace, reference);
    this.#workerCreates.set(workerScopeId, creation);
    try {
      return await creation;
    } finally {
      if (this.#workerCreates.get(workerScopeId) === creation) {
        this.#workerCreates.delete(workerScopeId);
      }
    }
  }

  private async createWorkerBinding(
    workspace: KiteWorkspaceIdentity,
    reference: CoordinatorWorkerReference,
  ): Promise<WorkerBinding> {
    const workerScopeId = reference.identity.workerScopeId;
    const clientId = clientIdFor(this.#binding.tabHandle, workerScopeId);
    const minted = coordinatorResult(
      await this.#options.coordinator.mintWorkerConnectionCapability({
        workspace: reference.workspace,
        workerScopeId,
        clientId,
        connectionGeneration: this.#binding.connectionGeneration,
        purpose: WORKER_CAPABILITY_PURPOSE,
      }),
    );
    assertWorkerReference(minted.worker, workspace);
    if (
      minted.clientId !== clientId ||
      minted.connectionGeneration !== this.#binding.connectionGeneration ||
      minted.purpose !== WORKER_CAPABILITY_PURPOSE ||
      !safeCapability(minted.workerConnectionCapability) ||
      !safeTimestamp(minted.expiresAt)
    ) {
      throw unavailable('Worker capability response is invalid.');
    }
    if (!sameWorkerReference(minted.worker, reference)) {
      throw unavailable('Worker changed while minting an Observer capability.');
    }
    const expiresAtMs = Date.parse(minted.expiresAt);
    if (expiresAtMs <= this.#now()) throw unavailable('Worker capability is expired.');
    const descriptor = workerDescriptor(minted.worker);
    const request = createWorkerHttpRequest({
      reference: minted.worker,
      capability: minted.workerConnectionCapability,
      clientId,
      connectionGeneration: this.#binding.connectionGeneration,
      fetch: this.#options.fetch,
    });
    const history = createNativeRuntimeHistoryClient(request);
    const transport = createNativeRuntimeWebSocketTransport({
      descriptor,
      accessToken: minted.workerConnectionCapability,
      workspace: minted.worker.workspace.canonicalPath,
      fetch: requestFetch({
        reference: minted.worker,
        capability: minted.workerConnectionCapability,
        clientId,
        connectionGeneration: this.#binding.connectionGeneration,
        fetch: this.#options.fetch,
      }),
      webSocketFactory: this.#options.webSocketFactory,
    });
    const runtime = new RuntimeClient({
      transport,
      clientInfo: clientInfo(this.#options.gatewayInstanceId, this.#binding.tabHandle),
      history,
    });
    if (this.#closed || this.#isClosed()) {
      await runtime.close('web_observer_upstream_closed');
      throw unavailable('Web Gateway upstream is closed.');
    }
    const binding: WorkerBinding = {
      workspace,
      reference: minted.worker,
      clientId,
      connectionGeneration: this.#binding.connectionGeneration,
      capability: minted.workerConnectionCapability,
      expiresAtMs,
      descriptor,
      history,
      runtime,
      close: async () => runtime.close('web_observer_disconnected'),
    };
    this.#workers.set(workerScopeId, binding);
    return binding;
  }

  private labelFor(workspace: KiteWorkspaceIdentity): string {
    const candidate =
      this.#options.workspaceLabel?.({
        canonicalPath: workspace.canonicalPath,
        projectId: workspace.projectId,
        workspaceDigest: workspace.workspaceDigest,
      }) ?? workspace.projectId;
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.length > MAX_LABEL_LENGTH ||
      /\p{Cc}/u.test(candidate) ||
      candidate.startsWith('/') ||
      candidate.includes('\\') ||
      /^[A-Za-z]:/u.test(candidate)
    ) {
      throw unavailable('Workspace label is invalid.');
    }
    return candidate;
  }

  private ensureOpen(): void {
    if (this.#closed || this.#isClosed()) throw unavailable('Web Gateway upstream is closed.');
  }
}

interface WorkerBinding {
  readonly workspace: KiteWorkspaceIdentity;
  readonly reference: CoordinatorWorkerReference;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly capability: string;
  readonly expiresAtMs: number;
  readonly descriptor: LocalRuntimeServiceDescriptor;
  readonly history: NativeRuntimeHistoryClient;
  readonly runtime: RuntimeClient;
  readonly close: () => Promise<void>;
}

interface DirectoryGroup {
  readonly workerScopeId: string;
  workspace?: KiteWorkspaceIdentity;
  source?: CoordinatorWorkerReference | null;
  readonly entries: Array<{
    readonly metadata: CoordinatorSessionMetadata;
  }>;
}

function unavailableWorkspaceLabel(workerScopeId: string): string {
  const suffix = workerScopeId.slice(-8);
  return `Workspace ${suffix}`;
}

type WebDirectoryEntry = Awaited<ReturnType<WebObserverDirectoryPort['list']>>[number];

async function listAllMetadata(
  coordinator: CoordinatorRequestClient,
): Promise<readonly CoordinatorSessionMetadata[]> {
  const entries: CoordinatorSessionMetadata[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page: CoordinatorListSessionMetadataResult = coordinatorResult(
      await coordinator.listSessionMetadata({
        limit: COORDINATOR_LIMITS.maxDirectoryEntries,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    for (const entry of page.entries) {
      if (seen.has(entry.sessionId)) throw unavailable('Coordinator repeated a Session identity.');
      seen.add(entry.sessionId);
      entries.push(entry);
      if (entries.length >= COORDINATOR_LIMITS.maxDirectoryEntries) return entries;
    }
    if (page.nextCursor === undefined) return entries;
    if (page.nextCursor === cursor || page.entries.length === 0) {
      throw unavailable('Coordinator metadata pagination did not advance.');
    }
    cursor = page.nextCursor;
  }
}

async function loadAllWorkerSessions(
  history: NativeRuntimeHistoryClient,
): Promise<ReadonlyMap<string, RuntimeLogSessionEntry>> {
  const entries = new Map<string, RuntimeLogSessionEntry>();
  let cursor: { readonly updatedAt: number; readonly sessionId: string } | undefined;
  for (;;) {
    const page = await history.listSessions({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const entry of page.entries) {
      if (entries.has(entry.sessionId)) throw unavailable('Worker History repeated a Session.');
      entries.set(entry.sessionId, entry);
      if (entries.size >= MAX_HISTORY_SESSIONS) return entries;
    }
    if (!page.hasMore) return entries;
    const next = page.nextCursor;
    if (
      next === undefined ||
      (cursor !== undefined &&
        (next.updatedAt >= cursor.updatedAt ||
          (next.updatedAt === cursor.updatedAt && next.sessionId >= cursor.sessionId)))
    ) {
      throw unavailable('Worker History pagination did not advance.');
    }
    cursor = next;
  }
}

function createWorkerHttpRequest(input: {
  readonly reference: CoordinatorWorkerReference;
  readonly capability: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly fetch?: LocalRuntimeFetch;
}): (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const origin = input.reference.endpoint.origin;
  return async (path, body, signal) => {
    assertHistoryPath(path);
    const url = exactWorkerUrl(origin, path);
    const response = await fetcher(url, {
      method: 'POST',
      headers: workerHeaders(input.capability, input.clientId, input.connectionGeneration),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(body),
      signal,
    });
    if (response.status !== 200) throw unavailable('Worker History request was rejected.');
    return readJsonResponse(response);
  };
}

function requestFetch(input: {
  readonly reference: CoordinatorWorkerReference;
  readonly capability: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly fetch?: LocalRuntimeFetch;
}): LocalRuntimeFetch {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  return (request, init = {}) => {
    const url = exactWorkerTransportUrl(input.reference.endpoint.origin, request);
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(
      workerHeaders(input.capability, input.clientId, input.connectionGeneration),
    )) {
      headers.set(name, value);
    }
    return fetcher(url, {
      ...init,
      headers,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  };
}

function exactWorkerTransportUrl(origin: string, request: RequestInfo | URL): string {
  const raw =
    typeof request === 'string'
      ? request
      : request instanceof URL
        ? request.toString()
        : request.url;
  const url = new URL(raw, origin);
  if (
    url.origin !== origin ||
    url.pathname !== '/_kite/connect' ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    url.username.length !== 0 ||
    url.password.length !== 0
  ) {
    throw unavailable('Worker transport path is invalid.');
  }
  return url.toString();
}

function workerHeaders(
  capability: string,
  clientId: string,
  connectionGeneration: number,
): Record<string, string> {
  return {
    authorization: `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${capability}`,
    'content-type': 'application/json',
    accept: 'application/json',
    [KITE_WORKER_CLIENT_ID_HEADER]: clientId,
    [KITE_WORKER_CONNECTION_GENERATION_HEADER]: String(connectionGeneration),
    [KITE_WORKER_PURPOSE_HEADER]: WORKER_CAPABILITY_PURPOSE,
  };
}

function exactWorkerUrl(origin: string, path: string): string {
  const url = new URL(path, origin);
  if (
    url.origin !== origin ||
    url.pathname !== path ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    url.username.length !== 0 ||
    url.password.length !== 0
  ) {
    throw unavailable('Worker request path is invalid.');
  }
  return url.toString();
}

function assertHistoryPath(path: string): void {
  if (
    path !== '/_kite/history/list-sessions' &&
    path !== '/_kite/history/list-events' &&
    path !== '/_kite/history/load-session'
  ) {
    throw unavailable('Web Gateway may use only query-only Worker History routes.');
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (contentType !== 'application/json; charset=utf-8') {
    throw unavailable('Worker response content type is invalid.');
  }
  return response.json();
}

function workerDescriptor(reference: CoordinatorWorkerReference): LocalRuntimeServiceDescriptor {
  return decodeLocalRuntimeServiceDescriptor({
    schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
    instanceId: reference.identity.instanceId,
    pid: 1,
    startedAt: '1970-01-01T00:00:00.000Z',
    endpoint: reference.endpoint,
    protocolVersion: 1,
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    serverVersion: 'kite-workspace-worker',
    buildId: reference.identity.buildId,
  });
}

function clientInfo(gatewayInstanceId: string, tabHandle: string): RuntimeClientInfo {
  return {
    name: 'kite-web-gateway-observer',
    version: 'v1',
    instanceId: clientIdFor(gatewayInstanceId, tabHandle),
  };
}

function durableLiveInput(
  notification: Extract<RuntimeAccessNotification, { readonly durability: 'durable' }>,
  sessionId: string,
  expected: number | undefined,
): WebObserverLiveInput | undefined {
  if (
    notification.sessionId !== sessionId ||
    !Number.isSafeInteger(notification.revision) ||
    notification.revision < 0 ||
    notification.projection.session.sessionId !== sessionId ||
    notification.projection.session.revision !== notification.revision ||
    (expected !== undefined && notification.revision <= expected)
  ) {
    if (notification.sessionId === sessionId && notification.revision <= (expected ?? -1)) {
      return { sessionId, sequence: notification.revision, event: INTERNAL_NOOP_EVENT };
    }
    return undefined;
  }
  return {
    sessionId,
    sequence: notification.revision,
    event: notification.projection.event ?? INTERNAL_NOOP_EVENT,
  };
}

function isDurableNotification(
  value: RuntimeAccessNotification,
): value is Extract<RuntimeAccessNotification, { readonly durability: 'durable' }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'durability' in value &&
    value.durability === 'durable'
  );
}

async function statusForSession(
  worker: WorkerBinding,
  sessionId: string,
): Promise<WebSessionStatus> {
  const result = await worker.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  if (result.status !== 'ok' || result.session?.sessionId !== sessionId) return 'unavailable';
  const projection = result.session;
  if (projection.lifecycle === 'closed') return 'completed';
  const activeWork = projection.activeWork;
  if (!activeWork) return 'idle';
  if (activeWork.status === 'waiting') return 'waiting';
  if (activeWork.status === 'failed') return 'failed';
  if (activeWork.status === 'cancelled') return 'cancelled';
  if (activeWork.status === 'completed') return 'completed';
  return 'running';
}

function toWorkspaceIdentity(value: CoordinatorWorkspaceIdentity): KiteWorkspaceIdentity {
  if (
    !safePath(value.canonicalPath) ||
    !/^[A-Za-z0-9._:-]{1,512}$/u.test(value.projectId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.workspaceDigest)
  ) {
    throw unavailable('Coordinator Workspace identity is invalid.');
  }
  return Object.freeze({
    canonicalPath: value.canonicalPath,
    projectId: value.projectId,
    workspaceDigest: value.workspaceDigest as `sha256:${string}`,
  });
}

function assertWorkerReference(
  reference: CoordinatorWorkerReference,
  workspace: KiteWorkspaceIdentity,
): void {
  if (
    reference.identity.role !== 'worker' ||
    !/^[A-Za-z0-9._:-]{1,512}$/u.test(reference.identity.workerScopeId) ||
    !/^[A-Za-z0-9._:-]{1,512}$/u.test(reference.identity.instanceId) ||
    !/^[A-Za-z0-9._:-]{1,512}$/u.test(reference.identity.buildId) ||
    reference.identity.protocolVersion !== 1 ||
    reference.identity.protocolRevision !== 'kite-local-coordinator-protocol-v1' ||
    reference.identity.clientContractRevision !== 'kite-local-coordinator-client-v1' ||
    reference.workspace.canonicalPath !== workspace.canonicalPath ||
    reference.workspace.projectId !== workspace.projectId ||
    reference.workspace.workspaceDigest !== workspace.workspaceDigest ||
    !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(reference.endpoint.origin) ||
    !/^ws:\/\/127\.0\.0\.1:\d{1,5}\/rpc$/u.test(reference.endpoint.websocketUrl) ||
    reference.endpoint.origin !==
      new URL(reference.endpoint.websocketUrl.replace(/^ws:/u, 'http:')).origin
  ) {
    throw unavailable('Coordinator Worker reference identity is invalid.');
  }
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function sameWorkerReference(
  left: CoordinatorWorkerReference,
  right: CoordinatorWorkerReference,
): boolean {
  return (
    left.identity.workerScopeId === right.identity.workerScopeId &&
    left.identity.instanceId === right.identity.instanceId &&
    left.identity.buildId === right.identity.buildId &&
    left.identity.protocolVersion === right.identity.protocolVersion &&
    left.identity.protocolRevision === right.identity.protocolRevision &&
    left.identity.clientContractRevision === right.identity.clientContractRevision &&
    sameWorkspace(toWorkspaceIdentity(left.workspace), toWorkspaceIdentity(right.workspace)) &&
    left.endpoint.origin === right.endpoint.origin &&
    left.endpoint.websocketUrl === right.endpoint.websocketUrl
  );
}

function clientIdFor(tabHandle: string, workerScopeId: string): string {
  const value = `kite-web-observer:${tabHandle}:${workerScopeId}`;
  if (value.length > MAX_CLIENT_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw unavailable('Web Observer client identity is invalid.');
  }
  return value;
}

function assertOpaqueTabHandle(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(value)) {
    throw new TypeError('Web Observer tab handle is invalid.');
  }
}

function assertSessionId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,512}$/u.test(value)) throw new TypeError('Session identity is invalid.');
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:-]{1,512}$/u.test(value)) throw new TypeError(`${label} is invalid.`);
}

function safePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function safeCapability(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,1024}$/u.test(value);
}

function safeTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function historyTranscript(
  sessionId: string,
  transcript: RuntimeHistorySessionTranscript,
): WebObserverHistoryTranscript {
  return Object.freeze({
    sessionId,
    lastSequence: transcript.session.lastSequence,
    records: transcript.records,
  });
}

function displayNameFor(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const sanitized = [...value]
    .filter(
      (character) =>
        !/\p{Cc}/u.test(character) ||
        character === '\n' ||
        character === '\r' ||
        character === '\t',
    )
    .join('')
    .slice(0, 512)
    .trim();
  return sanitized.length > 0 ? sanitized : fallback;
}

function unavailable(message: string): Error {
  return new Error(message);
}

function coordinatorResult<M extends CoordinatorMethod>(
  response: CoordinatorResponseFor<M>,
): CoordinatorResultByMethod[M] {
  if (response.outcome !== 'ok') throw unavailable('Coordinator request was unavailable.');
  return (response as unknown as CoordinatorSuccessResponse<M>).result;
}
