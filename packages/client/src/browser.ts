import { verifyContextCompression } from './context';
import { ClientError, decodeResponse, type Responses, validateRequest } from './decode';
import { collectDirectory, validateDirectoryPage } from './directory';
import {
  validateFileCheckpointTarget,
  verifyFileCheckpointDetail,
  verifyFileCheckpointObservation,
  verifyFileCheckpointPage,
  verifyFileRestoreStatus,
} from './file-checkpoints';
import type {
  BrowserBeginSessionExportQuery,
  BrowserContextQuery,
  BrowserInfo,
  BrowserSessionExportPageQuery,
  BrowserSessionExportTextQuery,
  BrowserVerifySessionExportQuery,
} from './generated/api';
import { readModelInputResponse, verifyModelInputPage } from './model-input';
import { readModelOutputResponse } from './model-output';
import {
  sessionExportParameters,
  streamSessionExport,
  verifySessionExportCompletion,
  verifySessionExportManifest,
  verifySessionExportPage,
  verifySessionExportTextPage,
} from './session-export';
import {
  validateSessionLogBounds,
  validateSessionLogTarget,
  verifySessionLogPage,
} from './session-logs';
import { parseCursorSequence } from './sse';

export interface BrowserClientOptions {
  /** Same-origin development gateway selected by the document, never a Native endpoint/token. */
  readonly origin: string;
  readonly pageIdentity: string;
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
}

/** Cookie-only read API. This surface has no business mutation or execution observation stream. */
export class BrowserClient {
  private readonly origin: string;
  private readonly pageIdentity: string;
  private readonly fetch: typeof fetch;
  private readonly maximum: number;
  private readonly reads = new Set<AbortController>();
  private info: BrowserInfo | undefined;
  private renewing: Promise<void> | undefined;
  private sessionGeneration = 0;
  private networkGeneration = 0;
  private closed = false;

  constructor(options: BrowserClientOptions) {
    const origin = new URL(options.origin);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/' ||
      !/^[0-9a-f]{64}$/.test(options.pageIdentity)
    )
      throw new ClientError('invalid_browser_binding');
    this.origin = origin.origin;
    this.pageIdentity = options.pageIdentity;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maximum = options.maxResponseBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1)
      throw new ClientError('invalid_response_limit');
  }

  get serverInfo(): BrowserInfo | undefined {
    return this.info ? structuredClone(this.info) : undefined;
  }

  async connect(options: { signal?: AbortSignal } = {}): Promise<BrowserInfo> {
    const info = await this.read('/browser/v1/server', 'BrowserInfo', options.signal);
    if (
      info.pageIdentity !== this.pageIdentity ||
      (this.info &&
        (info.storeId !== this.info.storeId ||
          info.instanceId !== this.info.instanceId ||
          info.buildId !== this.info.buildId)) ||
      (info.dataAvailability === 'available') !== (info.storeId !== null)
    )
      throw new ClientError('browser_identity_mismatch');
    this.info = structuredClone(info);
    return structuredClone(info);
  }

  private require(capability: BrowserInfo['capabilities'][number]): void {
    if (this.closed) throw new ClientError('browser_session_closed');
    if (!this.info) throw new ClientError('connection_not_admitted');
    if (this.info.dataAvailability !== 'available') throw new ClientError('data_unavailable');
    if (!this.info.capabilities.includes(capability))
      throw new ClientError('capability_unavailable');
  }

  async listWorkspaceDirectory(
    input: import('./generated/api').BrowserWorkspaceDirectoryQuery = {},
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('workspaces');
    const storeId = this.info!.storeId!,
      frozen = structuredClone(input);
    validateRequest('BrowserWorkspaceDirectoryQuery', frozen);
    if (
      frozen.upperSeq !== undefined &&
      parseCursorSequence(frozen.afterSeq ?? '0') > parseCursorSequence(frozen.upperSeq)
    )
      throw new ClientError('invalid_cursor');
    const query = new URLSearchParams(
      Object.entries(frozen)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const page = await this.read(
      `/browser/v1/workspace-directory?${query}`,
      'BrowserWorkspaceDirectoryPage',
      options.signal,
    );
    if (this.info!.storeId !== storeId) throw new ClientError('browser_identity_mismatch');
    return validateDirectoryPage(page, storeId, frozen);
  }
  async listSessionDirectory(
    input: import('./generated/api').BrowserSessionDirectoryQuery = {},
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('sessions');
    const storeId = this.info!.storeId!,
      frozen = structuredClone(input);
    validateRequest('BrowserSessionDirectoryQuery', frozen);
    if (
      frozen.upperSeq !== undefined &&
      parseCursorSequence(frozen.afterSeq ?? '0') > parseCursorSequence(frozen.upperSeq)
    )
      throw new ClientError('invalid_cursor');
    const query = new URLSearchParams(
      Object.entries(frozen)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const page = await this.read(
      `/browser/v1/session-directory?${query}`,
      'SessionDirectoryPage',
      options.signal,
    );
    if (
      this.info!.storeId !== storeId ||
      page.items.some(
        (item) =>
          item.session.parentSessionId !== null ||
          (frozen.workspaceId !== undefined && item.session.workspaceId !== frozen.workspaceId),
      )
    )
      throw new ClientError('browser_identity_mismatch');
    return validateDirectoryPage(page, storeId, frozen);
  }
  async listAllWorkspaces(options: { signal?: AbortSignal } = {}) {
    this.require('workspaces');
    const storeId = this.info!.storeId!,
      generation = this.networkGeneration;
    const result = await collectDirectory(
      (page) => {
        if (this.info!.storeId !== storeId || this.networkGeneration !== generation)
          throw new ClientError('directory_identity_conflict');
        return this.listWorkspaceDirectory(page, options);
      },
      options.signal,
      (item) => item.workspace.id,
    );
    if (this.info!.storeId !== storeId || this.networkGeneration !== generation)
      throw new ClientError('directory_identity_conflict');
    return result.map((item) => item.workspace);
  }
  async listAllSessions(options: { workspaceId?: string; signal?: AbortSignal } = {}) {
    this.require('sessions');
    const workspaceId = options.workspaceId,
      storeId = this.info!.storeId!,
      generation = this.networkGeneration;
    const result = await collectDirectory(
      (page) => {
        if (this.info!.storeId !== storeId || this.networkGeneration !== generation)
          throw new ClientError('directory_identity_conflict');
        return this.listSessionDirectory({ workspaceId, ...page }, options);
      },
      options.signal,
      (item) => item.session.id,
    );
    if (this.info!.storeId !== storeId || this.networkGeneration !== generation)
      throw new ClientError('directory_identity_conflict');
    return result.map((item) => item.session);
  }
  listWorkspaces(options: { signal?: AbortSignal } = {}) {
    this.require('workspaces');
    return this.read('/browser/v1/workspaces', 'BrowserWorkspaceList', options.signal);
  }

  listSessions(options: { workspaceId?: string; signal?: AbortSignal } = {}) {
    this.require('sessions');
    const query =
      options.workspaceId === undefined
        ? ''
        : `?${new URLSearchParams({ workspaceId: options.workspaceId })}`;
    return this.read(`/browser/v1/sessions${query}`, 'BrowserSessionList', options.signal);
  }

  async getView(sessionId: string, options: { signal?: AbortSignal } = {}) {
    this.require('sessions');
    const view = await this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/view`,
      'BrowserView',
      options.signal,
    );
    if (view.storeId !== this.info!.storeId || view.session.id !== sessionId)
      throw new ClientError('browser_identity_mismatch');
    return view;
  }

  private async readExport<K extends keyof Responses>(
    sessionId: string,
    operation: 'manifest' | 'records' | 'text' | 'verify',
    shape: Parameters<typeof validateRequest>[0],
    response: K,
    input:
      | BrowserBeginSessionExportQuery
      | BrowserSessionExportPageQuery
      | BrowserSessionExportTextQuery
      | BrowserVerifySessionExportQuery,
    options: { signal?: AbortSignal },
  ): Promise<Responses[K]> {
    this.require('session_exports');
    const query = structuredClone(input),
      storeId = this.info!.storeId!,
      generation = this.networkGeneration;
    validateRequest(shape, query);
    if (query.manifest) verifySessionExportManifest(query.manifest, storeId, sessionId);
    const value = await this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/export/${operation}?${sessionExportParameters(query)}`,
      response,
      options.signal,
    );
    if (this.networkGeneration !== generation || this.info!.storeId !== storeId)
      throw new ClientError('browser_identity_mismatch');
    return value;
  }
  async beginSessionExport(
    sessionId: string,
    input: BrowserBeginSessionExportQuery = {},
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('session_exports');
    const storeId = this.info!.storeId!;
    return verifySessionExportManifest(
      await this.readExport(
        sessionId,
        'manifest',
        'BrowserBeginSessionExportQuery',
        'SessionExportManifest',
        input,
        options,
      ),
      storeId,
      sessionId,
    );
  }
  async readSessionExportPage(
    sessionId: string,
    input: BrowserSessionExportPageQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('session_exports');
    const query = structuredClone(input),
      storeId = this.info!.storeId!;
    return verifySessionExportPage(
      await this.readExport(
        sessionId,
        'records',
        'BrowserSessionExportPageQuery',
        'SessionExportPage',
        query,
        options,
      ),
      { ...query, storeId },
    );
  }
  async readSessionExportText(
    sessionId: string,
    input: BrowserSessionExportTextQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('session_exports');
    const query = structuredClone(input),
      storeId = this.info!.storeId!;
    return verifySessionExportTextPage(
      await this.readExport(
        sessionId,
        'text',
        'BrowserSessionExportTextQuery',
        'SessionExportTextPage',
        query,
        options,
      ),
      { ...query, storeId },
    );
  }
  async verifySessionExport(
    sessionId: string,
    input: BrowserVerifySessionExportQuery,
    options: { signal?: AbortSignal } = {},
  ) {
    const query = structuredClone(input);
    return verifySessionExportCompletion(
      await this.readExport(
        sessionId,
        'verify',
        'BrowserVerifySessionExportQuery',
        'SessionExportCompletion',
        query,
        options,
      ),
      query.manifest,
    );
  }
  exportSession(sessionId: string, options: { signal?: AbortSignal } = {}) {
    this.require('session_exports');
    const generation = this.networkGeneration,
      storeId = this.info!.storeId!,
      signal = options.signal;
    return streamSessionExport(
      {
        check: () => {
          this.require('session_exports');
          if (this.networkGeneration !== generation || this.info!.storeId !== storeId)
            throw new ClientError('browser_identity_mismatch');
        },
        begin: () => this.beginSessionExport(sessionId, {}, { signal }),
        page: (input) => this.readSessionExportPage(sessionId, input, { signal }),
        text: (input) => this.readSessionExportText(sessionId, input, { signal }),
        verify: (manifest) => this.verifySessionExport(sessionId, { manifest }, { signal }),
      },
      { signal },
    );
  }

  listMessages(
    sessionId: string,
    options: {
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    this.require('history');
    const query = new URLSearchParams();
    for (const field of ['afterSeq', 'upperSeq'] as const) {
      if (options[field] === undefined) continue;
      parseCursorSequence(options[field]!);
      query.set(field, options[field]!);
    }
    if (
      options.afterSeq !== undefined &&
      options.upperSeq !== undefined &&
      parseCursorSequence(options.afterSeq) > parseCursorSequence(options.upperSeq)
    )
      throw new ClientError('invalid_cursor');
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
        throw new ClientError('invalid_page_limit');
      query.set('limit', String(options.limit));
    }
    return this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/messages?${query}`,
      'MessageList',
      options.signal,
    );
  }

  /** Current selected history/sources; this is not a particular Model's actual request. */
  getContext(
    sessionId: string,
    input: BrowserContextQuery = {},
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('context');
    const query = structuredClone(input);
    validateRequest('BrowserContextQuery', query);
    const after = parseCursorSequence(query.afterSeq ?? '0');
    if (query.upperSeq !== undefined && parseCursorSequence(query.upperSeq) < after)
      throw new ClientError('invalid_cursor');
    const params = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    );
    return this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/context?${params}`,
      'SelectedContextPage',
      options.signal,
    ).then((page) => {
      if (
        page.selection.sessionId !== sessionId ||
        (query.contextSelectionId !== undefined && page.selection.id !== query.contextSelectionId)
      )
        throw new ClientError('browser_identity_mismatch');
      return verifyContextCompression(page, sessionId);
    });
  }

  listExecutionOutput(
    sessionId: string,
    executionId: string,
    options: { afterSeq?: string; upperSeq?: string; limit?: number; signal?: AbortSignal } = {},
  ) {
    this.require('execution_output');
    const params = new URLSearchParams();
    const after = parseCursorSequence(options.afterSeq ?? '0');
    if (options.afterSeq !== undefined) params.set('afterSeq', options.afterSeq);
    if (options.upperSeq !== undefined) {
      if (parseCursorSequence(options.upperSeq) < after) throw new ClientError('invalid_cursor');
      params.set('upperSeq', options.upperSeq);
    }
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
        throw new ClientError('invalid_page_limit');
      params.set('limit', String(options.limit));
    }
    return this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(executionId)}/output?${params}`,
      'ExecutionOutputPage',
      options.signal,
    ).then((page) => {
      parseCursorSequence(page.highWaterSeq);
      for (const item of page.items) {
        if (item.executionId !== executionId) throw new ClientError('browser_identity_mismatch');
        parseCursorSequence(item.seq);
        parseCursorSequence(item.throughSeq);
      }
      return page;
    });
  }

  async listFileCheckpoints(
    sessionId: string,
    options: { afterKey?: string; limit?: number; signal?: AbortSignal } = {},
  ) {
    this.require('file_checkpoints');
    validateFileCheckpointTarget(sessionId);
    const { signal, ...query } = options;
    validateRequest('FileCheckpointListQuery', query);
    const target = { storeId: this.info!.storeId!, sessionId },
      generation = this.networkGeneration;
    const page = await this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/file-checkpoints?${new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      )}`,
      'FileCheckpointPage',
      signal,
    );
    if (generation !== this.networkGeneration || target.storeId !== this.info!.storeId)
      throw new ClientError('browser_identity_mismatch');
    return verifyFileCheckpointPage(verifyFileCheckpointObservation(page, target), query);
  }
  async getFileCheckpoint(
    sessionId: string,
    pointId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('file_checkpoints');
    validateFileCheckpointTarget(sessionId, pointId);
    const target = { storeId: this.info!.storeId!, sessionId },
      generation = this.networkGeneration;
    const detail = await this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/file-checkpoints/${encodeURIComponent(pointId)}`,
      'FileCheckpointDetail',
      options.signal,
    );
    if (generation !== this.networkGeneration || target.storeId !== this.info!.storeId)
      throw new ClientError('browser_identity_mismatch');
    return verifyFileCheckpointDetail(verifyFileCheckpointObservation(detail, target), pointId);
  }
  async getFileRestoreStatus(
    sessionId: string,
    pointId: string,
    restoreId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('file_checkpoints');
    validateFileCheckpointTarget(sessionId, pointId, restoreId);
    const target = { storeId: this.info!.storeId!, sessionId },
      generation = this.networkGeneration;
    const status = await this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/file-checkpoints/${encodeURIComponent(pointId)}/restores/${encodeURIComponent(restoreId)}`,
      'FileRestoreStatus',
      options.signal,
    );
    if (generation !== this.networkGeneration || target.storeId !== this.info!.storeId)
      throw new ClientError('browser_identity_mismatch');
    return verifyFileRestoreStatus(
      verifyFileCheckpointObservation(status, target),
      pointId,
      restoreId,
    );
  }

  listSessionLogs(
    sessionId: string,
    options: { afterCursor: string; upperCursor?: string; limit?: number; signal?: AbortSignal },
  ) {
    this.require('session_logs');
    validateSessionLogTarget(sessionId);
    const { signal, ...query } = options;
    validateRequest('BrowserSessionLogQuery', query);
    validateSessionLogBounds(query);
    const storeId = this.info!.storeId!;
    return this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/logs?${new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      )}`,
      'SessionLogPage',
      signal,
    ).then((page) => verifySessionLogPage(page, { storeId, sessionId }, query));
  }
  listModelInputs(
    sessionId: string,
    options: { afterSeq?: string; upperSeq?: string; limit?: number; signal?: AbortSignal } = {},
  ) {
    this.require('model_inputs');
    const { signal, ...query } = options;
    validateRequest('BrowserModelInputQuery', query);
    if (
      query.upperSeq !== undefined &&
      parseCursorSequence(query.afterSeq ?? '0') > parseCursorSequence(query.upperSeq)
    )
      throw new ClientError('invalid_page_bounds');
    const storeId = this.info!.storeId!;
    return this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/model-inputs?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`,
      'ModelInputPage',
      signal,
    ).then((page) => verifyModelInputPage(page, { storeId, sessionId }, query));
  }

  async getModelInput(
    sessionId: string,
    executionId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('model_inputs');
    const storeId = this.info!.storeId!;
    const snapshot = await this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(executionId)}/model-input`,
      'ModelInputSnapshot',
      options.signal,
    );
    if (
      snapshot.storeId !== storeId ||
      snapshot.sessionId !== sessionId ||
      snapshot.executionId !== executionId
    )
      throw new ClientError('model_input_identity_mismatch');
    return snapshot;
  }

  async getModelOutput(
    sessionId: string,
    executionId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    this.require('model_outputs');
    const storeId = this.info!.storeId!;
    const snapshot = await this.read(
      `/browser/v1/sessions/${encodeURIComponent(sessionId)}/executions/${encodeURIComponent(executionId)}/model-output`,
      'ModelOutputSnapshot',
      options.signal,
    );
    if (
      snapshot.storeId !== storeId ||
      snapshot.sessionId !== sessionId ||
      snapshot.executionId !== executionId
    )
      throw new ClientError('model_output_identity_mismatch');
    return snapshot;
  }
  private async read<K extends keyof Responses>(
    path: string,
    shape: K,
    signal?: AbortSignal,
  ): Promise<Responses[K]> {
    if (this.closed) throw new ClientError('browser_session_closed');
    const controller = new AbortController();
    const sessionGeneration = this.sessionGeneration;
    signal?.throwIfAborted();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.reads.add(controller);
    try {
      let response = await this.request(path, 'GET', controller.signal);
      if (response.status === 401) {
        await response.body?.cancel();
        if (sessionGeneration === this.sessionGeneration) await this.renewSession();
        controller.signal.throwIfAborted();
        response = await this.request(path, 'GET', controller.signal);
      }
      if (response.ok && shape === 'ModelInputSnapshot')
        return (await readModelInputResponse(response, controller.signal)) as Responses[K];
      if (response.ok && shape === 'ModelOutputSnapshot')
        return (await readModelOutputResponse(response, controller.signal)) as Responses[K];
      const value = await this.json(
        response,
        shape === 'SessionLogPage' ? Math.min(this.maximum, 512 * 1024) : this.maximum,
      );
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const problem = decodeResponse('Problem', value);
        throw new ClientError(problem.code, problem.message, response.status, problem);
      }
      return decodeResponse(shape, value);
    } catch (error) {
      if (error instanceof ClientError || controller.signal.aborted) throw error;
      throw new ClientError('browser_read_unavailable');
    } finally {
      this.reads.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetch(`${this.origin}${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { accept: 'application/json', 'x-kite-web-identity': this.pageIdentity },
    });
    if (signal?.aborted) {
      await response.body?.cancel();
      signal.throwIfAborted();
    }
    if (response.headers.get('x-kite-web-identity') !== this.pageIdentity) {
      await response.body?.cancel();
      throw new ClientError('browser_identity_mismatch');
    }
    return response;
  }

  private renewSession(): Promise<void> {
    if (!this.renewing) {
      const controller = new AbortController();
      this.reads.add(controller);
      const promise = (async () => {
        const response = await this.request('/browser/session', 'POST', controller.signal);
        await response.body?.cancel();
        controller.signal.throwIfAborted();
        if (!response.ok) throw new ClientError('browser_session_unavailable');
        this.sessionGeneration++;
      })();
      this.renewing = promise.finally(() => {
        this.reads.delete(controller);
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  /** Releasing reads never submits a Runtime cancellation or closes the paired Service. */
  disposeNetwork(): void {
    this.networkGeneration++;
    for (const read of this.reads) read.abort();
    this.reads.clear();
  }

  async closeBrowserSession(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const renewing = this.renewing;
    this.disposeNetwork();
    await renewing?.catch(() => {});
    const response = await this.request('/browser/session', 'DELETE');
    await response.body?.cancel();
    if (!response.ok) throw new ClientError('browser_session_unavailable');
  }

  private async json(response: Response, maximum = this.maximum): Promise<unknown> {
    if (!response.body) throw new ClientError('invalid_response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0,
      text = '';
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximum) throw new ClientError('response_too_large');
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      try {
        return JSON.parse(text);
      } catch {
        throw new ClientError('invalid_response');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export function createBrowserClient(options: BrowserClientOptions): BrowserClient {
  return new BrowserClient(options);
}

export type {
  FileCheckpoint,
  FileCheckpointArtifact,
  FileCheckpointBaseline,
  FileCheckpointBoundary,
  FileCheckpointDetail,
  FileCheckpointPage,
  FileCheckpointRestoreJournal,
  FileRestoreStatus,
} from './generated/api';
