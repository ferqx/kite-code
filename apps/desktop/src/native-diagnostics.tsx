import { DesktopDiagnosticsProvider, useDesktopDiagnostics } from '@kite-ai/ui/desktop';
import type { ReactNode } from 'react';

/** Presentation only. This never grants a Service capability or execution authority. */
export function NativeDiagnosticsProvider({
  enabled = false,
  children,
}: {
  enabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DesktopDiagnosticsProvider value={enabled === true}>{children}</DesktopDiagnosticsProvider>
  );
}

export function useNativeDiagnostics(): boolean {
  return useDesktopDiagnostics() === true;
}

export function NativeDiagnostic({ children }: { children: ReactNode }) {
  return useNativeDiagnostics() ? children : null;
}
