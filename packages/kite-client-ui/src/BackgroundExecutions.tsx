export interface BackgroundExecutionSummary {
  readonly executionId: string;
  readonly kind: 'shell' | 'service' | 'subagent';
  readonly status: 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'unavailable';
  readonly cleanupConfirmed: boolean;
  readonly cursor?: number;
  readonly sessionId?: string;
  readonly sessionRevision?: number;
  readonly ownerGeneration?: string;
  readonly revision?: number;
}

export interface BackgroundExecutionsProps {
  readonly executions: readonly BackgroundExecutionSummary[];
  readonly stale?: boolean;
  readonly stoppingExecutionId?: string;
  readonly onStop?: (execution: BackgroundExecutionSummary) => void;
}

export function BackgroundExecutions({
  executions,
  stale,
  stoppingExecutionId,
  onStop,
}: BackgroundExecutionsProps) {
  if (!executions.length && !stale) return null;
  return (
    <section className="background-executions" aria-label="后台执行">
      <header>
        <strong>后台执行</strong>
        {stale && <span className="background-stale">上次已知状态 · 等待重连刷新</span>}
      </header>
      {executions.length === 0 ? (
        <p>后台状态当前不可用；没有可验证的实时执行数据。</p>
      ) : (
        <ul>
          {executions.map((execution) => (
            <li key={execution.executionId}>
              <span>{kindLabel(execution.kind)}</span>
              <code>{execution.executionId}</code>
              <span>{statusLabel(execution.status)}</span>
              <span>{execution.cleanupConfirmed ? '清理已确认' : '清理未确认'}</span>
              {execution.cursor !== undefined && <span>游标 {execution.cursor}</span>}
              {onStop && !stale && execution.status === 'running' && (
                <button
                  type="button"
                  disabled={stoppingExecutionId === execution.executionId}
                  onClick={() => onStop(execution)}
                >
                  {stoppingExecutionId === execution.executionId ? '停止请求已受理' : '停止'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function kindLabel(kind: BackgroundExecutionSummary['kind']): string {
  if (kind === 'subagent') return '子 Agent';
  return kind === 'service' ? '后台服务' : 'Shell';
}

function statusLabel(status: BackgroundExecutionSummary['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'stopping') return '正在停止';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'failed') return '失败';
  return '不可用';
}
