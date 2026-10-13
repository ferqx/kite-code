import { type BrowserView, ClientError } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { useEffect, useRef, useState } from 'react';
import type { WebSnapshot } from './controller';

type RunFact = BrowserView['runs'][number];
const settled = (run: RunFact) =>
  !run.isActive && ['completed', 'failed', 'cancelled'].includes(run.status);

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
        message.sessionId === snapshot.sessionId && !message.originMessage && message.runId
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
    const pending = [...ids].filter((id) => {
      const previous = current.runs.get(id);
      return !observed.has(id) && (!previous || !settled(previous));
    });
    const read = new AbortController();
    void (async () => {
      for (const id of pending) {
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
        publish();
      }
    })().catch((error) => {
      if (!read.signal.aborted)
        publish(error instanceof ClientError ? error.code : 'browser_read_unavailable');
    });
    return () => read.abort();
  }, [client, snapshot, scope, available]);
  const runs = new Map<string, RunFact>();
  if (available && snapshot) {
    if (state.scope === scope && state.client === client)
      for (const run of state.runs) runs.set(run.id, run);
    for (const run of snapshot.view.runs) runs.set(run.id, run);
  }
  return {
    runs: [...runs.values()],
    error: available && state.scope === scope && state.client === client ? state.error : undefined,
  };
}
