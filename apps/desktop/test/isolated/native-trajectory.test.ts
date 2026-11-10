import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientError } from '@kite-ai/client';
import type {
  TrajectoryEvent,
  TrajectoryEvidenceDescriptor,
  TrajectoryEvidenceOpen,
  TrajectorySnapshot,
} from '@kite-ai/trajectory';
import { createTrajectoryEventId } from '@kite-ai/trajectory';
import { decodeNativeRequest } from '../../electron/native-ipc';
import { NativeTrajectory } from '../../electron/trajectory';
import { openNativeTrajectoryBundle } from '../../electron/trajectory-bundle';

const scope = { storeId: 'store', sessionId: 'session' };
function snapshot(): TrajectorySnapshot {
  return {
    ...scope,
    upperCursor: '9007199254740993',
    formatVersion: 1,
    historyCoverage: {
      enabledAfterCursor: '0',
      upperCursor: '9007199254740993',
      status: 'retained',
      integrity: { facts: 'unknown', identityConfidence: 'verified_origin', reasons: [] },
    },
  };
}
const evidence: TrajectoryEvidenceOpen = {
  ...scope,
  upperCursor: '9007199254740993',
  atCursor: '9007199254740993',
  eventId: 'event',
  evidenceId: 'material',
  contentVersion: 'version',
};
function descriptor(): TrajectoryEvidenceDescriptor {
  return {
    readId: 'lease',
    eventId: 'event',
    evidenceId: 'material',
    contentVersion: 'version',
    availability: 'empty',
    mediaType: 'text/plain',
    viewBytes: '0',
    viewSha256: 'a'.repeat(64),
    transformation: 'public',
    policyRevision: '1',
    authorizationEpoch: '1',
  };
}
test('Native trajectory IPC uses the same strict DTO and keeps event paging stateless', () => {
  expect(decodeNativeRequest({ method: 'trajectory.open', generation: 1, request: scope })).toEqual(
    { method: 'trajectory.open', generation: 1, request: scope },
  );
  const page = { ...scope, afterCursor: '9007199254740992', upperCursor: '9007199254740993' };
  expect(
    decodeNativeRequest({ method: 'trajectory.events', generation: 1, request: page }),
  ).toMatchObject({ request: page });
  for (const request of [
    { ...scope, subjectId: 'foreign' },
    { ...scope, readId: 'not-a-page-lease' },
    { ...scope, upperCursor: '01' },
  ])
    expect(() =>
      decodeNativeRequest({ method: 'trajectory.open', generation: 1, request }),
    ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'trajectory.evidence.read',
      generation: 1,
      request: { ...scope, readId: 'lease', offset: '0', limit: 65537 },
    }),
  ).toThrow('invalid_native_request');
});
test('Native scope changes reject late pages and close an Evidence lease whose open raced selection', async () => {
  let current = { ...scope, generation: 1, selection: 1 };
  let resolveSnapshot: ((value: TrajectorySnapshot) => void) | undefined;
  let resolveEvidence: ((value: TrajectoryEvidenceDescriptor) => void) | undefined;
  const closed: string[] = [];
  const source = new NativeTrajectory(
    {
      openTrajectory: () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
      readTrajectoryEvents: async (request) => ({
        ...request,
        scannedThrough: request.upperCursor,
        exhausted: true,
        events: [],
        integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
      }),
      openTrajectoryEvidence: () =>
        new Promise((resolve) => {
          resolveEvidence = resolve;
        }),
      readTrajectoryEvidenceChunk: async (request) => ({
        readId: request.readId,
        offset: request.offset,
        nextOffset: request.offset,
        data: '',
        eof: true,
        viewSha256: 'a'.repeat(64),
        policyRevision: '1',
        authorizationEpoch: '1',
      }),
      closeTrajectoryEvidence: async (request) => {
        closed.push(request.readId);
        return { closed: true };
      },
    },
    () => current,
  );
  const read = source.open(scope);
  current = { ...current, selection: 2 };
  resolveSnapshot!(snapshot());
  await expect(read).rejects.toMatchObject({ code: 'native_selection_changed' });
  const opening = source.openEvidence(evidence);
  source.release();
  current = { ...current, selection: 3 };
  resolveEvidence!(descriptor());
  await expect(opening).rejects.toMatchObject({ code: 'native_selection_changed' });
  expect(closed).toEqual(['lease']);
  expect(() => source.readEvidence({ ...scope, readId: 'lease', offset: '0' })).toThrow(
    'trajectory_evidence_read_missing',
  );
  await source.close();
});

test('Native shutdown waits for a late Evidence open and retains its original lease when close is unconfirmed', async () => {
  let resolve!: (value: TrajectoryEvidenceDescriptor) => void;
  let failClose = true,
    completed = false;
  const closed: string[] = [];
  const source = new NativeTrajectory(
    {
      openTrajectory: async () => snapshot(),
      readTrajectoryEvents: async (request) => ({
        ...request,
        scannedThrough: request.upperCursor,
        exhausted: true,
        events: [],
        integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
      }),
      openTrajectoryEvidence: () =>
        new Promise((done) => {
          resolve = done;
        }),
      readTrajectoryEvidenceChunk: async () => {
        throw Error('unexpected_read');
      },
      closeTrajectoryEvidence: async (request) => {
        closed.push(request.readId);
        if (failClose) throw Error('close_unknown');
        return { closed: true };
      },
    },
    () => ({ ...scope, generation: 1, selection: 1 }),
  );
  const opening = source.openEvidence(evidence);
  void opening.catch(() => {});
  const closing = source.close().then(() => {
    completed = true;
  });
  void closing.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(closed).toEqual([]);
  resolve(descriptor());
  await expect(opening).rejects.toThrow('close_unknown');
  await expect(closing).rejects.toThrow('close_unknown');
  expect(completed).toBe(false);
  await expect(source.close()).rejects.toThrow('close_unknown');
  expect(closed.every((id) => id === 'lease')).toBe(true);
  failClose = false;
  await source.close();
  const count = closed.length;
  await source.close();
  expect(closed.length).toBe(count);
});

function parentEvidenceFixture() {
  let current = { ...scope, generation: 1, selection: 1 },
    serial = 0,
    failClose = false,
    reads = 0;
  let openGate: Promise<void> | undefined,
    readGate: Promise<void> | undefined,
    closeGate: Promise<void> | undefined;
  const closed: { storeId: string; sessionId: string; readId: string }[] = [];
  const source = new NativeTrajectory(
    {
      openTrajectory: async () => snapshot(),
      readTrajectoryEvents: async (request) => ({
        ...request,
        scannedThrough: request.upperCursor,
        exhausted: true,
        events: [],
        integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
      }),
      openTrajectoryEvidence: async () => {
        const value = { ...descriptor(), readId: `parent-lease-${++serial}` };
        await openGate;
        return value;
      },
      readTrajectoryEvidenceChunk: async (request) => {
        reads++;
        await readGate;
        return {
          readId: request.readId,
          offset: request.offset,
          nextOffset: request.offset,
          data: '',
          eof: true,
          viewSha256: 'a'.repeat(64),
          policyRevision: '1',
          authorizationEpoch: '1',
        };
      },
      closeTrajectoryEvidence: async (request) => {
        closed.push({ ...request });
        await closeGate;
        if (failClose) throw Error('close_unknown');
        return { closed: true };
      },
    },
    () => current,
  );
  return {
    source,
    closed,
    reads: () => reads,
    failClose: (value: boolean) => {
      failClose = value;
    },
    holdOpen: (gate?: Promise<void>) => {
      openGate = gate;
    },
    holdRead: (gate?: Promise<void>) => {
      readGate = gate;
    },
    holdClose: (gate?: Promise<void>) => {
      closeGate = gate;
    },
    select: () => {
      current = { ...current, selection: current.selection + 1 };
    },
  };
}

test('released parent leases cannot read while close is pending or failed, even after the same scope reopens', async () => {
  const f = parentEvidenceFixture();
  const old = await f.source.openEvidence(evidence);
  let settle!: () => void;
  f.holdClose(new Promise<void>((resolve) => (settle = resolve)));
  f.failClose(true);
  f.source.release();
  const closeRequest = { ...scope, readId: old.readId };
  const closing = f.source.closeEvidence(closeRequest);
  void closing.catch(() => {});
  await expect(f.source.readEvidence({ ...closeRequest, offset: '0' })).rejects.toMatchObject({
    code: 'native_selection_changed',
  });
  const fresh = await f.source.openEvidence(evidence);
  await f.source.readEvidence({ ...scope, readId: fresh.readId, offset: '0' });
  settle();
  await expect(closing).rejects.toThrow('close_unknown');
  await expect(f.source.readEvidence({ ...closeRequest, offset: '0' })).rejects.toMatchObject({
    code: 'native_selection_changed',
  });
  expect(f.reads()).toBe(1);
  expect(f.closed).toEqual([closeRequest]);
  f.failClose(false);
  f.holdClose();
  await f.source.closeEvidence(closeRequest);
  expect(f.closed).toEqual([closeRequest, closeRequest]);
  // Returning to the same Session under a new selection never adopts a former lease.
  f.select();
  await expect(
    f.source.readEvidence({ ...scope, readId: fresh.readId, offset: '0' }),
  ).rejects.toMatchObject({ code: 'native_selection_changed' });
  await f.source.close();
});

test('explicit Evidence close revokes pending parent reads before an unconfirmed close returns', async () => {
  const f = parentEvidenceFixture();
  const lease = await f.source.openEvidence(evidence);
  let settle!: () => void;
  f.holdRead(new Promise<void>((resolve) => (settle = resolve)));
  const request = { ...scope, readId: lease.readId };
  const pending = f.source.readEvidence({ ...request, offset: '0' });
  void pending.catch(() => {});
  f.failClose(true);
  await expect(f.source.closeEvidence(request)).rejects.toThrow('close_unknown');
  settle();
  await expect(pending).rejects.toMatchObject({ code: 'native_selection_changed' });
  await expect(f.source.readEvidence({ ...request, offset: '0' })).rejects.toMatchObject({
    code: 'native_selection_changed',
  });
  expect(f.reads()).toBe(1);
  f.failClose(false);
  await f.source.close();
});

test('a late parent open cannot acquire the new release epoch or revoke a fresh same-scope lease', async () => {
  const f = parentEvidenceFixture();
  let settle!: () => void;
  f.holdOpen(new Promise<void>((resolve) => (settle = resolve)));
  const pending = f.source.openEvidence(evidence);
  void pending.catch(() => {});
  f.source.release();
  f.holdOpen();
  const fresh = await f.source.openEvidence(evidence);
  f.failClose(true);
  settle();
  await expect(pending).rejects.toThrow('close_unknown');
  await expect(
    f.source.readEvidence({ ...scope, readId: 'parent-lease-1', offset: '0' }),
  ).rejects.toMatchObject({ code: 'native_selection_changed' });
  await f.source.readEvidence({ ...scope, readId: fresh.readId, offset: '0' });
  expect(f.reads()).toBe(1);
  expect(f.closed).toEqual([{ ...scope, readId: 'parent-lease-1' }]);
  f.failClose(false);
  await f.source.close();
});

const exportRoots: string[] = [];
afterEach(() => {
  for (const root of exportRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type ExportCase =
  | 'private_artifact'
  | 'scope_denied'
  | 'plain_error'
  | 'typed_denied'
  | 'cancelled';
async function exportFixture(mode: ExportCase = 'private_artifact') {
  const root = mkdtempSync(join(tmpdir(), 'kite-native-trajectory-export-'));
  exportRoots.push(root);
  const path = join(root, 'original.kite-trajectory');
  const descriptor = snapshot();
  descriptor.upperCursor = '2';
  descriptor.historyCoverage.upperCursor = '2';
  descriptor.historyCoverage.integrity = {
    facts: 'complete',
    identityConfidence: 'verified_origin',
    reasons: [],
  };
  const privateOrigin = { storeId: 'original-facts', cursor: '1' },
    typedOrigin = { storeId: 'original-facts', cursor: '2' };
  const privateEvent: TrajectoryEvent = {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: await createTrajectoryEventId(privateOrigin),
    sequence: '1',
    origin: privateOrigin,
    workspaceId: 'workspace',
    sessionId: scope.sessionId,
    sourceEventType: 'artifact.published',
    sourceRecordRevision: '1',
    identityConfidence: 'verified_origin',
    kind: 'artifact',
    phase: 'observed',
    recordedStatus: 'published',
    occurredAt: 1,
    attributes: { artifactId: 'private-model-envelope', mediaType: 'application/json' },
    evidenceRefs: [
      {
        evidenceId: 'private-envelope',
        contentVersion: 'sealed-private-v1',
        kind: 'artifact',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  };
  const typedEvent: TrajectoryEvent = {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: await createTrajectoryEventId(typedOrigin),
    sequence: '2',
    origin: typedOrigin,
    workspaceId: 'workspace',
    sessionId: scope.sessionId,
    executionId: 'model-execution',
    sourceEventType: 'execution.succeeded',
    sourceRecordRevision: '1',
    identityConfidence: 'verified_origin',
    kind: 'model',
    phase: 'completed',
    recordedStatus: 'succeeded',
    occurredAt: 2,
    attributes: { definitionId: 'fixture-model', resultRevision: '1' },
    evidenceRefs: [
      {
        evidenceId: 'typed-model-output',
        contentVersion: 'typed-output-v1',
        kind: 'model_output',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  };
  const typedBytes = new TextEncoder().encode(
    JSON.stringify({ content: 'ORIGINAL typed Model 雪🙂', reasoning: '', toolCalls: [] }),
  );
  const digest = createHash('sha256').update(typedBytes).digest('hex');
  const opens: string[] = [],
    reads: string[] = [],
    closes: string[] = [];
  let source: NativeTrajectory;
  source = new NativeTrajectory(
    {
      async openTrajectory() {
        return descriptor;
      },
      async readTrajectoryEvents({ limit: _limit, ...request }) {
        return {
          ...request,
          events: [privateEvent, typedEvent].filter(
            (event) => BigInt(event.sequence) > BigInt(request.afterCursor),
          ),
          scannedThrough: request.upperCursor,
          exhausted: true,
          integrity: descriptor.historyCoverage.integrity,
        };
      },
      async openTrajectoryEvidence(input) {
        opens.push(input.evidenceId);
        expect(input.upperCursor).toBe('2');
        expect(input.atCursor).toBe(input.evidenceId === 'private-envelope' ? '1' : '2');
        if (input.evidenceId === 'private-envelope') {
          if (mode === 'scope_denied') throw new ClientError('trajectory_scope_denied');
          if (mode === 'plain_error') throw Error('artifact_scope_denied');
          if (mode === 'cancelled') {
            queueMicrotask(() => source.release());
            await Promise.resolve();
          } else throw new ClientError('artifact_scope_denied');
        }
        if (mode === 'typed_denied') throw new ClientError('artifact_scope_denied');
        return {
          readId: input.evidenceId === 'private-envelope' ? 'private-late-lease' : 'typed-lease',
          eventId: input.eventId,
          evidenceId: input.evidenceId,
          contentVersion: input.contentVersion,
          availability: 'available',
          mediaType: 'application/json',
          viewBytes: String(typedBytes.byteLength),
          viewSha256: digest,
          transformation: 'typed-fixture@1',
          policyRevision: '1',
          authorizationEpoch: '1',
        };
      },
      async readTrajectoryEvidenceChunk(input) {
        reads.push(input.readId);
        return {
          readId: input.readId,
          offset: input.offset,
          nextOffset: String(typedBytes.byteLength),
          data: Buffer.from(typedBytes).toString('base64'),
          eof: true,
          viewSha256: digest,
          policyRevision: '1',
          authorizationEpoch: '1',
        };
      },
      async closeTrajectoryEvidence(input) {
        closes.push(input.readId);
        return { closed: true };
      },
    },
    () => ({ ...scope, generation: 1, selection: 1 }),
  );
  return {
    root,
    path,
    descriptor,
    privateEvent,
    typedEvent,
    typedBytes,
    source,
    opens,
    reads,
    closes,
  };
}

test('Native export preserves typed Model bytes when an old available private Artifact is scope denied', async () => {
  const f = await exportFixture();
  try {
    await f.source.export(f.path, f.descriptor, true);
    expect(f.opens).toEqual(['private-envelope', 'typed-model-output']);
    expect(f.reads).toEqual(['typed-lease']);
    expect(f.closes).toEqual(['typed-lease']);
    await f.source.close();
    await f.source.close();
    expect(f.closes).toEqual(['typed-lease']);
    expect(readdirSync(f.root)).toEqual(['original.kite-trajectory']);
    const cold = await openNativeTrajectoryBundle(f.path);
    try {
      expect(cold.bundle.offline).toBe(true);
      const page = await cold.bundle.readEvents({ ...scope, afterCursor: '0', upperCursor: '2' });
      expect(page.events).toEqual([f.privateEvent, f.typedEvent]);
      expect(
        await cold.bundle.readEvidence(
          f.privateEvent.eventId,
          'private-envelope',
          'sealed-private-v1',
        ),
      ).toBeNull();
      expect(
        await cold.bundle.readEvidence(
          f.typedEvent.eventId,
          'typed-model-output',
          'typed-output-v1',
        ),
      ).toEqual(f.typedBytes);
      expect(
        cold.bundle.manifest.sections.filter((section) => section.kind === 'evidence'),
      ).toHaveLength(1);
    } finally {
      await cold.close();
      await cold.close();
    }
  } finally {
    await f.source.close();
  }
});

test.each([
  'scope_denied',
  'plain_error',
  'typed_denied',
  'cancelled',
] as const)('Native Evidence export does not swallow %s or leave a final/temporary file', async (mode) => {
  const f = await exportFixture(mode);
  try {
    const exporting = f.source.export(f.path, f.descriptor, true);
    if (mode === 'scope_denied')
      await expect(exporting).rejects.toMatchObject({ code: 'trajectory_scope_denied' });
    else if (mode === 'cancelled')
      await expect(exporting).rejects.toMatchObject({ code: 'native_selection_changed' });
    else if (mode === 'typed_denied')
      await expect(exporting).rejects.toMatchObject({ code: 'artifact_scope_denied' });
    else await expect(exporting).rejects.toThrow('artifact_scope_denied');
    expect(existsSync(f.path)).toBe(false);
    expect(readdirSync(f.root)).toEqual([]);
    expect(f.reads).toEqual([]);
    if (mode === 'typed_denied')
      expect(f.opens).toEqual(['private-envelope', 'typed-model-output']);
    if (mode === 'cancelled') expect(f.closes).toEqual(['private-late-lease']);
  } finally {
    await f.source.close();
  }
});

test('Native metadata-only export never opens Evidence, including old available private Artifact refs', async () => {
  const f = await exportFixture();
  try {
    await f.source.export(f.path, f.descriptor, false);
    expect(f.opens).toEqual([]);
    expect(f.reads).toEqual([]);
    expect(f.closes).toEqual([]);
    const cold = await openNativeTrajectoryBundle(f.path);
    try {
      expect(cold.bundle.manifest.sections.every((section) => section.kind === 'events')).toBe(
        true,
      );
      expect(
        await cold.bundle.readEvidence(
          f.typedEvent.eventId,
          'typed-model-output',
          'typed-output-v1',
        ),
      ).toBeNull();
    } finally {
      await cold.close();
    }
  } finally {
    await f.source.close();
  }
});

async function childReaderFixture() {
  let current = { ...scope, generation: 1, selection: 1 };
  const origin = { storeId: 'original-store', cursor: '20' };
  const carrier: TrajectoryEvent = {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: await createTrajectoryEventId(origin),
    sequence: '20',
    origin,
    sessionId: scope.sessionId,
    workspaceId: 'workspace',
    kind: 'job',
    executionId: 'carrier',
    executionOriginStoreId: 'original-store',
    identityConfidence: 'verified_origin',
    sourceEventType: 'execution.started',
    sourceRecordRevision: '20',
    phase: 'running',
    recordedStatus: 'running',
    occurredAt: 20,
    evidenceRefs: [],
    attributes: {
      childSessionId: 'child',
      display: {
        kind: 'task',
        targetExecutionId: 'carrier',
        targetExecutionOriginStoreId: 'original-store',
        targetSessionId: 'child',
        targetRunId: 'child-run',
      },
    },
  };
  const childOrigin = { storeId: 'restored-store', cursor: '30' };
  const child: TrajectoryEvent = {
    ...carrier,
    eventId: await createTrajectoryEventId(childOrigin),
    origin: childOrigin,
    sequence: '30',
    sourceRecordRevision: '30',
    sessionId: 'child',
    kind: 'model',
    runId: 'child-run',
    runOriginStoreId: 'original-store',
    executionId: 'child-model',
    executionOriginStoreId: 'restored-store',
    attributes: {},
    evidenceRefs: [
      {
        evidenceId: 'child-input',
        contentVersion: 'child-version',
        kind: 'model_input',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  };
  const events = [carrier, child],
    opens: TrajectoryEvidenceOpen[] = [],
    closed: string[] = [];
  let holdPage: (() => Promise<void>) | undefined;
  let holdEvidence: (() => Promise<void>) | undefined;
  let failClose = false,
    forwardedReads = 0;
  const source = new NativeTrajectory(
    {
      async openTrajectory(input) {
        return { ...snapshot(), ...input, upperCursor: '100' };
      },
      async readTrajectoryEvents(input) {
        if (input.sessionId === 'child') await holdPage?.();
        const { limit: _limit, ...request } = input;
        return {
          ...request,
          scannedThrough: request.upperCursor,
          exhausted: true,
          integrity: snapshot().historyCoverage.integrity,
          events: events.filter(
            (event) =>
              event.sessionId === input.sessionId &&
              (!input.runId || event.runId === input.runId) &&
              BigInt(event.sequence) > BigInt(input.afterCursor) &&
              BigInt(event.sequence) <= BigInt(input.upperCursor),
          ),
        };
      },
      async openTrajectoryEvidence(input) {
        opens.push(input);
        await holdEvidence?.();
        return {
          ...descriptor(),
          readId: `child-lease-${opens.length}`,
          eventId: input.eventId,
          evidenceId: input.evidenceId,
          contentVersion: input.contentVersion,
        };
      },
      async readTrajectoryEvidenceChunk(input) {
        forwardedReads++;
        return {
          readId: input.readId,
          offset: input.offset,
          nextOffset: input.offset,
          data: '',
          eof: true,
          viewSha256: 'a'.repeat(64),
          policyRevision: '1',
          authorizationEpoch: '1',
        };
      },
      async closeTrajectoryEvidence(input) {
        closed.push(input.readId);
        if (failClose) throw Error('close_unknown');
        return { closed: true };
      },
    },
    () => current,
  );
  const target = { storeId: 'store', sessionId: 'child', runId: 'child-run' };
  return {
    source,
    carrier,
    child,
    target,
    opens,
    closed,
    parentRead: (upperCursor = '40', afterCursor = '0') =>
      source.readEvents({ ...scope, afterCursor, upperCursor }),
    childRead: (upperCursor = '40') =>
      source.readEvents({ ...target, afterCursor: '0', upperCursor }),
    material: {
      storeId: 'store',
      sessionId: 'child',
      upperCursor: '40',
      atCursor: '40',
      eventId: child.eventId,
      evidenceId: 'child-input',
      contentVersion: 'child-version',
    },
    change: (patch: Partial<typeof current>) => {
      current = { ...current, ...patch };
    },
    holdPage: (fn: () => Promise<void>) => {
      holdPage = fn;
    },
    holdEvidence: (fn: () => Promise<void>) => {
      holdEvidence = fn;
    },
    failClose: (value: boolean) => {
      failClose = value;
    },
    forwardedReads: () => forwardedReads,
  };
}

test('Native child reads need an observed exact carrier and freeze its parent bound without broad Session access', async () => {
  const f = await childReaderFixture();
  await expect(f.source.open(f.target)).rejects.toMatchObject({ code: 'native_selection_changed' });
  await f.parentRead();
  const opened = await f.source.open(f.target);
  expect(opened.upperCursor).toBe('40');
  expect(opened.historyCoverage.upperCursor).toBe('40');
  for (const target of [
    { ...f.target, runId: undefined },
    { ...f.target, runId: 'foreign-run' },
    { ...f.target, sessionId: 'other-child' },
    { ...f.target, storeId: 'foreign-store' },
  ])
    await expect(f.source.open(target)).rejects.toMatchObject({ code: 'native_selection_changed' });
  await expect(f.childRead('19')).rejects.toMatchObject({ code: 'trajectory_child_scope_denied' });
  await expect(f.childRead('41')).rejects.toMatchObject({ code: 'trajectory_child_scope_denied' });
  await expect(f.source.openEvidence(f.material)).rejects.toMatchObject({
    code: 'trajectory_child_scope_denied',
  });
  expect((await f.childRead()).events.map((event) => event.eventId)).toEqual([f.child.eventId]);
  for (const material of [
    { ...f.material, evidenceId: 'foreign' },
    { ...f.material, contentVersion: 'future' },
    { ...f.material, atCursor: '29' },
    { ...f.material, upperCursor: '41' },
  ])
    await expect(f.source.openEvidence(material)).rejects.toMatchObject({
      code: 'trajectory_child_scope_denied',
    });
  expect(f.opens).toHaveLength(0);
  const material = await f.source.openEvidence(f.material);
  expect(f.opens).toEqual([f.material]);
  await f.source.readEvidence({
    storeId: 'store',
    sessionId: 'child',
    readId: material.readId,
    offset: '0',
  });
  f.source.release();
  await expect(f.source.open(f.target)).rejects.toMatchObject({ code: 'native_selection_changed' });
  await f.source.close();
  expect(f.closed).toEqual([material.readId]);
});

test('Native child proof rejects legacy or mismatched carrier fields and child Run original namespace', async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof childReaderFixture>>) => {
      f.carrier.identityConfidence = 'legacy_local';
    },
    (f: Awaited<ReturnType<typeof childReaderFixture>>) => {
      if (f.carrier.kind === 'job') f.carrier.attributes.display!.targetSessionId = 'foreign';
    },
    (f: Awaited<ReturnType<typeof childReaderFixture>>) => {
      if (f.carrier.kind === 'job') delete f.carrier.attributes.display!.targetRunId;
    },
    (f: Awaited<ReturnType<typeof childReaderFixture>>) => {
      if (f.carrier.kind === 'job')
        f.carrier.attributes.display!.targetExecutionOriginStoreId = 'foreign';
    },
  ]) {
    const f = await childReaderFixture();
    mutate(f);
    await f.parentRead();
    await expect(f.source.open(f.target)).rejects.toMatchObject({
      code: 'native_selection_changed',
    });
    await f.source.close();
  }
  const f = await childReaderFixture();
  await f.parentRead();
  f.child.runOriginStoreId = 'foreign';
  await expect(f.childRead()).rejects.toMatchObject({ code: 'trajectory_child_scope_denied' });
  await expect(f.source.openEvidence(f.material)).rejects.toMatchObject({
    code: 'trajectory_child_scope_denied',
  });
  expect(f.opens).toHaveLength(0);
  await f.source.close();
});

test('Native child leases/pages are revoked on selection and release including late material opens', async () => {
  const f = await childReaderFixture();
  await f.parentRead();
  await f.childRead();
  let resolve!: () => void;
  f.holdEvidence(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const opening = f.source.openEvidence(f.material);
  void opening.catch(() => {});
  f.change({ selection: 2 });
  resolve();
  await expect(opening).rejects.toMatchObject({ code: 'native_selection_changed' });
  expect(f.closed).toEqual(['child-lease-1']);
  await expect(f.source.open(f.target)).rejects.toMatchObject({ code: 'native_selection_changed' });
  await f.parentRead();
  expect((await f.source.open(f.target)).upperCursor).toBe('40');
  f.holdPage(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const pending = f.childRead();
  void pending.catch(() => {});
  f.source.release();
  resolve();
  await expect(pending).rejects.toMatchObject({ code: 'native_selection_changed' });
  await expect(f.source.openEvidence(f.material)).rejects.toMatchObject({
    code: 'trajectory_child_scope_denied',
  });
  await f.source.close();
});

test('regranting a released child never forwards an old lease whose close is still unconfirmed', async () => {
  const f = await childReaderFixture();
  await f.parentRead();
  await f.childRead();
  const lease = await f.source.openEvidence(f.material);
  f.failClose(true);
  f.source.release();
  await expect(
    f.source.closeEvidence({ storeId: 'store', sessionId: 'child', readId: lease.readId }),
  ).rejects.toThrow('close_unknown');
  await f.parentRead();
  await f.childRead();
  await expect(
    f.source.readEvidence({
      storeId: 'store',
      sessionId: 'child',
      readId: lease.readId,
      offset: '0',
    }),
  ).rejects.toMatchObject({ code: 'native_selection_changed' });
  expect(f.forwardedReads()).toBe(0);
  f.failClose(false);
  await f.source.close();
});

test('later bounded parent pages extend the known upper while child materials retain their earlier exact event cutoff', async () => {
  const f = await childReaderFixture();
  f.carrier.sequence = '35';
  f.carrier.origin.cursor = '35';
  f.carrier.eventId = await createTrajectoryEventId(f.carrier.origin);
  await f.parentRead();
  await f.childRead();
  const early = await f.source.openEvidence({ ...f.material, atCursor: '30' });
  expect(early.eventId).toBe(f.child.eventId);
  await f.parentRead('45', '40');
  expect((await f.source.open(f.target)).upperCursor).toBe('45');
  await expect(f.childRead('46')).rejects.toMatchObject({ code: 'trajectory_child_scope_denied' });
  await f.source.close();
});
