import { afterAll, afterEach, expect, test } from 'bun:test';
import {
  projectTrajectory,
  type TrajectoryEvent,
  type TrajectoryEvidenceRef,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { JSDOM } from 'jsdom';
import { act, useCallback, useState } from 'react';
import type { TrajectoryMaterialTarget } from '../../src/desktop/trajectory/workbench-details';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
});
class TestResizeObserver {
  static instances = new Set<TestResizeObserver>();
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.instances.add(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    TestResizeObserver.instances.delete(this);
  }
  static notify() {
    for (const observer of [...TestResizeObserver.instances])
      observer.callback([], observer as unknown as ResizeObserver);
  }
}
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Element: dom.window.Element,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  DOMRect: dom.window.DOMRect,
  getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries(globals)) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.assign(dom.window, {
  ResizeObserver: TestResizeObserver,
  requestAnimationFrame: globals.requestAnimationFrame,
  cancelAnimationFrame: globals.cancelAnimationFrame,
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => {},
});
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { TrajectoryPanel } = await import('../../src/desktop/trajectory/TrajectoryPanel');
const { initialTrajectoryViewState } = await import('../../src/desktop/trajectory/view-state');
const { buildTrajectoryTree } = await import('../../src/desktop/trajectory/tree');
const thinkingId = 'execution:model:part:thinking';
type ViewState = ReturnType<typeof initialTrajectoryViewState>;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
function material(
  evidenceId: string,
  kind: TrajectoryEvidenceRef['kind'],
  contentVersion = `${evidenceId}-version`,
): TrajectoryEvidenceRef {
  return { evidenceId, contentVersion, kind, availability: 'available', mediaType: 'text/plain' };
}
function facts() {
  const events: TrajectoryEvent[] = [];
  function add(
    kind: TrajectoryEvent['kind'],
    phase: TrajectoryEvent['phase'],
    attributes: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const sequence = String(events.length + 1);
    const event = trajectoryEventSchema.parse({
      schema: 'kite.trajectory',
      schemaVersion: 1,
      eventId: `te_${Number(sequence).toString(16).padStart(64, '0')}`,
      sequence,
      origin: { storeId: 'store', cursor: sequence },
      sessionId: 'session',
      workspaceId: 'workspace',
      runId: 'run',
      sourceEventType: `${kind}.${phase}`,
      sourceRecordRevision: sequence,
      kind,
      phase,
      recordedStatus: phase,
      occurredAt: null,
      identityConfidence: 'verified_origin',
      attributes,
      evidenceRefs: [],
      ...extra,
    });
    events.push(event);
    return event;
  }
  const run = add('run', 'running', {});
  const input = add(
    'model',
    'planned',
    { definitionId: 'respond' },
    {
      executionId: 'model',
      attempt: 1,
      evidenceRefs: [material('input', 'model_input')],
    },
  );
  const prefix = add(
    'model',
    'running',
    { definitionId: 'respond', resultRevision: '1' },
    {
      executionId: 'model',
      attempt: 1,
      evidenceRefs: [material('prefix', 'model_output', 'prefix-v1')],
    },
  );
  const failed = add(
    'model',
    'failed',
    { definitionId: 'respond', resultRevision: '1' },
    {
      executionId: 'model',
      attempt: 1,
      evidenceRefs: [material('prefix', 'model_output', 'prefix-v1')],
    },
  );
  add(
    'model',
    'planned',
    {
      previousExecutionId: 'model',
      previousExecutionOriginStoreId: 'store',
      retryReason: 'stream_incomplete',
      retryAttempt: 2,
      definitionId: 'respond',
    },
    { executionId: 'retry', attempt: 2 },
  );
  const retry = add(
    'model',
    'completed',
    { definitionId: 'respond', resultRevision: '2' },
    {
      executionId: 'retry',
      attempt: 2,
      evidenceRefs: [material('retry-result', 'model_output')],
    },
  );
  add(
    'tool',
    'planned',
    { definitionId: 'read_file' },
    {
      executionId: 'tool',
      parentExecutionId: 'retry',
    },
  );
  add(
    'interaction',
    'waiting_interaction',
    {
      interactionId: 'approval',
      interactionKind: 'approval',
      revision: '1',
      decision: 'requested',
    },
    { executionId: 'tool' },
  );
  add(
    'interaction',
    'observed',
    {
      interactionId: 'approval',
      interactionKind: 'approval',
      revision: '2',
      decision: 'accepted',
    },
    { executionId: 'tool' },
  );
  const tool = add(
    'tool',
    'completed',
    { definitionId: 'read_file', resultRevision: '1' },
    {
      executionId: 'tool',
      parentExecutionId: 'retry',
      evidenceRefs: [material('tool-result', 'tool_result')],
    },
  );
  add(
    'job',
    'running',
    { definitionId: 'check_tests', childSessionId: 'child' },
    {
      executionId: 'carrier',
      parentExecutionId: 'retry',
    },
  );
  add('child', 'observed', {
    childSessionId: 'child',
    carrierExecutionId: 'carrier',
    delivery: 'pending',
  });
  const unknown = add('unknown', 'observed', { reason: 'legacy_fields_missing' });
  add('artifact', 'observed', { artifactId: 'artifact', mediaType: 'text/plain' });
  add('verification', 'completed', {
    verificationId: 'verification',
    outcome: 'passed',
    method: 'test_evidence',
  });
  return { events, run, input, prefix, failed, retry, tool, unknown };
}
type PanelProps = Parameters<typeof TrajectoryPanel>[0];
function harness(
  events: TrajectoryEvent[],
  cursor = events.at(-1)!.sequence,
  withLoops = false,
  related: PanelProps['relatedTrajectories'] = [],
  mode: PanelProps['mode'] = 'history',
  options: Partial<Pick<PanelProps, 'integrity' | 'errorCode'>> = {},
) {
  const upperCursor = events.at(-1)!.sequence;
  let retained: ViewState = {
    ...initialTrajectoryViewState({
      storeId: 'store',
      sessionId: 'session',
      upperCursor,
      formatVersion: 1,
      historyCoverage: { enabledAfterCursor: '0', upperCursor, status: 'retained', integrity },
    }),
    cursor,
  };
  let update!: (state: ViewState) => void;
  const opened: NonNullable<PanelProps['materials']>[number][][] = [];
  const loopOpened: TrajectoryMaterialTarget[][] = [];
  const values = new Map<string, unknown>();
  const relatedTargets: Parameters<NonNullable<PanelProps['onExpandedChildrenChange']>>[0][] = [];
  const captureChildren: NonNullable<PanelProps['onExpandedChildrenChange']> = (targets) => {
    relatedTargets.push(targets);
  };
  let retries = 0;
  let latestReturns = 0;
  function Harness({
    held = false,
    foreign = false,
    hint = false,
  }: {
    held?: boolean;
    foreign?: boolean;
    hint?: boolean;
  }) {
    const [state, setState] = useState(retained);
    const [materials, setMaterials] = useState<NonNullable<PanelProps['materials']>>([]);
    const [loopMaterials, setLoopMaterials] = useState<NonNullable<PanelProps['loopMaterials']>>(
      [],
    );
    const requestLoopMaterials = useCallback<NonNullable<PanelProps['onLoopMaterialsChange']>>(
      (targets) => {
        loopOpened.push([...targets]);
        setLoopMaterials(
          targets.map(({ event, reference }) => ({
            eventId: event.eventId,
            evidenceId: reference.evidenceId,
            contentVersion: reference.contentVersion,
            status: 'available' as const,
            kind: reference.kind,
            data: values.get(reference.evidenceId),
          })),
        );
      },
      [],
    );
    const requestMaterials = useCallback<NonNullable<PanelProps['onMaterialsChange']>>(
      (targets) => {
        if (!targets.length) {
          setMaterials([]);
          return;
        }
        const result = targets.map(({ event, reference }) => ({
          eventId: event.eventId,
          evidenceId: reference.evidenceId,
          contentVersion: reference.contentVersion,
          status: 'available' as const,
          kind: reference.kind,
          data: values.has(reference.evidenceId)
            ? values.get(reference.evidenceId)
            : {
                content: `EXACT ${reference.contentVersion}`,
                reasoning: `EXACT ${reference.contentVersion}`,
              },
          rawText: JSON.stringify(
            values.has(reference.evidenceId)
              ? values.get(reference.evidenceId)
              : {
                  content: `EXACT ${reference.contentVersion}`,
                  reasoning: `EXACT ${reference.contentVersion}`,
                },
          ),
        }));
        opened.push(result);
        setMaterials(result);
      },
      [],
    );
    update = (next) => {
      retained = next;
      setState(next);
    };
    return (
      <TrajectoryPanel
        state={state}
        onStateChange={update}
        events={[]}
        projection={
          held ? null : projectTrajectory(events, { atCursor: state.cursor, completePrefix: true })
        }
        integrity={options.integrity ?? integrity}
        errorCode={options.errorCode}
        mode={mode}
        playing={false}
        exhausted
        loading={held}
        newEventsAvailable={hint}
        onSeek={() => {}}
        onStep={() => {}}
        onPlay={() => {}}
        onPause={() => {}}
        onReturnToLatest={() => {
          latestReturns++;
        }}
        onMaterialsRetry={() => {
          retries++;
        }}
        onMaterialsChange={requestMaterials}
        onLoopMaterialsChange={withLoops ? requestLoopMaterials : undefined}
        loopMaterials={withLoops ? (foreign ? [] : loopMaterials) : undefined}
        onExpandedChildrenChange={captureChildren}
        relatedTrajectories={related}
        materials={
          foreign
            ? [
                {
                  eventId: events.at(-1)!.eventId,
                  evidenceId: 'foreign',
                  contentVersion: 'future-v9',
                  status: 'available',
                  text: 'FUTURE MATERIAL',
                },
              ]
            : materials
        }
      />
    );
  }
  return {
    opened,
    loopOpened,
    values,
    relatedTargets,
    retries: () => retries,
    latestReturns: () => latestReturns,
    state: () => retained,
    setState: (next: ViewState) => act(() => update(next)),
    render: (held = false, foreign = false, hint = false) => {
      root ??= createRoot(document.body);
      return act(() => root!.render(<Harness held={held} foreign={foreign} hint={hint} />));
    },
    remount: async () => {
      await act(() => root!.unmount());
      root = createRoot(document.body);
      await act(() => root!.render(<Harness />));
    },
  };
}
function node(id: string) {
  const nodes = [...document.querySelectorAll<HTMLElement>('[data-trajectory-node]')];
  const row =
    nodes.find((item) => item.dataset.trajectoryRow === id) ??
    nodes.find((item) => item.dataset.trajectoryNode === id);
  expect(row).toBeDefined();
  return row!;
}
function absent(id: string) {
  expect(
    [...document.querySelectorAll<HTMLElement>('[data-trajectory-node]')].some(
      (item) => item.dataset.trajectoryNode === id,
    ),
  ).toBe(false);
}
async function select(id: string) {
  await act(() => node(id).querySelector<HTMLButtonElement>('.trajectory-node-select')!.click());
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === label || item.getAttribute('aria-label') === label,
  );
  expect(button).toBeDefined();
  await act(() => button!.click());
}
async function tab(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeDefined();
  await act(() => {
    button!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    button!.click();
  });
}
async function openMenu(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.startsWith(label) || item.getAttribute('aria-label') === label,
  );
  expect(button).toBeDefined();
  await act(() =>
    button!.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 })),
  );
}
async function checkbox(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
    (item) => item.textContent === label,
  );
  expect(item).toBeDefined();
  await act(() => item!.click());
}
async function all() {
  await openMenu('更多轨迹操作');
  await checkbox('显示全部事件');
}
function detail() {
  return document.querySelector<HTMLElement>('[aria-label="选中节点详情"]')!;
}
function assertCleanDetailChrome(scope = detail()) {
  expect(scope.querySelector('.trajectory-detail-caption')).toBeNull();
  expect(scope.querySelector('.trajectory-material-source')).toBeNull();
  expect([...scope.querySelectorAll('dt')].map((item) => item.textContent)).not.toContain(
    '来源记录',
  );
  expect([...scope.querySelectorAll('summary')].map((item) => item.textContent)).not.toContain(
    '指令与上下文来源',
  );
  for (const notice of scope.querySelectorAll('.trajectory-material-notice'))
    expect(notice.textContent).not.toContain('原来源标识：');
}
function tabLabels() {
  const labels = [...detail().querySelectorAll('[role="tab"]')].map((item) => item.textContent);
  expect(labels).not.toContain('原始内容');
  return labels;
}
function assertThoughtOnly() {
  expect(tabLabels()).toEqual(['思考']);
  expect(detail().querySelector('.trajectory-detail-summary')).toBeNull();
  expect(detail().querySelector('.trajectory-detail-timing')).toBeNull();
  expect(detail().querySelector('.trajectory-request-usage')).toBeNull();
}

test('old reference-backed loops expose exact system, user context, reasoning and output without inventing message events', async () => {
  const f = facts();
  const planned = f.events.find(
    (event) => event.executionId === 'retry' && event.phase === 'planned',
  )!;
  planned.evidenceRefs.push(material('retry-input', 'model_input'));
  for (const event of f.events)
    if (event.kind === 'model') event.attributes.definitionId = 'model-opaque-binding';
  const original = JSON.stringify(f.events);
  const h = harness(f.events, f.events.at(-1)!.sequence, true);
  h.values.set('retry-input', {
    request: {
      modelId: 'model-opaque-binding',
      messages: [
        { role: 'system', content: '准确系统指令：保留权限检查。' },
        { role: 'system', content: '第二条系统指令：只核对原始证据。' },
        { role: 'user', content: '用户原文：请检查登录跳转。' },
        {
          role: 'user',
          content: '第二条用户上下文：保留当前阅读位置。原来源标识：这段属于用户正文。',
        },
      ],
      tools: [
        {
          id: 'files.read',
          definitionVersion: 'fixture-public-version',
          description: '读取公开文件内容。',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    },
    metadata: {
      adapter: {
        availability: 'available',
        provider: { availability: 'available', modelId: 'actual-provider-model' },
      },
    },
  });
  h.values.set('input', {
    request: {
      modelId: 'model-opaque-binding',
      messages: [
        { role: 'user', content: '首次请求用户原文。' },
        { role: 'user', content: '首次请求第二条上下文。' },
      ],
      tools: [],
    },
  });
  h.values.set('retry-result', {
    content: 'Agent 原输出：登录跳转已核对。',
    reasoning: '已保存思考：先核对来源，再检查守卫。',
    reasoning_encrypted: 'PRIVATE-ENCRYPTED-SENTINEL',
    toolCalls: [],
    complete: true,
  });
  await h.render();
  const row = (part: string) =>
    document.querySelector<HTMLElement>(`[data-trajectory-row="execution:model:part:${part}"]`)!;
  expect(document.querySelector('[data-trajectory-row="execution:model"]')).toBeNull();
  expect(document.body.textContent).not.toContain('决策步骤');
  expect(row('thinking').textContent).toContain('actual-provider-model');
  expect(row('system').textContent).toContain('准确系统指令');
  expect(row('input').textContent).toContain('用户原文');
  expect(row('thinking').textContent).toContain('已保存思考');
  expect(row('reply').textContent).toContain('Agent 原输出');
  for (const part of ['system', 'input', 'thinking', 'reply']) {
    expect(row(part).dataset.trajectoryParent).toBe('run:run');
    expect(row(part).dataset.depth).toBe(node('execution:tool').dataset.depth);
    expect(row(part).querySelector('.trajectory-node-collapse')).toBeNull();
  }
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  expect(h.opened).toHaveLength(0);
  expect([
    ...new Set(
      h.loopOpened.flatMap((targets) => targets.map((target) => target.reference.evidenceId)),
    ),
  ]).toEqual(['retry-input', 'retry-result']);
  for (const part of ['system', 'input', 'thinking', 'reply']) {
    await act(() => row(part).querySelector<HTMLButtonElement>('.trajectory-node-select')!.click());
    expect(h.state().selectedNodeId).toBe(`execution:model:part:${part}`);
    expect(detail().textContent).not.toContain('PRIVATE-ENCRYPTED-SENTINEL');
    expect(detail().textContent).not.toContain('不在当前筛选结果');
    expect(detail().querySelector('dt')?.textContent).not.toBe('父级');
    assertCleanDetailChrome();
    if (part === 'system' || part === 'input') {
      const second =
        part === 'system'
          ? '第二条系统指令：只核对原始证据。'
          : '第二条用户上下文：保留当前阅读位置。';
      const triggers = detail().querySelectorAll('[data-slot="accordion-trigger"]');
      expect(triggers).toHaveLength(part === 'system' ? 1 : 2);
      expect(triggers[0]!.getAttribute('aria-expanded')).toBe('true');
      expect(detail().textContent).not.toContain('来源 #');
      expect(detail().querySelector('.trajectory-material-source')).toBeNull();
      const reads = h.opened.length;
      if (part === 'system') {
        expect(triggers[0]!.textContent).toBe('系统提示词');
        expect(detail().textContent).toContain('准确系统指令：保留权限检查。');
        expect(detail().textContent).toContain(second);
        await act(() => (triggers[0] as HTMLButtonElement).click());
        expect(detail().textContent).not.toContain(second);
        await act(() => (triggers[0] as HTMLButtonElement).click());
        expect(detail().textContent).toContain(second);
        expect(detail().textContent!.indexOf('准确系统指令')).toBeLessThan(
          detail().textContent!.indexOf(second),
        );
      } else {
        expect(triggers[1]!.getAttribute('aria-expanded')).toBe('false');
        expect(detail().textContent).not.toContain(second);
        await click('用户上下文 · 2');
        expect(detail().textContent).toContain(second);
        expect(detail().textContent).toContain('原来源标识：这段属于用户正文。');
        expect(triggers[0]!.getAttribute('aria-expanded')).toBe('true');
        expect(triggers[1]!.getAttribute('aria-expanded')).toBe('true');
        await click('用户上下文 · 1');
        expect(triggers[0]!.getAttribute('aria-expanded')).toBe('false');
        expect(detail().textContent).toContain(second);
        await click('用户上下文 · 2');
        expect(detail().textContent).not.toContain(second);
      }
      expect(h.opened).toHaveLength(reads);
      expect(h.state().selectedNodeId).toBe(`execution:model:part:${part}`);
      if (part === 'system') {
        await tab('工具');
        assertCleanDetailChrome();
        expect(detail().textContent).toContain('files.read');
        expect(detail().textContent).not.toContain('来源 #');
        expect(detail().querySelector('[aria-label="轨迹证据"]')?.getAttribute('title')).toBe(
          '材料版本：retry-input-version',
        );
        const tool =
          detail().querySelector<HTMLDetailsElement>('.trajectory-request-tool') ??
          detail().querySelector<HTMLDetailsElement>('[aria-label="工具定义"] details');
        expect(tool).not.toBeNull();
        const reads = h.opened.length;
        await act(async () => {
          tool!.querySelector('summary')!.click();
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
        expect(detail().querySelector('[aria-label="原公开 JSON"]')?.textContent).toContain('path');
        expect(h.opened).toHaveLength(reads);
      }
    }
  }
  expect(detail().textContent).toContain('Agent 原输出');
  await select('execution:model:part:input');
  await click('用户上下文 · 2');
  expect(detail().textContent).toContain('第二条用户上下文');
  await h.setState({ ...h.state(), selectedObservationId: f.input.eventId });
  expect(detail().textContent).toContain('首次请求用户原文');
  expect(detail().textContent).not.toContain('首次请求第二条上下文');
  expect(detail().textContent).not.toContain('第二条用户上下文');
  expect(
    detail().querySelectorAll('[data-slot="accordion-trigger"]')[0]!.getAttribute('aria-expanded'),
  ).toBe('true');
  expect(
    detail().querySelectorAll('[data-slot="accordion-trigger"]')[1]!.getAttribute('aria-expanded'),
  ).toBe('false');
  expect(h.opened.at(-1)!.map((material) => [material.eventId, material.contentVersion])).toEqual([
    [f.input.eventId, 'input-version'],
  ]);
  const reads = h.opened.length;
  await click('用户上下文 · 2');
  expect(detail().textContent).toContain('首次请求第二条上下文');
  expect(h.opened).toHaveLength(reads);
  expect(JSON.stringify(f.events)).toBe(original);
  expect(f.events.some((event) => event.kind === 'message')).toBe(false);
});

test('request dots keep record rows stable and open exact current, historical and child request information', async () => {
  const f = facts();
  if (f.retry.kind !== 'model') throw Error('expected original Model output');
  f.retry.attributes.usage = {
    inputTokens: '8086',
    outputTokens: '320',
    cachedInputTokens: '0',
    totalTokens: '8406',
  };
  for (const event of f.events) {
    event.runOriginStoreId = 'store';
    if (event.executionId) event.executionOriginStoreId = 'store';
    if (event.parentExecutionId) event.parentExecutionOriginStoreId = 'store';
    event.occurredAt = Number(event.sequence) * 100;
  }
  const planned = f.events.find(
    (event) => event.executionId === 'retry' && event.phase === 'planned',
  )!;
  planned.evidenceRefs.push(material('dot-retry-input', 'model_input'));
  const carrier = f.events.find((event) => event.kind === 'job')!;
  if (carrier.kind !== 'job') throw Error('expected original carrier');
  carrier.attributes.display = { kind: 'task', targetSessionId: 'child', targetRunId: 'child-run' };
  const make = (n: number, values: Record<string, unknown>): TrajectoryEvent =>
    trajectoryEventSchema.parse({
      ...f.retry,
      sequence: String(n),
      origin: { storeId: 'store', cursor: String(n) },
      eventId: `te_${n.toString(16).padStart(64, '0')}`,
      sourceRecordRevision: String(n),
      occurredAt: n * 100,
      parentExecutionId: undefined,
      parentExecutionOriginStoreId: undefined,
      ...values,
    });
  const secondInput = make(20, {
    executionId: 'next-model',
    phase: 'planned',
    recordedStatus: 'planned',
    attributes: { definitionId: 'respond' },
    evidenceRefs: [material('dot-second-input', 'model_input')],
  });
  const secondOutput = make(21, {
    executionId: 'next-model',
    attributes: { definitionId: 'respond' },
    evidenceRefs: [material('dot-second-output', 'model_output')],
  });
  f.events.push(secondInput, secondOutput);
  const childRun = make(16, {
    kind: 'run',
    sessionId: 'child',
    runId: 'child-run',
    executionId: undefined,
    attributes: {},
    evidenceRefs: [],
  });
  const childInput = make(17, {
    sessionId: 'child',
    runId: 'child-run',
    executionId: 'child-model',
    phase: 'planned',
    recordedStatus: 'planned',
    attributes: { definitionId: 'respond' },
    evidenceRefs: [material('dot-child-input', 'model_input')],
  });
  const childOutput = make(18, {
    sessionId: 'child',
    runId: 'child-run',
    executionId: 'child-model',
    attributes: { definitionId: 'respond' },
    evidenceRefs: [material('dot-child-output', 'model_output')],
  });
  const h = harness(f.events, '21', true, [
    {
      parentNodeId: 'execution:carrier',
      projection: projectTrajectory([childRun, childInput, childOutput], {
        atCursor: '21',
        completePrefix: true,
      }),
    },
  ]);
  const input = (label: string, family?: string) => ({
    request: {
      modelId: 'opaque-binding',
      messages: [
        { role: 'system', content: `${label} system` },
        { role: 'user', content: `${label} user` },
      ],
      tools: [],
    },
    metadata: {
      adapter: {
        availability: 'available',
        provider: family
          ? { availability: 'available', family, modelId: `${label}-actual-model` }
          : { availability: 'unavailable' },
      },
    },
  });
  h.values.set('input', input('initial', 'initial-provider'));
  h.values.set('dot-retry-input', input('retry', 'retry-provider'));
  h.values.set('dot-second-input', input('second'));
  h.values.set('dot-child-input', input('child', 'child-provider'));
  for (const [id, label] of [
    ['prefix', 'initial'],
    ['retry-result', 'retry'],
    ['dot-second-output', 'second'],
    ['dot-child-output', 'child'],
  ])
    h.values.set(id!, {
      content: `${label} output`,
      reasoning: `${label} thought`,
      toolCalls: [],
      complete: id !== 'prefix',
    });
  const original = JSON.stringify(f.events);
  await h.render();
  const markers = () => [
    ...document.querySelectorAll<HTMLButtonElement>('.trajectory-request-marker'),
  ];
  const marker = (owner: string) =>
    document.querySelector<HTMLButtonElement>(
      `.trajectory-request-marker[data-request-owner="${owner}"]`,
    )!;
  const requestDetail = () => document.querySelector<HTMLElement>('[aria-label="模型请求详情"]')!;
  const requestTabs = () =>
    [...requestDetail().querySelectorAll('[role="tab"]')].map((item) => item.textContent);
  expect(markers().map((button) => button.dataset.requestOwner)).toEqual([
    'execution:model',
    'execution:next-model',
  ]);
  expect(
    marker('execution:model').closest('[data-trajectory-row]')?.getAttribute('data-trajectory-row'),
  ).toBe(thinkingId);
  const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 2000 });
  await act(() => {
    viewport.scrollTop = 83;
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  const rows = () =>
    [...document.querySelectorAll<HTMLElement>('[data-trajectory-row]')].map((row) => [
      row.dataset.trajectoryRow,
      row.dataset.trajectoryParent,
      row.dataset.depth,
    ]);
  const before = rows();
  await act(() => marker('execution:model').click());
  expect(h.state().selectedNodeId).toBe('execution:model');
  expect(h.state().selectedRequestId).toBe('execution:model');
  expect(h.state().requestTab).toBe('overview');
  expect(requestTabs()).toEqual(['概述', '选项', '用量', '计时']);
  expect(detail()).toBeNull();
  expect(requestDetail().querySelector('[aria-label="关闭请求详情"]')).not.toBeNull();
  expect(h.opened.at(-1)!.map((view) => view.evidenceId)).toEqual([
    'dot-retry-input',
    'retry-result',
  ]);
  expect(requestDetail().textContent).toContain('retry-provider');
  expect(requestDetail().textContent).toContain('retry-actual-model');
  expect(requestDetail().textContent).toContain('已完成');
  await tab('选项');
  expect(h.state().requestTab).toBe('options');
  expect(h.opened.at(-1)!.map((view) => view.evidenceId)).toEqual(['dot-retry-input']);
  const metadataReads = h.opened.length;
  await tab('用量');
  expect(h.state().requestTab).toBe('usage');
  expect(requestDetail().textContent).toContain('8086');
  expect(requestDetail().textContent).toContain('8406');
  expect([...requestDetail().querySelectorAll('dd')].map((item) => item.textContent)).toContain(
    '0',
  );
  expect(h.opened).toHaveLength(metadataReads);
  await h.setState({ ...h.state(), detailScrollTop: 37 });
  await h.render(true);
  expect(h.state().selectedRequestId).toBe('execution:model');
  expect(h.state().selectedNodeId).toBe('execution:model');
  expect(h.state().requestTab).toBe('usage');
  expect(requestDetail()).toBeNull();
  expect(document.body.textContent).toContain('正在读取所选记录');
  await h.render();
  expect(requestTabs()).toEqual(['概述', '选项', '用量', '计时']);
  expect(requestDetail().textContent).toContain('8086');
  expect(requestDetail().querySelector<HTMLElement>('[aria-label="请求详情正文"]')!.scrollTop).toBe(
    37,
  );
  expect(h.opened).toHaveLength(metadataReads);
  await tab('计时');
  expect(h.state().requestTab).toBe('timing');
  expect(h.opened).toHaveLength(metadataReads);
  expect(requestDetail().textContent).toContain('已记录请求区间');
  expect(requestDetail().textContent).toContain('100 毫秒');
  await tab('概述');
  await h.render(false, true);
  expect(requestDetail().textContent).not.toContain('FUTURE MATERIAL');
  const unavailableCalls = [...requestDetail().querySelectorAll('dt')].find(
    (item) => item.textContent === '发起工具请求',
  )?.nextElementSibling?.textContent;
  expect(unavailableCalls).not.toBe('0');
  expect(unavailableCalls).toMatch(/读取|未保存/u);
  await h.render();
  expect(rows()).toEqual(before);
  expect(document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!.scrollTop).toBe(83);
  await act(() =>
    requestDetail()
      .querySelector<HTMLElement>('details.trajectory-request-retries > summary')!
      .click(),
  );
  const firstAttempt = [
    ...requestDetail().querySelectorAll<HTMLButtonElement>(
      'details.trajectory-request-retries button',
    ),
  ].find((button) => button.textContent?.startsWith('首次请求'))!;
  expect(firstAttempt).toBeDefined();
  await act(() => firstAttempt.click());
  expect(h.state().selectedObservationId).toBe(f.failed.eventId);
  expect(
    h.opened.at(-1)!.map((view) => [view.eventId, view.evidenceId, view.contentVersion]),
  ).toEqual([
    [f.input.eventId, 'input', 'input-version'],
    [f.failed.eventId, 'prefix', 'prefix-v1'],
  ]);
  expect(requestDetail().textContent).toContain('initial-provider');
  expect(requestDetail().textContent).not.toContain('retry-provider');
  await tab('用量');
  const historicalReads = h.opened.length;
  expect(requestDetail().textContent).toContain('未记录');
  await act(() => marker('execution:model').click());
  expect(h.state().selectedObservationId).toBe(f.failed.eventId);
  expect(h.state().requestTab).toBe('usage');
  expect(h.opened).toHaveLength(historicalReads);
  await tab('计时');
  expect(requestDetail().textContent).toContain('200 毫秒');
  expect(h.opened).toHaveLength(historicalReads);
  await tab('概述');
  expect(requestDetail().textContent).toContain('initial-actual-model');
  await select('execution:model:part:system');
  expect(h.state().selectedRequestId).toBeNull();
  expect(requestDetail()).toBeNull();
  expect(detail().textContent).toContain('retry system');
  expect(detail().textContent).not.toContain('second system');
  expect(h.opened.at(-1)!.map((view) => view.evidenceId)).toEqual(['dot-retry-input']);
  await act(() => marker('execution:model').click());
  await h.setState({ ...h.state(), selectedObservationId: f.failed.eventId });
  await act(() => marker('execution:next-model').click());
  expect(h.state().selectedNodeId).toBe('execution:next-model');
  expect(h.state().selectedRequestId).toBe('execution:next-model');
  expect(h.state().selectedObservationId).toBeNull();
  expect(h.state().requestTab).toBe('overview');
  expect(h.opened.at(-1)!.map((view) => view.evidenceId)).toEqual([
    'dot-second-input',
    'dot-second-output',
  ]);
  expect(requestDetail().textContent).not.toContain('retry-provider');
  await tab('用量');
  const unknownReads = h.opened.length;
  expect(requestDetail().textContent).toContain('未记录');
  await act(() => marker('execution:next-model').click());
  expect(h.opened).toHaveLength(unknownReads);
  await click('关闭请求详情');
  expect(requestDetail()).toBeNull();
  expect(document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!.scrollTop).toBe(83);
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(document.activeElement).toBe(marker('execution:next-model'));
  await select(thinkingId);
  assertThoughtOnly();
  await click('关闭节点详情');
  expect(rows()).toEqual(before);
  await openMenu('筛选轨迹');
  await checkbox('思考');
  expect(markers()).toHaveLength(0);
  expect(node('execution:tool')).toBeDefined();
  await click('清除筛选');
  expect(markers()).toHaveLength(2);
  await act(() =>
    node('execution:carrier')
      .querySelector<HTMLButtonElement>('.trajectory-node-collapse')!
      .click(),
  );
  const childMarker = markers().find((button) =>
    button.dataset.requestOwner?.endsWith('execution:child-model'),
  );
  expect(childMarker).toBeDefined();
  expect(markers()).toHaveLength(3);
  expect(
    childMarker!.closest('[data-trajectory-row]')?.getAttribute('data-trajectory-parent'),
  ).not.toBe('run:run');
  await act(() => childMarker!.click());
  expect(h.state().selectedNodeId).toBe(childMarker!.dataset.requestOwner);
  expect(h.state().selectedRequestId).toBe(childMarker!.dataset.requestOwner);
  expect(h.state().selectedRelatedScope?.sessionId).toBe('child');
  expect(h.state().selectedRelatedScope?.runId).toBe('child-run');
  expect(h.opened.at(-1)!.map((view) => [view.eventId, view.evidenceId])).toEqual([
    [childInput.eventId, 'dot-child-input'],
    [childOutput.eventId, 'dot-child-output'],
  ]);
  expect(requestDetail().textContent).toContain('child-provider');
  expect(requestDetail().textContent).not.toContain('retry-provider');
  for (const row of before) expect(rows()).toContainEqual(row);
  expect(JSON.stringify(f.events)).toBe(original);
});

test('restored child selections request only a currently proven carrier and wait through missing parent facts', async () => {
  const f = facts();
  const carrier = f.events.find((event) => event.kind === 'job')!;
  carrier.executionOriginStoreId = 'store';
  if (carrier.kind === 'job')
    carrier.attributes.display = {
      kind: 'task',
      targetSessionId: 'child',
      targetRunId: 'child-run',
    };
  const h = harness(f.events);
  await h.render();
  const retained = {
    nodeId: 'related-child-tool',
    parentNodeId: 'execution:carrier',
    sessionId: 'child',
    runId: 'child-run',
  };
  await h.setState({
    ...h.state(),
    detailOpen: true,
    selectedNodeId: retained.nodeId,
    selectedRelatedScope: retained,
    collapsedNodeIds: ['execution:carrier'],
  });
  expect(h.relatedTargets.at(-1)).toEqual([
    {
      parentNodeId: retained.parentNodeId,
      sessionId: retained.sessionId,
      runId: retained.runId,
      carrierExecutionId: carrier.executionId,
    },
  ]);
  await h.render(true);
  expect(h.relatedTargets.at(-1)).toEqual([]);
  expect(h.state().selectedRelatedScope).toEqual(retained);
  await h.render();
  expect(h.relatedTargets.at(-1)).toHaveLength(1);
  await h.setState({
    ...h.state(),
    selectedRelatedScope: { ...retained, sessionId: 'old-child-session' },
  });
  expect(h.relatedTargets.at(-1)).toEqual([]);
  expect(h.opened).toHaveLength(0);
});

test('ordinary Agent phases are sibling leaves while the proven child Agent alone expands a nested loop', async () => {
  const f = facts();
  f.events.push(
    trajectoryEventSchema.parse({
      ...f.tool,
      sequence: '20',
      eventId: `te_${'8'.repeat(64)}`,
      kind: 'model',
      executionId: 'compression',
      parentExecutionId: 'retry',
      attributes: {
        definitionId: 'compress',
        compressionId: 'cmp-flat',
        compressionTrigger: 'automatic',
      },
      evidenceRefs: [],
    }),
  );
  for (const [offset, role] of ['user', 'assistant'].entries())
    f.events.push(
      trajectoryEventSchema.parse({
        ...f.tool,
        sequence: String(21 + offset),
        eventId: `te_${String(6 + offset).repeat(64)}`,
        kind: 'message',
        executionId: role === 'assistant' ? 'retry' : undefined,
        parentExecutionId: undefined,
        attributes: {
          messageId: `flat-${role}`,
          role,
          messageSeq: String(21 + offset),
          revision: '1',
          status: 'complete',
        },
        evidenceRefs: [material(`flat-${role}`, 'message')],
      }),
    );
  f.events = f.events.map((event) => ({
    ...event,
    sequence: String(Number(event.sequence) * 10),
    origin: { ...event.origin, cursor: String(Number(event.sequence) * 10) },
  }));
  const carrier = f.events.find((event) => event.kind === 'job')!;
  carrier.executionOriginStoreId = 'store';
  if (carrier.kind !== 'job') throw Error('expected carrier');
  carrier.attributes.display = { kind: 'task', targetSessionId: 'child', targetRunId: 'child-run' };
  const child = ['run', 'tool'].map((kind, index) =>
    trajectoryEventSchema.parse({
      ...carrier,
      sequence: String(111 + index),
      origin: { storeId: 'store', cursor: String(111 + index) },
      eventId: `te_${'9'.repeat(63)}${index}`,
      sessionId: 'child',
      runId: 'child-run',
      runOriginStoreId: 'store',
      kind,
      executionId: index ? 'child-tool' : undefined,
      parentExecutionId: undefined,
      attributes: index ? { definitionId: 'child_work' } : {},
      evidenceRefs: [],
    }),
  );
  const original = JSON.stringify(f.events),
    upper = f.events.at(-1)!.sequence;
  const h = harness(f.events, upper, false, [
    {
      parentNodeId: 'execution:carrier',
      projection: projectTrajectory(child, { atCursor: upper, completePrefix: true }),
    },
  ]);
  await h.render();
  expect(document.body.textContent).not.toContain('决策步骤');
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  for (const id of [
    'execution:model:part:system',
    thinkingId,
    'execution:tool',
    'interaction:approval',
    'execution:compression',
    'message:flat-user',
    'message:flat-assistant',
  ]) {
    expect(node(id).dataset.trajectoryParent).toBe('run:run');
    expect(Number(node(id).dataset.depth)).toBe(Number(node('run:run').dataset.depth) + 1);
    expect(node(id).querySelector('.trajectory-node-collapse')).toBeNull();
    expect(node(id).closest('tr')!.hasAttribute('aria-expanded')).toBe(false);
  }
  const findChild = () =>
    [...document.querySelectorAll<HTMLElement>('[data-trajectory-node]')].find((item) =>
      item.dataset.trajectoryNode?.endsWith('execution:child-tool'),
    );
  expect(findChild()).toBeUndefined();
  const expand = node('execution:carrier').querySelector<HTMLButtonElement>(
    '.trajectory-node-collapse',
  )!;
  expect(expand).not.toBeNull();
  await act(() => expand.click());
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  const childTool = findChild();
  expect(childTool).toBeDefined();
  const childRun = [...document.querySelectorAll<HTMLElement>('[data-trajectory-node]')].find(
    (item) => item.dataset.trajectoryNode?.endsWith('run:child-run'),
  )!;
  expect(childRun.dataset.trajectoryParent).toBe('execution:carrier');
  expect(childTool!.dataset.trajectoryParent).toBe(childRun.dataset.trajectoryRow);
  expect(Number(childTool!.dataset.depth)).toBeGreaterThan(
    Number(node('execution:tool').dataset.depth),
  );
  expect(childTool!.querySelector('.trajectory-node-collapse')).toBeNull();
  await act(() =>
    node('execution:carrier')
      .querySelector<HTMLButtonElement>('.trajectory-node-collapse')!
      .click(),
  );
  expect(findChild()).toBeUndefined();
  expect(node('execution:tool')).toBeDefined();
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  expect(node('execution:carrier').querySelector('.trajectory-row-secondary')?.textContent).toBe(
    '内部：1 个工具操作',
  );
  expect(JSON.stringify(f.events)).toBe(original);
});

test('retained Model selection and timeline navigation resolve to the thinking stage without restoring a decision wrapper', async () => {
  const f = facts(),
    h = harness(f.events);
  await h.render();
  await h.setState({
    ...h.state(),
    selectedNodeId: 'execution:model',
    detailOpen: true,
    workbenchTab: 'preview',
  });
  assertThoughtOnly();
  expect(detail().textContent).toContain('EXACT retry-result-version');
  expect(document.querySelector('[data-trajectory-row="execution:model"]')).toBeNull();
  expect(
    node(thinkingId).querySelector('.trajectory-node-select')!.getAttribute('aria-pressed'),
  ).toBe('true');
  const restoredReads = h.opened.length;
  await h.setState({ ...h.state(), workbenchTab: 'request_info' });
  assertThoughtOnly();
  expect(document.querySelector('[aria-label="模型请求详情"]')).toBeNull();
  expect(detail().textContent).toContain('EXACT retry-result-version');
  expect(h.opened).toHaveLength(restoredReads);
  await select('execution:tool');
  const marker = document.querySelector<HTMLButtonElement>(
    '[data-trajectory-marker="execution:model"]',
  )!;
  expect(marker).not.toBeNull();
  await act(() => marker.click());
  expect(h.state().selectedNodeId).toBe(thinkingId);
  assertThoughtOnly();
  expect(detail().textContent).toContain('EXACT retry-result-version');
  expect(document.body.textContent).not.toContain('决策步骤');
  expect(marker.getAttribute('aria-pressed')).toBe('true');
});

test('retained Model folding aliases and expansion state preserve flat phases, selected material and child choices', async () => {
  const f = facts(),
    h = harness(f.events);
  await h.render();
  expect(document.body.textContent).not.toContain('项匹配');
  expect(document.body.textContent).not.toContain('固定上界');
  expect(document.body.textContent?.match(/找到 \d+ 项/g) ?? []).toEqual([]);
  await select(thinkingId);
  const reads = h.opened.length;
  const parts = ['system', 'input', 'reply'].map((part) => `execution:model:part:${part}`);
  const assertPhases = (visible: boolean) => {
    for (const id of parts) {
      const row = document.querySelector<HTMLElement>(`[data-trajectory-row="${id}"]`);
      if (!visible) {
        expect(row).toBeNull();
        continue;
      }
      expect(row).not.toBeNull();
      expect(row!.dataset.trajectoryParent).toBe('run:run');
      expect(row!.dataset.depth).toBe(node(thinkingId).dataset.depth);
      expect(row!.querySelector('.trajectory-node-collapse')).toBeNull();
    }
    expect(node(thinkingId).querySelector('.trajectory-node-collapse')).toBeNull();
    expect(document.querySelector('[data-trajectory-row="execution:model"]')).toBeNull();
    expect(document.body.textContent).not.toContain('决策步骤');
    expect(node('execution:tool')).toBeDefined();
    expect(detail().textContent).toContain('EXACT retry-result-version');
  };
  for (const alias of ['execution:model', 'execution:retry', thinkingId]) {
    await h.setState({
      ...h.state(),
      expansion: { rounds: true, calls: false, subcalls: false },
      collapsedNodeIds: [alias, 'execution:carrier'],
      expandedNodeIds: [],
    });
    assertPhases(false);
    await h.setState({
      ...h.state(),
      expansion: { ...h.state().expansion!, calls: true },
    });
    assertPhases(false);
    expect(h.state().collapsedNodeIds).toContain(alias);
    expect(h.state().collapsedNodeIds).toContain('execution:carrier');
    await h.setState({ ...h.state(), collapsedNodeIds: ['execution:carrier'] });
    assertPhases(true);
    await h.setState({
      ...h.state(),
      expansion: { rounds: true, calls: false, subcalls: false },
      collapsedNodeIds: ['execution:carrier'],
      expandedNodeIds: [alias],
    });
    assertPhases(true);
    await h.setState({ ...h.state(), expandedNodeIds: [] });
    assertPhases(false);
    expect(h.state().collapsedNodeIds).toContain('execution:carrier');
    await h.setState({
      ...h.state(),
      expansion: { ...h.state().expansion!, calls: true },
    });
    assertPhases(true);
  }
  expect(h.opened).toHaveLength(reads);
  expect(h.state().selectedNodeId).toBe(thinkingId);
});

test('workbench opens metadata first, preserves original parentage and exposes typed tabs without lifecycle UI', async () => {
  const f = facts(),
    h = harness(f.events);
  await h.render();
  expect(document.querySelector('[aria-label="选中节点详情"]')).toBeNull();
  expect(h.opened).toHaveLength(0);
  expect(document.querySelector('[role="treegrid"]')).not.toBeNull();
  expect(node('execution:tool').dataset.trajectoryParent).toBe('run:run');
  expect(node('interaction:approval').dataset.trajectoryParent).toBe('run:run');
  const originalTree = buildTrajectoryTree(
    projectTrajectory(f.events, { atCursor: f.events.at(-1)!.sequence }),
    [],
  );
  expect(originalTree.byId.get('execution:tool')!.parentId).toBe('execution:retry');
  expect(originalTree.byId.get('interaction:approval')!.parentId).toBe('execution:tool');
  await select(thinkingId);
  assertThoughtOnly();
  expect(h.opened).toHaveLength(1);
  await tab('思考');
  expect(detail().textContent).toContain('EXACT retry-result-version');
  expect(h.opened.at(-1)!.map((value) => value.eventId)).toEqual([f.retry.eventId]);
  expect(document.querySelectorAll('[data-trajectory-row="execution:retry"]')).toHaveLength(0);
  expect(f.tool.parentExecutionId).toBe('retry');
  expect(document.querySelector('[role="tab"][data-value="lifecycle"]')).toBeNull();
  expect(
    [...document.querySelectorAll('[role="tab"]')].some(
      (value) => value.textContent === '生命周期',
    ),
  ).toBe(false);
  await select('execution:tool');
  expect(tabLabels()).toEqual(['概述', '参数', '结果']);
  expect(h.state().workbenchTab).toBe('overview');
  const recordInfo = [...detail().querySelectorAll('details')].find(
    (item) => item.querySelector('summary')?.textContent === '记录信息',
  );
  expect(recordInfo).toBeUndefined();
  assertCleanDetailChrome();
  await tab('参数');
  expect(detail().textContent).toContain('未封存该次执行请求 JSON');
  await tab('结果');
  expect(detail().textContent).toContain('EXACT tool-result-version');
  assertCleanDetailChrome();
  expect(detail().querySelector('[aria-label="轨迹证据"]')?.getAttribute('title')).toBe(
    '材料版本：tool-result-version',
  );
  await select('execution:carrier');
  expect(tabLabels()).toEqual(['概述', '预览']);
  expect(h.state().workbenchTab).toBe('overview');
  await all();
  await select(`event:${f.unknown.eventId}`);
  assertCleanDetailChrome();
  expect(node(`event:${f.unknown.eventId}`).textContent).toContain('未识别事件');
  expect(h.state().selectedObservationId).toBe(f.unknown.eventId);
  expect(tabLabels()).toEqual(['概述']);
});

test('tool parameters preserve null, arrays and empty objects, typed shell output remains read only', async () => {
  const f = facts();
  f.events
    .find((event) => event.kind === 'tool' && event.phase === 'planned')!
    .evidenceRefs.push(material('params', 'tool_input'));
  const h = harness(f.events);
  h.values.set('params', null);
  h.values.set('tool-result', {
    outcome: 'succeeded',
    content: 'original receipt',
    presentation: {
      kind: 'shell',
      operation: 'launch',
      accepted: true,
      stdout: 'original stdout',
      stderr: 'original stderr',
      exitCode: 0,
      output: [
        { sequence: '1', throughSequence: '2', stream: 'gap', content: '', droppedBytes: '9' },
      ],
    },
  });
  await h.render();
  await select('execution:tool');
  await tab('参数');
  expect(detail().querySelector('pre')!.textContent).toBe('null');
  await tab('结果');
  expect(detail().textContent).toContain('original stdout');
  expect(detail().textContent).toContain('输出缺失');
  expect(detail().textContent).toContain('接纳回执不表示后台任务已经完成');
  expect(
    [...detail().querySelectorAll('button')].some((button) =>
      /执行|批准|重跑/.test(button.textContent ?? ''),
    ),
  ).toBe(false);
  await tab('参数');
  expect(detail().querySelector('pre')!.textContent).toBe('null');
  expect(h.opened.at(-1)!.some((view) => view.kind === 'tool_input')).toBe(true);
  expect(h.opened.at(-1)!.every((view) => view.kind === 'tool_input')).toBe(true);
  h.values.set('params', []);
  await tab('结果');
  await tab('参数');
  expect(detail().querySelector('pre')!.textContent).toBe('[]');
  h.values.set('params', {});
  await tab('概述');
  await tab('参数');
  expect(detail().querySelector('pre')!.textContent).toBe('{}');
});

test('filters use AND, empty sets remain empty, excluded selection retains its exact version and material', async () => {
  const f = facts(),
    h = harness(f.events);
  await h.render();
  await select(thinkingId);
  await tab('思考');
  const reads = h.opened.length;
  await openMenu('筛选轨迹');
  await checkbox('思考');
  expect(h.state().filters!.types).not.toContain('model');
  expect(document.body.textContent?.match(/找到 \d+ 项/g)).toHaveLength(1);
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  expect(document.querySelector(`[data-trajectory-row="${thinkingId}"]`)).toBeNull();
  expect(document.querySelector('[data-trajectory-row="execution:model"]')).toBeNull();
  expect(detail().textContent).toContain('此记录不在当前筛选结果中');
  expect(detail().textContent).toContain('EXACT retry-result-version');
  expect(h.opened).toHaveLength(reads);
  await click('清除筛选');
  expect(node(thinkingId)).toBeDefined();
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  expect(h.opened).toHaveLength(reads);
  expect(h.state().selectedNodeId).toBe(thinkingId);
  const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
  await act(() => {
    viewport.scrollTop = 83;
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  const selectedObservation = h.state().selectedObservationId;
  for (const previous of [
    { duration: 'observed_ge_1s', runKeys: [], subcalls: 'child' },
    { duration: 'observed_ge_5s', runKeys: ['missing-run'], subcalls: 'root' },
    { duration: 'unknown', runKeys: [], subcalls: 'child' },
  ] as const) {
    await h.setState({ ...h.state(), filters: { ...h.state().filters!, ...previous } });
    expect(node(thinkingId)).toBeDefined();
    expect(node('execution:tool')).toBeDefined();
    expect(node('execution:carrier')).toBeDefined();
    expect(document.body.textContent).not.toContain('没有匹配记录');
    expect(document.querySelector('[aria-label="当前筛选"]')).toBeNull();
    expect(document.body.textContent?.match(/找到 \d+ 项/g) ?? []).toEqual([]);
    expect(h.state().selectedNodeId).toBe(thinkingId);
    expect(h.state().selectedObservationId).toBe(selectedObservation);
    expect(h.state().workbenchTab).toBe('thinking');
    expect(detail().textContent).toContain('EXACT retry-result-version');
    expect(viewport.scrollTop).toBe(83);
    expect(h.opened).toHaveLength(reads);
  }
  await openMenu('筛选轨迹');
  expect(
    [...document.querySelectorAll('[role="menuitemcheckbox"]')].map((item) => item.textContent),
  ).toEqual(['消息', '思考', '工具', '自动压缩', '审批', '子 Agent']);
  await checkbox('思考');
  expect(h.state().filters!.duration).toBe('all');
  expect(h.state().filters!.runKeys).toBeNull();
  expect(h.state().filters!.subcalls).toBe('all');
  expect(h.state().filters!.types).not.toContain('model');
  absent(thinkingId);
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索元数据"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      search,
      'not-present',
    );
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  // React's controlled input behavior is additionally covered through the public pure filter state.
  await h.setState({
    ...h.state(),
    filters: { ...h.state().filters!, metadataQuery: 'not-present' },
  });
  expect(document.body.textContent).toContain('没有匹配记录');
  expect(document.body.textContent?.match(/找到 0 项/g)).toHaveLength(1);
  expect(h.state().filters!.types).not.toContain('model');
  expect(detail().textContent).toContain('EXACT retry-result-version');
  expect(h.opened).toHaveLength(reads);
  await click('清除筛选');
  expect(node(thinkingId)).toBeDefined();
  expect(h.state().selectedNodeId).toBe(thinkingId);
  expect(h.state().selectedObservationId).toBe(selectedObservation);
  expect(h.state().workbenchTab).toBe('thinking');
  expect(h.opened).toHaveLength(reads);
});

test('tool and child Agent menu choices are independent and preserve the selected exact tool result', async () => {
  const f = facts(),
    h = harness(f.events);
  await h.render();
  for (const label of ['轮次', '调用', '子调用'])
    expect(document.querySelector(`button[aria-label="${label}"]`)).toBeNull();
  const legacyFilters = { ...h.state().filters! };
  delete legacyFilters.childAgents;
  await h.setState({ ...h.state(), filters: legacyFilters });
  expect(h.state().filters?.childAgents).toBeUndefined();
  expect(node('execution:tool')).toBeDefined();
  expect(node('execution:carrier')).toBeDefined();
  await select('execution:tool');
  await tab('结果');
  const reads = h.opened.length;
  const originalMaterial = detail().textContent;
  await openMenu('筛选轨迹');
  await checkbox('子 Agent');
  expect(h.state().filters?.childAgents).toBe(false);
  expect(h.state().filters?.types).toContain('tool');
  expect(node('execution:tool')).toBeDefined();
  absent('execution:carrier');
  expect(detail().textContent).toBe(originalMaterial);
  expect(h.opened).toHaveLength(reads);
  await openMenu('筛选轨迹');
  await checkbox('子 Agent');
  expect(h.state().filters?.childAgents).toBe(true);
  await openMenu('筛选轨迹');
  await checkbox('工具');
  expect(h.state().filters?.types).not.toContain('tool');
  expect(h.state().filters?.childAgents).toBe(true);
  absent('execution:tool');
  expect(node('execution:carrier')).toBeDefined();
  expect(detail().textContent).toContain('此记录不在当前筛选结果中');
  expect(detail().textContent).toContain('EXACT tool-result-version');
  expect(h.state().selectedNodeId).toBe('execution:tool');
  expect(h.state().workbenchTab).toBe('result');
  expect(h.opened).toHaveLength(reads);
  await openMenu('筛选轨迹');
  await checkbox('工具');
  expect(node('execution:tool')).toBeDefined();
  expect(node('execution:carrier')).toBeDefined();
  expect(h.opened).toHaveLength(reads);
});

test('historical cursor and observation versions reject future or foreign bodies across tab changes', async () => {
  const f = facts(),
    h = harness(f.events, f.prefix.sequence);
  h.values.set('prefix', {
    content: 'original prefix',
    reasoning: 'EXACT prefix-v1',
    complete: false,
  });
  await h.render();
  await select(thinkingId);
  assertThoughtOnly();
  expect(detail().textContent).toContain('此版本输出尚未完整结束。');
  expect(h.opened.at(-1)!.find((value) => value.kind === 'model_output')?.eventId).toBe(
    f.prefix.eventId,
  );
  await tab('思考');
  expect(detail().textContent).toContain('EXACT prefix-v1');
  expect(detail().textContent).not.toContain('失败');
  absent('execution:retry');
  await h.render(false, true);
  expect(detail().textContent).not.toContain('FUTURE MATERIAL');
  expect(detail().textContent).toContain('正在读取原版本材料');
  await h.render();
  const requestMarker = document.querySelector<HTMLButtonElement>(
    '.trajectory-request-marker[data-request-owner="execution:model"]',
  )!;
  expect(requestMarker).not.toBeNull();
  await act(() => requestMarker.click());
  expect(
    h.opened.at(-1)!.map((value) => [value.eventId, value.evidenceId, value.contentVersion]),
  ).toEqual([
    [f.input.eventId, 'input', 'input-version'],
    [f.prefix.eventId, 'prefix', 'prefix-v1'],
  ]);
  await h.setState({ ...h.state(), selectedObservationId: f.input.eventId });
  await tab('选项');
  expect(h.opened.at(-1)!.map((value) => value.evidenceId)).toEqual(['input']);
  const requestDetail = document.querySelector<HTMLElement>('[aria-label="模型请求详情"]')!;
  expect(requestDetail.textContent).not.toContain('EXACT prefix-v1');
  expect(h.opened.at(-1)!.map((value) => value.eventId)).toEqual([f.input.eventId]);
  expect(
    [...requestDetail.querySelectorAll('[role="tab"]')].map((item) => item.textContent),
  ).toEqual(['概述', '选项', '用量', '计时']);
  expect(requestDetail.textContent).not.toContain('EXACT retry-result');
  const reads = h.opened.length;
  await h.setState({ ...h.state(), selectedObservationId: f.retry.eventId });
  expect(requestDetail.textContent).not.toContain('EXACT retry-result');
  expect(h.opened).toHaveLength(reads);
});

test('folding and keyboard navigation preserve selected details and restore retained list reading state', async () => {
  const f = facts(),
    h = harness(f.events);
  await h.render();
  await select('execution:tool');
  await tab('结果');
  const reads = h.opened.length;
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  await click('折叠Agent loop 1');
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  absent('execution:tool');
  expect(detail().textContent).toContain('此记录当前被折叠');
  expect(h.opened).toHaveLength(reads);
  await click('展开Agent loop 1');
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  const button =
    node('execution:tool').querySelector<HTMLButtonElement>('.trajectory-node-select')!;
  await act(() => {
    button.focus();
    button.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
  });
  // Ordinary stages are leaves; Left moves directly to the containing Agent loop.
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  expect((document.activeElement as HTMLElement).dataset.nodeId).toBe('run:run');
  const tree = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
  await act(() => {
    tree.scrollTop = 190;
    tree.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  expect(h.state().readingAnchor.scrollTop).toBe(190);
  await h.setState({ ...h.state(), detailScrollTop: 73, detailWidth: 46 });
  await h.remount();
  expect(h.state().selectedNodeId).toBe('execution:tool');
  expect(h.state().workbenchTab).toBe('result');
  expect(h.state().detailWidth).toBe(46);
  expect(document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!.scrollTop).toBe(190);
  expect(document.querySelector<HTMLElement>('[aria-label="详情正文"]')!.scrollTop).toBe(73);
});

test('held initial and reopened reads preserve cached selection and legal tab without a false root flash', async () => {
  const f = facts(),
    h = harness(f.events);
  await h.render();
  await select('execution:tool');
  await tab('结果');
  await h.setState({ ...h.state(), detailScrollTop: 73 });
  await h.render(true);
  expect(document.body.textContent).toContain('正在读取所选记录');
  expect(document.body.textContent).not.toContain('全部事件');
  expect(detail()).toBeNull();
  await all();
  expect(h.state().selectedNodeId).toBe('execution:tool');
  expect(h.state().workbenchTab).toBe('result');
  await h.render();
  assertCleanDetailChrome();
  expect(node('execution:tool').textContent).toContain('read_file');
  expect(detail().textContent).toContain('EXACT tool-result-version');
  expect(h.state().detailScrollTop).toBe(73);
});

test('container width selects a modal drawer and restores the same selection, tab and material when docking again', async () => {
  const f = facts(),
    h = harness(f.events);
  await h.render();
  await select(thinkingId);
  await tab('思考');
  const reads = h.opened.length;
  const workspace = document.querySelector<HTMLElement>('.trajectory-workspace')!;
  let width = 600;
  workspace.getBoundingClientRect = () => ({
    width,
    height: 500,
    top: 0,
    left: 0,
    right: width,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  await act(() => TestResizeObserver.notify());
  expect(workspace.dataset.detailLayout).toBe('drawer');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  assertThoughtOnly();
  expect(detail().textContent).toContain('EXACT retry-result-version');
  expect(h.opened).toHaveLength(reads);
  width = 1100;
  await act(() => TestResizeObserver.notify());
  expect(workspace.dataset.detailLayout).toBe('docked');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(h.state().selectedNodeId).toBe(thinkingId);
  expect(h.state().workbenchTab).toBe('thinking');
  expect(h.opened).toHaveLength(reads);
  expect(
    document.querySelector('[role="separator"][aria-label="调整轨迹详情宽度"]'),
  ).not.toBeNull();
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  expect((document.activeElement as HTMLElement).textContent).toBe('思考');
});

test('automatic compression reports sealed same-basis adopted accounting without inventing unpublished after counts', async () => {
  const f = facts();
  const base = f.tool;
  const before = trajectoryEventSchema.parse({
    ...base,
    sequence: '20',
    eventId: `te_${'a'.repeat(64)}`,
    kind: 'model',
    executionId: 'compression-model',
    parentExecutionId: undefined,
    sourceEventType: 'model.completed',
    attributes: {
      definitionId: 'compress',
      compressionId: 'cmp',
      compressionTrigger: 'automatic',
      compression: { adopted: false, triggerTokens: 500, triggerBasis: 'local_estimate' },
      usage: { inputTokens: '450', outputTokens: '30' },
    },
  });
  const after = trajectoryEventSchema.parse({
    ...base,
    sequence: '21',
    eventId: `te_${'b'.repeat(64)}`,
    kind: 'context',
    executionId: undefined,
    parentExecutionId: undefined,
    sourceEventType: 'context.compressed',
    attributes: {
      compressionId: 'cmp',
      compressionTrigger: 'automatic',
      action: 'published',
      compression: {
        adopted: true,
        accounting: { basis: 'local-context-estimate-v1', beforeTokens: 500, afterTokens: 100 },
      },
    },
  });
  const h = harness([...f.events, before, after]);
  await h.render();
  await select('execution:compression-model');
  await h.setState({ ...h.state(), selectedObservationId: before.eventId });
  expect(detail().textContent).toContain('未确认采用');
  expect(detail().textContent).toContain('未采用，不能计算实际压后容量');
  expect(detail().textContent).toContain('输入 450');
  await select(`event:${after.eventId}`);
  expect(detail().textContent).toContain('压缩已采用');
  expect(detail().textContent).toContain('400 Token');
  expect(detail().textContent).toContain('80.0%');
  expect(h.opened).toHaveLength(0);
  const compressionMarker = document.querySelector<HTMLButtonElement>(
    '.trajectory-request-marker[data-request-owner="execution:compression-model"]',
  );
  expect(compressionMarker).not.toBeNull();
  await act(() => compressionMarker!.click());
  expect(h.state().selectedRequestId).toBe('execution:compression-model');
  expect(h.state().selectedNodeId).toBe('execution:compression-model');
  const requestDetail = document.querySelector<HTMLElement>('[aria-label="模型请求详情"]')!;
  expect([...requestDetail.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(
    ['概述', '选项', '用量', '计时'],
  );
  const calls = [...requestDetail.querySelectorAll('dt')].find(
    (item) => item.textContent === '发起工具请求',
  )?.nextElementSibling?.textContent;
  expect(calls).toContain('未保存');
  expect(calls).not.toBe('0');
  expect(h.opened).toHaveLength(0);
  await tab('用量');
  expect(requestDetail.textContent).toContain('450');
  expect(requestDetail.textContent).toContain('30');
  expect(h.opened).toHaveLength(0);
});

test('10000-level legal source hierarchy remains intact while ordinary reading rows are flat and iterative', () => {
  const events = Array.from({ length: 10000 }, (_, index) =>
    trajectoryEventSchema.parse({
      schema: 'kite.trajectory',
      schemaVersion: 1,
      eventId: `te_${(index + 1).toString(16).padStart(64, '0')}`,
      sequence: String(index + 1),
      origin: { storeId: 'store', cursor: String(index + 1) },
      sessionId: 'session',
      workspaceId: 'workspace',
      executionId: `deep-${index}`,
      ...(index > 0 ? { parentExecutionId: `deep-${index - 1}` } : {}),
      kind: 'tool',
      phase: 'completed',
      sourceEventType: 'tool.completed',
      sourceRecordRevision: '1',
      occurredAt: null,
      identityConfidence: 'verified_origin',
      recordedStatus: 'succeeded',
      evidenceRefs: [],
      attributes: { definitionId: 'deep' },
    }),
  );
  const state = initialTrajectoryViewState();
  state.cursor = '10000';
  const projection = projectTrajectory(events, { atCursor: '10000', completePrefix: true });
  const source = buildTrajectoryTree(projection, []);
  expect(source.byId.get('execution:deep-9999')!.parentId).toBe('execution:deep-9998');
  let originalDepth = 0,
    current = source.byId.get('execution:deep-9999');
  while (current?.parentId) {
    originalDepth++;
    current = source.byId.get(current.parentId);
  }
  expect(originalDepth).toBe(10000);
  const html = renderToStaticMarkup(
    <TrajectoryPanel
      state={state}
      onStateChange={() => {}}
      events={[]}
      projection={projection}
      integrity={integrity}
      mode="history"
      playing={false}
      exhausted
      onSeek={() => {}}
      onStep={() => {}}
      onPlay={() => {}}
      onPause={() => {}}
      onReturnToLatest={() => {}}
    />,
  );
  expect(html.match(/data-trajectory-node="execution:deep-/g)).toHaveLength(10000);
  expect(
    /data-trajectory-node="execution:deep-9999" data-trajectory-row="execution:deep-9999" data-trajectory-parent="session" data-depth="1"/.test(
      html,
    ),
  ).toBe(true);
  expect(html).not.toContain('生命周期');
  expect(html).not.toContain('决策步骤');
});

test('public message updates aggregate one row, retain exact revisions and do not infer missing conversation records', async () => {
  const f = facts();
  const make = (
    sequence: number,
    id: string,
    role: 'user' | 'assistant',
    status: 'complete' | 'incomplete',
    revision: number,
    executionId?: string,
  ) =>
    trajectoryEventSchema.parse({
      ...f.tool,
      eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
      sequence: String(sequence),
      sourceRecordRevision: String(revision),
      sourceEventType: 'message.updated',
      kind: 'message',
      phase: 'observed',
      executionId,
      parentExecutionId: undefined,
      attributes: {
        messageId: id,
        role,
        status,
        messageSeq: String(sequence),
        revision: String(revision),
      },
      evidenceRefs: [material(`${id}-${revision}`, 'message')],
    });
  const user = make(20, 'human', 'user', 'complete', 1),
    prefix = make(21, 'reply', 'assistant', 'incomplete', 1, 'retry'),
    final = make(22, 'reply', 'assistant', 'complete', 2, 'retry'),
    next = make(23, 'next', 'user', 'complete', 1);
  const pending = {
    ...make(24, 'in-progress', 'assistant', 'incomplete', 1, 'retry'),
    phase: 'running' as const,
  };
  const h = harness([...f.events, user, prefix, final, next, pending]);
  h.values.set('reply-1', { role: 'assistant', status: 'incomplete', content: 'original prefix' });
  h.values.set('reply-2', {
    role: 'assistant',
    status: 'complete',
    content: '**final public reply**',
  });
  await h.render();
  expect(document.querySelectorAll('[data-trajectory-node="message:reply"]')).toHaveLength(1);
  expect(node('message:reply').querySelector('.trajectory-node-status')).toBeNull();
  expect(node('message:human').querySelector('.trajectory-node-status')).toBeNull();
  expect(
    node('message:in-progress').querySelector('.trajectory-node-status')?.getAttribute('title'),
  ).toBe('运行中');
  expect(node('message:reply').dataset.trajectoryParent).toBe('run:run');
  await select('message:reply');
  expect(tabLabels()).toEqual(['内容']);
  expect(h.opened).toHaveLength(1);
  expect(detail().textContent).toContain('final public reply');
  const messageTrigger = () => detail().querySelector('[data-slot="accordion-trigger"]')!;
  expect(detail().querySelectorAll('[data-slot="accordion-trigger"]')).toHaveLength(1);
  expect(messageTrigger().textContent).toBe('消息正文');
  expect(messageTrigger().getAttribute('aria-expanded')).toBe('true');
  expect(detail().textContent).not.toContain('来源 #');
  expect(detail().querySelector('.trajectory-material-source')).toBeNull();
  await click('消息正文');
  expect(messageTrigger().getAttribute('aria-expanded')).toBe('false');
  expect(detail().textContent).not.toContain('final public reply');
  expect(h.opened).toHaveLength(1);
  await click('消息正文');
  expect(detail().textContent).toContain('final public reply');
  expect(h.opened).toHaveLength(1);
  await h.setState({ ...h.state(), selectedObservationId: prefix.eventId });
  expect(messageTrigger().getAttribute('aria-expanded')).toBe('true');
  expect(detail().textContent).not.toContain('来源 #');
  expect(detail().textContent).toContain('original prefix');
  expect(detail().textContent).toContain('尚未完整结束');
  expect(detail().textContent).not.toContain('final public reply');
  await all();
  expect(document.querySelectorAll('[data-trajectory-node="message:reply"]')).toHaveLength(1);
  expect(h.state().selectedObservationId).toBe(prefix.eventId);
  await h.setState({ ...h.state(), workbenchTab: 'raw' });
  expect(tabLabels()).toEqual(['内容']);
  expect(detail().textContent).toContain('original prefix');
  expect(detail().textContent).not.toContain('final public reply');
  expect(h.opened.at(-1)!.map((value) => [value.eventId, value.contentVersion])).toEqual([
    [prefix.eventId, 'reply-1-version'],
  ]);
  await h.render(false, true);
  expect(detail().textContent).not.toContain('FUTURE MATERIAL');
  expect(detail().textContent).not.toContain('final public reply');
  expect(h.state().selectedObservationId).toBe(prefix.eventId);
  await h.render();
  expect(detail().textContent).toContain('original prefix');
  expect(tabLabels()).toEqual(['内容']);
  expect(document.querySelector('[aria-label="材料版本"]')).toBeNull();
  await h.remount();
  expect(h.state().selectedObservationId).toBe(prefix.eventId);
  expect(detail().textContent).toContain('original prefix');
});

test('canonical message content preserves complete attachment descriptions, duplicates and zero without an empty body accordion', async () => {
  const f = facts();
  const names = ['attachment-only', 'blank-human', 'json-human', 'normal-human'];
  const messages = names.map((id, index) =>
    trajectoryEventSchema.parse({
      ...f.tool,
      sequence: String(20 + index),
      eventId: `te_${(20 + index).toString(16).padStart(64, '0')}`,
      kind: 'message',
      phase: 'observed',
      executionId: undefined,
      parentExecutionId: undefined,
      attributes: {
        messageId: id,
        role: 'user',
        messageSeq: String(index + 1),
        revision: '1',
        status: 'complete',
      },
      evidenceRefs: [material(id, 'message')],
    }),
  );
  const h = harness([...f.events, ...messages]);
  const attachment = { name: 'empty.txt', mediaType: 'text/plain', size: 0 };
  const literal = '{"session_files":[{"path":"/user-pasted/original.json"}]}';
  h.values.set('attachment-only', {
    role: 'user',
    status: 'complete',
    content: '',
    attachments: [attachment, { ...attachment }],
  });
  h.values.set('blank-human', { role: 'user', status: 'complete', content: ' \n ' });
  h.values.set('json-human', { role: 'user', status: 'complete', content: literal });
  h.values.set('normal-human', {
    role: 'user',
    status: 'complete',
    content: '正常用户正文，保留原内容。',
  });
  const original = JSON.stringify(messages);
  await h.render();
  await select('message:attachment-only');
  expect(tabLabels()).toEqual(['内容']);
  expect(detail().querySelector('[data-slot="accordion-trigger"]')).toBeNull();
  expect(detail().textContent).not.toContain('消息正文为空');
  const attachments = detail().querySelector('[aria-label="已保存附件"]')!;
  expect(attachments).not.toBeNull();
  expect(attachments.querySelectorAll('.trajectory-attachment-description')).toHaveLength(2);
  expect(
    [...attachments.querySelectorAll('.trajectory-attachment-name')].map(
      (item) => item.textContent,
    ),
  ).toEqual(['empty.txt', 'empty.txt']);
  expect(
    [...attachments.querySelectorAll('.trajectory-attachment-metadata')].map(
      (item) => item.textContent,
    ),
  ).toEqual(['text/plain · 0 字节', 'text/plain · 0 字节']);
  expect(attachments.querySelector('a, img')).toBeNull();
  expect(h.opened.at(-1)!.map((view) => [view.eventId, view.contentVersion])).toEqual([
    [messages[0]!.eventId, 'attachment-only-version'],
  ]);
  await select('message:blank-human');
  expect(detail().textContent).toContain('正文仅包含空白字符（已保存）');
  expect(detail().querySelector('[data-slot="accordion-trigger"]')).toBeNull();
  await select('message:json-human');
  expect(detail().textContent).toContain(literal);
  await select('message:normal-human');
  expect(detail().textContent).toContain('正常用户正文，保留原内容。');
  expect(JSON.stringify(messages)).toBe(original);
});

test('legacy virtual input renders only its exact saved image descriptors and retains literal user context across attempts', async () => {
  const f = facts();
  const planned = f.events.find(
    (event) => event.executionId === 'retry' && event.phase === 'planned',
  )!;
  planned.evidenceRefs.push(material('image-retry-input', 'model_input'));
  const h = harness(f.events);
  const images = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].map((mediaType) => ({
    mediaType,
    data: 'AAAA',
  }));
  const literal = '{"session_files":[{"path":"/user-pasted/keep-this.json"}]}';
  h.values.set('image-retry-input', {
    request: {
      modelId: 'opaque-original',
      messages: [
        { role: 'user', content: '用户图片原文。', images },
        { role: 'user', content: literal },
        { role: 'user', content: '后续正常用户上下文。' },
      ],
      tools: [],
    },
  });
  h.values.set('input', {
    request: {
      modelId: 'opaque-original',
      messages: [{ role: 'user', content: '首次图片请求原文。', images: [images[0]] }],
      tools: [],
    },
  });
  const original = JSON.stringify(f.events);
  await h.render();
  await select('execution:model:part:input');
  expect(detail().textContent).toContain('用户图片原文');
  expect(
    [...detail().querySelectorAll<HTMLImageElement>('[aria-label="已保存请求图片"] img')].map(
      (image) => image.getAttribute('src'),
    ),
  ).toEqual(images.map((image) => `data:${image.mediaType};base64,${image.data}`));
  expect(h.opened.at(-1)!.map((view) => view.evidenceId)).toEqual(['image-retry-input']);
  const reads = h.opened.length;
  await click('用户上下文 · 2');
  expect(detail().textContent).toContain(literal);
  await click('用户上下文 · 3');
  expect(detail().textContent).toContain('后续正常用户上下文');
  expect(h.opened).toHaveLength(reads);
  await h.setState({ ...h.state(), selectedObservationId: f.input.eventId });
  expect(detail().textContent).toContain('首次图片请求原文');
  expect(detail().textContent).not.toContain('后续正常用户上下文');
  expect(detail().textContent).not.toContain(literal);
  expect([...detail().querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
    'data:image/png;base64,AAAA',
  ]);
  expect(h.opened.at(-1)!.map((view) => [view.eventId, view.evidenceId])).toEqual([
    [f.input.eventId, 'input'],
  ]);
  await h.render(false, true);
  expect(detail().querySelector('img')).toBeNull();
  expect(detail().textContent).not.toContain('FUTURE MATERIAL');
  await h.render();
  expect(detail().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  expect(h.state().selectedObservationId).toBe(f.input.eventId);
  expect(JSON.stringify(f.events)).toBe(original);
});

test('a proven delegated task preview keeps its readable original prompt and complete launch JSON on the same reference', async () => {
  const base = facts().tool;
  const make = (n: number, values: Record<string, unknown>) =>
    trajectoryEventSchema.parse({
      ...base,
      sequence: String(n),
      eventId: `te_${n.toString(16).padStart(64, '0')}`,
      executionOriginStoreId: 'store',
      runOriginStoreId: 'store',
      parentExecutionId: undefined,
      ...values,
    });
  const display = {
    kind: 'task',
    operation: 'spawn',
    targetExecutionId: 'delegate-job',
    targetExecutionOriginStoreId: 'store',
    targetSessionId: 'child',
    targetRunId: 'child-run',
  };
  const launch = make(2, {
    kind: 'tool',
    executionId: 'delegate-launch',
    phase: 'planned',
    recordedStatus: 'planned',
    attributes: { definitionId: 'task.spawn', display },
    evidenceRefs: [material('delegated-input', 'tool_input')],
  });
  const events = [
    make(1, {
      kind: 'run',
      executionId: undefined,
      phase: 'running',
      attributes: {},
      evidenceRefs: [],
    }),
    launch,
    make(3, {
      kind: 'tool',
      executionId: 'delegate-launch',
      attributes: { definitionId: 'task.spawn', display: { ...display, accepted: true } },
      evidenceRefs: [],
    }),
    make(4, {
      kind: 'job',
      executionId: 'delegate-job',
      parentExecutionId: 'delegate-launch',
      parentExecutionOriginStoreId: 'store',
      phase: 'running',
      recordedStatus: 'running',
      attributes: {
        definitionId: 'task.agent',
        childSessionId: 'child',
        display: { kind: 'task', targetSessionId: 'child', targetRunId: 'child-run' },
      },
      evidenceRefs: [],
    }),
  ];
  const input = {
    prompt: '检查登录守卫，返回准确审查结论。',
    taskName: '登录守卫审查',
    preset: 'read-only-reviewer',
  };
  const h = harness(events);
  h.values.set('delegated-input', input);
  await h.render();
  await select('execution:delegate-launch');
  expect(tabLabels()).toEqual(['概述', '预览']);
  await tab('预览');
  const delegation = detail().querySelector('.trajectory-content-accordion')!;
  expect(delegation.textContent).toContain('委派任务');
  expect(delegation.textContent).toContain('任务名称登录守卫审查');
  expect(delegation.textContent).toContain('预设角色read-only-reviewer');
  expect(delegation.textContent).toContain(input.prompt);
  const json = detail().querySelector('[aria-label="原公开 JSON"]')!;
  expect(JSON.parse(json.textContent!)).toEqual(input);
  expect(
    h.opened.at(-1)!.map((view) => [view.eventId, view.evidenceId, view.contentVersion]),
  ).toEqual([[launch.eventId, 'delegated-input', 'delegated-input-version']]);
  const reads = h.opened.length;
  await click('委派任务');
  expect(delegation.textContent).not.toContain(input.prompt);
  expect(JSON.parse(json.textContent!)).toEqual(input);
  expect(h.opened).toHaveLength(reads);
});

test('compression context preview retains exact message sequence zero and original range boundaries', async () => {
  const base = facts().tool;
  const context = trajectoryEventSchema.parse({
    ...base,
    sequence: '20',
    eventId: `te_${'b'.repeat(64)}`,
    kind: 'context',
    executionId: undefined,
    parentExecutionId: undefined,
    sourceEventType: 'context.compressed',
    attributes: {
      compressionId: 'context-range',
      compressionTrigger: 'automatic',
      action: 'compressed',
      compression: {
        adopted: true,
        accounting: { basis: 'local-context-estimate-v1', beforeTokens: 0, afterTokens: 0 },
      },
    },
    evidenceRefs: [material('exact-context-range', 'context')],
  });
  const h = harness([context]);
  h.values.set('exact-context-range', {
    selection: {
      boundarySeq: '0',
      tailFromSeq: '0',
      ranges: [
        { afterSeq: '0', throughSeq: '0' },
        { afterSeq: '1', throughSeq: '3' },
      ],
    },
  });
  await h.render();
  await select(`event:${context.eventId}`);
  await tab('预览');
  expect(detail().textContent).toContain('压缩后保留的消息范围');
  expect(detail().textContent).toContain('压缩边界消息消息序号 0');
  expect(detail().textContent).toContain('保留尾部消息从消息序号 0 开始');
  expect(detail().textContent).toContain('消息序号大于 0，至 0（含）');
  expect(detail().textContent).toContain('消息序号大于 1，至 3（含）');
  expect(
    h.opened.at(-1)!.map((view) => [view.eventId, view.evidenceId, view.contentVersion]),
  ).toEqual([[context.eventId, 'exact-context-range', 'exact-context-range-version']]);
  const reads = h.opened.length;
  await click('压缩后保留的消息范围');
  expect(detail().textContent).not.toContain('消息序号大于 1');
  expect(h.opened).toHaveLength(reads);
});

test('full event rows sharing one administrative owner keep independent observations and original recorded states', async () => {
  const f = facts();
  const first = trajectoryEventSchema.parse({
    ...f.tool,
    sequence: '20',
    eventId: `te_${'c'.repeat(64)}`,
    kind: 'command',
    executionId: undefined,
    parentExecutionId: undefined,
    phase: 'planned',
    sourceEventType: 'command.planned',
    attributes: { commandId: 'admin-command', commandType: 'submit' },
    evidenceRefs: [],
  });
  const second = trajectoryEventSchema.parse({
    ...first,
    sequence: '21',
    eventId: `te_${'d'.repeat(64)}`,
    phase: 'completed',
    sourceEventType: 'command.completed',
  });
  const h = harness([...f.events, first, second]);
  await h.render();
  await all();
  const selectEvent = async (id: string) => {
    const row = document.querySelector<HTMLElement>(`[data-trajectory-row="event:${id}"]`)!;
    expect(row).not.toBeNull();
    await act(() => row.querySelector<HTMLButtonElement>('.trajectory-node-select')!.click());
  };
  await selectEvent(first.eventId);
  expect(tabLabels()).toEqual(['概述']);
  expect(detail().textContent).toContain('已计划');
  expect(detail().textContent).not.toContain('已完成');
  expect(h.state().selectedObservationId).toBe(first.eventId);
  expect(h.state().selectedNodeId).toBe(`event:${first.eventId}`);
  await selectEvent(second.eventId);
  expect(h.state().selectedObservationId).toBe(second.eventId);
  expect(detail().textContent).toContain('已完成');
  expect(detail().textContent).not.toContain('已计划');
  expect(document.querySelectorAll('[aria-pressed="true"].trajectory-node-select')).toHaveLength(1);
  expect(h.opened).toHaveLength(0);
});

test('legacy and future unknown records stay distinct, expose original safe metadata and never invent tool tabs', async () => {
  const f = facts();
  const legacy = trajectoryEventSchema.parse({
    ...f.unknown,
    sequence: '20',
    eventId: `te_${'e'.repeat(64)}`,
    identityConfidence: 'legacy_local',
    sourceEventType: 'execution.planned',
    attributes: { reason: 'legacy_fields_missing' },
  });
  const future = trajectoryEventSchema.parse({
    ...f.unknown,
    sequence: '21',
    eventId: `te_${'f'.repeat(64)}`,
    sourceEventType: 'future.tool_event',
    attributes: { reason: 'unrecognized_source_type' },
  });
  const h = harness([...f.events, legacy, future]);
  await h.render();
  await all();
  await select(`event:${legacy.eventId}`);
  assertCleanDetailChrome();
  expect(node(`event:${legacy.eventId}`).textContent).toContain('旧记录 · execution.planned');
  expect(tabLabels()).toEqual(['概述']);
  expect(node(`event:${legacy.eventId}`).textContent).toContain('旧记录');
  expect(h.state().selectedObservationId).toBe(legacy.eventId);
  await select(`event:${future.eventId}`);
  assertCleanDetailChrome();
  expect(node(`event:${future.eventId}`).textContent).toContain('未识别事件 · future.tool_event');
  expect(tabLabels()).toEqual(['概述']);
  expect(h.state().selectedObservationId).toBe(future.eventId);
  expect(detail().textContent).not.toContain('旧记录');
  expect(h.opened).toHaveLength(0);
});

test('virtualized long lists keep the focused offscreen row mounted during manual scrolling', async () => {
  const f = facts();
  const events = Array.from({ length: 500 }, (_, index) =>
    trajectoryEventSchema.parse({
      ...f.tool,
      eventId: `te_${(index + 1).toString(16).padStart(64, '0')}`,
      sequence: String(index + 1),
      executionId: `parallel-${index}`,
      parentExecutionId: undefined,
      runId: undefined,
      attributes: { definitionId: 'parallel' },
      evidenceRefs: [],
    }),
  );
  const h = harness(events);
  await h.render();
  const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 190 });
  await act(() => TestResizeObserver.notify());
  const first =
    node('execution:parallel-0').querySelector<HTMLButtonElement>('.trajectory-node-select')!;
  await act(() => first.focus());
  await act(() => {
    viewport.scrollTop = 12000;
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  expect(first.isConnected).toBe(true);
  expect(document.activeElement).toBe(first);
  expect(document.querySelectorAll('[data-trajectory-node]').length).toBeLessThan(40);
  expect(node('execution:parallel-320')).toBeDefined();
  expect(h.opened).toHaveLength(0);
});

test('typed plan steps and MCP structured results survive the read-only renderer without duplicate raw fallback', async () => {
  const { TrajectoryResult, TrajectoryFileChange } = await import(
    '../../src/desktop/trajectory/TrajectoryResult'
  );
  const plan = renderToStaticMarkup(
    <TrajectoryResult
      data={{
        outcome: 'succeeded',
        content: 'duplicate fallback',
        presentation: {
          kind: 'plan',
          operation: 'read',
          text: 'Original plan',
          steps: [{ id: 'step-1', title: 'Original first step', status: 'completed' }],
        },
      }}
    />,
  );
  expect(plan).toContain('Original first step');
  expect(plan).toContain('已完成');
  expect(plan).not.toContain('duplicate fallback');
  const mcp = renderToStaticMarkup(
    <TrajectoryResult
      data={{
        outcome: 'succeeded',
        content: 'duplicate fallback',
        presentation: {
          kind: 'mcp',
          isError: false,
          text: ['Original MCP result'],
          structuredContent: { result: 7 },
        },
      }}
    />,
  );
  expect(mcp).toContain('Original MCP result');
  expect(mcp).toContain('&quot;result&quot;');
  expect(mcp).not.toContain('duplicate fallback');
  const diff = renderToStaticMarkup(
    <TrajectoryFileChange
      data={{ format: 'line_diff', path: 'original.ts', text: '-before\n+after', truncated: true }}
    />,
  );
  expect(diff).toContain('trajectory-diff-added');
  expect(diff).toContain('trajectory-diff-removed');
  expect(diff).toContain('原差异已截断');
  expect(diff).not.toContain('<button');
});

test('automatic approval details show the check request and outcome without empty Agent phases or internal IDs', async () => {
  const base = facts().tool;
  const make = (sequence: number, values: Record<string, unknown>): TrajectoryEvent =>
    trajectoryEventSchema.parse({
      ...base,
      eventId: `te_${sequence.toString(16).padStart(64, '0')}`,
      sequence: String(sequence),
      sourceRecordRevision: String(sequence),
      ...values,
    });
  const events = [
    make(1, { executionId: 'guarded-tool', parentExecutionId: undefined, evidenceRefs: [] }),
    make(2, {
      kind: 'command',
      executionId: undefined,
      parentExecutionId: undefined,
      runId: undefined,
      attributes: { commandId: 'check-command', commandType: 'authorization.check' },
      evidenceRefs: [],
    }),
    make(3, {
      kind: 'model',
      executionId: 'approval-check',
      parentExecutionId: 'guarded-tool',
      parentExecutionOriginStoreId: 'store',
      runId: undefined,
      phase: 'completed',
      attributes: { commandId: 'check-command', definitionId: 'OPAQUE_CHECKER_ID' },
      evidenceRefs: [
        material('check-input', 'model_input'),
        material('check-output', 'model_output'),
      ],
    }),
  ];
  const h = harness(events, '3', true);
  h.values.set('check-input', {
    request: {
      messages: [
        { role: 'system', content: 'Exact review rule' },
        {
          role: 'user',
          content: 'Inspect the requested file write.',
          sourceIds: ['INTERNAL_CHECK_SOURCE'],
        },
      ],
      tools: [],
    },
  });
  h.values.set('check-output', {
    content: '拒绝：原请求超出用户授权范围。',
    reasoning: '',
    toolCalls: [],
    complete: true,
  });
  await h.render();
  expect(node('execution:approval-check').textContent).toContain('审批');
  expect(node('execution:approval-check').textContent).toContain('自动审批检查');
  await select('execution:approval-check');
  await click('查看检查请求与结果');
  const detail = document.querySelector('[aria-label="选中节点详情"]')!;
  assertCleanDetailChrome(detail as HTMLElement);
  expect(detail.textContent).toContain('检查请求');
  expect(detail.textContent).toContain('检查结果');
  expect(detail.textContent).toContain('Inspect the requested file write.');
  expect(detail.textContent).toContain('拒绝：原请求超出用户授权范围。');
  expect(detail.textContent).not.toContain('未保存可展示的思考');
  expect(detail.textContent).not.toContain('可用工具 · 0');
  expect(detail.textContent).not.toContain('INTERNAL_CHECK_SOURCE');
  expect(detail.textContent).not.toContain('OPAQUE_CHECKER_ID');
  expect(detail.querySelector('[aria-label="审批检查请求"] details')?.hasAttribute('open')).toBe(
    false,
  );
  expect(h.opened.at(-1)?.map((view) => view.evidenceId)).toEqual(['check-input', 'check-output']);
});

test('Shell results omit empty stream groups while preserving errors, gaps and independent repeated output', async () => {
  const { TrajectoryResult } = await import('../../src/desktop/trajectory/TrajectoryResult');
  const data = {
    outcome: 'failed',
    content: 'Additional failure context',
    presentation: {
      kind: 'shell',
      operation: 'execute',
      status: 'failed',
      exitCode: 1,
      stdout: '',
      stderr: 'Original diagnostic',
      truncated: true,
      output: [
        { sequence: '1', throughSequence: '1', stream: 'stdout', content: '' },
        { sequence: '2', throughSequence: '2', stream: 'stdout', content: ' ' },
        { sequence: '3', throughSequence: '3', stream: 'gap', content: '', droppedBytes: '9' },
        { sequence: '4', throughSequence: '4', stream: 'stdout', content: 'Repeated output' },
        { sequence: '5', throughSequence: '5', stream: 'stdout', content: 'Repeated output' },
      ],
    },
  };
  const original = structuredClone(data);
  const page = new JSDOM(renderToStaticMarkup(<TrajectoryResult data={data} />));
  const body = page.window.document.body;
  const headings = [...body.querySelectorAll('h4')].map((element) => element.textContent);
  expect(headings).toEqual([
    'stderr',
    'stdout · #2–2',
    'gap · #3–3',
    'stdout · #4–4',
    'stdout · #5–5',
  ]);
  expect(body.textContent).toContain('Original diagnostic');
  expect(body.textContent).toContain('丢弃 9 字节');
  expect(body.textContent).toContain('原输出已截断');
  expect(body.textContent).toContain('失败');
  expect(body.textContent).toContain('退出码');
  expect(body.textContent?.split('Repeated output')).toHaveLength(3);
  expect([...body.querySelectorAll('pre')].some((element) => element.textContent === ' ')).toBe(
    true,
  );
  expect(body.textContent).toContain('Additional failure context');
  expect(
    [...body.querySelectorAll('details')].some((element) =>
      element.textContent?.includes('Additional failure context'),
    ),
  ).toBe(false);
  expect(data).toEqual(original);
  page.window.close();
});

test('prototype presentation exposes semantic lanes, exact time geometry and lightweight typed rows without body reads', async () => {
  const f = facts();
  f.events = f.events.map((event) =>
    ['model', 'tool'].includes(event.kind)
      ? { ...event, occurredAt: Number(event.sequence) * 1000 }
      : event,
  );
  const user = trajectoryEventSchema.parse({
    ...f.tool,
    sequence: '20',
    eventId: `te_${'e'.repeat(64)}`,
    occurredAt: 20000,
    kind: 'message',
    phase: 'observed',
    executionId: undefined,
    parentExecutionId: undefined,
    attributes: {
      messageId: 'visual-user',
      role: 'user',
      messageSeq: '1',
      revision: '1',
      status: 'complete',
    },
    evidenceRefs: [],
  });
  const h = harness([...f.events, user], undefined, false, [], 'history', {
    integrity: { ...integrity, facts: 'partial' },
    errorCode: 'fixture_trajectory_read_failed',
  });
  await h.render();
  const labels = [...document.querySelectorAll('.trajectory-timeline-lane-label')].map(
    (element) => element.textContent,
  );
  for (const label of ['输入 / 回复', '思考', '工具 / 子任务', '压缩 / 审批'])
    expect(labels).toContain(label);
  expect(document.querySelector('.trajectory-timeline-ruler')).not.toBeNull();
  expect(document.querySelector('.trajectory-timeline-gridline')).not.toBeNull();
  expect(
    document.querySelector(
      '[data-trajectory-marker="message:visual-user"].trajectory-time-instant',
    ),
  ).not.toBeNull();
  expect(document.querySelector('.trajectory-time-duration')).not.toBeNull();
  expect(document.querySelector('.trajectory-timeline-domain[data-unknown="true"]')).not.toBeNull();
  expect(node(thinkingId).querySelector('.trajectory-type-badge')!.textContent).toBe('思考');
  expect(node('execution:tool').querySelector('.trajectory-type-badge')!.textContent).toBe('工具');
  expect(
    node('message:visual-user').querySelector('.trajectory-type-badge')!.getAttribute('data-tone'),
  ).toBe('user');
  expect(node('execution:tool').querySelector('.trajectory-row-branch')).not.toBeNull();
  expect(node('run:run').closest('tr')!.classList.contains('trajectory-run-band')).toBe(true);
  expect(node('run:run').querySelector('.trajectory-run-count')).toBeNull();
  expect(document.querySelector('.trajectory-timeline-explanation')).toBeNull();
  expect(document.body.textContent).not.toContain('事实覆盖尚未完整核实');
  expect(document.body.textContent).toContain('轨迹读取未完成');
  expect(document.body.textContent).toContain('fixture_trajectory_read_failed');
  expect(document.querySelector<HTMLButtonElement>('[aria-label="时长"]')!.textContent).toBe(
    '时长',
  );
  for (const label of ['轮次', '调用', '子调用'])
    expect(document.querySelector(`button[aria-label="${label}"]`)).toBeNull();
  await click('时长');
  expect(document.querySelector('.trajectory-timeline-explanation')).toBeNull();
  expect(document.querySelector('.trajectory-time-duration')).toBeNull();
  expect(h.opened).toHaveLength(0);
  await openMenu('更多轨迹操作');
  await checkbox('轨迹信息');
  expect(document.body.textContent).toContain('事实覆盖尚未完整核实');
  expect(document.body.textContent).toContain('快照上界');
  expect(document.body.textContent).toContain('fixture_trajectory_read_failed');
});

function outputPresenceFacts(hasText: boolean) {
  const base = facts().tool;
  const make = (n: number, extra: Record<string, unknown>) =>
    trajectoryEventSchema.parse({
      ...base,
      eventId: `te_${n.toString(16).padStart(64, '0')}`,
      sequence: String(n),
      sourceRecordRevision: String(n),
      executionOriginStoreId: 'store',
      runOriginStoreId: 'store',
      phase: 'completed',
      recordedStatus: 'succeeded',
      ...extra,
    });
  const output = material('presence-output', 'model_output');
  const events = [
    make(1, {
      kind: 'run',
      executionId: undefined,
      parentExecutionId: undefined,
      attributes: {},
      evidenceRefs: [],
    }),
    make(2, {
      kind: 'model',
      executionId: 'presence-model',
      parentExecutionId: undefined,
      attributes: {
        display: {
          kind: 'model',
          outputPresence: {
            hasText,
            toolCallCount: 1,
            complete: true,
            evidenceId: output.evidenceId,
            contentVersion: output.contentVersion,
          },
        },
      },
      evidenceRefs: [output],
    }),
  ];
  for (let n = 3; n < 18; n++)
    events.push(
      make(n, {
        executionId: `tail-${n}`,
        parentExecutionId: 'presence-model',
        parentExecutionOriginStoreId: 'store',
        attributes: { definitionId: 'files.read' },
        evidenceRefs: [],
      }),
    );
  return { events, make, output };
}

test('proved tool-only outputs stay hidden while thought details omit redundant navigation and preserve reading position', async () => {
  const f = outputPresenceFacts(false),
    h = harness(f.events, f.events.at(-1)!.sequence, true);
  await h.render();
  absent('execution:presence-model:part:reply');
  const ids = () =>
    [...document.querySelectorAll('[data-trajectory-row]')].map((row) =>
      row.getAttribute('data-trajectory-row'),
    );
  const before = ids();
  const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
  await act(() => {
    viewport.scrollTop = 83;
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  h.values.set(f.output.evidenceId, {
    content: '',
    reasoning: `准确保存的公开思考。${'长思考内容。'.repeat(180)}`,
    toolCalls: [{ id: 'call', name: 'files.read', arguments: '{}' }],
    complete: true,
  });
  await h.render(false, true);
  expect(ids()).toEqual(before);
  expect(viewport.scrollTop).toBe(83);
  await h.render();
  await select('execution:presence-model:part:thinking');
  expect(h.state().selectedNodeId).toBe('execution:presence-model:part:thinking');
  expect(detail().textContent).toContain('准确保存的公开思考。');
  expect(detail().textContent).not.toContain('查看该次公开输出');
  expect(detail().querySelector('.trajectory-material-source')).toBeNull();
  expect(h.opened.at(-1)?.[0]?.evidenceId).toBe(f.output.evidenceId);
  expect(detail().querySelector('.trajectory-thought-preview')?.getAttribute('data-expanded')).toBe(
    'false',
  );
  await click('展开全部思考');
  expect(detail().querySelector('.trajectory-thought-preview')?.getAttribute('data-expanded')).toBe(
    'true',
  );
  await click('收起思考');
  expect(detail().querySelector('.trajectory-thought-preview')?.getAttribute('data-expanded')).toBe(
    'false',
  );
  await click('关闭节点详情');
  await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  expect((document.activeElement as HTMLElement).dataset.nodeId).toBe(
    'execution:presence-model:part:thinking',
  );
  expect(ids()).toEqual(before);
});

test('a live canonical-message handoff corrects the reading anchor by row identity, while explicit seeks keep their navigation position', async () => {
  const f = outputPresenceFacts(true),
    h = harness(f.events, f.events.at(-1)!.sequence, true, [], 'live');
  await h.render();
  const ids = () =>
    [...document.querySelectorAll('[data-trajectory-row]')].map(
      (row) => row.getAttribute('data-trajectory-row')!,
    );
  const initial = ids(),
    anchor = 'execution:tail-8';
  const index = initial.indexOf(anchor);
  expect(index).toBeGreaterThan(0);
  const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
  await act(() => {
    viewport.scrollTop = index * 38 + 7;
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  const reference = material('canonical-output', 'message');
  f.events.push(
    f.make(18, {
      kind: 'message',
      executionId: 'presence-model',
      parentExecutionId: undefined,
      phase: 'observed',
      recordedStatus: 'complete',
      attributes: {
        messageId: 'canonical',
        role: 'assistant',
        messageSeq: '1',
        revision: '18',
        status: 'complete',
        display: {
          kind: 'message',
          outputPresence: {
            hasText: true,
            toolCallCount: 0,
            complete: true,
            evidenceId: reference.evidenceId,
            contentVersion: reference.contentVersion,
          },
        },
      },
      evidenceRefs: [reference],
    }),
  );
  await h.setState({
    ...h.state(),
    cursor: '18',
    descriptor: { ...h.state().descriptor!, upperCursor: '18' },
  });
  absent('execution:presence-model:part:reply');
  expect(viewport.scrollTop).toBe(ids().indexOf(anchor) * 38 + 7);
  expect(viewport.scrollTop).toBe((index - 1) * 38 + 7);
  await h.setState({
    ...h.state(),
    cursor: '17',
    descriptor: { ...h.state().descriptor!, upperCursor: '17' },
    readingAnchor: { eventId: anchor, offset: 0, scrollTop: 42 },
  });
  // The explicit replay/navigation state is respected by the normal restoration path.
  expect(document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!.scrollTop).toBe(42);
});

test('opening and closing docked details preserves the list reading position', async () => {
  const original = Object.getOwnPropertyDescriptor(
    dom.window.HTMLElement.prototype,
    'clientHeight',
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.getAttribute('aria-label') === '轨迹事件树' ? 190 : 0;
    },
  });
  try {
    const h = harness(facts().events);
    await h.render();
    const first = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
    await act(() => {
      first.scrollTop = 114;
      first.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    });
    await select('execution:tool');
    const opened = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
    expect(opened.scrollTop).toBe(114);
    expect(h.state().readingAnchor.scrollTop).toBe(114);
    await click('关闭节点详情');
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    const closed = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
    expect(closed.scrollTop).toBe(114);
    expect(h.state().readingAnchor.scrollTop).toBe(114);
  } finally {
    if (original) Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', original);
    else Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'clientHeight');
  }
});

test('new records live inside the fixed toolbar and never insert flow ahead of the historical timeline or log', async () => {
  const f = facts(),
    h = harness(f.events, f.tool.sequence, true);
  await h.render();
  await select('execution:tool');
  await tab('结果');
  await h.setState({ ...h.state(), collapsedNodeIds: ['execution:carrier'] });
  const viewport = document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!;
  await act(() => {
    viewport.scrollTop = 190;
    viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  });
  const before = structuredClone(h.state());
  const reads = h.opened.length,
    loopReads = h.loopOpened.length;
  const panel = document.querySelector('.trajectory-panel')!;
  const children = [...panel.children];
  const rowIds = [...document.querySelectorAll<HTMLElement>('[data-trajectory-row]')].map(
    (row) => row.dataset.trajectoryRow,
  );
  expect(panel.querySelector('.trajectory-new-records')).toBeNull();
  expect(h.latestReturns()).toBe(0);
  for (const hint of [true, false, true]) {
    await h.render(false, false, hint);
    expect([...panel.children]).toEqual(children);
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-trajectory-row]')].map(
        (row) => row.dataset.trajectoryRow,
      ),
    ).toEqual(rowIds);
    expect(h.state()).toEqual(before);
    expect(document.querySelector<HTMLElement>('[aria-label="轨迹事件树"]')!.scrollTop).toBe(190);
    expect(h.opened).toHaveLength(reads);
    expect(h.loopOpened).toHaveLength(loopReads);
    expect(h.latestReturns()).toBe(0);
    const button = panel.querySelector<HTMLButtonElement>('.trajectory-new-records');
    expect(button !== null).toBe(hint);
    if (hint) {
      expect(button!.closest('.trajectory-toolbar')).toBe(panel.firstElementChild);
      expect(button!.textContent).toBe('返回最新');
      expect(button!.title).toContain('当前阅读位置保持不变');
      expect(
        panel.querySelector('.trajectory-toolbar [role="status"].sr-only')?.textContent,
      ).toContain('有新的执行记录');
    }
  }
  await act(() => panel.querySelector<HTMLButtonElement>('.trajectory-new-records')!.click());
  expect(h.latestReturns()).toBe(1);
  expect(h.state()).toEqual(before);
  expect(h.opened).toHaveLength(reads);
  expect(h.loopOpened).toHaveLength(loopReads);
});
