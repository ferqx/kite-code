import { useLayoutEffect, useState } from 'react';

type NativePageRoute =
  | { kind: 'conversation'; id: string }
  | { kind: 'new'; id: string }
  | { kind: 'scheduled'; id?: undefined };

type Entry = { route: NativePageRoute; intent: number };
type PageHistory = { storeId?: string; entries: Entry[]; index: number };

function sameRoute(left: NativePageRoute, right: NativePageRoute) {
  return left.kind === right.kind && left.id === right.id;
}

export function useNativePageHistory(
  storeId: string | undefined,
  kind: NativePageRoute['kind'],
  id: string | undefined,
  intent: number,
) {
  const [history, setHistory] = useState<PageHistory>({ entries: [], index: -1 });
  useLayoutEffect(() => {
    if (!storeId) return;
    const route = kind === 'scheduled' ? { kind } : id !== undefined ? { kind, id } : undefined;
    if (!route) return;
    const entry = { route, intent };
    setHistory((current) => {
      const previous = current.entries[current.index];
      if (current.storeId !== storeId || !previous) return { storeId, entries: [entry], index: 0 };
      const samePage = sameRoute(previous.route, route);
      if (samePage && previous.intent === intent) return current;
      // Project selection updates the new-conversation page. Its first submission
      // replaces that page when the saved conversation takes over the same intent.
      if (
        samePage ||
        (previous.route.kind === 'new' &&
          (kind === 'new' || (kind === 'conversation' && previous.intent === intent)))
      ) {
        return {
          ...current,
          entries: current.entries.map((existing, index) =>
            index === current.index ? entry : existing,
          ),
        };
      }
      const entries = [...current.entries.slice(0, current.index + 1), entry];
      return { storeId, entries, index: entries.length - 1 };
    });
  }, [storeId, kind, id, intent]);
  return {
    destination(direction: -1 | 1, available: (route: NativePageRoute) => boolean) {
      const current = history.entries[history.index];
      if (!storeId || history.storeId !== storeId || !current) return;
      for (
        let index = history.index + direction;
        index >= 0 && index < history.entries.length;
        index += direction
      ) {
        const entry = history.entries[index];
        if (entry && !sameRoute(current.route, entry.route) && available(entry.route))
          return { index, route: entry.route };
      }
      return undefined;
    },
    move(index: number) {
      setHistory((current) => ({ ...current, index }));
    },
  };
}
