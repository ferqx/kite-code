import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import type { NativeCaller } from '../../electron/native-caller';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('native_refresh_active_timeout')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
test('actual active Model remains dispatched while persistent notifications and a held successor view cannot starve original Native steer', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-native-refresh-active-'));
  const store = await openSqliteStore({ dataRoot: root, profile: 'new' }),
    storeId = (await store.getMetadata()).storeId;
  const modelGate = gate(),
    modelEntered = gate(),
    first = gate(),
    firstEntered = gate(),
    successor = gate(),
    successorEntered = gate(),
    dirty = gate();
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [{ type: 'text_delta', text: 'original dispatched' }, finish],
    [{ type: 'text_delta', text: 'steer applied at later checkpoint' }, finish],
  ]);
  const gatedModel: ModelAdapter = {
    async *stream(request, options) {
      const iterator = model.stream(request, options)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (model.requests.length === 1) {
        modelEntered.release();
        if (!first.done) yield first.value;
        await modelGate.promise;
      } else if (!first.done) yield first.value;
      for (;;) {
        const event = await iterator.next();
        if (event.done) break;
        yield event.value;
      }
    },
  };
  const runtime = createRuntime({
    store,
    model: gatedModel,
    modelId: 'fixed',
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Original',
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: root, name: 'new', accessKey: 'owned' },
    subjectId: 'owner',
    buildId: 'active-refresh',
  });
  const gatedViews: { ordinal: number; source: string | null }[] = [];
  let journalViews = 0;
  let views = 0,
    gateEnabled = false;
  const relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const response = await fetch(`${service.endpoint}${url.pathname}${url.search}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${service.bootstrap.token}`,
          'content-type': 'application/json',
        },
        ...(request.method === 'GET' ? {} : { body: await request.arrayBuffer() }),
      });
      const channel = request.headers.get('x-owned-view-source');
      if (gateEnabled && url.pathname.endsWith('/view') && channel === 'journal') journalViews++;
      if (gateEnabled && url.pathname.endsWith('/view') && channel === 'observer') {
        views++;
        gatedViews.push({ ordinal: views, source: request.headers.get('x-owned-view-source') });
        if (views === 1) {
          firstEntered.release();
          await first.promise;
        } else if (views === 2) {
          successorEntered.release();
          await successor.promise;
        }
      }
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });
  const expected = {
    profile: service.bootstrap.profile,
    apiMajor: 1,
    requiredCapabilities: ['sessions', 'commands', 'history'],
    instanceId: service.bootstrap.instanceId,
    buildId: service.bootstrap.buildId,
  };
  const client = createClient({
      endpoint: `http://127.0.0.1:${relay.port}`,
      token: service.bootstrap.token,
      expected,
    }),
    control = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected,
    });
  await client.connect();
  await control.connect();
  let caller: Pick<NativeCaller, 'invoke' | 'close'> | undefined;
  let native: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  let nativeOutput: Promise<void> | undefined, nativeErrors: Promise<string> | undefined;
  let sequence = 0;
  let closeFact: unknown, heldFact: unknown, cleanupFailure: unknown;
  let stage = 'build',
    failure: unknown;
  const viewSources: string[] = [];
  const pending = new Map<
    number,
    {
      resolve(value: Awaited<ReturnType<NativeCaller['invoke']>>): void;
      reject(error: Error): void;
    }
  >();
  const invoke = (request: Parameters<NativeCaller['invoke']>[0]) => {
    const id = ++sequence;
    const result = new Promise<Awaited<ReturnType<NativeCaller['invoke']>>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    native!.stdin.write(`${JSON.stringify({ id, request })}\n`);
    return result;
  };
  try {
    const helperPath = join(root, 'profile-access.js');
    const helper = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../electron/profile-access-helper.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'profile-access.js',
    });
    if (!helper.success) throw Error('owned_profile_helper_build_failed');
    symlinkSync(
      resolve(import.meta.dir, '../../../..', 'node_modules'),
      join(root, 'node_modules'),
    );
    const entry = join(root, 'native-refresh.ts');
    writeFileSync(
      entry,
      `
import {createInterface} from 'node:readline';
import {AsyncLocalStorage} from 'node:async_hooks';
import {selectProfile} from '@kite-ai/agent/profile';
import {createClient} from '@kite-ai/client';
import {NativeCallerJournal} from ${JSON.stringify(resolve(import.meta.dir, '../../electron/caller-journal.ts'))};
import {NativeCaller} from ${JSON.stringify(resolve(import.meta.dir, '../../electron/native-caller.ts'))};
import {openPrivateData} from ${JSON.stringify(resolve(import.meta.dir, '../../electron/private-data.ts'))};
import {acquireDesktopProfileAccess} from ${JSON.stringify(resolve(import.meta.dir, '../../electron/profile-access.ts'))};
const lines=createInterface({input:process.stdin});
const iterator=lines[Symbol.asyncIterator]();
const setup=JSON.parse((await iterator.next()).value);
const reads=new AsyncLocalStorage();
const actualFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const source=reads.getStore()??'observer';const headers=new Headers(options?.headers);headers.set('x-owned-view-source',source);return actualFetch(input,{...options,headers});};
for(const method of ['prepare','submit','lookup']){const original=NativeCallerJournal.prototype[method];NativeCallerJournal.prototype[method]=function(...args){return reads.run('journal',()=>original.apply(this,args));};}
const client=createClient(setup.connection);
let data,access,caller;
const reply=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
try {
 await client.connect();
 access=await acquireDesktopProfileAccess(setup.access);
 data=openPrivateData(selectProfile(setup.access.profile).profilePath,access);
 const getView=client.getView.bind(client);
 client.getView=(...args)=>{const source=reads.getStore()??'observer';reply({viewReadSource:source});return reads.run(source,()=>getView(...args));};
 const observe=client.observe.bind(client);
 client.observe=(options)=>observe({...options,onChange:(change)=>{const result=options.onChange(change);reply({changeSessionId:change.sessionId});return result;}});
 caller=new NativeCaller(client,()=>{},data);
 for (;;) {
  const next=await iterator.next();if(next.done)break;
  const {id,request}=JSON.parse(next.value);
  try {
   if(request.method==='owned.close'){await caller.close();caller=undefined;const commands=data.callers().map(record=>({commandId:record.intent.request.commandId,phase:record.phase}));data.close();data=undefined;reply({id,value:{commands,privateDataClosed:true,profileAccessClosed:true}});break;}
   reply({id,value:await caller.invoke(request)});
  }catch(error){reply({id,error:error instanceof Error?error.message:'owned_native_failure'});}
 }
} finally {
 try {await caller?.close();}finally{try{data?.close();}finally{if(!data)access?.close();client.disposeNetwork();lines.close();process.stdin.destroy();}}
}
`,
      { mode: 0o600 },
    );
    const built = await Bun.build({
      entrypoints: [entry],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'native-refresh.js',
    });
    if (!built.success) throw Error('owned_native_build_failed');
    native = Bun.spawn([realpathSync(Bun.which('node')!), join(root, 'native-refresh.js')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    nativeErrors = new Response(native.stderr).text();
    nativeOutput = (async () => {
      const reader = native!.stdout.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          for (;;) {
            const end = buffer.indexOf('\n');
            if (end < 0) break;
            const row = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (row.viewReadSource) viewSources.push(row.viewReadSource);
            if (row.changeSessionId === 's' && gateEnabled) dirty.release();
            const original = pending.get(row.id);
            if (original) {
              pending.delete(row.id);
              if (row.error) original.reject(Error(row.error));
              else original.resolve(row.value);
            }
          }
        }
        buffer += decoder.decode();
        if (buffer.length) throw Error('owned_native_incomplete_json_line');
      } finally {
        reader.releaseLock();
        for (const original of pending.values()) original.reject(Error('owned_native_closed'));
        pending.clear();
      }
    })();
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    native.stdin.write(
      `${JSON.stringify({
        connection: {
          endpoint: `http://127.0.0.1:${relay.port}`,
          token: service.bootstrap.token,
          expected,
        },
        access: {
          profile: { dataRoot: root, profile: 'new' },
          bunExecutable: realpathSync(process.execPath),
          bunSha256: hash(process.execPath),
          helperPath,
          helperSha256: hash(helperPath),
        },
      })}\n`,
    );
    caller = {
      invoke,
      close: async () => {
        const id = ++sequence;
        const closed = new Promise<Awaited<ReturnType<NativeCaller['invoke']>>>((resolve, reject) =>
          pending.set(id, { resolve, reject }),
        );
        native!.stdin.write(`${JSON.stringify({ id, request: { method: 'owned.close' } })}\n`);
        closeFact = await bounded(closed);
        const exit = await bounded(native!.exited);
        if (exit !== 0) throw Error('owned_native_exit_failed');
        await nativeOutput;
        await nativeErrors;
      },
    };
    stage = 'attach';
    await caller.invoke({ method: 'attach' });
    await caller.invoke({ method: 'select', generation: 1, sessionId: 's' });
    await control.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'hold actual Model',
    });
    stage = 'model';
    await bounded(modelEntered.promise);
    const active = (await control.getView('s')).runs.find((value) => value.isActive)!;
    gateEnabled = true;
    const original = (await control.getView('s')).session;
    await control.renameSession('s', {
      expectedStoreId: storeId,
      commandId: 'notify-one',
      ifRevision: original.controlRevision,
      title: 'One persistent notification',
    });
    stage = 'first-view';
    await bounded(firstEntered.promise);
    const next = (await control.getView('s')).session;
    await control.renameSession('s', {
      expectedStoreId: storeId,
      commandId: 'notify-two',
      ifRevision: next.controlRevision,
      title: 'Second persistent notification',
    });
    stage = 'dirty';
    await bounded(dirty.promise);
    const input = caller.invoke({
      method: 'submit',
      generation: 1,
      sessionId: 's',
      intent: {
        kind: 'input.steer',
        expectedStoreId: storeId,
        commandId: 'explicit-steer',
        targetRunId: active.id,
        contextSelectionId: original.contextSelectionId,
        content: 'new exact user input',
      },
    });
    first.release();
    stage = 'successor';
    await bounded(successorEntered.promise);
    stage = 'accepted';
    const accepted = await bounded(input);
    expect(accepted).toMatchObject({ phase: 'accepted', intent: { commandId: 'explicit-steer' } });
    expect((await control.getCommand('explicit-steer')).status).toBe('accepted');
    expect(model.requests).toHaveLength(1);
    expect(
      (await control.getView('s')).runs.find((value) => value.id === active.id)?.isActive,
    ).toBe(true);
    expect(views).toBeGreaterThanOrEqual(2);
    expect(journalViews).toBeGreaterThan(0);
    heldFact = {
      storeId,
      runId: active.id,
      commandId: 'explicit-steer',
      phase: 'accepted',
      modelRequests: model.requests.length,
      observerViews: views,
      journalViews,
    };
    successor.release();
    modelGate.release();
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
  } catch (error) {
    failure = error;
    console.error(
      JSON.stringify({
        stage,
        viewSources,
        gatedViews,
        code: error instanceof Error ? error.message : 'owned_failure',
      }),
    );
  } finally {
    first.release();
    successor.release();
    modelGate.release();
    const cleanupErrors: unknown[] = [];
    const collect = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await collect(async () => caller?.close());
    await collect(async () => {
      if (native?.exitCode === null) {
        native.kill('SIGTERM');
        await bounded(native.exited);
      }
    });
    await collect(async () => nativeOutput && bounded(nativeOutput));
    let stderr: string | undefined;
    await collect(async () => {
      if (nativeErrors) stderr = await bounded(nativeErrors);
    });
    client.disposeNetwork();
    control.disposeNetwork();
    await collect(async () => relay.stop(true));
    await collect(async () => service.close());
    if (!failure && cleanupErrors.length === 0) {
      await collect(async () => rmSync(root, { recursive: true, force: true }));
    }
    const evidence = `${root}-evidence.json`;
    if (failure && stderr) writeFileSync(`${root}-native.stderr.log`, stderr, { mode: 0o600 });
    writeFileSync(
      evidence,
      JSON.stringify({
        stage,
        heldFact,
        closeFact,
        observerViews: views,
        journalViews,
        gatedViews,
        nativeExit: native?.exitCode,
        failure: failure instanceof Error ? failure.message : undefined,
        cleanupErrors: cleanupErrors.map((error) =>
          error instanceof Error ? error.message : 'owned_cleanup_failure',
        ),
        rootRemoved: !existsSync(root),
      }),
      { mode: 0o600 },
    );
    console.error(
      JSON.stringify({
        evidence,
        nativeExit: native?.exitCode,
        cleanupConfirmed: cleanupErrors.length === 0,
        rootRemoved: !existsSync(root),
      }),
    );
    if (cleanupErrors.length)
      cleanupFailure = new AggregateError(cleanupErrors, 'owned_native_cleanup_failed');
  }
  if (failure && cleanupFailure)
    throw new AggregateError([failure, cleanupFailure], 'owned_native_failed');
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
  expect({ closeFact, nativeExit: native?.exitCode }).toEqual({
    closeFact: {
      commands: [{ commandId: 'explicit-steer', phase: 'accepted' }],
      privateDataClosed: true,
      profileAccessClosed: true,
    },
    nativeExit: 0,
  });
}, 15000);
