import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLayoutEffect, useRef } from 'react';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '../components/ui/code-block';
import { ScrollArea } from '../components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Button } from '../ui';
import { TrajectoryExecutionTiming, trajectoryDetailTiming } from './DetailMetrics';
import { trajectoryOutputState } from './output-presence';
import {
  type RequestMaterial,
  type TrajectoryRequestTab,
  trajectoryRequestMaterial,
  trajectoryRequestOptions,
  trajectoryRequestResult,
  trajectoryRequestTabs,
} from './request-details';
import type { TrajectoryEvidenceView } from './TrajectoryPanel';
import type { WorkbenchRow } from './workbench';
import {
  type TrajectoryMaterialTarget,
  trajectorySelectedMember,
  trajectorySelectedObservation,
} from './workbench-details';

export type { TrajectoryRequestTab } from './request-details';

const tabLabels = { overview: '概述', options: '选项', usage: '用量', timing: '计时' };
const phases: Record<string, string> = {
  planned: '已计划',
  dispatching: '派发中',
  running: '运行中',
  waiting_interaction: '等待回答',
  waiting_execution: '等待执行',
  cancelling: '取消中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  outcome_unknown: '结果未知',
  observed: '已记录',
};
function materialState(material: RequestMaterial): string {
  return {
    not_saved: '未保存',
    unread: '尚未读取',
    loading: '正在读取',
    available: '未保存可展示字段',
    partial: '仅保存部分内容',
    truncated: '已保存内容被截断',
    missing: '未保存此材料',
    unavailable: '此材料当前不可读取',
    redacted: '此材料已遮蔽',
    empty: '已保存的内容为空',
  }[material.status];
}
function Options({ input }: { input: RequestMaterial }) {
  const options = trajectoryRequestOptions(input.data);
  if (!options)
    return (
      <p role="status">
        {input.data ? '此版本未保存可展示的提供方和请求选项。' : materialState(input)}
      </p>
    );
  const json = JSON.stringify(
    {
      ...(options.family ? { providerFamily: options.family } : {}),
      ...(options.modelName ? { model: options.modelName } : {}),
      ...options.settings,
    },
    null,
    2,
  );
  return (
    <>
      {['partial', 'truncated'].includes(input.status) && (
        <p role="status">仅展示该版本已保存的公开选项。</p>
      )}
      <CodeBlock size="sm">
        <CodeBlockHeader>
          <CodeBlockTitle>请求选项 JSON</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={json} />
          </CodeBlockActions>
        </CodeBlockHeader>
        <CodeBlockContent wrap codeClassName="language-json" aria-label="请求选项 JSON">
          {json}
        </CodeBlockContent>
      </CodeBlock>
    </>
  );
}
function Usage({ row, observationId }: { row: WorkbenchRow; observationId?: string | null }) {
  const selected = trajectorySelectedObservation(row, observationId);
  const current = selected?.kind === 'model' ? selected : undefined;
  const usage = current?.kind === 'model' ? current.attributes.usage : undefined;
  const fields = [
    ['inputTokens', '输入 Token'],
    ['outputTokens', '输出 Token'],
    ['cachedInputTokens', '缓存 Token'],
    ['totalTokens', '合计 Token'],
  ] as const;
  if (!fields.some(([key]) => usage?.[key] !== undefined))
    return (
      <p role="status">{current ? '此版本未记录 Token 用量。' : '此版本不在当前历史范围中。'}</p>
    );
  return (
    <dl className="trajectory-request-usage" aria-label="本次请求用量">
      {fields.map(([key, label]) =>
        usage?.[key] !== undefined ? (
          <div key={key} className="trajectory-usage-item">
            <dt>{label}</dt>
            <dd>{usage[key]}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

function RequestTiming({
  row,
  observationId,
}: {
  row: WorkbenchRow;
  observationId?: string | null;
}) {
  const interval = trajectoryDetailTiming(row, observationId);
  const selected = trajectorySelectedObservation(row, observationId);
  const current = selected?.kind === 'model' ? selected : undefined;
  const time = (value?: number | null) => {
    const date = value === undefined || value === null ? undefined : new Date(value);
    return date && Number.isFinite(date.getTime()) ? (
      <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
    ) : (
      '未记录'
    );
  };
  return (
    <section className="trajectory-detail-timing" aria-label="请求计时">
      <dl className="trajectory-metadata">
        <dt>开始记录</dt>
        <dd>{time(interval.startAt)}</dd>
        <dt>
          {current &&
          ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(current.phase)
            ? '终态记录'
            : '当前记录'}
        </dt>
        <dd>{time(current?.occurredAt)}</dd>
        <dt>已记录请求区间</dt>
        <dd>
          {interval.durationMs === undefined
            ? '无法核实'
            : `${interval.durationMs < 1000 ? `${Math.round(interval.durationMs)} 毫秒` : `${Number((interval.durationMs / 1000).toFixed(2))} 秒`}${interval.ongoing ? '（尚未结束）' : ''}`}
        </dd>
      </dl>
      <p className="trajectory-material-notice">
        仅按该次请求的已保存记录边界计算，包含准备、调度和结果记录开销；不代表模型服务生成耗时。
        {interval.basis === 'unknown' && '当前范围缺少可比较的完整时间边界。'}
      </p>
    </section>
  );
}

export function TrajectoryRequestDetails({
  row,
  runLabel,
  tab,
  targets,
  materials,
  observationId,
  active,
  scrollTop,
  onScroll,
  onClose,
  onTabChange,
  onObservationChange,
  onRetry,
  onResult,
  rowsById,
  excluded,
  collapsed,
}: {
  row: WorkbenchRow;
  runLabel?: string;
  tab: TrajectoryRequestTab;
  targets: readonly TrajectoryMaterialTarget[];
  materials: readonly TrajectoryEvidenceView[];
  observationId?: string | null;
  active: boolean;
  scrollTop: number;
  onScroll: (top: number) => void;
  onClose: () => void;
  onTabChange: (tab: TrajectoryRequestTab) => void;
  onObservationChange: (id: string | null) => void;
  onRetry?: () => void;
  onResult?: (id: string) => void;
  rowsById?: ReadonlyMap<string, WorkbenchRow>;
  excluded?: boolean;
  collapsed?: boolean;
}) {
  const selected = trajectorySelectedObservation(row, observationId);
  const current = selected?.kind === 'model' ? selected : undefined;
  const member = trajectorySelectedMember(row, observationId);
  const input = trajectoryRequestMaterial(row, 'model_input', targets, materials, observationId);
  const output = trajectoryRequestMaterial(row, 'model_output', targets, materials, observationId);
  const options = trajectoryRequestOptions(input.data);
  const modelName =
    options?.modelName ??
    (current?.kind === 'model' ? current.attributes.display?.modelName : undefined);
  const resultId = trajectoryRequestResult(row, rowsById, observationId, output);
  const calls = Array.isArray(output.data?.toolCalls) ? output.data.toolCalls : undefined;
  const partialOutput =
    ['partial', 'truncated'].includes(output.status) ||
    output.target?.reference.availability !== 'available' ||
    output.data?.complete === false;
  const outputState = member ? trajectoryOutputState(member, output.target) : 'unknown';
  const resultNotice =
    outputState === 'tool_only'
      ? '本次仅发起工具调用，没有独立正文结果。'
      : outputState === 'generating_empty'
        ? '仍在生成，当前已保存前缀尚无正文结果。'
        : ['unread', 'loading'].includes(output.status)
          ? `${materialState(output)}该次结果材料。`
          : output.data?.complete === false && output.data.content === ''
            ? '此版本保存的前缀没有正文，不能据此判断完整结果为空。'
            : output.data?.content === ''
              ? '此版本没有独立正文结果。'
              : typeof output.data?.content === 'string'
                ? '结果已保存，但当前范围没有对应的可定位内容节点。'
                : `该次结果：${materialState(output)}。`;
  const viewport = useRef<HTMLDivElement>(null),
    restored = useRef('');
  const key = `${row.id}:${tab}:${observationId ?? 'latest'}`;
  const ready = targets.every((target) =>
    materials.some(
      (view) =>
        view.eventId === target.event.eventId &&
        view.evidenceId === target.reference.evidenceId &&
        view.contentVersion === target.reference.contentVersion &&
        view.status !== 'loading',
    ),
  );
  useLayoutEffect(() => {
    if (!active) {
      restored.current = '';
      return;
    }
    if (ready && viewport.current && restored.current !== key) {
      viewport.current.scrollTop = scrollTop;
      restored.current = key;
    }
  }, [active, ready, key, scrollTop]);
  const attempts = row.operation?.attempts ?? (row.kind === 'model' ? [row] : []);
  return (
    <section
      className="trajectory-detail trajectory-request-detail"
      aria-label="模型请求详情"
      hidden={!active}
    >
      <header className="trajectory-detail-heading">
        <div className="trajectory-detail-context">
          <span className="trajectory-type-badge" data-tone="model">
            请求
          </span>
          <span className="trajectory-detail-context-label">
            {runLabel ?? '当前会话'}
            {row.category === 'compression' ? ' · 自动压缩请求' : ''}
            {row.requestIndex !== undefined ? ` · 请求 ${row.requestIndex}` : ''}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="关闭请求详情"
          title="关闭请求详情"
          onClick={onClose}
        >
          <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
        </Button>
      </header>
      {excluded && <p role="status">此请求不在当前筛选结果中；保留原选择与材料。</p>}
      {collapsed && <p role="status">此请求当前被折叠；保留原选择与材料。</p>}
      <Tabs
        className="trajectory-detail-tabs"
        value={tab}
        activationMode="manual"
        onValueChange={(value) => onTabChange(value as TrajectoryRequestTab)}
      >
        <TabsList aria-label="请求详情">
          {trajectoryRequestTabs.map((value) => (
            <TabsTrigger key={value} value={value}>
              {tabLabels[value]}
            </TabsTrigger>
          ))}
        </TabsList>
        <ScrollArea
          className="trajectory-detail-scroll"
          nativeScrollbars
          chainScroll
          viewportRef={viewport}
          viewportProps={{
            'aria-label': '请求详情正文',
            tabIndex: 0,
            onScroll: (event) => onScroll(event.currentTarget.scrollTop),
          }}
        >
          {(attempts.length > 1 || row.operation?.attemptsComplete === false) && (
            <details className="trajectory-request-retries">
              <summary>请求尝试 · {attempts.length} 次已保存请求</summary>
              {row.operation?.attemptsComplete === false && (
                <p role="status">重连关联不完整；仅展示当前范围可核实的请求。</p>
              )}
              <ol>
                {attempts.map((attempt, index) => {
                  const last = attempt.events.at(-1);
                  const numbered = attempt.events.find(
                    (event) =>
                      event.kind === 'model' && event.attributes.retryAttempt !== undefined,
                  );
                  const number =
                    numbered?.kind === 'model'
                      ? numbered.attributes.retryAttempt
                      : row.operation?.attemptsComplete !== false
                        ? index + 1
                        : undefined;
                  return (
                    <li key={attempt.nodeId}>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!last}
                        aria-pressed={member?.nodeId === attempt.nodeId}
                        onClick={() => last && onObservationChange(last.eventId)}
                      >
                        {number === 1
                          ? '首次请求'
                          : number !== undefined
                            ? `第 ${number - 1} 次重连`
                            : `已保存请求 ${index + 1}`}{' '}
                        · {phases[last?.phase ?? ''] ?? '状态未记录'}
                      </Button>
                    </li>
                  );
                })}
              </ol>
              {observationId && (
                <Button size="xs" variant="ghost" onClick={() => onObservationChange(null)}>
                  返回最新一次请求
                </Button>
              )}
            </details>
          )}
          {onRetry &&
            [input.status, output.status].some((state) =>
              ['unavailable', 'missing'].includes(state),
            ) && (
              <Button size="xs" variant="ghost" onClick={onRetry}>
                重试读取材料
              </Button>
            )}
          {trajectoryRequestTabs.map((value) => (
            <TabsContent
              key={value}
              value={value}
              className="trajectory-detail-content"
              data-detail-tab={value}
            >
              {value === 'overview' && (
                <section aria-label="本次请求概述">
                  <dl className="trajectory-metadata">
                    <dt>状态</dt>
                    <dd>
                      {current
                        ? (phases[current.phase] ?? '状态未记录')
                        : '此版本不在当前历史范围中'}
                    </dd>
                    <dt>提供方类型</dt>
                    <dd>
                      {options?.family ??
                        (input.data ? '未保存可用提供方信息' : materialState(input))}
                    </dd>
                    <dt>模型</dt>
                    <dd>{modelName ?? (input.data ? '模型名称未保存' : materialState(input))}</dd>
                    <dt>发起工具请求</dt>
                    <dd>
                      {calls
                        ? `${calls.length}${partialOutput ? '（已保存部分）' : ''}`
                        : materialState(output)}
                    </dd>
                  </dl>
                  {onResult && resultId ? (
                    <Button size="xs" variant="ghost" onClick={() => onResult(resultId)}>
                      查看该次请求结果
                    </Button>
                  ) : (
                    <p className="trajectory-material-notice">{resultNotice}</p>
                  )}
                </section>
              )}
              {(value === 'overview' || value === 'options') && (
                <section className="trajectory-request-options" aria-label="请求选项">
                  {value === 'overview' && <h4>选项</h4>}
                  <Options input={input} />
                </section>
              )}
              {(value === 'overview' || value === 'usage') && (
                <section aria-label="请求用量">
                  {value === 'overview' && <h4>用量</h4>}
                  <Usage row={row} observationId={observationId} />
                </section>
              )}
              {(value === 'overview' || value === 'timing') && (
                <section>
                  {value === 'overview' && <h4>计时</h4>}
                  {value === 'timing' ? (
                    <RequestTiming row={row} observationId={observationId} />
                  ) : (
                    <TrajectoryExecutionTiming
                      row={row}
                      observationId={observationId}
                      kind="request"
                    />
                  )}
                </section>
              )}
            </TabsContent>
          ))}
        </ScrollArea>
      </Tabs>
    </section>
  );
}
