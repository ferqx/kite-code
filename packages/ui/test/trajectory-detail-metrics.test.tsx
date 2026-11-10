import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TrajectoryExecutionTiming,
  TrajectoryRequestMetrics,
  trajectoryDetailTiming,
} from '../src/desktop/trajectory/DetailMetrics';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  filterTrajectoryWorkbench,
  type WorkbenchRow,
} from '../src/desktop/trajectory/workbench';

function fact(n: number, values: Record<string, unknown> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${n.toString(16).padStart(64, '0')}`,
    sequence: String(n),
    origin: { storeId: 'store', cursor: String(n) },
    sessionId: 's',
    workspaceId: 'w',
    runId: 'r',
    runOriginStoreId: 'store',
    executionId: 'model',
    executionOriginStoreId: 'store',
    kind: 'model',
    phase: 'planned',
    recordedStatus: 'planned',
    occurredAt: n * 100,
    sourceEventType: 'execution.changed',
    sourceRecordRevision: String(n),
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...values,
  });
}
function index(events: TrajectoryEvent[]) {
  const projection = projectTrajectory(events, {
    atCursor: events.at(-1)!.sequence,
    completePrefix: true,
  });
  return filterTrajectoryWorkbench(
    buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, [])),
  );
}
function retry() {
  const events = [
    fact(1, { occurredAt: 1000 }),
    fact(2, {
      occurredAt: 1800,
      phase: 'failed',
      recordedStatus: 'failed',
      attributes: { usage: { outputTokens: '0', totalTokens: '17' } },
    }),
    fact(3, {
      executionId: 'retry',
      occurredAt: 3000,
      attributes: {
        previousExecutionId: 'model',
        previousExecutionOriginStoreId: 'store',
        retryAttempt: 2,
        retryReason: 'connection_failed',
      },
    }),
    fact(4, {
      executionId: 'retry',
      occurredAt: 3100,
      phase: 'running',
      recordedStatus: 'running',
    }),
    fact(5, {
      executionId: 'retry',
      occurredAt: 3400,
      phase: 'completed',
      recordedStatus: 'succeeded',
      attributes: { usage: { inputTokens: '8086', outputTokens: '320', cachedInputTokens: '0' } },
    }),
  ];
  return { events, row: index(events).byId.get('execution:model')! };
}
const summary = (row: WorkbenchRow, observationId?: string | null) =>
  renderToStaticMarkup(
    createElement(TrajectoryRequestMetrics, { row, observationId, modelName: 'actual-model' }),
  );
const timing = (row: WorkbenchRow, observationId?: string | null) =>
  renderToStaticMarkup(
    createElement(TrajectoryExecutionTiming, { row, observationId, kind: 'request' }),
  );

test('request metrics use the selected original attempt and never the merged retry span', () => {
  const { events, row } = retry();
  expect(row.interval.durationMs).toBe(2400);
  expect(trajectoryDetailTiming(row).durationMs).toBe(400);
  expect(trajectoryDetailTiming(row, events[1]!.eventId).durationMs).toBe(800);
  const latest = summary(row);
  expect(latest).toContain('actual-model');
  expect(latest).toContain('已完成');
  expect(latest).toContain('8086');
  expect(latest).toContain('320');
  expect(latest).toContain('<dt>缓存 Token</dt><dd>0</dd>');
  expect(latest).not.toContain('合计 Token');
  expect(latest).not.toContain('请求计时');
  const old = summary(row, events[1]!.eventId);
  expect(old).toContain('失败');
  expect(old).toContain('<dt>输出 Token</dt><dd>0</dd>');
  expect(old).toContain('<dt>合计 Token</dt><dd>17</dd>');
  expect(old).not.toContain('8086');
  expect(timing(row)).toContain('400 毫秒');
  expect(timing(row)).not.toContain('2.4 秒');
});

test('an intermediate selected record has only its observed prefix and no future usage or completion', () => {
  const { events, row } = retry();
  const selected = events[3]!.eventId;
  expect(trajectoryDetailTiming(row, selected).durationMs).toBe(100);
  expect(trajectoryDetailTiming(row, selected).ongoing).toBe(true);
  expect(summary(row, selected)).toContain('运行中');
  expect(summary(row, selected)).not.toContain('输出 Token');
  expect(timing(row, selected)).toContain('100 毫秒（尚未结束）');
  expect(timing(row, selected)).not.toContain('400 毫秒');
  const missing = timing(row, 'not-in-this-row');
  expect(missing).toContain('无法核实');
  expect(missing).not.toContain('400 毫秒');
  expect(summary(row, 'not-in-this-row')).toContain('此版本不在当前历史范围中');
});

test('missing boundaries, source-clock resets and incomplete provenance never yield a duration', () => {
  const cases = [
    [fact(1, { phase: 'completed', recordedStatus: 'succeeded' })],
    [fact(1, { occurredAt: null }), fact(2, { phase: 'completed', recordedStatus: 'succeeded' })],
    [
      fact(1, { occurredAt: 300 }),
      fact(2, { occurredAt: 200, phase: 'completed', recordedStatus: 'succeeded' }),
    ],
    [
      fact(1, { identityConfidence: 'legacy_local' }),
      fact(2, { phase: 'completed', recordedStatus: 'succeeded' }),
    ],
  ];
  for (const events of cases) {
    const row = index(events).rows.find((value) => value.kind === 'model')!;
    expect(trajectoryDetailTiming(row).durationMs).toBeUndefined();
    expect(timing(row)).toContain('无法核实');
  }
  const { row } = retry();
  const crossStore: WorkbenchRow = {
    ...row,
    operation: undefined,
    interval: { basis: 'unknown', ongoing: false, unknownReason: 'cross_store' },
  };
  expect(timing(crossStore)).toContain('记录来自不同来源，不能直接相减');
});

test('failed, cancelled and unknown terminal records keep their real status and bounded observation', () => {
  for (const phase of ['failed', 'cancelled', 'outcome_unknown'] as const) {
    const row = index([fact(1), fact(2, { phase, recordedStatus: phase })]).byId.get(
      'execution:model',
    )!;
    const result = timing(row);
    expect(trajectoryDetailTiming(row).durationMs).toBe(100);
    expect(trajectoryDetailTiming(row).ongoing).toBe(false);
    expect(result).toContain('已记录请求区间');
    expect(result).not.toContain('尚未结束');
    expect(summary(row)).toContain(
      { failed: '失败', cancelled: '已取消', outcome_unknown: '结果未知' }[phase],
    );
  }
});

test('execution timing stays generic and structural Runs do not inherit their child request duration', () => {
  const workbench = index([
    fact(1, { kind: 'tool' }),
    fact(2, { kind: 'tool', phase: 'completed', recordedStatus: 'succeeded' }),
  ]);
  const tool = workbench.byId.get('execution:model')!;
  const result = renderToStaticMarkup(createElement(TrajectoryExecutionTiming, { row: tool }));
  expect(result).toContain('aria-label="执行计时"');
  expect(result).toContain('已记录执行区间');
  expect(result).toContain('100 毫秒');
  const run = workbench.rows.find((row) => row.kind === 'run')!;
  expect(trajectoryDetailTiming(run).durationMs).toBeUndefined();
  expect(timing(run)).toContain('此节点没有独立执行计时');
});

test('record times and timing scope remain folded, without invented provider performance metrics', () => {
  const { row } = retry();
  const result = timing(row);
  expect(result).toContain('<details class="trajectory-timing-records">');
  expect(result).not.toContain('<details open');
  expect(result).toContain('记录时间与计时口径');
  expect(result).toMatch(/datetime=/i);
  expect(result).toContain('不代表模型服务生成耗时');
  expect(result).not.toMatch(/首\s*Token|TTFT|吞吐|tok\/s/);
});
