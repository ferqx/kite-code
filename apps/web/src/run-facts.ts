import { type BrowserView, ClientError } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WebSnapshot } from './controller';

type RunFact = BrowserView['runs'][number];
const settled = (run: RunFact) =>
  !run.isActive && ['completed', 'failed', 'cancelled'].includes(run.status);
const concurrentReads = 4;
const runsPerUpdate = 32;

/** Exact historical metadata only; View remains the authority for its current entries. */
export function useRunFacts(
  client: BrowserClient,
  snapshot: WebSnapshot | undefined,
  available: boolean,
) {
  const scope = JSON.stringify([snapshot?.view.storeId, snapshot?.sessionId, snapshot?.generation]);
  const cache = useRef({ scope, client, runs: new Map<string, RunFact>() });
  const [state, setState] = useState<{
    scope: string;
    client: BrowserClient;
    runs: RunFact[];
    error?: string;
  }>({ scope, client, runs: [] });
  useEffect(() => {
    if (cache.current.scope !== scope || cache.current.client !== client)
      cache.current = { scope, client, runs: new Map() };
    if (!available || !snapshot) return;
    const current = cache.current;
    const ids = new Set(
      snapshot.messages.flatMap((message) =>
        message.sessionId === snapshot.sessionId &&
        !message.originMessage &&
        message.runId &&
        (message.role === 'assistant' || (message.outputBody && !message.outputBody.complete))
          ? [message.runId]
          : [],
      ),
    );
    for (const id of current.runs.keys()) if (!ids.has(id)) current.runs.delete(id);
    const observed = new Map(snapshot.view.runs.map((run) => [run.id, run]));
    for (const [id, run] of observed) current.runs.set(id, run);
    const publish = (error?: string) =>
      setState({ scope, client, runs: [...current.runs.values()], error });
    publish();
    if (!client.serverInfo?.capabilities.includes('runs')) return;
    const pending = new Set(
      [...ids].filter((id) => {
        const previous = current.runs.get(id);
        return !observed.has(id) && (!previous || !settled(previous));
      }),
    );
    const read = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const load = async () => {
      try {
        const remaining = [...pending];
        for (let offset = 0; offset < remaining.length; offset += concurrentReads) {
          const batch = remaining.slice(offset, offset + concurrentReads);
          const results = await Promise.allSettled(
            batch.map(async (id) => {
              const facts = await client.getRun(snapshot.sessionId, id, { signal: read.signal });
              if (read.signal.aborted) return;
              if (
                facts.storeId !== snapshot.view.storeId ||
                facts.run.id !== id ||
                facts.run.sessionId !== snapshot.sessionId ||
                !facts.run.originStoreId
              )
                throw new ClientError('browser_identity_mismatch');
              current.runs.set(id, facts.run);
              pending.delete(id);
            }),
          );
          if (read.signal.aborted) return;
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
          if (!pending.size || (offset + batch.length) % runsPerUpdate === 0) publish();
        }
      } catch (error) {
        if (read.signal.aborted) return;
        publish(error instanceof ClientError ? error.code : 'browser_read_unavailable');
        timer = setTimeout(() => void load(), Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)));
      }
    };
    void load();
    return () => {
      read.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, snapshot, scope, available]);
  const runs = useMemo(() => {
    const merged = new Map<string, RunFact>();
    if (available && snapshot) {
      if (state.scope === scope && state.client === client)
        for (const run of state.runs) merged.set(run.id, run);
      for (const run of snapshot.view.runs) merged.set(run.id, run);
    }
    return [...merged.values()];
  }, [available, snapshot, state, scope, client]);
  return {
    runs,
    error: available && state.scope === scope && state.client === client ? state.error : undefined,
  };
}
