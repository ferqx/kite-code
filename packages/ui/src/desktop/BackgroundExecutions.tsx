import { ArrowRight01Icon, BotIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useDesktopDiagnostics } from './diagnostics';
import { Button } from './ui';

export interface BackgroundExecutionSummary {
  readonly activity?: string;
  readonly executionId: string;
  readonly displayName?: string;
  readonly kind: 'shell' | 'service' | 'subagent';
  readonly status:
    | 'queued'
    | 'starting'
    | 'unknown'
    | 'restored'
    | 'running'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unavailable'
    | 'unconfirmed';
  readonly cleanupConfirmed: boolean;
  readonly canStop?: boolean;
  readonly cursor?: number;
  readonly sessionId?: string;
  readonly sessionRevision?: number;
  readonly ownerGeneration?: string;
  readonly revision?: number;
}

export interface BackgroundExecutionsProps {
  readonly id?: string;
  readonly executions: readonly BackgroundExecutionSummary[];
  readonly stale?: boolean;
  readonly busy?: boolean;
  readonly currentOnly?: boolean;
  readonly stoppingExecutionId?: string;
  readonly onStop?: (execution: BackgroundExecutionSummary) => void;
  readonly subagentDetails?: {
    readonly sessionIdsByExecutionId: ReadonlyMap<string, string>;
    readonly loading?: boolean;
    readonly error?: string;
    readonly onOpen: (childSessionId: string, executionId?: string) => void;
    readonly onRefresh: () => void;
  };
}

export function BackgroundExecutions({
  id,
  executions,
  stale,
  busy = false,
  currentOnly,
  stoppingExecutionId,
  onStop,
  subagentDetails,
}: BackgroundExecutionsProps) {
  const diagnostics = useDesktopDiagnostics();
  if (currentOnly) {
    const shells = executions.filter(
      (execution) =>
        execution.kind === 'shell' &&
        (execution.status === 'running' || execution.status === 'stopping'),
    );
    const subagents = executions.filter((execution) => execution.kind === 'subagent');
    return (
      <section
        className="background-executions environment-information"
        id={id}
        data-stale={stale || undefined}
        aria-label="环境信息"
        aria-busy={busy || subagentDetails?.loading || undefined}
      >
        <header>
          <span>环境信息</span>
          {diagnostics && stale && <span className="background-stale">上次状态 · 待核实</span>}
        </header>
        <ExecutionGroup
          icon={TerminalIcon}
          label="Shell"
          emptyLabel="空闲"
          executions={shells}
          stoppingExecutionId={stoppingExecutionId}
          onStop={stale ? undefined : onStop}
          busy={busy}
        />
        <ExecutionGroup
          icon={BotIcon}
          label="子智能体"
          emptyLabel="暂无"
          executions={subagents}
          stoppingExecutionId={stoppingExecutionId}
          onStop={stale ? undefined : onStop}
          busy={busy}
          subagentDetails={subagentDetails}
        />
      </section>
    );
  }
  if (!executions.length && (!stale || !diagnostics)) return null;
  return (
    <section
      className="background-executions"
      aria-label="后台执行"
      aria-busy={busy || undefined}
      data-stale={stale || undefined}
    >
      <header>
        <strong>后台执行</strong>
        {diagnostics && stale && (
          <span className="background-stale">上次已知状态 · 等待重连刷新</span>
        )}
      </header>
      {executions.length === 0 ? (
        <p>后台状态当前不可用；没有可验证的实时执行数据。</p>
      ) : (
        <ul>
          {executions.map((execution) => (
            <li key={execution.executionId}>
              <span>{kindLabel(execution.kind)}</span>
              <code>{execution.executionId}</code>
              <span>{execution.activity ?? statusLabel(execution.status)}</span>
              <span>{execution.cleanupConfirmed ? '清理已确认' : '清理未确认'}</span>
              {execution.cursor !== undefined && <span>游标 {execution.cursor}</span>}
              {onStop && !stale && execution.status === 'running' && (
                <button
                  type="button"
                  disabled={busy || stoppingExecutionId === execution.executionId}
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

function ExecutionGroup({
  icon,
  label,
  emptyLabel,
  executions,
  stoppingExecutionId,
  onStop,
  subagentDetails,
  busy,
}: {
  readonly icon: typeof TerminalIcon;
  readonly label: string;
  readonly emptyLabel: string;
  readonly executions: readonly BackgroundExecutionSummary[];
  readonly stoppingExecutionId?: string;
  readonly onStop?: (execution: BackgroundExecutionSummary) => void;
  readonly subagentDetails?: BackgroundExecutionsProps['subagentDetails'];
  readonly busy: boolean;
}) {
  const diagnostics = useDesktopDiagnostics();
  return (
    <section
      className="background-execution-group"
      aria-label={label}
      aria-busy={busy || subagentDetails?.loading || undefined}
    >
      <h3>
        <HugeiconsIcon icon={icon} />
        <span>{label}</span>
        {executions.length > 0 ? (
          <span className="background-execution-count">{executions.length}</span>
        ) : (
          !subagentDetails?.loading && (
            <span className="background-execution-empty">{emptyLabel}</span>
          )
        )}
      </h3>
      {executions.length > 0 && (
        <ul>
          {executions.map((execution) => {
            const childSessionId = subagentDetails?.sessionIdsByExecutionId.get(
              execution.executionId,
            );
            const name =
              execution.displayName ??
              (diagnostics ? execution.executionId : kindLabel(execution.kind));
            return (
              <li key={execution.executionId} data-execution-id={execution.executionId}>
                <span className="background-execution-identity">
                  {childSessionId ? (
                    <button
                      type="button"
                      className="background-execution-detail"
                      title={name}
                      aria-label={`查看子 Agent 详情：${name}`}
                      onClick={() => subagentDetails?.onOpen(childSessionId, execution.executionId)}
                    >
                      <span>{name}</span>
                      <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />
                    </button>
                  ) : execution.displayName || !diagnostics ? (
                    <span className="background-execution-name">{name}</span>
                  ) : (
                    <code>{execution.executionId}</code>
                  )}
                </span>
                <span className="background-execution-status">
                  {execution.activity ?? statusLabel(execution.status)}
                </span>
                {onStop && execution.status === 'running' && execution.canStop !== false && (
                  <Button
                    className="background-execution-stop"
                    size="xs"
                    disabled={busy || stoppingExecutionId === execution.executionId}
                    onClick={() => onStop(execution)}
                  >
                    {stoppingExecutionId === execution.executionId ? '停止中' : '停止'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {subagentDetails?.error && (
        <p role="alert" className="background-execution-error">
          {subagentDetails.error}{' '}
          <Button className="ghost" size="xs" onClick={subagentDetails.onRefresh}>
            重试
          </Button>
        </p>
      )}
    </section>
  );
}

function kindLabel(kind: BackgroundExecutionSummary['kind']): string {
  if (kind === 'subagent') return '子 Agent';
  return kind === 'service' ? '后台服务' : 'Shell';
}

function statusLabel(status: BackgroundExecutionSummary['status']): string {
  if (status === 'queued') return '排队中';
  if (status === 'starting') return '正在启动';
  if (status === 'unknown') return '结果未知';
  if (status === 'restored') return '恢复历史，只读';
  if (status === 'unconfirmed') return '状态待确认';
  if (status === 'running') return '运行中';
  if (status === 'stopping') return '正在停止';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'failed') return '失败';
  return '不可用';
}
