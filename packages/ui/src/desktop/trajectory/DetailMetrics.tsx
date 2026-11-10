import { parseDecimal64, type TrajectoryEvent } from '@kite-ai/trajectory';
import type { WorkbenchObservedInterval, WorkbenchRow } from './workbench';
import { trajectorySelectedMember, trajectorySelectedObservation } from './workbench-details';

const phaseLabels: Record<string, string> = {
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
const terminal = new Set(['completed', 'failed', 'cancelled', 'outcome_unknown']);
const unknownReasons: Record<string, string> = {
  missing_time: '原记录缺少有效时间。',
  missing_boundary: '原记录缺少可核实的计划或结束边界。',
  cross_store: '记录来自不同来源，不能直接相减。',
  clock_reversed: '记录时钟发生回退，无法核实区间。',
  incomplete_history: '当前历史缺少完整来源证明。',
  not_a_call: '此节点没有独立执行计时。',
};
const hasTime = (event: TrajectoryEvent | undefined) =>
  typeof event?.occurredAt === 'number' &&
  Number.isFinite(event.occurredAt) &&
  event.occurredAt >= 0;

/** Select an original member, never the span that combines requests and reconnection waits. */
export function trajectoryDetailTiming(
  row: WorkbenchRow,
  observationId?: string | null,
): WorkbenchObservedInterval {
  const member = trajectorySelectedMember(row, observationId);
  const selected = trajectorySelectedObservation(row, observationId);
  const unknown = (unknownReason: WorkbenchObservedInterval['unknownReason']) => ({
    basis: 'unknown' as const,
    ongoing: false,
    unknownReason,
  });
  if (!member) return unknown('incomplete_history');
  if (!['model', 'tool', 'job'].includes(member.kind)) return unknown('not_a_call');
  if (!selected) return unknown('incomplete_history');
  // The workbench also detects source-clock resets in other entities. Preserve that verdict.
  if (member.interval.basis === 'unknown') return member.interval;
  const events = member.events.filter(
    (event) => parseDecimal64(event.sequence) <= parseDecimal64(selected.sequence),
  );
  if (!events.length || events.some((event) => event.identityConfidence !== 'verified_origin'))
    return unknown('incomplete_history');
  if (new Set(events.map((event) => event.origin.storeId)).size !== 1)
    return unknown('cross_store');
  const start = events[0]!;
  const end = events.at(-1)!;
  if (start.phase !== 'planned' || start === end || end.eventId !== selected.eventId)
    return unknown('missing_boundary');
  if (!hasTime(start) || !hasTime(end)) return unknown('missing_time');
  let previous = -Infinity;
  for (const event of events) {
    if (!hasTime(event)) continue;
    if (event.occurredAt! < previous) return unknown('clock_reversed');
    previous = event.occurredAt!;
  }
  return {
    basis: terminal.has(end.phase) ? 'planned_to_terminal' : 'observed_progress',
    startEventId: start.eventId,
    endEventId: end.eventId,
    startAt: start.occurredAt!,
    endAt: end.occurredAt!,
    durationMs: end.occurredAt! - start.occurredAt!,
    originStoreId: start.origin.storeId,
    ongoing: !terminal.has(end.phase),
  };
}

const duration = (milliseconds: number) =>
  milliseconds < 1000
    ? `${Math.round(milliseconds)} 毫秒`
    : `${Number((milliseconds / 1000).toFixed(2))} 秒`;
function RecordedTime({ value }: { value?: number }) {
  const date = value === undefined ? undefined : new Date(value);
  return date && Number.isFinite(date.getTime()) ? (
    <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
  ) : (
    <>未记录</>
  );
}

function Timing({
  row,
  observationId,
  kind,
}: {
  row: WorkbenchRow;
  observationId?: string | null;
  kind: 'request' | 'execution';
}) {
  const current = trajectorySelectedObservation(row, observationId);
  const interval = trajectoryDetailTiming(row, observationId);
  return (
    <section
      className="trajectory-detail-timing"
      aria-label={kind === 'request' ? '请求计时' : '执行计时'}
    >
      <dl className="trajectory-timing-line">
        <dt>{kind === 'request' ? '已记录请求区间' : '已记录执行区间'}</dt>
        <dd>
          {interval.durationMs === undefined
            ? '无法核实'
            : `${duration(interval.durationMs)}${interval.ongoing ? '（尚未结束）' : ''}`}
        </dd>
      </dl>
      <details className="trajectory-timing-records">
        <summary>记录时间与计时口径</summary>
        <dl className="trajectory-metadata">
          {interval.startAt !== undefined && (
            <>
              <dt>开始记录</dt>
              <dd>
                <RecordedTime value={interval.startAt} />
              </dd>
            </>
          )}
          <dt>当前记录</dt>
          <dd>
            <RecordedTime value={hasTime(current) ? current!.occurredAt! : undefined} />
          </dd>
        </dl>
        {interval.basis === 'unknown' ? (
          <p>{unknownReasons[interval.unknownReason ?? ''] ?? '当前范围无法核实计时边界。'}</p>
        ) : (
          <p>
            从该次计划记录到{interval.ongoing ? '当前已保存记录' : '终态记录'}的观察区间，
            包含准备、调度和结果记录开销；不代表
            {kind === 'request' ? '模型服务生成' : '底层操作实际运行'}耗时。
          </p>
        )}
      </details>
    </section>
  );
}

export function TrajectoryExecutionTiming({
  row,
  observationId,
  kind = 'execution',
}: {
  row: WorkbenchRow;
  observationId?: string | null;
  kind?: 'request' | 'execution';
}) {
  return <Timing row={row} observationId={observationId} kind={kind} />;
}

/** Only the selected event's explicit usage is shown; totals are never reconstructed. */
export function TrajectoryRequestMetrics({
  row,
  observationId,
  modelName,
}: {
  row: WorkbenchRow;
  observationId?: string | null;
  modelName?: string;
}) {
  const current = trajectorySelectedObservation(row, observationId);
  const usage = current?.kind === 'model' ? current.attributes.usage : undefined;
  const tokens = [
    ['inputTokens', '输入 Token'],
    ['outputTokens', '输出 Token'],
    ['cachedInputTokens', '缓存 Token'],
    ['totalTokens', '合计 Token'],
  ] as const;
  return (
    <section className="trajectory-detail-summary" aria-label="本次模型请求">
      <dl className="trajectory-request-identity">
        <dt className="sr-only">模型</dt>
        <dd className="trajectory-request-model">{modelName ?? '模型名称未保存'}</dd>
        <dt className="sr-only">状态</dt>
        <dd className="trajectory-request-state" data-state={current?.phase ?? 'unknown'}>
          {current ? (phaseLabels[current.phase] ?? '状态未记录') : '此版本不在当前历史范围中'}
        </dd>
      </dl>
      {tokens.some(([key]) => usage?.[key] !== undefined) && (
        <dl className="trajectory-request-usage">
          {tokens.map(([key, label]) =>
            usage?.[key] !== undefined ? (
              <div key={key} className="trajectory-usage-item">
                <dt>{label}</dt>
                <dd>{usage[key]}</dd>
              </div>
            ) : null,
          )}
        </dl>
      )}
    </section>
  );
}
