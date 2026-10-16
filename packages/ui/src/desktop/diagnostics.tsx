import { createContext, useContext } from 'react';

/** Only an explicit test fixture may enable diagnostic presentation. */
const Diagnostics = createContext(false);
export const DesktopDiagnosticsProvider = Diagnostics.Provider;
export const useDesktopDiagnostics = () => useContext(Diagnostics);
