import { expect, test } from 'bun:test';
import type { OutputFilesPage } from '@kite-ai/client';
import { ConversationActivityContext } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';
import type { NativeOutputSource } from '../../src/output-files-bridge';

test('parent and child reference lists preserve source identity through late results and read recovery', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'Element',
    'NodeFilter',
    'CustomEvent',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key),
    });
  const { createRoot } = await import('react-dom/client');
  const { useNativeOutputFiles } = await import('../../src/native-output-files');
  const root = createRoot(document.getElementById('root')!);
  const sources: NativeOutputSource[] = [
    {
      sessionId: 'child-a',
      runId: 'a1',
      parentRunId: 'parent1',
      carrierExecutionId: 'ca1',
      name: '制表',
    },
    {
      sessionId: 'child-b',
      runId: 'b1',
      parentRunId: 'parent1',
      carrierExecutionId: 'cb1',
      name: '制表',
    },
    {
      sessionId: 'child-a',
      runId: 'a2',
      parentRunId: 'parent2',
      carrierExecutionId: 'ca2',
      name: '制表',
    },
  ];
  const calls: NativeRequest[] = [];
  let sourceFailure = false;
  let lateFile = false;
  let forgedFile = false;
  let holdSources: ((value: NativeResult) => void) | undefined;
  let sourceList = sources;
  const file = (sessionId: string, runId: string, fileId: string, name = '同名.xlsx') => ({
    storeId: 'store',
    sessionId,
    ownerRunId: runId,
    fileId,
    name,
    locator: { kind: 'delivery' as const, key: `delivery/1/${runId}/${fileId}` },
    size: '12',
    mediaType: 'application/octet-stream',
    publishedAt: '2026-11-16T01:00:00Z',
  });
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest): Promise<NativeResult> {
      calls.push(request);
      if (request.method === 'outputs.sources') {
        if (request.scope.sessionId === 'held')
          return await new Promise((resolve) => {
            holdSources = resolve;
          });
        if (sourceFailure) throw Error('disconnected');
        return {
          kind: 'outputs.sources',
          scope: request.scope,
          sources: request.scope.sessionId === 'parent' ? sourceList : [],
        };
      }
      if (request.method === 'outputs.query') {
        const session = request.scope.sessionId;
        const run = request.runId;
        const items =
          session === 'parent'
            ? run
              ? []
              : [
                  file(session, 'parent0', 'root-1', '原件1.txt'),
                  file(session, 'parent0', 'root-2', '原件2.txt'),
                  file(session, 'parent0', 'root-3', '原件3.txt'),
                ]
            : sourceList.some((source) => source.sessionId === session && source.runId === run)
              ? [
                  file(
                    forgedFile && session === 'child-b' ? 'foreign' : session,
                    run!,
                    `${session}-${run}`,
                  ),
                  ...(lateFile && run === 'a1' ? [file(session, run, 'late', '晚到.txt')] : []),
                ]
              : [];
        const page: OutputFilesPage = {
          scope: request.scope,
          revision: lateFile ? '2' : '1',
          items,
          collections:
            run === 'b1'
              ? [
                  {
                    collectionId: 'cb',
                    revision: '7',
                    ownerRunId: 'b1',
                    state: 'failed',
                    expectedCount: 2,
                    publishedCount: 1,
                    errorCode: 'archive_failed',
                    retryUntil: '2099-01-01T00:00:00Z',
                  },
                ]
              : [],
        };
        return { kind: 'outputs.page', page };
      }
      return null;
    },
  } as NativeBridge;
  const turn = (session: string, run: string) =>
    JSON.stringify(['native-run', 'store', session, run]);
  let latest: ReturnType<typeof useNativeOutputFiles>;
  function Harness({
    session = 'parent',
    revision = 1,
    childActive = true,
  }: {
    session?: string;
    revision?: number;
    childActive?: boolean;
  }) {
    const outputs = useNativeOutputFiles({
      bridge,
      generation: 1,
      storeId: 'store',
      sessionId: session,
      revision,
      onEdit: async () => {},
      turnLabel: (id) => `轮次 ${id}`,
    });
    latest = outputs;
    return (
      <>
        <output data-testid="target">{JSON.stringify(outputs.request?.target)}</output>
        <div data-testid="reference-panel">{outputs.references}</div>
        <section data-testid="first">
          {outputs.renderTurnOutputs({ turnId: turn(session, 'parent1') })}
        </section>
        <section data-testid="second">
          {outputs.renderTurnOutputs({ turnId: turn(session, 'parent2') })}
        </section>
        <ConversationActivityContext value={{ readActive: childActive, resume: 0 }}>
          <section data-testid="child">
            {outputs.renderChildTurnOutputs('child-a', { turnId: turn('child-a', 'a1') })}
          </section>
        </ConversationActivityContext>
      </>
    );
  }
  const settle = async () => {
    await act(async () => {
      await Bun.sleep(140);
    });
    await act(async () => {
      await Bun.sleep(140);
    });
  };
  const render = async (props: Parameters<typeof Harness>[0]) => {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
    await settle();
  };
  const first = () => document.querySelector('[data-testid="first"]')!;
  const second = () => document.querySelector('[data-testid="second"]')!;
  const referencePanel = () => document.querySelector('[data-testid="reference-panel"]')!;
  try {
    await render({});
    expect(first().querySelectorAll('.output-file-card')).toHaveLength(2);
    expect(second().querySelectorAll('.output-file-card')).toHaveLength(1);
    expect(
      document.querySelector('[data-testid="child"]')?.querySelectorAll('.output-file-card'),
    ).toHaveLength(1);
    expect(first().textContent).toContain('来自子 Agent · 制表');
    const references = document.querySelector('[aria-label="输出"]')!;
    expect(references.querySelectorAll('li')).toHaveLength(6);
    expect(
      calls
        .filter((call) => call.method === 'outputs.query' && call.scope.sessionId === 'child-a')
        .every((call) => call.method === 'outputs.query' && ['a1', 'a2'].includes(call.runId!)),
    ).toBe(true);
    const card = first().querySelector('.output-file-card')!;
    await act(async () => {
      card.querySelector<HTMLButtonElement>('[aria-label="打开 同名.xlsx"]')!.click();
    });
    expect(latest!.request?.target).toEqual({
      storeId: 'store',
      sessionId: 'child-a',
      fileId: 'child-a-a1',
      locator: { kind: 'delivery', key: 'delivery/1/a1/child-a-a1' },
    });
    expect(first().querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(first().textContent).not.toContain('重试整理');
    expect(referencePanel().querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(referencePanel().textContent).not.toMatch(/重试整理|文件整理|archive_failed/);
    // A child collection can arrive after a newer parent turn exists. The old turn owns it.
    lateFile = true;
    await render({ revision: 2 });
    expect(first().textContent).toContain('晚到.txt');
    expect(second().textContent).not.toContain('晚到.txt');
    expect(first().querySelector('.output-file-card')).toBe(card);
    const verifiedReferences = referencePanel().textContent;
    const verifiedLink = referencePanel().querySelector('.output-reference-link');
    expect(verifiedReferences).toContain('晚到.txt');
    // An unavailable source directory keeps the verified list visible.
    sourceFailure = true;
    await render({ revision: 3 });
    expect(first().querySelectorAll('.output-file-card')).toHaveLength(3);
    expect(referencePanel().textContent).toBe(verifiedReferences);
    expect(referencePanel().querySelector('.output-reference-link')).toBe(verifiedLink);
    const sourceReads = calls.filter((call) => call.method === 'outputs.sources').length;
    sourceFailure = false;
    await act(async () => {
      await Bun.sleep(650);
    });
    await settle();
    expect(calls.filter((call) => call.method === 'outputs.sources').length).toBeGreaterThan(
      sourceReads,
    );
    expect(referencePanel().textContent).toBe(verifiedReferences);
    // A mixed-scope page cannot replace the previous verified child page.
    forgedFile = true;
    await render({ revision: 4 });
    expect(first().querySelectorAll('.output-file-card')).toHaveLength(3);
    expect(first().textContent).not.toContain('读取文件失败');
    expect(referencePanel().textContent).toBe(verifiedReferences);
    expect(latest!.request?.target.sessionId).toBe('child-a');
    forgedFile = false;
    await act(async () => {
      await Bun.sleep(650);
    });
    await settle();
    expect(first().textContent).not.toContain('读取文件失败');
    expect(referencePanel().textContent).toBe(verifiedReferences);
    expect(calls.some((call) => call.method === 'outputs.retry')).toBe(false);
    // Pausing the child detail keeps the exact card, with no child-detail background read.
    const childCard = document.querySelector('[data-testid="child"] .output-file-card');
    await render({ revision: 4, childActive: false });
    expect(document.querySelector('[data-testid="child"] .output-file-card')).toBe(childCard);
    // Removing an authorized source removes only its presentation, never rewrites ownership.
    sourceList = [sources[1]!, sources[2]!];
    await render({ revision: 5 });
    expect(latest!.request).toBeUndefined();
    expect(second().querySelectorAll('.output-file-card')).toHaveLength(1);
    sourceList = [sources[1]!];
    await render({ revision: 6 });
    expect(first().querySelectorAll('.output-file-card')).toHaveLength(1);
    expect(second().querySelectorAll('.output-file-card')).toHaveLength(0);
    expect(latest!.request).toBeUndefined();
    sourceFailure = true;
    await render({ session: 'cancel-retry', revision: 7 });
    const cancelledReads = calls.filter(
      (call) => call.method === 'outputs.sources' && call.scope.sessionId === 'cancel-retry',
    ).length;
    sourceFailure = false;
    await render({ session: 'other', revision: 8 });
    await act(async () => {
      await Bun.sleep(650);
    });
    expect(
      calls.filter(
        (call) => call.method === 'outputs.sources' && call.scope.sessionId === 'cancel-retry',
      ),
    ).toHaveLength(cancelledReads);
    // Old source-directory replies cannot inject children into a later parent selection.
    await render({ session: 'held', revision: 6 });
    expect(holdSources).toBeDefined();
    await render({ session: 'other', revision: 7 });
    await act(async () => {
      holdSources!({
        kind: 'outputs.sources',
        scope: { storeId: 'store', sessionId: 'held' },
        sources,
      });
    });
    await settle();
    expect(document.querySelectorAll('.output-file-card')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('同名.xlsx');
    expect(latest!.request).toBeUndefined();
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15000);
