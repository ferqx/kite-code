import { expect, mock, test } from 'bun:test';
import { createTrajectoryBundle, openTrajectoryBundle } from '@kite-ai/client';
import {
  createTrajectoryEventId,
  type TrajectoryEvent,
  type TrajectorySnapshot,
} from '@kite-ai/trajectory';
import type { openNativeTrajectoryBundle } from '../../electron/trajectory-bundle';

type Opened = Awaited<ReturnType<typeof openNativeTrajectoryBundle>>;
let complete!: (opened: Opened) => void;
class CleanupFailure extends Error {}
mock.module('../../electron/trajectory-bundle', () => ({
  openNativeTrajectoryBundle: () =>
    new Promise<Opened>((resolve) => {
      complete = resolve;
    }),
  TrajectoryBundleCleanupError: CleanupFailure,
}));
const { NativeTrajectoryFiles } = await import('../../electron/trajectory-files');

test('local file close waits for a late open and retains the same failed original owner', async () => {
  const files = new NativeTrajectoryFiles();
  let closes = 0,
    closed = false;
  const opening = files.open('/isolated/selected.kite-trajectory');
  void opening.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  const closing = files.close().then(() => {
    closed = true;
  });
  void closing.catch(() => {});
  await Promise.resolve();
  expect(closed).toBe(false);
  const failure = Error('fixture_original_close_unknown');
  complete({
    bundle: {} as Opened['bundle'],
    close() {
      closes++;
      return Promise.reject(failure);
    },
  });
  await expect(opening).rejects.toBe(failure);
  await expect(closing).rejects.toBe(failure);
  await expect(files.close()).rejects.toBe(failure);
  await expect(files.open('/isolated/another.kite-trajectory')).rejects.toBe(failure);
  expect(closes).toBe(1);
  expect(closed).toBe(false);
});

async function localFile(withMaterial = false, multiple = false) {
  const integrity = {
    facts: 'complete' as const,
    identityConfidence: 'verified_origin' as const,
    reasons: [],
  };
  const snapshot: TrajectorySnapshot = {
    storeId: 'store',
    sessionId: 'session',
    upperCursor: '1',
    formatVersion: 1,
    historyCoverage: { enabledAfterCursor: '0', upperCursor: '1', status: 'retained', integrity },
  };
  const origin = { storeId: 'original', cursor: '1' };
  const event: TrajectoryEvent = {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: await createTrajectoryEventId(origin),
    sequence: '1',
    origin,
    workspaceId: 'workspace',
    sessionId: 'session',
    sourceEventType: multiple ? 'execution.succeeded' : 'command.accepted',
    sourceRecordRevision: '1',
    identityConfidence: 'verified_origin',
    ...(multiple
      ? {
          kind: 'model' as const,
          phase: 'completed' as const,
          recordedStatus: 'succeeded',
          attributes: { definitionId: 'model' },
        }
      : {
          kind: 'command' as const,
          phase: 'observed' as const,
          recordedStatus: 'accepted',
          attributes: { commandId: 'command' },
        }),
    occurredAt: 1,
    evidenceRefs: [
      {
        evidenceId: 'bound-ref',
        contentVersion: 'original-v1',
        kind: multiple ? 'model_input' : 'tool_result',
        availability: 'available',
        mediaType: 'text/plain',
      },
      ...(multiple
        ? [
            {
              evidenceId: 'bound-output',
              contentVersion: 'original-v1',
              kind: 'model_output' as const,
              availability: 'available' as const,
              mediaType: 'text/plain',
            },
          ]
        : []),
    ],
  };
  const frames = new Map<string, Uint8Array>();
  for await (const frame of createTrajectoryBundle({
    snapshot,
    async readEvents({ limit: _limit, ...request }) {
      return { ...request, events: [event], scannedThrough: '1', exhausted: true, integrity };
    },
    ...(withMaterial
      ? {
          async readEvidence(_eventId: string, reference: { evidenceId: string }) {
            return new TextEncoder().encode(
              reference.evidenceId === 'bound-output'
                ? 'saved original output'
                : 'saved original bytes',
            );
          },
        }
      : {}),
  }))
    frames.set(frame.path, Uint8Array.from(frame.bytes));
  const bundle = await openTrajectoryBundle({
    async list() {
      return [...frames.keys()];
    },
    async read(path) {
      const value = frames.get(path);
      if (!value) throw Error('fixture_section_missing');
      return value;
    },
  });
  const files = new NativeTrajectoryFiles();
  let closes = 0;
  const opening = files.open('/isolated/selected.kite-trajectory');
  await Promise.resolve();
  await Promise.resolve();
  complete({
    bundle,
    async close() {
      closes++;
      bundle.clearCache();
    },
  });
  const opened = await opening;
  if (opened?.kind !== 'trajectory.bundle.opened') throw Error('fixture_open_failed');
  const query = {
    storeId: 'store',
    sessionId: 'session',
    upperCursor: '1',
    atCursor: '1',
    eventId: event.eventId,
    evidenceId: 'bound-ref',
    contentVersion: 'original-v1',
  };
  return { files, frames, bundle, bundleId: opened.bundleId, query, closes: () => closes };
}

test('one selected local bundle reads input and output concurrently with independent offsets and close identities', async () => {
  const f = await localFile(true, true);
  try {
    const [input, output] = await Promise.all(
      ['bound-ref', 'bound-output'].map((evidenceId) =>
        f.files.invoke({
          method: 'evidence.open',
          bundleId: f.bundleId,
          request: { ...f.query, evidenceId },
        }),
      ),
    );
    if (
      input?.kind !== 'trajectory.evidence.opened' ||
      output?.kind !== 'trajectory.evidence.opened'
    )
      throw Error('fixture_material_not_opened');
    expect(input.trajectory.readId).not.toBe(output.trajectory.readId);
    const inputRead = {
      method: 'evidence.read' as const,
      bundleId: f.bundleId,
      readId: input.trajectory.readId,
      offset: '0',
      limit: 6,
    };
    expect(await f.files.invoke(inputRead)).toMatchObject({
      trajectory: { data: Buffer.from('saved ').toString('base64'), nextOffset: '6', eof: false },
    });
    await expect(f.files.invoke(inputRead)).rejects.toThrow('trajectory_evidence_offset_invalid');
    await f.files.invoke({
      method: 'evidence.close',
      bundleId: f.bundleId,
      readId: input.trajectory.readId,
    });
    await expect(f.files.invoke({ ...inputRead, offset: '6' })).rejects.toThrow(
      'trajectory_evidence_offset_invalid',
    );
    expect(
      await f.files.invoke({ ...inputRead, readId: output.trajectory.readId, limit: 65536 }),
    ).toMatchObject({
      trajectory: { data: Buffer.from('saved original output').toString('base64'), eof: true },
    });
  } finally {
    await f.files.close();
  }
});

test('local Evidence lease limits include pending and active reads without evicting another owner', async () => {
  const f = await localFile(true);
  try {
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => (settle = resolve));
    const original = f.bundle.readEvidence.bind(f.bundle);
    f.bundle.readEvidence = async (...args) => {
      await gate;
      return original(...args);
    };
    const pending = Promise.all(
      Array.from({ length: 16 }, () =>
        f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
      ),
    );
    await expect(
      f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
    ).rejects.toThrow('trajectory_evidence_lease_limit');
    settle();
    const opened = await pending;
    await expect(
      f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
    ).rejects.toThrow('trajectory_evidence_lease_limit');
    const first = opened[0];
    if (first?.kind !== 'trajectory.evidence.opened') throw Error('fixture_material_not_opened');
    await f.files.invoke({
      method: 'evidence.close',
      bundleId: f.bundleId,
      readId: first.trajectory.readId,
    });
    expect(
      await f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
    ).toMatchObject({ kind: 'trajectory.evidence.opened' });
  } finally {
    await f.files.close();
  }
});

test('concurrent local Evidence reserves section bytes before I/O and returns failed reservations to the same bundle', async () => {
  const f = await localFile(true);
  try {
    const manifest = f.bundle.manifest;
    const manifestOwner = Object.getOwnPropertyDescriptor(f.bundle, 'manifest')!;
    const section = manifest.sections.find((value) => value.kind === 'evidence')!;
    section.bytes = String(64 * 1024 * 1024);
    Object.defineProperty(f.bundle, 'manifest', { value: manifest, configurable: true });
    let reject!: (error: Error) => void;
    const gate = new Promise<Uint8Array>((_resolve, fail) => (reject = fail));
    const original = f.bundle.readEvidence.bind(f.bundle);
    f.bundle.readEvidence = () => gate;
    const pending = Promise.allSettled(
      Array.from({ length: 2 }, () =>
        f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
    ).rejects.toThrow('trajectory_evidence_lease_budget');
    reject(Error('fixture_original_read_failed'));
    const results = await pending;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    f.bundle.readEvidence = original;
    Object.defineProperty(f.bundle, 'manifest', manifestOwner);
    expect(
      await f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
    ).toMatchObject({ kind: 'trajectory.evidence.opened' });
  } finally {
    await f.files.close();
  }
});

test('replacing the local bundle revokes every old lease and rejects a late old material open', async () => {
  const f = await localFile(true, true);
  const leases = await Promise.all(
    ['bound-ref', 'bound-output'].map((evidenceId) =>
      f.files.invoke({
        method: 'evidence.open',
        bundleId: f.bundleId,
        request: { ...f.query, evidenceId },
      }),
    ),
  );
  let settle!: () => void;
  const gate = new Promise<void>((resolve) => (settle = resolve));
  const read = f.bundle.readEvidence.bind(f.bundle);
  f.bundle.readEvidence = async (...args) => {
    await gate;
    return read(...args);
  };
  const pending = f.files.invoke({
    method: 'evidence.open',
    bundleId: f.bundleId,
    request: f.query,
  });
  void pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const opening = f.files.open('/isolated/replacement.kite-trajectory');
  await new Promise((resolve) => setTimeout(resolve, 0));
  complete({ bundle: f.bundle, async close() {} });
  const replacement = await opening;
  if (replacement?.kind !== 'trajectory.bundle.opened') throw Error('fixture_open_failed');
  expect(replacement.bundleId).not.toBe(f.bundleId);
  settle();
  await expect(pending).rejects.toThrow('trajectory_bundle_view_changed');
  for (const lease of leases) {
    if (lease?.kind !== 'trajectory.evidence.opened') throw Error('fixture_material_not_opened');
    for (const bundleId of [f.bundleId, replacement.bundleId])
      await expect(
        f.files.invoke({
          method: 'evidence.read',
          bundleId,
          readId: lease.trajectory.readId,
          offset: '0',
        }),
      ).rejects.toThrow(
        bundleId === f.bundleId
          ? 'trajectory_bundle_view_changed'
          : 'trajectory_evidence_offset_invalid',
      );
  }
  // An old pending reservation must not consume the new bundle's capacity.
  expect(
    await f.files.invoke({
      method: 'evidence.open',
      bundleId: replacement.bundleId,
      request: f.query,
    }),
  ).toMatchObject({ kind: 'trajectory.evidence.opened' });
  await f.files.close();
  expect(f.closes()).toBe(1);
});

test('a verified event/ref without a packaged section reports material missing and closes its original file owner', async () => {
  const f = await localFile();
  try {
    await expect(
      f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
    ).rejects.toThrow('trajectory_evidence_missing');
  } finally {
    await f.files.close();
    await f.files.close();
  }
  expect(f.closes()).toBe(1);
});

test.each([
  'event',
  'reference',
  'version',
  'scope',
] as const)('a forged %s remains denied rather than becoming a known omitted material', async (kind) => {
  const f = await localFile();
  const request = {
    ...f.query,
    ...(kind === 'event'
      ? { eventId: 'forged-event' }
      : kind === 'reference'
        ? { evidenceId: 'forged-ref' }
        : kind === 'version'
          ? { contentVersion: 'forged-version' }
          : { storeId: 'foreign-store' }),
  };
  try {
    await expect(
      f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request }),
    ).rejects.toThrow(
      kind === 'scope' ? 'trajectory_bundle_scope_denied' : 'trajectory_evidence_unavailable',
    );
  } finally {
    await f.files.close();
  }
  expect(f.closes()).toBe(1);
});

test('a real packaged section integrity failure propagates instead of becoming material missing', async () => {
  const f = await localFile(true);
  const path = [...f.frames.keys()].find((path) => path.startsWith('evidence/'))!,
    bytes = f.frames.get(path)!;
  bytes[0] = bytes[0]! ^ 1;
  try {
    await expect(
      f.files.invoke({ method: 'evidence.open', bundleId: f.bundleId, request: f.query }),
    ).rejects.toThrow('trajectory_bundle_section_integrity');
  } finally {
    await f.files.close();
  }
  expect(f.closes()).toBe(1);
});
