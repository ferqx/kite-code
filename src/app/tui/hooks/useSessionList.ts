import { useState, useEffect } from "react";
import type { SessionInfo } from "@/core/persistence/sessions.js";
import { listSessions } from "@/core/persistence/sessions.js";
import { defaultCheckpointPath } from "@/core/config/paths.js";

interface UseSessionListResult {
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
}

export function useSessionList(): UseSessionListResult {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await listSessions(defaultCheckpointPath());
        if (!cancelled) {
          setSessions(result);
          setLoading(false);
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
  }, []);

  return { sessions, loading, error };
}

export type { SessionInfo };
