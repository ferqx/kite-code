import {
  type TrajectoryEvent,
  type TrajectoryIntegrity,
  type TrajectoryReadRequest,
  type TrajectorySnapshot,
  trajectoryEventSchema,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import { decodeResponse } from '../src/decode';
import {
  createTrajectoryBundle,
  openTrajectoryBundle,
  type TrajectoryBundleDirectory,
} from '../src/trajectory-bundle';
import { TrajectoryReplayController, type TrajectoryReplaySource } from '../src/trajectory-replay';

const integrity: TrajectoryIntegrity = {
  facts: 'complete',
  identityConfidence: 'verified_origin',
  reasons: [],
};
function event(seq: number, patch: Record<string, unknown> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${seq.toString(16).padStart(64, '0')}`,
    sequence: String(seq),
    origin: { storeId: 'origin', cursor: String(seq) },
    sessionId: 'session',
    workspaceId: 'workspace',
    executionId: 'execution',
    sourceEventType: 'execution.running',
    sourceRecordRevision: String(seq),
    kind: 'model',
    phase: 'running',
    recordedStatus: 'running',
    occurredAt: null,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...patch,
  });
}
function source(
  events: TrajectoryEvent[],
  upper = String(events.at(-1)?.sequence ?? '0'),
  offline = true,
): TrajectoryReplaySource {
  const snapshot: TrajectorySnapshot = {
    storeId: 'read-store',
    sessionId: 'session',
    upperCursor: upper,
    formatVersion: 1,
    historyCoverage: {
      enabledAfterCursor: '0',
      upperCursor: upper,
      status: 'retained',
      integrity: structuredClone(integrity),
    },
  };
  return {
    snapshot,
    offline,
    async readEvents(request: TrajectoryReadRequest, signal) {
      signal?.throwIfAborted();
      const candidates = events.filter(
        (item) =>
          BigInt(item.sequence) > BigInt(request.afterCursor) &&
          BigInt(item.sequence) <= BigInt(request.upperCursor),
      );
      const selected = candidates.slice(0, request.limit ?? 200);
      const exhausted = selected.length === candidates.length;
      const scannedThrough = exhausted ? request.upperCursor : selected.at(-1)!.sequence;
      const { limit: _limit, ...scope } = request;
      return {
        ...scope,
        events: structuredClone(selected),
        scannedThrough,
        exhausted,
        integrity: structuredClone(integrity),
      };
    },
  };
}
function directory(files: Map<string, Uint8Array>): TrajectoryBundleDirectory {
  return {
    async list() {
      return [...files.keys()];
    },
    async read(path) {
      const bytes = files.get(path);
      if (!bytes) throw Error('missing');
      return Uint8Array.from(bytes);
    },
  };
}
async function bundle(events = [event(1), event(3), event(9)], fromCursor = '0') {
  const files = new Map<string, Uint8Array>();
  const original = source(events, String(events.at(-1)?.sequence ?? '0'));
  for await (const frame of createTrajectoryBundle({
    snapshot: original.snapshot,
    fromCursor,
    readEvents: original.readEvents,
  }))
    files.set(frame.path, frame.bytes);
  return files;
}

test('generated wire decoding and offline export preserve output presence without acquiring output bodies', async () => {
  const events = ['model', 'message'].map((kind, index) => {
    const reference = {
      kind: kind === 'model' ? 'model_output' : 'message',
      evidenceId: `${kind}-output`,
      contentVersion: `${kind}-version`,
      availability: 'available',
      mediaType: 'application/json',
    };
    const display = {
      kind,
      outputPresence: {
        hasText: false,
        toolCallCount: 1,
        complete: true,
        evidenceId: reference.evidenceId,
        contentVersion: reference.contentVersion,
      },
    };
    return event(index + 1, {
      kind,
      phase: kind === 'model' ? 'completed' : 'observed',
      recordedStatus: kind === 'model' ? 'succeeded' : 'complete',
      attributes:
        kind === 'model'
          ? { display }
          : {
              messageId: 'reply',
              role: 'assistant',
              messageSeq: '1',
              revision: '2',
              status: 'complete',
              display,
            },
      evidenceRefs: [reference],
    });
  });
  const query = { storeId: 'read-store', sessionId: 'session', afterCursor: '0', upperCursor: '2' };
  const page = await source(events).readEvents(query, new AbortController().signal);
  expect(decodeResponse('TrajectoryPage', page)).toEqual(page);
  const local = await openTrajectoryBundle(directory(await bundle(events)));
  expect((await local.readEvents(query)).events).toEqual(events);
  expect(await local.readEvidence(events[0]!.eventId, 'model-output', 'model-version')).toBeNull();
  for (const invalid of [
    {
      ...page,
      events: [
        {
          ...events[0],
          attributes: {
            display: {
              kind: 'model',
              outputPresence: {
                hasText: false,
                toolCallCount: 1,
                complete: true,
                evidenceId: 'model-output',
                contentVersion: 'model-version',
                reasoning: 'PRIVATE',
              },
            },
          },
        },
      ],
    },
    {
      ...page,
      events: [
        {
          ...events[0],
          attributes: {
            display: {
              kind: 'model',
              outputPresence: {
                hasText: false,
                toolCallCount: -1,
                complete: true,
                evidenceId: 'model-output',
                contentVersion: 'model-version',
              },
            },
          },
        },
      ],
    },
  ])
    expect(() => verifyTrajectoryPage(decodeResponse('TrajectoryPage', invalid), query)).toThrow();
});

test('offline controls seek and step both directions without executing any injected latest loader', async () => {
  const original = source([event(1), event(3), event(9)], '10');
  const controller = new TrajectoryReplayController(original, { cursor: '0' });
  expect(controller.state).toMatchObject({
    mode: 'replay',
    offline: true,
    cursor: '0',
    upperCursor: '10',
    playing: false,
  });
  controller.play();
  await controller.tick();
  expect(controller.state.cursor).toBe('1');
  expect(controller.state.playing).toBe(true);
  controller.pause();
  expect(controller.state.playing).toBe(false);
  await controller.step(1);
  expect(controller.state.cursor).toBe('3');
  await controller.step(-1);
  expect(controller.state.cursor).toBe('1');
  controller.seek('9');
  await controller.step(-1);
  expect(controller.state.cursor).toBe('3');
  controller.setVisible(false);
  controller.play();
  expect(controller.state.playing).toBe(false);
  let requests = 0;
  await controller.returnToLatest(async () => {
    requests++;
    throw Error('network forbidden');
  });
  expect(requests).toBe(0);
  expect(controller.state.cursor).toBe('10');
  expect(controller.state.mode).toBe('replay');
  expect(() => controller.seek('11')).toThrow('trajectory_cursor_ahead');
});

test('history keeps fixed upper on notifications; explicit online return reloads exact original scope', async () => {
  const controller = new TrajectoryReplayController(source([event(1), event(3)], '3', false));
  controller.seek('1');
  controller.notifyNewEvents('9');
  expect(controller.state).toMatchObject({
    cursor: '1',
    upperCursor: '3',
    newEventsAvailable: true,
  });
  await controller.returnToLatest(async () => source([event(1), event(3), event(9)], '9', false));
  expect(controller.state).toMatchObject({
    mode: 'live',
    cursor: '9',
    upperCursor: '9',
    newEventsAvailable: false,
  });
  await expect(
    controller.returnToLatest(async () => {
      const foreign = source([], '10', false);
      foreign.snapshot.sessionId = 'another-session';
      return foreign;
    }),
  ).rejects.toThrow('trajectory_latest_identity_mismatch');
  expect(controller.state.upperCursor).toBe('9');
});

test('late local read cannot replace a later seek or a hidden selection', async () => {
  let finish!: () => void;
  const original = source([event(1), event(3)], '3');
  const controller = new TrajectoryReplayController(
    {
      ...original,
      async readEvents(request, signal) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return original.readEvents(request, signal);
      },
    },
    { cursor: '0' },
  );
  const pending = controller.step(1);
  controller.seek('3');
  finish();
  await expect(pending).rejects.toThrow();
  expect(controller.state.cursor).toBe('3');
  controller.close();
  expect(() => controller.seek('1')).toThrow('trajectory_replay_closed');
});

test('bundle export and cold local open preserve precise pages with a bounded cache and no material fallback', async () => {
  const events = Array.from({ length: 610 }, (_, index) => event(index + 1));
  const files = await bundle(events);
  const reads: string[] = [];
  const port = directory(files);
  const local = await openTrajectoryBundle(
    {
      ...port,
      async read(path, signal) {
        reads.push(path);
        return port.read(path, signal);
      },
    },
    { maxCacheBytes: 1024 },
  );
  expect(reads).toEqual(['manifest.json']);
  let after = '0';
  const ids: string[] = [];
  while (true) {
    const page = await local.readEvents({
      storeId: 'read-store',
      sessionId: 'session',
      afterCursor: after,
      upperCursor: '610',
      limit: 37,
    });
    ids.push(...page.events.map((item) => item.eventId));
    expect(local.cacheBytes).toBeLessThanOrEqual(1024);
    if (page.exhausted) break;
    after = page.scannedThrough;
  }
  expect(ids).toHaveLength(610);
  expect(new Set(ids).size).toBe(610);
  expect(await local.readEvidence(events[0]!.eventId, 'not-packaged', 'v1')).toBeNull();
  local.clearCache();
  expect(local.cacheBytes).toBe(0);
});

test('bundle rejects path traversal, duplicate entries, unknown version, budgets and changed section bytes', async () => {
  const files = await bundle();
  const original = directory(files);
  await expect(
    openTrajectoryBundle({
      ...original,
      async list() {
        return [...files.keys(), '../secret'];
      },
    }),
  ).rejects.toThrow('trajectory_bundle_directory_invalid');
  await expect(
    openTrajectoryBundle({
      ...original,
      async list() {
        return [...files.keys(), 'manifest.json'];
      },
    }),
  ).rejects.toThrow('trajectory_bundle_directory_invalid');
  await expect(openTrajectoryBundle(original, { maxTotalBytes: 1 })).rejects.toThrow(
    'trajectory_bundle_total_budget',
  );
  const unknown = new Map(files);
  const manifest = JSON.parse(new TextDecoder().decode(unknown.get('manifest.json')));
  manifest.version = 2;
  unknown.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  await expect(openTrajectoryBundle(directory(unknown))).rejects.toThrow(
    'trajectory_bundle_manifest_invalid',
  );
  const changed = new Map(files);
  changed.set('events/00000000.jsonl', new TextEncoder().encode('[]'));
  const local = await openTrajectoryBundle(directory(changed));
  await expect(
    local.readEvents({
      storeId: 'read-store',
      sessionId: 'session',
      afterCursor: '0',
      upperCursor: '9',
    }),
  ).rejects.toThrow();
});

test('middle-range bundle stays partial, refuses a fabricated prefix and uses its real local lower bound', async () => {
  const local = await openTrajectoryBundle(
    directory(await bundle([event(1), event(3), event(9)], '1')),
  );
  expect(local.manifest.completePrefix).toBe(false);
  expect(local.snapshot.historyCoverage.integrity).toMatchObject({
    facts: 'partial',
    reasons: ['incomplete_prefix'],
  });
  await expect(
    local.readEvents({
      storeId: 'read-store',
      sessionId: 'session',
      afterCursor: '0',
      upperCursor: '9',
    }),
  ).rejects.toThrow('trajectory_bundle_request_invalid');
  const controller = new TrajectoryReplayController(local);
  expect(() => controller.seek('0')).toThrow();
  await controller.step(-1);
  expect(controller.state.cursor).toBe('3');
  await controller.step(-1);
  expect(controller.state.cursor).toBe('1');
});

test('optional packaged evidence is bound to exact old content version, verified locally and never upgraded', async () => {
  const ref = {
    evidenceId: 'evidence',
    contentVersion: 'old-head',
    kind: 'model_output' as const,
    availability: 'partial' as const,
    mediaType: 'text/plain',
  };
  const original = source([event(1, { evidenceRefs: [ref] }), event(3)], '3');
  const files = new Map<string, Uint8Array>();
  for await (const frame of createTrajectoryBundle({
    snapshot: original.snapshot,
    readEvents: original.readEvents,
    async readEvidence(_eventId, reference) {
      expect(reference.contentVersion).toBe('old-head');
      return new TextEncoder().encode('original prefix');
    },
  }))
    files.set(frame.path, frame.bytes);
  const local = await openTrajectoryBundle(directory(files));
  expect(
    new TextDecoder().decode((await local.readEvidence(event(1).eventId, 'evidence', 'old-head'))!),
  ).toBe('original prefix');
  expect(await local.readEvidence(event(1).eventId, 'evidence', 'latest')).toBeNull();
});
