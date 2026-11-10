import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceEventBatch, TraceEventView } from '@kite-ai/trajectory';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  buildOtelAdapterAssets,
  createOtelIntegration,
} from '../../src/trace-integrations/opentelemetry';
import { exportOtelSpans } from '../../src/trace-integrations/opentelemetry/exporter';
import {
  eventSpanIdentity,
  materializeSpan,
  semanticSources,
} from '../../src/trace-integrations/opentelemetry/mapping';
import {
  inspectOtelStore,
  OtelAdapterStore,
} from '../../src/trace-integrations/opentelemetry/store';

const stamp = { revision: '1', epoch: '1', active: true };
function event(
  sequence: string,
  phase: 'planned' | 'completed' | 'outcome_unknown',
  executionRef = 'execution',
): TraceEventView {
  return {
    schema: 'kite.trace-event-view',
    schemaVersion: 1,
    eventId: `te_${sequence.padStart(64, '0')}`,
    sequence,
    origin: { storeRef: 'origin', cursor: sequence },
    scope: {
      storeRef: 'read-store',
      sessionRef: 'session',
      workspaceRef: 'workspace',
      runRef: 'run',
      runOriginStoreRef: 'origin',
      executionOriginStoreRef: 'origin',
      executionRef,
    },
    sourceEventType: `model.${phase}`,
    sourceRecordRevision: sequence,
    identityConfidence: 'verified_origin',
    kind: 'model',
    phase,
    recordedStatus: phase === 'completed' ? 'succeeded' : phase,
    occurredAt: 1000 + Number(sequence),
    attributes: { usage: { inputTokens: '2', outputTokens: '3' } },
    evidenceRefs: [],
    attempt: 1,
  };
}
function batch(
  events: TraceEventView[],
  from = '0',
): Extract<TraceEventBatch, { source: 'history' }> {
  const last = events.at(-1)?.sequence ?? from;
  return {
    source: 'history',
    batchId: `batch-${last}`,
    leaseToken: `lease-${last}`,
    processGeneration: '1',
    partition: {
      installationId: 'fixture',
      storeRef: 'read-store',
      sessionRef: 'session',
      subscriptionEpoch: '1',
      lane: { kind: 'history', exportId: 'export' },
    },
    grantRevision: '1',
    filterRevision: '1',
    upperCursor: last,
    fromCursor: from,
    scannedThrough: last,
    events,
    integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
  };
}
function directory() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-otel-test-')));
}

test('mapping keeps original entity identity across restore, preserves real parent/independent Link and explicit sampling', () => {
  const root = directory();
  const store = new OtelAdapterStore({
    path: join(root, 'adapter.db'),
    installationId: 'fixture',
    endpoint: 'http://127.0.0.1:4318/v1/traces',
  });
  try {
    const original = event('1', 'planned');
    const restored = {
      ...original,
      origin: { ...original.origin, storeRef: 'new-fact-store' },
      scope: { ...original.scope, storeRef: 'new-read-store' },
    };
    expect(eventSpanIdentity(restored, 'fixed-key')).toEqual(
      eventSpanIdentity(original, 'fixed-key'),
    );
    const missing = {
      ...original,
      scope: { ...original.scope, executionOriginStoreRef: undefined },
    };
    expect(eventSpanIdentity(missing, 'fixed-key')).toBeNull();
    expect(semanticSources).toEqual({
      genAi: 'e6658f14c9d9ea0760825f029cb82e7673f48fab',
      openInference: '6be7118f789c9cd3c71b3375810fe9250050fe31',
    });
    const runScope = {
      storeRef: 'read-store',
      sessionRef: 'session',
      workspaceRef: 'workspace',
      runRef: 'run',
      runOriginStoreRef: 'origin',
    };
    const runStart: TraceEventView = {
      ...event('1', 'planned'),
      kind: 'run',
      scope: runScope,
      attributes: {},
    };
    const runEnd: TraceEventView = {
      ...event('6', 'completed'),
      kind: 'run',
      scope: runScope,
      attributes: {},
    };
    const jobScope = {
      storeRef: 'read-store',
      sessionRef: 'session',
      workspaceRef: 'workspace',
      executionRef: 'background',
      executionOriginStoreRef: 'origin',
      parentExecutionRef: 'execution',
      parentExecutionOriginStoreRef: 'origin',
    };
    const jobStart: TraceEventView = {
      ...event('4', 'planned'),
      kind: 'job',
      scope: jobScope,
      attributes: {},
    };
    const jobEnd: TraceEventView = {
      ...event('5', 'completed'),
      kind: 'job',
      scope: jobScope,
      attributes: {},
    };
    store.setGrant(stamp);
    store.consume(
      batch([runStart, event('2', 'planned'), event('3', 'completed'), jobStart, jobEnd, runEnd]),
    );
    const model = store.next()!,
      job = store.next()!,
      run = store.next()!;
    const modelSpan = materializeSpan(model.envelope),
      jobSpan = materializeSpan(job.envelope),
      runSpan = materializeSpan(run.envelope);
    expect(modelSpan.parentSpanContext!.spanId).toBe(runSpan.spanContext().spanId);
    expect(modelSpan.spanContext().traceId).toBe(runSpan.spanContext().traceId);
    expect(jobSpan.parentSpanContext).toBeUndefined();
    expect(jobSpan.links[0]!.context.spanId).toBe(modelSpan.spanContext().spanId);
    expect(jobSpan.spanContext().traceId).not.toBe(modelSpan.spanContext().traceId);
    expect(jobSpan.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(modelSpan.attributes['gen_ai.operation.name']).toBe('chat');
    expect(runSpan.attributes['openinference.span.kind']).toBe('AGENT');
    const retryStore = new OtelAdapterStore({
      path: join(root, 'retry.db'),
      installationId: 'fixture',
      endpoint: 'http://127.0.0.1:4318/v1/traces',
    });
    try {
      retryStore.setGrant(stamp);
      const retry = (sequence: string, phase: 'planned' | 'completed'): TraceEventView => {
        const source = event(sequence, phase, 'retry');
        return {
          ...source,
          kind: 'model',
          scope: { ...source.scope, executionOriginStoreRef: 'new-origin' },
          attributes: {
            previousExecutionRef: 'execution',
            previousExecutionOriginStoreRef: 'origin',
          },
        };
      };
      retryStore.consume(
        batch([
          event('1', 'planned'),
          event('2', 'completed'),
          retry('3', 'planned'),
          retry('4', 'completed'),
        ]),
      );
      const previous = retryStore.next()!,
        next = retryStore.next()!;
      expect(next.envelope.links[0]).toEqual({
        identity: previous.envelope.identity,
        traceId: previous.envelope.traceId,
        spanId: previous.envelope.spanId,
      });
    } finally {
      retryStore.close();
    }
    const sampled = new OtelAdapterStore({
      path: join(root, 'sampled.db'),
      installationId: 'fixture',
      endpoint: 'http://127.0.0.1:4318/v1/traces',
      sampleRate: 0,
    });
    try {
      sampled.setGrant(stamp);
      sampled.consume(batch([event('1', 'planned'), event('2', 'completed')]));
      expect(sampled.inspect().outgoing[0]!.status).toBe('sampled_out');
      expect(sampled.next()).toBeNull();
    } finally {
      sampled.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('private state commits before ACK, deduplicates ACK-window loss, resumes open spans and retains unknown outgoing work', () => {
  const root = directory(),
    options = {
      path: join(root, 'adapter.db'),
      installationId: 'fixture',
      endpoint: 'http://127.0.0.1:4318/v1/traces',
    };
  let store = new OtelAdapterStore(options);
  try {
    store.setGrant(stamp);
    expect(store.consume(batch([event('1', 'planned')])).acknowledgedEventIds).toHaveLength(1);
    expect(store.inspect().openSpans).toBe(1);
    store.close();
    store = new OtelAdapterStore(options);
    store.setGrant(stamp);
    expect(store.inspect().openSpans).toBe(1);
    const terminal = batch([event('2', 'completed')], '1');
    const ack = store.consume(terminal); // Simulate process loss after private commit, before Host saved this ACK.
    store.close();
    store = new OtelAdapterStore(options);
    store.setGrant(stamp);
    expect(store.consume(terminal)).toEqual(ack);
    expect(store.inspect().outgoing).toHaveLength(1);
    expect(store.inspect().openSpans).toBe(0);
    const outgoing = store.next()!;
    expect(outgoing.envelope.attributes['openinference.span.kind']).toBe('LLM');
    expect(outgoing.envelope.attributes['gen_ai.usage.input_tokens']).toBe(2);
    store.admitSend(outgoing);
    expect(inspectOtelStore(options)!.outgoing[0]).toMatchObject({
      status: 'sending',
      attempts: 1,
      possibleDuplicate: 0,
    });
    expect(store.inspect().outgoing[0]!.status).toBe('sending');
    expect(() => inspectOtelStore({ ...options, installationId: 'other' })).toThrow(
      'otel_store_incompatible',
    );
    const absent = join(root, 'never-created.db');
    expect(inspectOtelStore({ ...options, path: absent })).toBeNull();
    expect(existsSync(absent)).toBe(false);
    const spanId = outgoing.envelope.spanId;
    store.close();
    store = new OtelAdapterStore(options);
    store.setGrant(stamp);
    const recovered = store.next()!;
    expect(recovered.envelope.spanId).toBe(spanId);
    expect(recovered.possibleDuplicate).toBe(true);
    store.admitSend(recovered);
    store.finish(recovered, { kind: 'full', attempts: 1, possibleDuplicate: false });
    expect(store.inspect().outgoing[0]).toMatchObject({
      status: 'accepted',
      attempts: 2,
      possibleDuplicate: 1,
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('open unknown work is not ended, partial/permanent are not auto-retried, cancellation/revocation stop pending and capacity rolls back', () => {
  const root = directory();
  const store = new OtelAdapterStore({
    path: join(root, 'adapter.db'),
    installationId: 'fixture',
    endpoint: 'http://127.0.0.1:4318/v1/traces',
  });
  const full = batch([event('1', 'planned'), event('2', 'completed')]);
  try {
    store.setGrant(stamp);
    const observed = { ...event('1', 'outcome_unknown', 'missing-start'), sequence: '1' };
    store.consume(batch([observed]));
    expect(store.inspect().openSpans).toBe(0);
    expect(store.inspect().unmappedEvents.incompletePrefix).toBe(1);
    const observedTask = batch([event('1', 'planned'), event('2', 'outcome_unknown')]);
    observedTask.partition.lane.exportId = 'complete-prefix';
    store.consume(observedTask);
    expect(store.inspect().openSpans).toBe(1);
    expect(store.next()).toBeNull();
    const completedTask = batch([event('3', 'completed')], '2');
    completedTask.partition.lane.exportId = 'complete-prefix';
    store.consume(completedTask);
    const item = store.next()!;
    store.admitSend(item);
    store.finish(item, {
      kind: 'partial',
      code: 'partial_success',
      rejectedCount: 1,
      attempts: 1,
      possibleDuplicate: false,
    });
    expect(store.inspect().outgoing[0]!.status).toBe('partial_unknown');
    expect(store.next()).toBeNull();
    const another = batch([event('4', 'planned', 'other'), event('5', 'completed', 'other')], '3');
    store.consume(another);
    store.cancelTask('export');
    expect(store.inspect().outgoing.some((item) => item.status === 'stopped')).toBe(true);
    expect(store.next()).toBeNull();
    store.setGrant({ revision: '2', epoch: '2', active: true });
    expect(store.inspect().openSpans).toBe(0);
    expect(() => store.consume(full)).toThrow('otel_permission_revoked');
    const limited = new OtelAdapterStore({
      path: join(root, 'limited.db'),
      installationId: 'fixture',
      endpoint: 'http://127.0.0.1:4318/v1/traces',
      maxBytes: 100,
    });
    try {
      limited.setGrant(stamp);
      expect(() => limited.consume(full)).toThrow('otel_capacity_exceeded');
      expect(limited.inspect().acceptedEvents).toBe(0);
      expect(limited.inspect().outgoing).toEqual([]);
    } finally {
      limited.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unadmitted pause stays retryable, while cancel wins late confirmation and actual-send retry budget is bounded', () => {
  const root = directory();
  const store = new OtelAdapterStore({
    path: join(root, 'adapter.db'),
    installationId: 'fixture',
    endpoint: 'http://127.0.0.1:4318/v1/traces',
  });
  try {
    store.setGrant(stamp);
    store.consume(batch([event('1', 'planned'), event('2', 'completed')]));
    const pending = store.next(0)!;
    store.finish(
      pending,
      { kind: 'unconfirmed', code: 'send_not_authorized', attempts: 0, possibleDuplicate: false },
      0,
    );
    expect(store.inspect().outgoing[0]).toMatchObject({
      status: 'retry_wait',
      attempts: 0,
      possibleDuplicate: 0,
    });
    const resumed = store.next(1000)!;
    store.admitSend(resumed);
    store.cancelTask('export');
    store.finish(resumed, { kind: 'full', attempts: 1, possibleDuplicate: false });
    expect(store.inspect().outgoing[0]).toMatchObject({
      status: 'unconfirmed',
      code: 'task_cancelled',
    });
    expect(store.next()).toBeNull();
    const nextTask = batch([event('3', 'planned', 'next'), event('4', 'completed', 'next')], '2');
    nextTask.partition.lane.exportId = 'another-export';
    store.consume(nextTask);
    const retry = store.next()!;
    for (let attempt = 0; attempt < 8; attempt++) store.admitSend(retry);
    expect(() => store.admitSend(retry)).toThrow('otel_retry_exhausted');
    store.finish(retry, {
      kind: 'transient',
      code: 'http_503',
      attempts: 8,
      possibleDuplicate: true,
    });
    expect(store.inspect().outgoing[0]).toMatchObject({
      status: 'unconfirmed',
      code: 'retry_exhausted',
      attempts: 8,
    });
    expect(store.next()).toBeNull();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted independent adapter process accepts durably, reopens without source and checks grant at the actual exporter send', async () => {
  const root = directory();
  let deliveries = 0,
    checks = 0,
    active = true;
  const receiver = createServer((request, response) => {
    deliveries++;
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/v1/traces`;
  const assets = await buildOtelAdapterAssets(join(root, 'assets'));
  const options = {
    installationId: 'fixture',
    path: join(root, 'adapter.db'),
    endpoint,
    grant: stamp,
    assets,
    async authorizeSend(request: { endpoint: string }, signal: AbortSignal) {
      checks++;
      signal.throwIfAborted();
      if (!active || request.endpoint !== endpoint) throw Error('revoked');
      return { headers: {}, target: { address: '127.0.0.1', family: 4 as const } };
    },
  };
  let adapter = await createOtelIntegration(options);
  try {
    expect(adapter.identity.pid).not.toBe(process.pid);
    expect(
      (await adapter.accept(batch([event('1', 'planned')]))).acknowledgedEventIds,
    ).toHaveLength(1);
    await adapter.close();
    adapter = await createOtelIntegration(options);
    expect((await adapter.inspect()).openSpans).toBe(1);
    await adapter.accept(batch([event('2', 'completed')], '1'));
    await adapter.close();
    adapter = await createOtelIntegration(options);
    // There is no source port in the adapter: already accepted self-contained spool survives deletion.
    expect((await adapter.pump())!.kind).toBe('full');
    expect(deliveries).toBe(1);
    expect(checks).toBe(1);
    await adapter.accept(
      batch([event('3', 'planned', 'second'), event('4', 'completed', 'second')], '2'),
    );
    active = false;
    expect((await adapter.pump())!.kind).toBe('unconfirmed');
    expect(deliveries).toBe(1);
    await adapter.setGrant({ revision: '2', epoch: '2', active: false });
  } finally {
    await adapter.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('real SIGKILL at private-commit and remote-accept windows recovers dedup/spool and reports duplicate risk', async () => {
  const root = directory();
  let deliveries = 0;
  const receiver = createServer((request, response) => {
    deliveries++;
    request.resume();
    request.on('end', () => {
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/v1/traces`;
  const moduleUrl = new URL('../../src/trace-integrations/opentelemetry/store.ts', import.meta.url)
    .href;
  const exporterUrl = new URL(
    '../../src/trace-integrations/opentelemetry/exporter.ts',
    import.meta.url,
  ).href;
  const mappingUrl = new URL(
    '../../src/trace-integrations/opentelemetry/mapping.ts',
    import.meta.url,
  ).href;
  const delivery = batch([event('1', 'planned'), event('2', 'completed')]);
  try {
    for (const phase of ['private_commit', 'remote_accept']) {
      const options = { path: join(root, `${phase}.db`), installationId: 'fixture', endpoint };
      // Explicit isolated crash fixture, not a product/runtime debug entry.
      const script = `import {OtelAdapterStore} from ${JSON.stringify(moduleUrl)};
import {exportOtelSpans} from ${JSON.stringify(exporterUrl)};
import {materializeSpan} from ${JSON.stringify(mappingUrl)};
const store=new OtelAdapterStore(${JSON.stringify(options)});store.setGrant(${JSON.stringify(stamp)});store.consume(${JSON.stringify(delivery)});
${phase === 'remote_accept' ? `const row=store.next();store.admitSend(row);const result=await exportOtelSpans({endpoint:${JSON.stringify(endpoint)},spans:[materializeSpan(row.envelope)],authorizeSend:async()=>({headers:{},target:{address:'127.0.0.1',family:4}})});if(result.kind!=='full')throw Error('expected_full');` : ''}
console.log('ready');await new Response(Bun.stdin.stream()).text();`;
      const child = Bun.spawn(
        [process.execPath, '--no-env-file', '--no-install', '--eval', script],
        { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      );
      try {
        const reader = child.stdout.getReader();
        const output = await reader.read();
        reader.releaseLock();
        expect(new TextDecoder().decode(output.value)).toContain('ready');
        child.kill('SIGKILL');
        await child.exited;
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      }
      const recovered = new OtelAdapterStore(options);
      try {
        recovered.setGrant(stamp);
        expect(recovered.consume(delivery).acknowledgedEventIds).toHaveLength(2);
        expect(recovered.inspect().outgoing).toHaveLength(1);
        if (phase === 'remote_accept') {
          const row = recovered.next()!;
          expect(row.possibleDuplicate).toBe(true);
          recovered.admitSend(row);
          const result = await exportOtelSpans({
            endpoint,
            spans: [materializeSpan(row.envelope)],
            async authorizeSend() {
              return { headers: {}, target: { address: '127.0.0.1', family: 4 as const } };
            },
          });
          recovered.finish(row, result);
          expect(recovered.inspect().outgoing[0]).toMatchObject({
            status: 'accepted',
            possibleDuplicate: 1,
          });
        }
      } finally {
        recovered.close();
      }
    }
    expect(deliveries).toBe(2);
  } finally {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('official SDK/Protobuf exporter observes decoded full/partial, permanent/retry and missing response independently', async () => {
  let mode = 'full',
    lastHost = '',
    requests = 0,
    admissions = 0;
  const server = createServer((request, response) => {
    requests++;
    lastHost = request.headers.host ?? '';
    request.resume();
    request.on('end', () => {
      if (mode === 'drop') {
        response.writeHead(200);
        response.flushHeaders();
        response.destroy();
        return;
      }
      if (mode === 'retry' && requests === 1) {
        response.writeHead(503, { 'Retry-After': '0' });
        response.end();
        return;
      }
      response.writeHead(mode === 'permanent' ? 400 : 200, {
        'Content-Type': 'application/x-protobuf',
      });
      // Fixed OTLP ExportTraceServiceResponse fixture: partial_success {rejected_spans:1}.
      response.end(
        mode === 'partial'
          ? Buffer.from('0a020801', 'hex')
          : mode === 'invalid'
            ? Buffer.from('ff', 'hex')
            : Buffer.alloc(0),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
  const span = materializeSpan({
    identity: 'fixture',
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    mappingVersion: 1,
    name: 'kite.model',
    kind: SpanKind.CLIENT,
    startTime: 1000,
    endTime: 1100,
    attributes: { 'openinference.span.kind': 'LLM' },
    status: SpanStatusCode.UNSET,
    links: [],
  });
  try {
    for (const [selected, expected] of [
      ['full', 'full'],
      ['partial', 'partial'],
      ['invalid', 'unconfirmed'],
      ['permanent', 'permanent'],
      ['retry', 'full'],
      ['drop', 'unconfirmed'],
    ] as const) {
      mode = selected!;
      requests = 0;
      admissions = 0;
      const result = await exportOtelSpans({
        endpoint,
        spans: [span],
        timeoutMs: 500,
        async authorizeSend() {
          admissions++;
          return { headers: {}, target: { address: '127.0.0.1', family: 4 as const } };
        },
      });
      expect(result.kind).toBe(expected);
      expect(admissions).toBe(requests);
      if (selected === 'partial')
        expect(result).toMatchObject({ rejectedCount: 1, code: 'partial_success', attempts: 1 });
      if (selected === 'permanent') expect(requests).toBe(1);
      if (selected === 'retry')
        expect(result).toMatchObject({ attempts: 2, possibleDuplicate: true });
    }
    mode = 'full';
    requests = 0;
    const pinned = await exportOtelSpans({
      endpoint: endpoint.replace('127.0.0.1', 'collector.invalid'),
      spans: [span],
      async authorizeSend() {
        return { headers: {}, target: { address: '127.0.0.1', family: 4 } };
      },
    });
    expect(pinned.kind).toBe('full');
    expect(requests).toBe(1);
    expect(lastHost).toContain('collector.invalid');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10000);
