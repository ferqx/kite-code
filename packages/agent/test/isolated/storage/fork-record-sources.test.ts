import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import type { Extension, ReadContext } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { DispatchInput } from '../../../src/storage/port';
import { dispatchRecordRead } from '../../../src/storage/sqlite/dispatch-read-set';
import type { ForkRecordSources, Json } from '../../../src/storage/types';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (e) {
    return (e as { code: string }).code;
  }
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function fixture(
  count = 1,
  wait?: { entered: ReturnType<typeof gate>; proceed: ReturnType<typeof gate> },
  namespace = false,
) {
  const root = mkdtempSync('/private/tmp/kite-fork-record-sources-'),
    profile = { dataRoot: join(root, 'profile'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  let calls = 0,
    effects = 0,
    saved: ReadContext | undefined,
    observed: ForkRecordSources | undefined,
    executed: ReadContext | undefined;
  const anchor = namespace ? 'bundle' : 'note-0';
  const namespaceSnapshots: string[][] = [];
  const rebuild = {
    mode: 'rebuild' as const,
    version: '1',
    sourceScope: 'namespace' as const,
    onUnsupported: 'reject' as const,
    async prepare(input: import('../../../src/extensions/fork').ForkRecordInput) {
      expect(Object.isFrozen(input.namespaceRecords)).toBe(true);
      expect(input.records.every((r) => r.contentType === input.records[0]!.contentType)).toBe(
        true,
      );
      namespaceSnapshots.push(input.namespaceRecords!.map((r) => `${r.extensionId}/${r.key}`));
      return [
        {
          key: 'bundle',
          contentType: 'fixture.snapshot',
          contentVersion: 1,
          value: { keys: input.namespaceRecords!.map((r) => r.key) },
        },
      ];
    },
  };
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    records: [
      {
        contentType: 'fixture.history',
        contentVersion: 1,
        schema: { type: 'object' },
        fork: namespace ? rebuild : { mode: 'copy', version: '1' },
      },
      ...(namespace
        ? [
            {
              contentType: 'fixture.head',
              contentVersion: 1,
              schema: { type: 'object' },
              fork: { mode: 'omit' as const },
            },
            {
              contentType: 'fixture.snapshot',
              contentVersion: 1,
              schema: { type: 'object' },
              fork: rebuild,
            },
          ]
        : []),
    ],
    tools: [
      {
        id: 'seed',
        version: '1',
        description: 'Actual immutable fixture records',
        inputSchema: { type: 'object' },
        async execute(_input, ctx) {
          for (let n = 0; n < count; n++)
            await ctx.records.write({
              key: `note-${n}`,
              expectedRevision: null,
              contentType: 'fixture.history',
              contentVersion: 1,
              value: { original: n },
            });
          if (namespace)
            await ctx.records.write({
              key: 'head',
              expectedRevision: null,
              contentType: 'fixture.head',
              contentVersion: 1,
              value: { head: true },
            });
          return { outcome: 'succeeded', content: 'saved actual originals' };
        },
      },
    ],
    actions: [
      {
        id: 'effect',
        version: '1',
        description: 'Observe exact fork history before an effect',
        inputSchema: { type: 'object', additionalProperties: false },
        async prepare(_input, ctx) {
          saved = ctx;
          observed = await ctx.readForkRecordSources!(anchor);
          return { count: observed.records.length };
        },
        async execute(_prepared, context) {
          executed = context;
          await context.readForkRecordSources!(anchor);
          effects++;
          return { outcome: 'succeeded', content: 'effect' };
        },
      },
    ],
    queries: [
      {
        id: 'history',
        version: '1',
        description: 'Pure history',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'array' },
        async execute(_input, ctx) {
          saved = ctx;
          observed = await ctx.readForkRecordSources!(anchor);
          return [];
        },
      },
    ],
  };
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      if (calls === 1) {
        yield { type: 'tool_call', id: 'seed-call', name: 'seed', arguments: '{}' };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'original done' };
        yield finish;
      }
    },
  };
  const runtime = createRuntime({
    store,
    model,
    extensions: [extension],
    permissions: {
      async authorize(request) {
        if (wait && request.definitionId === 'fixture/effect') {
          wait.entered.release();
          await wait.proceed.promise;
        }
        return { allowed: true, revision: '1' };
      },
    },
  });
  const base = { expectedStoreId: storeId, subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'fixture',
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'original',
  });
  await runtime.submitCommand({
    ...base,
    commandId: 'work',
    sessionId: 's',
    request: { kind: 'run.start', content: 'actual original user' },
  });
  await runtime.waitForCommand('work', { timeoutMs: 5000 });
  const fork = async (sourceSessionId: string, newSessionId: string, empty = false) =>
    runtime.forkSession({
      ...base,
      commandId: `fork-${newSessionId}`,
      sourceSessionId,
      expectedContextSelectionId: (await store.getSession(sourceSessionId))!.contextSelectionId,
      newSessionId,
      title: newSessionId,
      ...(empty ? { boundary: null } : {}),
    });
  await fork('s', 'f1');
  await fork('f1', 'f2');
  const physical = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
  const read = (
    sessionId = 'f2',
    extensionId = 'fixture',
    subjectId = 'owner',
    localKey = anchor,
  ) =>
    store.readForkRecordSources({
      expectedStoreId: storeId,
      sessionId,
      extensionId,
      subjectId,
      localKey,
    });
  const plan = async () => {
    const proof = await read(),
      records = proof.records.map((r) => dispatchRecordRead(r.extensionId, r.sessionId, r.key, r)),
      owner = (await store.acquireSessionOwner('f2', 'test-owner'))!;
    await store.acceptCommand({
      ...base,
      commandId: 'action',
      sessionId: 'f2',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'effect',
        definitionVersion: '1',
        input: {},
      },
    });
    const source: Json = {
      kind: 'action_decision',
      commandId: 'action',
      extensionId: 'fixture',
      actionId: 'effect',
      definitionVersion: '1',
      preparedDigest: await semanticDigest({}),
      recordReads: records as unknown as Json,
      recordListReads: [],
      forkBindings: [proof.binding] as unknown as Json,
    };
    await store.planAction({
      expectedStoreId: storeId,
      owner,
      commandId: 'action',
      executionId: 'effect-execution',
      extensionId: 'fixture',
      definitionId: 'fixture/effect',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    const dispatch: DispatchInput = {
      expectedStoreId: storeId,
      owner,
      executionId: 'effect-execution',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source },
      readSet: { records, recordLists: [], forkBindings: [proof.binding] },
    };
    return { dispatch, proof };
  };
  return {
    store,
    runtime,
    physical,
    storeId,
    base,
    read,
    fork,
    plan,
    query: () =>
      runtime.queryExtension({
        ...base,
        sessionId: 'f2',
        extensionId: 'fixture',
        queryId: 'history',
        input: {},
      }),
    counts: () => ({ calls, effects }),
    namespaceSnapshots,
    observed: () => observed!,
    saved: () => saved!,
    executed: () => executed!,
    async close() {
      physical.close();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('actual two-layer Fork exposes only provenance-derived original identities; cold query closes reader and does no business writes', async () => {
  const f = await fixture();
  try {
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const proof = await f.read();
    expect(proof.records.map((r) => r.sessionId)).toEqual(['f2', 'f1', 's']);
    expect(proof.records.map((r) => r.key)).toEqual(['note-0', 'note-0', 'note-0']);
    expect(Object.keys(proof.binding).sort()).toEqual(['digest', 'localKey', 'version']);
    expect(await f.query()).toEqual([]);
    expect(f.observed()).toEqual(proof);
    expect(await code(f.saved().readForkRecordSources!('note-0'))).toBe(
      'dispatch_read_context_closed',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.counts()).toEqual({ calls: 2, effects: 0 });
    const p = await f.plan();
    expect(await code(f.store.markDispatching(p.dispatch))).toBe('success');
    expect((await f.store.getExecution('effect-execution'))!.status).toBe('dispatching');
  } finally {
    await f.close();
  }
});

test('actual null/zero Fork boundary needs no invented Message and cannot grant a foreign namespace or subject', async () => {
  const f = await fixture();
  try {
    const empty = await f.fork('s', 'empty', true);
    expect(empty.selection.ranges).toEqual([]);
    expect((empty.command.receipt as { sourceUpperSeq: string }).sourceUpperSeq).toBe('0');
    expect((await f.read('empty')).records.map((r) => r.sessionId)).toEqual(['empty', 's']);
    expect(await code(f.read('f2', 'foreign'))).toBe('fork_record_source_unverifiable');
    expect(await code(f.read('f2', 'fixture', 'foreign'))).toBe('fork_record_source_unverifiable');
    expect(await code(f.read('s'))).toBe('fork_record_source_unverifiable');
    expect(await code(f.read('f2', 'fixture', 'owner', 'missing'))).toBe(
      'fork_record_source_unverifiable',
    );
  } finally {
    await f.close();
  }
});

for (const drift of ['source', 'provenance', 'message', 'receipt', 'selection'] as const)
  test(`final same-transaction dispatch rejects ${drift} drift after original fork observation without events or adapter`, async () => {
    const f = await fixture();
    try {
      const p = await f.plan();
      if (drift === 'source')
        f.physical.run(
          "UPDATE extension_record SET revision=revision+1,json=? WHERE scope_id='s'",
          ['{"original":"changed"}'],
        );
      else if (drift === 'provenance')
        f.physical.run(
          "UPDATE extension_record SET fork_provenance_json=json_set(fork_provenance_json,'$.sourceSessionId','f2') WHERE scope_id='f2'",
        );
      else if (drift === 'message')
        f.physical.run(
          "UPDATE message_part SET revision=revision+1 WHERE message_id IN(SELECT id FROM message WHERE session_id='s')",
        );
      else if (drift === 'receipt')
        f.physical.run(
          "UPDATE command SET receipt_json=json_set(receipt_json,'$.sourceUpperSeq','0') WHERE id='fork-f2'",
        );
      else f.physical.run("UPDATE session SET context_selection_id='changed' WHERE id='f2'");
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      expect(await code(f.store.markDispatching(p.dispatch))).not.toBe('success');
      expect((await f.store.getExecution('effect-execution'))!.status).toBe('planned');
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(f.counts().effects).toBe(0);
    } finally {
      await f.close();
    }
  });

test('forged local JSON anchor cannot create provenance; omitting ancestor stamps cannot evade final read-set', async () => {
  const f = await fixture();
  try {
    f.physical.run(
      "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,json) VALUES('fixture','session','f2','forged',1,'fixture.history',1,?)",
      [
        JSON.stringify({
          forkProvenance: (await f.store.getExtensionRecord({
            sessionId: 'f2',
            extensionId: 'fixture',
            key: 'note-0',
          }))!.forkProvenance,
        }),
      ],
    );
    expect(await code(f.read('f2', 'fixture', 'owner', 'forged'))).toBe(
      'fork_record_source_unverifiable',
    );
    const p = await f.plan();
    p.dispatch.readSet!.records = p.dispatch.readSet!.records.filter((r) => r.sessionId === 'f2');
    expect(await code(f.store.markDispatching(p.dispatch))).toBe('dispatch_read_set_invalid');
    expect((await f.store.getExecution('effect-execution'))!.status).toBe('planned');
  } finally {
    await f.close();
  }
});

test('Host permission wait preserves exact ancestor stamps and closes prepare reader; source drift causes zero effect', async () => {
  const entered = gate(),
    proceed = gate(),
    f = await fixture(1, { entered, proceed });
  try {
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'host-action',
      sessionId: 'f2',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'effect',
        definitionVersion: '1',
        input: {},
      },
    });
    await entered.promise;
    expect(await code(f.saved().readForkRecordSources!('note-0'))).toBe(
      'dispatch_read_context_closed',
    );
    expect(f.counts().effects).toBe(0);
    f.physical.run("UPDATE extension_record SET revision=revision+1 WHERE scope_id='s'");
    proceed.release();
    await f.runtime.waitForCommand('host-action', { timeoutMs: 5000 });
    expect(f.counts()).toEqual({ calls: 2, effects: 0 });
    expect((await f.store.getView('f2')).executions.every((e) => e.status !== 'succeeded')).toBe(
      true,
    );
  } finally {
    proceed.release();
    await f.close();
  }
}, 15000);

test('same 64-record budget counts all ancestor identities and refuses excess rather than truncating', async () => {
  const f = await fixture(22);
  try {
    // copy provenance has one source per key: two-layer note-0 is three records, not all namespace keys.
    expect((await f.read()).records).toHaveLength(3);
    const row = f.physical
      .query(
        "SELECT fork_provenance_json FROM extension_record WHERE scope_id='f2' AND key='note-0'",
      )
      .get() as { fork_provenance_json: string };
    const p = JSON.parse(row.fork_provenance_json);
    p.mode = 'rebuild';
    p.sources = Array.from({ length: 65 }, (_, n) => ({
      key: `note-${n}`,
      revision: '1',
      originStoreId: null,
      rawDigest: 'a'.repeat(64),
    }));
    f.physical.run(
      "UPDATE extension_record SET fork_provenance_json=? WHERE scope_id='f2' AND key='note-0'",
      [JSON.stringify(p)],
    );
    expect(await code(f.read())).not.toBe('success');
  } finally {
    await f.close();
  }
});

test('opt-in namespace rebuild seals same-owner different-type records, preserves original source IDs and never exposes foreign namespace', async () => {
  const f = await fixture(1, undefined, true);
  try {
    expect(f.namespaceSnapshots).toEqual([['fixture/note-0', 'fixture/head'], ['fixture/bundle']]);
    const proof = await f.read();
    expect(proof.records.map((r) => [r.sessionId, r.key])).toEqual([
      ['f2', 'bundle'],
      ['f1', 'bundle'],
      ['s', 'note-0'],
      ['s', 'head'],
    ]);
    expect(proof.records[1]!.value).toEqual({ keys: ['note-0', 'head'] });
    f.physical.run(
      "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,json) VALUES('foreign','session','f2','private',1,'foreign.secret',1,'{}')",
    );
    await f.fork('f2', 'f3');
    expect(f.namespaceSnapshots.at(-1)).toEqual(['fixture/bundle']);
    const p = await f.plan();
    expect(await code(f.store.markDispatching(p.dispatch))).toBe('success');
  } finally {
    await f.close();
  }
});

test('namespace observer shares exact 64 actual records budget across nested forks; record 65 refuses without truncation', async () => {
  for (const count of [61, 62]) {
    const f = await fixture(count, undefined, true);
    try {
      if (count === 61) {
        expect((await f.read()).records).toHaveLength(64);
        const p = await f.plan();
        expect(await code(f.store.markDispatching(p.dispatch))).toBe('success');
      } else expect(await code(f.read())).toBe('dispatch_read_set_invalid');
      expect(f.counts()).toEqual({ calls: 2, effects: 0 });
    } finally {
      await f.close();
    }
  }
});

test('namespace rebuild rejects unsupported same-owner records before any fork publication', async () => {
  const f = await fixture(1, undefined, true);
  try {
    f.physical.run(
      "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,json) VALUES('fixture','session','f2','unsupported',1,'fixture.future',2,'{}')",
    );
    const before = (await f.store.getMetadata()).lastChangeCursor;
    expect(await code(f.fork('f2', 'rejected'))).toBe('fork_record_unsupported');
    expect(await f.store.getSession('rejected')).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
  } finally {
    await f.close();
  }
});

test('actual nested Fork chain reaches the shared finite limit and refuses the next original identity', async () => {
  const f = await fixture();
  try {
    let from = 'f2';
    for (let n = 3; n <= 63; n++) {
      await f.fork(from, `f${n}`);
      from = `f${n}`;
    }
    expect((await f.read(from)).records).toHaveLength(64);
    await f.fork(from, 'f64');
    expect(await code(f.read('f64'))).toBe('dispatch_read_set_invalid');
    expect(f.counts()).toEqual({ calls: 2, effects: 0 });
  } finally {
    await f.close();
  }
}, 15000);

test('sealed graph cycle and source Workspace mismatch are unverifiable, never an ancestor opener', async () => {
  for (const change of ['cycle', 'workspace'] as const) {
    const f = await fixture();
    try {
      if (change === 'workspace') {
        await f.runtime.createWorkspace({
          expectedStoreId: f.storeId,
          id: 'foreign-w',
          rootUri: 'file:///private/tmp',
          name: 'foreign',
        });
        f.physical.run("UPDATE session SET workspace_id='foreign-w' WHERE id='s'");
      } else {
        const local = (await f.store.getExtensionRecord({
          extensionId: 'fixture',
          sessionId: 'f2',
          key: 'note-0',
        }))!;
        const p = local.forkProvenance as { [key: string]: Json };
        p.sourceSessionId = 'f2';
        f.physical.run("UPDATE extension_record SET fork_provenance_json=? WHERE scope_id='f2'", [
          JSON.stringify(p),
        ]);
        f.physical.run(
          "UPDATE command SET request_json=json_set(request_json,'$.fork.sourceSessionId','f2'),receipt_json=json_set(receipt_json,'$.sourceSessionId','f2') WHERE id='fork-f2'",
        );
      }
      expect(await code(f.read())).toBe('fork_record_source_unverifiable');
      expect(f.counts()).toEqual({ calls: 2, effects: 0 });
    } finally {
      await f.close();
    }
  }
});

test('observation byte budget rejects a large current record rather than returning a partial ancestor set', async () => {
  const f = await fixture();
  try {
    f.physical.run("UPDATE extension_record SET json=? WHERE scope_id='f2'", [
      JSON.stringify({ large: 'x'.repeat(1024 * 1024) }),
    ]);
    expect(await code(f.read())).toBe('dispatch_read_set_invalid');
    expect(f.counts().effects).toBe(0);
  } finally {
    await f.close();
  }
});

test('Host actual adapter accepts its original foreign records once; intake/authorization sequence is not a Message drift and execute reader closes', async () => {
  const entered = gate(),
    proceed = gate(),
    f = await fixture(1, { entered, proceed });
  try {
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'host-valid',
      sessionId: 'f2',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'effect',
        definitionVersion: '1',
        input: {},
      },
    });
    await entered.promise;
    const planned = (await f.store.getView('f2')).executions[0]!;
    expect((planned.decisionSource as { forkBindings: unknown[] }).forkBindings).toHaveLength(1);
    expect(
      (planned.decisionSource as { recordReads: { sessionId: string }[] }).recordReads.map(
        (r) => r.sessionId,
      ),
    ).toEqual(['f2', 'f1', 's']);
    proceed.release();
    await f.runtime.waitForCommand('host-valid', { timeoutMs: 5000 });
    expect(f.counts()).toEqual({ calls: 2, effects: 1 });
    expect(await code(f.executed().readForkRecordSources!('note-0'))).toBe(
      'dispatch_read_context_closed',
    );
    expect((await f.store.getView('f2')).runs).toHaveLength(0);
    expect(
      (await f.store.getView('f2')).executions.filter((e) => e.status === 'succeeded'),
    ).toHaveLength(1);
  } finally {
    proceed.release();
    await f.close();
  }
}, 15000);

test('matching raw Message parts and same subject do not authorize a foreign-session origin outside actual Fork ancestry', async () => {
  const f = await fixture();
  try {
    await f.runtime.createSession({
      ...f.base,
      sessionId: 'foreign-s',
      commandId: 'create-foreign-s',
      workspaceId: 'w',
      title: 'same subject, unrelated',
    });
    f.physical.run(
      "INSERT INTO message(id,session_id,run_id,seq,role,status,source_json) SELECT 'alien-message','foreign-s',NULL,seq,role,status,source_json FROM message WHERE session_id='s' AND role='user' LIMIT 1",
    );
    f.physical.run(
      "INSERT INTO message_part(message_id,ordinal,kind,content_version,revision,json) SELECT 'alien-message',ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=(SELECT id FROM message WHERE session_id='s' AND role='user' LIMIT 1)",
    );
    f.physical.run(
      "UPDATE message SET fork_source_message_id='alien-message' WHERE session_id='f2' AND role='user'",
    );
    expect(await code(f.read())).toBe('fork_record_source_unverifiable');
    expect(f.counts()).toEqual({ calls: 2, effects: 0 });
  } finally {
    await f.close();
  }
});
