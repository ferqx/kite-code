import { useStdout } from 'ink';
import { useMemo, useSyncExternalStore } from 'react';

interface WindowSource {
  readonly columns?: number;
  readonly rows?: number;
  on(event: 'resize', listener: () => void): unknown;
  removeListener(event: 'resize', listener: () => void): unknown;
}
export interface InkWindowStore {
  subscribe(changed: () => void): () => void;
  getSnapshot(): string;
}
const stores = new WeakMap<WindowSource, InkWindowStore>();
/** The first view subscribes; the last view removes the one owned stdout listener. */
export function inkWindowStore(source: WindowSource): InkWindowStore {
  const existing = stores.get(source);
  if (existing) return existing;
  const readers = new Set<() => void>();
  const getSnapshot = () => `${source.columns || 80}:${source.rows || 24}`;
  let notified = getSnapshot();
  const resize = () => {
    const next = getSnapshot();
    if (next === notified) return;
    notified = next;
    // Copy so a subscriber can synchronously release another view while notified.
    for (const changed of [...readers]) if (readers.has(changed)) changed();
  };
  const store: InkWindowStore = {
    getSnapshot,
    subscribe(changed) {
      // Each subscription has its own ownership even if its callback is shared.
      const owned = () => changed();
      if (readers.size === 0) {
        notified = getSnapshot();
        source.on('resize', resize);
      }
      readers.add(owned);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        readers.delete(owned);
        if (readers.size === 0) source.removeListener('resize', resize);
      };
    },
  };
  stores.set(source, store);
  return store;
}
export function useInkWindowSize() {
  const { stdout } = useStdout();
  const store = useMemo(() => inkWindowStore(stdout), [stdout]);
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo(() => {
    const [columns = 80, rows = 24] = value.split(':').map(Number);
    return { columns, rows };
  }, [value]);
}
