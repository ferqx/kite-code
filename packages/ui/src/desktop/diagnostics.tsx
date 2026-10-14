import { createContext, useContext } from 'react';

/** Unspecified preserves existing consumers; Native supplies an explicit boolean. */
const Diagnostics = createContext<boolean | undefined>(undefined);
export const DesktopDiagnosticsProvider = Diagnostics.Provider;
export const useDesktopDiagnostics = () => useContext(Diagnostics);
