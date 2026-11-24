import {
  SESSION_SEARCH_PAGE_SIZE,
  type SearchRow,
  SessionSearchPalette,
} from '@kite-ai/ui/desktop/session-search';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installNativeInputModality } from './native-input-modality';
import type {
  NativeSessionSearchOverlayBridge,
  NativeSessionSearchState,
} from './native-session-search-bridge';
import './native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';
import './native-global-dialog.css';

function CurrentSearch({
  bridge,
  state,
}: {
  bridge: NativeSessionSearchOverlayBridge;
  state: NativeSessionSearchState;
}) {
  const [target, setTarget] = useState<{
    query: string;
    page: number;
    previousResponse?: NativeSessionSearchState;
  }>({ query: state.query, page: state.page });
  const requested = useRef(target);
  const [loaded, setLoaded] = useState<{
    query: string;
    resultId: string;
    available: boolean;
    rows: readonly SearchRow[];
  }>(() => ({
    query: state.query,
    resultId: state.resultId,
    available: state.available,
    rows: state.rows,
  }));
  const finished = useRef(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = state.theme;
  }, [state.theme]);
  const request = useCallback(
    (query: string, page: number) => {
      if (
        finished.current ||
        (query === requested.current.query && page === requested.current.page)
      )
        return;
      const next = { query, page, previousResponse: state };
      requested.current = next;
      setTarget(next);
      bridge.request({ type: 'query', requestId: state.requestId, query, page });
    },
    [bridge, state],
  );
  const matching =
    state !== target.previousResponse && state.query === target.query && state.page === target.page;
  useLayoutEffect(() => {
    if (!matching || finished.current) return;
    if (loaded.resultId !== state.resultId && state.resultPage !== 0) {
      request(state.query, 0);
      return;
    }
    setLoaded((previous) => ({
      query: state.query,
      resultId: state.resultId,
      available: state.available,
      rows: [...previous.rows.slice(0, state.resultPage * SESSION_SEARCH_PAGE_SIZE), ...state.rows],
    }));
  }, [loaded.resultId, matching, request, state]);
  const sameResults = loaded.resultId === state.resultId && state.query === target.query;
  const complete = state.available && loaded.available;
  const rows = complete ? loaded.rows : [];
  const pending = !matching || !sameResults;
  return (
    <SessionSearchPalette
      id="native-session-search"
      query={target.query}
      resultsQuery={loaded.query}
      setQuery={(query) => request(query, 0)}
      complete={complete}
      results={rows}
      pending={pending}
      onMore={
        rows.length < state.total ? () => request(target.query, state.resultPage + 1) : undefined
      }
      onOpen={(sessionId) => {
        if (finished.current || pending) return;
        const index = rows.findIndex((row) => row.session.sessionId === sessionId);
        if (index < 0) return;
        finished.current = true;
        bridge.request({
          type: 'select',
          requestId: state.requestId,
          resultId: state.resultId,
          sessionId,
          query: state.query,
          page: Math.floor(index / SESSION_SEARCH_PAGE_SIZE),
        });
      }}
      onClose={() => {
        if (finished.current) return;
        finished.current = true;
        bridge.request({ type: 'close', requestId: state.requestId });
      }}
      restoreFocus={() => {}}
    />
  );
}

function NativeSearch({ bridge }: { bridge: NativeSessionSearchOverlayBridge }) {
  const [state, setState] = useState<NativeSessionSearchState | null>(null);
  useLayoutEffect(() => {
    const unwatch = bridge.watch(setState);
    bridge.ready();
    return unwatch;
  }, [bridge]);
  return state ? <CurrentSearch key={state.requestId} bridge={bridge} state={state} /> : null;
}

const bridge = window.kiteSessionSearchOverlay;
installNativeInputModality(document);
if (bridge) createRoot(document.getElementById('root')!).render(<NativeSearch bridge={bridge} />);
