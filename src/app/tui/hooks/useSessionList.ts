import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionInfo } from "@/core/persistence/sessions.js";
import { listSessions, searchSessions } from "@/core/persistence/sessions.js";
import { defaultCheckpointPath } from "@/core/config/paths.js";

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

export function useSessionList(): UseSessionListResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const mountedRef = useRef(true);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (mountedRef.current) {
      setSearchQuery("");
      setRefreshKey(n => n + 1);
    }
  }, []);

  const search = useCallback((query: string) => {
    setSearchQuery(query);
    // Debounce 300ms
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setRefreshKey(n => n + 1);
    }, 300);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const checkpointPath = defaultCheckpointPath();
        const result = searchQuery.trim()
          ? await searchSessions(checkpointPath, searchQuery)
          : await listSessions(checkpointPath);
        if (!cancelled) {
          setSessions(result);
          setLoading(false);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load sessions");
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  return { sessions, loading, error, refresh, search, searchQuery };
}

export type { SessionInfo };
