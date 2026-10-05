import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createPlanningValidation } from '../../../src/business/planning';
import type { ToolContext, ToolResult } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionRecord, Json, RunRecord } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: Json): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
async function fixture(
  script: (step: number, f: Awaited<ReturnType<typeof fixture>>) => Promise<ModelEvent[]>,
  options: {
    enabled?: boolean;
    checkerAllowed?: boolean;
    askWrites?: boolean;
    ambiguousWrite?: boolean;
    onRead?: (context: ToolContext, result: ToolResult) => Promise<void>;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-auto-validation-'))),
    store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' }),
    files = createWorkspaceFiles({ root });
  const planning = createPlanningValidation({
    ...(options.enabled === false
      ? {}
      : {
          automaticValidation: {
            mutations: [
              { definitionId: 'files.write', definitionVersion: '2', effects: ['workspace_write'] },
              { definitionId: 'files.edit', definitionVersion: '2', effects: ['workspace_write'] },
            ],
            fileHashChecker: { definitionId: 'files.read', definitionVersion: '3' },
          },
        }),
  });
  let modelCalls = 0,
    reads = 0;
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      signal.throwIfAborted();
      for (const event of await script(modelCalls++, f)) yield event;
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    extensions: [
      planning.extension,
      {
        id: 'builtin.files',
        version: '1',
        apiMajor: 1,
        tools: createFileTools(files).map((tool) =>
          tool.id === 'files.read' && options.onRead
            ? {
                ...tool,
                async execute(input, context) {
                  const result = await tool.execute(input, context);
                  await options.onRead!(context, result);
                  return result;
                },
              }
            : tool.id === 'files.write' && options.ambiguousWrite
              ? {
                  ...tool,
                  async execute(input, context) {
                    await tool.execute(input, context);
                    return {
                      outcome: 'outcome_unknown' as const,
                      content: 'publication_ack_unconfirmed',
                    };
                  },
                }
              : tool,
        ),
      },
    ],
    initializeRunRequirements: planning.initializeRequirements,
    conditions: planning.conditions,
    permissions: {
      async authorize(request) {
        if (options.askWrites && request.definitionId === 'files.write')
          return {
            allowed: false,
            revision: '1',
            approval: { request: { title: 'Actual governed write' } },
          };
        if (request.definitionId === 'files.read') {
          reads++;
          if (options.checkerAllowed === false)
            return { allowed: false, revision: '1', reason: 'test_deny' };
        }
        return { allowed: true, revision: '1' };
      },
    },
  });
  const metadata = await store.getMetadata();
  await runtime.createWorkspace({
    expectedStoreId: metadata.storeId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'temporary',
  });
  await runtime.createSession({
    expectedStoreId: metadata.storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'u',
    title: 'automatic',
  });
  const f = {
    root,
    store,
    files,
    runtime,
    metadata,
    get modelCalls() {
      return modelCalls;
    },
    get reads() {
      return reads;
    },
    async submit() {
      await runtime.submitCommand({
        expectedStoreId: metadata.storeId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'u',
        request: { kind: 'run.start', content: 'write and verify' },
      });
    },
    async done(timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const command = await store.getCommand('work');
        const run =
          command?.receipt &&
          typeof command.receipt === 'object' &&
          !Array.isArray(command.receipt) &&
          typeof command.receipt.runId === 'string'
            ? await store.getRun(command.receipt.runId)
            : null;
        if (run && !run.isActive) return run;
        if (Date.now() > until) throw new Error('automatic_validation_timeout');
        await Bun.sleep(5);
      }
    },
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}
function mutationRef(run: RunRecord) {
  return run.requirements.find((ref) => ref.requirementId === 'mutation.required')!;
}
test('real mutation followed immediately by Model stop is checked without a second Model or explicit validation call', async () => {
  const f = await fixture(async (step) =>
    step === 0 ? call('files.write', { path: 'out.txt', content: 'actual', base: null }) : [finish],
  );
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('completed');
    expect(f.modelCalls).toBe(2);
    expect(f.reads).toBeGreaterThan(0);
    expect(run.requirements).toHaveLength(1);
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts).toHaveLength(1);
    expect(page.facts[0]!.status).toBe('succeeded');
    expect(page.facts[0]!.check?.outcome).toBe('passed');
    const messages = await f.store.listMessages('s');
    expect(
      messages.some(
        (message) => message.role === 'user' && message.content.includes('automatic_verification'),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 10000);
test('a changed file causes a new same-Loop repair turn and a fresh exact check; immutable mutation facts remain', async () => {
  const f = await fixture(async (step, f) => {
    if (step === 0)
      return call('files.write', { path: 'out.txt', content: 'expected', base: null });
    if (step === 1) {
      writeFileSync(join(f.root, 'out.txt'), 'external change');
      return [finish];
    }
    if (step === 2) {
      const base = (await f.files.read('out.txt')).baseline;
      return call('files.write', {
        path: 'out.txt',
        content: 'expected',
        base: base as unknown as Json,
      });
    }
    return [finish];
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('completed');
    expect(f.modelCalls).toBe(4);
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts).toHaveLength(2);
    expect(page.facts.map((fact) => fact.check?.outcome)).toEqual(['superseded', 'passed']);
    expect((await f.files.read('out.txt')).content).toBe('expected');
  } finally {
    await f.close();
  }
}, 10000);
test('missing checker permission cannot become completion and an unchanged failure does not endlessly call Model', async () => {
  const f = await fixture(
    async (step) =>
      step === 0
        ? call('files.write', { path: 'out.txt', content: 'actual', base: null })
        : [finish],
    { checkerAllowed: false },
  );
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('failed');
    expect(f.modelCalls).toBe(3);
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts[0]!.check?.outcome).toBe('inconclusive');
  } finally {
    await f.close();
  }
}, 10000);
test('automatic governance remains off for ordinary mutation without an enabled host policy', async () => {
  const f = await fixture(
    async (step) =>
      step === 0
        ? call('files.write', { path: 'out.txt', content: 'actual', base: null })
        : [finish],
    { enabled: false },
  );
  try {
    await f.submit();
    expect((await f.done()).status).toBe('completed');
    expect(f.reads).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test('a new mutation after an explicit passed check invalidates completion until its own exact check', async () => {
  const f = await fixture(async (step, f) => {
    if (step === 0) return call('files.write', { path: 'out.txt', content: 'first', base: null });
    if (step === 1) {
      const command = await f.store.getCommand('work'),
        run = await f.store.getRun(String((command!.receipt as { runId: string }).runId));
      const page = await f.store.listMutationFacts({
        expectedStoreId: f.metadata.storeId,
        requirement: mutationRef(run!),
      });
      return call('validation.auto_check', {
        runId: run!.id,
        mutationExecutionId: page.facts[0]!.executionId,
        headRevision: page.headRevision,
        seq: '1',
      });
    }
    if (step === 2) {
      const base = (await f.files.read('out.txt')).baseline;
      return call('files.write', {
        path: 'out.txt',
        content: 'second',
        base: base as unknown as Json,
      });
    }
    return [finish];
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('completed');
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.highWaterSeq).toBe('2');
    expect(page.facts.every((fact) => fact.check?.outcome === 'passed')).toBe(true);
    expect(f.reads).toBeGreaterThanOrEqual(2);
    expect((await f.files.read('out.txt')).content).toBe('second');
  } finally {
    await f.close();
  }
}, 15000);
test('settlement record failure rolls back the true terminal with its event; the published file is not silently retried', async () => {
  let database: Database | undefined;
  const f = await fixture(async (step, f) => {
    if (step === 0) {
      database = new Database(join(f.root, 'data', 'new', 'core.db'));
      database.run(
        "CREATE TRIGGER settlement_fault BEFORE INSERT ON extension_record WHEN NEW.key LIKE '%/mutation/settled/%' BEGIN SELECT RAISE(ABORT,'settlement fault'); END",
      );
      return call('files.write', { path: 'out.txt', content: 'actual', base: null });
    }
    return [finish];
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('failed');
    expect(f.modelCalls).toBe(1);
    expect((await f.files.read('out.txt')).content).toBe('actual');
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts).toHaveLength(1);
    expect(page.facts[0]!.status).toBe('dispatching');
    expect(page.facts[0]!.resultRevision).toBe('0');
    expect(
      database!
        .query("SELECT count(*) AS n FROM extension_record WHERE key LIKE '%/mutation/settled/%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      database!
        .query(
          "SELECT count(*) AS n FROM change_event WHERE type='execution.finished' AND object_id=?",
        )
        .get(page.facts[0]!.executionId),
    ).toEqual({ n: 0 });
    expect(page.facts[0]!.check).toBeNull();
  } finally {
    database?.close();
    await f.close();
  }
}, 10000);
test('intent registration rollback denies dispatch with zero file publication', async () => {
  let database: Database | undefined;
  const f = await fixture(async (step, f) => {
    if (step === 0) {
      database = new Database(join(f.root, 'data', 'new', 'core.db'));
      database.run(
        "CREATE TRIGGER intent_fault BEFORE INSERT ON extension_record WHEN NEW.key LIKE '%/mutation/intent/%' BEGIN SELECT RAISE(ABORT,'intent fault'); END",
      );
      return call('files.write', { path: 'out.txt', content: 'actual', base: null });
    }
    return [finish];
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(existsSync(join(f.root, 'out.txt'))).toBe(false);
    const executions = await f.store.listExecutions('s', 100);
    expect(executions.find((execution) => execution.definitionId === 'files.write')!.status).toBe(
      'failed',
    );
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts).toHaveLength(0);
    expect(page.headRevision).toBeNull();
  } finally {
    database?.close();
    await f.close();
  }
}, 10000);
test('a checker paused after its actual read cannot overwrite a newly registered mutation head', async () => {
  const readReached = gate(),
    readRelease = gate();
  const f = await fixture(
    async (step) =>
      step === 0
        ? call('files.write', { path: 'out.txt', content: 'actual', base: null })
        : [finish],
    {
      onRead: async () => {
        readReached.release();
        await readRelease.promise;
      },
    },
  );
  try {
    await f.submit();
    await readReached.promise;
    const command = await f.store.getCommand('work'),
      run = await f.store.getRun((command!.receipt as { runId: string }).runId),
      session = await f.store.getSession('s');
    const owner = {
      sessionId: 's',
      instanceId: session!.ownerInstanceId!,
      generation: session!.ownerGeneration,
    };
    const models = (await f.store.listExecutions('s', 100)).filter(
      (execution) => execution.kind === 'model' && execution.status === 'succeeded',
    );
    const model = models.at(-1)!;
    // A real Store intent is admitted while the safe read is paused; it has not dispatched or written a file.
    const executionId = crypto.randomUUID();
    await f.store.planExecution({
      expectedStoreId: f.metadata.storeId,
      owner,
      executionId,
      sessionId: 's',
      runId: run!.id,
      originCommandId: 'work',
      stepId: 'late',
      callId: 'late',
      kind: 'tool',
      definitionId: 'files.write',
      definitionVersion: '2',
      input: { path: 'later.txt', content: 'later', base: null },
      decisionSource: { kind: 'model_decision', modelExecutionId: model.id, sources: [] },
    });
    await f.store.registerMutationIntent({
      expectedStoreId: f.metadata.storeId,
      owner,
      executionId,
      requirement: mutationRef(run!),
      descriptor: { kind: 'file_hash', path: 'later.txt' },
    });
    readRelease.release();
    const terminal = await f.done();
    expect(terminal.status).toBe('failed');
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(terminal),
    });
    expect(page.highWaterSeq).toBe('2');
    expect(page.facts[0]!.check).toBeNull();
    expect(page.facts[1]!.status).toBe('planned');
    expect(existsSync(join(f.root, 'later.txt'))).toBe(false);
  } finally {
    readRelease.release();
    await f.close();
  }
}, 10000);
test('cancellation during an actual checker does not dispatch repair or activate history after readonly reopen', async () => {
  const reached = gate(),
    release = gate();
  const f = await fixture(
    async (step) =>
      step === 0
        ? call('files.write', { path: 'out.txt', content: 'actual', base: null })
        : [finish],
    {
      onRead: async () => {
        reached.release();
        await release.promise;
      },
    },
  );
  try {
    await f.submit();
    await reached.promise;
    await f.runtime.cancelCommand({
      expectedStoreId: f.metadata.storeId,
      commandId: 'cancel',
      sessionId: 's',
      subjectId: 'u',
      targetCommandId: 'work',
    });
    release.release();
    const run = await f.done();
    expect(run.status).toBe('cancelled');
    expect(f.modelCalls).toBe(2);
    await f.runtime.close();
    await f.store.close();
    const readonly = await openSqliteStore({
      dataRoot: join(f.root, 'data'),
      profile: 'new',
      mode: 'readonly',
    });
    try {
      const history = await readonly.listMutationFacts({
        expectedStoreId: f.metadata.storeId,
        requirement: mutationRef(run),
      });
      expect(history.facts).toHaveLength(1);
      expect(history.facts[0]!.status).toBe('succeeded');
      expect(history.facts[0]!.check).toBeNull();
      expect(f.modelCalls).toBe(2);
      let wrongStore: unknown;
      try {
        await readonly.listMutationFacts({
          expectedStoreId: 'wrong',
          requirement: mutationRef(run),
        });
      } catch (error) {
        wrongStore = error;
      }
      expect(wrongStore).toMatchObject({ code: 'store_identity_mismatch' });
    } finally {
      await readonly.close();
    }
  } finally {
    release.release();
    await f.close();
  }
}, 10000);
test('automatic obligation never grants the original mutation permission; human deny publishes no file', async () => {
  const f = await fixture(
    async (step) =>
      step === 0
        ? call('files.write', { path: 'out.txt', content: 'actual', base: null })
        : [finish],
    { askWrites: true },
  );
  try {
    await f.submit();
    let card: InteractionRecord | undefined;
    const until = Date.now() + 5000;
    for (;;) {
      card = (
        await f.runtime.listInteractions({
          expectedStoreId: f.metadata.storeId,
          sessionId: 's',
          state: 'pending',
        })
      ).interactions[0];
      if (card) break;
      if (Date.now() > until) throw new Error('approval_not_created');
      await Bun.sleep(5);
    }
    expect(existsSync(join(f.root, 'out.txt'))).toBe(false);
    await f.runtime.answerInteraction({
      expectedStoreId: f.metadata.storeId,
      commandId: 'deny',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      subjectId: 'u',
      answer: { kind: 'approval', decision: 'deny' },
    });
    const run = await f.done();
    expect(run.status).toBe('cancelled');
    expect(existsSync(join(f.root, 'out.txt'))).toBe(false);
    expect(f.reads).toBe(0);
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts[0]!.status).toBe('failed');
    expect(page.facts[0]!.check).toBeNull();
  } finally {
    await f.close();
  }
}, 10000);
test('Rewind retains original verified history without replaying it into a fresh Run', async () => {
  const f = await fixture(async (step) =>
    step === 0 ? call('files.write', { path: 'out.txt', content: 'actual', base: null }) : [finish],
  );
  try {
    await f.submit();
    const old = await f.done(),
      oldRef = mutationRef(old),
      session = await f.store.getSession('s');
    const beforeReads = f.reads;
    await f.runtime.selectContext({
      expectedStoreId: f.metadata.storeId,
      commandId: 'rewind',
      sessionId: 's',
      subjectId: 'u',
      expectedContextSelectionId: session!.contextSelectionId,
      boundary: null,
    });
    await f.runtime.submitCommand({
      expectedStoreId: f.metadata.storeId,
      commandId: 'new',
      sessionId: 's',
      subjectId: 'u',
      request: { kind: 'run.start', content: 'new explicit work' },
    });
    const next = await f.runtime.waitForCommand('new', { timeoutMs: 5000 });
    const run = await f.store.getRun((next.receipt as { runId: string }).runId);
    expect(run!.status).toBe('completed');
    expect(run!.id).not.toBe(old.id);
    expect(f.reads).toBe(beforeReads);
    const history = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: oldRef,
    });
    expect(history.facts[0]!.check?.outcome).toBe('passed');
    const fresh = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run!),
    });
    expect(fresh.facts).toHaveLength(0);
    expect(fresh.headRevision).toBeNull();
  } finally {
    await f.close();
  }
}, 10000);
test('more than 64 actual mutations use one immutable requirement and bounded sequence pages', async () => {
  const f = await fixture(async (step) => {
    if (step !== 0) return [finish];
    return [
      ...Array.from(
        { length: 65 },
        (_, index) =>
          call('files.write', {
            path: `file-${index}.txt`,
            content: String(index),
            base: null,
          })[0]!,
      ),
      { ...finish, reason: 'tool_calls' },
    ];
  });
  try {
    await f.submit();
    const run = await f.done(60000);
    expect(run.status).toBe('completed');
    expect(run.requirements).toHaveLength(1);
    expect(f.modelCalls).toBe(2);
    const first = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
      limit: 32,
    });
    expect(first.highWaterSeq).toBe('65');
    expect(first.facts).toHaveLength(32);
    expect(first.nextAfterSeq).toBe('32');
    const second = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
      limit: 32,
      afterSeq: first.nextAfterSeq!,
    });
    const final = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
      limit: 32,
      afterSeq: second.nextAfterSeq!,
    });
    expect(final.facts).toHaveLength(1);
    expect(final.facts[0]!.seq).toBe('65');
    expect(
      [...first.facts, ...second.facts, ...final.facts].every(
        (fact) => fact.check?.outcome === 'passed',
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 70000);

test('an actually published but unconfirmed mutation remains unknown and never auto-checks or repairs', async () => {
  const f = await fixture(
    async (step) =>
      step === 0
        ? call('files.write', { path: 'out.txt', content: 'published', base: null })
        : [finish],
    { ambiguousWrite: true },
  );
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('failed');
    expect((await f.files.read('out.txt')).content).toBe('published');
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts).toHaveLength(1);
    expect(page.facts[0]!.status).toBe('outcome_unknown');
    expect(page.facts[0]!.check).toBeNull();
    expect(f.reads).toBe(0);
    expect(f.modelCalls).toBe(1);
  } finally {
    await f.close();
  }
}, 10000);

test('two actual same-path mutations preserve history and verify the latest committed baseline', async () => {
  const f = await fixture(async (step, f) => {
    if (step === 0) return call('files.write', { path: 'out.txt', content: 'v1', base: null });
    if (step === 1)
      return call('files.write', {
        path: 'out.txt',
        content: 'v2',
        base: (await f.files.read('out.txt')).baseline as unknown as Json,
      });
    return [finish];
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('completed');
    expect((await f.files.read('out.txt')).content).toBe('v2');
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts).toHaveLength(2);
    expect(page.facts.every((fact) => fact.status === 'succeeded')).toBe(true);
    expect(page.facts.map((fact) => fact.check?.outcome)).toEqual(['superseded', 'passed']);
    expect(page.facts[0]!.check?.evidence).toMatchObject({
      supersededBy: { executionId: page.facts[1]!.executionId, seq: '2' },
    });
  } finally {
    await f.close();
  }
}, 10000);

test('same-path supersession does not hide a mismatching latest hash or invent an old passed check', async () => {
  const f = await fixture(async (step, f) => {
    if (step === 0) return call('files.write', { path: 'out.txt', content: 'v1', base: null });
    if (step === 1)
      return call('files.write', {
        path: 'out.txt',
        content: 'v2',
        base: (await f.files.read('out.txt')).baseline as unknown as Json,
      });
    if (step === 2) writeFileSync(join(f.root, 'out.txt'), 'external');
    return [finish];
  });
  try {
    await f.submit();
    const run = await f.done();
    expect(run.status).toBe('failed');
    const page = await f.store.listMutationFacts({
      expectedStoreId: f.metadata.storeId,
      requirement: mutationRef(run),
    });
    expect(page.facts.map((fact) => fact.check?.outcome)).toEqual(['superseded', 'failed']);
    expect((await f.files.read('out.txt')).content).toBe('external');
    expect(f.modelCalls).toBe(4);
  } finally {
    await f.close();
  }
}, 10000);
