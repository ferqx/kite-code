import type { ReactNode } from 'react';
import appIcon from '../app-icon.ico';

export function NativeStartupFrame({
  loading,
  children,
}: {
  loading: boolean;
  children?: ReactNode;
}) {
  return (
    <main className="kite-client desktop-startup" aria-label="Kite 启动页" aria-busy={loading}>
      <div className="desktop-startup-content">
        <img src={appIcon} width="56" height="56" alt="" />
        <h1>Kite</h1>
        {children}
      </div>
    </main>
  );
}
