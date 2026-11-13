import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from '#kite-test';
import { TraceConsumerStore } from '../../src/trace-extensions/consumer-store';
import { engineDigest } from '../../src/trace-extensions/engine/assets';
import type { TraceGrant } from '../../src/trace-extensions/types';

const roots: string[] = [],
  stores: TraceConsumerStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scope = { storeId: 'store', sessionId: 'session' };
const manifest = {
  apiVersion: 1,
  name: 'fixture',
  history: true,
  eventKinds: ['command'],
  evidenceKinds: [],
  origins: ['https://collector.example'],
  settings: { label: 'string', debug: 'boolean' },
};
const source = 'defineTraceExtension({onEvents(){}})',
  bundle = { apiVersion: 1 as const, source, sha256: engineDigest(source) };
const grant: TraceGrant = {
  scopes: [scope],
  eventKinds: ['command'],
  evidenceKinds: [],
  origins: [],
  metadata: [],
  originalIdentity: false,
  allowHistory: true,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-trace-grants-'));
  roots.push(root);
  const store = new TraceConsumerStore(join(root, 'consumer.db'));
  stores.push(store);
  const id = store.install(manifest, bundle);
  return { store, id };
}

test('install is disabled and data/history/evidence/origin permissions require declared separate grants', () => {
  const { store, id } = fixture();
  expect(store.inspectInstallation(id).status).toBe('installed');
  expect(() => store.enable(id)).toThrow('trace_grant_required');
  expect(() => store.authorize(id, { ...grant, origins: ['https://foreign.example'] })).toThrow(
    'trace_manifest_permission_denied',
  );
  expect(() => store.authorize(id, { ...grant, evidenceKinds: ['model_input'] })).toThrow(
    'trace_manifest_permission_denied',
  );
  expect(() => store.authorize(id, { ...grant, eventKinds: ['model'] })).toThrow(
    'trace_manifest_permission_denied',
  );
  store.authorize(id, { ...grant, allowHistory: false });
  store.enable(id);
  expect(() =>
    store.createPartition(id, scope, ['command'], '20', { exportId: 'history' }),
  ).toThrow('trace_scope_denied');
  expect(() =>
    store.createPartition(id, { ...scope, sessionId: 'foreign' }, ['command'], '20'),
  ).toThrow('trace_scope_denied');
  expect(() =>
    store.createPartition(id, { ...scope, executionId: 'foreign' }, ['command'], '20'),
  ).not.toThrow();
});

test('settings are manifest-closed finite nonsecret values and cannot insert credentials or free state', () => {
  const { store, id } = fixture();
  store.configure(id, { label: 'destination one', debug: false });
  expect(store.inspectInstallation(id).settings).toEqual({
    label: 'destination one',
    debug: false,
  });
  for (const settings of [
    { token: 'secret' },
    { label: true },
    { label: 'x'.repeat(2049) },
    { debug: {} },
  ])
    expect(() => Reflect.apply(store.configure, store, [id, settings])).toThrow(
      'trace_settings_invalid',
    );
});

test('revocation wins against an in-flight ACK and reauthorization creates a fresh epoch', () => {
  const { store, id } = fixture();
  const oldGrant = store.authorize(id, grant);
  store.enable(id);
  const partition = store.createPartition(id, scope, ['command'], '5', { exportId: 'history' });
  const request = store.requestFor(partition),
    { limit: _, ...pageScope } = request;
  const event = {
    schema: 'kite.trajectory' as const,
    schemaVersion: 1 as const,
    eventId: `te_${'1'.repeat(64)}`,
    sequence: '3',
    origin: { storeId: 'store', cursor: '3' },
    sessionId: 'session',
    workspaceId: 'workspace',
    kind: 'command' as const,
    phase: 'observed' as const,
    sourceEventType: 'command.accepted',
    sourceRecordRevision: '1',
    recordedStatus: 'accepted',
    occurredAt: null,
    attributes: { commandId: 'command' },
    evidenceRefs: [],
    identityConfidence: 'verified_origin' as const,
  };
  store.enqueuePage(partition, {
    ...pageScope,
    events: [event],
    scannedThrough: '5',
    exhausted: true,
    integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
  });
  const generation = store.nextGeneration(id),
    batch = store.lease(partition, generation)!;
  store.revoke(id);
  expect(() =>
    store.acknowledge(partition, {
      batchId: batch.batchId,
      leaseToken: batch.leaseToken,
      processGeneration: generation,
      subscriptionEpoch: batch.partition.subscriptionEpoch,
      acknowledgedEventIds: [event.eventId],
      rejected: [],
    }),
  ).toThrow('trace_permission_revoked');
  expect(store.inspectPartition(partition).contiguousAcknowledgedPosition).toBe('2');
  expect(store.inspectPartition(partition).status).toBe('revoked');
  const fresh = store.authorize(id, grant);
  store.enable(id);
  expect(BigInt(fresh.epoch)).toBeGreaterThan(BigInt(oldGrant.epoch));
  expect(() =>
    store.assertAuthorization(id, oldGrant.revision, oldGrant.epoch, generation),
  ).toThrow('trace_permission_revoked');
  const next = store.createPartition(id, scope, ['command'], '10');
  expect(next).not.toBe(partition);
  expect(store.inspectPartition(next).fromCursor).toBe('10');
});

test('temporary disable preserves original lanes and update/uninstall never inherit old grants', () => {
  const { store, id } = fixture();
  const authorized = store.authorize(id, grant);
  store.enable(id);
  const partition = store.createPartition(id, scope, ['command'], '10');
  store.disable(id);
  expect(store.inspectPartition(partition).status).toBe('active');
  expect(store.grant(id).epoch).toBe(authorized.epoch);
  store.enable(id);
  expect(store.inspectPartition(partition).status).toBe('active');
  expect(store.createPartition(id, scope, ['command'], '999')).toBe(partition);
  expect(store.inspectPartition(partition).upperCursor).toBe('10');
  store.update(id, manifest, bundle);
  expect(store.inspectInstallation(id).status).toBe('installed');
  expect(store.grant(id).active).toBe(false);
  expect(() => store.enable(id)).toThrow('trace_permission_revoked');
  store.uninstall(id);
  expect(() => store.inspectInstallation(id)).toThrow('trace_installation_unavailable');
  const replacement = store.install(manifest, bundle);
  expect(replacement).not.toBe(id);
  expect(() => store.grant(replacement)).toThrow('trace_grant_required');
});

test('history cancellation records terminated delivery and leaves the live lane untouched', () => {
  const { store, id } = fixture();
  store.authorize(id, grant);
  store.enable(id);
  const live = store.createPartition(id, scope, ['command'], '10');
  const history = store.createPartition(id, scope, ['command'], '20', {
    exportId: 'export',
    fromCursor: '5',
  });
  store.cancelExport(history);
  expect(store.inspectPartition(history).status).toBe('cancelled');
  expect(store.inspectPartition(history).deliveryComplete).toBe(false);
  expect(store.inspectPartition(live).status).toBe('active');
  expect(store.inspectPartition(live).upperCursor).toBe('10');
});
