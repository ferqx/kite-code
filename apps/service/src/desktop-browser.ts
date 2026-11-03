import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type BrowserReleasedPage,
  type BrowserSharedPageIdentity,
  BrowserTransportError,
  createNativeBrowserTransport,
  type NativeBrowserTransport,
  type NativeBrowserTransportOptions,
} from '@kite-ai/agent/browser';
import type { JobContext } from '@kite-ai/agent/extensions';

export interface DesktopBrowserEndpoint {
  readonly endpoint: string;
  readonly token: string;
}
type Lease = { leaseId: string; pageId: string; incarnation: string; navigation: number };
type OwnedPageState = Lease & { url: string; title: string };
const boundedIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;
function completeLease(value: unknown): value is Lease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return (
    Object.keys(lease).sort().join(',') === 'incarnation,leaseId,navigation,pageId' &&
    [lease.leaseId, lease.pageId, lease.incarnation].every(boundedIdentity) &&
    Number.isSafeInteger(lease.navigation) &&
    Number(lease.navigation) >= 0
  );
}
function ownedPageState(value: unknown, lease: Lease, minimumNavigation: number): OwnedPageState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BrowserTransportError('desktop_browser_page_state_invalid', true);
  const page = value as Record<string, unknown>;
  if (
    Object.keys(page).sort().join(',') !== 'incarnation,leaseId,navigation,pageId,title,url' ||
    page.leaseId !== lease.leaseId ||
    page.pageId !== lease.pageId ||
    page.incarnation !== lease.incarnation ||
    !Number.isSafeInteger(page.navigation) ||
    Number(page.navigation) < minimumNavigation ||
    typeof page.url !== 'string' ||
    page.url.length > 8192 ||
    typeof page.title !== 'string' ||
    page.title.length > 128
  )
    throw new BrowserTransportError('desktop_browser_page_state_invalid', true);
  try {
    const url = new URL(page.url);
    if (
      page.url !== 'about:blank' &&
      (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    )
      throw Error('invalid');
  } catch {
    throw new BrowserTransportError('desktop_browser_page_state_invalid', true);
  }
  return { ...lease, navigation: Number(page.navigation), url: page.url, title: page.title };
}
function retainedPage(value: unknown, lease: Lease): BrowserReleasedPage | null {
  if (!completeLease(lease) || !value || typeof value !== 'object' || Array.isArray(value))
    return null;
  const page = value as Record<string, unknown>;
  if (
    Object.keys(page).sort().join(',') !== 'incarnation,leaseId,pageId,title,url' ||
    page.leaseId !== lease.leaseId ||
    page.pageId !== lease.pageId ||
    page.incarnation !== lease.incarnation ||
    typeof page.url !== 'string' ||
    page.url.length > 8192 ||
    typeof page.title !== 'string' ||
    page.title.length > 128
  )
    return null;
  try {
    const url = new URL(page.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  } catch {
    return null;
  }
  return {
    url: page.url,
    title: page.title,
    identity: { pageId: lease.pageId, incarnation: lease.incarnation },
  };
}
function confirmsDestroyedPage(value: unknown, lease: Lease) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return (
    Object.keys(proof).sort().join(',') === 'incarnation,kind,leaseId,pageId' &&
    proof.kind === 'page_destroyed' &&
    proof.leaseId === lease.leaseId &&
    proof.pageId === lease.pageId &&
    proof.incarnation === lease.incarnation
  );
}
type FailureKind = 'not_dispatched' | 'read_failed' | 'effect_unknown';
class DesktopBrowserRequestError extends BrowserTransportError {
  readonly kind: FailureKind;
  constructor(code: string, kind: FailureKind) {
    super(code, kind !== 'not_dispatched');
    this.kind = kind;
  }
}
function pairedFailure(reply: Record<string, unknown>, input: Record<string, unknown>) {
  const raw = reply.failure;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;
  const fields = ['kind', 'op'];
  if (typeof input.leaseId === 'string') fields.push('leaseId');
  if (input.op === 'cdp' && typeof input.method === 'string') fields.push('method');
  if (
    Object.keys(value).sort().join(',') !== fields.sort().join(',') ||
    typeof value.kind !== 'string' ||
    !['not_dispatched', 'read_failed', 'effect_unknown'].includes(value.kind) ||
    value.op !== input.op ||
    value.leaseId !== input.leaseId ||
    value.method !== (input.op === 'cdp' ? input.method : undefined) ||
    typeof reply.error !== 'string' ||
    !/^(?:browser_page_|browser_session_page_|browser_capture_|page_request_)[a-z_]{1,100}$/.test(
      reply.error,
    )
  )
    return;
  return new DesktopBrowserRequestError(reply.error, value.kind as FailureKind);
}
function endpoint(input: DesktopBrowserEndpoint) {
  const url = new URL(input.endpoint);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/kite-page' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-f0-9-]{72}$/.test(input.token)
  )
    throw Error('desktop_browser_endpoint_invalid');
  return url.href;
}

/** CDP and owned navigation waits belong to their original owner; passive RPCs remain short. */
export function createDesktopBrowserClient(remote: DesktopBrowserEndpoint) {
  const address = endpoint(remote);
  return async function call(input: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (['cdp', 'navigate'].includes(String(input.op)) && !signal)
      throw Error('desktop_browser_cdp_signal_required');
    // startNative supplies this exact attachment's pollStop signal. Its original
    // Native request deadline/cancellation closes the transport and aborts that
    // signal; a shorter HTTP timer must not interrupt an already dispatched CDP.
    const requestSignal =
      input.op === 'cdp' || input.op === 'navigate'
        ? signal
        : signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000);
    const response = await fetch(address, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${remote.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: requestSignal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw Error('desktop_browser_response_missing');
    const chunks: Uint8Array[] = [];
    let length = 0;
    const maximum =
      input.op === 'cdp' && input.method === 'Page.captureScreenshot'
        ? 6 * 1024 * 1024
        : input.op === 'cdp' && input.method === 'Accessibility.getFullAXTree'
          ? 2 * 1024 * 1024
          : 512 * 1024;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > maximum) throw Error('desktop_browser_response_limit');
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, length);
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new BrowserTransportError('desktop_browser_response_invalid', true);
    const reply = parsed as Record<string, unknown>;
    if (!response.ok || reply.ok !== true) {
      // This endpoint and its credential come only from the paired Main. Main
      // produces proof at its own dispatch boundary; a daemon/error string does not.
      const proven = response.status === 400 && reply.ok === false && pairedFailure(reply, input);
      throw (
        proven ||
        new BrowserTransportError(
          typeof reply.error === 'string' && /^[a-z][a-z0-9_]{1,127}$/.test(reply.error)
            ? reply.error
            : 'desktop_browser_request_failed',
          true,
        )
      );
    }
    return reply.value;
  };
}

/** Trusted paired startup only. No public URL/target/JS setting and no credentials on disk. */
export function createDesktopBrowserTransport(
  options: NativeBrowserTransportOptions,
  remote: DesktopBrowserEndpoint,
  context: JobContext,
  binding: {
    browserId: string;
    storeId?: () => Promise<string>;
    grant?: () => Promise<{ grantId: string; grantExecutionId: string } | undefined>;
    manualDialogs?: () => Promise<boolean>;
  },
): NativeBrowserTransport {
  const call = createDesktopBrowserClient(remote);
  let lease: Lease | undefined, inner: NativeBrowserTransport | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let socket: Bun.ServerWebSocket<unknown> | undefined;
  let socketReceipt:
    | { socket: Bun.ServerWebSocket<unknown>; closed: Promise<void>; finish(): void }
    | undefined;
  let pollStop: AbortController | undefined, poll: Promise<void> | undefined;
  let closingDestroyedPage: Lease | undefined;
  let paused = false,
    stopping = false,
    unknown = false,
    changing = false,
    noLeaseConfirmed = true;
  let stopPromise: Promise<{ confirmed: boolean }> | undefined;
  let releasedPage: BrowserReleasedPage | null = null,
    disposed = false;
  let lastPageState: { lease: Lease; navigation: number } | undefined;
  let transition: Promise<void> | undefined;
  let resolveEnd!: (value: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    resolveEnd = resolve;
  });
  const inflight = new Set<Promise<unknown>>();
  const ownedStop = new AbortController();
  type NativeCommand = {
    pending: number;
    possibleEffects: number;
    optionalWebMcp: boolean;
    failure?: BrowserTransportError;
  };
  let nativeCommand: NativeCommand | undefined;
  const readCdp = new Set([
    'Browser.getVersion',
    'Page.enable',
    'Page.getFrameTree',
    'Page.getLayoutMetrics',
    'Page.captureScreenshot',
    'Page.setLifecycleEventsEnabled',
    'Runtime.enable',
    'Runtime.getProperties',
    'Runtime.releaseObject',
    'Runtime.releaseObjectGroup',
    'Accessibility.enable',
    'Accessibility.getFullAXTree',
    'Accessibility.getPartialAXTree',
    'DOM.enable',
    'DOM.getDocument',
    'DOM.describeNode',
    'DOM.resolveNode',
    'DOM.getBoxModel',
    'DOM.getNodeForLocation',
    'DOM.querySelector',
    'DOM.querySelectorAll',
    'Network.enable',
  ]);
  async function nativeResult<T>(
    operation: () => Promise<T>,
    reading = false,
    optionalWebMcp = false,
  ): Promise<T> {
    if (nativeCommand) throw new BrowserTransportError('browser_native_busy', false);
    const current: NativeCommand = { pending: 0, possibleEffects: 0, optionalWebMcp };
    nativeCommand = current;
    let value: T | undefined,
      cause: unknown,
      rejected = false;
    try {
      try {
        value = await operation();
      } catch (error) {
        rejected = true;
        cause = error;
      }
      // The fixed daemon flattens CDP errors. Retain the paired Host's original
      // proof beside this one outstanding native command instead of parsing its
      // diagnostic string. Earlier possible page effects forbid a downgrade.
      if (current.failure) {
        if (current.pending === 0 && reading) throw current.failure;
        throw new BrowserTransportError(
          current.failure.message,
          current.pending !== 0 ||
            current.possibleEffects !== 0 ||
            !(current.failure instanceof DesktopBrowserRequestError) ||
            current.failure.kind === 'effect_unknown',
        );
      }
      if (rejected) throw cause;
      return value as T;
    } finally {
      if (nativeCommand === current) nativeCommand = undefined;
    }
  }
  function retain<T>(promise: Promise<T>): Promise<T> {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => {});
    return promise;
  }
  async function readOwnedPage(
    current: Lease,
    input: { op: 'pageState' } | { op: 'navigate'; url: string },
    signal: AbortSignal,
  ): Promise<OwnedPageState> {
    const available = () => lease === current && !paused && !stopping && !changing && !unknown;
    const requestSignal = AbortSignal.any([signal, ownedStop.signal]);
    if (!available()) throw new BrowserTransportError('browser_control_not_owned', false);
    requestSignal.throwIfAborted();
    const evidence = input.op === 'navigate' ? nativeCommand : undefined;
    if (evidence) evidence.possibleEffects++;
    let reply: unknown;
    try {
      reply = await retain(call({ ...input, leaseId: current.leaseId }, requestSignal));
    } catch (error) {
      // This owned navigation participates in the same sticky effect proof as
      // daemon CDP. Only its own exact paired no-dispatch receipt can retract it.
      if (
        evidence &&
        error instanceof DesktopBrowserRequestError &&
        error.kind === 'not_dispatched'
      )
        evidence.possibleEffects--;
      if (error instanceof BrowserTransportError) throw error;
      throw new BrowserTransportError('browser_native_connection_failed', true);
    }
    requestSignal.throwIfAborted();
    if (!available()) throw new BrowserTransportError('desktop_browser_read_stale', true);
    const minimum =
      lastPageState?.lease === current ? lastPageState.navigation : current.navigation;
    let state: OwnedPageState;
    try {
      state = ownedPageState(reply, current, minimum);
    } catch (error) {
      // A mismatched paired receipt is not a new page binding. Retain the
      // integrity fence while the original resources are drained.
      unknown = true;
      void close();
      throw error;
    }
    lastPageState = { lease: current, navigation: state.navigation };
    return state;
  }
  async function startNative() {
    if (stopping) throw Error('desktop_browser_closed');
    const current = lease!;
    const token = randomUUID() + randomUUID();
    pollStop = new AbortController();
    const signal = pollStop.signal;
    let cdpTail: Promise<unknown> = Promise.resolve(),
      queued = 0;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, instance) {
        const url = new URL(request.url),
          supplied = url.pathname.slice('/kite-native/'.length);
        if (
          stopping ||
          signal.aborted ||
          socket ||
          request.headers.has('origin') ||
          url.search ||
          !url.pathname.startsWith('/kite-native/') ||
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          return new Response('denied', { status: 403 });
        return instance.upgrade(request, { data: null })
          ? undefined
          : new Response('denied', { status: 400 });
      },
      websocket: {
        maxPayloadLength: 256 * 1024,
        open(ws) {
          socket = ws;
          let finish!: () => void;
          const closed = new Promise<void>((resolve) => {
            finish = resolve;
          });
          socketReceipt = { socket: ws, closed, finish };
        },
        async message(ws, value) {
          let id: unknown;
          try {
            const request = JSON.parse(String(value));
            id = request.id;
            if (
              !Number.isSafeInteger(id) ||
              typeof request.method !== 'string' ||
              current !== lease ||
              signal.aborted
            )
              throw Error('desktop_browser_binding_changed');
            if (++queued > 256) {
              queued--;
              throw Error('desktop_browser_queue_limit');
            }
            const evidence = nativeCommand;
            if (evidence) evidence.pending++;
            const operation = cdpTail.then(async () => {
              signal.throwIfAborted();
              if (evidence?.failure)
                throw new BrowserTransportError('browser_page_command_stopped', false);
              const effect = !readCdp.has(request.method);
              if (evidence && effect) evidence.possibleEffects++;
              try {
                return await call(
                  {
                    op: 'cdp',
                    leaseId: current.leaseId,
                    method: request.method,
                    params: request.params,
                    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
                  },
                  signal,
                );
              } catch (error) {
                if (evidence) {
                  if (error instanceof DesktopBrowserRequestError) {
                    if (effect && error.kind !== 'effect_unknown') evidence.possibleEffects--;
                    // Pinned browser.rs::enable_domains_direct ignores this optional
                    // probe even with webmcp:false. Keep Main's refusal on the CDP
                    // response; it is not a failed page operation. No other denial,
                    // dispatched failure, or ordinary command gets this exception.
                    if (
                      evidence.optionalWebMcp &&
                      request.method === 'WebMCP.enable' &&
                      request.sessionId === undefined &&
                      (request.params === undefined ||
                        (request.params !== null &&
                          typeof request.params === 'object' &&
                          !Array.isArray(request.params) &&
                          Object.keys(request.params).length === 0)) &&
                      error.kind === 'not_dispatched' &&
                      error.message === 'browser_page_method_denied'
                    )
                      throw error;
                  }
                  evidence.failure ??=
                    error instanceof BrowserTransportError
                      ? error
                      : new BrowserTransportError('desktop_browser_command_failed', true);
                }
                throw error;
              }
            });
            cdpTail = operation.catch(() => {});
            let result: unknown;
            try {
              result = await retain(operation);
            } finally {
              queued--;
              if (evidence) evidence.pending--;
            }
            if (ws.readyState === 1) ws.send(JSON.stringify({ id, result }));
          } catch (error) {
            if (ws.readyState === 1)
              ws.send(
                JSON.stringify({
                  id,
                  error: {
                    code: -32000,
                    message:
                      error instanceof DesktopBrowserRequestError
                        ? error.message
                        : 'desktop_browser_command_failed',
                  },
                }),
              );
          }
        },
        close(ws) {
          if (socket === ws) socket = undefined;
          if (socketReceipt?.socket === ws) socketReceipt.finish();
        },
      },
    });
    poll = (async () => {
      let after = 0;
      while (!signal.aborted) {
        if (!socket) {
          await Bun.sleep(50);
          continue;
        }
        const result = await call({ op: 'events', leaseId: current.leaseId, after }, signal);
        if (
          !Array.isArray(result.events) ||
          !Number.isSafeInteger(result.cursor) ||
          result.events.length > 128
        )
          throw Error('desktop_browser_events_invalid');
        for (const event of result.events) {
          if (event.sessionId !== undefined && event.sessionId !== '')
            throw Error('desktop_browser_events_invalid');
          if (socket?.readyState === 1)
            // The fixed provider represents its sole direct-page session as "".
            // Unlike outgoing commands, its lifecycle reader requires Some("").
            socket.send(
              JSON.stringify({ method: event.method, params: event.params, sessionId: '' }),
            );
        }
        after = result.cursor;
        await Bun.sleep(50);
      }
    })().catch((error: unknown) => {
      if (!signal.aborted) {
        if (
          error instanceof DesktopBrowserRequestError &&
          error.kind === 'not_dispatched' &&
          ['browser_page_closed', 'browser_page_lease_stale'].includes(error.message)
        )
          closingDestroyedPage = current;
        else unknown = true;
        void close();
      }
    });
    inner = createNativeBrowserTransport(
      {
        ...options,
        ...((await binding.manualDialogs?.()) ? { manualDialogs: true as const } : {}),
        attachment: {
          cdpUrl: `ws://127.0.0.1:${server.port}/kite-native/${token}`,
          async readPageState(signal) {
            const state = await readOwnedPage(current, { op: 'pageState' }, signal);
            return { url: state.url, title: state.title };
          },
        },
      },
      context,
    );
    const owned = inner;
    void owned.completion.then(() => {
      if (!changing && !stopping && inner === owned) void close();
    });
    await owned.ready;
    if (stopping) throw Error('desktop_browser_closed');
    const disabled = (await owned.request({ action: 'stream_disable' }, context.signal)) as any;
    if (disabled.success !== true) throw Error('desktop_browser_stream_disable_failed');
    if (stopping) throw Error('desktop_browser_closed');
    const status = (await owned.request({ action: 'stream_status' }, context.signal)) as any;
    if (status.success !== true || status.data?.enabled !== false)
      throw Error('desktop_browser_stream_disable_failed');
  }
  async function disconnect(pause: boolean) {
    releasedPage = null;
    let confirmed = true,
      destroyedConfirmed = false;
    let retained: BrowserReleasedPage | null = null;
    if (lease)
      try {
        await call({ op: 'revoke', leaseId: lease.leaseId });
      } catch {
        confirmed = false;
      }
    pollStop?.abort();
    const closingSocket = socketReceipt;
    socket?.close();
    if (server) {
      try {
        await server.stop(true);
        // stop() and close() requests do not themselves acknowledge the exact
        // connection's close callback. Drain it before releasing its page lease.
        await closingSocket?.closed;
      } catch {
        confirmed = false;
      }
      server = undefined;
    }
    await Promise.allSettled([poll, ...inflight]);
    if (inner) {
      try {
        const end = await inner.close();
        confirmed = end.confirmed && confirmed;
        if (end.confirmed) await inner.dispose();
      } catch {
        confirmed = false;
      }
      inner = undefined;
    }
    if (lease)
      try {
        const result = await call({
          op: 'release',
          leaseId: lease.leaseId,
          pause,
          channelRevoked: confirmed,
        });
        confirmed = result.confirmed === true && confirmed;
        destroyedConfirmed = confirmsDestroyedPage(result.closure, lease);
        if (confirmed && !pause && result.detached === true && result.closure === undefined)
          retained = retainedPage(result.retainedPage, lease);
      } catch {
        confirmed = false;
      }
    else confirmed = noLeaseConfirmed && confirmed;
    if (closingDestroyedPage && (closingDestroyedPage !== lease || !destroyedConfirmed))
      confirmed = false;
    if (!confirmed) unknown = true;
    if (confirmed && !unknown && !context.signal.aborted) releasedPage = retained;
    return { confirmed: confirmed && !unknown };
  }
  const ready = (async () => {
    context.signal.throwIfAborted();
    try {
      const storeId = await binding.storeId?.();
      if (!storeId) {
        noLeaseConfirmed = true;
        throw Error('desktop_browser_store_unbound');
      }
      const grant = await binding.grant?.();
      noLeaseConfirmed = false;
      lease = await call(
        {
          op: 'acquire',
          storeId,
          sessionId: context.sessionId,
          executionId: context.executionId,
          browserId: binding.browserId,
          ...grant,
        },
        context.signal,
      );
    } catch (error) {
      if (error instanceof DesktopBrowserRequestError && error.kind === 'not_dispatched')
        noLeaseConfirmed = true;
      throw error;
    }
    if (!completeLease(lease)) throw Error('desktop_browser_lease_invalid');
    context.signal.throwIfAborted();
    await startNative();
  })();
  void ready.catch(() => {});
  function close() {
    if (stopPromise) return stopPromise;
    stopping = true;
    changing = true;
    ownedStop.abort();
    const changingControl = transition;
    stopPromise = (async () => {
      await ready.catch(() => {});
      await changingControl?.catch(() => {});
      const result = await disconnect(false);
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      resolveEnd(result);
      return result;
    })();
    return stopPromise;
  }
  function change(operation: () => Promise<void>) {
    if (stopping || transition) return Promise.reject(Error('desktop_browser_control_busy'));
    changing = true;
    const running = (async () => {
      await ready;
      if (stopping) throw Error('desktop_browser_closed');
      await operation();
    })();
    transition = running;
    return running.finally(() => {
      if (transition === running) transition = undefined;
      changing = stopping;
    });
  }
  function assertOpen(signal: AbortSignal) {
    if (stopping) throw Error('desktop_browser_closed');
    context.signal.throwIfAborted();
    signal.throwIfAborted();
  }
  const abort = () => {
    void close();
  };
  context.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10 * 60 * 1000);
  if (context.signal.aborted) abort();
  return {
    sharedPage: true,
    sharedPageIdentity(): Readonly<BrowserSharedPageIdentity> | null {
      return completeLease(lease) ? { pageId: lease.pageId, incarnation: lease.incarnation } : null;
    },
    releasedSharedPage() {
      // disconnect captured this receipt before cancellation and after confirmed
      // release. A later Job signal cannot revoke that passive cleanup fact.
      return disposed && !unknown && releasedPage ? structuredClone(releasedPage) : null;
    },
    ready,
    completion,
    readProcessEvidence() {
      if (!inner?.readProcessEvidence) throw Error('desktop_browser_not_running');
      return inner.readProcessEvidence();
    },
    async request(command, signal) {
      signal.throwIfAborted();
      await ready;
      if (!inner || paused || stopping)
        throw new BrowserTransportError('browser_control_not_owned', false);
      if (command.action === 'url' || command.action === 'title') {
        if (Object.keys(command).length !== 1 || !Object.hasOwn(command, 'action'))
          throw new BrowserTransportError('desktop_browser_metadata_arguments_invalid', false);
        const current = lease!;
        return nativeResult(async () => {
          const state = await readOwnedPage(current, { op: 'pageState' }, signal);
          const data: Record<string, string> =
            command.action === 'url'
              ? { url: state.url, title: state.title }
              : { title: state.title };
          return { success: true, data };
        }, true);
      }
      if (command.action === 'navigate') {
        if (
          Object.keys(command).sort().join(',') !== 'action,url,waitUntil' ||
          typeof command.url !== 'string' ||
          command.waitUntil !== 'domcontentloaded'
        )
          throw new BrowserTransportError('desktop_browser_navigation_arguments_invalid', false);
        const current = lease!;
        const deadline = AbortSignal.timeout(options.requestTimeoutMs ?? 35000);
        const navigationSignal = AbortSignal.any([signal, context.signal, deadline]);
        return nativeResult(async () => {
          const state = await readOwnedPage(
            current,
            { op: 'navigate', url: command.url as string },
            navigationSignal,
          );
          return { success: true, data: { url: state.url, title: state.title } };
        });
      }
      const answer = await nativeResult(
        () => inner!.request(command, signal),
        ['snapshot', 'url', 'title', 'wait'].includes(String(command.action)),
        command.action === 'launch' &&
          command.headless === true &&
          command.engine === 'chrome' &&
          command.webmcp === false,
      );
      if (command.action === 'launch' && (answer as any)?.success === true)
        await call({ op: 'confirm', leaseId: lease!.leaseId }, signal);
      return answer;
    },
    async capture(signal) {
      signal.throwIfAborted();
      await ready;
      const current = lease,
        human = paused;
      const validRead = () => {
        signal.throwIfAborted();
        if (stopping || changing || unknown || lease !== current || paused !== human)
          throw Error('desktop_browser_read_stale');
      };
      validRead();
      if (paused) {
        const captured = await call({ op: 'capture', leaseId: lease!.leaseId }, signal);
        validRead();
        return captured;
      }
      if (!inner) throw Error('desktop_browser_not_running');
      const captured = await nativeResult(() => inner!.capture(signal), true);
      validRead();
      const proof = await call({ op: 'captureMeta', leaseId: lease!.leaseId }, signal),
        metadata = proof.metadata;
      validRead();
      if (
        !metadata ||
        metadata.navigation !== proof.navigation ||
        metadata.sha256 !==
          createHash('sha256').update(Buffer.from(captured.frame.data, 'base64')).digest('hex') ||
        !Number.isFinite(metadata.width) ||
        !Number.isFinite(metadata.height) ||
        metadata.width <= 0 ||
        metadata.height <= 0
      )
        throw Error('desktop_browser_capture_identity_changed');
      const sx = captured.frame.width / metadata.width,
        sy = captured.frame.height / metadata.height;
      return {
        ...captured,
        annotations: captured.annotations.map((item) => ({
          ...item,
          box: {
            x: item.box.x * sx,
            y: item.box.y * sy,
            width: item.box.width * sx,
            height: item.box.height * sy,
          },
        })),
      };
    },
    async capturePng(signal) {
      await ready;
      const current = lease;
      if (!inner?.capturePng || paused || stopping || changing || unknown)
        throw Error('desktop_browser_control_not_owned');
      const captured = await nativeResult(() => inner!.capturePng!(signal), true);
      const proof = await call({ op: 'captureMeta', leaseId: current!.leaseId }, signal);
      signal.throwIfAborted();
      if (
        lease !== current ||
        paused ||
        stopping ||
        changing ||
        unknown ||
        proof.metadata?.navigation !== proof.navigation ||
        proof.metadata?.sha256 !==
          createHash('sha256').update(Buffer.from(captured.data, 'base64')).digest('hex')
      )
        throw Error('desktop_browser_read_stale');
      return {
        ...captured,
        imageRef: proof.metadata.captureId,
        viewport: { width: proof.metadata.width, height: proof.metadata.height },
        navigation: proof.navigation,
      };
    },
    async pointer(input, signal) {
      await ready;
      assertOpen(signal);
      if (paused || changing || unknown || !lease)
        throw new BrowserTransportError('browser_control_not_owned', false);
      await call(
        {
          op: 'pointer',
          leaseId: lease.leaseId,
          captureId: input.imageRef,
          kind: input.kind,
          from: input.from,
          ...(input.to ? { to: input.to } : {}),
        },
        signal,
      );
      assertOpen(signal);
    },
    async dialogs(signal) {
      await ready;
      assertOpen(signal);
      if (paused || changing || unknown || !lease)
        throw new BrowserTransportError('browser_control_not_owned', false);
      const result = await call({ op: 'dialogs', leaseId: lease.leaseId }, signal);
      assertOpen(signal);
      return result.dialogs;
    },
    async dialog(input, signal) {
      await ready;
      assertOpen(signal);
      if (paused || changing || unknown || !lease)
        throw new BrowserTransportError('browser_control_not_owned', false);
      await call({ op: 'dialog', leaseId: lease.leaseId, ...input }, signal);
      assertOpen(signal);
    },
    handoff(signal) {
      return change(async () => {
        assertOpen(signal);
        const end = await disconnect(true);
        if (!end.confirmed) throw Error('desktop_browser_handoff_unknown');
        paused = true;
      });
    },
    resume(signal) {
      return change(async () => {
        assertOpen(signal);
        if (!paused || unknown) throw Error('desktop_browser_resume_denied');
        // Keep a late, known new lease for close() to revoke; never discard it merely because stop won.
        lease = await call({ op: 'resume', leaseId: lease!.leaseId }, signal);
        if (!completeLease(lease)) throw Error('desktop_browser_lease_invalid');
        assertOpen(signal);
        await startNative();
        assertOpen(signal);
        const reply = (await inner!.request(
          { action: 'launch', headless: true, engine: 'chrome', webmcp: false },
          signal,
        )) as any;
        assertOpen(signal);
        if (reply.success !== true) throw Error('desktop_browser_resume_failed');
        await call({ op: 'confirm', leaseId: lease!.leaseId }, signal);
        assertOpen(signal);
        paused = false;
      });
    },
    close,
    async dispose() {
      const end = await close();
      if (!end.confirmed) throw Error('desktop_browser_cleanup_unknown');
      disposed = true;
    },
  };
}
