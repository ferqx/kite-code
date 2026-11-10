import { afterAll, afterEach, expect, test } from 'bun:test';
import type { TrajectoryEvidenceSource } from '@kite-ai/client';
import {
  type TrajectoryEvidenceDescriptor,
  type TrajectorySnapshot,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import type { TrajectoryMaterialTarget } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';

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
const { useTrajectoryMaterials } = await import('../../src/trajectory-materials');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const snapshot: TrajectorySnapshot = {
  storeId: 'store',
  sessionId: 'session',
  upperCursor: '100',
  formatVersion: 1,
  historyCoverage: {
    enabledAfterCursor: '0',
    upperCursor: '100',
    status: 'retained',
    integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
  },
};
function target(sequence = '5', version = 'old-v1'): TrajectoryMaterialTarget {
  const event = trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${Number(sequence).toString(16).padStart(64, '0')}`,
    sequence,
    origin: { storeId: 'store', cursor: sequence },
    sessionId: 'session',
    workspaceId: 'workspace',
    kind: 'message',
    phase: 'observed',
    sourceEventType: 'message.updated',
    sourceRecordRevision: sequence,
    recordedStatus: null,
    occurredAt: null,
    identityConfidence: 'verified_origin',
    attributes: {
      messageId: 'message',
      messageSeq: '1',
      revision: sequence,
      role: 'assistant',
      status: 'incomplete',
    },
    evidenceRefs: [
      {
        evidenceId: 'body',
        contentVersion: version,
        kind: 'message',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  });
  return { event, reference: event.evidenceRefs[0]! };
}
async function fixtureSource(label: string) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ role: 'assistant', status: 'incomplete', content: label }),
  );
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  const opens: {
    input: Parameters<TrajectoryEvidenceSource['openTrajectoryEvidence']>[0];
    signal?: AbortSignal;
    release: () => void;
    readId: string;
  }[] = [];
  const closed: string[] = [],
    chunks: string[] = [];
  const descriptors = new Map<string, TrajectoryEvidenceDescriptor>();
  const source: TrajectoryEvidenceSource = {
    openTrajectoryEvidence(input, options) {
      const readId = `${label}-${opens.length}`;
      const descriptor: TrajectoryEvidenceDescriptor = {
        readId,
        eventId: input.eventId,
        evidenceId: input.evidenceId,
        contentVersion: input.contentVersion,
        availability: 'available',
        mediaType: 'application/json',
        viewBytes: String(bytes.byteLength),
        viewSha256: hash,
        transformation: 'public',
        policyRevision: '1',
        authorizationEpoch: '1',
      };
      descriptors.set(readId, descriptor);
      return new Promise((resolve) =>
        opens.push({ input, signal: options?.signal, readId, release: () => resolve(descriptor) }),
      );
    },
    async readTrajectoryEvidenceChunk(input) {
      chunks.push(input.readId);
      const descriptor = descriptors.get(input.readId)!;
      return {
        readId: input.readId,
        offset: '0',
        nextOffset: String(bytes.byteLength),
        data: Buffer.from(bytes).toString('base64'),
        eof: true,
        viewSha256: hash,
        policyRevision: descriptor.policyRevision,
        authorizationEpoch: descriptor.authorizationEpoch,
      };
    },
    async closeTrajectoryEvidence(input) {
      closed.push(input.readId);
      return {};
    },
  };
  return { source, opens, closed, chunks };
}
type Owner = ReturnType<typeof useTrajectoryMaterials>;
function harness(retainCommon = false) {
  let owner!: Owner;
  const renders: {
    source: TrajectoryEvidenceSource | null;
    ownerKey: string;
    materials: Owner['materials'];
  }[] = [];
  function Harness({
    source,
    ownerKey,
    cursor = '100',
  }: {
    source: TrajectoryEvidenceSource | null;
    ownerKey: string;
    cursor?: string;
  }) {
    const value = useTrajectoryMaterials({ source, snapshot, cursor, ownerKey, retainCommon });
    owner = value;
    useLayoutEffect(() => {
      renders.push({ source, ownerKey, materials: value.materials });
    });
    return <pre>{JSON.stringify(value.materials)}</pre>;
  }
  return {
    owner: () => owner,
    renders,
    render: async (source: TrajectoryEvidenceSource | null, ownerKey = 'owner', cursor = '100') => {
      root ??= createRoot(document.body);
      await act(() =>
        root!.render(<Harness source={source} ownerKey={ownerKey} cursor={cursor} />),
      );
    },
    request: (targets: readonly TrajectoryMaterialTarget[]) =>
      act(() => owner.onMaterialsChange(targets)),
  };
}
async function release(open: { release: () => void }) {
  await act(async () => {
    open.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

test('visible loops retain only common exact materials while adding neighbors, retry and source changes revalidate', async () => {
  const a = await fixtureSource('original loop body'),
    b = await fixtureSource('replacement body'),
    h = harness(true);
  const first = target(),
    neighbor = target('6', 'neighbor-v1');
  await h.render(a.source);
  await h.request([first]);
  await release(a.opens[0]!);
  expect(h.owner().materials[0]?.text).toBe('original loop body');
  const before = h.renders.length;
  await h.request([first, neighbor]);
  expect(a.opens).toHaveLength(2);
  expect(a.opens[1]?.input.eventId).toBe(neighbor.event.eventId);
  expect(h.owner().materials[0]?.text).toBe('original loop body');
  expect(
    h.renders.slice(before).every((render) => render.materials[0]?.text === 'original loop body'),
  ).toBe(true);
  await release(a.opens[1]!);
  await h.request([neighbor]);
  expect(a.opens).toHaveLength(2);
  expect(h.owner().materials).toHaveLength(1);
  expect(h.owner().materials[0]?.eventId).toBe(neighbor.event.eventId);
  await act(() => h.owner().onMaterialsRetry());
  expect(a.opens).toHaveLength(3);
  expect(h.owner().materials[0]?.text).toBeUndefined();
  await release(a.opens[2]!);
  await h.render(b.source);
  expect(document.body.textContent).not.toContain('original loop body');
  await h.request([neighbor]);
  expect(b.opens).toHaveLength(1);
  await release(b.opens[0]!);
  expect(h.owner().materials[0]?.text).toBe('replacement body');
});

test('a source or owner replacement synchronously hides the prior same-event/ref view', async () => {
  const a = await fixtureSource('source A'),
    b = await fixtureSource('source B'),
    h = harness();
  await h.render(a.source, 'owner A');
  await h.request([target()]);
  await release(a.opens[0]!);
  expect(h.owner().materials[0]?.text).toBe('source A');
  const count = h.renders.length;
  await h.render(b.source, 'owner B');
  const first = h.renders.slice(count).find((render) => render.source === b.source)!;
  expect(first.materials).toEqual([]);
  expect(document.body.textContent).not.toContain('source A');
  expect(b.opens).toHaveLength(0);
  await h.request([target()]);
  if (b.opens[0]) await release(b.opens[0]);
  expect(h.owner().materials[0]?.text).toBe('source B');
  const ownerCount = h.renders.length;
  await h.render(b.source, 'owner C');
  expect(
    h.renders.slice(ownerCount).find((render) => render.ownerKey === 'owner C')!.materials,
  ).toEqual([]);
});

test('visible-loop reuse rejects the same ref when any original scope field changes', async () => {
  const a = await fixtureSource('admitted original'),
    h = harness(true),
    original = target();
  await h.render(a.source);
  await h.request([original]);
  await release(a.opens[0]!);
  expect(h.owner().materials[0]?.text).toBe('admitted original');
  await h.request([{ ...original, event: { ...original.event, sessionId: 'foreign-session' } }]);
  expect(a.opens).toHaveLength(1);
  expect(h.owner().materials[0]?.status).toBe('unavailable');
  expect(document.body.textContent).not.toContain('admitted original');
});

test('A to B to A late opens close every original source lease and cannot commit an earlier generation', async () => {
  const a = await fixtureSource('A'),
    b = await fixtureSource('B'),
    h = harness();
  await h.render(a.source, 'A');
  await h.request([target()]);
  expect(a.opens).toHaveLength(1);
  await h.render(b.source, 'B');
  await h.request([target()]);
  expect(a.opens[0]!.signal!.aborted).toBe(true);
  await h.render(a.source, 'A');
  await h.request([target()]);
  expect(a.opens).toHaveLength(2);
  expect(b.opens).toHaveLength(1);
  await release(a.opens[0]!);
  await release(b.opens[0]!);
  expect(a.closed).toContain(a.opens[0]!.readId);
  expect(b.closed).toContain(b.opens[0]!.readId);
  expect(a.chunks).toHaveLength(0);
  expect(b.chunks).toHaveLength(0);
  expect(h.owner().materials.every((view) => view.status === 'loading')).toBe(true);
  await release(a.opens[1]!);
  expect(h.owner().materials[0]?.text).toBe('A');
  expect(a.closed).toContain(a.opens[1]!.readId);
});

test('hiding a tab or document cancels held reads and late opens still close without restoring a body', async () => {
  const a = await fixtureSource('hidden'),
    h = harness();
  await h.render(a.source);
  await h.request([target()]);
  await h.request([]);
  expect(a.opens[0]!.signal!.aborted).toBe(true);
  await release(a.opens[0]!);
  expect(a.closed).toContain(a.opens[0]!.readId);
  expect(h.owner().materials).toEqual([]);
  await h.request([target()]);
  const held = a.opens.at(-1)!;
  await act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
  });
  expect(held.signal!.aborted).toBe(true);
  await release(held);
  expect(a.closed).toContain(held.readId);
  expect(h.owner().materials).toEqual([]);
});

test('an old version binds its original observation and missing refs never start an evidence open', async () => {
  const a = await fixtureSource('old content'),
    h = harness();
  await h.render(a.source, 'history', '9');
  const old = target('5', 'prefix-v1');
  const missing = target('6', 'not-exported');
  missing.reference.availability = 'missing';
  await h.request([old, missing]);
  expect(a.opens).toHaveLength(1);
  expect(a.opens[0]!.input).toMatchObject({
    atCursor: '5',
    upperCursor: '100',
    contentVersion: 'prefix-v1',
    eventId: old.event.eventId,
  });
  await release(a.opens[0]!);
  expect(h.owner().materials.find((view) => view.contentVersion === 'not-exported')?.status).toBe(
    'missing',
  );
  expect(h.owner().materials.find((view) => view.contentVersion === 'prefix-v1')?.text).toBe(
    'old content',
  );
  await h.request([target('10', 'future')]);
  expect(a.opens).toHaveLength(1);
  expect(h.owner().materials[0]?.status).toBe('unavailable');
  expect(h.owner().materials[0]?.notice).toContain('identity_mismatch');
});
