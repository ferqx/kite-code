import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceEventBatch } from '@kite-ai/trajectory';
import { createTraceEngine, TraceEngineError } from '../../src/trace-extensions/engine';
import { engineDigest, type TraceEngineAssets } from '../../src/trace-extensions/engine/assets';
import { buildTraceEngineAssets } from '../../src/trace-extensions/engine/build-assets';

let directory: string, assets: TraceEngineAssets;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'kite-trace-engine-test-'));
  assets = await buildTraceEngineAssets(join(directory, 'assets'));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const bundle = (source: string) => ({
  apiVersion: 1 as const,
  source,
  sha256: engineDigest(source),
});
const batch = (generation = '1'): TraceEventBatch => ({
  source: 'live',
  batchId: 'batch',
  leaseToken: 'lease',
  processGeneration: generation,
  partition: {
    installationId: 'installation',
    storeRef: 'store',
    sessionRef: 'session',
    subscriptionEpoch: '1',
    lane: { kind: 'live' },
  },
  grantRevision: '1',
  filterRevision: '1',
  upperCursor: '9007199254741000',
  fromCursor: '0',
  scannedThrough: '9007199254741000',
  events: [],
  integrity: { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] },
});
const acknowledgement = `function ack(b){return {batchId:b.batchId,leaseToken:b.leaseToken,processGeneration:b.processGeneration,subscriptionEpoch:b.partition.subscriptionEpoch,acknowledgedEventIds:b.events.map(e=>e.eventId),rejected:[]};}`;

describe('isolated Trace engine', () => {
  test('two real independent guest bundles use async JSON broker and retain exact generation', async () => {
    const seen: unknown[] = [];
    const source = `${acknowledgement} defineTraceExtension({async initialize(){await trace.request('settings',{first:true});},async onEvents(b){if(b.scannedThrough!=='9007199254741000')throw Error('decimal64');const v=await trace.request('probe',{process:typeof process,Bun:typeof Bun,require:typeof require,fetch:typeof fetch,WebAssembly:typeof WebAssembly});if(v!==true)throw Error('broker');await trace.request('settings',{second:true});return ack(b);}});`;
    const first = await createTraceEngine({
      installationId: 'first',
      generation: '1',
      assets,
      bundle: bundle(source),
      broker: async (method, input) => {
        seen.push({ method, input });
        await Bun.sleep(2);
        return true;
      },
    });
    const second = await createTraceEngine({
      installationId: 'second',
      generation: '2',
      assets,
      bundle: bundle(`${acknowledgement} defineTraceExtension({onEvents:async b=>ack(b)});`),
      broker: async () => null,
    });
    try {
      expect(first.readExitEvidence().identity.pid).not.toBe(
        second.readExitEvidence().identity.pid,
      );
      await first.initialize(null);
      const [one, two] = await Promise.all([first.onEvents(batch()), second.onEvents(batch('2'))]);
      expect(one.processGeneration).toBe('1');
      expect(two.processGeneration).toBe('2');
      expect(seen).toEqual([
        { method: 'settings', input: { first: true } },
        {
          method: 'probe',
          input: {
            process: 'undefined',
            Bun: 'undefined',
            require: 'undefined',
            fetch: 'undefined',
            WebAssembly: 'undefined',
          },
        },
        { method: 'settings', input: { second: true } },
      ]);
      await expect(first.onEvents(batch('2'))).rejects.toThrow('trace_engine_generation_mismatch');
      await expect(
        createTraceEngine({
          installationId: 'first',
          generation: '3',
          assets,
          bundle: bundle(source),
          broker: async () => null,
        }),
      ).rejects.toThrow('trace_engine_scope_busy');
    } finally {
      const [one, two] = await Promise.all([first.retire(), second.retire()]);
      for (const proof of [one, two]) {
        expect(proof.confirmed).toBe(true);
        expect(proof.exit?.reaped).toBe(true);
        expect(proof.stdoutClosed && proof.stderrClosed && proof.stdinClosed).toBe(true);
      }
    }
  });

  test('infinite loop is externally stopped without blocking another extension', async () => {
    const bad = await createTraceEngine({
      installationId: 'loop',
      generation: '1',
      assets,
      budgets: { callbackMs: 100 },
      bundle: bundle('defineTraceExtension({onEvents(){while(true){}}});'),
      broker: async () => null,
    });
    const good = await createTraceEngine({
      installationId: 'loop-neighbor',
      generation: '1',
      assets,
      bundle: bundle(`${acknowledgement} defineTraceExtension({onEvents:async b=>ack(b)});`),
      broker: async () => null,
    });
    try {
      const failed = bad.onEvents(batch());
      const result = await good.onEvents(batch());
      expect(result.batchId).toBe('batch');
      await expect(failed).rejects.toBeInstanceOf(TraceEngineError);
      const proof = await bad.retire();
      expect(proof.confirmed).toBe(true);
      await expect(bad.onEvents(batch())).rejects.toThrow('trace_engine_retired');
    } finally {
      await Promise.all([bad.retire(), good.retire()]);
    }
  });

  test.each([
    ['heap', "defineTraceExtension({onEvents(){return 'x'.repeat(128*1024*1024)}});"],
    ['stack', 'defineTraceExtension({onEvents(){function f(){return f()}return f()}});'],
    ['module', "defineTraceExtension({async onEvents(){return await import('node:fs')}});"],
    ['message', "defineTraceExtension({onEvents(){return 'x'.repeat(100000)}});"],
  ])('%s failure retires only the original runner', async (name, source) => {
    const engine = await createTraceEngine({
      installationId: `bad-${name}`,
      generation: '1',
      assets,
      budgets: { heapBytes: 2 * 1024 * 1024, messageBytes: 32 * 1024, callbackMs: 100 },
      bundle: bundle(source),
      broker: async () => null,
    });
    await expect(engine.onEvents(batch())).rejects.toBeInstanceOf(TraceEngineError);
    expect((await engine.retire()).confirmed).toBe(true);
  });

  test('retirement aborts broker custody, ignores its late result and allows only a fresh generation', async () => {
    let resolveBroker!: (value: null) => void, notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    let brokerSignal: AbortSignal | undefined;
    const source = `${acknowledgement} defineTraceExtension({async onEvents(b){await trace.request('wait',null);return ack(b)}});`;
    const old = await createTraceEngine({
      installationId: 'retire',
      generation: '1',
      assets,
      bundle: bundle(source),
      broker: async (_, __, context) => {
        brokerSignal = context.signal;
        notify();
        return new Promise((resolve) => {
          resolveBroker = resolve;
        });
      },
    });
    const delivery = old.onEvents(batch());
    await started;
    const retiring = old.retire();
    expect(brokerSignal?.aborted).toBe(true);
    resolveBroker(null);
    await expect(delivery).rejects.toThrow('trace_engine_retired');
    expect((await retiring).confirmed).toBe(true);
    const fresh = await createTraceEngine({
      installationId: 'retire',
      generation: '2',
      assets,
      bundle: bundle(`${acknowledgement} defineTraceExtension({onEvents:b=>ack(b)});`),
      broker: async () => null,
    });
    try {
      expect((await fresh.onEvents(batch('2'))).processGeneration).toBe('2');
    } finally {
      expect((await fresh.retire()).confirmed).toBe(true);
    }
  });

  test('broker call budget rejects floods and does not leak arbitrary errors', async () => {
    let count = 0;
    const engine = await createTraceEngine({
      installationId: 'flood',
      generation: '1',
      assets,
      budgets: { brokerCalls: 2 },
      bundle: bundle(
        "defineTraceExtension({async onEvents(){for(let i=0;i<10;i++)await trace.request('settings',null)}});",
      ),
      broker: async () => {
        count++;
        return null;
      },
    });
    await expect(engine.onEvents(batch())).rejects.toBeInstanceOf(TraceEngineError);
    expect(count).toBe(2);
    expect((await engine.retire()).confirmed).toBe(true);
  });

  test('source hash and authenticated asset closure are checked before launch', async () => {
    await expect(
      createTraceEngine({
        installationId: 'hash',
        generation: '1',
        assets,
        bundle: { ...bundle('defineTraceExtension({})'), sha256: '0'.repeat(64) },
        broker: async () => null,
      }),
    ).rejects.toThrow('trace_engine_bundle_invalid');
    const path = join(assets.directory, 'empty-tsconfig.json'),
      original = readFileSync(path);
    try {
      writeFileSync(path, '{"compilerOptions":{"paths":{"*": ["/tmp/*"]}}}');
      await expect(
        createTraceEngine({
          installationId: 'asset',
          generation: '1',
          assets,
          bundle: bundle('defineTraceExtension({})'),
          broker: async () => null,
        }),
      ).rejects.toThrow('trace_engine_assets_changed');
    } finally {
      writeFileSync(path, original);
    }
  });
});
