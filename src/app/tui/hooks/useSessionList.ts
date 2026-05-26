import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionInfo } from "@/core/persistence/sessions.js";
import { listSessions } from "@/core/persistence/sessions.js";
import { defaultCheckpointPath } from "@/core/config/paths.js";

interface UseSessionListResult {
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
  /** 重新加载会话列表（/new 等操作后调用） */
  refresh: () => void;
}

export function useSessionList(): UseSessionListResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    if (mountedRef.current) setRefreshKey(n => n + 1);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await listSessions(defaultCheckpointPath());
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

  return { sessions, loading, error, refresh };
}

export type { SessionInfo };
