import { TrajectoryReplayController, type TrajectoryReplaySource } from '@kite-ai/client';
import {
  type TrajectoryEvent,
  type TrajectorySnapshot,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import type { NativeBridge, NativeRequest } from '../src/native-bridge';
import {
  loadNativeTrajectory,
  type NativeTrajectoryLocalCache,
  openNativeTrajectorySnapshot,
} from '../src/trajectory-bridge';

const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
const snapshot: TrajectorySnapshot = {
  storeId: 'store',
  sessionId: 'session',
  upperCursor: '410',
  formatVersion: 1,
  historyCoverage: { enabledAfterCursor: '0', upperCursor: '410', status: 'retained', integrity },
};
const events = Array.from({ length: 410 }, (_, index) =>
  trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${(index + 1).toString(16).padStart(64, '0')}`,
    sequence: String(index + 1),
    origin: { storeId: 'store', cursor: String(index + 1) },
    sessionId: 'session',
    workspaceId: 'workspace',
    executionId: 'model',
    sourceEventType: 'execution.running',
    sourceRecordRevision: String(index + 1),
    kind: 'model',
    phase: 'running',
    recordedStatus: 'running',
    occurredAt: null,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
  }),
);
function memoryCache() {
  const files = new Map<string, Uint8Array>();
  let closed = false;
  const cache: NativeTrajectoryLocalCache = {
    async list() {
      if (closed) throw Error('closed');
      return [...files.keys()];
    },
    async read(path) {
      if (closed || !files.has(path)) throw Error('closed');
      return Uint8Array.from(files.get(path)!);
    },
    async write(path, bytes) {
      if (closed) throw Error('closed');
      files.set(path, Uint8Array.from(bytes));
    },
    async close() {
      closed = true;
      files.clear();
    },
  };
  return { cache, files, isClosed: () => closed };
}
function fixture(upper = '410') {
  const calls: NativeRequest[] = [];
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(input) {
      calls.push(structuredClone(input));
      if (input.method === 'trajectory.open')
        return {
          kind: 'trajectory.snapshot',
          trajectory: {
            ...snapshot,
            upperCursor: upper,
            historyCoverage: { ...snapshot.historyCoverage, upperCursor: upper },
          },
        };
      if (input.method === 'trajectory.events') {
        const { limit: _limit, ...scope } = input.request;
        const candidates = events.filter(
          (event) =>
            BigInt(event.sequence) > BigInt(input.request.afterCursor) &&
            BigInt(event.sequence) <= BigInt(input.request.upperCursor),
        );
        const selected = candidates.slice(0, input.request.limit ?? 200);
        const exhausted = selected.length === candidates.length;
        return {
          kind: 'trajectory.page',
          trajectory: {
            ...scope,
            scannedThrough: exhausted ? input.request.upperCursor : selected.at(-1)!.sequence,
            exhausted,
            events: selected,
            integrity,
          },
        };
      }
      throw Error('business_request_forbidden');
    },
  };
  return { bridge, calls };
}

test('explicit Native loader pages a fixed snapshot; all later playback and seek stay local', async () => {
  const f = fixture();
  const memory = memoryCache();
  const descriptor = await openNativeTrajectorySnapshot(f.bridge, 7, {
    storeId: 'store',
    sessionId: 'session',
  });
  const loaded = await loadNativeTrajectory({
    bridge: f.bridge,
    generation: 7,
    snapshot: descriptor,
    cacheFactory: async () => memory.cache,
  });
  expect(f.calls.map((call) => call.method)).toEqual([
    'trajectory.open',
    'trajectory.events',
    'trajectory.events',
    'trajectory.events',
  ]);
  expect(memory.files.has('manifest.json')).toBe(true);
  const count = f.calls.length;
  const player = new TrajectoryReplayController(
    { ...loaded.source, offline: false },
    { mode: 'history', cursor: '0' },
  );
  player.play();
  await player.tick();
  expect(player.state.cursor).toBe('1');
  player.seek('400');
  await player.step(-1);
  expect(player.state.cursor).toBe('399');
  await player.step(1);
  expect(player.state.cursor).toBe('400');
  expect(f.calls).toHaveLength(count);
  expect(loaded.source.cacheBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  player.close();
  await loaded.close();
  expect(memory.isClosed()).toBe(true);
});

test('cancelled snapshot loading leaves no completed package and closes the temporary owner', async () => {
  const f = fixture();
  const memory = memoryCache();
  const abort = new AbortController();
  const bridge: NativeBridge = {
    ...f.bridge,
    async request(input) {
      const value = await f.bridge.request(input);
      if (input.method === 'trajectory.events') abort.abort();
      return value;
    },
  };
  await expect(
    loadNativeTrajectory({
      bridge,
      generation: 7,
      snapshot,
      cacheFactory: async () => memory.cache,
      signal: abort.signal,
    }),
  ).rejects.toThrow();
  expect(memory.isClosed()).toBe(true);
  expect(memory.files.size).toBe(0);
});

test('live loading copies the validated local prefix and fetches only the new fixed range', async () => {
  const before = fixture('200');
  const oldMemory = memoryCache();
  const old = await loadNativeTrajectory({
    bridge: before.bridge,
    generation: 7,
    snapshot: {
      ...snapshot,
      upperCursor: '200',
      historyCoverage: { ...snapshot.historyCoverage, upperCursor: '200' },
    },
    cacheFactory: async () => oldMemory.cache,
  });
  const next = fixture();
  const newMemory = memoryCache();
  const loaded = await loadNativeTrajectory({
    bridge: next.bridge,
    generation: 7,
    snapshot,
    previous: old.source,
    cacheFactory: async () => newMemory.cache,
  });
  expect(
    next.calls
      .filter((call) => call.method === 'trajectory.events')
      .map((call) => (call.method === 'trajectory.events' ? call.request.afterCursor : '')),
  ).toEqual(['200', '400']);
  await old.close();
  const page = await loaded.source.readEvents({
    storeId: 'store',
    sessionId: 'session',
    afterCursor: '0',
    upperCursor: '410',
    limit: 1,
  });
  expect(page.events[0]!.sequence).toBe('1');
  await loaded.close();
});

test('local view starts from a real prefix and can restore any exact saved page cursor', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const f = fixture();
  const memory = memoryCache();
  const loaded = await loadNativeTrajectory({
    bridge: f.bridge,
    generation: 7,
    snapshot,
    cacheFactory: async () => memory.cache,
  });
  const count = f.calls.length;
  const view = await readNativeTrajectoryView(loaded.source, '409', '205');
  expect(view.events[0]!.sequence).toBe('206');
  expect(view.events.at(-1)!.sequence).toBe('405');
  expect(view.projection.sourceEventIds).toHaveLength(409);
  expect(view.navigation).toEqual({ after: '205', through: '405', previous: '200', next: '405' });
  const old = await readNativeTrajectoryView(loaded.source, '399');
  expect(old.events.at(-1)!.sequence).toBe('399');
  expect(old.navigation.through).toBe('399');
  await expect(readNativeTrajectoryView(loaded.source, '100', '205')).rejects.toThrow(
    'trajectory_view_position_invalid',
  );
  expect(f.calls).toHaveLength(count);
  await loaded.close();
});

function localSource(facts: TrajectoryEvent[], upperCursor = facts.at(-1)!.sequence) {
  const afters: string[] = [];
  const source: TrajectoryReplaySource = {
    snapshot: {
      ...snapshot,
      upperCursor,
      historyCoverage: { ...snapshot.historyCoverage, upperCursor },
    },
    offline: true,
    async readEvents(query, signal) {
      signal?.throwIfAborted();
      afters.push(query.afterCursor);
      const candidates = facts.filter(
        (event) =>
          BigInt(event.sequence) > BigInt(query.afterCursor) &&
          BigInt(event.sequence) <= BigInt(query.upperCursor),
      );
      const page = candidates.slice(0, query.limit ?? 200);
      const exhausted = candidates.length === page.length;
      return {
        storeId: query.storeId,
        sessionId: query.sessionId,
        afterCursor: query.afterCursor,
        upperCursor: query.upperCursor,
        scannedThrough: exhausted ? query.upperCursor : page.at(-1)!.sequence,
        exhausted,
        events: page,
        integrity,
      };
    },
  };
  return { source, afters };
}

test('a later raw page retains the full tree index and a node reads early parent and later descendants', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const facts = events.map((event, index) =>
    trajectoryEventSchema.parse({
      ...event,
      executionId: index === 0 || index === 349 ? 'parent' : index === 200 ? 'child' : 'unrelated',
      ...(index === 200
        ? { parentExecutionId: 'parent', parentExecutionOriginStoreId: 'store' }
        : {}),
      phase: index === 349 ? 'completed' : 'running',
    }),
  );
  const { source } = localSource(facts);
  const root = await readNativeTrajectoryView(source, '410');
  expect(root.events[0]!.sequence).toBe('401');
  expect(root.projection.steps).toHaveLength(3);
  expect(
    root.projection.steps.find((step) => step.executionId === 'parent')!.sourceEventIds,
  ).toEqual([facts[0]!.eventId, facts[349]!.eventId]);
  const parent = await readNativeTrajectoryView(
    source,
    '410',
    undefined,
    undefined,
    'execution:parent',
  );
  expect(parent.selectedNodeId).toBe('execution:parent');
  expect(parent.events.map((event) => event.sequence)).toEqual(['1', '201', '350']);
  expect(parent.navigation).toEqual({ after: '0', through: '410' });
  const earlier = await readNativeTrajectoryView(
    source,
    '199',
    undefined,
    undefined,
    'execution:parent',
  );
  expect(earlier.events.map((event) => event.sequence)).toEqual(['1']);
  expect(earlier.projection.steps.some((step) => step.executionId === 'child')).toBe(false);
});

test('selected node lifecycle pages remain bounded and cover every sparse event exactly once', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const facts = Array.from({ length: 1000 }, (_, index) =>
    trajectoryEventSchema.parse({
      ...events[0]!,
      eventId: `te_${(index + 1).toString(16).padStart(64, '0')}`,
      sequence: String(index + 1),
      origin: { storeId: 'store', cursor: String(index + 1) },
      executionId: index % 2 === 0 ? 'chosen' : 'other',
      sourceRecordRevision: String(index + 1),
    }),
  );
  const { source } = localSource(facts);
  let after: string | undefined;
  const seen: string[] = [];
  const windows: { after: string; through: string; previous?: string; next?: string }[] = [];
  do {
    const view = await readNativeTrajectoryView(
      source,
      '1000',
      after,
      undefined,
      'execution:chosen',
    );
    expect(view.events.length).toBeLessThanOrEqual(200);
    expect(view.events.every((event) => event.executionId === 'chosen')).toBe(true);
    expect(view.projection.sourceEventIds).toHaveLength(1000);
    seen.push(...view.events.map((event) => event.sequence));
    windows.push(view.navigation);
    after = view.navigation.next;
  } while (after !== undefined);
  expect(seen).toEqual(
    facts.filter((event) => event.executionId === 'chosen').map((event) => event.sequence),
  );
  expect(windows).toEqual([
    { after: '0', through: '399', next: '399' },
    { after: '399', through: '799', previous: '0', next: '799' },
    { after: '799', through: '1000', previous: '399' },
  ]);
});

test('missing retained selection falls back to the root without inventing a node or future event', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const { source } = localSource(events);
  const view = await readNativeTrajectoryView(
    source,
    '1',
    undefined,
    undefined,
    'execution:missing',
  );
  expect(view.selectedNodeId).toBe('session');
  expect(view.events.map((event) => event.sequence)).toEqual(['1']);
  expect(view.projection.sourceEventIds).toEqual([events[0]!.eventId]);
});

test('node detail scanning crosses empty pages and preserves Decimal64 positions without future facts', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const gap = 9007199254740993n;
  const facts = [1n, 501n].map((offset, index) =>
    trajectoryEventSchema.parse({
      ...events[index]!,
      sequence: String(gap + offset),
      origin: { storeId: 'store', cursor: String(gap + offset) },
    }),
  );
  const { source } = localSource(facts);
  const sparse: TrajectoryReplaySource = {
    ...source,
    async readEvents(query, signal) {
      if (query.afterCursor !== '0') return source.readEvents(query, signal);
      return {
        storeId: query.storeId,
        sessionId: query.sessionId,
        afterCursor: query.afterCursor,
        upperCursor: query.upperCursor,
        scannedThrough: String(gap),
        exhausted: false,
        events: [],
        integrity,
      };
    },
  };
  const view = await readNativeTrajectoryView(
    sparse,
    String(gap + 1n),
    undefined,
    undefined,
    'execution:model',
  );
  expect(view.events.map((event) => event.sequence)).toEqual([String(gap + 1n)]);
  expect(view.projection.sourceEventIds).toEqual([facts[0]!.eventId]);
  expect(view.navigation).toEqual({ after: '0', through: String(gap + 1n) });
});

test('cancelling the selected-node second pass never returns a partial detail page', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const { source } = localSource(events);
  const controller = new AbortController();
  let reads = 0;
  const cancellable: TrajectoryReplaySource = {
    ...source,
    async readEvents(query, signal) {
      const page = await source.readEvents(query, signal);
      if (++reads === 4) controller.abort();
      return page;
    },
  };
  await expect(
    readNativeTrajectoryView(cancellable, '410', undefined, controller.signal, 'execution:model'),
  ).rejects.toThrow();
  expect(reads).toBe(4);
});

test('the latest root lifecycle stays on its last nonempty page across a filtered empty tail', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const { source } = localSource(events.slice(0, 3), '1000');
  const sparse: TrajectoryReplaySource = {
    ...source,
    async readEvents(query, signal) {
      if (query.afterCursor !== '0') return source.readEvents(query, signal);
      return { ...(await source.readEvents(query, signal)), scannedThrough: '3', exhausted: false };
    },
  };
  const view = await readNativeTrajectoryView(sparse, '1000');
  expect(view.events.map((event) => event.sequence)).toEqual(['1', '2', '3']);
  expect(view.navigation).toEqual({ after: '0', through: '1000' });
  expect(view.projection.sourceEventIds).toHaveLength(3);
});

test('root latest and previous use matching-event page boundaries across sparse full-store scans', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const facts = Array.from({ length: 225 }, (_, index) => {
    const sequence = String(index * 2 + 1);
    return trajectoryEventSchema.parse({
      ...events[0]!,
      eventId: `te_${BigInt(sequence).toString(16).padStart(64, '0')}`,
      sequence,
      origin: { storeId: 'store', cursor: sequence },
    });
  });
  const { source } = localSource(facts, '600');
  const sparse: TrajectoryReplaySource = {
    ...source,
    async readEvents(query) {
      const through =
        BigInt(query.afterCursor) + 200n < 600n ? String(BigInt(query.afterCursor) + 200n) : '600';
      return {
        storeId: query.storeId,
        sessionId: query.sessionId,
        afterCursor: query.afterCursor,
        upperCursor: query.upperCursor,
        scannedThrough: through,
        exhausted: through === '600',
        events: facts.filter(
          (event) =>
            BigInt(event.sequence) > BigInt(query.afterCursor) &&
            BigInt(event.sequence) <= BigInt(through),
        ),
        integrity,
      };
    },
  };
  const latest = await readNativeTrajectoryView(sparse, '600');
  expect(latest.navigation).toEqual({ after: '399', through: '600', previous: '0' });
  expect(latest.events).toHaveLength(25);
  expect(latest.events[0]!.sequence).toBe('401');
  const previous = await readNativeTrajectoryView(sparse, '600', latest.navigation.previous);
  expect(previous.events).toHaveLength(200);
  expect(previous.events[0]!.sequence).toBe('1');
  expect(previous.navigation).toEqual({ after: '0', through: '399', next: '399' });
  expect([...previous.events, ...latest.events].map((event) => event.eventId)).toEqual(
    facts.map((event) => event.eventId),
  );
});

test('default lifecycle pages count retained execution facts across management noise and preserve the full index', async () => {
  const { readNativeTrajectoryView } = await import('../src/trajectory-view');
  const facts = Array.from({ length: 695 }, (_, index) => {
    const sequence = index + 1;
    const execution = sequence <= 675 && sequence % 3 === 0;
    return trajectoryEventSchema.parse({
      ...events[0]!,
      eventId: `te_${BigInt(sequence).toString(16).padStart(64, '0')}`,
      sequence: String(sequence),
      origin: { storeId: 'store', cursor: String(sequence) },
      executionId: execution ? 'model' : undefined,
      kind: execution ? 'model' : 'unknown',
      sourceEventType: execution ? 'execution.running' : 'session.created',
      attributes: execution ? {} : { reason: 'unrecognized_source_type' },
    });
  });
  const original = JSON.stringify(facts);
  const { source } = localSource(facts, '700');
  const latest = await readNativeTrajectoryView(
    source,
    '700',
    undefined,
    undefined,
    'session',
    'key_steps',
  );
  expect(latest.events).toHaveLength(25);
  expect(latest.events[0]!.sequence).toBe('603');
  expect(latest.events.at(-1)!.sequence).toBe('675');
  expect(latest.navigation).toEqual({ after: '600', through: '700', previous: '0' });
  expect(latest.projection.sourceEventIds).toHaveLength(695);
  const previous = await readNativeTrajectoryView(
    source,
    '700',
    latest.navigation.previous,
    undefined,
    'session',
    'key_steps',
  );
  expect(previous.events).toHaveLength(200);
  expect(previous.navigation).toEqual({ after: '0', through: '600', next: '600' });
  expect([...previous.events, ...latest.events].map((event) => event.eventId)).toEqual(
    facts.filter((event) => event.kind === 'model').map((event) => event.eventId),
  );
  const all = await readNativeTrajectoryView(
    source,
    '700',
    '0',
    undefined,
    'session',
    'all_events',
  );
  expect(all.events).toEqual(facts.slice(0, 200));
  expect(all.projection.sourceEventIds).toEqual(latest.projection.sourceEventIds);
  const hiddenSelection = await readNativeTrajectoryView(
    source,
    '700',
    undefined,
    undefined,
    `event:${facts[0]!.eventId}`,
    'key_steps',
  );
  expect(hiddenSelection.selectedNodeId).toBe('session');
  expect(hiddenSelection.events).toEqual(latest.events);
  expect(JSON.stringify(facts)).toBe(original);
});

test('tree-only viewing scans the fixed prefix once and retains the complete index without raw detail pages', async () => {
  const { readNativeTrajectoryView, resolveNativeTrajectorySelection } = await import(
    '../src/trajectory-view'
  );
  const facts = events.map((event, index) =>
    trajectoryEventSchema.parse({
      ...event,
      executionId: index < 200 ? 'first' : 'second',
      ...(index >= 200
        ? { parentExecutionId: 'first', parentExecutionOriginStoreId: 'store' }
        : {}),
    }),
  );
  const { source, afters } = localSource(facts);
  const view = await readNativeTrajectoryView(
    source,
    '410',
    undefined,
    undefined,
    'execution:first',
    'key_steps',
    { treeOnly: true },
  );
  expect(afters).toEqual(['0', '200', '400']);
  expect(view.events).toEqual([]);
  expect(view.projection.sourceEventIds).toEqual(facts.map((event) => event.eventId));
  expect(view.projection.steps).toHaveLength(2);
  expect(view.selectedNodeId).toBe('execution:first');
  expect(view.navigation).toEqual({ after: '0', through: '410' });
  expect(resolveNativeTrajectorySelection(view.projection, 'execution:second', 'key_steps')).toBe(
    'execution:second',
  );
  expect(resolveNativeTrajectorySelection(view.projection, 'execution:missing', 'all_events')).toBe(
    'session',
  );
  expect(afters).toHaveLength(3);
});
