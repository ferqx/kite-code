import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTrajectoryBundle,
  openTrajectoryBundle,
  type TrajectoryBundleDirectory,
} from '@kite-ai/client';
import {
  createTrajectoryEventId,
  decodeTrajectoryEvent,
  projectTrajectory,
  type TrajectoryEvent,
  type TrajectoryIntegrity,
  type TrajectorySnapshot,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { TraceConsumerStore } from '../../src/trace-extensions/consumer-store';
import { engineDigest } from '../../src/trace-extensions/engine/assets';
import { projectTraceEvent } from '../../src/trace-extensions/projection';
import type { TraceGrant } from '../../src/trace-extensions/types';

const integrity: TrajectoryIntegrity = {
  facts: 'complete',
  identityConfidence: 'verified_origin',
  reasons: [],
};
const scope = { storeId: 'read-store', sessionId: 'session' };
const ref = (kind: 'tool_input' | 'tool_result' | 'model_output', name: string) => ({
  kind,
  evidenceId: name,
  contentVersion: `${name}-v1`,
  availability: 'available',
  mediaType: 'application/json',
});
async function event(sequence: string, patch: Record<string, unknown>): Promise<TrajectoryEvent> {
  const origin = { storeId: 'original', cursor: sequence };
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: await createTrajectoryEventId(origin),
    sequence,
    origin,
    sessionId: 'session',
    workspaceId: 'workspace',
    runId: 'run',
    runOriginStoreId: 'original',
    executionId: 'tool',
    executionOriginStoreId: 'original',
    sourceEventType: 'execution.finished',
    sourceRecordRevision: sequence,
    kind: 'tool',
    phase: 'completed',
    recordedStatus: 'succeeded',
    occurredAt: 1000,
    identityConfidence: 'verified_origin',
    attributes: { definitionId: 'shell.execute', definitionVersion: '1' },
    evidenceRefs: [],
    ...patch,
  });
}
const grant: TraceGrant = {
  scopes: [scope],
  eventKinds: ['tool', 'model', 'context'],
  metadata: [],
  evidenceKinds: ['tool_result'],
  origins: [],
  originalIdentity: false,
  allowHistory: true,
};
const source = 'defineTraceExtension({onEvents(){}})';
const bundle = { apiVersion: 1 as const, source, sha256: engineDigest(source) };
function manifest(kinds: string[]) {
  return {
    apiVersion: 1,
    name: 'workbench-compat',
    history: true,
    eventKinds: ['tool', 'model', 'context'],
    evidenceKinds: kinds,
    origins: [],
    settings: {},
  };
}

test('old Trace manifests and grants never acquire tool input when the evidence enum gains a member', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-workbench-grant-'));
  const store = new TraceConsumerStore(join(root, 'consumer.db'));
  try {
    const original = await event('9007199254740993', {
      evidenceRefs: [ref('tool_input', 'private-input'), ref('tool_result', 'old-result')],
    });
    const oldInstallation = store.install(manifest(['tool_result']), bundle);
    expect(() =>
      store.authorize(oldInstallation, { ...grant, evidenceKinds: ['tool_input'] }),
    ).toThrow('trace_manifest_permission_denied');
    const id = store.install(manifest(['tool_result', 'tool_input']), bundle);
    const authorized = store.authorize(id, grant);
    store.enable(id);
    const partition = store.createPartition(id, scope, ['tool'], original.sequence, {
      exportId: 'original',
      fromCursor: '0',
      contentMode: 'authorized_evidence',
    });
    const { limit: _limit, ...request } = store.requestFor(partition);
    store.enqueuePage(partition, {
      ...request,
      events: [original],
      scannedThrough: original.sequence,
      exhausted: true,
      integrity,
    });
    const generation = store.nextGeneration(id),
      delivered = store.lease(partition, generation)!;
    expect(delivered.events[0]!.evidenceRefs.map((reference) => reference.kind)).toEqual([
      'tool_result',
    ]);
    expect(store.grant(id).grant.evidenceKinds).toEqual(['tool_result']);
    expect(() =>
      store.evidenceForBatch(
        id,
        authorized.revision,
        authorized.epoch,
        generation,
        delivered.batchId,
        original.eventId,
        'private-input',
        'private-input-v1',
      ),
    ).toThrow('trace_evidence_denied');
    const next = store.authorize(id, { ...grant, evidenceKinds: ['tool_input'] });
    expect(BigInt(next.epoch)).toBeGreaterThan(BigInt(authorized.epoch));
    expect(() =>
      store.assertAuthorization(id, authorized.revision, authorized.epoch, generation),
    ).toThrow('trace_permission_revoked');
    const allowed = projectTraceEvent(original, next.grant, 'fixture-key', scope.storeId);
    expect(allowed.evidenceRefs.map((reference) => reference.kind)).toEqual(['tool_input']);
    expect(JSON.stringify(allowed)).not.toContain('private-input');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('new first-party compression metadata stays outside the Trace metadata allowlist while usage retains its separate grant', async () => {
  const original = await event('1', {
    kind: 'model',
    attributes: {
      compressionId: 'private-compression-id',
      compressionTrigger: 'automatic',
      compression: {
        adopted: true,
        accounting: {
          basis: 'local-context-estimate-v1',
          beforeTokens: 100000,
          afterTokens: 25000,
        },
        thresholdTokens: 80000,
      },
      usage: { inputTokens: '9007199254740993', outputTokens: '200' },
    },
    evidenceRefs: [ref('tool_input', 'input')],
  });
  const denied = projectTraceEvent(original, grant, 'key', scope.storeId);
  expect(JSON.stringify(denied)).not.toContain('private-compression-id');
  expect(JSON.stringify(denied)).not.toContain('beforeTokens');
  expect(JSON.stringify(denied)).not.toContain('9007199254740993');
  expect(denied.occurredAt).toBeNull();
  expect(denied.evidenceRefs).toEqual([]);
  const allowed = projectTraceEvent(
    original,
    { ...grant, metadata: ['usage', 'timing'] },
    'key',
    scope.storeId,
  );
  expect(allowed.kind).toBe('model');
  if (allowed.kind !== 'model') throw Error('fixture');
  expect(allowed.attributes.usage).toEqual({
    inputTokens: '9007199254740993',
    outputTokens: '200',
  });
  expect(allowed.occurredAt).toBe(1000);
  expect(JSON.stringify(allowed)).not.toContain('beforeTokens');
});

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
async function packaged(events: TrajectoryEvent[], materials: Map<string, Uint8Array> = new Map()) {
  const upper = events.at(-1)!.sequence;
  const snapshot: TrajectorySnapshot = {
    ...scope,
    upperCursor: upper,
    formatVersion: 1,
    historyCoverage: { enabledAfterCursor: '0', upperCursor: upper, status: 'retained', integrity },
  };
  const files = new Map<string, Uint8Array>();
  for await (const frame of createTrajectoryBundle({
    snapshot,
    async readEvents({ limit: _limit, ...request }) {
      return {
        ...request,
        scannedThrough: upper,
        exhausted: true,
        events: events.filter((item) => BigInt(item.sequence) > BigInt(request.afterCursor)),
        integrity,
      };
    },
    async readEvidence(eventId, reference) {
      return materials.get(`${eventId}:${reference.evidenceId}`) ?? null;
    },
  }))
    files.set(frame.path, frame.bytes);
  return { files, snapshot };
}

test('V1 bundles round-trip original tool input JSON and new compression attrs without losing old V1 facts or ref versions', async () => {
  const input = await event('9007199254740993', {
    phase: 'planned',
    recordedStatus: 'planned',
    evidenceRefs: [ref('tool_input', 'original-input')],
  });
  const output = await event('9007199254740994', {
    evidenceRefs: [ref('tool_result', 'original-result')],
  });
  const model = await event('9007199254740995', {
    kind: 'model',
    executionId: 'compress',
    attributes: {
      compressionId: 'c',
      compressionTrigger: 'automatic',
      compression: { adopted: false },
      usage: { inputTokens: '100', outputTokens: '20' },
    },
  });
  const adopted = await event('9007199254740996', {
    kind: 'context',
    executionId: 'compress',
    sourceEventType: 'context.compressed',
    attributes: {
      compressionId: 'c',
      compressionTrigger: 'automatic',
      action: 'compressed',
      compression: {
        adopted: true,
        accounting: { basis: 'local-context-estimate-v1', beforeTokens: 1000, afterTokens: 300 },
      },
    },
  });
  const old = await event('9007199254740997', { executionId: 'old-tool', attributes: {} });
  const bytes = new TextEncoder().encode(
    JSON.stringify({ command: 'echo 雪🙂', background: false, nested: { empty: {}, value: null } }),
  );
  const resultBytes = new TextEncoder().encode(
    JSON.stringify({ outcome: 'succeeded', content: 'Original output' }),
  );
  const original = [input, output, model, adopted, old];
  const { files, snapshot } = await packaged(
    original,
    new Map([
      [`${input.eventId}:original-input`, bytes],
      [`${output.eventId}:original-result`, resultBytes],
    ]),
  );
  const local = await openTrajectoryBundle(directory(files), { maxCacheBytes: 0 });
  const page = await local.readEvents({
    ...scope,
    afterCursor: '0',
    upperCursor: snapshot.upperCursor,
  });
  expect(local.offline).toBe(true);
  expect(local.manifest.version).toBe(1);
  expect(page.events).toEqual(original);
  expect(await local.readEvidence(input.eventId, 'original-input', 'original-input-v1')).toEqual(
    bytes,
  );
  expect(await local.readEvidence(input.eventId, 'original-input', 'future-version')).toBeNull();
  expect(await local.readEvidence(old.eventId, 'original-input', 'original-input-v1')).toBeNull();
  const indexed = projectTrajectory(page.events, {
    atCursor: snapshot.upperCursor,
    completePrefix: true,
  });
  expect(indexed.steps.find((step) => step.stepId === 'execution:tool')!.sourceEventIds).toEqual([
    input.eventId,
    output.eventId,
  ]);
  expect(indexed.eventIndex).toEqual(original);
  expect(
    indexed.steps.find((step) => step.kind === 'context')!.compression?.accounting?.afterTokens,
  ).toBe(300);
  expect(local.cacheBytes).toBe(0);
});

test('future canonical events expose only safe envelopes and malformed future material members fail closed', async () => {
  const original = await event('1', {});
  const future = {
    ...original,
    schemaVersion: 2,
    attributes: { privateFuturePayload: 'DO_NOT_EXPOSE' },
    evidenceRefs: [{ kind: 'future_tool_input', body: 'DO_NOT_EXPOSE' }],
  };
  const decoded = decodeTrajectoryEvent(future);
  expect(decoded.status).toBe('unsupported_version');
  expect(JSON.stringify(decoded)).not.toContain('DO_NOT_EXPOSE');
  expect(JSON.stringify(decoded)).not.toContain('evidenceRefs');
  expect(decodeTrajectoryEvent({ ...original, evidenceRefs: future.evidenceRefs }).status).toBe(
    'invalid',
  );
  const { files, snapshot } = await packaged([original]);
  const eventPath = 'events/00000000.jsonl',
    changed = new TextEncoder().encode(`${JSON.stringify(future)}\n`);
  files.set(eventPath, changed);
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!));
  const section = manifest.sections.find((value: { path: string }) => value.path === eventPath);
  section.bytes = String(changed.byteLength);
  section.sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', changed)).toString('hex');
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  const local = await openTrajectoryBundle(directory(files));
  await expect(
    local.readEvents({ ...scope, afterCursor: '0', upperCursor: snapshot.upperCursor }),
  ).rejects.toThrow();
  expect(await local.readEvidence(original.eventId, 'guessed', 'future')).toBeNull();
});
