import { createContext, type ReactNode, useContext } from 'react';

const ReadGateContext = createContext(false);

/** A stale read revokes interaction without changing observed business state. */
export function ReadGate({ blocked, children }: { blocked?: boolean; children: ReactNode }) {
  const parent = useContext(ReadGateContext);
  return (
    <ReadGateContext.Provider value={parent || !!blocked}>{children}</ReadGateContext.Provider>
  );
}

export function useReadGate() {
  return useContext(ReadGateContext);
}
