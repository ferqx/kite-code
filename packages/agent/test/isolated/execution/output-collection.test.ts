import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import {
  enumerateOutputFiles,
  prepareOutputDirectory,
  withOutputCollection,
} from '../../../src/business/output-collection';
import type { JobDefinition, JobEvent, JobHandle } from '../../../src/extensions';
import { launchIdentityAsync } from '../../../src/jobs/launch-identity';
import { collectOutputStaging } from '../../../src/maintenance/output-staging';
import { type AgentRuntime, createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { createShellExtension } from '../../../src/tools/shell';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;
async function fixture(
  command: string | string[],
  fault?: {
    afterRef?: number;
    beforeRef?: number;
    startFailed?: boolean;
    cancelStart?: boolean;
    denyCollector?: boolean;
    denyAfterAttempt?: number;
  },
) {
  // Match the production coordination root: macOS tmpdir may use the /var alias.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kite-output-real-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  let runtime!: AgentRuntime;
  let starts = 0;
  const roots: string[] = [];
  const handles = new WeakMap<JobHandle, Promise<number>>();
  const job: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'Real bounded subprocess fixture',
    inputSchema: { type: 'object' },
    async start(input, context) {
      starts++;
      const path = await mkdtemp(join(root, 'job-'));
      roots.push(path);
      const allocated = await runtime.prepareOutputCollection(
        context,
        await launchIdentityAsync(path),
      );
      const task = new Promise<number>((resolve, reject) => {
        const child = spawn('/bin/bash', ['-c', (input as { command: string }).command], {
          env: { ...process.env, ...allocated.env },
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      });
      const handle = { reference: { path } };
      handles.set(handle, task);
      return handle;
    },
    async *observe(handle): AsyncIterable<JobEvent> {
      const code = await handles.get(handle)!;
      yield {
        type: 'terminal',
        supervision: 'ended',
        result: {
          outcome: code === 0 ? 'succeeded' : 'failed',
          content: 'finished',
          details: { exitCode: code, processTreeStopped: true },
        },
      };
    },
    async cancel() {
      return { status: 'unknown' };
    },
    async dispose() {},
  };
  const responses: ModelEvent[][] = [
    ...(typeof command === 'string' ? [command] : command).map((text, index) => [
      {
        type: 'tool_call' as const,
        name: 'shell_execute',
        id: typeof command === 'string' ? 'generate' : `generate-${index}`,
        arguments: JSON.stringify({ command: text }),
      },
      { ...finish, reason: 'tool_calls' as const },
    ]),
    [{ type: 'text_delta', text: 'Done' }, finish],
  ];
  const model = createFixedModel([...responses, ...responses]);
  const artifacts = createArtifactStore({ store, profile });
  let publications = 0;
  const collector = withOutputCollection(
    { id: 'builtin.files', version: '1', apiMajor: 1 },
    () => runtime,
  );
  const actions = collector.actions!.map((action) => ({
    ...action,
    async prepare(
      input: Parameters<typeof action.prepare>[0],
      context: Parameters<typeof action.prepare>[1],
    ) {
      if (fault?.cancelStart) {
        const scope = {
          expectedStoreId: (await store.getMetadata()).storeId,
          sessionId: context.sessionId,
          subjectId: 'owner',
        };
        const c = await store.getOutputCollection({
          ...scope,
          collectionId: (input as { collectionId: string }).collectionId,
        });
        await store.cancelCommand({
          ...scope,
          commandId: 'cancel-start',
          targetCommandId: c!.startCommandId!,
        });
      }
      return action.prepare(input, context);
    },
    async execute(
      input: Parameters<typeof action.execute>[0],
      context: Parameters<typeof action.execute>[1],
    ) {
      if (fault?.startFailed)
        return { outcome: 'failed' as const, content: 'fixture_start_failed' };
      return action.execute(input, context);
    },
  }));
  runtime = createRuntime({
    outputCollections: {
      prepare: (context, identity) => prepareOutputDirectory(runtime, context, identity),
    },
    store,
    artifacts: {
      ...artifacts,
      async publishStream(input) {
        publications++;
        if (publications === fault?.beforeRef) throw new Error('fixture_before_ref');
        const reference = await artifacts.publishStream(input);
        if (publications === fault?.afterRef) throw new Error('fixture_after_ref');
        return reference;
      },
    },
    model,
    modelId: 'fixed',
    extensions: [createShellExtension({ job }), { ...collector, actions }],
    permissions: {
      async authorize(request) {
        if (
          request.definitionId === 'builtin.files/collect' &&
          (fault?.denyCollector ||
            (fault?.denyAfterAttempt !== undefined &&
              (request.input as { attempt: number }).attempt > fault.denyAfterAttempt))
        )
          return { allowed: false, revision: 'fixture-denied', reason: 'fixture_collector_denied' };
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  const base = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  await runtime.createWorkspace({
    expectedStoreId: base.expectedStoreId,
    id: 'w',
    name: 'work',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'output' });
  return {
    root,
    profile,
    store,
    runtime,
    base,
    roots,
    model,
    get starts() {
      return starts;
    },
    async run(commandId = 'work') {
      const input = {
        ...base,
        commandId,
        request: { kind: 'run.start' as const, content: 'Create deliverables' },
      };
      await store.acceptCommand(input);
      await runtime.submitCommand(input);
    },
    async page() {
      return runtime.queryOutputFiles(base);
    },
    async wait(predicate: (p: Awaited<ReturnType<AgentRuntime['queryOutputFiles']>>) => boolean) {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const page = await runtime.queryOutputFiles(base);
        if (predicate(page)) return page;
        await Bun.sleep(10);
      }
      throw Error(
        JSON.stringify({
          page: await runtime.queryOutputFiles(base),
          commands: await store.listAcceptedCommands('s'),
        }),
      );
    },
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('real Shell delivers two immutable files without another model call and cleans staging', async () => {
  const f = await fixture(
    `printf hello > "$KITE_OUTPUT_DIR/report.txt"; printf '\\000\\001\\377' > "$KITE_OUTPUT_DIR/report.bin"`,
  );
  try {
    await f.run();
    const page = await f.wait((p) => p.items.length === 2 && p.collections[0]?.state === 'ready');
    expect(f.starts).toBe(1);
    const background = await f.runtime.listBackgroundExecutions({
      expectedStoreId: f.base.expectedStoreId,
      subjectId: f.base.subjectId,
      rootSessionId: 's',
    });
    expect(
      background.items.some(
        (item) =>
          item.execution.definitionId === 'builtin.files/collect' ||
          item.execution.definitionId === 'builtin.files/collect-outputs',
      ),
    ).toBe(false);
    expect(f.model.requests.length).toBe(2);
    expect(new Set(page.items.map((i) => i.fileId)).size).toBe(2);
    for (const item of page.items) {
      const record = await f.runtime.resolveOutputFile({ ...f.base, target: item });
      expect(record.reference.scope).toEqual({ kind: 'session', id: 's' });
      const read = await f.runtime.readArtifact({
        ...f.base,
        refId: record.reference.id,
        scope: record.reference.scope,
      });
      expect(read.content.length).toBe(Number(item.size));
    }
    await expect(readFile(join(f.roots[0]!, 'out/report.txt'))).rejects.toThrow();
    expect(
      f.model.requests
        .at(-1)
        ?.messages.map((m) => m.content)
        .join(''),
    ).not.toContain('output-file-');
  } finally {
    await f.close();
  }
}, 20000);
test('empty out produces no visible collection or files', async () => {
  const f = await fixture('true');
  try {
    await f.run();
    await Bun.sleep(300);
    expect((await f.page()).items).toEqual([]);
    expect((await f.page()).collections).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);
test('nonzero producer never publishes its residual files', async () => {
  const f = await fixture('printf partial > "$KITE_OUTPUT_DIR/final.txt"; exit 7');
  try {
    await f.run();
    await f.wait((p) => p.collections[0]?.errorCode === 'producer_failed');
    expect((await f.page()).items).toEqual([]);
    expect(f.starts).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);
test('symlink candidate fails visibly rather than reading outside allocation', async () => {
  const f = await fixture('ln -s /etc/passwd "$KITE_OUTPUT_DIR/leak.txt"');
  try {
    await f.run();
    const p = await f.wait((p) => p.collections[0]?.state === 'failed');
    expect(p.items).toEqual([]);
    expect(p.collections[0]?.errorCode).toBe('output_file_unsafe');
  } finally {
    await f.close();
  }
}, 20000);

test('ref publication crash window retries stable identity without rerunning producer', async () => {
  const f = await fixture('printf durable > "$KITE_OUTPUT_DIR/report.txt"', { afterRef: 1 });
  try {
    await f.run();
    const failed = await f.wait((p) => p.collections[0]?.state === 'failed');
    const original = failed.collections[0]!;
    expect(failed.items).toHaveLength(0);
    await f.runtime.retryOutputCollection({
      ...f.base,
      collectionId: original.collectionId,
      expectedRevision: original.revision,
    });
    const ready = await f.wait((p) => p.collections[0]?.state === 'ready');
    expect(ready.items).toHaveLength(1);
    expect(f.starts).toBe(1);
    expect(f.model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 20000);
test('partial delivery stays available and frozen missing file cannot become empty success on retry', async () => {
  const f = await fixture(
    'printf first > "$KITE_OUTPUT_DIR/a.txt"; printf second > "$KITE_OUTPUT_DIR/b.txt"',
    { beforeRef: 2 },
  );
  try {
    await f.run();
    const failed = await f.wait((p) => p.collections[0]?.state === 'failed');
    expect(failed.items).toHaveLength(1);
    const first = failed.items[0]!;
    await rm(join(f.roots[0]!, 'out/b.txt'));
    await writeFile(join(f.roots[0]!, 'out/new.txt'), 'unrelated');
    await f.runtime.retryOutputCollection({
      ...f.base,
      collectionId: failed.collections[0]!.collectionId,
      expectedRevision: failed.collections[0]!.revision,
    });
    const retried = await f.wait(
      (p) =>
        p.collections[0]?.state === 'failed' &&
        p.collections[0]?.revision !== failed.collections[0]!.revision,
    );
    expect(retried.items).toHaveLength(1);
    expect(retried.items[0]?.fileId).toBe(first.fileId);
    expect(retried.collections[0]?.expectedCount).toBe(2);
    expect(f.starts).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);

test('Fork inherits only immutable deliveries and keeps the exact original snapshot', async () => {
  const f = await fixture('printf original > "$KITE_OUTPUT_DIR/report.txt"');
  try {
    await f.run();
    const original = await f.wait((p) => p.collections[0]?.state === 'ready');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const session = await f.store.getSession('s');
    await f.runtime.forkSession({
      expectedStoreId: f.base.expectedStoreId,
      sourceSessionId: 's',
      expectedContextSelectionId: session!.contextSelectionId,
      newSessionId: 'fork',
      commandId: 'fork',
      subjectId: 'owner',
      title: 'fork',
    });
    const scope = { ...f.base, sessionId: 'fork' };
    const inherited = await f.runtime.queryOutputFiles(scope);
    expect(inherited.items).toHaveLength(1);
    expect(inherited.collections).toEqual([]);
    const record = await f.runtime.resolveOutputFile({ ...scope, target: inherited.items[0]! });
    expect(record.reference.id).toBe(
      (await f.runtime.resolveOutputFile({ ...f.base, target: original.items[0]! })).reference.id,
    );
    expect(record.reference.sessionId).toBe('s');
    expect(f.starts).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);

for (const cancelled of [false, true])
  test(`cold physical owner ${cancelled ? 'preserves explicit cancellation' : 'recovers exact pending collector without rerunning Shell'}`, async () => {
    const f = await fixture('printf durable > "$KITE_OUTPUT_DIR/report.txt"', { afterRef: 1 });
    let reopened: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    try {
      await f.run();
      const failed = await f.wait((p) => p.collections[0]?.state === 'failed');
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      await f.runtime.close();
      const db = new Database(join(f.profile.dataRoot, 'test/core.db'));
      const row = db
        .query<{ json: string }, [string]>('SELECT json FROM extension_record WHERE key=?')
        .get(failed.collections[0]!.collectionId)!;
      const collection = JSON.parse(row.json);
      collection.state = 'pending';
      collection.errorCode = null;
      db.run(
        'UPDATE extension_record SET json=? WHERE key=?',
        JSON.stringify(collection),
        collection.id,
      );
      db.run(
        "UPDATE execution SET state='running',cancel_requested=? WHERE id=?",
        cancelled ? 1 : 0,
        collection.collectorExecutionId,
      );
      db.close();
      reopened = await openSqliteStore(f.profile);
      const owner = await reopened.acquireSessionOwner('s', 'cold-owner');
      expect(owner).not.toBeNull();
      const recovered = await reopened.getOutputCollection({
        ...f.base,
        collectionId: collection.id,
      });
      expect(recovered?.state).toBe(cancelled ? 'failed' : 'pending');
      expect(recovered?.attempt).toBe(cancelled ? 1 : 2);
      expect((await reopened.getExecution(collection.source.producerExecutionId))?.status).toBe(
        'succeeded',
      );
      expect(f.starts).toBe(1);

      if (!cancelled)
        expect((await reopened.getCommand(recovered!.startCommandId!))?.status).toBe('accepted');
    } finally {
      await reopened?.close();
      await f.close();
    }
  }, 20000);

test('native directory scans enforce the remaining global entry budget and yield for cancellation', async () => {
  const f = await fixture('for i in {1..1100}; do mkdir "$KITE_OUTPUT_DIR/d$i"; done; exit 7');
  try {
    await f.run();
    const page = await f.wait((p) => p.collections[0]?.state === 'failed');
    const collection = (await f.store.getOutputCollection({
      ...f.base,
      collectionId: page.collections[0]!.collectionId,
    }))!;
    await expect(
      enumerateOutputFiles(collection, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'output_entry_limit' });
    for (let i = 1001; i <= 1100; i++)
      await rm(join(f.roots[0]!, 'out', `d${i}`), { recursive: true });
    expect(await enumerateOutputFiles(collection, new AbortController().signal)).toEqual([]);
    const nested = join(f.roots[0]!, 'out', 'd1', 'extra');
    await mkdir(nested);
    await expect(
      enumerateOutputFiles(collection, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'output_entry_limit' });
    await rm(nested, { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('fixture_cancelled')), 5);
    try {
      await expect(enumerateOutputFiles(collection, controller.signal)).rejects.toThrow(
        'fixture_cancelled',
      );
    } finally {
      clearTimeout(timer);
    }
    expect(await enumerateOutputFiles(collection, new AbortController().signal)).toEqual([]);
  } finally {
    await f.close();
  }
}, 20000);

test('read-only indexes cannot recover and wrong scope or locator cannot resolve a file', async () => {
  const f = await fixture('printf original > "$KITE_OUTPUT_DIR/report.txt"');
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await f.run();
    const page = await f.wait((p) => p.collections[0]?.state === 'ready');
    reader = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const before = await reader.getMetadata();
    expect((await reader.queryOutputFiles(f.base)).items).toHaveLength(1);
    expect((await reader.resolveOutputFile({ ...f.base, target: page.items[0]! })).name).toBe(
      'report.txt',
    );
    const denied = await reader
      .resolveOutputFile({ ...f.base, subjectId: 'stranger', target: page.items[0]! })
      .then(
        () => null,
        (error) => {
          return error;
        },
      );
    expect(denied?.code).toBe('output_scope_denied');
    const changed = await reader
      .resolveOutputFile({ ...f.base, target: { ...page.items[0]!, fileId: '0'.repeat(64) } })
      .then(
        () => null,
        (error) => error,
      );
    expect(changed?.code).toBe('output_target_invalid');
    expect((await reader.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
  } finally {
    await reader?.close();
    await f.close();
  }
}, 20000);

test('retry preserves saved bytes even when the already delivered source was deleted', async () => {
  const f = await fixture(
    'printf first > "$KITE_OUTPUT_DIR/a.txt"; printf second > "$KITE_OUTPUT_DIR/b.txt"',
    { beforeRef: 2 },
  );
  try {
    await f.run();
    const page = await f.wait((p) => p.collections[0]?.state === 'failed');
    const saved = page.items[0]!;
    await rm(join(f.roots[0]!, 'out/a.txt'));
    await f.runtime.retryOutputCollection({
      ...f.base,
      collectionId: page.collections[0]!.collectionId,
      expectedRevision: page.collections[0]!.revision,
    });
    const ready = await f.wait((p) => p.collections[0]?.state === 'ready');
    expect(ready.items).toHaveLength(2);
    expect(ready.items.some((item) => item.fileId === saved.fileId)).toBe(true);
    expect(f.starts).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);

for (const cancelStart of [false, true])
  test(`short Action ${cancelStart ? 'cancelled before dispatch' : 'failed before child creation'} settles collection`, async () => {
    const f = await fixture(
      'printf saved > "$KITE_OUTPUT_DIR/report.txt"',
      cancelStart ? { cancelStart: true } : { startFailed: true },
    );
    try {
      await f.run();
      const page = await f.wait((p) => p.collections[0]?.state === 'failed');
      expect(page.items).toEqual([]);
      expect(page.collections[0]?.errorCode).toBe(
        cancelStart ? 'output_collection_cancelled' : 'output_collection_start_failed',
      );
      const collection = await f.store.getOutputCollection({
        ...f.base,
        collectionId: page.collections[0]!.collectionId,
      });
      expect(collection?.collectorExecutionId).toBeNull();
      expect(f.starts).toBe(1);
    } finally {
      await f.close();
    }
  }, 20000);

test('one turn pages modern delivery plus more than fifty exact legacy snapshots', async () => {
  const f = await fixture('printf original > "$KITE_OUTPUT_DIR/report.txt"');
  try {
    await f.run();
    const page = await f.wait((p) => p.collections[0]?.state === 'ready');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const modern = await f.runtime.resolveOutputFile({ ...f.base, target: page.items[0]! });
    const db = new Database(join(f.profile.dataRoot, 'test/core.db'));
    // Runtime metadata transactions may still be finishing in the storage worker.
    db.run('PRAGMA busy_timeout = 5000');
    const original = db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM execution WHERE run_id=? AND kind='tool' LIMIT 1",
      )
      .get(modern.sourceRunId)!;
    const columns = Object.keys(original);
    for (let i = 0; i < 55; i++) {
      const id = `legacy-${String(i).padStart(3, '0')}`;
      const reference = {
        ...modern.reference,
        id: `legacy-ref-${id}`,
        scope: { kind: 'execution', id },
      };
      const result = {
        outcome: 'succeeded',
        content: 'saved',
        artifactRefs: [reference],
        details: { fileOutput: { snapshot: reference } },
      };
      const execution = {
        ...original,
        id,
        step_id: id,
        call_id: id,
        adapter_id: 'files.write',
        result_json: JSON.stringify(result),
      };
      db.query(
        `INSERT INTO execution(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      ).run(
        ...columns.map((c) => execution[c as keyof typeof execution] as string | number | null),
      );
      db.query(
        "INSERT INTO blob_ref(id,blob_hash,session_id,owner_kind,owner_id,subject_id,origin_store_id,media_type) VALUES(?,?,?,'execution',?,?,?,?)",
      ).run(
        reference.id,
        reference.hash,
        's',
        id,
        'owner',
        f.base.expectedStoreId,
        reference.mediaType,
      );
      db.query(
        "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES('builtin.files','session','s',?,1,'builtin.files.output',1,?,?)",
      ).run(
        `output-operation/${id}`,
        f.base.expectedStoreId,
        JSON.stringify({
          state: 'saved',
          executionId: id,
          name: `${id}.txt`,
          path: `outputs/${id}.txt`,
          snapshot: reference,
        }),
      );
    }
    db.close();
    let cursor: string | undefined;
    const ids = new Set<string>();
    let pages = 0;
    do {
      const current = await f.runtime.queryOutputFiles({
        ...f.base,
        runId: modern.sourceRunId,
        limit: 7,
        ...(cursor ? { beforeKey: cursor } : {}),
      });
      expect(current.items.length).toBeLessThanOrEqual(7);
      for (const item of current.items) {
        expect(ids.has(item.fileId)).toBe(false);
        ids.add(item.fileId);
        await f.runtime.resolveOutputFile({ ...f.base, target: item });
      }
      cursor = current.nextCursor;
      pages++;
      expect(pages).toBeLessThan(20);
    } while (cursor);
    expect(ids.size).toBe(56);
  } finally {
    await f.close();
  }
}, 20000);

test('empty allocations cannot hide failed collections and visible collection states page independently', async () => {
  const f = await fixture('printf original > "$KITE_OUTPUT_DIR/report.txt"');
  try {
    await f.run();
    const page = await f.wait((p) => p.collections[0]?.state === 'ready');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    const original = (await f.store.getOutputCollection({
      ...f.base,
      collectionId: page.collections[0]!.collectionId,
    }))!;
    const db = new Database(join(f.profile.dataRoot, 'test/core.db'));
    for (let i = 0; i < 111; i++) {
      const key = `${original.key}-${String(i).padStart(3, '0')}`;
      const visible = i < 51;
      const value = {
        ...original,
        id: key,
        key,
        state: visible ? 'failed' : 'allocated',
        errorCode: visible ? 'fixture_collection_failed' : null,
        expectedFiles: null,
        publishedCount: 0,
      };
      db.query(
        "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES('builtin.files','session','s',?,1,'builtin.files.collection',1,?,?)",
      ).run(key, f.base.expectedStoreId, JSON.stringify(value));
    }
    db.close();
    const first = await f.runtime.queryOutputFiles({ ...f.base, runId: original.source.runId });
    expect(first.collections).toHaveLength(50);
    expect(first.nextCollectionCursor).toBeDefined();
    const second = await f.runtime.queryOutputFiles({
      ...f.base,
      runId: original.source.runId,
      collectionBeforeKey: first.nextCollectionCursor!,
    });
    expect(second.collections).toHaveLength(2);
    expect(second.nextCollectionCursor).toBeUndefined();
    expect(
      new Set([...first.collections, ...second.collections].map((c) => c.collectionId)).size,
    ).toBe(52);
    expect(first.items).toHaveLength(1);
    expect(second.items[0]?.fileId).toBe(first.items[0]?.fileId);
  } finally {
    await f.close();
  }
}, 20000);

test('same name and same bytes in two turns remain distinct immutable deliveries', async () => {
  const f = await fixture('printf original > "$KITE_OUTPUT_DIR/report.txt"');
  try {
    await f.run();
    const first = await f.wait((p) => p.items.length === 1 && p.collections[0]?.state === 'ready');
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await f.run('second');
    const second = await f.wait(
      (p) => p.items.length === 2 && p.collections.every((c) => c.state === 'ready'),
    );
    expect(second.items[0]?.name).toBe(second.items[1]?.name);
    expect(second.items[0]?.fileId).not.toBe(second.items[1]?.fileId);
    expect(second.items[0]?.ownerRunId).not.toBe(first.items[0]?.ownerRunId);
    const old = await f.runtime.resolveOutputFile({ ...f.base, target: first.items[0]! });
    const newer = await f.runtime.resolveOutputFile({ ...f.base, target: second.items[0]! });
    expect(old.reference.hash).toBe(newer.reference.hash);
    expect(old.reference.id).not.toBe(newer.reference.id);
    expect(f.starts).toBe(2);
    expect(f.model.requests).toHaveLength(4);
  } finally {
    await f.close();
  }
}, 20000);

test('collector refusal before adapter becomes visible failure with no retry and finite safe retention', async () => {
  const f = await fixture('printf retained > "$KITE_OUTPUT_DIR/report.txt"', {
    denyCollector: true,
  });
  try {
    await f.run();
    const page = await f.wait((p) => p.collections[0]?.state === 'failed');
    expect(page.items).toEqual([]);
    expect(page.collections[0]).toMatchObject({
      state: 'failed',
      errorCode: 'output_collection_permission_denied',
      expectedCount: null,
      publishedCount: 0,
    });
    expect(page.collections[0]?.retryUntil).toBeUndefined();
    const c = (await f.store.getOutputCollection({
      ...f.base,
      collectionId: page.collections[0]!.collectionId,
    }))!;
    const denied = await f.store.getExecution(c.collectorExecutionId!);
    expect(denied?.result).toMatchObject({
      outcome: 'failed',
      details: { code: 'permission_denied', adapterAttempted: false },
    });
    expect(c.attempt).toBe(1);
    expect(c.cleanupAfter).toBeDefined();
    const rejection = await f.runtime
      .retryOutputCollection({ ...f.base, collectionId: c.id, expectedRevision: c.revision })
      .then(
        () => null,
        (e) => e,
      );
    expect(rejection).toMatchObject({ code: 'output_retry_unavailable' });
    await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
    await f.runtime.close();
    const db = new Database(join(f.profile.dataRoot, 'test/core.db'));
    try {
      const expires = Date.parse(c.cleanupAfter!);
      await collectOutputStaging(db, f.root, expires - 1);
      expect(await readFile(join(f.roots[0]!, 'out/report.txt'), 'utf8')).toBe('retained');
      db.run("UPDATE execution SET state='outcome_unknown' WHERE id=?", [c.collectorExecutionId!]);
      await collectOutputStaging(db, f.root, expires + 1);
      expect(await readFile(join(f.roots[0]!, 'out/report.txt'), 'utf8')).toBe('retained');
      db.run("UPDATE execution SET state='failed' WHERE id=?", [c.collectorExecutionId!]);
      db.run("UPDATE execution SET state='outcome_unknown' WHERE id=?", [
        c.source.producerExecutionId,
      ]);
      await collectOutputStaging(db, f.root, expires + 1);
      expect(await readFile(join(f.roots[0]!, 'out/report.txt'), 'utf8')).toBe('retained');
      db.run("UPDATE execution SET state='succeeded' WHERE id=?", [c.source.producerExecutionId]);
      await collectOutputStaging(db, f.root, expires + 1);
      await expect(readFile(join(f.roots[0]!, 'out/report.txt'))).rejects.toThrow();
    } finally {
      db.close();
    }
    expect(f.starts).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);

for (const newerAttempt of [false, true])
  test(`cold owner ${newerAttempt ? 'does not let an old refusal settle a newer attempt' : 'settles old hidden pre-adapter refusal without replay or rewriting history'}`, async () => {
    const f = await fixture('printf retained > "$KITE_OUTPUT_DIR/report.txt"', {
      denyCollector: true,
    });
    let reopened: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    try {
      await f.run();
      const page = await f.wait((p) => p.collections[0]?.state === 'failed');
      const c = (await f.store.getOutputCollection({
        ...f.base,
        collectionId: page.collections[0]!.collectionId,
      }))!;
      const denied = (await f.store.getExecution(c.collectorExecutionId!))!;
      await f.runtime.waitForCommand('work', { timeoutMs: 5000 });
      await f.runtime.close();
      const db = new Database(join(f.profile.dataRoot, 'test/core.db'));
      // Reproduce only the historical collection bug. The denied Execution and
      // its original immutable result are never rewritten by recovery.
      const pending = {
        ...c,
        state: 'pending',
        collectorExecutionId: null,
        errorCode: null,
        errors: [],
        cleanupAfter: undefined,
      };
      if (newerAttempt) {
        pending.attempt++;
        pending.startCommandId = `output-collect-${createHash('sha256')
          .update(JSON.stringify([c.source.storeId, c.id, pending.attempt]))
          .digest('hex')}`;
      }
      const beforeCount = db.query<{ n: number }, []>('SELECT count(*) AS n FROM command').get()!.n;
      db.run('UPDATE extension_record SET json=? WHERE key=?', [JSON.stringify(pending), c.id]);
      db.close();
      reopened = await openSqliteStore(f.profile);
      const owner = await reopened.acquireSessionOwner('s', 'cold-denied-owner');
      expect(owner).not.toBeNull();
      const recovered = (await reopened.getOutputCollection({ ...f.base, collectionId: c.id }))!;
      expect(recovered.state).toBe(newerAttempt ? 'pending' : 'failed');
      expect(recovered.attempt).toBe(newerAttempt ? 2 : 1);
      expect(recovered.startCommandId).toBe(pending.startCommandId);
      expect(recovered.retryUntil).toBeNull();
      expect(await reopened.getExecution(denied.id)).toEqual(denied);
      expect(f.starts).toBe(1);
      const reader = new Database(join(f.profile.dataRoot, 'test/core.db'), { readonly: true });
      expect(reader.query<{ n: number }, []>('SELECT count(*) AS n FROM command').get()!.n).toBe(
        beforeCount,
      );
      reader.close();
      if (!newerAttempt) {
        expect((await reopened.queryOutputFiles(f.base)).collections[0]?.errorCode).toBe(
          'output_collection_permission_denied',
        );
        expect(recovered.cleanupAfter).toBeDefined();
      }
    } finally {
      await reopened?.close();
      await f.close();
    }
  }, 20000);

test('refusal on a later collection attempt keeps already delivered files visible', async () => {
  const f = await fixture(
    'printf first > "$KITE_OUTPUT_DIR/a.txt"; printf second > "$KITE_OUTPUT_DIR/b.txt"',
    {
      beforeRef: 2,
      denyAfterAttempt: 1,
    },
  );
  try {
    await f.run();
    const partial = await f.wait((p) => p.collections[0]?.state === 'failed');
    expect(partial.items).toHaveLength(1);
    await f.runtime.retryOutputCollection({
      ...f.base,
      collectionId: partial.collections[0]!.collectionId,
      expectedRevision: partial.collections[0]!.revision,
    });
    const denied = await f.wait(
      (p) => p.collections[0]?.errorCode === 'output_collection_permission_denied',
    );
    expect(denied.items).toEqual(partial.items);
    expect(denied.collections[0]).toMatchObject({
      state: 'failed',
      publishedCount: 1,
      expectedCount: 2,
    });
    expect(denied.collections[0]?.retryUntil).toBeUndefined();
    const record = await f.runtime.resolveOutputFile({ ...f.base, target: denied.items[0]! });
    const original = await f.runtime.readArtifact({
      ...f.base,
      refId: record.reference.id,
      scope: record.reference.scope,
    });
    expect(new TextDecoder().decode(original.content)).toBe('first');
    expect(f.starts).toBe(1);
  } finally {
    await f.close();
  }
}, 20000);

test('serial same-path deliveries project the latest complete successor without deleting history', async () => {
  const f = await fixture([
    'printf original > "$KITE_OUTPUT_DIR/report.txt"; mkdir "$KITE_OUTPUT_DIR/sub"; printf nested > "$KITE_OUTPUT_DIR/sub/report.txt"',
    'printf corrected > "$KITE_OUTPUT_DIR/report.txt"',
    'printf final > "$KITE_OUTPUT_DIR/report.txt"',
  ]);
  try {
    await f.run();
    await f.runtime.waitForCommand('work', { timeoutMs: 10000 });
    await f.wait(
      (p) => p.collections.length === 3 && p.collections.every((c) => c.state === 'ready'),
    );
    const db = new Database(join(f.profile.dataRoot, 'test/core.db'));
    db.run('PRAGMA busy_timeout = 5000');
    try {
      const rows = db
        .query<{ key: string; json: string }, []>(
          "SELECT key,json FROM extension_record WHERE key LIKE 'delivery/%'",
        )
        .all();
      const records = rows.map((r) => ({ ...JSON.parse(r.json), key: r.key }));
      const plain = records.filter((r) => r.relativePath === 'report.txt');
      const order = (id: string) =>
        db
          .query<{ completed_cursor: number }, [string]>(
            'SELECT completed_cursor FROM execution WHERE id=?',
          )
          .get(id)!.completed_cursor;
      plain.sort((a, b) => order(a.sourceExecutionId) - order(b.sourceExecutionId));
      const [old, middle, latest] = plain;
      const ids = async () => (await f.page()).items.map((i) => i.fileId);
      expect(await ids()).toContain(latest.fileId);
      expect(await ids()).not.toContain(old.fileId);
      expect((await ids()).length).toBe(2); // Same basename in another directory stays independent.
      const oldTarget = {
        storeId: f.base.expectedStoreId,
        sessionId: 's',
        fileId: old.fileId,
        locator: { kind: 'delivery' as const, key: old.key },
      };
      expect(
        (await f.runtime.resolveOutputFile({ ...f.base, target: oldTarget })).reference.hash,
      ).toBe(old.reference.hash);
      // A turn is a Run, not an individual model call: do not fold its live outputs.
      for (const state of [
        'running',
        'waiting_interaction',
        'waiting_execution',
        'cancelling',
        'interrupted',
      ]) {
        db.query('UPDATE run SET status=?,is_active=1 WHERE id=?').run(state, old.sourceRunId);
        expect((await ids()).length).toBe(4);
      }
      db.query("UPDATE run SET status='interrupted',is_active=0 WHERE id=?").run(old.sourceRunId);
      expect((await ids()).length).toBe(4);
      for (const state of ['completed', 'failed', 'cancelled']) {
        db.query('UPDATE run SET status=?,is_active=0 WHERE id=?').run(state, old.sourceRunId);
        expect((await ids()).length).toBe(2);
      }
      db.query("UPDATE run SET status='completed',is_active=0 WHERE id=?").run(old.sourceRunId);
      // A delayed old collector timestamp cannot replace the causally later producer.
      db.query(
        "UPDATE extension_record SET json=json_set(json,'$.publishedAt','2999-01-01T00:00:00Z') WHERE key=?",
      ).run(old.key);
      expect(await ids()).not.toContain(old.fileId);
      // Incomplete / failed collection and unknown producer cannot suppress a known output.
      for (const state of ['pending', 'failed']) {
        db.query("UPDATE extension_record SET json=json_set(json,'$.state',?) WHERE key=?").run(
          state,
          latest.collectionId,
        );
        expect(await ids()).toContain(middle.fileId);
      }
      db.query("UPDATE extension_record SET json=json_set(json,'$.state','ready') WHERE key=?").run(
        latest.collectionId,
      );
      db.query("UPDATE execution SET state='outcome_unknown' WHERE id=?").run(
        latest.sourceExecutionId,
      );
      expect(await ids()).toContain(middle.fileId);
      db.query("UPDATE execution SET state='succeeded' WHERE id=?").run(latest.sourceExecutionId);
      // Counterexample: overlapping producers lack causal succession, despite ordered plans.
      const completed = order(old.sourceExecutionId);
      db.query('UPDATE execution SET completed_cursor=? WHERE id=?').run(
        order(latest.sourceExecutionId) + 1,
        old.sourceExecutionId,
      );
      expect(await ids()).toContain(old.fileId);
      expect(await ids()).toContain(latest.fileId);
      db.query('UPDATE execution SET completed_cursor=? WHERE id=?').run(
        completed,
        old.sourceExecutionId,
      );
      // Partial order A -> B and A -> C, but B overlaps C: only A is replaced.
      const middleCompleted = order(middle.sourceExecutionId);
      db.query('UPDATE execution SET completed_cursor=? WHERE id=?').run(
        order(latest.sourceExecutionId) + 1,
        middle.sourceExecutionId,
      );
      expect(await ids()).not.toContain(old.fileId);
      expect(await ids()).toContain(middle.fileId);
      expect(await ids()).toContain(latest.fileId);
      db.query('UPDATE execution SET completed_cursor=? WHERE id=?').run(
        middleCompleted,
        middle.sourceExecutionId,
      );
      // Missing historical completion evidence is not permission to guess a replacement.
      db.query('UPDATE execution SET completed_cursor=NULL WHERE id=?').run(old.sourceExecutionId);
      expect(await ids()).toContain(old.fileId);
      db.query('UPDATE execution SET completed_cursor=? WHERE id=?').run(
        completed,
        old.sourceExecutionId,
      );
      // Winner filtering precedes pagination, so older pages cannot resurrect the old card.
      let cursor: string | undefined;
      const paged: string[] = [];
      do {
        const page = await f.runtime.queryOutputFiles({
          ...f.base,
          limit: 1,
          ...(cursor ? { beforeKey: cursor } : {}),
        });
        paged.push(...page.items.map((i) => i.fileId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paged).not.toContain(old.fileId);
      expect(new Set(paged).size).toBe(2);
    } finally {
      db.close();
    }
    await f.run('work-next');
    await f.runtime.waitForCommand('work-next', { timeoutMs: 10000 });
    const otherRun = await f.wait(
      (p) => p.collections.length === 6 && p.collections.every((c) => c.state === 'ready'),
    );
    expect(otherRun.items.length).toBe(4);
    expect(new Set(otherRun.items.map((i) => i.ownerRunId)).size).toBe(2);
  } finally {
    await f.close();
  }
}, 30000);
