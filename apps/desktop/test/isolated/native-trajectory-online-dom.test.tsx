import { createHash } from 'node:crypto';
import {
  type TrajectoryEvent,
  type TrajectorySnapshot,
  trajectoryIdentityPayload,
} from '@kite-ai/trajectory';
import type { TrajectoryViewState } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { afterAll, expect, mock, test } from '#kite-test';
import type {
  NativeBridge,
  NativeEvent,
  NativeRequest,
  NativeResult,
} from '../../src/native-bridge';
import type { NativeTrajectoryLoaded } from '../../src/trajectory-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

// Exercise the real online host, projector, Panel and material reader. The disk-section cache
// is the only replaced boundary; its independent loader/IndexedDB tests remain responsible for IO.
const originalBridge = await import('../../src/trajectory-bridge');
const openSnapshot = originalBridge.openNativeTrajectorySnapshot;
const loads: { generation: number; snapshot: TrajectorySnapshot; closed: boolean }[] = [];
const sourceReads: string[] = [];
const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
const origin = { storeId: 'original', cursor: '1' };
const fact: TrajectoryEvent = {
  schema: 'kite.trajectory',
  schemaVersion: 1,
  eventId: `te_${createHash('sha256').update(trajectoryIdentityPayload(origin)).digest('hex')}`,
  sequence: '1',
  origin,
  sessionId: 'session',
  workspaceId: 'workspace',
  executionId: 'model',
  executionOriginStoreId: 'original',
  sourceEventType: 'execution.finished',
  sourceRecordRevision: '1',
  kind: 'model',
  phase: 'completed',
  recordedStatus: 'succeeded',
  occurredAt: 1,
  identityConfidence: 'verified_origin',
  attributes: { definitionId: 'fixture', definitionVersion: '1', resultRevision: '1' },
  evidenceRefs: [
    {
      evidenceId: 'original-ref',
      contentVersion: 'original-version',
      kind: 'model_output',
      availability: 'available',
      mediaType: 'application/json',
    },
  ],
};
const laterOrigin = { storeId: 'original', cursor: '2' };
const laterFact: TrajectoryEvent = {
  ...fact,
  eventId: `te_${createHash('sha256').update(trajectoryIdentityPayload(laterOrigin)).digest('hex')}`,
  sequence: '2',
  origin: laterOrigin,
  sourceRecordRevision: '2',
  occurredAt: 2,
  evidenceRefs: [
    { ...fact.evidenceRefs[0]!, evidenceId: 'FUTURE_REF', contentVersion: 'FUTURE_VERSION' },
  ],
};
function snapshot(upperCursor = '2'): TrajectorySnapshot {
  return {
    storeId: 'store',
    sessionId: 'session',
    upperCursor,
    formatVersion: 1,
    historyCoverage: { enabledAfterCursor: '0', upperCursor, status: 'retained', integrity },
  };
}
mock.module('../../src/trajectory-bridge', () => ({
  ...originalBridge,
  openNativeTrajectorySnapshot: openSnapshot,
  async loadNativeTrajectory(input: {
    generation: number;
    snapshot: TrajectorySnapshot;
    signal?: AbortSignal;
  }) {
    const record = { generation: input.generation, snapshot: input.snapshot, closed: false };
    loads.push(record);
    return {
      source: {
        snapshot: input.snapshot,
        offline: false,
        minimumCursor: '0',
        async readEvents(request: { afterCursor: string; upperCursor: string }) {
          input.signal?.throwIfAborted();
          sourceReads.push(`${input.generation}:${request.upperCursor}`);
          return {
            storeId: input.snapshot.storeId,
            sessionId: input.snapshot.sessionId,
            afterCursor: request.afterCursor,
            upperCursor: request.upperCursor,
            scannedThrough: request.upperCursor,
            exhausted: true,
            integrity,
            events: [fact, laterFact].filter(
              (event) =>
                BigInt(event.sequence) > BigInt(request.afterCursor) &&
                BigInt(event.sequence) <= BigInt(request.upperCursor),
            ),
          };
        },
        clearCache() {},
      },
      async close() {
        record.closed = true;
      },
    } as unknown as NativeTrajectoryLoaded;
  },
}));
const bootstrap = new JSDOM('<!doctype html><div></div>');
const previousBootstrap = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { initialTrajectoryViewState } = await import('@kite-ai/ui/desktop');
const { NativeTrajectory } = await import('../../src/native-trajectory');
Object.assign(globalThis, previousBootstrap);
bootstrap.window.close();
afterAll(() => mock.restore());

async function flush() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await flush();
  }
  expect(check()).toBe(true);
}
async function fixture(run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
  const h = await harness();
  try {
    await run(h);
  } finally {
    await h.close();
  }
}
async function harness() {
  loads.length = 0;
  sourceReads.length = 0;
  const dom = new JSDOM('<!doctype html><main id="root"></main>', { pretendToBeVisual: true }),
    restore = prepareDesktopDom(dom);
  const before = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const state: TrajectoryViewState = {
    ...initialTrajectoryViewState(snapshot()),
    mode: 'history' as const,
    cursor: '1',
    selectedNodeId: 'execution:model',
    detailOpen: true,
    workbenchTab: 'preview' as const,
    filters: {
      duration: 'all' as const,
      runKeys: null,
      types: ['message', 'model', 'tool', 'compression', 'approval'],
      includeAdministrative: false,
      subcalls: 'all' as const,
      metadataQuery: 'does-not-match',
    },
  };
  const cache = new Map<string, TrajectoryViewState>([
    [JSON.stringify(['store', 'session']), structuredClone(state) as TrajectoryViewState],
  ]);
  const calls: NativeRequest[] = [],
    closes: { generation: number; readId: string }[] = [];
  const opens: { generation: number; readId: string; release(): void }[] = [];
  let listener: ((event: NativeEvent) => void) | undefined;
  let upper = '2',
    holdWake = false,
    releaseWake: (() => void) | undefined;
  let generation = 1,
    selection = 1;
  const descriptors = new Map<string, { bytes: Buffer; hash: string }>();
  const bridge: NativeBridge = {
    watch(value) {
      listener = value;
      return () => {
        if (listener === value) listener = undefined;
      };
    },
    async request(input) {
      calls.push(input);
      if (input.method === 'trajectory.open') {
        const result = snapshot(upper);
        if (holdWake) {
          holdWake = false;
          await new Promise<void>((resolve) => {
            releaseWake = resolve;
          });
        }
        return { kind: 'trajectory.snapshot', trajectory: result };
      }
      if (input.method === 'trajectory.events')
        return {
          kind: 'trajectory.page',
          trajectory: {
            ...input.request,
            scannedThrough: input.request.upperCursor,
            exhausted: true,
            integrity,
            events: [],
          },
        };
      if (input.method === 'trajectory.evidence.open') {
        const readId = `g${input.generation}-open${opens.length}`,
          bytes = Buffer.from(
            JSON.stringify({
              content: `BODY_GENERATION_${input.generation}`,
              reasoning: `THOUGHT_GENERATION_${input.generation}`,
              toolCalls: [],
              complete: true,
            }),
          );
        const hash = createHash('sha256').update(bytes).digest('hex');
        descriptors.set(readId, { bytes, hash });
        return new Promise<NativeResult>((resolve) =>
          opens.push({
            generation: input.generation,
            readId,
            release: () =>
              resolve({
                kind: 'trajectory.evidence.opened',
                trajectory: {
                  readId,
                  eventId: input.request.eventId,
                  evidenceId: input.request.evidenceId,
                  contentVersion: input.request.contentVersion,
                  availability: 'available',
                  mediaType: 'application/json',
                  viewBytes: String(bytes.length),
                  viewSha256: hash,
                  policyRevision: '1',
                  authorizationEpoch: '1',
                  transformation: 'fixture@1',
                },
              }),
          }),
        );
      }
      if (input.method === 'trajectory.evidence.read') {
        const saved = descriptors.get(input.request.readId)!;
        return {
          kind: 'trajectory.evidence.chunk',
          trajectory: {
            readId: input.request.readId,
            offset: input.request.offset,
            nextOffset: String(saved.bytes.length),
            data: saved.bytes.toString('base64'),
            eof: true,
            viewSha256: saved.hash,
            policyRevision: '1',
            authorizationEpoch: '1',
          },
        };
      }
      if (input.method === 'trajectory.evidence.close') {
        closes.push({ generation: input.generation, readId: input.request.readId });
        return null;
      }
      if (input.method === 'trajectory.cancel') return null;
      throw Error('unexpected_fixture_request');
    },
  };
  const render = async () => {
    await act(async () =>
      root.render(
        <NativeTrajectory
          bridge={bridge}
          generation={generation}
          storeId="store"
          sessionId="session"
          selection={selection}
          stateCache={cache}
        />,
      ),
    );
    await flush();
  };
  return {
    host,
    calls,
    opens,
    closes,
    cache,
    render,
    sourceReads,
    state: () => cache.get(JSON.stringify(['store', 'session']))!,
    async replace(nextGeneration: number, nextSelection = selection) {
      generation = nextGeneration;
      selection = nextSelection;
      await render();
    },
    async unmount() {
      await act(() => root.render(null));
    },
    async visibility(value: 'visible' | 'hidden') {
      await act(() => {
        Object.defineProperty(dom.window.document, 'visibilityState', {
          configurable: true,
          value,
        });
        dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      });
    },
    async release(index: number) {
      await act(async () => {
        opens[index]!.release();
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    },
    async wakeAndQuit(nextUpper: string) {
      upper = nextUpper;
      holdWake = true;
      await act(() => listener!({ kind: 'changed', generation }));
      await until(() => releaseWake !== undefined);
      await act(() => listener!({ kind: 'lifecycle', phase: 'quitting' }));
    },
    async releaseWake() {
      await act(async () => {
        releaseWake!();
        releaseWake = undefined;
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    },
    async close() {
      for (const item of opens) item.release();
      releaseWake?.();
      await act(() => root.unmount());
      await flush();
      restore();
      dom.window.close();
      Object.assign(globalThis, before);
    },
  };
}

test('online fixed as-of retains filtered-out selection and original ref while generation, selection and reopen cancel pending materials', async () => {
  await fixture(async (h) => {
    await h.render();
    await until(() => h.opens.length === 1);
    expect(h.state()).toMatchObject({
      cursor: '1',
      mode: 'history',
      selectedNodeId: 'execution:model',
      descriptor: { upperCursor: '2' },
    });
    expect(h.host.textContent).toContain('此记录不在当前筛选结果中');
    expect(loads).toHaveLength(1);
    expect(h.sourceReads).toEqual(['1:2']);
    const first = h.calls.find((call) => call.method === 'trajectory.evidence.open');
    expect(first).toMatchObject({
      generation: 1,
      request: {
        upperCursor: '2',
        atCursor: '1',
        evidenceId: 'original-ref',
        contentVersion: 'original-version',
      },
    });
    await h.replace(2);
    await until(() => h.opens.length === 2);
    await h.release(0);
    expect(h.closes).toContainEqual({ generation: 1, readId: h.opens[0]!.readId });
    expect(h.host.textContent).not.toContain('BODY_GENERATION_1');
    expect(h.host.textContent).not.toContain('THOUGHT_GENERATION_1');
    await h.replace(2, 2);
    await until(() => h.opens.length === 3);
    await h.release(1);
    expect(h.closes).toContainEqual({ generation: 2, readId: h.opens[1]!.readId });
    expect(h.host.textContent).not.toContain('BODY_GENERATION_2');
    await h.unmount();
    await h.release(2);
    expect(h.closes).toContainEqual({ generation: 2, readId: h.opens[2]!.readId });
    await h.replace(2, 3);
    await until(() => h.opens.length === 4);
    await h.release(3);
    expect(h.host.textContent).toContain('THOUGHT_GENERATION_2');
    expect(h.host.textContent).not.toContain('BODY_GENERATION_2');
    expect(h.state()).toMatchObject({
      cursor: '1',
      mode: 'history',
      selectedNodeId: 'execution:model',
      filters: { metadataQuery: 'does-not-match' },
    });
    expect(
      h.calls.filter((call) => call.method === 'trajectory.cancel').length,
    ).toBeGreaterThanOrEqual(3);
    const reads = h.sourceReads.length,
      opens = h.opens.length;
    const clear = [...h.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '清除筛选',
    )!;
    expect(clear).toBeDefined();
    await act(() => clear.click());
    await flush();
    expect(h.state()).toMatchObject({
      cursor: '1',
      mode: 'history',
      selectedNodeId: 'execution:model',
      filters: { metadataQuery: '' },
    });
    expect(h.sourceReads).toHaveLength(reads);
    // Clearing the filter admits exactly this one visible loop, not the future checkpoint.
    expect(h.opens).toHaveLength(opens + 1);
    expect(
      h.calls.filter((call) => call.method === 'trajectory.evidence.open').at(-1),
    ).toMatchObject({
      request: { atCursor: '1', evidenceId: 'original-ref', contentVersion: 'original-version' },
    });
    expect(
      h.calls.some(
        (call) =>
          call.method === 'trajectory.evidence.open' && call.request.evidenceId === 'FUTURE_REF',
      ),
    ).toBe(false);
  });
});

async function showReplay(host: HTMLElement) {
  const window = host.ownerDocument.defaultView!;
  await act(() =>
    host
      .querySelector<HTMLElement>('[aria-label="更多轨迹操作"]')!
      .dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 })),
  );
  const item = [
    ...host.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
  ].find((element) => element.textContent === '显示回放控制')!;
  expect(item).toBeDefined();
  await act(() => item.click());
}

test('online hiding pauses replay and cancels late material, visibility restoration does not resume playback', async () => {
  await fixture(async (h) => {
    await h.render();
    await until(() => h.opens.length === 1);
    await showReplay(h.host);
    await act(() => h.host.querySelector<HTMLButtonElement>('[aria-label="播放轨迹"]')!.click());
    expect(h.host.querySelector('[aria-label="暂停轨迹"]')).not.toBeNull();
    await h.visibility('hidden');
    expect(h.host.querySelector('[aria-label="播放轨迹"]')).not.toBeNull();
    const reads = h.sourceReads.length;
    await h.release(0);
    expect(h.closes).toContainEqual({ generation: 1, readId: h.opens[0]!.readId });
    expect(h.host.textContent).not.toContain('BODY_GENERATION_1');
    expect(h.host.textContent).not.toContain('THOUGHT_GENERATION_1');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
    expect(h.sourceReads).toHaveLength(reads);
    expect(h.state().cursor).toBe('1');
    await h.visibility('visible');
    await until(() => h.opens.length === 2);
    expect(h.host.querySelector('[aria-label="播放轨迹"]')).not.toBeNull();
    expect(h.host.querySelector('[aria-label="暂停轨迹"]')).toBeNull();
    expect(h.state()).toMatchObject({ mode: 'replay', cursor: '1' });
  });
});

test('a new online player loaded while document is hidden cannot play or open materials until visible', async () => {
  await fixture(async (h) => {
    await h.visibility('hidden');
    await h.render();
    await until(() => loads.length === 1);
    await flush();
    await showReplay(h.host);
    expect(h.opens).toHaveLength(0);
    await act(() => h.host.querySelector<HTMLButtonElement>('[aria-label="播放轨迹"]')!.click());
    expect(h.host.querySelector('[aria-label="暂停轨迹"]')).toBeNull();
    expect(h.state()).toMatchObject({ mode: 'history', cursor: '1' });
    await h.visibility('visible');
    await until(() => h.opens.length === 1);
    expect(h.host.querySelector('[aria-label="播放轨迹"]')).not.toBeNull();
    expect(h.host.querySelector('[aria-label="暂停轨迹"]')).toBeNull();
  });
});

for (const nextUpper of ['2', '5'])
  test(`quitting rejects a late wake upper ${nextUpper} without clearing error or probing history`, async () => {
    await fixture(async (h) => {
      await h.render();
      await until(() => h.calls.filter((call) => call.method === 'trajectory.open').length >= 2);
      await flush();
      const probes = h.calls.filter((call) => call.method === 'trajectory.events').length;
      await h.wakeAndQuit(nextUpper);
      expect(h.host.textContent).toContain('trajectory_connection_unavailable');
      await h.releaseWake();
      expect(h.host.textContent).toContain('trajectory_connection_unavailable');
      expect(h.calls.filter((call) => call.method === 'trajectory.events')).toHaveLength(probes);
      expect(h.state()).toMatchObject({
        cursor: '1',
        mode: 'history',
        descriptor: { upperCursor: '2' },
      });
    });
  });

test('the real online host retains request selection and four tabs, reads no body for usage/timing and returns focus to its boundary', async () => {
  await fixture(async (h) => {
    await h.render();
    await until(() => h.opens.length === 1);
    await h.release(0);
    await act(() =>
      [...h.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '清除筛选')!
        .click(),
    );
    await until(() => h.opens.length === 2);
    await h.release(1);
    expect(h.host.textContent).toContain('THOUGHT_GENERATION_1');
    expect(h.host.querySelector('[aria-label="选中节点详情"]')?.textContent).not.toContain(
      'BODY_GENERATION_1',
    );
    const marker = h.host.querySelector<HTMLButtonElement>('.trajectory-request-marker')!;
    expect(marker).not.toBeNull();
    await act(() => marker.click());
    await until(() => h.host.querySelector('[aria-label="模型请求详情"]') !== null);
    expect(h.state()).toMatchObject({
      selectedRequestId: 'execution:model',
      requestTab: 'overview',
      cursor: '1',
    });
    expect(
      [...h.host.querySelectorAll('[aria-label="请求详情"] [role="tab"]')].map(
        (tab) => tab.textContent,
      ),
    ).toEqual(['概述', '选项', '用量', '计时']);
    const opens = h.opens.length;
    const chunks = h.calls.filter((call) => call.method === 'trajectory.evidence.read').length;
    for (const [label, tab] of [
      ['用量', 'usage'],
      ['计时', 'timing'],
    ] as const) {
      const button = [
        ...h.host.querySelectorAll<HTMLElement>('[aria-label="请求详情"] [role="tab"]'),
      ].find((button) => button.textContent === label)!;
      await act(() =>
        button.dispatchEvent(
          new h.host.ownerDocument.defaultView!.MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
          }),
        ),
      );
      await flush();
      expect(h.state()).toMatchObject({
        selectedRequestId: 'execution:model',
        requestTab: tab,
        cursor: '1',
      });
      expect(h.opens).toHaveLength(opens);
      expect(h.calls.filter((call) => call.method === 'trajectory.evidence.read')).toHaveLength(
        chunks,
      );
    }
    await act(() =>
      h.host.querySelector<HTMLButtonElement>('[aria-label="关闭请求详情"]')!.click(),
    );
    await until(() => h.host.querySelector('[aria-label="模型请求详情"]') === null);
    await until(
      () =>
        h.host.ownerDocument.activeElement === h.host.querySelector('.trajectory-request-marker'),
    );
    expect(
      h.calls.every((call) =>
        [
          'trajectory.open',
          'trajectory.events',
          'trajectory.evidence.open',
          'trajectory.evidence.read',
          'trajectory.evidence.close',
          'trajectory.cancel',
        ].includes(call.method),
      ),
    ).toBe(true);
    expect(
      h.calls
        .filter((call) => call.method === 'trajectory.evidence.open')
        .every(
          (call) =>
            call.method === 'trajectory.evidence.open' &&
            call.request.evidenceId === 'original-ref' &&
            call.request.contentVersion === 'original-version' &&
            call.request.atCursor === '1',
        ),
    ).toBe(true);
  });
});
