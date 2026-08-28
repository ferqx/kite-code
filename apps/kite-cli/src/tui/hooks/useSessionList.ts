import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '#kite-cli/session-types';

interface UseSessionListResult {
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
  /** 重新加载会话列表（/new 等操作后调用） */
  refresh: () => void;
  /** 按关键词搜索会话 */
  search: (query: string) => void;
  /** 当前搜索关键词 */
  searchQuery: string;
}

export function useSessionList(
  loadSessions: (query: string) => Promise<SessionInfo[]>,
): UseSessionListResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_refreshKey, setRefreshKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const mountedRef = useRef(true);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (mountedRef.current) {
      setSearchQuery('');
      setRefreshKey((n) => n + 1);
    }
  }, []);

  const search = useCallback((query: string) => {
    setSearchQuery(query);
    // Debounce 300ms
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setRefreshKey((n) => n + 1);
    }, 300);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: search() deliberately debounces loads through _refreshKey.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const result = await loadSessions(searchQuery.trim());
        if (!cancelled) {
          setSessions(result);
          setLoading(false);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError('无法加载历史会话，请稍后重试。');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [_refreshKey, loadSessions]);

  return { sessions, loading, error, refresh, search, searchQuery };
}

export type { SessionInfo };
