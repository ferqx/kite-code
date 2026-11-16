import { useErrorFeedback } from '@kite-ai/ui/desktop';
import { useEffect, useRef } from 'react';

/** A local failure episode, never a receipt store or permission to retry a mutation. */
export function useNativeSettingsFeedback(scope: string, onError?: (message: string) => void) {
  const handler = useErrorFeedback(onError);
  const current = useRef({ scope, active: true });
  current.current.scope = scope;
  const episodes = useRef({ scope, keys: new Set<string>() });
  if (episodes.current.scope !== scope) episodes.current = { scope, keys: new Set() };
  useEffect(() => {
    current.current.active = true;
    return () => {
      current.current.active = false;
    };
  }, []);
  return {
    handled: !!handler,
    report(key: string, message: string) {
      if (!current.current.active || current.current.scope !== scope || !message || !handler)
        return;
      if (episodes.current.keys.has(key)) return;
      episodes.current.keys.add(key);
      handler(message);
    },
    reset(key: string) {
      if (current.current.scope === scope) episodes.current.keys.delete(key);
    },
  };
}
