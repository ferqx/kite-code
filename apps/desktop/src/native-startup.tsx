import { Button } from '@kite-ai/ui/desktop';
import appIcon from '../app-icon.svg';

function startupMessage(error: string | undefined): string | undefined {
  switch (error) {
    case 'windows_access_unavailable':
      return '暂时无法访问启动所需的文件。请关闭可能占用这些文件的程序后重试。';
    case 'startup_timeout':
    case 'connection_timeout':
      return '本地服务暂未就绪。';
    case 'bootstrap_channel_closed':
    case 'service_process_failed':
      return '本地服务启动失败。';
    default:
      return error;
  }
}

/** Retained kite-desktop startup presentation; readiness belongs to the current Native caller. */
export function NativeStartup({
  phase,
  error,
  diagnosticSaveError,
  onSaveDiagnostic,
  onRetry,
}: {
  phase: 'loading' | 'failed';
  error?: string;
  diagnosticSaveError?: string;
  onSaveDiagnostic?: () => void;
  onRetry?: () => void;
}) {
  return (
    <main
      className="kite-client desktop-startup"
      aria-label="Kite 启动页"
      aria-busy={phase === 'loading'}
    >
      <div className="desktop-startup-content">
        <img src={appIcon} width="56" height="56" alt="" />
        <h1>Kite</h1>
        {phase === 'failed' && (
          <>
            <p role="alert">启动未完成：{startupMessage(error)}</p>
            {onSaveDiagnostic && <Button onClick={onSaveDiagnostic}>保存诊断</Button>}
            {diagnosticSaveError && <p role="alert">{diagnosticSaveError}</p>}
            {onRetry && <Button onClick={onRetry}>重新尝试</Button>}
          </>
        )}
      </div>
    </main>
  );
}
