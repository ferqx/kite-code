import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension, RecordDefinition, ToolContext } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(
  options: { large?: boolean; rejectUnknown?: boolean; barrier?: ReturnType<typeof gate> } = {},
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-fork-lifecycle-'))),
    profile = { dataRoot: join(directory, 'data'), profile: 'test' },
    store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId,
    artifacts = createArtifactStore({ profile, store });
  const entered = gate();
  let calls = 0,
    rebuilds = 0,
    starts = 0;
  const refused: string[] = [];
  const body = options.large ? `original-${'a'.repeat(17 * 1024 * 1024)}` : 'original complete';
  const definitions: RecordDefinition[] = [
    {
      contentType: 'fixture.copy',
      contentVersion: 1,
      schema: { type: 'object' },
      fork: {
        mode: 'copy',
        version: 'copy-1',
        onUnsupported: options.rejectUnknown ? 'reject' : 'omit',
      },
    },
    {
      contentType: 'fixture.rebuild',
      contentVersion: 1,
      schema: { type: 'object' },
      fork: {
        mode: 'rebuild',
        version: 'rebuild-1',
        async prepare(input) {
          rebuilds++;
          entered.release();
          if (options.barrier) await options.barrier.promise;
          return [
            {
              key: 'derived',
              contentType: 'fixture.rebuild',
              contentVersion: 1,
              value: {
                selected: input.selectedMessages.map((m) => m.id),
                upper: input.boundary.upperSeq,
                from: input.records.map((r) => r.key),
              },
            },
          ];
        },
      },
    },
    { contentType: 'fixture.omit', contentVersion: 1, schema: { type: 'object' } },
  ];
  const seed = async (ctx: ToolContext) => {
    await ctx.records.write({
      key: 'copy',
      expectedRevision: null,
      contentType: 'fixture.copy',
      contentVersion: 1,
      value: { original: true },
      executable: true,
    });
    await ctx.records.write({
      key: 'rebuild',
      expectedRevision: null,
      contentType: 'fixture.rebuild',
      contentVersion: 1,
      value: { actual: true },
    });
    await ctx.records.write({
      key: 'omit',
      expectedRevision: null,
      contentType: 'fixture.omit',
      contentVersion: 1,
      value: { privateBusiness: 'retained original' },
    });
  };
  const extension: Extension = {
    id: 'fixture',
    version: 'extension-1',
    apiMajor: 1,
    records: definitions,
    tools: [
      {
        id: 'fixture.seed',
        version: '1',
        description: 'actual source records',
        inputSchema: { type: 'object' },
        async execute(_input, ctx) {
          if (ctx.sessionId === 's') await seed(ctx);
          else {
            const copy = await ctx.records.get('copy');
            await ctx.records.write({
              key: 'copy',
              expectedRevision: copy!.revision,
              contentType: 'fixture.copy',
              contentVersion: 1,
              value: { edited: true },
              executable: true,
            });
            try {
              await ctx.requirements!.register([
                {
                  recordKey: 'copy',
                  requirementId: 'copied-plan',
                  definitionVersion: '1',
                  revision: '2',
                  phase: 'completion',
                },
              ]);
            } catch (error) {
              refused.push((error as { code: string }).code);
            }
            try {
              await ctx.operations.ensure({
                key: 'cannot-run-copy',
                planRecordKey: 'copy',
                request: {
                  kind: 'job',
                  definitionId: 'fixture.job',
                  definitionVersion: '1',
                  input: {},
                },
              });
            } catch (error) {
              refused.push((error as { code: string }).code);
            }
          }
          return { outcome: 'succeeded', content: 'actual record work' };
        },
      },
    ],
    jobs: [
      {
        id: 'fixture.job',
        version: '1',
        description: 'must not start from copied plan',
        inputSchema: { type: 'object' },
        async start() {
          starts++;
          return { reference: { actual: true } };
        },
        async *observe() {
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: { outcome: 'succeeded', content: 'not expected' },
          };
        },
        async cancel() {
          return { status: 'stopped' };
        },
        async dispose() {},
      },
    ],
  };
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      if (calls % 2 === 1) {
        yield { type: 'tool_call', id: `call-${calls}`, name: 'fixture.seed', arguments: '{}' };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: body };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'fixed',
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'private',
    rootUri: `file://${directory}`,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'source',
  });
  await runtime.submitCommand({
    expectedStoreId: storeId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'original input' },
  });
  await runtime.waitForCommand('work', { timeoutMs: 20000 });
  const view = await store.getView('s');
  return {
    directory,
    profile,
    store,
    storeId,
    runtime,
    definitions,
    view,
    body,
    refused,
    entered,
    counts: () => ({ calls, rebuilds, starts }),
    input: {
      expectedStoreId: storeId,
      sourceSessionId: 's',
      expectedContextSelectionId: view.session.contextSelectionId,
      newSessionId: 'fork',
      commandId: 'fork-command',
      subjectId: 'owner',
      title: 'branch',
    },
    async close() {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('explicit copy preserves original origin/raw value; bounded pure rebuild uses selected boundary; neither grants copied executable authority', async () => {
  const f = await fixture();
  try {
    const boundary = f.view.messages.find((m) => m.role === 'user')!;
    const fork = await f.runtime.forkSession({
      ...f.input,
      boundary: { messageId: boundary.id, seq: boundary.seq },
    });
    expect(fork.omittedExtensionState).toBe(true);
    expect(fork.namespaceReport!.find((r) => r.mode === 'copy')!.copied).toBe(1);
    expect(fork.namespaceReport!.find((r) => r.mode === 'rebuild')!.rebuilt).toBe(1);
    const copy = await f.store.getExtensionRecord({
        extensionId: 'fixture',
        sessionId: 'fork',
        key: 'copy',
      }),
      derived = await f.store.getExtensionRecord({
        extensionId: 'fixture',
        sessionId: 'fork',
        key: 'derived',
      });
    expect(copy!.originStoreId).toBe(f.storeId);
    expect(copy!.value).toEqual({ original: true });
    expect(copy!.forkProvenance).toMatchObject({
      kind: 'fork_record',
      mode: 'copy',
      sourceSessionId: 's',
      sourceUpperSeq: boundary.seq,
      ruleVersion: 'copy-1',
    });
    expect(derived!.originStoreId).toBeNull();
    expect(derived!.value).toEqual({
      selected: [boundary.id],
      upper: boundary.seq,
      from: ['rebuild'],
    });
    expect(derived!.forkProvenance).toMatchObject({ mode: 'rebuild', commandId: 'fork-command' });
    const exportScope = { expectedStoreId: f.storeId, sessionId: 'fork', subjectId: 'owner' };
    const manifest = await f.store.beginSessionExport(exportScope);
    const exported = await f.store.readSessionExportPage({
      ...exportScope,
      manifest,
      section: 'extension_records',
    });
    expect(
      JSON.parse(
        (exported.records.find((r) => r.id === 'copy')!.record as { fork_provenance_json: string })
          .fork_provenance_json,
      ),
    ).toEqual(copy!.forkProvenance);
    expect((await f.store.verifySessionExport({ ...exportScope, manifest })).verified).toBe(true);
    expect(
      await f.store.getExtensionRecord({ extensionId: 'fixture', sessionId: 'fork', key: 'omit' }),
    ).toBeNull();
    const before = f.counts();
    const retry = await f.runtime.forkSession({
      ...f.input,
      boundary: { messageId: boundary.id, seq: boundary.seq },
    });
    expect(retry.namespaceReport).toEqual(fork.namespaceReport);
    expect(f.counts()).toEqual(before);
    await f.runtime.submitCommand({
      expectedStoreId: f.storeId,
      sessionId: 'fork',
      commandId: 'new-work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'explicit fresh work' },
    });
    await f.runtime.waitForCommand('new-work', { timeoutMs: 10000 });
    expect(f.refused).toEqual(['record_revision_conflict', 'operation_unverifiable']);
    expect(f.counts().starts).toBe(0);
    expect(
      (await f.store.getExtensionRecord({
        extensionId: 'fixture',
        sessionId: 'fork',
        key: 'copy',
      }))!.forkProvenance,
    ).toEqual(copy!.forkProvenance);
  } finally {
    await f.close();
  }
}, 20000);

test('registration snapshot cannot be replaced by caller edits; source/CAS or trigger conflict rolls the entire Fork back', async () => {
  const barrier = gate(),
    f = await fixture({ barrier });
  try {
    const work = f.runtime.forkSession(f.input);
    await f.entered.promise;
    const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      physical.run(
        "UPDATE extension_record SET json='{\"race\":true}',revision=revision+1 WHERE key='copy'",
      );
    } finally {
      physical.close();
    }
    Object.assign(f.definitions[1]!, { fork: { mode: 'omit' } });
    Object.assign(f.definitions[0]!.schema, { type: 'boolean' });
    barrier.release();
    expect((await work.catch((error) => error)).code).toBe('fork_namespace_changed');
    expect(await f.store.getSession('fork')).toBeNull();
    expect(await f.store.getCommand('fork-command')).toBeNull();
    const trigger = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      trigger.run(
        "CREATE TRIGGER fail_copy BEFORE INSERT ON extension_record WHEN NEW.scope_id='fork' BEGIN SELECT RAISE(ABORT,'atomic copy rollback'); END",
      );
      expect((await f.runtime.forkSession(f.input).catch((error) => error)).code).toBe(
        'SQLITE_CONSTRAINT_TRIGGER',
      );
      expect(await f.store.getSession('fork')).toBeNull();
      expect(await f.store.getCommand('fork-command')).toBeNull();
      trigger.run('DROP TRIGGER fail_copy');
    } finally {
      trigger.close();
    }
    const fork = await f.runtime.forkSession(f.input);
    expect(fork.namespaceReport!.find((r) => r.mode === 'rebuild')!.ruleVersion).toBe('rebuild-1');
    expect(f.counts().calls).toBe(2);
  } finally {
    barrier.release();
    await f.close();
  }
}, 20000);

test('future content is preserved in source and safely omitted; exact unsupported known version may reject with zero Session', async () => {
  const f = await fixture({ rejectUnknown: true });
  try {
    const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      physical.run(
        "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES('fixture','session','s','future',1,'fixture.copy',900,'original-store','{ invalid future raw')",
      );
      physical.run("UPDATE extension_record SET json='false' WHERE key='copy'");
    } finally {
      physical.close();
    }
    expect((await f.runtime.forkSession(f.input).catch((error) => error)).code).toBe(
      'fork_record_unsupported',
    );
    expect(await f.store.getSession('fork')).toBeNull();
    const restore = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      restore.run("UPDATE extension_record SET json='{\"restored\":true}' WHERE key='copy'");
    } finally {
      restore.close();
    }
    const fork = await f.runtime.forkSession(f.input);
    expect(fork.namespaceReport!.find((r) => r.contentVersion === 900)!.omitted).toBe(1);
    expect(
      await f.store.getExtensionRecord({
        extensionId: 'fixture',
        sessionId: 'fork',
        key: 'future',
      }),
    ).toBeNull();
    expect(f.counts().calls).toBe(2);
    await f.runtime.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      const manifest = await cold.beginSessionExport({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
      });
      const page = await cold.readSessionExportPage({
        expectedStoreId: f.storeId,
        sessionId: 's',
        subjectId: 'owner',
        manifest,
        section: 'extension_records',
      });
      expect((page.records.find((r) => r.id === 'future')!.record as { json: string }).json).toBe(
        '{ invalid future raw',
      );
      expect(
        (await cold.getExtensionRecord({ extensionId: 'fixture', sessionId: 'fork', key: 'copy' }))!
          .forkProvenance,
      ).toMatchObject({ mode: 'copy' });
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
}, 20000);

test('copy/rebuild does not remap full 17MiB original Model media or replay it on cold reads', async () => {
  const f = await fixture({ large: true });
  try {
    await f.runtime.forkSession(f.input);
    const view = await f.store.getView('fork');
    const copied = view.messages.find((m) => m.modelOutput)!;
    const origin = await f.runtime.getMessageOrigin({
      expectedStoreId: f.storeId,
      sessionId: 'fork',
      subjectId: 'owner',
      messageId: copied.id,
    });
    expect(origin.message.sessionId).toBe('s');
    const original = f.view.executions.find(
      (e) =>
        e.kind === 'model' &&
        e.result &&
        typeof e.result === 'object' &&
        !Array.isArray(e.result) &&
        e.result.modelOutput,
    )!;
    const output = await f.runtime.readModelOutput({
      expectedStoreId: f.storeId,
      sessionId: 's',
      subjectId: 'owner',
      executionId: original.id,
    });
    expect(output.output.content).toBe(f.body);
    expect(f.counts().calls).toBe(2);
    await f.runtime.close();
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect(
        (await cold.getExtensionRecord({ extensionId: 'fixture', sessionId: 'fork', key: 'copy' }))!
          .originStoreId,
      ).toBe(f.storeId);
      expect((await cold.getView('fork')).messages.length).toBe(4);
    } finally {
      await cold.close();
    }
    expect(f.counts().calls).toBe(2);
  } finally {
    await f.close();
  }
}, 30000);

test('renderer cannot supply an internal namespace plan; conflicting lifecycle registration is rejected before any new Model', async () => {
  const f = await fixture();
  try {
    const forged = { ...f.input, namespacePlan: { snapshotCursor: '0' } };
    expect((await f.runtime.forkSession(forged).catch((error) => error)).code).toBe('invalid_fork');
    expect(await f.store.getSession('fork')).toBeNull();
    let providerCalls = 0;
    const model: ModelAdapter = {
      async *stream() {
        providerCalls++;
        yield finish;
      },
    };
    const duplicate = [
      {
        contentType: 'duplicate',
        contentVersion: 1,
        schema: { type: 'object' },
        fork: { mode: 'copy' as const, version: '1' },
      },
      { contentType: 'duplicate', contentVersion: 1, schema: { type: 'object' } },
    ];
    let code: string | undefined;
    try {
      createRuntime({
        store: f.store,
        model,
        modelId: 'never',
        permissions: {
          async authorize() {
            return { allowed: true, revision: '1' };
          },
        },
        extensions: [{ id: 'duplicate', version: '1', apiMajor: 1, records: duplicate }],
      });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe('fork_rule_conflict');
    expect(providerCalls).toBe(0);
    expect(f.counts().calls).toBe(2);
  } finally {
    await f.close();
  }
});
