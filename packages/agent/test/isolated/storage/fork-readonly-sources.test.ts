import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import type { Extension, ReadContext } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { DispatchInput } from '../../../src/storage/port';
import type { ForkSourceObservation, Json } from '../../../src/storage/types';

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
  ask = false,
  largeInput = false,
) {
  const root = mkdtempSync('/private/tmp/kite-fork-record-sources-'),
    profile = { dataRoot: join(root, 'profile'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  let calls = 0,
    effects = 0,
    saved: ReadContext | undefined,
    observed: ForkSourceObservation | undefined,
    executed: ReadContext | undefined,
    savedProjection: import('../../../src/extensions').ForkSourceProjection | undefined,
    detachedRead: Promise<unknown> | undefined;
  const anchor = 'bundle';
  const artifacts = createArtifactStore({ profile, store });
  let artifactId = '';
  const namespaceSnapshots: string[][] = [];
  let toolId = '',
    extraModelId = '';
  const rebuild = {
    mode: 'rebuild' as const,
    version: '1',
    sourceScope: 'namespace' as const,
    sourceReads: 'declared' as const,
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
          readonlySources:
            input.sourceSessionId === 's'
              ? [
                  {
                    kind: 'execution' as const,
                    executionKind: 'tool' as const,
                    executionId: String(
                      (input.records[0]!.value as { executionId: string }).executionId,
                    ),
                    artifactRefIds: [artifactId],
                  },
                ]
              : [
                  {
                    kind: 'inherited' as const,
                    anchorKey: 'bundle',
                    executionId: toolId,
                    artifactRefIds: [artifactId],
                  },
                  ...(extraModelId
                    ? [
                        {
                          kind: 'execution' as const,
                          executionKind: 'model' as const,
                          executionId: extraModelId,
                          artifactRefIds: [],
                        },
                      ]
                    : []),
                ],
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
        fork: rebuild,
      },
      ...[
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
      ],
    ],
    tools: [
      {
        id: 'seed',
        version: '1',
        description: 'Actual immutable fixture records',
        inputSchema: { type: 'object' },
        async execute(_input, ctx) {
          toolId = ctx.executionId;
          artifactId = (
            await ctx.artifacts!.publish({
              key: 'evidence',
              mediaType: 'application/octet-stream',
              content: Buffer.from('原始'.repeat(24000)),
            })
          ).id;
          for (let n = 0; n < count; n++)
            await ctx.records.write({
              key: `note-${n}`,
              expectedRevision: null,
              contentType: 'fixture.history',
              contentVersion: 1,
              value: { original: n, executionId: ctx.executionId },
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
          const projection = await ctx.openForkSourceProjection!(anchor);
          savedProjection = projection;
          observed = await store.readForkSourceProjection({
            expectedStoreId: storeId,
            subjectId: 'owner',
            sessionId: ctx.sessionId,
            extensionId: 'fixture',
            localKey: anchor,
          });
          await projection.getExecution(toolId);
          return { count: observed.proof.sources.length };
        },
        async execute(_prepared, context) {
          executed = context;
          await context.openForkSourceProjection!(anchor);
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
          const projection = await ctx.openForkSourceProjection!(anchor);
          savedProjection = projection;
          observed = await store.readForkSourceProjection({
            expectedStoreId: storeId,
            subjectId: 'owner',
            sessionId: ctx.sessionId,
            extensionId: 'fixture',
            localKey: anchor,
          });
          if (_input && typeof _input === 'object' && !Array.isArray(_input) && _input.detached) {
            detachedRead = projection.getExecution(toolId);
            detachedRead.catch(() => {});
            return [];
          }
          await projection.getExecution(toolId);
          const tool = projection.sources.find((s) => s.kind === 'tool')!;
          const original = await projection.getExecution(tool.executionId);
          expect(original!.sessionId).toBe('s');
          const input = await projection.readModelInput(tool.modelExecutionId!);
          expect(input.request.messages.some((m) => m.role === 'user')).toBe(true);
          const output = await projection.readModelOutput(tool.modelExecutionId!);
          expect(output.output.toolCalls[0]!.id).toBe('seed-call');
          expect((await projection.artifacts.read(tool.artifactRefs[0]!)).byteLength).toBe(
            Buffer.byteLength('原始'.repeat(24000)),
          );
          for (const alias of projection.aliases) {
            const message = await projection.getMessage(alias.aliases.at(-1)!.messageId);
            expect(message.status).toBe('complete');
            expect(message.parts.length).toBeGreaterThan(0);
          }
          expect(await code(projection.getMessage('unselected'))).toBe('fork_source_unverifiable');
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
    artifacts,
    permissions: {
      async authorize(request) {
        if (ask && request.definitionId === 'fixture/effect')
          return {
            allowed: false,
            revision: 'ask-v1',
            approval: { request: { title: 'exact original Fork evidence' } },
          };
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
    request: {
      kind: 'run.start',
      content: largeInput ? '始終'.repeat(55000) : 'actual original user',
    },
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
  await fork('s', 'f1', namespace);
  await fork('f1', 'f2');
  const physical = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
  const read = (
    sessionId = 'f2',
    extensionId = 'fixture',
    subjectId = 'owner',
    localKey = anchor,
  ) =>
    store.readForkSourceProjection({
      expectedStoreId: storeId,
      sessionId,
      extensionId,
      subjectId,
      localKey,
    });
  const plan = async () => {
    const proof = await read(),
      records: import('../../../src/storage/types').DispatchRecordRead[] = [],
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
      forkSourceBindings: [proof.binding] as unknown as Json,
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
      readSet: { records, recordLists: [], forkSourceBindings: [proof.binding] },
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
    toolId: () => toolId,
    setExtraModel: (id: string) => {
      extraModelId = id;
    },
    artifacts,
    profile,
    artifactId: () => artifactId,
    projection: () => savedProjection!,
    detached: () => detachedRead!,
    observed: () => observed!,
    saved: () => saved!,
    executed: () => executed!,
    async close() {
      physical.close();
      await runtime.close();
      await artifacts.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('declared Tool auto-closes actual Model and unselected evidence remains readonly through two Forks', async () => {
  const f = await fixture(1, undefined, true);
  try {
    const p = await f.read();
    expect(p.aliases).toEqual([]);
    expect(p.proof.sources.length).toBe(2);
    const tool = p.proof.sources.find((s) => s.kind === 'tool')!;
    expect(tool.executionId).toBe(f.toolId());
    expect(tool.modelExecutionId).toBe(
      p.proof.sources.find((s) => s.kind === 'model')!.executionId,
    );
    expect(p.proof.models.length).toBe(1);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.query();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.counts()).toEqual({ calls: 2, effects: 0 });
    expect(await code(f.projection().getExecution(f.toolId()))).toBe(
      'dispatch_read_context_closed',
    );
    f.physical.run(
      "UPDATE extension_record SET revision=revision+1,json='{}' WHERE scope_id='s' AND key='note-0'",
    );
    expect((await f.read()).proof.sources).toEqual(p.proof.sources);
  } finally {
    await f.close();
  }
});
test('selected Message aliases include every actual ancestor and bind full parts', async () => {
  const f = await fixture();
  try {
    const p = await f.read();
    expect(p.aliases.length).toBeGreaterThan(0);
    expect(p.aliases[0]!.aliases.map((a) => a.sessionId)).toEqual(['f2', 'f1', 's']);
    const before = p.binding.digest;
    const id = p.aliases[0]!.aliases[2]!.messageId;
    f.physical.run('UPDATE message_part SET revision=revision+1 WHERE message_id=?', [id]);
    expect(await code(f.read())).toBe('fork_origin_unverifiable');
    expect(before.length).toBe(64);
  } finally {
    await f.close();
  }
});
test('a live Fork keeps exact sealed and record sources after its ancestors are deleted, without reviving their authority', async () => {
  const f = await fixture();
  try {
    const original = await f.read();
    for (const id of ['s', 'f1']) {
      const source = (await f.store.getSession(id))!;
      await f.runtime.deleteSession({
        ...f.base,
        sessionId: id,
        commandId: `delete-${id}`,
        ifRevision: source.controlRevision,
      });
    }
    expect((await f.read()).proof).toEqual(original.proof);
    const records = await f.store.readForkRecordSources({
      ...f.base,
      sessionId: 'f2',
      extensionId: 'fixture',
      localKey: 'bundle',
    });
    expect(records.records.map((entry) => entry.sessionId)).toEqual(['f2', 'f1', 's']);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.query(); // Full original Model input/output, media EOF and all Message aliases.
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(f.counts()).toEqual({ calls: 2, effects: 0 });
    expect(await code(f.read('s'))).toBe('fork_source_unverifiable');
    expect(await code(f.read('f1'))).toBe('fork_source_unverifiable');
    expect(await code(f.fork('s', 'late'))).toBe('session_not_found');
  } finally {
    await f.close();
  }
});
test('foreign subject namespace and forged anchor are unavailable', async () => {
  const f = await fixture();
  try {
    expect(await code(f.read('f2', 'foreign'))).toBe('fork_source_unverifiable');
    expect(await code(f.read('f2', 'fixture', 'other'))).toBe('fork_source_unverifiable');
    f.physical.run(
      "UPDATE extension_record SET fork_provenance_json=json_set(fork_provenance_json,'$.commandId','fake') WHERE scope_id='f2'",
    );
    expect(await code(f.read())).toBe('fork_source_unverifiable');
  } finally {
    await f.close();
  }
});
for (const change of [
  "UPDATE execution SET result_revision=result_revision+1 WHERE kind='tool' AND session_id='s'",
  "UPDATE execution SET intent_json=json_set(intent_json,'$.drift',true) WHERE kind='model' AND session_id='s'",
  "UPDATE extension_record SET revision=revision+1 WHERE scope_id='f2'",
  "UPDATE blob_ref SET media_type='invalid/type' WHERE owner_kind='execution'",
]) {
  test(`final owned dispatch rechecks sealed readonly source: ${change}`, async () => {
    const f = await fixture();
    try {
      const { dispatch } = await f.plan();
      f.physical.run(change);
      expect(await code(f.store.markDispatching(dispatch))).not.toBe('success');
      expect(f.counts().effects).toBe(0);
    } finally {
      await f.close();
    }
  });
}
test('permission waiting does not reuse immutable source proof after drift', async () => {
  const entered = gate(),
    proceed = gate();
  const f = await fixture(1, { entered, proceed });
  try {
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'ask-action',
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
    f.physical.run(
      "UPDATE execution SET result_revision=result_revision+1 WHERE kind='tool' AND session_id='s'",
    );
    proceed.release();
    await f.runtime.waitForCommand('ask-action', { timeoutMs: 5000 });
    expect(f.counts().effects).toBe(0);
  } finally {
    proceed.release();
    await f.close();
  }
});

test('exact sealed ref subset does not expand to later media; physical incomplete EOF fails before effect', async () => {
  const f = await fixture();
  try {
    const initial = await f.read();
    const s = initial.proof.sources.find((s) => s.kind === 'tool')!;
    await f.artifacts.publish({
      expectedStoreId: f.storeId,
      subjectId: 'owner',
      sessionId: 's',
      scope: { kind: 'execution', id: f.toolId() },
      refId: 'later-media',
      mediaType: 'text/plain',
      content: Buffer.from('later'),
    });
    expect(
      (await f.read()).proof.sources.find((s) => s.kind === 'tool')!.artifactRefs.map((r) => r.id),
    ).toEqual([f.artifactId()]);
    const r = s.artifactRefs[0]!;
    chmodSync(artifactPath(join(f.profile.dataRoot, f.profile.profile), r.hash), 0o600);
    writeFileSync(
      artifactPath(join(f.profile.dataRoot, f.profile.profile), r.hash),
      Buffer.from('bad'),
    );
    expect(await code(f.query())).not.toBe('success');
    expect(f.counts().effects).toBe(0);
  } finally {
    await f.close();
  }
});
test('source group with accepted future work or outcome unknown cannot seal new delegation', async () => {
  const f = await fixture();
  try {
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'future',
      sessionId: 's',
      request: { kind: 'run.start', content: 'future' },
    });
    expect(await code(f.fork('s', 'blocked'))).toBe('execution_group_not_quiescent');
    f.physical.run("UPDATE command SET status='rejected' WHERE id='future'");
    f.physical.run("UPDATE execution SET state='outcome_unknown' WHERE id=?", [f.toolId()]);
    expect(await code(f.fork('s', 'blocked-unknown'))).toBe('context_execution_unsettled');
  } finally {
    await f.close();
  }
});
test('readonly declarations and inherited subset enforce bounded closed identities', async () => {
  const f = await fixture();
  try {
    const input = { ...f.base, sessionId: 'f2', extensionId: 'fixture' };
    expect(
      await code(
        f.store.prepareForkReadonlySources({
          ...input,
          declarations: [
            {
              kind: 'execution',
              executionId: f.toolId(),
              executionKind: 'tool',
              artifactRefIds: [],
            },
          ],
        }),
      ),
    ).toBe('fork_source_unverifiable');
    expect(
      await code(
        f.store.prepareForkReadonlySources({
          ...input,
          declarations: [
            {
              kind: 'inherited',
              anchorKey: 'bundle',
              executionId: f.toolId(),
              artifactRefIds: ['later-unsealed'],
            },
          ],
        }),
      ),
    ).toBe('fork_source_unverifiable');
    expect(
      await code(
        f.store.prepareForkReadonlySources({
          ...input,
          declarations: Array.from({ length: 65 }, () => ({
            kind: 'inherited' as const,
            anchorKey: 'bundle',
            executionId: f.toolId(),
            artifactRefIds: [],
          })),
        }),
      ),
    ).toBe('fork_source_budget_exceeded');
  } finally {
    await f.close();
  }
});

test('inflight projection reader is closed with its callback and yields no late source', async () => {
  const f = await fixture();
  const entered = gate(),
    proceed = gate();
  const original = f.store.readForkSourceProjection.bind(f.store);
  let n = 0;
  try {
    f.store.readForkSourceProjection = async (input) => {
      if (++n === 3) {
        entered.release();
        await proceed.promise;
      }
      return original(input);
    };
    await f.runtime.queryExtension({
      ...f.base,
      sessionId: 'f2',
      extensionId: 'fixture',
      queryId: 'history',
      input: { detached: true },
    });
    await entered.promise;
    proceed.release();
    expect(await code(f.detached())).toBe('dispatch_read_context_closed');
    expect(f.counts().effects).toBe(0);
  } finally {
    proceed.release();
    f.store.readForkSourceProjection = original;
    await f.close();
  }
});
test('legal User command ID colliding with source Model never becomes Execution authority', async () => {
  const f = await fixture();
  try {
    const source = (await f.read()).proof.sources.find((s) => s.kind === 'model')!;
    await f.runtime.submitCommand({
      ...f.base,
      commandId: source.executionId,
      sessionId: 's',
      request: { kind: 'run.start', content: 'real later user collision' },
    });
    await f.runtime.waitForCommand(source.executionId, { timeoutMs: 5000 });
    await f.fork('s', 'collision');
    const observed = await f.read('collision');
    const alias = observed.aliases.find((a) =>
      a.aliases.some(
        (v) =>
          v.sessionId === 's' &&
          String(
            f.physical
              .query<{ source_json: string }, [string]>(
                'SELECT source_json FROM message WHERE id=?',
              )
              .get(v.messageId)?.source_json,
          ).includes('real later user collision'),
      ),
    )!;
    expect(alias).toBeDefined();
    const original = alias.aliases.at(-1)!;
    const message = await f.store.readForkSourceMessage({
      ...f.base,
      sessionId: 'collision',
      extensionId: 'fixture',
      localKey: 'bundle',
      messageId: original.messageId,
    });
    expect(message.role).toBe('user');
    expect(message.content).toBe('real later user collision');
    expect(message.sourceIds).toContain(source.executionId);
    expect(observed.proof.sources.map((s) => s.executionId)).toEqual(
      (await f.read()).proof.sources.map((s) => s.executionId),
    );
  } finally {
    await f.close();
  }
});

for (const drift of [false, true])
  test(`actual Ask accepted original proof ${drift ? 'rejects drift' : 'dispatches once'}`, async () => {
    const f = await fixture(1, undefined, false, true);
    try {
      await f.runtime.submitCommand({
        ...f.base,
        commandId: 'human-action',
        sessionId: 'f2',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'effect',
          definitionVersion: '1',
          input: {},
        },
      });
      let card:
        | Awaited<ReturnType<typeof f.runtime.listInteractions>>['interactions'][number]
        | undefined;
      const deadline = Date.now() + 5000;
      while (!card) {
        card = (await f.runtime.listInteractions({ ...f.base, sessionId: 'f2', state: 'pending' }))
          .interactions[0];
        if (Date.now() > deadline) throw Error('approval_timeout');
        if (!card) await Bun.sleep(5);
      }
      expect(f.counts().effects).toBe(0);
      expect(await code(f.projection().getExecution(f.toolId()))).toBe(
        'dispatch_read_context_closed',
      );
      if (drift)
        f.physical.run('UPDATE execution SET result_revision=result_revision+1 WHERE id=?', [
          f.toolId(),
        ]);
      await f.runtime.answerInteraction({
        ...f.base,
        commandId: 'answer-proof',
        presentationSessionId: 'f2',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
      await f.runtime.waitForCommand('human-action', { timeoutMs: 5000 });
      expect(f.counts().effects).toBe(drift ? 0 : 1);
      expect(f.counts().calls).toBe(2);
    } finally {
      await f.close();
    }
  });

test('sealed full Model input larger than Worker metadata is read exactly through original projection', async () => {
  const f = await fixture(1, undefined, false, false, true);
  try {
    const p = await f.read();
    const m = p.proof.sources.find((s) => s.kind === 'model')!;
    const full = await f.runtime.readModelInput({
      ...f.base,
      sessionId: 's',
      executionId: m.executionId,
    });
    expect(BigInt(full.bodyBytes)).toBeGreaterThan(300000n);
    expect(full.request.messages.find((v) => v.role === 'user')!.content).toBe(
      '始終'.repeat(55000),
    );
    await f.query();
    expect(f.counts()).toEqual({ calls: 2, effects: 0 });
  } finally {
    await f.close();
  }
});

test('readonly projection reconstructs actual Fork ancestry and rejects a sealed cycle', async () => {
  const f = await fixture();
  try {
    f.physical.run(
      "UPDATE command SET request_json=json_set(request_json,'$.fork.sourceSessionId','f1'),receipt_json=json_set(receipt_json,'$.sourceSessionId','f1') WHERE id='fork-f1'",
    );
    expect(await code(f.read())).toBe('fork_source_unverifiable');
    expect(f.counts().effects).toBe(0);
  } finally {
    await f.close();
  }
});

test('new actual branch Model and sealed inherited Tool combine without reopening future old refs', async () => {
  const f = await fixture();
  try {
    await f.runtime.submitCommand({
      ...f.base,
      commandId: 'new-branch',
      sessionId: 'f2',
      request: { kind: 'run.start', content: 'actual new branch input' },
    });
    await f.runtime.waitForCommand('new-branch', { timeoutMs: 5000 });
    const newModel = (await f.store.listExecutions('f2')).find((e) => e.kind === 'model')!;
    expect(newModel.status).toBe('succeeded');
    f.setExtraModel(newModel.id);
    await f.fork('f2', 'mixed');
    const proof = await f.read('mixed');
    expect(proof.proof.models.length).toBe(2);
    expect(proof.proof.sources.map((s) => s.executionId)).toContain(newModel.id);
    expect(proof.proof.sources.map((s) => s.executionId)).toContain(f.toolId());
    await f.runtime.queryExtension({
      ...f.base,
      sessionId: 'mixed',
      extensionId: 'fixture',
      queryId: 'history',
      input: {},
    });
    expect(f.counts()).toEqual({ calls: 3, effects: 0 });
  } finally {
    await f.close();
  }
});

test('sealed readonly ancestry accepts exactly 64 actual Fork links and refuses further observation', async () => {
  const f = await fixture(1, undefined, true);
  try {
    let source = 'f2';
    for (let depth = 3; depth <= 64; depth++) {
      const target = `sealed-depth-${depth}`;
      await f.fork(source, target);
      source = target;
    }
    expect((await f.read(source)).proof.sources.length).toBe(2);
    await f.fork(source, 'sealed-depth-65');
    expect(await code(f.read('sealed-depth-65'))).toBe('fork_source_unverifiable');
    expect(f.counts()).toEqual({ calls: 2, effects: 0 });
  } finally {
    await f.close();
  }
}, 15000);

test('projection refuses oversized current anchor rather than exposing partial readonly proof', async () => {
  const f = await fixture();
  try {
    f.physical.run("UPDATE extension_record SET json=? WHERE scope_id='f2'", [
      JSON.stringify({ huge: 'x'.repeat(1024 * 1024) }),
    ]);
    expect(await code(f.read())).toBe('fork_source_budget_exceeded');
    expect(f.counts().effects).toBe(0);
  } finally {
    await f.close();
  }
});
