import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeToastProps } from './native-message';

/** Presentation only: an old callback can neither retarget an error nor dismiss a newer one. */
export function useNativeErrorFeedback(scope: string) {
  const owner = useMemo(() => ({ scope }), [scope]);
  const current = useRef<typeof owner | undefined>(owner);
  const sequence = useRef(0);
  const [occurrence, setOccurrence] = useState<{
    owner: typeof owner;
    message: NonNullable<NativeToastProps['message']>;
  }>();
  useLayoutEffect(() => {
    current.current = owner;
    setOccurrence((previous) => (previous?.owner === owner ? previous : undefined));
    return () => {
      if (current.current === owner) current.current = undefined;
    };
  }, [owner]);
  const report = useCallback(
    (text?: string) => {
      if (current.current !== owner) return;
      setOccurrence(text ? { owner, message: { id: ++sequence.current, text } } : undefined);
    },
    [owner],
  );
  const dismiss = useCallback((id: number) => {
    setOccurrence((previous) => (previous?.message.id === id ? undefined : previous));
  }, []);
  return { report, dismiss, message: occurrence?.owner === owner ? occurrence.message : undefined };
}
