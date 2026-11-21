import { SESSION_SEARCH_PAGE_SIZE, SessionSearchPalette } from '@kite-ai/ui/desktop/session-search';
import { useLayoutEffect, useRef, useState } from 'react';
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
  const [target, setTarget] = useState({
    query: state.query,
    page: state.page,
    landAtLast: false,
  });
  const finished = useRef(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = state.theme;
  }, [state.theme]);
  const request = (query: string, page: number, landAtLast = false) => {
    if (finished.current || (query === target.query && page === target.page)) return;
    setTarget({ query, page, landAtLast });
    bridge.request({ type: 'query', requestId: state.requestId, query, page });
  };
  const matching = state.query === target.query && state.page === target.page;
  const pending = !matching;
  return (
    <SessionSearchPalette
      id="native-session-search"
      query={target.query}
      setQuery={(query) => request(query, 0)}
      complete={state.available}
      results={state.rows}
      total={state.total}
      page={state.resultPage}
      pending={pending}
      visibleCount={SESSION_SEARCH_PAGE_SIZE}
      landAtLast={target.landAtLast}
      onMore={(page, landAtLast) => request(target.query, page, landAtLast)}
      onOpen={(sessionId) => {
        if (finished.current || !matching) return;
        finished.current = true;
        bridge.request({
          type: 'select',
          requestId: state.requestId,
          sessionId,
          query: state.query,
          page: state.page,
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
