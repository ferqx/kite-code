import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrajectoryEvent, TrajectoryScope } from '@kite-ai/trajectory';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import type { Json, OwnerRef } from '../../../src/storage/types';

type SqliteStore = Awaited<ReturnType<typeof openSqliteStore>>;
async function failure(work: Promise<unknown>, code?: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (code) expect(error).toMatchObject({ code });
}
async function events(
  store: SqliteStore,
  scope: TrajectoryScope & { subjectId: string },
  upperCursor?: string,
) {
  const upper = upperCursor ?? (await store.openTrajectory(scope)).upperCursor;
  const result: TrajectoryEvent[] = [];
  let afterCursor = '0';
  for (let pages = 0; pages < 20; pages++) {
    const page = await store.readTrajectoryEvents({ ...scope, afterCursor, upperCursor: upper });
    result.push(...page.events);
    if (page.exhausted) return result;
    expect(BigInt(page.scannedThrough)).toBeGreaterThan(BigInt(afterCursor));
    afterCursor = page.scannedThrough;
  }
  throw Error('fixture pagination did not terminate');
}
async function fixture(
  initial: { content: string; files?: { name: string; uri: string }[] } = { content: 'work' },
  registeredTool = { id: 'tool', version: '1', extensionId: 'fixture' },
) {
  const dataRoot = temporaryDirectory('kite-trajectory-flow-');
  chmodSync(dataRoot, 0o700);
  const store = await openSqliteStore({ dataRoot, profile: 'flow' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'user',
    title: 'flow',
  });
  await store.acceptCommand({
    expectedStoreId,
    commandId: 'work',
    sessionId: 's',
    subjectId: 'user',
    request: { kind: 'run.start', ...initial },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!,
    write = { expectedStoreId, owner };
  const configuration = { tools: [registeredTool] };
  const run = await store.startRun({ ...write, commandId: 'work', configuration });
  const source = { kind: 'model_decision', modelExecutionId: 'decision' },
    input = {};
  const inputDigest = await semanticDigest(input);
  const plan = (
    executionId: string,
    kind: 'model' | 'tool' = 'tool',
    sessionId = 's',
    runId = run.id,
    originCommandId = 'work',
  ) =>
    store.planExecution({
      ...write,
      executionId,
      sessionId,
      runId,
      originCommandId,
      stepId: executionId,
      callId: executionId,
      kind,
      definitionId: 'tool',
      definitionVersion: '1',
      input,
      decisionSource: source,
    });
  const dispatch = (executionId: string) =>
    store.markDispatching({
      ...write,
      executionId,
      authorization: { allowed: true, revision: 'policy-1', definitionVersion: '1', inputDigest },
      requirements: [],
      freshness: { checked: true, source },
    });
  const db = new Database(join(dataRoot, 'flow', 'core.db'));
  const scope = { storeId: expectedStoreId, sessionId: 's', subjectId: 'user' };
  return {
    store,
    db,
    dataRoot,
    expectedStoreId,
    owner,
    write,
    configuration,
    run,
    scope,
    source,
    inputDigest,
    plan,
    dispatch,
    async close() {
      db.close(true);
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

function observer(f: Awaited<ReturnType<typeof fixture>>) {
  return createRuntime({
    store: f.store,
    model: {
      stream() {
        throw Error('observation must not execute a Model');
      },
    },
    permissions: {
      async authorize() {
        throw Error('observation must not request execution permission');
      },
    },
  });
}
async function messageEvidence(
  f: Awaited<ReturnType<typeof fixture>>,
  runtime: ReturnType<typeof createRuntime>,
  event: TrajectoryEvent,
  upperCursor?: string,
) {
  const ref = event.evidenceRefs.find((value) => value.kind === 'message')!;
  return runtime.readTrajectoryEvidence({
    ...f.scope,
    upperCursor: upperCursor ?? (await f.store.getMetadata()).lastChangeCursor,
    atCursor: event.sequence,
    eventId: event.eventId,
    evidenceId: ref.evidenceId,
    contentVersion: ref.contentVersion,
  });
}

test('human text and attachment descriptions are sealed in a message fact without granting URI reads', async () => {
  const f = await fixture({
    content: 'Original user text 雪🙂',
    files: [{ name: 'Original file.txt', uri: 'file:///does-not-exist/PRIVATE_PATH' }],
  });
  const runtime = observer(f);
  try {
    const fact = (await events(f.store, f.scope)).find(
      (event) => event.kind === 'message' && event.attributes.role === 'user',
    )!;
    expect(fact).toMatchObject({
      kind: 'message',
      runId: f.run.id,
      operationId: 'work',
      messageOriginStoreId: f.expectedStoreId,
      attributes: { role: 'user', status: 'complete' },
    });
    expect(fact.executionId).toBeUndefined();
    expect(fact).toMatchObject({
      attributes: {
        display: { kind: 'message', title: '用户提示词', summary: 'Original user text 雪🙂' },
      },
    });
    expect(JSON.stringify(fact)).not.toContain('PRIVATE_PATH');
    const original = await messageEvidence(f, runtime, fact);
    expect(JSON.parse(Buffer.from(original.content).toString())).toEqual({
      role: 'user',
      status: 'complete',
      content: 'Original user text 雪🙂',
      attachments: [{ name: 'Original file.txt' }],
    });
    expect(Buffer.from(original.content).toString()).not.toContain('PRIVATE_PATH');
    f.db
      .query('UPDATE message SET source_json=? WHERE id=?')
      .run(
        JSON.stringify({ content: 'LATER PRIVATE REPLACEMENT', sourceIds: ['tool'] }),
        fact.kind === 'message' ? fact.attributes.messageId : '',
      );
    expect((await messageEvidence(f, runtime, fact)).content).toEqual(original.content);
    const ref = fact.evidenceRefs[0]!;
    await failure(
      runtime.readTrajectoryEvidence({
        ...f.scope,
        subjectId: 'stranger',
        upperCursor: (await f.store.getMetadata()).lastChangeCursor,
        atCursor: fact.sequence,
        eventId: fact.eventId,
        evidenceId: ref.evidenceId,
        contentVersion: ref.contentVersion,
      }),
      'trajectory_scope_denied',
    );
  } finally {
    await runtime.close();
    await f.close();
  }
});

test('assistant stream updates keep one original message identity and exact earlier public prefixes after completion', async () => {
  const f = await fixture(),
    runtime = observer(f);
  try {
    await f.plan('answer', 'model');
    await f.dispatch('answer');
    await f.store.persistModelPartial({
      ...f.write,
      executionId: 'answer',
      content: 'First prefix 雪',
      reasoning: 'PRIVATE_REASONING',
    });
    const upper = (await f.store.getMetadata()).lastChangeCursor;
    const first = (await events(f.store, f.scope, upper))
      .filter((event) => event.kind === 'message' && event.executionId === 'answer')
      .at(-1)!;
    const prefix = await messageEvidence(f, runtime, first, upper);
    expect(JSON.parse(Buffer.from(prefix.content).toString())).toEqual({
      role: 'assistant',
      status: 'incomplete',
      content: 'First prefix 雪',
      attachments: [],
    });
    await f.store.persistModelPartial({
      ...f.write,
      executionId: 'answer',
      content: 'First prefix 雪 second',
      reasoning: 'PRIVATE_REASONING',
    });
    await f.store.finishExecution({
      ...f.write,
      executionId: 'answer',
      status: 'succeeded',
      result: { content: 'Final reply', reasoning: 'PRIVATE_REASONING' },
      message: { role: 'assistant', content: 'Final reply', sourceIds: ['answer'] },
    });
    const all = await events(f.store, f.scope),
      messages = all.filter((event) => event.kind === 'message' && event.executionId === 'answer');
    expect(messages).toHaveLength(3);
    expect(
      new Set(
        messages.map((event) => (event.kind === 'message' ? event.attributes.messageId : null)),
      ).size,
    ).toBe(1);
    expect(
      messages.every(
        (event) => event.messageOriginStoreId === f.expectedStoreId && event.runId === f.run.id,
      ),
    ).toBe(true);
    expect(messages.at(-1)).toMatchObject({
      kind: 'message',
      phase: 'completed',
      attributes: {
        status: 'complete',
        messageId: 'partial_answer',
        display: { kind: 'message', summary: 'Final reply' },
      },
    });
    expect(first).toMatchObject({
      attributes: { display: { kind: 'message', summary: 'First prefix 雪' } },
    });
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_REASONING');
    const final = await messageEvidence(f, runtime, messages.at(-1)!);
    expect(JSON.parse(Buffer.from(final.content).toString()).content).toBe('Final reply');
    expect(Buffer.from(final.content).toString()).not.toContain('PRIVATE_REASONING');
    expect((await messageEvidence(f, runtime, first)).content).toEqual(prefix.content);
    expect(
      all
        .find(
          (event) =>
            event.kind === 'model' &&
            event.executionId === 'answer' &&
            event.sourceEventType === 'execution.finished',
        )
        ?.evidenceRefs.some((ref) => ref.kind === 'model_output'),
    ).toBe(true);
    await failure(
      f.store.persistModelPartial({
        ...f.write,
        executionId: 'answer',
        content: 'LATE REPLACEMENT',
      }),
      'execution_not_active',
    );
    expect((await messageEvidence(f, runtime, first)).content).toEqual(prefix.content);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test('role user tool results and multi-source assistant messages do not become human conversation facts', async () => {
  const f = await fixture();
  try {
    await f.plan('tool');
    await f.dispatch('tool');
    await f.store.finishExecution({
      ...f.write,
      executionId: 'tool',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'tool result' },
      message: { role: 'user', content: 'Pretend human prompt', sourceIds: ['tool'] },
    });
    await f.plan('ambiguous', 'model');
    await f.dispatch('ambiguous');
    await f.store.finishExecution({
      ...f.write,
      executionId: 'ambiguous',
      status: 'succeeded',
      result: { content: 'Ambiguous reply' },
      message: { role: 'assistant', content: 'Ambiguous reply', sourceIds: ['ambiguous', 'tool'] },
    });
    const all = await events(f.store, f.scope),
      messageFacts = all.filter((event) => event.kind === 'message');
    expect(messageFacts).toHaveLength(1);
    expect(messageFacts[0]).toMatchObject({ kind: 'message', attributes: { role: 'user' } });
    expect(all.some((event) => event.kind === 'tool' && event.executionId === 'tool')).toBe(true);
    expect(all.some((event) => event.kind === 'model' && event.executionId === 'ambiguous')).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

test('later observations preserve the sealed message namespace across a changed read Store and cancelled prefixes stay incomplete', async () => {
  const f = await fixture(),
    runtime = observer(f);
  try {
    await f.plan('restored-answer', 'model');
    await f.dispatch('restored-answer');
    await f.store.persistModelPartial({
      ...f.write,
      executionId: 'restored-answer',
      content: 'Original prefix',
    });
    const first = (await events(f.store, f.scope))
      .filter((event) => event.kind === 'message' && event.executionId === 'restored-answer')
      .at(-1)!;
    const original = await messageEvidence(f, runtime, first);
    // This fixture changes only the current read Store identity. The old Model,
    // Message and sealed facts retain their original entity identities.
    await f.store.finishExecution({
      ...f.write,
      executionId: 'restored-answer',
      status: 'cancelled',
      result: { content: 'cancelled' },
    });
    const nextStoreId = 'restored-current-store';
    f.db.query('UPDATE storage_meta SET store_id=? WHERE singleton=1').run(nextStoreId);
    const scope = { ...f.scope, storeId: nextStoreId };
    // Exercise only the original event writer across Store identities; this does
    // not grant permission to resume an old execution in the restored Store.
    const writer = new SqliteOperations(f.db, false);
    try {
      writer.tx(() => {
        const saved = JSON.parse(
          String(
            writer.row("SELECT source_json FROM message WHERE id='partial_restored-answer'")!
              .source_json,
          ),
        );
        const body = JSON.stringify({ ...saved, content: 'Original prefix after cancellation' });
        writer.run("UPDATE message SET source_json=? WHERE id='partial_restored-answer'", body);
        writer.run(
          "UPDATE message_part SET json=?,revision=revision+1 WHERE message_id='partial_restored-answer'",
          body,
        );
        writer.event('s', 'partial_restored-answer', 'message.updated');
      });
    } finally {
      writer.releaseStatements();
    }
    const facts = (await events(f.store, scope)).filter(
      (event) => event.kind === 'message' && event.executionId === 'restored-answer',
    );
    expect(facts).toHaveLength(2);
    expect(facts[1]).toMatchObject({
      origin: { storeId: nextStoreId },
      phase: 'cancelled',
      messageOriginStoreId: f.expectedStoreId,
      executionOriginStoreId: f.expectedStoreId,
      attributes: { messageId: 'partial_restored-answer', status: 'incomplete' },
    });
    const ref = first.evidenceRefs.find((value) => value.kind === 'message')!;
    const reread = await runtime.readTrajectoryEvidence({
      ...scope,
      upperCursor: (await f.store.getMetadata()).lastChangeCursor,
      atCursor: first.sequence,
      eventId: first.eventId,
      evidenceId: ref.evidenceId,
      contentVersion: ref.contentVersion,
    });
    expect(reread.content).toEqual(original.content);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test('one inline reply with multiple verified ordinary Models remains one Run message without guessing a Model parent', async () => {
  const f = await fixture(),
    runtime = observer(f);
  try {
    await f.plan('contributor-a', 'model');
    await f.dispatch('contributor-a');
    await f.store.finishExecution({
      ...f.write,
      executionId: 'contributor-a',
      status: 'succeeded',
      result: { content: 'First contribution' },
    });
    await f.plan('contributor-b', 'model');
    await f.dispatch('contributor-b');
    await f.store.finishExecution({
      ...f.write,
      executionId: 'contributor-b',
      status: 'succeeded',
      result: { content: 'Second contribution' },
      message: {
        role: 'assistant',
        content: 'Combined public reply',
        sourceIds: ['contributor-a', 'contributor-b'],
      },
    });
    const reply = (await events(f.store, f.scope)).find(
      (event) => event.kind === 'message' && event.attributes.role === 'assistant',
    )!;
    expect(reply).toMatchObject({
      kind: 'message',
      runId: f.run.id,
      operationId: 'work',
      attributes: { role: 'assistant', status: 'complete' },
    });
    expect(reply.executionId).toBeUndefined();
    expect(
      JSON.parse(Buffer.from((await messageEvidence(f, runtime, reply)).content).toString()),
    ).toEqual({
      role: 'assistant',
      status: 'complete',
      content: 'Combined public reply',
      attachments: [],
    });
  } finally {
    await runtime.close();
    await f.close();
  }
});

test('a later message observation never inherits a namespace hidden inside an unsupported fact wrapper', async () => {
  const f = await fixture();
  try {
    await f.plan('future-message', 'model');
    await f.dispatch('future-message');
    await f.store.persistModelPartial({
      ...f.write,
      executionId: 'future-message',
      content: 'First original prefix',
    });
    const row = f.db
      .query<{ cursor: number; trajectory_fact_json: string }, []>(
        "SELECT cursor,trajectory_fact_json FROM change_event WHERE object_id='partial_future-message' ORDER BY cursor DESC LIMIT 1",
      )
      .get()!;
    const future = JSON.parse(row.trajectory_fact_json);
    future.version = 2;
    future.event.messageOriginStoreId = 'UNVERIFIED_FOREIGN_NAMESPACE';
    f.db
      .query('UPDATE change_event SET trajectory_fact_json=? WHERE cursor=?')
      .run(JSON.stringify(future), row.cursor);
    expect(
      (await events(f.store, f.scope)).find((event) => event.sequence === String(row.cursor)),
    ).toMatchObject({ kind: 'unknown', attributes: { reason: 'unsupported_version' } });
    await f.store.persistModelPartial({
      ...f.write,
      executionId: 'future-message',
      content: 'Later original prefix',
    });
    const latest = (await events(f.store, f.scope))
      .filter((event) => event.kind === 'message' && event.executionId === 'future-message')
      .at(-1)!;
    expect(latest).toMatchObject({
      kind: 'message',
      attributes: { messageId: 'partial_future-message' },
    });
    expect(latest.messageOriginStoreId).toBeUndefined();
    expect(JSON.stringify(latest)).not.toContain('UNVERIFIED_FOREIGN_NAMESPACE');
  } finally {
    await f.close();
  }
});

test('retained human interpretation JSON stays private until the original decision seals its public reply on the same message', async () => {
  const f = await fixture(),
    runtime = observer(f);
  try {
    const scope = { expectedStoreId: f.expectedStoreId, sessionId: 's', subjectId: 'user' };
    const raw = await f.store.registerHumanInput({
      ...scope,
      commandId: 'greeting',
      content: '你好',
      contextSelectionId: f.run.contextSelectionId,
      observedRunId: f.run.id,
    });
    const source = {
      kind: 'model_request',
      toolBindings: [],
    };
    const input = { messages: [], tools: [] };
    await f.store.planExecution({
      ...f.write,
      executionId: 'interpret',
      sessionId: 's',
      runId: f.run.id,
      originCommandId: 'work',
      stepId: 'interpret',
      callId: 'interpret',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input,
      decisionSource: source,
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: 'interpret',
      authorization: {
        allowed: true,
        revision: 'policy-1',
        definitionVersion: '1',
        inputDigest: await semanticDigest(input),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    // New interpretation dispatch is retired. Recreate a previously dispatched original
    // record, then exercise the real retained-message and decision write transactions.
    f.db.query('UPDATE execution SET decision_source_json=? WHERE id=?').run(
      JSON.stringify({
        ...source,
        humanInputInterpretation: { inputCommandId: raw.id, inputDigest: raw.requestDigest },
      }),
      'interpret',
    );
    const privateJson = '{"PRIVATE_ROUTING":"secret","answer":"你好！"}';
    await f.store.persistModelPartial({
      ...f.write,
      executionId: 'interpret',
      content: privateJson,
    });
    await f.store.finishExecution({
      ...f.write,
      executionId: 'interpret',
      status: 'succeeded',
      result: { content: privateJson },
      message: { role: 'assistant', content: privateJson, sourceIds: ['interpret'] },
    });
    const before = (await events(f.store, f.scope)).filter(
      (event) => event.kind === 'message' && event.executionId === 'interpret',
    );
    expect(before).toHaveLength(2);
    const pending = await messageEvidence(f, runtime, before.at(-1)!);
    expect(JSON.parse(Buffer.from(pending.content).toString()).content).toBe(
      '输入解释已保存，等待核实原输入的关联。',
    );
    expect(Buffer.from(pending.content).toString()).not.toContain('PRIVATE_ROUTING');
    await f.store.decideHumanInput({
      ...scope,
      inputCommandId: raw.id,
      inputDigest: raw.requestDigest,
      decisionId: 'greeting-decision',
      expectedControlRevision: (await f.store.readHumanWorkState(scope)).controlRevision,
      proposal: {
        relation: 'unresolved',
        purpose: 'clarify',
        targetRootWorkCommandId: null,
        selectionEffect: 'keep',
        basis: { kind: 'model_proposal', instruction: '你好' },
      },
      interpretation: {
        executionId: 'interpret',
        answer: '你好！有什么可以帮你？',
        clarification: null,
      },
    });
    const messages = (await events(f.store, f.scope)).filter(
      (event) => event.kind === 'message' && event.executionId === 'interpret',
    );
    expect(messages).toHaveLength(3);
    expect(messages.at(-1)).toMatchObject({
      sourceEventType: 'human.input_decided',
      kind: 'message',
      messageOriginStoreId: f.expectedStoreId,
      attributes: { messageId: 'partial_interpret', role: 'assistant', status: 'complete' },
    });
    const reply = await messageEvidence(f, runtime, messages.at(-1)!);
    expect(JSON.parse(Buffer.from(reply.content).toString())).toEqual({
      role: 'assistant',
      status: 'complete',
      content: '你好！有什么可以帮你？',
      attachments: [],
    });
    expect(Buffer.from(reply.content).toString()).not.toContain('PRIVATE_ROUTING');
    expect((await messageEvidence(f, runtime, before.at(-1)!)).content).toEqual(pending.content);
    f.db
      .query(
        "UPDATE command SET receipt_json=json_set(receipt_json,'$.observation.answer','LATER WRONG ANSWER') WHERE id='greeting'",
      )
      .run();
    expect((await messageEvidence(f, runtime, messages.at(-1)!)).content).toEqual(reply.content);
  } finally {
    await runtime.close();
    await f.close();
  }
});

async function evidenceOf(
  f: Awaited<ReturnType<typeof fixture>>,
  runtime: ReturnType<typeof createRuntime>,
  event: TrajectoryEvent,
  kind: TrajectoryEvent['evidenceRefs'][number]['kind'],
  upperCursor?: string,
) {
  const ref = event.evidenceRefs.find((ref) => ref.kind === kind)!;
  return runtime.readTrajectoryEvidence({
    ...f.scope,
    upperCursor: upperCursor ?? (await f.store.getMetadata()).lastChangeCursor,
    atCursor: event.sequence,
    eventId: event.eventId,
    evidenceId: ref.evidenceId,
    contentVersion: ref.contentVersion,
  });
}

test('Tool input preserves original JSON values and old versions after cancellation without publishing private parameters in the index', async () => {
  const f = await fixture(),
    runtime = observer(f);
  const inputs: Json[] = [
    null,
    {},
    [],
    false,
    42,
    'original 雪',
    { path: '/original', nested: [null, 'EXACT_PARAMETER'] },
    'large original request 雪\n'.repeat(10000),
  ];
  try {
    for (const [index, input] of inputs.entries())
      await f.store.planExecution({
        ...f.write,
        executionId: `params-${index}`,
        sessionId: 's',
        runId: f.run.id,
        originCommandId: 'work',
        stepId: `params-${index}`,
        callId: `params-${index}`,
        kind: 'tool',
        definitionId: 'tool',
        definitionVersion: '1',
        input,
        decisionSource: f.source,
      });
    const upper = (await f.store.getMetadata()).lastChangeCursor;
    const planned = (await events(f.store, f.scope, upper)).filter(
      (event) => event.kind === 'tool',
    );
    expect(planned).toHaveLength(inputs.length);
    expect(JSON.stringify(planned)).not.toContain('EXACT_PARAMETER');
    const original = await Promise.all(
      planned.map((event) => evidenceOf(f, runtime, event, 'tool_input', upper)),
    );
    expect(original.map((item) => JSON.parse(Buffer.from(item.content).toString()))).toEqual(
      inputs,
    );
    await f.plan('not-a-tool', 'model');
    expect(
      (await events(f.store, f.scope))
        .filter((event) => event.kind === 'model')
        .every((event) => event.evidenceRefs.every((ref) => ref.kind !== 'tool_input')),
    ).toBe(true);
    await f.store.cancelWork({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel-params',
      sessionId: 's',
      subjectId: 'user',
      kind: 'run.cancel',
      runId: f.run.id,
    });
    f.db
      .query("UPDATE execution SET intent_json='\"LATER REPLACEMENT\"' WHERE id LIKE 'params-%'")
      .run();
    for (const [index, event] of planned.entries()) {
      expect((await evidenceOf(f, runtime, event, 'tool_input', upper)).content).toEqual(
        original[index]!.content,
      );
    }
    const event = planned[0]!,
      ref = event.evidenceRefs.find((ref) => ref.kind === 'tool_input')!;
    await failure(
      runtime.readTrajectoryEvidence({
        ...f.scope,
        subjectId: 'stranger',
        upperCursor: upper,
        atCursor: event.sequence,
        eventId: event.eventId,
        evidenceId: ref.evidenceId,
        contentVersion: ref.contentVersion,
      }),
      'trajectory_scope_denied',
    );
    await failure(
      runtime.readTrajectoryEvidence({
        ...f.scope,
        upperCursor: upper,
        atCursor: event.sequence,
        eventId: event.eventId,
        evidenceId: ref.evidenceId,
        contentVersion: 'wrong',
      }),
      'trajectory_evidence_unavailable',
    );
  } finally {
    await runtime.close();
    await f.close();
  }
});

test('original builtin Files receipt seals a closed typed result while arbitrary details and latest receipt cannot replace it', async () => {
  const f = await fixture(undefined, {
      id: 'files.read',
      version: '5',
      extensionId: 'builtin.files',
    }),
    runtime = observer(f);
  try {
    const input = { path: '/original.txt' };
    await f.store.planExecution({
      ...f.write,
      executionId: 'read',
      sessionId: 's',
      runId: f.run.id,
      originCommandId: 'work',
      stepId: 'read',
      callId: 'read',
      kind: 'tool',
      definitionId: 'files.read',
      definitionVersion: '5',
      input,
      decisionSource: f.source,
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: 'read',
      requirements: [],
      freshness: { checked: true, source: f.source },
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '5',
        inputDigest: await semanticDigest(input),
      },
    });
    await f.store.finishExecution({
      ...f.write,
      executionId: 'read',
      status: 'succeeded',
      result: {
        outcome: 'succeeded',
        content: JSON.stringify({
          path: '/original.txt',
          content: 'Original public file',
          executionId: 'read',
          selection: { fromLine: 2, toLine: 4 },
        }),
        details: { PRIVATE_DIAGNOSTIC: 'NEVER_PUBLIC' },
        trajectoryPresentation: { kind: 'browser', text: 'FORGED' },
      },
    });
    const event = (await events(f.store, f.scope))
      .filter((event) => event.executionId === 'read')
      .at(-1)!;
    const original = await evidenceOf(f, runtime, event, 'tool_result');
    expect(JSON.parse(Buffer.from(original.content).toString())).toMatchObject({
      presentation: {
        kind: 'file',
        operation: 'read',
        path: '/original.txt',
        text: 'Original public file',
        startLine: 2,
        endLine: 4,
      },
    });
    expect(Buffer.from(original.content).toString()).not.toContain('NEVER_PUBLIC');
    expect(Buffer.from(original.content).toString()).not.toContain('FORGED');
    f.db.query("UPDATE execution SET result_json='{}' WHERE id='read'").run();
    expect((await evidenceOf(f, runtime, event, 'tool_result')).content).toEqual(original.content);
  } finally {
    await runtime.close();
    await f.close();
  }
});

async function compressionModel(
  f: Awaited<ReturnType<typeof fixture>>,
  trigger: 'automatic' | 'manual',
  executionId: string,
  run = f.run,
  measurement?: Omit<
    import('@kite-ai/trajectory').CompressionPresentation,
    'adopted' | 'accounting'
  >,
) {
  const pending = await f.store.beginCompression({
    ...f.write,
    runId: run.id,
    executionId,
    expectedContextSelectionId: run.contextSelectionId,
    trigger,
    ...(measurement ? { measurement } : {}),
    compressor: { id: 'fixture', version: '1', snapshot: null },
  });
  const source = { kind: 'context_compression', compressionId: pending.id };
  await f.store.planExecution({
    ...f.write,
    executionId,
    sessionId: 's',
    runId: run.id,
    originCommandId: run.originCommandId,
    stepId: executionId,
    callId: executionId,
    kind: 'model',
    definitionId: 'fixed',
    definitionVersion: '1',
    input: {},
    decisionSource: source,
  });
  return {
    pending,
    dispatch: () =>
      f.store.markDispatching({
        ...f.write,
        executionId,
        authorization: {
          allowed: true,
          revision: 'policy-1',
          definitionVersion: '1',
          inputDigest: f.inputDigest,
        },
        requirements: [],
        freshness: { checked: true, source },
      }),
  };
}

for (const trigger of ['automatic', 'manual'] as const)
  test(`${trigger} compression seals its exact Model lifecycle and published context association`, async () => {
    const f = await fixture();
    try {
      let run = f.run;
      if (trigger === 'manual') {
        await f.store.finishRun({
          ...f.write,
          runId: run.id,
          status: 'completed',
          requirements: [],
        });
        await f.store.acceptCommand({
          expectedStoreId: f.expectedStoreId,
          commandId: 'manual-compress',
          sessionId: 's',
          subjectId: 'user',
          request: { kind: 'context.compress', expectedContextSelectionId: run.contextSelectionId },
        });
        run = await f.store.startRun({
          ...f.write,
          commandId: 'manual-compress',
          configuration: {},
        });
      }
      const executionId = `summary-${trigger}`;
      const compression = await compressionModel(f, trigger, executionId, run, {
        triggerTokens: 1900,
        triggerBasis: 'reported_baseline',
        measuredInputTokens: 1800,
        estimatedInputTokens: 100,
        thresholdTokens: 1700,
      });
      await compression.dispatch();
      await f.store.finishExecution({
        ...f.write,
        executionId,
        status: 'succeeded',
        result: {
          content: 'Private summary',
          reasoning: 'NEVER_COMPRESSION_REASONING',
          usage: { inputTokens: 99, outputTokens: 33 },
        },
        message: { role: 'assistant', content: 'Private summary', sourceIds: [executionId] },
      });
      const before = await f.store.openTrajectory(f.scope);
      const unpublished = await events(f.store, f.scope, before.upperCursor);
      expect(unpublished.some((event) => event.sourceEventType === 'context.compressed')).toBe(
        false,
      );
      await f.store.commitCompression({
        ...f.write,
        runId: run.id,
        compressionId: compression.pending.id,
        accounting: { basis: 'local-context-estimate-v1', beforeTokens: 1000, afterTokens: 200 },
      });
      const all = await events(f.store, f.scope);
      const modelFacts = all.filter(
        (event) => event.kind === 'model' && event.executionId === executionId,
      );
      expect(modelFacts.map((event) => event.sourceEventType)).toContain('execution.planned');
      expect(modelFacts.map((event) => event.sourceEventType)).toContain('execution.finished');
      for (const event of modelFacts)
        expect(event).toMatchObject({
          schemaVersion: 1,
          runId: run.id,
          attributes: { compressionId: compression.pending.id, compressionTrigger: trigger },
        });
      for (const event of modelFacts)
        if (event.kind === 'model')
          expect(event.attributes.compression).toEqual({
            adopted: false,
            triggerTokens: 1900,
            triggerBasis: 'reported_baseline',
            measuredInputTokens: 1800,
            estimatedInputTokens: 100,
            thresholdTokens: 1700,
          });
      expect(all.find((event) => event.sourceEventType === 'context.compressed')).toMatchObject({
        kind: 'context',
        executionId,
        executionOriginStoreId: f.expectedStoreId,
        runId: run.id,
        runOriginStoreId: f.expectedStoreId,
        attributes: {
          action: 'compressed',
          selectionId: run.contextSelectionId,
          compressionId: compression.pending.id,
          compressionTrigger: trigger,
          compression: {
            adopted: true,
            accounting: {
              basis: 'local-context-estimate-v1',
              beforeTokens: 1000,
              afterTokens: 200,
            },
            triggerTokens: 1900,
            triggerBasis: 'reported_baseline',
            measuredInputTokens: 1800,
            estimatedInputTokens: 100,
            thresholdTokens: 1700,
          },
        },
      });
      const runtime = observer(f);
      try {
        const published = all.find((event) => event.sourceEventType === 'context.compressed')!;
        const summary = await evidenceOf(f, runtime, published, 'model_output');
        expect(JSON.parse(Buffer.from(summary.content).toString())).toEqual({
          content: 'Private summary',
          complete: true,
        });
        f.db
          .query('UPDATE execution SET result_json=? WHERE id=?')
          .run(JSON.stringify({ content: 'LATER SUMMARY' }), executionId);
        expect((await evidenceOf(f, runtime, published, 'model_output')).content).toEqual(
          summary.content,
        );
        expect(await events(f.store, f.scope, before.upperCursor)).toEqual(unpublished);
      } finally {
        await runtime.close();
      }
    } finally {
      await f.close();
    }
  });

test('failed compression keeps its classification before publication and ordinary Models stay unclassified', async () => {
  const f = await fixture();
  try {
    await f.plan('ordinary', 'model');
    const compression = await compressionModel(f, 'automatic', 'failed-summary');
    await compression.dispatch();
    await f.store.finishExecution({
      ...f.write,
      executionId: 'failed-summary',
      status: 'failed',
      result: { outcome: 'failed', content: 'fixture failure' },
    });
    const all = await events(f.store, f.scope);
    expect(
      all.find((event) => event.executionId === 'failed-summary' && event.phase === 'failed'),
    ).toMatchObject({
      kind: 'model',
      attributes: { compressionId: compression.pending.id, compressionTrigger: 'automatic' },
    });
    const ordinary = all.find((event) => event.executionId === 'ordinary')!;
    expect(ordinary.attributes).not.toHaveProperty('compressionId');
    expect(ordinary.attributes).not.toHaveProperty('compressionTrigger');
    expect(all.some((event) => event.sourceEventType === 'context.compressed')).toBe(false);
  } finally {
    await f.close();
  }
});

test('compression classification validates original scope and ignores malformed or unknown metadata without rewriting sealed facts', async () => {
  const f = await fixture();
  try {
    const mismatches = [
      { id: 'other-compression' },
      { sessionId: 'other-session' },
      { modelExecutionId: 'other-model' },
      { runId: 'other-run' },
      { contextSelectionId: 'other-selection' },
      { originStoreId: 'other-origin' },
      { trigger: 'unknown' },
      { trigger: { private: 'not a scalar' } },
      { trigger: ['automatic'] },
      null,
    ];
    for (const [index, mismatch] of mismatches.entries()) {
      const executionId = `invalid-summary-${index}`;
      const compression = await compressionModel(f, 'automatic', executionId);
      const upper = (await f.store.openTrajectory(f.scope)).upperCursor;
      const original = await events(f.store, f.scope, upper);
      f.db
        .query('UPDATE context_snapshot SET request_json=? WHERE id=?')
        .run(
          mismatch === null
            ? '{invalid JSON'
            : JSON.stringify({ ...compression.pending, ...mismatch }),
          compression.pending.id,
        );
      await compression.dispatch();
      await f.store.finishExecution({
        ...f.write,
        executionId,
        status: 'failed',
        result: { content: 'fixture failure' },
      });
      const later = (await events(f.store, f.scope)).filter(
        (event) => event.executionId === executionId && BigInt(event.sequence) > BigInt(upper),
      );
      expect(later.length).toBeGreaterThan(0);
      for (const event of later) {
        expect(event.attributes).not.toHaveProperty('compressionId');
        expect(event.attributes).not.toHaveProperty('compressionTrigger');
      }
      expect(await events(f.store, f.scope, upper)).toEqual(original);
    }
    const valid = await compressionModel(f, 'automatic', 'extended-summary');
    f.db
      .query('UPDATE context_snapshot SET request_json=? WHERE id=?')
      .run(
        JSON.stringify({ ...valid.pending, privateFutureField: { token: 'must stay private' } }),
        valid.pending.id,
      );
    await valid.dispatch();
    const latest = (await events(f.store, f.scope))
      .filter((event) => event.executionId === 'extended-summary')
      .at(-1)!;
    expect(latest.attributes).toMatchObject({
      compressionId: valid.pending.id,
      compressionTrigger: 'automatic',
    });
    expect(JSON.stringify(latest)).not.toContain('must stay private');
    expect(latest.attributes).not.toHaveProperty('privateFutureField');
  } finally {
    await f.close();
  }
});

test('old V1 facts without compression metadata remain unchanged when later lifecycle facts are classified', async () => {
  const f = await fixture();
  try {
    const compression = await compressionModel(f, 'automatic', 'upgraded-summary');
    f.db
      .query(
        "UPDATE change_event SET trajectory_fact_json=json_remove(trajectory_fact_json,'$.event.attributes.compressionId','$.event.attributes.compressionTrigger') WHERE object_id=? AND type='execution.planned'",
      )
      .run('upgraded-summary');
    const upper = (await f.store.openTrajectory(f.scope)).upperCursor;
    const old = await events(f.store, f.scope, upper);
    expect(
      old.find((event) => event.executionId === 'upgraded-summary')!.attributes,
    ).not.toHaveProperty('compressionTrigger');
    await compression.dispatch();
    expect(
      (await events(f.store, f.scope))
        .filter((event) => event.executionId === 'upgraded-summary')
        .at(-1),
    ).toMatchObject({
      schemaVersion: 1,
      attributes: { compressionId: compression.pending.id, compressionTrigger: 'automatic' },
    });
    expect(await events(f.store, f.scope, upper)).toEqual(old);
  } finally {
    await f.close();
  }
});

test('a real business transaction rollback removes its sealed event and Evidence binding together', async () => {
  const f = await fixture();
  try {
    const before = await f.store.getMetadata(),
      original = await events(f.store, f.scope);
    const bindings = () =>
      f.db
        .query<{ count: number }, []>(
          "SELECT COALESCE(SUM(json_array_length(json_extract(trajectory_fact_json,'$.bindings'))),0) AS count FROM change_event",
        )
        .get()!.count;
    const beforeBindings = bindings();
    f.db.exec(
      "CREATE TRIGGER trajectory_rollback AFTER INSERT ON change_event WHEN NEW.object_id='rolled-back' AND NEW.type='execution.planned' BEGIN SELECT RAISE(ABORT,'trajectory fixture rollback'); END",
    );
    await failure(f.plan('rolled-back', 'model'));
    expect(await f.store.getExecution('rolled-back')).toBeNull();
    expect(
      f.db.query("SELECT cursor FROM change_event WHERE object_id='rolled-back'").all(),
    ).toEqual([]);
    expect(bindings()).toBe(beforeBindings);
    expect(await f.store.getMetadata()).toEqual(before);
    expect(await events(f.store, f.scope)).toEqual(original);
    f.db.exec('DROP TRIGGER trajectory_rollback');
    await f.plan('committed', 'model');
    const sealed = (await events(f.store, f.scope)).find(
      (event) => event.executionId === 'committed',
    )!;
    expect(sealed.kind).toBe('model');
    expect(sealed.evidenceRefs.some((ref) => ref.kind === 'model_input')).toBe(true);
    expect(bindings()).toBeGreaterThan(beforeBindings);
  } finally {
    await f.close();
  }
});

test('cancel request is cancelling until the actual terminal result, and the fixed earlier facts do not become success', async () => {
  const f = await fixture();
  try {
    await f.plan('tool');
    await f.dispatch('tool');
    await f.store.cancelWork({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      subjectId: 'user',
      kind: 'run.cancel',
      runId: f.run.id,
    });
    const pending = await f.store.openTrajectory(f.scope),
      pendingEvents = await events(f.store, f.scope, pending.upperCursor);
    const cancelRun = pendingEvents
      .filter((event) => event.kind === 'run' && event.runId === f.run.id)
      .at(-1)!;
    const cancelTool = pendingEvents
      .filter((event) => event.executionId === 'tool' && event.kind === 'tool')
      .at(-1)!;
    expect(cancelRun.phase).toBe('cancelling');
    expect(cancelTool.phase).toBe('cancelling');
    expect(cancelRun.recordedStatus).toBe('running');
    expect(cancelTool.recordedStatus).toBe('dispatching');
    expect((await f.store.getRun(f.run.id))!.isActive).toBe(true);
    expect(
      pendingEvents.some((event) => event.executionId === 'tool' && event.phase === 'completed'),
    ).toBe(false);
    await f.store.finishExecution({
      ...f.write,
      executionId: 'tool',
      status: 'cancelled',
      result: { outcome: 'cancelled', content: 'stopped' },
    });
    await f.store.finishRun({ ...f.write, runId: f.run.id, status: 'cancelled', requirements: [] });
    const final = await events(f.store, f.scope);
    expect(
      final.find(
        (event) => event.sourceEventType === 'execution.finished' && event.executionId === 'tool',
      ),
    ).toMatchObject({ phase: 'cancelled', recordedStatus: 'cancelled' });
    expect(final.filter((event) => event.kind === 'run').at(-1)).toMatchObject({
      phase: 'cancelled',
      recordedStatus: 'cancelled',
    });
    expect(
      final.some(
        (event) =>
          (event.kind === 'run' || event.executionId === 'tool') && event.phase === 'completed',
      ),
    ).toBe(false);
    expect(await events(f.store, f.scope, pending.upperCursor)).toEqual(pendingEvents);
  } finally {
    await f.close();
  }
});

test('Interaction requested, answered and accepted preserve original revisions and exact as-of Evidence', async () => {
  const f = await fixture();
  try {
    await f.plan('tool');
    const request = {
      ...f.write,
      interactionId: 'approval',
      executionId: 'tool',
      attempt: 1,
      kind: 'approval' as const,
      definitionId: 'tool',
      definitionVersion: '1',
      inputDigest: f.inputDigest,
      policyRevision: 'policy-1',
      requiredRefs: [],
      source: f.source,
      request: {
        title: 'Original request',
        options: [{ optionId: 'once', kind: 'once', presentation: { label: 'Once', details: [] } }],
      },
    };
    await f.store.requestInteraction(request);
    const requested = await f.store.openTrajectory(f.scope),
      requestedEvents = await events(f.store, f.scope, requested.upperCursor);
    const waiting = requestedEvents.find(
      (event) => event.sourceEventType === 'interaction.requested',
    )!;
    expect(waiting).toMatchObject({
      kind: 'interaction',
      phase: 'waiting_interaction',
      recordedStatus: 'pending',
      sourceRecordRevision: '1',
      attributes: { revision: '1', decision: 'requested', interactionKind: 'approval' },
    });
    expect((await f.store.getRun(f.run.id))!.status).toBe('waiting_interaction');
    const evidence = waiting.evidenceRefs.find((ref) => ref.kind === 'interaction')!;
    const open = {
      ...f.scope,
      upperCursor: requested.upperCursor,
      atCursor: waiting.sequence,
      eventId: waiting.eventId,
      evidenceId: evidence.evidenceId,
      contentVersion: evidence.contentVersion,
    };
    const originalBinding = await f.store.readTrajectoryBinding(open);
    expect(originalBinding.binding.value).toMatchObject({ revision: '1', answer: null });
    const answer = {
      expectedStoreId: f.expectedStoreId,
      commandId: 'answer',
      presentationSessionId: 's',
      interactionId: 'approval',
      expectedRevision: '1',
      subjectId: 'user',
      answer: { kind: 'approval' as const, decision: 'approve' as const, optionId: 'once' },
    };
    const receipt = await f.store.answerInteraction(answer);
    expect(await f.store.answerInteraction(answer)).toEqual(receipt);
    await f.store.acceptInteractionDecision({
      ...f.write,
      interactionId: 'approval',
      executionId: 'tool',
      attempt: 1,
      decisionRevision: '2',
      definitionId: 'tool',
      definitionVersion: '1',
      inputDigest: f.inputDigest,
      policyRevision: 'policy-1',
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const all = await events(f.store, f.scope),
      interactions = all.filter((event) => event.kind === 'interaction');
    expect(interactions.every((event) => event.attributes.interactionKind === 'approval')).toBe(
      true,
    );
    expect(
      interactions.map((event) => [
        event.sourceEventType,
        event.sourceRecordRevision,
        event.kind === 'interaction' ? event.attributes.revision : null,
      ]),
    ).toEqual([
      ['interaction.requested', '1', '1'],
      ['interaction.answered', '2', '2'],
      ['interaction.accepted', '2', '2'],
    ]);
    expect((await f.store.getRun(f.run.id))!.status).toBe('running');
    for (const decision of ['answered', 'accepted'] as const) {
      const event = interactions.find(
        (value) => value.sourceEventType === `interaction.${decision}`,
      )!;
      const ref = event.evidenceRefs.find((value) => value.kind === 'interaction')!;
      expect(ref.contentVersion).not.toBe(evidence.contentVersion);
      const binding = await f.store.readTrajectoryBinding({
        ...f.scope,
        upperCursor: (await f.store.openTrajectory(f.scope)).upperCursor,
        atCursor: event.sequence,
        eventId: event.eventId,
        evidenceId: ref.evidenceId,
        contentVersion: ref.contentVersion,
      });
      expect(binding.binding.value).toMatchObject({
        revision: '2',
        answer: answer.answer,
        acceptedDecisionRevision: decision === 'accepted' ? '2' : null,
      });
    }
    expect(await f.store.readTrajectoryBinding(open)).toEqual(originalBinding);
    expect(await events(f.store, f.scope, requested.upperCursor)).toEqual(requestedEvents);
  } finally {
    await f.close();
  }
});

for (const kind of ['question', 'plan_review'] as const)
  test(`${kind} interactions retain their explicit original kind without exposing request fields`, async () => {
    const f = await fixture();
    try {
      await f.plan('tool');
      await f.dispatch('tool');
      await f.store.requestInteraction({
        ...f.write,
        interactionId: 'information',
        executionId: 'tool',
        attempt: 1,
        kind,
        definitionId: 'tool',
        definitionVersion: '1',
        inputDigest: f.inputDigest,
        policyRevision: 'policy-1',
        requiredRefs: [],
        source: f.source,
        request: { content: 'Private request', futureField: { token: 'must stay private' } },
      });
      const fact = (await events(f.store, f.scope)).find(
        (event) => event.sourceEventType === 'interaction.requested',
      )!;
      expect(fact).toMatchObject({ kind: 'interaction', executionId: 'tool', runId: f.run.id });
      expect(fact.attributes).toEqual({
        interactionId: 'information',
        interactionKind: kind,
        revision: '1',
        decision: 'requested',
      });
      expect(JSON.stringify(fact)).not.toContain('must stay private');
      expect(fact.evidenceRefs.some((ref) => ref.kind === 'interaction')).toBe(true);
    } finally {
      await f.close();
    }
  });

test('actual child facts stay in their original Session and parent scope cannot open child Execution or Evidence', async () => {
  const f = await fixture();
  try {
    await f.plan('carrier');
    await f.dispatch('carrier');
    const child = await f.store.ensureOperation({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'carrier',
      operationKey: 'child',
      cancellation: 'detached',
      request: { kind: 'agent', configurationId: 'child', input: {} },
      childConfiguration: { id: 'child', version: '1', snapshot: f.configuration },
    });
    await f.dispatch(child.executionId!);
    const active = await f.store.activateChildRun({
      ...f.write,
      executionId: child.executionId!,
      configuration: f.configuration,
      requirementEvaluations: [],
      freshness: { checked: true, source: f.source },
    });
    await f.plan('child-model', 'model', child.childSessionId!, active.run.id, active.command.id);
    const childScope = { ...f.scope, sessionId: child.childSessionId! };
    const snapshot = await f.store.openTrajectory(childScope),
      childEvents = await events(f.store, childScope, snapshot.upperCursor),
      parentEvents = await events(f.store, f.scope, snapshot.upperCursor);
    expect(childEvents.length).toBeGreaterThan(0);
    expect(childEvents.every((event) => event.sessionId === child.childSessionId)).toBe(true);
    expect(parentEvents.every((event) => event.sessionId === 's')).toBe(true);
    expect(parentEvents.some((event) => event.executionId === 'child-model')).toBe(false);
    expect(
      parentEvents.some(
        (event) => event.kind === 'job' && event.attributes.childSessionId === child.childSessionId,
      ),
    ).toBe(true);
    await failure(
      f.store.openTrajectory({ ...f.scope, executionId: 'child-model' }),
      'trajectory_scope_denied',
    );
    await failure(
      f.store.openTrajectory({ ...childScope, runId: f.run.id }),
      'trajectory_scope_denied',
    );
    const model = childEvents.find((event) => event.executionId === 'child-model')!,
      ref = model.evidenceRefs.find((value) => value.kind === 'model_input')!;
    const binding = {
      ...childScope,
      upperCursor: snapshot.upperCursor,
      atCursor: model.sequence,
      eventId: model.eventId,
      evidenceId: ref.evidenceId,
      contentVersion: ref.contentVersion,
    };
    expect((await f.store.readTrajectoryBinding(binding)).event.eventId).toBe(model.eventId);
    await failure(
      f.store.readTrajectoryBinding({ ...binding, sessionId: 's' }),
      'trajectory_evidence_unavailable',
    );
  } finally {
    await f.close();
  }
});

for (const mode of ['committed', 'dispatching'] as const)
  test(`SIGKILL after original ${mode} commit survives readonly reopen before delivery and preserves recovery history`, async () => {
    const dataRoot = temporaryDirectory('kite-trajectory-crash-');
    chmodSync(dataRoot, 0o700);
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./trajectory-flow-writer-fixture.ts', import.meta.url)),
        dataRoot,
        mode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let observer: SqliteStore | undefined,
      writer: SqliteStore | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = child.stdout.getReader();
      let text = '';
      const readReady = async () => {
        while (!text.includes('\n')) {
          const value = await reader.read();
          if (value.done)
            throw Error(`writer ended before commit: ${await new Response(child.stderr).text()}`);
          text += new TextDecoder().decode(value.value);
        }
        return JSON.parse(text.slice(0, text.indexOf('\n'))) as {
          expectedStoreId: string;
          owner: OwnerRef;
          runId: string;
          eventId: string;
          cursor: string;
          kind: string;
          phase: string;
        };
      };
      const ready = await Promise.race([
        readReady(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('writer commit timeout')), 10000);
        }),
      ]);
      clearTimeout(timer);
      expect(ready.phase).toBe(mode === 'committed' ? 'planned' : 'dispatching');
      expect(ready.kind).toBe(mode === 'committed' ? 'model' : 'tool');
      child.kill('SIGKILL');
      await child.exited;
      observer = await openSqliteStore({ dataRoot, profile: 'flow', mode: 'readonly' });
      const scope = { storeId: ready.expectedStoreId, sessionId: 's', subjectId: 'user' };
      const cold = await events(observer, scope, ready.cursor),
        original = cold.find((event) => event.eventId === ready.eventId)!;
      expect(original).toMatchObject({
        eventId: ready.eventId,
        sequence: ready.cursor,
        kind: mode === 'committed' ? 'model' : 'tool',
        phase: ready.phase,
        executionId: 'original',
      });
      if (mode === 'committed') {
        const ref = original.evidenceRefs.find((value) => value.kind === 'model_input')!;
        expect(
          (
            await observer.readTrajectoryBinding({
              ...scope,
              upperCursor: ready.cursor,
              atCursor: ready.cursor,
              eventId: ready.eventId,
              evidenceId: ref.evidenceId,
              contentVersion: ref.contentVersion,
            })
          ).binding.value,
        ).toMatchObject({ input: { requestId: 'original' } });
      } else {
        writer = await openSqliteStore({ dataRoot, profile: 'flow' });
        const recovery = {
          expectedStoreId: ready.expectedStoreId,
          commandId: 'recover',
          sessionId: 's',
          subjectId: 'user',
          expectedOwnerGeneration: ready.owner.generation,
          decision: 'interrupt' as const,
        };
        const report = await writer.recoverSession(recovery);
        expect(report.unknownExecutionIds).toEqual(['original']);
        const recoveredSnapshot = await observer.openTrajectory(scope),
          recovered = await events(observer, scope, recoveredSnapshot.upperCursor);
        const unknown = recovered.find(
          (event) =>
            event.sourceEventType === 'execution.recovered' && event.executionId === 'original',
        )!;
        expect(unknown).toMatchObject({
          kind: 'tool',
          phase: 'outcome_unknown',
          recordedStatus: 'outcome_unknown',
        });
        expect(
          recovered.find((event) => event.sourceEventType === 'session.recovered'),
        ).toMatchObject({ kind: 'recovery', attributes: { outcome: 'interrupted' } });
        expect(recovered.find((event) => event.eventId === ready.eventId)).toEqual(original);
        await writer.acceptCommand({
          expectedStoreId: ready.expectedStoreId,
          commandId: 'later',
          sessionId: 's',
          subjectId: 'user',
          request: { kind: 'run.start', content: 'new explicit intent' },
        });
        expect(
          (await events(observer, scope)).find((event) => event.eventId === unknown.eventId),
        ).toEqual(unknown);
        expect(await events(observer, scope, recoveredSnapshot.upperCursor)).toEqual(recovered);
        expect(await writer.recoverSession(recovery)).toEqual(report);
      }
      expect(await events(observer, scope, ready.cursor)).toEqual(cold);
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
      await child.exited;
      await observer?.close();
      await writer?.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 15000);
