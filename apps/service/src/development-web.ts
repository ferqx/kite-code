import { createHash, randomBytes } from 'node:crypto';
import { type AgentClient, ClientError, parseCursorSequence } from '@kite-ai/client';
import { apiDocumentationAssets } from './api-docs';
import { fileCheckpointResponse, supportsFileCheckpoints } from './file-checkpoint-response';
import {
  apiSchemas,
  BrowserContextQuerySchema,
  BrowserInfoSchema,
  BrowserModelInputQuerySchema,
  BrowserSessionDirectoryQuerySchema,
  BrowserSessionListSchema,
  BrowserViewSchema,
  BrowserWorkspaceDirectoryPageSchema,
  BrowserWorkspaceDirectoryQuerySchema,
  BrowserWorkspaceListSchema,
  SelectedContextPageSchema,
  SessionDirectoryPageSchema,
  schemas,
} from './http/schema';
import { FileCheckpointListQuerySchema } from './http/schema/file-checkpoints';
import { BrowserSessionLogQuerySchema, SessionLogPageSchema } from './http/schema/session-logs';
import { modelInputResponse, modelOutputResponse } from './model-input-response';

const security = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DevelopmentWebOptions {
  readonly admittedClient: AgentClient;
  /** Trusted compiled assets; not a browser-controlled filesystem or proxy path. */
  readonly assets?: ReadonlyMap<
    string,
    { readonly content: string | Uint8Array; readonly mediaType: string }
  >;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  readonly maxBrowserSessions?: number;
}

/** Development Service owns this explicit listener. Only finite public reads can reach Client. */
export function startDevelopmentWeb(options: DevelopmentWebOptions) {
  const admitted = options.admittedClient.serverInfo;
  if (!admitted) throw new ClientError('connection_not_admitted');
  const original = structuredClone(admitted);
  const assetTypes = new Map([
    ['/index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/app.css', 'text/css; charset=utf-8'],
  ]);
  const assets = new Map<string, { content: string | Uint8Array; mediaType: string }>();
  const assetDigests: [string, string, string][] = [];
  for (const [path, asset] of options.assets ?? []) {
    if (assetTypes.get(path) !== asset.mediaType) throw new ClientError('invalid_browser_assets');
    const content =
      typeof asset.content === 'string' ? asset.content : new Uint8Array(asset.content);
    assets.set(path, { content, mediaType: asset.mediaType });
    assetDigests.push([path, asset.mediaType, createHash('sha256').update(content).digest('hex')]);
  }
  for (const [path, asset] of apiDocumentationAssets()) {
    assets.set(path, asset);
    assetDigests.push([
      path,
      asset.mediaType,
      createHash('sha256').update(asset.content).digest('hex'),
    ]);
  }
  assetDigests.sort((a, b) => a[0].localeCompare(b[0]));
  const pageIdentity = digest(
    JSON.stringify([original.instanceId, original.buildId, original.storeId ?? null, assetDigests]),
  );
  const cookieName = `kite_web_${digest(original.instanceId).slice(0, 24)}`;
  const sessions = new Map<string, number>();
  const reads = new Set<AbortController>();
  const pendingReads = new Set<Promise<void>>();
  let closeTask: Promise<void> | undefined;
  let cleanupFailure: unknown;
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? 5 * 60_000;
  const maximum = options.maxBrowserSessions ?? 128;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || !Number.isSafeInteger(maximum) || maximum < 1)
    throw new ClientError('invalid_browser_limits');
  let endpoint = '',
    closed = false;

  function response(
    status: number,
    body: string | Uint8Array | null,
    headers: Record<string, string> = {},
  ) {
    return new Response(body instanceof Uint8Array ? new Uint8Array(body).buffer : body, {
      status,
      headers: { ...security, 'x-kite-web-identity': pageIdentity, ...headers },
    });
  }
  function problem(code: string, status: number) {
    return response(
      status,
      JSON.stringify({
        code,
        message: code,
        scope: 'browser',
        requestId: crypto.randomUUID(),
        retryable: false,
      }),
      { 'content-type': 'application/problem+json' },
    );
  }
  function json(value: unknown) {
    return response(200, JSON.stringify(value), { 'content-type': 'application/json' });
  }
  function cookie(request: Request): string | undefined {
    const values = (request.headers.get('cookie') ?? '').split(';').flatMap((part) => {
      const index = part.indexOf('=');
      return index > 0 && part.slice(0, index).trim() === cookieName
        ? [part.slice(index + 1).trim()]
        : [];
    });
    if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]!)) return undefined;
    return digest(`${original.instanceId}\0${values[0]}`);
  }
  function issue(request: Request): string | undefined {
    for (const [hash, deadline] of sessions) if (deadline <= now()) sessions.delete(hash);
    const previous = cookie(request);
    if (previous) sessions.delete(previous);
    if (sessions.size >= maximum) return undefined;
    const value = randomBytes(32).toString('base64url');
    const deadline = now() + ttl;
    if (!Number.isSafeInteger(deadline) || deadline < 0)
      throw new ClientError('invalid_browser_clock');
    sessions.set(digest(`${original.instanceId}\0${value}`), deadline);
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(ttl / 1000)}`;
  }
  async function identity(signal: AbortSignal) {
    const current = await options.admittedClient.verifyConnection({ signal });
    if (
      current.instanceId !== original.instanceId ||
      current.buildId !== original.buildId ||
      (current.storeId ?? null) !== (original.storeId ?? null)
    )
      throw new ClientError('browser_identity_mismatch');
    return current;
  }
  function info(fileCheckpoints = false) {
    return BrowserInfoSchema.parse({
      instanceId: original.instanceId,
      buildId: original.buildId,
      pageIdentity,
      storeId: original.storeId ?? null,
      dataAvailability: original.dataAvailability,
      capabilities: [
        ...(original.capabilities.includes('sessions')
          ? ['workspaces', 'sessions', 'execution_output']
          : []),
        ...(original.capabilities.includes('session_directory_activity')
          ? ['session_directory_activity']
          : []),
        ...(original.capabilities.includes('history') ? ['history'] : []),
        ...(original.capabilities.includes('context') ? ['context'] : []),
        ...(original.capabilities.includes('model_inputs') ? ['model_inputs'] : []),
        ...(original.capabilities.includes('model_outputs') ? ['model_outputs'] : []),
        ...(original.capabilities.includes('session_exports') ? ['session_exports'] : []),
        ...(original.capabilities.includes('session_logs') ? ['session_logs'] : []),
        ...(fileCheckpoints ? ['file_checkpoints'] : []),
      ],
    });
  }
  function checkpointSegment(value: string) {
    try {
      return decodeURIComponent(value);
    } catch {
      throw new ClientError('invalid_query');
    }
  }
  function query(url: URL, allowed: readonly string[]) {
    const seen = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || seen.has(key)) throw new ClientError('invalid_query');
      seen.add(key);
    }
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    development: false,
    async fetch(request, activeServer) {
      if (closed) return problem('browser_unavailable', 503);
      if (
        activeServer.requestIP(request)?.address !== '127.0.0.1' ||
        request.headers.get('host') !== new URL(endpoint).host ||
        (request.headers.get('origin') && request.headers.get('origin') !== endpoint) ||
        request.headers.has('authorization')
      )
        return problem('browser_request_denied', 403);
      const url = new URL(request.url);
      const shell =
        url.pathname === '/' ||
        /^\/sessions\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(url.pathname);
      if (shell && request.method === 'GET' && !url.search) {
        const hash = cookie(request);
        const authorized = hash && (sessions.get(hash) ?? 0) > now();
        const setCookie = authorized ? undefined : issue(request);
        if (!authorized && !setCookie) return problem('browser_session_unavailable', 503);
        const supplied = assets.get('/index.html')?.content;
        const document =
          supplied === undefined
            ? '<!doctype html><html><head><title>Kite</title></head><body><main id="root">Kite development observation</main></body></html>'
            : typeof supplied === 'string'
              ? supplied
              : new TextDecoder('utf-8', { fatal: true }).decode(supplied);
        return response(
          200,
          document.replace(
            /<head([^>]*)>/i,
            `<head$1><meta name="kite-web-identity" content="${pageIdentity}">`,
          ),
          {
            'content-type': 'text/html; charset=utf-8',
            ...(setCookie ? { 'set-cookie': setCookie } : {}),
          },
        );
      }
      if (url.pathname === '/browser/session') {
        if (!['POST', 'DELETE'].includes(request.method)) return problem('method_not_allowed', 405);
        if (
          url.search ||
          request.headers.get('origin') !== endpoint ||
          request.headers.get('x-kite-web-identity') !== pageIdentity ||
          request.body
        )
          return problem('browser_request_denied', 403);
        if (request.method === 'DELETE') {
          const hash = cookie(request);
          if (hash) sessions.delete(hash);
          return response(204, null, {
            'set-cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
          });
        }
        const setCookie = issue(request);
        return setCookie
          ? response(204, null, { 'set-cookie': setCookie })
          : problem('browser_session_unavailable', 503);
      }
      if (request.method !== 'GET') return problem('method_not_allowed', 405);
      if (!url.pathname.startsWith('/browser/v1/')) {
        const asset = !url.search && assets.get(url.pathname);
        return asset
          ? response(200, asset.content, { 'content-type': asset.mediaType })
          : problem('not_found', 404);
      }
      if (request.headers.get('x-kite-web-identity') !== pageIdentity)
        return problem('browser_identity_mismatch', 409);
      const hash = cookie(request);
      if (!hash || (sessions.get(hash) ?? 0) <= now())
        return problem('browser_session_expired', 401);
      const checkpointMatch =
        /^\/browser\/v1\/sessions\/([^/]+)\/file-checkpoints(?:\/([^/]+)(?:\/restores\/([^/]+))?)?$/.exec(
          url.pathname,
        );
      const viewMatch =
        /^\/browser\/v1\/sessions\/([^/]+)\/(view|messages|context|model-inputs|logs)$/.exec(
          url.pathname,
        );
      const outputMatch = /^\/browser\/v1\/sessions\/([^/]+)\/executions\/([^/]+)\/output$/.exec(
        url.pathname,
      );
      const modelInputMatch =
        /^\/browser\/v1\/sessions\/([^/]+)\/executions\/([^/]+)\/model-input$/.exec(url.pathname);
      const modelOutputMatch =
        /^\/browser\/v1\/sessions\/([^/]+)\/executions\/([^/]+)\/model-output$/.exec(url.pathname);
      const exportMatch =
        /^\/browser\/v1\/sessions\/([^/]+)\/export\/(manifest|records|text|verify)$/.exec(
          url.pathname,
        );
      if (
        ![
          '/browser/v1/server',
          '/browser/v1/workspaces',
          '/browser/v1/sessions',
          '/browser/v1/workspace-directory',
          '/browser/v1/session-directory',
        ].includes(url.pathname) &&
        !checkpointMatch &&
        !viewMatch &&
        !outputMatch &&
        !modelInputMatch &&
        !modelOutputMatch &&
        !exportMatch
      )
        return problem('not_found', 404);
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener('abort', abort, { once: true });
      reads.add(controller);
      let resolveRead!: () => void;
      const readDone = new Promise<void>((resolve) => {
        resolveRead = resolve;
      });
      pendingReads.add(readDone);
      let finished = false,
        streaming = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        reads.delete(controller);
        pendingReads.delete(readDone);
        request.signal.removeEventListener('abort', abort);
        resolveRead();
      };
      // A returned body remains owned until EOF or actual reader cancellation finishes.
      function streamResponse(value: Response): Response {
        const reader = value.body!.getReader();
        streaming = true;
        let stopTask: Promise<void> | undefined;
        let output!: ReadableStreamDefaultController<Uint8Array>;
        const stop = (reason?: unknown) => {
          if (!stopTask)
            stopTask = (async () => {
              try {
                await reader.cancel(reason);
              } catch (error) {
                cleanupFailure ??= error;
                throw error;
              } finally {
                controller.signal.removeEventListener('abort', abortBody);
                reader.releaseLock();
                finish();
              }
            })();
          return stopTask;
        };
        const abortBody = () => {
          output.error(controller.signal.reason);
          void stop(controller.signal.reason).catch(() => {});
        };
        const body = new ReadableStream<Uint8Array>({
          start(target) {
            output = target;
            controller.signal.addEventListener('abort', abortBody, { once: true });
            if (controller.signal.aborted) abortBody();
          },
          async pull(target) {
            try {
              const chunk = await reader.read();
              if (finished) return;
              if (chunk.done) {
                controller.signal.removeEventListener('abort', abortBody);
                reader.releaseLock();
                finish();
                target.close();
              } else target.enqueue(chunk.value);
            } catch (error) {
              if (!finished) target.error(error);
              await stop(error);
            }
          },
          cancel(reason) {
            return stop(reason);
          },
        });
        return new Response(body, { status: value.status, headers: value.headers });
      }
      try {
        await identity(controller.signal);
        if (url.pathname === '/browser/v1/server') {
          query(url, []);
          return json(
            info(await supportsFileCheckpoints(options.admittedClient, controller.signal)),
          );
        }
        if (original.dataAvailability !== 'available') return problem('data_unavailable', 503);
        if (
          url.pathname === '/browser/v1/workspace-directory' ||
          url.pathname === '/browser/v1/session-directory'
        ) {
          const isSession = url.pathname === '/browser/v1/session-directory';
          query(
            url,
            isSession
              ? ['afterSeq', 'upperSeq', 'snapshotCursor', 'limit', 'workspaceId']
              : ['afterSeq', 'upperSeq', 'limit'],
          );
          const parsed = (
            isSession ? BrowserSessionDirectoryQuerySchema : BrowserWorkspaceDirectoryQuerySchema
          ).safeParse(Object.fromEntries(url.searchParams));
          if (!parsed.success) throw new ClientError('invalid_query');
          const page = isSession
            ? await options.admittedClient.listSessionDirectory(
                { storeId: original.storeId!, ...parsed.data },
                { signal: controller.signal },
              )
            : await options.admittedClient.listWorkspaceDirectory(
                { storeId: original.storeId!, ...parsed.data },
                { signal: controller.signal },
              );
          if (isSession) return json(SessionDirectoryPageSchema.parse(page));
          return json(
            BrowserWorkspaceDirectoryPageSchema.parse({
              ...page,
              items: (page as import('@kite-ai/client').WorkspaceDirectoryPage).items.map(
                (item) => ({
                  seq: item.seq,
                  workspace: { id: item.workspace.id, name: item.workspace.name },
                }),
              ),
            }),
          );
        }
        if (url.pathname === '/browser/v1/workspaces') {
          query(url, []);
          const workspaces = await options.admittedClient.listWorkspaces({
            signal: controller.signal,
          });
          return json(
            BrowserWorkspaceListSchema.parse(workspaces.map(({ id, name }) => ({ id, name }))),
          );
        }
        if (url.pathname === '/browser/v1/sessions') {
          query(url, ['workspaceId']);
          const workspaceId = url.searchParams.get('workspaceId');
          if (workspaceId !== null && !id.test(workspaceId)) throw new ClientError('invalid_query');
          const list = await options.admittedClient.listSessions({ signal: controller.signal });
          return json(
            BrowserSessionListSchema.parse(
              list.filter((session) => !workspaceId || session.workspaceId === workspaceId),
            ),
          );
        }
        const sessionId = checkpointMatch
          ? checkpointSegment(checkpointMatch[1]!)
          : decodeURIComponent(
              (viewMatch ?? outputMatch ?? modelInputMatch ?? modelOutputMatch ?? exportMatch)![1]!,
            );
        if (!id.test(sessionId)) throw new ClientError('invalid_query');
        if (checkpointMatch) {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new ClientError('invalid_query');
          const pointId =
            checkpointMatch[2] === undefined ? undefined : checkpointSegment(checkpointMatch[2]);
          const restoreId =
            checkpointMatch[3] === undefined ? undefined : checkpointSegment(checkpointMatch[3]);
          if (
            (pointId !== undefined && !/^[a-f0-9]{64}$/.test(pointId)) ||
            (restoreId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(restoreId))
          )
            throw new ClientError('invalid_query');
          query(url, pointId === undefined ? ['afterKey', 'limit'] : []);
          const parsed = FileCheckpointListQuerySchema.safeParse(
            Object.fromEntries(
              [...url.searchParams].map(([key, value]) => [
                key,
                key === 'limit' ? Number(value) : value,
              ]),
            ),
          );
          if (!parsed.success) throw new ClientError('invalid_query');
          const operation =
            pointId === undefined ? 'list' : restoreId === undefined ? 'detail' : 'status';
          const input =
            pointId === undefined
              ? parsed.data
              : restoreId === undefined
                ? { pointId }
                : { checkpointId: pointId, restoreId };
          const value = await fileCheckpointResponse(
            options.admittedClient,
            original.storeId!,
            sessionId,
            operation,
            input,
            controller.signal,
          );
          await identity(controller.signal);
          return json(value);
        }
        if (exportMatch) {
          if (!info().capabilities.includes('session_exports'))
            throw new ClientError('capability_unavailable');
          const operation = exportMatch[2]!;
          query(
            url,
            operation === 'manifest'
              ? []
              : operation === 'records'
                ? ['manifest', 'section', 'afterSeq', 'limit', 'byteLimit']
                : operation === 'text'
                  ? ['manifest', 'section', 'seq', 'field', 'afterByte', 'limitBytes']
                  : ['manifest'],
          );
          const values: Record<string, unknown> = {};
          for (const [key, value] of url.searchParams) {
            if (key === 'manifest') {
              if (new TextEncoder().encode(value).byteLength > 32768)
                throw new ClientError('invalid_query');
              try {
                values[key] = JSON.parse(value);
              } catch {
                throw new ClientError('invalid_query');
              }
            } else
              values[key] = ['limit', 'byteLimit', 'limitBytes'].includes(key)
                ? Number(value)
                : value;
          }
          const readOptions = { signal: controller.signal };
          let exported: unknown;
          if (operation === 'manifest') {
            const checked = apiSchemas.BrowserBeginSessionExportQuery.safeParse(values);
            if (!checked.success) throw new ClientError('invalid_query');
            exported = apiSchemas.SessionExportManifest.parse(
              await options.admittedClient.beginSessionExport(
                sessionId,
                { storeId: original.storeId! },
                readOptions,
              ),
            );
          } else if (operation === 'records') {
            const checked = apiSchemas.BrowserSessionExportPageQuery.safeParse(values);
            if (!checked.success) throw new ClientError('invalid_query');
            exported = apiSchemas.SessionExportPage.parse(
              await options.admittedClient.readSessionExportPage(
                sessionId,
                { ...checked.data, storeId: original.storeId! },
                readOptions,
              ),
            );
          } else if (operation === 'text') {
            const checked = apiSchemas.BrowserSessionExportTextQuery.safeParse(values);
            if (!checked.success) throw new ClientError('invalid_query');
            exported = apiSchemas.SessionExportTextPage.parse(
              await options.admittedClient.readSessionExportText(
                sessionId,
                { ...checked.data, storeId: original.storeId! },
                readOptions,
              ),
            );
          } else {
            const checked = apiSchemas.BrowserVerifySessionExportQuery.safeParse(values);
            if (!checked.success) throw new ClientError('invalid_query');
            exported = apiSchemas.SessionExportCompletion.parse(
              await options.admittedClient.verifySessionExport(
                sessionId,
                { ...checked.data, storeId: original.storeId! },
                readOptions,
              ),
            );
          }
          await identity(controller.signal);
          return json(exported);
        }
        if (modelOutputMatch) {
          if (!info().capabilities.includes('model_outputs'))
            throw new ClientError('capability_unavailable');
          query(url, []);
          const executionId = decodeURIComponent(modelOutputMatch[2]!);
          if (!id.test(executionId)) throw new ClientError('invalid_query');
          const snapshot = await options.admittedClient.getModelOutput(sessionId, executionId, {
            expectedStoreId: original.storeId!,
            signal: controller.signal,
          });
          await identity(controller.signal);
          return streamResponse(
            modelOutputResponse(snapshot, controller.signal, {
              ...security,
              'x-kite-web-identity': pageIdentity,
            }),
          );
        }
        if (modelInputMatch) {
          if (!info().capabilities.includes('model_inputs'))
            throw new ClientError('capability_unavailable');
          query(url, []);
          const executionId = decodeURIComponent(modelInputMatch[2]!);
          if (!id.test(executionId)) throw new ClientError('invalid_query');
          const snapshot = await options.admittedClient.getModelInput(sessionId, executionId, {
            expectedStoreId: original.storeId!,
            signal: controller.signal,
          });
          await identity(controller.signal);
          return streamResponse(
            modelInputResponse(snapshot, controller.signal, {
              ...security,
              'x-kite-web-identity': pageIdentity,
            }),
          );
        }
        if (viewMatch?.[2] === 'logs') {
          if (!info().capabilities.includes('session_logs'))
            throw new ClientError('capability_unavailable');
          query(url, ['afterCursor', 'upperCursor', 'limit']);
          const parsed = BrowserSessionLogQuerySchema.safeParse(
            Object.fromEntries(
              [...url.searchParams].map(([key, value]) => [
                key,
                key === 'limit' ? Number(value) : value,
              ]),
            ),
          );
          if (!parsed.success) throw new ClientError('invalid_query');
          const page = await options.admittedClient.listSessionLogs(sessionId, {
            ...parsed.data,
            expectedStoreId: original.storeId!,
            signal: controller.signal,
          });
          await identity(controller.signal);
          return json(SessionLogPageSchema.parse(page));
        }
        if (viewMatch?.[2] === 'model-inputs') {
          if (!info().capabilities.includes('model_inputs'))
            throw new ClientError('capability_unavailable');
          query(url, ['afterSeq', 'upperSeq', 'limit']);
          const parsed = BrowserModelInputQuerySchema.safeParse(
            Object.fromEntries(
              [...url.searchParams].map(([key, value]) => [
                key,
                key === 'limit' ? Number(value) : value,
              ]),
            ),
          );
          if (!parsed.success) throw new ClientError('invalid_query');
          const page = await options.admittedClient.listModelInputs(sessionId, {
            ...parsed.data,
            expectedStoreId: original.storeId!,
            signal: controller.signal,
          });
          await identity(controller.signal);
          return json(schemas.ModelInputPage.parse(page));
        }
        if (viewMatch?.[2] === 'context') {
          if (!info().capabilities.includes('context'))
            throw new ClientError('capability_unavailable');
          const fields = [
            'contextSelectionId',
            'afterSeq',
            'upperSeq',
            'messageLimit',
            'afterSourceId',
            'sourceLimit',
            'byteLimit',
          ];
          query(url, fields);
          const values = Object.fromEntries(
            [...url.searchParams].map(([key, value]) => [
              key,
              ['messageLimit', 'sourceLimit', 'byteLimit'].includes(key) ? Number(value) : value,
            ]),
          );
          const checked = BrowserContextQuerySchema.safeParse(values);
          if (!checked.success) throw new ClientError('invalid_query');
          const input = checked.data;
          const after = parseCursorSequence(input.afterSeq ?? '0');
          if (input.upperSeq !== undefined && parseCursorSequence(input.upperSeq) < after)
            throw new ClientError('invalid_query');
          const page = await options.admittedClient.getContext(
            sessionId,
            { ...input, storeId: original.storeId! },
            { signal: controller.signal },
          );
          if (
            page.selection.sessionId !== sessionId ||
            (input.contextSelectionId !== undefined &&
              page.selection.id !== input.contextSelectionId)
          )
            throw new ClientError('browser_identity_mismatch');
          return json(SelectedContextPageSchema.parse(page));
        }
        if (viewMatch?.[2] === 'view') {
          query(url, []);
          const view = await options.admittedClient.getView(sessionId, {
            signal: controller.signal,
          });
          if (view.storeId !== original.storeId) throw new ClientError('browser_identity_mismatch');
          return json(
            BrowserViewSchema.parse({
              ...view,
              runs: view.runs.map(({ configuration: _configuration, ...run }) => run),
              executions: view.executions.map(({ result: _result, ...execution }) => execution),
            }),
          );
        }
        query(url, ['afterSeq', 'upperSeq', 'limit']);
        const afterSeq = url.searchParams.get('afterSeq') ?? undefined;
        const upperSeq = url.searchParams.get('upperSeq') ?? undefined;
        for (const seq of [afterSeq, upperSeq]) if (seq !== undefined) parseCursorSequence(seq);
        if (afterSeq !== undefined && upperSeq !== undefined && BigInt(afterSeq) > BigInt(upperSeq))
          throw new ClientError('invalid_query');
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 200;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
          throw new ClientError('invalid_query');
        if (outputMatch) {
          if (!info().capabilities.includes('execution_output'))
            throw new ClientError('capability_unavailable');
          const executionId = decodeURIComponent(outputMatch[2]!);
          if (!id.test(executionId)) throw new ClientError('invalid_query');
          const execution = await options.admittedClient.getExecution(executionId, {
            signal: controller.signal,
          });
          if (execution.sessionId !== sessionId)
            throw new ClientError('browser_scope_denied', 'browser_scope_denied', 403);
          const output = await options.admittedClient.listExecutionOutput(executionId, {
            afterSeq,
            upperSeq,
            limit,
            signal: controller.signal,
          });
          await identity(controller.signal);
          return json(schemas.ExecutionOutputPage.parse(output));
        }
        const messages = await options.admittedClient.listMessages(sessionId, {
          afterSeq,
          upperSeq,
          limit,
          signal: controller.signal,
        });
        return json(schemas.Message.array().parse(messages));
      } catch (error) {
        if (error instanceof ClientError)
          return problem(
            error.code,
            error.status ??
              (error.code === 'browser_identity_mismatch'
                ? 409
                : ['invalid_query', 'invalid_cursor'].includes(error.code)
                  ? 400
                  : 503),
          );
        return problem('browser_read_unavailable', 503);
      } finally {
        if (!streaming) finish();
      }
    },
  });
  endpoint = `http://127.0.0.1:${server.port}`;
  return {
    endpoint,
    pageIdentity,
    close(): Promise<void> {
      if (closeTask) return closeTask;
      closed = true;
      sessions.clear();
      closeTask = Promise.resolve().then(async () => {
        await Promise.all([...pendingReads]);
        if (cleanupFailure !== undefined) throw cleanupFailure;
        await server.stop(true);
      });
      for (const read of reads) read.abort();
      void closeTask.catch(() => {});
      return closeTask;
    },
  };
}
