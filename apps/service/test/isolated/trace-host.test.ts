import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { buildTraceBundle } from '@kite-ai/trace-extension-sdk/bundle';
import type { TrajectoryEvent, TrajectoryReadRequest } from '@kite-ai/trajectory';
import { Hono } from 'hono';
import { z } from 'zod';
import { TraceConsumerStore } from '../../src/trace-extensions/consumer-store';
import { TraceCredentialBroker } from '../../src/trace-extensions/credentials';
import type { TraceEngineAssets } from '../../src/trace-extensions/engine';
import { engineDigest } from '../../src/trace-extensions/engine/assets';
import { buildTraceEngineAssets } from '../../src/trace-extensions/engine/build-assets';
import { TraceEvidenceBroker } from '../../src/trace-extensions/evidence';
import { TraceHost } from '../../src/trace-extensions/host';
import { registerTraceExtensionRoutes } from '../../src/trace-extensions/http';
import { TraceHttpBroker } from '../../src/trace-extensions/network';
import { TraceHostError } from '../../src/trace-extensions/types';
import { createTrajectorySource, type TrajectorySource } from '../../src/trajectory';
import { TrajectoryEvidenceReads } from '../../src/trajectory/evidence';

let root: string, assets: TraceEngineAssets;
const stores: TraceConsumerStore[] = [],
  hosts: TraceHost[] = [];
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kite-trace-host-'));
  assets = await buildTraceEngineAssets(join(root, 'assets'));
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const store of stores.splice(0)) store.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const scope = { storeId: 'store', sessionId: 'session' };
const integrity = {
  facts: 'complete' as const,
  identityConfidence: 'verified_origin' as const,
  reasons: [],
};
const ack = `function ack(b){return {batchId:b.batchId,leaseToken:b.leaseToken,processGeneration:b.processGeneration,subscriptionEpoch:b.partition.subscriptionEpoch,acknowledgedEventIds:b.events.map(e=>e.eventId),rejected:[]}}`;
const normal = `${ack} defineTraceExtension({async initialize(){const s=await trace.request('settings.get',null);if(s.label!=='fixture')throw Error('settings');},onEvents:b=>ack(b)});`;
function fixture(sourceCode = normal, allowHistory = true) {
  const path = join(root, `consumer-${crypto.randomUUID()}.db`),
    store = new TraceConsumerStore(path);
  stores.push(store);
  let upper = '5',
    unavailable = false;
  const queries: (TrajectoryReadRequest & { subjectId: string })[] = [];
  let pauseOpen: (() => Promise<void>) | undefined;
  const source: TrajectorySource = {
    async open(input) {
      expect(input.subjectId).toBe('trusted-subject');
      if (unavailable) throw new TraceHostError('history_unavailable');
      await pauseOpen?.();
      const { subjectId: _, ...scope } = input;
      return {
        ...scope,
        upperCursor: upper,
        formatVersion: 1,
        historyCoverage: {
          enabledAfterCursor: '0',
          upperCursor: upper,
          status: 'retained',
          integrity,
        },
      };
    },
    async readEvents(input) {
      expect(input.subjectId).toBe('trusted-subject');
      queries.push(input);
      if (unavailable) throw new TraceHostError('history_unavailable');
      const { subjectId: _, limit: __, ...request } = input;
      const events: TrajectoryEvent[] = [];
      for (
        let cursor = BigInt(input.afterCursor) + 1n;
        cursor <= BigInt(input.upperCursor);
        cursor++
      )
        events.push({
          schema: 'kite.trajectory',
          schemaVersion: 1,
          eventId: `te_${cursor.toString(16).padStart(64, '0')}`,
          sequence: String(cursor),
          origin: { storeId: 'store', cursor: String(cursor) },
          sessionId: 'session',
          workspaceId: 'workspace',
          kind: 'command',
          phase: 'observed',
          recordedStatus: 'accepted',
          sourceRecordRevision: '1',
          sourceEventType: 'command.accepted',
          occurredAt: null,
          attributes: { commandId: `command-${cursor}` },
          identityConfidence: 'verified_origin',
          evidenceRefs: [],
        });
      return { ...request, events, scannedThrough: input.upperCursor, exhausted: true, integrity };
    },
  };
  const host = new TraceHost({
    store,
    source,
    subjectId: 'trusted-subject',
    assets,
    engineBudgets: { callbackMs: 100 },
  });
  hosts.push(host);
  const install = (code = sourceCode) =>
    host.install(
      {
        apiVersion: 1,
        name: 'fixture',
        history: true,
        eventKinds: ['command'],
        evidenceKinds: [],
        origins: [],
        settings: { label: 'string' },
      },
      { apiVersion: 1, source: code, sha256: engineDigest(code) },
    );
  const id = install();
  host.configure(id, { label: 'fixture' });
  const authorize = (installationId = id) =>
    host.authorize(installationId, {
      scopes: [scope],
      eventKinds: ['command'],
      evidenceKinds: [],
      origins: [],
      metadata: [],
      originalIdentity: false,
      allowHistory,
    });
  return {
    path,
    store,
    host,
    id,
    source,
    queries,
    install,
    authorize,
    setUpper(value: string) {
      upper = value;
    },
    setUnavailable() {
      unavailable = true;
    },
    pauseNextOpen(pause: () => Promise<void>) {
      pauseOpen = pause;
    },
  };
}

test('enable starts live at U and explicit inclusive history has its own fixed upper and ACK', async () => {
  const f = fixture();
  await f.authorize();
  await f.host.enable(f.id);
  expect(f.store.listPartitions(f.id)[0]!.fromCursor).toBe('5');
  f.setUpper('7');
  await f.host.pump(f.id);
  expect(f.queries.map((query) => [query.afterCursor, query.upperCursor])).toEqual([['5', '7']]);
  const live = f.store.listPartitions(f.id)[0]!;
  expect(live.contiguousAcknowledgedPosition).toBe('7');
  const history = await f.host.startHistoryExport(f.id, {
    scope,
    fromSequence: '2',
    toSequence: '4',
    contentMode: 'metadata',
  });
  f.setUpper('9');
  await f.host.pump(f.id);
  expect(f.queries.some((query) => query.afterCursor === '1' && query.upperCursor === '4')).toBe(
    true,
  );
  expect(f.store.inspectPartition(history).upperCursor).toBe('4');
  expect(f.store.inspectPartition(history).contiguousAcknowledgedPosition).toBe('4');
  expect(f.store.inspectPartition(history).integrity.reasons).toContain('incomplete_prefix');
  expect(f.store.inspectPartition(live.id).contiguousAcknowledgedPosition).toBe('9');
});

test('history permission and source scope are rejected before any implicit backfill', async () => {
  const f = fixture(normal, false);
  await f.authorize();
  await f.host.enable(f.id);
  await expect(f.host.startHistoryExport(f.id, { scope, contentMode: 'metadata' })).rejects.toThrow(
    'trace_history_permission_denied',
  );
  await expect(
    f.host.startHistoryExport(f.id, {
      scope: { ...scope, sessionId: 'foreign' },
      contentMode: 'metadata',
    }),
  ).rejects.toThrow('trace_history_permission_denied');
  expect(f.store.listPartitions(f.id)).toHaveLength(1);
  expect(f.queries).toHaveLength(0);
});

test('revocation during a guest history broker call blocks the late job and ACK', async () => {
  const code = `${ack} defineTraceExtension({async onEvents(b){await trace.request('history.request',{storeRef:b.events[0].scope.storeRef,sessionRef:b.events[0].scope.sessionRef,contentMode:'metadata'});return ack(b)}});`;
  const f = fixture(code);
  await f.authorize();
  await f.host.enable(f.id);
  f.setUpper('6');
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let opens = 0;
  f.pauseNextOpen(async () => {
    if (++opens === 2) {
      entered();
      await blocked;
    }
  });
  const delivery = f.host.pump(f.id);
  void delivery.catch(() => {});
  await arrived;
  await f.host.revoke(f.id);
  release();
  await expect(delivery).rejects.toBeInstanceOf(Error);
  await Bun.sleep(5);
  expect(f.store.listPartitions(f.id)).toHaveLength(1);
  expect(f.store.listPartitions(f.id)[0]!.status).toBe('revoked');
  expect(f.store.listPartitions(f.id)[0]!.contiguousAcknowledgedPosition).toBe('5');
});

test('one failing runner does not block another installation and preserves unacknowledged work', async () => {
  const f = fixture('defineTraceExtension({onEvents(){while(true){}}});');
  const other = f.install(normal);
  f.host.configure(other, { label: 'fixture' });
  await f.authorize();
  await f.authorize(other);
  await f.host.enable(f.id);
  await f.host.enable(other);
  f.setUpper('6');
  const bad = f.host.pump(f.id);
  void bad.catch(() => {});
  await f.host.pump(other);
  expect(f.store.listPartitions(other)[0]!.contiguousAcknowledgedPosition).toBe('6');
  await expect(bad).rejects.toBeInstanceOf(Error);
  expect(f.store.listPartitions(f.id)[0]!.pending).toBe(1);
  expect(f.store.listPartitions(f.id)[0]!.contiguousAcknowledgedPosition).toBe('5');
});

test('host reopens original live upper and does not consume older history implicitly', async () => {
  const f = fixture();
  await f.authorize();
  await f.host.enable(f.id);
  await f.host.close();
  hosts.splice(hosts.indexOf(f.host), 1);
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const store = new TraceConsumerStore(f.path);
  stores.push(store);
  const host = new TraceHost({ store, source: f.source, subjectId: 'trusted-subject', assets });
  hosts.push(host);
  f.setUpper('8');
  await host.pump(f.id);
  expect(f.queries.map((query) => [query.afterCursor, query.upperCursor])).toEqual([['5', '8']]);
  expect(store.listPartitions(f.id)[0]!.fromCursor).toBe('5');
  expect(store.listPartitions(f.id)[0]!.contiguousAcknowledgedPosition).toBe('8');
});

test('HTTP broker pins explicit origins, injects own credentials, rejects foreign handles and stops on revocation', async () => {
  const received: { url: string; authorization: string | null }[] = [];
  let delay = false,
    arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const collector = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      received.push({
        url: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
      });
      if (delay) {
        arrive();
        await Bun.sleep(100);
      }
      if (new URL(request.url).pathname === '/redirect')
        return new Response('', {
          status: 302,
          headers: { location: 'http://127.0.0.1:9/foreign' },
        });
      return new Response('accepted');
    },
  });
  const origin = `http://127.0.0.1:${collector.port}`;
  const store = new TraceConsumerStore(join(root, `network-${crypto.randomUUID()}.db`));
  stores.push(store);
  const source = 'defineTraceExtension({onEvents(){}})';
  const id = store.install(
    {
      apiVersion: 1,
      name: 'network',
      history: false,
      eventKinds: ['command'],
      evidenceKinds: [],
      origins: [origin],
      settings: {},
    },
    { apiVersion: 1, source, sha256: engineDigest(source) },
  );
  const vault = createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    credentials = new TraceCredentialBroker(store, vault);
  const binding = await credentials.bind(id, origin, 'synthetic-trace-token');
  const grant = store.authorize(id, {
    scopes: [scope],
    eventKinds: ['command'],
    evidenceKinds: [],
    metadata: [],
    origins: [origin],
    originalIdentity: false,
    allowHistory: false,
    credentialHandles: [binding.handle],
  });
  store.enable(id);
  const generation = store.nextGeneration(id);
  const context = {
    installationId: id,
    revision: grant.revision,
    epoch: grant.epoch,
    generation,
    signal: new AbortController().signal,
  };
  const broker = new TraceHttpBroker(store, credentials);
  try {
    const result = await broker.request(
      {
        url: `${origin}/v1/traces`,
        method: 'POST',
        bodyBase64: Buffer.from('metadata').toString('base64'),
        credentialHandle: binding.handle,
      },
      context,
    );
    expect(result).toEqual({
      status: 'complete',
      httpStatus: 200,
      bodyBase64: Buffer.from('accepted').toString('base64'),
    });
    expect(received).toEqual([
      { url: '/v1/traces', authorization: 'Bearer synthetic-trace-token' },
    ]);
    expect(
      await broker.request({ url: 'http://127.0.0.1:9/foreign', method: 'POST' }, context),
    ).toEqual({ status: 'unavailable', code: 'origin_denied' });
    expect(
      await broker.request(
        { url: `${origin}/redirect`, method: 'GET', credentialHandle: binding.handle },
        context,
      ),
    ).toEqual({ status: 'unavailable', code: 'redirect_denied' });
    expect(received).toHaveLength(2);
    const foreign = { ...context, installationId: 'foreign' };
    await expect(
      credentials.headers({ ...foreign, origin, handle: binding.handle }),
    ).rejects.toThrow('trace_credential_unavailable');
    delay = true;
    const abort = new AbortController(),
      inFlight = broker.request(
        { url: `${origin}/slow`, method: 'POST', credentialHandle: binding.handle },
        { ...context, signal: abort.signal },
      );
    await arrived;
    store.revoke(id);
    abort.abort();
    expect(await inFlight).toEqual({ status: 'unconfirmed', code: 'request_interrupted' });
    expect(await broker.request({ url: `${origin}/never`, method: 'GET' }, context)).toEqual({
      status: 'unavailable',
      code: 'permission_revoked',
    });
    expect(received).toHaveLength(3);
  } finally {
    collector.stop(true);
  }
});

test('Trace credential namespace is separate from MCP and replacement invalidates old purpose handles', async () => {
  const store = new TraceConsumerStore(join(root, `credentials-${crypto.randomUUID()}.db`));
  stores.push(store);
  const source = 'defineTraceExtension({})',
    origin = 'https://collector.example';
  const id = store.install(
    {
      apiVersion: 1,
      name: 'credentials',
      history: false,
      eventKinds: ['command'],
      evidenceKinds: [],
      origins: [origin],
      settings: {},
    },
    { apiVersion: 1, source, sha256: engineDigest(source) },
  );
  const backend = createTemporaryCredentialBackend(),
    vault = createCredentialVault({ backend }),
    credentials = new TraceCredentialBroker(store, vault);
  const first = await credentials.bind(id, origin, 'first');
  const second = await credentials.bind(id, origin, 'second');
  expect(store.credential(id, first.handle).active).toBe(false);
  const binding = store.credential(id, second.handle);
  expect(
    await vault.readOwned({ namespace: 'mcp.oauth', ownerDigest: binding.ownerDigest }),
  ).toBeNull();
  expect(await vault.readOwned({ namespace: 'trace.http', ownerDigest: binding.ownerDigest })).toBe(
    'second',
  );
  await credentials.revoke(id, second.handle);
  expect(store.credential(id, second.handle).active).toBe(false);
  expect(
    await vault.readOwned({ namespace: 'trace.http', ownerDigest: binding.ownerDigest }),
  ).toBeNull();
});

function evidenceFixture() {
  const store = new TraceConsumerStore(join(root, `evidence-${crypto.randomUUID()}.db`));
  stores.push(store);
  const code = 'defineTraceExtension({})';
  const id = store.install(
    {
      apiVersion: 1,
      name: 'evidence',
      history: true,
      eventKinds: ['artifact'],
      evidenceKinds: ['artifact'],
      origins: [],
      settings: {},
    },
    { apiVersion: 1, source: code, sha256: engineDigest(code) },
  );
  const grant = store.authorize(id, {
    scopes: [scope],
    eventKinds: ['artifact'],
    evidenceKinds: ['artifact'],
    metadata: [],
    origins: [],
    originalIdentity: false,
    allowHistory: true,
    evidenceContent: 'full',
  });
  store.enable(id);
  const generation = store.nextGeneration(id),
    partition = store.createPartition(id, scope, ['artifact'], '1', {
      exportId: 'export',
      contentMode: 'authorized_evidence',
    });
  const event: TrajectoryEvent = {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${'1'.repeat(64)}`,
    sequence: '1',
    origin: { storeId: 'store', cursor: '1' },
    sessionId: 'session',
    workspaceId: 'workspace',
    kind: 'artifact',
    phase: 'observed',
    recordedStatus: null,
    sourceRecordRevision: '1',
    sourceEventType: 'artifact.registered',
    occurredAt: null,
    attributes: { artifactId: 'original-artifact' },
    identityConfidence: 'verified_origin',
    evidenceRefs: [
      {
        evidenceId: 'original-evidence',
        contentVersion: 'original-version',
        kind: 'artifact',
        availability: 'available',
        mediaType: 'text/plain',
      },
    ],
  };
  const { limit: _, ...query } = store.requestFor(partition);
  store.enqueuePage(partition, {
    ...query,
    events: [event],
    scannedThrough: '1',
    exhausted: true,
    integrity,
  });
  const batch = store.lease(partition, generation)!;
  const reference = batch.events[0]!.evidenceRefs[0]!;
  return { store, id, grant, generation, partition, event, batch, reference };
}

test('Evidence broker resolves only current sent refs, fixes the transformed digest and blocks revoked chunks', async () => {
  const { store, id, grant, generation, event, batch, reference } = evidenceFixture();
  let checks = 0,
    blockAtRead = false,
    arrived!: () => void,
    release!: () => void;
  const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    }),
    paused = new Promise<void>((resolve) => {
      release = resolve;
    });
  const original = new TrajectoryEvidenceReads(
    {
      async readTrajectoryBinding(input) {
        expect(input.subjectId).toBe('trusted-subject');
        expect(input.evidenceId).toBe('original-evidence');
        expect(input.atCursor).toBe('1');
        checks++;
        if (blockAtRead) {
          arrived();
          await paused;
        }
        return {
          event,
          binding: {
            evidenceId: 'original-evidence',
            contentVersion: 'original-version',
            kind: 'artifact',
            value: null,
          },
        };
      },
    },
    async () => ({
      content: new TextEncoder().encode('你好🙂 historical body'),
      mediaType: 'text/plain',
      availability: 'available',
      transformation: 'fixture-public@1',
    }),
  );
  const broker = new TraceEvidenceBroker(store, original, 'trusted-subject'),
    abort = new AbortController();
  const context = {
    installationId: id,
    revision: grant.revision,
    epoch: grant.epoch,
    generation,
    signal: abort.signal,
  };
  const request = {
    batchId: batch.batchId,
    eventId: event.eventId,
    evidenceId: reference.evidenceId,
    contentVersion: reference.contentVersion,
  };
  await expect(broker.open({ ...request, evidenceId: 'foreign' }, context)).rejects.toThrow(
    'trace_evidence_denied',
  );
  const descriptor = await broker.open(request, context);
  expect(JSON.stringify(descriptor)).not.toContain('original-evidence');
  expect(descriptor.policyRevision).toBe(grant.revision);
  const first = await broker.read({ readId: descriptor.readId, offset: '0', limit: 4 }, context);
  expect(first.viewSha256).toBe(descriptor.viewSha256);
  expect(first.nextOffset).toBe('4');
  expect(checks).toBe(4);
  blockAtRead = true;
  const pending = broker.read({ readId: descriptor.readId, offset: '4', limit: 4 }, context);
  void pending.catch(() => {});
  await reached;
  store.revoke(id);
  abort.abort();
  release();
  await expect(pending).rejects.toBeInstanceOf(Error);
  await expect(broker.read({ readId: descriptor.readId, offset: '4' }, context)).rejects.toThrow(
    'trace_evidence_read_missing',
  );
  original.dispose();
});

for (const phase of ['open', 'read'] as const)
  for (const action of ['cancel', 'pause'] as const)
    test(`Evidence ${phase} cannot publish after its partition is ${action}d while source material is pending`, async () => {
      const { store, id, grant, generation, partition, event, batch, reference } =
        evidenceFixture();
      let block = false,
        arrived!: () => void,
        release!: () => void,
        sourceReadId: string | undefined;
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const source = new TrajectoryEvidenceReads(
        {
          async readTrajectoryBinding() {
            if (block) {
              arrived();
              await held;
            }
            return {
              event,
              binding: {
                evidenceId: 'original-evidence',
                contentVersion: 'original-version',
                kind: 'artifact',
                value: null,
              },
            };
          },
        },
        async () => ({
          content: new TextEncoder().encode('saved body'),
          mediaType: 'text/plain',
          availability: 'available',
          transformation: 'fixture@1',
        }),
      );
      const open = source.open.bind(source);
      source.open = async (...args) => {
        const descriptor = await open(...args);
        sourceReadId = descriptor.readId;
        return descriptor;
      };
      const broker = new TraceEvidenceBroker(store, source, 'trusted-subject');
      const context = {
        installationId: id,
        revision: grant.revision,
        epoch: grant.epoch,
        generation,
        signal: new AbortController().signal,
      };
      const request = {
        batchId: batch.batchId,
        eventId: event.eventId,
        evidenceId: reference.evidenceId,
        contentVersion: reference.contentVersion,
      };
      try {
        const descriptor = phase === 'read' ? await broker.open(request, context) : undefined;
        block = true;
        const pending =
          phase === 'open'
            ? broker.open(request, context)
            : broker.read({ readId: descriptor!.readId, offset: '0' }, context);
        void pending.catch(() => {});
        await reached;
        if (action === 'cancel') store.cancelExport(partition);
        else store.pauseExport(partition);
        // Installation authorization remains valid: the exact partition is what changed.
        expect(store.grant(id).active).toBe(true);
        expect(context.signal.aborted).toBe(false);
        release();
        await expect(pending).rejects.toThrow('trace_evidence_read_invalid');
        expect(sourceReadId).toBeDefined();
        await expect(
          source.read(
            {
              storeId: scope.storeId,
              sessionId: scope.sessionId,
              readId: sourceReadId!,
              offset: '0',
            },
            'trusted-subject',
          ),
        ).rejects.toThrow('trajectory_evidence_read_missing');
        if (descriptor)
          await expect(
            broker.read({ readId: descriptor.readId, offset: '0' }, context),
          ).rejects.toThrow('trace_evidence_read_missing');
      } finally {
        release();
        broker.revoke(id);
        source.dispose();
      }
    });

test('history cancellation withdraws only the owning installation Evidence before awaiting consumer cancellation', async () => {
  const f = fixture();
  let arrived!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = new TraceHost({
    store: f.store,
    source: f.source,
    subjectId: 'trusted-subject',
    assets,
    trustedConsumerFactory: async ({ generation }) => ({
      generation,
      async initialize() {},
      async onEvents() {
        throw Error('no delivery expected');
      },
      async retire() {
        return { confirmed: true };
      },
      async cancelTask() {
        arrived();
        await held;
      },
    }),
  });
  hosts.push(host);
  const code = 'defineTraceExtension({})';
  const id = f.store.installTrusted(
    'opentelemetry',
    {
      apiVersion: 1,
      name: 'cancel-owner',
      history: true,
      eventKinds: ['command'],
      evidenceKinds: [],
      origins: [],
      settings: {},
    },
    { apiVersion: 1, source: code, sha256: engineDigest(code) },
  );
  await host.authorize(id, {
    scopes: [scope],
    eventKinds: ['command'],
    evidenceKinds: [],
    metadata: [],
    origins: [],
    originalIdentity: false,
    allowHistory: true,
  });
  await host.enable(id);
  const partition = await host.startHistoryExport(id, {
    scope,
    fromSequence: '1',
    toSequence: '2',
    contentMode: 'metadata',
  });
  const revoke = spyOn(TraceEvidenceBroker.prototype, 'revoke');
  try {
    await expect(host.cancelHistoryExport(f.id, partition)).rejects.toThrow('trace_scope_denied');
    expect(revoke).not.toHaveBeenCalled();
    const pending = host.cancelHistoryExport(id, partition);
    await reached;
    expect(f.store.inspectPartition(partition).status).toBe('cancelled');
    expect(revoke.mock.calls).toEqual([[id]]);
    release();
    await pending;
  } finally {
    release();
    revoke.mockRestore();
  }
});

test('public SDK template builds, installs, consumes live/history and resumes the original lanes', async () => {
  const f = fixture();
  const entry = fileURLToPath(
    new URL('../../../../packages/trace-extension-sdk/examples/metadata.ts', import.meta.url),
  );
  const bundle = await buildTraceBundle(entry);
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../../packages/trace-extension-sdk/examples/metadata.manifest.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  );
  const id = f.host.install(manifest, bundle);
  await f.authorize(id);
  await f.host.enable(id);
  f.setUpper('7');
  await f.host.pump(id);
  const live = f.store.listPartitions(id)[0]!;
  expect(live.fromCursor).toBe('5');
  expect(live.contiguousAcknowledgedPosition).toBe('7');
  const history = await f.host.startHistoryExport(id, {
    scope,
    fromSequence: '1',
    toSequence: '2',
    contentMode: 'metadata',
  });
  await f.host.pump(id);
  expect(f.store.inspectPartition(history).contiguousAcknowledgedPosition).toBe('2');
  await f.host.pauseHistoryExport(id, history);
  await f.host.disable(id);
  f.setUpper('9');
  await f.host.enable(id);
  expect(f.store.inspectPartition(history).status).toBe('paused');
  f.host.resumeHistoryExport(id, history);
  await f.host.pump(id);
  expect(f.store.inspectPartition(live.id).contiguousAcknowledgedPosition).toBe('9');
  expect(f.store.inspectPartition(history).upperCursor).toBe('2');
  expect(f.store.inspectPartition(history).deliveryComplete).toBe(true);
  await f.host.uninstall(id);
  expect(() => f.host.inspectInstallation(id)).toThrow('trace_installation_unavailable');
});
test('a built SDK consumer reads authorized version-bound Evidence through its actual engine broker', async () => {
  const f = fixture(),
    originals = new Map<string, TrajectoryEvent>();
  const read = f.source.readEvents;
  f.source.readEvents = async (input, options) => {
    const page = await read(input, options);
    for (const event of page.events) {
      event.evidenceRefs = [
        {
          evidenceId: 'private-evidence',
          contentVersion: 'private-version',
          kind: 'artifact',
          availability: 'available',
          mediaType: 'text/plain',
        },
      ];
      originals.set(event.eventId, event);
    }
    return page;
  };
  let materialReads = 0;
  f.source.evidence = new TrajectoryEvidenceReads(
    {
      async readTrajectoryBinding(input) {
        const event = originals.get(input.eventId);
        if (
          !event ||
          input.evidenceId !== 'private-evidence' ||
          input.contentVersion !== 'private-version' ||
          input.atCursor !== event.sequence
        )
          throw new TraceHostError('fixture_binding_denied');
        return {
          event,
          binding: {
            evidenceId: 'private-evidence',
            contentVersion: 'private-version',
            kind: 'artifact',
            value: null,
          },
        };
      },
    },
    async () => {
      materialReads++;
      return {
        content: new TextEncoder().encode('immutable historical 你好🙂'),
        mediaType: 'text/plain',
        availability: 'available',
        transformation: 'fixture-public@1',
      };
    },
  );
  const host = new TraceHost({
    store: f.store,
    source: f.source,
    subjectId: 'trusted-subject',
    assets,
  });
  hosts.push(host);
  const entry = join(root, `sdk-evidence-${crypto.randomUUID()}.ts`),
    sdk = fileURLToPath(import.meta.resolve('@kite-ai/trace-extension-sdk'));
  writeFileSync(
    entry,
    `import {defineTraceExtension,acknowledge} from ${JSON.stringify(sdk)}; defineTraceExtension({async onEvents(batch,context){for(const event of batch.events){const ref=event.evidenceRefs[0];if(!ref||ref.evidenceId==='private-evidence')throw Error('unsafe_ref');const d=await context.evidence.open({eventId:event.eventId,evidenceId:ref.evidenceId,contentVersion:ref.contentVersion});if(d.policyRevision!==batch.grantRevision||d.authorizationEpoch!==batch.partition.subscriptionEpoch)throw Error('epoch');const c=await context.evidence.read({readId:d.readId,offset:'0',limit:65536});if(!c.eof||c.viewSha256!==d.viewSha256||c.nextOffset!==d.viewBytes||!c.data)throw Error('view');await context.evidence.close({readId:d.readId});}return acknowledge(batch.events);}});`,
  );
  const bundle = await buildTraceBundle(entry),
    id = host.install(
      {
        apiVersion: 1,
        name: 'sdk-evidence',
        history: true,
        eventKinds: ['command'],
        evidenceKinds: ['artifact'],
        origins: [],
        settings: {},
      },
      bundle,
    );
  await host.authorize(id, {
    scopes: [scope],
    eventKinds: ['command'],
    evidenceKinds: ['artifact'],
    origins: [],
    metadata: [],
    originalIdentity: false,
    allowHistory: true,
    evidenceContent: 'full',
  });
  try {
    await host.enable(id);
    f.setUpper('6');
    await host.pump(id);
    expect(f.store.listPartitions(id)[0]!.contiguousAcknowledgedPosition).toBe('6');
    const history = await host.startHistoryExport(id, {
      scope,
      fromSequence: '1',
      toSequence: '1',
      contentMode: 'authorized_evidence',
    });
    await host.pump(id);
    expect(f.store.inspectPartition(history).deliveryComplete).toBe(true);
    expect(materialReads).toBe(2);
    await host.disable(id);
    await host.enable(id);
    await host.pump(id);
    expect(materialReads).toBe(2);
  } finally {
    await host.disable(id);
    f.source.evidence.dispose();
  }
});

test('only trusted installation provenance selects the privileged consumer factory', async () => {
  const f = fixture();
  let factories = 0,
    pumps = 0;
  const host = new TraceHost({
    store: f.store,
    source: f.source,
    subjectId: 'trusted-subject',
    assets,
    trustedConsumerFactory: async (input) => {
      factories++;
      expect(input.kind).toBe('opentelemetry');
      return {
        generation: input.generation,
        async initialize() {},
        async onEvents(batch) {
          return {
            batchId: batch.batchId,
            leaseToken: batch.leaseToken,
            processGeneration: batch.processGeneration,
            subscriptionEpoch: batch.partition.subscriptionEpoch,
            acknowledgedEventIds: batch.events.map((event) => event.eventId),
            rejected: [],
          };
        },
        async pump() {
          pumps++;
        },
        async retire() {
          return { confirmed: true };
        },
      };
    },
  });
  hosts.push(host);
  const untrusted = host.install(
    {
      apiVersion: 1,
      name: 'opentelemetry',
      history: true,
      eventKinds: ['command'],
      evidenceKinds: [],
      origins: [],
      settings: { label: 'string' },
    },
    { apiVersion: 1, source: normal, sha256: engineDigest(normal) },
  );
  host.configure(untrusted, { label: 'fixture' });
  await f.authorize(untrusted);
  await host.enable(untrusted);
  f.setUpper('6');
  await host.pump(untrusted);
  expect(factories).toBe(0);
  const source = 'trusted adapter identity marker, not guest JavaScript';
  const id = host.installTrusted(
    'opentelemetry',
    {
      apiVersion: 1,
      name: 'fixture',
      history: true,
      eventKinds: ['command'],
      evidenceKinds: [],
      origins: [],
      settings: {},
    },
    { apiVersion: 1, source, sha256: engineDigest(source) },
  );
  await f.authorize(id);
  await host.enable(id);
  f.setUpper('7');
  await host.pump(id);
  expect(factories).toBe(1);
  expect(pumps).toBe(1);
  expect(host.inspectInstallation(id).kind).toBe('opentelemetry');
  expect(f.store.listPartitions(id)[0]!.contiguousAcknowledgedPosition).toBe('7');
  await expect(
    host.update(id, {}, { apiVersion: 1, source, sha256: engineDigest(source) }),
  ).rejects.toThrow('trace_trusted_update_required');
});

test('disabled trusted delivery inspection never starts a consumer or changes accepted versus remote state', async () => {
  const f = fixture();
  let factories = 0,
    reads = 0;
  const inspection = {
    grant: { revision: '1', epoch: '1', active: true },
    openSpans: 0,
    acceptedEvents: 2,
    unmappedEvents: {
      notSpan: 0,
      identityUnavailable: 0,
      timingUnavailable: 0,
      incompletePrefix: 0,
    },
    outgoingTotal: 1,
    outgoingStates: [{ status: 'retry_wait' as const, count: 1 }],
    outgoing: [
      {
        key: 'opaque-key',
        taskId: 'live:1',
        status: 'retry_wait' as const,
        code: 'send_not_authorized' as const,
        attempts: 0,
        rejectedCount: null,
        possibleDuplicate: 0 as const,
      },
    ],
  };
  const host = new TraceHost({
    store: f.store,
    source: f.source,
    subjectId: 'trusted-subject',
    assets,
    trustedConsumerFactory: async () => {
      factories++;
      throw Error('must_not_start');
    },
    trustedConsumerInspect: async () => {
      reads++;
      return reads === 1 ? null : inspection;
    },
  });
  hosts.push(host);
  const id = host.installOtelIntegration({ endpoint: 'http://localhost:4318/v1/traces' });
  expect(await host.deliveryStatus(id)).toEqual({
    kind: 'opentelemetry',
    status: 'not_started',
    inspection: null,
  });
  expect(await host.deliveryStatus(id)).toEqual({
    kind: 'opentelemetry',
    status: 'available',
    inspection,
  });
  expect(factories).toBe(0);
  expect(host.inspectInstallation(id).status).toBe('configured');
  expect(await f.host.deliveryStatus(id)).toHaveProperty('status', 'unavailable');
  expect(await host.deliveryStatus(f.id)).toEqual({
    kind: 'third_party',
    status: 'not_applicable',
  });
});

test('management HTTP uses root authentication, closed requests and finite DTOs without raw bundle source', async () => {
  const f = fixture(),
    app = new Hono();
  let bodyCalls = 0;
  class Failure extends Error {
    readonly code: string;
    readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 503;
    constructor(code: string, status: 400 | 403 | 404 | 409 | 413 | 429 | 503) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  app.use('*', async (context, next) => {
    if (context.req.header('authorization') !== 'Bearer fixture')
      return context.json({ code: 'unauthorized' }, 401);
    await next();
    return undefined;
  });
  app.onError((error, context) =>
    context.json(
      { code: error instanceof Failure ? error.code : 'failure' },
      error instanceof Failure ? error.status : 503,
    ),
  );
  registerTraceExtensionRoutes(app, {
    host: f.host,
    async readBody(request, schema, maxBytes) {
      bodyCalls++;
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > maxBytes) throw new Failure('request_too_large', 413);
      return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    },
    fail(code, status): never {
      throw new Failure(code, status);
    },
  });
  expect((await app.request('/v1/trace/extensions')).status).toBe(401);
  expect(bodyCalls).toBe(0);
  const request = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const detail = await request(`/v1/trace/extensions/${f.id}`);
  expect(detail.status).toBe(200);
  const value = await detail.json();
  expect(value).toHaveProperty('kind', 'third_party');
  expect(value).not.toHaveProperty('bundle');
  expect(
    (await request(`/v1/trace/extensions/${f.id}/enable`, { subjectId: 'forged' })).status,
  ).toBe(400);
  expect(
    (
      await request(`/v1/trace/extensions/${f.id}/configure`, {
        settings: { label: 'http-configured' },
      })
    ).status,
  ).toBe(200);
  const official = await request('/v1/trace/integrations/opentelemetry/install', {
    endpoint: 'http://localhost:4318/v1/traces',
  });
  expect(official.status).toBe(201);
  const officialId = (await official.json()).installationId;
  const officialState = f.host.inspectInstallation(officialId);
  expect(officialState).toMatchObject({
    kind: 'opentelemetry',
    status: 'configured',
    grant: null,
    settings: { endpoint: 'http://localhost:4318/v1/traces', sampleRate: 1 },
    manifest: { evidenceKinds: [], origins: ['http://localhost:4318'] },
  });
  expect(
    (
      await request('/v1/trace/integrations/opentelemetry/install', {
        endpoint: 'http://localhost:4318/v1/traces',
        credentialHandle: crypto.randomUUID(),
      })
    ).status,
  ).toBe(400);
  expect(() =>
    f.host.configure(officialId, { endpoint: 'http://localhost:4319/v1/traces', sampleRate: 1 }),
  ).toThrow('trace_trusted_configuration_requires_new_installation');
  const delivery = await request(`/v1/trace/extensions/${officialId}/delivery`);
  expect(delivery.status).toBe(200);
  expect(await delivery.json()).toHaveProperty('status', 'unavailable');
  const source = 'defineTraceExtension({onEvents(){}})',
    manifest = {
      apiVersion: 1,
      name: 'http-fixture',
      history: false,
      eventKinds: ['command'],
      evidenceKinds: [],
      origins: [],
      settings: {},
    };
  const input = { manifest, bundle: { apiVersion: 1, source, sha256: engineDigest(source) } };
  expect((await request('/v1/trace/extensions/validate', input)).status).toBe(200);
  expect(
    (await request('/v1/trace/extensions/install', { ...input, kind: 'opentelemetry' })).status,
  ).toBe(400);
  const installed = await request('/v1/trace/extensions/install', input);
  expect(installed.status).toBe(201);
  expect(
    z.strictObject({ installationId: z.string().uuid() }).safeParse(await installed.json()).success,
  ).toBe(true);
  expect(
    (
      await request('/v1/trace/extensions/install', {
        ...input,
        bundle: { ...input.bundle, sha256: '0'.repeat(64) },
      })
    ).status,
  ).toBe(400);
});

test.each([
  'gc_marker',
  'store_replacement',
] as const)('Host delivers durable safe pending after actual SQLite source %s', async (loss) => {
  const dataRoot = join(root, `authority-${crypto.randomUUID()}`);
  const authority = await openSqliteStore({ dataRoot, profile: 'trace' });
  const storeId = (await authority.getMetadata()).storeId;
  await authority.createWorkspace({
    expectedStoreId: storeId,
    id: 'workspace',
    rootUri: 'file:///fixture',
    name: 'fixture',
  });
  await authority.createSession({
    expectedStoreId: storeId,
    sessionId: 'session',
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'fixture',
    subjectId: 'trusted-subject',
  });
  const source = createTrajectorySource(authority),
    consumer = new TraceConsumerStore(join(root, `authority-consumer-${crypto.randomUUID()}.db`));
  stores.push(consumer);
  const host = new TraceHost({ store: consumer, source, subjectId: 'trusted-subject', assets });
  hosts.push(host);
  const sourceCode = `${ack} defineTraceExtension({onEvents:b=>ack(b)});`;
  const id = host.install(
    {
      apiVersion: 1,
      name: 'sqlite-source',
      history: true,
      eventKinds: ['command'],
      evidenceKinds: [],
      origins: [],
      settings: {},
    },
    { apiVersion: 1, source: sourceCode, sha256: engineDigest(sourceCode) },
  );
  await host.authorize(id, {
    scopes: [{ storeId, sessionId: 'session' }],
    eventKinds: ['command'],
    evidenceKinds: [],
    origins: [],
    metadata: [],
    originalIdentity: false,
    allowHistory: true,
  });
  const db = new Database(join(dataRoot, 'trace', 'core.db'));
  try {
    await host.enable(id);
    for (const commandId of ['pending-one', 'pending-two'])
      await authority.acceptCommand({
        expectedStoreId: storeId,
        sessionId: 'session',
        commandId,
        subjectId: 'trusted-subject',
        request: { kind: 'run.start', content: 'PRIVATE_INPUT' },
      });
    const partition = consumer.listPartitions(id)[0]!;
    const upper = (
      await source.open({ storeId, sessionId: 'session', subjectId: 'trusted-subject' }, {})
    ).upperCursor;
    consumer.extendLiveWindow(partition.id, upper);
    consumer.enqueuePage(
      partition.id,
      await source.readEvents(
        { ...consumer.requestFor(partition.id), subjectId: 'trusted-subject' },
        {},
      ),
    );
    expect(consumer.inspectPartition(partition.id).pending).toBeGreaterThan(0);
    if (loss === 'gc_marker')
      db.run('UPDATE workspace SET metadata_json=? WHERE id=?', [
        JSON.stringify({ sessionHistoryCollection: { version: 1, roots: { session: 1 } } }),
        'workspace',
      ]);
    else db.run('UPDATE storage_meta SET store_id=?', ['restored-store-identity']);
    const before = await authority.getMetadata();
    await host.pump(id);
    const result = consumer.inspectPartition(partition.id);
    expect(result.status).toBe('unavailable');
    expect(result.integrity.facts).toBe('partial');
    expect(result.integrity.reasons).toContain('source_unavailable');
    expect(result.pending).toBe(0);
    expect(result.contiguousAcknowledgedPosition).toBe(upper);
    expect(result.deliveryComplete).toBe(false);
    expect((await authority.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
    const closed = host.close();
    expect(host.close()).toBe(closed);
    await closed;
    await expect(host.pump(id)).rejects.toThrow('trace_host_closed');
  } finally {
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    db.close();
    await authority.close();
  }
});
