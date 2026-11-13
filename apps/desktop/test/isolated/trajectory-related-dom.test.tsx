import { createHash } from 'node:crypto';
import type { TrajectoryEvidenceSource } from '@kite-ai/client';
import {
  type TrajectoryEvent,
  type TrajectoryEvidenceDescriptor,
  type TrajectorySnapshot,
  trajectoryIdentityPayload,
} from '@kite-ai/trajectory';
import type { TrajectoryMaterialTarget } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';
import { afterAll, afterEach, expect, mock, test } from '#kite-test';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';
import type { NativeTrajectoryLocalCache } from '../../src/trajectory-bridge';

// Only renderer disk sections are replaced. The real Native loader, page verification,
// local bundle, projector, related-scope hook and Evidence reader run unchanged.
const originalBridge = await import('../../src/trajectory-bridge');
const realLoad = originalBridge.loadNativeTrajectory;
const caches: { closed: boolean; signal?: AbortSignal; snapshot: TrajectorySnapshot }[] = [];
mock.module('../../src/trajectory-bridge', () => ({
  ...originalBridge,
  async loadNativeTrajectory(input: Parameters<typeof realLoad>[0]) {
    const record = { closed: false, signal: input.signal, snapshot: input.snapshot };
    caches.push(record);
    const files = new Map<string, Uint8Array>();
    const cache: NativeTrajectoryLocalCache = {
      async list() {
        return [...files.keys()];
      },
      async read(path) {
        if (record.closed || !files.has(path)) throw Error('cache_closed');
        return Uint8Array.from(files.get(path)!);
      },
      async write(path, bytes) {
        if (record.closed) throw Error('cache_closed');
        files.set(path, Uint8Array.from(bytes));
      },
      async close() {
        record.closed = true;
        files.clear();
      },
    };
    return realLoad({ ...input, cacheFactory: async () => cache });
  },
}));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const { useRelatedTrajectories } = await import('../../src/trajectory-related');
const { useTrajectoryMaterials } = await import('../../src/trajectory-materials');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  caches.length = 0;
});
afterAll(() => {
  mock.restore();
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
function snapshot(
  sessionId = 'parent',
  runId = 'parent-run',
  upperCursor = '100',
): TrajectorySnapshot {
  return {
    storeId: 'store',
    sessionId,
    runId,
    upperCursor,
    formatVersion: 1,
    historyCoverage: { enabledAfterCursor: '0', upperCursor, status: 'retained', integrity },
  };
}
function fact(sequence: number, sessionId: string, runId: string): TrajectoryEvent {
  const origin = { storeId: 'original', cursor: String(sequence) };
  return {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${createHash('sha256').update(trajectoryIdentityPayload(origin)).digest('hex')}`,
    sequence: String(sequence),
    origin,
    sessionId,
    workspaceId: 'workspace',
    runId,
    runOriginStoreId: 'original',
    executionId: `model-${sessionId}`,
    executionOriginStoreId: 'original',
    kind: 'model',
    phase: 'completed',
    sourceEventType: 'execution.finished',
    sourceRecordRevision: String(sequence),
    recordedStatus: 'succeeded',
    occurredAt: sequence,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
  };
}
function bridgeFixture() {
  const calls: NativeRequest[] = [];
  const opens: {
    request: Extract<NativeRequest, { method: 'trajectory.open' }>;
    release: (upper?: string, session?: string) => void;
    reject: () => void;
  }[] = [];
  const pendingPages: { release: () => void }[] = [],
    held = new Set<string>();
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input): Promise<NativeResult> {
      calls.push(structuredClone(input));
      if (input.method === 'trajectory.open')
        return new Promise((resolve, reject) =>
          opens.push({
            request: input,
            release: (upper = '999', session = input.request.sessionId) =>
              resolve({
                kind: 'trajectory.snapshot',
                trajectory: snapshot(session, input.request.runId!, upper),
              }),
            reject: () => reject(Error('trajectory_fixture_unavailable')),
          }),
        );
      if (input.method === 'trajectory.events') {
        const page = (): NativeResult => {
          const { limit: _limit, ...scope } = input.request;
          return {
            kind: 'trajectory.page',
            trajectory: {
              ...scope,
              exhausted: true,
              scannedThrough: scope.upperCursor,
              integrity,
              events: [
                fact(10, scope.sessionId, scope.runId!),
                fact(60, scope.sessionId, scope.runId!),
              ].filter(
                (event) =>
                  BigInt(event.sequence) > BigInt(scope.afterCursor) &&
                  BigInt(event.sequence) <= BigInt(scope.upperCursor),
              ),
            },
          };
        };
        if (held.has(input.request.sessionId))
          return new Promise((resolve) => pendingPages.push({ release: () => resolve(page()) }));
        return page();
      }
      throw Error('unexpected_business_request');
    },
  };
  return { bridge, calls, opens, held, pendingPages };
}
const childA = { parentNodeId: 'carrier-a', sessionId: 'child-a', runId: 'run-a' };
const childB = { parentNodeId: 'carrier-b', sessionId: 'child-b', runId: 'run-b' };
type RelatedProps = Parameters<typeof useRelatedTrajectories>[0];
function relatedHarness() {
  let owner!: ReturnType<typeof useRelatedTrajectories>;
  const renders: {
    bridge: NativeBridge;
    enabled: boolean;
    cursor: string;
    scopes: typeof owner.scopes;
  }[] = [];
  function Harness(props: RelatedProps) {
    const value = useRelatedTrajectories(props);
    owner = value;
    useLayoutEffect(() => {
      renders.push({
        bridge: props.bridge,
        enabled: props.enabled,
        cursor: props.cursor,
        scopes: value.scopes,
      });
    });
    return (
      <pre>
        {JSON.stringify(
          value.scopes.map((scope) => ({
            parent: scope.parentNodeId,
            status: scope.status,
            ids: scope.projection?.sourceEventIds,
          })),
        )}
      </pre>
    );
  }
  return {
    owner: () => owner,
    renders,
    async render(
      bridge: NativeBridge,
      targets: RelatedProps['targets'],
      extra: Partial<RelatedProps> = {},
    ) {
      root ??= createRoot(document.body);
      await act(async () => {
        root!.render(
          <Harness
            bridge={bridge}
            generation={1}
            snapshot={snapshot()}
            cursor="40"
            targets={targets}
            enabled
            {...extra}
          />,
        );
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    },
  };
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2));
  });
}
async function until(check: () => boolean) {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await flush();
  }
  throw Error('trajectory_hook_did_not_settle');
}
async function release(action: () => void) {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 2));
  });
}

test('only expanded targets read exact child Session/Run and freeze the parent cursor while adding a sibling retains the first scope', async () => {
  const f = bridgeFixture(),
    h = relatedHarness();
  await h.render(f.bridge, []);
  expect(f.calls).toHaveLength(0);
  await h.render(f.bridge, [childA]);
  expect(f.opens).toHaveLength(1);
  expect(f.opens[0]!.request.request).toEqual({
    storeId: 'store',
    sessionId: 'child-a',
    runId: 'run-a',
  });
  await release(() => f.opens[0]!.release());
  await until(() => !!h.owner().scopes[0]?.projection);
  expect(h.owner().snapshots[0]?.upperCursor).toBe('40');
  expect(h.owner().scopes[0]?.projection?.sourceEventIds).toHaveLength(1);
  const before = h.renders.length;
  await h.render(f.bridge, [childA, childB]);
  expect(
    h.renders
      .slice(before)
      .every(
        (render) =>
          !!render.scopes.find((scope) => scope.parentNodeId === childA.parentNodeId)?.projection,
      ),
  ).toBe(true);
  expect(f.opens).toHaveLength(2);
  await release(() => f.opens[1]!.release());
  await until(() => h.owner().snapshots.length === 2);
  for (const call of f.calls)
    if (call.method === 'trajectory.events') {
      expect(call.request.upperCursor).toBe('40');
      expect(call.request.runId).toBe(call.request.sessionId === 'child-a' ? 'run-a' : 'run-b');
    }
  expect(caches.every((cache) => cache.closed && cache.snapshot.upperCursor === '40')).toBe(true);
});

test('collapse aborts pending opens and in-flight page loads; late completion closes local sections and never restores scopes', async () => {
  const f = bridgeFixture(),
    h = relatedHarness();
  await h.render(f.bridge, [childA]);
  await h.render(f.bridge, []);
  await release(() => f.opens[0]!.release());
  expect(h.owner().scopes).toEqual([]);
  expect(caches).toHaveLength(0);
  f.held.add('child-a');
  await h.render(f.bridge, [childA]);
  await release(() => f.opens[1]!.release());
  await until(() => f.pendingPages.length === 1);
  expect(caches).toHaveLength(1);
  await h.render(f.bridge, []);
  expect(caches[0]!.signal?.aborted).toBe(true);
  await release(() => f.pendingPages[0]!.release());
  await until(() => caches[0]!.closed);
  expect(h.owner().scopes).toEqual([]);
});

test('same-generation bridge replacement and disconnect hide old scopes immediately and require a fresh admission', async () => {
  const a = bridgeFixture(),
    b = bridgeFixture(),
    h = relatedHarness();
  await h.render(a.bridge, [childA]);
  await release(() => a.opens[0]!.release());
  await until(() => !!h.owner().scopes[0]?.projection);
  const start = h.renders.length;
  await h.render(b.bridge, [childA]);
  expect(
    h.renders.slice(start).find((value) => value.bridge === b.bridge)?.scopes[0]?.projection,
  ).toBeNull();
  expect(b.opens).toHaveLength(1);
  await release(() => b.opens[0]!.release());
  await until(() => !!h.owner().scopes[0]?.projection);
  await h.render(b.bridge, [childA], { enabled: false });
  expect(h.owner().scopes).toEqual([]);
  await h.render(b.bridge, [childA]);
  expect(h.owner().scopes[0]?.projection).toBeNull();
  expect(b.opens).toHaveLength(2);
  await release(() => b.opens[1]!.release());
  await until(() => !!h.owner().scopes[0]?.projection);
  const cursorStart = h.renders.length;
  await h.render(b.bridge, [childA], { cursor: '30' });
  expect(
    h.renders.slice(cursorStart).find((value) => value.cursor === '30')?.scopes[0]?.projection,
  ).toBeNull();
  await release(() => b.opens[2]!.release());
  await until(() => h.owner().snapshots[0]?.upperCursor === '30');
});

test('unavailable or foreign snapshots remain local failures and collapse/reopen can recover', async () => {
  const f = bridgeFixture(),
    h = relatedHarness();
  await h.render(f.bridge, [childA]);
  await release(() => f.opens[0]!.release('999', 'foreign'));
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(caches).toHaveLength(0);
  await h.render(f.bridge, []);
  await h.render(f.bridge, [childA]);
  await release(() => f.opens[1]!.release('20'));
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(caches).toHaveLength(0);
  await h.render(f.bridge, []);
  await h.render(f.bridge, [childA]);
  await release(() => f.opens[2]!.release());
  await until(() => !!h.owner().scopes[0]?.projection);
  await h.render(f.bridge, [{ ...childA, sessionId: 'parent' }]);
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(f.opens).toHaveLength(3);
});

function materialTarget(
  sessionId = 'child-a',
  runId = 'run-a',
  sequence = 10,
): TrajectoryMaterialTarget {
  const base = fact(sequence, sessionId, runId);
  const origin = { storeId: `original-${sessionId}-${runId}`, cursor: String(sequence) };
  const event: TrajectoryEvent = {
    ...base,
    origin,
    eventId: `te_${createHash('sha256').update(trajectoryIdentityPayload(origin)).digest('hex')}`,
    kind: 'message',
    phase: 'observed',
    attributes: {
      messageId: 'reply',
      role: 'assistant',
      messageSeq: '1',
      revision: String(sequence),
      status: 'complete',
    },
    evidenceRefs: [
      {
        kind: 'message',
        evidenceId: 'body',
        contentVersion: 'version',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  };
  return { event, reference: event.evidenceRefs[0]! };
}
async function evidenceFixture() {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ role: 'assistant', status: 'complete', content: 'CHILD_BODY' }),
  );
  const hash = createHash('sha256').update(bytes).digest('hex');
  const opens: {
    input: Parameters<TrajectoryEvidenceSource['openTrajectoryEvidence']>[0];
    signal?: AbortSignal;
    release: () => void;
    id: string;
  }[] = [];
  const closes: string[] = [],
    chunks: string[] = [];
  const source: TrajectoryEvidenceSource = {
    openTrajectoryEvidence(input, options) {
      const readId = `lease-${opens.length}`;
      const descriptor: TrajectoryEvidenceDescriptor = {
        readId,
        eventId: input.eventId,
        evidenceId: input.evidenceId,
        contentVersion: input.contentVersion,
        availability: 'available',
        mediaType: 'application/json',
        viewBytes: String(bytes.length),
        viewSha256: hash,
        transformation: 'public',
        policyRevision: '1',
        authorizationEpoch: '1',
      };
      return new Promise((resolve) =>
        opens.push({
          input,
          signal: options?.signal,
          id: readId,
          release: () => resolve(descriptor),
        }),
      );
    },
    async readTrajectoryEvidenceChunk(input) {
      chunks.push(input.readId);
      return {
        readId: input.readId,
        offset: '0',
        nextOffset: String(bytes.length),
        data: Buffer.from(bytes).toString('base64'),
        eof: true,
        viewSha256: hash,
        policyRevision: '1',
        authorizationEpoch: '1',
      };
    },
    async closeTrajectoryEvidence(input) {
      closes.push(input.readId);
      return {};
    },
  };
  return { source, opens, closes, chunks };
}
function materialsHarness() {
  let owner!: ReturnType<typeof useTrajectoryMaterials>;
  const renders: { scopes: readonly TrajectorySnapshot[]; materials: typeof owner.materials }[] =
    [];
  function Harness({
    source,
    scopes,
    targets,
  }: {
    source: TrajectoryEvidenceSource;
    scopes: readonly TrajectorySnapshot[];
    targets: readonly TrajectoryMaterialTarget[];
  }) {
    const value = useTrajectoryMaterials({
      source,
      snapshot: snapshot(),
      cursor: '40',
      ownerKey: 'parent-selection',
      relatedSnapshots: scopes,
    });
    owner = value;
    // The real Panel re-submits the unchanged selected targets when admission changes its callback.
    useLayoutEffect(() => {
      value.onMaterialsChange(targets);
    }, [targets, value.onMaterialsChange]);
    useLayoutEffect(() => {
      renders.push({ scopes, materials: value.materials });
    });
    return <pre>{JSON.stringify(value.materials)}</pre>;
  }
  return {
    owner: () => owner,
    renders,
    async render(
      source: TrajectoryEvidenceSource,
      scopes: readonly TrajectorySnapshot[],
      targets: readonly TrajectoryMaterialTarget[],
    ) {
      root ??= createRoot(document.body);
      await act(async () => {
        root!.render(<Harness source={source} scopes={scopes} targets={targets} />);
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    },
  };
}

test('child Evidence reads use its admitted exact scope and never borrow the parent or another Run, Store or future bound', async () => {
  const f = await evidenceFixture(),
    h = materialsHarness(),
    admitted = snapshot('child-a', 'run-a', '40');
  await h.render(f.source, [admitted], [materialTarget()]);
  await until(() => f.opens.length === 1);
  expect(f.opens[0]!.input).toMatchObject({
    storeId: 'store',
    sessionId: 'child-a',
    upperCursor: '40',
    atCursor: '10',
  });
  await release(() => f.opens[0]!.release());
  await until(() => h.owner().materials[0]?.text === 'CHILD_BODY');
  for (const invalid of [
    { scopes: [], target: materialTarget() },
    { scopes: [admitted], target: materialTarget('child-b', 'run-b') },
    { scopes: [admitted], target: materialTarget('child-a', 'wrong-run') },
    { scopes: [{ ...admitted, runId: undefined }], target: materialTarget() },
    { scopes: [{ ...admitted, storeId: 'foreign' }], target: materialTarget() },
    { scopes: [{ ...admitted, upperCursor: '41' }], target: materialTarget() },
    { scopes: [admitted], target: materialTarget('child-a', 'run-a', 41) },
  ]) {
    await h.render(f.source, invalid.scopes, [invalid.target]);
    await until(() => h.owner().materials[0]?.status === 'unavailable');
    expect(f.opens).toHaveLength(1);
    expect(document.body.textContent).not.toContain('CHILD_BODY');
  }
});

test('revoking an admitted child synchronously hides its body, aborts held leases, and unrelated children do not flash the current body', async () => {
  const f = await evidenceFixture(),
    h = materialsHarness(),
    admitted = snapshot('child-a', 'run-a', '40'),
    target = materialTarget();
  await h.render(f.source, [admitted], [target]);
  await until(() => f.opens.length === 1);
  await release(() => f.opens[0]!.release());
  await until(() => h.owner().materials[0]?.text === 'CHILD_BODY');
  const before = h.renders.length;
  await h.render(f.source, [admitted, snapshot('child-b', 'run-b', '40')], [target]);
  expect(h.renders.slice(before).every((value) => value.materials[0]?.text === 'CHILD_BODY')).toBe(
    true,
  );
  expect(f.opens).toHaveLength(1);
  const revoked = h.renders.length;
  await h.render(f.source, [], [target]);
  expect(h.renders.slice(revoked)[0]?.materials).toEqual([]);
  expect(document.body.textContent).not.toContain('CHILD_BODY');
  await h.render(f.source, [admitted], [target]);
  await until(() => f.opens.length === 2);
  await h.render(f.source, [], [target]);
  expect(f.opens[1]!.signal?.aborted).toBe(true);
  await release(() => f.opens[1]!.release());
  await until(() => f.closes.includes(f.opens[1]!.id));
  expect(f.chunks).toEqual([f.opens[0]!.id]);
  expect(document.body.textContent).not.toContain('CHILD_BODY');
});

test('the real Native manager admits only the observed direct child Run at the frozen parent cursor', async () => {
  const { NativeTrajectory } = await import('../../electron/trajectory');
  const carrier: TrajectoryEvent = {
    ...fact(20, 'parent', 'parent-run'),
    kind: 'job',
    executionId: 'carrier-a',
    attributes: {
      childSessionId: 'child-a',
      display: {
        kind: 'task',
        targetExecutionId: 'carrier-a',
        targetExecutionOriginStoreId: 'original',
        targetSessionId: 'child-a',
        targetRunId: 'run-a',
      },
    },
  };
  const child = fact(10, 'child-a', 'run-a');
  const readCalls: { sessionId: string; runId?: string; upperCursor: string }[] = [];
  const current = { storeId: 'store', sessionId: 'parent', generation: 1, selection: 1 };
  const main = new NativeTrajectory(
    {
      async openTrajectory(input) {
        return { ...snapshot(input.sessionId, input.runId, '999'), ...input };
      },
      async readTrajectoryEvents(input) {
        readCalls.push(input);
        const { limit: _limit, ...request } = input;
        return {
          ...request,
          scannedThrough: input.upperCursor,
          exhausted: true,
          integrity,
          events: [carrier, child].filter(
            (event) =>
              event.sessionId === input.sessionId &&
              (!input.runId || event.runId === input.runId) &&
              BigInt(event.sequence) > BigInt(input.afterCursor) &&
              BigInt(event.sequence) <= BigInt(input.upperCursor),
          ),
        };
      },
      async openTrajectoryEvidence() {
        throw Error('unexpected_material_read');
      },
      async readTrajectoryEvidenceChunk() {
        throw Error('unexpected_material_read');
      },
      async closeTrajectoryEvidence() {
        return { closed: true };
      },
    },
    () => current,
  );
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      if (input.method === 'trajectory.open')
        return { kind: 'trajectory.snapshot', trajectory: await main.open(input.request) };
      if (input.method === 'trajectory.events')
        return { kind: 'trajectory.page', trajectory: await main.readEvents(input.request) };
      throw Error('unexpected_request');
    },
  };
  const h = relatedHarness();
  await h.render(bridge, [childA]);
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(readCalls).toHaveLength(0);
  await main.readEvents({
    storeId: 'store',
    sessionId: 'parent',
    afterCursor: '0',
    upperCursor: '100',
  });
  await h.render(bridge, []);
  await h.render(bridge, [childA]);
  await until(() => !!h.owner().scopes[0]?.projection);
  expect(h.owner().snapshots[0]?.upperCursor).toBe('40');
  expect(h.owner().scopes[0]?.projection?.sourceEventIds).toEqual([child.eventId]);
  expect(readCalls.filter((call) => call.sessionId === 'child-a')).toEqual([
    expect.objectContaining({ sessionId: 'child-a', runId: 'run-a', upperCursor: '40' }),
  ]);
  const readCount = readCalls.length;
  await h.render(bridge, [childA], { cursor: '19' });
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(readCalls).toHaveLength(readCount);
  await h.render(bridge, [{ ...childA, runId: 'foreign-run' }]);
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(readCalls).toHaveLength(readCount);
  main.release();
  await h.render(bridge, []);
  await h.render(bridge, [childA]);
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(readCalls).toHaveLength(readCount);
  const exactTarget = { ...childA, carrierExecutionId: 'carrier-a' };
  await h.render(bridge, [exactTarget]);
  await until(() => !!h.owner().scopes[0]?.projection);
  expect(h.owner().snapshots[0]?.upperCursor).toBe('40');
  expect(readCalls.slice(readCount)).toEqual([
    expect.objectContaining({
      sessionId: 'parent',
      executionId: 'carrier-a',
      eventKinds: ['job'],
      upperCursor: '40',
    }),
    expect.objectContaining({ sessionId: 'child-a', runId: 'run-a', upperCursor: '40' }),
  ]);
  const restoredCount = readCalls.length;
  await h.render(bridge, [exactTarget], { cursor: '101' });
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(readCalls).toHaveLength(restoredCount);
  main.release();
  await h.render(bridge, [exactTarget], { cursor: '19' });
  await until(() => h.owner().scopes[0]?.status === 'unavailable');
  expect(readCalls.slice(restoredCount)).toEqual([
    expect.objectContaining({ sessionId: 'parent', executionId: 'carrier-a', upperCursor: '19' }),
  ]);
  await main.close();
});
