import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOwnedWorker, ownedWorkerAssets } from '../platform/process/owned-worker';
import { McpAdapterError } from './errors';

type SchemaPair = { input: object; output?: object };
type Pending = { resolve(valid: boolean): void; reject(error: unknown): void };
type Startup = {
  promise: Promise<State>;
  sealed?: unknown;
  deadline: number;
  state?: State;
};
type State = {
  owned: ReturnType<typeof createOwnedWorker>;
  pending: Map<number, Pending>;
  ready?: Promise<void>;
  termination?: Promise<void>;
  idle?: ReturnType<typeof setTimeout>;
};
/** Exact executed assets; source hosts select built JS, never a schema-compiler TS fallback. */
export function mcpSchemaWorkerAssets() {
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? '../../dist/mcp/schema-worker.js' : './schema-worker.js',
      import.meta.url,
    ),
  );
  const observer = ownedWorkerAssets();
  return Object.freeze({
    worker,
    checksum: worker.replace(/\.js$/, '.sha256'),
    preload: fileURLToPath(observer.preload),
    observerModules: Object.freeze(observer.modules.map((url) => fileURLToPath(url))),
  });
}

/** One scope/catalogue's pure compiler. Retirement rejects every queued request before joining its original Worker. */
export function createMcpSchemaValidation(schemas: readonly SchemaPair[], timeout: number) {
  let current: State | undefined;
  let starting: Startup | undefined;
  let closed = false;
  let serial = 0;
  const retired = new Set<Promise<void>>();
  function retire(state: State, error: unknown) {
    if (state.termination) return state.termination;
    if (current === state) current = undefined;
    clearTimeout(state.idle);
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
    const termination = Promise.resolve().then(() => state.owned.terminate());
    state.termination = termination;
    retired.add(termination);
    void termination.then(
      () => retired.delete(termination),
      () => {},
    );
    return termination;
  }
  async function settleRetired() {
    const results = await Promise.allSettled([...retired]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'MCP schema Worker cleanup failed.');
  }
  async function send(
    state: State,
    payload: object,
    signal?: AbortSignal,
    deadline = performance.now() + timeout,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    if (state.termination || closed) throw new McpAdapterError('mcp_catalogue_stale');
    clearTimeout(state.idle);
    const id = ++serial;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      void retire(state, new McpAdapterError('mcp_catalogue_stale')).catch(() => {});
    };
    try {
      return await new Promise<boolean>((resolve, reject) => {
        state.pending.set(id, { resolve, reject });
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(
          () => {
            void retire(state, new McpAdapterError('mcp_admission_rejected')).catch(() => {});
          },
          Math.max(0, deadline - performance.now()),
        );
        if (signal?.aborted) abort();
        else if (performance.now() >= deadline)
          void retire(state, new McpAdapterError('mcp_admission_rejected')).catch(() => {});
        else state.owned.worker.postMessage({ ...payload, id });
      });
    } catch (error) {
      if (state.termination) await state.termination;
      if (signal?.aborted) throw new McpAdapterError('mcp_cancelled_before_call');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      state.pending.delete(id);
      if (!state.termination && !state.pending.size) {
        // Pure cache only: idle retirement does not cancel business work or revoke its catalogue.
        state.idle = setTimeout(() => {
          void retire(state, new McpAdapterError('mcp_catalogue_stale')).catch(() => {});
        }, 1000);
        state.idle.unref();
      }
    }
  }
  async function start(startup: Startup): Promise<State> {
    if (closed) throw new McpAdapterError('mcp_catalogue_stale');
    await settleRetired();
    if (performance.now() >= startup.deadline)
      startup.sealed ??= new McpAdapterError('mcp_admission_rejected');
    if (startup.sealed) throw startup.sealed;
    const assets = mcpSchemaWorkerAssets();
    // A failed/cancelled admission still owns both actual reads until each settles.
    const reads = await Promise.allSettled([
      readFile(assets.worker),
      readFile(assets.checksum, 'utf8'),
    ]);
    if (performance.now() >= startup.deadline)
      startup.sealed ??= new McpAdapterError('mcp_admission_rejected');
    if (startup.sealed) throw startup.sealed;
    if (closed) throw new McpAdapterError('mcp_catalogue_stale');
    const [body, checksum] = reads;
    if (body.status === 'rejected') throw body.reason;
    if (checksum.status === 'rejected') throw checksum.reason;
    const bytes = body.value;
    const expected = checksum.value;
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
    if (performance.now() >= startup.deadline)
      startup.sealed ??= new McpAdapterError('mcp_admission_rejected');
    if (startup.sealed) throw startup.sealed;
    if (!/^[a-f0-9]{64}$/.test(expected.trim()) || hash !== expected.trim())
      throw new McpAdapterError('mcp_admission_rejected');
    if (closed) throw new McpAdapterError('mcp_catalogue_stale');
    const state: State = { owned: createOwnedWorker(assets.worker), pending: new Map() };
    current = state;
    startup.state = state;
    state.owned.worker.onmessage = (
      event: MessageEvent<{ id: number; valid?: boolean; error?: string }>,
    ) => {
      const pending = state.pending.get(event.data?.id);
      if (!pending) return;
      if (event.data.error) pending.reject(new McpAdapterError('mcp_arguments_invalid'));
      else if (typeof event.data.valid === 'boolean') pending.resolve(event.data.valid);
      else void retire(state, new McpAdapterError('mcp_admission_rejected')).catch(() => {});
    };
    state.owned.worker.onerror = () => {
      void retire(state, new McpAdapterError('mcp_admission_rejected')).catch(() => {});
    };
    state.owned.worker.addEventListener('close', () => {
      if (!state.termination)
        void retire(state, new McpAdapterError('mcp_admission_rejected')).catch(() => {});
    });
    return state;
  }
  async function ready(signal: AbortSignal | undefined, deadline: number) {
    signal?.throwIfAborted();
    if (closed) throw new McpAdapterError('mcp_catalogue_stale');
    let state = current;
    let startup: Startup | undefined;
    let stopped: unknown;
    const stop = (reason: McpAdapterError) => {
      stopped ??= reason;
      const shared =
        reason.code === 'mcp_cancelled_before_call'
          ? new McpAdapterError('mcp_catalogue_stale')
          : reason;
      if (startup) startup.sealed ??= shared;
      const owned = state ?? startup?.state;
      if (owned) void retire(owned, shared).catch(() => {});
    };
    const abort = () => stop(new McpAdapterError('mcp_cancelled_before_call'));
    // Install deadline/signal before asset IO or joining another caller's startup.
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => stop(new McpAdapterError('mcp_admission_rejected')),
      Math.max(0, deadline - performance.now()),
    );
    try {
      if (!state) {
        if (!starting) {
          const pending: Startup = { promise: undefined!, deadline };
          starting = pending;
          pending.promise = start(pending).finally(() => {
            if (starting === pending) starting = undefined;
          });
        }
        startup = starting;
        startup.deadline = Math.min(startup.deadline, deadline);
        if (signal?.aborted) abort();
        state = await startup.promise;
      }
      if (signal?.aborted) abort();
      if (stopped) throw stopped;
      if (performance.now() >= deadline) {
        stop(new McpAdapterError('mcp_admission_rejected'));
        throw stopped;
      }
      state.ready ??= send(state, { kind: 'compile', schemas }, undefined, deadline).then(() => {});
      await state.ready;
      if (state.termination) await state.termination;
      if (stopped) throw stopped;
      signal?.throwIfAborted();
      return state;
    } catch (error) {
      // No early rejection: original asset IO/hash and any created Worker must converge first.
      await startup?.promise.catch(() => {});
      if (state?.termination) await state.termination;
      else if (startup?.state?.termination) await startup.state.termination;
      await settleRetired();
      if (stopped) throw stopped;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async prepare(signal?: AbortSignal) {
      await ready(signal, performance.now() + timeout);
    },
    async validate(kind: 'input' | 'output', index: number, value: unknown, signal: AbortSignal) {
      const deadline = performance.now() + timeout;
      const state = await ready(signal, deadline);
      return send(state, { kind, index, value }, signal, deadline);
    },
    close() {
      closed = true;
      if (starting) starting.sealed ??= new McpAdapterError('mcp_catalogue_stale');
      if (current) void retire(current, new McpAdapterError('mcp_catalogue_stale')).catch(() => {});
      return (async () => {
        await starting?.promise.catch(() => {});
        if (current) await retire(current, new McpAdapterError('mcp_catalogue_stale'));
        await settleRetired();
      })();
    },
  };
}
