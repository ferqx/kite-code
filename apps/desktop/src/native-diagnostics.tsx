import { DesktopDiagnosticsProvider, useDesktopDiagnostics } from '@kite-ai/ui/desktop';
import type { ReactNode } from 'react';

declare const __KITE_DESKTOP_TEST_DIAGNOSTICS__: boolean;

/** Presentation only. This never grants a Service capability or execution authority. */
export function NativeDiagnosticsProvider({
  enabled = false,
  children,
}: {
  enabled?: boolean;
  children: ReactNode;
}) {
  // Direct DOM fixtures have no build constant; dev/prod renderers explicitly set it to false.
  const testBuild =
    typeof __KITE_DESKTOP_TEST_DIAGNOSTICS__ === 'undefined' ||
    __KITE_DESKTOP_TEST_DIAGNOSTICS__ === true;
  return (
    <DesktopDiagnosticsProvider value={testBuild && enabled === true}>
      {children}
    </DesktopDiagnosticsProvider>
  );
}

export function useNativeDiagnostics(): boolean {
  return useDesktopDiagnostics() === true;
}

export function NativeDiagnostic({ children }: { children: ReactNode }) {
  return useNativeDiagnostics() ? children : null;
}
