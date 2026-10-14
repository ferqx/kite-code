import { useStdout } from 'ink';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** One mounted view owns its resize subscription; no permanent global listener. */
export function useInkWindowSize() {
  const { stdout } = useStdout();
  const subscribe = useCallback(
    (changed: () => void) => {
      stdout.on('resize', changed);
      return () => {
        stdout.removeListener('resize', changed);
      };
    },
    [stdout],
  );
  const read = useCallback(() => `${stdout.columns || 80}:${stdout.rows || 24}`, [stdout]);
  const value = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => {
    const [columns = 80, rows = 24] = value.split(':').map(Number);
    return { columns, rows };
  }, [value]);
}
