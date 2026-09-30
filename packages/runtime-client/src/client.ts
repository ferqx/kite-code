import type {
  RuntimeAccessNotification,
  RuntimeBackgroundExecutionProjection,
  RuntimeClientEvent,
  RuntimeCommand,
  RuntimeCommandReceipt,
  RuntimeHistorySessionTranscript,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeQueryResult,
  RuntimeSessionProjection,
  RuntimeSubscription,
  RuntimeSubscriptionSpec,
} from '@kite-ai/runtime-contract';
import {
  type AcceptedPresentationEnvelope,
  assertAcceptedPresentationEnvelope,
} from '@kite-ai/runtime-contract';
import {
  type InitializeResult,
  mapRuntimeCommandToProtocol,
  mapRuntimeQueryToProtocol,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeProtocolAppMethod,
  type RuntimeProtocolError,
  type RuntimeProtocolMessage,
  type RuntimeProtocolMethod,
  type RuntimeProtocolResult,
  type RuntimeSubscriptionSpec as RuntimeProtocolSubscriptionSpec,
  type RuntimeSubscriptionMessage,
  safeDecodeRuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import type {
  RuntimeClientConnection,
  RuntimeClientTransport,
  RuntimeHistoryClient,
} from './index';
import { type RuntimeClientConnectionStatus, RuntimeSnapshotStore } from './store';

export interface RuntimeClientInfo {
  readonly name: string;
  readonly version: string;
  readonly instanceId: string;
}

export interface RuntimeClientFeatures {
  readonly steer: boolean;
  readonly backgroundQuery: boolean;
  readonly backgroundControl: boolean;
}

const NO_RUNTIME_FEATURES: RuntimeClientFeatures = Object.freeze({
  steer: false,
  backgroundQuery: false,
  backgroundControl: false,
});

const MAX_ACTIVE_HISTORY_LOADS = 4;

function waitForHistoryRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

interface WaitingHistoryLoad {
  start(): void;
  cancel(error: unknown): void;
}

export interface RuntimeClientOptions {
  readonly transport: RuntimeClientTransport;
  readonly clientInfo: RuntimeClientInfo;
  readonly snapshotStore?: RuntimeSnapshotStore;
  /** App-injected exact, client-safe durable history reader. */
  readonly history?: RuntimeHistoryClient | 'protocol';
  /** Exact peer identity/capability check used by same-build App Server clients. */
  readonly expectedServer?: Readonly<{
    version: string;
    requiredMethods?: readonly RuntimeProtocolMethod[];
  }>;
  /** Maximum time for connection, transport send, and one protocol response. */
  readonly requestTimeoutMs?: number;
}

export interface RuntimeClientSubscription {
  readonly id: string;
  readonly spec: RuntimeProtocolSubscriptionSpec;
  readonly generation: number;
  unsubscribe(): Promise<boolean>;
}

export class RuntimeClientError extends Error {
  readonly code:
    | 'connection_closed'
    | 'connection_failed'
    | 'startup_failure'
    | 'protocol_error'
    | 'server_mismatch'
    | 'unsupported_command'
    | 'unsupported_query'
    | 'request_timeout'
    | 'request_overloaded'
    | 'history_too_large';
  readonly protocol?: RuntimeProtocolError;

  constructor(code: RuntimeClientError['code'], message: string, protocol?: RuntimeProtocolError) {
    super(message);
    this.name = 'RuntimeClientError';
    this.code = code;
    this.protocol = protocol;
  }
}

/** Fixed, client-safe startup fact; transports cannot supply arbitrary display text. */
export class RuntimeClientStartupError extends RuntimeClientError {
  readonly diagnosticCode:
    | 'store_incompatible'
    | 'store_migration_required'
    | 'store_insufficient_space'
    | 'store_access_denied'
    | 'store_corrupt'
    | 'store_preparation_cancelled'
    | 'store_busy'
    | 'store_admission_failed'
    | 'store_preparation_retry_blocked'
    | 'store_history_reconciliation_required';
  readonly actualSchema: number | null;
  readonly expectedSchema: number | null;
  readonly admissionReason?:
    | 'unsupported_platform'
    | 'desktop_identity_mismatch'
    | 'paired_manifest_mismatch'
    | 'desktop_parent_unverified'
    | 'source_identity_mismatch'
    | 'source_build_mismatch'
    | 'source_parent_unverified'
    | 'installed_identity_mismatch'
    | 'release_selection_busy_or_unsafe'
    | 'installed_parent_unverified'
    | 'installed_process_inspection_incomplete'
    | 'legacy_process_inspection_incomplete'
    | 'admission_unverified';
  readonly stage?:
    | 'inspecting'
    | 'acquiring_maintenance'
    | 'waiting_for_store'
    | 'preparing'
    | 'publishing'
    | 'ready';

  constructor(input: {
    readonly code: RuntimeClientStartupError['diagnosticCode'];
    readonly actualSchema: number | null;
    readonly expectedSchema: number | null;
    readonly stage?: RuntimeClientStartupError['stage'];
    readonly admissionReason?: RuntimeClientStartupError['admissionReason'];
  }) {
    const codes = [
      'store_incompatible',
      'store_migration_required',
      'store_busy',
      'store_admission_failed',
      'store_preparation_retry_blocked',
      'store_insufficient_space',
      'store_access_denied',
      'store_corrupt',
      'store_preparation_cancelled',
      'store_history_reconciliation_required',
    ];
    if (
      Object.keys(input).some(
        (key) =>
          !['code', 'actualSchema', 'expectedSchema', 'stage', 'admissionReason'].includes(key),
      ) ||
      !codes.includes(input.code) ||
      !validStartupSchema(input.actualSchema) ||
      !validStartupSchema(input.expectedSchema) ||
      (input.code === 'store_admission_failed'
        ? !validStartupAdmissionReason(input.admissionReason)
        : input.admissionReason !== undefined) ||
      (input.stage !== undefined &&
        ![
          'inspecting',
          'acquiring_maintenance',
          'waiting_for_store',
          'preparing',
          'publishing',
          'ready',
        ].includes(input.stage))
    )
      throw new TypeError('Invalid Runtime startup diagnostic.');
    const actual = input.actualSchema === null ? '未知' : String(input.actualSchema);
    const expected = input.expectedSchema === null ? '未知' : String(input.expectedSchema);
    const message =
      input.code === 'store_admission_failed'
        ? `STORE_ADMISSION_FAILED：${describeStartupAdmissionReason(input.admissionReason!)}会话数据及恢复资料保持不变。`
        : input.code === 'store_preparation_retry_blocked'
          ? 'STORE_PREPARATION_RETRY_BLOCKED：同一版本对未变化的会话数据已尝试整理且未完成；为避免重复占用磁盘，本版本不会再次复制。请使用修复版本或保存诊断进行恢复处理；原数据及恢复资料保持不变。'
          : input.code === 'store_preparation_cancelled'
            ? 'STORE_PREPARATION_CANCELLED：已在提交前取消会话数据整理，原会话数据保持不变，可以重新启动。'
            : input.code === 'store_access_denied'
              ? 'STORE_ACCESS_DENIED：无法访问会话数据。请检查数据目录的所有者、访问权限及磁盘可用状态后重新尝试；不要删除数据库。'
              : input.code === 'store_corrupt'
                ? 'STORE_CORRUPT：会话数据库未通过完整性检查。请保留当前数据库及恢复资料，保存诊断后通过恢复流程处理；不会自动清空或覆盖数据。'
                : input.code === 'store_history_reconciliation_required'
                  ? 'STORE_HISTORY_RECONCILIATION_REQUIRED：会话数据自动整理未通过校验，原数据及恢复资料已保留。请保存诊断并使用修复版本继续整理；同一版本对未变化的数据不会重复建立备份。'
                  : input.code === 'store_insufficient_space'
                    ? 'STORE_INSUFFICIENT_SPACE：磁盘可用空间不足，暂时无法完成会话数据整理。请释放磁盘空间后重新尝试；不要删除 Kite 会话数据或恢复资料。'
                    : input.code === 'store_busy'
                      ? 'STORE_BUSY：会话存储正忙，请稍后重试。'
                      : `${input.code.toUpperCase()}：当前版本无法处理这份会话数据（数据格式 ${actual}，程序支持 ${expected}）。数据保持原样，请使用创建这份数据的版本或支持该格式的新版本后重新尝试。`;
    super('startup_failure', message);
    this.name = 'RuntimeClientStartupError';
    this.diagnosticCode = input.code;
    this.actualSchema = input.actualSchema;
    this.expectedSchema = input.expectedSchema;
    this.admissionReason = input.admissionReason;
    this.stage = input.stage;
  }
}

function validStartupSchema(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function validStartupAdmissionReason(
  value: unknown,
): value is NonNullable<RuntimeClientStartupError['admissionReason']> {
  return (
    typeof value === 'string' &&
    [
      'unsupported_platform',
      'desktop_identity_mismatch',
      'paired_manifest_mismatch',
      'desktop_parent_unverified',
      'source_identity_mismatch',
      'source_build_mismatch',
      'source_parent_unverified',
      'installed_identity_mismatch',
      'release_selection_busy_or_unsafe',
      'installed_parent_unverified',
      'installed_process_inspection_incomplete',
      'legacy_process_inspection_incomplete',
      'admission_unverified',
    ].includes(value)
  );
}

function describeStartupAdmissionReason(
  reason: NonNullable<RuntimeClientStartupError['admissionReason']>,
): string {
  switch (reason) {
    case 'unsupported_platform':
      return '此平台不支持自动整理会话数据。请使用支持的运行环境。';
    case 'desktop_identity_mismatch':
    case 'paired_manifest_mismatch':
    case 'source_identity_mismatch':
    case 'source_build_mismatch':
    case 'installed_identity_mismatch':
    case 'release_selection_busy_or_unsafe':
      return '无法核实客户端与配套服务或安装版本。请检查安装并从受支持的入口重新启动。';
    case 'desktop_parent_unverified':
    case 'source_parent_unverified':
    case 'installed_parent_unverified':
      return '无法核实启动配套服务的客户端。请退出 Kite 后从受支持的入口重新启动。';
    case 'legacy_process_inspection_incomplete':
    case 'installed_process_inspection_incomplete':
      return '无法完整核实其他客户端是否仍在使用会话数据。请退出其他 Kite 客户端并保存诊断。';
    case 'admission_unverified':
      return '无法完成会话数据维护准入核实。请保存诊断以便排查。';
  }
}

interface PendingRequest {
  readonly generation: number;
  readonly resolve: (result: RuntimeProtocolResult) => void;
  readonly reject: (reason: RuntimeClientError) => void;
  /** Subscribe ack binding must happen in the receive turn before its first notification. */
  readonly subscriptionState?: SubscriptionState;
}

interface SubscriptionState {
  readonly id: string;
  readonly spec: RuntimeProtocolSubscriptionSpec;
  readonly queue: RuntimeNotificationQueue;
  readonly signal?: AbortSignal;
  readonly indexObserverOnly?: boolean;
  readonly ready?: Readonly<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: RuntimeClientError) => void;
  }>;
  remoteId?: string;
  remoteGeneration?: number;
  /** Local connection generation that owns the remote subscription identity. */
  connectionGeneration?: number;
  /** Sent subscribe request, usable to detach before the remote ID is acknowledged. */
  subscribeRequestId?: string;
  subscribeRequestGeneration?: number;
  resyncing?: boolean;
  /** A parent Run already active when this subscription became ready may have unreplayable frames. */
  joinedActiveParentRunId?: string;
  onAbort?: () => void;
}

/**
 * One RuntimeAccess notification together with the local connection
 * generation that accepted it.  The generation is captured when the
 * notification enters the client queue; consumers must not substitute the
 * current generation later, because a reconnect may have happened while the
 * consumer was suspended.
 */
export interface RuntimeClientNotificationWithGeneration {
  readonly notification: RuntimeAccessNotification;
  readonly connectionGeneration: number;
}

/**
 * Browser-safe Protocol client. Reconnect is explicit and only restores
 * subscriptions; mutations are never replayed automatically.
 */
export class RuntimeClient implements AsyncDisposable {
  readonly #transport: RuntimeClientTransport;
  readonly #clientInfo: RuntimeClientInfo;
  readonly #store: RuntimeSnapshotStore;
  readonly #history: RuntimeHistoryClient | undefined;
  readonly #expectedServer: RuntimeClientOptions['expectedServer'];
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #subscriptions = new Map<string, SubscriptionState>();
  readonly #appliedBackgroundListQueries = new Map<string, number>();
  readonly #activeHistoryLoads = new Set<AbortController>();
  readonly #waitingHistoryLoads: WaitingHistoryLoad[] = [];
  #connection: RuntimeClientConnection | undefined;
  #connectionGeneration = 0;
  #nextRequest = 0;
  #nextSubscription = 0;
  #nextBackgroundListQuery = 0;
  #connectPromise: Promise<void> | undefined;
  #closed = false;
  #features: RuntimeClientFeatures = NO_RUNTIME_FEATURES;
  #historyCancelSupported = false;

  constructor(options: RuntimeClientOptions) {
    this.#transport = options.transport;
    this.#clientInfo = options.clientInfo;
    this.#store = options.snapshotStore ?? new RuntimeSnapshotStore();
    this.#expectedServer = options.expectedServer;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new RangeError('requestTimeoutMs must be a positive integer.');
    }
    const requestHistory = this.#request.bind(this);
    const scheduleHistoryLoad = this.#scheduleHistoryLoad.bind(this);
    const historyPageTimeoutMs = this.#requestTimeoutMs;
    this.#history =
      options.history === 'protocol'
        ? Object.freeze({
            listSessions: async (request) => {
              const result = await this.#request('history/list_sessions', { request });
              if (!('entries' in result) || 'observedLastSequence' in result) {
                throw new RuntimeClientError(
                  'protocol_error',
                  'Protocol returned invalid History.',
                );
              }
              return result;
            },
            listEvents: async (request) => {
              const result = await this.#request('history/list_events', { request });
              if (!('entries' in result) || !('observedLastSequence' in result)) {
                throw new RuntimeClientError(
                  'protocol_error',
                  'Protocol returned invalid History.',
                );
              }
              return result;
            },
            loadSession: (sessionId, throughSequence, options) =>
              loadTranscript('history/load_session', { sessionId }, throughSequence, options),
            loadChildSession: (parentSessionId, childSessionId, throughSequence, options) =>
              loadTranscript(
                'history/load_child_session',
                { parentSessionId, childSessionId },
                throughSequence,
                options,
              ),
          } satisfies RuntimeHistoryClient)
        : options.history;

    async function loadTranscript(
      method: 'history/load_session' | 'history/load_child_session',
      identity:
        | { readonly sessionId: string }
        | { readonly parentSessionId: string; readonly childSessionId: string },
      throughSequence?: number,
      options?: { readonly signal?: AbortSignal },
    ): Promise<RuntimeHistorySessionTranscript> {
      return scheduleHistoryLoad(
        (signal) => loadTranscriptPages(method, identity, throughSequence, signal),
        options?.signal,
      );
    }

    async function loadTranscriptPages(
      method: 'history/load_session' | 'history/load_child_session',
      identity:
        | { readonly sessionId: string }
        | { readonly parentSessionId: string; readonly childSessionId: string },
      throughSequence: number | undefined,
      signal: AbortSignal,
    ): Promise<RuntimeHistorySessionTranscript> {
      const sessionId = 'sessionId' in identity ? identity.sessionId : identity.childSessionId;
      for (let attempt = 0; attempt < 2; attempt++) {
        const records: RuntimeHistorySessionTranscript['records'][number][] = [];
        let afterSequence: number | undefined;
        let snapshotSequence = throughSequence;
        let snapshotDigest: string | undefined;
        let metadata: Omit<RuntimeHistorySessionTranscript, 'records' | 'events'> | undefined;
        let localSnapshotChange = false;
        try {
          for (;;) {
            signal.throwIfAborted();
            const pageRequest = {
              ...identity,
              page: {
                ...(afterSequence === undefined ? {} : { afterSequence }),
                ...(snapshotSequence === undefined ? {} : { throughSequence: snapshotSequence }),
                ...(snapshotDigest === undefined ? {} : { snapshotDigest }),
              },
            };
            let retryDelayMs = 25;
            const pageDeadline = Date.now() + historyPageTimeoutMs;
            let result: RuntimeProtocolResult;
            for (;;) {
              signal.throwIfAborted();
              const remainingMs = pageDeadline - Date.now();
              if (remainingMs <= 0)
                throw new RuntimeClientError('request_timeout', 'Runtime History page timed out.');
              try {
                result = await requestHistory(method, pageRequest, undefined, signal, remainingMs);
                break;
              } catch (error) {
                signal.throwIfAborted();
                if (
                  !(error instanceof RuntimeClientError) ||
                  error.code !== 'request_overloaded' ||
                  error.protocol?.data.code !== 'overloaded'
                )
                  throw error;
                await waitForHistoryRetry(
                  signal,
                  Math.min(retryDelayMs, pageDeadline - Date.now()),
                );
                retryDelayMs = Math.min(retryDelayMs * 2, 250);
              }
            }
            signal.throwIfAborted();
            if (
              !('type' in result) ||
              result.type !== 'history_session_page' ||
              result.session.sessionId !== sessionId ||
              (snapshotSequence !== undefined && result.session.lastSequence !== snapshotSequence)
            ) {
              throw new RuntimeClientError(
                'protocol_error',
                'Protocol returned invalid History page.',
              );
            }
            if (
              afterSequence !== undefined &&
              snapshotDigest !== undefined &&
              result.snapshotDigest !== snapshotDigest
            ) {
              localSnapshotChange = true;
              throw new RuntimeClientError('protocol_error', 'History changed during pagination.');
            }
            snapshotSequence = result.session.lastSequence;
            snapshotDigest ??= result.snapshotDigest;
            metadata ??= {
              session: result.session,
              interactionMode: result.interactionMode,
              recovery: result.recovery,
            };
            let previous = afterSequence ?? 0;
            for (const record of result.records) {
              if (record.sequence <= previous || record.sequence > snapshotSequence)
                throw new RuntimeClientError(
                  'protocol_error',
                  'History records are out of sequence.',
                );
              previous = record.sequence;
            }
            records.push(...result.records);
            if (result.nextCursor === undefined)
              return {
                ...metadata,
                records,
                events: records.flatMap((record) => record.events),
              };
            if (
              result.nextCursor !== previous ||
              result.nextCursor <= (afterSequence ?? 0) ||
              result.nextCursor >= snapshotSequence
            )
              throw new RuntimeClientError('protocol_error', 'History pagination did not advance.');
            afterSequence = result.nextCursor;
          }
        } catch (error) {
          signal.throwIfAborted();
          const serverSnapshotChange =
            error instanceof RuntimeClientError &&
            error.protocol?.data.detailCode === 'history_snapshot_changed';
          if (attempt === 1 || (!localSnapshotChange && !serverSnapshotChange)) throw error;
        }
      }
      throw new RuntimeClientError('protocol_error', 'History changed during pagination.');
    }
  }

  get snapshotStore(): RuntimeSnapshotStore {
    return this.#store;
  }

  get history(): RuntimeHistoryClient | undefined {
    return this.#history;
  }

  get connectionGeneration(): number {
    return this.#connectionGeneration;
  }

  get features(): RuntimeClientFeatures {
    return this.#features;
  }

  async connect(): Promise<void> {
    if (this.#closed) throw closedError();
    if (this.#connection) return;
    this.#connectPromise ??= this.#open('connecting', false);
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  /** Explicit reconnect: subscriptions are restored, but commands are not replayed. */
  async reconnect(): Promise<void> {
    if (this.#closed) throw closedError();
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#open('reconnecting', true);
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async command(command: RuntimeCommand): Promise<RuntimeCommandReceipt> {
    if (command.type === 'steer_turn' && !this.#features.steer) {
      throw new RuntimeClientError(
        'unsupported_command',
        'Runtime Host does not advertise steering support.',
      );
    }
    if (command.type === 'stop_background_execution' && !this.#features.backgroundControl) {
      throw new RuntimeClientError(
        'unsupported_command',
        'Runtime Host does not advertise background control support.',
      );
    }
    const wire = mapRuntimeCommandToProtocol(command);
    if (!wire) {
      throw new RuntimeClientError(
        'unsupported_command',
        `Runtime command is not available in Protocol V2: ${command.type}`,
      );
    }
    const result = await this.#request('runtime/command', { command: wire });
    if (!isCommandReceipt(result)) {
      throw new RuntimeClientError('protocol_error', 'Protocol returned a non-command result.');
    }
    return result;
  }

  /** Stop exactly the background execution represented by a previously read projection. */
  async stopBackgroundExecution(input: {
    readonly commandId: string;
    readonly execution: RuntimeBackgroundExecutionProjection;
  }): Promise<{
    readonly receipt: RuntimeCommandReceipt;
    readonly execution?: RuntimeBackgroundExecutionProjection;
  }> {
    const target = input.execution;
    const command = Object.freeze({
      schema: 'kite.runtime-command.v1' as const,
      commandId: input.commandId,
      type: 'stop_background_execution' as const,
      sessionId: target.sessionId,
      expectedRevision: target.sessionRevision,
      executionId: target.executionId,
      executionKind: target.kind,
      expectedOwnerGeneration: target.ownerGeneration,
      expectedExecutionRevision: target.revision,
    });
    let receipt: RuntimeCommandReceipt;
    try {
      receipt = await this.command(command);
    } catch (error) {
      const resolved = await this.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_command_receipt',
        sessionId: target.sessionId,
        command,
      }).catch(() => undefined);
      if (resolved?.status !== 'ok' || !resolved.receipt) throw error;
      receipt = resolved.receipt;
    }
    let execution: RuntimeBackgroundExecutionProjection | undefined;
    if (
      receipt.status === 'applied' ||
      receipt.status === 'idempotent_replay' ||
      receipt.status === 'conflict'
    ) {
      const refreshed = await this.query({
        schema: 'kite.runtime-query.v1',
        type: 'get_background_execution',
        sessionId: target.sessionId,
        executionId: target.executionId,
      });
      execution = refreshed.status === 'ok' ? refreshed.backgroundExecution : undefined;
    }
    return { receipt, ...(execution ? { execution } : {}) };
  }

  async query(query: RuntimeQuery, signal?: AbortSignal): Promise<RuntimeQueryResult> {
    if (
      (query.type === 'list_background_executions' || query.type === 'get_background_execution') &&
      !this.#features.backgroundQuery
    ) {
      throw new RuntimeClientError(
        'unsupported_query',
        'Runtime Host does not advertise background query support.',
      );
    }
    const wire = mapRuntimeQueryToProtocol(query);
    if (!wire) {
      throw new RuntimeClientError(
        'unsupported_query',
        `Runtime query is not available in Protocol V2: ${query.type}`,
      );
    }
    const connectionGeneration = this.#connectionGeneration;
    const backgroundSessionId =
      query.type === 'list_background_executions' ? query.sessionId : undefined;
    const completeBackgroundList =
      query.type === 'list_background_executions' &&
      query.cursor === undefined &&
      query.limit === undefined;
    const backgroundListQuery =
      query.type === 'list_background_executions' ? ++this.#nextBackgroundListQuery : undefined;
    const backgroundSubscribers =
      query.type === 'list_background_executions' || query.type === 'get_background_execution'
        ? [...this.#subscriptions.values()]
            .filter(
              (state) =>
                (state.spec.scope === 'session' && state.spec.sessionId === query.sessionId) ||
                (state.spec.scope === 'child_session' &&
                  state.spec.childSessionId === query.sessionId),
            )
            .map((state) => state.id)
        : [];
    const queryDeadline = Date.now() + this.#requestTimeoutMs;
    const rawResult = await this.#request('runtime/query', { query: wire }, undefined, signal);
    if (!isQueryResult(rawResult)) {
      throw new RuntimeClientError('protocol_error', 'Protocol returned a non-query result.');
    }
    let result: RuntimeQueryResult = rawResult;
    if (
      completeBackgroundList &&
      result.status === 'ok' &&
      result.queryType === 'list_background_executions' &&
      result.backgroundSnapshot
    ) {
      const deadline = queryDeadline;
      let first = result;
      let anchor = result.backgroundSnapshot;
      if (anchor.sessionId !== backgroundSessionId)
        throw new RuntimeClientError(
          'protocol_error',
          'Background response belongs to another session.',
        );
      let executions = [...anchor.executions];
      let cursor = first.nextBackgroundCursor;
      while (cursor !== undefined) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline)
          throw new RuntimeClientError(
            'request_timeout',
            'Background directory changed during pagination.',
          );
        const pageQuery = mapRuntimeQueryToProtocol({ ...query, cursor });
        if (!pageQuery)
          throw new RuntimeClientError('protocol_error', 'Background page query is invalid.');
        const page = await this.#request(
          'runtime/query',
          { query: pageQuery },
          undefined,
          signal,
          Math.max(1, deadline - Date.now()),
        );
        if (
          !isQueryResult(page) ||
          page.status !== 'ok' ||
          page.queryType !== 'list_background_executions' ||
          !page.backgroundSnapshot
        )
          throw new RuntimeClientError('protocol_error', 'Background page response is invalid.');
        const current = page.backgroundSnapshot;
        if (current.sessionId !== anchor.sessionId)
          throw new RuntimeClientError(
            'protocol_error',
            'Background page belongs to another session.',
          );
        if (
          current.aggregateGeneration !== anchor.aggregateGeneration ||
          current.watermark !== anchor.watermark ||
          current.sessionRevision !== anchor.sessionRevision
        ) {
          // A changing directory cannot be represented as one complete snapshot.
          // Let the owner settle briefly, then restart from its current first page.
          await new Promise((resolve) => setTimeout(resolve, 25));
          signal?.throwIfAborted();
          const restart = await this.#request(
            'runtime/query',
            { query: wire },
            undefined,
            signal,
            Math.max(1, deadline - Date.now()),
          );
          if (
            !isQueryResult(restart) ||
            restart.status !== 'ok' ||
            restart.queryType !== 'list_background_executions' ||
            !restart.backgroundSnapshot
          )
            throw new RuntimeClientError(
              'protocol_error',
              'Background restart response is invalid.',
            );
          first = restart;
          anchor = restart.backgroundSnapshot;
          if (anchor.sessionId !== backgroundSessionId)
            throw new RuntimeClientError(
              'protocol_error',
              'Background restart belongs to another session.',
            );
          executions = [...anchor.executions];
          cursor = restart.nextBackgroundCursor;
          continue;
        }
        if (page.nextBackgroundCursor !== undefined && page.nextBackgroundCursor <= cursor)
          throw new RuntimeClientError('protocol_error', 'Background page cursor did not advance.');
        executions.push(...current.executions);
        cursor = page.nextBackgroundCursor;
      }
      result = {
        ...first,
        backgroundSnapshot: { ...anchor, executions },
        nextBackgroundCursor: undefined,
      };
    }
    if (
      result.status === 'ok' &&
      result.queryType === 'list_background_executions' &&
      result.backgroundSnapshot !== undefined &&
      completeBackgroundList &&
      backgroundSubscribers.some((id) => this.#subscriptions.has(id)) &&
      connectionGeneration === this.#connectionGeneration &&
      backgroundSessionId !== undefined &&
      backgroundListQuery !== undefined &&
      backgroundListQuery > (this.#appliedBackgroundListQueries.get(backgroundSessionId) ?? 0)
    ) {
      // Aggregate generations are opaque: a slower, older list must not
      // replace a newer list merely because its generation differs.
      this.#store.applyBackgroundSnapshot({
        connectionGeneration,
        snapshot: result.backgroundSnapshot,
      });
      this.#appliedBackgroundListQueries.set(backgroundSessionId, backgroundListQuery);
    }
    if (
      result.status === 'ok' &&
      result.queryType === 'get_background_execution' &&
      result.backgroundExecution !== undefined &&
      backgroundSubscribers.some((id) => this.#subscriptions.has(id))
    ) {
      this.#store.applyBackgroundExecution({
        connectionGeneration,
        execution: result.backgroundExecution,
      });
    }
    return result;
  }

  /** Native App connector seam; semantic request/response codecs remain owned above this package. */
  async requestApp(
    method: RuntimeProtocolAppMethod,
    request: Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number },
  ): Promise<Readonly<Record<string, unknown>>> {
    const timeoutMs = options?.timeoutMs ?? this.#requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
      throw new TypeError('App request timeout must be a positive bounded integer.');
    const result = await this.#request(method, { request }, undefined, undefined, timeoutMs);
    if (
      !('method' in result) ||
      result.method !== method ||
      !('response' in result) ||
      !isPlainRecord(result.response)
    ) {
      throw new RuntimeClientError(
        'protocol_error',
        'Protocol returned an invalid App Control result.',
      );
    }
    return result.response;
  }

  /** Explicit daemon lifecycle control over the initialized Runtime protocol connection. */
  async requestServerControl(
    method: import('@kite-ai/runtime-protocol').RuntimeProtocolServerControlMethod,
    request: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.#request(method, { request });
    if (
      !('method' in result) ||
      result.method !== method ||
      !('response' in result) ||
      !isPlainRecord(result.response)
    ) {
      throw new RuntimeClientError('protocol_error', 'Protocol returned an invalid Server result.');
    }
    return result.response;
  }

  /** RuntimeAccess-compatible stream. Remote acquisition happens asynchronously. */
  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
    const state = this.#createSubscription(subscription.spec, subscription.signal);
    void this.#activateSubscription(state).catch(() => this.#closeSubscription(state, false));
    return state.queue.iterable(() => {
      void this.#closeSubscription(state, true).catch(() => undefined);
    });
  }

  /** Observe index removals without replacing the selected Session's live snapshot. */
  observeSessionIndex(signal?: AbortSignal): AsyncIterable<RuntimeAccessNotification> {
    const state = this.#createSubscription({ scope: 'sessions' }, signal, false, true);
    void this.#activateSubscription(state).catch(() => this.#closeSubscription(state, false));
    return state.queue.iterable(() => {
      void this.#closeSubscription(state, true).catch(() => undefined);
    });
  }

  /**
   * Acquire a stream only after the remote initial watermark is ready. This
   * prevents a command from racing the Server's initial subscription phase
   * and losing live ephemeral notifications produced in that window.
   */
  async subscribeReady(
    subscription: RuntimeSubscription,
  ): Promise<AsyncIterable<RuntimeAccessNotification>> {
    const state = this.#createSubscription(subscription.spec, subscription.signal, true);
    try {
      await this.#activateSubscription(state);
      await this.#waitForReady(state);
      return state.queue.iterable(() => {
        void this.#closeSubscription(state, true).catch(() => undefined);
      });
    } catch (error) {
      await this.#closeSubscription(state, false);
      throw error;
    }
  }

  /**
   * Ready RuntimeAccess stream retaining the receipt-time connection
   * generation for every notification.  This is the stream for presentation
   * adapters that need both event-free authoritative snapshots and accepted
   * envelopes; the ordinary `subscribeReady()` API remains RuntimeAccess
   * compatible and intentionally strips this local transport metadata.
   */
  async subscribeReadyWithGeneration(
    subscription: RuntimeSubscription,
  ): Promise<AsyncIterable<RuntimeClientNotificationWithGeneration>> {
    const state = this.#createSubscription(subscription.spec, subscription.signal, true);
    try {
      await this.#activateSubscription(state);
      await this.#waitForReady(state);
      return state.queue.iterableWithGeneration(() => {
        void this.#closeSubscription(state, true).catch(() => undefined);
      });
    } catch (error) {
      await this.#closeSubscription(state, false);
      throw error;
    }
  }

  /** A child stream is authorized through its parent Session, then delivered as a read-only Session stream. */
  async subscribeChildReadyWithGeneration(subscription: {
    readonly spec: Extract<RuntimeProtocolSubscriptionSpec, { readonly scope: 'child_session' }>;
    readonly signal?: AbortSignal;
  }): Promise<AsyncIterable<RuntimeClientNotificationWithGeneration>> {
    const state = this.#createSubscription(subscription.spec, subscription.signal, true);
    try {
      await this.#activateSubscription(state);
      await this.#waitForReady(state);
      return state.queue.iterableWithGeneration(() => {
        void this.#closeSubscription(state, true).catch(() => undefined);
      });
    } catch (error) {
      await this.#closeSubscription(state, false);
      throw error;
    }
  }

  /** Optional lifecycle handle for consumers that need the remote subscription identity. */
  async subscribeHandle(spec: RuntimeSubscriptionSpec): Promise<RuntimeClientSubscription> {
    const state = this.#createSubscription(spec);
    try {
      await this.#activateSubscription(state);
    } catch (error) {
      await this.#closeSubscription(state, false);
      throw error;
    }
    return this.#subscriptionHandle(state);
  }

  async unsubscribe(subscriptionId: string): Promise<boolean> {
    const state = this.#subscriptions.get(subscriptionId);
    if (!state) return false;
    return this.#closeSubscription(state, true);
  }

  #createSubscription(
    spec: RuntimeProtocolSubscriptionSpec,
    signal?: AbortSignal,
    waitForReady = false,
    indexObserverOnly = false,
  ): SubscriptionState {
    let ready: SubscriptionState['ready'];
    if (waitForReady) {
      let resolve!: () => void;
      let reject!: (error: RuntimeClientError) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      void promise.catch(() => undefined);
      ready = Object.freeze({ promise, resolve, reject });
    }
    const state: SubscriptionState = {
      id: `client-subscription-${++this.#nextSubscription}`,
      spec,
      queue: new RuntimeNotificationQueue(),
      signal,
      ...(indexObserverOnly ? { indexObserverOnly: true } : {}),
      ...(ready ? { ready } : {}),
    };
    this.#subscriptions.set(state.id, state);
    const onAbort = (): void => {
      void this.#closeSubscription(state, true).catch(() => undefined);
    };
    state.onAbort = onAbort;
    if (signal?.aborted) {
      void this.#closeSubscription(state, false);
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }
    return state;
  }

  async #closeSubscription(state: SubscriptionState, sendUnsubscribe: boolean): Promise<boolean> {
    if (!this.#subscriptions.delete(state.id)) return false;
    state.ready?.reject(closedError());
    state.queue.close();
    if (state.signal && state.onAbort) state.signal.removeEventListener('abort', state.onAbort);
    const releasedSessionId =
      state.spec.scope === 'session'
        ? state.spec.sessionId
        : state.spec.scope === 'child_session'
          ? state.spec.childSessionId
          : undefined;
    if (
      releasedSessionId &&
      ![...this.#subscriptions.values()].some(
        (remaining) =>
          (remaining.spec.scope === 'sessions' && !remaining.indexObserverOnly) ||
          (remaining.spec.scope === 'session' && remaining.spec.sessionId === releasedSessionId) ||
          (remaining.spec.scope === 'child_session' &&
            remaining.spec.childSessionId === releasedSessionId),
      )
    ) {
      this.#store.discardSession(releasedSessionId);
      this.#appliedBackgroundListQueries.delete(releasedSessionId);
    }
    const remoteId = state.remoteId;
    const remoteConnectionGeneration = state.connectionGeneration;
    const subscribeRequestId = state.subscribeRequestId;
    const subscribeRequestGeneration = state.subscribeRequestGeneration;
    state.remoteId = undefined;
    state.remoteGeneration = undefined;
    state.connectionGeneration = undefined;
    state.subscribeRequestId = undefined;
    state.subscribeRequestGeneration = undefined;
    if (
      !sendUnsubscribe ||
      !this.#connection ||
      (remoteId
        ? remoteConnectionGeneration !== this.#connectionGeneration
        : !subscribeRequestId || subscribeRequestGeneration !== this.#connectionGeneration)
    )
      return true;
    const connection = this.#connection;
    try {
      const result = await this.#request(
        'runtime/unsubscribe',
        remoteId ? { subscriptionId: remoteId } : { subscribeRequestId },
      );
      if (!isUnsubscribeResult(result)) throw new Error('Invalid unsubscribe result.');
      return result.unsubscribed;
    } catch (error) {
      if (this.#connection === connection)
        void connection.close('runtime_subscription_cleanup_failed').catch(() => undefined);
      throw error;
    }
  }

  async close(reason = 'runtime_client_closed'): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#appliedBackgroundListQueries.clear();
    this.#failHistoryLoads(closedError());
    this.#store.setConnection({ generation: this.#connectionGeneration, status: 'draining' });
    this.#rejectPending(this.#connectionGeneration, closedError());
    const connection = this.#connection;
    this.#connection = undefined;
    for (const state of this.#subscriptions.values()) {
      state.ready?.reject(closedError());
      state.remoteId = undefined;
      state.remoteGeneration = undefined;
      state.subscribeRequestId = undefined;
      state.subscribeRequestGeneration = undefined;
      state.queue.close();
    }
    try {
      await connection?.close(reason);
    } finally {
      this.#store.dispose();
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #open(
    status: Extract<RuntimeClientConnectionStatus, 'connecting' | 'reconnecting'>,
    resubscribe: boolean,
  ): Promise<void> {
    if (status === 'reconnecting') {
      this.#failHistoryLoads(
        new RuntimeClientError('connection_closed', 'Runtime connection was replaced.'),
      );
    }
    const previous = this.#connection;
    const previousGeneration = this.#connectionGeneration;
    const generation = previousGeneration + 1;
    this.#connectionGeneration = generation;
    this.#connection = undefined;
    this.#features = NO_RUNTIME_FEATURES;
    this.#historyCancelSupported = false;
    // A remote id belongs to the connection that created it. It must never be
    // matched, or unsubscribed, on the replacement connection.
    for (const state of this.#subscriptions.values()) {
      state.remoteId = undefined;
      state.remoteGeneration = undefined;
      state.connectionGeneration = undefined;
      state.subscribeRequestId = undefined;
      state.subscribeRequestGeneration = undefined;
    }
    this.#store.setConnection({ generation, status });
    this.#rejectPending(
      previousGeneration,
      new RuntimeClientError('connection_closed', 'Runtime connection was replaced.'),
    );
    let openedConnection: RuntimeClientConnection | undefined;
    try {
      await previous?.close('runtime_client_reconnect');
      const connection = await this.#transport.connect();
      openedConnection = connection;
      if (this.#closed || generation !== this.#connectionGeneration) {
        await connection.close('stale_runtime_client_connection');
        throw closedError();
      }
      this.#connection = connection;
      void this.#receive(connection, generation);
      let initialize: RuntimeProtocolResult;
      try {
        initialize = await this.#request('initialize', {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          clientInfo: this.#clientInfo,
          featureNegotiation: true,
        });
      } catch (error) {
        if (
          !(error instanceof RuntimeClientError) ||
          error.code !== 'protocol_error' ||
          (error.protocol?.data.code !== 'invalid_request' &&
            error.protocol?.data.code !== 'invalid_params')
        ) {
          throw error;
        }
        // A strict pre-negotiation Host rejects the additive request field.
        // Retrying initialize without it is safe: no Runtime mutation or
        // subscription has been admitted yet, and all feature bits remain false.
        initialize = await this.#request('initialize', {
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          clientInfo: this.#clientInfo,
        });
      }
      if (!isInitializeResult(initialize)) {
        throw new RuntimeClientError(
          'protocol_error',
          'Protocol returned an invalid initialize result.',
        );
      }
      this.#assertExpectedServer(initialize);
      this.#historyCancelSupported = initialize.capabilities.methods.includes('history/cancel');
      this.#features = Object.freeze({
        steer: initialize.capabilities.features?.steer ?? false,
        backgroundQuery: initialize.capabilities.features?.backgroundQuery ?? false,
        backgroundControl: initialize.capabilities.features?.backgroundControl ?? false,
      });
      this.#store.setConnection({
        generation,
        status: 'active',
        serverInstanceId: initialize.serverInfo.instanceId,
      });
      if (resubscribe) {
        for (const state of this.#subscriptions.values()) await this.#activateSubscription(state);
      }
    } catch (error) {
      if (generation === this.#connectionGeneration) this.#failHistoryLoads(error);
      if (openedConnection && openedConnection !== previous) {
        await openedConnection.close('runtime_client_initialize_failed').catch(() => undefined);
      }
      if (generation === this.#connectionGeneration) {
        this.#connection = undefined;
        this.#store.setConnection({ generation, status: 'disconnected' });
      }
      if (error instanceof RuntimeClientError) throw error;
      throw new RuntimeClientError(
        'connection_failed',
        'Runtime connection could not be established.',
      );
    }
  }

  #assertExpectedServer(initialize: InitializeResult): void {
    const expected = this.#expectedServer;
    if (!expected) return;
    if (initialize.serverInfo.version !== expected.version) {
      throw new RuntimeClientError('server_mismatch', 'Runtime Server version does not match.');
    }
    const advertised = new Set(initialize.capabilities.methods);
    if (expected.requiredMethods?.some((method) => !advertised.has(method))) {
      throw new RuntimeClientError(
        'server_mismatch',
        'Runtime Server capability set is incomplete.',
      );
    }
  }

  async #activateSubscription(state: SubscriptionState): Promise<void> {
    if (!this.#subscriptions.has(state.id)) return;
    state.joinedActiveParentRunId = undefined;
    const result = await this.#request(
      'runtime/subscribe',
      { subscription: state.spec },
      state,
      state.signal,
    );
    const connectionGeneration = this.#connectionGeneration;
    if (!isSubscribeResult(result)) {
      throw new RuntimeClientError(
        'protocol_error',
        'Protocol returned an invalid subscribe result.',
      );
    }
    // An async subscribe result may arrive as reconnect replaces the
    // connection. Do not let that old result resurrect a stale identity.
    if (
      !this.#subscriptions.has(state.id) ||
      !this.#connection ||
      connectionGeneration !== this.#connectionGeneration
    )
      return;
    this.#bindRemoteSubscription(state, result, connectionGeneration);
  }

  async #waitForReady(state: SubscriptionState): Promise<void> {
    const connection = this.#connection;
    const generation = this.#connectionGeneration;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        state.ready!.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new RuntimeClientError(
                'request_timeout',
                'Runtime subscription initial state timed out.',
              ),
            );
            if (connection && generation === this.#connectionGeneration) {
              void connection.close('runtime_subscription_ready_timeout').catch(() => undefined);
            }
          }, this.#requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #subscriptionHandle(state: SubscriptionState): RuntimeClientSubscription {
    return Object.freeze({
      id: state.id,
      spec: state.spec,
      get generation(): number {
        return state.remoteGeneration ?? 0;
      },
      unsubscribe: () => this.#closeSubscription(state, true),
    });
  }

  async #request(
    method:
      | 'initialize'
      | 'runtime/command'
      | 'runtime/query'
      | 'runtime/subscribe'
      | 'runtime/unsubscribe'
      | 'history/list_sessions'
      | 'history/list_events'
      | 'history/load_session'
      | 'history/load_child_session'
      | RuntimeProtocolAppMethod
      | import('@kite-ai/runtime-protocol').RuntimeProtocolServerControlMethod,
    params: unknown,
    subscriptionState?: SubscriptionState,
    signal?: AbortSignal,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<RuntimeProtocolResult> {
    signal?.throwIfAborted();
    const deadline = Date.now() + timeoutMs;
    if (!this.#connection) {
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let onConnectAbort: (() => void) | undefined;
      try {
        await Promise.race([
          this.connectForRequest(),
          new Promise<never>((_, reject) => {
            connectTimer = setTimeout(
              () =>
                reject(
                  new RuntimeClientError(
                    'request_timeout',
                    `Runtime ${method} connection timed out.`,
                  ),
                ),
              Math.max(0, deadline - Date.now()),
            );
          }),
          new Promise<never>((_, reject) => {
            onConnectAbort = () =>
              reject(signal?.reason ?? new Error('Runtime request cancelled.'));
            signal?.addEventListener('abort', onConnectAbort, { once: true });
            if (signal?.aborted) onConnectAbort();
          }),
        ]);
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
        if (onConnectAbort) signal?.removeEventListener('abort', onConnectAbort);
      }
    }
    signal?.throwIfAborted();
    if (subscriptionState && !this.#subscriptions.has(subscriptionState.id)) throw closedError();
    const connection = this.#connection;
    const generation = this.#connectionGeneration;
    if (!connection)
      throw new RuntimeClientError('connection_closed', 'Runtime connection is unavailable.');
    const id = `rpc-${generation}-${++this.#nextRequest}`;
    let sendStarted = false;
    const cancelRemoteHistoryRead = (): void => {
      if (
        !sendStarted ||
        !method.startsWith('history/') ||
        !this.#historyCancelSupported ||
        this.#connection !== connection ||
        this.#connectionGeneration !== generation
      )
        return;
      try {
        void connection
          .send({ jsonrpc: '2.0', method: 'history/cancel', params: { requestId: id } })
          .catch(() => undefined);
      } catch {
        // Cancellation is best-effort; the original request is already rejected locally.
      }
    };
    const response = new Promise<RuntimeProtocolResult>((resolve, reject) => {
      const finish = (): void => {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        finish();
        reject(signal?.reason ?? new Error('Runtime request cancelled.'));
        cancelRemoteHistoryRead();
      };
      const timer = setTimeout(
        () => {
          finish();
          reject(
            new RuntimeClientError('request_timeout', `Runtime ${method} response timed out.`),
          );
          cancelRemoteHistoryRead();
          // A subscribe may have succeeded remotely even though its ack was lost.
          // Closing this logical connection lets the Server release that identity.
          if (method === 'runtime/subscribe') {
            void connection.close('runtime_subscribe_timeout').catch(() => undefined);
          }
        },
        Math.max(0, deadline - Date.now()),
      );
      this.#pending.set(id, {
        generation,
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
        subscriptionState,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const sendFailed = (error: unknown): void => {
      const pending = this.#pending.get(id);
      pending?.reject(
        method === 'initialize' && error instanceof RuntimeClientStartupError
          ? error
          : new RuntimeClientError('connection_failed', 'Runtime request could not be sent.'),
      );
    };
    if (!signal?.aborted) {
      sendStarted = true;
      if (method === 'runtime/subscribe' && subscriptionState) {
        subscriptionState.subscribeRequestId = id;
        subscriptionState.subscribeRequestGeneration = generation;
      }
      try {
        void connection
          .send({ jsonrpc: '2.0', id, method, params } as RuntimeProtocolMessage)
          .catch(sendFailed);
      } catch (error) {
        sendFailed(error);
      }
    }
    return response;
  }

  async connectForRequest(): Promise<void> {
    if (this.#connection) return;
    if (this.#connectPromise) return this.#connectPromise;
    return this.connect();
  }

  #scheduleHistoryLoad<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(closedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const waitDeadline = Date.now() + this.#requestTimeoutMs;
      let state: 'waiting' | 'active' | 'done' = 'waiting';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const task: WaitingHistoryLoad = {
        start: () => {
          if (state !== 'waiting') return;
          if (Date.now() >= waitDeadline) {
            task.cancel(
              new RuntimeClientError('request_timeout', 'Runtime History request wait timed out.'),
            );
            return;
          }
          state = 'active';
          if (timer) clearTimeout(timer);
          this.#activeHistoryLoads.add(controller);
          void Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted();
              return operation(controller.signal);
            })
            .then(resolve, reject)
            .finally(() => {
              state = 'done';
              cleanup();
              this.#activeHistoryLoads.delete(controller);
              this.#drainHistoryLoads();
            });
        },
        cancel: (error) => {
          if (state === 'done') return;
          controller.abort(error);
          if (state === 'active') return;
          state = 'done';
          const index = this.#waitingHistoryLoads.indexOf(task);
          if (index !== -1) this.#waitingHistoryLoads.splice(index, 1);
          cleanup();
          reject(error);
        },
      };
      const onAbort = (): void => task.cancel(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () =>
          task.cancel(
            new RuntimeClientError('request_timeout', 'Runtime History request timed out.'),
          ),
        Math.max(0, waitDeadline - Date.now()),
      );
      if (signal?.aborted) {
        task.cancel(signal.reason);
      } else if (this.#activeHistoryLoads.size < MAX_ACTIVE_HISTORY_LOADS) {
        task.start();
      } else {
        this.#waitingHistoryLoads.push(task);
      }
    });
  }

  #drainHistoryLoads(): void {
    while (
      this.#activeHistoryLoads.size < MAX_ACTIVE_HISTORY_LOADS &&
      this.#waitingHistoryLoads.length > 0
    ) {
      this.#waitingHistoryLoads.shift()?.start();
    }
  }

  #failHistoryLoads(error: unknown): void {
    const waiting = this.#waitingHistoryLoads.splice(0);
    for (const task of waiting) task.cancel(error);
    for (const controller of this.#activeHistoryLoads) controller.abort(error);
  }

  async #receive(connection: RuntimeClientConnection, generation: number): Promise<void> {
    let receiveError: unknown;
    try {
      for await (const value of connection.messages()) {
        if (
          this.#closed ||
          generation !== this.#connectionGeneration ||
          connection !== this.#connection
        )
          return;
        const decoded = safeDecodeRuntimeProtocolMessage(value);
        if (!decoded.success) continue;
        this.#handleMessage(decoded.data, generation);
      }
    } catch (error) {
      receiveError = error;
      // The deterministic disconnect path below rejects only this generation.
    } finally {
      if (
        !this.#closed &&
        generation === this.#connectionGeneration &&
        connection === this.#connection
      ) {
        const status = this.#store.getSnapshot().status;
        const initializing = status === 'connecting' || status === 'reconnecting';
        this.#connection = undefined;
        this.#failHistoryLoads(
          new RuntimeClientError('connection_closed', 'Runtime connection closed.'),
        );
        this.#store.setConnection({ generation, status: 'disconnected' });
        this.#rejectPending(
          generation,
          initializing && receiveError instanceof RuntimeClientStartupError
            ? receiveError
            : new RuntimeClientError('connection_closed', 'Runtime connection closed.'),
        );
      }
    }
  }

  #handleMessage(message: RuntimeProtocolMessage, connectionGeneration: number): void {
    if ('id' in message && !('method' in message)) {
      if (message.id === null) return;
      const pending = this.#pending.get(message.id);
      if (!pending || pending.generation !== connectionGeneration) return;
      this.#pending.delete(message.id);
      if ('error' in message) {
        pending.reject(
          new RuntimeClientError(
            message.error.data.detailCode === 'history_too_large'
              ? 'history_too_large'
              : message.error.data.code === 'overloaded'
                ? 'request_overloaded'
                : 'protocol_error',
            message.error.message,
            message.error,
          ),
        );
      } else {
        if (pending.subscriptionState && isSubscribeResult(message.result)) {
          this.#bindRemoteSubscription(
            pending.subscriptionState,
            message.result,
            connectionGeneration,
          );
        }
        pending.resolve(message.result);
      }
      return;
    }
    if (!('method' in message)) return;
    if (message.method === 'server/draining') {
      this.#store.setConnection({ generation: connectionGeneration, status: 'draining' });
      return;
    }
    if (message.method !== 'runtime/subscription') return;
    const state = [...this.#subscriptions.values()].find(
      (candidate) =>
        candidate.remoteId === message.params.subscriptionId &&
        candidate.remoteGeneration === message.params.generation &&
        candidate.connectionGeneration === connectionGeneration,
    );
    if (!state) return;
    this.#applySubscriptionMessage(
      connectionGeneration,
      message.params.generation,
      state,
      message.params.message,
    );
  }

  #bindRemoteSubscription(
    state: SubscriptionState,
    result: { readonly subscriptionId: string; readonly generation: number },
    connectionGeneration: number,
  ): void {
    if (
      !this.#subscriptions.has(state.id) ||
      !this.#connection ||
      connectionGeneration !== this.#connectionGeneration
    ) {
      return;
    }
    state.remoteId = result.subscriptionId;
    state.remoteGeneration = result.generation;
    state.connectionGeneration = connectionGeneration;
  }

  #applySubscriptionMessage(
    connectionGeneration: number,
    subscriptionGeneration: number,
    state: SubscriptionState,
    message: RuntimeSubscriptionMessage,
  ): void {
    const { spec } = state;
    if (
      state.indexObserverOnly &&
      (message.type === 'index_reset_begin' ||
        message.type === 'session_upsert' ||
        message.type === 'session_remove' ||
        message.type === 'index_reset_end')
    ) {
      this.#pushSubscriptionNotification(state, message, connectionGeneration);
      return;
    }
    switch (message.type) {
      case 'index_reset_begin':
        if (
          this.#store.beginIndexReset({
            connectionGeneration,
            subscriptionGeneration: message.generation,
            serverInstanceId: message.serverInstanceId,
            indexRevision: message.indexRevision,
          }) !== 'applied'
        )
          return;
        this.#pushSubscriptionNotification(state, message, connectionGeneration);
        return;
      case 'session_upsert':
        if (
          this.#store.applyIndexSession({
            connectionGeneration,
            subscriptionGeneration: message.generation,
            indexRevision: message.indexRevision,
            session: message.session,
          }) !== 'applied'
        )
          return;
        this.#pushSubscriptionNotification(state, message, connectionGeneration);
        return;
      case 'session_remove':
        if (
          this.#store.removeIndexSession({
            connectionGeneration,
            subscriptionGeneration: message.generation,
            indexRevision: message.indexRevision,
            sessionId: message.sessionId,
          }) !== 'applied'
        )
          return;
        this.#pushSubscriptionNotification(state, message, connectionGeneration);
        return;
      case 'index_reset_end':
        if (
          this.#store.endIndexReset({
            connectionGeneration,
            subscriptionGeneration: message.generation,
            indexRevision: message.indexRevision,
          }) !== 'applied'
        )
          return;
        this.#pushSubscriptionNotification(state, message, connectionGeneration);
        return;
      case 'reset':
        state.joinedActiveParentRunId = undefined;
        for (const session of message.sessions) {
          const notification = durableNotification(session);
          const applied = this.#store.applySessionNotification({
            connectionGeneration,
            subscriptionGeneration,
            notification,
            reset: true,
          });
          if (applied !== 'applied') continue;
          this.#pushSubscriptionNotification(state, notification, connectionGeneration);
        }
        return;
      case 'notification': {
        if (message.durability === 'ephemeral') {
          const notification = ephemeralNotification(message);
          const joinedRunId = state.joinedActiveParentRunId;
          const currentRun =
            spec.scope === 'session'
              ? this.#store.getSnapshot().sessions[spec.sessionId]?.projection.currentRun
              : undefined;
          const applied = this.#store.applySessionNotification({
            connectionGeneration,
            subscriptionGeneration,
            notification,
            // Only the parent Run already active at ready may have skipped
            // frames. A Run started after ready must begin at sequence one.
            ...(spec.scope === 'child_session' ||
            (spec.scope === 'session' &&
              joinedRunId !== undefined &&
              joinedRunId === currentRun?.runId &&
              (notification.runId === undefined || notification.runId === joinedRunId))
              ? { allowInitialEphemeralSequence: true }
              : {}),
          });
          if (spec.scope === 'session' && applied === 'applied')
            state.joinedActiveParentRunId = undefined;
          if (applied === 'resync_required') void this.#resubscribeAfterResync(state);
          if (applied !== 'applied') return;
          this.#pushSubscriptionNotification(state, notification, connectionGeneration);
          return;
        }
        const notification = durableNotification(message.session, message.revision, message.event, {
          ...(message.runId === undefined ? {} : { runId: message.runId }),
          ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
          ...(message.occurredAt === undefined ? {} : { occurredAt: message.occurredAt }),
        });
        state.joinedActiveParentRunId = undefined;
        const applied = this.#store.applySessionNotification({
          connectionGeneration,
          subscriptionGeneration,
          notification,
          ready: spec.scope !== 'sessions',
        });
        if (applied === 'resync_required') void this.#resubscribeAfterResync(state);
        if (applied !== 'applied') return;
        this.#pushSubscriptionNotification(state, notification, connectionGeneration);
        return;
      }
      case 'ready':
        if (spec.scope !== 'sessions') {
          this.#store.markSessionReady({
            connectionGeneration,
            subscriptionGeneration,
            sessionId: spec.scope === 'session' ? spec.sessionId : spec.childSessionId,
          });
        }
        if (spec.scope === 'session') {
          const run = this.#store.getSnapshot().sessions[spec.sessionId]?.projection.currentRun;
          state.joinedActiveParentRunId =
            run?.status === 'running' || run?.status === 'waiting' ? run.runId : undefined;
        }
        state.ready?.resolve();
        return;
    }
  }

  #rejectPending(generation: number, error: RuntimeClientError): void {
    for (const [id, pending] of this.#pending) {
      if (pending.generation !== generation) continue;
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  async #resubscribeAfterResync(state: SubscriptionState): Promise<void> {
    if (state.resyncing || !this.#subscriptions.has(state.id) || this.#closed) return;
    state.resyncing = true;
    const remoteId = state.remoteId;
    const generation = state.connectionGeneration;
    state.remoteId = undefined;
    state.remoteGeneration = undefined;
    state.connectionGeneration = undefined;
    try {
      if (remoteId && generation === this.#connectionGeneration) {
        await this.#request('runtime/unsubscribe', { subscriptionId: remoteId }).catch(
          () => undefined,
        );
      }
      if (
        generation === this.#connectionGeneration &&
        this.#subscriptions.has(state.id) &&
        !this.#closed
      ) {
        await this.#activateSubscription(state);
      }
    } catch {
      // A failed replacement has no live source. End its iterator so the
      // consumer can report/recalibrate instead of waiting indefinitely.
      // A replacement connection owns its own subscription activation.
      if (generation === this.#connectionGeneration) await this.#closeSubscription(state, false);
    } finally {
      state.resyncing = false;
    }
  }

  #pushSubscriptionNotification(
    state: SubscriptionState,
    notification: RuntimeAccessNotification,
    connectionGeneration: number,
  ): void {
    if (state.queue.push(notification, connectionGeneration) !== 'durable_overflow') return;
    // A durable fact cannot be silently discarded. Close the local iterator
    // and release its remote counterpart; callers must resubscribe to obtain
    // a fresh, bounded stream.
    void this.#closeSubscription(state, true).catch(() => undefined);
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface QueuedRuntimeNotification {
  readonly notification: RuntimeAccessNotification;
  readonly connectionGeneration: number;
}

class RuntimeNotificationQueue {
  readonly #items: QueuedRuntimeNotification[] = [];
  readonly #waiters = new Set<(result: IteratorResult<QueuedRuntimeNotification>) => void>();
  #closed = false;

  push(
    notification: RuntimeAccessNotification,
    connectionGeneration: number,
  ): 'accepted' | 'dropped_ephemeral' | 'durable_overflow' | 'closed' {
    if (this.#closed) return 'closed';
    const waiter = this.#waiters.values().next().value as
      | ((result: IteratorResult<QueuedRuntimeNotification>) => void)
      | undefined;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({
        done: false,
        value: Object.freeze({ notification, connectionGeneration }),
      });
      return 'accepted';
    }
    if (this.#items.length < 256) {
      this.#items.push(Object.freeze({ notification, connectionGeneration }));
      return 'accepted';
    }
    // Stream deltas are intentionally lossy. Before failing a subscription,
    // evict every queued ephemeral value and retain the newest one. Durable
    // messages retain FIFO order and are never evicted or silently dropped.
    const retained = this.#items.filter((item) => !isEphemeralNotification(item.notification));
    if (retained.length < 256) {
      this.#items.splice(0, this.#items.length, ...retained);
      this.#items.push(Object.freeze({ notification, connectionGeneration }));
      return 'accepted';
    }
    if (isEphemeralNotification(notification)) return 'dropped_ephemeral';
    this.close();
    return 'durable_overflow';
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.length = 0;
    for (const waiter of this.#waiters) waiter({ done: true, value: undefined });
    this.#waiters.clear();
  }

  iterable(onReturn: () => void): AsyncIterable<RuntimeAccessNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<RuntimeAccessNotification>> => {
          const item = this.#items.shift();
          if (item) return Promise.resolve({ done: false, value: item.notification });
          if (this.#closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<RuntimeAccessNotification>>((resolve) =>
            this.#waiters.add((result) =>
              resolve(
                result.done
                  ? { done: true, value: undefined }
                  : { done: false, value: result.value.notification },
              ),
            ),
          );
        },
        return: async (): Promise<IteratorResult<RuntimeAccessNotification>> => {
          onReturn();
          this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }

  iterableWithGeneration(onReturn: () => void): AsyncIterable<QueuedRuntimeNotification> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<QueuedRuntimeNotification>> => {
          const item = this.#items.shift();
          if (item) return Promise.resolve({ done: false, value: item });
          if (this.#closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<QueuedRuntimeNotification>>((resolve) =>
            this.#waiters.add(resolve),
          );
        },
        return: async (): Promise<IteratorResult<QueuedRuntimeNotification>> => {
          onReturn();
          this.close();
          return { done: true, value: undefined };
        },
      }),
    };
  }
}

function durableNotification(
  session: RuntimeSessionProjection,
  revision = session.revision,
  event?: RuntimeClientEvent,
  identity: Readonly<{
    runId?: string;
    taskId?: string;
    turnId?: string;
    occurredAt?: string;
  }> = {},
): Extract<RuntimeNotification, { durability: 'durable' }> {
  return {
    schema: 'kite.runtime-notification.v2' as const,
    durability: 'durable' as const,
    sessionId: session.sessionId,
    revision,
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    ...(identity.taskId === undefined ? {} : { taskId: identity.taskId }),
    ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
    ...(identity.occurredAt === undefined ? {} : { occurredAt: identity.occurredAt }),
    projection: { kind: 'session' as const, session, ...(event === undefined ? {} : { event }) },
  };
}

/** Convert one already accepted Runtime notification to the TUI envelope. */
export function toAcceptedPresentationEnvelope(
  notification: RuntimeNotification,
  connectionGeneration: number,
): AcceptedPresentationEnvelope | undefined {
  const event =
    notification.durability === 'durable' ? notification.projection.event : notification.event;
  if (!event) return undefined;
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    throw new Error('Accepted presentation envelope connection generation is invalid.');
  }
  const run =
    notification.durability === 'durable' ? notification.projection.session.currentRun : undefined;
  const eventRunId = event.type === 'run.terminal' ? event.runId : undefined;
  const eventTaskId =
    event.type === 'task.terminal' ||
    event.type === 'planning.entered' ||
    event.type === 'planning.exited'
      ? event.taskId
      : undefined;
  const eventTurnId = event.type === 'turn.terminal' ? event.turnId : undefined;
  const startedTurnId = event.type === 'turn.started' ? event.turnId : undefined;
  const envelope = Object.freeze({
    sessionId: notification.sessionId,
    connectionGeneration,
    durability: notification.durability,
    ...(notification.durability === 'durable'
      ? {
          revision: notification.revision,
          ...(notification.occurredAt === undefined ? {} : { occurredAt: notification.occurredAt }),
        }
      : {}),
    ...(notification.durability === 'ephemeral'
      ? {
          ...((notification.runId ?? eventRunId)
            ? { runId: notification.runId ?? eventRunId }
            : {}),
          ...((eventTaskId ?? notification.taskId ?? notification.workId)
            ? { taskId: eventTaskId ?? notification.taskId ?? notification.workId }
            : {}),
          turnId: startedTurnId ?? eventTurnId ?? notification.turnId,
        }
      : {
          ...((notification.runId ?? eventRunId ?? run?.runId)
            ? { runId: notification.runId ?? eventRunId ?? run?.runId }
            : {}),
          ...((notification.taskId ??
          eventTaskId ??
          run?.taskId ??
          notification.projection.session.activeTask?.taskId)
            ? {
                taskId:
                  notification.taskId ??
                  eventTaskId ??
                  run?.taskId ??
                  notification.projection.session.activeTask?.taskId,
              }
            : {}),
          ...((notification.turnId ??
          startedTurnId ??
          eventTurnId ??
          run?.activeTurnId ??
          run?.initialTurnId)
            ? {
                turnId:
                  notification.turnId ??
                  startedTurnId ??
                  eventTurnId ??
                  run?.activeTurnId ??
                  run?.initialTurnId,
              }
            : {}),
        }),
    event,
    ...(notification.durability === 'ephemeral'
      ? {
          stream: Object.freeze({
            actorId: notification.actorId,
            attemptId: notification.attemptId,
            compositionRevision: notification.compositionRevision,
            streamId: notification.streamId,
            sequence: notification.sequence,
          }),
        }
      : {}),
  });
  assertAcceptedPresentationEnvelope(envelope);
  return envelope;
}

function ephemeralNotification(
  message: Extract<
    RuntimeSubscriptionMessage,
    { readonly type: 'notification'; readonly durability: 'ephemeral' }
  >,
): Extract<RuntimeNotification, { readonly durability: 'ephemeral' }> {
  return {
    schema: 'kite.runtime-notification.v2',
    durability: 'ephemeral',
    sessionId: message.sessionId,
    workId: message.workId,
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    ...(message.taskId === undefined ? {} : { taskId: message.taskId }),
    turnId: message.turnId,
    actorId: message.actorId,
    attemptId: message.attemptId,
    compositionRevision: message.compositionRevision,
    streamId: message.streamId,
    sequence: message.sequence,
    event: message.event,
  };
}

function isEphemeralNotification(
  notification: RuntimeAccessNotification,
): notification is Extract<RuntimeNotification, { readonly durability: 'ephemeral' }> {
  return 'durability' in notification && notification.durability === 'ephemeral';
}

function isInitializeResult(result: RuntimeProtocolResult): result is InitializeResult {
  return 'protocolVersion' in result && 'serverInfo' in result;
}

function isSubscribeResult(
  result: RuntimeProtocolResult,
): result is { readonly subscriptionId: string; readonly generation: number } {
  return 'subscriptionId' in result && 'generation' in result;
}

function isUnsubscribeResult(
  result: RuntimeProtocolResult,
): result is { readonly unsubscribed: boolean } {
  return 'unsubscribed' in result;
}

function isCommandReceipt(result: RuntimeProtocolResult): result is RuntimeCommandReceipt {
  return 'commandId' in result && 'status' in result;
}

function isQueryResult(result: RuntimeProtocolResult): result is RuntimeQueryResult {
  return 'queryType' in result && 'status' in result;
}

function closedError(): RuntimeClientError {
  return new RuntimeClientError('connection_closed', 'Runtime Client is closed.');
}
