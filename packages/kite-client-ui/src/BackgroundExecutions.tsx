import { ArrowRight01Icon, BotIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from './ui';

export interface BackgroundExecutionSummary {
  readonly executionId: string;
  readonly displayName?: string;
  readonly kind: 'shell' | 'service' | 'subagent';
  readonly status:
    | 'running'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unavailable'
    | 'unconfirmed';
  readonly cleanupConfirmed: boolean;
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
  readonly currentOnly?: boolean;
  readonly stoppingExecutionId?: string;
  readonly onStop?: (execution: BackgroundExecutionSummary) => void;
  readonly subagentDetails?: {
    readonly sessionIdsByExecutionId: ReadonlyMap<string, string>;
    readonly loading?: boolean;
    readonly error?: string;
    readonly onOpen: (childSessionId: string) => void;
    readonly onRefresh: () => void;
  };
}

export function BackgroundExecutions({
  id,
  executions,
  stale,
  currentOnly,
  stoppingExecutionId,
  onStop,
  subagentDetails,
}: BackgroundExecutionsProps) {
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
        aria-label="环境信息"
      >
        <header>
          <strong>环境信息</strong>
          {stale && <span className="background-stale">上次状态 · 正在核对</span>}
        </header>
        <ExecutionGroup
          icon={TerminalIcon}
          label="当前运行的 Shell"
          emptyLabel="无运行中的 Shell"
          executions={shells}
          stoppingExecutionId={stoppingExecutionId}
          onStop={stale ? undefined : onStop}
        />
        <ExecutionGroup
          icon={BotIcon}
          label="子智能体"
          emptyLabel="暂无子智能体记录"
          executions={subagents}
          stoppingExecutionId={stoppingExecutionId}
          onStop={stale ? undefined : onStop}
          subagentDetails={subagentDetails}
        />
      </section>
    );
  }
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

function ExecutionGroup({
  icon,
  label,
  emptyLabel,
  executions,
  stoppingExecutionId,
  onStop,
  subagentDetails,
}: {
  readonly icon: typeof TerminalIcon;
  readonly label: string;
  readonly emptyLabel: string;
  readonly executions: readonly BackgroundExecutionSummary[];
  readonly stoppingExecutionId?: string;
  readonly onStop?: (execution: BackgroundExecutionSummary) => void;
  readonly subagentDetails?: BackgroundExecutionsProps['subagentDetails'];
}) {
  return (
    <section className="background-execution-group" aria-label={label}>
      <h3>
        <HugeiconsIcon icon={icon} />
        <span>{label}</span>
        <span className="background-execution-count">{executions.length}</span>
        {subagentDetails && (
          <Button
            className="ghost background-execution-refresh"
            size="xs"
            disabled={subagentDetails.loading}
            aria-label="刷新子 Agent"
            onClick={subagentDetails.onRefresh}
          >
            刷新
          </Button>
        )}
      </h3>
      {executions.length === 0 ? (
        <p className="background-execution-empty">{emptyLabel}</p>
      ) : (
        <ul>
          {executions.map((execution) => {
            const childSessionId = subagentDetails?.sessionIdsByExecutionId.get(
              execution.executionId,
            );
            return (
              <li key={execution.executionId}>
                <span className="background-execution-identity">
                  {childSessionId ? (
                    <button
                      type="button"
                      className="background-execution-detail"
                      title={execution.displayName ?? execution.executionId}
                      aria-label={`查看子 Agent 详情：${execution.displayName ?? execution.executionId}`}
                      onClick={() => subagentDetails?.onOpen(childSessionId)}
                    >
                      <span>{execution.displayName ?? execution.executionId}</span>
                      <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />
                    </button>
                  ) : execution.displayName ? (
                    <span className="background-execution-name">{execution.displayName}</span>
                  ) : (
                    <code>{execution.executionId}</code>
                  )}
                </span>
                <span className="background-execution-status">{statusLabel(execution.status)}</span>
                {onStop && execution.status === 'running' && (
                  <Button
                    className="background-execution-stop"
                    size="xs"
                    disabled={stoppingExecutionId === execution.executionId}
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
      {subagentDetails?.loading && executions.length === 0 && (
        <p role="status">正在读取子 Agent…</p>
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
  if (status === 'unconfirmed') return '状态待确认';
  if (status === 'running') return '运行中';
  if (status === 'stopping') return '正在停止';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'failed') return '失败';
  return '不可用';
}
