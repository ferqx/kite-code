import {
  ArrowRight01Icon,
  BotIcon,
  StopIcon,
  TerminalIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { ChildAgentIcon } from './ApprovalHeader';
import { Spinner } from './components/ui/spinner';
import { useDesktopDiagnostics } from './diagnostics';
import { Button } from './ui';

export interface BackgroundExecutionSummary {
  readonly activity?: string;
  readonly executionId: string;
  readonly displayName?: string;
  /** Stable original Store/child Session decoration; grants no navigation or control. */
  readonly childAgentIdentity?: string;
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
  readonly plan?: ReactNode;
  readonly references?: ReactNode;
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
  plan,
  references,
  stoppingExecutionId,
  onStop,
  subagentDetails,
}: BackgroundExecutionsProps) {
  const diagnostics = useDesktopDiagnostics();
  if (currentOnly) {
    const shells = executions.filter(
      (execution) => execution.kind === 'shell' && execution.status === 'running',
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
        {diagnostics && stale && <p className="background-stale">上次状态 · 待核实</p>}
        <ExecutionGroup
          icon={TerminalIcon}
          label="Shell 列表"
          executions={shells}
          stoppingExecutionId={stoppingExecutionId}
          onStop={onStop}
          stopReadOnly={stale || busy}
          busy={busy}
        />
        <ExecutionGroup
          icon={BotIcon}
          label="子智能体"
          executions={subagents}
          stoppingExecutionId={stoppingExecutionId}
          onStop={onStop}
          stopReadOnly={stale || busy}
          busy={busy}
          subagentDetails={subagentDetails}
        />
        {plan}
        {references}
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
                <Button
                  type="button"
                  disabled={busy || stoppingExecutionId === execution.executionId}
                  onClick={() => onStop(execution)}
                >
                  {stoppingExecutionId === execution.executionId ? '停止请求已受理' : '停止'}
                </Button>
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
  executions,
  stoppingExecutionId,
  onStop,
  stopReadOnly,
  subagentDetails,
  busy,
}: {
  readonly icon: typeof TerminalIcon;
  readonly label: string;
  readonly executions: readonly BackgroundExecutionSummary[];
  readonly stoppingExecutionId?: string;
  readonly onStop?: (execution: BackgroundExecutionSummary) => void;
  readonly stopReadOnly?: boolean;
  readonly subagentDetails?: BackgroundExecutionsProps['subagentDetails'];
  readonly busy: boolean;
}) {
  const diagnostics = useDesktopDiagnostics();
  if (executions.length === 0) return null;
  return (
    <section
      className="background-execution-group"
      aria-label={label}
      aria-busy={busy || subagentDetails?.loading || undefined}
    >
      <h3>
        <HugeiconsIcon icon={icon} aria-hidden="true" />
        <span>{label}</span>
      </h3>
      <ul>
        {executions.map((execution) => {
          const childSessionId = subagentDetails?.sessionIdsByExecutionId.get(
            execution.executionId,
          );
          const name =
            execution.displayName ??
            (diagnostics ? execution.executionId : kindLabel(execution.kind));
          const status = execution.activity ?? statusLabel(execution.status);
          const stopping = stoppingExecutionId === execution.executionId;
          const childIcon =
            execution.kind === 'subagent' ? (
              execution.childAgentIdentity ? (
                <ChildAgentIcon identity={execution.childAgentIdentity} />
              ) : (
                <HugeiconsIcon icon={BotIcon} aria-hidden="true" />
              )
            ) : null;
          const row = (
            <>
              <span className="background-execution-identity">
                {childIcon}
                {childSessionId || execution.displayName || !diagnostics ? (
                  <span
                    className="background-execution-name"
                    title={childSessionId ? undefined : name}
                  >
                    {name}
                  </span>
                ) : (
                  <code title={name}>{name}</code>
                )}
              </span>
              <span className="background-execution-status" title={status}>
                {execution.status === 'completed' && (
                  <HugeiconsIcon icon={Tick02Icon} aria-hidden="true" />
                )}
                {execution.status === 'running' && (
                  <span className="background-execution-running" aria-hidden="true" />
                )}
                {status}
              </span>
            </>
          );
          return (
            <li
              key={execution.childAgentIdentity ?? execution.executionId}
              data-execution-id={execution.executionId}
            >
              {childSessionId ? (
                <Button
                  variant="ghost"
                  type="button"
                  className="background-execution-detail background-execution-row"
                  title={name}
                  aria-label={`查看子 Agent 详情：${name}`}
                  aria-description={status}
                  onClick={() => subagentDetails?.onOpen(childSessionId, execution.executionId)}
                >
                  {row}
                  <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />
                </Button>
              ) : (
                <span className="background-execution-row">{row}</span>
              )}
              {onStop && execution.status === 'running' && execution.canStop !== false && (
                <Button
                  className="background-execution-stop"
                  variant="ghost"
                  size="icon-xs"
                  readOnly={stopReadOnly}
                  disabled={stopping}
                  aria-busy={stopping || undefined}
                  aria-label={stopping ? '停止中' : '停止'}
                  aria-description={name}
                  title={stopping ? '停止中' : `停止 ${name}`}
                  onClick={() => onStop(execution)}
                >
                  {stopping ? (
                    <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
                  ) : (
                    <HugeiconsIcon
                      icon={StopIcon}
                      fill="currentColor"
                      strokeWidth={0}
                      aria-hidden="true"
                    />
                  )}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
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
