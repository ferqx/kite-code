import { expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  type TrajectoryEvidenceRef,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  normalizeTrajectoryRequestTab,
  type TrajectoryRequestTab,
  trajectoryRequestMaterial,
  trajectoryRequestOptions,
  trajectoryRequestResult,
  trajectoryRequestTargets,
} from '../src/desktop/trajectory/request-details';
import type { TrajectoryEvidenceView } from '../src/desktop/trajectory/TrajectoryPanel';
import { TrajectoryRequestDetails } from '../src/desktop/trajectory/TrajectoryRequestDetails';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  filterTrajectoryWorkbench,
} from '../src/desktop/trajectory/workbench';

const ref = (
  id: string,
  kind: TrajectoryEvidenceRef['kind'],
  availability: TrajectoryEvidenceRef['availability'] = 'available',
): TrajectoryEvidenceRef => ({
  evidenceId: id,
  contentVersion: `${id}-v1`,
  kind,
  availability,
  mediaType: 'application/json',
});
function fact(n: number, values: Record<string, unknown> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${n.toString(16).padStart(64, '0')}`,
    sequence: String(n),
    origin: { storeId: 'store', cursor: String(n) },
    sessionId: 's',
    workspaceId: 'w',
    runId: 'run',
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
const input = (name: string) => ({
  request: {
    modelId: 'PRIVATE_INTERNAL_BINDING',
    messages: [{ role: 'system', content: 'PRIVATE_SYSTEM_BODY' }],
    tools: [],
  },
  metadata: {
    adapter: {
      availability: 'available',
      adapterId: 'PRIVATE_ADAPTER_ID',
      provider: { availability: 'available', family: `${name}-provider`, modelId: `${name}-model` },
      settings: {
        reasoningEffort: 'high',
        temperature: 0,
        topP: 0.5,
        maxOutputTokens: 1024,
        protocol: 'responses',
        maxRetries: 7,
        maxSteps: 8,
        authorization: 'PRIVATE_AUTHORITY',
      },
    },
  },
});
function fixture() {
  const events = [
    fact(1, { evidenceRefs: [ref('initial-input', 'model_input')] }),
    fact(2, {
      phase: 'running',
      recordedStatus: 'running',
      evidenceRefs: [ref('initial-prefix', 'model_output', 'partial')],
    }),
    fact(3, {
      phase: 'failed',
      recordedStatus: 'failed',
      attributes: { usage: { outputTokens: '0', totalTokens: '17' } },
      evidenceRefs: [ref('initial-prefix', 'model_output', 'partial')],
    }),
    fact(4, {
      executionId: 'retry',
      occurredAt: 1000,
      attributes: {
        previousExecutionId: 'model',
        previousExecutionOriginStoreId: 'store',
        retryAttempt: 2,
        retryReason: 'stream_incomplete',
      },
      evidenceRefs: [ref('retry-input', 'model_input')],
    }),
    fact(5, {
      executionId: 'retry',
      occurredAt: 1250,
      phase: 'completed',
      recordedStatus: 'succeeded',
      attributes: {
        usage: {
          inputTokens: '8086',
          outputTokens: '320',
          cachedInputTokens: '0',
          totalTokens: '9000',
        },
      },
      evidenceRefs: [ref('retry-output', 'model_output')],
    }),
  ];
  const projection = projectTrajectory(events, { atCursor: '5', completePrefix: true });
  const workbench = filterTrajectoryWorkbench(
    buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []), {
      loopParts: true,
    }),
  );
  const row = workbench.byId.get('execution:model')!;
  const values: Record<string, unknown> = {
    'initial-input': input('initial'),
    'retry-input': input('retry'),
    'initial-prefix': {
      content: 'INITIAL_TEXT',
      reasoning: 'PRIVATE_INITIAL_THOUGHT',
      toolCalls: [],
      complete: false,
    },
    'retry-output': {
      content: 'PUBLIC_REPLY',
      reasoning: 'PRIVATE_LATEST_THOUGHT',
      toolCalls: [{ id: 'call', name: 'files.read', arguments: '{}' }],
      complete: true,
    },
  };
  function materials(observationId?: string | null): TrajectoryEvidenceView[] {
    return trajectoryRequestTargets(row, 'overview', observationId).map(({ event, reference }) => ({
      eventId: event.eventId,
      evidenceId: reference.evidenceId,
      contentVersion: reference.contentVersion,
      status: reference.availability === 'partial' ? 'partial' : 'available',
      data: values[reference.evidenceId],
    }));
  }
  function render(
    tab: TrajectoryRequestTab = 'overview',
    observationId?: string | null,
    views = materials(observationId),
  ) {
    return renderToStaticMarkup(
      createElement(TrajectoryRequestDetails, {
        row,
        runLabel: 'Agent loop 1',
        tab,
        observationId,
        targets: trajectoryRequestTargets(row, tab, observationId),
        materials: views,
        active: true,
        scrollTop: 0,
        onScroll() {},
        onClose() {},
        onTabChange() {},
        onObservationChange() {},
        onResult() {},
        rowsById: workbench.byId,
      }),
    );
  }
  return { events, row, workbench, materials, render, values };
}

test('four independent request tabs admit only their own exact references and legacy names normalize safely', () => {
  const f = fixture();
  expect(
    trajectoryRequestTargets(f.row, 'overview').map((target) => target.reference.evidenceId),
  ).toEqual(['retry-input', 'retry-output']);
  expect(
    trajectoryRequestTargets(f.row, 'options').map((target) => target.reference.evidenceId),
  ).toEqual(['retry-input']);
  expect(trajectoryRequestTargets(f.row, 'usage')).toEqual([]);
  expect(trajectoryRequestTargets(f.row, 'timing')).toEqual([]);
  expect(
    trajectoryRequestTargets(f.row, 'overview', f.events[2]!.eventId).map(
      (target) => target.reference.evidenceId,
    ),
  ).toEqual(['initial-input', 'initial-prefix']);
  expect(trajectoryRequestTargets(f.row, 'overview', 'not-current')).toEqual([]);
  for (const old of ['raw', 'thinking', 'preview', null, 'future'])
    expect(normalizeTrajectoryRequestTab(old)).toBe('overview');
  expect(normalizeTrajectoryRequestTab('usage')).toBe('usage');
});

test('overview and options expose only public prepared provider identity and whitelisted options', () => {
  const f = fixture();
  const html = f.render();
  expect(html).toContain('aria-label="模型请求详情"');
  expect(html).toContain('aria-label="关闭请求详情"');
  expect(html).toContain('概述');
  expect(html).toContain('选项');
  expect(html).toContain('用量');
  expect(html).toContain('计时');
  expect(html).toContain('提供方类型');
  expect(html).toContain('retry-provider');
  expect(html).toContain('retry-model');
  expect(html).toContain('<dt>发起工具请求</dt><dd>1</dd>');
  expect(html).toContain('查看该次请求结果');
  expect(html).toContain('请求选项 JSON');
  expect(html).toContain('&quot;temperature&quot;: 0');
  for (const text of [
    'PRIVATE_INTERNAL_BINDING',
    'PRIVATE_ADAPTER_ID',
    'PRIVATE_AUTHORITY',
    'PRIVATE_SYSTEM_BODY',
    'PRIVATE_LATEST_THOUGHT',
    'maxRetries',
    'maxSteps',
    '原始内容',
    '来源 #',
  ])
    expect(html).not.toContain(text);
  expect(f.render('options')).not.toContain('本次请求用量');
  expect(f.render('options')).not.toContain('aria-label="请求计时"');
});

test('unavailable adapter or provider metadata never exposes opaque IDs or private settings', () => {
  for (const metadata of [
    {
      adapter: {
        availability: 'unavailable',
        provider: { availability: 'available', family: 'PRIVATE_FAMILY', modelId: 'PRIVATE_MODEL' },
      },
    },
    {
      adapter: {
        availability: 'available',
        provider: {
          availability: 'unavailable',
          family: 'PRIVATE_FAMILY',
          modelId: 'PRIVATE_MODEL',
        },
        settings: { protocol: 'PRIVATE_PROTOCOL' },
      },
    },
  ]) {
    expect(trajectoryRequestOptions({ metadata })).toBeUndefined();
    const f = fixture();
    const views = f
      .materials()
      .map((view) =>
        view.evidenceId === 'retry-input'
          ? { ...view, data: { request: { modelId: 'PRIVATE_BINDING' }, metadata } }
          : view,
      );
    const html = f.render('options', null, views);
    expect(html).toContain('未保存可展示的提供方和请求选项');
    expect(html).not.toContain('PRIVATE_');
  }
});

test('loading, unavailable, empty and foreign material states never become zero tool calls or a newer provider', () => {
  const f = fixture();
  for (const status of ['loading', 'unavailable', 'empty'] as const) {
    const views = f.materials().map((view) => ({ ...view, status }));
    const html = f.render('overview', null, views);
    expect(html).not.toContain('<dt>发起工具请求</dt><dd>0');
    expect(html).not.toContain('retry-provider');
  }
  const targets = trajectoryRequestTargets(f.row, 'overview');
  const foreign = f.materials().map((view) => ({ ...view, contentVersion: 'foreign-version' }));
  expect(trajectoryRequestMaterial(f.row, 'model_input', targets, foreign).status).toBe('unread');
  expect(f.render('overview', null, foreign)).not.toContain('retry-provider');
  expect(trajectoryRequestMaterial(f.row, 'model_input', [], f.materials()).status).toBe('unread');
  expect(
    trajectoryRequestMaterial(
      f.row,
      'model_input',
      targets,
      f.materials(f.events[2]!.eventId),
      f.events[2]!.eventId,
    ).status,
  ).toBe('unread');
});

test('historical attempts retain their own provider, usage, prefix and timing without summing reconnections', () => {
  const f = fixture();
  const old = f.events[2]!.eventId;
  const html = f.render('overview', old);
  expect(html).toContain('initial-provider');
  expect(html).not.toContain('retry-provider');
  expect(html).toContain('<dt>输出 Token</dt><dd>0</dd>');
  expect(html).toContain('<dt>合计 Token</dt><dd>17</dd>');
  expect(html).not.toContain('8086');
  expect(html).toContain('0（已保存部分）');
  expect(html).toContain('200 毫秒');
  expect(html).not.toContain('250 毫秒');
  expect(html).toContain('首次请求');
  expect(html).toContain('第 1 次重连');
  const current = f.render('usage');
  expect(current).toContain('<dt>缓存 Token</dt><dd>0</dd>');
  expect(current).toContain('<dt>合计 Token</dt><dd>9000</dd>');
  expect(current).not.toContain('8406');
  expect(current).not.toContain('retry-provider');
  expect(f.render('timing')).toContain('250 毫秒');
  expect(f.render('timing')).not.toContain('1.15 秒');
  expect(f.render('usage', f.events[1]!.eventId)).toContain('此版本未记录 Token 用量');
  expect(f.render('usage', 'not-current')).toContain('此版本不在当前历史范围中');
});

test('missing reported totals are omitted and no provider latency or throughput is reconstructed', () => {
  const f = fixture();
  const selected = f.events[4]!;
  if (selected.kind !== 'model') throw Error('expected Model');
  // A snapshot may report input/output without a total; the UI must not invent one.
  delete selected.attributes.usage!.totalTokens;
  const p = projectTrajectory(f.events, { atCursor: '5', completePrefix: true });
  const w = filterTrajectoryWorkbench(buildTrajectoryWorkbenchIndex(p, buildTrajectoryTree(p, [])));
  const html = renderToStaticMarkup(
    createElement(TrajectoryRequestDetails, {
      row: w.byId.get('execution:model')!,
      tab: 'usage',
      targets: [],
      materials: [],
      active: true,
      scrollTop: 0,
      onScroll() {},
      onClose() {},
      onTabChange() {},
      onObservationChange() {},
    }),
  );
  expect(html).toContain('输入 Token');
  expect(html).toContain('输出 Token');
  expect(html).not.toContain('合计 Token');
  expect(html).not.toContain('8406');
  const timing = f.render('timing');
  expect(timing).toContain('已记录请求区间');
  expect(timing).toContain('不代表模型服务生成耗时');
  expect(timing).not.toMatch(/TTFT|首\s*Token|吞吐|tok\/s/);
});

test('result navigation is tied to the selected output reference and never guesses another request or missing version', () => {
  const f = fixture();
  expect(trajectoryRequestResult(f.row, f.workbench.byId)).toBe('execution:model:part:reply');
  expect(trajectoryRequestResult(f.row, f.workbench.byId, f.events[2]!.eventId)).toBe(
    'execution:model:part:reply',
  );
  expect(trajectoryRequestResult(f.row, f.workbench.byId, f.events[0]!.eventId)).toBeUndefined();
  expect(trajectoryRequestResult(f.row, f.workbench.byId, 'not-current')).toBeUndefined();
  const onlyWrongOwner = new Map(f.workbench.byId);
  onlyWrongOwner.delete('execution:model:part:reply');
  expect(trajectoryRequestResult(f.row, onlyWrongOwner)).toBeUndefined();
  expect(trajectoryRequestResult(f.row, undefined)).toBeUndefined();
});

test('compression request details use only the selected original model and never adopted context accounting', () => {
  const events = [
    fact(1, {
      attributes: { compressionId: 'cmp', compressionTrigger: 'automatic' },
      evidenceRefs: [ref('compression-input', 'model_input')],
    }),
    fact(2, {
      phase: 'completed',
      recordedStatus: 'succeeded',
      attributes: {
        compressionId: 'cmp',
        compressionTrigger: 'automatic',
        usage: { inputTokens: '450', outputTokens: '30' },
      },
      evidenceRefs: [ref('compression-output', 'model_output')],
    }),
    fact(3, {
      kind: 'context',
      executionId: 'model',
      phase: 'observed',
      recordedStatus: 'published',
      sourceEventType: 'context.compressed',
      attributes: {
        compressionId: 'cmp',
        compressionTrigger: 'automatic',
        action: 'published',
        compression: {
          adopted: true,
          accounting: {
            basis: 'local-context-estimate-v1',
            beforeTokens: 100000,
            afterTokens: 100,
          },
        },
      },
      evidenceRefs: [ref('adopted-context', 'context')],
    }),
  ];
  const p = projectTrajectory(events, { atCursor: '3', completePrefix: true });
  const w = filterTrajectoryWorkbench(
    buildTrajectoryWorkbenchIndex(p, buildTrajectoryTree(p, []), { loopParts: true }),
  );
  const row = w.byId.get('execution:model')!;
  expect(row.category).toBe('compression');
  expect(row.operation?.members.some((member) => member.kind === 'context')).toBe(true);
  const targets = trajectoryRequestTargets(row, 'overview');
  expect(targets.map((target) => target.reference.evidenceId)).toEqual([
    'compression-input',
    'compression-output',
  ]);
  expect(trajectoryRequestTargets(row, 'overview', events[2]!.eventId)).toEqual([]);
  const html = renderToStaticMarkup(
    createElement(TrajectoryRequestDetails, {
      row,
      tab: 'overview',
      targets,
      materials: targets.map(({ event, reference }) => ({
        eventId: event.eventId,
        evidenceId: reference.evidenceId,
        contentVersion: reference.contentVersion,
        status: 'available' as const,
        data:
          reference.kind === 'model_input'
            ? input('compress')
            : {
                content: 'PRIVATE_SUMMARY_BODY',
                reasoning: 'PRIVATE_COMPRESSION_THOUGHT',
                toolCalls: [],
                complete: true,
              },
      })),
      active: true,
      scrollTop: 0,
      onScroll() {},
      onClose() {},
      onTabChange() {},
      onObservationChange() {},
      rowsById: w.byId,
    }),
  );
  expect(html).toContain('自动压缩请求');
  expect(html).toContain('<dt>输入 Token</dt><dd>450</dd>');
  expect(html).toContain('<dt>输出 Token</dt><dd>30</dd>');
  expect(html).not.toContain('100000');
  expect(html).not.toContain('PRIVATE_SUMMARY_BODY');
  expect(html).not.toContain('PRIVATE_COMPRESSION_THOUGHT');
  expect(html).not.toContain('adopted-context');
  expect(html).not.toContain('查看该次请求结果');
});

test('a canonical message fallback requires exact execution and original scope and never exceeds an explicit observation cutoff', () => {
  const f = fixture();
  const message = fact(6, {
    kind: 'message',
    executionId: 'retry',
    phase: 'observed',
    recordedStatus: 'complete',
    attributes: {
      messageId: 'final',
      role: 'assistant',
      messageSeq: '1',
      revision: '1',
      status: 'complete',
    },
    evidenceRefs: [ref('final-message', 'message')],
  });
  const originalEvents = f.events.map((event) =>
    event.executionId === 'model'
      ? {
          ...event,
          evidenceRefs: event.evidenceRefs.filter((reference) => reference.kind !== 'model_output'),
        }
      : event,
  );
  const p = projectTrajectory([...originalEvents, message], {
    atCursor: '6',
    completePrefix: true,
  });
  const w = filterTrajectoryWorkbench(
    buildTrajectoryWorkbenchIndex(p, buildTrajectoryTree(p, []), { loopParts: true }),
  );
  const rows = new Map(w.byId);
  expect(w.byId.get('execution:model:part:reply')?.presentationHidden).toBe(true);
  expect(trajectoryRequestResult(f.row, w.byId)).toBe('message:final');
  rows.delete('execution:model:part:reply');
  expect(trajectoryRequestResult(f.row, rows)).toBe('message:final');
  expect(trajectoryRequestResult(f.row, rows, f.events[4]!.eventId)).toBeUndefined();
  expect(trajectoryRequestResult(f.row, rows, f.events[2]!.eventId)).toBeUndefined();
  const original = rows.get('message:final')!;
  rows.set('message:final', {
    ...original,
    step: { ...original.step!, executionOriginStoreId: 'foreign' },
  });
  expect(trajectoryRequestResult(f.row, rows)).toBeUndefined();
});

test('tool-only or generating-empty requests do not link an empty result and historical text needs its exact selected version', () => {
  for (const complete of [true, false]) {
    const f = fixture();
    const last = f.events[4]!;
    if (last.kind !== 'model') throw Error('expected Model');
    last.phase = complete ? 'completed' : 'running';
    last.recordedStatus = complete ? 'succeeded' : 'running';
    last.evidenceRefs[0]!.availability = complete ? 'available' : 'partial';
    last.attributes.display = {
      kind: 'model',
      outputPresence: {
        hasText: false,
        toolCallCount: 1,
        complete,
        evidenceId: last.evidenceRefs[0]!.evidenceId,
        contentVersion: last.evidenceRefs[0]!.contentVersion,
      },
    };
    const p = projectTrajectory(f.events, { atCursor: '5', completePrefix: true });
    const w = filterTrajectoryWorkbench(
      buildTrajectoryWorkbenchIndex(p, buildTrajectoryTree(p, []), { loopParts: true }),
    );
    const row = w.byId.get('execution:model')!;
    expect(trajectoryRequestResult(row, w.byId)).toBeUndefined();
    expect(w.byId.get('execution:model:part:reply')?.outputHistory).toBe(true);
    const old = f.events[2]!.eventId;
    expect(trajectoryRequestResult(row, w.byId, old)).toBeUndefined();
    const oldTargets = trajectoryRequestTargets(row, 'overview', old);
    const oldOutput = trajectoryRequestMaterial(
      row,
      'model_output',
      oldTargets,
      f.materials(old),
      old,
    );
    expect(trajectoryRequestResult(row, w.byId, old, oldOutput)).toBe('execution:model:part:reply');
    const html = renderToStaticMarkup(
      createElement(TrajectoryRequestDetails, {
        row,
        tab: 'overview',
        targets: trajectoryRequestTargets(row, 'overview'),
        materials: [],
        active: true,
        scrollTop: 0,
        onScroll() {},
        onClose() {},
        onTabChange() {},
        onObservationChange() {},
        onResult() {},
        rowsById: w.byId,
      }),
    );
    expect(html).not.toContain('查看该次请求结果');
    expect(html).toContain(complete ? '本次仅发起工具调用' : '仍在生成');
  }
});

test('timing has directly readable exact record boundaries and focused tabs omit redundant section headings', () => {
  const f = fixture();
  const html = f.render('timing');
  expect(html).toContain('<dt>开始记录</dt>');
  expect(html).toContain('<dt>终态记录</dt>');
  expect(html).toContain('1970-01-01T00:00:01.000Z');
  expect(html).toContain('1970-01-01T00:00:01.250Z');
  expect(html).not.toContain('trajectory-timing-records');
  for (const tab of ['options', 'usage', 'timing'] as const)
    expect(f.render(tab)).not.toContain(
      `<h4>${{ options: '选项', usage: '用量', timing: '计时' }[tab]}</h4>`,
    );
  const noRows = renderToStaticMarkup(
    createElement(TrajectoryRequestDetails, {
      row: f.row,
      tab: 'overview',
      targets: trajectoryRequestTargets(f.row, 'overview'),
      materials: [],
      active: true,
      scrollTop: 0,
      onScroll() {},
      onClose() {},
      onTabChange() {},
      onObservationChange() {},
    }),
  );
  expect(noRows).toContain('尚未读取该次结果材料');
  expect(noRows).not.toContain('此范围没有可定位');
});
