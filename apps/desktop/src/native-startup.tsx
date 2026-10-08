import { Button } from '@kite-ai/ui/desktop';
import appIcon from '../app-icon.svg';

/** Retained kite-desktop startup presentation; readiness belongs to the current Native caller. */
export function NativeStartup({
  phase,
  error,
  onRetry,
}: {
  phase: 'loading' | 'failed';
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <main
      className="kite-client desktop-startup"
      aria-label="kite 启动页"
      aria-busy={phase === 'loading'}
    >
      <div className="desktop-startup-content">
        <img src={appIcon} width="56" height="56" alt="" />
        <h1>kite</h1>
        {phase === 'loading' ? (
          <p role="status">正在准备你的工作空间…</p>
        ) : (
          <>
            <p role="alert">启动未完成：{error}</p>
            {onRetry && <Button onClick={onRetry}>重新尝试</Button>}
          </>
        )}
      </div>
    </main>
  );
}
