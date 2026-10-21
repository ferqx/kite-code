import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAdapter } from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension } from '../../../src/extensions';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { ApplyAgentCommandInput } from '../../../src/storage/agent-collaboration';
import type { EnsureOperationInput } from '../../../src/storage/port';
import type { OperationRef } from '../../../src/storage/types';

type Row = Record<string, string | number | null>;

async function fixture() {
  const dataRoot = temporaryDirectory('kite-first-activation-proof-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'test' };
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///disposable',
    name: 'w',
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 'root',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 'root',
  });
  await store.acceptCommand({
    expectedStoreId,
    sessionId: 'root',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'coordinate the original work' },
  });
  const owner = (await store.acquireSessionOwner('root', 'original'))!;
  const configuration = {
    modelId: 'fixed',
    snapshot: { value: null, authorizationReview: null },
    maxConcurrentSubagents: 3,
    extensions: [{ id: 'fixture', version: '1' }],
    tools: [{ id: 'fixture/parent', version: '1', extensionId: 'fixture' }],
  };
  const run = await store.startRun({ expectedStoreId, owner, commandId: 'work', configuration });
  await store.beginRunRequirementsInitialization({ expectedStoreId, owner, runId: run.id });
  await store.registerRunRequirements({
    expectedStoreId,
    owner,
    runId: run.id,
    requirements: [],
    initialize: true,
  });
  const modelInput = {
    messages: [],
    modelId: 'fixed',
    requestId: 'model',
    tools: [
      {
        id: 'fixture/parent',
        definitionVersion: '1',
        description: 'Own the child fixture',
        inputSchema: { type: 'object' },
      },
    ],
  };
  const modelSource = { kind: 'model_request', requestId: 'model' };
  await store.planExecution({
    expectedStoreId,
    owner,
    executionId: 'model',
    sessionId: 'root',
    runId: run.id,
    originCommandId: 'work',
    stepId: 'step',
    callId: 'model',
    kind: 'model',
    definitionId: 'fixed',
    definitionVersion: '1',
    input: modelInput,
    decisionSource: modelSource,
  });
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId: 'model',
    authorization: {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest(modelInput),
    },
    requirements: [],
    freshness: { checked: true, source: modelSource },
  });
  await store.finishExecution({
    expectedStoreId,
    owner,
    executionId: 'model',
    status: 'succeeded',
    result: {
      content: '',
      reasoning: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call', name: 'fixture/parent', arguments: '{}' }],
    },
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call', name: 'fixture/parent', arguments: '{}' }],
      sourceIds: ['model'],
    },
  });
  const source = { kind: 'model_decision', modelExecutionId: 'model' };
  await store.planExecution({
    expectedStoreId,
    owner,
    executionId: 'parent',
    sessionId: 'root',
    runId: run.id,
    originCommandId: 'work',
    stepId: 'step',
    callId: 'call',
    kind: 'tool',
    definitionId: 'fixture/parent',
    definitionVersion: '1',
    input: {},
    decisionSource: source,
  });
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId: 'parent',
    authorization: {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    },
    requirements: [],
    freshness: { checked: true, source },
  });
  const request: EnsureOperationInput = {
    expectedStoreId,
    owner,
    sessionId: 'root',
    extensionId: 'fixture',
    originCommandId: 'work',
    parentExecutionId: 'parent',
    operationKey: 'original-child',
    request: {
      kind: 'agent',
      configurationId: 'worker',
      input: { content: 'Original assignment, cancelled before its first activation.' },
    },
    childConfiguration: { id: 'worker', version: '1', snapshot: configuration },
  };
  const original = await store.ensureOperation(request);
  await store.applyAgentCommand({
    ...request,
    commandId: 'interrupt',
    agentId: original.childSessionId!,
    kind: 'interrupt',
  });
  await store.finishExecution({
    expectedStoreId,
    owner,
    executionId: original.executionId!,
    status: 'cancelled',
    result: { outcome: 'cancelled', content: 'Cancelled before activation.' },
  });
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  const followUp: ApplyAgentCommandInput = {
    ...request,
    operationKey: 'first-activation',
    commandId: 'follow-up',
    agentId: original.childSessionId!,
    kind: 'follow_up',
    content: 'Use this new instruction for the first real turn.',
    newTurnPrepared: true,
    request: {
      kind: 'agent',
      configurationId: 'worker',
      input: { content: 'Use this new instruction for the first real turn.' },
    },
  };
  return {
    get store() {
      return store;
    },
    db,
    profile,
    owner,
    expectedStoreId,
    configuration,
    source,
    run,
    original,
    followUp,
    async reopen() {
      await store.close();
      store = await openSqliteStore(profile);
    },
    async close() {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function row(f: Fixture, table: string, id: string): Row {
  return f.db.query(`SELECT * FROM ${table} WHERE id=?`).get(id) as Row;
}
function snapshot(f: Fixture): string {
  return JSON.stringify(
    ['session', 'command', 'execution', 'run', 'message', 'change_event', 'storage_meta'].map(
      (table) => [table, f.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}
async function rejectedUnchanged(f: Fixture, action: () => Promise<unknown>, label: string) {
  const before = snapshot(f);
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error)) throw new Error(`Expected rejection for ${label}`);
  expect((error as Error & { code?: string }).code).toBeString();
  expect(snapshot(f)).toBe(before);
}
async function admit(f: Fixture) {
  const result = await f.store.applyAgentCommand(f.followUp);
  expect(result.receipt.mode).toBe('new_turn');
  expect(result.start).toBe(true);
  return result.receipt.ref;
}
async function dispatch(f: Fixture, ref: OperationRef) {
  const carrier = await f.store.getExecution(ref.executionId!);
  await f.store.markDispatching({
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId: ref.executionId!,
    authorization: {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest(carrier!.input),
    },
    requirements: [],
    freshness: { checked: true, source: f.source },
  });
}
function activation(f: Fixture, ref: OperationRef) {
  return {
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId: ref.executionId!,
    configuration: f.configuration,
    requirementEvaluations: [],
    freshness: { checked: true, source: f.source },
  };
}
function predecessorMutations(f: Fixture): [string, string, string, string | number | null][] {
  const old = f.original.executionId!;
  const start = `child-start-${old}`;
  return [
    ['execution', old, 'dispatched', 1],
    ['execution', old, 'state', 'outcome_unknown'],
    ['execution', old, 'state', 'failed'],
    ['execution', old, 'origin_store_id', 'other-store'],
    [
      'execution',
      old,
      'child_configuration_json',
      JSON.stringify({ id: 'other', version: '1', snapshot: f.configuration }),
    ],
    ['execution', old, 'root_work_command_id', 'create'],
    ['execution', old, 'root_work_seq', 1],
    ['execution', old, 'root_session_id', f.original.childSessionId!],
    ['command', f.original.commandId, 'subject_id', 'other-subject'],
    ['command', start, 'subject_id', 'other-subject'],
    ['command', start, 'origin_store_id', 'other-store'],
    ['command', start, 'root_work_command_id', 'create'],
    ['command', start, 'status', 'accepted'],
    ['command', start, 'receipt_json', JSON.stringify({ outcome: 'unproved' })],
    ['command', start, 'cancelled', 0],
    ['session', f.original.childSessionId!, 'context_selection_id', 'other-selection'],
  ];
}
async function checkMutations(
  f: Fixture,
  mutations: ReturnType<typeof predecessorMutations>,
  action: () => Promise<unknown>,
) {
  for (const [table, id, field, bad] of mutations) {
    const previous = row(f, table, id)[field]!;
    f.db.run(`UPDATE ${table} SET ${field}=? WHERE id=?`, [bad, id]);
    try {
      await rejectedUnchanged(f, action, `${table}.${field}=${bad}`);
    } finally {
      f.db.run(`UPDATE ${table} SET ${field}=? WHERE id=?`, [previous, id]);
    }
  }
}
function addOldRun(f: Fixture) {
  const old = row(f, 'execution', f.original.executionId!);
  f.db.run(
    "INSERT INTO run(id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,status,is_active,config_json,started_at,context_selection_id) VALUES('unexpected-old-run',?,?,?,?,?,'cancelled',0,?,'0',?)",
    [
      f.original.childSessionId!,
      `child-start-${old.id}`,
      old.origin_store_id!,
      old.root_work_command_id!,
      old.root_work_seq!,
      JSON.stringify(f.configuration),
      row(f, 'session', f.original.childSessionId!).context_selection_id!,
    ],
  );
}

test('first activation keeps the cancelled predecessor immutable and creates one real Run in the original Session', async () => {
  const f = await fixture();
  try {
    const oldCarrier = row(f, 'execution', f.original.executionId!);
    const oldStart = row(f, 'command', `child-start-${f.original.executionId}`);
    const creator = f.db
      .query("SELECT * FROM command WHERE session_id=? AND kind='session.create'")
      .get(f.original.childSessionId!);
    expect(oldCarrier.state).toBe('cancelled');
    expect(oldCarrier.dispatched).toBe(0);
    expect(oldStart.status).toBe('rejected');
    expect(JSON.parse(String(oldStart.receipt_json))).toEqual({
      outcome: 'cancelled_before_apply',
    });
    const next = await admit(f);
    expect(next.childSessionId).toBe(f.original.childSessionId);
    expect(next.executionId).not.toBe(f.original.executionId);
    const newStart = row(f, 'command', `child-start-${next.executionId}`);
    const proof = JSON.parse(String(newStart.request_json)).firstActivation;
    expect(newStart.kind).toBe('child.start');
    expect(newStart.after_run_id).toBeNull();
    expect(proof.previousExecutionId).toBe(f.original.executionId);
    expect(proof.previousCommandId).toBe(f.original.commandId);
    expect(proof.childSessionId).toBe(f.original.childSessionId);
    expect(
      JSON.parse(String(row(f, 'command', next.commandId).request_json)).firstActivation,
    ).toEqual(proof);
    expect(row(f, 'execution', next.executionId!).predecessor_execution_id).toBe(
      f.original.executionId,
    );
    const accepted = snapshot(f);
    expect((await f.store.applyAgentCommand(f.followUp)).receipt.ref).toEqual(next);
    expect(snapshot(f)).toBe(accepted);
    await dispatch(f, next);
    const activated = await f.store.activateChildRun(activation(f, next));
    expect(activated.command.kind).toBe('child.start');
    expect(activated.run.originCommandId).toBe(String(newStart.id));
    expect(activated.session.id).toBe(f.original.childSessionId!);
    expect(activated.run.carrierExecutionId).toBe(next.executionId!);
    const applied = snapshot(f);
    expect((await f.store.activateChildRun(activation(f, next))).run.id).toBe(activated.run.id);
    expect(snapshot(f)).toBe(applied);
    expect(row(f, 'execution', f.original.executionId!)).toEqual(oldCarrier);
    expect(row(f, 'command', String(oldStart.id))).toEqual(oldStart);
    expect(
      f.db
        .query("SELECT * FROM command WHERE session_id=? AND kind='session.create'")
        .get(next.childSessionId!),
    ).toEqual(creator);
    expect(
      f.db.query('SELECT count(*) AS n FROM run WHERE session_id=?').get(next.childSessionId!),
    ).toEqual({ n: 1 });
  } finally {
    await f.close();
  }
});

test('first-activation admission rejects unproved predecessor identities, unknown effects and an actual old Run without writes', async () => {
  const f = await fixture();
  try {
    await checkMutations(
      f,
      predecessorMutations(f).filter(([table]) => table !== 'session'),
      () => f.store.applyAgentCommand(f.followUp),
    );
    addOldRun(f);
    try {
      await rejectedUnchanged(
        f,
        () => f.store.applyAgentCommand(f.followUp),
        'predecessor acquired a Run',
      );
    } finally {
      f.db.run("DELETE FROM run WHERE id='unexpected-old-run'");
    }
    await admit(f);
  } finally {
    await f.close();
  }
});

test('final first activation rechecks sealed predecessor and successor proof after admission', async () => {
  const f = await fixture();
  try {
    const next = await admit(f);
    await dispatch(f, next);
    const start = `child-start-${next.executionId}`;
    const mutations = predecessorMutations(f);
    mutations.push(
      ['execution', next.executionId!, 'predecessor_execution_id', next.executionId!],
      ['command', start, 'agent_source_execution_id', 'model'],
      ['command', start, 'agent_carrier_execution_id', f.original.executionId!],
      ['command', start, 'input_context_selection_id', 'other-selection'],
      ['command', start, 'subject_id', 'other-subject'],
      ['command', start, 'root_work_command_id', 'create'],
    );
    await checkMutations(f, mutations, () => f.store.activateChildRun(activation(f, next)));
    addOldRun(f);
    try {
      await rejectedUnchanged(
        f,
        () => f.store.activateChildRun(activation(f, next)),
        'old Run created after admission',
      );
    } finally {
      f.db.run("DELETE FROM run WHERE id='unexpected-old-run'");
    }
    expect((await f.store.activateChildRun(activation(f, next))).run.isActive).toBe(true);
  } finally {
    await f.close();
  }
});

for (const mode of ['queued', 'activated'] as const)
  test(`cold ${mode} first activation proves only the new carrier and refuses changed predecessor facts`, async () => {
    const f = await fixture();
    try {
      const next = await admit(f);
      if (mode === 'activated') await dispatch(f, next);
      const active =
        mode === 'activated' ? await f.store.activateChildRun(activation(f, next)) : null;
      if (active)
        await f.store.markRunning({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          executionId: next.executionId!,
          reference: {
            kind: 'child_session',
            childSessionId: next.childSessionId!,
            commandId: active.command.id,
            runId: active.run.id,
          },
        });
      await f.store.finishExecution({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: 'parent',
        status: 'succeeded',
        result: { outcome: 'succeeded', content: 'New carrier accepted.' },
      });
      const predecessorBefore = row(f, 'execution', f.original.executionId!);
      const oldStartBefore = row(f, 'command', `child-start-${f.original.executionId}`);
      await f.reopen();
      const input = {
        expectedStoreId: f.expectedStoreId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'resume',
        runId: f.run.id,
        expectedOwnerGeneration: f.owner.generation,
      };
      const beforeRead = snapshot(f);
      const state = await f.store.verifyRunResume(input);
      expect(snapshot(f)).toBe(beforeRead);
      expect(state.children).toHaveLength(1);
      expect(state.children![0]!.carrier.id).toBe(next.executionId!);
      expect(state.children![0]!.command.kind).toBe('child.start');
      expect(state.children![0]!.state?.run.id ?? null).toBe(active?.run.id ?? null);
      expect(state.checkpoint!.groupDigest).toBeString();
      await checkMutations(f, predecessorMutations(f), () => f.store.verifyRunResume(input));
      addOldRun(f);
      try {
        await rejectedUnchanged(
          f,
          () => f.store.verifyRunResume(input),
          'cold predecessor acquired a Run',
        );
      } finally {
        f.db.run("DELETE FROM run WHERE id='unexpected-old-run'");
      }
      const verified = await f.store.verifyRunResume(input);
      const begun = await f.store.beginRunResume({
        ...input,
        checkpoint: verified.checkpoint!,
        instanceId: 'recovered',
      });
      const commit = {
        expectedStoreId: f.expectedStoreId,
        lease: begun.lease!,
        expectedConfiguration: f.configuration,
        checkpoint: verified.checkpoint!,
        childConfigurations: [{ executionId: next.executionId!, configuration: f.configuration }],
      };
      // Still a semantically cancelled predecessor, but no longer the exact observed proof.
      f.db.run('UPDATE execution SET result_revision=result_revision+1 WHERE id=?', [
        f.original.executionId!,
      ]);
      try {
        await rejectedUnchanged(
          f,
          () => f.store.commitRunResume(commit),
          'predecessor changed after recovery observation',
        );
      } finally {
        f.db.run('UPDATE execution SET result_revision=? WHERE id=?', [
          predecessorBefore.result_revision!,
          f.original.executionId!,
        ]);
      }
      const resumed = await f.store.commitRunResume(commit);
      expect(resumed.started).toBe(true);
      expect(resumed.run.id).toBe(f.run.id);
      expect(row(f, 'execution', f.original.executionId!)).toEqual(predecessorBefore);
      expect(row(f, 'command', String(oldStartBefore.id))).toEqual(oldStartBefore);
      expect((await f.store.getExecution(next.executionId!))!.ownerGeneration).toBe(
        resumed.owner.generation,
      );
      expect(
        f.db.query('SELECT count(*) AS n FROM run WHERE session_id=?').get(next.childSessionId!),
      ).toEqual({ n: active ? 1 : 0 });
    } finally {
      await f.close();
    }
  });

test('cold Runtime resumes only the queued first-activation carrier and executes its saved configuration once', async () => {
  const f = await fixture();
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const next = await admit(f);
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'parent',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'Only the new carrier is pending.' },
    });
    const oldCarrier = row(f, 'execution', f.original.executionId!);
    const oldStart = row(f, 'command', `child-start-${f.original.executionId}`);
    await f.reopen();
    let parentCalls = 0;
    let childCalls = 0;
    let replayedTools = 0;
    const parent: ModelAdapter = {
      async *stream() {
        parentCalls++;
        yield { type: 'text_delta', text: 'Parent recovery complete.' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const child: ModelAdapter = {
      async *stream(request) {
        childCalls++;
        expect(request.modelId).toBe('fixed');
        expect(request.messages.some((message) => message.content === f.followUp.content)).toBe(
          true,
        );
        yield { type: 'text_delta', text: 'Only the first actual child turn executed.' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const extension: Extension = {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture/parent',
          version: '1',
          description: 'Own the child fixture',
          inputSchema: { type: 'object' },
          async execute() {
            replayedTools++;
            return { outcome: 'failed', content: 'The completed parent Tool must not replay.' };
          },
        },
      ],
    };
    runtime = createRuntime({
      artifacts: createArtifactStore({ profile: f.profile, store: f.store }),
      store: f.store,
      model: parent,
      modelId: 'fixed',
      extensions: [extension],
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: child,
          modelId: 'fixed',
          snapshot: f.configuration.snapshot,
        },
      ],
    });
    const input = {
      expectedStoreId: f.expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'runtime-resume',
      runId: f.run.id,
      expectedOwnerGeneration: f.owner.generation,
    };
    const receipt = await runtime.resumeRun(input);
    expect(receipt.receipt).toMatchObject({ outcome: 'run_resumed', runId: f.run.id });
    const deadline = Date.now() + 5000;
    while (
      (await f.store.getExecution(next.executionId!))!.status !== 'succeeded' ||
      (await f.store.getRun(f.run.id))!.isActive
    ) {
      if (Date.now() > deadline) throw new Error('first_activation_runtime_recovery_timeout');
      await Bun.sleep(5);
    }
    expect(childCalls).toBe(1);
    expect(parentCalls).toBe(1);
    expect(replayedTools).toBe(0);
    expect(row(f, 'execution', f.original.executionId!)).toEqual(oldCarrier);
    expect(row(f, 'command', String(oldStart.id))).toEqual(oldStart);
    const childView = await f.store.getView(next.childSessionId!);
    expect(childView.runs).toHaveLength(1);
    expect(childView.runs[0]!.originCommandId).toBe(`child-start-${next.executionId}`);
    expect(childView.runs[0]!.configuration).toEqual(f.configuration);
    expect(childView.runs[0]!.status).toBe('completed');
    expect(childView.executions.filter((execution) => execution.kind === 'model')).toHaveLength(1);
    expect(await runtime.resumeRun(input)).toEqual(receipt);
    expect(childCalls).toBe(1);
    expect(replayedTools).toBe(0);
  } finally {
    await runtime?.close();
    await f.close();
  }
});
