import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  createPassiveWebExtractor,
  createPinnedWebNetworkPort,
  createWebFetchExtension,
} from '@kite-ai/agent/web-fetch';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import type { DarwinWorkerThreadRecord } from '../../../packages/agent/src/platform/process/worker-thread.darwin';
import * as originalThreadLeaf from '../../../packages/agent/src/platform/process/worker-thread.darwin';

async function until(read: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 5000;
  while (!(await read())) {
    if (Date.now() > deadline) throw Error('worker_close_observation_timeout');
    await Bun.sleep(5);
  }
}

const originalThreadExports = { ...originalThreadLeaf };
const threadLeafPath = resolve(
  import.meta.dir,
  '../../../packages/agent/src/platform/process/worker-thread.darwin.ts',
);
const native = process.platform === 'darwin';
interface WorkerRecord {
  kind: 'parser' | 'sqlite';
  worker: Worker;
  closed: boolean;
  message: boolean;
  closeAck: boolean;
  closeRequest?: number;
  pendingParse?: () => void;
  origin?: DarwinWorkerThreadRecord;
  nativeState?: 'alive' | 'terminated';
  retained: boolean;
  released: boolean;
  allowCompletion: boolean;
  posts: number;
}
function instrumentWorkers() {
  const OriginalWorker = globalThis.Worker;
  const records: WorkerRecord[] = [];
  const control = {
    holdParse: false,
    autoAllow: false,
    onCreated: undefined as ((record: WorkerRecord) => void) | undefined,
  };
  mock.module(threadLeafPath, () => ({
    ...originalThreadExports,
    retainWorkerThread(record: DarwinWorkerThreadRecord) {
      // Identity comes from an independent original-prototype preload message observer.
      const observation = records.find((entry) => entry.origin === record);
      if (!observation) throw Error('original_worker_origin_not_observed');
      const lease = originalThreadExports.retainWorkerThread(record);
      observation.retained = true;
      return {
        inspect() {
          const state = lease.inspect();
          observation.nativeState = state;
          // Pending cannot grant death: hold only confirmation after the real API
          // has observed this original retained right as DEAD_NAME.
          return state === 'terminated' && !observation.allowCompletion ? 'alive' : state;
        },
        release() {
          lease.release();
          observation.released = true;
        },
      };
    },
  }));
  globalThis.Worker = class extends OriginalWorker {
    record: WorkerRecord;
    constructor(...args: ConstructorParameters<typeof OriginalWorker>) {
      super(...args);
      this.record = {
        kind: String(args[0]).includes('storage/worker/main') ? 'sqlite' : 'parser',
        worker: this,
        closed: false,
        message: false,
        closeAck: false,
        retained: false,
        released: false,
        allowCompletion: control.autoAllow,
        posts: 0,
      };
      records.push(this.record);
      OriginalWorker.prototype.addEventListener.call(this, 'message', (original: Event) => {
        const event = original as MessageEvent;
        if (event.data?.protocol === 'kite_worker_thread@1') {
          this.record.origin = event.data.thread;
          return;
        }
        this.record.message = true;
        if (
          this.record.kind === 'sqlite' &&
          event.data.id === this.record.closeRequest &&
          !event.data.error
        )
          this.record.closeAck = true;
      });
      OriginalWorker.prototype.addEventListener.call(this, 'close', () => {
        this.record.closed = true;
      });
      control.onCreated?.(this.record);
    }
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      if (this.record.kind === 'sqlite') {
        const frame = message as { method?: string; id?: number };
        if (frame.method === 'close') this.record.closeRequest = frame.id;
      }
      const post = () => {
        this.record.posts++;
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      };
      if (this.record.kind === 'parser' && control.holdParse) this.record.pendingParse = post;
      else post();
    }
  } as typeof Worker;
  return {
    records,
    control,
    restore() {
      for (const record of records) record.allowCompletion = true;
      globalThis.Worker = OriginalWorker;
      mock.module(threadLeafPath, () => originalThreadExports);
    },
  };
}

// macOS confirms the real original Mach right. Other platforms execute the full
// business chain and explicitly retain unknown physical-worker qualification.
test('public web_fetch/cancellation retain original worker rights through Store/profile handoff and cold zero-replay reads', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worker-handoff-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'close' });
  const probe = instrumentWorkers();
  const { records } = probe;
  const article = '完整原网页中🙂e\u0301\r\n原正文 '.repeat(100);
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return new Response(
        new URL(request.url).pathname === '/robots.txt'
          ? 'User-agent: *\nAllow: /'
          : `<html><head><title>Original article</title></head><body><article><h1>Original article</h1><p>${article}</p></article></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
  const url = `http://fixture.test:${remote.port}/article`;
  const network = createPinnedWebNetworkPort({
    policy: { mode: 'public' },
    allowLoopbackForTests: true,
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
    admitHop: async () => ({ allowed: true, revision: 'test-loopback' }),
  });
  const extension = createWebFetchExtension({ networkPort: network });
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const calls: ModelEvent[] = [
    { type: 'tool_call', id: 'web', name: 'web_fetch', arguments: JSON.stringify({ url }) },
    { ...finish, reason: 'tool_calls' },
  ];
  const model = createFixedModel([
    calls,
    [{ type: 'text_delta', text: 'Original verified response' }, finish],
    calls,
    [finish],
  ]);
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    instanceId: 'worker-handoff',
    buildId: 'fixed',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['sessions', 'commands', 'history'],
    },
  });
  let failed = false,
    originalFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'original',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'original',
    });
    await client.startRun('s', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'normal',
      content: 'Read original article',
    });
    await until(() =>
      records.some(
        (record) =>
          record.kind === 'parser' &&
          (native ? record.nativeState === 'terminated' : record.closed),
      ),
    );
    const normalParser = records.find((record) => record.kind === 'parser')!;
    expect(normalParser.message).toBe(true);
    if (native) {
      expect(normalParser.origin?.pid).toBe(process.pid);
      expect(normalParser.retained).toBe(true);
      expect(normalParser.nativeState).toBe('terminated');
      expect(normalParser.released).toBe(false);
      expect(model.requests.length).toBe(1);
      expect((await client.getView('s')).runs.some((run) => run.status === 'completed')).toBe(
        false,
      );
    } else expect(normalParser.nativeState).toBeUndefined();
    normalParser.allowCompletion = true;
    await until(async () =>
      (await client.getView('s')).runs.some((run) => run.status === 'completed'),
    );
    expect(model.requests.length).toBe(2);
    if (native) expect(normalParser.released).toBe(true);
    const complete = await client.getView('s');
    expect(complete.executions.find((execution) => execution.kind === 'tool')?.status).toBe(
      'succeeded',
    );
    const originalMessages = await client.listMessages('s');
    expect(originalMessages.some((message) => message.content.includes('完整原网页中'))).toBe(true);
    probe.control.holdParse = true;
    await client.startRun('s', {
      kind: 'run.start',
      expectedStoreId: storeId,
      commandId: 'cancelled',
      content: 'Cancel this original fetch',
    });
    await until(() => records.filter((record) => record.kind === 'parser').length === 2);
    const cancelledParser = records.filter((record) => record.kind === 'parser')[1]!;
    await until(() => !!cancelledParser.pendingParse);
    const cancellingRun = (await client.getView('s')).runs.find((run) => run.isActive)!;
    await client.cancelRun('s', {
      kind: 'run.cancel',
      expectedStoreId: storeId,
      commandId: 'cancel-exact',
      runId: cancellingRun.id,
    });
    await until(() =>
      native ? cancelledParser.nativeState === 'terminated' : cancelledParser.closed,
    );
    expect(cancelledParser.message).toBe(false);
    if (native) {
      expect(cancelledParser.retained).toBe(true);
      expect(cancelledParser.nativeState).toBe('terminated');
      expect(cancelledParser.released).toBe(false);
      expect((await client.getRun(cancellingRun.id)).status).toBe('cancelling');
    } else expect(cancelledParser.nativeState).toBeUndefined();
    expect(model.requests.length).toBe(3);
    cancelledParser.allowCompletion = true;
    await until(async () => (await client.getRun(cancellingRun.id)).status === 'cancelled');
    expect(model.requests.length).toBe(3);
    if (native) expect(cancelledParser.released).toBe(true);
    const durable = await client.listMessages('s');
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    const sql = records.find((record) => record.kind === 'sqlite')!;
    await until(() => sql.closeAck && (native ? sql.nativeState === 'terminated' : sql.closed));
    expect(sql.closeAck).toBe(true);
    if (native) {
      expect(sql.retained).toBe(true);
      expect(sql.nativeState).toBe('terminated');
      expect(sql.released).toBe(false);
      expect(closed).toBe(false);
      await expect(
        createProfileBackup({ profile, destinationRoot: join(root, 'still-owned') }),
      ).rejects.toMatchObject({ code: 'owner_busy' });
    } else expect(sql.nativeState).toBeUndefined();
    sql.allowCompletion = true;
    await closing;
    expect(closed).toBe(true);
    if (native) expect(sql.released).toBe(true);
    await service.close();
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'released') });
    expect(backup.manifest.source.storeId).toBe(storeId);
    // Real new read-only SQLite Worker, same original rows, no Runtime dispatch/replay.
    probe.control.autoAllow = true;
    const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
    const coldSql = records.filter((record) => record.kind === 'sqlite').at(-1)!;
    coldSql.allowCompletion = true;
    const coldRuntime = createRuntime({
      store: cold,
      modelId: 'fixed',
      model,
      permissions: {
        async authorize() {
          return { allowed: false, revision: 'cold-readonly' };
        },
      },
    });
    const coldService = await startService({
      runtime: coldRuntime,
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      instanceId: 'cold-worker-handoff',
      buildId: 'fixed',
    });
    const coldClient = createClient({
      endpoint: coldService.endpoint,
      token: coldService.bootstrap.token,
      expected: {
        profile: coldService.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history'],
      },
    });
    try {
      await coldClient.connect();
      expect((await cold.getMetadata()).storeId).toBe(storeId);
      expect(await coldClient.listMessages('s')).toEqual(durable);
      expect((await coldClient.getRun(cancellingRun.id)).status).toBe('cancelled');
      expect(model.requests.length).toBe(3);
    } finally {
      coldClient.disposeNetwork();
      await coldService.close();
      await coldRuntime.close();
    }
  } catch (error) {
    failed = true;
    originalFailure = error;
  } finally {
    for (const record of records) record.allowCompletion = true;
    const cleanup = async (close: () => void | Promise<void>) => {
      try {
        await close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    await cleanup(() => client.disposeNetwork());
    await cleanup(() => service.close());
    await cleanup(() => runtime.close());
    remote.stop(true);
    probe.restore();
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      failed ? [originalFailure, ...cleanupFailures] : cleanupFailures,
      `worker_close_cleanup_failed:${root}`,
      { cause: originalFailure },
    );
  if (failed) throw originalFailure;
  rmSync(root, { recursive: true, force: true });
}, 30000);

test('trusted custom parser preserves original main/import/one input, syntax error and earliest original abort', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worker-main-contract-')));
  const probe = instrumentWorkers();
  probe.control.autoAllow = true;
  const path = join(root, 'original-main.js');
  const relative = join(root, 'relative.js');
  writeFileSync(relative, "export const marker = 'original relative 中🙂';\n");
  writeFileSync(
    path,
    `import {marker} from './relative.js';\nlet calls=0;\nself.onmessage=({data})=>self.postMessage({title:import.meta.url,content:JSON.stringify({main:import.meta.url,isMain:import.meta.main,marker,calls:++calls,input:data})});\n`,
  );
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  let failed = false,
    originalFailure: unknown;
  try {
    const body = {
      html: '完整原input中🙂e\u0301\r\n原第二行',
      url: 'https://original.test/custom',
    };
    // Independent Bun process has no preload or parent module mocks. It runs the
    // exact same original main and original input to establish runtime semantics.
    const baselineProgram = `const worker = new Worker(${JSON.stringify(path)});
worker.onmessage = ({data}) => { console.log(JSON.stringify(data)); worker.terminate(); };
worker.onerror = () => { console.error('original_worker_failed'); process.exitCode = 1; worker.terminate(); };
worker.postMessage(${JSON.stringify(body)});`;
    const baselineChild = Bun.spawn([process.execPath, '--no-install', '--eval', baselineProgram], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let baselineTimedOut = false;
    const baselineTimer = setTimeout(() => {
      baselineTimedOut = true;
      baselineChild.kill('SIGKILL');
    }, 5000);
    let baselineExit: number, baselineOut: string, baselineError: string;
    try {
      [baselineExit, baselineOut, baselineError] = await Promise.all([
        baselineChild.exited,
        new Response(baselineChild.stdout).text(),
        new Response(baselineChild.stderr).text(),
      ]);
    } finally {
      clearTimeout(baselineTimer);
    }
    expect(baselineTimedOut).toBe(false);
    expect(baselineExit).toBe(0);
    expect(baselineError).toBe('');
    const baselineResult = JSON.parse(baselineOut.trim()) as { title: string; content: string };
    const baseline = JSON.parse(baselineResult.content) as {
      main: string;
      isMain: boolean;
      marker: string;
      calls: number;
      input: typeof body;
    };
    expect(typeof baseline.isMain).toBe('boolean');
    expect(baselineResult.title).toBe(pathToFileURL(path).href);
    expect(baseline.main).toBe(pathToFileURL(path).href);
    expect(baseline.marker).toBe('original relative 中🙂');
    expect(baseline.calls).toBe(1);
    expect(baseline.input).toEqual(body);
    const extractor = createPassiveWebExtractor({ workerPath: path, expectedHash: hash(path) });
    const result = await extractor.extract(body, { signal: new AbortController().signal });
    const original = JSON.parse(result.content) as {
      main: string;
      isMain: boolean;
      marker: string;
      calls: number;
      input: typeof body;
    };
    expect(result.title).toBe(pathToFileURL(path).href);
    expect(original.main).toBe(pathToFileURL(path).href);
    expect(original.isMain).toBe(baseline.isMain);
    expect(original).toEqual(baseline);
    expect(original.marker).toBe('original relative 中🙂');
    expect(original.calls).toBe(1);
    expect(original.input).toEqual(body);
    expect(probe.records[0]?.posts).toBe(1);
    if (native) {
      expect(probe.records[0]?.origin?.pid).toBe(process.pid);
      expect(probe.records[0]?.nativeState).toBe('terminated');
      expect(probe.records[0]?.released).toBe(true);
    } else expect(probe.records[0]?.nativeState).toBeUndefined();

    const invalid = join(root, 'original-syntax-error.js');
    writeFileSync(invalid, 'self.onmessage = (\n');
    await expect(
      createPassiveWebExtractor({ workerPath: invalid, expectedHash: hash(invalid) }).extract(
        body,
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'web_parser_unavailable' });
    const syntaxWorker = probe.records.at(-1)!;
    expect(syntaxWorker.posts).toBe(1);
    if (native) expect(syntaxWorker.released).toBe(true);
    else expect(syntaxWorker.nativeState).toBeUndefined();

    const cancellation = new AbortController();
    const reason = new Error('original earliest parser cancellation');
    probe.control.onCreated = () => {
      probe.control.onCreated = undefined;
      cancellation.abort(reason);
    };
    await expect(extractor.extract(body, { signal: cancellation.signal })).rejects.toBe(reason);
    const earliest = probe.records.at(-1)!;
    expect(earliest.posts).toBe(0);
    expect(earliest.message).toBe(false);
    if (native) {
      expect(earliest.origin?.pid).toBe(process.pid);
      expect(earliest.nativeState).toBe('terminated');
      expect(earliest.released).toBe(true);
    } else expect(earliest.nativeState).toBeUndefined();
  } catch (error) {
    failed = true;
    originalFailure = error;
  } finally {
    probe.restore();
  }
  if (failed) throw originalFailure;
  rmSync(root, { recursive: true, force: true });
}, 20000);
