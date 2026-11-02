import { useCallback, useLayoutEffect, useRef } from 'react';

type PermissionMode = 'accept_edits' | 'auto' | 'full';

export function useNativePermissionChange(action: (mode: PermissionMode) => void) {
  const current = useRef<typeof action | undefined>(action);
  useLayoutEffect(() => {
    // A suspended replacement render cannot retarget a confirmation owned by
    // the UI that is still committed and visible.
    current.current = action;
    return () => {
      if (current.current === action) current.current = undefined;
    };
  }, [action]);
  return useCallback((mode: PermissionMode) => current.current?.(mode), []);
}
