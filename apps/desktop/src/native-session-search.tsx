import {
  SESSION_SEARCH_PAGE_SIZE,
  type SessionSearchProps,
  searchSessions,
  sessionSearchDirectoryComplete,
} from '@kite-ai/ui/desktop/session-search';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeSessionSearchBridge } from './native-session-search-bridge';

export function UnavailableNativeSessionSearch({
  onClose,
  onUnavailable,
}: Pick<SessionSearchProps, 'onClose'> & { onUnavailable(): void }) {
  useLayoutEffect(() => {
    onClose();
    onUnavailable();
  }, [onClose, onUnavailable]);
  return null;
}

export function NativeSessionSearch({
  bridge,
  onUnavailable,
  ...props
}: SessionSearchProps & { bridge: NativeSessionSearchBridge; onUnavailable(): void }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const opening = useRef(true);
  const [target, setTarget] = useState({ query: '', page: 0 });
  const complete = sessionSearchDirectoryComplete(props.available, props.workspaces);
  const { matches, resultId } = useMemo(
    () => ({
      matches: complete ? searchSessions(props.workspaces, target.query) : [],
      resultId: crypto.randomUUID(),
    }),
    [complete, props.workspaces, target.query],
  );
  const current = useRef({ ...props, onUnavailable, resultId });
  const resultPage = Math.min(
    target.page,
    Math.max(0, Math.ceil(matches.length / SESSION_SEARCH_PAGE_SIZE) - 1),
  );
  const start = resultPage * SESSION_SEARCH_PAGE_SIZE;
  const rows = useMemo(
    () =>
      matches.slice(start, start + SESSION_SEARCH_PAGE_SIZE).map((row) => ({
        ...row,
        session: {
          sessionId: row.session.sessionId,
          displayName: row.session.displayName,
          status: row.session.status,
          pendingInteractions: row.session.pendingInteractions,
        },
      })),
    [matches, start],
  );
  useLayoutEffect(() => {
    current.current = { ...props, onUnavailable, resultId };
  });
  useLayoutEffect(() => {
    const unwatch = bridge.watchActions((action) => {
      if (action.requestId !== requestId) return;
      if (action.type === 'query') {
        setTarget({ query: action.query, page: action.page });
        return;
      }
      current.current.onClose();
      if (action.type === 'select') {
        const { available, workspaces, onOpen, resultId } = current.current;
        if (
          onOpen &&
          action.resultId === resultId &&
          sessionSearchDirectoryComplete(available, workspaces) &&
          workspaces.some((ws) => ws.sessions.some((row) => row.sessionId === action.sessionId))
        ) {
          onOpen(action.sessionId);
          return;
        }
      }
      current.current.restoreFocus();
      if (action.type === 'unavailable') current.current.onUnavailable();
    });
    return () => {
      unwatch();
      bridge.close(requestId);
      opening.current = true;
    };
  }, [bridge, requestId]);
  useLayoutEffect(() => {
    try {
      bridge.present(
        {
          requestId,
          resultId,
          available: complete,
          ...target,
          total: matches.length,
          resultPage,
          rows,
        },
        opening.current,
      );
      opening.current = false;
    } catch {
      current.current.onClose();
      current.current.restoreFocus();
      current.current.onUnavailable();
    }
  }, [bridge, requestId, resultId, complete, target, matches.length, resultPage, rows]);
  return null;
}
