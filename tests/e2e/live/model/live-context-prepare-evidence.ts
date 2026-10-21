import type { openSqliteStore } from '@kite-ai/agent/sqlite';

type Store = Awaited<ReturnType<typeof openSqliteStore>>;
type Page = Awaited<ReturnType<Store['getModelContext']>>;
/** Observe the real normal-history page chain before Model planning; never edit a query/result. */
export function observeContextPreparation(original: Store) {
  const reading = new Map<
    string,
    { selectionId: string; highWaterSeq: string; sources: Page['resultSources'] }
  >();
  const prepared = new Map<
    string,
    {
      sessionId: string;
      runId: string | null;
      selectionId: string;
      highWaterSeq: string;
      sources: Page['resultSources'];
    }
  >();
  const store = new Proxy(original, {
    get(target, key) {
      if (key === 'getModelContext')
        return async (input: Parameters<Store['getModelContext']>[0]) => {
          const result = await target.getModelContext(input);
          // This exact page shape is Runtime.modelMessages, not independent inspection,
          // summary coverage validation, or current-state observations after dispatch.
          if (
            input.messageLimit === 200 &&
            input.sourceLimit === 100 &&
            input.byteLimit === 8 * 1024 * 1024
          ) {
            if (input.afterSeq === '0' && input.afterSourceId === '')
              reading.set(input.sessionId, {
                selectionId: result.selection.id,
                highWaterSeq: result.highWaterSeq,
                sources: [],
              });
            const chain = reading.get(input.sessionId);
            if (
              !chain ||
              chain.selectionId !== result.selection.id ||
              chain.highWaterSeq !== result.highWaterSeq
            )
              throw Error('context_prepare_observation_page_chain_mismatch');
            for (const source of result.resultSources) {
              if (chain.sources.some((prior) => prior.id === source.id))
                throw Error('context_prepare_duplicate_source_page');
              chain.sources.push(structuredClone(source));
            }
          }
          return result;
        };
      if (key === 'planExecution')
        return async (input: Parameters<Store['planExecution']>[0]) => {
          if (input.kind === 'model') {
            const chain = reading.get(input.sessionId);
            if (!chain) throw Error('context_prepare_observation_missing_real_history_read');
            reading.delete(input.sessionId);
            prepared.set(input.executionId, {
              sessionId: input.sessionId,
              runId: input.runId,
              ...structuredClone(chain),
            });
          }
          return target.planExecution(input);
        };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store, prepared };
}
