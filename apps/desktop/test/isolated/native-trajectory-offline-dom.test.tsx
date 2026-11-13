import { createHash } from 'node:crypto';
import { createTrajectoryEventId, type TrajectoryEvent } from '@kite-ai/trajectory';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { expect, test } from '#kite-test';
import type {
  NativeTrajectoryFileBridge,
  NativeTrajectoryFileRequest,
  NativeTrajectoryFileResult,
} from '../../src/native-trajectory-file-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<!doctype html><div></div>');
const oldBootstrap = {
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
const { OfflineTrajectoryViewer } = await import('../../src/native-trajectory-offline');
Object.assign(globalThis, oldBootstrap);
bootstrap.window.close();
const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
const snapshot = {
  storeId: 'store',
  sessionId: 'session',
  upperCursor: '3',
  formatVersion: 1 as const,
  historyCoverage: {
    enabledAfterCursor: '0',
    upperCursor: '3',
    status: 'retained' as const,
    integrity,
  },
};
const evidenceOrigin = { storeId: 'original', cursor: '1' };
const evidenceEvent: TrajectoryEvent = {
  schema: 'kite.trajectory',
  schemaVersion: 1,
  eventId: await createTrajectoryEventId(evidenceOrigin),
  sequence: '1',
  origin: evidenceOrigin,
  workspaceId: 'workspace',
  sessionId: 'session',
  executionId: 'model',
  sourceEventType: 'execution.succeeded',
  sourceRecordRevision: '1',
  identityConfidence: 'verified_origin',
  kind: 'model',
  phase: 'completed',
  recordedStatus: 'succeeded',
  occurredAt: 2,
  attributes: { definitionId: 'fixture', resultRevision: '1' },
  evidenceRefs: [
    {
      evidenceId: 'saved-output',
      contentVersion: 'original-v1',
      kind: 'model_output',
      availability: 'available',
      mediaType: 'application/json',
    },
  ],
};
function opened(id: string): NativeTrajectoryFileResult {
  return { kind: 'trajectory.bundle.opened', bundleId: id, snapshot, minimumCursor: '0' };
}
async function fixture(
  run: (value: {
    host: HTMLElement;
    calls: NativeTrajectoryFileRequest[];
    retired: string[];
    root: ReturnType<typeof createRoot>;
    render(): Promise<void>;
    reopen(): Promise<void>;
    release(): void;
    holdRead(): void;
    failNextRead(code: string): void;
    failNextPick(code: string): void;
  }) => Promise<void>,
  late = false,
  evidenceCode?: string,
  facts?: TrajectoryEvent[],
) {
  const dom = new JSDOM('<!doctype html><main id="root"></main>', { pretendToBeVisual: true }),
    restore = prepareDesktopDom(dom),
    old = {
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
    root = createRoot(host),
    calls: NativeTrajectoryFileRequest[] = [];
  let serial = 0;
  let release = () => {};
  let heldRead: Promise<void> | undefined;
  let readFailure: string | undefined;
  let pickFailure: string | undefined;
  let currentBundle: string | undefined;
  const retired: string[] = [];
  const materials = new Map<string, { bytes: Buffer; hash: string }>();
  const files: NativeTrajectoryFileBridge = {
    async request(input) {
      calls.push(structuredClone(input));
      if (input.method === 'pick') {
        if (pickFailure) {
          const failure = pickFailure;
          pickFailure = undefined;
          throw Error(failure);
        }
        serial++;
        const next = `bundle-${serial}`;
        const select = () => {
          if (currentBundle) retired.push(currentBundle);
          currentBundle = next;
          return opened(next);
        };
        if (late)
          return new Promise((resolve) => {
            release = () => resolve(select());
          });
        return select();
      }
      if ('bundleId' in input && input.bundleId !== currentBundle)
        throw Error('trajectory_bundle_view_changed');
      if (input.method === 'close') {
        currentBundle = undefined;
        return null;
      }
      if (input.method === 'events') {
        if (heldRead) {
          const pending = heldRead;
          heldRead = undefined;
          await pending;
        }
        if (readFailure) {
          const failure = readFailure;
          readFailure = undefined;
          throw Error(failure);
        }
        const { limit: _limit, ...scope } = input.request;
        return {
          kind: 'trajectory.page',
          trajectory: {
            ...scope,
            events: (facts ?? (evidenceCode ? [evidenceEvent] : [])).filter(
              (event) =>
                BigInt(event.sequence) > BigInt(scope.afterCursor) &&
                BigInt(event.sequence) <= BigInt(scope.upperCursor),
            ),
            scannedThrough: scope.upperCursor,
            exhausted: true,
            integrity,
          },
        };
      }
      if (input.method === 'evidence.open') {
        const event = (facts ?? [evidenceEvent]).find(
          (event) => event.eventId === input.request.eventId,
        );
        expect(event).toBeDefined();
        expect(
          event!.evidenceRefs.some(
            (ref) =>
              ref.evidenceId === input.request.evidenceId &&
              ref.contentVersion === input.request.contentVersion,
          ),
        ).toBe(true);
        expect(input.request).toMatchObject({
          storeId: 'store',
          sessionId: 'session',
          upperCursor: '3',
          atCursor: event!.sequence,
        });
        if (evidenceCode) throw Error(evidenceCode);
        const readId = `offline-evidence-${materials.size}`;
        const bytes = Buffer.from(
          JSON.stringify({
            content: 'ORIGINAL_OFFLINE_REPLY',
            reasoning: 'ORIGINAL_OFFLINE_THOUGHT',
            toolCalls: [],
            complete: true,
          }),
        );
        const hash = createHash('sha256').update(bytes).digest('hex');
        materials.set(readId, { bytes, hash });
        return {
          kind: 'trajectory.evidence.opened',
          trajectory: {
            readId,
            eventId: event!.eventId,
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
        };
      }
      if (input.method === 'evidence.read') {
        const material = materials.get(input.readId);
        expect(material).toBeDefined();
        return {
          kind: 'trajectory.evidence.chunk',
          trajectory: {
            readId: input.readId,
            offset: input.offset,
            nextOffset: String(material!.bytes.length),
            data: material!.bytes.toString('base64'),
            eof: true,
            viewSha256: material!.hash,
            policyRevision: '1',
            authorizationEpoch: '1',
          },
        };
      }
      return null;
    },
  };
  let unmounted = false;
  let viewer = 0;
  const render = async () => {
    await act(async () => root.render(<OfflineTrajectoryViewer key={viewer} files={files} />));
  };
  try {
    await run({
      host,
      calls,
      retired,
      root,
      render,
      async reopen() {
        viewer++;
        await render();
      },
      release: () => release(),
      holdRead() {
        heldRead = new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      failNextRead(code) {
        readFailure = code;
      },
      failNextPick(code) {
        pickFailure = code;
      },
    });
  } finally {
    if (!unmounted) {
      await act(async () => root.unmount());
      unmounted = true;
    }
    // Radix restores focus in the following task; finish it while this DOM still owns globals.
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    restore();
    dom.window.close();
    Object.assign(globalThis, old);
  }
}

async function showReplayControls(host: HTMLElement) {
  if (host.querySelector('[aria-label="轨迹位置"]')) return;
  const window = host.ownerDocument.defaultView!;
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="更多轨迹操作"]')!
      .dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 })),
  );
  const item = [
    ...host.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
  ].find((element) => element.textContent === '显示回放控制')!;
  expect(item).toBeDefined();
  await act(async () => item.click());
  expect(host.querySelector('[aria-label="轨迹位置"]')).not.toBeNull();
}

async function chooseNode(host: HTMLElement, id: string) {
  const node = host.querySelector<HTMLButtonElement>(
    `[data-trajectory-node="${id}"] .trajectory-node-select`,
  )!;
  expect(node).not.toBeNull();
  await act(async () => node.click());
}

async function showAll(host: HTMLElement) {
  const window = host.ownerDocument.defaultView!;
  await act(async () =>
    host
      .querySelector<HTMLElement>('[aria-label="更多轨迹操作"]')!
      .dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 })),
  );
  const item = [
    ...host.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'),
  ].find((element) => element.textContent === '显示全部事件')!;
  expect(item).toBeDefined();
  await act(async () => item.click());
}
function expectBoundedReadOnlyView(
  host: HTMLElement,
  calls: NativeTrajectoryFileRequest[],
  allowed: readonly TrajectoryEvent[] = [],
) {
  expect(
    [...host.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === '生命周期'),
  ).toBe(false);
  expect(host.querySelector('.trajectory-lifecycle')).toBeNull();
  const opens = calls.filter((call) => call.method === 'evidence.open');
  if (!allowed.length) expect(opens).toHaveLength(0);
  for (const call of opens) {
    if (call.method !== 'evidence.open') continue;
    const event = allowed.find((event) => event.eventId === call.request.eventId);
    expect(event).toBeDefined();
    expect(call.request).toMatchObject({
      storeId: 'store',
      sessionId: 'session',
      upperCursor: '3',
      atCursor: event!.sequence,
    });
    expect(
      event!.evidenceRefs.some(
        (ref) =>
          ref.evidenceId === call.request.evidenceId &&
          ref.contentVersion === call.request.contentVersion,
      ),
    ).toBe(true);
  }
  expect(
    new Set(
      opens.map((call) =>
        call.method === 'evidence.open'
          ? `${call.request.eventId}:${call.request.evidenceId}:${call.request.contentVersion}`
          : '',
      ),
    ).size,
  ).toBeLessThanOrEqual(allowed.reduce((sum, event) => sum + event.evidenceRefs.length, 0));
}
async function seek(host: HTMLElement, cursor: string) {
  await showReplayControls(host);
  const input = host.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')!,
    window = host.ownerDocument.defaultView!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      cursor,
    );
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === '跳转')!.click(),
  );
  return input;
}
test('cold viewer closes a late picked bundle after unmount without adopting its source', async () =>
  fixture(async ({ root, calls, render, release }) => {
    await render();
    await act(async () => root.unmount());
    await act(async () => release());
    expect(calls).toEqual([{ method: 'pick' }, { method: 'close', bundleId: 'bundle-1' }]);
  }, true));
test('cold viewer trusts Main retirement on successful replacements and keeps real pick failures visible', async () =>
  fixture(async ({ host, calls, retired, render, failNextPick }) => {
    await render();
    const choose = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '选择轨迹文件',
    )!;
    await act(async () => choose.click());
    await act(async () => choose.click());
    expect(retired).toEqual(['bundle-1', 'bundle-2']);
    expect(calls.filter((call) => call.method === 'close')).toEqual([]);
    expect(host.textContent).not.toContain('trajectory_bundle_view_changed');
    await showReplayControls(host);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="轨迹位置"]')!,
      window = input.ownerDocument.defaultView!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '1',
      );
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === '跳转')!.click(),
    );
    await act(async () => host.querySelector<HTMLElement>('[aria-label="播放轨迹"]')!.click());
    expect(host.querySelector('[aria-label="暂停轨迹"]')).not.toBeNull();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
    expect(host.querySelector('[aria-label="播放轨迹"]')).not.toBeNull();
    expect(calls.every((call) => ['pick', 'events', 'close'].includes(call.method))).toBe(true);
    failNextPick('trajectory_bundle_close_unconfirmed');
    await act(async () => choose.click());
    expect(host.textContent).toContain('trajectory_bundle_close_unconfirmed');
    expect(retired).toEqual(['bundle-1', 'bundle-2']);
  }));

test('seek commits its visible cursor only with the complete verified local prefix', async () =>
  fixture(async ({ host, render, holdRead, release }) => {
    await render();
    await showReplayControls(host);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="轨迹位置"]')!,
      window = input.ownerDocument.defaultView!;
    expect(input.value).toBe('3');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '1',
      );
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    holdRead();
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === '跳转')!.click(),
    );
    expect(input.value).toBe('3');
    await act(async () => release());
    expect(input.value).toBe('1');
  }));

const otherEvent: TrajectoryEvent = {
  ...evidenceEvent,
  eventId: await createTrajectoryEventId({ storeId: 'original', cursor: '2' }),
  sequence: '2',
  origin: { storeId: 'original', cursor: '2' },
  executionId: 'other-tool',
  kind: 'tool',
  sourceEventType: 'execution.succeeded',
  attributes: { definitionId: 'other-tool' },
  evidenceRefs: [],
};
const managementEvent: TrajectoryEvent = {
  ...evidenceEvent,
  eventId: await createTrajectoryEventId({ storeId: 'original', cursor: '3' }),
  sequence: '3',
  origin: { storeId: 'original', cursor: '3' },
  executionId: undefined,
  kind: 'command',
  sourceEventType: 'command.accepted',
  attributes: { commandId: 'management', commandType: 'session.create' },
  evidenceRefs: [],
};

test('tree selection made during a held seek survives the verified cursor commit without another scan', async () =>
  fixture(
    async ({ host, calls, render, holdRead, release }) => {
      await render();
      const before = calls.filter((call) => call.method === 'events').length;
      expect(before).toBe(1);
      holdRead();
      const input = await seek(host, '2');
      expect(input.value).toBe('3');
      await chooseNode(host, 'execution:other-tool');
      expect(
        host
          .querySelector('[data-trajectory-node="execution:other-tool"]')
          ?.closest('tr[aria-selected]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(calls.filter((call) => call.method === 'events')).toHaveLength(before + 1);
      await act(async () => release());
      expect(input.value).toBe('2');
      expect(
        host
          .querySelector('[data-trajectory-node="execution:other-tool"]')
          ?.closest('tr[aria-selected]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(calls.filter((call) => call.method === 'events')).toHaveLength(before + 1);
      expect(
        calls
          .filter((call) => call.method === 'events')
          .every(
            (call) =>
              call.method === 'events' &&
              call.request.upperCursor === '3' &&
              call.request.storeId === 'store' &&
              call.request.sessionId === 'session' &&
              call.request.eventKinds === undefined,
          ),
      ).toBe(true);
      expectBoundedReadOnlyView(host, calls, [evidenceEvent]);
    },
    false,
    undefined,
    [evidenceEvent, otherEvent],
  ));

test.each([
  'trajectory_evidence_missing',
  'trajectory_evidence_unavailable',
  'trajectory_bundle_section_integrity',
])('missing or unreadable %s materials stay separate from the offline event index while exact visible loop material is read lazily', async (evidenceCode) =>
  fixture(
    async ({ host, calls, render }) => {
      await render();
      await chooseNode(host, 'execution:model');
      expect(
        host
          .querySelector('[data-trajectory-node="execution:model"]')
          ?.closest('tr[aria-selected]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(host.textContent).not.toContain('轨迹读取未完成');
      expect(calls.filter((call) => call.method === 'events')).toHaveLength(1);
      expectBoundedReadOnlyView(host, calls, [evidenceEvent]);
      expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toContain(
        '思考',
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
      expect(host.textContent).toContain(evidenceCode);
      expect(host.textContent).not.toContain('轨迹读取未完成');
      expect(calls.filter((call) => call.method === 'evidence.open')).toHaveLength(2);
      expect(calls.filter((call) => call.method === 'events')).toHaveLength(1);
      expect(host.querySelector('[aria-label="选中节点详情"]')).not.toBeNull();
    },
    false,
    evidenceCode,
  ));

test('A-B-A selection and all-event filtering are synchronous presentation changes with no raw-detail rescans', async () =>
  fixture(
    async ({ host, calls, render }) => {
      await render();
      expect(calls.filter((call) => call.method === 'events')).toHaveLength(1);
      await chooseNode(host, 'execution:model');
      await chooseNode(host, 'execution:other-tool');
      await chooseNode(host, 'execution:model');
      expect(
        host
          .querySelector('[data-trajectory-node="execution:model"]')
          ?.closest('tr[aria-selected]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(
        [...host.querySelectorAll('[data-trajectory-node="execution:model"]')].map((row) =>
          row.getAttribute('data-trajectory-row'),
        ),
      ).toEqual(['execution:model:part:thinking', 'execution:model:part:reply']);
      expect(host.querySelectorAll('[data-trajectory-node="execution:other-tool"]')).toHaveLength(
        1,
      );
      const defaultNodes = host.querySelectorAll('[data-trajectory-node]').length;
      await showAll(host);
      expect(host.querySelectorAll('[data-trajectory-node]').length).toBeGreaterThan(defaultNodes);
      expect(
        host
          .querySelector('[data-trajectory-node="execution:model"]')
          ?.closest('tr[aria-selected]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      await showAll(host);
      expect(host.querySelectorAll('[data-trajectory-node]')).toHaveLength(defaultNodes);
      expect(calls.filter((call) => call.method === 'events')).toHaveLength(1);
      expectBoundedReadOnlyView(host, calls, [evidenceEvent]);
    },
    false,
    undefined,
    [evidenceEvent, otherEvent, managementEvent],
  ));

test('an empty local prefix keeps the tree and can show all records without requesting materials', async () =>
  fixture(async ({ host, calls, render }) => {
    await render();
    expect(host.querySelector('[role="treegrid"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-trajectory-node]')).toHaveLength(0);
    expect(host.textContent).toContain('没有匹配记录');
    expect(host.textContent).not.toContain('0 项匹配');
    await showAll(host);
    expect(calls.filter((call) => call.method === 'events')).toHaveLength(1);
    expectBoundedReadOnlyView(host, calls);
  }));

test('a real event read failure preserves the fixed reading position and retries the same source', async () =>
  fixture(
    async ({ host, calls, render, failNextRead }) => {
      await render();
      failNextRead('trajectory_bundle_section_integrity');
      const input = await seek(host, '1');
      expect(host.textContent).toContain('轨迹读取未完成');
      expect(host.textContent).toContain('trajectory_bundle_section_integrity');
      expect(input.value).toBe('3');
      await act(async () =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === '重试读取')!
          .click(),
      );
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(input.value).toBe('1');
      expect(calls.filter((call) => call.method === 'pick')).toHaveLength(1);
      expect(
        calls
          .filter((call) => call.method === 'events')
          .every(
            (call) =>
              call.method === 'events' &&
              call.bundleId === 'bundle-1' &&
              call.request.upperCursor === '3',
          ),
      ).toBe(true);
      expectBoundedReadOnlyView(host, calls, [evidenceEvent]);
    },
    false,
    undefined,
    [evidenceEvent, otherEvent],
  ));

test('reopening the viewer retires a pending old seek and its late result cannot replace the new tree selection', async () =>
  fixture(
    async ({ host, calls, render, reopen, holdRead, release }) => {
      await render();
      holdRead();
      await seek(host, '1');
      await reopen();
      await showReplayControls(host);
      await chooseNode(host, 'execution:other-tool');
      await act(async () => release());
      expect(host.querySelector<HTMLInputElement>('[aria-label="轨迹位置"]')!.value).toBe('3');
      expect(
        host
          .querySelector('[data-trajectory-node="execution:other-tool"]')
          ?.closest('tr[aria-selected]')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(calls.filter((call) => call.method === 'close')).toEqual([
        { method: 'close', bundleId: 'bundle-1' },
      ]);
      expect(
        calls.filter((call) => call.method === 'events' && call.bundleId === 'bundle-2'),
      ).toHaveLength(1);
      expectBoundedReadOnlyView(host, calls, [evidenceEvent]);
    },
    false,
    undefined,
    [evidenceEvent, otherEvent],
  ));

test('the real offline host opens the independent request inspector and metadata tabs remain read-only without new body reads', async () =>
  fixture(
    async ({ host, calls, render }) => {
      await render();
      expect(calls.filter((call) => call.method === 'evidence.open')).toHaveLength(1);
      const marker = host.querySelector<HTMLButtonElement>('.trajectory-request-marker')!;
      expect(marker).not.toBeNull();
      await act(() => marker.click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
      expect(host.querySelector('[aria-label="模型请求详情"]') !== null).toBe(true);
      expect(host.querySelector('.trajectory-request-marker')?.getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(
        [...host.querySelectorAll('[aria-label="请求详情"] [role="tab"]')].map(
          (tab) => tab.textContent,
        ),
      ).toEqual(['概述', '选项', '用量', '计时']);
      const opens = calls.filter((call) => call.method === 'evidence.open').length;
      const chunks = calls.filter((call) => call.method === 'evidence.read').length;
      for (const label of ['用量', '计时']) {
        const tab = [
          ...host.querySelectorAll<HTMLElement>('[aria-label="请求详情"] [role="tab"]'),
        ].find((button) => button.textContent === label)!;
        await act(() =>
          tab.dispatchEvent(
            new host.ownerDocument.defaultView!.MouseEvent('mousedown', {
              bubbles: true,
              button: 0,
            }),
          ),
        );
        await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
        expect(tab.getAttribute('data-state')).toBe('active');
        expect(calls.filter((call) => call.method === 'evidence.open')).toHaveLength(opens);
        expect(calls.filter((call) => call.method === 'evidence.read')).toHaveLength(chunks);
      }
      await act(() =>
        host.querySelector<HTMLButtonElement>('[aria-label="关闭请求详情"]')!.click(),
      );
      for (
        let i = 0;
        i < 30 &&
        host.ownerDocument.activeElement !== host.querySelector('.trajectory-request-marker');
        i++
      )
        await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
      expect(host.querySelector('[aria-label="模型请求详情"]') === null).toBe(true);
      expect(
        host.ownerDocument.activeElement === host.querySelector('.trajectory-request-marker'),
      ).toBe(true);
      await chooseNode(host, 'execution:model');
      expect(host.textContent).toContain('ORIGINAL_OFFLINE_THOUGHT');
      expect(host.querySelector('[aria-label="选中节点详情"]')?.textContent).not.toContain(
        'ORIGINAL_OFFLINE_REPLY',
      );
      expectBoundedReadOnlyView(host, calls, [evidenceEvent]);
      expect(
        calls.every((call) =>
          ['pick', 'events', 'evidence.open', 'evidence.read', 'evidence.close', 'close'].includes(
            call.method,
          ),
        ),
      ).toBe(true);
    },
    false,
    undefined,
    [evidenceEvent],
  ));
